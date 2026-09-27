import type { OnboardingStepId } from "../speech/lines";
import type { BrainService } from "../services";
import type { ProfilePatch } from "./profile";

/**
 * Turning a spoken answer into profile fields. The brain (quickJson) reads
 * anything; regexes handle the easy answers instantly and cover for a brain
 * that's down or slow. Every step can be skipped.
 */

export type Extracted = { kind: "skip" } | { kind: "pause" } | { kind: "none" } | { kind: "value"; patch: ProfilePatch; by: "brain" | "regex" };

/** "skip", "idk", "later", "pass", "next", "rather not say". */
export const SKIP = /^(?:(?:uh+|um+|hm+|eh|nah|no|oh)[,. ]+)*(?:skip(?: (?:it|that|this|this one))?|idk|i (?:don'?t|do not) know|dunno|later|pass|next(?: one| question)?|no comment|rather not(?: say)?|i'?d rather not(?: say)?|none of your business|not sure|no idea|nope,? next|move on)\b[.!? ]*$/i;
/** Stop the whole flow for now: "stop", "not now", "let's do this later". */
export const PAUSE = /^(?:(?:okay|ok|hey|yo|wait|actually)[,. ]+)*(?:stop|stop asking|not now|not right now|can we do (?:this|that|it) later|let'?s do (?:this|that|it) later|do (?:this|that|it) later|maybe later|another time|enough(?: questions)?|i'?m busy|shut up)\b[.!? ]*$/i;
/** "redo onboarding", "let's start over", "ask me the questions again". */
export const REDO = /\b(?:re-?do (?:the )?(?:onboarding|setup|intro)|restart (?:the )?(?:onboarding|setup)|(?:let'?s|can we) start over|start over(?: with me)?|ask me (?:those|the|your) questions again|(?:do|run) (?:the )?onboarding(?: again)?|get to know me again)\b/i;
/** "let's finish onboarding", "keep going with the questions". */
export const RESUME = /\b(?:(?:finish|continue|resume) (?:the )?(?:onboarding|setup|questions)|(?:let'?s|can we) (?:finish|continue) (?:the )?(?:questions|onboarding))\b/i;

const NOT_NAMES = new Set(
  "the a an i im i'm my me you your it its and or but so just um uh uhh umm like yeah yes no nah ok okay well hmm call name is its it's that this whatever anything something guess think probably maybe honestly lol haha oh".split(" "),
);

const cap = (w: string) => (w ? w[0]!.toUpperCase() + w.slice(1) : w);
const words = (s: string) => s.replace(/[^\p{L}\p{N}' -]+/gu, " ").trim().split(/\s+/).filter(Boolean);

/** A name out of "call me matt", "it's matt", "matt", "my name is Matthew but call me matt". */
export function nameFrom(text: string): { name?: string; callMe?: string } | null {
  const t = text.trim().replace(/[.!?]+$/, "");
  const callMe = /\b(?:call me|you can call me|just call me|go by|i go by)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/iu.exec(t)?.[1];
  const named = /\b(?:my name is|my name'?s|name'?s|i'?m|i am|it'?s|this is)\s+([\p{L}][\p{L}'-]*(?:\s+[\p{L}][\p{L}'-]*)?)/iu.exec(t)?.[1];
  const clip = (s?: string) => {
    if (!s) return undefined;
    const ws = words(s).filter((w) => !NOT_NAMES.has(w.toLowerCase()));
    // "matt but" / "matthew kim though": stop at a connector.
    const stop = ws.findIndex((w) => /^(?:but|though|and|or|please|lol|haha)$/i.test(w));
    const kept = (stop >= 0 ? ws.slice(0, stop) : ws).slice(0, 2);
    return kept.length ? kept.join(" ") : undefined;
  };
  const c = clip(callMe);
  const n = clip(named);
  if (c || n) return { ...(n ? { name: n.split(" ").map(cap).join(" ") } : {}), callMe: (c ?? n)!.toLowerCase() };
  // A bare name, maybe wrapped in filler: "matt", "uh, matthew i guess".
  const all = words(t);
  const ws = all.filter((w) => !NOT_NAMES.has(w.toLowerCase()));
  if (all.length <= 5 && ws.length >= 1 && ws.length <= 2) return { name: ws.map(cap).join(" "), callMe: ws[0]!.toLowerCase() };
  return null;
}

/** Her name out of "nova", "call you nova", "eve's fine", "keep it". */
export function herNameFrom(text: string): string | null {
  const t = text.trim().replace(/[.!?]+$/, "");
  if (/\b(?:eve'?s? (?:is )?(?:fine|good|cool|great|perfect)|keep (?:it|eve|your name)|stay eve|eve it is|i like eve|just eve)\b/i.test(t)) return "Eve";
  const m = /\b(?:call you|name you|you'?re|you are|how about|let'?s go with|go with|i'?ll call you|you'?ll be)\s+([\p{L}][\p{L}'-]*)/iu.exec(t)?.[1];
  if (m && !NOT_NAMES.has(m.toLowerCase())) return cap(m.toLowerCase());
  const ws = words(t);
  if (ws.length === 1 && !NOT_NAMES.has(ws[0]!.toLowerCase())) return cap(ws[0]!.toLowerCase());
  return null;
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/** "march 14th", "3/14", "14 march 2003", "2003-03-14" -> "03-14" or "2003-03-14". */
export function birthdayFrom(text: string): string | null {
  const t = text.toLowerCase();
  const pad = (n: number) => String(n).padStart(2, "0");
  const ok = (m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= 31;
  const withYear = (y: string | undefined, m: number, d: number) => (y && /^\d{4}$/.test(y) ? `${y}-${pad(m)}-${pad(d)}` : `${pad(m)}-${pad(d)}`);
  let m = /\b(\d{4})-(\d{1,2})-(\d{1,2})\b/.exec(t);
  if (m && ok(+m[2]!, +m[3]!)) return withYear(m[1], +m[2]!, +m[3]!);
  const mon = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  m = new RegExp(`\\b${mon}\\.?\\s+(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?`).exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[1]!.slice(0, 3)) + 1;
    if (ok(mi, +m[2]!)) return withYear(m[3], mi, +m[2]!);
  }
  m = new RegExp(`\\b(\\d{1,2})(?!\\d)(?:st|nd|rd|th)?\\s+(?:of\\s+)?${mon}(?:,?\\s+(\\d{4}))?`).exec(t);
  if (m) {
    const mi = MONTHS.indexOf(m[2]!.slice(0, 3)) + 1;
    if (ok(mi, +m[1]!)) return withYear(m[3], mi, +m[1]!);
  }
  m = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(t);
  if (m && ok(+m[1]!, +m[2]!)) return withYear(m[3]?.length === 4 ? m[3] : undefined, +m[1]!, +m[2]!);
  return null;
}

/** "nothing", "no", "you're good", "go wild" = no boundaries. */
export const NO_RULES = /^(?:(?:uh+|um+|hm+)[,. ]+)*(?:no+|nope|nah|nothing|none|not really|nothing really|you'?re good|all good|go wild|anything goes|no rules|i'?m good|nothing comes to mind)\b[.!? ]*$/i;

function listFrom(text: string): string[] {
  const t = text
    .replace(/^(?:(?:uh+|um+|hm+|well|like|so|honestly)[,. ]+)*/i, "")
    .replace(/^(?:i'?m (?:into|really into)|i (?:like|love|do|build|make|study|work on)|mostly|probably|stuff like|things like)\s+/i, "")
    .replace(/[.!?]+$/, "");
  return t
    .split(/\s*(?:,|;|\band also\b|\band\b|\bplus\b|\bor\b)\s*/i)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2 && s.length <= 60)
    .slice(0, 8);
}

/** Instant, dependency-free read of an answer. null = not confident. */
export function regexExtract(step: OnboardingStepId, text: string): ProfilePatch | null {
  const t = text.trim();
  switch (step) {
    case "name": {
      const n = nameFrom(t);
      return n ? n : null;
    }
    case "herName": {
      const n = herNameFrom(t);
      return n ? { herName: n } : null;
    }
    case "birthday": {
      const b = birthdayFrom(t);
      return b ? { birthday: b } : null;
    }
    case "work": {
      const w = t.replace(/^(?:(?:uh+|um+|well|so)[,. ]+)*(?:i'?m (?:a|an)?|i (?:work (?:on|at|as)|do|build|study))\s*/i, "").replace(/[.!?]+$/, "");
      return w.split(/\s+/).length >= 1 && w.length >= 2 ? { work: w.slice(0, 160) } : null;
    }
    case "interests": {
      const l = listFrom(t);
      return l.length ? { interests: l } : null;
    }
    case "boundaries": {
      if (NO_RULES.test(t)) return { boundaries: [] };
      const b = t.replace(/^(?:(?:uh+|um+|well|so|yeah)[,. ]+)*(?:please\s+)?(?:don'?t|do not|never)\s+/i, "").replace(/[.!?]+$/, "");
      return b.length >= 3 ? { boundaries: [b.slice(0, 140)] } : null;
    }
  }
}

const FIELD_SPEC: Record<OnboardingStepId, string> = {
  name: `{"skip":false,"name":"their name as they'd write it, or null","callMe":"what to call them, lowercase, or null","pronouns":"only if they said, else null"}`,
  herName: `{"skip":false,"herName":"the name they want for the companion (Eve if they're fine with Eve), or null"}`,
  work: `{"skip":false,"work":"what they do / are working on, one short phrase, max 14 words, or null"}`,
  interests: `{"skip":false,"interests":["short interest", "..."]}`,
  birthday: `{"skip":false,"birthday":"MM-DD, or YYYY-MM-DD if a year was given, or null"}`,
  boundaries: `{"skip":false,"none":false,"boundaries":["short thing to never bring up or do, phrased as the topic/behavior"]}`,
};

const QUESTION: Record<OnboardingStepId, string> = {
  name: "what should i call you?",
  herName: "what do you want to call me (the companion, currently Eve)?",
  work: "what do you do / what are you working on?",
  interests: "what are you into?",
  birthday: "when's your birthday?",
  boundaries: "anything you don't want me to bring up or do?",
};

export const EXTRACT_SYSTEM = `You extract one answer from a spoken onboarding conversation between a companion and the person she lives with.
Return JSON only, in the exact shape given. Set "skip":true if they declined, deflected, or said skip/idk/later.
Keep their words; don't invent. Speech-to-text may mangle names: prefer the likeliest spelling. Never use em dashes.`;

/** Brain read of an answer, validated. null = brain missing, slow, or unusable. */
export async function brainExtract(brains: BrainService | null, step: OnboardingStepId, text: string, timeoutMs = 3000): Promise<{ skip: boolean; patch: ProfilePatch } | null> {
  if (!brains) return null;
  let raw: unknown;
  try {
    raw = await brains.quickJson(EXTRACT_SYSTEM, `question: ${QUESTION[step]}\nanswer: "${text.slice(0, 400)}"\nshape: ${FIELD_SPEC[step]}`, { timeoutMs });
  } catch {
    return null;
  }
  return parseBrainAnswer(step, raw);
}

export function parseBrainAnswer(step: OnboardingStepId, raw: unknown): { skip: boolean; patch: ProfilePatch } | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.skip === true) return { skip: true, patch: {} };
  const s = (v: unknown) => (typeof v === "string" && v.trim() && v.trim().toLowerCase() !== "null" ? v.trim() : undefined);
  const list = (v: unknown) => (Array.isArray(v) ? v.map(s).filter((x): x is string => !!x) : []);
  switch (step) {
    case "name": {
      const name = s(o.name);
      const callMe = s(o.callMe) ?? name?.split(/\s+/)[0]?.toLowerCase();
      if (!name && !callMe) return null;
      return { skip: false, patch: { ...(name ? { name } : {}), ...(callMe ? { callMe: callMe.toLowerCase() } : {}), ...(s(o.pronouns) ? { pronouns: s(o.pronouns) } : {}) } };
    }
    case "herName": {
      const n = s(o.herName);
      return n ? { skip: false, patch: { herName: n.split(/\s+/).slice(0, 2).join(" ") } } : null;
    }
    case "work": {
      const w = s(o.work);
      return w ? { skip: false, patch: { work: w } } : null;
    }
    case "interests": {
      const l = list(o.interests);
      return l.length ? { skip: false, patch: { interests: l } } : null;
    }
    case "birthday": {
      const b = s(o.birthday);
      const norm = b ? birthdayFrom(b) : null;
      return norm ? { skip: false, patch: { birthday: norm } } : null;
    }
    case "boundaries": {
      if (o.none === true) return { skip: false, patch: { boundaries: [] } };
      const l = list(o.boundaries);
      return l.length ? { skip: false, patch: { boundaries: l } } : { skip: false, patch: { boundaries: [] } };
    }
  }
}

/** Where regex alone is trustworthy enough to skip the brain round trip. */
function regexIsEnough(step: OnboardingStepId, text: string, patch: ProfilePatch | null): boolean {
  if (!patch) return false;
  const n = words(text).length;
  if (step === "birthday") return true;
  if (step === "boundaries") return NO_RULES.test(text.trim());
  if (step === "name" || step === "herName") return n <= 4;
  return false;
}

/** skip / pause / value / none. Regex first when it's certain, brain otherwise, regex as the fallback. */
export async function extractAnswer(brains: BrainService | null, step: OnboardingStepId, text: string, timeoutMs = 3000): Promise<Extracted> {
  const t = text.trim();
  if (!t) return { kind: "none" };
  if (PAUSE.test(t)) return { kind: "pause" };
  if (SKIP.test(t)) return { kind: "skip" };
  const quick = regexExtract(step, t);
  if (regexIsEnough(step, t, quick)) return { kind: "value", patch: quick!, by: "regex" };
  const b = await brainExtract(brains, step, t, timeoutMs);
  if (b?.skip) return { kind: "skip" };
  if (b) return { kind: "value", patch: b.patch, by: "brain" };
  return quick ? { kind: "value", patch: quick, by: "regex" } : { kind: "none" };
}
