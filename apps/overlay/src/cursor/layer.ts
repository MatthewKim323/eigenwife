/**
 * Eve's cursor layer (docs/AGENT_CURSOR.md): a transparent, always
 * click-through window over every display that draws HER pointer. She's
 * always there, like a second player on the same computer: resting by her
 * avatar, wandering now and then (presence.ts), and driven by the core while
 * she works or points at something (agent.cursor). It never reads the screen's
 * pixels and never moves the real cursor; it only draws.
 */
import { execFile } from "child_process";
import { join } from "path";
import { app, BrowserWindow, powerMonitor, screen } from "electron";
import type { CursorPt, ScreenRect } from "@eigenwife/protocol";
import { BusClient } from "@eigenwife/protocol/client";
import { configureCursorWindow, cursorPageQuery, cursorWindowOptions, DEFAULT_HUE, type DisplayLike } from "./config";
import { homeFor, Presence, TypingDetector } from "./presence";

export const CURSOR_BUS_CLIENT = "eve-cursor";

export interface CursorLayerOpts {
  coreHost: string;
  capturable(): boolean;
  log(...a: unknown[]): void;
  /** Her avatar window's bounds (null: no avatar, cursor-only mode). */
  avatar(): ScreenRect | null;
  /** Tray "Show Eve's cursor" and ⌘⇧E together. */
  shown(): boolean;
  /** What her avatar is looking at, reported by the page (screen points). */
  look(): { p: CursorPt; at: number } | null;
}

export interface CursorLayer {
  setCapturable(c: boolean): void;
  /** Re-read shown() right away (tray toggle, ⌘⇧E). */
  refresh(): void;
  stop(): void;
}

/**
 * JXA: is the frontmost app showing a window that fills a whole display?
 * Window bounds and owner names only: no titles, no pixels, no permissions.
 */
export const FULLSCREEN_JXA = `
ObjC.import("CoreGraphics"); ObjC.import("AppKit");
function run() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front) return "no";
  var name = ObjC.unwrap(front.localizedName) || "";
  if (name === "Electron" || name === "Finder") return "no";
  var screens = $.NSScreen.screens, frames = [];
  for (var s = 0; s < screens.count; s++) { var f = screens.objectAtIndex(s).frame; frames.push([f.size.width, f.size.height]); }
  var list = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements, 0));
  for (var i = 0; i < list.count; i++) {
    var w = list.objectAtIndex(i);
    if (ObjC.unwrap(w.objectForKey("kCGWindowOwnerName")) !== name || ObjC.unwrap(w.objectForKey("kCGWindowLayer")) !== 0) continue;
    var b = ObjC.deepUnwrap(w.objectForKey("kCGWindowBounds"));
    for (var k = 0; k < frames.length; k++) if (Math.abs(b.Width - frames[k][0]) < 2 && Math.abs(b.Height - frames[k][1]) < 2) return "yes";
  }
  return "no";
}`;

export function startCursorLayer(opts: CursorLayerOpts): CursorLayer {
  const wins = new Map<number, BrowserWindow>();
  let hue = DEFAULT_HUE;
  let lastBrowser: unknown = null;
  const page = join(app.getAppPath(), "dist", "cursor", "index.html");
  const preload = join(app.getAppPath(), "dist", "cursor-preload.cjs");

  const send = (channel: string, payload: unknown) => {
    for (const w of wins.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };

  // --- presence state ----------------------------------------------------
  const presence = new Presence(Math.random, Date.now());
  const typing = new TypingDetector();
  let user: CursorPt | null = null;
  let userMovedAt = 0;
  let fullscreen = false;
  let level = -1;
  let lastCmd: unknown = null;

  function home(): CursorPt {
    const primary = screen.getPrimaryDisplay();
    const a = opts.avatar();
    if (a) return homeFor(a, screen.getDisplayMatching(a).bounds);
    const wa = primary.workArea;
    return homeFor({ x: wa.x + wa.width - 436, y: wa.y + wa.height - 560, width: 420, height: 560 }, primary.bounds);
  }

  function tick() {
    const now = Date.now();
    const p = screen.getCursorScreenPoint();
    if (!user || p.x !== user.x || p.y !== user.y) {
      user = p;
      userMovedAt = now;
    }
    const quiet = typing.sample(now, powerMonitor.getSystemIdleTime(), userMovedAt) || fullscreen;
    const w = { now, home: home(), user, userMovedAt, look: opts.look(), quiet, shown: opts.shown() };
    const lv = presence.level(w);
    if (lv !== level) {
      level = lv;
      send("cursor:level", lv);
    }
    for (const cmd of presence.tick(w)) {
      lastCmd = cmd;
      send("cursor:event", cmd);
    }
  }

  function checkFullscreen() {
    if (process.platform !== "darwin") return;
    execFile("osascript", ["-l", "JavaScript", "-e", FULLSCREEN_JXA], { timeout: 3000 }, (err, out) => {
      if (!err) fullscreen = String(out).trim() === "yes";
    });
  }

  // --- windows ------------------------------------------------------------
  function open(d: DisplayLike) {
    const w = new BrowserWindow(cursorWindowOptions(d, preload));
    configureCursorWindow(w, d, opts.capturable());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.on("did-finish-load", () => {
      w.showInactive();
      w.webContents.send("cursor:level", Math.max(0, level));
      if (lastCmd) w.webContents.send("cursor:event", { ...(lastCmd as object), ms: 0 });
      if (lastBrowser) w.webContents.send("cursor:browser", lastBrowser);
    });
    w.on("closed", () => wins.delete(d.id));
    void w.loadFile(page, { query: { ...cursorPageQuery(d, hue), presence: "1" } }).catch((err) => opts.log(`cursor layer: ${String(err)}`));
    wins.set(d.id, w);
  }

  function sync() {
    const displays = screen.getAllDisplays();
    const ids = new Set(displays.map((d) => d.id));
    for (const [id, w] of wins) if (!ids.has(id)) w.destroy();
    for (const d of displays) {
      const w = wins.get(d.id);
      if (!w || w.isDestroyed()) open(d);
      else {
        configureCursorWindow(w, d, opts.capturable());
        w.webContents.send("cursor:display", d.bounds);
      }
    }
  }

  sync();
  screen.on("display-added", sync);
  screen.on("display-removed", sync);
  screen.on("display-metrics-changed", sync);
  const ticker = setInterval(tick, 100);
  const fsTimer = setInterval(checkFullscreen, 4000);
  checkFullscreen();

  // --- the core -------------------------------------------------------------
  const bus = new BusClient({ url: `ws://${opts.coreHost}/bus`, client: CURSOR_BUS_CLIENT, role: "observer" }).connect();
  const setHue = (h: unknown) => {
    if (typeof h !== "number" || !Number.isFinite(h) || h === hue) return;
    hue = h;
    send("cursor:hue", h);
  };
  bus.on("bus.welcome", (e) => setHue(e.data.world.companion.persona?.palette.hue));
  bus.on("companion.born", (e) => setHue(e.data.persona.palette.hue));
  bus.on("agent.cursor", (e) => {
    presence.onAgent(e.data, Date.now());
    lastCmd = e.data;
    send("cursor:event", e.data);
  });
  // Belt and braces: if her browser sits untouched for 2 minutes, drop its outline
  // (a window closed some way the core never heard about must not leave a frame behind).
  let browserIdle: ReturnType<typeof setTimeout> | undefined;
  const armBrowserIdle = () => {
    clearTimeout(browserIdle);
    if (!lastBrowser) return;
    browserIdle = setTimeout(() => {
      lastBrowser = null;
      send("cursor:browser", { status: "closed" });
    }, 120_000);
  };
  bus.on("agent.browser", (e) => {
    lastBrowser = e.data.status === "open" ? e.data : null;
    send("cursor:browser", e.data);
    armBrowserIdle();
  });
  bus.on("agent.cursor", () => {
    if (lastBrowser) armBrowserIdle();
  });
  bus.onStatus((up) => {
    opts.log(`cursor layer ${up ? "connected to the core" : "lost the core, retrying"}`);
    if (!up) {
      // Whatever the core was driving is over: drop the browser frame, go home.
      send("cursor:reset", true);
      lastBrowser = null;
      const at = presence.mode() === "agent" && lastCmd ? (lastCmd as CursorPt) : null;
      if (at) presence.onAgent({ x: at.x, y: at.y, action: "idle" }, Date.now());
    }
  });
  opts.log(`cursor layer up on ${wins.size} display(s)`);

  return {
    setCapturable(c: boolean) {
      for (const w of wins.values()) if (!w.isDestroyed()) w.setContentProtection(!c);
    },
    refresh: tick,
    stop() {
      clearInterval(ticker);
      clearInterval(fsTimer);
      bus.close();
      screen.removeListener("display-added", sync);
      screen.removeListener("display-removed", sync);
      screen.removeListener("display-metrics-changed", sync);
      for (const w of wins.values()) if (!w.isDestroyed()) w.destroy();
      wins.clear();
    },
  };
}
