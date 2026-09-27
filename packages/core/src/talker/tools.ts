/**
 * The talker's one tool: delegate({ stall, kind, task }). Tool schemas for
 * each API family, tolerant argument parsing, early stall extraction from
 * partial JSON, and the inline text protocol for backends without native
 * tool calling (claude CLI, featherless). Pure, no IO.
 */

export type DelegateKind = "answer" | "do";

export interface DelegateCall {
  kind: DelegateKind;
  task: string;
  /** What she says out loud right now while the thinker works. */
  stall?: string;
}

export const DELEGATE_DESCRIPTION =
  "Hand work to your deeper brain, which has his computer, files, calendar, email, the web, memory and real tools, and thinks harder. " +
  "Use it for fresh or live info, anything about his own stuff, doing something on the computer, or careful research. " +
  'kind "answer" = he wants to know something you must look up or work out. kind "do" = he wants something done.';

/** Field order matters: models emit stall first, so it can be spoken before the task is even written. */
export const DELEGATE_SCHEMA = {
  type: "object",
  properties: {
    stall: { type: "string", description: "what you say out loud right now while it runs, 2 to 6 words, in character. e.g. ooh, lemme look." },
    kind: { type: "string", enum: ["answer", "do"] },
    task: { type: "string", description: "the full task for the deeper brain, self-contained, with every detail he gave" },
  },
  required: ["stall", "kind", "task"],
  additionalProperties: false,
} as const;

export function anthropicTool() {
  return { name: "delegate", description: DELEGATE_DESCRIPTION, input_schema: DELEGATE_SCHEMA, eager_input_streaming: true };
}

export function openAiTool() {
  return { type: "function", function: { name: "delegate", description: DELEGATE_DESCRIPTION, parameters: DELEGATE_SCHEMA } };
}

const clean = (s: unknown) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "");

/** Normalize tool arguments (object or JSON string). null when there's no usable task. */
export function parseDelegateArgs(raw: unknown, fallbackTask = ""): DelegateCall | null {
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw || "{}");
      if (v && typeof v === "object") obj = v as Record<string, unknown>;
    } catch {
      obj = null;
    }
  } else if (raw && typeof raw === "object") obj = raw as Record<string, unknown>;
  if (!obj) return fallbackTask ? { kind: "answer", task: fallbackTask } : null;
  const task = clean(obj.task) || fallbackTask;
  if (!task) return null;
  const kind: DelegateKind = clean(obj.kind).toLowerCase() === "do" ? "do" : "answer";
  const stall = clean(obj.stall);
  return { kind, task, ...(stall ? { stall } : {}) };
}

/**
 * The stall value from a partial JSON arguments string, as soon as its string
 * literal is closed. `{"stall": "ooh, lemme look.", "ki` -> "ooh, lemme look.".
 */
export function partialStall(json: string): string | null {
  const m = /"stall"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(json);
  if (!m) return null;
  try {
    return clean(JSON.parse(`"${m[1]}"`));
  } catch {
    return clean(m[1]);
  }
}

// ---------------------------------------------------------------------------
// Inline protocol (no native tools)
// ---------------------------------------------------------------------------

/** How a no-tools backend delegates: its whole reply is one line. */
export const INLINE_RULE =
  "you can't call tools directly. to delegate, your ENTIRE reply must be exactly one line: >>delegate <answer|do> | <stall> | <task>   example: >>delegate answer | ooh, lemme look. | weather in irvine tonight";

const INLINE_RE = /^>>\s*delegate\s*(answer|do)?\s*\|\s*([^|]*)\|\s*([\s\S]+)$/i;

export function parseInline(line: string, fallbackTask = ""): DelegateCall | null {
  const t = line.trim().replace(/^\[[^\]]*\]\s*/, "");
  const m = INLINE_RE.exec(t);
  if (!m) {
    if (/^>>\s*delegate/i.test(t)) return fallbackTask ? { kind: "answer", task: fallbackTask } : null;
    return null;
  }
  const task = clean(m[3]).replace(/^task:\s*/i, "") || fallbackTask;
  if (!task) return null;
  const stall = clean(m[2]);
  return { kind: (m[1] ?? "answer").toLowerCase() === "do" ? "do" : "answer", task, ...(stall ? { stall } : {}) };
}

/**
 * Streaming detector for the inline protocol: holds back the first few
 * characters until it can tell a normal reply from ">>delegate". Normal text
 * passes straight through after that.
 */
export class InlineDelegateParser {
  private head = "";
  private mode: "unknown" | "text" | "delegate" = "unknown";

  /** Feed a chunk; returns text safe to speak now. */
  push(chunk: string): string {
    if (this.mode === "text") return chunk;
    this.head += chunk;
    if (this.mode === "delegate") return "";
    const probe = this.head.replace(/^\s*(?:\[[^\]]*\]\s*)*/, "");
    if (!probe) return "";
    if (probe.startsWith(">>") || probe.startsWith("[[")) {
      this.mode = "delegate";
      return "";
    }
    if (probe.length < 2 && ">".startsWith(probe)) return "";
    this.mode = "text";
    const out = this.head;
    this.head = "";
    return out;
  }

  /** End of stream: remaining text, and the call if this reply was a delegation. */
  end(fallbackTask = ""): { text: string; call: DelegateCall | null } {
    if (this.mode === "delegate") {
      const line = this.head.replace(/^\s*(?:\[[^\]]*\]\s*)*/, "").replace(/^\[\[/, ">>").replace(/\]\]\s*$/, "");
      return { text: "", call: parseInline(line.split("\n")[0] ?? line, fallbackTask) };
    }
    const text = this.head;
    this.head = "";
    return { text, call: null };
  }
}

// ---------------------------------------------------------------------------
// Keyword routing: the no-tool safety net
// ---------------------------------------------------------------------------

/**
 * Asks that obviously need fresh info or his accounts. Used when the serving
 * backend has no native tool calling, so the CLI never guesses at the weather.
 */
const LOOKUP =
  /\b(?:weather|forecast|temperature outside|news|headlines|stock|stocks|share price|crypto|bitcoin|score|who won|standings|latest|look (?:it |that |this )?up|search (?:for|up)|google|what time does .{1,40} (?:open|close)|open (?:now|right now|tonight)|hours for|my (?:calendar|schedule|inbox|email|emails|texts|messages|meetings?)|what'?s on my|do i have (?:anything|any meetings?|plans)|when is my|remind me)\b/i;

export function lookupIntent(text: string): boolean {
  return LOOKUP.test(text);
}
