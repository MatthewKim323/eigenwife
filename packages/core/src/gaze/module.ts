import type { CoreContext, Module } from "../context";
import { json } from "../hub";
import { secret } from "../config";
import { realExec } from "../work/exec";
import { createCapture, type AxHit } from "../screen/capture";
import { isEve } from "../screen/module";
import { hostOf, loadSettings, PRIVATE_DOMAINS, privateReason, type ScreenSettings } from "../screen/privacy";
import { redactScreenText } from "../screen/redact";
import { DesktopGaze, toTarget, type DesktopGazeOptions, type EyeMsg, type Resolved, type Skip } from "./desktop";

/**
 * Desktop gaze (docs/GAZE.md): eye serve's fixations -> the thing under them on
 * the real screen -> gaze.target. Reuses the screen sense's helper binary,
 * privacy rules (private apps/domains/titles, secure fields, redaction) and
 * pause state (screen.json, cmd+shift+P, attention.pause). The shell page keeps
 * doing its own DOM gaze: points over Eve's own windows are skipped here.
 *
 * EVE_DESKTOP_GAZE=0 turns it off. Quiet when eye serve isn't running.
 */

const SRC = "gaze";

export interface DesktopGazeModuleOptions extends DesktopGazeOptions {
  /** Resolve a point (tests). Default: screen-ax at + privacy. */
  at?: (x: number, y: number, o: { denyHosts: string[]; minW: number; minH: number }) => Promise<AxHit>;
  /** Connect to eye serve (tests pass false and feed messages directly). */
  connect?: boolean;
  tickMs?: number;
}

export function createDesktopGaze(ctx: CoreContext, opts: DesktopGazeModuleOptions = {}) {
  const log = (...a: unknown[]) => ctx.log("gaze", ...a);
  let settings: ScreenSettings = loadSettings(ctx.config.eveHome);
  let settingsAt = Date.now();
  let ptPerDeg = 48;
  let accuracyDeg = 2.5;
  let attentionPaused = false;
  let told = false;

  let capture: ReturnType<typeof createCapture> | null = null;
  const at =
    opts.at ??
    ((x: number, y: number, o: { denyHosts: string[]; minW: number; minH: number }) => (capture ??= createCapture({ exec: realExec, eveHome: ctx.config.eveHome, log })).at(x, y, o));

  function freshSettings(): ScreenSettings {
    if (Date.now() - settingsAt > 10_000) {
      settings = loadSettings(ctx.config.eveHome);
      settingsAt = Date.now();
    }
    return settings;
  }

  const paused = () => attentionPaused || freshSettings().paused || ctx.tryUse("screen")?.paused() === true || secret("EVE_SCREEN") === "0";

  async function resolve(x: number, y: number): Promise<Resolved | Skip> {
    if (paused()) return { skip: "paused" };
    const s = freshSettings();
    const accPt = accuracyDeg * ptPerDeg;
    const hit = await at(x, y, { denyHosts: [...PRIVATE_DOMAINS, ...s.denyDomains], minW: accPt * 1.6, minH: accPt * 0.5 });
    if (!hit.ok) {
      if (hit.error === "accessibility" && !told) {
        told = true;
        log("no accessibility permission: desktop gaze can't see what's under your eyes");
      }
      return { skip: "error", why: hit.error };
    }
    if (hit.none) return { skip: "none" };
    if (hit.private || hit.secure) return { skip: "private", why: hit.secure ? "secure field" : "private site" };
    if (isEve({ app: hit.app, bundleId: hit.bundleId, title: hit.title, url: hit.url })) return { skip: "eve" };
    const why = privateReason({ app: hit.app, bundleId: hit.bundleId, title: hit.title, url: hit.url }, s);
    if (why) return { skip: "private", why };
    const label = redactScreenText(hit.label).text;
    const title = hit.title ? redactScreenText(hit.title).text : undefined;
    return toTarget({ ...hit, label, title }, { x, y }, hostOf(hit.url), accPt);
  }

  const dg = new DesktopGaze(
    {
      resolve,
      emit: (type, data) => ctx.bus.emit(type, data, SRC),
      paused,
    },
    opts,
  );

  const offs: (() => void)[] = [ctx.bus.on("attention.pause", (e) => void (attentionPaused = e.data.paused))];

  function feed(m: EyeMsg) {
    if (m.type === "hello") {
      const d = m.display as { ptPerDeg?: number } | undefined;
      if (typeof d?.ptPerDeg === "number" && d.ptPerDeg > 0) ptPerDeg = d.ptPerDeg;
      const acc = typeof m.uncertaintyDeg === "number" ? m.uncertaintyDeg : m.accuracyDeg;
      if (typeof acc === "number" && acc > 0) accuracyDeg = acc;
    }
    dg.onMessage(m, Date.now());
  }

  // --- eye serve connection (reconnecting, silent when it isn't running) -------------
  let ws: WebSocket | null = null;
  let closed = false;
  let backoff = 1000;
  let everUp = false;
  function open() {
    if (closed) return;
    let sock: WebSocket;
    try {
      sock = new WebSocket(ctx.config.eyeUrl);
    } catch {
      return retry();
    }
    ws = sock;
    sock.onopen = () => {
      backoff = 1000;
      if (!everUp) log(`desktop gaze on (${ctx.config.eyeUrl})`);
      everUp = true;
      dg.connected(true);
    };
    sock.onmessage = (ev) => {
      try {
        const m = JSON.parse(typeof ev.data === "string" ? ev.data : String(ev.data)) as EyeMsg;
        if (m && typeof m.type === "string") feed(m);
      } catch {}
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      dg.connected(false);
      retry();
    };
    sock.onerror = () => {
      try {
        sock.close();
      } catch {}
    };
  }
  function retry() {
    if (closed) return;
    setTimeout(open, backoff);
    backoff = Math.min(backoff * 2, 10_000);
  }

  let busy = false;
  const timer = setInterval(() => {
    if (busy) return;
    busy = true;
    void dg
      .tick(Date.now())
      .catch((err) => log("tick failed:", err))
      .finally(() => (busy = false));
  }, opts.tickMs ?? 200);

  if (opts.connect !== false) open();

  return {
    feed,
    tick: (now = Date.now()) => dg.tick(now),
    status: () => ({ ...dg.snapshot(), paused: paused(), accuracyDeg, ptPerDeg, eyeUrl: ctx.config.eyeUrl, connected: !!ws }),
    stop() {
      closed = true;
      clearInterval(timer);
      for (const off of offs.splice(0)) off();
      ws?.close();
    },
  };
}

export function desktopGazeModule(opts: DesktopGazeModuleOptions = {}): Module {
  let g: ReturnType<typeof createDesktopGaze> | null = null;
  return {
    name: "gaze",
    start(ctx) {
      if (secret("EVE_DESKTOP_GAZE") === "0" || (process.platform !== "darwin" && opts.connect !== false)) {
        ctx.log("gaze", "desktop gaze off");
        return;
      }
      g = createDesktopGaze(ctx, { connect: process.env.NODE_ENV !== "test", ...opts });
      ctx.route("/api/gaze/status", () => json(g!.status()));
    },
    stop() {
      g?.stop();
    },
  };
}
