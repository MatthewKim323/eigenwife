import type { Module } from "../context";
import { agencyModule } from "../agency/module";
import { brainsModule } from "../brains/module";
import { earsModule } from "../ears/module";
import { homeModule } from "../home/module";
import { memoryModule } from "../memory/module";
import { relationshipModule } from "../mind/module";
import { preferenceModule } from "../preference/module";
import { reflexModule } from "../reflex/module";
import { speechModule } from "../speech/module";
import { wardrobeModule } from "../wardrobe/module";
import { workModule } from "../work/module";
import { screenModule } from "../screen/module";
import { clock } from "./clock";

/**
 * The full Eve. Modules never import each other: they talk over the bus.
 * Each one owns a faculty (see docs/ARCHITECTURE.md).
 */
export function allModules(): Module[] {
  return [
    clock(),
    homeModule(),
    memoryModule(),
    preferenceModule(),
    relationshipModule(),
    wardrobeModule(),
    brainsModule(),
    speechModule(),
    earsModule(),
    reflexModule(),
    agencyModule(),
    workModule(),
    screenModule(),
  ];
}
