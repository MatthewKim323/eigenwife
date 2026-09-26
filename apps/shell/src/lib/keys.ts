import type { Scene } from "@eigenwife/protocol";

/**
 * Operator keys. Pure mapping so it can be tested and documented in one
 * place (docs/SHELL.md). Every handled key is also emitted as shell.key so
 * a remote operator can drive the shell over the bus (POST /emit).
 */

export const SCENE_ORDER: readonly Scene[] = [
  "boot",
  "calibration",
  "dating",
  "convergence",
  "emergence",
  "desktop",
  "swarm",
  "architecture",
];

export type KeyAction =
  | { type: "scene"; scene: Scene }
  | { type: "next" }
  | { type: "prev" }
  | { type: "open-eigen" }
  | { type: "close-eigen" }
  | { type: "toggle-hud" }
  | { type: "toggle-reticle" }
  | { type: "toggle-mouse" }
  | { type: "help" }
  | { type: "escape" };

export const KEY_HELP: readonly [string, string][] = [
  ["1 to 8", "jump to scene: boot, calibration, dating, convergence, emergence, desktop, swarm, architecture"],
  ["→ / ←", "next / previous (profile, architecture beat)"],
  ["↑ or d", "dating relapse: open the Eigen app on the desktop"],
  ["↓", "close the Eigen app"],
  ["a", "architecture slide"],
  ["h", "HUD verbosity: full, quiet, off"],
  ["g", "gaze reticle on / off"],
  ["m", "toggle mouse gaze (reloads in place)"],
  ["?", "this sheet"],
  ["esc", "close sheet / Eigen app"],
];

/** Map a KeyboardEvent.key to an operator action. Returns null for keys we ignore. */
export function keyAction(key: string): KeyAction | null {
  if (/^[1-8]$/.test(key)) return { type: "scene", scene: SCENE_ORDER[Number(key) - 1]! };
  switch (key) {
    case "ArrowRight":
      return { type: "next" };
    case "ArrowLeft":
      return { type: "prev" };
    case "ArrowUp":
    case "d":
    case "D":
      return { type: "open-eigen" };
    case "ArrowDown":
    case "eigen.close":
      return { type: "close-eigen" };
    case "a":
    case "A":
      return { type: "scene", scene: "architecture" };
    case "h":
    case "H":
      return { type: "toggle-hud" };
    case "g":
    case "G":
      return { type: "toggle-reticle" };
    case "m":
    case "M":
      return { type: "toggle-mouse" };
    case "?":
      return { type: "help" };
    case "Escape":
      return { type: "escape" };
    default:
      return null;
  }
}

/** Keys pressed with a modifier (cmd+r, ctrl+c) belong to the browser, not us. */
export function isOperatorKeyEvent(ev: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean }): boolean {
  if (ev.metaKey || ev.ctrlKey || ev.altKey) return false;
  return keyAction(ev.key) !== null;
}

export type HudLevel = "full" | "quiet" | "off";
export function nextHudLevel(l: HudLevel): HudLevel {
  return l === "full" ? "quiet" : l === "quiet" ? "off" : "full";
}

/** URL for toggling the gaze source in place: keeps the current scene, flips gaze=mouse. */
export function toggledGazeUrl(href: string, scene: Scene): string {
  const u = new URL(href);
  const cur = u.searchParams.get("gaze");
  if (cur === "mouse") u.searchParams.delete("gaze");
  else u.searchParams.set("gaze", "mouse");
  u.searchParams.set("scene", scene);
  return u.toString();
}
