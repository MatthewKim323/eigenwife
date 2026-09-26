import type { TraitVector } from "./index";

/**
 * Act I dataset: fictional, clearly synthetic profiles with hidden trait
 * vectors. Attention on these is what "compiles" Eve. Owned by the shell
 * builder (content), consumed by core preference math.
 */

export const TRAIT_GROUPS = {
  appearance: ["style", "sporty", "alternative", "polished"],
  personality: ["humor", "sarcasm", "warmth", "ambition", "spontaneity", "nerdiness", "chaos"],
  lifestyle: ["nightlife", "outdoors", "fitness", "travel", "career_focus"],
} as const;

export type TraitKey = (typeof TRAIT_GROUPS)[keyof typeof TRAIT_GROUPS][number];
export const TRAIT_KEYS: readonly TraitKey[] = Object.values(TRAIT_GROUPS).flat() as TraitKey[];

export interface CandidateRegion {
  /** Region id, unique within the candidate: "photo1", "prompt2", "meta". */
  id: string;
  kind: "profile-photo" | "profile-prompt" | "profile-meta";
  /** Which traits this region expresses most, 0..1. Attention here is evidence for these. */
  emphasis: Partial<Record<TraitKey, number>>;
}

export interface Candidate {
  id: string;
  name: string;
  age: number;
  tagline: string;
  job: string;
  location: string;
  photos: { id: string; src: string; caption: string }[];
  prompts: { id: string; question: string; answer: string }[];
  /** Hidden ground truth, 0..1 per trait. */
  traits: Record<TraitKey, number>;
  regions: CandidateRegion[];
}

/** data-gaze key for a candidate region. The shell and the core must agree on this. */
export function regionKey(candidateId: string, regionId: string): string {
  return `cand_${candidateId}_${regionId}`;
}

export function traitVector(c: Candidate): TraitVector {
  return { ...c.traits };
}

/** Filled in by the shell builder. Keep ids stable once shipped. */
export const CANDIDATES: Candidate[] = [];
