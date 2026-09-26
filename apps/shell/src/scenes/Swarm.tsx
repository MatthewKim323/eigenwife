import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { Ambient, Glitch, useNow, useTypewriter } from "../components/fx";
import { gazeProps } from "../gaze/tracker";
import { useShell, type SwarmAgent, type SwarmRun } from "../lib/store";
import "../styles/swarm.css";

const CALM = 420;

function useSize() {
  const [s, setS] = useState({ w: innerWidth, h: innerHeight });
  useEffect(() => {
    const f = () => setS({ w: innerWidth, h: innerHeight });
    addEventListener("resize", f);
    return () => removeEventListener("resize", f);
  }, []);
  return s;
}

/**
 * Her workspace: Eve in the middle, wives fanning out with a radial ripple,
 * lines drawn parent to child, progress streaming under each, then the
 * argument, Eve's call, the merge back into memory, and the approval.
 */
export function SwarmScene() {
  const run = useShell((s) => s.swarm);
  const persona = useShell((s) => s.persona);
  const { w, h } = useSize();
  const cx = (w - CALM) / 2 + 30;
  const cy = h * 0.5;
  const agents = run ? run.order.map((id) => run.agents[id]!).filter(Boolean) : [];
  const pos = useMemo(() => layout(agents, cx, cy, Math.min((w - CALM) * 0.36, 380), Math.min(h * 0.3, 250)), [agents.length, cx, cy, w, h]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <motion.div className="swarm" initial={{ scale: 1.28, filter: "blur(12px)", opacity: 0 }} animate={{ scale: 1, filter: "blur(0px)", opacity: 1 }} transition={{ type: "spring", duration: 1.1, bounce: 0 }}>
      <Ambient>
        <div className="swarm-grid" />
      </Ambient>
      <Header run={run} />
      <svg className="swarm-lines" width={w} height={h} aria-hidden>
        {agents.map((a) => {
          const p = pos.get(a.id);
          if (!p) return null;
          const parent = a.parentId && pos.get(a.parentId) ? pos.get(a.parentId)! : { x: cx, y: cy };
          const mx = (parent.x + p.x) / 2;
          const my = (parent.y + p.y) / 2 - 30;
          const d = `M${parent.x},${parent.y} Q${mx},${my} ${p.x},${p.y}`;
          const gone = a.state === "despawned" || a.state === "merging";
          return (
            <g key={a.id} className={`line ${a.state}`}>
              <path d={d} className="base" pathLength={1} style={{ animationDelay: `${a.order * 80}ms` }} />
              {!gone && <path d={d} className="flow" />}
            </g>
          );
        })}
      </svg>
      <EveNode x={cx} y={cy} run={run} name={persona?.name ?? "Eve"} />
      {agents.map((a) => {
        const p = pos.get(a.id);
        return p ? <AgentNode key={a.id} a={a} x={p.x} y={p.y} cx={cx} cy={cy} /> : null;
      })}
      {run?.conflicts.map((c) => {
        const pa = pos.get(c.lines[0]?.agentId ?? c.a) ?? pos.get(c.a);
        const pb = pos.get(c.lines[1]?.agentId ?? c.b) ?? pos.get(c.b);
        if (!pa || !pb) return null;
        return <Conflict key={c.conflictId} c={c} a={pa} b={pb} resolved={!!run.resolve} />;
      })}
      {run?.merge && <Merge run={run} pos={pos} cx={cx} cy={cy} />}
      <Resolve run={run} />
      <ApprovalCard run={run} />
    </motion.div>
  );
}

function layout(agents: SwarmAgent[], cx: number, cy: number, rx: number, ry: number) {
  const m = new Map<string, { x: number; y: number }>();
  const top = agents.filter((a) => !a.parentId || !agents.some((b) => b.id === a.parentId));
  const n = Math.max(1, top.length);
  top.forEach((a, i) => {
    // n=4 lands on the diagonals, n=3 on a triangle, n=1 straight up.
    const angle = n === 1 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / n + (i * Math.PI * 2) / n;
    m.set(a.id, { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry });
  });
  // Children fan out beyond their parent.
  for (const a of agents) {
    if (m.has(a.id) || !a.parentId) continue;
    const p = m.get(a.parentId);
    if (!p) continue;
    const sib = agents.filter((b) => b.parentId === a.parentId);
    const k = sib.indexOf(a);
    const base = Math.atan2(p.y - cy, p.x - cx);
    const ang = base + (k - (sib.length - 1) / 2) * 0.5;
    m.set(a.id, { x: p.x + Math.cos(ang) * 200, y: p.y + Math.sin(ang) * 150 });
  }
  return m;
}

function Header({ run }: { run: SwarmRun | null }) {
  const now = useNow(100);
  const secs = run ? ((run.done ? run.startedAt + run.done.ms : now) - run.startedAt) / 1000 : 0;
  return (
    <div className="swarm-head">
      <div className="mode mono">
        <span className="dotlive" /> <Glitch text={run?.done ? "COMPANION MODE" : "THINKING MODE"} /> <span className="dim">· {secs.toFixed(1)}s</span>
      </div>
      <h1>"{run?.goal || "figure out tonight"}"</h1>
      <div className="plan mono">
        {run?.plan ? (
          <>
            {run.plan.mode} · confidence {run.plan.confidence.toFixed(2)} · {run.plan.workers.length} workers
            {run.brain ? ` · ${run.brain}` : ""}
          </>
        ) : (
          <>planning{run?.brain ? ` · ${run.brain}` : ""}...</>
        )}
      </div>
    </div>
  );
}

function EveNode({ x, y, run, name }: { x: number; y: number; run: SwarmRun | null; name: string }) {
  const retained = run?.merge?.retained.length ?? 0;
  return (
    <div className={`eve-node ${run?.done ? "done" : ""}`} style={{ left: x, top: y }} {...gazeProps("swarm_eve", `${name}, coordinating the task`, "avatar")}>
      <div className="orb">
        <i />
        <i />
        <i />
      </div>
      <div className="label mono">{name.toUpperCase()}</div>
      <div className="sub mono">{run?.done ? (run.done.ok ? "done" : "failed") : run?.merge ? "merging" : "orchestrating"}</div>
      <AnimatePresence>
        {retained > 0 && (
          <motion.div className="mem mono" initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 1.2 }}>
            MEMORY +{retained}
            {run!.merge!.discarded ? <span className="dim"> · {run!.merge!.discarded} discarded</span> : null}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function AgentNode({ a, x, y, cx, cy }: { a: SwarmAgent; x: number; y: number; cx: number; cy: number }) {
  const last = a.progress[a.progress.length - 1] ?? "";
  const typed = useTypewriter(last, 80);
  const gone = a.state === "despawned";
  return (
    <motion.div
      className={`agent ${a.state}`}
      style={{ left: x, top: y }}
      initial={{ x: cx - x, y: cy - y, scale: 0.5, opacity: 0 }}
      animate={gone ? { x: (cx - x) * 0.85, y: (cy - y) * 0.85, scale: 0.4, opacity: 0 } : { x: 0, y: 0, scale: 1, opacity: 1 }}
      transition={gone ? { duration: 0.7, ease: [0.4, 0, 0.2, 1] } : { type: "spring", duration: 0.8, bounce: 0.18, delay: a.order * 0.08 }}
      {...gazeProps(`swarm_${a.id}`, `${a.name ?? a.label}: ${a.goal ?? a.role}`, "other", { role: a.role, state: a.state })}
    >
      <div className="top">
        <span className="emoji">{a.emoji ?? "◆"}</span>
        <div className="who">
          <b>{a.name ?? a.label}</b>
          <span className="mono">{a.role.toUpperCase()}</span>
        </div>
        <span className={`state mono ${a.state}`}>{a.state === "working" && a.tool ? a.tool : a.state}</span>
      </div>
      {a.goal && <div className="goal">{a.goal}</div>}
      <div className="stream mono">
        {a.progress.slice(-3, -1).map((p, i) => (
          <div key={i} className="old">
            {p}
          </div>
        ))}
        {last && <div className="cur">{typed}</div>}
        {!last && a.state !== "done" && <div className="old">spawning...</div>}
      </div>
      {a.result && a.state !== "working" && (
        <div className={`res ${a.ok === false ? "bad" : ""}`}>
          <span>{a.ok === false ? "✕" : "✓"}</span> {a.result}
        </div>
      )}
    </motion.div>
  );
}

function Conflict({ c, a, b, resolved }: { c: SwarmRun["conflicts"][number]; a: { x: number; y: number }; b: { x: number; y: number }; resolved: boolean }) {
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return (
    <motion.div className={`conflict ${resolved ? "resolved" : ""}`} style={{ left: mx, top: my }} initial={{ opacity: 0, scale: 0.9 }} animate={{ opacity: resolved ? 0.35 : 1, scale: 1 }} transition={{ type: "spring", duration: 0.5, bounce: 0.3 }}>
      <div className="topic mono">CONFLICT · {c.topic}</div>
      {c.lines.slice(0, 2).map((l, i) => (
        <motion.div key={i} className={`bubble ${i ? "r" : "l"}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: 0.3 + i * 0.7 }}>
          {l.text}
        </motion.div>
      ))}
    </motion.div>
  );
}

function Resolve({ run }: { run: SwarmRun | null }) {
  const text = run?.resolve?.text ?? "";
  const typed = useTypewriter(text, 26);
  if (!run?.resolve) return null;
  return (
    <div className="resolve" key={run.resolve.conflictId}>
      <div className="k mono">EVE</div>
      <div className="line">{typed}</div>
    </div>
  );
}

function Merge({ run, pos, cx, cy }: { run: SwarmRun; pos: Map<string, { x: number; y: number }>; cx: number; cy: number }) {
  const m = run.merge!;
  const from = m.agentIds.map((id) => pos.get(id)).filter(Boolean) as { x: number; y: number }[];
  return (
    <>
      {m.retained.map((fact, i) => {
        const p = from[i % Math.max(1, from.length)] ?? { x: cx, y: cy - 200 };
        return (
          <motion.div
            key={i}
            className="fact mono"
            style={{ left: cx, top: cy }}
            initial={{ x: p.x - cx, y: p.y - cy, opacity: 0, scale: 0.9 }}
            animate={{ x: [p.x - cx, (p.x - cx) * 0.4, 0], y: [p.y - cy, (p.y - cy) * 0.4, 0], opacity: [0, 1, 0], scale: [0.9, 1, 0.6] }}
            transition={{ duration: 1.6, delay: 0.2 + i * 0.25, ease: [0.65, 0, 0.35, 1] }}
          >
            {fact}
          </motion.div>
        );
      })}
    </>
  );
}

function ApprovalCard({ run }: { run: SwarmRun | null }) {
  const a = run?.approval;
  if (!a) return null;
  const state = run!.approved === true ? "approved" : run!.approved === false ? "denied" : "pending";
  return (
    <motion.div className={`sw-approval ${state}`} initial={{ opacity: 0, y: 24, scale: 0.97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={{ type: "spring", duration: 0.6, bounce: 0.15 }}>
      <div className="k mono">
        {a.permission.replace(/_/g, " ")} · {a.kind}
      </div>
      <div className="d">{a.description}</div>
      <div className="say mono">
        {state === "pending" ? (
          <>
            say <b>"yeah"</b> to approve · <b>"nah"</b> to cancel
          </>
        ) : state === "approved" ? (
          <b className="ok">APPROVED BY VOICE</b>
        ) : (
          <b className="no">CANCELLED</b>
        )}
      </div>
      {run!.done && <div className="done mono">{run!.done.summary}</div>}
    </motion.div>
  );
}
