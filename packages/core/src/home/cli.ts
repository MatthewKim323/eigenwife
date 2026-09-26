#!/usr/bin/env bun
/**
 * eve: talk to Eve's home from a terminal, with or without the browser.
 *
 *   bun run --cwd packages/core eve status          pretty status block
 *   bun run --cwd packages/core eve status --json   machine readable
 *   bun run --cwd packages/core eve memories        list what she remembers
 *
 * Reads the running core (GET /health, /api/home/status) and falls back to the
 * files in ~/.eve when the core is down, so it always answers.
 */
import type { MemoryRecord } from "@eigenwife/protocol";
import { loadConfig, secret } from "../config";
import { ZoClient } from "../zo/client";
import { formatAgo, formatStatus, type EveStatus } from "./format";
import type { ProfileFile, StatusFile, TaskState } from "./module";
import { HomeStore } from "./store";

async function getJson<T>(url: string, ms = 800): Promise<T | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

/** Actually talk to Zo (initialize + ping), so "LIVE" means live right now. */
export async function pingZo(timeoutMs = 8000): Promise<EveStatus["zoLive"]> {
  const key = secret("ZO_API_KEY");
  if (!key) return null;
  const client = new ZoClient({ apiKey: key, baseUrl: secret("ZO_BASE_URL") || undefined, keepaliveMs: 0 });
  const t0 = Date.now();
  const r = await client.ping(timeoutMs);
  return { ok: r.ok, ms: Date.now() - t0, ...(r.error ? { error: r.error } : {}) };
}

export async function collectStatus(): Promise<EveStatus> {
  const [s, zoLive] = await Promise.all([collectLocal(), pingZo()]);
  return { ...s, zoLive, zo: s.zo || !!zoLive };
}

async function collectLocal(): Promise<EveStatus> {
  const config = loadConfig();
  const store = new HomeStore(config.eveHome);
  const statusFile = await store.read<StatusFile | null>("status", null);
  const port = statusFile?.port || config.port;
  const base = `http://${config.host}:${port}`;
  const health = await getJson<{ ok: boolean; peers: string[] }>(`${base}/health`);
  const profile = await store.read<ProfileFile>("profile", { persona: null });

  if (health?.ok) {
    const live = await getJson<EveStatus>(`${base}/api/home/status`);
    if (live) return { ...live, peers: health.peers, bornAt: profile.bornAt ?? null, home: store.dir };
  }

  const memories = await store.read<MemoryRecord[]>("memories.jsonl", []);
  const tasks = await store.read<TaskState>("task_state", { tasks: [] });
  return {
    online: !!health?.ok,
    host: statusFile?.host ?? "local",
    uptimeMs: health?.ok && statusFile ? Date.now() - statusFile.startedAt : 0,
    memories: memories.length,
    tasks: tasks.tasks?.length ?? 0,
    activeTasks: tasks.tasks?.filter((t) => t.doneAt === undefined).length ?? 0,
    lastSyncAt: statusFile?.lastSyncAt,
    zo: !!statusFile?.lastSyncAt,
    persona: profile.persona ? { name: profile.persona.name, tagline: profile.persona.tagline } : null,
    bornAt: profile.bornAt ?? null,
    home: store.dir,
    peers: health?.peers,
  };
}

async function main(argv: string[]) {
  const [cmd = "status", ...rest] = argv;
  const asJson = rest.includes("--json");
  if (cmd === "status") {
    const s = await collectStatus();
    if (asJson) console.log(JSON.stringify(s, null, 2));
    else {
      console.log(formatStatus(s, { color: process.stdout.isTTY }));
      if (!s.online) console.log("\ncore is not running. start it with: bun run core");
    }
    return;
  }
  if (cmd === "memories") {
    const config = loadConfig();
    const records = await new HomeStore(config.eveHome).read<MemoryRecord[]>("memories.jsonl", []);
    if (asJson) return console.log(JSON.stringify(records, null, 2));
    for (const r of records.sort((a, b) => b.createdAt - a.createdAt))
      console.log(`${r.kind.padEnd(10)} ${r.importance.toFixed(2)}  ${formatAgo(r.createdAt).padEnd(8)}  ${r.content}`);
    console.log(`\n${records.length} memories`);
    return;
  }
  console.log("usage: eve status [--json] | eve memories [--json]");
  process.exitCode = 1;
}

if (import.meta.main) await main(process.argv.slice(2));
