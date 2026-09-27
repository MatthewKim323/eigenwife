import { describe, expect, test } from "bun:test";
import {
  attentionEnvelope,
  clampInto,
  cornerBounds,
  DEFAULT_STATE,
  loadState,
  overlayUrl,
  parseState,
  resizeAnchored,
  resolveBounds,
  saveState,
  serializeState,
  SIZES,
  type FsLike,
} from "./state";
import { isEnvelope } from "@eigenwife/protocol";

const primary = { x: 0, y: 25, width: 1512, height: 920 }; // menu bar at the top
const second = { x: 1512, y: 0, width: 1920, height: 1055 };

describe("placement", () => {
  test("default: 420x560, bottom-right of the primary work area", () => {
    const b = resolveBounds(null, "medium", [primary], primary);
    expect(b).toEqual({ x: 1512 - 420 - 16, y: 25 + 920 - 560, width: 420, height: 560 });
  });

  test("saved bounds on a live display are kept", () => {
    const saved = { x: 2000, y: 300, width: 420, height: 560 };
    expect(resolveBounds(saved, "medium", [primary, second], primary)).toEqual(saved);
  });

  test("half off the edge gets clamped back inside", () => {
    const saved = { x: 1300, y: 600, width: 420, height: 560 };
    expect(resolveBounds(saved, "medium", [primary], primary)).toEqual({ x: 1512 - 420, y: 945 - 560, width: 420, height: 560 });
  });

  test("monitor unplugged: back to the primary corner, same size", () => {
    const saved = { x: 2600, y: 200, width: 540, height: 720 };
    const b = resolveBounds(saved, "large", [primary], primary);
    expect(b.width).toBe(540);
    expect(b.x + b.width).toBe(1512 - 16);
    expect(b.y + b.height).toBe(945);
  });

  test("corners and tiny screens", () => {
    expect(cornerBounds(primary, SIZES.small, "top-left")).toEqual({ x: 16, y: 41, width: 330, height: 440 });
    const tiny = { x: 0, y: 0, width: 300, height: 400 };
    const b = cornerBounds(tiny, SIZES.large);
    expect(b.width).toBe(268);
    expect(b.height).toBe(368);
  });

  test("resize keeps her feet where they were", () => {
    const r = { x: 1000, y: 385, width: 420, height: 560 };
    expect(resizeAnchored(r, SIZES.small, primary)).toEqual({ x: 1090, y: 505, width: 330, height: 440 });
    expect(clampInto({ x: -50, y: -50, width: 100, height: 100 }, primary)).toEqual({ x: 0, y: 25, width: 100, height: 100 });
  });
});

describe("persistence", () => {
  test("round trip through ~/.eve/overlay.json", () => {
    const files = new Map<string, string>();
    const fs: FsLike = {
      readFileSync: (p) => files.get(p)!,
      writeFileSync: (p, d) => void files.set(p, d),
      mkdirSync: () => undefined,
      existsSync: (p) => files.has(p),
    };
    const path = "/home/x/.eve/overlay.json";
    expect(loadState(path, fs)).toEqual(DEFAULT_STATE);
    const s = { ...DEFAULT_STATE, bounds: { x: 10, y: 20, width: 420, height: 560 }, muted: true, size: "large" as const };
    saveState(path, s, fs);
    expect(loadState(path, fs)).toEqual(s);
  });

  test("garbage and partial files fall back field by field", () => {
    expect(parseState("{nope")).toEqual(DEFAULT_STATE);
    expect(parseState("[]")).toEqual(DEFAULT_STATE);
    const p = parseState(JSON.stringify({ bounds: { x: 1, y: 2, width: 5, height: 5 }, size: "huge", muted: "yes", capturable: true }));
    expect(p.bounds).toBeNull();
    expect(p.size).toBe("medium");
    expect(p.muted).toBe(false);
    expect(p.capturable).toBe(true);
    expect(parseState(serializeState(DEFAULT_STATE))).toEqual(DEFAULT_STATE);
  });

  test("visible to screen capture by default (demos), no login item", () => {
    expect(DEFAULT_STATE.capturable).toBe(true);
    // old files stored the old hidden default: dropped once, re-read after v2 saves it
    expect(parseState(JSON.stringify({ capturable: false })).capturable).toBe(true);
    expect(parseState(JSON.stringify({ v: 2, capturable: false })).capturable).toBe(false);
    expect(DEFAULT_STATE.openAtLogin).toBe(false);
  });
});

describe("wiring", () => {
  test("overlay url", () => {
    expect(overlayUrl({})).toBe("http://127.0.0.1:5173/?mode=overlay");
    expect(overlayUrl({ EIGEN_PORT: "7788" })).toBe("http://127.0.0.1:5173/?mode=overlay&core=127.0.0.1%3A7788");
    expect(overlayUrl({ EVE_OVERLAY_URL: "http://x/?mode=overlay&eve=tachie" })).toBe("http://x/?mode=overlay&eve=tachie");
  });

  test("attention.pause is a valid bus envelope", () => {
    const e = attentionEnvelope(true, 1000);
    expect(isEnvelope(e)).toBe(true);
    expect(e.type).toBe("attention.pause");
    expect(e.data).toEqual({ paused: true, by: "overlay" });
  });
});
