/**
 * Draws Eve's cursor on one display's transparent layer (docs/AGENT_CURSOR.md).
 * All motion comes from CursorSim; this file is paint only.
 */
import type { ScreenRect } from "@eigenwife/protocol";
import { CursorSim, isCursorEvent, onDisplay, toLocal, type CursorFrame } from "./sim";

interface Bridge {
  on(channel: "event" | "browser" | "hue" | "display" | "reset" | "level", cb: (p: unknown) => void): () => void;
}

const bridge: Bridge = (window as unknown as { eveCursor?: Bridge }).eveCursor ?? { on: () => () => {} };
const q = new URLSearchParams(location.search);
let display: ScreenRect = { x: Number(q.get("x")) || 0, y: Number(q.get("y")) || 0, width: Number(q.get("w")) || innerWidth, height: Number(q.get("h")) || innerHeight };
let hue = Number(q.get("hue")) || 330;

const canvas = document.getElementById("c") as HTMLCanvasElement;
const g = canvas.getContext("2d")!;
const sim = new CursorSim();
// The layer's co-op presence: she's always on screen (idle never fades her out).
if (q.get("presence") === "1") sim.setAlwaysOn(true);
let raf = 0;
let slow: ReturnType<typeof setTimeout> | undefined;

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(innerWidth * dpr);
  canvas.height = Math.round(innerHeight * dpr);
  canvas.style.width = `${innerWidth}px`;
  canvas.style.height = `${innerHeight}px`;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
}
addEventListener("resize", () => {
  resize();
  wake();
});
resize();

const hsl = (h: number, s: number, l: number, a = 1) => `hsla(${((h % 360) + 360) % 360}, ${s}%, ${l}%, ${a})`;

// Her pointer, tip at (0, 0): a soft, rounded arrow, a little chubbier than the system one.
const POINTER = new Path2D("M1.2 1.4 L1.2 19.2 Q1.2 21 2.7 20 L7.1 15.9 Q7.7 15.4 8.5 15.4 L14.4 15.2 Q16.2 15.1 14.9 13.8 L3.2 1.2 Q1.2 -0.6 1.2 1.4 Z");

function drawPointer(f: CursorFrame, x: number, y: number) {
  g.save();
  g.translate(x, y);
  g.rotate(f.tilt * 0.6);
  g.scale(1.18 * f.scale, 1.18 * f.scale);
  g.globalAlpha = f.opacity;
  // Glow.
  g.shadowColor = hsl(hue, 95, 62, 0.55);
  g.shadowBlur = 14 + f.hover * 10;
  g.shadowOffsetY = 2;
  const grad = g.createLinearGradient(0, 0, 10, 20);
  grad.addColorStop(0, hsl(hue, 95, 76));
  grad.addColorStop(1, hsl(hue + 18, 88, 58));
  g.fillStyle = grad;
  g.fill(POINTER);
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  g.lineJoin = "round";
  g.lineWidth = 1.5;
  g.strokeStyle = "rgba(255,255,255,0.95)";
  g.stroke(POINTER);
  // A tiny highlight so it reads as a little object, not a flat arrow.
  g.globalAlpha = f.opacity * 0.55;
  g.fillStyle = "rgba(255,255,255,0.9)";
  g.beginPath();
  g.ellipse(4.2, 7, 1.1, 3.2, -0.35, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

function roundRect(x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

function drawTag(f: CursorFrame, x: number, y: number) {
  const name = "Eve";
  const label = f.label && f.label !== name ? f.label : "";
  g.save();
  g.globalAlpha = f.opacity;
  g.font = "700 12px ui-rounded, -apple-system, system-ui, sans-serif";
  const nameW = g.measureText(name).width;
  g.font = "500 11.5px ui-rounded, -apple-system, system-ui, sans-serif";
  let text = label;
  const maxW = 230;
  while (text && g.measureText(text).width > maxW) text = text.slice(0, -2);
  if (text !== label) text = `${text.trimEnd()}…`;
  const labelW = text ? g.measureText(text).width + 9 : 0;
  const w = 10 + nameW + labelW + 10;
  const h = 22;
  const tx = x + 15;
  const ty = y + 21;
  g.shadowColor = hsl(hue, 80, 40, 0.35);
  g.shadowBlur = 10;
  g.shadowOffsetY = 3;
  const grad = g.createLinearGradient(tx, ty, tx, ty + h);
  grad.addColorStop(0, hsl(hue, 92, 67));
  grad.addColorStop(1, hsl(hue + 16, 86, 58));
  g.fillStyle = grad;
  roundRect(tx, ty, w, h, 11);
  g.fill();
  g.shadowBlur = 0;
  g.shadowOffsetY = 0;
  g.strokeStyle = "rgba(255,255,255,0.55)";
  g.lineWidth = 1;
  g.stroke();
  g.fillStyle = "#fff";
  g.textBaseline = "middle";
  g.font = "700 12px ui-rounded, -apple-system, system-ui, sans-serif";
  g.fillText(name, tx + 10, ty + h / 2 + 0.5);
  if (text) {
    g.fillStyle = "rgba(255,255,255,0.55)";
    g.beginPath();
    g.arc(tx + 10 + nameW + 5, ty + h / 2, 1.4, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = "rgba(255,255,255,0.93)";
    g.font = "500 11.5px ui-rounded, -apple-system, system-ui, sans-serif";
    g.fillText(text, tx + 10 + nameW + 9, ty + h / 2 + 0.5);
  }
  // Typing caret at the end of the tag.
  if (f.caretOn) {
    g.fillStyle = "#fff";
    roundRect(tx + w - 7, ty + 5, 2, h - 10, 1);
    g.fill();
  }
  g.restore();
}

function drawScroll(f: CursorFrame, x: number, y: number) {
  if (!f.scroll) return;
  g.save();
  g.globalAlpha = f.opacity * 0.9;
  g.strokeStyle = hsl(hue, 90, 70);
  g.lineWidth = 2.2;
  g.lineCap = "round";
  g.lineJoin = "round";
  for (let i = 0; i < 2; i++) {
    const ph = (f.scroll.phase + i * 0.5) % 1;
    const oy = f.scroll.dir * (ph * 12);
    g.globalAlpha = f.opacity * (1 - ph) * 0.9;
    const cy = y - 10 + oy;
    g.beginPath();
    g.moveTo(x - 20, cy - 3 * f.scroll.dir);
    g.lineTo(x - 15, cy + 2 * f.scroll.dir);
    g.lineTo(x - 10, cy - 3 * f.scroll.dir);
    g.stroke();
  }
  g.restore();
}

function drawBrowser(b: NonNullable<CursorFrame["browser"]>) {
  const r = { ...toLocal(b.rect, display), width: b.rect.width, height: b.rect.height };
  g.save();
  g.globalAlpha = b.alpha;
  g.shadowColor = hsl(hue, 95, 62, 0.6);
  g.shadowBlur = 22;
  g.strokeStyle = hsl(hue, 92, 70, 0.9);
  g.lineWidth = 2.5;
  roundRect(r.x - 2, r.y - 2, r.width + 4, r.height + 4, 12);
  g.stroke();
  g.shadowBlur = 0;
  // "Eve's browser" badge on the bottom edge.
  const text = "Eve's browser";
  g.font = "700 11px ui-rounded, -apple-system, system-ui, sans-serif";
  const w = g.measureText(text).width + 26;
  const x = r.x + 14;
  const y = r.y + r.height - 11;
  const grad = g.createLinearGradient(x, y, x, y + 22);
  grad.addColorStop(0, hsl(hue, 92, 67));
  grad.addColorStop(1, hsl(hue + 16, 86, 58));
  g.fillStyle = grad;
  roundRect(x, y, w, 22, 11);
  g.fill();
  g.fillStyle = "#fff";
  g.beginPath();
  g.arc(x + 10, y + 11, 2.5, 0, Math.PI * 2);
  g.fill();
  g.textBaseline = "middle";
  g.fillText(text, x + 17, y + 11.5);
  g.restore();
}

function draw(now: number): "busy" | "calm" | "sleep" {
  const f = sim.frame(now);
  g.clearRect(0, 0, innerWidth, innerHeight);
  if (f.browser) drawBrowser(f.browser);
  const onHere = onDisplay({ x: f.x, y: f.y }, display);
  if (onHere) {
    const p = toLocal(f, display);
    // Trail: a faint comet tail while she glides.
    if (f.trail.length > 2) {
      g.save();
      g.lineCap = "round";
      for (let i = 1; i < f.trail.length; i++) {
        const a = toLocal(f.trail[i - 1]!, display);
        const b = toLocal(f.trail[i]!, display);
        g.strokeStyle = hsl(hue, 95, 70, f.trail[i]!.alpha * 0.6);
        g.lineWidth = 1 + 4 * (i / f.trail.length);
        g.beginPath();
        g.moveTo(a.x, a.y);
        g.lineTo(b.x, b.y);
        g.stroke();
      }
      g.restore();
    }
    for (const r of f.ripples) {
      const c = toLocal(r, display);
      g.save();
      g.strokeStyle = hsl(hue, 95, 68, r.alpha * 0.9);
      g.lineWidth = 2.5 * r.alpha + 0.5;
      g.beginPath();
      g.arc(c.x, c.y, r.r, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = hsl(hue, 95, 75, r.alpha * 0.18);
      g.fill();
      g.restore();
    }
    if (f.point > 0) {
      // Pointing: two soft rings pulsing out from the tip, "this, here".
      const t = performance.now() / 700;
      g.save();
      for (let i = 0; i < 2; i++) {
        const ph = (t + i * 0.5) % 1;
        g.strokeStyle = hsl(hue, 95, 70, (1 - ph) * 0.55 * f.opacity * f.point);
        g.lineWidth = 2;
        g.beginPath();
        g.arc(p.x, p.y, 6 + ph * 22, 0, Math.PI * 2);
        g.stroke();
      }
      g.restore();
    }
    if (f.hover > 0) {
      g.save();
      g.fillStyle = hsl(hue, 95, 70, 0.16 * f.hover * f.opacity);
      g.beginPath();
      g.arc(p.x, p.y, 10 + 10 * f.hover, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
    for (const k of f.particles) {
      const c = toLocal(k, display);
      g.save();
      g.fillStyle = hsl(hue + k.hueShift, 95, 72, k.alpha);
      roundRect(c.x - k.size / 2, c.y - k.size / 2, k.size, k.size, 1);
      g.fill();
      g.restore();
    }
    if (f.opacity > 0) {
      drawScroll(f, p.x, p.y);
      drawTag(f, p.x, p.y);
      drawPointer(f, p.x, p.y);
    }
  }
  if (!f.active) return "sleep";
  // Only breathing at rest: 20fps is plenty and keeps the GPU cool.
  const calm = !f.moving && !f.ripples.length && !f.particles.length && !f.scroll && !f.typing && f.hover === 0 && f.point === 0 && (!f.browser || f.browser.alpha >= 1);
  return calm ? "calm" : "busy";
}

function loop() {
  raf = 0;
  slow = undefined;
  const r = draw(performance.now());
  if (r === "busy") raf = requestAnimationFrame(loop);
  else if (r === "calm") slow = setTimeout(() => (raf = requestAnimationFrame(loop)), 50);
}

function wake() {
  if (slow) {
    clearTimeout(slow);
    slow = undefined;
  }
  if (!raf) raf = requestAnimationFrame(loop);
}

bridge.on("event", (p) => {
  if (!isCursorEvent(p)) return;
  sim.feed(p, performance.now());
  wake();
});
bridge.on("browser", (p) => {
  const b = p as { status?: "open" | "closed"; bounds?: ScreenRect };
  if (b?.status !== "open" && b?.status !== "closed") return;
  sim.feedBrowser({ status: b.status, bounds: b.bounds }, performance.now());
  wake();
});
bridge.on("hue", (h) => {
  if (typeof h === "number" && Number.isFinite(h)) hue = h;
  wake();
});
bridge.on("display", (d) => {
  const r = d as ScreenRect;
  if (r && Number.isFinite(r.x) && Number.isFinite(r.width)) display = { x: r.x, y: r.y, width: r.width, height: r.height };
  wake();
});
bridge.on("level", (lv) => {
  if (typeof lv === "number" && Number.isFinite(lv)) sim.setLevel(lv, performance.now());
  wake();
});
bridge.on("reset", () => {
  sim.reset(performance.now());
  wake();
});

// Dev: open dist/cursor/index.html?demo in a browser to see her move without a core.
if (q.has("demo")) {
  const pts = [
    [220, 180, "move", "Menu"],
    [220, 180, "click", "Menu"],
    [600, 420, "move", "search"],
    [600, 420, "type", '"spicy ramen"'],
    [420, 300, "move", "scrolling"],
    [420, 300, "scroll", "down"],
    [420, 300, "idle", ""],
  ] as const;
  let i = 0;
  const step = () => {
    const [x, y, action, label] = pts[i % pts.length]!;
    sim.feed({ x, y, action, label }, performance.now());
    wake();
    i++;
    setTimeout(step, action === "move" ? 750 : action === "idle" ? 3200 : 1300);
  };
  step();
}
