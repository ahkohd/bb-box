import { Agent, buildConnector, fetch as undiciFetch } from "undici";
import type { TailnetFetch } from "./tailnet.ts";

const IDLE_REUSE_MS = 4_000;
const CONNECT_TIMEOUT_MS = 10_000;

export function tailscaleFetch(log: (line: string) => void = () => {}): TailnetFetch {
  const connect = buildConnector({ timeout: CONNECT_TIMEOUT_MS });
  let connections = 0;
  let lastAddress = "";
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
          log(`Tailscale: opened a connection to ${lastAddress}, over ${protocol}.`);
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
      log(`Tailscale: ${init.method} ${new URL(url).pathname} failed after ${Date.now() - started} ms on ${reused ? "a reused" : "a new"} connection to ${lastAddress || "nowhere"}; its connections are closed, so the next request opens a fresh one.`);
      const stale = agent;
      agent = pool();
      void stale.destroy().catch(() => {});
      throw error;
    }
  };
}
