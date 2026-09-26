import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GazeProvider } from "./gaze/GazeProvider";
import { BusProvider } from "./lib/bus";
import { SceneProvider } from "./lib/scene";
import { OVERLAY } from "./overlay/mode";
import { OverlayApp } from "./overlay/OverlayApp";
import "./styles/tokens.css";
import { VoiceProvider } from "./voice/VoiceProvider";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BusProvider>
      {OVERLAY ? (
        // Desktop companion (apps/overlay): only Eve, no scenes, no gaze.
        <VoiceProvider>
          <OverlayApp />
        </VoiceProvider>
      ) : (
        <GazeProvider>
          <SceneProvider>
            <VoiceProvider>
              <App />
            </VoiceProvider>
          </SceneProvider>
        </GazeProvider>
      )}
    </BusProvider>
  </StrictMode>,
);
