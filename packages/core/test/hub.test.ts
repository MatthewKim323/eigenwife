import { afterAll, beforeAll, expect, test } from "bun:test";
import { BusClient } from "@eigenwife/protocol/client";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { startCore, type RunningCore } from "../src/index";

let core: RunningCore;
const port = 17777;

beforeAll(async () => {
  process.env.EIGEN_QUIET = "1";
  core = await startCore([], { port });
});
afterAll(() => core.stop());

function client(name: string) {
  return new BusClient({ url: `ws://127.0.0.1:${port}/bus`, client: name, role: "observer" }).connect();
}

const until = async (cond: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timeout");
    await Bun.sleep(10);
  }
};

test("welcome carries the world snapshot", async () => {
  const a = client("a");
  let welcome: AnyEnvelope | null = null;
  a.on("bus.welcome", (e) => (welcome = e));
  await until(() => welcome !== null);
  expect((welcome as any).data.world.scene).toBe("boot");
  a.close();
});

test("client events reach the core bus and other clients, not the sender", async () => {
  const a = client("a");
  const b = client("b");
  await until(() => a.connected && b.connected);
  const seenByA: string[] = [];
  const seenByB: string[] = [];
  a.on("voice.*", (e) => seenByA.push(e.source));
  b.on("voice.*", (e) => seenByB.push(e.source));
  let coreSaw = "";
  const off = core.ctx.bus.on("voice.final", (e) => {
    coreSaw = e.data.text;
  });
  a.emit("voice.final", { text: "thoughts?" });
  await until(() => coreSaw === "thoughts?" && seenByB.length === 1);
  await Bun.sleep(50);
  // a heard itself exactly once (local dispatch), never an echo from the hub
  expect(seenByA).toEqual(["a"]);
  expect(seenByB).toEqual(["a"]);
  expect(core.ctx.world().user.lastUtterance).toBe("thoughts?");
  off();
  a.close();
  b.close();
});

test("core emits fan out to every client", async () => {
  const a = client("a");
  await until(() => a.connected);
  let mood = "";
  a.on("avatar.mood", (e) => (mood = e.data.mood));
  core.ctx.bus.emit("avatar.mood", { mood: "annoyed", intensity: 0.7 });
  await until(() => mood === "annoyed");
  a.close();
});

test("http: health, world, emit, module routes", async () => {
  core.ctx.route("/api/ping", () => new Response("pong"));
  const base = `http://127.0.0.1:${port}`;
  expect((await (await fetch(`${base}/health`)).json()).ok).toBe(true);
  const res = await fetch(`${base}/emit`, {
    method: "POST",
    body: JSON.stringify({ type: "shell.scene", ts: Date.now(), source: "t", id: "x1", data: { scene: "dating" } }),
  });
  expect((await res.json()).ok).toBe(true);
  expect((await (await fetch(`${base}/world`)).json()).scene).toBe("dating");
  const ping = await fetch(`${base}/api/ping`);
  expect(await ping.text()).toBe("pong");
  expect(ping.headers.get("access-control-allow-origin")).toBe("*");
  expect((await fetch(`${base}/emit`, { method: "POST", body: "nope" })).status).toBe(400);
});

test("queued emits flush after connect", async () => {
  const a = new BusClient({ url: `ws://127.0.0.1:${port}/bus`, client: "late", role: "observer" });
  a.emit("diag", { label: "queued", value: "1" });
  let got = false;
  const off = core.ctx.bus.on("diag", (e) => {
    if (e.data.label === "queued") got = true;
  });
  a.connect();
  await until(() => got);
  off();
  a.close();
});
