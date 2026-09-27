import { getAudioContext } from "./audio";
import { rmsOfBytes } from "./lipsync";
import { ChunkBuffer, parseWav, PcmDecoder, concatBytes } from "./stream";

/**
 * How segment audio gets from a URL to her speakers, everything through the
 * one shared AudioContext and one AnalyserNode (lipsync reads it).
 *
 *   cached file   fetch whole -> decodeAudioData -> AudioBufferSourceNode
 *   live mp3      fetch streaming -> MediaSource(audio/mpeg) -> <audio>
 *                 -> createMediaElementSource -> analyser
 *   live wav      fetch streaming -> PCM chunks -> AudioBufferSourceNodes
 *                 scheduled back to back (Deepgram Aura)
 *
 * Preparing starts the download (and the MediaSource) the moment a segment
 * arrives, so the next one is already buffered while the current one plays.
 * A stream that can't start (no MediaSource, play() refused, a decode error)
 * falls back to decoding the whole file once it's in.
 */

export interface Playback {
  /** Start playing; onEnded fires once when the audio is over. */
  start(onEnded: () => void): Promise<void>;
  /** ms of audio played so far. */
  time(): number;
  /** Total ms once known (streams: when fully downloaded and decoded). */
  duration(): number | null;
  stop(): void;
  streamed: boolean;
}

export interface AudioEngine {
  /** Begin fetching now; resolves when playback can start (null: no audio, use speechSynthesis). */
  prepare(url: string, stream: boolean, signal: AbortSignal): Promise<Playback | null>;
  /** Audio output is live (context unlocked). */
  running(): boolean;
  /** RMS of what's playing right now, null when there's no tap. */
  level(): number | null;
}

export class WebAudioEngine implements AudioEngine {
  private analyser: AnalyserNode | null = null;
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array(1024);

  running() {
    return getAudioContext()?.state === "running";
  }

  level(): number | null {
    if (!this.analyser) return null;
    this.analyser.getByteTimeDomainData(this.bytes);
    return rmsOfBytes(this.bytes);
  }

  private out(ctx: AudioContext): AnalyserNode {
    if (!this.analyser) {
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 1024;
      this.analyser.connect(ctx.destination);
      this.bytes = new Uint8Array(this.analyser.fftSize);
    }
    return this.analyser;
  }

  async prepare(url: string, stream: boolean, signal: AbortSignal): Promise<Playback | null> {
    const ctx = getAudioContext();
    const cb = new ChunkBuffer(url, signal);
    try {
      if (!ctx) {
        await cb.all();
        return null;
      }
      const out = this.out(ctx);
      const whole = async () => bufferPlayback(ctx, out, await cb.all());
      if (!stream) return await whole();
      await cb.atLeast(1);
      let inner: Playback | null = null;
      try {
        if (/\.wav(\?|$)/.test(url)) inner = await PcmStream.open(ctx, out, cb);
        else if (MseStream.supported()) inner = await MseStream.open(ctx, out, cb, signal);
      } catch (err) {
        if (!signal.aborted) console.warn("[voice] streaming start failed, decoding the whole segment", err);
      }
      if (signal.aborted) {
        inner?.stop();
        return null;
      }
      return inner ? new Fallback(inner, whole) : await whole();
    } catch (err) {
      if (!signal.aborted) console.warn("[voice] segment audio failed, falling back to speechSynthesis", err);
      return null;
    }
  }
}

async function bufferPlayback(ctx: AudioContext, out: AudioNode, data: ArrayBuffer): Promise<Playback> {
  const buf = await ctx.decodeAudioData(data);
  let src: AudioBufferSourceNode | null = null;
  let t0 = -1;
  return {
    streamed: false,
    duration: () => buf.duration * 1000,
    time: () => (t0 < 0 ? 0 : Math.min(buf.duration, ctx.currentTime - t0) * 1000),
    async start(onEnded) {
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(out);
      src.onended = () => onEnded();
      t0 = ctx.currentTime;
      src.start();
    },
    stop() {
      if (!src) return;
      try {
        src.onended = null;
        src.stop();
        src.disconnect();
      } catch {}
    },
  };
}

/** A stream that turns into a whole-file playback if it refuses to start. */
class Fallback implements Playback {
  streamed = true;
  constructor(
    private cur: Playback,
    private whole: () => Promise<Playback>,
  ) {}
  async start(onEnded: () => void) {
    try {
      await this.cur.start(onEnded);
    } catch (err) {
      console.warn("[voice] stream playback refused, decoding the whole segment", err);
      this.cur.stop();
      this.cur = await this.whole();
      this.streamed = false;
      await this.cur.start(onEnded);
    }
  }
  time() {
    return this.cur.time();
  }
  duration() {
    return this.cur.duration();
  }
  stop() {
    this.cur.stop();
  }
}

/** mp3 over MediaSource into an <audio> tapped by the shared context. */
class MseStream implements Playback {
  streamed = true;
  private node: MediaElementAudioSourceNode | null = null;
  private objectUrl = "";
  private ended = false;

  static supported() {
    return typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg");
  }

  private constructor(
    private el: HTMLAudioElement,
    private cb: ChunkBuffer,
  ) {}

  static async open(ctx: AudioContext, out: AudioNode, cb: ChunkBuffer, signal: AbortSignal): Promise<MseStream> {
    const el = new Audio();
    el.preload = "auto";
    const ms = new MediaSource();
    const s = new MseStream(el, cb);
    s.objectUrl = URL.createObjectURL(ms);
    el.src = s.objectUrl;
    s.node = ctx.createMediaElementSource(el);
    s.node.connect(out);
    await new Promise<void>((resolve, reject) => {
      ms.addEventListener("sourceopen", () => resolve(), { once: true });
      setTimeout(() => reject(new Error("mediasource: sourceopen timeout")), 2000);
    });
    const sb = ms.addSourceBuffer("audio/mpeg");
    const append = (c: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        const ok = () => {
          sb.removeEventListener("error", bad);
          resolve();
        };
        const bad = () => {
          sb.removeEventListener("updateend", ok);
          reject(new Error("mediasource: append failed"));
        };
        sb.addEventListener("updateend", ok, { once: true });
        sb.addEventListener("error", bad, { once: true });
        sb.appendBuffer(c as Uint8Array<ArrayBuffer>);
      });
    const gate: { first: (() => void) | null; fail: ((e: unknown) => void) | null } = { first: null, fail: null };
    const firstAppended = new Promise<void>((r, j) => {
      gate.first = r;
      gate.fail = j;
    });
    // Feed the rest in the background (also before start: this is the pre-connect).
    void (async () => {
      try {
        for await (const c of cb.read()) {
          if (signal.aborted || ms.readyState !== "open") return gate.fail?.(new Error("mediasource: aborted"));
          await append(c);
          gate.first?.();
        }
        if (ms.readyState === "open") ms.endOfStream();
        gate.first?.();
      } catch (err) {
        gate.fail?.(err);
        if (ms.readyState === "open") {
          try {
            ms.endOfStream(cb.bytes ? undefined : "network");
          } catch {}
        }
      }
    })();
    try {
      await firstAppended;
    } catch (err) {
      s.stop();
      throw err;
    }
    return s;
  }

  async start(onEnded: () => void) {
    const end = () => {
      if (this.ended) return;
      this.ended = true;
      onEnded();
    };
    this.el.onended = end;
    await this.el.play();
    // A decode error mid-segment ends it instead of wedging the queue.
    this.el.onerror = end;
  }

  time() {
    return this.el.currentTime * 1000;
  }

  duration() {
    return this.cb.done && Number.isFinite(this.el.duration) ? this.el.duration * 1000 : null;
  }

  stop() {
    this.ended = true;
    this.el.onended = null;
    this.el.onerror = null;
    try {
      this.el.pause();
      this.el.removeAttribute("src");
      this.el.load();
    } catch {}
    try {
      this.node?.disconnect();
    } catch {}
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
  }
}

/** Streaming wav (16-bit PCM) scheduled chunk by chunk, gapless. */
class PcmStream implements Playback {
  streamed = true;
  private sources = new Set<AudioBufferSourceNode>();
  private t0 = -1;
  private next = 0;
  private scheduledMs = 0;
  private stalledMs = 0;
  private stopped = false;
  private onEnded: (() => void) | null = null;
  private pending: Float32Array[][] = [];
  private downloaded = false;
  private totalFrames = 0;

  private constructor(
    private ctx: AudioContext,
    private out: AudioNode,
    private rate: number,
    private channels: number,
  ) {}

  static async open(ctx: AudioContext, out: AudioNode, cb: ChunkBuffer): Promise<PcmStream> {
    await cb.atLeast(44);
    const head = concatBytes(cb.chunks);
    const fmt = parseWav(head);
    if (!fmt || fmt.bits !== 16) throw new Error("wav: not 16-bit pcm");
    const s = new PcmStream(ctx, out, fmt.sampleRate, fmt.channels);
    const dec = new PcmDecoder(fmt.channels);
    let skip = fmt.dataOffset;
    void (async () => {
      try {
        for await (const c of cb.read()) {
          if (s.stopped) return;
          let chunk = c;
          if (skip) {
            const n = Math.min(skip, chunk.byteLength);
            skip -= n;
            chunk = chunk.subarray(n);
          }
          if (chunk.byteLength) s.feed(dec.push(chunk));
        }
      } catch {}
      s.downloaded = true;
      s.maybeEnd();
    })();
    return s;
  }

  private feed(frames: Float32Array[]) {
    if (!frames[0]?.length) return;
    this.totalFrames += frames[0].length;
    if (this.t0 < 0) this.pending.push(frames);
    else this.schedule(frames);
  }

  private schedule(frames: Float32Array[]) {
    const n = frames[0]!.length;
    const buf = this.ctx.createBuffer(this.channels, n, this.rate);
    frames.forEach((f, c) => buf.copyToChannel(f as Float32Array<ArrayBuffer>, c));
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    const now = this.ctx.currentTime;
    if (this.next < now + 0.005) {
      // Underrun: the network fell behind. Resume a hair later; the clock skips the gap.
      this.stalledMs += (now + 0.01 - this.next) * 1000;
      this.next = now + 0.01;
    }
    src.start(this.next);
    this.next += buf.duration;
    this.scheduledMs += buf.duration * 1000;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      this.maybeEnd();
    };
  }

  private maybeEnd() {
    if (this.t0 < 0 || !this.downloaded || this.sources.size || this.stopped) return;
    const f = this.onEnded;
    this.onEnded = null;
    f?.();
  }

  async start(onEnded: () => void) {
    this.onEnded = onEnded;
    this.t0 = this.ctx.currentTime + 0.01;
    this.next = this.t0;
    for (const f of this.pending.splice(0)) this.schedule(f);
    this.maybeEnd();
  }

  time() {
    if (this.t0 < 0) return 0;
    return Math.max(0, Math.min(this.scheduledMs, (this.ctx.currentTime - this.t0) * 1000 - this.stalledMs));
  }

  duration() {
    return this.downloaded ? (this.totalFrames / this.rate) * 1000 : null;
  }

  stop() {
    this.stopped = true;
    this.onEnded = null;
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
        s.disconnect();
      } catch {}
    }
    this.sources.clear();
  }
}
