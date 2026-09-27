import type { Module } from "../context";
import { agencyModule } from "../agency/module";
import { brainsModule } from "../brains/module";
import { earsModule } from "../ears/module";
import { homeModule } from "../home/module";
import { memoryModule } from "../memory/module";
import { onboardingModule } from "../onboarding/module";
import { relationshipModule } from "../mind/module";
import { preferenceModule } from "../preference/module";
import { reflexModule } from "../reflex/module";
import { speechModule } from "../speech/module";
import { talkerModule } from "../talker/module";
import { wardrobeModule } from "../wardrobe/module";
import { workModule } from "../work/module";
import { followupModule } from "../followup/module";
import { screenModule } from "../screen/module";
import { desktopGazeModule } from "../gaze/module";
import { clock } from "./clock";
import { touchModule } from "../touch/module";
import { greetModule } from "../greet/module";
import { liveModule } from "../live/module";

/**
 * The full Eve. Modules never import each other: they talk over the bus.
 * Each one owns a faculty (see docs/ARCHITECTURE.md).
 */
export function allModules(): Module[] {
  return [
    clock(),
    homeModule(),
    // Before memory/preference: owns user.json and hears the first companion.born.
    onboardingModule(),
    memoryModule(),
    preferenceModule(),
    relationshipModule(),
    wardrobeModule(),
    brainsModule(),
    speechModule(),
    // After speech: wraps the speech service so the gpt-live-1 engine can own her voice (docs/LIVE.md).
    liveModule(),
    earsModule(),
    // The fast voice with one tool (delegate); the reflex routes turns through it. docs/VOICE.md
    talkerModule(),
    reflexModule(),
    agencyModule(),
    touchModule(),
    greetModule(),
    workModule(),
    // The next step after anything she did (docs/FOLLOW_THROUGH.md).
    followupModule(),
    screenModule(),
    // After screen: shares its helper, privacy rules and pause. eye serve fixations -> gaze.target.
    desktopGazeModule(),
  ];
}
