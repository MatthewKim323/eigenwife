import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import type { Exec } from "../agency/types";
import { deniedPath, expandHome } from "./safety";

/** Where matt keeps code. EVE_CODE_ROOTS=~/dev,~/work overrides. */
export function codeRoots(env: (n: string) => string = () => "", home = homedir()): string[] {
  const raw = env("EVE_CODE_ROOTS");
  const list = raw ? raw.split(",") : ["~/dev", "~/code", "~/projects", "~/src", "~/Developer", "~/Documents/GitHub", "~/Documents"];
  return list.map((p) => expandHome(p.trim(), home)).filter(Boolean);
}

export interface KnownRepo {
  name: string;
  path: string;
}

/** Git repos one level under each code root. Cheap (readdir + existsSync), cached by the caller. */
export function listRepos(roots: string[]): KnownRepo[] {
  const out: KnownRepo[] = [];
  const seen = new Set<string>();
  for (const root of roots) {
    let names: string[] = [];
    try {
      names = readdirSync(root);
    } catch {
      continue;
    }
    for (const name of names) {
      if (name.startsWith(".")) continue;
      const path = join(root, name);
      if (seen.has(name.toLowerCase())) continue;
      try {
        if (!statSync(path).isDirectory() || !existsSync(join(path, ".git"))) continue;
      } catch {
        continue;
      }
      if (deniedPath(path)) continue;
      seen.add(name.toLowerCase());
      out.push({ name, path });
    }
  }
  return out;
}

const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Find a repo named in an utterance. "fix the login bug in eigen wife" finds
 * eigenwife; "ship it in jabby" finds jabby. Longest name wins so "eigenwife"
 * beats a repo called "eigen".
 */
export function repoFromText(text: string, repos: KnownRepo[]): KnownRepo | null {
  const t = ` ${text.toLowerCase().replace(/[^a-z0-9./~_-]+/g, " ")} `;
  const tSquash = squash(text);
  const sorted = [...repos].sort((a, b) => b.name.length - a.name.length);
  for (const r of sorted) {
    const n = r.name.toLowerCase();
    if (n.length < 3) continue;
    const spaced = n.replace(/[-_.]+/g, " ");
    if (t.includes(` ${n} `) || t.includes(` ${spaced} `)) return r;
    // Speech-to-text splits and joins words freely: "eigen wife", "eigen-wife".
    if (squash(n).length >= 5 && tSquash.includes(squash(n))) return r;
  }
  // An explicit path: "in ~/dev/foo".
  const m = /(?:^|\s)(~\/[\w./-]+|\/Users\/[\w./-]+)/.exec(text);
  if (m) {
    const p = expandHome(m[1]!.replace(/[.,!?]+$/, ""));
    if (existsSync(join(p, ".git")) && !deniedPath(p)) return { name: basename(p), path: p };
  }
  return null;
}

export interface GitInfo {
  root: string;
  name: string;
  branch: string;
  dirty: number;
  lastCommit?: string;
  hasRemote: boolean;
}

/** git facts for a directory, or null when it isn't inside a repo. */
export async function gitInfo(exec: Exec, dir: string): Promise<GitInfo | null> {
  if (deniedPath(dir)) return null;
  const top = await exec(["git", "-C", dir, "rev-parse", "--show-toplevel"], { timeoutMs: 4000 });
  if (top.code !== 0) return null;
  const root = top.stdout.trim();
  const [branch, status, last, remote] = await Promise.all([
    exec(["git", "-C", root, "rev-parse", "--abbrev-ref", "HEAD"], { timeoutMs: 4000 }),
    exec(["git", "-C", root, "status", "--porcelain=v1", "--untracked-files=normal"], { timeoutMs: 6000 }),
    exec(["git", "-C", root, "log", "-1", "--format=%h %s (%cr)"], { timeoutMs: 4000 }),
    exec(["git", "-C", root, "remote"], { timeoutMs: 4000 }),
  ]);
  return {
    root,
    name: basename(root),
    branch: branch.code === 0 ? branch.stdout.trim() : "?",
    dirty: status.code === 0 ? status.stdout.split("\n").filter((l) => l.trim()).length : 0,
    lastCommit: last.code === 0 && last.stdout.trim() ? last.stdout.trim() : undefined,
    hasRemote: remote.code === 0 && remote.stdout.trim().length > 0,
  };
}

/** Which test command a repo uses, or null when none is detectable. */
export function detectTestCommand(root: string): string[] | null {
  const has = (f: string) => existsSync(join(root, f));
  if (has("package.json")) {
    try {
      const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
      const script = pkg.scripts?.test;
      const bun = has("bun.lock") || has("bun.lockb");
      if (script && !/no test specified/.test(script)) {
        if (bun) return ["bun", "run", "test"];
        if (has("pnpm-lock.yaml")) return ["pnpm", "test"];
        if (has("yarn.lock")) return ["yarn", "test"];
        return ["npm", "test", "--silent"];
      }
      if (bun) return ["bun", "test"];
    } catch {}
  }
  if (has("pyproject.toml") || has("pytest.ini") || has("setup.cfg")) return has("uv.lock") ? ["uv", "run", "pytest", "-q"] : ["python3", "-m", "pytest", "-q"];
  if (has("Cargo.toml")) return ["cargo", "test", "--quiet"];
  if (has("go.mod")) return ["go", "test", "./..."];
  return null;
}

/** One-line test verdict from a runner's output: "12 pass, 0 fail" or the last line. */
export function testVerdict(code: number, out: string): { ok: boolean; line: string } {
  const text = out.replace(/\x1b\[[0-9;]*m/g, "");
  const bun = /(\d+)\s+pass[\s\S]*?(\d+)\s+fail/.exec(text);
  if (bun) return { ok: code === 0 && bun[2] === "0", line: `${bun[1]} pass, ${bun[2]} fail` };
  const py = /=+\s*(.*?(?:passed|failed|error).*?)\s*=+\s*$/m.exec(text) ?? /^(\d+ (?:passed|failed).*)$/m.exec(text);
  if (py) return { ok: code === 0, line: py[1]!.trim() };
  const jest = /Tests:\s+(.*)$/m.exec(text);
  if (jest) return { ok: code === 0, line: jest[1]!.trim() };
  const last = text.trim().split("\n").filter(Boolean).at(-1) ?? "";
  return { ok: code === 0, line: code === 0 ? "tests passed" : `tests failed${last ? `: ${last.slice(0, 120)}` : ""}` };
}
