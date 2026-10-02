// The docker CLI on BB's server, which the Docker backend runs for every
// call to the Docker host. The CLI speaks to the local socket and to an
// ssh:// host alike, and its `docker exec` is a plain command line, which
// the command transport and the desktop's route use (031).

import { spawn } from "node:child_process";
import { Capture } from "../../transports/process.ts";
import { abortable } from "../../core/abortable.ts";

export interface DockerResult {
  /** Null when the CLI was killed. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** What the CLI prints when it cannot reach the Docker daemon. */
const UNREACHABLE = /Cannot connect to the Docker daemon|error during connect|failed to connect to the docker API|Is the docker daemon running/i;
/** What the daemon says of a container, or a name, that does not exist. */
export const NO_SUCH = /No such (container|object|image)/i;

export { abortable };

export class DockerError extends Error {
  /** The CLI could not reach the daemon, so nothing was done. */
  readonly unreachable: boolean;
  constructor(message: string, unreachable = false) {
    super(message);
    this.name = "DockerError";
    this.unreachable = unreachable;
  }
}

/** The bb-box labels on a box's container, from its first write. */
export const LABELS = {
  backend: "bbbox.backend",
  install: "bbbox.install",
  box: "bbbox.box",
  thread: "bbbox.thread",
  name: "bbbox.name",
  kind: "bbbox.kind",
  created: "bbbox.created",
  /** The CDI device of a GPU desktop. */
  gpu: "bbbox.gpu",
  /** On an image setup/docker/build.sh made: its layout version. */
  imageVersion: "bbbox.image-version",
  /** On an image setup/docker/build.sh made: the digest of BB's app in it, or empty for none. */
  bbApp: "bbbox.bb-app",
} as const;

export interface DockerInfo {
  readonly name: string;
  readonly version: string;
  /** For example "Ubuntu 24.04.3 LTS" or "Docker Desktop". */
  readonly operatingSystem: string;
  readonly osType: string;
  /** The daemon's kernel, which says "microsoft" under WSL2. */
  readonly kernelVersion: string;
  readonly arch: string;
  readonly cpus: number;
  readonly memoryMiB: number;
  readonly rootless: boolean;
  /** NVIDIA GPUs the daemon lists as CDI devices, one name each, such as nvidia.com/gpu=0. */
  readonly gpus: readonly string[];
}

export interface ContainerInfo {
  readonly id: string;
  /** Without Docker's leading "/". */
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
  /** created, running, paused, restarting, removing, exited or dead. */
  readonly status: string;
  readonly exitCode: number | null;
  /** From the container's limits; null without one. */
  readonly cores: number | null;
  readonly memoryMiB: number | null;
  /** Its address on each network. */
  readonly addresses: Readonly<Record<string, string>>;
}

const MiB = 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function strings(value: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record(value))) if (typeof entry === "string") result[key] = entry;
  return result;
}

/**
 * The GPUs among the daemon's CDI devices, one name each. nvidia-ctk names
 * each GPU by index, by UUID or both; UUIDs stay the same across reboots, so
 * they are used when there are any. "all" is not one GPU.
 */
export function gpusOf(devices: unknown): string[] {
  const ids = (Array.isArray(devices) ? devices : [])
    .map((device) => record(device))
    .filter((device) => device.Source === "cdi" && typeof device.ID === "string")
    .map((device) => device.ID as string)
    .filter((id) => /^nvidia\.com\/gpu=/.test(id) && id !== "nvidia.com/gpu=all");
  const uuids = ids.filter((id) => /=GPU-[0-9a-f-]+$/i.test(id));
  return (uuids.length ? uuids : ids).sort();
}

export function parseInfo(text: string): DockerInfo {
  const info = record(JSON.parse(text));
  const security = Array.isArray(info.SecurityOptions) ? info.SecurityOptions.map(String) : [];
  return {
    name: typeof info.Name === "string" ? info.Name : "",
    version: typeof info.ServerVersion === "string" ? info.ServerVersion : "",
    operatingSystem: typeof info.OperatingSystem === "string" ? info.OperatingSystem : "",
    osType: typeof info.OSType === "string" ? info.OSType : "",
    kernelVersion: typeof info.KernelVersion === "string" ? info.KernelVersion : "",
    arch: typeof info.Architecture === "string" ? info.Architecture : "",
    cpus: Number(info.NCPU) || 0,
    memoryMiB: Math.floor((Number(info.MemTotal) || 0) / MiB),
    rootless: security.some((option) => option.includes("name=rootless")),
    gpus: gpusOf(info.DiscoveredDevices),
  };
}

export function parseContainers(text: string): ContainerInfo[] {
  const list: unknown = text.trim() ? JSON.parse(text) : [];
  return (Array.isArray(list) ? list : []).map((entry) => {
    const container = record(entry);
    const state = record(container.State);
    const host = record(container.HostConfig);
    const networks = record(record(container.NetworkSettings).Networks);
    const addresses: Record<string, string> = {};
    for (const [network, settings] of Object.entries(networks)) {
      const address = record(settings).IPAddress;
      if (typeof address === "string" && address) addresses[network] = address;
    }
    const nanoCpus = Number(host.NanoCpus) || 0;
    const memory = Number(host.Memory) || 0;
    return {
      id: String(container.Id ?? ""),
      name: String(container.Name ?? "").replace(/^\//, ""),
      labels: strings(record(container.Config).Labels),
      status: typeof state.Status === "string" ? state.Status : "",
      exitCode: typeof state.ExitCode === "number" ? state.ExitCode : null,
      cores: nanoCpus ? Math.round((nanoCpus / 1e9) * 100) / 100 : null,
      memoryMiB: memory ? Math.round(memory / MiB) : null,
      addresses,
    };
  });
}

export interface RunOptions {
  readonly stdin?: string;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export class DockerCli {
  readonly #binary: string;
  /** The -H address, or null for the CLI's own default. */
  readonly host: string | null;

  /** Run before each command that reaches the daemon, as when the host is a BB machine's relay (042). */
  readonly #prepare: (() => Promise<void>) | null;

  constructor(host: string | null, binary = "docker", prepare: (() => Promise<void>) | null = null) {
    this.host = host;
    this.#binary = binary;
    this.#prepare = prepare;
  }

  /**
   * Makes the host ready to use, as the transport needs before its first
   * command. Throws a DockerError when it cannot, and stops waiting when
   * `signal` aborts, as when the plugin stops, since BB may not answer then.
   */
  async prepare(signal?: AbortSignal): Promise<void> {
    if (!this.#prepare) return;
    try {
      await abortable(this.#prepare(), signal);
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      throw new DockerError(error instanceof Error ? error.message : String(error), true);
    }
  }

  /** The command line for `docker <args>` on this host. */
  argv(args: readonly string[]): [string, ...string[]] {
    return [this.#binary, ...(this.host ? ["-H", this.host] : []), ...args];
  }

  async run(args: readonly string[], options: RunOptions = {}): Promise<DockerResult> {
    // The CLI's own version needs no daemon.
    if (args[0] !== "--version") await this.prepare(options.signal);
    return this.#spawn(args, options);
  }

  #spawn(args: readonly string[], options: RunOptions): Promise<DockerResult> {
    const [binary, ...rest] = this.argv(args);
    const stdout = new Capture(8 * MiB);
    const stderr = new Capture(64 * 1024);
    return new Promise((resolve, reject) => {
      options.signal?.throwIfAborted();
      const child = spawn(binary, rest, { stdio: ["pipe", "pipe", "pipe"] });
      let timedOut = false;
      const kill = () => child.kill("SIGKILL");
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs ?? 60_000);
      options.signal?.addEventListener("abort", kill, { once: true });
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", kill);
      };
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.stdin.on("error", () => {
        // The CLI may exit before it reads all of stdin.
      });
      child.once("error", (error) => {
        done();
        reject(new DockerError(`Cannot run ${binary}: ${error.message}`));
      });
      child.once("close", (code) => {
        done();
        if (options.signal?.aborted && !timedOut) return reject(options.signal.reason);
        resolve({ exitCode: code, stdout: stdout.text(), stderr: stderr.text(), timedOut });
      });
      child.stdin.end(options.stdin ?? "");
    });
  }

  /** Runs `docker <args>` and returns its output, or throws a DockerError that says what failed. */
  async ok(args: readonly string[], options: RunOptions = {}): Promise<string> {
    const result = await this.run(args, options);
    if (result.exitCode === 0) return result.stdout;
    // A management command, such as `docker container ls`, by its first two words.
    throw this.error(`docker ${args.slice(0, ["container", "image", "network"].includes(args[0]!) ? 2 : 1).join(" ")}`, result);
  }

  error(action: string, result: DockerResult): DockerError {
    if (result.timedOut) return new DockerError(`${action} did not finish in time.`);
    const said = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600);
    return new DockerError(`${action} failed: ${said || `exit code ${result.exitCode}`}`, UNREACHABLE.test(said));
  }

  async info(signal?: AbortSignal): Promise<DockerInfo> {
    return parseInfo(await this.ok(["info", "--format", "{{json .}}"], { timeoutMs: 30_000, signal }));
  }

  /** The containers among `refs` that exist. */
  async inspect(refs: readonly string[], signal?: AbortSignal): Promise<ContainerInfo[]> {
    if (!refs.length) return [];
    const result = await this.run(["container", "inspect", ...refs], { timeoutMs: 30_000, signal });
    // A missing container fails the command, but the others are still printed.
    if (result.exitCode !== 0 && !(NO_SUCH.test(result.stderr) && !UNREACHABLE.test(result.stderr))) {
      throw this.error("docker container inspect", result);
    }
    return parseContainers(result.stdout);
  }

  /** Every container with all of `labels`, running or not. */
  async list(labels: Readonly<Record<string, string>>, signal?: AbortSignal): Promise<ContainerInfo[]> {
    const filters = Object.entries(labels).flatMap(([key, value]) => ["--filter", `label=${key}=${value}`]);
    const ids = (await this.ok(["container", "ls", "--all", "--quiet", "--no-trunc", ...filters], { timeoutMs: 30_000, signal }))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return this.inspect(ids, signal);
  }
}
