import type { EventMap, GazeTarget } from "@eigenwife/protocol";
import type { AxHit } from "../screen/capture";

/**
 * Desktop gaze: what you're looking at on the real screen, not just inside the
 * shell page. eye serve streams fixations in global screen points; each settled
 * fixation is resolved to the accessibility element under it (screen-ax at),
 * run through the screen module's privacy rules, and announced as gaze.target
 * while you keep looking. The reflex stare rules take it from there: a glance at
 * 2.5s, "that caught your eye" at 4s.
 *
 * Pure state machine: the module feeds it eye messages and ticks, and gives it a
 * resolver and an emitter. Nothing here touches the network or the disk.
 */

export interface EyeMsg {
  type: string;
  [k: string]: unknown;
}

export interface Resolved {
  target: GazeTarget;
  frame?: { x: number; y: number; w: number; h: number };
  confidence: number;
}

/** Why a point can't be announced: private window, Eve herself, nothing there. */
export type Skip = { skip: "private" | "eve" | "none" | "paused" | "error"; why?: string };

export interface DesktopGazeDeps {
  resolve(x: number, y: number): Promise<Resolved | Skip>;
  emit<K extends keyof EventMap>(type: K, data: EventMap[K]): void;
  paused(): boolean;
}

export interface DesktopGazeOptions {
  /** A fixation must hold this long before we spend an AX lookup on it. */
  settleMs?: number;
  /** Re-announce the current target this often while you keep looking (rules need < 6s gaps). */
  announceMs?: number;
  /** Look back at the same target within this gap and the stare continues. */
  continuityMs?: number;
  /** Re-resolve if the fixation center drifts this far (points). */
  moveTolerancePt?: number;
  /** Never resolve more often than this. */
  minResolveGapMs?: number;
}

interface Fix {
  id: number;
  x: number;
  y: number;
  since: number;
  resolvedAt?: number;
  resolving?: boolean;
  at?: { x: number; y: number };
}

interface Current {
  resolved: Resolved;
  /** When this target was first looked at, across short breaks (for dwellMs). */
  since: number;
  lastSeen: number;
  lastAnnounced: number;
}

export class DesktopGaze {
  private o: Required<DesktopGazeOptions>;
  private fix: Fix | null = null;
  private cur: Current | null = null;
  private lastResolveAt = -Infinity;
  private face: boolean | null = null;
  private status: { connected: boolean; calibrated: boolean; accuracyDeg?: number } = { connected: false, calibrated: false };
  private lastStatusKey = "";
  private lastLostReason = "";
  readonly stats = { fixations: 0, resolves: 0, announced: 0, private: 0, eve: 0, none: 0, errors: 0 };

  constructor(
    private d: DesktopGazeDeps,
    opts: DesktopGazeOptions = {},
  ) {
    this.o = { settleMs: 350, announceMs: 1200, continuityMs: 1500, moveTolerancePt: 90, minResolveGapMs: 400, ...opts };
  }

  connected(up: boolean) {
    this.status = { ...this.status, connected: up };
    if (!up) {
      this.fix = null;
      this.lose("away");
    }
    this.pushStatus();
  }

  /** One message from eye serve's websocket. */
  onMessage(m: EyeMsg, now: number) {
    switch (m.type) {
      case "hello":
        this.status = { connected: true, calibrated: m.calibrated === true, accuracyDeg: num(m.accuracyDeg) };
        if (typeof m.face === "boolean") this.face = m.face;
        this.pushStatus();
        return;
      case "face":
        this.face = m.present === true;
        this.pushStatus();
        if (!this.face) {
          this.fix = null;
          this.lose("no_face");
        }
        return;
      case "fixation_start": {
        const x = num(m.x);
        const y = num(m.y);
        const id = num(m.id);
        if (x === undefined || y === undefined || id === undefined) return;
        this.stats.fixations++;
        this.fix = { id, x, y, since: now };
        return;
      }
      case "fixation_end":
        if (this.fix && num(m.id) === this.fix.id) {
          if (this.cur) this.d.emit("gaze.fixation_end", { target: this.cur.resolved.target, ms: Math.max(0, now - this.fix.since) });
          this.fix = null;
        }
        return;
      case "gaze": {
        if (m.valid === false) {
          // Blinks are part of looking: they don't end a stare. Everything else does.
          if (m.blink === true || m.reason === "blink") return;
          this.fix = null;
          this.lose(String(m.reason ?? "").includes("face") ? "no_face" : "away");
          return;
        }
        const fix = m.fix as { id?: number } | null | undefined;
        const x = num(m.x);
        const y = num(m.y);
        // Track the fixation center as it settles (the start point is the first sample).
        if (this.fix && fix && fix.id === this.fix.id && x !== undefined && y !== undefined) {
          this.fix.x = this.fix.x * 0.8 + x * 0.2;
          this.fix.y = this.fix.y * 0.8 + y * 0.2;
        }
        return;
      }
    }
  }

  /** Drive resolution and re-announcement. Call every ~200ms. */
  async tick(now: number): Promise<void> {
    if (this.d.paused()) {
      if (this.cur) this.lose("offscreen");
      return;
    }
    const f = this.fix;
    if (f && !f.resolving && now - f.since >= this.o.settleMs && now - this.lastResolveAt >= this.o.minResolveGapMs) {
      const moved = f.at ? Math.hypot(f.x - f.at.x, f.y - f.at.y) > this.o.moveTolerancePt : true;
      if (f.resolvedAt === undefined || moved) await this.resolve(f, now);
    }
    const c = this.cur;
    if (c && this.fix && now - c.lastAnnounced >= this.o.announceMs) this.announce(c, now);
    // Looked away for good: the next target starts a fresh stare.
    if (c && !this.fix && now - c.lastSeen > this.o.continuityMs) this.cur = null;
  }

  private async resolve(f: Fix, now: number) {
    f.resolving = true;
    this.lastResolveAt = now;
    this.stats.resolves++;
    let r: Resolved | Skip;
    try {
      r = await this.d.resolve(f.x, f.y);
    } catch {
      r = { skip: "error" };
    } finally {
      f.resolving = false;
    }
    // The fixation ended while we were asking: drop it.
    if (this.fix !== f) return;
    f.resolvedAt = now;
    f.at = { x: f.x, y: f.y };
    if ("skip" in r) {
      this.stats[r.skip === "paused" ? "private" : r.skip === "error" ? "errors" : r.skip]++;
      // Private, Eve, or nothing: never announce it, and it breaks any stare in progress.
      if (r.skip !== "error") this.lose("offscreen");
      return;
    }
    const same = this.cur && this.cur.resolved.target.key === r.target.key && now - this.cur.lastSeen <= this.o.continuityMs + this.o.announceMs;
    if (same) {
      this.cur!.resolved = r;
      this.cur!.lastSeen = now;
    } else {
      this.cur = { resolved: r, since: f.since, lastSeen: now, lastAnnounced: -Infinity };
      this.d.emit("gaze.fixation", { target: r.target, x: f.x, y: f.y });
    }
    this.lastLostReason = "";
    this.announce(this.cur!, now);
  }

  private announce(c: Current, now: number) {
    c.lastSeen = now;
    c.lastAnnounced = now;
    this.stats.announced++;
    this.d.emit("gaze.target", { target: c.resolved.target, dwellMs: Math.max(0, now - c.since), confidence: c.resolved.confidence });
  }

  private lose(reason: EventMap["gaze.lost"]["reason"]) {
    this.cur = null;
    if (this.lastLostReason === reason) return;
    this.lastLostReason = reason;
    this.d.emit("gaze.lost", { reason });
  }

  private pushStatus() {
    const s: EventMap["eye.status"] = {
      connected: this.status.connected,
      calibrated: this.status.calibrated,
      ...(this.status.accuracyDeg !== undefined ? { accuracyDeg: this.status.accuracyDeg } : {}),
      ...(this.face !== null ? { facePresent: this.face } : {}),
    };
    const key = JSON.stringify(s);
    if (key === this.lastStatusKey) return;
    this.lastStatusKey = key;
    this.d.emit("eye.status", s);
  }

  snapshot() {
    return { fixating: !!this.fix, current: this.cur ? { key: this.cur.resolved.target.key, label: this.cur.resolved.target.label, dwellMs: Date.now() - this.cur.since } : null, face: this.face, status: this.status, stats: this.stats };
  }
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

// ---------------------------------------------------------------------------
// AX hit -> GazeTarget
// ---------------------------------------------------------------------------

const UI_ROLES = new Set(["AXMenuBar", "AXMenuBarItem", "AXMenu", "AXMenuItem", "AXButton", "AXTab", "AXTabGroup", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXToolbar", "AXScrollBar", "AXSlider", "AXIncrementor", "AXDisclosureTriangle", "AXSplitter"]);

function hash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/**
 * "desk:<app>:<role>:<content hash>". Stable while you keep looking at the same
 * thing: keyed by what it says, not where it sits (frames jitter by a point or
 * two between lookups). Only an unlabeled, untitled hit falls back to position.
 */
export function targetKey(hit: Pick<AxHit, "app" | "bundleId" | "role" | "label" | "title" | "frame">): string {
  const app = (hit.bundleId || hit.app || "app").toLowerCase().replace(/[^a-z0-9.]+/g, "-");
  const content = hit.label || hit.title ? `${hit.label}|${hit.title ?? ""}` : hit.frame ? `@${Math.round((hit.frame.x + hit.frame.w / 2) / 150)}.${Math.round((hit.frame.y + hit.frame.h / 2) / 150)}` : "?";
  return `desk:${app}:${(hit.role ?? "").replace(/^AX/, "").toLowerCase()}:${hash(content)}`;
}

export function kindFor(hit: Pick<AxHit, "role" | "bundleId" | "coarse">): GazeTarget["kind"] {
  if (hit.bundleId === "com.apple.dock") return "app";
  if (hit.role && UI_ROLES.has(hit.role)) return "ui";
  return "other";
}

/**
 * Turn a (non-private, already redacted) hit into a gaze target. The label is
 * what Eve reads in her prompt, so it says what and where:
 * "Garlic Knockout Ramen $21 (Chrome, menshotokyo.com)".
 */
export function toTarget(hit: AxHit & { label: string }, point: { x: number; y: number }, host: string | null, accuracyPt: number): Resolved {
  const where = [hit.app, host ?? (hit.title ? clip(hit.title, 50) : "")].filter(Boolean).join(", ");
  const text = cleanLabel(hit.label);
  const what = hit.coarse || !text ? (hit.title ? `the ${hit.app} window "${clip(hit.title, 60)}"` : `${hit.app}`) : clip(text, 140);
  const label = hit.coarse || !text ? what : `${what} (${where})`;
  const area = hit.frame ? hit.frame.w * hit.frame.h : 0;
  // Bigger than the gaze error circle = we're probably right about which thing it is.
  const circle = Math.PI * accuracyPt * accuracyPt;
  const confidence = hit.coarse ? 0.45 : area <= 0 ? 0.5 : Math.max(0.35, Math.min(0.9, 0.35 + 0.55 * Math.min(1, area / (circle * 1.5))));
  return {
    target: {
      key: targetKey(hit),
      label,
      kind: kindFor(hit),
      meta: {
        source: "desktop",
        app: hit.app,
        ...(host ? { host } : {}),
        ...(hit.role ? { role: hit.role.replace(/^AX/, "") } : {}),
        point: { x: Math.round(point.x), y: Math.round(point.y) },
      },
    },
    ...(hit.frame ? { frame: hit.frame } : {}),
    confidence: Math.round(confidence * 100) / 100,
  };
}

/** "* Built with · Built with · You can add up to 25 tags. · *" -> "Built with · You can add up to 25 tags." */
export function cleanLabel(raw: string): string {
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const p of raw.split(" · ")) {
    const t = p.replace(/\s+/g, " ").trim().replace(/^[^\p{L}\p{N}"'(]+/u, "").replace(/[\s*•·|:-]+$/u, "");
    if (t.replace(/[^\p{L}\p{N}]/gu, "").length < 2) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    parts.push(t);
  }
  return parts.join(" · ");
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
