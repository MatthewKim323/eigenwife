import { motion } from "motion/react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { envelope, type Persona } from "@eigenwife/protocol";
import { BOX_H, BOX_W } from "../avatar/AvatarLayer";
import { easeInOutCubic } from "../avatar/motion-math";
import { avatarRuntime, avatarUi } from "../avatar/store";
import { useBus, useLatest, useWorld } from "../lib/bus";
import { useScene } from "../lib/scene";
import { voice } from "../voice/VoiceProvider";
import "../avatar/emergence.css";

/** Used only when the core never sent a persona (offline demo). */
export const FALLBACK_PERSONA: Persona = {
  name: "Eve",
  tagline: "apparently i'm your type",
  description: "Compiled from where your eyes kept going.",
  personality: "dry, warm underneath, allergic to overpriced ramen",
  scenario: "she just stepped out of a dating profile onto your desktop",
  dials: { humor: 0.86, sarcasm: 0.76, warmth: 0.68, initiative: 0.79, verbosity: 0.31, chaos: 0.61 },
  voice: { provider: "local", voiceId: "", style: "dry" },
  palette: { hue: 330 },
  vector: {},
};
const FALLBACK_LINE = "Wow. So this is what your eyes have been telling on you for? Apparently I'm your type.";

/** Choreography, ms from mount. */
export const T = { wake: 1500, reveal: 1900, revealMs: 950, glitch: 2700, step: 3160, stage: 4000, idleExitMs: 6000, maxLineMs: 20000, exitHoldMs: 900 };

type Phase = "card" | "awake" | "reveal" | "glitch" | "step" | "stage";

const DIALS: [keyof Persona["dials"], string][] = [
  ["humor", "humor"],
  ["sarcasm", "sarcasm"],
  ["warmth", "warmth"],
  ["chaos", "chaos"],
];

/**
 * Act II. The converged persona's card sits center stage with Eve asleep
 * inside it, her portrait bleeding out over the top edge. She wakes, the
 * mask dissolves, a glitch, and she steps out of the card into her
 * persistent layer while the card shatters. Her birth line plays with
 * subtitles, then the desktop.
 */
export function EmergenceScene() {
  const { go } = useScene();
  const { client } = useBus();
  const { world, connected } = useWorld();
  const converged = useLatest("preference.converged");
  const persona = world.companion.persona ?? converged?.data.persona ?? FALLBACK_PERSONA;
  const cardRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("card");
  const live = useRef({ born: world.companion.born, connected, persona });
  live.current = { born: world.companion.born, connected, persona };

  // Dock her box into the card, bleeding ~5rem above its top edge.
  useLayoutEffect(() => {
    const place = () => {
      const el = cardRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Her head sits ~5rem above the card's top edge, body inside the portrait window.
      const w = r.width * 1.2;
      const h = (w * BOX_H) / BOX_W;
      avatarUi.set({ cardRect: { x: r.left + (r.width - w) / 2, y: r.top - r.height * 0.3, w, h } });
    };
    avatarUi.set({ dock: "card", reveal: 0, glitch: false, stateOverride: "sleeping" });
    place();
    addEventListener("resize", place);
    return () => removeEventListener("resize", place);
  }, []);

  useEffect(() => {
    voice.gate(true);
    const timers: ReturnType<typeof setTimeout>[] = [];
    const at = (ms: number, fn: () => void) => timers.push(setTimeout(fn, ms));
    let raf = 0;
    let birthLine: string | null = null;
    let left = false;
    // ?stay=1: hold center stage (capturing tachie stills / screenshots).
    const stay = new URLSearchParams(location.search).get("stay") === "1";
    const leave = () => {
      if (left || stay) return;
      left = true;
      if (!live.current.born) client.dispatch(envelope("companion.born", { persona: live.current.persona }, "shell"));
      go("desktop");
    };
    const offBegin = voice.onBegin((id) => {
      birthLine ??= id;
    });
    const offDone = voice.onDone((id) => {
      if (id === birthLine) at(T.exitHoldMs, leave);
    });

    at(T.wake, () => {
      setPhase("awake");
      avatarUi.set({ stateOverride: "idle" });
      avatarRuntime.rig.setMood("surprised", 0.75, performance.now(), 1100);
    });
    at(T.reveal, () => {
      setPhase("reveal");
      const t0 = performance.now();
      const tick = () => {
        const p = Math.min(1, (performance.now() - t0) / T.revealMs);
        avatarUi.set({ reveal: easeInOutCubic(p) });
        if (p < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    at(T.glitch, () => {
      setPhase("glitch");
      avatarUi.set({ glitch: true });
    });
    at(T.step, () => {
      setPhase("step");
      avatarUi.set({ glitch: false, reveal: 1, dock: "stage" });
      avatarRuntime.rig.setMood("happy", 0.85, performance.now(), 2600);
    });
    at(T.stage, () => {
      setPhase("stage");
      avatarUi.set({ stateOverride: null });
      if (!live.current.born && !live.current.connected) {
        // Offline: she is born locally and says her line with the browser voice.
        client.dispatch(envelope("companion.born", { persona: live.current.persona }, "shell"));
        const id = `birth_${Date.now()}`;
        client.dispatch(envelope("speech.begin", { utteranceId: id, text: FALLBACK_LINE, brain: "local" }, "shell"));
        client.dispatch(
          envelope(
            "speech.segment",
            { utteranceId: id, seq: 0, text: FALLBACK_LINE, marks: [{ at: 0, mood: "surprised", intensity: 0.6 }, { at: 62, mood: "smug", intensity: 0.9 }] },
            "shell",
          ),
        );
        client.dispatch(envelope("speech.end", { utteranceId: id, interrupted: false }, "shell"));
      }
      voice.gate(false);
    });
    at(T.stage + T.idleExitMs, () => {
      if (!birthLine) leave();
    });
    at(T.stage + T.maxLineMs, leave);

    return () => {
      timers.forEach(clearTimeout);
      cancelAnimationFrame(raf);
      offBegin();
      offDone();
      voice.gate(false);
      avatarUi.set({ reveal: 1, glitch: false, stateOverride: null, cardRect: null, dock: "hidden" });
    };
  }, [client, go]);

  const hue = persona.palette?.hue ?? 330;
  const shattered = phase === "step" || phase === "stage";
  return (
    <div className="emg" style={{ "--card-hue": hue } as CSSProperties}>
      <div className="emg-bg" data-phase={phase} />
      <div className="emg-card-anchor">
        <div ref={cardRef} className="emg-card-slot">
          {!shattered ? (
            <motion.div
              className="emg-card"
              initial={{ opacity: 0, scale: 0.96, y: 14, filter: "blur(6px)" }}
              animate={{ opacity: 1, scale: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.7, ease: [0.23, 1, 0.32, 1] }}
              data-phase={phase}
            >
              <CardFace persona={persona} phase={phase} />
            </motion.div>
          ) : (
            <Shards persona={persona} />
          )}
        </div>
      </div>
    </div>
  );
}

function CardFace({ persona, phase }: { persona: Persona; phase: Phase }) {
  return (
    <>
      <div className="emg-portrait" data-phase={phase}>
        <div className="emg-portrait-glow" />
        <div className="emg-foil" />
      </div>
      <div className="emg-info">
        <div className="emg-kicker mono">eigenwoman · converged</div>
        <div className="emg-name">
          {persona.name}
          <span className="emg-match mono">97.3% match</span>
        </div>
        <div className="emg-tagline">{persona.tagline}</div>
        <div className="emg-dials">
          {DIALS.map(([k, label]) => (
            <div key={k} className="emg-dial">
              <span className="mono">{label}</span>
              <i style={{ transform: `scaleX(${persona.dials?.[k] ?? 0.5})` }} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

const COLS = 4;
const ROWS = 6;

/** The card breaks into a grid of shards that ripple outward from her. */
function Shards({ persona }: { persona: Persona }) {
  const shards = useMemo(() => {
    const out: { clip: string; dx: number; dy: number; rot: number; delay: number }[] = [];
    for (let r = 0; r < ROWS; r++)
      for (let c = 0; c < COLS; c++) {
        const j = () => (Math.random() - 0.5) * 6;
        const x0 = (c / COLS) * 100, x1 = ((c + 1) / COLS) * 100, y0 = (r / ROWS) * 100, y1 = ((r + 1) / ROWS) * 100;
        const clip = `polygon(${x0 + j()}% ${y0 + j()}%, ${x1 + j()}% ${y0 + j()}%, ${x1 + j()}% ${y1 + j()}%, ${x0 + j()}% ${y1 + j()}%)`;
        const cx = (c + 0.5) / COLS - 0.5;
        const cy = (r + 0.5) / ROWS - 0.3;
        const d = Math.hypot(cx, cy) || 0.1;
        out.push({
          clip,
          dx: (cx / d) * (160 + Math.random() * 220),
          dy: (cy / d) * (120 + Math.random() * 200) + 80,
          rot: (Math.random() - 0.5) * 70,
          delay: Math.hypot(c - (COLS - 1) / 2, r - 1) * 0.035,
        });
      }
    return out;
  }, []);
  return (
    <>
      {shards.map((s, i) => (
        <motion.div
          key={i}
          className="emg-card emg-shard"
          style={{ clipPath: s.clip }}
          initial={{ opacity: 1, x: 0, y: 0, rotate: 0, scale: 1, filter: "blur(0px)" }}
          animate={{ opacity: 0, x: s.dx, y: s.dy, rotate: s.rot, scale: 0.86, filter: "blur(3px)" }}
          transition={{ duration: 0.95, delay: s.delay, ease: [0.23, 1, 0.32, 1] }}
        >
          <CardFace persona={persona} phase="step" />
        </motion.div>
      ))}
    </>
  );
}
