import { newId, type Mood, type SpeechMark } from "@eigenwife/protocol";
import type { EventBus } from "../bus";
import type { SayOptions, SpeechService } from "../services";
import { wordCount } from "../brains/text";
import { SegmentStream, segmentText, type Segment } from "./chunker";
import { FILLERS } from "./lines";
import { splitMarks } from "./marks";
import type { Rendered, Tts } from "./tts";

/**
 * The speech pipeline: text or a token stream in, ordered speech.* events out.
 *
 *   chunks -> MarkSplitter -> SentenceChunker -> TTS (<= 4 in parallel)
 *          -> speech.segment in strict seq order -> shell plays them
 *
 * Utterances are serialized through a priority queue. A higher-priority say()
 * (or interrupt: true) cuts off whatever she's saying; a low-priority line
 * that arrives while she's busy is dropped (ambient chatter goes stale fast).
 * The shell reports playback with speech.played; without it we estimate
 * duration so avatar.state still returns to idle.
 */

export interface SpeechDeps {
  bus: EventBus;
  tts: Tts | null;
  log?(...args: unknown[]): void;
  /** Wait this long for a stream's first chunk before playing a filler. */
  fillerMs?: number;
  /** Parallel TTS requests per utterance. */
  concurrency?: number;
  /** Playback estimate for one segment when the shell doesn't report. */
  estimateMs?(seg: Segment): number;
  /** Extra wait past the estimate before declaring playback over. */
  slackMs?: number;
  source?: string;
}

const RANK = { low: 0, normal: 1, high: 2 } as const;
type Priority = keyof typeof RANK;

interface Job {
  id: string;
  input: string | AsyncIterable<string>;
  opts: SayOptions;
  priority: Priority;
  abort: AbortController;
  resolve(r: { utteranceId: string; text: string }): void;
  text: string;
  seq: number;
  begun: boolean;
  ended: boolean;
  interrupted: boolean;
  spoke: boolean;
  playUntil: number;
  timer?: ReturnType<typeof setTimeout>;
}

export function defaultEstimateMs(seg: Segment): number {
  const pauses = seg.marks.reduce((s, m) => s + (m.pauseS ?? 0), 0);
  return Math.max(500, wordCount(seg.text) * 330 + pauses * 1000 + 250);
}

/** A tiny counting semaphore. */
function limiter(n: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= n) await new Promise<void>((r) => waiting.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

export interface Speech extends SpeechService {
  /** Stats for /api/speech/status. */
  info(): { speaking: boolean; queued: number; current: string | null; fillers: number };
  dispose(): void;
}

export function createSpeech(deps: SpeechDeps): Speech {
  const { bus } = deps;
  const log = deps.log ?? (() => {});
  const src = deps.source ?? "core";
  const fillerMs = deps.fillerMs ?? 700;
  const estimate = deps.estimateMs ?? defaultEstimateMs;
  const slack = deps.slackMs ?? 800;
  const concurrency = deps.concurrency ?? 4;

  const queue: Job[] = [];
  let running: Job | null = null;
  const playing = new Set<Job>();
  let fillerIdx = 0;
  let fillersPlayed = 0;
  let avatarState: "idle" | "speaking" | "thinking" = "idle";
  let selfStop = false;

  const setAvatar = (state: "idle" | "speaking" | "thinking", parent?: string) => {
    if (avatarState === state) return;
    avatarState = state;
    bus.emit("avatar.state", { state }, src, parent);
  };

  const speaking = () => running !== null || playing.size > 0;
  const activeRank = () => Math.max(-1, ...[running, ...playing].filter((j): j is Job => !!j && !j.interrupted).map((j) => RANK[j.priority]));

  function finishPlayback(job: Job) {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
    playing.delete(job);
    if (!speaking()) setAvatar("idle", job.opts.parent);
  }

  function schedulePlaybackEnd(job: Job) {
    if (job.timer) clearTimeout(job.timer);
    const wait = Math.max(0, job.playUntil - Date.now()) + slack;
    job.timer = setTimeout(() => {
      if (!job.ended) return schedulePlaybackEnd(job);
      finishPlayback(job);
    }, wait);
    (job.timer as { unref?: () => void }).unref?.();
  }

  function emitSegment(job: Job, seg: Segment, audio: Rendered | null, filler = false) {
    if (job.abort.signal.aborted) return;
    const seq = job.seq++;
    bus.emit(
      "speech.segment",
      { utteranceId: job.id, seq, text: seg.text, marks: seg.marks, ...(audio ? { audioUrl: audio.url } : {}) },
      src,
      job.opts.parent,
    );
    if (!filler) {
      job.text += (job.text ? " " : "") + seg.text;
      if (!job.spoke) {
        job.spoke = true;
        setAvatar("speaking", job.opts.parent);
      }
    } else setAvatar("thinking", job.opts.parent);
    playing.add(job);
    job.playUntil = Math.max(job.playUntil, Date.now()) + estimate(seg);
    schedulePlaybackEnd(job);
  }

  async function playFiller(job: Job) {
    const text = FILLERS[fillerIdx++ % FILLERS.length]!;
    fillersPlayed++;
    const audio = deps.tts ? (deps.tts.lookup(text) ?? (await deps.tts.render(text, job.abort.signal).catch(() => null))) : null;
    emitSegment(job, { text, marks: [{ at: 0, mood: "thinking", intensity: 0.5 }] }, audio, true);
  }

  async function runJob(job: Job) {
    const signal = job.abort.signal;
    const initial = typeof job.input === "string" ? splitMarks(job.input).text : "";
    job.begun = true;
    bus.emit("speech.begin", { utteranceId: job.id, text: initial, brain: job.opts.brain ?? (typeof job.input === "string" ? "scripted" : "persona") }, src, job.opts.parent);

    const limit = limiter(concurrency);
    let chain = Promise.resolve();
    let first = true;
    const ss = new SegmentStream();
    const enqueue = (segs: Segment[]) => {
      for (const seg of segs) {
        if (signal.aborted) return;
        if (first) {
          first = false;
          if (job.opts.mood && !seg.marks.some((m) => m.at === 0 && m.mood)) seg.marks.unshift({ at: 0, mood: job.opts.mood as Mood, intensity: 0.6 } as SpeechMark);
        }
        const audio = deps.tts ? limit(() => deps.tts!.render(seg.text, signal)).catch(() => null) : Promise.resolve(null);
        chain = chain.then(async () => emitSegment(job, seg, await audio));
      }
    };

    try {
      if (typeof job.input === "string") {
        enqueue(segmentText(job.input));
      } else {
        const it = job.input[Symbol.asyncIterator]();
        try {
          let next = it.next();
          let timer: ReturnType<typeof setTimeout> | undefined;
          const timeout = new Promise<"slow">((r) => (timer = setTimeout(() => r("slow"), fillerMs)));
          const firstResult = await Promise.race([next, timeout]);
          if (timer) clearTimeout(timer);
          if (firstResult === "slow" && !signal.aborted) await playFiller(job);
          while (!signal.aborted) {
            const r = await next;
            if (r.done) break;
            if (r.value) enqueue(ss.push(r.value));
            next = it.next();
          }
        } finally {
          if (signal.aborted) void it.return?.();
        }
      }
      if (!signal.aborted && typeof job.input !== "string") enqueue(ss.flush());
      await chain;
    } catch (err) {
      log("utterance failed:", err);
    }

    if (!job.ended) {
      job.ended = true;
      bus.emit("speech.end", { utteranceId: job.id, interrupted: job.interrupted }, src, job.opts.parent);
    }
    if (job.seq === 0 && !job.interrupted) {
      // Nothing to say after all.
      playing.delete(job);
    }
    if (running === job) running = null;
    if (!speaking()) setAvatar("idle", job.opts.parent);
    job.resolve({ utteranceId: job.id, text: job.text });
  }

  function pump() {
    if (running || !queue.length) return;
    const job = queue.shift()!;
    running = job;
    void runJob(job).finally(pump);
  }

  function cut(reason: string, emitStop: boolean, parent?: string) {
    const had = speaking() || queue.length > 0;
    for (const j of queue.splice(0)) j.resolve({ utteranceId: j.id, text: "" });
    const victims = [running, ...playing].filter((j): j is Job => !!j);
    if (!victims.length && !had) return;
    if (emitStop) {
      selfStop = true;
      try {
        bus.emit("speech.stop", { reason }, src, parent);
      } finally {
        selfStop = false;
      }
    }
    for (const j of victims) {
      j.interrupted = true;
      j.abort.abort();
      if (j.timer) clearTimeout(j.timer);
      if (j.begun && !j.ended) {
        j.ended = true;
        bus.emit("speech.end", { utteranceId: j.id, interrupted: true }, src, j.opts.parent);
      }
    }
    playing.clear();
    running = null;
    setAvatar("idle", parent);
    log(`stopped (${reason})`);
  }

  function say(input: string | AsyncIterable<string>, opts: SayOptions = {}) {
    const priority: Priority = opts.priority ?? "normal";
    return new Promise<{ utteranceId: string; text: string }>((resolve) => {
      const job: Job = {
        id: newId("utt"),
        input,
        opts,
        priority,
        abort: new AbortController(),
        resolve,
        text: "",
        seq: 0,
        begun: false,
        ended: false,
        interrupted: false,
        spoke: false,
        playUntil: 0,
      };
      const busy = speaking() || queue.length > 0;
      if (opts.interrupt || (busy && RANK[priority] > activeRank())) {
        if (busy) cut(opts.interrupt ? "interrupt" : "preempted", true, opts.parent);
      } else if (busy && priority === "low") {
        log("dropped low-priority line while busy");
        return resolve({ utteranceId: job.id, text: "" });
      }
      // Priority order, FIFO within a priority.
      const at = queue.findIndex((q) => RANK[q.priority] < RANK[priority]);
      if (at < 0) queue.push(job);
      else queue.splice(at, 0, job);
      pump();
    });
  }

  const offs = [
    bus.on("speech.played", (e) => {
      for (const j of playing) {
        if (j.id === e.data.utteranceId && j.ended && e.data.seq >= j.seq - 1) finishPlayback(j);
      }
    }),
    bus.on("speech.stop", (e) => {
      if (selfStop) return;
      cut(e.data.reason, false, e.id);
    }),
    bus.on("voice.partial", (e) => {
      if (speaking() && wordCount(e.data.text) >= 3) cut("barge-in", true, e.id);
    }),
  ];

  return {
    say,
    stop: (reason) => cut(reason, true),
    speaking,
    info: () => ({ speaking: speaking(), queued: queue.length, current: running?.id ?? null, fillers: fillersPlayed }),
    dispose() {
      for (const off of offs) off();
      for (const j of [running, ...playing, ...queue]) if (j?.timer) clearTimeout(j.timer);
    },
  };
}
