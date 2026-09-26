import { HttpError } from "./io";
import { isErrorText } from "./text";

export interface BackendHealth {
  ok: boolean;
  lastMs?: number;
  lastFirstTokenMs?: number;
  lastError?: string;
  lastUsedAt?: number;
  downUntil?: number;
  calls: number;
  failures: number;
  model?: string;
}

/**
 * Per-backend circuit breaker. A billing/auth/rate-limit failure parks a
 * backend for 10 minutes; anything else for 20 seconds. Parked backends are
 * skipped by the router and reported as not live by status().
 */
export class HealthBook {
  private m = new Map<string, BackendHealth>();
  constructor(private now: () => number = Date.now) {}

  get(name: string): BackendHealth {
    let h = this.m.get(name);
    if (!h) this.m.set(name, (h = { ok: true, calls: 0, failures: 0 }));
    return h;
  }

  cooling(name: string): boolean {
    const h = this.m.get(name);
    return !!h?.downUntil && h.downUntil > this.now();
  }

  ok(name: string, ms: number, firstTokenMs?: number, model?: string): void {
    const h = this.get(name);
    h.ok = true;
    h.calls++;
    h.lastMs = Math.round(ms);
    if (firstTokenMs !== undefined) h.lastFirstTokenMs = Math.round(firstTokenMs);
    if (model) h.model = model;
    h.lastUsedAt = this.now();
    h.downUntil = undefined;
  }

  fail(name: string, err: unknown): void {
    const h = this.get(name);
    h.ok = false;
    h.calls++;
    h.failures++;
    h.lastError = describe(err).slice(0, 200);
    h.lastUsedAt = this.now();
    h.downUntil = this.now() + (isHardFailure(err) ? 10 * 60_000 : 20_000);
  }

  snapshot(): Record<string, BackendHealth> {
    return Object.fromEntries([...this.m].map(([k, v]) => [k, { ...v }]));
  }
}

export function describe(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Billing, auth and rate limits don't fix themselves in 20 seconds. */
export function isHardFailure(err: unknown): boolean {
  if (err instanceof HttpError && (err.status === 401 || err.status === 402 || err.status === 403 || err.status === 429)) return true;
  return isErrorText(describe(err));
}
