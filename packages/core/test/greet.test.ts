import { expect, test } from "bun:test";
import { greetKind } from "../src/greet/module";
import { GREET_LINES, scriptedTexts } from "../src/speech/lines";

const at = (h: number) => new Date(2026, 8, 26, h, 0, 0);

test("greeting by time of day and time away; quick reloads stay quiet", () => {
  expect(greetKind(at(9), null)).toBe("first");
  const t = at(9).getTime();
  expect(greetKind(at(9), t - 60_000)).toBeNull(); // reload a minute later
  expect(greetKind(at(9), t - 3 * 60_000)).toBe("soon"); // a relaunch a few minutes later still says hi
  expect(greetKind(at(9), t - 20 * 60_000)).toBe("soon");
  expect(greetKind(at(9), t - 3 * 3600_000)).toBe("morning");
  expect(greetKind(at(14), at(14).getTime() - 3 * 3600_000)).toBe("afternoon");
  expect(greetKind(at(20), at(20).getTime() - 3 * 3600_000)).toBe("evening");
  expect(greetKind(at(2), at(2).getTime() - 3 * 3600_000)).toBe("late");
  expect(greetKind(at(9), t - 3 * 86_400_000)).toBe("long");
});

test("every greeting is prerendered", () => {
  for (const l of Object.values(GREET_LINES).flat()) expect(scriptedTexts()).toContain(l);
});

test("every core boot says hi once when a face connects, even right after a restart", async () => {
  const { fakeContext, FakeSpeech, FakeClock, startModules, settle } = await import("../src/reflex/testing");
  const { greetModule } = await import("../src/greet/module");
  const clock = new FakeClock(Date.now());
  const ctx = fakeContext();
  const speech = new FakeSpeech(ctx, clock);
  ctx.provide("speech", speech);
  ctx.bus.emit("companion.born", { persona: { name: "Eve" } as any });
  await startModules(ctx, [greetModule({ now: clock.now, random: () => 0 })]);
  ctx.bus.emit("bus.hello", { client: "shell", role: "shell", version: "x" });
  await settle(10);
  expect(speech.said.length).toBe(1);
  // the overlay's own "opened" right after is not a second hello
  ctx.bus.emit("overlay.opened", { at: clock.now() });
  ctx.bus.emit("bus.hello", { client: "shell", role: "shell", version: "x" });
  await settle(10);
  expect(speech.said.length).toBe(1);
});
