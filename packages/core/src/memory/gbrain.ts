import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/**
 * gbrain: matt's personal knowledge brain (Instagram + Discord history,
 * notes, people pages), reached through its CLI the way jabby does it
 * (~/dev/jabby/src/context-prefetch.ts, fact-writeback.ts). Short-lived
 * `query` / `search` / `get` / `put` calls coexist with a live `gbrain serve`.
 *
 * Nothing here is ever on her reply path: the digest runs in the background,
 * live lookups are fire-and-forget, write-back is batched. See docs/KNOW_ME.md.
 *
 * Measured on matt's Mac (2026-09-26, ~8k pages): `query` (hybrid, embeds the
 * question) p50 6.9s; `search` (keyword) p50 355ms; `get` 200ms.
 */

export interface GbrainHit {
  score: number;
  slug: string;
  text: string;
}

export interface RunResult {
  ok: boolean;
  stdout: string;
  ms: number;
  timedOut?: boolean;
}

/** Runs `gbrain <args>`. Injected in tests; never throws. */
export type GbrainRunner = (args: string[], opts: { timeoutMs: number; stdin?: string }) => Promise<RunResult>;

export function gbrainBin(): string {
  const env = process.env.GBRAIN_BIN?.trim();
  if (env) return env;
  const candidate = join(homedir(), ".bun", "bin", "gbrain");
  return existsSync(candidate) ? candidate : "gbrain";
}

export function gbrainInstalled(bin = gbrainBin()): boolean {
  if (bin.includes("/")) return existsSync(bin);
  return !!Bun.which(bin);
}

/** The real CLI: spawn, hard timeout (SIGTERM, then SIGKILL), stdout as text. */
export function bunRunner(bin = gbrainBin()): GbrainRunner {
  return (args, { timeoutMs, stdin }) =>
    new Promise<RunResult>((resolve) => {
      const t0 = performance.now();
      const ms = () => Math.round(performance.now() - t0);
      let settled = false;
      const done = (r: RunResult) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        proc = Bun.spawn([bin, ...args], { stdin: stdin !== undefined ? "pipe" : "ignore", stdout: "pipe", stderr: "ignore", env: process.env as Record<string, string> });
      } catch {
        return done({ ok: false, stdout: "", ms: ms() });
      }
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGTERM");
        } catch {}
        setTimeout(() => {
          try {
            proc.kill("SIGKILL");
          } catch {}
        }, 1000).unref?.();
        done({ ok: false, stdout: "", ms: ms(), timedOut: true });
      }, timeoutMs);
      timer.unref?.();
      void (async () => {
        try {
          if (stdin !== undefined) {
            const sink = proc.stdin as { write(c: string): unknown; end(): unknown };
            sink.write(stdin);
            await sink.end();
          }
          const stdout = await new Response(proc.stdout as ReadableStream).text();
          await proc.exited;
          clearTimeout(timer);
          done({ ok: (proc.exitCode ?? 1) === 0, stdout, ms: ms() });
        } catch {
          clearTimeout(timer);
          done({ ok: false, stdout: "", ms: ms() });
        }
      })();
    });
}

// "[0.8285] some/slug -- content..." (content may wrap until the next record).
// The leading float keeps warning lines like "[ai.gateway] ..." out.
const RESULT_RE = /\[(\d+\.\d+)\]\s+(\S+)\s+--\s+/g;

export function parseHits(stdout: string, max = 20): GbrainHit[] {
  const matches = [...stdout.matchAll(RESULT_RE)];
  const hits: GbrainHit[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i]!;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1]!.index ?? stdout.length) : stdout.length;
    const text = stdout
      .slice(start, end)
      .replace(/^#+\s*/gm, "")
      .replace(/\s+/g, " ")
      .trim();
    if (text) hits.push({ score: parseFloat(m[1]!), slug: m[2]!, text });
  }
  return hits.slice(0, max);
}

/**
 * Scores aren't calibrated across queries, so keep hits relative to the top
 * one, one per slug, and at most `perPrefix` from one collection (a wall of
 * daily pages can't crowd out the one person page that matters).
 */
export function filterHits(hits: GbrainHit[], o: { relative?: number; perPrefix?: number } = {}): GbrainHit[] {
  if (!hits.length) return [];
  const top = Math.max(...hits.map((h) => h.score));
  const floor = top * (o.relative ?? 0.7);
  const per = new Map<string, number>();
  const seen = new Set<string>();
  const out: GbrainHit[] = [];
  for (const h of [...hits].sort((a, b) => b.score - a.score)) {
    if (h.score < floor || seen.has(h.slug)) continue;
    const prefix = h.slug.includes("/") ? h.slug.slice(0, h.slug.indexOf("/")) : h.slug;
    const n = per.get(prefix) ?? 0;
    if (n >= (o.perPrefix ?? 3)) continue;
    per.set(prefix, n + 1);
    seen.add(h.slug);
    out.push(h);
  }
  return out;
}

export interface GbrainStats {
  queries: number;
  failures: number;
  timeouts: number;
  lastMs?: number;
  lastError?: string;
}

/** Thin typed client over a runner. */
export class GbrainClient {
  stats: GbrainStats = { queries: 0, failures: 0, timeouts: 0 };
  constructor(readonly run: GbrainRunner) {}

  private async hits(args: string[], timeoutMs: number, limit: number): Promise<GbrainHit[] | null> {
    this.stats.queries += 1;
    const r = await this.run(args, { timeoutMs });
    this.stats.lastMs = r.ms;
    if (!r.ok) {
      this.stats.failures += 1;
      if (r.timedOut) this.stats.timeouts += 1;
      this.stats.lastError = r.timedOut ? `timeout after ${timeoutMs}ms` : "gbrain exited non-zero";
      return null;
    }
    return parseHits(r.stdout, limit);
  }

  /** Hybrid (vector + keyword + expansion). Slow: ~7s. Background only. */
  query(q: string, o: { timeoutMs?: number; limit?: number } = {}): Promise<GbrainHit[] | null> {
    const limit = o.limit ?? 8;
    return this.hits(["query", q, "--limit", String(limit), "--detail", "low"], o.timeoutMs ?? 25_000, limit);
  }

  /** Keyword (tsvector). Fast: ~0.35s. Used for live lookups. */
  search(q: string, o: { timeoutMs?: number; limit?: number } = {}): Promise<GbrainHit[] | null> {
    const limit = o.limit ?? 6;
    return this.hits(["search", q, "--limit", String(limit)], o.timeoutMs ?? 2500, limit);
  }

  async get(slug: string, timeoutMs = 10_000): Promise<string> {
    const r = await this.run(["get", slug], { timeoutMs });
    return r.ok ? r.stdout : "";
  }

  /** Write a page (stdin). One retry with backoff if it loses a lock race. */
  async put(slug: string, content: string, timeoutMs = 20_000): Promise<boolean> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await this.run(["put", slug], { timeoutMs, stdin: content });
      if (r.ok) return true;
      await Bun.sleep(400 * (attempt + 1));
    }
    return false;
  }
}
