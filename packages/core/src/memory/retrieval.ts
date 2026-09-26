import type { MemoryHit, MemoryRecord } from "@eigenwife/protocol";
import { cosine, type Vec } from "./embed";

/**
 * Retrieval math, kept pure so it is testable with fake embeddings.
 *
 *   score   = 1.2 * cosine + 0.2 * recency + 0.3 * importance
 *   recency = max(0, 1 - ageDays / 30)
 *
 * A record is a hit when cosine >= minCos (a relevance gate: recency and
 * importance alone can reach 0.5, and a memory that is merely recent and
 * important but off-topic should not surface) and score > keep. Thresholds
 * are per embedding space because cosine scales differ between spaces.
 */

export const WEIGHTS = { cosine: 1.2, recency: 0.2, importance: 0.3 } as const;
export const RECENCY_DAYS = 30;

export type Space = "local" | "openai" | "moss";

export interface SpaceThresholds {
  keep: number;
  minCos: number;
  /** Cosine above which a new memory is a near duplicate of an old one. */
  dedupe: number;
}

export const THRESHOLDS: Record<Space, SpaceThresholds> = {
  // Tuned on the demo seed + queries: related pairs land at cos 0.2-0.75,
  // unrelated ones at 0-0.12.
  local: { keep: 0.5, minCos: 0.15, dedupe: 0.86 },
  // text-embedding-3-small: related short sentences ~0.3-0.6, unrelated ~0.05-0.2.
  openai: { keep: 0.55, minCos: 0.22, dedupe: 0.92 },
  // Moss minilm with alpha 1.0 returns raw cosine.
  moss: { keep: 0.55, minCos: 0.25, dedupe: 0.92 },
};

export interface RecordVecs {
  local: Vec;
  openai?: Vec;
}

export function recency(createdAt: number, now: number): number {
  const ageDays = Math.max(0, now - createdAt) / 86_400_000;
  return Math.max(0, 1 - ageDays / RECENCY_DAYS);
}

export function scoreMemory(cos: number, rec: Pick<MemoryRecord, "createdAt" | "importance">, now: number): number {
  return WEIGHTS.cosine * cos + WEIGHTS.recency * recency(rec.createdAt, now) + WEIGHTS.importance * rec.importance;
}

export interface SearchOptions {
  k?: number;
  kinds?: MemoryRecord["kind"][];
  now?: number;
  /** Moss cosine per record id, merged with the local space (max wins). */
  moss?: Map<string, number>;
}

export interface SearchResult {
  hits: MemoryHit[];
  space: Space;
}

/** Which vector space to compare in, given what the query and the records carry. */
export function chooseSpace(query: RecordVecs, vecs: Iterable<RecordVecs>): "local" | "openai" {
  if (!query.openai) return "local";
  let n = 0;
  let withOpenai = 0;
  for (const v of vecs) {
    n++;
    if (v.openai) withOpenai++;
  }
  return n > 0 && withOpenai / n >= 0.8 ? "openai" : "local";
}

export function search(
  records: MemoryRecord[],
  vecs: Map<string, RecordVecs>,
  query: RecordVecs,
  opts: SearchOptions = {},
): SearchResult {
  const now = opts.now ?? Date.now();
  const k = opts.k ?? 5;
  const pool = opts.kinds?.length ? records.filter((r) => opts.kinds!.includes(r.kind)) : records;
  const base = chooseSpace(query, pool.map((r) => vecs.get(r.id)).filter((v): v is RecordVecs => !!v));
  const scored: (MemoryHit & { space: Space })[] = [];
  for (const r of pool) {
    const v = vecs.get(r.id);
    let space: Space = base;
    let cos = 0;
    if (v) cos = base === "openai" && v.openai ? cosine(query.openai, v.openai) : cosine(query.local, v.local);
    if (base === "openai" && v && !v.openai) space = "local";
    const m = opts.moss?.get(r.id);
    if (m !== undefined && m >= cos) {
      cos = m;
      space = "moss";
    }
    const t = THRESHOLDS[space];
    if (cos < t.minCos) continue;
    const score = scoreMemory(cos, r, now);
    if (score <= t.keep) continue;
    scored.push({ record: r, score: Math.round(score * 1000) / 1000, space });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, k);
  // "moss" whenever Moss contributed a hit, so the recall flash credits the backend that served it.
  const space: Space = top.some((h) => h.space === "moss") ? "moss" : (top[0]?.space ?? base);
  return { hits: top.map(({ record, score }) => ({ record, score })), space };
}

/** Closest existing record to a new one, in the best shared space. */
export function nearest(
  records: MemoryRecord[],
  vecs: Map<string, RecordVecs>,
  v: RecordVecs,
): { record: MemoryRecord; cos: number; space: "local" | "openai" } | null {
  let best: { record: MemoryRecord; cos: number; space: "local" | "openai" } | null = null;
  for (const r of records) {
    const rv = vecs.get(r.id);
    if (!rv) continue;
    const both = !!(v.openai && rv.openai);
    const cos = both ? cosine(v.openai, rv.openai) : cosine(v.local, rv.local);
    const space = both ? "openai" : "local";
    if (!best || cos > best.cos) best = { record: r, cos, space };
  }
  return best;
}

export function isDuplicate(n: { cos: number; space: "local" | "openai" } | null): boolean {
  return !!n && n.cos > THRESHOLDS[n.space].dedupe;
}

/** Noisy-or: hearing the same thing twice makes it more certain, never less. */
export function reinforce(existing: number, incoming: number, weight = 0.5): number {
  return Math.min(1, 1 - (1 - existing) * (1 - incoming * weight));
}
