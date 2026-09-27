import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Who speaks an action's outcome. Code running inside reported() (work.handle,
 * the follow-up flows) returns its own outcome line for the caller to say, so
 * the follow-up module stays quiet about those actions. Anything outside (the
 * reflex's "show me" browse, a music command that failed) gets its outcome
 * line from the follow-up module, so she never goes quiet after acting.
 * The bus is synchronous, so action.result handlers see the caller's context.
 */
const store = new AsyncLocalStorage<true>();

export function reported<T>(fn: () => Promise<T>): Promise<T> {
  return store.run(true, fn);
}

export function inReported(): boolean {
  return store.getStore() === true;
}
