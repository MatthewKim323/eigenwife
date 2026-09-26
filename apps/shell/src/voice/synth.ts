/**
 * Browser speechSynthesis as a first-class voice (not an afterthought): most
 * segments arrive without audio until a TTS key is live. It can't be tapped
 * with an AnalyserNode, so the mouth is synthesized from word boundary pulses
 * plus a syllable-rate oscillator, gated by onstart/onend.
 */

export interface VoiceLike {
  name: string;
  lang: string;
  localService?: boolean;
}

/** Soft female English voices, best first. macOS "Premium"/"Enhanced" variants rank above the compact ones. */
export const PREFERRED_VOICES = [
  "Samantha",
  "Google US English",
  "Microsoft Aria",
  "Microsoft Jenny",
  "Microsoft Ava",
  "Ava",
  "Zoe",
  "Allison",
  "Susan",
  "Serena",
  "Karen",
  "Moira",
  "Tessa",
  "Google UK English Female",
  "Victoria",
];

const NOVELTY = /albert|bad news|bahh|bells|boing|bubbles|cellos|good news|jester|organ|superstar|trinoids|whisper|wobble|zarvox|fred|junior|ralph|grandpa|grandma|rocko|shelley|flo|eddy|reed|sandy/i;

export function rankVoice(v: VoiceLike): number {
  if (!/^en/i.test(v.lang) || NOVELTY.test(v.name)) return -1;
  const i = PREFERRED_VOICES.findIndex((p) => v.name.toLowerCase().includes(p.toLowerCase()));
  let score = i >= 0 ? 100 - i * 4 : 10;
  if (/premium|enhanced|natural|neural/i.test(v.name)) score += 30;
  if (/en[-_]US/i.test(v.lang)) score += 3;
  return score;
}

export function bestVoice<T extends VoiceLike>(voices: readonly T[]): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = rankVoice(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore >= 0 ? best : null;
}

export const SYNTH_MOUTH = { cap: 0.7, floor: 0.1, syllableHz: 5.6, pulseTauMs: 170, msPerChar: 62 };

/**
 * Fake lipsync for speechSynthesis. Each word boundary kicks an envelope
 * sized to the word; a ~5.6Hz syllable oscillator opens and closes the jaw
 * inside it. When a voice fires no boundaries (some remote voices don't), it
 * falls back to a steady noisy chatter so she never talks with a still mouth.
 */
export class SynthMouth {
  private speaking = false;
  private startedAt = 0;
  private wordAt = -Infinity;
  private wordMs = 0;
  private sawBoundary = false;

  start(now: number) {
    this.speaking = true;
    this.startedAt = now;
    this.wordAt = -Infinity;
    this.sawBoundary = false;
  }

  end() {
    this.speaking = false;
  }

  /** A word boundary: charLength (or word length) sizes the pulse. */
  word(now: number, chars: number) {
    this.sawBoundary = true;
    this.wordAt = now;
    this.wordMs = Math.max(120, chars * SYNTH_MOUTH.msPerChar);
  }

  value(now: number): number {
    if (!this.speaking) return 0;
    const t = (now - this.startedAt) / 1000;
    const syll = 0.35 + 0.65 * Math.abs(Math.sin(Math.PI * SYNTH_MOUTH.syllableHz * t));
    const noise = 0.75 + 0.25 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1);
    const since = now - this.wordAt;
    let env: number;
    if (this.sawBoundary) {
      // Hold open through the word, then decay into the gap before the next one.
      env = since <= this.wordMs ? 1 : Math.exp(-(since - this.wordMs) / SYNTH_MOUTH.pulseTauMs);
    } else {
      env = 0.85; // no boundary info: steady chatter
    }
    return Math.min(SYNTH_MOUTH.cap, SYNTH_MOUTH.floor * env + 0.6 * env * syll * noise);
  }
}

/** Length of the word starting at charIndex (for voices that omit charLength). */
export function wordLengthAt(text: string, charIndex: number): number {
  const m = /^\S+/.exec(text.slice(charIndex));
  return m ? m[0].length : 1;
}
