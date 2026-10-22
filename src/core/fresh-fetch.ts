import { Agent, buildConnector, fetch as undiciFetch, type Response } from "undici";

const IDLE_REUSE_MS = 4_000;
const CONNECT_TIMEOUT_MS = 10_000;

export type FreshFetch = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<Response>;

export function freshFetch(service: string, log: (line: string) => void = () => {}): FreshFetch {
  const connect = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
  let connections = 0;
  let lastAddress = "";
  let afterFailure = false;
  const pool = () =>
    new Agent({
      keepAliveTimeout: IDLE_REUSE_MS,
      keepAliveMaxTimeout: IDLE_REUSE_MS,
      connect: (options, callback) =>
        connect(options, (error, socket) => {
          if (error || !socket) return callback(error ?? new Error("no connection"), null);
          connections += 1;
          lastAddress = `${socket.remoteAddress ?? "an unknown address"}${socket.remoteFamily ? ` (${socket.remoteFamily})` : ""}`;
          const protocol = "alpnProtocol" in socket && typeof socket.alpnProtocol === "string" ? socket.alpnProtocol : "http/1.1";
          if (afterFailure) log(`${service}: opened a fresh connection to ${lastAddress}, over ${protocol}, after a failed request.`);
          afterFailure = false;
          callback(null, socket);
        }),
    });
  let agent = pool();
  return async (url, init) => {
    const openedBefore = connections;
    const started = Date.now();
    try {
      return await undiciFetch(url, { ...init, dispatcher: agent });
    } catch (error) {
      const reused = connections === openedBefore;
      log(`${service}: ${init.method} ${new URL(url).pathname} failed after ${Date.now() - started} ms on ${reused ? "a reused" : "a new"} connection to ${lastAddress || "nowhere"}; its connections are closed, so the next request opens a fresh one.`);
      afterFailure = true;
      const stale = agent;
      agent = pool();
      void stale.destroy().catch(() => {});
      throw error;
    }
  };
}
