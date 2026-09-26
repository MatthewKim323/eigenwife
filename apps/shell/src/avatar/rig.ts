import type { AvatarState, Mood } from "@eigenwife/protocol";
import { applyPoses, EmotionBlender, poseMouth } from "./emotion";
import { HARU, type ModelDef, type ParamMap, type Pose, type PoseTable } from "./models";
import { BlinkScheduler, breathAt, clamp, easeInOutCubic, frameLerp, idleSway, SaccadeScheduler, Spring, springParams, type Rand } from "./motion-math";
import { WardrobeLayer } from "./wardrobe";

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
  /** How much the head follows the focus (eyes always follow fully). Default 1; ~0.5 while tracking the cursor. */
  headGain?: number;
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
 * motion -> face rest -> emotion pose -> wardrobe -> blink -> look-at -> mouth -> breath.
 * All SDK built-ins (expressions, eye blink, breath, focus) are disabled by the
 * Live2D adapter, so nothing fights us. Parameter ids come from the model def.
 */
export class EveRig {
  readonly emotion = new EmotionBlender();
  /** Outfits + accents (wardrobe.ts), applied right after the mood poses. */
  readonly wardrobe = new WardrobeLayer();
  /** Touch one-shots: eyes held shut (a head pat) and a small body bounce (a poke). */
  private eyesShut: { from: number; until: number } | null = null;
  private bounceAt = -Infinity;
  readonly blink: BlinkScheduler;
  readonly saccade: SaccadeScheduler;
  private headX: Spring;
  private headY: Spring;
  private eyeX = 0;
  private eyeY = 0;
  private lastState: AvatarState = "idle";
  private stateAt = 0;
  private model: ModelDef = HARU;
  private P: ParamMap = HARU.params;
  private poses: PoseTable = HARU.poses;
  /** Visible hooks for overlays / tests. */
  last = { blink: null as number | null, eyeOpen: 1, headX: 0, headY: 0 };

  constructor(rand: Rand = Math.random, now = 0) {
    this.blink = new BlinkScheduler(rand, now);
    this.saccade = new SaccadeScheduler(rand, now);
    const p = springParams(LOOK.follow, LOOK.inertia);
    this.headX = new Spring(0, p.k, p.c);
    this.headY = new Spring(0, p.k, p.c);
  }

  /** Switch model: ids, face rest and poses (built from the model's expressions, see buildPoses). */
  setModel(def: ModelDef, poses: PoseTable = def.poses, toggles: { wardrobe?: Record<string, Pose>; accents?: Record<string, Pose> } = {}, now = 0) {
    this.model = def;
    this.P = def.params;
    this.poses = poses;
    this.wardrobe.setModel(def, toggles.wardrobe ?? {}, toggles.accents ?? {}, now);
  }

  /** What she has on (wardrobe item ids). Fades ~250ms. Ids the model can't show are ignored. */
  setOutfit(items: string[], now: number) {
    this.wardrobe.set(items, now);
  }

  /** Eyes eased shut for ms (a head pat). */
  closeEyes(now: number, ms: number) {
    this.eyesShut = { from: now, until: now + ms };
  }

  /** A tiny startled hop (a poke). */
  bounce(now: number) {
    this.bounceAt = now;
  }

  get modelDef() {
    return this.model;
  }

  get poseTable() {
    return this.poses;
  }

  setMood(mood: Mood, intensity: number, now: number, holdMs?: number) {
    this.emotion.set(mood, intensity, now, holdMs);
    if (mood === "surprised") this.blink.trigger(now + 1); // a startled blink reads well
  }

  frame(io: ParamIO, input: RigInput, dtMs: number, now: number) {
    const P = this.P;
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

    // 1. motion: already written into the model by the motion manager. Its
    //    face curves (blinks, smiles, brow twitches) are pinned back to rest:
    //    the face only moves on our events, never on the idle loop's schedule.
    for (const [id, v] of Object.entries(this.model.faceRest)) io.set(id, v);

    // 2. emotion pose, then the wardrobe on top (moods never clear an outfit).
    const weights = this.emotion.weights(now);
    const worn = this.wardrobe.before(io.get);
    applyPoses(this.poses, weights, io.get, io.set);
    this.wardrobe.apply(worn, now, io.get, io.set);
    if (sleeping) {
      io.set(P.eyeLOpen, 0);
      io.set(P.eyeROpen, 0);
      io.set(P.eyeLSmile, 0.4);
      io.set(P.eyeRSmile, 0.4);
      io.set(P.mouthForm, 0.2);
    }
    // Happy onset: a small spring bob of the head.
    const sinceHappy = now - this.emotion.onsetAt;
    if ((weights.happy ?? 0) > 0.05 && sinceHappy < 1400) {
      const bob = 5 * Math.exp(-sinceHappy / 380) * Math.sin((2 * Math.PI * sinceHappy) / 420);
      io.set(P.angleY, io.get(P.angleY) + bob);
      io.set(P.bodyY, io.get(P.bodyY) + bob * 0.4);
    }

    // A poke: a small decaying hop of the body.
    const sinceBounce = now - this.bounceAt;
    if (sinceBounce >= 0 && sinceBounce < 700) {
      const hop = bounceAt(sinceBounce);
      io.set(P.bodyY, io.get(P.bodyY) + hop * 6);
      io.set(P.angleY, io.get(P.angleY) + hop * 5);
    }

    // A pat: eyes eased shut, then open again.
    if (this.eyesShut) {
      const k = shutAt(now, this.eyesShut.from, this.eyesShut.until);
      if (k <= 0 && now > this.eyesShut.until) this.eyesShut = null;
      else {
        io.set(P.eyeLOpen, io.get(P.eyeLOpen) * (1 - k));
        io.set(P.eyeROpen, io.get(P.eyeROpen) * (1 - k));
        io.set(P.eyeLSmile, Math.max(io.get(P.eyeLSmile), k * 0.8));
        io.set(P.eyeRSmile, Math.max(io.get(P.eyeRSmile), k * 0.8));
      }
    }

    // 3. blink: multiplier on the pose's eye value, only written during a blink.
    const eyeL = io.get(P.eyeLOpen);
    const eyeR = io.get(P.eyeROpen);
    const b = input.eyesClosed ? 0 : sleeping || input.still ? null : this.blink.update(now);
    if (b !== null) {
      io.set(P.eyeLOpen, eyeL * b);
      io.set(P.eyeROpen, eyeR * b);
    }
    this.last.blink = b;
    this.last.eyeOpen = b === null ? eyeL : eyeL * b;

    // 4. look-at: head on a spring, eyes lerp 0.3/frame, saccades on top.
    this.saccade.update(now);
    const lookGain = state === "thinking" ? 0.25 : sleeping ? 0 : 1;
    const fx = clamp(input.focus.x, -1, 1) * lookGain;
    const fy = clamp(input.focus.y, -1, 1) * lookGain + (sleeping ? -0.35 : 0);
    const hg = input.headGain ?? 1;
    const hx = this.headX.step(fx * hg + this.saccade.x * LOOK.headFollow, dtMs);
    const hy = this.headY.step(fy * hg + this.saccade.y * LOOK.headFollow, dtMs);
    const a = frameLerp(LOOK.eyeLerp, dtMs);
    this.eyeX += (clamp(fx + this.saccade.x, -1, 1) - this.eyeX) * a;
    this.eyeY += (clamp(fy + this.saccade.y, -1, 1) - this.eyeY) * a;
    const sway = input.still ? { x: 0, y: 0, z: 0 } : idleSway(now);
    const listen = state === "listening" ? 1 : 0;
    io.set(P.angleX, io.get(P.angleX) + hx * LOOK.headDeg + sway.x);
    io.set(P.angleY, io.get(P.angleY) + hy * LOOK.headDeg + sway.y + listen * 4);
    io.set(P.angleZ, io.get(P.angleZ) - hx * hy * 20 + sway.z + listen * 5);
    io.set(P.bodyX, io.get(P.bodyX) + hx * LOOK.bodyDeg + sway.x * 0.4);
    io.set(P.bodyY, io.get(P.bodyY) + listen * 3);
    io.set(P.eyeBallX, io.get(P.eyeBallX) + this.eyeX);
    io.set(P.eyeBallY, io.get(P.eyeBallY) + this.eyeY);
    this.last.headX = hx;
    this.last.headY = hy;

    // 5. mouth.
    if (input.mouthHold || sleeping) io.set(P.mouthOpen, 0);
    else {
      io.set(P.mouthOpen, Math.max(poseMouth(this.poses, weights, P.mouthOpen), input.mouth));
      if (input.mouth > 0.05) io.set(P.angleY, io.get(P.angleY) + input.mouth * 3);
    }

    // 6. breath (slower while asleep).
    io.set(P.breath, breathAt(now, sleeping ? 1.8 : 1));
  }

  get stateSince() {
    return this.stateAt;
  }
}

/** Bounce profile 0..1 over ~700ms: a quick hop up, a small settle. */
export function bounceAt(ms: number): number {
  if (ms < 0 || ms >= 700) return 0;
  return Math.exp(-ms / 180) * Math.sin((2 * Math.PI * ms) / 360);
}

/** Eyes-shut amount 0..1: 150ms in, hold, 220ms out after `until`. */
export function shutAt(now: number, from: number, until: number): number {
  if (now < from) return 0;
  if (now < until) return easeInOutCubic(Math.min(1, (now - from) / 150));
  return 1 - easeInOutCubic(Math.min(1, (now - until) / 220));
}
