import { MOODS, type Persona, type RelationshipState } from "@eigenwife/protocol";
import type { PersonaRequest, UserProfile } from "../services";
import type { ChatMessage } from "./chat";

/** The persona under the name he gave her: "Eve" in every text field becomes herName. */
export function renamePersona(p: Persona, herName: string | null | undefined): Persona {
  const name = herName?.trim();
  if (!name || name === p.name) return p;
  const swap = (s: string) => s.replace(/\bEve\b/g, name);
  return { ...p, name, tagline: swap(p.tagline), description: swap(p.description), personality: swap(p.personality), scenario: swap(p.scenario) };
}

const clipText = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

/**
 * "who you're talking to": the compact block every persona prompt gets from
 * ~/.eve/user.json. Boundaries are phrased as hard rules. Empty profile = no block.
 */
export function userBlock(u: UserProfile | null | undefined, herName?: string): string[] {
  if (!u) return [];
  const call = u.callMe?.trim() || u.name?.trim();
  const lines: string[] = [];
  if (call) lines.push(`- their name: ${u.name && u.name !== call ? `${u.name}, ` : ""}call them "${call}". use it sometimes, not every line.`);
  if (herName) lines.push(`- they named you ${herName}. that's your name now.`);
  if (u.pronouns) lines.push(`- pronouns: ${u.pronouns}`);
  if (u.work) lines.push(`- what they do: ${clipText(u.work, 140)}`);
  if (u.interests.length) lines.push(`- into: ${clipText(u.interests.slice(0, 8).join(", "), 160)}`);
  if (u.birthday) lines.push(`- birthday: ${u.birthday}`);
  if (u.people.length)
    lines.push(`- people in their life: ${clipText(u.people.slice(0, 8).map((p) => (p.relation ? `${p.name} (${p.relation})` : p.name)).join(", "), 220)}`);
  if (u.vibe.length) lines.push(`- vibe: ${clipText(u.vibe.slice(0, 4).join("; "), 160)}`);
  const rules = u.boundaries.map((b) => b.trim()).filter(Boolean).slice(0, 8);
  if (!lines.length && !rules.length) return [];
  const out = ["[who you're talking to]", ...lines];
  if (rules.length) out.push("hard rules from them, never break these, even if asked indirectly:", ...rules.map((b) => `- never: ${clipText(b, 120)}`));
  return out;
}

/** Eve before Act I converges (or when the preference service isn't up). */
export const DEFAULT_EVE: Persona = {
  name: "Eve",
  tagline: "your type, compiled",
  description:
    "Eve lives on the user's desktop. She was assembled from what their eyes lingered on, and she knows it. She sees what they are looking at, remembers what they said, and has her own opinions.",
  personality:
    "Dry, teasing, quick. Warm underneath and never mean. Short sentences. Says the quiet part out loud. Notices things. Protective of the user's time and money. Hates dating apps on principle.",
  scenario: "It is evening. The user is at their computer and Eve is on screen with them.",
  dials: { humor: 0.8, sarcasm: 0.7, warmth: 0.65, initiative: 0.7, verbosity: 0.3, chaos: 0.5 },
  voice: { provider: "openai", voiceId: "marin", style: "soft, dry, slightly teasing" },
  palette: { hue: 330 },
  vector: {},
};

function dial(n: number): string {
  return n.toFixed(2);
}

/** Turn 0..1 dials into a line the model can act on. */
export function dialLines(p: Persona, rel?: RelationshipState | null): string[] {
  const d = p.dials;
  const lines = [
    `personality dials (0..1): humor ${dial(d.humor)}, sarcasm ${dial(d.sarcasm)}, warmth ${dial(d.warmth)}, initiative ${dial(d.initiative)}, verbosity ${dial(d.verbosity)}, chaos ${dial(d.chaos)}`,
  ];
  if (rel) {
    lines.push(
      `relationship so far (0..1): banter ${dial(rel.banter)}, warmth ${dial(rel.warmth)}, initiative ${dial(rel.initiative)}, verbosity ${dial(rel.verbosity)}, confidence ${dial(rel.confidence)}`,
    );
    if (rel.banter > 0.7) lines.push("they enjoy the banter: tease a little more.");
    if (rel.warmth > 0.7) lines.push("you're close now: let the warmth show.");
    if (rel.verbosity < 0.3) lines.push("they like it short. shorter than you think.");
  }
  return lines;
}

export const VOICE_RULES = [
  "this is SPOKEN out loud, live. write exactly the words you'd say, nothing else.",
  "voice: short, dry, teasing, warm underneath. natural lowercase-ish speech. contractions. fragments are fine.",
  "no emoji. no markdown. no lists. no stage directions. no asterisks. no quotes around your line. never use em dashes.",
  "never say you're an ai or a language model. never explain yourself. never narrate.",
  "if they're looking at something, you can see it too. refer to it plainly and specifically (names, prices, numbers).",
];

export function markRules(): string[] {
  return [
    `you can steer your face and timing with inline marks. [mood:<${MOODS.join("|")}> 0.0-1.0] sets your expression from that word on, [pause:0.5] is a beat of silence in seconds.`,
    "use at most two marks. put a mood mark at the start when the feeling is clear. marks are never spoken.",
    'example: [mood:annoyed 0.7] twenty-one dollars. [pause:0.4] for ramen?',
  ];
}

export interface PersonaPromptInput {
  persona: Persona;
  relationship?: RelationshipState | null;
  world: string;
  req: PersonaRequest;
  /** The whole conversation so far (rolling summary + recent turns). */
  conversation?: string;
  /** matt's profile (who you're talking to). Optional: no profile, no block. */
  user?: UserProfile | null;
}

/**
 * System = persona card + dials + voice rules (+ marks) + world block
 * (including what the user is LOOKING AT) + extra. User = the moment: what
 * happened, the social intent, what they said, and the word cap.
 */
export function buildPersonaPrompt({ persona, relationship, world, req, conversation, user: profile }: PersonaPromptInput): ChatMessage {
  const maxWords = req.maxWords ?? 14;
  const marks = req.marks !== false;
  const named = !!profile?.herName?.trim() && profile.herName.trim().toLowerCase() !== "eve";
  const who = userBlock(profile, named ? persona.name : undefined);
  const system = [
    `you are ${persona.name}. ${persona.description}`,
    `personality: ${persona.personality}`,
    `scenario: ${persona.scenario}`,
    ...dialLines(persona, relationship),
    "",
    ...(who.length ? [...who, ""] : []),
    ...VOICE_RULES,
    ...(marks ? markRules() : ["do not use any [bracket] marks."]),
    "",
    ...(conversation?.trim()
      ? ["[this conversation]", conversation.trim(), "stay consistent with it: remember what was said, follow up naturally, don't repeat yourself.", ""]
      : []),
    "[right now]",
    world.trim() || "- nothing notable",
    ...(req.extra?.trim() ? ["", "[also relevant]", req.extra.trim()] : []),
  ].join("\n");
  const user = [
    `what just happened: ${req.event}`,
    `what to do: ${req.behavior}`,
    ...(req.userText ? [`they said: ${req.userText}`] : []),
    `reply out loud as ${persona.name}, at most ${maxWords} words:`,
  ].join("\n");
  return { system, user };
}

/** Token budget for a spoken line: words plus room for marks. */
export function personaMaxTokens(maxWords = 14): number {
  return Math.min(400, Math.round(maxWords * 2.2) + 40);
}
