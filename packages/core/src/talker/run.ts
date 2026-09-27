import { describe, HealthBook } from "../brains/health";
import type { BrainIO } from "../brains/io";
import { guardSpoken, LeakError } from "../brains/text";
import type { TalkerBackend, TalkerMessage } from "./backends";
import type { DelegateCall } from "./tools";

/**
 * One talker turn. It starts streaming the moment it's created (before Jev
 * has decided, before the reflex slot is free) and buffers everything, so a
 * consumer that attaches later replays from the first word. Backends are
 * tried in order and fall through on any failure before the first word, like
 * the persona router. abort() kills the stream (Jev said IGNORE, he kept
 * talking, the turn was resumed).
 */

/** A replayable async channel: many readers, each from the start. */
export class Replay<T> {
  private items: T[] = [];
  private closed = false;
  private waiters: (() => void)[] = [];

  push(v: T) {
    if (this.closed) return;
    this.items.push(v);
    this.wake();
  }

  close() {
    this.closed = true;
    this.wake();
  }

  get done() {
    return this.closed;
  }

  snapshot(): T[] {
    return [...this.items];
  }

  private wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  async *read(): AsyncGenerator<T> {
    let i = 0;
    while (true) {
      if (i < this.items.length) {
        yield this.items[i++]!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

export interface TalkerRequest {
  userText: string;
  event?: string;
  behavior?: string;
  extra?: string;
  maxWords?: number;
  parent?: string;
}

export interface TalkerDeps {
  io: BrainIO;
  backends: TalkerBackend[];
  prompt(req: TalkerRequest): TalkerMessage;
  maxTokens(req: TalkerRequest): number;
  health?: HealthBook;
  /** Her names, for stripping "Eve:" labels. */
  names?(): string[];
  log?(...a: unknown[]): void;
}

let seq = 0;

export class TalkerRun {
  readonly id = `talk_${(++seq).toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  readonly text = new Replay<string>();
  readonly startedAt: number;
  firstTextAt: number | null = null;
  backend: string | null = null;
  said = "";
  errors: string[] = [];
  /** The delegate call, as soon as it's known (or null at the end). */
  readonly delegation: Promise<DelegateCall | null>;
  /** Resolves when the stream is over (any outcome). */
  readonly finished: Promise<void>;
  call: DelegateCall | null = null;
  stalled = false;
  private resolveCall!: (c: DelegateCall | null) => void;
  private resolveFinished!: () => void;
  private ac = new AbortController();
  abortReason: string | null = null;

  constructor(
    readonly req: TalkerRequest,
    now: number,
  ) {
    this.startedAt = now;
    this.delegation = new Promise((r) => (this.resolveCall = r));
    this.finished = new Promise((r) => (this.resolveFinished = r));
  }

  get signal() {
    return this.ac.signal;
  }

  get aborted() {
    return this.ac.signal.aborted;
  }

  /** Nothing usable came out (every backend failed, or aborted before a word). */
  get empty() {
    return this.text.done && !this.said.trim() && !this.call;
  }

  abort(reason = "aborted") {
    if (this.aborted) return;
    this.abortReason = reason;
    this.ac.abort();
    this.settle(null);
  }

  delegate(c: DelegateCall) {
    if (this.call) return;
    this.call = c;
    this.resolveCall(c);
  }

  settle(call: DelegateCall | null) {
    if (call) this.delegate(call);
    this.resolveCall(this.call);
    this.text.close();
    this.resolveFinished();
  }
}

export interface Talker {
  start(req: TalkerRequest): TalkerRun;
  available(): boolean;
  backends: TalkerBackend[];
  health: HealthBook;
}

const endPunct = (s: string) => (/[.!?…]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);

export function createTalker(deps: TalkerDeps): Talker {
  const health = deps.health ?? new HealthBook(deps.io.now);
  const log = deps.log ?? (() => {});
  const now = deps.io.now;

  function order(): TalkerBackend[] {
    const configured = deps.backends.filter((b) => b.configured());
    const lastResort = configured.at(-1);
    const allParked = configured.every((b) => health.cooling(b.name));
    return configured.filter((b) => !health.cooling(b.name) || (allParked && b === lastResort));
  }

  async function drive(run: TalkerRun) {
    let msg: TalkerMessage;
    try {
      msg = deps.prompt(run.req);
    } catch (err) {
      run.errors.push(`prompt: ${describe(err)}`);
      return run.settle(null);
    }
    const maxTokens = deps.maxTokens(run.req);
    for (const b of order()) {
      if (run.aborted) return run.settle(null);
      const start = now();
      let spoke = false;
      let rawText = false;
      const events = b.stream(msg, { maxTokens, temperature: 0.9, signal: run.signal, userText: run.req.userText });
      const textOnly = async function* (): AsyncGenerator<string> {
        for await (const e of events) {
          if (run.aborted) return;
          if (e.type === "text") {
            if (e.text.trim()) rawText = true;
            yield e.text;
          } else if (e.type === "stall") {
            if (!rawText && !run.stalled) {
              run.stalled = true;
              yield ` ${endPunct(e.text)} `;
            }
          } else if (e.type === "delegate") {
            run.delegate(e.call);
          }
        }
      };
      try {
        for await (const chunk of guardSpoken(textOnly(), deps.names?.() ?? ["eve"])) {
          if (run.aborted) break;
          if (!spoke) {
            spoke = true;
            run.backend = b.name;
            run.firstTextAt = now();
          }
          run.said += chunk;
          run.text.push(chunk);
        }
        if (run.aborted) return run.settle(null);
        if (!spoke && !run.call) throw new Error("empty reply");
        run.backend ??= b.name;
        run.firstTextAt ??= now();
        health.ok(b.name, now() - start, (run.firstTextAt ?? now()) - start, b.model());
        return run.settle(null);
      } catch (err) {
        if (run.aborted) return run.settle(null);
        health.fail(b.name, err);
        run.errors.push(`${b.name}: ${err instanceof LeakError ? "error text suppressed" : describe(err).slice(0, 160)}`);
        log(`talker ${b.name} failed:`, run.errors.at(-1));
        // Already spoke (or already delegated): the partial line stands, never restart in another voice.
        if (spoke || run.call) {
          run.backend ??= b.name;
          return run.settle(null);
        }
      }
    }
    run.settle(null);
  }

  return {
    backends: deps.backends,
    health,
    available: () => order().length > 0,
    start(req) {
      const run = new TalkerRun(req, now());
      void drive(run).catch((err) => {
        run.errors.push(describe(err));
        run.settle(null);
      });
      return run;
    },
  };
}
