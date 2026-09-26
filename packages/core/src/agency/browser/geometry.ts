import type { CursorPt, ScreenRect } from "@eigenwife/protocol";

/**
 * Page -> screen mapping for Eve's browser (docs/AGENT_CURSOR.md). Pure.
 *
 * Everything the page can tell us about itself, measured with one evaluate():
 * window.screenX/Y is the window's outer top-left in screen points,
 * outerWidth/Height are in points, innerWidth/Height are in CSS px of the
 * current zoom. The browser chrome (tab strip + toolbar) is what's left over:
 * outerHeight - innerHeight * zoom. Page zoom is devicePixelRatio over the
 * ratio at launch (fresh profile = 100%), so a zoomed page still maps right.
 */
export interface PageMetrics {
  screenX: number;
  screenY: number;
  outerWidth: number;
  outerHeight: number;
  innerWidth: number;
  innerHeight: number;
  devicePixelRatio: number;
}

export interface ChromeOffset {
  left: number;
  top: number;
}

/** Page zoom: current devicePixelRatio over the display's backing scale (dpr at 100%). */
export function pageZoom(m: PageMetrics, baseDpr: number): number {
  const z = baseDpr > 0 ? m.devicePixelRatio / baseDpr : 1;
  return Number.isFinite(z) && z > 0.2 && z < 6 ? z : 1;
}

/**
 * Where the page's viewport starts inside the window, in points. Side borders
 * are split evenly (0 on macOS); the bottom border is assumed equal to a side
 * border, the rest of the height difference is the top chrome.
 */
export function chromeOffset(m: PageMetrics, zoom = 1): ChromeOffset {
  const left = Math.max(0, (m.outerWidth - m.innerWidth * zoom) / 2);
  const top = Math.max(0, m.outerHeight - m.innerHeight * zoom - left);
  return { left, top };
}

/** A point in viewport CSS px (getBoundingClientRect / Playwright boundingBox) -> screen points. */
export function pageToScreen(m: PageMetrics, p: CursorPt, baseDpr = m.devicePixelRatio): CursorPt {
  const zoom = pageZoom(m, baseDpr);
  const off = chromeOffset(m, zoom);
  return { x: m.screenX + off.left + p.x * zoom, y: m.screenY + off.top + p.y * zoom };
}

/** A pixel in a screenshot of her page (device px) -> screen points. */
export function shotToScreen(m: PageMetrics, px: CursorPt, baseDpr = m.devicePixelRatio): CursorPt {
  const dpr = m.devicePixelRatio || 1;
  return pageToScreen(m, { x: px.x / dpr, y: px.y / dpr }, baseDpr);
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The center of an element box, nudged a touch up-left like a person aiming at a label. */
export function aimPoint(b: Box): CursorPt {
  return { x: b.x + b.width * 0.46, y: b.y + b.height * 0.5 };
}

/** Is the box at least partly inside the viewport (so the cursor can go there)? */
export function inViewport(m: PageMetrics, b: Box): boolean {
  return b.x + b.width > 0 && b.y + b.height > 0 && b.x < m.innerWidth && b.y < m.innerHeight;
}

/** Roughly where the address bar is: in the toolbar row, just right of the nav buttons. */
export function addressBarPoint(m: PageMetrics, baseDpr = m.devicePixelRatio): CursorPt {
  const off = chromeOffset(m, pageZoom(m, baseDpr));
  const y = off.top > 56 ? off.top - 22 : off.top / 2;
  return { x: m.screenX + off.left + Math.min(m.outerWidth * 0.36, 380), y: m.screenY + y };
}

/** Middle of the visible page, in screen points (scrolling, reading). */
export function viewportCenter(m: PageMetrics, baseDpr = m.devicePixelRatio): CursorPt {
  return pageToScreen(m, { x: m.innerWidth * 0.5, y: m.innerHeight * 0.55 }, baseDpr);
}

/** Her window: the left half of the display's usable area. */
export function leftHalf(avail: ScreenRect): ScreenRect {
  const width = Math.max(640, Math.floor(avail.width / 2));
  return { x: avail.x, y: avail.y, width: Math.min(width, avail.width), height: avail.height };
}
