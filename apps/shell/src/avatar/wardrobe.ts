import { applyWear } from "@eigenwife/protocol";
import type { ModelDef, Pose, WardrobeEntry } from "./models";
import { clamp, easeInOutCubic } from "./motion-math";

/**
 * The wardrobe layer: outfit toggles (a hoodie, sunglasses) that persist until
 * someone takes them off, plus short accents (a blush on a head pat). Applied
 * every frame right after the mood poses, so:
 *
 * - moods never clear an outfit (the outfit is its own state, not a mood);
 * - idle / faceRest pinning never touches it (it runs after both);
 * - while a slot is worn, the wardrobe owns that slot's parameters: whatever
 *   the mood pose did to them is faded out by the slot's weight. That's the
 *   sunglasses rule: Alexia's smug mood flashes sunglasses (dyj) when she has
 *   none on, but with sunglasses (or pushed-up sunglasses) worn, smug can't
 *   add or remove a second pair. When smug fades, a worn pair stays.
 *
 * Pure: the rig hands in get/set and a clock.
 */

export const WARDROBE_FADE_MS = 250;
/** Accents ease in/out a little slower so they read as a feeling, not a switch. */
export const ACCENT_FADE_MS = 300;

interface Tween {
  from: number;
  to: number;
  t0: number;
  /** Accent: drop back to 0 at this time. */
  until?: number;
}

/** Eased 0..1 weights per id. Outfits hold, accents auto-return. */
export class ToggleWeights {
  private tw = new Map<string, Tween>();
  constructor(private fadeMs = WARDROBE_FADE_MS) {}

  private at(t: Tween | undefined, now: number): number {
    if (!t) return 0;
    return t.from + (t.to - t.from) * easeInOutCubic((now - t.t0) / this.fadeMs);
  }

  private go(id: string, to: number, now: number, until?: number) {
    const cur = this.at(this.tw.get(id), now);
    this.tw.set(id, { from: cur, to, t0: now, until });
  }

  /** Exactly these ids on, everything else fades off. */
  set(ids: Iterable<string>, now: number) {
    const on = new Set(ids);
    this.expire(now);
    for (const id of new Set([...this.tw.keys(), ...on])) {
      const t = this.tw.get(id);
      const to = on.has(id) ? 1 : 0;
      if (t && t.to === to && t.until === undefined) continue;
      this.go(id, to, now);
    }
  }

  /** On now, back off after holdMs. */
  pulse(id: string, now: number, holdMs: number) {
    this.go(id, 1, now, now + holdMs);
  }

  private expire(now: number) {
    for (const [id, t] of this.tw) if (t.until !== undefined && now >= t.until) this.go(id, 0, t.until);
  }

  /** ids currently switched on (target 1). */
  targets(): string[] {
    return [...this.tw].filter(([, t]) => t.to === 1).map(([id]) => id);
  }

  weights(now: number): Record<string, number> {
    this.expire(now);
    const out: Record<string, number> = {};
    for (const [id, t] of this.tw) {
      const w = clamp(this.at(t, now), 0, 1);
      if (w > 0.001) out[id] = w;
      else if (t.to === 0 && now - t.t0 >= this.fadeMs) this.tw.delete(id);
    }
    return out;
  }
}

/** Keep only ids this model can show, with slot exclusivity (the last one wins). */
export function outfitFor(wardrobe: Record<string, WardrobeEntry>, items: string[]): string[] {
  const catalog = Object.fromEntries(Object.entries(wardrobe).map(([id, e]) => [id, { id, ...e }]));
  return applyWear([], { add: items }, catalog);
}

/** Parameter ids each slot owns: the union of its items' pose params. */
export function slotParams(wardrobe: Record<string, WardrobeEntry>, poses: Record<string, Pose>): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const [id, e] of Object.entries(wardrobe)) {
    const s = (out[e.slot] ??= new Set());
    for (const p of Object.keys(poses[id] ?? {})) s.add(p);
  }
  return out;
}

/** Add one toggle pose at weight w (exp3 semantics: Add, Multiply, Overwrite). */
export function applyToggle(pose: Pose, w: number, get: (id: string) => number, set: (id: string, v: number) => void) {
  for (const [id, e] of Object.entries(pose)) {
    const cur = get(id);
    const op = e.op ?? "abs";
    set(id, op === "add" ? cur + e.v * w : op === "mul" ? cur * (1 + (e.v - 1) * w) : cur + (e.v - cur) * w);
  }
}

/**
 * The per-frame wardrobe stage. `before` holds the owned params' values from
 * before the mood poses ran (see snapshot()).
 */
export function applyWardrobe(
  wardrobe: Record<string, WardrobeEntry>,
  poses: Record<string, Pose>,
  owned: Record<string, Set<string>>,
  weights: Record<string, number>,
  before: Map<string, number>,
  get: (id: string) => number,
  set: (id: string, v: number) => void,
) {
  // Slot weight = how much of the slot is worn right now (crossfades sum to ~1).
  const slotW: Record<string, number> = {};
  for (const [id, w] of Object.entries(weights)) {
    const e = wardrobe[id];
    if (e) slotW[e.slot] = Math.min(1, (slotW[e.slot] ?? 0) + w);
  }
  // Take back the worn slots' params from the mood layer.
  for (const [slot, w] of Object.entries(slotW)) {
    for (const p of owned[slot] ?? []) {
      const b = before.get(p);
      if (b !== undefined) set(p, get(p) + (b - get(p)) * w);
    }
  }
  for (const [id, w] of Object.entries(weights)) if (wardrobe[id] && poses[id]) applyToggle(poses[id]!, w, get, set);
}

/** Values of every owned param, taken before the mood poses. */
export function snapshot(owned: Record<string, Set<string>>, get: (id: string) => number): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of Object.values(owned)) for (const p of s) if (!m.has(p)) m.set(p, get(p));
  return m;
}

/** Everything the rig needs about one model's wardrobe, precomputed once per model. */
export class WardrobeLayer {
  readonly outfit = new ToggleWeights(WARDROBE_FADE_MS);
  readonly accents = new ToggleWeights(ACCENT_FADE_MS);
  private wardrobe: Record<string, WardrobeEntry> = {};
  private poses: Record<string, Pose> = {};
  private accentPoses: Record<string, Pose> = {};
  private owned: Record<string, Set<string>> = {};
  /** Requested items (kept across a model switch, filtered per model). */
  private wanted: string[] = [];

  setModel(def: Pick<ModelDef, "wardrobe" | "accents">, poses: Record<string, Pose>, accentPoses: Record<string, Pose>, now: number) {
    this.wardrobe = def.wardrobe ?? {};
    this.poses = poses;
    this.accentPoses = accentPoses;
    this.owned = slotParams(this.wardrobe, poses);
    this.set(this.wanted, now);
  }

  /** What she has on (ids outside this model's wardrobe are ignored: Haru wears nothing extra). */
  set(items: string[], now: number) {
    this.wanted = [...items];
    this.outfit.set(outfitFor(this.wardrobe, items), now);
  }

  wearing(): string[] {
    return this.outfit.targets();
  }

  /** A transient flourish (e.g. "blush"). No-op when the model has no such accent. */
  accent(name: string, now: number, holdMs: number) {
    if (this.accentPoses[name]) this.accents.pulse(name, now, holdMs);
  }

  /** Call before the mood poses. */
  before(get: (id: string) => number): Map<string, number> | null {
    return Object.keys(this.owned).length ? snapshot(this.owned, get) : null;
  }

  /** Call after the mood poses. */
  apply(before: Map<string, number> | null, now: number, get: (id: string) => number, set: (id: string, v: number) => void) {
    if (before) applyWardrobe(this.wardrobe, this.poses, this.owned, this.outfit.weights(now), before, get, set);
    for (const [name, w] of Object.entries(this.accents.weights(now))) if (this.accentPoses[name]) applyToggle(this.accentPoses[name]!, w, get, set);
  }
}
