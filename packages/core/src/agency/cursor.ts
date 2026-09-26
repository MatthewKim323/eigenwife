import { agentGlideMs, type AgentCursorAction, type CursorPt, type ScreenRect } from "@eigenwife/protocol";
import type { EventBus } from "../bus";
import { runJxa, type OsaRunner } from "./osa";

/**
 * Eve's own cursor, core side (docs/AGENT_CURSOR.md). This only ever emits
 * agent.cursor events for the overlay's cursor layer to draw. It never moves
 * matt's real pointer: there is no CGEvent, no cliclick, nothing that posts input.
 *
 * move() waits for the glide (the same agentGlideMs the renderer uses), so a
 * click emitted right after it lands exactly when her pointer arrives.
 */

export const CURSOR_CLIENT = "eve-cursor";
const SRC = "agency";

export interface AgentCursorOpts {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Emit idle this long after the last action (the layer then fades her out ~2s later). */
  idleAfterMs?: number;
}

export class AgentCursor {
  private pos: CursorPt | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | undefined;
  private seenAt = 0;
  private lastAt = 0;
  private offHello: () => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly idleAfterMs: number;

  constructor(
    private bus: EventBus,
    opts: AgentCursorOpts = {},
  ) {
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? (() => Date.now());
    this.idleAfterMs = opts.idleAfterMs ?? 1200;
    // The overlay's cursor layer says hello when it connects (and on every reconnect).
    this.offHello = bus.on("bus.hello", (e) => {
      if (e.data.client === CURSOR_CLIENT) this.seenAt = this.now();
    });
  }

  /** Is anyone drawing her cursor? The show (visible browsing, native glides) only runs when true. */
  watching(): boolean {
    return this.seenAt > 0;
  }

  /** For tests and the dev CLI: pretend the layer is connected. */
  markWatching(on = true): void {
    this.seenAt = on ? Math.max(1, this.now()) : 0;
  }

  position(): CursorPt | null {
    return this.pos ? { ...this.pos } : null;
  }

  private emit(action: AgentCursorAction, p: CursorPt, extra: { label?: string; target?: string; ms?: number } = {}): void {
    clearTimeout(this.idleTimer);
    this.lastAt = this.now();
    this.bus.emit("agent.cursor", { x: Math.round(p.x), y: Math.round(p.y), space: "screen", action, ...clean(extra) }, SRC);
  }

  /** Glide to p and resolve when she's there. Returns the glide ms. */
  async move(p: CursorPt, extra: { label?: string; target?: string } = {}): Promise<number> {
    const ms = agentGlideMs(this.pos, p);
    this.emit("move", p, { ...extra, ms });
    this.pos = { x: p.x, y: p.y };
    if (ms > 0) await this.sleep(ms);
    return ms;
  }

  click(extra: { label?: string; target?: string } = {}): void {
    if (this.pos) this.emit("click", this.pos, extra);
  }

  type(extra: { label?: string; target?: string } = {}): void {
    if (this.pos) this.emit("type", this.pos, extra);
  }

  scroll(extra: { label?: string; target?: string } = {}): void {
    if (this.pos) this.emit("scroll", this.pos, extra);
  }

  hover(extra: { label?: string; target?: string } = {}): void {
    if (this.pos) this.emit("hover", this.pos, extra);
  }

  /** Shared attention: a little wiggle at where she already is, while she talks about it. */
  point(extra: { label?: string; target?: string } = {}): void {
    if (this.pos) this.emit("point", this.pos, extra);
  }

  /** When she last did anything with her cursor (task steps, glides, points). */
  lastActionAt(): number {
    return this.lastAt;
  }

  /** Done for now: after a short beat she goes idle (and fades). Any new action cancels it. */
  settle(): void {
    clearTimeout(this.idleTimer);
    if (!this.pos) return;
    const p = this.pos;
    this.idleTimer = setTimeout(() => this.bus.emit("agent.cursor", { x: Math.round(p.x), y: Math.round(p.y), space: "screen", action: "idle" }, SRC), this.idleAfterMs);
  }

  stop(): void {
    clearTimeout(this.idleTimer);
    this.offHello();
  }
}

function clean<T extends Record<string, unknown>>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) if (v !== undefined && v !== "") (out as Record<string, unknown>)[k] = typeof v === "string" ? v.slice(0, 80) : v;
  return out;
}

// ---------------------------------------------------------------------------
// native targets: where on screen an app "is", from window bounds only
// ---------------------------------------------------------------------------

/**
 * JXA: the largest on-screen, normal-layer window owned by the named app, plus
 * the display frames. Reads CGWindowList bounds and owner names only: never
 * window titles (kCGWindowName), never pixels, so it needs no Screen Recording
 * or Accessibility permission. Payload arrives as argv[0].
 */
export const WINDOW_BOUNDS_JXA = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  var p = JSON.parse(argv[0]);
  var want = String(p.app || "").toLowerCase();
  var screens = $.NSScreen.screens, displays = [], mainH = 0;
  for (var s = 0; s < screens.count; s++) {
    var f = screens.objectAtIndex(s).frame;
    if (s === 0) mainH = f.size.height;
    displays.push({ x: f.origin.x, y: 0, width: f.size.width, height: f.size.height, cy: f.origin.y });
  }
  for (var d = 0; d < displays.length; d++) { displays[d].y = mainH - (displays[d].cy + displays[d].height); delete displays[d].cy; }
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  var best = null;
  for (var i = 0; i < list.count; i++) {
    var w = list.objectAtIndex(i);
    var owner = ObjC.unwrap(w.objectForKey("kCGWindowOwnerName"));
    if (ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0 || !owner || String(owner).toLowerCase() !== want) continue;
    var b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    if (!b || b.Width < 120 || b.Height < 90) continue;
    var cx = b.X + b.Width / 2, cy = b.Y + b.Height / 2, on = false;
    for (var k = 0; k < displays.length; k++) { var r = displays[k]; if (cx >= r.x && cx < r.x + r.width && cy >= r.y && cy < r.y + r.height) on = true; }
    if (!on) continue;
    if (!best || b.Width * b.Height > best.width * best.height) best = { x: b.X, y: b.Y, width: b.Width, height: b.Height };
  }
  return JSON.stringify({ window: best, displays: displays });
}`;

export interface NativeTarget {
  point: CursorPt;
  /** "window": the app's window. "dock": no window on screen, so its Dock icon area. */
  kind: "window" | "dock";
  bounds?: ScreenRect;
}

/**
 * Where her cursor should go to "use" an app: a bit above the middle of its
 * biggest window (where a title / play area usually is), else the Dock.
 */
export function nativeTargetFrom(raw: { window: ScreenRect | null; displays: ScreenRect[] } | null): NativeTarget | null {
  if (!raw) return null;
  const w = raw.window;
  if (w && w.width > 0 && w.height > 0) return { kind: "window", bounds: w, point: { x: w.x + w.width / 2, y: w.y + w.height * 0.42 } };
  const main = raw.displays[0];
  if (!main) return null;
  return { kind: "dock", point: { x: main.x + main.width / 2, y: main.y + main.height - 34 } };
}

export async function findNativeTarget(osa: OsaRunner, app: string, timeoutMs = 1500): Promise<NativeTarget | null> {
  const r = await runJxa<{ window: ScreenRect | null; displays: ScreenRect[] }>(osa, WINDOW_BOUNDS_JXA, { app }, timeoutMs);
  return r.ok ? nativeTargetFrom(r.value) : null;
}
