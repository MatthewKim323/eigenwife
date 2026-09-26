import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Candidate, MemoryRecord, RelationshipState, TraitKey } from "@eigenwife/protocol";
import { TRAIT_KEYS } from "@eigenwife/protocol";
import type { Module } from "../src/context";
import { startCore, type RunningCore } from "../src/index";
import { homeModule } from "../src/home/module";
import { cosine, localEmbed, OpenAIEmbedder, tokenize } from "../src/memory/embed";
import { memoryModule, type MemoryServiceImpl } from "../src/memory/module";
import type { MossLike } from "../src/memory/moss";
import { keywordPolicy, parseDecision } from "../src/memory/policy";
import { isDuplicate, nearest, recency, reinforce, scoreMemory, search, type RecordVecs } from "../src/memory/retrieval";
import { seedMemories } from "../src/memory/seed";
import type { BrainService } from "../src/services";

process.env.EIGEN_QUIET = "1";

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "eve-mem-"));
  dirs.push(d);
  return d;
};
let cores: RunningCore[] = [];
let port = 17900;
afterEach(async () => {
  for (const c of cores) await c.stop();
  cores = [];
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function boot(mods: Module[], opts: { demo?: boolean; home?: string } = {}) {
  const core = await startCore(mods, { port: ++port, eveHome: opts.home ?? tmp(), demo: opts.demo ?? false });
  cores.push(core);
  return core;
}

const rec = (id: string, content: string, over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id,
  kind: "fact",
  content,
  importance: 0.5,
  confidence: 0.7,
  source: "test",
  createdAt: NOW,
  ...over,
});

// --- retrieval math with fake embeddings ----------------------------------------

test("score formula: 1.2 cos + 0.2 recency(30d) + 0.3 importance", () => {
  expect(recency(NOW, NOW)).toBe(1);
  expect(recency(NOW - 15 * DAY, NOW)).toBeCloseTo(0.5);
  expect(recency(NOW - 45 * DAY, NOW)).toBe(0);
  expect(scoreMemory(0.5, { createdAt: NOW - 15 * DAY, importance: 0.4 }, NOW)).toBeCloseTo(0.6 + 0.1 + 0.12);
});

test("search: ranks by score, applies the relevance gate and the keep threshold, caps k", () => {
  // Fake 3-d "embeddings": the direction is the topic.
  const food = [1, 0, 0];
  const money = [0, 1, 0];
  const records = [
    rec("a", "spicy", { importance: 0.7 }),
    rec("b", "ramen", { importance: 0.2, createdAt: NOW - 40 * DAY }),
    rec("c", "budget", { importance: 0.9 }),
    rec("d", "mixed", { importance: 0.5 }),
  ];
  const vecs = new Map<string, RecordVecs>([
    ["a", { local: food }],
    ["b", { local: [0.3, 0, 0.95] }],
    ["c", { local: money }],
    ["d", { local: [0.7, 0.7, 0] }],
  ]);
  const { hits, space } = search(records, vecs, { local: food }, { now: NOW, k: 5 });
  expect(space).toBe("local");
  expect(hits.map((h) => h.record.id)).toEqual(["a", "d"]);
  // c is important and recent (0.2 + 0.27 = 0.47 < 0.5 even before the gate) and orthogonal: never surfaces
  expect(hits.find((h) => h.record.id === "c")).toBeUndefined();
  // b: cos 0.3 passes the gate, but old + unimportant: 0.36 + 0 + 0.06 < 0.5
  expect(hits.find((h) => h.record.id === "b")).toBeUndefined();
  expect(search(records, vecs, { local: food }, { now: NOW, k: 1 }).hits.length).toBe(1);
  expect(search(records, vecs, { local: food }, { now: NOW, kinds: ["episodic"] }).hits.length).toBe(0);
});

test("search: openai space when the query and most records have it, moss merges by max", () => {
  const records = [rec("a", "x"), rec("b", "y")];
  const vecs = new Map<string, RecordVecs>([
    ["a", { local: [1, 0], openai: [0, 1] }],
    ["b", { local: [0, 1], openai: [1, 0] }],
  ]);
  const r = search(records, vecs, { local: [1, 0], openai: [1, 0] }, { now: NOW });
  expect(r.space).toBe("openai");
  expect(r.hits[0]!.record.id).toBe("b");
  const m = search(records, vecs, { local: [1, 0], openai: [1, 0] }, { now: NOW, moss: new Map([["a", 0.99]]) });
  expect(m.space).toBe("moss");
  expect(m.hits.map((h) => h.record.id).sort()).toEqual(["a", "b"]);
});

test("dedupe + reinforcement helpers", () => {
  const records = [rec("a", "Likes spicy food")];
  const vecs = new Map<string, RecordVecs>([["a", { local: localEmbed("Likes spicy food") }]]);
  expect(isDuplicate(nearest(records, vecs, { local: localEmbed("likes spicy food!") }))).toBe(true);
  expect(isDuplicate(nearest(records, vecs, { local: localEmbed("Trying to save money") }))).toBe(false);
  expect(reinforce(0.7, 0.7)).toBeCloseTo(1 - 0.3 * 0.65);
  expect(reinforce(0.99, 1)).toBeLessThanOrEqual(1);
});

// --- local embedding on the demo seed -------------------------------------------

test("local embedding: the demo query recalls food + money memories, not unrelated ones", () => {
  const seeds = seedMemories(NOW);
  const vecs = new Map(seeds.map((s) => [s.id, { local: localEmbed(s.content) }]));
  const ids = (q: string) => search(seeds, vecs, { local: localEmbed(q) }, { now: NOW, k: 5 }).hits.map((h) => h.record.id);
  const eat = ids("what should we eat instead?");
  expect(eat).toContain("seed_spicy");
  expect(eat).toContain("seed_ramen28");
  expect(eat).toContain("seed_saving");
  expect(eat).toContain("seed_japanese");
  expect(eat).not.toContain("seed_concise");
  expect(eat).not.toContain("seed_teased");
  expect(ids("Garlic Knockout Ramen, $21, 4.6 stars")[0]).toBe("seed_ramen28");
  expect(ids("what's the weather like")).toEqual([]);
  expect(ids("lol")).not.toContain("seed_saving");
  expect(tokenize("It's $21!")).toContain("$");
  expect(cosine(localEmbed("abc"), localEmbed("abc"))).toBeCloseTo(1);
});

test("openai embedder: batches, caches by content hash, reports failures", async () => {
  let calls = 0;
  const fake = async (_url: string, init?: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init!.body));
    if (body.input.includes("boom")) return new Response("quota", { status: 429 });
    return Response.json({ data: body.input.map((t: string, index: number) => ({ index, embedding: [t.length, 1, 0] })) });
  };
  const e = new OpenAIEmbedder({ apiKey: "k", fetch: fake });
  const a = await e.embed(["ab", "abc", "ab"]);
  expect(a[0]).toEqual([2, 1, 0]);
  expect(a[1]).toEqual([3, 1, 0]);
  expect(calls).toBe(1);
  await e.embed(["abc"]);
  expect(calls).toBe(1);
  expect(await e.embed(["boom"])).toEqual([null]);
  expect(e.failures).toBe(1);
});

// --- write policy ------------------------------------------------------------------

test("keyword policy: preferences, goals, complaints, relationship, ignore", () => {
  const p = keywordPolicy({ user: "ugh that's too long, just the answer" });
  expect(p.policy).toBe("UPDATE_PREFERENCE");
  expect(p.facts[0]!.content).toBe("Prefers concise responses");

  const g = keywordPolicy({ user: "I like spicy food but I'm trying to save money this month" });
  expect(g.facts.map((f) => f.content)).toEqual(["Likes spicy food", "Trying to save money this month"]);
  expect(g.facts[1]!.policy).toBe("STORE_LONG_TERM");

  const c = keywordPolicy({ user: "28 dollars for ramen is so overpriced" });
  expect(c.facts[0]!.kind).toBe("episodic");

  const l = keywordPolicy({ user: "lmao shut up", eve: "Opening the dating app again?" });
  expect(l.policy).toBe("UPDATE_RELATIONSHIP");
  expect(l.relationship?.banter).toBeGreaterThan(0);
  expect(l.facts[0]!.content).toContain("Laughed");

  expect(keywordPolicy({ user: "ok" }).policy).toBe("IGNORE_EVENT");
  expect(keywordPolicy({ event: "user opened Spotify" }).policy).toBe("STORE_SHORT_TERM");
  expect(keywordPolicy({ user: "my password is hunter2 and I love it" }).facts).toEqual([]);
});

test("brain decisions are validated, junk falls back", () => {
  expect(parseDecision({ policy: "NOPE" })).toBeNull();
  const d = parseDecision({
    policy: "UPDATE_PREFERENCE",
    facts: [{ content: "Prefers concise responses", kind: "preference", importance: 3 }, { content: "" }, { content: "card number 4111111111111111" }],
    relationship: { banter: 5, warmth: "x" },
  })!;
  expect(d.facts.length).toBe(1);
  expect(d.facts[0]!.importance).toBe(1);
  expect(d.relationship).toEqual({ banter: 0.1 });
});

// --- module ---------------------------------------------------------------------------

const noKeys = { openaiKey: "", moss: null } as const;

test("seed: demo seeds once, idempotent across restarts, persisted to memories.jsonl", async () => {
  const home = tmp();
  let core = await boot([homeModule({ zoKey: "" }), memoryModule(noKeys)], { demo: true, home });
  const mem = core.ctx.use("memory") as MemoryServiceImpl;
  expect(mem.count()).toBe(8);
  expect(mem.all().every((r) => r.source === "seed")).toBe(true);
  const ages = mem.all().map((r) => (Date.now() - r.createdAt) / DAY);
  expect(Math.max(...ages)).toBeGreaterThan(20);
  expect(Math.min(...ages)).toBeLessThan(5);
  await core.stop();
  cores = [];
  core = await boot([homeModule({ zoKey: "" }), memoryModule(noKeys)], { demo: true, home });
  expect(core.ctx.use("memory").count()).toBe(8);
  const lines = readFileSync(join(home, "memories.jsonl"), "utf8").trim().split("\n");
  expect(lines.length).toBe(8);
  // non-demo: no seed
  const plain = await boot([homeModule({ zoKey: "" }), memoryModule(noKeys)]);
  expect(plain.ctx.use("memory").count()).toBe(0);
});

test("recall emits memory.recall, updates lastRecalledAt, respects emit:false; http routes work", async () => {
  const core = await boot([homeModule({ zoKey: "" }), memoryModule(noKeys)], { demo: true });
  const events: any[] = [];
  core.ctx.bus.on("memory.recall", (e) => events.push(e.data));
  const mem = core.ctx.use("memory");
  const hits = await mem.recall("where should we eat tonight?");
  expect(hits.length).toBeGreaterThanOrEqual(3);
  expect(hits.map((h) => h.record.content).join(" ")).toMatch(/spicy|ramen|Japanese/);
  expect(events.length).toBe(1);
  expect(events[0].by).toBe("local");
  expect(events[0].ms).toBeLessThan(50);
  expect(mem.all().find((r) => r.id === hits[0]!.record.id)!.lastRecalledAt).toBeGreaterThan(0);
  await mem.recall("spicy", { emit: false });
  expect(events.length).toBe(1);

  const base = `http://127.0.0.1:${core.port}`;
  const list = await (await fetch(`${base}/api/memory`)).json();
  expect(list.count).toBe(8);
  const r = await (await fetch(`${base}/api/memory/recall`, { method: "POST", body: JSON.stringify({ query: "cheap ramen" }) })).json();
  expect(r.ok).toBe(true);
  expect(r.hits[0].record.id).toBe("seed_ramen28");
  expect((await fetch(`${base}/api/memory/recall`, { method: "POST", body: "{}" })).status).toBe(400);
});

test("write: near duplicates reinforce instead of duplicating, short-term stays out of the file", async () => {
  const home = tmp();
  const core = await boot([homeModule({ zoKey: "" }), memoryModule({ ...noKeys, persistDebounceMs: 1 })], { home });
  const mem = core.ctx.use("memory") as MemoryServiceImpl;
  const writes: any[] = [];
  core.ctx.bus.on("memory.write", (e) => writes.push(e.data));
  const a = await mem.write({ kind: "preference", content: "Likes spicy food", confidence: 0.6 }, "UPDATE_PREFERENCE");
  const b = await mem.write({ kind: "preference", content: "likes spicy food.", confidence: 0.8 }, "UPDATE_PREFERENCE");
  expect(b!.id).toBe(a!.id);
  expect(b!.confidence).toBeGreaterThan(0.6);
  expect(mem.count()).toBe(1);
  expect(writes.length).toBe(2);
  expect(await mem.write({ kind: "fact", content: "anything" }, "IGNORE_EVENT")).toBeNull();

  const s = await mem.write({ kind: "episodic", content: "User is looking at the ramen menu" }, "STORE_SHORT_TERM");
  expect(s!.tags).toContain("short-term");
  expect(mem.count()).toBe(1);
  expect(mem.shortTerm().length).toBe(1);
  expect((await mem.recall("ramen menu", { emit: false })).some((h) => h.record.id === s!.id)).toBe(true);
  await mem.flush();
  const file = readFileSync(join(home, "memories.jsonl"), "utf8");
  expect(file).toContain("spicy");
  expect(file).not.toContain("ramen menu");
});

test("short-term records expire", async () => {
  let t = Date.now();
  const core = await boot([homeModule({ zoKey: "" }), memoryModule({ ...noKeys, shortTermTtlMs: 1000, now: () => t })]);
  const mem = core.ctx.use("memory") as MemoryServiceImpl;
  await mem.write({ kind: "episodic", content: "Looking at a ramen shop" }, "STORE_SHORT_TERM");
  expect(mem.shortTerm().length).toBe(1);
  t += 2000;
  expect(mem.shortTerm().length).toBe(0);
});

function fakeRelationship(): Module & { nudges: Partial<RelationshipState>[] } {
  const nudges: Partial<RelationshipState>[] = [];
  return {
    name: "rel",
    nudges,
    start(ctx) {
      ctx.provide("relationship", {
        get: () => ({ banter: 0.5, warmth: 0.5, initiative: 0.5, verbosity: 0.5, confidence: 0.5 }),
        nudge: (d) => {
          nudges.push(d);
          return { banter: 0.5, warmth: 0.5, initiative: 0.5, verbosity: 0.5, confidence: 0.5 };
        },
      });
    },
  };
}

test("observe: keyword fallback without brains, nudges relationship", async () => {
  const rel = fakeRelationship();
  const core = await boot([homeModule({ zoKey: "" }), rel, memoryModule(noKeys)]);
  const mem = core.ctx.use("memory");
  const out = await mem.observe({ user: "honestly I hate long explanations" });
  expect(out[0]!.content).toBe("Dislikes long explanations");
  expect(out[0]!.kind).toBe("preference");
  await mem.observe({ user: "LMAO stop", eve: "you opened the app again" });
  expect(rel.nudges[0]!.banter).toBeGreaterThan(0);
  expect(await mem.observe({ user: "hmm" })).toEqual([]);
});

test("observe: uses the brain when present, falls back when it returns junk", async () => {
  let answer: unknown = {
    policy: "STORE_LONG_TERM",
    facts: [{ content: "Has a sister named Mina", kind: "fact", importance: 0.6, confidence: 0.9, policy: "STORE_LONG_TERM" }],
  };
  const brains: Module = {
    name: "brains",
    start(ctx) {
      ctx.provide("brains", {
        persona: async function* () {},
        frontier: async () => ({ ok: false, text: "", engine: "x", ms: 0 }),
        quickJson: async () => answer as never,
        status: () => ({}),
      } satisfies BrainService);
    },
  };
  const core = await boot([homeModule({ zoKey: "" }), brains, memoryModule(noKeys)]);
  const mem = core.ctx.use("memory");
  expect((await mem.observe({ user: "my sister Mina is visiting" }))[0]!.content).toBe("Has a sister named Mina");
  answer = "not json";
  expect((await mem.observe({ user: "I love anime" }))[0]!.content).toBe("Likes anime");
});

const traits = (over: Partial<Record<TraitKey, number>>) =>
  Object.fromEntries(TRAIT_KEYS.map((t) => [t, over[t] ?? 0.3])) as Record<TraitKey, number>;
const fixtures: Candidate[] = [
  { id: "mira", name: "Mira", age: 26, tagline: "", job: "", location: "", photos: [], prompts: [], traits: traits({ sarcasm: 0.95, nerdiness: 0.8 }), regions: [] },
  { id: "jo", name: "Jo", age: 27, tagline: "", job: "", location: "", photos: [], prompts: [], traits: traits({ outdoors: 0.9 }), regions: [] },
];

test("bus facts: strong dating signals, finished tasks, and swarm merges become memories", async () => {
  const core = await boot([homeModule({ zoKey: "" }), memoryModule({ ...noKeys, candidates: fixtures })]);
  const mem = core.ctx.use("memory");
  core.ctx.bus.emit("dating.signal", { candidateId: "jo", interest: { skip: 0.7, neutral: 0.2, inspect: 0.1, positive: 0 }, strength: 0.8, reward: 0.1, by: "local" });
  core.ctx.bus.emit("dating.signal", { candidateId: "mira", interest: { skip: 0, neutral: 0.1, inspect: 0.2, positive: 0.7 }, strength: 0.85, reward: 0.9, by: "local" });
  core.ctx.bus.emit("task.done", { taskId: "t", ok: true, summary: "Booked Menya Tsuki for 7:30", ms: 900 });
  core.ctx.bus.emit("swarm.merge", { taskId: "t", agentIds: ["a"], retained: ["Menya Tsuki has $14 spicy miso ramen", ""], discarded: 3 });
  await Bun.sleep(30);
  const all = mem.all().map((r) => `${r.source}|${r.content}`);
  expect(all.some((s) => s.startsWith("act1:attention|") && s.includes("sarcasm") && s.includes("Mira"))).toBe(true);
  expect(all.some((s) => s.includes("Jo"))).toBe(false);
  expect(all).toContain("task|Eve handled: Booked Menya Tsuki for 7:30");
  expect(all).toContain("swarm|Menya Tsuki has $14 spicy miso ramen");
});

test("moss: writes mirror to the adapter and its scores merge into recall", async () => {
  const upserts: string[] = [];
  const moss: MossLike = {
    name: "fake",
    ready: () => true,
    upsert: async (rs) => {
      upserts.push(...rs.map((r) => r.id));
    },
    remove: async () => {},
    query: async () => [{ id: "seed_saving", score: 0.9 }],
    close: async () => {},
  };
  const core = await boot([homeModule({ zoKey: "" }), memoryModule({ openaiKey: "", moss })], { demo: true });
  const events: any[] = [];
  core.ctx.bus.on("memory.recall", (e) => events.push(e.data));
  const hits = await core.ctx.use("memory").recall("anything at all");
  expect(hits[0]!.record.id).toBe("seed_saving");
  expect(events[0].by).toBe("moss");
  await core.ctx.use("memory").write({ kind: "fact", content: "Has a cat named Tofu" });
  expect(upserts.length).toBe(1);
});
