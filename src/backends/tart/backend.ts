// The Tart backend: macOS boxes as VMs on Macs with Apple silicon, made by
// Tart on Apple's Virtualization framework. bb-box reaches each Mac over SSH
// as its host user and runs `tart` there (see host.ts). VMs sit on the Mac's
// own NAT, so bb-box reaches them through the Mac: commands over SSH with the
// Mac as the jump host, and the desktop through Tart's VNC server, which
// listens on the Mac's loopback.
//
// - Acquire: the box's VM is named bb-box-<box ID>, so it is claimed before
//   anything is made. Its owner file goes first, then the clone (copy on
//   write on APFS), then `tart run` detached from SSH, then its address from
//   the Mac's DHCP leases, then SSH through the Mac.
// - Capacity: per Mac, at most two running macOS VMs, which Apple's licence
//   and the Virtualization framework allow, counting every VM Tart runs
//   there; memory, less a reserve and the running VMs'; free disk.
// - Stop suspends the VM, which frees its memory and its slot, and start
//   resumes it with a new VNC port and password.
// - A VM's address can change when it starts again, so bb-box asks the Mac
//   for it when it does not know it, and forgets it when the VM stops.

import { performance } from "node:perf_hooks";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import { TransportError, type Display, type RunResult, type SshAccess } from "../../transports/types.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type ComputerUse,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type HostCapacity,
  type Limit,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { TART_KINDS, type TartConfig, type TartHost, type TartKind } from "./config.ts";
import {
  claimScript,
  cloneScript,
  deleteScript,
  ipScript,
  ownerText,
  parseConfig,
  parseFields,
  parseState,
  parseVnc,
  powerScript,
  startScript,
  stateScript,
  stopScript,
  vmName,
  vncScript,
  type HostState,
  type VmConfig,
} from "./host.ts";

const SSH_KEY = "ssh-key";
const READY_TIMEOUT_MS = 5 * 60_000;
/** Cua Driver as the images pin it (015). The setup guide's image script installs this release. */
export const CUA_VERSION = "0.30.4";
const MiB_PER_GiB = 1024;

/** The doctor checks room for a box of the small preset core ships for the macOS kinds (028). */
const DOCTOR_SIZE: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };

const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true };

type Step = <T>(name: string, run: () => Promise<T>) => Promise<T>;

export interface TartBackendOptions {
  readonly sshBinary?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** The longest an acquire may take, instead of the kind's. */
  readonly readyTimeoutMs?: number;
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

/** A VM bb-box is starting on a Mac, counted against the Mac until Tart lists it running. */
interface Placing {
  readonly host: string;
  readonly vm: string;
  readonly memoryMiB: number;
}

type Pending = { readonly kind: string; readonly size: BoxSize };

/** Boxes the registry is acquiring that have not reached a Mac yet, which count on every Mac. */
interface Unplaced {
  readonly count: number;
  readonly memoryMiB: number;
}

const NONE_UNPLACED: Unplaced = { count: 0, memoryMiB: 0 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatMiB(value: number): string {
  return value >= MiB_PER_GiB ? `${Math.round((value / MiB_PER_GiB) * 10) / 10} GiB` : `${value} MiB`;
}

function powerOf(state: string | undefined): PowerState {
  if (state === "running") return "running";
  if (state === "stopped" || state === "suspended") return "stopped";
  return "unknown";
}

/** The size a VM's config gives it. Tart keeps no disk size there, so the disk is the image's, as null. */
function sizeOf(config: VmConfig | null | undefined): BoxSize | null {
  if (!config || !config.cpus || !config.memoryMiB) return null;
  return { cores: config.cpus, memoryMiB: config.memoryMiB, diskGiB: null };
}

function ownerOf(fields: Readonly<Record<string, string>>): BoxOwner | null {
  if (!fields.box || !fields.thread) return null;
  const created = Number(fields.created);
  return {
    boxId: fields.box,
    threadId: fields.thread,
    name: fields.name || null,
    kind: fields.kind || null,
    createdAt: Number.isFinite(created) && created > 0 ? created : null,
  };
}

/** The kinds a config offers: those with an image. */
export function tartKinds(config: TartConfig): BoxKind[] {
  const cua: ComputerUse = { driver: "cua", version: CUA_VERSION, socket: `/Users/${config.ssh.vmUser}/Library/Caches/cua-driver/cua-driver.sock` };
  const kinds: Record<TartKind, BoxKind> = {
    macos: {
      id: "macos",
      label: "macOS",
      description: "A macOS VM on a Mac with Apple silicon, for builds and commands. Its desktop is not shown.",
      requires: [],
      capabilities: { os: "macos", arch: "arm64", gpu: false, features: [], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
    "macos-desktop": {
      id: "macos-desktop",
      label: "macOS desktop",
      description: "A macOS VM on a Mac with Apple silicon, with its desktop shown in the panel and computer use.",
      requires: [],
      capabilities: {
        os: "macos",
        arch: "arm64",
        gpu: false,
        features: [],
        command: SSH_COMMAND,
        displays: [{ id: "desktop", protocol: "rfb", resizable: false }],
        computerUse: cua,
        enrol: true,
      },
      readyTimeoutMs: READY_TIMEOUT_MS,
    },
  };
  return TART_KINDS.filter((kind) => config.kinds[kind].image).map((kind) => kinds[kind]);
}

/** A Mac that did not answer over SSH, or whose script failed. */
class HostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostError";
  }
}

export class TartBackend implements Backend {
  readonly id = "tart";
  readonly label: string;
  readonly nature = "virtual" as const;
  readonly #config: TartConfig;
  readonly #context: BackendContext;
  readonly #options: TartBackendOptions;
  readonly #kinds: BoxKind[];
  readonly #keyFile = new KeyFile();
  #ssh: Promise<SshKeys> | null = null;
  /** Each VM's address while bb-box knows it: learnt when it starts, forgotten when it stops. */
  readonly #addresses = new Map<string, string>();
  /** VMs being acquired, by box ID, until their acquire ends. */
  readonly #placing = new Map<string, Placing>();
  /** Placement is one at a time, so two acquires never take the last slot of one Mac. */
  #placement: Promise<unknown> = Promise.resolve();

  constructor(config: TartConfig, context: BackendContext, options: TartBackendOptions = {}) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#kinds = tartKinds(config);
    this.label = `Tart on ${config.hosts.map((host) => host.name).join(", ")}`;
  }

  kinds(): BoxKind[] {
    return this.#kinds;
  }

  #kind(id: string): BoxKind {
    const kind = this.#kinds.find((candidate) => candidate.id === id);
    if (!kind) throw new BackendError("unsupported", `${this.label} does not offer ${id} boxes.`);
    return kind;
  }

  async capacity(kind: string, size: BoxSize, pending: readonly Pending[], signal?: AbortSignal): Promise<Capacity> {
    this.#kind(kind);
    const states = await this.#states(signal);
    const placed = [...this.#placing.values()];
    const unplaced: Unplaced = {
      count: Math.max(0, pending.length - placed.length),
      memoryMiB: Math.max(0, pending.reduce((sum, other) => sum + other.size.memoryMiB, 0) - placed.reduce((sum, other) => sum + other.memoryMiB, 0)),
    };
    const hosts = this.#config.hosts.map((host) => this.#room(host, states.get(host.name)!, size, unplaced));
    const ok = hosts.some((host) => host.capacity.ok);
    return {
      ok,
      message: ok ? null : this.#full(kind, hosts),
      warm: null,
      hosts: hosts.map((host) => host.capacity),
    };
  }

  /** Each Mac's state, or the error it gave. */
  async #states(signal?: AbortSignal): Promise<Map<string, HostState | Error>> {
    const entries = await Promise.all(
      this.#config.hosts.map(async (host) => [host.name, await this.#state(host, signal).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))))] as const),
    );
    return new Map(entries);
  }

  /** Whether a box of `size` fits on the Mac, and if not, why, with what to do. */
  #room(host: TartHost, state: HostState | Error, size: BoxSize, unplaced: Unplaced = NONE_UNPLACED): { capacity: HostCapacity; why: string | null } {
    if (state instanceof Error) return { capacity: { host: host.name, ok: false, limits: [] }, why: `${host.name} did not answer: ${state.message}` };
    // Every running VM takes memory; only macOS VMs count against Apple's two.
    const running = state.vms.filter((vm) => vm.running);
    const macos = running.filter((vm) => (state.configs.get(vm.name)?.os ?? "darwin") === "darwin");
    const placing = [...this.#placing.values()].filter((other) => other.host === host.name && !running.some((vm) => vm.name === other.vm));
    const starting = placing.length + unplaced.count;
    const memoryUsed =
      running.reduce((sum, vm) => sum + (state.configs.get(vm.name)?.memoryMiB ?? 0), 0) + placing.reduce((sum, other) => sum + other.memoryMiB, 0) + unplaced.memoryMiB;
    const memoryFree = state.memoryMiB - memoryUsed;
    const reserve = this.#config.reserve;
    const diskReserveMiB = reserve.diskGiB * MiB_PER_GiB;
    const limits: Limit[] = [
      { resource: "guests", used: macos.length + starting, total: this.#config.vmsPerHost, reserve: 0, unit: "count" },
      { resource: "memory", used: memoryUsed, total: state.memoryMiB, reserve: reserve.memoryMiB, unit: "MiB" },
      { resource: "disk", used: state.disk.totalMiB - state.disk.freeMiB, total: state.disk.totalMiB, reserve: diskReserveMiB, unit: "MiB" },
    ];
    let why: string | null = null;
    if (size.diskGiB !== null) {
      // Growing a macOS VM's disk needs its recovery partition removed and its APFS container grown inside the guest.
      why = `a Tart box keeps its image's disk, so bb-box cannot give it a ${size.diskGiB} GiB disk yet. Ask for the base disk`;
    } else if (state.cpus && size.cores > state.cpus) {
      why = `${host.name} has ${state.cpus} cores, fewer than the ${size.cores} asked for. Ask for at most ${state.cpus} cores`;
    } else if (macos.length + starting >= this.#config.vmsPerHost) {
      const names = macos.map((vm) => vm.name).join(", ");
      why =
        `${host.name} runs ${macos.length + starting} of the ${this.#config.vmsPerHost} macOS VMs it may run${names ? ` (${names})` : ""}. ` +
        "Release or stop a macOS box, or stop another VM there";
    } else if (memoryFree - size.memoryMiB < reserve.memoryMiB) {
      why =
        `${host.name} has ${formatMiB(Math.max(0, memoryFree))} of memory free, and a box with ${formatMiB(size.memoryMiB)} would leave less than the ${formatMiB(reserve.memoryMiB)} kept free. ` +
        "Ask for less memory, release a box, or lower the memory kept free in bb-box's settings";
    } else if (state.disk.freeMiB < diskReserveMiB) {
      why = `${host.name} has ${formatMiB(state.disk.freeMiB)} of disk free, less than the ${formatMiB(diskReserveMiB)} kept free. Release boxes or free some space`;
    }
    return { capacity: { host: host.name, ok: why === null, limits }, why };
  }

  #full(kind: string, hosts: readonly { why: string | null }[]): string {
    const reasons = [...new Set(hosts.map((host) => host.why).filter((why): why is string => why !== null))];
    return `No Mac can take this ${kind} box: ${reasons.join("; ")}.`;
  }

  /** Picks the first Mac with room and counts the box against it, one acquire at a time. */
  #place(box: BoxIdentity, signal: AbortSignal): Promise<TartHost> {
    const placed = this.#placement.then(async () => {
      const states = await this.#states(signal);
      const rooms = this.#config.hosts.map((host) => ({ host, ...this.#room(host, states.get(host.name)!, box.size) }));
      const chosen = rooms.find((room) => room.capacity.ok);
      if (!chosen) throw new BackendError("no_capacity", this.#full(box.kind, rooms));
      this.#placing.set(box.boxId, { host: chosen.host.name, vm: vmName(box.boxId), memoryMiB: box.size.memoryMiB });
      return chosen.host;
    });
    this.#placement = placed.catch(() => undefined);
    return placed;
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#kind(box.kind);
    const image = this.#config.kinds[box.kind as TartKind].image!;
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? kind.readyTimeoutMs);
    const vm = vmName(box.boxId);
    const step: Step = async (name, run) => {
      const started = performance.now();
      try {
        return await run();
      } finally {
        hooks.timing(name, Math.round(performance.now() - started));
      }
    };
    const resumed = previous?.ref === vm ? this.#hostNamed(previous.host) : null;
    const host = resumed ?? (await step("place", () => this.#place(box, signal)));
    if (resumed) this.#placing.set(box.boxId, { host: resumed.name, vm, memoryMiB: box.size.memoryMiB });
    const guest = (address: string | null, size: BoxSize | null = null): Guest => ({ ref: vm, host: host.name, address, size, data: { box: box.boxId } });
    let owned = false;
    try {
      await hooks.claim(guest(null));
      const owner = ownerText({
        install: this.#context.installId,
        kind: box.kind,
        box: box.boxId,
        thread: box.threadId,
        name: box.name,
        created: box.createdAt,
      });
      const claimed = (await this.#run(host, claimScript(vm, owner), { signal })).stdout.trim();
      if (claimed !== "claimed") {
        const fields = parseFields(claimed);
        if (fields.install !== this.#context.installId || fields.box !== box.boxId) {
          throw new Error(`VM ${vm} on ${host.name} belongs to another box, so bb-box left it alone.`);
        }
      }
      owned = true;
      const cloned = await step("clone", () => this.#run(host, cloneScript(image, vm, box.size.cores, box.size.memoryMiB), { timeoutMs: 10 * 60_000, signal }));
      const size = sizeOf(parseConfig(cloned.stdout));
      await hooks.starting();
      await step("start", () => this.#start(host, vm, deadline, signal));
      const address = await step("network", () => this.#address(host, vm, deadline, signal));
      await step("ssh", () => this.#waitReady(host, vm, address, deadline, signal));
      // Claimed again, so the box's record has the address and size as it becomes ready.
      await hooks.claim(guest(address, size));
      return guest(address, size);
    } catch (error) {
      if (owned) {
        await this.#delete(host, vm, box.boxId).catch((cause) => this.#context.logError("release after a failed acquire", cause));
      }
      throw error;
    } finally {
      this.#placing.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const started = performance.now();
    await this.#delete(host, guest.ref, this.#boxOf(guest), signal);
    hooks.timing("delete", Math.round(performance.now() - started));
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const host = this.#hostNamed(guest.host);
    if (!host) return "unknown";
    let result: RunResult;
    try {
      result = await this.#run(host, powerScript(guest.ref, this.#context.installId, this.#boxOf(guest)), { timeoutMs: 30_000, signal });
    } catch (error) {
      if (signal?.aborted) throw error;
      return "unknown";
    }
    const state = result.stdout.trim().split("\n").pop();
    if (state === "gone") return null;
    return powerOf(state);
  }

  async start(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    const deadline = Date.now() + (this.#options.readyTimeoutMs ?? READY_TIMEOUT_MS);
    if ((await this.power(guest, signal)) === null) throw this.#gone(guest);
    this.#addresses.delete(guest.ref);
    await this.#start(host, guest.ref, deadline, signal);
    const address = await this.#address(host, guest.ref, deadline, signal);
    await this.#waitReady(host, guest.ref, address, deadline, signal);
  }

  async stop(guest: Guest, signal?: AbortSignal): Promise<void> {
    const host = this.#hostOf(guest);
    await this.#forget(host, guest.ref);
    const result = await this.#run(host, stopScript(guest.ref, this.#context.installId, this.#boxOf(guest), "suspend"), { timeoutMs: 120_000, signal });
    if (result.stdout.trim() === "gone") throw this.#gone(guest);
  }

  /** This install's VMs on every Mac that answers, from their owner files. */
  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    const states = await this.#states(signal);
    for (const host of this.#config.hosts) {
      const state = states.get(host.name)!;
      if (state instanceof Error) {
        this.#context.logError("held", state);
        continue;
      }
      for (const [vm, fields] of state.owners) {
        if (fields.install !== this.#context.installId) continue;
        const owner = ownerOf(fields);
        const listed = state.vms.find((candidate) => candidate.name === vm);
        held.push({
          ref: vm,
          host: host.name,
          address: this.#addresses.get(vm) ?? null,
          size: sizeOf(state.configs.get(vm)),
          data: owner ? { box: owner.boxId } : {},
          owner,
          // A VM not made yet, after an acquire cut short before its clone, counts as stopped.
          power: listed ? powerOf(listed.state) : "stopped",
        });
      }
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const host = this.#hostOf(guest);
    const { ssh } = await this.#keys();
    const mac = await this.#mac(host);
    let address: string | null = this.#addresses.get(guest.ref) ?? null;
    if (!address) {
      address = (await this.#lookup(host, guest.ref).catch(() => null)) ?? guest.address;
    }
    if (!address) throw new TransportError("unreachable", `The macOS VM ${guest.ref} on ${host.name} has no address. It may be stopped.`);
    const access = this.#vm(mac, address);
    const command = new SshTransport(ssh, access, "macos");
    const capabilities = this.#kinds.find((candidate) => candidate.id === kind)?.capabilities;
    const displays = (capabilities?.displays ?? []).map(
      (display): Display => ({
        ...display,
        label: "Desktop",
        open: async (signal) => {
          const vnc = await this.#vnc(host, guest.ref, signal);
          return { route: ssh.route(mac, vnc.port), auth: { type: "vnc-password", password: vnc.password } };
        },
      }),
    );
    return { command, displays, access: { ssh: access, dockerHost: null } };
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. Its VMs' owner files on each Mac, in ~/.bb-box/tart/owners, name it.`];
    const push = (id: string, name: string, status: DoctorCheck["status"], detail: string, fix: string | null = null) =>
      checks.push({ id, name, status, detail, fix });

    let keys: SshKeys | null = null;
    try {
      keys = await this.#keys();
      if (keys.publicKey) {
        push("tart.ssh-key", "SSH key", "ok", keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
        notes.push(
          `Each Mac's user, and user ${this.#config.ssh.vmUser} in each image, must accept this SSH key in ~/.ssh/authorized_keys: ${keys.publicKey}`,
        );
      } else {
        push("tart.ssh-key", "SSH key", "fail", "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      push("tart.ssh-key", "SSH key", "fail", message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    const states = keys ? await this.#states(signal) : new Map<string, HostState | Error>();
    const others = new Map<string, number>();
    for (const host of this.#config.hosts) {
      const id = `host.${host.name}`;
      const name = `Mac ${host.name}`;
      const images = TART_KINDS.filter((kind) => this.#config.kinds[kind].image);
      const state = states.get(host.name);
      if (!state || state instanceof Error) {
        push(
          id,
          name,
          state ? "fail" : "skipped",
          state ? state.message : "Skipped until the checks above pass.",
          state ? `Check that ${host.user}@${host.address} accepts bb-box's key over SSH, that its host key is in bb-box's settings, and that Tart is installed (setup/tart/README.md).` : null,
        );
        for (const kind of images) push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "skipped", "Skipped until the checks above pass.");
        continue;
      }
      if (state.arch !== "arm64") {
        push(id, name, "fail", `${host.name} is ${state.arch || "not Apple silicon"}; Tart runs macOS VMs on Apple silicon only.`, "Use a Mac with Apple silicon.");
      } else {
        push(id, name, "ok", `macOS ${state.macos} on Apple silicon, Tart ${state.version}.`);
      }
      for (const kind of images) {
        const image = this.#config.kinds[kind].image!;
        const listed = state.vms.find((vm) => vm.name === image);
        const config = state.configs.get(image);
        if (!listed) {
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "fail", `${host.name} has no Tart VM ${image}.`, "Prepare it with setup/tart/prepare-image.sh, or set the image in bb-box's settings.");
        } else if (config?.os && config.os !== "darwin") {
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "fail", `${image} on ${host.name} is a ${config.os} VM.`, "Give a macOS image.");
        } else {
          push(`image.${host.name}.${kind}`, `${kind} image on ${host.name}`, "ok", `${image}${config ? `, ${config.cpus} cores and ${formatMiB(config.memoryMiB)} as prepared` : ""}.`);
        }
      }
      const room = this.#room(host, state, DOCTOR_SIZE);
      push(
        `capacity.${host.name}`,
        `Room on ${host.name}`,
        room.capacity.ok ? "ok" : "warn",
        room.why ?? room.capacity.limits.map((limit) => `${limit.resource} ${limit.unit === "MiB" ? `${formatMiB(limit.used)} of ${formatMiB(limit.total ?? 0)}` : `${limit.used} of ${limit.total}`}`).join(", "),
        room.capacity.ok ? null : "Release or stop a macOS box, or stop another VM on the Mac.",
      );
      for (const [, fields] of state.owners) {
        if (fields.install === this.#context.installId) continue;
        const key = fields.install || "none";
        others.set(key, (others.get(key) ?? 0) + 1);
      }
    }
    if (others.size) {
      notes.push(
        `bb-box leaves alone the VMs of other installs on these Macs: ${[...others].map(([install, count]) => `${count} of install ${install}`).join(", ")}. They still count against each Mac's room.`,
      );
    }
    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    const answering = [...states.values()].find((state): state is HostState => !(state instanceof Error));
    return {
      ok,
      summary: ok ? `Tart ${answering?.version ?? "?"} on ${this.#config.hosts.map((host) => host.name).join(", ")}` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  async dispose(): Promise<void> {
    const pending = this.#ssh;
    this.#ssh = null;
    const keys = await pending?.catch(() => null);
    await keys?.ssh.dispose().catch(() => undefined);
    await this.#keyFile.dispose();
  }

  // The Mac's side.

  #hostNamed(name: string | null): TartHost | null {
    return this.#config.hosts.find((host) => host.name === name) ?? null;
  }

  #hostOf(guest: Guest): TartHost {
    const host = this.#hostNamed(guest.host);
    if (!host) throw new Error(`Box VM ${guest.ref} is on Mac ${guest.host ?? "unknown"}, which is not in bb-box's Tart settings. Add the Mac back to reach it.`);
    return host;
  }

  #boxOf(guest: Guest): string | null {
    return typeof guest.data?.box === "string" ? guest.data.box : null;
  }

  #gone(guest: Guest): BackendError {
    return new BackendError("gone", `The macOS VM ${guest.ref} no longer exists on ${guest.host}.`);
  }

  async #mac(host: TartHost): Promise<SshAccess> {
    return { host: host.address, port: host.port, user: host.user, hostKeys: this.#config.hostKeys };
  }

  #vm(mac: SshAccess, address: string): SshAccess {
    return { host: address, port: 22, user: this.#config.ssh.vmUser, hostKeys: [], jump: mac };
  }

  /** Runs a script on the Mac. Throws when the Mac does not answer, or the script fails. */
  async #run(host: TartHost, script: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<RunResult> {
    const { ssh } = await this.#keys();
    const result = await ssh.run(await this.#mac(host), script, { timeoutMs: options.timeoutMs ?? 60_000, signal: options.signal, maxOutputBytes: 1 << 20 }, "macos");
    if (result.timedOut) throw new HostError(`${host.name} did not finish in time.`);
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${result.stderr.trim() || "no reason given"}.`);
    if (result.exitCode !== 0) {
      throw new HostError(`On ${host.name}: ${result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`}`);
    }
    return result;
  }

  async #state(host: TartHost, signal?: AbortSignal): Promise<HostState> {
    return parseState((await this.#run(host, stateScript(), { timeoutMs: 30_000, signal })).stdout);
  }

  /** Starts the VM, detached from SSH, and fails fast when Tart cannot. */
  async #start(host: TartHost, vm: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const seconds = Math.max(5, Math.min(180, Math.round((deadline - Date.now()) / 1000)));
    const { ssh } = await this.#keys();
    const result = await ssh.run(await this.#mac(host), startScript(vm, seconds), { timeoutMs: (seconds + 30) * 1000, signal, maxOutputBytes: 1 << 16 }, "macos");
    if (result.exitCode === 0) return;
    const said = result.stderr.trim();
    if (result.exitCode === 3 && /exceeds the system limit/i.test(said)) {
      throw new BackendError(
        "no_capacity",
        `${host.name} already runs as many VMs as macOS allows, two: ${said.split("\n").pop()}. Release or stop a macOS box, or stop another VM on ${host.name}.`,
      );
    }
    if (result.exitCode === 255) throw new HostError(`${host.name} did not answer over SSH as ${host.user}: ${said || "no reason given"}.`);
    throw new Error(`Tart could not start ${vm} on ${host.name}: ${said || `exit code ${result.exitCode}`}`);
  }

  /** Waits for the VM's DHCP lease on the Mac, and keeps the address. */
  async #address(host: TartHost, vm: string, deadline: number, signal?: AbortSignal): Promise<string> {
    const seconds = Math.max(5, Math.round((deadline - Date.now()) / 1000));
    const result = await this.#run(host, ipScript(vm, seconds), { timeoutMs: (seconds + 30) * 1000, signal }).catch((error: unknown) => {
      throw new Error(`${vm} on ${host.name} got no address within ${seconds} s: ${message(error)}`);
    });
    const address = result.stdout.trim();
    if (!/^[0-9a-f.:]+$/i.test(address)) throw new Error(`Tart gave ${vm} on ${host.name} no address: ${address || "nothing"}.`);
    this.#addresses.set(vm, address);
    return address;
  }

  async #lookup(host: TartHost, vm: string): Promise<string | null> {
    const address = (await this.#run(host, ipScript(vm, 0), { timeoutMs: 15_000 })).stdout.trim();
    if (!/^[0-9a-f.:]+$/i.test(address)) return null;
    this.#addresses.set(vm, address);
    return address;
  }

  /** Waits until SSH to the VM, through the Mac, answers, on the connection its first commands then share. */
  async #waitReady(host: TartHost, vm: string, address: string, deadline: number, signal?: AbortSignal): Promise<void> {
    const { ssh } = await this.#keys();
    const command = new SshTransport(ssh, this.#vm(await this.#mac(host), address), "macos");
    const left = Math.max(1_000, deadline - Date.now());
    const answers = { probe: (inner?: AbortSignal) => command.answers(inner) };
    const ready = await waitUntilAnswers(answers, { timeoutMs: left, intervalMs: 500, signal, sleep: this.#options.sleep ?? pause });
    if (!ready) {
      throw new Error(
        `${vm} on ${host.name} did not answer SSH as ${this.#config.ssh.vmUser} at ${address} within ${Math.round(left / 1000)} s. ` +
          `Check that the image's user ${this.#config.ssh.vmUser} accepts bb-box's key.`,
      );
    }
  }

  async #vnc(host: TartHost, vm: string, signal?: AbortSignal): Promise<{ port: number; password: string }> {
    const vnc = parseVnc((await this.#run(host, vncScript(vm), { timeoutMs: 15_000, signal })).stdout);
    if (!vnc) throw new Error(`Tart's VNC server for ${vm} on ${host.name} is not running. The VM may be stopped.`);
    return vnc;
  }

  /** Closes the shared SSH connections to a VM that is stopping or going, and forgets its address. */
  async #forget(host: TartHost, vm: string): Promise<void> {
    const address = this.#addresses.get(vm);
    this.#addresses.delete(vm);
    if (!address) return;
    try {
      const { ssh } = await this.#keys();
      await ssh.forget(this.#vm(await this.#mac(host), address));
    } catch (error) {
      this.#context.logError("ssh", error);
    }
  }

  async #delete(host: TartHost, vm: string, boxId: string | null, signal?: AbortSignal): Promise<void> {
    await this.#forget(host, vm);
    await this.#run(host, deleteScript(vm, this.#context.installId, boxId), { timeoutMs: 120_000, signal });
  }

  #keys(): Promise<SshKeys> {
    if (!this.#ssh) {
      const pending = (async () => {
        let privateKey = this.#config.ssh.privateKey;
        let publicText: string | null = null;
        const generated = !privateKey;
        if (!privateKey) {
          let stored = await this.#context.storage.get<{ privateKey: string; publicKey: string }>(SSH_KEY);
          if (!stored) {
            stored = await generateKeyPair();
            await this.#context.storage.set(SSH_KEY, stored);
          }
          privateKey = stored.privateKey;
          publicText = stored.publicKey;
        }
        const keyPath = await this.#keyFile.path(privateKey);
        publicText ??= await publicKey(keyPath);
        const knownHostsPath = await this.#keyFile.knownHosts(this.#config.hostKeys);
        const shareDir = await this.#keyFile.shareDir();
        return { ssh: new Ssh({ keyPath, knownHostsPath, binary: this.#options.sshBinary, shareDir }), publicKey: publicText, generated };
      })();
      this.#ssh = pending;
      pending.catch(() => {
        if (this.#ssh === pending) this.#ssh = null;
      });
    }
    return this.#ssh;
  }
}

