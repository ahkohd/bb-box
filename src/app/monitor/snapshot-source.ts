import { MAX_BACKOFF_STEPS, backoffDelayMs, pollDelayMs } from "./cadence.ts";

export function createSnapshotSource<T>(intervalMs: (value: T) => number) {
  let snapshot: T | null = null;
  let pending: Promise<T> | null = null;
  let nextAttemptAt = 0;
  let failures = 0;
  let error: unknown;
  const listeners = new Set<(value: T) => void>();
  const publish = (value: T) => {
    snapshot = value;
    for (const listener of listeners) listener(value);
  };
  return {
    snapshot: () => snapshot,
    subscribe(listener: (value: T) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load(collect: () => Promise<T>, force = false): Promise<T> {
      if (pending) return pending;
      if (!force && Date.now() < nextAttemptAt) {
        if (failures) return Promise.reject(error);
        if (snapshot !== null) return Promise.resolve(snapshot);
      }
      pending = Promise.resolve().then(collect).then((value) => {
        publish(value);
        failures = 0;
        error = undefined;
        nextAttemptAt = Date.now() + pollDelayMs(intervalMs(value));
        return value;
      }, (cause: unknown) => {
        error = new Error(cause instanceof Error ? cause.message.slice(0, 500) : "Server unavailable");
        failures = Math.min(MAX_BACKOFF_STEPS, failures + 1);
        nextAttemptAt = Date.now() + backoffDelayMs(failures);
        throw error;
      }).finally(() => { pending = null; });
      return pending;
    },
  };
}
