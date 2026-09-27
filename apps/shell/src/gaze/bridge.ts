import type { BusClient } from "@eigenwife/protocol/client";
import { envelope, type RegionStats } from "@eigenwife/protocol";
import { TargetTracker, targetFromElement } from "./tracker";

export type GazeMode = "eye" | "mouse" | "auto";

export interface GazeBridge {
  mode(): "eye" | "mouse" | "none";
  stats(prefix?: string): Record<string, RegionStats>;
  reset(prefix?: string): void;
  calibrate(): Promise<{ ok: boolean; afterDeg?: number; error?: string }>;
  point(): { x: number; y: number } | null;
  /** Real document fullscreen: eye-client refuses to map gaze without it. Call from a click. */
  enterFullscreen(): Promise<boolean>;
  close(): void;
}

const EYE_HTTP = "http://127.0.0.1:8765";

/**
 * Gaze is attention, never input. This bridge turns fixations into bus events
 * (gaze.fixation / gaze.target) so Eve knows what "this" is. It prefers the
 * real tracker (`eye serve`) and falls back to the mouse pointer as a stand-in
 * for development and as a demo safety net.
 */
export function startGaze(bus: BusClient, requested: GazeMode = "auto"): GazeBridge {
  const tracker = new TargetTracker({
    fixation: (target, x, y) => bus.emit("gaze.fixation", { target, x, y }),
    fixationEnd: (target, ms) => bus.emit("gaze.fixation_end", { target, ms }),
    target: (target, dwellMs, confidence) => bus.emit("gaze.target", { target, dwellMs, confidence }),
  });
  let active: "eye" | "mouse" | "none" = "none";
  let last: { x: number; y: number } | null = null;
  let eye: any = null;
  const cleanups: (() => void)[] = [];

  const localPoint = (x: number, y: number) => {
    last = { x, y };
    // 30Hz: local listeners only (avatar eyes, debug dot), never over the wire.
    bus.dispatch(envelope("gaze.point", { x, y, nx: x / innerWidth, ny: y / innerHeight }, "shell"));
  };

  function useMouse() {
    if (active === "mouse") return;
    active = "mouse";
    bus.emit("eye.status", { connected: false, calibrated: false, facePresent: true });
    // A fixation = the pointer resting ~120ms within 24px.
    let anchor: { x: number; y: number; t: number } | null = null;
    let fixed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onMove = (ev: MouseEvent) => {
      localPoint(ev.clientX, ev.clientY);
      const now = performance.now();
      if (anchor && Math.hypot(ev.clientX - anchor.x, ev.clientY - anchor.y) < 24) return;
      if (fixed) tracker.fixationEnd(Date.now());
      fixed = false;
      anchor = { x: ev.clientX, y: ev.clientY, t: now };
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!anchor) return;
        fixed = true;
        tracker.fixationStart(targetFromElement(document.elementFromPoint(anchor.x, anchor.y)), anchor.x, anchor.y, Date.now());
      }, 120);
    };
    const tick = setInterval(() => tracker.sample(Date.now()), 100);
    addEventListener("mousemove", onMove);
    cleanups.push(() => {
      removeEventListener("mousemove", onMove);
      clearInterval(tick);
      clearTimeout(timer);
    });
  }

  async function useEye(): Promise<boolean> {
    try {
      const mod = await import(/* @vite-ignore */ `${EYE_HTTP}/eye-client.js`);
      // The tracker's own median + fast-follow smoother (screen points only, calibration stays raw).
      const smoothing = await import(/* @vite-ignore */ `${EYE_HTTP}/iphone-protocol.js`).catch(() => null);
      const gazeSmoother = smoothing?.GazeSmoother ? new smoothing.GazeSmoother({ strength: "steady" }) : null;
      eye = new mod.EyeClient({ gazeSmoother });
    } catch {
      return false;
    }
    const ok = await new Promise<boolean>((resolve) => {
      if (eye.connected) return resolve(true);
      const off = eye.on("status", (s: { connected: boolean }) => {
        if (s.connected) {
          off();
          resolve(true);
        }
      });
      setTimeout(() => resolve(eye.connected), 1500);
    });
    if (!ok) {
      eye.close();
      eye = null;
      return false;
    }
    active = "eye";
    // eye-client fires status on every quality flicker: only forward real changes.
    let lastStatus = "";
    let lastLost = "";
    const offs = [
      eye.on("status", (s: any) => {
        const radius = s.uncertaintyDeg ?? s.accuracyDeg;
        if (radius) tracker.setAccuracy(radius);
        const status = {
          connected: !!s.connected,
          calibrated: !!s.calibrated,
          accuracyDeg: s.accuracyDeg ?? undefined,
          facePresent: !!s.face,
          valid: !!s.valid,
          reason: s.reason ?? null,
          guidance: s.guidance ?? s.pose?.guidance ?? null,
          uncertaintyDeg: s.uncertaintyDeg ?? undefined,
        };
        const key = JSON.stringify(status);
        if (key === lastStatus) return;
        lastStatus = key;
        bus.emit("eye.status", status);
        if (s.connected === false) bus.emit("gaze.lost", { reason: "away" });
      }),
      // Blink, lost face, head outside the calibrated range, sample gaps, ambiguous targets:
      // the client already cleared its target, so Eve's "this" must clear too.
      eye.on("lost", (l: { reason?: string }) => {
        tracker.fixationEnd(Date.now());
        const reason = lostReason(l.reason);
        if (!reason || reason === lastLost) return;
        lastLost = reason;
        bus.emit("gaze.lost", { reason });
      }),
      eye.on("fixation", () => {
        lastLost = "";
      }),
      eye.on("gaze", (g: any) => {
        localPoint(g.x, g.y);
        tracker.sample(Date.now());
      }),
      eye.on("fixation", (f: any) => tracker.fixationStart(targetFromElement(f.el), f.x, f.y, Date.now())),
      eye.on("fixation_end", () => tracker.fixationEnd(Date.now())),
    ];
    cleanups.push(() => offs.forEach((o: () => void) => o()));
    return true;
  }

  if (requested === "mouse") useMouse();
  else
    void useEye().then((ok) => {
      if (!ok) {
        if (requested === "eye") console.warn("[gaze] eye serve not reachable at", EYE_HTTP);
        useMouse();
      }
    });

  return {
    mode: () => active,
    stats: (prefix = "") => tracker.snapshot(prefix),
    reset: (prefix = "") => tracker.reset(prefix),
    point: () => last,
    enterFullscreen,
    async calibrate() {
      if (!eye) return { ok: true, error: "mouse mode: nothing to calibrate" };
      const r = await eye.calibrate();
      return { ok: r.ok !== false && !r.error, afterDeg: r.afterDeg, error: r.error };
    },
    close() {
      cleanups.forEach((c) => c());
      eye?.close();
    },
  };
}

/** Map eye-client lost reasons onto the bus vocabulary. Target switches are not losses. */
export function lostReason(r: string | undefined): "away" | "no_face" | "offscreen" | null {
  if (!r || r === "target_changed" || r === "ambiguous_target") return null;
  if (/face/.test(r)) return "no_face";
  if (/fullscreen|geometry|viewport|display/.test(r)) return "offscreen";
  return "away";
}

export async function enterFullscreen(): Promise<boolean> {
  if (document.fullscreenElement === document.documentElement) return true;
  try {
    await document.documentElement.requestFullscreen({ navigationUI: "hide" });
    return true;
  } catch {
    return false;
  }
}

/** "eye 2.6°" when tracking, else the tracker's own short reason ("eye: enter fullscreen"). */
export function eyeLabel(eye: { valid?: boolean; reason?: string | null; accuracyDeg?: number } | null): string {
  if (eye && eye.valid === false && eye.reason) {
    const r = eye.reason.replace(/_/g, " ");
    const short = /fullscreen/.test(r) ? "enter fullscreen" : /head pose|position/.test(r) ? "sit where you calibrated" : /face/.test(r) ? "no face" : /uncalibrated/.test(r) ? "not calibrated" : r;
    return `eye: ${short.length > 28 ? short.slice(0, 27) + "…" : short}`;
  }
  return `eye${eye?.accuracyDeg ? ` ${eye.accuracyDeg.toFixed(1)}°` : ""}`;
}
