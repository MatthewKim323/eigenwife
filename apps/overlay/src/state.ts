/**
 * Window placement + persisted overlay settings (~/.eve/overlay.json).
 * Pure except loadState / saveState, which take their fs in.
 */

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SizeName = "small" | "medium" | "large";
export type Corner = "bottom-right" | "bottom-left" | "top-right" | "top-left";

export const SIZES: Record<SizeName, { width: number; height: number }> = {
  small: { width: 330, height: 440 },
  medium: { width: 420, height: 560 },
  large: { width: 540, height: 720 },
};

export const MARGIN = 16;

export interface OverlayState {
  bounds: Rect | null;
  size: SizeName;
  visible: boolean;
  muted: boolean;
  attentionPaused: boolean;
  openAtLogin: boolean;
  /** false = setContentProtection(true): she doesn't show up in screenshots / screen shares. */
  capturable: boolean;
}

export const DEFAULT_STATE: OverlayState = {
  bounds: null,
  size: "medium",
  visible: true,
  muted: false,
  attentionPaused: false,
  openAtLogin: false,
  capturable: false,
};

const isNum = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);

function parseRect(r: unknown): Rect | null {
  if (!r || typeof r !== "object") return null;
  const o = r as Record<string, unknown>;
  if (!isNum(o.x) || !isNum(o.y) || !isNum(o.width) || !isNum(o.height)) return null;
  if (o.width < 120 || o.height < 160 || o.width > 4000 || o.height > 4000) return null;
  return { x: Math.round(o.x), y: Math.round(o.y), width: Math.round(o.width), height: Math.round(o.height) };
}

/** Tolerant: anything missing or malformed falls back to the default. */
export function parseState(raw: string | null | undefined): OverlayState {
  let o: Record<string, unknown> = {};
  try {
    const j = raw ? JSON.parse(raw) : {};
    if (j && typeof j === "object" && !Array.isArray(j)) o = j;
  } catch {}
  const bool = (k: keyof OverlayState) => (typeof o[k] === "boolean" ? (o[k] as boolean) : (DEFAULT_STATE[k] as boolean));
  return {
    bounds: parseRect(o.bounds),
    size: typeof o.size === "string" && o.size in SIZES ? (o.size as SizeName) : DEFAULT_STATE.size,
    visible: bool("visible"),
    muted: bool("muted"),
    attentionPaused: bool("attentionPaused"),
    openAtLogin: bool("openAtLogin"),
    capturable: bool("capturable"),
  };
}

export function serializeState(s: OverlayState): string {
  return JSON.stringify(s, null, 2) + "\n";
}

/** A rect of the given size tucked into a corner of a work area. */
export function cornerBounds(work: Rect, size: { width: number; height: number }, corner: Corner = "bottom-right"): Rect {
  const width = Math.min(size.width, work.width - MARGIN * 2);
  const height = Math.min(size.height, work.height - MARGIN * 2);
  const right = corner.endsWith("right");
  const bottom = corner.startsWith("bottom");
  return {
    x: right ? work.x + work.width - width - MARGIN : work.x + MARGIN,
    y: bottom ? work.y + work.height - height : work.y + MARGIN,
    width,
    height,
  };
}

function overlap(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where the window opens: the saved bounds if they still land on a display
 * (clamped fully inside it), else the bottom-right of the primary display.
 * Handles unplugged monitors and resolution changes.
 */
export function resolveBounds(saved: Rect | null, size: SizeName, works: Rect[], primary: Rect): Rect {
  if (!saved) return cornerBounds(primary, SIZES[size]);
  let best: Rect | null = null;
  let bestArea = 0;
  for (const w of works) {
    const a = overlap(saved, w);
    if (a > bestArea) {
      bestArea = a;
      best = w;
    }
  }
  // Less than a sliver on any screen: she's lost, bring her home.
  if (!best || bestArea < Math.min(saved.width * saved.height * 0.15, 80 * 80)) return cornerBounds(primary, { width: saved.width, height: saved.height });
  return clampInto(saved, best);
}

export function clampInto(r: Rect, work: Rect): Rect {
  const width = Math.min(r.width, work.width);
  const height = Math.min(r.height, work.height);
  const x = Math.min(Math.max(r.x, work.x), work.x + work.width - width);
  const y = Math.min(Math.max(r.y, work.y), work.y + work.height - height);
  return { x, y, width, height };
}

/** Resize around the bottom-right anchor (she stands on the same spot) and keep it on screen. */
export function resizeAnchored(r: Rect, size: { width: number; height: number }, work: Rect): Rect {
  return clampInto({ x: r.x + r.width - size.width, y: r.y + r.height - size.height, width: size.width, height: size.height }, work);
}

export interface FsLike {
  readFileSync(p: string, enc: "utf8"): string;
  writeFileSync(p: string, data: string): void;
  mkdirSync(p: string, o: { recursive: true }): unknown;
  existsSync(p: string): boolean;
}

export function loadState(path: string, fs: FsLike): OverlayState {
  try {
    return parseState(fs.existsSync(path) ? fs.readFileSync(path, "utf8") : null);
  } catch {
    return { ...DEFAULT_STATE };
  }
}

export function saveState(path: string, s: OverlayState, fs: FsLike) {
  try {
    fs.mkdirSync(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    fs.writeFileSync(path, serializeState(s));
  } catch {}
}

/** The shell URL the window loads. */
export function overlayUrl(env: Record<string, string | undefined>): string {
  if (env.EVE_OVERLAY_URL) return env.EVE_OVERLAY_URL;
  const shell = env.EVE_SHELL_URL || "http://127.0.0.1:5173";
  const q = new URLSearchParams({ mode: "overlay" });
  const core = env.EVE_CORE || (env.EIGEN_PORT ? `127.0.0.1:${env.EIGEN_PORT}` : "");
  if (core) q.set("core", core);
  return `${shell.replace(/\/$/, "")}/?${q}`;
}

/** An attention.pause envelope for POST /emit (plain JSON, the bus's wire format). */
export function attentionEnvelope(paused: boolean, now = Date.now()) {
  return {
    type: "attention.pause",
    ts: now,
    source: "overlay",
    id: `ov_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    data: { paused, by: "overlay" },
  };
}
