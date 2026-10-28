import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { placementData, readPlacement, slotDaemonPortOf, slotModelRefusal, slotPorts, slotUser, spareMaking, AskOrder, LAST_GENERATION, type SlotKind, type SlotLender, type SlotPlacement, type SlotTaken, type SlotTier } from "../../core/device-host.ts";
import type { DeviceOffer, IosModelName } from "../../core/device.ts";
import type { MacReport } from "../../core/mac-capabilities.ts";
import { sizeMacSlots, macSlotSizingWords } from "../../core/slot-sizing.ts";
import { quote } from "../../transports/process.ts";
import { SlotUserTransport } from "../../transports/slot-user.ts";
import type { SshTransport } from "../../transports/ssh.ts";
import type { RunResult } from "../../transports/types.ts";
import { setupDir } from "../setup-dir.ts";
import { DEVICE_HOST_EXITS, claimantInput, helperCommand, parseHostStatus, slotDaemonKeptByHost, type HostStatus, type SlotClaimant } from "../tart/device-host.ts";
import { BackendError, type AcquireHooks, type BackendStorage, type BoxIdentity, type BoxTransports, type DoctorCheck, type Guest, type HeldGuest, type PowerState } from "../types.ts";
import type { Instance } from "./api.ts";
import type { MacShape } from "./config.ts";

export const NAMESPACE_HOST_ROLE = "device-host";
export const HOST_RECORD_KEY = "ios-host";
export const ENDING_MS = 60 * 60_000;
export const HOST_START_MS = 15 * 60_000;
export const NEW_HOST_WAIT_MS = 240_000;
export const START_LIVE_MS = 2 * 60_000;
export const START_BEAT_MS = 30_000;
export const SLOT_READY_MS = 5 * 60_000;
export const POLL_MS = 2_000;
const CLAIM_WAIT_MS = 6_000;
const SLOT_MAKING_MS = 45_000;
const HOST_SETUP_MS = 25 * 60_000;
const SETUP_FOLDER = "bb-box-setup";
const HELPER_LONG_MS = 360_000;

export interface NamespaceIosHostsConfig {
  readonly on: boolean;
  readonly most: number | null;
  readonly ahead: number;
  readonly resettingMost: number;
  readonly diskReserveGiB: number;
}

export interface NamespaceHostRecord {
  readonly tag: string;
  readonly instance: string | null;
  readonly made: number;
  readonly endsAt: number;
  readonly phase: "starting" | "serving" | "failed";
  readonly promised: readonly string[];
  readonly most: number;
  readonly ahead: number;
  readonly resettingMost: number;
  readonly diskReserveGiB: number;
  readonly failure: string | null;
  readonly startBy: string | null;
  readonly startBeat: number | null;
  readonly hardware: boolean | null;
}

export interface NamespaceHostsAccess {
  readonly installId: string;
  readonly storage: BackendStorage;
  settings(): NamespaceIosHostsConfig;
  longestLifeMs(): number;
  now(): number;
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  report(): MacReport | null;
  room(signal?: AbortSignal): Promise<{ readonly shape: MacShape | null; readonly words: string | null }>;
  create(tag: string, shape: MacShape, signal?: AbortSignal): Promise<Instance>;
  wait(instance: string, signal?: AbortSignal): Promise<Instance>;
  describe(instance: string, signal?: AbortSignal): Promise<Instance | null>;
  destroy(instance: string, why: string, signal?: AbortSignal): Promise<void>;
  extend(instance: string, aheadMs: number, signal?: AbortSignal): Promise<void>;
  answers(instance: string, deadline: number, signal?: AbortSignal): Promise<void>;
  command(instance: string): Promise<SshTransport>;
  measure(instance: string, signal?: AbortSignal): Promise<MacReport>;
  joinTailnet?(instance: string, signal?: AbortSignal): Promise<void>;
  leaveTailnet?(instance: string): Promise<void>;
  setupArchive(): Promise<Buffer>;
  publicKey(): Promise<string>;
  log(message: string): void;
  logError(operation: string, error: unknown): void;
}

export interface NamespaceSlotRef {
  readonly tag: string;
  readonly instance: string | null;
  readonly slot: string | null;
  readonly box: string;
}

export const NS_HOST_KEY = "nsHost";

export function namespaceSlotOf(guest: Guest): NamespaceSlotRef | null {
  const tag = guest.data?.[NS_HOST_KEY];
  if (typeof tag !== "string") return null;
  const instance = guest.data?.instance;
  const slot = guest.data?.slot;
  const box = guest.data?.box;
  return { tag, instance: typeof instance === "string" ? instance : null, slot: typeof slot === "string" ? slot : null, box: typeof box === "string" ? box : "" };
}

export interface ModelRow {
  readonly model: string;
  readonly native: string;
}

export function setupModels(setup = setupDir()): ModelRow[] {
  const path = join(setup, "tart", "ios", "devices.tsv");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.split("\t"))
    .filter((fields) => fields.length >= 2 && fields[0] && fields[1])
    .map(([model, native]) => ({ model: model!, native: native! }));
}

export function slimList(os: string, build: string, setup = setupDir()): { readonly list: string; readonly labels: number; readonly sha256: string } | null {
  const list = `ios-${os}-${build}`;
  const path = join(setup, "tart", "ios", "slim", `${list}.txt`);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  return { list, labels: text.split("\n").filter((line) => line.trim()).length, sha256: createHash("sha256").update(text).digest("hex") };
}

export function companionPin(setup = setupDir()): string | null {
  const path = join(setup, "tart", "ios", "pins");
  if (!existsSync(path)) return null;
  return /^IDB_VERSION=(\S+)$/m.exec(readFileSync(path, "utf8"))?.[1] ?? null;
}

export type HostOffer = { readonly ok: true; readonly device: DeviceOffer } | { readonly ok: false; readonly why: string };

export function namespaceDeviceOffer(report: MacReport | null, setup = setupDir()): HostOffer {
  if (!report) return { ok: false, why: "bb-box has not measured a Namespace Mac yet; it does when one starts, as for a macos box, or when the doctor runs while one is held" };
  const simulator = report.capabilities.simulator;
  if (simulator.is !== "yes") return { ok: false, why: `Namespace's last Mac measured, an ${report.chip ?? "unknown chip"}, cannot run the iOS Simulator: ${simulator.is === "no" ? simulator.why : "not known"}` };
  const newest = simulator.what.newest;
  if (!newest) return { ok: false, why: "Namespace's last Mac was measured by an older bb-box, which did not ask its newest iOS runtime; bb-box starts a Namespace Mac for a few minutes to measure it again" };
  const slim = slimList(newest.os, newest.build, setup);
  if (!slim) return { ok: false, why: `bb-box has no slimming list for iOS ${newest.os} (${newest.build}), the newest runtime of Namespace's Macs: make one as docs/research/ios-simulator-slimming.md says, as setup/tart/ios/slim/ios-${newest.os}-${newest.build}.txt` };
  const types = new Set(simulator.what.deviceTypes ?? []);
  const row = setupModels(setup).find((each) => types.has(each.native));
  if (!row) return { ok: false, why: `Namespace's Macs have Xcode ${simulator.what.xcode}, which can make none of bb-box's iOS devices` };
  const companion = companionPin(setup) ?? "";
  return {
    ok: true,
    device: { platform: "ios", devices: [{ model: row.model as IosModelName, native: row.native, runtime: { platform: "ios", os: newest.os, build: newest.build, xcode: simulator.what.xcode, companion }, slim }] } as DeviceOffer,
  };
}

function heldCount(status: HostStatus): number {
  return status.slots.filter((slot) => slot.is === "held").length;
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clock(at: number): string {
  return new Date(at).toISOString().slice(11, 16);
}

function slotNameOf(id: string): { readonly carried: false; readonly generation: number } | null {
  return /^\d+$/.test(id) && Number(id) >= 1 && Number(id) <= LAST_GENERATION ? { carried: false, generation: Number(id) } : null;
}

export function namespaceSlotPlacement(tag: string, id: string, portBase: number, most: number): SlotPlacement | null {
  const name = slotNameOf(id);
  const place = (portBase - slotPorts(0).base) / slotPorts(0).count;
  if (!name || !Number.isInteger(place) || place < 0 || place >= most) return null;
  return { on: "slot", host: tag, hostOn: "namespace", ...name, place, most };
}

export function hostSettingsText(record: Pick<NamespaceHostRecord, "most" | "ahead" | "resettingMost" | "diskReserveGiB">): string {
  return `most=${record.most}\nahead=${record.ahead}\nresetting-most=${record.resettingMost}\ndisk-reserve-gib=${record.diskReserveGiB}`;
}

export function hostSetupScript(record: Pick<NamespaceHostRecord, "most" | "ahead" | "resettingMost" | "diskReserveGiB">): string {
  return [
    "set -eu",
    'export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"',
    `here="$HOME/${SETUP_FOLDER}/setup"`,
    `sudo -n env HOST_SETTINGS=${quote(hostSettingsText(record))} /bin/sh "$here/ssh-pool/mac-ios.sh" "$here/ssh-pool" "$(id -un)"`,
  ].join("\n");
}

export const UNPACK_SETUP = `rm -rf "$HOME/${SETUP_FOLDER}" && mkdir -p "$HOME/${SETUP_FOLDER}" && tar -xzf - -C "$HOME/${SETUP_FOLDER}"`;

export class NamespaceHosts implements SlotLender {
  readonly on = "namespace" as const;
  readonly #access: NamespaceHostsAccess;
  readonly #instance = randomBytes(4).toString("hex");
  readonly #acquiringBoxes = new Set<string>();
  readonly #order = new AskOrder();
  readonly #stopping = new AbortController();
  #start: Promise<void> | null = null;
  #known: NamespaceHostRecord | null = null;
  #offered: { readonly report: MacReport | null; readonly offer: HostOffer } | null = null;
  #lock: Promise<unknown> = Promise.resolve();
  #recordLock: Promise<unknown> = Promise.resolve();

  constructor(access: NamespaceHostsAccess) {
    this.#access = access;
  }

  #serial<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#lock.then(task, task);
    this.#lock = next.catch(() => undefined);
    return next;
  }

  async record(): Promise<NamespaceHostRecord | null> {
    this.#known = (await this.#access.storage.get<NamespaceHostRecord>(HOST_RECORD_KEY)) ?? null;
    return this.#known;
  }

  known(): NamespaceHostRecord | null {
    return this.#known;
  }

  async #save(record: NamespaceHostRecord | null): Promise<void> {
    this.#known = record;
    if (record) await this.#access.storage.set(HOST_RECORD_KEY, record);
    else await this.#access.storage.delete(HOST_RECORD_KEY);
  }

  #update(change: (record: NamespaceHostRecord) => NamespaceHostRecord): Promise<NamespaceHostRecord | null> {
    const task = async () => {
      const record = await this.record();
      if (!record) return null;
      const next = change(record);
      await this.#save(next);
      return next;
    };
    const next = this.#recordLock.then(task, task);
    this.#recordLock = next.catch(() => undefined);
    return next;
  }

  offerable(): HostOffer {
    const report = this.#access.report();
    if (this.#offered?.report !== report) this.#offered = { report, offer: namespaceDeviceOffer(report) };
    return this.#offered.offer;
  }

  offerNote(): string {
    const most = this.#access.settings().most;
    const slots = most ? `up to ${most} slots on it` : "as many slots as its cores, memory and video encoder allow";
    return `iOS slots on a Namespace Mac made for the first ios box, in about 5 minutes, and deleted after its last; ${slots}; each slot a macOS user with its own device, files and keychain; no root; the slot's user and every file it owns removed after release`;
  }

  lends(kind: SlotKind): boolean {
    return kind === "ios" && this.#access.settings().on && this.offerable().ok;
  }

  #sizing(report: MacReport | null, shape: MacShape): { readonly most: number; readonly words: string } {
    const settings = this.#access.settings();
    const hardware = report?.capabilities.hardwareEncoder.is === "yes" ? true : report?.capabilities.hardwareEncoder.is === "no" ? false : null;
    const sized = sizeMacSlots({ name: "the Namespace Mac", cores: shape.cores, performanceCores: null, memoryGiB: shape.memoryGB, chip: report?.chip ?? null, hardware }, undefined, settings.most ?? undefined, 3);
    return { most: sized.most.value, words: macSlotSizingWords(sized) };
  }

  async #status(instance: string, signal?: AbortSignal): Promise<HostStatus> {
    const command = await this.#access.command(instance);
    const result = await command.run(helperCommand("status"), { timeoutMs: 60_000, signal, maxOutputBytes: 1 << 20 });
    const status = result.exitCode === 0 ? parseHostStatus(result.stdout) : null;
    if (!status) throw new Error(`The Namespace host's helper did not give its status: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    return status;
  }

  async #helper(instance: string, verb: string, args: readonly string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    const command = await this.#access.command(instance);
    return command.run(helperCommand(verb, ...args), { stdin, timeoutMs, signal, maxOutputBytes: 1 << 16 });
  }

  #claimantOf(box: { readonly boxId: string }): SlotClaimant {
    return { install: this.#access.installId, box: box.boxId };
  }

  async #claimant(box: BoxIdentity): Promise<string> {
    const key = (await this.#access.publicKey()).trim();
    return `install=${this.#access.installId}\nbox=${box.boxId}\nthread=${box.threadId}\nname=${box.name}\nkind=${box.kind}\ncreated=${box.createdAt}\nkey=${key}\n`;
  }

  #ending(record: NamespaceHostRecord): boolean {
    return this.#access.now() >= record.endsAt - ENDING_MS;
  }

  #ends(record: Pick<NamespaceHostRecord, "endsAt">): Pick<Guest, "endsAt" | "facts"> {
    return { endsAt: record.endsAt, facts: [{ label: "Ends", value: `${clock(record.endsAt)} UTC, when its Namespace host does` }] };
  }

  #promiseGuest(record: Pick<NamespaceHostRecord, "tag" | "instance" | "endsAt">, boxId: string): Guest {
    return { ref: `${record.tag}/for-${boxId}`, host: null, address: null, size: null, data: { box: boxId, [NS_HOST_KEY]: record.tag, ...(record.instance ? { instance: record.instance } : {}) }, ...this.#ends(record) };
  }

  #slotGuest(record: NamespaceHostRecord, boxId: string, placement: SlotPlacement, id: string): Guest {
    return { ref: `${record.tag}/${id}`, host: null, address: null, size: null, data: { box: boxId, [NS_HOST_KEY]: record.tag, instance: record.instance!, slot: id, ...placementData(placement) }, ...this.#ends(record) };
  }

  async offer(kind: SlotKind, model: string | null, signal: AbortSignal): Promise<SlotTier> {
    if (kind !== "ios") return { tier: "wait", words: "Namespace hosts lend only ios boxes." };
    if (!this.#access.settings().on) return { tier: "wait", words: "Shared iOS hosts are off in bb-box's Namespace settings." };
    const offerable = this.offerable();
    if (!offerable.ok) return { tier: "wait", words: `No Namespace host can start: ${offerable.why}.` };
    const slotModel = offerable.device.devices[0].model;
    if (model && model !== slotModel) return { tier: "wait", words: slotModelRefusal(slotModel, model) };
    const record = await this.record();
    if (record && record.phase !== "failed") {
      if (this.#ending(record)) return { tier: "wait", words: `The Namespace host ends at ${clock(record.endsAt)} UTC, within the hour, as Namespace's Macs live at most the plan's longest life, so it lends no new slot.` };
      if (record.phase === "starting") {
        if (record.promised.length < record.most) return { tier: "join", host: record.tag, waitMs: Math.max(5_000, record.made + NEW_HOST_WAIT_MS - this.#access.now()) };
        return { tier: "wait", words: `The Namespace host starting has all its ${record.most} slots promised.` };
      }
      if (!record.instance) return { tier: "wait", words: "The Namespace host has no machine." };
      let status: HostStatus;
      try {
        status = await this.#status(record.instance, signal);
      } catch (error) {
        return { tier: "wait", words: words(error) };
      }
      if (status.deletingSince !== null) return { tier: "wait", words: "The Namespace host is being deleted." };
      if (this.#order.slotForNewBox(record.tag, status.slots, this.#acquiringBoxes)) return { tier: "ready", host: record.tag, waitMs: CLAIM_WAIT_MS };
      if (status.slots.some((slot) => spareMaking(slot, null))) return { tier: "join", host: record.tag, waitMs: SLOT_MAKING_MS / 2 };
      if (status.counted + status.promises.length < status.most && (status.diskGiB === null || status.diskGiB >= status.diskReserveGiB)) return { tier: "make", host: record.tag, waitMs: SLOT_MAKING_MS };
      return { tier: "wait", words: `The Namespace host has all its ${status.most} slots making, ready, held or promised (${heldCount(status)} held). A slot is likely free when one of its boxes is released.` };
    }
    if (record?.phase === "failed") return { tier: "wait", words: `The last Namespace host failed, and bb-box removes it before it starts another: ${record.failure ?? "no reason recorded"}` };
    const room = await this.#access.room(signal);
    if (!room.shape) return { tier: "wait", words: `No Namespace host can start: ${room.words ?? "Namespace has no Mac for it now"}` };
    if (room.words) return { tier: "wait", words: `No Namespace host can start now: ${room.words}` };
    return { tier: "new-host", where: "Namespace", waitMs: NEW_HOST_WAIT_MS, cost: "namespace-mac" };
  }

  async take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    return this.#serial(async () => {
      const taken = await this.#take(choice, box, signal);
      const ref = "lost" in taken ? null : namespaceSlotOf(taken);
      if (ref && ref.slot === null) this.#order.asked(ref.tag, box.boxId);
      return taken;
    });
  }

  async #take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    switch (choice.tier) {
      case "new-host":
        return this.#newHost(box, signal);
      case "join":
      case "make":
        return this.#promise(box, signal);
      case "ready":
        return this.#claimReady(box, signal);
      default:
        return { lost: `The Namespace backend cannot take a ${choice.tier} answer.` };
    }
  }

  async #newHost(box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    if (await this.record()) return { lost: "Another Namespace host exists already." };
    const room = await this.#access.room(signal);
    if (!room.shape || room.words) return { lost: `No Namespace host can start now: ${room.words ?? "Namespace has no Mac for it"}` };
    const settings = this.#access.settings();
    const sizing = this.#sizing(this.#access.report(), room.shape);
    const now = this.#access.now();
    const record: NamespaceHostRecord = {
      tag: `bbbox-${this.#access.installId}-ios-host-${randomBytes(3).toString("hex")}`,
      instance: null,
      made: now,
      endsAt: now + this.#access.longestLifeMs(),
      phase: "starting",
      promised: [box.boxId],
      most: sizing.most,
      ahead: Math.min(settings.ahead, sizing.most),
      resettingMost: settings.resettingMost,
      diskReserveGiB: settings.diskReserveGiB,
      failure: null,
      startBy: this.#instance,
      startBeat: now,
      hardware: null,
    };
    await this.#save(record);
    this.#access.log(`Starting a Namespace host for box ${box.name}, a ${room.shape.cores}x${room.shape.memoryGB} Mac with ${sizing.words}.`);
    this.#kickStart(room.shape);
    return this.#promiseGuest(record, box.boxId);
  }

  async #promise(box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const record = await this.record();
    if (!record || record.phase === "failed") return { lost: "The Namespace host is no longer there." };
    if (record.phase === "starting") {
      let full = false;
      const updated = await this.#update((current) => {
        if (current.phase !== "starting" || current.promised.includes(box.boxId)) return current;
        if (current.promised.length >= current.most) return (full = true), current;
        return { ...current, promised: [...current.promised, box.boxId] };
      });
      if (!updated || full) return { lost: full ? "The Namespace host has all its slots promised." : "The Namespace host is no longer there." };
      if (updated.phase === "starting") return this.#promiseGuest(updated, box.boxId);
      return this.#promise(box, signal);
    }
    if (!record.instance) return { lost: "The Namespace host has no machine." };
    const result = await this.#helper(record.instance, "promise", [], claimantInput(this.#claimantOf(box)), 90_000, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.done) return this.#promiseGuest(record, box.boxId);
    if (result.exitCode === DEVICE_HOST_EXITS.full && (await this.#status(record.instance, signal)).slots.some((slot) => spareMaking(slot, null))) return this.#promiseGuest(record, box.boxId);
    return { lost: result.stderr.trim() || `The Namespace host refused the promise, exit code ${result.exitCode}.` };
  }

  async #claimReady(box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken> {
    const record = await this.record();
    if (!record || record.phase !== "serving" || !record.instance) return { lost: "The Namespace host is no longer serving." };
    const status = await this.#status(record.instance, signal);
    const ready = this.#order.slotForNewBox(record.tag, status.slots, this.#acquiringBoxes);
    if (!ready) return { lost: "The Namespace host has no ready slot now that no box asked for earlier waits for." };
    return this.#claim(record, ready.id, box, status.most, signal);
  }

  async #claim(record: NamespaceHostRecord, slot: string, box: BoxIdentity, most: number, signal?: AbortSignal): Promise<Guest | { readonly lost: string }> {
    const result = await this.#helper(record.instance!, "claim", [slot], await this.#claimant(box), HELPER_LONG_MS, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) {
      const said = result.stderr.trim() || `exit code ${result.exitCode}`;
      if (result.exitCode === DEVICE_HOST_EXITS.lost || result.exitCode === DEVICE_HOST_EXITS.notReady || result.exitCode === DEVICE_HOST_EXITS.deleting) return { lost: said };
      throw new Error(`The Namespace host could not lend slot ${slot}: ${said}`);
    }
    const answer = Object.fromEntries(result.stdout.split("\n").flatMap((line) => (line.includes("=") ? [[line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]] : [])));
    const placement = namespaceSlotPlacement(record.tag, answer.slot ?? slot, Number(answer.ports), most);
    if (!placement) throw new Error(`The Namespace host lent slot ${slot}, but its answer could not be read: ${result.stdout.trim()}`);
    return this.#slotGuest(record, box.boxId, placement, answer.slot ?? slot);
  }

  #kickStart(shape: MacShape | null): void {
    if (this.#start) return;
    this.#start = this.#startHost(shape)
      .catch((error) => this.#access.logError("start the Namespace host", error))
      .finally(() => (this.#start = null));
  }

  async #startHost(given: MacShape | null): Promise<void> {
    const signal = this.#stopping.signal;
    const began = performance.now();
    let record = await this.record();
    if (!record || record.phase !== "starting") return;
    record = (await this.#update((current) => ({ ...current, startBy: this.#instance, startBeat: this.#access.now() })))!;
    const beat = setInterval(() => void this.#update((current) => (current.startBy === this.#instance ? { ...current, startBeat: this.#access.now() } : current)).catch(() => undefined), START_BEAT_MS);
    beat.unref?.();
    let instance = record.instance;
    try {
      if (!instance) {
        const shape = given ?? (await this.#access.room(signal)).shape;
        if (!shape) throw new Error("Namespace has no Mac for it now");
        instance = (await this.#access.create(record.tag, shape, signal)).id;
        record = (await this.#update((current) => ({ ...current, instance })))!;
      }
      const ready = await this.#access.wait(instance, signal);
      if (ready.status !== "running") throw new Error(`Namespace's Mac ${instance} is ${ready.status}, not running`);
      await this.#access.answers(instance, this.#access.now() + 5 * 60_000, signal);
      await this.#access.joinTailnet?.(instance, signal);
      const machineUp = performance.now();
      const measured = await this.#access.measure(instance, signal);
      if (measured.capabilities.simulator.is !== "yes") throw new Error(`its Mac cannot run the iOS Simulator: ${measured.capabilities.simulator.is === "no" ? measured.capabilities.simulator.why : "not known"}`);
      const command = await this.#access.command(instance);
      const unpacked = await command.run(UNPACK_SETUP, { stdin: await this.#access.setupArchive(), timeoutMs: 120_000, signal });
      if (unpacked.exitCode !== 0) throw new Error(`bb-box's setup did not unpack on it: ${unpacked.stderr.trim() || `exit code ${unpacked.exitCode}`}`);
      const setUp = await command.run(hostSetupScript(record), { timeoutMs: HOST_SETUP_MS, signal, maxOutputBytes: 1 << 20 });
      if (setUp.exitCode !== 0) throw new Error(`its iOS slots were not set up: ${setUp.stderr.trim().split("\n").slice(-3).join(" ") || `exit code ${setUp.exitCode}`}`);
      const hardware = measured.capabilities.hardwareEncoder.is === "yes" ? true : measured.capabilities.hardwareEncoder.is === "no" ? false : null;
      const promised = await this.#serial(async () => {
        const handed: string[] = [];
        for (;;) {
          const current = (await this.record())!;
          const left = current.promised.filter((box) => !handed.includes(box));
          if (!left.length) break;
          for (const box of left) {
            const result = await this.#helper(instance!, "promise", [], claimantInput({ install: this.#access.installId, box }), 90_000, signal);
            if (result.exitCode !== DEVICE_HOST_EXITS.done) this.#access.log(`The Namespace host did not take the promise for box ${box}: ${result.stderr.trim()}`);
            handed.push(box);
          }
        }
        await this.#update((current) => ({ ...current, phase: "serving", promised: current.promised.filter((box) => !handed.includes(box)), startBy: null, startBeat: null, hardware }));
        return handed;
      });
      const total = (performance.now() - began) / 1000;
      this.#access.log(`The Namespace host on ${instance} serves, ${total.toFixed(1)} s after its start (its Mac ${((machineUp - began) / 1000).toFixed(1)} s), for ${promised.length} boxes: ${setUp.stdout.trim().split("\n").pop() ?? ""}.`);
      if (!promised.length) await this.#vacate(signal);
    } catch (error) {
      if (signal.aborted) throw error;
      const why = words(error);
      await this.#update((current) => ({ ...current, phase: "failed", failure: why, startBy: null, startBeat: null })).catch(() => undefined);
      if (instance) await this.#access.destroy(instance, "bb-box: the Namespace host did not start").catch((cause) => this.#access.logError("destroy the Namespace host after its start failed", cause));
      throw new Error(`The Namespace host did not start: ${why}`);
    } finally {
      clearInterval(beat);
    }
  }

  async #vacate(signal?: AbortSignal): Promise<boolean> {
    const record = await this.record();
    if (!record?.instance) return false;
    const result = await this.#helper(record.instance, "vacate", [], `install=${this.#access.installId}\n`, 90_000, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done || !/^last=yes$/m.test(result.stdout)) return false;
    await this.#deleteHost(record, "its last box went");
    return true;
  }

  async #deleteHost(record: NamespaceHostRecord, why: string): Promise<void> {
    const began = performance.now();
    if (record.instance) await this.#access.leaveTailnet?.(record.instance).catch((error) => this.#access.logError("take the Namespace host off the tailnet", error));
    if (record.instance) await this.#access.destroy(record.instance, `bb-box: the Namespace host is deleted, as ${why}`);
    await this.#save(null);
    this.#access.log(`Deleted the Namespace host${record.instance ? ` ${record.instance}` : ""}, as ${why}, in ${((performance.now() - began) / 1000).toFixed(1)} s.`);
  }

  async #serving(signal: AbortSignal): Promise<NamespaceHostRecord> {
    const deadline = this.#access.now() + HOST_START_MS;
    for (;;) {
      signal.throwIfAborted();
      const record = await this.record();
      if (!record) throw new Error("The Namespace host is gone.");
      if (record.phase === "failed") throw new Error(`The Namespace host failed: ${record.failure ?? "no reason recorded"}`);
      if (record.phase === "serving" && record.instance) return record;
      if (!this.#start && !this.#startedElsewhere(record)) this.#kickStart(null);
      if (this.#access.now() > deadline) throw new Error(`The Namespace host did not serve within ${HOST_START_MS / 60_000} minutes.`);
      await this.#access.sleep(POLL_MS, signal);
    }
  }

  #startedElsewhere(record: NamespaceHostRecord): boolean {
    return record.startBy !== null && record.startBy !== this.#instance && record.startBeat !== null && this.#access.now() - record.startBeat < START_LIVE_MS;
  }

  async acquire(box: BoxIdentity, previous: Guest, hooks: AcquireHooks, signal: AbortSignal): Promise<Guest> {
    this.#acquiringBoxes.add(box.boxId);
    const ref = namespaceSlotOf(previous)!;
    this.#order.asked(ref.tag, box.boxId);
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
      const claimed = readPlacement(previous.data).ok && ref.slot !== null;
      let guest = previous;
      if (!claimed) {
        const record = await timed("host", () => this.#serving(signal));
        guest = await timed("slot", () => this.#slotFor(record, box, signal));
        this.#order.served(box.boxId);
        taken = guest;
        await hooks.claim(guest);
      }
      const transport = await this.#slotTransport(guest);
      await timed("ready", () => this.#answers(transport, signal));
      return guest;
    } catch (error) {
      if (!signal.aborted && !this.#stopping.signal.aborted) await this.release(taken).catch((cause) => this.#access.logError(`release ${taken.ref} after a failed acquire`, cause));
      throw error;
    } finally {
      this.#order.served(box.boxId);
      this.#acquiringBoxes.delete(box.boxId);
    }
  }

  async #answers(transport: SlotUserTransport, signal: AbortSignal): Promise<void> {
    const deadline = this.#access.now() + SLOT_READY_MS;
    while (!(await transport.probe(signal))) {
      if (this.#access.now() > deadline) throw new Error(`The slot's user did not answer within ${SLOT_READY_MS / 60_000} minutes.`);
      await this.#access.sleep(POLL_MS, signal);
    }
  }

  async #slotFor(record: NamespaceHostRecord, box: BoxIdentity, signal: AbortSignal): Promise<Guest> {
    const instance = record.instance!;
    const deadline = this.#access.now() + SLOT_READY_MS;
    for (;;) {
      signal.throwIfAborted();
      const status = await this.#status(instance, signal);
      const mine = status.claims.find((claim) => claim.install === this.#access.installId && claim.box === box.boxId);
      const line = mine && status.slots.find((slot) => slot.id === mine.slot);
      if (line) {
        const placement = namespaceSlotPlacement(record.tag, line.id, line.portBase, status.most);
        if (placement) return this.#slotGuest(record, box.boxId, placement, line.id);
      }
      if (status.deletingSince !== null) throw new Error(`The Namespace host was being deleted before box ${box.name} got a slot.`);
      if (this.#access.now() > deadline) throw new Error(`The Namespace host gave box ${box.name} no slot within ${SLOT_READY_MS / 60_000} minutes.`);
      const ready = this.#order.slotFor(record.tag, box.boxId, status.slots, this.#acquiringBoxes);
      if (ready) {
        this.#order.claiming(box.boxId, ready.id);
        const claimed = await this.#claim(record, ready.id, box, status.most, signal).finally(() => this.#order.looking(box.boxId));
        if (!("lost" in claimed)) return claimed;
        continue;
      }
      if (status.slots.some((slot) => spareMaking(slot, box.boxId))) {
        await this.#access.sleep(POLL_MS, signal);
        continue;
      }
      if (!status.promises.some((promise) => promise.box === box.boxId)) {
        const again = await this.#helper(instance, "promise", [], claimantInput(this.#claimantOf(box)), 90_000, signal);
        if (again.exitCode === DEVICE_HOST_EXITS.full && this.#order.servesFirst(record.tag, box.boxId)) {
          await this.#access.sleep(POLL_MS, signal);
          continue;
        }
        if (again.exitCode !== DEVICE_HOST_EXITS.done) throw new BackendError("no_capacity", `The Namespace host has no room for box ${box.name} now: ${again.stderr.trim()}`);
      }
      this.#order.making(box.boxId);
      const made = await this.#helper(instance, "make", [], claimantInput(this.#claimantOf(box)), SLOT_READY_MS, signal).finally(() => this.#order.looking(box.boxId));
      if (made.exitCode === DEVICE_HOST_EXITS.done) continue;
      if (made.exitCode === DEVICE_HOST_EXITS.full || made.exitCode === DEVICE_HOST_EXITS.lost) {
        await this.#access.sleep(POLL_MS * 2, signal);
        continue;
      }
      throw new Error(`The Namespace host could not make a slot for box ${box.name}: ${made.stderr.trim() || `exit code ${made.exitCode}`}`);
    }
  }

  async #slotTransport(guest: Guest): Promise<SlotUserTransport> {
    const ref = namespaceSlotOf(guest);
    if (!ref?.instance) throw new BackendError("gone", `Box guest ${guest.ref} is on no Namespace Mac.`);
    const placement = readPlacement(guest.data);
    if (!placement.ok || placement.value.on !== "slot") throw new Error(`Box guest ${guest.ref} holds no slot.`);
    return new SlotUserTransport(await this.#access.command(ref.instance), slotUser(placement.value));
  }

  async release(guest: Guest, signal?: AbortSignal): Promise<{ readonly last: boolean }> {
    const ref = namespaceSlotOf(guest)!;
    this.#order.served(ref.box);
    const record = await this.record();
    if (!record || record.tag !== ref.tag) return { last: false };
    if (record.phase === "starting" && !ref.slot) {
      const updated = await this.#update((current) => ({ ...current, promised: current.promised.filter((box) => box !== ref.box) }));
      if (updated?.phase === "starting") return { last: !updated.promised.length };
    }
    if (record.phase === "failed" || !record.instance) return { last: true };
    const result = ref.slot
      ? await this.#helper(record.instance, "release", [ref.slot], claimantInput({ install: this.#access.installId, box: ref.box }), 300_000, signal)
      : await this.#helper(record.instance, "unpromise", [], claimantInput({ install: this.#access.installId, box: ref.box }), 90_000, signal);
    if (result.exitCode === DEVICE_HOST_EXITS.notOurs) return { last: false };
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The Namespace host could not release box ${ref.box}'s ${ref.slot ? `slot ${ref.slot}` : "promise"}: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    const last = /^last=yes$/m.test(result.stdout);
    if (last) await this.#deleteHost(record, "its last box was released");
    return { last };
  }

  async power(guest: Guest, signal?: AbortSignal): Promise<PowerState | null> {
    const ref = namespaceSlotOf(guest)!;
    const record = await this.record();
    if (!record || record.tag !== ref.tag) return null;
    if (record.phase === "starting") return "running";
    if (!record.instance) return null;
    const instance = await this.#access.describe(record.instance, signal);
    if (!instance || instance.status === "destroyed" || instance.status === "destroying") return null;
    return instance.status === "running" ? "running" : "unknown";
  }

  async held(signal?: AbortSignal): Promise<HeldGuest[]> {
    const record = await this.record();
    if (!record) return [];
    if (record.phase === "starting") return record.promised.map((box) => ({ ...this.#promiseGuest(record, box), owner: null, power: "running" as const }));
    if (record.phase !== "serving" || !record.instance) return [];
    const status = await this.#status(record.instance, signal).catch(() => null);
    if (!status) return [];
    const held: HeldGuest[] = [];
    for (const promise of status.promises) if (promise.install === this.#access.installId) held.push({ ...this.#promiseGuest(record, promise.box), owner: null, power: "running" });
    for (const claim of status.claims) {
      if (claim.install !== this.#access.installId) continue;
      const line = status.slots.find((slot) => slot.id === claim.slot);
      const placement = line && namespaceSlotPlacement(record.tag, line.id, line.portBase, status.most);
      if (!placement || line.is !== "held") continue;
      held.push({
        ...this.#slotGuest(record, claim.box, placement, claim.slot),
        owner: { boxId: claim.box, threadId: claim.thread ?? "", name: claim.name, kind: claim.kind, createdAt: claim.created },
        power: "running",
      });
    }
    return held;
  }

  async transports(guest: Guest): Promise<BoxTransports> {
    const ref = namespaceSlotOf(guest)!;
    const command = await this.#slotTransport(guest);
    const host = await this.#access.command(ref.instance!);
    return { command, displays: [], access: null, ...(ref.slot ? { daemonKeptByHost: slotDaemonKeptByHost(host, ref.slot, this.#claimantOf({ boxId: ref.box }), slotDaemonPortOf(guest)) } : {}) };
  }

  async restartDeviceServer(guest: Guest, signal?: AbortSignal): Promise<void> {
    const ref = namespaceSlotOf(guest)!;
    if (!ref.instance || !ref.slot) return;
    const result = await this.#helper(ref.instance, "restart", [ref.slot], claimantInput(this.#claimantOf({ boxId: ref.box })), 60_000, signal);
    if (result.exitCode !== DEVICE_HOST_EXITS.done) throw new Error(`The Namespace host could not start slot ${ref.slot}'s device server again: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  hostInstance(): Promise<string | null> {
    return this.record().then((record) => record?.instance ?? null);
  }

  async maintain(signal?: AbortSignal): Promise<void> {
    const record = await this.record();
    if (!record) return;
    try {
      if (record.phase === "failed") {
        if (record.instance) await this.#access.destroy(record.instance, "bb-box: the Namespace host failed", signal).catch(() => undefined);
        await this.#save(null);
        return;
      }
      if (record.phase === "starting") {
        if (!this.#start && !this.#startedElsewhere(record)) this.#kickStart(null);
        return;
      }
      if (!record.instance) return;
      const instance = await this.#access.describe(record.instance, signal);
      if (!instance || instance.status === "destroyed" || instance.status === "destroying" || this.#access.now() >= record.endsAt) {
        if (instance && instance.status !== "destroyed") await this.#access.destroy(record.instance, "bb-box: the Namespace host reached the plan's longest life", signal).catch(() => undefined);
        await this.#save(null);
        this.#access.log(`The Namespace host ${record.instance} is gone${this.#access.now() >= record.endsAt ? ", at the plan's longest life" : ""}.`);
        return;
      }
      const ahead = Math.min(ENDING_MS, record.endsAt - this.#access.now());
      if (ahead > 0 && (instance.deadline ?? 0) - this.#access.now() < ahead - 5 * 60_000) await this.#access.extend(record.instance, ahead, signal);
      if (this.#acquiringBoxes.size) return;
      const status = await this.#status(record.instance, signal);
      if (status.deletingSince !== null) return;
      const kept = status.slots.some((slot) => slot.is === "held" || (slot.is === "making" && slot.madeFor !== null)) || status.promises.length > 0;
      if (!kept) await this.#serial(() => this.#vacate(signal));
    } catch (error) {
      this.#access.logError("upkeep of the Namespace host", error);
    }
  }

  async doctor(signal?: AbortSignal): Promise<DoctorCheck> {
    const id = "ios-hosts.namespace" as DoctorCheck["id"];
    const name = "Shared iOS hosts on Namespace";
    if (!this.#access.settings().on) return { id, name, status: "skipped", detail: "Shared iOS hosts are off in bb-box's Namespace settings.", fix: null };
    const offerable = this.offerable();
    const record = await this.record();
    if (!record) {
      if (!offerable.ok) return { id, name, status: "warn", detail: `No Namespace host can start: ${offerable.why}.`, fix: "Run bb box doctor again once bb-box has measured a Namespace Mac; it measures each one it starts." };
      const device = offerable.device.devices[0];
      const os = "os" in device.runtime ? device.runtime.os : "";
      return { id, name, status: "ok", detail: `No Namespace host runs. One starts when an ios box finds no slot on a pool Mac or a Tart host: a ${device.model} on iOS ${os}, on the workspace's one Mac, which then holds no macos box. It lives until its last box goes, or an hour before the plan's longest life.`, fix: null };
    }
    if (record.phase !== "serving" || !record.instance) return { id, name, status: record.phase === "failed" ? "warn" : "ok", detail: `The Namespace host is ${record.phase}${record.failure ? `: ${record.failure}` : ""}, with ${record.promised.length} boxes promised, made ${Math.round((this.#access.now() - record.made) / 1000)} s ago.`, fix: record.phase === "failed" ? "bb-box removes it at its next upkeep." : null };
    const status = await this.#status(record.instance, signal).catch((error: unknown) => error as Error);
    if (status instanceof Error) return { id, name, status: "warn", detail: `The Namespace host on ${record.instance} did not answer: ${status.message}`, fix: "bb-box tries again at its next upkeep." };
    const count = (is: string) => status.slots.filter((slot) => slot.is === is).length;
    const ending = this.#ending(record) ? " It lends no new slot, as it ends within the hour." : "";
    return {
      id,
      name,
      status: "ok",
      detail: `The Namespace host on ${record.instance}: ${count("held")} held, ${count("ready")} ready, ${count("making")} making, ${status.sweeping} sweeping, of ${status.most}; ends at ${clock(record.endsAt)} UTC; video by ${record.hardware === false ? "software, as its Mac has no hardware H.264 encoder" : "its Mac's hardware H.264 encoder"}.${ending}`,
      fix: null,
    };
  }

  dispose(): void {
    this.#stopping.abort(new Error("bb-box stopped."));
  }
}
