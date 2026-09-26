import { describe, expect, test } from "bun:test";
import { AttentionController, GLANCE, screenToFocus, userFocus } from "./attention";
import { applyPoses, EmotionBlender, WEIGHT_CAP } from "./emotion";
import { BLINK, BlinkScheduler, breathAt, SaccadeScheduler, Spring, springParams, triangular } from "./motion-math";
import { EveRig } from "./rig";

/** Deterministic PRNG (mulberry32). */
function rng(seed = 7) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("blink scheduler", () => {
  test("first blink lands between 3 and 8 seconds", () => {
    for (let s = 1; s < 40; s++) {
      const b = new BlinkScheduler(rng(s), 0);
      let t = 0;
      while (b.update(t) === null && t < 10_000) t += 5;
      expect(t).toBeGreaterThanOrEqual(BLINK.minGapMs);
      expect(t).toBeLessThanOrEqual(BLINK.maxGapMs + 5);
    }
  });

  test("closes in 75ms, reopens in 150-300ms, returns null when done", () => {
    const b = new BlinkScheduler(rng(3), 0);
    b.trigger(1000);
    expect(b.update(1000)).toBeCloseTo(1, 5);
    expect(b.update(1000 + 74)!).toBeLessThan(0.01);
    const mid = b.update(1000 + 75 + 20)!;
    expect(mid).toBeGreaterThanOrEqual(0);
    expect(mid).toBeLessThan(0.1); // ease-in: opening starts slow
    let t = 1000 + 75;
    while (b.update(t) !== null) t += 1;
    const openMs = t - 1075;
    expect(openMs).toBeGreaterThanOrEqual(BLINK.openMinMs);
    expect(openMs).toBeLessThanOrEqual(BLINK.openMaxMs + 1);
  });

  test("multiplier never writes outside a blink, so eyes restore exactly", () => {
    const rig = new EveRig(rng(11), 0);
    const params = new Map<string, number>();
    const io = { get: (id: string) => params.get(id) ?? 0, set: (id: string, v: number) => void params.set(id, v) };
    const input = { state: "idle" as const, focus: { x: 0, y: 0 }, mouth: 0, mouthHold: false };
    // Simulate the model: each frame the motion writes eye open = 1 fresh.
    let minOpen = 1;
    let after = 0;
    for (let t = 0; t < 30_000; t += 16) {
      params.set("ParamEyeLOpen", 1);
      params.set("ParamEyeROpen", 1);
      rig.frame(io, input, 16, t);
      minOpen = Math.min(minOpen, params.get("ParamEyeLOpen")!);
      if (rig.last.blink === null) after = params.get("ParamEyeLOpen")!;
    }
    expect(minOpen).toBeLessThan(0.05); // she did blink
    expect(after).toBe(1); // and outside blinks the value is untouched
  });

  test("roughly 15% double blinks", () => {
    const b = new BlinkScheduler(rng(99), 0);
    const starts: number[] = [];
    let was = false;
    for (let t = 0; t < 2_000_000; t += 5) {
      const v = b.update(t);
      if (v !== null && !was) starts.push(t);
      was = v !== null;
    }
    const gaps = starts.slice(1).map((s, i) => s - starts[i]!);
    const doubles = gaps.filter((g) => g < 1000).length;
    expect(doubles / gaps.length).toBeGreaterThan(0.08);
    expect(doubles / gaps.length).toBeLessThan(0.22);
  });
});

describe("saccade scheduler", () => {
  test("intervals stay within 0.8-4.8s and cluster near 2s", () => {
    const s = new SaccadeScheduler(rng(5), 0);
    const xs = Array.from({ length: 4000 }, () => s.interval());
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(800);
    expect(Math.max(...xs)).toBeLessThanOrEqual(4800);
    const median = xs.sort((a, b) => a - b)[2000]!;
    expect(median).toBeGreaterThan(1800);
    expect(median).toBeLessThan(2900);
  });

  test("targets are small and pausing recenters", () => {
    const s = new SaccadeScheduler(rng(8), 0);
    for (let t = 0; t < 60_000; t += 16) {
      s.update(t);
      expect(Math.abs(s.x)).toBeLessThanOrEqual(0.16);
      expect(Math.abs(s.y)).toBeLessThanOrEqual(0.1);
    }
    s.paused = true;
    s.update(70_000);
    expect(s.x).toBe(0);
    expect(s.y).toBe(0);
  });

  test("triangular sampling covers the range", () => {
    expect(triangular(0, 800, 4800, 2000)).toBeCloseTo(800);
    expect(triangular(1, 800, 4800, 2000)).toBeCloseTo(4800);
  });
});

describe("spring", () => {
  test("k = 30 + 190 * follow, zeta = 1 - 0.75 * inertia", () => {
    expect(springParams(0, 0).k).toBe(30);
    expect(springParams(1, 0).k).toBe(220);
    expect(springParams(0.5, 1).zeta).toBeCloseTo(0.25);
    expect(springParams(0.5, 0).zeta).toBe(1);
  });

  test("converges to target, critically damped never overshoots", () => {
    const s = Spring.of(0.5, 0);
    let max = 0;
    for (let i = 0; i < 120; i++) max = Math.max(max, s.step(1, 16));
    expect(s.x).toBeCloseTo(1, 2);
    expect(max).toBeLessThanOrEqual(1.0001);
  });

  test("underdamped overshoots a little and still settles", () => {
    const s = Spring.of(0.5, 0.4);
    let max = 0;
    for (let i = 0; i < 200; i++) max = Math.max(max, s.step(1, 16));
    expect(max).toBeGreaterThan(1.01);
    expect(s.x).toBeCloseTo(1, 2);
  });

  test("frame-rate independent", () => {
    const a = Spring.of(0.5, 0.4);
    const b = Spring.of(0.5, 0.4);
    for (let i = 0; i < 30; i++) a.step(1, 33.3);
    for (let i = 0; i < 60; i++) b.step(1, 16.65);
    expect(a.x).toBeCloseTo(b.x, 2);
  });
});

describe("emotion blend", () => {
  test("weights ease in, cap at 0.78, then auto-return after the hold", () => {
    const e = new EmotionBlender();
    e.set("happy", 1, 0, 3000);
    expect(e.weights(0).happy ?? 0).toBe(0);
    const mid = e.weights(225).happy!;
    expect(mid).toBeGreaterThan(0.2);
    expect(mid).toBeLessThan(0.6);
    expect(e.weights(500).happy).toBeCloseTo(WEIGHT_CAP, 5);
    expect(e.weights(2900).happy).toBeCloseTo(WEIGHT_CAP, 5);
    e.weights(3000); // hold expires, retarget to neutral
    expect(e.weights(3200).happy!).toBeLessThan(WEIGHT_CAP);
    expect(e.weights(3600).happy ?? 0).toBe(0);
    expect(e.dominant(3600)).toBe("neutral");
  });

  test("switching moods crossfades from the current weight", () => {
    const e = new EmotionBlender();
    e.set("happy", 1, 0);
    e.weights(600);
    e.set("annoyed", 0.5, 600);
    const w = e.weights(800);
    expect(w.happy!).toBeGreaterThan(0);
    expect(w.annoyed!).toBeGreaterThan(0);
    const end = e.weights(1200);
    expect(end.happy ?? 0).toBe(0);
    expect(end.annoyed).toBeCloseTo(0.5 * WEIGHT_CAP, 5);
  });

  test("sustained mood holds past the auto-return", () => {
    const e = new EmotionBlender();
    e.sustain("thinking");
    e.weights(0);
    expect(e.weights(10_000).thinking).toBeCloseTo(WEIGHT_CAP);
    e.set("surprised", 1, 10_000, 1000);
    e.weights(10_000);
    expect(e.weights(10_600).surprised).toBeCloseTo(WEIGHT_CAP);
    e.weights(11_000);
    expect(e.weights(11_600).thinking).toBeCloseTo(WEIGHT_CAP);
  });

  test("applyPoses lerps absolutes and adds offsets", () => {
    const p = new Map<string, number>([["ParamMouthForm", 0], ["ParamAngleX", 10]]);
    applyPoses({ annoyed: 0.5 }, (id) => p.get(id) ?? 0, (id, v) => void p.set(id, v));
    expect(p.get("ParamMouthForm")).toBeCloseTo(-0.3);
    expect(p.get("ParamAngleX")).toBeCloseTo(17.5);
  });
});

describe("breath", () => {
  test("2s cosine to 0.5 then a 1.2s rest", () => {
    expect(breathAt(0)).toBeCloseTo(0);
    expect(breathAt(1000)).toBeCloseTo(0.5);
    expect(breathAt(2500)).toBe(0);
    expect(breathAt(3200 + 1000)).toBeCloseTo(0.5);
  });
});

describe("attention", () => {
  test("glances at a new target for ~800ms then back to the user", () => {
    const a = new AttentionController();
    expect(a.onUserTarget("menu_1", { x: 100, y: 200 }, 5000)).toBe(true);
    expect(a.current(5100)).toEqual({ kind: "point", x: 100, y: 200 });
    expect(a.current(5000 + GLANCE.ms + 1)).toEqual({ kind: "user" });
  });

  test("same key or rapid changes don't make her twitch", () => {
    const a = new AttentionController();
    a.onUserTarget("a", { x: 1, y: 1 }, 0);
    expect(a.onUserTarget("a", { x: 1, y: 1 }, 2000)).toBe(false);
    expect(a.onUserTarget("b", { x: 1, y: 1 }, 300)).toBe(false);
    expect(a.onUserTarget("c", { x: 1, y: 1 }, 3000)).toBe(true);
  });

  test("screen mapping: right and up are positive, clamped", () => {
    const f = screenToFocus({ x: 1500, y: 0 }, { x: 500, y: 400 }, 1000, 800);
    expect(f.x).toBe(1);
    expect(f.y).toBe(1);
    expect(userFocus({ x: 500, y: 300 }, 1000).x).toBe(0);
    expect(userFocus({ x: 900, y: 300 }, 1000).x).toBeLessThan(0);
  });
});
