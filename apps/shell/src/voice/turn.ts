/**
 * Turn-taking logic for speech recognition, kept pure for tests.
 * PLAYBOOK section 7: commit the turn when the interim text has been
 * unchanged for 650ms. Don't wait 1.2s for silence.
 */

export const TURN = { stableMs: 650, bargeInWords: 3, echoTailMs: 600 };

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * Half-duplex gate. While Eve talks (or right after, while her audio may still
 * be echoing), only accept speech with 3+ words: that's a barge-in.
 */
export function acceptWhileSpeaking(text: string, eveSpeaking: boolean, msSinceEveStopped: number): "accept" | "ignore" | "barge-in" {
  const busy = eveSpeaking || msSinceEveStopped < TURN.echoTailMs;
  if (!busy) return "accept";
  return wordCount(text) >= TURN.bargeInWords ? "barge-in" : "ignore";
}

/**
 * Feed it interim text as it arrives; call tick() on a timer. It commits once
 * the text has not changed for stableMs, or immediately on a final from the
 * engine or on flush() (push-to-talk release).
 */
export class TurnCommitter {
  private text = "";
  private changedAt = 0;
  private committed = "";

  constructor(
    private onCommit: (text: string) => void,
    private stableMs = TURN.stableMs,
  ) {}

  interim(text: string, now: number) {
    const t = text.trim();
    if (t === this.text) return;
    this.text = t;
    this.changedAt = now;
  }

  /** Engine said this chunk is final: commit right away. */
  final(text: string) {
    this.text = text.trim();
    this.commit();
  }

  tick(now: number) {
    if (this.text && now - this.changedAt >= this.stableMs) this.commit();
  }

  flush() {
    if (this.text) this.commit();
  }

  reset() {
    this.text = "";
  }

  get current() {
    return this.text;
  }

  private commit() {
    const t = this.text;
    this.text = "";
    if (!t || t === this.committed) return;
    this.committed = t;
    this.onCommit(t);
    // Allow saying the same thing twice in a row later.
    setTimeoutSafe(() => {
      if (this.committed === t) this.committed = "";
    }, 3000);
  }
}

function setTimeoutSafe(fn: () => void, ms: number) {
  try {
    setTimeout(fn, ms);
  } catch {}
}
