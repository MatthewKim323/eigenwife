import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { BROWSER_LIMITS, httpUrl, shortUrl, type BrowserRun, type BrowserStep } from "../browser/driver";
import type { ActionDef, ActionEnv, ActionOutcome } from "../types";
import type { Place } from "./places";

/**
 * browser.task / browser.submit: Eve does it herself in her own visible
 * browser (docs/AGENT_CURSOR.md). Browsing and reading are SAFE_ACTION. The
 * moment a step would submit something (a POST form, a "Book" / "Pay" button,
 * or a step marked submit), the run stops and asks through the gate as
 * browser.submit, an EXTERNAL_SIDE_EFFECT that needs a spoken yes.
 */

const OPS = new Set(["open", "click", "type", "scroll", "read", "screenshot", "wait"]);

/** Validate steps from a brain or an HTTP caller. Unknown shapes are dropped. */
export function normalizeSteps(raw: unknown): BrowserStep[] {
  if (!Array.isArray(raw)) return [];
  const out: BrowserStep[] = [];
  for (const r of raw) {
    if (!r || typeof r !== "object") continue;
    const s = r as Record<string, unknown>;
    const op = String(s.op ?? "");
    if (!OPS.has(op)) continue;
    const str = (k: string) => (typeof s[k] === "string" && (s[k] as string).trim() ? (s[k] as string).slice(0, 300) : undefined);
    const flag = (k: string) => (s[k] === true ? true : undefined);
    switch (op) {
      case "open":
        if (str("url")) out.push({ op, url: str("url")! });
        break;
      case "click":
        if (str("selector") || str("text")) out.push(prune({ op, selector: str("selector"), text: str("text"), optional: flag("optional"), submit: flag("submit") }));
        break;
      case "type":
        if ((str("selector") || str("text")) && typeof s.value === "string") out.push(prune({ op, selector: str("selector"), text: str("text"), value: s.value.slice(0, 500), enter: flag("enter"), optional: flag("optional"), submit: flag("submit") }));
        break;
      case "scroll":
        out.push(prune({ op, dy: Number.isFinite(Number(s.dy)) && s.dy !== undefined ? Math.max(-4000, Math.min(4000, Number(s.dy))) : undefined, selector: str("selector"), text: str("text") }));
        break;
      case "read":
        out.push(prune({ op, max: Number.isFinite(Number(s.max)) && s.max !== undefined ? Number(s.max) : undefined }));
        break;
      case "screenshot":
        out.push({ op });
        break;
      case "wait":
        out.push({ op, ms: Math.max(0, Math.min(5000, Number(s.ms) || 800)) });
        break;
    }
  }
  return out;
}

function prune<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined) delete o[k];
  return o;
}

const isMaps = (u: string) => /(^|\.)google\.[a-z.]+\/maps|maps\.google\./i.test(u.replace(/^https?:\/\//, ""));

export function mapsSearchUrl(q: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(q).replace(/%20/g, "+")}`;
}

/** Any page: have a look, check the menu and the hours if there are any, read it. */
export function lookAroundSteps(url: string): BrowserStep[] {
  return [
    { op: "open", url },
    { op: "wait", ms: 1200 },
    { op: "scroll", dy: 480 },
    { op: "click", text: "Menu", optional: true },
    { op: "wait", ms: 900 },
    { op: "scroll", dy: 520 },
    { op: "click", text: "Hours", optional: true },
    { op: "read" },
  ];
}

/** Google Maps search results: scroll the results list like a person skimming. */
export function mapsSearchSteps(query: string): BrowserStep[] {
  return [
    { op: "open", url: mapsSearchUrl(query) },
    { op: "wait", ms: 2200 },
    { op: "scroll", dy: 520, selector: "div[role=feed]" },
    { op: "wait", ms: 500 },
    { op: "scroll", dy: 640, selector: "div[role=feed]" },
    { op: "read", max: 4000 },
  ];
}

/** One place: its own site when we have it, else its Maps page (menu tab, hours). */
export function placeSteps(p: Pick<Place, "name" | "address" | "url">): BrowserStep[] {
  if (p.url && !isMaps(p.url) && httpUrl(p.url)) return lookAroundSteps(p.url);
  return [
    { op: "open", url: p.url && isMaps(p.url) ? p.url : mapsSearchUrl([p.name, p.address].filter(Boolean).join(" ")) },
    { op: "wait", ms: 2400 },
    { op: "click", selector: 'button[role=tab][aria-label^="Menu"]', optional: true },
    { op: "wait", ms: 900 },
    { op: "scroll", dy: 560, selector: "div[role=main]" },
    { op: "click", selector: 'button[role=tab][aria-label^="Overview"]', optional: true },
    { op: "click", selector: '[aria-label*="hours" i]', optional: true },
    { op: "wait", ms: 900 },
    { op: "read", max: 4000 },
  ];
}

/** A plain search she can see (DuckDuckGo: keyless, no captcha wall), then the first result. */
export function searchSteps(query: string): BrowserStep[] {
  return [
    { op: "open", url: `https://duckduckgo.com/?q=${encodeURIComponent(query)}` },
    { op: "wait", ms: 1400 },
    { op: "click", selector: '[data-testid="result-title-a"]', optional: true },
    { op: "wait", ms: 1400 },
    { op: "scroll", dy: 520 },
    { op: "read", max: 4000 },
  ];
}

// The last place the planner picked, so "show me" / "open it" knows what "it" is.
let lastPlace: Pick<Place, "name" | "address" | "url"> | null = null;
export function rememberPlace(p: Pick<Place, "name" | "address" | "url"> | null): void {
  lastPlace = p ? { name: p.name, address: p.address, url: p.url } : null;
}
export function rememberedPlace() {
  return lastPlace;
}

/** Turn browser.task args into steps: explicit steps, a place, a url, a query, or "it". */
export function stepsFor(args: Record<string, unknown>, env?: Pick<ActionEnv, "ctx">): { steps: BrowserStep[]; what: string } {
  const steps = normalizeSteps(args.steps);
  if (steps.length) return { steps, what: String(args.goal ?? "browse") };
  const place = args.place as Place | undefined;
  if (place && typeof place.name === "string") return { steps: placeSteps(place), what: place.name };
  const url = httpUrl(args.url);
  if (url) return { steps: lookAroundSteps(url), what: shortUrl(url) };
  const q = typeof args.query === "string" ? args.query.trim() : "";
  const qUrl = httpUrl(q) ?? (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(q) ? httpUrl(`https://${q}`) : null);
  if (qUrl) return { steps: lookAroundSteps(qUrl), what: shortUrl(qUrl) };
  if (args.maps === true && q) return { steps: mapsSearchSteps(q), what: q };
  if (q && !/^(?:it|that|this|that one|this one|the place|there)$/i.test(q)) return { steps: searchSteps(q), what: q };
  if (lastPlace) return { steps: placeSteps(lastPlace), what: lastPlace.name };
  const page = env?.ctx.world().desktop.page?.url;
  if (page && httpUrl(page)) return { steps: lookAroundSteps(page), what: shortUrl(page) };
  return { steps: [], what: "" };
}

function saveShots(run: BrowserRun, env: ActionEnv): string[] {
  if (!run.shots.length) return [];
  const dir = join(env.deps.env("EVE_HOME") || join(process.env.HOME ?? "", ".eve"), "browser", "shots");
  try {
    mkdirSync(dir, { recursive: true });
    return run.shots.map((b, i) => {
      const p = join(dir, `${env.deps.now()}-${i}.png`);
      writeFileSync(p, b);
      return p;
    });
  } catch {
    return [];
  }
}

function summarize(run: BrowserRun, what: string): string {
  const did = run.trace.filter((t) => t.ok && t.note).map((t) => t.note);
  const title = run.reads.at(-1)?.title;
  const head = run.ok ? `browsed ${what}` : `browsing ${what} stopped`;
  const tail = did.length ? `: ${did.slice(-4).join(", ")}` : "";
  const failed = run.trace.find((t) => !t.ok && !t.skipped && t.note);
  return `${head}${tail}${title ? ` (read "${title.slice(0, 60)}")` : ""}${!run.ok && failed ? `. ${failed.note}` : ""}${run.truncated ? `. ${run.truncated} steps over budget skipped` : ""}`;
}

function outcome(run: BrowserRun, what: string, env: ActionEnv): ActionOutcome {
  const shots = saveShots(run, env);
  return {
    ok: run.ok,
    observation: summarize(run, what),
    data: { trace: run.trace, url: run.url, reads: run.reads.map((r) => ({ ...r, text: r.text.slice(0, 4000) })), shots, truncated: run.truncated ?? 0 },
  };
}

const budgetOf = (args: Record<string, unknown>) => Math.max(1, Math.min(BROWSER_LIMITS.maxBudget, Number(args.budget) || BROWSER_LIMITS.defaultBudget));

function openUrls(args: Record<string, unknown>): string[] {
  return normalizeSteps(args.steps)
    .filter((s): s is Extract<BrowserStep, { op: "open" }> => s.op === "open")
    .map((s) => s.url);
}

export const browserTask: ActionDef = {
  kind: "browser.task",
  permission: "SAFE_ACTION",
  describe: (a) => (typeof a.goal === "string" && a.goal ? String(a.goal) : `look at ${stepsFor(a).what || "that"} in my browser`),
  targets: (a) => [...openUrls(a), typeof a.url === "string" ? a.url : ""].filter(Boolean),
  refuse: (a) => {
    const bad = openUrls(a).find((u) => !httpUrl(u));
    return bad ? `refusing non-web url ${JSON.stringify(bad)}` : null;
  },
  async run(args, env) {
    if (!env.browser) return { ok: false, observation: "my browser isn't set up (playwright-core or Chromium missing)" };
    const { steps, what } = stepsFor(args, env);
    if (!steps.length) return { ok: false, observation: "open what? I don't have anything to show you yet" };
    const run = await env.browser.run(steps, { budget: budgetOf(args), allowSubmit: false, progress: env.progress });
    if (run.needsSubmit) {
      env.progress?.(`${run.needsSubmit.why} needs your ok`);
      const sub = await env.act("browser.submit", { steps: run.needsSubmit.remaining, why: run.needsSubmit.why, goal: args.goal ?? what, budget: budgetOf(args) });
      const first = outcome(run, what, env);
      return { ok: sub.ok, observation: `${first.observation}. ${sub.ok ? sub.observation : `didn't submit: ${sub.observation.replace(/^not done: /, "")}`}`, data: { first: first.data, submit: sub.data } };
    }
    return outcome(run, what, env);
  },
};

export const browserSubmit: ActionDef = {
  kind: "browser.submit",
  permission: "EXTERNAL_SIDE_EFFECT",
  describe: (a) => `press ${String(a.why ?? "submit")} in my browser${a.goal ? ` for ${String(a.goal)}` : ""}`,
  targets: (a) => openUrls(a),
  refuse: (a) => (normalizeSteps(a.steps).length ? null : "nothing to submit"),
  async run(args, env) {
    if (!env.browser) return { ok: false, observation: "my browser isn't set up" };
    const run = await env.browser.run(normalizeSteps(args.steps), { budget: budgetOf(args), allowSubmit: true, progress: env.progress });
    return outcome(run, String(args.why ?? "the form"), env);
  },
};

export const browserClose: ActionDef = {
  kind: "browser.close",
  permission: "SAFE_ACTION",
  describe: () => "close my browser",
  async run(_args, env) {
    if (!env.browser) return { ok: true, observation: "my browser wasn't open" };
    await env.browser.close();
    return { ok: true, observation: "closed my browser" };
  },
};

export const BROWSER_ACTIONS: ActionDef[] = [browserTask, browserSubmit, browserClose];
