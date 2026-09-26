import type { GazeTarget, RegionStats } from "@eigenwife/protocol";

export interface TrackerOut {
  fixation(target: GazeTarget | null, x: number, y: number): void;
  fixationEnd(target: GazeTarget | null, ms: number): void;
  target(target: GazeTarget, dwellMs: number, confidence: number): void;
}

export interface TrackerOptions {
  /** A single fixation this long promotes its element to the attention target. */
  promoteMs?: number;
  /** Same element on this many consecutive fixations promotes it too. */
  promoteCount?: number;
  /** Don't re-announce the same target within this window. */
  repeatMs?: number;
  /** Tracker accuracy in degrees, folded into confidence. */
  accuracyDeg?: number;
}

/**
 * Pure attention logic, independent of where fixations come from (eye serve or
 * the mouse fallback). Turns a stream of fixations into region stats and
 * stable "this is what they're looking at" targets.
 */
export class TargetTracker {
  private stats = new Map<string, RegionStats>();
  private lastKey: string | null = null;
  private streak = 0;
  private current: { target: GazeTarget | null; start: number } | null = null;
  private announced = new Map<string, number>();
  private opts: Required<TrackerOptions>;

  constructor(private out: TrackerOut, opts: TrackerOptions = {}) {
    this.opts = { promoteMs: 550, promoteCount: 2, repeatMs: 2500, accuracyDeg: 2.5, ...opts };
  }

  setAccuracy(deg: number) {
    this.opts.accuracyDeg = deg;
  }

  fixationStart(target: GazeTarget | null, x: number, y: number, now: number) {
    if (this.current) this.fixationEnd(now);
    this.current = { target, start: now };
    const key = target?.key ?? null;
    if (key) {
      const s = this.stat(key);
      if (key !== this.lastKey) s.visits += 1;
      s.revisits = Math.max(0, s.visits - 1);
    }
    this.streak = key && key === this.lastKey ? this.streak + 1 : key ? 1 : 0;
    this.lastKey = key;
    this.out.fixation(target, x, y);
    if (target && this.streak >= this.opts.promoteCount) this.promote(target, 0, now);
  }

  fixationEnd(now: number) {
    const cur = this.current;
    if (!cur) return;
    this.current = null;
    const ms = Math.max(0, now - cur.start);
    if (cur.target) {
      const s = this.stat(cur.target.key);
      s.dwellMs += ms;
      s.longestMs = Math.max(s.longestMs, ms);
      if (ms >= this.opts.promoteMs) this.promote(cur.target, ms, now);
    }
    this.out.fixationEnd(cur.target, ms);
  }

  /** Called on every gaze sample so long fixations promote before they end. */
  sample(now: number) {
    const cur = this.current;
    if (cur?.target && now - cur.start >= this.opts.promoteMs) this.promote(cur.target, now - cur.start, now);
  }

  private promote(target: GazeTarget, dwellMs: number, now: number) {
    const last = this.announced.get(target.key);
    if (last !== undefined && now - last < this.opts.repeatMs) return;
    this.announced.set(target.key, now);
    // Confidence: long dwell and good accuracy help, capped below 1.
    const dwellFactor = Math.min(1, 0.55 + dwellMs / 2000 + (this.streak - 1) * 0.1);
    const accFactor = Math.max(0.4, Math.min(1, 1.6 - this.opts.accuracyDeg / 4));
    this.out.target(target, dwellMs, Math.min(0.98, dwellFactor * accFactor));
  }

  private stat(key: string): RegionStats {
    let s = this.stats.get(key);
    if (!s) this.stats.set(key, (s = { dwellMs: 0, visits: 0, revisits: 0, longestMs: 0 }));
    return s;
  }

  /** Stats for keys matching a prefix (e.g. one candidate's regions). Includes an in-flight fixation. */
  snapshot(prefix = "", now = Date.now()): Record<string, RegionStats> {
    const out: Record<string, RegionStats> = {};
    for (const [k, v] of this.stats) if (k.startsWith(prefix)) out[k] = { ...v };
    const cur = this.current;
    if (cur?.target && cur.target.key.startsWith(prefix)) {
      const s = (out[cur.target.key] ??= { dwellMs: 0, visits: 1, revisits: 0, longestMs: 0 });
      const ms = now - cur.start;
      s.dwellMs += ms;
      s.longestMs = Math.max(s.longestMs, ms);
    }
    return out;
  }

  reset(prefix = "") {
    for (const k of [...this.stats.keys()]) if (k.startsWith(prefix)) this.stats.delete(k);
  }
}

/** Read a GazeTarget off a DOM element's data-gaze-* attributes. */
export function targetFromElement(el: Element | null): GazeTarget | null {
  const host = el?.closest?.("[data-gaze]") as HTMLElement | null;
  if (!host) return null;
  const d = host.dataset;
  let meta: Record<string, unknown> | undefined;
  if (d.gazeMeta) {
    try {
      meta = JSON.parse(d.gazeMeta);
    } catch {}
  }
  return {
    key: d.gaze!,
    label: d.gazeLabel ?? host.getAttribute("aria-label") ?? host.textContent?.trim().slice(0, 80) ?? d.gaze!,
    kind: (d.gazeKind as GazeTarget["kind"]) ?? "other",
    ...(meta ? { meta } : {}),
  };
}

/** Props helper so components tag themselves in one spread. */
export function gazeProps(key: string, label: string, kind: GazeTarget["kind"], meta?: Record<string, unknown>) {
  return {
    "data-gaze": key,
    "data-gaze-label": label,
    "data-gaze-kind": kind,
    ...(meta ? { "data-gaze-meta": JSON.stringify(meta) } : {}),
  };
}
