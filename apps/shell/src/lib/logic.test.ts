import { describe, expect, test } from "bun:test";
import { CANDIDATES, TRAIT_KEYS, envelope, regionKey, type EventMap, type EventType, type RegionStats } from "@eigenwife/protocol";
import { DEFAULT_ADVANCE, advanceReason, pointInRect } from "./advance";
import { LocalPreference, engagement, evidenceVector, lifts, localPersona, localProgress, localSignal, personaHue } from "./fallback";
import { hueDelta } from "./hue";
import { SCENE_ORDER, isOperatorKeyEvent, keyAction, nextHudLevel, toggledGazeUrl } from "./keys";
import { formatWhen, initialShell, reduceShell, summarizeResult, type ShellState } from "./store";

const stat = (dwellMs: number, revisits = 0): RegionStats => ({ dwellMs, visits: revisits + 1, revisits, longestMs: dwellMs });

describe("candidates", () => {
  test("12 candidates, unique ids, full trait vectors in range", () => {
    expect(CANDIDATES.length).toBe(12);
    expect(new Set(CANDIDATES.map((c) => c.id)).size).toBe(12);
    for (const c of CANDIDATES) {
      for (const k of TRAIT_KEYS) {
        expect(c.traits[k]).toBeGreaterThanOrEqual(0);
        expect(c.traits[k]).toBeLessThanOrEqual(1);
      }
      expect(c.regions.map((r) => r.id)).toEqual(["photo1", "photo2", "prompt1", "prompt2", "prompt3", "meta"]);
      expect(c.prompts.length).toBe(3);
      expect(c.photos.length).toBe(2);
    }
  });
  test("no em or en dashes in copy", () => {
    const text = JSON.stringify(CANDIDATES);
    expect(text.includes("—")).toBe(false);
    expect(text.includes("–")).toBe(false);
  });
  test("region keys never collide across candidates", () => {
    const keys = CANDIDATES.flatMap((c) => c.regions.map((r) => regionKey(c.id, r.id)));
    expect(new Set(keys).size).toBe(keys.length);
    // Prefix filtering by `cand_<id>_` must not leak between ids.
    for (const a of CANDIDATES) for (const b of CANDIDATES) if (a !== b) expect(regionKey(b.id, "x").startsWith(`cand_${a.id}_`)).toBe(false);
  });
});

describe("auto-advance", () => {
  const t0 = 1_000_000;
  test("holds while gaze stays on the card", () => {
    expect(advanceReason({ now: t0 + 5000, shownAt: t0, lastOnCardAt: t0 + 4990 })).toBeNull();
  });
  test("advances after looking away for 1.5s", () => {
    expect(advanceReason({ now: t0 + 4000, shownAt: t0, lastOnCardAt: t0 + 2400 })).toBe("away");
    expect(advanceReason({ now: t0 + 3800, shownAt: t0, lastOnCardAt: t0 + 2400 })).toBeNull();
  });
  test("never advances before the minimum", () => {
    expect(advanceReason({ now: t0 + 1700, shownAt: t0, lastOnCardAt: null })).toBeNull();
    expect(advanceReason({ now: t0 + DEFAULT_ADVANCE.minMs, shownAt: t0, lastOnCardAt: null })).toBe("away");
  });
  test("budget wins even while looking", () => {
    expect(advanceReason({ now: t0 + 7000, shownAt: t0, lastOnCardAt: t0 + 6999 })).toBe("budget");
  });
  test("custom config", () => {
    expect(advanceReason({ now: t0 + 3000, shownAt: t0, lastOnCardAt: t0 }, { budgetMs: 3000, awayMs: 99999, minMs: 0 })).toBe("budget");
  });
  test("pointInRect with margin", () => {
    const r = { left: 100, top: 100, right: 200, bottom: 200 };
    expect(pointInRect({ x: 150, y: 150 }, r)).toBe(true);
    expect(pointInRect({ x: 90, y: 150 }, r)).toBe(true);
    expect(pointInRect({ x: 50, y: 150 }, r)).toBe(false);
    expect(pointInRect(null, r)).toBe(false);
  });
});

describe("local fallback preference", () => {
  const zadie = CANDIDATES.find((c) => c.id === "zadie")!;
  const sol = CANDIDATES.find((c) => c.id === "sol")!;

  test("engagement grows with dwell and revisits, quick skips are punished", () => {
    const lo = engagement({}, 1200).score;
    const mid = engagement({ a: stat(2000) }, 4000).score;
    const hi = engagement({ a: stat(4000, 2), b: stat(1500) }, 7000).score;
    expect(lo).toBeLessThan(mid);
    expect(mid).toBeLessThan(hi);
  });

  test("signal is a distribution and tracks interest", () => {
    const skip = localSignal("x", {}, 900);
    const love = localSignal("x", { a: stat(5000, 3) }, 7000);
    for (const s of [skip, love]) {
      const sum = s.interest.skip + s.interest.neutral + s.interest.inspect + s.interest.positive;
      expect(Math.abs(sum - 1)).toBeLessThan(0.03);
    }
    expect(skip.interest.skip).toBeGreaterThan(skip.interest.positive);
    expect(love.interest.positive).toBeGreaterThan(love.interest.skip);
    expect(love.reward).toBeGreaterThan(skip.reward);
  });

  test("evidence leans toward the region that was looked at", () => {
    const e = evidenceVector(zadie, { [regionKey("zadie", "prompt1")]: stat(4000) });
    expect(e.sarcasm).toBeGreaterThan(zadie.traits.sarcasm - 1e-9);
    expect(evidenceVector(zadie, {})).toEqual(zadie.traits);
  });

  test("attention on funny profiles and not outdoorsy ones compiles a funny type", () => {
    const p = new LocalPreference(CANDIDATES);
    const funny = ["zadie", "mira", "dahlia", "wren"];
    let last;
    for (const c of CANDIDATES) {
      const regions = funny.includes(c.id)
        ? { [regionKey(c.id, "prompt1")]: stat(3500, 2), [regionKey(c.id, "prompt3")]: stat(2000, 1) }
        : { [regionKey(c.id, "photo1")]: stat(300) };
      last = p.observe(c, regions, funny.includes(c.id) ? 7000 : 1600);
    }
    const v = last!.update.vector;
    expect(v.sarcasm!).toBeGreaterThan(v.warmth!);
    expect(v.outdoors!).toBeLessThan(0.4);
    const top = lifts(v, CANDIDATES).filter((l) => l.lift > 0).slice(0, 4).map((l) => l.key);
    expect(top).toContain("sarcasm");
    expect(last!.update.observations).toBe(12);
    expect(last!.update.progress).toBeGreaterThanOrEqual(0.98);
    const persona = localPersona(v, CANDIDATES);
    expect(persona.name).toBe("Eve");
    expect(persona.dials.sarcasm).toBeGreaterThan(persona.dials.warmth);
    expect(persona.palette.hue).toBeGreaterThanOrEqual(0);
    expect(persona.palette.hue).toBeLessThan(360);
    void sol;
  });

  test("progress is monotonic and converges around profile 9", () => {
    let prev = 0;
    for (let n = 1; n <= 12; n++) {
      expect(localProgress(n)).toBeGreaterThanOrEqual(prev);
      prev = localProgress(n);
    }
    expect(localProgress(8)).toBeLessThan(0.98);
    expect(localProgress(9)).toBeGreaterThanOrEqual(0.98);
    expect(localProgress(100)).toBeLessThanOrEqual(0.99);
  });

  test("persona hue follows the dominant traits", () => {
    const outdoorsy = { ...sol.traits };
    const h = personaHue(outdoorsy, CANDIDATES);
    expect(h).toBeGreaterThan(90);
    expect(h).toBeLessThan(230);
  });
});

describe("operator keys", () => {
  test("digits jump to scenes in order", () => {
    SCENE_ORDER.forEach((s, i) => expect(keyAction(String(i + 1))).toEqual({ type: "scene", scene: s }));
    expect(keyAction("9")).toBeNull();
    expect(keyAction("0")).toBeNull();
  });
  test("letters and arrows", () => {
    expect(keyAction("ArrowRight")).toEqual({ type: "next" });
    expect(keyAction("ArrowLeft")).toEqual({ type: "prev" });
    expect(keyAction("ArrowUp")).toEqual({ type: "open-eigen" });
    expect(keyAction("d")).toEqual({ type: "open-eigen" });
    expect(keyAction("eigen.close")).toEqual({ type: "close-eigen" });
    expect(keyAction("a")).toEqual({ type: "scene", scene: "architecture" });
    expect(keyAction("h")).toEqual({ type: "toggle-hud" });
    expect(keyAction("g")).toEqual({ type: "toggle-reticle" });
    expect(keyAction("m")).toEqual({ type: "toggle-mouse" });
    expect(keyAction("?")).toEqual({ type: "help" });
    expect(keyAction("x")).toBeNull();
  });
  test("modifier chords belong to the browser", () => {
    expect(isOperatorKeyEvent({ key: "r", metaKey: true, ctrlKey: false, altKey: false })).toBe(false);
    expect(isOperatorKeyEvent({ key: "a", metaKey: false, ctrlKey: true, altKey: false })).toBe(false);
    expect(isOperatorKeyEvent({ key: "a", metaKey: false, ctrlKey: false, altKey: false })).toBe(true);
  });
  test("hud cycles full, quiet, off", () => {
    expect(nextHudLevel("full")).toBe("quiet");
    expect(nextHudLevel("quiet")).toBe("off");
    expect(nextHudLevel("off")).toBe("full");
  });
  test("mouse toggle keeps the scene", () => {
    const a = toggledGazeUrl("http://127.0.0.1:5173/?gaze=mouse", "desktop");
    expect(new URL(a).searchParams.get("gaze")).toBeNull();
    expect(new URL(a).searchParams.get("scene")).toBe("desktop");
    const b = toggledGazeUrl("http://127.0.0.1:5173/", "dating");
    expect(new URL(b).searchParams.get("gaze")).toBe("mouse");
  });
  test("hue takes the short way around", () => {
    expect(hueDelta(350, 10)).toBe(20);
    expect(hueDelta(10, 350)).toBe(-20);
    expect(hueDelta(262, 330)).toBe(68);
  });
});

describe("shell reducer", () => {
  const run = <K extends EventType>(s: ShellState, type: K, data: EventMap[K]) => reduceShell(s, envelope(type, data, "core") as any);

  test("formatWhen", () => {
    expect(formatWhen("7:30")).toBe("7:30 PM");
    expect(formatWhen("19:30")).toBe("7:30 PM");
    expect(formatWhen("7pm")).toBe("7:00 PM");
    expect(formatWhen("booked for 7:30 pm tonight")).toBe("7:30 PM");
    expect(formatWhen("table for 2")).toBeNull();
  });

  test("swarm lifecycle and calendar from an approved action", () => {
    let s = initialShell();
    s = run(s, "task.start", { taskId: "t1", goal: "figure out tonight", brain: "claude" });
    s = run(s, "swarm.spawn", { taskId: "t1", agentId: "a1", role: "places", label: "PLACES", name: "Miso", emoji: "🍜" });
    s = run(s, "swarm.progress", { taskId: "t1", agentId: "a1", text: "searching ramen under $15" });
    expect(s.swarm!.agents.a1!.state).toBe("working");
    s = run(s, "swarm.done", { taskId: "t1", agentId: "a1", ok: true, result: "Ramen Nagi" });
    expect(s.swarm!.agents.a1!.state).toBe("done");
    s = run(s, "action.request", {
      actionId: "x1",
      taskId: "t1",
      kind: "calendar.create",
      permission: "EXTERNAL_SIDE_EFFECT",
      description: "Cheap ramen at 7:30",
      args: { title: "Cheap ramen", start: "19:30" },
      needsApproval: true,
    });
    expect(s.approval?.actionId).toBe("x1");
    s = run(s, "action.approval", { actionId: "x1", approved: true, by: "voice" });
    expect(s.approval).toBeNull();
    s = run(s, "action.result", { actionId: "x1", ok: true, observation: "created" });
    expect(s.calendar).toEqual([expect.objectContaining({ title: "Cheap ramen", when: "7:30 PM" })]);
    s = run(s, "task.done", { taskId: "t1", ok: true, summary: "7:30. Cheap ramen. You're free. Done.", ms: 20000 });
    expect(s.calendar.length).toBe(1);
    expect(s.result?.summary).toContain("Cheap ramen");
  });

  test("task.done alone still lands on the calendar", () => {
    let s = initialShell();
    s = run(s, "task.done", { taskId: "t2", ok: true, summary: "7:30. Cheap ramen. You're free. Done.", ms: 1 });
    expect(s.calendar[0]).toEqual(expect.objectContaining({ title: "Cheap ramen", when: "7:30 PM" }));
  });

  test("eigen app opens and closes", () => {
    let s = initialShell();
    s = run(s, "app.opened", { app: "Eigen" });
    expect(s.eigenOpen).toBe(true);
    s = run(s, "app.focused", { app: "Chrome" });
    expect(s.eigenOpen).toBe(false);
  });

  test("reflex chips and ignore count", () => {
    let s = initialShell();
    for (let i = 0; i < 6; i++)
      s = run(s, "reflex.decision", { trigger: "tick", decision: "IGNORE", scores: { IGNORE: 0.91 }, urgency: "later", by: "jev", latencyMs: 4 });
    expect(s.reflex.length).toBe(4);
    expect(s.reflexIgnored).toBe(6);
    expect(s.counts["reflex.decision"]).toBe(6);
  });
});

describe("wife results", () => {
  test("structured results read like a sentence", () => {
    expect(summarizeResult(JSON.stringify({ options: [{ name: "Mensho", dish: "Garlic Knockout", price: 21 }, { name: "Kaze" }] }))).toBe("Mensho · Garlic Knockout · $21 (+1 more)");
    expect(summarizeResult(JSON.stringify({ availableFrom: "19:10", availableUntil: "23:30" }))).toBe("free 19:10 to 23:30");
    expect(summarizeResult(JSON.stringify({ maxRecommendedSpend: 20, warnings: ["no $28 bowls"] }))).toBe("budget: under $20 · no $28 bowls");
    expect(summarizeResult(JSON.stringify({ summary: "done deal" }))).toBe("done deal");
    expect(summarizeResult("plain text")).toBe("plain text");
  });
});
