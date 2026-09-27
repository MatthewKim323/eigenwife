import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, dirname, extname, isAbsolute, join } from "path";
import type { ActionDef, ActionEnv, Exec } from "../types";
import { deniedPath, expandHome, redactSecrets } from "../../work/safety";
import { findFiles, type RankedFile } from "../../work/find";
import { safeUrl } from "./apps";

/**
 * Files: Spotlight search, read + summarize, open. Denylisted paths (~/.ssh,
 * keychains, .env files, password stores, mail, messages) are refused before
 * anything runs, and again after a search resolves a name to a path.
 */

export type { FileHit } from "../../work/find";

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

/** matt's name words ("matt", "kim"), so a file named after him ranks higher. */
export function ownerWords(env: Pick<ActionEnv, "ctx">): string[] {
  const p = env.ctx.tryUse("user")?.profile();
  return [p?.name, p?.callMe]
    .filter((x): x is string => typeof x === "string")
    .flatMap((x) => x.toLowerCase().split(/[^a-z]+/))
    .filter((w) => w.length >= 3);
}

/** Spotlight, ranked like a person looks (work/find.ts): Documents, Downloads, Desktop, iCloud, then home; code trees out. */
export async function spotlight(
  exec: Exec,
  query: string,
  opts: { dir?: string; content?: boolean; limit?: number; owner?: string[]; repoPath?: string | null; now?: number; home?: string } = {},
): Promise<RankedFile[]> {
  const home = opts.home ?? homedir();
  return findFiles(exec, query, {
    home,
    now: opts.now ?? Date.now(),
    dir: opts.dir && opts.dir !== home ? opts.dir : undefined,
    content: opts.content,
    limit: opts.limit ?? 8,
    owner: opts.owner,
    repoPath: opts.repoPath ?? null,
  });
}

export const filesSearch: ActionDef = {
  kind: "files.search",
  permission: "READ",
  describe: (a) => `search your files for "${String(a.query ?? "")}"`,
  refuse: (a) => (a.dir ? deniedPath(String(a.dir)) : null),
  async run(args, env) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, observation: "search for what?" };
    const home = env.deps.env("EVE_FILES_HOME") || homedir();
    const dir = args.dir ? expandHome(String(args.dir)) : home;
    env.progress?.(`spotlight: ${query}`);
    const repoPath = typeof args.repo === "string" && args.repo ? expandHome(args.repo) : null;
    const hits = await spotlight(env.deps.exec, query, { dir, home, content: args.content === true, limit: Number(args.limit) || 8, owner: ownerWords(env), repoPath, now: env.deps.now() });
    if (!hits.length) return { ok: true, observation: `no files matching "${query}"`, data: { hits } };
    const now = env.deps.now();
    const top = hits.slice(0, 3).map((h) => `${h.name} in ${h.where}, ${ago(h.modified, now)}`);
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
  const hits = await spotlight(env.deps.exec, t.replace(/\s+(?:file|doc)$/i, ""), { limit: 1, owner: ownerWords(env), now: env.deps.now(), home: env.deps.env("EVE_FILES_HOME") || undefined });
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
  cursorApp: (a) => findApp(String(a.target ?? a.path ?? "").trim()) ?? "Finder",
  refuse: (a) => {
    const t = String(a.target ?? a.path ?? "").trim();
    if (EXECUTABLE_EXT.test(t) && !findApp(t)) return `refused: opening ${basename(t)} would run it`;
    if (t.startsWith("~") || isAbsolute(t)) return deniedPath(t);
    return null;
  },
  async run(args, env) {
    const target = String(args.target ?? args.path ?? "").trim();
    if (!target) return { ok: false, observation: "open what?" };
    // "resume.pdf" is a file, not a website.
    const looksLikeFile = /\.(?:pdf|docx?|pages|key|md|txt|rtf|pptx?|xlsx?|numbers|csv|png|jpe?g|heic)$/i.test(target);
    const url = safeUrl(target) ?? (/^[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/.test(target) && !looksLikeFile && !existsSync(expandHome(target)) ? safeUrl(`https://${target}`) : null);
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
    // "show it in finder": select it in a Finder window, never run it.
    if (args.reveal === true) {
      const r = await env.deps.exec(["open", "-R", found.path], { timeoutMs: 10_000 });
      return { ok: r.code === 0, observation: r.code === 0 ? `showed ${basename(found.path)} in finder` : `couldn't show ${basename(found.path)} in finder`, data: { path: found.path } };
    }
    if (EXECUTABLE_EXT.test(found.path)) return { ok: false, observation: `refused: opening ${basename(found.path)} would run it` };
    const r = await env.deps.exec(["open", found.path], { timeoutMs: 10_000 });
    return { ok: r.code === 0, observation: r.code === 0 ? `opened ${basename(found.path)}` : `couldn't open ${basename(found.path)}`, data: { path: found.path } };
  },
};
