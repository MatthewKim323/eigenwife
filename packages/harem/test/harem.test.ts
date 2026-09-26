import { describe, expect, test } from "bun:test";
import { emptyWorld, type AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "@eigenwife/core";
import { DEMO_SCRIPTS, ScriptedBrain } from "../src/brain";
import { choose, collect, detectConflicts, eveSummary } from "../src/conflicts";
import { executeWithHarem, HaremManager } from "../src/manager";
import { MAX_WIVES, normalizePlan, quickRoute } from "../src/planner";
import type { Brain } from "../src/types";

const task = { taskId: "t1", goal: "figure out tonight", context: "- memory: likes spicy food" };

function run(brain: Brain = new ScriptedBrain(DEMO_SCRIPTS, 0), approve?: boolean, goal = task.goal) {
  const bus = new EventBus();
  const seen: AnyEnvelope[] = [];
  bus.tap((e) => seen.push(e));
  if (approve !== undefined)
    bus.on("action.request", (e) => queueMicrotask(() => bus.emit("action.approval", { actionId: e.data.actionId, approved: approve, by: "voice" })));
  const p = executeWithHarem({ ...task, goal }, { bus, world: emptyWorld, brain, pace: 0, approvalTimeoutMs: 50, schedule: () => "free after 19:00" });
  return { p, seen };
}

describe("executeWithHarem (scripted demo beat)", () => {
  test("spawns three wives, fights, merges, asks before booking", async () => {
    const { p, seen } = run(undefined, true);
    const out = await p;
    const types = seen.map((e) => e.type);
    expect(out.ok).toBe(true);
    expect(types.filter((t) => t === "swarm.spawn")).toHaveLength(3);
    expect(types).toContain("swarm.conflict");
    expect(types.indexOf("swarm.merge")).toBeGreaterThan(types.indexOf("swarm.conflict"));
    expect(types.at(-1)).toBe("task.done");
    const req = seen.find((e) => e.type === "action.request")!;
    expect(req.data).toMatchObject({ permission: "EXTERNAL_SIDE_EFFECT", needsApproval: true, kind: "calendar.create" });
    expect(out.choice?.option.name).toBe("Menya Kaze");
    expect(out.summary).toBe("7:30, red miso tantanmen at Menya Kaze, $18, twelve minutes away. Done.");
    // every wife ends despawned, and nothing executes the side effect itself
    const finals = new Map<string, string>();
    for (const e of seen) if (e.type === "swarm.status") finals.set(e.data.agentId, e.data.state);
    expect([...finals.values()].every((s) => s === "despawned")).toBe(true);
    expect(types).not.toContain("action.result");
  });

  test("no approval: still answers, just asks", async () => {
    const out = await run().p;
    expect(out.action?.approved).toBeNull();
    expect(out.summary.endsWith("Want it on the calendar?")).toBe(true);
  });

  test("a failed wife doesn't sink the harem", async () => {
    const scripts = { ...DEMO_SCRIPTS };
    delete (scripts as any).calendar;
    const out = await run(new ScriptedBrain(scripts, 0)).p;
    expect(out.ok).toBe(true);
    expect(out.agents.find((a) => a.role === "calendar")?.error).toBeTruthy();
    expect(out.choice?.start).toBe("19:30");
  });

  test("DO_MYSELF short-circuits without spawning", async () => {
    const brain = new ScriptedBrain({ planner: { steps: [], doneMs: 0, result: { mode: "DO_MYSELF", confidence: 0.9, workers: [] } } }, 0);
    const { p, seen } = run(brain, undefined, "what's the capital of peru again");
    const out = await p;
    expect(out.ok).toBe(false);
    expect(seen.some((e) => e.type === "swarm.spawn")).toBe(false);
  });
});

describe("guards", () => {
  test("evening asks skip the planner and swarm instantly", () => {
    expect(quickRoute("figure out tonight")?.workers.map((w) => w.role)).toEqual(["food", "calendar", "budget"]);
    expect(quickRoute("plan dinner, nothing too far to drive")?.workers).toHaveLength(4);
    expect(quickRoute("refactor the auth module please")).toBeNull();
  });

  test("plans are capped, deduped, and never recurse", () => {
    const p = normalizePlan({
      mode: "SPAWN_SWARM",
      confidence: 3,
      workers: ["food", "food", "budget", "calendar", "logistics", "research", "harem" as any].map((role) => ({ role, goal: "x" })),
    });
    expect(p.workers.length).toBe(MAX_WIVES);
    expect(new Set(p.workers.map((w) => w.role)).size).toBe(p.workers.length);
    expect(p.confidence).toBe(1);
  });

  test("manager refuses a fifth wife", () => {
    const h = new HaremManager({ bus: new EventBus(), world: emptyWorld, brain: new ScriptedBrain({}) });
    for (const role of ["food", "budget", "calendar", "logistics"] as const) h.spawn("t", { role, goal: "g" });
    expect(() => h.spawn("t", { role: "research", goal: "g" })).toThrow(/full/);
  });
});

describe("conflicts", () => {
  const agent = (id: string, role: any, result: any) => ({ id, role, result }) as any;
  test("over-budget top pick fights, cheaper pick wins", () => {
    const f = collect([agent("m", "food", { type: "food_result", ...(DEMO_SCRIPTS.food!.result as any) }), agent("b", "budget", { type: "budget_result", ...(DEMO_SCRIPTS.budget!.result as any) })]);
    const c = detectConflicts(f);
    expect(c).toHaveLength(1);
    expect(c[0]!.lines[1]!.text).toBe("It's $22 for noodles. Absolutely not.");
    const pick = choose(f)!;
    expect(pick.option.cost).toBeLessThanOrEqual(20);
    expect(eveSummary(pick)).toContain("twelve minutes");
  });

  test("nothing under budget: cheapest wins and says so", () => {
    const f = collect([
      agent("m", "food", { type: "food_result", options: [{ name: "A", cost: 40, distanceMinutes: 5, fit: 0.9, reason: "" }, { name: "B", cost: 30, distanceMinutes: 5, fit: 0.5, reason: "" }], confidence: 1 }),
      agent("b", "budget", { type: "budget_result", maxRecommendedSpend: 10, warnings: [], confidence: 1 }),
    ]);
    expect(choose(f)).toMatchObject({ option: { name: "B" }, relaxed: "budget" });
  });
});
