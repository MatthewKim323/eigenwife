/** One variable drives the palette (styles/tokens.css). Animate it and the whole UI changes mood. */

let raf = 0;

export function getHue(): number {
  const v = getComputedStyle(document.documentElement).getPropertyValue("--hue");
  return Number.parseFloat(v) || 262;
}

export function setHue(h: number) {
  cancelAnimationFrame(raf);
  document.documentElement.style.setProperty("--hue", String(Math.round(h * 10) / 10));
}

/** Shortest path around the wheel. */
export function hueDelta(from: number, to: number): number {
  return ((((to - from) % 360) + 540) % 360) - 180;
}

export function animateHue(to: number, ms = 2400): Promise<void> {
  cancelAnimationFrame(raf);
  const from = getHue();
  const d = hueDelta(from, to);
  const t0 = performance.now();
  return new Promise((resolve) => {
    const step = (t: number) => {
      const p = Math.min(1, (t - t0) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      document.documentElement.style.setProperty("--hue", ((from + d * e + 360) % 360).toFixed(1));
      if (p < 1) raf = requestAnimationFrame(step);
      else resolve();
    };
    raf = requestAnimationFrame(step);
  });
}
