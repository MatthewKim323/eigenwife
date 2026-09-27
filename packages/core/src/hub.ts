import type { ServerWebSocket } from "bun";
import { BUS_PATH, newId, parseEnvelope, type AnyEnvelope } from "@eigenwife/protocol";
import type { CoreContext, RouteHandler, SocketHandler, SocketPeer } from "./context";

interface Peer {
  id: string;
  name: string;
  /** Set for sockets on an extra path (ctx.socket), absent for the bus. */
  path?: string;
  peer?: SocketPeer;
  url?: string;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "content-type,authorization",
};

export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...CORS_HEADERS } });
}

/**
 * The bus hub: one Bun server for the websocket bus plus module HTTP routes.
 * Every client message is republished on the in-process bus; every bus event
 * fans out to every client except the one that sent it.
 */
export function startHub(ctx: CoreContext & { routes: Map<string, RouteHandler>; sockets?: Map<string, SocketHandler> }) {
  const extra = ctx.sockets ?? new Map<string, SocketHandler>();
  const sockets = new Map<string, ServerWebSocket<Peer>>();
  // Only the exact envelope a client sent is withheld from that client. Reactions
  // the core publishes synchronously while handling it must still reach the sender.
  let origin: { socket: string; eventId: string } | null = null;

  ctx.bus.tap((e: AnyEnvelope) => {
    const raw = JSON.stringify(e);
    for (const [id, ws] of sockets) {
      if (origin && id === origin.socket && e.id === origin.eventId) continue;
      ws.send(raw);
    }
  });

  const server = Bun.serve<Peer>({
    hostname: ctx.config.host,
    port: ctx.config.port,
    idleTimeout: 120,
    async fetch(req, srv) {
      const url = new URL(req.url);
      if (req.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
      if (url.pathname === BUS_PATH) {
        if (srv.upgrade(req, { data: { id: newId("peer"), name: "anon" } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      const handler = extra.get(url.pathname);
      if (handler) {
        const refused = handler.upgrade?.(req, url);
        if (refused) {
          for (const [k, v] of Object.entries(CORS_HEADERS)) refused.headers.set(k, v);
          return refused;
        }
        if (srv.upgrade(req, { data: { id: newId("sock"), name: url.pathname, path: url.pathname, url: req.url } })) return undefined;
        return new Response("upgrade failed", { status: 400 });
      }
      if (url.pathname === "/health") return json({ ok: true, peers: [...sockets.values()].map((s) => s.data.name), now: Date.now() });
      if (url.pathname === "/world") return json(ctx.world());
      if (url.pathname === "/events") return json(ctx.bus.recent(url.searchParams.get("type") ?? "*", Number(url.searchParams.get("limit") ?? 100)));
      if (url.pathname === "/emit" && req.method === "POST") {
        const e = parseEnvelope(await req.text());
        if (!e) return json({ ok: false, error: "bad envelope" }, 400);
        ctx.bus.publish(e);
        return json({ ok: true, id: e.id });
      }
      // Longest matching prefix wins.
      const prefixes = [...ctx.routes.keys()].filter((p) => url.pathname.startsWith(p)).sort((a, b) => b.length - a.length);
      for (const p of prefixes) {
        const res = await ctx.routes.get(p)!(req, url);
        if (res) {
          for (const [k, v] of Object.entries(CORS_HEADERS)) res.headers.set(k, v);
          return res;
        }
      }
      return json({ ok: false, error: "not found" }, 404);
    },
    websocket: {
      open(ws) {
        if (ws.data.path) {
          const peer: SocketPeer = {
            id: ws.data.id,
            url: new URL(ws.data.url!),
            send: (d) => void ws.send(d as string | Uint8Array),
            close: (code, reason) => ws.close(code, reason),
          };
          ws.data.peer = peer;
          extra.get(ws.data.path)?.open(peer);
          return;
        }
        sockets.set(ws.data.id, ws);
      },
      message(ws, raw) {
        if (ws.data.path) {
          extra.get(ws.data.path)?.message(ws.data.peer!, typeof raw === "string" ? raw : new Uint8Array(raw));
          return;
        }
        const e = parseEnvelope(typeof raw === "string" ? raw : raw.toString());
        if (!e) return;
        if (e.type === "bus.hello") {
          ws.data.name = e.data.client;
          ws.send(
            JSON.stringify({
              type: "bus.welcome",
              ts: Date.now(),
              source: "core",
              id: newId(),
              data: { clientId: ws.data.id, peers: [...sockets.values()].map((s) => s.data.name), world: ctx.world() },
            }),
          );
          ctx.log("hub", `${e.data.client} joined (${e.data.role})`);
        }
        const prev = origin;
        origin = { socket: ws.data.id, eventId: e.id };
        try {
          ctx.bus.publish(e);
        } finally {
          origin = prev;
        }
      },
      close(ws, code, reason) {
        if (ws.data.path) {
          extra.get(ws.data.path)?.close(ws.data.peer!, code, reason);
          return;
        }
        sockets.delete(ws.data.id);
        ctx.log("hub", `${ws.data.name} left`);
      },
    },
  });

  return {
    server,
    port: server.port,
    peers: () => [...sockets.values()].map((s) => s.data.name),
    stop: () => server.stop(true),
  };
}
