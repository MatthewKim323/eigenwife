import { REFLEX_DECISIONS, type ReflexDecision, type RelationshipState, type WorldSnapshot } from "@eigenwife/protocol";
import { readIntent, type UtteranceIntent } from "./intent";
import type { Trigger } from "./rules";

/**
 * System 1. Given a trigger and the world, pick one of
 * IGNORE | GLANCE | REACT | COMMENT | ASK | HELP | ACT | ESCALATE.
 *
 * Two scorers:
 * - Jev (TypeSafe systemone, a typed `choice` question) when TYPESAFE_API_KEY is set.
 * - A transparent hand-tuned local scorer otherwise, and whenever Jev is slow
 *   (400ms budget) or down. Every score it produces can be read off the
 *   feature table in docs/MIND.md.
 */

export type Scores = Record<ReflexDecision, number>;

export interface JevInput {
  trigger: Trigger;
  world: WorldSnapshot;
  relationship: RelationshipState;
  now: number;
  /** When she last reacted out loud or acted (not IGNORE, not a silent GLANCE). */
  lastReactionAt?: number;
  /** An action is waiting on a spoken yes/no: short approvals belong to agency. */
  pendingApproval?: boolean;
  /** This task.done belongs to a task the reflex itself escalated (reported directly). */
  ownTask?: boolean;
}

export interface JevVerdict {
  decision: ReflexDecision;
  scores: Scores;
  by: "jev" | "local";
  latencyMs: number;
  reason: string;
  /** Stop current speech right now (stop words). */
  stopSpeech?: boolean;
  intent?: UtteranceIntent;
}

export interface JevDecider {
  decide(input: JevInput): Promise<JevVerdict>;
  status(): { remote: boolean; failures: number; lastError?: string };
}

// ---------------------------------------------------------------------------
// Local scorer
// ---------------------------------------------------------------------------

const LOW = -1.5;

/** Deterministic per-trigger whim in [-1, 1): borderline cases vary, replays don't. */
export function whim(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  // murmur3 finalizer: ids differ only in their tail ("stare#41", "stare#42"), so mix hard
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return ((h >>> 0) / 2 ** 32) * 2 - 1;
}

export function softmax(logits: Scores, temperature = 1): Scores {
  const max = Math.max(...REFLEX_DECISIONS.map((d) => logits[d]));
  const exps = REFLEX_DECISIONS.map((d) => Math.exp((logits[d] - max) / temperature));
  const sum = exps.reduce((a, b) => a + b, 0);
  const out = {} as Scores;
  REFLEX_DECISIONS.forEach((d, i) => (out[d] = Math.round((exps[i]! / sum) * 1000) / 1000));
  return out;
}

export function argmax(scores: Partial<Scores>): ReflexDecision {
  let best: ReflexDecision = "IGNORE";
  let v = -Infinity;
  for (const d of REFLEX_DECISIONS) {
    const s = scores[d] ?? -Infinity;
    if (s > v) {
      v = s;
      best = d;
    }
  }
  return best;
}

function base(): Scores {
  return { IGNORE: 0, GLANCE: LOW, REACT: LOW, COMMENT: LOW, ASK: LOW, HELP: LOW, ACT: LOW, ESCALATE: LOW };
}

export interface LocalResult {
  logits: Scores;
  scores: Scores;
  decision: ReflexDecision;
  reason: string;
  stopSpeech?: boolean;
  intent?: UtteranceIntent;
}

function scoreUtterance(input: JevInput, text: string): LocalResult {
  const it = readIntent(text);
  const l = base();
  const why: string[] = [];
  let stopSpeech = false;
  if (it.stop) {
    l.IGNORE = 6;
    stopSpeech = true;
    why.push("stop word");
  } else if (it.approval && input.pendingApproval) {
    l.IGNORE = 5;
    why.push("approval reply, agency owns it");
  } else if (it.outfit) {
    l.ACT = 4;
    why.push(`outfit request ${it.outfit.kind}`);
  } else if (it.work) {
    l.ESCALATE = 4.2;
    l.HELP = 1.5;
    why.push("work ask");
  } else if (it.task) {
    l.ESCALATE = 4;
    l.HELP = 1.5;
    why.push("task intent");
  } else if (it.command || it.music || it.browse) {
    l.ACT = 3.5;
    why.push(it.music ? `music ${it.music.op}` : it.browse ? `browse ${it.browse.query ?? "it"}` : `command ${it.command!.kind}`);
  } else if (it.help) {
    l.HELP = 3;
    l.REACT = 1.5;
    why.push("help intent");
  } else if (it.down) {
    l.COMMENT = 3;
    l.REACT = 1.5;
    why.push("user is down: comfort");
  } else if (it.question) {
    l.REACT = it.deictic ? 3.3 : 3;
    l.COMMENT = 1;
    why.push(it.deictic ? "deictic question" : "question");
  } else if (it.filler) {
    l.GLANCE = 2;
    l.IGNORE = 1.5;
    why.push("filler");
  } else if (it.laugh) {
    l.REACT = 2.4;
    l.COMMENT = 1.2;
    why.push("laugh");
  } else {
    l.COMMENT = 2 + (input.relationship.banter - 0.5);
    l.REACT = 2;
    why.push("statement");
  }
  const scores = softmax(l);
  let decision = argmax(scores);
  if (decision === "IGNORE" && !it.stop && !(it.approval && input.pendingApproval)) decision = "GLANCE";
  return { logits: l, scores, decision, reason: why.join(", "), stopSpeech, intent: it };
}

/** How much a rule wants her to say something, before social modifiers. */
function ambientSalience(t: Trigger, input: JevInput, l: Scores, why: string[]) {
  const r = input.relationship;
  switch (t.rule) {
    case "companion_born":
      l.COMMENT = 6;
      why.push("first words");
      return;
    case "relapse":
      l.IGNORE = -2;
      l.ACT = 4;
      l.COMMENT = 2.5;
      why.push("dating app relapse");
      return;
    case "repeat_media": {
      const n = Number(t.data.count ?? 3);
      l.IGNORE = 2.2;
      l.COMMENT = 1.2 + 1.4 * (n - 3) + (r.banter - 0.5) * 1.5;
      l.GLANCE = 0.4;
      why.push(`track x${n}`);
      return;
    }
    case "task_done":
      if (input.ownTask) {
        l.IGNORE = 6;
        why.push("own escalation, reported directly");
        return;
      }
      l.IGNORE = 1.2;
      l.REACT = 1.8;
      why.push("task finished");
      return;
    case "stare": {
      const kind = String(t.data.kind ?? "");
      const ms = Number(t.data.ms ?? 0);
      l.IGNORE = 2.4;
      l.GLANCE = 1.8 + 0.8 * Math.min(1, (ms - 4000) / 5000);
      l.COMMENT = (kind === "menu-item" || kind === "restaurant" ? 0.5 : -0.2) + (r.initiative - 0.5);
      why.push(`stare ${kind} ${(ms / 1000).toFixed(1)}s`);
      return;
    }
    case "long_silence":
      l.IGNORE = 2;
      l.ASK = 0.8 + r.initiative;
      l.COMMENT = 0.4 + r.banter * 0.5;
      why.push("long silence");
      return;
    case "face_return":
      l.IGNORE = 1.4;
      l.GLANCE = 1.3;
      l.REACT = 1.2 + r.warmth;
      why.push("welcome back");
      return;
    case "poked":
      l.IGNORE = -2;
      l.COMMENT = 5;
      why.push(`poked x${Number(t.data.count ?? 3)}`);
      return;
    case "screen_stuck": {
      // Same error for minutes: offering help is the friend move. Still not forced.
      const min = Number(t.data.stuckMin ?? 5);
      l.IGNORE = 0.8;
      l.GLANCE = 0.4;
      l.HELP = 2.3 + 0.3 * Math.min(1, Math.max(0, (min - 5) / 10)) + (r.initiative - 0.5);
      why.push(`stuck on an error ${min}m`);
      return;
    }
    case "screen_interesting": {
      const i = Number(t.data.interesting ?? 0.7);
      l.IGNORE = 2.6;
      l.GLANCE = 1.1;
      l.COMMENT = 0.5 + 1.5 * (i - 0.7) + (r.banter - 0.5);
      why.push(`screen ${String(t.data.mode ?? "")} ${i.toFixed(2)}`);
      return;
    }
    case "app_opened":
      l.IGNORE = 3;
      l.GLANCE = -0.5;
      l.COMMENT = -0.8 + (r.banter - 0.5);
      why.push(`app ${String(t.data.app ?? "")}`);
      return;
    default:
      l.IGNORE = 2.5;
      l.GLANCE = 0.5;
      l.COMMENT = 0.3;
      why.push(`custom rule ${t.rule}`);
  }
}

export function localScore(input: JevInput): LocalResult {
  const t = input.trigger;
  if (t.rule === "utterance") return scoreUtterance(input, String(t.data.text ?? ""));
  const l = base();
  const why: string[] = [];
  const w = input.world;
  if (!w.companion.born && t.rule !== "companion_born") {
    l.IGNORE = 8;
    why.push("not born yet");
    const scores = softmax(l);
    return { logits: l, scores, decision: "IGNORE", reason: why.join(", ") };
  }
  ambientSalience(t, input, l, why);
  // Social modifiers apply to everything that is not a forced moment.
  const forced = t.rule === "companion_born" || t.rule === "relapse" || t.rule === "poked";
  if (!forced) {
    let mod = (input.relationship.initiative - 0.5) * 2;
    const sinceHer = w.companion.lastSpokeAt !== undefined ? input.now - w.companion.lastSpokeAt : Infinity;
    if (sinceHer < 20_000) mod -= 2;
    else if (sinceHer < 60_000) mod -= 1;
    const sinceReact = input.lastReactionAt !== undefined ? input.now - input.lastReactionAt : Infinity;
    if (sinceReact < 30_000) mod -= 1.5;
    else if (sinceReact < 90_000) mod -= 0.6;
    if (w.user.speaking) mod -= 2;
    if (w.companion.state === "speaking") mod -= 1.5;
    if (w.scene === "swarm" || w.scene === "architecture") mod -= 0.5;
    // Deep focus (typing in a code or writing app, from the screen sense): stay quiet.
    if (w.slots.screen?.focus === "deep" && t.rule !== "screen_stuck") mod -= 1.5;
    for (const d of REFLEX_DECISIONS) if (d !== "IGNORE") l[d] += mod;
    const jitter = whim(t.id) * 0.5;
    l.IGNORE += jitter;
    if (mod) why.push(`social ${mod >= 0 ? "+" : ""}${mod.toFixed(2)}`);
  }
  const scores = softmax(l);
  return { logits: l, scores, decision: argmax(scores), reason: why.join(", ") };
}

// ---------------------------------------------------------------------------
// Jev (TypeSafe systemone)
// ---------------------------------------------------------------------------

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";

export const DECISION_CRITERIA: Record<ReflexDecision, string> = {
  IGNORE: "Say nothing and do nothing. The right call for most ambient events; a good companion does not narrate the user's life.",
  GLANCE: "Just look at the thing (eyes/head only), no words.",
  REACT: "A quick verbal reaction or a direct answer to what the user said.",
  COMMENT: "An unprompted short remark or tease about what is happening.",
  ASK: "Ask the user a short question.",
  HELP: "Offer concrete help with what they are doing.",
  ACT: "Take one small immediate action on the computer (e.g. close an app).",
  ESCALATE: "Start a real multi-step task (plan, search, book, schedule) with the frontier brain.",
};

function secondsAgo(now: number, t?: number) {
  return t === undefined ? null : Math.round((now - t) / 1000);
}

/** The state object Jev sees. Compact on purpose: it is on the critical path. */
export function jevState(input: JevInput) {
  const w = input.world;
  const t = input.trigger;
  return {
    companion: "Eve, an AI girlfriend living on the user's desktop. Witty, a little sarcastic, cares about them.",
    policy: "Ignore 80-95% of ambient events. Never ignore the user speaking to her, unless they say stop/wait. Do not chatter: if she spoke recently, prefer IGNORE.",
    event: t.description,
    kind: t.rule,
    urgency: t.urgency,
    direct: !t.ambient,
    data: t.data,
    scene: w.scene,
    user_looking_at: w.user.gazeTarget?.label ?? null,
    user_speaking: w.user.speaking,
    she_spoke_seconds_ago: secondsAgo(input.now, w.companion.lastSpokeAt),
    she_reacted_seconds_ago: secondsAgo(input.now, input.lastReactionAt),
    active_app: w.desktop.activeApp ?? null,
    relationship: input.relationship,
  };
}

export function jevQuestions() {
  return {
    decision: {
      type: "choice",
      instructions: "What should Eve do about this event right now?",
      criteria: DECISION_CRITERIA,
    },
  };
}

/** Parse a systemone response into scores. Throws on anything malformed. */
export function parseJevResponse(body: unknown): { decision: ReflexDecision; scores: Scores; confidence?: number; model?: string } {
  const b = body as { model?: string; answers?: { decision?: { choice?: unknown; probabilities?: Record<string, unknown>; confidence?: unknown } } };
  const a = b?.answers?.decision;
  if (!a || typeof a.choice !== "string") throw new Error("jev: no decision answer");
  const choice = a.choice.toUpperCase() as ReflexDecision;
  if (!REFLEX_DECISIONS.includes(choice)) throw new Error(`jev: unknown choice ${a.choice}`);
  const scores = {} as Scores;
  for (const d of REFLEX_DECISIONS) {
    const p = a.probabilities?.[d] ?? a.probabilities?.[d.toLowerCase()];
    scores[d] = typeof p === "number" && Number.isFinite(p) ? Math.round(p * 1000) / 1000 : 0;
  }
  if (!Object.values(scores).some((v) => v > 0)) scores[choice] = 1;
  return { decision: choice, scores, confidence: typeof a.confidence === "number" ? a.confidence : undefined, model: b.model };
}

export interface JevOptions {
  apiKey?: string;
  model?: string;
  url?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
  /** Local verdicts at or above this confidence are not overridden by Jev (default 0.85). */
  pin?: number;
  /** Consecutive failures before the breaker opens, and how long it stays open. */
  breaker?: { failures: number; coolMs: number };
  now?: () => number;
}

export function createJev(opts: JevOptions = {}): JevDecider {
  const timeoutMs = opts.timeoutMs ?? 400;
  const pin = opts.pin ?? 0.85;
  const breaker = opts.breaker ?? { failures: 3, coolMs: 30_000 };
  const clock = opts.now ?? Date.now;
  const doFetch = opts.fetchImpl ?? fetch;
  let failures = 0;
  let openUntil = 0;
  let lastError: string | undefined;

  async function remote(input: JevInput) {
    const ctl = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, rej) => {
      timer = setTimeout(() => {
        ctl.abort();
        rej(new Error(`jev timeout ${timeoutMs}ms`));
      }, timeoutMs);
    });
    try {
      const req = (async () => {
        const res = await doFetch(opts.url ?? JEV_URL, {
          method: "POST",
          headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify({ model: opts.model ?? "jev-latest", state: jevState(input), questions: jevQuestions() }),
          signal: ctl.signal,
        });
        if (!res.ok) throw new Error(`jev ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return parseJevResponse(await res.json());
      })();
      return await Promise.race([req, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  return {
    status: () => ({ remote: !!opts.apiKey, failures, lastError }),
    async decide(input) {
      const t0 = performance.now();
      const local = localScore(input);
      const ms = () => Math.round((performance.now() - t0) * 10) / 10;
      const localVerdict = (why: string): JevVerdict => ({
        decision: local.decision,
        scores: local.scores,
        by: "local",
        latencyMs: ms(),
        reason: why ? `${local.reason}; ${why}` : local.reason,
        stopSpeech: local.stopSpeech,
        intent: local.intent,
      });
      // Hard cases never wait on the network.
      const hard = local.stopSpeech || local.reason.includes("not born") || local.reason.includes("agency owns") || local.reason.includes("own escalation") || local.reason.includes("outfit request") || local.reason.includes("poked");
      if (!opts.apiKey || hard) return localVerdict("");
      if (clock() < openUntil) return localVerdict("jev breaker open");
      try {
        const r = await remote(input);
        failures = 0;
        let decision = r.decision;
        let reason = `jev ${r.model ?? ""} picked ${r.decision}`.replace("  ", " ");
        const localConf = local.scores[local.decision];
        if (decision !== local.decision && localConf >= pin) {
          reason += `; local pin ${local.decision} ${localConf.toFixed(2)}`;
          decision = local.decision;
        }
        if (decision === "IGNORE" && input.trigger.rule === "utterance") {
          reason += "; utterances are never ignored";
          decision = local.decision === "IGNORE" ? "REACT" : local.decision;
        }
        return { decision, scores: r.scores, by: "jev", latencyMs: ms(), reason: `${reason} (${local.reason})`, intent: local.intent };
      } catch (err) {
        failures += 1;
        lastError = err instanceof Error ? err.message : String(err);
        if (failures >= breaker.failures) openUntil = clock() + breaker.coolMs;
        return localVerdict(`fallback: ${lastError}`);
      }
    },
  };
}
