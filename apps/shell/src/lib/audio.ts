/**
 * Browsers refuse to play audio until a user gesture. The boot "begin" click
 * is the one required click in the whole demo, so it calls unlockAudio().
 * The avatar/voice layer reuses getAudioContext() for playback and lipsync.
 */

let ctx: AudioContext | null = null;
let unlocked = false;

export function getAudioContext(): AudioContext | null {
  if (ctx) return ctx;
  const AC = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!AC) return null;
  ctx = new AC() as AudioContext;
  return ctx;
}

export function isAudioUnlocked(): boolean {
  return unlocked && ctx?.state === "running";
}

/** Call from inside a click handler. Idempotent. Resolves true when audio can play. */
export async function unlockAudio(): Promise<boolean> {
  const c = getAudioContext();
  if (c) {
    try {
      // A one-sample silent buffer is the classic iOS/Safari unlock.
      const buf = c.createBuffer(1, 1, 22050);
      const src = c.createBufferSource();
      src.buffer = buf;
      src.connect(c.destination);
      src.start(0);
      if (c.state !== "running") await c.resume();
    } catch (err) {
      console.warn("[audio] unlock failed", err);
    }
  }
  try {
    // speechSynthesis also needs a gesture before its first utterance.
    const synth = globalThis.speechSynthesis;
    if (synth) {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      synth.speak(u);
      synth.getVoices();
    }
  } catch {}
  unlocked = c?.state === "running";
  return unlocked;
}

/** Tiny UI blip for theatrical moments. Silent until audio is unlocked. */
export function blip(freq = 880, ms = 70, gain = 0.035) {
  const c = ctx;
  if (!c || c.state !== "running") return;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = "sine";
  o.frequency.value = freq;
  g.gain.setValueAtTime(gain, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + ms / 1000);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + ms / 1000 + 0.02);
}
