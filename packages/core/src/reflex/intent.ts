/**
 * Cheap, transparent read of what an utterance is asking for. Used by the
 * local Jev scorer (features) and the router (behavior, goal extraction).
 * Deliberately keyword based: it runs on every utterance in well under 1ms.
 */

export interface UtteranceIntent {
  /** "wait", "stop", "nvm": shut up now. */
  stop: boolean;
  /** "figure out", "plan", "book": a real-world multi-step task. */
  task: boolean;
  /** "close it", "quit spotify": one small immediate action. */
  command: { kind: string; app?: string } | null;
  /** "how do i", "help me". */
  help: boolean;
  question: boolean;
  /** "this", "that one", "thoughts?": refers to whatever they're looking at. */
  deictic: boolean;
  laugh: boolean;
  /** "sad", "rough day": wants comfort, not jokes. */
  down: boolean;
  /** "yeah", "do it", "nah": probably answering an approval prompt. */
  approval: boolean;
  /** "um", "hmm", "ok": nothing to answer. */
  filler: boolean;
  words: number;
}

const STOP =
  /^(?:wait|stop|nvm|never\s*mind|hold on|hang on|shh+|shush|quiet|shut up|be quiet|not now|enough|pause|cancel that|nevermind|okay stop|ok stop)\b[\s.!,]*(?:please|eve)?[\s.!]*$|^(?:wait|stop|hold on)[,.!]|\b(?:stop talking|shut up|not now|be quiet)\b/i;
const TASK =
  /\b(?:figure (?:it |this |that )?out|figure out|plan(?:s|ning)?(?: for| out| my| a| our| the)?|book(?: me| us| a| it)?|reserve|reservation|schedule|put (?:it|that|this) (?:in|on) (?:my|the) calendar|find (?:me|us) (?:a|an|some|somewhere)|look (?:it |this |that )?up|research|order (?:me|us)|sort (?:it|this) out|no idea what i'?m doing|what should i do tonight|organize|compare)\b/i;
const HELP = /\b(?:how do i|how can i|help me|can you help|could you help|walk me through|explain|what does .* mean)\b/i;
const QUESTION_START =
  /^(?:who|what|whats|what's|when|where|why|how|which|is|are|was|were|do|does|did|should|could|would|can|will|shall|thoughts|any thoughts|opinion|yay or nay)\b/i;
const DEICTIC = /\b(?:this|that|these|those|this one|that one|the one|it|here|there)\b|^thoughts\??$|^(?:yay or nay|opinion)\??$/i;
const LAUGH = /\b(?:lol+|lmao+|lmfao|haha+|hehe+|rofl|dead|i'?m crying)\b|😂|🤣|💀/i;
const DOWN = /\b(?:sad|depressed|lonely|rough day|bad day|tired|exhausted|stressed|breakup|broke up|dumped|miss (?:her|him|them)|cry(?:ing)?|anxious|overwhelmed)\b/i;
const APPROVAL = /^(?:yeah|yea|yes|yep|yup|sure|ok(?:ay)?|do it|go(?: for it| ahead)?|lock it in|send it|nah|no|nope|don'?t)\b[\s.!]*$/i;
const FILLER = /^(?:um+|uh+|hm+|mm+|hmm+|ah+|oh|ok|okay|k|cool|nice|right)[\s.!?]*$/i;
const COMMAND = /\b(?:close|quit|kill|exit)\s+(?:the\s+)?(?:(it|that|this|dating app|eigen|[a-z][\w ]{1,20}?))(?:\s+app)?[\s.!]*$/i;

export function readIntent(text: string): UtteranceIntent {
  const t = text.trim();
  const words = t ? t.split(/\s+/).length : 0;
  const stop = STOP.test(t) && words <= 6;
  const cmd = COMMAND.exec(t);
  let command: UtteranceIntent["command"] = null;
  if (cmd && words <= 7) {
    const raw = (cmd[1] ?? "").trim().toLowerCase();
    const app = raw === "it" || raw === "that" || raw === "this" ? undefined : raw === "dating app" || raw === "eigen" ? "Eigen" : cmd[1]!.trim();
    command = { kind: "shell.close_app", app };
  }
  const question = /\?\s*$/.test(t) || QUESTION_START.test(t);
  return {
    stop,
    task: !stop && TASK.test(t),
    command: stop ? null : command,
    help: HELP.test(t),
    question,
    deictic: DEICTIC.test(t) && words <= 12,
    laugh: LAUGH.test(t),
    down: DOWN.test(t),
    approval: APPROVAL.test(t),
    filler: FILLER.test(t),
    words,
  };
}

/** Turn "can you figure out dinner for tonight?" into a goal line for the agency. */
export function goalFrom(text: string): string {
  let g = text.trim().replace(/[?!.]+$/, "");
  g = g.replace(/^(?:hey |yo |ok |okay |so |um |uh )+/i, "");
  g = g.replace(/^(?:eve[, ]+)?(?:can you|could you|would you|will you|please|pls|i need you to|help me|i want you to)\s+/i, "");
  return g.charAt(0).toUpperCase() + g.slice(1);
}
