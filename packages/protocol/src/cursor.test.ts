import { describe, expect, test } from "bun:test";
import { AGENT_GLIDE, agentGlideMs, cursorDist, glideAt, glideControl, glideDone, glideProgress, makeGlide, minJerk } from "./cursor";

describe("agent cursor motion", () => {
  test("glide duration: 350-700ms, scaled by distance, monotonic", () => {
    const o = { x: 100, y: 100 };
    expect(agentGlideMs(null, o)).toBe(AGENT_GLIDE.minMs);
    expect(agentGlideMs(o, o)).toBe(0);
    let prev = 0;
    for (const d of [5, 40, 120, 300, 700, 1400, 3000]) {
      const ms = agentGlideMs(o, { x: 100 + d, y: 100 });
      expect(ms).toBeGreaterThanOrEqual(AGENT_GLIDE.minMs);
      expect(ms).toBeLessThanOrEqual(AGENT_GLIDE.maxMs);
      expect(ms).toBeGreaterThanOrEqual(prev);
      prev = ms;
    }
    expect(agentGlideMs(o, { x: 1500, y: 100 })).toBe(AGENT_GLIDE.maxMs);
    // Direction doesn't matter, only distance.
    expect(agentGlideMs(o, { x: 400, y: 100 })).toBe(agentGlideMs(o, { x: 100, y: 400 }));
  });

  test("minimum jerk: ends at rest", () => {
    expect(minJerk(0)).toBe(0);
    expect(minJerk(1)).toBe(1);
    expect(minJerk(0.5)).toBeCloseTo(0.5, 6);
    const eps = 1e-4;
    expect((minJerk(eps) - minJerk(0)) / eps).toBeLessThan(0.01);
    expect((minJerk(1) - minJerk(1 - eps)) / eps).toBeLessThan(0.01);
  });

  test("progress: starts slow, overshoots slightly, settles exactly", () => {
    expect(glideProgress(0)).toBe(0);
    expect(glideProgress(1)).toBe(1);
    expect(glideProgress(2)).toBe(1);
    let max = 0;
    let firstDrop = 1;
    let prev = 0;
    for (let i = 1; i <= 1000; i++) {
      const p = glideProgress(i / 1000);
      max = Math.max(max, p);
      if (p < prev && firstDrop === 1) firstDrop = i / 1000;
      prev = p;
    }
    expect(max).toBeGreaterThan(1.005);
    expect(max).toBeLessThan(1.05);
    // Rises monotonically through most of the move, the settle comes at the very end.
    expect(firstDrop).toBeGreaterThan(0.85);
    expect(glideProgress(0.1)).toBeLessThan(0.05);
  });

  test("path arcs like a wrist: off the chord, same side every time, straight for nudges", () => {
    const a = { x: 0, y: 500 };
    const b = { x: 1000, y: 500 };
    const c = glideControl(a, b);
    expect(c.x).toBeCloseTo(500, 6);
    expect(c.y).toBeLessThan(500); // bends upward on screen
    expect(500 - c.y).toBeLessThanOrEqual(AGENT_GLIDE.bendMaxPx);
    const back = glideControl(b, a);
    expect(back.y).toBeLessThan(500);
    const nudge = glideControl(a, { x: 10, y: 505 });
    expect(nudge).toEqual({ x: 5, y: 502.5 });
    // Midway the pointer is off the straight line.
    const g = makeGlide(a, b, 0);
    const mid = glideAt(g, g.ms / 2);
    expect(mid.y).toBeLessThan(499);
  });

  test("glideAt: from before start, exactly to at the end, continuous", () => {
    const g = makeGlide({ x: 10, y: 20 }, { x: 610, y: 420 }, 1000);
    expect(glideAt(g, 900)).toEqual({ x: 10, y: 20 });
    expect(glideAt(g, 1000 + g.ms)).toEqual({ x: 610, y: 420 });
    expect(glideDone(g, 1000 + g.ms)).toBe(true);
    expect(glideDone(g, 1000 + g.ms - 1)).toBe(false);
    let prev = glideAt(g, 1000);
    for (let t = 1000; t <= 1000 + g.ms; t += 8) {
      const p = glideAt(g, t);
      expect(cursorDist(prev, p)).toBeLessThan(40); // no teleports at 120Hz
      prev = p;
    }
    // No `from`: appears at the target.
    const first = makeGlide(null, { x: 5, y: 5 }, 0);
    expect(glideAt(first, 1)).toEqual({ x: 5, y: 5 });
  });
});
