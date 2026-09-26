import type { Module } from "../context";

/** Brain router: persona brain (fast) + frontier brains (jabby) behind one interface. Stub: owned by the brains builder. */
export function brainsModule(): Module {
  return { name: "brains", start() {} };
}
