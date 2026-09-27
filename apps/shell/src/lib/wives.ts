import { CANDIDATES, type AnyEnvelope, type Candidate, type EventMap } from "@eigenwife/protocol";

/**
 * Harem wives are the Act I girls. Pure helpers shared by the swarm scene and
 * the overlay's little portrait bubbles (no React, no DOM: tested directly).
 */

const byId = new Map(CANDIDATES.map((c) => [c.id, c]));
const byName = new Map(CANDIDATES.map((c) => [c.name.toLowerCase(), c]));

/** Her candidate: by id, else by display name (older cores emit only name). */
export function wifeCandidate(a: { candidateId?: string; name?: string }): Candidate | undefined {
  return (a.candidateId && byId.get(a.candidateId)) || (a.name ? byName.get(a.name.toLowerCase()) : undefined);
}

/** Human role label: "food" -> "FOOD", "logistics" -> "PLACES". */
export function roleLabel(role: string): string {
  const r = role.toLowerCase();
  if (r === "logistics") return "PLACES";
  if (r === "calendar") return "PLANS";
  if (r === "budget") return "MONEY";
  return r.toUpperCase();
}

// ---------------------------------------------------------------------------
// Overlay presence: a tiny reducer over swarm.* for the desktop bubbles.
// ---------------------------------------------------------------------------

export type WifeState = EventMap["swarm.status"]["state"];

export interface OverlayWife {
  id: string;
  candidateId?: string;
  name: string;
  role: string;
  state: WifeState;
  /** Her latest short line: a progress blurb, then her quip in a fight. */
  caption?: string;
  /** Quip captions outrank progress chatter until this time. */
  quipUntil?: number;
  chosen?: boolean;
  order: number;
}

export interface OverlayWives {
  taskId: string | null;
  wives: Record<string, OverlayWife>;
  order: string[];
  /** When the whole thing ended (merge / task.done), so bubbles can fade out. */
  endedAt?: number;
  /** When this task started (first event we saw for it). */
  startedAt?: number;
  /** Last time a shell said it switched to its swarm scene; cleared when it leaves. */
  shellSwarmAt?: number;
}

export const NO_WIVES: OverlayWives = { taskId: null, wives: {}, order: [] };

/** A shell that flips to its swarm scene does it within ms of the task starting. */
export const SHELL_GRACE_MS = 5000;

/**
 * Is a shell showing this task in its own swarm scene? Only if it switched
 * for this task: a stale "swarm" from a tab closed mid-run doesn't count.
 */
export function shellShowing(s: OverlayWives): boolean {
  return s.shellSwarmAt !== undefined && s.startedAt !== undefined && s.shellSwarmAt >= s.startedAt - SHELL_GRACE_MS;
}

/** How long a quip holds its caption over progress lines. */
export const QUIP_HOLD_MS = 3200;
/** How long bubbles linger after the merge before they're cleared. */
export const LINGER_MS = 1800;

const clip = (s: string, n = 38) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

export function reduceWives(s: OverlayWives, e: AnyEnvelope, now = Date.now()): OverlayWives {
  const d = e.data as { taskId?: string; agentId?: string };
  const keep = s.shellSwarmAt !== undefined ? { shellSwarmAt: s.shellSwarmAt } : {};
  const fresh = (taskId: string): OverlayWives => (s.taskId === taskId && !s.endedAt ? s : { taskId, wives: {}, order: [], startedAt: now, ...keep });
  const patch = (taskId: string, agentId: string, f: (w: OverlayWife) => OverlayWife, st: OverlayWives = s): OverlayWives => {
    if (st.taskId !== taskId || !st.wives[agentId]) return st;
    return { ...st, wives: { ...st.wives, [agentId]: f(st.wives[agentId]!) } };
  };
  switch (e.type) {
    case "task.start":
      return { taskId: (e.data as EventMap["task.start"]).taskId, wives: {}, order: [], startedAt: now, ...keep };
    case "swarm.plan":
      return fresh((e.data as EventMap["swarm.plan"]).taskId);
    case "shell.scene": {
      const scene = (e.data as EventMap["shell.scene"]).scene;
      if (scene === "swarm") return { ...s, shellSwarmAt: now };
      if (s.shellSwarmAt === undefined) return s;
      const { shellSwarmAt: _, ...rest } = s;
      return rest;
    }
    case "swarm.spawn": {
      const x = e.data as EventMap["swarm.spawn"];
      const base = fresh(x.taskId);
      const c = wifeCandidate(x);
      const w: OverlayWife = {
        id: x.agentId,
        ...(c ? { candidateId: c.id } : {}),
        name: x.name ?? c?.name ?? x.label,
        role: x.role,
        state: base.wives[x.agentId]?.state ?? "spawning",
        order: base.wives[x.agentId]?.order ?? base.order.length,
      };
      return { ...base, wives: { ...base.wives, [w.id]: w }, order: base.wives[w.id] ? base.order : [...base.order, w.id] };
    }
    case "swarm.status": {
      const x = e.data as EventMap["swarm.status"];
      return patch(x.taskId, x.agentId, (w) => ({ ...w, state: x.state }));
    }
    case "swarm.progress": {
      const x = e.data as EventMap["swarm.progress"];
      return patch(x.taskId, x.agentId, (w) => (w.quipUntil && now < w.quipUntil ? w : { ...w, caption: clip(x.text) }));
    }
    case "swarm.done": {
      const x = e.data as EventMap["swarm.done"];
      return patch(x.taskId, x.agentId, (w) => ({ ...w, state: x.ok ? "done" : "failed" }));
    }
    case "swarm.conflict": {
      const x = e.data as EventMap["swarm.conflict"];
      return x.lines.reduce((st, l) => patch(x.taskId, l.agentId, (w) => ({ ...w, caption: clip(l.text, 52), quipUntil: now + QUIP_HOLD_MS }), st), s);
    }
    case "swarm.resolve": {
      const x = e.data as EventMap["swarm.resolve"];
      if (!x.winner) return s;
      return patch(x.taskId, x.winner, (w) => ({ ...w, chosen: true }));
    }
    case "swarm.merge":
    case "task.done": {
      const x = e.data as { taskId: string };
      if (s.taskId !== x.taskId || s.endedAt) return s;
      return { ...s, endedAt: now };
    }
    default:
      return s;
  }
}

/** The wives worth drawing right now, in spawn order. Empty once the linger is over. */
export function visibleWives(s: OverlayWives, now = Date.now()): OverlayWife[] {
  if (!s.taskId) return [];
  if (s.endedAt && now - s.endedAt > LINGER_MS) return [];
  return s.order.map((id) => s.wives[id]!).filter((w) => w && w.state !== "despawned");
}

/**
 * Where the bubbles sit in the overlay window: fanned out to either side of
 * her head, alternating left / right and stepping down, so nothing ever
 * covers her face. Page px, centers of the portraits.
 */
export function sideSlots(n: number, head: { x: number; y: number }, vp: { w: number; h: number }, size: number, pad = 22): { x: number; y: number; side: "l" | "r" }[] {
  const step = size + 44;
  const top = Math.max(pad + size / 2 + 40, head.y - step * 0.6);
  return Array.from({ length: Math.max(0, n) }, (_, i) => {
    const side = i % 2 ? "r" : "l";
    const k = Math.floor(i / 2);
    const x = side === "l" ? pad + size / 2 : vp.w - pad - size / 2;
    // Stagger the right column half a step so a fight reads left, then right.
    const y = Math.min(vp.h - 120, top + k * step + (side === "r" ? step * 0.35 : 0));
    return { x: Math.round(x), y: Math.round(y), side };
  });
}
