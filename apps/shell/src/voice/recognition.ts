import { acceptWhileSpeaking, TurnCommitter } from "./turn";

export interface RecognizerHooks {
  partial(text: string): void;
  final(text: string): void;
  /** User talked over her with 3+ words. */
  bargeIn(text: string): void;
  status(s: { supported: boolean; listening: boolean; ptt: boolean; error?: string }): void;
  /** Is she talking right now, and how long since she stopped. */
  eve(): { speaking: boolean; msSinceStopped: number };
}

/**
 * Chrome SpeechRecognition: continuous + interim, auto-restarting forever.
 * Turns commit when interim text is stable for 650ms (or the engine says
 * final). Half-duplex while she speaks. Space held = push-to-talk: listening
 * is forced on and releasing commits immediately (operator fallback).
 */
export class Recognizer {
  private rec: any = null;
  private running = false;
  private wanted = false;
  private ptt = false;
  /** Results before this index were already committed. */
  private consumed = 0;
  private committer: TurnCommitter;
  private tick: ReturnType<typeof setInterval> | undefined;
  private restartTimer: ReturnType<typeof setTimeout> | undefined;
  private lastInterim = "";
  private bargedFor = "";
  readonly supported: boolean;

  constructor(private hooks: RecognizerHooks, private opts: { continuous: boolean; lang?: string } = { continuous: true }) {
    const Ctor = (globalThis as any).SpeechRecognition ?? (globalThis as any).webkitSpeechRecognition;
    this.supported = !!Ctor;
    this.committer = new TurnCommitter((t) => this.commit(t));
    if (!Ctor) {
      hooks.status({ supported: false, listening: false, ptt: false });
      return;
    }
    const rec = new Ctor();
    rec.continuous = true;
    rec.interimResults = true;
    rec.lang = opts.lang ?? "en-US";
    rec.maxAlternatives = 1;
    rec.onstart = () => {
      this.running = true;
      this.consumed = 0;
      this.emitStatus();
    };
    rec.onend = () => {
      this.running = false;
      this.emitStatus();
      if (this.wanted || this.ptt) {
        clearTimeout(this.restartTimer);
        this.restartTimer = setTimeout(() => this.startEngine(), 120);
      }
    };
    rec.onerror = (e: any) => {
      const err = String(e?.error ?? "error");
      if (err === "not-allowed" || err === "service-not-allowed") {
        this.wanted = false;
        this.hooks.status({ supported: true, listening: false, ptt: this.ptt, error: "mic blocked" });
      }
      // "no-speech" / "aborted" / "network": onend restarts us.
    };
    rec.onresult = (ev: any) => this.onResult(ev);
    this.rec = rec;
    this.tick = setInterval(() => this.committer.tick(performance.now()), 50);
  }

  private emitStatus() {
    this.hooks.status({ supported: this.supported, listening: this.running, ptt: this.ptt });
  }

  private startEngine() {
    if (!this.rec || this.running) return;
    try {
      this.rec.start();
    } catch {
      // Already started or not allowed yet (needs a gesture on some setups).
    }
  }

  /** Start continuous listening (call after a user gesture). */
  start() {
    if (!this.opts.continuous) return;
    this.wanted = true;
    this.startEngine();
  }

  stop() {
    this.wanted = false;
    try {
      this.rec?.stop();
    } catch {}
  }

  pttDown() {
    if (this.ptt || !this.rec) return;
    this.ptt = true;
    this.emitStatus();
    this.startEngine();
  }

  pttUp() {
    if (!this.ptt) return;
    this.ptt = false;
    this.committer.flush();
    this.emitStatus();
    if (!this.wanted) {
      try {
        this.rec?.stop();
      } catch {}
    }
  }

  private onResult(ev: any) {
    let text = "";
    let isFinal = true;
    for (let i = this.consumed; i < ev.results.length; i++) {
      const r = ev.results[i];
      text += r[0].transcript;
      if (!r.isFinal) isFinal = false;
    }
    text = text.trim();
    if (!text) return;
    const eve = this.hooks.eve();
    // Push-to-talk means the operator wants this heard even if she's talking.
    const verdict = this.ptt ? "accept" : acceptWhileSpeaking(text, eve.speaking, eve.msSinceStopped);
    if (verdict === "ignore") {
      // Likely her own voice or a mumble: drop it for good.
      if (isFinal) this.consumed = ev.results.length;
      this.committer.reset();
      return;
    }
    if (verdict === "barge-in" && this.bargedFor !== text) {
      this.bargedFor = text;
      this.hooks.bargeIn(text);
    }
    if (text !== this.lastInterim) {
      this.lastInterim = text;
      this.hooks.partial(text);
    }
    if (isFinal) {
      this.consumed = ev.results.length;
      if (!this.ptt) this.committer.final(text);
      else this.committer.interim(text, performance.now());
    } else {
      this.committer.interim(text, performance.now());
    }
    this.pendingIndex = ev.results.length;
  }

  private pendingIndex = 0;

  private commit(text: string) {
    // Everything heard so far belongs to this turn, even if the engine later finalizes it.
    this.consumed = Math.max(this.consumed, this.pendingIndex);
    this.lastInterim = "";
    this.bargedFor = "";
    this.hooks.final(text);
  }

  dispose() {
    clearInterval(this.tick);
    clearTimeout(this.restartTimer);
    this.wanted = false;
    this.ptt = false;
    try {
      this.rec?.abort();
    } catch {}
  }
}
