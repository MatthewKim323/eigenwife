import type { Module } from "../context";

/** Ambient heartbeat. The reflex layer drains its urgency queue on each tick. */
export function clock(intervalMs = 2000): Module {
  let timer: ReturnType<typeof setInterval> | undefined;
  let n = 0;
  return {
    name: "clock",
    start(ctx) {
      timer = setInterval(() => ctx.bus.emit("timer.tick", { n: ++n }), intervalMs);
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}
