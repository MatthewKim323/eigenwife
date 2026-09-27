import type { BrainService, UserProfile } from "../services";
import { filterHits, type GbrainClient, type GbrainHit } from "./gbrain";
import { looksSensitive } from "./policy";

/**
 * "Who matt is", from gbrain. A handful of targeted hybrid queries (slow,
 * so background only, generous timeouts), summarized by a brain into
 * user-profile fields plus ~20 compact facts. Cached in ~/.eve/gbrain.json,
 * refreshed at most daily. Onboarding answers always win over these fields
 * (see onboarding/profile.ts mergeProfile).
 */

export type DigestProfile = Partial<Pick<UserProfile, "name" | "callMe" | "pronouns" | "birthday" | "work" | "interests" | "people" | "vibe">>;

export interface DigestFact {
  content: string;
  importance: number;
}

export interface Digest {
  at: number;
  ms: number;
  by: "brain" | "frontier" | "slugs" | "none";
  queries: number;
  hits: number;
  profile: DigestProfile;
  facts: DigestFact[];
  error?: string;
}

export const DIGEST_MAX_AGE_MS = 24 * 3600_000;

/** What she asks gbrain about him. {who} is his name ("matt" until onboarding says otherwise). */
export const DIGEST_QUERIES = [
  "{who}'s closest friends and the important people in his life",
  "what {who} is building: projects, startups, side projects",
  "{who}'s school, major, work and career",
  "{who}'s interests, hobbies, music and taste",
  "recent events and what's been going on in {who}'s life",
  "how {who} talks and what kind of humor he likes",
];

export const DIGEST_SYSTEM = `You build a compact profile of one person (the owner of this personal knowledge base) for his desktop companion, who talks to him out loud.
From the notes, return JSON only:
{"profile":{"name":"full name or null","callMe":"what friends call him, lowercase, or null","birthday":"MM-DD or YYYY-MM-DD, only if stated, else null","work":"what he does / is building, one phrase, max 16 words","interests":["short", "..."],"people":[{"name":"First Last","relation":"girlfriend|close friend|sister|roommate|..."}],"vibe":["how he talks / what lands, max 12 words each"]},
 "facts":[{"content":"compact third-person fact, max 14 words","importance":0.0-1.0}]}
Rules: up to 18 facts, the most useful for a friend who wants to know him (projects, people, taste, recent events). Up to 10 people, the ones who matter most.
Never include health, sexual, legal, financial account, address, phone, password, or other private identifiers. Nothing about other people's secrets.
Only what the notes support. No em dashes. Keep it short.`;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);

/** Validate a model's digest answer. */
export function parseDigest(raw: unknown): { profile: DigestProfile; facts: DigestFact[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const p = (o.profile && typeof o.profile === "object" ? o.profile : {}) as Record<string, unknown>;
  const s = (v: unknown, n = 120) => (typeof v === "string" && v.trim() && !/^(?:null|unknown|n\/a)$/i.test(v.trim()) ? clip(v.trim().replace(/\s*[\u2013\u2014]\s*/g, ", "), n) : undefined);
  const list = (v: unknown, n = 60) => (Array.isArray(v) ? v.map((x) => s(x, n)).filter((x): x is string => !!x && !looksSensitive(x)) : []);
  const profile: DigestProfile = {};
  for (const k of ["name", "callMe", "pronouns", "work"] as const) {
    const v = s(p[k], k === "work" ? 160 : 60);
    if (v) profile[k] = k === "callMe" ? v.toLowerCase() : v;
  }
  const b = s(p.birthday, 12);
  if (b && /^(?:\d{4}-)?\d{2}-\d{2}$/.test(b)) profile.birthday = b;
  const interests = list(p.interests).slice(0, 10);
  if (interests.length) profile.interests = interests;
  const vibe = list(p.vibe, 120).slice(0, 5);
  if (vibe.length) profile.vibe = vibe;
  if (Array.isArray(p.people)) {
    const people = p.people
      .map((x) => (x && typeof x === "object" ? { name: s((x as Record<string, unknown>).name, 50), relation: s((x as Record<string, unknown>).relation, 40) ?? "" } : null))
      .filter((x): x is { name: string; relation: string } => !!x?.name)
      .slice(0, 10);
    if (people.length) profile.people = people;
  }
  const facts: DigestFact[] = [];
  for (const f of Array.isArray(o.facts) ? o.facts : []) {
    const content = typeof f === "string" ? s(f, 160) : f && typeof f === "object" ? s((f as Record<string, unknown>).content, 160) : undefined;
    if (!content || looksSensitive(content) || PRIVATE.test(content)) continue;
    const imp = f && typeof f === "object" ? Number((f as Record<string, unknown>).importance) : NaN;
    facts.push({ content, importance: Math.max(0.4, Math.min(0.8, Number.isFinite(imp) ? imp : 0.6)) });
    if (facts.length >= 24) break;
  }
  if (!Object.keys(profile).length && !facts.length) return null;
  return { profile, facts };
}

/** Topics that never become memories from gbrain (the notes are his, the digest still stays tame). */
export const PRIVATE = /\b(?:diagnos\w*|therap\w*|medication|std|pregnan\w*|sex(?:ual)?|nude|address|phone number|social security|bank account|arrest\w*|lawsuit)\b/i;

/**
 * No brain? Still learn something: people pages ("people/eyan-koko -- Eyan is
 * a close friend of matt's ...") become people with a relation guessed from
 * the first sentence, and their first sentences become facts.
 */
export function digestFromSlugs(hits: GbrainHit[]): { profile: DigestProfile; facts: DigestFact[] } {
  const people: { name: string; relation: string }[] = [];
  const facts: DigestFact[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.slug)) continue;
    seen.add(h.slug);
    const first = h.text.split(/(?<=[.!?])\s/)[0] ?? "";
    if (h.slug.startsWith("people/")) {
      const name = h.slug
        .slice(7)
        .split("-")
        .map((w) => (w ? w[0]!.toUpperCase() + w.slice(1) : w))
        .join(" ");
      const rel =
        /\b(girlfriend|boyfriend|sister|brother|mom|mother|dad|father|cousin|roommate|best friend|close friend|friend|coworker|cofounder|co-founder|classmate|mentor)\b/i.exec(first)?.[1]?.toLowerCase() ?? "";
      if (people.length < 10) people.push({ name, relation: rel });
    }
    if (first && facts.length < 20 && !looksSensitive(first) && !PRIVATE.test(first)) facts.push({ content: clip(first.replace(/^[^A-Za-z]+/, ""), 160), importance: 0.5 });
  }
  return { profile: people.length ? { people } : {}, facts };
}

export interface DigestDeps {
  client: GbrainClient;
  brains: BrainService | null;
  who: string;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  queryTimeoutMs?: number;
  brainTimeoutMs?: number;
}

/** Run the queries (sequentially, gentle on the brain's DB) and summarize. */
export async function buildDigest(d: DigestDeps): Promise<Digest> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const all: GbrainHit[] = [];
  let answered = 0;
  for (const q of DIGEST_QUERIES) {
    const hits = await d.client.query(q.replaceAll("{who}", d.who), { timeoutMs: d.queryTimeoutMs ?? 25_000, limit: 8 });
    if (!hits) continue;
    answered += 1;
    all.push(...filterHits(hits, { relative: 0.6, perPrefix: 4 }).slice(0, 6));
  }
  const base = { at: now(), queries: answered, hits: all.length };
  if (!all.length) return { ...base, ms: now() - t0, by: "none", profile: {}, facts: [], error: answered ? "no hits" : "gbrain unreachable" };
  const notes = [...new Map(all.map((h) => [h.slug, h])).values()].map((h) => `- (${h.slug}) ${clip(h.text, 320)}`).join("\n");
  const user = `the person: ${d.who}\n\nnotes from his knowledge base:\n${clip(notes, 14_000)}`;
  if (d.brains) {
    try {
      const raw = await d.brains.quickJson(DIGEST_SYSTEM, user, { timeoutMs: d.brainTimeoutMs ?? 25_000 });
      const parsed = parseDigest(raw);
      if (parsed) return { ...base, ms: now() - t0, by: "brain", ...parsed };
      d.log?.("digest: quickJson gave nothing usable, trying frontier");
      const fr = await d.brains.frontier({ goal: `${DIGEST_SYSTEM}\n\n${user}`, json: true, tools: "none", timeoutMs: 120_000 });
      const parsed2 = parseDigest(fr.json);
      if (parsed2) return { ...base, ms: now() - t0, by: "frontier", ...parsed2 };
    } catch (err) {
      d.log?.("digest brain failed:", err);
    }
  }
  return { ...base, ms: now() - t0, by: "slugs", ...digestFromSlugs(all) };
}
