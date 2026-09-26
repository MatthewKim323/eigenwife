import { runJxa } from "../osa";
import type { ActionDef } from "../types";

export const EVE_CALENDAR = "Eigenwife";

/**
 * JXA: create an event. Payload arrives as argv[0] JSON, never spliced into source.
 * Finds (or makes) the named calendar, falls back to the first writable one.
 * Calendar.app is slow (5-10s per write), so callers give this a long timeout.
 */
export const CREATE_EVENT_JXA = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var Cal = Application("Calendar");
  var cal = null, fellBack = false;
  var named = Cal.calendars.whose({ name: p.calendar })();
  if (named.length) cal = named[0];
  if (!cal) {
    try {
      var made = Cal.Calendar({ name: p.calendar });
      Cal.calendars.push(made);
      var again = Cal.calendars.whose({ name: p.calendar })();
      if (again.length) cal = again[0];
    } catch (e) {}
  }
  if (!cal) {
    var all = Cal.calendars();
    for (var i = 0; i < all.length; i++) { try { if (all[i].writable()) { cal = all[i]; fellBack = true; break; } } catch (e) {} }
  }
  if (!cal) throw new Error("no writable calendar");
  var ev = Cal.Event({ summary: p.title, startDate: new Date(p.start), endDate: new Date(p.end), location: p.location || "", description: p.notes || "" });
  cal.events.push(ev);
  return JSON.stringify({ uid: ev.uid(), calendar: cal.name(), fellBack: fellBack });
}`;

export const DELETE_EVENT_JXA = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var Cal = Application("Calendar");
  var cals = p.calendar ? Cal.calendars.whose({ name: p.calendar })() : Cal.calendars(), n = 0;
  for (var i = 0; i < cals.length; i++) {
    try {
      if (!p.calendar && !cals[i].writable()) continue;
      var hits = cals[i].events.whose({ uid: p.uid })();
      for (var j = 0; j < hits.length; j++) { Cal.delete(hits[j]); n++; }
    } catch (e) {}
  }
  return JSON.stringify({ deleted: n });
}`;

/** Writable calendars only: read-only holiday feeds take 10-35s each to query. */
export const LIST_CALENDARS_JXA = `
function run(argv) {
  var Cal = Application("Calendar");
  var names = Cal.calendars.name(), writable = Cal.calendars.writable(), out = [];
  for (var i = 0; i < names.length; i++) if (writable[i]) out.push(names[i]);
  return JSON.stringify(out);
}`;

export const SKIP_CALENDARS = /^(scheduled reminders|siri suggestions|birthdays)$|holiday/i;

/**
 * One calendar per osascript, run in parallel: a slow calendar times out alone
 * instead of sinking the whole read. Batched property reads: one Apple event per
 * property, not per event.
 */
export const FREE_BUSY_JXA = `
function run(argv) {
  var p = JSON.parse(argv[0]);
  var Cal = Application("Calendar");
  var s = new Date(p.start), e = new Date(p.end), out = [];
  var cals = Cal.calendars.whose({ name: p.calendar })();
  for (var i = 0; i < cals.length; i++) {
    var q = cals[i].events.whose({ _and: [{ startDate: { _lessThan: e } }, { endDate: { _greaterThan: s } }] });
    var t = q.summary(), st = q.startDate(), en = q.endDate(), ad = q.alldayEvent();
    for (var j = 0; j < t.length; j++) {
      if (ad[j]) continue;
      out.push({ title: t[j], start: st[j].getTime(), end: en[j].getTime(), calendar: p.calendar });
    }
  }
  return JSON.stringify(out);
}`;

/** "19:30", "7:30pm", "7pm" or an ISO/epoch string -> epoch ms (today, local time, for bare times). */
export function parseStart(v: unknown, now: number): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v !== "string" || !v.trim()) return null;
  const s = v.trim().toLowerCase();
  const m = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
  if (m) {
    let h = Number(m[1]);
    const min = Number(m[2] ?? 0);
    if (m[3] === "pm" && h < 12) h += 12;
    if (m[3] === "am" && h === 12) h = 0;
    if (h > 23 || min > 59) return null;
    const d = new Date(now);
    d.setHours(h, min, 0, 0);
    return d.getTime();
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** "7:30 PM" with a plain space (ICU emits U+202F, which TTS and regexes trip on). */
export function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");
}

export interface BusyBlock {
  title: string;
  start: number;
  end: number;
  calendar?: string;
}

/** First free slot of `needMin` minutes between `from` and `until`, starting on a :00 or :30. */
export function firstFreeSlot(busy: BusyBlock[], from: number, until: number, needMin = 90): number | null {
  const step = 30 * 60_000;
  let t = Math.ceil(from / step) * step;
  for (; t + needMin * 60_000 <= until; t += step) {
    const end = t + needMin * 60_000;
    if (!busy.some((b) => b.start < end && b.end > t)) return t;
  }
  return null;
}

export function eventArgs(args: Record<string, unknown>, now: number) {
  const title = String(args.title ?? args.summary ?? "Plans with Eve").slice(0, 200);
  const start = parseStart(args.start ?? args.startIso ?? args.time, now);
  const durationMin = Math.max(5, Math.min(24 * 60, Number(args.durationMin ?? args.duration ?? 90) || 90));
  return {
    title,
    start,
    end: start === null ? null : start + durationMin * 60_000,
    durationMin,
    location: String(args.location ?? "").slice(0, 300),
    notes: String(args.notes ?? "Planned by Eve (eigenwife)").slice(0, 2000),
    calendar: String(args.calendar ?? EVE_CALENDAR).slice(0, 100),
  };
}

function createEvent(kind: string): ActionDef {
  return {
    kind,
    permission: "EXTERNAL_SIDE_EFFECT",
    describe: (a) => {
      const e = eventArgs(a, Date.now());
      return `put "${e.title}" on your calendar${e.start ? ` at ${fmtTime(e.start)}` : ""}${e.location && e.location !== e.title ? ` at ${e.location}` : ""}`;
    },
    async run(args, env) {
      const e = eventArgs(args, env.deps.now());
      if (e.start === null || e.end === null) return { ok: false, observation: `couldn't read a start time from ${JSON.stringify(args.start ?? null)}` };
      env.progress?.("writing to Calendar...");
      const r = await runJxa<{ uid: string; calendar: string; fellBack: boolean }>(env.deps.osa, CREATE_EVENT_JXA, { ...e }, 60_000);
      if (!r.ok) return { ok: false, observation: `Calendar said no: ${r.error}` };
      return {
        ok: true,
        observation: `created "${e.title}" ${new Date(e.start).toDateString()} ${fmtTime(e.start)}-${fmtTime(e.end)} in ${r.value.calendar}${r.value.fellBack ? ` (no "${e.calendar}" calendar, used ${r.value.calendar})` : ""}`,
        data: { uid: r.value.uid, calendar: r.value.calendar, start: e.start, end: e.end, title: e.title },
      };
    },
  };
}

export const calendarCreateEvent = createEvent("calendar.create_event");
/** Harem's name for the same thing. Same class, same gate. */
export const calendarCreateAlias = createEvent("calendar.create");

export const calendarDeleteEvent: ActionDef = {
  kind: "calendar.delete_event",
  permission: "EXTERNAL_SIDE_EFFECT",
  describe: (a) => `delete a calendar event${a.title ? ` ("${String(a.title)}")` : ""}`,
  async run(args, env) {
    const uid = String(args.uid ?? "");
    if (!uid) return { ok: false, observation: "no uid" };
    const calendar = typeof args.calendar === "string" ? args.calendar : undefined;
    const r = await runJxa<{ deleted: number }>(env.deps.osa, DELETE_EVENT_JXA, { uid, calendar }, 60_000);
    if (!r.ok) return { ok: false, observation: `Calendar said no: ${r.error}` };
    return { ok: r.value.deleted > 0, observation: `deleted ${r.value.deleted} event(s)`, data: r.value };
  },
};

export const calendarFreeBusy: ActionDef = {
  kind: "calendar.free_busy",
  permission: "READ",
  describe: () => "look at your calendar for tonight",
  async run(args, env) {
    const now = env.deps.now();
    const day = new Date(now);
    const from = typeof args.from === "number" ? args.from : Math.max(now, new Date(day).setHours(17, 0, 0, 0));
    const until = typeof args.until === "number" ? args.until : new Date(day).setHours(23, 30, 0, 0);
    const needMin = Number(args.needMin ?? 90) || 90;
    const start = new Date(day).setHours(0, 0, 0, 0);

    const listed = await runJxa<string[]>(env.deps.osa, LIST_CALENDARS_JXA, {}, 20_000);
    if (!listed.ok) return { ok: false, observation: `couldn't read Calendar: ${listed.error}` };
    const only = env.deps
      .env("EIGEN_CALENDARS")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const names = listed.value.filter((n) => (only.length ? only.includes(n) : !SKIP_CALENDARS.test(n)));
    const perCal = Number(args.perCalendarTimeoutMs ?? 20_000) || 20_000;
    const reads = await Promise.all(
      names.map((calendar) => runJxa<BusyBlock[]>(env.deps.osa, FREE_BUSY_JXA, { start, end: until, calendar }, perCal).then((r) => ({ calendar, r }))),
    );
    const skipped = reads.filter((x) => !x.r.ok).map((x) => x.calendar);
    const busy = reads
      .flatMap((x) => (x.r.ok ? x.r.value : []))
      .filter((b) => b.end > from)
      .sort((a, b) => a.start - b.start);
    const slot = firstFreeSlot(busy, from, until, needMin);
    const busyText = busy.length ? busy.map((b) => `${b.title} ${fmtTime(b.start)}-${fmtTime(b.end)}`).join(", ") : "nothing";
    const main = slot ? `busy tonight: ${busyText}. free from ${fmtTime(slot)}` : `busy tonight: ${busyText}. no ${needMin}-minute gap left`;
    return {
      ok: true,
      observation: `${main}${skipped.length ? ` (didn't finish reading ${skipped.join(", ")})` : ""}`,
      data: { busy, freeFrom: slot, calendars: names, skipped },
    };
  },
};
