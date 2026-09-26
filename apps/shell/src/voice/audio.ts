/**
 * The one AudioContext for the whole shell. Gaze is not a user gesture, so the
 * first click / key anywhere (the calibration "start" click in the demo)
 * resumes it. Shared via globalThis so any other module that needs audio gets
 * the same context: import { getAudioContext, unlockAudio } from here.
 */

type G = typeof globalThis & { __eveAudioCtx?: AudioContext; __eveAudioUnlockWired?: boolean };
const g = globalThis as G;

export function getAudioContext(): AudioContext | null {
  if (g.__eveAudioCtx) return g.__eveAudioCtx;
  const Ctor = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!Ctor) return null;
  g.__eveAudioCtx = new Ctor({ latencyHint: "interactive" }) as AudioContext;
  return g.__eveAudioCtx;
}

export function audioUnlocked(): boolean {
  return g.__eveAudioCtx?.state === "running";
}

/** Resume the context (call from inside a user gesture). Also primes speechSynthesis. */
export async function unlockAudio(): Promise<boolean> {
  const ctx = getAudioContext();
  if (!ctx) return false;
  try {
    if (ctx.state !== "running") await ctx.resume();
    // A silent one-sample buffer fully unlocks iOS/Safari-style policies.
    const b = ctx.createBuffer(1, 1, 22050);
    const s = ctx.createBufferSource();
    s.buffer = b;
    s.connect(ctx.destination);
    s.start();
  } catch {}
  try {
    if ("speechSynthesis" in globalThis) speechSynthesis.getVoices();
  } catch {}
  return ctx.state === "running";
}

/** Unlock on the first gesture anywhere. Idempotent. */
export function wireAudioUnlock(onUnlocked?: () => void) {
  if (g.__eveAudioUnlockWired || typeof addEventListener !== "function") return;
  g.__eveAudioUnlockWired = true;
  const go = () => {
    void unlockAudio().then((ok) => {
      if (!ok) return;
      removeEventListener("pointerdown", go, true);
      removeEventListener("keydown", go, true);
      onUnlocked?.();
    });
  };
  addEventListener("pointerdown", go, true);
  addEventListener("keydown", go, true);
}
