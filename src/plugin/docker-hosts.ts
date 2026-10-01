// BB machines that can host Docker boxes (042), for BB Box's settings: each
// connected, persistent machine bb-box did not make, with Docker as it
// answers through bb-box's relay, and the Docker backend the configuration
// has for it. The operator turns each on: that adds a Docker backend whose
// host is bb:<machine ID>, last in acquire order; off removes it, or, while
// it still has boxes, turns it off so it takes no new ones.

import type { BackendConfig, ConfigDocument } from "../core/document.ts";
import type { DockerInfo } from "../backends/docker/cli.ts";

/** BB's machines as the settings list reads them. */
export interface MachineRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly type: string;
  readonly machineProviderId: string | null;
  readonly lifecycle: { readonly phase: string };
}

export interface DockerHostView {
  readonly hostId: string;
  readonly name: string;
  readonly connected: boolean;
  /** Docker on the machine, through the relay, or null when it did not answer. */
  readonly docker: { readonly version: string; readonly os: string; readonly arch: string; readonly cpus: number; readonly memoryMiB: number } | null;
  /** Why Docker did not answer, or why the machine cannot host boxes. */
  readonly problem: string | null;
  /** The Docker backend the configuration has for this machine. */
  readonly backend: { readonly id: string; readonly enabled: boolean; readonly boxes: number } | null;
}

/** The host field of a Docker backend on BB machine `hostId`. */
export function machineHost(hostId: string): string {
  return `bb:${hostId}`;
}

/** The Docker backend on BB machine `hostId`, if the configuration has one. */
export function backendOn(document: ConfigDocument, hostId: string): BackendConfig | null {
  return document.backends.find((backend) => backend.type === "docker" && backend.fields.host === machineHost(hostId)) ?? null;
}

/**
 * Machines that may host boxes: persistent and not being removed, and not
 * made by bb-box's providers, since its own boxes, spares and your machines
 * are BB machines with Docker too (041). One the configuration already uses
 * stays listed whatever its state, so it can be turned off.
 */
export function machineHosts(machines: readonly MachineRecord[], document: ConfigDocument, providers: readonly string[]): MachineRecord[] {
  return machines.filter((machine) => {
    if (backendOn(document, machine.id)) return true;
    if (machine.type !== "persistent" || machine.lifecycle.phase !== "active") return false;
    return !(machine.machineProviderId && providers.includes(machine.machineProviderId));
  });
}

export interface DockerHostsDeps {
  machines(): Promise<readonly MachineRecord[]>;
  document(): ConfigDocument;
  /** bb-box's machine providers, whose machines are its own boxes. */
  readonly providers: readonly string[];
  /** Docker's facts on the machine, through the relay. */
  docker(hostId: string, signal: AbortSignal): Promise<DockerInfo>;
  /** Boxes bb-box holds on each backend, by backend ID. */
  boxes(): Promise<ReadonlyMap<string, number>>;
  readonly timeoutMs?: number;
  /** How long Docker's facts on a machine are kept, so the page does not open every relay each time. */
  readonly freshMs?: number;
  now?(): number;
}

/** How long a machine's Docker may take to answer the list. */
const CHECK_MS = 10_000;
const FRESH_MS = 60_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DockerHosts {
  readonly #deps: DockerHostsDeps;
  readonly #checked = new Map<string, { at: number; docker: DockerHostView["docker"]; problem: string | null }>();

  constructor(deps: DockerHostsDeps) {
    this.#deps = deps;
  }

  async list(): Promise<DockerHostView[]> {
    const document = this.#deps.document();
    const [machines, boxes] = await Promise.all([this.#deps.machines(), this.#deps.boxes()]);
    const listed = machineHosts(machines, document, this.#deps.providers);
    return Promise.all(
      listed.map(async (machine): Promise<DockerHostView> => {
        const connected = machine.status === "connected";
        const backend = backendOn(document, machine.id);
        const checked = connected ? await this.#check(machine.id) : { docker: null, problem: "The machine is offline in BB." };
        return {
          hostId: machine.id,
          name: machine.name,
          connected,
          docker: checked.docker,
          problem: checked.problem,
          backend: backend ? { id: backend.id, enabled: backend.enabled, boxes: boxes.get(backend.id) ?? 0 } : null,
        };
      }),
    );
  }

  /** Forgets what Docker said on a machine, as when it is turned on and checked again. */
  forget(hostId: string): void {
    this.#checked.delete(hostId);
  }

  async #check(hostId: string): Promise<{ docker: DockerHostView["docker"]; problem: string | null }> {
    const now = this.#deps.now?.() ?? Date.now();
    const known = this.#checked.get(hostId);
    if (known && now - known.at < (this.#deps.freshMs ?? FRESH_MS)) return known;
    let result: { docker: DockerHostView["docker"]; problem: string | null };
    try {
      const info = await this.#deps.docker(hostId, AbortSignal.timeout(this.#deps.timeoutMs ?? CHECK_MS));
      result =
        info.osType && info.osType !== "linux"
          ? { docker: null, problem: `Docker there runs ${info.osType} containers. Switch it to Linux containers.` }
          : { docker: { version: info.version, os: info.operatingSystem, arch: info.arch, cpus: info.cpus, memoryMiB: info.memoryMiB }, problem: null };
    } catch (error) {
      result = { docker: null, problem: `Docker did not answer: ${message(error)}` };
    }
    this.#checked.set(hostId, { at: now, ...result });
    return result;
  }
}

/**
 * The document with machine `machine` on or off as a Docker host. On adds
 * a Docker backend, last in acquire order, named after the machine; its boxes
 * are privileged containers, root on the machine, as on any Docker host
 * (041). Off removes it, or turns it off while it still has boxes.
 */
export function withDockerHost(document: ConfigDocument, machine: { readonly id: string; readonly name: string }, on: boolean, boxes: number): ConfigDocument {
  const existing = backendOn(document, machine.id);
  if (on) {
    if (existing) return { ...document, backends: document.backends.map((backend) => (backend === existing ? { ...backend, enabled: true } : backend)) };
    const taken = new Set(document.backends.map((backend) => backend.id));
    const base = `docker:${machine.name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "machine"}`;
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    const backend: BackendConfig = { id, type: "docker", label: `Docker on ${machine.name}`.slice(0, 64), enabled: true, fields: { host: machineHost(machine.id), privileged: true } };
    return { ...document, backends: [...document.backends, backend] };
  }
  if (!existing) return document;
  if (boxes > 0) return { ...document, backends: document.backends.map((backend) => (backend === existing ? { ...backend, enabled: false } : backend)) };
  return { ...document, backends: document.backends.filter((backend) => backend !== existing) };
}
