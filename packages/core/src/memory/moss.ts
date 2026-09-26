import type { MemoryRecord } from "@eigenwife/protocol";

/**
 * Moss adapter (hippocampus). Long-term memories are mirrored into a Moss
 * index; recall asks Moss first and merges its scores with the local store.
 *
 * Verified 2026-09-26: @moss-js/moss 1.14 (with its native moss-core binding)
 * imports and runs under Bun on darwin-arm64 and reaches the Moss control
 * plane. Queries run in-process on a loaded index (~1-10 ms, never metered).
 *
 * Read-after-write: a loaded index does not see addDocs until it is reloaded,
 * so writes schedule a debounced reload. Between the write and the reload the
 * local store still has the record, so nothing is ever missing from recall.
 * We query with alpha = 1.0 (pure embedding), which the SDK documents as raw
 * cosine scores, so Moss scores drop straight into the retrieval formula.
 */

export interface MossHit {
  id: string;
  score: number;
}

export interface MossLike {
  readonly name: string;
  ready(): boolean;
  upsert(records: MemoryRecord[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  query(text: string, topK: number): Promise<MossHit[]>;
  close(): Promise<void>;
}

interface MossClientShape {
  listIndexes(): Promise<{ name: string }[]>;
  createIndex(name: string, docs: MossDoc[], opts?: { modelId?: string }): Promise<unknown>;
  addDocs(name: string, docs: MossDoc[], opts?: { upsert?: boolean }): Promise<unknown>;
  deleteDocs(name: string, ids: string[]): Promise<unknown>;
  loadIndex(name: string, opts?: { autoRefresh?: boolean; pollingIntervalInSeconds?: number; cachePath?: string }): Promise<string>;
  query(name: string, text: string, opts?: { topK?: number; alpha?: number }): Promise<{ docs: { id: string; score: number }[] }>;
  close(): Promise<void>;
}

interface MossDoc {
  id: string;
  text: string;
  metadata?: Record<string, string>;
}

export function toMossDoc(r: MemoryRecord): MossDoc {
  return {
    id: r.id,
    text: r.content,
    metadata: {
      kind: r.kind,
      source: r.source,
      importance: r.importance.toFixed(3),
      createdAt: String(r.createdAt),
    },
  };
}

export interface MossAdapterOptions {
  projectId: string;
  projectKey: string;
  index?: string;
  cachePath?: string;
  log?: (...a: unknown[]) => void;
  /** Injected client for tests; defaults to a real MossClient. */
  client?: MossClientShape;
  reloadDebounceMs?: number;
}

export class MossAdapter implements MossLike {
  readonly name: string;
  private client: MossClientShape | null = null;
  private loaded = false;
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSync: MemoryRecord[] = [];
  lastError: string | undefined;

  constructor(private opts: MossAdapterOptions) {
    this.name = opts.index ?? "eve-memories";
  }

  ready(): boolean {
    return this.loaded;
  }

  /** Connect, make sure the index exists with every current record, load it locally. */
  async init(records: MemoryRecord[]): Promise<boolean> {
    try {
      if (this.opts.client) this.client = this.opts.client;
      else {
        const mod = (await import("@moss-js/moss")) as unknown as { MossClient: new (id: string, key: string) => MossClientShape };
        this.client = new mod.MossClient(this.opts.projectId, this.opts.projectKey);
      }
      const c = this.client;
      const existing = await c.listIndexes();
      const docs = records.map(toMossDoc);
      if (!existing.some((i) => i.name === this.name)) {
        const initial = docs.length ? docs : [{ id: "eve_genesis", text: "Eve was born", metadata: { kind: "fact" } }];
        await c.createIndex(this.name, initial, { modelId: "moss-minilm" });
      } else if (docs.length) {
        await c.addDocs(this.name, docs, { upsert: true });
      }
      await c.loadIndex(this.name, { cachePath: this.opts.cachePath });
      this.loaded = true;
      if (this.pendingSync.length) {
        const queued = this.pendingSync.splice(0);
        await this.upsert(queued);
      }
      this.opts.log?.(`moss index "${this.name}" loaded (${docs.length} docs)`);
      return true;
    } catch (err) {
      this.lastError = String(err);
      this.opts.log?.("moss unavailable, local memory only:", this.lastError);
      return false;
    }
  }

  async upsert(records: MemoryRecord[]): Promise<void> {
    if (!records.length) return;
    if (!this.client || !this.loaded) {
      this.pendingSync.push(...records);
      return;
    }
    try {
      await this.client.addDocs(this.name, records.map(toMossDoc), { upsert: true });
      this.scheduleReload();
    } catch (err) {
      this.lastError = String(err);
    }
  }

  async remove(ids: string[]): Promise<void> {
    if (!this.client || !this.loaded || !ids.length) return;
    try {
      await this.client.deleteDocs(this.name, ids);
      this.scheduleReload();
    } catch (err) {
      this.lastError = String(err);
    }
  }

  async query(text: string, topK: number): Promise<MossHit[]> {
    if (!this.client || !this.loaded) return [];
    const r = await this.client.query(this.name, text, { topK, alpha: 1.0 });
    return r.docs.map((d) => ({ id: d.id, score: d.score }));
  }

  private scheduleReload(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(() => {
      this.reloadTimer = null;
      this.client?.loadIndex(this.name, { cachePath: this.opts.cachePath }).catch((e) => (this.lastError = String(e)));
    }, this.opts.reloadDebounceMs ?? 3000);
  }

  async close(): Promise<void> {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    await this.client?.close().catch(() => {});
    this.loaded = false;
  }
}
