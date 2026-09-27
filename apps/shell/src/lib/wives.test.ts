import { describe, expect, test } from "bun:test";
import { envelope, type AnyEnvelope, type EventMap, type EventType } from "@eigenwife/protocol";
import { LINGER_MS, NO_WIVES, QUIP_HOLD_MS, reduceWives, roleLabel, shellShowing, sideSlots, visibleWives, wifeCandidate, type OverlayWives } from "./wives";
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

describe("shell swarm scene detection", () => {
  test("a shell that switches for this task hides the bubbles; a stale one doesn't", () => {
    const scene = (s: "swarm" | "desktop") => ev("shell.scene", { scene: s });
    // stale: the tab flipped to swarm long ago and closed mid-run
    let s = reduceWives(NO_WIVES, scene("swarm"), 1000);
    s = reduceWives(s, ev("task.start", { taskId: "t", goal: "g", brain: "b" }), 60_000);
    expect(shellShowing(s)).toBe(false);
    // live: it flips right as the task starts
    s = reduceWives(s, scene("swarm"), 60_050);
    expect(shellShowing(s)).toBe(true);
    s = reduceWives(s, scene("desktop"), 70_000);
    expect(shellShowing(s)).toBe(false);
    // no shell at all
    expect(shellShowing(feed([spawn("a1", "kit", "Kit", "food")]))).toBe(false);
  });
});

describe("sideSlots", () => {
  const head = { x: 210, y: 170 };
  const vp = { w: 420, h: 560 };
  test("alternate left / right beside her head, never over her face, inside the window", () => {
    expect(sideSlots(0, head, vp, 34)).toEqual([]);
    const four = sideSlots(4, head, vp, 34);
    expect(four.map((p) => p.side)).toEqual(["l", "r", "l", "r"]);
    for (const p of four) {
      expect(Math.abs(p.x - head.x)).toBeGreaterThan(150);
      expect(p.x - 17).toBeGreaterThanOrEqual(0);
      expect(p.x + 17).toBeLessThanOrEqual(vp.w);
      expect(p.y).toBeGreaterThan(40);
      expect(p.y).toBeLessThan(vp.h - 100);
    }
    // columns step down, and the right one sits a little lower so a fight reads left then right
    expect(four[2]!.y).toBeGreaterThan(four[0]!.y);
    expect(four[1]!.y).toBeGreaterThan(four[0]!.y);
  });
});
