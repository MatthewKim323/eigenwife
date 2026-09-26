import { useSyncExternalStore } from "react";
import type { AvatarState } from "@eigenwife/protocol";
import { AttentionController } from "./attention";
import { resolveModel, type FramingSlot } from "./models";
import { EveRig } from "./rig";

/** The avatar model for this page: ?model= beats the build-time EVE_MODEL beats the default (Haru). */
export const activeModel = resolveModel(
  typeof location !== "undefined" ? location.search : "",
  (import.meta as any).env?.EVE_MODEL as string | undefined,
);

function makeRig() {
  const rig = new EveRig(Math.random, typeof performance !== "undefined" ? performance.now() : 0);
  rig.setModel(activeModel);
  return rig;
}

/** Minimal external store: plain object, shallow set, React subscription via selector. */
export function createStore<T extends object>(initial: T) {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(patch: Partial<T>) {
      let changed = false;
      for (const k in patch) if (!Object.is(state[k], patch[k])) changed = true;
      if (!changed) return;
      state = { ...state, ...patch };
      subs.forEach((s) => s());
    },
    subscribe(fn: () => void) {
      subs.add(fn);
      return () => void subs.delete(fn);
    },
  };
}

export function useStore<T extends object, U>(store: ReturnType<typeof createStore<T>>, sel: (s: T) => U): U {
  return useSyncExternalStore(store.subscribe, () => sel(store.get()));
}

export type Dock = "hidden" | "card" | "stage" | "column";

export interface AvatarUi {
  dock: Dock;
  /** Screen rect of the card portrait slot while docked in the card. */
  cardRect: { x: number; y: number; w: number; h: number } | null;
  /** Emergence choreography overrides the world state (e.g. asleep in the card). */
  stateOverride: AvatarState | null;
  /** Effective state, resolved every frame by the layer. */
  state: AvatarState;
  renderer: "loading" | "live2d" | "tachie";
  /** 0 = card mask fully on (bleeding out of the frame), 1 = mask gone. */
  reveal: number;
  glitch: boolean;
}

export const avatarUi = createStore<AvatarUi>({
  dock: "hidden",
  cardRect: null,
  stateOverride: null,
  state: "sleeping",
  renderer: "loading",
  reveal: 1,
  glitch: false,
});

/**
 * Per-frame runtime, deliberately NOT React state: the voice player writes the
 * mouth at 60fps and the renderer reads it without re-rendering anything.
 */
export const avatarRuntime = {
  rig: makeRig(),
  /** Which framing she's in right now (the head position in the box depends on it). */
  slot: "column" as FramingSlot,
  attention: new AttentionController(),
  mouth: 0,
  mouthHold: false,
  speaking: false,
  /** Capture/debug overrides (window.__eve). */
  still: false,
  eyesClosed: false,
  mouthOverride: null as number | null,
  /** Screen position of her head, updated by the layer, used for look-at mapping. */
  head: { x: 0, y: 0 },
};
