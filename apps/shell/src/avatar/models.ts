import type { Mood } from "@eigenwife/protocol";

/**
 * Avatar model registry. Everything model-specific lives here: where the
 * files are, which parameter ids the rig drives, the emotion pose table
 * (the model's own expressions blended with our overrides), which params the
 * idle motion must never touch, and how she's framed in each dock.
 *
 * Selected by `?model=<id>` (or a direct `...model3.json` URL for trying a
 * new model), then the build-time `EVE_MODEL` env, then DEFAULT_MODEL.
 */

export interface PoseEntry {
  v: number;
  /** "abs" (default) lerps toward v, "add" adds v * w, "mul" scales by 1 + (v - 1) * w. */
  op?: "abs" | "add" | "mul";
}
export type Pose = Record<string, PoseEntry>;
export type PoseTable = Record<Mood, Pose>;

/** Logical parameters the rig writes every frame. */
export type ParamKey =
  | "angleX"
  | "angleY"
  | "angleZ"
  | "bodyX"
  | "bodyY"
  | "eyeLOpen"
  | "eyeROpen"
  | "eyeLSmile"
  | "eyeRSmile"
  | "eyeBallX"
  | "eyeBallY"
  | "mouthOpen"
  | "mouthForm"
  | "breath";
export type ParamMap = Record<ParamKey, string>;

/** Cubism standard ids (Haru, Hiyori, most official samples). */
export const STANDARD_PARAMS: ParamMap = {
  angleX: "ParamAngleX",
  angleY: "ParamAngleY",
  angleZ: "ParamAngleZ",
  bodyX: "ParamBodyAngleX",
  bodyY: "ParamBodyAngleY",
  eyeLOpen: "ParamEyeLOpen",
  eyeROpen: "ParamEyeROpen",
  eyeLSmile: "ParamEyeLSmile",
  eyeRSmile: "ParamEyeRSmile",
  eyeBallX: "ParamEyeBallX",
  eyeBallY: "ParamEyeBallY",
  mouthOpen: "ParamMouthOpenY",
  mouthForm: "ParamMouthForm",
  breath: "ParamBreath",
};

/** Where the model sits inside the 560x840 canvas box, per dock. */
export interface Framing {
  /** Model height as a multiple of the box height. */
  scale: number;
  /** Top of the model, as a fraction of the box height (negative = above the box). */
  y: number;
  /** Horizontal center, fraction of box width. */
  x: number;
  /** Where her head (between the eyes) lands in the box, fractions. For look-at mapping. */
  head: { x: number; y: number };
}
export type FramingSlot = "column" | "stage" | "overlay";

export interface ModelDef {
  id: string;
  name: string;
  /** URL of the *.model3.json. */
  url: string;
  params: ParamMap;
  /**
   * Face params pinned to these rest values every frame, right after the
   * motion stage. Idle motions carry blinks, smiles and brow twitches of their
   * own; pinning them means her face only changes on avatar.mood, speech marks
   * or avatar.state (and our own blink / look-at / lipsync).
   */
  faceRest: Record<string, number>;
  /** Model expressions (exp3 names) that seed each mood's pose; `poses` overrides on top. */
  expressions: Partial<Record<Mood, string>>;
  /** Our overrides per mood. Merged over the expression params by `buildPoses`. */
  poses: PoseTable;
  /** Motion group for the looping body idle (head drift, breathing shoulders). */
  idleMotionGroup: string;
  framing: Record<FramingSlot, Framing>;
  /** Short license note (see docs/AVATAR.md). */
  license: string;
}

const abs = (v: number): PoseEntry => ({ v });
const add = (v: number): PoseEntry => ({ v, op: "add" });

/**
 * Haru: the receptionist from the official Cubism samples. An adult woman in
 * office wear. Ships F01-F08 expressions; the idle motion carries its own
 * blinks and mouth shapes, which faceRest pins.
 */
export const HARU: ModelDef = {
  id: "haru",
  name: "Haru",
  url: "/avatar/haru/Haru.model3.json",
  params: STANDARD_PARAMS,
  faceRest: {
    ParamEyeLOpen: 1,
    ParamEyeROpen: 1,
    ParamEyeLSmile: 0,
    ParamEyeRSmile: 0,
    ParamEyeForm: 0,
    ParamEyeBallForm: 0,
    ParamEyeBallX: 0,
    ParamEyeBallY: 0,
    ParamTear: 0,
    ParamTere: 0,
    ParamBrowLY: 0,
    ParamBrowRY: 0,
    ParamBrowLX: 0,
    ParamBrowRX: 0,
    ParamBrowLAngle: 0,
    ParamBrowRAngle: 0,
    ParamBrowLForm: 0,
    ParamBrowRForm: 0,
    // A pleasant resting mouth (0 reads as a faint frown on Haru).
    ParamMouthForm: 0.45,
    ParamMouthOpenY: 0,
  },
  // F01 soft smile, F02 open laugh, F03 angry shout, F04 sulky, F05 ^^ smile,
  // F06 wide-eyed, F07 blushing frown, F08 displeased. Verified by screenshot
  // (docs/screens/avatar-moods.png): overrides close F03's mouth, keep a
  // sliver of F05's eyes open, and add the head motion Haru's expressions lack.
  expressions: {
    happy: "F05",
    annoyed: "F03",
    surprised: "F06",
    smug: "F01",
    sad: "F08",
  },
  poses: {
    neutral: {},
    happy: {
      ParamEyeLOpen: abs(0.25),
      ParamEyeROpen: abs(0.25),
      ParamMouthForm: abs(1),
      ParamMouthOpenY: abs(0.2),
      ParamTere: abs(0.5),
      ParamAngleZ: add(6),
      ParamBodyAngleZ: add(4),
    },
    annoyed: {
      // F03 without the shout: mouth shut in a flat frown, lids half down.
      ParamMouthOpenY: abs(0),
      ParamMouthForm: abs(-0.8),
      ParamBrowLAngle: abs(-1),
      ParamBrowRAngle: abs(-1),
      ParamBrowLForm: abs(-1),
      ParamBrowRForm: abs(-1),
      ParamEyeForm: abs(0),
      ParamEyeLOpen: abs(0.75),
      ParamEyeROpen: abs(0.75),
      // Head turns away, eyes stay on you.
      ParamAngleX: add(24),
      ParamEyeBallX: add(-0.6),
    },
    thinking: {
      ParamEyeBallX: abs(0.8),
      ParamEyeBallY: abs(0.8),
      ParamAngleZ: add(12),
      ParamBodyAngleZ: add(5),
      ParamAngleY: add(4),
      ParamMouthForm: abs(0.1),
      ParamBrowLY: abs(0.3),
      ParamBrowRY: abs(-0.2),
    },
    surprised: {
      ParamEyeLOpen: abs(1.25),
      ParamEyeROpen: abs(1.25),
      ParamMouthOpenY: abs(0.45),
      ParamAngleY: add(5),
    },
    smug: {
      ParamEyeLOpen: abs(0.6),
      ParamEyeROpen: abs(0.6),
      ParamEyeLSmile: abs(0.7),
      ParamEyeRSmile: abs(0.7),
      ParamMouthForm: abs(1),
      ParamTere: abs(0.35),
      ParamBrowLY: abs(-0.2),
      ParamBrowRY: abs(0.5),
      ParamAngleZ: add(-10),
      ParamBodyAngleZ: add(-4),
      ParamAngleY: add(-4),
    },
    sad: {
      ParamBrowLForm: abs(-0.6),
      ParamBrowRForm: abs(-0.6),
      ParamBrowLAngle: abs(0.8),
      ParamBrowRAngle: abs(0.8),
      ParamBrowLY: abs(-0.3),
      ParamBrowRY: abs(-0.3),
      ParamAngleY: add(-12),
      ParamEyeBallY: abs(-0.4),
    },
  },
  idleMotionGroup: "Idle",
  framing: {
    // Right column: head and chest, large; she fades out below the chest.
    column: { scale: 2.2, y: -0.04, x: 0.5, head: { x: 0.5, y: 0.27 } },
    // Emergence center stage: head down to her clasped hands.
    stage: { scale: 1.6, y: 0.03, x: 0.5, head: { x: 0.5, y: 0.26 } },
    // Desktop overlay window: like the stage (she's small there, show more of her).
    overlay: { scale: 1.6, y: 0.03, x: 0.5, head: { x: 0.5, y: 0.26 } },
  },
  license:
    "Haru, official Live2D Cubism sample model (Live2D/CubismWebSamples Samples/Resources/Haru). Live2D Free Material License: free for individuals and small orgs (annual revenue under 10M JPY); larger businesses need a Cubism SDK Release License.",
};

export const MODELS: Record<string, ModelDef> = { haru: HARU };
export const DEFAULT_MODEL = "haru";

/**
 * A model def for an arbitrary `*.model3.json` URL (evaluating a new sample
 * model). Standard ids, no expressions, Haru's framing and overrides.
 */
export function adHocModel(url: string): ModelDef {
  const name = decodeURIComponent(url.split("/").pop()!.replace(/\.model3\.json$/, ""));
  return { ...HARU, id: `url:${url}`, name, url, expressions: {} };
}

/** ?model= beats EVE_MODEL beats the default. Unknown ids fall back to the default. */
export function resolveModel(search: string, env?: string | null): ModelDef {
  const q = new URLSearchParams(search).get("model")?.trim();
  for (const pick of [q, env?.trim()]) {
    if (!pick) continue;
    if (/\.model3\.json$/i.test(pick) && (pick.startsWith("/") || /^https?:\/\//.test(pick))) return adHocModel(pick);
    const def = MODELS[pick.toLowerCase()];
    if (def) return def;
  }
  return MODELS[DEFAULT_MODEL] ?? HARU;
}

/** exp3.json content, as the Cubism SDK writes it. */
export interface Exp3 {
  Parameters: { Id: string; Value: number; Blend?: "Add" | "Multiply" | "Overwrite" }[];
}

/** Convert a model expression into a pose (same semantics as the SDK's blend modes). */
export function expressionToPose(exp: Exp3): Pose {
  const out: Pose = {};
  for (const p of exp.Parameters ?? []) {
    const b = p.Blend ?? "Add";
    out[p.Id] = b === "Multiply" ? { v: p.Value, op: "mul" } : b === "Overwrite" ? { v: p.Value } : { v: p.Value, op: "add" };
  }
  return out;
}

/**
 * Final pose table: each mood starts from its model expression (if any and
 * loaded), our overrides replace per parameter.
 */
export function buildPoses(def: Pick<ModelDef, "poses" | "expressions">, exps: Record<string, Exp3>): PoseTable {
  const out = {} as PoseTable;
  for (const mood of Object.keys(def.poses) as Mood[]) {
    const name = def.expressions[mood];
    const base = name && exps[name] ? expressionToPose(exps[name]) : {};
    out[mood] = { ...base, ...def.poses[mood] };
  }
  return out;
}

/** Framing slot for a dock placement. */
export function framingSlot(placement: "stage" | "column" | "hidden" | "overlay"): FramingSlot {
  return placement === "overlay" ? "overlay" : placement === "stage" ? "stage" : "column";
}
