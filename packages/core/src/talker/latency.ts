/**
 * End of speech -> first audio, per talker backend. Fed from the bus:
 * voice.final starts the clock, speech.begin tells us which utterance is the
 * talker's, the first speech.segment with audio stops it. Two numbers:
 *   sound  first audio of any kind (a filler "hm." counts)
 *   reply  first audio of her actual reply (the stall line counts, fillers don't)
 * Pure, clock-injected.
 */

export interface LatencySample {
  at: number;
  backend: string;
  soundMs: number | null;
  replyMs: number;
}

export function percentile(xs: number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export class LatencyBook {
  samples: LatencySample[] = [];
  private pending: { t0: number; sound: number | null } | null = null;
  private utts = new Map<string, string>();

  constructor(
    private keep = 200,
    private staleMs = 20_000,
  ) {}

  /** He stopped talking (voice.final). */
  endOfSpeech(at: number) {
    this.pending = { t0: at, sound: null };
  }

  /** An utterance started; backend() resolves lazily (the talker's backend is known after its first word). */
  utterance(id: string, label: string) {
    this.utts.set(id, label);
    if (this.utts.size > 100) this.utts.delete(this.utts.keys().next().value!);
  }

  /** A segment went out. Returns the sample when this closed one. */
  segment(at: number, utteranceId: string, hasAudio: boolean, filler: boolean, backendOf: (label: string) => string | null): LatencySample | null {
    const p = this.pending;
    if (!p || !hasAudio) return null;
    if (at - p.t0 > this.staleMs) {
      this.pending = null;
      return null;
    }
    if (p.sound === null) p.sound = at - p.t0;
    if (filler) return null;
    const label = this.utts.get(utteranceId);
    if (!label) return null;
    const backend = backendOf(label);
    if (!backend) return null;
    const s: LatencySample = { at, backend, soundMs: p.sound, replyMs: at - p.t0 };
    this.pending = null;
    this.samples.push(s);
    if (this.samples.length > this.keep) this.samples.shift();
    return s;
  }

  summary(): Record<string, { n: number; replyP50: number | null; replyP95: number | null; soundP50: number | null; soundP95: number | null }> {
    const by = new Map<string, LatencySample[]>();
    for (const s of this.samples) (by.get(s.backend) ?? by.set(s.backend, []).get(s.backend)!).push(s);
    const out: ReturnType<LatencyBook["summary"]> = {};
    for (const [b, xs] of by) {
      const reply = xs.map((x) => x.replyMs);
      const sound = xs.map((x) => x.soundMs ?? x.replyMs);
      out[b] = { n: xs.length, replyP50: percentile(reply, 50), replyP95: percentile(reply, 95), soundP50: percentile(sound, 50), soundP95: percentile(sound, 95) };
    }
    return out;
  }
}
