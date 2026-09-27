import { newId } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { FollowupOption, FollowupPending, FollowupService } from "../services";
import { clockTime, extractTimes, pickTime, resolveChoice, shortName, speakOption, spokenTime, type Option } from "./options";
import { inReported, reported } from "./report";

/**
 * Follow-through (docs/FOLLOW_THROUGH.md). After anything she does, she says
 * how it went in one line and, when there's an obvious next step, asks for it
 * and keeps it in mind: "which one?" over the ramen places on her browser page,
 * "want me to look for a table?", "they have 7:30 or 8:15, want 7:30?", "want
 * it on your calendar?". His next words resolve against that ("the second
 * one", "marufuku", "the cheaper one", "yeah", "8:15"). It expires after about
 * two minutes, or as soon as he talks about something else.
 *
 * Any engine can see it: the world slot followup.pending ("asked which ramen
 * place; options: 1 Mensho 2 Marufuku 3 Nagi") is in every prompt, and the
 * followup service's resolve(utterance) acts on an answer.
 */

const SRC = "followup";

export interface FollowupDeps {
  now(): number;
  env(name: string): string;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}

export interface FollowupOptions {
  deps?: Partial<FollowupDeps>;
  /** How long a pending next step waits for him. Default 2 min. */
  ttlMs?: number;
}

type Step = "open" | "hours" | "availability" | "book" | "calendar" | "reveal" | "read" | "open-other" | "send";

export type Answer =
  | { kind: "choice"; index: number; by: "ordinal" | "name" | "attribute" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "time"; time: string }
  | { kind: "step"; step: Step; arg?: string };

const YES =
  /^(?:(?:yeah|yea|yes|yep|yup|ya|yah|sure|ok(?:ay)?|k|bet|please|pls|perfect|absolutely|definitely|for sure|why not|hell yeah|go for it|go ahead|do it|lock it in|book it|sounds good|that works|works for me|let'?s do (?:it|that)|let'?s go|that one|down)\b[\s,!.]*)+(?:please|then|eve|babe|lol)?[\s.!]*$/i;
const NO =
  /^(?:nah|no|nope|not now|not yet|don'?t|skip(?: it)?|never ?mind|nvm|pass|i'?m good|all good|none of (?:them|those)|neither|cancel|stop|forget it|leave it)\b(?!\s+(?:the|that|this)\s+(?:second|first|third|other|\w+ one))/i;
const FILLER = /^(?:um+|uh+|hm+|mm+|hmm+|ah+|oh|ok|okay|k|cool|nice|right|wait|lol|haha)[\s.!?]*$/i;

const STEP_RULES: { re: RegExp; step: Step; domains: FollowupPending["domain"][] }[] = [
  { re: /\b(?:book(?: it| a table| one)?|reserve|reservation|get (?:us |me )?a table|any tables|availability|check (?:for )?(?:a )?table|look for a table)\b/i, step: "availability", domains: ["places"] },
  { re: /\b(?:hours|open (?:till|until|late|now|tonight)|when (?:do|does) (?:they|it) (?:close|open)|is it open|are they open|still open)\b/i, step: "hours", domains: ["places"] },
  { re: /\b(?:calendar|put it (?:on|in)|add it to my|block (?:it|that) off)\b/i, step: "calendar", domains: ["places"] },
  { re: /^(?:read (?:it|that|me)|what does it say|what'?s in it|summari[sz]e (?:it|that)|tl;?dr|give me the gist)\b/i, step: "read", domains: ["files"] },
  { re: /\b(?:show (?:it |me )?in finder|reveal (?:it|that)|open (?:the |its )?folder)\b/i, step: "reveal", domains: ["files"] },
  { re: /\b(?:the other one|wrong one|not that one|other one)\b/i, step: "open-other", domains: ["files", "places"] },
  { re: /^(?:open (?:it|that|that one|this one)(?: up)?|pull (?:it|that) up|show (?:it to )?me(?: it)?|let me see(?: it)?|go (?:to|look at) (?:it|their site))$/i, step: "open", domains: ["files", "places"] },
];
const SEND = /^(?:send|email|text|share)\s+(?:it|that|this|the file)(?:\s+over)?\s+to\s+(.{2,40})$/i;

/** Classify his utterance against what she's waiting on. Pure. */
export function classify(utterance: string, p: FollowupPending | null): Answer | null {
  if (!p) return null;
  const t = utterance
    .trim()
    .replace(/[?!.]+$/, "")
    .replace(/,/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:um+|uh+|so|and|hmm+|eve|yo)\s+)+/i, "")
    .trim();
  if (!t) return null;
  const opts = p.options as Option[];
  if (p.times?.length) {
    const time = pickTime(t, p.times);
    if (time) return { kind: "time", time };
  }
  const send = SEND.exec(t);
  if (send && p.domain === "files" && (p.chosen?.path || opts[0]?.path)) return { kind: "step", step: "send", arg: send[1]!.trim() };
  if (NO.test(t)) return { kind: "no" };
  if (YES.test(t)) return p.expect === "none" ? null : { kind: "yes" };
  for (const r of STEP_RULES) if (r.domains.includes(p.domain) && r.re.test(t)) {
    // "the other one" while choosing is a choice, not a reopen.
    if (r.step === "open-other" && opts.length < 2) continue;
    return { kind: "step", step: r.step };
  }
  // Choices: while she's asking which one, anything that picks one; after that, only short
  // corrections ("no the older one") so chatter that mentions a name isn't taken as an answer.
  if (opts.length && (p.expect === "choice" || (opts.length > 1 && t.split(/\s+/).length <= 7))) {
    const c = resolveChoice(t, opts);
    if (c) return { kind: "choice", ...c };
  }
  return null;
}

export function joinOr(xs: string[]): string {
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} or ${xs.at(-1)}`;
}

/** "asked which ramen place; options: 1 Mensho 2 Marufuku 3 Nagi" */
export function describePending(p: FollowupPending): string {
  const opts = p.options.slice(0, 5).map((o) => `${o.n} ${shortName(o.name)}`).join(" ");
  if (p.expect === "choice") return `asked ${p.question ? `"${p.question}"` : "which one"}${p.query ? ` (${p.query})` : ""}; options: ${opts}. his answer ("the second one", a name, "the cheaper one") picks one`;
  if (p.expect === "confirm") return `asked "${p.question}"${p.chosen ? ` about ${shortName(p.chosen.name)}` : ""}; a yes does: ${p.next ?? "it"}${p.times?.length ? `; times: ${p.times.join(", ")}` : ""}`;
  return `${p.question || "just did something"}${p.chosen ? ` (${shortName(p.chosen.name)})` : ""}${opts && p.options.length > 1 ? `; others: ${opts}` : ""}`;
}

const MEMORY_WORDS = ["spicy", "cheap", "vegetarian", "vegan", "tonkotsu", "miso", "shoyu", "patio", "quiet", "late", "open late", "halal", "gluten", "chicken", "pork", "beef", "seafood", "noodles", "broth", "boba", "matcha", "cozy", "counter"];

function heuristicPick(options: Option[], memories: string[]): { pick: number; why: string } {
  const mem = memories.join(" ").toLowerCase();
  const broke = /\b(?:broke|cheap|budget|saving|save money|poor|tight)\b/.test(mem);
  for (const w of MEMORY_WORDS) {
    if (!mem.includes(w)) continue;
    const i = options.findIndex((o) => o.detail.includes(w));
    if (i >= 0) return { pick: i, why: `it's got the ${w} thing you like` };
  }
  if (broke) {
    const priced = options.map((o, i) => ({ i, p: o.price ? (/^\$+$/.test(o.price) ? o.price.length : 2) : 9 })).sort((a, b) => a.p - b.p);
    if (priced[0] && priced[0].p < 9) return { pick: priced[0].i, why: "cheapest one and you're saving" };
  }
  let best = 0;
  let score = -1;
  options.forEach((o, i) => {
    const s = (o.rating ?? 0) + Math.log10((o.reviews ?? 1) + 1) * 0.15;
    if (s > score) {
      best = i;
      score = s;
    }
  });
  return { pick: best, why: options[best]?.rating ? "best rated of the bunch" : "looks the most legit" };
}

/** One line: the top options, her pick with a reason, the question. */
export function placesLine(options: Option[], pick: { pick: number; why: string }): string {
  const top = options.slice(0, 3);
  const list = top.map((o) => speakOption(o)).join("; ");
  const p = top[pick.pick] ?? top[0]!;
  return `found ${top.length}: ${list}. i'd do ${shortName(p.name).toLowerCase()}, ${pick.why}. which one?`;
}

function hoursFrom(text: string | undefined): string | null {
  if (!text) return null;
  const m = /\b(open 24 hours|closed(?: now)?|open(?: now)?)\b[\s,.·⋅•]*(?:(closes|opens)[ \t]+(?:at[ \t]+)?(\d{1,2}(?::\d{2})?[ \t]*(?:am|pm)?))?/i.exec(text);
  if (!m) return null;
  const state = m[1]!.toLowerCase().replace(" now", "");
  if (!m[2]) return state === "open" ? "open now" : state;
  return `${state}, ${m[2].toLowerCase()} ${m[3]!.toLowerCase().replace(/\s+/g, " ")}`.replace("open, closes", "open till").replace("closed, opens", "opens");
}

/** A reservation search she can read: OpenTable's public search, tonight, party of 2. */
export function reserveUrl(name: string, location: string, now: number): string {
  const d = new Date(now);
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `https://www.opentable.com/s?term=${encodeURIComponent(`${name} ${location}`.trim())}&covers=2&dateTime=${encodeURIComponent(`${day}T19:00`)}`;
}

/** Times near the restaurant's name on the reservation page (not the page's other listings). */
export function timesFor(name: string, text: string): string[] {
  const short = shortName(name).toLowerCase();
  const lower = text.toLowerCase();
  const at = lower.indexOf(short);
  const slice = at >= 0 ? text.slice(at, at + 900) : text.slice(0, 900);
  return extractTimes(slice, 4);
}

const CONFIRMED = /\b(?:reservation (?:is )?confirmed|booking confirmed|you'?re all set|see you (?:on|at|tonight)|confirmation (?:number|#)|thanks for booking|table is booked)\b/i;

export function createFollowup(ctx: CoreContext, opts: FollowupOptions = {}) {
  const deps: FollowupDeps = {
    now: () => Date.now(),
    env: (n) => process.env[n] ?? "",
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
    ...opts.deps,
  };
  const ttl = opts.ttlMs ?? 120_000;
  const log = (...a: unknown[]) => ctx.log(SRC, ...a);
  let cur: FollowupPending | null = null;
  let timer: unknown = null;
  let busy = false;
  let lastBrowse: { at: number; query?: string; place?: string; url?: string; options: Option[]; text?: string } | null = null;
  const kinds = new Map<string, string>();

  function pending(): FollowupPending | null {
    if (cur && deps.now() > cur.expiresAt) clear("expired");
    return cur;
  }

  function offer(p: Omit<FollowupPending, "id" | "at" | "expiresAt"> & { ttlMs?: number }): FollowupPending {
    if (cur) clear("replaced");
    const at = deps.now();
    const { ttlMs, ...rest } = p;
    const next: FollowupPending = { ...rest, id: newId("fu"), at, expiresAt: at + (ttlMs ?? ttl) };
    cur = next;
    ctx.setSlot("followup", "pending", describePending(next));
    ctx.bus.emit(
      "followup.pending",
      {
        id: next.id,
        domain: next.domain,
        expect: next.expect,
        question: next.question,
        options: next.options.slice(0, 5).map((o) => ({ n: o.n, name: o.name, ...(o.where ? { detail: o.where } : o.rating ? { detail: `${o.rating}${o.price ? ` ${o.price}` : ""}` } : {}) })),
        ...(next.next ? { next: next.next } : {}),
        expiresAt: next.expiresAt,
      },
      SRC,
    );
    if (timer) deps.clearTimer(timer);
    timer = deps.setTimer(() => {
      if (cur?.id === next.id) clear("expired");
    }, ttlMs ?? ttl);
    return next;
  }

  function clear(reason: "done" | "declined" | "expired" | "topic" | "replaced" = "done"): void {
    if (!cur) return;
    const id = cur.id;
    cur = null;
    if (timer) deps.clearTimer(timer);
    timer = null;
    ctx.setSlot("followup", "pending", null);
    ctx.bus.emit("followup.cleared", { id, reason }, SRC);
  }

  function claims(text: string): boolean {
    return !busy && classify(text, pending()) !== null;
  }

  async function say(line: string, parent?: string) {
    const speech = ctx.tryUse("speech");
    if (speech) await speech.say(line, { priority: "high", parent, brain: SRC }).catch(() => {});
    else log(`would say: ${line}`);
  }

  const agency = () => ctx.tryUse("agency");
  // No hardcoded city: "near me" lets the map use where he actually is, unless he names a place.
  const location = () => deps.env("EIGEN_LOCATION") || "";

  // --- places ------------------------------------------------------------------------
  async function opinion(options: Option[], query: string): Promise<{ pick: number; why: string }> {
    const mem = await ctx
      .tryUse("memory")
      ?.recall(`${query} food taste preferences`, { k: 4 })
      .then((h) => h.map((x) => x.record.content))
      .catch(() => [] as string[]);
    const memories = mem ?? [];
    const brains = ctx.tryUse("brains");
    if (brains) {
      const list = options
        .slice(0, 3)
        .map((o, i) => `${i + 1}. ${o.name}${o.rating ? `, ${o.rating}` : ""}${o.price ? `, ${o.price}` : ""}${o.kind ? `, ${o.kind}` : ""} :: ${o.detail.slice(0, 160)}`)
        .join("\n");
      const j = await brains
        .quickJson<{ pick?: number; why?: string }>(
          'You help your person pick a place. JSON {"pick": <1-based number>, "why": "<max 9 words, lowercase, casual, tied to what you know about him if anything fits, never invented facts>"}',
          `${ctx.contextBlock()}\n\nwhat you remember about him:\n${memories.map((m) => `- ${m}`).join("\n") || "- nothing relevant"}\n\nhe asked for: ${query}\noptions:\n${list}`,
          { timeoutMs: 4000 },
        )
        .catch(() => null);
      const n = Number(j?.pick);
      const why = typeof j?.why === "string" ? j.why.trim().replace(/[.!]+$/, "").slice(0, 70) : "";
      if (n >= 1 && n <= Math.min(3, options.length) && why) return { pick: n - 1, why };
    }
    return heuristicPick(options.slice(0, 3), memories);
  }

  async function present(options: Option[], query: string): Promise<string> {
    const pick = await opinion(options, query);
    const line = placesLine(options, pick);
    offer({ domain: "places", expect: "choice", question: "which one?", options: options.slice(0, 3), chosen: options[pick.pick], query });
    return line;
  }

  async function browse(query: string, o: { parent?: string; maps?: boolean } = {}): Promise<{ ok: boolean; summary: string }> {
    return reported(async () => {
      const a = agency();
      if (!a) return { ok: false, summary: "my hands aren't hooked up right now." };
      const q = /\b(?:in|near|around|by)\s+\w/i.test(query) ? query : `${query} near ${location() || "me"}`;
      const r = await a.act("browser.task", { query: q, maps: o.maps ?? true, goal: `look up ${q}`, budget: 10, followup: false }, { parent: o.parent });
      let options = ((r.data as { options?: Option[] } | undefined)?.options ?? []).slice(0, 5);
      if (options.length < 2) {
        // Her page didn't give a clean list (a captcha, a layout change): the places search is the backup.
        const ps = await a.act("places.search", { query: q, ...(location() ? { location: location() } : {}) }, { parent: o.parent }).catch(() => null);
        const places = ((ps?.data as { places?: { name: string; price?: string; rating?: number; address?: string; url?: string; why?: string; dish?: string }[] } | undefined)?.places ?? []).slice(0, 5);
        if (places.length >= 2)
          options = places.map((p, i) => ({ n: i + 1, name: p.name, rating: p.rating, price: p.price, address: p.address, url: p.url, detail: `${p.name} ${p.why ?? ""} ${p.dish ?? ""} ${p.price ?? ""}`.toLowerCase() }));
      }
      if (!r.ok && options.length < 2) return { ok: false, summary: `couldn't pull up ${query}: ${r.observation.replace(/^not done: /, "").slice(0, 100)}` };
      if (options.length < 2) {
        offer({ domain: "web", expect: "none", question: `showed ${q} in her browser`, options: [], query: q });
        return { ok: true, summary: `it's up in my browser, but i couldn't make out a clean list. want me to try a different search?` };
      }
      return { ok: true, summary: await present(options, query) };
    });
  }

  function placeArgs(o: FollowupOption) {
    return { name: o.name, address: o.address ?? location(), url: o.url };
  }

  async function openPlace(o: FollowupOption, parent?: string, focus: "open" | "hours" = "open"): Promise<{ ok: boolean; summary: string }> {
    const a = agency()!;
    const short = shortName(o.name).toLowerCase();
    const r = await a.act("browser.task", { place: placeArgs(o), goal: `check out ${o.name}`, followup: false }, { parent });
    if (!r.ok) {
      offer({ domain: "places", expect: "confirm", question: `want me to look for a table at ${short} anyway?`, options: [o as Option], chosen: o, next: "availability" });
      return { ok: false, summary: `couldn't pull up ${short}. want me to look for a table anyway?` };
    }
    const text = (r.data as { reads?: { text: string }[] } | undefined)?.reads?.at(-1)?.text;
    const hours = hoursFrom(text) ?? (o.hours ? hoursFrom(o.hours) : null);
    const q = "want me to look for a table?";
    offer({ domain: "places", expect: "confirm", question: q, options: [o as Option], chosen: o, next: "availability" });
    if (focus === "hours") return { ok: true, summary: hours ? `${short}'s ${hours}. ${q}` : `couldn't see ${short}'s hours on their page. ${q}` };
    return { ok: true, summary: `pulled up ${short}${hours ? `, ${hours}` : ""}. ${q}` };
  }

  async function availability(o: FollowupOption, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const a = agency()!;
    const short = shortName(o.name).toLowerCase();
    const url = reserveUrl(shortName(o.name), o.address?.split(",").slice(-2).join(",").trim() || location(), deps.now());
    const steps = [
      { op: "open", url },
      { op: "wait", ms: 2500 },
      { op: "scroll", dy: 400 },
      { op: "read", max: 6000 },
    ];
    const r = await a.act("browser.task", { steps, goal: `look for a table at ${o.name}`, followup: false }, { parent });
    const text = (r.data as { reads?: { text: string }[] } | undefined)?.reads?.at(-1)?.text ?? "";
    const times = r.ok ? timesFor(o.name, text) : [];
    if (!times.length) {
      const q = "want it on your calendar anyway?";
      offer({ domain: "places", expect: "confirm", question: q, options: [o as Option], chosen: o, next: "calendar" });
      return { ok: r.ok, summary: `couldn't see open tables for ${short} online. ${q}` };
    }
    const first = times[0]!;
    const q = `they have ${joinOr(times.slice(0, 3).map(spokenTime))}, want ${spokenTime(first)}?`;
    offer({ domain: "places", expect: "confirm", question: q, options: [o as Option], chosen: o, next: "book", times, time: first });
    return { ok: true, summary: q };
  }

  async function book(o: FollowupOption, time: string, heard: { text: string; question: string }, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const a = agency()!;
    const short = shortName(o.name).toLowerCase();
    const label = time.replace(/\s*(am|pm)$/i, "");
    const steps = [
      { op: "click", text: label, submit: true },
      { op: "wait", ms: 2500 },
      { op: "read", max: 4000 },
    ];
    const r = await a.act("browser.submit", { steps, why: `book ${label} at ${o.name}`, goal: `book ${o.name} at ${label}` }, { parent, approved: heard, description: `book ${label} at ${o.name}` });
    if (!r.ok) {
      clear("done");
      return { ok: false, summary: r.observation.startsWith("not done:") ? "okay, not booking it." : `couldn't book it: ${r.observation.replace(/^browsing [^:]+ stopped\.?\s*/, "").slice(0, 90)}. want me to leave their page up?` };
    }
    const text = (r.data as { reads?: { text: string }[] } | undefined)?.reads?.at(-1)?.text ?? "";
    const q = "want it on your calendar?";
    offer({ domain: "places", expect: "confirm", question: q, options: [o as Option], chosen: o, next: "calendar", time });
    if (CONFIRMED.test(text)) return { ok: true, summary: `booked ${short} at ${label}. ${q}` };
    return { ok: true, summary: `i grabbed ${label} at ${short}, but it wants your name and number to finish. it's up in my browser. ${q}` };
  }

  async function calendar(o: FollowupOption, time: string | undefined, heard: { text: string; question: string }, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const a = agency()!;
    const short = shortName(o.name).toLowerCase();
    const start = clockTime(time ?? "7:30 pm");
    const r = await a.act("calendar.create_event", { title: shortName(o.name), start, durationMin: 90, location: o.address ? `${o.name}, ${o.address}` : o.name }, { parent, approved: heard });
    clear("done");
    const spoken = (time ?? "7:30 pm").replace(/\s*pm$/i, "");
    if (r.ok) return { ok: true, summary: `on your calendar, ${spoken} at ${short}.` };
    return { ok: false, summary: r.observation.startsWith("not done:") ? "okay, left it off the calendar." : `couldn't add it to your calendar: ${r.observation.slice(0, 80)}` };
  }

  // --- files -------------------------------------------------------------------------
  async function openFile(o: FollowupOption, all: FollowupOption[], parent?: string): Promise<{ ok: boolean; summary: string }> {
    const a = agency()!;
    const r = await a.act("files.open", { target: o.path }, { parent });
    if (!r.ok) {
      const q = "want me to show it in finder?";
      offer({ domain: "files", expect: "confirm", question: q, options: all as Option[], chosen: o, next: "reveal" });
      return { ok: false, summary: `couldn't open ${o.name}. ${q}` };
    }
    offer({ domain: "files", expect: "none", question: `opened ${o.name}`, options: all as Option[], chosen: o });
    return { ok: true, summary: `opening ${o.name}${o.where ? ` from ${o.where}` : ""}.` };
  }

  // --- resolve -----------------------------------------------------------------------
  async function run(p: FollowupPending, ans: Answer, text: string, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const opts = p.options;
    const heard = { text, question: p.question };
    if (ans.kind === "no") {
      clear("declined");
      return { ok: true, summary: p.expect === "choice" ? "okay, none of them." : "okay." };
    }
    let chosen = p.chosen;
    if (ans.kind === "choice") chosen = opts[ans.index];
    if (ans.kind === "step" && ans.step === "open-other") {
      const others = opts.filter((o) => o !== p.chosen && o.name !== p.chosen?.name);
      chosen = others[0];
      if (!chosen) return { ok: true, summary: "that's the only one i found." };
      return p.domain === "files" ? openFile(chosen, opts, parent) : openPlace(chosen, parent);
    }
    if (!chosen && opts.length === 1) chosen = opts[0];
    if (!chosen) return { ok: true, summary: `which one though? ${joinOr(opts.slice(0, 3).map((o) => shortName(o.name).toLowerCase()))}?` };

    if (p.domain === "files") {
      const a = agency()!;
      const step = ans.kind === "step" ? ans.step : ans.kind === "choice" ? "open" : (p.next as Step | undefined) ?? "open";
      if (step === "reveal") {
        const r = await a.act("files.open", { target: chosen.path, reveal: true }, { parent });
        clear("done");
        return { ok: r.ok, summary: r.ok ? `it's selected in finder.` : `couldn't show it in finder either. it's at ${chosen.where ?? chosen.path}.` };
      }
      if (step === "read") {
        // He asked for it, so now she reads (a short summary, never secrets: files.read redacts).
        const r = await a.act("files.read", { path: chosen.path }, { parent });
        offer({ domain: "files", expect: "none", question: `read ${chosen.name} to him`, options: opts as Option[], chosen });
        return { ok: r.ok, summary: r.ok ? r.observation : `couldn't read it: ${r.observation}` };
      }
      if (step === "send" && ans.kind === "step" && ans.arg) {
        const work = ctx.tryUse("work");
        clear("done");
        if (!work) return { ok: false, summary: "i can't send things from here yet." };
        return work.handle(`email ${ans.arg} with the file ${chosen.path} attached`, { parent });
      }
      return openFile(chosen, opts, parent);
    }

    // places
    const step: Step =
      ans.kind === "step" ? ans.step : ans.kind === "time" ? "book" : ans.kind === "choice" ? "open" : ((p.next as Step | undefined) ?? (p.expect === "choice" ? "open" : "open"));
    switch (step) {
      case "open":
        return openPlace(chosen, parent);
      case "hours":
        return openPlace(chosen, parent, "hours");
      case "availability":
        // "book it" after she already read the times: that's a yes to the time she offered.
        if (p.next === "book" && p.time) return book(chosen, p.time, heard, parent);
        return availability(chosen, parent);
      case "book": {
        const time = ans.kind === "time" ? ans.time : p.time;
        if (!time) return availability(chosen, parent);
        return book(chosen, time, heard, parent);
      }
      case "calendar":
        return calendar(chosen, p.time, ans.kind === "step" ? { text, question: "(he asked for it)" } : heard, parent);
      default:
        return openPlace(chosen, parent);
    }
  }

  async function resolve(text: string, o: { parent?: string } = {}): Promise<{ handled: boolean; ok: boolean; summary: string }> {
    return reported(async () => {
      const p = pending();
      if (!p || busy) return { handled: false, ok: false, summary: "" };
      const ans = classify(text, p);
      if (!ans) return { handled: false, ok: false, summary: "" };
      const choice = ans.kind === "choice" ? p.options[ans.index]?.name : ans.kind === "time" ? ans.time : undefined;
      ctx.bus.emit(
        "followup.resolved",
        {
          id: p.id,
          utterance: text.slice(0, 200),
          step: ans.kind === "step" ? ans.step : ans.kind === "time" ? "book" : ans.kind === "choice" ? "choose" : ans.kind === "yes" ? (p.next ?? "open") : "decline",
          ...(choice ? { choice } : {}),
          by: ans.kind === "choice" ? ans.by : ans.kind === "time" ? "name" : ans.kind,
        },
        SRC,
        o.parent,
      );
      if (!agency() && ans.kind !== "no") return { handled: true, ok: false, summary: "my hands aren't hooked up right now." };
      busy = true;
      try {
        const r = await run(p, ans, text, o.parent);
        return { handled: true, ...r };
      } catch (err) {
        clear("done");
        return { handled: true, ok: false, summary: `that broke: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        busy = false;
      }
    });
  }

  // --- never quiet: outcome lines for actions nobody else reports -------------------------
  function noteBrowse(run: { query?: string; place?: string; url?: string; options: FollowupOption[]; text?: string }) {
    lastBrowse = { at: deps.now(), ...run, options: run.options as Option[] };
  }

  const FAIL_LINES: Record<string, (obs: string) => string> = {
    "music.play": () => "couldn't get spotify to play that. is it open?",
    "music.control": () => "spotify didn't listen to me.",
    "app.quit": (obs) => `couldn't quit it${/allow|not allowed|refus/i.test(obs) ? ", i'm not allowed to close that one" : ""}.`,
    "files.open": (obs) => `couldn't open it: ${obs.replace(/^not done: /, "").slice(0, 80)}.`,
  };

  async function announceBrowse(parent?: string) {
    const b = lastBrowse;
    lastBrowse = null;
    if (!b || deps.now() - b.at > 10_000) return;
    busy = true;
    try {
      let line: string;
      if (b.options.length >= 2) line = await present(b.options, b.query ?? "that");
      else if (b.place) {
        const o: FollowupOption = { n: 1, name: b.place, detail: b.place.toLowerCase(), ...(b.url ? { url: b.url } : {}) };
        const hours = hoursFrom(b.text);
        const q = "want me to look for a table?";
        offer({ domain: "places", expect: "confirm", question: q, options: [o as Option], chosen: o, next: "availability" });
        line = `that's ${shortName(b.place).toLowerCase()}${hours ? `, ${hours}` : ""}. ${q}`;
      } else line = "it's up in my browser.";
      await say(line, parent);
    } finally {
      busy = false;
    }
  }

  const offs: (() => void)[] = [];
  offs.push(
    ctx.bus.on("action.request", (e) => {
      if (e.source !== "agency") return;
      kinds.set(e.data.actionId, e.data.kind);
      if (kinds.size > 200) kinds.delete(kinds.keys().next().value!);
    }),
    ctx.bus.on("action.result", (e) => {
      const kind = kinds.get(e.data.actionId);
      kinds.delete(e.data.actionId);
      // work.handle and the follow-up flows say their own outcome line.
      if (!kind || inReported()) return;
      if (kind === "browser.task" && e.data.ok) void announceBrowse(e.parent);
      else if (!e.data.ok && FAIL_LINES[kind] && !e.data.observation.startsWith("not done:")) void say(FAIL_LINES[kind]!(e.data.observation), e.parent);
    }),
    // He moved on: a new topic drops the pending question (a filler "hm" doesn't).
    ctx.bus.on("voice.final", (e) => {
      const p = pending();
      if (!p || busy) return;
      const text = e.data.text.trim();
      if (!text || FILLER.test(text) || text.split(/\s+/).length < 3) return;
      if (classify(text, p) === null) clear("topic");
    }),
  );

  const service: FollowupService = { pending, claims, resolve, offer, clear: (r) => clear(r), browse, noteBrowse };

  return {
    service,
    stop() {
      for (const off of offs.splice(0)) off();
      if (timer) deps.clearTimer(timer);
    },
  };
}

export function followupModule(opts: FollowupOptions = {}): Module {
  let f: ReturnType<typeof createFollowup> | null = null;
  return {
    name: "followup",
    start(ctx) {
      f = createFollowup(ctx, opts);
      ctx.provide("followup", f.service);
      ctx.route("/api/followup", () => json({ ok: true, pending: f!.service.pending() }));
    },
    stop() {
      f?.stop();
    },
  };
}
