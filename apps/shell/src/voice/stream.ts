import type { SpeechMark } from "@eigenwife/protocol";

/**
 * Pure pieces of streamed playback (no Web Audio here, so they test in bun):
 * a download that many readers can follow while it runs, WAV header parsing
 * and PCM conversion for Aura's streaming wav, and mark timing against
 * playback time when the segment's length isn't known yet.
 */

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Starts downloading at construction and keeps every chunk, so the next
 * segment's bytes are already here when its turn comes, and a failed
 * streaming start can still fall back to decoding the whole file.
 */
export class ChunkBuffer {
  readonly chunks: Uint8Array[] = [];
  done = false;
  error: unknown = null;
  bytes = 0;
  private wake = new Set<() => void>();

  constructor(
    readonly url: string,
    private signal: AbortSignal,
    fetchFn: Fetch = (u, i) => fetch(u, i),
  ) {
    void this.run(fetchFn);
  }

  private async run(fetchFn: Fetch) {
    try {
      const res = await fetchFn(this.url, { signal: this.signal });
      if (!res.ok) throw new Error(`audio ${res.status}`);
      if (!res.body) this.add(new Uint8Array(await res.arrayBuffer()));
      else {
        const r = res.body.getReader();
        for (;;) {
          const { done, value } = await r.read();
          if (done) break;
          if (value?.byteLength) this.add(value);
        }
      }
    } catch (err) {
      this.error = err ?? new Error("audio fetch failed");
    }
    this.done = true;
    this.ping();
  }

  private add(c: Uint8Array) {
    this.chunks.push(c);
    this.bytes += c.byteLength;
    this.ping();
  }

  private ping() {
    for (const w of [...this.wake]) w();
  }

  private waitChange(): Promise<void> {
    return new Promise((r) => {
      const w = () => {
        this.wake.delete(w);
        r();
      };
      this.wake.add(w);
    });
  }

  /** Every chunk from the start, following the download; throws if it failed. */
  async *read(): AsyncGenerator<Uint8Array> {
    let i = 0;
    for (;;) {
      if (i < this.chunks.length) {
        yield this.chunks[i++]!;
        continue;
      }
      if (this.error) throw this.error;
      if (this.done) return;
      await this.waitChange();
    }
  }

  /** Resolves once at least n bytes are in (or the download ended). */
  async atLeast(n: number): Promise<void> {
    while (this.bytes < n && !this.done) await this.waitChange();
    if (this.bytes === 0 && this.error) throw this.error;
  }

  /** The whole file, once downloaded. */
  async all(): Promise<ArrayBuffer> {
    while (!this.done) await this.waitChange();
    if (this.error && !this.bytes) throw this.error;
    return concatBytes(this.chunks).buffer as ArrayBuffer;
  }
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export interface WavFormat {
  sampleRate: number;
  channels: number;
  bits: number;
  /** Byte offset of the first sample. */
  dataOffset: number;
}

/** Parse a RIFF/WAVE header (PCM only). null when it isn't one or isn't complete yet. */
export function parseWav(b: Uint8Array): WavFormat | null {
  if (b.byteLength < 12) return null;
  const tag = (o: number) => String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 12;
  let fmt: Omit<WavFormat, "dataOffset"> | null = null;
  while (o + 8 <= b.byteLength) {
    const id = tag(o);
    const size = v.getUint32(o + 4, true);
    if (id === "fmt ") {
      if (o + 8 + 16 > b.byteLength) return null;
      if (v.getUint16(o + 8, true) !== 1) return null; // PCM only
      fmt = { channels: v.getUint16(o + 10, true), sampleRate: v.getUint32(o + 12, true), bits: v.getUint16(o + 22, true) };
    } else if (id === "data") {
      return fmt ? { ...fmt, dataOffset: o + 8 } : null;
    }
    o += 8 + size + (size % 2);
  }
  return null;
}

/**
 * 16-bit little-endian PCM bytes -> float samples per channel, carrying an odd
 * trailing byte (or partial frame) over to the next chunk.
 */
export class PcmDecoder {
  private carry = new Uint8Array(0);
  constructor(private channels = 1) {}

  push(chunk: Uint8Array): Float32Array[] {
    const b = this.carry.byteLength ? concatBytes([this.carry, chunk]) : chunk;
    const frame = 2 * this.channels;
    const usable = b.byteLength - (b.byteLength % frame);
    this.carry = b.slice(usable);
    const frames = usable / frame;
    const out = Array.from({ length: this.channels }, () => new Float32Array(frames));
    const v = new DataView(b.buffer, b.byteOffset, usable);
    for (let i = 0; i < frames; i++) for (let c = 0; c < this.channels; c++) out[c]![i] = v.getInt16((i * this.channels + c) * 2, true) / 32768;
    return out;
  }
}

/**
 * How fast her voice speaks, learned from segments whose length we saw.
 * Streamed segments don't know their duration until they end, so marks and
 * subtitles are timed against text length at this rate meanwhile.
 */
export class SpeechRate {
  constructor(public msPerChar = 65) {}
  estimate(text: string): number {
    return Math.max(300, text.length * this.msPerChar);
  }
  learn(text: string, durationMs: number) {
    if (text.length < 8 || !(durationMs > 200)) return;
    const r = Math.min(140, Math.max(30, durationMs / text.length));
    this.msPerChar = this.msPerChar * 0.7 + r * 0.3;
  }
}

/**
 * Marks fired by playback position: a mark at char offset `at` fires once the
 * audio has played at/len of the segment. The length is the real duration
 * when known, else the text-based estimate. Each mark fires exactly once.
 */
export class TimedMarks {
  private left: SpeechMark[];
  constructor(
    private text: string,
    marks: SpeechMark[],
    private estimateMs: number,
  ) {
    this.left = [...marks].sort((a, b) => a.at - b.at);
  }

  at(mark: SpeechMark, durationMs: number | null): number {
    const len = Math.max(1, this.text.length);
    return Math.max(0, Math.min(1, mark.at / len)) * (durationMs ?? this.estimateMs);
  }

  /** Marks due at playback time tMs. */
  due(tMs: number, durationMs: number | null): SpeechMark[] {
    const out: SpeechMark[] = [];
    while (this.left.length && this.at(this.left[0]!, durationMs) <= tMs) out.push(this.left.shift()!);
    return out;
  }

  /** Whatever is left (the segment ended). */
  rest(): SpeechMark[] {
    return this.left.splice(0);
  }
}
