import { emptyWorld, reduceWorld, renderContext, setSlot, type AnyEnvelope, type WorldSnapshot } from "@eigenwife/protocol";
import type { EventBus } from "./bus";
import type { CoreConfig } from "./config";

export type RouteHandler = (req: Request, url: URL) => Response | Promise<Response> | null | Promise<Response | null>;

/** Everything a module gets. Modules never import each other directly: they talk over the bus. */
export interface CoreContext {
  bus: EventBus;
  config: CoreConfig;
  world(): WorldSnapshot;
  setSlot(source: string, name: string, value: string | null): void;
  contextBlock(): string;
  /** Register an HTTP route on the core server (prefix match). */
  route(prefix: string, handler: RouteHandler): void;
  log(module: string, ...args: unknown[]): void;
}

export interface Module {
  name: string;
  start(ctx: CoreContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export function createContext(bus: EventBus, config: CoreConfig): CoreContext & { routes: Map<string, RouteHandler> } {
  let world = emptyWorld();
  bus.on("*", (e: AnyEnvelope) => {
    world = reduceWorld(world, e);
  });
  const routes = new Map<string, RouteHandler>();
  const quiet = process.env.EIGEN_QUIET === "1";
  return {
    bus,
    config,
    routes,
    world: () => world,
    setSlot: (source, name, value) => {
      world = setSlot(world, source, name, value);
    },
    contextBlock: () => renderContext(world),
    route: (prefix, handler) => routes.set(prefix, handler),
    log: (module, ...args) => {
      if (!quiet) console.log(`[${new Date().toLocaleTimeString()}] [${module}]`, ...args);
    },
  };
}
