import { matchesType, type AnyEnvelope, type Urgency, type WorldSnapshot } from "@eigenwife/protocol";
import { SCREEN_RULES } from "../screen/rules";

/**
 * Perception rules: System 0 to System 1. Raw bus events go in, a small number
 * of candidate triggers come out. Jev then decides whether any of them deserve
 * a reaction. Rules are plain declarative objects; the `when` escape hatch is
 * there for the few that need arithmetic (stare length, silence length).
 *
 * The engine's clock is the event timestamp, so replaying a recorded or
 * simulated stream is fully deterministic.
 */

export interface Trigger {
  /** Unique id for this firing, e.g. "repeat_media#12". */
  id: string;
  /** Which rule fired. */
  rule: string;
  /** One line a brain can read: "user played 'Someone Like You' 4 times in 30 minutes". */
  description: string;
  urgency: Urgency;
  data: Record<string, unknown>;
  /** The event that caused it. */
  parent?: string;
  /** Epoch ms. */
  at: number;
  /** Ambient triggers are what the 80-95% ignore target is measured over. */
  ambient: boolean;
}

/** Facts every rule can read. Maintained by the engine from the stream it has seen. */
export interface RuleContext {
  now: number;
  world: WorldSnapshot;
  /** ts of the last event matching this type/pattern, or undefined. */
  lastSeen(type: string): number | undefined;
  /** Has this event type ever been seen. */
  seen(type: string): boolean;
  /** ms since the user last spoke (or since the engine started, if never). */
  silenceMs(): number;
  /** Is a face in front of the camera right now (eye.status, or a recent gaze target). */
  facePresent(): boolean;
  /** ms the face was away before the current presence began. 0 if it never left, or if it came back more than 10s ago. */
  lastAbsenceMs(): number;
  /** When the current presence began (undefined while away). */
  presentSince(): number | undefined;
  /** The current continuous stare: same gaze target key since `since`. */
  stare(): { key: string; label: string; kind: string; since: number; ms: number; meta?: Record<string, unknown> } | null;
  /** When this rule last fired, or undefined. */
  lastFired(rule: string): number | undefined;
}

export interface WindowSpec {
  /** Fire when at least this many matching events fell inside the window. */
  count: number;
  withinMs: number;
  /** Group key, e.g. the track name. "$same" semantics: only same-key events count together. */
  key?: (e: AnyEnvelope) => string;
}

export interface Rule {
  id: string;
  /** Event type or glob ("gaze.*") the rule listens to. */
  on: string | string[];
  urgency: Urgency;
  /** Ambient triggers are unprompted observations; direct ones (utterances, birth) are not. */
  ambient?: boolean;
  /** Only after this event type has been seen at least once (e.g. companion.born). */
  after?: string;
  /** Shallow field match on the payload; RegExp values test strings. */
  where?: Record<string, string | number | boolean | RegExp>;
  /** Sliding window count. */
  window?: WindowSpec;
  /** Arbitrary predicate for the rest. */
  when?: (e: AnyEnvelope, rc: RuleContext) => boolean;
  /** Minimum ms between firings. Keyed per window key when a window key exists. */
  cooldownMs?: number;
  /** Human description of this firing. */
  describe: (e: AnyEnvelope, rc: RuleContext, count: number) => string;
  data?: (e: AnyEnvelope, rc: RuleContext, count: number) => Record<string, unknown>;
  /** Short doc line for docs/MIND.md and /api/reflex. */
  doc: string;
}

// ---------------------------------------------------------------------------
// Constants (tuned for the demo, documented in docs/MIND.md)
// ---------------------------------------------------------------------------

export const MIN = 60_000;
export const STARE_MS = 4_000;
export const STARE_COOLDOWN_MS = 45_000;
export const SILENCE_MS = 3 * MIN;
export const SILENCE_COOLDOWN_MS = 10 * MIN;
export const AWAY_MS = 2 * MIN;
/** Gaze targets older than this no longer count as "face present". */
const GAZE_PRESENCE_MS = 10_000;
/** Things worth staring at. Avatar/ui/app regions are not "content". */
const STARE_KINDS = new Set(["menu-item", "restaurant", "profile-photo", "profile-prompt", "profile-meta", "other"]);

const DATING_APP = /^eigen\b|dating|hinge|tinder|bumble/i;

const str = (x: unknown) => (typeof x === "string" ? x : "");

// ---------------------------------------------------------------------------
// The shipped rules
// ---------------------------------------------------------------------------

export const DEFAULT_RULES: Rule[] = [
  {
    id: "utterance",
    doc: "user said something (voice.final). Always a trigger.",
    on: "voice.final",
    urgency: "immediate",
    ambient: false,
    when: (e) => str((e.data as { text?: unknown }).text).trim().length > 0,
    describe: (e) => `user said: "${str((e.data as { text: string }).text).trim()}"`,
    data: (e) => ({ text: str((e.data as { text: string }).text).trim() }),
  },
  {
    id: "companion_born",
    doc: "companion.born: her first words.",
    on: "companion.born",
    urgency: "immediate",
    ambient: false,
    describe: (e) => `you were just born as ${(e.data as { persona: { name: string } }).persona.name}. these are your first words to them`,
    data: (e) => ({ persona: (e.data as { persona: { name: string } }).persona.name, woken: !!(e.data as { woken?: boolean }).woken }),
  },
  {
    id: "relapse",
    doc: "dating app opened again (app.opened Eigen/dating, or shell.scene dating) after companion.born.",
    on: ["app.opened", "shell.scene"],
    urgency: "immediate",
    ambient: true,
    after: "companion.born",
    cooldownMs: 20_000,
    when: (e) => (e.type === "app.opened" ? DATING_APP.test(e.data.app) : e.type === "shell.scene" && e.data.scene === "dating"),
    describe: () => "user opened the dating app again, after you already exist",
    data: (e) => ({ app: e.type === "app.opened" ? e.data.app : "Eigen" }),
  },
  {
    id: "repeat_media",
    doc: "same track played 3+ times inside 30 minutes.",
    on: "media.play",
    urgency: "soon",
    ambient: true,
    window: { count: 3, withinMs: 30 * MIN, key: (e) => (e.type === "media.play" ? e.data.track.toLowerCase().trim() : "") },
    cooldownMs: 60_000,
    describe: (e, _rc, n) => {
      const d = e.data as { track: string; artist?: string };
      return `user played "${d.track}"${d.artist ? ` by ${d.artist}` : ""} ${n} times in the last 30 minutes`;
    },
    data: (e, _rc, n) => ({ track: (e.data as { track: string }).track, artist: (e.data as { artist?: string }).artist, count: n }),
  },
  {
    id: "stare",
    doc: "same gaze target for 4s+ while nobody is talking (content only, not ui/avatar).",
    on: "gaze.target",
    urgency: "soon",
    ambient: true,
    cooldownMs: STARE_COOLDOWN_MS,
    when: (_e, rc) => {
      const s = rc.stare();
      if (!s || s.ms < STARE_MS || !STARE_KINDS.has(s.kind)) return false;
      // once per continuous stare
      const fired = rc.lastFired("stare");
      if (fired !== undefined && fired >= s.since) return false;
      return rc.silenceMs() > 6_000 && rc.world.companion.state !== "speaking";
    },
    describe: (_e, rc) => {
      const s = rc.stare()!;
      return `user has been staring at "${s.label}" for ${(s.ms / 1000).toFixed(1)}s without saying anything`;
    },
    data: (_e, rc) => {
      const s = rc.stare()!;
      return { targetKey: s.key, label: s.label, kind: s.kind, ms: s.ms, meta: s.meta };
    },
  },
  {
    id: "long_silence",
    doc: "no voice for 3 minutes while a face is present.",
    on: "timer.tick",
    urgency: "later",
    ambient: true,
    after: "companion.born",
    cooldownMs: SILENCE_COOLDOWN_MS,
    when: (_e, rc) => rc.facePresent() && rc.silenceMs() >= SILENCE_MS,
    describe: (_e, rc) => `nobody has said anything for ${Math.round(rc.silenceMs() / MIN)} minutes; user is still there`,
    data: (_e, rc) => ({ silenceMs: rc.silenceMs(), gaze: rc.world.user.gazeTarget?.label }),
  },
  {
    id: "task_done",
    doc: "a background task finished (task.done).",
    on: "task.done",
    urgency: "soon",
    ambient: true,
    describe: (e) => {
      const d = e.data as { ok: boolean; summary: string };
      return `a background task ${d.ok ? "finished" : "failed"}: ${d.summary}`;
    },
    data: (e) => {
      const d = e.data as { taskId: string; ok: boolean; summary: string };
      return { taskId: d.taskId, ok: d.ok, summary: d.summary };
    },
  },
  {
    id: "face_return",
    doc: "face back after being away 2 minutes or more.",
    on: ["eye.status", "gaze.target"],
    urgency: "soon",
    ambient: true,
    after: "companion.born",
    cooldownMs: 60_000,
    when: (e, rc) => {
      if (e.type === "eye.status" && e.data.facePresent !== true) return false;
      if (rc.lastAbsenceMs() < AWAY_MS) return false;
      const fired = rc.lastFired("face_return");
      const since = rc.presentSince();
      return since !== undefined && (fired === undefined || fired < since);
    },
    describe: (_e, rc) => `user came back after being away ${Math.round(rc.lastAbsenceMs() / MIN)} minutes`,
    data: (_e, rc) => ({ awayMs: rc.lastAbsenceMs() }),
  },
  {
    id: "poked",
    doc: "the user clicked her 3+ times in a few seconds (avatar.poke from the overlay / shell). One short line, 30s cooldown.",
    on: "avatar.poke",
    urgency: "immediate",
    ambient: false,
    after: "companion.born",
    cooldownMs: 30_000,
    when: (e) => e.type === "avatar.poke" && e.data.count >= 3,
    describe: (e) => `user keeps poking you (${(e.data as { count: number }).count} clicks in a few seconds)`,
    data: (e) => ({ count: (e.data as { count: number }).count, region: (e.data as { region: string }).region }),
  },
  {
    id: "app_opened",
    doc: "any other app opened. Almost always ignored, which is the point.",
    on: "app.opened",
    urgency: "later",
    ambient: true,
    cooldownMs: 5_000,
    when: (e) => e.type === "app.opened" && !DATING_APP.test(e.data.app),
    describe: (e) => `user opened ${(e.data as { app: string }).app}`,
    data: (e) => ({ app: (e.data as { app: string }).app }),
  },
  // screen awareness: stuck on an error, something worth a remark (docs/SCREEN.md)
  ...SCREEN_RULES,
];

// ---------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------

function matchWhere(data: Record<string, unknown>, where: Rule["where"]): boolean {
  if (!where) return true;
  for (const [k, v] of Object.entries(where)) {
    const got = data[k];
    if (v instanceof RegExp) {
      if (typeof got !== "string" || !v.test(got)) return false;
    } else if (got !== v) return false;
  }
  return true;
}

export class PerceptionEngine {
  private last = new Map<string, number>();
  private windows = new Map<string, number[]>();
  private fired = new Map<string, number>();
  private start: number | undefined;
  private lastVoice: number | undefined;
  private face: { present: boolean; since: number; awaySince?: number; lastAbsence: number } = { present: false, since: 0, lastAbsence: 0 };
  private lastGazeAt: number | undefined;
  private stareState: { key: string; label: string; kind: string; since: number; lastAt: number; meta?: Record<string, unknown> } | null = null;
  private seq = 0;

  constructor(
    private world: () => WorldSnapshot,
    public rules: Rule[] = DEFAULT_RULES,
  ) {}

  /** Feed one event; returns the triggers it raised (usually none). */
  feed(e: AnyEnvelope): Trigger[] {
    const now = e.ts;
    this.start ??= now;
    this.track(e, now);
    const rc = this.context(now);
    const out: Trigger[] = [];
    for (const r of this.rules) {
      const ons = Array.isArray(r.on) ? r.on : [r.on];
      if (!ons.some((p) => matchesType(p, e.type))) continue;
      if (r.after && !this.last.has(r.after)) continue;
      if (!matchWhere(e.data as Record<string, unknown>, r.where)) continue;
      if (r.when && !r.when(e, rc)) continue;
      let count = 1;
      let cdKey = r.id;
      if (r.window) {
        const key = r.window.key?.(e) ?? "";
        cdKey = `${r.id}:${key}`;
        const wk = `${r.id}:${key}`;
        const arr = (this.windows.get(wk) ?? []).filter((t) => now - t <= r.window!.withinMs);
        arr.push(now);
        this.windows.set(wk, arr);
        count = arr.length;
        if (count < r.window.count) continue;
      }
      const prev = this.fired.get(cdKey);
      if (r.cooldownMs && prev !== undefined && now - prev < r.cooldownMs) continue;
      this.fired.set(cdKey, now);
      this.fired.set(r.id, now);
      out.push({
        id: `${r.id}#${++this.seq}`,
        rule: r.id,
        description: r.describe(e, rc, count),
        urgency: r.urgency,
        data: r.data?.(e, rc, count) ?? {},
        parent: e.id,
        at: now,
        ambient: r.ambient ?? true,
      });
    }
    // mark after rules ran so "after: X" means strictly after
    this.last.set(e.type, now);
    return out;
  }

  private track(e: AnyEnvelope, now: number) {
    switch (e.type) {
      case "voice.final":
      case "voice.partial":
        this.lastVoice = now;
        break;
      case "eye.status":
        if (e.data.facePresent === true) this.present(now);
        else if (e.data.facePresent === false) this.away(now);
        break;
      case "gaze.lost":
        if (e.data.reason !== "offscreen") this.away(now);
        this.stareState = null;
        break;
      case "gaze.fixation":
        if (e.data.target && this.stareState && e.data.target.key !== this.stareState.key) this.stareState = null;
        break;
      case "gaze.target": {
        this.lastGazeAt = now;
        this.present(now);
        const t = e.data.target;
        const s = this.stareState;
        // A gap of >6s between announcements of the same target breaks the stare.
        if (s && s.key === t.key && now - s.lastAt < 6_000) s.lastAt = now;
        else this.stareState = { key: t.key, label: t.label, kind: t.kind, since: now - Math.max(0, e.data.dwellMs), lastAt: now, meta: t.meta };
        break;
      }
    }
  }

  private present(now: number) {
    if (this.face.present) return;
    this.face.lastAbsence = this.face.awaySince !== undefined ? now - this.face.awaySince : 0;
    this.face = { present: true, since: now, lastAbsence: this.face.lastAbsence };
  }

  private away(now: number) {
    if (!this.face.present && this.face.awaySince !== undefined) return;
    this.face = { present: false, since: this.face.since, awaySince: now, lastAbsence: this.face.lastAbsence };
  }

  private context(now: number): RuleContext {
    return {
      now,
      world: this.world(),
      lastSeen: (type) => {
        let best: number | undefined;
        for (const [k, t] of this.last) if (matchesType(type, k) && (best === undefined || t > best)) best = t;
        return best;
      },
      seen: (type) => this.last.has(type),
      silenceMs: () => now - (this.lastVoice ?? this.start ?? now),
      facePresent: () =>
        this.face.present || this.world().user.facePresent || (this.lastGazeAt !== undefined && now - this.lastGazeAt < GAZE_PRESENCE_MS),
      lastAbsenceMs: () => (this.face.present && now - this.face.since < 10_000 ? this.face.lastAbsence : 0),
      presentSince: () => (this.face.present ? this.face.since : undefined),
      stare: () => {
        const s = this.stareState;
        if (!s) return null;
        return { key: s.key, label: s.label, kind: s.kind, since: s.since, ms: now - s.since, meta: s.meta };
      },
      lastFired: (rule) => this.fired.get(rule),
    };
  }

  /** Snapshot for /api/reflex. */
  describeRules() {
    return this.rules.map((r) => ({ id: r.id, on: r.on, urgency: r.urgency, ambient: r.ambient ?? true, cooldownMs: r.cooldownMs ?? 0, doc: r.doc }));
  }
}
