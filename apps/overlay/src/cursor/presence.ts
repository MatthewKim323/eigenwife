import { agentGlideMs, type CursorPt, type ScreenRect } from "@eigenwife/protocol";

/**
 * Eve's co-op presence (docs/AGENT_CURSOR.md): her cursor is always on the
 * screen, like a second player sharing the computer. Pure scheduler: the
 * cursor layer ticks it with what it knows (where her avatar is, where his
 * cursor is, what she's looking at, whether a task is driving) and draws the
 * commands it returns. Rate limited so it's charming, not distracting.
 *
 *   home       resting next to her avatar, breathing (the renderer adds the drift)
 *   wander     every 20-60s: lazily over near his cursor (never on it), to what
 *              she's looking at, or a small loop near home, then back
 *   agent      the core is driving (task steps, pointing while she talks)
 *   quiet      he's typing fast or in a fullscreen app: dim, and stay still
 */

export interface PresenceWorld {
  now: number;
  /** Where she rests: beside her avatar (homeFor). */
  home: CursorPt;
  /** His cursor, screen points. */
  user: CursorPt | null;
  /** When his cursor last moved. */
  userMovedAt: number;
  /** What her avatar is looking at (glance / hold / gaze), with when. */
  look: { p: CursorPt; at: number } | null;
  /** Typing fast, or a fullscreen app in front. */
  quiet: boolean;
  /** Tray "Show Eve's cursor" and ⌘⇧E. */
  shown: boolean;
}

export interface PresenceCmd {
  x: number;
  y: number;
  action: "move" | "hover" | "idle";
  ms?: number;
  label?: string;
}

export const PRESENCE = {
  firstWanderMs: 15_000,
  wanderMinMs: 20_000,
  wanderMaxMs: 60_000,
  dwellMs: [1600, 3200] as [number, number],
  /** Playful follow: re-aim at most this often, for at most followMaxMs. */
  followEveryMs: 800,
  followMaxMs: 4500,
  /** Never closer than this to his cursor. */
  keepAwayPx: 72,
  followDistPx: [84, 124] as [number, number],
  /** Only follow a cursor that moved recently; only visit a fresh look target. */
  userFreshMs: 10_000,
  lookFreshMs: 5000,
  nearHome: [70, 170] as [number, number],
  /** Home moved (she was dragged): walk over after this much drift. */
  homeSlackPx: 28,
  /** After the core says idle: a beat, then home. No word from the core this long = idle. */
  returnAfterAgentMs: 1100,
  agentSilenceMs: 12_000,
  dimLevel: 0.35,
};

export type Rand = () => number;

type State = "boot" | "home" | "going" | "dwell" | "returning" | "agent";

/** Resting spot beside her avatar window: by her hand, on the side facing the screen. */
export function homeFor(avatar: ScreenRect, display: ScreenRect): CursorPt {
  const leftRoom = avatar.x - display.x;
  const rightRoom = display.x + display.width - (avatar.x + avatar.width);
  const x = leftRoom >= rightRoom ? avatar.x + avatar.width * 0.2 : avatar.x + avatar.width * 0.8;
  return { x, y: avatar.y + avatar.height * 0.64 };
}

/** A spot near his cursor, on the side toward her home, at a polite distance. */
export function followPoint(user: CursorPt, home: CursorPt, dist: number): CursorPt {
  let dx = home.x - user.x;
  let dy = home.y - user.y;
  const d = Math.hypot(dx, dy);
  if (d < 1) {
    dx = 1;
    dy = 0.6;
  }
  const n = Math.hypot(dx, dy);
  return { x: user.x + (dx / n) * dist, y: user.y + (dy / n) * dist };
}

export class Presence {
  private state: State = "boot";
  private pos: CursorPt | null = null;
  private nextWanderAt: number;
  private arriveAt = 0;
  private dwellUntil = 0;
  private kind: "user" | "look" | "near" = "near";
  private followUntil = 0;
  private lastFollowAt = 0;
  private agentIdleAt: number | null = null;
  private agentLastAt = 0;
  private wasQuiet = false;

  constructor(
    private rand: Rand = Math.random,
    now = 0,
    private o = PRESENCE,
  ) {
    this.nextWanderAt = now + o.firstWanderMs;
  }

  /** What to draw at: 0 hidden, dim while quiet, else full. */
  level(w: Pick<PresenceWorld, "shown" | "quiet">): number {
    return !w.shown ? 0 : w.quiet ? this.o.dimLevel : 1;
  }

  mode(): State {
    return this.state;
  }

  /** The core drove the cursor (task step, pointing). Presence stands aside until it's idle. */
  onAgent(e: { x: number; y: number; action: string }, now: number): void {
    this.pos = { x: e.x, y: e.y };
    this.agentLastAt = now;
    if (e.action === "idle") this.agentIdleAt = now;
    else {
      this.state = "agent";
      this.agentIdleAt = null;
    }
  }

  private range([a, b]: [number, number]) {
    return a + this.rand() * (b - a);
  }

  private go(to: CursorPt, now: number, state: State, label?: string): PresenceCmd {
    const ms = agentGlideMs(this.pos, to);
    // Idle wandering is lazier than working: 1.6x the task glide.
    const lazy = state === "agent" ? ms : Math.round(ms * 1.6);
    this.pos = { ...to };
    this.state = state;
    this.arriveAt = now + lazy;
    return { x: Math.round(to.x), y: Math.round(to.y), action: "move", ms: lazy, ...(label ? { label } : {}) };
  }

  private scheduleNext(now: number) {
    this.nextWanderAt = now + this.range([this.o.wanderMinMs, this.o.wanderMaxMs]);
  }

  tick(w: PresenceWorld): PresenceCmd[] {
    const { now } = w;
    const o = this.o;
    if (this.state === "boot") {
      this.state = "home";
      return [this.go(w.home, now, "home")];
    }
    if (this.state === "agent") {
      const silent = now - this.agentLastAt > o.agentSilenceMs;
      if ((this.agentIdleAt !== null && now - this.agentIdleAt >= o.returnAfterAgentMs) || silent) {
        this.agentIdleAt = null;
        this.scheduleNext(now);
        return [this.go(w.home, now, "returning")];
      }
      return [];
    }
    if (!w.shown) {
      // Hidden: nothing moves, and nothing is owed when she's shown again.
      this.scheduleNext(now);
      return [];
    }
    if (w.quiet) {
      // Stay still (a glide already in flight finishes where it was going).
      this.wasQuiet = true;
      this.nextWanderAt = Math.max(this.nextWanderAt, now + o.wanderMinMs);
      if (this.state === "dwell") this.dwellUntil = Math.max(this.dwellUntil, now + 1000);
      return [];
    }
    if (this.wasQuiet) {
      this.wasQuiet = false;
      if (this.state === "dwell" || this.state === "going") return [this.go(w.home, now, "returning")];
    }

    switch (this.state) {
      case "home": {
        if (this.pos && Math.hypot(this.pos.x - w.home.x, this.pos.y - w.home.y) > o.homeSlackPx) return [this.go(w.home, now, "home")];
        if (now < this.nextWanderAt) return [];
        return [this.wander(w)];
      }
      case "going":
        if (now >= this.arriveAt) {
          this.state = "dwell";
          this.dwellUntil = now + this.range(o.dwellMs);
          this.followUntil = this.kind === "user" ? now + o.followMaxMs : 0;
          this.lastFollowAt = now;
          if (this.kind === "look" && this.pos) return [{ x: Math.round(this.pos.x), y: Math.round(this.pos.y), action: "hover" }];
        }
        return [];
      case "dwell": {
        if (this.kind === "user" && w.user && this.pos && now < this.followUntil && now - this.lastFollowAt >= o.followEveryMs) {
          const d = Math.hypot(this.pos.x - w.user.x, this.pos.y - w.user.y);
          if (d < o.keepAwayPx || d > o.followDistPx[1] + 60) {
            this.lastFollowAt = now;
            this.dwellUntil = Math.max(this.dwellUntil, now + 900);
            const cmd = this.go(followPoint(w.user, w.home, this.range(o.followDistPx)), now, "dwell");
            return [cmd];
          }
        }
        if (now >= this.dwellUntil) {
          this.scheduleNext(now);
          return [this.go(w.home, now, "returning")];
        }
        return [];
      }
      case "returning":
        if (now >= this.arriveAt) this.state = "home";
        return [];
    }
    return [];
  }

  private wander(w: PresenceWorld): PresenceCmd {
    const { now } = w;
    const o = this.o;
    const userFresh = !!w.user && now - w.userMovedAt <= o.userFreshMs;
    const lookFresh = !!w.look && now - w.look.at <= o.lookFreshMs;
    const r = this.rand();
    if (lookFresh && (r < 0.45 || !userFresh)) {
      this.kind = "look";
      return this.go(w.look!.p, now, "going");
    }
    if (userFresh && r < 0.85) {
      this.kind = "user";
      return this.go(followPoint(w.user!, w.home, this.range(o.followDistPx)), now, "going");
    }
    this.kind = "near";
    const a = this.rand() * Math.PI * 2;
    const d = this.range(o.nearHome);
    return this.go({ x: w.home.x + Math.cos(a) * d, y: w.home.y + Math.sin(a) * d * 0.6 }, now, "going");
  }
}

/**
 * "He's typing fast": the system saw input within the last second, again and
 * again, while his mouse stayed put. Uses only the OS idle time (no key
 * contents, no input monitoring).
 */
export class TypingDetector {
  private busySince: number | null = null;
  private quietUntil = 0;

  constructor(
    private o = { holdMs: 1800, releaseMs: 2500 },
  ) {}

  sample(now: number, idleSec: number, mouseMovedAt: number): boolean {
    const keys = idleSec < 1 && now - mouseMovedAt > 1200;
    if (keys) {
      this.busySince ??= now;
      if (now - this.busySince >= this.o.holdMs) this.quietUntil = now + this.o.releaseMs;
    } else if (idleSec >= 1 || now - mouseMovedAt <= 1200) {
      this.busySince = null;
    }
    return now < this.quietUntil;
  }
}
