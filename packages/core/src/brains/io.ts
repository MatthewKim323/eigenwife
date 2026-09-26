import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * The IO seams every brain backend goes through. Tests swap these for fakes,
 * so nothing in bun test ever touches the network or spawns a CLI.
 */

export interface ProcHandle {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill(signal?: number | NodeJS.Signals): void;
}

export interface SpawnOpts {
  cwd?: string;
  env?: Record<string, string>;
  /** Written to stdin, then closed. Omit for no stdin. */
  stdin?: string;
}

export type Spawner = (argv: string[], opts?: SpawnOpts) => ProcHandle;
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export interface BrainIO {
  fetch: Fetcher;
  spawn: Spawner;
  /** Resolve a secret by name ("" when missing). */
  secret(name: string): string;
  /** Absolute path of a CLI, or null when it isn't installed. */
  which(bin: string): string | null;
  /** Scratch dir for CLI runs (created on demand). */
  workDir: string;
  now(): number;
}

export const bunSpawn: Spawner = (argv, opts = {}) => {
  const p = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin !== undefined ? new Blob([opts.stdin]) : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: p.stdout,
    stderr: p.stderr,
    exited: p.exited,
    kill: (sig) => {
      try {
        p.kill(sig as number | undefined);
      } catch {}
    },
  };
};

/**
 * launchd and some shells run with a bare PATH, so look in the usual install
 * spots before trusting PATH (same idea as jabby's resolveCodexBin).
 */
export function whichBin(bin: string, home = homedir()): string | null {
  const envOverride = process.env[`${bin.toUpperCase()}_BIN`];
  const candidates = [
    envOverride,
    join(home, ".local", "bin", bin),
    join(home, ".bun", "bin", bin),
    join(home, ".claude", "local", bin),
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return Bun.which(bin) ?? null;
}

/**
 * Env for a spawned claude CLI: strip the vars that break detached
 * subscription auth when we're launched from inside another Claude session.
 * Exactly jabby's brainEnv() list (src/voice/brain.ts).
 */
export function cliEnv(base: Record<string, string | undefined> = process.env): Record<string, string> {
  const stripped = new Set(["CLAUDECODE", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST", "GH_TOKEN", "GITHUB_TOKEN"]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (stripped.has(k) || k.startsWith("CLAUDE_CODE_ENTRYPOINT")) continue;
    if (typeof v === "string") out[k] = v;
  }
  // launchd PATH is bare; make sure node/bun shims the CLIs need resolve.
  const extra = [join(homedir(), ".local", "bin"), join(homedir(), ".bun", "bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  out.PATH = [...new Set([...(out.PATH ?? "/usr/bin:/bin").split(":"), ...extra])].join(":");
  return out;
}

/** Split a byte stream into trimmed non-empty lines. */
export async function* readLines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const dec = new TextDecoder();
  let buf = "";
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) yield line;
      }
    }
    buf += dec.decode();
  } finally {
    try {
      reader.releaseLock();
    } catch {}
  }
  if (buf.trim()) yield buf.trim();
}

/** Parse an SSE body into its `data:` payloads (one per event, "[DONE]" included). */
export async function* sseData(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  for await (const line of readLines(body)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload) yield payload;
  }
}

export class HttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    where: string,
  ) {
    super(`${where} http ${status}: ${body.slice(0, 240)}`);
    this.name = "HttpError";
  }
}

/** Kill a process after ms (SIGTERM, then SIGKILL) and on abort. Returns a disposer. */
export function killAfter(proc: ProcHandle, ms: number, signal?: AbortSignal): () => void {
  let hard: ReturnType<typeof setTimeout> | undefined;
  const kill = () => {
    proc.kill("SIGTERM");
    hard = setTimeout(() => proc.kill("SIGKILL"), 1500);
    (hard as { unref?: () => void }).unref?.();
  };
  const timer = setTimeout(kill, ms);
  (timer as { unref?: () => void }).unref?.();
  signal?.addEventListener("abort", kill, { once: true });
  if (signal?.aborted) kill();
  return () => {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  };
}

/** Merge an optional caller signal with a timeout. */
export function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([t, signal]) : t;
}

export async function drainText(stream: ReadableStream<Uint8Array>): Promise<string> {
  try {
    return await new Response(stream).text();
  } catch {
    return "";
  }
}
