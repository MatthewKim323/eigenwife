/**
 * Progress narration for long thinker runs, and the "natural gap" wait for
 * delivering results. Pure logic plus an injectable clock, so the rate limits
 * are tested without timers.
 */

export interface ProgressSignal {
  /** swarm.progress text, a frontier tool name, or a task/work state. */
  kind: "swarm" | "tool" | "state";
  text?: string;
  tool?: string;
}

const TOOL_PHRASES: [RegExp, string][] = [
  [/web_?search|search|google|firecrawl/i, "searching the web"],
  [/web_?fetch|fetch|browse|browser|page/i, "reading a page"],
  [/calendar|event/i, "checking your calendar"],
  [/gmail|email|mail|inbox/i, "checking your email"],
  [/imessage|message|text|discord|slack/i, "checking your messages"],
  [/map|place|restaurant|yelp/i, "checking the map"],
  [/spotify|music/i, "checking spotify"],
  [/gbrain|memory|recall|brain/i, "checking my notes on you"],
  [/read|grep|glob|file|ls|find/i, "digging through files"],
  [/bash|shell|exec|run|test/i, "running something"],
  [/edit|write|patch/i, "writing it"],
];

const STATE_PHRASES: Record<string, string> = {
  working: "working on it",
  testing: "running the tests",
  review: "checking my work",
  merging: "wrapping it up",
};

const LEADS = ["still on it, ", "okay, ", "mm, ", ""];

function tidy(s: string): string {
  return s
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[`*_#"{}[\]<>]/g, "")
    .replace(/^\s*(?:\w+\s*)?(?:agent|worker|wife)\s*\d*\s*[:>-]\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!…]+$/, "")
    .toLowerCase();
}

/** A short spoken phrase for a progress signal, or null if there's nothing worth saying. */
export function progressPhrase(p: ProgressSignal, seed = 0): string | null {
  let core: string | null = null;
  if (p.kind === "tool" && p.tool) core = TOOL_PHRASES.find(([re]) => re.test(p.tool!))?.[1] ?? null;
  else if (p.kind === "state" && p.text) core = STATE_PHRASES[p.text] ?? null;
  else if (p.kind === "swarm" && p.text) {
    const t = tidy(p.text);
    const words = t.split(" ").filter(Boolean);
    if (words.length < 2 || /^[\d\W]+$/.test(t) || /error|failed|exception|traceback/i.test(t)) return null;
    core = words.slice(0, 9).join(" ");
  }
  if (!core) return null;
  const lead = LEADS[Math.abs(seed) % LEADS.length]!;
  return `${lead}${core}.`;
}

export interface NarratorOptions {
  /** At most one spoken update per this many ms (per narrator). */
  minGapMs?: number;
  /** Nothing in the first ms of a job: the stall already covered it. */
  graceMs?: number;
  now?: () => number;
}

/** Rate limits progress updates: one every ~6s at most, none right after the stall, no repeats. */
export class Narrator {
  private lastAt = -Infinity;
  private lastPhrase = "";
  private n = 0;
  readonly minGapMs: number;
  readonly graceMs: number;
  private now: () => number;

  constructor(o: NarratorOptions = {}) {
    this.minGapMs = o.minGapMs ?? 6000;
    this.graceMs = o.graceMs ?? 4000;
    this.now = o.now ?? Date.now;
  }

  /** Mark that she just said something about this job (stall, earlier update). */
  spoke() {
    this.lastAt = this.now();
  }

  /** The phrase to speak now, or null (too soon, too early, a repeat, nothing to say). */
  offer(p: ProgressSignal, jobStartedAt: number): string | null {
    const t = this.now();
    if (t - jobStartedAt < this.graceMs) return null;
    if (t - this.lastAt < this.minGapMs) return null;
    const phrase = progressPhrase(p, this.n);
    if (!phrase) return null;
    const bare = phrase.replace(/^(?:still on it, |okay, |mm, )/, "");
    if (bare === this.lastPhrase) return null;
    this.lastPhrase = bare;
    this.lastAt = t;
    this.n++;
    return phrase;
  }
}

export interface GapProbe {
  /** She's talking. */
  speaking(): boolean;
  /** He's talking (mid-utterance) right now. */
  userSpeaking(): boolean;
  /** When he last said anything (partial or final). */
  lastUserAt(): number;
  now(): number;
  sleep(ms: number): Promise<void>;
}

/**
 * Wait for a natural gap: she's not talking, he's not talking, and he's been
 * quiet for quietMs. Gives up after maxMs (the result still gets said; a
 * minute of silence is worse than an interruption). Resolves true on a real gap.
 */
export async function waitForGap(p: GapProbe, opts: { quietMs?: number; maxMs?: number; pollMs?: number; signal?: AbortSignal } = {}): Promise<boolean> {
  const quiet = opts.quietMs ?? 1200;
  const max = opts.maxMs ?? 30_000;
  const poll = opts.pollMs ?? 200;
  const start = p.now();
  while (!opts.signal?.aborted) {
    const t = p.now();
    if (!p.speaking() && !p.userSpeaking() && t - p.lastUserAt() >= quiet) return true;
    if (t - start >= max) return false;
    await p.sleep(poll);
  }
  return false;
}

/** "never mind", "forget it", "cancel that": drop whatever she's off doing. */
const CANCEL =
  /^(?:(?:oh|ah|actually|nah|no|okay|ok|wait)[,\s]+)*(?:never\s*mind|nevermind|nvm|forget (?:it|about it|that)|cancel(?: (?:it|that|the (?:search|task|lookup)))?|scratch that|don'?t (?:worry about it|bother)|stop (?:looking|searching|checking)|drop it)\b[\s.!,]*(?:eve|babe|please)?[\s.!]*$/i;

export function isCancel(text: string): boolean {
  return CANCEL.test(text.trim());
}
