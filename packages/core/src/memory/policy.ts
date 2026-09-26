import type { MemoryRecord, MemoryWritePolicy, RelationshipState } from "@eigenwife/protocol";
import type { BrainService } from "../services";

/**
 * Write policy: decide what (if anything) to remember from an exchange.
 *
 *   IGNORE_EVENT         nothing worth keeping
 *   STORE_SHORT_TERM     useful for this session only (working memory)
 *   STORE_LONG_TERM      a durable fact or episode
 *   UPDATE_PREFERENCE    a stable like/dislike or style preference
 *   UPDATE_RELATIONSHIP  how the user reacted to Eve (feeds relationship scalars)
 *
 * The brain (brains.quickJson) classifies and extracts compact third-person
 * facts. Without a brain, or when it fails, a transparent keyword policy runs.
 */

export interface ExtractedFact {
  content: string;
  kind: MemoryRecord["kind"];
  importance: number;
  confidence: number;
  policy: MemoryWritePolicy;
  tags?: string[];
}

export interface PolicyDecision {
  policy: MemoryWritePolicy;
  facts: ExtractedFact[];
  relationship?: Partial<RelationshipState>;
  by: "brain" | "keywords";
}

export interface Exchange {
  user?: string;
  eve?: string;
  event?: string;
}

const POLICIES: MemoryWritePolicy[] = ["IGNORE_EVENT", "STORE_SHORT_TERM", "STORE_LONG_TERM", "UPDATE_PREFERENCE", "UPDATE_RELATIONSHIP"];
const KINDS: MemoryRecord["kind"][] = ["episodic", "preference", "fact"];

export const POLICY_SYSTEM = `You are the memory write policy of Eve, a companion AI. Given one exchange, decide what to remember about the USER.
Return JSON only:
{"policy":"IGNORE_EVENT|STORE_SHORT_TERM|STORE_LONG_TERM|UPDATE_PREFERENCE|UPDATE_RELATIONSHIP",
 "facts":[{"content":"compact third-person fact, max 12 words, no names","kind":"preference|fact|episodic","importance":0.0-1.0,"confidence":0.0-1.0,"policy":"<one of the policies>"}],
 "relationship":{"banter":delta,"warmth":delta,"initiative":delta,"verbosity":delta,"confidence":delta}}
Rules: most small talk is IGNORE_EVENT with no facts. Likes/dislikes/style -> UPDATE_PREFERENCE (kind preference, e.g. "Prefers concise responses").
Goals, schedule, life facts -> STORE_LONG_TERM (kind fact, e.g. "Trying to save money this month"). Notable moments/complaints -> STORE_LONG_TERM (kind episodic).
Things only relevant right now -> STORE_SHORT_TERM. Reactions to Eve (laughing at a tease, telling her to stop) -> UPDATE_RELATIONSHIP with small deltas (+-0.02 to 0.05).
Never store secrets, passwords, or payment details.`;

function clamp01(n: unknown, d: number): number {
  const x = typeof n === "number" && Number.isFinite(n) ? n : d;
  return Math.max(0, Math.min(1, x));
}

/** Validate a brain answer. Anything malformed becomes null so the keyword path runs. */
export function parseDecision(raw: unknown): PolicyDecision | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const policy = POLICIES.includes(o.policy as MemoryWritePolicy) ? (o.policy as MemoryWritePolicy) : null;
  if (!policy) return null;
  const facts: ExtractedFact[] = [];
  for (const f of Array.isArray(o.facts) ? o.facts : []) {
    if (!f || typeof f !== "object") continue;
    const x = f as Record<string, unknown>;
    const content = typeof x.content === "string" ? x.content.trim().slice(0, 160) : "";
    if (!content || looksSensitive(content)) continue;
    const fp = POLICIES.includes(x.policy as MemoryWritePolicy) ? (x.policy as MemoryWritePolicy) : policy;
    if (fp === "IGNORE_EVENT") continue;
    facts.push({
      content,
      kind: KINDS.includes(x.kind as MemoryRecord["kind"]) ? (x.kind as MemoryRecord["kind"]) : kindFor(fp),
      importance: clamp01(x.importance, 0.5),
      confidence: clamp01(x.confidence, 0.7),
      policy: fp,
    });
  }
  let relationship: Partial<RelationshipState> | undefined;
  if (o.relationship && typeof o.relationship === "object") {
    relationship = {};
    for (const key of ["banter", "warmth", "initiative", "verbosity", "confidence"] as const) {
      const v = (o.relationship as Record<string, unknown>)[key];
      if (typeof v === "number" && Number.isFinite(v) && v !== 0) relationship[key] = Math.max(-0.1, Math.min(0.1, v));
    }
    if (!Object.keys(relationship).length) relationship = undefined;
  }
  return { policy, facts, relationship, by: "brain" };
}

function kindFor(p: MemoryWritePolicy): MemoryRecord["kind"] {
  return p === "UPDATE_PREFERENCE" ? "preference" : p === "STORE_LONG_TERM" ? "fact" : "episodic";
}

export function looksSensitive(s: string): boolean {
  return /\b(password|passcode|pin code|ssn|social security|credit card|card number|cvv|api key|secret key)\b/i.test(s) || /\b\d{12,19}\b/.test(s);
}

// --- keyword fallback -----------------------------------------------------------

function clean(s: string, max = 70): string {
  let t = s
    .replace(/\s+/g, " ")
    .replace(/[.!?,;:]+$/g, "")
    .trim();
  t = t.replace(/\bmy\b/gi, "their").replace(/\bi'?m\b/gi, "they're").replace(/\bme\b/gi, "them").replace(/\bmyself\b/gi, "themselves");
  if (t.length > max) t = t.slice(0, max).replace(/\s+\S*$/, "");
  return t;
}

/** Cut a captured phrase at the end of its clause: "spicy food but I'm broke" -> "spicy food". */
function clause(s: string): string {
  return s.split(/[.,;!?]|\s(?:but|and|because|though|although|so|except|unless|when)\s/i)[0]!;
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

interface Rule {
  re: RegExp;
  make: (m: RegExpMatchArray) => Omit<ExtractedFact, "confidence"> & { confidence?: number };
}

const RULES: Rule[] = [
  {
    re: /\b(too long|shorter|tl;?dr|get to the point|less words|stop rambling|be brief|keep it short|just the answer)\b/i,
    make: () => ({ content: "Prefers concise responses", kind: "preference", importance: 0.72, policy: "UPDATE_PREFERENCE", tags: ["style"] }),
  },
  {
    re: /\b(more detail|explain more|elaborate|go deeper)\b/i,
    make: () => ({ content: "Sometimes wants more detailed explanations", kind: "preference", importance: 0.5, policy: "UPDATE_PREFERENCE", tags: ["style"] }),
  },
  {
    re: /\bi\s+(?:really\s+|kinda\s+|kind of\s+|totally\s+|honestly\s+)?(hate|can'?t stand|cannot stand|don'?t like|do not like|dislike|am not into|'?m not into|'m not a fan of|am not a fan of)\s+(.{3,80})/i,
    make: (m) => ({ content: `Dislikes ${clean(clause(m[2]!))}`, kind: "preference", importance: 0.6, policy: "UPDATE_PREFERENCE" }),
  },
  {
    re: /\bi\s+(?:really\s+|kinda\s+|kind of\s+|totally\s+|honestly\s+)?(love|like|prefer|enjoy|adore|am into|'m into)\s+(.{3,80})/i,
    make: (m) => ({ content: `Likes ${clean(clause(m[2]!))}`, kind: "preference", importance: 0.6, policy: "UPDATE_PREFERENCE" }),
  },
  {
    re: /\bi'?m\s+(trying to|going to|planning to|saving|working on|learning)\s+(.{3,80})/i,
    make: (m) => ({
      content: cap(`${m[1]!.toLowerCase().startsWith("saving") ? "saving" : m[1]!.toLowerCase()} ${clean(clause(m[2]!))}`),
      kind: "fact",
      importance: 0.65,
      policy: "STORE_LONG_TERM",
      tags: ["goal"],
    }),
  },
  {
    re: /\b(save money|saving money|on a budget|tight on money|broke this month)\b/i,
    make: () => ({ content: "Trying to save money", kind: "fact", importance: 0.7, policy: "STORE_LONG_TERM", tags: ["money", "goal"] }),
  },
  {
    re: /\bmy\s+(name|birthday|job|boss|girlfriend|boyfriend|partner|sister|brother|mom|dad|best friend|roommate|cat|dog)\s+(?:is|'s)\s+(.{2,60})/i,
    make: (m) => ({ content: `Their ${m[1]!.toLowerCase()} is ${clean(clause(m[2]!), 50)}`, kind: "fact", importance: 0.6, policy: "STORE_LONG_TERM" }),
  },
  {
    re: /\bi\s+(work|live|study)\s+(at|in|as|on|from)\s+(.{2,60})/i,
    make: (m) => ({ content: `${cap(m[1]!.toLowerCase())}s ${m[2]!.toLowerCase()} ${clean(clause(m[3]!), 50)}`, kind: "fact", importance: 0.55, policy: "STORE_LONG_TERM" }),
  },
  {
    re: /\b(overpriced|too expensive|rip.?off|so expensive|way too much|highway robbery)\b/i,
    make: (m) => ({
      content: `Complained something was overpriced (${clean(m.input ?? "", 50)})`,
      kind: "episodic",
      importance: 0.5,
      policy: "STORE_LONG_TERM",
      tags: ["money"],
    }),
  },
];

const LAUGH = /\b(lol|lmao|lmfao|haha+|hehe|rofl)\b|😂|🤣|you'?re (so )?funny|stop it you/i;
const REBUFF = /\b(not now|go away|stop talking|so annoying|be quiet|shut up already|leave me alone)\b/i;

export function keywordPolicy(ex: Exchange): PolicyDecision {
  const user = (ex.user ?? "").trim();
  const facts: ExtractedFact[] = [];
  let relationship: Partial<RelationshipState> | undefined;

  if (user && !looksSensitive(user)) {
    const seen = new Set<string>();
    for (const rule of RULES) {
      const m = user.match(rule.re);
      if (!m) continue;
      const f = rule.make(m);
      const key = f.content.toLowerCase();
      if ([...seen].some((k) => k.includes(key) || key.includes(k))) continue;
      seen.add(key);
      facts.push({ confidence: 0.7, ...f });
    }
    if (REBUFF.test(user)) {
      relationship = { initiative: -0.04 };
      facts.push({ content: "Told Eve to back off", kind: "episodic", importance: 0.35, confidence: 0.7, policy: "UPDATE_RELATIONSHIP", tags: ["relationship"] });
    } else if (LAUGH.test(user)) {
      relationship = { banter: 0.03, warmth: 0.01 };
      const about = ex.eve ? `: "${clean(ex.eve, 50)}"` : "";
      facts.push({ content: `Laughed at Eve's teasing${about}`, kind: "episodic", importance: 0.35, confidence: 0.75, policy: "UPDATE_RELATIONSHIP", tags: ["humor", "relationship"] });
    }
  }

  if (!facts.length && ex.event && !user) {
    facts.push({ content: clean(ex.event, 90), kind: "episodic", importance: 0.2, confidence: 0.9, policy: "STORE_SHORT_TERM", tags: ["event"] });
  }

  const rank: MemoryWritePolicy[] = ["UPDATE_PREFERENCE", "STORE_LONG_TERM", "UPDATE_RELATIONSHIP", "STORE_SHORT_TERM"];
  const policy = rank.find((p) => facts.some((f) => f.policy === p)) ?? "IGNORE_EVENT";
  return { policy, facts, relationship, by: "keywords" };
}

export async function decide(ex: Exchange, brains: BrainService | null, timeoutMs = 2500): Promise<PolicyDecision> {
  if (brains) {
    const user = [ex.event && `event: ${ex.event}`, ex.user && `user: ${ex.user}`, ex.eve && `eve: ${ex.eve}`].filter(Boolean).join("\n");
    try {
      const raw = await brains.quickJson(POLICY_SYSTEM, user, { timeoutMs });
      const d = parseDecision(raw);
      if (d) return d;
    } catch {}
  }
  return keywordPolicy(ex);
}
