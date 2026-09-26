import type { Module } from "../context";

/** Speech pipeline: mark splitter, TTS, speech.* events, audio cache route. Stub: owned by the brains builder. */
export function speechModule(): Module {
  return { name: "speech", start() {} };
}
