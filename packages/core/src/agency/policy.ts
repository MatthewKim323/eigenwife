import type { PermissionClass } from "@eigenwife/protocol";
import type { ActionDef } from "./types";

/** Apps Eve may never touch, whatever the permission class. Matched case-insensitively as substrings. */
export const DENY_APPS = [
  "terminal",
  "iterm",
  "warp",
  "system settings",
  "system preferences",
  "keychain access",
  "1password",
  "bitwarden",
  "lastpass",
  "dashlane",
  "passwords",
  "activity monitor",
  "disk utility",
];

/** Kinds that talk to other people or spend money are always SENSITIVE and never auto-approved. */
const SENSITIVE_KIND = /(^|[._])(send|message|email|sms|text|post|tweet|purchase|buy|pay|checkout|order|transfer)([._]|$)/i;

export const AUTO_CLASSES: readonly PermissionClass[] = ["READ", "SAFE_ACTION"];

export function effectivePermission(def: ActionDef): PermissionClass {
  if (SENSITIVE_KIND.test(def.kind)) return "SENSITIVE_ACTION";
  return def.permission;
}

export function needsApproval(p: PermissionClass): boolean {
  return !AUTO_CLASSES.includes(p);
}

export interface PolicyVerdict {
  allowed: boolean;
  reason?: string;
}

export class Policy {
  private spent = 0;
  constructor(
    public budget: number,
    private denyApps: string[] = DENY_APPS,
  ) {}

  /** Checked before every action. READ actions don't spend budget but still obey the deny list. */
  check(def: ActionDef, args: Record<string, unknown>): PolicyVerdict {
    for (const t of def.targets?.(args) ?? []) {
      const hit = this.denied(t);
      if (hit) return { allowed: false, reason: `${t} is on the deny list (${hit})` };
    }
    if (effectivePermission(def) !== "READ" && this.spent >= this.budget)
      return { allowed: false, reason: `session action budget spent (${this.spent}/${this.budget})` };
    return { allowed: true };
  }

  /** Call once an allowed, approved action actually runs. */
  spend(def: ActionDef): void {
    if (effectivePermission(def) !== "READ") this.spent++;
  }

  used(): number {
    return this.spent;
  }

  denied(target: string): string | null {
    const t = target.toLowerCase();
    return this.denyApps.find((d) => t.includes(d)) ?? null;
  }
}
