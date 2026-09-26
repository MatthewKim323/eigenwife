/**
 * Text hygiene for everything a brain says out loud or hands back as data.
 * Pure functions, no IO. Heavily tested in test/brains.text.test.ts.
 */

/**
 * CLI/API error and rate-limit chatter that must NEVER be spoken. Close to
 * jabby's voice ERROR_RE (src/voice/brain.ts), minus "slow down" (Eve says that
 * to people), plus the OpenAI/Anthropic
 * billing and auth messages we have actually seen come back as "text".
 */
export const ERROR_RE =
  /API Error|rate.?limit|try again in|temporarily limiting|usage limit|overloaded|hit your limit|out of extra usage|Server is temporarily|insufficient_quota|no credits remaining|credit balance|invalid.?api.?key|authentication_error|permission_error|Prompt is too long|Execution error|not logged in|please run \/login|Internal server error|quota exceeded|too many requests/i;

export function isErrorText(s: string): boolean {
  return ERROR_RE.test(s);
}

const EM = "—";
const EN = "–";
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}\u{FE0F}\u{200D}]/gu;

/**
 * Make one streamed chunk speakable: no em/en dashes (house style, and TTS
 * reads them badly), no emoji, no markdown emphasis, no quote marks. Brackets
 * are left alone: marks are the speech splitter's job.
 */
export function sanitizeChunk(s: string): string {
  return s
    .replaceAll(EM, ", ")
    .replaceAll(EN, "-")
    .replace(EMOJI_RE, "")
    .replace(/[*_`#]+/g, "")
    .replace(/["“”]/g, "");
}

/** Strip a leading speaker label the model sometimes adds ("Eve: ..."). */
export function stripSpeakerLabel(s: string, names: string[] = ["eve"]): string {
  const alt = [...new Set(names.map((n) => n.toLowerCase().replace(/[^a-z0-9 ]/g, "")).filter(Boolean))].join("|");
  if (!alt) return s;
  return s.replace(new RegExp(`^\\s*(?:${alt})\\s*:\\s*`, "i"), "");
}

/**
 * Pull the first JSON value out of free text. Tries, in order: the whole text,
 * a fenced ```json block, then the first balanced {...} (or [...]) that parses.
 * Returns undefined when nothing parses. String-aware, so braces inside
 * strings don't confuse the balancer.
 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  if (!t) return undefined;
  const direct = tryParse(t);
  if (direct !== undefined && typeof direct === "object") return direct;
  const fence = t.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
  if (fence) {
    const f = tryParse(fence[1]!.trim());
    if (f !== undefined && typeof f === "object") return f;
  }
  for (const open of ["{", "["] as const) {
    let from = 0;
    while (true) {
      const start = t.indexOf(open, from);
      if (start < 0) break;
      const end = balancedEnd(t, start);
      if (end > start) {
        const v = tryParse(t.slice(start, end + 1));
        if (v !== undefined) return v;
      }
      from = start + 1;
    }
  }
  return undefined;
}

function tryParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** Index of the bracket closing the one at `start`, or -1. */
function balancedEnd(s: string, start: number): number {
  const open = s[start]!;
  const close = open === "{" ? "}" : "]";
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export class LeakError extends Error {
  constructor(public text: string) {
    super(`backend returned error text instead of speech`);
    this.name = "LeakError";
  }
}

/**
 * Wrap a raw token stream from a persona backend:
 * - holds the head back (until a sentence end, 48 chars, or the end) and
 *   throws LeakError if it is error chatter, so the router can fall back to
 *   the next backend before anything reaches the speaker
 * - after the head, keeps a rolling window and cuts the stream if error
 *   chatter shows up late (never speaks it)
 * - sanitizes every chunk (dashes, emoji, markdown, quotes) and strips a
 *   leading "Eve:" label
 */
export async function* guardSpoken(src: AsyncIterable<string>, names: string[] = ["eve"]): AsyncGenerator<string> {
  let head = "";
  let headDone = false;
  let window = "";
  for await (const raw of src) {
    if (!raw) continue;
    if (!headDone) {
      head += raw;
      if (head.length < 48 && !/[.!?\n]/.test(head)) continue;
      headDone = true;
      if (isErrorText(head)) throw new LeakError(head);
      const out = sanitizeChunk(stripSpeakerLabel(head.replace(/^\s+/, ""), names));
      window = head.slice(-160);
      if (out) yield out;
      continue;
    }
    window = (window + raw).slice(-160);
    if (isErrorText(window)) return;
    const out = sanitizeChunk(raw);
    if (out) yield out;
  }
  if (!headDone) {
    if (!head.trim()) return;
    if (isErrorText(head)) throw new LeakError(head);
    const out = sanitizeChunk(stripSpeakerLabel(head.replace(/^\s+/, ""), names));
    if (out) yield out;
  }
}

/** Count spoken words, ignoring [marks]. */
export function wordCount(s: string): number {
  return s.replace(/\[[^\]]*\]/g, " ").split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
