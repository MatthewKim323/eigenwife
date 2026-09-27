/**
 * When is something he said worth a gbrain lookup? A person, a place, a
 * project, or "remember when". Pure: text in, search terms out (or null).
 * The lookup itself is fire-and-forget (memory/module.ts); its results land
 * as short-term memories and a world slot for her NEXT turn.
 */

const STOP = new Set(
  (
    "I Im I'm Ive I've Id I'd Ill I'll Eve Evie Hey Yo Okay Ok OK Yeah Yes No Nah Lol Lmao Omg Bro Dude Man Wait So And But Or The A An This That These Those It Its What When Where Why How Who Which Can Could Would Should Will Just Like Also Well Oh Um Uh Hmm Honestly Actually Literally Really Maybe Please Thanks Thank Sorry Nice Cool Good Great " +
    "Monday Tuesday Wednesday Thursday Friday Saturday Sunday Today Tomorrow Yesterday Tonight January February March April May June July August September October November December Spotify Chrome Safari Google Youtube YouTube Discord Twitter Instagram Claude Cursor"
  ).split(" "),
);

const RELATION = /\b(?:my|our)\s+(?:friend|buddy|homie|bestie|best friend|girlfriend|gf|boyfriend|bf|sister|brother|mom|dad|cousin|roommate|boss|coworker|cofounder|co-founder|professor|prof|ex)\s+([a-z][a-z'-]+)/i;
const REMEMBER = /\b(?:remember|remembering)\s+(?:when|that time|the time|how|what)\s+(.+)/i;
const PLACE = /\b(?:at|in|to|from)\s+([A-Z][\w'&-]+(?:\s+[A-Z][\w'&-]+){0,2})/;
const PROJECT = /\b(?:project|startup|hackathon|app|repo|company|class|course)\s+(?:called\s+)?([A-Za-z][\w-]{2,})/i;

const FILLER = new Set("a an the we i you he she they it that this was were is are my our me us to of and with at in on for about".split(" "));

export interface Cue {
  kind: "remember" | "person" | "place" | "project" | "name";
  query: string;
}

/**
 * Terms worth a lookup, most specific first. `known` = names she already
 * knows matter (his people from the profile), matched case-insensitively,
 * because speech-to-text often lowercases names.
 */
export function liveCue(text: string, known: string[] = []): Cue | null {
  const t = text.trim();
  if (t.length < 4) return null;
  const rem = REMEMBER.exec(t);
  if (rem) {
    const words = rem[1]!
      .replace(/[?.!,]/g, " ")
      .split(/\s+/)
      .filter((w) => w && !FILLER.has(w.toLowerCase()))
      .slice(0, 6);
    if (words.length) return { kind: "remember", query: words.join(" ") };
  }
  const lower = ` ${t.toLowerCase()} `;
  for (const k of known) {
    const first = k.trim().split(/\s+/)[0];
    if (first && first.length >= 3 && new RegExp(`[^a-z]${first.toLowerCase().replace(/[^a-z]/g, "")}[^a-z]`).test(lower)) return { kind: "person", query: k.trim() };
  }
  const rel = RELATION.exec(t);
  if (rel && !FILLER.has(rel[1]!.toLowerCase())) return { kind: "person", query: rel[1]! };
  const proj = PROJECT.exec(t);
  if (proj && !FILLER.has(proj[1]!.toLowerCase())) return { kind: "project", query: proj[1]! };
  const place = PLACE.exec(t);
  if (place && !place[1]!.split(/\s+/).every((w) => STOP.has(w))) return { kind: "place", query: place[1]!.split(/\s+/).filter((w) => !STOP.has(w)).join(" ") };
  // Capitalized words that aren't sentence starts or stopwords: names, places, projects.
  // Speech-to-text capitalizes the first word of every sentence, so those don't count.
  const caps = [...t.matchAll(/(?<=[^.!?\s]\s+)([A-Z][a-z][\w'-]*(?:\s+[A-Z][a-z][\w'-]*)?)/g)]
    .map((m) => m[1]!)
    .filter((w) => !w.split(/\s+/).every((x) => STOP.has(x)))
    .map((w) => w.split(/\s+/).filter((x) => !STOP.has(x)).join(" "));
  if (caps.length) return { kind: "name", query: caps.slice(0, 2).join(" ") };
  return null;
}
