import { AnimatePresence, motion } from "motion/react";
import { useEffect, useReducer, useState } from "react";
import type { AnyEnvelope } from "@eigenwife/protocol";
import { WifeFace } from "../components/WifeFace";
import { useEvent } from "../lib/bus";
import { LINGER_MS, NO_WIVES, reduceWives, shellShowing, sideSlots, visibleWives, type OverlayWives } from "../lib/wives";
import "./wives.css";

const EVENTS = ["task.start", "shell.scene", "swarm.plan", "swarm.spawn", "swarm.status", "swarm.progress", "swarm.done", "swarm.conflict", "swarm.resolve", "swarm.merge", "task.done"] as const;
const PAD = 22;

/**
 * The harem on the real desktop: while a task runs and the shell's swarm
 * scene isn't on screen, the active wives float around Eve as tiny portrait
 * bubbles with one-line captions. Pure decoration: pointer-events none, so
 * the overlay's click-through (which only reads Eve's pixels) never changes.
 */
export function WifeBubbles({ head, vp, scale }: { head: { x: number; y: number }; vp: { w: number; h: number }; scale: number }) {
  const [state, dispatch] = useReducer((s: OverlayWives, e: AnyEnvelope) => reduceWives(s, e, Date.now()), NO_WIVES);
  const [, tick] = useState(0);
  for (const t of EVENTS) useEvent(t, dispatch); // eslint-disable-line react-hooks/rules-of-hooks

  // Re-render when quips expire and when the linger ends, so bubbles fade on time.
  useEffect(() => {
    const now = Date.now();
    const due = [state.endedAt ? state.endedAt + LINGER_MS + 20 : 0, ...Object.values(state.wives).map((w) => (w.quipUntil ?? 0) + 20)].filter((t) => t > now);
    if (!due.length) return;
    const id = setTimeout(() => tick((n) => n + 1), Math.min(...due) - now);
    return () => clearTimeout(id);
  }, [state]);

  const now = Date.now();
  // A shell that switched to its swarm scene for this task already shows them big; don't double up.
  const wives = shellShowing(state) ? [] : visibleWives(state, now);
  const size = Math.round(Math.max(26, Math.min(38, 34 * scale + 8)));
  const spots = sideSlots(wives.length, head, vp, size, PAD);
  const ending = !!state.endedAt;

  return (
    <div className="ov-wives" aria-hidden>
      <AnimatePresence>
        {wives.map((w, i) => {
          const { x, y, side } = spots[i]!;
          const quip = !!w.quipUntil && now < w.quipUntil;
          const faded = w.state === "done" || w.state === "failed" || w.state === "merging" || ending;
          return (
            <motion.div
              key={w.id}
              className="ov-wife"
              data-state={w.state}
              data-quip={quip}
              data-chosen={!!w.chosen}
              data-side={side}
              style={{ left: x, top: y - size / 2, ["--s" as string]: `${size}px` }}
              initial={{ opacity: 0, scale: 0.4, x: head.x - x, y: head.y - y }}
              animate={{ opacity: faded && !w.chosen ? 0.62 : 1, scale: 1, x: 0, y: 0 }}
              exit={{ opacity: 0, scale: 0.5, x: (head.x - x) * 0.7, y: (head.y - y) * 0.7, transition: { duration: 0.45, ease: [0.4, 0, 0.2, 1] } }}
              transition={{ type: "spring", duration: 0.7, bounce: 0.2, delay: w.order * 0.08 }}
            >
              <WifeFace who={w} size={size} glow={!!w.chosen && !ending} />
              {w.caption && (
                <span className="ov-wife-cap" key={w.caption}>
                  {quip ? w.caption : `${w.name.toLowerCase()} · ${w.caption}`}
                </span>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
