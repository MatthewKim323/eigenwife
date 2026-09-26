import type { SpeechMark } from "@eigenwife/protocol";
import { MarkSplitter, splitMarks } from "./marks";

/**
 * Sentence chunker for TTS. Feeds on the mark splitter's clean text + marks
 * and releases speakable segments as soon as they are complete:
 *
 * - split after . ! ? ; (a run like "?!" or "..." counts once) when followed
 *   by whitespace, so "3.5" and "$21.50" never split
 * - for the first 2 segments, also split after a comma once the segment has
 *   >= 4 words (gets audio started sooner)
 * - hard cap: 12 words per segment
 *
 * Marks ride along with the segment whose text they fall in, with `at`
 * rebased to that segment's text. A mark sitting exactly on a boundary
 * belongs to the next segment (it fires when that one starts). Segments with
 * no letters or digits aren't emitted; their marks carry forward. Pure.
 */

export interface Segment {
  text: string;
  marks: SpeechMark[];
}

export const MAX_WORDS = 12;
const EARLY_COMMA_SEGMENTS = 2;
const EARLY_COMMA_MIN_WORDS = 4;

function words(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

export class SentenceChunker {
  private buf = "";
  /** Global clean-text offset of buf[0]. */
  private start = 0;
  private marks: SpeechMark[] = [];
  private carry: SpeechMark[] = [];
  private emitted = 0;

  /**
   * Add clean text and marks (marks use global offsets, as MarkSplitter emits
   * them). final=true also flushes, so trailing marks can still attach to the
   * last segment.
   */
  push(text: string, marks: SpeechMark[] = [], final = false): Segment[] {
    this.buf += text;
    this.marks.push(...marks);
    return this.drain(final);
  }

  flush(): Segment[] {
    return this.drain(true);
  }

  get count(): number {
    return this.emitted;
  }

  private cutPoint(final: boolean): number {
    const b = this.buf;
    let best = -1;
    // sentence end
    const re = /[.!?;]+(?=\s)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(b))) {
      const end = m.index + m[0].length;
      if (words(b.slice(0, end)) > 0) {
        best = end;
        break;
      }
    }
    // early comma
    if (this.emitted < EARLY_COMMA_SEGMENTS) {
      const cre = /,(?=\s)/g;
      while ((m = cre.exec(b))) {
        const end = m.index + 1;
        if (best >= 0 && end >= best) break;
        if (words(b.slice(0, end)) >= EARLY_COMMA_MIN_WORDS) {
          best = end;
          break;
        }
      }
    }
    // word cap
    const wre = /\S+/g;
    let n = 0;
    while ((m = wre.exec(b))) {
      if (!/[\p{L}\p{N}]/u.test(m[0])) continue;
      n++;
      const end = m.index + m[0].length;
      if (best >= 0 && end >= best) break;
      if (n === MAX_WORDS) {
        if (end < b.length && /\s/.test(b[end]!)) best = end;
        else if (final && end < b.length) best = end;
        break;
      }
    }
    if (best < 0 && final && b.trim()) best = b.length;
    return best;
  }

  private drain(final: boolean): Segment[] {
    const out: Segment[] = [];
    while (true) {
      const cut = this.cutPoint(final);
      if (cut < 0) break;
      const raw = this.buf.slice(0, cut);
      const endG = this.start + cut;
      const lastCut = final && cut >= this.buf.length;
      const mine = this.marks.filter((mk) => mk.at < endG || (lastCut && mk.at <= endG));
      this.marks = this.marks.filter((mk) => !mine.includes(mk));
      const lead = raw.length - raw.trimStart().length;
      const text = raw.trim();
      const rebased = mine.map((mk) => ({ ...mk, at: Math.max(0, Math.min(text.length, mk.at - this.start - lead)) }));
      this.buf = this.buf.slice(cut);
      this.start = endG;
      if (!/[\p{L}\p{N}]/u.test(text)) {
        this.carry.push(...rebased.map((mk) => ({ ...mk, at: 0 })));
        continue;
      }
      out.push({ text, marks: [...this.carry, ...rebased] });
      this.carry = [];
      this.emitted++;
    }
    if (final) {
      // Marks after the last word: attach to the last segment's end.
      const rest = [...this.carry, ...this.marks];
      if (rest.length && out.length) {
        const last = out[out.length - 1]!;
        last.marks.push(...rest.map((mk) => ({ ...mk, at: last.text.length })));
      }
      this.carry = [];
      this.marks = [];
      this.buf = "";
    }
    return out;
  }
}

/**
 * Splitter + chunker in one: raw brain chunks in, speakable segments out.
 * This is the whole text path of the speech pipeline.
 */
export class SegmentStream {
  private splitter = new MarkSplitter();
  private chunker = new SentenceChunker();

  push(raw: string): Segment[] {
    const { text, marks } = this.splitter.push(raw);
    return this.chunker.push(text, marks);
  }

  flush(): Segment[] {
    const { text, marks } = this.splitter.flush();
    return this.chunker.push(text, marks, true);
  }
}

/** One-shot segmentation of a full string (used for scripted lines and prerender). */
export function segmentText(s: string): Segment[] {
  const { text, marks } = splitMarks(s);
  return new SentenceChunker().push(text, marks, true);
}
