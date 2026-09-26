import { createHash } from "crypto";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { HealthBook } from "../brains/health";
import { drainText, HttpError, type Fetcher, type Spawner } from "../brains/io";

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
}

export interface TtsBackend {
  name: string;
  /** Stable id of the voice this backend renders with; part of the cache key. */
  voiceKey(): string;
  configured(): boolean;
  synth(text: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; ext: AudioExt }>;
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
    async synth(text, signal) {
      const res = await io.fetch("https://api.openai.com/v1/audio/speech", {
        method: "POST",
        headers: { Authorization: `Bearer ${io.secret("OPENAI_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ model: OPENAI_TTS_MODEL, voice: voice(), input: text, instructions: EVE_VOICE_INSTRUCTIONS, response_format: "mp3" }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "openai tts");
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length < 64) throw new Error("openai tts: empty audio");
      return { bytes, ext: "mp3" };
    },
  };
}

/** Aura-2 voice. Andromeda: casual and expressive, less read-aloud than the others. */
export const DEEPGRAM_DEFAULT_VOICE = "aura-2-andromeda-en";

export function deepgramTts(io: TtsIO): TtsBackend {
  const voice = () => io.secret("EVE_DEEPGRAM_VOICE") || DEEPGRAM_DEFAULT_VOICE;
  return {
    name: "deepgram",
    voiceKey: () => `deepgram:${voice()}:v1`,
    configured: () => !!io.secret("DEEPGRAM_API_KEY"),
    async synth(text, signal) {
      const res = await io.fetch(`https://api.deepgram.com/v1/speak?model=${encodeURIComponent(voice())}&encoding=mp3`, {
        method: "POST",
        headers: { Authorization: `Token ${io.secret("DEEPGRAM_API_KEY")}`, "content-type": "application/json" },
        body: JSON.stringify({ text }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "deepgram tts");
      const bytes = new Uint8Array(await res.arrayBuffer());
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

export function elevenLabsTts(io: TtsIO): TtsBackend {
  const voice = () => io.secret("EVE_ELEVEN_VOICE_ID") || io.secret("ELEVENLABS_VOICE_ID") || ELEVEN_DEFAULT_VOICE;
  const model = () => io.secret("EVE_ELEVEN_MODEL") || ELEVEN_LIVE_MODEL;
  return {
    name: "elevenlabs",
    voiceKey: () => `elevenlabs:${voice()}:v2`,
    configured: () => !!io.secret("ELEVENLABS_API_KEY"),
    async synth(text, signal) {
      const m = model();
      const settings = m === "eleven_v3" ? { stability: 0.5 } : { stability: 0.45, similarity_boost: 0.8, style: 0.35, use_speaker_boost: true };
      const res = await io.fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voice()}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": io.secret("ELEVENLABS_API_KEY"), "content-type": "application/json", accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: m, voice_settings: settings }),
        signal,
      });
      if (!res.ok) throw new HttpError(res.status, await res.text().catch(() => ""), "elevenlabs");
      const bytes = new Uint8Array(await res.arrayBuffer());
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

export function normalizeForCache(text: string): string {
  return text.trim().replace(/\s+/g, " ");
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
}

export class Tts {
  health: HealthBook;
  constructor(
    public backends: TtsBackend[],
    public cache: AudioCache,
    private now: () => number = Date.now,
    health?: HealthBook,
  ) {
    this.health = health ?? new HealthBook(now);
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

  live(): TtsBackend[] {
    return this.backends.filter((b) => b.configured() && !this.health.cooling(b.name));
  }

  /**
   * Walk backends best voice first: a cached copy in that voice wins, else a
   * live backend synthesizes. So an old render from a worse backend (say) never
   * beats a better backend that is live right now, while a line prerendered
   * with a backend that is down at demo time still keeps its good voice.
   */
  async render(text: string, signal?: AbortSignal, opts: { only?: string } = {}): Promise<Rendered | null> {
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
      try {
        const { bytes, ext } = await b.synth(normalizeForCache(text), signal);
        this.cache.put(sha, ext, bytes);
        this.health.ok(b.name, this.now() - t0);
        return this.rendered(sha, ext, b.name, false, this.now() - t0);
      } catch (err) {
        if (signal?.aborted) return null;
        this.health.fail(b.name, err);
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
