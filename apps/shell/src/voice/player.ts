import type { SpeechMark } from "@eigenwife/protocol";
import { getAudioContext } from "./audio";
import { fakeMouth, LipsyncEnvelope, rmsOfBytes } from "./lipsync";
import { estimateSpeechMs, markTimes, SegmentQueue, type Segment } from "./queue";

export interface PlayerHooks {
  played(utteranceId: string, seq: number): void;
  mark(mark: SpeechMark, utteranceId: string): void;
  utteranceDone(utteranceId: string, interrupted: boolean): void;
  /** A segment started: text is shown progressively over durationMs. */
  subtitle(s: { utteranceId: string; before: string; text: string; startedAt: number; durationMs: number } | null): void;
  /** Mouth + speaking flag every frame. */
  mouth(value: number, hold: boolean, speaking: boolean): void;
}

interface Playing {
  seg: Segment;
  kind: "audio" | "synth";
  stop(): void;
}

/**
 * Plays speech.segment events in strict (utteranceId, seq) order through one
 * AudioContext. Audio is prefetched and decoded the moment a segment arrives,
 * so the gap between segments is just scheduling. An AnalyserNode taps the
 * same source for lipsync. Segments without audio fall back to
 * speechSynthesis with a fake mouth.
 */
export class SpeechPlayer {
  private queue = new SegmentQueue();
  private abort = new AbortController();
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  private playing: Playing | null = null;
  private tracked = new Set<string>();
  private spoken = new Map<string, string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private envelope = new LipsyncEnvelope();
  private analyser: AnalyserNode | null = null;
  private bytes: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private raf = 0;
  private lastFrame = 0;
  private gated = false;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  stoppedAt = 0;

  constructor(
    private hooks: PlayerHooks,
    private resolveUrl: (u: string) => string,
  ) {}

  start() {
    const loop = (t: number) => {
      this.frame(t);
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.stop("dispose");
  }

  get speaking() {
    return this.playing !== null;
  }

  /** Hold playback (segments keep queueing and prefetching). Used by emergence. */
  gate(on: boolean) {
    this.gated = on;
    if (!on) this.pump();
  }

  begin(utteranceId: string) {
    this.tracked.add(utteranceId);
    this.queue.begin(utteranceId);
  }

  segment(s: Segment) {
    this.tracked.add(s.utteranceId);
    this.queue.push(s);
    if (s.audioUrl) this.prefetch(s);
    this.pump();
  }

  end(utteranceId: string) {
    this.queue.end(utteranceId);
    this.pump();
  }

  /** Abort everything: speech.stop, barge-in, or a new high-priority utterance. */
  stop(_reason: string) {
    const cut = this.queue.abort();
    this.abort.abort();
    this.abort = new AbortController();
    this.buffers.clear();
    this.clearTimers();
    const cur = this.playing;
    this.playing = null;
    cur?.stop();
    try {
      if ("speechSynthesis" in globalThis) speechSynthesis.cancel();
    } catch {}
    this.hooks.subtitle(null);
    for (const id of new Set([...cut, ...this.tracked])) this.hooks.utteranceDone(id, true);
    this.tracked.clear();
    this.spoken.clear();
    if (cur) this.stoppedAt = performance.now();
  }

  private key(s: Segment) {
    return `${s.utteranceId}#${s.seq}`;
  }

  private prefetch(s: Segment) {
    const k = this.key(s);
    if (this.buffers.has(k)) return;
    const ctx = getAudioContext();
    const signal = this.abort.signal;
    const p = (async () => {
      try {
        const res = await fetch(this.resolveUrl(s.audioUrl!), { signal });
        if (!res.ok) throw new Error(`audio ${res.status}`);
        const data = await res.arrayBuffer();
        if (!ctx) return null;
        return await ctx.decodeAudioData(data);
      } catch (err) {
        if (!signal.aborted) console.warn("[voice] segment audio failed, falling back to speechSynthesis", err);
        return null;
      }
    })();
    this.buffers.set(k, p);
  }

  private pump() {
    if (this.playing || this.gated) return;
    clearTimeout(this.gapTimer);
    const s = this.queue.next(performance.now());
    if (s) {
      void this.play(s);
      return;
    }
    for (const id of [...this.tracked]) {
      if (this.queue.finished(id)) {
        this.tracked.delete(id);
        this.spoken.delete(id);
        this.hooks.utteranceDone(id, false);
      }
    }
    if (this.queue.size > 0) this.gapTimer = setTimeout(() => this.pump(), 250); // waiting out a missing seq
  }

  private async play(s: Segment) {
    const gen = this.abort.signal;
    const placeholder: Playing = { seg: s, kind: "audio", stop() {} };
    this.playing = placeholder;
    let buf: AudioBuffer | null = null;
    if (s.audioUrl) {
      this.prefetch(s);
      buf = await this.buffers.get(this.key(s))!;
      this.buffers.delete(this.key(s));
    }
    if (gen.aborted || this.playing !== placeholder) return;
    const ctx = getAudioContext();
    const done = () => {
      if (this.playing?.seg !== s) return;
      this.clearTimers();
      this.playing = null;
      this.stoppedAt = performance.now();
      this.spoken.set(s.utteranceId, (this.spoken.get(s.utteranceId) ?? "") + s.text + " ");
      this.hooks.played(s.utteranceId, s.seq);
      this.pump();
    };
    const before = this.spoken.get(s.utteranceId) ?? "";
    if (buf && ctx && ctx.state === "running") {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (!this.analyser) {
        this.analyser = ctx.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.connect(ctx.destination);
        this.bytes = new Uint8Array(this.analyser.fftSize);
      }
      src.connect(this.analyser);
      const ms = buf.duration * 1000;
      this.playing = {
        seg: s,
        kind: "audio",
        stop: () => {
          try {
            src.onended = null;
            src.stop();
          } catch {}
        },
      };
      src.onended = done;
      src.start();
      this.scheduleMarks(s, ms);
      this.hooks.subtitle({ utteranceId: s.utteranceId, before, text: s.text, startedAt: performance.now(), durationMs: ms });
      return;
    }
    this.playSynth(s, before, done);
  }

  private playSynth(s: Segment, before: string, done: () => void) {
    const est = estimateSpeechMs(s.text);
    const hasSynth = "speechSynthesis" in globalThis && typeof SpeechSynthesisUtterance !== "undefined";
    if (!hasSynth) {
      // Silent: still animate and subtitle so the scene reads.
      const t = setTimeout(done, est);
      this.playing = { seg: s, kind: "synth", stop: () => clearTimeout(t) };
      this.scheduleMarks(s, est);
      this.hooks.subtitle({ utteranceId: s.utteranceId, before, text: s.text, startedAt: performance.now(), durationMs: est });
      return;
    }
    const u = new SpeechSynthesisUtterance(s.text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = 1.04;
    u.pitch = 1.18;
    let started = false;
    const fire = () => {
      if (started) return;
      started = true;
      this.scheduleMarks(s, est);
      this.hooks.subtitle({ utteranceId: s.utteranceId, before, text: s.text, startedAt: performance.now(), durationMs: est });
    };
    u.onstart = fire;
    u.onend = done;
    u.onerror = done;
    // Chrome sometimes never fires onstart when audio is locked: don't hang.
    const guard = setTimeout(() => {
      fire();
    }, 400);
    const hardStop = setTimeout(done, est * 2.2 + 1500);
    this.playing = {
      seg: s,
      kind: "synth",
      stop: () => {
        clearTimeout(guard);
        clearTimeout(hardStop);
        u.onend = null;
        try {
          speechSynthesis.cancel();
        } catch {}
      },
    };
    speechSynthesis.speak(u);
  }

  private scheduleMarks(s: Segment, durationMs: number) {
    for (const { t, mark } of markTimes(s.text, s.marks ?? [], durationMs)) {
      this.timers.push(setTimeout(() => this.hooks.mark(mark, s.utteranceId), t));
    }
  }

  private clearTimers() {
    this.timers.forEach(clearTimeout);
    this.timers = [];
  }

  private frame(t: number) {
    const dt = this.lastFrame ? Math.min(100, t - this.lastFrame) : 16;
    this.lastFrame = t;
    const p = this.playing;
    let rms = 0;
    let live = false;
    if (p?.kind === "audio" && this.analyser) {
      this.analyser.getByteTimeDomainData(this.bytes);
      rms = rmsOfBytes(this.bytes);
      live = true;
    }
    let mouth: number;
    if (p?.kind === "synth") {
      mouth = fakeMouth(t);
      this.envelope.value = mouth;
      this.envelope.update(0.3, true, dt, t); // keep the envelope "speaking" so release works after
      this.envelope.value = mouth;
    } else {
      mouth = this.envelope.update(rms, live, dt, t);
    }
    this.hooks.mouth(mouth, !p && this.envelope.holding(t), !!p);
  }
}

let cachedVoice: SpeechSynthesisVoice | null | undefined;
function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice !== undefined && cachedVoice !== null) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const prefs = ["Samantha", "Google US English", "Microsoft Aria", "Microsoft Jenny", "Karen", "Moira", "Tessa", "Victoria"];
  cachedVoice =
    prefs.map((n) => voices.find((v) => v.name.includes(n))).find(Boolean) ?? voices.find((v) => v.lang.startsWith("en")) ?? voices[0] ?? null;
  return cachedVoice;
}
