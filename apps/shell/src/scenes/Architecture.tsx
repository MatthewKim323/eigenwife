import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Ambient, Glitch, useNow } from "../components/fx";
import { useEvent } from "../lib/bus";
import { useShell, type ShellState } from "../lib/store";
import { fmtUptime } from "./Desktop";
import "../styles/scenes.css";

interface Faculty {
  id: string;
  faculty: string;
  who: string;
  organ: string;
  /** Where on the figure (viewBox 0 0 300 520). */
  at: [number, number];
  live(s: ShellState, now: number): string;
}

const n = (s: ShellState, ...types: string[]) => types.reduce((a, t) => a + (s.counts[t] ?? 0), 0);

const FACULTIES: Faculty[] = [
  { id: "perception", faculty: "Perception", who: "Eye tracking + Firecrawl", organ: "eyes: where, and what it is", at: [150, 92], live: (s) => `${n(s, "gaze.target", "gaze.fixation")} fixations` },
  { id: "reflex", faculty: "Reflex", who: "Jev", organ: "spinal cord: knows when not to talk", at: [150, 250], live: (s) => (n(s, "reflex.decision") ? `IGNORE ${Math.round((s.reflexIgnored / n(s, "reflex.decision")) * 100)}%` : "0 decisions") },
  { id: "memory", faculty: "Memory", who: "Moss", organ: "hippocampus", at: [176, 66], live: (s) => `${n(s, "memory.recall")} recalls · ${n(s, "memory.write")} writes` },
  { id: "personality", faculty: "Personality", who: "Featherless", organ: "social cortex: the voice", at: [150, 128], live: (s) => `${n(s, "speech.segment")} lines` },
  { id: "reasoning", faculty: "Reasoning", who: "Claude / Codex via Jabby", organ: "frontal cortex", at: [128, 58], live: (s) => `${n(s, "task.start")} escalations` },
  { id: "orchestration", faculty: "Orchestration", who: "Jabby", organ: "nervous system", at: [150, 190], live: (s) => `${Object.values(s.counts).reduce((a, b) => a + b, 0)} events` },
  { id: "workspace", faculty: "Cognitive workspace", who: "Open Swarm", organ: "the desk she thinks on", at: [78, 300], live: (s) => `${n(s, "swarm.spawn")} wives spawned` },
  { id: "home", faculty: "Persistence + action", who: "Zo", organ: "her own computer, her hands", at: [222, 300], live: (s, now) => (s.home ? `up ${fmtUptime(s.home.uptimeMs + (now - s.home.ts))}` : `${n(s, "action.result")} actions`) },
];

/** Final slide: how do you build a person? Then EIGENWIFE / Your type, compiled. */
export function ArchitectureScene() {
  const state = useShell((s) => s);
  const now = useNow(500);
  const [final, setFinal] = useState(false);
  const [hot, setHot] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setFinal(true), 16_000);
    return () => clearTimeout(t);
  }, []);
  useEvent("shell.key", (e) => {
    if (e.data.key === "ArrowRight") setFinal(true);
    if (e.data.key === "ArrowLeft") setFinal(false);
  });
  // Light up the faculty that just fired.
  useEvent("*", (e) => {
    const map: Record<string, string> = {
      "gaze.target": "perception",
      "page.context": "perception",
      "reflex.decision": "reflex",
      "memory.recall": "memory",
      "memory.write": "memory",
      "speech.segment": "personality",
      "task.start": "reasoning",
      "swarm.spawn": "workspace",
      "home.status": "home",
      "action.result": "home",
    };
    const id = map[e.type];
    if (id) setHot(id);
  });

  return (
    <div className="arch">
      <Ambient />
      <div className="arch-inner">
        <header>
          <div className="kicker">EIGENWIFE · ARCHITECTURE</div>
          <h1>
            <Glitch text="HOW DO YOU BUILD A PERSON?" />
          </h1>
        </header>
        <div className="arch-body">
          <Figure hot={hot} />
          <div className="arch-list">
            {FACULTIES.map((f, i) => (
              <div key={f.id} className={`arch-row ${hot === f.id ? "hot" : ""}`} style={{ animationDelay: `${300 + i * 140}ms` }}>
                <div className="fac">{f.faculty}</div>
                <div className="who">{f.who}</div>
                <div className="organ">{f.organ}</div>
                <div className="live">{f.live(state, now)}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
      <AnimatePresence>
        {final && (
          <motion.div className="arch-final" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.8 }}>
            <div>
              <motion.h2 initial={{ opacity: 0, y: 20, filter: "blur(16px)" }} animate={{ opacity: 1, y: 0, filter: "blur(0px)" }} transition={{ duration: 1.2, ease: [0.22, 1, 0.36, 1], delay: 0.2 }}>
                <Glitch text="EIGENWIFE" />
              </motion.h2>
              <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1.2, duration: 0.8 }}>
                Your type, compiled.
              </motion.p>
              <motion.div className="fine" initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 2.2, duration: 0.8 }}>
                SHARED ATTENTION · MEMORY · INITIATIVE · AGENCY
              </motion.div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Figure({ hot }: { hot: string | null }) {
  return (
    <div className="arch-figure" aria-hidden>
      <svg viewBox="0 0 300 520" preserveAspectRatio="xMidYMid meet">
        <defs>
          <linearGradient id="fig" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" style={{ stopColor: "oklch(0.9 0.1 var(--hue))" }} stopOpacity="0.55" />
            <stop offset="1" style={{ stopColor: "oklch(0.7 0.15 calc(var(--hue) + 60))" }} stopOpacity="0.05" />
          </linearGradient>
        </defs>
        <g fill="none" stroke="url(#fig)" strokeWidth="1.4">
          <ellipse cx="150" cy="80" rx="46" ry="56" />
          <path d="M132,132 L132,160 M168,132 L168,160" />
          <path d="M40,520 C44,300 80,190 132,168 L168,168 C220,190 256,300 260,520" />
          <path d="M150,140 L150,420" strokeDasharray="3 5" />
          <path d="M150,190 C110,220 90,260 78,300 M150,190 C190,220 210,260 222,300" strokeDasharray="3 5" />
          <path d="M122,90 q14,-8 28,0 M150,90 q14,-8 28,0" />
        </g>
        {FACULTIES.map((f) => (
          <g key={f.id} transform={`translate(${f.at[0]} ${f.at[1]})`}>
            <circle r={hot === f.id ? 9 : 5} fill="oklch(0.92 0.13 var(--hue))" style={{ transition: "r 300ms ease" }}>
              <animate attributeName="opacity" values="1;0.5;1" dur="2.4s" repeatCount="indefinite" />
            </circle>
            <circle r="14" fill="none" stroke="oklch(0.9 0.1 var(--hue))" strokeOpacity="0.3" />
          </g>
        ))}
      </svg>
    </div>
  );
}
