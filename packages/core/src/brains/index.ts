export { brainsModule, brainsFor, haremBrain, defaultIO } from "./module";
export { createBrains, OFFLINE_LINES, AUTO_ORDER, HAREM_ORDER } from "./service";
export type { Brains, BrainsDeps, HaremBrain, StructuredRequest, PersonaTrace } from "./service";
export type { BrainEvent, FrontierEngine, EngineRun } from "./frontier";
export type { BrainIO, Fetcher, Spawner, ProcHandle } from "./io";
export type { ChatBackend, ChatMessage } from "./chat";
export { DEFAULT_EVE, buildPersonaPrompt } from "./prompt";
export { extractJson, isErrorText, ERROR_RE } from "./text";
