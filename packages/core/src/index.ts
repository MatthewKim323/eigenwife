import { EventBus } from "./bus";
import { loadConfig, type CoreConfig } from "./config";
import { createContext, type CoreContext, type Module } from "./context";
import { startHub } from "./hub";

export { EventBus } from "./bus";
export { json, CORS_HEADERS } from "./hub";
export { loadConfig, secret, has, REPO_ROOT, JABBY_DIR } from "./config";
export type { CoreConfig } from "./config";
export type { CoreContext, Module, RouteHandler } from "./context";
export type * from "./services";

export interface RunningCore {
  ctx: CoreContext;
  port: number;
  stop(): Promise<void>;
}

/** Boot the bus hub, then start modules in order. A module that throws is logged and skipped. */
export async function startCore(modules: Module[], overrides: Partial<CoreConfig> = {}): Promise<RunningCore> {
  const config = loadConfig(overrides);
  const bus = new EventBus();
  const ctx = createContext(bus, config);
  const hub = startHub(ctx);
  const started: Module[] = [];
  for (const m of modules) {
    try {
      await m.start(ctx);
      started.push(m);
      ctx.log("core", `module ${m.name} up`);
    } catch (err) {
      ctx.log("core", `module ${m.name} failed to start:`, err);
      bus.emit("error", { where: `module:${m.name}`, message: String(err) });
    }
  }
  return {
    ctx,
    port: hub.port ?? config.port,
    async stop() {
      for (const m of started.reverse()) {
        try {
          await m.stop?.();
        } catch {}
      }
      hub.stop();
    },
  };
}
