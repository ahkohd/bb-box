import { performance } from "node:perf_hooks";
import { placementData, readPlacement, slotModelRefusal, slotPorts, slotUser, LAST_GENERATION, type SlotKind, type SlotLender, type SlotPlacement, type SlotTaken, type SlotTier } from "../../core/device-host.ts";
import type { DeviceOffer, IosModelName } from "../../core/device.ts";
import { macSlotSizingWords, sizeMacSlots, type MacSlotSizing } from "../../core/slot-sizing.ts";
import type { DeviceRoom } from "../../core/mac-capabilities.ts";
import { pause, waitUntilAnswers } from "../../transports/ready.ts";
import type { SshTransport } from "../../transports/ssh.ts";
import type { RunResult, SshAccess } from "../../transports/types.ts";
import { DEVICE_HOST_EXITS, SLOT_INSTALLER_ENVIRONMENT, claimantInput, keepServerApp, keptAppWords, parseHostStatus, type HostSlotLine, type HostStatus, type ServerApp } from "../tart/device-host.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxTransports, type DoctorCheck, type Guest, type HeldGuest, type PoolMember, type PowerState } from "../types.ts";
import { SLOT_KIND, type PoolSlotsConfig, type SshPoolMachine } from "./config.ts";
import { SLOTS_HELPER_VERSION, fields, slotsBusy, type MachineStatus, type SlotsSummary } from "./protocol.ts";

export const SLOT_MAC_KEY = "slotMac";
export const NEXT_POOL_SLOT_WORDS = "The next slot is likely free when a box on the pool's Mac is released.";
const SLOT_READY_MS = 5 * 60_000;
const CLAIM_WAIT_MS = 2_000;
const SLOT_MAKING_MS = 30_000;
const POLL_MS = 1_000;
const MEMORY_FREE_LEAST = 15;
const STATUS_MS = 60_000;
const CLAIM_MS = 360_000;
const RELEASE_MS = 300_000;
const QUICK_MS = 90_000;
const SSH_FAILED = 255;
const APP_INSTALL_MS = 5 * 60_000;
const APP_TRIED_AGAIN_MS = 30 * 60_000;
const SERVER_APP_REUSED_MS = 2 * 60_000;

export interface PoolMacView {
  readonly machine: SshPoolMachine;
  readonly status: MachineStatus | null;
  readonly state: PoolMember["state"];
  readonly reason: string | null;
  readonly unreachable: boolean;
}

export interface PoolSlotsAccess {
  readonly installId: string;
  settings(): PoolSlotsConfig;
  chip?(machine: SshPoolMachine): string | null;
  devices?(machine: SshPoolMachine, signal?: AbortSignal): Promise<DeviceRoom>;
  hardware?(machine: SshPoolMachine): boolean | null;
  machines(): readonly SshPoolMachine[];
  machine(name: string): SshPoolMachine | null;
  survey(signal?: AbortSignal): Promise<readonly PoolMacView[]>;
  helper(machine: SshPoolMachine, args: readonly string[], input: string | null, timeoutMs: number, signal?: AbortSignal): Promise<RunResult>;
  command(machine: SshPoolMachine, user: string): Promise<SshTransport>;
  access(machine: SshPoolMachine, user: string): SshAccess;
  publicKey(): Promise<string>;
  readyTimeoutMs(): number | null;
  log(message: string): void;
  logError(operation: string, error: unknown): void;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
  serverApp?(signal?: AbortSignal): Promise<ServerApp | null>;
}

export interface PoolSlotRef {
  readonly mac: string;
  readonly slot: string | null;
  readonly box: string;
}

export function poolSlotOf(guest: Guest): PoolSlotRef | null {
  const mac = guest.data?.[SLOT_MAC_KEY];
  if (typeof mac !== "string") return null;
  const slot = guest.data?.slot;
  const box = guest.data?.box;
  return { mac, slot: typeof slot === "string" ? slot : null, box: typeof box === "string" ? box : "" };
}

export function listsSlots(machine: SshPoolMachine): boolean {
  return machine.os === "macos" && machine.kinds.includes(SLOT_KIND);
}

export function slotsSetUp(status: MachineStatus | null): SlotsSummary | null {
  const summary = status?.slots ?? null;
  if (!summary || (status?.helper ?? 0) < SLOTS_HELPER_VERSION || !summary.kept) return null;
  return summary.runtime && summary.model ? summary : null;
}

export function lendingSlots(status: MachineStatus | null): number {
  const summary = status?.slots ?? null;
  return summary?.kept ? slotsBusy(summary) : 0;
}

export function lendingWords(name: string, summary: SlotsSummary): string {
  const waiting = summary.waiting ? `, ${summary.waiting} waiting for a box` : "";
  return `The pool's Mac ${name} is lending iOS slots (${summary.held} held${waiting}). It is lent whole again when they are released.`;
}

export function poolSlotPlacement(mac: string, id: string, portBase: number, most: number): SlotPlacement | null {
  const generation = /^\d+$/.test(id) ? Number(id) : NaN;
  const place = (portBase - slotPorts(0).base) / slotPorts(0).count;
  if (!Number.isInteger(generation) || generation < 1 || generation > LAST_GENERATION) return null;
  if (!Number.isInteger(place) || place < 0 || place >= most) return null;
  return { on: "slot", host: mac, hostOn: "pool-mac", carried: false, generation, place, most };
}

export function slotDeviceOffer(summary: SlotsSummary, xcode: string | null): DeviceOffer | null {
  if (!summary.runtime || !summary.model) return null;
  return {
    platform: "ios",
    devices: [
      {
        model: summary.model.name as IosModelName,
        native: summary.model.native,
        runtime: { platform: "ios", os: summary.runtime.os, build: summary.runtime.build, xcode: xcode ?? "", companion: summary.companion ?? "" },
        ...(summary.labels !== null && summary.listSha256 ? { slim: { list: summary.runtime.list, labels: summary.labels, sha256: summary.listSha256 } } : {}),
      },
    ],
  } as DeviceOffer;
}

function readyFor(slot: HostSlotLine, box: string | null, acquiring: ReadonlySet<string>): boolean {
  return slot.is === "ready" && (slot.madeFor === null || slot.madeFor === box || !acquiring.has(slot.madeFor));
}

function spareMaking(slot: HostSlotLine, box: string | null): boolean {
  return slot.is === "making" && (slot.madeFor === null || slot.madeFor === box);
}

function heldCount(status: HostStatus): number {
  return status.slots.filter((slot) => slot.is === "held").length;
}

export function poolNoRoomWords(name: string, status: HostStatus): string | null {
  if (status.generation >= LAST_GENERATION) return `The pool's Mac ${name} has given all its slot UIDs. Let its ios boxes go, then set its slots up again.`;
  if (status.counted + status.promises.length >= status.most) return `The pool's Mac ${name} has all its ${status.most} iOS slots making, ready, held or promised (${heldCount(status)} held).`;
  if (status.diskGiB !== null && status.diskGiB < status.diskReserveGiB) return `The pool's Mac ${name} has ${status.diskGiB} GiB of disk free, under the ${status.diskReserveGiB} GiB it keeps.`;
  if (status.memoryFreePercent !== null && status.memoryFreePercent < MEMORY_FREE_LEAST) return `The pool's Mac ${name} has ${status.memoryFreePercent}% of its memory free, under ${MEMORY_FREE_LEAST}%.`;
  return null;
}

function said(result: RunResult): string {
  return result.stderr.trim().split("\n").slice(-2).join(" ").trim() || (result.timedOut ? "It did not answer in time." : `exit code ${result.exitCode}`);
}

function unreached(result: RunResult): boolean {
  return result.exitCode === SSH_FAILED || result.timedOut;
}

export class PoolSlots implements SlotLender {
  readonly on = "pool-mac" as const;
  readonly #access: PoolSlotsAccess;
  readonly #acquiringBoxes = new Set<string>();
  readonly #appKeeping = new Set<string>();
  readonly #macFacts = new Map<string, { readonly cores: number | null; readonly memoryMiB: number | null }>();
  readonly #appKept = new Map<string, string>();
  readonly #appTried = new Map<string, { readonly digest: string; readonly at: number }>();
  #serverAppRead: { readonly app: ServerApp | null; readonly at: number } | null = null;
  #lock: Promise<unknown> = Promise.resolve();

  constructor(access: PoolSlotsAccess) {
    this.#access = access;
  }

  lends(_kind: SlotKind): boolean {
    return this.#access.machines().some(listsSlots);
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return (this.#access.sleep ?? pause)(ms, signal);
  }

  #machineOf(name: string): SshPoolMachine {
    const machine = this.#access.machine(name);
    if (!machine) throw new Error(`The pool's Mac ${name} is not in the SSH host pool's settings now, so bb-box cannot reach its ios boxes. Put its line back in ssh-pool-machines.`);
    return machine;
  }

  async #status(machine: SshPoolMachine, signal?: AbortSignal): Promise<HostStatus> {
    const result = await this.#access.helper(machine, ["slot", "status"], null, STATUS_MS, signal);
    const status = result.exitCode === 0 ? parseHostStatus(result.stdout) : null;
    if (!status) throw new Error(`The pool's Mac ${machine.name} did not give its iOS slots' status: ${said(result)}`);
    return status;
  }

  unlendable(view: PoolMacView): string | null {
    const name = view.machine.name;
    const { status } = view;
    if (view.unreachable || !status) return `The pool's Mac ${name} does not answer: ${view.reason ?? "it gave no status."}`;
    if (status.marker === "owner") return `The pool's Mac ${name} is lent whole to a box, so it lends no iOS slot until that box is released.`;
    if (status.marker === "resetting") return `The pool's Mac ${name} is resetting after a box it was lent whole to, so it lends no iOS slot until its reset ends.`;
    if (view.state === "out-of-service") return `The pool's Mac ${name} is out of service: ${view.reason ?? "a reset failed."}`;
    if (!slotsSetUp(status)) return `The pool's Mac ${name} has no iOS slots set up. Run this bb-box's setup-mac.sh on it, with the whole setup folder and Xcode's iOS platform.`;
    return null;
  }

  async #devicesOn(machine: SshPoolMachine, signal?: AbortSignal): Promise<string | null> {
    if (!this.#access.devices) return null;
    try {
      const room = await this.#access.devices(machine, signal);
      return room.is === "no" ? `The pool's Mac ${machine.name} lends no iOS slot: ${room.why}` : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#access.logError(`measure what ${machine.name} offers`, error);
      return null;
    }
  }

  async #slotViews(signal?: AbortSignal): Promise<PoolMacView[]> {
    const views = (await this.#access.survey(signal)).filter((view) => listsSlots(view.machine));
    for (const view of views) this.#remember(view);
    return views;
  }

  async offer(kind: SlotKind, model: string | null, signal: AbortSignal): Promise<SlotTier> {
    const tiers: SlotTier[] = [];
    const words: string[] = [];
    let held = false;
    for (const view of await this.#slotViews(signal)) {
      const name = view.machine.name;
      const why = this.unlendable(view);
      if (why) {
        words.push(why);
        continue;
      }
      const devices = await this.#devicesOn(view.machine, signal);
      if (devices) {
        words.push(devices);
        continue;
      }
      const summary = slotsSetUp(view.status)!;
      if (model && model !== summary.model!.name) {
        words.push(slotModelRefusal(summary.model!.name, model));
        continue;
      }
      if (summary.closedSince !== null) {
        tiers.push({ tier: "make", host: name, waitMs: SLOT_MAKING_MS });
        continue;
      }
      let status: HostStatus;
      try {
        status = await this.#status(view.machine, signal);
      } catch (error) {
        words.push(error instanceof Error ? error.message : String(error));
        continue;
      }
      if (heldCount(status)) held = true;
      if (status.slots.some((slot) => readyFor(slot, null, this.#acquiringBoxes))) {
        tiers.push({ tier: "ready", host: name, waitMs: CLAIM_WAIT_MS });
        continue;
      }
      const full = poolNoRoomWords(name, status);
      if (status.slots.some((slot) => spareMaking(slot, null))) tiers.push({ tier: "join", host: name, waitMs: SLOT_MAKING_MS / 2 });
      else if (!full) tiers.push({ tier: "make", host: name, waitMs: SLOT_MAKING_MS });
      else words.push(full);
    }
    const order = ["ready", "join", "make"];
    tiers.sort((a, b) => order.indexOf(a.tier) - order.indexOf(b.tier) || ("waitMs" in a && "waitMs" in b ? a.waitMs - b.waitMs : 0));
    if (tiers[0]) return tiers[0];
    const next = held ? ` ${NEXT_POOL_SLOT_WORDS}` : "";
    return { tier: "wait", words: `${[...new Set(words)].join(" ") || "No Mac in the SSH host pool lends iOS slots now."}${next}` };
  }

  async take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    return this.#serial(async () => {
      switch (choice.tier) {
        case "ready":
          return this.#claimReady(choice.host, box, signal);
        case "join":
        case "make":
          return this.#promise(choice.host, box, signal);
        default:
          return { lost: `The SSH host pool cannot take a ${choice.tier} answer.` };
      }
    });
  }

  async #claimant(box: BoxIdentity): Promise<string> {
    const key = (await this.#access.publicKey()).trim();
    const line = (text: string) => text.replace(/[\r\n]+/g, " ");
    return `install=${line(this.#access.installId)}\nbox=${line(box.boxId)}\nthread=${line(box.threadId)}\nname=${line(box.name)}\nkind=${line(box.kind)}\ncreated=${Math.round(box.createdAt)}\nkey=${line(key)}\n`;
  }

  #promiseGuest(machine: SshPoolMachine, boxId: string): Guest {
    return { ref: `${machine.name}/for-${boxId}`, host: machine.name, address: null, size: null, data: { box: boxId, [SLOT_MAC_KEY]: machine.name } };
  }

  #slotGuest(machine: SshPoolMachine, boxId: string, placement: SlotPlacement, id: string): Guest {
    return {
      ref: `${machine.name}/slot-${id}`,
      host: machine.name,
      address: machine.admin.host,
      size: null,
      data: { box: boxId, [SLOT_MAC_KEY]: machine.name, slot: id, ...placementData(placement) },
      facts: [
        { label: "Form", value: "a macOS user on a physical Mac, shared with other ios boxes" },
        { label: "Machine", value: machine.name },
        { label: "Reset", value: "User and home, with every file it owns" },
      ],
    };
  }

  async #claim(machine: SshPoolMachine, id: string, box: BoxIdentity, most: number, signal?: AbortSignal): Promise<SlotTaken> {
    const result = await this.#access.helper(machine, ["slot", "claim", id], await this.#claimant(box), CLAIM_MS, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) {
      if (result.exitCode === DEVICE_HOST_EXITS.lost || result.exitCode === DEVICE_HOST_EXITS.notReady || result.exitCode === DEVICE_HOST_EXITS.deleting) return { lost: said(result) };
      throw new Error(`The pool's Mac ${machine.name} could not lend slot ${id}: ${said(result)}`);
    }
    const answer = fields(result.stdout);
    const slot = answer.get("slot") ?? id;
    const placement = poolSlotPlacement(machine.name, slot, Number(answer.get("ports")), most);
    if (!placement) throw new Error(`The pool's Mac ${machine.name} lent slot ${id}, but its answer could not be read: ${result.stdout.trim()}`);
    return this.#slotGuest(machine, box.boxId, placement, slot);
  }

  async #claimReady(name: string, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const machine = this.#access.machine(name);
    if (!machine) return { lost: `The pool's Mac ${name} is no longer in the SSH host pool's settings.` };
    const status = await this.#status(machine, signal);
    const ready = status.slots.filter((slot) => readyFor(slot, null, this.#acquiringBoxes)).sort((a, b) => a.uid - b.uid);
    if (!ready.length) return { lost: `The pool's Mac ${name} has no ready iOS slot now.` };
    return this.#claim(machine, ready[0]!.id, box, status.most, signal);
  }

  #remember(view: PoolMacView): void {
    if (view.status) this.#macFacts.set(view.machine.name, { cores: view.status.cores, memoryMiB: view.status.memoryMiB });
  }

  sizing(machine: SshPoolMachine): MacSlotSizing {
    const facts = this.#macFacts.get(machine.name);
    const settings = this.#access.settings();
    const mac = { name: machine.name, cores: facts?.cores ?? null, performanceCores: null, memoryGiB: facts?.memoryMiB ? Math.floor(facts.memoryMiB / 1024) : null, chip: this.#access.chip?.(machine) ?? null, hardware: this.#access.hardware?.(machine) ?? null };
    return sizeMacSlots(mac, machine.slotsMost, settings.mostSet, settings.most);
  }

  #slotSettings(machine: SshPoolMachine): Pick<PoolSlotsConfig, "most" | "ahead" | "resettingMost" | "diskReserveGiB"> {
    const settings = this.#access.settings();
    const most = this.sizing(machine).most.value;
    return { most, ahead: Math.min(settings.ahead, most), resettingMost: settings.resettingMost, diskReserveGiB: settings.diskReserveGiB };
  }

  #openInput(machine: SshPoolMachine): string {
    const settings = this.#slotSettings(machine);
    return `install=${this.#access.installId}\nmost=${settings.most}\nahead=${settings.ahead}\nresetting-most=${settings.resettingMost}\ndisk-reserve-gib=${settings.diskReserveGiB}\n`;
  }

  async #open(machine: SshPoolMachine, signal?: AbortSignal): Promise<RunResult> {
    return this.#access.helper(machine, ["slot", "open"], this.#openInput(machine), QUICK_MS, signal);
  }

  async #promise(name: string, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const machine = this.#access.machine(name);
    if (!machine) return { lost: `The pool's Mac ${name} is no longer in the SSH host pool's settings.` };
    const claimant = claimantInput({ install: this.#access.installId, box: box.boxId });
    let result = await this.#access.helper(machine, ["slot", "promise"], claimant, QUICK_MS, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.deleting && /lends no slot now/.test(result.stderr)) {
      const opened = await this.#open(machine, signal);
      if (opened.exitCode !== DEVICE_HOST_EXITS.done) return { lost: said(opened) };
      result = await this.#access.helper(machine, ["slot", "promise"], claimant, QUICK_MS, signal);
    }
    if (result.exitCode === DEVICE_HOST_EXITS.done) return this.#promiseGuest(machine, box.boxId);
    if (result.exitCode === DEVICE_HOST_EXITS.full && (await this.#status(machine, signal)).slots.some((slot) => spareMaking(slot, null))) return this.#promiseGuest(machine, box.boxId);
    return { lost: said(result) };
  }

  async acquire(box: BoxIdentity, previous: Guest, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    const ref = poolSlotOf(previous)!;
    const machine = this.#machineOf(ref.mac);
    this.#acquiringBoxes.add(box.boxId);
    let taken = previous;
    try {
      await hooks.starting();
      const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
        const began = performance.now();
        try {
          return await run();
        } finally {
          hooks.timing(step, Math.round(performance.now() - began));
        }
      };
      const claimed = ref.slot !== null && readPlacement(previous.data).ok;
      const guest = claimed ? previous : await timed("slot", () => this.#slotFor(machine, box, signal));
      taken = guest;
      await hooks.claim(guest);
      await timed("ssh", () => this.#waitAnswers(machine, slotUserOf(guest), signal));
      return guest;
    } catch (error) {
      if (!signal.aborted) await this.release(taken).catch((cause) => this.#access.logError(`release ${taken.ref} after a failed acquire`, cause));
      throw error;
    } finally {
      this.#acquiringBoxes.delete(box.boxId);
    }
  }

  async #waitAnswers(machine: SshPoolMachine, user: string, signal: AbortSignal): Promise<void> {
    const timeoutMs = this.#access.readyTimeoutMs() ?? SLOT_READY_MS;
    const command = await this.#access.command(machine, user);
    const ready = await waitUntilAnswers({ probe: (inner?: AbortSignal) => command.answers(inner) }, { timeoutMs, intervalMs: 250, signal, sleep: this.#access.sleep });
    if (!ready) throw new Error(`The pool's Mac ${machine.name} lent slot user ${user}, but SSH as ${user} did not answer within ${Math.round(timeoutMs / 1000)} s. Check that Remote Login lets ${user} log in with a key: where sshd has AllowUsers or AllowGroups, it must allow bbd-*, as it does bbx-*.`);
  }

  async #slotFor(machine: SshPoolMachine, box: BoxIdentity, signal: AbortSignal): Promise<Guest> {
    const claimant = claimantInput({ install: this.#access.installId, box: box.boxId });
    const deadline = Date.now() + SLOT_READY_MS;
    for (;;) {
      signal.throwIfAborted();
      const status = await this.#status(machine, signal);
      const mine = status.claims.find((claim) => claim.install === this.#access.installId && claim.box === box.boxId);
      const line = mine && status.slots.find((slot) => slot.id === mine.slot);
      if (line) {
        const placement = poolSlotPlacement(machine.name, line.id, line.portBase, status.most);
        if (placement) return this.#slotGuest(machine, box.boxId, placement, line.id);
      }
      if (status.closedSince !== null) throw new BackendError("no_capacity", `The pool's Mac ${machine.name} was lent whole before box ${box.name} got an iOS slot.`);
      if (Date.now() > deadline) throw new Error(`The pool's Mac ${machine.name} gave box ${box.name} no iOS slot within ${SLOT_READY_MS / 60_000} minutes.`);
      const ready = status.slots.filter((slot) => readyFor(slot, box.boxId, this.#acquiringBoxes)).sort((a, b) => Number(b.madeFor === box.boxId) - Number(a.madeFor === box.boxId) || a.uid - b.uid);
      if (ready.length) {
        const claimed = await this.#claim(machine, ready[0]!.id, box, status.most, signal);
        if (!("lost" in claimed)) return claimed;
        continue;
      }
      if (status.slots.some((slot) => spareMaking(slot, box.boxId))) {
        await this.#sleep(POLL_MS, signal);
        continue;
      }
      if (!status.promises.some((promise) => promise.box === box.boxId)) {
        const again = await this.#access.helper(machine, ["slot", "promise"], claimant, QUICK_MS, signal);
        if (again.exitCode !== DEVICE_HOST_EXITS.done) throw new BackendError("no_capacity", `The pool's Mac ${machine.name} has no room for box ${box.name} now: ${said(again)}`);
      }
      const made = await this.#access.helper(machine, ["slot", "make"], claimant, SLOT_READY_MS, signal);
      if (made.exitCode === DEVICE_HOST_EXITS.done) continue;
      if (made.exitCode === DEVICE_HOST_EXITS.full || made.exitCode === DEVICE_HOST_EXITS.lost) {
        await this.#sleep(POLL_MS * 2, signal);
        continue;
      }
      throw new Error(`The pool's Mac ${machine.name} could not make an iOS slot for box ${box.name}: ${said(made)}`);
    }
  }

  async release(guest: Guest, signal?: AbortSignal): Promise<{ readonly last: boolean }> {
    const ref = poolSlotOf(guest)!;
    const machine = this.#access.machine(ref.mac);
    if (!machine) return { last: false };
    const claimant = claimantInput({ install: this.#access.installId, box: ref.box });
    const result = ref.slot
      ? await this.#access.helper(machine, ["slot", "release", ref.slot], claimant, RELEASE_MS, signal)
      : await this.#access.helper(machine, ["slot", "unpromise"], claimant, QUICK_MS, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.notOurs) return { last: false };
    if (unreached(result)) throw new Error(`The pool's Mac ${machine.name} cannot release box ${ref.box}'s iOS slot now: ${said(result)} bb-box tries again later.`);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The pool's Mac ${machine.name} could not release box ${ref.box}'s ${ref.slot ? `iOS slot ${ref.slot}` : "promise"}: ${said(result)}`);
    return { last: fields(result.stdout).get("last") === "yes" };
  }

  async held(views: readonly PoolMacView[], signal?: AbortSignal): Promise<HeldGuest[]> {
    const held: HeldGuest[] = [];
    for (const view of views) {
      if (!listsSlots(view.machine) && !view.status?.slots) continue;
      if (!slotsSetUp(view.status)) continue;
      let status: HostStatus;
      try {
        status = await this.#status(view.machine, signal);
      } catch (error) {
        this.#access.logError(`read the iOS slots of ${view.machine.name}`, error);
        continue;
      }
      for (const promise of status.promises) {
        if (promise.install === this.#access.installId) held.push({ ...this.#promiseGuest(view.machine, promise.box), owner: null, power: "running" });
      }
      for (const claim of status.claims) {
        if (claim.install !== this.#access.installId) continue;
        const line = status.slots.find((slot) => slot.id === claim.slot);
        const placement = line && poolSlotPlacement(view.machine.name, line.id, line.portBase, status.most);
        if (!placement || line.is !== "held") continue;
        held.push({
          ...this.#slotGuest(view.machine, claim.box, placement, claim.slot),
          owner: { boxId: claim.box, threadId: claim.thread ?? "", name: claim.name, kind: claim.kind, createdAt: claim.created },
          power: "running",
        });
      }
    }
    return held;
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const ref = poolSlotOf(guest)!;
    const machine = this.#access.machine(ref.mac);
    if (!machine) return "unknown";
    let status: HostStatus;
    try {
      status = await this.#status(machine, signal);
    } catch {
      signal?.throwIfAborted();
      return "unknown";
    }
    const ours = (box: string, install: string) => box === ref.box && install === this.#access.installId;
    if (ref.slot) return status.claims.some((claim) => claim.slot === ref.slot && ours(claim.box, claim.install)) ? "running" : null;
    if (status.promises.some((promise) => ours(promise.box, promise.install))) return "running";
    return status.claims.some((claim) => ours(claim.box, claim.install)) ? "running" : null;
  }

  async transports(guest: Guest): Promise<BoxTransports> {
    const ref = poolSlotOf(guest)!;
    const machine = this.#machineOf(ref.mac);
    const user = slotUserOf(guest);
    const slot = ref.slot!;
    const claimant = claimantInput({ install: this.#access.installId, box: ref.box });
    return {
      command: await this.#access.command(machine, user),
      displays: [],
      access: { ssh: this.#access.access(machine, user), dockerHost: null },
      daemonKeptByHost: {
        installerEnvironment: SLOT_INSTALLER_ENVIRONMENT,
        takeOver: async (signal) => {
          const result = await this.#access.helper(machine, ["slot", "daemon", slot], claimant, QUICK_MS, signal);
          if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The pool's Mac ${machine.name} could not take over BB's daemon for slot ${slot}: ${said(result)}`);
        },
      },
    };
  }

  async restartDeviceServer(guest: Guest, signal?: AbortSignal): Promise<void> {
    const ref = poolSlotOf(guest)!;
    if (!ref.slot) return;
    const machine = this.#machineOf(ref.mac);
    const result = await this.#access.helper(machine, ["slot", "restart", ref.slot], claimantInput({ install: this.#access.installId, box: ref.box }), QUICK_MS, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The pool's Mac ${machine.name} could not start slot ${ref.slot}'s device server again: ${said(result)}`);
  }

  #settingsDiffer(summary: SlotsSummary, machine: SshPoolMachine): boolean {
    const settings = this.#slotSettings(machine);
    return summary.most !== settings.most || summary.ahead !== settings.ahead || summary.resettingMost !== settings.resettingMost || summary.diskReserveGiB !== settings.diskReserveGiB;
  }

  async maintain(views: readonly PoolMacView[], signal?: AbortSignal): Promise<void> {
    for (const view of views) {
      signal?.throwIfAborted();
      this.#remember(view);
      const summary = slotsSetUp(view.status);
      if (!summary || view.unreachable || !view.status || view.status.marker !== "none") continue;
      const name = view.machine.name;
      try {
        if (listsSlots(view.machine)) {
          if (view.state === "out-of-service") continue;
          this.#keepAppAside(view.machine);
          const short = summary.ready + summary.making - summary.waiting < summary.ahead;
          if (summary.closedSince === null && !this.#settingsDiffer(summary, view.machine) && !short) continue;
          const opened = await this.#open(view.machine, signal);
          if (opened.exitCode !== DEVICE_HOST_EXITS.done && opened.exitCode !== DEVICE_HOST_EXITS.deleting) this.#access.log(`The pool's Mac ${name} did not open its iOS slots: ${said(opened)}`);
          else if (summary.closedSince !== null && opened.exitCode === DEVICE_HOST_EXITS.done) this.#access.log(`The pool's Mac ${name} lends iOS slots again, as it is not lent whole.`);
        } else if (summary.closedSince === null && slotsBusy(summary) === 0) {
          const closed = await this.#access.helper(view.machine, ["slot", "close"], `install=${this.#access.installId}\n`, QUICK_MS, signal);
          if (closed.exitCode === DEVICE_HOST_EXITS.done) this.#access.log(`The pool's Mac ${name} lends no iOS slot now, as its line does not list ios.`);
        }
      } catch (error) {
        signal?.throwIfAborted();
        this.#access.logError(`upkeep of the iOS slots on ${name}`, error);
      }
    }
  }

  #keepAppAside(machine: SshPoolMachine): void {
    if (this.#appKeeping.has(machine.name)) return;
    this.#appKeeping.add(machine.name);
    void this.#keepApp(machine)
      .catch((error) => this.#access.logError(`keep BB's app on the pool's Mac ${machine.name}`, error))
      .finally(() => this.#appKeeping.delete(machine.name));
  }

  async #keepApp(machine: SshPoolMachine, signal?: AbortSignal): Promise<void> {
    const app = await this.#serverApp(signal);
    if (!app || this.#appKept.get(machine.name) === app.digest) return;
    const tried = this.#appTried.get(machine.name);
    if (tried?.digest === app.digest && Date.now() - tried.at < APP_TRIED_AGAIN_MS) return;
    const status = await this.#status(machine, signal).catch(() => null);
    if (status?.bbAppKept && status.bbApp === app.digest) {
      this.#appKept.set(machine.name, app.digest);
      return;
    }
    this.#appTried.set(machine.name, { digest: app.digest, at: Date.now() });
    const command = await this.#access.command(machine, machine.admin.user);
    const kept = await keepServerApp(
      app,
      (script) => command.run(script, { timeoutMs: APP_INSTALL_MS, signal, maxOutputBytes: 1 << 16 }),
      (input) => this.#access.helper(machine, ["slot", "keep-app"], input, QUICK_MS, signal),
    );
    if (!kept.kept) {
      this.#access.log(`The pool's Mac ${machine.name} keeps no BB app for its iOS slots, so each slot downloads it: ${kept.why}`);
      return;
    }
    this.#appTried.delete(machine.name);
    this.#appKept.set(machine.name, app.digest);
    this.#access.log(`The pool's Mac ${machine.name} keeps ${keptAppWords(app, kept)}.`);
  }

  async #serverApp(signal?: AbortSignal): Promise<ServerApp | null> {
    const read = this.#serverAppRead;
    if (read && Date.now() - read.at < SERVER_APP_REUSED_MS) return read.app;
    const app = (await this.#access.serverApp?.(signal).catch(() => null)) ?? null;
    this.#serverAppRead = { app, at: Date.now() };
    return app;
  }

  async doctor(view: PoolMacView, signal?: AbortSignal): Promise<Omit<DoctorCheck, "id" | "name"> | null> {
    if (!listsSlots(view.machine)) return null;
    const name = view.machine.name;
    const { status } = view;
    if (!status) return null;
    this.#remember(view);
    const summary = slotsSetUp(status);
    const sized = ` It lends ${macSlotSizingWords(this.sizing(view.machine))}.`;
    const setup = `Copy the whole setup folder to ${name}, then run setup/ssh-pool/setup-mac.sh on it with sudo, with Xcode and its iOS platform installed. It installs idb_companion, the slimming list and seed, and the slots' helper.`;
    if ((status.helper ?? 0) < SLOTS_HELPER_VERSION) return { status: "warn", detail: `Its helper is version ${status.helper ?? "unknown"}; iOS slots need version ${SLOTS_HELPER_VERSION}, so the Mac lends none.`, fix: setup };
    if (!summary) {
      const why = !status.slots ? "Its iOS slots are not set up" : !status.slots.runtime ? "Its iOS slots have no iOS runtime with a slimming list and seed" : "Its iOS slots are not set up as a kept host";
      return { status: "warn", detail: `${why}, so the Mac lends no ios box.`, fix: setup };
    }
    const runtime = `iOS ${summary.runtime!.os} (${summary.runtime!.build}), the ${summary.model!.name}, idb_companion ${summary.companion ?? "of unknown version"}`;
    const counts = `${summary.held} held, ${summary.ready} ready, ${summary.making} making, ${summary.sweeping} sweeping, of ${summary.most}`;
    const slots = await this.#status(view.machine, signal).catch(() => null);
    const swept = slots ? sweepWords(slots) : "";
    if (status.marker === "owner") return { status: "ok", detail: `Lent whole to a box now, so it lends no iOS slot until that box is released. Its slots: ${runtime}.${sized}${swept}`, fix: null };
    if (summary.closedSince !== null) return { status: "ok", detail: `Closed: it lends no iOS slot until bb-box opens it, at its next upkeep while it is not lent whole. Its slots: ${runtime}.${sized}${swept}`, fix: null };
    return { status: "ok", detail: `Lends iOS slots, ${counts}: ${runtime}.${sized}${slotsBusy(summary) ? ` While any is held it is not lent whole.` : ""}${slots ? heldLoadWords(slots) : ""}${swept}`, fix: null };
  }
}

function heldLoadWords(status: HostStatus): string {
  const held = status.slots.filter((slot) => slot.is === "held");
  if (!held.length) return "";
  return ` ${held.map((slot) => `Slot ${slot.id} (box ${slot.box ?? "?"}): ${slot.cores.toFixed(2)} cores, ${(slot.memoryMiB / 1024).toFixed(1)} GiB${slot.homeMiB !== null ? `, home ${(slot.homeMiB / 1024).toFixed(1)} GiB` : ""}`).join("; ")}.`;
}

export function sweepWords(status: HostStatus): string {
  const passes: (typeof status.sweeps)[number][][] = [];
  for (const sweep of status.sweeps) {
    const pass = passes.at(-1);
    const same = pass?.[0] && pass.length < pass[0].uidsInPass && pass[0].seconds === sweep.seconds && pass[0].found === sweep.found && pass[0].left === sweep.left;
    if (same) pass.push(sweep);
    else passes.push([sweep]);
  }
  const last = passes.slice(-3);
  if (!last.length) return "";
  const words = last.map((pass) => {
    const { found, left, seconds } = pass[0]!;
    const uids = pass.map((sweep) => sweep.uid);
    const of = uids.length === 1 ? `UID ${uids[0]}` : `UIDs ${uids.slice(0, -1).join(", ")} and ${uids.at(-1)}`;
    return `of ${of}, ${found} ${found === 1 ? "path" : "paths"} found and ${left} left, in ${Math.round(seconds)} s`;
  });
  const leaves = last.some((pass) => pass[0]!.left > 0) ? " A sweep that leaves a path needs the helper's Full Disk Access." : "";
  return ` Its last sweeps: ${words.join("; ")}.${leaves}`;
}

export function slotUserOf(guest: Guest): string {
  const placement = readPlacement(guest.data);
  if (!placement.ok || placement.value.on !== "slot") throw new Error(`Box guest ${guest.ref} holds no iOS slot yet.`);
  return slotUser(placement.value);
}
