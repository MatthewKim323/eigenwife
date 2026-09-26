import { secret } from "../config";
import type { Module, SocketPeer } from "../context";
import { json } from "../hub";
import { DEEPGRAM_LISTEN_URL, LISTEN_DEFAULTS, listenUrl, optionsFromQuery } from "./deepgram";
import { EarsSession, type UpstreamFactory } from "./session";

/**
 * Ears: streamed mic audio in, voice.partial / voice.final out. The shell (or
 * the desktop overlay, where Web Speech doesn't exist) opens ws /ears and
 * sends 16kHz linear16 PCM (or webm/opus with ?encoding=webm); we proxy it to
 * Deepgram live STT and publish transcripts on the bus as source "ears".
 *
 *   ws  /ears?encoding=linear16&sample_rate=16000&client=overlay
 *       binary frames = audio; text frames = JSON control:
 *         { type: "eve", speaking }   who's playing her voice right now
 *         { type: "ptt", down }       push-to-talk (bypasses the half-duplex gate)
 *         { type: "finalize" }        close the utterance now
 *       server -> client JSON: status | partial | final | bargein | dropped
 *   GET /api/ears/status   { available, provider, model, reason?, sessions }
 *
 * Env: DEEPGRAM_API_KEY (env, .env, or jabby's .env), EVE_STT_MODEL (nova-3).
 */

export interface EarsOptions {
  /** Upstream base URL (tests point this at a fake Deepgram). */
  endpoint?: string;
  connect?: UpstreamFactory;
  secret?: (name: string) => string;
  minBackoffMs?: number;
  maxBackoffMs?: number;
  keepAliveMs?: number;
}

export function earsModule(opts: EarsOptions = {}): Module {
  const sessions = new Map<string, EarsSession>();
  const offs: (() => void)[] = [];
  return {
    name: "ears",
    start(ctx) {
      const get = opts.secret ?? secret;
      const key = () => get("DEEPGRAM_API_KEY");
      const model = get("EVE_STT_MODEL") || LISTEN_DEFAULTS.model;

      // Her voice, as the core sees it; clients that play audio report more precisely.
      offs.push(
        ctx.bus.on("speech.begin", () => sessions.forEach((s) => s.tracker.fromBus(true))),
        ctx.bus.on("speech.end", () => sessions.forEach((s) => s.tracker.fromBus(false))),
        ctx.bus.on("speech.stop", () => sessions.forEach((s) => s.tracker.fromBus(false))),
      );

      ctx.route("/api/ears/status", (req) => {
        if (req.method !== "GET") return null;
        const k = key();
        return json({
          ok: true,
          available: !!k,
          provider: "deepgram",
          model,
          ...(k ? {} : { reason: "DEEPGRAM_API_KEY not set" }),
          sessions: [...sessions.values()].map((s) => ({ state: s.state, connects: s.connects, bytesIn: s.bytesIn })),
        });
      });

      ctx.socket("/ears", {
        upgrade() {
          if (key()) return null;
          return json({ ok: false, available: false, error: "DEEPGRAM_API_KEY not set" }, 503);
        },
        open(peer: SocketPeer) {
          const q = peer.url.searchParams;
          const client = q.get("client") ?? "mic";
          const url = listenUrl({ ...optionsFromQuery(q), model }, opts.endpoint ?? DEEPGRAM_LISTEN_URL);
          const send = (m: Record<string, unknown>) => {
            try {
              peer.send(JSON.stringify(m));
            } catch {}
          };
          const s = new EarsSession({
            url,
            apiKey: key(),
            connect: opts.connect,
            minBackoffMs: opts.minBackoffMs,
            maxBackoffMs: opts.maxBackoffMs,
            keepAliveMs: opts.keepAliveMs,
            hooks: {
              partial: (text) => ctx.bus.emit("voice.partial", { text }, "ears"),
              final: (text, confidence) => {
                ctx.log("ears", `heard: "${text}"`);
                ctx.bus.emit("voice.final", { text, ...(confidence !== undefined ? { confidence } : {}) }, "ears");
              },
              bargeIn: () => ctx.bus.emit("speech.stop", { reason: "barge-in" }, "ears"),
              toClient: send,
              log: (...a) => ctx.log("ears", ...a),
            },
          });
          if (ctx.tryUse("speech")?.speaking()) s.tracker.fromBus(true);
          sessions.set(peer.id, s);
          ctx.log("ears", `${client} connected (${q.get("encoding") ?? "linear16"})`);
          s.start();
        },
        message(peer, data) {
          const s = sessions.get(peer.id);
          if (!s) return;
          if (typeof data === "string") {
            try {
              s.control(JSON.parse(data));
            } catch {}
          } else s.audio(data);
        },
        close(peer) {
          const s = sessions.get(peer.id);
          sessions.delete(peer.id);
          s?.close();
          if (s) ctx.log("ears", `mic client left (${Math.round(s.bytesIn / 1024)} KiB heard)`);
        },
      });
    },
    stop() {
      offs.forEach((o) => o());
      sessions.forEach((s) => s.close());
      sessions.clear();
    },
  };
}
