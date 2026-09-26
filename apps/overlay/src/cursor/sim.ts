import { glideAt, glideDone, makeGlide, type AgentCursorAction, type CursorPt, type Glide, type ScreenRect } from "@eigenwife/protocol";

/**
 * Eve's cursor as pure state (docs/AGENT_CURSOR.md). Feed it agent.cursor /
 * agent.browser events, ask it for a frame at any time. The renderer only
 * draws what frame() returns, so everything that moves is tested here.
 */

export interface CursorEvent {
  x: number;
  y: number;
  action: AgentCursorAction;
  label?: string;
  target?: string;
  ms?: number;
}

export const SIM = {
  /** She appears from a little below-right of her first target. */
  enterOffset: { x: 46, y: 64 },
  fadeInMs: 180,
  /** After "idle": stay this long, then fade. */
  idleHoldMs: 2000,
  fadeOutMs: 480,
  /** No event at all for this long counts as idle (a crashed core never leaves her stuck). */
  silenceMs: 9000,
  /** Click: press in and spring back. */
  pressMs: 200,
  rippleMs: 560,
  rippleRadius: 28,
  /** Typing lasts this long per type event, keystroke particles every keyEveryMs. */
  typeMs: 1500,
  keyEveryMs: 75,
  particleMs: 560,
  caretBlinkMs: 530,
  scrollMs: 950,
  /** Browser frame fade. */
  frameFadeMs: 320,
  trailMs: 170,
  /** Presence level (dim / hide) easing. */
  levelMs: 380,
  pointWiggleMs: 900,
};

export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  size: number;
  hueShift: number;
}

export interface CursorFrame {
  /** Anything to draw at all (cursor or browser frame)? The renderer sleeps when false. */
  active: boolean;
  x: number;
  y: number;
  opacity: number;
  /** 1 = rest, < 1 pressed in. */
  scale: number;
  /** Lean into the motion, radians. */
  tilt: number;
  moving: boolean;
  ripples: { x: number; y: number; r: number; alpha: number }[];
  typing: boolean;
  caretOn: boolean;
  particles: { x: number; y: number; alpha: number; size: number; hueShift: number }[];
  scroll: { dir: 1 | -1; phase: number } | null;
  hover: number;
  /** Pointing at something she's talking about: 1 wiggling, ~0.35 holding. */
  point: number;
  label: string;
  trail: { x: number; y: number; alpha: number }[];
  browser: { rect: ScreenRect; alpha: number } | null;
}

export type Rand = () => number;

export class CursorSim {
  private glide: Glide | null = null;
  private lastAt = -Infinity;
  private shownAt = -Infinity;
  private idleAt: number | null = null;
  private pressAt = -Infinity;
  private ripples: { x: number; y: number; at: number }[] = [];
  private typeUntil = -Infinity;
  private typeStart = -Infinity;
  private nextKey = 0;
  private particles: Particle[] = [];
  private scrollUntil = -Infinity;
  private scrollDir: 1 | -1 = 1;
  private hoverAt = -Infinity;
  private label = "";
  private history: { x: number; y: number; at: number }[] = [];
  private browser: { rect: ScreenRect; openAt: number; closeAt: number | null } | null = null;
  /** Always-on presence (co-op cursor): idle and silence never fade her out, setLevel dims. */
  private alwaysOn = false;
  private level = { from: 1, to: 1, at: -Infinity };
  private pointAt = -Infinity;
  private pointing = false;

  constructor(
    private rand: Rand = Math.random,
    private o = SIM,
  ) {}

  /** Current position (end of glide if one is running). */
  position(now: number): CursorPt | null {
    return this.glide ? glideAt(this.glide, now) : null;
  }

  setAlwaysOn(on: boolean): void {
    this.alwaysOn = on;
  }

  /** Presence level: 1 normal, ~0.35 dimmed (he's typing, fullscreen app), 0 hidden. Eased. */
  setLevel(level: number, now: number): void {
    const to = Math.max(0, Math.min(1, level));
    if (Math.abs(to - this.level.to) < 1e-3) return;
    this.level = { from: this.levelAt(now), to, at: now };
  }

  levelAt(now: number): number {
    const t = Math.min(1, Math.max(0, (now - this.level.at) / this.o.levelMs));
    return this.level.from + (this.level.to - this.level.from) * t;
  }

  feed(e: CursorEvent, now: number): void {
    const hidden = this.alwaysOn ? !this.glide : this.opacityAt(now) <= 0.01;
    this.lastAt = now;
    this.pointing = e.action === "point";
    if (e.action === "idle") {
      this.idleAt = now;
      this.label = "";
      return;
    }
    this.idleAt = null;
    if (hidden) this.shownAt = now;
    if (e.label) this.label = e.label;
    else if (e.action === "move") this.label = "";
    const to = { x: e.x, y: e.y };
    if (e.action === "move") {
      const from = hidden || !this.glide ? { x: to.x + this.o.enterOffset.x, y: to.y + this.o.enterOffset.y } : glideAt(this.glide, now);
      this.glide = makeGlide(from, to, now, e.ms);
      return;
    }
    // Every other action happens where the event says (normally where she already is).
    if (!this.glide || hidden) this.glide = makeGlide(null, to, now, 0);
    else {
      const here = glideAt(this.glide, now);
      if (Math.hypot(here.x - to.x, here.y - to.y) > 2) this.glide = makeGlide(here, to, now, 120);
    }
    switch (e.action) {
      case "click":
        this.pressAt = now;
        this.ripples.push({ x: to.x, y: to.y, at: now });
        break;
      case "type":
        if (now > this.typeUntil) {
          this.typeStart = now;
          this.nextKey = now;
        }
        this.typeUntil = now + this.o.typeMs;
        break;
      case "scroll":
        this.scrollUntil = now + this.o.scrollMs;
        this.scrollDir = /\bup\b/i.test(e.label ?? "") ? -1 : 1;
        break;
      case "hover":
        this.hoverAt = now;
        break;
      case "point":
        this.pointAt = now;
        break;
    }
  }

  /** The core went away: fade out now, drop the browser frame. */
  reset(now: number): void {
    if (this.glide) this.idleAt = now - this.o.idleHoldMs;
    this.typeUntil = -Infinity;
    this.scrollUntil = -Infinity;
    if (this.browser && this.browser.closeAt === null) this.browser.closeAt = now;
  }

  feedBrowser(e: { status: "open" | "closed"; bounds?: ScreenRect }, now: number): void {
    if (e.status === "open" && e.bounds) {
      const keep = this.browser && this.browser.closeAt === null;
      this.browser = { rect: { ...e.bounds }, openAt: keep ? this.browser!.openAt : now, closeAt: null };
    } else if (e.status === "closed" && this.browser && this.browser.closeAt === null) {
      this.browser.closeAt = now;
    }
  }

  private opacityAt(now: number): number {
    if (!this.glide) return 0;
    const o = this.o;
    if (this.alwaysOn) return Math.max(0, Math.min(1, (now - this.shownAt) / o.fadeInMs, this.levelAt(now)));
    const quietFrom = this.idleAt !== null ? this.idleAt + o.idleHoldMs : this.lastAt + o.silenceMs;
    const fadeIn = Math.min(1, (now - this.shownAt) / o.fadeInMs);
    const fadeOut = now <= quietFrom ? 1 : Math.max(0, 1 - (now - quietFrom) / o.fadeOutMs);
    return Math.max(0, Math.min(fadeIn, fadeOut));
  }

  frame(now: number): CursorFrame {
    const o = this.o;
    const opacity = this.opacityAt(now);
    const at = this.glide ? glideAt(this.glide, now) : { x: -100, y: -100 };
    const moving = !!this.glide && !glideDone(this.glide, now);
    // Point: a small wiggle at the thing, strong at first, then a lazy sway while she talks.
    const pAge = now - this.pointAt;
    const point = this.pointing && !moving ? (pAge < o.pointWiggleMs ? 1 : 0.35) : 0;
    const wiggle = point ? Math.sin(pAge / 70) * (pAge < o.pointWiggleMs ? 5 * (1 - pAge / o.pointWiggleMs) + 1.5 : 1.2) : 0;
    // Breathing: at rest she's never perfectly still (a hand resting on a mouse).
    const breathe = this.alwaysOn && !moving ? { x: Math.sin(now / 1700) * 1.8 + Math.sin(now / 610) * 0.5, y: Math.sin(now / 2300) * 1.4 } : { x: 0, y: 0 };
    const p = { x: at.x + breathe.x + wiggle, y: at.y + breathe.y - Math.abs(wiggle) * 0.3 };

    // Trail + tilt from recent positions.
    this.history.push({ ...p, at: now });
    while (this.history.length > 2 && now - this.history[0]!.at > o.trailMs) this.history.shift();
    const prev = this.history.find((h) => now - h.at <= 40) ?? this.history[0]!;
    const dx = p.x - prev.x;
    const tilt = moving ? Math.max(-0.22, Math.min(0.22, dx * 0.006)) : 0;
    const trail = moving ? this.history.map((h) => ({ x: h.x, y: h.y, alpha: Math.max(0, 1 - (now - h.at) / o.trailMs) * opacity * 0.5 })) : [];

    // Press: quick in, springy out.
    const pt = (now - this.pressAt) / o.pressMs;
    const scale = pt >= 0 && pt < 1 ? 1 - 0.2 * Math.sin(Math.PI * Math.min(1, pt * 1.4)) * (1 - pt * 0.3) : 1;

    this.ripples = this.ripples.filter((r) => now - r.at < o.rippleMs);
    const ripples = this.ripples.map((r) => {
      const t = (now - r.at) / o.rippleMs;
      const ease = 1 - (1 - t) ** 3;
      return { x: r.x, y: r.y, r: 4 + o.rippleRadius * ease, alpha: (1 - t) * opacity };
    });

    const typing = now < this.typeUntil && opacity > 0;
    if (typing) {
      while (this.nextKey <= now) {
        this.particles.push({ x: p.x + 6, y: p.y + 4, vx: (this.rand() - 0.3) * 0.09, vy: -0.05 - this.rand() * 0.07, born: this.nextKey, size: 2 + this.rand() * 2.5, hueShift: (this.rand() - 0.5) * 50 });
        this.nextKey += o.keyEveryMs;
      }
    }
    this.particles = this.particles.filter((q) => now - q.born < o.particleMs);
    const particles = this.particles.map((q) => {
      const age = now - q.born;
      return { x: q.x + q.vx * age, y: q.y + q.vy * age + 0.00004 * age * age, alpha: (1 - age / o.particleMs) * opacity, size: q.size, hueShift: q.hueShift };
    });
    const caretOn = typing && Math.floor((now - this.typeStart) / o.caretBlinkMs) % 2 === 0;

    const scroll = now < this.scrollUntil ? { dir: this.scrollDir, phase: ((now - (this.scrollUntil - o.scrollMs)) / 320) % 1 } : null;
    const hoverT = (now - this.hoverAt) / 1400;
    const hover = hoverT >= 0 && hoverT < 1 ? Math.sin(Math.PI * hoverT) : 0;

    let browser: CursorFrame["browser"] = null;
    if (this.browser) {
      const b = this.browser;
      const inA = Math.min(1, (now - b.openAt) / o.frameFadeMs);
      const outA = b.closeAt === null ? 1 : Math.max(0, 1 - (now - b.closeAt) / o.frameFadeMs);
      const alpha = Math.min(inA, outA);
      if (alpha <= 0 && b.closeAt !== null) this.browser = null;
      else browser = { rect: b.rect, alpha };
    }

    const active = opacity > 0 || ripples.length > 0 || particles.length > 0 || !!browser;
    return { active, x: p.x, y: p.y, opacity, scale, tilt, moving, ripples, typing, caretOn, particles, scroll, hover, point, label: this.label, trail, browser };
  }
}

/** Screen points -> this window's local px (each display has its own layer window). */
export function toLocal(p: CursorPt, display: { x: number; y: number }): CursorPt {
  return { x: p.x - display.x, y: p.y - display.y };
}

/** Is a screen point (plus a margin for the name tag) on this display? */
export function onDisplay(p: CursorPt, d: ScreenRect, margin = 260): boolean {
  return p.x >= d.x - margin && p.x < d.x + d.width + margin && p.y >= d.y - margin && p.y < d.y + d.height + margin;
}

export function isCursorEvent(x: unknown): x is CursorEvent {
  const e = x as CursorEvent;
  return !!e && Number.isFinite(e.x) && Number.isFinite(e.y) && ["move", "click", "type", "scroll", "hover", "point", "idle"].includes(e.action);
}
