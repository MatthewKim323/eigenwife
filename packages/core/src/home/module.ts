import { hostname } from "os";
import type { Persona } from "@eigenwife/protocol";
import { secret } from "../config";
import type { Module } from "../context";
import { json } from "../hub";
import type { HomeService } from "../services";
import type { EveStatus } from "./format";
import { HomeStore } from "./store";
import { ZoMirror, type FetchLike, type ZoSyncResult } from "./zo";

/**
 * Home: Eve's state lives in files under config.eveHome (~/.eve), not in the
 * web page. The core is its own process, so closing the browser does not stop
 * her. When ZO_API_KEY is set the same files are mirrored to her Zo computer.
 *
 * Files (all written atomically):
 *   profile.json       { persona, convergedAt, bornAt }            (preference)
 *   preferences.json   { vector, deltas, progress, observations }  (preference)
 *   relationship.json  { state, reason, updatedAt }                (home, from relationship.update)
 *   memories.jsonl     one MemoryRecord per line                   (memory)
 *   embeddings.json    vector cache, local only, never mirrored    (memory)
 *   task_state.json    { tasks: TaskRow[] }                         (home, from task.*)
 *   status.json        heartbeat for `eve status`                  (home)
 */

export const MIRRORED_FILES = new Set([
  "profile.json",
  "preferences.json",
  "relationship.json",
  "memories.jsonl",
  "task_state.json",
  "status.json",
]);

export interface TaskRow {
  taskId: string;
  goal: string;
  brain: string;
  startedAt: number;
  doneAt?: number;
  ok?: boolean;
  summary?: string;
  ms?: number;
}

export interface TaskState {
  tasks: TaskRow[];
}

export interface ProfileFile {
  persona: Persona | null;
  convergedAt?: number | null;
  bornAt?: number | null;
}

export interface StatusFile {
  pid: number;
  startedAt: number;
  lastBeatAt: number;
  host: string;
  hostname: string;
  port: number;
  online: boolean;
  memories: number;
  tasks: number;
  lastSyncAt?: number;
}

export interface HomeModuleOptions {
  /** Defaults to ZO_API_KEY. Empty string disables the Zo mirror. */
  zoKey?: string;
  zoBaseUrl?: string;
  zoDir?: string;
  fetch?: FetchLike;
  syncDebounceMs?: number;
  statusIntervalMs?: number;
  /** How often the heartbeat file itself is mirrored to Zo. */
  statusMirrorMs?: number;
}

export type HomeServiceImpl = HomeService & {
  store: HomeStore;
  zo: ZoMirror | null;
  snapshot(): EveStatus;
  tasks(): TaskRow[];
};

const MAX_TASKS = 200;

export function homeModule(opts: HomeModuleOptions = {}): Module {
  let ticker: ReturnType<typeof setInterval> | undefined;
  let service: HomeServiceImpl | null = null;
  let offs: (() => void)[] = [];
  let port = 0;

  return {
    name: "home",
    async start(ctx) {
      const store = new HomeStore(ctx.config.eveHome);
      port = ctx.config.port;
      const startedAt = Date.now();
      const machine = hostname();
      const zoKey = opts.zoKey ?? secret("ZO_API_KEY");
      const log = (...a: unknown[]) => ctx.log("home", ...a);

      const zo = zoKey
        ? new ZoMirror({
            apiKey: zoKey,
            baseUrl: opts.zoBaseUrl ?? (secret("ZO_BASE_URL") || undefined),
            remoteDir: opts.zoDir ?? (secret("ZO_EVE_DIR") || undefined),
            debounceMs: opts.syncDebounceMs,
            fetch: opts.fetch,
            log,
            onSync: (r: ZoSyncResult) => {
              if (r.ok) log(`zo sync via ${r.via}: ${r.files.join(", ")}`);
              else ctx.bus.emit("error", { where: "home:zo", message: r.error ?? "sync failed" });
            },
          })
        : null;

      let taskState = await store.read<TaskState>("task_state", { tasks: [] });
      if (!Array.isArray(taskState.tasks)) taskState = { tasks: [] };

      const host = () => (zo?.lastSyncAt ? "zo" : machine);
      const memoryCount = () => ctx.tryUse("memory")?.count() ?? 0;
      let fileMemories = 0;

      const write = async (name: string, data: unknown) => {
        const body = await store.write(name, data);
        const file = HomeStore.fileName(name);
        if (zo && MIRRORED_FILES.has(file)) zo.enqueue(file, body);
      };

      const snapshot = (): EveStatus => {
        const memories = ctx.tryUse("memory") ? memoryCount() : fileMemories;
        return {
          online: true,
          host: host(),
          uptimeMs: Date.now() - startedAt,
          memories,
          tasks: taskState.tasks.length,
          activeTasks: taskState.tasks.filter((t) => t.doneAt === undefined).length,
          lastSyncAt: zo?.lastSyncAt,
          zo: !!zo,
          persona: ctx.tryUse("preference")?.persona() ?? null,
          home: store.dir,
          peers: undefined,
        };
      };

      const persistTasks = () => {
        if (taskState.tasks.length > MAX_TASKS) taskState.tasks.splice(0, taskState.tasks.length - MAX_TASKS);
        void write("task_state", taskState).catch((e) => log("task_state write failed", e));
      };

      offs.push(
        ctx.bus.on("task.start", (e) => {
          taskState.tasks.push({ taskId: e.data.taskId, goal: e.data.goal, brain: e.data.brain, startedAt: e.ts });
          persistTasks();
        }),
        ctx.bus.on("task.done", (e) => {
          let row = taskState.tasks.find((t) => t.taskId === e.data.taskId);
          if (!row) {
            row = { taskId: e.data.taskId, goal: e.data.summary, brain: "unknown", startedAt: e.ts - e.data.ms };
            taskState.tasks.push(row);
          }
          Object.assign(row, { doneAt: e.ts, ok: e.data.ok, summary: e.data.summary, ms: e.data.ms });
          persistTasks();
        }),
        ctx.bus.on("relationship.update", (e) => {
          void write("relationship", { state: e.data.state, reason: e.data.reason, updatedAt: e.ts }).catch(() => {});
        }),
      );

      let lastStatusMirror = 0;
      const statusMirrorMs = opts.statusMirrorMs ?? 60_000;
      const beat = async (online = true) => {
        const s = snapshot();
        const file: StatusFile = {
          pid: process.pid,
          startedAt,
          lastBeatAt: Date.now(),
          host: s.host,
          hostname: machine,
          port: ctx.config.port,
          online,
          memories: s.memories,
          tasks: s.tasks,
          lastSyncAt: s.lastSyncAt,
        };
        const body = await store.write("status", file);
        if (zo && (!online || Date.now() - lastStatusMirror >= statusMirrorMs)) {
          lastStatusMirror = Date.now();
          zo.enqueue("status.json", body);
        }
        return s;
      };

      const emitStatus = () => {
        const s = snapshot();
        ctx.bus.emit("home.status", {
          online: true,
          host: s.host,
          uptimeMs: s.uptimeMs,
          memories: s.memories,
          tasks: s.tasks,
          ...(s.lastSyncAt ? { lastSyncAt: s.lastSyncAt } : {}),
        });
        void beat().catch(() => {});
      };

      service = {
        store,
        zo,
        read: (name, fallback) => store.read(name, fallback),
        write,
        status: () => ({ online: true, host: host(), uptimeMs: Date.now() - startedAt }),
        snapshot,
        tasks: () => taskState.tasks,
      };
      ctx.provide("home", service);

      // Count memories from disk until the memory module is up (the CLI path uses the same file).
      fileMemories = (await store.read<unknown[]>("memories.jsonl", [])).length;

      ctx.route("/api/home/status", () => json(snapshot()));
      ctx.route("/api/home/tasks", () => json({ tasks: taskState.tasks }));
      ctx.route("/api/home/sync", async (req) => {
        if (req.method !== "POST") return null;
        if (!zo) return json({ ok: false, error: "ZO_API_KEY not set" }, 400);
        for (const f of MIRRORED_FILES) {
          const raw = await store.readRaw(f);
          if (raw !== null) zo.enqueue(f, raw);
        }
        const r = await zo.flush();
        return json(r, r.ok ? 200 : 502);
      });

      // Initial mirror: push whatever already exists so Zo matches ~/.eve after a restart.
      if (zo) {
        for (const f of MIRRORED_FILES) {
          if (f === "status.json") continue;
          const raw = await store.readRaw(f);
          if (raw !== null) zo.enqueue(f, raw);
        }
        log(`zo mirror on -> ${zo.baseUrl} ${zo.remoteDir}`);
      }

      await beat().catch(() => {});
      ticker = setInterval(emitStatus, opts.statusIntervalMs ?? 5000);
      log(`home at ${store.dir}`);
    },
    async stop() {
      if (ticker) clearInterval(ticker);
      for (const off of offs) off();
      offs = [];
      if (!service) return;
      const s = service;
      service = null;
      try {
        const snap = s.snapshot();
        const body = await s.store.write("status", {
          pid: process.pid,
          startedAt: Date.now() - snap.uptimeMs,
          lastBeatAt: Date.now(),
          host: snap.host,
          hostname: hostname(),
          port,
          online: false,
          memories: snap.memories,
          tasks: snap.tasks,
          lastSyncAt: snap.lastSyncAt,
        } satisfies StatusFile);
        if (s.zo) {
          s.zo.enqueue("status.json", body);
          await Promise.race([s.zo.flush(), Bun.sleep(3000)]);
          s.zo.stop();
        }
        await s.store.flush();
      } catch {}
    },
  };
}
