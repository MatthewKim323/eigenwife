import type { Focus } from "./rig";

/**
 * Shared attention. By default Eve looks at the user (webcam, top-center).
 * When the user's gaze target changes she glances at the same thing for
 * ~800ms, then comes back. avatar.look does the same on request.
 */

export const GLANCE = { ms: 800, minGapMs: 1100 };

export type LookAt = { kind: "user" } | { kind: "point"; x: number; y: number };

export class AttentionController {
  private glance: { x: number; y: number; until: number } | null = null;
  private sustained: { x: number; y: number } | null = null;
  private cursor: { x: number; y: number } | null = null;
  private lastGlanceAt = -Infinity;
  private lastKey: string | null = null;

  /** User gaze moved to a new element. Returns true if she glanced. */
  onUserTarget(key: string, point: { x: number; y: number } | null, now: number): boolean {
    if (key === this.lastKey) return false;
    this.lastKey = key;
    if (!point || now - this.lastGlanceAt < GLANCE.minGapMs) return false;
    this.look(point, GLANCE.ms, now);
    return true;
  }

  /** Explicit look (avatar.look). ms <= 0 falls back to a normal glance. */
  look(point: { x: number; y: number } | null, ms: number, now: number) {
    if (!point) {
      this.glance = null;
      return;
    }
    this.glance = { ...point, until: now + (ms > 0 ? ms : GLANCE.ms) };
    this.lastGlanceAt = now;
  }

  /** Hold her eyes on a point until cleared (e.g. watching the swarm while acting). */
  hold(point: { x: number; y: number } | null) {
    this.sustained = point;
  }

  /** Soft cursor follow (touch.ts CursorWatch): lowest priority, below glances and holds. */
  follow(point: { x: number; y: number } | null) {
    this.cursor = point;
  }

  current(now: number): LookAt {
    if (this.glance && now < this.glance.until) return { kind: "point", x: this.glance.x, y: this.glance.y };
    this.glance = null;
    if (this.sustained) return { kind: "point", ...this.sustained };
    if (this.cursor) return { kind: "point", ...this.cursor };
    return { kind: "user" };
  }
}

/**
 * Map a screen point into focus space relative to her head position.
 * Horizontal: half a viewport away = full turn. Vertical: up is positive.
 */
export function screenToFocus(p: { x: number; y: number }, head: { x: number; y: number }, vw: number, vh: number): Focus {
  const x = (p.x - head.x) / (vw * 0.5);
  const y = (head.y - p.y) / (vh * 0.5);
  return { x: Math.max(-1, Math.min(1, x)), y: Math.max(-1, Math.min(1, y)) };
}

/**
 * Looking at the user = looking out of the screen toward the webcam
 * (top-center). A 2D character reads best facing mostly forward with a lean
 * toward screen center and a slight upward tilt.
 */
export function userFocus(head: { x: number; y: number }, vw: number): Focus {
  const x = ((vw / 2 - head.x) / (vw / 2)) * 0.35;
  return { x: Math.max(-0.5, Math.min(0.5, x)), y: 0.12 };
}
