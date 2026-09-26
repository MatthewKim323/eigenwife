import type { EventMap } from "@eigenwife/protocol";
import { jevEndpoint, secret } from "../config";
import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import type { ScreenService, ScreenSnapshot } from "../services";
import { bunSpawn, whichBin, type BrainIO } from "../brains/io";
import { frontmostApp, hidIdleSeconds } from "../work/context";
import { realExec } from "../work/exec";
import type { Exec } from "../agency/types";
import { createCapture, type AxDump, type Capture, type Permissions } from "./capture";
import { createScreenJev, type ScreenJev, type ScreenScores } from "./jev";
import { screenMemory } from "./memory";
import { loadSettings, PRIVATE_DOMAINS, privateReason, saveSettings, type ScreenSettings } from "./privacy";
import { capText, redactScreenText, SCREEN_MAX_CHARS } from "./redact";
import { summarize, type AxText, type Digest } from "./summarize";
import { defaultVisionEngines, describeImage, type VisionRequest, type VisionResult } from "./vision";

/**
 * Screen awareness (docs/SCREEN.md). Level 2: every few seconds while matt is
 * active, read the focused window's accessibility text, redact it, summarize
 * it locally, and let Jev judge the summary (mode / stuck / interesting /
 * sensitive). Level 3: a one-off capture of just the focused window for a
 * vision model, only when asked ("what do you think of this"), when she
 * offers help on a stuck error, or (opt-in) when idle and interesting.
 * Everything else stays on the machine. Pausable, and a kill switch.
 */

const SRC = "screen";

export type LookReason = "deictic" | "stuck" | "auto";

export interface ScreenDeps {
  capture: Pick<Capture, "dump" | "permissions" | "withWindowImage" | "sweep">;
  jev: ScreenJev;
  vision(req: VisionRequest): Promise<VisionResult>;
  /** Frontmost app, unprivileged (lsappinfo). */
  front(): Promise<{ app?: string; bundleId?: string; pid?: number }>;
  idleSeconds(): Promise<number | null>;
  now(): number;
  env(name: string): string;
  loadSettings(): ScreenSettings;
  saveSettings(s: ScreenSettings): void;
}

export interface ScreenOptions {
  deps?: Partial<ScreenDeps>;
  /** Poll the focused window. Default: on macOS outside tests, unless EVE_SCREEN=0. */
  poll?: boolean;
  pollMs?: number;
  /** Same error visible this long = stuck. */
  stuckMs?: number;
  /** Re-judge an unchanged screen this often while an error is up (so "stuck" can grow). */
  heartbeatMs?: number;
  /** No keyboard/mouse input for this long = not active, stop reading. */
  activeIdleS?: number;
  /** Level 3 (c): look when idle-and-interesting. Default EVE_SCREEN_AUTOVISION=1. */
  autoVision?: boolean;
  autoVisionEveryMs?: number;
}

/** Eve's own windows: the overlay (Electron) and the shell tab. Never read, "this" never means her. */
export function isEve(d: { app?: string; bundleId?: string; title?: string; url?: string }): boolean {
  const app = (d.app ?? "").toLowerCase();
  if (app === "electron" || app === "eve" || /com\.github\.electron/i.test(d.bundleId ?? "")) return true;
  if (/^(?:https?:\/\/)?(?:127\.0\.0\.1|localhost):5173\b/.test(d.url ?? "")) return true;
  return /^eigenwife\b/i.test(d.title ?? "");
}

/** Which app macOS attributes the permission to, for the spoken hint. */
export function hostAppName(env: Record<string, string | undefined> = process.env): string {
  const t = (env.TERM_PROGRAM ?? "").toLowerCase();
  if (t === "apple_terminal") return "Terminal";
  if (t === "iterm.app") return "iTerm";
  if (t === "vscode") return env.CURSOR_TRACE_ID ? "Cursor" : "your editor";
  if (t === "ghostty") return "Ghostty";
  if (t === "warpterminal") return "Warp";
  return "the app you run my core from";
}

export const PERMISSION_LINES = {
  accessibility: (host: string) => `heads up, i can't read your screen yet. system settings, privacy and security, accessibility, then turn on ${host}.`,
  screenRecording: (host: string) => `i can't actually see windows yet. system settings, privacy and security, screen recording, turn on ${host}, then restart me.`,
};

/** "VS Code, TypeError in hub.ts line 42, stuck ~6 min". The world slot every prompt sees. */
export function onScreenLine(o: ScreenSnapshot): string {
  if (o.private) return "a private app (not looking)";
  const bits = [o.summary];
  if (o.error && o.stuckMs && o.stuckMs >= 60_000) bits.push(`same error for ~${Math.round(o.stuckMs / 60_000)} min`);
  if (o.focus) bits.push("typing, deep focus");
  return bits.join(", ");
}

function redactRead(d: AxDump): { texts: AxText[]; selected?: string; focusedValue?: string; count: number } {
  let count = 0;
  let budget = SCREEN_MAX_CHARS;
  const texts: AxText[] = [];
  for (const x of d.texts) {
    if (budget <= 0) break;
    if (/secure/i.test(x.r)) continue;
    const r = redactScreenText(x.t);
    count += r.count;
    const t = capText(r.text, budget);
    if (!t) continue;
    texts.push({ r: x.r, t });
    budget -= t.length;
  }
  const one = (s?: string) => {
    if (!s || d.secureFocused) return undefined;
    const r = redactScreenText(s);
    count += r.count;
    return capText(r.text, 500) || undefined;
  };
  return { texts, selected: one(d.selected), focusedValue: one(d.focusedValue), count };
}

export function createScreen(ctx: CoreContext, opts: ScreenOptions = {}) {
  const env = (n: string) => opts.deps?.env?.(n) ?? secret(n);
  const enabled = env("EVE_SCREEN") !== "0";
  const now = opts.deps?.now ?? (() => Date.now());
  const exec: Exec = realExec;
  const log = (...a: unknown[]) => ctx.log("screen", ...a);
  const stuckMs = opts.stuckMs ?? 5 * 60_000;
  const heartbeatMs = opts.heartbeatMs ?? 60_000;
  const activeIdleS = opts.activeIdleS ?? 90;
  const autoVision = opts.autoVision ?? env("EVE_SCREEN_AUTOVISION") === "1";
  const autoEvery = opts.autoVisionEveryMs ?? 2 * 60_000;

  let capture: ScreenDeps["capture"] | undefined = opts.deps?.capture;
  const getCapture = () => (capture ??= createCapture({ exec, eveHome: ctx.config.eveHome, log }));
  const io: BrainIO = { fetch: (u, i) => fetch(u, i), spawn: bunSpawn, secret, which: (b) => whichBin(b), workDir: ctx.config.eveHome, now };
  const deps: ScreenDeps = {
    capture: {
      dump: (o) => getCapture().dump(o),
      permissions: () => getCapture().permissions(),
      withWindowImage: (id, use) => getCapture().withWindowImage(id, use),
      sweep: () => getCapture().sweep(),
    },
    jev: (() => {
      const ep = jevEndpoint();
      return createScreenJev(ep ? { apiKey: ep.apiKey, url: ep.url, model: ep.model, stuckMs } : { stuckMs });
    })(),
    vision: (req) => describeImage(defaultVisionEngines(io), req, now),
    front: () => frontmostApp(exec),
    idleSeconds: () => hidIdleSeconds(exec),
    now,
    env,
    loadSettings: () => loadSettings(ctx.config.eveHome),
    saveSettings: (s) => saveSettings(ctx.config.eveHome, s),
    ...opts.deps,
  };

  let settings = deps.loadSettings();
  let attentionPaused = false;
  let snapshot: ScreenSnapshot | null = null;
  let frontIsEve = false;
  /** The last window that wasn't Eve: clicking her shouldn't blind her. */
  let lastRealFront: { app?: string; bundleId?: string; pid?: number } | null = null;
  /** Why the current window is off limits (for her reply and debugging), never its content. */
  let privateWhy: string | null = null;
  let last: { signature: string; app: string; emittedAt: number; scores?: ScreenScores; private?: boolean } | null = null;
  let track: { key: string; since: number; lastSeen: number } | null = null;
  let perms: Permissions | null = null;
  let lastMemoryAt: number | undefined;
  const lastLookAt: Partial<Record<LookReason, number>> = {};
  let looking = false;
  let reading = false;
  const stats = { reads: 0, observations: 0, jev: 0, private: 0, looks: 0, skipped: 0 };

  const paused = () => !enabled || settings.paused || attentionPaused;

  function setPaused(p: boolean, by?: string) {
    if (settings.paused === p) return;
    settings = { ...settings, paused: p };
    deps.saveSettings(settings);
    log(`screen ${p ? "paused" : "resumed"}${by ? ` by ${by}` : ""}`);
    if (p) {
      ctx.setSlot(SRC, "on_screen", null);
      ctx.setSlot(SRC, "focus", null);
    }
  }

  async function say(line: string) {
    const speech = ctx.tryUse("speech");
    if (speech) await speech.say(line, { priority: "normal", brain: "screen" }).catch(() => {});
  }

  /** Say once (ever, persisted) how to grant a missing permission. */
  async function hint(which: "accessibility" | "screenRecording") {
    if (settings.told[which] || !ctx.world().companion.born) return;
    settings = { ...settings, told: { ...settings.told, [which]: true } };
    deps.saveSettings(settings);
    await say(PERMISSION_LINES[which](hostAppName()));
  }

  async function checkPermissions(): Promise<Permissions> {
    perms = await deps.capture.permissions();
    ctx.bus.emit("screen.permission", perms, SRC);
    return perms;
  }

  const flash = (level: 2 | 3, active: boolean, reason?: string) => ctx.bus.emit("screen.looking", { level, active, ...(reason ? { reason } : {}) }, SRC);

  function emitPrivate(app: string) {
    stats.private++;
    track = null;
    const changed = !last?.private;
    last = { signature: "private", app, emittedAt: now(), private: true };
    snapshot = { app: "private app", summary: "", mode: "idle", stuck: false, interesting: 0, private: true, at: now() };
    ctx.setSlot(SRC, "on_screen", onScreenLine(snapshot));
    ctx.setSlot(SRC, "focus", null);
    if (changed) ctx.bus.emit("screen.observation", { app: "private app", summary: "", scores: { mode: "idle", stuck: false, interesting: 0, sensitive: true }, by: "local", private: true }, SRC);
  }

  /** One level-2 pass. Returns what happened, for tests and the status route. */
  async function tick(): Promise<string> {
    if (paused()) return "paused";
    if (reading || looking) return "busy";
    if (!ctx.world().companion.born) return "unborn";
    reading = true;
    try {
      const idle = await deps.idleSeconds().catch(() => null);
      if (idle !== null && idle > activeIdleS) return "inactive";
      const front = await deps.front().catch(() => ({}) as { app?: string; bundleId?: string; pid?: number });
      if (!front.app) return "no app";
      if (isEve(front)) {
        frontIsEve = true;
        return "eve";
      }
      frontIsEve = false;
      lastRealFront = front;
      // Private apps are skipped before a single accessibility call.
      const why = privateReason(front, settings);
      privateWhy = why;
      if (why) {
        emitPrivate(front.app);
        return "private";
      }
      if (perms === null) await checkPermissions().catch(() => null);
      if (perms?.accessibility === false) {
        void hint("accessibility");
        return "no permission";
      }
      flash(2, true);
      const d = await deps.capture.dump({ pid: front.pid, denyHosts: [...PRIVATE_DOMAINS, ...settings.denyDomains] });
      stats.reads++;
      if (!d.ok) {
        if (d.error === "accessibility") {
          perms = { accessibility: false, screenRecording: perms?.screenRecording ?? null };
          void hint("accessibility");
        }
        return `read failed: ${d.error ?? "?"}`;
      }
      if (d.private || privateReason(d, settings)) {
        emitPrivate(d.app || front.app);
        return "private";
      }
      if (isEve(d)) {
        frontIsEve = true;
        return "eve";
      }
      const red = redactRead(d);
      const digest = summarize({ app: d.app || front.app, bundleId: d.bundleId, title: d.title ? redactScreenText(d.title).text : undefined, url: d.url, texts: red.texts, selected: red.selected, focusedValue: red.focusedValue, focusedRole: d.focusedRole }, red.count);
      const t = now();
      if (digest.errorKey) {
        if (track && track.key === digest.errorKey && t - track.lastSeen < 2 * heartbeatMs) track.lastSeen = t;
        else track = { key: digest.errorKey, since: t, lastSeen: t };
      } else if (track && t - track.lastSeen > 2 * heartbeatMs) track = null;
      const stuckFor = digest.errorKey && track ? t - track.since : 0;
      const changed = !last || last.private || last.signature !== digest.signature;
      const beat = !!digest.error && !!last && t - last.emittedAt >= heartbeatMs;
      if (!changed && !beat) {
        stats.skipped++;
        return "unchanged";
      }
      return await observe(digest, stuckFor, idle);
    } finally {
      reading = false;
    }
  }

  async function observe(digest: Digest, stuckFor: number, idle: number | null): Promise<string> {
    const t = now();
    if (digest.guess.sensitive) {
      // Locally obvious: never sent to Jev at all.
      emitPrivate(digest.app);
      return "sensitive (local)";
    }
    const j = await deps.jev.judge({ digest, stuckMs: stuckFor, idleSeconds: idle });
    if (j.by === "jev") stats.jev++;
    if (j.scores.sensitive) {
      emitPrivate(digest.app);
      return "sensitive (jev)";
    }
    const focus = idle !== null && idle < 4 && (j.scores.mode === "coding" || j.scores.mode === "writing" || j.scores.mode === "debugging");
    last = { signature: digest.signature, app: digest.app, emittedAt: t, scores: j.scores };
    snapshot = {
      app: digest.app,
      title: digest.title,
      summary: digest.summary,
      mode: j.scores.mode,
      stuck: j.scores.stuck,
      interesting: j.scores.interesting,
      ...(digest.error ? { error: digest.error, stuckMs: stuckFor } : {}),
      focus,
      at: t,
    };
    const data: EventMap["screen.observation"] = {
      app: digest.app,
      ...(digest.title ? { title: digest.title.slice(0, 120) } : {}),
      summary: digest.summary,
      scores: j.scores,
      by: j.by,
      ...(digest.error ? { error: digest.error, stuckMs: stuckFor } : {}),
      focus,
      ...(digest.host ? { host: digest.host } : {}),
    };
    stats.observations++;
    ctx.bus.emit("screen.observation", data, SRC);
    ctx.setSlot(SRC, "on_screen", onScreenLine(snapshot));
    ctx.setSlot(SRC, "focus", focus ? "deep" : null);
    const mem = screenMemory({ kind: "observation", app: digest.app, summary: digest.summary, scores: j.scores, lastAt: lastMemoryAt, now: t });
    if (mem) {
      lastMemoryAt = t;
      void ctx.tryUse("memory")?.write({ kind: mem.kind, content: mem.content, importance: mem.importance, confidence: mem.confidence, tags: mem.tags, source: "screen" }, mem.policy).catch(() => null);
    }
    if (autoVision && !focus && idle !== null && idle >= 5 && j.scores.interesting >= 0.7 && t - (lastLookAt.auto ?? -Infinity) >= autoEvery) void look("auto");
    return `observed (${j.by})`;
  }

  const LOOK_GAP: Record<LookReason, number> = { deictic: 8_000, stuck: 10 * 60_000, auto: autoEvery };

  async function look(reason: LookReason, o: { question?: string; parent?: string } = {}): Promise<{ ok: boolean; description: string; app?: string; by: string; error?: string }> {
    const fail = (error: string) => ({ ok: false, description: "", by: "none", error });
    if (!enabled) return fail("screen is off (EVE_SCREEN=0)");
    if (paused()) return fail("screen paused");
    if (looking) return fail("already looking");
    const t = now();
    if (t - (lastLookAt[reason] ?? -Infinity) < LOOK_GAP[reason]) return fail("looked a moment ago");
    looking = true;
    let flashed = false;
    try {
      let front = await deps.front().catch(() => ({}) as { app?: string; bundleId?: string; pid?: number });
      if (front.app && isEve(front) && lastRealFront?.app) front = lastRealFront;
      if (!front.app || isEve(front)) return fail("nothing to look at");
      if (privateReason(front, settings)) return fail("private app");
      if (perms === null) await checkPermissions().catch(() => null);
      if (perms?.screenRecording === false) {
        void hint("screenRecording");
        return fail("no screen recording permission");
      }
      const d = await deps.capture.dump({ pid: front.pid, maxChars: 2000, denyHosts: [...PRIVATE_DOMAINS, ...settings.denyDomains] });
      if (!d.ok || d.private || privateReason(d, settings) || isEve(d)) return fail(d.ok ? "private or eve" : `no window (${d.error ?? "?"})`);
      if (!d.windowId) return fail("no window id");
      lastLookAt[reason] = t;
      stats.looks++;
      flash(3, true, reason);
      flashed = true;
      const hint2 = snapshot && snapshot.app === (d.app || front.app) && !snapshot.private ? snapshot.summary : undefined;
      const r = await deps.capture.withWindowImage(d.windowId, (imagePath) => deps.vision({ imagePath, question: o.question, hint: hint2 }));
      const app = d.app || front.app;
      if (!r.ok) {
        ctx.bus.emit("screen.vision", { app, reason, description: "", by: "none", ms: now() - t, ok: false }, SRC, o.parent);
        return fail(r.error);
      }
      const v = r.value;
      if (v.private) {
        ctx.bus.emit("screen.vision", { app: "private app", reason, description: "", by: v.by, ms: v.ms, ok: false }, SRC, o.parent);
        return fail("looked private");
      }
      ctx.bus.emit("screen.vision", { app, ...(d.title ? { title: redactScreenText(d.title).text.slice(0, 120) } : {}), reason, description: v.description, by: v.by, ms: v.ms, ok: v.ok }, SRC, o.parent);
      if (!v.ok) return { ok: false, description: "", app, by: v.by, error: v.error };
      ctx.setSlot(SRC, "last_look", `${app}: ${v.description}`);
      const scores = snapshot?.app === app && last?.scores ? last.scores : { mode: "idle" as const, stuck: false, interesting: 0.6, sensitive: false };
      const mem = reason === "stuck" ? null : screenMemory({ kind: "vision", app, summary: `${app}: ${v.description}`, scores, lastAt: lastMemoryAt, now: t });
      if (mem) {
        lastMemoryAt = t;
        void ctx.tryUse("memory")?.write({ kind: mem.kind, content: mem.content, importance: mem.importance, confidence: mem.confidence, tags: mem.tags, source: "screen" }, mem.policy).catch(() => null);
      }
      return { ok: true, description: v.description, app, by: v.by };
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    } finally {
      if (flashed) flash(3, false, reason);
      looking = false;
    }
  }

  const service: ScreenService = {
    current: () => (paused() ? null : snapshot),
    canLook: () => enabled && !paused() && (!frontIsEve || !!lastRealFront?.app) && !snapshot?.private,
    /** Why she can't look right now, or null. */
    blocked: (): string | null =>
      !enabled ? "screen is off" : paused() ? "screen is paused" : snapshot?.private ? `private window (${privateWhy ?? "private"})` : frontIsEve && !lastRealFront?.app ? "nothing to look at" : null,
    look,
    paused,
  };

  const offs: (() => void)[] = [];
  offs.push(
    ctx.bus.on("screen.pause", (e) => setPaused(e.data.paused, e.data.by)),
    ctx.bus.on("attention.pause", (e) => {
      attentionPaused = e.data.paused;
    }),
    ctx.bus.on("companion.born", () => {
      if (!enabled || !wantPoll) return;
      void checkPermissions()
        .then((p) => {
          if (!p.accessibility) void hint("accessibility");
        })
        .catch(() => {});
    }),
  );

  let timer: ReturnType<typeof setInterval> | undefined;
  const wantPoll = enabled && (opts.poll ?? (process.platform === "darwin" && process.env.NODE_ENV !== "test"));
  if (wantPoll) {
    const swept = deps.capture.sweep();
    if (swept) log(`removed ${swept} leftover capture(s)`);
    timer = setInterval(() => void tick().catch((err) => log("tick failed:", err)), opts.pollMs ?? 7000);
  }
  if (!enabled) log("screen awareness off (EVE_SCREEN=0)");

  function status() {
    return {
      enabled,
      polling: !!timer,
      paused: settings.paused,
      attentionPaused,
      autoVision,
      permissions: perms,
      current: snapshot,
      jev: deps.jev.status(),
      stats,
      denylist: { apps: settings.denyApps, domains: settings.denyDomains },
    };
  }

  return {
    service,
    tick,
    look,
    status,
    setPaused,
    checkPermissions,
    stop() {
      for (const off of offs.splice(0)) off();
      if (timer) clearInterval(timer);
    },
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function screenModule(opts: ScreenOptions = {}): Module {
  let screen: ReturnType<typeof createScreen> | null = null;
  return {
    name: "screen",
    start(ctx) {
      const s = (screen = createScreen(ctx, opts));
      ctx.provide("screen", s.service);
      ctx.route("/api/screen/status", () => json(s.status()));
      ctx.route("/api/screen/pause", async (req) => {
        if (req.method !== "POST") return null;
        const paused = (await body(req)).paused !== false;
        ctx.bus.emit("screen.pause", { paused, by: "http" }, SRC);
        return json({ ok: true, paused: s.status().paused });
      });
      ctx.route("/api/screen/look", async (req) => {
        if (req.method !== "POST") return null;
        const b = await body(req);
        return json(await s.look("deictic", { question: typeof b.question === "string" ? b.question : undefined }));
      });
    },
    stop() {
      screen?.stop();
    },
  };
}
