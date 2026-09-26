import type { MemoryHit, SwarmAgentState } from "@eigenwife/protocol";
import type { CoreContext } from "../context";
import { fmtTime, type BusyBlock } from "./actions/calendar";
import { DEMO_PLACES, scorePlace, type Place, type PlacePrefs } from "./actions/places";
import { SRC, type Gate } from "./gate";
import type { AgencyDeps } from "./types";

export type Role = "MEMORY" | "PLACES" | "CALENDAR" | "PLAN";
export const ROLES: Role[] = ["MEMORY", "PLACES", "CALENDAR", "PLAN"];

const LOOK: Record<Role, { emoji: string; label: string; goal: string }> = {
  MEMORY: { emoji: "🧠", label: "MEMORY", goal: "recall what you like to eat and what you're saving for" },
  PLACES: { emoji: "📍", label: "PLACES", goal: "search nearby places and compare them" },
  CALENDAR: { emoji: "📅", label: "CALENDAR", goal: "find free time tonight" },
  PLAN: { emoji: "✨", label: "PLAN", goal: "pick one concrete plan" },
};

export interface PlanStep {
  role: Role;
  goal: string;
}

export interface TaskOutcome {
  ok: boolean;
  summary: string;
  place?: Place;
  start?: number;
  booked?: boolean;
  via: string;
}

const PLAN_PROMPT = (goal: string, context: string) => `You are Eve's planner. The user said: "${goal}".
Split the work into 3-4 parallel sub-agents. Available roles (use each at most once, PLAN last):
- MEMORY: recall the user's preferences from memory
- PLACES: search real places nearby and compare
- CALENDAR: read the calendar for free time
- PLAN: aggregate everything into one concrete plan
Reply with JSON {"agents":[{"role":"MEMORY"|"PLACES"|"CALENDAR"|"PLAN","goal":string}],"confidence":number}. Goals under 10 words, lowercase, specific to this request.

Context:
${context}`;

export function normalizePlan(raw: unknown): PlanStep[] | null {
  const agents = (raw as { agents?: unknown[] } | null)?.agents;
  if (!Array.isArray(agents)) return null;
  const seen = new Set<Role>();
  const steps: PlanStep[] = [];
  for (const a of agents) {
    const role = String((a as { role?: unknown })?.role ?? "").toUpperCase() as Role;
    if (!ROLES.includes(role) || seen.has(role)) continue;
    seen.add(role);
    const goal = String((a as { goal?: unknown }).goal ?? LOOK[role].goal).slice(0, 80);
    steps.push({ role, goal });
  }
  // The plan always needs somewhere to look and someone to decide.
  if (!seen.has("PLACES")) steps.unshift({ role: "PLACES", goal: LOOK.PLACES.goal });
  if (!seen.has("PLAN")) steps.push({ role: "PLAN", goal: LOOK.PLAN.goal });
  return steps.length >= 2 ? steps.slice(0, 4) : null;
}

export function defaultPlan(): PlanStep[] {
  return ROLES.map((role) => ({ role, goal: LOOK[role].goal }));
}

const PREF_WORDS: [RegExp, (p: PlacePrefs) => void][] = [
  [/\bspic(y|e)\b|\bhot\b/i, (p) => (p.likes = [...new Set([...(p.likes ?? []), "spicy"])])],
  [/\bcheap\b|\bsaving\b|\bbudget\b|\bexpensive\b|\bafford/i, (p) => (p.budget = "cheap")],
  [/\bramen\b/i, (p) => (p.cuisine ??= "ramen")],
  [/\bsushi\b/i, (p) => (p.cuisine ??= "sushi")],
  [/\bjapanese\b/i, (p) => (p.cuisine ??= "japanese")],
  [/\btacos?\b|\bmexican\b/i, (p) => (p.cuisine ??= "tacos")],
  [/\bpizza\b/i, (p) => (p.cuisine ??= "pizza")],
  [/\bthai\b/i, (p) => (p.cuisine ??= "thai")],
  [/\bkorean\b/i, (p) => (p.cuisine ??= "korean")],
];

/** Keyword read of memories + goal + what they're looking at. Good enough when no model answers. */
export function heuristicPrefs(texts: string[]): PlacePrefs {
  const p: PlacePrefs = {};
  for (const t of texts) for (const [re, apply] of PREF_WORDS) if (re.test(t)) apply(p);
  return p;
}

interface Agent {
  id: string;
  role: Role;
}

/**
 * The built-in swarm: used when @eigenwife/harem isn't installed or fails.
 * MEMORY, PLACES, CALENDAR run in parallel (PLACES waits on MEMORY for taste,
 * visibly), PLAN aggregates, then the calendar write goes through the gate.
 */
export async function runBuiltinTask(ctx: CoreContext, gate: Gate, deps: AgencyDeps, taskId: string, goal: string, parent?: string): Promise<TaskOutcome> {
  const { bus } = ctx;
  const brains = ctx.tryUse("brains");
  const location = deps.env("EIGEN_LOCATION") || "Irvine, CA";
  const t0 = deps.now();

  // ---- plan ---------------------------------------------------------------
  let steps: PlanStep[] | null = null;
  let confidence = 0.5;
  let planVia = "default";
  if (brains) {
    const r = await brains.frontier({ goal: PLAN_PROMPT(goal, ctx.contextBlock()), json: true, tools: "none", timeoutMs: 15_000 }).catch(() => null);
    if (r?.ok) {
      steps = normalizePlan(r.json);
      confidence = Number((r.json as { confidence?: unknown })?.confidence ?? 0.7) || 0.7;
      planVia = r.engine;
    }
  }
  steps ??= defaultPlan();
  bus.emit("swarm.plan", { taskId, mode: "SPAWN_SWARM", confidence, workers: steps.map((s) => ({ role: s.role.toLowerCase(), goal: s.goal })) }, SRC, parent);
  bus.emit("diag", { label: "plan", value: `${steps.map((s) => s.role).join(" / ")} via ${planVia}`, ttlMs: 6000 }, SRC);

  const agents = new Map<Role, Agent>();
  for (const s of steps) {
    const id = `${taskId}_${s.role.toLowerCase()}`;
    agents.set(s.role, { id, role: s.role });
    bus.emit("swarm.spawn", { taskId, agentId: id, role: s.role.toLowerCase(), label: LOOK[s.role].label, parentId: "eve", emoji: LOOK[s.role].emoji, goal: s.goal }, SRC, parent);
    bus.emit("swarm.status", { taskId, agentId: id, state: "assigned" }, SRC);
  }
  const status = (r: Role, state: SwarmAgentState, tool?: string) => {
    const a = agents.get(r);
    if (a) bus.emit("swarm.status", { taskId, agentId: a.id, state, ...(tool ? { tool } : {}) }, SRC);
  };
  const say = (r: Role, text: string) => {
    const a = agents.get(r);
    if (a) bus.emit("swarm.progress", { taskId, agentId: a.id, text }, SRC);
  };
  const done = (r: Role, ok: boolean, result: string) => {
    const a = agents.get(r);
    if (!a) return;
    bus.emit("swarm.status", { taskId, agentId: a.id, state: ok ? "done" : "failed" }, SRC);
    bus.emit("swarm.done", { taskId, agentId: a.id, ok, result }, SRC);
  };

  // ---- MEMORY -------------------------------------------------------------
  const memoryWork = (async (): Promise<PlacePrefs> => {
    status("MEMORY", "working", "memory.recall");
    say("MEMORY", "remembering what you like...");
    const memory = ctx.tryUse("memory");
    let hits: MemoryHit[] = [];
    if (memory) hits = await memory.recall("food preferences, budget, what they like to eat, restaurants", { k: 6, emit: true, parent }).catch(() => []);
    for (const h of hits.slice(0, 3)) say("MEMORY", `remembered: ${h.record.content}`);
    const gaze = ctx.world().user.gazeTarget;
    const texts = [goal, ...hits.map((h) => h.record.content), gaze?.label ?? "", ...Object.values(ctx.world().slots).flatMap((s) => Object.values(s))];
    let prefs: PlacePrefs | null = null;
    if (brains && hits.length) {
      prefs = await brains
        .quickJson<PlacePrefs>(
          'Infer dinner preferences as JSON {"cuisine":string,"budget":"cheap"|"moderate"|"any","likes":string[],"avoid":string[]}. Keep words short (e.g. "spicy", "ramen").',
          texts.filter(Boolean).join("\n"),
          { timeoutMs: 8000 },
        )
        .catch(() => null);
    }
    prefs ??= heuristicPrefs(texts);
    if (!prefs.cuisine && !prefs.likes?.length && ctx.config.demo) prefs = { cuisine: "ramen", budget: "cheap", likes: ["spicy"] };
    const line = [prefs.budget === "cheap" ? "cheap" : "", ...(prefs.likes ?? []), prefs.cuisine ?? ""].filter(Boolean).join(", ") || "open to anything";
    say("MEMORY", `you want: ${line}`);
    done("MEMORY", true, line);
    return prefs;
  })();

  // ---- CALENDAR -----------------------------------------------------------
  const calendarWork = (async (): Promise<{ start: number; note: string }> => {
    const dinner = new Date(deps.now()).setHours(19, 30, 0, 0);
    const from = Math.max(dinner, deps.now() + 30 * 60_000);
    if (!agents.has("CALENDAR")) return { start: roundUp(from), note: "didn't check the calendar" };
    status("CALENDAR", "working", "calendar.free_busy");
    say("CALENDAR", "checking your calendar for tonight...");
    const r = await gate.request("calendar.free_busy", { from, until: new Date(deps.now()).setHours(23, 30, 0, 0), needMin: 90 }, { taskId, parent });
    const data = r.data as { busy: BusyBlock[]; freeFrom: number | null } | undefined;
    if (r.ok && data) {
      for (const b of data.busy.slice(0, 3)) say("CALENDAR", `busy: ${b.title} ${fmtTime(b.start)}-${fmtTime(b.end)}`);
      if (data.freeFrom) {
        say("CALENDAR", `you're free from ${fmtTime(data.freeFrom)}`);
        done("CALENDAR", true, `free ${fmtTime(data.freeFrom)}`);
        return { start: data.freeFrom, note: "you're free" };
      }
      say("CALENDAR", "tonight's packed, squeezing it in late");
      done("CALENDAR", true, "no clean gap");
      return { start: roundUp(from), note: "it's tight" };
    }
    say("CALENDAR", "couldn't read Calendar, assuming you're free");
    done("CALENDAR", false, "calendar unreadable");
    return { start: roundUp(from), note: "calendar unread" };
  })();

  // ---- PLACES -------------------------------------------------------------
  const placesWork = (async (): Promise<Place[]> => {
    status("PLACES", "waiting");
    say("PLACES", "waiting on MEMORY for your taste...");
    const prefs = await memoryWork;
    status("PLACES", "working", "places.search");
    const r = await gate.request("places.search", { prefs, location }, { taskId, parent, progress: (t) => say("PLACES", t) });
    let places = ((r.data as { places?: Place[] } | undefined)?.places ?? []).slice();
    if (!places.length && ctx.config.demo) {
      say("PLACES", "search came up dry, using my short list");
      places = DEMO_PLACES.map((p) => ({ ...p, address: location }));
    }
    places.sort((a, b) => scorePlace(b, prefs) - scorePlace(a, prefs));
    if (places.length >= 2) say("PLACES", `comparing ${places.slice(0, 3).map((p) => `${p.name} ${p.cost ? `$${p.cost}` : p.price}${p.rating ? ` ${p.rating}★` : ""}`).join(" vs ")}`);
    if (places[0]) say("PLACES", `best fit: ${places[0].name} (${places[0].why})`);
    done("PLACES", places.length > 0, places[0] ? places[0].name : "nothing found");
    return places;
  })();

  // ---- PLAN ---------------------------------------------------------------
  status("PLAN", "waiting");
  say("PLAN", "waiting for the others...");
  const [prefs, cal, places] = await Promise.all([memoryWork, calendarWork, placesWork]);
  status("PLAN", "working");
  const pick = places[0];
  if (!pick) {
    done("PLAN", false, "no place fits");
    finishMerge(ctx, taskId, [...agents.values()], []);
    return { ok: false, summary: `Couldn't find anywhere ${prefs.cuisine ? `for ${prefs.cuisine} ` : ""}near ${location} tonight.`, via: "builtin", start: cal.start };
  }
  const cost = pick.cost ? `$${pick.cost}` : pick.price;
  const headline = `${fmtTime(cal.start).replace(/\s(AM|PM)$/, "")} at ${pick.name}, ${cost}${pick.dish ? ` ${pick.dish}` : ""}, ${cal.note}`;
  say("PLAN", `plan: ${headline}`);
  done("PLAN", true, headline);
  finishMerge(ctx, taskId, [...agents.values()], [`chose ${pick.name} (${cost}${pick.dish ? `, ${pick.dish}` : ""}) for ${fmtTime(cal.start)}`, `preferences: ${JSON.stringify(prefs)}`]);

  // ---- act ------------------------------------------------------------------
  const booking = await gate.request(
    "calendar.create_event",
    {
      title: `${pick.name}${pick.dish ? ` (${pick.dish})` : ""}`,
      start: new Date(cal.start).toISOString(),
      durationMin: 90,
      location: pick.address && pick.address !== pick.name ? `${pick.name}, ${pick.address}` : pick.name,
      notes: `Planned by Eve: ${pick.why}${pick.url ? `\n${pick.url}` : ""}`,
    },
    { taskId, parent, description: `put ${pick.name} at ${fmtTime(cal.start)} on your calendar` },
  );

  const summary = booking.ok ? `${capitalize(headline)}. On your calendar.` : `${capitalize(headline)}. Not on your calendar (${booking.observation.replace(/^not done: /, "")}).`;
  await ctx
    .tryUse("memory")
    ?.write({ kind: "episodic", content: `Eve planned dinner: ${headline}${booking.ok ? " (booked on calendar)" : ""}`, importance: 0.6, source: "agency" }, "STORE_LONG_TERM")
    .catch(() => null);
  ctx.log("agency", `builtin task done in ${deps.now() - t0}ms: ${summary}`);
  return { ok: true, summary, place: pick, start: cal.start, booked: booking.ok, via: "builtin" };
}

function finishMerge(ctx: CoreContext, taskId: string, agents: Agent[], retained: string[]) {
  for (const a of agents) ctx.bus.emit("swarm.status", { taskId, agentId: a.id, state: "merging" }, SRC);
  ctx.bus.emit("swarm.merge", { taskId, agentIds: agents.map((a) => a.id), retained, discarded: agents.length }, SRC);
  for (const a of agents) ctx.bus.emit("swarm.status", { taskId, agentId: a.id, state: "despawned" }, SRC);
}

function roundUp(ms: number): number {
  const step = 30 * 60_000;
  return Math.ceil(ms / step) * step;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** The last resort in demo mode: a plan that always exists, clearly canned. */
export function cannedOutcome(now: number): TaskOutcome {
  const start = Math.max(new Date(now).setHours(19, 30, 0, 0), roundUp(now + 30 * 60_000));
  const p = DEMO_PLACES[0]!;
  return { ok: true, summary: `${fmtTime(start).replace(/\s(AM|PM)$/, "")} at ${p.name}, $${p.cost} ${p.dish}. Cheap and spicy. Want it on the calendar?`, place: p, start, booked: false, via: "canned" };
}
