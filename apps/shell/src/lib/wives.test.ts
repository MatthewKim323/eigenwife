import { describe, expect, test } from "bun:test";
import { envelope, type AnyEnvelope, type EventMap, type EventType } from "@eigenwife/protocol";
import { fanOut, LINGER_MS, NO_WIVES, QUIP_HOLD_MS, reduceWives, roleLabel, visibleWives, wifeCandidate, type OverlayWives } from "./wives";
import { reduceShell, initialShell } from "./store";

const ev = <K extends EventType>(type: K, data: EventMap[K]) => envelope(type, data, "harem") as AnyEnvelope;
const feed = (evs: AnyEnvelope[], t0 = 1000) => evs.reduce<OverlayWives>((s, e, i) => reduceWives(s, e, t0 + i * 100), NO_WIVES);

const spawn = (agentId: string, candidateId: string, name: string, role: string) =>
  ev("swarm.spawn", { taskId: "t", agentId, role, label: `${name} · ${role} wife`, parentId: "eve", name, emoji: "x", candidateId });

describe("wife identity helpers", () => {
  test("candidate by id, else by name, else nothing", () => {
    expect(wifeCandidate({ candidateId: "kit" })?.name).toBe("Kit");
    expect(wifeCandidate({ name: "Hana" })?.id).toBe("hana");
    expect(wifeCandidate({ name: "Miso" })).toBeUndefined();
    expect(roleLabel("logistics")).toBe("PLACES");
    expect(roleLabel("food")).toBe("FOOD");
  });

  test("shell store keeps candidateId from swarm.spawn", () => {
    const s = reduceShell(initialShell(), spawn("a1", "kit", "Kit", "food"));
    expect(s.swarm?.agents.a1?.candidateId).toBe("kit");
  });
});

describe("overlay wives reducer", () => {
  const run = [
    ev("task.start", { taskId: "t", goal: "figure out tonight", brain: "harem" }),
    spawn("a1", "kit", "Kit", "food"),
    spawn("a2", "hana", "Hana", "budget"),
    ev("swarm.status", { taskId: "t", agentId: "a1", state: "working" }),
    ev("swarm.progress", { taskId: "t", agentId: "a1", text: "searching 14 restaurants near you for spicy ramen tonight" }),
  ];

  test("spawns in order with their faces and clipped captions", () => {
    const s = feed(run);
    const v = visibleWives(s, 2000);
    expect(v.map((w) => w.candidateId)).toEqual(["kit", "hana"]);
    expect(v[0]!.state).toBe("working");
    expect(v[0]!.caption!.length).toBeLessThanOrEqual(38);
    expect(v[0]!.caption!.endsWith("...")).toBe(true);
  });

  test("quips hold over progress chatter, then yield", () => {
    let s = feed(run);
    s = reduceWives(s, ev("swarm.conflict", { taskId: "t", conflictId: "c", topic: "restaurant_selection", a: "a1", b: "a2", lines: [{ agentId: "a1", text: "Mensho. Life's short. It's worth it." }, { agentId: "a2", text: "It's $22 for noodles, sweetie. Absolutely not." }] }), 5000);
    expect(s.wives.a2!.caption).toBe("It's $22 for noodles, sweetie. Absolutely not.");
    s = reduceWives(s, ev("swarm.progress", { taskId: "t", agentId: "a1", text: "noise" }), 5000 + QUIP_HOLD_MS - 1);
    expect(s.wives.a1!.caption).toBe("Mensho. Life's short. It's worth it.");
    s = reduceWives(s, ev("swarm.progress", { taskId: "t", agentId: "a1", text: "noise" }), 5000 + QUIP_HOLD_MS + 1);
    expect(s.wives.a1!.caption).toBe("noise");
  });

  test("resolve marks the winner; merge fades everyone out after the linger", () => {
    let s = feed(run);
    s = reduceWives(s, ev("swarm.resolve", { taskId: "t", conflictId: "c", text: "Girls. Menya Kaze.", winner: "a2" }), 6000);
    expect(s.wives.a2!.chosen).toBe(true);
    expect(s.wives.a1!.chosen).toBeUndefined();
    s = reduceWives(s, ev("swarm.merge", { taskId: "t", agentIds: ["a1", "a2"], retained: [], discarded: 2 }), 7000);
    expect(visibleWives(s, 7000 + LINGER_MS - 1)).toHaveLength(2);
    expect(visibleWives(s, 7000 + LINGER_MS + 1)).toHaveLength(0);
  });

  test("despawned wives drop out; other tasks' events are ignored; a new task starts clean", () => {
    let s = feed(run);
    s = reduceWives(s, ev("swarm.status", { taskId: "t", agentId: "a1", state: "despawned" }), 3000);
    expect(visibleWives(s, 3000).map((w) => w.id)).toEqual(["a2"]);
    s = reduceWives(s, ev("swarm.status", { taskId: "other", agentId: "a2", state: "failed" }), 3000);
    expect(s.wives.a2!.state).toBe("spawning");
    s = reduceWives(s, ev("task.start", { taskId: "t2", goal: "g", brain: "b" }), 4000);
    expect(visibleWives(s, 4000)).toHaveLength(0);
  });

  test("late join: swarm.spawn without task.start adopts the task", () => {
    const s = reduceWives(NO_WIVES, spawn("a1", "kit", "Kit", "food"), 1);
    expect(s.taskId).toBe("t");
    expect(visibleWives(s, 1)).toHaveLength(1);
  });
});

describe("fanOut", () => {
  test("arcs over her head, symmetric, never below it", () => {
    expect(fanOut(0, 100)).toEqual([]);
    expect(fanOut(1, 100)).toEqual([{ x: 0, y: -100 }]);
    const four = fanOut(4, 100);
    expect(four).toHaveLength(4);
    for (const p of four) expect(p.y).toBeLessThan(0);
    expect(four[0]!.x).toBe(-four[3]!.x);
    expect(four[0]!.x).toBeLessThan(four[1]!.x);
  });
});
