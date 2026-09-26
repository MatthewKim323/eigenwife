import { existsSync } from "fs";
import { join } from "path";
import { newId } from "@eigenwife/protocol";
import type { ActionDef, ActionEnv } from "../types";
import { whichBin } from "../../brains/io";
import { commitMessage, commitWork, createWorktree, diffStat, rebaseAndPush, removeWorktree, runClaudeCode, runTests, type Worktree } from "../../work/code";
import { codeRoots, detectTestCommand, gitInfo, listRepos, repoFromText, testVerdict } from "../../work/repo";
import { deniedPath, expandHome } from "../../work/safety";

/**
 * Code actions. code.task (EXTERNAL_SIDE_EFFECT) makes an isolated worktree and
 * runs Claude Code in it; code.merge (SENSITIVE_ACTION, asked out loud as
 * "merge it and push?") commits, rebases and pushes; code.keep (SAFE_ACTION)
 * commits locally and keeps the branch. code.status (READ) reports git + tests.
 */

const SRC = "work";

/** A repo from a name, a path, or matt's current work context. */
export function resolveRepoArg(env: ActionEnv, hint?: unknown): { name: string; path: string } | null {
  const h = typeof hint === "string" ? hint.trim() : "";
  const work = env.ctx.tryUse("work");
  if (work) return work.resolveRepo(h || undefined);
  if (h) {
    const p = expandHome(h);
    if (existsSync(join(p, ".git")) && !deniedPath(p)) return { name: p.split("/").pop()!, path: p };
    return repoFromText(h, listRepos(codeRoots(env.deps.env)));
  }
  return null;
}

const isWorktree = (x: unknown): x is Worktree => {
  const w = x as Worktree;
  return !!w && typeof w === "object" && typeof w.path === "string" && typeof w.branch === "string" && typeof w.repo === "string" && typeof w.baseSha === "string";
};

/** Merge/keep only ever touch Eve's own worktrees on eve/* branches. */
function refuseForeignWorktree(a: Record<string, unknown>): string | null {
  const w = a.worktree;
  if (!isWorktree(w)) return "no worktree to merge";
  if (!w.branch.startsWith("eve/")) return `refused: ${w.branch} isn't one of my branches`;
  if (!/\/work\/worktrees\//.test(w.path)) return "refused: that worktree isn't mine";
  if (deniedPath(w.repo)) return deniedPath(w.repo);
  return null;
}

export const codeTask: ActionDef = {
  kind: "code.task",
  permission: "EXTERNAL_SIDE_EFFECT",
  describe: (a) => `have claude code ${String(a.task ?? "do it").replace(/^(?:please\s+)/i, "")} in ${String(a.repoName ?? a.repo ?? "the repo").split("/").pop()} on its own branch`,
  refuse: (a) => (typeof a.repo === "string" && a.repo ? deniedPath(a.repo) : null),
  async run(args, env) {
    const task = String(args.task ?? "").trim();
    if (!task) return { ok: false, observation: "what should i build?" };
    const repo = resolveRepoArg(env, args.repo);
    if (!repo) return { ok: false, observation: "which repo? i couldn't tell" };
    const { bus } = env.ctx;
    const taskId = env.taskId ?? newId("task");
    const agentId = `${taskId}-claude`;
    const title = task.length > 60 ? task.slice(0, 57) + "..." : task;
    const chip = (state: "starting" | "working" | "testing" | "review" | "failed", detail?: string, branch?: string) =>
      bus.emit("work.task", { taskId, title, state, repo: repo.name, ...(branch ? { branch } : {}), ...(detail ? { detail } : {}) }, SRC);
    const progress = (text: string) => {
      bus.emit("swarm.progress", { taskId, agentId, text: text.slice(0, 160) }, SRC);
      env.progress?.(text);
    };

    chip("starting");
    bus.emit("swarm.plan", { taskId, mode: "SPAWN_ONE", confidence: 0.9, workers: [{ role: "CODER", goal: task }] }, SRC);
    bus.emit("swarm.spawn", { taskId, agentId, role: "CODER", label: `claude code: ${title}`, name: "Claude", goal: task }, SRC);
    bus.emit("swarm.status", { taskId, agentId, state: "spawning" }, SRC);

    let wt: Worktree;
    try {
      wt = await createWorktree(env.deps.exec, repo.path, task, { eveHome: env.ctx.config.eveHome, now: env.deps.now() });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      bus.emit("swarm.done", { taskId, agentId, ok: false, result: msg }, SRC);
      chip("failed", msg);
      return { ok: false, observation: `couldn't set up a branch: ${msg}` };
    }
    progress(`worktree ready on ${wt.branch}`);
    chip("working", undefined, wt.branch);
    bus.emit("swarm.status", { taskId, agentId, state: "working" }, SRC);

    let lastTool = 0;
    const run = await runClaudeCode(env.deps.exec, wt, task, {
      bin: env.deps.env("EVE_CLAUDE_BIN") || whichBin("claude"),
      model: env.deps.env("EVE_CODE_MODEL") || "sonnet",
      effort: env.deps.env("EVE_CODE_EFFORT") || undefined,
      timeoutMs: Number(env.deps.env("EVE_CODE_TIMEOUT_MS")) || 15 * 60_000,
      context: typeof args.context === "string" ? args.context : undefined,
      onEvent: (e) => {
        if (e.kind === "tool") {
          const now = env.deps.now();
          bus.emit("swarm.status", { taskId, agentId, state: "working", tool: e.name }, SRC);
          if (now - lastTool > 250) progress(`${e.name}${e.detail ? ` ${e.detail}` : ""}`);
          lastTool = now;
        } else progress(e.text.replace(/\s+/g, " "));
      },
    });

    const diff = await diffStat(env.deps.exec, wt);
    if (!run.ok && !diff.files) {
      await removeWorktree(env.deps.exec, wt, true);
      bus.emit("swarm.done", { taskId, agentId, ok: false, result: run.error ?? "failed" }, SRC);
      chip("failed", run.error);
      return { ok: false, observation: `claude code didn't finish: ${run.error ?? "no reason given"}` };
    }
    if (!diff.files) {
      await removeWorktree(env.deps.exec, wt, true);
      bus.emit("swarm.done", { taskId, agentId, ok: false, result: "no changes" }, SRC);
      chip("failed", "no changes");
      return { ok: false, observation: `claude code finished without changing anything. ${run.summary}`.trim() };
    }

    chip("testing", undefined, wt.branch);
    bus.emit("swarm.status", { taskId, agentId, state: "waiting", tool: "tests" }, SRC);
    progress("running the tests");
    const tests = args.tests === false ? null : await runTests(env.deps.exec, wt, Number(env.deps.env("EVE_TEST_TIMEOUT_MS")) || 5 * 60_000);
    if (tests) progress(`tests: ${tests.line}`);

    const info = await gitInfo(env.deps.exec, wt.repo);
    const changed = `${diff.files} file${diff.files === 1 ? "" : "s"} changed (+${diff.insertions} -${diff.deletions})`;
    const summary = (run.summary || "done").replace(/\s+/g, " ").trim();
    const testLine = tests ? (tests.ok ? `tests pass (${tests.line})` : `tests FAIL (${tests.line})`) : "no test command found";
    bus.emit("swarm.done", { taskId, agentId, ok: run.ok, result: `${changed}; ${testLine}` }, SRC);
    chip("review", `${changed}; ${testLine}`, wt.branch);
    return {
      ok: true,
      observation: `${summary} ${changed} on ${wt.branch}; ${testLine}.${run.ok ? "" : ` (claude stopped early: ${run.error})`}`,
      data: { worktree: wt, diff, tests, summary, hasRemote: info?.hasRemote ?? false, claudeOk: run.ok },
    };
  },
};

export const codeMerge: ActionDef = {
  kind: "code.merge",
  permission: "SENSITIVE_ACTION",
  describe: (a) => {
    const w = a.worktree as Worktree | undefined;
    return `commit ${w?.branch ?? "the branch"}, rebase it onto ${w?.base ?? "main"} and push`;
  },
  confirmLine: (a) => {
    const w = a.worktree as Worktree | undefined;
    return a.hasRemote === false ? `commit it onto ${w?.branch ?? "the branch"}? there's no remote to push to.` : `merge it and push to ${w?.base ?? "main"}?`;
  },
  refuse: refuseForeignWorktree,
  async run(args, env) {
    const wt = args.worktree as Worktree;
    const msg = commitMessage(String(args.message ?? args.task ?? "eve changes"));
    const c = await commitWork(env.deps.exec, wt, msg);
    if (!c.ok) return { ok: false, observation: `commit failed: ${c.error}. branch ${wt.branch} is still there.` };
    if (c.empty) {
      await removeWorktree(env.deps.exec, wt, true);
      return { ok: false, observation: "nothing to commit" };
    }
    const out = await rebaseAndPush(env.deps.exec, wt, args.hasRemote !== false);
    await removeWorktree(env.deps.exec, wt, out.pushed);
    return { ok: out.ok, observation: out.observation, data: { ...out, branch: wt.branch } };
  },
};

export const codeKeep: ActionDef = {
  kind: "code.keep",
  permission: "SAFE_ACTION",
  describe: (a) => `keep the work on ${(a.worktree as Worktree | undefined)?.branch ?? "its branch"} without pushing`,
  refuse: refuseForeignWorktree,
  async run(args, env) {
    const wt = args.worktree as Worktree;
    const c = await commitWork(env.deps.exec, wt, commitMessage(String(args.message ?? args.task ?? "eve changes")));
    if (!c.ok) return { ok: false, observation: `left it uncommitted in ${wt.path}: ${c.error}` };
    await removeWorktree(env.deps.exec, wt, false);
    return { ok: true, observation: `kept it on branch ${wt.branch}${c.sha ? ` (${c.sha})` : ""}, not pushed`, data: { branch: wt.branch, sha: c.sha } };
  },
};

export const codeStatus: ActionDef = {
  kind: "code.status",
  permission: "READ",
  describe: (a) => (a.tests ? `run the tests in ${String(a.repo ?? "this repo")}` : `check git status of ${String(a.repo ?? "this repo")}`),
  refuse: (a) => (typeof a.repo === "string" && (a.repo.startsWith("/") || a.repo.startsWith("~")) ? deniedPath(a.repo) : null),
  async run(args, env) {
    const repo = resolveRepoArg(env, args.repo);
    if (!repo) return { ok: false, observation: "which repo? i can't tell what you're working on" };
    const info = await gitInfo(env.deps.exec, repo.path);
    if (!info) return { ok: false, observation: `${repo.name} isn't a git repo` };
    const parts = [`${info.name} on ${info.branch}`, info.dirty ? `${info.dirty} uncommitted file${info.dirty === 1 ? "" : "s"}` : "clean", info.lastCommit ? `last commit ${info.lastCommit}` : ""];
    let tests: { ok: boolean; line: string; command: string } | null = null;
    if (args.tests) {
      const cmd = detectTestCommand(info.root);
      if (!cmd) parts.push("no test command i recognize");
      else {
        env.progress?.(`running ${cmd.join(" ")}`);
        const r = await env.deps.exec(cmd, { cwd: info.root, timeoutMs: Number(env.deps.env("EVE_TEST_TIMEOUT_MS")) || 5 * 60_000, env: { ...process.env, CI: "1", NO_COLOR: "1" } as Record<string, string> });
        const v = testVerdict(r.code, `${r.stdout}\n${r.stderr}`);
        tests = { ok: !r.timedOut && v.ok, line: r.timedOut ? "tests timed out" : v.line, command: cmd.join(" ") };
        parts.push(tests.ok ? `tests pass: ${tests.line}` : `tests failing: ${tests.line}`);
      }
    }
    return { ok: tests ? tests.ok : true, observation: parts.filter(Boolean).join(", "), data: { info, tests } };
  },
};

export const CODE_ACTIONS = [codeTask, codeMerge, codeKeep, codeStatus];
