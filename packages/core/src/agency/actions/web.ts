import type { ActionDef, ActionEnv, FetchLike } from "../types";

const FC = "https://api.firecrawl.dev/v2";

export interface SearchHit {
  title: string;
  url: string;
  description: string;
  markdown?: string;
}

export interface ScrapeResult {
  url: string;
  title: string;
  description: string;
  markdown: string;
  json?: unknown;
  via: "firecrawl" | "fetch";
}

async function withTimeout<T>(p: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    return await p(ac.signal);
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Firecrawl v2
// ---------------------------------------------------------------------------

export async function firecrawlSearch(fetch: FetchLike, key: string, query: string, limit = 5, location?: string): Promise<SearchHit[]> {
  const body: Record<string, unknown> = { query: query.slice(0, 500), limit };
  if (location) body.location = location;
  const res = await withTimeout(
    (signal) => fetch(`${FC}/search`, { method: "POST", signal, headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(body) }),
    15_000,
  );
  const j = (await res.json()) as { success?: boolean; data?: { web?: SearchHit[] } | SearchHit[]; error?: string };
  if (!res.ok || j.success === false) throw new Error(`firecrawl search ${res.status}: ${j.error ?? "failed"}`);
  const web = Array.isArray(j.data) ? j.data : (j.data?.web ?? []);
  return web.map((w) => ({ title: String(w.title ?? ""), url: String(w.url ?? ""), description: String(w.description ?? ""), markdown: w.markdown }));
}

export async function firecrawlScrape(fetch: FetchLike, key: string, url: string, schema?: object, prompt?: string): Promise<ScrapeResult> {
  const formats: unknown[] = [{ type: "markdown" }];
  if (schema) formats.push({ type: "json", schema, ...(prompt ? { prompt } : {}) });
  const res = await withTimeout(
    (signal) =>
      fetch(`${FC}/scrape`, {
        method: "POST",
        signal,
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ url, formats, onlyMainContent: true }),
      }),
    30_000,
  );
  const j = (await res.json()) as { success?: boolean; data?: { markdown?: string; json?: unknown; metadata?: Record<string, unknown> }; error?: string };
  if (!res.ok || !j.success || !j.data) throw new Error(`firecrawl scrape ${res.status}: ${j.error ?? "failed"}`);
  const md = j.data.metadata ?? {};
  return {
    url,
    title: String(md.title ?? ""),
    description: String(md.description ?? ""),
    markdown: j.data.markdown ?? "",
    json: j.data.json,
    via: "firecrawl",
  };
}

// ---------------------------------------------------------------------------
// Keyless fallbacks
// ---------------------------------------------------------------------------

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'", "#x27": "'", "#x2F": "/" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (ENTITIES[e] !== undefined) return ENTITIES[e]!;
    if (e.startsWith("#x") || e.startsWith("#X")) return String.fromCodePoint(parseInt(e.slice(2), 16) || 32);
    if (e.startsWith("#")) return String.fromCodePoint(Number(e.slice(1)) || 32);
    return m;
  });
}

/** Readability-ish: drop chrome, keep headings/paragraphs/list items/prices as markdown-ish text. */
export function htmlToText(html: string): { title: string; description: string; markdown: string } {
  const title = decodeEntities(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? "");
  const description = decodeEntities(
    html.match(/<meta[^>]+name=["']description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]*content=["']([^"']*)["']/i)?.[1] ??
      "",
  );
  let body = html.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html.match(/<body[\s\S]*<\/body>/i)?.[0] ?? html;
  body = body
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<h([1-6])[^>]*>/gi, (_m, n: string) => `\n\n${"#".repeat(Number(n))} `)
    .replace(/<li[^>]*>/gi, "\n- ")
    .replace(/<(br|\/p|\/div|\/h[1-6]|\/li|\/tr|p|div|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  const markdown = decodeEntities(body)
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter((l) => l && l !== "-")
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .slice(0, 20_000);
  return { title, description, markdown };
}

export async function fetchScrape(fetch: FetchLike, url: string): Promise<ScrapeResult> {
  const res = await withTimeout(
    (signal) => fetch(url, { signal, headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15", Accept: "text/html,*/*" } }),
    15_000,
  );
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`);
  const html = await res.text();
  return { url, ...htmlToText(html), via: "fetch" };
}

/** DuckDuckGo's html endpoint: no key, no js. Result links are wrapped in a redirect with uddg=. */
export function parseDuckDuckGo(html: string, limit = 5): SearchHit[] {
  const out: SearchHit[] = [];
  const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < limit) {
    let url = decodeEntities(m[1]!);
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]!);
    if (url.startsWith("//")) url = `https:${url}`;
    if (!/^https?:/.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
    const strip = (s?: string) => decodeEntities((s ?? "").replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    out.push({ url, title: strip(m[2]), description: strip(m[3]) });
  }
  return out;
}

async function duckSearch(fetch: FetchLike, query: string, limit: number): Promise<SearchHit[]> {
  const res = await withTimeout(
    (signal) =>
      fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
        signal,
        headers: { "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15" },
      }),
    12_000,
  );
  if (!res.ok) throw new Error(`duckduckgo ${res.status}`);
  return parseDuckDuckGo(await res.text(), limit);
}

async function brainSearch(env: ActionEnv, query: string, limit: number): Promise<SearchHit[]> {
  const brains = env.ctx.tryUse("brains");
  if (!brains) throw new Error("no brains");
  const r = await brains.frontier({
    goal: `Search the web for: ${query}\nReturn JSON {"results":[{"title":string,"url":string,"description":string}]} with up to ${limit} real results. Only real URLs you actually found.`,
    json: true,
    tools: "read",
    timeoutMs: 45_000,
  });
  const results = (r.json as { results?: SearchHit[] } | undefined)?.results;
  if (!r.ok || !Array.isArray(results)) throw new Error(r.error ?? "frontier search returned nothing");
  return results.filter((x) => x && typeof x.url === "string").slice(0, limit);
}

// ---------------------------------------------------------------------------
// The actions
// ---------------------------------------------------------------------------

/** Try each strategy in order, return the first non-empty answer plus which one worked. */
export async function webSearch(env: ActionEnv, query: string, limit = 5, location?: string): Promise<{ hits: SearchHit[]; via: string; errors: string[] }> {
  const key = env.deps.env("FIRECRAWL_API_KEY");
  const errors: string[] = [];
  const tries: [string, () => Promise<SearchHit[]>][] = [];
  if (key) tries.push(["firecrawl", () => firecrawlSearch(env.deps.fetch, key, query, limit, location)]);
  tries.push(["duckduckgo", () => duckSearch(env.deps.fetch, location && !query.includes(location) ? `${query} ${location}` : query, limit)]);
  tries.push(["frontier", () => brainSearch(env, query, limit)]);
  for (const [via, f] of tries) {
    try {
      const hits = await f();
      if (hits.length) return { hits, via, errors };
      errors.push(`${via}: no results`);
    } catch (err) {
      errors.push(`${via}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { hits: [], via: "none", errors };
}

export async function webScrape(env: ActionEnv, url: string, schema?: object, prompt?: string): Promise<ScrapeResult> {
  if (!/^https?:\/\//i.test(url)) throw new Error("only http(s) urls");
  const key = env.deps.env("FIRECRAWL_API_KEY");
  if (key) {
    try {
      return await firecrawlScrape(env.deps.fetch, key, url, schema, prompt);
    } catch (err) {
      env.ctx.log("agency", "firecrawl scrape failed, falling back to fetch:", String(err));
    }
  }
  const page = await fetchScrape(env.deps.fetch, url);
  if (schema) {
    const brains = env.ctx.tryUse("brains");
    const json = await brains
      ?.quickJson(
        `Extract data from a web page as JSON matching this schema: ${JSON.stringify(schema)}. ${prompt ?? ""} Reply with JSON only.`,
        `${page.title}\n${page.description}\n\n${page.markdown.slice(0, 8000)}`,
        { timeoutMs: 15_000 },
      )
      .catch(() => null);
    if (json) page.json = json;
  }
  return page;
}

export const webSearchAction: ActionDef = {
  kind: "web.search",
  permission: "READ",
  describe: (a) => `search the web for "${String(a.query ?? "")}"`,
  async run(args, env) {
    const query = String(args.query ?? "").trim();
    if (!query) return { ok: false, observation: "empty query" };
    const r = await webSearch(env, query, Number(args.limit ?? 5) || 5, typeof args.location === "string" ? args.location : undefined);
    if (!r.hits.length) return { ok: false, observation: `no results (${r.errors.join("; ")})`, data: r };
    return { ok: true, observation: `${r.hits.length} results via ${r.via}: ${r.hits.map((h) => h.title).slice(0, 3).join(" | ")}`, data: r };
  },
};

export const webScrapeAction: ActionDef = {
  kind: "web.scrape",
  permission: "READ",
  describe: (a) => `read ${String(a.url ?? "a page")}`,
  targets: (a) => [String(a.url ?? "")],
  async run(args, env) {
    try {
      const page = await webScrape(env, String(args.url ?? ""), args.schema as object | undefined, args.prompt as string | undefined);
      return { ok: true, observation: `read "${page.title || page.url}" via ${page.via} (${page.markdown.length} chars)`, data: page };
    } catch (err) {
      return { ok: false, observation: `couldn't read it: ${err instanceof Error ? err.message : String(err)}` };
    }
  },
};
