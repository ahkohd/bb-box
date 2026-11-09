import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DockerCli } from "../docker/cli.ts";
import { containerName, dockerKinds, DockerBackend, type DockerBackendOptions } from "../docker/backend.ts";
import { DOCKER_KEYS, parseDockerPart, type DockerConfig } from "../docker/config.ts";
import { scopedStorage } from "../index.ts";
import type { Ssh } from "../../transports/ssh.ts";
import type { SshAccess } from "../../transports/types.ts";
import type { AcquireHooks, BackendContext, BoxIdentity, BoxKind, MachineSize, Guest } from "../types.ts";
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
    const part = new DockerBackend({ ...this.#config, host, machine: null }, context, {
      ...this.#deps.dockerOptions,
      ...(wrappers ? { ssh: wrappers.ssh } : {}),
      cliReachingAHostAnotherBackendMade: cli,
    });
    this.#parts.set(instance, part);
    return part;
  }

  forget(instance: string): void {
    this.#parts.delete(instance);
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
