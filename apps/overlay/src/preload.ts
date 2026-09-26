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
  on(channel: string, cb: (value: boolean) => void) {
    if (!CHANNELS.has(channel)) return () => {};
    const fn = (_e: IpcRendererEvent, v: boolean) => cb(!!v);
    ipcRenderer.on(`overlay:${channel}`, fn);
    return () => void ipcRenderer.removeListener(`overlay:${channel}`, fn);
  },
});
