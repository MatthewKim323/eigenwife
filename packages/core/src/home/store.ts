import { mkdir, readFile, rename, unlink, writeFile } from "fs/promises";
import { basename, join } from "path";

/**
 * Eve's files on disk (~/.eve by default). Every write is atomic: the bytes go
 * to a unique temp file in the same directory, then rename() swaps it in, so a
 * crash mid-write leaves either the old file or the new one, never half of
 * each. Writes to the same file are serialized, so the last call always wins.
 *
 * Names map to files: "profile" -> profile.json, "memories.jsonl" stays as is.
 * A .jsonl file holds one JSON value per line and reads back as an array.
 */
export class HomeStore {
  private chains = new Map<string, Promise<void>>();
  private seq = 0;

  constructor(readonly dir: string) {}

  static fileName(name: string): string {
    const n = basename(name);
    return /\.[a-z0-9]+$/i.test(n) ? n : `${n}.json`;
  }

  path(name: string): string {
    return join(this.dir, HomeStore.fileName(name));
  }

  static serialize(name: string, data: unknown): string {
    if (HomeStore.fileName(name).endsWith(".jsonl")) {
      const rows = Array.isArray(data) ? data : [data];
      return rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");
    }
    if (typeof data === "string" && !HomeStore.fileName(name).endsWith(".json")) return data;
    return JSON.stringify(data, null, 2) + "\n";
  }

  static parse(name: string, raw: string): unknown {
    const file = HomeStore.fileName(name);
    if (file.endsWith(".jsonl")) {
      const out: unknown[] = [];
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        try {
          out.push(JSON.parse(line));
        } catch {
          // A torn last line (should not happen with atomic writes) is skipped, not fatal.
        }
      }
      return out;
    }
    if (file.endsWith(".json")) return JSON.parse(raw);
    return raw;
  }

  async read<T>(name: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(this.path(name), "utf8");
      return HomeStore.parse(name, raw) as T;
    } catch {
      return fallback;
    }
  }

  async readRaw(name: string): Promise<string | null> {
    try {
      return await readFile(this.path(name), "utf8");
    } catch {
      return null;
    }
  }

  /** Atomic write. Resolves with the exact bytes written (the Zo mirror reuses them). */
  write(name: string, data: unknown): Promise<string> {
    return this.writeRaw(name, HomeStore.serialize(name, data));
  }

  /** Atomic write of exact bytes (used when restoring files from Zo). */
  writeRaw(name: string, body: string): Promise<string> {
    const file = this.path(name);
    const prev = this.chains.get(file) ?? Promise.resolve();
    const next = prev.then(async () => {
      await mkdir(this.dir, { recursive: true });
      const tmp = `${file}.${process.pid}.${++this.seq}.tmp`;
      try {
        await writeFile(tmp, body, "utf8");
        await rename(tmp, file);
      } catch (err) {
        await unlink(tmp).catch(() => {});
        throw err;
      }
    });
    const settled = next.catch(() => {});
    this.chains.set(file, settled);
    settled.then(() => {
      if (this.chains.get(file) === settled) this.chains.delete(file);
    });
    return next.then(() => body);
  }

  async remove(name: string): Promise<void> {
    await unlink(this.path(name)).catch(() => {});
  }

  /** Wait for every pending write. */
  async flush(): Promise<void> {
    await Promise.all([...this.chains.values()]);
  }
}
