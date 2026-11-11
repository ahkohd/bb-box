import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerCli } from "../docker/cli.ts";
import { containerName, dockerKinds, DockerBackend, type DockerBackendOptions } from "../docker/backend.ts";
import { DOCKER_KEYS, parseDockerPart, type DockerConfig } from "../docker/config.ts";
import { scopedStorage } from "../index.ts";
import type { Ssh } from "../../transports/ssh.ts";
import type { SshAccess } from "../../transports/types.ts";
import type { AcquireHooks, BackendContext, BoxIdentity, BoxKind, MachineSize, Guest, SnapshotPlan, Snapshotting } from "../types.ts";
import { dockerOffer } from "../docker/snapshots.ts";
import { LINUX_IMAGE_TARGETS, type LinuxImageKind, type LinuxImages } from "./linux-images.ts";
import { PRODUCT } from "../../brand.ts";

export const LINUX_KINDS = Object.keys(LINUX_IMAGE_TARGETS) as LinuxImageKind[];
const LINUX_CORES = [1, 2, 4, 8, 10, 12, 16, 32];
const LINUX_MEMORY_GB = [2, 4, 8, 16, 32, 56];
const MIB_PER_GB = 1024;
const LOCAL_IMAGE: Readonly<Record<LinuxImageKind, string>> = {
  linux: "bbbox/linux:1",
  "linux-desktop-cpu": "bbbox/linux-desktop:1",
  "linux-desktop-wayland-cpu": "bbbox/linux-desktop-wayland:1",
};
const PULL_TIMEOUT_MS = 15 * 60_000;
export const CONTAINER_MEMORY_MARGIN_MIB = 512;
export const NAMESPACE_KEEP_OFF = "a box's snapshots stay on its Namespace machine and end with it, at the box's release or at the machine's deadline";
export const NAMESPACE_FORK_OFF = `a fork needs a Namespace machine of its own, and ${PRODUCT} cannot carry a snapshot from one machine to another yet`;
const SNAPSHOTS_TAKEN_ON = "snapshots-taken-on:";
const TAKE_ENDS_BEFORE_DEADLINE_MS = 2 * 60_000;

export function namespaceOffer(): Snapshotting {
  return { ...dockerOffer(NAMESPACE_KEEP_OFF), lives: "host", fork: "none", forkWhy: NAMESPACE_FORK_OFF };
}

export function snapshotStorageOnMachine(endsAt: number | null): string {
  return endsAt === null ? "Docker's disk on the box's Namespace machine" : `Docker's disk on the box's Namespace machine, which ends at ${clock(endsAt)} with its snapshots`;
}

export function deadlineRefusal(endsAt: number | null, now: number, aboutMs: number, what: "snapshot" | "restore"): string | null {
  if (endsAt === null || now + aboutMs + TAKE_ENDS_BEFORE_DEADLINE_MS < endsAt) return null;
  const done = what === "snapshot" ? "this snapshot would be ready" : "this restore would finish";
  return `The box's Namespace machine ends at ${clock(endsAt)}, the plan's longest life, before ${done}, and its snapshots end with it. Make a new box to go on working`;
}

export function withMachineDeadline(plan: SnapshotPlan, endsAt: number | null, now: number): SnapshotPlan {
  const storage = { ...plan.storage, name: snapshotStorageOnMachine(endsAt) };
  const takeWhy = plan.take.ok ? deadlineRefusal(endsAt, now, plan.take.aboutMs, "snapshot") : null;
  const restoreWhy = plan.restore.way === "none" ? null : deadlineRefusal(endsAt, now, plan.restore.undoAboutMs, "restore");
  return {
    ...plan,
    storage,
    take: takeWhy ? { ...plan.take, ok: false, why: takeWhy } : plan.take,
    restore: restoreWhy ? { ...plan.restore, way: "none", why: restoreWhy, undo: "none" } : plan.restore,
    fork: { ...plan.fork, ok: false, why: NAMESPACE_FORK_OFF },
  };
}

function clock(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

export function instancePartOptions(given: DockerBackendOptions | undefined, cli: DockerCli, ssh: string | null): DockerBackendOptions {
  return { ...given, ...(ssh ? { ssh } : {}), cliReachingAHostAnotherBackendMade: cli, keepOffBecause: NAMESPACE_KEEP_OFF };
}

function commandPath(name: string): string {
  if (name.includes("/")) return name;
  return execFileSync("sh", ["-c", 'command -v "$1"', "sh", name], { encoding: "utf8" }).trim() || name;
}

export function isLinuxKind(kind: string): kind is LinuxImageKind {
  return (LINUX_KINDS as readonly string[]).includes(kind);
}

export function linuxShapeFor(size: MachineSize): { readonly cores: number; readonly memoryGB: number } | null {
  const cores = LINUX_CORES.find((each) => each >= size.cores);
  const memoryGB = LINUX_MEMORY_GB.find((each) => each * MIB_PER_GB >= size.memoryMiB);
  return cores === undefined || memoryGB === undefined ? null : { cores, memoryGB };
}

export function linuxDockerConfig(): DockerConfig {
  const parsed = parseDockerPart({ id: "namespace-linux", hosts: [], fields: { [DOCKER_KEYS.host]: "", [DOCKER_KEYS.gpus]: false, [DOCKER_KEYS.reserveMemoryMiB]: 0 } });
  if (!parsed.ok) throw new Error(`${PRODUCT}'s Docker settings for Namespace's Linux boxes are wrong: ${parsed.problems.map((each) => each.message).join("; ")}`);
  return parsed.config;
}

export function pullScript(ref: string, local: string): string {
  const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
  return ["set -eu", "[ ! -e /dev/kvm ] || chmod 0666 /dev/kvm", `docker pull -q ${quote(ref)} >/dev/null`, `docker tag ${quote(ref)} ${quote(local)}`].join("\n");
}

export interface NamespaceLinuxDeps {
  readonly context: BackendContext;
  readonly images: LinuxImages;
  readonly keys: () => Promise<{ ssh: Ssh }>;
  readonly access: (instance: string) => SshAccess;
  readonly run: (instance: string, script: string, timeoutMs: number, signal?: AbortSignal) => Promise<{ exitCode: number | null; stderr: string }>;
  readonly shareDir: () => Promise<string>;
  readonly dockerOptions?: DockerBackendOptions;
  readonly dockerCli?: (instance: string) => DockerCli;
  readonly pullScript?: (ref: string, local: string) => string;
}

export class NamespaceLinux {
  readonly #deps: NamespaceLinuxDeps;
  readonly #config = linuxDockerConfig();
  readonly #parts = new Map<string, DockerBackend>();
  #wrappers: Promise<{ docker: string; ssh: string }> | null = null;

  constructor(deps: NamespaceLinuxDeps) {
    this.#deps = deps;
  }

  kinds(readyTimeoutMs: number): BoxKind[] {
    return dockerKinds(this.#config)
      .filter((kind) => isLinuxKind(kind.id))
      .map((kind) => ({ ...kind, description: `${kind.description} On a Linux machine of its own on Namespace, which lasts at most the workspace plan's longest life.`, readyTimeoutMs }))
      .map((kind) => (kind.id === "linux" && this.#config.docker ? { ...kind, capabilities: { ...kind.capabilities, features: [...kind.capabilities.features, "kvm"] } } : kind));
  }

  ref(boxId: string): string {
    return containerName(boxId);
  }

  async boxOn(instance: string, machineMemoryMiB: number, box: BoxIdentity, kind: LinuxImageKind, hooks: AcquireHooks, own: (guest: Guest) => Guest, step: <T>(name: string, run: () => Promise<T>) => Promise<T>, signal: AbortSignal): Promise<Guest> {
    const image = await step("image", () => this.#deps.images.forBox(LINUX_IMAGE_TARGETS[kind], signal, async (words) => hooks.waiting?.(words)));
    await step("pull", async () => {
      const pulled = await this.#deps.run(instance, (this.#deps.pullScript ?? pullScript)(image.ref, LOCAL_IMAGE[kind]), PULL_TIMEOUT_MS, signal);
      if (pulled.exitCode !== 0) throw new Error(`Namespace's machine ${instance} could not pull ${image.ref}: ${pulled.stderr.trim().slice(-300) || `exit ${pulled.exitCode}`}`);
    });
    const part = await this.part(instance);
    const container: BoxIdentity = { ...box, size: { ...box.size, memoryMiB: Math.min(box.size.memoryMiB, machineMemoryMiB - CONTAINER_MEMORY_MARGIN_MIB) } };
    return own(await part.acquire(container, null, { ...hooks, claim: (guest) => hooks.claim(own(guest)), starting: async () => {} }, signal));
  }

  async part(instance: string): Promise<DockerBackend> {
    const known = this.#parts.get(instance);
    if (known) return known;
    const context: BackendContext = {
      ...this.#deps.context,
      id: `${this.#deps.context.id}/${instance}`,
      storage: scopedStorage(this.#deps.context.storage, `docker/${instance}/`),
      machines: undefined,
    };
    const host = `ssh://${this.#deps.access(instance).user}@${this.#deps.access(instance).host}`;
    const wrappers = this.#deps.dockerCli ? null : await this.#wrapperPaths();
    const cli = this.#deps.dockerCli ? this.#deps.dockerCli(instance) : new DockerCli(host, wrappers!.docker);
    const part = new DockerBackend({ ...this.#config, host, machine: null }, context, instancePartOptions(this.#deps.dockerOptions, cli, wrappers?.ssh ?? null));
    this.#parts.set(instance, part);
    return part;
  }

  async forget(instance: string): Promise<void> {
    this.#parts.delete(instance);
    await this.#deps.context.storage.delete(SNAPSHOTS_TAKEN_ON + instance);
  }

  async markSnapshotsOn(instance: string): Promise<void> {
    await this.#deps.context.storage.set(SNAPSHOTS_TAKEN_ON + instance, true);
  }

  async snapshotsTakenOn(instance: string): Promise<boolean> {
    return (await this.#deps.context.storage.get(SNAPSHOTS_TAKEN_ON + instance)) === true;
  }

  async machinesWithSnapshots(): Promise<readonly string[]> {
    return (await this.#deps.context.storage.list(SNAPSHOTS_TAKEN_ON)).map((key) => key.slice(SNAPSHOTS_TAKEN_ON.length));
  }

  #wrapperPaths(): Promise<{ docker: string; ssh: string }> {
    this.#wrappers ??= (async () => {
      const dir = join(await this.#deps.shareDir(), "ssh-bin");
      await mkdir(dir, { recursive: true });
      const { ssh } = await this.#deps.keys();
      const realSsh = commandPath(ssh.binary);
      const realDocker = commandPath(this.#deps.dockerOptions?.binary ?? "docker");
      const shared = ["-o", "ControlMaster=auto", "-o", `ControlPath=${await this.#deps.shareDir()}/d-%C`, "-o", "ControlPersist=120"];
      const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`;
      const options = ssh.options(this.#deps.access("x")).filter((_part, index, all) => all[index] !== "-p" && all[index - 1] !== "-p");
      const sshPath = join(dir, "ssh");
      const dockerPath = join(await this.#deps.shareDir(), "docker");
      await writeFile(sshPath, `#!/bin/sh\nexec ${[realSsh, ...options, ...shared].map(quote).join(" ")} "$@"\n`);
      await writeFile(dockerPath, `#!/bin/sh\nPATH=${quote(dir)}:"$PATH" exec ${quote(realDocker)} "$@"\n`);
      await chmod(sshPath, 0o755);
      await chmod(dockerPath, 0o755);
      return { docker: dockerPath, ssh: sshPath };
    })();
    return this.#wrappers;
  }
}
