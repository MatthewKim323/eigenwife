export { executeWithHarem, HaremManager } from "./manager";
export { planTask, normalizePlan, quickRoute, MAX_WIVES, MAX_DEPTH } from "./planner";
export { detectConflicts, choose, collect, eveSummary } from "./conflicts";
export { ClaudeCliBrain, ScriptedBrain, DEMO_SCRIPTS } from "./brain";
export { WIVES } from "./wives";
export { assignCandidates, pickCandidate, roleFit, candidateById, ROLE_FIT, QUIPS } from "./identity";
export type { WifeIdentity } from "./identity";
export type * from "./types";
