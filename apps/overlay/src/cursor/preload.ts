/**
 * The cursor layer's only bridge: events in, nothing out. The page can't
 * send anything back to main (there is nothing it could ask for).
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";

const CHANNELS = new Set(["event", "browser", "hue", "display", "reset", "level", "gaze", "gaze-target"]);

contextBridge.exposeInMainWorld("eveCursor", {
  on(channel: string, cb: (payload: unknown) => void) {
    if (!CHANNELS.has(channel)) return () => {};
    const fn = (_e: IpcRendererEvent, p: unknown) => cb(p);
    ipcRenderer.on(`cursor:${channel}`, fn);
    return () => void ipcRenderer.removeListener(`cursor:${channel}`, fn);
  },
});
