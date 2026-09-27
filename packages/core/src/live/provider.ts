import { LIVE_RATE, type LiveConnectPlan } from "@eigenwife/protocol";
import type { LiveConfig } from "./config";

/**
 * The two ways into gpt-live-1, both keeping the key in the core:
 *
 *  gateway  POST {gateway}/v1/realtime/client-secrets {model, routeKind:"live"}
 *           -> single-use token; the page opens wss://.../v1/live/sessions with
 *           subprotocols ai-gateway-realtime.v1 + ai-gateway-auth.<token> and
 *           sends session.start. WebSocket only, client delegation only.
 *  openai   the page makes a WebRTC offer, the core POSTs {session, transport:
 *           {type:"webrtc", sdp}} to /v1/live/sessions and hands back the
 *           answer. Audio rides the media tracks, events the "oai-events"
 *           data channel.
 */

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export type AccessKind = "no_key" | "no_credits" | "network" | "error";

export class LiveAccessError extends Error {
  constructor(
    readonly kind: AccessKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Words providers use for "you can't use this model right now". */
const CREDIT_RE =
  /credit|insufficient|quota|billing|payment|balance|funds|free[ -]?tier|upgrade|not (?:available|enabled|allowed)|no access|does not have access|model_not_found|unsupported model|permission|forbidden|rate.?limit|limit exceeded/i;

/** Is this HTTP failure (or error event) about access/credits rather than a bug? */
export function isAccessProblem(status: number | undefined, text: string): boolean {
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return CREDIT_RE.test(text);
}

export function classify(status: number, body: string): LiveAccessError {
  const detail = body.replace(/\s+/g, " ").slice(0, 200);
  return new LiveAccessError(isAccessProblem(status, body) ? "no_credits" : "error", `http ${status}: ${detail}`, status);
}

export interface SessionConfigInput {
  instructions: string;
  input: Record<string, unknown>[];
}

/** The session object for session.start (WebSocket) or the WebRTC create call. */
export function sessionConfig(cfg: LiveConfig, provider: "gateway" | "openai", s: SessionConfigInput): Record<string, unknown> {
  const model = provider === "gateway" && !cfg.model.includes("/") ? `openai/${cfg.model}` : cfg.model;
  const audio: Record<string, unknown> = { output: { voice: cfg.voice } };
  // WebRTC negotiates its format in SDP; the WebSocket needs it spelled out.
  if (provider === "gateway") audio.format = { type: "audio/pcm", rate: LIVE_RATE };
  return {
    model,
    store: false,
    delegation: { type: "client" },
    audio,
    instructions: s.instructions,
    ...(s.input.length ? { input: s.input } : {}),
  };
}

/** Gateway: mint a single-use client secret and describe the WebSocket connect. */
export async function gatewayPlan(cfg: LiveConfig, fetcher: Fetcher, session: Record<string, unknown>): Promise<LiveConnectPlan> {
  if (!cfg.gatewayKey) throw new LiveAccessError("no_key", "no AI_GATEWAY_API_KEY");
  let res: Response;
  try {
    res = await fetcher(`${cfg.gatewayUrl}/v1/realtime/client-secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.gatewayKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: session.model, routeKind: "live" }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    throw new LiveAccessError("network", `gateway unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.text();
  if (!res.ok) throw classify(res.status, body);
  let token = "";
  try {
    token = String((JSON.parse(body) as { token?: string }).token ?? "");
  } catch {}
  if (!token) throw new LiveAccessError("error", "gateway returned no token");
  const wsBase = cfg.gatewayUrl.replace(/^http/, "ws");
  return {
    kind: "websocket",
    provider: "gateway",
    url: `${wsBase}/v1/live/sessions`,
    protocols: ["ai-gateway-realtime.v1", `ai-gateway-auth.${token}`],
    start: { type: "session.start", session },
  };
}

/** OpenAI WebRTC: exchange the page's SDP offer for an answer (the HTTP call starts the session). */
export async function openaiAnswer(cfg: LiveConfig, fetcher: Fetcher, session: Record<string, unknown>, sdp: string): Promise<{ sdp: string; sessionId?: string }> {
  if (!cfg.openaiKey) throw new LiveAccessError("no_key", "no OPENAI_API_KEY");
  let res: Response;
  try {
    res = await fetcher(`${cfg.openaiUrl}/v1/live/sessions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ session, transport: { type: "webrtc", sdp } }),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new LiveAccessError("network", `openai unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  const body = await res.text();
  if (!res.ok) throw classify(res.status, body);
  try {
    const j = JSON.parse(body) as { session?: { id?: string }; transport?: { sdp?: string } };
    if (!j.transport?.sdp) throw new Error("no sdp");
    return { sdp: j.transport.sdp, sessionId: j.session?.id };
  } catch {
    throw new LiveAccessError("error", "openai returned no SDP answer");
  }
}
