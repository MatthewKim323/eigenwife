import { describeOutfit, DEFAULT_RELATIONSHIP, WARDROBE_ITEMS, type AnyEnvelope, type Mood, type ReflexDecision, type RelationshipState, type Urgency } from "@eigenwife/protocol";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import { jevEndpoint, secret } from "../config";
import { goalFrom, readIntent, type UtteranceIntent } from "./intent";
import type { OutfitIntent } from "./outfit";
import { createJev, type JevDecider, type JevVerdict } from "./jev";
import { DEFAULT_RULES, PerceptionEngine, type Rule, type Trigger } from "./rules";
import { screenDeictic } from "../screen/intent";

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

  async function say(text: string | AsyncIterable<string>, t: Trigger | null, parent: string | undefined, mood?: Mood, forceInterrupt = false): Promise<string | null> {
    const speech = ctx.tryUse("speech");
    if (!speech) {
      log("no speech service: would have said", typeof text === "string" ? `"${text}"` : "(stream)");
      return null;
    }
    const interrupt = forceInterrupt ? speech.speaking() : !!t && t.urgency === "immediate" && !t.ambient && speech.speaking();
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
    const screenLines = await screenContext(t, userText, myGen);
    if (screenLines === null || gen !== myGen) return;
    const extra = extraFor(t, intent, memories, screenLines);
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

  async function escalate(t: Trigger) {
    if (t.rule === "utterance" && acceptedOffer) {
      const offer = acceptedOffer;
      acceptedOffer = null;
      return helpWithScreen(t, offer);
    }
    const text = String(t.data.text ?? t.description);
    const goal = t.rule === "utterance" ? goalFrom(text) : t.description;
    const work = ctx.tryUse("work");
    if (t.rule === "utterance" && work?.claims(text)) return escalateWork(t, text, goal, work.awaiting());
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

  /** Work asks (docs/WORK.md): files, code, jabby, shell. Same ack + background run + report as a task. */
  async function escalateWork(t: Trigger, text: string, goal: string, answering: boolean) {
    const work = ctx.use("work");
    // Answers to her own question and quick reads don't need an "on it".
    if (!answering) await say(pick(ACK_LINES, t.id), t, t.parent, "thinking");
    escalations += 1;
    ownGoals.add(goal);
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
      await report(t, goal, text, res);
    })();
  }

  async function report(t: Trigger, goal: string, userText: string, res: { ok: boolean; summary: string }) {
    await acquire();
    try {
      const rel = relationship();
      const brains = ctx.tryUse("brains");
      const fallback = `${res.ok ? "done." : "that didn't work."} ${res.summary}`.trim();
      // A short summary is already in her voice and is the ground truth (e.g. the
      // user declined the booking): say it verbatim instead of letting the persona
      // brain paraphrase it into something that never happened.
      const words = res.summary.trim().split(/\s+/).filter(Boolean).length;
      if (res.summary.trim() && words <= 32) {
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
