import { displayShows, type BoxIdentity, type Guest, type KindCapabilities } from "../backends/types.ts";
import { deviceModels, listWords, type DeviceOffer, type IosModelName, type IosRuntime } from "./device.ts";

export const HOST_KINDS = ["pool-mac", "tart", "namespace"] as const;
export type HostKind = (typeof HOST_KINDS)[number];

export interface HostSettings {
  readonly most: number;
  readonly ahead: number;
  readonly resettingMost: number;
}

interface HostCommon {
  readonly id: string;
  readonly runtime: IosRuntime;
  readonly cores: number;
  readonly memoryGiB: number;
  readonly settings: HostSettings;
}

export const HOST_FAILURES = ["start-failed", "helper-failed", "no-slot-made"] as const;
export type HostFailure = (typeof HOST_FAILURES)[number];

export const DRAIN_REASONS = ["image", "ending", "operator"] as const;
export type DrainReason = (typeof DRAIN_REASONS)[number];

export type HostState =
  | { readonly is: "starting"; readonly promised: readonly string[]; readonly since: number }
  | { readonly is: "serving" }
  | { readonly is: "draining"; readonly why: DrainReason; readonly lends: boolean; readonly since: number }
  | { readonly is: "stopped"; readonly since: number }
  | { readonly is: "deleting"; readonly since: number }
  | { readonly is: "failed"; readonly error: { readonly code: HostFailure; readonly words: string }; readonly since: number };

export type PoolMacState =
  | { readonly is: "free" }
  | { readonly is: "whole"; readonly box: string }
  | { readonly is: "resetting-whole"; readonly since: number }
  | { readonly is: "slots" }
  | { readonly is: "out-of-service"; readonly why: string };

export type DeviceHost =
  | (HostCommon & { readonly on: "pool-mac"; readonly machine: string; readonly state: PoolMacState; readonly endsAt?: never })
  | (HostCommon & { readonly on: "tart"; readonly mac: string; readonly vm: string; readonly state: HostState; readonly endsAt?: never })
  | (HostCommon & { readonly on: "namespace"; readonly instance: string; readonly endsAt: number; readonly state: HostState });

export const CARRIED_GENERATIONS = [1, 2] as const;
export type CarriedGeneration = (typeof CARRIED_GENERATIONS)[number];

export type SlotName = { readonly carried: true; readonly generation: CarriedGeneration } | { readonly carried: false; readonly generation: number };

export interface SlotDevice {
  readonly model: IosModelName;
  readonly udid: string;
}

export const MAKING_STEPS = ["user", "device", "first-boot", "daemons"] as const;
export const RESETTING_STEPS = ["processes", "user", "sweep"] as const;

export type SlotState =
  | { readonly is: "making"; readonly step: (typeof MAKING_STEPS)[number]; readonly for: string | null; readonly since: number }
  | { readonly is: "ready"; readonly device: SlotDevice; readonly booted: boolean }
  | { readonly is: "held"; readonly box: string; readonly for: "ios"; readonly device: SlotDevice; readonly since: number }
  | { readonly is: "held"; readonly box: string; readonly for: "macos"; readonly device?: never; readonly since: number }
  | { readonly is: "releasing"; readonly box: string; readonly since: number }
  | { readonly is: "resetting"; readonly step: (typeof RESETTING_STEPS)[number]; readonly since: number };

export type Slot = SlotName & {
  readonly host: string;
  readonly state: SlotState;
};

export const CARRIED_UID_BASE = 79990;
export const MADE_UID_BASE = 80000;
export const MADE_UID_SPAN = 10000;
export const LAST_GENERATION = MADE_UID_SPAN - 1;

export const slotUser = (slot: SlotName): string => (slot.carried ? `bbd-i${slot.generation}` : `bbd-${slot.generation}`);
export const slotUid = (slot: SlotName): number => (slot.carried ? CARRIED_UID_BASE + slot.generation : MADE_UID_BASE + slot.generation);

export const PORT_BASE = 20000;
export const PORTS_PER_SLOT = 100;

export interface SlotPorts {
  readonly base: number;
  readonly count: number;
}

export const slotPorts = (place: number): SlotPorts => ({ base: PORT_BASE + PORTS_PER_SLOT * place, count: PORTS_PER_SLOT });

export type SlotPlacement = SlotName & {
  readonly on: "slot";
  readonly host: string;
  readonly hostOn: HostKind;
  readonly place: number;
  readonly most: number;
};

export type Placement = { readonly on: "vm" } | SlotPlacement;

export const OWN_VM: Placement = { on: "vm" };

export type SlotTier =
  | { readonly tier: "ready"; readonly host: string; readonly waitMs: number }
  | { readonly tier: "join"; readonly host: string; readonly waitMs: number }
  | { readonly tier: "make"; readonly host: string; readonly waitMs: number }
  | { readonly tier: "new-host"; readonly where: string; readonly waitMs: number; readonly cost: "vm-slot" | "namespace-mac" }
  | { readonly tier: "own-vm"; readonly where: string; readonly waitMs: number }
  | { readonly tier: "wait"; readonly words: string };

export const SLOT_KINDS = ["ios", "macos"] as const;
export type SlotKind = (typeof SLOT_KINDS)[number];

export type SlotTaken = Guest | { readonly lost: string };

export interface SlotLender {
  readonly on: HostKind;
  lends(kind: SlotKind): boolean;
  offer(kind: SlotKind, model: string | null, signal: AbortSignal): Promise<SlotTier>;
  take(choice: SlotTier, box: BoxIdentity, signal: AbortSignal): Promise<SlotTaken>;
}

export const TAKE_TRIES = 3;

const TIER_RANKS: Readonly<Record<SlotTier["tier"], number>> = { ready: 0, join: 1, make: 2, "new-host": 3, "own-vm": 4, wait: 5 };
const HOST_RANKS: Readonly<Record<HostKind, number>> = { "pool-mac": 0, tart: 1, namespace: 2 };

export interface LenderAnswer<L> {
  readonly lender: L;
  readonly on: HostKind;
  readonly tier: SlotTier;
}

function answerRank(answer: LenderAnswer<unknown>): readonly number[] {
  const { tier } = answer;
  const cost = tier.tier === "new-host" && tier.cost === "namespace-mac" ? 1 : 0;
  return [TIER_RANKS[tier.tier], cost, HOST_RANKS[answer.on], "waitMs" in tier ? tier.waitMs : Number.MAX_SAFE_INTEGER];
}

export function bestAnswer<L>(answers: readonly LenderAnswer<L>[]): LenderAnswer<L> | null {
  const ranked = answers.map((answer) => ({ answer, rank: answerRank(answer) }));
  ranked.sort((a, b) => {
    for (let at = 0; at < a.rank.length; at++) if (a.rank[at] !== b.rank[at]) return a.rank[at]! - b.rank[at]!;
    return 0;
  });
  return ranked[0]?.answer ?? null;
}

export function waitWords(answers: readonly LenderAnswer<unknown>[]): string {
  const words = [...new Set(answers.flatMap((answer) => (answer.tier.tier === "wait" ? [answer.tier.words] : [])))];
  return words.join(" ") || "No shared iOS host has room now.";
}

export function lostWords(kind: string, lost: readonly string[]): string {
  return `Every shared iOS host bb-box asked had its room taken first, ${TAKE_TRIES} times, so this ${kind} box has no slot: ${lost.join(" ")} Ask again.`;
}

export function isSlotKind(kind: string): kind is SlotKind {
  return (SLOT_KINDS as readonly string[]).includes(kind);
}

const PLACEMENT_KEYS = {
  host: "slotHost",
  hostOn: "slotHostOn",
  generation: "slotGeneration",
  carried: "slotCarried",
  place: "slotPlace",
  most: "slotMost",
} as const;

export function placementData(placement: SlotPlacement): Readonly<Record<string, string | number | boolean>> {
  return {
    [PLACEMENT_KEYS.host]: placement.host,
    [PLACEMENT_KEYS.hostOn]: placement.hostOn,
    [PLACEMENT_KEYS.generation]: placement.generation,
    [PLACEMENT_KEYS.carried]: placement.carried,
    [PLACEMENT_KEYS.place]: placement.place,
    [PLACEMENT_KEYS.most]: placement.most,
  };
}

export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly words: string };

class Refusal extends Error {}

type Fields = Readonly<Record<string, unknown>>;

const MAX_PROMISED = 64;
const MAX_TEXT = 200;

function refuse(path: string, problem: string): never {
  throw new Refusal(`${path} ${problem}`);
}

function parsing<T>(read: () => T): Parsed<T> {
  try {
    return { ok: true, value: read() };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, words: error.message };
    throw error;
  }
}

function shown(value: unknown): string {
  if (value === undefined) return "missing";
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 40 ? `${text.slice(0, 37)}...` : text;
}

function fields(value: unknown, path: string, keys: readonly string[]): Fields {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse(path, `must be an object, not ${shown(value)}.`);
  const extra = Object.keys(value).filter((key) => !keys.includes(key));
  if (extra.length) refuse(path, `has ${listWords(extra.map((key) => `"${key}"`))}, which ${extra.length === 1 ? "it does" : "they do"} not take. It takes ${listWords(keys.map((key) => `"${key}"`))}.`);
  return value as Fields;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value === "") refuse(path, `must be text, not ${shown(value)}.`);
  if (value.length > MAX_TEXT) refuse(path, `is longer than ${MAX_TEXT} characters.`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") refuse(path, `must be true or false, not ${shown(value)}.`);
  return value;
}

function whole(value: unknown, path: string, least = 0, most = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < least || value > most) refuse(path, `must be a whole number from ${least} to ${most}, not ${shown(value)}.`);
  return value;
}

function oneOf<const T extends string | number>(value: unknown, path: string, options: readonly T[]): T {
  if (!(options as readonly unknown[]).includes(value)) refuse(path, `must be ${listWords(options.map((option) => (typeof option === "string" ? `"${option}"` : String(option))), "or")}, not ${shown(value)}.`);
  return value as T;
}

const time = (value: unknown, path: string) => whole(value, path);

function slotName(carried: unknown, generation: unknown, paths: { readonly carried: string; readonly generation: string }): SlotName {
  if (bool(carried, paths.carried)) return { carried: true, generation: oneOf(generation, paths.generation, CARRIED_GENERATIONS) };
  return { carried: false, generation: whole(generation, paths.generation, 1, LAST_GENERATION) };
}

function settingsOf(value: unknown, path: string): HostSettings {
  const read = fields(value, path, ["most", "ahead", "resettingMost"]);
  const most = whole(read.most, `${path}.most`, 1, 64);
  return { most, ahead: whole(read.ahead, `${path}.ahead`, 0, most), resettingMost: whole(read.resettingMost, `${path}.resettingMost`, 1, 64) };
}

function iosRuntimeOf(value: unknown, path: string): IosRuntime {
  const read = fields(value, path, ["platform", "os", "build", "xcode", "companion"]);
  oneOf(read.platform, `${path}.platform`, ["ios"]);
  return { platform: "ios", os: text(read.os, `${path}.os`), build: text(read.build, `${path}.build`), xcode: text(read.xcode, `${path}.xcode`), companion: text(read.companion, `${path}.companion`) };
}

function hostStateOf(value: unknown, path: string, most: number): HostState {
  const is = oneOf((value as Fields | null)?.is, `${path}.is`, ["starting", "serving", "draining", "stopped", "deleting", "failed"]);
  switch (is) {
    case "starting": {
      const read = fields(value, path, ["is", "promised", "since"]);
      if (!Array.isArray(read.promised)) refuse(`${path}.promised`, `must be a list, not ${shown(read.promised)}.`);
      if (read.promised.length > Math.min(most, MAX_PROMISED)) refuse(`${path}.promised`, `has ${read.promised.length} boxes, more than the host's ${most} slots.`);
      const promised = read.promised.map((box, index) => text(box, `${path}.promised[${index}]`));
      if (new Set(promised).size !== promised.length) refuse(`${path}.promised`, "names a box twice.");
      return { is, promised, since: time(read.since, `${path}.since`) };
    }
    case "serving":
      fields(value, path, ["is"]);
      return { is };
    case "draining": {
      const read = fields(value, path, ["is", "why", "lends", "since"]);
      return { is, why: oneOf(read.why, `${path}.why`, DRAIN_REASONS), lends: bool(read.lends, `${path}.lends`), since: time(read.since, `${path}.since`) };
    }
    case "stopped":
    case "deleting": {
      const read = fields(value, path, ["is", "since"]);
      return { is, since: time(read.since, `${path}.since`) };
    }
    case "failed": {
      const read = fields(value, path, ["is", "error", "since"]);
      const error = fields(read.error, `${path}.error`, ["code", "words"]);
      return { is, error: { code: oneOf(error.code, `${path}.error.code`, HOST_FAILURES), words: text(error.words, `${path}.error.words`) }, since: time(read.since, `${path}.since`) };
    }
  }
}

function poolMacStateOf(value: unknown, path: string): PoolMacState {
  const is = oneOf((value as Fields | null)?.is, `${path}.is`, ["free", "whole", "resetting-whole", "slots", "out-of-service"]);
  switch (is) {
    case "free":
    case "slots":
      fields(value, path, ["is"]);
      return { is };
    case "whole": {
      const read = fields(value, path, ["is", "box"]);
      return { is, box: text(read.box, `${path}.box`) };
    }
    case "resetting-whole": {
      const read = fields(value, path, ["is", "since"]);
      return { is, since: time(read.since, `${path}.since`) };
    }
    case "out-of-service": {
      const read = fields(value, path, ["is", "why"]);
      return { is, why: text(read.why, `${path}.why`) };
    }
  }
}

const COMMON_KEYS = ["id", "runtime", "cores", "memoryGiB", "settings", "on", "state"] as const;

function deviceHostOf(value: unknown, path: string): DeviceHost {
  const on = oneOf((value as Fields | null)?.on, `${path}.on`, HOST_KINDS);
  const extra = on === "pool-mac" ? ["machine"] : on === "tart" ? ["mac", "vm"] : ["instance", "endsAt"];
  const read = fields(value, path, [...COMMON_KEYS, ...extra]);
  const settings = settingsOf(read.settings, `${path}.settings`);
  const common = {
    id: text(read.id, `${path}.id`),
    runtime: iosRuntimeOf(read.runtime, `${path}.runtime`),
    cores: whole(read.cores, `${path}.cores`, 1, 1024),
    memoryGiB: whole(read.memoryGiB, `${path}.memoryGiB`, 1, 65536),
    settings,
  };
  if (on === "pool-mac") return { ...common, on, machine: text(read.machine, `${path}.machine`), state: poolMacStateOf(read.state, `${path}.state`) };
  const state = hostStateOf(read.state, `${path}.state`, settings.most);
  if (on === "tart") return { ...common, on, mac: text(read.mac, `${path}.mac`), vm: text(read.vm, `${path}.vm`), state };
  return { ...common, on, instance: text(read.instance, `${path}.instance`), endsAt: time(read.endsAt, `${path}.endsAt`), state };
}

const IOS_MODEL_NAMES: readonly IosModelName[] = deviceModels("ios").map((model) => model.name as IosModelName);

function slotDeviceOf(value: unknown, path: string): SlotDevice {
  const read = fields(value, path, ["model", "udid"]);
  return { model: oneOf(read.model, `${path}.model`, IOS_MODEL_NAMES), udid: text(read.udid, `${path}.udid`) };
}

function slotStateOf(value: unknown, path: string): SlotState {
  const is = oneOf((value as Fields | null)?.is, `${path}.is`, ["making", "ready", "held", "releasing", "resetting"]);
  switch (is) {
    case "making": {
      const read = fields(value, path, ["is", "step", "for", "since"]);
      return { is, step: oneOf(read.step, `${path}.step`, MAKING_STEPS), for: read.for === null ? null : text(read.for, `${path}.for`), since: time(read.since, `${path}.since`) };
    }
    case "ready": {
      const read = fields(value, path, ["is", "device", "booted"]);
      return { is, device: slotDeviceOf(read.device, `${path}.device`), booted: bool(read.booted, `${path}.booted`) };
    }
    case "held": {
      const kind = oneOf((value as Fields).for, `${path}.for`, SLOT_KINDS);
      if (kind === "macos") {
        const read = fields(value, path, ["is", "box", "for", "since"]);
        return { is, box: text(read.box, `${path}.box`), for: kind, since: time(read.since, `${path}.since`) };
      }
      const read = fields(value, path, ["is", "box", "for", "device", "since"]);
      return { is, box: text(read.box, `${path}.box`), for: kind, device: slotDeviceOf(read.device, `${path}.device`), since: time(read.since, `${path}.since`) };
    }
    case "releasing": {
      const read = fields(value, path, ["is", "box", "since"]);
      return { is, box: text(read.box, `${path}.box`), since: time(read.since, `${path}.since`) };
    }
    case "resetting": {
      const read = fields(value, path, ["is", "step", "since"]);
      return { is, step: oneOf(read.step, `${path}.step`, RESETTING_STEPS), since: time(read.since, `${path}.since`) };
    }
  }
}

function slotOf(value: unknown, path: string): Slot {
  const read = fields(value, path, ["host", "generation", "carried", "state"]);
  return { ...slotName(read.carried, read.generation, { carried: `${path}.carried`, generation: `${path}.generation` }), host: text(read.host, `${path}.host`), state: slotStateOf(read.state, `${path}.state`) };
}

export function parseDeviceHost(value: unknown): Parsed<DeviceHost> {
  return parsing(() => deviceHostOf(value, "host"));
}

export function parseSlot(value: unknown): Parsed<Slot> {
  return parsing(() => slotOf(value, "slot"));
}

export function readPlacement(data: Guest["data"]): Parsed<Placement> {
  return parsing(() => {
    if (data?.[PLACEMENT_KEYS.host] === undefined) return OWN_VM;
    const path = "guest.data";
    const most = whole(data[PLACEMENT_KEYS.most], `${path}.${PLACEMENT_KEYS.most}`, 1, 64);
    return {
      on: "slot",
      host: text(data[PLACEMENT_KEYS.host], `${path}.${PLACEMENT_KEYS.host}`),
      hostOn: oneOf(data[PLACEMENT_KEYS.hostOn], `${path}.${PLACEMENT_KEYS.hostOn}`, HOST_KINDS),
      ...slotName(data[PLACEMENT_KEYS.carried], data[PLACEMENT_KEYS.generation], { carried: `${path}.${PLACEMENT_KEYS.carried}`, generation: `${path}.${PLACEMENT_KEYS.generation}` }),
      place: whole(data[PLACEMENT_KEYS.place], `${path}.${PLACEMENT_KEYS.place}`, 0, most - 1),
      most,
    };
  });
}

export function placementOf(box: { readonly guest: Guest | null }): Placement {
  const read = readPlacement(box.guest?.data);
  return read.ok ? read.value : OWN_VM;
}

export function inSlot(box: { readonly guest: Guest | null }): boolean {
  return placementOf(box).on === "slot";
}

export function slotCapabilities(offer: KindCapabilities): KindCapabilities {
  return {
    ...offer,
    command: offer.command ? { ...offer.command, admin: false } : null,
    displays: offer.displays.filter((display) => displayShows(display) === "device"),
    computerUse: null,
    device: offer.device ? ({ ...offer.device, devices: [offer.device.devices[0]] } as DeviceOffer) : null,
  };
}

export const NO_SHARED_IOS_HOST = "No shared iOS host is set up";

export const SHARED_IOS_BY_DEFAULT = false;

export interface SharedHosts {
  readonly on: boolean;
  readonly why: string | null;
  readonly byDefault: boolean;
}

export const SHARED_HOSTS_OFF: SharedHosts = { on: false, why: NO_SHARED_IOS_HOST, byDefault: SHARED_IOS_BY_DEFAULT };

export function sharedHostsOn(byDefault: boolean): SharedHosts {
  return { on: true, why: null, byDefault };
}

export function slotModelRefusal(slotModel: string, asked: string): string {
  return `A shared ios box has the ${slotModel}, the model every slot is made with. Leave device out for it, or ask for dedicated: true for the ${asked}.`;
}

const HOST_WORDS: Readonly<Record<HostKind, string>> = {
  "pool-mac": "the pool's Mac",
  tart: "a Tart VM",
  namespace: "a Namespace Mac",
};

export function placementWords(placement: Placement): string {
  if (placement.on === "vm") return "A VM of its own.";
  const ports = slotPorts(placement.place);
  return `On a shared iOS host (${HOST_WORDS[placement.hostOn]}), slot ${placement.place + 1} of ${placement.most}. Ports ${ports.base} to ${ports.base + ports.count - 1}, in BB_PORT_BASE and BB_PORT_COUNT.`;
}

export function sharedBoxWords(kind: string): string {
  return `A shared ${kind} box`;
}

function ownVmAsking(kind: string): string {
  return kind === "macos" ? "acquire a macos box without shared for a VM of its own" : "ask for dedicated";
}

export function stopRefusal(kind: string): string {
  return `${sharedBoxWords(kind)} cannot be stopped on its own: it shares its host with other boxes. Release it, or ${ownVmAsking(kind)}.`;
}

export function restartRefusal(kind: string): string {
  return `${sharedBoxWords(kind)} cannot be restarted on its own: it shares its host with other boxes. Release it, or ${ownVmAsking(kind)}.${kind === "ios" ? " box_device reboot reboots its device." : ""}`;
}

export function resizeRefusal(kind: string): string {
  const asking = kind === "macos" ? "acquire a macos box without shared, with a size" : "ask for dedicated: true with a size";
  return `${sharedBoxWords(kind)} has no size of its own, so it cannot be resized. Release it, and ${asking}.`;
}

export function grantRefusal(kind: string): string {
  const asking = kind === "macos" ? "Acquire a macos box without shared for a VM of its own, or macos-desktop for one with a desktop." : "Ask for dedicated: true for a VM of its own.";
  return `${sharedBoxWords(kind)} has no console session, so there is nothing to grant macOS permissions to. ${asking}`;
}

export function noDesktopRefusal(name: string, kind: string): string {
  const asking = kind === "macos" ? "acquire macos-desktop for a VM with a desktop" : "ask for dedicated: true for a VM with a desktop";
  return `Box ${name} is ${sharedBoxWords(kind).toLowerCase()}, a macOS user on a shared iOS host with no console session: it has no desktop, so nothing it runs can open a window, take a screenshot or be driven by the computer tools. Run commands without desktop, or ${asking}.`;
}

export function rootRefusalWords(kind: string): string {
  const asking = kind === "macos" ? "Acquire a macos box without shared for a VM of its own" : "Ask for dedicated: true for a VM of its own";
  return `no, the box user cannot use sudo or brew install on a shared host. ${asking}`;
}

export const SHARED_MACOS_DESKTOP_WORDS = "none. A shared macos box has no console session: no app windows, screenshots, computer use or macOS permission grants. Acquire a macos box without shared for a VM of its own";

export const SHARED_MACOS_WORDS =
  "a macOS user on a Mac or VM shared with ios boxes, ready in seconds, for commands, builds and the iOS Simulator, with its own files and keychain, but no sudo, Homebrew installs, desktop or app windows, and cores, ports and processes shared";

export function sharedMacosHint(): string {
  return ` Or ask for shared: true: ${SHARED_MACOS_WORDS}.`;
}

export function sizeRefusal(kind: string): string {
  return kind === "macos" ? "A shared macos box has no size of its own. Leave shared out for a VM of its own at that size." : SIZE_NEEDS_DEDICATED;
}

export const SIZE_NEEDS_DEDICATED = "A shared ios box has no size of its own. Ask for dedicated: true with a size.";

export function sharedRefusal(kind: SlotKind): string {
  const without = kind === "ios" ? "Leave shared out, or ask for dedicated: true," : "Leave shared out";
  return `${NO_SHARED_IOS_HOST}, so ${kind === "ios" ? "an" : "a"} ${kind} box cannot have a slot on one yet. ${without} for a VM of its own.`;
}
