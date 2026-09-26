import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { GazeProvider } from "./gaze/GazeProvider";
import { BusProvider } from "./lib/bus";
import { SceneProvider } from "./lib/scene";
import "./styles/tokens.css";
import { VoiceProvider } from "./voice/VoiceProvider";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BusProvider>
      <GazeProvider>
        <SceneProvider>
          <VoiceProvider>
            <App />
          </VoiceProvider>
        </SceneProvider>
      </GazeProvider>
    </BusProvider>
  </StrictMode>,
);
