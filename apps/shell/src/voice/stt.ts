/**
 * Where speech-to-text comes from. Pure, so it's testable.
 *
 *   ?stt=browser   Chrome Web Speech (the default in a browser tab)
 *   ?stt=deepgram  mic audio streamed to core ws /ears, Deepgram nova-3
 *   ?stt=auto      deepgram when GET /api/ears/status says available, else browser
 *
 * The desktop overlay (?mode=overlay) always uses deepgram: Electron has no
 * Web Speech backend.
 */

export type SttSource = "browser" | "deepgram";
export type SttPref = SttSource | "auto";

export function sttPref(search: string, overlay: boolean): SttPref {
  if (overlay) return "deepgram";
  const v = new URLSearchParams(search).get("stt");
  return v === "deepgram" || v === "auto" || v === "browser" ? v : "browser";
}

/** Resolve a preference against what the core reports (null = core unreachable). */
export function chooseStt(pref: SttPref, earsAvailable: boolean | null, browserSupported: boolean): SttSource {
  if (pref !== "auto") return pref;
  if (earsAvailable) return "deepgram";
  return browserSupported ? "browser" : "deepgram";
}

export async function earsAvailable(coreHttp: string, timeoutMs = 1500, f: typeof fetch = fetch): Promise<boolean | null> {
  try {
    const r = await f(`${coreHttp}/api/ears/status`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return false;
    const j = (await r.json()) as { available?: boolean };
    return !!j.available;
  } catch {
    return null;
  }
}

/** http://host:port -> ws://host:port/ears?... */
export function earsUrl(coreHttp: string, client: string): string {
  const u = new URL(coreHttp);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ears";
  u.search = new URLSearchParams({ encoding: "linear16", sample_rate: "16000", client }).toString();
  return u.toString();
}
