const MIN_POLL_MS = 2000;
const MAX_WAIT_MS = 60_000;
const DEFAULT_POLL_MS = 5000;

export const MAX_BACKOFF_STEPS = 5;

export function pollDelayMs(intervalMs: number): number {
  return Math.min(MAX_WAIT_MS, Math.max(MIN_POLL_MS, intervalMs || DEFAULT_POLL_MS));
}

export function backoffDelayMs(failures: number): number {
  return Math.min(MAX_WAIT_MS, DEFAULT_POLL_MS * 2 ** (failures - 1));
}
