import { describeOutfit, DEFAULT_RELATIONSHIP, envelope, WARDROBE_ITEMS, type AnyEnvelope, type Mood, type ReflexDecision, type RelationshipState, type Urgency } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import type { OnboardingService } from "../services";
import { json } from "../hub";
import { jevEndpoint, secret } from "../config";
import { goalFrom, readIntent, splitActions, type UtteranceIntent } from "./intent";
import type { OutfitIntent } from "./outfit";
import { createJev, type JevDecider, type JevVerdict } from "./jev";
import { DEFAULT_RULES, PerceptionEngine, type Rule, type Trigger } from "./rules";
import { screenDeictic } from "../screen/intent";
import { VoiceRouter, type RouterTrigger } from "../talker/router";
import { CANCEL_LINES } from "../speech/lines";

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
  /** Wait this long after a voice.final for him to keep talking before it's a turn (0 = immediate). */
  turnMs?: number;
  /** Talker router overrides (tests: gap timing, narrator). */
  router?: Partial<Pick<import("../talker/router").RouterDeps, "gapQuietMs" | "gapMaxMs" | "narrator" | "sleep" | "speculateMs">>;
}

const URGENCY_RANK: Record<Urgency, number> = { immediate: 0, soon: 1, later: 2 };

/** The acknowledgement before a task. Scripted: fast, and cacheable by the speech layer. */
export const ACK_LINES = ["on it.", "okay. give me a sec.", "leave it to me.", "on it. don't move."];
// Same text as the speech module's scripted lines, so the pre-rendered audio is a cache hit.
export const MUSIC_LINES = ["[mood:happy 0.7] ooh. okay. our song.", "[mood:smug 0.6] finally, taste.", "[mood:happy 0.6] bet. turning it up."];
export const RELAPSE_LINE = "[mood:annoyed 0.8] ...seriously?";
export const BIRTH_LINE = "[mood:smug 0.6] so. apparently this is your type.";
/** Woken on the desktop without Act I: no "your type" joke, she just moves in. */
export const WAKE_LINE = "[mood:happy 0.6] hey. i live on your desktop now. don't mind me.";

/** Said before a level 3 look (docs/SCREEN.md), so the few seconds of looking aren't dead air. */
export const LOOK_LINES = ["hm. lemme see.", "ooh. let me look.", "hold on, looking."];
/** A yes / no to her "want me to look?" offer about a stuck error. */
const OFFER_YES = /^(?:yeah|yea|ya|yes|yep|yup|sure|ok(?:ay)?|please|pls|do it|go (?:for it|ahead)|help(?: me)?|look at it|take a look|fix it|bet|that'?d be (?:great|nice))\b(?!.*\b(?:no|nah|don'?t)\b)/i;
const OFFER_NO = /^(?:nah|no|nope|don'?t|i'?m good|not now|i got it|i'?ve got it|all good)\b/i;

/** Poked 3+ times: scripted (fast, cacheable), never improvised. */
export const POKE_LINES = ["[mood:annoyed 0.7] okay. stop poking me.", "[mood:annoyed 0.7] i'm not a button.", "[mood:annoyed 0.6] hey. hands off."];

const labels = (ids: string[]) => ids.map((id) => WARDROBE_ITEMS[id]?.label ?? id).join(", ");

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

/** The talker answers real questions properly (up to three short sentences). */
function talkerWordsFor(behavior: string, rel: RelationshipState): number {
  if (behavior === "answer" || behavior === "help") return Math.round(35 + rel.verbosity * 20);
  return Math.round(14 + rel.verbosity * 36);
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
  /** Her open "want me to look?" about an error on screen, and the one he just said yes to. */
  let screenOffer: { until: number; error: string; app: string } | null = null;
  let acceptedOffer: { error: string; app: string } | null = null;
  const offs: (() => void)[] = [];
  const recent: { at: number; trigger: string; rule: string; decision: ReflexDecision; by: string; latencyMs: number; reason: string }[] = [];
  const stats: ReflexStats = { total: 0, ambient: 0, ambientIgnored: 0, byDecision: {}, byJev: 0 };
  const log = (...a: unknown[]) => ctx.log("reflex", ...a);
  /** Talker/thinker routing (docs/VOICE.md). */
  let router: VoiceRouter;

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
    // Onboarding (docs/KNOW_ME.md): while a question is out every utterance is
    // the answer, "redo onboarding" starts it over, and ambient reactions wait.
    const ob = ctx.tryUse("onboarding");
    if (ob && t.rule === "utterance") {
      const text = String(t.data.text ?? "");
      if (ob.active() || ob.claims(text)) return toOnboarding(t, text, ob);
    }
    if (t.ambient && ob?.active()) return;
    if (t.rule === "utterance") {
      const text = String(t.data.text ?? "");
      // "never mind" while she's off looking something up: drop the job, not just the line.
      if (router.active && router.isCancel(text)) return cancelJobs(t, text);
      if (!readIntent(text).stop) prestart(t, text);
    }
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

  // --- talker: start in parallel with Jev ---------------------------------------
  /** Asks the local intent reader already maps to an action: those never need a talker reply. */
  function talkerSkips(text: string): boolean {
    const it = readIntent(text);
    if (it.approval && pendingApprovals.size) return true;
    if (it.outfit || it.music || it.browse || it.command || it.task || it.work) return true;
    if (screenOffer || ctx.tryUse("work")?.awaiting()) return true;
    // An answer to her pending follow-up ("the second one", "yeah") goes to followup, not a fresh reply.
    if (ctx.tryUse("followup")?.claims(text)) return true;
    // Screen questions need a look first (speak() does it, then starts the talker).
    if (ctx.tryUse("screen") && screenDeictic(text)) return true;
    return false;
  }

  /** Gaze, memories (150ms budget), and thinker state for a talker prompt. */
  async function talkerExtra(t: Trigger, text: string): Promise<string> {
    const memories = await quickRecall(text, t.parent);
    return extraFor(t, readIntent(text), memories, router.context());
  }

  /**
   * Memories for a talker prompt without delaying its first token: whatever
   * recall returns within 150ms (local name hits are sub-ms), and hits that
   * land later (an embedding call) are folded into the next turn's prompt.
   */
  let lateMemories: { text: string; at: number }[] = [];
  async function quickRecall(text: string, parent?: string): Promise<string[]> {
    let late = false;
    const full = recall(text, parent).then((hits) => {
      if (late && hits.length) {
        const known = new Set(lateMemories.map((m) => m.text));
        lateMemories = [...lateMemories, ...hits.filter((h) => !known.has(h)).map((h) => ({ text: h, at: now() }))].slice(-6);
      }
      return hits;
    });
    const got = await Promise.race([full, Bun.sleep(150).then(() => null)]);
    if (got === null) late = true;
    const carried = lateMemories.filter((m) => now() - m.at < 5 * 60_000).map((m) => m.text);
    lateMemories = [];
    return [...new Set([...(got ?? []), ...carried])];
  }

  function prestart(t: Trigger, text: string) {
    if (!router.usable() || talkerSkips(text)) return;
    router.prestart({ id: t.id, text, parent: t.parent }, () => talkerExtra(t, text));
  }

  function cancelJobs(t: Trigger, text: string) {
    router.cancel(text);
    gen += 1;
    stats.total += 1;
    ctx.bus.emit("reflex.decision", { trigger: t.id, decision: "REACT", scores: { REACT: 1 }, urgency: t.urgency, by: "local", latencyMs: 0, reason: `${t.description} | cancel thinker` }, "core", t.parent);
    log(`utterance -> cancel "${text}"`);
    ctx.bus.emit("conversation.turn", { role: "user", text }, "core", t.parent);
    void say(pick([...CANCEL_LINES], t.id), t, t.parent, "neutral", true);
  }

  function toOnboarding(t: Trigger, text: string, ob: OnboardingService) {
    stats.total += 1;
    stats.byDecision.COMMENT = (stats.byDecision.COMMENT ?? 0) + 1;
    lastReactionAt = now();
    const reason = `${t.description} | onboarding answer`;
    recent.push({ at: now(), trigger: t.id, rule: t.rule, decision: "COMMENT", by: "local", latencyMs: 0, reason: "onboarding" });
    if (recent.length > 50) recent.shift();
    ctx.bus.emit("reflex.decision", { trigger: t.id, decision: "COMMENT", scores: { COMMENT: 1 }, urgency: t.urgency, by: "local", latencyMs: 0, reason }, "core", t.parent);
    log(`utterance -> onboarding "${text}"`);
    void ob.hear(text, t.parent).catch((err) => log("onboarding failed:", err));
  }

  function drain(onlyImmediate: boolean) {
    if (busy) return;
    const t0 = now();
    for (let i = queue.length - 1; i >= 0; i--)
      if (t0 - queue[i]!.at > stale[queue[i]!.urgency]) {
        router.drop(queue[i]!.id, "stale");
        queue.splice(i, 1);
      }
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
    let v = await jev.decide({
      trigger: t,
      world: ctx.world(),
      relationship: relationship(),
      now: now(),
      lastReactionAt,
      pendingApproval: pendingApprovals.size > 0,
      ownTask,
    });
    // She asked a work question ("which repo?"): the next thing he says is the answer.
    if (t.rule === "utterance" && !v.stopSpeech && pendingApprovals.size === 0 && v.decision !== "ESCALATE" && ctx.tryUse("work")?.awaiting())
      v = { ...v, decision: "ESCALATE", reason: `${v.reason}; answering her work question` };
    // She's waiting on a next step ("which one?", "want 7:30?"): his answer goes through work -> followup (docs/FOLLOW_THROUGH.md).
    if (t.rule === "utterance" && !v.stopSpeech && pendingApprovals.size === 0 && v.decision !== "ESCALATE" && ctx.tryUse("followup")?.claims(text))
      v = { ...v, decision: "ESCALATE", reason: `${v.reason}; answering her follow-up` };
    // She offered to look at a stuck error: "yeah" hands it to work mode, "nah" drops it.
    if (t.rule === "utterance" && !v.stopSpeech && screenOffer) {
      if (now() > screenOffer.until) screenOffer = null;
      else if (pendingApprovals.size === 0 && OFFER_YES.test(text.trim())) {
        acceptedOffer = { error: screenOffer.error, app: screenOffer.app };
        screenOffer = null;
        v = { ...v, decision: "ESCALATE", reason: `${v.reason}; yes to her screen help offer` };
      } else if (OFFER_NO.test(text.trim())) screenOffer = null;
    }
    stats.total += 1;
    stats.byDecision[v.decision] = (stats.byDecision[v.decision] ?? 0) + 1;
    if (v.by === "jev") stats.byJev += 1;
    if (t.ambient) {
      stats.ambient += 1;
      if (v.decision === "IGNORE") stats.ambientIgnored += 1;
    }
    // A silent glance is not chatter; only verbal or acting reactions start the quiet period.
    if (v.decision !== "IGNORE" && v.decision !== "GLANCE") lastReactionAt = now();
    // What he says TO her becomes part of the conversation she remembers (room chatter doesn't).
    if (t.rule === "utterance" && v.decision !== "IGNORE" && typeof t.data.text === "string")
      ctx.bus.emit("conversation.turn", { role: "user", text: t.data.text }, "core", t.parent);
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
    // Jev in parallel with the talker: anything but a spoken reply kills the prestarted stream.
    if (t.rule === "utterance" && !(v.decision === "REACT" || v.decision === "COMMENT" || v.decision === "ASK" || v.decision === "HELP")) router.drop(t.id, v.decision);
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

  async function say(text: string | AsyncIterable<string>, t: Trigger | null, parent: string | undefined, mood?: Mood, forceInterrupt = false, brain = "persona"): Promise<string | null> {
    const speech = ctx.tryUse("speech");
    if (!speech) {
      log("no speech service: would have said", typeof text === "string" ? `"${text}"` : "(stream)");
      return null;
    }
    const interrupt = forceInterrupt ? speech.speaking() : !!t && t.urgency === "immediate" && !t.ambient && speech.speaking();
    const r = await speech.say(text, { parent, interrupt, priority: t?.urgency === "immediate" ? "high" : "normal", brain, mood });
    return r.text;
  }

  async function speak(t: Trigger, v: JevVerdict) {
    // Her first words belong to onboarding when it's about to run (it greets and asks).
    if (t.rule === "companion_born" && ctx.tryUse("onboarding")?.pending()) {
      log("born: onboarding takes her first words");
      return;
    }
    const myGen = gen;
    const rel = relationship();
    const intent = v.intent;
    const behavior = behaviorFor(v.decision, t, intent, rel);
    const userText = t.rule === "utterance" ? String(t.data.text ?? "") : undefined;
    // He named someone she doesn't know yet and gbrain is still looking (docs/KNOW_ME.md):
    // give it ~600ms to land in local memory; past that, she covers and it's there next turn.
    // null = a stop word arrived while waiting.
    const missFor = async (): Promise<string[] | null> => {
      const lookup = userText ? ctx.tryUse("memory")?.pending?.(userText) : null;
      if (!lookup) return [];
      const landed = await lookup.settle(600);
      if (gen !== myGen) return null;
      return landed === null
        ? [`you don't remember "${lookup.term}" yet (it's on the tip of your tongue). don't make anything up about it: cover naturally, like "wait... ${lookup.term.toLowerCase()}? remind me" or keep it vague.`]
        : [];
    };
    // He talked to her: the talker answers (and delegates what needs tools). docs/VOICE.md
    if (userText !== undefined && router.usable()) {
      let extra = "";
      if (!router.prestarted(t.id)) {
        const missLines = await missFor();
        if (missLines === null) return router.drop(t.id, "stopped");
        const memories = await quickRecall(userText, t.parent);
        if (gen !== myGen) return;
        const screenLines = await screenContext(t, userText, myGen);
        if (screenLines === null || gen !== myGen) return router.drop(t.id, "stopped");
        extra = extraFor(t, intent, memories, [...screenLines, ...missLines, ...router.context()]);
      }
      if (gen !== myGen) return router.drop(t.id, "stopped");
      const said = await router.respond(
        { id: t.id, text: userText, parent: t.parent },
        { userText, event: t.description, behavior, extra, maxWords: talkerWordsFor(behavior, rel), fallback: FALLBACK[behavior] ?? "mhm." },
        t.urgency === "immediate" && !t.ambient,
      );
      if (said !== null) {
        // Off the slot: memory.observe can be an LLM call, and the next turn shouldn't wait on it.
        void observe(userText, said, t.description);
        return;
      }
    }
    const missLines = await missFor();
    if (missLines === null) return;
    const memories = await recall(userText ?? t.description, t.parent);
    if (gen !== myGen) return;
    const screenLines = await screenContext(t, userText, myGen);
    if (screenLines === null || gen !== myGen) return;
    const extra = extraFor(t, intent, memories, [...screenLines, ...missLines]);
    const brains = ctx.tryUse("brains");
    const fallback =
      t.rule === "task_done"
        ? `${t.data.ok ? "done" : "that didn't work"}. ${String(t.data.summary ?? "")}`.trim()
        : t.rule === "screen_stuck"
          ? `that error's been up ${String(t.data.stuckMin ?? "a few")} minutes. want me to look?`
          : (FALLBACK[behavior] ?? "mhm.");
    let src: string | AsyncIterable<string>;
    if (t.rule === "poked") {
      src = pick(POKE_LINES, t.id);
    } else if (t.rule === "companion_born" && t.data.woken) {
      src = WAKE_LINE;
    } else if (t.rule === "companion_born" && ctx.config.demo) {
      // The birth line is the demo's biggest laugh: scripted, pre-rendered, never improvised.
      src = BIRTH_LINE;
    } else if (brains) {
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
    // Several actions in one breath ("pajamas on and play some music"): do each, in order.
    if (t.rule === "utterance" && !t.data.multiPart) {
      const parts = splitActions(String(t.data.text ?? ""));
      if (parts.length >= 2) {
        log(`multi-action: ${parts.map((p) => p.kind).join(" + ")}`);
        for (const p of parts) {
          await act({ ...t, data: { ...t.data, text: p.text, multiPart: true } }, { ...v, intent: p.intent });
        }
        return;
      }
    }
    const agency = ctx.tryUse("agency");
    let kind = "shell.close_app";
    let args: Record<string, unknown> = {};
    let description = "";
    if (t.rule === "relapse") {
      // The punchline cuts off whatever she was saying.
      await say(RELAPSE_LINE, t, t.parent, "annoyed", true);
      args = { app: String(t.data.app ?? "Eigen") };
      description = `close ${args.app}: user relapsed onto the dating app`;
    } else if (v.intent?.outfit) {
      return outfit(t, v.intent.outfit);
    } else if (v.intent?.music) {
      const mu = v.intent.music;
      if (mu.op === "play") {
        kind = "music.play";
        args = mu.query ? { query: mu.query } : { query: "our song" };
        description = mu.query ? `play ${mu.query}` : "play our song";
        await say(pick(mu.query ? ["okay. one sec.", "bet.", "fine. putting it on."] : MUSIC_LINES, t.id), t, t.parent, "happy");
      } else {
        kind = "music.control";
        args = { op: mu.op };
        description = `${mu.op} the music`;
        if (mu.op !== "pause") await say(pick(["mm.", "okay.", "next."], t.id), t, t.parent);
      }
    } else if (v.intent?.browse) {
      // "show me" / "do it yourself" / "open it": she does it in her own visible browser.
      const q = v.intent.browse.query;
      kind = "browser.task";
      args = q ? { query: q, maps: /\b(?:restaurants?|places?|spots?|near|open now|food)\b/i.test(q), goal: `show you ${q}` } : { goal: "show you" };
      description = q ? `show you ${q} in my browser` : "show you in my browser";
      await say(pick(["okay, watch.", "look.", "fine, i'll do it. watch."], t.id), t, t.parent, "happy");
    } else if (v.intent?.command) {
      // The dating app lives in the shell (shell.close_app); anything else is a real macOS app (app.quit).
      const app = v.intent.command.app ?? ctx.world().desktop.activeApp;
      const inShell = !app || /^eigen\b|dating/i.test(app);
      kind = inShell ? "shell.close_app" : "app.quit";
      args = app ? { app: inShell ? "Eigen" : app } : {};
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
      if (!r.ok && kind === "browser.task")
        await say(/open what/i.test(r.observation) ? "open what? i haven't found anything yet." : "my browser didn't cooperate.", t, t.parent, "sad");
    } catch (err) {
      log(`act ${kind} threw:`, err);
    }
    await observe(t.rule === "utterance" ? String(t.data.text ?? "") : undefined, null, t.description);
  }

  /** Outfit requests: change first (she's visibly changing), then one short in-character line. */
  async function outfit(t: Trigger, o: OutfitIntent) {
    const userText = String(t.data.text ?? "");
    const w = ctx.tryUse("wardrobe");
    if (!w) {
      await say("my closet isn't hooked up right now.", t, t.parent, "sad");
      return;
    }
    const avail = w.available();
    const have = avail.length ? labels(avail) : "nothing, just these clothes";
    const facts: string[] = [];
    let fallback = "there.";
    let mood: Mood = "happy";
    const wearing = () => describeOutfit(w.get().items);
    const wear = async (change: { add?: string[]; remove?: string[] | "all" }, fb: string) => {
      const r = await w.wear(change, "user");
      if (!r.changed && r.unavailable.length) {
        facts.push(`they asked you to put on: ${labels(r.unavailable)}. you can't in this body right now.`, `what you can wear: ${have}`);
        fallback = avail.length ? `can't do that one. i've got ${have}.` : "i only have what i'm wearing, sorry.";
        mood = "sad";
      } else if (!r.changed) {
        facts.push("nothing changed: it was already like that.");
        fallback = change.add?.length ? "already on. keep up." : "i'm not even wearing that.";
        mood = "smug";
      } else {
        fallback = fb;
      }
      facts.push(`you are now wearing: ${wearing()}`);
    };
    switch (o.kind) {
      case "ask":
        facts.push(`you are wearing: ${wearing()}`, `your wardrobe: ${have}`);
        fallback = w.get().items.length ? `${wearing()}. obviously.` : "just my usual. want me to change?";
        mood = "smug";
        break;
      case "wear":
        facts.push(`they asked you to put on: ${labels(o.add)}.`);
        await wear({ add: o.add }, pick(["there. happy?", "better?", "okay, how's this?"], t.id));
        break;
      case "remove":
        facts.push(`they asked you to take off: ${o.remove === "all" ? "everything extra, back to normal" : labels(o.remove)}.`);
        await wear({ remove: o.remove }, pick(["fine. back to normal.", "okay, off.", "there. plain me."], t.id));
        break;
      case "change": {
        const top = w.get().items.some((id) => WARDROBE_ITEMS[id]?.slot === "top");
        facts.push(top ? "they asked you to change: you took the hoodie off." : "they asked you to change: you picked your cat hoodie.");
        await wear(top ? { remove: "all" } : { add: ["hoodie"] }, top ? "okay, back to normal." : "hoodie time.");
        break;
      }
      case "missing":
        facts.push(`they asked you to wear a ${o.want}. you don't have one.`, `what you do have: ${have}`);
        fallback = avail.length ? `i don't own a ${o.want}. i've got ${have}.` : `i don't own a ${o.want}. this is all i've got.`;
        mood = "sad";
        break;
    }
    facts.push("one short line, in character. only mention clothes listed above, never invent others.");
    const brains = ctx.tryUse("brains");
    const src = brains
      ? guarded(brains.persona({ event: t.description, behavior: "react", userText, extra: extraFor(t, undefined, [], facts), marks: true, maxWords: 16 }), fallback, log)
      : fallback;
    const said = await say(src, t, t.parent, mood);
    await observe(userText, said, t.description);
  }

  /**
   * What the screen adds to a reply (docs/SCREEN.md): a level 3 look for a
   * deictic question in another app, the error (and a look) for a stuck
   * offer, the summary for an interesting remark. null = a stop word
   * arrived while she was looking; drop the reply.
   */
  /** Questions only a picture answers: these get the (slower) screenshot look. */
  const VISUAL_ASK = /\b(?:look|looks|rate|fire|mid|cute|ugly|pretty|fit|outfit|drip|picture|pic|photo|image|video|design|color|colour|thumbnail|meme|see this|see that)\b/i;
  const freshText = (cur: { summary?: string; private?: boolean; at?: number } | null | undefined) =>
    !!cur && !cur.private && !!cur.summary && cur.summary.length > 20 && cur.at !== undefined && now() - cur.at < 20_000;

  async function screenContext(t: Trigger, userText: string | undefined, myGen: number): Promise<string[] | null> {
    const screen = ctx.tryUse("screen");
    if (!screen) return [];
    const lines: string[] = [];
    const w = ctx.world();
    const gazeFreshNow = !!w.user.gazeTarget && w.user.gazeTargetAt !== undefined && now() - w.user.gazeTargetAt <= gazeFresh;
    if (userText && screenDeictic(userText) && !gazeFreshNow && !screen.canLook()) {
      // Asked about the screen but she can't look: say why instead of answering blind.
      const why = screen.blocked?.() ?? "can't see it right now";
      lines.push(`they asked about their screen, but you can't look right now: ${why}. private windows (passwords, banking, sign-in pages) you never look at on purpose. say that in one short line and ask what it is.`);
    } else if (userText && screenDeictic(userText) && !gazeFreshNow && screen.canLook() && !VISUAL_ASK.test(userText) && freshText(screen.current())) {
      // Fast path (~0s): the window text she already read answers "what am i doing". No screenshot.
      const cur = screen.current()!;
      lines.push(`on their screen right now (${cur.app}): ${cur.summary}`, `answer from that directly and specifically, like a friend glancing over.`);
    } else if (userText && screenDeictic(userText) && !gazeFreshNow && screen.canLook()) {
      await say(pick(LOOK_LINES, t.id), t, t.parent, "thinking");
      const look = await screen.look("deictic", { question: userText, parent: t.parent });
      if (gen !== myGen) return null;
      if (look.ok && look.description) {
        lines.push(`on their screen right now (${look.app ?? "their window"}): ${look.description}`);
        lines.push(`when they say "this", "that" or "thoughts?", they mean what's on their screen. react to it directly and specifically, like a friend glancing over. have an opinion.`);
      } else {
        const cur = screen.current();
        if (cur && !cur.private) lines.push(`on their screen (from the window text): ${cur.summary}`, `when they say "this" or "that", they probably mean that.`);
        else lines.push("you couldn't see their screen just now. say so briefly and ask what it is.");
      }
    } else if (t.rule === "screen_stuck") {
      const look = screen.canLook() ? await screen.look("stuck", { parent: t.parent }) : null;
      if (gen !== myGen) return null;
      lines.push(`the error: ${String(t.data.error ?? "")} (in ${String(t.data.app ?? "")}, on screen ${String(t.data.stuckMin ?? "?")} minutes)`);
      if (look?.ok && look.description) lines.push(`what the window shows: ${look.description}`);
      lines.push(`offer to take a look, in one short casual line ending in a question, like "that error's been there ${String(t.data.stuckMin ?? 6)} minutes, want me to look?". don't try to solve it yet.`);
      screenOffer = { until: now() + 120_000, error: String(t.data.error ?? "the error on screen"), app: String(t.data.app ?? "") };
    } else if (t.rule === "screen_interesting") {
      lines.push(`what's on their screen: ${String(t.data.summary ?? "")}`, `one short, specific, opinionated remark about it, like a friend glancing over ("that jacket is mid"). don't offer help.`);
    }
    return lines;
  }

  /** He said yes to "want me to look?": hand the error to work mode (Claude Code on his repo), else to a task. */
  async function helpWithScreen(t: Trigger, offer: { error: string; app: string }) {
    const work = ctx.tryUse("work");
    const repo = work?.resolveRepo()?.name;
    const ask = `fix ${offer.error}${repo ? ` in ${repo}` : ""}`;
    if (work?.claims(ask)) return escalateWork(t, ask, goalFrom(ask), false);
    const agency = ctx.tryUse("agency");
    if (!agency) {
      await say("i'd help but my hands aren't hooked up right now.", t, t.parent, "sad");
      return;
    }
    await say(pick(ACK_LINES, t.id), t, t.parent, "thinking");
    const goal = `Help fix this error on their screen (${offer.app}): ${offer.error}`;
    escalations += 1;
    ownGoals.add(goal);
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
      await report(t, goal, String(t.data.text ?? ""), res);
    })();
  }

  async function escalate(t: Trigger, acked = false) {
    if (t.rule === "utterance" && acceptedOffer) {
      const offer = acceptedOffer;
      acceptedOffer = null;
      return helpWithScreen(t, offer);
    }
    const text = String(t.data.text ?? t.description);
    const goal = t.rule === "utterance" ? goalFrom(text) : t.description;
    const work = ctx.tryUse("work");
    if (t.rule === "utterance" && work?.claims(text)) return escalateWork(t, text, goal, acked || work.awaiting());
    const agency = ctx.tryUse("agency");
    if (!agency) {
      log("no agency service: can't run tasks");
      await say("i can't do that from here yet. my hands aren't hooked up.", t, t.parent, "sad");
      return;
    }
    if (!acked) await say(pick(ACK_LINES, t.id), t, t.parent, "thinking");
    escalations += 1;
    ownGoals.add(goal);
    const job = router.track("do", goal, text);
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
      if (job.cancelled) return router.finish(job);
      router.finish(job);
      await report(t, goal, text, res);
    })();
  }

  /** The talker delegated a "do": route it through the same paths Jev's ACT/ESCALATE use. The stall already played. */
  async function doDelegated(rt: RouterTrigger, task: string) {
    const t: Trigger = { id: `${rt.id}#do`, rule: "utterance", description: `he asked you to: ${task}`, urgency: "immediate", data: { text: task }, parent: rt.parent, at: now(), ambient: false };
    const it = readIntent(task);
    if (it.outfit) return outfit(t, it.outfit);
    if (it.music || it.browse || it.command) {
      const scores = { IGNORE: 0, GLANCE: 0, REACT: 0, COMMENT: 0, ASK: 0, HELP: 0, ACT: 1, ESCALATE: 0 };
      return act(t, { decision: "ACT", scores, by: "local", latencyMs: 0, reason: "talker delegate", intent: it });
    }
    return escalate(t, true);
  }

  /** Work asks (docs/WORK.md): files, code, jabby, shell. Same ack + background run + report as a task. */
  async function escalateWork(t: Trigger, text: string, goal: string, answering: boolean) {
    const work = ctx.use("work");
    // Answers to her own question and quick reads don't need an "on it".
    if (!answering) await say(pick(ACK_LINES, t.id), t, t.parent, "thinking");
    escalations += 1;
    ownGoals.add(goal);
    const job = router.track("do", goal, text);
    void (async () => {
      let res: { ok: boolean; summary: string };
      try {
        res = await work.handle(text, { parent: t.parent, goal });
      } catch (err) {
        res = { ok: false, summary: `it broke: ${err instanceof Error ? err.message : String(err)}` };
      } finally {
        escalations -= 1;
        ownGoals.delete(goal);
      }
      if (job.cancelled) return router.finish(job);
      router.finish(job);
      await report(t, goal, text, res);
    })();
  }

  async function report(t: Trigger, goal: string, userText: string, res: { ok: boolean; summary: string }) {
    // Not over him, not over herself: wait for a natural gap (docs/VOICE.md).
    await router.waitGap();
    await acquire();
    try {
      const rel = relationship();
      const brains = ctx.tryUse("brains");
      const fallback = `${res.ok ? "done." : "that didn't work."} ${res.summary}`.trim();
      // A short summary is already in her voice and is the ground truth (e.g. the
      // user declined the booking): say it verbatim instead of letting the persona
      // brain paraphrase it into something that never happened.
      const words = res.summary.trim().split(/\s+/).filter(Boolean).length;
      // Raw tool output (commit hashes, paths, file names, flags) gets said like a person, not read out.
      const raw = /\b[0-9a-f]{7,40}\b|[\w-]+\.(?:md|ts|tsx|js|json|py|txt|lock|yml|yaml)\b|\/[\w.-]+\/|--?\w+|\bdocs:|\bfeat:|\bfix:/i.test(res.summary);
      if (res.summary.trim() && words <= 32 && !raw) {
        const said = await say(res.summary.trim(), null, t.parent, res.ok ? "happy" : "sad");
        await observe(userText, said, `task ${res.ok ? "done" : "failed"}: ${goal}. ${res.summary}`);
        return;
      }
      const memories = await recall(goal, t.parent);
      const extra = extraFor(t, undefined, memories, [
        `task: ${goal}`,
        `outcome: ${res.ok ? "success" : "failed"}`,
        `result: ${res.summary}`,
        "the result above is the ground truth. only report what it says. never claim something was booked, sent or bought unless the result says so.",
        "say it like a person, not a terminal: no commit hashes, file paths, flags or code punctuation out loud. one or two short sentences.",
      ]);
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
      const ep = jevEndpoint();
      jev = opts.jev ?? createJev(ep ? { apiKey: ep.apiKey, url: ep.url, model: ep.model } : {});
      log(`jev: ${ep ? `${ep.model} via ${ep.via} (400ms budget, local fallback)` : "local scorer (no AI_GATEWAY_API_KEY or TYPESAFE_API_KEY)"}`);

      router = new VoiceRouter({
        bus: ctx.bus,
        talker: () => ctx.tryUse("talker"),
        brains: () => ctx.tryUse("brains"),
        speech: () => ctx.tryUse("speech"),
        now,
        log: (...a) => ctx.log("talker", ...a),
        say: (text, parent, o = {}) => say(text, o.immediate ? ({ urgency: "immediate", ambient: false } as Trigger) : null, parent, o.mood, false, o.brain ?? "persona"),
        doTask: doDelegated,
        acquire,
        release,
        observe,
        userSpeaking: () => ctx.world().user.speaking,
        ...opts.router,
      });
      // Flux EagerEndOfTurn: start the talker before he's even done; TurnResumed drops it.
      offs.push(
        ctx.bus.on("voice.eager", (e) => {
          const text = String(e.data.text ?? "").trim();
          if (!text || readIntent(text).stop || ctx.tryUse("onboarding")?.active() || !router.usable() || talkerSkips(text)) return;
          const t: Trigger = { id: `eager#${now().toString(36)}`, rule: "utterance", description: `user said "${text}"`, urgency: "immediate", data: { text }, at: now(), ambient: false };
          router.speculate(text, () => talkerExtra(t, text));
        }),
        ctx.bus.on("voice.resumed", () => router.unspeculate("turn resumed")),
      );

      ctx.provide("reflex", {
        trigger: (x) =>
          enqueue({ id: `${x.id}#ext${now().toString(36)}`, rule: x.id, description: x.description, urgency: x.urgency, data: x.data ?? {}, parent: x.parent, at: now(), ambient: true }),
      });

      // --- turns: "talk, pause, keep talking" is one turn ------------------------------
      // voice.final pieces merge until he's quiet for turnMs. If he keeps talking right
      // after she started answering, her half-answer is dropped and she hears it all.
      const turnMs = opts.turnMs ?? (process.env.NODE_ENV === "test" ? 0 : Number(process.env.EVE_TURN_MS || 800));
      const MERGE_MS = 3500;
      let pend: { texts: string[]; timer?: ReturnType<typeof setTimeout>; parent?: string } | null = null;
      let lastTurn: { text: string; at: number } | null = null;
      const flushTurn = () => {
        if (!pend) return;
        if (pend.timer) clearTimeout(pend.timer);
        const text = pend.texts.join(" ").replace(/\s+/g, " ").trim();
        const parts = pend.texts.length;
        const parent = pend.parent;
        pend = null;
        if (!text) return;
        lastTurn = { text, at: now() };
        // Stamped on the module clock: the rules engine replays by event time.
        ctx.bus.publish({ ...envelope("voice.turn", { text, parts }, "core", parent), ts: now() } as AnyEnvelope);
      };
      offs.push(
        ctx.bus.on("voice.final", (e) => {
          const text = String(e.data.text ?? "").trim();
          if (!text) return;
          const it = readIntent(text);
          if (it.stop) {
            // Stop words never wait.
            flushTurn();
            pend = { texts: [text], parent: e.id };
            flushTurn();
            return;
          }
          const speech = ctx.tryUse("speech");
          const answering = busy || (speech?.speaking() ?? false);
          if (!pend && lastTurn && now() - lastTurn.at < MERGE_MS && answering && !(it.approval && pendingApprovals.size)) {
            // He wasn't done: cancel her reply to the first half and take the whole thing.
            gen += 1;
            speech?.stop("he kept talking");
            pend = { texts: [lastTurn.text] };
          }
          pend ??= { texts: [] };
          pend.texts.push(text);
          pend.parent = e.id;
          // Flux already decided the turn is over (model-based end of turn): no extra wait.
          if (turnMs <= 0 || e.data.endOfTurn) return flushTurn();
          if (pend.timer) clearTimeout(pend.timer);
          // A finished-sounding sentence waits a little less.
          const wait = /[?!.]$/.test(text) && text.split(/\s+/).length >= 3 ? Math.round(turnMs * 0.6) : turnMs;
          pend.timer = setTimeout(flushTurn, wait);
        }),
      );

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
      router?.dispose();
      for (const off of offs.splice(0)) off();
      queue.length = 0;
    },
  };
}
