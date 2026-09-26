import type { AvatarState, Mood } from "@eigenwife/protocol";
import { applyPoses, EmotionBlender, poseMouth } from "./emotion";
import { BlinkScheduler, breathAt, clamp, frameLerp, idleSway, SaccadeScheduler, Spring, springParams, type Rand } from "./motion-math";

/** A point in "focus space": x right, y up, both roughly -1..1 relative to her face. */
export interface Focus {
  x: number;
  y: number;
}

export interface RigInput {
  state: AvatarState;
  /** Where she should look (already mapped into focus space). */
  focus: Focus;
  /** Mouth open 0..0.7 from the lipsync envelope. */
  mouth: number;
  /** Force the mouth closed (post-speech hold). */
  mouthHold: boolean;
  /** Capture mode: no saccades, sway or random blinks (for rendering tachie stills). */
  still?: boolean;
  /** Capture mode: eyes shut. */
  eyesClosed?: boolean;
}

export interface ParamIO {
  get(id: string): number;
  set(id: string, v: number): void;
}

/** Look-at spring feel: follow 0.5, inertia 0.4 -> k=125, zeta=0.7. */
export const LOOK = { follow: 0.5, inertia: 0.4, eyeLerp: 0.3, headDeg: 30, bodyDeg: 10, headFollow: 0.5 };

const STATE_MOOD: Partial<Record<AvatarState, Mood>> = { thinking: "thinking" };

/**
 * Eve's per-frame parameter pipeline, in the order the playbook requires:
 * motion (already in the model) -> emotion pose -> blink -> look-at -> mouth -> breath.
 * All SDK built-ins (expressions, eye blink, breath, focus) are disabled by the
 * Live2D adapter, so nothing fights us.
 */
export class EveRig {
  readonly emotion = new EmotionBlender();
  readonly blink: BlinkScheduler;
  readonly saccade: SaccadeScheduler;
  private headX: Spring;
  private headY: Spring;
  private eyeX = 0;
  private eyeY = 0;
  private lastState: AvatarState = "idle";
  private stateAt = 0;
  /** Visible hooks for overlays / tests. */
  last = { blink: null as number | null, eyeOpen: 1, headX: 0, headY: 0 };

  constructor(rand: Rand = Math.random, now = 0) {
    this.blink = new BlinkScheduler(rand, now);
    this.saccade = new SaccadeScheduler(rand, now);
    const p = springParams(LOOK.follow, LOOK.inertia);
    this.headX = new Spring(0, p.k, p.c);
    this.headY = new Spring(0, p.k, p.c);
  }

  setMood(mood: Mood, intensity: number, now: number, holdMs?: number) {
    this.emotion.set(mood, intensity, now, holdMs);
    if (mood === "surprised") this.blink.trigger(now + 1); // a startled blink reads well
  }

  frame(io: ParamIO, input: RigInput, dtMs: number, now: number) {
    const { state } = input;
    if (state !== this.lastState) {
      // Waking up: a blink right as the eyes open sells it.
      if (this.lastState === "sleeping") this.blink.trigger(now);
      this.lastState = state;
      this.stateAt = now;
    }
    const sleeping = state === "sleeping";
    this.emotion.sustain(STATE_MOOD[state] ?? null, 1);
    this.saccade.paused = state === "thinking" || sleeping || !!input.still;

    // 1. motion: already written into the model by the motion manager.

    // 2. emotion pose.
    const weights = this.emotion.weights(now);
    applyPoses(weights, io.get, io.set);
    if (sleeping) {
      io.set("ParamEyeLOpen", 0);
      io.set("ParamEyeROpen", 0);
      io.set("ParamEyeLSmile", 0.4);
      io.set("ParamEyeRSmile", 0.4);
      io.set("ParamMouthForm", 0.2);
    }
    // Happy onset: a small spring bob of the head.
    const sinceHappy = now - this.emotion.onsetAt;
    if ((weights.happy ?? 0) > 0.05 && sinceHappy < 1400) {
      const bob = 5 * Math.exp(-sinceHappy / 380) * Math.sin((2 * Math.PI * sinceHappy) / 420);
      io.set("ParamAngleY", io.get("ParamAngleY") + bob);
      io.set("ParamBodyAngleY", io.get("ParamBodyAngleY") + bob * 0.4);
    }

    // 3. blink: multiplier on the pose's eye value, only written during a blink.
    const eyeL = io.get("ParamEyeLOpen");
    const eyeR = io.get("ParamEyeROpen");
    const b = input.eyesClosed ? 0 : sleeping || input.still ? null : this.blink.update(now);
    if (b !== null) {
      io.set("ParamEyeLOpen", eyeL * b);
      io.set("ParamEyeROpen", eyeR * b);
    }
    this.last.blink = b;
    this.last.eyeOpen = b === null ? eyeL : eyeL * b;

    // 4. look-at: head on a spring, eyes lerp 0.3/frame, saccades on top.
    this.saccade.update(now);
    const lookGain = state === "thinking" ? 0.25 : sleeping ? 0 : 1;
    const fx = clamp(input.focus.x, -1, 1) * lookGain;
    const fy = clamp(input.focus.y, -1, 1) * lookGain + (sleeping ? -0.35 : 0);
    const hx = this.headX.step(fx + this.saccade.x * LOOK.headFollow, dtMs);
    const hy = this.headY.step(fy + this.saccade.y * LOOK.headFollow, dtMs);
    const a = frameLerp(LOOK.eyeLerp, dtMs);
    this.eyeX += (clamp(fx + this.saccade.x, -1, 1) - this.eyeX) * a;
    this.eyeY += (clamp(fy + this.saccade.y, -1, 1) - this.eyeY) * a;
    const sway = input.still ? { x: 0, y: 0, z: 0 } : idleSway(now);
    const listen = state === "listening" ? 1 : 0;
    io.set("ParamAngleX", io.get("ParamAngleX") + hx * LOOK.headDeg + sway.x);
    io.set("ParamAngleY", io.get("ParamAngleY") + hy * LOOK.headDeg + sway.y + listen * 4);
    io.set("ParamAngleZ", io.get("ParamAngleZ") - hx * hy * 20 + sway.z + listen * 5);
    io.set("ParamBodyAngleX", io.get("ParamBodyAngleX") + hx * LOOK.bodyDeg + sway.x * 0.4);
    io.set("ParamBodyAngleY", io.get("ParamBodyAngleY") + listen * 3);
    io.set("ParamEyeBallX", io.get("ParamEyeBallX") + this.eyeX);
    io.set("ParamEyeBallY", io.get("ParamEyeBallY") + this.eyeY);
    this.last.headX = hx;
    this.last.headY = hy;

    // 5. mouth.
    if (input.mouthHold || sleeping) io.set("ParamMouthOpenY", 0);
    else {
      io.set("ParamMouthOpenY", Math.max(poseMouth(weights), input.mouth));
      if (input.mouth > 0.05) io.set("ParamAngleY", io.get("ParamAngleY") + input.mouth * 3);
    }

    // 6. breath (slower while asleep).
    io.set("ParamBreath", breathAt(now, sleeping ? 1.8 : 1));
  }

  get stateSince() {
    return this.stateAt;
  }
}
