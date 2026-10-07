// The machine's end of the Docker API relay (042), in bb-box's host entry.
// "relay" opens a WebSocket out to bb-box's route on BB's server, with the
// secret the call gives, and joins each channel the server opens to Docker,
// found as the docker CLI here would find it. The worker holds a lease
// while the relay is open, so BB's idle timer leaves it.

import { execFile } from "node:child_process";
import { connect, type NetConnectOpts } from "node:net";
import { release, userInfo } from "node:os";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { Mux, type Channel, type MuxOptions } from "../relay/mux.ts";

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

/** The OS of this machine for bb-box's forms: windows when BB's daemon runs in WSL (its kernel says microsoft), macos on a Mac, else linux. */
export function machinePlatform(platform: string = process.platform, kernel: string = release()): "linux" | "macos" | "windows" {
  if (platform === "win32" || /microsoft/i.test(kernel)) return "windows";
  if (platform === "darwin") return "macos";
  return "linux";
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

/**
 * Opens a WebSocket out to bb-box's route at `path` on BB's server, with
 * `secret`, and a Mux on it for channels bb-box opens: the Docker relay's
 * and a file copy's (#492).
 */
export function dial(path: string, secret: string, connect: ((url: string) => RelayWebSocket) | undefined, options: Omit<MuxOptions, "opener">): Mux {
  const server = process.env.BB_SERVER_URL;
  if (!server) throw new Error("BB_SERVER_URL is not set in the worker, so it cannot reach bb-box.");
  const url = `${server.replace(/^http/, "ws").replace(/\/$/, "")}${path}?s=${encodeURIComponent(secret)}`;
  const socket = (connect ?? ((to) => new WebSocket(to) as unknown as RelayWebSocket))(url);
  socket.binaryType = "arraybuffer";
  const mux = new Mux({ send: (data) => socket.send(data), close: (code, reason) => socket.close(code, reason) }, { ...options, opener: false });
  socket.addEventListener("message", (event) => {
    if (event.data instanceof ArrayBuffer) mux.receive(new Uint8Array(event.data));
    else if (ArrayBuffer.isView(event.data)) mux.receive(new Uint8Array(event.data.buffer, event.data.byteOffset, event.data.byteLength));
  });
  socket.addEventListener("close", () => mux.close("bb-box's side closed"));
  socket.addEventListener("error", () => mux.close("the WebSocket to bb-box failed"));
  return mux;
}

function describe(endpoint: DockerEndpoint): string {
  return "path" in endpoint ? endpoint.path : `${endpoint.host}:${endpoint.port}`;
}

/**
 * What to do when Docker's socket refused BB's daemon, as when its user is
 * not in the socket's group, or was put in it after the daemon started.
 * Null for any other failure.
 */
export function refusal(endpoint: DockerEndpoint, error: NodeJS.ErrnoException, platform: NodeJS.Platform = process.platform): string | null {
  if (error.code !== "EACCES" || !("path" in endpoint) || platform === "win32") return null;
  const { username, uid } = userInfo();
  // A systemd user service gets its groups from the user's manager, so restarting the service alone keeps the old ones.
  const restart = platform === "linux" ? `restart ${username}'s services so BB's daemon has the group: sudo systemctl restart user@${uid}.service` : "restart BB's daemon";
  return `${username} may not use Docker's socket ${endpoint.path}. Add ${username} to its group, usually docker, then ${restart}.`;
}

/** Connects to Docker's endpoint and closes at once: whether it is there to relay to, and if not, why and whether it refused BB's daemon. */
function reachable(endpoint: DockerEndpoint, timeoutMs = 3_000): Promise<{ reason: string; refused: boolean } | null> {
  return new Promise((resolve) => {
    const socket = connect(endpoint as NetConnectOpts);
    const done = (failed: { reason: string; refused: boolean } | null) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(failed);
    };
    const timer = setTimeout(() => done({ reason: `it did not answer at ${describe(endpoint)} within ${timeoutMs / 1000} s`, refused: false }), timeoutMs);
    socket.once("connect", () => done(null));
    socket.once("error", (error) => {
      const refused = refusal(endpoint, error);
      done({ reason: refused ?? `${describe(endpoint)}: ${error.message}`, refused: refused !== null });
    });
  });
}

export function relayHandlers(options: RelayOptions = {}) {
  const leases = new Set<ExperimentalHostWorkerLease>();
  const muxes = new Set<Mux>();
  const join = (channel: Channel, endpoint: DockerEndpoint) => {
    const socket = connect({ ...endpoint, allowHalfOpen: true } as NetConnectOpts);
    socket.on("error", (error) => channel.destroy(new Error(refusal(endpoint, error) ?? `Docker at ${describe(endpoint)}: ${error.message}`)));
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
          return { endpoint: "", found: false, reason: error instanceof Error ? error.message : String(error), platform: machinePlatform() };
        }
        const failed = await reachable(endpoint);
        return { endpoint: describe(endpoint), found: failed === null, reason: failed?.reason ?? null, ...(failed?.refused ? { refused: true } : {}), platform: machinePlatform() };
      },
      relay: async ({ secret, path }: { secret: string; path: string }, context: ExperimentalHostRpcContext) => {
        const endpoint = await (options.endpoint ?? dockerEndpoint)();
        if (!process.env.BB_SERVER_URL) throw new Error("BB_SERVER_URL is not set in the worker, so it cannot reach bb-box.");
        const lease = context.experimental_retainWorker();
        leases.add(lease);
        const mux = dial(path, secret, options.connect, {
          onOpen: (channel) => join(channel, endpoint),
          pingMs: options.pingMs,
          deadMs: options.deadMs,
          onClose: () => {
            muxes.delete(mux);
            leases.delete(lease);
            void lease.dispose();
          },
        });
        muxes.add(mux);
        return { endpoint: describe(endpoint) };
      },
    },
    async dispose() {
      for (const mux of muxes) mux.close("the worker stopped");
      for (const lease of leases) await lease.dispose();
    },
  };
}
