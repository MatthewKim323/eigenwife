import { expect, test } from "bun:test";
import { emptyWorld, envelope, matchesType, parseEnvelope } from "./index";
import { reduceWorld, renderContext, setSlot } from "./world";

test("matchesType", () => {
  expect(matchesType("*", "a.b")).toBe(true);
  expect(matchesType("gaze.*", "gaze.target")).toBe(true);
  expect(matchesType("gaze.*", "gazebo")).toBe(false);
  expect(matchesType("voice.final", "voice.final")).toBe(true);
});

test("parseEnvelope rejects junk", () => {
  expect(parseEnvelope("{")).toBeNull();
  expect(parseEnvelope(JSON.stringify({ type: "x" }))).toBeNull();
  expect(parseEnvelope(JSON.stringify(envelope("diag", { label: "a", value: "b" }, "t")))?.type).toBe("diag");
});

test("gaze target lands in the rendered context", () => {
  let w = emptyWorld();
  w = reduceWorld(w, envelope("gaze.target", { target: { key: "ramen-3", label: "Garlic Knockout Ramen, $21", kind: "menu-item", meta: { price: 21 } }, dwellMs: 900, confidence: 0.87 }, "shell"));
  w = reduceWorld(w, envelope("voice.final", { text: "thoughts?" }, "shell"));
  w = setSlot(w, "memory", "recent", "complained about $28 ramen");
  const ctx = renderContext(w);
  expect(ctx).toContain("looking at: Garlic Knockout Ramen, $21");
  expect(ctx).toContain('"price":21');
  expect(ctx).toContain('user last said: "thoughts?"');
  expect(ctx).toContain("memory.recent: complained about $28 ramen");
  w = setSlot(w, "memory", "recent", null);
  expect(renderContext(w)).not.toContain("memory.recent");
});

test("task counters never go negative", () => {
  let w = emptyWorld();
  w = reduceWorld(w, envelope("task.done", { taskId: "t", ok: true, summary: "", ms: 1 }, "core"));
  expect(w.tasks).toEqual({ active: 0, done: 1 });
});

test("preference reset un-births the companion", () => {
  let w = emptyWorld();
  const persona = { name: "Eve" } as any;
  w = reduceWorld(w, envelope("companion.born", { persona }, "core"));
  expect(w.companion.born).toBe(true);
  w = reduceWorld(w, envelope("preference.update", { vector: {}, deltas: {}, progress: 0.4, observations: 3 }, "core"));
  expect(w.companion.born).toBe(true);
  w = reduceWorld(w, envelope("preference.update", { vector: {}, deltas: {}, progress: 0, observations: 0 }, "core"));
  expect(w.companion.born).toBe(false);
  expect(w.companion.persona).toBeUndefined();
});

test("companion.rename renames the born persona, and only then", () => {
  let w = emptyWorld();
  w = reduceWorld(w, envelope("companion.rename", { name: "Nova", by: "onboarding" }, "core"));
  expect(w.companion.persona).toBeUndefined();
  w = reduceWorld(w, envelope("companion.born", { persona: { name: "Eve", palette: { hue: 1 } } as any }, "core"));
  w = reduceWorld(w, envelope("companion.rename", { name: "Nova", by: "onboarding" }, "core"));
  expect(w.companion.persona?.name).toBe("Nova");
  expect(w.companion.persona?.palette.hue).toBe(1);
  w = reduceWorld(w, envelope("companion.rename", { name: "  ", by: "user" }, "core"));
  expect(w.companion.persona?.name).toBe("Nova");
});
