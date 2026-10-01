// The machine's end of the Docker API relay (042), in bb-box's host entry.
// "relay" opens a WebSocket out to bb-box's route on BB's server, with the
// secret the call gives, and joins each channel the server opens to Docker,
// found as the docker CLI here would find it. The worker holds a lease
// while the relay is open, so BB's idle timer leaves it.

import { execFile } from "node:child_process";
import { connect, type NetConnectOpts } from "node:net";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { Mux, type Channel } from "../relay/mux.ts";

/** What a channel connects to: Docker's unix socket or named pipe, or TCP. */
export type DockerEndpoint = { readonly path: string } | { readonly host: string; readonly port: number };

/** The WebSocket the worker opens; the global one, or a stand-in in tests. */
export interface RelayWebSocket {
  binaryType: string;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open" | "close" | "error", listener: () => void): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface RelayOptions {
  /** Opens the WebSocket to `url`. The global WebSocket by default. */
  readonly connect?: (url: string) => RelayWebSocket;
  /** Where Docker is. By default as the docker CLI would find it. */
  readonly endpoint?: () => Promise<DockerEndpoint>;
  readonly pingMs?: number;
  readonly deadMs?: number;
}

/** Docker's endpoint from a docker host address, or null for one the relay cannot reach. */
export function endpointOf(address: string): DockerEndpoint | null {
  if (address.startsWith("unix://")) return { path: address.slice("unix://".length) };
  // npipe:////./pipe/docker_engine is \\.\pipe\docker_engine.
  if (address.startsWith("npipe://")) return { path: address.slice("npipe://".length).replaceAll("/", "\\") };
  const tcp = /^tcp:\/\/([^:/]+):(\d+)\/?$/.exec(address);
  if (tcp) return { host: tcp[1]!, port: Number(tcp[2]) };
  return null;
}

/** Where the docker CLI here would go: DOCKER_HOST, then the current context's endpoint, then the default. */
export async function dockerEndpoint(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<DockerEndpoint> {
  if (env.DOCKER_HOST) {
    const endpoint = endpointOf(env.DOCKER_HOST);
    if (!endpoint) throw new Error(`DOCKER_HOST is ${env.DOCKER_HOST}, which the relay cannot reach: it takes unix://, npipe:// or tcp://.`);
    return endpoint;
  }
  const context = await new Promise<string | null>((resolve) =>
    execFile("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"], { timeout: 3_000, env }, (error, stdout) => resolve(error ? null : stdout.trim())),
  );
  const fromContext = context ? endpointOf(context) : null;
  if (fromContext) return fromContext;
  return platform === "win32" ? { path: "\\\\.\\pipe\\docker_engine" } : { path: "/var/run/docker.sock" };
}

function describe(endpoint: DockerEndpoint): string {
  return "path" in endpoint ? endpoint.path : `${endpoint.host}:${endpoint.port}`;
}

/** Connects to Docker's endpoint and closes at once: whether it is there to relay to. */
function reachable(endpoint: DockerEndpoint, timeoutMs = 3_000): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = connect(endpoint as NetConnectOpts);
    const done = (reason: string | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(reason);
    };
    const timer = setTimeout(() => done(`it did not answer at ${describe(endpoint)} within ${timeoutMs / 1000} s`), timeoutMs);
    socket.once("connect", () => done(null));
    socket.once("error", (error) => done(`${describe(endpoint)}: ${error.message}`));
  });
}

export function relayHandlers(options: RelayOptions = {}) {
  const leases = new Set<ExperimentalHostWorkerLease>();
  const muxes = new Set<Mux>();
  const join = (channel: Channel, endpoint: DockerEndpoint) => {
    const socket = connect({ ...endpoint, allowHalfOpen: true } as NetConnectOpts);
    socket.on("error", (error) => channel.destroy(new Error(`Docker at ${describe(endpoint)}: ${error.message}`)));
    channel.on("error", () => socket.destroy());
    socket.pipe(channel).pipe(socket);
  };
  return {
    handlers: {
      docker: async () => {
        let endpoint: DockerEndpoint;
        try {
          endpoint = await (options.endpoint ?? dockerEndpoint)();
        } catch (error) {
          return { endpoint: "", found: false, reason: error instanceof Error ? error.message : String(error) };
        }
        const reason = await reachable(endpoint);
        return { endpoint: describe(endpoint), found: reason === null, reason };
      },
      relay: async ({ secret, path }: { secret: string; path: string }, context: ExperimentalHostRpcContext) => {
        const endpoint = await (options.endpoint ?? dockerEndpoint)();
        const server = process.env.BB_SERVER_URL;
        if (!server) throw new Error("BB_SERVER_URL is not set in the worker, so it cannot reach bb-box.");
        const url = `${server.replace(/^http/, "ws").replace(/\/$/, "")}${path}?s=${encodeURIComponent(secret)}`;
        const socket = (options.connect ?? ((to) => new WebSocket(to) as unknown as RelayWebSocket))(url);
        socket.binaryType = "arraybuffer";
        const lease = context.experimental_retainWorker();
        leases.add(lease);
        const mux = new Mux(
          { send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) },
          {
            opener: false,
            onOpen: (channel) => join(channel, endpoint),
            pingMs: options.pingMs,
            deadMs: options.deadMs,
            onClose: () => {
              muxes.delete(mux);
              leases.delete(lease);
              void lease.dispose();
            },
          },
        );
        muxes.add(mux);
        socket.addEventListener("message", (event) => {
          if (event.data instanceof ArrayBuffer) mux.receive(new Uint8Array(event.data));
          else if (ArrayBuffer.isView(event.data)) mux.receive(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
        });
        socket.addEventListener("close", () => mux.close("bb-box's side closed"));
        socket.addEventListener("error", () => mux.close("the WebSocket to bb-box failed"));
        return { endpoint: describe(endpoint) };
      },
    },
    async dispose() {
      for (const mux of muxes) mux.close("the worker stopped");
      for (const lease of leases) await lease.dispose();
    },
  };
}
