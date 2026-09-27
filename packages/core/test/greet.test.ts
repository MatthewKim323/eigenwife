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
