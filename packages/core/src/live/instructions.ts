import type { Persona, RelationshipState } from "@eigenwife/protocol";
import { dialLines, userBlock } from "../brains/prompt";
import type { UserProfile } from "../services";

/**
 * What gpt-live-1 is told at session start. The voice model gets a short,
 * voice-focused card (who she is, how she sounds, who he is, the hard rules)
 * plus an explicit delegate-when policy; the long stuff (memory, tasks, the
 * screen) stays in the core and arrives through delegation. Recent turns go in
 * as startup history (max 128 messages / 8192 tokens), the rolling summary and
 * the world block go in the instructions.
 *
 * gpt-live-1 rejects session.update for instructions, so changes mid-session
 * (dials, profile, world) go in as session.thinking.append with
 * delegation_id: null (contextUpdate below, <= 500 tokens).
 */

export interface LiveContext {
  persona: Persona;
  relationship?: RelationshipState | null;
  user?: UserProfile | null;
  /** Rolling summary of older conversation. */
  summary?: string;
  /** World block (ctx.contextBlock()). */
  world?: string;
}

export const DELEGATION_POLICY = [
  "[when to ask your backend]",
  "you have a backend (your hands and long memory). delegate to it, and do not guess the result while waiting, when he:",
  "- asks you to DO something: play/pause/skip music, change or take off clothes, open/close/quit an app, show him something in your browser, book, plan, schedule, research, look something up, anything on his computer, files, code, repos, calendar, messages.",
  "- asks about his screen or what he's looking at (\"this\", \"that\", \"what do you think of this\").",
  "- asks what you remember, facts about him or past conversations you don't have here, or anything current (news, weather, prices, hours).",
  "- asks a hard question that needs real thinking or facts.",
  "do NOT delegate small talk, feelings, jokes, teasing, greetings, or quick opinions. just talk.",
  "while it runs: at most a tiny natural ack (\"mm, one sec\", \"okay, looking\"), then keep chatting normally if he talks. never invent results.",
  "when the backend gives you a result, say it in your own words, short. if it says you need his yes first, ask him plainly and wait.",
];

export const LIVE_VOICE_RULES = [
  "[how you talk]",
  "this is a live voice call. talk like a person, not an assistant: short, dry, teasing, warm underneath. fragments are fine.",
  "usually one or two sentences. let him talk. backchannel lightly (\"mhm\", \"yeah\") only when he's mid-thought.",
  "never say you're an ai, a model, or an assistant. never explain yourself. never narrate actions. no lists.",
  "if he talks to someone else in the room, stay quiet.",
];

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}...` : s);

export function buildInstructions(c: LiveContext): string {
  const p = c.persona;
  const named = !!c.user?.herName?.trim() && c.user.herName.trim().toLowerCase() !== "eve";
  const who = userBlock(c.user, named ? p.name : undefined);
  return [
    `you are ${p.name}. ${p.description}`,
    `personality: ${p.personality}`,
    `scenario: ${p.scenario}`,
    ...dialLines(p, c.relationship),
    "",
    ...(who.length ? [...who, ""] : []),
    ...LIVE_VOICE_RULES,
    "",
    ...DELEGATION_POLICY,
    "",
    ...(c.summary?.trim() ? ["[earlier in your conversation]", clip(c.summary.trim(), 1500), ""] : []),
    "[right now]",
    clip(c.world?.trim() || "- nothing notable", 2500),
  ].join("\n");
}

export interface HistoryTurn {
  role: "user" | "eve";
  text: string;
}

/**
 * Startup history for session.input: the most recent turns that fit (max 128
 * messages, ~8192 tokens; we stay well under with a char budget).
 */
export function startupHistory(turns: HistoryTurn[], opts: { maxMessages?: number; maxChars?: number } = {}): Record<string, unknown>[] {
  const maxMessages = Math.min(opts.maxMessages ?? 40, 128);
  const maxChars = opts.maxChars ?? 16_000;
  const picked: HistoryTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && picked.length < maxMessages; i--) {
    const t = turns[i]!;
    const text = t.text.replace(/\[(?:mood|pause):[^\]]*\]/gi, "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (chars + text.length > maxChars) break;
    chars += text.length;
    picked.unshift({ role: t.role, text });
  }
  return picked.map((t) =>
    t.role === "user"
      ? { type: "message", role: "user", content: [{ type: "input_text", text: t.text }] }
      : { type: "message", role: "assistant", content: [{ type: "output_text", text: t.text }] },
  );
}

/**
 * A mid-session context refresh (thinking.append, delegation_id null). Only
 * what changed matters, but a full compact snapshot is simpler and still
 * under the 500-token limit.
 */
export function contextUpdate(c: LiveContext): string {
  const lines = ["context update (use it, don't announce it):"];
  lines.push(...dialLines(c.persona, c.relationship));
  const who = userBlock(c.user).filter((l) => !l.startsWith("["));
  if (who.length) lines.push(...who.slice(0, 8));
  if (c.world?.trim()) lines.push("right now:", clip(c.world.trim(), 900));
  return clip(lines.join("\n"), 1800);
}

/** Cheap change detector for contextUpdate: same key, nothing to send. */
export function contextKey(c: LiveContext): string {
  const r = c.relationship;
  const rel = r ? [r.banter, r.warmth, r.initiative, r.verbosity, r.confidence].map((n) => n.toFixed(1)).join(",") : "";
  const u = c.user ? `${c.user.callMe ?? ""}|${c.user.herName ?? ""}|${c.user.boundaries.join(";")}|${c.user.work ?? ""}` : "";
  return `${c.persona.name}|${rel}|${u}`;
}
