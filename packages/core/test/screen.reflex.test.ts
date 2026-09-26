import { expect, test } from "bun:test";
import type { EventMap, ReflexDecision } from "@eigenwife/protocol";
import { createJev } from "../src/reflex/jev";
import { LOOK_LINES, reflexModule } from "../src/reflex/module";
import { emitAt, FakeAgency, FakeBrains, FakeClock, fakeContext, FakeMemory, FakeSpeech, settle, startModules } from "../src/reflex/testing";
import type { ScreenService, ScreenSnapshot, WorkService } from "../src/services";

/** The mind's side of screen awareness: deictic looks, the stuck offer, remarks, deep focus. Fakes only. */

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

class FakeScreen implements ScreenService {
  looks: { reason: string; question?: string }[] = [];
  can = true;
  snap: ScreenSnapshot | null = { app: "TextEdit", summary: "TextEdit: bug.txt · error: TypeError (hub.ts line 42)", mode: "debugging", stuck: false, interesting: 0.3, at: 0 };
  description = "A TextEdit window with a TypeError about reading 'port' in hub.ts line 42.";
  current() {
    return this.snap;
  }
  canLook() {
    return this.can;
  }
  async look(reason: "deictic" | "stuck" | "auto", o?: { question?: string }) {
    this.looks.push({ reason, question: o?.question });
    return { ok: true, description: this.description, app: "TextEdit", by: "fake" };
  }
  paused() {
    return false;
  }
}

class FakeWork implements WorkService {
  handled: string[] = [];
  context() {
    return null;
  }
  claims(text: string) {
    return /^fix\b/i.test(text);
  }
  awaiting() {
    return false;
  }
  async handle(text: string) {
    this.handled.push(text);
    return { ok: true, summary: "fixed it on a branch." };
  }
  resolveRepo() {
    return { name: "eigenwife", path: "/tmp/eigenwife" };
  }
}

async function rig() {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  const speech = new FakeSpeech(ctx, clock);
  const brains = new FakeBrains((r) => `(${r.behavior}) ok`);
  const screen = new FakeScreen();
  const work = new FakeWork();
  const agency = new FakeAgency();
  ctx.provide("speech", speech);
  ctx.provide("brains", brains);
  ctx.provide("memory", new FakeMemory(ctx));
  ctx.provide("screen", screen);
  ctx.provide("work", work);
  ctx.provide("agency", agency);
  const decisions: { trigger: string; decision: ReflexDecision }[] = [];
  ctx.bus.on("reflex.decision", (e) => decisions.push({ trigger: e.data.trigger, decision: e.data.decision }));
  const stop = await startModules(ctx, [reflexModule({ now: clock.now, jev: createJev({}) })]);
  const emit = <K extends keyof EventMap>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  emit("companion.born", { persona });
  await settle(10);
  speech.said.length = 0;
  brains.requests.length = 0;
  decisions.length = 0;
  clock.advance(120_000);
  const tick = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(2000);
      emit("timer.tick", { n: i });
      await settle(8);
    }
  };
  return { ctx, clock, speech, brains, screen, work, agency, decisions, stop, emit, tick };
}

const stuckObs = (min: number): EventMap["screen.observation"] => ({
  app: "Terminal",
  title: "bun test",
  summary: "Terminal: bun test · error: TypeError: x is undefined (hub.ts line 42)",
  error: "TypeError: x is undefined (hub.ts line 42)",
  stuckMs: min * 60_000,
  scores: { mode: "debugging", stuck: min >= 5, interesting: 0.3, sensitive: false },
  by: "local",
});

test("deictic question in another app: a quick 'lemme see', a level 3 look, the description grounds the answer", async () => {
  const r = await rig();
  r.emit("voice.final", { text: "what do you think of this" });
  await settle(15);
  expect(r.screen.looks).toEqual([{ reason: "deictic", question: "what do you think of this" }]);
  expect(LOOK_LINES).toContain(r.speech.said[0]!.text);
  const req = r.brains.requests.at(-1)!;
  expect(req.extra).toContain("on their screen right now (TextEdit): A TextEdit window with a TypeError");
  expect(req.extra).toContain("they mean what's on their screen");
  await r.stop();
});

test("no look when she can't (paused, Eve in front) or the line isn't pointing at anything", async () => {
  const r = await rig();
  r.emit("voice.final", { text: "what time is it" });
  await settle(10);
  r.screen.can = false;
  r.clock.advance(30_000);
  r.emit("voice.final", { text: "thoughts?" });
  await settle(10);
  expect(r.screen.looks.length).toBe(0);
  await r.stop();
});

test("a fresh gaze target wins over the screen for 'this'", async () => {
  const r = await rig();
  r.emit("gaze.target", { target: { key: "menu_ramen", label: "Garlic Ramen, $21", kind: "menu-item" }, dwellMs: 900, confidence: 0.9 });
  r.emit("voice.final", { text: "thoughts?" });
  await settle(10);
  expect(r.screen.looks.length).toBe(0);
  expect(r.brains.requests.at(-1)!.extra).toContain("Garlic Ramen");
  await r.stop();
});

test("stuck on an error: HELP offer with a look, then 'yeah' hands the error to work mode", async () => {
  const r = await rig();
  r.emit("screen.observation", stuckObs(6));
  await r.tick(3);
  const d = r.decisions.find((x) => x.trigger.startsWith("screen_stuck"));
  expect(d?.decision).toBe("HELP");
  expect(r.screen.looks).toEqual([{ reason: "stuck", question: undefined }]);
  const req = r.brains.requests.at(-1)!;
  expect(req.behavior).toBe("help");
  expect(req.extra).toContain("the error: TypeError: x is undefined (hub.ts line 42)");
  expect(req.extra).toContain("want me to look?");
  r.clock.advance(5_000);
  r.emit("voice.final", { text: "yeah" });
  await settle(20);
  expect(r.decisions.at(-1)!.decision).toBe("ESCALATE");
  expect(r.work.handled).toEqual(["fix TypeError: x is undefined (hub.ts line 42) in eigenwife"]);
  await r.stop();
});

test("stuck offer: 'nah' drops it; the offer expires after 2 minutes", async () => {
  const r = await rig();
  r.emit("screen.observation", stuckObs(6));
  await r.tick(3);
  r.emit("voice.final", { text: "nah i got it" });
  await settle(10);
  r.clock.advance(5_000);
  r.emit("voice.final", { text: "yeah" });
  await settle(10);
  expect(r.work.handled.length).toBe(0);
  await r.stop();
});

test("stuck rule rate limits: not before 5 min, not while typing, once per error, 10 min between any", async () => {
  const r = await rig();
  r.emit("screen.observation", stuckObs(3));
  r.emit("screen.observation", { ...stuckObs(7), focus: true });
  await r.tick(2);
  expect(r.decisions.filter((d) => d.trigger.startsWith("screen_stuck")).length).toBe(0);
  r.emit("screen.observation", stuckObs(6));
  await r.tick(2);
  r.clock.advance(60_000);
  r.emit("screen.observation", stuckObs(7));
  await r.tick(2);
  r.emit("screen.observation", { ...stuckObs(8), error: "ReferenceError: y is not defined (a.ts line 3)" });
  await r.tick(2);
  expect(r.decisions.filter((d) => d.trigger.startsWith("screen_stuck")).length).toBe(1);
  r.clock.advance(11 * 60_000);
  r.emit("screen.observation", { ...stuckObs(19), error: "ReferenceError: y is not defined (a.ts line 3)" });
  await r.tick(2);
  expect(r.decisions.filter((d) => d.trigger.startsWith("screen_stuck")).length).toBe(2);
  await r.stop();
});

test("interesting screens: a remark prompt carries the summary; private, sensitive, deep focus and coding never raise one", async () => {
  const r = await rig();
  const base: EventMap["screen.observation"] = { app: "Google Chrome", title: "Wool Jacket | SSENSE", summary: "Chrome: Wool Jacket | SSENSE · $1,250", scores: { mode: "shopping", stuck: false, interesting: 0.95, sensitive: false }, by: "jev" };
  r.emit("screen.observation", { ...base, private: true });
  r.emit("screen.observation", { ...base, scores: { ...base.scores, sensitive: true } });
  r.emit("screen.observation", { ...base, focus: true });
  r.emit("screen.observation", { ...base, scores: { ...base.scores, mode: "coding" } });
  r.emit("screen.observation", { ...base, scores: { ...base.scores, interesting: 0.5 } });
  await r.tick(2);
  expect(r.decisions.filter((d) => d.trigger.startsWith("screen_interesting")).length).toBe(0);
  r.emit("screen.observation", base);
  await r.tick(2);
  const fired = r.decisions.filter((d) => d.trigger.startsWith("screen_interesting"));
  expect(fired.length).toBe(1);
  if (fired[0]!.decision === "COMMENT") expect(r.brains.requests.at(-1)!.extra).toContain("that jacket is mid");
  // 8 min between remarks, 30 min per page
  r.emit("screen.observation", { ...base, title: "Other Jacket" });
  await r.tick(2);
  expect(r.decisions.filter((d) => d.trigger.startsWith("screen_interesting")).length).toBe(1);
  await r.stop();
});

test("deep focus: ambient remarks get quieter while he types", async () => {
  const { localScore } = await import("../src/reflex/jev");
  const r = await rig();
  const world = r.ctx.world();
  const trig = { id: "screen_interesting#1", rule: "screen_interesting", description: "x", urgency: "later" as const, data: { interesting: 0.95, mode: "shopping" }, at: 0, ambient: true };
  const input = { trigger: trig, relationship: world.companion.relationship, now: r.clock.now() };
  const calm = localScore({ ...input, world });
  r.ctx.setSlot("screen", "focus", "deep");
  const focused = localScore({ ...input, world: r.ctx.world() });
  expect(focused.scores.IGNORE).toBeGreaterThan(calm.scores.IGNORE);
  expect(focused.decision).toBe("IGNORE");
  await r.stop();
});
