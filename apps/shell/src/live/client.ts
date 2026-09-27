import { LIVE_PATH, LIVE_RATE, parseLive, type LiveConnectPlan, type LiveDown, type LiveUp } from "@eigenwife/protocol";
import { LipsyncEnvelope, rmsOfBytes } from "../voice/lipsync";
import { base64ToBytes, bytesToBase64, LIVE_WORKLET, liveWorkletSource, pcm16ToFloat, PlayClock, WakeDetector } from "./pcm24";

/**
 * Eve Live, page half (docs/LIVE.md). The core decides everything; this
 * owns the audio. It keeps a relay socket to the core (ws /live), and when
 * told to connect it opens gpt-live-1 directly:
 *
 *   gateway  WebSocket with the core-minted single-use secret as subprotocol,
 *            mic -> 24kHz PCM16 frames up, PCM16 chunks down -> gapless playback
 *   openai   WebRTC: mic track up, remote track down, JSON events on the
 *            "oai-events" data channel; the core swaps the SDP with the key
 *
 * Every server event except audio goes to the core. Her mouth follows an
 * AnalyserNode on whatever is actually playing (lipsync.ts envelope).
 */

export interface LiveHooks {
  /** Her mouth this frame (0..0.7) and whether live audio is playing. */
  mouth(value: number, speaking: boolean): void;
  /** Engine / ownership as the core sees it (VoiceProvider stops the classic ears on live). */
  engine(engine: "classic" | "live", owner: boolean): void;
  /** Mic lamp while live owns the mic. */
  mic(s: { listening: boolean; muted: boolean; error?: string; idle?: boolean }): void;
  log?(...a: unknown[]): void;
}

export interface LiveEnv {
  WebSocket: typeof WebSocket;
  RTCPeerConnection?: typeof RTCPeerConnection;
  getUserMedia?: (c: MediaStreamConstraints) => Promise<MediaStream>;
  audio?: () => AudioContext | null;
  raf?: (fn: () => void) => number;
  caf?: (id: number) => void;
  now?: () => number;
}

interface Transport {
  key: string;
  kind: "websocket" | "webrtc";
  send(e: Record<string, unknown>): void;
  close(): void;
  started: boolean;
}

export class LiveClient {
  private relay: WebSocket | null = null;
  private backoff = 500;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private disposed = false;
  private t: Transport | null = null;
  private engine: "classic" | "live" = "classic";
  private owner = false;
  private idle = false;
  private muted = false;
  // audio
  private stream: MediaStream | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private out: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private rtcAudio: HTMLAudioElement | null = null;
  private rtcSource: MediaStreamAudioSourceNode | null = null;
  private clock = new PlayClock();
  private playing = new Set<AudioBufferSourceNode>();
  private wake = new WakeDetector();
  private env: Required<Pick<LiveEnv, "WebSocket" | "now">> & LiveEnv;
  private lips = new LipsyncEnvelope();
  private raf = 0;
  private lastFrame = 0;
  private audible = false;
  private bytes: Uint8Array<ArrayBuffer> | null = null;

  constructor(
    private coreHttp: string,
    private role: "overlay" | "shell",
    private hooks: LiveHooks,
    env: LiveEnv,
  ) {
    this.env = { now: () => (typeof performance !== "undefined" ? performance.now() : Date.now()), ...env };
  }

  get isLive(): boolean {
    return this.engine === "live" && this.owner;
  }

  // --- relay to the core ---------------------------------------------------------

  start() {
    if (this.disposed || this.relay) return;
    const url = `${this.coreHttp.replace(/^http/, "ws")}${LIVE_PATH}`;
    const ws = new this.env.WebSocket(url);
    this.relay = ws;
    ws.onopen = () => {
      this.backoff = 500;
      this.up({ type: "hello", role: this.role, audio: !!this.env.audio?.() });
    };
    ws.onmessage = (ev) => {
      const m = parseLive<LiveDown>(String(ev.data));
      if (m) void this.onDown(m);
    };
    ws.onclose = () => {
      if (this.relay !== ws) return;
      this.relay = null;
      this.drop();
      if (this.disposed) return;
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.start(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
  }

  private up(m: LiveUp) {
    if (this.relay?.readyState === 1) this.relay.send(JSON.stringify(m));
  }

  async onDown(m: LiveDown) {
    switch (m.type) {
      case "engine": {
        const was = this.isLive;
        this.engine = m.engine;
        this.owner = m.owner;
        this.hooks.engine(m.engine, m.owner);
        if (this.isLive && !was) await this.openMic();
        if (!this.isLive && was) {
          this.drop();
          this.closeMic();
        }
        this.status();
        return;
      }
      case "idle":
        this.idle = m.idle;
        this.status();
        return;
      case "connect":
        if (m.plan.kind === "websocket") return this.openWs(m.key, m.plan);
        return this.openRtc(m.key);
      case "answer":
        return this.answer(m.key, m.sdp);
      case "send":
        if (this.t?.key === m.key) this.t.send(m.event);
        return;
      case "close":
        if (this.t?.key === m.key) this.t.send({ type: "session.close" });
        return;
      case "teardown":
        if (this.t?.key === m.key) this.drop();
        return;
    }
  }

  private event(key: string, e: Record<string, unknown>) {
    if (e.type === "session.started" && this.t?.key === key) {
      this.t.started = true;
      this.idle = false;
      this.status();
    }
    this.up({ type: "event", key, event: e });
  }

  // --- gateway WebSocket ---------------------------------------------------------------

  private openWs(key: string, plan: Extract<LiveConnectPlan, { kind: "websocket" }>) {
    this.drop();
    let ws: WebSocket;
    try {
      ws = new this.env.WebSocket(plan.url, plan.protocols);
    } catch (err) {
      this.up({ type: "fail", key, message: `websocket: ${String(err)}` });
      return;
    }
    let opened = false;
    const t: Transport = {
      key,
      kind: "websocket",
      started: false,
      send: (e) => {
        if (ws.readyState === 1) ws.send(JSON.stringify(e));
      },
      close: () => {
        try {
          ws.close();
        } catch {}
      },
    };
    this.t = t;
    ws.onopen = () => {
      opened = true;
      this.up({ type: "opened", key });
      ws.send(JSON.stringify(plan.start));
    };
    ws.onmessage = (ev) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (e.type === "session.output_audio.delta") return this.play(String(e.delta ?? ""));
      this.event(key, e);
      if (e.type === "session.started") this.flushWake();
    };
    ws.onclose = (c) => {
      if (this.t !== t) return;
      this.t = null;
      this.stopPlayback();
      if (!opened) this.up({ type: "fail", key, message: `live socket refused (${c.code}${c.reason ? ` ${c.reason}` : ""})` });
      else this.up({ type: "closed", key, code: c.code, reason: c.reason });
      this.status();
    };
  }

  /** His opening words from before the (re)connect, so waking her doesn't eat them. */
  private flushWake() {
    for (const f of this.wake.take()) this.sendFrame(f);
  }

  private sendFrame(f: Int16Array) {
    const t = this.t;
    if (!t || t.kind !== "websocket" || !t.started) return;
    t.send({ type: "session.input_audio.append", audio: bytesToBase64(new Uint8Array(f.buffer, f.byteOffset, f.byteLength)) });
  }

  private play(b64: string) {
    const ctx = this.env.audio?.();
    if (!ctx || !b64) return;
    this.ensureOut(ctx);
    const samples = pcm16ToFloat(base64ToBytes(b64));
    if (!samples.length) return;
    const buf = ctx.createBuffer(1, samples.length, LIVE_RATE);
    buf.copyToChannel(samples, 0);
    const node = ctx.createBufferSource();
    node.buffer = buf;
    node.connect(this.out!);
    const at = this.clock.schedule(ctx.currentTime, buf.duration);
    node.onended = () => this.playing.delete(node);
    this.playing.add(node);
    node.start(at);
  }

  private stopPlayback() {
    for (const n of this.playing) {
      try {
        n.stop();
      } catch {}
    }
    this.playing.clear();
    this.clock.reset();
  }

  // --- OpenAI WebRTC -------------------------------------------------------------------

  private async openRtc(key: string) {
    this.drop();
    const RTC = this.env.RTCPeerConnection;
    if (!RTC) return this.up({ type: "fail", key, message: "no WebRTC in this page" });
    await this.openMic();
    const pc = new RTC();
    const dc = pc.createDataChannel("oai-events");
    const t: Transport = {
      key,
      kind: "webrtc",
      started: false,
      send: (e) => {
        if (dc.readyState === "open") dc.send(JSON.stringify(e));
      },
      close: () => {
        try {
          dc.close();
          pc.close();
        } catch {}
      },
    };
    this.t = t;
    for (const track of this.stream?.getAudioTracks() ?? []) pc.addTrack(track, this.stream!);
    pc.ontrack = (ev) => this.attachRemote(new MediaStream([ev.track]));
    dc.onopen = () => this.up({ type: "opened", key });
    dc.onmessage = (ev) => {
      try {
        this.event(key, JSON.parse(String(ev.data)));
      } catch {}
    };
    dc.onclose = () => {
      if (this.t !== t) return;
      this.t = null;
      this.up({ type: "closed", key });
      this.status();
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      await new Promise<void>((resolve) => {
        if (pc.iceGatheringState === "complete") return resolve();
        const done = () => pc.iceGatheringState === "complete" && resolve();
        pc.addEventListener("icegatheringstatechange", done);
        setTimeout(resolve, 3000);
      });
      const sdp = pc.localDescription?.sdp;
      if (!sdp) throw new Error("no local SDP");
      this.pending = { key, pc };
      this.up({ type: "offer", key, sdp });
    } catch (err) {
      this.up({ type: "fail", key, message: `webrtc offer: ${String(err)}` });
    }
  }

  private pending: { key: string; pc: RTCPeerConnection } | null = null;

  private async answer(key: string, sdp: string) {
    const p = this.pending;
    if (!p || p.key !== key) return;
    this.pending = null;
    try {
      await p.pc.setRemoteDescription({ type: "answer", sdp });
    } catch (err) {
      this.up({ type: "fail", key, message: `webrtc answer: ${String(err)}` });
    }
  }

  private attachRemote(stream: MediaStream) {
    const ctx = this.env.audio?.();
    // Chromium only plays remote WebRTC audio through a media element; the analyser taps a copy.
    if (typeof Audio !== "undefined") {
      const el = (this.rtcAudio ??= new Audio());
      el.autoplay = true;
      el.srcObject = stream;
      void el.play().catch(() => {});
    }
    if (ctx) {
      this.ensureOut(ctx);
      this.rtcSource?.disconnect();
      this.rtcSource = ctx.createMediaStreamSource(stream);
      this.rtcSource.connect(this.analyser!);
    }
  }

  // --- mic -----------------------------------------------------------------------------

  private async openMic() {
    if (this.stream || !this.env.getUserMedia) return;
    const ctx = this.env.audio?.();
    try {
      this.stream = await this.env.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
    } catch (err) {
      this.hooks.mic({ listening: false, muted: this.muted, error: (err as Error)?.name === "NotAllowedError" ? "mic blocked" : "no microphone" });
      return;
    }
    if (!this.isLive) return this.closeMic();
    for (const tr of this.stream.getAudioTracks()) tr.enabled = !this.muted;
    if (!ctx) return;
    try {
      const url = URL.createObjectURL(new Blob([liveWorkletSource()], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      this.hooks.log?.("[live] worklet failed", err);
    }
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, LIVE_WORKLET, { numberOfInputs: 1, numberOfOutputs: 1 });
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(ctx.destination);
    this.node.port.postMessage({ type: "mute", muted: this.muted });
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onMicFrame(new Int16Array(e.data));
    this.src.connect(this.node);
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    this.ensureOut(ctx);
  }

  onMicFrame(f: Int16Array) {
    const t = this.t;
    if (t?.started && t.kind === "websocket") return this.sendFrame(f);
    // Session idle-closed (or reconnecting): listen locally, wake the core when he talks.
    if (this.isLive && !this.muted && this.wake.push(f) && (this.idle || !t)) this.up({ type: "activity" });
  }

  private closeMic() {
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {}
    this.src = this.node = this.sink = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.hooks.mouth(0, false);
  }

  setMuted(on: boolean) {
    this.muted = on;
    this.node?.port.postMessage({ type: "mute", muted: on });
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !on));
    this.status();
  }

  private status() {
    if (!this.isLive) return;
    this.hooks.mic({ listening: !!this.t?.started && !this.muted, muted: this.muted, idle: this.idle });
  }

  // --- her mouth -------------------------------------------------------------------------

  private ensureOut(ctx: AudioContext) {
    if (this.out) return;
    this.out = ctx.createGain();
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.out.connect(this.analyser);
    this.out.connect(ctx.destination);
    this.bytes = new Uint8Array(this.analyser.fftSize);
    this.loop();
  }

  private loop() {
    if (this.raf || !this.env.raf) return;
    const tick = () => {
      this.raf = this.env.raf!(tick);
      if (!this.isLive) return;
      const now = this.env.now();
      const dt = this.lastFrame ? Math.min(100, now - this.lastFrame) : 16;
      this.lastFrame = now;
      let rms = 0;
      if (this.analyser && this.bytes) {
        this.analyser.getByteTimeDomainData(this.bytes);
        rms = rmsOfBytes(this.bytes);
      }
      const ctx = this.env.audio?.();
      const queued = ctx ? this.clock.ahead(ctx.currentTime) > 0 : false;
      const speaking = queued || rms > 0.02;
      const v = this.lips.update(rms, speaking, dt, now);
      this.hooks.mouth(v, speaking);
      if (speaking !== this.audible) {
        this.audible = speaking;
        this.up({ type: "playback", speaking });
      }
    };
    this.raf = this.env.raf(tick);
  }

  // --- teardown ----------------------------------------------------------------------------

  private drop() {
    const t = this.t;
    this.t = null;
    this.pending = null;
    t?.close();
    this.stopPlayback();
    this.rtcSource?.disconnect();
    this.rtcSource = null;
    if (this.rtcAudio) this.rtcAudio.srcObject = null;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    this.drop();
    this.closeMic();
    if (this.raf) this.env.caf?.(this.raf);
    this.raf = 0;
    const r = this.relay;
    this.relay = null;
    r?.close();
  }
}
