import {
  TRAIT_KEYS,
  clamp01,
  type Candidate,
  type EventMap,
  type Persona,
  type RegionStats,
  type TraitKey,
  type TraitVector,
} from "@eigenwife/protocol";

/**
 * Local Act I math, used when the core's preference module is silent (core
 * down, or not built yet). Same shape as the core's output so the UI never
 * knows the difference:
 *
 *   P = Σ(r_i · E_i) / Σ r_i
 *
 * E_i is the candidate's trait vector nudged toward what the user actually
 * looked at (region emphasis weighted by dwell), r_i the attention reward.
 */

export type Signal = EventMap["dating.signal"];
export type PrefUpdate = EventMap["preference.update"];

export interface Engagement {
  dwellMs: number;
  revisits: number;
  totalMs: number;
  score: number;
}

export function engagement(regions: Record<string, RegionStats>, totalMs: number): Engagement {
  let dwellMs = 0;
  let revisits = 0;
  for (const s of Object.values(regions)) {
    dwellMs += s.dwellMs;
    revisits += s.revisits;
  }
  const quickSkip = totalMs < 2500 ? 0.25 : 0;
  const score = clamp01(0.1 + dwellMs / 6500 + revisits * 0.07 - quickSkip);
  return { dwellMs, revisits, totalMs, score };
}

/** Interest distribution from engagement, shaped like Jev's output. */
export function localSignal(candidateId: string, regions: Record<string, RegionStats>, totalMs: number): Signal {
  const { score: s } = engagement(regions, totalMs);
  const raw = {
    skip: clamp01((0.38 - s) * 2.6) + 0.02,
    neutral: clamp01(1 - Math.abs(s - 0.3) * 3) * 0.7 + 0.04,
    inspect: clamp01(1 - Math.abs(s - 0.58) * 2.6) * 0.8 + 0.03,
    positive: clamp01((s - 0.45) * 2.2) + 0.02,
  };
  const sum = raw.skip + raw.neutral + raw.inspect + raw.positive;
  const interest = {
    skip: round2(raw.skip / sum),
    neutral: round2(raw.neutral / sum),
    inspect: round2(raw.inspect / sum),
    positive: round2(raw.positive / sum),
  };
  return { candidateId, interest, strength: round2(clamp01(Math.abs(s - 0.4) * 1.9 + 0.1)), reward: round2(Math.max(0.02, s)), by: "local" };
}

/** Candidate vector nudged toward the regions that got attention. */
export function evidenceVector(c: Candidate, regions: Record<string, RegionStats>): Record<TraitKey, number> {
  const weights = new Map<string, number>();
  let W = 0;
  for (const r of c.regions) {
    const s = regions[`cand_${c.id}_${r.id}`];
    if (!s) continue;
    const w = s.dwellMs / 1000 + s.revisits * 0.6;
    if (w <= 0) continue;
    weights.set(r.id, w);
    W += w;
  }
  const out = { ...c.traits };
  if (W === 0) return out;
  for (const r of c.regions) {
    const w = weights.get(r.id);
    if (!w) continue;
    for (const [k, v] of Object.entries(r.emphasis) as [TraitKey, number][]) {
      out[k] = clamp01(out[k] + (w / W) * v * 0.5);
    }
  }
  return out;
}

export function populationMean(cands: readonly Candidate[]): Record<TraitKey, number> {
  const m = Object.fromEntries(TRAIT_KEYS.map((k) => [k, 0])) as Record<TraitKey, number>;
  if (!cands.length) return m;
  for (const c of cands) for (const k of TRAIT_KEYS) m[k] += c.traits[k];
  for (const k of TRAIT_KEYS) m[k] /= cands.length;
  return m;
}

/** 1 - 0.64^n: ~0.98 after 9 profiles. */
export function localProgress(observations: number): number {
  return Math.min(0.99, round2(1 - Math.pow(0.64, observations)));
}

export class LocalPreference {
  private sum: Record<TraitKey, number> = Object.fromEntries(TRAIT_KEYS.map((k) => [k, 0])) as Record<TraitKey, number>;
  private rewardSum = 0;
  observations = 0;
  vector: TraitVector = {};

  constructor(private cands: readonly Candidate[]) {}

  observe(c: Candidate, regions: Record<string, RegionStats>, totalMs: number): { signal: Signal; update: PrefUpdate } {
    const signal = localSignal(c.id, regions, totalMs);
    const E = evidenceVector(c, regions);
    const r = signal.reward;
    for (const k of TRAIT_KEYS) this.sum[k] += r * E[k];
    this.rewardSum += r;
    this.observations += 1;
    const prev = this.vector;
    const next: TraitVector = {};
    for (const k of TRAIT_KEYS) next[k] = round2(this.sum[k] / this.rewardSum);
    const deltas: TraitVector = {};
    for (const k of TRAIT_KEYS) deltas[k] = round2(next[k]! - (prev[k] ?? populationMean(this.cands)[k]));
    this.vector = next;
    return { signal, update: { vector: next, deltas, progress: localProgress(this.observations), observations: this.observations } };
  }
}

/**
 * What makes this vector "your type": each trait relative to the candidate
 * pool, scaled into a readable -0.99..0.99 ("humor +0.82").
 */
export function lifts(vector: TraitVector, cands: readonly Candidate[]): { key: TraitKey; lift: number }[] {
  const mean = populationMean(cands);
  return TRAIT_KEYS.filter((k) => vector[k] !== undefined)
    .map((k) => ({ key: k, lift: Math.max(-0.99, Math.min(0.99, round2((vector[k]! - mean[k]) * 2.6))) }))
    .sort((a, b) => Math.abs(b.lift) - Math.abs(a.lift));
}

/** Where each trait sits on the OKLCH hue wheel: Eve's color is her type. */
export const TRAIT_HUES: Record<TraitKey, number> = {
  style: 320,
  sporty: 165,
  alternative: 285,
  polished: 250,
  humor: 335,
  sarcasm: 300,
  warmth: 25,
  ambition: 235,
  spontaneity: 350,
  nerdiness: 205,
  chaos: 345,
  nightlife: 295,
  outdoors: 145,
  fitness: 160,
  travel: 190,
  career_focus: 240,
};

/** Circular mean of trait hues weighted by positive lift. */
export function personaHue(vector: TraitVector, cands: readonly Candidate[]): number {
  let x = 0;
  let y = 0;
  for (const { key, lift } of lifts(vector, cands)) {
    if (lift <= 0) continue;
    const a = (TRAIT_HUES[key] * Math.PI) / 180;
    x += Math.cos(a) * lift;
    y += Math.sin(a) * lift;
  }
  if (x === 0 && y === 0) return 330;
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

export function localPersona(vector: TraitVector, cands: readonly Candidate[]): Persona {
  const mean = populationMean(cands);
  const dial = (k: TraitKey) => round2(clamp01(0.55 + ((vector[k] ?? mean[k]) - mean[k]) * 2.5));
  const top = lifts(vector, cands)
    .filter((l) => l.lift > 0)
    .slice(0, 3)
    .map((l) => l.key.replace("_", " "));
  const dials = {
    humor: dial("humor"),
    sarcasm: dial("sarcasm"),
    warmth: dial("warmth"),
    initiative: round2((dial("ambition") + dial("spontaneity")) / 2),
    verbosity: round2(clamp01(0.3 + (dial("warmth") - dial("sarcasm")) * 0.3)),
    chaos: dial("chaos"),
  };
  return {
    name: "Eve",
    tagline: "Your type, compiled.",
    description: `Compiled from attention. Leans ${top.join(", ") || "balanced"}.`,
    personality: `Humor ${dials.humor}, sarcasm ${dials.sarcasm}, warmth ${dials.warmth}. Short sentences. Notices things.`,
    scenario: "She just stepped out of the dating app onto your desktop.",
    dials,
    voice: { provider: "browser", voiceId: "default", style: "dry, warm, quick" },
    palette: { hue: personaHue(vector, cands) },
    vector,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
