import type { ZoClient, ZoStatus } from "./client";
import { parseKwargs, parsePy } from "./repr";

/**
 * Typed wrappers over the Zo app tools Eve uses: Google Calendar, Spotify,
 * Google Maps and Zo's own filesystem. Each method resolves (never throws) and
 * carries the round-trip time. Shapes verified live on 2026-09-26, see
 * docs/ZO.md.
 */

export const LA_TZ = "America/Los_Angeles";
/** Zo's workspace (what the Zo UI shows as the home folder). HOME for the bash tool is /root. */
export const ZO_WORKSPACE = "/home/workspace";

export interface ZoPlace {
  name: string;
  /** "$10-20" range from Maps, or "$", "$$" from price_level. */
  price: string;
  cost?: number;
  rating?: number;
  address?: string;
  url?: string;
  why: string;
  dish?: string;
}

export interface ZoEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  htmlLink?: string;
  status?: string;
  location?: string;
  allDay?: boolean;
}

export interface NowPlaying {
  playing: boolean;
  track?: string;
  artist?: string;
  id?: string;
  progressMs?: number;
  durationMs?: number;
}

export interface MapsQuery {
  query: string;
  location: string;
  openNow?: boolean;
  cheap?: boolean;
  minRating?: number;
}

export interface MapsResult {
  ok: boolean;
  places: ZoPlace[];
  summary?: string;
  cached: boolean;
  ms: number;
  error?: string;
}

export interface Timed<T> {
  ok: boolean;
  value?: T;
  ms: number;
  error?: string;
  code?: string;
}

/** What the core's "zo" service offers. Provided by the home module when ZO_API_KEY is set. */
export interface ZoService {
  client: ZoClient;
  status(): ZoStatus;
  createEvent(e: { title: string; start: number; end: number; location?: string; description?: string; timeZone?: string }, o?: { timeoutMs?: number }): Promise<Timed<ZoEvent>>;
  deleteEvent(id: string, o?: { timeoutMs?: number }): Promise<Timed<{ deleted: boolean }>>;
  getEvent(id: string, o?: { timeoutMs?: number }): Promise<Timed<ZoEvent>>;
  listEvents(from: number, until: number, o?: { timeoutMs?: number; q?: string }): Promise<Timed<ZoEvent[]>>;
  freeBusy(from: number, until: number, o?: { timeoutMs?: number }): Promise<Timed<{ start: number; end: number }[]>>;
  nowPlaying(o?: { timeoutMs?: number }): Promise<Timed<NowPlaying>>;
  maps(q: MapsQuery, o?: { timeoutMs?: number; fresh?: boolean }): Promise<MapsResult>;
  /** Fire-and-forget cache warm. */
  prefetchMaps(q: MapsQuery): void;
  writeFile(path: string, content: string, o?: { timeoutMs?: number; priority?: "high" | "low" }): Promise<Timed<void>>;
  readFile(path: string, o?: { timeoutMs?: number; priority?: "high" | "low" }): Promise<Timed<string>>;
  listDir(path: string, o?: { timeoutMs?: number; priority?: "high" | "low" }): Promise<Timed<string[]>>;
}

// --- time ------------------------------------------------------------------------

function tzOffsetMin(ms: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60_000);
}

/** Epoch ms -> RFC3339 wall time in `tz` with its offset: 2026-09-26T19:30:00-07:00. */
export function toRfc3339(ms: number, tz = LA_TZ): string {
  const off = tzOffsetMin(ms, tz);
  const local = new Date(Math.floor(ms / 1000) * 1000 + off * 60_000).toISOString().slice(0, 19);
  const sign = off < 0 ? "-" : "+";
  const a = Math.abs(off);
  return `${local}${sign}${String(Math.floor(a / 60)).padStart(2, "0")}:${String(a % 60).padStart(2, "0")}`;
}

// --- result parsing ----------------------------------------------------------------

/** `exports={...} os=[] ret=<value> ...` -> ret. undefined when absent. */
export function appRet(text: string): unknown {
  const kw = parseKwargs(text);
  return "ret" in kw ? kw.ret : undefined;
}

function when(v: unknown): number | null {
  const o = v as { dateTime?: string; date?: string } | undefined;
  const s = o?.dateTime ?? o?.date;
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function toZoEvent(raw: unknown): ZoEvent | null {
  const e = raw as Record<string, unknown> | null;
  if (!e || typeof e !== "object" || typeof e.id !== "string") return null;
  const start = when(e.start);
  const end = when(e.end);
  return {
    id: e.id,
    title: String(e.summary ?? "(busy)"),
    start: start ?? 0,
    end: end ?? start ?? 0,
    ...(typeof e.htmlLink === "string" ? { htmlLink: e.htmlLink } : {}),
    ...(typeof e.status === "string" ? { status: e.status } : {}),
    ...(typeof e.location === "string" && e.location ? { location: e.location } : {}),
    ...(!(e.start as { dateTime?: string } | undefined)?.dateTime && (e.start as { date?: string } | undefined)?.date ? { allDay: true } : {}),
  };
}

export function parseNowPlaying(text: string): NowPlaying | null {
  const ret = appRet(text) as Record<string, any> | undefined;
  if (!ret || typeof ret !== "object") return /Nothing/i.test(text) ? { playing: false } : null;
  const item = ret.item ?? ret.track ?? (ret.name ? ret : null);
  const playing = ret.is_playing ?? ret.playing ?? !!item;
  if (!item || typeof item !== "object") return { playing: false };
  const artists = Array.isArray(item.artists) ? item.artists.map((a: any) => a?.name).filter(Boolean) : [];
  return {
    playing: !!playing,
    track: typeof item.name === "string" ? item.name : undefined,
    artist: artists.join(", ") || (typeof item.show?.name === "string" ? item.show.name : undefined),
    id: typeof item.id === "string" ? item.id : undefined,
    progressMs: typeof ret.progress_ms === "number" ? ret.progress_ms : undefined,
    durationMs: typeof item.duration_ms === "number" ? item.duration_ms : undefined,
  };
}

const PRICE_LEVELS: Record<string, string> = {
  PRICE_LEVEL_FREE: "free",
  PRICE_LEVEL_INEXPENSIVE: "$",
  PRICE_LEVEL_MODERATE: "$$",
  PRICE_LEVEL_EXPENSIVE: "$$$",
  PRICE_LEVEL_VERY_EXPENSIVE: "$$$$",
};

function cleanTitle(t: string): string {
  return t.replace(/\s+-\s+Google Maps$/i, "").trim();
}

function sentences(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?])\s+(?=[A-Z*])/)
    .map((s) => s.replace(/\*\*/g, "").replace(/^\*\s*/, "").trim())
    .filter(Boolean);
}

/**
 * maps_search output: a JSON array of strings, one of which is
 * `summary="..." places=[MapPlace(title=..., uri=..., rating=..., price_level=...)]`.
 * Review links are dropped; rating/price/dish/why are pulled from the summary
 * prose when the structured fields are empty (they usually are).
 */
export function parseMapsSearch(text: string, location?: string): { places: ZoPlace[]; summary: string } {
  let chunks: string[] = [text];
  try {
    const j = JSON.parse(text);
    if (Array.isArray(j)) chunks = j.map(String);
  } catch {}
  const body = chunks.find((c) => /^\s*summary=/.test(c)) ?? chunks.find((c) => c.includes("places=")) ?? "";
  const kw = parseKwargs(body);
  const summary = typeof kw.summary === "string" ? kw.summary : "";
  const raw = Array.isArray(kw.places) ? (kw.places as Record<string, unknown>[]) : [];
  const seen = new Set<string>();
  const sents = sentences(summary);
  const places: ZoPlace[] = [];
  for (const p of raw) {
    const title = typeof p?.title === "string" ? p.title : "";
    if (!title || /^review of /i.test(title)) continue;
    const name = cleanTitle(title);
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    // Match prose on the name before any " - Branch" suffix ("Kitakata Ramen Ban Nai - Irvine").
    const short = name.split(/\s+-\s+/)[0]!.toLowerCase();
    const mine: string[] = [];
    let on = false;
    for (const s of sents) {
      const low = s.toLowerCase();
      const mentionsOther = raw.some((o) => {
        const n = typeof o?.title === "string" ? cleanTitle(o.title).split(/\s+-\s+/)[0]!.toLowerCase() : "";
        return n && n !== short && !/^review of /i.test(String(o.title)) && low.includes(n);
      });
      if (low.includes(short)) on = true;
      else if (mentionsOther) on = false;
      if (on) mine.push(s);
    }
    const prose = mine.join(" ");
    const ratingRaw = typeof p.rating === "number" ? p.rating : Number(prose.match(/(\d\.\d)[- ]star/i)?.[1] ?? NaN);
    const range = prose.match(/\$(\d+)\s*[-to]+\s*\$?(\d+)/);
    const lvl = typeof p.price_level === "string" ? PRICE_LEVELS[p.price_level] : undefined;
    const price = range ? `$${range[1]}-${range[2]}` : (lvl ?? "?");
    const cost = range ? Math.round((Number(range[1]) + Number(range[2])) / 2) : lvl ? lvl.length * 10 : undefined;
    const dish = prose.match(/\b((?:spicy|sriracha|umakara)[\w' -]{0,24}?(?:ramen|miso|tan ?tan|tonkotsu|noodles?|curry|wings?|tacos?|chicken|pho))\b/i)?.[1];
    const why = [/spic/i.test(prose) ? "spicy on the menu" : "", range ? `$${range[1]}-${range[2]}` : lvl ?? "", Number.isFinite(ratingRaw) ? `${ratingRaw} stars` : ""]
      .filter(Boolean)
      .join(", ");
    places.push({
      name,
      price,
      ...(cost !== undefined ? { cost } : {}),
      ...(Number.isFinite(ratingRaw) ? { rating: ratingRaw } : {}),
      address: typeof p.address === "string" && p.address ? p.address : location,
      ...(typeof p.uri === "string" ? { url: p.uri } : typeof p.website_uri === "string" ? { url: p.website_uri } : {}),
      why: why || "on Google Maps nearby",
      ...(dish ? { dish: dish.toLowerCase() } : {}),
    });
  }
  // Places the summary never mentions are usually weak matches: keep them, but after the ones it talks about.
  const talked = (x: ZoPlace) => (x.rating !== undefined || x.cost !== undefined ? 0 : 1);
  places.sort((a, b) => talked(a) - talked(b));
  return { places, summary };
}

export function mapsCacheKey(q: MapsQuery): string {
  return [q.query.trim().toLowerCase(), q.location.trim().toLowerCase(), q.openNow ? "open" : "", q.cheap ? "cheap" : "", q.minRating ?? ""].join("|");
}

// --- the service -------------------------------------------------------------------

export interface ZoAppsOptions {
  timeZone?: string;
  mapsTtlMs?: number;
  now?: () => number;
  log?: (...a: unknown[]) => void;
}

export function zoApps(client: ZoClient, opts: ZoAppsOptions = {}): ZoService {
  const tz = opts.timeZone ?? LA_TZ;
  const now = opts.now ?? Date.now;
  const ttl = opts.mapsTtlMs ?? 10 * 60_000;
  const cache = new Map<string, { at: number; places: ZoPlace[]; summary: string }>();
  const inflight = new Map<string, Promise<MapsResult>>();

  const cal = (tool: string, props: Record<string, unknown>, timeoutMs?: number) =>
    client.call("use_app_google_calendar", { tool_name: tool, configured_props: props }, { timeoutMs, priority: "high" });

  const fail = <T>(r: { ok: boolean; ms: number; error?: string; code?: string }): Timed<T> => ({ ok: false, ms: r.ms, error: r.error, code: r.code });

  const mapsLive = async (q: MapsQuery, timeoutMs?: number): Promise<MapsResult> => {
    const r = await client.call(
      "maps_search",
      {
        query: q.query,
        location: q.location,
        ...(q.openNow !== undefined ? { open_now: q.openNow ? "true" : "false" } : {}),
        ...(q.cheap ? { price_level: "PRICE_LEVEL_INEXPENSIVE" } : {}),
        ...(q.minRating ? { min_rating: q.minRating } : {}),
      },
      { timeoutMs: timeoutMs ?? 15_000, priority: "high" },
    );
    if (!r.ok) return { ok: false, places: [], cached: false, ms: r.ms, error: r.error };
    const parsed = parseMapsSearch(r.text, q.location);
    if (parsed.places.length) cache.set(mapsCacheKey(q), { at: now(), ...parsed });
    return { ok: parsed.places.length > 0, places: parsed.places, summary: parsed.summary, cached: false, ms: r.ms, ...(parsed.places.length ? {} : { error: "no places parsed" }) };
  };

  const svc: ZoService = {
    client,
    status: () => client.status(),

    async createEvent(e, o = {}) {
      const r = await cal(
        "google_calendar-create-event",
        {
          calendarId: "primary",
          summary: e.title,
          eventStartDate: toRfc3339(e.start, e.timeZone ?? tz),
          eventEndDate: toRfc3339(e.end, e.timeZone ?? tz),
          timeZone: e.timeZone ?? tz,
          ...(e.location ? { location: e.location } : {}),
          ...(e.description ? { description: e.description } : {}),
          addSelfAsAttendee: false,
          sendUpdates: "none",
        },
        o.timeoutMs,
      );
      if (!r.ok) return fail(r);
      const ev = toZoEvent(appRet(r.text));
      if (!ev) return { ok: false, ms: r.ms, error: `unreadable create result: ${r.text.slice(0, 120)}` };
      return { ok: true, value: ev, ms: r.ms };
    },

    async deleteEvent(id, o = {}) {
      const r = await cal("google_calendar-delete-event", { calendarId: "primary", eventId: id }, o.timeoutMs);
      if (!r.ok) return fail(r);
      return { ok: true, value: { deleted: true }, ms: r.ms };
    },

    async getEvent(id, o = {}) {
      const r = await cal("google_calendar-get-event", { calendarId: "primary", eventId: id }, o.timeoutMs);
      if (!r.ok) return fail(r);
      const ev = toZoEvent(appRet(r.text));
      return ev ? { ok: true, value: ev, ms: r.ms } : { ok: false, ms: r.ms, error: "unreadable event" };
    },

    async listEvents(from, until, o = {}) {
      const r = await cal(
        "google_calendar-list-events",
        {
          calendarId: "primary",
          timeMin: toRfc3339(from, tz),
          timeMax: toRfc3339(until, tz),
          singleEvents: true,
          orderBy: "startTime",
          fields: "compact",
          maxAttendees: 1,
          ...(o.q ? { q: o.q } : {}),
        },
        o.timeoutMs,
      );
      if (!r.ok) return fail(r);
      const ret = appRet(r.text);
      const list = Array.isArray(ret) ? ret : Array.isArray((ret as { items?: unknown[] })?.items) ? (ret as { items: unknown[] }).items : [];
      const events = list.map(toZoEvent).filter((e): e is ZoEvent => !!e && e.status !== "cancelled");
      return { ok: true, value: events, ms: r.ms };
    },

    async freeBusy(from, until, o = {}) {
      const r = await cal("google_calendar-query-free-busy-calendars", { calendarId: ["primary"], timeMin: toRfc3339(from, tz), timeMax: toRfc3339(until, tz), timeZone: tz }, o.timeoutMs);
      if (!r.ok) return fail(r);
      const ret = appRet(r.text) as { calendars?: Record<string, { busy?: { start: string; end: string }[] }> } | undefined;
      const busy = Object.values(ret?.calendars ?? {}).flatMap((c) => c.busy ?? []);
      return { ok: true, value: busy.map((b) => ({ start: Date.parse(b.start), end: Date.parse(b.end) })).filter((b) => Number.isFinite(b.start)), ms: r.ms };
    },

    async nowPlaying(o = {}) {
      const r = await client.call("use_app_spotify", { tool_name: "spotify-get-currently-playing-track", configured_props: {} }, { timeoutMs: o.timeoutMs ?? 12_000, priority: "low" });
      if (!r.ok) return fail(r);
      const np = parseNowPlaying(r.text);
      return np ? { ok: true, value: np, ms: r.ms } : { ok: false, ms: r.ms, error: `unreadable: ${r.text.slice(0, 120)}` };
    },

    async maps(q, o = {}) {
      const key = mapsCacheKey(q);
      const hit = cache.get(key);
      if (!o.fresh && hit && now() - hit.at < ttl) return { ok: true, places: hit.places, summary: hit.summary, cached: true, ms: 0 };
      // A prefetch already on the wire for the same query: ride it instead of paying twice.
      const pending = inflight.get(key);
      if (pending) {
        const t0 = now();
        const r = await pending;
        return { ...r, cached: true, ms: now() - t0 };
      }
      const p = mapsLive(q, o.timeoutMs).finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },

    prefetchMaps(q) {
      const key = mapsCacheKey(q);
      const hit = cache.get(key);
      if ((hit && now() - hit.at < ttl * 0.8) || inflight.has(key)) return;
      const p = mapsLive(q, 20_000).finally(() => inflight.delete(key));
      inflight.set(key, p);
      void p.then((r) => opts.log?.(`zo maps prefetch "${q.query}": ${r.ok ? `${r.places.length} places` : r.error} in ${r.ms}ms`));
    },

    async writeFile(path, content, o = {}) {
      const r = await client.call("write_file", { target_file: path, content }, { timeoutMs: o.timeoutMs ?? 20_000, priority: o.priority ?? "low" });
      return r.ok ? { ok: true, ms: r.ms } : fail(r);
    },

    async readFile(path, o = {}) {
      const r = await client.call("read_file", { target_file: path, read_entire_file: true }, { timeoutMs: o.timeoutMs ?? 20_000, priority: o.priority ?? "low" });
      if (!r.ok) return fail(r);
      // A JSON array: [content, "kind='file_ref' path=..."].
      let content: string | undefined;
      try {
        const j = JSON.parse(r.text);
        if (Array.isArray(j) && typeof j[0] === "string") content = j[0];
      } catch {}
      if (content === undefined) content = typeof parsePy(r.text) === "string" ? (parsePy(r.text) as string) : r.text;
      return { ok: true, value: content, ms: r.ms };
    },

    async listDir(path, o = {}) {
      const r = await client.call("list_directory", { path }, { timeoutMs: o.timeoutMs ?? 15_000, priority: o.priority ?? "low" });
      if (!r.ok) return fail(r);
      const names = [...r.text.matchAll(/^\s*-\s+(\S.*?)\s*$/gm)].map((m) => m[1]!).filter((n) => !n.startsWith("/"));
      return { ok: true, value: names, ms: r.ms };
    },
  };
  return svc;
}
