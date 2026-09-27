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
  /** Cancel the run (the talker's "never mind"). */
  signal?: AbortSignal;
  /** Tool calls and text as they happen (progress narration). */
  onEvent?: (e: { kind: "tool"; name: string; detail?: string } | { kind: "text"; text: string }) => void;
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
  act(kind: string, args: Record<string, unknown>, opts?: { taskId?: string; description?: string; parent?: string }): Promise<{ ok: boolean; observation: string; data?: unknown }>;
}

/** Eve as a coworker (packages/core/src/work, docs/WORK.md). */
export interface WorkService {
  /** Latest coarse work context (frontmost app, repo, branch), or null before the first probe. */
  context(): WorkContextSnapshot | null;
  /** Is this utterance a work ask (or the answer to her clarifying question)? */
  claims(text: string): boolean;
  /** She asked a clarifying question and is waiting for the answer. */
  awaiting(): boolean;
  /** Carry out a work ask end to end (approvals included). Resolves with what to report. */
  handle(text: string, opts?: { parent?: string; goal?: string }): Promise<{ ok: boolean; summary: string }>;
  /** Resolve a repo from words ("eigenwife"), a path, or the current context. */
  resolveRepo(hint?: string): { name: string; path: string } | null;
}

export interface WorkContextSnapshot {
  app: string;
  bundleId?: string;
  title?: string;
  repo?: string;
  repoPath?: string;
  branch?: string;
  dirty?: number;
  lastCommit?: string;
  private?: boolean;
  at: number;
}

/** What's on matt's screen (packages/core/src/screen, docs/SCREEN.md). */
export interface ScreenService {
  /** Latest level-2 observation (summary only, never raw text), or null. */
  current(): ScreenSnapshot | null;
  /** Could "this" mean the screen right now: enabled, not paused, a non-Eve, non-private app in front. */
  canLook(): boolean;
  /** Why she can't look right now (never the window's content), or null. */
  blocked?(): string | null;
  /** Level 3: capture the focused window once, describe it with a vision model, delete the image. */
  look(reason: "deictic" | "stuck" | "auto", opts?: { question?: string; parent?: string }): Promise<{ ok: boolean; description: string; app?: string; by: string; error?: string }>;
  paused(): boolean;
}

export interface ScreenSnapshot {
  app: string;
  title?: string;
  summary: string;
  mode: string;
  stuck: boolean;
  interesting: number;
  error?: string;
  stuckMs?: number;
  focus?: boolean;
  private?: boolean;
  at: number;
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

/** Where a user-profile field came from. Onboarding answers beat gbrain-derived values. */
export type ProfileSource = "onboarding" | "gbrain" | "conversation" | "api" | "default";

/** The semantic model of matt (~/.eve/user.json, docs/KNOW_ME.md). */
export interface UserProfile {
  /** His name ("Matthew Kim"). */
  name?: string;
  /** What she calls him ("matt"). */
  callMe?: string;
  /** What he calls her. Absent = "Eve". */
  herName?: string;
  pronouns?: string;
  /** "MM-DD" or "YYYY-MM-DD". */
  birthday?: string;
  /** What he does / is working on, one short phrase. */
  work?: string;
  interests: string[];
  people: { name: string; relation: string }[];
  /** Topics or behaviors that are off limits. Hard rules in every prompt. */
  boundaries: string[];
  /** Short notes on how he talks and what lands. */
  vibe: string[];
  updatedAt: number;
  /** Per field: who set it last. */
  sources: Partial<Record<keyof Omit<UserProfile, "sources" | "updatedAt">, ProfileSource>>;
}

export interface UserService {
  profile(): UserProfile;
  /** Merge a patch. Scalars from "gbrain" never overwrite "onboarding" values; lists union. */
  merge(patch: Partial<Omit<UserProfile, "sources" | "updatedAt">>, source: ProfileSource): Promise<UserProfile>;
  /** The name he gave her, or null for the default ("Eve"). */
  herName(): string | null;
}

/** First-run spoken onboarding (packages/core/src/onboarding). */
export interface OnboardingService {
  /** A question is out and his next words are the answer: route every utterance here. */
  active(): boolean;
  /** Onboarding will take over her first words (no name yet, not finished): the reflex skips its greeting. */
  pending(): boolean;
  /** Is this utterance a request to (re)do onboarding ("redo onboarding", "let's start over")? */
  claims(text: string): boolean;
  /** Handle one utterance while active (or a claimed redo). */
  hear(text: string, parent?: string): Promise<void>;
  /** Start (redo: from scratch) or resume. */
  begin(opts?: { redo?: boolean; parent?: string }): Promise<void>;
}

/** The talker's one tool call (packages/core/src/talker, docs/VOICE.md). */
export interface TalkerDelegation {
  kind: "answer" | "do";
  task: string;
  /** Spoken right away while the thinker works. */
  stall?: string;
}

/** One streaming talker turn. It starts on creation and buffers; text() replays from the first word. */
export interface TalkerRunHandle {
  id: string;
  text(): AsyncIterable<string>;
  /** The delegate call as soon as it's known, or null when the turn ends without one. */
  delegation: Promise<TalkerDelegation | null>;
  finished: Promise<void>;
  /** Backend that produced the first word (null until then). */
  backend(): string | null;
  /** What's been said so far (marks included). */
  said(): string;
  /** Nothing usable came out (every backend failed or it was aborted early). */
  empty(): boolean;
  aborted(): boolean;
  abort(reason?: string): void;
}

/** The fast conversational voice: a streaming persona model with one tool, delegate (packages/core/src/talker). */
export interface TalkerService {
  /** Some talker backend is configured and not parked. */
  available(): boolean;
  start(req: { userText: string; event?: string; behavior?: string; extra?: string; maxWords?: number; parent?: string }): TalkerRunHandle;
}

export interface ServiceMap {
  /** The talker (packages/core/src/talker). */
  talker: TalkerService;
  /** matt's profile (packages/core/src/onboarding). */
  user: UserService;
  onboarding: OnboardingService;
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
  work: WorkService;
  /** What's on matt's screen (packages/core/src/screen). */
  screen: ScreenService;
  /** Eve's Zo computer (Google Calendar, Maps, Spotify, files). Provided by home only when ZO_API_KEY is set. */
  zo: ZoService;
}
