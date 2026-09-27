import { LIVE_FRAME, LIVE_RATE } from "@eigenwife/protocol";
import { Resampler } from "../voice/pcm";

/**
 * Audio plumbing for Eve Live over the AI Gateway WebSocket: the mic goes up
 * as base64 PCM16 24kHz mono in 20ms frames, her voice comes down the same
 * way. (OpenAI WebRTC needs none of this: media tracks carry the audio.)
 */

export const LIVE_WORKLET = "eve-live-pcm24";

/** AudioWorklet source: resample channel 0 to 24kHz, post 20ms Int16 frames. Reuses the ears' Resampler verbatim. */
export function liveWorkletSource(): string {
  return `const R = (${Resampler.toString()});
class EveLivePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.r = new R(sampleRate, ${LIVE_RATE}, ${LIVE_FRAME});
    this.on = true;
    this.port.onmessage = (e) => { if (e.data && e.data.type === "mute") this.on = !e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) for (const f of this.r.push(ch)) { if (!this.on) f.fill(0); this.port.postMessage(f.buffer, [f.buffer]); }
    return true;
  }
}
registerProcessor(${JSON.stringify(LIVE_WORKLET)}, EveLivePcm);`;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode(...bytes.subarray(i, i + CH));
  return btoa(s);
}

export function base64ToBytes(b64: string): Uint8Array {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** PCM16 little-endian bytes -> Float32 samples in -1..1. A trailing odd byte is dropped. */
export function pcm16ToFloat(bytes: Uint8Array): Float32Array<ArrayBuffer> {
  const n = bytes.length >> 1;
  const out = new Float32Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true) / 0x8000;
  return out;
}

/** RMS of Float32 samples, 0..1. */
export function rmsFloat(f: Float32Array): number {
  if (!f.length) return 0;
  let s = 0;
  for (let i = 0; i < f.length; i++) s += f[i]! * f[i]!;
  return Math.sqrt(s / f.length);
}

/**
 * Gapless playback clock for streamed chunks: each chunk starts where the
 * last one ends, or a hair after "now" when the queue ran dry (a 40ms
 * cushion absorbs network jitter without audible delay).
 */
export class PlayClock {
  private end = 0;
  constructor(private cushion = 0.04) {}
  /** When to start a chunk of `duration` seconds, given the context time now. */
  schedule(now: number, duration: number): number {
    const start = Math.max(now + (this.end > now ? 0 : this.cushion), this.end);
    this.end = start + duration;
    return start;
  }
  /** Seconds of audio still queued ahead of now. */
  ahead(now: number): number {
    return Math.max(0, this.end - now);
  }
  reset() {
    this.end = 0;
  }
}

/**
 * Local voice activity for waking an idle-closed session: RMS over a
 * threshold for `holdMs` of frames. Keeps the last `keepMs` of frames so his
 * first words survive the reconnect.
 */
export class WakeDetector {
  private loudMs = 0;
  private ring: Int16Array[] = [];
  constructor(
    private threshold = 0.02,
    private holdMs = 160,
    private keepMs = 1500,
    private frameMs = 20,
  ) {}
  /** Feed a 20ms frame; true on the frame that crosses into "he's talking". */
  push(frame: Int16Array): boolean {
    this.ring.push(frame);
    while (this.ring.length * this.frameMs > this.keepMs) this.ring.shift();
    let s = 0;
    for (let i = 0; i < frame.length; i++) {
      const v = frame[i]! / 0x8000;
      s += v * v;
    }
    const rms = frame.length ? Math.sqrt(s / frame.length) : 0;
    const was = this.loudMs >= this.holdMs;
    this.loudMs = rms >= this.threshold ? this.loudMs + this.frameMs : Math.max(0, this.loudMs - this.frameMs * 2);
    return !was && this.loudMs >= this.holdMs;
  }
  /** Buffered frames (oldest first), cleared. */
  take(): Int16Array[] {
    const out = this.ring;
    this.ring = [];
    this.loudMs = 0;
    return out;
  }
}
