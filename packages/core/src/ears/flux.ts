/**
 * Deepgram Flux: conversational STT with model-based end-of-turn detection.
 * URL building and the turn state machine. Pure, no IO.
 * Docs: https://developers.deepgram.com/docs/flux/quickstart
 *
 *   StartOfTurn     he started talking (barge-in hint)
 *   Update          transcript so far
 *   EagerEndOfTurn  probably done: start the talker speculatively
 *   TurnResumed     he wasn't done: drop the speculation
 *   EndOfTurn       done: commit (voice.final with endOfTurn)
 */

export const DEEPGRAM_FLUX_URL = "wss://api.deepgram.com/v2/listen";
export const FLUX_MODEL = "flux-general-en";

export interface FluxOptions {
  model?: string;
  encoding?: "linear16" | "opus";
  sampleRate?: number;
  eotThreshold?: number;
  eagerEotThreshold?: number;
  eotTimeoutMs?: number;
}

export const FLUX_DEFAULTS = { eotThreshold: 0.7, eagerEotThreshold: 0.5, eotTimeoutMs: 3000 } as const;

export function fluxUrl(o: FluxOptions = {}, base = DEEPGRAM_FLUX_URL): string {
  const q = new URLSearchParams({
    model: o.model ?? FLUX_MODEL,
    encoding: o.encoding ?? "linear16",
    sample_rate: String(o.sampleRate ?? (o.encoding === "opus" ? 48000 : 16000)),
    eot_threshold: String(o.eotThreshold ?? FLUX_DEFAULTS.eotThreshold),
    eot_timeout_ms: String(o.eotTimeoutMs ?? FLUX_DEFAULTS.eotTimeoutMs),
  });
  const eager = o.eagerEotThreshold ?? FLUX_DEFAULTS.eagerEotThreshold;
  if (eager > 0) q.set("eager_eot_threshold", String(eager));
  return `${base}?${q}`;
}

export interface FluxTurnInfo {
  type: "TurnInfo";
  event: "Update" | "StartOfTurn" | "EagerEndOfTurn" | "TurnResumed" | "EndOfTurn";
  turn_index?: number;
  transcript?: string;
  end_of_turn_confidence?: number | string;
  words?: { word: string; confidence?: number }[];
}

export interface FluxHooks {
  start?(turn: number): void;
  partial(text: string): void;
  eager?(text: string, turn: number): void;
  resumed?(turn: number): void;
  final(text: string, confidence?: number): void;
}

export type FluxState = "idle" | "speaking" | "eager";

/**
 * Turns Flux TurnInfo messages into hooks. Guarantees: at most one eager per
 * speculation, resumed only after an eager, final exactly once per turn (and
 * never empty), a dangling turn committed on close/finalize.
 */
export class FluxTurnTracker {
  state: FluxState = "idle";
  private text = "";
  private lastPartial = "";
  private turn = -1;
  private eagerText = "";

  constructor(private hooks: FluxHooks) {}

  get current() {
    return this.text;
  }

  /** Returns true when the message was a Flux turn event. */
  push(msg: { type?: string; [k: string]: unknown }): boolean {
    if (msg.type !== "TurnInfo") return false;
    const m = msg as unknown as FluxTurnInfo;
    const t = (m.transcript ?? "").trim();
    const idx = typeof m.turn_index === "number" ? m.turn_index : this.turn;
    if (idx !== this.turn && this.state !== "idle" && m.event !== "EndOfTurn") {
      // A new turn while the old one never closed: commit the old one first.
      this.commit();
    }
    this.turn = idx;
    if (t) this.text = t;
    switch (m.event) {
      case "StartOfTurn":
        if (this.state === "idle") {
          this.state = "speaking";
          this.hooks.start?.(idx);
        }
        this.partial();
        break;
      case "Update":
        if (this.state === "idle") this.state = "speaking";
        this.partial();
        break;
      case "EagerEndOfTurn":
        this.partial();
        if (this.text && (this.state !== "eager" || this.eagerText !== this.text)) {
          this.state = "eager";
          this.eagerText = this.text;
          this.hooks.eager?.(this.text, idx);
        }
        break;
      case "TurnResumed":
        if (this.state === "eager") this.hooks.resumed?.(idx);
        this.state = "speaking";
        this.eagerText = "";
        this.partial();
        break;
      case "EndOfTurn": {
        const conf = Number(m.end_of_turn_confidence);
        this.commit(Number.isFinite(conf) ? conf : undefined);
        break;
      }
    }
    return true;
  }

  /** Close the turn now (EndOfTurn, push-to-talk release, socket close). */
  commit(confidence?: number) {
    const text = this.text.trim();
    this.reset();
    if (text) this.hooks.final(text, confidence);
  }

  reset() {
    this.state = "idle";
    this.text = "";
    this.lastPartial = "";
    this.eagerText = "";
  }

  private partial() {
    if (!this.text || this.text === this.lastPartial) return;
    this.lastPartial = this.text;
    this.hooks.partial(this.text);
  }
}

/** Normalize a transcript for "is the final the same thing the eager guess saw?". */
export function sameTurn(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ").trim();
  return n(a) === n(b);
}
