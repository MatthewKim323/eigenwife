import type { EventMap, SpeechMark } from "@eigenwife/protocol";

export type Segment = EventMap["speech.segment"];

interface Utterance {
  id: string;
  /** Next seq to play. Seqs start at 0 (protocol contract). */
  expect: number | null;
  pending: Map<number, Segment>;
  ended: boolean;
  played: number;
  /** When we started waiting on a missing seq while later ones sit ready. */
  gapSince: number | null;
}

/**
 * Strict-order FIFO of speech segments keyed by (utteranceId, seq).
 * Utterances play in arrival order; within one, seqs play in order. A missing
 * seq is skipped once the utterance has ended or after gapMs, so one lost
 * segment can never wedge her mouth open forever. Pure: time is passed in.
 */
export class SegmentQueue {
  private utterances: Utterance[] = [];
  private dead = new Set<string>();
  constructor(
    private gapMs = 1500,
    private firstGapMs = 400,
  ) {}

  private get(id: string, create = true): Utterance | undefined {
    let u = this.utterances.find((x) => x.id === id);
    if (!u && create && !this.dead.has(id)) {
      u = { id, expect: 0, pending: new Map(), ended: false, played: 0, gapSince: null };
      this.utterances.push(u);
    }
    return u;
  }

  push(s: Segment) {
    const u = this.get(s.utteranceId);
    if (!u) return;
    if (u.expect !== null && s.seq < u.expect) return; // late duplicate
    u.pending.set(s.seq, s);
  }

  begin(utteranceId: string) {
    this.get(utteranceId);
  }

  end(utteranceId: string) {
    const u = this.get(utteranceId, false);
    if (u) u.ended = true;
  }

  /** Next segment ready to play, removing it from the queue. */
  next(now: number): Segment | null {
    while (this.utterances.length) {
      const u = this.utterances[0]!;
      if (u.expect !== null && u.pending.has(u.expect)) {
        const s = u.pending.get(u.expect)!;
        u.pending.delete(u.expect);
        u.expect++;
        u.played++;
        u.gapSince = null;
        return s;
      }
      if (u.pending.size) {
        // A later seq is waiting on a missing one.
        const lowest = Math.min(...u.pending.keys());
        if (u.gapSince === null) u.gapSince = now;
        // Nothing played yet: seq 0 is probably just in flight, but don't hold her mouth for long.
        const wait = u.played === 0 ? this.firstGapMs : this.gapMs;
        if (u.ended || now - u.gapSince >= wait) {
          u.expect = lowest;
          continue;
        }
        return null;
      }
      if (u.ended) {
        this.utterances.shift();
        this.dead.add(u.id);
        continue;
      }
      return null; // waiting for more of the head utterance
    }
    return null;
  }

  /** Utterance ended and has been fully drained (or aborted). */
  finished(utteranceId: string): boolean {
    return this.dead.has(utteranceId);
  }

  /** Drop everything (speech.stop, barge-in). Returns ids that were cut. */
  abort(): string[] {
    const ids = this.utterances.map((u) => u.id);
    for (const id of ids) this.dead.add(id);
    this.utterances = [];
    return ids;
  }

  get size(): number {
    return this.utterances.reduce((n, u) => n + u.pending.size, 0);
  }

  get headId(): string | null {
    return this.utterances[0]?.id ?? null;
  }

  /** Head utterance ended with nothing left to play (after next() drained it). */
  idle(): boolean {
    return this.utterances.length === 0;
  }
}

/** When each mark fires, in ms from segment start: char offset proportional to duration. */
export function markTimes(text: string, marks: SpeechMark[], durationMs: number): { t: number; mark: SpeechMark }[] {
  const len = Math.max(1, text.length);
  return marks
    .map((mark) => ({ t: Math.max(0, Math.min(1, mark.at / len)) * Math.max(0, durationMs), mark }))
    .sort((a, b) => a.t - b.t);
}

/**
 * Marks for a speechSynthesis segment, fired as word boundaries report
 * progress (charIndex). Each mark fires exactly once.
 */
export class MarkCursor {
  private left: SpeechMark[];
  constructor(marks: SpeechMark[]) {
    this.left = [...marks].sort((a, b) => a.at - b.at);
  }
  /** Marks at or before charIndex that haven't fired yet. */
  advance(charIndex: number): SpeechMark[] {
    const out: SpeechMark[] = [];
    while (this.left.length && this.left[0]!.at <= charIndex) out.push(this.left.shift()!);
    return out;
  }
  pending(): SpeechMark[] {
    return [...this.left];
  }
  /** Claim one specific mark (time-based fallback). False if it already fired. */
  take(m: SpeechMark): boolean {
    const i = this.left.indexOf(m);
    if (i < 0) return false;
    this.left.splice(i, 1);
    return true;
  }
  rest(): SpeechMark[] {
    return this.left.splice(0);
  }
}

/** Rough speaking time for text without audio (speechSynthesis), ~14 chars/s. */
export function estimateSpeechMs(text: string): number {
  return Math.max(600, text.length * 70);
}

/** How many graphemes of text to show at playback progress p (0..1). Leads the audio slightly. */
export function revealCount(total: number, p: number): number {
  return Math.min(total, Math.ceil(total * Math.min(1, Math.max(0, p * 1.08))));
}
