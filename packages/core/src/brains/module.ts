import { join } from "path";
import { secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { FrontierRequest } from "../services";
import { bunSpawn, whichBin, type BrainIO } from "./io";
import { createBrains, type Brains, type BrainsDeps, type HaremBrain, type StructuredRequest } from "./service";

/**
 * Brain router: the fast social cortex (persona), the frontal cortex
 * (frontier: jabby first), and small structured calls (quickJson), behind
 * the `brains` service. See docs/BRAINS.md.
 *
 * Routes:
 *   GET  /api/brains/status   which backends are live, latencies, last errors
 *   POST /api/brains/test     { text, mode?: "persona"|"frontier"|"json", engine?, speak? }
 */

const instances = new WeakMap<CoreContext, Brains>();

export function defaultIO(ctx: CoreContext): BrainIO {
  return {
    fetch: (input, init) => fetch(input, init),
    spawn: bunSpawn,
    secret,
    which: whichBin,
    workDir: join(ctx.config.eveHome, "work"),
    now: Date.now,
  };
}

function build(ctx: CoreContext, overrides: Partial<BrainsDeps> = {}): Brains {
  return createBrains({
    io: overrides.io ?? defaultIO(ctx),
    jabbyUrl: ctx.config.jabbyUrl,
    persona: () => {
      try {
        return ctx.tryUse("preference")?.persona() ?? ctx.world().companion.persona ?? null;
      } catch {
        return ctx.world().companion.persona ?? null;
      }
    },
    relationship: () => {
      try {
        return ctx.tryUse("relationship")?.get() ?? ctx.world().companion.relationship;
      } catch {
        return ctx.world().companion.relationship;
      }
    },
    world: () => ctx.contextBlock(),
    log: (...a) => ctx.log("brains", ...a),
    ...overrides,
  });
}

/** The Brains instance behind ctx (created on first use if the module isn't started). */
export function brainsFor(ctx: CoreContext): Brains {
  let b = instances.get(ctx);
  if (!b) instances.set(ctx, (b = build(ctx)));
  return b;
}

/**
 * Harem adapter: implements packages/harem's Brain interface
 * (`structured<T>({agent, system, prompt, schema, tools, onEvent, signal})`)
 * on the frontier engines. claude -p --json-schema first, then codex
 * --output-schema, jabby, openai. Pass it to the harem as deps.brain.
 */
export function haremBrain(ctx: CoreContext): HaremBrain {
  return {
    name: "eve-frontier",
    structured: <T>(req: StructuredRequest) => brainsFor(ctx).harem.structured<T>(req),
  };
}

export function brainsModule(overrides: Partial<BrainsDeps> = {}): Module {
  let timer: ReturnType<typeof setInterval> | undefined;
  return {
    name: "brains",
    async start(ctx) {
      const brains = build(ctx, overrides);
      instances.set(ctx, brains);
      ctx.provide("brains", brains);
      // Don't block boot on jabby's health check.
      void brains.refresh().then(() => ctx.log("brains", "live:", liveList(brains)));
      timer = setInterval(() => void brains.refresh(), 15_000);
      (timer as { unref?: () => void }).unref?.();

      ctx.route("/api/brains/status", async (req) => {
        if (req.method !== "GET") return null;
        await brains.refresh();
        return json({ ok: true, live: brains.status(), detail: brains.detail(), lastPersona: brains.lastPersona() });
      });

      ctx.route("/api/brains/test", async (req) => {
        if (req.method !== "POST") return null;
        let body: { text?: string; mode?: string; engine?: FrontierRequest["engine"]; speak?: boolean; behavior?: string };
        try {
          body = (await req.json()) as typeof body;
        } catch {
          return json({ ok: false, error: "json body required" }, 400);
        }
        const text = String(body.text ?? "").trim();
        if (!text) return json({ ok: false, error: "text required" }, 400);
        const t0 = Date.now();
        if (body.mode === "frontier") return json(await brains.frontier({ goal: text, engine: body.engine ?? "auto" }));
        if (body.mode === "json") {
          const out = await brains.quickJson("Answer as a compact JSON object.", text);
          return json({ ok: out !== null, json: out, ms: Date.now() - t0 });
        }
        const req2 = { event: "the user said something to you", behavior: body.behavior ?? "answer", userText: text, maxWords: 16, marks: true };
        const speech = body.speak ? ctx.tryUse("speech") : null;
        if (speech) {
          let said = "";
          const tee = (async function* () {
            for await (const c of brains.persona(req2)) {
              said += c;
              yield c;
            }
          })();
          const r = await speech.say(tee, { brain: "persona", priority: "high" });
          return json({ ok: true, text: said, utteranceId: r.utteranceId, trace: brains.lastPersona(), ms: Date.now() - t0 });
        }
        let out = "";
        for await (const c of brains.persona(req2)) out += c;
        return json({ ok: true, text: out, trace: brains.lastPersona(), ms: Date.now() - t0 });
      });
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

function liveList(b: Brains): string {
  return (
    Object.entries(b.status())
      .filter(([, v]) => v)
      .map(([k]) => k)
      .join(", ") || "none"
  );
}
