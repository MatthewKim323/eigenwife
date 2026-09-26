import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import type { Exec } from "../agency/types";
import { REPO_ROOT } from "../config";
import type { AxText, ScreenRead } from "./summarize";

/**
 * The macOS side of the screen sense.
 *
 * Level 2: watcher/screen-ax.swift, compiled once (swiftc -O) to
 * ~/.eve/bin/screen-ax-<hash>, prints the focused window's accessibility text
 * as JSON. Secure text fields are skipped inside the helper.
 *
 * Level 3: `screencapture -l <windowId> -x -o` of exactly that window into
 * ~/.eve/tmp, downscaled with sips, handed to a vision model, and deleted in a
 * finally block (and swept on start, in case the process died mid-look).
 */

export const HELPER_SRC = join(REPO_ROOT, "watcher", "screen-ax.swift");

export interface AxDump extends ScreenRead {
  ok: boolean;
  error?: string;
  pid?: number;
  windowId?: number;
  secureFocused?: boolean;
  secureSeen?: boolean;
  noWindow?: boolean;
  /** The helper hit a denylisted host and stopped reading. */
  private?: boolean;
}

export interface Permissions {
  accessibility: boolean;
  screenRecording: boolean | null;
}

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
}

/** Validate the helper's JSON. Secure-field text never gets this far, but a secure role is dropped here too. */
export function parseDump(stdout: string): AxDump {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(stdout.trim().split("\n").pop() ?? "");
  } catch {
    return { ok: false, error: "bad helper output", app: "", texts: [] };
  }
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  const texts: AxText[] = Array.isArray(j.texts)
    ? (j.texts as Record<string, unknown>[])
        .filter((x) => x && typeof x.t === "string" && typeof x.r === "string" && !/secure/i.test(String(x.r)))
        .map((x) => ({ r: String(x.r), t: String(x.t) }))
    : [];
  const secureFocused = j.secureFocused === true || /secure/i.test(s(j.focusedRole));
  return {
    ok: j.ok === true,
    error: s(j.error) || undefined,
    app: s(j.app),
    bundleId: s(j.bundleId) || undefined,
    pid: typeof j.pid === "number" ? j.pid : undefined,
    windowId: typeof j.windowId === "number" && j.windowId > 0 ? j.windowId : undefined,
    title: s(j.title) || undefined,
    url: s(j.url) || undefined,
    texts,
    selected: secureFocused ? undefined : s(j.selected) || undefined,
    focusedValue: secureFocused ? undefined : s(j.focusedValue) || undefined,
    focusedRole: s(j.focusedRole) || undefined,
    secureFocused,
    secureSeen: j.secureSeen === true,
    noWindow: j.noWindow === true,
    private: j.private === true,
  };
}

export interface CaptureDeps {
  exec: Exec;
  eveHome: string;
  /** Override the helper binary (tests). */
  helper?: string;
  log?: (...a: unknown[]) => void;
}

export function createCapture(d: CaptureDeps) {
  const bin = join(d.eveHome, "bin");
  const tmp = join(d.eveHome, "tmp");
  let helperPath: string | null = d.helper ?? null;
  let building: Promise<string | null> | null = null;

  /** Compile the helper once per source version. null when swiftc is missing or the build fails. */
  async function helper(): Promise<string | null> {
    if (helperPath) return helperPath;
    if (building) return building;
    building = (async () => {
      if (!existsSync(HELPER_SRC)) return null;
      const out = join(bin, `screen-ax-${hash(readFileSync(HELPER_SRC, "utf8"))}`);
      if (existsSync(out)) return (helperPath = out);
      mkdirSync(bin, { recursive: true });
      d.log?.("compiling the screen helper (once)...");
      const r = await d.exec(["swiftc", "-O", "-o", out, HELPER_SRC], { timeoutMs: 180_000 });
      if (r.code !== 0 || !existsSync(out)) {
        d.log?.(`screen helper build failed: ${(r.stderr || r.stdout).slice(-300)}`);
        return null;
      }
      return (helperPath = out);
    })();
    try {
      return await building;
    } finally {
      building = null;
    }
  }

  async function permissions(): Promise<Permissions> {
    const h = await helper();
    if (!h) return { accessibility: false, screenRecording: null };
    const r = await d.exec([h, "perms"], { timeoutMs: 4000 });
    try {
      const j = JSON.parse(r.stdout.trim()) as { accessibility?: boolean; screenRecording?: boolean };
      return { accessibility: j.accessibility === true, screenRecording: typeof j.screenRecording === "boolean" ? j.screenRecording : null };
    } catch {
      return { accessibility: false, screenRecording: null };
    }
  }

  /** Level 2 read of one window: the frontmost app's focused window, or pid's. */
  async function dump(opts: { pid?: number; maxChars?: number; denyHosts?: string[] } = {}): Promise<AxDump> {
    const h = await helper();
    if (!h) return { ok: false, error: "no helper", app: "", texts: [] };
    const argv = [h, "dump", "--max", String(opts.maxChars ?? 8000)];
    if (opts.pid) argv.push("--pid", String(opts.pid));
    if (opts.denyHosts?.length) argv.push("--deny-hosts", opts.denyHosts.join(","));
    const r = await d.exec(argv, { timeoutMs: 5000, maxBytes: 200_000 });
    if (r.code !== 0 && !r.stdout.trim()) return { ok: false, error: r.timedOut ? "helper timeout" : r.stderr.slice(0, 200) || `exit ${r.code}`, app: "", texts: [] };
    return parseDump(r.stdout);
  }

  /** Remove any leftover capture (a crash mid-look). */
  function sweep(): number {
    let n = 0;
    try {
      for (const f of readdirSync(tmp)) {
        if (!/^screen-.*\.(?:png|jpe?g)$/.test(f)) continue;
        rmSync(join(tmp, f), { force: true });
        n++;
      }
    } catch {}
    return n;
  }

  /**
   * Level 3: capture exactly one window, hand the file to `use`, delete it
   * afterwards no matter what. The path never leaves this function except
   * as the argument to `use`.
   */
  async function withWindowImage<T>(windowId: number, use: (path: string) => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
    if (!Number.isInteger(windowId) || windowId <= 0) return { ok: false, error: "no window id" };
    mkdirSync(tmp, { recursive: true, mode: 0o700 });
    const file = join(tmp, `screen-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.jpg`);
    try {
      const r = await d.exec(["screencapture", "-l", String(windowId), "-x", "-o", "-t", "jpg", file], { timeoutMs: 8000 });
      if (r.code !== 0 || !existsSync(file)) return { ok: false, error: r.stderr.trim().slice(0, 200) || "capture failed (screen recording permission?)" };
      try {
        chmodSync(file, 0o600);
      } catch {}
      if (statSync(file).size < 1000) return { ok: false, error: "empty capture" };
      // Keep the upload small: long side 1280px.
      await d.exec(["sips", "-Z", "1280", file], { timeoutMs: 8000 });
      return { ok: true, value: await use(file) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      rmSync(file, { force: true });
    }
  }

  return { helper, permissions, dump, withWindowImage, sweep, tmpDir: tmp };
}

export type Capture = ReturnType<typeof createCapture>;
