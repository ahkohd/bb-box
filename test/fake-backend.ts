// An in-memory backend for tests. Each guest is a directory on this machine,
// and its commands run there with sh through the same command line code as
// SSH. It acts as a virtual backend (acquire makes a guest, release deletes
// it) or a real one (a fixed set of machines, claimed through the shared ready
// pool, reset and returned on release). State lives in backend storage, so a
// new instance on the same storage and root finds the same guests, as after a
// restart. Desktops stream from a local server that sends an RFB greeting.

import { mkdir, rm } from "node:fs/promises";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import { KvPoolStore, ReadyPool, type PoolMachine } from "../src/backends/pool.ts";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
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
import {
  TransportError,
  type ByteChannel,
  type CommandTransport,
  type Display,
  type Route,
  type RunOptions,
  type RunResult,
  type StreamOptions,
} from "../src/transports/types.ts";

export interface FakeBackendOptions {
  readonly root: string;
  readonly storage: BackendStorage;
  readonly id?: string;
  readonly nature?: MachineNature;
  /** The kinds it offers. FAKE_KINDS by default. */
  readonly kinds?: readonly BoxKind[];
  /** Real: how many machines the pool has. */
  readonly machines?: number;
  /** Virtual: most guests at once. */
  readonly maxGuests?: number;
  /** Whether it can stop and start guests. True by default. */
  readonly stopStart?: boolean;
}

/** Faults a test can inject. Each is used once. */
export interface FakeFaults {
  /** Fails the acquire after the guest is claimed, or after it started. */
  acquire?: { at: "claimed" | "started"; error: Error };
  release?: Error;
  /** Real: the reset fails, so the machine goes out of service with this reason. */
  reset?: string;
  doctor?: string;
}

interface GuestRecord {
  readonly owner: BoxIdentity | null;
  readonly power: PowerState;
}

const HOST = "fake";

const COMMAND: CommandCapability = { transport: "local", shell: "sh", admin: false, inDesktopSession: false, streaming: true };

/** The test machine's architecture, since the fake box's commands run there. */
const ARCH = process.arch === "arm64" ? "arm64" : "x86_64";

export const FAKE_KINDS: readonly BoxKind[] = [
  {
    id: "linux-headless",
    label: "Linux headless",
    description: "A fake box: a directory on the test machine.",
    size: "1 core",
    requires: [],
    capabilities: { os: "linux", arch: ARCH, gpu: false, features: [], command: COMMAND, displays: [], computerUse: null, enrol: true },
    readyTimeoutMs: 10_000,
  },
  {
    id: "linux-desktop",
    label: "Linux desktop",
    description: "A fake box with a fake desktop stream.",
    size: "2 cores",
    requires: [],
    capabilities: {
      os: "linux",
      arch: ARCH,
      gpu: false,
      features: [],
      command: COMMAND,
      displays: [{ id: "desktop", protocol: "rfb", resizable: true }],
      computerUse: null,
      enrol: true,
    },
    readyTimeoutMs: 10_000,
  },
];

export class FakeBackend implements Backend {
  readonly id: string;
  readonly label: string;
  readonly nature: MachineNature;
  readonly restores?: "home" | "machine";
  readonly faults: FakeFaults = {};
  /** Acquires wait here after the claim while it is set. */
  gate: Promise<void> | null = null;
  readonly calls: string[] = [];
  readonly start?: (guest: Guest) => Promise<void>;
  readonly stop?: (guest: Guest) => Promise<void>;
  readonly members?: () => Promise<readonly PoolMember[]>;
  readonly returnToService?: (ref: string) => Promise<void>;
  readonly #options: FakeBackendOptions;
  readonly #kinds: readonly BoxKind[];
  readonly #storage: BackendStorage;
  readonly #pool: KvPoolStore<BoxIdentity>;
  readonly #ready: ReadyPool<BoxIdentity>;
  #vnc: Promise<Server> | null = null;

  constructor(options: FakeBackendOptions) {
    this.#options = options;
    this.#kinds = options.kinds ?? FAKE_KINDS;
    this.#storage = options.storage;
    this.id = options.id ?? "fake";
    this.nature = options.nature ?? "virtual";
    this.label = this.nature === "real" ? "Fake machine pool" : "Fake host";
    this.#pool = new KvPoolStore(this.#storage, () => this.machines());
    this.#ready = new ReadyPool(this.#pool);
    if (options.stopStart ?? true) {
      this.start = (guest) => this.#power(guest, "running");
      this.stop = (guest) => this.#power(guest, "stopped");
    }
    if (this.nature === "real") {
      this.restores = "home";
      this.members = () => this.#pool.members();
      this.returnToService = (ref) => this.#pool.returnToService(ref);
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

  async capacity(kind: string, pending: readonly string[]): Promise<Capacity> {
    this.#kind(kind);
    if (this.nature === "real") {
      const members = (await this.#pool.members()).filter((member) => member.kinds.includes(kind));
      const free = members.filter((member) => member.state === "free").length;
      const ok = free > pending.length;
      const machines: Limit = { resource: "machines", used: members.length - free + pending.length, total: members.length, reserve: 0, unit: "count" };
      return {
        ok,
        message: ok ? null : `All ${members.length} machines are in use. Release a box to free one.`,
        warm: null,
        hosts: [{ host: HOST, ok, limits: [machines] }],
      };
    }
    const used = (await this.#storage.list("guest/")).length + pending.length;
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
        const member = await this.#ready.claim(box.kind, box, {
          before: async (candidate) => {
            guest = this.#guest(candidate.ref, candidate.generation);
            await hooks.claim(guest);
          },
          signal,
        });
        if (!member) throw new BackendError("no_capacity", "All machines are in use. Release a box to free one.");
      }
      if (!guest) {
        const counter = ((await this.#storage.get<number>("counter")) ?? 0) + 1;
        await this.#storage.set("counter", counter);
        guest = this.#guest(`g${counter}`, null);
        await hooks.claim(guest);
        signal.throwIfAborted();
        await this.#storage.set(`guest/${guest.ref}`, { owner: box, power: "stopped" } satisfies GuestRecord);
      }
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
      if (guest) await this.#discard(guest, null);
      throw error;
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks): Promise<void> {
    this.calls.push(`release ${guest.ref}`);
    const error = this.faults.release;
    if (error) {
      delete this.faults.release;
      throw error;
    }
    await this.#discard(guest, hooks);
  }

  async power(guest: Guest): Promise<PowerState | null> {
    if (this.nature === "real") return (await this.#storage.get<PowerState>(`power/${guest.ref}`)) ?? "running";
    return (await this.#storage.get<GuestRecord>(`guest/${guest.ref}`))?.power ?? null;
  }

  async held(): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    const guests =
      this.nature === "real"
        ? (await this.#pool.members()).filter((member) => member.state === "held").map((member) => this.#guest(member.ref, member.generation))
        : (await this.#storage.list("guest/")).map((key) => this.#guest(key.slice("guest/".length), null));
    for (const guest of guests) {
      const power = await this.power(guest);
      if (!power) continue;
      const owner = await this.#owner(guest.ref);
      held.push({
        ...guest,
        owner: owner && { boxId: owner.boxId, threadId: owner.threadId, name: owner.name, kind: owner.kind, createdAt: owner.createdAt },
        power,
      });
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const displays = this.#kind(kind).capabilities.displays.map(
      (display): Display => ({
        id: display.id,
        label: "Desktop",
        protocol: display.protocol,
        resizable: display.resizable,
        open: async () => ({ route: { type: "tcp", host: "127.0.0.1", port: await this.#vncPort() }, auth: { type: "none" } }),
      }),
    );
    return { command: new FakeTransport(this.#home(guest.ref), () => this.power(guest)), displays, access: null };
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

  async maintain(): Promise<void> {
    this.calls.push("maintain");
  }

  async dispose(): Promise<void> {
    const server = await this.#vnc;
    this.#vnc = null;
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  }

  #kind(kind: string): BoxKind {
    const found = this.#kinds.find((candidate) => candidate.id === kind);
    if (!found) throw new BackendError("unsupported", `${this.label} has no ${kind} boxes.`);
    return found;
  }

  /** A real machine's guest carries the reset generation it was claimed at, so a stale release cannot reset the next box's machine. */
  #guest(ref: string, generation: number | null): Guest {
    const address = this.machines().find((machine) => machine.ref === ref)?.address ?? null;
    return generation === null ? { ref, host: HOST, address } : { ref, host: HOST, address, data: { generation } };
  }

  #home(ref: string): string {
    return join(this.#options.root, this.id, ref);
  }

  async #owner(ref: string): Promise<BoxIdentity | null> {
    if (this.nature === "real") {
      const state = await this.#pool.state(ref);
      return state.state === "held" ? state.holder : null;
    }
    return (await this.#storage.get<GuestRecord>(`guest/${ref}`))?.owner ?? null;
  }

  async #power(guest: Guest, power: PowerState): Promise<void> {
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
      await rm(this.#home(guest.ref), { recursive: true, force: true });
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
    await rm(this.#home(guest.ref), { recursive: true, force: true });
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

  #vncPort(): Promise<number> {
    this.#vnc ??= new Promise((resolve, reject) => {
      const server = createServer((socket) => socket.end("RFB 003.008\n"));
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
    return this.#vnc.then((server) => (server.address() as AddressInfo).port);
  }
}

/** Runs scripts in the guest's directory with sh. A stopped guest does not answer. */
export class FakeTransport implements CommandTransport {
  readonly #home: string;
  readonly #line: CommandLine;
  readonly #power: () => Promise<PowerState | null>;

  constructor(home: string, power: () => Promise<PowerState | null>) {
    this.#home = home;
    this.#line = new CommandLine({ argv: (script) => ["sh", "-c", script], cwd: home, env: { PATH: process.env.PATH, HOME: home } });
    this.#power = power;
  }

  async probe(): Promise<boolean> {
    return (await this.#power()) === "running";
  }

  async #answer(): Promise<void> {
    if (!(await this.probe())) throw new TransportError("unreachable", "The fake box is not running.");
  }

  async run(script: string, options?: RunOptions): Promise<RunResult> {
    await this.#answer();
    return this.#line.run(script, options);
  }

  async stream(script: string, options: StreamOptions): Promise<{ exitCode: number | null; timedOut: boolean }> {
    await this.#answer();
    return this.#line.stream(script, options);
  }

  async writeFile(path: string, data: Uint8Array, options?: { mode?: string; signal?: AbortSignal }): Promise<void> {
    await this.#answer();
    return this.#line.writeFile(path, data, options);
  }

  async readFile(path: string, options: { maxBytes: number; signal?: AbortSignal }): Promise<Uint8Array> {
    await this.#answer();
    return this.#line.readFile(path, options);
  }

  /** A fake box's ports are the test machine's. */
  async route(port: number): Promise<Route> {
    await this.#answer();
    return { type: "tcp", host: "127.0.0.1", port };
  }

  async spawn(script: string, signal?: AbortSignal): Promise<ByteChannel> {
    await this.#answer();
    return openRoute({ type: "command", argv: ["sh", "-c", `cd ${quote(this.#home)} && ${script}`] }, signal);
  }
}
