import type { AnyEnvelope, ReflexDecision } from "@eigenwife/protocol";
import type { CoreContext } from "../context";
import type { SayOptions } from "../services";
import { readIntent } from "../reflex/intent";
import type { Schedule } from "./transcript";

/**
 * Client delegation (docs/LIVE.md): gpt-live-1 says "I need help" with
 * session.delegation.created (an id, no task text). The core already knows
 * what he just said: the controller flushed his transcript into a voice.final
 * the moment the delegation arrived, so the SAME cascade paths run on it:
 * Jev judges it, reflex routes it (music, outfit, browser, apps, work,
 * agency.runTask with spoken approvals), memory recalls for it.
 *
 * This class is the glue back to the voice model:
 *   - memory hits for his words     -> session.thinking.append (quiet facts)
 *   - task progress (swarm.progress) -> session.thinking.append
 *   - her lines (ack, answer, approval question, task report), captured
 *     from the speech service while live -> session.commentary.append
 *   - deep questions (explain, why, research) or nothing from reflex within
 *     a few seconds -> brains.frontier -> session.commentary.append
 *
 * Official semantics: commentary is what the model says aloud, thinking is
 * context it uses without speaking. A spoken interruption doesn't cancel the
 * work; late results still land (as session-wide commentary once the
 * delegation timed out).
 */

export interface DelegationDeps {
  ctx: CoreContext;
  send(event: Record<string, unknown>): void;
  now(): number;
  schedule: Schedule;
  log(...a: unknown[]): void;
  /** Recent conversation, for frontier context. */
  conversation(): string;
  /** Is an approval question out right now? */
  approvalPending(): boolean;
  /** The delegation opened or closed (avatar thinking state). */
  changed(): void;
  /** Wait this long for reflex before asking the frontier brain. */
  fallbackMs?: number;
  /** Give up on a delegation after this long (late lines go session-wide). */
  timeoutMs?: number;
}

export interface Delegation {
  id: string;
  openedAt: number;
  userText: string;
  /** The voice.final id his words went out as: reflex's trigger parent. */
  lineage: string | null;
  deep: boolean;
  decision?: ReflexDecision;
  taskId?: string;
  taskDone: boolean;
  answered: boolean;
  /** Her "on it." before a task went out (quietly). */
  acked: boolean;
  closed: boolean;
  frontier: boolean;
  lastProgressAt: number;
  cancel: (() => void)[];
}

/** 500 tokens max per append; ~3.5 chars a token with margin. */
export const APPEND_MAX_CHARS = 1600;

const clip = (s: string, n = APPEND_MAX_CHARS) => (s.length > n ? `${s.slice(0, n - 3).trimEnd()}...` : s);

/** Worth the frontier brain: explanations, research, comparisons, long questions. */
export function isDeep(text: string): boolean {
  const it = readIntent(text);
  if (it.task || it.work || it.music || it.outfit || it.browse || it.command) return false;
  if (/\b(?:explain|why (?:is|are|do|does|did|would)|how does|how do .* work|what'?s the difference|compare|research|look (?:it|this|that) up|latest|news|summari[sz]e|teach me|break (?:it|this) down)\b/i.test(text)) return true;
  return it.help || (it.question && it.words >= 12);
}

let seq = 0;
const eventId = (p: string) => `${p}_${Date.now().toString(36)}${(seq++).toString(36)}`;

export class Delegations {
  private open_: Delegation[] = [];
  private fallbackMs: number;
  private timeoutMs: number;

  constructor(private d: DelegationDeps) {
    this.fallbackMs = d.fallbackMs ?? 6000;
    this.timeoutMs = d.timeoutMs ?? 180_000;
  }

  list(): Delegation[] {
    return this.open_.filter((x) => !x.closed);
  }

  any(): boolean {
    return this.list().length > 0;
  }

  get(id: string): Delegation | undefined {
    return this.open_.find((x) => x.id === id);
  }

  thinking(delegationId: string | null, content: string) {
    if (!content.trim()) return;
    this.d.send({ type: "session.thinking.append", event_id: eventId("think"), delegation_id: delegationId, content: clip(content) });
  }

  commentary(delegationId: string | null, content: string) {
    if (!content.trim()) return;
    this.d.send({ type: "session.commentary.append", event_id: eventId("say"), delegation_id: delegationId, content: clip(content) });
  }

  open(id: string, userText: string, lineage: string | null): Delegation {
    const del: Delegation = {
      id,
      openedAt: this.d.now(),
      userText,
      lineage,
      deep: !!userText && isDeep(userText),
      taskDone: false,
      answered: false,
      acked: false,
      closed: false,
      frontier: false,
      lastProgressAt: 0,
      cancel: [],
    };
    this.open_.push(del);
    if (this.open_.length > 20) this.open_.splice(0, this.open_.length - 20);
    this.d.log(`delegation ${id}${userText ? ` for "${userText}"` : ""}${del.deep ? " (deep)" : ""}`);
    this.d.changed();
    // No words yet: the transcript can trail the delegation. adopt() picks up his next final.
    if (userText) {
      void this.recall(del);
      if (del.deep) void this.frontier(del);
    }
    del.cancel.push(this.d.schedule(() => this.fallback(del), this.fallbackMs));
    del.cancel.push(
      this.d.schedule(() => {
        if (del.closed) return;
        if (!del.answered) this.commentary(del.id, "backend: that's taking too long. tell him it didn't come through and he can ask again.");
        this.close(del, "timeout");
      }, this.timeoutMs),
    );
    return del;
  }

  /** His words arrived after the delegation did: they're what it's about. */
  adopt(text: string, lineage: string): boolean {
    const del = this.list().find((x) => !x.userText && this.d.now() - x.openedAt < 5000);
    if (!del || !text.trim()) return false;
    del.userText = text;
    del.lineage = lineage;
    del.deep = isDeep(text);
    this.d.log(`delegation ${del.id} is about "${text}"`);
    void this.recall(del);
    if (del.deep) void this.frontier(del);
    return true;
  }

  private async recall(del: Delegation) {
    const memory = this.d.ctx.tryUse("memory");
    if (!memory || !del.userText) return;
    try {
      const hits = await memory.recall(del.userText, { k: 3, emit: true, parent: del.lineage ?? undefined });
      if (del.closed || !hits.length) return;
      this.thinking(del.id, `things you remember that may matter:\n${hits.map((h) => `- ${h.record.content}`).join("\n")}`);
    } catch (err) {
      this.d.log("delegation recall failed:", err);
    }
  }

  /** Reflex had nothing to say (or never decided): think it through with the frontier brain. */
  private fallback(del: Delegation) {
    if (del.closed || del.answered || del.frontier || del.taskId) return;
    // Reflex is carrying it out (task, work, action): its own lines report back.
    if (del.decision === "ESCALATE") return;
    if (del.decision === "ACT") {
      // Quiet actions (pause the music) have no line: don't leave the model hanging.
      del.cancel.push(
        this.d.schedule(() => {
          if (del.closed) return;
          this.thinking(del.id, "backend: handled.");
          this.close(del, "acted quietly");
        }, this.fallbackMs),
      );
      return;
    }
    if (del.decision === "IGNORE" || del.decision === "GLANCE") {
      this.thinking(del.id, "backend: nothing to do for that one. just respond naturally, or stay quiet if it wasn't for you.");
      return this.close(del, "ignored");
    }
    if (!del.userText) {
      this.thinking(del.id, "backend: still didn't catch a request. ask him what he wants.");
      return this.close(del, "empty");
    }
    void this.frontier(del);
  }

  private async frontier(del: Delegation) {
    if (del.frontier || del.closed) return;
    del.frontier = true;
    const brains = this.d.ctx.tryUse("brains");
    if (!brains) {
      this.commentary(del.id, "backend: my thinking brain is offline right now. say you can't check that at the moment.");
      return this.close(del, "no brains");
    }
    const world = this.d.ctx.contextBlock();
    const convo = this.d.conversation();
    try {
      const r = await brains.frontier({
        goal: `He asked, in a live voice conversation: "${del.userText}". Answer it for her to say out loud: the facts only, 1 to 3 short plain sentences, no markdown, no lists.`,
        context: [convo && `conversation so far:\n${convo}`, world && `what's going on:\n${world}`].filter(Boolean).join("\n\n"),
        tools: "read",
        timeoutMs: 45_000,
      });
      if (del.closed && del.answered) return;
      const text = r.ok && r.text.trim() ? r.text.trim() : "";
      this.commentary(del.closed ? null : del.id, text ? `backend answer: ${text}` : "backend: couldn't figure that one out right now. say so briefly.");
      del.answered = true;
      this.close(del, "frontier");
    } catch (err) {
      this.d.log("delegation frontier failed:", err);
      this.commentary(del.closed ? null : del.id, "backend: that lookup broke. say you couldn't get it.");
      this.close(del, "frontier failed");
    }
  }

  /** The open delegation a say() belongs to, by causal parent (his words) or recency. */
  target(opts: SayOptions): Delegation | null {
    const open = this.list();
    if (!open.length) return null;
    const parent = opts.parent;
    if (parent) {
      const byLineage = open.find((x) => x.lineage === parent);
      if (byLineage) return byLineage;
      const task = this.taskParent.get(parent);
      if (task) return open.find((x) => x.taskId === task) ?? null;
    }
    // Agency's approval question may carry no parent: the newest delegation owns it.
    if (this.d.approvalPending()) return open.at(-1)!;
    return null;
  }

  /** A line she would have spoken in classic mode, routed to its delegation. */
  deliver(del: Delegation, text: string, opts: SayOptions): "commentary" | "thinking" | "dropped" {
    const line = text.trim();
    if (!line) return "dropped";
    // A deep question is the frontier's; reflex's quick persona line would just be a guess.
    if (del.deep && del.frontier && !del.taskId && !this.d.approvalPending() && opts.brain === "persona" && del.decision !== "ACT" && del.decision !== "ESCALATE")
      return "dropped";
    if (this.d.approvalPending()) {
      this.commentary(del.id, `ask him this and wait for his yes or no: ${line}`);
      return "commentary";
    }
    if (del.decision === "ESCALATE" && !del.acked && !del.taskDone) {
      // "on it." before the task: the voice model acks on its own; keep it posted quietly.
      del.acked = true;
      this.thinking(del.id, `backend: working on it (${line})`);
      return "thinking";
    }
    this.commentary(del.id, line);
    del.answered = true;
    // An ACT line comes before the action runs: action.result closes it.
    if (del.decision !== "ACT") this.close(del, "answered");
    return "commentary";
  }

  private taskParent = new Map<string, string>();

  /** Bus events that move a delegation along. */
  onBus(e: AnyEnvelope) {
    switch (e.type) {
      case "reflex.decision": {
        const del = this.list().find((x) => x.lineage && x.lineage === e.parent);
        if (!del) return;
        del.decision = e.data.decision;
        if ((del.decision === "IGNORE" || del.decision === "GLANCE") && !del.deep) this.fallback(del);
        return;
      }
      case "task.start": {
        // The task reflex started for his words (runTask carries his voice.final as parent).
        const del = this.list().find((x) => !x.taskId && ((x.lineage && x.lineage === e.parent) || (x.decision === "ESCALATE" && this.d.now() - x.openedAt < 30_000)));
        if (!del) return;
        del.taskId = e.data.taskId;
        this.taskParent.set(e.id, e.data.taskId);
        this.thinking(del.id, `backend: started "${e.data.goal}". results in a bit.`);
        return;
      }
      case "swarm.progress": {
        const del = this.list().find((x) => x.taskId === e.data.taskId);
        if (!del || this.d.now() - del.lastProgressAt < 4000) return;
        del.lastProgressAt = this.d.now();
        this.thinking(del.id, `backend progress: ${e.data.text}`);
        return;
      }
      case "task.done": {
        const del = this.list().find((x) => x.taskId === e.data.taskId);
        if (!del) return;
        del.taskDone = true;
        this.thinking(del.id, `backend: task ${e.data.ok ? "finished" : "failed"}: ${e.data.summary}`);
        // The report line follows through the speech path; if it never comes, close soon.
        del.cancel.push(
          this.d.schedule(() => {
            if (del.closed) return;
            this.commentary(del.id, `${e.data.ok ? "done" : "that didn't work"}: ${e.data.summary}`);
            del.answered = true;
            this.close(del, "task done");
          }, 8000),
        );
        return;
      }
      case "action.result": {
        // One-shot actions (music, outfit, apps): the line came first, the result closes it.
        const del = this.list().find((x) => x.decision === "ACT");
        if (!del) return;
        if (!e.data.ok) this.commentary(del.id, `backend: that didn't work: ${e.data.observation}`);
        else if (!del.answered) this.thinking(del.id, `backend: done (${e.data.observation}).`);
        del.answered = true;
        this.close(del, "acted");
        return;
      }
    }
  }

  close(del: Delegation, why: string) {
    if (del.closed) return;
    del.closed = true;
    for (const c of del.cancel.splice(0)) c();
    this.d.log(`delegation ${del.id} closed (${why})`);
    this.d.changed();
  }

  closeAll() {
    for (const del of this.list()) this.close(del, "session over");
  }
}
