import { appleScriptString } from "../osa";
import type { ActionDef } from "../types";

/**
 * Music on matt's real Spotify desktop app, driven with AppleScript: instant,
 * no API quota. "let's listen to music" plays our song (EVE_SONG_URI, default
 * GGEZ); "play <anything>" resolves a track through Zo's Spotify search when Zo
 * is connected. Pause / skip / resume are plain player commands.
 */
export const DEFAULT_SONG_URI = "spotify:track:6iwsWcvqCQcj025NqCeyFS";

export function spotifyUri(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim();
  const m = /^spotify:(track|album|playlist|artist):[A-Za-z0-9]{10,40}$/.exec(t);
  if (m) return t;
  const u = /open\.spotify\.com\/(track|album|playlist|artist)\/([A-Za-z0-9]{10,40})/.exec(t);
  return u ? `spotify:${u[1]}:${u[2]}` : null;
}

export const PLAY_SCRIPT = (uri: string) =>
  `tell application "Spotify"\n  play track ${appleScriptString(uri)}\n  delay 0.4\n  return (name of current track) & " by " & (artist of current track)\nend tell`;
export const CONTROL_SCRIPT: Record<"pause" | "resume" | "next" | "previous", string> = {
  pause: `tell application "Spotify" to pause\nreturn "paused"`,
  resume: `tell application "Spotify" to play\nreturn "playing"`,
  next: `tell application "Spotify"\n  next track\n  delay 0.4\n  return (name of current track) & " by " & (artist of current track)\nend tell`,
  previous: `tell application "Spotify"\n  previous track\n  delay 0.4\n  return (name of current track) & " by " & (artist of current track)\nend tell`,
};

const OUR_SONG = /^(?:|music|some music|something|a song|our song|the song|my song|that song|a vibe|vibes)$/i;

export const musicPlay: ActionDef = {
  kind: "music.play",
  permission: "SAFE_ACTION",
  describe: (a) => `play ${String(a.query ?? a.uri ?? "our song")} on Spotify`,
  targets: () => ["Spotify"],
  cursorApp: () => "Spotify",
  async run(args, env) {
    let uri = spotifyUri(args.uri) ?? spotifyUri(args.query);
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!uri && OUR_SONG.test(query)) uri = spotifyUri(env.deps.env("EVE_SONG_URI")) ?? DEFAULT_SONG_URI;
    if (!uri) {
      const zo = env.ctx.tryUse("zo");
      if (!zo) return { ok: false, observation: `can't search Spotify for "${query}" without Zo; our song works though` };
      const r = await zo.client.ask(`Search Spotify for the track "${query}". Reply with ONLY its Spotify URI (spotify:track:...), nothing else. Do not play anything.`, { timeoutMs: 20_000 });
      uri = spotifyUri(/spotify:track:[A-Za-z0-9]+/.exec(r.output ?? "")?.[0]);
      if (!uri) return { ok: false, observation: `couldn't find "${query}" on Spotify` };
    }
    const r = await env.deps.osa(PLAY_SCRIPT(uri), { timeoutMs: 12_000 });
    if (!r.ok) return { ok: false, observation: `Spotify didn't play: ${r.stderr || "is the app installed and logged in?"}` };
    return { ok: true, observation: `now playing ${r.stdout || uri}` };
  },
};

export const musicControl: ActionDef = {
  kind: "music.control",
  permission: "SAFE_ACTION",
  describe: (a) => `${String(a.op ?? "pause")} the music`,
  targets: () => ["Spotify"],
  cursorApp: () => "Spotify",
  async run(args, env) {
    const op = String(args.op ?? "pause") as keyof typeof CONTROL_SCRIPT;
    const script = CONTROL_SCRIPT[op];
    if (!script) return { ok: false, observation: `unknown music control ${op}` };
    const r = await env.deps.osa(script, { timeoutMs: 10_000 });
    return r.ok ? { ok: true, observation: op === "next" || op === "previous" ? `now playing ${r.stdout}` : r.stdout } : { ok: false, observation: `Spotify: ${r.stderr}` };
  },
};
