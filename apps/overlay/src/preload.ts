/**
 * The only door between the overlay page and the main process. Sandboxed,
 * context-isolated: the page gets window.eveOverlay and nothing else.
 * Contract: apps/shell/src/overlay/bridge.ts.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const CHANNELS = new Set(["mute", "attention", "visible"]);

contextBridge.exposeInMainWorld("eveOverlay", {
  setInteractive: (on: boolean) => ipcRenderer.send("overlay:interactive", !!on),
  dragStart: () => ipcRenderer.send("overlay:drag-start"),
  dragEnd: () => ipcRenderer.send("overlay:drag-end"),
  log: (msg: string) => ipcRenderer.send("overlay:log", String(msg).slice(0, 500)),
  ready: () => ipcRenderer.send("overlay:ready"),
  // What she's looking at (screen points) so her cursor can wander there; null = nothing in particular.
  reportLook: (p: { x: number; y: number } | null) => ipcRenderer.send("overlay:look", p ? { x: Number(p.x) || 0, y: Number(p.y) || 0 } : null),
  onCursor(cb: (p: { x: number; y: number }) => void) {
    const fn = (_e: IpcRendererEvent, p: { x: number; y: number }) => cb({ x: Number(p?.x) || 0, y: Number(p?.y) || 0 });
    ipcRenderer.on("overlay:cursor", fn);
    return () => void ipcRenderer.removeListener("overlay:cursor", fn);
  },
  on(channel: string, cb: (value: boolean) => void) {
    if (!CHANNELS.has(channel)) return () => {};
    const fn = (_e: IpcRendererEvent, v: boolean) => cb(!!v);
    ipcRenderer.on(`overlay:${channel}`, fn);
    return () => void ipcRenderer.removeListener(`overlay:${channel}`, fn);
  },
});
