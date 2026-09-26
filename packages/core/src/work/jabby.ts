import type { FetchLike } from "../agency/types";
import { sseData } from "../brains/io";
import { splitJabbyChunk } from "../brains/frontier";
import { extractJson } from "../brains/text";

/**
 * The live jabby daemon as Eve's hands for everything jabby already does:
 * gmail, syla (classes), discord, reminders and jobs, gbrain. Every message
 * says how much jabby may do: READ (look, never send), ACT (may do it, still
 * never message anyone but matt), DRAFT (compose, never send), SEND (send
 * exactly this approved text, nothing else).
 */

export type JabbyMode = "read" | "act" | "draft" | "send";

const HEAD = "[eigenwife: matt asked Eve (his desktop voice companion) out loud and she is relaying it to you. she reads your reply to him out loud, so talk to matt directly (say you, not he), in 1-3 short plain sentences, no markdown, no lists, no links.]";

export function jabbyMessage(mode: JabbyMode, request: string, extra: { to?: string; channel?: string; body?: string } = {}): string {
  switch (mode) {
    case "read":
      return `${HEAD}\n[READ ONLY. look things up and answer. do NOT send, reply, post, text, email, schedule, archive or change anything, even if the request sounds like it wants that. if it needs an action, say what you would do instead.]\n\n${request}`;
    case "act":
      return `${HEAD}\n[matt approved this by voice. you may do it (reminders, jobs, notes). do NOT send any email, text or message to anyone other than matt himself.]\n\n${request}`;
    case "draft":
      return `${HEAD}\n[DRAFT ONLY. do NOT send anything. work out who it goes to and write the message in matt's voice. reply with ONLY one JSON object: {"channel":"email"|"text"|"discord","to":"<name and address/number/handle>","subject":"<email subject or empty>","body":"<the exact message>"}. if you can't tell who it's for, set "to" to "" .]\n\n${request}`;
    case "send":
      return `${HEAD}\n[matt heard this read back and said yes. send EXACTLY this, once, and nothing else: channel=${extra.channel ?? "?"} to=${extra.to ?? "?"}\nbody:\n${extra.body ?? ""}\n\nthen reply "sent" plus one short line, or the error.]\n\noriginal ask: ${request}`;
  }
}

export interface JabbyReply {
  ok: boolean;
  text: string;
  tools: string[];
  error?: string;
}

export async function jabbyUp(fetch: FetchLike, baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok && ((await res.json().catch(() => ({}))) as { ok?: boolean }).ok === true;
  } catch {
    return false;
  }
}

/** POST /api/chat and read the SSE stream to the end. onChunk sees prose and tool traces as they land. */
export async function askJabby(
  fetch: FetchLike,
  baseUrl: string,
  message: string,
  opts: { timeoutMs?: number; onText?: (t: string) => void; onTool?: (name: string, detail?: string) => void } = {},
): Promise<JabbyReply> {
  const url = baseUrl.replace(/\/$/, "");
  const tools: string[] = [];
  let text = "";
  try {
    const res = await fetch(`${url}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
    if (!res.ok || !res.body) return { ok: false, text: "", tools, error: `jabby http ${res.status}` };
    const type = res.headers.get("content-type") ?? "";
    if (!type.includes("event-stream")) {
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      return { ok: false, text: "", tools, error: `jabby: ${j.error ?? "refused"}` };
    }
    for await (const data of sseData(res.body)) {
      let evt: { type?: string; text?: string; message?: string };
      try {
        evt = JSON.parse(data);
      } catch {
        continue;
      }
      if (evt.type === "chunk" && evt.text) {
        const split = splitJabbyChunk(evt.text);
        for (const t of split.tools) {
          tools.push(t.name);
          opts.onTool?.(t.name, t.detail);
        }
        if (split.text.trim()) opts.onText?.(split.text.trim());
        text += split.text;
      } else if (evt.type === "error") return { ok: false, text: text.trim(), tools, error: `jabby: ${evt.message ?? "error"}` };
      else if (evt.type === "done") break;
    }
  } catch (err) {
    return { ok: false, text: text.trim(), tools, error: err instanceof Error && err.name === "TimeoutError" ? "jabby took too long" : `jabby: ${String(err).slice(0, 160)}` };
  }
  text = text.trim();
  if (!text) return { ok: false, text, tools, error: "jabby said nothing" };
  return { ok: true, text, tools };
}

export interface Draft {
  channel: string;
  to: string;
  subject?: string;
  body: string;
}

export function parseDraft(text: string): Draft | null {
  const j = extractJson(text) as Partial<Draft> | null;
  if (!j || typeof j !== "object" || typeof j.body !== "string" || !j.body.trim()) return null;
  return { channel: String(j.channel ?? "email"), to: String(j.to ?? "").trim(), ...(j.subject ? { subject: String(j.subject) } : {}), body: j.body.trim() };
}

/** Speakable: no markdown, no urls, no tool traces, capped. */
export function speakable(text: string, maxChars = 400): string {
  const t = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/https?:\/\/\S+/g, "a link")
    .replace(/[*_`#>]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/[\u2014\u2013]/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > 80 ? cut.slice(0, end + 1) : cut.trimEnd() + "...").trim();
}
