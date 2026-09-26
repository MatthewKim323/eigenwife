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
      eye = new mod.EyeClient();
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
    const offs = [
      eye.on("status", (s: any) => {
        if (s.accuracyDeg) tracker.setAccuracy(s.accuracyDeg);
        bus.emit("eye.status", { connected: s.connected, calibrated: s.calibrated, accuracyDeg: s.accuracyDeg, facePresent: s.face });
        if (s.connected === false) bus.emit("gaze.lost", { reason: "away" });
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
