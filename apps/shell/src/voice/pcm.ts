/**
 * Mic -> 16kHz linear16 PCM. The Resampler is self-contained on purpose: its
 * source is stringified into the AudioWorklet (workletSource), so it may not
 * reference anything outside its own body.
 */
export class Resampler {
  ratio: number;
  frame: number;
  t = 0;
  acc = 0;
  n = 0;
  buf: Int16Array;
  fill = 0;

  constructor(inRate: number, outRate = 16000, frame = 320) {
    this.ratio = inRate / outRate;
    this.frame = frame;
    this.buf = new Int16Array(frame);
  }

  /** Box-filter decimation (averages each output period: cheap anti-aliasing for speech). Returns full frames. */
  push(input: Float32Array): Int16Array[] {
    const out: Int16Array[] = [];
    for (let i = 0; i < input.length; i++) {
      this.acc += input[i]!;
      this.n++;
      this.t += 1;
      if (this.t >= this.ratio) {
        this.t -= this.ratio;
        let v = this.acc / this.n;
        this.acc = 0;
        this.n = 0;
        v = v > 1 ? 1 : v < -1 ? -1 : v;
        this.buf[this.fill++] = v < 0 ? Math.round(v * 0x8000) : Math.round(v * 0x7fff);
        if (this.fill === this.frame) {
          out.push(this.buf);
          this.buf = new Int16Array(this.frame);
          this.fill = 0;
        }
      }
    }
    return out;
  }
}

export const WORKLET_NAME = "eve-pcm16";

/** AudioWorklet module source: resample channel 0 and post 20ms Int16 frames. */
export function workletSource(): string {
  return `const R = (${Resampler.toString()});
class EvePcm extends AudioWorkletProcessor {
  constructor() {
    super();
    this.r = new R(sampleRate, 16000, 320);
    this.on = true;
    this.port.onmessage = (e) => { if (e.data && e.data.type === "mute") this.on = !e.data.muted; };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && this.on) for (const f of this.r.push(ch)) this.port.postMessage(f.buffer, [f.buffer]);
    return true;
  }
}
registerProcessor(${JSON.stringify(WORKLET_NAME)}, EvePcm);`;
}

/** RMS of an Int16 frame in 0..1, for the listening lamp. */
export function rms16(f: Int16Array): number {
  if (!f.length) return 0;
  let s = 0;
  for (let i = 0; i < f.length; i++) {
    const v = f[i]! / 0x8000;
    s += v * v;
  }
  return Math.sqrt(s / f.length);
}
