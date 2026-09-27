/**
 * Streaming TTS over prewarmed websockets. One socket per backend, opened
 * before she needs it (at boot and whenever he starts talking), so a line's
 * first audio skips the TLS + HTTP setup. Each call resolves with the whole
 * segment's bytes (the unit the cache keeps), and an optional onChunk sees
 * the audio as it arrives (the live route streams it to the shell).
 *
 *   ElevenLabs  wss://api.elevenlabs.io/v1/text-to-speech/{voice}/multi-stream-input
 *               one context per segment, many in flight on one socket, mp3
 *   Deepgram    wss://api.deepgram.com/v1/speak (Aura-2), Speak + Flush per
 *               segment, one at a time per socket, linear16 wrapped as wav
 *
 * Any socket trouble throws, and the backend falls back to plain HTTP.
 */

export interface TtsSocket {
  readyState: number;
  binaryType?: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type SocketFactory = (url: string, headers: Record<string, string>) => TtsSocket;

export const bunSocket: SocketFactory = (url, headers) => new WebSocket(url, { headers } as never) as unknown as TtsSocket;

const OPEN = 1;

function b64(s: string): Uint8Array {
  return Uint8Array.from(Buffer.from(s, "base64"));
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.byteLength, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

/** 16-bit mono PCM -> a WAV file. */
export function wav(pcm: Uint8Array, sampleRate: number): Uint8Array {
  return concat([wavHeader(sampleRate, pcm.byteLength), pcm]);
}

/** A 44-byte WAV header. No length (streaming): both sizes are 0xFFFFFFFF. */
export function wavHeader(sampleRate: number, dataBytes?: number): Uint8Array {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, "RIFF");
  h.setUint32(4, dataBytes === undefined ? 0xffffffff : 36 + dataBytes, true);
  w(8, "WAVE");
  w(12, "fmt ");
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, sampleRate, true);
  h.setUint32(28, sampleRate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, "data");
  h.setUint32(40, dataBytes === undefined ? 0xffffffff : dataBytes, true);
  return new Uint8Array(h.buffer);
}

/** A lazily (re)opened socket with an open() that resolves when usable. */
class Lazy {
  sock: TtsSocket | null = null;
  private opening: Promise<TtsSocket> | null = null;
  onMessage: (data: unknown) => void = () => {};
  onClosed: (why: string) => void = () => {};
  opens = 0;

  constructor(
    private url: () => string,
    private headers: () => Record<string, string>,
    private factory: SocketFactory,
    private openTimeoutMs = 3000,
  ) {}

  get ready() {
    return this.sock?.readyState === OPEN;
  }

  open(): Promise<TtsSocket> {
    if (this.sock && this.sock.readyState === OPEN) return Promise.resolve(this.sock);
    if (this.opening) return this.opening;
    this.opening = new Promise<TtsSocket>((resolve, reject) => {
      let s: TtsSocket;
      try {
        s = this.factory(this.url(), this.headers());
      } catch (err) {
        this.opening = null;
        return reject(err);
      }
      this.opens++;
      try {
        s.binaryType = "arraybuffer";
      } catch {}
      const timer = setTimeout(() => {
        this.opening = null;
        try {
          s.close();
        } catch {}
        reject(new Error("tts socket: open timeout"));
      }, this.openTimeoutMs);
      s.onopen = () => {
        clearTimeout(timer);
        this.sock = s;
        this.opening = null;
        resolve(s);
      };
      s.onmessage = (ev) => {
        if (this.sock === s) this.onMessage(ev.data);
      };
      s.onerror = () => {};
      s.onclose = (ev) => {
        clearTimeout(timer);
        if (this.opening && this.sock !== s) {
          this.opening = null;
          reject(new Error(`tts socket closed before open: ${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim()));
        }
        if (this.sock === s) {
          this.sock = null;
          this.onClosed(`${ev?.code ?? ""} ${ev?.reason ?? ""}`.trim() || "closed");
        }
      };
    });
    return this.opening;
  }

  send(o: unknown) {
    if (!this.sock || this.sock.readyState !== OPEN) throw new Error("tts socket: not open");
    this.sock.send(JSON.stringify(o));
  }

  close() {
    const s = this.sock;
    this.sock = null;
    try {
      s?.close(1000, "bye");
    } catch {}
  }
}

export type ChunkSink = (chunk: Uint8Array, ext: "mp3" | "wav") => void;

export interface StreamingSynth {
  /** Open the socket now if it isn't (cheap when already open). */
  warm(): void;
  /** onChunk: playable bytes as they arrive (wav: a streaming header first, then pcm). */
  synth(text: string, signal?: AbortSignal, onChunk?: ChunkSink): Promise<{ bytes: Uint8Array; ext: "mp3" | "wav"; firstChunkMs: number }>;
  close(): void;
  ready(): boolean;
}

// ---------------------------------------------------------------------------
// ElevenLabs multi-context
// ---------------------------------------------------------------------------

export interface ElevenSocketOpts {
  key: () => string;
  voice: () => string;
  model: () => string;
  settings: () => Record<string, unknown>;
  factory?: SocketFactory;
  now?: () => number;
  timeoutMs?: number;
}

export function elevenStream(o: ElevenSocketOpts): StreamingSynth {
  const now = o.now ?? Date.now;
  const url = () =>
    `wss://api.elevenlabs.io/v1/text-to-speech/${o.voice()}/multi-stream-input?model_id=${encodeURIComponent(o.model())}&output_format=mp3_44100_128&inactivity_timeout=180`;
  const lazy = new Lazy(url, () => ({ "xi-api-key": o.key() }), o.factory ?? bunSocket);
  const pending = new Map<string, { parts: Uint8Array[]; resolve: (b: Uint8Array) => void; reject: (e: Error) => void; first: number; sink?: ChunkSink }>();
  let seq = 0;
  lazy.onMessage = (data) => {
    let m: { audio?: string | null; isFinal?: boolean; is_final?: boolean; contextId?: string; context_id?: string; error?: string; message?: string };
    try {
      m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    const id = m.contextId ?? m.context_id;
    if (!id) {
      if (m.error || m.message) for (const p of pending.values()) p.reject(new Error(`elevenlabs ws: ${m.error ?? m.message}`));
      return;
    }
    const p = pending.get(id);
    if (!p) return;
    if (m.audio) {
      if (p.first < 0) p.first = now();
      const chunk = b64(m.audio);
      p.parts.push(chunk);
      p.sink?.(chunk, "mp3");
    }
    if (m.isFinal || m.is_final) {
      pending.delete(id);
      p.resolve(concat(p.parts));
    }
  };
  lazy.onClosed = (why) => {
    for (const [id, p] of pending) {
      pending.delete(id);
      p.reject(new Error(`elevenlabs ws closed: ${why}`));
    }
  };
  return {
    warm: () => void lazy.open().catch(() => {}),
    ready: () => lazy.ready,
    close: () => lazy.close(),
    async synth(text, signal, onChunk) {
      const t0 = now();
      await lazy.open();
      const id = `c${++seq}_${Math.random().toString(36).slice(2, 7)}`;
      const entry = { parts: [] as Uint8Array[], resolve: (_: Uint8Array) => {}, reject: (_: Error) => {}, first: -1, sink: onChunk };
      const done = new Promise<Uint8Array>((resolve, reject) => {
        entry.resolve = resolve;
        entry.reject = reject;
      });
      pending.set(id, entry);
      const timer = setTimeout(() => entry.reject(new Error("elevenlabs ws: timeout")), o.timeoutMs ?? 10_000);
      const onAbort = () => entry.reject(new Error("aborted"));
      signal?.addEventListener("abort", onAbort, { once: true });
      try {
        lazy.send({ text: " ", context_id: id, voice_settings: o.settings() });
        lazy.send({ text: `${text} `, context_id: id, flush: true });
        lazy.send({ context_id: id, close_context: true });
        const bytes = await done;
        if (bytes.byteLength < 64) throw new Error("elevenlabs ws: empty audio");
        return { bytes, ext: "mp3" as const, firstChunkMs: entry.first >= 0 ? entry.first - t0 : now() - t0 };
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending.delete(id);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Deepgram Aura-2
// ---------------------------------------------------------------------------

export interface AuraSocketOpts {
  key: () => string;
  voice: () => string;
  sampleRate?: number;
  factory?: SocketFactory;
  now?: () => number;
  timeoutMs?: number;
}

export function auraStream(o: AuraSocketOpts): StreamingSynth {
  const now = o.now ?? Date.now;
  const rate = o.sampleRate ?? 24000;
  const url = () => `wss://api.deepgram.com/v1/speak?model=${encodeURIComponent(o.voice())}&encoding=linear16&sample_rate=${rate}`;
  const lazy = new Lazy(url, () => ({ Authorization: `Token ${o.key()}` }), o.factory ?? bunSocket);
  // Aura speaks one flush at a time per socket: segments queue.
  let chain: Promise<unknown> = Promise.resolve();
  let cur: { parts: Uint8Array[]; resolve: (b: Uint8Array) => void; reject: (e: Error) => void; first: number; sink?: ChunkSink; sent?: boolean } | null = null;
  lazy.onMessage = (data) => {
    if (!cur) return;
    if (typeof data !== "string") {
      const chunk = new Uint8Array(data as ArrayBuffer);
      if (cur.first < 0) cur.first = now();
      if (cur.sink && chunk.byteLength) {
        // The live stream is a wav with no length yet: header first, then pcm as it comes.
        cur.sink(cur.sent ? chunk : concat([wavHeader(rate), chunk]), "wav");
        cur.sent = true;
      }
      cur.parts.push(chunk);
      return;
    }
    let m: { type?: string; description?: string; err_msg?: string };
    try {
      m = JSON.parse(data);
    } catch {
      return;
    }
    if (m.type === "Flushed") {
      const c = cur;
      cur = null;
      c.resolve(concat(c.parts));
    } else if (m.type === "Error" || m.type === "Warning" || m.err_msg) {
      if (m.type !== "Warning") cur.reject(new Error(`deepgram ws: ${m.description ?? m.err_msg ?? m.type}`));
    }
  };
  lazy.onClosed = (why) => {
    cur?.reject(new Error(`deepgram ws closed: ${why}`));
    cur = null;
  };
  const one = async (text: string, signal?: AbortSignal, sink?: ChunkSink) => {
    const t0 = now();
    await lazy.open();
    if (signal?.aborted) throw new Error("aborted");
    const entry = { parts: [] as Uint8Array[], resolve: (_: Uint8Array) => {}, reject: (_: Error) => {}, first: -1, sink };
    const done = new Promise<Uint8Array>((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    cur = entry;
    const timer = setTimeout(() => entry.reject(new Error("deepgram ws: timeout")), o.timeoutMs ?? 10_000);
    try {
      lazy.send({ type: "Speak", text });
      lazy.send({ type: "Flush" });
      const pcm = await done;
      if (pcm.byteLength < 64) throw new Error("deepgram ws: empty audio");
      return { bytes: wav(pcm, rate), ext: "wav" as const, firstChunkMs: entry.first >= 0 ? entry.first - t0 : now() - t0 };
    } catch (err) {
      // A half-read flush poisons the socket's ordering: start clean next time.
      if (cur === entry) cur = null;
      lazy.close();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    warm: () => void lazy.open().catch(() => {}),
    ready: () => lazy.ready,
    close: () => lazy.close(),
    synth(text, signal, onChunk) {
      const run = chain.then(() => one(text, signal, onChunk));
      chain = run.catch(() => {});
      return run;
    },
  };
}
