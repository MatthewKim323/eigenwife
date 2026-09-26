import type { AnyEnvelope, EventMap } from "@eigenwife/protocol";
import type { Rule } from "../reflex/rules";

/**
 * Perception rules over screen.observation (docs/SCREEN.md, docs/MIND.md).
 * Both are ambient and rate limited; Jev still ignores most of what they
 * raise. Deep focus (typing in a code or writing app) never raises anything.
 */

const MIN = 60_000;
export const SCREEN_STUCK_MS = 5 * MIN;
export const SCREEN_INTEREST_MIN = 0.7;
const COMMENTABLE = new Set(["shopping", "social", "video", "reading", "gaming"]);

type Obs = EventMap["screen.observation"];
const obs = (e: AnyEnvelope) => e.data as Obs;

export const SCREEN_RULES: Rule[] = [
  {
    id: "screen_stuck",
    doc: "the same error has been on screen 5+ min (screen.observation, Jev or local stuck), not while typing. Per-error 30 min, any error 10 min.",
    on: "screen.observation",
    urgency: "later",
    ambient: true,
    after: "companion.born",
    window: { count: 1, withinMs: 1, key: (e) => String(obs(e).error ?? "").toLowerCase().replace(/\d+/g, "#") },
    cooldownMs: 30 * MIN,
    when: (e, rc) => {
      const o = obs(e);
      if (o.private || !o.error || !o.scores.stuck || o.focus) return false;
      if ((o.stuckMs ?? 0) < SCREEN_STUCK_MS) return false;
      const fired = rc.lastFired("screen_stuck");
      return fired === undefined || rc.now - fired >= 10 * MIN;
    },
    describe: (e) => {
      const o = obs(e);
      return `the same error has been on their screen for ${Math.round((o.stuckMs ?? 0) / MIN)} minutes in ${o.app}: ${o.error}`;
    },
    data: (e) => {
      const o = obs(e);
      return { app: o.app, error: o.error, stuckMin: Math.round((o.stuckMs ?? 0) / MIN), summary: o.summary };
    },
  },
  {
    id: "screen_interesting",
    doc: "something a friend glancing over might mention (interesting >= 0.7: shopping, feed, video, article), not private, not deep focus. 8 min apart, 30 min per page.",
    on: "screen.observation",
    urgency: "later",
    ambient: true,
    after: "companion.born",
    window: { count: 1, withinMs: 1, key: (e) => `${obs(e).app}|${obs(e).title ?? ""}`.toLowerCase() },
    cooldownMs: 30 * MIN,
    when: (e, rc) => {
      const o = obs(e);
      if (o.private || o.scores.sensitive || o.focus || o.scores.interesting < SCREEN_INTEREST_MIN || !COMMENTABLE.has(o.scores.mode)) return false;
      const fired = rc.lastFired("screen_interesting");
      return fired === undefined || rc.now - fired >= 8 * MIN;
    },
    describe: (e) => `on their screen (${obs(e).scores.mode}): ${obs(e).summary}`,
    data: (e) => {
      const o = obs(e);
      return { app: o.app, mode: o.scores.mode, interesting: o.scores.interesting, summary: o.summary };
    },
  },
];
