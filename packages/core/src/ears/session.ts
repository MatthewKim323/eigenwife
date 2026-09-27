import { TranscriptAssembler, type DeepgramMessage } from "./deepgram";
import { FluxTurnTracker } from "./flux";
import { acceptWhileSpeaking, SpeakingTracker } from "./gate";

/** The slice of WebSocket we use, so tests can hand in anything socket-shaped. */
export interface UpstreamSocket {
  readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | Uint8Array): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: any) => void) | null;
  onmessage: ((ev: { data: any }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: any) => void) | null;
}

export type UpstreamFactory = (url: string, apiKey: string) => UpstreamSocket;

/** Bun's WebSocket takes headers, so the key never rides in the URL. */
export const bunUpstream: UpstreamFactory = (url, apiKey) =>
  new WebSocket(url, { headers: { Authorization: `Token ${apiKey}` } } as any) as unknown as UpstreamSocket;

export type UpstreamState = "connecting" | "open" | "reconnecting" | "closed";

export interface SessionHooks {
  partial(text: string): void;
  /** endOfTurn: a model-detected end of turn (Flux), so nobody needs to wait for more. */
  final(text: string, confidence?: number, endOfTurn?: boolean): void;
  /** Flux EagerEndOfTurn: probably done, start thinking speculatively. */
  eager?(text: string): void;
  /** Flux TurnResumed: he kept going, drop the speculation. */
  resumed?(): void;
  /** 3+ words while she's talking: stop her. Fires once per utterance. */
  bargeIn(text: string): void;
  /** JSON to the mic client (transcripts echo back so it can draw what it heard). */
  toClient(msg: Record<string, unknown>): void;
  log(...args: unknown[]): void;
}

export interface SessionOptions {
  url: string;
  apiKey: string;
  connect?: UpstreamFactory;
  hooks: SessionHooks;
  tracker?: SpeakingTracker;
  now?: () => number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  keepAliveMs?: number;
  /** Audio held while the upstream reconnects, in bytes (1s of 16k PCM). */
  bufferBytes?: number;
  /** "flux" speaks Deepgram's /v2/listen TurnInfo protocol; "nova" (default) the /v1 Results one. */
  protocol?: "nova" | "flux";
  /** Where to go when Flux won't connect (two closes before an open): the nova URL. */
  fallbackUrl?: string;
}

const OPEN = 1;

/**
 * One mic client <-> one Deepgram stream. Audio in, transcripts out through
 * the same half-duplex gate the browser recognizer uses. Reconnects with
 * backoff while the client stays connected; keeps the stream alive through
 * silence with KeepAlive frames.
 */
export class EarsSession {
  readonly tracker: SpeakingTracker;
  private sock: UpstreamSocket | null = null;
  private assembler: TranscriptAssembler;
  private flux: FluxTurnTracker;
  protocol: "nova" | "flux";
  private url: string;
  private failedOpens = 0;
  private closed = false;
  private backoff: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private keepAlive: ReturnType<typeof setInterval> | undefined;
  private lastSentAt = 0;
  private pending: Uint8Array[] = [];
  private pendingBytes = 0;
  private ptt = false;
  /** Current utterance overlapped her voice at some point: gate the final too. */
  private busyUtterance = false;
  private barged = false;
  state: UpstreamState = "connecting";
  connects = 0;
  bytesIn = 0;

  constructor(private o: SessionOptions) {
    this.tracker = o.tracker ?? new SpeakingTracker(o.now);
    this.backoff = o.minBackoffMs ?? 250;
    this.assembler = new TranscriptAssembler({
      partial: (t) => this.onPartial(t),
      final: (t, c) => this.onFinal(t, c),
    });
    this.protocol = o.protocol ?? "nova";
    this.url = o.url;
    this.flux = new FluxTurnTracker({
      partial: (t) => this.onPartial(t),
      eager: (t) => this.onEager(t),
      resumed: () => this.o.hooks.resumed?.(),
      final: (t, c) => this.onFinal(t, c, true),
    });
  }

  private now() {
    return (this.o.now ?? Date.now)();
  }

  start() {
    this.open();
    const ka = this.o.keepAliveMs ?? 4000;
    this.keepAlive = setInterval(() => {
      if (this.protocol === "nova" && this.sock?.readyState === OPEN && this.now() - this.lastSentAt >= ka) this.sendUp(JSON.stringify({ type: "KeepAlive" }));
    }, Math.max(50, Math.floor(ka / 2)));
    return this;
  }

  private setState(s: UpstreamState, extra: Record<string, unknown> = {}) {
    this.state = s;
    this.o.hooks.toClient({ type: "status", upstream: s, ...extra });
  }

  private open() {
    if (this.closed) return;
    let sock: UpstreamSocket;
    try {
      sock = (this.o.connect ?? bunUpstream)(this.url, this.o.apiKey);
    } catch (err) {
      this.o.hooks.log("upstream connect threw", err);
      this.scheduleReconnect(String(err));
      return;
    }
    this.connects++;
    this.sock = sock;
    try {
      sock.binaryType = "arraybuffer";
    } catch {}
    let opened = false;
    sock.onopen = () => {
      if (this.sock !== sock) return;
      opened = true;
      this.failedOpens = 0;
      this.backoff = this.o.minBackoffMs ?? 250;
      this.setState("open", { protocol: this.protocol });
      for (const chunk of this.pending.splice(0)) this.sendUp(chunk);
      this.pendingBytes = 0;
    };
    sock.onmessage = (ev) => {
      if (this.sock !== sock) return;
      const raw = typeof ev.data === "string" ? ev.data : new TextDecoder().decode(ev.data as ArrayBuffer);
      let msg: DeepgramMessage;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.type === "Error" || (msg as any).err_code) this.o.hooks.log("deepgram error", raw.slice(0, 300));
      if (this.protocol === "flux") this.flux.push(msg as any);
      else this.assembler.push(msg);
    };
    sock.onerror = () => {};
    sock.onclose = (ev) => {
      if (this.sock !== sock) return;
      this.sock = null;
      // Whatever was mid-utterance is still something they said.
      this.commitCurrent();
      if (this.closed) return;
      if (!opened && this.protocol === "flux" && this.o.fallbackUrl && ++this.failedOpens >= 2) {
        this.o.hooks.log("flux would not connect, falling back to nova", ev?.reason ?? ev?.code ?? "");
        this.protocol = "nova";
        this.url = this.o.fallbackUrl;
        this.failedOpens = 0;
      }
      this.scheduleReconnect(ev?.reason || `closed ${ev?.code ?? ""}`.trim());
    };
  }

  private scheduleReconnect(reason: string) {
    if (this.closed) return;
    const wait = this.backoff;
    this.backoff = Math.min(this.o.maxBackoffMs ?? 5000, this.backoff * 2);
    this.setState("reconnecting", { reason, retryInMs: wait });
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), wait);
  }

  private sendUp(d: string | Uint8Array) {
    try {
      this.sock?.send(d);
      this.lastSentAt = this.now();
    } catch {}
  }

  /** A chunk of mic audio from the client. */
  audio(chunk: Uint8Array) {
    if (this.closed || !chunk.byteLength) return;
    this.bytesIn += chunk.byteLength;
    if (this.sock?.readyState === OPEN) return this.sendUp(chunk);
    // Reconnecting: hold the newest second so the first words aren't lost.
    const cap = this.o.bufferBytes ?? 32000;
    this.pending.push(chunk);
    this.pendingBytes += chunk.byteLength;
    while (this.pendingBytes > cap && this.pending.length) this.pendingBytes -= this.pending.shift()!.byteLength;
  }

  /** JSON control from the client: { type: "eve", speaking } | { type: "ptt", down } | { type: "finalize" }. */
  control(msg: { type?: string; speaking?: unknown; down?: unknown }) {
    if (msg.type === "eve") this.tracker.fromClient(!!msg.speaking);
    else if (msg.type === "ptt") {
      this.ptt = !!msg.down;
      if (!this.ptt) this.finalize();
    } else if (msg.type === "finalize") this.finalize();
  }

  /** Ask Deepgram to flush now; commit locally too in case it has nothing pending. */
  finalize() {
    if (this.protocol === "flux") return this.flux.commit();
    if (this.sock?.readyState === OPEN) this.sendUp(JSON.stringify({ type: "Finalize" }));
    setTimeout(() => this.assembler.commit(), 250);
  }

  private commitCurrent() {
    if (this.protocol === "flux") this.flux.commit();
    else this.assembler.commit();
  }

  private onEager(text: string) {
    if (this.verdict(text) !== "accept") return;
    this.o.hooks.eager?.(text);
  }

  private verdict(text: string) {
    if (this.ptt) return "accept" as const;
    const v = acceptWhileSpeaking(text, this.tracker.speaking, this.tracker.msSinceStopped);
    if (v !== "accept") this.busyUtterance = true;
    // Started over her voice: keep the stricter rule until the utterance closes.
    if (v === "accept" && this.busyUtterance) return acceptWhileSpeaking(text, true, 0);
    return v;
  }

  private onPartial(text: string) {
    const v = this.verdict(text);
    if (v === "ignore") return;
    if (v === "barge-in" && !this.barged) {
      this.barged = true;
      this.o.hooks.bargeIn(text);
      this.o.hooks.toClient({ type: "bargein", text });
    }
    this.o.hooks.toClient({ type: "partial", text });
    this.o.hooks.partial(text);
  }

  private onFinal(text: string, confidence?: number, endOfTurn = false) {
    const v = this.verdict(text);
    this.busyUtterance = false;
    const barged = this.barged;
    this.barged = false;
    if (v === "ignore") {
      this.o.hooks.toClient({ type: "dropped", text });
      return;
    }
    if (v === "barge-in" && !barged) {
      this.o.hooks.bargeIn(text);
      this.o.hooks.toClient({ type: "bargein", text });
    }
    this.o.hooks.toClient({ type: "final", text, confidence });
    this.o.hooks.final(text, confidence, endOfTurn || undefined);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.keepAlive);
    const s = this.sock;
    this.sock = null;
    if (s) {
      try {
        if (s.readyState === OPEN) s.send(JSON.stringify({ type: "CloseStream" }));
        s.close(1000, "client gone");
      } catch {}
    }
    this.commitCurrent();
    this.state = "closed";
  }
}
