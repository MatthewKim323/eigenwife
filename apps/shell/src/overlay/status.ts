/** The one small status chip under Eve on the desktop. Pure: inputs in, chip out. */

export interface ChipInput {
  connected: boolean;
  born: boolean;
  /** Description of an action waiting for a spoken yes. */
  approval: string | null;
  muted: boolean;
  thinking: boolean;
  heard: string;
  listening: boolean;
  micError: string | undefined;
  speaking: boolean;
  attentionPaused: boolean;
  /** A coding task she's running in the background (work.task), e.g. "add dark mode (eigenwife)". */
  working?: string | null;
}

export type ChipKind = "offline" | "asleep" | "approval" | "muted" | "thinking" | "heard" | "listening" | "speaking" | "mic-error" | "working" | "idle";

export interface Chip {
  kind: ChipKind;
  text: string;
  /** Secondary line, dimmer. */
  sub?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function chipFor(s: ChipInput): Chip {
  if (!s.connected) return { kind: "offline", text: "core offline", sub: "bun run dev" };
  if (!s.born) return { kind: "idle", text: "waking up" };
  if (s.approval) return { kind: "approval", text: "say “yeah”", sub: clip(s.approval, 42) };
  if (s.muted) return { kind: "muted", text: "mic muted", sub: "⌘⇧M" };
  if (s.thinking) return { kind: "thinking", text: "thinking" };
  if (s.heard) return { kind: "heard", text: `“${clip(s.heard, 60)}”` };
  if (s.speaking) return { kind: "speaking", text: "" };
  if (s.working) return { kind: "working", text: "working on", sub: clip(s.working, 42) };
  if (s.listening) return { kind: "listening", text: "listening", sub: s.attentionPaused ? "attention paused" : undefined };
  if (s.micError) return { kind: "mic-error", text: s.micError };
  return { kind: "idle", text: "waking the mic" };
}

/** "dating_relapse#3" -> "dating relapse". */
export function triggerLabel(trigger: string): string {
  return trigger.replace(/#\d+$/, "").replace(/[_.]+/g, " ").trim();
}

/** "2d ago" / "3mo ago" / "just now". */
export function ago(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d < 60) return `${d}d ago`;
  const mo = Math.round(d / 30);
  return mo < 24 ? `${mo}mo ago` : `${Math.round(mo / 12)}y ago`;
}

interface RecallHitLike {
  record: { content: string; source?: string; createdAt?: number; provenance?: { system: string; title?: string; slug?: string; at?: number } };
}

/**
 * The memory flash text. A gbrain memory says where it came from:
 * "remembered from gbrain · 4ms · Leo Park · 2mo ago"; anything else keeps
 * "remembered · 4ms · <what>".
 */
export function recallFlash(hits: RecallHitLike[], ms: number, now = Date.now()): string | null {
  const top = hits[0]?.record;
  if (!top) return null;
  const t = `${Math.max(1, Math.round(ms))}ms`;
  const p = top.provenance;
  if (p && (top.source === p.system || p.system === "gbrain")) {
    const when = p.at ?? top.createdAt;
    return `remembered from ${p.system} · ${t} · ${p.title || p.slug || top.content}${when ? ` · ${ago(now - when)}` : ""}`;
  }
  return `remembered · ${t} · ${top.content}`;
}
