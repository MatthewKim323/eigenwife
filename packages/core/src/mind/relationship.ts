import { clamp01, DEFAULT_RELATIONSHIP, type Persona, type RelationshipState } from "@eigenwife/protocol";

/**
 * The relationship model: five slow scalars, separate from memory. Memory is
 * what happened; this is how it feels. Every change is a bounded nudge, and
 * everything relaxes back toward the persona's baseline over time, so one bad
 * minute never permanently rewires her.
 */

export const KEYS: (keyof RelationshipState)[] = ["banter", "warmth", "initiative", "verbosity", "confidence"];

/** A single nudge can move a scalar at most this far. */
export const MAX_STEP = 0.1;
/** Scalars live in [FLOOR, CEIL]: she never becomes fully silent or fully unhinged. */
export const FLOOR = 0.05;
export const CEIL = 0.95;
/** Half-life of the pull back toward baseline. */
export const HALF_LIFE_MS = 30 * 60_000;

const bound = (v: number) => Math.min(CEIL, Math.max(FLOOR, v));
const r3 = (v: number) => Math.round(v * 1000) / 1000;

export function applyNudge(state: RelationshipState, delta: Partial<RelationshipState>): { state: RelationshipState; applied: Partial<RelationshipState> } {
  const next = { ...state };
  const applied: Partial<RelationshipState> = {};
  for (const k of KEYS) {
    const d = delta[k];
    if (typeof d !== "number" || !Number.isFinite(d) || d === 0) continue;
    const step = Math.max(-MAX_STEP, Math.min(MAX_STEP, d));
    const v = r3(bound(state[k] + step));
    if (v !== state[k]) {
      applied[k] = r3(v - state[k]);
      next[k] = v;
    }
  }
  return { state: next, applied };
}

/** Exponential relaxation toward baseline over dtMs. */
export function decay(state: RelationshipState, baseline: RelationshipState, dtMs: number, halfLifeMs = HALF_LIFE_MS): RelationshipState {
  if (dtMs <= 0) return state;
  const keep = Math.pow(0.5, dtMs / halfLifeMs);
  const out = { ...state };
  for (const k of KEYS) out[k] = bound(baseline[k] + (state[k] - baseline[k]) * keep);
  return out;
}

export function distance(a: RelationshipState, b: RelationshipState): number {
  return Math.max(...KEYS.map((k) => Math.abs(a[k] - b[k])));
}

/** Seed her baseline from the persona that Act I converged on. */
export function seedFromPersona(p: Persona | undefined | null): RelationshipState {
  if (!p?.dials) return { ...DEFAULT_RELATIONSHIP };
  const d = p.dials;
  return {
    banter: r3(bound(clamp01((d.humor + d.sarcasm) / 2))),
    warmth: r3(bound(clamp01(d.warmth))),
    initiative: r3(bound(clamp01(d.initiative))),
    verbosity: r3(bound(clamp01(d.verbosity))),
    confidence: DEFAULT_RELATIONSHIP.confidence,
  };
}

export interface Signal {
  delta: Partial<RelationshipState>;
  reason: string;
}

const LAUGH = /\b(?:lol+|lmao+|lmfao|haha+|hehe+|rofl|dead|i'?m crying)\b|😂|🤣|💀/i;
const POSITIVE = /\b(?:true|fair|facts|real|good one|nice one|love (?:that|it|this)|you'?re (?:funny|right|so right)|so true|valid|period)\b/i;
const DISMISS = /\b(?:stop|not now|shut up|be quiet|no thanks|nah|leave me alone|go away|quiet|enough|not interested|don'?t care)\b/i;
const RUDE = /\b(?:shut up|you'?re annoying|annoying|go away|leave me alone)\b/i;
const THANKS = /\b(?:thanks|thank you|ty|love you|you'?re the best|appreciate (?:it|you)|good girl|you'?re amazing)\b/i;

export interface SignalContext {
  /** ms since she last finished (or started) speaking; replies are judged against her line. */
  sinceHerLineMs?: number;
  /** Consecutive back-and-forth turns so far in this conversation, including this one. */
  turns?: number;
}

/** What an utterance says about how things are going. */
export function readSignals(text: string, ctx: SignalContext = {}): Signal[] {
  const t = text.trim();
  if (!t) return [];
  const words = t.split(/\s+/).length;
  const reply = ctx.sinceHerLineMs !== undefined && ctx.sinceHerLineMs < 30_000;
  const out: Signal[] = [];
  const laughed = LAUGH.test(t);
  const dismissed = DISMISS.test(t) && words <= 8;
  if (laughed) out.push({ delta: { banter: 0.03, warmth: 0.01 }, reason: "user laughed" });
  else if (reply && POSITIVE.test(t) && !dismissed) out.push({ delta: { banter: 0.03 }, reason: "positive reply to banter" });
  if (dismissed) {
    out.push({ delta: { initiative: -0.04 }, reason: "user dismissed her" });
    if (RUDE.test(t)) out.push({ delta: { warmth: -0.02, banter: -0.01 }, reason: "user was short with her" });
  }
  if (THANKS.test(t)) out.push({ delta: { warmth: 0.03 }, reason: "user was sweet" });
  if (reply && !laughed && !dismissed) {
    if (words <= 2) out.push({ delta: { verbosity: -0.02 }, reason: "terse reply" });
    else if (words >= 15) out.push({ delta: { verbosity: 0.01, warmth: 0.01 }, reason: "long engaged reply" });
  }
  if (ctx.turns && ctx.turns >= 4 && ctx.turns % 4 === 0) out.push({ delta: { warmth: 0.02, confidence: 0.01 }, reason: `engaged conversation (${ctx.turns} turns)` });
  return out;
}

/** Fold many signals into one delta + reason line. */
export function combine(signals: Signal[]): Signal | null {
  if (!signals.length) return null;
  const delta: Partial<RelationshipState> = {};
  for (const s of signals) for (const k of KEYS) if (s.delta[k]) delta[k] = r3((delta[k] ?? 0) + s.delta[k]!);
  return { delta, reason: signals.map((s) => s.reason).join(", ") };
}
