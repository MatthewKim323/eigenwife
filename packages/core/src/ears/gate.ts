/**
 * Half-duplex gate, the same rule the shell's browser recognizer uses
 * (apps/shell/src/voice/turn.ts): while Eve talks, or for a short echo tail
 * after she stops, only speech with 3+ words gets through, and it counts as a
 * barge-in. Kept in sync by the shared test vectors in test/ears.test.ts.
 */

export const GATE = { bargeInWords: 3, echoTailMs: 600 };

export function wordCount(text: string): number {
  const t = text.trim();
  return t ? t.split(/\s+/).length : 0;
}

export type Verdict = "accept" | "ignore" | "barge-in";

export function acceptWhileSpeaking(text: string, eveSpeaking: boolean, msSinceEveStopped: number): Verdict {
  const busy = eveSpeaking || msSinceEveStopped < GATE.echoTailMs;
  if (!busy) return "accept";
  return wordCount(text) >= GATE.bargeInWords ? "barge-in" : "ignore";
}

/**
 * Where Eve's voice is. The client (who actually plays the audio) reports it
 * when it can; otherwise we infer it from speech.begin / speech.end on the bus.
 */
export class SpeakingTracker {
  private bus = false;
  private client: boolean | null = null;
  private stoppedAt = -Infinity;

  constructor(private now: () => number = Date.now) {}

  fromBus(speaking: boolean) {
    if (this.bus && !speaking && this.client === null) this.stoppedAt = this.now();
    this.bus = speaking;
  }

  fromClient(speaking: boolean) {
    if (this.client && !speaking) this.stoppedAt = this.now();
    this.client = speaking;
  }

  get speaking(): boolean {
    return this.client ?? this.bus;
  }

  get msSinceStopped(): number {
    return this.now() - this.stoppedAt;
  }
}
