/**
 * Tray "Voice engine: Classic / Live" (docs/LIVE.md). The core owns the
 * choice (~/.eve/voice.json); the tray mirrors GET /api/live and flips it with
 * POST /api/live/engine. Pure helpers here so they're testable without Electron.
 */

export interface LiveTray {
  engine: "classic" | "live";
  status: string;
  reason?: string;
  usedMin?: number;
  capMin?: number;
  voice?: string;
  providers: string[];
}

export function parseLiveStatus(j: unknown): LiveTray | null {
  if (!j || typeof j !== "object") return null;
  const o = j as Record<string, unknown>;
  if (o.engine !== "classic" && o.engine !== "live") return null;
  return {
    engine: o.engine,
    status: typeof o.status === "string" ? o.status : "off",
    reason: typeof o.reason === "string" ? o.reason : undefined,
    usedMin: typeof o.usedMin === "number" ? o.usedMin : undefined,
    capMin: typeof o.capMin === "number" ? o.capMin : undefined,
    voice: typeof o.voice === "string" ? o.voice : undefined,
    providers: Array.isArray(o.providers) ? o.providers.filter((p): p is string => typeof p === "string") : [],
  };
}

/** The submenu title, with the live state when it matters. */
export function liveMenuLabel(s: LiveTray | null): string {
  if (!s) return "Voice engine (core offline)";
  if (s.status === "no_access") return "Voice engine: Classic (Live needs credits)";
  if (s.status === "capped") return "Voice engine: Classic (Live minutes used up today)";
  if (s.engine === "classic") return "Voice engine: Classic";
  const state = s.status === "live" ? "on" : s.status === "idle" ? "asleep" : s.status === "connecting" ? "connecting" : s.status;
  return `Voice engine: Live (${state})`;
}

/** Info lines under the radio items (disabled menu entries). */
export function liveMenuInfo(s: LiveTray | null): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.reason && (s.status === "no_access" || s.status === "capped" || s.status === "error")) out.push(s.reason.length > 90 ? `${s.reason.slice(0, 87)}...` : s.reason);
  if (s.capMin !== undefined) out.push(`Live today: ${Math.round(s.usedMin ?? 0)} of ${s.capMin} min`);
  if (!s.providers.length) out.push("Live needs AI_GATEWAY_API_KEY or OPENAI_API_KEY");
  return out;
}

export function liveEngineBody(engine: "classic" | "live"): string {
  return JSON.stringify({ engine, by: "tray" });
}
