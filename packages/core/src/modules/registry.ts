import type { Module } from "../context";
import { clock } from "./clock";

/**
 * The full Eve. Order matters only for startup logs: modules talk over the bus.
 * Each module owns one faculty (see docs/ARCHITECTURE.md).
 */
export function allModules(): Module[] {
  return [clock()];
}
