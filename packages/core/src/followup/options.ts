/**
 * Options she found (restaurants on her browser page, files on disk) and how
 * his answer picks one: "the second one", "marufuku", "the spicy one", "the
 * cheaper one", "the one from august". Pure functions, tested with fixtures.
 */

export interface Option {
  n: number;
  name: string;
  rating?: number;
  reviews?: number;
  /** "$$" or "$10-20". */
  price?: string;
  /** "Ramen", "Japanese". */
  kind?: string;
  /** "Open, closes 10 PM". */
  hours?: string;
  address?: string;
  url?: string;
  /** Everything else the card said, lowercased, for "the spicy one". */
  detail: string;
  /** Files: path, modified (ms), where ("downloads"). */
  path?: string;
  modified?: number;
  where?: string;
}

export interface Card {
  name: string;
  text: string;
  url?: string;
}

/** Any dash between two price numbers (Maps writes "$10" en-dash "20"), as escapes. */
const DASH = "[-\\u2012\\u2013\\u2014\\u2212]";
const RATING = /^(\d(?:[.,]\d)?)\s*(?:\(([\d.,]+[kK]?)\)|stars?\b|★)/;
const RATING_ANY = /\b([1-5][.,]\d)\s*(?:\(([\d.,]+[kK]?)\)|\s*stars?\b|\s*★|\s*\(([\d.,]+[kK]?)\s*reviews?\))/i;
const PRICE = new RegExp(`(\\${"$"}{1,4})(?![\\d])|\\${"$"}(\\d{1,3})\\s*${DASH}\\s*(\\d{1,3})\\+?|\\${"$"}(\\d{1,3})\\+`);
const HOURS = /\b(?:open(?:s)?(?:\s+now)?|closed|closes|closing soon|opens soon|open 24 hours)\b[^\n]{0,40}/i;
const NOISE_NAME =
  /^(?:results?|sponsored|ad|ads|share|save|directions|website|call|menu|order online|reserve a table|dine-in|takeout|delivery|no-contact delivery|overview|reviews?|about|photos?|nearby|search|filters?|sort by|price|rating|hours|open now|all filters|more|less|see more|show more|view map|map|list|top rated|recommended|updated|people also search for|\d+|[•·⋅]+)$/i;

const clean = (s: string) => s.replace(/[ \s]+/g, " ").trim();

function parseCount(s?: string): number | undefined {
  if (!s) return undefined;
  const k = /k$/i.test(s);
  const n = Number(s.replace(/[kK,]/g, "").replace(/(\d)\.(\d{3})$/, "$1$2"));
  if (!Number.isFinite(n)) return undefined;
  return Math.round(k ? n * 1000 : n);
}

function priceOf(text: string): string | undefined {
  const m = PRICE.exec(text);
  if (!m) return undefined;
  if (m[1]) return m[1];
  if (m[2] && m[3]) return `$${m[2]}-${m[3]}`;
  if (m[4]) return `$${m[4]}+`;
  return undefined;
}

/** One card's text -> the facts a person would say out loud. */
export function parseCard(name: string, text: string, n: number, url?: string): Option {
  const t = clean(text.replace(/\n+/g, " \n "));
  const r = RATING_ANY.exec(t);
  const rating = r ? Number(r[1]!.replace(",", ".")) : undefined;
  const reviews = r ? parseCount(r[2] ?? r[3]) : undefined;
  const price = priceOf(t);
  const hours = HOURS.exec(t)?.[0]?.replace(/\s*[·⋅•]\s*/g, ", ").trim();
  // "Ramen · 1581 Webster St" (Maps): the category and the street.
  const kindAddr = /(?:^|\n|\s)([A-Z][A-Za-z &'-]{2,30}?)\s*[·⋅•]\s*(?:[^\n·⋅•]*[·⋅•]\s*)?(\d{1,5}\s+[A-Z0-9][^\n·⋅•]{2,40})/.exec(text);
  return prune({
    n,
    name: clean(name).replace(/^\d{1,2}\.\s+/, ""),
    rating: rating && rating <= 5 ? rating : undefined,
    reviews,
    price,
    kind: kindAddr?.[1]?.trim(),
    address: kindAddr?.[2]?.trim(),
    hours: hours ? hours.slice(0, 48) : undefined,
    url,
    detail: `${clean(name)} ${t}`.toLowerCase().slice(0, 600),
  });
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

function looksLikeName(line: string): boolean {
  const l = clean(line);
  if (l.length < 2 || l.length > 70) return false;
  if (NOISE_NAME.test(l)) return false;
  if (RATING.test(l) || /^\$/.test(l) || /^\(?\d[\d.,]*\)?$/.test(l)) return false;
  if (/^(?:open|closed|closes|opens)\b/i.test(l)) return false;
  if (/[·⋅•]/.test(l) && /\d/.test(l)) return false;
  if (/^(?:"|“)/.test(l)) return false;
  return /[A-Za-z]/.test(l);
}

/**
 * Listing page text -> options. A rating line ("4.5(3,211)", "4.6 stars")
 * anchors each listing; its name is the nearest name-looking line above it;
 * the lines up to the next listing are its details. Works for Google Maps
 * result lists, Yelp and most "best X in Y" pages.
 */
export function optionsFromText(text: string, max = 5): Option[] {
  const lines = text.split("\n").map(clean).filter(Boolean);
  const anchors: { at: number; name: string; nameAt: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const inline = /^(?:\d{1,2}\.\s+)?(.{2,60}?)\s+([1-5][.,]\d)\s*(?:\(|stars?\b|★)/.exec(lines[i]!);
    if (RATING.test(lines[i]!)) {
      for (let j = i - 1; j >= Math.max(0, i - 3); j--) {
        if (looksLikeName(lines[j]!)) {
          anchors.push({ at: i, name: lines[j]!, nameAt: j });
          break;
        }
      }
    } else if (inline && looksLikeName(inline[1]!)) anchors.push({ at: i, name: inline[1]!, nameAt: i });
  }
  const out: Option[] = [];
  const seen = new Set<string>();
  for (let k = 0; k < anchors.length && out.length < max; k++) {
    const a = anchors[k]!;
    const end = k + 1 < anchors.length ? anchors[k + 1]!.nameAt : Math.min(lines.length, a.at + 8);
    const body = lines.slice(a.at, Math.max(a.at + 1, end)).join("\n");
    const key = a.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(parseCard(a.name, body, out.length + 1));
  }
  return out;
}

/** Cards the page gave us (Maps feed articles, list items with a heading) first, else the text. */
export function extractOptions(read: { text?: string; cards?: Card[] } | null | undefined, max = 5): Option[] {
  if (!read) return [];
  const fromCards: Option[] = [];
  const seen = new Set<string>();
  for (const c of read.cards ?? []) {
    const name = clean(c.name);
    if (!looksLikeName(name) || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const o = parseCard(name, c.text, fromCards.length + 1, c.url);
    // A card with no rating, price or hours is usually a nav tile, not a listing.
    if (o.rating === undefined && !o.price && !o.hours) continue;
    fromCards.push(o);
    if (fromCards.length >= max) break;
  }
  if (fromCards.length >= 2) return fromCards;
  const fromText = optionsFromText(read.text ?? "", max);
  return fromText.length >= fromCards.length ? fromText : fromCards;
}

/** "Marufuku Ramen, 4.5, $$": how she names an option out loud. */
export function speakOption(o: Option, full = true): string {
  const bits = [shortName(o.name)];
  if (full && o.rating) bits.push(String(o.rating));
  if (full && o.price && /^\$+$/.test(o.price)) bits.push(o.price.length === 1 ? "cheap" : o.price.length === 2 ? "mid" : "pricey");
  return bits.join(", ");
}

/** "Marufuku Ramen SF (Japantown)" -> "Marufuku Ramen". */
export function shortName(name: string): string {
  return name.replace(/\s*[([].*$/, "").replace(/\s*[-|:,].*$/, "").trim() || name;
}

// ---------------------------------------------------------------------------
// resolving his answer
// ---------------------------------------------------------------------------

export interface Choice {
  index: number;
  by: "ordinal" | "name" | "attribute";
}

const ORDINALS: [RegExp, (n: number) => number][] = [
  [/\b(?:first|1st|number one|#1|top one|the one on top|option one|option 1)\b|^(?:the\s+)?(?:one|1)(?:\s+please)?$/i, () => 0],
  [/\b(?:second|2nd|number two|#2|option two|option 2)\b|^(?:the\s+)?(?:two|2)(?:\s+please)?$/i, () => 1],
  [/\b(?:third|3rd|number three|#3|option three|option 3)\b|^(?:the\s+)?(?:three|3)(?:\s+please)?$/i, () => 2],
  [/\b(?:fourth|4th|number four|#4)\b|^(?:the\s+)?(?:four|4)$/i, () => 3],
  [/\b(?:fifth|5th|number five|#5)\b|^(?:the\s+)?(?:five|5)$/i, () => 4],
  [/\b(?:last|bottom)\s+one\b|\bthe\s+last\b|^last$/i, (n) => n - 1],
  [/\b(?:middle)\s+one\b/i, (n) => (n === 3 ? 1 : -1)],
];

/** Words too generic to pick a place or a file by. */
const GENERIC = new Set(
  "the a an one that this it place spot restaurant ramen sushi cafe coffee bar grill kitchen house shop san francisco sf la ny new york irvine los angeles near me please yeah yes let's lets go with do i'll ill take want pick choose how about what about and or of in at on for to my file pdf doc resume ok okay um uh like".split(
    " ",
  ),
);

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9$' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
}

function sim(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 4 || b.length < 4) return 0;
  const m = a.length;
  const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)] as number[]);
  for (let j = 1; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[m]![n]! / Math.max(m, n);
}

const priceLevel = (o: Option): number | undefined => {
  if (!o.price) return undefined;
  if (/^\$+$/.test(o.price)) return o.price.length * 15;
  const m = /\$(\d+)(?:-(\d+))?/.exec(o.price);
  return m ? (Number(m[1]) + Number(m[2] ?? m[1])) / 2 : undefined;
};

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

function argBest(options: Option[], f: (o: Option) => number | undefined, dir: 1 | -1): number {
  let best = -1;
  let val = 0;
  options.forEach((o, i) => {
    const v = f(o);
    if (v === undefined) return;
    if (best < 0 || v * dir > val * dir) {
      best = i;
      val = v;
    }
  });
  return best;
}

/**
 * Which option does he mean? Ordinals first ("the second one"), then names
 * ("marufuku", fuzzy for speech-to-text), then attributes ("the cheaper one",
 * "the highest rated", "the spicy one", "the one from august", "the older one").
 * null when nothing fits: that's not an answer to her question.
 */
export function resolveChoice(utterance: string, options: Option[]): Choice | null {
  if (!options.length) return null;
  const t = utterance.toLowerCase().replace(/[?!.,]+/g, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  for (const [re, f] of ORDINALS) {
    if (re.test(t)) {
      const i = f(options.length);
      if (i >= 0 && i < options.length) return { index: i, by: "ordinal" };
    }
  }
  // Names: the option whose distinctive words he said.
  const said = words(t).filter((w) => !GENERIC.has(w));
  if (said.length) {
    let best = -1;
    let bestScore = 0;
    let tie = false;
    options.forEach((o, i) => {
      const own = words(o.name).filter((w) => !GENERIC.has(w));
      let s = 0;
      for (const w of said) s += Math.max(0, ...own.map((x) => (sim(w, x) >= 0.75 ? sim(w, x) : 0)));
      if (s > bestScore) {
        best = i;
        bestScore = s;
        tie = false;
      } else if (s > 0 && s === bestScore) tie = true;
    });
    if (best >= 0 && !tie) return { index: best, by: "name" };
  }
  // Attributes.
  const attr = (i: number): Choice | null => (i >= 0 ? { index: i, by: "attribute" } : null);
  if (/\b(?:cheap(?:er|est)?|less expensive|budget|affordable)\b/.test(t)) return attr(argBest(options, priceLevel, -1));
  if (/\b(?:fancier|fanciest|nicer|nicest|expensive|pricier|priciest|bougie)\b/.test(t)) return attr(argBest(options, priceLevel, 1));
  if (/\b(?:highest|best|top)[- ]rated\b|\bbest (?:one|reviews?)\b|\bhighest (?:rating|one)\b/.test(t)) return attr(argBest(options, (o) => o.rating, 1));
  if (/\b(?:most (?:reviews|popular)|popular one|busiest)\b/.test(t)) return attr(argBest(options, (o) => o.reviews, 1));
  if (/\b(?:new(?:er|est)|latest|recent|most recent)\b/.test(t)) return attr(argBest(options, (o) => o.modified, 1));
  if (/\b(?:old(?:er|est)|earlier|previous)\b/.test(t)) return attr(argBest(options, (o) => o.modified, -1));
  const month = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(t));
  if (month >= 0) {
    const hits = options.map((o, i) => (o.modified !== undefined && new Date(o.modified).getMonth() === month ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return attr(hits[0]!);
  }
  const place = /\b(?:in|from)\s+(?:my\s+)?(downloads|documents|desktop|icloud)\b/.exec(t)?.[1];
  if (place) {
    const hits = options.map((o, i) => (o.where?.startsWith(place) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return attr(hits[0]!);
  }
  // "the spicy one", "the one with the patio": a word only one option's card has.
  const m = /\b(?:the\s+)?(\w[\w' ]{1,30}?)\s+one\b|\bthe\s+one\s+(?:with|that has|that's|thats|by|near|on)\s+(?:the\s+)?(.{2,30})$/.exec(t);
  const phrase = m ? (m[1] ?? m[2] ?? "") : "";
  const keys = words(phrase).filter((w) => !GENERIC.has(w) && w.length >= 3);
  if (keys.length) {
    const hits = options.map((o, i) => (keys.some((k) => o.detail.includes(k)) ? i : -1)).filter((i) => i >= 0);
    if (hits.length === 1) return attr(hits[0]!);
  }
  return null;
}

/** Times a reservation page shows: "7:30 PM", "8:15pm", "19:30". Deduped, in page order. */
export function extractTimes(text: string, max = 6): string[] {
  const out: string[] = [];
  const re = /\b((?:1[0-2]|0?[1-9]):[0-5]\d)\s*([ap]\.?m\.?)?|\b((?:1[3-9]|2[0-3]):[0-5]\d)\b/gi;
  for (const m of text.matchAll(re)) {
    let t: string;
    if (m[3]) {
      const [h, mm] = m[3].split(":");
      t = `${Number(h) - 12}:${mm} pm`;
    } else t = `${m[1]}${m[2] ? ` ${m[2].replace(/\./g, "").toLowerCase()}` : ""}`;
    if (!out.includes(t)) out.push(t);
    if (out.length >= max) break;
  }
  return out;
}

/** "7:30 pm" -> "7:30" for speech, "19:30" for the calendar. */
export function spokenTime(t: string): string {
  return t.replace(/\s*pm$/i, "").replace(/\s*am$/i, " am");
}

export function clockTime(t: string): string {
  const m = /^(\d{1,2}):(\d{2})\s*(am|pm)?$/i.exec(t.trim());
  if (!m) return t;
  let h = Number(m[1]);
  const ap = m[3]?.toLowerCase();
  if (ap === "pm" && h < 12) h += 12;
  if (ap === "am" && h === 12) h = 0;
  // A dinner time without am/pm is evening.
  if (!ap && h < 11) h += 12;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

/** Which of these times did he say? "8:15", "the 8:15", "eight fifteen" is left to the brain. */
export function pickTime(utterance: string, times: string[]): string | null {
  const said = extractTimes(utterance.replace(/(?<![:\d])(\d{1,2})\s*(pm|am)\b/gi, "$1:00 $2"));
  for (const s of said) {
    const hit = times.find((t) => clockTime(t) === clockTime(s) || spokenTime(t) === spokenTime(s));
    if (hit) return hit;
  }
  const bare = /\b(\d{1,2})(?::(\d{2}))?\b/.exec(utterance);
  if (bare) {
    const want = `${bare[1]}:${bare[2] ?? "00"}`;
    return times.find((t) => spokenTime(t).startsWith(want)) ?? null;
  }
  return null;
}
