import { useScene } from "../lib/scene";

/** Stub scene. See docs/ARCHITECTURE.md for the owner. */
export function EmergenceScene() {
  const { go } = useScene();
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%" }} className="mono dim" onClick={() => go("desktop")}>
      Emergence
    </div>
  );
}
