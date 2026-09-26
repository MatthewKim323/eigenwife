import type { ActionDef } from "../types";
import { CODE_ACTIONS } from "./code";
import { filesOpen, filesRead, filesSearch } from "./files";
import { JABBY_ACTIONS } from "./jabby";
import { shellRun } from "./shell";

/** Every coworker action (docs/WORK.md), registered with the gate in one line. */
export const WORK_ACTIONS: ActionDef[] = [filesSearch, filesRead, filesOpen, ...CODE_ACTIONS, ...JABBY_ACTIONS, shellRun];
