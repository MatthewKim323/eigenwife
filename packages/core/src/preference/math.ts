import { TRAIT_GROUPS, TRAIT_KEYS, type Candidate, type CandidateRegion, type RegionStats, type TraitKey, type TraitVector } from "@eigenwife/protocol";

/**
 * Act I math: a latent preference direction from weighted attention.
 *
 * 1. Attention reward r_i per candidate (0..1) from how the user looked at the
 *    card (dwell, revisits, longest fixation, time before leaving). Jev
 *    produces it when available; `localReward` below is the transparent model.
 *
 * 2. Region-aware evidence. Each card region (photo, prompt, meta) carries an
 *    `emphasis` over traits. The share of attention a_j on region j, times its
 *    emphasis, times how much that kind of region can say about that kind of
 *    trait (kappa: prompts speak for personality, photos for appearance), gives
 *    the focus f_i[t] in 0..1 of candidate i on trait t:
 *
 *        a_j    = (dwell_j + 350ms * revisits_j) / sum_j (...)
 *        f_i[t] = sum_j a_j * emphasis_j[t] * kappa(kind_j, group(t))
 *
 * 3. Trait-wise attention-weighted mean (the spec's P = sum(r_i C_i) / sum(r_i),
 *    with the weight sharpened per trait by the focus):
 *
 *        w_i[t] = r_i * (1 + beta * f_i[t])          beta = 2
 *        P[t]   = sum_i w_i[t] C_i[t] / sum_i w_i[t]
 *
 *    With uniform focus this is exactly the spec formula. Staring at a
 *    sarcastic prompt raises the weight of that candidate's sarcasm only.
 *
 * 4. Deltas vs the population (the candidate pool), standardized so the viz
 *    reads "humor +0.82":  delta[t] = clamp((P[t] - mu[t]) / (2 sigma[t]), -1, 1).
 *
 * 5. Direction u = (P - mu) / ||P - mu|| ("then normalize"). Convergence is the
 *    stability of u plus how much evidence we have:
 *
 *        m_t      = 0.5 m_{t-1} + 0.5 ||u_t - u_{t-1}||       (m_1 = 1)
 *        coverage = 1 - exp(-n / 4)
 *        progress = coverage^0.6 * (1 - min(1, m_t))^0.4, never dropping more than 0.05 per step
 */

export type Interest = { skip: number; neutral: number; inspect: number; positive: number };
export const INTEREST_KEYS = ["skip", "neutral", "inspect", "positive"] as const;
/** Reward value of each interest class. */
export const INTEREST_VALUE: Interest = { skip: 0.02, neutral: 0.25, inspect: 0.6, positive: 1 };

export const BETA = 2;
export const REVISIT_MS = 350;

type Group = keyof typeof TRAIT_GROUPS;
export const KAPPA: Record<CandidateRegion["kind"], Record<Group, number>> = {
  "profile-photo": { appearance: 1.0, personality: 0.35, lifestyle: 0.7 },
  "profile-prompt": { appearance: 0.2, personality: 1.0, lifestyle: 0.6 },
  "profile-meta": { appearance: 0.2, personality: 0.4, lifestyle: 0.9 },
};

/** Reading a prompt takes longer than glancing at a photo: dwell saturates per kind. */
export const TAU_MS: Record<CandidateRegion["kind"], number> = {
  "profile-photo": 1200,
  "profile-prompt": 2500,
  "profile-meta": 1500,
};

const GROUP_OF = new Map<TraitKey, Group>();
for (const [g, keys] of Object.entries(TRAIT_GROUPS) as [Group, readonly TraitKey[]][]) for (const k of keys) GROUP_OF.set(k, g);
export const groupOf = (t: TraitKey): Group => GROUP_OF.get(t) ?? "personality";

export interface LeaveObservation {
  candidateId: string;
  regions: Record<string, RegionStats>;
  totalMs: number;
  skipLatencyMs: number;
}

/** Region stats keyed by region id, whether the shell sent "cand_<id>_<region>" keys or bare ids. */
export function normalizeRegions(candidateId: string, regions: Record<string, RegionStats>): Record<string, RegionStats> {
  const out: Record<string, RegionStats> = {};
  const prefix = `cand_${candidateId}_`;
  for (const [k, v] of Object.entries(regions ?? {})) {
    if (!v || typeof v.dwellMs !== "number") continue;
    const id = k.startsWith(prefix) ? k.slice(prefix.length) : k;
    const prev = out[id];
    out[id] = prev
      ? { dwellMs: prev.dwellMs + v.dwellMs, visits: prev.visits + v.visits, revisits: prev.revisits + v.revisits, longestMs: Math.max(prev.longestMs, v.longestMs) }
      : { ...v };
  }
  return out;
}

export interface AttentionFeatures {
  dwellMs: number;
  revisits: number;
  longestMs: number;
  skipLatencyMs: number;
  promptShare: number;
  photoShare: number;
  /** Per-region saturating engagement, mean over looked-at regions. */
  engagement: number;
}

export function features(c: Candidate | undefined, obs: LeaveObservation): AttentionFeatures {
  const regions = normalizeRegions(obs.candidateId, obs.regions);
  let dwell = 0;
  let revisits = 0;
  let longest = 0;
  let prompt = 0;
  let photo = 0;
  let engagementSum = 0;
  let looked = 0;
  for (const [id, s] of Object.entries(regions)) {
    const kind = c?.regions.find((r) => r.id === id)?.kind ?? (id.startsWith("prompt") ? "profile-prompt" : id.startsWith("photo") ? "profile-photo" : "profile-meta");
    dwell += s.dwellMs;
    revisits += s.revisits;
    longest = Math.max(longest, s.longestMs);
    if (kind === "profile-prompt") prompt += s.dwellMs;
    if (kind === "profile-photo") photo += s.dwellMs;
    if (s.dwellMs > 0) {
      engagementSum += 1 - Math.exp(-s.dwellMs / TAU_MS[kind]);
      looked++;
    }
  }
  return {
    dwellMs: dwell,
    revisits,
    longestMs: longest,
    skipLatencyMs: obs.skipLatencyMs,
    promptShare: dwell > 0 ? prompt / dwell : 0,
    photoShare: dwell > 0 ? photo / dwell : 0,
    engagement: looked ? engagementSum / looked : 0,
  };
}

const sat = (x: number, scale: number) => 1 - Math.exp(-Math.max(0, x) / scale);
const clamp = (x: number, lo = 0, hi = 1) => (x < lo ? lo : x > hi ? hi : x);

/** Scalar engagement z in 0..1, a fixed linear blend of saturating features. */
export function engagementScore(f: AttentionFeatures): number {
  const dwell = sat(f.dwellMs, 4000);
  const revisit = sat(f.revisits, 2);
  const fixation = sat(f.longestMs, 2000);
  const stayed = clamp((f.skipLatencyMs - 1500) / 5500);
  return clamp(0.3 * dwell + 0.2 * revisit + 0.2 * fixation + 0.15 * stayed + 0.15 * f.engagement);
}

const CENTERS: Interest = { skip: 0.08, neutral: 0.33, inspect: 0.58, positive: 0.82 };
const SIGMA = 0.12;

export interface RewardResult {
  interest: Interest;
  strength: number;
  reward: number;
  by: string;
}

/** Soft assignment of z to the four interest prototypes (Gaussian kernels), then reward = E[value]. */
export function interestFromScore(z: number): Interest {
  const raw = INTEREST_KEYS.map((k) => Math.exp(-((z - CENTERS[k]) ** 2) / (2 * SIGMA * SIGMA)));
  const sum = raw.reduce((a, b) => a + b, 0) || 1;
  const out = {} as Interest;
  INTEREST_KEYS.forEach((k, i) => (out[k] = Math.round((raw[i]! / sum) * 1000) / 1000));
  return out;
}

export function rewardFromInterest(i: Interest): number {
  return INTEREST_KEYS.reduce((s, k) => s + i[k] * INTEREST_VALUE[k], 0);
}

export function localReward(c: Candidate | undefined, obs: LeaveObservation): RewardResult {
  const f = features(c, obs);
  const z = engagementScore(f);
  const interest = interestFromScore(z);
  return {
    interest,
    // How far from indifference: a snap skip and a long stare are both strong signals.
    strength: Math.round(clamp(Math.abs(z - CENTERS.neutral) / (1 - CENTERS.neutral) + 0.15) * 1000) / 1000,
    reward: Math.round(rewardFromInterest(interest) * 1000) / 1000,
    by: "local",
  };
}

/** Focus f_i[t]: where on the card the attention went, as evidence per trait. */
export function focus(c: Candidate, obs: LeaveObservation): TraitVector {
  const regions = normalizeRegions(obs.candidateId, obs.regions);
  const weights: [CandidateRegion, number][] = [];
  let total = 0;
  for (const r of c.regions) {
    const s = regions[r.id];
    if (!s) continue;
    const w = Math.max(0, s.dwellMs) + REVISIT_MS * Math.max(0, s.revisits);
    if (w <= 0) continue;
    weights.push([r, w]);
    total += w;
  }
  const f: TraitVector = {};
  for (const t of TRAIT_KEYS) f[t] = 0;
  if (total <= 0) return f;
  for (const [r, w] of weights) {
    const a = w / total;
    for (const [t, e] of Object.entries(r.emphasis) as [TraitKey, number][]) f[t] = f[t]! + a * e * KAPPA[r.kind][groupOf(t)];
  }
  for (const t of TRAIT_KEYS) f[t] = clamp(f[t]!);
  return f;
}

export interface Observation {
  candidateId: string;
  traits: Record<TraitKey, number>;
  reward: number;
  focus: TraitVector;
}

export function estimate(obs: Observation[], beta = BETA): TraitVector {
  const P: TraitVector = {};
  for (const t of TRAIT_KEYS) {
    let num = 0;
    let den = 0;
    for (const o of obs) {
      const w = Math.max(1e-6, o.reward) * (1 + beta * (o.focus[t] ?? 0));
      num += w * (o.traits[t] ?? 0);
      den += w;
    }
    P[t] = den > 0 ? num / den : 0;
  }
  return P;
}

export interface Population {
  mean: TraitVector;
  sd: TraitVector;
}

export function population(cands: Pick<Candidate, "traits">[]): Population {
  const mean: TraitVector = {};
  const sd: TraitVector = {};
  for (const t of TRAIT_KEYS) {
    const xs = cands.map((c) => c.traits[t] ?? 0);
    const m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0.5;
    const v = xs.length ? xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length : 0.0625;
    mean[t] = m;
    sd[t] = Math.max(0.05, Math.sqrt(v));
  }
  return { mean, sd };
}

export function deltas(P: TraitVector, pop: Population): TraitVector {
  const d: TraitVector = {};
  for (const t of TRAIT_KEYS) d[t] = Math.round(clamp((P[t]! - pop.mean[t]!) / (2 * pop.sd[t]!), -1, 1) * 1000) / 1000;
  return d;
}

export function direction(P: TraitVector, pop: Population): number[] {
  const v = TRAIT_KEYS.map((t) => (P[t] ?? 0) - (pop.mean[t] ?? 0));
  const n = Math.hypot(...v);
  return n > 0 ? v.map((x) => x / n) : v.map(() => 0);
}

export interface ConvergenceState {
  prevDir: number[] | null;
  movement: number;
  progress: number;
  n: number;
}

export const initialConvergence = (): ConvergenceState => ({ prevDir: null, movement: 1, progress: 0, n: 0 });

export function stepConvergence(s: ConvergenceState, dir: number[]): ConvergenceState {
  const n = s.n + 1;
  const d = s.prevDir ? Math.hypot(...dir.map((x, i) => x - s.prevDir![i]!)) : 2;
  const movement = s.prevDir ? 0.5 * s.movement + 0.5 * d : 1;
  const coverage = 1 - Math.exp(-n / 4);
  const stability = 1 - Math.min(1, movement);
  const raw = Math.pow(coverage, 0.6) * Math.pow(stability, 0.4);
  const progress = clamp(Math.max(raw, s.progress - 0.05));
  return { prevDir: dir, movement, progress: Math.round(progress * 1000) / 1000, n };
}

/** Optional adaptation after birth: P(t+1) = alpha P(t) + (1 - alpha) x. */
export function adapt(P: TraitVector, x: TraitVector, alpha = 0.85): TraitVector {
  const out: TraitVector = {};
  for (const t of TRAIT_KEYS) out[t] = Math.round((alpha * (P[t] ?? 0) + (1 - alpha) * (x[t] ?? 0)) * 1000) / 1000;
  return out;
}

export function round3(v: TraitVector): TraitVector {
  const out: TraitVector = {};
  for (const [k, x] of Object.entries(v)) out[k] = Math.round(x * 1000) / 1000;
  return out;
}
