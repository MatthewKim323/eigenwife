import type { Envelope } from "@eigenwife/protocol";
import type { Module } from "../context";
import { TOUCH_LINES, type TouchKind } from "../speech/lines";

/**
 * She answers touch. Every pat, poke, poke-spam, drag and drop from the
 * overlay or the shell column gets one short pre-rendered line whose mood
 * marks match the face the shell already played. No brain round trip, so it
 * lands instantly. Rate limited, never repeats a line twice in a row, never
 * talks over herself (except to get annoyed), and stays quiet before she's born.
 */
export interface TouchOptions {
  /** Min gap between any two touch lines. */
  gapMs?: number;
  now?: () => number;
  random?: () => number;
}

export class TouchVoice {
  private lastAt = -Infinity;
  private lastLine = new Map<TouchKind, string>();
  constructor(private opts: Required<TouchOptions>) {}

  /** The line to say for this touch right now, or null (rate limited / she's busy). */
  pick(kind: TouchKind, speaking: boolean): string | null {
    const now = this.opts.now();
    if (speaking && kind !== "annoyed") return null;
    if (now - this.lastAt < this.opts.gapMs && kind !== "annoyed") return null;
    const pool = TOUCH_LINES[kind];
    const prev = this.lastLine.get(kind);
    const choices = pool.length > 1 ? pool.filter((l) => l !== prev) : [...pool];
    const line = choices[Math.floor(this.opts.random() * choices.length) % choices.length]!;
    this.lastLine.set(kind, line);
    this.lastAt = now;
    return line;
  }
}

export function touchModule(opts: TouchOptions = {}): Module {
  const offs: (() => void)[] = [];
  return {
    name: "touch",
    start(ctx) {
      const voice = new TouchVoice({ gapMs: opts.gapMs ?? 2500, now: opts.now ?? Date.now, random: opts.random ?? Math.random });
      offs.push(
        ctx.bus.on("avatar.touch", (e: Envelope<"avatar.touch">) => {
          if (!ctx.world().companion.born) return;
          const speech = ctx.tryUse("speech");
          if (!speech) return;
          const line = voice.pick(e.data.kind, speech.speaking());
          if (!line) return;
          void speech.say(line, { priority: "high", interrupt: e.data.kind === "annoyed", parent: e.id, brain: "touch" });
        }),
      );
    },
    stop() {
      offs.forEach((o) => o());
    },
  };
}
