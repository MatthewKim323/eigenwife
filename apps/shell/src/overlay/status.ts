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
}

export type ChipKind = "offline" | "asleep" | "approval" | "muted" | "thinking" | "heard" | "listening" | "speaking" | "mic-error" | "idle";

export interface Chip {
  kind: ChipKind;
  text: string;
  /** Secondary line, dimmer. */
  sub?: string;
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

export function chipFor(s: ChipInput): Chip {
  if (!s.connected) return { kind: "offline", text: "core offline", sub: "bun run dev" };
  if (!s.born) return { kind: "asleep", text: "asleep", sub: "run the Eigen flow first" };
  if (s.approval) return { kind: "approval", text: "say “yeah”", sub: clip(s.approval, 42) };
  if (s.muted) return { kind: "muted", text: "mic muted", sub: "⌘⇧M" };
  if (s.thinking) return { kind: "thinking", text: "thinking" };
  if (s.heard) return { kind: "heard", text: `“${clip(s.heard, 60)}”` };
  if (s.speaking) return { kind: "speaking", text: "" };
  if (s.listening) return { kind: "listening", text: "listening", sub: s.attentionPaused ? "attention paused" : undefined };
  if (s.micError) return { kind: "mic-error", text: s.micError };
  return { kind: "idle", text: "waking the mic" };
}

/** "dating_relapse#3" -> "dating relapse". */
export function triggerLabel(trigger: string): string {
  return trigger.replace(/#\d+$/, "").replace(/[_.]+/g, " ").trim();
}
