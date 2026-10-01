// BB machines that can host Docker boxes (042), for BB Box's settings: each
// connected, persistent machine bb-box did not make, with Docker as it
// answers through bb-box's relay, and the Docker backend the configuration
// has for it.
//
// Looking leaves the machine as it was. A machine BB shows offline is not
// called. Otherwise one host call asks whether Docker is there, holding no
// lease and starting nothing; only where it is does the list open the relay,
// and then it only reads: docker info, nothing pulled or started. That relay
// closes on its idle timer unless a box uses it, and with it the worker's
// lease. The operator turns each on: that adds a Docker backend whose
// host is bb:<machine ID>, last in acquire order; off removes it, or, while
// it still has boxes, turns it off so it takes no new ones.

import type { BackendConfig, ConfigDocument } from "../core/document.ts";
import type { DockerInfo } from "../backends/docker/cli.ts";
import type { ImageBuild } from "./docker-images.ts";

/** BB's machines as the settings list reads them. */
export interface MachineRecord {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly type: string;
  readonly machineProviderId: string | null;
  readonly lifecycle: { readonly phase: string };
  /** When BB last heard from the machine, in ms since the epoch. */
  readonly lastSeenAt?: number | null;
}

export interface DockerHostView {
  readonly hostId: string;
  readonly name: string;
  readonly connected: boolean;
  /** Docker on the machine, through the relay, or null when it did not answer. */
  readonly docker: { readonly version: string; readonly os: string; readonly arch: string; readonly cpus: number; readonly memoryMiB: number } | null;
  /** Why Docker did not answer, or why the machine cannot host boxes. Null when it has none (`absent`), which is normal, not a fault. */
  readonly problem: string | null;
  /** The machine has no Docker to reach, so it is not a host: nothing to fix, nothing to say in red. */
  readonly absent: boolean;
  /** The Docker backend the configuration has for this machine. */
  readonly backend: { readonly id: string; readonly enabled: boolean; readonly boxes: number } | null;
  /** Its last image build, or the one running (src/plugin/docker-images.ts). */
  readonly images: ImageBuild | null;
}

/**
 * How long BB may go without hearing from a machine it shows connected
 * before bb-box takes it as offline. BB hears from each about every 5 s, but
 * showed a PC that restarted, which said nothing as it went, connected until
 * it was back (#233).
 */
export const SILENT_MS = 60_000;

/**
 * Why the machine cannot be reached now, as the end of a sentence about it,
 * or null when BB shows it connected and has heard from it lately.
 */
export function machineOffline(machine: Pick<MachineRecord, "status" | "lastSeenAt">, now: number): string | null {
  if (machine.status !== "connected") return "is offline in BB.";
  const silent = machine.lastSeenAt == null ? 0 : now - machine.lastSeenAt;
  if (silent <= SILENT_MS) return null;
  const minutes = Math.max(1, Math.round(silent / 60_000));
  return `is offline: BB has not heard from it for ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`;
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
  /** Whether Docker is on the machine, from the host entry with no lease and no relay; the reason when it is not. */
  found(hostId: string, signal: AbortSignal): Promise<string | null>;
  /** Docker's facts on the machine, through the relay: docker info, which only reads. */
  docker(hostId: string, signal: AbortSignal): Promise<DockerInfo>;
  /** Boxes bb-box holds on each backend, by backend ID. */
  boxes(): Promise<ReadonlyMap<string, number>>;
  /** The machine's last image build, or the one running. */
  images?(hostId: string): ImageBuild | null;
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
  readonly #checked = new Map<string, { at: number; docker: DockerHostView["docker"]; problem: string | null; absent: boolean }>();

  constructor(deps: DockerHostsDeps) {
    this.#deps = deps;
  }

  async list(): Promise<DockerHostView[]> {
    const document = this.#deps.document();
    const [machines, boxes] = await Promise.all([this.#deps.machines(), this.#deps.boxes()]);
    const listed = machineHosts(machines, document, this.#deps.providers);
    return Promise.all(
      listed.map(async (machine): Promise<DockerHostView> => {
        const offline = machineOffline(machine, this.#deps.now?.() ?? Date.now());
        const connected = offline === null;
        const backend = backendOn(document, machine.id);
        const checked = connected ? await this.#check(machine.id) : { docker: null, problem: `The machine ${offline}`, absent: false };
        return {
          hostId: machine.id,
          name: machine.name,
          connected,
          docker: checked.docker,
          problem: checked.problem,
          absent: checked.absent,
          backend: backend ? { id: backend.id, enabled: backend.enabled, boxes: boxes.get(backend.id) ?? 0 } : null,
          images: this.#deps.images?.(machine.id) ?? null,
        };
      }),
    );
  }

  /** Forgets what Docker said on a machine, as when it is turned on and checked again. */
  forget(hostId: string): void {
    this.#checked.delete(hostId);
  }

  async #check(hostId: string): Promise<{ docker: DockerHostView["docker"]; problem: string | null; absent: boolean }> {
    const now = this.#deps.now?.() ?? Date.now();
    const known = this.#checked.get(hostId);
    if (known && now - known.at < (this.#deps.freshMs ?? FRESH_MS)) return known;
    let result: { docker: DockerHostView["docker"]; problem: string | null; absent: boolean };
    try {
      const signal = AbortSignal.timeout(this.#deps.timeoutMs ?? CHECK_MS);
      const missing = await this.#deps.found(hostId, signal);
      if (missing !== null) {
        // No Docker on the machine: normal for most machines, so no problem to show.
        result = { docker: null, problem: null, absent: true };
      } else {
        const info = await this.#deps.docker(hostId, signal);
        result =
          info.osType && info.osType !== "linux"
            ? { docker: null, problem: `Docker there runs ${info.osType} containers. Switch it to Linux containers.`, absent: false }
            : { docker: { version: info.version, os: info.operatingSystem, arch: info.arch, cpus: info.cpus, memoryMiB: info.memoryMiB }, problem: null, absent: false };
      }
    } catch (error) {
      result = { docker: null, problem: `Docker did not answer: ${message(error)}`, absent: false };
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
