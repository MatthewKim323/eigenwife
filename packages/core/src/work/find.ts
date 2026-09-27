import { existsSync, statSync } from "fs";
import { basename, dirname, extname, join } from "path";
import type { Exec } from "../agency/types";
import { deniedPath } from "./safety";

/**
 * "find my resume" the way a person would look: Documents, Downloads,
 * Desktop and iCloud Drive first, then the rest of home. Code trees (~/dev,
 * test fixtures, node_modules, build output), caches and Library are not
 * where his resume lives, so they're dropped. Filename beats content,
 * documents beat code for document-ish asks, newer beats older, and a file
 * with his name in it beats one without. Same file twice counts once.
 */

export interface FileHit {
  path: string;
  name: string;
  modified: number;
  size: number;
}

export interface RankedFile extends FileHit {
  score: number;
  /** Spoken place: "downloads", "documents", "icloud", "desktop", "~/notes". */
  where: string;
  /** Matched by file name (vs only by content). */
  byName: boolean;
  why: string[];
}

export interface FindOpts {
  home: string;
  now: number;
  /** Search only here (an explicit dir): no scope weighting, nothing outside it. */
  dir?: string;
  /** Content search instead of name search ("the doc about the overlay"). */
  content?: boolean;
  /** Code roots to skip (~/dev ...) unless he named a repo. */
  codeRoots?: string[];
  /** He named a repo: search inside it too (its tests and build output stay out). */
  repoPath?: string | null;
  /** Words from his name ("matt", "kim"): a file named after him is probably his. */
  owner?: string[];
  limit?: number;
}

export const DOC_EXT = new Set([".pdf", ".docx", ".doc", ".pages", ".key", ".keynote", ".rtf", ".odt", ".pptx", ".ppt"]);
const NOTE_EXT = new Set([".md", ".txt", ".markdown"]);
const SHEET_EXT = new Set([".xlsx", ".xls", ".numbers", ".csv"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".heic", ".gif", ".webp", ".tiff"]);
const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rb", ".go", ".rs", ".java", ".c", ".h", ".cpp", ".swift", ".kt", ".json", ".yml", ".yaml", ".toml", ".lock", ".html", ".css", ".scss", ".sh", ".sql", ".snap", ".map", ".log", ".xml", ".plist"]);

/** Never where his stuff is, anywhere: dependency, cache and test-fixture dirs. */
const ALWAYS_NOISE = new Set(["node_modules", "fixtures", "__fixtures__", "testdata", "test-data", "__tests__", "__snapshots__", "__mocks__", "coverage", "bower_components", "Pods", "DerivedData", "venv", "site-packages", "Caches", "Cache", "CachedData", "tmp", "temp"]);
/** Only noise inside a git repo: a "test" folder in Documents can be his. */
const REPO_NOISE = new Set(["test", "tests", "spec", "specs", "e2e", "dist", "build", "out", "target", "vendor", "examples", "example", "samples", "sample", "docs-build", "public", "assets", "static"]);

const ICLOUD = "Library/Mobile Documents/com~apple~CloudDocs";

/** Default dev roots to skip for file asks (not ~/Documents: that's where his documents are). */
export function devRoots(home: string, extra: string[] = []): string[] {
  const base = ["dev", "code", "projects", "src", "Developer", "Documents/GitHub", "repos", "workspace", "go", "git"].map((d) => join(home, d));
  return [...new Set([...base, ...extra.filter((d) => d !== join(home, "Documents") && d !== home)])];
}

export function scopes(home: string): { dir: string; label: string; weight: number }[] {
  return [
    { dir: join(home, "Documents"), label: "documents", weight: 6 },
    { dir: join(home, "Downloads"), label: "downloads", weight: 5.5 },
    { dir: join(home, "Desktop"), label: "desktop", weight: 5 },
    { dir: join(home, ICLOUD), label: "icloud", weight: 5 },
  ];
}

const STOP = new Set(["my", "the", "a", "an", "of", "for", "file", "files", "doc", "docs", "document", "documents", "that", "this", "old", "new", "latest", "last", "from", "in", "on", "and", "with", "i", "me", "to"]);

export function tokens(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOP.has(t));
}

/** Asks where the answer is a document, not code or a photo. */
const DOCISH = /\b(?:resume|resumé|cv|cover|letter|essay|paper|thesis|transcript|syllabus|contract|lease|invoice|receipt|report|statement|notes?|deck|slides|presentation|pitch|proposal|application|offer|w2|w-2|1099|tax|taxes|form|agreement|memo|outline|draft|homework|assignment|pset|manual|guide|itinerary|ticket|boarding|passport|license|certificate|diploma|portfolio|plan|budget|doc|document|pdf)\b/i;
const IMAGEY = /\b(?:screenshot|screen shot|photo|picture|pic|image|selfie|meme|png|jpg)\b/i;

export function docish(query: string): boolean {
  if (IMAGEY.test(query)) return false;
  const ext = extname(query.trim()).toLowerCase();
  if (ext && CODE_EXT.has(ext)) return false;
  return DOCISH.test(query) || !ext;
}

function stem(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.[^.]+$/, "")
    .replace(/\s*\(\d+\)$/, "")
    .replace(/[\s_-]*(?:copy|final|v\d+)$/, "")
    .replace(/[\s_-]+/g, " ")
    .trim();
}

export interface Excluder {
  (path: string): string | null;
}

/** Why a path is not a candidate for "find my X", or null when it is one. */
export function excluder(o: Pick<FindOpts, "home" | "codeRoots" | "repoPath" | "dir">): Excluder {
  const home = o.home;
  const roots = (o.codeRoots ?? devRoots(home)).filter((r) => !(o.repoPath && (o.repoPath === r || o.repoPath.startsWith(r + "/"))));
  const repoCache = new Map<string, string | null>();
  const repoOf = (dir: string): string | null => {
    const stopAt = o.dir && dir.startsWith(o.dir) ? o.dir : home;
    const chain: string[] = [];
    let d = dir;
    let hit: string | null = null;
    while (d.length > 1 && d.startsWith(stopAt)) {
      if (repoCache.has(d)) {
        hit = repoCache.get(d)!;
        break;
      }
      chain.push(d);
      if (existsSync(join(d, ".git"))) {
        hit = d;
        break;
      }
      if (d === stopAt) break;
      d = dirname(d);
    }
    for (const c of chain) repoCache.set(c, hit);
    return hit;
  };
  return (p: string) => {
    const denied = deniedPath(p);
    if (denied) return "denied";
    const base = o.dir && p.startsWith(o.dir + "/") ? o.dir : home;
    if (!p.startsWith(base + "/")) return o.dir ? "outside the folder" : "outside home";
    const rel = p.slice(base.length + 1);
    if (base === home) {
      if (rel.startsWith("Library/") && !rel.startsWith(ICLOUD + "/")) return "Library";
      if (rel.startsWith(".Trash/")) return "trash";
      if (roots.some((r) => p.startsWith(r + "/"))) return "code tree";
    }
    const segs = rel.split("/").slice(0, -1);
    for (const s of segs) {
      if (s.startsWith(".")) return "hidden folder";
      if (ALWAYS_NOISE.has(s)) return `${s} folder`;
    }
    const repo = repoOf(dirname(p));
    if (repo) {
      const inRepo = p.slice(repo.length + 1).split("/").slice(0, -1);
      for (const s of inRepo) if (REPO_NOISE.has(s.toLowerCase())) return `repo ${s} folder`;
    }
    return null;
  };
}

/** "downloads", "documents", "icloud", "desktop", else a short ~/path. */
export function whereOf(path: string, home: string): string {
  for (const s of scopes(home)) if (path.startsWith(s.dir + "/")) {
    const sub = dirname(path).slice(s.dir.length + 1);
    return sub ? `${s.label}/${sub.split("/").slice(-1)[0]}` : s.label;
  }
  const d = dirname(path);
  return d.startsWith(home + "/") ? `~${d.slice(home.length)}` : d;
}

/** Score and order candidates. Pure given the stat results: tests feed it fixtures. */
export function rankFiles(query: string, hits: (FileHit & { byName: boolean })[], o: FindOpts): RankedFile[] {
  const q = tokens(query);
  const wantExt = extname(query.trim()).toLowerCase();
  const doc = docish(query);
  const owner = (o.owner ?? []).map((w) => w.toLowerCase()).filter((w) => w.length >= 3);
  const scoped = o.dir ? [] : scopes(o.home);
  const out: RankedFile[] = [];
  for (const h of hits) {
    const why: string[] = [];
    let score = 0;
    const scope = scoped.find((s) => h.path.startsWith(s.dir + "/"));
    if (scope) {
      score += scope.weight;
      why.push(scope.label);
    } else if (!o.dir) score += 1;
    const lower = h.name.toLowerCase();
    const nameToks = tokens(h.name);
    const hitToks = q.filter((t) => nameToks.some((n) => n === t || n.startsWith(t) || (t.length >= 4 && n.includes(t))));
    if (h.byName && q.length && hitToks.length === q.length) {
      score += 10;
      why.push("name");
    } else if (hitToks.length) {
      score += 4 * (hitToks.length / Math.max(1, q.length));
      why.push("part of the name");
    } else {
      score -= 2;
      why.push("content");
    }
    if (wantExt && lower === basename(query.trim()).toLowerCase()) score += 8;
    const ext = extname(lower);
    if (doc) {
      if (DOC_EXT.has(ext)) score += 5;
      else if (NOTE_EXT.has(ext)) score += 2;
      else if (SHEET_EXT.has(ext)) score += 1;
      else if (CODE_EXT.has(ext)) score -= 8;
      else if (IMAGE_EXT.has(ext)) score -= 2;
      else if (!ext) score -= 3;
    } else if (IMAGEY.test(query) && IMAGE_EXT.has(ext)) score += 4;
    const ageDays = Math.max(0, (o.now - h.modified) / 86_400_000);
    score += 4 * Math.pow(0.5, ageDays / 120);
    if (owner.some((w) => nameToks.includes(w) || lower.includes(w))) {
      score += 2;
      why.push("his name");
    }
    if (/(?:\(\d+\)|\bcopy\b|\bbackup\b|\bold\b)/i.test(h.name)) score -= 1;
    // A document inside some git repo (not a code root) is more often a fixture than his.
    if (!o.repoPath && inGitRepo(h.path, o.dir ?? o.home)) score -= 4;
    out.push({ ...h, score: Math.round(score * 100) / 100, where: whereOf(h.path, o.home), why });
  }
  out.sort((a, b) => b.score - a.score || b.modified - a.modified);
  // Same file in two places (a download and its copy in Documents): keep the better one.
  const seen = new Set<string>();
  return out.filter((f) => {
    const key = `${stem(f.name)}|${f.size}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function inGitRepo(path: string, stopAt: string): boolean {
  let d = dirname(path);
  while (d.length > 1 && d.startsWith(stopAt) && d !== stopAt) {
    if (existsSync(join(d, ".git"))) return true;
    d = dirname(d);
  }
  return false;
}

/**
 * Spotlight, then rank. One name query over home (plus one per word for
 * multi-word asks: "cover letter" matches cover_letter.pdf) and one content
 * query, excluded paths dropped before anything is stat'ed.
 */
export async function findFiles(exec: Exec, query: string, o: FindOpts): Promise<RankedFile[]> {
  const root = o.dir ?? o.home;
  const q = query.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  if (!q) return [];
  const nameOnly = /\.[a-z0-9]{1,5}$/i.test(q) && !/\s/.test(q);
  const toks = tokens(q);
  const nameRuns: string[][] = o.content ? [] : [["mdfind", "-onlyin", root, "-name", q]];
  if (!o.content && toks.length > 1) for (const t of toks.filter((t) => t.length >= 3).slice(0, 3)) nameRuns.push(["mdfind", "-onlyin", root, "-name", t]);
  const contentRuns: string[][] = o.content || !nameOnly ? [["mdfind", "-onlyin", root, q]] : [];
  const roots = o.repoPath ? [root, o.repoPath].filter((r, i, a) => a.indexOf(r) === i) : [root];
  const run = async (argv: string[]) => {
    const lists: string[] = [];
    for (const r of roots) {
      const a = [...argv];
      a[2] = r;
      const res = await exec(a, { timeoutMs: 10_000, maxBytes: 600_000 });
      if (res.code === 0) lists.push(...res.stdout.split("\n").map((l) => l.trim()).filter(Boolean));
    }
    return lists;
  };
  const skip = excluder(o);
  const byPath = new Map<string, FileHit & { byName: boolean }>();
  const add = (paths: string[], byName: boolean) => {
    for (const p of paths.slice(0, 1500)) {
      if (byPath.has(p)) {
        if (byName) byPath.get(p)!.byName = true;
        continue;
      }
      if (skip(p)) continue;
      try {
        const st = statSync(p);
        if (!st.isFile()) continue;
        byPath.set(p, { path: p, name: basename(p), modified: st.mtimeMs, size: st.size, byName });
      } catch {}
    }
  };
  for (const argv of nameRuns) add(await run(argv), true);
  for (const argv of contentRuns) add(await run(argv), false);
  // Word-only name matches ("letter" for "cover letter") only count when the whole name fits.
  const hits = [...byPath.values()].map((h) => (h.byName && toks.length > 1 && !toks.every((t) => h.name.toLowerCase().includes(t)) ? { ...h, byName: false } : h));
  return rankFiles(q, hits, o).slice(0, o.limit ?? 8);
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

export function monthOf(ms: number): string {
  return MONTHS[new Date(ms).getMonth()]!;
}

/**
 * Is the top pick clearly the one, or should she ask? Close scores between
 * two different-looking files mean ask: "the one from august or the older one
 * from march?"
 */
export function ambiguity(ranked: RankedFile[], now: number): { question: string } | null {
  const [a, b] = ranked;
  if (!a || !b) return null;
  // Both real name matches of the same kind of thing, close enough that recency alone
  // shouldn't decide (a resume from august vs one from march): ask.
  if (!a.byName || !b.byName || b.score < a.score - 3) return null;
  if (extname(a.name).toLowerCase() !== extname(b.name).toLowerCase() && !(DOC_EXT.has(extname(a.name).toLowerCase()) && DOC_EXT.has(extname(b.name).toLowerCase()))) return null;
  const newer = a.modified >= b.modified ? a : b;
  const older = newer === a ? b : a;
  const days = (newer.modified - older.modified) / 86_400_000;
  if (days > 20) {
    const nm = monthOf(newer.modified);
    const om = monthOf(older.modified);
    const year = (ms: number) => new Date(ms).getFullYear();
    const oldLabel = om === nm || year(older.modified) !== year(now) ? `${om} ${year(older.modified)}` : om;
    return { question: `the one from ${nm} or the older one from ${oldLabel}?` };
  }
  if (a.where !== b.where) return { question: `the one in ${a.where} or the one in ${b.where}?` };
  return { question: `${a.name} or ${b.name}?` };
}
