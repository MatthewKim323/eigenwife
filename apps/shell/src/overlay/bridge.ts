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
  /** The global cursor in screen points (~30Hz while visible, only when it moved). Returns an unsubscribe. */
  onCursor(cb: (p: { x: number; y: number }) => void): () => void;
}

const noop: OverlayBridge = {
  setInteractive() {},
  dragStart() {},
  dragEnd() {},
  log() {},
  on: () => () => {},
  ready() {},
  onCursor: () => () => {},
};

const real = typeof window !== "undefined" ? (window as any).eveOverlay : null;
// An older preload without onCursor still works (the cursor then only counts over her window).
export const bridge: OverlayBridge = real ? { ...noop, ...real } : noop;
export const inElectron = typeof window !== "undefined" && !!(window as any).eveOverlay;
