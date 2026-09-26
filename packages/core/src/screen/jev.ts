import { SCREEN_MODES, type ScreenMode } from "@eigenwife/protocol";
import type { Digest } from "./summarize";

/**
 * Jev judges the compact screen summary with four typed questions: mode
 * (choice), stuck (boolean, a TypeSafe "noul"), interesting (score) and
 * sensitive (boolean). Same endpoint as the reflex (AI Gateway /v1/evaluate
 * or TypeSafe systemone). Only the summary line and a few numbers are sent,
 * never raw screen text. Any failure falls back to the local guesses.
 */

export interface ScreenScores {
  mode: ScreenMode;
  stuck: boolean;
  interesting: number;
  sensitive: boolean;
}

export interface ScreenJudgement {
  scores: ScreenScores;
  by: "jev" | "local";
  latencyMs: number;
  reason?: string;
}

export interface ScreenJevInput {
  digest: Digest;
  /** ms the same error has been visible. */
  stuckMs: number;
  /** Seconds since the last keyboard/mouse input, null when unknown. */
  idleSeconds: number | null;
}

export const MODE_CRITERIA: Record<ScreenMode, string> = {
  coding: "Writing or reading code in an editor or terminal, no visible error.",
  debugging: "An error, stack trace, failing test or broken build is on screen.",
  reading: "Reading an article, docs, a PDF or a long page.",
  writing: "Writing prose: a document, notes, an email draft.",
  shopping: "Looking at products, prices, a cart or a store.",
  social: "Social media, chat, a feed, forums.",
  video: "Watching a video or stream.",
  gaming: "Playing or browsing a game.",
  idle: "Nothing in particular: a desktop, a launcher, an empty window.",
};

export const INTEREST_LEVELS = ["boring: nothing a friend would mention", "mildly interesting", "interesting: a friend glancing over might say something", "very interesting: a friend would definitely comment"];

export function screenQuestions() {
  return {
    mode: { type: "choice", instructions: "What is the user doing on screen right now?", criteria: MODE_CRITERIA },
    stuck: {
      type: "noul",
      instructions: "Is the user stuck: the same error or problem has been on screen for minutes without progress?",
      criteria: { true: "The same error has persisted for several minutes; they would welcome help.", false: "No error, or it just appeared, or they are making progress." },
    },
    interesting: { type: "score", instructions: "How interesting is this screen for a witty friend sitting next to them to remark on?", criteria: INTEREST_LEVELS },
    sensitive: {
      type: "noul",
      instructions: "Does this look private or sensitive (banking, passwords, medical, legal, intimate messages, personal identity documents)?",
      criteria: { true: "Private: a companion should look away and not remember it.", false: "Ordinary content." },
    },
  };
}

/** The state Jev sees: the local summary and a few numbers. Never raw text. */
export function screenState(i: ScreenJevInput) {
  return {
    task: "Classify what is on the user's screen for Eve, a desktop companion who glances over sometimes.",
    app: i.digest.app,
    summary: i.digest.summary,
    error_visible: !!i.digest.error,
    same_error_for_seconds: i.digest.error ? Math.round(i.stuckMs / 1000) : 0,
    seconds_since_input: i.idleSeconds === null ? null : Math.round(i.idleSeconds),
  };
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Parse Jev's answers. Throws when the mode answer is missing or unknown. Tolerates missing extras (filled from local). */
export function parseScreenJev(body: unknown, local: ScreenScores): ScreenScores {
  const a = (body as { answers?: Record<string, Record<string, unknown>> })?.answers;
  if (!a || typeof a !== "object") throw new Error("jev: no answers");
  const choice = typeof a.mode?.choice === "string" ? (a.mode.choice as string).toLowerCase() : "";
  if (!SCREEN_MODES.includes(choice as ScreenMode)) throw new Error(`jev: bad mode ${String(a.mode?.choice)}`);
  const bool = (q: Record<string, unknown> | undefined, fallback: boolean) => {
    if (!q) return fallback;
    const p = num(q.noul) ?? num(q.probability) ?? num(q.score);
    if (p !== null) return p >= 0.5;
    if (typeof q.value === "boolean") return q.value;
    if (typeof q.choice === "string") return /^(?:true|yes)$/i.test(q.choice);
    return fallback;
  };
  let interesting = local.interesting;
  const s = a.interesting;
  if (s) {
    const score = num(s.score);
    const n = INTEREST_LEVELS.length - 1;
    if (score !== null) interesting = Math.max(0, Math.min(1, score / n));
  }
  return { mode: choice as ScreenMode, stuck: bool(a.stuck, local.stuck), interesting: Math.round(interesting * 100) / 100, sensitive: bool(a.sensitive, local.sensitive) };
}

/** Stuck, locally: the same error has been up for the threshold, and they aren't mid-typing a fix. */
export function localStuck(i: ScreenJevInput, thresholdMs: number): boolean {
  return !!i.digest.error && i.stuckMs >= thresholdMs;
}

export function localScores(i: ScreenJevInput, stuckMs: number): ScreenScores {
  return { mode: i.digest.guess.mode, stuck: localStuck(i, stuckMs), interesting: i.digest.guess.interesting, sensitive: i.digest.guess.sensitive };
}

export interface ScreenJevOptions {
  apiKey?: string;
  url?: string;
  model?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** How long an error must persist before it counts as stuck (local fallback). */
  stuckMs?: number;
  breaker?: { failures: number; coolMs: number };
}

export interface ScreenJev {
  judge(i: ScreenJevInput): Promise<ScreenJudgement>;
  status(): { remote: boolean; failures: number; lastError?: string };
}

export function createScreenJev(opts: ScreenJevOptions = {}): ScreenJev {
  const timeoutMs = opts.timeoutMs ?? 1500;
  const stuckMs = opts.stuckMs ?? 5 * 60_000;
  const doFetch = opts.fetchImpl ?? fetch;
  const clock = opts.now ?? Date.now;
  const breaker = opts.breaker ?? { failures: 3, coolMs: 60_000 };
  let failures = 0;
  let openUntil = 0;
  let lastError: string | undefined;
  return {
    status: () => ({ remote: !!opts.apiKey, failures, lastError }),
    async judge(i) {
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      const local = localScores(i, stuckMs);
      if (!opts.apiKey) return { scores: local, by: "local", latencyMs: ms() };
      if (clock() < openUntil) return { scores: local, by: "local", latencyMs: ms(), reason: "jev breaker open" };
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);
      try {
        const res = await doFetch(opts.url ?? "https://api.typesafe.ai/v1/systemone", {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: opts.model ?? "jev-latest", state: screenState(i), questions: screenQuestions() }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 160)}`);
        const scores = parseScreenJev(await res.json(), local);
        failures = 0;
        // Stuck needs time on the clock: Jev can't call a 10-second-old error "stuck".
        if (scores.stuck && i.stuckMs < stuckMs / 2) scores.stuck = false;
        // Local privacy is a floor: Jev can add "sensitive", never remove it.
        if (local.sensitive) scores.sensitive = true;
        return { scores, by: "jev", latencyMs: ms() };
      } catch (err) {
        failures += 1;
        lastError = ctl.signal.aborted ? `jev timeout ${timeoutMs}ms` : err instanceof Error ? err.message : String(err);
        if (failures >= breaker.failures) openUntil = clock() + breaker.coolMs;
        return { scores: local, by: "local", latencyMs: ms(), reason: `fallback: ${lastError}` };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
