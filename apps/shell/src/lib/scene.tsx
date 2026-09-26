import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import type { Scene } from "@eigenwife/protocol";
import { useBus, useEvent } from "./bus";

const SceneContext = createContext<{ scene: Scene; go(s: Scene): void }>({ scene: "boot", go: () => {} });

const initial = (new URLSearchParams(location.search).get("scene") as Scene) ?? "boot";

/** Scene state lives in the shell; anyone on the bus can request a change with shell.scene. */
export function SceneProvider({ children }: { children: ReactNode }) {
  const { emit } = useBus();
  const [scene, setScene] = useState<Scene>(initial);
  useEvent("shell.scene", (e) => setScene(e.data.scene));
  const go = useCallback((s: Scene) => {
    emit("shell.scene", { scene: s });
  }, [emit]);
  return <SceneContext.Provider value={{ scene, go }}>{children}</SceneContext.Provider>;
}

export function useScene() {
  return useContext(SceneContext);
}
