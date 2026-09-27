import { newId } from "@eigenwife/protocol";
import type { CoreContext } from "../../context";
import type { BrainService } from "../../services";
import { classifyApproval } from "../approval";
import { bestHandle, chooseOption, contactHandles, findContacts, handleKey, pickContact, whichQuestion, type ContactCandidate, type ContactHandle } from "../contacts";
import type { OsaRunner } from "../osa";
import type { ActionDef, ActionOutcome } from "../types";
import { readDraftEdit, type DraftEdit, type WorkAsk } from "../../work/intent";

/**
 * Texting people from matt's own Messages app (docs/MESSAGES.md).
 *
 *   contacts.find   READ              who "stephen hung" is in Contacts (candidates only)
 *   messages.send   SENSITIVE_ACTION  one iMessage (or SMS) with the exact text she read back,
 *                                     only after a SPOKEN yes (keys and buttons can't approve it)
 *
 * The conversation around it (which stephen?, what should it say?, drafting in
 * his voice, "make it shorter" before he says yes) is createMessagesFlow below;
 * the work module routes "text <person> ..." asks and answers into it.
 */

/**
 * Constant AppleScript. User data only arrives as argv: item 1 is a fixed
 * sentinel (so a text starting with "-" is never read as an osascript flag),
 * then handle, text, service ("iMessage" | "SMS"), dry run ("1" | "0").
 */
export const SEND_APPLESCRIPT = `on run argv
	set theHandle to item 2 of argv
	set theText to item 3 of argv
	set wantType to item 4 of argv
	set dryRun to item 5 of argv
	tell application "Messages"
		if wantType is "SMS" then
			set theAccount to first account whose service type is SMS and enabled is true
		else
			set theAccount to first account whose service type is iMessage and enabled is true
		end if
		set theTarget to participant theHandle of theAccount
		if dryRun is "1" then return "dry-run " & wantType & " " & (handle of theTarget)
		send theText to theTarget
	end tell
	return "sent " & wantType
end run`;

export interface MessagesActionOpts {
  now?: () => number;
  /** Sends allowed per window (default 5, EVE_MESSAGES_MAX). */
  max?: number;
  /** Window in ms (default 10 min, EVE_MESSAGES_WINDOW_MS). */
  windowMs?: number;
}

const MAX_TEXT = 1000;

export function cleanText(s: string): string {
  return String(s ?? "")
    .replace(/[—–]/g, ", ")
    .replace(/\s+,/g, ",")
    .replace(/[ \t]+/g, " ")
    .trim();
}

async function runSend(osa: OsaRunner, handle: string, text: string, service: "iMessage" | "SMS", dry: boolean) {
  return osa(SEND_APPLESCRIPT, { args: ["eve", handle, text, service, dry ? "1" : "0"], timeoutMs: 25_000 });
}

function osaError(stderr: string, code: number): string {
  if (/-1743|not authori[sz]ed|not allowed to send apple events/i.test(stderr)) return "i'm not allowed to control Messages yet (System Settings > Privacy & Security > Automation)";
  if (/account|-1728|can.t get/i.test(stderr)) return "Messages isn't signed in to iMessage or SMS";
  return (stderr || `osascript exited ${code}`).slice(0, 200);
}

/** Build the two actions. Rate-limit state lives in this closure (one per agency). */
export function messagesActions(o: MessagesActionOpts = {}): ActionDef[] {
  const sentAt: number[] = [];
  const now = () => (o.now ?? Date.now)();
  const limits = (env?: (n: string) => string) => ({
    max: o.max ?? (Number(env?.("EVE_MESSAGES_MAX")) || 5),
    windowMs: o.windowMs ?? (Number(env?.("EVE_MESSAGES_WINDOW_MS")) || 10 * 60_000),
  });
  let lastEnv: ((n: string) => string) | undefined;
  const overLimit = (): string | null => {
    const { max, windowMs } = limits(lastEnv);
    const t = now();
    while (sentAt.length && t - sentAt[0]! > windowMs) sentAt.shift();
    return sentAt.length >= max ? `slow down: that's ${sentAt.length} texts in the last ${Math.round(windowMs / 60_000)} minutes` : null;
  };

  const contactsFind: ActionDef = {
    kind: "contacts.find",
    permission: "READ",
    describe: (a) => `look up ${String(a.query ?? "someone")} in your contacts`,
    targets: () => ["Contacts"],
    async run(args, env) {
      lastEnv = env.deps.env;
      const query = String(args.query ?? "").trim();
      if (!query) return { ok: false, observation: "look up who?" };
      const r = await findContacts(env.deps.osa, query);
      if (!r.ok) return { ok: false, observation: r.error };
      const names = r.candidates.map((c) => c.name.toLowerCase());
      return { ok: true, observation: names.length ? `${names.length} match${names.length === 1 ? "" : "es"}: ${names.join(", ")}` : `no one called ${query}`, data: r.candidates };
    },
  };

  const messagesSend: ActionDef = {
    kind: "messages.send",
    permission: "SENSITIVE_ACTION",
    voiceOnly: true,
    describe: (a) => `text ${String(a.name ?? "someone")}: "${String(a.text ?? "")}"`,
    // Read back the recipient and the exact words. The yes covers these and nothing else.
    confirmLine: (a) => `text to ${String(a.name ?? "them").toLowerCase()}: "${String(a.text ?? "")}". send it?`,
    targets: () => ["Messages"],
    cursorApp: () => "Messages",
    refuse: (a) => {
      const text = String(a.text ?? "").trim();
      if (!text) return "nothing to send";
      if (text.length > MAX_TEXT) return `that's too long for a text (${text.length} characters)`;
      if (!String(a.contactId ?? "").trim() || !String(a.handle ?? "").trim()) return "i only text people who are in your contacts";
      return overLimit();
    },
    async run(args, env) {
      lastEnv = env.deps.env;
      const text = String(args.text);
      const handle = String(args.handle);
      const limited = overLimit();
      if (limited) return { ok: false, observation: limited };
      // Never a raw number: the handle has to be on that Contacts card right now.
      const card = await contactHandles(env.deps.osa, String(args.contactId));
      if (!card.ok) return { ok: false, observation: card.error };
      if (!card.found || !card.handles.some((h) => handleKey(h.value) === handleKey(handle)))
        return { ok: false, observation: "that number isn't on their contact card, so i'm not sending it" };
      const dry = env.deps.env("EVE_MESSAGES_DRY_RUN") === "1" || args.dryRun === true;
      sentAt.push(now());
      const isPhone = !handle.includes("@");
      let r = await runSend(env.deps.osa, handle, text, "iMessage", dry);
      let via: "iMessage" | "SMS" = "iMessage";
      // iMessage isn't available for this number (or at all): try the phone's SMS relay.
      if (!r.ok && isPhone) {
        const sms = await runSend(env.deps.osa, handle, text, "SMS", dry);
        if (sms.ok) [r, via] = [sms, "SMS"];
      }
      if (!r.ok) {
        sentAt.pop();
        return { ok: false, observation: osaError(r.stderr, r.code) };
      }
      const name = String(args.name ?? "them").toLowerCase();
      if (dry) return { ok: true, observation: `dry run: would text ${name} via ${via}`, data: { dryRun: true, via } };
      return { ok: true, observation: `sent to ${name} via ${via}`, data: { via } };
    },
  };

  return [contactsFind, messagesSend];
}

// ---------------------------------------------------------------------------
// drafting in matt's voice
// ---------------------------------------------------------------------------

const VOICE =
  'You write one text message FROM matt TO a friend, in matt\'s own voice: all lowercase, casual, short, slangy like his real texts ("yo you up", "omw", "lemme know", "u tryna eat"). No emojis unless he asked, no em dashes, no hashtags, no sign-off, never "Hey [name]!". Never add plans, times or facts he did not say. Reply with JSON {"text": "..."}.';

function pronounsToYou(s: string): string {
  return s
    .replace(/\b(?:he|she|they)'re\b/gi, "you're")
    .replace(/\b(?:he|she|they) (?:is|are)\b/gi, "you are")
    .replace(/\b(?:he|she|they) (?:was|were)\b/gi, "you were")
    .replace(/\b(?:he|she|they)'s\b/gi, "you're")
    .replace(/\b(?:he|she|they) (?:wants|want)\b/gi, "you want")
    .replace(/\b(?:he|she|they) (?:has|have)\b/gi, "you have")
    .replace(/\b(?:he|she|they)\b/gi, "you")
    .replace(/\b(?:his|their)\b/gi, "your")
    .replace(/\b(?:him|them)\b/gi, "you");
}

/** No brain: turn "that i'm running late" / "asking if he wants food" into a plain text. */
export function fallbackDraft(instruction: string): string {
  let s = instruction.trim().toLowerCase().replace(/[.!]+$/, "");
  const ask = /^(?:asking|and ask|ask|to ask (?:him|her|them))\s+(?:(?:him|her|them)\s+)?(?:if|whether)\s+(.+)$/.exec(s) ?? /^(?:if|whether)\s+(.+)$/.exec(s);
  if (ask) {
    const q = pronounsToYou(ask[1]!).replace(/^you want to\b/, "you wanna").replace(/^you are\b/, "you're");
    return cleanText(`${q}?`);
  }
  s = s
    .replace(/^(?:that|(?:and )?(?:tell|let) (?:him|her|them)(?: know)?(?: that)?|telling (?:him|her|them)(?: that)?|to tell (?:him|her|them)(?: that)?|(?:letting|to let) (?:him|her|them) know(?: that)?)\s+/, "")
    .replace(/^(?:asking|and ask|to ask (?:him|her|them))\s+(?:(?:him|her|them)\s+)?(?:to\s+)?/, "can you ")
    .replace(/^to\s+/, "can you ")
    .replace(/^about\s+/, "yo about ");
  s = pronounsToYou(s);
  return cleanText(s.startsWith("can you ") ? `${s}?` : s);
}

function validDraft(v: unknown): string | null {
  const t = cleanText(String((v as { text?: unknown } | null)?.text ?? ""));
  return t && t.length <= MAX_TEXT ? t : null;
}

export async function draftMessage(brains: BrainService | null, to: string, body: string, dictated: boolean): Promise<string> {
  if (dictated) return cleanText(body.toLowerCase());
  if (brains) {
    try {
      const r = await brains.quickJson<{ text?: string }>(VOICE, `To: ${to}\nWhat matt wants to say: ${body}`, { timeoutMs: 6000 });
      const t = validDraft(r);
      if (t) return t.toLowerCase();
    } catch {}
  }
  return fallbackDraft(body);
}

export async function applyEdit(brains: BrainService | null, to: string, draft: string, edit: DraftEdit): Promise<{ text: string; changed: boolean }> {
  if (edit.kind === "replace") return { text: cleanText(edit.text.toLowerCase()), changed: true };
  if (brains) {
    try {
      const how = edit.kind === "append" ? `add this: ${edit.text}` : edit.instruction;
      const r = await brains.quickJson<{ text?: string }>(VOICE, `To: ${to}\nCurrent draft: ${draft}\nmatt's change: ${how}\nReturn the whole revised text.`, { timeoutMs: 6000 });
      const t = validDraft(r);
      if (t) return { text: t.toLowerCase(), changed: t.toLowerCase() !== draft };
    } catch {}
  }
  if (edit.kind === "append") {
    const add = fallbackDraft(edit.text.replace(/^that\s+/i, ""));
    return { text: cleanText(`${draft.replace(/[.!]+$/, "")}, ${add}`), changed: true };
  }
  if (/\bshort(?:er)?\b|\bshorten\b/i.test(edit.instruction)) {
    const first = draft.split(/(?<=[.!?])\s+|,\s+/)[0]!;
    if (first && first !== draft) return { text: cleanText(first), changed: true };
  }
  return { text: draft, changed: false };
}

// ---------------------------------------------------------------------------
// the conversation: who, what, read back, edits, send
// ---------------------------------------------------------------------------

type MessageAsk = WorkAsk & { kind: "messages.send" };
type Pending =
  | { stage: "which"; options: ContactCandidate[]; ask: MessageAsk; until: number; retried: boolean }
  | { stage: "body"; contact: ContactCandidate; handle: ContactHandle; until: number };

export interface MessagesFlow {
  /** She asked "which stephen?" or "what should it say?" and is waiting. */
  awaiting(): boolean;
  /** The answer to that question. */
  answer(text: string, parent?: string): Promise<{ ok: boolean; summary: string }>;
  /** A fresh "text <person> ..." ask. */
  start(ask: MessageAsk, parent?: string): Promise<{ ok: boolean; summary: string }>;
}

const SRC = "messages";
const CANCEL = /^(?:nah|no|nope|never\s*mind|nvm|cancel|forget\s+it|don'?t|stop|skip\s+it|actually\s+no)\b/i;
/** Answers that describe the text rather than dictate it: "tell him i'm late", "ask if he's coming". */
const DESCRIBES = /^(?:tell|ask|let)\s+(?:him|her|them)\b|^(?:that|asking|ask\s+if|ask\s+whether|if|whether|about)\b/i;

export function createMessagesFlow(ctx: CoreContext, o: { now?: () => number; maxEdits?: number } = {}): MessagesFlow {
  const now = () => (o.now ?? Date.now)();
  let pending: Pending | null = null;

  const awaiting = () => {
    if (pending && now() > pending.until) pending = null;
    return !!pending;
  };

  const agency = () => {
    const a = ctx.tryUse("agency");
    if (!a) throw new Error("my hands aren't hooked up (no agency)");
    return a;
  };

  async function resolve(ask: MessageAsk, parent?: string): Promise<{ ok: boolean; summary: string }> {
    const found = await agency().act("contacts.find", { query: ask.who }, { parent });
    if (!found.ok) return { ok: false, summary: `couldn't check your contacts: ${found.observation.replace(/^not done: /, "")}` };
    const pick = pickContact((found.data as ContactCandidate[] | undefined) ?? []);
    const who = ask.who.toLowerCase();
    if (pick.kind === "none") return { ok: false, summary: `i can't find ${who} in your contacts.` };
    if (pick.kind === "no_handle") return { ok: false, summary: `${pick.contact.name.toLowerCase()}'s in your contacts but there's no number or email for them.` };
    if (pick.kind === "many") {
      pending = { stage: "which", options: pick.options, ask, until: now() + 90_000, retried: false };
      return { ok: true, summary: whichQuestion(pick.options) };
    }
    return withContact(pick.contact, pick.handle, ask, parent);
  }

  async function withContact(contact: ContactCandidate, handle: ContactHandle, ask: Pick<MessageAsk, "body" | "dictated">, parent?: string) {
    if (!ask.body) {
      pending = { stage: "body", contact, handle, until: now() + 90_000 };
      return { ok: true, summary: `what do you wanna say to ${firstName(contact)}?` };
    }
    const text = await draftMessage(ctx.tryUse("brains"), contact.name, ask.body, ask.dictated);
    return confirmAndSend(contact, handle, text, parent);
  }

  /** Read back, take edits ("make it shorter"), send only on a fresh spoken yes for the exact words. */
  async function confirmAndSend(contact: ContactCandidate, handle: ContactHandle, first: string, parent?: string) {
    const { bus } = ctx;
    let text = first;
    const maxEdits = o.maxEdits ?? 5;
    for (let round = 0; round <= maxEdits; round++) {
      if (!text) return { ok: false, summary: "that came out empty, not sending anything." };
      const nonce = newId("msg");
      let actionId: string | null = null;
      let edit: DraftEdit | null = null;
      const offReq = bus.on("action.request", (e) => {
        if (e.source === "agency" && e.data.kind === "messages.send" && (e.data.args as { nonce?: string })?.nonce === nonce) actionId = e.data.actionId;
      });
      // Registered before the gate's own listener, so an edit ("ok make it shorter")
      // lands as a no for this draft before any yes-word in it can approve it.
      const offVoice = bus.on("voice.final", (e) => {
        if (!actionId || edit) return;
        const ed = readDraftEdit(e.data.text);
        if (!ed) return;
        edit = ed;
        bus.emit("action.approval", { actionId, approved: false, by: "voice" }, SRC);
      });
      let r: ActionOutcome;
      try {
        r = await agency().act("messages.send", { name: contact.name, contactId: contact.id, handle: handle.value, handleKind: handle.kind, text, nonce }, { parent });
      } finally {
        offReq();
        offVoice();
      }
      if (edit) {
        const next = await applyEdit(ctx.tryUse("brains"), contact.name, text, edit);
        if (!next.changed) {
          const speech = ctx.tryUse("speech");
          await speech?.say("can't rework it right now, here it is again.", { priority: "high", parent, brain: SRC }).catch(() => {});
        }
        text = next.text;
        continue;
      }
      if (r.ok) {
        const dry = (r.data as { dryRun?: boolean } | undefined)?.dryRun;
        return { ok: true, summary: dry ? `dry run, didn't actually send it. ${r.observation}.` : "sent." };
      }
      const obs = r.observation;
      if (obs.startsWith("not done:")) {
        const why = obs.replace(/^not done: /, "");
        if (/not approved|said|no answer|key|answered by/.test(why)) return { ok: false, summary: "okay, not sending it." };
        return { ok: false, summary: `not sending it: ${why}.` };
      }
      return { ok: false, summary: `didn't send: ${obs}` };
    }
    return { ok: false, summary: "that's a lot of edits, let's start over when you know what you wanna say." };
  }

  async function answer(text: string, parent?: string) {
    const p = awaiting() ? pending : null;
    pending = null;
    if (!p) return { ok: false, summary: "not sure what you mean." };
    const t = text.trim().replace(/[.!?]+$/, "");
    if (CANCEL.test(t) && classifyApproval(t) !== "yes") return { ok: true, summary: "okay, never mind." };
    if (p.stage === "which") {
      const c = chooseOption(t, p.options);
      if (!c) {
        if (!p.retried) {
          pending = { ...p, retried: true, until: now() + 90_000 };
          return { ok: true, summary: `which one? ${whichQuestion(p.options)}` };
        }
        return { ok: false, summary: "didn't catch which one, never mind." };
      }
      return withContact(c, bestHandle(c)!, p.ask, parent);
    }
    const said = t.replace(/^(?:just\s+)?(?:say|tell\s+(?:him|her|them)|write)\s*[:,]?\s+(?=["“'‘])/i, "");
    const quoted = /^["“'‘](.+?)["”'’]?$/.exec(said);
    if (quoted) return withContact(p.contact, p.handle, { body: quoted[1]!, dictated: true }, parent);
    const sayIt = /^(?:just\s+)?say\s+(.+)$/i.exec(t);
    if (sayIt) return withContact(p.contact, p.handle, { body: sayIt[1]!, dictated: true }, parent);
    return withContact(p.contact, p.handle, { body: t, dictated: !DESCRIBES.test(t) }, parent);
  }

  async function start(ask: MessageAsk, parent?: string) {
    pending = null;
    return resolve(ask, parent);
  }

  return { awaiting, answer, start };
}

function firstName(c: ContactCandidate): string {
  return (c.name.split(/\s+/)[0] ?? c.name).toLowerCase();
}
