import { join } from "path";
import { secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { SayOptions } from "../services";
import { bunSpawn, whichBin } from "../brains/io";
import { createSpeech, type Speech, type SpeechDeps } from "./service";
import { AUDIO_NAME_RE, AUDIO_TYPES, AudioCache, elevenLabsTts, openAiTts, sayTts, Tts, type AudioExt, type TtsBackend, type TtsIO } from "./tts";

/**
 * Speech: mark splitter, sentence chunker, TTS with a disk cache, speech.*
 * events, barge-in. Provides the `speech` service. See docs/BRAINS.md.
 *
 * Routes:
 *   GET  /api/audio/<sha>.<mp3|m4a|wav>   cached audio (immutable)
 *   GET  /api/speech/status               queue + TTS backend health
 *   POST /api/speech/say   { text, priority?, interrupt? }
 *   POST /api/speech/stop  { reason? }
 *
 * Env: EVE_TTS=openai|elevenlabs|say|none pins the backend order (first) or
 * turns synthesis off (segments go out without audioUrl; the shell falls back
 * to speechSynthesis). EVE_TTS_VOICE, ELEVENLABS_VOICE_ID, EVE_SAY_VOICE.
 */

export function ttsIO(ctx: { config: { eveHome: string } }): TtsIO {
  return {
    fetch: (i, init) => fetch(i, init),
    spawn: bunSpawn,
    secret,
    which: whichBin,
    now: Date.now,
    tmpDir: join(ctx.config.eveHome, "work", "tts"),
  };
}

/** Backends in preference order, honoring EVE_TTS. null when TTS is off. */
export function buildTts(eveHome: string, io: TtsIO, pin = io.secret("EVE_TTS")): Tts | null {
  if (pin === "none" || pin === "off") return null;
  const all: TtsBackend[] = [openAiTts(io), elevenLabsTts(io), sayTts(io)];
  const ordered = pin ? [...all.filter((b) => b.name === pin), ...all.filter((b) => b.name !== pin)] : all;
  return new Tts(ordered, new AudioCache(join(eveHome, "audio")), io.now);
}

const instances = new WeakMap<CoreContext, { speech: Speech; tts: Tts | null }>();

export function speechFor(ctx: CoreContext) {
  return instances.get(ctx) ?? null;
}

export function speechModule(overrides: Partial<SpeechDeps> & { tts?: Tts | null } = {}): Module {
  let speech: Speech | null = null;
  return {
    name: "speech",
    start(ctx) {
      const tts = overrides.tts !== undefined ? overrides.tts : buildTts(ctx.config.eveHome, ttsIO(ctx));
      speech = createSpeech({ bus: ctx.bus, log: (...a) => ctx.log("speech", ...a), ...overrides, tts });
      instances.set(ctx, { speech, tts });
      ctx.provide("speech", speech);
      const report = () => {
        const live = tts?.live().map((b) => b.name) ?? [];
        ctx.log("speech", `tts: ${live.length ? live.join(" > ") : "none (segments without audio)"}; cache ${tts?.cache.size ?? 0} files`);
      };
      if (tts && overrides.tts === undefined) void tts.probe().then(report);
      else report();

      ctx.route("/api/audio/", async (req, url) => {
        if (req.method !== "GET" && req.method !== "HEAD") return null;
        const name = url.pathname.slice("/api/audio/".length);
        const m = name.match(AUDIO_NAME_RE);
        if (!m || !tts) return json({ ok: false, error: "not found" }, 404);
        const ext = m[2] as AudioExt;
        if (tts.cache.get(m[1]!) !== ext) return json({ ok: false, error: "not found" }, 404);
        const file = Bun.file(tts.cache.path(m[1]!, ext));
        return new Response(req.method === "HEAD" ? null : file, {
          headers: {
            "content-type": AUDIO_TYPES[ext],
            "content-length": String(file.size),
            "cache-control": "public, max-age=31536000, immutable",
          },
        });
      });

      ctx.route("/api/speech/status", (req) => {
        if (req.method !== "GET") return null;
        return json({
          ok: true,
          ...speech!.info(),
          tts: tts
            ? { order: tts.backends.map((b) => b.name), live: tts.live().map((b) => b.name), cached: tts.cache.size, health: tts.health.snapshot() }
            : { order: [], live: [], cached: 0, health: {} },
        });
      });

      ctx.route("/api/speech/say", async (req) => {
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as { text?: string; priority?: SayOptions["priority"]; interrupt?: boolean };
        const text = String(body.text ?? "").trim();
        if (!text) return json({ ok: false, error: "text required" }, 400);
        const r = await speech!.say(text, { priority: body.priority ?? "high", interrupt: body.interrupt ?? true, brain: "manual" });
        return json({ ok: true, ...r });
      });

      ctx.route("/api/speech/stop", async (req) => {
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as { reason?: string };
        speech!.stop(body.reason ?? "manual");
        return json({ ok: true });
      });
    },
    stop() {
      speech?.dispose();
    },
  };
}
