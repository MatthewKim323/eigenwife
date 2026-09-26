/**
 * Click-through for the desktop overlay. The window ignores the mouse by
 * default (forwarding moves so we still see the cursor); we read the alpha of
 * Eve's actual painted pixels under the pointer, and only while it's her do we
 * ask the main process to take clicks. Everything here is pure.
 */

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Alpha hysteresis (0..255): enter on solid pixels, leave only when clearly off her. */
export const HIT = { enter: 48, exit: 16, radius: 5, leaveDelayMs: 140 };

/** Fit her logical box (bw x bh) into the window, bottom-centered. */
export function fitBox(winW: number, winH: number, bw: number, bh: number, pad = 0): Box {
  const s = Math.min((winW - pad * 2) / bw, (winH - pad) / bh);
  const w = bw * s;
  const h = bh * s;
  return { x: (winW - w) / 2, y: winH - h, w, h };
}

/** Page point -> backing-store pixel of a canvas drawn over `box`. null when outside. */
export function toCanvasPixel(px: number, py: number, box: Box, canvasW: number, canvasH: number): { cx: number; cy: number } | null {
  const u = (px - box.x) / box.w;
  const v = (py - box.y) / box.h;
  if (!(u >= 0 && u < 1 && v >= 0 && v < 1)) return null;
  return { cx: Math.floor(u * canvasW), cy: Math.floor(v * canvasH) };
}

/** Same bottom fade the layer masks her with (#000 76% -> transparent 98%), as a multiplier. */
export function bottomFade(v: number): number {
  if (v <= 0.76) return 1;
  if (v >= 0.98) return 0;
  return 1 - (v - 0.76) / 0.22;
}

/** object-fit: contain rect of an image (nw x nh) inside a box (bw x bh), in box px. */
export function containRect(bw: number, bh: number, nw: number, nh: number): Box {
  const s = Math.min(bw / nw, bh / nh);
  const w = nw * s;
  const h = nh * s;
  return { x: (bw - w) / 2, y: (bh - h) / 2, w, h };
}

/**
 * Max alpha around the pointer (center + 4 points at `radius` css px), times
 * the bottom fade. sample(cx, cy) returns 0..255 for a backing-store pixel.
 * A small neighborhood keeps her grabbable at hair tips and edges.
 */
export function hitAlpha(
  px: number,
  py: number,
  box: Box,
  canvasW: number,
  canvasH: number,
  sample: (cx: number, cy: number) => number,
  radius = HIT.radius,
): number {
  let best = 0;
  const pts: [number, number][] = [
    [0, 0],
    [radius, 0],
    [-radius, 0],
    [0, radius],
    [0, -radius],
  ];
  for (const [dx, dy] of pts) {
    const p = toCanvasPixel(px + dx, py + dy, box, canvasW, canvasH);
    if (!p) continue;
    const a = sample(p.cx, p.cy);
    if (a > best) best = a;
    if (best >= 255) break;
  }
  const v = (py - box.y) / box.h;
  return best * bottomFade(v);
}

/**
 * Turns noisy per-move hit results into a steady interactive flag. Enter is
 * instant (grab her the moment you touch her). Leave waits a beat so a pixel of
 * stray hair doesn't flicker the window between modes. Never leaves mid-drag.
 */
export class ClickThroughGate {
  interactive = false;
  private dragging = false;
  private offSince: number | null = null;

  constructor(
    private send: (interactive: boolean) => void,
    private opts = { enter: HIT.enter, exit: HIT.exit, leaveDelayMs: HIT.leaveDelayMs },
  ) {}

  /** Feed the alpha under the pointer (or -1 when the pointer left the window). */
  update(alpha: number, now: number) {
    if (this.dragging) return;
    const over = this.interactive ? alpha > this.opts.exit : alpha >= this.opts.enter;
    if (over) {
      this.offSince = null;
      if (!this.interactive) this.set(true);
      return;
    }
    if (!this.interactive) return;
    if (alpha < 0) return this.set(false);
    this.offSince ??= now;
    if (now - this.offSince >= this.opts.leaveDelayMs) this.set(false);
  }

  /** Called on a timer too, so the leave delay fires without another mousemove. */
  tick(now: number) {
    if (this.interactive && !this.dragging && this.offSince !== null && now - this.offSince >= this.opts.leaveDelayMs) this.set(false);
  }

  setDragging(on: boolean) {
    this.dragging = on;
    if (on) this.offSince = null;
  }

  /** Force click-through (window hidden, pointer left). */
  release() {
    this.dragging = false;
    this.offSince = null;
    if (this.interactive) this.set(false);
  }

  private set(on: boolean) {
    this.interactive = on;
    this.offSince = null;
    this.send(on);
  }
}

/** A press that moved less than this (css px) is a tap, not a drag. */
export const TAP_SLOP = 4;
