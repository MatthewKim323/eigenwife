import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import { startCore, type RunningCore } from "../src/index";
import { homeModule, type HomeServiceImpl } from "../src/home/module";
import { HomeStore } from "../src/home/store";
import { memoriesSummary, restoreFromZo, ZoMirror } from "../src/home/zo";
import { ZoClient, parseMcpBody } from "../src/zo/client";
import { parseMapsSearch, parseNowPlaying, toRfc3339, zoApps, type ZoService } from "../src/zo/apps";
import { parseKwargs, parsePy } from "../src/zo/repr";
import { SpotifyPoller } from "../src/zo/spotify";
import { calendarCreateAlias, calendarCreateEvent, calendarDeleteEvent, calendarFreeBusy, CREATE_EVENT_JXA } from "../src/agency/actions/calendar";
import { placesSearchAction } from "../src/agency/actions/places";
import type { ActionEnv, AgencyDeps } from "../src/agency/types";
import type { OsaRunner } from "../src/agency/osa";
import { fakeZoServer, SAMPLE_CREATE, SAMPLE_DELETE, SAMPLE_MAPS, SAMPLE_SPOTIFY_NOTHING, SAMPLE_SPOTIFY_PLAYING } from "./zo.fakes";

process.env.EIGEN_QUIET = "1";

const stops: (() => unknown)[] = [];
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "eve-zo-"));
  dirs.push(d);
  return d;
};
let cores: RunningCore[] = [];
afterEach(async () => {
  for (const c of cores) await c.stop();
  cores = [];
  for (const s of stops.splice(0)) await s();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function server(o: Parameters<typeof fakeZoServer>[0] = {}) {
  const s = fakeZoServer(o);
  stops.push(s.stop);
  return s;
}

function client(url: string, o: Partial<ConstructorParameters<typeof ZoClient>[0]> = {}) {
  const c = new ZoClient({ apiKey: "zo_sk_test", baseUrl: url, keepaliveMs: 0, ...o });
  stops.push(() => c.close());
  return c;
}

// --- repr ----------------------------------------------------------------------------

test("repr: Zo's python-style results parse", () => {
  expect(parsePy("{'a': True, 'b': None, 'c': [1, 2.5, -3], 'd': \"it's\", 'e': (1,)}")).toEqual({ a: true, b: null, c: [1, 2.5, -3], d: "it's", e: [1] });
  expect(parsePy("'line\\nnext \\u00e9'")).toBe("line\nnext \u00e9");
  expect(parsePy("MapPlace(title='X', rating=4.5, uri=None)")).toEqual({ __type: "MapPlace", title: "X", rating: 4.5, uri: null });
  const kw = parseKwargs(SAMPLE_SPOTIFY_NOTHING);
  expect(kw.ret).toEqual({ playing: false });
  expect((kw.exports as any)["$summary"]).toContain("Nothing");
  expect(parsePy("{'broken': ")).toBeUndefined();
});

test("mcp body: JSON, batches and multi-line SSE frames", () => {
  expect(parseMcpBody('{"jsonrpc":"2.0","id":1,"result":{}}', "application/json")).toHaveLength(1);
  expect(parseMcpBody('[{"id":1},{"id":2}]', "application/json")).toHaveLength(2);
  const sse = 'event: message\ndata: {"jsonrpc":"2.0",\ndata: "id":3,"result":{"ok":true}}\n\n: comment\n\n';
  expect(parseMcpBody(sse, "text/event-stream")[0]).toEqual({ jsonrpc: "2.0", id: 3, result: { ok: true } });
});

// --- client -----------------------------------------------------------------------------

test("client: initialize once, session header echoed, Accept header, bearer", async () => {
  for (const sse of [false, true]) {
    const s = server({ sse, tools: { echo: (a) => `hi ${a.who}` } });
    const c = client(s.url);
    const [a, b] = await Promise.all([c.call("echo", { who: "eve" }), c.call("echo", { who: "matt" })]);
    expect(a).toMatchObject({ ok: true, text: "hi eve" });
    expect(b.ok).toBe(true);
    expect(s.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
    const calls = s.calls("echo");
    expect(calls.every((r) => r.session === "s1")).toBe(true);
    expect(calls[0]!.accept).toBe("application/json, text/event-stream");
    expect(calls[0]!.auth).toBe("Bearer zo_sk_test");
    expect(c.status()).toMatchObject({ configured: true, connected: true, session: true });
  }
});

test("client: a forgotten session (404) re-initializes and retries once", async () => {
  const s = server({ tools: { echo: () => "ok" } });
  const c = client(s.url);
  expect((await c.call("echo", {})).ok).toBe(true);
  s.expireSessions();
  const r = await c.call("echo", {});
  expect(r.ok).toBe(true);
  expect(s.requests.filter((x) => x.method === "initialize")).toHaveLength(2);
  expect(s.calls("echo").at(-1)!.session).toBe("s2");
});

test("client: tool errors carry Zo's code; timeouts and dead servers resolve, never throw", async () => {
  const s = server({ tools: { bad: () => ({ text: "Error: must be an absolute path\ncode: invalid_path", isError: true }), slow: () => Bun.sleep(2000).then(() => "late") } });
  const c = client(s.url);
  const bad = await c.call("bad", {});
  expect(bad).toMatchObject({ ok: false, code: "invalid_path", error: "must be an absolute path" });
  const t0 = Date.now();
  const slow = await c.call("slow", {}, { timeoutMs: 150 });
  expect(slow).toMatchObject({ ok: false, code: "timeout" });
  expect(Date.now() - t0).toBeLessThan(1000);

  const dead = client("http://127.0.0.1:9");
  const d = await dead.call("anything", {}, { timeoutMs: 500 });
  expect(d.ok).toBe(false);
  expect(dead.status().connected).toBe(false);
  expect(dead.status().lastError).toBeTruthy();
  expect((await dead.ping(500)).ok).toBe(false);
});

test("client: at most 2 in flight, background work holds one lane, high priority jumps the queue", async () => {
  const order: string[] = [];
  const s = server({ tools: { work: async (a) => (await Bun.sleep(60), order.push(a.tag), a.tag) } });
  const c = client(s.url);
  await c.ping();
  const lows = Array.from({ length: 4 }, (_, i) => c.call("work", { tag: `low${i}` }, { priority: "low" }));
  await Bun.sleep(5);
  // One low is running; the second lane stays free for this booking.
  const high = c.call("work", { tag: "high" }, { priority: "high" });
  await Promise.all([...lows, high]);
  expect(s.maxInflight()).toBeLessThanOrEqual(2);
  expect(order.indexOf("high")).toBeLessThanOrEqual(1);
  expect(order.filter((x) => x.startsWith("low"))).toEqual(["low0", "low1", "low2", "low3"]);
  const st = c.status();
  expect(st.calls.work!.n).toBe(5);
  expect(st.calls.work!.p95).toBeGreaterThanOrEqual(st.calls.work!.p50);
  expect(st.inflight).toBe(0);
});

test("client: warm() initializes in the background and ping is cheap", async () => {
  const s = server();
  const c = client(s.url, { keepaliveMs: 50 });
  c.warm();
  await Bun.sleep(180);
  expect(s.requests.filter((r) => r.method === "initialize")).toHaveLength(1);
  expect(s.requests.filter((r) => r.method === "ping").length).toBeGreaterThanOrEqual(2);
  c.close();
});

// --- apps -------------------------------------------------------------------------------

test("apps: RFC3339 in Los Angeles time, DST aware", () => {
  expect(toRfc3339(Date.parse("2026-09-27T02:30:00Z"))).toBe("2026-09-26T19:30:00-07:00");
  expect(toRfc3339(Date.parse("2026-12-01T20:00:00Z"))).toBe("2026-12-01T12:00:00-08:00");
});

test("apps: maps_search parses to named places with price, rating, dish, url", () => {
  const { places, summary } = parseMapsSearch(SAMPLE_MAPS, "Irvine, CA");
  expect(summary).toContain("cheap spicy ramen");
  expect(places.map((p) => p.name)).toEqual(["Kitakata Ramen Ban Nai - Irvine", "Silverlake Ramen", "HiroNori Craft Ramen"]);
  expect(places[0]).toMatchObject({ price: "$10-20", cost: 15, rating: 4.4, address: "Irvine, CA", url: "https://maps.google.com/maps?cid=11892275661009871434" });
  expect(places[0]!.dish).toContain("spicy miso");
  expect(places[0]!.why).toContain("spicy");
  expect(places[2]).toMatchObject({ price: "$20-30", cost: 25, rating: 4.6 });
  expect(parseMapsSearch("garbage").places).toEqual([]);
});

test("apps: Spotify now playing, nothing and something", () => {
  expect(parseNowPlaying(SAMPLE_SPOTIFY_NOTHING)).toEqual({ playing: false });
  expect(parseNowPlaying(SAMPLE_SPOTIFY_PLAYING("Someone Like You", "Adele", "t1", 5000))).toMatchObject({ playing: true, track: "Someone Like You", artist: "Adele", id: "t1", progressMs: 5000 });
});

test("apps: calendar create/get/list/delete speak Zo's configured_props", async () => {
  const created: any[] = [];
  const s = server({
    tools: {
      "use_app_google_calendar:google_calendar-create-event": (a) => {
        const p = a.configured_props;
        created.push(p);
        return SAMPLE_CREATE("abc123", p.summary, p.eventStartDate, p.eventEndDate);
      },
      "use_app_google_calendar:google_calendar-list-events": () =>
        `exports={} os=[] ret=[{'id': 'e1', 'summary': 'gym', 'start': {'dateTime': '2026-09-26T18:00:00-07:00'}, 'end': {'dateTime': '2026-09-26T19:15:00-07:00'}}, {'id': 'e2', 'summary': 'holiday', 'start': {'date': '2026-09-26'}, 'end': {'date': '2026-09-27'}}] stash_id=None`,
      "use_app_google_calendar:google_calendar-delete-event": (a) => SAMPLE_DELETE(a.configured_props.eventId),
    },
  });
  const zo = zoApps(client(s.url));
  const start = Date.parse("2026-09-27T02:30:00Z");
  const r = await zo.createEvent({ title: "Ramen", start, end: start + 90 * 60_000, location: "Irvine", description: "booked by Eve" });
  expect(r.ok).toBe(true);
  expect(r.value).toMatchObject({ id: "abc123", title: "Ramen", start, htmlLink: "https://www.google.com/calendar/event?eid=abc123" });
  expect(created[0]).toMatchObject({ calendarId: "primary", eventStartDate: "2026-09-26T19:30:00-07:00", eventEndDate: "2026-09-26T21:00:00-07:00", timeZone: "America/Los_Angeles", location: "Irvine", sendUpdates: "none" });
  const list = await zo.listEvents(start - 3600_000, start + 3600_000);
  expect(list.value!.map((e) => [e.id, !!e.allDay])).toEqual([
    ["e1", false],
    ["e2", true],
  ]);
  expect((await zo.deleteEvent("abc123")).ok).toBe(true);
  const call = s.calls("google_calendar-list-events")[0]!;
  expect(call.params.arguments.configured_props).toMatchObject({ singleEvents: true, orderBy: "startTime", fields: "compact" });
});

test("apps: maps results are cached 10 min and a prefetch in flight is shared", async () => {
  const s = server({ delayMs: 40, tools: { maps_search: () => SAMPLE_MAPS } });
  const zo = zoApps(client(s.url));
  const q = { query: "cheap spicy ramen", location: "Irvine, CA", openNow: true, cheap: true };
  zo.prefetchMaps(q);
  const a = await zo.maps(q);
  expect(a.ok).toBe(true);
  expect(a.cached).toBe(true);
  const b = await zo.maps(q);
  expect(b).toMatchObject({ cached: true, ms: 0 });
  expect(s.calls("maps_search")).toHaveLength(1);
  expect(s.calls("maps_search")[0]!.params.arguments).toMatchObject({ query: "cheap spicy ramen", location: "Irvine, CA", open_now: "true", price_level: "PRICE_LEVEL_INEXPENSIVE" });
});

// --- mirror + restore ---------------------------------------------------------------

test("mirror: debounced, only changed files, absolute /home/workspace/eve paths", async () => {
  const s = server();
  const zo = zoApps(client(s.url));
  const m = new ZoMirror({ zo, debounceMs: 30 });
  m.enqueue("profile.json", "v1");
  m.enqueue("profile.json", "v2");
  m.enqueue("memories.jsonl", "m1");
  await Bun.sleep(150);
  expect(s.calls("write_file")).toHaveLength(2);
  expect(s.files.get("/home/workspace/eve/profile.json")).toBe("v2");
  expect(m.lastSyncAt).toBeGreaterThan(0);
  m.enqueue("profile.json", "v2");
  m.enqueue("memories.jsonl", "m2");
  const r = await m.flush();
  expect(r.files).toEqual(["memories.jsonl"]);
  expect(s.calls("write_file")).toHaveLength(3);
  m.stop();
});

test("mirror: write_file failure falls back to /zo/ask; total failure keeps files dirty", async () => {
  const s = server({ tools: { write_file: () => ({ text: "Error: disk full\ncode: write_failed", isError: true }) } });
  const zo = zoApps(client(s.url));
  const m = new ZoMirror({ zo, debounceMs: 5 });
  m.enqueue("profile.json", '{"persona":null}');
  const r = await m.flush();
  expect(r).toMatchObject({ ok: true, via: "ask" });
  expect(s.asks[0]).toContain("/home/workspace/eve/profile.json");

  const dead = zoApps(client("http://127.0.0.1:9", { timeoutMs: 300 }));
  const m2 = new ZoMirror({ zo: dead, debounceMs: 5 });
  m2.enqueue("profile.json", "x");
  const r2 = await m2.flush();
  expect(r2.ok).toBe(false);
  expect(m2.lastSyncAt).toBeUndefined();
  expect(m2.dirty()).toEqual(["profile.json"]);
});

test("restore: an empty ~/.eve comes back from Zo, bad json is skipped", async () => {
  const s = server();
  s.files.set("/home/workspace/eve/profile.json", '{"persona":{"name":"Eve"},"bornAt":1}\n');
  s.files.set("/home/workspace/eve/memories.jsonl", '{"id":"m1","content":"likes spicy"}\n');
  s.files.set("/home/workspace/eve/relationship.json", "{not json");
  const store = new HomeStore(tmp());
  const r = await restoreFromZo(zoApps(client(s.url)), store, "/home/workspace/eve", ["profile.json", "memories.jsonl", "relationship.json", "task_state.json"]);
  expect(r.restored.sort()).toEqual(["memories.jsonl", "profile.json"]);
  expect(r.skipped).toEqual(["relationship.json"]);
  expect(await store.read<any>("profile", null)).toEqual({ persona: { name: "Eve" }, bornAt: 1 });
});

test("memories summary is readable and ordered by importance", () => {
  const md = memoriesSummary('{"kind":"fact","content":"low","importance":0.1}\n{"kind":"preference","content":"likes spicy","importance":0.9}\n');
  expect(md.indexOf("likes spicy")).toBeLessThan(md.indexOf("low"));
  expect(md).toContain("2 memories");
});

// --- home module ----------------------------------------------------------------------

test("home: provides the zo service, mirrors to Zo, host zo, status route carries Zo stats", async () => {
  const s = server();
  const home = tmp();
  const core = await startCore([homeModule({ zoKey: "k", zoBaseUrl: s.url, syncDebounceMs: 10, statusIntervalMs: 30, spotify: false, prefetch: false })], { port: 17831, eveHome: home });
  cores.push(core);
  const svc = core.ctx.use("home") as HomeServiceImpl;
  expect(core.ctx.tryUse("zo")).toBeTruthy();
  await svc.write("profile", { persona: null });
  await svc.write("memories.jsonl", [{ id: "1", kind: "fact", content: "likes spicy", importance: 0.8, createdAt: 1 }]);
  await Bun.sleep(150);
  expect(s.files.has("/home/workspace/eve/profile.json")).toBe(true);
  expect(s.files.get("/home/workspace/eve/memories.md")).toContain("likes spicy");
  const st = await (await fetch("http://127.0.0.1:17831/api/home/status")).json();
  expect(st).toMatchObject({ host: "zo", zo: true });
  expect(st.zoStatus).toMatchObject({ configured: true, connected: true });
  expect(st.zoStatus.calls.write_file.n).toBeGreaterThanOrEqual(2);
});

test("home: boot with an empty ~/.eve restores her from Zo before other modules read", async () => {
  const s = server();
  s.files.set("/home/workspace/eve/profile.json", '{"persona":{"name":"Eve","tagline":"back"},"bornAt":5}\n');
  s.files.set("/home/workspace/eve/task_state.json", '{"tasks":[{"taskId":"t0","goal":"old","brain":"x","startedAt":1}]}\n');
  const home = tmp();
  const core = await startCore([homeModule({ zoKey: "k", zoBaseUrl: s.url, syncDebounceMs: 10, spotify: false, prefetch: false })], { port: 17832, eveHome: home });
  cores.push(core);
  const svc = core.ctx.use("home") as HomeServiceImpl;
  expect(svc.restore?.restored.sort()).toEqual(["profile.json", "task_state.json"]);
  expect(JSON.parse(readFileSync(join(home, "profile.json"), "utf8")).persona.name).toBe("Eve");
  expect(svc.tasks()).toHaveLength(1);
  // Restored bytes are already on Zo: no echo write.
  await Bun.sleep(80);
  expect(s.calls("write_file").filter((c) => c.params.arguments.target_file.endsWith("profile.json"))).toHaveLength(0);
});

test("home: a hung Zo never holds up boot or the bus (restore is capped)", async () => {
  const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
  const home = tmp();
  const t0 = Date.now();
  const core = await startCore([homeModule({ zoKey: "k", fetch: hang, restoreTimeoutMs: 200, spotify: false, prefetch: false, statusIntervalMs: 20 })], { port: 17833, eveHome: home });
  cores.push(core);
  expect(Date.now() - t0).toBeLessThan(1500);
  let got = 0;
  core.ctx.bus.on("voice.final", () => void got++);
  core.ctx.bus.emit("voice.final", { text: "hey" });
  expect(got).toBe(1);
  const svc = core.ctx.use("home") as HomeServiceImpl;
  await svc.write("profile", { persona: null });
  expect(readdirSync(home)).toContain("profile.json");
});

test("home: once born, the maps cache is prefetched in the background", async () => {
  const s = server({ tools: { maps_search: () => SAMPLE_MAPS } });
  const core = await startCore([homeModule({ zoKey: "k", zoBaseUrl: s.url, spotify: false })], { port: 17834, eveHome: tmp() });
  cores.push(core);
  core.ctx.bus.emit("companion.born", { persona: { name: "Eve" } as any });
  await Bun.sleep(150);
  const qs = s.calls("maps_search").map((c) => c.params.arguments.query);
  expect(qs).toContain("cheap spicy food");
  expect(qs).toContain("cheap spicy ramen");
  const zo = core.ctx.use("zo");
  const r = await zo.maps({ query: "cheap spicy ramen", location: "Irvine, CA", openNow: true, cheap: true });
  expect(r.cached).toBe(true);
});

// --- spotify ----------------------------------------------------------------------------

function fakeNowPlaying(seq: (string | null)[]) {
  let i = 0;
  return {
    async nowPlaying() {
      const v = seq[Math.min(i++, seq.length - 1)];
      if (v === "ERR") return { ok: false, ms: 1, error: "down" };
      if (!v) return { ok: true, ms: 1, value: { playing: false } };
      const [track, progress] = v.split("@");
      return { ok: true, ms: 1, value: { playing: true, track, artist: "Adele", id: track, progressMs: Number(progress ?? 1000) } };
    },
  } as Pick<ZoService, "nowPlaying">;
}

test("spotify: media.play on change and on repeat, deduped against the local watcher", async () => {
  const bus = new EventBus(100);
  const plays: AnyEnvelope[] = [];
  bus.on("media.play", (e) => void plays.push(e));
  const p = new SpotifyPoller({ zo: fakeNowPlaying(["A@1000", "A@60000", "A@2000", "B@1000", null, "C@1000"]), bus });
  p.start(1e9);
  await p.tick(); // A starts
  await p.tick(); // same A, later: nothing
  await p.tick(); // A restarted: repeat counts
  bus.emit("media.play", { track: "B" }, "watcher");
  await p.tick(); // B already reported locally: suppressed
  await p.tick(); // nothing playing
  await p.tick(); // C
  p.stop();
  const fromZo = plays.filter((e) => e.source === "zo").map((e) => (e.data as { track: string }).track);
  expect(fromZo).toEqual(["A", "A", "C"]);
  expect(plays.find((e) => e.source === "zo")!.data).toEqual({ track: "A", artist: "Adele" });
});

test("spotify: backs off on errors and slows down when idle", async () => {
  const bus = new EventBus(10);
  const p = new SpotifyPoller({ zo: fakeNowPlaying(["ERR", "ERR", null, null, null, null]), bus, intervalMs: 1000, idleMs: 5000 });
  await p.tick();
  expect(p.nextDelay()).toBe(2000);
  await p.tick();
  expect(p.nextDelay()).toBe(4000);
  for (let i = 0; i < 3; i++) await p.tick();
  expect(p.nextDelay()).toBe(5000);
});

// --- actions -------------------------------------------------------------------------------

const NOW = new Date(2026, 8, 26, 15, 0, 0, 0).getTime();

function fakeZoService(o: { create?: "ok" | "fail" | "slow"; list?: "ok" | "fail"; maps?: "ok" | "fail" } = {}) {
  const log: string[] = [];
  const zo = {
    client: {} as any,
    status: () => ({}) as any,
    async createEvent(e: { title: string; start: number; end: number; description?: string; location?: string }) {
      log.push(`create:${e.title}:${e.description}`);
      if (o.create === "fail") return { ok: false, ms: 5, error: "not connected" };
      if (o.create === "slow") await Bun.sleep(300);
      return { ok: true, ms: 5, value: { id: "gid123", title: e.title, start: e.start, end: e.end, htmlLink: "https://www.google.com/calendar/event?eid=gid123" } };
    },
    async deleteEvent(id: string) {
      log.push(`delete:${id}`);
      return { ok: true, ms: 5, value: { deleted: true } };
    },
    async listEvents() {
      log.push("list");
      if (o.list === "fail") return { ok: false, ms: 5, error: "down" };
      return { ok: true, ms: 5, value: [{ id: "e1", title: "gym", start: new Date(2026, 8, 26, 18).getTime(), end: new Date(2026, 8, 26, 19, 15).getTime() }] };
    },
    async maps(q: { query: string; cheap?: boolean; openNow?: boolean }) {
      log.push(`maps:${q.query}:${q.cheap}:${q.openNow}`);
      if (o.maps === "fail") return { ok: false, places: [], cached: false, ms: 5, error: "down" };
      return { ok: true, places: parseMapsSearch(SAMPLE_MAPS, "Irvine, CA").places, cached: false, ms: 5 };
    },
  } as unknown as ZoService;
  return { zo, log };
}

function actionEnv(zo: ZoService | null, o: { osaFail?: boolean; env?: Record<string, string>; memories?: string[] } = {}) {
  const bus = new EventBus(100);
  const ctx = createContext(bus, { ...loadConfig(), demo: false });
  if (zo) ctx.provide("zo", zo);
  if (o.memories) ctx.provide("memory", { all: () => o.memories!.map((content) => ({ content })) } as any);
  const osaCalls: string[] = [];
  const osa: OsaRunner = async (script) => {
    osaCalls.push(script === CREATE_EVENT_JXA ? "create" : "other");
    if (o.osaFail) return { ok: false, stdout: "", stderr: "not allowed", code: 1 };
    if (script === CREATE_EVENT_JXA) return { ok: true, stdout: JSON.stringify({ uid: "MAC-UID-1", calendar: "Eigenwife", fellBack: false }), stderr: "", code: 0 };
    return { ok: true, stdout: JSON.stringify(["Home"]), stderr: "", code: 0 };
  };
  const env = o.env ?? {};
  const deps = { osa, fetch: async () => new Response("", { status: 500 }), now: () => NOW, env: (n: string) => env[n] ?? "" } as unknown as AgencyDeps;
  const actEnv: ActionEnv = { ctx, deps, act: async () => ({ ok: false, observation: "" }) };
  return { actEnv, osaCalls };
}

test("calendar: create_event books the real Google Calendar via Zo, noting Eve", async () => {
  const { zo, log } = fakeZoService();
  const { actEnv, osaCalls } = actionEnv(zo);
  const r = await calendarCreateEvent.run({ title: "Kitakata Ramen", start: "7:30pm", durationMin: 90, location: "Irvine" }, actEnv);
  expect(r.ok).toBe(true);
  expect(r.observation).toContain("Google Calendar (event gid123)");
  expect(r.observation).toContain("https://www.google.com/calendar/event?eid=gid123");
  expect(r.data).toMatchObject({ id: "gid123", via: "zo", calendar: "google" });
  expect(log[0]).toContain("booked by Eve");
  expect(osaCalls).toEqual([]);
  // The harem alias takes the same road.
  const alias = await calendarCreateAlias.run({ title: "x", start: "8pm" }, actEnv);
  expect(alias.data).toMatchObject({ via: "zo" });
  expect(calendarCreateEvent.permission).toBe("EXTERNAL_SIDE_EFFECT");
  expect(calendarCreateAlias.permission).toBe("EXTERNAL_SIDE_EFFECT");
});

test("calendar: Zo failure falls back to macOS Calendar", async () => {
  const { zo } = fakeZoService({ create: "fail" });
  const { actEnv, osaCalls } = actionEnv(zo);
  const r = await calendarCreateEvent.run({ title: "Ramen", start: "7:30pm" }, actEnv);
  expect(r.ok).toBe(true);
  expect(r.data).toMatchObject({ uid: "MAC-UID-1", via: "macos" });
  expect(r.observation).toContain("Google Calendar via Zo failed");
  expect(osaCalls).toEqual(["create"]);
});

test("calendar: past the booking cap, macOS takes over and the late Google event is cleaned up", async () => {
  const { zo, log } = fakeZoService({ create: "slow" });
  const { actEnv } = actionEnv(zo, { env: { EVE_ZO_BOOK_CAP_MS: "50" } });
  const t0 = Date.now();
  const r = await calendarCreateEvent.run({ title: "Ramen", start: "7:30pm" }, actEnv);
  expect(Date.now() - t0).toBeLessThan(250);
  expect(r.data).toMatchObject({ via: "macos" });
  await Bun.sleep(400);
  expect(log).toContain("delete:gid123");
});

test("calendar: without Zo nothing changes (macOS path)", async () => {
  const { actEnv, osaCalls } = actionEnv(null);
  const r = await calendarCreateEvent.run({ title: "Ramen", start: "7:30pm" }, actEnv);
  expect(r.data).toMatchObject({ via: "macos" });
  expect(osaCalls).toEqual(["create"]);
});

test("calendar: delete_event takes a Google id; free_busy reads Google first", async () => {
  const { zo, log } = fakeZoService();
  const { actEnv } = actionEnv(zo);
  const d = await calendarDeleteEvent.run({ id: "gid123" }, actEnv);
  expect(d).toMatchObject({ ok: true });
  expect(log).toContain("delete:gid123");
  const fb = await calendarFreeBusy.run({}, actEnv);
  expect(fb.ok).toBe(true);
  expect(fb.observation).toContain("gym");
  expect((fb.data as any).freeFrom).toBe(new Date(2026, 8, 26, 19, 30).getTime());
  expect((fb.data as any).calendars).toEqual(["google"]);

  const bad = fakeZoService({ list: "fail" });
  const { actEnv: env2, osaCalls } = actionEnv(bad.zo);
  const fb2 = await calendarFreeBusy.run({}, env2);
  expect(fb2.observation).toContain("Google Calendar via Zo failed");
  expect(osaCalls.length).toBeGreaterThan(0);
});

test("places: Google Maps via Zo first, cheap when memories say saving money, open now for tonight", async () => {
  const { zo, log } = fakeZoService();
  const { actEnv } = actionEnv(zo, { memories: ["saving money this month"] });
  const r = await placesSearchAction.run({ prefs: { cuisine: "ramen", likes: ["spicy"] }, location: "Irvine, CA" }, actEnv);
  expect(r.ok).toBe(true);
  expect(log[0]).toBe("maps:spicy ramen:true:true");
  const places = (r.data as any).places;
  expect((r.data as any).via).toBe("zo:maps");
  expect(places[0].source).toBe("zo");
  expect(places.map((p: any) => p.name)).toContain("Kitakata Ramen Ban Nai - Irvine");
});

test("places: a Zo failure falls through to the web/brain path", async () => {
  const { zo, log } = fakeZoService({ maps: "fail" });
  const { actEnv } = actionEnv(zo);
  const r = await placesSearchAction.run({ prefs: { cuisine: "ramen", budget: "cheap" }, location: "Irvine, CA" }, actEnv);
  expect(log).toHaveLength(1);
  expect(r.ok).toBe(false); // no brains, no demo: the old path ran and found nothing
});

// --- latency guard ------------------------------------------------------------------------

test("latency: nothing on the speaking path (speech, reflex, mind, ears) touches Zo", async () => {
  const root = join(import.meta.dir, "..", "src");
  const offenders: string[] = [];
  for (const dir of ["speech", "reflex", "mind", "ears"]) {
    let files: string[] = [];
    try {
      files = readdirSync(join(root, dir), { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
    } catch {
      continue;
    }
    for (const f of files) {
      const src = readFileSync(join(root, dir, f), "utf8");
      if (/from\s+["'][./]*\/zo\b|from\s+["'][./]*\/home\/zo|(use|tryUse)\(\s*["']zo["']\s*\)|ZoClient|zoApps/.test(src)) offenders.push(`${dir}/${f}`);
    }
  }
  expect(offenders).toEqual([]);
});

test("home: a throwaway EVE_HOME gets the zo service but never mirrors, restores or polls", async () => {
  const s = server();
  s.files.set("/home/workspace/eve/profile.json", '{"persona":{"name":"Real Eve"}}\n');
  process.env.ZO_API_KEY = "k";
  process.env.ZO_BASE_URL = s.url;
  try {
    const core = await startCore([homeModule({ prefetch: false })], { port: 17835, eveHome: tmp() });
    cores.push(core);
    const svc = core.ctx.use("home") as HomeServiceImpl;
    expect(core.ctx.tryUse("zo")).toBeTruthy();
    expect(svc.zo).toBeNull();
    expect(svc.restore).toBeNull();
    expect(svc.spotify).toBeNull();
    await svc.write("profile", { persona: { name: "Test Eve" } });
    await Bun.sleep(50);
    expect(s.files.get("/home/workspace/eve/profile.json")).toContain("Real Eve");
  } finally {
    delete process.env.ZO_API_KEY;
    delete process.env.ZO_BASE_URL;
  }
});
