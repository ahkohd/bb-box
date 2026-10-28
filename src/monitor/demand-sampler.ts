export function createDemandSampler<T>(options: {
  collect: (signal: AbortSignal) => Promise<T>;
  reset: () => void;
  intervalMs: () => number;
  now?: () => number;
}) {
  const now = options.now ?? (() => performance.now());
  const lifecycle = new AbortController();
  let cached: T | null = null;
  let sampledAt = -Infinity;
  let pending: Promise<T> | null = null;
  let expiry: ReturnType<typeof setTimeout> | undefined;

  function clear() {
    cached = null;
    sampledAt = -Infinity;
    options.reset();
  }

  function expireLater() {
    clearTimeout(expiry);
    expiry = setTimeout(() => { expiry = undefined; clear(); }, Math.max(15_000, options.intervalMs() * 2));
    expiry.unref();
  }

  function sample(force = false): Promise<T> {
    if (lifecycle.signal.aborted) return Promise.reject(new Error("The monitor has stopped"));
    if (pending) return pending;
    if (!force && cached !== null && now() - sampledAt < options.intervalMs()) {
      expireLater();
      return Promise.resolve(cached);
    }
    clearTimeout(expiry);
    expiry = undefined;
    pending = Promise.resolve().then(() => {
      lifecycle.signal.throwIfAborted();
      return options.collect(lifecycle.signal);
    }).then((value) => {
      lifecycle.signal.throwIfAborted();
      cached = value;
      sampledAt = now();
      return value;
    }).catch((error: unknown) => {
      clear();
      throw error;
    }).finally(() => {
      pending = null;
      if (!lifecycle.signal.aborted) expireLater();
      else clear();
    });
    return pending;
  }

  return {
    sample,
    intervalChanged() {
      if (cached !== null && !pending && !lifecycle.signal.aborted) expireLater();
    },
    forget() {
      if (pending) return;
      clearTimeout(expiry);
      expiry = undefined;
      clear();
    },
    dispose() {
      lifecycle.abort();
      clearTimeout(expiry);
      expiry = undefined;
      clear();
    },
  };
}
