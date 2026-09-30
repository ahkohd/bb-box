// Waits for a box to answer: first for a TCP port to accept connections,
// which is quick to poll, then on its command transport.

import { createConnection } from "node:net";
import type { CommandTransport } from "./types.ts";

/** True when something accepts a TCP connection on host:port within `timeoutMs`. */
export type PortCheck = (host: string, port: number, timeoutMs: number, signal?: AbortSignal) => Promise<boolean>;

export function pause(ms: number, signal?: AbortSignal): Promise<void> {
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

/** Opens a TCP connection and closes it at once. */
export const portOpen: PortCheck = (host, port, timeoutMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const socket = createConnection({ host, port });
    const done = (open: boolean) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      socket.destroy();
      resolve(open);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    function abort() {
      clearTimeout(timer);
      socket.destroy();
      reject(signal!.reason);
    }
    signal?.addEventListener("abort", abort, { once: true });
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });

/**
 * Checks every `intervalMs` until host:port accepts a connection or the
 * deadline passes. Each attempt gives up after `connectTimeoutMs`, so a guest
 * whose network is not up yet costs a quarter of a second, not a TCP timeout.
 */
export async function waitForPort(
  host: string,
  port: number,
  options: {
    timeoutMs: number;
    intervalMs?: number;
    connectTimeoutMs?: number;
    check?: PortCheck;
    signal?: AbortSignal;
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<boolean> {
  const interval = options.intervalMs ?? 50;
  const connectTimeout = options.connectTimeoutMs ?? 250;
  const check = options.check ?? portOpen;
  const sleep = options.sleep ?? pause;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    options.signal?.throwIfAborted();
    const started = Date.now();
    if (await check(host, port, Math.max(1, Math.min(connectTimeout, deadline - started)), options.signal)) return true;
    if (Date.now() >= deadline) return false;
    await sleep(Math.max(0, interval - (Date.now() - started)), options.signal);
  }
}
