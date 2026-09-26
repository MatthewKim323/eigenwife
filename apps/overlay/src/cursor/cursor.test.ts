import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { configureCursorWindow, cursorPageQuery, cursorWindowOptions, type CursorWindowLike } from "./config";
import { CursorSim, isCursorEvent, onDisplay, SIM, toLocal } from "./sim";

const D = { id: 1, bounds: { x: 0, y: 0, width: 1470, height: 956 } };

function recorder() {
  const calls: [string, unknown[]][] = [];
  const win = new Proxy({} as CursorWindowLike, { get: (_t, k) => (...a: unknown[]) => void calls.push([String(k), a]) });
  return { win, calls };
}

describe("cursor layer window never takes input", () => {
  test("options: transparent, frameless, unfocusable panel over the whole display", () => {
    const o = cursorWindowOptions(D, "/p.cjs");
    expect(o).toMatchObject({ x: 0, y: 0, width: 1470, height: 956, transparent: true, frame: false, focusable: false, alwaysOnTop: true, skipTaskbar: true, resizable: false, movable: false, hasShadow: false });
    expect(o.backgroundColor).toBe("#00000000");
    expect(o.webPreferences).toMatchObject({ contextIsolation: true, sandbox: true, nodeIntegration: false });
    if (process.platform === "darwin") expect(o.type).toBe("panel");
  });

  test("configure: click-through (no forwarding), all workspaces, capture follows the setting", () => {
    const hidden = recorder();
    configureCursorWindow(hidden.win, D, false);
    const byName = (n: string) => hidden.calls.filter(([k]) => k === n).map(([, a]) => a);
    expect(byName("setIgnoreMouseEvents")).toEqual([[true]]);
    expect(byName("setFocusable")).toEqual([[false]]);
    expect(byName("setAlwaysOnTop")[0]!.slice(0, 2)).toEqual([true, "screen-saver"]);
    expect(byName("setVisibleOnAllWorkspaces")).toEqual([[true, { visibleOnFullScreen: true }]]);
    expect(byName("setContentProtection")).toEqual([[true]]);
    const shown = recorder();
    configureCursorWindow(shown.win, D, true);
    expect(shown.calls.find(([k]) => k === "setContentProtection")![1]).toEqual([false]);
  });

  test("nothing in the layer ever turns mouse events back on or posts input", () => {
    for (const f of ["layer.ts", "config.ts", "preload.ts", "renderer.ts"]) {
      const src = readFileSync(join(import.meta.dir, f), "utf8");
      expect(src).not.toMatch(/setIgnoreMouseEvents\(\s*false/);
      expect(src).not.toMatch(/forward:\s*true/);
      expect(src).not.toMatch(/setFocusable\(\s*true/);
      expect(src).not.toMatch(/robotjs|nut-js|cliclick|CGEventPost|CGWarpMouse|desktopCapturer|getSources/);
    }
    // The preload only listens; the page has no way to talk back to main.
    const preload = readFileSync(join(import.meta.dir, "preload.ts"), "utf8");
    expect(preload).not.toMatch(/ipcRenderer\.(send|invoke)/);
  });

  test("page query carries the display origin and her hue", () => {
    expect(cursorPageQuery({ id: 2, bounds: { x: -1920, y: 0, width: 1920, height: 1080 } }, 331.6)).toEqual({ x: "-1920", y: "0", w: "1920", h: "1080", hue: "332" });
  });
});

describe("CursorSim", () => {
  test("first move enters from below-right, fades in, lands exactly on target", () => {
    const s = new CursorSim(() => 0.5);
    s.feed({ x: 400, y: 300, action: "move", ms: 500 }, 1000);
    const f0 = s.frame(1000);
    expect(f0.x).toBe(400 + SIM.enterOffset.x);
    expect(f0.y).toBe(300 + SIM.enterOffset.y);
    expect(f0.opacity).toBe(0);
    expect(s.frame(1000 + SIM.fadeInMs).opacity).toBe(1);
    const mid = s.frame(1250);
    expect(mid.moving).toBe(true);
    const end = s.frame(1500);
    expect(end).toMatchObject({ x: 400, y: 300, moving: false });
  });

  test("glides between targets on a curve, using the event's duration", () => {
    const s = new CursorSim();
    s.feed({ x: 100, y: 500, action: "move", ms: 0 }, 0);
    s.frame(0);
    s.feed({ x: 1100, y: 500, action: "move", ms: 600 }, 10);
    const mid = s.frame(310);
    expect(mid.y).toBeLessThan(500); // arcs up
    expect(mid.x).toBeGreaterThan(100);
    expect(mid.x).toBeLessThan(1100);
    expect(s.frame(610)).toMatchObject({ x: 1100, y: 500 });
  });

  test("a new move mid-glide starts from where she is (no jump)", () => {
    const s = new CursorSim();
    s.feed({ x: 0, y: 0, action: "move", ms: 0 }, 0);
    s.feed({ x: 1000, y: 0, action: "move", ms: 600 }, 0);
    const here = s.frame(300);
    s.feed({ x: 0, y: 800, action: "move", ms: 600 }, 300);
    const after = s.frame(300);
    expect(Math.hypot(after.x - here.x, after.y - here.y)).toBeLessThan(1);
  });

  test("click: press in and spring back, ripple grows and fades", () => {
    const s = new CursorSim();
    s.feed({ x: 50, y: 50, action: "move", ms: 0 }, 0);
    s.feed({ x: 50, y: 50, action: "click", label: "Menu" }, 1000);
    const pressed = s.frame(1060);
    expect(pressed.scale).toBeLessThan(0.9);
    expect(pressed.ripples.length).toBe(1);
    const r1 = pressed.ripples[0]!;
    const later = s.frame(1300);
    expect(later.ripples[0]!.r).toBeGreaterThan(r1.r);
    expect(later.ripples[0]!.alpha).toBeLessThan(r1.alpha);
    expect(s.frame(1000 + SIM.pressMs + 1).scale).toBe(1);
    expect(s.frame(1000 + SIM.rippleMs + 1).ripples.length).toBe(0);
    expect(later.label).toBe("Menu");
  });

  test("type: caret blinks, keystroke particles rise and fade", () => {
    let seed = 0;
    const s = new CursorSim(() => ((seed = (seed * 9301 + 49297) % 233280) / 233280));
    s.feed({ x: 200, y: 200, action: "move", ms: 0 }, 0);
    s.feed({ x: 200, y: 200, action: "type", label: '"ramen"' }, 1000);
    const f = s.frame(1000);
    expect(f.typing).toBe(true);
    expect(f.caretOn).toBe(true);
    expect(s.frame(1000 + SIM.caretBlinkMs + 10).caretOn).toBe(false);
    const g = s.frame(1400);
    expect(g.particles.length).toBeGreaterThan(3);
    expect(g.particles.some((p) => p.y < 200)).toBe(true);
    expect(s.frame(1000 + SIM.typeMs + SIM.particleMs + 10)).toMatchObject({ typing: false, particles: [] });
  });

  test("scroll shows direction from the label; hover pulses", () => {
    const s = new CursorSim();
    s.feed({ x: 1, y: 1, action: "move", ms: 0 }, 0);
    s.feed({ x: 1, y: 1, action: "scroll", label: "up" }, 100);
    expect(s.frame(200).scroll?.dir).toBe(-1);
    s.feed({ x: 1, y: 1, action: "scroll", label: "down" }, 300);
    expect(s.frame(400).scroll?.dir).toBe(1);
    expect(s.frame(300 + SIM.scrollMs + 1).scroll).toBeNull();
    s.feed({ x: 1, y: 1, action: "hover" }, 2000);
    expect(s.frame(2700).hover).toBeGreaterThan(0.9);
  });

  test("idle: holds ~2s, then fades out and the layer goes to sleep", () => {
    const s = new CursorSim();
    s.feed({ x: 5, y: 5, action: "move", ms: 0 }, 0);
    s.feed({ x: 5, y: 5, action: "idle" }, 1000);
    expect(s.frame(1000 + SIM.idleHoldMs - 1).opacity).toBe(1);
    expect(s.frame(1000 + SIM.idleHoldMs + SIM.fadeOutMs / 2).opacity).toBeCloseTo(0.5, 1);
    const gone = s.frame(1000 + SIM.idleHoldMs + SIM.fadeOutMs + 1);
    expect(gone.opacity).toBe(0);
    expect(gone.active).toBe(false);
    // Coming back after fading: she re-enters and fades in again.
    s.feed({ x: 600, y: 600, action: "move", ms: 400 }, 9000);
    expect(s.frame(9000).opacity).toBe(0);
    expect(s.frame(9000).x).toBe(600 + SIM.enterOffset.x);
  });

  test("silence counts as idle (a dead core never leaves her stuck on screen)", () => {
    const s = new CursorSim();
    s.feed({ x: 5, y: 5, action: "move", ms: 0 }, 0);
    expect(s.frame(SIM.silenceMs - 1).opacity).toBe(1);
    expect(s.frame(SIM.silenceMs + SIM.fadeOutMs + 1).opacity).toBe(0);
  });

  test("reset fades right away and drops the browser frame", () => {
    const s = new CursorSim();
    s.feed({ x: 5, y: 5, action: "move", ms: 0 }, 0);
    s.feedBrowser({ status: "open", bounds: { x: 0, y: 33, width: 735, height: 923 } }, 0);
    s.reset(1000);
    expect(s.frame(1000 + SIM.fadeOutMs + 1).opacity).toBe(0);
    expect(s.frame(1000 + SIM.frameFadeMs + 1).browser).toBeNull();
  });

  test("browser frame fades in on open and out on close", () => {
    const s = new CursorSim();
    s.feedBrowser({ status: "open", bounds: { x: 0, y: 33, width: 735, height: 923 } }, 0);
    expect(s.frame(SIM.frameFadeMs / 2).browser?.alpha).toBeCloseTo(0.5, 1);
    expect(s.frame(SIM.frameFadeMs).browser?.alpha).toBe(1);
    expect(s.frame(SIM.frameFadeMs).active).toBe(true);
    s.feedBrowser({ status: "closed" }, 1000);
    expect(s.frame(1000 + SIM.frameFadeMs + 1).browser).toBeNull();
  });

  test("display mapping", () => {
    expect(toLocal({ x: -100, y: 50 }, { x: -1920, y: 0 })).toEqual({ x: 1820, y: 50 });
    expect(onDisplay({ x: 1500, y: 100 }, D.bounds)).toBe(true); // within tag margin
    expect(onDisplay({ x: 3000, y: 100 }, D.bounds)).toBe(false);
    expect(isCursorEvent({ x: 1, y: 2, action: "click" })).toBe(true);
    expect(isCursorEvent({ x: 1, y: 2, action: "drag" })).toBe(false);
    expect(isCursorEvent({ x: NaN, y: 2, action: "move" })).toBe(false);
  });
});
