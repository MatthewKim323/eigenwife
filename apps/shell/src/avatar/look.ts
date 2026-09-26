import type { Rand } from "./motion-math";

/**
 * Where she looks, when several things want her eyes. Pure: the caller feeds
 * points in ONE coordinate space (the overlay uses screen points, the shell
 * column uses viewport px) and maps the winner into focus space.
 *
 * Priority, highest first:
 *   glance  an explicit, short shared-attention target (avatar.look, a new gaze.target element)
 *   hold    a sustained target (watching the swarm while acting)
 *   gaze    the user's real gaze point (gaze.point), while fresh
 *   cursor  the mouse, anywhere on screen, until it rests for CURSOR_IDLE_MS
 *   idle    back to the user (camera, top-center), with an occasional glance around
 *
 * Plugging in a gaze tracker = calling arbiter.gaze(point, now) per sample.
 */

export interface Pt {
  x: number;
  y: number;
}

export type LookKind = "glance" | "hold" | "gaze" | "cursor" | "idle-glance" | "user";

export interface LookChoice {
  kind: LookKind;
  /** null for "user": look out of the screen at them. */
  point: Pt | null;
  /** How much her head follows (eyes always follow fully). Tracking the cursor/gaze: ~half. */
  headGain: number;
}

export const LOOK_ARB = {
  /** The cursor has to rest this long before she drifts back to you. */
  cursorIdleMs: 4000,
  /** Moves smaller than this (px) don't count as "the cursor moved". */
  cursorJitterPx: 2,
  /** A gaze sample older than this no longer counts. */
  gazeFreshMs: 600,
  /** Idle: a short glance somewhere every 6-14s, 500-900ms long. */
  idleGlanceMinMs: 6000,
  idleGlanceMaxMs: 14000,
  idleGlanceMs: [500, 900] as [number, number],
  /** Head gain while tracking the cursor / gaze. */
  trackHeadGain: 0.5,
};

export class LookArbiter {
  private cur: { p: Pt; movedAt: number } | null = null;
  private gz: { p: Pt; at: number } | null = null;
  private nextIdleGlance: number;
  private idleGlance: { p: Pt; until: number } | null = null;

  constructor(
    private rand: Rand = Math.random,
    now = 0,
    private opts = LOOK_ARB,
  ) {
    this.nextIdleGlance = now + this.idleGap();
  }

  private idleGap() {
    return this.opts.idleGlanceMinMs + this.rand() * (this.opts.idleGlanceMaxMs - this.opts.idleGlanceMinMs);
  }

  /** A cursor sample. Only real movement resets the idle timer. */
  cursor(p: Pt, now: number) {
    const c = this.cur;
    if (c && Math.hypot(p.x - c.p.x, p.y - c.p.y) < this.opts.cursorJitterPx) return;
    this.cur = { p: { ...p }, movedAt: now };
  }

  /** A real gaze sample (eye tracker). */
  gaze(p: Pt, now: number) {
    this.gz = { p: { ...p }, at: now };
  }

  /** Gaze lost / tracker gone. */
  clearGaze() {
    this.gz = null;
  }

  /** Is she tracking the cursor right now (moved within cursorIdleMs)? */
  cursorLive(now: number): boolean {
    return !!this.cur && now - this.cur.movedAt <= this.opts.cursorIdleMs;
  }

  resolve(now: number, s: { glance?: Pt | null; hold?: Pt | null; head: Pt; spread: Pt }): LookChoice {
    if (s.glance) return { kind: "glance", point: s.glance, headGain: 1 };
    if (s.hold) return { kind: "hold", point: s.hold, headGain: 1 };
    const track = this.opts.trackHeadGain;
    if (this.gz && now - this.gz.at <= this.opts.gazeFreshMs) {
      this.bumpIdle(now);
      return { kind: "gaze", point: this.gz.p, headGain: track };
    }
    if (this.cur && this.cursorLive(now)) {
      this.bumpIdle(now);
      return { kind: "cursor", point: this.cur.p, headGain: track };
    }
    // Idle: at the user, now and then a quick look around (where the cursor
    // was last, or somewhere near her).
    if (this.idleGlance && now < this.idleGlance.until) return { kind: "idle-glance", point: this.idleGlance.p, headGain: track };
    this.idleGlance = null;
    if (now >= this.nextIdleGlance) {
      const [a, b] = this.opts.idleGlanceMs;
      const p =
        this.cur && this.rand() < 0.5
          ? this.cur.p
          : { x: s.head.x + (this.rand() * 2 - 1) * s.spread.x, y: s.head.y + (this.rand() * 0.8 - 0.2) * s.spread.y };
      this.idleGlance = { p, until: now + a + this.rand() * (b - a) };
      this.nextIdleGlance = this.idleGlance.until + this.idleGap();
      return { kind: "idle-glance", point: p, headGain: track };
    }
    return { kind: "user", point: null, headGain: 1 };
  }

  /** While tracking, idle glances wait until she's been idle a while. */
  private bumpIdle(now: number) {
    this.idleGlance = null;
    this.nextIdleGlance = Math.max(this.nextIdleGlance, now + this.opts.idleGlanceMinMs);
  }
}

/** Natural range for tracking: full turn sideways is fine, up/down less so. */
export function clampFocus(f: Pt, max: Pt = { x: 0.9, y: 0.6 }): Pt {
  return { x: Math.max(-max.x, Math.min(max.x, f.x)), y: Math.max(-max.y, Math.min(max.y, f.y)) };
}
