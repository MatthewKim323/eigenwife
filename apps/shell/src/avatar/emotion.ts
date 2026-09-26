import type { Mood } from "@eigenwife/protocol";
import type { Pose, PoseEntry, PoseTable } from "./models";
import { clamp, easeInOutCubic } from "./motion-math";

export type { Pose, PoseEntry, PoseTable };

/**
 * Emotion poses are per model (models.ts: the model's own expressions blended
 * with our overrides). This file blends them over time and applies them.
 */

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
 * "thinking") holds until cleared. Transient wins while it lasts. Nothing
 * here ever picks a mood on its own: no event, no expression.
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

/** The mouth-open value the blended poses ask for (lipsync takes the max of this and the audio). */
export function poseMouth(table: PoseTable, weights: Partial<Record<Mood, number>>, mouthId = "ParamMouthOpenY"): number {
  let m = 0;
  for (const [mood, w] of Object.entries(weights) as [Mood, number][]) {
    const e = table[mood]?.[mouthId];
    if (e && (e.op ?? "abs") === "abs") m = Math.max(m, e.v * w);
  }
  return m;
}

/**
 * Apply blended poses to parameter values. get() returns the current value
 * (after motion), set() writes. "abs" lerps toward the pose value, "add" adds
 * weight * value, "mul" scales by 1 + (value - 1) * weight (the SDK's
 * expression Multiply blend, faded by weight).
 */
export function applyPoses(
  table: PoseTable,
  weights: Partial<Record<Mood, number>>,
  get: (id: string) => number,
  set: (id: string, v: number) => void,
) {
  for (const [mood, w] of Object.entries(weights) as [Mood, number][]) {
    const pose = table[mood];
    if (!pose) continue;
    for (const [id, e] of Object.entries(pose)) {
      const cur = get(id);
      const op = e.op ?? "abs";
      set(id, op === "add" ? cur + e.v * w : op === "mul" ? cur * (1 + (e.v - 1) * w) : cur + (e.v - cur) * w);
    }
  }
}
