// Waiting that ends when a signal aborts, as when the plugin stops and BB
// may no longer answer it.

/** `promise`, or `signal`'s reason as soon as it aborts. The work itself goes on; only the wait ends. */
export function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => (signal.removeEventListener("abort", abort), resolve(value)),
      (error: unknown) => (signal.removeEventListener("abort", abort), reject(error)),
    );
  });
}
