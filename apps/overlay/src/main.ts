/**
 * Eve on the real desktop. A transparent, frameless, always-on-top panel that
 * never steals focus and ignores the mouse everywhere except her own pixels
 * (the page hit-tests and tells us). Loads the shell at ?mode=overlay.
 *
 *   bun run dev        core :7777 + shell :5173
 *   bun run overlay    this
 *
 * See docs/OVERLAY.md.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import {
  app,
  BrowserWindow,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  screen,
  session,
  systemPreferences,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { startCursorLayer, type CursorLayer } from "./cursor/layer";
import { heartBitmap } from "./icon";
import {
  attentionEnvelope,
  parseScreenStatus,
  screenPauseEnvelope,
  cornerBounds,
  loadState,
  overlayUrl,
  resizeAnchored,
  resolveBounds,
  saveState,
  SIZES,
  type Corner,
  type OverlayState,
  type SizeName,
} from "./state";

// Keep Eve painting through macOS Space swipes and Mission Control: Chromium
// otherwise treats the overlay as occluded mid-swipe, stops rendering her
// canvas, and she "pops back" when the swipe ends.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-features", "CalculateNativeWinOcclusion,MacWebContentsOcclusion");

const EVE_HOME = process.env.EVE_HOME || join(homedir(), ".eve");
const STATE_PATH = join(EVE_HOME, "overlay.json");
const URL = overlayUrl(process.env);
const CORE_HTTP = `http://${new globalThis.URL(URL).searchParams.get("core") || "127.0.0.1:7777"}`;
const CORE_HOST = new globalThis.URL(CORE_HTTP).host;
const fsio = { readFileSync, writeFileSync, mkdirSync, existsSync };

const log = (...a: unknown[]) => console.log(`[overlay ${new Date().toLocaleTimeString()}]`, ...a);

let state: OverlayState = loadState(STATE_PATH, fsio);
// For recording a demo: EVE_OVERLAY_CAPTURABLE=1 lets screenshots see her this run.
const capturableEnv = process.env.EVE_OVERLAY_CAPTURABLE === "1";
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
// Eve's own cursor over every display (docs/AGENT_CURSOR.md). EVE_CURSOR_LAYER=0 turns it off.
let cursorLayer: CursorLayer | null = null;
let interactive = false;
let drag: { timer: ReturnType<typeof setInterval>; dx: number; dy: number; until: number } | null = null;
let loadRetry: ReturnType<typeof setTimeout> | undefined;
let shellUp = false;

function persist(patch: Partial<OverlayState> = {}) {
  state = { ...state, ...patch };
  if (win && !win.isDestroyed()) state.bounds = win.getBounds();
  saveState(STATE_PATH, state, fsio);
}

function workAreas() {
  return screen.getAllDisplays().map((d) => d.workArea);
}

function send(channel: "mute" | "attention" | "visible", v: boolean) {
  if (win && !win.isDestroyed()) win.webContents.send(`overlay:${channel}`, v);
}

// ---------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------

function createWindow() {
  const bounds = resolveBounds(state.bounds, state.size, workAreas(), screen.getPrimaryDisplay().workArea);
  win = new BrowserWindow({
    ...bounds,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    title: "Eve",
    roundedCorners: false,
    // NSPanel (non-activating): clicking her never pulls focus from your app.
    ...(process.platform === "darwin" ? { type: "panel" } : { type: "toolbar" }),
    webPreferences: {
      // app path = apps/overlay (bun inlines __dirname at build time, so not that)
      preload: join(app.getAppPath(), "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Her voice plays without a click; there is nothing to click.
      autoplayPolicy: "no-user-gesture-required",
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  // skipTransformProcessType: don't flip the app's process type on every call (dock/space flicker).
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  // Not a "window" macOS should shuffle around in Mission Control / Space swipes.
  if (process.platform === "darwin") win.setHiddenInMissionControl?.(true);
  // Space swipes briefly blur/occlude her; re-assert the floor so she never drops behind.
  win.on("blur", () => win?.setAlwaysOnTop(true, "screen-saver"));
  win.setContentProtection(!(state.capturable || capturableEnv));
  win.setIgnoreMouseEvents(true, { forward: true });
  interactive = false;

  const wc = win.webContents;
  wc.on("did-finish-load", () => {
    shellUp = true;
    log(`loaded ${URL}`);
    if (state.visible) win?.showInactive();
    refreshTray();
  });
  wc.on("did-fail-load", (_e, code, desc, url, isMain) => {
    if (!isMain) return;
    shellUp = false;
    refreshTray();
    log(`shell not reachable (${desc || code}) at ${url}; retrying in 2s. is \`bun run dev\` up?`);
    clearTimeout(loadRetry);
    loadRetry = setTimeout(() => win && !win.isDestroyed() && void win.loadURL(URL).catch(() => {}), 2000);
  });
  wc.on("render-process-gone", (_e, d) => {
    log(`renderer gone (${d.reason}); reloading`);
    setTimeout(() => win && !win.isDestroyed() && void win.loadURL(URL).catch(() => {}), 1000);
  });
  wc.on("console-message", (e) => {
    const lvl = (e as any).level;
    if (lvl === "error" || lvl === "warning" || lvl === 2 || lvl === 3) log(`page ${lvl}: ${(e as any).message}`);
  });
  // Links never open inside her window.
  wc.setWindowOpenHandler(() => ({ action: "deny" }));
  wc.on("will-navigate", (e, u) => {
    if (!u.startsWith(new globalThis.URL(URL).origin)) e.preventDefault();
  });

  win.on("closed", () => {
    win = null;
  });
  void win.loadURL(URL).catch(() => {});
}

function setVisible(v: boolean) {
  if (!win) return;
  if (v) win.showInactive();
  else {
    stopDrag();
    win.hide();
  }
  send("visible", v);
  persist({ visible: v });
  // Her cursor hides and comes back with her.
  cursorLayer?.refresh();
  refreshTray();
}

function setCursorVisible(on: boolean) {
  persist({ cursorVisible: on });
  cursorLayer?.refresh();
  log(`eve's cursor ${on ? "shown" : "hidden"}`);
  refreshTray();
}

// What her avatar is looking at (glance / hold / gaze), for the cursor's idle wander.
let lookTarget: { p: { x: number; y: number }; at: number } | null = null;

/** Everything the cursor layer needs to know about her body and his settings. */
function cursorLayerOpts() {
  return {
    coreHost: CORE_HOST,
    capturable: () => state.capturable || capturableEnv,
    log,
    avatar: () => (win && !win.isDestroyed() && win.isVisible() ? win.getBounds() : null),
    // Cursor-only (no avatar window): shown follows the tray setting alone.
    shown: () => state.cursorVisible && (CURSOR_ONLY || (!!win && !win.isDestroyed() && win.isVisible())),
    look: () => lookTarget,
  };
}

function toggleVisible() {
  setVisible(!(win?.isVisible() ?? false));
}

function setMuted(m: boolean) {
  send("mute", m);
  persist({ muted: m });
  log(`mic ${m ? "muted" : "live"}`);
  refreshTray();
}

async function setAttentionPaused(p: boolean) {
  persist({ attentionPaused: p });
  send("attention", p);
  refreshTray();
  try {
    const r = await fetch(`${CORE_HTTP}/emit`, { method: "POST", body: JSON.stringify(attentionEnvelope(p)), signal: AbortSignal.timeout(2000) });
    log(`attention ${p ? "paused" : "resumed"} (core ${r.status})`);
  } catch {
    log(`attention ${p ? "paused" : "resumed"} locally; core offline`);
  }
}

// ---------------------------------------------------------------------------
// screen awareness (docs/SCREEN.md): the core owns the pause (~/.eve/screen.json)
// ---------------------------------------------------------------------------

let screenSense: { enabled: boolean; paused: boolean } | null = null;

async function refreshScreen() {
  let next: typeof screenSense = null;
  try {
    const r = await fetch(`${CORE_HTTP}/api/screen/status`, { signal: AbortSignal.timeout(1500) });
    next = r.ok ? parseScreenStatus(await r.json()) : null;
  } catch {}
  if (JSON.stringify(next) !== JSON.stringify(screenSense)) {
    screenSense = next;
    refreshTray();
  }
}

async function setScreenPaused(p: boolean) {
  if (screenSense) screenSense = { ...screenSense, paused: p };
  refreshTray();
  try {
    const r = await fetch(`${CORE_HTTP}/emit`, { method: "POST", body: JSON.stringify(screenPauseEnvelope(p)), signal: AbortSignal.timeout(2000) });
    log(`screen ${p ? "paused" : "resumed"} (core ${r.status})`);
  } catch {
    log("screen pause: core offline");
  }
  await refreshScreen();
}

// ---------------------------------------------------------------------------
// outfit (docs/WARDROBE.md): the core owns what she wears; the tray mirrors it
// ---------------------------------------------------------------------------

interface OutfitItem {
  id: string;
  label: string;
  on: boolean;
}
let outfit: OutfitItem[] = [];

async function refreshOutfit() {
  try {
    const r = await fetch(`${CORE_HTTP}/api/wardrobe`, { signal: AbortSignal.timeout(1500) });
    const j = (await r.json()) as { catalog?: OutfitItem[] };
    const next = (j.catalog ?? []).map((c) => ({ id: c.id, label: c.label, on: !!c.on }));
    if (JSON.stringify(next) !== JSON.stringify(outfit)) {
      outfit = next;
      refreshTray();
    }
  } catch {
    if (outfit.length) {
      outfit = [];
      refreshTray();
    }
  }
}

async function toggleOutfit(id: string, on: boolean) {
  try {
    await fetch(`${CORE_HTTP}/api/wardrobe`, { method: "POST", body: JSON.stringify(on ? { add: [id] } : { remove: id === "all" ? "all" : [id] }), signal: AbortSignal.timeout(2000) });
    log(`outfit ${on ? "+" : "-"}${id}`);
  } catch {
    log("outfit: core offline");
  }
  await refreshOutfit();
}

// ---------------------------------------------------------------------------
// global cursor: she looks where the mouse is, anywhere on screen (look.ts)
// ---------------------------------------------------------------------------

let lastCursor = { x: NaN, y: NaN };
function pollCursor() {
  if (!win || win.isDestroyed() || !win.isVisible() || !shellUp) return;
  const p = screen.getCursorScreenPoint();
  if (p.x === lastCursor.x && p.y === lastCursor.y) return;
  lastCursor = p;
  win.webContents.send("overlay:cursor", { x: p.x, y: p.y });
}

function moveTo(corner: Corner) {
  if (!win) return;
  const b = win.getBounds();
  const work = screen.getDisplayMatching(b).workArea;
  win.setBounds(cornerBounds(work, { width: b.width, height: b.height }, corner));
  persist();
}

function setSize(size: SizeName) {
  if (!win) return;
  const b = win.getBounds();
  win.setBounds(resizeAnchored(b, SIZES[size], screen.getDisplayMatching(b).workArea));
  persist({ size });
  refreshTray();
}

function setCapturable(c: boolean) {
  win?.setContentProtection(!c);
  cursorLayer?.setCapturable(c || capturableEnv);
  persist({ capturable: c });
  refreshTray();
}

function setOpenAtLogin(on: boolean) {
  // Dev builds: relaunch this same Electron with this app path.
  app.setLoginItemSettings({ openAtLogin: on, path: process.execPath, args: app.isPackaged ? [] : [app.getAppPath()] });
  persist({ openAtLogin: on });
  refreshTray();
}

// ---------------------------------------------------------------------------
// click-through + drag (the page decides, we obey)
// ---------------------------------------------------------------------------

function stopDrag() {
  if (!drag) return;
  clearInterval(drag.timer);
  drag = null;
  if (win) {
    const b = win.getBounds();
    const work = screen.getDisplayMatching(b).workArea;
    const within = resolveBounds(b, state.size, [work], work);
    if (within.x !== b.x || within.y !== b.y) win.setBounds(within);
  }
  persist();
}

ipcMain.on("overlay:interactive", (e, on: boolean) => {
  if (!win || e.sender !== win.webContents) return;
  on = !!on;
  if (on === interactive) return;
  interactive = on;
  win.setIgnoreMouseEvents(!on, { forward: true });
  log(`click-through ${on ? "OFF (cursor on eve)" : "ON"}`);
});

ipcMain.on("overlay:drag-start", (e) => {
  if (!win || e.sender !== win.webContents || drag) return;
  const c = screen.getCursorScreenPoint();
  const [wx, wy] = win.getPosition() as [number, number];
  const d = { dx: c.x - wx, dy: c.y - wy, until: Date.now() + 60_000, timer: undefined as any };
  // Follow the real cursor: no lost events when the window moves under it.
  d.timer = setInterval(() => {
    if (!win || Date.now() > d.until) return stopDrag();
    const p = screen.getCursorScreenPoint();
    win.setPosition(Math.round(p.x - d.dx), Math.round(p.y - d.dy), false);
  }, 8);
  drag = d;
});

ipcMain.on("overlay:drag-end", (e) => {
  if (win && e.sender === win.webContents) stopDrag();
});

ipcMain.on("overlay:log", (_e, msg: string) => log(`page: ${msg}`));

ipcMain.on("overlay:look", (e, p: { x: number; y: number } | null) => {
  if (!win || e.sender !== win.webContents) return;
  lookTarget = p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { p: { x: p.x, y: p.y }, at: Date.now() } : null;
});

ipcMain.on("overlay:ready", (e) => {
  if (!win || e.sender !== win.webContents) return;
  send("mute", state.muted);
  send("attention", state.attentionPaused);
  send("visible", win.isVisible());
});

// ---------------------------------------------------------------------------
// tray + hotkeys
// ---------------------------------------------------------------------------

function trayIcon(dim: boolean) {
  const px = 36;
  const img = nativeImage.createFromBitmap(Buffer.from(heartBitmap(px, dim)), { width: px, height: px, scaleFactor: 2 });
  img.setTemplateImage(true);
  return img;
}

function refreshTray() {
  if (!tray) return;
  const visible = win?.isVisible() ?? false;
  const corner = (c: Corner, label: string): MenuItemConstructorOptions => ({ label, click: () => moveTo(c) });
  const size = (s: SizeName, label: string): MenuItemConstructorOptions => ({ label, type: "radio", checked: state.size === s, click: () => setSize(s) });
  const template: MenuItemConstructorOptions[] = [
    { label: shellUp ? "Eve is here" : "Waiting for the shell (bun run dev)", enabled: false },
    { type: "separator" },
    { label: visible ? "Hide Eve" : "Show Eve", accelerator: "CommandOrControl+Shift+E", click: toggleVisible },
    { label: "Mute mic", type: "checkbox", checked: state.muted, accelerator: "CommandOrControl+Shift+M", click: (i) => setMuted(i.checked) },
    { label: "Pause attention", type: "checkbox", checked: state.attentionPaused, click: (i) => void setAttentionPaused(i.checked) },
    {
      label: screenSense?.enabled === false ? "Pause screen (off: EVE_SCREEN=0)" : "Pause screen",
      type: "checkbox",
      checked: !!screenSense?.paused,
      enabled: !!screenSense?.enabled,
      accelerator: "CommandOrControl+Shift+P",
      click: (i) => void setScreenPaused(i.checked),
    },
    {
      label: "Outfit",
      enabled: outfit.length > 0,
      submenu: outfit.length
        ? [
            ...outfit.map((o): MenuItemConstructorOptions => ({ label: o.label, type: "checkbox", checked: o.on, click: (i) => void toggleOutfit(o.id, i.checked) })),
            { type: "separator" },
            { label: "Back to normal", enabled: outfit.some((o) => o.on), click: () => void toggleOutfit("all", false) },
          ]
        : [{ label: "core offline", enabled: false }],
    },
    { type: "separator" },
    {
      label: "Move to corner",
      submenu: [corner("bottom-right", "Bottom right"), corner("bottom-left", "Bottom left"), corner("top-right", "Top right"), corner("top-left", "Top left")],
    },
    { label: "Size", submenu: [size("small", "Small"), size("medium", "Medium"), size("large", "Large")] },
    { type: "separator" },
    { label: "Show Eve's cursor", type: "checkbox", checked: state.cursorVisible, enabled: !!cursorLayer, click: (i) => setCursorVisible(i.checked) },
    {
      label: "Hide from screen capture",
      type: "checkbox",
      checked: !(state.capturable || capturableEnv),
      enabled: !capturableEnv,
      click: (i) => setCapturable(!i.checked),
    },
    { label: "Open at login", type: "checkbox", checked: state.openAtLogin, click: (i) => setOpenAtLogin(i.checked) },
    { label: "Reload", click: () => win?.webContents.reloadIgnoringCache() },
    { type: "separator" },
    { label: "Quit Eve", accelerator: "CommandOrControl+Q", click: () => app.quit() },
  ];
  tray.setContextMenu(Menu.buildFromTemplate(template));
  tray.setImage(trayIcon(!visible || !shellUp));
  tray.setToolTip(visible ? "Eve" : "Eve (hidden)");
}

function registerHotkeys() {
  const keys: [string, () => void][] = [
    ["CommandOrControl+Shift+E", toggleVisible],
    ["CommandOrControl+Shift+M", () => setMuted(!state.muted)],
    // Screen awareness pause works even before the tray has heard from the core.
    ["CommandOrControl+Shift+P", () => void setScreenPaused(!screenSense?.paused)],
  ];
  for (const [k, fn] of keys) if (!globalShortcut.register(k, fn)) log(`hotkey ${k} is taken by another app`);
}

// ---------------------------------------------------------------------------
// boot
// ---------------------------------------------------------------------------

// Dev: a second overlay beside the one in use gets its own profile (and single-instance lock).
const INSTANCE = (process.env.EVE_OVERLAY_INSTANCE ?? "").replace(/[^\w-]/g, "");
if (INSTANCE) app.setPath("userData", join(app.getPath("userData"), `instance-${INSTANCE}`));
// Only Eve's cursor layer: no avatar window, tray, hotkeys or mic (demos, a second core).
const CURSOR_ONLY = process.env.EVE_OVERLAY_CURSOR_ONLY === "1";

if (!app.requestSingleInstanceLock()) {
  console.log("[overlay] already running: toggling the existing Eve");
  app.quit();
} else {
  app.on("second-instance", () => toggleVisible());

  app.whenReady().then(async () => {
    // A companion, not an app: no dock icon, no app switcher entry.
    if (process.platform === "darwin") app.dock?.hide();
    if (CURSOR_ONLY) {
      cursorLayer = startCursorLayer(cursorLayerOpts());
      log(`cursor layer only (core ${CORE_HOST}${capturableEnv ? ", capturable for recording" : ""})`);
      return;
    }

    // Mic: allow media for our page only; everything else is denied.
    const origin = new globalThis.URL(URL).origin;
    const ours = (u: string | undefined) => !!u && u.startsWith(origin);
    session.defaultSession.setPermissionRequestHandler((wc, permission, cb, details) => {
      const ok = ours(details.requestingUrl ?? wc.getURL()) && (permission === "media" || permission === "speaker-selection");
      if (!ok) log(`denied permission ${permission}`);
      cb(ok);
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ours(requestingOrigin) && (permission === "media" || permission === "speaker-selection"));
    if (process.platform === "darwin") {
      const s = systemPreferences.getMediaAccessStatus("microphone");
      if (s !== "granted") {
        const ok = await systemPreferences.askForMediaAccess("microphone").catch(() => false);
        log(`microphone access: ${ok ? "granted" : `not granted (${s}); System Settings > Privacy & Security > Microphone`}`);
      }
    }

    tray = new Tray(trayIcon(true));
    tray.setToolTip("Eve");
    // IPC is registered at module load, before the first loadURL.
    createWindow();
    refreshTray();
    if (process.env.EVE_CURSOR_LAYER !== "0") cursorLayer = startCursorLayer(cursorLayerOpts());
    refreshTray();
    registerHotkeys();
    // The tray's Outfit submenu mirrors the core (spoken changes show up here too).
    void refreshOutfit();
    setInterval(() => void refreshOutfit(), 4000);
    // The tray's "Pause screen" mirrors the core too.
    void refreshScreen();
    setInterval(() => void refreshScreen(), 4000);
    // ~30Hz, only while she's visible, only when it moved.
    setInterval(pollCursor, 33);

    const reclamp = () => {
      if (!win) return;
      const b = resolveBounds(win.getBounds(), state.size, workAreas(), screen.getPrimaryDisplay().workArea);
      win.setBounds(b);
      persist();
    };
    screen.on("display-removed", reclamp);
    screen.on("display-metrics-changed", reclamp);
    log(`up: ${URL} (state ${STATE_PATH}${capturableEnv ? ", capturable for recording" : ""})`);
  });

  app.on("will-quit", () => {
    globalShortcut.unregisterAll();
    cursorLayer?.stop();
    stopDrag();
  });
  // Closing the window isn't quitting: she lives in the tray.
  app.on("window-all-closed", () => {});
}
