import { describe, expect, test } from "bun:test";
import { applyWear, clashes, describeOutfit, type AnyEnvelope, type EventMap, type EventType } from "@eigenwife/protocol";
import { createAgency } from "../src/agency/module";
import type { AgencyDeps } from "../src/agency/types";
import { createJev } from "../src/reflex/jev";
import { POKE_LINES, reflexModule } from "../src/reflex/module";
import { readOutfit } from "../src/reflex/outfit";
import { emitAt, FakeBrains, FakeClock, fakeContext, FakeHome, FakeSpeech, settle, startModules } from "../src/reflex/testing";
import { HOME_FILE, wardrobeModule } from "../src/wardrobe/module";

// ---------------------------------------------------------------------------
// Catalog + slot rules (protocol, shared with the shell)
// ---------------------------------------------------------------------------

describe("wardrobe catalog", () => {
  test("items in one slot are exclusive: the later one wins", () => {
    expect(applyWear([], { add: ["hoodie", "hood_up"] })).toEqual(["hood_up"]);
    expect(applyWear(["sunglasses"], { add: ["sunglasses_up"] })).toEqual(["sunglasses_up"]);
    expect(applyWear(["odd_eye_left"], { add: ["odd_eye_right"] })).toEqual(["odd_eye_right"]);
  });
  test("different slots stack, in catalog order", () => {
    expect(applyWear([], { add: ["lollipop", "sunglasses", "hoodie"] })).toEqual(["hoodie", "sunglasses", "lollipop"]);
  });
  test("remove, unknown ids and an allowed list", () => {
    expect(applyWear(["hoodie", "sunglasses"], { remove: ["hoodie"] })).toEqual(["sunglasses"]);
    expect(applyWear([], { add: ["dress", "hoodie"] })).toEqual(["hoodie"]);
    expect(applyWear([], { add: ["hoodie", "lollipop"] }, undefined, ["lollipop"])).toEqual(["lollipop"]);
    expect(applyWear(["hoodie"], { add: ["sunglasses"] }, undefined, [])).toEqual([]);
  });
  test("clashes and descriptions", () => {
    expect(clashes("hoodie", "hood_up")).toBe(true);
    expect(clashes("hoodie", "sunglasses")).toBe(false);
    expect(clashes("hoodie", "hoodie")).toBe(false);
    expect(describeOutfit(["hoodie", "sunglasses"])).toBe("cat hoodie, sunglasses");
    expect(describeOutfit([])).toContain("usual");
  });
});

// ---------------------------------------------------------------------------
// Spoken requests
// ---------------------------------------------------------------------------

describe("readOutfit", () => {
  const cases: [string, ReturnType<typeof readOutfit>][] = [
    ["put your hoodie on", { kind: "wear", add: ["hoodie"] }],
    ["put your pajamas on", { kind: "wear", add: ["hoodie"] }],
    ["get comfy", { kind: "wear", add: ["hoodie"] }],
    ["wear your cozy clothes", { kind: "wear", add: ["hoodie"] }],
    ["hood up", { kind: "wear", add: ["hood_up"] }],
    ["put your hood up", { kind: "wear", add: ["hood_up"] }],
    ["hood down", { kind: "wear", add: ["hoodie"] }],
    ["wear your glasses", { kind: "wear", add: ["sunglasses"] }],
    ["shades on", { kind: "wear", add: ["sunglasses"] }],
    ["put on your sunglasses and grab a lollipop", { kind: "wear", add: ["sunglasses", "lollipop"] }],
    ["push your sunglasses up", { kind: "wear", add: ["sunglasses_up"] }],
    ["show me your heterochromia", null],
    ["try the odd eyes", { kind: "wear", add: ["odd_eye_left"] }],
    ["lose the sunglasses", { kind: "remove", remove: ["sunglasses", "sunglasses_up"] }],
    ["sunglasses off", { kind: "remove", remove: ["sunglasses", "sunglasses_up"] }],
    ["take off the hoodie", { kind: "remove", remove: ["hoodie", "hood_up"] }],
    ["take it off", { kind: "remove", remove: "all" }],
    ["normal clothes", { kind: "remove", remove: "all" }],
    ["change back", { kind: "remove", remove: "all" }],
    ["change clothes", { kind: "change" }],
    ["what are you wearing", { kind: "ask" }],
    ["what're you wearing?", { kind: "ask" }],
    ["can you wear a dress", { kind: "missing", want: "dress" }],
    ["put on a kimono", { kind: "missing", want: "kimono" }],
  ];
  test.each(cases)("%p", (text, want) => {
    expect(readOutfit(text)).toEqual(want);
  });
  test.each(["i bought sunglasses today", "should i wear a dress tonight", "take it off my calendar", "where are my glasses", "that dress is ugly", "put it on the calendar", ""])(
    "%p is not an outfit request",
    (text) => {
      expect(readOutfit(text)).toBeNull();
    },
  );
});

// ---------------------------------------------------------------------------
// Core module: service, persistence, restore, slots
// ---------------------------------------------------------------------------

async function wardrobeRig(files = new Map<string, unknown>()) {
  const ctx = fakeContext();
  const home = new FakeHome(files);
  ctx.provide("home", home);
  const events: AnyEnvelope[] = [];
  ctx.bus.on("avatar.outfit", (e) => void events.push(e));
  const stop = await startModules(ctx, [wardrobeModule()]);
  return { ctx, home, events, stop, w: ctx.use("wardrobe") };
}

describe("wardrobe module", () => {
  test("restore: empty home emits an empty outfit by restore", async () => {
    const r = await wardrobeRig();
    expect(r.events.map((e) => e.data)).toEqual([{ items: [], by: "restore" }]);
    expect(r.ctx.world().slots.wardrobe?.wearing).toContain("usual");
    await r.stop();
  });

  test("wear persists, emits, and fills the prompt slot; restart restores it", async () => {
    const r = await wardrobeRig();
    const out = await r.w.wear({ add: ["hoodie", "sunglasses"] });
    expect(out).toEqual({ items: ["hoodie", "sunglasses"], changed: true, unavailable: [] });
    expect(r.events.at(-1)!.data).toEqual({ items: ["hoodie", "sunglasses"], by: "user" });
    expect(r.ctx.world().slots.wardrobe).toEqual({ wearing: "cat hoodie, sunglasses", items: "hoodie,sunglasses" });
    expect((r.home.files.get(HOME_FILE) as { items: string[] }).items).toEqual(["hoodie", "sunglasses"]);
    expect(r.ctx.contextBlock()).toContain("wardrobe.wearing: cat hoodie, sunglasses");
    await r.stop();

    const again = await wardrobeRig(r.home.files);
    expect(again.events[0]!.data).toEqual({ items: ["hoodie", "sunglasses"], by: "restore" });
    expect(again.w.get().items).toEqual(["hoodie", "sunglasses"]);
    await again.stop();
  });

  test("no change, no event; remove all clears", async () => {
    const r = await wardrobeRig();
    await r.w.wear({ add: ["lollipop"] });
    const n = r.events.length;
    expect((await r.w.wear({ add: ["lollipop"] })).changed).toBe(false);
    expect(r.events.length).toBe(n);
    await r.w.wear({ remove: "all" });
    expect(r.w.get().items).toEqual([]);
    await r.stop();
  });

  test("a model without a wardrobe (Haru): nothing can be worn", async () => {
    const r = await wardrobeRig();
    r.ctx.bus.emit("avatar.model", { id: "haru", wardrobe: [] }, "shell");
    const out = await r.w.wear({ add: ["hoodie"] });
    expect(out).toEqual({ items: [], changed: false, unavailable: ["hoodie"] });
    expect(r.w.available()).toEqual([]);
    await r.stop();
  });

  test("restored junk is sanitized", async () => {
    const r = await wardrobeRig(new Map([[HOME_FILE, { items: ["hoodie", "hood_up", "tiara"], by: "user", updatedAt: 1 }]]));
    expect(r.w.get().items).toEqual(["hood_up"]);
    await r.stop();
  });

  test("POST /api/wardrobe (the tray) and GET", async () => {
    const r = await wardrobeRig();
    const route = (r.ctx as unknown as { routes: Map<string, (req: Request, url: URL) => Promise<Response>> }).routes.get("/api/wardrobe")!;
    const u = new URL("http://x/api/wardrobe");
    let res = await route(new Request(u, { method: "POST", body: JSON.stringify({ add: ["sunglasses"] }) }), u);
    expect(((await res.json()) as { items: string[] }).items).toEqual(["sunglasses"]);
    res = await route(new Request(u), u);
    const j = (await res.json()) as { items: string[]; catalog: { id: string; on: boolean }[] };
    expect(j.items).toEqual(["sunglasses"]);
    expect(j.catalog.find((c) => c.id === "sunglasses")!.on).toBe(true);
    res = await route(new Request(u, { method: "POST", body: JSON.stringify({ remove: "all" }) }), u);
    expect(((await res.json()) as { items: string[] }).items).toEqual([]);
    await r.stop();
  });
});

// ---------------------------------------------------------------------------
// avatar.wear action: SAFE_ACTION, no approval
// ---------------------------------------------------------------------------

test("avatar.wear runs without an approval prompt", async () => {
  const r = await wardrobeRig();
  const events: AnyEnvelope[] = [];
  r.ctx.bus.on("*", (e) => void events.push(e));
  const deps: Partial<AgencyDeps> = { loadHarem: async () => null, now: () => 0, env: () => "" };
  const agency = createAgency(r.ctx, { deps, approvalTimeoutMs: 50 });
  const out = await agency.service.act("avatar.wear", { add: ["hood_up"] });
  expect(out.ok).toBe(true);
  expect(out.observation).toBe("wearing: cat hoodie, hood up");
  const req = events.find((e) => e.type === "action.request") as Extract<AnyEnvelope, { type: "action.request" }>;
  expect(req.data.permission).toBe("SAFE_ACTION");
  expect(req.data.needsApproval).toBe(false);
  expect(r.w.get()).toMatchObject({ items: ["hood_up"], by: "agent" });
  agency.stop();
  await r.stop();
});

// ---------------------------------------------------------------------------
// Reflex: spoken requests end to end, poke rule
// ---------------------------------------------------------------------------

const persona = {
  name: "Eve",
  tagline: "",
  description: "",
  personality: "",
  scenario: "",
  dials: { humor: 0.7, sarcasm: 0.6, warmth: 0.5, initiative: 0.5, verbosity: 0.3, chaos: 0.2 },
  voice: { provider: "x", voiceId: "x", style: "x" },
  palette: { hue: 0 },
  vector: {},
};

async function reflexRig(brains = false) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  const speech = new FakeSpeech(ctx, clock);
  const b = new FakeBrains((r) => `(${r.behavior}) ${r.extra?.includes("you are now wearing") ? "styled" : "ok"}`);
  ctx.provide("speech", speech);
  ctx.provide("home", new FakeHome());
  if (brains) ctx.provide("brains", b);
  const stop = await startModules(ctx, [wardrobeModule(), reflexModule({ now: clock.now, jev: createJev({}) })]);
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  emit("companion.born", { persona });
  await settle(10);
  speech.said.length = 0;
  clock.advance(120_000);
  return { ctx, clock, speech, brains: b, emit, stop, w: ctx.use("wardrobe") };
}

describe("reflex outfit requests", () => {
  test("'put your hoodie on': she changes, then says one line (scripted without brains)", async () => {
    const r = await reflexRig();
    const outfits: string[][] = [];
    r.ctx.bus.on("avatar.outfit", (e) => void outfits.push(e.data.items));
    r.emit("voice.final", { text: "put your hoodie on" });
    await settle(10);
    expect(outfits).toEqual([["hoodie"]]);
    expect(r.speech.said.length).toBe(1);
    expect(["there. happy?", "better?", "okay, how's this?"]).toContain(r.speech.said[0]!.text);
    await r.stop();
  });

  test("with brains: the persona line knows what she has on", async () => {
    const r = await reflexRig(true);
    r.emit("voice.final", { text: "hood up" });
    await settle(10);
    const req = r.brains.requests.at(-1)!;
    expect(req.extra).toContain("you are now wearing: cat hoodie, hood up");
    expect(req.extra).toContain("never invent");
    expect(r.speech.said[0]!.text).toBe("(react) styled");
    await r.stop();
  });

  test("'what are you wearing' answers from the slot and changes nothing", async () => {
    const r = await reflexRig();
    await r.w.wear({ add: ["sunglasses"] });
    r.emit("voice.final", { text: "what are you wearing?" });
    await settle(10);
    expect(r.speech.said[0]!.text).toBe("sunglasses. obviously.");
    expect(r.w.get().items).toEqual(["sunglasses"]);
    await r.stop();
  });

  test("something she doesn't have: says so and offers what exists", async () => {
    const r = await reflexRig();
    r.emit("voice.final", { text: "can you wear a dress" });
    await settle(10);
    expect(r.speech.said[0]!.text).toStartWith("i don't own a dress. i've got cat hoodie");
    expect(r.w.get().items).toEqual([]);
    await r.stop();
  });

  test("'take it off' clears; 'change clothes' toggles the hoodie", async () => {
    const r = await reflexRig();
    await r.w.wear({ add: ["hoodie", "lollipop"] });
    r.emit("voice.final", { text: "take it off" });
    await settle(10);
    expect(r.w.get().items).toEqual([]);
    r.clock.advance(5000);
    r.emit("voice.final", { text: "change clothes" });
    await settle(10);
    expect(r.w.get().items).toEqual(["hoodie"]);
    await r.stop();
  });

  test("moods and time never change the outfit on their own", async () => {
    const r = await reflexRig();
    await r.w.wear({ add: ["sunglasses_up"] });
    r.emit("avatar.mood", { mood: "smug", intensity: 1 });
    r.emit("task.done", { taskId: "t", ok: true, summary: "done", ms: 1 });
    for (let i = 0; i < 50; i++) {
      r.clock.advance(60 * 60_000);
      r.emit("timer.tick", { n: i });
    }
    await settle(10);
    expect(r.w.get().items).toEqual(["sunglasses_up"]);
    await r.stop();
  });

  test("3 pokes: one scripted line, then a 30s cooldown", async () => {
    const r = await reflexRig();
    r.emit("avatar.poke", { region: "body", count: 2 });
    await settle(10);
    expect(r.speech.said.length).toBe(0);
    r.emit("avatar.poke", { region: "body", count: 3 });
    await settle(10);
    expect(r.speech.said.length).toBe(1);
    expect(POKE_LINES).toContain(r.speech.said[0]!.text);
    r.clock.advance(10_000);
    r.emit("avatar.poke", { region: "head", count: 4 });
    await settle(10);
    expect(r.speech.said.length).toBe(1);
    r.clock.advance(31_000);
    r.emit("avatar.poke", { region: "head", count: 3 });
    await settle(10);
    expect(r.speech.said.length).toBe(2);
    await r.stop();
  });
});
