import { expect, test } from "bun:test";
import { CONTROL_SCRIPT, DEFAULT_SONG_URI, musicControl, musicPlay, PLAY_SCRIPT, spotifyUri } from "../src/agency/actions/music";
import { readIntent } from "../src/reflex/intent";

test("music intents: vibes, our song, a named song, controls; games and idioms stay chat", () => {
  expect(readIntent("yo lets listen to music bro").music).toEqual({ op: "play" });
  expect(readIntent("let's listen to some music").music).toEqual({ op: "play" });
  expect(readIntent("play our song").music).toEqual({ op: "play", query: "our song" });
  expect(readIntent("play ggez").music).toEqual({ op: "play", query: "ggez" });
  expect(readIntent("can you put on some frank ocean").music).toEqual({ op: "play", query: "frank ocean" });
  expect(readIntent("pause the music").music).toEqual({ op: "pause" });
  expect(readIntent("skip").music).toEqual({ op: "next" });
  expect(readIntent("next song").music).toEqual({ op: "next" });
  expect(readIntent("resume").music).toEqual({ op: "resume" });
  expect(readIntent("wanna play league").music).toBeNull();
  expect(readIntent("just play it cool").music).toBeNull();
  expect(readIntent("what do you think about this").music).toBeNull();
  // music wins over the generic close/quit command
  expect(readIntent("play our song").command).toBeNull();
});

test("spotify uris from uris and share links", () => {
  expect(spotifyUri("https://open.spotify.com/track/6iwsWcvqCQcj025NqCeyFS?si=abc")).toBe(DEFAULT_SONG_URI);
  expect(spotifyUri(DEFAULT_SONG_URI)).toBe(DEFAULT_SONG_URI);
  expect(spotifyUri("ggez")).toBeNull();
  expect(spotifyUri('spotify:track:x" & do shell script "rm')).toBeNull();
});

function env(over: { osa?: (s: string) => any; zo?: any; vars?: Record<string, string> } = {}) {
  const scripts: string[] = [];
  return {
    scripts,
    env: {
      deps: {
        osa: async (s: string) => {
          scripts.push(s);
          return over.osa ? over.osa(s) : { ok: true, stdout: "GGEZ by Someone", stderr: "" };
        },
        env: (n: string) => over.vars?.[n] ?? "",
      },
      ctx: { tryUse: (n: string) => (n === "zo" ? (over.zo ?? null) : null) },
    } as any,
  };
}

test("music.play: our song by default, env override, search via zo, safe applescript", async () => {
  const a = env();
  expect((await musicPlay.run({ query: "our song" }, a.env)).observation).toBe("now playing GGEZ by Someone");
  expect(a.scripts[0]).toBe(PLAY_SCRIPT(DEFAULT_SONG_URI));
  const b = env({ vars: { EVE_SONG_URI: "spotify:track:AAAAAAAAAAAAAAAAAAAAAA" } });
  await musicPlay.run({ query: "music" }, b.env);
  expect(b.scripts[0]).toContain("spotify:track:AAAAAAAAAAAAAAAAAAAAAA");
  const c = env({ zo: { client: { ask: async () => ({ ok: true, output: "spotify:track:BBBBBBBBBBBBBBBBBBBBBB" }) } } });
  expect((await musicPlay.run({ query: "nights frank ocean" }, c.env)).ok).toBe(true);
  expect(c.scripts[0]).toContain("spotify:track:BBBBBBBBBBBBBBBBBBBBBB");
  const d = env();
  expect((await musicPlay.run({ query: "nights frank ocean" }, d.env)).ok).toBe(false);
  expect(d.scripts.length).toBe(0);
  expect(musicPlay.permission).toBe("SAFE_ACTION");
});

test("music.control maps ops to player commands", async () => {
  const a = env({ osa: (s) => ({ ok: true, stdout: s.includes("pause") ? "paused" : "Next by X", stderr: "" }) });
  expect((await musicControl.run({ op: "pause" }, a.env)).observation).toBe("paused");
  expect(a.scripts[0]).toBe(CONTROL_SCRIPT.pause);
  expect((await musicControl.run({ op: "nuke" }, a.env)).ok).toBe(false);
});
