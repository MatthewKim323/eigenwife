import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import type { EventMap } from "@eigenwife/protocol";
import type { Exec } from "../agency/types";
import type { OsaRunner } from "../agency/osa";
import { gitInfo, repoFromText, type KnownRepo } from "./repo";
import { deniedPath, isPrivateApp } from "./safety";

/**
 * "What is matt working on", resolved coarsely and locally: the frontmost app
 * (lsappinfo, no permissions), its window title (System Events, only for
 * editors and terminals), and the git repo behind it. Never screen contents,
 * never accessibility text beyond a window title.
 */

export type WorkContext = EventMap["work.context"];

export const EDITORS = ["Cursor", "Code", "Visual Studio Code", "VSCodium", "Windsurf", "Zed", "Xcode", "Sublime Text", "Nova", "WebStorm", "IntelliJ IDEA", "PyCharm", "GoLand", "RustRover", "Fleet"];
export const TERMINALS = ["Terminal", "iTerm2", "iTerm", "Ghostty", "Warp", "Alacritty", "kitty", "WezTerm", "Hyper", "Tabby"];

export const isEditor = (app?: string) => !!app && EDITORS.some((e) => e.toLowerCase() === app.toLowerCase());
export const isTerminal = (app?: string) => !!app && TERMINALS.some((e) => e.toLowerCase() === app.toLowerCase());
export const isCodeApp = (app?: string) => isEditor(app) || isTerminal(app);

/** Parse `lsappinfo info` output ("LSDisplayName"="Cursor", "pid"=123, "CFBundleIdentifier"="..."). */
export function parseLsappinfo(out: string): { app?: string; bundleId?: string; pid?: number } {
  const field = (k: string) => {
    const m = new RegExp(`"${k}"\\s*=\\s*("?)([^"\\n]*)\\1`).exec(out);
    const v = m?.[2]?.trim();
    return v && v !== "[ NULL ]" && v !== "NULL" ? v : undefined;
  };
  const pid = Number(field("pid"));
  return { app: field("LSDisplayName") ?? field("name"), bundleId: field("CFBundleIdentifier") ?? field("bundleid"), pid: Number.isFinite(pid) && pid > 0 ? pid : undefined };
}

/** Frontmost app via lsappinfo (ships with macOS, unprivileged). */
export async function frontmostApp(exec: Exec): Promise<{ app?: string; bundleId?: string; pid?: number }> {
  const asn = await exec(["lsappinfo", "front"], { timeoutMs: 2000 });
  const id = asn.stdout.trim();
  if (asn.code !== 0 || !id) return {};
  const info = await exec(["lsappinfo", "info", "-only", "name", "-only", "bundleid", "-only", "pid", id], { timeoutMs: 2000 });
  return parseLsappinfo(info.stdout);
}

/** Front window title of an app via System Events. Needs Accessibility; fails quietly without it. */
export const WINDOW_TITLE_SCRIPT = `on run argv
  set appName to item 1 of argv
  tell application "System Events"
    if not (exists process appName) then return ""
    tell process appName
      if (count of windows) is 0 then return ""
      return name of front window
    end tell
  end tell
end run`;

/** tty of the front tab in Terminal / iTerm2 (Automation permission, asked once by macOS). */
export const TERMINAL_TTY_SCRIPT = `on run argv
  set appName to item 1 of argv
  if appName is "Terminal" then
    tell application "Terminal" to return tty of selected tab of front window
  else
    tell application "iTerm2" to tell current session of current window to return tty
  end if
end run`;

const DASHES = /\s+[—–-]\s+/;

/**
 * Workspace name from an editor window title. VS Code / Cursor / Windsurf:
 * "file.ts — eigenwife" (or " - "), sometimes with a "[SSH: host]" or
 * "(Workspace)" suffix. Zed: "eigenwife — file.ts". Xcode: "Project — file.swift".
 */
export function workspaceFromTitle(app: string, title: string): string | null {
  const t = title.replace(/\s*\[(?:SSH|WSL|Dev Container|Codespaces)[^\]]*\]\s*/gi, " ").replace(/\s*\((?:Workspace|Untracked)\)\s*/gi, " ").trim();
  if (!t) return null;
  const parts = t.split(DASHES).map((p) => p.replace(/^[●•*]\s*/, "").trim()).filter(Boolean);
  if (!parts.length) return null;
  const a = app.toLowerCase();
  if (a === "zed" || a === "xcode") return parts[0]!;
  // Drop a trailing app name ("... - Visual Studio Code", "... - Cursor").
  if (parts.length > 1 && /^(?:cursor|visual studio code|code|vscodium|windsurf|sublime text)$/i.test(parts.at(-1)!)) parts.pop();
  return parts.at(-1) ?? null;
}

/** Last folder an editor had open, from its global storage (a plain file read, no permissions). */
export function editorLastFolder(app: string, home = homedir()): string | null {
  const dirs: Record<string, string> = { cursor: "Cursor", code: "Code", "visual studio code": "Code", vscodium: "VSCodium", windsurf: "Windsurf" };
  const d = dirs[app.toLowerCase()];
  if (!d) return null;
  const f = join(home, "Library", "Application Support", d, "User", "globalStorage", "storage.json");
  if (!existsSync(f)) return null;
  try {
    const j = JSON.parse(readFileSync(f, "utf8")) as { windowsState?: { lastActiveWindow?: { folder?: string } } };
    const uri = j.windowsState?.lastActiveWindow?.folder;
    if (!uri?.startsWith("file://")) return null;
    return decodeURIComponent(uri.slice("file://".length));
  } catch {
    return null;
  }
}

/** cwd of the foreground process on a tty (the shell, or whatever runs in it: claude, vim, bun). */
export async function cwdOfTty(exec: Exec, tty: string): Promise<string | null> {
  const dev = tty.replace(/^\/dev\//, "").trim();
  if (!/^ttys?\d+$/.test(dev)) return null;
  const ps = await exec(["ps", "-t", dev, "-o", "pid=,stat="], { timeoutMs: 2000 });
  if (ps.code !== 0) return null;
  const rows = ps.stdout
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .filter((r) => r.length >= 2 && /^\d+$/.test(r[0]!));
  const fg = rows.filter((r) => r[1]!.includes("+"));
  const pick = (fg.length ? fg : rows).at(-1);
  if (!pick) return null;
  return cwdOfPid(exec, Number(pick[0]));
}

export async function cwdOfPid(exec: Exec, pid: number): Promise<string | null> {
  const r = await exec(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"], { timeoutMs: 3000 });
  const line = r.stdout.split("\n").find((l) => l.startsWith("n/"));
  return line ? line.slice(1) : null;
}

export interface ProbeDeps {
  exec: Exec;
  osa: OsaRunner;
  repos(): KnownRepo[];
  /** Most recent Claude Code cwd from the hook, if fresh. */
  claudeCwd(): string | null;
  /** Read window titles (System Events). Default on; EVE_WORK_TITLES=0 turns it off. */
  titles: boolean;
  home?: string;
}

/** Resolve a directory for the frontmost code app. */
async function dirFor(app: string, title: string | undefined, d: ProbeDeps): Promise<string | null> {
  if (isEditor(app)) {
    const ws = title ? workspaceFromTitle(app, title) : null;
    if (ws) {
      const hit = repoFromText(ws, d.repos());
      if (hit) return hit.path;
    }
    const last = editorLastFolder(app, d.home);
    if (last) return last;
  }
  if (app === "Terminal" || app === "iTerm2" || app === "iTerm") {
    const tty = await d.osa(TERMINAL_TTY_SCRIPT, { args: [app === "Terminal" ? "Terminal" : "iTerm2"], timeoutMs: 3000 });
    if (tty.ok && tty.stdout) {
      const cwd = await cwdOfTty(d.exec, tty.stdout);
      if (cwd) return cwd;
    }
  }
  if (isTerminal(app) && title) {
    // Many terminals put the cwd or "user@host: ~/dev/foo" in the title.
    const m = /(~\/[\w./-]+|\/Users\/[\w./-]+)/.exec(title);
    if (m) return m[1]!.replace(/^~/, d.home ?? homedir());
    const hit = repoFromText(title, d.repos());
    if (hit) return hit.path;
  }
  return isCodeApp(app) ? d.claudeCwd() : null;
}

/** One probe of the desktop: frontmost app, title, repo facts. */
export async function probeWorkContext(d: ProbeDeps): Promise<WorkContext | null> {
  const front = await frontmostApp(d.exec);
  if (!front.app) return null;
  const app = front.app;
  if (isPrivateApp(app, front.bundleId)) return { app: "private app", private: true };
  let title: string | undefined;
  if (d.titles && isCodeApp(app)) {
    const r = await d.osa(WINDOW_TITLE_SCRIPT, { args: [app], timeoutMs: 2500 });
    if (r.ok && r.stdout) title = r.stdout.slice(0, 200);
  }
  const ctx: WorkContext = { app, ...(front.bundleId ? { bundleId: front.bundleId } : {}), ...(title ? { title } : {}) };
  if (!isCodeApp(app)) return ctx;
  const dir = await dirFor(app, title, d);
  if (!dir || deniedPath(dir)) return ctx;
  const git = await gitInfo(d.exec, dir);
  if (!git) return ctx;
  return { ...ctx, repo: git.name, repoPath: git.root, branch: git.branch, dirty: git.dirty, ...(git.lastCommit ? { lastCommit: git.lastCommit } : {}) };
}

/** "eigenwife (main, 3 dirty files) in Cursor". */
export function describeWork(c: WorkContext | null): string | null {
  if (!c) return null;
  if (c.private) return "a private app";
  if (!c.repo) return c.title ? `${c.app}: ${c.title}` : c.app;
  const dirty = c.dirty ? `, ${c.dirty} dirty file${c.dirty === 1 ? "" : "s"}` : ", clean";
  return `${c.repo} (${c.branch ?? "?"}${dirty}) in ${c.app}`;
}

/** Seconds since the last keyboard/mouse input (IOKit HIDIdleTime, unprivileged). null when unknown. */
export async function hidIdleSeconds(exec: Exec): Promise<number | null> {
  const r = await exec(["ioreg", "-c", "IOHIDSystem", "-d", "4", "-k", "HIDIdleTime"], { timeoutMs: 2000 });
  const m = /"HIDIdleTime"\s*=\s*(\d+)/.exec(r.stdout);
  return m ? Number(m[1]) / 1e9 : null;
}
