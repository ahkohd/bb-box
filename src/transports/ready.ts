// Waits for a box to answer on its command transport.

import type { CommandTransport } from "./types.ts";

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    function abort() {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * Probes every `intervalMs` until the box answers or the deadline passes. A
 * refused or unreachable port fails in milliseconds; the next probe starts
 * `intervalMs` after the previous one began.
 */
export async function waitUntilAnswers(
  transport: Pick<CommandTransport, "probe">,
  options: { timeoutMs: number; intervalMs?: number; signal?: AbortSignal; sleep?: (ms: number, signal?: AbortSignal) => Promise<void> },
): Promise<boolean> {
  const interval = options.intervalMs ?? 1_000;
  const sleep = options.sleep ?? pause;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    if (await transport.probe(options.signal)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.max(0, interval - (Date.now() - started)), options.signal);
  }
}
