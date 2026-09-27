import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { newId, type AnyEnvelope } from "@eigenwife/protocol";
import type { OsaRunner } from "../agency/osa";
import { realOsa } from "../agency/osa";
import type { Exec } from "../agency/types";
import { secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { WorkContextSnapshot, WorkService } from "../services";
import type { Worktree } from "./code";
import { describeWork, hidIdleSeconds, isCodeApp, probeWorkContext, type WorkContext } from "./context";
import { realExec } from "./exec";
import { answerClarify, readWorkIntent, type WorkAsk } from "./intent";
import { codeRoots, listRepos, repoFromText, type KnownRepo } from "./repo";
import { deniedPath, expandHome } from "./safety";
import { speakable } from "./jabby";
import { createMessagesFlow } from "../agency/actions/messages";

/**
 * Eve as a coworker. Watches what matt is working on (app + repo, never the
 * screen), turns work asks into gated actions (files, code, jabby, shell),
 * and says one line when a Claude Code session of his finishes, without
 * talking over him while he types.
 */

const SRC = "work";

export interface WorkDeps {
  exec: Exec;
  osa: OsaRunner;
  now(): number;
  env(name: string): string;
  /** Seconds since the last keyboard/mouse input, null when unknown. */
  idleSeconds(): Promise<number | null>;
  sleep(ms: number): Promise<void>;
  home: string;
}

export interface WorkOptions {
  deps?: Partial<WorkDeps>;
  /** Poll the frontmost app. Default: on macOS outside tests, unless EVE_WORK_POLL=0. */
  poll?: boolean;
  pollMs?: number;
  /** Quiet period between unprompted work lines. */
  cooldownMs?: number;
  /** How long to wait for matt to stop typing before saying a line (then drop it). */
  focusWaitMs?: number;
}

export function defaultWorkDeps(): WorkDeps {
  return {
    exec: realExec,
    osa: realOsa,
    now: () => Date.now(),
    env: (n) => secret(n),
    idleSeconds: () => hidIdleSeconds(realExec),
    sleep: (ms) => Bun.sleep(ms),
    home: homedir(),
  };
}

const DONE_LINES = ["claude's done in {repo}.", "{repo}: claude finished.", "claude wrapped up in {repo}."];
const FAIL_LINES = ["claude's done in {repo}, but the tests are failing.", "claude finished in {repo}. tests are red though."];

export function createWork(ctx: CoreContext, opts: WorkOptions = {}) {
  const deps: WorkDeps = { ...defaultWorkDeps(), ...opts.deps };
  const cooldownMs = opts.cooldownMs ?? 90_000;
  const focusWaitMs = opts.focusWaitMs ?? 45_000;
  let snapshot: WorkContextSnapshot | null = null;
  let repoCache: { at: number; list: KnownRepo[] } | null = null;
  let pending: { partial: string; until: number } | null = null;
  /** "text stephen hung ..." (docs/MESSAGES.md): who, what, read back, edits, send. */
  const messages = createMessagesFlow(ctx, { now: deps.now });
  let lastLineAt = -Infinity;
  let attentionPaused = false;
  const claude: { cwd: string; at: number } = { cwd: "", at: 0 };
  const sessions = new Map<string, { cwd?: string; tools: number; testsOk?: boolean }>();
  const eveWork = join(ctx.config.eveHome, "work");
  const log = (...a: unknown[]) => ctx.log("work", ...a);

  function repos(): KnownRepo[] {
    if (!repoCache || deps.now() - repoCache.at > 60_000) repoCache = { at: deps.now(), list: listRepos(codeRoots(deps.env, deps.home)) };
    return repoCache.list;
  }

  function setContext(c: WorkContext | null) {
    if (!c) return;
    const prev = snapshot;
    snapshot = { ...c, at: deps.now() };
    const same = prev && prev.app === c.app && prev.repo === c.repo && prev.branch === c.branch && prev.dirty === c.dirty && prev.title === c.title;
    if (same) return;
    ctx.bus.emit("work.context", c, SRC);
    ctx.setSlot("work", "working_on", c.repo ? describeWork(c) : null);
  }

  // --- repo resolution --------------------------------------------------------
  function resolveRepo(hint?: string): { name: string; path: string } | null {
    const h = (hint ?? "").trim();
    if (h) {
      const p = expandHome(h);
      if ((p.startsWith("/") || h.startsWith("~")) && existsSync(join(p, ".git")) && !deniedPath(p)) return { name: p.split("/").pop()!, path: p };
      const hit = repoFromText(h, repos());
      if (hit) return hit;
      // A path-ish hint that doesn't exist is an answer, not a fallback.
      if (/^(?:~|\/)/.test(h)) return null;
    }
    if (snapshot?.repoPath && snapshot.repo && !deniedPath(snapshot.repoPath)) return { name: snapshot.repo, path: snapshot.repoPath };
    if (claude.cwd && deps.now() - claude.at < 30 * 60_000) {
      const hit = repos().find((r) => claude.cwd === r.path || claude.cwd.startsWith(r.path + "/"));
      if (hit) return hit;
    }
    return null;
  }

  // --- polling --------------------------------------------------------------------
  let probing = false;
  async function probe(): Promise<WorkContext | null> {
    if (probing) return null;
    probing = true;
    try {
      const c = await probeWorkContext({
        exec: deps.exec,
        osa: deps.osa,
        repos,
        claudeCwd: () => (claude.cwd && deps.now() - claude.at < 10 * 60_000 ? claude.cwd : null),
        titles: deps.env("EVE_WORK_TITLES") !== "0",
        home: deps.home,
      });
      setContext(c);
      return c;
    } catch (err) {
      log("probe failed:", err);
      return null;
    } finally {
      probing = false;
    }
  }

  // --- speaking ---------------------------------------------------------------------
  /** matt is typing in an editor/terminal right now. */
  async function focused(): Promise<boolean> {
    if (!isCodeApp(snapshot?.app ?? ctx.world().desktop.activeApp)) return false;
    const idle = await deps.idleSeconds().catch(() => null);
    return idle !== null && idle < 4;
  }

  /** One unprompted line, only when it's polite: born, not paused, not mid-sentence, not while he types, not too often. */
  async function sayAmbient(line: string): Promise<boolean> {
    const w = ctx.world();
    if (!w.companion.born || attentionPaused) return false;
    if (deps.now() - lastLineAt < cooldownMs) return false;
    const deadline = deps.now() + focusWaitMs;
    while ((await focused()) || ctx.tryUse("speech")?.speaking() || ctx.world().user.speaking) {
      if (deps.now() >= deadline) {
        log(`dropped "${line}": matt stayed busy`);
        return false;
      }
      await deps.sleep(1000);
    }
    lastLineAt = deps.now();
    const speech = ctx.tryUse("speech");
    if (!speech) return false;
    await speech.say(line, { priority: "low", brain: "work" }).catch(() => {});
    return true;
  }

  const pick = (arr: string[], seed: string) => arr[Math.abs([...seed].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 0)) % arr.length]!;

  function onClaude(e: AnyEnvelope & { type: "work.claude" }) {
    const d = e.data;
    const cwd = d.cwd ?? "";
    // Eve's own claude -p runs (code.task worktrees, frontier scratch) aren't matt's sessions.
    if (cwd && (cwd === eveWork || cwd.startsWith(eveWork + "/"))) return;
    const id = d.sessionId ?? cwd ?? "default";
    const s = sessions.get(id) ?? { cwd, tools: 0 };
    if (cwd) {
      s.cwd = cwd;
      claude.cwd = cwd;
      claude.at = deps.now();
    }
    if (d.event === "tool") s.tools++;
    if (d.event === "test" && typeof d.ok === "boolean") s.testsOk = d.ok;
    sessions.set(id, s);
    if (d.event !== "stop") return;
    sessions.delete(id);
    // A quick question isn't work worth a remark: only sessions that used tools.
    if (s.tools < 1) return;
    const repo = repos().find((r) => s.cwd === r.path || s.cwd?.startsWith(r.path + "/"))?.name ?? (s.cwd ? s.cwd.split("/").pop() : undefined) ?? "your repo";
    const line = pick(s.testsOk === false ? FAIL_LINES : DONE_LINES, e.id).replace("{repo}", repo);
    void sayAmbient(line);
  }

  // --- asks ----------------------------------------------------------------------------
  function awaiting(): boolean {
    if (messages.awaiting()) return true;
    if (pending && deps.now() > pending.until) pending = null;
    return !!pending;
  }

  function claims(text: string): boolean {
    return awaiting() || readWorkIntent(text) !== null;
  }

  const agencyOrThrow = () => {
    const a = ctx.tryUse("agency");
    if (!a) throw new Error("my hands aren't hooked up (no agency)");
    return a;
  };

  async function say(text: string, parent?: string) {
    const speech = ctx.tryUse("speech");
    if (speech) await speech.say(text, { priority: "high", parent, brain: "work" }).catch(() => {});
  }

  async function codeTask(ask: WorkAsk & { kind: "code.task" }, goal: string, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const repo = resolveRepo(ask.task);
    if (!repo) {
      pending = { partial: `${ask.task} in`, until: deps.now() + 90_000 };
      const names = repos()
        .slice(0, 3)
        .map((r) => r.name)
        .join(", ");
      return { ok: true, summary: `which repo?${names ? ` like ${names}?` : ""}` };
    }
    const agency = agencyOrThrow();
    const taskId = newId("task");
    const t0 = deps.now();
    ctx.bus.emit("task.start", { taskId, goal, brain: "claude-code" }, SRC, parent);
    ctx.bus.emit("avatar.state", { state: "acting" }, SRC, parent);
    ctx.setSlot("work", "task", `${ask.task} (${repo.name})`);
    const done = (ok: boolean, summary: string) => {
      ctx.bus.emit("task.done", { taskId, ok, summary, ms: deps.now() - t0 }, SRC, parent);
      ctx.setSlot("work", "task", null);
      return { ok, summary };
    };
    try {
      const ctxLine = snapshot?.repo === repo.name ? describeWork(snapshot) ?? undefined : undefined;
      const run = await agency.act("code.task", { task: ask.task, repo: repo.path, repoName: repo.name, context: ctxLine }, { taskId, parent });
      if (!run.ok) return done(false, run.observation.startsWith("not done:") ? "okay, i won't touch it." : speakable(run.observation, 220));
      const data = run.data as { worktree: Worktree; tests: { ok: boolean; line: string } | null; diff: { files: number; insertions: number; deletions: number }; summary: string; hasRemote: boolean };
      const wt = data.worktree;
      const testBit = data.tests ? (data.tests.ok ? "tests pass." : `tests are failing (${data.tests.line}).`) : "no tests to run.";
      await say(`${speakable(data.summary, 240)} ${data.diff.files} file${data.diff.files === 1 ? "" : "s"}, ${testBit}`.trim(), parent);
      ctx.bus.emit("work.task", { taskId, title: ask.task.slice(0, 60), state: "review", repo: repo.name, branch: wt.branch }, SRC);
      const merge = await agency.act("code.merge", { worktree: wt, task: ask.task, message: ask.task, hasRemote: data.hasRemote }, { taskId, parent });
      if (merge.ok) {
        ctx.bus.emit("work.task", { taskId, title: ask.task.slice(0, 60), state: "done", repo: repo.name, branch: wt.branch, detail: merge.observation }, SRC);
        const md = merge.data as { pushed?: boolean; sha?: string } | undefined;
        return done(true, md?.pushed ? `pushed to ${wt.base}. ${md.sha ?? ""}`.trim() : `committed on ${wt.branch}. no remote, so nothing pushed.`);
      }
      if (!merge.observation.startsWith("not done:")) {
        ctx.bus.emit("work.task", { taskId, title: ask.task.slice(0, 60), state: "failed", repo: repo.name, branch: wt.branch, detail: merge.observation }, SRC);
        return done(false, speakable(merge.observation, 220));
      }
      const keep = await agency.act("code.keep", { worktree: wt, task: ask.task }, { taskId, parent });
      ctx.bus.emit("work.task", { taskId, title: ask.task.slice(0, 60), state: "kept", repo: repo.name, branch: wt.branch }, SRC);
      return done(keep.ok, keep.ok ? `okay, not pushing. it's on branch ${wt.branch}.` : speakable(keep.observation, 200));
    } catch (err) {
      return done(false, `it broke: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function jabby(ask: WorkAsk & { kind: "jabby" }, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const agency = agencyOrThrow();
    if (ask.mode === "read") {
      const r = await agency.act("jabby.ask", { request: ask.request }, { parent });
      return { ok: r.ok, summary: r.ok ? r.observation : `jabby couldn't: ${r.observation}` };
    }
    if (ask.mode === "act") {
      const r = await agency.act("jabby.act", { request: ask.request }, { parent });
      return { ok: r.ok, summary: r.ok ? r.observation : r.observation.startsWith("not done:") ? "okay, skipping it." : `jabby couldn't: ${r.observation}` };
    }
    // send: draft (no side effects), read it back word for word, send only on yes.
    const draft = await agency.act("jabby.draft", { request: ask.request }, { parent });
    if (!draft.ok) return { ok: false, summary: `couldn't draft it: ${draft.observation}` };
    const d = draft.data as { channel: string; to: string; subject?: string; body: string };
    if (!d.to) {
      pending = { partial: `${ask.request} (send it to`, until: deps.now() + 90_000 };
      return { ok: true, summary: "who's it going to?" };
    }
    const sent = await agency.act("jabby.send", { request: ask.request, ...d }, { parent });
    if (sent.ok) return { ok: true, summary: `sent. ${sent.observation}`.trim() };
    return { ok: false, summary: sent.observation.startsWith("not done:") ? "okay, not sending it." : `didn't send: ${sent.observation}` };
  }

  async function handle(text: string, o: { parent?: string; goal?: string } = {}): Promise<{ ok: boolean; summary: string }> {
    let utterance = text;
    // She asked "stephen hung or stephen lee?" / "what do you wanna say?": this is the answer (unless it's a new text ask).
    if (messages.awaiting() && readWorkIntent(text)?.kind !== "messages.send") {
      try {
        return await messages.answer(text, o.parent);
      } catch (err) {
        return { ok: false, summary: `it broke: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    if (awaiting() && pending) {
      utterance = answerClarify(pending.partial, text);
      pending = null;
    }
    const ask = readWorkIntent(utterance);
    if (!ask) return { ok: false, summary: "not sure what you want me to do there." };
    const goal = o.goal ?? utterance;
    const parent = o.parent;
    try {
      switch (ask.kind) {
        case "clarify":
          pending = { partial: ask.partial, until: deps.now() + 90_000 };
          return { ok: true, summary: ask.question };
        case "context": {
          const c = snapshot ?? (await probe());
          const d = describeWork(c);
          return { ok: !!d, summary: d ? `you're in ${d}.` : "can't tell what you're working on right now." };
        }
        case "code.status": {
          const repo = resolveRepo(utterance);
          if (!repo) {
            pending = { partial: `${ask.tests ? "run the tests" : "git status"} in`, until: deps.now() + 90_000 };
            return { ok: true, summary: "which repo?" };
          }
          const r = await agencyOrThrow().act("code.status", { repo: repo.path, tests: ask.tests }, { parent });
          return { ok: r.ok, summary: r.observation };
        }
        case "files.search": {
          const r = await agencyOrThrow().act("files.search", { query: ask.query, content: ask.content }, { parent });
          return { ok: r.ok, summary: r.observation };
        }
        case "files.read": {
          const r = await agencyOrThrow().act("files.read", { target: ask.target }, { parent });
          return { ok: r.ok, summary: r.observation };
        }
        case "files.open": {
          const r = await agencyOrThrow().act("files.open", { target: ask.target }, { parent });
          return { ok: r.ok, summary: r.ok ? "opened." : r.observation.replace(/^not done: /, "") };
        }
        case "shell.run": {
          const cwd = ask.dir ? (resolveRepo(ask.dir)?.path ?? ask.dir) : (resolveRepo()?.path ?? deps.home);
          const r = await agencyOrThrow().act("shell.run", { command: ask.command, cwd }, { parent });
          if (r.observation.startsWith("not done:")) return { ok: false, summary: r.observation.includes("refused") ? r.observation.replace(/^not done: /, "not running that: ") : "okay, didn't run it." };
          return { ok: r.ok, summary: speakable(r.observation, 280) };
        }
        case "jabby":
          return await jabby(ask, parent);
        case "messages.send":
          return await messages.start(ask, parent);
        case "code.task":
          return await codeTask(ask, goal, parent);
      }
    } catch (err) {
      return { ok: false, summary: `it broke: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  const service: WorkService = { context: () => snapshot, claims, awaiting, handle, resolveRepo };

  const offs: (() => void)[] = [];
  offs.push(
    ctx.bus.on("work.claude", (e) => onClaude(e as AnyEnvelope & { type: "work.claude" })),
    ctx.bus.on("attention.pause", (e) => {
      attentionPaused = e.data.paused;
    }),
    // A context someone else reported (the watcher) counts too.
    ctx.bus.on("work.context", (e) => {
      if (e.source !== SRC) snapshot = { ...e.data, at: deps.now() };
    }),
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  const wantPoll = opts.poll ?? (process.platform === "darwin" && process.env.NODE_ENV !== "test" && deps.env("EVE_WORK_POLL") !== "0");
  if (wantPoll) {
    void probe();
    timer = setInterval(() => void probe(), opts.pollMs ?? 4000);
  }

  return {
    service,
    probe,
    setContext,
    deps,
    stop() {
      for (const off of offs.splice(0)) off();
      if (timer) clearInterval(timer);
    },
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function workModule(opts: WorkOptions = {}): Module {
  let work: ReturnType<typeof createWork> | null = null;
  return {
    name: "work",
    start(ctx) {
      const w = (work = createWork(ctx, opts));
      ctx.provide("work", w.service);
      ctx.route("/api/work/context", async (_req, url) => {
        if (url.searchParams.get("fresh") === "1") await w.probe();
        return json({ ok: true, context: w.service.context(), describe: describeWork(w.service.context()) });
      });
      // Same path as a spoken ask (approvals still apply). For scripts and the real-run check.
      ctx.route("/api/work/ask", async (req) => {
        if (req.method !== "POST") return null;
        const text = String((await body(req)).text ?? "").trim();
        if (!text) return json({ ok: false, error: "text required" }, 400);
        return json(await w.service.handle(text));
      });
    },
    stop() {
      work?.stop();
    },
  };
}
