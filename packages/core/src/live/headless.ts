import { LIVE_PATH, LIVE_FRAME, parseLive, type LiveDown, type LiveUp } from "@eigenwife/protocol";

/**
 * A page without a page: plays the shell's half of the Eve Live relay from
 * Bun. It opens the provider WebSocket the core describes (gateway plan),
 * streams whatever PCM you hand it, forwards server events to the core, and
 * obeys send/close/teardown. The tests drive it against the fake server; the
 * smoke script (smoke.ts) drives it against the real gateway with a recorded
 * question. WebRTC plans get a stub offer (for testing the SDP exchange only).
 */

export interface HeadlessOptions {
  /** ws://127.0.0.1:<port> of the core. */
  core: string;
  role?: "overlay" | "shell";
  /** Output audio (base64 PCM16 24kHz) as it arrives. */
  onAudio?(b64: string): void;
  onEvent?(e: Record<string, unknown>): void;
  onDown?(m: LiveDown): void;
  log?(...a: unknown[]): void;
}

export class HeadlessPage {
  private coreWs: WebSocket | null = null;
  private provider: WebSocket | null = null;
  private key = "";
  private pump: ReturnType<typeof setInterval> | undefined;
  private pcm: Uint8Array[] = [];
  started = false;
  engine: "classic" | "live" = "classic";
  owner = false;
  idle = false;
  downs: LiveDown[] = [];
  events: Record<string, unknown>[] = [];
  sent: Record<string, unknown>[] = [];
  answers: { sdp: string; sessionId?: string }[] = [];

  constructor(private o: HeadlessOptions) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.o.core}${LIVE_PATH}`);
      this.coreWs = ws;
      ws.onopen = () => {
        this.up({ type: "hello", role: this.o.role ?? "overlay", audio: true });
        resolve();
      };
      ws.onerror = () => reject(new Error("core socket failed"));
      ws.onmessage = (m) => {
        const d = parseLive<LiveDown>(String(m.data));
        if (d) this.onDown(d);
      };
    });
  }

  private up(m: LiveUp) {
    if (this.coreWs?.readyState === WebSocket.OPEN) this.coreWs.send(JSON.stringify(m));
  }

  private onDown(m: LiveDown) {
    this.downs.push(m);
    this.o.onDown?.(m);
    switch (m.type) {
      case "engine":
        this.engine = m.engine;
        this.owner = m.owner;
        return;
      case "idle":
        this.idle = m.idle;
        return;
      case "connect":
        this.key = m.key;
        if (m.plan.kind === "webrtc") {
          this.up({ type: "offer", key: m.key, sdp: "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=headless\r\n" });
          return;
        }
        return this.openProvider(m.key, m.plan.url, m.plan.protocols, m.plan.start);
      case "answer":
        this.answers.push({ sdp: m.sdp, sessionId: m.sessionId });
        return;
      case "send":
        if (m.key !== this.key) return;
        this.sent.push(m.event);
        this.providerSend(m.event);
        return;
      case "close":
        if (m.key !== this.key) return;
        this.providerSend({ type: "session.close" });
        return;
      case "teardown":
        if (m.key !== this.key) return;
        this.drop();
        return;
    }
  }

  private openProvider(key: string, url: string, protocols: string[], start: Record<string, unknown>) {
    this.drop();
    const ws = new WebSocket(url, protocols);
    this.provider = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.up({ type: "opened", key });
      ws.send(JSON.stringify(start));
    };
    ws.onmessage = (m) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (e.type === "session.output_audio.delta") return this.o.onAudio?.(String(e.delta ?? ""));
      this.events.push(e);
      this.o.onEvent?.(e);
      if (e.type === "session.started") {
        this.started = true;
        this.startPump();
      }
      this.up({ type: "event", key, event: e });
    };
    ws.onclose = (c) => {
      if (this.provider !== ws) return;
      this.provider = null;
      this.stopPump();
      this.started = false;
      if (!opened) this.up({ type: "fail", key, message: `provider socket closed before open (${c.code}${c.reason ? ` ${c.reason}` : ""})` });
      else this.up({ type: "closed", key, code: c.code, reason: c.reason });
    };
  }

  private providerSend(e: Record<string, unknown>) {
    if (this.provider?.readyState === WebSocket.OPEN) this.provider.send(JSON.stringify(e));
  }

  /** Queue raw PCM16 24kHz mono; it goes out in paced 20ms frames (silence when empty). */
  feed(pcm: Uint8Array) {
    this.pcm.push(pcm);
  }

  private startPump() {
    this.stopPump();
    let buf = new Uint8Array(0);
    const bytes = LIVE_FRAME * 2;
    this.pump = setInterval(() => {
      while (buf.length < bytes && this.pcm.length) {
        const next = this.pcm.shift()!;
        const merged = new Uint8Array(buf.length + next.length);
        merged.set(buf);
        merged.set(next, buf.length);
        buf = merged;
      }
      const frame = new Uint8Array(bytes);
      frame.set(buf.subarray(0, Math.min(bytes, buf.length)));
      buf = buf.subarray(Math.min(bytes, buf.length));
      this.providerSend({ type: "session.input_audio.append", audio: Buffer.from(frame).toString("base64") });
    }, 20);
  }

  private stopPump() {
    if (this.pump) clearInterval(this.pump);
    this.pump = undefined;
  }

  activity() {
    this.up({ type: "activity" });
  }

  playback(speaking: boolean) {
    this.up({ type: "playback", speaking });
  }

  private drop() {
    this.stopPump();
    const p = this.provider;
    this.provider = null;
    this.started = false;
    try {
      p?.close();
    } catch {}
  }

  close() {
    this.drop();
    this.coreWs?.close();
    this.coreWs = null;
  }
}
