import { expect, test } from "bun:test";
import type { EventMap, EventType, GazeTarget, ReflexDecision } from "@eigenwife/protocol";
import type { CoreContext } from "../src/context";
import type { JevDecider } from "../src/reflex/jev";
import { ACK_LINES, BIRTH_LINE, RELAPSE_LINE, reflexModule } from "../src/reflex/module";
import { emitAt, FakeAgency, FakeBrains, FakeClock, fakeContext, FakeMemory, FakeSpeech, settle, startModules } from "../src/reflex/testing";

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
const ramen: GazeTarget = { key: "menu_ramen", label: "Garlic Knockout Ramen, $21, 4.6 stars", kind: "menu-item", meta: { price: 21, spicy: true } };

async function rig(opts: { jev?: JevDecider; services?: ("speech" | "brains" | "memory" | "agency")[]; demo?: boolean } = {}) {
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  ctx.config.demo = opts.demo ?? false;
  const want = new Set(opts.services ?? ["speech", "brains", "memory", "agency"]);
  const speech = new FakeSpeech(ctx, clock);
  const brains = new FakeBrains((r) => (r.behavior === "report" ? "booked. ramen at 8, you're welcome." : `(${r.behavior}) sure`));
  const memory = new FakeMemory(ctx, ["complained that $28 ramen was overpriced", "likes spicy food"]);
  const agency = new FakeAgency();
  if (want.has("speech")) ctx.provide("speech", speech);
  if (want.has("brains")) ctx.provide("brains", brains);
  if (want.has("memory")) ctx.provide("memory", memory);
  if (want.has("agency")) ctx.provide("agency", agency);
  const decisions: { trigger: string; decision: ReflexDecision; by: string }[] = [];
  ctx.bus.on("reflex.decision", (e) => {
    decisions.push({ trigger: e.data.trigger, decision: e.data.decision, by: e.data.by });
    // REFLEX_SIM_TRACE=1 prints every non-trivial decision with its scores
    if (process.env.REFLEX_SIM_TRACE && !/^(stare|app_opened)#/.test(e.data.trigger)) console.log(e.data.decision, JSON.stringify(e.data.scores), e.data.reason);
  });
  const stop = await startModules(ctx, [reflexModule({ now: clock.now, jev: opts.jev })]);
  const emit = <K extends EventType>(type: K, data: EventMap[K]) => emitAt(ctx, clock, type, data);
  return { ctx, clock, speech, brains, memory, agency, decisions, stop, emit };
}

async function bornRig(o: Parameters<typeof rig>[0] = {}) {
  const r = await rig(o);
  r.emit("companion.born", { persona });
  await settle(10);
  r.speech.said.length = 0;
  r.brains.requests.length = 0;
  r.decisions.length = 0;
  r.clock.advance(120_000); // her first line is old news
  return r;
}

test("companion.born: her first words, through persona with behavior greet", async () => {
  const r = await rig();
  r.emit("companion.born", { persona });
  await settle(10);
  expect(r.decisions[0]!.decision).toBe("COMMENT");
  expect(r.brains.requests[0]!.behavior).toBe("greet");
  expect(r.speech.said[0]!.text).toBe("(greet) sure");
  await r.stop();
});

test("deixis: 'thoughts?' puts the gaze target in the persona prompt, recalls memory", async () => {
  const r = await bornRig();
  let recallEvent = false;
  r.ctx.bus.on("memory.recall", () => (recallEvent = true));
  r.emit("gaze.target", { target: ramen, dwellMs: 900, confidence: 0.9 });
  const said = r.emit("voice.final", { text: "thoughts?" });
  await settle(10);
  const req = r.brains.requests.at(-1)!;
  expect(req.behavior).toBe("answer");
  expect(req.userText).toBe("thoughts?");
  expect(req.marks).toBe(true);
  expect(req.extra!.split("\n")[0]).toBe(`they are looking at: ${ramen.label} {"price":21,"spicy":true}`);
  expect(req.extra).toContain(`they mean ${ramen.label}`);
  expect(req.extra).toContain("$28 ramen was overpriced");
  expect(r.memory.recalls).toContain("thoughts?");
  expect(recallEvent).toBe(true);
  expect(r.speech.said.at(-1)!.opts!.parent).toBe(said.id);
  expect(r.memory.observed.at(-1)).toMatchObject({ user: "thoughts?", eve: "(answer) sure" });
  await r.stop();
});

test("companion.born in demo mode: the scripted, pre-rendered birth line", async () => {
  const r = await rig({ demo: true });
  r.emit("companion.born", { persona });
  await settle(10);
  expect(r.speech.said[0]!.text).toBe(BIRTH_LINE);
  expect(r.brains.requests.length).toBe(0);
  await r.stop();
});

test("ESCALATE: a short task summary is spoken verbatim, never paraphrased", async () => {
  const r = await bornRig();
  r.agency.result = { ok: true, summary: "7:30 at Menya Kaze, $18. Not booking it then." };
  r.emit("voice.final", { text: "can you figure out dinner for tonight?" });
  await settle(10);
  await Bun.sleep(20);
  await settle(10);
  expect(r.brains.requests.find((q) => q.behavior === "report")).toBeUndefined();
  expect(r.speech.said.at(-1)!.text).toBe("7:30 at Menya Kaze, $18. Not booking it then.");
  await r.stop();
});

test("ESCALATE: acknowledges, runs the task through agency, reports a long result via persona", async () => {
  const r = await bornRig();
  r.agency.result = {
    ok: true,
    summary:
      "booked Ramen Nagi for 8pm, $18 bowls, 10 min walk, and I also checked three other places nearby but they were either over budget or had a forty minute wait, so Nagi it is, and I set a reminder",
  };
  const e = r.emit("voice.final", { text: "can you figure out dinner for tonight?" });
  await settle(10);
  expect(r.decisions.at(-1)!.decision).toBe("ESCALATE");
  expect(ACK_LINES).toContain(r.speech.said[0]!.text);
  expect(r.agency.tasks[0]).toEqual({ goal: "Figure out dinner for tonight", parent: e.id });
  await Bun.sleep(20);
  await settle(10);
  const report = r.brains.requests.find((q) => q.behavior === "report")!;
  expect(report.extra).toContain("booked Ramen Nagi for 8pm");
  expect(report.extra).toContain("ground truth");
  expect(report.userText).toBe("can you figure out dinner for tonight?");
  expect(r.speech.said.at(-1)!.text).toBe("booked. ramen at 8, you're welcome.");
  expect(r.memory.observed.at(-1)!.event).toContain("task done");
  await r.stop();
});

test("own task.done during an escalation is ignored, not double-reported", async () => {
  const r = await bornRig();
  r.agency.delayMs = 50;
  r.emit("voice.final", { text: "plan my saturday" });
  await settle(10);
  r.emit("task.done", { taskId: "t1", ok: true, summary: "saturday planned", ms: 40 });
  r.clock.advance(2000);
  r.emit("timer.tick", { n: 1 });
  await settle(10);
  const d = r.decisions.find((x) => x.trigger.startsWith("task_done"))!;
  expect(d.decision).toBe("IGNORE");
  await Bun.sleep(70);
  await r.stop();
});

test("stop words stop speech immediately, even mid-reaction, and flush ambient queue", async () => {
  const r = await bornRig();
  r.speech.talking = true;
  r.emit("media.play", { track: "a" });
  r.emit("media.play", { track: "a" });
  r.emit("media.play", { track: "a" });
  r.emit("voice.final", { text: "wait" });
  await settle(10);
  expect(r.speech.stops).toEqual(["user said stop"]);
  expect(r.decisions.at(-1)!.decision).toBe("IGNORE");
  r.speech.talking = false;
  r.clock.advance(5000);
  r.emit("timer.tick", { n: 1 });
  await settle(10);
  expect(r.decisions.some((d) => d.trigger.startsWith("repeat_media"))).toBe(false);
  expect(r.speech.said).toHaveLength(0);
  await r.stop();
});

test("relapse: '...seriously?' then closes the app via agency", async () => {
  const r = await bornRig();
  r.emit("app.opened", { app: "Eigen" });
  await settle(10);
  expect(r.decisions.at(-1)!.decision).toBe("ACT");
  expect(r.speech.said[0]!.text).toBe(RELAPSE_LINE);
  expect(r.speech.said[0]!.opts!.mood).toBe("annoyed");
  expect(r.agency.acts).toEqual([{ kind: "shell.close_app", args: { app: "Eigen" } }]);
  await r.stop();
});

test("spoken commands: 'close spotify' quits the app, 'close it' on the dating app closes the shell app", async () => {
  const r = await bornRig();
  r.emit("voice.final", { text: "close spotify" });
  await settle(10);
  expect(r.decisions.at(-1)!.decision).toBe("ACT");
  expect(r.agency.acts.at(-1)).toEqual({ kind: "app.quit", args: { app: "spotify" } });
  r.clock.advance(30_000);
  r.emit("app.focused", { app: "Eigen" });
  r.emit("voice.final", { text: "close it" });
  await settle(10);
  expect(r.agency.acts.at(-1)).toEqual({ kind: "shell.close_app", args: { app: "Eigen" } });
  await r.stop();
});

test("ambient waits for the tick and for her to finish talking; immediate bypasses", async () => {
  const forced: JevDecider = {
    status: () => ({ remote: false, failures: 0 }),
    decide: async (i) => ({ decision: i.trigger.rule === "utterance" ? "REACT" : "COMMENT", scores: {} as any, by: "local", latencyMs: 0, reason: "forced" }),
  };
  const r = await bornRig({ jev: forced });
  r.emit("task.done", { taskId: "x", ok: true, summary: "downloaded", ms: 1 });
  await settle(10);
  expect(r.decisions).toHaveLength(0); // not drained yet
  r.speech.talking = true;
  r.emit("timer.tick", { n: 1 });
  await settle(10);
  expect(r.decisions).toHaveLength(0); // suppressed while she speaks
  r.emit("voice.final", { text: "hey" });
  await settle(10);
  expect(r.decisions.map((d) => d.trigger.split("#")[0])).toEqual(["utterance"]);
  expect(r.speech.said[0]!.opts!.interrupt).toBe(true);
  r.speech.talking = false;
  r.clock.advance(4000);
  r.emit("timer.tick", { n: 2 });
  await settle(10);
  expect(r.decisions.map((d) => d.trigger.split("#")[0])).toEqual(["utterance", "task_done"]);
  await r.stop();
});

test("GLANCE looks at the target without words", async () => {
  const glance: JevDecider = {
    status: () => ({ remote: false, failures: 0 }),
    decide: async () => ({ decision: "GLANCE", scores: {} as any, by: "local", latencyMs: 0, reason: "forced" }),
  };
  const r = await bornRig({ jev: glance });
  const looks: (string | null)[] = [];
  r.ctx.bus.on("avatar.look", (e) => looks.push(e.data.targetKey));
  r.emit("timer.tick", { n: 0 });
  r.clock.advance(10_000);
  r.emit("gaze.target", { target: ramen, dwellMs: 600, confidence: 0.9 });
  r.clock.advance(4500);
  r.emit("gaze.target", { target: ramen, dwellMs: 0, confidence: 0.9 });
  r.clock.advance(2000);
  r.emit("timer.tick", { n: 1 });
  await settle(10);
  expect(looks).toEqual(["menu_ramen"]);
  expect(r.speech.said).toHaveLength(0);
  await r.stop();
});

test("survives missing services: no speech, brains, memory, or agency", async () => {
  const r = await rig({ services: [] });
  r.emit("companion.born", { persona });
  r.emit("voice.final", { text: "thoughts?" });
  r.emit("voice.final", { text: "figure out dinner" });
  r.emit("app.opened", { app: "Eigen" });
  await settle(20);
  expect(r.decisions.length).toBeGreaterThanOrEqual(3);
  await r.stop();
});

test("fallback lines when brains is missing", async () => {
  const r = await rig({ services: ["speech"] });
  r.emit("companion.born", { persona });
  await settle(10);
  expect(r.speech.said[0]!.text.length).toBeGreaterThan(5);
  await r.stop();
});

test("reflex service: other modules can raise triggers", async () => {
  const forced: JevDecider = {
    status: () => ({ remote: false, failures: 0 }),
    decide: async () => ({ decision: "ASK", scores: {} as any, by: "local", latencyMs: 0, reason: "forced" }),
  };
  const r = await bornRig({ jev: forced });
  r.ctx.use("reflex").trigger({ id: "calendar_conflict", description: "two events overlap at 8pm", urgency: "immediate" });
  await settle(10);
  expect(r.decisions.at(-1)!.trigger).toStartWith("calendar_conflict");
  expect(r.brains.requests.at(-1)!.behavior).toBe("ask");
  await r.stop();
});

// ---------------------------------------------------------------------------
// The property that matters: over a simulated hour of normal desktop life,
// she ignores 80-95% of ambient triggers.
// ---------------------------------------------------------------------------

function rng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

async function simulateHour(seed: number) {
  const r = await rig();
  const rand = rng(seed);
  const pickOne = <T,>(a: T[]) => a[Math.floor(rand() * a.length)]!;
  const apps = ["Spotify", "Slack", "Chrome", "VS Code", "Messages", "Notes", "Figma", "Terminal", "Finder", "Calendar"];
  const tracks = ["Kyoto", "Motion Sickness", "Garden Song", "Savior Complex", "Chinese Satellite", "Funeral", "Moon Song", "ICU"];
  const targets: GazeTarget[] = [
    ramen,
    { key: "menu_gyoza", label: "Pork Gyoza, $9", kind: "menu-item" },
    { key: "menu_tsukemen", label: "Yuzu Tsukemen, $19", kind: "menu-item" },
    { key: "rest_header", label: "Menya Tsuki", kind: "restaurant" },
    { key: "hud", label: "status bar", kind: "ui" },
    { key: "eve", label: "Eve", kind: "avatar" },
    { key: "doc", label: "design doc paragraph", kind: "other" },
  ];
  r.emit("eye.status", { connected: true, calibrated: true, facePresent: true });
  r.emit("companion.born", { persona });
  await settle(5);
  const HOUR = 3_600_000;
  const start = r.clock.now();
  let n = 0;
  let nextApp = 60_000;
  let nextSong = 30_000;
  let nextTalk = 5 * 60_000;
  let away: { until: number } | null = null;
  const aways = [17 * 60_000, 41 * 60_000];
  let gazeKey: GazeTarget = targets[0]!;
  let gazeLeft = 0;
  let breakup = 0;
  let nextBreakup = 6 * 60_000;
  let nextTask = 33 * 60_000;
  for (let t = 0; t < HOUR; t += 2000) {
    r.clock.t = start + t;
    // speech in the fake is instant; she is "speaking" for 3s after any line
    const last = r.ctx.world().companion.lastSpokeAt;
    r.speech.talking = last !== undefined && r.clock.now() - last < 3000;
    if (away && t >= away.until) {
      away = null;
      r.emit("eye.status", { connected: true, calibrated: true, facePresent: true });
    }
    if (!away && aways.length && t >= aways[0]!) {
      away = { until: t + (2.5 + rand() * 3) * 60_000 };
      aways.shift();
      r.emit("gaze.lost", { reason: "away" });
      r.emit("eye.status", { connected: true, calibrated: true, facePresent: false });
    }
    if (!away) {
      // gaze: announce the current target, sometimes linger on it
      if (gazeLeft <= 0) {
        gazeKey = pickOne(targets);
        gazeLeft = rand() < 0.15 ? 3 + Math.floor(rand() * 4) : 1 + Math.floor(rand() * 2);
        r.emit("gaze.fixation", { target: gazeKey, x: 0, y: 0 });
      }
      r.emit("gaze.target", { target: gazeKey, dwellMs: 300, confidence: 0.8 });
      gazeLeft -= 1;
      if (t >= nextApp) {
        r.emit("app.opened", { app: pickOne(apps) });
        nextApp = t + (1 + rand() * 3) * 60_000;
      }
      if (t >= nextSong) {
        if (t >= nextBreakup && breakup < 5) {
          r.emit("media.play", { track: "Someone Like You", artist: "Adele" });
          breakup++;
          nextBreakup = t + 4 * 60_000;
        } else r.emit("media.play", { track: pickOne(tracks) });
        nextSong = t + (2.5 + rand() * 2) * 60_000;
      }
      if (t >= nextTalk) {
        r.emit("voice.final", { text: pickOne(["lol", "this is so good", "thoughts?", "what time is it", "ok"]) });
        nextTalk = t + (4 + rand() * 6) * 60_000;
      }
    }
    if (t >= nextTask) {
      r.emit("task.done", { taskId: "bg", ok: true, summary: "exported the slides", ms: 1000 });
      nextTask = Infinity;
    }
    r.emit("timer.tick", { n: ++n });
    await settle(4);
  }
  await settle(10);
  const ambient = r.decisions.filter((d) => !d.trigger.startsWith("utterance") && !d.trigger.startsWith("companion_born"));
  const ignored = ambient.filter((d) => d.decision === "IGNORE").length;
  const byRule: Record<string, Record<string, number>> = {};
  for (const d of ambient) {
    const rule = d.trigger.split("#")[0]!;
    byRule[rule] ??= {};
    byRule[rule]![d.decision] = (byRule[rule]![d.decision] ?? 0) + 1;
  }
  await r.stop();
  return { ambient: ambient.length, ignored, rate: ignored / ambient.length, byRule, said: r.speech.said.map((s) => s.text) };
}

test("simulated hour: ambient triggers are IGNORE 80-95% of the time", async () => {
  const rates: number[] = [];
  for (const seed of [1, 7, 42, 99, 2026]) {
    const s = await simulateHour(seed);
    rates.push(s.rate);
    if (process.env.REFLEX_SIM_VERBOSE) console.log(`seed ${seed}: ${s.ignored}/${s.ambient} ignored (${(s.rate * 100).toFixed(1)}%)`, JSON.stringify(s.byRule));
    expect(s.ambient).toBeGreaterThan(30);
    expect(s.rate).toBeGreaterThanOrEqual(0.8);
    expect(s.rate).toBeLessThanOrEqual(0.95);
    // the moments that matter still land
    expect(s.byRule.repeat_media?.COMMENT ?? 0).toBeGreaterThanOrEqual(1);
    expect(s.byRule.app_opened?.IGNORE ?? 0).toBeGreaterThan(10);
  }
}, 30_000);
