import type { VoiceEngine } from "@eigenwife/protocol";
import type { Module } from "../context";
import { json } from "../hub";
import { liveConfig, type LiveConfig } from "./config";
import { LiveController, type ControllerOptions } from "./controller";
import type { UsageFile } from "./usage";

/**
 * Eve Live: gpt-live-1 as an alternate voice engine behind a toggle
 * (docs/LIVE.md). Must start after speech (it wraps the speech service) and
 * before anything that captures services at start (nothing does today).
 *
 * Routes:
 *   GET  /api/live          engine, session status, provider, today's minutes
 *   POST /api/live/engine   { engine: "classic" | "live" }  (the tray toggle)
 * Socket:
 *   ws /live                the page's audio relay (packages/protocol/src/live.ts)
 */
export function liveModule(opts: ControllerOptions & { config?: Partial<LiveConfig> } = {}): Module & { controller(): LiveController | null } {
  let ctl: LiveController | null = null;
  return {
    controller: () => ctl,
    name: "live",
    async start(ctx) {
      const cfg = liveConfig(undefined, opts.config);
      const home = ctx.tryUse("home");
      const saved = home ? await home.read<{ engine?: VoiceEngine } | null>("voice", null).catch(() => null) : null;
      const usage = home ? await home.read<UsageFile | null>("live-usage", null).catch(() => null) : null;
      ctl = new LiveController(ctx, cfg, opts, usage);
      const engine: VoiceEngine = cfg.envEngine ?? (saved?.engine === "live" ? "live" : "classic");
      ctl.start(ctx.tryUse("speech"), engine, cfg.envEngine ? "env" : "restore");
      ctx.log("live", `engine ${engine}${cfg.envEngine ? " (EVE_VOICE_ENGINE)" : ""}, providers: ${ctl.snapshot().providers.join(", ") || "none (no keys)"}, voice ${cfg.voice}, cap ${cfg.dailyCapMin} min/day`);

      ctx.route("/api/live", async (req, url) => {
        if (url.pathname === "/api/live" && req.method === "GET") return json({ ok: true, ...ctl!.snapshot() });
        if (url.pathname === "/api/live/engine" && req.method === "POST") {
          let body: { engine?: string; by?: string };
          try {
            body = (await req.json()) as typeof body;
          } catch {
            return json({ ok: false, error: "json body required" }, 400);
          }
          if (body.engine !== "live" && body.engine !== "classic") return json({ ok: false, error: 'engine must be "classic" or "live"' }, 400);
          const r = await ctl!.setEngine(body.engine, body.by === "tray" ? "tray" : "api");
          return json({ ok: r.engine === body.engine, ...ctl!.snapshot() });
        }
        return null;
      });
    },
    stop() {
      ctl?.stop();
      ctl = null;
    },
  };
}
