import type { MemoryRecord } from "@eigenwife/protocol";
import { ZO_WORKSPACE, type ZoService } from "../zo/apps";
import { HomeStore } from "./store";

/**
 * Zo mirror: Eve's state files are copied onto her Zo computer (default
 * /home/workspace/eve, the "eve" folder in the Zo UI) so "she has her own
 * computer" is literally true, and she survives a laptop wipe (restoreFromZo).
 *
 * Writes are debounced and coalesced: a burst of local writes becomes one sync
 * carrying the latest bytes of every dirty file, and a file whose bytes match
 * what Zo already has is skipped. Transport is the shared Zo MCP client
 * (`write_file`, low priority lane, so it never delays a booking). If MCP
 * fails, one POST /zo/ask asks the Zo agent to write the files verbatim.
 * Nothing here throws into the bus: results go to onSync.
 */

export const DEFAULT_ZO_DIR = `${ZO_WORKSPACE}/eve`;

export interface ZoMirrorOptions {
  zo: ZoService;
  remoteDir?: string;
  debounceMs?: number;
  log?: (...args: unknown[]) => void;
  onSync?: (r: ZoSyncResult) => void;
}

export interface ZoSyncResult {
  ok: boolean;
  files: string[];
  skipped?: string[];
  via: "mcp" | "ask" | "none";
  at: number;
  ms?: number;
  error?: string;
}

export class ZoMirror {
  readonly remoteDir: string;
  private debounceMs: number;
  private pending = new Map<string, string>();
  /** Hash of the bytes Zo is known to hold, per file. */
  private pushed = new Map<string, number | bigint>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inflight: Promise<ZoSyncResult> | null = null;
  lastSyncAt: number | undefined;
  lastResult: ZoSyncResult | undefined;
  syncs = 0;

  constructor(private opts: ZoMirrorOptions) {
    this.remoteDir = (opts.remoteDir ?? DEFAULT_ZO_DIR).replace(/\/$/, "");
    this.debounceMs = opts.debounceMs ?? 1500;
  }

  get baseUrl(): string {
    return this.opts.zo.client.baseUrl;
  }

  /** Mark a file dirty with its latest bytes. The sync fires debounceMs after the last call. */
  enqueue(file: string, content: string): void {
    if (!this.pending.has(file) && this.pushed.get(file) === Bun.hash(content)) return;
    this.pending.set(file, content);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** Zo already holds these bytes (e.g. just restored from it): don't push them back. */
  markPushed(file: string, content: string): void {
    this.pushed.set(file, Bun.hash(content));
  }

  dirty(): string[] {
    return [...this.pending.keys()];
  }

  /** Sync everything dirty now. Concurrent calls chain, so no file is dropped. */
  async flush(): Promise<ZoSyncResult> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inflight) await this.inflight.catch(() => {});
    if (this.pending.size === 0) return this.lastResult ?? { ok: true, files: [], via: "none", at: Date.now() };
    const batch = new Map(this.pending);
    this.pending.clear();
    this.inflight = this.push(batch).finally(() => {
      this.inflight = null;
    });
    const r = await this.inflight;
    if (!r.ok) {
      // Keep the failed files dirty unless a newer write already replaced them.
      for (const [f, c] of batch) if (!this.pending.has(f)) this.pending.set(f, c);
    }
    return r;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private async push(batch: Map<string, string>): Promise<ZoSyncResult> {
    const t0 = Date.now();
    const files: string[] = [];
    const skipped: string[] = [];
    const todo = [...batch].filter(([f, c]) => {
      if (this.pushed.get(f) === Bun.hash(c)) {
        skipped.push(f);
        return false;
      }
      files.push(f);
      return true;
    });
    let result: ZoSyncResult;
    let failed: [string, string][] = [];
    for (const [file, content] of todo) {
      const r = await this.opts.zo.writeFile(`${this.remoteDir}/${file}`, content, { priority: "low" });
      if (r.ok) this.pushed.set(file, Bun.hash(content));
      else failed.push([file, content]);
    }
    if (!failed.length) {
      result = { ok: true, files, skipped, via: todo.length ? "mcp" : "none", at: Date.now(), ms: Date.now() - t0 };
    } else {
      this.opts.log?.(`zo write_file failed for ${failed.map(([f]) => f).join(", ")}, falling back to /zo/ask`);
      const parts = failed.map(([f, c]) => `=== ${this.remoteDir}/${f} ===\n${c}`);
      const input =
        `You are Eve's home computer. Create the directory ${this.remoteDir} if needed and write each file below ` +
        `verbatim (overwrite, no edits, no commentary). Reply with just OK when done.\n\n${parts.join("\n\n")}`;
      const a = await this.opts.zo.client.ask(input, { timeoutMs: 60_000 });
      if (a.ok) {
        for (const [f, c] of failed) this.pushed.set(f, Bun.hash(c));
        failed = [];
        result = { ok: true, files, skipped, via: "ask", at: Date.now(), ms: Date.now() - t0 };
      } else result = { ok: false, files, skipped, via: "none", at: Date.now(), ms: Date.now() - t0, error: a.error ?? "zo write failed" };
    }
    this.syncs++;
    this.lastResult = result;
    if (result.ok) this.lastSyncAt = result.at;
    this.opts.onSync?.(result);
    return result;
  }
}

/** Human-readable view of memories.jsonl for the Zo folder (the jsonl stays the source of truth). */
export function memoriesSummary(jsonl: string, max = 60): string {
  const rows = HomeStore.parse("memories.jsonl", jsonl) as MemoryRecord[];
  const top = [...rows]
    .filter((r) => r && typeof r.content === "string")
    .sort((a, b) => (b.importance ?? 0) - (a.importance ?? 0) || (b.createdAt ?? 0) - (a.createdAt ?? 0))
    .slice(0, max);
  const lines = top.map((r) => `- [${r.kind}] ${r.content.replace(/\s+/g, " ").trim()}${r.createdAt ? ` (${new Date(r.createdAt).toISOString().slice(0, 10)})` : ""}`);
  return `# What Eve remembers\n\n${rows.length} memories, top ${top.length} by importance.\n\n${lines.join("\n")}\n`;
}

export interface RestoreResult {
  restored: string[];
  skipped: string[];
  ms: number;
  error?: string;
}

/**
 * Laptop wiped, Zo still has her: pull the mirrored files back into ~/.eve.
 * Only files that parse are written; nothing local is ever overwritten
 * (callers run this only when the local home is empty).
 */
export async function restoreFromZo(zo: ZoService, store: HomeStore, remoteDir: string, files: Iterable<string>, onRestored?: (file: string, body: string) => void): Promise<RestoreResult> {
  const t0 = Date.now();
  const listed = await zo.listDir(remoteDir, { priority: "high" });
  if (!listed.ok) return { restored: [], skipped: [], ms: Date.now() - t0, error: listed.error };
  const have = new Set(listed.value ?? []);
  const wanted = [...files].filter((f) => have.has(f));
  const restored: string[] = [];
  const skipped: string[] = [];
  await Promise.all(
    wanted.map(async (f) => {
      if ((await store.readRaw(f)) !== null) return skipped.push(f);
      const r = await zo.readFile(`${remoteDir}/${f}`, { priority: "high" });
      if (!r.ok || typeof r.value !== "string" || !r.value.trim()) return skipped.push(f);
      try {
        if (f.endsWith(".json")) JSON.parse(r.value);
      } catch {
        return skipped.push(f);
      }
      await store.writeRaw(f, r.value);
      onRestored?.(f, r.value);
      restored.push(f);
    }),
  );
  return { restored, skipped, ms: Date.now() - t0 };
}
