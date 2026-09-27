import type { SpeechMark } from "@eigenwife/protocol";
import { WebAudioEngine, type AudioEngine, type Playback } from "./engine";
import { LipsyncEnvelope } from "./lipsync";
import { estimateSpeechMs, MarkCursor, markTimes, SegmentQueue, type Segment } from "./queue";
import { SpeechRate, TimedMarks } from "./stream";
import { bestVoice, SynthMouth, wordLengthAt } from "./synth";

export interface PlayerHooks {
  played(utteranceId: string, seq: number): void;
  mark(mark: SpeechMark, utteranceId: string): void;
  utteranceDone(utteranceId: string, interrupted: boolean): void;
  /** A segment started: text is shown progressively over durationMs. */
  /** revealTo: chars confirmed spoken (word boundaries); when absent, reveal by time. */
  subtitle(s: { utteranceId: string; before: string; text: string; startedAt: number; durationMs: number; revealTo?: number } | null): void;
  /** Mouth + speaking flag every frame. */
  mouth(value: number, hold: boolean, speaking: boolean): void;
}

interface Playing {
  seg: Segment;
  kind: "audio" | "synth";
  utterance?: SpeechSynthesisUtterance;
  stop(): void;
}

/**
 * Plays speech.segment events in strict (utteranceId, seq) order through one
 * AudioContext. Audio is prepared the moment a segment arrives (see
 * engine.ts): cached files are fetched and decoded whole, live streams
 * (stream: true) start downloading and buffering so they play from their
 * first bytes, and the next segment is ready while the current one plays.
 * An AnalyserNode taps whatever plays for lipsync. Marks fire by playback
 * position. Segments without audio fall back to speechSynthesis with a fake mouth.
 */
export class SpeechPlayer {
  private queue = new SegmentQueue();
  private abort = new AbortController();
  private prepared = new Map<string, Promise<Playback | null>>();
  private playing: Playing | null = null;
  private tracked = new Set<string>();
  private spoken = new Map<string, string>();
  private timers: ReturnType<typeof setTimeout>[] = [];
  private tickers: ReturnType<typeof setInterval>[] = [];
  private envelope = new LipsyncEnvelope();
  private synthMouth = new SynthMouth();
  /** Her speaking rate, learned from played audio (times streamed segments before their length is known). */
  readonly rate = new SpeechRate();
  private raf = 0;
  private lastFrame = 0;
  private gated = false;
  private gapTimer: ReturnType<typeof setTimeout> | undefined;
  stoppedAt = 0;

  constructor(
    private hooks: PlayerHooks,
    private resolveUrl: (u: string) => string,
    private engine: AudioEngine = new WebAudioEngine(),
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
    for (const p of this.prepared.values()) void p.then((pb) => pb?.stop());
    this.prepared.clear();
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
    if (this.prepared.has(k)) return;
    const p = this.engine.prepare(this.resolveUrl(s.audioUrl!), !!s.stream, this.abort.signal).catch(() => null);
    this.prepared.set(k, p);
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
    let pb: Playback | null = null;
    if (s.audioUrl) {
      this.prefetch(s);
      pb = await this.prepared.get(this.key(s))!;
      this.prepared.delete(this.key(s));
    }
    if (gen.aborted || this.playing !== placeholder) {
      pb?.stop();
      return;
    }
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
    if (pb && this.engine.running()) {
      if (await this.playAudio(s, pb, before, done)) return;
      if (gen.aborted || this.playing?.seg !== s) return;
    } else pb?.stop();
    this.playSynth(s, before, done);
  }

  /** Play prepared audio; false if it refused to start (the caller falls back to speechSynthesis). */
  private async playAudio(s: Segment, pb: Playback, before: string, done: () => void): Promise<boolean> {
    const est = pb.duration() ?? this.rate.estimate(s.text);
    const marks = new TimedMarks(s.text, s.marks ?? [], est);
    const fire = (list: SpeechMark[]) => list.forEach((m) => this.hooks.mark(m, s.utteranceId));
    let over = false;
    const end = () => {
      if (over) return;
      over = true;
      fire(marks.rest());
      const d = pb.duration();
      if (d) this.rate.learn(s.text, d);
      done();
    };
    this.playing = {
      seg: s,
      kind: "audio",
      stop: () => {
        over = true;
        pb.stop();
      },
    };
    try {
      await pb.start(end);
    } catch (err) {
      console.warn("[voice] audio refused to play, falling back to speechSynthesis", err);
      pb.stop();
      return false;
    }
    if (over || this.playing?.seg !== s) return true;
    // Marks by playback position: a stream that stalls holds its marks back too.
    fire(marks.due(pb.time(), pb.duration()));
    this.tickers.push(setInterval(() => !over && fire(marks.due(pb.time(), pb.duration())), 25));
    // A stream that never ends must not hold her mouth open forever.
    this.timers.push(
      setTimeout(
        () => {
          if (over) return;
          pb.stop();
          end();
        },
        Math.max(15_000, est * 3),
      ),
    );
    this.hooks.subtitle({ utteranceId: s.utteranceId, before, text: s.text, startedAt: performance.now(), durationMs: est });
    return true;
  }

  private playSynth(s: Segment, before: string, done: () => void) {
    const est = estimateSpeechMs(s.text) / SYNTH_RATE;
    const sub = (revealTo?: number) =>
      this.hooks.subtitle({ utteranceId: s.utteranceId, before, text: s.text, startedAt: performance.now(), durationMs: est, revealTo });
    const hasSynth = "speechSynthesis" in globalThis && typeof SpeechSynthesisUtterance !== "undefined";
    if (!hasSynth) {
      // Silent: still animate and subtitle so the scene reads.
      const t = setTimeout(done, est);
      this.synthMouth.start(performance.now());
      this.playing = { seg: s, kind: "synth", stop: () => clearTimeout(t) };
      this.scheduleMarks(s, est);
      sub();
      return;
    }
    const u = new SpeechSynthesisUtterance(s.text);
    const v = pickVoice();
    if (v) u.voice = v;
    u.lang = v?.lang ?? "en-US";
    u.rate = SYNTH_RATE;
    u.pitch = SYNTH_PITCH;
    const cursor = new MarkCursor(s.marks ?? []);
    const fireMarks = (list: SpeechMark[]) => list.forEach((m) => this.hooks.mark(m, s.utteranceId));
    let started = false;
    let boundaries = 0;
    const start = () => {
      if (started) return;
      started = true;
      this.synthMouth.start(performance.now());
      fireMarks(cursor.advance(0));
      sub(0);
      // Voices that never report word boundaries: fall back to time-based marks + subtitles.
      this.timers.push(
        setTimeout(() => {
          if (boundaries > 0) return;
          const t0 = 700;
          for (const { t, mark } of markTimes(s.text, cursor.pending(), est)) {
            this.timers.push(setTimeout(() => cursor.take(mark) && fireMarks([mark]), Math.max(0, t - t0)));
          }
          sub(undefined);
        }, 700),
      );
    };
    u.onstart = start;
    u.onboundary = (ev: SpeechSynthesisEvent) => {
      if (ev.name && ev.name !== "word") return;
      start();
      boundaries++;
      const len = ev.charLength || wordLengthAt(s.text, ev.charIndex);
      this.synthMouth.word(performance.now(), len);
      fireMarks(cursor.advance(ev.charIndex + Math.ceil(len / 2)));
      sub(ev.charIndex + len);
    };
    const finish = () => {
      this.synthMouth.end();
      fireMarks(cursor.rest());
      done();
    };
    u.onend = finish;
    u.onerror = finish;
    // Chrome sometimes never fires onstart (locked audio, busy engine): don't hang the queue.
    const guard = setTimeout(start, 500);
    const hardStop = setTimeout(finish, est * 2.2 + 2000);
    this.playing = {
      seg: s,
      kind: "synth",
      utterance: u, // keep a strong ref: Chrome GCs utterances and then never fires onend
      stop: () => {
        clearTimeout(guard);
        clearTimeout(hardStop);
        this.synthMouth.end();
        u.onend = null;
        u.onerror = null;
        u.onboundary = null;
        try {
          speechSynthesis.cancel();
        } catch {}
      },
    };
    // A stale queue from a previous page state can block speak() forever.
    if (speechSynthesis.speaking || speechSynthesis.pending) speechSynthesis.cancel();
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
    this.tickers.forEach(clearInterval);
    this.tickers = [];
  }

  private frame(t: number) {
    const dt = this.lastFrame ? Math.min(100, t - this.lastFrame) : 16;
    this.lastFrame = t;
    const p = this.playing;
    let mouth: number;
    if (p?.kind === "synth") {
      mouth = this.synthMouth.value(t);
      this.envelope.drive(mouth);
    } else {
      const level = p?.kind === "audio" ? this.engine.level() : null;
      mouth = this.envelope.update(level ?? 0, level !== null, dt, t);
    }
    this.hooks.mouth(mouth, !p && this.envelope.holding(t), !!p);
  }
}

export const SYNTH_RATE = 1.04;
export const SYNTH_PITCH = 1.15;

let cachedVoice: SpeechSynthesisVoice | null = null;
if (typeof speechSynthesis !== "undefined") {
  try {
    speechSynthesis.addEventListener("voiceschanged", () => (cachedVoice = null));
  } catch {}
}

/** Best available voice (see synth.ts PREFERRED_VOICES). Override with ?voice=<name substring>. */
export function pickVoice(): SpeechSynthesisVoice | null {
  if (cachedVoice) return cachedVoice;
  const voices = speechSynthesis.getVoices();
  if (!voices.length) return null;
  const want = new URLSearchParams(location.search).get("voice");
  cachedVoice = (want && voices.find((v) => v.name.toLowerCase().includes(want.toLowerCase()))) || bestVoice(voices) || voices[0] || null;
  return cachedVoice;
}
