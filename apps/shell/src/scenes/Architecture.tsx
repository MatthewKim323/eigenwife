import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Ambient, Glitch, useNow } from "../components/fx";
import { CORE_HTTP, useEvent } from "../lib/bus";
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
  { id: "perception", faculty: "Perception", who: "Eye tracking + Firecrawl", organ: "eyes: where, and what it is", at: [129, 122], live: (s) => `${n(s, "gaze.target", "gaze.fixation")} fixations` },
  { id: "reflex", faculty: "Reflex", who: "Jev", organ: "spinal cord: knows when not to talk", at: [150, 300], live: (s) => (n(s, "reflex.decision") ? `IGNORE ${Math.round((s.reflexIgnored / n(s, "reflex.decision")) * 100)}%` : "0 decisions") },
  { id: "memory", faculty: "Memory", who: "Moss", organ: "hippocampus", at: [178, 76], live: (s) => `${n(s, "memory.recall")} recalls · ${n(s, "memory.write")} writes` },
  { id: "personality", faculty: "Personality", who: "Featherless", organ: "social cortex: the voice", at: [150, 158], live: (s) => `${n(s, "speech.segment")} lines` },
  { id: "reasoning", faculty: "Reasoning", who: "Claude / Codex via Jabby", organ: "frontal cortex", at: [122, 62], live: (s) => `${n(s, "task.start")} escalations` },
  { id: "orchestration", faculty: "Orchestration", who: "Jabby", organ: "nervous system", at: [150, 214], live: (s) => `${Object.entries(s.counts).reduce((a, [k, b]) => (k.startsWith("__") ? a : a + b), 0)} events` },
  { id: "workspace", faculty: "Cognitive workspace", who: "Open Swarm", organ: "the desk she thinks on", at: [70, 400], live: (s) => `${n(s, "swarm.spawn")} wives spawned` },
  { id: "home", faculty: "Persistence + action", who: "Zo", organ: "her own computer, her hands", at: [230, 400], live: (s, now) => (s.home ? `up ${fmtUptime(s.home.uptimeMs + (now - s.home.ts))}` : `${n(s, "action.result")} actions`) },
];

/** Final slide: how do you build a person? Then EIGENWIFE / Your type, compiled. */
export function ArchitectureScene() {
  const live = useShell((s) => s);
  // After a reload the shell's own counters start at zero: backfill from the core's event log.
  const [backfill, setBackfill] = useState<Record<string, number>>({});
  useEffect(() => {
    fetch(`${CORE_HTTP}/events?limit=5000`)
      .then((r) => r.json())
      .then((evs: { type: string; data?: { decision?: string } }[]) => {
        const c: Record<string, number> = {};
        for (const e of evs) {
          c[e.type] = (c[e.type] ?? 0) + 1;
          if (e.type === "reflex.decision" && e.data?.decision === "IGNORE") c.__ignored = (c.__ignored ?? 0) + 1;
        }
        setBackfill(c);
      })
      .catch(() => {});
  }, []);
  const counts = { ...live.counts };
  for (const [k, v] of Object.entries(backfill)) counts[k] = Math.max(counts[k] ?? 0, v);
  const useBackfill = (backfill["reflex.decision"] ?? 0) > (live.counts["reflex.decision"] ?? 0);
  const state = { ...live, counts, reflexIgnored: useBackfill ? (backfill.__ignored ?? 0) : live.reflexIgnored };
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
            <stop offset="0" style={{ stopColor: "oklch(0.92 0.1 var(--hue))" }} stopOpacity="0.7" />
            <stop offset="1" style={{ stopColor: "oklch(0.7 0.15 calc(var(--hue) + 60))" }} stopOpacity="0" />
          </linearGradient>
          <radialGradient id="brain">
            <stop offset="0" style={{ stopColor: "oklch(0.85 0.14 var(--hue))" }} stopOpacity="0.35" />
            <stop offset="1" style={{ stopColor: "oklch(0.85 0.14 var(--hue))" }} stopOpacity="0" />
          </radialGradient>
        </defs>
        <circle cx="150" cy="66" r="80" fill="url(#brain)" />
        <g fill="none" stroke="url(#fig)" strokeWidth="1.3">
          {/* hair, head, neck, shoulders: the same silhouette as the Act I cards */}
          <path d="M86,112 C84,36 118,20 150,20 C182,20 216,36 214,112 L226,336 C200,344 180,332 170,320 L130,320 C120,332 100,344 74,336 Z" strokeOpacity="0.5" />
          <ellipse cx="150" cy="112" rx="49" ry="61" />
          <path d="M134,170 L134,222 M166,170 L166,222" />
          <path d="M22,520 C26,270 84,230 130,220 L170,220 C216,230 274,270 278,520" />
          <path d="M120,124 Q129,116 138,124 M162,124 Q171,116 180,124" />
          <path d="M143,152 Q150,157 157,152" />
        </g>
        <g fill="none" stroke="oklch(0.9 0.1 var(--hue))" strokeOpacity="0.22" strokeDasharray="2 5">
          {FACULTIES.map((f) => (
            <path key={f.id} d={`M150,190 Q${(150 + f.at[0]) / 2 + 12},${(190 + f.at[1]) / 2} ${f.at[0]},${f.at[1]}`} />
          ))}
        </g>
        {FACULTIES.map((f) => (
          <g key={f.id} transform={`translate(${f.at[0]} ${f.at[1]})`}>
            <circle r="15" fill="none" stroke="oklch(0.9 0.1 var(--hue))" strokeOpacity={hot === f.id ? 0.8 : 0.25} style={{ transition: "stroke-opacity 300ms ease" }} />
            <circle r={hot === f.id ? 7 : 4.5} fill="oklch(0.94 0.12 var(--hue))" style={{ transition: "r 300ms ease" }}>
              <animate attributeName="opacity" values="1;0.45;1" dur={`${2 + f.at[0] / 200}s`} repeatCount="indefinite" />
            </circle>
            <text x="20" y="4" fontSize="9" fontFamily="DM Mono" letterSpacing="0.12em" fill="white" opacity="0.55">
              {f.faculty.split(" ")[0]!.toUpperCase()}
            </text>
          </g>
        ))}
      </svg>
    </div>
  );
}
