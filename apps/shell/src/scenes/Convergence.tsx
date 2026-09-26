import { useEffect, useMemo, useState } from "react";
import { CANDIDATES } from "@eigenwife/protocol";
import { Ambient, Glitch } from "../components/fx";
import { shutter } from "../components/Shutter";
import { blip } from "../lib/audio";
import { localPersona } from "../lib/fallback";
import { animateHue } from "../lib/hue";
import { useScene } from "../lib/scene";
import { shell, useShell } from "../lib/store";
import "../styles/scenes.css";

type Beat = "count" | "detected" | "found" | "tear";

/**
 * LATENT MODEL 94% ... 99% / CONVERGENCE DETECTED / EIGENWOMAN FOUND.
 * --hue drifts to Eve's color, the screen tears, then emergence.
 */
export function ConvergenceScene() {
  const { go } = useScene();
  const persona = useShell((s) => s.persona);
  const pref = useShell((s) => s.pref);
  const [pct, setPct] = useState(Math.max(90, Math.floor((pref?.progress ?? 0.94) * 100) - 4));
  const [beat, setBeat] = useState<Beat>("count");
  const [flash, setFlash] = useState(0);
  const hue = persona?.palette.hue ?? (pref ? localPersona(pref.vector, CANDIDATES).palette.hue : 330);

  useEffect(() => {
    // Guarantee a persona exists for emergence even if nobody sent one.
    if (!shell.get().persona && pref) shell.set({ persona: localPersona(pref.vector, CANDIDATES) });
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, f: () => void) => timers.push(setTimeout(f, ms));
    let p = pct;
    const tick = setInterval(() => {
      p = Math.min(99, p + 1);
      setPct(p);
      blip(500 + p * 6, 30, 0.02);
      if (p >= 99) clearInterval(tick);
    }, 170);
    at(1500, () => {
      setBeat("detected");
      setFlash((f) => f + 1);
      blip(220, 200, 0.05);
    });
    at(2600, () => {
      setBeat("found");
      setFlash((f) => f + 1);
      void animateHue(hue, 2600);
      blip(1320, 260, 0.05);
    });
    at(5200, () => setBeat("tear"));
    at(6000, () => void shutter(() => go("emergence"), 1500));
    return () => {
      clearInterval(tick);
      timers.forEach(clearTimeout);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const slices = useMemo(() => Array.from({ length: 14 }, () => ({ top: Math.random() * 100, h: 0.4 + Math.random() * 5, x: (Math.random() - 0.5) * 60 })), [flash, beat]);

  return (
    <div className={`conv ${beat === "found" || beat === "tear" ? "shake" : ""}`}>
      <Ambient scanlines />
      <div className="conv-stage">
        {beat === "count" || beat === "detected" ? (
          <>
            <div className="conv-pct">
              LATENT MODEL
              <b>{pct}%</b>
            </div>
            <div className="conv-line">{beat === "detected" && <Glitch text="CONVERGENCE DETECTED" hard />}</div>
          </>
        ) : (
          <>
            <div className="conv-pct" style={{ marginBottom: 18 }}>
              CONVERGENCE DETECTED · {pct}%
            </div>
            <div className="conv-found">
              <Glitch text="EIGENWOMAN" hard />
              <br />
              <Glitch text="FOUND" hard />
            </div>
            <div className="conv-sub">
              {persona ? `${persona.name.toUpperCase()} · HUE ${Math.round(hue)} · HUMOR ${persona.dials.humor.toFixed(2)} · SARCASM ${persona.dials.sarcasm.toFixed(2)}` : "COMPILING PERSONA"}
            </div>
          </>
        )}
      </div>
      {(beat === "found" || beat === "tear") && (
        <div className="conv-slices" aria-hidden>
          {slices.map((s, i) => (
            <i
              key={i}
              style={{
                top: `${s.top}%`,
                height: `${s.h}%`,
                transform: `translateX(${s.x}px)`,
                animation: `blinky ${0.12 + (i % 4) * 0.05}s steps(2) infinite`,
                opacity: beat === "tear" ? 0.9 : 0.5,
              }}
            />
          ))}
        </div>
      )}
      <div key={flash} className={`conv-flash ${flash ? "on" : ""}`} />
    </div>
  );
}
