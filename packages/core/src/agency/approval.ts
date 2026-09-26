import type { BrainService } from "../services";

export type Verdict = "yes" | "no" | null;

const YES = [
  "yeah",
  "yea",
  "yah",
  "ya",
  "yes",
  "yep",
  "yup",
  "do it",
  "lock it in",
  "lock in",
  "bet",
  "go",
  "go ahead",
  "go for it",
  "sure",
  "ok",
  "okay",
  "k",
  "sounds good",
  "perfect",
  "please",
  "absolutely",
  "definitely",
  "of course",
  "send it",
  "book it",
  "approved",
  "confirm",
  "let's do it",
  "lets do it",
  "for sure",
  "hell yeah",
  "why not",
];

const NO = [
  "nah",
  "no",
  "nope",
  "wait",
  "stop",
  "hold on",
  "hold up",
  "cancel",
  "don't",
  "dont",
  "do not",
  "not now",
  "never mind",
  "nevermind",
  "not yet",
  "skip",
  "abort",
  "negative",
  "later",
];

function toPattern(words: string[]): RegExp {
  const alts = [...words].sort((a, b) => b.length - a.length).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ /g, "\\s+"));
  return new RegExp(`(^|\\s)(${alts.join("|")})(?=\\s|$)`, "i");
}

const YES_RE = toPattern(YES);
const NO_RE = toPattern(NO);

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Keyword pass: a clear yes or a clear no. Anything that hits both sides
 * ("no wait, do it") or neither ("hmm what time") returns null so a model can judge.
 */
export function classifyApproval(text: string): Verdict {
  const t = normalize(text);
  if (!t) return null;
  // A negated yes ("not ok", "don't do it") is a no.
  const negated = /\b(not|don't|dont|never)\s+(ok|okay|sure|do it|go)\b/.test(t);
  const yes = YES_RE.test(t) && !negated;
  const no = NO_RE.test(t) || negated;
  if (yes && !no) return "yes";
  if (no && !yes) return "no";
  return null;
}

/** Keywords first, then a tiny model call. null means "still unclear, keep waiting". */
export async function judgeApproval(text: string, action: string, brains: BrainService | null): Promise<Verdict> {
  const quick = classifyApproval(text);
  if (quick || !brains) return quick;
  try {
    const r = await brains.quickJson<{ decision?: string }>(
      'You judge whether a spoken reply approves a pending action. Reply with JSON {"decision":"yes"|"no"|"unclear"}. Only "yes" if the person clearly agrees now. Hesitation, questions or changes of plan are "no" or "unclear".',
      `Pending action: ${action}\nThey said: "${text}"`,
      { timeoutMs: 4000 },
    );
    const d = String(r?.decision ?? "").toLowerCase();
    return d === "yes" ? "yes" : d === "no" ? "no" : null;
  } catch {
    return null;
  }
}

export const APPROVE_KEYS = new Set(["Enter", "y", "Y"]);
export const DENY_KEYS = new Set(["Escape", "n", "N"]);
