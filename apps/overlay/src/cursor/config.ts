/**
 * The cursor layer's window contract, pure so it's testable without Electron.
 *
 * One window per display, covering all of it, fully transparent, above normal
 * windows, on every Space. It NEVER takes the mouse: setIgnoreMouseEvents(true)
 * with no forwarding, not focusable, and nothing in the layer ever turns that off.
 */

export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
}

export function cursorWindowOptions(d: DisplayLike, preload: string) {
  return {
    x: d.bounds.x,
    y: d.bounds.y,
    width: d.bounds.width,
    height: d.bounds.height,
    transparent: true,
    backgroundColor: "#00000000",
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    enableLargerThanScreen: true,
    show: false,
    title: "Eve's cursor",
    roundedCorners: false,
    // NSPanel: never activates, never steals focus.
    ...(process.platform === "darwin" ? { type: "panel" as const } : { type: "toolbar" as const }),
    webPreferences: {
      preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      spellcheck: false,
    },
  };
}

/** The subset of BrowserWindow the layer configures. */
export interface CursorWindowLike {
  setIgnoreMouseEvents(ignore: boolean, opts?: { forward?: boolean }): void;
  setAlwaysOnTop(flag: boolean, level?: string, relativeLevel?: number): void;
  setVisibleOnAllWorkspaces(visible: boolean, opts?: { visibleOnFullScreen?: boolean }): void;
  setContentProtection(on: boolean): void;
  setFocusable(on: boolean): void;
  setBounds(b: { x: number; y: number; width: number; height: number }): void;
}

/**
 * Click-through forever, above everything normal (one notch above Eve's own
 * panel so her pointer can pass over her), every Space, and hidden from
 * screen capture exactly when the overlay setting says so.
 */
export function configureCursorWindow(win: CursorWindowLike, d: DisplayLike, capturable: boolean): void {
  win.setIgnoreMouseEvents(true);
  win.setFocusable(false);
  win.setAlwaysOnTop(true, "screen-saver", 2);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setContentProtection(!capturable);
  // Cover the menu bar and the Dock too (she clicks Dock icons).
  win.setBounds({ ...d.bounds });
}

/** Where the renderer page learns which part of the screen it covers. */
export function cursorPageQuery(d: DisplayLike, hue: number): Record<string, string> {
  return { x: String(d.bounds.x), y: String(d.bounds.y), w: String(d.bounds.width), h: String(d.bounds.height), hue: String(Math.round(hue)) };
}

export const DEFAULT_HUE = 330;
