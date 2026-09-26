import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { startCore, type RunningCore } from "../src/index";
import { formatStatus, formatUptime, statusLine } from "../src/home/format";
import { homeModule, type HomeServiceImpl } from "../src/home/module";
import { HomeStore } from "../src/home/store";
import { pickWriteTool, ZoMirror } from "../src/home/zo";

process.env.EIGEN_QUIET = "1";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "eve-home-"));
  dirs.push(d);
  return d;
};
let cores: RunningCore[] = [];
afterEach(async () => {
  for (const c of cores) await c.stop();
  cores = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("store: names map to files, json and jsonl round-trip", async () => {
  const store = new HomeStore(tmp());
  expect(HomeStore.fileName("profile")).toBe("profile.json");
  expect(HomeStore.fileName("memories.jsonl")).toBe("memories.jsonl");
  expect(HomeStore.fileName("../../etc/passwd")).toBe("passwd.json");
  await store.write("profile", { a: 1 });
  await store.write("memories.jsonl", [{ id: 1 }, { id: 2 }]);
  expect(await store.read<unknown>("profile", null)).toEqual({ a: 1 });
  expect(await store.read<unknown[]>("memories.jsonl", [])).toEqual([{ id: 1 }, { id: 2 }]);
  expect(await store.read("missing", "fallback")).toBe("fallback");
});

test("store: concurrent writes are serialized, last wins, no temp files left", async () => {
  const dir = tmp();
  const store = new HomeStore(dir);
  await Promise.all(Array.from({ length: 50 }, (_, i) => store.write("profile", { i, pad: "x".repeat(5000) })));
  expect((await store.read<{ i: number } | null>("profile", null))!.i).toBe(49);
  expect(readdirSync(dir)).toEqual(["profile.json"]);
});

test("store: readers never see a torn file while writes are in flight", async () => {
  const dir = tmp();
  const store = new HomeStore(dir);
  await store.write("big", { v: 0, blob: "a".repeat(200_000) });
  let torn = 0;
  const writes = Array.from({ length: 20 }, (_, i) => store.write("big", { v: i, blob: String(i % 10).repeat(200_000) }));
  const reads = Array.from({ length: 40 }, async () => {
    const raw = readFileSync(join(dir, "big.json"), "utf8");
    try {
      JSON.parse(raw);
    } catch {
      torn++;
    }
    await Bun.sleep(0);
  });
  await Promise.all([...writes, ...reads]);
  expect(torn).toBe(0);
});

test("store: a jsonl file with a torn trailing line still loads", async () => {
  const dir = tmp();
  await Bun.write(join(dir, "memories.jsonl"), '{"id":1}\n{"id":2}\n{"id":');
  expect(await new HomeStore(dir).read<unknown[]>("memories.jsonl", [])).toEqual([{ id: 1 }, { id: 2 }]);
});

// --- Zo mirror ---------------------------------------------------------------

interface Call {
  url: string;
  body: any;
  headers: Record<string, string>;
}

function fakeZo(opts: { mcp?: boolean; sse?: boolean; failAsk?: boolean } = {}) {
  const calls: Call[] = [];
  const files = new Map<string, string>();
  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    if (url.endsWith("/mcp")) {
      if (!opts.mcp) return new Response("nope", { status: 404 });
      if (!body.id) return new Response(null, { status: 202 });
      let result: unknown = {};
      if (body.method === "tools/list")
        result = {
          tools: [
            { name: "read_file", inputSchema: { properties: { path: {} } } },
            { name: "write_file", inputSchema: { properties: { file_path: {}, content: {} } } },
          ],
        };
      if (body.method === "tools/call") {
        files.set(body.params.arguments.file_path, body.params.arguments.content);
        result = { content: [{ type: "text", text: "ok" }] };
      }
      const msg = JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
      return opts.sse
        ? new Response(`event: message\ndata: ${msg}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s1" } })
        : new Response(msg, { headers: { "content-type": "application/json", "mcp-session-id": "s1" } });
    }
    if (url.endsWith("/zo/ask")) {
      if (opts.failAsk) return Response.json({ error: "down" }, { status: 500 });
      return Response.json({ output: "OK", conversation_id: null });
    }
    return new Response("?", { status: 404 });
  };
  return { calls, files, fetcher };
}

test("zo: bursts are debounced into one sync with the latest bytes", async () => {
  const z = fakeZo({ mcp: true });
  const zo = new ZoMirror({ apiKey: "zo_sk_test", debounceMs: 40, fetch: z.fetcher });
  zo.enqueue("profile.json", "v1");
  zo.enqueue("profile.json", "v2");
  zo.enqueue("memories.jsonl", "m1");
  await Bun.sleep(10);
  zo.enqueue("profile.json", "v3");
  expect(z.calls.length).toBe(0);
  await Bun.sleep(120);
  const writes = z.calls.filter((c) => c.body?.method === "tools/call");
  expect(writes.length).toBe(2);
  expect(z.files.get("/home/workspace/eve/profile.json")).toBe("v3");
  expect(z.files.get("/home/workspace/eve/memories.jsonl")).toBe("m1");
  expect(zo.syncs).toBe(1);
  expect(zo.lastSyncAt).toBeGreaterThan(0);
  expect(zo.lastResult?.via).toBe("mcp");
  // bearer auth + session header after initialize
  expect(z.calls[0]!.headers.Authorization).toBe("Bearer zo_sk_test");
  expect(writes[0]!.headers["Mcp-Session-Id"]).toBe("s1");
  zo.stop();
});

test("zo: SSE-framed MCP responses work", async () => {
  const z = fakeZo({ mcp: true, sse: true });
  const zo = new ZoMirror({ apiKey: "k", debounceMs: 5, fetch: z.fetcher });
  zo.enqueue("status.json", "{}");
  const r = await zo.flush();
  expect(r.ok).toBe(true);
  expect(r.via).toBe("mcp");
  expect(z.files.get("/home/workspace/eve/status.json")).toBe("{}");
});

test("zo: falls back to /zo/ask when MCP is unavailable, keeps files dirty on total failure", async () => {
  const z = fakeZo({ mcp: false });
  const zo = new ZoMirror({ apiKey: "k", debounceMs: 5, fetch: z.fetcher });
  zo.enqueue("profile.json", '{"persona":null}');
  const r = await zo.flush();
  expect(r.via).toBe("ask");
  const ask = z.calls.find((c) => c.url.endsWith("/zo/ask"))!;
  expect(ask.body.input).toContain("/home/workspace/eve/profile.json");
  expect(ask.body.input).toContain('{"persona":null}');

  const bad = fakeZo({ mcp: false, failAsk: true });
  const zo2 = new ZoMirror({ apiKey: "k", debounceMs: 5, fetch: bad.fetcher });
  zo2.enqueue("profile.json", "x");
  const r2 = await zo2.flush();
  expect(r2.ok).toBe(false);
  expect(zo2.lastSyncAt).toBeUndefined();
  expect(zo2.dirty()).toEqual(["profile.json"]);
});

test("zo: write tool is picked by schema, not by guesswork", () => {
  expect(pickWriteTool([{ name: "write_file", inputSchema: { properties: { path: {}, content: {} } } }])).toEqual({
    name: "write_file",
    pathKey: "path",
    contentKey: "content",
  });
  expect(pickWriteTool([{ name: "create_file", inputSchema: { properties: { target_file: {}, text: {} } } }])?.pathKey).toBe("target_file");
  expect(pickWriteTool([{ name: "web_search", inputSchema: { properties: { query: {} } } }])).toBeNull();
});

// --- module ------------------------------------------------------------------

test("module: status route, home.status ticks, task_state + relationship persistence, zo host", async () => {
  const home = tmp();
  const z = fakeZo({ mcp: true });
  const core = await startCore([homeModule({ zoKey: "k", fetch: z.fetcher, syncDebounceMs: 10, statusIntervalMs: 30 })], {
    port: 17811,
    eveHome: home,
  });
  cores.push(core);
  const svc = core.ctx.use("home") as HomeServiceImpl;
  expect(svc.status().online).toBe(true);

  const ticks: any[] = [];
  core.ctx.bus.on("home.status", (e) => ticks.push(e.data));
  core.ctx.bus.emit("task.start", { taskId: "t1", goal: "plan tonight", brain: "claude" });
  core.ctx.bus.emit("task.done", { taskId: "t1", ok: true, summary: "booked ramen", ms: 1200 });
  core.ctx.bus.emit("relationship.update", {
    state: { banter: 0.7, warmth: 0.5, initiative: 0.6, verbosity: 0.3, confidence: 0.5 },
    delta: { banter: 0.03 },
    reason: "laughed",
  });
  await Bun.sleep(120);
  expect(ticks.length).toBeGreaterThanOrEqual(2);
  expect(ticks.at(-1).tasks).toBe(1);
  expect(ticks.at(-1).host).toBe("zo");
  expect(ticks.at(-1).lastSyncAt).toBeGreaterThan(0);

  await svc.store.flush();
  const ts = JSON.parse(readFileSync(join(home, "task_state.json"), "utf8"));
  expect(ts.tasks[0]).toMatchObject({ taskId: "t1", ok: true, summary: "booked ramen" });
  expect(JSON.parse(readFileSync(join(home, "relationship.json"), "utf8")).state.banter).toBe(0.7);
  expect(z.files.has("/home/workspace/eve/task_state.json")).toBe(true);
  expect(z.files.has("/home/workspace/eve/relationship.json")).toBe(true);

  const status = await (await fetch("http://127.0.0.1:17811/api/home/status")).json();
  expect(status).toMatchObject({ online: true, tasks: 1, zo: true, host: "zo", home });
});

test("module: without a Zo key the host is this machine and nothing leaves", async () => {
  const home = tmp();
  const core = await startCore([homeModule({ zoKey: "" })], { port: 17812, eveHome: home });
  cores.push(core);
  const svc = core.ctx.use("home") as HomeServiceImpl;
  expect(svc.zo).toBeNull();
  expect(svc.status().host).not.toBe("zo");
  await svc.write("profile", { persona: null });
  expect(await svc.read("profile", {})).toEqual({ persona: null });
  const st = JSON.parse(readFileSync(join(home, "status.json"), "utf8"));
  expect(st.online).toBe(true);
  expect(st.pid).toBe(process.pid);
});

test("format: the spec banner and the pretty block", () => {
  expect(formatUptime(5 * 3600_000 + 31 * 60_000 + 14_000)).toBe("05:31:14");
  expect(formatUptime(26 * 3600_000)).toBe("1d 02:00:00");
  expect(statusLine({ online: true, uptimeMs: 19874000, memories: 142, tasks: 3 })).toBe(
    "EVE  STATUS ONLINE | UPTIME 05:31:14 | MEMORIES 142 | TASKS 3",
  );
  const block = formatStatus({ online: false, host: "mbp", uptimeMs: 0, memories: 8, tasks: 0, home: "/x", persona: null });
  expect(block).toContain("OFFLINE");
  expect(block).toContain("MEMORIES");
  expect(block).not.toMatch(/[–—]/);
});
