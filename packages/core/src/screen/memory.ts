import type { MemoryRecord, MemoryWritePolicy } from "@eigenwife/protocol";
import { looksSensitive } from "../memory/policy";
import type { ScreenScores } from "./jev";

/**
 * What of the screen is worth remembering. Only non-sensitive, non-private,
 * interest-scored observations become short-term memories; screenshots never
 * do. A vision description is remembered only when it was for a question
 * (deictic) or an interesting auto look, and passes the same checks.
 */

export const MEMORY_MIN_INTEREST = 0.6;
export const MEMORY_EVERY_MS = 10 * 60_000;

export interface ScreenMemoryInput {
  kind: "observation" | "vision";
  app: string;
  summary: string;
  scores: ScreenScores;
  private?: boolean;
  /** When the last screen memory was written, for the rate limit. */
  lastAt?: number;
  now: number;
}

export type ScreenMemory = Pick<MemoryRecord, "kind" | "content" | "importance" | "confidence" | "tags"> & { policy: MemoryWritePolicy };

export function screenMemory(i: ScreenMemoryInput): ScreenMemory | null {
  if (i.private || i.scores.sensitive) return null;
  if (!i.summary.trim() || looksSensitive(i.summary) || /\[(?:email|phone|card|token|id|account|redacted)\]/.test(i.summary)) return null;
  if (i.kind === "observation" && i.scores.interesting < MEMORY_MIN_INTEREST) return null;
  if (i.kind === "observation" && (i.scores.mode === "coding" || i.scores.mode === "idle")) return null;
  if (i.lastAt !== undefined && i.now - i.lastAt < MEMORY_EVERY_MS) return null;
  const what = i.summary.replace(/\s+/g, " ").trim().slice(0, 140);
  return {
    kind: "episodic",
    content: `${i.kind === "vision" ? "Showed Eve" : "Was looking at"} ${what}`,
    importance: Math.round((0.2 + 0.3 * i.scores.interesting) * 100) / 100,
    confidence: 0.7,
    tags: ["screen", i.scores.mode],
    policy: "STORE_SHORT_TERM",
  };
}
