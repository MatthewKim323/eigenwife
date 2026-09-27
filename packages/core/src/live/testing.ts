import type { Server, ServerWebSocket } from "bun";

/**
 * A faithful fake of the GPT-Live surfaces Eve uses, for hermetic tests:
 *
 *   POST /v1/realtime/client-secrets   AI Gateway client secret ({token, expiresAt}),
 *                                      single use, bound to model + routeKind "live"
 *   WS   /v1/live/sessions             gateway Live socket: subprotocols
 *                                      ai-gateway-realtime.v1 + ai-gateway-auth.<token>,
 *                                      first frame session.start, then the event flow
 *   POST /v1/live/sessions             OpenAI WebRTC create: {session, transport:{type:"webrtc", sdp}}
 *                                      -> 201 {session:{id}, transport:{type:"webrtc", sdp}}
 *
 * Event shapes follow the OpenAI GPT-Live docs and what the real gateway
 * returned in the 2026-09-26 probe (docs/LIVE.md): session.started{session},
 * *.transcript.delta{delta,start_ms,end_ms}, session.delegation.created
 * {offset_ms, delegation:{id,type,target}}, *.appended{client_event_id},
 * session.usage.updated{usage:{seconds}}, session.closed{reason,usage}.
 */

/** Gateway behavior. */
export type FakeMode = "ok" | "no_credits_mint" | "no_credits_ws";

interface Sock {
  id: string;
  started: boolean;
  closed: boolean;
}

export class FakeLiveServer {
  server!: Server<Sock>;
  mode: FakeMode = "ok";
  /** OpenAI direct answers 429 insufficient_quota (the state of the OpenAI key today). */
  openaiNoQuota = false;
  gatewayKey = "gw_test_key";
  openaiKey = "sk_test_key";
  tokens = new Map<string, { model: string; used: boolean }>();
  /** Every client event received on any live socket (audio appends counted, not kept). */
  received: Record<string, unknown>[] = [];
  audioFrames = 0;
  starts: Record<string, unknown>[] = [];
  webrtcCreates: Record<string, unknown>[] = [];
  mints: Record<string, unknown>[] = [];
  private sockets = new Set<ServerWebSocket<Sock>>();
  private t = 0;
  private n = 0;
  usageSeconds = 0;

  start(): this {
    const self = this;
    this.server = Bun.serve<Sock>({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/v1/realtime/client-secrets" && req.method === "POST") return self.mint(req);
        if (url.pathname === "/v1/live/sessions" && req.method === "POST") return self.webrtc(req);
        if (url.pathname === "/v1/live/sessions") {
          const protos = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
          const auth = protos.find((p) => p.startsWith("ai-gateway-auth."))?.slice("ai-gateway-auth.".length);
          const tok = auth ? self.tokens.get(auth) : undefined;
          if (!protos.includes("ai-gateway-realtime.v1") || !tok || tok.used) return new Response("unauthorized", { status: 401 });
          tok.used = true;
          if (srv.upgrade(req, { data: { id: `live_fake_${++self.n}`, started: false, closed: false }, headers: { "Sec-WebSocket-Protocol": "ai-gateway-realtime.v1" } })) return undefined;
          return new Response("upgrade failed", { status: 400 });
        }
        return new Response("not found", { status: 404 });
      },
      websocket: {
        open(ws) {
          self.sockets.add(ws);
        },
        message(ws, raw) {
          let e: Record<string, unknown>;
          try {
            e = JSON.parse(String(raw));
          } catch {
            return;
          }
          self.onClient(ws, e);
        },
        close(ws) {
          self.sockets.delete(ws);
        },
      },
    });
    return this;
  }

  get url(): string {
    return `http://127.0.0.1:${this.server.port}`;
  }

  stop() {
    for (const s of this.sockets) s.close();
    this.server.stop(true);
  }

  private async mint(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${this.gatewayKey}`) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    const body = (await req.json()) as Record<string, unknown>;
    this.mints.push(body);
    if (this.mode === "no_credits_mint")
      return Response.json({ error: { type: "insufficient_funds", message: "AI Gateway requires credits for realtime models. Add credits to continue." } }, { status: 402 });
    if (body.routeKind !== "live" || typeof body.model !== "string") return Response.json({ error: { message: "bad request" } }, { status: 400 });
    const token = `tok_${Math.random().toString(36).slice(2)}`;
    this.tokens.set(token, { model: body.model, used: false });
    return Response.json({ token, expiresAt: Math.floor(Date.now() / 1000) + 60 });
  }

  private async webrtc(req: Request): Promise<Response> {
    if (req.headers.get("authorization") !== `Bearer ${this.openaiKey}`) return Response.json({ error: { message: "Invalid API key" } }, { status: 401 });
    const body = (await req.json()) as { session?: Record<string, unknown>; transport?: { type?: string; sdp?: string } };
    this.webrtcCreates.push(body as Record<string, unknown>);
    if (this.openaiNoQuota)
      return Response.json({ error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } }, { status: 429 });
    if (body.transport?.type !== "webrtc" || !body.transport.sdp) return Response.json({ error: { message: "sdp required" } }, { status: 400 });
    return Response.json({ session: { id: `live_rtc_${++this.n}` }, transport: { type: "webrtc", sdp: "v=0\r\ns=fake-answer\r\n" } }, { status: 201 });
  }

  private eid() {
    return `event_${(++this.n).toString(36)}`;
  }

  private onClient(ws: ServerWebSocket<Sock>, e: Record<string, unknown>) {
    const type = String(e.type ?? "");
    if (type === "session.input_audio.append") {
      this.audioFrames += 1;
      return;
    }
    this.received.push(e);
    if (!ws.data.started) {
      if (type !== "session.start") return this.error(ws, "invalid_request_error", "first event must be session.start", e);
      const session = (e.session ?? {}) as Record<string, unknown>;
      this.starts.push(session);
      if (this.mode === "no_credits_ws") {
        this.error(ws, "insufficient_funds", "Insufficient AI Gateway credits for openai/gpt-live-1", e);
        ws.close(1008, "insufficient credits");
        return;
      }
      if (typeof session.model !== "string" || !String(session.model).endsWith("gpt-live-1")) return this.error(ws, "invalid_request_error", "unknown model", e);
      ws.data.started = true;
      this.t = 0;
      ws.send(JSON.stringify({ event_id: this.eid(), type: "session.started", session: { id: ws.data.id, model: "gpt-live-1", ...session, status: "active" } }));
      return;
    }
    switch (type) {
      case "session.thinking.append":
      case "session.commentary.append":
      case "session.instructions.append": {
        if (!("delegation_id" in e)) return this.error(ws, "invalid_request_error", "delegation_id is required", e);
        const content = String(e.content ?? "");
        if (!content || content.length > 2200) return this.error(ws, "invalid_request_error", "content must be 1..500 tokens", e);
        const ack = type.replace(/append$/, "appended");
        ws.send(JSON.stringify({ type: ack, start_ms: this.t, end_ms: this.t + 200, event_id: this.eid(), client_event_id: e.event_id ?? null }));
        return;
      }
      case "session.update":
        return this.error(ws, "invalid_request_error", "session.update only supports delegation.responses settings", e, "immutable_field_update");
      case "session.close":
        ws.data.closed = true;
        ws.send(JSON.stringify({ event_id: this.eid(), type: "session.closed", reason: "close_requested", usage: { seconds: this.usageSeconds }, session: { id: ws.data.id } }));
        ws.close(1000);
        return;
    }
  }

  private error(ws: ServerWebSocket<Sock>, code: string, message: string, e: Record<string, unknown>, c?: string) {
    ws.send(JSON.stringify({ type: "error", event_id: this.eid(), error: { type: code, code: c ?? code, message, client_event_id: e.event_id ?? null } }));
  }

  // --- scripting the conversation ---------------------------------------------------

  private broadcast(e: Record<string, unknown>) {
    for (const s of this.sockets) if (s.data.started && !s.data.closed) s.send(JSON.stringify({ event_id: this.eid(), ...e }));
  }

  get live(): boolean {
    return [...this.sockets].some((s) => s.data.started && !s.data.closed);
  }

  /** His words, as input transcript deltas (one per word, 200ms apart on the timeline). */
  async userSays(text: string, gapMs = 5) {
    for (const [i, w] of text.split(" ").entries()) {
      this.broadcast({ type: "session.input_transcript.delta", delta: i ? ` ${w}` : w, start_ms: this.t, end_ms: (this.t += 200) });
      if (gapMs) await Bun.sleep(gapMs);
    }
  }

  /** Her words: output transcript deltas plus a little fake audio. */
  async eveSays(text: string, gapMs = 5) {
    for (const [i, w] of text.split(" ").entries()) {
      this.broadcast({ type: "session.output_audio.delta", delta: Buffer.alloc(960).toString("base64") });
      this.broadcast({ type: "session.output_transcript.delta", delta: i ? ` ${w}` : w, start_ms: this.t, end_ms: (this.t += 200) });
      if (gapMs) await Bun.sleep(gapMs);
    }
  }

  delegate(): string {
    const id = `item_${Math.random().toString(36).slice(2, 12)}`;
    this.broadcast({ type: "session.delegation.created", offset_ms: this.t, delegation: { id, type: "delegation", target: "client" } });
    return id;
  }

  usage(seconds: number) {
    this.usageSeconds = seconds;
    this.broadcast({ type: "session.usage.updated", usage: { seconds }, context_window: { usage_ratio: 0.1 } });
  }

  /** Client events of one type, in order. */
  of(type: string): Record<string, unknown>[] {
    return this.received.filter((e) => e.type === type);
  }
}
