/**
 * Mouth envelope from audio loudness. PLAYBOOK section 6:
 * mouth = min(0.7, rms^0.7 * gain), ~120ms lerp, then after speech ends a
 * 200ms release and a 500ms hard hold at 0 (idle motions otherwise reopen it).
 */

export const LIPSYNC = { cap: 0.7, exponent: 0.7, gain: 4.2, lerpMs: 120, releaseMs: 200, holdMs: 500, gate: 0.012 };

export function mouthTarget(rms: number, gain = LIPSYNC.gain): number {
  if (rms <= LIPSYNC.gate) return 0;
  return Math.min(LIPSYNC.cap, Math.pow(rms, LIPSYNC.exponent) * gain);
}

export class LipsyncEnvelope {
  value = 0;
  private endedAt = -1;
  private releaseFrom = 0;

  constructor(private gain = LIPSYNC.gain) {}

  /**
   * speaking: audio is playing and rms is live. When it flips false the
   * release + hold kicks in. Returns the mouth value to write this frame.
   */
  update(rms: number, speaking: boolean, dtMs: number, now: number): number {
    if (speaking) {
      this.endedAt = -1;
      const target = mouthTarget(rms, this.gain);
      // "120ms lerp": exponential smoothing reaching ~95% in 120ms.
      const a = 1 - Math.exp(-(3 * dtMs) / LIPSYNC.lerpMs);
      this.value += (target - this.value) * a;
      return this.value;
    }
    if (this.endedAt < 0) {
      this.endedAt = now;
      this.releaseFrom = this.value;
    }
    const t = now - this.endedAt;
    if (t < LIPSYNC.releaseMs) this.value = this.releaseFrom * (1 - t / LIPSYNC.releaseMs);
    else this.value = 0;
    return this.value;
  }

  /** Set the value directly while speaking from a non-audio source (speechSynthesis). */
  drive(v: number) {
    this.endedAt = -1;
    this.value = v;
  }

  /** True while the post-speech 0 hold is in force (release + 500ms). */
  holding(now: number): boolean {
    return this.endedAt >= 0 && now - this.endedAt < LIPSYNC.releaseMs + LIPSYNC.holdMs;
  }
}

/** speechSynthesis can't be tapped: 0.15 + 0.55 * |sin(18t)| * noise. */
export function fakeMouth(nowMs: number): number {
  const t = nowMs / 1000;
  const noise = 0.6 + 0.4 * (0.5 + 0.5 * Math.sin(t * 7.3) * Math.sin(t * 3.1 + 1));
  return Math.min(LIPSYNC.cap, 0.15 + 0.55 * Math.abs(Math.sin(18 * t)) * noise);
}

/** RMS of a time-domain byte buffer from AnalyserNode.getByteTimeDomainData. */
export function rmsOfBytes(buf: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) {
    const s = (buf[i]! - 128) / 128;
    sum += s * s;
  }
  return buf.length ? Math.sqrt(sum / buf.length) : 0;
}
