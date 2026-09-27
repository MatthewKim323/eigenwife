import type { MemoryRecord } from "@eigenwife/protocol";
import type { GbrainClient } from "./gbrain";
import { PRIVATE } from "./gbrain-digest";
import { looksSensitive } from "./policy";

/**
 * "matt's world": a broad preload from gbrain so that recalling any of it is
 * local vector search (sub-ms), and any name he says is an exact index hit.
 *
 *   people    `list --type person` -> get each: title, aliases, relationship, first paragraph
 *   projects  `list --type project` -> title + first paragraph
 *   events    `list --type event` + the last ~10 `days/*` catch-ups (bullets)
 *   learned   the last week of jabby's `learned/*` pages (durable facts about matt)
 *   about     `list --type profile` (about-matt, resume, hackathon wins)
 *
 * Each page becomes one record with provenance (slug, title, page date).
 * Cached in ~/.eve/gbrain-world.json (local only: never in memories.jsonl,
 * never mirrored to Zo or Moss), rebuilt at most daily in the background.
 */

export type WorldKind = "person" | "project" | "event" | "day" | "learned" | "about";

export interface WorldEntry {
  slug: string;
  title: string;
  kind: WorldKind;
  content: string;
  aliases: string[];
  /** Page date (frontmatter date / updated), epoch ms. */
  at: number;
}

export interface WorldCache {
  at: number;
  ms: number;
  pages: number;
  entries: WorldEntry[];
}

export const WORLD_MAX_AGE_MS = 24 * 3600_000;

export interface Listed {
  slug: string;
  type: string;
  updated: string;
  title: string;
}

/** `gbrain list` rows: slug \t type \t YYYY-MM-DD \t title. */
export function parseList(stdout: string): Listed[] {
  const out: Listed[] = [];
  for (const line of stdout.split("\n")) {
    const [slug, type, updated, ...rest] = line.split("\t");
    if (!slug || !type || !updated || !/^\d{4}-\d{2}-\d{2}/.test(updated)) continue;
    out.push({ slug: slug.trim(), type: type.trim(), updated: updated.trim(), title: rest.join("\t").trim() });
  }
  return out;
}

export interface ParsedPage {
  meta: Record<string, string | string[]>;
  title: string;
  body: string;
}

/** Tiny YAML-ish frontmatter reader: scalars and `- item` lists, which is all gbrain writes that we need. */
export function parsePage(raw: string): ParsedPage {
  const meta: Record<string, string | string[]> = {};
  let body = raw;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  if (fm) {
    body = raw.slice(fm[0].length);
    let key: string | null = null;
    for (const line of fm[1]!.split("\n")) {
      const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
      if (kv) {
        key = kv[1]!;
        const v = kv[2]!.trim().replace(/^['"]|['"]$/g, "");
        meta[key] = v ? v : [];
        continue;
      }
      const item = /^\s+-\s+(.*)$/.exec(line);
      if (item && key && Array.isArray(meta[key])) (meta[key] as string[]).push(item[1]!.trim().replace(/^['"]|['"]$/g, ""));
    }
  }
  const h1 = /^#\s+(.+)$/m.exec(body);
  const title = (typeof meta.title === "string" && meta.title) || h1?.[1]?.trim() || "";
  return { meta, title, body };
}

/** The first real paragraph (the page's "compiled truth"), clipped to a couple of sentences. */
export function lead(body: string, maxChars = 260): string {
  const paras = body
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p && !/^#/.test(p) && !/^[-*_]{3,}$/.test(p) && !/^_.*_$/.test(p));
  const first = (paras[0] ?? "").replace(/\s+/g, " ");
  const sentences = first.split(/(?<=[.!?])\s+/);
  let out = "";
  for (const s of sentences) {
    if ((out + " " + s).trim().length > maxChars) break;
    out = `${out} ${s}`.trim();
    if (out.length > maxChars * 0.6) break;
  }
  return (out || first.slice(0, maxChars)).replace(/\s*[–—]\s*/g, ", ");
}

/** Bullets from a daily catch-up ("- [00:10-00:12] Nathan getting some apparel"), with who they're about. */
export function dayBullets(body: string, max = 5): string[] {
  const out: string[] = [];
  let who = "";
  for (const line of body.split("\n")) {
    const person = /^\*\*(.+?)\*\*/.exec(line.trim());
    if (person) who = person[1]!;
    const b = /^-\s+(?:\[[^\]]*\]\s*)?(.+)$/.exec(line.trim());
    if (b && !/^_/.test(b[1]!) && b[1]!.length > 12) out.push(who && !b[1]!.includes(who.split(" ")[0]!) ? `${who}: ${b[1]}` : b[1]!);
    if (out.length >= max) break;
  }
  return out;
}

/** "- [00:01] (decision) Matt wants ..." -> facts. */
export function learnedFacts(body: string): string[] {
  const out: string[] = [];
  for (const line of body.split("\n")) {
    const m = /^-\s+\[\d{2}:\d{2}\]\s+\(([a-z-]+)\)\s+(.+)$/.exec(line.trim());
    if (m && m[1] !== "eigenwife") out.push(m[2]!.trim());
  }
  return out;
}

const safe = (s: string) => !!s && !looksSensitive(s) && !PRIVATE.test(s);
const asList = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
const dateOf = (s: string | undefined) => {
  const t = s ? Date.parse(s.slice(0, 10)) : NaN;
  return Number.isFinite(t) ? t : 0;
};

/** One page -> entries. Pure (tested). */
export function entriesFor(kind: WorldKind, row: Listed, raw: string): WorldEntry[] {
  const p = parsePage(raw);
  const title = (p.title || row.title).replace(/\s*[–—]\s*/g, ", ");
  const at = dateOf(typeof p.meta.date === "string" ? p.meta.date : undefined) || dateOf(row.updated);
  if (kind === "day") {
    const bullets = dayBullets(p.body).filter(safe);
    if (!bullets.length) return [];
    const date = row.slug.slice(-10);
    return [{ slug: row.slug, title, kind, content: `On ${date}: ${bullets.join("; ")}`.slice(0, 320), aliases: [], at }];
  }
  if (kind === "learned") {
    return learnedFacts(p.body)
      .filter(safe)
      .slice(0, 12)
      .map((f, i) => ({ slug: `${row.slug}#${i}`, title: `learned ${row.slug.slice(-10)}`, kind, content: f.slice(0, 240), aliases: [], at }));
  }
  const text = lead(p.body);
  if (!safe(text)) return [];
  if (kind === "person") {
    const rel = typeof p.meta.relationship === "string" ? p.meta.relationship : "";
    const aliases = [title, ...asList(p.meta.aliases)]
      .map((a) => a.replace(/\(.*?\)/g, "").trim())
      .filter((a) => a.length >= 3);
    const first = title.replace(/\(.*?\)/g, "").trim().split(/\s+/)[0];
    if (first && first.length >= 3) aliases.push(first);
    return [{ slug: row.slug, title, kind, content: `${title}${rel ? ` (${rel})` : ""}: ${text}`, aliases: [...new Set(aliases.map((a) => a.toLowerCase()))], at }];
  }
  const aliases = kind === "project" ? [title.replace(/^project:\s*/i, "").toLowerCase(), row.slug.split("/").pop()!.replace(/-/g, " ")] : [];
  return [{ slug: row.slug, title, kind, content: `${title}: ${text}`, aliases: aliases.filter((a) => a.length >= 3), at }];
}

export interface WorldDeps {
  client: GbrainClient;
  now?: () => number;
  log?: (...a: unknown[]) => void;
  /** Parallel `get`s. */
  concurrency?: number;
  limits?: Partial<Record<"person" | "project" | "event" | "day" | "learned" | "profile", number>>;
}

async function list(client: GbrainClient, args: string[]): Promise<Listed[]> {
  const r = await client.run(["list", ...args], { timeoutMs: 20_000 });
  return r.ok ? parseList(r.stdout) : [];
}

/** Pull matt's world from gbrain. Background only: ~130 short CLI calls. */
export async function buildWorld(d: WorldDeps): Promise<WorldCache> {
  const now = d.now ?? Date.now;
  const t0 = now();
  const L = { person: 100, project: 30, event: 10, day: 10, learned: 7, profile: 5, ...d.limits };
  const [people, projects, events, concepts, days, profiles] = await Promise.all([
    list(d.client, ["--type", "person", "--limit", String(L.person)]),
    list(d.client, ["--type", "project", "--limit", String(L.project)]),
    list(d.client, ["--type", "event", "--limit", String(L.event)]),
    list(d.client, ["--type", "concept", "--limit", "60"]),
    list(d.client, ["--type", "day", "--limit", String(L.day)]),
    list(d.client, ["--type", "profile", "--limit", String(L.profile)]),
  ]);
  const learned = concepts.filter((c) => /^learned\/\d{4}-\d{2}-\d{2}$/.test(c.slug)).slice(0, L.learned);
  const jobs: [WorldKind, Listed][] = [
    ...profiles.map((r) => ["about", r] as [WorldKind, Listed]),
    ...people.map((r) => ["person", r] as [WorldKind, Listed]),
    ...projects.map((r) => ["project", r] as [WorldKind, Listed]),
    ...events.map((r) => ["event", r] as [WorldKind, Listed]),
    ...days.map((r) => ["day", r] as [WorldKind, Listed]),
    ...learned.map((r) => ["learned", r] as [WorldKind, Listed]),
  ];
  const entries: WorldEntry[] = [];
  let i = 0;
  let pages = 0;
  const worker = async () => {
    while (i < jobs.length) {
      const [kind, row] = jobs[i++]!;
      const raw = await d.client.get(row.slug, 10_000);
      if (!raw) continue;
      pages += 1;
      try {
        entries.push(...entriesFor(kind, row, raw));
      } catch (err) {
        d.log?.(`world: ${row.slug} unparseable`, err);
      }
    }
  };
  await Promise.all(Array.from({ length: d.concurrency ?? 4 }, worker));
  return { at: now(), ms: now() - t0, pages, entries };
}

const IMPORTANCE: Record<WorldKind, number> = { about: 0.7, person: 0.6, project: 0.6, event: 0.55, day: 0.45, learned: 0.5 };

/** Entries -> memory records with provenance. Stable ids so a refresh replaces, not duplicates. */
export function worldRecords(w: WorldCache): MemoryRecord[] {
  return w.entries.map((e) => ({
    id: `gw_${e.slug.replace(/[^\w#-]+/g, "_")}`,
    kind: "fact" as const,
    content: e.content,
    importance: IMPORTANCE[e.kind],
    confidence: 0.8,
    source: "gbrain",
    createdAt: e.at || w.at,
    tags: ["gbrain", "world", e.kind],
    provenance: { system: "gbrain", slug: e.slug.replace(/#\d+$/, ""), title: e.title, at: e.at || undefined },
  }));
}

const INDEX_STOP = new Set(["the", "and", "you", "her", "his", "one", "man", "bro", "kim", "lee", "project", "summer project"]);

/** alias (lowercase) -> record ids. Exact name hits beat vector search. */
export class EntityIndex {
  private map = new Map<string, Set<string>>();
  private maxWords = 1;

  add(alias: string, id: string) {
    const a = alias.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").replace(/\s+/g, " ").trim();
    if (a.length < 3 || INDEX_STOP.has(a)) return;
    let s = this.map.get(a);
    if (!s) this.map.set(a, (s = new Set()));
    s.add(id);
    this.maxWords = Math.max(this.maxWords, Math.min(4, a.split(" ").length));
  }

  removeIds(ids: Set<string>) {
    for (const [k, s] of this.map) {
      for (const id of ids) s.delete(id);
      if (!s.size) this.map.delete(k);
    }
  }

  has(alias: string): boolean {
    return this.map.has(alias.toLowerCase().trim());
  }

  size(): number {
    return this.map.size;
  }

  /** Record ids named in the text (longest alias first), with the alias that matched. */
  match(text: string): { alias: string; ids: string[] }[] {
    const words = text.toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean).map((w) => w.replace(/'s$/, ""));
    const out: { alias: string; ids: string[] }[] = [];
    const used = new Set<number>();
    for (let n = this.maxWords; n >= 1; n--) {
      for (let i = 0; i + n <= words.length; i++) {
        if ([...Array(n).keys()].some((k) => used.has(i + k))) continue;
        const a = words.slice(i, i + n).join(" ");
        const s = this.map.get(a);
        if (!s) continue;
        out.push({ alias: a, ids: [...s] });
        for (let k = 0; k < n; k++) used.add(i + k);
      }
    }
    return out;
  }
}
