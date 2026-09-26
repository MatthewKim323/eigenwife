import { homedir, hostname } from "os";
import { join } from "path";
import type { Persona } from "@eigenwife/protocol";
import { secret } from "../config";
import type { Module } from "../context";
import { json } from "../hub";
import type { HomeService } from "../services";
import type { EveStatus } from "./format";
import { HomeStore } from "./store";
import { ZoClient, type FetchLike } from "../zo/client";
import { zoApps, type MapsQuery, type ZoService } from "../zo/apps";
import { SpotifyPoller } from "../zo/spotify";
import { DEFAULT_ZO_DIR, memoriesSummary, restoreFromZo, ZoMirror, type RestoreResult, type ZoSyncResult } from "./zo";

/**
 * Home: Eve's state lives in files under config.eveHome (~/.eve), not in the
 * web page. The core is its own process, so closing the browser does not stop
 * her. When ZO_API_KEY is set the same files are mirrored to her Zo computer,
 * and home also owns the shared Zo client (the "zo" service: Google Calendar,
 * Maps, Spotify, files; see docs/ZO.md). Zo work is always background: the
 * session is pre-warmed at boot and kept alive, syncs are debounced, the
 * Spotify poll runs on its own timer. Only the empty-home restore waits on Zo,
 * and only for restoreTimeoutMs.
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
  "memories.md",
]);

/** Files worth pulling back from Zo when ~/.eve is empty. status.json is stale by definition. */
export const RESTORE_FILES = ["profile.json", "preferences.json", "relationship.json", "memories.jsonl", "task_state.json"];

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
  zoKeepaliveMs?: number;
  /** Spotify now-playing poll through Zo. Default on (EVE_ZO_SPOTIFY=0 turns it off). */
  spotify?: boolean | { intervalMs?: number; idleMs?: number; firstDelayMs?: number };
  /** Warm the maps cache once she is born. Default on (EVE_ZO_PREFETCH=0 turns it off). */
  prefetch?: boolean;
  /** Cap on the boot-time restore from Zo when ~/.eve is empty. */
  restoreTimeoutMs?: number;
}

/** Queries the planner is most likely to ask for, so "figure out tonight" hits a warm cache. */
export function prefetchQueries(location: string): MapsQuery[] {
  return ["cheap spicy food", "cheap spicy ramen"].map((query) => ({ query, location, openNow: true, cheap: true }));
}

export type HomeServiceImpl = HomeService & {
  store: HomeStore;
  zo: ZoMirror | null;
  zoService: ZoService | null;
  spotify: SpotifyPoller | null;
  restore: RestoreResult | null;
  snapshot(): EveStatus;
  tasks(): TaskRow[];
};

const MAX_TASKS = 200;

export function homeModule(opts: HomeModuleOptions = {}): Module {
  let ticker: ReturnType<typeof setInterval> | undefined;
  let service: HomeServiceImpl | null = null;
  let offs: (() => void)[] = [];
  let port = 0;
  let prefetchTimer: ReturnType<typeof setInterval> | undefined;

  return {
    name: "home",
    async start(ctx) {
      const store = new HomeStore(ctx.config.eveHome);
      port = ctx.config.port;
      const startedAt = Date.now();
      const machine = hostname();
      const zoKey = opts.zoKey ?? secret("ZO_API_KEY");
      const log = (...a: unknown[]) => ctx.log("home", ...a);

      const client = zoKey
        ? new ZoClient({ apiKey: zoKey, baseUrl: opts.zoBaseUrl ?? (secret("ZO_BASE_URL") || undefined), fetch: opts.fetch, keepaliveMs: opts.zoKeepaliveMs, log })
        : null;
      const zoService = client ? zoApps(client, { log }) : null;
      if (client && zoService) {
        ctx.provide("zo", zoService);
        // Pre-warm: initialize now, ping every 4 min, so no real call pays for the handshake.
        client.warm();
      }
      // Her Zo folder is one per Zo account, not per local home. A throwaway home (scripts/e2e.ts,
      // EVE_HOME=/tmp/...) must not overwrite the real Eve on Zo or restore her into a test, so the
      // mirror, restore and Spotify poll run only for the real ~/.eve, an explicit zoKey, or EVE_ZO_MIRROR=1.
      const realHome = opts.zoKey !== undefined || ctx.config.eveHome === join(homedir(), ".eve") || secret("EVE_ZO_MIRROR") === "1";
      if (zoService && !realHome) log(`zo mirror off for throwaway home ${ctx.config.eveHome} (EVE_ZO_MIRROR=1 to force)`);
      const remoteDir = (opts.zoDir ?? (secret("ZO_EVE_DIR") || DEFAULT_ZO_DIR)).replace(/\/$/, "");

      // Laptop wiped but Zo still has her: pull her state back before anyone reads it.
      let restore: RestoreResult | null = null;
      const localEmpty = (await Promise.all(RESTORE_FILES.map((f) => store.readRaw(f)))).every((x) => x === null);
      const restoredBytes = new Map<string, string>();
      if (zoService && realHome && localEmpty && secret("EVE_ZO_RESTORE") !== "0") {
        const cap = opts.restoreTimeoutMs ?? 15_000;
        restore = await Promise.race([
          restoreFromZo(zoService, store, remoteDir, RESTORE_FILES, (f, b) => restoredBytes.set(f, b)),
          Bun.sleep(cap).then((): RestoreResult => ({ restored: [], skipped: [], ms: cap, error: "timeout" })),
        ]);
        if (restore.restored.length) log(`restored ${restore.restored.join(", ")} from zo in ${restore.ms}ms`);
        else if (restore.error) log(`zo restore skipped: ${restore.error}`);
      }

      const zo = zoService && realHome
        ? new ZoMirror({
            zo: zoService,
            remoteDir,
            debounceMs: opts.syncDebounceMs,
            log,
            onSync: (r: ZoSyncResult) => {
              // Logged, never put on the bus: a flaky Zo must not look like Eve breaking. /api/home/status shows it.
              if (r.ok) {
                if (r.files.length) log(`zo sync via ${r.via} in ${r.ms}ms: ${r.files.join(", ")}`);
              } else log(`zo sync failed (${r.error ?? "?"}), will retry on the next write`);
            },
          })
        : null;

      let taskState = await store.read<TaskState>("task_state", { tasks: [] });
      if (!Array.isArray(taskState.tasks)) taskState = { tasks: [] };

      const host = () => (zo?.lastSyncAt ? "zo" : machine);
      const memoryCount = () => ctx.tryUse("memory")?.count() ?? 0;
      let fileMemories = 0;

      for (const [f, b] of restoredBytes) zo?.markPushed(f, b);

      const mirror = (file: string, body: string) => {
        if (!zo || !MIRRORED_FILES.has(file)) return;
        zo.enqueue(file, body);
        if (file === "memories.jsonl") zo.enqueue("memories.md", memoriesSummary(body));
      };

      const write = async (name: string, data: unknown) => {
        const body = await store.write(name, data);
        mirror(HomeStore.fileName(name), body);
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
        zoService,
        spotify: null,
        restore,
        read: (name, fallback) => store.read(name, fallback),
        write,
        status: () => ({ online: true, host: host(), uptimeMs: Date.now() - startedAt }),
        snapshot,
        tasks: () => taskState.tasks,
      };
      ctx.provide("home", service);

      // Count memories from disk until the memory module is up (the CLI path uses the same file).
      fileMemories = (await store.read<unknown[]>("memories.jsonl", [])).length;

      ctx.route("/api/home/status", () => json({ ...snapshot(), zoStatus: zoService?.status() ?? null, ...(restore ? { zoRestore: restore } : {}) }));
      ctx.route("/api/home/tasks", () => json({ tasks: taskState.tasks }));
      ctx.route("/api/home/sync", async (req) => {
        if (req.method !== "POST") return null;
        if (!zo) return json({ ok: false, error: "ZO_API_KEY not set" }, 400);
        for (const f of MIRRORED_FILES) {
          const raw = await store.readRaw(f);
          if (raw !== null) mirror(f, raw);
        }
        const r = await zo.flush();
        return json(r, r.ok ? 200 : 502);
      });

      // Initial mirror: push whatever already exists so Zo matches ~/.eve after a restart.
      if (zo) {
        for (const f of MIRRORED_FILES) {
          if (f === "status.json") continue;
          const raw = await store.readRaw(f);
          if (raw !== null) mirror(f, raw);
        }
        log(`zo mirror on -> ${zo.baseUrl} ${zo.remoteDir}`);
      }

      // Media awareness: Spotify on any device, through Zo, in the background.
      const spotifyOn = opts.spotify ?? secret("EVE_ZO_SPOTIFY") !== "0";
      if (zoService && realHome && spotifyOn) {
        const so = typeof opts.spotify === "object" ? opts.spotify : {};
        const poller = new SpotifyPoller({ zo: zoService, bus: ctx.bus, intervalMs: so.intervalMs, idleMs: so.idleMs, log });
        poller.start(so.firstDelayMs ?? 5000);
        service.spotify = poller;
      }

      // Once she is born, keep "cheap spicy food open now" warm so the planner usually hits the cache.
      const prefetchOn = opts.prefetch ?? secret("EVE_ZO_PREFETCH") !== "0";
      if (zoService && prefetchOn) {
        const location = secret("EIGEN_LOCATION") || "Irvine, CA";
        const warm = () => {
          for (const q of prefetchQueries(location)) zoService.prefetchMaps(q);
        };
        offs.push(
          ctx.bus.on("companion.born", () => {
            warm();
            prefetchTimer ??= setInterval(warm, 9 * 60_000);
          }),
        );
      }

      await beat().catch(() => {});
      ticker = setInterval(emitStatus, opts.statusIntervalMs ?? 5000);
      log(`home at ${store.dir}`);
    },
    async stop() {
      if (ticker) clearInterval(ticker);
      if (prefetchTimer) clearInterval(prefetchTimer);
      prefetchTimer = undefined;
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
        s.spotify?.stop();
        s.zoService?.client.close();
        await s.store.flush();
      } catch {}
    },
  };
}
