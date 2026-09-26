import { expect, test } from "bun:test";
import { EventBus } from "../src/bus";

test("pattern subscriptions", () => {
  const bus = new EventBus();
  const got: string[] = [];
  bus.on("gaze.*", (e) => got.push(e.type));
  bus.on("*", () => got.push("*"));
  bus.emit("gaze.lost", { reason: "away" });
  bus.emit("voice.final", { text: "hi" });
  expect(got).toEqual(["gaze.lost", "*", "*"]);
});

test("a throwing handler never breaks the others", () => {
  const bus = new EventBus();
  let reached = false;
  const orig = console.error;
  console.error = () => {};
  bus.on("diag", () => {
    throw new Error("boom");
  });
  bus.on("diag", () => {
    reached = true;
  });
  bus.emit("diag", { label: "x", value: "y" });
  console.error = orig;
  expect(reached).toBe(true);
});

test("once with filter and timeout", async () => {
  const bus = new EventBus();
  const p = bus.once("action.approval", (e) => e.data.actionId === "b", 500);
  bus.emit("action.approval", { actionId: "a", approved: true, by: "voice" });
  bus.emit("action.approval", { actionId: "b", approved: false, by: "voice" });
  expect((await p)?.data.approved).toBe(false);
  expect(await bus.once("action.approval", () => true, 20)).toBeNull();
});

test("history ring buffer", () => {
  const bus = new EventBus(3);
  for (let i = 0; i < 5; i++) bus.emit("timer.tick", { n: i });
  expect(bus.recent("timer.tick").map((e) => (e.data as { n: number }).n)).toEqual([2, 3, 4]);
});
