import { describe, expect, test } from "bun:test";
import { CANDIDATES, emptyWorld, type AnyEnvelope, type Envelope } from "@eigenwife/protocol";
import { EventBus } from "@eigenwife/core";
import { DEMO_SCRIPTS, ScriptedBrain } from "../src/brain";
import { choose, collect, conflictWinner, detectConflicts } from "../src/conflicts";
import { assignCandidates, candidateById, pickCandidate, QUIPS, roleFit } from "../src/identity";
import { executeWithHarem, HaremManager, wifeSystem } from "../src/manager";
import type { WifeRole } from "../src/types";
import { WIVES } from "../src/wives";

const ROLES: WifeRole[] = ["food", "calendar", "budget", "logistics", "research"];

describe("casting the Act I girls", () => {
  test("deterministic per task + role", () => {
    for (const t of ["t1", "task_abc", "zzz"]) {
      expect(assignCandidates(t, ["food", "calendar", "budget"]).map((w) => w.candidateId)).toEqual(
        assignCandidates(t, ["food", "calendar", "budget"]).map((w) => w.candidateId),
      );
    }
  });

  test("never the same girl twice in one task", () => {
    for (let i = 0; i < 100; i++) {
      const ids = assignCandidates(`t${i}`, ROLES.slice(0, 4)).map((w) => w.candidateId);
      expect(new Set(ids).size).toBe(ids.length);
    }
    // the full roster: five roles, five different girls
    const all = assignCandidates("t", ROLES).map((w) => w.candidateId);
    expect(new Set(all).size).toBe(5);
  });

  test("the same role tends to get the same girl across tasks", () => {
    for (const role of ROLES) {
      const counts = new Map<string, number>();
      for (let i = 0; i < 60; i++) {
        const id = pickCandidate(`task_${i}`, role).candidateId;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      expect(Math.max(...counts.values())).toBeGreaterThanOrEqual(36);
    }
  });

  test("role fit: planners plan, party girls find food, steady ones hold the money", () => {
    const fit = (role: WifeRole, id: string) => roleFit(candidateById(id)!, role);
    const [food, calendar, budget] = assignCandidates("t1", ["food", "calendar", "budget"]);
    expect(food!.candidate.traits.nightlife).toBeGreaterThan(0.7);
    expect(calendar!.candidate.traits.career_focus).toBeGreaterThan(0.65);
    expect(budget!.candidate.traits.chaos).toBeLessThan(0.3);
    expect(budget!.candidate.traits.warmth).toBeGreaterThan(0.6);
    expect(fit("calendar", "vivienne")).toBeGreaterThan(fit("calendar", "kit"));
    expect(fit("logistics", "sol")).toBeGreaterThan(fit("logistics", "wren"));
    expect(fit("budget", "hana")).toBeGreaterThan(fit("budget", "dahlia"));
    expect(fit("research", "ada")).toBeGreaterThan(fit("research", "kit"));
    // every assigned girl is in her role's top half
    for (const role of ROLES) {
      const ranked = [...CANDIDATES].sort((a, b) => roleFit(b, role) - roleFit(a, role)).map((c) => c.id);
      const id = pickCandidate("t1", role).candidateId;
      expect(ranked.indexOf(id)).toBeLessThan(6);
    }
  });

  test("pickCandidate skips whoever is already on the task", () => {
    const first = pickCandidate("t", "food").candidateId;
    expect(pickCandidate("t", "food", [first]).candidateId).not.toBe(first);
  });

  test("manager.spawn casts on its own and never doubles up", () => {
    const bus = new EventBus();
    const seen: Envelope<"swarm.spawn">[] = [];
    bus.on("swarm.spawn", (e) => seen.push(e));
    const h = new HaremManager({ bus, world: emptyWorld, brain: new ScriptedBrain({}) });
    const a = h.spawn("t", { role: "research", goal: "g" });
    const b = h.spawn("t", { role: "research", goal: "g" });
    expect(a.candidateId).toBeTruthy();
    expect(b.candidateId).not.toBe(a.candidateId);
    expect(seen[0]!.data).toMatchObject({ candidateId: a.candidateId, name: a.name, emoji: WIVES.research.emoji });
    expect(seen[0]!.data.label).toContain(a.name.toUpperCase());
  });

  test("her system prompt speaks as her, from her profile", () => {
    const s = wifeSystem(WIVES.budget.system, WIVES.budget.name, { name: "Hana", candidateId: "hana" });
    expect(s).toContain("You are Hana, Eve's budget wife");
    expect(s).not.toContain("Mina");
    expect(s).toContain("will remember your coffee order forever");
    expect(s).toContain("never changes numbers");
    expect(wifeSystem(WIVES.budget.system, WIVES.budget.name, { name: "Mina" })).toBe(WIVES.budget.system);
  });

  test("every girl has a voice for every kind of fight", () => {
    for (const c of CANDIDATES) {
      const q = QUIPS[c.id]!;
      expect(q).toBeTruthy();
      for (const line of [q.push!("Mensho"), q.no!("$22", "noodles"), q.near!("Mensho"), q.far!(35)]) {
        expect(line.length).toBeLessThan(64);
        expect(line).not.toMatch(/[–—]/);
      }
    }
  });
});

describe("events carry her identity", () => {
  test("demo beat: spawn has candidateId + her name, quips in her voice, resolve names the winner", async () => {
    const bus = new EventBus();
    const seen: AnyEnvelope[] = [];
    bus.tap((e) => seen.push(e));
    await executeWithHarem({ taskId: "t1", goal: "figure out tonight", context: "" }, { bus, world: emptyWorld, brain: new ScriptedBrain(DEMO_SCRIPTS, 0), pace: 0, approvalTimeoutMs: 20, schedule: () => "free" });
    const spawns = seen.filter((e): e is Envelope<"swarm.spawn"> => e.type === "swarm.spawn");
    expect(spawns).toHaveLength(3);
    const byRole = Object.fromEntries(spawns.map((e) => [e.data.role, e.data]));
    for (const s of spawns) {
      const c = candidateById(s.data.candidateId)!;
      expect(c).toBeTruthy();
      expect(s.data.name).toBe(c.name);
    }
    expect(new Set(spawns.map((s) => s.data.candidateId)).size).toBe(3);
    // the golden path cast
    expect(byRole.food!.candidateId).toBe("kit");
    expect(byRole.budget!.candidateId).toBe("hana");
    expect(byRole.calendar!.candidateId).toBe("vivienne");

    const conflict = seen.find((e): e is Envelope<"swarm.conflict"> => e.type === "swarm.conflict")!;
    expect(conflict.data.lines.map((l) => l.text)).toEqual(["Mensho. Life's short. It's worth it.", "It's $22 for noodles, sweetie. Absolutely not."]);
    const resolve = seen.find((e): e is Envelope<"swarm.resolve"> => e.type === "swarm.resolve")!;
    expect(resolve.data.text).toBe("Girls. Menya Kaze.");
    expect(resolve.data.winner).toBe(byRole.budget!.agentId);
  });

  test("conflictWinner: food wins when her top pick survives", () => {
    const agent = (id: string, role: any, result: any) => ({ id, role, result }) as any;
    const f = collect([
      agent("m", "food", { type: "food_result", options: [{ name: "A", cost: 40, distanceMinutes: 5, fit: 0.9, reason: "" }], confidence: 1 }),
      agent("b", "budget", { type: "budget_result", maxRecommendedSpend: 10, warnings: [], confidence: 1 }),
    ]);
    const [c] = detectConflicts(f);
    expect(conflictWinner(c!, choose(f), f)).toBe("m");
    expect(conflictWinner(c!, null, f)).toBeUndefined();
  });
});
