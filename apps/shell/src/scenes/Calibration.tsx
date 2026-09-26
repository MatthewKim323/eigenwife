import { useEffect, useRef, useState } from "react";
import { Ambient, Glitch } from "../components/fx";
import { shutter } from "../components/Shutter";
import { useGaze } from "../gaze/GazeProvider";
import { blip } from "../lib/audio";
import { useScene } from "../lib/scene";
import "../styles/scenes.css";

type Phase = "linking" | "calibrating" | "done" | "failed";

/**
 * Eye mode: frame the tracker's own LOOK HERE dots, then show accuracy.
 * Mouse mode: a 3 second "attention link established" beat. Then dating.
 */
export function CalibrationScene() {
  const gaze = useGaze();
  const { go } = useScene();
  const [phase, setPhase] = useState<Phase>("linking");
  const [acc, setAcc] = useState<number | null>(null);
  const [mode, setMode] = useState<"eye" | "mouse" | "none">("none");
  const started = useRef(false);

  useEffect(() => {
    if (!gaze || started.current) return;
    let alive = true;
    // The bridge settles on eye or mouse within ~1.5s.
    const t0 = performance.now();
    const poll = setInterval(async () => {
      const m = gaze.mode();
      if (m === "none" && performance.now() - t0 < 2500) return;
      clearInterval(poll);
      if (started.current) return;
      started.current = true;
      setMode(m);
      if (m === "eye") {
        await wait(1400);
        if (!alive) return;
        setPhase("calibrating");
        const r = await gaze.calibrate();
        if (!alive) return;
        setAcc(r.afterDeg ?? null);
        setPhase(r.ok ? "done" : "failed");
        blip(880, 120);
        await wait(2000);
      } else {
        await wait(1500);
        if (!alive) return;
        setPhase("done");
        blip(880, 120);
        await wait(1500);
      }
      if (alive) void shutter(() => go("dating"));
    }, 100);
    return () => {
      alive = false;
      clearInterval(poll);
    };
  }, [gaze, go]);

  return (
    <div className={`calib ${phase}`}>
      <Ambient />
      <div className="calib-rings" aria-hidden>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} style={{ animationDelay: `${i * 0.6}s` }} />
        ))}
        <b />
      </div>
      <div className="calib-copy">
        {phase === "linking" && (
          <>
            <div className="mono kicker">STEP 01 · ATTENTION LINK</div>
            <h2>Look at the center. Keep your head still.</h2>
            <div className="mono sub">{mode === "none" ? "searching for eyes..." : mode === "eye" ? "eye serve found · preparing calibration" : "mouse proxy · pointer stands in for your eyes"}</div>
          </>
        )}
        {phase === "calibrating" && (
          <>
            <div className="mono kicker">STEP 02 · CALIBRATION</div>
            <h2>Follow the dots with your eyes.</h2>
            <div className="mono sub">head still · blink normally · ~45s</div>
          </>
        )}
        {phase === "done" && (
          <>
            <div className="mono kicker ok">LINK ESTABLISHED</div>
            <h2>
              <Glitch text="ATTENTION LINK ESTABLISHED" />
            </h2>
            <div className="mono sub">
              {mode === "eye" ? `accuracy ${acc ? `${acc.toFixed(2)}°` : "ok"} · gaze is attention only, never input` : "mouse gaze · 120ms fixations · attention only"}
            </div>
          </>
        )}
        {phase === "failed" && (
          <>
            <div className="mono kicker warn">CALIBRATION DEGRADED</div>
            <h2>Close enough. Proceeding.</h2>
            <div className="mono sub">big targets only · accuracy {acc ? `${acc.toFixed(2)}°` : "unknown"}</div>
          </>
        )}
      </div>
    </div>
  );
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
