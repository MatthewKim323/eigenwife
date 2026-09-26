import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join } from "path";
import type { ActionDef, ActionEnv, Exec } from "../types";
import { deniedPath, expandHome, redactSecrets } from "../../work/safety";
import { safeUrl } from "./apps";

/**
 * Files: Spotlight search, read + summarize, open. Denylisted paths (~/.ssh,
 * keychains, .env files, password stores, mail, messages) are refused before
 * anything runs, and again after a search resolves a name to a path.
 */

export interface FileHit {
  path: string;
  name: string;
  modified: number;
  size: number;
}

const NOISE = /\/(?:Library|node_modules|\.git|\.cache|\.Trash|\.npm|\.bun|\.cargo|\.rustup|\.venv|venv|__pycache__|dist|build|DerivedData|\.next|\.turbo)\//;

export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 14) return `${d} days ago`;
  if (d < 60) return `${Math.round(d / 7)} weeks ago`;
  return `${Math.round(d / 30)} months ago`;
}

export function tildify(p: string, home = homedir()): string {
  return p.startsWith(home + "/") ? `~${p.slice(home.length)}` : p;
}

/** Spotlight: name matches first, then content matches, minus noise and denylisted paths, newest first within each group. */
export async function spotlight(exec: Exec, query: string, opts: { dir?: string; content?: boolean; limit?: number } = {}): Promise<FileHit[]> {
  const dir = opts.dir ?? homedir();
  const q = query.replace(/[\u0000-\u001f]/g, " ").trim().slice(0, 120);
  if (!q) return [];
  // "OVERLAY.md" is a file name, not a topic: content matches would only add noise.
  const nameOnly = /\.[a-z0-9]{1,5}$/i.test(q) && !/\s/.test(q);
  const runs = opts.content ? [["mdfind", "-onlyin", dir, q]] : nameOnly ? [["mdfind", "-onlyin", dir, "-name", q]] : [["mdfind", "-onlyin", dir, "-name", q], ["mdfind", "-onlyin", dir, q]];
  const groups: string[][] = [];
  for (const argv of runs) {
    const r = await exec(argv, { timeoutMs: 10_000, maxBytes: 400_000 });
    groups.push(r.code === 0 ? r.stdout.split("\n").map((l) => l.trim()).filter(Boolean) : []);
  }
  const seen = new Set<string>();
  const out: FileHit[] = [];
  const limit = opts.limit ?? 8;
  for (const g of groups) {
    const hits: FileHit[] = [];
    for (const p of g.slice(0, 400)) {
      if (seen.has(p) || NOISE.test(p) || /\/\.[^/]+\//.test(p.slice(homedir().length)) || deniedPath(p)) continue;
      seen.add(p);
      try {
        const st = statSync(p);
        hits.push({ path: p, name: basename(p), modified: st.mtimeMs, size: st.size });
      } catch {}
    }
    hits.sort((a, b) => b.modified - a.modified);
    out.push(...hits);
    if (out.length >= limit) break;
  }
  return out.slice(0, limit);
}

export const filesSearch: ActionDef = {
  kind: "files.search",
  permission: "READ",
  describe: (a) => `search your files for "${String(a.query ?? "")}"`,
  refuse: (a) => (a.dir ? deniedPath(String(a.dir)) : null),
  async run(args, env) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, observation: "search for what?" };
    const dir = args.dir ? expandHome(String(args.dir)) : homedir();
    env.progress?.(`spotlight: ${query}`);
    const hits = await spotlight(env.deps.exec, query, { dir, content: args.content === true, limit: Number(args.limit) || 8 });
    if (!hits.length) return { ok: true, observation: `no files matching "${query}"`, data: { hits } };
    const now = env.deps.now();
    const top = hits.slice(0, 3).map((h) => `${h.name} in ${tildify(dirname(h.path))}, ${ago(h.modified, now)}`);
    return { ok: true, observation: `found ${hits.length}${hits.length >= 8 ? "+" : ""}: ${top.join("; ")}`, data: { hits } };
  },
};

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

/** PDF text through PDFKit (JXA), path passed as argv, never spliced into source. */
export const PDF_TEXT_JXA = `ObjC.import('PDFKit');
function run(argv) {
  var doc = $.PDFDocument.alloc.initWithURL($.NSURL.fileURLWithPath(argv[0]));
  if (!doc || doc.isNil()) return '';
  var s = doc.string;
  return (s && !s.isNil()) ? ObjC.unwrap(s).slice(0, 200000) : '';
}`;

const TEXTUTIL_EXT = new Set([".docx", ".doc", ".rtf", ".rtfd", ".odt", ".html", ".htm", ".webarchive", ".wordml"]);
const MAX_BYTES = 40 * 1024 * 1024;

/** Resolve "resume", "~/notes/x.md", "README in eigenwife" to one path. */
export async function resolveFile(env: ActionEnv, target: string): Promise<{ path: string } | { error: string }> {
  const t = target.trim().replace(/^["'`]|["'`]$/g, "");
  if (!t) return { error: "which file?" };
  const candidates: string[] = [];
  const ctxRepo = env.ctx.tryUse("work")?.context()?.repoPath;
  if (t.startsWith("~") || isAbsolute(t)) candidates.push(expandHome(t));
  else {
    // "README in eigenwife" / "package.json"
    const m = /^(.+?)\s+(?:in|from)\s+(?:the\s+)?([\w.-]+)(?:\s+(?:repo|project|folder))?$/i.exec(t);
    const repo = m ? env.ctx.tryUse("work")?.resolveRepo(m[2]!) : null;
    const name = m ? m[1]! : t;
    if (repo) candidates.push(join(repo.path, name));
    if (ctxRepo) candidates.push(join(ctxRepo, name));
  }
  for (const c of candidates) {
    for (const p of [c, `${c}.md`]) {
      if (existsSync(p) && statSync(p).isFile()) {
        const why = deniedPath(p);
        return why ? { error: why } : { path: p };
      }
    }
    // README -> README.md regardless of case
    const dir = dirname(c);
    if (existsSync(dir)) {
      try {
        const want = basename(c).toLowerCase();
        const hit = readdirSync(dir).find((f) => f.toLowerCase() === want || f.toLowerCase().replace(/\.[^.]+$/, "") === want);
        if (hit) {
          const p = join(dir, hit);
          const why = deniedPath(p);
          if (why) return { error: why };
          if (statSync(p).isFile()) return { path: p };
        }
      } catch {}
    }
  }
  if (t.startsWith("~") || isAbsolute(t)) {
    const why = deniedPath(expandHome(t));
    return { error: why ?? `${tildify(expandHome(t))} doesn't exist` };
  }
  const hits = await spotlight(env.deps.exec, t.replace(/\s+(?:file|doc)$/i, ""), { limit: 1 });
  if (!hits.length) return { error: `couldn't find a file called ${t}` };
  return { path: hits[0]!.path };
}

export async function extractText(exec: Exec, osa: ActionEnv["deps"]["osa"], path: string): Promise<{ text: string } | { error: string }> {
  const st = statSync(path);
  if (st.isDirectory()) return { error: `${basename(path)} is a folder` };
  if (st.size > MAX_BYTES) return { error: `${basename(path)} is ${Math.round(st.size / 1e6)}MB, too big to read` };
  const ext = extname(path).toLowerCase();
  if (ext === ".pdf") {
    const r = await osa(PDF_TEXT_JXA, { lang: "JavaScript", args: [path], timeoutMs: 20_000 });
    return r.ok && r.stdout.trim() ? { text: r.stdout } : { error: `couldn't pull text out of ${basename(path)}` };
  }
  if (TEXTUTIL_EXT.has(ext)) {
    const r = await exec(["textutil", "-convert", "txt", "-stdout", path], { timeoutMs: 15_000, maxBytes: 400_000 });
    return r.code === 0 ? { text: r.stdout } : { error: `couldn't convert ${basename(path)}` };
  }
  const buf = readFileSync(path).subarray(0, 400_000);
  if (buf.subarray(0, 8000).includes(0)) return { error: `${basename(path)} is a binary file` };
  return { text: buf.toString("utf8") };
}

export const filesRead: ActionDef = {
  kind: "files.read",
  permission: "READ",
  describe: (a) => `read ${String(a.path ?? a.target ?? "a file")}`,
  refuse: (a) => {
    const p = String(a.path ?? a.target ?? "");
    return p.startsWith("~") || isAbsolute(p) || /(?:^|\/)\.env/.test(p) ? deniedPath(p) : null;
  },
  async run(args, env) {
    const found = await resolveFile(env, String(args.path ?? args.target ?? ""));
    if ("error" in found) return { ok: false, observation: found.error };
    const path = found.path;
    env.progress?.(`reading ${basename(path)}`);
    const got = await extractText(env.deps.exec, env.deps.osa, path);
    if ("error" in got) return { ok: false, observation: got.error };
    const text = redactSecrets(got.text).replace(/\r/g, "").trim();
    if (!text) return { ok: true, observation: `${basename(path)} is empty`, data: { path, chars: 0 } };
    const brains = env.ctx.tryUse("brains");
    let summary = "";
    if (brains && args.summarize !== false) {
      const j = await brains
        .quickJson<{ summary?: string }>(
          'You summarize a file for a spoken reply. JSON {"summary": "..."}: 1-3 short plain sentences, what it is and what matters in it. Never repeat anything that looks like a password, key or token.',
          `File: ${basename(path)}\n\n${text.slice(0, 7000)}`,
          { timeoutMs: 8000 },
        )
        .catch(() => null);
      summary = typeof j?.summary === "string" ? j.summary.trim() : "";
    }
    if (!summary) summary = text.split(/\n\s*\n/).find((p) => p.trim().length > 20)?.replace(/\s+/g, " ").slice(0, 240) ?? text.slice(0, 240);
    return { ok: true, observation: `${basename(path)}: ${redactSecrets(summary)}`, data: { path, chars: text.length, excerpt: text.slice(0, 2000) } };
  },
};

// ---------------------------------------------------------------------------
// open
// ---------------------------------------------------------------------------

/** Opening these runs code (a .command opens a Terminal and executes it). */
const EXECUTABLE_EXT = /\.(?:command|sh|bash|zsh|tool|terminal|workflow|scpt|scptd|applescript|pkg|mpkg|dmg|jar|exe|action|osax|app|prefpane|mobileconfig|kext)$/i;

function findApp(name: string): string | null {
  const clean = name.replace(/\.app$/i, "").trim();
  if (!clean || /[/]/.test(clean)) return null;
  for (const dir of ["/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities", join(homedir(), "Applications")]) {
    try {
      const hit = readdirSync(dir).find((f) => f.toLowerCase() === `${clean.toLowerCase()}.app`);
      if (hit) return hit.replace(/\.app$/i, "");
    } catch {}
  }
  return null;
}

export const filesOpen: ActionDef = {
  kind: "files.open",
  permission: "SAFE_ACTION",
  describe: (a) => `open ${String(a.target ?? a.path ?? "it")}`,
  targets: (a) => [String(a.target ?? a.path ?? "")],
  refuse: (a) => {
    const t = String(a.target ?? a.path ?? "").trim();
    if (EXECUTABLE_EXT.test(t) && !findApp(t)) return `refused: opening ${basename(t)} would run it`;
    if (t.startsWith("~") || isAbsolute(t)) return deniedPath(t);
    return null;
  },
  async run(args, env) {
    const target = String(args.target ?? args.path ?? "").trim();
    if (!target) return { ok: false, observation: "open what?" };
    const url = safeUrl(target) ?? (/^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/.test(target) && !existsSync(expandHome(target)) ? safeUrl(`https://${target}`) : null);
    if (url) {
      const ok = await env.deps.openUrl(url);
      return { ok, observation: ok ? `opened ${url}` : `couldn't open ${url}` };
    }
    const app = findApp(target);
    if (app) {
      const r = await env.deps.exec(["open", "-a", app], { timeoutMs: 10_000 });
      return { ok: r.code === 0, observation: r.code === 0 ? `opened ${app}` : `couldn't open ${app}` };
    }
    const found = await resolveFile(env, target);
    if ("error" in found) return { ok: false, observation: found.error };
    if (EXECUTABLE_EXT.test(found.path)) return { ok: false, observation: `refused: opening ${basename(found.path)} would run it` };
    const r = await env.deps.exec(["open", found.path], { timeoutMs: 10_000 });
    return { ok: r.code === 0, observation: r.code === 0 ? `opened ${basename(found.path)}` : `couldn't open ${basename(found.path)}`, data: { path: found.path } };
  },
};
