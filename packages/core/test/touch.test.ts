import { expect, test } from "bun:test";
import { TOUCH_LINES, scriptedTexts } from "../src/speech/lines";
import { TouchVoice } from "../src/touch/module";

const clock = () => {
  let t = 0;
  return { now: () => t, advance: (ms: number) => (t += ms) };
};

test("every touch kind has lines with mood marks, all prerendered", () => {
  for (const [kind, pool] of Object.entries(TOUCH_LINES)) {
    expect(pool.length).toBeGreaterThan(1);
    for (const l of pool) {
      expect(l).toMatch(/^\[mood:[a-z]+ [0-9.]+\]/);
      expect(scriptedTexts()).toContain(l);
    }
    expect(kind).toBeTruthy();
  }
});

test("rate limited, never the same line twice in a row, quiet while she talks", () => {
  const c = clock();
  const v = new TouchVoice({ gapMs: 2500, now: c.now, random: () => 0 });
  const a = v.pick("pat", false);
  expect(a).toBe(TOUCH_LINES.pat[0]);
  expect(v.pick("poke", false)).toBeNull(); // within the gap
  c.advance(3000);
  expect(v.pick("pat", false)).not.toBe(a); // no repeat
  c.advance(3000);
  expect(v.pick("poke", true)).toBeNull(); // she's talking
});

test("annoyed cuts through the gap and her own speech", () => {
  const c = clock();
  const v = new TouchVoice({ gapMs: 2500, now: c.now, random: () => 0.5 });
  v.pick("poke", false);
  expect(v.pick("annoyed", true)).toMatch(/annoyed/);
});
