import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { EventBus } from "../src/bus";
import { loadConfig } from "../src/config";
import { createContext } from "../src/context";
import type { BrainService, SpeechService } from "../src/services";
import { createAgency } from "../src/agency/module";
import type { OsaRunner } from "../src/agency/osa";
import { effectivePermission } from "../src/agency/policy";
import { CURSOR_CLIENT, WINDOW_BOUNDS_JXA } from "../src/agency/cursor";
import { CONTACT_HANDLES_JXA, CONTACTS_FIND_JXA, bestHandle, chooseOption, handleKey, pickContact, scoreContactRows, whichQuestion, type ContactCandidate, type ContactHandle } from "../src/agency/contacts";
import { SEND_APPLESCRIPT, applyEdit, cleanText, draftMessage, fallbackDraft } from "../src/agency/actions/messages";
import { readDraftEdit, readMessageAsk, readWorkIntent } from "../src/work/intent";
import { createWork } from "../src/work/module";
import { readIntent } from "../src/reflex/intent";
import { localScore } from "../src/reflex/jev";

process.env.EIGEN_QUIET = "1";

// ---------------------------------------------------------------------------
// fakes: an address book behind a fake osascript, Messages that records sends
// ---------------------------------------------------------------------------

interface Person {
  id: string;
  name: string;
  first?: string;
  last?: string;
  nick?: string;
  handles: ContactHandle[];
}

const BOOK: Person[] = [
  { id: "p1", name: "Stephen Hung", first: "Stephen", last: "Hung", handles: [{ kind: "phone", value: "+1 (949) 555-0101", label: "_$!<Mobile>!$_" }] },
  { id: "p2", name: "Stephen Lee", first: "Stephen", last: "Lee", handles: [{ kind: "phone", value: "(714) 555-0102", label: "iPhone" }, { kind: "email", value: "slee@example.com" }] },
  { id: "p3", name: "Leo Park", first: "Leo", last: "Park", handles: [{ kind: "email", value: "leo@example.com", label: "home" }] },
  { id: "p4", name: "Mom", first: "Mom", handles: [{ kind: "phone", value: "+19495550104", label: "mobile" }] },
  { id: "p5", name: "Nora Numberless", first: "Nora", last: "Numberless", handles: [] },
  { id: "p6", name: "Jessica Alvarez", first: "Jessica", last: "Alvarez", nick: "jess", handles: [{ kind: "phone", value: "+1 949 555 0106" }] },
];

function fakeOsa(o: { book?: Person[]; imessageFails?: boolean; smsFails?: boolean; contactsDenied?: boolean } = {}) {
  const book = o.book ?? BOOK;
  const sends: string[][] = [];
  const scripts: string[] = [];
  const osa: OsaRunner = async (script, opts = {}) => {
    scripts.push(script);
    const args = opts.args ?? [];
    const ok = (stdout: string) => ({ ok: true, stdout, stderr: "", code: 0 });
    if (script === CONTACTS_FIND_JXA) {
      if (o.contactsDenied) return { ok: false, stdout: "", stderr: "execution error: Not authorized to send Apple events to Contacts. (-1743)", code: 1 };
      const q = JSON.parse(args[0]!);
      const hits = scoreContactRows(q.query, book, q.limit);
      return ok(JSON.stringify({ candidates: hits.map((h) => ({ id: book[h.i]!.id, name: book[h.i]!.name, score: h.score, exact: h.exact, strong: h.strong, handles: book[h.i]!.handles })) }));
    }
    if (script === CONTACT_HANDLES_JXA) {
      const p = book.find((b) => b.id === JSON.parse(args[0]!).id);
      return ok(JSON.stringify(p ? { found: true, name: p.name, handles: p.handles } : { found: false, handles: [] }));
    }
    if (script === SEND_APPLESCRIPT) {
      sends.push(args);
      const svc = args[3];
      if ((svc === "iMessage" && o.imessageFails) || (svc === "SMS" && o.smsFails)) return { ok: false, stdout: "", stderr: `execution error: Can't get account 1 whose service type = ${svc}. (-1728)`, code: 1 };
      return ok(args[4] === "1" ? `dry-run ${svc} ${args[1]}` : `sent ${svc}`);
    }
    if (script === WINDOW_BOUNDS_JXA) return ok(JSON.stringify({ window: { x: 900, y: 100, width: 500, height: 400 }, displays: [{ x: 0, y: 0, width: 1470, height: 956 }] }));
    return { ok: false, stdout: "", stderr: "unexpected script", code: 1 };
  };
  return { osa, sends, scripts };
}

function fakeSpeech() {
  const said: string[] = [];
  const speech: SpeechService = {
    async say(text) {
      let s = "";
      if (typeof text === "string") s = text;
      else for await (const c of text) s += c;
      said.push(s);
      return { utteranceId: `u${said.length}`, text: s };
    },
    stop() {},
    speaking: () => false,
  };
  return { speech, said };
}

/** A brain that drafts and edits like matt would, and records what it was asked. */
function fakeBrain(o: { down?: boolean } = {}) {
  const prompts: string[] = [];
  const brains: BrainService = {
    async *persona() {
      yield "ok?";
    },
    frontier: async () => ({ ok: false, text: "", engine: "none", ms: 0 }),
    async quickJson<T>(_system: string, user: string): Promise<T | null> {
      prompts.push(user);
      if (o.down) return null;
      if (user.includes("Pending action")) return null;
      if (user.includes("add this: i'm bringing snacks")) return { text: "yo u tryna eat tonight? i'm bringing snacks" } as T;
      if (user.includes("make it shorter")) return { text: "yo u eating?" } as T;
      if (user.includes("What matt wants to say")) return { text: "Yo u tryna eat tonight? \u2014 lmk" } as T;
      return null;
    },
    status: () => ({}),
  };
  return { brains, prompts };
}

interface RigOpts {
  answers?: (string | { key: string } | { approve: string })[];
  osa?: ReturnType<typeof fakeOsa>;
  brain?: ReturnType<typeof fakeBrain> | null;
  env?: Record<string, string>;
  timeoutMs?: number;
  watching?: boolean;
}

function rig(o: RigOpts = {}) {
  const bus = new EventBus();
  const ctx = createContext(bus, { ...loadConfig(), eveHome: mkdtempSync(join(tmpdir(), "eve-msg-")), demo: false });
  const events: AnyEnvelope[] = [];
  bus.on("*", (e) => void events.push(e));
  const { speech, said } = fakeSpeech();
  ctx.provide("speech", speech);
  const brain = o.brain === null ? null : (o.brain ?? fakeBrain());
  if (brain) ctx.provide("brains", brain.brains);
  const fx = o.osa ?? fakeOsa();
  const clock = { t: 1_000_000 };
  const env = (n: string) => o.env?.[n] ?? "";
  const agency = createAgency(ctx, {
    deps: { osa: fx.osa, env, now: () => clock.t, loadHarem: async () => null, fetch: async () => new Response("", { status: 503 }), openUrl: async () => true, sleep: async () => {} },
    approvalTimeoutMs: o.timeoutMs ?? 400,
  });
  ctx.provide("agency", agency.service);
  const work = createWork(ctx, { poll: false, deps: { osa: fx.osa, env, now: () => clock.t, idleSeconds: async () => 60, sleep: async () => {} } });
  ctx.provide("work", work.service);
  if (o.watching) bus.emit("bus.hello", { client: CURSOR_CLIENT, role: "observer", version: "1" }, "overlay");
  const answers = [...(o.answers ?? [])];
  const asked: string[] = [];
  bus.on("action.request", (e) => {
    if (!e.data.needsApproval || e.source !== "agency") return;
    asked.push(e.data.kind);
    const a = answers.shift();
    if (a === undefined) return;
    setTimeout(() => {
      if (typeof a === "string") bus.emit("voice.final", { text: a }, "ears");
      else if ("key" in a) bus.emit("shell.key", { key: a.key }, "shell");
      else bus.emit("action.approval", { actionId: e.data.actionId, approved: true, by: "key" }, a.approve);
    }, 5);
  });
  return { bus, ctx, events, said, agency, work, fx, asked, clock, brain, stop: () => (work.stop(), agency.stop()) };
}

const readbacks = (said: string[]) => said.filter((s) => s.endsWith("send it?"));

// ---------------------------------------------------------------------------
// intents
// ---------------------------------------------------------------------------

describe("messages intents", () => {
  test.each([
    ["hey can you text my friend stephen hung", { who: "stephen hung", dictated: false }],
    ["text stephen 'yo you up'", { who: "stephen", body: "yo you up", dictated: true }],
    ['text stephen "yo you up"', { who: "stephen", body: "yo you up", dictated: true }],
    ["text stephen hung saying yo you up", { who: "stephen hung", body: "yo you up", dictated: true }],
    ["text leo saying im outside", { who: "leo", body: "im outside", dictated: true }],
    ["imessage leo that i'm running 10 min late", { who: "leo", body: "that i'm running 10 min late", dictated: false }],
    ["i message leo: omw", { who: "leo", body: "omw", dictated: true }],
    ["message my mom that i'll be home by 8", { who: "mom", body: "that i'll be home by 8", dictated: false }],
    ["text stephen asking if he wants to get food", { who: "stephen", body: "asking if he wants to get food", dictated: false }],
    ["send a text to jess and tell her i'm outside", { who: "jess", body: "and tell her i'm outside", dictated: false }],
    ["text stephen 'you need to chill'", { who: "stephen", body: "you need to chill", dictated: true }],
    ["can you text stephen hung for me", { who: "stephen hung", dictated: false }],
  ])("%p", (text, want) => {
    const ask = readWorkIntent(text);
    expect(ask?.kind).toBe("messages.send");
    expect(ask).toMatchObject(want);
    if (!("body" in want)) expect((ask as { body?: string }).body).toBeUndefined();
  });

  test.each(["text me when it's done", "text him back", "message leo on discord saying hi", "text size is too small in the header component", "how's it going", "email leo saying friday works", "remind me to text stephen"])("%p is not a Messages text", (text) => {
    expect(readMessageAsk(text.replace(/^remind me to /, "zz "))).toBeNull();
    expect(readWorkIntent(text)?.kind).not.toBe("messages.send");
  });

  test("email still goes to jabby", () => {
    expect(readWorkIntent("email leo saying friday works")).toMatchObject({ kind: "jabby", mode: "send" });
  });

  test.each([
    ["make it shorter", { kind: "rewrite" }],
    ["ok make it shorter", { kind: "rewrite" }],
    ["make it more casual", { kind: "rewrite" }],
    ["add that i'm bringing snacks", { kind: "append", text: "i'm bringing snacks" }],
    ["yeah add that i'm bringing snacks", { kind: "append", text: "i'm bringing snacks" }],
    ["also say i'll be there at 8", { kind: "append", text: "i'll be there at 8" }],
    ["say 'yo you up' instead", { kind: "replace", text: "yo you up" }],
    ["change it to on my way", { kind: "replace", text: "on my way" }],
    ["take out the lmk", { kind: "rewrite" }],
    ["don't mention dinner", { kind: "rewrite" }],
  ])("edit %p", (text, want) => {
    expect(readDraftEdit(text)).toMatchObject(want);
  });

  test.each(["yeah", "send it", "yeah send it", "nah", "do it", "what time is it"])("%p is not an edit", (text) => {
    expect(readDraftEdit(text)).toBeNull();
  });

  test("reflex: an edit while she waits on 'send it?' is hers to handle, not chat", () => {
    const world = rig().ctx.world();
    const base = { world, relationship: { banter: 0.6, warmth: 0.5, initiative: 0.5, verbosity: 0.3, confidence: 0.5 }, now: 0 };
    const t = (text: string) => ({ id: "u1", rule: "utterance", description: text, urgency: "immediate" as const, data: { text }, at: 0, ambient: false });
    expect(readIntent("make it shorter").approval).toBe(true);
    expect(localScore({ ...base, trigger: t("add that i'm bringing snacks"), pendingApproval: true }).decision).toBe("IGNORE");
    expect(readIntent("text my friend stephen hung").work).toBe(true);
    expect(localScore({ ...base, trigger: t("text my friend stephen hung") }).decision).toBe("ESCALATE");
  });
});

// ---------------------------------------------------------------------------
// contacts
// ---------------------------------------------------------------------------

const lookup = (q: string): ContactCandidate[] => scoreContactRows(q, BOOK, 6).map((h) => ({ id: BOOK[h.i]!.id, name: BOOK[h.i]!.name, score: h.score, exact: h.exact, strong: h.strong, handles: BOOK[h.i]!.handles }));

describe("contacts matching", () => {
  test("one, many, none", () => {
    expect(pickContact(lookup("stephen hung"))).toMatchObject({ kind: "one", contact: { id: "p1" } });
    expect(pickContact(lookup("stephen"))).toMatchObject({ kind: "many" });
    expect(pickContact(lookup("zelda"))).toEqual({ kind: "none" });
    expect(pickContact(lookup("nora"))).toMatchObject({ kind: "no_handle" });
  });

  test("fuzzy: sound-alikes, prefixes, nicknames, 'my mom'", () => {
    expect(pickContact(lookup("steven hung"))).toMatchObject({ kind: "one", contact: { id: "p1" } });
    expect(pickContact(lookup("steph lee"))).toMatchObject({ kind: "one", contact: { id: "p2" } });
    expect(pickContact(lookup("jess"))).toMatchObject({ kind: "one", contact: { id: "p6" } });
    expect(pickContact(lookup("jessica"))).toMatchObject({ kind: "one", contact: { id: "p6" } });
    expect(pickContact(lookup("mom"))).toMatchObject({ kind: "one", contact: { id: "p4" } });
    expect(lookup("")).toEqual([]);
  });

  test("an exact full name beats a longer one", () => {
    const book: Person[] = [
      { id: "a", name: "Stephen Hung", first: "Stephen", last: "Hung", handles: [{ kind: "phone", value: "9495550001" }] },
      { id: "b", name: "Stephen Hungerford", first: "Stephen", last: "Hungerford", handles: [{ kind: "phone", value: "9495550002" }] },
    ];
    const c = scoreContactRows("stephen hung", book, 6).map((h) => ({ id: book[h.i]!.id, name: book[h.i]!.name, score: h.score, exact: h.exact, strong: h.strong, handles: book[h.i]!.handles }));
    expect(pickContact(c)).toMatchObject({ kind: "one", contact: { id: "a" } });
  });

  test("the question and the answer", () => {
    const opts = (pickContact(lookup("stephen")) as { options: ContactCandidate[] }).options;
    expect(whichQuestion(opts)).toBe("stephen hung or stephen lee?");
    expect(chooseOption("stephen lee", opts)?.id).toBe("p2");
    expect(chooseOption("lee", opts)?.id).toBe("p2");
    expect(chooseOption("the first one", opts)?.id).toBe("p1");
    expect(chooseOption("hung", opts)?.id).toBe("p1");
    expect(chooseOption("the one ending 0102", opts)?.id).toBe("p2");
    expect(chooseOption("uhh", opts)).toBeNull();
  });

  test("same name twice: she tells them apart by the last digits", () => {
    const twins: ContactCandidate[] = [
      { id: "x", name: "Chris Kim", score: 8, exact: true, handles: [{ kind: "phone", value: "+1 949 555 1111" }] },
      { id: "y", name: "Chris Kim", score: 8, exact: true, handles: [{ kind: "phone", value: "+1 949 555 2222" }] },
    ];
    expect(pickContact(twins).kind).toBe("many");
    expect(whichQuestion(twins)).toBe("chris kim (ending 1111) or chris kim (ending 2222)?");
    // Two cards, same person, same number: counts once.
    expect(pickContact([twins[0]!, { ...twins[0]!, id: "z" }]).kind).toBe("one");
  });

  test("handles: mobile first, then any phone, then email; keys ignore formatting", () => {
    expect(bestHandle(BOOK[1]!)?.value).toBe("(714) 555-0102");
    expect(bestHandle(BOOK[2]!)?.value).toBe("leo@example.com");
    expect(handleKey("+1 (949) 555-0101")).toBe(handleKey("9495550101"));
    expect(handleKey("Leo@Example.com")).toBe("leo@example.com");
  });

  test("the address book is matched inside osascript: only candidates come back", () => {
    expect(CONTACTS_FIND_JXA).toContain("function scoreContactRows(");
    expect(CONTACTS_FIND_JXA).toContain("people.name()");
    // phones/emails are read per hit, never in bulk for everyone
    expect(CONTACTS_FIND_JXA).not.toMatch(/people\.phones|people\.emails/);
    expect(CONTACTS_FIND_JXA).toMatch(/var p = people\[hits\[k\]\.i\]/);
  });
});

// ---------------------------------------------------------------------------
// drafting
// ---------------------------------------------------------------------------

describe("drafting in his voice", () => {
  test("dictated words stay his words (lowercased, no em dashes)", async () => {
    expect(await draftMessage(null, "Stephen Hung", "Yo you up", true)).toBe("yo you up");
    expect(cleanText("omw \u2014 5 min")).toBe("omw, 5 min");
  });

  test("described texts go through the brain, cleaned", async () => {
    const b = fakeBrain();
    expect(await draftMessage(b.brains, "Stephen Hung", "asking if he wants to eat tonight", false)).toBe("yo u tryna eat tonight?, lmk");
    expect(b.prompts[0]).toContain("asking if he wants to eat tonight");
  });

  test("no brain: plain fallback", () => {
    expect(fallbackDraft("that i'm running 10 min late")).toBe("i'm running 10 min late");
    expect(fallbackDraft("asking if he wants to get food")).toBe("you wanna get food?");
    expect(fallbackDraft("and tell her she's the goat")).toBe("you're the goat");
    expect(fallbackDraft("to bring snacks")).toBe("can you bring snacks?");
  });

  test("edits: replace verbatim, append and rewrite with or without a brain", async () => {
    const b = fakeBrain();
    expect(await applyEdit(b.brains, "s", "yo u tryna eat tonight?", { kind: "replace", text: "On my way" })).toEqual({ text: "on my way", changed: true });
    expect((await applyEdit(b.brains, "s", "yo u tryna eat tonight?", { kind: "append", text: "i'm bringing snacks" })).text).toBe("yo u tryna eat tonight? i'm bringing snacks");
    expect((await applyEdit(null, "s", "yo u tryna eat tonight", { kind: "append", text: "i'm bringing snacks" })).text).toBe("yo u tryna eat tonight, i'm bringing snacks");
    expect(await applyEdit(null, "s", "yo you up, wanna get food", { kind: "rewrite", instruction: "make it shorter" })).toEqual({ text: "yo you up", changed: true });
    expect((await applyEdit(null, "s", "yo", { kind: "rewrite", instruction: "make it funnier" })).changed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the whole conversation through the work service + gate
// ---------------------------------------------------------------------------

describe("messages.send through the gate", () => {
  test("classes: lookups are READ, sends are SENSITIVE and voice-only", () => {
    const r = rig();
    const perm = (k: string) => effectivePermission(r.agency.gate.registry.get(k)!);
    expect(perm("contacts.find")).toBe("READ");
    expect(perm("messages.send")).toBe("SENSITIVE_ACTION");
    expect(r.agency.gate.registry.get("messages.send")!.voiceOnly).toBe(true);
    r.stop();
  });

  test("one match, dictated: reads back recipient + exact words, 'yeah' sends exactly that", async () => {
    const r = rig({ answers: ["yeah"] });
    const res = await r.work.service.handle("text stephen hung saying yo you up");
    expect(res).toEqual({ ok: true, summary: "sent." });
    expect(readbacks(r.said)).toEqual(['text to stephen hung: "yo you up". send it?']);
    expect(r.fx.sends).toEqual([["eve", "+1 (949) 555-0101", "yo you up", "iMessage", "0"]]);
    const result = r.events.find((e) => e.type === "action.result" && (e.data as { observation: string }).observation.startsWith("sent to"));
    expect((result!.data as { observation: string }).observation).toBe("sent to stephen hung via iMessage");
    // Trace: lookup (auto) then the send (spoken yes).
    const trace = r.agency.gate.trace.map((t) => [t.kind, t.decision?.by, t.result?.ok]);
    expect(trace).toEqual([
      ["contacts.find", "policy", true],
      ["messages.send", "voice", true],
    ]);
    r.stop();
  });

  test("several matches: she asks which, the spoken answer picks, then the usual read-back", async () => {
    const r = rig({ answers: ["yep"] });
    const q = await r.work.service.handle("text stephen saying you up?");
    expect(q).toEqual({ ok: true, summary: "stephen hung or stephen lee?" });
    expect(r.work.service.awaiting()).toBe(true);
    expect(r.work.service.claims("stephen lee")).toBe(true);
    expect(r.fx.sends).toHaveLength(0);
    const res = await r.work.service.handle("stephen lee");
    expect(res.summary).toBe("sent.");
    expect(readbacks(r.said)).toEqual(['text to stephen lee: "you up". send it?']);
    expect(r.fx.sends[0]!.slice(1, 3)).toEqual(["(714) 555-0102", "you up"]);
    expect(r.work.service.awaiting()).toBe(false);
    r.stop();
  });

  test("an unclear answer gets one re-ask, 'never mind' drops it", async () => {
    const r = rig();
    await r.work.service.handle("text stephen saying yo");
    expect((await r.work.service.handle("uhh the tall one")).summary).toBe("which one? stephen hung or stephen lee?");
    expect((await r.work.service.handle("never mind")).summary).toBe("okay, never mind.");
    expect(r.fx.sends).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
    r.stop();
  });

  test("nobody by that name: she says so and never guesses a number", async () => {
    const r = rig();
    const res = await r.work.service.handle("text zelda saying hi");
    expect(res).toEqual({ ok: false, summary: "i can't find zelda in your contacts." });
    expect(r.fx.sends).toHaveLength(0);
    expect(r.asked).toHaveLength(0);
    const nora = await r.work.service.handle("text nora saying hi");
    expect(nora.summary).toContain("no number or email");
    r.stop();
  });

  test("no message yet: 'what do you wanna say', the next thing he says is the text", async () => {
    const r = rig({ answers: ["yeah"] });
    const q = await r.work.service.handle("hey can you text my friend stephen hung");
    expect(q.summary).toBe("what do you wanna say to stephen?");
    const res = await r.work.service.handle("yo you up");
    expect(res.summary).toBe("sent.");
    expect(readbacks(r.said)).toEqual(['text to stephen hung: "yo you up". send it?']);
    r.stop();
  });

  test("described texts get drafted in his voice before the read-back", async () => {
    const r = rig({ answers: ["yeah"] });
    await r.work.service.handle("text stephen hung asking if he wants to eat tonight");
    expect(readbacks(r.said)).toEqual(['text to stephen hung: "yo u tryna eat tonight?, lmk". send it?']);
    expect(r.fx.sends[0]![2]).toBe("yo u tryna eat tonight?, lmk");
    r.stop();
  });

  test("edit loop: 'add that...' re-drafts and asks again; only the final words get sent", async () => {
    const r = rig({ answers: ["yeah add that i'm bringing snacks", "yeah send it"] });
    const res = await r.work.service.handle("text stephen hung asking if he wants to eat tonight");
    expect(res.summary).toBe("sent.");
    expect(readbacks(r.said)).toEqual(['text to stephen hung: "yo u tryna eat tonight?, lmk". send it?', `text to stephen hung: "yo u tryna eat tonight? i'm bringing snacks". send it?`]);
    // "yeah add that..." contains a yes-word but is an edit: the first draft was never sent.
    expect(r.fx.sends.map((s) => s[2])).toEqual(["yo u tryna eat tonight? i'm bringing snacks"]);
    const decisions = r.agency.gate.trace.filter((t) => t.kind === "messages.send").map((t) => t.decision?.approved);
    expect(decisions).toEqual([false, true]);
    r.stop();
  });

  test("edit loop: 'ok make it shorter' then 'nah' sends nothing", async () => {
    const r = rig({ answers: ["ok make it shorter", "nah"] });
    const res = await r.work.service.handle("text stephen hung asking if he wants to eat tonight");
    expect(res.summary).toBe("okay, not sending it.");
    expect(readbacks(r.said)[1]).toBe('text to stephen hung: "yo u eating?". send it?');
    expect(r.fx.sends).toHaveLength(0);
    r.stop();
  });

  test("'say X instead' swaps in his exact words", async () => {
    const r = rig({ answers: ["say 'on my way' instead", "yes"] });
    await r.work.service.handle("text leo saying running late");
    expect(r.fx.sends.map((s) => s[2])).toEqual(["on my way"]);
    r.stop();
  });

  test("approval required: no answer = no send, a no = no send", async () => {
    const silent = rig({ timeoutMs: 150 });
    const res = await silent.work.service.handle("text stephen hung saying yo");
    expect(res.summary).toBe("okay, not sending it.");
    expect(silent.fx.sends).toHaveLength(0);
    const no = rig({ answers: ["nah"] });
    expect((await no.work.service.handle("text stephen hung saying yo")).summary).toBe("okay, not sending it.");
    expect(no.fx.sends).toHaveLength(0);
    silent.stop();
    no.stop();
  });

  test("voice only: Enter and other modules' yes can't send a text (they can still say no)", async () => {
    const key = rig({ answers: [{ key: "Enter" }], timeoutMs: 200 });
    expect((await key.work.service.handle("text stephen hung saying yo")).summary).toBe("okay, not sending it.");
    expect(key.fx.sends).toHaveLength(0);
    const btn = rig({ answers: [{ approve: "shell" }], timeoutMs: 200 });
    expect((await btn.work.service.handle("text stephen hung saying yo")).summary).toBe("okay, not sending it.");
    expect(btn.fx.sends).toHaveLength(0);
    const esc = rig({ answers: [{ key: "Escape" }], timeoutMs: 5000 });
    expect((await esc.work.service.handle("text stephen hung saying yo")).summary).toBe("okay, not sending it.");
    expect(esc.agency.gate.trace.find((t) => t.kind === "messages.send")!.decision).toMatchObject({ approved: false, by: "key" });
    key.stop();
    btn.stop();
    esc.stop();
  });

  test("injection-safe: the script is a constant, his words only ever travel as argv", async () => {
    const evil = `x" & (do shell script "rm -rf ~") & "\nend tell\n-e boom \\ "quoted"`;
    const r = rig({ answers: ["yeah"] });
    const res = await r.agency.service.act("messages.send", { name: "Stephen Hung", contactId: "p1", handle: "+1 (949) 555-0101", text: evil });
    expect(res.ok).toBe(true);
    const sendScripts = r.fx.scripts.filter((s) => s === SEND_APPLESCRIPT);
    expect(sendScripts).toHaveLength(1);
    expect(SEND_APPLESCRIPT).not.toContain("rm -rf");
    expect(r.fx.sends[0]).toEqual(["eve", "+1 (949) 555-0101", evil, "iMessage", "0"]);
    // argv[1] is a fixed sentinel, so a text starting with "-" is never an osascript flag.
    expect(SEND_APPLESCRIPT).toContain("set theHandle to item 2 of argv");
    expect(SEND_APPLESCRIPT).toContain("set theText to item 3 of argv");
    expect(SEND_APPLESCRIPT).toMatch(/if dryRun is "1" then return[^\n]*\n\t\tsend theText to theTarget/);
    r.stop();
  });

  test("never raw numbers: the handle must be on that contact card, and a card id is required", async () => {
    const r = rig({ answers: ["yeah"] });
    const spoof = await r.agency.service.act("messages.send", { name: "Stephen Hung", contactId: "p1", handle: "+1 555 000 9999", text: "hi" });
    expect(spoof.ok).toBe(false);
    expect(spoof.observation).toContain("isn't on their contact card");
    const raw = await r.agency.service.act("messages.send", { name: "someone", handle: "+15550009999", text: "hi" });
    expect(raw.observation).toContain("only text people who are in your contacts");
    expect(readbacks(r.said)).toHaveLength(1); // the raw one was refused before she asked
    expect(r.fx.sends).toHaveLength(0);
    r.stop();
  });

  test("rate limit: 5 texts per 10 minutes, refused before she even asks", async () => {
    const r = rig({ answers: ["yeah", "yeah", "yeah", "yeah", "yeah", "yeah"] });
    const send = () => r.agency.service.act("messages.send", { name: "Mom", contactId: "p4", handle: "+19495550104", text: "hi mom" });
    for (let i = 0; i < 5; i++) expect((await send()).ok).toBe(true);
    const sixth = await send();
    expect(sixth.ok).toBe(false);
    expect(sixth.observation).toContain("slow down");
    expect(readbacks(r.said)).toHaveLength(5);
    r.clock.t += 10 * 60_000 + 1;
    expect((await send()).ok).toBe(true);
    expect(r.fx.sends).toHaveLength(6);
    r.stop();
  });

  test("SMS fallback when iMessage isn't there for a number; email handles don't fall back", async () => {
    const r = rig({ answers: ["yeah", "yeah"], osa: fakeOsa({ imessageFails: true }) });
    const res = await r.work.service.handle("text mom saying home by 8");
    expect(res.summary).toBe("sent.");
    expect(r.fx.sends.map((s) => s[3])).toEqual(["iMessage", "SMS"]);
    expect(r.events.some((e) => e.type === "action.result" && (e.data as { observation: string }).observation === "sent to mom via SMS")).toBe(true);
    const leo = await r.work.service.handle("text leo saying yo");
    expect(leo.ok).toBe(false);
    expect(leo.summary).toBe("didn't send: Messages isn't signed in to iMessage or SMS");
    expect(r.fx.sends).toHaveLength(3);
    r.stop();
  });

  test("failures are honest: Contacts permission, Messages errors", async () => {
    const r = rig({ osa: fakeOsa({ contactsDenied: true }) });
    const res = await r.work.service.handle("text stephen hung saying yo");
    expect(res.ok).toBe(false);
    expect(res.summary).toContain("not allowed into Contacts");
    const both = rig({ answers: ["yeah"], osa: fakeOsa({ imessageFails: true, smsFails: true }) });
    const out = await both.work.service.handle("text mom saying yo");
    expect(out.ok).toBe(false);
    expect(out.summary).toStartWith("didn't send:");
    r.stop();
    both.stop();
  });

  test("dry run: resolves the service + participant, never calls send", async () => {
    const r = rig({ answers: ["yeah"], env: { EVE_MESSAGES_DRY_RUN: "1" } });
    const res = await r.work.service.handle("text stephen hung saying yo");
    expect(res.summary).toBe("dry run, didn't actually send it. dry run: would text stephen hung via iMessage.");
    expect(r.fx.sends[0]![4]).toBe("1");
    r.stop();
  });

  test("her cursor glides to Messages (bounds only) before the send when someone's watching", async () => {
    const r = rig({ answers: ["yeah"], watching: true });
    await r.work.service.handle("text stephen hung saying yo");
    const cursor = r.events.filter((e) => e.type === "agent.cursor").map((e) => (e.data as { action: string; target?: string }).action);
    expect(cursor).toContain("move");
    expect(cursor).toContain("click");
    expect(r.events.filter((e) => e.type === "agent.cursor").every((e) => (e.data as { target?: string }).target === "Messages" || (e.data as { action: string }).action === "idle")).toBe(true);
    // glide happens after the yes and before the AppleScript send
    const iClick = r.fx.scripts.indexOf(WINDOW_BOUNDS_JXA);
    const iSend = r.fx.scripts.indexOf(SEND_APPLESCRIPT);
    expect(iClick).toBeGreaterThan(-1);
    expect(iClick).toBeLessThan(iSend);
    r.stop();
  });
});
