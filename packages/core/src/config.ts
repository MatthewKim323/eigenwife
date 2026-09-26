import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/** Repo root, independent of the cwd the core was launched from. */
export const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
export const JABBY_DIR = process.env.JABBY_DIR ?? join(homedir(), "dev", "jabby");

export function parseDotEnv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]!] = v;
  }
  return out;
}

/**
 * Secrets resolve from, in order: the process env, eigenwife/.env,
 * eigenwife/.env.local, then jabby's own secrets file. Jabby is the brain, so
 * anything already wired for it (keys, voice ids) works here for free.
 */
function loadEnvFiles(): Record<string, string> {
  const files = [join(REPO_ROOT, ".env.local"), join(REPO_ROOT, ".env"), join(JABBY_DIR, ".claude", "jabby", ".env")];
  const out: Record<string, string> = {};
  for (const f of files) {
    if (!existsSync(f)) continue;
    try {
      for (const [k, v] of Object.entries(parseDotEnv(readFileSync(f, "utf8")))) if (!(k in out)) out[k] = v;
    } catch {}
  }
  return out;
}

let fileEnv: Record<string, string> | null = null;

export function secret(name: string): string {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  fileEnv ??= loadEnvFiles();
  return (fileEnv[name] ?? "").trim();
}

export function has(name: string): boolean {
  return secret(name).length > 0;
}

export interface CoreConfig {
  port: number;
  host: string;
  eveHome: string;
  jabbyUrl: string;
  eyeUrl: string;
  /** Demo mode: seeded memories, pre-rendered lines, deterministic fallbacks. */
  demo: boolean;
}

export function loadConfig(overrides: Partial<CoreConfig> = {}): CoreConfig {
  return {
    port: Number(secret("EIGEN_PORT") || 7777),
    host: secret("EIGEN_HOST") || "127.0.0.1",
    eveHome: secret("EVE_HOME") || join(homedir(), ".eve"),
    jabbyUrl: secret("JABBY_URL") || "http://127.0.0.1:4632",
    eyeUrl: secret("EYE_URL") || "ws://127.0.0.1:8765/ws",
    demo: secret("EIGEN_DEMO") !== "0",
    ...overrides,
  };
}
