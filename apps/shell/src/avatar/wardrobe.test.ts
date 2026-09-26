import { describe, expect, test } from "bun:test";
import { BLEND_MS } from "./emotion";
import { LOOK_ARB, LookArbiter, clampFocus } from "./look";
import { ALEXIA, buildPoses, buildTogglePoses, expressionNames, HARU, type Exp3, type ModelDef } from "./models";
import { EveRig, bounceAt, shutAt, type RigInput } from "./rig";
import { bodyRect, headEllipse, HoverLimiter, inEllipse, playTouch, PokeCounter, regionAt, TOUCH } from "./touch";
import { outfitFor, ToggleWeights, WARDROBE_FADE_MS } from "./wardrobe";

/** Alexia's exp3 switch params (numbers only, the model itself stays local). */
const add = (Id: string, Value = 30) => ({ Id, Value, Blend: "Add" as const });
const EXPS: Record<string, Exp3> = {
  yf: { Parameters: [add("Param16"), add("Param17", 0), add("Param61", 0)] },
  yfmz: { Parameters: [add("Param17"), add("Param16"), add("Param61", 0)] },
  dyj: { Parameters: [add("Param64")] },
  mj: { Parameters: [add("Param11")] },
  bbt: { Parameters: [add("Param60")] },
  yjys1: { Parameters: [add("Param62")] },
  yjys2: { Parameters: [add("Param63")] },
  lh: { Parameters: [add("Param58")] },
  lzx: { Parameters: [add("Param54")] },
  sq: { Parameters: [add("Param57")] },
};

function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function alexiaRig(def: ModelDef = ALEXIA) {
  const rig = new EveRig(rng(3), 0);
  const wardrobe = buildTogglePoses(Object.fromEntries(Object.entries(def.wardrobe).map(([id, w]) => [id, w.expression])), EXPS);
  rig.setModel(def, buildPoses(def, EXPS), { wardrobe, accents: buildTogglePoses(def.accents ?? {}, EXPS) }, 0);
  return rig;
}

const input: RigInput = { state: "idle", focus: { x: 0, y: 0 }, mouth: 0, mouthHold: false, still: true };

/** One frame on fresh params (the SDK reloads saved params every frame). */
function frame(rig: EveRig, t: number) {
  const p = new Map<string, number>();
  rig.frame({ get: (id) => p.get(id) ?? 0, set: (id, v) => void p.set(id, v) }, input, 16, t);
  return (id: string) => p.get(id) ?? 0;
}

describe("registry wardrobe", () => {
  test("alexia's items map to her verified toggles; haru has none", () => {
    const w = ALEXIA.wardrobe;
    expect(Object.fromEntries(Object.entries(w).map(([id, e]) => [id, e.expression]))).toEqual({
      hoodie: "yfmz",
      hood_up: "yf",
      sunglasses: "dyj",
      sunglasses_up: "mj",
      lollipop: "bbt",
      odd_eye_left: "yjys1",
      odd_eye_right: "yjys2",
    });
    expect(w.hoodie!.slot).toBe("top");
    expect(w.sunglasses_up!.slot).toBe("eyewear");
    expect(HARU.wardrobe).toEqual({});
    expect([...expressionNames(ALEXIA)]).toEqual(expect.arrayContaining(["yf", "yfmz", "mj", "bbt", "lh", "dyj"]));
  });

  test("slot exclusivity per model", () => {
    expect(outfitFor(ALEXIA.wardrobe, ["hoodie", "hood_up", "sunglasses"])).toEqual(["hood_up", "sunglasses"]);
    expect(outfitFor(HARU.wardrobe, ["hoodie", "sunglasses"])).toEqual([]);
  });
});

describe("toggle weights", () => {
  test("fade in over ~250ms, hold, fade out", () => {
    const t = new ToggleWeights();
    t.set(["a"], 0);
    expect(t.weights(0).a ?? 0).toBe(0);
    expect(t.weights(WARDROBE_FADE_MS / 2).a).toBeCloseTo(0.5, 1);
    expect(t.weights(WARDROBE_FADE_MS).a).toBe(1);
    expect(t.weights(60_000).a).toBe(1);
    t.set([], 60_000);
    expect(t.weights(60_000 + WARDROBE_FADE_MS).a).toBeUndefined();
  });
  test("pulse returns to 0 by itself", () => {
    const t = new ToggleWeights(300);
    t.pulse("blush", 0, 1000);
    expect(t.weights(500).blush).toBe(1);
    expect(t.weights(1000 + 300).blush).toBeUndefined();
  });
});

describe("rig wardrobe layer", () => {
  test("an outfit shows, persists through a minute of idle, and moods never clear it", () => {
    const rig = alexiaRig();
    rig.setOutfit(["hoodie", "lollipop"], 0);
    let g = frame(rig, WARDROBE_FADE_MS);
    expect(g("Param16")).toBe(30);
    expect(g("Param17")).toBe(30);
    expect(g("Param60")).toBe(30);
    for (const m of ["happy", "annoyed", "sad", "smug", "surprised"] as const) {
      rig.setMood(m, 1, 1000, 500);
      frame(rig, 1000 + BLEND_MS);
    }
    g = frame(rig, 61_000);
    expect(g("Param16")).toBe(30);
    expect(g("Param60")).toBe(30);
    expect(rig.wardrobe.wearing().sort()).toEqual(["hoodie", "lollipop"]);
  });

  test("mood expression + outfit stack (happy grin + hoodie)", () => {
    const rig = alexiaRig();
    rig.setOutfit(["hood_up"], 0);
    rig.setMood("happy", 1, 0, 10_000);
    const g = frame(rig, BLEND_MS);
    expect(g("Param16")).toBe(30);
    expect(g("Param17")).toBe(0);
    expect(g("Param54")).toBeGreaterThan(20); // lzx at the mood weight cap
  });

  test("sunglasses rule: smug flashes them only when none are worn", () => {
    // Nothing worn: smug's dyj adds sunglasses, gone when smug fades.
    const bare = alexiaRig();
    bare.setMood("smug", 1, 0, 1000);
    expect(frame(bare, BLEND_MS)("Param64")).toBeGreaterThan(20);
    frame(bare, 1001);
    expect(frame(bare, 1001 + BLEND_MS)("Param64")).toBe(0);
    // Pushed up (mj) worn: smug can't add a second pair on her face.
    const up = alexiaRig();
    up.setOutfit(["sunglasses_up"], 0);
    up.setMood("smug", 1, 0, 1000);
    let g = frame(up, BLEND_MS);
    expect(g("Param64")).toBe(0);
    expect(g("Param11")).toBe(30);
    // Worn on the face: smug neither doubles nor removes them; they stay after it fades.
    const on = alexiaRig();
    on.setOutfit(["sunglasses"], 0);
    on.setMood("smug", 1, 0, 1000);
    expect(frame(on, BLEND_MS)("Param64")).toBe(30);
    expect(frame(on, 5000)("Param64")).toBe(30);
  });

  test("switching items in a slot crossfades, never both at full", () => {
    const rig = alexiaRig();
    rig.setOutfit(["sunglasses"], 0);
    frame(rig, 1000);
    rig.setOutfit(["sunglasses_up"], 1000);
    const mid = frame(rig, 1000 + WARDROBE_FADE_MS / 2);
    expect(mid("Param64")).toBeGreaterThan(5);
    expect(mid("Param64")).toBeLessThan(25);
    const end = frame(rig, 1000 + WARDROBE_FADE_MS);
    expect(end("Param64")).toBe(0);
    expect(end("Param11")).toBe(30);
  });

  test("face rest pinning never touches wardrobe params", () => {
    for (const id of ["Param16", "Param17", "Param11", "Param64", "Param60", "Param62", "Param63"]) expect(id in ALEXIA.faceRest).toBe(false);
  });

  test("Haru: wearing anything is a no-op", () => {
    const rig = new EveRig(rng(1), 0);
    rig.setModel(HARU, buildPoses(HARU, {}), { wardrobe: {}, accents: {} }, 0);
    rig.setOutfit(["hoodie", "sunglasses"], 0);
    const g = frame(rig, 1000);
    expect(g("Param16")).toBe(0);
    expect(rig.wardrobe.wearing()).toEqual([]);
    rig.wardrobe.accent("blush", 1000, 500); // no accent on haru: nothing throws
    frame(rig, 1200);
  });

  test("an outfit set before the model loads applies once it does", () => {
    const rig = new EveRig(rng(1), 0);
    rig.setOutfit(["lollipop"], 0);
    const wardrobe = buildTogglePoses({ lollipop: "bbt" }, EXPS);
    rig.setModel(ALEXIA, buildPoses(ALEXIA, EXPS), { wardrobe }, 100);
    expect(frame(rig, 100 + WARDROBE_FADE_MS)("Param60")).toBe(30);
  });
});

describe("touch", () => {
  const box = { x: 100, y: 50, w: 280, h: 420 };
  const head = headEllipse(box, ALEXIA.framing.overlay.head, ALEXIA.framing.overlay.scale);

  test("head ellipse sits at the framing head point, body below it", () => {
    expect(head.cx).toBe(100 + 280 * 0.5);
    expect(inEllipse({ x: head.cx, y: head.cy }, head)).toBe(true);
    expect(regionAt({ x: head.cx, y: head.cy }, head, false)).toBe("head");
    expect(regionAt({ x: head.cx, y: head.cy + head.ry * 3 }, head, true)).toBe("body");
    expect(regionAt({ x: head.cx, y: head.cy + head.ry * 3 }, head, false)).toBeNull();
    const r = bodyRect(head, box);
    expect(r.y + r.h).toBe(box.y + box.h);
  });

  test("pokes: pat on the head, poke on the body, annoyed at 3 in 4s, core told at most every 20s", () => {
    const p = new PokeCounter();
    expect(p.click("head", 0)).toMatchObject({ kind: "pat", count: 1, emit: false });
    expect(p.click("body", 100)).toBeNull(); // double click = one poke
    expect(p.click("body", 1000)).toMatchObject({ kind: "poke", count: 2 });
    expect(p.click("body", 2000)).toMatchObject({ kind: "annoyed", count: 3, emit: true });
    expect(p.click("body", 3000)).toMatchObject({ kind: "annoyed", count: 4, emit: false });
    expect(p.click("head", 3000 + TOUCH.pokeWindowMs + 1)).toMatchObject({ kind: "pat", count: 1 });
    const later = [30_000, 30_400, 30_800, 31_200].map((t) => p.click("body", t)!);
    expect(later.map((r) => r.emit)).toEqual([false, false, true, false]);
  });

  test("hover reactions are rate limited and alternate", () => {
    const h = new HoverLimiter();
    expect(h.enter(0)).toBe("smile");
    expect(h.enter(3000)).toBeNull();
    expect(h.enter(TOUCH.hoverGapMs)).toBe("hm");
    expect(h.enter(TOUCH.hoverGapMs * 2)).toBe("smile");
  });

  test("a pat: happy, blush accent, eyes shut then open; a poke: blink + bounce", () => {
    const rig = alexiaRig();
    playTouch({ kind: "pat", region: "head", count: 1, emit: false }, rig, 0, () => {});
    let g = frame(rig, 400);
    expect(rig.emotion.dominant(400)).toBe("happy");
    expect(g("Param58")).toBe(30); // lh blush
    expect(g("ParamEyeLOpen")).toBeLessThan(0.05);
    g = frame(rig, 3000);
    expect(g("Param58")).toBe(0);
    expect(g("ParamEyeLOpen")).toBeGreaterThan(0.9);
    let looked = 0;
    playTouch({ kind: "poke", region: "body", count: 1, emit: false }, rig, 5000, () => looked++);
    expect(rig.emotion.dominant(5000)).toBe("neutral");
    expect(looked).toBe(1);
    expect(Math.abs(bounceAt(90))).toBeGreaterThan(0.3);
    expect(bounceAt(800)).toBe(0);
  });

  test("eyes-shut profile", () => {
    expect(shutAt(0, 100, 1000)).toBe(0);
    expect(shutAt(300, 100, 1000)).toBe(1);
    expect(shutAt(1000 + 220, 100, 1000)).toBe(0);
  });
});

describe("look arbiter", () => {
  const head = { x: 1300, y: 800 };
  const spread = { x: 300, y: 150 };
  const quiet = { ...LOOK_ARB, idleGlanceMinMs: 1e9, idleGlanceMaxMs: 1e9 };

  test("priority: glance > hold > gaze > cursor > user", () => {
    const a = new LookArbiter(rng(1), 0, quiet);
    expect(a.resolve(0, { head, spread }).kind).toBe("user");
    a.cursor({ x: 10, y: 10 }, 0);
    expect(a.resolve(10, { head, spread })).toMatchObject({ kind: "cursor", point: { x: 10, y: 10 }, headGain: 0.5 });
    a.gaze({ x: 500, y: 20 }, 20);
    expect(a.resolve(30, { head, spread }).kind).toBe("gaze");
    expect(a.resolve(30, { head, spread, hold: { x: 1, y: 1 } }).kind).toBe("hold");
    expect(a.resolve(30, { head, spread, hold: { x: 1, y: 1 }, glance: { x: 2, y: 2 } })).toMatchObject({ kind: "glance", headGain: 1 });
    // gaze goes stale -> cursor again
    expect(a.resolve(20 + LOOK_ARB.gazeFreshMs + 1, { head, spread }).kind).toBe("cursor");
    a.cursor({ x: 11, y: 10 }, 1000); // jitter: doesn't count as a move
    expect(a.resolve(LOOK_ARB.cursorIdleMs + 1, { head, spread }).kind).toBe("user");
    a.cursor({ x: 400, y: 10 }, 5000);
    expect(a.resolve(5000, { head, spread }).kind).toBe("cursor");
    a.gaze({ x: 1, y: 1 }, 5000);
    a.clearGaze();
    expect(a.resolve(5001, { head, spread }).kind).toBe("cursor");
  });

  test("her own cursor outranks the user's cursor and gaze while she acts, and rides its glide", () => {
    const a = new LookArbiter(rng(3), 0, quiet);
    a.cursor({ x: 10, y: 10 }, 0);
    a.gaze({ x: 900, y: 20 }, 0);
    a.agent({ x: 100, y: 500, action: "move", ms: 0 }, 0);
    expect(a.resolve(1, { head, spread })).toMatchObject({ kind: "agent", point: { x: 100, y: 500 }, headGain: LOOK_ARB.agentHeadGain });
    // glance/hold still win (shared attention beats her own work)
    expect(a.resolve(1, { head, spread, hold: { x: 1, y: 1 } }).kind).toBe("hold");
    // A glide: halfway she looks between the two points, at the end exactly at the target.
    a.agent({ x: 1100, y: 500, action: "move", ms: 600 }, 100);
    const mid = a.resolve(400, { head, spread }).point!;
    expect(mid.x).toBeGreaterThan(100);
    expect(mid.x).toBeLessThan(1100);
    expect(a.resolve(700, { head, spread }).point).toEqual({ x: 1100, y: 500 });
    a.agent({ x: 1100, y: 500, action: "click" }, 800);
    expect(a.agentLive(800)).toBe(true);
    // idle: a short linger, then back to the normal order (gaze is stale by now, the cursor too).
    a.agent({ x: 1100, y: 500, action: "idle" }, 900);
    expect(a.resolve(900 + LOOK_ARB.agentLingerMs - 1, { head, spread }).kind).toBe("agent");
    expect(a.resolve(900 + LOOK_ARB.agentLingerMs + 1, { head, spread }).kind).not.toBe("agent");
    // No idle ever arrives: it lets go on its own.
    a.agent({ x: 5, y: 5, action: "click" }, 10_000);
    expect(a.resolve(10_000 + LOOK_ARB.agentHoldMs + 200, { head, spread }).kind).not.toBe("agent");
  });

  test("idle: back at the user, with an occasional short glance, never while tracking", () => {
    const a = new LookArbiter(rng(7), 0);
    const kinds: string[] = [];
    for (let t = 0; t < 60_000; t += 50) {
      const k = a.resolve(t, { head, spread }).kind;
      if (kinds.at(-1) !== k) kinds.push(k);
    }
    const glances = kinds.filter((k) => k === "idle-glance").length;
    expect(glances).toBeGreaterThanOrEqual(3);
    expect(glances).toBeLessThanOrEqual(10);
    expect(kinds[0]).toBe("user");
    // Tracking the cursor holds off idle glances.
    const b = new LookArbiter(rng(7), 0);
    for (let t = 0; t < 30_000; t += 50) {
      b.cursor({ x: t / 10, y: 0 }, t);
      expect(b.resolve(t, { head, spread }).kind).toBe("cursor");
    }
  });

  test("tracking focus is clamped to a natural range", () => {
    expect(clampFocus({ x: 5, y: -5 })).toEqual({ x: 0.9, y: -0.6 });
    expect(clampFocus({ x: 0.2, y: 0.1 })).toEqual({ x: 0.2, y: 0.1 });
  });

  test("head follows the cursor at ~half, eyes fully", () => {
    const rig = alexiaRig();
    const full = new Map<string, number>();
    const half = new Map<string, number>();
    const io = (p: Map<string, number>) => ({ get: (id: string) => p.get(id) ?? 0, set: (id: string, v: number) => void p.set(id, v) });
    const r2 = alexiaRig();
    for (let t = 0; t < 3000; t += 16) {
      full.clear();
      half.clear();
      rig.frame(io(full), { ...input, focus: { x: 0.8, y: 0 }, headGain: 1 }, 16, t);
      r2.frame(io(half), { ...input, focus: { x: 0.8, y: 0 }, headGain: 0.5 }, 16, t);
    }
    expect(half.get("ParamAngleX")! / full.get("ParamAngleX")!).toBeCloseTo(0.5, 1);
    expect(half.get("ParamEyeBallX")).toBeCloseTo(full.get("ParamEyeBallX")!, 2);
  });
});
