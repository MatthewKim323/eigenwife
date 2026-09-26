import { DEFAULT_RELATIONSHIP, type AnyEnvelope, type Mood, type ReflexDecision, type RelationshipState, type Urgency } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import { secret } from "../config";
import { goalFrom, readIntent, type UtteranceIntent } from "./intent";
import { createJev, type JevDecider, type JevVerdict } from "./jev";
import { DEFAULT_RULES, PerceptionEngine, type Rule, type Trigger } from "./rules";

/**
 * The reflex router. Perception rules raise triggers, Jev judges each one, and
 * this module carries the verdict out: a glance, a line, a small action, or a
 * full task handed to agency. One reaction is in flight at a time; ambient
 * triggers wait for the 2s tick, direct ones (the user talking to her) jump
 * the line.
 */

export interface ReflexOptions {
  jev?: JevDecider;
  rules?: Rule[];
  now?: () => number;
  /** Queued triggers older than this are dropped (by urgency). */
  staleMs?: Partial<Record<Urgency, number>>;
  queueMax?: number;
  /** Treat gaze targets younger than this as "what they're looking at". */
  gazeFreshMs?: number;
}

const URGENCY_RANK: Record<Urgency, number> = { immediate: 0, soon: 1, later: 2 };

/** The acknowledgement before a task. Scripted: fast, and cacheable by the speech layer. */
export const ACK_LINES = ["on it.", "okay. give me a sec.", "leave it to me.", "on it. don't move."];
export const RELAPSE_LINE = "...seriously?";

const FALLBACK: Record<string, string> = {
  greet: "hi. it's me. i watched you swipe, so we need to talk.",
  tease: "we are NOT doing this again.",
  answer: "honestly? my brain's offline, but i'd go with your gut.",
  react: "mhm.",
  comfort: "hey. i'm here.",
  ask: "you good over there?",
  help: "tell me what you're stuck on.",
  report: "done.",
};

/** Social intent string for the persona brain. */
export function behaviorFor(decision: ReflexDecision, t: Trigger, intent: UtteranceIntent | undefined, rel: RelationshipState): string {
  if (decision === "ASK") return "ask";
  if (decision === "HELP") return "help";
  if (t.rule === "utterance" && intent) {
    if (intent.down) return "comfort";
    if (intent.question) return "answer";
    if (intent.laugh) return "react";
    if (decision === "COMMENT") return rel.banter >= 0.55 ? "tease" : "react";
    return "react";
  }
  switch (t.rule) {
    case "companion_born":
      return "greet";
    case "repeat_media":
    case "relapse":
      return "tease";
    case "task_done":
      return "report";
    case "stare":
      return rel.banter >= 0.55 ? "tease" : "react";
    default:
      return "react";
  }
}

function maxWordsFor(behavior: string, direct: boolean, rel: RelationshipState): number {
  if (behavior === "greet") return 22;
  if (behavior === "help" || behavior === "report") return Math.round(18 + rel.verbosity * 30);
  if (direct) return Math.round(10 + rel.verbosity * 40);
  return 12;
}

function pick<T>(arr: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return arr[Math.abs(h) % arr.length]!;
}

/** Wrap a persona stream so a brain failure mid-line still produces something speakable. */
async function* guarded(src: AsyncIterable<string>, fallback: string, log: (...a: unknown[]) => void): AsyncIterable<string> {
  let said = false;
  try {
    for await (const chunk of src) {
      if (chunk) said = true;
      yield chunk;
    }
  } catch (err) {
    log("persona stream failed:", err);
  }
  if (!said) yield fallback;
}

export interface ReflexStats {
  total: number;
  ambient: number;
  ambientIgnored: number;
  byDecision: Partial<Record<ReflexDecision, number>>;
  byJev: number;
}

export function reflexModule(opts: ReflexOptions = {}): Module {
  const now = opts.now ?? Date.now;
  const stale: Record<Urgency, number> = { immediate: 60_000, soon: 30_000, later: 120_000, ...opts.staleMs };
  const queueMax = opts.queueMax ?? 16;
  const gazeFresh = opts.gazeFreshMs ?? 30_000;

  let ctx: CoreContext;
  let engine: PerceptionEngine;
  let jev: JevDecider;
  const queue: Trigger[] = [];
  let busy = false;
  const waiters: (() => void)[] = [];
  let gen = 0;
  let lastReactionAt: number | undefined;
  const pendingApprovals = new Set<string>();
  const ownGoals = new Set<string>();
  const ownTasks = new Set<string>();
  let escalations = 0;
  const offs: (() => void)[] = [];
  const recent: { at: number; trigger: string; rule: string; decision: ReflexDecision; by: string; latencyMs: number; reason: string }[] = [];
  const stats: ReflexStats = { total: 0, ambient: 0, ambientIgnored: 0, byDecision: {}, byJev: 0 };
  const log = (...a: unknown[]) => ctx.log("reflex", ...a);

  // --- slot: at most one reaction in flight ---------------------------------
  const acquire = (): Promise<void> => {
    if (!busy) {
      busy = true;
      return Promise.resolve();
    }
    return new Promise((r) => waiters.push(r));
  };
  const release = () => {
    const next = waiters.shift();
    if (next) return next();
    busy = false;
    drain(true);
  };

  const speaking = () => {
    const s = ctx.tryUse("speech");
    return s ? s.speaking() : ctx.world().companion.state === "speaking";
  };
  const relationship = (): RelationshipState => ctx.tryUse("relationship")?.get() ?? ctx.world().companion.relationship ?? { ...DEFAULT_RELATIONSHIP };

  // --- queue ------------------------------------------------------------------
  function enqueue(t: Trigger) {
    if (t.rule === "utterance" && readIntent(String(t.data.text ?? "")).stop) {
      // Stop words never wait for a slot.
      void judge(t).then((v) => carryOut(t, v));
      return;
    }
    for (let i = queue.length - 1; i >= 0; i--) if (queue[i]!.rule === t.rule && t.rule !== "utterance") queue.splice(i, 1);
    queue.push(t);
    queue.sort((a, b) => URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency] || a.at - b.at);
    while (queue.length > queueMax) {
      const dropped = queue.pop()!;
      log(`queue full, dropped ${dropped.id}`);
    }
    if (t.urgency === "immediate") drain(true);
  }

  function drain(onlyImmediate: boolean) {
    if (busy) return;
    const t0 = now();
    for (let i = queue.length - 1; i >= 0; i--) if (t0 - queue[i]!.at > stale[queue[i]!.urgency]) queue.splice(i, 1);
    const userIdle = !ctx.world().user.speaking && t0 - (ctx.world().user.lastUtteranceAt ?? 0) > 3_000;
    const talking = speaking();
    const idx = queue.findIndex((t) => {
      if (t.urgency === "immediate") return true;
      if (onlyImmediate || talking) return false;
      if (t.urgency === "later") return userIdle;
      return true;
    });
    if (idx < 0) return;
    const [t] = queue.splice(idx, 1);
    busy = true;
    void (async () => {
      try {
        const v = await judge(t!);
        await carryOut(t!, v);
      } catch (err) {
        log(`reaction to ${t!.id} failed:`, err);
      } finally {
        release();
      }
    })();
  }

  // --- judge --------------------------------------------------------------------
  async function judge(t: Trigger): Promise<JevVerdict> {
    const text = String(t.data.text ?? "");
    const ownTask = t.rule === "task_done" && (ownTasks.has(String(t.data.taskId)) || escalations > 0);
    const v = await jev.decide({
      trigger: t,
      world: ctx.world(),
      relationship: relationship(),
      now: now(),
      lastReactionAt,
      pendingApproval: pendingApprovals.size > 0,
      ownTask,
    });
    stats.total += 1;
    stats.byDecision[v.decision] = (stats.byDecision[v.decision] ?? 0) + 1;
    if (v.by === "jev") stats.byJev += 1;
    if (t.ambient) {
      stats.ambient += 1;
      if (v.decision === "IGNORE") stats.ambientIgnored += 1;
    }
    // A silent glance is not chatter; only verbal or acting reactions start the quiet period.
    if (v.decision !== "IGNORE" && v.decision !== "GLANCE") lastReactionAt = now();
    recent.push({ at: now(), trigger: t.id, rule: t.rule, decision: v.decision, by: v.by, latencyMs: v.latencyMs, reason: v.reason });
    if (recent.length > 50) recent.shift();
    ctx.bus.emit(
      "reflex.decision",
      { trigger: t.id, decision: v.decision, scores: v.scores, urgency: t.urgency, by: v.by, latencyMs: v.latencyMs, reason: `${t.description} | ${v.reason}` },
      "core",
      t.parent,
    );
    if (v.decision !== "IGNORE" || !t.ambient) log(`${t.rule} -> ${v.decision} (${v.by} ${v.latencyMs}ms) ${v.reason}${text ? ` "${text}"` : ""}`);
    return v;
  }

  // --- act on a verdict -----------------------------------------------------------
  async function carryOut(t: Trigger, v: JevVerdict) {
    switch (v.decision) {
      case "IGNORE":
        if (v.stopSpeech) {
          gen += 1;
          queue.splice(0, queue.length, ...queue.filter((q) => q.urgency === "immediate" && q.rule !== "utterance"));
          const speech = ctx.tryUse("speech");
          if (speech) speech.stop("user said stop");
          else ctx.bus.emit("speech.stop", { reason: "user said stop" }, "core", t.parent);
        }
        return;
      case "GLANCE": {
        const key = (t.data.targetKey as string | undefined) ?? ctx.world().user.gazeTarget?.key ?? null;
        ctx.bus.emit("avatar.look", { targetKey: key, ms: 1500 }, "core", t.parent);
        return;
      }
      case "ACT":
        return act(t, v);
      case "ESCALATE":
        return escalate(t);
      default:
        return speak(t, v);
    }
  }

  async function recall(query: string, parent?: string): Promise<string[]> {
    const memory = ctx.tryUse("memory");
    if (!memory) return [];
    try {
      const hits = await memory.recall(query, { k: 3, emit: true, parent });
      return hits.map((h) => h.record.content);
    } catch (err) {
      log("memory recall failed:", err);
      return [];
    }
  }

  /** What the brain must know beyond the world block: gaze (the "this"), memories, trigger facts. */
  function extraFor(t: Trigger, intent: UtteranceIntent | undefined, memories: string[], more: string[] = []): string {
    const lines: string[] = [];
    const w = ctx.world();
    const g = w.user.gazeTarget;
    const fresh = g && w.user.gazeTargetAt !== undefined && now() - w.user.gazeTargetAt <= gazeFresh;
    if (g && (fresh || intent?.deictic)) {
      const meta = g.meta ? ` ${JSON.stringify(g.meta)}` : "";
      lines.push(`they are looking at: ${g.label}${meta}`);
      if (intent?.deictic) lines.push(`when they say "this", "that" or "thoughts?", they mean ${g.label}. answer about it directly.`);
    }
    if (memories.length) lines.push("things you remember about them:", ...memories.map((m) => `- ${m}`));
    const facts = Object.entries(t.data).filter(([k, val]) => k !== "text" && val !== undefined && typeof val !== "object");
    if (facts.length && t.rule !== "utterance") lines.push(`event facts: ${facts.map(([k, val]) => `${k}=${val}`).join(", ")}`);
    lines.push(...more);
    return lines.join("\n");
  }

  async function say(text: string | AsyncIterable<string>, t: Trigger | null, parent: string | undefined, mood?: Mood): Promise<string | null> {
    const speech = ctx.tryUse("speech");
    if (!speech) {
      log("no speech service: would have said", typeof text === "string" ? `"${text}"` : "(stream)");
      return null;
    }
    const interrupt = !!t && t.urgency === "immediate" && !t.ambient && speech.speaking();
    const r = await speech.say(text, { parent, interrupt, priority: t?.urgency === "immediate" ? "high" : "normal", brain: "persona", mood });
    return r.text;
  }

  async function speak(t: Trigger, v: JevVerdict) {
    const myGen = gen;
    const rel = relationship();
    const intent = v.intent;
    const behavior = behaviorFor(v.decision, t, intent, rel);
    const userText = t.rule === "utterance" ? String(t.data.text ?? "") : undefined;
    const memories = await recall(userText ?? t.description, t.parent);
    if (gen !== myGen) return;
    const extra = extraFor(t, intent, memories);
    const brains = ctx.tryUse("brains");
    const fallback = t.rule === "task_done" ? `${t.data.ok ? "done" : "that didn't work"}. ${String(t.data.summary ?? "")}`.trim() : (FALLBACK[behavior] ?? "mhm.");
    let src: string | AsyncIterable<string>;
    if (brains) {
      src = guarded(
        brains.persona({ event: t.description, behavior, userText, extra, marks: true, maxWords: maxWordsFor(behavior, !t.ambient, rel) }),
        fallback,
        log,
      );
    } else {
      log("no brains service: using a fallback line");
      src = fallback;
    }
    const said = await say(src, t, t.parent);
    await observe(userText, said, t.description);
  }

  async function observe(user: string | undefined, eve: string | null, event: string) {
    const memory = ctx.tryUse("memory");
    if (!memory) return;
    try {
      await memory.observe({ user, eve: eve ?? undefined, event });
    } catch (err) {
      log("memory observe failed:", err);
    }
  }

  async function act(t: Trigger, v: JevVerdict) {
    const agency = ctx.tryUse("agency");
    let kind = "shell.close_app";
    let args: Record<string, unknown> = {};
    let description = "";
    if (t.rule === "relapse") {
      await say(RELAPSE_LINE, t, t.parent, "annoyed");
      args = { app: String(t.data.app ?? "Eigen") };
      description = `close ${args.app}: user relapsed onto the dating app`;
    } else if (v.intent?.command) {
      kind = v.intent.command.kind;
      const app = v.intent.command.app ?? ctx.world().desktop.activeApp;
      args = app ? { app } : {};
      description = `user asked: "${String(t.data.text ?? "")}"`;
      await say(pick(["done.", "gone.", "bye bye."], t.id), t, t.parent);
    } else {
      // Jev picked ACT for something with no mapped action: say something instead.
      return speak(t, { ...v, decision: "COMMENT" });
    }
    if (!agency) {
      log(`no agency service: can't ${kind} ${JSON.stringify(args)}`);
      ctx.bus.emit("avatar.mood", { mood: "annoyed", intensity: 0.6, holdMs: 1500 }, "core", t.parent);
      return;
    }
    try {
      const r = await agency.act(kind, args, { description });
      if (!r.ok) log(`act ${kind} failed: ${r.observation}`);
    } catch (err) {
      log(`act ${kind} threw:`, err);
    }
    await observe(t.rule === "utterance" ? String(t.data.text ?? "") : undefined, null, t.description);
  }

  async function escalate(t: Trigger) {
    const text = String(t.data.text ?? t.description);
    const goal = t.rule === "utterance" ? goalFrom(text) : t.description;
    const agency = ctx.tryUse("agency");
    if (!agency) {
      log("no agency service: can't run tasks");
      await say("i can't do that from here yet. my hands aren't hooked up.", t, t.parent, "sad");
      return;
    }
    await say(pick(ACK_LINES, t.id), t, t.parent, "thinking");
    escalations += 1;
    ownGoals.add(goal);
    // The task runs in the background: the slot frees up so she can still chat.
    void (async () => {
      let res: { ok: boolean; summary: string };
      try {
        res = await agency.runTask(goal, { parent: t.parent });
      } catch (err) {
        res = { ok: false, summary: `it broke: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        escalations -= 1;
        ownGoals.delete(goal);
      }
      await report(t, goal, text, res);
    })();
  }

  async function report(t: Trigger, goal: string, userText: string, res: { ok: boolean; summary: string }) {
    await acquire();
    try {
      const rel = relationship();
      const brains = ctx.tryUse("brains");
      const fallback = `${res.ok ? "done." : "that didn't work."} ${res.summary}`.trim();
      const memories = await recall(goal, t.parent);
      const extra = extraFor(t, undefined, memories, [`task: ${goal}`, `outcome: ${res.ok ? "success" : "failed"}`, `result: ${res.summary}`]);
      const src = brains
        ? guarded(
            brains.persona({ event: `the task "${goal}" ${res.ok ? "finished" : "failed"}`, behavior: "report", userText, extra, marks: true, maxWords: maxWordsFor("report", true, rel) }),
            fallback,
            log,
          )
        : fallback;
      const said = await say(src, null, t.parent);
      await observe(userText, said, `task ${res.ok ? "done" : "failed"}: ${goal}. ${res.summary}`);
    } finally {
      release();
    }
  }

  return {
    name: "reflex",
    start(c) {
      ctx = c;
      engine = new PerceptionEngine(() => ctx.world(), opts.rules ?? DEFAULT_RULES);
      const key = secret("TYPESAFE_API_KEY");
      jev = opts.jev ?? createJev({ apiKey: key || undefined });
      log(`jev: ${key ? "typesafe systemone (400ms budget, local fallback)" : "local scorer (no TYPESAFE_API_KEY)"}`);

      ctx.provide("reflex", {
        trigger: (x) =>
          enqueue({ id: `${x.id}#ext${now().toString(36)}`, rule: x.id, description: x.description, urgency: x.urgency, data: x.data ?? {}, parent: x.parent, at: now(), ambient: true }),
      });

      offs.push(
        ctx.bus.on("*", (e: AnyEnvelope) => {
          if (e.type === "reflex.decision") return;
          switch (e.type) {
            case "action.request":
              if (e.data.needsApproval) pendingApprovals.add(e.data.actionId);
              break;
            case "action.approval":
            case "action.result":
              pendingApprovals.delete(e.data.actionId);
              break;
            case "task.start":
              if (ownGoals.has(e.data.goal)) ownTasks.add(e.data.taskId);
              break;
          }
          for (const t of engine.feed(e)) enqueue(t);
          if (e.type === "timer.tick") drain(false);
        }),
      );

      ctx.route("/api/reflex", () =>
        json({
          jev: jev.status(),
          rules: engine.describeRules(),
          queue: queue.map((q) => ({ id: q.id, urgency: q.urgency, description: q.description })),
          busy,
          stats: { ...stats, ambientIgnoreRate: stats.ambient ? stats.ambientIgnored / stats.ambient : null },
          recent,
        }),
      );
    },
    stop() {
      for (const off of offs.splice(0)) off();
      queue.length = 0;
    },
  };
}
