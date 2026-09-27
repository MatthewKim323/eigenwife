/**
 * Eve Live relay (docs/LIVE.md). The page (shell or overlay) owns the audio:
 * mic in and her voice out, straight to gpt-live-1 (AI Gateway WebSocket or
 * OpenAI WebRTC). The core owns the brain: it mints the credentials, writes
 * the session config, and handles every non-audio event (transcripts,
 * delegation, usage). They talk over ws://127.0.0.1:7777/live with these
 * messages. The API key never reaches the page: the gateway gets a single-use
 * client secret, and OpenAI WebRTC gets its SDP exchanged by the core.
 */

export const LIVE_PATH = "/live";

/** 24 kHz mono PCM16, 20ms frames: the Live WebSocket audio format. */
export const LIVE_RATE = 24000;
export const LIVE_FRAME = 480;

/** How the page should connect to the provider. */
export type LiveConnectPlan =
  | {
      kind: "websocket";
      provider: "gateway";
      url: string;
      /** WebSocket subprotocols; the gateway takes the client secret here. */
      protocols: string[];
      /** First message after open (session.start with the full session config). */
      start: Record<string, unknown>;
    }
  | {
      kind: "webrtc";
      provider: "openai";
    };

/** core -> page */
export type LiveDown =
  | { type: "engine"; engine: "classic" | "live"; owner: boolean }
  | { type: "connect"; key: string; plan: LiveConnectPlan }
  | { type: "answer"; key: string; sdp: string; sessionId?: string }
  /** A client event to put on the provider connection (session.thinking.append, ...). */
  | { type: "send"; key: string; event: Record<string, unknown> }
  /** Graceful close: send session.close, keep reading until session.closed. */
  | { type: "close"; key: string; reason: string }
  /** Drop the transport now (after close timed out, or engine switched). */
  | { type: "teardown"; key: string }
  /** Session is closed for idleness: wake the core on local voice activity. */
  | { type: "idle"; idle: boolean };

/** page -> core */
export type LiveUp =
  | { type: "hello"; role: "overlay" | "shell"; audio: boolean }
  | { type: "offer"; key: string; sdp: string }
  | { type: "opened"; key: string }
  /** A provider server event, audio deltas excluded. */
  | { type: "event"; key: string; event: Record<string, unknown> }
  | { type: "closed"; key: string; code?: number; reason?: string }
  | { type: "fail"; key: string; message: string }
  /** Local voice activity while the session is idle-closed. */
  | { type: "activity" }
  /** Her audio is audibly playing (analyser RMS), for exact speaking(). */
  | { type: "playback"; speaking: boolean };

export function parseLive<T extends { type: string }>(raw: string): T | null {
  try {
    const x = JSON.parse(raw);
    return x && typeof x === "object" && typeof x.type === "string" ? (x as T) : null;
  } catch {
    return null;
  }
}
