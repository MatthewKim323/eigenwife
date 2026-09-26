/**
 * Eve's cursor layer (docs/AGENT_CURSOR.md): a transparent, always
 * click-through window over every display that draws HER pointer while she
 * works. It listens to agent.cursor / agent.browser on the core bus and
 * forwards them to each display's page. It never reads the screen and never
 * moves the real cursor; it only draws.
 */
import { join } from "path";
import { app, BrowserWindow, screen } from "electron";
import { BusClient } from "@eigenwife/protocol/client";
import { configureCursorWindow, cursorPageQuery, cursorWindowOptions, DEFAULT_HUE, type DisplayLike } from "./config";

export const CURSOR_BUS_CLIENT = "eve-cursor";

export interface CursorLayerOpts {
  coreHost: string;
  capturable(): boolean;
  log(...a: unknown[]): void;
}

export interface CursorLayer {
  setCapturable(c: boolean): void;
  stop(): void;
}

export function startCursorLayer(opts: CursorLayerOpts): CursorLayer {
  const wins = new Map<number, BrowserWindow>();
  let hue = DEFAULT_HUE;
  let lastBrowser: unknown = null;
  const page = join(app.getAppPath(), "dist", "cursor", "index.html");
  const preload = join(app.getAppPath(), "dist", "cursor-preload.cjs");

  const send = (channel: string, payload: unknown) => {
    for (const w of wins.values()) if (!w.isDestroyed()) w.webContents.send(channel, payload);
  };

  function open(d: DisplayLike) {
    const w = new BrowserWindow(cursorWindowOptions(d, preload));
    configureCursorWindow(w, d, opts.capturable());
    w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    w.webContents.on("will-navigate", (e) => e.preventDefault());
    w.webContents.on("did-finish-load", () => {
      w.showInactive();
      if (lastBrowser) w.webContents.send("cursor:browser", lastBrowser);
    });
    w.on("closed", () => wins.delete(d.id));
    void w.loadFile(page, { query: cursorPageQuery(d, hue) }).catch((err) => opts.log(`cursor layer: ${String(err)}`));
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

  const bus = new BusClient({ url: `ws://${opts.coreHost}/bus`, client: CURSOR_BUS_CLIENT, role: "observer" }).connect();
  const setHue = (h: unknown) => {
    if (typeof h !== "number" || !Number.isFinite(h) || h === hue) return;
    hue = h;
    send("cursor:hue", h);
  };
  bus.on("bus.welcome", (e) => setHue(e.data.world.companion.persona?.palette.hue));
  bus.on("companion.born", (e) => setHue(e.data.persona.palette.hue));
  bus.on("agent.cursor", (e) => send("cursor:event", e.data));
  bus.on("agent.browser", (e) => {
    lastBrowser = e.data.status === "open" ? e.data : null;
    send("cursor:browser", e.data);
  });
  bus.onStatus((up) => {
    opts.log(`cursor layer ${up ? "connected to the core" : "lost the core, retrying"}`);
    // Core gone: nothing she's doing is real any more, fade everything out.
    if (!up) {
      send("cursor:reset", true);
      lastBrowser = null;
    }
  });
  opts.log(`cursor layer up on ${wins.size} display(s)`);

  return {
    setCapturable(c: boolean) {
      for (const w of wins.values()) if (!w.isDestroyed()) w.setContentProtection(!c);
    },
    stop() {
      bus.close();
      screen.removeListener("display-added", sync);
      screen.removeListener("display-removed", sync);
      screen.removeListener("display-metrics-changed", sync);
      for (const w of wins.values()) if (!w.isDestroyed()) w.destroy();
      wins.clear();
    },
  };
}
