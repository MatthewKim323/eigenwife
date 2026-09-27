import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { newId, type SwarmAgentState } from "@eigenwife/protocol";
import { ClaudeCliBrain, sleep } from "./brain";
import { choose, collect, conflictWinner, detectConflicts, eveResolveLine, eveSummary } from "./conflicts";
import { MAX_DEPTH, MAX_WIVES, planTask } from "./planner";
import type { Brain, Conflict, HaremAgent, HaremDeps, HaremMirror, HaremOutcome, HaremTask, Plan, WifeResult, WorkerSpec } from "./types";
import { assignCandidates, candidateById, personaBlock, pickCandidate, type WifeIdentity } from "./identity";
import { RESULT_TYPE, WIVES } from "./wives";

const SRC = "harem";

/**
 * Eve is permanent. Every wife is ephemeral: spawn, work, argue, return,
 * merge, despawn. Wives only exist while a task needs parallel hands.
 */
export class HaremManager {
  private agents = new Map<string, HaremAgent>();
  private brain: Brain;

  constructor(private deps: HaremDeps) {
    this.brain = deps.brain ?? new ClaudeCliBrain();
  }

  active(): HaremAgent[] {
    return [...this.agents.values()].filter((a) => a.state !== "despawned");
  }

  /**
   * Spawn one wife as one of the Act I girls. Pass `who` to cast her
   * yourself (executeWithHarem casts the whole plan at once); otherwise she's
   * picked by role fit, skipping girls already on this task.
   */
  spawn(taskId: string, spec: WorkerSpec, who?: WifeIdentity): HaremAgent {
    if (this.active().length >= MAX_WIVES) throw new Error(`harem is full (${MAX_WIVES})`);
    const mode = WIVES[spec.role];
    const taken = this.active()
      .filter((a) => a.taskId === taskId && a.candidateId)
      .map((a) => a.candidateId!);
    const girl = who && !taken.includes(who.candidateId) ? who : pickCandidate(taskId, spec.role, taken);
    const agent: HaremAgent = {
      id: newId(`wife_${girl.candidateId}`),
      taskId,
      name: girl.name,
      emoji: mode.emoji,
      candidateId: girl.candidateId,
      role: spec.role,
      goal: spec.goal,
      state: "spawning",
      parentAgentId: "eve",
      depth: MAX_DEPTH,
      startedAt: Date.now(),
    };
    this.agents.set(agent.id, agent);
    this.deps.bus.emit(
      "swarm.spawn",
      {
        taskId,
        agentId: agent.id,
        role: spec.role,
        label: `${mode.emoji} ${agent.name.toUpperCase()} · ${mode.title}`,
        parentId: "eve",
        name: agent.name,
        emoji: mode.emoji,
        goal: spec.goal,
        candidateId: girl.candidateId,
      },
      SRC,
    );
    void this.deps.mirror?.spawn(agent);
    return agent;
  }

  setState(a: HaremAgent, state: SwarmAgentState, extra: { tool?: string; confidence?: number } = {}) {
    a.state = state;
    if (extra.tool !== undefined) a.tool = extra.tool;
    this.deps.bus.emit("swarm.status", { taskId: a.taskId, agentId: a.id, state, ...extra }, SRC);
    void this.deps.mirror?.status(a);
  }

  progress(a: HaremAgent, text: string) {
    a.lastText = text;
    this.deps.bus.emit("swarm.progress", { taskId: a.taskId, agentId: a.id, text }, SRC);
    void this.deps.mirror?.progress(a, text);
  }

  async execute(a: HaremAgent, task: HaremTask, shared: string, signal?: AbortSignal): Promise<HaremAgent> {
    const mode = WIVES[a.role];
    this.setState(a, "assigned");
    this.setState(a, "working");
    this.progress(a, mode.idle);
    try {
      const result = await this.brain.structured<Record<string, unknown>>({
        agent: `${task.taskId}:${a.role}`,
        system: wifeSystem(mode.system, mode.name, a),
        prompt: `Overall task (Eve's): ${task.goal}\nYour slice: ${a.goal}\n\nShared context:\n${shared}`,
        schema: mode.schema,
        tools: mode.tools,
        signal,
        onEvent: (ev) => {
          if (ev.kind === "tool") {
            this.setState(a, "working", { tool: ev.name });
            this.progress(a, ev.detail ? `${ev.name}: ${ev.detail}` : ev.name);
          } else {
            this.progress(a, ev.text.length > 140 ? `${ev.text.slice(0, 137)}...` : ev.text);
          }
        },
      });
      a.result = { ...result, type: RESULT_TYPE[a.role] } as unknown as WifeResult;
      a.endedAt = Date.now();
      this.setState(a, "done", { confidence: Number(result.confidence ?? 0.5) });
      this.deps.bus.emit("swarm.done", { taskId: a.taskId, agentId: a.id, ok: true, result: JSON.stringify(a.result) }, SRC);
    } catch (err) {
      a.error = String((err as Error)?.message ?? err);
      a.endedAt = Date.now();
      this.setState(a, "failed");
      this.deps.bus.emit("swarm.done", { taskId: a.taskId, agentId: a.id, ok: false, result: a.error }, SRC);
    }
    void this.deps.mirror?.done(a);
    return a;
  }

  async terminate(a: HaremAgent) {
    this.setState(a, "despawned");
    void this.deps.mirror?.despawn(a);
    this.agents.delete(a.id);
  }
}

/** The entry point core's agency module calls. Emits swarm.* and task.done, resolves {ok, summary}. */
export async function executeWithHarem(task: HaremTask, deps: HaremDeps): Promise<HaremOutcome> {
  const t0 = Date.now();
  if (!deps.mirror && process.env.HAREM_OPENSWARM === "1") deps = { ...deps, mirror: await openSwarmMirror() };
  const { bus } = deps;
  const brain = deps.brain ?? new ClaudeCliBrain();
  const harem = new HaremManager({ ...deps, brain });
  const beat = (ms: number) => sleep(ms * (deps.pace ?? 1));

  const finish = (o: Omit<HaremOutcome, "plan"> & { plan?: Plan }): HaremOutcome => {
    bus.emit("task.done", { taskId: task.taskId, ok: o.ok, summary: o.summary, ms: Date.now() - t0 }, SRC);
    return { plan: o.plan ?? { mode: "DO_MYSELF", confidence: 0, workers: [] }, ...o };
  };

  let plan: Plan;
  try {
    plan = await planTask(task, brain);
  } catch (err) {
    return finish({ ok: false, summary: `planner failed: ${(err as Error).message}`, agents: [], conflicts: [] });
  }
  bus.emit("swarm.plan", { taskId: task.taskId, mode: plan.mode, confidence: plan.confidence, workers: plan.workers }, SRC);
  if (plan.mode === "DO_MYSELF" || plan.mode === "ASK_USER" || plan.workers.length === 0) {
    return finish({ ok: false, summary: plan.mode === "ASK_USER" ? "need more detail" : "not a harem task", plan, agents: [], conflicts: [] });
  }

  const shared = await sharedContext(task, deps);
  const cast = assignCandidates(
    task.taskId,
    plan.workers.map((w) => w.role),
  );
  const wives = plan.workers.map((w, i) => harem.spawn(task.taskId, w, cast[i]));
  await beat(350);
  await Promise.all(wives.map((w) => harem.execute(w, task, shared)));

  const findings = collect(wives);
  const conflicts = detectConflicts(findings);
  for (const c of conflicts) {
    bus.emit("swarm.conflict", { taskId: task.taskId, conflictId: c.id, topic: c.topic, a: c.a, b: c.b, lines: c.lines }, SRC);
    const a = wives.find((w) => w.id === c.a)!;
    const b = wives.find((w) => w.id === c.b)!;
    void deps.mirror?.conflict(c, a, b);
    await beat(1400);
  }

  const pick = choose(findings);
  if (conflicts.length) {
    const line = eveResolveLine(conflicts);
    for (const c of conflicts) {
      c.resolution = pick ? `${line} ${pick.option.name}.` : line;
      c.winner = conflictWinner(c, pick, findings);
      bus.emit("swarm.resolve", { taskId: task.taskId, conflictId: c.id, text: c.resolution, ...(c.winner ? { winner: c.winner } : {}) }, SRC);
    }
    await beat(900);
  }

  // Merge: only distilled decisions go to memory, never raw scrape or tool chatter.
  const retained = distill(pick, findings, conflicts);
  for (const w of wives) harem.setState(w, "merging");
  bus.emit("swarm.merge", { taskId: task.taskId, agentIds: wives.map((w) => w.id), retained, discarded: wives.length }, SRC);
  await beat(900);
  for (const w of wives) await harem.terminate(w);

  const failed = wives.filter((w) => w.state === "failed" || w.error);
  if (!pick) {
    const why = failed.length ? `${failed.map((w) => w.name).join(" and ")} came back empty` : "nothing fit";
    return finish({ ok: false, summary: `Couldn't pin tonight down, ${why}.`, plan, agents: wives, conflicts });
  }

  // Side effects go through the permissions module. We ask, we never do.
  const actionId = newId("act");
  bus.emit(
    "action.request",
    {
      actionId,
      taskId: task.taskId,
      kind: "calendar.create",
      permission: "EXTERNAL_SIDE_EFFECT",
      description: `put ${pick.option.name} at ${pick.start} on the calendar`,
      args: { title: `${pick.option.name}${pick.option.dish ? ` (${pick.option.dish})` : ""}`, start: pick.start, durationMin: 90, location: pick.option.name },
      needsApproval: true,
    },
    SRC,
  );
  const approval = await bus.once("action.approval", (e) => e.data.actionId === actionId, deps.approvalTimeoutMs ?? 30_000);
  const approved = approval ? approval.data.approved : null;
  const base = eveSummary(pick);
  const summary = approved ? `${base} Done.` : approved === false ? `${base} Not booking it then.` : `${base} Want it on the calendar?`;
  return finish({ ok: true, summary, plan, agents: wives, conflicts, choice: pick, action: { actionId, approved } });
}

let swarmMirror: Promise<HaremMirror | undefined> | null = null;
/** HAREM_OPENSWARM=1: mirror wives into Open Swarm cards. Never blocks or fails the task if Open Swarm is down. */
function openSwarmMirror(): Promise<HaremMirror | undefined> {
  swarmMirror ??= Promise.race([
    import("./openswarm").then((m) => m.OpenSwarmMirror.connect(process.env.HAREM_OPENSWARM_DASHBOARD ?? "Eve's Harem") as Promise<HaremMirror>),
    sleep(2000).then(() => {
      throw new Error("timed out");
    }),
  ]).catch((err) => {
    console.error("[harem] open swarm mirror off:", (err as Error).message);
    swarmMirror = null;
    return undefined;
  });
  return swarmMirror;
}

/** Her archetype prompt, re-voiced as the girl she is today. */
export function wifeSystem(system: string, archetype: string, a: Pick<HaremAgent, "name" | "candidateId">): string {
  const c = candidateById(a.candidateId);
  if (!c) return system;
  return `${system.replace(`You are ${archetype},`, `You are ${a.name},`)}\n${personaBlock(c)}`;
}

function distill(pick: ReturnType<typeof choose>, f: ReturnType<typeof collect>, conflicts: Conflict[]): string[] {
  const out: string[] = [];
  if (pick) out.push(`chose ${pick.option.name} (${pick.option.dish ?? "dinner"}, $${pick.option.cost}, ${pick.option.distanceMinutes} min) for ${pick.start}`);
  const top = f.food?.result.options[0];
  if (top && pick && top.name !== pick.option.name) out.push(`passed on ${top.name} at $${top.cost}`);
  if (f.budget) out.push(`tonight's budget cap: $${f.budget.result.maxRecommendedSpend}`);
  if (pick?.relaxed) out.push(`nothing fit every constraint, relaxed ${pick.relaxed}`);
  if (conflicts.length) out.push(`${conflicts.length} harem disagreement(s): ${conflicts.map((c) => c.topic).join(", ")}`);
  return out;
}

async function sharedContext(task: HaremTask, deps: HaremDeps): Promise<string> {
  const now = new Date();
  const schedule = deps.schedule ? await deps.schedule() : defaultSchedule();
  return [
    `- now: ${now.toLocaleString("en-US", { weekday: "long", hour: "numeric", minute: "2-digit" })}`,
    `- main agent: Eve`,
    `- tonight's schedule: ${schedule}`,
    task.context.trim(),
  ]
    .filter(Boolean)
    .join("\n");
}

function defaultSchedule(): string {
  const f = join(process.env.EVE_HOME ?? join(homedir(), ".eve"), "calendar.json");
  if (existsSync(f)) {
    try {
      return readFileSync(f, "utf8").trim();
    } catch {}
  }
  return "no calendar connected, user said they are free after 19:00";
}
