import { clamp01, MOODS, type Mood, type SpeechMark } from "@eigenwife/protocol";

/**
 * Streaming mark splitter. The persona brain writes inline control marks:
 *
 *   [mood:annoyed 0.7] twenty-one dollars. [pause:0.6] for ramen?
 *
 * push() takes raw chunks as they stream in and returns the speakable text
 * so far plus the marks, each pinned to a char offset in the cumulative clean
 * text. An incomplete `[...` tail is held back across chunks, so a mark split
 * over two chunks is never spoken. Pure, no IO.
 *
 * Rules:
 * - `[mood:<m> <0..1>]`, `[mood:<m>]`, `[mood: m, 0.8]`: a mood mark. Close
 *   synonyms (angry, excited, confused, ...) map onto the 7 moods; anything
 *   else is dropped.
 * - `[pause:<s>]`, `[pause]`: a pause mark (seconds, clamped 0.05..3).
 * - any other `[word:...]` or a known audio tag (`[laughs]`, `[sighs]`, ...):
 *   an unknown mark, dropped silently.
 * - other brackets (`[1]`, `[sic]`, `[ok so]`) are normal text and kept.
 * - an unclosed `[` longer than 48 chars is normal text too.
 */

export interface SplitOut {
  /** Speakable text released by this push. */
  text: string;
  /** Marks released by this push; `at` is an offset into the cumulative clean text. */
  marks: SpeechMark[];
}

const MOOD_ALIASES: Record<string, Mood> = {
  angry: "annoyed",
  irritated: "annoyed",
  mad: "annoyed",
  exasperated: "annoyed",
  excited: "happy",
  pleased: "happy",
  warm: "happy",
  playful: "smug",
  teasing: "smug",
  confident: "smug",
  confused: "thinking",
  curious: "thinking",
  pensive: "thinking",
  shocked: "surprised",
  amazed: "surprised",
  upset: "sad",
  disappointed: "sad",
  calm: "neutral",
};

const AUDIO_TAGS = new Set([
  "laughs",
  "laugh",
  "laughing",
  "sighs",
  "sigh",
  "whispers",
  "whisper",
  "giggles",
  "chuckles",
  "scoffs",
  "gasps",
  "hums",
  "pause",
  "beat",
  "smirks",
  "sarcastic",
  "excited",
  "curious",
]);

const MAX_TAIL = 48;

export function parseMood(name: string): Mood | null {
  const n = name.trim().toLowerCase();
  if ((MOODS as readonly string[]).includes(n)) return n as Mood;
  return MOOD_ALIASES[n] ?? null;
}

/**
 * Interpret the inside of one `[...]`. Returns a mark (without `at`), "drop"
 * for unknown marks, or null when it is ordinary bracketed text.
 */
export function parseMark(inner: string): Omit<SpeechMark, "at"> | "drop" | null {
  const s = inner.trim();
  const m = s.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/s);
  if (m) {
    const key = m[1]!.toLowerCase();
    const args = m[2]!.trim();
    if (key === "mood") {
      const parts = args.split(/[\s,]+/).filter(Boolean);
      const mood = parseMood(parts[0] ?? "");
      if (!mood) return "drop";
      const n = Number(parts[1]);
      return { mood, intensity: Number.isFinite(n) && parts[1] !== undefined ? clamp01(n) : 0.7 };
    }
    if (key === "pause") {
      const n = Number.parseFloat(args);
      return { pauseS: Number.isFinite(n) ? Math.min(3, Math.max(0.05, n)) : 0.4 };
    }
    return "drop";
  }
  const word = s.toLowerCase();
  if (word === "pause" || word === "beat") return { pauseS: 0.4 };
  if (AUDIO_TAGS.has(word)) return "drop";
  if (parseMood(word) && MOODS.includes(word as Mood)) return { mood: word as Mood, intensity: 0.7 };
  return null;
}

export class MarkSplitter {
  private tail = "";
  /** Length of clean text released so far. */
  private offset = 0;
  /** Whether the released text so far ends in a space (or nothing was released yet). */
  private lastSpace = true;

  push(chunk: string): SplitOut {
    return this.scan(this.tail + chunk, false);
  }

  /** End of stream: release whatever is held (an unfinished mark is dropped). */
  flush(): SplitOut {
    return this.scan(this.tail, true);
  }

  get released(): number {
    return this.offset;
  }

  private scan(buf: string, final: boolean): SplitOut {
    this.tail = "";
    let text = "";
    const marks: SpeechMark[] = [];
    let i = 0;
    while (i < buf.length) {
      const open = buf.indexOf("[", i);
      if (open < 0) {
        text += buf.slice(i);
        break;
      }
      text += buf.slice(i, open);
      const close = buf.indexOf("]", open + 1);
      const nextOpen = buf.indexOf("[", open + 1);
      if (close < 0 || (nextOpen >= 0 && nextOpen < close)) {
        if (close < 0 && !final && buf.length - open <= MAX_TAIL) {
          // Could still become a mark: hold it back.
          this.tail = buf.slice(open);
          break;
        }
        if (close < 0 && final && /^\[\s*[a-zA-Z_]+\s*:/.test(buf.slice(open))) {
          // Unfinished mark at the very end: drop it, never speak it.
          break;
        }
        text += "[";
        i = open + 1;
        continue;
      }
      const parsed = parseMark(buf.slice(open + 1, close));
      if (parsed === null) {
        text += buf.slice(open, close + 1);
      } else if (parsed !== "drop") {
        marks.push({ at: this.offset + text.length, ...parsed });
      }
      i = close + 1;
    }
    // Collapse the double spaces a removed mark leaves behind.
    const cleaned = collapse(text, this.lastSpace, marks, this.offset);
    this.offset += cleaned.length;
    if (cleaned.length) this.lastSpace = cleaned.endsWith(" ");
    return { text: cleaned, marks };
  }
}

/**
 * Collapse runs of spaces left where marks were cut (also across chunks), and
 * adjust mark offsets to match. Leading whitespace of the stream is dropped.
 */
function collapse(text: string, prevSpace: boolean, marks: SpeechMark[], base: number): string {
  let out = "";
  const map: number[] = [];
  for (let i = 0; i < text.length; i++) {
    map.push(out.length);
    const c = /\s/.test(text[i]!) ? " " : text[i]!;
    if (c === " " && (out.endsWith(" ") || (prevSpace && out.length === 0))) continue;
    out += c;
  }
  map.push(out.length);
  for (const m of marks) m.at = base + (map[m.at - base] ?? out.length);
  return out;
}

/** One-shot: split a whole string. */
export function splitMarks(s: string): { text: string; marks: SpeechMark[] } {
  const sp = new MarkSplitter();
  const a = sp.push(s);
  const b = sp.flush();
  return { text: a.text + b.text, marks: [...a.marks, ...b.marks] };
}
