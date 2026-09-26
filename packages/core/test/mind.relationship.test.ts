import { expect, test } from "bun:test";
import { DEFAULT_RELATIONSHIP, type EventMap, type EventType, type RelationshipState } from "@eigenwife/protocol";
import { relationshipModule } from "../src/mind/module";
import { applyNudge, CEIL, combine, decay, FLOOR, HALF_LIFE_MS, MAX_STEP, readSignals, seedFromPersona } from "../src/mind/relationship";
import { emitAt, FakeClock, fakeContext, FakeHome, settle, startModules } from "../src/reflex/testing";

const persona = {
  name: "Eve",
  tagline: "",
  description: "",
  personality: "",
  scenario: "",
  dials: { humor: 0.8, sarcasm: 0.6, warmth: 0.4, initiative: 0.7, verbosity: 0.2, chaos: 0.3 },
  voice: { provider: "x", voiceId: "x", style: "x" },
  palette: { hue: 0 },
  vector: {},
};

test("nudges are bounded per step and overall", () => {
  const s = { ...DEFAULT_RELATIONSHIP };
  const big = applyNudge(s, { banter: 5, initiative: -5 });
  expect(big.applied.banter).toBeCloseTo(MAX_STEP, 5);
  expect(big.applied.initiative).toBeCloseTo(-MAX_STEP, 5);
  let st: RelationshipState = s;
  for (let i = 0; i < 50; i++) st = applyNudge(st, { banter: 0.1, verbosity: -0.1 }).state;
  expect(st.banter).toBe(CEIL);
  expect(st.verbosity).toBe(FLOOR);
  // no-op at the bound reports nothing applied
  expect(applyNudge(st, { banter: 0.05 }).applied).toEqual({});
  expect(applyNudge(st, { banter: Number.NaN }).applied).toEqual({});
});

test("decay relaxes toward baseline with the configured half-life", () => {
  const base = { ...DEFAULT_RELATIONSHIP };
  const s = { ...base, banter: base.banter + 0.2 };
  const half = decay(s, base, HALF_LIFE_MS);
  expect(half.banter).toBeCloseTo(base.banter + 0.1, 5);
  expect(decay(s, base, 20 * HALF_LIFE_MS).banter).toBeCloseTo(base.banter, 4);
  expect(decay(s, base, 0)).toEqual(s);
});

test("seed from persona dials", () => {
  const seeded = seedFromPersona(persona);
  expect(seeded.banter).toBeCloseTo(0.7, 5);
  expect(seeded.initiative).toBe(0.7);
  expect(seeded.verbosity).toBe(0.2);
  expect(seedFromPersona(null)).toEqual(DEFAULT_RELATIONSHIP);
});

test("signals: laugh, positive banter, dismissal, terse, long, sweet, engaged", () => {
  const reply = { sinceHerLineMs: 3000 };
  expect(combine(readSignals("lmao", reply))!.delta.banter).toBe(0.03);
  expect(combine(readSignals("ok fair", reply))!.delta.banter).toBe(0.03);
  expect(combine(readSignals("fair"))).toBeNull(); // not a reply to her: no banter credit
  expect(combine(readSignals("not now", reply))!.delta.initiative).toBe(-0.04);
  expect(combine(readSignals("stop", reply))!.delta.initiative).toBe(-0.04);
  expect(combine(readSignals("sure", reply))!.delta.verbosity).toBe(-0.02);
  expect(combine(readSignals("honestly i think we should go somewhere quieter because the last place was way too loud for me", reply))!.delta.verbosity).toBe(0.01);
  expect(combine(readSignals("thank you", {}))!.delta.warmth).toBe(0.03);
  expect(readSignals("what about the gyoza", { ...reply, turns: 4 }).some((s) => s.reason.includes("engaged"))).toBe(true);
});

async function rig(home = new FakeHome()) {
  const clock = new FakeClock();
  const ctx = fakeContext();
  ctx.provide("home", home);
  const updates: { reason: string; state: RelationshipState }[] = [];
  ctx.bus.on("relationship.update", (e) => updates.push({ reason: e.data.reason, state: e.data.state }));
  const stop = await startModules(ctx, [relationshipModule({ now: clock.now, persistDebounceMs: 0, decayEveryMs: 10_000 })]);
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  return { ctx, clock, home, updates, stop, emit };
}

test("module: seeds on companion.born, reacts to a laugh after her line, emits and persists", async () => {
  const r = await rig();
  r.emit("companion.born", { persona });
  expect(r.updates[0]!.reason).toContain("seeded");
  expect(r.ctx.use("relationship").get().banter).toBeCloseTo(0.7, 5);
  expect(r.ctx.world().companion.relationship.initiative).toBe(0.7);
  r.emit("speech.begin", { utteranceId: "u1", text: "we are NOT doing this song again", brain: "x" });
  r.clock.advance(2000);
  r.emit("voice.final", { text: "lol" });
  const last = r.updates.at(-1)!;
  expect(last.reason).toBe("user laughed");
  expect(last.state.banter).toBeCloseTo(0.73, 5);
  await settle();
  const saved = r.home.files.get("relationship") as { state: RelationshipState; persona: string };
  expect(saved.state.banter).toBeCloseTo(0.73, 5);
  expect(saved.persona).toBe("Eve");
  await r.stop();
});

test("module: dismissal lowers initiative; task outcomes move confidence", async () => {
  const r = await rig();
  r.emit("companion.born", { persona });
  r.emit("speech.end", { utteranceId: "u", interrupted: false });
  r.emit("voice.final", { text: "not now" });
  expect(r.ctx.use("relationship").get().initiative).toBeCloseTo(0.66, 5);
  r.emit("task.done", { taskId: "t", ok: true, summary: "", ms: 1 });
  expect(r.ctx.use("relationship").get().confidence).toBeCloseTo(0.53, 5);
  expect(r.updates.at(-1)!.reason).toBe("task went well");
  await r.stop();
});

test("module: decays back toward baseline on ticks, announcing it", async () => {
  const r = await rig();
  r.emit("companion.born", { persona });
  r.ctx.use("relationship").nudge({ banter: 0.1 }, "test");
  expect(r.ctx.use("relationship").get().banter).toBeCloseTo(0.8, 5);
  r.clock.advance(HALF_LIFE_MS);
  r.emit("timer.tick", { n: 1 });
  expect(r.updates.at(-1)!.reason).toBe("decay toward baseline");
  expect(r.ctx.use("relationship").get().banter).toBeCloseTo(0.75, 3);
  await r.stop();
});

test("module: restores from home across restarts (with elapsed decay)", async () => {
  const home = new FakeHome();
  const a = await rig(home);
  a.emit("companion.born", { persona });
  a.ctx.use("relationship").nudge({ warmth: 0.1 }, "test");
  await settle();
  await a.stop();
  const b = await rig(home);
  expect(b.updates[0]!.reason).toBe("restored from home");
  expect(b.ctx.use("relationship").get().warmth).toBeGreaterThan(0.45);
  // same persona reborn: keeps the learned state instead of resetting it
  b.emit("companion.born", { persona });
  expect(b.ctx.use("relationship").get().warmth).toBeGreaterThan(0.45);
  await b.stop();
});

test("module: works with no home service", async () => {
  const ctx = fakeContext();
  const stop = await startModules(ctx, [relationshipModule({ persistDebounceMs: 0 })]);
  expect(ctx.use("relationship").nudge({ banter: 0.03 }, "x").banter).toBeCloseTo(DEFAULT_RELATIONSHIP.banter + 0.03, 5);
  await stop();
});
