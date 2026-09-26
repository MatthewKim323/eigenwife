/**
 * Act I auto-advance. Profiles move on by themselves; gaze never clicks.
 *
 *   away:   gaze has been off the card for awayMs (lost interest)
 *   budget: the card has been up for budgetMs
 *   operator: ArrowRight (handled by the caller)
 *
 * minMs keeps a card from flicking past before anyone could look at it.
 */

export interface AdvanceConfig {
  budgetMs: number;
  awayMs: number;
  minMs: number;
}

export const DEFAULT_ADVANCE: AdvanceConfig = { budgetMs: 7000, awayMs: 1500, minMs: 1800 };

export type AdvanceReason = "away" | "budget" | "operator";

export interface AdvanceInput {
  now: number;
  shownAt: number;
  /** Last time the gaze point was on the card, or null if it never was. */
  lastOnCardAt: number | null;
}

export function advanceReason(input: AdvanceInput, cfg: AdvanceConfig = DEFAULT_ADVANCE): AdvanceReason | null {
  const up = input.now - input.shownAt;
  if (up >= cfg.budgetMs) return "budget";
  if (up < cfg.minMs) return null;
  const lastOn = input.lastOnCardAt ?? input.shownAt;
  if (input.now - lastOn >= cfg.awayMs) return "away";
  return null;
}

/** Is a viewport point on (or within margin px of) a rect? */
export function pointInRect(
  p: { x: number; y: number } | null,
  r: { left: number; top: number; right: number; bottom: number },
  margin = 24,
): boolean {
  if (!p) return false;
  return p.x >= r.left - margin && p.x <= r.right + margin && p.y >= r.top - margin && p.y <= r.bottom + margin;
}
