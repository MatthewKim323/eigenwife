import { runJxa, type OsaRunner } from "./osa";

/**
 * macOS Contacts lookup for messages.send (docs/MESSAGES.md).
 *
 * Privacy: the whole address book is matched INSIDE the osascript process.
 * Only the candidates for this one send (name + their phone numbers / emails)
 * ever come back to Eve; nobody else's details leave Contacts.app.
 */

export interface ContactHandle {
  kind: "phone" | "email";
  value: string;
  label?: string;
}

export interface ContactCandidate {
  id: string;
  name: string;
  score: number;
  /** Full-name (or nickname) exact match, not just a prefix or sound-alike. */
  exact: boolean;
  /** Every spoken word matched exactly or by sound ("stephen" ~ "steven"), no prefixes or typos. */
  strong?: boolean;
  handles: ContactHandle[];
}

export interface ContactRow {
  name?: string | null;
  first?: string | null;
  last?: string | null;
  nick?: string | null;
}

/**
 * Score every row against the spoken name. Self-contained on purpose: its
 * source is pasted into the JXA script (fn.toString()), so it may not use
 * imports, closures over module state, or TypeScript-only runtime features.
 * Every query word has to hit some part of the name (exact, sound-alike,
 * prefix, or one edit away), so "stephen" finds Stephen Hung and Steven Lee,
 * "stephen hung" finds only the first, and "steve" finds both.
 */
export function scoreContactRows(query: string, rows: ContactRow[], limit: number): { i: number; score: number; exact: boolean; strong: boolean }[] {
  function norm(s: unknown): string {
    return String(s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .replace(/'/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }
  function sound(w: string): string {
    return w
      .replace(/ph/g, "f")
      .replace(/v/g, "f")
      .replace(/ck/g, "k")
      .replace(/c(?=[aoukrl])/g, "k")
      .replace(/(?!^)h/g, "")
      .replace(/(.)\1+/g, "$1");
  }
  function oneEdit(a: string, b: string): boolean {
    if (a === b) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    let i = 0;
    let j = 0;
    let edits = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        i++;
        j++;
        continue;
      }
      if (++edits > 1) return false;
      if (a.length > b.length) i++;
      else if (b.length > a.length) j++;
      else {
        i++;
        j++;
      }
    }
    return edits + (a.length - i) + (b.length - j) <= 1;
  }
  function wordScore(q: string, w: string): number {
    if (!q || !w) return 0;
    if (q === w) return 3;
    const sq = sound(q);
    const sw = sound(w);
    // Sound-alikes only for real names ("stephen" ~ "steven"), never "leo" ~ "lee".
    if (q.length >= 4 && w.length >= 4 && sq === sw) return 2.5;
    if (q.length >= 2 && w.startsWith(q)) return 2;
    if (q.length >= 4 && w.length >= 4 && oneEdit(sq, sw)) return 1.5;
    return 0;
  }
  const q = norm(query);
  const qWords = q.split(" ").filter(Boolean);
  if (!qWords.length) return [];
  const out: { i: number; score: number; exact: boolean; strong: boolean }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i] || {};
    const full = norm(r.name) || norm([r.first, r.last].filter(Boolean).join(" "));
    const nick = norm(r.nick);
    const words = [full, norm(r.first), norm(r.last), nick].join(" ").split(" ").filter(Boolean);
    if (!words.length) continue;
    let score = 0;
    let ok = true;
    let strong = true;
    for (const qw of qWords) {
      let best = 0;
      for (const w of words) best = Math.max(best, wordScore(qw, w));
      if (!best) {
        ok = false;
        break;
      }
      if (best < 2.5) strong = false;
      score += best;
    }
    if (!ok) continue;
    const firstLast = norm([r.first, r.last].filter(Boolean).join(" "));
    const exact = q === full || q === nick || q === firstLast;
    if (exact) score += 2;
    out.push({ i, score, exact, strong: strong || exact });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, Math.max(1, limit));
}

/**
 * Constant JXA: argv[0] is {query, limit}. Bulk-reads names in one Apple
 * Event each, matches in-process, then reads phones/emails only for matches.
 */
export const CONTACTS_FIND_JXA = `
${scoreContactRows.toString()}
function run(argv) {
  var q = JSON.parse(argv[0]);
  var app = Application("Contacts");
  var people = app.people;
  var names = people.name(), firsts = people.firstName(), lasts = people.lastName(), nicks = people.nickname();
  var rows = [];
  for (var i = 0; i < names.length; i++) rows.push({ name: names[i], first: firsts[i], last: lasts[i], nick: nicks[i] });
  var hits = scoreContactRows(String(q.query || ""), rows, Number(q.limit) || 6);
  var out = [];
  for (var k = 0; k < hits.length; k++) {
    var p = people[hits[k].i];
    var handles = [];
    try {
      var pv = p.phones.value(), pl = p.phones.label();
      for (var a = 0; a < pv.length; a++) if (pv[a]) handles.push({ kind: "phone", value: String(pv[a]), label: String(pl[a] || "") });
    } catch (e) {}
    try {
      var ev = p.emails.value(), el = p.emails.label();
      for (var b = 0; b < ev.length; b++) if (ev[b]) handles.push({ kind: "email", value: String(ev[b]), label: String(el[b] || "") });
    } catch (e) {}
    out.push({ id: String(p.id()), name: String(names[hits[k].i] || ""), score: hits[k].score, exact: hits[k].exact, strong: hits[k].strong, handles: handles });
  }
  return JSON.stringify({ candidates: out });
}
`;

/** Constant JXA: argv[0] is {id}. The handles on one card, to double-check a send target. */
export const CONTACT_HANDLES_JXA = `
function run(argv) {
  var q = JSON.parse(argv[0]);
  var app = Application("Contacts");
  var p = app.people.byId(String(q.id || ""));
  var name = "";
  try { name = String(p.name()); } catch (e) { return JSON.stringify({ found: false, handles: [] }); }
  var handles = [];
  try { var pv = p.phones.value(); for (var a = 0; a < pv.length; a++) handles.push({ kind: "phone", value: String(pv[a]) }); } catch (e) {}
  try { var ev = p.emails.value(); for (var b = 0; b < ev.length; b++) handles.push({ kind: "email", value: String(ev[b]) }); } catch (e) {}
  return JSON.stringify({ found: true, name: name, handles: handles });
}
`;

export type ContactLookup = { ok: true; candidates: ContactCandidate[] } | { ok: false; error: string };

export async function findContacts(osa: OsaRunner, query: string, limit = 6, timeoutMs = 20_000): Promise<ContactLookup> {
  const q = query.trim();
  if (!q) return { ok: true, candidates: [] };
  const r = await runJxa<{ candidates?: ContactCandidate[] }>(osa, CONTACTS_FIND_JXA, { query: q, limit }, timeoutMs);
  if (!r.ok) return { ok: false, error: contactsError(r.error) };
  return { ok: true, candidates: Array.isArray(r.value.candidates) ? r.value.candidates : [] };
}

export async function contactHandles(osa: OsaRunner, id: string, timeoutMs = 15_000): Promise<{ ok: true; found: boolean; name?: string; handles: ContactHandle[] } | { ok: false; error: string }> {
  const r = await runJxa<{ found?: boolean; name?: string; handles?: ContactHandle[] }>(osa, CONTACT_HANDLES_JXA, { id }, timeoutMs);
  if (!r.ok) return { ok: false, error: contactsError(r.error) };
  return { ok: true, found: !!r.value.found, name: r.value.name, handles: Array.isArray(r.value.handles) ? r.value.handles : [] };
}

function contactsError(err: string): string {
  if (/-1743|not authori[sz]ed|not allowed/i.test(err)) return "i'm not allowed into Contacts yet (System Settings > Privacy & Security > Contacts / Automation)";
  return err.slice(0, 200);
}

/** Digits for phones (last 10, so +1 (949) 555-0100 == 9495550100), lowercase for emails. */
export function handleKey(h: string): string {
  const s = String(h).trim();
  if (s.includes("@")) return s.toLowerCase();
  const digits = s.replace(/\D/g, "");
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** iMessage-able handle to use: a mobile/iPhone number, then any number, then an email. */
export function bestHandle(c: Pick<ContactCandidate, "handles">): ContactHandle | null {
  const phones = c.handles.filter((h) => h.kind === "phone" && handleKey(h.value).length >= 7);
  const mobile = phones.find((h) => /mobile|iphone|cell/i.test(h.label ?? ""));
  return mobile ?? phones[0] ?? c.handles.find((h) => h.kind === "email" && h.value.includes("@")) ?? null;
}

export type ContactPick = { kind: "one"; contact: ContactCandidate; handle: ContactHandle } | { kind: "many"; options: ContactCandidate[] } | { kind: "none" } | { kind: "no_handle"; contact: ContactCandidate };

/**
 * One clear match wins (the only match, the only exact full-name match,
 * or the only card every spoken word matches by sound), otherwise she asks. Cards with the same name and the same number count once.
 */
export function pickContact(candidates: ContactCandidate[]): ContactPick {
  const seen = new Set<string>();
  const usable: ContactCandidate[] = [];
  for (const c of candidates) {
    const h = bestHandle(c);
    const key = `${c.name.toLowerCase()}|${h ? handleKey(h.value) : c.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    usable.push(c);
  }
  if (!usable.length) return { kind: "none" };
  const withHandle = usable.filter((c) => bestHandle(c));
  if (!withHandle.length) return { kind: "no_handle", contact: usable[0]! };
  const exact = withHandle.filter((c) => c.exact);
  const strong = withHandle.filter((c) => c.strong);
  // Only the query's full words (or their sound-alikes) on exactly one card: "stephen hung" -> Steven Hung, not Stephen Huang.
  const chosen = withHandle.length === 1 ? withHandle[0] : exact.length === 1 ? exact[0] : !exact.length && strong.length === 1 && withHandle[0] === strong[0] ? strong[0] : null;
  if (chosen) return { kind: "one", contact: chosen, handle: bestHandle(chosen)! };
  return { kind: "many", options: (exact.length > 1 ? exact : withHandle).slice(0, 4) };
}

/** How she names the options out loud. Same-name cards get the last 4 digits. */
export function optionLabels(options: ContactCandidate[]): string[] {
  const lower = options.map((o) => o.name.toLowerCase());
  return options.map((o, i) => {
    const name = o.name.toLowerCase();
    if (lower.filter((n) => n === lower[i]).length < 2) return name;
    const h = bestHandle(o);
    if (!h) return name;
    return h.kind === "phone" ? `${name} (ending ${handleKey(h.value).slice(-4)})` : `${name} (${h.value.toLowerCase()})`;
  });
}

/** "stephen hung or stephen lee?" / "stephen hung, stephen lee, or stephen wu?" */
export function whichQuestion(options: ContactCandidate[]): string {
  const labels = optionLabels(options);
  if (labels.length === 2) return `${labels[0]} or ${labels[1]}?`;
  return `${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}?`;
}

const ORDINALS: [RegExp, number][] = [
  [/\b(?:first|1st|former|top)\b/, 0],
  [/\b(?:second|2nd|two|other|latter)\b/, 1],
  [/\b(?:third|3rd|three)\b/, 2],
  [/\b(?:fourth|4th|four)\b/, 3],
];

/** Which option the answer points at ("stephen lee", "lee", "the second one", "the one ending 4821"), or null. */
export function chooseOption(answer: string, options: ContactCandidate[]): ContactCandidate | null {
  const a = answer.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
  if (!a) return null;
  const digits = a.replace(/\D/g, "");
  if (digits.length >= 3) {
    const hits = options.filter((o) => o.handles.some((h) => handleKey(h.value).endsWith(digits)));
    if (hits.length === 1) return hits[0]!;
  }
  // Words that tell the options apart (drop the ones every option shares, like "stephen").
  const tokens = options.map((o) => new Set(o.name.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter(Boolean)));
  const shared = new Set([...tokens[0]!].filter((t) => tokens.every((s) => s.has(t))));
  const words = a.split(" ").filter((w) => w.length > 1 && !shared.has(w));
  const scored = options.map((o, i) => ({ o, n: words.filter((w) => [...tokens[i]!].some((t) => t === w || (w.length >= 3 && t.startsWith(w)))).length }));
  const best = Math.max(...scored.map((s) => s.n));
  if (best > 0) {
    const top = scored.filter((s) => s.n === best);
    if (top.length === 1) return top[0]!.o;
  }
  if (options.length <= 4 && /\b(?:the\s+)?(?:\w+\s+)?one\b|\b(?:first|second|third|fourth|1st|2nd|3rd|4th|former|latter|other)\b/.test(a)) {
    for (const [re, idx] of ORDINALS) if (re.test(a) && options[idx]) return options[idx]!;
  }
  return null;
}
