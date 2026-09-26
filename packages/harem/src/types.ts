import type { Envelope, EventMap, EventType, ExecutionMode, SwarmAgentState, WorldSnapshot } from "@eigenwife/protocol";

/** Structural slice of core's EventBus, so harem never imports @eigenwife/core (core imports us). */
export interface HaremBus {
  emit<K extends EventType>(type: K, data: EventMap[K], source?: string, parent?: string): Envelope<K>;
  once<K extends EventType>(type: K, filter?: (e: Envelope<K>) => boolean, timeoutMs?: number): Promise<Envelope<K> | null>;
}

export interface HaremTask {
  taskId: string;
  goal: string;
  /** Rendered Context bullets (renderContext) plus recalled memories. */
  context: string;
}

export type BrainEvent = { kind: "tool"; name: string; detail?: string } | { kind: "text"; text: string };

export interface StructuredRequest {
  /** Who is asking, for logs and the CLI's per-agent scratch dir. */
  agent: string;
  system: string;
  prompt: string;
  schema: object;
  /** Built-in tools the worker may use. Empty = pure reasoning. */
  tools?: string[];
  model?: string;
  timeoutMs?: number;
  onEvent?: (e: BrainEvent) => void;
  signal?: AbortSignal;
}

/** The one thing harem needs from a frontier brain: schema-shaped output plus a live event stream. */
export interface Brain {
  name: string;
  structured<T>(req: StructuredRequest): Promise<T>;
}

export interface HaremDeps {
  bus: HaremBus;
  world: () => WorldSnapshot;
  brain?: Brain;
  /** Called with each card event, for the Open Swarm adapter or any other mirror. */
  mirror?: HaremMirror;
  /** How long to wait for a spoken "yeah" on side effects. */
  approvalTimeoutMs?: number;
  /** Tonight's schedule as plain text for Kari. Defaults to ~/.eve/calendar.json, else "free after 19:00". */
  schedule?: () => Promise<string> | string;
  /** Stretch or squash theatrical pauses (tests use 0). */
  pace?: number;
}

export interface HaremMirror {
  spawn(agent: HaremAgent): Promise<void> | void;
  status(agent: HaremAgent): Promise<void> | void;
  progress(agent: HaremAgent, text: string): Promise<void> | void;
  done(agent: HaremAgent): Promise<void> | void;
  conflict(c: Conflict, a: HaremAgent, b: HaremAgent): Promise<void> | void;
  despawn(agent: HaremAgent): Promise<void> | void;
}

export interface WorkerSpec {
  role: WifeRole;
  goal: string;
}

export interface Plan {
  mode: ExecutionMode;
  confidence: number;
  workers: WorkerSpec[];
  reason?: string;
}

export type WifeRole = "food" | "calendar" | "budget" | "logistics" | "research";

export interface HaremAgent {
  id: string;
  taskId: string;
  name: string;
  emoji: string;
  role: WifeRole;
  goal: string;
  state: SwarmAgentState;
  tool?: string;
  lastText?: string;
  parentAgentId: "eve";
  depth: 1;
  result?: WifeResult;
  error?: string;
  startedAt: number;
  endedAt?: number;
}

// ---------------------------------------------------------------------------
// Result schemas, one per role. Wives talk to each other only through these.
// ---------------------------------------------------------------------------

export interface FoodOption {
  name: string;
  dish?: string;
  cost: number;
  distanceMinutes: number;
  fit: number;
  reason: string;
  url?: string;
}

export interface FoodResult {
  type: "food_result";
  options: FoodOption[];
  confidence: number;
}

export interface BudgetResult {
  type: "budget_result";
  maxRecommendedSpend: number;
  warnings: string[];
  confidence: number;
}

export interface CalendarResult {
  type: "calendar_result";
  availableFrom: string;
  availableUntil: string;
  suggestedStart: string;
  confidence: number;
}

export interface LogisticsResult {
  type: "logistics_result";
  maxTravelMinutes: number;
  notes: string[];
  confidence: number;
}

export interface ResearchResult {
  type: "research_result";
  findings: { claim: string; source?: string }[];
  confidence: number;
}

export type WifeResult = FoodResult | BudgetResult | CalendarResult | LogisticsResult | ResearchResult;

export interface Conflict {
  id: string;
  topic: string;
  a: string;
  b: string;
  lines: { agentId: string; text: string }[];
  /** What Eve decided, filled in by resolve(). */
  resolution?: string;
}

export interface HaremOutcome {
  ok: boolean;
  summary: string;
  plan: Plan;
  agents: HaremAgent[];
  conflicts: Conflict[];
  choice?: { option: FoodOption; start: string };
  action?: { actionId: string; approved: boolean | null };
}
