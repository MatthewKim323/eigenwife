import type { Module } from "../context";
import { GREET_LINES, type GreetKind } from "../speech/lines";

/**
 * She says hi when the desktop overlay opens: by time of day and by how long
 * she's been gone. Reloads inside a few minutes stay quiet. Lines are
 * pre-rendered, so the hello is instant.
 */
export const GREET_QUIET_MS = 5 * 60_000;
const SOON_MS = 60 * 60_000;
const LONG_MS = 24 * 60 * 60_000;

export function greetKind(now: Date, lastSeenAt: number | null): GreetKind | null {
  if (lastSeenAt === null) return "first";
  const gone = now.getTime() - lastSeenAt;
  if (gone < GREET_QUIET_MS) return null;
  if (gone > LONG_MS) return "long";
  if (gone < SOON_MS) return "soon";
  const h = now.getHours();
  if (h >= 5 && h < 12) return "morning";
  if (h >= 12 && h < 17) return "afternoon";
  if (h >= 17 && h < 23) return "evening";
  return "late";
}

export function greetModule(opts: { now?: () => number; random?: () => number } = {}): Module {
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const offs: (() => void)[] = [];
  return {
    name: "greet",
    async start(ctx) {
      const home = ctx.tryUse("home");
      let lastSeenAt = home ? await home.read<number | null>("last_seen", null).catch(() => null) : null;
      const touch = () => {
        lastSeenAt = now();
        void home?.write("last_seen", lastSeenAt).catch(() => {});
      };
      offs.push(
        ctx.bus.on("overlay.opened", (e) => {
          const kind = greetKind(new Date(now()), lastSeenAt);
          touch();
          if (!kind) return;
          const speech = ctx.tryUse("speech");
          if (!speech) return;
          // She has to be awake (the overlay wakes her on first run); give it a moment.
          const say = () => {
            if (!ctx.world().companion.born) return false;
            const pool = GREET_LINES[kind];
            void speech.say(pool[Math.floor(random() * pool.length) % pool.length]!, { priority: "high", parent: e.id, brain: "greet" });
            return true;
          };
          if (!say()) {
            const off = ctx.bus.on("companion.born", () => {
              off();
              setTimeout(say, 4000);
            });
            offs.push(off);
          }
        }),
      );
      // "Seen" means he was actually around: an overlay launch or talking to her.
      offs.push(ctx.bus.on("voice.turn", () => touch()));
    },
    stop() {
      offs.forEach((o) => o());
    },
  };
}
