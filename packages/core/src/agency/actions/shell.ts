import { existsSync, statSync } from "fs";
import { homedir } from "os";
import type { ActionDef, ActionEnv } from "../types";
import { cliEnv } from "../../brains/io";
import { deniedPath, destructiveCommand, expandHome, redactSecrets } from "../../work/safety";
import { resolveRepoArg } from "./code";
import { tildify } from "./files";

/**
 * shell.run: one command, one directory, a timeout. SENSITIVE_ACTION, so it
 * never runs without a spoken yes, and Eve reads the exact command back
 * (confirmLine, never paraphrased). Destructive patterns are refused before
 * she even asks: no approval unlocks rm -rf, force pushes, sudo or curl | sh.
 */

function dirFor(env: ActionEnv | null, raw: unknown): string {
  const d = typeof raw === "string" ? raw.trim() : "";
  if (d) {
    const p = expandHome(d);
    if (p.startsWith("/") && existsSync(p)) return p;
    if (env) {
      const repo = resolveRepoArg(env, d);
      if (repo) return repo.path;
    }
    return p;
  }
  return env?.ctx.tryUse("work")?.context()?.repoPath ?? homedir();
}

export const shellRun: ActionDef = {
  kind: "shell.run",
  permission: "SENSITIVE_ACTION",
  describe: (a) => `run \`${String(a.command ?? "")}\` in ${tildify(String(a.cwd ?? a.dir ?? "~"))}`,
  confirmLine: (a) => `run ${String(a.command ?? "")}, in ${tildify(String(a.cwd ?? a.dir ?? "your home folder")).split("/").pop() || "home"}? yes or no.`,
  refuse: (a) => {
    const bad = destructiveCommand(String(a.command ?? ""));
    if (bad) return bad;
    const d = a.cwd ?? a.dir;
    if (typeof d === "string" && (d.startsWith("/") || d.startsWith("~"))) return deniedPath(d);
    return null;
  },
  async run(args, env) {
    const command = String(args.command ?? "").trim();
    // Checked again at run time: the approval is for the command as read back, nothing else.
    const bad = destructiveCommand(command);
    if (bad) return { ok: false, observation: bad };
    const cwd = dirFor(env, args.cwd ?? args.dir);
    const why = deniedPath(cwd);
    if (why) return { ok: false, observation: why };
    if (!existsSync(cwd) || !statSync(cwd).isDirectory()) return { ok: false, observation: `${tildify(cwd)} isn't a folder` };
    env.progress?.(`$ ${command}`);
    const r = await env.deps.exec(["/bin/zsh", "-c", command], {
      cwd,
      timeoutMs: Math.min(Number(args.timeoutMs) || 60_000, 10 * 60_000),
      env: { ...cliEnv(), NO_COLOR: "1" },
      maxBytes: 200_000,
    });
    const out = redactSecrets(`${r.stdout}${r.stderr ? `\n${r.stderr}` : ""}`.trim());
    const tail = out.split("\n").slice(-12).join("\n").slice(-1200);
    if (r.timedOut) return { ok: false, observation: `timed out. last output: ${tail || "(none)"}`, data: { code: r.code, output: out } };
    return { ok: r.code === 0, observation: `${r.code === 0 ? "ok" : `exited ${r.code}`}${tail ? `: ${tail}` : ""}`, data: { code: r.code, output: out.slice(0, 20_000), cwd } };
  },
};
