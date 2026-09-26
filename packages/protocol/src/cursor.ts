/**
 * Motion math for Eve's own cursor (agent.cursor). Pure and shared: the core
 * uses agentGlideMs to know how long to wait before it clicks, the overlay's
 * cursor layer and the avatar's look arbiter sample the same path, so the
 * click lands exactly when the pointer arrives.
 *
 * A glide is a quadratic Bezier (a gentle wrist arc, never a straight robot
 * line) walked with a minimum-jerk profile (bell-shaped speed, like a hand)
 * plus a small overshoot that settles back onto the target.
 */

export interface CursorPt {
  x: number;
  y: number;
}

export const AGENT_GLIDE = {
  /** Shortest and longest glide. Distance maps between them (Fitts-ish log). */
  minMs: 350,
  maxMs: 700,
  /** A move this long (points) or longer takes maxMs. */
  fullPx: 1400,
  /** Peak overshoot past the target, as a fraction of the path. */
  overshoot: 0.045,
  /** Arc: control point offset as a fraction of the distance, capped. */
  bend: 0.16,
  bendMaxPx: 110,
  /** Shorter moves than this are straight (a nudge doesn't arc). */
  straightPx: 24,
};

export type GlideOpts = typeof AGENT_GLIDE;

const clamp01 = (n: number) => (n < 0 ? 0 : n > 1 ? 1 : n);

export function cursorDist(a: CursorPt, b: CursorPt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** How long a glide from `from` to `to` takes. No `from` (first appearance): the shortest glide. */
export function agentGlideMs(from: CursorPt | null | undefined, to: CursorPt, o: GlideOpts = AGENT_GLIDE): number {
  if (!from) return o.minMs;
  const d = cursorDist(from, to);
  if (d < 1) return 0;
  const k = clamp01(Math.log2(1 + d / 40) / Math.log2(1 + o.fullPx / 40));
  return Math.round(o.minMs + (o.maxMs - o.minMs) * k);
}

/** Minimum-jerk position profile: 0 -> 1 with zero speed and acceleration at both ends. */
export function minJerk(t: number): number {
  const u = clamp01(t);
  return u * u * u * (10 - 15 * u + 6 * u * u);
}

/**
 * Path parameter at time fraction t (0..1). Starts like minJerk, swings a
 * little past 1 near the end and settles at exactly 1 when t = 1.
 */
export function glideProgress(t: number, overshoot = AGENT_GLIDE.overshoot): number {
  const u = clamp01(t);
  if (u >= 1) return 1;
  // The bump is ~0 for the first half, peaks around t = 0.85, and is 0 at t = 1.
  const bump = Math.sin(Math.PI * u) * u ** 5;
  return minJerk(u) + overshoot * 3.2 * bump;
}

/** The arc's control point: perpendicular to the chord, bending "over the top" like a wrist. */
export function glideControl(from: CursorPt, to: CursorPt, o: GlideOpts = AGENT_GLIDE): CursorPt {
  const d = cursorDist(from, to);
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  if (d < o.straightPx) return mid;
  const off = Math.min(o.bendMaxPx, d * o.bend);
  // Unit normal. Pick the side that bends upward on screen (smaller y), and to the
  // left for pure vertical moves, so arcs look consistent instead of random.
  let nx = -(to.y - from.y) / d;
  let ny = (to.x - from.x) / d;
  if (ny > 0 || (Math.abs(ny) < 1e-9 && nx > 0)) {
    nx = -nx;
    ny = -ny;
  }
  return { x: mid.x + nx * off, y: mid.y + ny * off };
}

/** Quadratic Bezier at parameter s (s may run slightly past 1 for the overshoot). */
export function cursorBezier(a: CursorPt, c: CursorPt, b: CursorPt, s: number): CursorPt {
  const m = 1 - s;
  return { x: m * m * a.x + 2 * m * s * c.x + s * s * b.x, y: m * m * a.y + 2 * m * s * c.y + s * s * b.y };
}

export interface Glide {
  from: CursorPt;
  to: CursorPt;
  control: CursorPt;
  start: number;
  ms: number;
}

export function makeGlide(from: CursorPt | null | undefined, to: CursorPt, start: number, ms?: number, o: GlideOpts = AGENT_GLIDE): Glide {
  const a = from ?? to;
  return { from: { ...a }, to: { ...to }, control: glideControl(a, to, o), start, ms: ms ?? agentGlideMs(from, to, o) };
}

/** Where the glide is at time `now`. Before start: from; after start + ms: exactly to. */
export function glideAt(g: Glide, now: number, o: GlideOpts = AGENT_GLIDE): CursorPt {
  if (g.ms <= 0 || now >= g.start + g.ms) return { ...g.to };
  const t = (now - g.start) / g.ms;
  if (t <= 0) return { ...g.from };
  return cursorBezier(g.from, g.control, g.to, glideProgress(t, o.overshoot));
}

export function glideDone(g: Glide, now: number): boolean {
  return now >= g.start + g.ms;
}
