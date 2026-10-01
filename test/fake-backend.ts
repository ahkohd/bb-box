// An in-memory backend for tests. Each guest is a directory on this machine,
// and its commands run there with sh through the same command line code as
// SSH. It acts as a virtual backend (acquire makes a guest, release deletes
// it) or a real one (a fixed set of machines, claimed through the shared ready
// pool, reset and returned on release). State lives in backend storage, so a
// new instance on the same storage and root finds the same guests, as after a
// restart. Instances given one `host` storage share the fake provider, as two
// installs share a host: each records its install ID on its guests and acts
// only on its own (018). Desktops stream from a local server that sends an RFB
// greeting. With `resize: "backend"` that server ignores SetDesktopSize and the
// display's resize sets the size instead, as on a GPU desktop (021).
//
// Stopping a guest's command, as at a timeout, kills only its shell, as it
// kills `ssh` for a real box, so what the script started runs on, as do
// servers a test starts in a guest. All guests' commands therefore run in one
// process group, which ends with the test process, however it ends (#310).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import type { Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { KvPoolStore, ReadyPool, type PoolMachine } from "../src/backends/pool.ts";
import { FakeRfb } from "./fake-rfb.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BackendDriver,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorReport,
  type Guest,
  type HeldGuest,
  type Limit,
  type MachineNature,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
} from "../src/backends/types.ts";
import { CommandLine, quote } from "../src/transports/process.ts";
import { openRoute } from "../src/transports/route.ts";
import { openTerminal } from "../src/transports/terminal.ts";
import {
  TransportError,
  type ByteChannel,
  type CommandTransport,
  type Display,
  type DisplaySize,
  type Route,
  type RunOptions,
  type RunResult,
  type StreamOptions,
  type Terminal,
  type TerminalSize,
} from "../src/transports/types.ts";

export interface FakeBackendOptions {
  readonly root: string;
  readonly storage: BackendStorage;
  readonly id?: string;
  readonly nature?: MachineNature;
  /** Where its boxes run, by name, for a provider's name (044). None by default. */
  readonly hosts?: readonly string[];
  /** The kinds it offers. FAKE_KINDS by default. */
  readonly kinds?: readonly BoxKind[];
  /** Real: how many machines the pool has. */
  readonly machines?: number;
  /** Virtual: most guests at once. */
  readonly maxGuests?: number;
  /** Whether it can stop and start guests. True by default. */
  readonly stopStart?: boolean;
  /** This install's ID. "test" by default. */
  readonly installId?: string;
  /** Where the fake provider keeps its guests and machines. The storage by default. */
  readonly host?: BackendStorage;
  /** What sets a desktop's size: the stream server's SetDesktopSize (the default), or the display's resize. */
  readonly resize?: "stream" | "backend";
  /** The smallest size a viewer may set a desktop to. None by default. */
  readonly minSize?: DisplaySize;
  /**
   * Virtual: the largest guest it makes; capacity refuses a larger size. Real:
   * every machine's size, which a box of any size up to it gets. 16 cores,
   * 64 GiB memory and 256 GiB disk by default.
   */
  readonly largest?: BoxSize;
  /** Warm guests to keep per kind, read at each maintain, as a backend reads its context's. None by default. */
  readonly warm?: (kind: string) => number;
  /** The $SHELL that runs guests' scripts, such as FAKE_PWSH. The user's login shell by default. */
  readonly shell?: string;
}

/** Faults a test can inject. Each is used once. */
export interface FakeFaults {
  /** Fails the acquire after the guest is claimed, or after it started. */
  acquire?: { at: "claimed" | "started"; error: Error };
  release?: Error;
  /** Real: the reset fails, so the machine goes out of service with this reason. */
  reset?: string;
  doctor?: string;
  /** The guest whose command transport does not answer, although it runs. */
  silent?: string;
}

interface GuestRecord {
  readonly install: string;
  readonly owner: BoxIdentity | null;
  readonly power: PowerState;
}

/** A real machine's holder: the box, and the install it belongs to. */
type Holder = BoxIdentity & { readonly install: string };

const HOST = "fake";
const LARGEST: BoxSize = { cores: 16, memoryMiB: 65536, diskGiB: 256 };
/** Where the fake `cua-driver` command is. */
export const FAKE_CUA_BIN = fileURLToPath(new URL("./fake-cua", import.meta.url));
/** A Windows box's fake PowerShell, for the backend's `shell`. */
export const FAKE_PWSH = fileURLToPath(new URL("./fake-pwsh", import.meta.url));

const COMMAND: CommandCapability = { transport: "local", shell: "sh", admin: false, inDesktopSession: false, streaming: true };

/** The test machine's architecture, since the fake box's commands run there. */
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";

export const FAKE_KINDS: readonly BoxKind[] = [
  {
    id: "linux",
    label: "Linux",
    description: "A fake box: a directory on the test machine.",
    requires: [],
    capabilities: { os: "linux", arch: ARCH, gpu: false, features: [], command: COMMAND, displays: [], computerUse: null, enrol: true },
    readyTimeoutMs: 10_000,
  },
  {
    id: "linux-desktop",
    label: "Linux desktop",
    description: "A fake box with a fake desktop stream.",
    requires: [],
    capabilities: {
      os: "linux",
      arch: ARCH,
      gpu: false,
      features: [],
      command: COMMAND,
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
      // The fake driver keeps its desktop in this file, in the box's directory.
      computerUse: { driver: "cua", version: "test", socket: "cua-driver.json" },
      enrol: true,
    },
    readyTimeoutMs: 10_000,
  },
];

/** A Windows box with no enrolment. Its scripts need FAKE_PWSH as the backend's `shell`. */
export const FAKE_WINDOWS_KIND: BoxKind = {
  ...FAKE_KINDS[0]!,
  id: "windows",
  label: "Windows",
  capabilities: { ...FAKE_KINDS[0]!.capabilities, os: "windows", enrol: false },
};

export class FakeBackend implements Backend {
  readonly id: string;
  readonly label: string;
  readonly hosts: readonly string[];
  readonly nature: MachineNature;
  readonly restores?: "home" | "machine";
  readonly faults: FakeFaults = {};
  /** Acquires wait here after the claim while it is set. */
  gate: Promise<void> | null = null;
  /** Stops and starts wait here while it is set. */
  powerGate: Promise<void> | null = null;
  readonly calls: string[] = [];
  /** The steps a start reports, with the time each took. */
  startSteps: Readonly<Record<string, number>> = { boot: 1_200 };
  readonly start?: (guest: Guest, signal?: AbortSignal, timing?: (step: string, ms: number) => void) => Promise<void>;
  readonly stop?: (guest: Guest) => Promise<void>;
  readonly members?: () => Promise<readonly PoolMember[]>;
  readonly returnToService?: (ref: string) => Promise<void>;
  readonly stamp?: (boxId: string, guest: Guest) => Promise<Guest>;
  readonly #options: FakeBackendOptions;
  readonly #kinds: readonly BoxKind[];
  readonly #installId: string;
  readonly #storage: BackendStorage;
  readonly #pool: KvPoolStore<Holder>;
  readonly #ready: ReadyPool<Holder>;
  /** Boxes whose acquire runs here and holds its guest, which capacity counts once. */
  readonly #holding = new Set<string>();
  /** Every desktop box's VNC server: one server, with a password the viewer never sees. */
  readonly rfb: FakeRfb;
  #vnc: Promise<number> | null = null;
  /** Each size a display's resize was asked for, in order. */
  readonly resizes: DisplaySize[] = [];
  /** How many resizes run now, and the most that ran at once. */
  resizing = 0;
  mostResizing = 0;
  /** Resizes wait here while it is set. */
  resizeGate: Promise<void> | null = null;

  constructor(options: FakeBackendOptions) {
    this.#options = options;
    this.rfb = new FakeRfb({ password: "fakepass", acceptResize: options.resize !== "backend" });
    this.#kinds = options.kinds ?? FAKE_KINDS;
    this.#installId = options.installId ?? "test";
    this.#storage = options.host ?? options.storage;
    this.id = options.id ?? "fake";
    this.nature = options.nature ?? "virtual";
    this.label = this.nature === "real" ? "Fake machine pool" : "Fake host";
    this.hosts = options.hosts ?? [];
    this.#pool = new KvPoolStore(this.#storage, () => this.machines());
    this.#ready = new ReadyPool(this.#pool);
    if (options.stopStart ?? true) {
      this.start = async (guest, _signal, timing) => {
        await this.#power(guest, "running");
        for (const [step, ms] of Object.entries(this.startSteps)) timing?.(step, ms);
      };
      this.stop = (guest) => this.#power(guest, "stopped");
    }
    if (this.nature === "real") {
      this.restores = "home";
      this.members = () => this.#pool.members();
      this.returnToService = (ref) => this.#pool.returnToService(ref);
    } else {
      this.stamp = (boxId, guest) => this.#stamp(boxId, guest);
    }
  }

  machines(): PoolMachine[] {
    return Array.from({ length: this.#options.machines ?? 2 }, (_, index) => ({
      ref: `m${index + 1}`,
      host: HOST,
      address: `192.0.2.${index + 10}`,
      kinds: this.#kinds.map((kind) => kind.id),
    }));
  }

  kinds(): BoxKind[] {
    return [...this.#kinds];
  }

  async capacity(kind: string, size: BoxSize, pending: readonly { readonly kind: string; readonly size: BoxSize }[]): Promise<Capacity> {
    this.#kind(kind);
    const largest = this.#largest();
    const larger = size.cores > largest.cores || size.memoryMiB > largest.memoryMiB || (size.diskGiB ?? 0) > (largest.diskGiB ?? 0);
    if (larger) {
      const what = this.nature === "real" ? "No machine in the pool is" : "The fake host makes guests of at most";
      return {
        ok: false,
        message: `${what} ${largest.cores} cores, ${largest.memoryMiB / 1024} GiB memory and ${largest.diskGiB} GiB disk.`,
        warm: this.nature === "real" ? null : { ready: 0, target: 0 },
        hosts: [{ host: HOST, ok: false, limits: [] }],
      };
    }
    const unplaced = Math.max(0, pending.length - this.#holding.size);
    if (this.nature === "real") {
      const members = (await this.#pool.members()).filter((member) => member.kinds.includes(kind));
      const free = members.filter((member) => member.state === "free").length;
      const ok = free > unplaced;
      const machines: Limit = { resource: "machines", used: members.length - free + unplaced, total: members.length, reserve: 0, unit: "count" };
      return {
        ok,
        message: ok ? null : `All ${members.length} machines are in use. Release a box to free one.`,
        warm: null,
        hosts: [{ host: HOST, ok, limits: [machines] }],
      };
    }
    const used = (await this.#storage.list("guest/")).length + unplaced;
    const total = this.#options.maxGuests ?? null;
    const ok = total === null || used < total;
    return {
      ok,
      message: ok ? null : `The fake host holds ${total} guests at most. Release a box to make room.`,
      warm: { ready: 0, target: 0 },
      hosts: [{ host: HOST, ok, limits: [{ resource: "guests", used, total, reserve: 0, unit: "count" }] }],
    };
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.calls.push(`acquire ${box.boxId}`);
    this.#kind(box.kind);
    signal.throwIfAborted();
    let guest: Guest | null = null;
    const started = performance.now();
    try {
      if (previous && (await this.#owner(previous.ref))?.boxId === box.boxId) guest = previous;
      if (!guest && this.nature === "real") {
        const member = await this.#ready.claim(box.kind, { ...box, install: this.#installId }, {
          before: async (candidate) => {
            guest = this.#guest(candidate.ref, candidate.generation, null, this.#largest());
            await hooks.claim(guest);
          },
          signal,
        });
        if (!member) throw new BackendError("no_capacity", "All machines are in use. Release a box to free one.");
      }
      if (!guest) {
        const counter = ((await this.#storage.get<number>("counter")) ?? 0) + 1;
        await this.#storage.set("counter", counter);
        guest = this.#guest(`g${counter}`, null, box.boxId, box.size);
        await hooks.claim(guest);
        signal.throwIfAborted();
        await this.#storage.set(`guest/${guest.ref}`, { install: this.#installId, owner: box, power: "stopped" } satisfies GuestRecord);
      }
      this.#holding.add(box.boxId);
      await mkdir(this.#home(guest.ref), { recursive: true });
      hooks.timing("make", Math.round(performance.now() - started));
      await this.gate;
      this.#fault("claimed");
      signal.throwIfAborted();
      await hooks.starting();
      signal.throwIfAborted();
      await this.#setPower(guest.ref, "running");
      this.#fault("started");
      hooks.timing("start", Math.round(performance.now() - started));
      return guest;
    } catch (error) {
      // Counted as pending in full again before its guest goes, so never not at all.
      this.#holding.delete(box.boxId);
      if (guest) await this.#discard(guest, null);
      throw error;
    } finally {
      this.#holding.delete(box.boxId);
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks): Promise<void> {
    this.calls.push(`release ${guest.ref}`);
    const error = this.faults.release;
    if (error) {
      delete this.faults.release;
      throw error;
    }
    if (await this.#still(guest)) await this.#discard(guest, hooks);
  }

  async power(guest: Guest): Promise<PowerState | null> {
    if (!(await this.#still(guest))) return null;
    if (this.nature === "real") return (await this.#storage.get<PowerState>(`power/${guest.ref}`)) ?? "running";
    return (await this.#storage.get<GuestRecord>(`guest/${guest.ref}`))?.power ?? null;
  }

  async held(): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    const refs =
      this.nature === "real"
        ? (await this.#pool.members()).filter((member) => member.state === "held").map((member) => member.ref)
        : (await this.#storage.list("guest/")).map((key) => key.slice("guest/".length));
    for (const ref of refs) {
      const owner = await this.#owner(ref);
      if (this.nature === "virtual" && (await this.#record(ref))?.install !== this.#installId) continue;
      if (this.nature === "real" && !owner) continue;
      const generation = this.nature === "real" ? (await this.#pool.state(ref)).generation : null;
      // As a guest would say: a machine's own size, or what a guest was made at.
      const size = this.nature === "real" ? this.#largest() : (owner?.size ?? null);
      const guest = this.#guest(ref, generation, owner?.boxId ?? null, size);
      const power = await this.power(guest);
      if (!power) continue;
      held.push({
        ...guest,
        owner: owner && { boxId: owner.boxId, threadId: owner.threadId, name: owner.name, kind: owner.kind, createdAt: owner.createdAt },
        power,
      });
    }
    return held;
  }

  /** Virtual: records this install on a guest that names the box and no install. */
  async #stamp(boxId: string, guest: Guest): Promise<Guest> {
    this.calls.push(`stamp ${guest.ref}`);
    const record = await this.#record(guest.ref);
    if (record && !record.install && record.owner?.boxId === boxId) await this.#storage.set(`guest/${guest.ref}`, { ...record, install: this.#installId });
    return { ...guest, data: { ...guest.data, box: boxId } };
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const displays = this.#kind(kind).capabilities.displays.map(
      (display): Display => ({
        id: display.id,
        label: "Desktop",
        protocol: display.protocol,
        resizable: display.resizable,
        open: async () => ({
          route: { type: "tcp", host: "127.0.0.1", port: await (this.#vnc ??= this.rfb.listen()) },
          auth: { type: "vnc-password", password: "fakepass" },
        }),
        ...(this.#options.resize === "backend" ? { resize: (size: DisplaySize) => this.#resize(size) } : {}),
        ...(this.#options.minSize ? { minSize: this.#options.minSize } : {}),
      }),
    );
    const power = this.faults.silent === guest.ref ? async (): Promise<PowerState> => "unknown" : () => this.power(guest);
    return { command: new FakeTransport(this.#home(guest.ref), power, this.#commands(guest.ref).signal, this.#options.shell), displays, access: null };
  }

  async #resize(size: DisplaySize): Promise<void> {
    this.resizes.push(size);
    this.resizing += 1;
    this.mostResizing = Math.max(this.mostResizing, this.resizing);
    try {
      await this.resizeGate;
      // X's limit, which xrandr reports as it exits.
      if (size.width > 32767 || size.height > 32767) {
        throw new Error(`xrandr: screen cannot be larger than 32767x32767 (desired size ${size.width}x${size.height})`);
      }
      this.rfb.width = size.width;
      this.rfb.height = size.height;
    } finally {
      this.resizing -= 1;
    }
  }

  async doctor(): Promise<DoctorReport> {
    const problem = this.faults.doctor;
    const checks = [
      problem
        ? { id: "fake.host", name: "Fake host", status: "fail" as const, detail: problem, fix: "Clear the fault." }
        : { id: "fake.host", name: "Fake host", status: "ok" as const, detail: `Guests live under ${this.#options.root}.`, fix: null },
    ];
    return { ok: !problem, summary: problem ? `Fake host: ${problem}` : this.label, checks, notes: [] };
  }

  /** Warm guests kept per kind: maintain makes or retires them to match `warm`. */
  readonly warmGuests = new Map<string, number>();

  /** What relabel was asked: the box's ID, its new owner and name, and the name it had. */
  readonly relabels: { boxId: string; threadId: string; name: string; from: string }[] = [];

  /** Whether a guest comes from what the kind is offered from now; unset assumes so. */
  asOffered?: (guest: Guest, kind: string, createdAt: number) => Promise<boolean>;

  /** How long relabel takes. */
  relabelMs = 0;

  async relabel(_guest: Guest, box: BoxIdentity, from: string): Promise<void> {
    this.relabels.push({ boxId: box.boxId, threadId: box.threadId, name: box.name, from });
    // A timer can fire a little early by the wall clock, which core times it with.
    const end = Date.now() + this.relabelMs;
    while (Date.now() < end) await new Promise((resolve) => setTimeout(resolve, end - Date.now()));
  }

  async maintain(): Promise<void> {
    this.calls.push("maintain");
    for (const kind of this.#kinds) {
      const target = this.#options.warm?.(kind.id) ?? 0;
      if (target) this.warmGuests.set(kind.id, target);
      else this.warmGuests.delete(kind.id);
    }
  }

  async dispose(): Promise<void> {
    if (this.#vnc) await this.#vnc;
    this.#vnc = null;
    await this.rfb.close();
  }

  #kind(kind: string): BoxKind {
    const found = this.#kinds.find((candidate) => candidate.id === kind);
    if (!found) throw new BackendError("unsupported", `${this.label} has no ${kind} boxes.`);
    return found;
  }

  /**
   * A real machine's guest carries the reset generation it was claimed at, so
   * a stale release cannot reset the next box's machine. A virtual guest
   * carries its box, as a reference can be reused.
   */
  #guest(ref: string, generation: number | null, box: string | null, size: BoxSize | null): Guest {
    const address = this.machines().find((machine) => machine.ref === ref)?.address ?? null;
    if (generation !== null) return { ref, host: HOST, address, size, data: { generation } };
    return box === null ? { ref, host: HOST, address, size } : { ref, host: HOST, address, size, data: { box } };
  }

  #largest(): BoxSize {
    return this.#options.largest ?? LARGEST;
  }

  async #record(ref: string): Promise<GuestRecord | undefined> {
    return this.#storage.get<GuestRecord>(`guest/${ref}`);
  }

  /** Whether the guest at the reference is still this install's, and the same box's (018). */
  async #still(guest: Guest): Promise<boolean> {
    if (this.nature === "real") {
      const state = await this.#pool.state(guest.ref);
      return state.state !== "held" || state.holder.install === this.#installId;
    }
    const record = await this.#record(guest.ref);
    return !!record && record.install === this.#installId && (record.owner?.boxId ?? null) === (guest.data?.box ?? null);
  }

  /** Aborted when the guest goes, which stops its commands, as deleting a real guest does. */
  readonly #running = new Map<string, AbortController>();

  #commands(ref: string): AbortController {
    let controller = this.#running.get(ref);
    if (!controller) this.#running.set(ref, (controller = new AbortController()));
    return controller;
  }

  /** Stops the guest's commands, then deletes its directory. A write already under way can land after the stop, so the delete tries again. */
  async #wipe(ref: string): Promise<void> {
    this.#running.get(ref)?.abort(new TransportError("unreachable", "The fake box is gone."));
    this.#running.delete(ref);
    await rm(this.#home(ref), { recursive: true, force: true, maxRetries: 10, retryDelay: 10 });
  }

  #home(ref: string): string {
    return join(this.#options.root, this.id, ref);
  }

  /** The box that holds the guest, when it is this install's. */
  async #owner(ref: string): Promise<BoxIdentity | null> {
    if (this.nature === "real") {
      const state = await this.#pool.state(ref);
      return state.state === "held" && state.holder.install === this.#installId ? state.holder : null;
    }
    const record = await this.#record(ref);
    return record?.install === this.#installId ? record.owner : null;
  }

  async #power(guest: Guest, power: PowerState): Promise<void> {
    await this.powerGate;
    if (!(await this.power(guest))) throw new BackendError("gone", `Guest ${guest.ref} no longer exists.`);
    await this.#setPower(guest.ref, power);
  }

  async #setPower(ref: string, power: PowerState): Promise<void> {
    if (this.nature === "real") return this.#storage.set(`power/${ref}`, power);
    const record = await this.#storage.get<GuestRecord>(`guest/${ref}`);
    if (record) await this.#storage.set(`guest/${ref}`, { ...record, power });
  }

  /** Deletes a virtual guest, or resets a real machine and returns it to the pool. */
  async #discard(guest: Guest, hooks: ReleaseHooks | null): Promise<void> {
    const started = performance.now();
    if (this.nature === "virtual") {
      await this.#storage.delete(`guest/${guest.ref}`);
      await this.#wipe(guest.ref);
      hooks?.timing("delete", Math.round(performance.now() - started));
      return;
    }
    const state = await this.#pool.state(guest.ref);
    if (state.state !== "held" && state.state !== "resetting") return;
    if (typeof guest.data?.generation === "number" && guest.data.generation !== state.generation) return;
    await hooks?.resetting();
    await this.#pool.resetting(guest.ref);
    const reason = this.faults.reset;
    if (reason) {
      delete this.faults.reset;
      await this.#pool.outOfService(guest.ref, reason);
      return;
    }
    await this.#wipe(guest.ref);
    await this.#storage.delete(`power/${guest.ref}`);
    hooks?.timing("reset", Math.round(performance.now() - started));
    await this.#pool.free(guest.ref);
  }

  #fault(at: "claimed" | "started"): void {
    const fault = this.faults.acquire;
    if (fault?.at !== at) return;
    delete this.faults.acquire;
    throw fault.error;
  }
}

/**
 * Perl, as the macOS timeout wrapper uses, since a shell cannot change its
 * process group. LEAD starts a group and keeps it until its input closes, as
 * it does when the test process ends, then kills the group. JOIN runs a
 * command line in a group.
 */
const LEAD = `setpgrp(0, 0) or die "setpgrp: $!\\n"; $| = 1; print "\\n"; <STDIN>; kill "KILL", -$$`;
const JOIN = `setpgrp(0, shift) or die "setpgid: $!\\n"; exec @ARGV or exit 127`;

/** The group's leader, held so that its input stays open. */
let leader: ChildProcess | undefined;
let group: Promise<number | null> | undefined;

/** The process group all guests' commands run in, or null without Perl. */
function fakeGroup(): Promise<number | null> {
  group ??= new Promise((resolve) => {
    const lead = spawn("perl", ["-e", LEAD], { stdio: ["pipe", "pipe", "inherit"] });
    leader = lead;
    lead.once("error", () => resolve(null));
    lead.stdout.once("data", () => {
      lead.stdout.destroy();
      resolve(lead.pid!);
    });
    // The test process need not wait for it.
    lead.unref();
    (lead.stdin as Socket).unref();
  });
  return group;
}

/** Runs scripts in the guest's directory with sh. A stopped guest does not answer. */
export class FakeTransport implements CommandTransport {
  readonly #home: string;
  readonly #line: CommandLine;
  readonly #power: () => Promise<PowerState | null>;
  /** Aborted when the guest is deleted. */
  readonly #gone: AbortSignal;
  /** The group its commands run in, known once a call finds the guest answers. */
  #group: number | null = null;

  constructor(home: string, power: () => Promise<PowerState | null>, gone: AbortSignal = new AbortController().signal, shell?: string) {
    this.#home = home;
    const env = { PATH: process.env.PATH, HOME: home, ...(shell ? { SHELL: shell } : {}) };
    const sh = (script: string) => ["sh", "-c", script] as const;
    this.#line = new CommandLine({
      argv: (script) => (this.#group === null ? sh(script) : ["perl", "-e", JOIN, String(this.#group), ...sh(script)]),
      cwd: home,
      env,
    });
    this.#power = power;
    this.#gone = gone;
  }

  #signal(signal?: AbortSignal): AbortSignal {
    return signal ? AbortSignal.any([signal, this.#gone]) : this.#gone;
  }

  async probe(): Promise<boolean> {
    return (await this.#power()) === "running";
  }

  async #answer(): Promise<void> {
    if (!(await this.probe())) throw new TransportError("unreachable", "The fake box is not running.");
    this.#group = await fakeGroup();
  }

  async run(script: string, options?: RunOptions): Promise<RunResult> {
    await this.#answer();
    return this.#line.run(script, { ...options, signal: this.#signal(options?.signal) });
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    await this.#answer();
    return this.#line.stream(script, { ...options, signal: this.#signal(options.signal) });
  }

  async writeFile(path: string, data: Uint8Array, options?: { mode?: string; signal?: AbortSignal }): Promise<void> {
    await this.#answer();
    return this.#line.writeFile(path, data, { ...options, signal: this.#signal(options?.signal) });
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    await this.#answer();
    return this.#line.readFile(path, { ...options, signal: this.#signal(options.signal) });
  }

  /** A fake box's ports are the test machine's. */
  async route(port: number): Promise<Route> {
    await this.#answer();
    return { type: "tcp", host: "127.0.0.1", port };
  }

  async spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    await this.#answer();
    // The fake Cua Driver is the box's cua-driver command.
    const path = `${FAKE_CUA_BIN}:${process.env.PATH ?? ""}`;
    return openRoute({ type: "command", argv: ["sh", "-c", `cd ${quote(this.#home)} && PATH=${quote(path)} && export PATH && ${script}`] }, this.#signal(signal));
  }
  /** A shell on the test machine in the fake box's home, on a PTY. */
  async terminal(size: TerminalSize, signal?: AbortSignal): Promise<Terminal> {
    await this.#answer();
    return openTerminal(["sh", "-c", `cd ${quote(this.#home)} && exec sh -i`], size, this.#signal(signal));
  }
}

/**
 * A driver for the fake backend (029). Its one field, "address", must be
 * set unless it is "broken". Hosts are named as the fake guests name theirs.
 * Its settings before the configuration, "fake-enabled" and "fake-broken",
 * move into it like any backend's.
 */
export function fakeDriver(
  root: string,
  world: { backend: FakeBackend | null; contexts?: BackendContext[] } = { backend: null },
  options: Partial<FakeBackendOptions> = {},
): BackendDriver<{ address: string }> {
  return {
    type: "fake",
    label: "Fake host",
    description: "Guests in directories on this machine.",
    nature: options.nature ?? "virtual",
    form: options.nature === "real" ? "Physical" : "VM",
    kinds: (options.kinds ?? FAKE_KINDS).map((kind) => kind.id),
    fields: {
      address: { type: "string", label: "Address", description: "Where the fake host is.", group: "connection", default: "here" },
      token: { type: "string", label: "Token", group: "credentials", secret: true },
    },
    hostFields: { address: { type: "string", label: "Address", group: "connection", default: "" } },
    setup: { guide: "setup/fake/README.md", scripts: ["setup/fake/host.sh"] },
    parse(part) {
      if (part.fields.address === "broken") return { ok: false, problems: [{ path: "address", message: "Fill in the fake host's address." }] };
      return { ok: true, config: { address: String(part.fields.address) } };
    },
    create(_config, context) {
      world.contexts?.push(context);
      return (world.backend = new FakeBackend({ ...options, root, id: context.id, storage: context.storage, installId: context.installId, warm: context.warm }));
    },
    earlier: {
      settings: {
        "fake-enabled": { type: "boolean", label: "Fake host", description: "Use the fake host.", default: false },
        "fake-broken": { type: "boolean", label: "Broken", description: "Make the settings wrong.", default: false },
        "fake-token": { type: "string", label: "Token", secret: true },
      },
      read(values) {
        if (values["fake-enabled"] !== true && values["fake-broken"] !== true && !values["fake-token"]) return null;
        const fields: Record<string, string> = values["fake-broken"] === true ? { address: "broken" } : {};
        const secrets: Record<string, string> = typeof values["fake-token"] === "string" && values["fake-token"] ? { token: values["fake-token"] } : {};
        return { enabled: values["fake-enabled"] === true, fields, secrets, warm: {} };
      },
    },
  };
}
