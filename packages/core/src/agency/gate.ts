import { newId, type PermissionClass } from "@eigenwife/protocol";
import type { CoreContext } from "../context";
import { APPROVE_KEYS, DENY_KEYS, judgeApproval } from "./approval";
import { effectivePermission, needsApproval, Policy } from "./policy";
import type { EveBrowser } from "./browser/driver";
import { findNativeTarget, type AgentCursor } from "./cursor";
import type { ActionDef, ActionOutcome, AgencyDeps, TraceEntry } from "./types";

export const SRC = "agency";

const RANK: Record<PermissionClass, number> = { READ: 0, SAFE_ACTION: 1, EXTERNAL_SIDE_EFFECT: 2, SENSITIVE_ACTION: 3 };

export interface RequestOpts {
  taskId?: string;
  description?: string;
  parent?: string;
  /** Reuse an id from someone else's action.request (harem, shell). */
  actionId?: string;
  /** The action.request is already on the bus (someone else emitted it). */
  external?: boolean;
  requestedBy?: string;
  /** Permission the requester claimed. We only ever raise it, never lower it. */
  claimed?: PermissionClass;
  claimedNeedsApproval?: boolean;
  progress?: (text: string) => void;
}

type Decision = { approved: boolean; by: "voice" | "key" | "policy"; reason?: string };

/**
 * The one door every action walks through: registry lookup, policy (deny list,
 * budget), approval for consequential classes (spoken, key, or timeout = deny),
 * execution, action.result, and a trace entry for each step.
 */
export class Gate {
  readonly registry = new Map<string, ActionDef>();
  readonly trace: TraceEntry[] = [];
  private approvals: Promise<unknown> = Promise.resolve();
  private pendingCount = 0;
  /** Her cursor and browser (docs/AGENT_CURSOR.md), wired by createAgency. */
  tools: { cursor?: AgentCursor; browser?: EveBrowser | null } = {};

  constructor(
    private ctx: CoreContext,
    private deps: AgencyDeps,
    readonly policy: Policy,
    private approvalTimeoutMs = 30_000,
  ) {}

  register(...defs: ActionDef[]): void {
    for (const d of defs) this.registry.set(d.kind, d);
  }

  pending(): number {
    return this.pendingCount;
  }

  async request(kind: string, args: Record<string, unknown>, opts: RequestOpts = {}): Promise<ActionOutcome & { actionId: string }> {
    const { bus } = this.ctx;
    const actionId = opts.actionId ?? newId("act");
    const def = this.registry.get(kind);
    const t0 = this.deps.now();

    if (!def) {
      const observation = `I don't know how to ${kind}`;
      if (!opts.external)
        bus.emit("action.request", { actionId, taskId: opts.taskId, kind, permission: "SENSITIVE_ACTION", description: opts.description ?? kind, args, needsApproval: true }, SRC, opts.parent);
      bus.emit("action.approval", { actionId, approved: false, by: "policy" }, SRC);
      bus.emit("action.result", { actionId, ok: false, observation }, SRC);
      this.record({ actionId, taskId: opts.taskId, kind, permission: "SENSITIVE_ACTION", description: kind, args, requestedBy: opts.requestedBy ?? SRC, requestedAt: t0, decision: { approved: false, by: "policy", reason: "unknown action", at: t0 } });
      return { ok: false, observation, actionId };
    }

    let permission = effectivePermission(def);
    if (opts.claimed && RANK[opts.claimed] > RANK[permission]) permission = opts.claimed;
    const ask = needsApproval(permission);
    const description = opts.description ?? def.describe(args);
    const entry: TraceEntry = { actionId, taskId: opts.taskId, kind, permission, description, args, requestedBy: opts.requestedBy ?? SRC, requestedAt: t0 };
    this.record(entry);
    // Emit our own request, or correct an external one that understated what this needs,
    // so the shell's prompt and the swarm view show the real class.
    const understated = opts.external && (opts.claimed !== permission || opts.claimedNeedsApproval !== ask);
    if (!opts.external || understated) bus.emit("action.request", { actionId, taskId: opts.taskId, kind, permission, description, args, needsApproval: ask }, SRC, opts.parent);

    const verdict = this.policy.check(def, args);
    let decision: Decision;
    if (!verdict.allowed) {
      decision = { approved: false, by: "policy", reason: verdict.reason };
      bus.emit("action.approval", { actionId, approved: false, by: "policy" }, SRC);
    } else if (ask) {
      decision = await this.approve(actionId, description, opts.parent, def.confirmLine?.(args), def.voiceOnly);
    } else {
      decision = { approved: true, by: "policy", reason: `${permission} runs on its own` };
      bus.emit("action.approval", { actionId, approved: true, by: "policy" }, SRC);
    }
    entry.decision = { ...decision, at: this.deps.now() };

    if (!decision.approved) {
      const observation = `not done: ${decision.reason ?? "not approved"}`;
      bus.emit("action.result", { actionId, ok: false, observation }, SRC);
      entry.result = { ok: false, observation, at: this.deps.now(), ms: 0 };
      return { ok: false, observation, actionId };
    }

    this.policy.spend(def);
    const t1 = this.deps.now();
    let out: ActionOutcome;
    try {
      await this.nativeGlide(def, args, description);
      out = await def.run(args, {
        ctx: this.ctx,
        deps: this.deps,
        taskId: opts.taskId,
        progress: opts.progress,
        browser: this.tools.browser,
        cursor: this.tools.cursor,
        act: (k, a) => this.request(k, a, { taskId: opts.taskId, parent: opts.parent, progress: opts.progress }),
      });
    } catch (err) {
      out = { ok: false, observation: `failed: ${err instanceof Error ? err.message : String(err)}` };
    }
    bus.emit("action.result", { actionId, ok: out.ok, observation: out.observation }, SRC);
    entry.result = { ok: out.ok, observation: out.observation, at: this.deps.now(), ms: this.deps.now() - t1 };
    this.ctx.log("agency", `${kind} ${out.ok ? "ok" : "failed"}: ${out.observation}`);
    return { ...out, actionId };
  }

  /**
   * Native actions (Spotify, Calendar, quitting an app, opening a file): when
   * someone is watching her cursor, it glides to the app's window (bounds only)
   * or its Dock spot and clicks, then the AppleScript does the real work.
   * Capped so a slow window lookup never holds the action up for long.
   */
  private async nativeGlide(def: ActionDef, args: Record<string, unknown>, label: string): Promise<void> {
    const cursor = this.tools.cursor;
    const app = def.cursorApp?.(args);
    if (!cursor || !app || !cursor.watching()) return;
    try {
      const target = await findNativeTarget(this.deps.osa, app, 1200);
      if (!target) return;
      await cursor.move(target.point, { label: target.kind === "dock" ? `${app} in the Dock` : app, target: app });
      cursor.click({ label: label.slice(0, 48), target: app });
      cursor.settle();
    } catch {}
  }

  /** Approvals are serialized: she asks one thing at a time. */
  private approve(actionId: string, description: string, parent?: string, line?: string, voiceOnly = false): Promise<Decision> {
    this.pendingCount++;
    const run = this.approvals.then(() => this.waitForApproval(actionId, description, parent, line, voiceOnly));
    this.approvals = run.catch(() => {});
    return run.finally(() => {
      this.pendingCount--;
    });
  }

  private waitForApproval(actionId: string, description: string, parent?: string, line?: string, voiceOnly = false): Promise<Decision> {
    const { bus } = this.ctx;
    const brains = this.ctx.tryUse("brains");
    this.ctx.setSlot("agency", "pending_approval", `${description} (waiting for a yes or no)`);
    bus.emit("diag", { label: "approval", value: `waiting: ${description}`, ttlMs: this.approvalTimeoutMs }, SRC);

    return new Promise<Decision>((resolve) => {
      let settled = false;
      const offs: (() => void)[] = [];
      const finish = (d: Decision, emit: boolean) => {
        if (settled) return;
        settled = true;
        for (const off of offs) off();
        clearTimeout(timer);
        this.ctx.setSlot("agency", "pending_approval", null);
        if (emit) bus.emit("action.approval", { actionId, approved: d.approved, by: d.by }, SRC);
        bus.emit("diag", { label: "approval", value: `${d.approved ? "approved" : "denied"} by ${d.by}`, ttlMs: 3000 }, SRC);
        resolve(d);
      };

      offs.push(
        bus.on("voice.final", async (e) => {
          const text = e.data.text;
          const v = await judgeApproval(text, description, brains);
          if (v) finish({ approved: v === "yes", by: "voice", reason: `said "${text}"` }, true);
        }),
      );
      offs.push(
        bus.on("shell.key", (e) => {
          if (APPROVE_KEYS.has(e.data.key) && !voiceOnly) finish({ approved: true, by: "key", reason: `key ${e.data.key}` }, true);
          else if (DENY_KEYS.has(e.data.key)) finish({ approved: false, by: "key", reason: `key ${e.data.key}` }, true);
        }),
      );
      // Anyone else can answer too (a shell button, an operator script), as long as it names this action.
      offs.push(
        bus.on("action.approval", (e) => {
          if (e.data.actionId !== actionId || e.source === SRC) return;
          // Voice-only actions (texting people): anyone may say no, only his voice says yes.
          if (voiceOnly && e.data.approved) return;
          finish({ approved: e.data.approved, by: e.data.by, reason: `answered by ${e.source}` }, false);
        }),
      );
      const timer = setTimeout(() => finish({ approved: false, by: "policy", reason: `no answer in ${Math.round(this.approvalTimeoutMs / 1000)}s` }, true), this.approvalTimeoutMs);

      void this.askOutLoud(description, parent, line);
    });
  }

  /** The approval is a conversational beat: she says what she's about to do and waits. */
  private async askOutLoud(description: string, parent?: string, line?: string): Promise<void> {
    const speech = this.ctx.tryUse("speech");
    if (!speech) return;
    // Exact lines (a shell command, a message body) are never paraphrased.
    if (line) {
      await speech.say(line, { priority: "high", parent, brain: "agency" }).catch(() => {});
      return;
    }
    const brains = this.ctx.tryUse("brains");
    const fallback = `${description}, yeah?`;
    try {
      const text = brains
        ? brains.persona({
            event: `You are about to ${description} for the user. You need their yes first.`,
            behavior: "confirm",
            maxWords: 16,
            extra: "Ask in one short line whether to go ahead, naming the concrete thing (time, place). End with a question.",
          })
        : fallback;
      await speech.say(text, { priority: "high", parent, brain: brains ? "persona" : "agency" });
    } catch {
      await speech.say(fallback, { priority: "high", parent, brain: "agency" }).catch(() => {});
    }
  }

  private record(e: TraceEntry): void {
    this.trace.push(e);
    if (this.trace.length > 300) this.trace.splice(0, this.trace.length - 300);
  }
}
