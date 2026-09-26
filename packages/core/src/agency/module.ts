import type { Module } from "../context";

/** Agency: tasks, permissions + voice approvals, computer actions. Stub: owned by the agency builder. */
export function agencyModule(): Module {
  return { name: "agency", start() {} };
}
