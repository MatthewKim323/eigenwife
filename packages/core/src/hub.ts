import type { ServerWebSocket } from "bun";
import { BUS_PATH, newId, parseEnvelope, type AnyEnvelope } from "@eigenwife/protocol";
import type { CoreContext, RouteHandler } from "./context";

interface Peer {
  id: string;
  name: string;
}

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
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
export function startHub(ctx: CoreContext & { routes: Map<string, RouteHandler> }) {
  const sockets = new Map<string, ServerWebSocket<Peer>>();
  let fromSocket: string | null = null;

  ctx.bus.tap((e: AnyEnvelope) => {
    const raw = JSON.stringify(e);
    for (const [id, ws] of sockets) {
      if (id === fromSocket) continue;
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
        sockets.set(ws.data.id, ws);
      },
      message(ws, raw) {
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
        fromSocket = ws.data.id;
        try {
          ctx.bus.publish(e);
        } finally {
          fromSocket = null;
        }
      },
      close(ws) {
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
