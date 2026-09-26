import type { Candidate } from "@eigenwife/protocol";
import { features, INTEREST_KEYS, normalizeRegions, rewardFromInterest, type Interest, type LeaveObservation, type RewardResult } from "./math";

/**
 * Jev (TypeSafe systemone) as the Act I attention judge. One call, two typed
 * questions: a `choice` over skip|neutral|inspect|positive and a `score` on a
 * four-step signal-strength rubric. 400 ms budget; anything slower or malformed
 * falls back to the local model, and the signal says which one answered (`by`).
 */

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function jevState(c: Candidate | undefined, obs: LeaveObservation) {
  const f = features(c, obs);
  const regions = normalizeRegions(obs.candidateId, obs.regions);
  return {
    task: "A person is browsing a dating profile. Judge their interest only from how their eyes moved over it.",
    profile: c ? { name: c.name, tagline: c.tagline } : { id: obs.candidateId },
    totalMs: obs.totalMs,
    msBeforeLeaving: obs.skipLatencyMs,
    dwellMs: Math.round(f.dwellMs),
    revisits: f.revisits,
    longestFixationMs: Math.round(f.longestMs),
    promptReadingShare: Math.round(f.promptShare * 100) / 100,
    photoShare: Math.round(f.photoShare * 100) / 100,
    regions: Object.entries(regions).map(([id, s]) => {
      const r = c?.regions.find((x) => x.id === id);
      const text = r?.kind === "profile-prompt" ? c?.prompts.find((p) => p.id === id)?.answer : r?.kind === "profile-photo" ? c?.photos.find((p) => p.id === id)?.caption : undefined;
      return { id, kind: r?.kind ?? "unknown", dwellMs: s.dwellMs, revisits: s.revisits, longestMs: s.longestMs, ...(text ? { text } : {}) };
    }),
  };
}

export const JEV_QUESTIONS = {
  interest: {
    type: "choice",
    instructions: "How interested is the viewer in this profile, judging only by their attention?",
    criteria: {
      skip: "Left quickly, barely looked",
      neutral: "Looked briefly without lingering",
      inspect: "Read or looked carefully, some revisits",
      positive: "Lingered, revisited, read the prompts closely",
    },
  },
  signal: {
    type: "score",
    instructions: "How strong and unambiguous is this attention signal?",
    criteria: ["No signal", "Weak", "Clear", "Strong"],
  },
} as const;

export function parseJevAnswer(body: unknown): { interest: Interest; strength: number } {
  const a = (body as { answers?: Record<string, any> })?.answers;
  const probs = a?.interest?.probabilities;
  if (!probs || typeof probs !== "object") throw new Error("jev: no interest probabilities");
  const interest = {} as Interest;
  let sum = 0;
  for (const k of INTEREST_KEYS) {
    const p = Number(probs[k] ?? 0);
    interest[k] = Number.isFinite(p) && p > 0 ? p : 0;
    sum += interest[k];
  }
  if (sum <= 0) throw new Error("jev: empty distribution");
  for (const k of INTEREST_KEYS) interest[k] = Math.round((interest[k] / sum) * 1000) / 1000;
  const score = Number(a?.signal?.score);
  const strength = Number.isFinite(score) ? Math.max(0, Math.min(1, score / 3)) : Math.max(...INTEREST_KEYS.map((k) => interest[k]));
  return { interest, strength: Math.round(strength * 1000) / 1000 };
}

export async function jevReward(
  c: Candidate | undefined,
  obs: LeaveObservation,
  opts: { apiKey: string; fetch?: FetchLike; timeoutMs?: number; model?: string; url?: string },
): Promise<RewardResult> {
  const f = opts.fetch ?? ((i: string, init?: RequestInit) => fetch(i, init));
  const res = await f(opts.url ?? JEV_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: opts.model ?? "jev-latest", state: jevState(c, obs), questions: JEV_QUESTIONS }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 400),
  });
  if (!res.ok) throw new Error(`jev ${res.status}`);
  const body = (await res.json()) as { model?: string };
  const { interest, strength } = parseJevAnswer(body);
  return { interest, strength, reward: Math.round(rewardFromInterest(interest) * 1000) / 1000, by: `jev${body.model ? `:${body.model}` : ""}` };
}
