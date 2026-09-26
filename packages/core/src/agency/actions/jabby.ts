import type { ActionDef, ActionEnv } from "../types";
import { askJabby, jabbyMessage, jabbyUp, parseDraft, speakable, type JabbyMode } from "../../work/jabby";

/**
 * jabby as Eve's hands for email, classes (syla), discord, reminders and jobs.
 *   jabby.ask    READ                  questions; jabby is told not to change or send anything
 *   jabby.draft  READ                  compose a message without sending it
 *   jabby.act    EXTERNAL_SIDE_EFFECT  reminders, jobs, notes (asked first; never messages other people)
 *   jabby.send   SENSITIVE_ACTION      send exactly the drafted text, after Eve reads it back and matt says yes
 */

async function relay(env: ActionEnv, mode: JabbyMode, request: string, extra: { to?: string; channel?: string; body?: string } = {}) {
  const url = env.ctx.config.jabbyUrl;
  if (!(await jabbyUp(env.deps.fetch, url))) return { ok: false as const, observation: "jabby's offline right now" };
  const reply = await askJabby(env.deps.fetch, url, jabbyMessage(mode, request, extra), {
    timeoutMs: Number(env.deps.env("EVE_JABBY_TIMEOUT_MS")) || 180_000,
    onTool: (name, detail) => env.progress?.(`jabby: ${name}${detail ? ` ${detail.slice(0, 60)}` : ""}`),
    onText: (t) => env.progress?.(`jabby: ${t.slice(0, 100)}`),
  });
  if (!reply.ok) return { ok: false as const, observation: reply.error ?? "jabby didn't answer" };
  return { ok: true as const, text: reply.text, tools: reply.tools };
}

export const jabbyAsk: ActionDef = {
  kind: "jabby.ask",
  permission: "READ",
  describe: (a) => `ask jabby: ${String(a.request ?? "")}`,
  async run(args, env) {
    const request = String(args.request ?? "").trim();
    if (!request) return { ok: false, observation: "ask jabby what?" };
    const r = await relay(env, "read", request);
    if (!r.ok) return r;
    return { ok: true, observation: speakable(r.text), data: { text: r.text, tools: r.tools } };
  },
};

export const jabbyDraft: ActionDef = {
  kind: "jabby.draft",
  permission: "READ",
  describe: (a) => `have jabby draft: ${String(a.request ?? "")}`,
  async run(args, env) {
    const request = String(args.request ?? "").trim();
    if (!request) return { ok: false, observation: "draft what?" };
    const r = await relay(env, "draft", request);
    if (!r.ok) return r;
    const draft = parseDraft(r.text);
    if (!draft) return { ok: false, observation: `jabby didn't give me a draft: ${speakable(r.text, 160)}` };
    return { ok: true, observation: `draft to ${draft.to || "?"} by ${draft.channel}: ${draft.body}`, data: draft };
  },
};

export const jabbyAct: ActionDef = {
  kind: "jabby.act",
  permission: "EXTERNAL_SIDE_EFFECT",
  describe: (a) => `have jabby ${String(a.request ?? "do it").replace(/^(?:can you|please)\s+/i, "")}`,
  async run(args, env) {
    const request = String(args.request ?? "").trim();
    if (!request) return { ok: false, observation: "do what?" };
    const r = await relay(env, "act", request);
    if (!r.ok) return r;
    return { ok: true, observation: speakable(r.text), data: { text: r.text, tools: r.tools } };
  },
};

export const jabbySend: ActionDef = {
  kind: "jabby.send",
  permission: "SENSITIVE_ACTION",
  describe: (a) => `send ${String(a.channel ?? "a message")} to ${String(a.to ?? "someone")}: "${String(a.body ?? "")}"`,
  // Read the exact message back. The approval covers these words and nothing else.
  confirmLine: (a) => {
    const body = String(a.body ?? "").trim();
    const short = body.length > 320 ? body.slice(0, 317) + "..." : body;
    return `${String(a.channel ?? "message")} to ${String(a.to ?? "them")}${a.subject ? `, subject ${String(a.subject)}` : ""}: "${short}". send it?`;
  },
  refuse: (a) => {
    if (!String(a.body ?? "").trim()) return "nothing to send";
    if (!String(a.to ?? "").trim()) return "i don't know who it's for";
    return null;
  },
  async run(args, env) {
    const r = await relay(env, "send", String(args.request ?? ""), { to: String(args.to), channel: String(args.channel ?? "email"), body: String(args.body) });
    if (!r.ok) return r;
    const sent = /\bsent\b/i.test(r.text) && !/\b(?:not sent|couldn'?t|failed|error)\b/i.test(r.text);
    return { ok: sent, observation: speakable(r.text), data: { text: r.text, tools: r.tools } };
  },
};

export const JABBY_ACTIONS = [jabbyAsk, jabbyDraft, jabbyAct, jabbySend];
