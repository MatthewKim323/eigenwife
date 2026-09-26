import { expect, test } from "bun:test";
import { LOOK_FLASH_MS, LOOK_LINGER_MS, lookChip, nextLook, NO_LOOK } from "./looking";

test("level 2 read: a brief flash", () => {
  const s = nextLook(NO_LOOK, { level: 2, active: true }, 1000);
  expect(lookChip(s, 1000)).toEqual({ kind: "read", text: "👀 looking" });
  expect(lookChip(s, 1000 + LOOK_FLASH_MS - 1)).not.toBeNull();
  expect(lookChip(s, 1000 + LOOK_FLASH_MS)).toBeNull();
});

test("level 3 capture: clear chip for the whole look, a short linger, not cut short by a text read", () => {
  let s = nextLook(NO_LOOK, { level: 3, active: true }, 0);
  expect(lookChip(s, 60_000)?.kind).toBe("vision");
  s = nextLook(s, { level: 2, active: true }, 10);
  expect(s.level).toBe(3);
  s = nextLook(s, { level: 3, active: false }, 5000);
  expect(lookChip(s, 5000 + LOOK_LINGER_MS - 1)?.text).toBe("👀 looking");
  expect(lookChip(s, 5000 + LOOK_LINGER_MS)).toBeNull();
});

test("nothing happening: no chip", () => {
  expect(lookChip(NO_LOOK, 0)).toBeNull();
});
