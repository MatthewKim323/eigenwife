import type { PermissionClass } from "@eigenwife/protocol";
import type { CoreContext } from "../context";
import type { OsaRunner } from "./osa";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Side-effect seams. Tests swap every one of these for fakes. */
export interface AgencyDeps {
  osa: OsaRunner;
  fetch: FetchLike;
  /** Open a URL in the default browser (macOS `open`). */
  openUrl(url: string): Promise<boolean>;
  /** Optional visible Playwright browser. Returns false when Playwright is not installed. */
  openVisible(url: string): Promise<boolean>;
  /** Resolve the harem package, or null when it is not installed. */
  loadHarem(): Promise<HaremModule | null>;
  now(): number;
  env(name: string): string;
}

export interface HaremTask {
  taskId: string;
  goal: string;
  context: string;
}

/** Structural slice of @eigenwife/harem's Brain. */
export interface HaremBrain {
  name: string;
  structured<T>(req: { agent: string; system: string; prompt: string; schema: object; tools?: string[]; timeoutMs?: number; onEvent?: (e: { kind: "text"; text: string } | { kind: "tool"; name: string; detail?: string }) => void; signal?: AbortSignal }): Promise<T>;
}

export interface HaremDepsLike {
  bus: CoreContext["bus"];
  world: CoreContext["world"];
  brain?: HaremBrain;
  approvalTimeoutMs?: number;
  schedule?: () => Promise<string> | string;
}

/** What we use from @eigenwife/harem, typed structurally so core never needs it at compile time. */
export interface HaremModule {
  executeWithHarem(task: HaremTask, deps: HaremDepsLike): Promise<{ ok: boolean; summary: string }>;
  ScriptedBrain?: new (scripts: unknown) => HaremBrain;
  DEMO_SCRIPTS?: unknown;
}

export interface ActionOutcome {
  ok: boolean;
  observation: string;
  /** Structured result for internal callers (planner). Not put on the bus. */
  data?: unknown;
}

export interface ActionEnv {
  ctx: CoreContext;
  deps: AgencyDeps;
  taskId?: string;
  /** Run another registered action through the same gate (e.g. places.search calls web.search). */
  act(kind: string, args: Record<string, unknown>): Promise<ActionOutcome>;
  /** Human-readable progress lines for whoever asked (the planner turns them into swarm.progress). */
  progress?(text: string): void;
}

export interface ActionDef {
  kind: string;
  permission: PermissionClass;
  /** One line, spoken-friendly, e.g. "put 'Ramen' on your calendar at 7:30". */
  describe(args: Record<string, unknown>): string;
  /** Apps or hosts this action touches, checked against the deny list. */
  targets?(args: Record<string, unknown>): string[];
  run(args: Record<string, unknown>, env: ActionEnv): Promise<ActionOutcome>;
}

export interface TraceEntry {
  actionId: string;
  taskId?: string;
  kind: string;
  permission: PermissionClass;
  description: string;
  args: Record<string, unknown>;
  requestedBy: string;
  requestedAt: number;
  decision?: { approved: boolean; by: "voice" | "key" | "policy"; reason?: string; at: number };
  result?: { ok: boolean; observation: string; at: number; ms: number };
}
