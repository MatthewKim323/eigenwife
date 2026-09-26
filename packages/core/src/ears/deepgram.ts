/**
 * Deepgram live STT: URL building and the transcript assembler. Pure, no IO.
 * Docs: https://developers.deepgram.com/docs/live-streaming-audio
 */

export const DEEPGRAM_LISTEN_URL = "wss://api.deepgram.com/v1/listen";

export interface ListenOptions {
  model?: string;
  /** "linear16" for raw PCM, undefined for containerized audio (webm/opus, ogg): Deepgram sniffs it. */
  encoding?: "linear16" | "opus";
  sampleRate?: number;
  channels?: number;
  language?: string;
  endpointingMs?: number;
  utteranceEndMs?: number;
}

export const LISTEN_DEFAULTS = {
  model: "nova-3",
  language: "en",
  endpointingMs: 300,
  utteranceEndMs: 1000,
} as const;

/** Build the wss://.../v1/listen URL with our streaming settings. */
export function listenUrl(opts: ListenOptions = {}, base = DEEPGRAM_LISTEN_URL): string {
  const q = new URLSearchParams({
    model: opts.model ?? LISTEN_DEFAULTS.model,
    language: opts.language ?? LISTEN_DEFAULTS.language,
    interim_results: "true",
    smart_format: "true",
    punctuate: "true",
    vad_events: "true",
    endpointing: String(opts.endpointingMs ?? LISTEN_DEFAULTS.endpointingMs),
    utterance_end_ms: String(opts.utteranceEndMs ?? LISTEN_DEFAULTS.utteranceEndMs),
  });
  if (opts.encoding === "linear16") {
    q.set("encoding", "linear16");
    q.set("sample_rate", String(opts.sampleRate ?? 16000));
    q.set("channels", String(opts.channels ?? 1));
  } else if (opts.encoding === "opus") {
    // Raw (non-containerized) opus needs its rate; webm/ogg containers need nothing.
    q.set("encoding", "opus");
    q.set("sample_rate", String(opts.sampleRate ?? 48000));
  }
  return `${base}?${q}`;
}

/** Client query (?encoding=linear16&sample_rate=16000 or ?encoding=webm) to listen options. */
export function optionsFromQuery(q: URLSearchParams): ListenOptions {
  const enc = (q.get("encoding") ?? "linear16").toLowerCase();
  const rate = Number(q.get("sample_rate") ?? "") || undefined;
  if (enc === "webm" || enc === "ogg" || enc === "container") return { language: q.get("language") ?? undefined };
  if (enc === "opus") return { encoding: "opus", sampleRate: rate ?? 48000, language: q.get("language") ?? undefined };
  return { encoding: "linear16", sampleRate: rate ?? 16000, language: q.get("language") ?? undefined };
}

export interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: { transcript?: string; confidence?: number }[] };
}

export type DeepgramMessage =
  | DeepgramResults
  | { type: "UtteranceEnd"; last_word_end?: number }
  | { type: "SpeechStarted"; timestamp?: number }
  | { type: "Metadata"; request_id?: string }
  | { type: "Error" | string; [k: string]: unknown };

export interface AssemblerHooks {
  partial(text: string): void;
  final(text: string, confidence?: number): void;
}

const join = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");

/**
 * Deepgram streams interim results, then is_final chunks (a stretch of audio is
 * settled), then speech_final (endpoint: the speaker paused). An utterance can
 * span several is_final chunks, so we hold them until speech_final or an
 * UtteranceEnd (the backup when background noise defeats endpointing), then
 * commit the whole thing once.
 */
export class TranscriptAssembler {
  private settled: string[] = [];
  private interim = "";
  private lastPartial = "";
  private confidences: number[] = [];

  constructor(private hooks: AssemblerHooks) {}

  /** Returns true when the message was a transcript event. */
  push(msg: DeepgramMessage): boolean {
    if (msg.type === "UtteranceEnd") {
      this.commit();
      return true;
    }
    if (msg.type !== "Results") return false;
    const r = msg as DeepgramResults;
    const alt = r.channel?.alternatives?.[0];
    const text = (alt?.transcript ?? "").trim();
    if (r.is_final) {
      if (text) {
        this.settled.push(text);
        if (typeof alt?.confidence === "number") this.confidences.push(alt.confidence);
      }
      this.interim = "";
      if (r.speech_final) this.commit();
      else this.emitPartial();
    } else {
      this.interim = text;
      this.emitPartial();
    }
    return true;
  }

  /** Everything heard in the current utterance so far. */
  get current(): string {
    return join([...this.settled, this.interim]);
  }

  /** Force the utterance closed (push-to-talk release, client finalize). */
  commit() {
    const text = this.current;
    const conf = this.confidences.length ? this.confidences.reduce((a, b) => a + b, 0) / this.confidences.length : undefined;
    this.reset();
    if (text) this.hooks.final(text, conf);
  }

  reset() {
    this.settled = [];
    this.interim = "";
    this.lastPartial = "";
    this.confidences = [];
  }

  private emitPartial() {
    const t = this.current;
    if (!t || t === this.lastPartial) return;
    this.lastPartial = t;
    this.hooks.partial(t);
  }
}
