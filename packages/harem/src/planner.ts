import type { Brain, HaremTask, Plan, WifeRole, WorkerSpec } from "./types";
import { WIVES } from "./wives";

export const MAX_WIVES = 4;
/** Only Eve spawns. Wives never get a spawn tool, so recursion is impossible, not just discouraged. */
export const MAX_DEPTH = 1;

const ROLES = Object.keys(WIVES) as WifeRole[];

const PLAN_SCHEMA = {
  type: "object",
  properties: {
    mode: { type: "string", enum: ["DO_MYSELF", "SPAWN_ONE", "SPAWN_SWARM", "ASK_USER"] },
    confidence: { type: "number" },
    reason: { type: "string" },
    workers: {
      type: "array",
      maxItems: MAX_WIVES,
      items: {
        type: "object",
        properties: { role: { type: "string", enum: ROLES }, goal: { type: "string" } },
        required: ["role", "goal"],
      },
    },
  },
  required: ["mode", "confidence", "workers"],
};

const PLANNER_SYSTEM = `You are Eve's planner. Decide how to execute the user's task.
DO_MYSELF: one quick answer, no research. SPAWN_ONE: one specialist is enough. SPAWN_SWARM: independent slices that benefit from parallel work. ASK_USER: too ambiguous to start at all (rare, prefer acting).
Available workers (role: what she does):
${ROLES.map((r) => `- ${r}: ${WIVES[r].name}, ${WIVES[r].title}`).join("\n")}
Prefer SPAWN_SWARM whenever there are 2+ independent concerns (what, when, how much, how far).
At most ${MAX_WIVES} workers, each role at most once, each with a one-line goal. Only include workers that matter.`;

const EVENING = /\b(tonight|dinner|date night|evening|eat|food|hungry|plans?)\b/;

/**
 * Cheap pre-route so obvious asks never pay the planner's ~10s. Jev replaces
 * the mode half of this when it's wired; the evening template stays because
 * it's the demo's golden path and must be instant.
 */
export function quickRoute(goal: string): Plan | null {
  const g = goal.toLowerCase();
  if (EVENING.test(g) && /\b(figure|plan|what should|where should|something|ideas?|sort)\b/.test(g)) {
    const workers: WorkerSpec[] = [
      { role: "food", goal: "Find 3 dinner options that match what the user likes" },
      { role: "calendar", goal: "Find tonight's free window and a good start time" },
      { role: "budget", goal: "Keep tonight's spend reasonable" },
    ];
    if (/\b(drive|far|travel|uber|walk|transit)\b/.test(g)) workers.push({ role: "logistics", goal: "Check travel time is sane" });
    return { mode: "SPAWN_SWARM", confidence: 0.91, workers, reason: "evening plan template" };
  }
  if (g.split(/\s+/).length <= 2) return { mode: "DO_MYSELF", confidence: 0.8, workers: [], reason: "too small to delegate" };
  return null;
}

export async function planTask(task: HaremTask, brain: Brain): Promise<Plan> {
  const quick = quickRoute(task.goal);
  if (quick) return quick;
  const raw = await brain.structured<Plan>({
    agent: `${task.taskId}:planner`,
    system: PLANNER_SYSTEM,
    prompt: `Task: ${task.goal}\n\nContext:\n${task.context || "(none)"}`,
    schema: PLAN_SCHEMA,
    tools: [],
    timeoutMs: 45_000,
  });
  return normalizePlan(raw);
}

export function normalizePlan(p: Plan): Plan {
  const seen = new Set<WifeRole>();
  const workers: WorkerSpec[] = [];
  for (const w of p.workers ?? []) {
    if (!ROLES.includes(w.role) || seen.has(w.role)) continue;
    seen.add(w.role);
    workers.push({ role: w.role, goal: String(w.goal ?? "").slice(0, 200) });
    if (workers.length >= MAX_WIVES) break;
  }
  let mode = p.mode;
  if ((mode === "SPAWN_SWARM" || mode === "SPAWN_ONE") && workers.length === 0) mode = "DO_MYSELF";
  if (mode === "SPAWN_SWARM" && workers.length === 1) mode = "SPAWN_ONE";
  if (mode === "SPAWN_ONE") workers.splice(1);
  return { mode, confidence: Math.max(0, Math.min(1, Number(p.confidence) || 0)), workers, reason: p.reason };
}
