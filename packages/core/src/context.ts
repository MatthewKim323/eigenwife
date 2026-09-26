import { emptyWorld, reduceWorld, renderContext, setSlot, type AnyEnvelope, type WorldSnapshot } from "@eigenwife/protocol";
import type { EventBus } from "./bus";
import type { CoreConfig } from "./config";
import type { ServiceMap } from "./services";

export type RouteHandler = (req: Request, url: URL) => Response | Promise<Response> | null | Promise<Response | null>;

/** One accepted websocket on an extra path (not the bus). */
export interface SocketPeer {
  id: string;
  url: URL;
  send(data: string | ArrayBuffer | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/**
 * A websocket endpoint other than /bus (e.g. /ears for streamed mic audio).
 * upgrade() may return a Response to refuse the connection.
 */
export interface SocketHandler {
  upgrade?(req: Request, url: URL): Response | null;
  open(peer: SocketPeer): void;
  message(peer: SocketPeer, data: string | Uint8Array): void;
  close(peer: SocketPeer, code: number, reason: string): void;
}

/** Everything a module gets. Modules never import each other directly: they talk over the bus. */
export interface CoreContext {
  bus: EventBus;
  config: CoreConfig;
  world(): WorldSnapshot;
  setSlot(source: string, name: string, value: string | null): void;
  contextBlock(): string;
  /** Register an HTTP route on the core server (prefix match). */
  route(prefix: string, handler: RouteHandler): void;
  /** Register a websocket endpoint on an exact path. */
  socket(path: string, handler: SocketHandler): void;
  log(module: string, ...args: unknown[]): void;
  provide<K extends keyof ServiceMap>(name: K, impl: ServiceMap[K]): void;
  /** Resolve a service at call time. Throws if nobody provides it. */
  use<K extends keyof ServiceMap>(name: K): ServiceMap[K];
  tryUse<K extends keyof ServiceMap>(name: K): ServiceMap[K] | null;
}

export interface Module {
  name: string;
  start(ctx: CoreContext): void | Promise<void>;
  stop?(): void | Promise<void>;
}

export function createContext(
  bus: EventBus,
  config: CoreConfig,
): CoreContext & { routes: Map<string, RouteHandler>; sockets: Map<string, SocketHandler> } {
  let world = emptyWorld();
  bus.on("*", (e: AnyEnvelope) => {
    world = reduceWorld(world, e);
  });
  const routes = new Map<string, RouteHandler>();
  const sockets = new Map<string, SocketHandler>();
  const services = new Map<keyof ServiceMap, unknown>();
  const quiet = process.env.EIGEN_QUIET === "1";
  return {
    bus,
    config,
    routes,
    sockets,
    world: () => world,
    setSlot: (source, name, value) => {
      world = setSlot(world, source, name, value);
    },
    contextBlock: () => renderContext(world),
    route: (prefix, handler) => routes.set(prefix, handler),
    socket: (path, handler) => sockets.set(path, handler),
    provide: (name, impl) => {
      services.set(name, impl);
    },
    use: (name) => {
      const s = services.get(name);
      if (!s) throw new Error(`service "${name}" is not provided`);
      return s as never;
    },
    tryUse: (name) => (services.get(name) as never) ?? null,
    log: (module, ...args) => {
      if (!quiet) console.log(`[${new Date().toLocaleTimeString()}] [${module}]`, ...args);
    },
  };
}
