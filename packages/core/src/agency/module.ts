import { existsSync } from "fs";
import { join } from "path";
import { newId } from "@eigenwife/protocol";
import { REPO_ROOT, secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { AgencyService, BrainService } from "../services";
import { appQuit, browserOpen, shellCloseApp, shellOpen } from "./actions/apps";
import { musicControl, musicPlay } from "./actions/music";
import { calendarCreateAlias, calendarCreateEvent, calendarDeleteEvent, calendarFreeBusy } from "./actions/calendar";
import { placesSearchAction } from "./actions/places";
import { webScrape, webScrapeAction, webSearchAction } from "./actions/web";
import { avatarWear } from "./actions/wardrobe";
import { BROWSER_ACTIONS, rememberPlace } from "./actions/browser";
import { mapsQuery } from "./actions/places";
import { EveBrowser } from "./browser/driver";
import { playwrightBackend } from "./browser/playwright";
import { AgentCursor } from "./cursor";
import { startPointer } from "./pointer";
import { Gate, SRC } from "./gate";
import { effectivePermission } from "./policy";
import { Policy } from "./policy";
import { cannedOutcome, heuristicPrefs, runBuiltinTask } from "./planner";
import { realOsa } from "./osa";
import { realExec } from "../work/exec";
import { WORK_ACTIONS } from "./actions/work";
import { messagesActions } from "./actions/messages";
import type { AgencyDeps, HaremBrain, HaremModule } from "./types";

export interface AgencyOptions {
  deps?: Partial<AgencyDeps>;
  /** Default 30s. Silence past this is a no. */
  approvalTimeoutMs?: number;
  /** Actions (other than READs) per session. Default EIGEN_ACTION_BUDGET or 25. */
  budget?: number;
  /** Spawn watcher/watch.py with the core. Default: EIGEN_WATCHER=1. */
  watcher?: boolean;
}

export const defaultDeps = (): AgencyDeps => ({
  osa: realOsa,
  fetch: (input, init) => fetch(input, init),
  async openUrl(url) {
    const p = Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  },
  async openVisible(url) {
    try {
      const spec = "playwright";
      const pw = (await import(spec)) as { chromium: { launch(o: object): Promise<{ newPage(): Promise<{ goto(u: string): Promise<unknown> }> }> } };
      const browser = await pw.chromium.launch({ headless: false });
      const page = await browser.newPage();
      await page.goto(url);
      return true;
    } catch {
      return false;
    }
  },
  async loadHarem() {
    // Variable specifiers keep tsc and bundlers from requiring harem at build time.
    // Core can't declare harem as a dependency (harem dev-depends on core), and bun's
    // isolated installs only link declared deps, so fall back to the workspace path.
    const specs = ["@eigenwife/harem", join(REPO_ROOT, "packages", "harem", "src", "index.ts")];
    for (const spec of specs) {
      try {
        const mod = (await import(spec)) as Partial<HaremModule>;
        if (typeof mod.executeWithHarem === "function") return mod as HaremModule;
      } catch {}
    }
    return null;
  },
  now: () => Date.now(),
  env: (name) => secret(name),
  exec: realExec,
  browserBackend: () => playwrightBackend(),
  sleep: (ms) => Bun.sleep(ms),
});

/** Food-ish goals get the visible Maps browse while the swarm works. */
const PLACE_GOAL = /\b(tonight|dinner|lunch|brunch|breakfast|eat|food|hungry|restaurant|ramen|sushi|tacos?|pizza|thai|korean|coffee|drinks|bar|date)\b/i;

/** Adapt the core brains' frontier call to harem's structured Brain interface. */
export function frontierAsHaremBrain(brains: BrainService): HaremBrain {
  return {
    name: "frontier",
    async structured<T>(req: Parameters<HaremBrain["structured"]>[0]): Promise<T> {
      req.onEvent?.({ kind: "text", text: "thinking..." });
      const r = await brains.frontier({
        goal: `${req.system}\n\n${req.prompt}\n\nReply with only a JSON object matching this JSON Schema:\n${JSON.stringify(req.schema)}`,
        json: true,
        tools: req.tools?.length ? "read" : "none",
        timeoutMs: req.timeoutMs ?? 90_000,
      });
      if (!r.ok || r.json === undefined || r.json === null) throw new Error(r.error ?? `frontier (${r.engine}) returned no JSON`);
      req.onEvent?.({ kind: "text", text: `answered via ${r.engine}` });
      return r.json as T;
    },
  };
}

export function createAgency(ctx: CoreContext, opts: AgencyOptions = {}) {
  const deps: AgencyDeps = { ...defaultDeps(), ...opts.deps };
  const budget = opts.budget ?? (Number(deps.env("EIGEN_ACTION_BUDGET")) || 25);
  const gate = new Gate(ctx, deps, new Policy(budget), opts.approvalTimeoutMs ?? 30_000);
  gate.register(calendarCreateEvent, calendarCreateAlias, calendarDeleteEvent, calendarFreeBusy, browserOpen, webSearchAction, webScrapeAction, placesSearchAction, shellCloseApp, shellOpen, appQuit, musicPlay, musicControl);
  gate.register(avatarWear);
  gate.register(...WORK_ACTIONS);
  gate.register(...messagesActions({ now: deps.now }));
  gate.register(...BROWSER_ACTIONS);

  // Her own cursor + visible browser (docs/AGENT_CURSOR.md). The browser window
  // only opens when a browser.task actually runs.
  const cursor = new AgentCursor(ctx.bus, { sleep: deps.sleep });
  const backend = deps.browserBackend?.() ?? null;
  const browser = backend ? new EveBrowser(backend, cursor, ctx.bus, { sleep: deps.sleep }) : null;
  gate.tools = { cursor, browser };
  // Shared attention: she points at what she's talking about (pointer.ts).
  const offPointer = startPointer(ctx, cursor, { osa: deps.osa, now: deps.now, browserOpen: () => browser?.isOpen() ?? false });

  /**
   * The show: visible browsing that runs next to a task, never in its way.
   * Only when someone is watching her cursor (the overlay's cursor layer said
   * hello) or EVE_BROWSER_SHOW=1; EVE_BROWSER_SHOW=0 turns it off.
   */
  const showOn = () => {
    const flag = deps.env("EVE_BROWSER_SHOW");
    return !!browser && flag !== "0" && (flag === "1" || cursor.watching());
  };
  function show(args: Record<string, unknown>, taskId?: string, parent?: string) {
    if (!showOn()) return;
    // followup:false: the show runs beside a task whose summary is the answer, not a menu to pick from.
    void gate.request("browser.task", { budget: 10, ...args, followup: false }, { taskId, parent }).catch(() => {});
  }
  function startShow(taskId: string, goal: string, context: string, parent?: string): () => void {
    if (!showOn()) return () => {};
    const location = deps.env("EIGEN_LOCATION") || "Irvine, CA";
    const prefs = heuristicPrefs([goal, context]);
    if (PLACE_GOAL.test(goal) || prefs.cuisine) {
      const q = `${mapsQuery(prefs.cuisine ? prefs : { ...prefs, cuisine: "dinner" })} near ${location}`;
      show({ goal: `look up ${q}`, query: q, maps: true }, taskId, parent);
    }
    // The pick arrives as the calendar request (harem or built-in): go look at it while she asks.
    const off = ctx.bus.on("action.request", (e) => {
      if (e.data.taskId !== taskId || !/^calendar\.create/.test(e.data.kind)) return;
      off();
      const a = e.data.args ?? {};
      const name = String(a.location ?? a.title ?? "").split(",")[0]!.replace(/\s*\(.*\)$/, "").trim();
      if (!name) return;
      const place = { name, address: location };
      rememberPlace(place);
      ctx.setSlot("agency", "last_place", name);
      show({ goal: `check out ${name}`, place }, taskId, parent);
    });
    return off;
  }

  // Someone else (harem, shell, an operator script) asked for an action on the bus:
  // same gate, their actionId, never their permission claim if it's lower than ours.
  const offExternal = ctx.bus.on("action.request", (e) => {
    if (e.source === SRC) return;
    void gate.request(e.data.kind, e.data.args ?? {}, {
      actionId: e.data.actionId,
      taskId: e.data.taskId,
      description: e.data.description,
      external: true,
      requestedBy: e.source,
      claimed: e.data.permission,
      claimedNeedsApproval: e.data.needsApproval,
      parent: e.id,
    });
  });

  // Calendar.app reads take seconds, so harem gets the freshest cached read and a
  // short wait for a new one. The read keeps going in the background for next time.
  let schedule: { at: number; text: string } | null = null;
  let reading: Promise<unknown> | null = null;
  function refreshSchedule(): Promise<unknown> {
    reading ??= gate
      .request("calendar.free_busy", {})
      .then((r) => {
        if (r.ok) schedule = { at: deps.now(), text: r.observation };
      })
      .finally(() => (reading = null));
    return reading;
  }
  async function haremSchedule(): Promise<string> {
    const fresh = schedule && deps.now() - schedule.at < 10 * 60_000;
    if (!fresh) await Promise.race([refreshSchedule(), Bun.sleep(4000)]);
    return schedule?.text ?? "calendar still loading, assume free after 19:00";
  }

  async function runTask(goal: string, o: { parent?: string } = {}): Promise<{ ok: boolean; summary: string }> {
    const taskId = newId("task");
    const t0 = deps.now();
    const brains = ctx.tryUse("brains");
    const harem = await deps.loadHarem();
    ctx.bus.emit("task.start", { taskId, goal, brain: harem ? "harem" : "agency" }, SRC, o.parent);
    ctx.bus.emit("avatar.state", { state: "thinking" }, SRC, o.parent);
    ctx.setSlot("agency", "task", goal);
    // The visible browse runs beside the task and never delays its answer.
    const offShow = startShow(taskId, goal, ctx.contextBlock(), o.parent);

    try {
      if (harem) {
        try {
          const memories = await ctx
            .tryUse("memory")
            ?.recall(goal, { k: 5, parent: o.parent })
            .catch(() => []);
          const context = [ctx.contextBlock(), ...(memories ?? []).map((h) => `- memory: ${h.record.content}`)].join("\n");
          const brain: HaremBrain | undefined =
            ctx.config.demo && harem.ScriptedBrain && harem.DEMO_SCRIPTS ? new harem.ScriptedBrain(harem.DEMO_SCRIPTS) : brains ? frontierAsHaremBrain(brains) : undefined;
          const out = await harem.executeWithHarem({ taskId, goal, context }, { bus: ctx.bus, world: ctx.world, brain, schedule: haremSchedule, approvalTimeoutMs: (opts.approvalTimeoutMs ?? 30_000) + 2000 });
          // Harem emits task.done itself.
          return { ok: out.ok, summary: out.summary };
        } catch (err) {
          ctx.log("agency", "harem failed, falling back to the built-in planner:", String(err));
          ctx.bus.emit("diag", { label: "harem", value: `fell back: ${String(err).slice(0, 80)}`, ttlMs: 5000 }, SRC);
        }
      }

      let out;
      try {
        out = await runBuiltinTask(ctx, gate, deps, taskId, goal, o.parent);
      } catch (err) {
        ctx.log("agency", "built-in planner crashed:", err);
        if (!ctx.config.demo) throw err;
        out = cannedOutcome(deps.now());
      }
      ctx.bus.emit("task.done", { taskId, ok: out.ok, summary: out.summary, ms: deps.now() - t0 }, SRC, o.parent);
      await ctx
        .tryUse("home")
        ?.write("task_state", { taskId, goal, ...out, at: deps.now() })
        .catch(() => {});
      return { ok: out.ok, summary: out.summary };
    } catch (err) {
      const summary = `I got stuck: ${err instanceof Error ? err.message : String(err)}`;
      ctx.bus.emit("task.done", { taskId, ok: false, summary, ms: deps.now() - t0 }, SRC, o.parent);
      return { ok: false, summary };
    } finally {
      ctx.setSlot("agency", "task", null);
      // Harem resolves before the calendar request can land: keep listening a moment.
      setTimeout(offShow, 5000);
    }
  }

  const service: AgencyService = {
    runTask,
    act: async (kind, args, o = {}) => {
      const r = await gate.request(kind, args, { taskId: o.taskId, description: o.description, parent: o.parent, preApproved: o.approved });
      return { ok: r.ok, observation: r.observation, ...(r.data !== undefined ? { data: r.data } : {}) };
    },
  };

  const stop = () => {
    offExternal();
    offPointer();
    cursor.stop();
    void browser?.close();
  };
  return { gate, deps, service, runTask, cursor, browser, stop };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function agencyModule(opts: AgencyOptions = {}): Module {
  let agency: ReturnType<typeof createAgency> | null = null;
  let watcher: ReturnType<typeof Bun.spawn> | null = null;
  const scrapeCache = new Map<string, { at: number; data: unknown }>();

  return {
    name: "agency",
    start(ctx: CoreContext) {
      const a = (agency = createAgency(ctx, opts));
      ctx.provide("agency", a.service);

      // Shell enrichment for gaze targets: GET /api/page/scrape?url=
      ctx.route("/api/page/scrape", async (req, url) => {
        const target = url.searchParams.get("url") ?? "";
        if (!/^https?:\/\//i.test(target)) return json({ ok: false, error: "url must be http(s)" }, 400);
        const hit = scrapeCache.get(target);
        if (hit && Date.now() - hit.at < 10 * 60_000) return json({ ok: true, cached: true, ...(hit.data as object) });
        try {
          const page = await webScrape({ ctx, deps: a.deps, act: (k, args) => a.gate.request(k, args) }, target);
          scrapeCache.set(target, { at: Date.now(), data: page });
          return json({ ok: true, ...page });
        } catch (err) {
          return json({ ok: false, error: err instanceof Error ? err.message : String(err) }, 502);
        }
      });
      ctx.route("/api/agency/trace", () => json({ ok: true, budget: a.gate.policy.budget, spent: a.gate.policy.used(), pending: a.gate.pending(), trace: a.gate.trace }));
      ctx.route("/api/agency/actions", () =>
        json({ ok: true, actions: [...a.gate.registry.values()].map((d) => ({ kind: d.kind, permission: effectivePermission(d) })) }),
      );
      ctx.route("/api/agency/task", async (req) => {
        if (req.method !== "POST") return null;
        const goal = String((await body(req)).goal ?? "").trim();
        if (!goal) return json({ ok: false, error: "goal required" }, 400);
        void a.runTask(goal);
        return json({ ok: true, started: goal });
      });
      ctx.route("/api/agency/act", async (req) => {
        if (req.method !== "POST") return null;
        const b = await body(req);
        const r = await a.gate.request(String(b.kind ?? ""), (b.args as Record<string, unknown>) ?? {}, { requestedBy: "http" });
        return json(r);
      });

      const wantWatcher = opts.watcher ?? secret("EIGEN_WATCHER") === "1";
      const script = join(REPO_ROOT, "watcher", "watch.py");
      if (wantWatcher && existsSync(script)) {
        watcher = Bun.spawn(["python3", script, "--core", `http://127.0.0.1:${ctx.config.port}`], { stdout: "inherit", stderr: "inherit" });
        ctx.log("agency", `watcher started (pid ${watcher.pid})`);
      }
    },
    stop() {
      agency?.stop();
      watcher?.kill();
    },
  };
}
