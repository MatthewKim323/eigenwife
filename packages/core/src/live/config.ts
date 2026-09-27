import type { VoiceEngine } from "@eigenwife/protocol";
import { secret } from "../config";

/**
 * Eve Live settings (docs/LIVE.md). Everything is optional: with no key she
 * stays on the classic cascade and the toggle says what's missing.
 *
 *   EVE_VOICE_ENGINE     classic | live (beats ~/.eve/voice.json at boot)
 *   EVE_LIVE_PROVIDER    auto | gateway | openai (auto: gateway first, then OpenAI)
 *   EVE_LIVE_VOICE       gpt-live-1 voice (default gleam: young, soft, North American)
 *   EVE_LIVE_DAILY_MIN   live minutes per day before she falls back to classic (default 60)
 *   EVE_LIVE_IDLE_MIN    close the session after this many quiet minutes, reopen on voice (default 3, 0 = never)
 *   EVE_LIVE_MODEL       default gpt-live-1
 */
export interface LiveConfig {
  /** Engine forced by env, or null to use the persisted choice. */
  envEngine: VoiceEngine | null;
  provider: "auto" | "gateway" | "openai";
  model: string;
  voice: string;
  dailyCapMin: number;
  /** Warn this many minutes before the cap. */
  warnMin: number;
  idleMin: number;
  gatewayKey: string;
  openaiKey: string;
  gatewayUrl: string;
  openaiUrl: string;
}

/** The gpt-live-1 voices (Managing sessions guide), plus marin, the API default. */
export const LIVE_VOICES = ["marin", "quartz", "ripple", "vesper", "willow", "stone", "gleam", "meridian", "bossa", "tempo", "beacon", "delta", "cinder"] as const;

/**
 * Her ElevenLabs voice is young, soft and playful. Of the feminine English
 * voices, gleam (North American, natural) is the closest; willow is softer but
 * Irish, quartz is Australian and generated. Pick by ear with EVE_LIVE_VOICE.
 */
export const DEFAULT_LIVE_VOICE = "gleam";

const num = (v: string, d: number) => {
  const n = Number(v);
  return v.trim() !== "" && Number.isFinite(n) && n >= 0 ? n : d;
};

export function liveConfig(get: (name: string) => string = secret, overrides: Partial<LiveConfig> = {}): LiveConfig {
  const eng = get("EVE_VOICE_ENGINE").toLowerCase();
  const prov = get("EVE_LIVE_PROVIDER").toLowerCase();
  const voice = get("EVE_LIVE_VOICE").toLowerCase() || DEFAULT_LIVE_VOICE;
  return {
    envEngine: eng === "live" || eng === "classic" ? eng : null,
    provider: prov === "gateway" || prov === "openai" ? prov : "auto",
    model: get("EVE_LIVE_MODEL") || "gpt-live-1",
    voice,
    dailyCapMin: num(get("EVE_LIVE_DAILY_MIN"), 60),
    warnMin: 2,
    idleMin: num(get("EVE_LIVE_IDLE_MIN"), 3),
    gatewayKey: get("AI_GATEWAY_API_KEY"),
    openaiKey: get("OPENAI_API_KEY"),
    gatewayUrl: get("EVE_LIVE_GATEWAY_URL") || "https://ai-gateway.vercel.sh",
    openaiUrl: get("EVE_LIVE_OPENAI_URL") || "https://api.openai.com",
    ...overrides,
  };
}

/** Providers to try, in order, given the keys we have. */
export function providerOrder(cfg: LiveConfig): ("gateway" | "openai")[] {
  const out: ("gateway" | "openai")[] = [];
  if ((cfg.provider === "auto" || cfg.provider === "gateway") && cfg.gatewayKey) out.push("gateway");
  if ((cfg.provider === "auto" || cfg.provider === "openai") && cfg.openaiKey) out.push("openai");
  return out;
}

export const NO_ACCESS_REASON = "Eve Live needs OpenAI or gateway credits";
