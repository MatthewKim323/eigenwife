import type { ActionDef, ActionEnv } from "../types";
import type { SearchHit } from "./web";
import { webSearch } from "./web";

export interface Place {
  name: string;
  /** "$", "$$", ... or a dollar estimate like "$12". */
  price: string;
  /** Rough per-person cost in dollars, for comparing. */
  cost?: number;
  rating?: number;
  address?: string;
  url?: string;
  why: string;
  dish?: string;
  source: "zo" | "search" | "frontier" | "demo";
}

export interface PlacePrefs {
  cuisine?: string;
  budget?: "cheap" | "moderate" | "any";
  likes?: string[];
  avoid?: string[];
}

/**
 * Canned fallback: used only in demo mode when search and every brain fail, so
 * the flagship beat never dead-ends. Marked source "demo" everywhere it shows.
 */
export const DEMO_PLACES: Place[] = [
  {
    name: "Kitakata Ramen Ban Nai",
    price: "$",
    cost: 14,
    rating: 4.5,
    address: "Irvine, CA",
    dish: "spicy miso ramen",
    why: "cheap, spicy miso option, close",
    source: "demo",
  },
  {
    name: "Silverlake Ramen",
    price: "$$",
    cost: 18,
    rating: 4.4,
    address: "Irvine, CA",
    dish: "spicy tonkotsu",
    why: "rich tonkotsu, a bit pricier",
    source: "demo",
  },
  {
    name: "Hironori Craft Ramen",
    price: "$$",
    cost: 21,
    rating: 4.7,
    address: "Irvine, CA",
    dish: "tonkotsu black",
    why: "best rated but that's the $21 ramen again",
    source: "demo",
  },
];

/** Short Google Maps query: "cheap spicy ramen". Matches the home module's prefetch queries on purpose. */
export function mapsQuery(prefs: PlacePrefs): string {
  return [prefs.budget === "cheap" ? "cheap" : "", ...(prefs.likes ?? []).slice(0, 2), prefs.cuisine ?? "food"].filter(Boolean).join(" ");
}

const SAVING = /\b(sav(e|ing) (money|up)|broke|on a budget|tight on (money|cash)|spent too much|cheap(er)?)\b/i;

/** Memories say he is saving money: ask Maps for inexpensive places even if prefs did not. */
export function memoriesSaySaving(env: ActionEnv): boolean {
  try {
    return (env.ctx.tryUse("memory")?.all() ?? []).some((m) => SAVING.test(m.content));
  } catch {
    return false;
  }
}

export function placesQuery(prefs: PlacePrefs, location: string): string {
  const bits = [prefs.budget === "cheap" ? "cheap" : "", ...(prefs.likes ?? []).slice(0, 2), prefs.cuisine ?? "dinner"].filter(Boolean);
  return `best ${bits.join(" ")} restaurants near ${location}`;
}

const EXTRACT_SYSTEM = `You pick real restaurants from web search results. Reply with JSON {"places":[{"name":string,"price":string,"cost":number,"rating":number,"address":string,"url":string,"why":string,"dish":string}]}.
Rules: only restaurants named in the results (never list sites like Yelp or TripAdvisor themselves as places). cost is your per-person dollar estimate for one main dish. why is under 8 words and mentions how it fits the preferences. Up to 5 places, best fit first.`;

function coerce(raw: unknown, source: Place["source"]): Place[] {
  const list = (raw as { places?: unknown[] } | null)?.places;
  if (!Array.isArray(list)) return [];
  return list
    .filter((p): p is Record<string, unknown> => !!p && typeof p === "object" && typeof (p as { name?: unknown }).name === "string")
    .map((p) => ({
      name: String(p.name).slice(0, 80),
      price: String(p.price ?? "$$"),
      cost: Number.isFinite(Number(p.cost)) ? Number(p.cost) : undefined,
      rating: Number.isFinite(Number(p.rating)) ? Number(p.rating) : undefined,
      address: p.address ? String(p.address) : undefined,
      url: typeof p.url === "string" && /^https?:/.test(p.url) ? p.url : undefined,
      why: String(p.why ?? ""),
      dish: p.dish ? String(p.dish) : undefined,
      source,
    }));
}

function hitsText(hits: SearchHit[]): string {
  return hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}\n   ${h.description}${h.markdown ? `\n   ${h.markdown.slice(0, 600)}` : ""}`).join("\n");
}

/** Score for comparison: fits budget, rating, preference words in why/dish. Higher is better. */
export function scorePlace(p: Place, prefs: PlacePrefs): number {
  const cost = p.cost ?? (p.price.match(/\$/g)?.length ?? 2) * 10;
  let s = (p.rating ?? 4) * 2;
  if (prefs.budget === "cheap") s -= Math.max(0, cost - 12) * 0.35;
  const text = `${p.name} ${p.why} ${p.dish ?? ""}`.toLowerCase();
  for (const l of prefs.likes ?? []) if (text.includes(l.toLowerCase())) s += 1.5;
  for (const a of prefs.avoid ?? []) if (text.includes(a.toLowerCase())) s -= 3;
  return s;
}

export async function searchPlaces(
  env: ActionEnv,
  prefs: PlacePrefs,
  location: string,
  onProgress?: (t: string) => void,
  opts: { openNow?: boolean } = {},
): Promise<{ places: Place[]; via: string }> {
  // Google Maps through Zo first: real places, ~4-7s live, instant when prefetched.
  const zo = env.deps.env("EVE_ZO_MAPS") === "0" ? null : env.ctx.tryUse("zo");
  if (zo) {
    const q = { query: mapsQuery(prefs), location, openNow: opts.openNow ?? true, cheap: prefs.budget === "cheap" || memoriesSaySaving(env) };
    onProgress?.(`checking Google Maps for "${q.query}" near ${location}`);
    const r = await zo.maps(q, { timeoutMs: 12_000 });
    if (r.ok && r.places.length) {
      onProgress?.(`${r.places.length} places from Google Maps${r.cached ? " (already had them)" : ""}`);
      return { places: r.places.map((p) => ({ ...p, source: "zo" as const })), via: r.cached ? "zo:maps:cache" : "zo:maps" };
    }
    onProgress?.(`Google Maps came back empty (${r.error ?? "no places"}), trying the web`);
  }
  const brains = env.ctx.tryUse("brains");
  const query = placesQuery(prefs, location);
  onProgress?.(`searching "${query}"`);
  const search = await webSearch(env, query, 8, location);
  const prefsLine = `Preferences: ${JSON.stringify(prefs)}. Location: ${location}.`;
  if (search.hits.length) {
    onProgress?.(`${search.hits.length} results via ${search.via}, reading them`);
    const extracted =
      (await brains?.quickJson(EXTRACT_SYSTEM, `${prefsLine}\n\nResults:\n${hitsText(search.hits)}`, { timeoutMs: 20_000 }).catch(() => null)) ??
      (brains ? (await brains.frontier({ goal: `${EXTRACT_SYSTEM}\n\n${prefsLine}\n\nResults:\n${hitsText(search.hits)}`, json: true, tools: "none", timeoutMs: 40_000 }).catch(() => null))?.json : null);
    const places = coerce(extracted, "search");
    if (places.length) return { places, via: `${search.via}+extract` };
  } else {
    onProgress?.(`web search came back empty (${search.errors[0] ?? "no results"})`);
  }
  if (brains) {
    onProgress?.("asking the frontier brain to look it up directly");
    const r = await brains
      .frontier({ goal: `Find 3-5 real restaurants near ${location}. ${prefsLine}\n${EXTRACT_SYSTEM}`, json: true, tools: "read", timeoutMs: 60_000 })
      .catch(() => null);
    const places = coerce(r?.json, "frontier");
    if (places.length) return { places, via: `frontier:${r?.engine ?? "?"}` };
  }
  if (env.ctx.config.demo) {
    onProgress?.("using my saved short list");
    return { places: DEMO_PLACES.map((p) => ({ ...p, address: location })), via: "demo" };
  }
  return { places: [], via: "none" };
}

export const placesSearchAction: ActionDef = {
  kind: "places.search",
  permission: "READ",
  describe: (a) => `look for ${String((a.prefs as PlacePrefs | undefined)?.cuisine ?? "food")} near ${String(a.location ?? "you")}`,
  async run(args, env) {
    const prefs = (args.prefs as PlacePrefs | undefined) ?? { cuisine: typeof args.cuisine === "string" ? args.cuisine : undefined, budget: "cheap" };
    const location = String(args.location ?? "").trim() || env.deps.env("EIGEN_LOCATION") || "Irvine, CA";
    const { places, via } = await searchPlaces(env, prefs, location, env.progress, { openNow: typeof args.openNow === "boolean" ? args.openNow : undefined });
    const ranked = [...places].sort((a, b) => scorePlace(b, prefs) - scorePlace(a, prefs));
    if (!ranked.length) return { ok: false, observation: "found nothing that fits" };
    return {
      ok: true,
      observation: `${ranked.length} places via ${via}: ${ranked
        .slice(0, 3)
        .map((p) => `${p.name} (${p.cost ? `$${p.cost}` : p.price})`)
        .join(", ")}`,
      data: { places: ranked, via },
    };
  },
};
