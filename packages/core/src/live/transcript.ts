/**
 * GPT-Live transcript deltas have no turn boundaries: fragments with
 * start_ms/end_ms arrive while either side talks, sometimes both at once. A
 * Side stitches one speaker's fragments into lines: it opens on the first
 * fragment, grows with each one, and closes after `gapMs` of no new text (or
 * when the caller flushes it, e.g. the model started answering).
 */

export type Schedule = (fn: () => void, ms: number) => () => void;

export const realSchedule: Schedule = (fn, ms) => {
  const t = setTimeout(fn, ms);
  (t as { unref?: () => void }).unref?.();
  return () => clearTimeout(t);
};

export interface SideHooks {
  start(): void;
  grow(text: string): void;
  end(text: string, reason: "gap" | "flush"): void;
}

export class Side {
  private text = "";
  private open = false;
  private cancel: (() => void) | null = null;
  lastAt = 0;

  constructor(
    private hooks: SideHooks,
    private gapMs: number,
    private schedule: Schedule = realSchedule,
    private now: () => number = Date.now,
  ) {}

  get active(): boolean {
    return this.open;
  }

  get current(): string {
    return this.text.replace(/\s+/g, " ").trim();
  }

  push(delta: string) {
    if (typeof delta !== "string" || !delta) return;
    this.lastAt = this.now();
    if (!this.open) {
      this.open = true;
      this.text = "";
      this.hooks.start();
    }
    // Deltas carry their own leading spaces: append exactly as received.
    this.text += delta;
    this.hooks.grow(this.current);
    this.cancel?.();
    this.cancel = this.schedule(() => this.close("gap"), this.gapMs);
  }

  /** Close the line now (if open). */
  flush() {
    this.close("flush");
  }

  private close(reason: "gap" | "flush") {
    this.cancel?.();
    this.cancel = null;
    if (!this.open) return;
    this.open = false;
    const text = this.current;
    this.text = "";
    this.hooks.end(text, reason);
  }

  dispose() {
    this.cancel?.();
    this.cancel = null;
    this.open = false;
    this.text = "";
  }
}

/** "mhm", "yeah", "okay": the model backchanneling while he talks. Not a turn of hers. */
export function isBackchannel(text: string): boolean {
  return /^(?:m+h?m+|mm+|uh[- ]?huh|yeah|yep|ok(?:ay)?|right|sure|oh|ah|hm+|haha|ha)[.!,?\s]*$/i.test(text.trim());
}
