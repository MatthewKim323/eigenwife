/**
 * Embeddings for memory retrieval.
 *
 * Two spaces:
 *  - "openai": text-embedding-3-small at 512 dims, cached by content hash so a
 *    memory or a repeated query is embedded once, ever.
 *  - "local": a deterministic offline embedding (below) so recall works with
 *    zero keys. Every record always carries a local vector; the OpenAI vector
 *    is added when available.
 *
 * The local embedding is three blocks in one vector:
 *  1. concept dims: a small hand-written lexicon maps words to concepts (food,
 *     money, work, ...) plus a few documented associations (eating out costs
 *     money), so "where should we eat?" finds "trying to save money".
 *  2. hashed word unigrams (light stemming, stopwords dropped).
 *  3. hashed character trigrams, for spelling variants and partial overlap.
 * It is honest keyword-plus-lexicon matching, not a language model.
 */

export type Vec = number[];
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export function cosine(a: Vec | undefined, b: Vec | undefined): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  if (na === 0 || nb === 0) return 0;
  return dot / Math.sqrt(na * nb);
}

export function contentHash(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex").slice(0, 20);
}

// --- local embedding ----------------------------------------------------------

export const LOCAL_DIMS = 384;

export const CONCEPTS: Record<string, string[]> = {
  food: [
    "eat", "food", "dinner", "lunch", "breakfast", "brunch", "hungry", "ramen", "sushi", "spicy", "restaurant", "meal",
    "cook", "noodle", "japanese", "pizza", "taco", "bowl", "snack", "menu", "dish", "cuisine", "curry", "miso", "izakaya",
    "chili", "kimchi", "thai", "korean", "burger", "cafe", "coffee",
  ],
  money: [
    "money", "cheap", "expensive", "price", "priced", "cost", "budget", "save", "saving", "overpriced", "dollar", "afford",
    "affordable", "pay", "spend", "spending", "deal", "broke", "rent", "$",
  ],
  work: ["job", "late", "working", "office", "deadline", "meeting", "busy", "weekday", "shift", "project", "boss", "overtime", "grind", "code", "coding"],
  schedule: ["tonight", "tomorrow", "schedule", "calendar", "free", "weekend", "evening", "plan", "plans", "time", "today", "night", "morning"],
  style: ["explanation", "explain", "long", "short", "concise", "brief", "verbose", "ramble", "tldr", "wordy", "answer", "response", "reply", "talk", "lecture"],
  humor: ["laugh", "laughed", "joke", "funny", "tease", "teased", "teasing", "banter", "humor", "lol", "haha", "lmao", "sarcastic", "sarcasm", "roast"],
  outdoors: ["outdoor", "outdoors", "hike", "hiking", "camping", "nature", "park", "beach", "trail", "outside", "sport", "sporty", "fitness", "gym"],
  music: ["song", "music", "playlist", "spotify", "track", "album", "band", "concert"],
  dating: ["date", "dating", "type", "attractive", "profile", "partner", "girlfriend", "crush", "swipe", "romance"],
  social: ["friends", "party", "nightlife", "bar", "club", "drinks", "going", "hang"],
  nerd: ["nerd", "nerdy", "anime", "game", "games", "gaming", "book", "books", "science", "math", "tech"],
};

/** Documented concept associations: evidence for one concept is weak evidence for another. */
export const ASSOCIATIONS: [string, string, number][] = [
  ["food", "money", 0.35],
  ["schedule", "work", 0.4],
  ["schedule", "food", 0.25],
  ["dating", "humor", 0.2],
  ["social", "schedule", 0.2],
];

const CONCEPT_NAMES = Object.keys(CONCEPTS);
const WORD_TO_CONCEPT = new Map<string, number>();
CONCEPT_NAMES.forEach((c, i) => {
  for (const w of CONCEPTS[c]!) WORD_TO_CONCEPT.set(stem(w), i);
});

const STOP = new Set(
  "a an the and or but if of to in on at for with from by is are was were be been being it its this that these those i me my we our you your he she they them their what which who whom how why where when do does did doing have has had should would could can will just so very really too not no yes about into over than then there here some any all more most much also like likes liked thing things stuff get got go ok okay thought thoughts idea know think mean said say".split(" "),
);

function stem(w: string): string {
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith("ed")) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase().replace(/[’']/g, "");
  const out: string[] = [];
  if (/\$\s?\d/.test(lower)) out.push("$");
  for (const w of lower.split(/[^a-z0-9]+/)) {
    if (!w || STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const CONCEPT_WEIGHT = 2;
const WORD_WEIGHT = 1;
const TRIGRAM_WEIGHT = 0.35;

export function localEmbed(text: string, dims = LOCAL_DIMS): Vec {
  const v = new Array<number>(dims).fill(0);
  const nc = CONCEPT_NAMES.length;
  const hashed = dims - nc;
  const tokens = tokenize(text);
  const conceptHits = new Array<number>(nc).fill(0);
  for (const t of tokens) {
    const c = WORD_TO_CONCEPT.get(t);
    if (c !== undefined) conceptHits[c]!++;
    if (t === "$") continue;
    const h = fnv1a(`w:${t}`);
    v[nc + (h % hashed)]! += (h & 0x80000000 ? -1 : 1) * WORD_WEIGHT;
    const padded = `#${t}#`;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const g = fnv1a(`g:${padded.slice(i, i + 3)}`);
      v[nc + (g % hashed)]! += (g & 0x80000000 ? -1 : 1) * TRIGRAM_WEIGHT;
    }
  }
  const concepts = conceptHits.map((n) => (n > 0 ? CONCEPT_WEIGHT * Math.sqrt(n) : 0));
  const spread = [...concepts];
  for (const [a, b, w] of ASSOCIATIONS) {
    const ia = CONCEPT_NAMES.indexOf(a);
    const ib = CONCEPT_NAMES.indexOf(b);
    spread[ib]! += w * concepts[ia]!;
    spread[ia]! += w * concepts[ib]!;
  }
  for (let i = 0; i < nc; i++) v[i] = spread[i]!;
  return v;
}

// --- OpenAI embeddings ---------------------------------------------------------

export interface OpenAIEmbedderOptions {
  apiKey: string;
  model?: string;
  dims?: number;
  fetch?: FetchLike;
  timeoutMs?: number;
  /** Persisted cache hash -> vector, loaded and saved by the caller. */
  cache?: Map<string, Vec>;
  onCacheChange?: () => void;
}

export class OpenAIEmbedder {
  readonly model: string;
  readonly dims: number;
  readonly cache: Map<string, Vec>;
  private fetch: FetchLike;
  failures = 0;
  calls = 0;

  constructor(private opts: OpenAIEmbedderOptions) {
    this.model = opts.model ?? "text-embedding-3-small";
    this.dims = opts.dims ?? 512;
    this.cache = opts.cache ?? new Map();
    this.fetch = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  key(text: string): string {
    return contentHash(`${this.model}:${this.dims}:${text}`);
  }

  cached(text: string): Vec | undefined {
    return this.cache.get(this.key(text));
  }

  /** Embed many texts in one request. Cached ones never hit the network. Returns null on failure. */
  async embed(texts: string[], timeoutMs = this.opts.timeoutMs ?? 4000): Promise<(Vec | null)[]> {
    const out: (Vec | null)[] = texts.map((t) => this.cached(t) ?? null);
    const missing = [...new Set(texts.filter((_, i) => out[i] === null))];
    if (missing.length === 0) return out;
    try {
      this.calls++;
      const res = await this.fetch("https://api.openai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: this.model, input: missing, dimensions: this.dims, encoding_format: "float" }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`openai embeddings ${res.status}`);
      const j = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      for (const d of j.data) {
        const vec = d.embedding.map((x) => Math.round(x * 1e5) / 1e5);
        this.cache.set(this.key(missing[d.index]!), vec);
      }
      this.opts.onCacheChange?.();
    } catch {
      this.failures++;
    }
    return texts.map((t) => this.cached(t) ?? null);
  }
}
