import { describe, expect, test } from "bun:test";
import { followPoint, homeFor, Presence, PRESENCE, TypingDetector, type PresenceWorld } from "./presence";
import { CursorSim } from "./sim";

const HOME = { x: 1200, y: 700 };
const world = (now: number, over: Partial<PresenceWorld> = {}): PresenceWorld => ({ now, home: HOME, user: null, userMovedAt: -1e9, look: null, quiet: false, shown: true, ...over });

/** Run the scheduler at 100ms ticks, collecting commands with their times. */
function run(p: Presence, from: number, to: number, w: (now: number) => PresenceWorld) {
  const out: { at: number; cmd: ReturnType<Presence["tick"]>[number] }[] = [];
  for (let t = from; t <= to; t += 100) for (const cmd of p.tick(w(t))) out.push({ at: t, cmd });
  return out;
}

const seq = (seed: number) => () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;

describe("presence: always on, rate limited", () => {
  test("appears at home first, then rests (no moves) until the first wander", () => {
    const p = new Presence(seq(3), 0);
    const cmds = run(p, 0, PRESENCE.firstWanderMs - 100, (t) => world(t));
    expect(cmds.length).toBe(1);
    expect(cmds[0]!.cmd).toMatchObject({ x: HOME.x, y: HOME.y, action: "move" });
  });

  test("wanders every 20-60s at most, always comes back home", () => {
    const p = new Presence(seq(11), 0);
    const cmds = run(p, 0, 10 * 60_000, (t) => world(t));
    const outings = cmds.filter((c) => c.cmd.action === "move" && (c.cmd.x !== HOME.x || c.cmd.y !== HOME.y));
    const homes = cmds.filter((c) => c.cmd.action === "move" && c.cmd.x === HOME.x && c.cmd.y === HOME.y);
    // 10 minutes: between 10 (every 60s) and ~26 (every 20s + dwell) outings.
    expect(outings.length).toBeGreaterThanOrEqual(8);
    expect(outings.length).toBeLessThanOrEqual(30);
    for (let i = 1; i < outings.length; i++) expect(outings[i]!.at - outings[i - 1]!.at).toBeGreaterThanOrEqual(PRESENCE.wanderMinMs);
    // Every outing is followed by a trip home.
    expect(homes.length).toBeGreaterThanOrEqual(outings.length);
    // Idle glides are lazy: slower than the task glide range.
    for (const o of outings) expect(o.cmd.ms!).toBeGreaterThan(350);
  });

  test("playful follow: near his cursor, never on it, re-aims rarely", () => {
    const p = new Presence(() => 0.6, 0); // 0.6: pick the user when his cursor is fresh
    let user = { x: 500, y: 400 };
    const cmds = run(p, 0, 40_000, (t) => {
      // He keeps moving his mouse around.
      user = { x: 500 + Math.sin(t / 900) * 300, y: 400 + Math.cos(t / 1300) * 200 };
      return world(t, { user, userMovedAt: t });
    });
    const away = cmds.filter((c) => c.cmd.action === "move" && !(c.cmd.x === HOME.x && c.cmd.y === HOME.y));
    expect(away.length).toBeGreaterThan(0);
    for (let i = 0; i < away.length; i++) {
      const t = away[i]!.at;
      const u = { x: 500 + Math.sin(t / 900) * 300, y: 400 + Math.cos(t / 1300) * 200 };
      expect(Math.hypot(away[i]!.cmd.x - u.x, away[i]!.cmd.y - u.y)).toBeGreaterThanOrEqual(PRESENCE.keepAwayPx);
      if (i > 0 && away[i]!.at - away[i - 1]!.at < PRESENCE.wanderMinMs) expect(away[i]!.at - away[i - 1]!.at).toBeGreaterThanOrEqual(PRESENCE.followEveryMs);
    }
    expect(followPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 90)).toEqual({ x: 90, y: 0 });
  });

  test("visits what she's looking at and hovers there", () => {
    const p = new Presence(() => 0.2, 0);
    const look = { p: { x: 300, y: 200 }, at: 0 };
    const cmds = run(p, 0, 25_000, (t) => world(t, { look: { ...look, at: t } }));
    const go = cmds.find((c) => c.cmd.x === 300 && c.cmd.action === "move");
    expect(go).toBeTruthy();
    expect(cmds.find((c) => c.cmd.action === "hover")?.cmd).toMatchObject({ x: 300, y: 200 });
  });

  test("quiet (typing fast, fullscreen): dims and stays still", () => {
    const p = new Presence(seq(5), 0);
    run(p, 0, 1000, (t) => world(t));
    const cmds = run(p, 1100, 5 * 60_000, (t) => world(t, { quiet: true, user: { x: 10, y: 10 }, userMovedAt: t }));
    expect(cmds.length).toBe(0);
    expect(p.level({ shown: true, quiet: true })).toBe(PRESENCE.dimLevel);
    expect(p.level({ shown: true, quiet: false })).toBe(1);
    expect(p.level({ shown: false, quiet: false })).toBe(0);
  });

  test("hidden: nothing moves", () => {
    const p = new Presence(seq(5), 0);
    run(p, 0, 100, (t) => world(t));
    expect(run(p, 200, 5 * 60_000, (t) => world(t, { shown: false })).length).toBe(0);
  });

  test("dragging her avatar: the cursor walks over to the new home", () => {
    const p = new Presence(seq(5), 0);
    run(p, 0, 100, (t) => world(t));
    const moved = { x: 300, y: 700 };
    const c = run(p, 200, 400, (t) => world(t, { home: moved }));
    expect(c[0]!.cmd).toMatchObject({ x: 300, y: 700, action: "move" });
    expect(homeFor({ x: 1000, y: 300, width: 400, height: 500 }, { x: 0, y: 0, width: 1470, height: 956 })).toEqual({ x: 1080, y: 620 });
    expect(homeFor({ x: 20, y: 300, width: 400, height: 500 }, { x: 0, y: 0, width: 1470, height: 956 }).x).toBe(340);
  });
});

describe("point / return sequence", () => {
  test("the core points while she talks, presence waits, then she goes home", () => {
    const p = new Presence(seq(9), 0);
    const sim = new CursorSim(() => 0.5);
    sim.setAlwaysOn(true);
    const feed = (cmds: ReturnType<Presence["tick"]>, t: number) => cmds.forEach((c) => sim.feed(c, t));
    feed(p.tick(world(0)), 0);
    // speech.begin -> the core glides to the Spotify window and points.
    const move = { x: 400, y: 300, action: "move" as const, ms: 500, label: "Spotify" };
    p.onAgent(move, 1000);
    sim.feed(move, 1000);
    const point = { x: 400, y: 300, action: "point" as const, label: "Spotify" };
    p.onAgent(point, 1500);
    sim.feed(point, 1500);
    expect(p.mode()).toBe("agent");
    // While she talks presence never moves the cursor (even past a wander slot).
    expect(run(p, 1600, 12_000, (t) => world(t)).length).toBe(0);
    const f = sim.frame(1700);
    expect(f.point).toBe(1);
    expect(Math.abs(f.x - 400)).toBeLessThan(8); // a wiggle, not a wander
    expect(sim.frame(1500 + 1200).point).toBeCloseTo(0.35, 5);
    // speech.end -> idle. A beat later, home.
    p.onAgent({ x: 400, y: 300, action: "idle" }, 12_100);
    sim.feed({ x: 400, y: 300, action: "idle" }, 12_100);
    expect(sim.frame(12_200).point).toBe(0);
    expect(sim.frame(20_000).opacity).toBe(1); // always on: idle never fades her out
    const back = run(p, 12_200, 14_000, (t) => world(t));
    expect(back.length).toBe(1);
    expect(back[0]!.at - 12_100).toBeGreaterThanOrEqual(PRESENCE.returnAfterAgentMs);
    expect(back[0]!.cmd).toMatchObject({ x: HOME.x, y: HOME.y, action: "move" });
  });

  test("a core that never says idle still lets go", () => {
    const p = new Presence(seq(9), 0);
    p.tick(world(0));
    p.onAgent({ x: 1, y: 1, action: "click" }, 100);
    const c = run(p, 200, 100 + PRESENCE.agentSilenceMs + 500, (t) => world(t));
    expect(c.length).toBe(1);
    expect(c[0]!.cmd).toMatchObject({ x: HOME.x, y: HOME.y });
  });

  test("dim level eases in the renderer", () => {
    const sim = new CursorSim();
    sim.setAlwaysOn(true);
    sim.feed({ x: 5, y: 5, action: "move", ms: 0 }, 0);
    expect(sim.frame(1000).opacity).toBe(1);
    sim.setLevel(0.35, 1000);
    expect(sim.frame(1000 + 190).opacity).toBeGreaterThan(0.35);
    expect(sim.frame(2000).opacity).toBeCloseTo(0.35, 5);
    // Breathing: resting, she drifts a pixel or two.
    const a = sim.frame(3000);
    const b = sim.frame(3900);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(0.05);
    expect(Math.hypot(a.x - 5, a.y - 5)).toBeLessThan(4);
  });
});

describe("typing detector (OS idle time only)", () => {
  test("keys without mouse for a while = typing; stops after a pause", () => {
    const d = new TypingDetector();
    let quiet = false;
    for (let t = 0; t <= 2500; t += 250) quiet = d.sample(t, 0, -5000);
    expect(quiet).toBe(true);
    // Mouse moving: that's not typing.
    const m = new TypingDetector();
    for (let t = 0; t <= 2500; t += 250) quiet = m.sample(t, 0, t);
    expect(quiet).toBe(false);
    // After he stops, it releases.
    expect(d.sample(6000, 3, -5000)).toBe(false);
  });
});
