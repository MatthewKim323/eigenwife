/**
 * What kind of work ask an utterance is. Keyword based and transparent like
 * reflex/intent.ts: it runs on every utterance, well under a millisecond.
 * null means "not a work ask" (the normal reflex path handles it).
 */

export type WorkAsk =
  | { kind: "code.task"; task: string }
  | { kind: "code.status"; tests: boolean }
  | { kind: "context" }
  /** mode: open = "find my resume" (open the best match), locate = "where's my resume" (say where, offer to open). */
  | { kind: "files.search"; query: string; content: boolean; mode: "open" | "locate" }
  /** "find me ramen places in sf": browse in her browser, pick from the options with him (docs/FOLLOW_THROUGH.md). */
  | { kind: "browse.options"; query: string }
  | { kind: "files.read"; target: string }
  | { kind: "files.open"; target: string }
  | { kind: "jabby"; mode: "read" | "act" | "send"; request: string }
  | { kind: "shell.run"; command: string; dir?: string }
  /** iMessage/SMS from matt's Messages app (docs/MESSAGES.md). body is his exact words when dictated, else what to say. */
  | { kind: "messages.send"; who: string; body?: string; dictated: boolean }
  | { kind: "clarify"; question: string; partial: string };

const strip = (t: string) =>
  t
    .trim()
    .replace(/[?!.]+$/, "")
    .replace(/^(?:hey |yo |ok |okay |so |um |uh |aight |alright )+/i, "")
    .replace(/^(?:eve[, ]+)?(?:can you|could you|would you|will you|please|pls|i need you to|i want you to|go ahead and|lemme get you to)\s+/i, "")
    .trim();

const CODE_VERB = /^(?:ship|fix|implement|refactor|debug|patch|build|add|write|make|create|update|rename|migrate|port|clean up|remove|delete|wire up|hook up|bump|upgrade|optimize|speed up|test)\b/i;
/** Verbs that are code work on their own: "fix the flaky test", "ship dark mode". */
const STRONG_VERB = /^(?:ship|fix|implement|refactor|debug|patch)\b/i;
const CODE_NOUN =
  /\b(?:function|method|class|test|tests|spec|endpoint|route|api|component|feature|bug|crash|error|module|script|cli|flag|type|types|lint|build|ci|readme|docs?|page|button|hook|handler|schema|migration|query|repo|codebase|branch|pr|commit|typescript|react|css|ui|server|backend|frontend|config|dependency|dependencies|package)\b/i;
/** Things a code verb can hit that are not code: calendars, dinner, alarms. */
const NOT_CODE = /\b(?:calendar|dinner|lunch|breakfast|reservation|table|playlist|alarm|reminder|appointment|meeting|flight|uber|grocer(?:y|ies)|shopping list)\b/i;

const FILE_NOUN = "file|doc|document|pdf|deck|slides|spreadsheet|sheet|notes|note|resume|cv|essay|paper|screenshot|photo|picture|image|folder|draft|syllabus|transcript|invoice|receipt|contract|report|presentation";

const TESTS = /^(?:run|rerun|re-run|kick off)\s+(?:the\s+|my\s+)?tests?\b|\b(?:are|do)\s+(?:the\s+)?tests\s+(?:pass|passing|green|still pass)|\bdid\s+(?:the\s+)?tests\s+pass\b/i;
const STATUS = /\b(?:git|repo|branch)\s+status\b|\bwhat(?:'s| is)\s+(?:the\s+)?(?:status|state)\s+of\s+(?:the\s+|my\s+)?(?:repo|branch|code|build)\b|\bwhat\s+changed\b.*\b(?:repo|branch|code)\b|\bhow\s+many\s+(?:dirty|changed|uncommitted)\s+files\b/i;
// "what am i doing" is a screen question (she looks); "working on" is the coarse app/repo answer.
const CONTEXT = /\bwhat\s+am\s+i\s+working\s+on\b|\bwhat\s+(?:repo|project|branch)\s+am\s+i\s+(?:in|on)\b/i;

const FIND = new RegExp(`^(?:find|locate|search\\s+for|look\\s+for|pull\\s+up|dig\\s+up|where(?:'s|\\s+is|\\s+are|\\s+did\\s+i\\s+(?:put|save))|get\\s+me)\\s+(.+)$`, "i");
const FIND_MINE = new RegExp(`\\b(?:my|the|that)\\b.*\\b(?:${FILE_NOUN})s?\\b|\\.[a-z0-9]{1,5}\\b|\\bmy\\s+\\w+`, "i");
const CONTENT = /\b(?:about|mentions?|mentioning|that says|containing|with the words?|talks? about)\b\s+(.+)$/i;
const PLACE_NOUN =
  "restaurants?|places?|spots?|cafes?|caf\\u00e9s?|coffee(?:\\s+shops?)?|bars?|food|eats|ramen|sushi|tacos?|pizza|burgers?|brunch|boba|dim sum|pho|bbq|thai|korean|italian|mexican|indian|chinese|japanese|bakery|bakeries|dessert|ice cream";
const PLACES = new RegExp(
  `^(?:find|look\\s+for|search\\s+for|look\\s+up|get|pull\\s+up|show)\\s+(?:me\\s+|us\\s+)?(?:some\\s+|a\\s+few\\s+|a\\s+|any\\s+|the\\s+best\\s+|good\\s+|really\\s+good\\s+)*((?:[\\w'&-]+\\s+){0,4}?(?:${PLACE_NOUN})\\b.*)$`,
  "i",
);
const READ = new RegExp(`^(?:what(?:'s| is)\\s+in|read(?:\\s+me)?|summari[sz]e|tl;?dr|skim)\\s+(?:my\\s+|the\\s+|that\\s+)?(.+?)(?:\\s+(?:${FILE_NOUN}))?$`, "i");
const OPEN = /^(?:open(?:\s+up)?|launch|bring\s+up|show\s+me)\s+(?:my\s+|the\s+)?(.+)$/i;

const DUE = /\bwhat(?:'s| is)\s+due\b|\b(?:assignments?|homework|deadlines?|syllabus|my\s+classes|problem\s+sets?|psets?|midterms?|finals?)\b/i;
const EMAIL_READ = /\b(?:check|read|triage|go\s+through|scan|clear)\s+(?:my\s+)?(?:e-?mails?|inbox|gmail|mail)\b|\bany\s+(?:new\s+|important\s+)?(?:e-?mails?|mail)\b|\bwho\s+(?:e-?mailed|emailed)\s+me\b|\bwhat(?:'s| is)\s+in\s+my\s+inbox\b/i;
const SEND =
  /^(?:e-?mail|text|message|dm|reply\s+to|respond\s+to|write\s+back\s+to|send(?:\s+an?\s+(?:e-?mail|text|message|dm))?(?:\s+to)?|tell)\s+(?!me\b|us\b|you\b)(\w[\w .'-]*?)\b.*\b(?:saying|that|to\s+say|about|telling|asking|and\s+say|with)\b/i;
const REMIND = /\bremind\s+me\b|\bset\s+(?:a|an|up\s+a)\s+(?:reminder|alarm|timer|cron|job)\b|\bevery\s+(?:morning|day|night|week|monday|tuesday|wednesday|thursday|friday)\b.*\b(?:text|ping|dm|tell)\s+me\b/i;
const JABBY_OTHER = /\b(?:internships?|job\s+postings?|discord|dms?|gbrain|what\s+did\s+\w+\s+say)\b/i;
const ASK_JABBY = /^(?:ask|tell|have)\s+jabby\s+(?:to\s+)?(.+)$/i;

const SHELL = /^(?:run|execute)\s+(?:the\s+)?(?:command\s+|shell\s+command\s+)?[`"']?(.+?)[`"']?(?:\s+in\s+(?:the\s+)?([\w./~-]+?)(?:\s+(?:repo|folder|directory|project))?)?$/i;
const SHELL_LOOKS = /^(?:git|ls|cat|echo|pwd|bun|npm|pnpm|yarn|node|python3?|uv|pytest|cargo|go|make|wc|head|tail|grep|rg|find|du|df|whoami|date|brew|gh|tsc|bunx|npx|open|which|curl)\b/i;

/** Pronoun-only objects: "ship it", "fix that". Code work needs a real object. */
const VAGUE = /^(?:it|that|this|them|the thing|something|stuff|everything|the bug|the issue|the problem|it up|this one|that one)$/i;

export function readWorkIntent(raw: string): WorkAsk | null {
  const text = strip(raw);
  if (!text) return null;
  const t = text.toLowerCase();

  // Texts go out through matt's own Messages app: "text stephen hung saying yo you up".
  const msg = readMessageAsk(text);
  if (msg) return msg;

  // jabby first: "remind me", "what's due", "email leo saying ..." are never code.
  const askJ = ASK_JABBY.exec(text);
  if (askJ) {
    const req = askJ[1]!;
    return { kind: "jabby", mode: SEND.test(req) ? "send" : REMIND.test(req) ? "act" : "read", request: req };
  }
  if (SEND.test(text) && !CODE_NOUN.test(t.replace(/\b(?:about|saying).*$/, ""))) return { kind: "jabby", mode: "send", request: text };
  if (REMIND.test(text)) return { kind: "jabby", mode: "act", request: text };
  if (EMAIL_READ.test(text) || DUE.test(text) || JABBY_OTHER.test(text)) return { kind: "jabby", mode: "read", request: text };

  if (CONTEXT.test(text)) return { kind: "context" };
  if (TESTS.test(text)) return { kind: "code.status", tests: true };
  if (STATUS.test(text)) return { kind: "code.status", tests: false };

  // Explicit shell: "run git log --oneline in eigenwife" (also "open terminal and run ...").
  const shText = text
    .replace(/^(?:open|pull up|go to|use)\s+(?:up\s+)?(?:the\s+|a\s+|my\s+)?(?:terminal|ghostty|iterm|shell|command line)\s*(?:and\s+|then\s+|,\s*)?/i, "")
    .replace(/\s+(?:in|on|from)\s+(?:the\s+|my\s+)?(?:terminal|shell|command line)\b/i, "");
  const sh = SHELL.exec(shText);
  if (sh && SHELL_LOOKS.test(sh[1]!.trim())) return { kind: "shell.run", command: sh[1]!.trim(), ...(sh[2] ? { dir: sh[2] } : {}) };

  const read = READ.exec(text);
  if (read && /^(?:what(?:'s| is)\s+in|read|summari|tl|skim)/i.test(text)) {
    const target = read[1]!.trim();
    if (target && !/^(?:my\s+)?(?:inbox|e-?mail|mail)$/i.test(target)) return { kind: "files.read", target };
  }

  // "find me ramen places in sf", "look for sushi spots near me": options to pick from, not a plan.
  const places = PLACES.exec(text);
  const fileish = new RegExp(`\\b(?:${FILE_NOUN})s?\\b`, "i").test(text) || /\.[a-z0-9]{1,5}\b/i.test(text) || CODE_NOUN.test(text);
  if (places && !fileish && !/\b(?:book|reserve|reservation|figure out|plan)\b/i.test(text) && !/\bmy\b/i.test(places[1]!))
    return { kind: "browse.options", query: places[1]!.trim() };

  const find = FIND.exec(text);
  if (find && FIND_MINE.test(text) && !/\b(?:restaurant|place|spot|food|dinner|flight|hotel)\b/i.test(text)) {
    const phrase = find[1]!.trim();
    const content = CONTENT.exec(phrase);
    const query = (content ? content[1]! : phrase)
      .replace(/\b(?:my|the|that|a|an|file|files|doc|docs|document|documents|folder)\b/gi, " ")
      .replace(/\b(?:i\s+(?:was\s+)?(?:working\s+on|wrote|made|saved)|from\s+(?:last|this)\s+\w+|on\s+my\s+(?:computer|mac|laptop))\b/gi, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (!query) return { kind: "clarify", question: "which file? give me a word from the name.", partial: text };
    const locate = /^(?:where|locate|search\s+for)\b/i.test(text);
    return { kind: "files.search", query, content: !!content, mode: locate ? "locate" : "open" };
  }

  const open = OPEN.exec(text);
  if (open && !/\b(?:dating|eigen)\b/i.test(text)) {
    const target = open[1]!.trim();
    if (VAGUE.test(target)) return { kind: "clarify", question: "open what?", partial: text };
    return { kind: "files.open", target };
  }

  if (CODE_VERB.test(text) && !NOT_CODE.test(text)) {
    const object = text.replace(CODE_VERB, "").trim();
    const strong = STRONG_VERB.test(text);
    if (!object || VAGUE.test(object.replace(/\s+(?:in|on|for)\s+.*$/, ""))) {
      if (strong) return { kind: "clarify", question: `${text.split(/\s+/)[0]!.toLowerCase()} what, exactly? one sentence and i'll hand it to claude.`, partial: text };
      return null;
    }
    if (strong || CODE_NOUN.test(object)) return { kind: "code.task", task: text };
  }
  return null;
}

/** Fold a clarification answer into the ask that needed it. */
export function answerClarify(partial: string, answer: string): string {
  const a = answer.trim().replace(/[.!]+$/, "");
  const p = partial.trim();
  // "fix the login bug in" + "eigenwife", "email leo saying hi (send it to" + "leo@x.com"
  if (/\((?:send it to)$/.test(p)) return `${p} ${a})`;
  if (/\s(?:in|to|on)$/.test(p)) return `${p} ${a}`;
  // "ship it" + "the dark mode toggle in eigenwife" -> "ship the dark mode toggle in eigenwife"
  const replaced = p.replace(/\b(?:it|that|this|the bug|the issue|the problem|something|stuff)\b\s*$/i, a);
  if (replaced !== p) return replaced;
  if (/^(?:find|locate|search|look|pull|where|open)/i.test(p)) return `${p.replace(/\s+(?:file|it|that)$/i, "")} ${a}`.replace(/\s+/g, " ");
  return `${p}: ${a}`;
}

// --- messages (docs/MESSAGES.md) -------------------------------------------------------

const MSG_VERB = /^(?:text|txt|message|i-?\s?message|sms|send\s+(?:a\s+)?(?:text|message|imessage|i\s?message|sms)\s+(?:to\s+)?|shoot\s+(?:a\s+)?(?:text|message)\s+(?:to\s+)?|drop\s+(?:a\s+)?text\s+(?:to\s+)?)\s*(.+)$/i;
/** Where the name ends and the message starts. The earliest connector wins. */
const MSG_CONNECT =
  /(?:\s*[,]\s*|\s+)(saying|and\s+say|to\s+say|that\s+says|say|that|and\s+(?:tell|ask|let)\s+(?:him|her|them)(?:\s+know)?(?:\s+that)?|and\s+ask|asking|telling\s+(?:him|her|them)(?:\s+that)?|to\s+(?:tell|ask)\s+(?:him|her|them)(?:\s+that)?|(?:letting|to\s+let)\s+(?:him|her|them)\s+know(?:\s+that)?|about|if|whether|to)\s+/gi;
/** Connectors after which his words are the text itself, not a description of it. */
const MSG_DICTATED = /^(?:saying|and\s+say|to\s+say|that\s+says|say)$/i;
const MSG_OTHER_APP = /\b(?:on|in|over|through|via)\s+(?:discord|slack|email|e-mail|gmail|instagram|insta|ig|whatsapp|telegram|signal|linkedin|twitter|x)\b/i;
const NOT_A_PERSON = /^(?:me|myself|us|you|him|her|them|it|back|someone|somebody|anyone|everyone|people)\b/i;
const WHO_LEAD = /^(?:to\s+)?(?:my\s+(?:friend|buddy|boy|homie|bro|girl|dude|pal|guy|man)\s+|my\s+(?=mom|dad|mother|father|brother|sister|sis|grandma|grandpa|aunt|uncle|cousin|roommate|boss|girlfriend|boyfriend|gf|bf))/i;
const WHO_TAIL = /\s+(?:for\s+me|real\s+quick|rn|right\s+now|please|pls|on\s+(?:imessage|messages|my\s+phone))$/i;
const QUOTES = /^["“'‘]+|["”'’]+$/g;

function cleanWho(raw: string): string {
  let w = raw.trim().replace(/[,.:;!?]+$/, "");
  for (let i = 0; i < 3; i++) w = w.replace(WHO_TAIL, "").trim();
  return w.replace(WHO_LEAD, "").trim();
}

/** "text my friend stephen hung", "text stephen 'yo you up'", "imessage leo that i'm outside". null if not a text ask. */
export function readMessageAsk(text: string): (WorkAsk & { kind: "messages.send" }) | null {
  const m = MSG_VERB.exec(text.trim());
  if (!m) return null;
  const rest = m[1]!.trim();
  if (NOT_A_PERSON.test(rest) || MSG_OTHER_APP.test(rest)) return null;
  // Connectors inside a quoted message don't count ("text leo 'you need to chill'").
  const q = /(?:^|\s|[:,])["“]|\s['‘]/.exec(rest);
  const quoteAt = q ? q.index : rest.length;
  const colonAt = rest.indexOf(":");
  let who = rest;
  let body: string | undefined;
  let dictated = false;
  let conn: RegExpExecArray | null = null;
  for (const c of rest.matchAll(MSG_CONNECT)) {
    if (c.index! > 0 && c.index! < quoteAt && (colonAt < 0 || c.index! < colonAt)) {
      conn = c as RegExpExecArray;
      break;
    }
  }
  if (conn) {
    who = rest.slice(0, conn.index);
    const said = rest.slice(conn.index! + conn[0].length).trim();
    dictated = MSG_DICTATED.test(conn[1]!.replace(/\s+/g, " "));
    body = dictated ? said : `${conn[1]!.replace(/\s+/g, " ").toLowerCase()} ${said}`;
  } else if (colonAt > 0 && colonAt < quoteAt) {
    [who, body, dictated] = [rest.slice(0, colonAt), rest.slice(colonAt + 1), true];
  } else if (q && quoteAt > 0) {
    [who, body, dictated] = [rest.slice(0, quoteAt), rest.slice(quoteAt), true];
  }
  who = cleanWho(who);
  if (!who || NOT_A_PERSON.test(who)) return null;
  // A name is a few words. "text size is too small in the header" is not a text to "size is too small".
  if (who.split(/\s+/).length > 4 || CODE_NOUN.test(who)) return null;
  body = body?.trim().replace(QUOTES, "").trim();
  return { kind: "messages.send", who, ...(body ? { body } : {}), dictated: !!body && dictated };
}

export type DraftEdit = { kind: "replace"; text: string } | { kind: "append"; text: string } | { kind: "rewrite"; instruction: string };

const EDIT_LEAD = /^(?:(?:no|nah|actually|wait|hmm|oh|ok|okay|yeah|and|but)[,\s]+)*/i;
const EDIT_REPLACE = /^(?:(?:just\s+)?say\s+(.+?)\s+instead|change\s+it\s+to\s+(?:say\s+)?(.+)|make\s+it\s+say\s+(.+)|instead\s+say\s+(.+)|just\s+say\s+(.+)|replace\s+it\s+with\s+(.+))$/i;
const EDIT_APPEND = /^(?:add\s+(?:that\s+|on\s+|in\s+)?(.+)|also\s+(?:say|tell\s+(?:him|her|them)|mention|ask(?:\s+(?:him|her|them))?)\s+(?:that\s+)?(.+)|tell\s+(?:him|her|them)\s+(?:also\s+)?(?:that\s+)?(.+?)\s+too)$/i;
const EDIT_REWRITE =
  /^(?:make\s+it\s+(?:a\s+(?:bit|little)\s+|way\s+|more\s+|less\s+|sound\s+)?\w+.*|(?:reword|rewrite|rephrase|redo|shorten|lengthen)\s+(?:it|that).*|(?:take\s+out|remove|drop|lose|cut)\s+(?:the\s+)?.+|don'?t\s+(?:say|mention)\s+.+|without\s+(?:the\s+)?.+|(?:less|more)\s+\w+|shorter|longer|nicer|funnier|more\s+casual)$/i;

/** He's changing the draft she just read back ("make it shorter", "add that i'm bringing snacks"). null if not an edit. */
export function readDraftEdit(raw: string): DraftEdit | null {
  const text = raw.trim().replace(/[.!?]+$/, "").replace(EDIT_LEAD, "").trim();
  if (!text || /^(?:(?:yeah\s+)?send\s+it|do\s+it|go|go\s+ahead)$/i.test(text)) return null;
  const r = EDIT_REPLACE.exec(text);
  if (r) return { kind: "replace", text: r.slice(1).find(Boolean)!.trim().replace(QUOTES, "") };
  const a = EDIT_APPEND.exec(text);
  if (a) return { kind: "append", text: a.slice(1).find(Boolean)!.trim() };
  if (EDIT_REWRITE.test(text)) return { kind: "rewrite", instruction: text };
  return null;
}
