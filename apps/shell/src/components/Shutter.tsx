import { useEffect, useRef } from "react";

/**
 * Full-screen shutter: panels sweep up with cubic-bezier(0.87, 0.05, 0.02, 0.97),
 * hold while the view swaps underneath (at duration / 3), then sweep away.
 *
 *   shutter(() => go("dating"))
 */

type Req = { onCovered: () => void; duration: number; resolve: () => void };
let request: ((r: Req) => void) | null = null;
let busy = false;

export function shutter(onCovered: () => void, duration = 1400): Promise<void> {
  return new Promise((resolve) => {
    if (!request || busy || matchMedia("(prefers-reduced-motion: reduce)").matches) {
      onCovered();
      resolve();
      return;
    }
    request({ onCovered, duration, resolve });
  });
}

const PANELS = 7;
const EASE = "cubic-bezier(0.87, 0.05, 0.02, 0.97)";

export function ShutterHost() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    request = ({ onCovered, duration, resolve }) => {
      const host = ref.current;
      if (!host) {
        onCovered();
        resolve();
        return;
      }
      busy = true;
      host.style.display = "grid";
      const panels = [...host.children] as HTMLElement[];
      const stagger = 28;
      panels.forEach((p, i) => {
        const d = Math.abs(i - (PANELS - 1) / 2) * stagger;
        p.animate(
          [
            { transform: "translateY(101%)", easing: EASE },
            { transform: "translateY(0%)", offset: 0.3 },
            { transform: "translateY(0%)", offset: 0.58, easing: EASE },
            { transform: "translateY(-101%)" },
          ],
          { duration, delay: d, fill: "both" },
        );
      });
      setTimeout(onCovered, duration / 3 + stagger * PANELS * 0.5);
      setTimeout(() => {
        host.style.display = "none";
        panels.forEach((p) => p.getAnimations().forEach((a) => a.cancel()));
        busy = false;
        resolve();
      }, duration + stagger * PANELS);
    };
    return () => {
      request = null;
    };
  }, []);
  return (
    <div ref={ref} className="shutter" style={{ display: "none" }} aria-hidden>
      {Array.from({ length: PANELS }, (_, i) => (
        <i key={i} />
      ))}
    </div>
  );
}
