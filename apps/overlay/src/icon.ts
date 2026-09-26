/**
 * The menu bar glyph, drawn in code so there's no binary asset: a small heart
 * as a BGRA bitmap (black + alpha, used as a macOS template image so it
 * follows light / dark menu bars). Anti-aliased by 4x4 supersampling.
 */
export function heartBitmap(size: number, dim = false): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const ss = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let hits = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          // Map into heart space: x in [-1.3, 1.3], y in [-1.2, 1.4] (y up).
          const x = (((px + (sx + 0.5) / ss) / size) * 2 - 1) * 1.3;
          const y = -((((py + (sy + 0.5) / ss) / size) * 2 - 1) * 1.3) + 0.1;
          const a = x * x + y * y - 1;
          if (a * a * a - x * x * y * y * y <= 0) hits++;
        }
      }
      const i = (py * size + px) * 4;
      out[i + 3] = Math.round((hits / (ss * ss)) * (dim ? 110 : 255));
    }
  }
  return out;
}
