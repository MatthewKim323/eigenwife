/**
 * The Electron preload (apps/overlay/src/preload.ts) exposes window.eveOverlay.
 * In a plain browser tab it's absent and every call is a no-op, so
 * ?mode=overlay still renders for design work.
 */
export type OverlayChannel = "mute" | "attention" | "visible";

export interface OverlayBridge {
  /** true: take clicks (pointer is over her pixels). false: click-through. */
  setInteractive(on: boolean): void;
  /** Main moves the window with the cursor until dragEnd. */
  dragStart(): void;
  dragEnd(): void;
  log(msg: string): void;
  on(channel: OverlayChannel, cb: (value: boolean) => void): () => void;
  /** Renderer is up: main replies with the current mute / attention state. */
  ready(): void;
}

const noop: OverlayBridge = {
  setInteractive() {},
  dragStart() {},
  dragEnd() {},
  log() {},
  on: () => () => {},
  ready() {},
};

export const bridge: OverlayBridge = (typeof window !== "undefined" && (window as any).eveOverlay) || noop;
export const inElectron = typeof window !== "undefined" && !!(window as any).eveOverlay;
