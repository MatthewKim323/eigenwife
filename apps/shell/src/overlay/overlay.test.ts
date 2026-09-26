import { describe, expect, test } from "bun:test";
import { bottomFade, ClickThroughGate, containRect, fitBox, HIT, hitAlpha, toCanvasPixel } from "./hittest";
import { isOverlayMode } from "./mode";
import { chipFor, triggerLabel, type ChipInput } from "./status";

describe("overlay mode", () => {
  test("?mode=overlay", () => {
    expect(isOverlayMode("?mode=overlay")).toBe(true);
    expect(isOverlayMode("?mode=overlay&stt=browser")).toBe(true);
    expect(isOverlayMode("")).toBe(false);
    expect(isOverlayMode("?scene=desktop")).toBe(false);
  });
});

describe("hit test", () => {
  const box = { x: 20, y: 0, w: 380, h: 570 };

  test("fit her box bottom-centered in a 420x560 window", () => {
    const b = fitBox(420, 560, 560, 840);
    expect(b.h).toBeCloseTo(560);
    expect(b.w).toBeCloseTo(373.33, 1);
    expect(b.x).toBeCloseTo((420 - 373.33) / 2, 1);
    expect(b.y).toBeCloseTo(0);
    // wide window: height-limited, still centered
    const w = fitBox(900, 560, 560, 840);
    expect(w.x).toBeGreaterThan(200);
  });

  test("page point -> backing pixel (2x canvas)", () => {
    expect(toCanvasPixel(20, 0, box, 1120, 1680)).toEqual({ cx: 0, cy: 0 });
    expect(toCanvasPixel(210, 285, box, 1120, 1680)).toEqual({ cx: 560, cy: 840 });
    expect(toCanvasPixel(19, 10, box, 1120, 1680)).toBeNull();
    expect(toCanvasPixel(400, 10, box, 1120, 1680)).toBeNull();
  });

  test("bottom fade matches the layer mask", () => {
    expect(bottomFade(0.5)).toBe(1);
    expect(bottomFade(0.87)).toBeCloseTo(0.5);
    expect(bottomFade(0.99)).toBe(0);
  });

  test("alpha under her body vs transparent air", () => {
    // her silhouette: a centered column 40% wide
    const sample = (cx: number) => (cx > 1120 * 0.3 && cx < 1120 * 0.7 ? 255 : 0);
    expect(hitAlpha(210, 200, box, 1120, 1680, sample)).toBe(255);
    expect(hitAlpha(40, 200, box, 1120, 1680, sample)).toBe(0);
    // just outside the edge: the neighborhood still catches her
    const edgeX = 20 + 380 * 0.3 - 3;
    expect(hitAlpha(edgeX, 200, box, 1120, 1680, sample)).toBe(255);
    expect(hitAlpha(edgeX, 200, box, 1120, 1680, sample, 0)).toBe(0);
    // faded-out feet don't grab clicks
    expect(hitAlpha(210, 565, box, 1120, 1680, sample)).toBe(0);
  });

  test("contain rect for the tachie stills", () => {
    expect(containRect(560, 840, 1000, 1000)).toEqual({ x: 0, y: 140, w: 560, h: 560 });
  });
});

describe("click-through gate", () => {
  test("enter instantly, leave after the delay, hysteresis between", () => {
    const sent: boolean[] = [];
    const g = new ClickThroughGate((on) => sent.push(on));
    g.update(0, 0);
    g.update(HIT.enter - 1, 10);
    expect(sent).toEqual([]);
    g.update(200, 20);
    expect(sent).toEqual([true]);
    g.update(HIT.exit + 1, 30); // soft edge: still her
    g.update(0, 40);
    g.update(0, 40 + HIT.leaveDelayMs - 1);
    expect(sent).toEqual([true]);
    g.tick(40 + HIT.leaveDelayMs);
    expect(sent).toEqual([true, false]);
  });

  test("a stray transparent pixel mid-hover doesn't flicker", () => {
    const sent: boolean[] = [];
    const g = new ClickThroughGate((on) => sent.push(on));
    g.update(255, 0);
    g.update(0, 16);
    g.update(255, 32);
    g.tick(500);
    expect(sent).toEqual([true]);
  });

  test("never drops clicks mid-drag; pointer leaving the window releases", () => {
    const sent: boolean[] = [];
    const g = new ClickThroughGate((on) => sent.push(on));
    g.update(255, 0);
    g.setDragging(true);
    g.update(0, 100);
    g.tick(1000);
    expect(sent).toEqual([true]);
    g.setDragging(false);
    g.update(-1, 1100);
    expect(sent).toEqual([true, false]);
  });
});

describe("status chip", () => {
  const base: ChipInput = {
    connected: true,
    born: true,
    approval: null,
    muted: false,
    thinking: false,
    heard: "",
    listening: true,
    micError: undefined,
    speaking: false,
    attentionPaused: false,
  };

  test("priority: offline > asleep > approval > muted > thinking > heard > listening", () => {
    expect(chipFor({ ...base, connected: false, born: false }).kind).toBe("offline");
    expect(chipFor({ ...base, born: false }).kind).toBe("asleep");
    expect(chipFor({ ...base, approval: "add ramen to calendar", thinking: true }).text).toContain("say");
    expect(chipFor({ ...base, muted: true, thinking: true }).kind).toBe("muted");
    expect(chipFor({ ...base, thinking: true }).kind).toBe("thinking");
    expect(chipFor({ ...base, heard: "what about this" }).text).toBe("“what about this”");
    expect(chipFor(base).kind).toBe("listening");
    expect(chipFor({ ...base, listening: false, micError: "mic blocked" }).text).toBe("mic blocked");
  });

  test("trigger labels read like words", () => {
    expect(triggerLabel("dating_relapse#3")).toBe("dating relapse");
    expect(triggerLabel("companion_born#1")).toBe("companion born");
  });

  test("asleep hint says what to do", () => {
    expect(chipFor({ ...base, born: false }).sub).toContain("Eigen");
  });
});
