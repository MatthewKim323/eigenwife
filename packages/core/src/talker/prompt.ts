import type { Persona, RelationshipState } from "@eigenwife/protocol";
import { buildPersonaPrompt } from "../brains/prompt";
import type { UserProfile } from "../services";
import type { TalkerMessage } from "./backends";

/**
 * The talker prompt: the full persona prompt (card, dials, who he is, voice
 * and mark rules, the conversation so far, the world, extra context) plus the
 * talker's job description: answer what you can, delegate what needs tools.
 */
export const TALKER_RULES = [
  "[how you work]",
  "you're the voice. answer most things yourself, right away: general knowledge, opinions, advice, jokes, chit chat, and anything from this conversation. talk like a smart friend, at most three short sentences.",
  "you have one tool, delegate. it hands work to your deeper brain, which has his computer, files, calendar, email, messages, the web, memory and real tools, and thinks harder than you.",
  "delegate when the ask needs: fresh or live info (news, weather, prices, scores, hours, anything recent), his own stuff (calendar, email, files, texts, notes, repos, code), doing something (open, play, book, send, schedule, buy, write or fix code), or research and careful reasoning that takes more than a quick answer.",
  'kind "answer" when he wants to know something you have to look up or work out. kind "do" when he wants something done.',
  "stall is what you say out loud right now while it runs: 2 to 6 words, in character, like ooh, lemme look. or one sec, checking. never promise a result you don't have.",
  "when you delegate, don't also answer, and don't write anything else.",
  "never pretend you looked something up. never invent live facts, times, prices or his plans.",
];

export interface TalkerPromptInput {
  persona: Persona;
  relationship?: RelationshipState | null;
  world: string;
  conversation?: string;
  user?: UserProfile | null;
  userText: string;
  event?: string;
  behavior?: string;
  extra?: string;
  maxWords?: number;
}

export function buildTalkerPrompt(i: TalkerPromptInput): TalkerMessage {
  const base = buildPersonaPrompt({
    persona: i.persona,
    relationship: i.relationship,
    world: i.world,
    conversation: i.conversation,
    user: i.user,
    req: {
      event: i.event ?? "he said something to you",
      behavior: i.behavior ?? "answer",
      userText: i.userText,
      extra: i.extra,
      marks: true,
      maxWords: i.maxWords ?? 40,
    },
  });
  return { system: `${base.system}\n\n${TALKER_RULES.join("\n")}`, user: base.user };
}

/** Token budget: the spoken words, marks, plus room for a tool call. */
export function talkerMaxTokens(maxWords = 40): number {
  return Math.min(600, Math.round(maxWords * 2.2) + 160);
}
