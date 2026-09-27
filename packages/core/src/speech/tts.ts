import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { HealthBook } from "../brains/health";
import { drainText, HttpError, type Fetcher, type Spawner } from "../brains/io";
import { LiveStreams, type LiveWriter } from "./live";
import { auraStream, elevenStream, type ChunkSink, type SocketFactory, type StreamingSynth } from "./sockets";

/**
 * Text to speech with a content-hash disk cache.
 *
 *   deepgram     Aura-2, ~300ms to first byte (DEEPGRAM_API_KEY, EVE_DEEPGRAM_VOICE)
 *   openai       gpt-4o-mini-tts, voice + `instructions` (OPENAI_API_KEY)
 *   elevenlabs   eleven_flash_v2_5 (ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID)
 *   say          macOS `say` + ffmpeg to mp3, zero keys, always there on a Mac
 *
 * Files live at <eveHome>/audio/<sha256(voiceKey + text)>.<ext> and are served
 * by the speech module at GET /api/audio/<sha>.<ext>. A cache lookup checks
 * every backend's key in preference order, so a line prerendered with OpenAI
 * keeps its good voice even when OpenAI is down at demo time.
 */

export type AudioExt = "mp3" | "m4a" | "wav";

export const AUDIO_TYPES: Record<AudioExt, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav" };

export interface TtsIO {
  fetch: Fetcher;
  spawn: Spawner;
  secret(name: string): string;
  which(bin: string): string | null;
  now(): number;
  /** Scratch dir for local synthesis temp files. */
  tmpDir: string;
  /** Websocket factory for streaming TTS (prewarmed sockets). Absent = HTTP only (tests). EVE_TTS_STREAM=0 turns it off. */
  socket?: SocketFactory;
}

export interface TtsBackend {
  name: string;
  /** Stable id of the voice this backend renders with; part of the cache key. */
  voiceKey(): string;
  configured(): boolean;
  /**
   * The whole segment's audio. onChunk (optional) sees playable bytes as they
   * arrive, in order, all of the same ext; backends that can't stream never call it.
   */
  synth(text: string, signal?: AbortSignal, onChunk?: ChunkSink): Promise<{ bytes: Uint8Array; ext: AudioExt }>;
  /** Open the streaming socket ahead of time (no-op without one). */
  warm?(): void;
  /** How the last synth went: "ws" or "http", and ms to the first audio byte over ws. */
  lastPath?(): { via: "ws" | "http"; firstChunkMs?: number } | null;
}

/** How Eve sounds (OpenAI `instructions`). */
export const EVE_VOICE_INSTRUCTIONS =
  "Voice: a young woman, soft and low, close to the mic. Tone: dry, deadpan, slightly teasing, warm underneath. Delivery: unhurried and conversational, small natural pauses, understated. Never theatrical, never bubbly, never announcer-like. Questions land flat and knowing.";

export const OPENAI_TTS_MODEL = "gpt-4o-mini-tts";

export function openAiTts(io: TtsIO): TtsBackend {
  const voice = () => io.secret("EVE_TTS_VOICE") || "marin";
  return {
    name: "openai",
    voiceKey: () => `openai:${OPENAI_TTS_MODEL}:${voice()}:v1`,
    configured: () => !!io.secret("OPENAI_API_KEY"),
    async synth(text, signal, onChunk) {
      const res = await io.fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${io.secret("OPENAI_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: voice(), input: text, instructions: EVE_VOICE_INSTRUCTIONS, response_format: "mp3" }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "openai tts");
      const bytes = await readAudio(res, "mp3", onChunk);
      if (bytes.length < 64) throw new Error("openai tts: empty audio");
      return { bytes, ext: "mp3" };
    },
  };
}

/** Aura-2 voice. Andromeda: casual and expressive, less read-aloud than the others. */
export const DEEPGRAM_DEFAULT_VOICE = "aura-2-andromeda-en";

/** Streaming sockets are on when a factory exists and EVE_TTS_STREAM isn't "0". */
const streaming = (io: TtsIO) => !!io.socket && io.secret("EVE_TTS_STREAM") !== "0";

/**
 * Try the prewarmed socket, fall back to HTTP on any socket trouble, unless
 * the socket already streamed part of the segment out (then it's too late to
 * restart in another format, and the error surfaces).
 */
async function viaSocket(
  ws: StreamingSynth | null,
  text: string,
  signal: AbortSignal | undefined,
  set: (p: { via: "ws" | "http"; firstChunkMs?: number }) => void,
  onChunk?: ChunkSink,
): Promise<{ bytes: Uint8Array; ext: AudioExt } | null> {
  if (!ws) return null;
  let sent = false;
  const sink: ChunkSink | undefined = onChunk
    ? (c, ext) => {
        sent = true;
        onChunk(c, ext);
      }
    : undefined;
  try {
    const r = await ws.synth(text, signal, sink);
    set({ via: "ws", firstChunkMs: r.firstChunkMs });
    return { bytes: r.bytes, ext: r.ext };
  } catch (err) {
    if (signal?.aborted || sent) throw err;
    return null;
  }
}

/** Read an HTTP audio body, handing chunks to onChunk as they arrive (chunked responses stream). */
export async function readAudio(res: Response, ext: "mp3" | "wav", onChunk?: ChunkSink): Promise<Uint8Array> {
  if (!onChunk || !res.body) return new Uint8Array(await res.arrayBuffer());
  const parts: Uint8Array[] = [];
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    parts.push(value);
    onChunk(value, ext);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

export function deepgramTts(io: TtsIO): TtsBackend {
  const voice = () => io.secret("EVE_DEEPGRAM_VOICE") || DEEPGRAM_DEFAULT_VOICE;
  const ws = streaming(io) ? auraStream({ key: () => io.secret("DEEPGRAM_API_KEY"), voice, factory: io.socket, now: io.now }) : null;
  let path: { via: "ws" | "http"; firstChunkMs?: number } | null = null;
  return {
    name: "deepgram",
    voiceKey: () => `deepgram:${voice()}:v1`,
    configured: () => !!io.secret("DEEPGRAM_API_KEY"),
    warm: () => ws?.warm(),
    lastPath: () => path,
    async synth(text, signal, onChunk) {
      const streamed = await viaSocket(ws, text, signal, (p) => (path = p), onChunk);
      if (streamed) return streamed;
      path = { via: "http" };
      const res = await io.fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice())}&encoding=mp3`, {
        method: "POST",
        headers: { Authorization: `Token ${io.secret("DEEPGRAM_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "deepgram tts");
      const bytes = await readAudio(res, "mp3", onChunk);
      if (bytes.length < 64) throw new Error("deepgram tts: empty audio");
      return { bytes, ext: "mp3" };
    },
  };
}

/** ElevenLabs "Rachel": calm young female voice, a safe default when no voice id is configured. */
export const ELEVEN_DEFAULT_VOICE = "21m00Tcm4TlvDq8ikWAM";

/**
 * Live lines use the fast model; `prerender` sets EVE_ELEVEN_MODEL=eleven_v3 so
 * scripted lines get the expressive one. The cache key is model-agnostic (same
 * voice), so a v3 prerender is what plays live for scripted lines.
 */
export const ELEVEN_LIVE_MODEL = "eleven_flash_v2_5";

/**
 * Quota guard: the account's remaining characters are checked (at most once a
 * minute, in the background). When fewer than EVE_ELEVEN_RESERVE (default 1500)
 * are left, the backend reports itself unconfigured, so live lines fall back to
 * the next voice and pay-as-you-go never runs past the plan. Cached lines still play.
 */
export function elevenLabsTts(io: TtsIO): TtsBackend & { quota(): { used: number; limit: number; checkedAt: number } | null } {
  const voice = () => io.secret("EVE_ELEVEN_VOICE_ID") || io.secret("ELEVENLABS_VOICE_ID") || ELEVEN_DEFAULT_VOICE;
  const model = () => io.secret("EVE_ELEVEN_MODEL") || ELEVEN_LIVE_MODEL;
  const reserve = () => Number(io.secret("EVE_ELEVEN_RESERVE") || 1500);
  let quota: { used: number; limit: number; checkedAt: number } | null = null;
  let checking = false;
  const refresh = () => {
    if (checking || (quota && io.now() - quota.checkedAt < 60_000)) return;
    checking = true;
    io.fetch("https://api.elevenlabs.io/v1/user/subscription", { headers: { "xi-api-key": io.secret("ELEVENLABS_API_KEY") } })
      .then(async (r) => {
        if (!r.ok) return;
        const d = (await r.json()) as { character_count?: number; character_limit?: number };
        if (typeof d.character_count === "number" && typeof d.character_limit === "number")
          quota = { used: d.character_count, limit: d.character_limit, checkedAt: io.now() };
      })
      .catch(() => {})
      .finally(() => {
        checking = false;
      });
  };
  const underReserve = () => !!quota && quota.limit - quota.used < reserve();
  const liveSettings = () => ({ stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true });
  // The socket is for live lines (flash); prerender's eleven_v3 goes over HTTP.
  const ws = streaming(io) ? elevenStream({ key: () => io.secret("ELEVENLABS_API_KEY"), voice, model, settings: liveSettings, factory: io.socket, now: io.now }) : null;
  let path: { via: "ws" | "http"; firstChunkMs?: number } | null = null;
  return {
    name: "elevenlabs",
    warm: () => {
      if (model() !== "eleven_v3") ws?.warm();
    },
    lastPath: () => path,
    voiceKey: () => `elevenlabs:${voice()}:v2`,
    quota: () => quota,
    configured: () => {
      if (!io.secret("ELEVENLABS_API_KEY")) return false;
      refresh();
      return !underReserve();
    },
    async synth(text, signal, onChunk) {
      const m = model();
      if (quota) quota = { ...quota, used: quota.used + text.length };
      if (m !== "eleven_v3") {
        const streamed = await viaSocket(ws, text, signal, (p) => (path = p), onChunk);
        if (streamed) return streamed;
      }
      path = { via: "http" };
      const settings = m === "eleven_v3" ? { stability: 0.5 } : { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };
      // optimize_streaming_latency is rejected by eleven_v3 (used for prerendered lines): fast models only.
      const tune = m === "eleven_v3" ? "" : "&optimize_streaming_latency=3";
      const res = await io.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice()}/stream?output_format=mp3_44100_128${tune}`, {
        method: "POST",
        headers: { "xi-api-key": io.secret("ELEVENLABS_API_KEY"), "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: m, voice_settings: settings }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "elevenlabs");
      const bytes = await readAudio(res, "mp3", onChunk);
      if (bytes.length < 64) throw new Error("elevenlabs: empty audio");
      return { bytes, ext: "mp3" };
    },
  };
}

/** macOS `say`, converted to mp3 with ffmpeg (or m4a with afconvert). */
export function sayTts(io: TtsIO): TtsBackend {
  const voice = () => io.secret("EVE_SAY_VOICE") || "Samantha";
  const rate = () => io.secret("EVE_SAY_RATE") || "182";
  return {
    name: "say",
    voiceKey: () => `say:${voice()}:${rate()}:v1`,
    configured: () => process.platform === "darwin" && !!io.which("say") && (!!io.which("ffmpeg") || !!io.which("afconvert")),
    async synth(text, signal) {
      mkdirSync(io.tmpDir, { recursive: true });
      const base = join(io.tmpDir, `say-${io.now()}-${Math.random().toString(36).slice(2, 8)}`);
      const aiff = `${base}.aiff`;
      const run = async (argv: string[]) => {
        const p = io.spawn(argv);
        const onAbort = () => p.kill();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const [code, err] = await Promise.all([p.exited, drainText(p.stderr), drainText(p.stdout)]);
          if (code !== 0) throw new Error(`${argv[0]} exited ${code}: ${err.slice(0, 200)}`);
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      };
      try {
        await run([io.which("say") ?? "say", "-v", voice(), "-r", rate(), "-o", aiff, text]);
        const ffmpeg = io.which("ffmpeg");
        if (ffmpeg) {
          const out = `${base}.mp3`;
          await run([ffmpeg, "-y", "-loglevel", "error", "-i", aiff, "-codec:a", "libmp3lame", "-q:a", "4", out]);
          return { bytes: new Uint8Array(await Bun.file(out).arrayBuffer()), ext: "mp3" };
        }
        const out = `${base}.m4a`;
        await run([io.which("afconvert") ?? "afconvert", "-f", "m4af", "-d", "aac", aiff, out]);
        return { bytes: new Uint8Array(await Bun.file(out).arrayBuffer()), ext: "m4a" };
      } finally {
        for (const ext of ["aiff", "mp3", "m4a"]) rmSync(`${base}.${ext}`, { force: true });
      }
    },
  };
}

/**
 * What the voice actually reads. Subtitles keep the original text; TTS engines
 * spell short hums out ("mm" -> "em em"), so stretch them into sounds.
 * Also part of the cache key, so pronunciation fixes re-render stale audio.
 */
export function normalizeForCache(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\b[mM]{2,}\b/g, (m) => (m[0] === "M" ? "Mmm" : "mmm"))
    .replace(/\b([hH])m+\b/g, "$1mm")
    .replace(/\b([uU])m+\b/g, "$1mm")
    .replace(/\b([uU])h+\b/g, "$1hh");
}

export function audioKey(voiceKey: string, text: string): string {
  return createHash("sha256").update(`${voiceKey}\n${normalizeForCache(text)}`).digest("hex");
}

export const AUDIO_NAME_RE = /^([a-f0-9]{64})\.(mp3|m4a|wav)$/;

export class AudioCache {
  private index = new Map<string, AudioExt>();
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    try {
      for (const f of readdirSync(dir)) {
        const m = f.match(AUDIO_NAME_RE);
        if (m) this.index.set(m[1]!, m[2] as AudioExt);
      }
    } catch {}
  }

  get(sha: string): AudioExt | null {
    const ext = this.index.get(sha);
    if (ext && existsSync(this.path(sha, ext))) return ext;
    if (ext) this.index.delete(sha);
    return null;
  }

  put(sha: string, ext: AudioExt, bytes: Uint8Array): void {
    writeFileSync(this.path(sha, ext), bytes);
    this.index.set(sha, ext);
  }

  path(sha: string, ext: AudioExt): string {
    return join(this.dir, `${sha}.${ext}`);
  }

  get size(): number {
    return this.index.size;
  }
}

export interface Rendered {
  sha: string;
  ext: AudioExt;
  file: string;
  /** Relative URL the shell resolves against the core origin. */
  url: string;
  backend: string;
  cached: boolean;
  ms: number;
  /** url is a live stream (/api/audio/live/...) still being synthesized. */
  stream?: boolean;
}

export interface RenderOpts {
  only?: string;
  /**
   * Called once, the moment a streaming backend's first bytes arrive, with a
   * live url the shell can start playing. The bytes are still cached under the
   * normal content hash when synthesis finishes.
   */
  onLive?(r: Rendered): void;
}

export class Tts {
  health: HealthBook;
  /** Live streams for segments still being synthesized (GET /api/audio/live/<id>). null = streaming off. */
  streams: LiveStreams | null;
  constructor(
    public backends: TtsBackend[],
    public cache: AudioCache,
    private now: () => number = Date.now,
    health?: HealthBook,
    opts: { live?: boolean } = {},
  ) {
    this.health = health ?? new HealthBook(now);
    this.streams = opts.live === false ? null : new LiveStreams(now);
  }

  /** Cached audio for this text from any backend's voice, best voice first. */
  lookup(text: string): Rendered | null {
    for (const b of this.backends) {
      const sha = audioKey(b.voiceKey(), text);
      const ext = this.cache.get(sha);
      if (ext) return this.rendered(sha, ext, b.name, true, 0);
    }
    return null;
  }

  /** Prewarm the streaming socket of the backend that would speak next. */
  warm(): void {
    this.live()[0]?.warm?.();
  }

  live(): TtsBackend[] {
    return this.backends.filter((b) => b.configured() && !this.health.cooling(b.name));
  }

  /**
   * Walk backends best voice first: a cached copy in that voice wins, else a
   * live backend synthesizes. So an old render from a worse backend (say) never
   * beats a better backend that is live right now, while a line prerendered
   * with a backend that is down at demo time still keeps its good voice.
   */
  async render(text: string, signal?: AbortSignal, opts: RenderOpts = {}): Promise<Rendered | null> {
    if (!/[\p{L}\p{N}]/u.test(text)) return null;
    for (const b of this.backends) {
      if (opts.only && b.name !== opts.only) continue;
      const sha = audioKey(b.voiceKey(), text);
      if (!opts.only) {
        const ext = this.cache.get(sha);
        if (ext) return this.rendered(sha, ext, b.name, true, 0);
      }
      if (!b.configured() || this.health.cooling(b.name)) continue;
      if (signal?.aborted) return null;
      const t0 = this.now();
      let live: LiveWriter | null = null;
      const streams = this.streams;
      const onChunk: ChunkSink | undefined =
        opts.onLive && streams
          ? (chunk, ext) => {
              if (!live) {
                live = streams.open(sha, ext);
                opts.onLive!({ ...this.rendered(sha, ext, b.name, false, this.now() - t0), url: live.url, stream: true });
              }
              live.push(chunk);
            }
          : undefined;
      try {
        const { bytes, ext } = await b.synth(normalizeForCache(text), signal, onChunk);
        this.cache.put(sha, ext, bytes);
        (live as LiveWriter | null)?.end();
        this.health.ok(b.name, this.now() - t0);
        return this.rendered(sha, ext, b.name, false, this.now() - t0);
      } catch (err) {
        (live as LiveWriter | null)?.end(true);
        if (signal?.aborted) return null;
        this.health.fail(b.name, err);
        // Part of this segment already went out live: no second voice for the rest.
        if (live) return null;
      }
    }
    return null;
  }

  /**
   * Render one short filler with every configured network backend that has
   * no cached copy yet. A dead key gets parked at boot (so the first real
   * line doesn't pay for it) and a live one leaves a useful cached filler.
   */
  async probe(text = "hm."): Promise<Record<string, boolean>> {
    const out: Record<string, boolean> = {};
    for (const b of this.backends) {
      if (b.name === "say" || !b.configured() || this.health.cooling(b.name)) continue;
      if (this.cache.get(audioKey(b.voiceKey(), text))) {
        out[b.name] = true;
        continue;
      }
      out[b.name] = !!(await this.render(text, AbortSignal.timeout(8000), { only: b.name }));
    }
    return out;
  }

  private rendered(sha: string, ext: AudioExt, backend: string, cached: boolean, ms: number): Rendered {
    return { sha, ext, file: this.cache.path(sha, ext), url: `/api/audio/${sha}.${ext}`, backend, cached, ms };
  }
}
