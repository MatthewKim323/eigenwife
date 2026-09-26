import { AnimatePresence, motion } from "motion/react";
import type { ComponentType } from "react";
import type { Scene } from "@eigenwife/protocol";
import { AvatarLayer } from "./avatar/AvatarLayer";
import { Hud } from "./components/Hud";
import { useScene } from "./lib/scene";
import { ArchitectureScene } from "./scenes/Architecture";
import { BootScene } from "./scenes/Boot";
import { CalibrationScene } from "./scenes/Calibration";
import { ConvergenceScene } from "./scenes/Convergence";
import { DatingScene } from "./scenes/Dating";
import { DesktopScene } from "./scenes/Desktop";
import { EmergenceScene } from "./scenes/Emergence";
import { SwarmScene } from "./scenes/Swarm";

const SCENES: Record<Scene, ComponentType> = {
  boot: BootScene,
  calibration: CalibrationScene,
  dating: DatingScene,
  convergence: ConvergenceScene,
  emergence: EmergenceScene,
  desktop: DesktopScene,
  swarm: SwarmScene,
  architecture: ArchitectureScene,
};

export function App() {
  const { scene } = useScene();
  const Current = SCENES[scene];
  return (
    <>
      <AnimatePresence mode="wait">
        <motion.main
          key={scene}
          style={{ position: "fixed", inset: 0 }}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.35 }}
        >
          <Current />
        </motion.main>
      </AnimatePresence>
      <AvatarLayer />
      <Hud />
    </>
  );
}
