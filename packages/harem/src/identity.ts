import { CANDIDATES, type Candidate, type TraitKey } from "@eigenwife/protocol";
import type { WifeRole } from "./types";

/**
 * Who shows up for the job. Every wife is one of the twelve Eigen profiles
 * from Act I (the girls he swiped past). Assignment is deterministic per
 * task + role, leans on trait fit, and never repeats a girl inside one task.
 */

/** How much each trait matters for a role. Negative = it counts against her. */
export const ROLE_FIT: Record<WifeRole, Partial<Record<TraitKey, number>>> = {
  // Scheduling wants someone who owns a calendar and doesn't improvise.
  calendar: { career_focus: 1, nerdiness: 0.6, polished: 0.5, ambition: 0.4, chaos: -0.8, spontaneity: -0.5 },
  // Money wants warmth that still says no: steady, low chaos, not out every night.
  budget: { warmth: 0.9, chaos: -1, spontaneity: -0.6, polished: 0.3, nightlife: -0.4, travel: -0.3 },
  // Places to eat: whoever knows where the night goes.
  food: { nightlife: 0.8, spontaneity: 0.5, travel: 0.4, humor: 0.3, chaos: 0.3, style: 0.2 },
  // Places to get to: outdoorsy, well traveled, reads a map.
  logistics: { outdoors: 1, travel: 0.8, fitness: 0.4, sporty: 0.3, chaos: -0.3 },
  research: { nerdiness: 1, career_focus: 0.4, warmth: 0.2, chaos: -0.2 },
};

/** How much a per-task coin flip can move a score. Small: the best fit usually wins. */
export const JITTER = 0.1;

export interface WifeIdentity {
  candidateId: string;
  name: string;
  candidate: Candidate;
}

const byId = new Map(CANDIDATES.map((c) => [c.id, c]));

export function candidateById(id: string | undefined): Candidate | undefined {
  return id ? byId.get(id) : undefined;
}

/** Trait fit for a role, normalized to roughly -1..1. */
export function roleFit(c: Candidate, role: WifeRole): number {
  const w = ROLE_FIT[role] ?? {};
  let sum = 0;
  let norm = 0;
  for (const [k, v] of Object.entries(w) as [TraitKey, number][]) {
    sum += v * (c.traits[k] ?? 0);
    norm += Math.abs(v);
  }
  return norm ? sum / norm : 0;
}

/** 0..1, stable for a (task, role, candidate) triple. FNV-1a + a murmur finalizer. */
export function unit(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

export function score(c: Candidate, role: WifeRole, taskId: string): number {
  return roleFit(c, role) + unit(`${taskId}|${role}|${c.id}`) * JITTER;
}

/** One girl for one role, skipping anyone already on this task. */
export function pickCandidate(taskId: string, role: WifeRole, taken: Iterable<string> = []): WifeIdentity {
  const skip = new Set(taken);
  let best: Candidate | undefined;
  let bestScore = -Infinity;
  for (const c of CANDIDATES) {
    if (skip.has(c.id)) continue;
    const s = score(c, role, taskId);
    if (s > bestScore) {
      best = c;
      bestScore = s;
    }
  }
  // More wives than girls can't happen (MAX_WIVES is 4), but never crash on it.
  best ??= CANDIDATES[Math.floor(unit(`${taskId}|${role}`) * CANDIDATES.length)]!;
  return { candidateId: best.id, name: best.name, candidate: best };
}

/**
 * The whole cast at once. Greedy over every (role, girl) pair, best score
 * first, so two roles that want the same girl settle it by fit instead of by
 * plan order. Returns one identity per role, in the order given.
 */
export function assignCandidates(taskId: string, roles: WifeRole[]): WifeIdentity[] {
  const pairs: { i: number; c: Candidate; s: number }[] = [];
  roles.forEach((role, i) => {
    for (const c of CANDIDATES) pairs.push({ i, c, s: score(c, role, taskId) });
  });
  pairs.sort((a, b) => b.s - a.s || a.i - b.i || a.c.id.localeCompare(b.c.id));
  const out: (WifeIdentity | undefined)[] = roles.map(() => undefined);
  const used = new Set<string>();
  for (const p of pairs) {
    if (out[p.i] || used.has(p.c.id)) continue;
    out[p.i] = { candidateId: p.c.id, name: p.c.name, candidate: p.c };
    used.add(p.c.id);
  }
  return roles.map((role, i) => out[i] ?? pickCandidate(taskId, role, used));
}

/** Personality flavor for her system prompt. Voice only: never lets it bend the numbers. */
export function personaBlock(c: Candidate): string {
  const lines = c.prompts.map((p) => `- "${p.question}": ${p.answer}`).join("\n");
  return `
You are ${c.name}, ${c.age}, ${c.job.toLowerCase()} from ${c.location}. Tagline: "${c.tagline}".
In your own words:
${lines}
Let this color how you phrase short text (reasons, notes, warnings). It never changes numbers, facts, or your lane.`;
}

// ---------------------------------------------------------------------------
// Conflict quips, in her voice. The generic line is the fallback.
// ---------------------------------------------------------------------------

type Quips = {
  /** Food side, over budget: defends the pricey pick. */
  push?: (top: string) => string;
  /** Budget side: says no. */
  no?: (cost: string, noun: string) => string;
  /** Food side, too far: it's close, trust me. */
  near?: (top: string) => string;
  /** Logistics side: it is not close. */
  far?: (mins: number) => string;
};

export const QUIPS: Record<string, Quips> = {
  mira: {
    push: (t) => `${t}. I read every review. It's worth it.`,
    no: (d, n) => `${d} for ${n} is a bug. Absolutely not.`,
    near: (t) => `${t} is right there. Statistically.`,
    far: (m) => `${m} minutes. I measured. Not "right there".`,
  },
  sol: {
    push: (t) => `${t}. We'll walk it off. It's worth it.`,
    no: (d, n) => `${d} for ${n}? That's a headlamp. Absolutely not.`,
    near: (t) => `${t} is right there, I'd jog it.`,
    far: (m) => `${m} minutes is a hike, babe. Not "right there".`,
  },
  vivienne: {
    push: (t) => `${t}. Quality is an investment. It's worth it.`,
    no: (d, n) => `${d} for ${n}. Terrible ROI. Absolutely not.`,
    near: (t) => `${t} is right there. I've timed it.`,
    far: (m) => `${m} minutes is a calendar block. Not "right there".`,
  },
  kit: {
    push: (t) => `${t}. Life's short. It's worth it.`,
    no: (d, n) => `${d} for ${n}? Even I say no. Absolutely not.`,
    near: (t) => `${t} is right there, just vibe over.`,
    far: (m) => `${m} minutes? The party ends by then. Not "right there".`,
  },
  hana: {
    push: (t) => `${t}? It's worth it, I promise.`,
    no: (d, n) => `It's ${d} for ${n}, sweetie. Absolutely not.`,
    near: (t) => `${t} is right there, I'll hold your hand.`,
    far: (m) => `${m} minutes is too far on a school night.`,
  },
  zadie: {
    push: (t) => `${t}. My therapist says treat yourself. It's worth it.`,
    no: (d, n) => `${d} for ${n}? That's the joke. Absolutely not.`,
    near: (t) => `${t} is right there. Trust the bit.`,
    far: (m) => `${m} minutes is not "right there", it's a tour.`,
  },
  ines: {
    push: (t) => `${t}. Best bowl this side of Lisbon. It's worth it.`,
    no: (d, n) => `${d} for ${n} is a train ticket. Absolutely not.`,
    near: (t) => `${t} is right there, I've gone farther for bread.`,
    far: (m) => `${m} minutes is not "right there". I would know.`,
  },
  wren: {
    push: (t) => `${t}. Optimal route to happiness. It's worth it.`,
    no: (d, n) => `${d} for ${n}? Speedrunning debt. Absolutely not.`,
    near: (t) => `${t} is right there. I have routes.`,
    far: (m) => `${m} minutes is not "right there". Check the frame data.`,
  },
  dahlia: {
    push: (t) => `${t}. Cheap ramen is a phase. It's worth it.`,
    no: (d, n) => `${d} for ${n}. Absolutely not. Not even ironically.`,
    near: (t) => `${t} is right there, don't be dramatic.`,
    far: (m) => `${m} minutes is not "right there". It's a pilgrimage.`,
  },
  priya: {
    push: (t) => `${t}. Clinically, you need broth. It's worth it.`,
    no: (d, n) => `${d} for ${n}. My diagnosis: absolutely not.`,
    near: (t) => `${t} is right there. I'd make it on foot.`,
    far: (m) => `${m} minutes is not "right there". Triage says no.`,
  },
  yuki: {
    push: (t) => `${t}. The bowl is architecture. It's worth it.`,
    no: (d, n) => `${d} for ${n} is a thrift coat. Absolutely not.`,
    near: (t) => `${t} is right there, wear good shoes.`,
    far: (m) => `${m} minutes is not "right there". Not in these boots.`,
  },
  ada: {
    push: (t) => `${t}. Once in a lifetime, like a comet. It's worth it.`,
    no: (d, n) => `${d} for ${n}. Astronomically not.`,
    near: (t) => `${t} is right there, cosmically speaking.`,
    far: (m) => `${m} minutes is not "right there". Light is faster.`,
  },
};

export function quip<K extends keyof Quips>(candidateId: string | undefined, kind: K, fallback: string, ...args: Parameters<NonNullable<Quips[K]>>): string {
  const f = candidateId ? (QUIPS[candidateId]?.[kind] as ((...a: unknown[]) => string) | undefined) : undefined;
  return f ? f(...args) : fallback;
}
