import type { AudioExt } from "./tts";

/**
 * Live audio: a segment's bytes as they arrive from the TTS backend, served
 * at GET /api/audio/live/<id>.<ext> while synthesis is still running. Every
 * reader gets the chunks seen so far, then follows new ones until the stream
 * ends. Finished streams stay readable for a while (a late reader or a replay
 * still gets the whole thing); after that the route serves the cached file
 * by its content hash.
 */

export const LIVE_NAME_RE = /^live\/([a-z0-9_]{6,40})\.(mp3|m4a|wav)$/;

interface Entry {
  id: string;
  sha: string;
  ext: AudioExt;
  chunks: Uint8Array[];
  done: boolean;
  failed: boolean;
  endedAt: number;
  wake: Set<() => void>;
}

export class LiveStreams {
  private map = new Map<string, Entry>();
  /** Expired ids -> content hash, so an old live url still finds the cached file. */
  private gone = new Map<string, { sha: string; ext: AudioExt }>();
  private seq = 0;
  constructor(
    private now: () => number = Date.now,
    /** How long a finished stream stays in memory. */
    private keepMs = 60_000,
  ) {}

  /** Start a live stream for audio that will be cached under `sha`. */
  open(sha: string, ext: AudioExt): LiveWriter {
    this.sweep();
    const id = `l${(++this.seq).toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const e: Entry = { id, sha, ext, chunks: [], done: false, failed: false, endedAt: 0, wake: new Set() };
    this.map.set(id, e);
    const ping = () => {
      for (const w of [...e.wake]) w();
    };
    return {
      id,
      url: `/api/audio/live/${id}.${ext}`,
      push: (chunk) => {
        if (e.done || !chunk.byteLength) return;
        e.chunks.push(chunk);
        ping();
      },
      end: (failed = false) => {
        if (e.done) return;
        e.done = true;
        e.failed = failed;
        e.endedAt = this.now();
        ping();
      },
    };
  }

  /** A live id's stream state; expired ones report only their content hash (serve the cached file). */
  info(id: string): { sha: string; ext: AudioExt; live: boolean; done: boolean; bytes: number } | null {
    const e = this.map.get(id);
    if (e) return { sha: e.sha, ext: e.ext, live: true, done: e.done, bytes: e.chunks.reduce((n, c) => n + c.byteLength, 0) };
    const g = this.gone.get(id);
    return g ? { ...g, live: false, done: true, bytes: 0 } : null;
  }

  /** A body that replays what has arrived, then follows the stream to its end. */
  body(id: string, signal?: AbortSignal): ReadableStream<Uint8Array> | null {
    const e = this.map.get(id);
    if (!e) return null;
    let i = 0;
    let wake: (() => void) | null = null;
    return new ReadableStream<Uint8Array>({
      pull: async (ctl) => {
        for (;;) {
          if (signal?.aborted) return ctl.close();
          if (i < e.chunks.length) return ctl.enqueue(e.chunks[i++]!);
          if (e.done) return ctl.close();
          await new Promise<void>((r) => {
            wake = () => {
              if (wake) e.wake.delete(wake);
              wake = null;
              r();
            };
            e.wake.add(wake);
          });
        }
      },
      cancel: () => {
        if (wake) e.wake.delete(wake);
        wake = null;
      },
    });
  }

  get size(): number {
    return this.map.size;
  }

  private sweep() {
    const t = this.now();
    for (const [id, e] of this.map) {
      if (!e.done || t - e.endedAt <= this.keepMs) continue;
      this.map.delete(id);
      if (!e.failed) this.gone.set(id, { sha: e.sha, ext: e.ext });
    }
    while (this.gone.size > 5000) this.gone.delete(this.gone.keys().next().value!);
  }
}

export interface LiveWriter {
  id: string;
  /** Relative URL the shell resolves against the core origin. */
  url: string;
  push(chunk: Uint8Array): void;
  /** No more bytes. failed: the backend died mid-segment (readers just see the end). */
  end(failed?: boolean): void;
}
