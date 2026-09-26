import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useBus } from "../lib/bus";
import { startGaze, type GazeBridge, type GazeMode } from "./bridge";

const GazeContext = createContext<GazeBridge | null>(null);

export function GazeProvider({ children }: { children: ReactNode }) {
  const { client } = useBus();
  const mode = (new URLSearchParams(location.search).get("gaze") as GazeMode) ?? "auto";
  const [bridge, setBridge] = useState<GazeBridge | null>(null);
  useEffect(() => {
    const b = startGaze(client, mode);
    setBridge(b);
    return () => b.close();
  }, [client, mode]);
  const value = useMemo(() => bridge, [bridge]);
  return <GazeContext.Provider value={value}>{children}</GazeContext.Provider>;
}

export function useGaze(): GazeBridge | null {
  return useContext(GazeContext);
}
