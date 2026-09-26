import { existsSync, mkdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { Exec } from "../agency/types";
import { cliEnv, whichBin } from "../brains/io";
import { detectTestCommand, testVerdict } from "./repo";

/**
 * Eve's coding hands: an isolated git worktree per task, headless Claude Code
 * inside it (edits only, a short list of test/build commands, no git writes),
 * then one commit with no AI attribution, a rebase onto the base branch, and a
 * normal (never forced) push. matt's own checkout is never touched.
 */

export interface Worktree {
  repo: string;
  repoName: string;
  path: string;
  branch: string;
  base: string;
  baseSha: string;
}

export function slugify(s: string, max = 32): string {
  return (
    s
      .toLowerCase()
      .replace(/\b(?:ship|fix|implement|refactor|add|make|build|write|create|update|please|the|a|an|in|to|for|with|and|of|my)\b/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, max)
      .replace(/-+$/g, "") || "task"
  );
}

/** Root for Eve's worktrees: ~/.eve/work/worktrees/<repo>/<slug>. */
export function worktreeRoot(eveHome = join(homedir(), ".eve")): string {
  return join(eveHome, "work", "worktrees");
}

async function git(exec: Exec, cwd: string, args: string[], timeoutMs = 20_000) {
  return exec(["git", "-C", cwd, ...args], { timeoutMs });
}

/** Create an isolated worktree on a new branch from the repo's current branch. Never touches the main checkout's files. */
export async function createWorktree(exec: Exec, repo: string, task: string, opts: { eveHome?: string; now?: number } = {}): Promise<Worktree> {
  const top = await git(exec, repo, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) throw new Error(`${repo} isn't a git repo`);
  const root = top.stdout.trim();
  const repoName = root.split("/").pop()!;
  const headRef = await git(exec, root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  let base = headRef.stdout.trim();
  if (headRef.code !== 0 || !base || base === "HEAD") base = "main";
  const sha = await git(exec, root, ["rev-parse", base]);
  if (sha.code !== 0) throw new Error(`can't find base branch ${base}`);
  const stamp = (opts.now ?? Date.now()).toString(36).slice(-5);
  const branch = `eve/${slugify(task)}-${stamp}`;
  const dir = join(worktreeRoot(opts.eveHome), repoName);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, branch.replace(/^eve\//, ""));
  const add = await git(exec, root, ["worktree", "add", "-b", branch, path, sha.stdout.trim()], 60_000);
  if (add.code !== 0) throw new Error(`git worktree add failed: ${add.stderr.trim().slice(0, 200)}`);
  return { repo: root, repoName, path, branch, base, baseSha: sha.stdout.trim() };
}

/** Tools Claude gets inside the worktree. dontAsk mode refuses everything else. */
export const CLAUDE_ALLOWED_TOOLS = [
  "Read",
  "Edit",
  "Write",
  "MultiEdit",
  "Glob",
  "Grep",
  "TodoWrite",
  "Bash(bun test:*)",
  "Bash(bun run test:*)",
  "Bash(bun run typecheck:*)",
  "Bash(bun run lint:*)",
  "Bash(bun run build:*)",
  "Bash(bun install:*)",
  "Bash(bunx tsc:*)",
  "Bash(npm test:*)",
  "Bash(npm run test:*)",
  "Bash(npm run build:*)",
  "Bash(npm run lint:*)",
  "Bash(npx tsc:*)",
  "Bash(pnpm test:*)",
  "Bash(yarn test:*)",
  "Bash(pytest:*)",
  "Bash(python3 -m pytest:*)",
  "Bash(uv run pytest:*)",
  "Bash(cargo test:*)",
  "Bash(cargo build:*)",
  "Bash(go test:*)",
  "Bash(go build:*)",
  "Bash(git status:*)",
  "Bash(git diff:*)",
  "Bash(git log:*)",
  "Bash(ls:*)",
];

export const CLAUDE_DISALLOWED_TOOLS = ["Bash(git commit:*)", "Bash(git push:*)", "Bash(git reset:*)", "Bash(git checkout:*)", "Bash(rm:*)", "Bash(sudo:*)", "WebFetch", "WebSearch"];

export function codePrompt(task: string, wt: Worktree, context?: string): string {
  return [
    `You are working in an isolated git worktree of ${wt.repoName} on branch ${wt.branch}. The user asked by voice: "${task}".`,
    context ? `What they had open: ${context}.` : "",
    "Do the task completely: read the code, make the change, add or update a test when the repo has tests, and run the relevant tests.",
    "Rules: stay inside this directory. Do NOT commit, push, reset or checkout: leave every change uncommitted, the caller commits it.",
    "Never use em dashes (U+2014) or en dashes (U+2013) in code, comments or text.",
    "When you are done, reply with 2-3 plain sentences: what you changed and whether the tests pass. No markdown.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function claudeCodeArgs(bin: string, prompt: string, opts: { model?: string; effort?: string } = {}): string[] {
  return [
    bin,
    "-p",
    prompt,
    "--output-format",
    "stream-json",
    "--verbose",
    "--no-session-persistence",
    "--permission-mode",
    "dontAsk",
    "--allowedTools",
    CLAUDE_ALLOWED_TOOLS.join(","),
    "--disallowedTools",
    CLAUDE_DISALLOWED_TOOLS.join(","),
    "--model",
    opts.model || "sonnet",
    ...(opts.effort ? ["--effort", opts.effort] : []),
  ];
}

export type CodeEvent = { kind: "tool"; name: string; detail?: string } | { kind: "text"; text: string };

/** One stream-json line from claude -p into progress events + the final result. */
export function parseClaudeLine(line: string): { events: CodeEvent[]; result?: string; error?: string } {
  let msg: Record<string, any>;
  try {
    msg = JSON.parse(line);
  } catch {
    return { events: [] };
  }
  const events: CodeEvent[] = [];
  if (msg.type === "assistant") {
    for (const block of msg.message?.content ?? []) {
      if (block?.type === "tool_use") {
        const i = (block.input ?? {}) as Record<string, unknown>;
        const d = i.file_path ?? i.command ?? i.pattern ?? i.path;
        events.push({ kind: "tool", name: String(block.name), ...(typeof d === "string" ? { detail: d.split("/").slice(-2).join("/").slice(0, 80) } : {}) });
      } else if (block?.type === "text" && block.text?.trim()) events.push({ kind: "text", text: String(block.text).trim() });
    }
    return { events };
  }
  if (msg.type === "result") {
    if (msg.is_error) return { events, error: String(msg.result || msg.subtype || "claude error").slice(0, 300) };
    return { events, result: typeof msg.result === "string" ? msg.result.trim() : "" };
  }
  return { events };
}

export interface ClaudeRunResult {
  ok: boolean;
  summary: string;
  error?: string;
  timedOut: boolean;
}

/** Run headless Claude Code in the worktree, streaming progress. */
export async function runClaudeCode(
  exec: Exec,
  wt: Worktree,
  task: string,
  opts: { onEvent?: (e: CodeEvent) => void; timeoutMs?: number; model?: string; effort?: string; context?: string; bin?: string | null; signal?: AbortSignal } = {},
): Promise<ClaudeRunResult> {
  const bin = opts.bin === undefined ? whichBin("claude") : opts.bin;
  if (!bin) return { ok: false, summary: "", error: "claude code isn't installed", timedOut: false };
  let result: string | undefined;
  let error: string | undefined;
  let lastText = "";
  const r = await exec(claudeCodeArgs(bin, codePrompt(task, wt, opts.context), { model: opts.model, effort: opts.effort }), {
    cwd: wt.path,
    env: cliEnv(),
    timeoutMs: opts.timeoutMs ?? 15 * 60_000,
    maxBytes: 4_000_000,
    signal: opts.signal,
    onLine: (line) => {
      const p = parseClaudeLine(line);
      for (const e of p.events) {
        if (e.kind === "text") lastText = e.text;
        opts.onEvent?.(e);
      }
      if (p.result !== undefined) result = p.result;
      if (p.error) error = p.error;
    },
  });
  if (r.timedOut) return { ok: false, summary: result ?? lastText, error: "claude code ran out of time", timedOut: true };
  if (error) return { ok: false, summary: result ?? lastText, error, timedOut: false };
  if (r.code !== 0 && result === undefined) return { ok: false, summary: lastText, error: `claude exited ${r.code}: ${r.stderr.trim().slice(-200)}`, timedOut: false };
  return { ok: true, summary: result ?? lastText, timedOut: false };
}

export interface DiffStat {
  files: number;
  insertions: number;
  deletions: number;
  names: string[];
  text: string;
}

/** Uncommitted + committed changes in the worktree relative to its base (untracked files included). */
export async function diffStat(exec: Exec, wt: Worktree): Promise<DiffStat> {
  await git(exec, wt.path, ["add", "-A", "--intent-to-add"]);
  const stat = await git(exec, wt.path, ["diff", "--stat", wt.baseSha]);
  const nums = await git(exec, wt.path, ["diff", "--numstat", wt.baseSha]);
  let insertions = 0;
  let deletions = 0;
  const names: string[] = [];
  for (const line of nums.stdout.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line.trim());
    if (!m) continue;
    insertions += m[1] === "-" ? 0 : Number(m[1]);
    deletions += m[2] === "-" ? 0 : Number(m[2]);
    names.push(m[3]!);
  }
  return { files: names.length, insertions, deletions, names, text: stat.stdout.trim().split("\n").slice(-12).join("\n") };
}

export async function runTests(exec: Exec, wt: Worktree, timeoutMs = 5 * 60_000): Promise<{ command: string; ok: boolean; line: string } | null> {
  const cmd = detectTestCommand(wt.path);
  if (!cmd) return null;
  // A fresh worktree has no node_modules: install from the lockfile first (quietly, best effort).
  if (cmd[0] === "bun" && !existsSync(join(wt.path, "node_modules")) && existsSync(join(wt.path, "package.json")))
    await exec(["bun", "install", "--frozen-lockfile"], { cwd: wt.path, timeoutMs: 120_000, env: cliEnv() });
  const r = await exec(cmd, { cwd: wt.path, timeoutMs, env: { ...cliEnv(), CI: "1", NO_COLOR: "1" } });
  const v = testVerdict(r.code, `${r.stdout}\n${r.stderr}`);
  return { command: cmd.join(" "), ok: !r.timedOut && v.ok, line: r.timedOut ? "tests timed out" : v.line };
}

/** Lines no commit Eve makes may contain (matt's house rule: commits are his). */
const ATTRIBUTION = /^\s*(?:co-authored-by:.*|.*\b(?:generated|written|created|made)\s+(?:with|by)\s+.*\b(?:claude|codex|chatgpt|gpt|copilot|ai)\b.*|.*noreply@anthropic\.com.*|.*\bu\+1f916\b.*|\u{1F916}.*)$/gimu;

export function commitMessage(task: string): string {
  const msg = task
    .toLowerCase()
    .replace(/^(?:hey|yo|eve|please|can you|could you)[, ]+/g, "")
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!?]+$/, "")
    .slice(0, 72);
  return (msg || "eve changes").replace(ATTRIBUTION, "").trim();
}

export function hasAttribution(message: string): boolean {
  ATTRIBUTION.lastIndex = 0;
  const hit = ATTRIBUTION.test(message);
  ATTRIBUTION.lastIndex = 0;
  return hit;
}

/**
 * Squash everything on the branch (Claude's commits too, if it made any) into
 * one commit with matt's message and no attribution lines. Local and isolated.
 */
export async function commitWork(exec: Exec, wt: Worktree, message: string): Promise<{ ok: boolean; sha?: string; error?: string; empty?: boolean }> {
  const clean = message.replace(ATTRIBUTION, "").replace(/\n{3,}/g, "\n\n").trim();
  await git(exec, wt.path, ["reset", "--soft", wt.baseSha]);
  await git(exec, wt.path, ["add", "-A"]);
  const staged = await git(exec, wt.path, ["diff", "--cached", "--quiet"]);
  if (staged.code === 0) return { ok: true, empty: true };
  const c = await git(exec, wt.path, ["-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", clean], 30_000);
  if (c.code !== 0) return { ok: false, error: c.stderr.trim().slice(0, 200) || "commit failed" };
  const sha = await git(exec, wt.path, ["rev-parse", "--short", "HEAD"]);
  return { ok: true, sha: sha.stdout.trim() };
}

export interface MergeOutcome {
  ok: boolean;
  pushed: boolean;
  sha?: string;
  observation: string;
}

/**
 * Rebase the branch onto the latest base and push it to the base branch on
 * origin. Never forced: a rejected push is an honest failure and the branch stays.
 */
export async function rebaseAndPush(exec: Exec, wt: Worktree, hasRemote: boolean): Promise<MergeOutcome> {
  let onto = wt.base;
  if (hasRemote) {
    const f = await git(exec, wt.path, ["fetch", "origin", wt.base], 60_000);
    if (f.code === 0) onto = `origin/${wt.base}`;
  }
  const rb = await git(exec, wt.path, ["rebase", onto], 60_000);
  if (rb.code !== 0) {
    await git(exec, wt.path, ["rebase", "--abort"]);
    return { ok: false, pushed: false, observation: `rebase onto ${onto} hit conflicts. kept branch ${wt.branch} as is.` };
  }
  const sha = (await git(exec, wt.path, ["rev-parse", "--short", "HEAD"])).stdout.trim();
  if (!hasRemote) return { ok: true, pushed: false, sha, observation: `committed ${sha} on ${wt.branch}, rebased on ${wt.base}. no remote to push to.` };
  const push = await git(exec, wt.path, ["push", "origin", `HEAD:refs/heads/${wt.base}`], 90_000);
  if (push.code !== 0) return { ok: false, pushed: false, sha, observation: `push to ${wt.base} was rejected (${push.stderr.trim().split("\n").at(-1)?.slice(0, 120)}). kept branch ${wt.branch}.` };
  return { ok: true, pushed: true, sha, observation: `pushed ${sha} to ${wt.base}` };
}

/** Remove the worktree directory. deleteBranch only after a successful push. */
export async function removeWorktree(exec: Exec, wt: Worktree, deleteBranch: boolean): Promise<void> {
  await git(exec, wt.repo, ["worktree", "remove", "--force", wt.path], 30_000);
  // -d (not -D) refuses to drop unmerged work, which is exactly the safety we want.
  if (deleteBranch) await git(exec, wt.repo, ["branch", "-d", wt.branch]);
  await git(exec, wt.repo, ["worktree", "prune"]);
}
