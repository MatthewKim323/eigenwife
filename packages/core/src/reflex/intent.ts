import { readDraftEdit, readWorkIntent } from "../work/intent";

/**
 * Cheap, transparent read of what an utterance is asking for. Used by the
 * local Jev scorer (features) and the router (behavior, goal extraction).
 * Deliberately keyword based: it runs on every utterance in well under 1ms.
 */
import { readOutfit, type OutfitIntent } from "./outfit";

export interface UtteranceIntent {
  /** "wait", "stop", "nvm": shut up now. */
  stop: boolean;
  /** "figure out", "plan", "book": a real-world multi-step task. */
  task: boolean;
  /** "close it", "quit spotify": one small immediate action. app undefined means "whatever is open". */
  command: { kind: "close"; app?: string } | null;
  /** "let's listen to music", "play our song", "play <x>", "pause", "skip". */
  music: { op: "play" | "pause" | "resume" | "next" | "previous"; query?: string } | null;
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
  /** "put your hoodie on", "lose the shades", "what are you wearing" (outfit.ts). */
  outfit: OutfitIntent | null;
  /** "show me", "do it yourself", "open it": she does it herself in her own visible browser (docs/AGENT_CURSOR.md). */
  browse: { query?: string } | null;
  /** "fix the flaky test in eigenwife", "find my resume", "what's due": a work ask (docs/WORK.md). */
  work: boolean;
  words: number;
}

const STOP =
  /^(?:wait|stop|nvm|never\s*mind|hold on|hang on|shh+|shush|quiet|shut up|be quiet|not now|enough|pause|cancel that|nevermind|okay stop|ok stop)\b[\s.!,]*(?:please|eve)?[\s.!]*$|^(?:wait|stop|hold on)[,.!]|\b(?:stop talking|shut up|not now|be quiet)\b/i;
const TASK =
  /\b(?:figure (?:it |this |that )?out|figure out|plan(?:s|ning)?(?: for| out| my| a| our| the)?|book(?: me| us| a| it)?|reserve|reservation|schedule|put (?:it|that|this) (?:in|on) (?:my|the) calendar|find (?:me|us) (?:a|an|some|somewhere)|look (?:it |this |that )?up|research|order (?:me|us)|sort (?:it|this) out|no idea what i'?m doing|what should i do tonight|organize|compare)\b/i;
const HELP = /\b(?:how do i|how can i|help me|can you help|could you help|walk me through|explain|what does .* mean)\b/i;
const QUESTION_START =
  /^(?:who|what|whats|what's|when|where|why|how|which|is|are|was|were|do|does|did|should|could|would|can|will|shall|thoughts|any thoughts|opinion|yay or nay)\b/i;
const DEICTIC = /\b(?:this|that|these|those|this one|that one|the one|this place|over here)\b|^thoughts\??$|^(?:yay or nay|opinion)\??$/i;
const LAUGH = /\b(?:lol+|lmao+|lmfao|haha+|hehe+|rofl|dead|i'?m crying)\b|😂|🤣|💀/i;
const DOWN = /\b(?:sad|depressed|lonely|rough day|bad day|tired|exhausted|stressed|breakup|broke up|dumped|miss (?:her|him|them)|cry(?:ing)?|anxious|overwhelmed)\b/i;
const APPROVAL = /^(?:yeah|yea|yes|yep|yup|sure|ok(?:ay)?|do it|go(?: for it| ahead)?|lock it in|send it|nah|no|nope|don'?t)\b[\s.!]*$/i;
const FILLER = /^(?:um+|uh+|hm+|mm+|hmm+|ah+|oh|ok|okay|k|cool|nice|right)[\s.!?]*$/i;
const MUSIC_PLAY =
  /^(?:(?:yo|hey|ok(?:ay)?|eve)[,\s]+)*(?:let'?s|lets|can we|can you|could you|wanna|want to|please)?\s*(?:listen to|play|put on|throw on|bump|queue up|spin)\s+(.{1,60}?)(?:\s+(?:bro|please|for me|on spotify|rn|now))*[\s.!?]*$/i;
const MUSIC_VIBE = /\b(?:let'?s|lets)\s+(?:listen to|vibe to|play)\s+(?:some\s+)?music\b|\b(?:music time|drop the beat|put some music on)\b/i;
const MUSIC_CTRL: [RegExp, "pause" | "resume" | "next" | "previous"][] = [
  [/^(?:(?:yo|eve)[,\s]+)?(?:pause|stop)\s+(?:the\s+)?(?:music|song|spotify)\b|^pause(?: it)?[\s.!]*$/i, "pause"],
  [/^(?:(?:yo|eve)[,\s]+)?(?:skip|next)(?:\s+(?:it|this|song|track|this song|this one))?[\s.!]*$|\bnext song\b|\bskip (?:this|the) (?:song|track)\b/i, "next"],
  [/\b(?:previous|last) (?:song|track)\b|^go back[\s.!]*$/i, "previous"],
  [/^(?:(?:yo|eve)[,\s]+)?(?:resume|unpause|keep playing|play it again|turn (?:it|the music) back on)\b/i, "resume"],
];
const COMMAND = /\b(?:close|quit|kill|exit)\s+(?:the\s+)?(?:(it|that|this|dating app|eigen|[a-z][\w ]{1,20}?))(?:\s+app)?[\s.!]*$/i;

const LEAD = /^(?:(?:yo|hey|ok(?:ay)?|eve|so|and)[,\s]+)*(?:(?:can|could|would) you\s+|please\s+)?/i;
/** "it" in "show me" / "open it": whatever she found last (or the page he's on). */
const BROWSE_BARE =
  /^(?:show me(?: it| that| this| the (?:place|restaurant|spot|menu|hours|site|website))?|show it to me|open (?:it|that|this)(?: up)?|pull (?:it|that) up|let me see(?: it)?|do it yourself|you do it|go look(?: at it)?|look at it yourself)(?:\s+(?:on|in) (?:your|the) browser)?(?:\s+(?:please|pls|eve|for me))*$/i;
/** "show me X in your browser", "open X in your browser": X is a query or a site. */
const BROWSE_IN = /^(?:show me|open|pull up|look up|go to|search)\s+(.{2,80}?)\s+(?:on|in) (?:your|the) browser$/i;
/** "show me ramen places near irvine": web-shaped things, never "show me my resume". */
const BROWSE_WEB = /^show me\s+(?!my\b)(.{2,80})$/i;
const WEBBY = /\b(?:restaurants?|places?|spots?|menu|hours|website|site|reviews?|near(?:by| me)?|open now|directions|map|maps)\b|\.(?:com|org|net|io|ai|dev)\b/i;

export function readBrowse(text: string): UtteranceIntent["browse"] {
  const t = text.trim().replace(/[\s.!?]+$/, "").replace(LEAD, "").trim();
  if (!t || t.split(/\s+/).length > 14) return null;
  if (BROWSE_BARE.test(t)) return {};
  const inb = BROWSE_IN.exec(t);
  if (inb) return /^(?:it|that|this)$/i.test(inb[1]!.trim()) ? {} : { query: inb[1]!.trim() };
  const web = BROWSE_WEB.exec(t);
  if (web && WEBBY.test(web[1]!)) return { query: web[1]!.trim() };
  return null;
}

/** "Yo.", "hey,", "ok so", "eve," in front of a request: drop them so the request itself parses. */
export function stripOpeners(text: string): string {
  return text.trim().replace(/^(?:(?:yo+|hey+|hi|ok(?:ay)?|so|um+|uh+|bro|dude|eve|babe|alright|aight)[\s,.!?]+)+/i, "").trim() || text.trim();
}

export function readIntent(text: string): UtteranceIntent {
  const t = stripOpeners(text);
  const words = t ? t.split(/\s+/).length : 0;
  const stop = STOP.test(t) && words <= 6;
  const cmd = COMMAND.exec(t);
  let command: UtteranceIntent["command"] = null;
  if (cmd && words <= 7) {
    const raw = (cmd[1] ?? "").trim().toLowerCase();
    const app = raw === "it" || raw === "that" || raw === "this" ? undefined : raw === "dating app" || raw === "eigen" ? "Eigen" : cmd[1]!.trim();
    command = { kind: "close", app };
  }
  let music: UtteranceIntent["music"] = null;
  if (!stop && words <= 12) {
    const ctrl = MUSIC_CTRL.find(([re]) => re.test(t));
    if (ctrl) music = { op: ctrl[1] };
    else if (MUSIC_VIBE.test(t)) music = { op: "play" };
    else {
      const m = MUSIC_PLAY.exec(t);
      // "play" + something that isn't a game or a task ("play league", "play it cool" stay chat).
      if (m && !/\b(?:league|valorant|fortnite|minecraft|chess|games?|it cool|dumb|along|around|with)\b/i.test(m[1]!)) {
        const q = m[1]!.replace(/^(?:some|a|the|our|my)\s+/i, (x) => (/^(?:our|my)\s/i.test(x) ? x : "")).trim();
        music = { op: "play", query: /^(?:music|a song|something|some music|song)$/i.test(q) ? undefined : q };
      }
    }
  }
  // Clothes beat music: "put on your pajamas" is an outfit, not a song.
  const outfit = stop ? null : readOutfit(t);
  if (outfit) music = null;
  const question = /\?\s*$/.test(t) || QUESTION_START.test(t);
  const browse = stop || music || outfit ? null : readBrowse(t);
  return {
    stop,
    task: !stop && !browse && TASK.test(t),
    command: stop || music || browse || outfit ? null : command,
    music,
    help: HELP.test(t),
    question,
    deictic: DEICTIC.test(t) && words <= 12,
    laugh: LAUGH.test(t),
    down: DOWN.test(t),
    // "make it shorter" while she waits on "send it?" is an answer to her question too (docs/MESSAGES.md).
    approval: APPROVAL.test(t) || readDraftEdit(t) !== null,
    filler: FILLER.test(t),
    outfit,
    browse,
    work: !stop && !command && !music && !browse && readWorkIntent(t) !== null,
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
