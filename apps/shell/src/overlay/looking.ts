/**
 * The "👀 looking" chip on Eve (docs/SCREEN.md). A guardrail, not decoration:
 * it is visible whenever she reads the screen. Level 2 (accessibility text)
 * is a brief flash; level 3 (a window capture for vision) holds for as long
 * as the look runs, and lingers a moment after. Pure: events in, chip out.
 */

export const LOOK_FLASH_MS = 1400;
export const LOOK_LINGER_MS = 800;

export interface LookState {
  level: 2 | 3 | null;
  /** Hide after this time (Infinity while a level 3 look is running). */
  until: number;
}

export const NO_LOOK: LookState = { level: null, until: 0 };

export function nextLook(s: LookState, e: { level: 2 | 3; active: boolean }, now: number): LookState {
  if (e.level === 3) return e.active ? { level: 3, until: Infinity } : { level: 3, until: now + LOOK_LINGER_MS };
  if (!e.active) return s;
  // A running capture outranks a text read.
  if (s.level === 3 && s.until > now) return s;
  return { level: 2, until: now + LOOK_FLASH_MS };
}

export function lookChip(s: LookState, now: number): { kind: "read" | "vision"; text: string; sub?: string } | null {
  if (!s.level || s.until <= now) return null;
  return s.level === 3 ? { kind: "vision", text: "👀 looking", sub: "at this window" } : { kind: "read", text: "👀 looking" };
}
