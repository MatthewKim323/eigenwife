import type { Module } from "../context";

/** Home (Zo): persistence of Eve's state off the web page. Stub: owned by the memory builder. */
export function homeModule(): Module {
  return { name: "home", start() {} };
}
