/**
 * Pure motion primitives for Eve's face. No DOM, no Live2D: every function
 * takes time explicitly so it can be unit tested and replayed.
 * Numbers come from docs/PLAYBOOK.md section 6.
 */

export type Rand = () => number;

export const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const easeOutCubic = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);
export const easeInCubic = (t: number) => Math.pow(clamp(t, 0, 1), 3);
export const easeInOutCubic = (t: number) => {
  const x = clamp(t, 0, 1);
  return x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2;
};

/** Per-frame lerp factor rescaled so "0.3 per 60fps frame" holds at any frame rate. */
export function frameLerp(perFrame: number, dtMs: number): number {
  return 1 - Math.pow(1 - perFrame, dtMs / (1000 / 60));
}

/** Triangular distribution: min..max with the mass piled up at mode. */
export function triangular(r: number, min: number, max: number, mode: number): number {
  const c = (mode - min) / (max - min);
  return r < c ? min + Math.sqrt(r * (max - min) * (mode - min)) : max - Math.sqrt((1 - r) * (max - min) * (max - mode));
}

// ---------------------------------------------------------------------------
// Blink: 3-8s interval, 75ms ease-out close, 150-300ms ease-in open, ~15% double.
// ---------------------------------------------------------------------------

export const BLINK = { minGapMs: 3000, maxGapMs: 8000, closeMs: 75, openMinMs: 150, openMaxMs: 300, doubleChance: 0.15, doubleGapMs: 90 };

export class BlinkScheduler {
  private nextAt: number;
  private start = -1;
  private openMs = 200;
  private pendingDouble = false;

  constructor(private rand: Rand = Math.random, now = 0) {
    this.nextAt = now + this.gap();
  }

  private gap() {
    return BLINK.minGapMs + this.rand() * (BLINK.maxGapMs - BLINK.minGapMs);
  }

  /** Force a blink now (used when she wakes up, or on a mood change). */
  trigger(now: number) {
    if (this.start >= 0) return;
    this.begin(now);
  }

  private begin(now: number) {
    this.start = now;
    this.openMs = BLINK.openMinMs + this.rand() * (BLINK.openMaxMs - BLINK.openMinMs);
  }

  /**
   * Eye-open multiplier while a blink is in flight, or null when not blinking.
   * Null means "do not write": the caller keeps the pose's eye value untouched,
   * so the multiply can never feed back and decay the eyes shut.
   */
  update(now: number): number | null {
    if (this.start < 0) {
      if (now < this.nextAt) return null;
      this.begin(now);
    }
    const t = now - this.start;
    if (t < BLINK.closeMs) return 1 - easeOutCubic(t / BLINK.closeMs);
    const o = t - BLINK.closeMs;
    if (o < this.openMs) return easeInCubic(o / this.openMs);
    // Finished.
    this.start = -1;
    if (!this.pendingDouble && this.rand() < BLINK.doubleChance) {
      this.pendingDouble = true;
      this.nextAt = now + BLINK.doubleGapMs;
    } else {
      this.pendingDouble = false;
      this.nextAt = now + this.gap();
    }
    return null;
  }

  get blinking() {
    return this.start >= 0;
  }
}

// ---------------------------------------------------------------------------
// Saccades: 0.8-4.8s, weighted toward ~2s, small targets. Paused while thinking.
// ---------------------------------------------------------------------------

export const SACCADE = { minMs: 800, maxMs: 4800, modeMs: 2000, ampX: 0.16, ampY: 0.1, centerChance: 0.35 };

export class SaccadeScheduler {
  x = 0;
  y = 0;
  private nextAt: number;
  paused = false;

  constructor(private rand: Rand = Math.random, now = 0) {
    this.nextAt = now + this.interval();
  }

  interval() {
    return triangular(this.rand(), SACCADE.minMs, SACCADE.maxMs, SACCADE.modeMs);
  }

  /** Current saccade offset (in focus units). Returns true on the frame a new dart fires. */
  update(now: number): boolean {
    if (this.paused) {
      this.x = 0;
      this.y = 0;
      this.nextAt = now + this.interval();
      return false;
    }
    if (now < this.nextAt) return false;
    if (this.rand() < SACCADE.centerChance) {
      this.x = 0;
      this.y = 0;
    } else {
      this.x = (this.rand() * 2 - 1) * SACCADE.ampX;
      this.y = (this.rand() * 2 - 1) * SACCADE.ampY;
    }
    this.nextAt = now + this.interval();
    return true;
  }
}

// ---------------------------------------------------------------------------
// Spring: k = 30 + 190 * follow, zeta = 1 - 0.75 * inertia (unit mass).
// ---------------------------------------------------------------------------

export function springParams(follow: number, inertia: number) {
  const k = 30 + 190 * clamp(follow, 0, 1);
  const zeta = 1 - 0.75 * clamp(inertia, 0, 1);
  return { k, c: 2 * zeta * Math.sqrt(k), zeta };
}

export class Spring {
  v = 0;
  constructor(
    public x = 0,
    public k = 125,
    public c = 2 * 0.7 * Math.sqrt(125),
  ) {}

  static of(follow: number, inertia: number, x = 0) {
    const p = springParams(follow, inertia);
    return new Spring(x, p.k, p.c);
  }

  /** Semi-implicit Euler with fixed 4ms substeps: stable for any frame time. */
  step(target: number, dtMs: number): number {
    let left = Math.min(dtMs, 100) / 1000;
    while (left > 0) {
      const h = Math.min(left, 0.004);
      const a = -this.k * (this.x - target) - this.c * this.v;
      this.v += a * h;
      this.x += this.v * h;
      left -= h;
    }
    return this.x;
  }
}

// ---------------------------------------------------------------------------
// Breath: ParamBreath 0..0.5, 2s cosine cycle then 1.2s pause.
// ---------------------------------------------------------------------------

export const BREATH = { cycleMs: 2000, pauseMs: 1200, peak: 0.5 };

export function breathAt(nowMs: number, slow = 1): number {
  const cycle = BREATH.cycleMs * slow;
  const period = cycle + BREATH.pauseMs * slow;
  const t = ((nowMs % period) + period) % period;
  if (t >= cycle) return 0;
  return (BREATH.peak / 2) * (1 - Math.cos((2 * Math.PI * t) / cycle));
}

/** Tiny idle sway: incommensurate sines, so it never visibly loops. */
export function idleSway(nowMs: number): { x: number; y: number; z: number } {
  const t = nowMs / 1000;
  return {
    x: 1.6 * Math.sin(t * 0.37) + 0.7 * Math.sin(t * 0.91 + 1.3),
    y: 1.1 * Math.sin(t * 0.29 + 0.4) + 0.5 * Math.sin(t * 0.73 + 2.1),
    z: 1.8 * Math.sin(t * 0.23 + 0.9) + 0.6 * Math.sin(t * 0.61),
  };
}
