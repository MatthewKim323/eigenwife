import type { AnyEnvelope, Mood } from "@eigenwife/protocol";
import type { EventBus } from "../bus";
import type { BrainService, SpeechService, TalkerDelegation, TalkerRunHandle, TalkerService } from "../services";
import { sameTurn } from "../ears/flux";
import { STALL_LINES } from "../speech/lines";
import { isCancel, Narrator, waitForGap, type GapProbe, type ProgressSignal } from "./narrate";

/**
 * The talker/thinker router, owned by the reflex module (it holds the reflex
 * slot, the escalation paths and the approvals). It:
 *
 * - starts the talker the moment an utterance arrives (in parallel with Jev),
 *   or even earlier on a Flux EagerEndOfTurn, and adopts or drops that run
 * - speaks the talker's stream; on delegate() speaks the stall (or an ack
 *   clip), then hands the task to the thinker: "answer" -> frontier (jabby
 *   first), "do" -> the reflex's own escalation paths
 * - narrates long thinker runs (rate limited) and delivers results at a
 *   natural gap, never over him
 * - cancels thinker jobs on "never mind"
 */

/** Said when the talker delegated without saying anything itself. Prerendered in her voice (speech/lines.ts). */
export const ACK_CLIPS: string[] = STALL_LINES.slice(0, 4);

export interface RouterTrigger {
  id: string;
  text: string;
  parent?: string;
}

export interface ThinkerJob {
  id: string;
  kind: "answer" | "do";
  task: string;
  userText: string;
  startedAt: number;
  abort: AbortController;
  cancelled: boolean;
  done: boolean;
  result?: string;
}

export interface RouterDeps {
  bus: EventBus;
  talker(): TalkerService | null;
  brains(): BrainService | null;
  speech(): SpeechService | null;
  now(): number;
  sleep?(ms: number): Promise<void>;
  log(...a: unknown[]): void;
  /** Speak on behalf of a trigger (the reflex's say, which knows priority and interrupts). */
  say(text: string | AsyncIterable<string>, parent: string | undefined, opts?: { mood?: Mood; brain?: string; immediate?: boolean }): Promise<string | null>;
  /** Carry out a "do" delegation through the reflex's paths (act / work / agency). acked: the stall already played. */
  doTask(t: RouterTrigger, task: string): Promise<void>;
  /** The reflex slot (one reaction in flight). */
  acquire(): Promise<void>;
  release(): void;
  observe(user: string | undefined, eve: string | null, event: string): Promise<void>;
  /** He's talking right now (world.user.speaking). */
  userSpeaking(): boolean;
  /** Ms of quiet he needs before a deferred result is spoken. */
  gapQuietMs?: number;
  /** Longest a result waits for a gap. */
  gapMaxMs?: number;
  narrator?: Narrator;
  /** How long an unadopted speculative run lives. */
  speculateMs?: number;
}

export interface RespondRequest {
  userText: string;
  event: string;
  behavior: string;
  extra: string;
  maxWords: number;
  fallback: string;
}

function pick<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return arr[Math.abs(h) % arr.length]!;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...` : s);

export class VoiceRouter {
  private pre = new Map<string, Promise<TalkerRunHandle | null>>();
  private spec: { text: string; run: Promise<TalkerRunHandle | null>; timer?: ReturnType<typeof setTimeout> } | null = null;
  readonly jobs = new Map<string, ThinkerJob>();
  private lastResult: { task: string; text: string; at: number } | null = null;
  private lastUserAt = 0;
  private narrator: Narrator;
  private offs: (() => void)[] = [];
  private jobSeq = 0;
  stats = { prestarted: 0, adopted: 0, speculated: 0, speculationHits: 0, dropped: 0, delegations: { answer: 0, do: 0 }, cancelled: 0, narrations: 0 };

  constructor(private d: RouterDeps) {
    this.narrator = d.narrator ?? new Narrator({ now: d.now });
    const on = (type: string, h: (e: AnyEnvelope) => void) => this.offs.push(d.bus.on(type, h));
    on("voice.partial", () => (this.lastUserAt = d.now()));
    on("voice.final", () => (this.lastUserAt = d.now()));
    on("swarm.progress", (e) => this.progress({ kind: "swarm", text: String((e.data as { text?: string }).text ?? "") }));
    on("work.task", (e) => this.progress({ kind: "state", text: String((e.data as { state?: string }).state ?? "") }));
  }

  dispose() {
    this.offs.forEach((o) => o());
    this.spec?.run.then((r) => r?.abort("disposed"));
    for (const j of this.jobs.values()) j.abort.abort();
  }

  get active(): boolean {
    return [...this.jobs.values()].some((j) => !j.done && !j.cancelled);
  }

  /** Talker is usable right now. */
  usable(): boolean {
    return !!this.d.talker()?.available();
  }

  /** Extra prompt lines about thinker state: what she's looking into, the last full result. */
  context(): string[] {
    const lines: string[] = [];
    const open = [...this.jobs.values()].filter((j) => !j.done && !j.cancelled);
    if (open.length) lines.push(`you're already on it (your deeper brain is working): ${open.map((j) => j.task).join("; ")}. if he asks, you're still on it. don't delegate the same thing again.`);
    if (this.lastResult && this.d.now() - this.lastResult.at < 10 * 60_000)
      lines.push(`what your last lookup found (for follow ups like "tell me more"; ${this.lastResult.task}): ${clip(this.lastResult.text, 1500)}`);
    return lines;
  }

  // --- speculation (Flux EagerEndOfTurn) -------------------------------------------------

  speculate(text: string, buildExtra: () => Promise<string>) {
    const talker = this.d.talker();
    if (!talker?.available() || !text.trim()) return;
    if (this.spec && sameTurn(this.spec.text, text)) return;
    this.unspeculate("new eager turn");
    this.stats.speculated++;
    const run = buildExtra()
      .catch(() => "")
      .then((extra) => talker.start({ userText: text, extra }));
    const timer = setTimeout(() => this.unspeculate("not adopted"), this.d.speculateMs ?? 5000);
    (timer as { unref?: () => void }).unref?.();
    this.spec = { text, run, timer };
  }

  unspeculate(reason: string) {
    const s = this.spec;
    if (!s) return;
    this.spec = null;
    if (s.timer) clearTimeout(s.timer);
    void s.run.then((r) => r?.abort(reason));
  }

  // --- prestart: talker in parallel with Jev ------------------------------------------------

  /** Start the talker for an utterance now (or adopt the speculative run for the same words). */
  prestart(t: RouterTrigger, buildExtra: () => Promise<string>) {
    if (this.pre.has(t.id)) return;
    const talker = this.d.talker();
    if (!talker?.available()) return;
    if (this.spec && sameTurn(this.spec.text, t.text)) {
      const s = this.spec;
      this.spec = null;
      if (s.timer) clearTimeout(s.timer);
      this.stats.speculationHits++;
      this.pre.set(t.id, s.run);
      return;
    }
    this.unspeculate("different final");
    this.stats.prestarted++;
    this.pre.set(
      t.id,
      buildExtra()
        .catch(() => "")
        .then((extra) => talker.start({ userText: t.text, extra, parent: t.parent })),
    );
  }

  /** Jev didn't want a talker reply (IGNORE, GLANCE, ACT, ESCALATE): kill the prestarted run. */
  drop(triggerId: string, reason: string) {
    const p = this.pre.get(triggerId);
    if (!p) return;
    this.pre.delete(triggerId);
    this.stats.dropped++;
    void p.then((r) => r?.abort(reason));
  }

  prestarted(triggerId: string): boolean {
    return this.pre.has(triggerId);
  }

  private async take(triggerId: string): Promise<TalkerRunHandle | null> {
    const p = this.pre.get(triggerId);
    if (!p) return null;
    this.pre.delete(triggerId);
    const r = await p;
    if (r && !r.aborted()) {
      this.stats.adopted++;
      return r;
    }
    return null;
  }

  // --- respond ---------------------------------------------------------------------------

  /** Speak the talker's reply for this trigger. Returns what she said, or null when the talker couldn't (caller falls back). */
  async respond(t: RouterTrigger, req: RespondRequest, immediate: boolean): Promise<string | null> {
    const talker = this.d.talker();
    let run = await this.take(t.id);
    if (!run) {
      if (!talker?.available()) return null;
      run = talker.start({ userText: req.userText, event: req.event, behavior: req.behavior, extra: req.extra, maxWords: req.maxWords, parent: t.parent });
    }
    const r = run;
    let delegated: TalkerDelegation | null = null;
    const handled = r.delegation.then((call) => {
      if (!call || r.aborted()) return;
      delegated = call;
      this.onDelegate(t, call, r);
    });
    const self = this;
    const stream = (async function* () {
      let said = false;
      for await (const c of r.text()) {
        if (c.trim()) said = true;
        yield c;
      }
      await handled;
      if (said) return;
      if (delegated) {
        self.narrator.spoke();
        yield pick(ACK_CLIPS, t.id);
      } else if (!r.aborted()) yield req.fallback;
    })();
    const out = await this.d.say(stream, t.parent, { brain: `talker:${r.id}`, immediate });
    if (delegated || r.said()) this.narrator.spoke();
    return out ?? "";
  }

  // --- delegation ----------------------------------------------------------------------------

  private onDelegate(t: RouterTrigger, call: TalkerDelegation, run: TalkerRunHandle) {
    this.stats.delegations[call.kind]++;
    this.d.log(`delegate ${call.kind} (${run.backend() ?? "?"}): ${call.task}${call.stall ? ` [stall "${call.stall}"]` : ""}`);
    this.d.bus.emit("talker.delegate", { runId: run.id, kind: call.kind, task: call.task, ...(call.stall ? { stall: call.stall } : {}), backend: run.backend() ?? undefined }, "core", t.parent);
    if (call.kind === "do") {
      void this.d.doTask(t, call.task).catch((err) => this.d.log("do task failed:", err));
      return;
    }
    void this.answer(t, call.task);
  }

  /** Register a background job (answers, and the reflex's own do-tasks) for narration and cancel. */
  track(kind: "answer" | "do", task: string, userText: string): ThinkerJob {
    const job: ThinkerJob = { id: `job_${++this.jobSeq}`, kind, task, userText, startedAt: this.d.now(), abort: new AbortController(), cancelled: false, done: false };
    this.jobs.set(job.id, job);
    return job;
  }

  finish(job: ThinkerJob) {
    job.done = true;
    this.jobs.delete(job.id);
  }

  /** "never mind": drop every open job. True if there was something to drop. */
  cancel(reason = "never mind"): boolean {
    const open = [...this.jobs.values()].filter((j) => !j.done && !j.cancelled);
    for (const j of open) {
      j.cancelled = true;
      j.abort.abort();
      this.d.log(`cancelled ${j.kind} job: ${j.task} (${reason})`);
    }
    this.stats.cancelled += open.length;
    return open.length > 0;
  }

  isCancel(text: string): boolean {
    return isCancel(text);
  }

  async answer(t: RouterTrigger, task: string): Promise<void> {
    const job = this.track("answer", task, t.text);
    const brains = this.d.brains();
    let text = "";
    let ok = false;
    try {
      if (!brains) throw new Error("no brains service");
      const r = await brains.frontier({
        goal: [
          `he asked you, out loud: "${t.text}"`,
          `task: ${task}`,
          "find the real answer with your tools and memory. reply in plain text, facts first, no markdown, no preamble. if you can't find it, say what you tried.",
        ].join("\n"),
        tools: "read",
        timeoutMs: 150_000,
        signal: job.abort.signal,
        onEvent: (e) => {
          if (e.kind === "tool") this.progress({ kind: "tool", tool: e.name });
        },
      });
      ok = r.ok && !!r.text.trim();
      text = r.ok ? r.text.trim() : "";
      if (!r.ok) this.d.log(`thinker failed: ${r.error ?? "?"}`);
    } catch (err) {
      this.d.log("thinker threw:", err);
    }
    if (job.cancelled) return this.finish(job);
    job.result = text;
    if (ok) this.lastResult = { task, text, at: this.d.now() };
    await this.deliver(job, async (say) => {
      const brains2 = this.d.brains();
      const fallback = ok ? clip(text.split(/(?<=[.!?])\s+/).slice(0, 2).join(" "), 280) : "couldn't get that one. my deeper brain isn't answering.";
      if (!brains2 || !ok) return say(fallback, ok ? "happy" : "sad");
      const src = brains2.persona({
        event: `you looked something up for him: ${task}`,
        behavior: "report",
        userText: t.text,
        extra: [
          `what you found (ground truth, only say what's here): ${clip(text, 3000)}`,
          "say the answer in at most three short spoken sentences, most useful part first. if there's clearly more, end with a short offer like want the rest?",
        ].join("\n"),
        marks: true,
        maxWords: 55,
      });
      const guarded = (async function* () {
        let any = false;
        try {
          for await (const c of src) {
            if (c.trim()) any = true;
            yield c;
          }
        } catch {}
        if (!any) yield fallback;
      })();
      return say(guarded);
    });
  }

  /**
   * Speak a finished job's result at a natural gap (not over him, not over
   * herself), holding the reflex slot so a fresh reply can't interleave.
   */
  async deliver(job: ThinkerJob, speak: (say: (src: string | AsyncIterable<string>, mood?: Mood) => Promise<string | null>) => Promise<string | null>) {
    try {
      await this.waitGap(job.abort.signal);
      if (job.cancelled) return;
      await this.d.acquire();
      try {
        if (job.cancelled) return;
        const said = await speak((src, mood) => this.d.say(src, undefined, { mood, brain: "thinker" }));
        this.narrator.spoke();
        await this.d.observe(job.userText, said, `looked up: ${job.task}. ${clip(job.result ?? "", 400)}`);
      } finally {
        this.d.release();
      }
    } finally {
      this.finish(job);
    }
  }

  /** Wait for a natural gap in the conversation (true when a real gap was found). */
  waitGap(signal?: AbortSignal): Promise<boolean> {
    const probe: GapProbe = {
      speaking: () => this.d.speech()?.speaking() ?? false,
      userSpeaking: () => this.d.userSpeaking(),
      lastUserAt: () => this.lastUserAt,
      now: this.d.now,
      sleep: this.d.sleep ?? ((ms) => Bun.sleep(ms)),
    };
    // Unit tests run the reflex with no real audio: no gap to wait for unless a test asks.
    const test = process.env.NODE_ENV === "test";
    return waitForGap(probe, { quietMs: this.d.gapQuietMs ?? (test ? 0 : 1200), maxMs: this.d.gapMaxMs ?? (test ? 2000 : 30_000), signal });
  }

  // --- progress narration --------------------------------------------------------------------

  progress(p: ProgressSignal) {
    const open = [...this.jobs.values()].filter((j) => !j.done && !j.cancelled);
    if (!open.length) return;
    const speech = this.d.speech();
    if (!speech || speech.speaking() || this.d.userSpeaking() || this.d.now() - this.lastUserAt < 1500) return;
    const oldest = Math.min(...open.map((j) => j.startedAt));
    const phrase = this.narrator.offer(p, oldest);
    if (!phrase) return;
    this.stats.narrations++;
    void speech.say(phrase, { priority: "low", brain: "narration", mood: "thinking" });
  }
}
