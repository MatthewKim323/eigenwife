import type { ZoService } from "./zo/apps";
import type { MemoryHit, MemoryRecord, MemoryWritePolicy, Mood, Persona, RelationshipState, TraitVector, Urgency } from "@eigenwife/protocol";

/**
 * Typed service contracts between modules. A module provides one with
 * ctx.provide(name, impl); others call ctx.use(name) at call time. Consumers
 * compile against these interfaces only, never against an implementation.
 */

export interface PersonaRequest {
  /** What just happened, in one line: "user opened the dating app again". */
  event: string;
  /** Social intent: tease, comfort, answer, react, ask, confirm, report. */
  behavior: string;
  /** What the user said, if this is a reply. */
  userText?: string;
  maxWords?: number;
  /** Extra prompt context beyond the world block (memories, task results). */
  extra?: string;
  /** Allow inline [mood:x 0.7] and [pause:0.5] marks in the output. */
  marks?: boolean;
}

export interface FrontierRequest {
  goal: string;
  context?: string;
  /** Which engine. "auto" tries jabby's fast path, then claude cli, then codex, then openai. */
  engine?: "auto" | "claude" | "codex" | "jabby" | "openai";
  /** Ask for a JSON object back; the result's `json` is parsed when possible. */
  json?: boolean;
  timeoutMs?: number;
  /** Tools/permissions: "none" = pure reasoning, "read" = may browse/read files. */
  tools?: "none" | "read";
}

export interface FrontierResult {
  ok: boolean;
  text: string;
  json?: unknown;
  engine: string;
  ms: number;
  error?: string;
}

export interface BrainService {
  /** Fast social cortex. Streams text (possibly with marks) chunk by chunk. */
  persona(req: PersonaRequest): AsyncIterable<string>;
  /** Frontal cortex: planning, reasoning, tool use. Slow, rare. */
  frontier(req: FrontierRequest): Promise<FrontierResult>;
  /** Small fast structured call (classification, extraction). Returns parsed JSON or null. */
  quickJson<T = unknown>(system: string, user: string, opts?: { timeoutMs?: number }): Promise<T | null>;
  /** Which backends are live right now, for diagnostics. */
  status(): Record<string, boolean>;
}

export interface SayOptions {
  priority?: "low" | "normal" | "high";
  /** Stop whatever she's saying first. */
  interrupt?: boolean;
  parent?: string;
  brain?: string;
  /** Mood to set before the first word when the text carries no marks. */
  mood?: Mood;
}

export interface SpeechService {
  /** Speak text or a stream of text chunks (marks allowed). Resolves when fully queued. */
  say(text: string | AsyncIterable<string>, opts?: SayOptions): Promise<{ utteranceId: string; text: string }>;
  stop(reason: string): void;
  speaking(): boolean;
}

export interface MemoryService {
  recall(query: string, opts?: { k?: number; kinds?: MemoryRecord["kind"][]; emit?: boolean; parent?: string }): Promise<MemoryHit[]>;
  write(rec: Pick<MemoryRecord, "kind" | "content"> & Partial<MemoryRecord>, policy?: MemoryWritePolicy): Promise<MemoryRecord | null>;
  /** Decide what (if anything) to remember from an exchange; writes and returns records. */
  observe(exchange: { user?: string; eve?: string; event?: string }): Promise<MemoryRecord[]>;
  count(): number;
  all(): MemoryRecord[];
}

export interface RelationshipService {
  get(): RelationshipState;
  nudge(delta: Partial<RelationshipState>, reason: string): RelationshipState;
}

export interface PreferenceService {
  vector(): TraitVector;
  progress(): number;
  persona(): Persona | null;
}

export interface HomeService {
  read<T>(name: string, fallback: T): Promise<T>;
  write(name: string, data: unknown): Promise<void>;
  status(): { online: boolean; host: string; uptimeMs: number };
}

export interface ReflexService {
  /** Push a trigger for Jev to judge (other modules can raise triggers too). */
  trigger(t: { id: string; description: string; urgency: Urgency; parent?: string; data?: Record<string, unknown> }): void;
}

export interface AgencyService {
  /** Run a multi-step real-world task (planning, swarm, actions). */
  runTask(goal: string, opts?: { parent?: string }): Promise<{ ok: boolean; summary: string }>;
  /** Ask permission (voice) when needed, then execute a registered action. */
  act(kind: string, args: Record<string, unknown>, opts?: { taskId?: string; description?: string }): Promise<{ ok: boolean; observation: string }>;
}

export interface WardrobeState {
  /** Item ids she has on (protocol WARDROBE_ITEMS), catalog order. */
  items: string[];
  /** Who made the last change and when. */
  by: "user" | "agent" | "restore";
  updatedAt: number;
}

export interface WardrobeService {
  get(): WardrobeState;
  /** Items the active avatar model can show (all catalog items until the shell reports its model). */
  available(): string[];
  /** Put on / take off. remove: "all" clears. Emits avatar.outfit and persists when anything changed. */
  wear(change: { add?: string[]; remove?: string[] | "all" }, by?: "user" | "agent"): Promise<{ items: string[]; changed: boolean; unavailable: string[] }>;
}

export interface ServiceMap {
  brains: BrainService;
  speech: SpeechService;
  memory: MemoryService;
  relationship: RelationshipService;
  preference: PreferenceService;
  home: HomeService;
  reflex: ReflexService;
  agency: AgencyService;
  /** What she has on (packages/core/src/wardrobe). */
  wardrobe: WardrobeService;
  /** Eve's Zo computer (Google Calendar, Maps, Spotify, files). Provided by home only when ZO_API_KEY is set. */
  zo: ZoService;
}
