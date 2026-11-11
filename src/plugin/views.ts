// What the panel, the tools and the CLI show about boxes: plain JSON views
// for the panel, and short text for agents. Nothing here holds a credential.

import { PRODUCT } from "../brand.ts";
import { providerName } from "../core/provider-name.ts";
import { boxForm, driverLabel, providerFamily, type BackendStatus, type OfferedKind } from "../backends/index.ts";
import { currentKindId, kindAliases, kindInfo, vmOffersLast } from "../backends/kinds.ts";
import { desktopDisplays, deviceDisplayOf, type Arch, type BoxForm, type CardClaim, type GpuPart, type MachineSize, type Capacity, type DoctorReport, type GpuRoom, type GuestOs, type Resizing, type Snapshotting, type Windowing } from "../backends/types.ts";
import { offerSnapshotWords } from "./snapshot-words.ts";
import type { Versions } from "../backends/versions.ts";
import type { TryResult } from "./bakes.ts";
import type { Draft } from "../core/draft.ts";
import type { ImageView, OwnImagesOf } from "./images.ts";
import { OPERATOR, RELEASE_OR_DELETE_KEPT, extraFeatures, forkedFromWords, isAcquiring, resizingWords, stopWords, type BoxImage, type BoxRecord, type BoxState, type EnrolState, type KindChange, type ResizeAnswer, type UserspaceInstalled } from "../core/boxes.ts";
import type { ControlView } from "../core/control.ts";
import type { Problem } from "../core/document.ts";
import type { MovedCopy } from "../core/move.ts";
import { claimOf, configuredGpu, gpuPartsOffered, gpuWhenNotAsked, holdsCard, recordedGpu, userspaceOf, type GpuWhenNotAsked, type NvidiaUserspace } from "../core/gpu.ts";
import { USERSPACE_INSTALL_SECONDS, agentUserspaceWords, gpuPartToRetry, readingWords, unfinishedUpdate, updateLeftWords, userspaceState, type UserspaceReading, type UserspaceState, type UserspaceUpdate } from "../core/gpu-userspace.ts";
import { PRESETS, describeSize, formatMiB, kindSizes, type Preset, type SizeChange, type SizeChanges } from "../core/sizes.ts";
import type { ConfigState } from "./configuration.ts";
import type { ThreadOnBox } from "./contract.ts";
import type { DisplayProtocol } from "../transports/types.ts";
import { actionsOf, deviceModel, isTestOffer, platformWord, type DevicePlatform, type DeviceState, type Runtime } from "../core/device.ts";
import { deviceStateWords } from "../core/device-settings.ts";
import { inSlot, isSlotKind, placementOf, slotHostName, placementWords, rootRefusalWords, SHARED_HOSTS_OFF, SHARED_MACOS_DESKTOP_WORDS, SHARED_MACOS_WORDS, type SharedHosts, type SlotKind } from "../core/device-host.ts";
import { offeredWords } from "../core/mac-capabilities.ts";
import type { BoxLogView } from "../core/box-log.ts";
import type { Reach } from "../core/reach.ts";
import { JOIN_TRIES, joiningWords } from "../core/join-tries.ts";

export type ReachView =
  | Reach
  | { readonly is: "not-in-settings"; readonly backend: string; readonly lastAnswered: number | null }
  | { readonly is: "backend-silent"; readonly backend: string; readonly since: number; readonly error: string; readonly lastAnswered: number | null };

export interface BoxTold {
  readonly log: BoxLogView | null;
  readonly reach: ReachView | null;
}

const DEVICE_HOST_KINDS: ReadonlySet<string> = new Set(["ios", "macos", "macos-desktop"]);

export interface BoxView {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  readonly backendLabel: string;
  readonly provider?: string;
  readonly nature: "virtual" | "real";
  /** What the box is, as a badge: an LXC or Docker container, a VM or a physical machine. Null when its backend's driver is gone. */
  readonly form: BoxForm | null;
  readonly shared: boolean;
  readonly slotHost?: string | null;
  readonly role: "box" | "machine";
  /** In words: what the box has, or else what it was asked to be. Null when neither is known. */
  readonly size: string | null;
  readonly state: BoxState;
  readonly error: string | null;
  readonly releaseHeldForKept?: boolean;
  /** Why it last stopped without bb-box's request, and what bb-box did, in words (#406). */
  readonly stopped: string | null;
  readonly waitingOn?: string | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly os: string;
  readonly arch: string;
  readonly gpu: boolean;
  readonly gpuPart?: GpuPart;
  readonly claim?: CardClaim | null;
  readonly nvidiaUserspace?: NvidiaUserspace;
  readonly userspaceRead?: UserspaceReading | null;
  readonly userspaceUpdate?: UserspaceUpdate | null;
  readonly userspaceRunningSeenAt?: number | null;
  readonly userspaceNotice?: UserspaceNotice | null;
  readonly requires: readonly string[];
  /** Features beyond what the kind promises. */
  readonly extras: readonly string[];
  /** The box has Docker (041), whichever ID it was asked for by. A Linux box without it says "No Docker". */
  readonly docker: boolean;
  readonly desktop: boolean;
  /** The desktop the viewer shows, when the box has one. */
  readonly display: { readonly protocol: DisplayProtocol; readonly resizable: boolean; readonly clipboard: "commands" | null; readonly refresh: "viewer" | null; readonly quality: number | null; readonly macKeys: "alt-command" | null } | null;
  readonly device?: { readonly platform: DevicePlatform; readonly model: string | null; readonly simulatorHost: boolean } | null;
  /** Who controls the desktop's input, when the box has one. */
  readonly control: ControlView | null;
  readonly computerUse: boolean;
  /** A person can open a terminal in it: it is ready and runs commands. Every command transport gives a shell on a PTY on BB's server. */
  readonly terminal: boolean;
  readonly address: string | null;
  readonly facts: readonly { readonly label: string; readonly value: string }[];
  readonly timings: Readonly<Record<string, number>>;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  readonly joinTries?: JoinTriesView | null;
  /** Its kind's boxes join BB as machines when enrolment is on; Windows kinds unless their backend's switch is off (#539). */
  readonly enrols: boolean;
  readonly canStopStart: boolean;
  /** What the box has, in parts, or else what it was asked to be; null when neither is known (061's Resize). Absent from older plugins. */
  readonly sizeNow?: SizeView | null;
  /** What its backend can resize for its kind, and how (061); null when nothing. Absent from older plugins. */
  readonly resizing?: Resizing | null;
  /** Its last resize (061), or null. Absent from older plugins. */
  readonly lastResize?: ResizeView | null;
  readonly log?: BoxLogView | null;
  readonly reach?: ReachView | null;
  readonly forkedFrom?: { readonly name: string; readonly snapshot: string; readonly takenAt: number } | null;
}

export interface JoinTriesView {
  readonly failed: number;
  readonly of: number;
  readonly next: number | null;
  readonly words: string;
  readonly setup: boolean;
}

/** A box's last resize (061), as the panel shows it. */
export interface ResizeView {
  readonly to: SizeView;
  /** When it began, in ms since the epoch. */
  readonly at: number;
  readonly state: "resizing" | "done" | "failed";
  readonly restart: boolean;
  readonly ms: number | null;
  readonly error: string | null;
}

/** What the box has, read from its guest, or else the size it was asked to be. */
export function boxSize(box: BoxRecord): MachineSize | null {
  return box.guest?.size ?? box.size ?? null;
}

function sizeWords(box: BoxRecord): string | null {
  if (inSlot(box)) return null;
  const size = boxSize(box);
  return size ? describeSize(size) : null;
}

function platformOfUnofferedDevice(os: string): DevicePlatform {
  return os === "macos" ? "ios" : "android";
}

export function boxView(box: BoxRecord, canStopStart: boolean, control: ControlView, resizing: Resizing | null = null, told: BoxTold = { log: null, reach: null }): BoxView {
  const [display] = desktopDisplays(box.capabilities.displays);
  const offer = box.capabilities.device;
  const device = deviceDisplayOf(box.capabilities.displays)
    ? { platform: offer?.platform ?? platformOfUnofferedDevice(box.capabilities.os), model: box.device?.model ?? box.askedDevice ?? offer?.devices[0].model ?? null, simulatorHost: offer?.platform === "ios" && !isTestOffer(offer) }
    : null;
  return {
    id: box.id,
    name: box.name,
    kind: box.kind,
    kindLabel: box.kindLabel,
    backendLabel: box.backendLabel,
    provider: providerFamily(box.backend),
    nature: box.nature,
    form: inSlot(box) ? null : boxForm(box.backend),
    shared: inSlot(box),
    slotHost: slotHostName(box),
    role: box.role,
    size: sizeWords(box),
    state: box.state,
    error: box.error,
    releaseHeldForKept: box.state === "releasing" && (box.error ?? "").startsWith("Release did not finish: ") && (box.error ?? "").endsWith(RELEASE_OR_DELETE_KEPT),
    stopped: stopWords(box) || null,
    waitingOn: waitingWords(box),
    createdAt: box.createdAt,
    readyAt: box.readyAt,
    os: box.capabilities.os,
    arch: box.capabilities.arch,
    gpu: holdsCard(recordedGpu(box)),
    gpuPart: recordedGpu(box),
    claim: claimOf(box),
    nvidiaUserspace: userspaceOf(box),
    userspaceRead: box.userspaceRead ?? null,
    userspaceUpdate: box.userspaceUpdate ?? null,
    userspaceRunningSeenAt: box.userspaceRunningSeenAt ?? null,
    userspaceNotice: userspaceNoticeOf(box),
    requires: box.requires,
    extras: extraFeatures(box),
    docker: box.capabilities.features.includes("docker"),
    desktop: !!display,
    display: display ? { protocol: display.protocol, resizable: display.resizable, clipboard: display.clipboard ?? null, refresh: display.refresh ?? null, quality: display.quality ?? null, macKeys: display.macKeys ?? null } : null,
    device,
    control: display || device ? control : null,
    computerUse: box.capabilities.computerUse !== null,
    terminal: box.state === "ready" && box.capabilities.command !== null,
    address: box.guest?.address ?? null,
    facts: box.guest?.facts ?? [],
    timings: box.timings,
    enrol: box.enrol,
    joinTries: box.joinTries ? { failed: box.joinTries.failed, of: JOIN_TRIES, next: box.joinTries.next, words: box.joinTries.words, setup: box.joinTries.setup } : null,
    enrols: box.capabilities.enrol,
    canStopStart,
    sizeNow: boxSize(box) ? sizeView(boxSize(box)!) : null,
    resizing,
    lastResize: box.resize ? { to: sizeView(box.resize.to), at: box.resize.at, state: box.resize.state, restart: box.resize.restart, ms: box.resize.ms, error: box.resize.error } : null,
    log: told.log,
    reach: told.reach,
    forkedFrom: box.fork ? { name: box.fork.source.name, snapshot: box.fork.snapshot.name, takenAt: box.fork.snapshot.takenAt } : null,
  };
}

export interface SizeView {
  readonly cores: number;
  readonly memoryGiB: number;
  /** Null: the base disk. */
  readonly diskGiB: number | null;
  readonly words: string;
}

export function sizeView(size: MachineSize): SizeView {
  return { cores: size.cores, memoryGiB: size.memoryMiB / 1024, diskGiB: size.diskGiB, words: describeSize(size) };
}

export interface KindView {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  /** The default preset in words. */
  readonly size: string;
  /** Small, medium and large (028). */
  readonly presets: readonly ({ readonly name: Preset } & SizeView)[];
  readonly defaultPreset: Preset;
  /** The largest custom size. */
  readonly largest: SizeView;
  readonly gpu: boolean;
  readonly gpuWhenNotAsked?: GpuPart;
  readonly gpuSetting?: GpuPart;
  readonly desktop: boolean;
  /** The OS, which the panel names the kind by; badges say the rest. */
  readonly os: GuestOs;
  /** x86_64 unless the kind is arm64 (040), which the panel shows as a badge. */
  readonly arch: Arch;
  /** The windowing system a desktop runs (048); the New box form offers X11 or Wayland when a system has both. */
  readonly windowing: Windowing;
  /** The features every offer promises, such as "docker". */
  readonly features: readonly string[];
  /** A box of it can become a BB machine, so a thread can run on it. */
  readonly enrol: boolean;
  /** Its spare boxes (032). */
  readonly spares: SparesView;
  /** The box user can become root on every backend that offers the kind, on none, or, when null, on some. */
  readonly admin: boolean | null;
  /** Its boxes have Docker on every backend that offers the kind, on none, or, when null, on some (041). */
  readonly docker: boolean | null;
  /** The backends that offer it, in the order acquire tries them. */
  readonly backends: readonly string[];
  /** What its boxes are on those backends, as badges, each once. */
  readonly forms: readonly BoxForm[];
  /** Each offer, in the order acquire tries them, for the New box form's provider rows. */
  readonly offers: readonly OfferView[];
  /** Its boxes run a computer-use driver, on every backend that offers it. */
  readonly computerUse: boolean;
  readonly devices: KindDevices | null;
  readonly placement?: KindPlacement | null;
}

export interface KindPlacement {
  readonly kind: SlotKind;
  readonly shared: boolean;
  readonly why: string | null;
  readonly sizeNeedsDedicated: boolean;
}

export type SharedHostsByKind = Readonly<Partial<Record<SlotKind, SharedHosts>>>;

function kindPlacement(kind: string, shared: SharedHostsByKind): KindPlacement | null {
  if (!isSlotKind(kind)) return null;
  const hosts = shared[kind] ?? SHARED_HOSTS_OFF;
  if (kind === "macos" && !hosts.on) return null;
  return { kind, shared: hosts.on, why: hosts.on ? null : hosts.why, sizeNeedsDedicated: kind === "ios" && hosts.on && hosts.byDefault };
}

export interface KindDevices {
  readonly platform: DevicePlatform;
  readonly models: readonly string[];
}

/** One backend's offer of a kind, as the picker's pane shows it. */
export interface OfferView {
  /** The backend's ID, as boxes record it. */
  readonly backend: string;
  /** The provider's name for people and for `on` (044): "Proxmox LXC on pve1", "Docker on devpc", "Tart on 2 Macs". */
  readonly name: string;
  /** The driver's type, for the provider's glyph: "proxmox-lxc", "proxmox-qemu", "docker", "tart", "ssh-pool". */
  readonly type: string;
  /** The driver's label, as settings names the backend: "Proxmox LXC". */
  readonly label: string;
  /** Where its boxes run, by name: a node, each Mac, a Docker host. Empty for a pool and for a local Docker daemon. */
  readonly hosts: readonly string[];
  readonly form: BoxForm | null;
  /** Spare boxes of this kind ready now on this backend (032). */
  readonly ready: number;
  /** A spare here waits stopped, so a box that claims one starts it first: ready in seconds, not at once (#539). Absent means no. */
  readonly spareStarts?: boolean;
  /** Free machines for this kind on a real backend, from its last survey; null for a virtual one or before a survey. */
  readonly free: number | null;
  /** What the backend's boxes of this kind are, where it says more than its form, as a pool's physical machines; absent otherwise. */
  readonly note?: string;
  readonly devices?: string;
  /** What a box of this offer can resize, and how (061); absent when nothing. */
  readonly resizing?: Resizing;
  readonly snapshotting?: Snapshotting;
  /** The box user can become root, or Administrator, on this backend. */
  readonly admin: boolean;
  /** Its desktop follows the viewer's size; null for a kind without a desktop. */
  readonly resizable: boolean | null;
  /** The median total of its last cold starts on this backend, in ms; null until it has had one. */
  readonly typicalReadyMs: number | null;
  /** This offer's boxes have Docker (041). */
  readonly docker: boolean;
  /** The OS of the machine the boxes run on, for "Runs on"; null while the backend does not know it yet, which the form treats as "could be any". */
  readonly hostOs: GuestOs | null;
  /** A GPU desktop's GPUs as the backend last read them (#603); null when it reads none. */
  readonly gpuRoom: GpuRoom | null;
  readonly gpuParts?: readonly GpuPart[];
  readonly cardReach?: string;
}

/** A kind's spare boxes (032): how many it keeps, and how many are ready or being made. */
export interface SparesView {
  readonly target: number;
  readonly ready: number;
  readonly making: number;
}

/** The GPUs of each GPU desktop kind's offers, as their backends last read them (#603), keyed "<kind>|<backend>". */
export async function gpuRooms(offered: readonly OfferedKind[]): Promise<Record<string, GpuRoom>> {
  const rooms: Record<string, GpuRoom> = {};
  await Promise.all(
    offered.map(async ({ kind, backend }) => {
      const room = gpuPartsOffered(kind).some(holdsCard) ? await backend.gpuRoom?.(kind.id).catch(() => null) : null;
      if (room?.readings.length || room?.parts) rooms[`${kind.id}|${backend.id}`] = room;
    }),
  );
  return rooms;
}

export function kindViews(
  offered: readonly OfferedKind[],
  changes: SizeChanges,
  spares: Readonly<Record<string, { readonly ready: number; readonly making: number }>> = {},
  targets: Readonly<Record<string, number>> = {},
  /** Median cold-start totals, keyed "<kind>|<backend>" (the registry's `typicalReady`). */
  typical: Readonly<Record<string, number>> = {},
  /** Spares ready now, keyed "<kind>|<backend>" (the registry's `spareReadyByBackend`). */
  readyByBackend: Readonly<Record<string, number>> = {},
  /** The driver's label for a backend ID, as settings names it; the registry's, which knows the drivers in use. */
  labelOf: (backendId: string) => string = driverLabel,
  /** GPU desktops' GPUs as last read, keyed "<kind>|<backend>" (`gpuRooms`). */
  gpus: Readonly<Record<string, GpuRoom>> = {},
  shared: SharedHostsByKind = {},
  gpuDefaults: GpuWhenNotAsked = {},
): KindView[] {
  const views = new Map<string, KindView>();
  // Each kind's offers in the order a plain acquire tries them (057), the kinds where they first come.
  const first = new Map<string, number>();
  offered.forEach(({ kind }, index) => first.has(kind.id) || first.set(kind.id, index));
  const ordered = vmOffersLast(offered).sort((a, b) => first.get(a.kind.id)! - first.get(b.kind.id)! || Number(a.kind.slotsOnly === true) - Number(b.kind.slotsOnly === true));
  for (const { kind, backend } of ordered) {
    const existing = views.get(kind.id);
    const admin = kind.capabilities.command?.admin ?? false;
    const docker = kind.capabilities.features.includes("docker");
    const form = boxForm(backend.id);
    const key = `${kind.id}|${backend.id}`;
    const type = backend.id.split(":")[0]!;
    const label = labelOf(backend.id);
    const hosts = backend.hosts ?? [];
    const offer: OfferView = {
      backend: backend.id,
      name: providerName({ label, hosts, id: backend.id }),
      type,
      label,
      hosts,
      form,
      ready: readyByBackend[key] ?? 0,
      ...(backend.keepsSession?.(kind.id) ? { spareStarts: true } : {}),
      free: backend.free?.(kind.id) ?? null,
      ...(backend.offerNote?.(kind.id) ? { note: backend.offerNote(kind.id)! } : {}),
      ...(DEVICE_HOST_KINDS.has(kind.id) && offeredWords(backend.macCapabilities?.() ?? []) ? { devices: offeredWords(backend.macCapabilities!())! } : {}),
      ...(backend.resizing?.(kind.id) ? { resizing: backend.resizing(kind.id)! } : {}),
      ...(backend.snapshotting?.(kind.id) ? { snapshotting: backend.snapshotting(kind.id)! } : {}),
      admin,
      resizable: desktopDisplays(kind.capabilities.displays)[0]?.resizable ?? null,
      typicalReadyMs: typical[key] ?? null,
      docker,
      hostOs: backend.hostOs ?? null,
      gpuRoom: gpus[key] ?? null,
      gpuParts: gpuPartsOffered(kind),
      ...cardReachOf(gpus[key]?.reach ?? backend.cardReach?.(kind.id) ?? null),
    };
    const computerUse = kind.capabilities.computerUse !== null;
    const offerDevices = kind.capabilities.device;
    const models = offerDevices ? offerDevices.devices.map((device) => device.model as string) : [];
    if (existing) {
      views.set(kind.id, {
        ...existing,
        admin: existing.admin === admin ? admin : null,
        docker: existing.docker === docker ? docker : null,
        backends: [...existing.backends, backend.label],
        forms: form && !existing.forms.includes(form) ? [...existing.forms, form] : existing.forms,
        offers: [...existing.offers, offer],
        computerUse: existing.computerUse && computerUse,
        devices: existing.devices ? { ...existing.devices, models: [...existing.devices.models, ...models.filter((model) => !existing.devices!.models.includes(model))] } : offerDevices ? { platform: offerDevices.platform, models } : null,
      });
      continue;
    }
    const sizes = kindSizes(kind.id, changes);
    views.set(kind.id, {
      id: kind.id,
      label: kind.label,
      description: kind.description,
      size: describeSize(sizes.presets[sizes.default]),
      presets: PRESETS.map((name) => ({ name, ...sizeView(sizes.presets[name]) })),
      defaultPreset: sizes.default,
      largest: sizeView(sizes.largest),
      gpu: kind.capabilities.gpu,
      gpuWhenNotAsked: gpuWhenNotAsked(kind.id, gpuDefaults),
      ...(configuredGpu(kind.id, gpuDefaults) ? { gpuSetting: configuredGpu(kind.id, gpuDefaults)! } : {}),
      desktop: desktopDisplays(kind.capabilities.displays).length > 0,
      os: kind.capabilities.os,
      arch: kind.capabilities.arch,
      // The windowing system is not in a kind's capabilities; it is known by the kind's ID (048).
      windowing: kindInfo(kind.id).windowing,
      features: kind.requires,
      enrol: kind.capabilities.enrol,
      spares: { target: targets[kind.id] ?? 0, ready: spares[kind.id]?.ready ?? 0, making: spares[kind.id]?.making ?? 0 },
      admin,
      docker,
      backends: [backend.label],
      forms: form ? [form] : [],
      offers: [offer],
      computerUse,
      devices: offerDevices ? { platform: offerDevices.platform, models } : null,
      placement: kindPlacement(kind.id, shared),
    });
  }
  return [...views.values()];
}

export interface BackendView extends BackendStatus {
  readonly setup: { readonly guide: string; readonly scripts: readonly string[] };
}

export interface OfferRoom {
  readonly backend: string;
  readonly available: boolean;
  readonly reason: string | null;
}

/**
 * A provider's profile, behind the (i) on its row in the New box form: read
 * when the row's popover opens, never on every panel load.
 */
export interface ProviderProfile {
  readonly backend: string;
  /** "Proxmox LXC on pve1", as the row names it. */
  readonly name: string;
  /** The driver's description: what the technology is. */
  readonly technology: string;
  readonly nature: "virtual" | "real";
  readonly hosts: readonly string[];
  /** What the machine its boxes run on runs, or null until known. */
  readonly hostOs: GuestOs | null;
  /** The kinds it makes, in acquire order, each with what its boxes are, the usual cold start on it and spares ready. */
  readonly makes: readonly { readonly id: string; readonly label: string; readonly form: BoxForm | null; readonly typicalReadyMs: number | null; readonly ready: number }[];
  /** Boxes on it now, of every thread, in any state but gone. */
  readonly boxes: number;
  /** Room for one more box of the first kind it makes, at the default size; null when it makes nothing or did not answer. */
  readonly room: Capacity | null;
  readonly status: {
    readonly state: "off" | "active" | "misconfigured";
    /** The first thing to fix, when its settings are not valid. */
    readonly problem: string | null;
    /** The doctor's last verdict, summary and time; null before it has run. */
    readonly ok: boolean | null;
    readonly summary: string | null;
    readonly checkedAt: number | null;
  };
}

export interface DoctorView {
  readonly ok: boolean;
  readonly sections: readonly {
    readonly title: string;
    readonly report: DoctorReport;
  }[];
}

const STATE_WORDS: Record<BoxState, string> = {
  acquiring: "being acquired",
  starting: "starting",
  ready: "ready",
  stopping: "stopping",
  stopped: "stopped",
  failed: "failed",
  gone: "gone",
  releasing: "being released",
};

/** Words for timings whose names alone do not say what they are. */
const STEP_WORDS: Readonly<Record<string, string>> = {
  template: "waiting for the template",
  enrol: "BB enrolment",
  spare: "claiming a spare",
  spareResume: "resuming it",
  spareReconnect: "BB machine reconnecting",
  spareSwitch: "switching its device",
  relabel: "naming it for its owner",
  clock: "setting the clock",
  "shared-host": "choosing a shared host",
};

/** Where a box's timings name the steps of its last start. */
const START = "start.";

/** Under 0.1 s in milliseconds, which a claim of a spare takes (#186). */
function seconds(ms: number): string {
  return ms < 100 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** One line per box, for lists. */
export function boxLine(box: BoxRecord): string {
  const size = sizeWords(box);
  const parts = [`${box.name}: ${box.kindLabel} (${box.kind}${holdsCard(recordedGpu(box)) ? `, GPU ${recordedGpu(box)}` : ""}${size ? `, ${size}` : ""}), ${STATE_WORDS[box.state]}`];
  if (box.state === "ready" && box.timings.total !== undefined) parts.push(`ready in ${seconds(box.timings.total)}`);
  if (box.role === "machine") parts.push("this thread's machine");
  else if (box.enrol.state === "enrolled") parts.push(`enrolled as a BB machine${box.timings.enrol !== undefined ? ` in ${seconds(box.timings.enrol)}` : ""}`);
  const model = box.device?.model ?? box.askedDevice;
  if (model) parts.push(`device: ${model}`);
  if (box.error) parts.push(box.error);
  if (box.unrequestedStop && box.state !== "ready") parts.push(stopWords(box));
  return `- ${parts.join("; ")}`;
}

export function placementText(kind: Pick<KindView, "placement">): string {
  if (!kind.placement) return "";
  if (kind.placement.kind === "macos") {
    return ` Each box is a macOS VM of its own, with sudo, brew install and its own cores and ports, unless it asks for shared: true: then ${SHARED_MACOS_WORDS}. Servers on localhost are reachable from every box on the host: use your box's ports, from BB_PORT_BASE.`;
  }
  const why = kind.placement.why ?? "";
  const asking = kind.placement.sizeNeedsDedicated ? "dedicated: true asks for one, and a size needs it" : "dedicated: true asks for one";
  if (kind.placement.shared && kind.placement.sizeNeedsDedicated) {
    return (
      " Shared by default: a macOS user on a Mac or VM shared with other ios boxes, ready in seconds, with its own device, files and keychain, but no sudo, and cores and processes shared;" +
      " where no shared iOS host has room, a VM of its own. Servers on localhost are reachable from every box on the host: use your box's ports, from BB_PORT_BASE." +
      " Ask for dedicated: true for a VM of its own, with sudo, brew install and its own cores, ports and desktop; a size needs it. Another device than the first, or slim: false, gets a VM of its own."
    );
  }
  if (kind.placement.shared) {
    return (
      ` Each box is a macOS VM of its own, with sudo, brew install and its own cores, ports and desktop, unless it asks for shared: true: then a macOS user on a Mac or VM shared with other ios boxes, ready in seconds,` +
      " with its own device, files and keychain, but no sudo, and cores and processes shared. Servers on localhost are reachable from every box on the host: use your box's ports, from BB_PORT_BASE." +
      ` ${asking.charAt(0).toUpperCase()}${asking.slice(1)}.`
    );
  }
  return ` Each box is a macOS VM of its own, with sudo, brew install and its own cores, ports and desktop; ${asking}. ${why}, so shared ios boxes, a macOS user on a Mac or VM shared with other ios boxes, are not offered yet.`;
}

export function devicesText(kind: Pick<KindView, "devices">): string {
  if (!kind.devices?.models.length) return "";
  const [first, ...rest] = kind.devices.models;
  return ` Devices: ${[`${first} (default)`, ...rest].join(", ")}.`;
}

export function runtimeWords(runtime: Runtime): string {
  if (runtime.platform === "ios") return `iOS ${runtime.os} (${runtime.build}), Xcode ${runtime.xcode}, idb_companion ${runtime.companion}`;
  return `Android, API ${runtime.api}, Google APIs, emulator ${runtime.emulator}`;
}

export function deviceLines(box: BoxRecord, state: DeviceState | null, server: string | null, encoder: string | null = null): string[] {
  const offer = box.capabilities.device;
  if (!offer) return [];
  const model = state?.model ?? box.device?.model ?? box.askedDevice ?? offer.devices[0].model;
  const runtime = box.device?.runtime ?? offer.devices.find((device) => device.model === model)?.runtime ?? null;
  const lines = [`Device: ${model}${runtime ? `, ${runtimeWords(runtime)}` : ""}`];
  if (state) {
    lines.push(`Device state: ${deviceStateWords(state)}`);
    lines.push(`Device actions, for box_device: ${actionsOf(deviceModel(state.model)).join(", ")}`);
  } else lines.push(`Device state: ${server ?? `not known yet: ${PRODUCT} has not reached the box's device server`}`);
  if (encoder) lines.push(encoder);
  if (offer.platform === "ios") lines.push(`Device commands: simctl in box_run takes booted as the ${platformWord(offer.platform)} device, as in xcrun simctl openurl booted <url>`);
  if (offer.platform === "android") lines.push("Device commands: adb in box_run reaches the device as emulator-5554, as in adb install app.apk; the Android SDK is in /opt/android-sdk");
  if (offer.platform === "ios" && box.slim === false) lines.push("Slim: off. The device runs every service iOS starts");
  else if (offer.platform === "ios") lines.push("Slim: on. Widgets, Siri, iCloud, Health, Wallet and the like are off; acquire with slim false for an app that needs them");
  return lines;
}

function controlLine(owner: ControlView["owner"], controlled: "desktop" | "device"): string {
  const leaveAlone = controlled === "device" ? "Leave the device alone" : "Leave the desktop's windows alone";
  const words: Record<ControlView["owner"], string> = {
    agent: "the agent",
    human: `the user, in ${PRODUCT}'s panel. ${leaveAlone} until they hand control back, or until they ask you to continue: then call computer_take_control`,
    none: "changing hands",
  };
  return `${controlled === "device" ? "Device" : "Desktop"} control: ${words[owner]}`;
}

/** Whether a kind's box user can become root, or Administrator on Windows, for kind lists. */
export function adminText({ admin, os }: Pick<KindView, "admin" | "os">): string {
  if (os === "windows") {
    if (admin === null) return "Administrator: on some of its backends; box_status says for each box.";
    return admin ? "Administrator: yes, and commands run elevated." : "Administrator: no, the box user is a standard user.";
  }
  if (admin === null) return "Root: on some of its backends, through sudo; box_status says for each box.";
  return admin ? "Root: yes, through sudo without a password." : "Root: no, the box user cannot use sudo.";
}

/** Whether a Linux kind's boxes have Docker (041), for kind lists, naming the alias that makes sure of it. Empty for another OS. */
export function dockerText({ id, docker, os }: Pick<KindView, "id" | "docker" | "os">): string {
  if (os !== "linux") return "";
  if (docker !== null) return docker ? "Docker: yes." : "Docker: no.";
  const alias = kindAliases().find((each) => each.kind === id && each.features.includes("docker"));
  return alias ? `Docker: on some of its backends. Ask for ${alias.id} to be sure of it.` : "Docker: on some of its backends; box_status says for each box.";
}

/** Whether this box's user can become root, or Administrator on Windows. */
function adminLine(capabilities: BoxRecord["capabilities"], kind: string, shared = false): string | null {
  const command = capabilities.command;
  if (!command) return null;
  if (capabilities.os === "windows") return `Administrator: ${command.admin ? "yes" : "no"}`;
  if (shared) return `Root: ${rootRefusalWords(kind)}`;
  return command.admin ? "Root: yes, through sudo without a password" : "Root: no, the box user cannot use sudo. box_list shows the kinds that give root";
}

/** Everything an agent may want to know about one box. */
/** A box's project's image (049): its name, and what its script did as the box started. */
export function imageWords(image: BoxImage): string {
  const what = {
    pending: "its script runs as the box starts",
    running: "running its script",
    done: `its script ran as the box started${image.seconds !== undefined ? `, in ${image.seconds} s` : ""}`,
    failed: "its script failed",
    baked: `built ${builtOn(image.build)}`,
  };
  return `${image.name}, ${what[image.state]}`;
}

/** A build's day from its ID, build.20261003-021500-3f9c: "3 October", or "ahead" when it has none. */
function builtOn(build: string | null | undefined): string {
  const match = /^build\.(\d{4})(\d{2})(\d{2})-/.exec(build ?? "");
  if (!match) return "ahead";
  const day = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return `${day.getUTCDate()} ${day.toLocaleString("en-GB", { month: "long", timeZone: "UTC" })}`;
}

/** What a box is, for its Form line: as its backend said of its machine, else as its backend's form makes it; null when unknown. */
export function formLine(box: BoxRecord): string | null {
  if (inSlot(box)) return "a macOS user on a shared iOS host";
  const said = box.guest?.facts?.find((fact) => fact.label === "Form")?.value;
  if (said) return said;
  const mac = box.capabilities.os === "macos";
  switch (boxForm(box.backend)) {
    case "Physical":
      return mac ? "a physical Mac, lent whole" : "a physical machine, lent whole";
    case "VM":
      return mac ? "a macOS VM" : "a VM";
    case "microVM":
      return "a microVM";
    case "LXC":
      return "an LXC container";
    case "Docker":
      return "a Docker container";
    default:
      return null;
  }
}

function neverReady(box: BoxRecord): boolean {
  return box.readyAt === null && !box.restoredAt;
}

function cardReachOf(reach: string | null): { readonly cardReach?: string } {
  return reach ? { cardReach: reach } : {};
}

export interface UserspaceNotice {
  readonly words: string;
  readonly action: "update" | "update-again" | "resize-again" | null;
}

function boxUserspaceState(box: BoxRecord): UserspaceState {
  return userspaceState(box.userspaceRead, box.userspaceUpdate, box.userspaceRead?.hostDriver ?? null, typeof box.userspaceRunningSeenAt === "number");
}

function installNoticeOf(box: BoxRecord): UserspaceNotice | null {
  if (!unfinishedUpdate(box.userspaceUpdate)) return null;
  const state = boxUserspaceState(box);
  switch (state.is) {
    case "updating":
      return { words: `${PRODUCT} is installing NVIDIA's userspace ${state.update.to} in it, to add its GPU, at its ${state.update.step} step.`, action: null };
    case "running":
      return { words: `An earlier install of NVIDIA's userspace is still running in it: ${PRODUCT} reads its userspace once it ends, and starts no other until then.`, action: null };
    case "half":
      return { words: `It has ${readingWords(state.reading)}, and no GPU.`, action: "resize-again" };
    case "unfinished":
      return state.update.state === "unknown"
        ? { words: `${updateLeftWords(box.name, state.update)} Its GPU was not added. bb box doctor reads it, and says whether that install is still running.`, action: null }
        : { words: `${updateLeftWords(box.name, state.update)} Its GPU was not added.`, action: "resize-again" };
    default:
      return null;
  }
}

export function userspaceNoticeOf(box: BoxRecord): UserspaceNotice | null {
  if (!holdsCard(recordedGpu(box))) return installNoticeOf(box);
  const state = boxUserspaceState(box);
  switch (state.is) {
    case "differs":
      return {
        words: `${state.version === "none" ? "It has no NVIDIA userspace" : `Its NVIDIA userspace is ${state.version}`}, and the host's driver ${state.driver}: nvidia-smi and CUDA fail in it until its userspace is updated.`,
        action: "update",
      };
    case "half":
      return { words: `It has ${readingWords(state.reading)}, so nvidia-smi and CUDA may fail in it.`, action: "update-again" };
    case "unfinished":
      return state.update.state === "unknown"
        ? { words: `${updateLeftWords(box.name, state.update)} bb box doctor reads it, and says whether that update is still running and when to update it again.`, action: null }
        : { words: updateLeftWords(box.name, state.update), action: "update-again" };
    case "updating":
      return { words: `${PRODUCT} is updating NVIDIA's userspace in it to ${state.update.to}, at its ${state.update.step} step.`, action: null };
    case "running":
      return { words: `An earlier update of NVIDIA's userspace is still running in it: ${PRODUCT} reads its userspace once it ends, and starts no other update until then.`, action: null };
    default:
      return null;
  }
}

export function userspaceFixLine(box: BoxRecord): string | null {
  const notice = userspaceNoticeOf(box);
  if (!notice) return null;
  if (!notice.action) return `NVIDIA userspace: ${notice.words}`;
  const owner = box.threadId === OPERATOR ? " --machine" : ` --thread ${box.threadId}`;
  const command = notice.action === "resize-again" ? `bb box resize ${box.name} --gpu ${gpuPartToRetry(box.resize)} --restart${owner}` : `bb box gpu update ${box.name}${owner}`;
  const asked = notice.action === "resize-again" ? "Resize it again" : notice.action === "update-again" ? "Update it again" : "Update it";
  return `NVIDIA userspace: ${notice.words} ${asked}${box.state === "stopped" ? ` once it runs` : ""}: ${command}`;
}

export function gpuLine(box: BoxRecord): string | null {
  const part = recordedGpu(box);
  const fact = box.guest?.facts?.find((candidate) => candidate.label === "GPU")?.value ?? null;
  if (!holdsCard(part)) {
    const install = installNoticeOf(box);
    if (!install) return fact;
    return `${install.words}${install.action === "resize-again" ? ` Call box_resize with gpu ${gpuPartToRetry(box.resize)} and restart true to try again, or ask the user.` : " Ask the user."}`;
  }
  const card = fact ?? part;
  if (/: (nvidia-smi in it|CUDA's driver|CUDA in it)/.test(card)) return `${card}. Ask the user${/NVIDIA userspace is/.test(card) ? " to update its NVIDIA userspace" : ""}.`;
  const userspaceWords = agentUserspaceWords(box.name, boxUserspaceState(box));
  if (userspaceWords) return `${card}. ${userspaceWords}`;
  const userspace = box.nvidiaUserspace;
  const seeIt = box.guest?.facts?.find((candidate) => candidate.label === "GPU check")?.value ?? "Run nvidia-smi to see it";
  return `${card}. ${seeIt}.${userspace && userspace !== "unknown" && userspace !== "none" ? ` NVIDIA's userspace in it: ${userspace}.` : ""}`;
}

export function boxDetail(box: BoxRecord, control?: ControlView): string {
  const capabilities = box.capabilities;
  const lines = [
    `Box ${box.name} (${box.id})`,
    `State: ${STATE_WORDS[box.state]}${box.error ? `. ${box.error}` : ""}`,
    ...(waitingWords(box) ? [`Now: ${waitingWords(box)}`] : []),
    ...(box.unrequestedStop ? [`Last unrequested stop: ${stopWords(box)}`] : []),
    `Kind: ${box.kindLabel} (${box.kind}) from ${box.backendLabel}`,
    ...(formLine(box) ? [`Form: ${formLine(box)}`] : []),
    ...(box.kind === "ios" || inSlot(box) ? [`Where: ${placementWords(placementOf(box))}`] : []),
    ...(sizeWords(box) ? [`Size: ${sizeWords(box)}`] : []),
    `System: ${capabilities.os} ${capabilities.arch}${holdsCard(recordedGpu(box)) ? " with a GPU" : ""}${desktopDisplays(capabilities.displays).length ? ", with a desktop" : ""}`,
  ];
  const admin = adminLine(capabilities, box.kind, inSlot(box));
  if (admin) lines.push(admin);
  if (inSlot(box) && box.kind === "macos") lines.push(`Desktop: ${SHARED_MACOS_DESKTOP_WORDS}`);
  // The Docker line says what a "docker" feature would.
  const linux = capabilities.os === "linux";
  if (linux) lines.push(capabilities.features.includes("docker") ? "Docker: yes" : "Docker: no. box_list says which kinds have it");
  const other = (features: readonly string[]) => (linux ? features.filter((feature) => feature !== "docker") : features);
  const requires = other(box.requires);
  if (requires.length) lines.push(`Features: ${requires.join(", ")}`);
  const extras = other(extraFeatures(box));
  if (extras.length) lines.push(`Also has: ${extras.join(", ")}`);
  if (box.image) lines.push(`Image: ${imageWords(box.image)}`);
  if (box.fork) lines.push(`Origin: ${forkedFromWords(box.fork)}`);
  if (box.guest?.address) lines.push(`Address: ${box.guest.address}`);
  for (const fact of box.guest?.facts ?? []) if (fact.label !== "Form" && fact.label !== "GPU" && fact.label !== "GPU check") lines.push(`${fact.label}: ${fact.value}`);
  const gpu = gpuLine(box);
  if (gpu) lines.push(`GPU: ${gpu}`);
  if (control && capabilities.displays.length) lines.push(controlLine(control.owner, deviceDisplayOf(capabilities.displays) ? "device" : "desktop"));
  const enrol: Record<EnrolState, string> = {
    off:
      capabilities.enrol && neverReady(box)
        ? box.state === "acquiring" || box.state === "starting"
          ? `not yet: it joins BB once it is ready, if ${PRODUCT} enrols boxes`
          : "not enrolled"
        : box.restoredAt && capabilities.enrol
        ? `not enrolled since ${PRODUCT} restored its lost record. It enrols again once it runs and answers, if ${PRODUCT} enrols boxes`
        : capabilities.enrol
          ? // A box made before its kind's boxes joined BB, as a Windows box made before #539, is not enrolled in place.
            `not enrolled: it was made while boxes of its kind did not join BB, and stays so until it is released. A new one joins BB when ${PRODUCT} enrols boxes`
          : "not enrolled",
    enrolling: box.joinTries
      ? `${joiningWords(box.joinTries, Date.now())}. Until it joins, box_run runs commands without the thread's access`
      : `being added, which takes ${capabilities.os === "windows" ? "a minute or two" : "a few seconds"}. box_run waits for it, so commands have the thread's access`,
    enrolled: "enrolled",
    failed: `enrolment failed${box.enrol.error ? `: ${box.enrol.error}` : ""}`,
  };
  lines.push(`BB machine: ${enrol[box.enrol.state]}`);
  const words = (timings: [string, number][]) => timings.map(([step, ms]) => `${STEP_WORDS[step] ?? step} ${seconds(ms)}`).join(", ");
  const timings = Object.entries(box.timings);
  const acquire = timings.filter(([step]) => !step.startsWith(START));
  if (acquire.length) lines.push(`Timings: ${words(acquire)}`);
  const start = timings.flatMap(([step, ms]): [string, number][] => (step.startsWith(START) ? [[step.slice(START.length), ms]] : []));
  if (start.length) lines.push(`Last start: ${words(start)}`);
  const resize = box.resize;
  if (resize) {
    const when = new Date(resize.at).toISOString().slice(0, 16).replace("T", " ");
    const how = resize.state === "resizing" ? "under way" : resize.state === "done" ? `done${resize.ms !== null ? ` in ${seconds(resize.ms)}` : ""}` : `failed: ${resize.error ?? "no reason given"}`;
    lines.push(`Last resize: to ${describeSize(resize.to)}${resize.restart ? ", with a restart" : ""}, at ${when} UTC, ${how}`);
  }
  return lines.join("\n");
}

/** "Next:" hints end every tool result, so an agent always knows what it can do. */
/**
 * Why a box that an acquire stopped waiting for is not ready yet. A restart
 * ends the wait, and the next bb-box goes on acquiring the box (#533).
 */
export function startingWords(box: BoxRecord, restarted: boolean): string {
  if (restarted) return `${PRODUCT} restarted, as for an update, before box ${box.name} was ready. It goes on starting once ${PRODUCT} is back, usually within seconds.`;
  const waiting = waitingWords(box);
  return waiting ? `Box ${box.name} is still starting. ${waiting}` : `Box ${box.name} is still starting.`;
}

export function waitingWords(box: BoxRecord): string | null {
  return isAcquiring(box) ? (box.waitingOn ?? null) : null;
}

export function next(...hints: string[]): string {
  return hints.length ? `\n\nNext: ${hints.join(" ")}` : "";
}

/** An image's line in bb box images list: its build and age, why it is due, and its last rebuild. */
export function imageLine(view: ImageView): string {
  const record = view.build.record;
  const age = record ? Math.floor((Date.now() - Date.parse(record.built)) / 86_400_000) : null;
  const built = record ? `${record.build}, ${age === 0 ? "built today" : `${age} days old`}` : "no record";
  const reason = (view.last?.reason ?? "").replace(/\.+$/, "");
  const last = view.last ? `; last rebuild ${new Date(view.last.at).toISOString().slice(0, 10)} ${view.last.ok ? "passed" : view.last.waiting ? `waited: ${reason}` : `failed: ${reason}`}` : "";
  return `${view.name} (${view.build.kind}): ${built}; ${view.due ? `due, as ${view.due}` : "not due"}${last}.`;
}

export function ownImageLines(of: OwnImagesOf, now = Date.now()): string[] {
  return of.images.map((image) => {
    const name = `${of.backend}/${image.kind} (${image.kind})`;
    const building = image.building ? "; being built now" : "";
    if (!image.ref || image.builtAt === null) return `${name}: not built yet; ${of.label} builds it when a box first needs it${building}.`;
    const days = Math.floor((now - image.builtAt) / 86_400_000);
    const due = image.due ? `due, as ${image.due}` : "not due";
    return `${name}: ${image.ref}, ${days === 0 ? "built today" : `${days} days old`}; ${due}${building}; ${of.label} builds and refreshes it by itself.`;
  });
}

/**
 * A project's image, for a choice of image (049): New box, BB's new-thread
 * inputs, and box_list. A box can also choose "standard", bb-box's own
 * image, which is in no list.
 */
export interface ImageOptionView {
  readonly name: string;
  /** The kinds it covers: a choice shows where one of them is chosen. */
  readonly kinds: readonly string[];
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** One of its projects is the thread's: its boxes of these kinds get it unless they choose another. */
  readonly mine: boolean;
  /** Where it is built ahead, so a box there starts from the build; elsewhere its script runs as the box starts. */
  readonly builds: readonly { readonly kind: string; readonly backend: string; readonly build: string | null; /** ISO 8601. */ readonly built: string }[];
  readonly failed?: readonly { readonly kind: string; readonly backend: string; readonly at: number; readonly reason: string }[];
  /** Its spares (#440), where it has any: a box claims a ready one at once. */
  readonly spares: readonly { readonly kind: string; readonly backend: string; readonly ready: number; readonly making: number }[];
}

/**
 * A kind's images, for box_list (049): this project's first, the default,
 * then standard, then others with their projects; nothing when no image
 * covers the kind.
 */
export function imagesText(images: readonly ImageOptionView[], kind: string): string {
  const covering = images.filter((image) => image.kinds.includes(kind));
  if (!covering.length) return "";
  const words = (image: ImageOptionView) => {
    const spare = (backend: string) => {
      const count = image.spares.find((one) => one.kind === kind && one.backend === backend);
      return count?.ready ? " with a spare ready" : count?.making ? " with a spare being made" : "";
    };
    const built = image.builds.filter((build) => build.kind === kind).map((build) => `${build.backend}${spare(build.backend)}`);
    return `${image.name}${image.mine ? " (this project's, the default)" : ` (${image.projects.map((project) => project.name).join(", ")})`}${built.length ? `, built ahead on ${built.join(", ")}` : ""}`;
  };
  const mine = covering.filter((image) => image.mine);
  const others = covering.filter((image) => !image.mine);
  return ` Images: ${[...mine.map(words), mine.length ? "standard" : "standard (the default)", ...others.map(words)].join("; ")}.`;
}

/** A draft of a project image's script (049): the files it used, what it left to the agent, the script and the check. */
export function draftText(draft: Draft): string {
  return [
    draft.used.length ? `Drafted from ${draft.used.join(", ")}.` : "No file it reads was given, so the draft is a template to fill in.",
    ...(draft.gaps.length ? ["", "Left to you, also commented at the top of the script:", ...draft.gaps.map((gap) => `- ${gap}`)] : []),
    "",
    "`.bb/box-setup.sh`:",
    "```bash",
    draft.script.trimEnd(),
    "```",
    "",
    "`.bb/box-check.sh`:",
    "```bash",
    draft.check.trimEnd(),
    "```",
  ].join("\n");
}

/** What a try of a script did (049): a line per check, then the build's last lines. */
export function tryText(result: TryResult): string {
  // The first check is the script's own, in the build box; a later one failing means the script passed, and says which to fix.
  const where = `on ${result.backend} (${result.kind}), in ${result.seconds} s, as a build runs it`;
  const failed = result.checks.find((check) => !check.ok);
  const head = result.reason
    ? `The try on ${result.backend} (${result.kind}) did not finish, after ${result.seconds} s: ${result.reason}`
    : result.ok || !failed
      ? `The script ${result.ok ? "passed" : "failed"} ${where}.`
      : failed === result.checks[0]
        ? `The script failed ${where}.`
        : `The script passed ${where}, but this failed: ${failed.name}.`;
  const checks = result.checks.map((check) => `- ${check.name}: ${check.ok ? "ok" : "FAIL"}, ${check.detail}`);
  const lines = result.output.length ? ["", `The build's last ${result.output.length} lines:`, ...result.output] : [];
  const kept = result.kept ? [result.kept.box ? `Kept box ${result.kept.box} (${result.kept.detail}).` : `Kept no box: ${result.kept.detail}`] : [];
  return [head, ...checks, ...kept, ...lines].join("\n");
}

/** What a rebuild of the standard Linux images would take, a line per tool, its architectures together where they agree. */
export function versionsText(versions: Versions): string {
  const lines = new Map<string, { words: string; arches: string[]; why: string }>();
  for (const tool of versions.tools) {
    const words = tool.version === tool.pinned ? `${tool.name} ${tool.version}, as pinned` : `${tool.name} ${tool.version}, pinned ${tool.pinned}`;
    const why = tool.kept ?? (tool.version === tool.pinned ? "nothing newer" : tool.source);
    const key = `${words}\n${why}`;
    const line = lines.get(key) ?? { words, arches: [], why };
    line.arches.push(tool.arch);
    lines.set(key, line);
  }
  const { aptSnapshot } = versions;
  return [
    versions.following
      ? `A rebuild of the standard Linux images now takes, against this ${PRODUCT}'s pins:`
      : `With --pinned, a rebuild of the standard Linux images takes this ${PRODUCT}'s pins alone:`,
    ...[...lines.values()].map(({ words, arches, why }) => `  ${words}, for ${arches.join(" and ")}: ${why}.`),
    `  apt snapshot ${aptSnapshot.version}${aptSnapshot.version === aptSnapshot.pinned ? ", as pinned" : `, pinned ${aptSnapshot.pinned}`}.`,
  ].join("\n");
}

export function doctorText(view: DoctorView): string {
  const lines: string[] = [];
  for (const { title, report } of view.sections) {
    lines.push(`${title}: ${report.summary}`);
    for (const check of report.checks) {
      lines.push(`  [${check.status}] ${check.name}: ${check.detail}`);
      if (check.fix && check.status !== "ok") lines.push(`        Fix: ${check.fix}`);
    }
    for (const note of report.notes) lines.push(`  Note: ${note}`);
  }
  if (!view.sections.length) lines.push(`No backend is on. bb box setup docker sets up Docker on the machine that runs BB; or add one with bb box backend add <type>, or in ${PRODUCT}'s settings.`);
  return lines.join("\n");
}

/** One problem per line, with its field's path. */
export function problemsText(problems: readonly Problem[]): string {
  return problems.map((problem) => `  ${problem.path || "(the file)"}: ${problem.message}`).join("\n");
}

function fieldValue(value: unknown): string {
  if (typeof value === "object" && value !== null && "set" in value) return (value as { set: boolean }).set ? "set" : "not set";
  const text = String(value);
  return text.includes("\n") ? `${text.split("\n").length} lines` : JSON.stringify(value);
}

function changeWords(change: SizeChange | undefined): string | null {
  if (!change) return null;
  const parts = [
    change.cores !== undefined ? `${change.cores} cores` : null,
    change.memoryMiB !== undefined ? `${change.memoryMiB / 1024} GiB memory` : null,
    change.diskGiB !== undefined ? (change.diskGiB === null ? "the base disk" : `${change.diskGiB} GiB disk`) : null,
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** The configuration in words, for bb box config show. Secrets show only as set or not. */
export function configText(state: ConfigState): string {
  const { document } = state;
  const lines = [`${PRODUCT}'s configuration, revision ${state.revision}.`, ""];
  if (!document.backends.length) lines.push(`Backends: none. Add one on ${PRODUCT}'s settings page, or with bb box config apply.`);
  else lines.push("Backends, in the order they are tried:");
  for (const backend of document.backends) {
    const status = state.backends.find((candidate) => candidate.id === backend.id);
    const words = { active: "ready", off: "off", misconfigured: "needs setting up" }[status?.state ?? "misconfigured"];
    const offers = status?.kinds.length ? `, offers ${status.kinds.join(", ")}` : "";
    const boxes = status?.boxes ? `, ${status.boxes} ${status.boxes === 1 ? "box" : "boxes"}` : "";
    lines.push(`- ${backend.id} (${status?.label ?? backend.type}): ${backend.enabled ? "on" : "off"}, ${words}${offers}${boxes}.`);
    for (const [key, value] of Object.entries(backend.fields)) lines.push(`    ${key}: ${fieldValue(value)}`);
    const warm = Object.entries(backend.warm ?? {});
    if (warm.length) lines.push(`    warm: ${warm.map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
    for (const host of backend.hosts ?? []) {
      lines.push(`    host ${host.name}: ${host.enabled ? "on" : "off"}${Object.entries(host.fields).map(([key, value]) => `, ${key} ${fieldValue(value)}`).join("")}`);
    }
  }
  lines.push("");
  const kinds = Object.entries(document.kinds);
  if (!kinds.length) lines.push(`Kinds: all on, at ${PRODUCT}'s own sizes.`);
  else {
    lines.push(`Kinds changed from ${PRODUCT}'s own (any other is on, at ${PRODUCT}'s sizes):`);
    for (const [id, kind] of kinds) {
      const parts = [
        kind.enabled === false ? "off" : null,
        ...PRESETS.map((preset) => {
          const words = changeWords(kind.presets?.[preset]);
          return words ? `${preset} ${words}` : null;
        }),
        kind.default ? `default ${kind.default}` : null,
        changeWords(kind.largest) ? `largest ${changeWords(kind.largest)}` : null,
      ].filter(Boolean);
      lines.push(`- ${id}: ${parts.join("; ") || "as shipped"}`);
    }
  }
  lines.push("");
  const general = { ...state.defaults.general, ...document.general };
  lines.push(
    `Boxes per thread: ${general.boxesPerThread || "no limit"}. Enrol boxes as BB machines: ${general.enrol ? "yes" : "no"}. Default kind: ${general.defaultKind}. Linux desktops as video: ${general.video ? "yes" : "no"}.`,
  );
  if (state.problems.length) lines.push("", "Problems:", problemsText(state.problems));
  if (state.migrated) {
    lines.push(
      "",
      `${PRODUCT} keeps a copy of the BB settings it moved into this configuration on ${new Date(state.migrated.at).toISOString()}. bb box config migrated shows it, and --remove removes it.`,
    );
  }
  return lines.join("\n");
}

/** The copy of BB's settings the move kept, for bb box config migrated. */
export function movedText(copy: MovedCopy): string {
  const lines = [
    `${PRODUCT} ${copy.version} moved these BB settings into its configuration on ${new Date(copy.at).toISOString()}. Secrets show only whether they were set.`,
    "",
    ...Object.entries(copy.values).map(([key, value]) => `${key}: ${fieldValue(value)}`),
  ];
  if (copy.notes.length) lines.push("", "Not carried over as they were:", ...copy.notes.map((note) => `- ${note}`));
  lines.push("", "bb box config migrated --json prints the values in full. --remove removes the copy.");
  return lines.join("\n");
}

/** What a release or stop did to the idle threads on a box: "" when there were none. */
export function idleWords(threads: readonly ThreadOnBox[], stopped: boolean): string {
  if (!threads.length) return "";
  const one = threads.length === 1;
  return stopped
    ? ` ${threadsWords(threads).replace(/^t/, "T")}, idle on it, ${one ? "has" : "have"} no machine until it starts again.`
    : ` ${threadsWords(threads).replace(/^t/, "T")}, idle on it, lost ${one ? "its" : "their"} machine. Archive ${one ? "it" : "them"} if ${one ? "it is" : "they are"} done.`;
}

/** "thread Fix the build (thr_1)", or several. */
export function threadsWords(threads: readonly ThreadOnBox[]): string {
  const each = threads.map((thread) => `${thread.title ? `"${thread.title}" ` : ""}(${thread.id})`);
  return `${threads.length === 1 ? "thread" : "threads"} ${each.join(", ")}`;
}

/** A part of a size, from and to, in words: "cores 4 to 6", "memory 8 GiB to 12 GiB", "disk 24 GiB to 32 GiB". */
function partText(part: { part: string; from: number | null; to: number }): string {
  if (part.part === "cores") return `cores ${part.from ?? "?"} to ${part.to}`;
  if (part.part === "memory") return `memory ${part.from === null ? "?" : formatMiB(part.from)} to ${formatMiB(part.to)}`;
  return `disk ${part.from === null ? "the base" : `${part.from} GiB`} to ${part.to} GiB`;
}

/** What box_resize did, or would do, in words (061). */
function sizeWithGpu(size: ResizeAnswer["from"], gpuChanges: boolean): string {
  return gpuChanges ? `${describeSize(size)}, GPU ${size.gpu}` : describeSize(size);
}

export function resizeText(answer: ResizeAnswer, checked: boolean, audience: "person" | "agent" = "person"): string {
  const { box, plan } = answer;
  const gpu = plan?.gpu && answer.from.gpu !== answer.to.gpu ? plan.gpu : null;
  const from = sizeWithGpu(answer.from, gpu !== null);
  const to = sizeWithGpu(answer.to, gpu !== null);
  if (!plan) return `Box ${box.name} is ${describeSize(answer.from)} already, so nothing changed.`;
  const ways = (way: "live" | "restart") => [...plan.parts.filter((part) => part.way === way).map(partText), ...(gpu && gpu.way === way ? [`GPU ${gpu.from} to ${gpu.to}`] : [])];
  const live = ways("live");
  const restart = ways("restart");
  const lines: string[] = [];
  const stopped = gpu?.stopped === true;
  const desktop = currentKindId(answer.becomes?.to ?? box.kind) === "linux-desktop";
  if (checked) {
    lines.push(`Resizing box ${box.name} from ${from} to ${to} would change:`);
    if (live.length) lines.push(stopped ? `- now, while it stays stopped: ${live.join("; ")}` : `- live, while everything in it runs on: ${live.join("; ")}`);
    if (restart.length) lines.push(`- with a restart${plan.downSeconds !== null ? ` of about ${plan.downSeconds} s` : ""}, which ends everything running in it: ${restart.join("; ")}`);
    if (gpu) lines.push(gpu.words);
    if (gpu?.installs) lines.push(installsWords(gpu.installs, desktop));
    if (answer.becomes) lines.push(becomesWords(answer.becomes, answer.to.gpu, false));
    lines.push(plan.room.ok ? "Its host has room for it." : `Its host has no room for it: ${plan.room.message ?? "no reason given"}`);
    return lines.join("\n");
  }
  const took = box.resize?.ms != null ? ` in ${seconds(box.resize.ms)}` : "";
  lines.push(`Resized box ${box.name} from ${from} to ${to}${took}.`);
  if (live.length) lines.push(stopped ? `While it stayed stopped: ${live.join("; ")}.` : `Live, with everything in it still running: ${live.join("; ")}.`);
  if (restart.length) lines.push(`With a restart, which ended what was running in it: ${restart.join("; ")}.`);
  if (gpu) lines.push(gpu.words);
  if (answer.installed) lines.push(installedWords(box, answer.installed, desktop, audience));
  if (answer.becomes) lines.push(becomesWords(answer.becomes, answer.to.gpu, true));
  if (plan.parts.some((part) => part.part === "cores" && part.way === "live")) lines.push("New cores can take up to 15 s to show in the box.");
  return lines.join("\n");
}

function installsWords(driver: string, desktop: boolean): string {
  return `It has no NVIDIA userspace for the host's driver ${driver}, which a card needs, so ${PRODUCT} installs it first, while it runs with no GPU, then restarts it with the card: about ${USERSPACE_INSTALL_SECONDS} s more${desktop ? ". Its desktop is set to draw on the GPU" : ""}. If the install fails, it goes on running with no GPU, as it was.`;
}

function installedWords(box: BoxRecord, installed: UserspaceInstalled, desktop: boolean, audience: "person" | "agent"): string {
  const over = installed.from === "none" ? "where it had none" : `over ${installed.from}`;
  if (installed.problem) {
    const fix = audience === "agent" ? "Ask the user to update it again." : `Update it again: bb box gpu update ${box.name}${box.threadId === OPERATOR ? " --machine" : ` --thread ${box.threadId}`}`;
    return `${PRODUCT} installed NVIDIA's userspace ${installed.driver} in it, ${over}, before the restart, but its check after the restart failed: ${installed.problem.replace(/\.$/, "")}. ${fix}`;
  }
  const fact = box.guest?.facts?.find((candidate) => candidate.label === "GPU")?.value ?? "its card";
  return `${PRODUCT} installed NVIDIA's userspace ${installed.driver} in it, ${over}, before the restart. nvidia-smi in it lists ${fact}, and CUDA's driver initialises.${desktop ? " Its desktop is drawn by the GPU, and its video encoded with NVENC." : ""}`;
}

function becomesWords(becomes: KindChange, gpu: GpuPart, done: boolean): string {
  const card = gpu === "whole" ? "a whole card" : "a shared GPU";
  return done
    ? `It is now a GPU desktop: a ${becomes.to} box with ${card}, no longer ${becomes.from}.`
    : `It becomes a GPU desktop: a ${becomes.to} box with ${card}, no longer ${becomes.from}.`;
}

/**
 * What a kind's boxes can resize, for box_list and bb box kinds (061): one
 * sentence when every offer agrees, otherwise each offer that resizes, and
 * once that the others cannot; empty when none can.
 */
export function kindResizeText(kind: KindView): string {
  const able = kind.offers.filter((offer) => offer.resizing && resizingWords(offer.resizing) !== "Resize: no.");
  if (!able.length) return "";
  const words = (offer: OfferView) => resizingWords(offer.resizing!).replace(/^Resize: /, "").replace(/\.$/, "");
  const same = new Set(able.map(words));
  if (able.length === kind.offers.length && same.size === 1) return `Resize: ${words(able[0]!)}.`;
  const others = able.length < kind.offers.length ? `; ${kind.offers.length - able.length === 1 ? "the other provider cannot" : "the other providers cannot"}` : "";
  return `Resize: ${able.map((offer) => `on ${offer.name}, ${words(offer)}`).join("; ")}${others}.`;
}

export function kindSnapshotText(kind: KindView): string {
  const able = kind.offers.filter((offer) => offer.snapshotting);
  if (!able.length) return "";
  const words = (offer: OfferView) => offerSnapshotWords(offer.snapshotting!);
  const same = new Set(able.map(words));
  if (able.length === kind.offers.length && same.size === 1) return `Snapshots: ${words(able[0]!)}.`;
  const others = able.length < kind.offers.length ? `; ${kind.offers.length - able.length === 1 ? "the other provider takes none" : "the other providers take none"}` : "";
  return `Snapshots: ${able.map((offer) => `on ${offer.name}, ${words(offer)}`).join("; ")}${others}.`;
}

export interface JoinAgainWords {
  readonly text: string;
  readonly failed: boolean;
}

export function joinAgainWords(answer: { readonly is: "joined" | "joining" | "trying"; readonly box: BoxRecord }, followWith: string): JoinAgainWords {
  const { box } = answer;
  const untouched = `${PRODUCT} ran BB's installer in it as its user, and did not restart, stop or resize it.`;
  if (answer.is === "joined") return { text: `Box ${box.name} is a BB machine already, as machine ${box.enrol.hostId}. Nothing changed.`, failed: false };
  if (answer.is === "joining") return { text: `Box ${box.name} is joining BB now, so nothing else was started. Follow it with ${followWith}.`, failed: false };
  if (box.enrol.state === "enrolled") return { text: `Box ${box.name} joined BB as machine ${box.enrol.hostId}. ${untouched}`, failed: false };
  if (box.enrol.state === "failed") return { text: `Box ${box.name} did not join BB: ${box.enrol.error ?? "BB gave no reason."}`, failed: true };
  if (box.joinTries?.next && box.joinTries.failed > 0 && box.joinTries.next > Date.now()) {
    return { text: `Box ${box.name} did not join BB at this try. It is ${joiningWords(box.joinTries, Date.now()).replace(/\.?$/, ".")}`, failed: true };
  }
  return { text: `Box ${box.name} is still joining BB. Follow it with ${followWith}.`, failed: false };
}
