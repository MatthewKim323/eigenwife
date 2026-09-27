import { describe, expect, test } from "bun:test";
import type { EventMap, EventType, Persona } from "@eigenwife/protocol";
import { DEFAULT_EVE } from "../src/brains/prompt";
import { GbrainClient, type GbrainRunner } from "../src/memory/gbrain";
import { buildWorld, dayBullets, EntityIndex, entriesFor, lead, learnedFacts, parseList, parsePage, worldRecords, type WorldCache } from "../src/memory/gbrain-world";
import { memoryModule, type MemoryServiceImpl } from "../src/memory/module";
import { createJev } from "../src/reflex/jev";
import { reflexModule } from "../src/reflex/module";
import { emitAt, FakeBrains, FakeClock, fakeContext, FakeHome, FakeSpeech, startModules } from "../src/reflex/testing";

const persona: Persona = { ...DEFAULT_EVE };

const LEO = `---
type: person
title: Leo Park
aliases:
  - Leo Park
  - leopark
  - "the leo"
relationship: friend
---

# Leo Park

Leo is matt's climbing partner from UCSB who always says "send it" before every route. They met at the rec center bouldering wall in 2024.

## Relationship arc
- **2024-01-01** stuff`;

const NERVE = `---
type: project
title: Nerve product north star
---

# Nerve

Nerve turns minimal intent into the right completed computer task. Gaze is one input layer.`;

const DAY = `---
type: day
title: Daily catch-up
date: '2026-09-21T00:00:00.000Z'
---

# Daily catch-up \u2014 2026-09-21

**Nathan Kim** (8 msgs)
- [00:10-00:12] Nathan getting some apparel, offered matt a free black medium

_No human Discord messages on 2026-09-21._`;

const LEARNED = `# learned 2026-09-20

- [00:01] (decision) Matt wants to ingest Claude Code transcripts into gbrain.
- [00:02] (eigenwife) matt: something eve wrote
- [00:03] (preference) Matt's password is hunter2`;

const LISTS: Record<string, string> = {
  person: "people/leo-park\tperson\t2026-09-08\tLeo Park\npeople/ghost\tperson\t2026-09-01\tGhost",
  project: "projects/nerve\tproject\t2026-09-08\tNerve product north star",
  event: "",
  concept: "learned/2026-09-20\tconcept\t2026-09-20\t2026 09 20\ndocs/gbrain/skills/x\tconcept\t2026-07-25\tSkill",
  day: "days/2026-09-21\tday\t2026-09-21\tDaily catch-up",
  profile: "",
};
const PAGES: Record<string, string> = { "people/leo-park": LEO, "projects/nerve": NERVE, "days/2026-09-21": DAY, "learned/2026-09-20": LEARNED };

function fakeBrain(opts: { searchDelayMs?: number; search?: (q: string) => string } = {}) {
  const calls: string[][] = [];
  const runner: GbrainRunner = async (args) => {
    calls.push(args);
    const [cmd, a1] = args;
    if (cmd === "list") return { ok: true, stdout: LISTS[args[2]!] ?? "", ms: 1 };
    if (cmd === "get") return { ok: !!PAGES[a1!], stdout: PAGES[a1!] ?? "", ms: 1 };
    if (cmd === "search") {
      if (opts.searchDelayMs) await Bun.sleep(opts.searchDelayMs);
      return { ok: true, stdout: opts.search?.(a1!) ?? "", ms: opts.searchDelayMs ?? 1 };
    }
    return { ok: true, stdout: "", ms: 1 };
  };
  return { runner, calls };
}

async function waitFor(cond: () => boolean, ms = 3000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error("timed out waiting");
    await Bun.sleep(2);
  }
}

describe("world parsing", () => {
  test("list rows, frontmatter, lead paragraph, day bullets, learned facts", () => {
    expect(parseList(LISTS.person!)).toEqual([
      { slug: "people/leo-park", type: "person", updated: "2026-09-08", title: "Leo Park" },
      { slug: "people/ghost", type: "person", updated: "2026-09-01", title: "Ghost" },
    ]);
    const p = parsePage(LEO);
    expect(p.meta.aliases).toEqual(["Leo Park", "leopark", "the leo"]);
    expect(p.meta.relationship).toBe("friend");
    expect(p.title).toBe("Leo Park");
    expect(lead(p.body)).toBe(`Leo is matt's climbing partner from UCSB who always says "send it" before every route. They met at the rec center bouldering wall in 2024.`);
    expect(dayBullets(parsePage(DAY).body)).toEqual(["Nathan getting some apparel, offered matt a free black medium"]);
    expect(learnedFacts(LEARNED)).toEqual(["Matt wants to ingest Claude Code transcripts into gbrain.", "Matt's password is hunter2"]);
  });
  test("entries: people carry aliases; secrets and eve's own lines never come back", () => {
    const [leo] = entriesFor("person", parseList(LISTS.person!)[0]!, LEO);
    expect(leo!.content).toStartWith("Leo Park (friend): Leo is matt's climbing partner");
    expect(leo!.aliases).toEqual(["leo park", "leopark", "the leo", "leo"]);
    const learned = entriesFor("learned", { slug: "learned/2026-09-20", type: "concept", updated: "2026-09-20", title: "" }, LEARNED);
    expect(learned.map((e) => e.content)).toEqual(["Matt wants to ingest Claude Code transcripts into gbrain."]);
    expect(entriesFor("day", { slug: "days/2026-09-21", type: "day", updated: "2026-09-21", title: "" }, DAY)[0]!.content).toBe(
      "On 2026-09-21: Nathan getting some apparel, offered matt a free black medium",
    );
  });
  test("entity index: longest alias wins, possessives, case-insensitive", () => {
    const ix = new EntityIndex();
    ix.add("leo park", "a");
    ix.add("leo", "a");
    ix.add("leo", "b");
    ix.add("the", "x");
    expect(ix.match("did Leo Park's thing work")).toEqual([{ alias: "leo park", ids: ["a"] }]);
    expect(ix.match("leo's back")).toEqual([{ alias: "leo", ids: ["a", "b"] }]);
    expect(ix.match("the end")).toEqual([]);
    ix.removeIds(new Set(["a"]));
    expect(ix.match("leo park")).toEqual([{ alias: "leo", ids: ["b"] }]);
  });
  test("buildWorld: lists, gets, skips missing pages; records carry provenance", async () => {
    const { runner, calls } = fakeBrain();
    const w = await buildWorld({ client: new GbrainClient(runner) });
    expect(calls.filter((c) => c[0] === "get").map((c) => c[1]).sort()).toEqual(["days/2026-09-21", "learned/2026-09-20", "people/ghost", "people/leo-park", "projects/nerve"]);
    expect(w.pages).toBe(4);
    expect(w.entries.map((e) => e.kind).sort()).toEqual(["day", "learned", "person", "project"]);
    const recs = worldRecords(w);
    const leo = recs.find((r) => r.content.startsWith("Leo"))!;
    expect(leo.id).toBe("gw_people_leo-park");
    expect(leo.source).toBe("gbrain");
    expect(leo.provenance).toEqual({ system: "gbrain", slug: "people/leo-park", title: "Leo Park", at: Date.parse("2026-09-08") });
  });
});

async function rig(o: { searchDelayMs?: number; search?: (q: string) => string; reflex?: boolean; world?: WorldCache } = {}) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  ctx.config.demo = false;
  ctx.config.eveHome = "/tmp/eve-throwaway-home";
  const home = new FakeHome(o.world ? new Map([["gbrain-world", o.world]]) : undefined);
  ctx.provide("home", home);
  const speech = new FakeSpeech(ctx, clock);
  const brains = new FakeBrains((r) => `(${r.behavior}) sure`);
  ctx.provide("speech", speech);
  ctx.provide("brains", brains);
  const fb = fakeBrain(o);
  const mods = [memoryModule({ openaiKey: "", moss: null, gbrain: { runner: fb.runner, digest: false, digestDelayMs: 0 } })];
  if (o.reflex) mods.push(reflexModule({ now: clock.now, jev: createJev({}) }));
  const stop = await startModules(ctx, mods);
  const mem = ctx.use("memory") as MemoryServiceImpl;
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  return { ctx, clock, home, speech, brains, mem, stop, emit, calls: fb.calls };
}

const LEO_HIT = `[1.20] people/leo-park -- Leo is matt's climbing partner from UCSB.`;

describe("world in memory", () => {
  test("preload: names are exact local hits with provenance; recall is local and fast", async () => {
    const r = await rig();
    await waitFor(() => (r.mem.gbrainPool?.() ?? []).some((x) => x.tags?.includes("world")));
    expect(r.home.files.has("gbrain-world")).toBe(true);
    expect(r.mem.all().some((x) => x.source === "gbrain")).toBe(false);
    let flash: EventMap["memory.recall"] | null = null;
    r.ctx.bus.on("memory.recall", (e) => void (flash = e.data));
    const t0 = performance.now();
    const hits = await r.mem.recall("did leo say anything", { emit: true });
    const ms = performance.now() - t0;
    expect(hits[0]!.via).toBe("entity");
    expect(hits[0]!.record.provenance).toMatchObject({ system: "gbrain", slug: "people/leo-park", title: "Leo Park" });
    expect(flash!.hits[0]!.record.source).toBe("gbrain");
    expect(ms).toBeLessThan(50);
    // A name she knows never goes to gbrain.
    r.emit("voice.partial", { text: "so leo said" });
    r.emit("voice.final", { text: "so Leo said we should go climbing" });
    await Bun.sleep(5);
    expect(r.calls.filter((c) => c[0] === "search")).toEqual([]);
    // Cached world: a restart loads it without asking gbrain.
    const world = r.home.files.get("gbrain-world") as WorldCache;
    await r.stop();
    const r2 = await rig({ world });
    expect((r2.mem.gbrainPool?.() ?? []).length).toBe(world.entries.length);
    expect(r2.calls.filter((c) => c[0] === "list")).toEqual([]);
    await r2.stop();
  });

  test("speculative prefetch: an unknown name in a partial is fetched before the turn ends; deduped, 2 in flight max", async () => {
    const r = await rig({ searchDelayMs: 40, search: (q) => (q === "Mira" ? `[1.1] people/mira-chen -- Mira is matt's lab partner in CS 130.` : "") });
    await waitFor(() => (r.mem.gbrainPool?.() ?? []).length > 0);
    r.emit("voice.partial", { text: "wait did" });
    r.emit("voice.partial", { text: "wait did Mira" });
    r.emit("voice.partial", { text: "wait did Mira text" });
    expect(r.calls.filter((c) => c[0] === "search").map((c) => c[1])).toEqual(["Mira"]);
    r.emit("voice.partial", { text: "and Jonah and" });
    r.emit("voice.partial", { text: "and Jonah and Priya" });
    r.emit("voice.partial", { text: "oh and Sam" }); // 2 already in flight: skipped
    expect(r.calls.filter((c) => c[0] === "search").map((c) => c[1])).toEqual(["Mira", "Jonah"]);
    await waitFor(() => r.mem.shortTerm().some((x) => x.content.includes("lab partner")));
    const rec = r.mem.shortTerm().find((x) => x.content.includes("lab partner"))!;
    expect(rec.provenance).toMatchObject({ system: "gbrain", slug: "people/mira-chen" });
    // Now it's a known name: exact hit, no second trip within the cache window.
    const hits = await r.mem.recall("what did mira say", { emit: false });
    expect(hits[0]!.via).toBe("entity");
    r.emit("voice.final", { text: "wait did Mira text me" });
    await Bun.sleep(5);
    expect(r.calls.filter((c) => c[0] === "search" && c[1] === "Mira").length).toBe(1);
    const st = r.mem.gbrain!() as { lookups: { fromPartial: number; lookups: number } };
    expect(st.lookups.fromPartial).toBe(2);
    await r.stop();
  });

  test("miss path, fast: a lookup that lands within 600ms makes it into this turn", async () => {
    const r = await rig({ reflex: true, searchDelayMs: 150, search: (q) => (q === "Tavi" ? `[1.1] people/tavi -- Tavi is matt's cousin who lives in Seoul.` : "") });
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.speech.said.length === 1);
    r.emit("voice.final", { text: "eve, Tavi is visiting next week" });
    await waitFor(() => r.brains.requests.length === 1);
    expect(r.brains.requests[0]!.extra).toContain("cousin who lives in Seoul");
    expect(r.brains.requests[0]!.extra).not.toContain("don't remember");
    await r.stop();
  });

  test("miss path, slow: she covers now, knows it next turn", async () => {
    const r = await rig({ reflex: true, searchDelayMs: 1200, search: (q) => (q === "Tavi" ? `[1.1] people/tavi -- Tavi is matt's cousin who lives in Seoul.` : "") });
    r.emit("companion.born", { persona, woken: true });
    await waitFor(() => r.speech.said.length === 1);
    const t0 = Date.now();
    r.emit("voice.final", { text: "eve, Tavi is visiting next week" });
    await waitFor(() => r.brains.requests.length === 1);
    expect(Date.now() - t0).toBeLessThan(1000); // waited ~600ms, not 1200
    expect(r.brains.requests[0]!.extra).toContain(`you don't remember "Tavi" yet`);
    await waitFor(() => r.mem.shortTerm().some((x) => x.content.includes("Seoul")), 3000);
    r.emit("voice.final", { text: "anyway what should i do with tavi" });
    await waitFor(() => r.brains.requests.length === 2);
    expect(r.brains.requests[1]!.extra).toContain("cousin who lives in Seoul");
    await r.stop();
  });
});
