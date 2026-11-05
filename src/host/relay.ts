// The machine's end of the Docker API relay (042), in bb-box's host entry.
// "relay" opens a WebSocket out to bb-box's route on BB's server, with the
// secret the call gives, and joins each channel the server opens to Docker,
// found as the docker CLI here would find it. The worker holds a lease
// while the relay is open, so BB's idle timer leaves it.

import { execFile, spawn } from "node:child_process";
import { connect, type NetConnectOpts } from "node:net";
import { constants } from "node:fs";
import { access, readFile, stat, statfs } from "node:fs/promises";
import { hostname, release, userInfo } from "node:os";
import type { ExperimentalHostRpcContext, ExperimentalHostWorkerLease } from "@get-bb/plugin-sdk/host";
import { ATTACH_PING, forwarderReason, isLocalhost, readAfterHalfClose } from "../backends/docker/attach.ts";
import { Mux, type Channel, type MuxOptions } from "../relay/mux.ts";

export interface WslDocker {
  readonly distro: string;
  readonly user: string | null;
}

/** What a channel connects to: Docker's unix socket or named pipe, TCP, or a WSL distribution's daemon through dial-stdio. */
export type DockerEndpoint = { readonly path: string } | { readonly host: string; readonly port: number } | { readonly wsl: WslDocker };

export interface DialStdio {
  stdin: NodeJS.WritableStream;
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null) => void): unknown;
}

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
  readonly dial?: (wsl: WslDocker) => DialStdio;
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
  const wsl = /^wsl:\/\/(?:([A-Za-z_][A-Za-z0-9_-]{0,31})@)?([A-Za-z0-9][A-Za-z0-9._-]{0,63})$/.exec(address);
  if (wsl) return { wsl: { user: wsl[1] ?? null, distro: wsl[2]! } };
  return null;
}

export function wslFrom(address: string): WslDocker | null {
  const endpoint = endpointOf(address);
  return endpoint && "wsl" in endpoint ? endpoint.wsl : null;
}

export function wslArgs(wsl: WslDocker, command: readonly string[]): string[] {
  return ["-d", wsl.distro, ...(wsl.user ? ["-u", wsl.user] : []), "-e", ...command];
}

export function wslDial(wsl: WslDocker): DialStdio {
  const child = spawn("wsl.exe", wslArgs(wsl, ["docker", "system", "dial-stdio"]), { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  if (!child.stdin || !child.stdout || !child.stderr) throw new Error("wsl.exe did not open its pipes");
  return child as DialStdio;
}

/** Where the docker CLI here would go: DOCKER_HOST, then the current context's endpoint, then the default. */
export async function dockerEndpoint(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): Promise<DockerEndpoint> {
  if (env.DOCKER_HOST) {
    const endpoint = endpointOf(env.DOCKER_HOST);
    if (!endpoint) throw new Error(`DOCKER_HOST is ${env.DOCKER_HOST}, which the relay cannot reach: it takes unix://, npipe://, tcp:// or wsl://.`);
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
  if ("wsl" in endpoint) return endpoint.wsl.user ? `wsl://${endpoint.wsl.user}@${endpoint.wsl.distro}` : `wsl://${endpoint.wsl.distro}`;
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

/** What first-run setup needs to know of this machine (#setup): who BB's daemon runs as, how to restart it, KVM, and free disk. */
export interface SetupFacts {
  readonly hostname: string;
  readonly user: string;
  /** The group of Docker's socket, and whether the daemon has it now. Null where there is no socket to read. */
  readonly socketGroup: string | null;
  readonly inSocketGroup: boolean | null;
  /** The command that restarts BB's daemon with new groups, or null when bb-box cannot tell how it runs. */
  readonly restart: string | null;
  readonly kvm: "ok" | "denied" | "absent";
  /** Free disk where Docker keeps images, else at the root, in GB. */
  readonly freeGb: number | null;
}

/** How BB's daemon restarts with new groups, from its cgroup: a user service needs its user's manager restarted, a system one itself. */
export function restartFor(cgroup: string, uid: number): string | null {
  const path = cgroup.trim().split("\n").find((line) => line.startsWith("0::"))?.slice(3) ?? "";
  if (path.includes(`/user@${uid}.service/`)) return `sudo systemctl restart user@${uid}.service`;
  const unit = /\/system\.slice\/([^/]+\.service)$/.exec(path)?.[1];
  return unit ? `sudo systemctl restart ${unit}` : null;
}

export async function setupFacts(endpoint: DockerEndpoint | null, platform: NodeJS.Platform = process.platform): Promise<SetupFacts> {
  const { username, uid } = userInfo();
  let socketGroup: string | null = null;
  let inSocketGroup: boolean | null = null;
  if (endpoint && "path" in endpoint && platform !== "win32") {
    const gid = await stat(endpoint.path).then((found) => found.gid, () => null);
    if (gid !== null) {
      const groups = await readFile("/etc/group", "utf8").catch(() => "");
      socketGroup = groups.split("\n").find((line) => line.split(":")[2] === String(gid))?.split(":")[0] ?? String(gid);
      inSocketGroup = process.getgroups?.().includes(gid) ?? null;
    }
  }
  const cgroup = platform === "linux" ? await readFile("/proc/self/cgroup", "utf8").catch(() => "") : "";
  const kvm = platform !== "linux" ? "absent" : await access("/dev/kvm", constants.R_OK | constants.W_OK).then(() => "ok" as const, (error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? ("absent" as const) : ("denied" as const)));
  const disk = await statfs("/var/lib/docker").catch(() => statfs("/")).catch(() => null);
  return {
    hostname: hostname(),
    user: username,
    socketGroup,
    inSocketGroup,
    restart: restartFor(cgroup, uid),
    kvm,
    freeGb: disk ? Math.floor((disk.bavail * disk.bsize) / 1e9) : null,
  };
}

/** Connects to Docker's endpoint and closes at once: whether it is there to relay to, and if not, why and whether it refused BB's daemon. */
function reachable(endpoint: DockerEndpoint, dial: (wsl: WslDocker) => DialStdio, timeoutMs = 3_000): Promise<{ reason: string; refused: boolean } | null> {
  if ("wsl" in endpoint) return reachableWsl(endpoint.wsl, dial, timeoutMs);
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

function reachableWsl(wsl: WslDocker, dial: (wsl: WslDocker) => DialStdio, timeoutMs: number): Promise<{ reason: string; refused: boolean } | null> {
  return new Promise((resolve) => {
    let child: DialStdio;
    try {
      child = dial(wsl);
    } catch (error) {
      resolve({ reason: error instanceof Error ? error.message : String(error), refused: false });
      return;
    }
    const where = describe({ wsl });
    let stderr = "";
    let settled = false;
    const done = (failed: { reason: string; refused: boolean } | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(failed);
    };
    const timer = setTimeout(() => done({ reason: `docker system dial-stdio in ${where} did not answer within ${timeoutMs / 1000} s`, refused: false }), timeoutMs);
    child.stdout.on("data", () => done(null));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-400);
    });
    child.once("error", (error) => done({ reason: `wsl.exe: ${error.message}`, refused: false }));
    child.once("close", (code) => done({ reason: stderr.trim() || `docker system dial-stdio in ${where} exited ${code ?? "with a signal"}`, refused: false }));
    child.stdin.end(ATTACH_PING);
  });
}

function pipeDial(channel: Channel, child: DialStdio, where: string): void {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-400);
  });
  child.stdin.on("error", () => {});
  child.once("error", (error) => channel.destroy(new Error(`wsl.exe for ${where}: ${error.message}`)));
  channel.on("error", () => child.kill());
  channel.on("close", () => child.kill());
  child.stdout.pipe(channel, { end: false });
  channel.pipe(child.stdin);
  child.once("close", (code) => {
    if (channel.destroyed || channel.writableEnded) return;
    if (code === 0) channel.end();
    else channel.destroy(new Error(stderr.trim() || `docker system dial-stdio in ${where} exited ${code ?? "with a signal"}`));
  });
}

async function endpointAsked(dockerHost: string | undefined, fallback: RelayOptions["endpoint"]): Promise<DockerEndpoint> {
  const asked = dockerHost?.trim();
  if (asked) {
    const endpoint = endpointOf(asked);
    if (!endpoint) throw new Error(`The Docker host from bb-box is ${asked}, which the relay cannot reach: it takes unix://, npipe://, tcp:// or wsl://.`);
    return endpoint;
  }
  return (fallback ?? dockerEndpoint)();
}

export function relayHandlers(options: RelayOptions = {}) {
  const leases = new Set<ExperimentalHostWorkerLease>();
  const muxes = new Set<Mux>();
  const dialStdio = options.dial ?? wslDial;
  const forwarders = new Map<string, { readonly at: number; readonly result: Promise<string | null> }>();
  const forwarderAt = (endpoint: DockerEndpoint): Promise<string | null> => {
    if (!("host" in endpoint) || !isLocalhost(endpoint.host) || machinePlatform() !== "windows") return Promise.resolve(null);
    const address = `${endpoint.host}:${endpoint.port}`;
    const cached = forwarders.get(address);
    if (cached && Date.now() - cached.at < 5_000) return cached.result;
    const result = readAfterHalfClose(endpoint.port, endpoint.host, ATTACH_PING).then(
      (text) => (text.trim() ? null : forwarderReason(address)),
      () => null,
    );
    forwarders.set(address, { at: Date.now(), result });
    return result;
  };
  const joinSocket = (channel: Channel, endpoint: DockerEndpoint) => {
    const socket = connect({ ...endpoint, allowHalfOpen: true } as NetConnectOpts);
    socket.on("error", (error) => channel.destroy(new Error(refusal(endpoint, error) ?? `Docker at ${describe(endpoint)}: ${error.message}`)));
    channel.on("error", () => socket.destroy());
    socket.pipe(channel).pipe(socket);
  };
  const join = (channel: Channel, endpoint: DockerEndpoint) => {
    const start = () => {
      if ("wsl" in endpoint) {
        let child: DialStdio;
        try {
          child = dialStdio(endpoint.wsl);
        } catch (error) {
          channel.destroy(new Error(error instanceof Error ? error.message : String(error)));
          return;
        }
        pipeDial(channel, child, describe(endpoint));
        return;
      }
      joinSocket(channel, endpoint);
    };
    if (!("host" in endpoint) || !isLocalhost(endpoint.host) || machinePlatform() !== "windows") {
      start();
      return;
    }
    void forwarderAt(endpoint).then((dropped) => {
      if (dropped) channel.destroy(new Error(dropped));
      else start();
    });
  };
  return {
    handlers: {
      docker: async ({ dockerHost }: { dockerHost?: string } = {}) => {
        let endpoint: DockerEndpoint;
        try {
          endpoint = await endpointAsked(dockerHost, options.endpoint);
        } catch (error) {
          return { endpoint: "", found: false, reason: error instanceof Error ? error.message : String(error), platform: machinePlatform(), setup: await setupFacts(null) };
        }
        const failed = await reachable(endpoint, dialStdio);
        if (failed === null) {
          const dropped = await forwarderAt(endpoint);
          if (dropped) return { endpoint: describe(endpoint), found: true, reason: dropped, attached: false, platform: machinePlatform(), setup: await setupFacts(endpoint) };
        }
        return { endpoint: describe(endpoint), found: failed === null, reason: failed?.reason ?? null, ...(failed?.refused ? { refused: true } : {}), platform: machinePlatform(), setup: await setupFacts(endpoint) };
      },
      relay: async ({ secret, path, dockerHost }: { secret: string; path: string; dockerHost?: string }, context: ExperimentalHostRpcContext) => {
        const endpoint = await endpointAsked(dockerHost, options.endpoint);
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
