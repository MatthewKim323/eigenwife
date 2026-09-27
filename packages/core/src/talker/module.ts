import type { Persona } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import { conversationFor, defaultIO } from "../brains/module";
import { DEFAULT_EVE, renamePersona } from "../brains/prompt";
import type { BrainIO } from "../brains/io";
import type { TalkerRunHandle, TalkerService } from "../services";
import { FILLERS } from "../speech/lines";
import { defaultTalkerBackends, type TalkerBackend } from "./backends";
import { LatencyBook } from "./latency";
import { buildTalkerPrompt, talkerMaxTokens } from "./prompt";
import { createTalker, type Talker, type TalkerRun } from "./run";

/**
 * The talker: Eve's fast conversational voice. A streaming persona model
 * with one tool, delegate({stall, kind, task}). Provides the `talker`
 * service; the reflex router (reflex/module.ts + talker/router.ts) decides
 * when to use it and carries out delegations. See docs/VOICE.md.
 *
 *   GET  /api/talker/status   backends, health, end-of-speech -> first-audio p50/p95
 *   POST /api/talker/test     { text } -> { said, delegate, backend, firstTextMs }
 *
 * Backend order: anthropic (ANTHROPIC_API_KEY) > gateway (AI_GATEWAY_API_KEY)
 * > openai > featherless > claude CLI haiku. EVE_TALKER=off disables it (the
 * old persona path answers instead).
 */

export interface TalkerOptions {
  io?: BrainIO;
  backends?: TalkerBackend[];
}

const instances = new WeakMap<CoreContext, { talker: Talker; latency: LatencyBook; runs: Map<string, TalkerRun> }>();

export function talkerFor(ctx: CoreContext) {
  return instances.get(ctx) ?? null;
}

export function handle(run: TalkerRun): TalkerRunHandle {
  return {
    id: run.id,
    text: () => run.text.read(),
    delegation: run.delegation,
    finished: run.finished,
    backend: () => run.backend,
    said: () => run.said,
    empty: () => run.empty,
    aborted: () => run.aborted,
    abort: (r) => run.abort(r),
  };
}

export function talkerModule(opts: TalkerOptions = {}): Module {
  const offs: (() => void)[] = [];
  return {
    name: "talker",
    start(ctx) {
      const io = opts.io ?? defaultIO(ctx);
      const persona = (): Persona => {
        let p: Persona | null = null;
        try {
          p = ctx.tryUse("preference")?.persona() ?? ctx.world().companion.persona ?? null;
        } catch {
          p = ctx.world().companion.persona ?? null;
        }
        let her: string | null = null;
        try {
          her = ctx.tryUse("user")?.herName() ?? null;
        } catch {}
        return her ? renamePersona(p ?? DEFAULT_EVE, her) : (p ?? DEFAULT_EVE);
      };
      const runs = new Map<string, TalkerRun>();
      const talker = createTalker({
        io,
        backends: opts.backends ?? defaultTalkerBackends(io),
        prompt: (req) =>
          buildTalkerPrompt({
            persona: persona(),
            relationship: (() => {
              try {
                return ctx.tryUse("relationship")?.get() ?? ctx.world().companion.relationship;
              } catch {
                return ctx.world().companion.relationship;
              }
            })(),
            world: ctx.contextBlock(),
            conversation: conversationFor(ctx).block(persona().name.toLowerCase()),
            user: (() => {
              try {
                return ctx.tryUse("user")?.profile() ?? null;
              } catch {
                return null;
              }
            })(),
            userText: req.userText,
            event: req.event,
            behavior: req.behavior,
            extra: req.extra,
            maxWords: req.maxWords,
          }),
        maxTokens: (req) => talkerMaxTokens(req.maxWords),
        names: () => [persona().name, "eve"],
        log: (...a) => ctx.log("talker", ...a),
      });
      const latency = new LatencyBook();
      instances.set(ctx, { talker, latency, runs });
      const off = (io.secret("EVE_TALKER") || "").toLowerCase() === "off";

      const service: TalkerService = {
        available: () => !off && talker.available(),
        start(req) {
          const run = talker.start(req);
          runs.set(run.id, run);
          if (runs.size > 50) runs.delete(runs.keys().next().value!);
          void run.finished.then(() => {
            if (run.backend) ctx.log("talker", `${run.backend} ${run.firstTextAt !== null ? `first word ${run.firstTextAt - run.startedAt}ms` : ""}${run.call ? ` -> delegate ${run.call.kind}: ${run.call.task}` : ""}${run.errors.length ? ` (${run.errors.join("; ")})` : ""}`);
          });
          return handle(run);
        },
      };
      ctx.provide("talker", service);
      ctx.log("talker", `backends: ${talker.backends.filter((b) => b.configured()).map((b) => `${b.name}${b.tools === "inline" ? "(inline)" : ""}`).join(" > ") || "none"}${off ? " (EVE_TALKER=off)" : ""}`);

      // --- latency: end of speech -> first audio -----------------------------------------
      const fillers = new Set<string>(FILLERS);
      offs.push(
        ctx.bus.on("voice.final", (e) => latency.endOfSpeech(e.ts)),
        ctx.bus.on("speech.begin", (e) => latency.utterance(e.data.utteranceId, e.data.brain)),
        ctx.bus.on("speech.segment", (e) => {
          const s = latency.segment(e.ts, e.data.utteranceId, !!e.data.audioUrl, fillers.has(e.data.text), (label) => {
            if (!label.startsWith("talker:")) return label === "persona" ? "persona" : label === "scripted" ? "scripted" : null;
            const r = runs.get(label.slice(7));
            return r?.backend ?? "talker";
          });
          if (s) ctx.log("talker", `end of speech -> first audio: ${s.replyMs}ms (${s.backend}${s.soundMs !== null && s.soundMs < s.replyMs ? `, first sound ${s.soundMs}ms` : ""})`);
        }),
      );

      ctx.route("/api/talker/status", (req) => {
        if (req.method !== "GET") return null;
        return json({
          ok: true,
          enabled: !off,
          available: service.available(),
          backends: talker.backends.map((b) => ({ name: b.name, tools: b.tools, configured: b.configured(), model: b.model(), cooling: talker.health.cooling(b.name) })),
          health: talker.health.snapshot(),
          latency: latency.summary(),
          recent: latency.samples.slice(-20),
        });
      });

      ctx.route("/api/talker/test", async (req) => {
        if (req.method !== "POST") return null;
        const body = (await req.json().catch(() => ({}))) as { text?: string };
        const text = String(body.text ?? "").trim();
        if (!text) return json({ ok: false, error: "text required" }, 400);
        const run = talker.start({ userText: text });
        await run.finished;
        return json({
          ok: !run.empty,
          said: run.said,
          delegate: run.call,
          backend: run.backend,
          firstTextMs: run.firstTextAt !== null ? run.firstTextAt - run.startedAt : null,
          errors: run.errors,
        });
      });
    },
    stop() {
      offs.forEach((o) => o());
    },
  };
}
