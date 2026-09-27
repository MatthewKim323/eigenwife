/**
 * Your gaze, drawn on the cursor layer (docs/GAZE.md): a soft dot where eye
 * serve thinks you're looking, a faint ring the size of its error radius (so
 * you can see how sure it is), a fill that grows while you hold a fixation,
 * and an outline around the thing desktop gaze resolved it to. Paint + motion
 * only: it reads nothing but the points it's handed.
 */
import type { ScreenRect } from "@eigenwife/protocol";

export interface GazeSample {
  x: number;
  y: number;
  valid: boolean;
  /** Current fixation age (ms), null between fixations. */
  fixMs: number | null;
  /** Error radius in screen points. */
  radius: number;
  t: number;
  /** Why the sample was rejected (eye serve's reason / guidance), for the status pill. */
  reason?: string | null;
  guidance?: string | null;
}

export interface GazeTargetBox {
  rect: ScreenRect;
  label: string;
  at: number;
}

const FOLLOW = 18; // 1/s: exponential follow toward the sample (on top of eye serve's own smoothing)
const FADE_IN = 6;
const FADE_OUT = 3;
const STALE_MS = 400;
const BOX_MS = 2500;

export class GazeDot {
  private p: { x: number; y: number } | null = null;
  private target: GazeSample | null = null;
  private alpha = 0;
  private fix = 0;
  private radius = 120;
  private last = 0;
  private box: GazeTargetBox | null = null;
  private boxAlpha = 0;
  /** Rejected since: the pill only shows after a second of not tracking. */
  private badSince: number | null = null;
  private pill = "";
  private pillAlpha = 0;

  feed(s: GazeSample) {
    if (!Number.isFinite(s.radius) || s.radius <= 0) s.radius = this.radius;
    this.target = s;
    if (s.valid && !this.p) this.p = { x: s.x, y: s.y };
  }

  feedTarget(b: GazeTargetBox | null) {
    this.box = b;
  }

  /** Advance and report whether anything is still visible/moving. */
  step(now: number): boolean {
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const s = this.target;
    const live = !!s && s.valid && now - s.t < STALE_MS;
    if (live && this.p) {
      const k = 1 - Math.exp(-FOLLOW * dt);
      this.p.x += (s!.x - this.p.x) * k;
      this.p.y += (s!.y - this.p.y) * k;
      this.radius += (s!.radius - this.radius) * (1 - Math.exp(-4 * dt));
    }
    this.alpha += ((live ? 1 : 0) - this.alpha) * (1 - Math.exp(-(live ? FADE_IN : FADE_OUT) * dt));
    const fixT = live && s!.fixMs !== null ? Math.min(1, s!.fixMs / 4000) : 0;
    this.fix += (fixT - this.fix) * (1 - Math.exp(-8 * dt));
    const boxLive = !!this.box && Date.now() - this.box.at < BOX_MS;
    this.boxAlpha += ((boxLive ? 1 : 0) - this.boxAlpha) * (1 - Math.exp(-6 * dt));
    if (!live && this.alpha < 0.01) this.p = null;
    // Connected but rejected (head out of range, face lost...): say why, gently, after a second.
    const bad = !!s && !s.valid && now - s.t < 2000 && !!(s.reason || s.guidance);
    if (bad) {
      this.badSince ??= now;
      this.pill = pillText(s!.reason, s!.guidance);
    } else this.badSince = null;
    const showPill = bad && now - (this.badSince ?? now) > 1000;
    this.pillAlpha += ((showPill ? 1 : 0) - this.pillAlpha) * (1 - Math.exp(-5 * dt));
    return this.alpha > 0.01 || this.boxAlpha > 0.01 || this.pillAlpha > 0.01 || bad;
  }

  draw(g: CanvasRenderingContext2D, display: ScreenRect, hue: number) {
    const hsl = (h: number, s: number, l: number, a: number) => `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;
    const gh = hue + 160; // your color: opposite hers on the wheel, so the two never blur together
    if (this.box && this.boxAlpha > 0.01) {
      const r = this.box.rect;
      const x = r.x - display.x;
      const y = r.y - display.y;
      if (x + r.width > 0 && y + r.height > 0 && x < display.width && y < display.height) {
        g.save();
        g.strokeStyle = hsl(gh, 90, 66, 0.55 * this.boxAlpha);
        g.lineWidth = 1.5;
        g.setLineDash([6, 5]);
        roundRect(g, x - 3, y - 3, r.width + 6, r.height + 6, 8);
        g.stroke();
        g.setLineDash([]);
        if (this.box.label) {
          g.font = "600 11px -apple-system, system-ui, sans-serif";
          const text = this.box.label.length > 48 ? this.box.label.slice(0, 47) + "…" : this.box.label;
          const w = g.measureText(text).width + 12;
          const ty = y - 3 - 20 < 0 ? y + r.height + 6 : y - 3 - 20;
          g.fillStyle = hsl(gh, 60, 18, 0.72 * this.boxAlpha);
          roundRect(g, x - 3, ty, w, 18, 6);
          g.fill();
          g.fillStyle = hsl(gh, 90, 88, 0.95 * this.boxAlpha);
          g.fillText(text, x + 3, ty + 13);
        }
        g.restore();
      }
    }
    // Status pill, top-center of the main display (under the camera).
    if (this.pillAlpha > 0.01 && this.pill && display.x === 0 && display.y === 0) {
      g.save();
      g.font = "600 12px -apple-system, system-ui, sans-serif";
      const text = `👁 ${this.pill}`;
      const w = g.measureText(text).width + 22;
      const x = display.width / 2 - w / 2;
      const y = 40;
      g.fillStyle = `rgba(20, 20, 28, ${0.72 * this.pillAlpha})`;
      roundRect(g, x, y, w, 24, 12);
      g.fill();
      g.fillStyle = hsl(gh, 80, 86, 0.95 * this.pillAlpha);
      g.fillText(text, x + 11, y + 16);
      g.restore();
    }
    if (!this.p || this.alpha < 0.01) return;
    const cx = this.p.x - display.x;
    const cy = this.p.y - display.y;
    if (cx < -this.radius || cy < -this.radius || cx > display.width + this.radius || cy > display.height + this.radius) return;
    const a = this.alpha;
    g.save();
    // Error circle: how far off it could be.
    g.fillStyle = hsl(gh, 90, 70, 0.05 * a);
    g.strokeStyle = hsl(gh, 90, 70, 0.22 * a);
    g.lineWidth = 1;
    g.beginPath();
    g.arc(cx, cy, this.radius, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    // Fixation: an arc that fills as you hold (full at 4s, when she notices).
    if (this.fix > 0.02) {
      g.strokeStyle = hsl(gh, 95, 72, 0.8 * a);
      g.lineWidth = 3;
      g.lineCap = "round";
      g.beginPath();
      g.arc(cx, cy, 16, -Math.PI / 2, -Math.PI / 2 + this.fix * Math.PI * 2);
      g.stroke();
    }
    // The dot.
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, 10);
    grad.addColorStop(0, hsl(gh, 95, 82, 0.95 * a));
    grad.addColorStop(0.55, hsl(gh, 95, 68, 0.6 * a));
    grad.addColorStop(1, hsl(gh, 95, 60, 0));
    g.fillStyle = grad;
    g.beginPath();
    g.arc(cx, cy, 10, 0, Math.PI * 2);
    g.fill();
    g.restore();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** eye serve's reason/guidance -> a few friendly words. */
export function pillText(reason?: string | null, guidance?: string | null): string {
  const r = reason ?? "";
  const gd = guidance ?? "";
  if (/face_lost|face lost/.test(r)) return "can't see your face";
  if (/outside_display/.test(r)) return "looking off screen";
  if (/head_pose|pose/.test(r) || /calibration/.test(gd)) {
    const m = gd.match(/(vertical_position|horizontal_position|distance|roll|yaw|pitch)[^(;]*?(-?\d+(?:\.\d+)?)\s*;\s*calibrated range\s*(-?\d+(?:\.\d+)?)\s*to\s*(-?\d+(?:\.\d+)?)/);
    if (m) {
      const [, axis, v, lo, hi] = m;
      const val = Number(v);
      const below = val < Number(lo);
      const hint: Record<string, [string, string]> = {
        vertical_position: ["sit a little higher", "sit a little lower"],
        horizontal_position: ["move a little right", "move a little left"],
        distance: ["lean in a little", "sit back a little"],
        roll: ["tilt your head the other way", "straighten your head"],
        yaw: ["turn toward the screen", "turn toward the screen"],
        pitch: ["tilt your chin up a bit", "tilt your chin down a bit"],
      };
      const pair = hint[axis!];
      if (pair) return `${below ? pair[0] : pair[1]} (where you calibrated)`;
    }
    return "sit like you did when you calibrated";
  }
  return r.replace(/_/g, " ").slice(0, 60) || "not tracking";
}
