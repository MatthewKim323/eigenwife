import type { Module } from "../context";

/** Memory (Moss): records, write policy, retrieval, recall flashes. Stub: owned by the memory builder. */
export function memoryModule(): Module {
  return { name: "memory", start() {} };
}
