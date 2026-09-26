import type { Mood } from "@eigenwife/protocol";
import { clamp, easeInOutCubic } from "./motion-math";

/**
 * Emotion poses for Hiyori, who ships no expressions. Each pose is a set of
 * parameter overrides. `add` entries are offsets on top of motion + look-at
 * (head angles); the rest pull the parameter toward an absolute value.
 */
export interface PoseEntry {
  v: number;
  add?: boolean;
}
export type Pose = Record<string, PoseEntry>;

const abs = (v: number): PoseEntry => ({ v });
const add = (v: number): PoseEntry => ({ v, add: true });

export const POSES: Record<Mood, Pose> = {
  neutral: {},
  happy: {
    ParamEyeLSmile: abs(1),
    ParamEyeRSmile: abs(1),
    ParamMouthForm: abs(1),
    ParamCheek: abs(1),
    // Hiyori's smile arcs only read once the lids come down a bit.
    ParamEyeLOpen: abs(0.7),
    ParamEyeROpen: abs(0.7),
    ParamMouthOpenY: abs(0.18),
    ParamBrowLY: abs(0.3),
    ParamBrowRY: abs(0.3),
    ParamAngleZ: add(6),
  },
  annoyed: {
    ParamEyeLOpen: abs(0.55),
    ParamEyeROpen: abs(0.55),
    ParamBrowLForm: abs(-1),
    ParamBrowRForm: abs(-1),
    ParamBrowLAngle: abs(-0.6),
    ParamBrowRAngle: abs(-0.6),
    ParamMouthForm: abs(-0.6),
    ParamAngleX: add(15),
    // Head turns away, eyes stay on you.
    ParamEyeBallX: add(-0.45),
  },
  thinking: {
    ParamEyeBallX: abs(0.6),
    ParamEyeBallY: abs(0.7),
    ParamAngleZ: add(8),
    ParamAngleY: add(4),
    ParamMouthForm: abs(-0.2),
    ParamBrowLY: abs(0.2),
    ParamBrowRY: abs(-0.1),
  },
  surprised: {
    ParamEyeLOpen: abs(1.2),
    ParamEyeROpen: abs(1.2),
    ParamBrowLY: abs(1),
    ParamBrowRY: abs(1),
    ParamMouthOpenY: abs(0.4),
    ParamMouthForm: abs(0),
    ParamAngleY: add(5),
  },
  smug: {
    ParamEyeLOpen: abs(0.62),
    ParamEyeROpen: abs(0.62),
    ParamEyeLSmile: abs(0.6),
    ParamEyeRSmile: abs(0.6),
    ParamMouthForm: abs(0.7),
    ParamBrowLY: abs(-0.2),
    ParamBrowRY: abs(0.5),
    ParamAngleZ: add(-7),
    ParamAngleY: add(-4),
  },
  sad: {
    ParamEyeLOpen: abs(0.65),
    ParamEyeROpen: abs(0.65),
    ParamBrowLForm: abs(0.8),
    ParamBrowRForm: abs(0.8),
    ParamBrowLAngle: abs(0.7),
    ParamBrowRAngle: abs(0.7),
    ParamMouthForm: abs(-0.8),
    ParamAngleY: add(-8),
    ParamEyeBallY: abs(-0.4),
  },
};

/** Full weight looks deranged. */
export const WEIGHT_CAP = 0.78;
export const BLEND_MS = 450;
export const AUTO_RETURN_MS = 3000;

interface Tween {
  from: number;
  to: number;
  t0: number;
}

/**
 * Blends mood poses with easing. A transient mood (from marks or avatar.mood)
 * auto-returns after holdMs; a sustained mood (from avatar.state, e.g.
 * "thinking") holds until cleared. Transient wins while it lasts.
 */
export class EmotionBlender {
  private tweens = new Map<Mood, Tween>();
  private transient: { mood: Mood; weight: number; until: number } | null = null;
  private sustained: { mood: Mood; weight: number } | null = null;
  private target: Mood = "neutral";
  private targetWeight = 0;
  /** When the current transient mood began (for bobs and similar one-shots). */
  onsetAt = -Infinity;

  constructor(
    private cap = WEIGHT_CAP,
    private blendMs = BLEND_MS,
  ) {}

  set(mood: Mood, intensity: number, now: number, holdMs = AUTO_RETURN_MS) {
    if (!this.transient || this.transient.mood !== mood) this.onsetAt = now;
    this.transient = { mood, weight: clamp(intensity, 0, 1) * this.cap, until: now + holdMs };
    this.retarget(now);
  }

  sustain(mood: Mood | null, intensity = 1) {
    this.sustained = mood ? { mood, weight: clamp(intensity, 0, 1) * this.cap } : null;
  }

  clear() {
    this.transient = null;
  }

  private retarget(now: number) {
    let mood: Mood = "neutral";
    let w = 0;
    if (this.transient && now < this.transient.until) {
      mood = this.transient.mood;
      w = this.transient.weight;
    } else if (this.sustained) {
      this.transient = null;
      mood = this.sustained.mood;
      w = this.sustained.weight;
    } else {
      this.transient = null;
    }
    if (mood === this.target && w === this.targetWeight) return;
    this.target = mood;
    this.targetWeight = w;
    for (const m of new Set<Mood>([...this.tweens.keys(), mood])) {
      const cur = this.weightOf(m, now);
      const to = m === mood ? w : 0;
      this.tweens.set(m, { from: cur, to, t0: now });
    }
  }

  private weightOf(m: Mood, now: number): number {
    const tw = this.tweens.get(m);
    if (!tw) return 0;
    return tw.from + (tw.to - tw.from) * easeInOutCubic((now - tw.t0) / this.blendMs);
  }

  /** Weights per mood right now, each within [0, cap]. */
  weights(now: number): Partial<Record<Mood, number>> {
    this.retarget(now);
    const out: Partial<Record<Mood, number>> = {};
    for (const m of this.tweens.keys()) {
      const w = clamp(this.weightOf(m, now), 0, this.cap);
      if (w > 0.001) out[m] = w;
      else if (this.tweens.get(m)!.to === 0 && now - this.tweens.get(m)!.t0 >= this.blendMs) this.tweens.delete(m);
    }
    return out;
  }

  dominant(now: number): Mood {
    this.retarget(now);
    return this.targetWeight > 0 ? this.target : "neutral";
  }
}

/**
 * Apply blended poses to parameter values. get() returns the current value
 * (after motion), set() writes. Absolute entries lerp toward the pose value,
 * additive entries add weight * value.
 */
/** The mouth-open value the blended poses ask for (lipsync takes the max of this and the audio). */
export function poseMouth(weights: Partial<Record<Mood, number>>): number {
  let m = 0;
  for (const [mood, w] of Object.entries(weights) as [Mood, number][]) {
    const e = POSES[mood].ParamMouthOpenY;
    if (e) m = Math.max(m, e.v * w);
  }
  return m;
}

export function applyPoses(
  weights: Partial<Record<Mood, number>>,
  get: (id: string) => number,
  set: (id: string, v: number) => void,
) {
  for (const [mood, w] of Object.entries(weights) as [Mood, number][]) {
    for (const [id, e] of Object.entries(POSES[mood])) {
      const cur = get(id);
      set(id, e.add ? cur + e.v * w : cur + (e.v - cur) * w);
    }
  }
}
