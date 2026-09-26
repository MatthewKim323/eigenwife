import { expect, test } from "bun:test";
import { join } from "path";
import { isEnvelope } from "@eigenwife/protocol";
import { detail, mapHook } from "../../../watcher/claude-hook";

const WATCHER = join(import.meta.dir, "..", "..", "..", "watcher");

test("claude hook maps tool runs to thinking and Stop to happy", () => {
  expect(mapHook({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/a/b/module.ts" } })).toEqual([
    { type: "avatar.state", data: { state: "thinking" } },
    { type: "diag", data: { label: "claude", value: "Edit module.ts", ttlMs: 8000 } },
  ]);
  const stop = mapHook({ hook_event_name: "Stop" });
  expect(stop[0]).toEqual({ type: "avatar.mood", data: { mood: "happy", intensity: 0.8, holdMs: 2500 } });
  expect(stop[1]).toEqual({ type: "avatar.state", data: { state: "idle" } });
  expect(mapHook({ hook_event_name: "SessionStart" })).toEqual([]);
  expect(mapHook({})).toEqual([]);
});

test("claude hook detail is short and never the whole command", () => {
  expect(detail("Bash", { command: "curl -H 'Authorization: Bearer secret' https://x" })).toBe("Bash curl");
  expect(detail("WebFetch", { url: "https://docs.firecrawl.dev/api/x" })).toBe("WebFetch docs.firecrawl.dev");
  expect(detail("Grep", { pattern: "x".repeat(200) }).length).toBe(60);
});

test("claude hook exits 0 and prints nothing when the core is down", async () => {
  const p = Bun.spawn(["bun", join(WATCHER, "claude-hook.ts")], { stdin: "pipe", stdout: "pipe", env: { ...process.env, EIGEN_CORE: "http://127.0.0.1:9" } });
  p.stdin.write(JSON.stringify({ hook_event_name: "Stop" }));
  p.stdin.end();
  expect(await p.exited).toBe(0);
  expect(await new Response(p.stdout).text()).toBe("");
});

test("watcher parses lsappinfo output and emits valid envelopes", async () => {
  const code = `
import sys, json
sys.path.insert(0, ${JSON.stringify(WATCHER)})
import watch
out = '"LSDisplayName"="Tinder"\\n"CFBundleIdentifier"="com.cardify.tinder"\\n'
print(json.dumps([watch.parse_lsappinfo_field(out, "LSDisplayName"), watch.parse_lsappinfo_field(out, "CFBundleIdentifier"), watch.parse_lsappinfo_field('"x"=[ NULL ]', "x")]))
p = watch.Poster("http://127.0.0.1:9", dry_run=True)
t = watch.AppTracker(p)
t.focused("Tinder", "com.cardify.tinder")
t.focused("Tinder", "com.cardify.tinder")
t.launched("Spotify", None)
`;
  const p = Bun.spawn(["python3", "-c", code], { stdout: "pipe", stderr: "pipe" });
  const out = (await new Response(p.stdout).text()).trim().split("\n");
  expect(await p.exited).toBe(0);
  expect(JSON.parse(out[0]!)).toEqual(["Tinder", "com.cardify.tinder", null]);
  const envs = out.slice(1).map((l) => JSON.parse(l));
  // The repeated focus was deduped.
  expect(envs.map((e) => e.type)).toEqual(["app.focused", "app.opened"]);
  expect(envs.every(isEnvelope)).toBe(true);
  expect(envs[0].data).toEqual({ app: "Tinder", bundleId: "com.cardify.tinder" });
  expect(envs[1].source).toBe("watcher");
});
