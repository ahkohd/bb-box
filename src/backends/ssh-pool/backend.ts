// The SSH host pool backend. It lends Linux machines the operator already
// has, reached over SSH, one box per machine. bb-box logs in as its admin
// user on each machine and runs only its helper, setup/ssh-pool/machine.sh,
// as root through sudo. The helper claims the machine for a box by making a
// new user for it, bbx-<generation>, whose SSH the box's commands use, and
// releases it by removing that user and everything the user left. The reset
// generation counts completed resets: a claim names the generation it
// expects, so a machine is never lent twice without a reset between.
//
// The truth is on the machine (016, 018). The helper's markers in
// /var/lib/bb-box say which install and box hold it, or that it is being
// reset, and every method reads them before it acts. bb-box's storage keeps
// only what the machine cannot say: that a machine is out of service and
// why, the generation it last saw, and the box on a machine that does not
// answer. A new instance on empty storage finds every box from the markers.
//
// A reset that fails puts the machine out of service. It comes back when
// returnToService resets it again, or when the operator runs the helper's
// reset on the machine, which bb-box sees as a clean machine at a later
// generation.

import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendContext,
  type BoxIdentity,
  type BoxKind,
  type BoxOwner,
  type BoxTransports,
  type Capacity,
  type CommandCapability,
  type DoctorCheck,
  type DoctorReport,
  type Guest,
  type GuestFact,
  type HeldGuest,
  type PoolMember,
  type PowerState,
  type ReleaseHooks,
} from "../types.ts";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import { KeyFile, Ssh, SshTransport, generateKeyPair, publicKey } from "../../transports/ssh.ts";
import type { RunResult, SshAccess } from "../../transports/types.ts";
import { hostKeysFor, type SshPoolConfig, type SshPoolHost, type SshPoolKind, type SshPoolMachine } from "./config.ts";
import { EXIT, HELPER_COMMAND, HELPER_VERSION, claimInput, fields, parseStatus, releaseInput, type MachineStatus, type Marker } from "./protocol.ts";

const SSH_KEY = "ssh-key";
const RECORD = "machine/";
const USER_PREFIX = "bbx-";
const ARCH = "x86_64";
/** The pool's single entry in capacity. */
const POOL_HOST = "SSH host pool";
/** Claiming makes a user; SSH as it answers at once. This leaves room for a slow machine or jump host. */
const READY_TIMEOUT_MS = 60_000;
const STATUS_TIMEOUT_MS = 20_000;
const CLAIM_TIMEOUT_MS = 60_000;
/** The helper waits this long for its lock, and a whole-machine reset may take as long. */
const RESET_TIMEOUT_MS = 15 * 60_000;
const RESET_POLL_MS = 2_000;

const SSH_COMMAND: CommandCapability = { transport: "ssh", shell: "sh", admin: false, inDesktopSession: false, streaming: true };

const OFFERS: readonly BoxKind[] = [
  {
    id: "linux",
    label: "Linux",
    description: "A Linux machine of its own, for builds, backend services and the agent's own work.",
    size: "A whole machine from the pool",
    requires: [],
    capabilities: { os: "linux", arch: ARCH, gpu: false, features: [], command: SSH_COMMAND, displays: [], computerUse: null, enrol: true },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
  {
    id: "linux-docker",
    label: "Linux with Docker",
    description: "A Linux machine of its own with Docker, and root through sudo, for builds and services that need them.",
    size: "A whole machine from the pool",
    requires: ["docker"],
    capabilities: {
      os: "linux",
      arch: ARCH,
      gpu: false,
      features: ["docker"],
      command: { ...SSH_COMMAND, admin: true },
      displays: [],
      computerUse: null,
      enrol: true,
    },
    readyTimeoutMs: READY_TIMEOUT_MS,
  },
];

export interface SshPoolBackendOptions {
  readonly sshBinary?: string;
  /** Replaces the command that runs the helper as root, for tests. */
  readonly helperCommand?: string;
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Replaces each kind's readyTimeoutMs, for tests. */
  readonly readyTimeoutMs?: number;
  /** How long a reset may take, and how often a whole-machine reset is checked. For tests. */
  readonly resetTimeoutMs?: number;
  readonly resetPollMs?: number;
}

/** What bb-box keeps about a machine. The machine's markers say the rest. */
interface MachineRecord {
  readonly state: PoolMember["state"];
  readonly since: number;
  /** The machine's reset generation when the record was written. */
  readonly generation: number;
  readonly reason: string | null;
  /** The box that holds it, for when the machine does not answer. */
  readonly owner: BoxOwner | null;
  readonly user: string | null;
}

/** What the helper's status said, or why it said nothing. */
interface Probe {
  readonly status: MachineStatus | null;
  /** True when SSH itself failed. */
  readonly unreachable: boolean;
  readonly problem: string | null;
}

/** A machine as bb-box sees it now. */
interface View {
  readonly machine: SshPoolMachine;
  readonly probe: Probe;
  readonly record: MachineRecord | null;
  readonly state: PoolMember["state"];
  readonly reason: string | null;
  readonly generation: number;
  readonly since: number;
}

interface SshKeys {
  readonly ssh: Ssh;
  readonly publicKey: string | null;
  readonly generated: boolean;
}

type Check = readonly [id: string, name: string];
const SSH_KEY_CHECK: Check = ["ssh.key", "SSH key"];

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The last lines of a command's error output, for a reason or a doctor check. */
function said(result: RunResult): string {
  const text = result.stderr.trim().split("\n").slice(-3).join(" ").trim();
  if (text) return text.replace(/\.?$/, ".");
  return result.timedOut ? "It did not finish in time." : `It exited with ${result.exitCode}.`;
}

function whole(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function ownerOf(box: BoxIdentity): BoxOwner {
  return { boxId: box.boxId, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt };
}

function markerOwner(marker: Marker): BoxOwner | null {
  if (!marker.box) return null;
  return { boxId: marker.box, threadId: marker.thread ?? "", name: marker.name, kind: marker.kind, createdAt: marker.createdAt };
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

export class SshPoolBackend implements Backend {
  readonly id = "ssh-pool";
  readonly nature = "real" as const;
  readonly label: string;
  readonly restores: "home" | "machine";
  readonly #config: SshPoolConfig;
  readonly #context: BackendContext;
  readonly #options: SshPoolBackendOptions;
  readonly #keyFile = new KeyFile();
  readonly #machines: ReadonlyMap<string, SshPoolMachine>;
  /** Machines this process is resetting, which held() leaves to it. */
  readonly #resetting = new Set<string>();
  /** Machines this process is claiming, whose record the claim writes. */
  readonly #claiming = new Set<string>();
  /** The kinds of boxes whose acquire in this process has claimed a machine and not finished. */
  readonly #claimed = new Map<string, string>();
  #ssh: Promise<SshKeys> | null = null;
  /** Claims in this process go one at a time, so two never pick the same machine. */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(config: SshPoolConfig, context: BackendContext, options: SshPoolBackendOptions = {}) {
    this.#config = config;
    this.#context = context;
    this.#options = options;
    this.#machines = new Map(config.machines.map((machine) => [machine.name, machine]));
    this.label = `SSH host pool of ${plural(config.machines.length, "machine")}`;
    this.restores = config.machines.length && config.machines.every((machine) => machine.reset === "machine") ? "machine" : "home";
  }

  kinds(): readonly BoxKind[] {
    return OFFERS.filter((kind) => this.#config.machines.some((machine) => machine.kinds.includes(kind.id as SshPoolKind)));
  }

  #offer(kind: string): BoxKind {
    const offer = this.kinds().find((candidate) => candidate.id === kind);
    if (!offer) throw new BackendError("unsupported", `The SSH host pool has no machine for kind ${kind}. Its kinds are ${this.kinds().map((other) => other.id).join(", ")}.`);
    return offer;
  }

  async capacity(kind: string, pending: readonly string[], signal?: AbortSignal): Promise<Capacity> {
    this.#offer(kind);
    const views = (await this.#survey(signal)).filter((view) => this.#lists(view.machine, kind));
    const free = views.filter((view) => view.state === "free" && this.#ready(view, kind) === null);
    // Acquires of kinds that share a machine with this one wait for the same machines; those that have claimed one show as held.
    const shares = (other: string) => views.some((view) => this.#lists(view.machine, other));
    const waiting = Math.max(0, pending.filter(shares).length - [...this.#claimed.values()].filter(shares).length);
    const ok = free.length > waiting;
    const used = Math.min(views.length, views.length - free.length + waiting);
    return {
      ok,
      message: ok ? null : this.#full(kind, views, free.length),
      warm: null,
      hosts: [{ host: POOL_HOST, ok, limits: [{ resource: "machines", used, total: views.length, reserve: 0, unit: "count" }] }],
    };
  }

  /** Why no machine is free for `kind`, in words for the user. */
  #full(kind: string, views: readonly View[], free: number): string {
    const held = views.filter((view) => view.state === "held" && view.probe.status?.owner?.install === this.#context.installId).length;
    const others = views.filter((view) => view.state === "held").length - held;
    const resetting = views.filter((view) => view.state === "resetting").length;
    const out = views.filter((view) => view.state === "out-of-service");
    const unready = views.filter((view) => view.state === "free" && this.#ready(view, kind) !== null);
    const parts = [
      held ? `${plural(held, "is", "are")} held by this install's boxes` : "",
      others ? `${others} by another install` : "",
      resetting ? `${resetting} resetting` : "",
      out.length ? `${out.length} out of service (${out.map((view) => `${view.machine.name}: ${view.reason}`).join("; ")})` : "",
      unready.length ? `${unready.length} not ready for ${kind} (${unready.map((view) => `${view.machine.name}: ${this.#ready(view, kind)}`).join("; ")})` : "",
    ].filter(Boolean);
    const all = `${plural(views.length, "machine")} that serve${views.length === 1 ? "s" : ""} ${kind}`;
    const why = parts.length ? ` Of the ${all}, ${parts.join(", ")}.` : free ? ` Other boxes are waiting for the ${free === 1 ? "free one" : `${free} free ones`}.` : "";
    return `No machine in the SSH host pool is free for ${kind}.${why} Release a box to free one.`;
  }

  async acquire(box: BoxIdentity, previous: Guest | null, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const kind = this.#offer(box.kind);
    signal.throwIfAborted();
    if (previous) {
      const resumed = await this.#resume(box, previous, kind, hooks, signal);
      if (resumed) return resumed;
    }
    const claimed: Guest[] = [];
    try {
      let started = performance.now();
      const { machine, guest } = await this.#claim(box, kind, hooks, signal, (guest) => claimed.push(guest));
      hooks.timing("claim", performance.now() - started);
      await hooks.starting();
      started = performance.now();
      await this.#waitReady(machine, String(guest.data!.user), kind, signal);
      hooks.timing("ssh", performance.now() - started);
      return guest;
    } catch (error) {
      // Not with the signal, which may be what ended the acquire.
      for (const guest of claimed) await this.release(guest, QUIET).catch((cause) => this.#context.logError(`release ${guest.ref} after a failed acquire`, cause));
      throw error;
    } finally {
      this.#claimed.delete(box.boxId);
    }
  }

  /** Picks up an acquire a restart interrupted, when its machine still names the box; otherwise releases it. */
  async #resume(box: BoxIdentity, previous: Guest, kind: BoxKind, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest | null> {
    const machine = this.#machines.get(previous.ref);
    const generation = whole(previous.data?.generation);
    const user = previous.data?.user;
    if (machine && generation !== null && typeof user === "string") {
      const probe = await this.#status(machine, signal);
      const marker = probe.status?.owner;
      if (probe.status?.marker === "owner" && marker?.install === this.#context.installId && marker.box === box.boxId && marker.generation === generation) {
        await hooks.starting();
        try {
          await this.#waitReady(machine, user, kind, signal);
          return previous;
        } catch (error) {
          signal.throwIfAborted();
          this.#context.logError(`resume ${machine.name}`, error);
        }
      }
    }
    await this.release(previous, QUIET).catch((error) => this.#context.logError(`release ${previous.ref} before a new claim`, error));
    signal.throwIfAborted();
    return null;
  }

  /** Claims the first free machine for the kind, with the fewest other kinds, free longest. */
  #claim(
    box: BoxIdentity,
    kind: BoxKind,
    hooks: AcquireHooks,
    signal: AbortSignal,
    onClaim: (guest: Guest) => void,
  ): Promise<{ machine: SshPoolMachine; guest: Guest }> {
    return this.#exclusive(async () => {
      const views = (await this.#survey(signal)).filter((view) => this.#lists(view.machine, kind.id));
      const candidates = views
        .filter((view) => view.state === "free" && this.#ready(view, kind.id) === null)
        .sort((a, b) => a.machine.kinds.length - b.machine.kinds.length || a.since - b.since);
      const { publicKey } = await this.#keys();
      if (!publicKey) throw new Error("ssh-keygen cannot read the SSH private key in bb-box's settings. Paste the whole key, or clear it so bb-box makes one.");
      for (const view of candidates) {
        const { machine } = view;
        const generation = view.probe.status!.generation!;
        const user = `${USER_PREFIX}${generation}`;
        const guest = this.#guest(machine, box.boxId, generation, user);
        await hooks.claim(guest);
        onClaim(guest);
        signal.throwIfAborted();
        this.#claiming.add(machine.name);
        try {
          // Without the signal: a claim cut short could finish on the machine after bb-box looked.
          const docker = kind.requires.includes("docker") ? ["docker"] : [];
          const result = await this.#helper(machine, ["claim", String(generation), ...docker], claimInput(this.#context.installId, box, publicKey), CLAIM_TIMEOUT_MS);
          if (result.exitCode === EXIT.held || result.exitCode === EXIT.moved || result.exitCode === 255 || result.timedOut) continue;
          if (result.exitCode === EXIT.dirty) {
            await this.#outOfService(machine, generation, said(result));
            continue;
          }
          if (result.exitCode !== EXIT.ok) throw new Error(`Machine ${machine.name} could not be claimed: ${said(result)}`);
          this.#claimed.set(box.boxId, kind.id);
          await this.#write(machine, { state: "held", since: Date.now(), generation, reason: null, owner: ownerOf(box), user });
          return { machine, guest };
        } finally {
          this.#claiming.delete(machine.name);
        }
      }
      throw new BackendError("no_capacity", this.#full(kind.id, views, 0));
    });
  }

  async #waitReady(machine: SshPoolMachine, user: string, kind: BoxKind, signal: AbortSignal): Promise<void> {
    const timeoutMs = this.#options.readyTimeoutMs ?? kind.readyTimeoutMs;
    const command = await this.#command(machine, user);
    // Through the shared connection, which the box's first commands then use.
    const answers = { probe: (signal?: AbortSignal) => command.answers(signal) };
    const ready = await waitUntilAnswers(answers, { timeoutMs, intervalMs: 250, signal, sleep: this.#options.sleep });
    if (!ready) {
      throw new Error(
        `Machine ${machine.name} made box user ${user}, but SSH as ${user} did not answer within ${Math.round(timeoutMs / 1000)} s. ` +
          `Check that sshd on ${machine.name} lets users ${USER_PREFIX}* log in with a key, as the setup guide says.`,
      );
    }
  }

  async release(guest: Guest, hooks: ReleaseHooks, signal?: AbortSignal): Promise<void> {
    const machine = this.#machines.get(guest.ref);
    const generation = whole(guest.data?.generation);
    // A machine no longer in the settings is no longer bb-box's to reset.
    if (!machine || generation === null) return;
    const box = typeof guest.data?.box === "string" ? guest.data.box : null;
    const record = await this.#read(machine);
    if (record?.state === "out-of-service") return;
    const probe = await this.#status(machine, signal);
    if (!probe.status) throw new Error(`Machine ${machine.name} cannot be reset now: ${probe.problem} bb-box tries again later.`);
    const { status } = probe;
    const marker = status.owner;
    const ours =
      marker !== null &&
      marker.install === this.#context.installId &&
      marker.generation === generation &&
      (box ? marker.box === box : status.marker === "resetting");
    if (!ours) {
      // Never claimed, already reset, or another box's: there is nothing to do.
      if (status.marker === "none" && status.generation !== null && record && record.state !== "free" && (record.owner?.boxId ?? null) === box) {
        await this.#write(machine, { state: "free", since: Date.now(), generation: status.generation, reason: null, owner: null, user: null });
      }
      return;
    }
    await hooks.resetting();
    const started = performance.now();
    const user = marker.user ?? `${USER_PREFIX}${generation}`;
    this.#resetting.add(machine.name);
    try {
      await this.#write(machine, { state: "resetting", since: Date.now(), generation, reason: null, owner: markerOwner(marker), user });
      await (await this.#keys()).ssh.forget(this.#access(machine, user));
      const args = ["release", String(generation), ...(machine.reset === "machine" ? ["machine"] : [])];
      const outcome = await this.#reset(machine, args, releaseInput(this.#context.installId, box), signal);
      if (outcome.generation !== null) {
        await this.#write(machine, { state: "free", since: Date.now(), generation: outcome.generation, reason: null, owner: null, user: null });
      } else if (outcome.reason !== null) {
        await this.#outOfService(machine, generation, outcome.reason);
        this.#context.logError(`reset ${machine.name}`, new Error(outcome.reason));
      }
    } finally {
      this.#resetting.delete(machine.name);
    }
    hooks.timing("reset", performance.now() - started);
  }

  /**
   * Runs a release or reset, asking again while a whole-machine reset runs.
   * Gives the new generation, or the reason it failed, or neither when the
   * machine turned out to be another box's.
   */
  async #reset(machine: SshPoolMachine, args: readonly string[], input: string, signal?: AbortSignal): Promise<{ generation: number | null; reason: string | null }> {
    const timeoutMs = this.#options.resetTimeoutMs ?? RESET_TIMEOUT_MS;
    const deadline = Date.now() + timeoutMs;
    const sleep = this.#options.sleep ?? pause;
    let restoring = false;
    for (;;) {
      const result = await this.#helper(machine, args, input, Math.max(1_000, deadline - Date.now()), signal);
      signal?.throwIfAborted();
      if (result.exitCode === EXIT.ok) {
        const generation = Number(fields(result.stdout).get("generation"));
        if (Number.isInteger(generation)) return { generation, reason: null };
        return { generation: null, reason: `The helper did not say the machine's new generation: ${result.stdout.trim().slice(0, 200)}` };
      }
      if (result.exitCode === EXIT.notOurs) return { generation: null, reason: null };
      if (result.exitCode === EXIT.restoring) restoring = true;
      else if (!(restoring && (result.exitCode === 255 || result.timedOut))) {
        // In a home reset, SSH failing means the machine went away mid-reset: the sweep finishes it later.
        if (result.exitCode === 255 || result.timedOut) throw new Error(`Machine ${machine.name} stopped answering during its reset: ${said(result)} bb-box finishes the reset later.`);
        return { generation: null, reason: `Its reset failed: ${said(result)}` };
      }
      // The whole-machine reset runs on, and may restart the machine.
      if (Date.now() >= deadline) {
        return { generation: null, reason: `Its whole-machine reset did not finish within ${Math.round(timeoutMs / 60_000)} minutes.` };
      }
      await sleep(this.#options.resetPollMs ?? RESET_POLL_MS, signal);
    }
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const machine = this.#machines.get(guest.ref);
    if (!machine) return null;
    const probe = await this.#status(machine, signal);
    if (!probe.status) return "unknown";
    const marker = probe.status.owner;
    const box = guest.data?.box;
    const ours =
      probe.status.marker === "owner" &&
      typeof box === "string" &&
      marker?.install === this.#context.installId &&
      marker.box === box &&
      marker.generation === whole(guest.data?.generation);
    return ours ? "running" : null;
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    for (const { machine, probe, record } of await this.#survey(signal)) {
      if (record?.state === "out-of-service" || this.#resetting.has(machine.name)) continue;
      const { status } = probe;
      if (!status) {
        // The record names the box on a machine that does not answer, so the sweep keeps it.
        if (record?.state === "held" && record.owner && record.user) {
          held.push({ ...this.#guest(machine, record.owner.boxId, record.generation, record.user), owner: record.owner, power: "unknown" });
        }
        continue;
      }
      const marker = status.owner;
      if (!marker || marker.install !== this.#context.installId || marker.generation === null) continue;
      const user = marker.user ?? `${USER_PREFIX}${marker.generation}`;
      const owner = status.marker === "owner" ? markerOwner(marker) : null;
      // A machine part-way through its reset has no owner, so the sweep finishes the reset.
      held.push({ ...this.#guest(machine, owner?.boxId ?? null, marker.generation, user), owner, power: "running" });
    }
    return held;
  }

  async transports(guest: Guest, kind: string): Promise<BoxTransports> {
    const machine = this.#machines.get(guest.ref);
    if (!machine) throw new BackendError("gone", `Machine ${guest.ref} is no longer in the SSH host pool's settings.`);
    const user = typeof guest.data?.user === "string" ? guest.data.user : `${USER_PREFIX}${guest.data?.generation}`;
    const access = this.#access(machine, user);
    const docker = OFFERS.find((offer) => offer.id === kind)?.capabilities.features.includes("docker") ?? false;
    const host = access.host.includes(":") ? `[${access.host}]` : access.host;
    return {
      command: await this.#command(machine, user),
      displays: [],
      access: {
        ssh: access,
        // DOCKER_HOST cannot go through a jump host.
        dockerHost: docker && !machine.jump ? `ssh://${user}@${host}${access.port === 22 ? "" : `:${access.port}`}` : null,
      },
    };
  }

  async members(signal?: AbortSignal): Promise<readonly PoolMember[]> {
    return (await this.#survey(signal)).map((view) => ({
      ref: view.machine.name,
      host: view.machine.name,
      kinds: view.machine.kinds,
      state: view.state,
      reason: view.state === "out-of-service" ? view.reason : null,
      since: view.since,
      generation: view.generation,
    }));
  }

  /**
   * Resets a machine out of service and lends it again. The reset completes
   * the one that failed, so the generation moves on by one. A machine held
   * by a box or by another install is left alone.
   */
  async returnToService(ref: string, signal?: AbortSignal): Promise<void> {
    const machine = this.#machines.get(ref);
    if (!machine) throw new Error(`There is no machine ${ref} in the SSH host pool.`);
    const view = await this.#look(machine, signal);
    if (view.state === "free") return;
    if (view.state !== "out-of-service") throw new Error(`Machine ${ref} is ${view.state}, not out of service.`);
    const { status } = view.probe;
    if (!status) throw new Error(`Machine ${ref} cannot be reset: ${view.probe.problem}`);
    if (status.owner && status.owner.install !== this.#context.installId) {
      throw new Error(`Machine ${ref} is held by another bb-box install, ${status.owner.install || "with no ID"}. Leave it to that install.`);
    }
    this.#resetting.add(ref);
    try {
      const args = ["reset", ...(machine.reset === "machine" ? ["machine"] : [])];
      const outcome = await this.#reset(machine, args, releaseInput(this.#context.installId, null), signal);
      if (outcome.generation === null) {
        const reason = outcome.reason ?? "Another bb-box install holds it.";
        await this.#outOfService(machine, status.generation ?? view.generation, reason);
        throw new Error(`Machine ${ref} is still out of service. ${reason}`);
      }
      await this.#write(machine, { state: "free", since: Date.now(), generation: outcome.generation, reason: null, owner: null, user: null });
    } finally {
      this.#resetting.delete(ref);
    }
  }

  async doctor(signal?: AbortSignal): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const notes: string[] = [`This install's ID is ${this.#context.installId}. The machines it holds name it in /var/lib/bb-box/owner.`];
    const pass = ([id, name]: Check, detail: string) => checks.push({ id, name, status: "ok", detail, fix: null });
    const warn = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "warn", detail, fix });
    const fail = ([id, name]: Check, detail: string, fix: string) => checks.push({ id, name, status: "fail", detail, fix });
    const skip = (...skipped: Check[]) => {
      for (const [id, name] of skipped) checks.push({ id, name, status: "skipped", detail: "An earlier check failed.", fix: null });
    };

    let keys: SshKeys | null = null;
    try {
      keys = await this.#keys();
      if (keys.publicKey) {
        pass(SSH_KEY_CHECK, keys.generated ? "bb-box made a key; its public key is below." : "From bb-box's settings; its public key is below.");
        notes.push(`Give setup/ssh-pool/setup.sh this public key with --key, so each machine's admin user accepts it: ${keys.publicKey}`);
      } else {
        fail(SSH_KEY_CHECK, "ssh-keygen cannot read the SSH private key in bb-box's settings.", "Paste the whole private key, or clear the setting so bb-box makes one.");
      }
    } catch (error) {
      fail(SSH_KEY_CHECK, message(error), "Check the SSH private key in bb-box's settings, or clear it so bb-box makes one.");
    }

    const views = keys?.publicKey ? await this.#survey(signal) : [];
    const others = new Map<string, number>();
    for (const machine of this.#config.machines) {
      const name = machine.name;
      const check = (what: string, label: string): Check => [`machine.${name}.${what}`, `${name}: ${label}`];
      const SSH = check("ssh", "SSH"), HELPER = check("helper", "helper"), ARCH_CHECK = check("arch", "architecture");
      const TOOLS = check("tools", "tools"), DOCKER = check("docker", "Docker"), STATE = check("state", "state");
      const rest = [HELPER, ARCH_CHECK, TOOLS, ...(machine.kinds.includes("linux-docker") ? [DOCKER] : []), STATE];
      const view = views.find((other) => other.machine === machine);
      const where = `${machine.admin.user}@${machine.admin.host}${machine.admin.port === 22 ? "" : `:${machine.admin.port}`}${machine.jump ? ` through ${machine.jump.host}` : ""}`;
      if (!view) {
        skip(SSH, ...rest);
        continue;
      }
      const { probe } = view;
      if (probe.unreachable) {
        const hostKey = /host key/i.test(probe.problem ?? "");
        fail(
          SSH,
          `${where} did not answer: ${probe.problem}`,
          hostKey
            ? `Put ${name}'s current host key in the host keys setting. setup.sh prints it.`
            : `Check that ${name} is on and that BB's server reaches it, and that its admin user accepts bb-box's key: run setup.sh on it with --key and the public key below.`,
        );
        skip(...rest);
        continue;
      }
      pass(SSH, `${where} answers.`);
      const { status } = probe;
      if (!status || status.helper === null) {
        fail(HELPER, `bb-box's helper did not run: ${probe.problem ?? "it gave no version."}`, `Run setup/ssh-pool/setup.sh on ${name} as root.`);
        skip(ARCH_CHECK, TOOLS, ...(machine.kinds.includes("linux-docker") ? [DOCKER] : []), STATE);
        continue;
      }
      if (status.helper < HELPER_VERSION || status.generation === null) {
        fail(
          HELPER,
          status.generation === null ? "The machine has no reset generation in /var/lib/bb-box." : `The helper is version ${status.helper}; this bb-box needs ${HELPER_VERSION}.`,
          `Run this bb-box's setup/ssh-pool/setup.sh on ${name} as root.`,
        );
      } else pass(HELPER, `Version ${status.helper}, reset generation ${status.generation}.`);
      if (status.arch === ARCH) pass(ARCH_CHECK, ARCH);
      else fail(ARCH_CHECK, `${name} is ${status.arch || "of unknown architecture"}, but its kinds promise ${ARCH}.`, `Take ${name} out of the machines list: every machine that serves a kind must be ${ARCH}.`);
      if (status.missing.length) {
        fail(TOOLS, `${name} lacks ${status.missing.join(", ")}.`, `Install them on ${name}. curl-or-wget means either. Boxes need sh, tar and curl or wget to enrol in BB.`);
      } else pass(TOOLS, status.systemd ? "Everything the helper and enrolment need, with systemd for linger." : "Everything the helper and enrolment need. There is no systemd, so BB's daemon runs without linger.");
      if (machine.kinds.includes("linux-docker")) {
        const problem = this.#ready(view, "linux-docker");
        if (problem) fail(DOCKER, problem, `Install Docker on ${name}, and its reset-machine command with setup.sh --reset-hook, or take linux-docker off its line.`);
        else pass(DOCKER, "Docker and a whole-machine reset are installed.");
      }
      if (status.owner && status.owner.install !== this.#context.installId) {
        const install = status.owner.install || "none";
        others.set(install, (others.get(install) ?? 0) + 1);
      }
      if (view.state === "out-of-service") {
        warn(
          STATE,
          `Out of service: ${view.reason}`,
          `Fix the cause on ${name}, then reset it there with "sudo /usr/local/libexec/bb-box/machine reset${machine.reset === "machine" ? " machine" : ""}". bb-box lends it again once it is clean.`,
        );
      } else pass(STATE, this.#describe(view));
    }

    if (others.size) {
      const parts = [...others].map(([install, count]) => `${plural(count, "machine")} held by ${install === "none" ? "no install ID" : `install ${install}`}`);
      notes.push(
        `This install leaves alone ${parts.join(", ")}. They still count against capacity. ` +
          "If one of these IDs was this install's before it lost its storage, take it back with bb box install-id --set <id>.",
      );
    }
    if (this.restores === "home") {
      notes.push("A release removes the box's user, its files and its processes. It does not undo changes a box made as root, which only linux-docker boxes can make.");
    }

    const ok = checks.every((check) => check.status !== "fail");
    const first = checks.find((check) => check.status === "fail");
    const free = views.filter((view) => view.state === "free").length;
    return {
      ok,
      summary: ok ? `${plural(this.#config.machines.length, "machine")}, ${free} free` : `${first!.name}: ${first!.detail}`,
      checks,
      notes,
    };
  }

  #describe(view: View): string {
    const status = view.probe.status;
    const owner = status?.owner;
    const size = [
      status?.cores ? plural(status.cores, "core") : "",
      status?.memoryMiB ? `${(status.memoryMiB / 1024).toFixed(1)} GiB memory` : "",
      status?.diskGiB !== null && status?.diskGiB !== undefined ? `${status.diskGiB} GiB free disk` : "",
    ].filter(Boolean);
    const has = size.length ? ` It has ${size.join(", ")}.` : "";
    if (view.state === "held") {
      const by = owner?.install === this.#context.installId ? `box ${owner.name ?? owner.box}` : `install ${owner?.install || "with no ID"}`;
      return `Held by ${by} at reset generation ${view.generation}.${has}`;
    }
    if (view.state === "resetting") return `Resetting after reset generation ${view.generation}.${has}`;
    return `Free at reset generation ${view.generation}.${has}`;
  }

  async dispose(): Promise<void> {
    await (await this.#ssh?.catch(() => null))?.ssh.dispose();
    await this.#keyFile.dispose();
  }

  /** The machine's kinds include `kind`. */
  #lists(machine: SshPoolMachine, kind: string): boolean {
    return machine.kinds.includes(kind as SshPoolKind);
  }

  /** Why a free machine cannot serve `kind` now, or null when it can. */
  #ready(view: View, kind: string): string | null {
    const status = view.probe.status;
    if (kind !== "linux-docker" || !status) return null;
    if (!status.docker) return "Docker is not installed.";
    if (!status.hook) return "There is no reset-machine command, so a whole-machine reset is not set up.";
    return null;
  }

  #guest(machine: SshPoolMachine, box: string | null, generation: number, user: string): Guest {
    const facts: GuestFact[] = [
      { label: "Machine", value: machine.name },
      { label: "Reset", value: machine.reset === "machine" ? "Whole machine" : "User and home" },
      ...(machine.labels.length ? [{ label: "Labels", value: machine.labels.join(", ") }] : []),
    ];
    return {
      ref: machine.name,
      host: machine.name,
      address: machine.admin.host,
      data: { ...(box ? { box } : {}), generation, user },
      facts,
    };
  }

  #access(machine: SshPoolMachine, user: string): SshAccess {
    const pinned = (host: SshPoolHost, as: string): SshAccess => ({
      host: host.host,
      port: host.port,
      user: as,
      hostKeys: hostKeysFor(this.#config.knownHosts, host),
    });
    return { ...pinned(machine.admin, user), ...(machine.jump ? { jump: pinned(machine.jump, machine.jump.user) } : {}) };
  }

  async #command(machine: SshPoolMachine, user: string): Promise<SshTransport> {
    return new SshTransport((await this.#keys()).ssh, this.#access(machine, user), "linux");
  }

  /** Runs the helper as root through the admin user. */
  async #helper(machine: SshPoolMachine, args: readonly string[], input: string | null, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    const { ssh } = await this.#keys();
    const command = [this.#options.helperCommand ?? HELPER_COMMAND, ...args].join(" ");
    return ssh.run(this.#access(machine, machine.admin.user), command, {
      ...(input !== null ? { stdin: input } : {}),
      timeoutMs,
      signal,
      maxOutputBytes: 64 * 1024,
    });
  }

  async #status(machine: SshPoolMachine, signal?: AbortSignal): Promise<Probe> {
    try {
      const result = await this.#helper(machine, ["status"], null, STATUS_TIMEOUT_MS, signal);
      if (result.exitCode === 0) return { status: parseStatus(result.stdout), unreachable: false, problem: null };
      return { status: null, unreachable: result.exitCode === 255 || result.timedOut, problem: said(result) };
    } catch (error) {
      signal?.throwIfAborted();
      return { status: null, unreachable: true, problem: message(error) };
    }
  }

  #survey(signal?: AbortSignal): Promise<View[]> {
    return Promise.all(this.#config.machines.map((machine) => this.#look(machine, signal)));
  }

  async #look(machine: SshPoolMachine, signal?: AbortSignal): Promise<View> {
    const [record, probe] = await Promise.all([this.#read(machine), this.#status(machine, signal)]);
    const { state, reason } = this.#judge(probe, record);
    const marker = probe.status?.owner ?? null;
    const since = record?.state === state ? record.since : state === "held" && marker?.createdAt ? marker.createdAt : Date.now();
    const generation = probe.status?.generation ?? record?.generation ?? 0;
    if (probe.status && !this.#resetting.has(machine.name) && !this.#claiming.has(machine.name)) {
      await this.#sync(machine, record, state, probe.status, since);
    }
    return { machine, probe, record, state, reason, generation, since };
  }

  /**
   * Keeps the record in step with a machine that answers, for when it does
   * not: whose box holds it, and the generation it last had. An operator's
   * reset on the machine puts it back in service, clean at a later generation.
   */
  async #sync(machine: SshPoolMachine, record: MachineRecord | null, state: PoolMember["state"], status: MachineStatus, since: number): Promise<void> {
    const marker = status.owner;
    const generation = status.generation ?? 0;
    if (state === "free") {
      if (record?.state !== "free" || record.generation !== generation) {
        await this.#write(machine, { state, since, generation, reason: null, owner: null, user: null });
      }
    } else if (state === "held" && marker) {
      const owner = marker.install === this.#context.installId ? markerOwner(marker) : null;
      const markerGeneration = marker.generation ?? generation;
      if (record?.state !== "held" || record.owner?.boxId !== owner?.boxId || record.generation !== markerGeneration) {
        await this.#write(machine, { state, since, generation: markerGeneration, reason: null, owner, user: owner ? marker.user : null });
      }
    }
  }

  /** The machine's state from its own word, and from bb-box's record of it. */
  #judge(probe: Probe, record: MachineRecord | null): { state: PoolMember["state"]; reason: string | null } {
    const out = (reason: string) => ({ state: "out-of-service" as const, reason });
    const { status } = probe;
    if (probe.unreachable) return record?.state === "out-of-service" ? out(record.reason ?? "A reset failed.") : out(`It does not answer over SSH: ${probe.problem}`);
    if (!status) return out(`bb-box's helper did not run: ${probe.problem} Run setup/ssh-pool/setup.sh on it.`);
    if (status.helper === null || status.helper < HELPER_VERSION) return out("bb-box's helper is missing or too old. Run this bb-box's setup/ssh-pool/setup.sh on it.");
    if (status.generation === null) return out("It has no reset generation. Run setup/ssh-pool/setup.sh on it.");
    if (record?.state === "out-of-service") {
      // Back once the operator has reset it on the machine: clean, at a later generation.
      const back = status.marker === "none" && !status.dirty && status.generation > record.generation;
      if (!back) return out(record.reason ?? "A reset failed.");
    }
    if (status.marker === "owner") return { state: "held", reason: null };
    if (status.marker === "resetting") return { state: "resetting", reason: null };
    if (status.arch !== ARCH) return out(`It is ${status.arch || "of unknown architecture"}, not ${ARCH}.`);
    if (status.missing.length) return out(`It lacks ${status.missing.join(", ")}.`);
    if (status.dirty) return out(`An earlier box left ${status.dirty}`);
    if (record && status.generation < record.generation) {
      return out(`Its reset generation went back from ${record.generation} to ${status.generation}, as if restored from an older copy. Check it, then reset it.`);
    }
    return { state: "free", reason: null };
  }

  async #read(machine: SshPoolMachine): Promise<MachineRecord | null> {
    return (await this.#context.storage.get<MachineRecord>(`${RECORD}${machine.name}`)) ?? null;
  }

  async #write(machine: SshPoolMachine, record: MachineRecord): Promise<void> {
    await this.#context.storage.set(`${RECORD}${machine.name}`, record);
  }

  async #outOfService(machine: SshPoolMachine, generation: number, reason: string): Promise<void> {
    await this.#write(machine, { state: "out-of-service", since: Date.now(), generation, reason, owner: null, user: null });
  }

  #exclusive<T>(run: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(run, run);
    this.#queue = next.catch(() => undefined);
    return next;
  }

  #keys(): Promise<SshKeys> {
    if (!this.#ssh) {
      const pending = (async () => {
        let privateKey = this.#config.privateKey;
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
        const knownHostsPath = await this.#keyFile.knownHosts(this.#config.knownHosts);
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
