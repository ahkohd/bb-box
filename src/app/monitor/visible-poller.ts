import { MAX_BACKOFF_STEPS, backoffDelayMs, pollDelayMs } from "./cadence.ts";

export function createVisiblePoller<T>(options: {
  load: () => Promise<T>;
  receive: (value: T) => void;
  error: (error: unknown) => void;
  intervalMs: (value: T) => number;
}) {
  let active = false;
  let disposed = false;
  let generation = 0;
  let pending = false;
  let failures = 0;
  let nextPollAt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  async function poll() {
    if (!active || disposed || pending) return;
    pending = true;
    const requestGeneration = generation;
    let delay = 5000;
    try {
      const value = await options.load();
      if (!active || disposed || requestGeneration !== generation) return;
      failures = 0;
      delay = pollDelayMs(options.intervalMs(value));
      options.receive(value);
    } catch (error) {
      if (!active || disposed || requestGeneration !== generation) return;
      failures = Math.min(failures + 1, MAX_BACKOFF_STEPS);
      delay = backoffDelayMs(failures);
      options.error(error);
    } finally {
      pending = false;
      if (active && !disposed) {
        schedule(requestGeneration === generation ? delay : 0);
      }
    }
  }

  function schedule(delay: number) {
    nextPollAt = Date.now() + delay;
    timer = setTimeout(() => { timer = undefined; void poll(); }, delay);
  }

  return {
    setActive(next: boolean) {
      if (disposed || next === active) return;
      active = next;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      if (active && !pending) {
        const remaining = Math.max(0, nextPollAt - Date.now());
        if (remaining > 0) schedule(remaining);
        else void poll();
      }
    },
    refresh() {
      if (disposed || !active) return false;
      generation++;
      clearTimeout(timer);
      timer = undefined;
      nextPollAt = 0;
      if (!pending) void poll();
      return true;
    },
    dispose() {
      disposed = true;
      active = false;
      generation++;
      clearTimeout(timer);
      timer = undefined;
    },
  };
}
