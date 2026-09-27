import type { ProfileSource, UserProfile } from "../services";

/**
 * matt's profile (~/.eve/user.json). Pure helpers: normalize whatever is on
 * disk, merge patches with source precedence, and keep lists short.
 *
 * Precedence for scalar fields: onboarding > conversation/api > gbrain. A
 * gbrain digest never overwrites what he told her himself. Lists union, his
 * own answers first, deduped case-insensitively and capped.
 */

export type ProfilePatch = Partial<Omit<UserProfile, "sources" | "updatedAt">>;

const RANK: Record<ProfileSource, number> = { gbrain: 0, conversation: 1, api: 1, onboarding: 2 };
const SCALARS = ["name", "callMe", "herName", "pronouns", "birthday", "work"] as const;
const LIMITS = { interests: 12, people: 16, boundaries: 12, vibe: 6 } as const;

export function emptyProfile(): UserProfile {
  return { interests: [], people: [], boundaries: [], vibe: [], updatedAt: 0, sources: {} };
}

const str = (v: unknown, max = 160): string | undefined => {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s*[–—]\s*/g, ", ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : undefined;
};

const strList = (v: unknown, max = 80): string[] => (Array.isArray(v) ? v.map((x) => str(x, max)).filter((x): x is string => !!x) : []);

function people(v: unknown): { name: string; relation: string }[] {
  if (!Array.isArray(v)) return [];
  const out: { name: string; relation: string }[] = [];
  for (const p of v) {
    if (typeof p === "string") {
      const name = str(p, 60);
      if (name) out.push({ name, relation: "" });
    } else if (p && typeof p === "object") {
      const o = p as Record<string, unknown>;
      const name = str(o.name, 60);
      if (name) out.push({ name, relation: str(o.relation, 60) ?? "" });
    }
  }
  return out;
}

/** Anything from disk or a model answer -> a valid profile. */
export function normalizeProfile(raw: unknown): UserProfile {
  const p = emptyProfile();
  if (!raw || typeof raw !== "object") return p;
  const o = raw as Record<string, unknown>;
  for (const k of SCALARS) {
    const v = str(o[k], k === "work" ? 200 : 60);
    if (v) p[k] = v;
  }
  p.interests = uniq(strList(o.interests)).slice(0, LIMITS.interests);
  p.people = uniqBy(people(o.people), (x) => x.name).slice(0, LIMITS.people);
  p.boundaries = uniq(strList(o.boundaries, 140)).slice(0, LIMITS.boundaries);
  p.vibe = uniq(strList(o.vibe, 140)).slice(0, LIMITS.vibe);
  p.updatedAt = typeof o.updatedAt === "number" ? o.updatedAt : 0;
  if (o.sources && typeof o.sources === "object") {
    for (const [k, v] of Object.entries(o.sources as Record<string, unknown>)) if (typeof v === "string" && v in RANK) (p.sources as Record<string, string>)[k] = v;
  }
  return p;
}

function uniq(xs: string[]): string[] {
  return uniqBy(xs, (x) => x);
}
function uniqBy<T>(xs: T[], key: (x: T) => string): T[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = key(x).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Merge a patch into a profile. Returns a new profile; the input is untouched. */
export function mergeProfile(cur: UserProfile, patch: ProfilePatch, source: ProfileSource, now = Date.now()): UserProfile {
  const next: UserProfile = structuredClone(cur);
  const clean = normalizeProfile({ ...patch, sources: {} });
  const wins = (field: keyof UserProfile["sources"]) => {
    const had = cur.sources[field];
    return !had || RANK[source] >= RANK[had];
  };
  let changed = false;
  for (const k of SCALARS) {
    const v = clean[k];
    if (!v || !(k in patch)) continue;
    if (!wins(k) || next[k] === v) continue;
    next[k] = v;
    next.sources[k] = source;
    changed = true;
  }
  const lists = ["interests", "boundaries", "vibe"] as const;
  for (const k of lists) {
    if (!(k in patch)) continue;
    const add = clean[k];
    // His own answers go first; a lower-ranked source only appends.
    const merged = wins(k) ? uniq([...add, ...next[k]]) : uniq([...next[k], ...add]);
    const capped = merged.slice(0, LIMITS[k]);
    if (JSON.stringify(capped) !== JSON.stringify(next[k])) {
      next[k] = capped;
      if (wins(k)) next.sources[k] = source;
      changed = true;
    }
  }
  if ("people" in patch) {
    const incoming = clean.people;
    const merged = wins("people") ? uniqBy([...incoming, ...next.people], (x) => x.name) : uniqBy([...next.people, ...incoming], (x) => x.name);
    // Fill a missing relation from the other side.
    for (const p of merged) {
      if (!p.relation) p.relation = [...incoming, ...next.people].find((x) => x.name.toLowerCase() === p.name.toLowerCase() && x.relation)?.relation ?? "";
    }
    const capped = merged.slice(0, LIMITS.people);
    if (JSON.stringify(capped) !== JSON.stringify(next.people)) {
      next.people = capped;
      if (wins("people")) next.sources.people = source;
      changed = true;
    }
  }
  if (changed) next.updatedAt = now;
  return next;
}

/** "03-14" / "2003-03-14" -> "march 14". */
export function prettyBirthday(b: string): string {
  const m = /^(?:(\d{4})-)?(\d{2})-(\d{2})$/.exec(b);
  if (!m) return b;
  const month = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"][Number(m[2]) - 1];
  return month ? `${month} ${Number(m[3])}` : b;
}
