import { useEffect, useRef, useState } from "react";
import type { Mood } from "@eigenwife/protocol";
import { avatarRuntime, avatarUi, useStore } from "./store";

export const TACHIE_MOODS: readonly Mood[] = ["neutral", "happy", "annoyed", "thinking", "surprised", "smug", "sad"];
const src = (name: string) => `/avatar/tachie/${name}.webp`;

/**
 * Safety net if Live2D won't load: pre-rendered stills of the same
 * rig per mood (see scripts in docs/AVATAR.md), with a CSS bob, a blink
 * overlay driven by the same blink scheduler, and a talking overlay.
 */
export function Tachie() {
  const state = useStore(avatarUi, (s) => s.state);
  const [mood, setMood] = useState<Mood>("neutral");
  const blinkRef = useRef<HTMLImageElement>(null);
  const talkRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let raf = 0;
    let last = "";
    const loop = () => {
      const now = performance.now();
      const rig = avatarRuntime.rig;
      const m = rig.emotion.dominant(now);
      if (m !== last) {
        last = m;
        setMood(m);
      }
      const b = rig.blink.update(now);
      const asleep = avatarUi.get().state === "sleeping";
      if (blinkRef.current) blinkRef.current.style.opacity = asleep || (b !== null && b < 0.5) ? "1" : "0";
      if (talkRef.current) talkRef.current.style.opacity = !asleep && avatarRuntime.mouth > 0.22 ? "1" : "0";
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const base = state === "thinking" ? "thinking" : mood;
  return (
    <div className="eve-tachie" data-state={state}>
      {TACHIE_MOODS.map((m) => (
        <img key={m} src={src(m)} alt="" draggable={false} style={{ opacity: m === base ? 1 : 0 }} />
      ))}
      <img ref={talkRef} src={src(`${base}-talk`)} onError={(e) => (e.currentTarget.src = src("neutral-talk"))} alt="" draggable={false} style={{ opacity: 0, transition: "none" }} />
      <img ref={blinkRef} src={src(`${base}-blink`)} onError={(e) => (e.currentTarget.src = src("neutral-blink"))} alt="" draggable={false} style={{ opacity: 0, transition: "none" }} />
    </div>
  );
}
