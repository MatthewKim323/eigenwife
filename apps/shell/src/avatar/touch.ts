/**
 * Cursor + touch reactions (desktop overlay and the shell's right column).
 * Pure logic: geometry, rate limits, poke counting. The glue that turns a
 * reaction into rig calls is `playTouch` at the bottom.
 *
 * - where she looks (cursor anywhere, real gaze, idle) is look.ts, not here.
 * - hover on her pixels: a tiny smile or a "hm?" glance, at most every 8s.
 * - click body: a startled blink + a small hop. Click head: a pat (happy,
 *   blush, eyes shut). 3+ clicks inside 4s: annoyed, and the core gets
 *   avatar.poke so the reflex can say one short line (rate limited there too).
 * - drag start: surprised. Drop: she settles.
 */

export interface Pt {
  x: number;
  y: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Head hit ellipse, as fractions of the model's height (scale * box height). */
export interface HeadShape {
  rx: number;
  ry: number;
  /** Ellipse center relative to the look-at head point (between the eyes); negative = up. */
  dy: number;
}

export const DEFAULT_HEAD: HeadShape = { rx: 0.055, ry: 0.068, dy: -0.03 };

export const TOUCH = {
  hoverGapMs: 8000,
  pokeWindowMs: 4000,
  pokeAnnoyed: 3,
  /** Shell-side limit on avatar.poke events (the reflex rule has its own cooldown). */
  pokeEmitGapMs: 20_000,
  /** Min gap between click reactions (a double click is one poke). */
  clickGapMs: 250,
};

export interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/**
 * Her head ellipse in page px. `box` is her canvas box on the page, `head` the
 * look-at point in box fractions (framing.head), `scale` the model height in
 * box heights (framing.scale).
 */
export function headEllipse(box: Box, head: Pt, scale: number, shape: HeadShape = DEFAULT_HEAD): Ellipse {
  const mh = box.h * scale;
  return { cx: box.x + box.w * head.x, cy: box.y + box.h * head.y + shape.dy * mh, rx: shape.rx * mh, ry: shape.ry * mh };
}

export function inEllipse(p: Pt, e: Ellipse): boolean {
  const dx = (p.x - e.cx) / e.rx;
  const dy = (p.y - e.cy) / e.ry;
  return dx * dx + dy * dy <= 1;
}

/** Rough silhouette (the shell column's hit area): under her head, ~3 heads wide, down to the box bottom. */
export function bodyRect(head: Ellipse, box: Box): Box {
  const w = head.rx * 3.2;
  const top = head.cy - head.ry;
  return { x: head.cx - w / 2, y: top, w, h: Math.max(0, box.y + box.h - top) };
}

export type Region = "head" | "face" | "ears" | "chest" | "belly" | "body";

/**
 * Which part of her is under the pointer, derived from her head ellipse (so it
 * scales with every dock and model). `painted` = her pixels are there
 * (overlay: alpha hit test; shell column: the body rect). Head wins inside the
 * head ellipse, even over transparent gaps in the hair. `ears` only for models
 * that have them (Alexia's cat ears sit above the head ellipse).
 */
export function regionAt(p: Pt, head: Ellipse, painted: boolean, opts: { ears?: boolean } = {}): Region | null {
  const dx = p.x - head.cx;
  const dy = p.y - head.cy;
  const hh = head.ry * 2;
  if (opts.ears && dy < -head.ry * 0.55 && Math.abs(dx) > head.rx * 0.35 && Math.abs(dx) < head.rx * 1.9 && dy > -head.ry * 2.2) return "ears";
  if (inEllipse(p, head)) return dy > head.ry * 0.05 ? "face" : "head";
  if (!painted) return null;
  const chin = head.cy + head.ry;
  const y = p.y - chin;
  if (y > hh * 0.15 && y < hh * 1.25 && Math.abs(dx) < head.rx * 1.25) return "chest";
  if (y >= hh * 1.25 && y < hh * 2.3 && Math.abs(dx) < head.rx * 1.05) return "belly";
  return "body";
}

export type HoverReaction = "smile" | "hm";

/** Hovering on her: alternate a tiny smile and a "hm?" glance, at most every gapMs. */
export class HoverLimiter {
  private lastAt = -Infinity;
  private n = 0;
  constructor(private gapMs = TOUCH.hoverGapMs) {}
  enter(now: number): HoverReaction | null {
    if (now - this.lastAt < this.gapMs) return null;
    this.lastAt = now;
    return this.n++ % 2 === 0 ? "smile" : "hm";
  }
}

export type ClickKind = "pat" | "poke" | "annoyed" | "boop" | "ears" | "chest" | "tickle";
export type ClickReaction = { kind: ClickKind; region: Region; count: number; emit: boolean };

/** What a single click on a region is. */
export const REGION_KIND: Record<Region, Exclude<ClickKind, "annoyed">> = {
  head: "pat",
  face: "boop",
  ears: "ears",
  chest: "chest",
  belly: "tickle",
  body: "poke",
};

/** Counts clicks in a sliding window and decides pat / poke / annoyed, plus whether to tell the core. */
export class PokeCounter {
  private times: number[] = [];
  private lastEmit = -Infinity;
  private lastClick = -Infinity;
  constructor(private opts = { windowMs: TOUCH.pokeWindowMs, annoyedAt: TOUCH.pokeAnnoyed, emitGapMs: TOUCH.pokeEmitGapMs, clickGapMs: TOUCH.clickGapMs }) {}

  count(now: number): number {
    this.times = this.times.filter((t) => now - t <= this.opts.windowMs);
    return this.times.length;
  }

  click(region: Region, now: number): ClickReaction | null {
    if (now - this.lastClick < this.opts.clickGapMs) return null;
    this.lastClick = now;
    this.times.push(now);
    const count = this.count(now);
    // Boundaries: she runs out of patience faster when it's the chest.
    const annoyedAt = region === "chest" ? Math.min(2, this.opts.annoyedAt) : this.opts.annoyedAt;
    if (count >= annoyedAt) {
      const emit = now - this.lastEmit >= this.opts.emitGapMs;
      if (emit) this.lastEmit = now;
      return { kind: "annoyed", region, count, emit };
    }
    return { kind: REGION_KIND[region], region, count, emit: false };
  }
}

// ---------------------------------------------------------------------------
// Glue: reaction -> rig
// ---------------------------------------------------------------------------

export interface TouchTarget {
  setMood(mood: "happy" | "surprised" | "annoyed" | "thinking" | "neutral", intensity: number, now: number, holdMs?: number): void;
  blink: { trigger(at: number): void };
  bounce(now: number): void;
  closeEyes(now: number, ms: number): void;
  wardrobe: { accent(name: string, now: number, holdMs: number): void };
}

export type TouchEvent = ClickReaction | { kind: "hover"; reaction: HoverReaction } | { kind: "drag-start" } | { kind: "drop" };

/** Subtle by design: low intensities, short holds. `look` glances at a point for ms. */
export function playTouch(ev: TouchEvent, rig: TouchTarget, now: number, look: (ms: number) => void) {
  switch (ev.kind) {
    case "hover":
      if (ev.reaction === "smile") rig.setMood("happy", 0.3, now, 900);
      else {
        look(700);
        rig.blink.trigger(now);
      }
      return;
    case "poke":
      // A blink and a hop. No partial "surprised" pose: on toggle-style
      // expressions (Alexia's star eyes) a low weight reads as a ghosted overlay.
      rig.blink.trigger(now);
      rig.bounce(now);
      look(800);
      return;
    case "pat":
      rig.setMood("happy", 0.7, now, 1800);
      rig.wardrobe.accent("blush", now, 1800);
      rig.closeEyes(now, 1300);
      return;
    case "annoyed":
      rig.setMood("annoyed", 0.75, now, 2600);
      look(900);
      return;
    case "boop":
      rig.blink.trigger(now);
      rig.setMood("happy", 0.45, now, 1200);
      return;
    case "ears":
      rig.setMood("happy", 0.6, now, 1600);
      rig.wardrobe.accent("blush", now, 1600);
      rig.closeEyes(now, 900);
      return;
    case "chest":
      // Flustered, then a boundary: blush + annoyed, eyes back on him.
      rig.setMood("annoyed", 0.7, now, 2200);
      rig.wardrobe.accent("blush", now, 2200);
      rig.bounce(now);
      look(1000);
      return;
    case "tickle":
      rig.setMood("happy", 0.8, now, 1400);
      rig.bounce(now);
      return;
    case "drag-start":
      rig.setMood("surprised", 1, now, 60_000);
      return;
    case "drop":
      rig.setMood("neutral", 0, now, 0);
      rig.bounce(now);
      return;
  }
}
