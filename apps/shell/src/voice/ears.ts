import { getAudioContext } from "./audio";
import { rms16, workletSource, WORKLET_NAME } from "./pcm";
import type { MicStatus } from "./recognition";

export interface EarsClientHooks {
  /** What the core heard so far (UI only: the core already put it on the bus). */
  partial(text: string): void;
  final(text: string): void;
  /** Core decided the user is talking over her: stop playback right now. */
  bargeIn(text: string): void;
  status(s: MicStatus): void;
  eve(): { speaking: boolean; msSinceStopped: number };
}

/** Live mic level 0..1, read by the lamp every frame (not React state). */
export const micLevel = { value: 0 };

/**
 * Deepgram ears, client half: getUserMedia (echo cancellation on) ->
 * AudioWorklet -> 16kHz linear16 frames -> ws /ears on the core. The core
 * proxies to Deepgram and publishes voice.partial / voice.final itself, with
 * the same half-duplex gate as the browser recognizer. We tell it when her
 * voice is actually playing so the gate is exact.
 */
export class EarsClient {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private src: MediaStreamAudioSourceNode | null = null;
  private sink: GainNode | null = null;
  private disposed = false;
  private started = false;
  private muted = false;
  private ptt = false;
  private backoff = 400;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private lastEve: boolean | null = null;
  private upstream = "connecting";
  private error: string | undefined;
  readonly supported = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;

  constructor(private hooks: EarsClientHooks, private url: string) {
    this.emitStatus();
  }

  private emitStatus() {
    const listening = !!this.ws && this.ws.readyState === WebSocket.OPEN && this.upstream === "open" && !!this.stream && !this.muted;
    this.hooks.status({ supported: this.supported, listening, ptt: this.ptt, muted: this.muted, source: "deepgram", error: this.error });
  }

  /** Open the mic and the socket. Safe to call more than once. */
  async start() {
    if (this.started || this.disposed) return;
    this.started = true;
    if (!this.supported) {
      this.error = "no microphone api";
      return this.emitStatus();
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
      });
    } catch (err) {
      this.error = (err as Error)?.name === "NotAllowedError" ? "mic blocked" : "no microphone";
      this.started = false;
      return this.emitStatus();
    }
    if (this.disposed) return this.stopTracks();
    const ctx = getAudioContext();
    if (!ctx) {
      this.error = "no audio context";
      return this.emitStatus();
    }
    try {
      const url = URL.createObjectURL(new Blob([workletSource()], { type: "application/javascript" }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.warn("[ears] worklet failed", err);
      this.error = "audio worklet failed";
      return this.emitStatus();
    }
    this.src = ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(ctx, WORKLET_NAME, { numberOfInputs: 1, numberOfOutputs: 1 });
    // Pulled by the graph only when it reaches the destination: route it through silence.
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink).connect(ctx.destination);
    this.node.port.onmessage = (e: MessageEvent<ArrayBuffer>) => this.onFrame(e.data);
    this.node.port.postMessage({ type: "mute", muted: this.muted });
    this.src.connect(this.node);
    if (ctx.state !== "running") void ctx.resume().catch(() => {});
    this.connect();
    this.poll = setInterval(() => this.syncEve(), 100);
  }

  private onFrame(buf: ArrayBuffer) {
    const f = new Int16Array(buf);
    micLevel.value = this.muted ? 0 : micLevel.value * 0.6 + Math.min(1, rms16(f) * 4) * 0.4;
    if (this.muted || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(buf);
  }

  private connect() {
    if (this.disposed) return;
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    this.upstream = "connecting";
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.backoff = 400;
      this.error = undefined;
      this.lastEve = null;
      this.syncEve();
      if (this.ptt) this.send({ type: "ptt", down: true });
      this.emitStatus();
    };
    ws.onmessage = (ev) => {
      let m: { type?: string; text?: string; upstream?: string; reason?: string };
      try {
        m = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (m.type === "status") {
        this.upstream = m.upstream ?? "open";
        this.error = m.upstream === "reconnecting" ? "deepgram reconnecting" : undefined;
        this.emitStatus();
      } else if (m.type === "partial" && m.text) this.hooks.partial(m.text);
      else if (m.type === "final" && m.text) this.hooks.final(m.text);
      else if (m.type === "bargein" && m.text) this.hooks.bargeIn(m.text);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed) return;
      // Refused (no key) or core down: both look like a close before open here.
      this.error = "ears offline";
      this.emitStatus();
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
  }

  private send(m: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private syncEve() {
    const speaking = this.hooks.eve().speaking;
    if (speaking === this.lastEve) return;
    this.lastEve = speaking;
    this.send({ type: "eve", speaking });
  }

  setMuted(on: boolean) {
    this.muted = on;
    this.node?.port.postMessage({ type: "mute", muted: on });
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = !on));
    if (on) {
      micLevel.value = 0;
      this.send({ type: "finalize" });
    }
    this.emitStatus();
  }

  get isMuted() {
    return this.muted;
  }

  pttDown() {
    if (this.ptt) return;
    this.ptt = true;
    this.send({ type: "ptt", down: true });
    this.emitStatus();
  }

  pttUp() {
    if (!this.ptt) return;
    this.ptt = false;
    this.send({ type: "ptt", down: false });
    this.emitStatus();
  }

  private stopTracks() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose() {
    this.disposed = true;
    clearTimeout(this.retry);
    clearInterval(this.poll);
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.sink?.disconnect();
    } catch {}
    this.stopTracks();
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}
