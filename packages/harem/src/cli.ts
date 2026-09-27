#!/usr/bin/env bun
/**
 * Run the harem standalone.
 *   bun run packages/harem/src/cli.ts "figure out tonight"            scripted demo beat, local bus
 *   bun run packages/harem/src/cli.ts "figure out tonight" --live     real claude -p wives
 *   add --bus to publish on the core hub (ws://127.0.0.1:7777/bus) so the shell and harem room see it
 *   add --swarm to mirror cards into Open Swarm (see openswarm/README.md)
 *   add --approve to auto-approve the calendar action after 1.5s
 *   add --core=127.0.0.1:7791 (or EVE_CORE) to talk to a core on another port
 */
import { emptyWorld, newId, type AnyEnvelope, type Envelope, type EventMap, type EventType } from "@eigenwife/protocol";
import { BusClient } from "@eigenwife/protocol/client";
import { EventBus } from "@eigenwife/core";
import { ClaudeCliBrain, DEMO_SCRIPTS, ScriptedBrain } from "./brain";
import { executeWithHarem } from "./manager";
import { OpenSwarmMirror } from "./openswarm";
import type { HaremBus } from "./types";

const argv = process.argv.slice(2);
const flag = (f: string) => argv.includes(f);
const goal = argv.filter((a) => !a.startsWith("--")).join(" ") || "figure out tonight";

const local = new EventBus();
let bus: HaremBus = local;
let client: BusClient | null = null;
if (flag("--bus")) {
  const core = argv.find((a) => a.startsWith("--core="))?.slice(7) || process.env.EVE_CORE;
  client = new BusClient({ client: "harem-cli", role: "adapter", ...(core ? { url: `ws://${core}/bus` } : {}) }).connect();
  client.on("*", (e: AnyEnvelope) => {
    if (e.source !== "harem-cli") local.publish(e);
  });
  bus = {
    emit<K extends EventType>(type: K, data: EventMap[K], _source?: string, parent?: string): Envelope<K> {
      return client!.emit(type, data, parent);
    },
    once: (type, filter, timeoutMs) => local.once(type, filter, timeoutMs),
  };
}

const t0 = Date.now();
const stamp = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s`;
const names = new Map<string, string>();
const tap = (e: AnyEnvelope) => {
  const d = e.data as any;
  const who = d.agentId ? names.get(d.agentId) ?? d.agentId : "";
  switch (e.type) {
    case "swarm.plan": return console.log(stamp(), "PLAN", d.mode, d.confidence, d.workers.map((w: any) => w.role).join(", "));
    case "swarm.spawn": names.set(d.agentId, `${d.emoji} ${d.name}`); return console.log(stamp(), "SPAWN", d.label, d.candidateId ? `(${d.candidateId})` : "");
    case "swarm.status": return console.log(stamp(), "  ", who, "->", d.state, d.tool ? `(${d.tool})` : "");
    case "swarm.progress": return console.log(stamp(), "  ", who, `"${d.text}"`);
    case "swarm.conflict": return d.lines.forEach((l: any) => console.log(stamp(), "CONFLICT", names.get(l.agentId), `"${l.text}"`));
    case "swarm.resolve": return console.log(stamp(), "EVE", `"${d.text}"`, d.winner ? `-> ${names.get(d.winner) ?? d.winner}` : "");
    case "swarm.merge": return console.log(stamp(), "MERGE", d.retained);
    case "action.request": return console.log(stamp(), "ACTION?", d.permission, d.description);
    case "task.done": return console.log(stamp(), "DONE", d.ok, `"${d.summary}"`);
  }
};
if (client) client.on("*", tap);
else local.tap(tap);

if (flag("--approve")) {
  (client ?? local).on("action.request", (e: Envelope<"action.request">) => {
    setTimeout(() => bus.emit("action.approval", { actionId: e.data.actionId, approved: true, by: "key" }, "harem-cli"), 1500);
  });
}

const mirror = flag("--swarm") ? await OpenSwarmMirror.connect() : undefined;
const out = await executeWithHarem(
  { taskId: newId("task"), goal, context: "- memory: likes spicy food (0.94)\n- memory: complained that $28 ramen was overpriced (0.89)\n- memory: trying to save money (0.83)\n- memory: likes Japanese food (0.74)" },
  {
    bus,
    world: emptyWorld,
    brain: flag("--live") ? new ClaudeCliBrain() : new ScriptedBrain(DEMO_SCRIPTS),
    mirror,
    approvalTimeoutMs: flag("--approve") ? 10_000 : 3_000,
  },
);
await mirror?.flush();
console.log("\n" + out.summary);
client?.close();
process.exit(out.ok ? 0 : 1);
