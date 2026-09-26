import { useSyncExternalStore } from "react";
import type { AnyEnvelope, EventMap, Persona, TraitVector } from "@eigenwife/protocol";
import type { HudLevel } from "./keys";

/**
 * Shell-local state that must outlive scene mounts (swarm events arriving
 * mid-transition, calendar events shown later on the desktop, counters for the
 * architecture slide). Fed by one always-mounted bridge (components/Hud.tsx)
 * through the pure reduceShell() below.
 */

export interface CalEvent {
  id: string;
  title: string;
  /** Display time, e.g. "7:30 PM". */
  when: string;
  where?: string;
  ts: number;
}

export interface SwarmAgent {
  id: string;
  role: string;
  label: string;
  name?: string;
  emoji?: string;
  goal?: string;
  parentId?: string;
  state: EventMap["swarm.status"]["state"];
  tool?: string;
  progress: string[];
  result?: string;
  ok?: boolean;
  order: number;
}

export interface SwarmRun {
  taskId: string;
  goal: string;
  brain: string;
  startedAt: number;
  plan?: EventMap["swarm.plan"];
  agents: Record<string, SwarmAgent>;
  order: string[];
  conflicts: (EventMap["swarm.conflict"] & { ts: number })[];
  resolve?: EventMap["swarm.resolve"] & { ts: number };
  merge?: EventMap["swarm.merge"] & { ts: number };
  approval?: EventMap["action.request"];
  approved?: boolean;
  done?: EventMap["task.done"];
}

export interface ReflexChip {
  id: string;
  decision: string;
  score: number;
  trigger: string;
  ts: number;
}

export interface ShellState {
  hud: HudLevel;
  reticle: boolean;
  help: boolean;
  eigenOpen: boolean;
  calendar: CalEvent[];
  result: { taskId: string; summary: string; ok: boolean; ts: number } | null;
  swarm: SwarmRun | null;
  approval: EventMap["action.request"] | null;
  pendingActions: Record<string, EventMap["action.request"]>;
  persona: Persona | null;
  pref: { vector: TraitVector; deltas: TraitVector; progress: number; observations: number; by: "core" | "local" } | null;
  signals: EventMap["dating.signal"][];
  counts: Record<string, number>;
  reflex: ReflexChip[];
  reflexIgnored: number;
  recall: (EventMap["memory.recall"] & { ts: number }) | null;
  home: (EventMap["home.status"] & { ts: number }) | null;
  eye: EventMap["eye.status"] | null;
  avatarState: EventMap["avatar.state"]["state"];
  lastTarget: EventMap["gaze.target"] | null;
}

export const initialShell = (): ShellState => ({
  hud: "full",
  reticle: new URLSearchParams(globalThis.location?.search ?? "").get("reticle") !== "0",
  help: false,
  eigenOpen: false,
  calendar: [],
  result: null,
  swarm: null,
  approval: null,
  pendingActions: {},
  persona: null,
  pref: null,
  signals: [],
  counts: {},
  reflex: [],
  reflexIgnored: 0,
  recall: null,
  home: null,
  eye: null,
  avatarState: "sleeping",
  lastTarget: null,
});

const TIME_RE = /\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|AM|PM)?\b/;

/** "7:30" -> "7:30 PM" (evenings are the demo's default), "19:30" -> "7:30 PM". */
export function formatWhen(raw: unknown): string | null {
  if (typeof raw === "number") raw = new Date(raw).toISOString();
  if (typeof raw !== "string") return null;
  const iso = Date.parse(raw);
  if (!Number.isNaN(iso) && /\d{4}-\d{2}-\d{2}/.test(raw)) {
    return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  const m = raw.match(TIME_RE);
  if (!m || (!m[2] && !m[3])) return null;
  let h = Number(m[1]);
  const min = m[2] ?? "00";
  let ampm = m[3]?.toUpperCase();
  if (!ampm) {
    if (h >= 13) {
      h -= 12;
      ampm = "PM";
    } else ampm = "PM";
  }
  if (h === 0) h = 12;
  return `${h}:${min} ${ampm}`;
}

function calFromArgs(actionId: string, req: EventMap["action.request"], ts: number): CalEvent {
  const a = req.args as Record<string, unknown>;
  const title = String(a.title ?? a.summary ?? a.name ?? req.description).slice(0, 60);
  const when = formatWhen(a.start ?? a.when ?? a.time ?? a.startTime) ?? formatWhen(req.description) ?? "tonight";
  const where = typeof a.location === "string" ? a.location : typeof a.where === "string" ? a.where : undefined;
  return { id: actionId, title, when, ...(where ? { where } : {}), ts };
}

const isCalendar = (kind: string) => /calendar|event|schedule/i.test(kind);

export function reduceShell(s: ShellState, e: AnyEnvelope): ShellState {
  const counts = { ...s.counts, [e.type]: (s.counts[e.type] ?? 0) + 1 };
  const base = e.type === "gaze.point" ? s : { ...s, counts };
  switch (e.type) {
    case "preference.update":
      return { ...base, pref: { ...e.data, by: e.source === "shell" ? "local" : "core" } };
    case "preference.converged":
      return { ...base, persona: e.data.persona };
    case "companion.born":
      return { ...base, persona: e.data.persona };
    case "dating.signal":
      return { ...base, signals: [...s.signals.slice(-19), e.data] };
    case "reflex.decision": {
      const score = e.data.scores[e.data.decision] ?? 0;
      const chip = { id: e.id, decision: e.data.decision, score, trigger: e.data.trigger, ts: e.ts };
      return {
        ...base,
        reflex: [...s.reflex.slice(-3), chip],
        reflexIgnored: s.reflexIgnored + (e.data.decision === "IGNORE" ? 1 : 0),
      };
    }
    case "memory.recall":
      return { ...base, recall: { ...e.data, ts: e.ts } };
    case "home.status":
      return { ...base, home: { ...e.data, ts: e.ts } };
    case "eye.status":
      return { ...base, eye: e.data };
    case "avatar.state":
      return { ...base, avatarState: e.data.state };
    case "gaze.target":
      return { ...base, lastTarget: e.data };
    case "app.opened":
      return e.data.app.toLowerCase().includes("eigen") ? { ...base, eigenOpen: true } : base;
    case "app.focused":
      return s.eigenOpen && !e.data.app.toLowerCase().includes("eigen") ? { ...base, eigenOpen: false } : base;
    case "task.start":
      return {
        ...base,
        swarm: { taskId: e.data.taskId, goal: e.data.goal, brain: e.data.brain, startedAt: e.ts, agents: {}, order: [], conflicts: [] },
      };
    case "swarm.plan":
      return withRun(base, e.data.taskId, (r) => ({ ...r, plan: e.data }));
    case "swarm.spawn":
      return withRun(base, e.data.taskId, (r) => {
        const prev = r.agents[e.data.agentId];
        const agent: SwarmAgent = {
          id: e.data.agentId,
          role: e.data.role,
          label: e.data.label,
          ...(e.data.name ? { name: e.data.name } : {}),
          ...(e.data.emoji ? { emoji: e.data.emoji } : {}),
          ...(e.data.goal ? { goal: e.data.goal } : {}),
          ...(e.data.parentId ? { parentId: e.data.parentId } : {}),
          state: prev?.state ?? "spawning",
          progress: prev?.progress ?? [],
          order: prev?.order ?? r.order.length,
        };
        return { ...r, agents: { ...r.agents, [agent.id]: agent }, order: prev ? r.order : [...r.order, agent.id] };
      });
    case "swarm.status":
      return withAgent(base, e.data.taskId, e.data.agentId, (a) => ({ ...a, state: e.data.state, ...(e.data.tool ? { tool: e.data.tool } : {}) }));
    case "swarm.progress":
      return withAgent(base, e.data.taskId, e.data.agentId, (a) => ({
        ...a,
        state: a.state === "spawning" || a.state === "assigned" ? "working" : a.state,
        progress: [...a.progress.slice(-5), e.data.text],
      }));
    case "swarm.done":
      return withAgent(base, e.data.taskId, e.data.agentId, (a) => ({
        ...a,
        state: e.data.ok ? "done" : "failed",
        ok: e.data.ok,
        result: e.data.result,
      }));
    case "swarm.conflict":
      return withRun(base, e.data.taskId, (r) => ({ ...r, conflicts: [...r.conflicts, { ...e.data, ts: e.ts }] }));
    case "swarm.resolve":
      return withRun(base, e.data.taskId, (r) => ({ ...r, resolve: { ...e.data, ts: e.ts } }));
    case "swarm.merge":
      return withRun(base, e.data.taskId, (r) => ({ ...r, merge: { ...e.data, ts: e.ts } }));
    case "action.request": {
      let next: ShellState = { ...base, pendingActions: { ...s.pendingActions, [e.data.actionId]: e.data } };
      if (e.data.needsApproval) next = { ...next, approval: e.data };
      if (e.data.taskId) next = withRun(next, e.data.taskId, (r) => ({ ...r, approval: e.data }));
      return next;
    }
    case "action.approval": {
      let next: ShellState = s.approval?.actionId === e.data.actionId ? { ...base, approval: null } : base;
      const req = s.pendingActions[e.data.actionId];
      if (req?.taskId) next = withRun(next, req.taskId, (r) => ({ ...r, approved: e.data.approved }));
      return next;
    }
    case "action.result": {
      const req = s.pendingActions[e.data.actionId];
      const { [e.data.actionId]: _, ...rest } = s.pendingActions;
      let next: ShellState = { ...base, pendingActions: rest, approval: s.approval?.actionId === e.data.actionId ? null : s.approval };
      if (req && e.data.ok && isCalendar(req.kind) && !s.calendar.some((c) => c.id === e.data.actionId)) {
        next = { ...next, calendar: [...s.calendar, calFromArgs(e.data.actionId, req, e.ts)] };
      }
      return next;
    }
    case "task.done": {
      let next: ShellState = withRun(base, e.data.taskId, (r) => ({ ...r, done: e.data }));
      next = { ...next, result: { taskId: e.data.taskId, summary: e.data.summary, ok: e.data.ok, ts: e.ts } };
      // No explicit calendar action came through: read the time off the summary.
      const when = e.data.ok ? formatWhen(e.data.summary) : null;
      const already = next.calendar.some((c) => Math.abs(c.ts - e.ts) < 120_000);
      if (when && !already) {
        const title = e.data.summary.replace(/\s+/g, " ").split(/[.!]/).find((p) => p.trim().length > 3 && !TIME_RE.test(p))?.trim() ?? "Plan";
        next = { ...next, calendar: [...next.calendar, { id: `task_${e.data.taskId}`, title: title.slice(0, 48), when, ts: e.ts }] };
      }
      return next;
    }
    default:
      return base;
  }
}

function withRun(s: ShellState, taskId: string, f: (r: SwarmRun) => SwarmRun): ShellState {
  let run = s.swarm;
  // Swarm events can arrive without a task.start we saw (late join, harem CLI): adopt the task.
  if (!run || run.taskId !== taskId) run = { taskId, goal: "", brain: "", startedAt: Date.now(), agents: {}, order: [], conflicts: [] };
  return { ...s, swarm: f(run) };
}

function withAgent(s: ShellState, taskId: string, agentId: string, f: (a: SwarmAgent) => SwarmAgent): ShellState {
  return withRun(s, taskId, (r) => {
    const a = r.agents[agentId] ?? { id: agentId, role: "agent", label: agentId, state: "spawning" as const, progress: [], order: r.order.length };
    return { ...r, agents: { ...r.agents, [agentId]: f(a) }, order: r.agents[agentId] ? r.order : [...r.order, agentId] };
  });
}

// ---------------------------------------------------------------------------
// Tiny external store
// ---------------------------------------------------------------------------

type Listener = () => void;
let state: ShellState = initialShell();
const listeners = new Set<Listener>();

export const shell = {
  get: () => state,
  set(patch: Partial<ShellState> | ((s: ShellState) => Partial<ShellState>)) {
    const p = typeof patch === "function" ? patch(state) : patch;
    state = { ...state, ...p };
    listeners.forEach((l) => l());
  },
  apply(e: AnyEnvelope) {
    const next = reduceShell(state, e);
    if (next === state) return;
    state = next;
    listeners.forEach((l) => l());
  },
  subscribe(l: Listener) {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};

/** Select a slice. Return stable references (fields of state), not fresh objects. */
export function useShell<T>(sel: (s: ShellState) => T): T {
  return useSyncExternalStore(shell.subscribe, () => sel(state), () => sel(state));
}

/** For the avatar layer: Eve closes the dating app. Same as emitting shell.key {key:"eigen.close"}. */
export function closeEigen() {
  shell.set({ eigenOpen: false });
}
