// Each thread's boxes: the registry in plugin storage and every step of a
// box's life. The registry never names a provider or a transport; it works
// through the Backend interface and the box's command transport.
//
// `acquire` records the box and returns at once; the backend acquires it in
// the background and the box is ready when its command transport answers. A
// box lives until someone releases it or its thread is archived or deleted:
// nothing expires. The sweep is the safety net for missed thread events and
// finishes work that a restart interrupted.
//
// A kind can keep spare boxes (032): boxes of the thread SPARES, made at the
// kind's default size and enrolled ahead like any other. An acquire of the
// kind at that size claims one, which moves its record to the thread, and
// core makes another in the background.
//
// Storage keys: box/<threadId>/<boxId> holds a BoxRecord, and index/<boxId>
// holds the thread ID, so a box can be found by its ID alone.

import { foldName, providerKeys, providerName } from "./provider-name.ts";
import { waitingToJoin, type JoinTries } from "./join-tries.ts";
import { createHash, randomBytes } from "node:crypto";
import type { OfferedKind, WithheldOffer } from "../backends/index.ts";
import { KIND_INFO, VM_FEATURES, currentKindId, featureWord, isEarlierKindId, kindRequest, vmOffersLast } from "../backends/kinds.ts";
import { DEVICE_PLATFORMS, TEST_DEVICE_NAME, deviceModels, isTestOffer, listWords, offeredModels, offersModel, type BoxDevice, type DevicePlatform, type ModelName } from "./device.ts";
import { encoderKey, encoderKeyParts, type EncoderPlace } from "./encoder-ledger.ts";
import { chooseModel, parseBoxDevice, parseDeviceOffer } from "./device-parse.ts";
import {
  BackendError,
  agentMessageOf,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxGrants,
  type BoxIdentity,
  type BoxKind,
  type BoxSize,
  type GpuPart,
  type GpuResize,
  type MachineSize,
  type BoxTransports,
  type Capacity,
  type CardClaim,
  type DoctorCheck,
  type GpuHandoff,
  type GrantAnswer,
  type GrantRequest,
  type Guest,
  type HeldGuest,
  type KindCapabilities,
  type LeasedAddressNow,
  type MachineNature,
  type NvidiaHost,
  type PowerState,
  type ReleaseHooks,
  type ResizePlan,
  type Resizing,
  type SizePart,
  type Started,
  type StopReason,
  GpuPlanChanged,
  ResizeHolds,
  ResizeLeftStopped,
  desktopDisplays,
  startedGpu,
  startedGuest,
} from "../backends/types.ts";
import { TransportError, type ByteChannel, type CommandTransport, type RunResult } from "../transports/types.ts";
import type { GeneralConfig } from "./config.ts";
import type { CheckId } from "./checks.ts";
import type { ImageConfig } from "./document.ts";
import { quote } from "../transports/process.ts";
import { command, envFile, envScript, jobScript, timedOutExits, type Access, type Session } from "./in-box.ts";
import { generateName, isFriendlyName, isMachineName } from "./names.ts";
import { FORK_SAFE_PROBE_MS, MARKER_WRITE_MS, forkVerdict, identityStatusScript, parseIdentityStatus, readForkSafe, readForkSeen, readsForkSafetyAtStop, writeIdentityMarker, type ForkSafety, type HeldIdentity, type StoppedForkSafety } from "./identity.ts";
import { forksOn } from "./snapshot.ts";
import {
  bestAnswer,
  grantRefusal,
  inSlot,
  isSlotKind,
  lostWords,
  placedOnSharedHost,
  noDesktopRefusal,
  resizeRefusal,
  restartRefusal,
  sharedHostsOn,
  sharedMacosHint,
  sharedRefusal,
  SHARED_HOSTS_OFF,
  SHARED_IOS_BY_DEFAULT,
  SIZE_NEEDS_DEDICATED,
  sizeRefusal,
  slotCapabilities,
  stopRefusal,
  takenOnSharedHost,
  TAKE_TRIES,
  waitWords,
  type LenderAnswer,
  type SharedHosts,
  type SlotKind,
} from "./device-host.ts";
import { chooseResize, chooseSize, defaultSize, describeSize, formatMiB, kindSizes, sameMachineSize, sameSize, type SizeRequest } from "./sizes.ts";
import { BY_OUTSIDE, EVENT_WORDS_BYTES, UNKNOWN_ACTOR, byBbBox, openStop, utf8Prefix, type Actor, type BoxEvent, type BoxEventKind, type BoxLog, type Observation } from "./box-log.ts";
import { POWER_CHECK_GAP_MS } from "./reach.ts";
import { forkCapacityWords } from "./snapshot-refusals.ts";
import { WHOLE_CARDS_OFF, WHOLE_CARDS_OFF_FOR_FORK, WHOLE_CARDS_OFF_FOR_RESIZE, chooseGpu, claimOf, gpuForSpare, gpuBeforeGpuParts, gpuOnOffer, gpuPartWords, gpuResizingWords, hasGpuPart, holdsCard, kindWithGpu, machineSizeOf, offersGpuPart, recordedGpu, withGpu, withRecordedGpu, type NvidiaUserspace, type RecordedSize } from "./gpu.ts";
import {
  DESKTOP_GPU_CHECK,
  USERSPACE_READ,
  fetchCommand,
  fromOf,
  halfInstalled,
  installCommand,
  judgeAnyCard,
  judgeDesktopCheck,
  judgeReading,
  judgeUpdateCheck,
  lastLines,
  matchesDriver,
  planWords,
  readingWords,
  restartedSinceUpdate,
  settledUpdate,
  stillRunningWords,
  UPDATE_CHECK,
  cannotInstallWords,
  startFirstWords,
  gpuPartToRetry,
  unfinishedUpdate,
  updateScriptText,
  updateLeftWords,
  userspaceOfReading,
  updateRunning,
  userspaceState,
  type GpuProcess,
  type UserspaceReading,
  type UserspaceState,
  type UserspaceUpdate,
  type UserspaceUpdateStep,
} from "./gpu-userspace.ts";
import { CARD_CHECK_COMMAND, judgeCardCheck } from "../backends/card-check.ts";

export type BoxState =
  /** Recorded; the backend is making or claiming the guest. */
  | "acquiring"
  /** The guest exists and is booting. */
  | "starting"
  /** The command transport answers. */
  | "ready"
  | "stopping"
  | "stopped"
  /** The acquire failed. The backend released what it had claimed. */
  | "failed"
  /** The guest was deleted outside bb-box. */
  | "gone"
  | "releasing";

/** "box" is acquired by a tool or the panel; "machine" is a thread's own BB machine. */
export type BoxRole = "box" | "machine";
export type EnrolState = "off" | "enrolling" | "enrolled" | "failed";

export interface IdentityResetFound {
  readonly at: number;
  readonly why: string;
  readonly machine: string;
  readonly foundAt: number;
  readonly retiredAt: number | null;
  readonly machineAgain: string | null;
  readonly enrolledAgainAt: number | null;
}

export interface ForkOrigin {
  readonly operation: string;
  readonly snapshot: { readonly id: string; readonly name: string; readonly takenAt: number; readonly ref: string; readonly livesOn: Guest; readonly identity: HeldIdentity | null; readonly from?: "snapshot" | "held-copy" };
  readonly source: { readonly id: string; readonly name: string; readonly threadId: string; readonly macs: readonly string[]; readonly address?: string | null };
}

export interface MachineToCheck {
  readonly machine: string;
  readonly at: number;
  readonly why: string;
}

/** A box's project's image (049): its name, and its script's run at start, or the baked build it started from. */
export interface BoxImage {
  readonly name: string;
  readonly state: "pending" | "running" | "done" | "failed" | "baked";
  /** How long its script and check took, once done. */
  readonly seconds?: number;
  /** For a baked image: the build's ID, and its reference, which the box starts from. */
  readonly build?: string | null;
  readonly from?: string;
}

/** Reads /etc/environment, where an image's script sets the box's PATH and variables, as a new session would (049). */
export const LOAD_ENVIRONMENT = "set -a; [ ! -r /etc/environment ] || . /etc/environment; set +a;";

/** A spare of an image's build that failed is not made again from that build for this long (#440). */
const SPARE_RETRY_MS = 24 * 60 * 60_000;
const SPARE_SETTLE_RETRY_MS = 30 * 60_000;
const spareFailedKey = (name: string, backend: string, kind: string) => `spares/image-failed/${name}/${backend}/${kind}`;

/** How long an image's script may run at start (049), and its check. */
const IMAGE_SCRIPT_MS = 30 * 60_000;
const IMAGE_CHECK_MS = 10 * 60_000;
/** Lines of a failed script's output an acquire's error gives (049). */
const IMAGE_LINES = 20;
/** Where an image's files go in the box while they run. */
const IMAGE_DIR = ".bb-box-image";

export interface BoxRecord {
  readonly id: string;
  readonly threadId: string;
  readonly projectId: string | null;
  /** Friendly name, unique within the thread. */
  readonly name: string;
  readonly kind: string;
  readonly kindLabel: string;
  /** The features every offer of the kind has, and those an alias asked for (041). */
  readonly requires: readonly string[];
  /** The offer's capabilities when the box was acquired. Its features may add to `requires`. */
  readonly capabilities: KindCapabilities;
  readonly backend: string;
  readonly backendLabel: string;
  readonly nature: MachineNature;
  readonly role: BoxRole;
  /**
   * The size asked for (028). Absent for a box recorded before sizes, which
   * was made at what is now the default preset, and for a restored box,
   * whose guest says its size.
   */
  readonly size?: RecordedSize;
  readonly nvidiaUserspace?: NvidiaUserspace | null;
  readonly userspaceRead?: UserspaceReading | null;
  readonly userspaceUpdate?: UserspaceUpdate | null;
  readonly userspaceRunningSeenAt?: number | null;
  /** Set by the backend's claim, before it makes or changes anything. */
  readonly guest: Guest | null;
  readonly state: BoxState;
  /** Why the box failed, or what went wrong with its last change. */
  readonly error: string | null;
  readonly agentError?: { readonly of: string; readonly words: string } | null;
  readonly createdAt: number;
  readonly readyAt: number | null;
  readonly releaseRequestedAt: number | null;
  /** When a real backend began resetting the machine, during release. */
  readonly resetAt: number | null;
  /**
   * When the sweep restored the box's lost record from its guest, until the
   * box starts enrolling again. A box restored stopped, or whose guest did
   * not answer, enrols when bb-box starts it or the sweep finds it answering (026).
   */
  readonly restoredAt?: number | null;
  /** Milliseconds per acquire step, "total" from request to ready, and "release.<step>" after a failed release. */
  readonly timings: Readonly<Record<string, number>>;
  readonly waitingOn?: string | null;
  readonly enrol: { readonly state: EnrolState; readonly hostId: string | null; readonly error: string | null };
  readonly joinTries?: JoinTries | null;
  readonly identityReset?: IdentityResetFound | null;
  readonly removedMachineToCheck?: MachineToCheck | null;
  readonly identityMarkedAt?: number | null;
  /** Its project's image (049), whose script runs as root as the box starts, before it is handed over. */
  readonly image?: BoxImage | null;
  /** The last time the box's guest stopped without bb-box's request (#406). A stop bb-box makes forgets it. */
  readonly unrequestedStop?: UnrequestedStop | null;
  /** The box's last resize (061), recorded before it changes anything. */
  readonly resize?: ResizeRecord | null;
  readonly restoring?: RestoringMark | null;
  readonly fork?: ForkOrigin | null;
  readonly forkFailure?: string | null;
  readonly agentForkFailure?: string | null;
  readonly endToldAt?: number | null;
  readonly device?: BoxDevice | null;
  readonly askedDevice?: ModelName;
  readonly slim?: boolean;
  readonly stoppedAt?: number | null;
  readonly stopForkSafety?: StoppedForkSafety | null;
}

export type { RecordedSize };

export type SpareSettling = { readonly is: "settled" } | { readonly is: "settling" } | { readonly is: "failed"; readonly words: string };

export interface RestoringMark {
  readonly operation: string;
  readonly snapshot: string;
  readonly name: string;
  readonly at: number;
  readonly ran: boolean;
}

/** A resize of a box (061): what it asked for, and how it went. */
export interface ResizeRecord {
  readonly from: RecordedSize;
  readonly to: RecordedSize;
  /** When it began, in ms since the epoch. */
  readonly at: number;
  readonly state: "resizing" | "done" | "failed";
  /** How long it took, once it has ended. */
  readonly ms: number | null;
  /** It restarted the box. */
  readonly restart: boolean;
  readonly error: string | null;
}

export interface UserspaceUpdateOptions {
  readonly check?: boolean;
  readonly who?: Actor;
  readonly checkRestart?: (box: BoxRecord) => Promise<void>;
  readonly signal?: AbortSignal;
}

export interface UserspaceUpdateAnswer {
  readonly box: BoxRecord;
  readonly needed: boolean;
  readonly changed: boolean;
  readonly from: UserspaceReading;
  readonly to: string;
  readonly processes: readonly GpuProcess[];
  readonly words: string;
}

const USERSPACE_READ_MS = 15_000;
const UPDATE_CHECK_MS = 60_000;
const FETCH_MS = 31 * 60_000;
const INSTALL_MS = 10 * 60_000;
const CARD_CHECK_MS = 30_000;
const DESKTOP_CHECK_MS = 90_000;

function isRunResult(value: unknown): value is RunResult {
  return typeof value === "object" && value !== null && "exitCode" in value && "stdout" in value;
}

function updateCommandFor(box: BoxRecord): string {
  const owner = box.threadId === OPERATOR ? " --machine" : ` --thread ${box.threadId}`;
  if (!holdsCard(recordedGpu(box))) return `bb box resize ${box.name} --gpu ${gpuPartToRetry(box.resize)} --restart${owner}`;
  return `bb box gpu update ${box.name}${owner}`;
}

function userspaceCheck(box: BoxRecord, state: UserspaceState, unread: string | null, hostUnknown: string | null, notReadNow: string | null): DoctorCheck {
  const id: CheckId = `gpu-userspace.${box.name}`;
  const name = `NVIDIA userspace in ${box.name}`;
  const update = updateCommandFor(box);
  const stopped = box.state === "stopped";
  const fixWhenRunning = (fix: string) => (stopped ? `Start ${box.name}, then ${fix}` : `${fix.charAt(0).toUpperCase()}${fix.slice(1)}`);
  const read = box.userspaceRead;
  const asRead = stopped && read ? ` It is stopped: this is as bb-box read it at ${new Date(read.at).toISOString().slice(0, 16).replace("T", " ")} UTC.` : "";
  if (unread) return { id, name, status: "warn", detail: `${unread.replace(/\.$/, "")}.`, fix: "Run bb box doctor again; if it lasts, look at the box with bb box status." };
  switch (state.is) {
    case "updating":
      return { id, name, status: "ok", detail: `bb-box is updating NVIDIA's userspace in ${box.name} to ${state.update.to} now, at its ${state.update.step} step.`, fix: null };
    case "running":
      return { id, name, status: "warn", detail: `${stillRunningWords(box.name)}.`, fix: "Wait for it to end, then run bb box doctor again." };
    case "unfinished":
      return holdsCard(recordedGpu(box))
        ? { id, name, status: "warn", detail: `${updateLeftWords(box.name, state.update)} nvidia-smi and CUDA may fail in it.`, fix: fixWhenRunning(`update it again: ${update}`) }
        : { id, name, status: "warn", detail: `${updateLeftWords(box.name, state.update)} Its GPU was not added.`, fix: fixWhenRunning(`resize it again: ${update}`) };
    case "half":
      return { id, name, status: "warn", detail: `Box ${box.name} has ${readingWords(state.reading)}, so nvidia-smi and CUDA may fail in it.${asRead}`, fix: fixWhenRunning(`${holdsCard(recordedGpu(box)) ? "update" : "resize"} it again: ${update}`) };
    case "differs":
      return {
        id,
        name,
        status: "warn",
        detail: `Box ${box.name} has ${state.version === "none" ? "no NVIDIA userspace" : `NVIDIA's userspace ${state.version}`}, and the host's driver is ${state.driver}: nvidia-smi and CUDA fail in it until its userspace is updated.${asRead}`,
        fix: fixWhenRunning(`update it: ${update}`),
      };
    case "not-checked":
      return stopped
        ? { id, name, status: "ok", detail: `Box ${box.name} is stopped, and bb-box has not read its NVIDIA userspace yet: it does when ${box.name} next starts.`, fix: null }
        : { id, name, status: "ok", detail: `bb-box has not read NVIDIA's userspace in box ${box.name} yet, and did not now, as ${notReadNow ?? `the box is ${box.state}`}: the doctor reads it at its next run.`, fix: null };
    case "driver-unknown":
      return { id, name, status: "warn", detail: `Box ${box.name} has ${state.version === "none" ? "no NVIDIA userspace" : `NVIDIA's userspace ${state.version}`}, and bb-box cannot tell the host's driver: ${hostUnknown ?? "its backend does not say"}`, fix: "Run bb box doctor again once the host's driver is known." };
    case "matches":
      return { id, name, status: "ok", detail: `Box ${box.name} has NVIDIA's userspace ${state.version}, the host's driver.`, fix: null };
  }
}

/** What a resize did, or with `check`, would do (061). */
export interface ResizeAnswer {
  readonly box: BoxRecord;
  readonly from: BoxSize;
  readonly to: BoxSize;
  /** Null when the box has that size already. */
  readonly plan: ResizePlan | null;
  /** It changed the box, as opposed to checking, or finding it had the size. */
  readonly changed: boolean;
  readonly becomes?: KindChange | null;
  readonly installed?: UserspaceInstalled | null;
}

export interface KindChange {
  readonly from: string;
  readonly to: string;
}

export interface UserspaceInstalled {
  readonly driver: string;
  readonly from: string;
  readonly problem: string | null;
}

interface UserspaceSteps {
  readonly from: string;
  readonly signal: AbortSignal;
  stepTo(step: UserspaceUpdateStep): Promise<void>;
  ended(step: UserspaceUpdateStep, why: string, read: boolean): Promise<UserspaceReading | null>;
  done(): Promise<number>;
  close(): void;
}

/**
 * The memory a Linux box uses that it cannot give back at once, in MiB: its
 * cgroup's use less the file cache it can drop, as a container's cgroup
 * shows it, or else MemTotal less MemAvailable, as in a VM. BBBOX_CGROUP,
 * which no box sets, lets a test give it a cgroup of its own.
 */
const MEMORY_IN_USE = String.raw`f=${"$"}{BBBOX_CGROUP:-/sys/fs/cgroup}
if [ -r $f/memory.current ] && [ -r $f/memory.stat ]; then
  c=$(cat $f/memory.current); i=$(awk '$1 == "inactive_file" { print $2 }' $f/memory.stat)
  echo $(( (c - ${"$"}{i:-0}) / 1048576 ))
else
  awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { print int((t - a) / 1024) }' /proc/meminfo
fi`;

function gpuFixedWords(box: BoxRecord): [string, string] {
  const said = `${box.backendLabel} cannot change the GPU of its ${box.kind} boxes, so box ${box.name} keeps its GPU`;
  return [`${said}. Make a new box with the GPU it needs.`, `Not resized: ${said}. Acquire a new box with the GPU it needs, or ask the user. bb-box changed nothing.`];
}

function noGpuDesktopWords(box: BoxRecord, kind: string): [string, string] {
  const said = `${box.backendLabel} offers no ${kind} box with a GPU, so box ${box.name}, a desktop drawn by the CPU, cannot become a GPU desktop there`;
  return [`Not resized: ${said}. List a GPU desktop template in BB Box's settings, or make a new ${kind} box with a GPU. bb-box changed nothing.`, `Not resized: ${said}. Acquire a ${kind} box with the GPU it needs, or ask the user. bb-box changed nothing.`];
}

function sizeAndGpuWords(size: BoxSize, withGpuPart: boolean): string {
  return withGpuPart ? `${describeSize(size)}, GPU ${size.gpu}` : describeSize(size);
}

/** "cores", "cores and memory", "cores, memory and disk". */
export function partWords(parts: readonly SizePart[]): string {
  const words = parts.map((part) => part);
  return words.length < 2 ? (words[0] ?? "") : `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** What an offer can resize, in words (061): "Resize: cores, memory and disk live." */
export function resizingWords(resizing: Resizing | null): string {
  if (!resizing) return "Resize: no.";
  const all: SizePart[] = ["cores", "memory", "disk"];
  const way = (part: SizePart) => resizing[part];
  const live = all.filter((part) => way(part) === "live");
  const restart = all.filter((part) => way(part) === "restart");
  if (!live.length && !restart.length) return "Resize: no.";
  const said = [live.length ? `${partWords(live)} live` : "", restart.length ? `${partWords(restart)} with a restart` : ""].filter(Boolean).join("; ");
  return `Resize: ${said}${resizing.disk !== "no" ? ", the disk only growing" : ""}.${gpuResizingWords(resizing.gpu)}`;
}

/**
 * About how long a restart of `box` takes, in whole seconds, from what its
 * own restarts took (061): its last restart resize, with a fifth more, or
 * else its last start, twice over for the shutdown before it, when that
 * start was a boot. A start of a backend whose stop keeps the session
 * (`resumes`) was a resume, unless its timings name a boot, and says
 * nothing of a boot. Null when the box has no such figure.
 */
export function restartSeconds(box: BoxRecord, resumes: boolean): number | null {
  const last = box.resize;
  if (last?.restart && last.state === "done" && last.ms) return Math.max(1, Math.ceil((last.ms * 1.2) / 1000));
  const start = box.timings["start.total"];
  const booted = box.timings["start.boot"] !== undefined || (!resumes && box.timings["start.resume"] === undefined);
  if (start && booted) return Math.max(1, Math.ceil((start * 2) / 1000));
  return null;
}

/** What a live memory shrink must leave free above the memory in use: the larger of this and a tenth of the new size. */
export const RESIZE_MEMORY_MARGIN_MIB = 512;

export function restoringWords(box: Pick<BoxRecord, "name">, mark: RestoringMark): string {
  return `Box ${box.name} is being restored to snapshot "${mark.name}", or bb-box could not confirm that restore. Check its status in a few seconds; if it stays so, bb box doctor says why, and bb box sweep checks again now.`;
}

/** A stop bb-box did not make, why, and what bb-box did about it (#406). */
export interface UnrequestedStop {
  /** When the guest stopped, or when bb-box found it stopped. */
  readonly at: number;
  /** The backend's words, or null when it cannot tell. */
  readonly reason: string | null;
  /** The guest did not choose it, as when its VM crashed. */
  readonly crashed: boolean;
  /** When bb-box started the box again, and the error when that failed. */
  readonly restart: { readonly at: number; readonly error: string | null } | null;
}

/**
 * bb-box starts a box whose VM crashed again (#406), unless it did so for
 * the stop before less than this long before, so a VM that keeps crashing
 * stays stopped.
 */
export const RESTART_GAP_MS = 10 * 60_000;

function threadMachineWords(box: BoxRecord): string {
  return `It is the machine of thread ${box.threadId}, and bb-box removes no thread's machine, which would release the box with the thread's worktree, so it keeps the box as it is, no longer a BB machine that connects.`;
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** Why the box last stopped without bb-box's request, and what bb-box did, in words (#406); empty when it has not. */
export function stopWords(box: BoxRecord): string {
  const stop = box.unrequestedStop;
  if (!stop) return "";
  const words = [`It stopped without a request from bb-box at ${utc(stop.at)}.`, stop.reason ? sentence(stop.reason) : "Its backend does not record why."];
  if (stop.restart?.error) words.push(`bb-box could not start it again: ${sentence(stop.restart.error)}`);
  else if (stop.restart) words.push(box.state === "ready" ? `bb-box started it again at ${utc(stop.restart.at)}.` : "bb-box is starting it again.");
  else if (stop.crashed) words.push(`bb-box left it stopped, as it had started it again after a stop less than ${RESTART_GAP_MS / 60_000} minutes before.`);
  return words.join(" ");
}

/** Whether bb-box is starting the box again after a stop it did not make (#406). */
function restarting(box: BoxRecord): boolean {
  return !!box.unrequestedStop?.restart && !box.unrequestedStop.restart.error;
}

/**
 * What BB says of a thread: "ended" when it returns the thread archived or
 * deleted, "missing" when it says there is no such thread, and "unknown" on
 * any other error.
 */
export type ThreadLiveness = "live" | "ended" | "missing" | "unknown";

/** BB's answer for a thread, with what it said as it came, for the log. */
export interface ThreadAnswer {
  readonly state: ThreadLiveness;
  readonly said: string;
}

/** The thread of spare boxes, which no thread owns yet (032). BB's thread IDs never take this form. */
export const SPARES = "spare";

/** The thread of your machines: boxes you own, kept as BB machines (036). BB's thread IDs never take this form either. */
export const OPERATOR = "operator";

/** Whether boxes of `threadId` belong to a thread, as opposed to the spares or your machines. */
export function ownedByThread(threadId: string): boolean {
  return threadId !== SPARES && threadId !== OPERATOR;
}

/** A name for one of your machines: a hostname label, as it is also its BB machine's name (036). */

export { isMachineName };

export function forkNameProblem(name: string): string | null {
  return isMachineName(name) ? null : `Name a fork with a lower-case letter first, then letters, digits and "-", up to 32, not ending in "-". "${name}" is not one.`;
}

/**
 * The name of a box's BB machine. A spare's says it is one, and one that
 * waits stopped says so too, as BB shows its machine offline meanwhile (#539).
 */
export function machineName(box: Pick<BoxRecord, "name" | "threadId" | "state">): string {
  if (box.threadId !== SPARES) return box.name;
  return box.state === "stopped" ? `${box.name} (spare, stopped)` : `${box.name} (spare)`;
}

export interface BoxesDeps {
  readonly kv: BackendStorage;
  readonly backends: {
    get(id: string): Backend | null;
    active(): Backend[];
    kinds(): OfferedKind[];
    withheld?(kind: string, signal?: AbortSignal): Promise<readonly WithheldOffer[]>;
    offered?(backend: Backend): readonly BoxKind[];
    /** The driver's label for a backend ID, as settings names it ("Proxmox LXC"), for a provider's name (044). */
    driverLabel?(id: string): string;
    /** The built backends that are on, so an `on` naming one that is off is told so (044). */
    on?(): Backend[];
  };
  general(): Promise<GeneralConfig>;
  /** The image a project's boxes of a kind get (049), or image `name` when it covers the kind, from the configuration, or null. */
  image?(projectId: string | null, kind: string, name?: string): { readonly name: string; readonly image: ImageConfig } | null;
  /** A current baked build of an image for a kind on a backend whose images start boxes from builds (049), or null. */
  baked?(name: string, backend: string, kind: string): Promise<{ readonly ref: string; readonly build: string | null } | null>;
  /**
   * Commands an image's script may call, as this bb-box has them, put first
   * on its PATH at start: bb-box-feature, for boxes of images built before
   * standard images had it (049).
   */
  readonly imageTools?: Readonly<Record<string, string>>;
  /**
   * The spares of projects' images wanted now (#440): one per image, backend
   * and kind, from the build in `ref`, which is current there.
   */
  imageSpares?(): Promise<readonly { readonly name: string; readonly backend: string; readonly kind: string; readonly ref: string }[]>;
  /** Says a box of an image is ready, whether its script ran at start or it started baked, for baking when used (049). */
  imageReady?(box: BoxRecord): void;
  /** Tells panels and tools that a thread's boxes changed. */
  notify(threadId: string): void;
  /** A box's record was written, or deleted when `deleted` is true. */
  recorded?(box: BoxRecord, deleted: boolean): void;
  ended?(box: BoxRecord, how: "released" | "forgotten"): void;
  forked?(box: BoxRecord): void;
  forkHold?(box: BoxRecord, signal: AbortSignal): Promise<void>;
  keepsGuest?(backendId: string, guestRef: string, ended?: boolean): string | null;
  holdKeptOn?(backendId: string, guestRef: string, boxId: string | null): Promise<string | null>;
  leftoverReleased?(backendId: string, guestRef: string, boxId: string | null, why: string): void;
  beforeRelease?(box: BoxRecord, who: Actor): Promise<void>;
  /**
   * Whether a thread still exists and is not archived, as BB says. The sweep
   * releases the thread's boxes and guests once BB says at two sweeps running
   * that it ended or that there is no such thread.
   */
  thread(threadId: string): Promise<ThreadAnswer>;
  /** A thread's project, for a box the sweep restores from its guest. */
  projectOf?(threadId: string): Promise<string | null>;
  /**
   * The ID of BB's machine that a box is for its thread, as a "New box"
   * (033), or null when it is none. The sweep asks it for a box it restores.
   */
  machineOf?(boxId: string): Promise<string | null>;
  /**
   * Enrols a ready box as a BB machine, with the box ID as the key. With
   * `restored`, the sweep restored the box and bb-box has just found it
   * answering, so its enrolment counts from now. Called without awaiting.
   */
  enrol?(box: BoxRecord, options?: { restored?: boolean }): Promise<void>;
  /** Removes a box's BB machine. Awaited before the backend releases the box. */
  unenrol?(box: BoxRecord): Promise<void>;
  /**
   * Starts an enrolled box's BB daemon again after bb-box started the box:
   * BB's bootstrap with the box ID as the key. Commands wait for it a while.
   */
  reconnect?(box: BoxRecord): Promise<void>;
  tryingToJoin?(boxId: string): boolean;
  /**
   * A thread, neither archived nor deleted, on a spare's BB machine, or
   * null. A claim skips such a spare, and the spare upkeep makes it yours
   * (036): someone started a thread on it from BB's picker.
   */
  spareThread?(box: BoxRecord): Promise<string | null>;
  /**
   * Gives a claimed spare's BB machine the box's name, and says whether BB
   * shows it disconnected, so it must reconnect. Commands wait a while only
   * for that reconnect, as after a start.
   */
  claimed?(box: BoxRecord): Promise<boolean>;
  /** Names the box's BB machine as `machineName` says, as after a spare stops to wait (#539). */
  renameMachine?(box: BoxRecord): Promise<void>;
  spareSettled?(box: BoxRecord): Promise<SpareSettling>;
  spareClaimed?(box: BoxRecord): void;
  /**
   * Which of BB's variables commands in a box enrolled as a BB machine take
   * from its daemon, so they have the thread's access. Null for none.
   */
  access?(box: BoxRecord): Promise<Access | null>;
  /**
   * Why a box that does not answer is to be waited for, not released: bb-box
   * is reconnecting to the machine it runs on, as after an update (#415).
   * Null when it is not.
   */
  reconnecting?(box: BoxRecord): string | null;
  tell?(threadId: string, text: string): Promise<void>;
  logError(operation: string, error: unknown): void;
  /** Records what the sweep did to a guest, and what became of spares, and why. */
  log?(message: string): void;
  /** How long a command waits for its box to finish enrolling, or reconnecting after a start. */
  readonly enrolWaitMs?: number;
  readonly forkWaitMs?: number;
  readonly sharedIosByDefault?: boolean;
  readonly events?: BoxLog;
  readonly reach?: BoxReach;
  now?(): number;
  random?(bytes: number): Uint8Array;
}

export interface BoxReach {
  failed(box: BoxRecord, error: string): void;
  answered(box: BoxRecord): void;
  notAnswering(boxId: string): boolean;
  forget(boxId: string): void;
  settled?(box: BoxRecord): void;
}

function withoutStartSteps(timings: Readonly<Record<string, number>>): Record<string, number> {
  return Object.fromEntries(Object.entries(timings).filter(([step]) => !step.startsWith("start.")));
}

export interface BackendSilence {
  readonly since: number;
  readonly error: string;
}

function changedParts(from: MachineSize, to: MachineSize | null): SizePart[] {
  if (!to) return [];
  const parts: SizePart[] = [];
  if (from.cores !== to.cores) parts.push("cores");
  if (from.memoryMiB !== to.memoryMiB) parts.push("memory");
  if (from.diskGiB !== null && to.diskGiB !== null && from.diskGiB !== to.diskGiB) parts.push("disk");
  return parts;
}

export function forgetRefusal(box: Pick<BoxRecord, "name" | "backendLabel">): BoxError {
  return new BoxError("unsupported", `Box ${box.name}'s backend, ${box.backendLabel}, is in bb-box's settings, so release the box instead: forgetting it would leave its guest running with nothing to release it.`);
}

function observedState(power: PowerState | null | undefined): Observation["state"] {
  if (power === undefined || power === "unknown") return "unknown";
  if (power === null) return "gone";
  return power;
}

export type BoxErrorCode =
  | "not_found"
  | "unknown_provider"
  | "unknown_kind"
  | "invalid_size"
  | "limit_reached"
  | "no_capacity"
  | "not_ready"
  | "unsupported"
  | "backend_off"
  | "released"
  | "unreachable"
  /** A thread runs on the box's BB machine. */
  | "in_use"
  /** A resize needs a restart of the box, which the caller did not allow (061). */
  | "needs_restart"
  /** A live shrink of a box's memory would leave less than a margin above what the box uses (061). */
  | "memory_in_use"
  /** A name for one of your machines that is not a hostname label, or is taken. */
  | "invalid_name"
  | "unknown_device"
  /** The box this thread runs on belongs to another owner, who releases or stops it (036). */
  | "not_owner"
  /** bb-box is stopping, as for an update, and takes no new commands (#405). */
  | "restarting"
  /** The box does not answer while bb-box reconnects to the machine it runs on, as after an update (#415). */
  | "reconnecting"
  | "locked"
  | "failed"
  | "reused_request"
  | "try_again"
  | "unflushed"
  | "invalid_value"
  | "needs_yes";

/** A job a box_run command left running when bb-box restarted (#405). */
export type JobResult =
  | { readonly state: "ended"; readonly exitCode: number; readonly stdout: string; readonly stderr: string; readonly truncated: boolean }
  | { readonly state: "running"; readonly stdout: string; readonly stderr: string };

export class BoxError extends Error {
  readonly code: BoxErrorCode;
  readonly agentMessage: string | null;
  constructor(code: BoxErrorCode, message: string, agentMessage: string | null = null) {
    super(message);
    this.name = "BoxError";
    this.code = code;
    this.agentMessage = agentMessage;
  }
}

export class ReleaseWaits extends BoxError {}

export const RELEASE_OR_DELETE_KEPT = "Release it again, or release it and delete what you kept.";

/** #choose finding no offer for a box, with the backends that had no room: only their spares give room (#282). */
/** What `on` named (044): the offers to try, in acquire order; why each named provider that is off was passed over; and every provider named. */
interface Named {
  readonly offers: OfferedKind[];
  readonly out: string[];
  readonly ids: ReadonlySet<string>;
}

class Unplaced extends BoxError {
  readonly full: readonly string[];
  constructor(code: BoxErrorCode, message: string, full: readonly string[]) {
    super(code, message);
    this.full = full;
  }
}

/** The storage key of the cold-start history, see `typicalReady`. */
const READY_HISTORY = "ready-history";
const ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

export function newBoxId(random: (bytes: number) => Uint8Array): string {
  return `bx${[...random(12)].map((byte) => ID_ALPHABET[byte % 32]).join("")}`;
}

/** Boxes that count against the per-thread limit and hold resources. */
export function isActive(box: BoxRecord): boolean {
  return box.state !== "failed" && box.state !== "gone" && box.state !== "releasing";
}

export const END_NOTICE_MS = 3600_000;

export function endingWords(box: Pick<BoxRecord, "name" | "kindLabel" | "backendLabel">, endsAt: number, now: number): string {
  const minutes = Math.max(1, Math.round((endsAt - now) / 60_000));
  const at = new Date(endsAt).toISOString().slice(11, 16);
  return [
    `Box ${box.name} (${box.kindLabel}) ends at ${at} UTC, in ${minutes} minutes: ${box.backendLabel} does not let a machine live longer, and bb-box cannot extend it.`,
    `Everything on it goes then. Copy out what you need before that, with box_copy, and push work in progress. If you still need a box after that, ask for a new one with box_acquire.`,
  ].join(" ");
}

/** A box as the log names it. */
function describeBox(box: Pick<BoxRecord, "name" | "threadId">): string {
  return box.threadId === SPARES ? `spare box ${box.name}` : `box ${box.name} of thread ${box.threadId}`;
}

export function isAcquiring(box: BoxRecord): boolean {
  return box.state === "acquiring" || box.state === "starting";
}

/** What a guest's power says about a box that is settled, or moving when `moving`: the change, empty for none. */
function observed(current: BoxRecord, power: PowerState | null, moving = false): Partial<BoxRecord> {
  const settled = current.state === "ready" || current.state === "stopped" || current.state === "gone";
  const started = (current.state === "stopping" || current.state === "starting") && current.readyAt !== null;
  if (!settled && !(moving && started)) return {};
  if (power === null) return { state: "gone", error: "The guest was deleted outside bb-box." };
  // The provider cannot tell, for example a machine that does not answer: keep what we know.
  if (power === "unknown") return {};
  const state = power === "running" ? "ready" : "stopped";
  return current.state === state ? {} : { state, error: null };
}

export function identity(box: BoxRecord, size: MachineSize): BoxIdentity {
  return { boxId: box.id, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt, size: withGpu(size, recordedGpu(box)), ...(box.image?.from ? { from: box.image.from } : {}) };
}

/** The message a user sees for an error: bb-box's and backends' own messages as they are. */
export function describeError(error: unknown, action: string): string {
  if (error instanceof BoxError || error instanceof BackendError || error instanceof TransportError) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return `${action} failed: ${message}`;
}

export function describeErrorForAgent(error: unknown, action: string): string {
  const words = agentMessageOf(error);
  if (words === null) return describeError(error, action);
  return error instanceof BackendError || error instanceof BoxError || error instanceof TransportError ? words : `${action} failed: ${words}`;
}

export function errorForAgent(box: Pick<BoxRecord, "error" | "agentError">): string | null {
  return box.agentError && box.agentError.of === box.error ? box.agentError.words : box.error;
}

function hoursWords(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 120) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  const hours = Math.round(minutes / 60);
  return `${hours} hours`;
}

/** `text` ending with a full stop, so another sentence can follow it. */
function sentence(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/** Waits for `promise`, which never rejects, for up to `ms`, or until `signal` aborts. */
function within(promise: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.max(0, ms));
    signal?.addEventListener("abort", done, { once: true });
    void promise.then(done);
    if (signal?.aborted) done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

/** Capabilities for a guest whose kind no backend offers any more: it can only be released. */
const UNKNOWN_KIND: KindCapabilities = {
  os: "linux",
  arch: "x86_64",
  gpu: false,
  features: [],
  command: null,
  displays: [],
  computerUse: null,
  enrol: false,
  device: null,
};

/** How much longer than the timeout in the box bb-box waits before it stops the command itself. */
const LOCAL_TIMEOUT_GRACE_MS = 10_000;
const ENROL_POLL_MS = 250;
/** Long enough for a Mac box's enrolment, which takes 8 to 10 s from ready. */
const ENROL_WAIT_MS = 20_000;

/** For releases whose progress nobody watches: leftovers the sweep finds, and guests whose box was forgotten. */
const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const FORK_WAIT_MS = 60_000;
const FORK_START_WAIT_MS = 180_000;
const FORK_LOOKS = 30;

export interface ForkRequest {
  readonly id: string;
  readonly threadId: string;
  readonly projectId: string | null;
  readonly name?: string;
  readonly backend: string;
  readonly backendLabel: string;
  readonly kind: string;
  readonly size: MachineSize;
  readonly gpu?: GpuPart;
  readonly origin: ForkOrigin;
  readonly who: Actor;
}

export type ForkAdmission = Pick<ForkRequest, "threadId" | "name" | "backend" | "backendLabel" | "kind" | "gpu"> & { readonly size: MachineSize | null; readonly who?: Actor };

function distinctAddresses(addresses: readonly (string | null)[]): string[] {
  return [...new Set(addresses.filter((address): address is string => !!address))];
}

function sentenceOf(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function forkReleasedWords(box: Pick<BoxRecord, "fork">): string {
  return `bb-box released it, so nothing of it acts as ${box.fork?.source.name ?? "its source"}.`;
}

function forkCleanupWords(ref: string, why: string, stopped: boolean): string {
  return `bb-box could not delete its guest ${ref} yet (${why.replace(/\.$/, "")})${stopped ? ", so it stopped it" : ", nor stop it"}. It tries again at each sweep, and never hands the fork over.`;
}

export function forkedFromWords(origin: ForkOrigin): string {
  return `Forked from ${origin.source.name}, "${origin.snapshot.name}" (taken ${new Date(origin.snapshot.takenAt).toISOString().slice(0, 16).replace("T", " ")} UTC).`;
}

/** The error of a box restored running whose guest did not answer. The sweep clears it once the guest answers. */
const SILENT = "Its guest was running but did not answer when bb-box restored the box's lost record. Stop and start it if commands fail.";

const SLOT_PLACE_MS = 120_000;

function lendersOf(offers: readonly OfferedKind[], kind: SlotKind): OfferedKind[] {
  const seen = new Set<string>();
  return offers.filter((offer) => {
    if (seen.has(offer.backend.id) || !offer.backend.slots?.lends(kind)) return false;
    seen.add(offer.backend.id);
    return true;
  });
}

function sizeAsked(size: SizeRequest | undefined): boolean {
  return !!size && [size.preset, size.cores, size.memoryGiB, size.diskGiB].some((part) => part !== undefined && part !== "");
}

function placed(box: BoxRecord, guest: Guest): Partial<BoxRecord> {
  if (!inSlot({ guest }) || inSlot(box)) return { guest };
  return { guest, capabilities: slotCapabilities(box.capabilities) };
}

export function withDeviceChecked(box: BoxRecord): BoxRecord {
  const storedOffer: unknown = box.capabilities.device;
  const offerReadable = storedOffer === null || (storedOffer !== undefined && parseDeviceOffer(storedOffer).ok);
  const storedDevice: unknown = box.device;
  const deviceReadable = storedDevice === undefined || storedDevice === null || parseBoxDevice(storedDevice).ok;
  const askedReadable = box.askedDevice === undefined || deviceModels().some((model) => model.name === box.askedDevice);
  const slimReadable = box.slim === undefined || typeof box.slim === "boolean";
  if (offerReadable && deviceReadable && askedReadable && slimReadable) return box;
  const { askedDevice: _, slim: __, ...rest } = box;
  return {
    ...rest,
    ...(askedReadable && box.askedDevice !== undefined ? { askedDevice: box.askedDevice } : {}),
    ...(slimReadable && box.slim !== undefined ? { slim: box.slim } : {}),
    capabilities: offerReadable ? box.capabilities : { ...box.capabilities, device: null },
    ...(deviceReadable ? {} : { device: null }),
  };
}

export interface UnofferedKind {
  readonly kind: string;
  readonly label: string;
  readonly words: string;
}

export const WITHHELD_READ_WAIT_MS = 10_000;

function withheldRefusal(kind: string, withheld: readonly WithheldOffer[], providerName: (backend: Backend) => string): BoxError {
  const reasons = withheld.map((offer) => `${providerName(offer.backend)} offers them, but not now: ${offer.why}`);
  const passing = withheld.some((offer) => offer.passing);
  return new BoxError(passing ? "no_capacity" : "unknown_kind", `No ${kind} box (${KIND_INFO[kind]?.label ?? kind}) can come now. ${reasons.join(" ")}`);
}

function kindPlatform(kind: string, offers: readonly OfferedKind[]): DevicePlatform | null {
  return KIND_INFO[kind]?.device ?? offers.find((offer) => offer.kind.capabilities.device)?.kind.capabilities.device?.platform ?? null;
}

function deviceKindIds(): string[] {
  return Object.entries(KIND_INFO)
    .filter(([, info]) => info.device !== null)
    .map(([id]) => id);
}

/** Whether a box or offer with `capabilities` has every one of `features`. */
export function hasFeatures(capabilities: Pick<KindCapabilities, "features">, features: readonly string[]): boolean {
  return features.every((feature) => capabilities.features.includes(feature));
}

/** The features a box has beyond what its kind promises. */
export function extraFeatures(box: Pick<BoxRecord, "requires" | "capabilities">): string[] {
  return box.capabilities.features.filter((feature) => !box.requires.includes(feature));
}

const recordKey = (threadId: string, boxId: string) => `box/${threadId}/${boxId}`;
const checkedGpuKey = (boxId: string) => `gpu-check/${boxId}`;
const RECOVERY_READ_MS = 15_000;
const indexKey = (boxId: string) => `index/${boxId}`;

class Queue {
  #tail: Promise<unknown> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = this.#tail.then(task, task);
    this.#tail = next.catch(() => undefined);
    return next;
  }
}

export interface SweepReport {
  /** Boxes released because their thread ended. */
  readonly released: number;
  /** Guests released that no box owns. */
  readonly leftovers: number;
  /** Records restored from guests whose record was lost. */
  readonly adopted: number;
  /** Guests with no record whose thread BB did not confirm, kept for the next sweep. */
  readonly kept: number;
  /** Boxes and guests whose thread BB said ended at this sweep but not the last, kept for the next. */
  readonly ending: number;
  /** Acquires and releases a restart interrupted, carried on. */
  readonly resumed: number;
  readonly guarded: number;
}

export class Boxes {
  readonly #deps: BoxesDeps;
  readonly #now: () => number;
  readonly #random: (bytes: number) => Uint8Array;
  /** Serialises capacity checks, so two acquires never take the same room. */
  readonly #admission = new Queue();
  readonly #threads = new Map<string, Queue>();
  /** The latest task per box: acquire, stop, start, release. Tasks for one box run in turn. */
  readonly #work = new Map<string, Promise<unknown>>();
  /** Acquires running in this process, so a release can cancel them. */
  readonly #acquiring = new Map<string, AbortController>();
  readonly #updating = new Map<string, AbortController>();
  readonly #resizing = new Map<string, AbortController>();
  /** Reconnects of BB machines after a start or a claim in this process, while they run. */
  readonly #reconnects = new Map<string, Promise<void>>();
  /** By box, the jobs whose results bb-box has, which its next command removes, and whether a command has pruned old ones since this process started (#405). */
  readonly #jobs = new Map<string, { readonly received: Set<string>; pruned: boolean }>();
  /** The run of keepSpares in progress, and whether a call asked for another after it. */
  #keeping: Promise<void> | null = null;
  #keepAgain = false;
  readonly #spareShortfalls = new Map<string, string>();
  readonly #spareSettleFailedAt = new Map<string, number>();
  /** The threads BB said had ended at the last sweep. */
  #ending = new Set<string>();
  readonly #powerCheckedAt = new Map<string, number>();
  readonly #silentBackends = new Map<string, BackendSilence>();
  #disposed = false;

  constructor(deps: BoxesDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#random = deps.random ?? ((bytes) => randomBytes(bytes));
  }

  #locked<T>(threadId: string, task: () => Promise<T>): Promise<T> {
    let queue = this.#threads.get(threadId);
    if (!queue) this.#threads.set(threadId, (queue = new Queue()));
    return queue.run(task);
  }

  inTurn<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    return this.#chain(boxId, task);
  }

  /** Runs `task` after the box's earlier tasks settle. */
  #chain<T>(boxId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#work.get(boxId) ?? Promise.resolve();
    const next = previous.then(task, task);
    const settled = next.then(
      () => undefined,
      () => undefined,
    );
    this.#work.set(boxId, settled);
    void settled.then(() => {
      if (this.#work.get(boxId) === settled) this.#work.delete(boxId);
    });
    return next;
  }

  async #read(threadId: string, boxId: string): Promise<BoxRecord | null> {
    const box = await this.#deps.kv.get<BoxRecord>(recordKey(threadId, boxId));
    return box ? this.#current(box) : null;
  }

  /** A stored record with its kind's current ID and label, when the kind was renamed (027). */
  #current(stored: BoxRecord): BoxRecord {
    const box = withDeviceChecked(stored);
    if (!isEarlierKindId(box.kind)) return box;
    const kind = currentKindId(box.kind);
    return { ...box, kind, kindLabel: this.kinds().find((candidate) => candidate.id === kind)?.label ?? box.kindLabel };
  }

  async #write(written: BoxRecord): Promise<BoxRecord> {
    const box = written.stopForkSafety && (written.state !== "stopped" || written.restoring) ? { ...written, stopForkSafety: null } : written;
    await this.#deps.kv.set(recordKey(box.threadId, box.id), box);
    if (box.state !== "ready") this.#deps.reach?.settled?.(box);
    this.#deps.recorded?.(box, false);
    this.#deps.notify(box.threadId);
    return box;
  }

  async #forget(box: BoxRecord, how: "released" | "forgotten" = "released"): Promise<void> {
    await this.#deps.kv.delete(recordKey(box.threadId, box.id));
    await this.#deps.kv.delete(indexKey(box.id));
    await this.#forgetGpuPlan(box.id);
    this.#deps.reach?.forget(box.id);
    this.#powerCheckedAt.delete(box.id);
    this.#deps.recorded?.(box, true);
    this.#deps.ended?.(box, how);
    this.#deps.notify(box.threadId);
  }

  #event(box: Pick<BoxRecord, "id" | "threadId" | "name">, kind: BoxEventKind, who: Actor, more: Partial<Pick<BoxEvent, "words" | "observed" | "parts" | "backend" | "state" | "at">> = {}): void {
    try {
      this.#deps.events?.record({ box: box.id, thread: box.threadId, name: box.name, kind, by: who, ...more, at: more.at ?? this.#now() });
    } catch (error) {
      this.#deps.logError("box log", error);
    }
  }

  #openStop(box: BoxRecord): BoxEvent | null {
    const events = this.#deps.events;
    if (!events) return null;
    const latest = new Map<BoxEventKind, BoxEvent>();
    for (const kind of ["stop-asked", "stop-failed", "stopped", "stopped-unasked", "start-asked", "started"] as const) {
      const event = events.latest(box.id, [kind]);
      if (event) latest.set(kind, event);
    }
    return openStop(latest, this.#now());
  }

  async #observedAfterFailure(box: BoxRecord, signal: AbortSignal | undefined, moving: boolean): Promise<Observation> {
    let seen: PowerState | null | undefined;
    await this.#observe(box, { signal, moving, seen: (power) => (seen = power) }).catch(() => null);
    return { state: observedState(seen), at: this.#now(), from: box.backendLabel };
  }

  /** Applies a change to the stored record. Null when the box is gone. */
  update(box: Pick<BoxRecord, "threadId" | "id">, change: (current: BoxRecord) => Partial<BoxRecord>): Promise<BoxRecord | null> {
    return this.#locked(box.threadId, async () => {
      const current = await this.#read(box.threadId, box.id);
      if (!current) return null;
      return this.#write({ ...current, ...change(current) });
    });
  }

  async list(threadId: string): Promise<BoxRecord[]> {
    return this.#load(await this.#deps.kv.list(`box/${threadId}/`));
  }

  async all(): Promise<BoxRecord[]> {
    return this.#load(await this.#deps.kv.list("box/"));
  }

  /**
   * The names a new name must avoid: `taken`, and every live box's in this
   * install, whatever its thread. A spare's name is a claimed box's, so a
   * new spare named only against the spares could share a name, and a BB
   * machine's, with a box a thread just claimed (#539).
   */
  async #liveNames(taken: ReadonlySet<string>): Promise<Set<string>> {
    return new Set([...taken, ...(await this.all()).filter((box) => box.state !== "gone").map((box) => box.name)]);
  }

  async #load(keys: string[]): Promise<BoxRecord[]> {
    const boxes = await Promise.all(keys.map((key) => this.#deps.kv.get<BoxRecord>(key)));
    return boxes
      .filter((box): box is BoxRecord => !!box)
      .map((box) => this.#current(box))
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  backendSilence(backendId: string): BackendSilence | null {
    return this.#silentBackends.get(backendId) ?? null;
  }

  async #backendSilent(backendId: string, error: string): Promise<void> {
    const known = this.#silentBackends.get(backendId);
    this.#silentBackends.set(backendId, { since: known?.since ?? this.#now(), error });
    if (!known) await this.#notifyBackend(backendId);
  }

  async #backendAnswered(backendId: string): Promise<void> {
    if (!this.#silentBackends.delete(backendId)) return;
    await this.#notifyBackend(backendId);
  }

  async #notifyBackend(backendId: string): Promise<void> {
    const threads = new Set((await this.all()).filter((box) => box.backend === backendId).map((box) => box.threadId));
    for (const threadId of threads) this.#deps.notify(threadId);
  }

  /** A box by ID alone. */
  async find(boxId: string): Promise<BoxRecord | null> {
    const threadId = await this.#deps.kv.get<string>(indexKey(boxId));
    return threadId ? this.#read(threadId, boxId) : null;
  }

  /** A thread's box by ID or friendly name. */
  async get(threadId: string, ref: string): Promise<BoxRecord> {
    const boxes = await this.list(threadId);
    const box = boxes.find((candidate) => candidate.id === ref) ?? boxes.find((candidate) => candidate.name === ref);
    if (!box) {
      const names = boxes.map((candidate) => candidate.name).join(", ");
      throw new BoxError("not_found", `This thread has no box "${ref}".${names ? ` Its boxes are: ${names}.` : " It has no boxes."}`);
    }
    return box;
  }

  async withheldKinds(waitMs = WITHHELD_READ_WAIT_MS): Promise<readonly UnofferedKind[]> {
    const ask = this.#deps.backends.withheld?.bind(this.#deps.backends);
    if (!ask) return [];
    const offered = () => new Set(this.kinds().map((kind) => kind.id));
    const unoffered = Object.keys(KIND_INFO).filter((kind) => !offered().has(kind));
    const reading = AbortSignal.timeout(waitMs);
    const answers = await Promise.all(
      unoffered.map(async (kind): Promise<UnofferedKind | null> => {
        const stillReading = new Promise<null>((resolve) => reading.addEventListener("abort", () => resolve(null), { once: true }));
        const withheld = await Promise.race([ask(kind, reading).catch(() => [] as const), stillReading]);
        if (offered().has(kind)) return null;
        const label = KIND_INFO[kind]?.label ?? kind;
        if (withheld === null) return { kind, label, words: "Being checked: bb-box is still reading whether its backends can make them now. Call box_list again in a few seconds" };
        if (!withheld.length) return null;
        return { kind, label, words: `Not now: ${withheld.map((offer) => `${this.#providerName(offer.backend)} offers them, but not now: ${offer.why}`).join(" ")}` };
      }),
    );
    return answers.filter((answer): answer is UnofferedKind => answer !== null);
  }

  /** The kinds the active backends offer, once each. */
  kinds(): BoxKind[] {
    const seen = new Set<string>();
    return this.#deps.backends
      .kinds()
      .map((offered) => offered.kind)
      .filter((kind) => !seen.has(kind.id) && !!seen.add(kind.id));
  }

  #askedDevice(name: string | undefined, kind: string, platform: DevicePlatform | null, offers: readonly OfferedKind[]): ModelName | null {
    if (name === undefined) return null;
    const offered = offers.length > 0;
    const testOffer = offers.find((candidate) => isTestOffer(candidate.kind.capabilities.device))?.kind.capabilities.device;
    if (testOffer && name.trim().toLowerCase() === TEST_DEVICE_NAME.toLowerCase()) return testOffer.devices[0].model;
    if (!platform) {
      if (!offered && !KIND_INFO[kind]) return null;
      const examples = DEVICE_PLATFORMS.map((each) => deviceModels(each)[0]!.name);
      throw new BoxError("unsupported", `A ${kind} box has no device. device is only for ${deviceKindIds().join(" and ")} boxes, such as ${examples.join(" or ")}.`);
    }
    const choice = chooseModel(name, platform);
    if (!choice.ok) throw new BoxError("unknown_device", choice.words);
    return choice.model.name;
  }

  #ownVmAsked(input: { readonly dedicated?: boolean; readonly shared?: boolean; readonly size?: SizeRequest }, kind: string, impliedOwnVm: boolean, offers: readonly OfferedKind[]): void {
    if (input.dedicated !== undefined && kind !== "ios") {
      throw new BoxError("unsupported", `dedicated is only for ios boxes, which may one day share a Mac or VM with other ios boxes. A ${kind} box is a machine of its own already.`);
    }
    if (input.shared !== undefined && !isSlotKind(kind)) throw new BoxError("unsupported", `shared is only for ios and macos boxes, which can be a macOS user on a shared iOS host. A ${kind} box cannot.`);
    if (input.dedicated === true && input.shared === true) throw new BoxError("unsupported", "Ask for dedicated or shared, not both: dedicated is a VM of its own, shared a macOS user on a host shared with other boxes.");
    if (input.shared === true && isSlotKind(kind) && !lendersOf(offers, kind).length) {
      throw new BoxError("no_capacity", sharedRefusal(kind));
    }
    if (input.shared === true && impliedOwnVm) throw new BoxError("unsupported", "This box is a VM of its own, as a spare, one of your machines, a box from a build or one with a project's image is, so it cannot be shared.");
    if (input.shared === true && sizeAsked(input.size)) throw new BoxError("invalid_size", sizeRefusal(kind));
    if (kind === "ios" && this.sharedHosts().byDefault && lendersOf(offers, "ios").length && input.dedicated !== true && !impliedOwnVm && sizeAsked(input.size)) throw new BoxError("invalid_size", SIZE_NEEDS_DEDICATED);
  }

  #slotByDefault(input: { readonly dedicated?: boolean; readonly shared?: boolean; readonly size?: SizeRequest; readonly slim?: boolean }, kind: string, impliedOwnVm: boolean, offers: readonly OfferedKind[]): boolean {
    if (kind !== "ios" || input.shared !== undefined || input.dedicated === true || impliedOwnVm || sizeAsked(input.size) || input.slim === false) return false;
    return this.sharedHosts().byDefault && lendersOf(offers, "ios").length > 0;
  }

  #withNoSlotWords(error: unknown, noSlotWords: string | null): unknown {
    if (!noSlotWords || !(error instanceof BoxError) || error.code !== "no_capacity") return error;
    return new BoxError("no_capacity", `No shared iOS host had a slot: ${noSlotWords} And no VM of its own could be had: ${error.message}`);
  }

  sharedHosts(kind: SlotKind = "ios"): SharedHosts {
    const byDefault = kind === "ios" && (this.#deps.sharedIosByDefault ?? SHARED_IOS_BY_DEFAULT);
    const offers = this.#deps.backends.kinds().filter((candidate) => candidate.kind.id === kind);
    return lendersOf(offers, kind).length ? sharedHostsOn(byDefault) : { ...SHARED_HOSTS_OFF, byDefault };
  }

  sharedHostsByKind(): Readonly<Record<SlotKind, SharedHosts>> {
    return { ios: this.sharedHosts("ios"), macos: this.sharedHosts("macos") };
  }

  #withSharedHint(error: unknown, kind: string, shared: boolean | undefined, impliedOwnVm: boolean, offers: readonly OfferedKind[]): unknown {
    if (!(error instanceof BoxError) || error.code !== "no_capacity" || kind !== "macos" || shared !== undefined || impliedOwnVm || !lendersOf(offers, "macos").length) return error;
    return new BoxError("no_capacity", `${error.message}${sharedMacosHint()}`);
  }

  async #placeInSlot(offers: readonly OfferedKind[], kind: SlotKind, model: string | null, box: BoxIdentity): Promise<{ readonly chosen: OfferedKind; readonly guest: Guest }> {
    const lenders = lendersOf(offers, kind);
    const lost: string[] = [];
    for (let attempt = 0; attempt < TAKE_TRIES; attempt++) {
      const signal = AbortSignal.timeout(SLOT_PLACE_MS);
      const answers: LenderAnswer<OfferedKind>[] = await Promise.all(
        lenders.map(async (lender) => ({
          lender,
          on: lender.backend.slots!.on,
          tier: await lender.backend.slots!.offer(kind, model, signal).catch((error: unknown) => ({ tier: "wait" as const, words: describeError(error, `Asking ${lender.backend.label} for a slot`) })),
        })),
      );
      const best = bestAnswer(answers);
      if (!best || best.tier.tier === "wait" || best.tier.tier === "own-vm") throw new BoxError("no_capacity", waitWords(answers));
      const taken = await best.lender.backend.slots!.take(best.tier, box, signal);
      if (!("lost" in taken)) return { chosen: best.lender, guest: takenOnSharedHost(taken) };
      lost.push(taken.lost);
      this.#deps.log?.(`A slot for box ${box.name} was lost to another box (${taken.lost}); asking again.`);
    }
    throw new BoxError("no_capacity", lostWords(kind, lost));
  }

  #slimAsked(slim: boolean | undefined, kind: string, platform: DevicePlatform | null): boolean | null {
    if (platform === "ios") return slim ?? true;
    if (slim === undefined) return null;
    throw new BoxError("unsupported", `slim is only for ios boxes, whose iOS Simulator runs without the services a device box does not need unless slim is false. Boxes of kind ${kind} have no such device.`);
  }

  /**
   * Records a new box and starts acquiring it. Returns at once, once a
   * backend has said the box fits; the box is ready when its command
   * transport answers.
   */
  async acquire(input: {
    threadId: string;
    projectId: string | null;
    kind: string;
    size?: SizeRequest;
    role?: BoxRole;
    name?: string;
    on?: string | readonly string[];
    /** An image's name, or "standard" (049). The project's image for the kind when left out. */
    image?: string;
    /**
     * A build to start the box from, as a tried image's kept build (#451):
     * its image's name, build ID and reference on the backend `on` names,
     * which must start boxes from builds.
     */
    from?: { readonly name: string; readonly build: string | null; readonly ref: string };
    device?: string;
    slim?: boolean;
    dedicated?: boolean;
    shared?: boolean;
    gpu?: GpuPart;
    who?: Actor;
  }): Promise<BoxRecord> {
    const requested = this.#now();
    const who = input.who ?? UNKNOWN_ACTOR;
    const { kind: wanted, features } = kindRequest(input.kind);
    const offersOf = () => this.#deps.backends.kinds().filter((candidate) => candidate.kind.id === wanted);
    const withheld = offersOf().length ? [] : ((await this.#deps.backends.withheld?.(wanted)) ?? []);
    const ofKind = offersOf();
    const platform = kindPlatform(wanted, ofKind);
    const askedDevice = this.#askedDevice(input.device, wanted, platform, ofKind);
    const slim = this.#slimAsked(input.slim, wanted, platform);
    // An alias takes only the offers that have its features (041).
    // A VM's offer comes after the others', which start sooner and hold less, unless the request asks for a VM (057).
    const asksVm = features.some((feature) => VM_FEATURES.includes(feature));
    const matching = ofKind.filter((candidate) => hasFeatures(candidate.kind.capabilities, features));
    const everywhere = asksVm ? matching : vmOffersLast(matching);
    if (!ofKind.length && withheld.length) throw withheldRefusal(wanted, withheld, (backend) => this.#providerName(backend));
    if (!ofKind.length) {
      const kinds = this.kinds().map((kind) => kind.id);
      if (platform && kinds.length) throw new BoxError("unknown_kind", `No backend offers ${wanted} boxes (${KIND_INFO[wanted]?.label ?? wanted}) now. The kinds you can acquire are: ${kinds.join(", ")}.`);
      throw new BoxError(
        "unknown_kind",
        kinds.length
          ? `There is no "${input.kind}" kind. The kinds are: ${kinds.join(", ")}.`
          : "No backend is set up, so there are no boxes to acquire. With the user's go-ahead, bb box setup docker sets up Docker on the machine that runs BB, as the Box panel's first run does; or the user sets a backend up in BB Box's settings.",
      );
    }
    if (!everywhere.length) {
      const lacking = features.map(featureWord).join(" or ");
      const from = [...new Set(ofKind.map((candidate) => candidate.backend.label))].join(" and ");
      throw new BoxError("unknown_kind", `No backend offers ${input.kind} now: ${wanted} boxes from ${from} have no ${lacking}. Ask for ${wanted} if the box can do without it.`);
    }
    const withDevice = askedDevice ? everywhere.filter((candidate) => offersModel(candidate.kind.capabilities.device, askedDevice)) : everywhere;
    if (!withDevice.length) {
      const offered = [...new Set(everywhere.flatMap((candidate) => (candidate.kind.capabilities.device ? offeredModels(candidate.kind.capabilities.device) : [])))];
      throw new BoxError("unknown_device", `No backend offers the ${askedDevice} now.${offered.length ? ` The ${wanted} devices offered are: ${offered.join(", ")}.` : ""}`);
    }
    const gpuChoice = chooseGpu(input.kind, input.gpu, (await this.#deps.general()).gpuWhenNotAsked);
    if (!gpuChoice.ok) throw new BoxError("unsupported", gpuChoice.message);
    const askedGpu = input.threadId === SPARES ? gpuForSpare(gpuChoice.gpu) : gpuChoice.gpu;
    const gpuAsked = input.gpu !== undefined;
    const gpuFor = (kind: BoxKind) => gpuOnOffer(kind, askedGpu, gpuAsked);
    const forAgent = who.is === "agent";
    if (askedGpu === "whole" && !(await this.wholeCards())) throw new BoxError("unsupported", forAgent ? WHOLE_CARDS_OFF.agent : WHOLE_CARDS_OFF.person, WHOLE_CARDS_OFF.agent);
    // The named providers are the only ones tried, in acquire order (044).
    const namedForKind = input.on !== undefined ? this.#on(input.on, input.kind, everywhere) : null;
    const named = namedForKind && askedDevice ? this.#namedWithDevice(namedForKind, askedDevice, withDevice) : namedForKind;
    const offered = this.#takingGpu(named ? named.offers : withDevice, wanted, askedGpu, gpuAsked, forAgent);
    const role = input.role ?? "box";
    const yours = input.threadId === OPERATOR;
    if (yours) {
      if (input.name !== undefined && !isMachineName(input.name)) {
        throw new BoxError("invalid_name", `Name a machine with a lower-case letter first, then letters, digits and "-", up to 32, not ending in "-". "${input.name}" is not one.`);
      }
      const kind = withDevice[0]!.kind;
      if (!kind.capabilities.enrol) throw new BoxError("unsupported", `A ${kind.label} box cannot become a BB machine, so it cannot be one of your machines.`);
    }
    // Spares and your machines are outside the per-thread limit.
    const owned = role === "box" && ownedByThread(input.threadId);
    const claimsSpare = role === "box" && input.threadId !== SPARES;
    const general = await this.#deps.general();
    // The image chosen, or the project's for the kind (049): a thread's own box too, not one of your machines unless chosen. Such a box is made, not a spare, for now.
    const tried = input.from ?? null;
    if (tried && named === null) throw new BoxError("unsupported", "A box from a given build needs the backend that keeps it, in on.");
    const image = tried
      ? null
      : input.image === "standard" ? null : input.image !== undefined ? (this.#deps.image?.(input.projectId, wanted, input.image) ?? null) : yours ? null : (this.#deps.image?.(input.projectId, wanted) ?? null);
    if (input.image !== undefined && input.image !== "standard" && !image) {
      throw new BoxError("not_found", `There is no image ${input.image} for ${wanted} boxes. box_list names each kind's images; "standard" is bb-box's own.`);
    }
    // Spares left over from a kind that keeps none now are released, not claimed. A project's image's box claims a spare of its image's current build (#440).
    const impliedOwnVm = input.threadId === SPARES || yours || role === "machine" || tried !== null || image !== null;
    this.#ownVmAsked(input, wanted, impliedOwnVm, offered);
    const inSlotAsked = input.shared === true && isSlotKind(wanted);
    const slotByDefault = this.#slotByDefault(input, wanted, impliedOwnVm, offered);
    const claims = claimsSpare && !tried && !inSlotAsked && (image !== null || (general.spares[wanted] ?? 0) > 0);
    const bootsDevice = askedDevice ?? ofKind.find((candidate) => candidate.kind.capabilities.device)?.kind.capabilities.device?.devices[0].model;
    const sized = chooseSize(wanted, kindSizes(wanted, general.sizes), input.size, bootsDevice);
    if (!sized.ok) throw new BoxError("invalid_size", sized.message);
    const { box, claimed } = await this.#admission.run(() =>
      this.#locked(input.threadId, async () => {
        const existing = await this.list(input.threadId);
        const active = existing.filter((box) => isActive(box) && box.role === "box");
        if (owned && general.perThreadLimit !== null && active.length >= general.perThreadLimit) {
          throw new BoxError(
            "limit_reached",
            `This thread already has ${active.length} boxes, the most allowed: ${active.map((box) => box.name).join(", ")}. Release one first.`,
          );
        }
        const taken = new Set(existing.filter((box) => box.state !== "gone").map((box) => box.name));
        if (input.name !== undefined && taken.has(input.name)) throw new BoxError("invalid_name", `There is a machine called ${input.name} already.`);
        const claimSpare = async () => (claims ? await this.#claim({ ...input, askedDevice, slim }, offered, features, sized.size, gpuFor, taken, requested, image?.name ?? null) : null);
        const spare = slotByDefault ? null : await claimSpare();
        if (spare) return { box: spare.box, claimed: spare.from };
        const id = newBoxId(this.#random);
        const name = input.name ?? generateName(await this.#liveNames(taken), this.#random);
        const createdAt = this.#now();
        const identity = { boxId: id, threadId: input.threadId, name, kind: wanted, createdAt, size: withGpu(sized.size, askedGpu) };
        let noSlotWords: string | null = null;
        const slot = inSlotAsked
          ? await this.#placeInSlot(offered, wanted as SlotKind, askedDevice, identity)
          : slotByDefault
            ? await this.#placeInSlot(offered, "ios", askedDevice, identity).catch((error: unknown) => {
                if (!(error instanceof BoxError) || error.code !== "no_capacity") throw error;
                noSlotWords = error.message;
                const ownVmOffered = offered.some(({ kind }) => kind.id === "ios" && !kind.slotsOnly);
                this.#deps.log?.(
                  ownVmOffered
                    ? `Box ${name} found no slot on a shared iOS host, so bb-box looks for a VM of its own: ${error.message}`
                    : `Box ${name} found no slot on a shared iOS host, and no VM of its own is offered where it was asked, so it is refused: ${error.message}`,
                );
                return null;
              })
            : null;
        if (!slot && slotByDefault) {
          const fallback = await claimSpare();
          if (fallback) return { box: fallback.box, claimed: fallback.from };
        }
        const placedIn: Record<string, number> = slot ? { "shared-host": this.#now() - createdAt } : {};
        const chosen = slot ? slot.chosen : await this.#place({ threadId: input.threadId, named, forAgent, gpuFor }, offered, withDevice, withGpu(sized.size, askedGpu), features).catch((error: unknown) => {
          throw this.#withNoSlotWords(this.#withSharedHint(error, wanted, input.shared, impliedOwnVm, offered), noSlotWords);
        });
        if (tried && !chosen.backend.images?.startsFrom) throw new BoxError("unsupported", `${chosen.backend.label} starts no box from a build.`);
        // A current baked build of the image on the backend chosen starts the box with it (049); otherwise its script runs at start.
        const baked =
          image && chosen.backend.images?.startsFrom ? await this.#deps.baked?.(image.name, chosen.backend.id, chosen.kind.id).catch(() => null) : null;
        const box: BoxRecord = {
          id,
          threadId: input.threadId,
          projectId: input.projectId,
          name,
          kind: chosen.kind.id,
          kindLabel: chosen.kind.label,
          requires: [...new Set([...chosen.kind.requires, ...features])],
          capabilities: slot && inSlot({ guest: slot.guest }) ? slotCapabilities(chosen.kind.capabilities) : chosen.kind.capabilities,
          backend: chosen.backend.id,
          backendLabel: chosen.backend.label,
          nature: chosen.backend.nature,
          role,
          size: withGpu(sized.size, gpuFor(chosen.kind)),
          guest: slot?.guest ?? null,
          state: "acquiring",
          error: null,
          createdAt,
          readyAt: null,
          releaseRequestedAt: null,
          resetAt: null,
          timings: placedIn,
          enrol: { state: "off", hostId: null, error: null },
          ...(askedDevice ? { askedDevice } : {}),
          ...(slim !== null ? { slim } : {}),
          ...(tried
            ? { image: { name: tried.name, state: "baked" as const, build: tried.build, from: tried.ref } }
            : image
              ? { image: baked ? { name: image.name, state: "baked" as const, build: baked.build, from: baked.ref } : { name: image.name, state: "pending" as const } }
              : {}),
        };
        await this.#deps.kv.set(indexKey(box.id), box.threadId);
        const written = await this.#write(box);
        this.#event(written, "made", who, { at: createdAt });
        return { box: written, claimed: null };
      }),
    );
    if (claimed !== null && box.state === "stopped") {
      // A spare that waited stopped (#539): it starts first, as a hibernated VM cannot be relabelled, and the start reconnects its machine.
      void this.#chain(box.id, async () => {
        const started = await this.#start(box, undefined, false, who);
        // The claim's time counts the resume, which its last start's times also show.
        const timed = await this.update(started, ({ timings }) => {
          const { spare = 0, total: _, spareResume: __, ...rest } = timings;
          const spareResume = timings["start.total"] ?? 0;
          return { timings: { spare, spareResume, total: spare + spareResume, ...rest } };
        });
        // The start reconnects its machine. How long that took from the claim, until BB shows the
        // machine connected with the thread's access, is a step of its own, as a new box's enrolment is.
        const reconnect = this.#reconnects.get(box.id);
        if (reconnect) {
          this.#waitFor(
            box.id,
            reconnect.then(async () => {
              await this.update(box, ({ timings }) => ({ timings: { ...timings, spareReconnect: this.#now() - requested } })).catch(() => null);
            }),
          );
        }
        return timed ?? started;
      }).then(
        (started) => this.#claimed(started, claimed),
        (error) => this.#deps.logError("start a claimed spare", error),
      );
    } else if (claimed !== null) this.#claimed(box, claimed);
    else this.#startAcquire(box);
    return box;
  }

  async wholeCards(): Promise<boolean> {
    return (await this.#deps.general()).wholeCards ?? false;
  }

  async admitFork(request: ForkAdmission): Promise<void> {
    await this.#forkRoom(request);
    this.#forkPlace(request, await this.list(request.threadId), await this.#deps.general());
  }

  async #forkRoom(request: ForkAdmission): Promise<OfferedKind> {
    const offered = this.#deps.backends.kinds().find((candidate) => candidate.backend.id === request.backend && candidate.kind.id === request.kind);
    if (!offered) throw new BoxError("unknown_kind", `${request.backendLabel} offers no ${request.kind} boxes now, so bb-box cannot fork one there.`);
    const { backend, kind } = offered;
    const yours = request.threadId === OPERATOR;
    if (yours && request.name !== undefined && !isMachineName(request.name)) {
      throw new BoxError("invalid_name", `Name a machine with a lower-case letter first, then letters, digits and "-", up to 32, not ending in "-". "${request.name}" is not one.`);
    }
    if (yours && !kind.capabilities.enrol) throw new BoxError("unsupported", `A ${kind.label} box cannot become a BB machine, so a fork of it cannot be one of your machines.`);
    const size = request.size ?? defaultSize(kindSizes(kind.id, (await this.#deps.general()).sizes));
    const gpu = request.gpu ?? "none";
    if (gpu === "whole" && !(await this.wholeCards())) throw new BoxError("unsupported", WHOLE_CARDS_OFF_FOR_FORK.person, WHOLE_CARDS_OFF_FOR_FORK.agent);
    const room = await backend.capacity(kind.id, withGpu(size, gpu), await this.#pending(backend.id), undefined, { threadId: request.threadId });
    if (!room.ok) {
      const said = (words: string | null | undefined) => forkCapacityWords(`${backend.label} has no room for the fork: ${words ?? "it did not say why"}`, gpu);
      throw new BoxError("no_capacity", said(room.message), request.who?.is === "agent" ? said(room.agentMessage?.replace(/^Not made: /, "") ?? room.message) : null);
    }
    return offered;
  }

  #forkPlace(request: ForkAdmission, existing: readonly BoxRecord[], general: GeneralConfig): Set<string> {
    const yours = request.threadId === OPERATOR;
    const active = existing.filter((box) => isActive(box) && box.role === "box");
    if (!yours && ownedByThread(request.threadId) && general.perThreadLimit !== null && active.length >= general.perThreadLimit) {
      throw new BoxError("limit_reached", `This thread already has ${active.length} boxes, the most allowed: ${active.map((box) => box.name).join(", ")}. Release one first.`);
    }
    const taken = new Set(existing.filter((box) => box.state !== "gone").map((box) => box.name));
    if (request.name !== undefined && taken.has(request.name)) throw new BoxError("invalid_name", `There is a ${yours ? "machine" : "box"} called ${request.name} already${yours ? "" : " in this thread"}.`);
    return taken;
  }

  async fork(request: ForkRequest): Promise<BoxRecord> {
    const { backend, kind } = await this.#forkRoom(request);
    const general = await this.#deps.general();
    const box = await this.#admission.run(() =>
      this.#locked(request.threadId, async () => {
        const taken = this.#forkPlace(request, await this.list(request.threadId), general);
        const createdAt = this.#now();
        const record: BoxRecord = {
          id: request.id,
          threadId: request.threadId,
          projectId: request.projectId,
          name: request.name ?? generateName(await this.#liveNames(taken), this.#random),
          kind: kind.id,
          kindLabel: kind.label,
          requires: [...kind.requires],
          capabilities: kind.capabilities,
          backend: backend.id,
          backendLabel: backend.label,
          nature: backend.nature,
          role: "box",
          size: withGpu(request.size, request.gpu ?? "none"),
          guest: null,
          state: "acquiring",
          error: null,
          createdAt,
          readyAt: null,
          releaseRequestedAt: null,
          resetAt: null,
          timings: {},
          enrol: { state: "off", hostId: null, error: null },
          fork: request.origin,
        };
        await this.#deps.kv.set(indexKey(record.id), record.threadId);
        const written = await this.#write(record);
        this.#event(written, "made", request.who, { at: createdAt, words: forkedFromWords(request.origin) });
        return written;
      }),
    );
    this.#startAcquire(box);
    return box;
  }

  /**
   * Moves a spare of an offered kind and the size to the thread, or returns
   * null when none suits (032). Runs in the thread's turn; `taken` holds the
   * names of its boxes. The box's timings are the claim's, from `requested`.
   */
  async #claim(
    input: { threadId: string; projectId: string | null; name?: string; askedDevice: ModelName | null; slim: boolean | null; who?: Actor },
    offered: OfferedKind[],
    features: readonly string[],
    size: MachineSize,
    gpuFor: (kind: BoxKind) => GpuPart,
    taken: Set<string>,
    requested: number,
    /** The project's image the box gets, whose spares alone it claims; a kind's spares have none. */
    imageName: string | null,
  ): Promise<{ box: BoxRecord; from: string } | null> {
    return this.#locked(SPARES, async () => {
      // A spare of an old build skipped here: the upkeep is asked to replace it now.
      let stale = false;
      const claimed = await (async () => {
        for (const spare of await this.list(SPARES)) {
          const spareOffer = offered.find((candidate) => candidate.backend.id === spare.backend && candidate.kind.id === spare.kind);
          if (!spareOffer) continue;
          if ((spare.image?.name ?? null) !== imageName) continue;
          // An image's spare from a build that is no longer current there is not claimed: the upkeep replaces it.
          if (imageName && (spare.image?.state !== "baked" || (await this.#deps.baked?.(imageName, spare.backend, spare.kind).catch(() => null))?.ref !== spare.image.from)) continue;
          // A spare made before its backend's offer gained a feature lacks it.
          if (!hasFeatures(spare.capabilities, features)) continue;
          if (input.askedDevice && !offersModel(spare.capabilities.device, input.askedDevice)) continue;
          if (!(await this.#claimable(spare)) || !sameSize(await this.#size(spare), withGpu(size, gpuFor(spareOffer.kind)))) continue;
          // A spare of an older build of its kind's image than its backend starts
          // boxes from now is not claimed, from the moment the image is
          // replaced, not only once the upkeep has replaced the spare. The
          // backend answers without starting it.
          if (!imageName && (await this.#oldBuild(spare))) {
            this.#deps.log?.(`Skipped spare box ${spare.name}: it is of an older build of its ${spare.kind} image than ${spare.backendLabel} starts boxes from now. The upkeep replaces it.`);
            stale = true;
            continue;
          }
          try {
            if (this.#deps.spareThread && (await this.#deps.spareThread(spare)) !== null) {
              this.#deps.log?.(`Skipped spare box ${spare.name}: a thread uses its BB machine.`);
              continue;
            }
          } catch (error) {
            this.#deps.logError("claim", error);
            continue;
          }
          const ms = this.#now() - requested;
          const box: BoxRecord = {
            ...spare,
            threadId: input.threadId,
            projectId: input.projectId,
            name: input.name ?? (taken.has(spare.name) ? generateName(await this.#liveNames(taken), this.#random) : spare.name),
            requires: [...new Set([...spare.requires, ...features])],
            ...(input.askedDevice ? { askedDevice: input.askedDevice } : {}),
            ...(input.slim !== null ? { slim: input.slim } : {}),
            timings: { spare: ms, total: ms },
          };
          await this.#deps.kv.set(indexKey(box.id), box.threadId);
          await this.#write(box);
          this.#event(box, "made", input.who ?? UNKNOWN_ACTOR, { words: `Claimed from bb-box's spare boxes, as ${spare.name}.` });
          if (box.state === "ready") this.#event(box, "ready", UNKNOWN_ACTOR);
          await this.#deps.kv.delete(recordKey(SPARES, box.id));
          this.#deps.notify(SPARES);
          return { box, from: spare.name };
        }
        return null;
      })();
      if (stale) void this.keepSpares();
      return claimed;
    });
  }

  /**
   * Keeps the last five cold starts of each kind on each backend, by their
   * total time to ready, for "usually about 3 s" in the panel. A claim from
   * a spare (its timings carry `spare`) and a restored record are not starts.
   */
  async #recordReady(box: BoxRecord): Promise<void> {
    const total = box.timings.total;
    if (box.timings.spare !== undefined || box.restoredAt || typeof total !== "number") return;
    const history = (await this.#deps.kv.get<Record<string, number[]>>(READY_HISTORY)) ?? {};
    const key = `${box.kind}|${box.backend}`;
    history[key] = [...(history[key] ?? []), total].slice(-5);
    await this.#deps.kv.set(READY_HISTORY, history);
  }

  /** The median of each kind's last cold starts on each backend, keyed "<kind>|<backend>", in ms. */
  async typicalReady(): Promise<Record<string, number>> {
    const history = (await this.#deps.kv.get<Record<string, number[]>>(READY_HISTORY)) ?? {};
    const typical: Record<string, number> = {};
    for (const [key, totals] of Object.entries(history)) {
      const sorted = [...totals].sort((a, b) => a - b);
      if (!sorted.length) continue;
      const middle = Math.floor(sorted.length / 2);
      typical[key] = sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
    }
    return typical;
  }

  /** Each kind's spares ready to claim now, keyed "<kind>|<backend>" (032), for the picker's offers. */
  async spareReadyByBackend(): Promise<Record<string, number>> {
    const counts: Record<string, number> = {};
    for (const spare of await this.list(SPARES)) {
      // An image's spares (#440) are not its kind's: a box of the standard image does not claim them.
      if (!isActive(spare) || spare.image || !(await this.#claimable(spare))) continue;
      const key = `${spare.kind}|${spare.backend}`;
      counts[key] = (counts[key] ?? 0) + 1;
    }
    return counts;
  }

  /** Each kind's spares now (032): ready to claim, and being made or made ready. */
  async spareCounts(): Promise<Record<string, { readonly ready: number; readonly making: number }>> {
    const counts: Record<string, { ready: number; making: number }> = {};
    for (const spare of await this.list(SPARES)) {
      // An image's spares (#440) are not its kind's.
      if (!isActive(spare) || spare.image) continue;
      const count = (counts[spare.kind] ??= { ready: 0, making: 0 });
      if (await this.#claimable(spare)) count.ready++;
      else count.making++;
    }
    return counts;
  }

  /** Each project's image's spares (#440), by "<image>|<backend>|<kind>": ready to claim, or being made. */
  async imageSpareCounts(): Promise<Record<string, { readonly ready: number; readonly making: number }>> {
    const counts: Record<string, { ready: number; making: number }> = {};
    for (const spare of await this.list(SPARES)) {
      if (!isActive(spare) || !spare.image) continue;
      const count = (counts[`${spare.image.name}|${spare.backend}|${spare.kind}`] ??= { ready: 0, making: 0 });
      if (await this.#claimable(spare)) count.ready++;
      else count.making++;
    }
    return counts;
  }

  /** The doctor's line for each image's spare the upkeep holds off, as a box of its build failed to start (#440). */
  async imageSpareChecks(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    for (const key of await this.#deps.kv.list("spares/image-failed/")) {
      const failed = await this.#deps.kv.get<{ ref: string; at: number }>(key);
      if (!failed || this.#now() - failed.at >= SPARE_RETRY_MS) continue;
      const [name = "", backend = "", kind = ""] = key.slice("spares/image-failed/".length).split("/");
      const when = (at: number) => new Date(at).toISOString().slice(0, 16).replace("T", " ");
      checks.push({
        id: `spares.image.${name}.${backend}.${kind}`,
        name: `Spare of ${name} for ${kind} on ${backend}`,
        status: "warn",
        detail: `A spare from its build ${failed.ref} failed to start at ${when(failed.at)} UTC, so bb-box keeps none of that build until ${when(failed.at + SPARE_RETRY_MS)} UTC. Its boxes start from the build meanwhile.`,
        fix: "The failed box's error is in bb box list --all. A new build of the image, as a changed script or the nightly rebuild makes, is tried at once.",
      });
    }
    return checks;
  }

  /**
   * Whether a spare can be claimed now: ready, answering, enrolled when it
   * enrols, and with no task running; or waiting stopped, which the claim
   * starts (#539).
   */
  async #claimable(spare: BoxRecord): Promise<boolean> {
    if (spare.restoredAt || spare.error || this.#work.has(spare.id) || this.#reconnects.has(spare.id)) return false;
    if (spare.state === "stopped") return this.#waitsStopped(spare);
    if (spare.state !== "ready") return false;
    return spare.enrol.state === "enrolled" || (spare.enrol.state === "off" && !(await this.#enrols(spare)));
  }

  /**
   * Whether a spare waits stopped (#539): it is a BB machine, on a backend
   * whose stop keeps its session, so it holds no memory while it waits and
   * a start resumes it, BB's daemon included, in a few seconds.
   */
  #waitsStopped(spare: BoxRecord): boolean {
    return spare.enrol.state === "enrolled" && !!this.#deps.backends.get(spare.backend)?.keepsSession?.(spare.kind);
  }

  async #spareSettling(spare: BoxRecord): Promise<SpareSettling> {
    if (!this.#deps.spareSettled) return { is: "settled" };
    return this.#deps.spareSettled(spare).catch((error): SpareSettling => {
      this.#deps.logError("spares", error);
      return { is: "settling" };
    });
  }

  #waitedPastRestore(spare: BoxRecord): string | null {
    if (spare.state !== "stopped") return null;
    const restoresWithinMs = this.#deps.backends.get(spare.backend)?.savedSessionRestoresWithinMs?.(spare.kind) ?? null;
    if (restoresWithinMs === null) return null;
    const since = spare.stoppedAt ?? spare.readyAt ?? spare.createdAt;
    const waited = this.#now() - since;
    if (waited <= restoresWithinMs) return null;
    return `it has waited stopped for ${hoursWords(waited)}, longer than ${spare.backendLabel} restores a saved ${spare.kind} VM reliably, ${hoursWords(restoresWithinMs)}`;
  }

  identityChecked(box: BoxRecord): boolean {
    return forksOn(box.capabilities.os) && !!box.identityMarkedAt;
  }

  async identityResetFound(box: BoxRecord, reset: { readonly at: number; readonly why: string; readonly machine: string }): Promise<BoxRecord | null> {
    const foundAt = this.#now();
    const ours = (current: BoxRecord) => current.state !== "releasing" && (current.enrol.hostId === reset.machine || current.enrol.hostId === null) && current.identityReset?.machine !== reset.machine;
    const marked = await this.update(box, (current) =>
      ours(current)
        ? { enrol: { state: "off", hostId: null, error: null }, removedMachineToCheck: null, identityReset: { ...reset, foundAt, retiredAt: null, machineAgain: null, enrolledAgainAt: null } }
        : {},
    );
    if (!marked || marked.identityReset?.foundAt !== foundAt) return null;
    const next = marked.role === "machine" ? threadMachineWords(marked) : "so bb-box enrols the box again as a new BB machine, and keeps it.";
    this.#event(marked, "identity-reset", byBbBox("its BB machine went with its identity reset"), {
      words: `Box ${marked.name} reset its identity at ${utc(reset.at)}, as ${reset.why}. BB's machine ${reset.machine} went with it, ${next}`,
    });
    this.#deps.log?.(`Box ${marked.name} reset its identity at ${utc(reset.at)}, as ${reset.why}, removing BB's machine ${reset.machine}: ${next}`);
    return marked;
  }

  async identityResetRetired(boxId: string): Promise<BoxRecord | null> {
    const box = await this.find(boxId);
    if (!box?.identityReset || box.identityReset.retiredAt !== null) return box;
    const at = this.#now();
    return this.update(box, (current) => (current.identityReset && current.identityReset.retiredAt === null ? { identityReset: { ...current.identityReset, retiredAt: at } } : {}));
  }

  async enrolledAgainAfterReset(boxId: string): Promise<BoxRecord | null> {
    const box = await this.find(boxId);
    const reset = box?.identityReset;
    if (!box || !reset || reset.enrolledAgainAt !== null || box.enrol.state !== "enrolled" || !box.enrol.hostId || box.enrol.hostId === reset.machine) return null;
    const machine = box.enrol.hostId;
    const now = this.#now();
    const updated = await this.update(box, (current) =>
      current.identityReset && current.identityReset.enrolledAgainAt === null && current.enrol.hostId === machine ? { identityReset: { ...current.identityReset, machineAgain: machine, enrolledAgainAt: now } } : {},
    );
    if (updated?.identityReset?.enrolledAgainAt !== now) return null;
    if (updated.guest) {
      const backend = this.#deps.backends.get(updated.backend);
      if (backend) await this.#markIdentity(updated, updated.guest, backend, {}, AbortSignal.timeout(MARKER_WRITE_MS * 2));
    }
    this.#event(updated, "enrolled-again", byBbBox("its BB machine went with its identity reset"), {
      words: `Box ${updated.name} joined BB again as machine ${machine}, in place of ${reset.machine}, ${Math.max(1, Math.round((now - reset.foundAt) / 1000))} s after bb-box found its identity reset.`,
    });
    return updated;
  }

  async machineToCheck(box: BoxRecord, machine: string, why: string): Promise<BoxRecord | null> {
    const at = this.#now();
    const updated = await this.update(box, (current) =>
      current.enrol.hostId === machine || (current.enrol.hostId === null && !current.removedMachineToCheck)
        ? { enrol: current.enrol.hostId === machine ? { state: current.enrol.state === "failed" ? "failed" : "off", hostId: null, error: current.enrol.state === "failed" ? current.enrol.error : null } : current.enrol, removedMachineToCheck: { machine, at, why } }
        : {},
    );
    if (updated?.removedMachineToCheck?.at === at) this.#deps.log?.(`BB no longer has machine ${machine} of box ${updated.name}, and bb-box could not read whether the box's identity reset (${why}), so it keeps the box and reads again at each sweep.`);
    return updated;
  }

  async identityResetChecks(): Promise<DoctorCheck[]> {
    return (await this.all()).flatMap((box): DoctorCheck[] => {
      const checks: DoctorCheck[] = [];
      const look = "A box that is not a copy of another should never reset: see /var/lib/bb-box/identity-resets and journalctl -u bb-box-identity in the box.";
      const reset = box.identityReset;
      if (reset) {
        const what = `Box ${box.name} reset its identity at ${utc(reset.at)}, as ${reset.why}, and BB's machine ${reset.machine} went with it.`;
        if (box.role === "machine") {
          checks.push({
            id: `identity-reset.${box.name}`,
            name: `Identity reset of ${box.name}`,
            status: "fail",
            detail: `${what} ${threadMachineWords(box)}`,
            fix: `Copy what thread ${box.threadId} needs from the box with bb box run or box_copy, then end the thread or remove machine ${reset.machine} in BB, which releases the box. ${look}`,
          });
        } else if (reset.enrolledAgainAt !== null) {
          checks.push({ id: `identity-reset.${box.name}`, name: `Identity reset of ${box.name}`, status: "warn", detail: `${what} bb-box kept the box and enrolled it again, at ${utc(reset.enrolledAgainAt)}, as BB machine ${reset.machineAgain}.`, fix: look });
        } else {
          const step = reset.retiredAt === null ? `BB has not yet confirmed the removal of machine ${reset.machine}, which bb-box asks for again at each sweep` : "bb-box has not yet enrolled it again as a BB machine";
          const why = box.enrol.state === "failed" && box.enrol.error ? ` Its last try failed: ${box.enrol.error}` : "";
          checks.push({ id: `identity-reset.${box.name}`, name: `Identity reset of ${box.name}`, status: "fail", detail: `${what} bb-box kept the box; ${step}.${why}`, fix: `bb-box tries again at each sweep. ${look}` });
        }
      }
      const check = box.removedMachineToCheck;
      if (check) {
        checks.push({
          id: `identity-reset.${box.name}`,
          name: `Identity reset of ${box.name}`,
          status: "warn",
          detail: `BB no longer has machine ${check.machine} of box ${box.name}, since ${utc(check.at)}, and bb-box could not read whether the box's identity reset (${check.why}), so it keeps the box.`,
          fix: "bb-box reads the box's /var/lib/bb-box/identity-resets again at each sweep, once the box answers. If you removed the machine in BB on purpose, release the box in bb-box.",
        });
      }
      return checks;
    });
  }

  async spareChecks(): Promise<DoctorCheck[]> {
    const general = await this.#deps.general();
    const counts = await this.spareCounts();
    const spares = (await this.list(SPARES)).filter((spare) => isActive(spare) && !spare.image);
    const offered = new Map<string, OfferedKind[]>();
    for (const offer of this.#deps.backends.kinds()) offered.set(offer.kind.id, [...(offered.get(offer.kind.id) ?? []), offer]);
    const checks: DoctorCheck[] = [];
    for (const [kind, offers] of offered) {
      const wanted = general.spares[kind] ?? 0;
      const device = offers.some((offer) => offer.kind.capabilities.device);
      if (!wanted && !device) continue;
      const memory = defaultSize(kindSizes(kind, general.sizes)).memoryMiB;
      const spareBackend = spares.find((spare) => spare.kind === kind)?.backend;
      const where = offers.find((offer) => offer.backend.id === spareBackend)?.backend ?? offers[0]!.backend;
      const waitsSaved = !!where.keepsSession?.(kind);
      const cost = waitsSaved
        ? `A spare waits stopped with its session saved: it holds no memory, and its saved memory takes disk, at most a little over its ${formatMiB(memory)} of memory, besides its own disk.`
        : `A spare waits running, with its ${formatMiB(memory)} of memory.`;
      const name = `Spare ${kind} boxes`;
      if (!wanted) {
        checks.push({ id: `spares.${kind}`, name, status: "ok", detail: `Spares are off for ${kind} boxes: none is kept. ${cost}`, fix: null });
        continue;
      }
      const now = counts[kind] ?? { ready: 0, making: 0 };
      const keeps = `bb-box keeps ${wanted} spare ${kind} ${wanted === 1 ? "box" : "boxes"}: ${now.ready} ready, ${now.making} being made. ${cost}`;
      const shortfall = this.#spareShortfalls.get(kind);
      if (shortfall && now.ready + now.making < wanted) {
        checks.push({ id: `spares.${kind}`, name, status: "warn", detail: `${keeps} It has too few: ${sentence(shortfall)}`, fix: `Free room where ${kind} boxes go, or set fewer spares in the ${kind} kind's settings.` });
      } else checks.push({ id: `spares.${kind}`, name, status: "ok", detail: keeps, fix: null });
    }
    return checks;
  }

  /**
   * After a claim: renames the box's BB machine, and makes another spare.
   * Its commands wait only when its machine must reconnect (#128).
   */
  #claimed(box: BoxRecord, from: string): void {
    this.#deps.log?.(`Claimed spare box ${box.name} for thread ${box.threadId}.`);
    this.#renamed(box, from);
    // A claim of an image's spare is a use of its build (#440).
    if (box.image) this.#deps.imageReady?.(box);
    this.#deps.spareClaimed?.(box);
    void this.keepSpares();
  }

  /** Makes the box's commands wait a while for `task`, which never rejects. */
  #waitFor(boxId: string, task: Promise<void>): void {
    this.#reconnects.set(boxId, task);
    void task.then(() => {
      if (this.#reconnects.get(boxId) === task) this.#reconnects.delete(boxId);
    });
  }

  /**
   * Gives each box the capabilities its kind has now, where its backend
   * still offers the kind and says the guest comes from what it offers it
   * from. A box keeps the capabilities it was acquired with otherwise, so a
   * release that adds one, such as computer use, reaches long-lived boxes
   * too (#215). What describes the guest as it was made, such as its size
   * and address, is the guest's and stays. Returns how many changed.
   */
  async refreshCapabilities(signal?: AbortSignal): Promise<number> {
    let changed = 0;
    for (const box of await this.all()) {
      if (signal?.aborted) break;
      if (!box.guest || box.state === "gone" || box.state === "releasing") continue;
      const backend = this.#deps.backends.get(box.backend);
      const kind = backend ? this.#offeredKinds(backend).find((candidate) => candidate.id === box.kind) : undefined;
      if (!backend || !kind) continue;
      // A box asked for by an alias keeps what it was made with when the offer now lacks the alias's features (041).
      if (!hasFeatures(kind.capabilities, box.requires)) continue;
      const requires = [...new Set([...kind.requires, ...box.requires])];
      const capabilities = inSlot(box) ? slotCapabilities(kind.capabilities) : kind.capabilities;
      if (JSON.stringify(box.capabilities) === JSON.stringify(capabilities) && JSON.stringify(box.requires) === JSON.stringify(requires)) continue;
      if (backend.asOffered && !(await backend.asOffered(box.guest, kind.id, box.createdAt, signal).catch((error) => (this.#deps.logError("capabilities", error), false)))) continue;
      const updated = await this.update(box, () => ({ capabilities, requires, kindLabel: kind.label })).catch((error) => {
        this.#deps.logError("capabilities", error);
        return null;
      });
      if (!updated) continue;
      changed++;
      this.#deps.log?.(`Box ${box.name} has the capabilities of its kind ${kind.id} now.`);
      this.#deps.notify(box.threadId);
    }
    return changed;
  }

  /**
   * Keeps each kind's spares (032): makes those missing, at the kind's
   * default size, and releases those no kind keeps now, those of another
   * size and those no claim can take. One run at a time; a call during a run
   * starts another after it.
   */
  keepSpares(): Promise<void> {
    if (this.#keeping) {
      this.#keepAgain = true;
      return this.#keeping;
    }
    const keeping = (async () => {
      do {
        this.#keepAgain = false;
        await this.#keepSpares().catch((error) => this.#deps.logError("spares", error));
      } while (this.#keepAgain && !this.#disposed);
    })().finally(() => {
      this.#keeping = null;
    });
    this.#keeping = keeping;
    return keeping;
  }

  async #keepSpares(): Promise<void> {
    if (this.#disposed) return;
    const general = await this.#deps.general();
    // The images' spares wanted (#440), or null when they could not be read, which leaves the images' spares as they are.
    const wants = this.#deps.imageSpares ? await this.#deps.imageSpares().catch((error) => (this.#deps.logError("image spares", error), null)) : [];
    const wantOf = (spare: BoxRecord) => wants?.find((want) => want.name === spare.image?.name && want.backend === spare.backend && want.kind === spare.kind) ?? null;
    /** Kept spares, by kind, and an image's by image, backend and kind. */
    const slotOf = (spare: { image?: { name: string } | null; backend: string; kind: string }) => (spare.image ? `${spare.image.name}|${spare.backend}|${spare.kind}` : spare.kind);
    const kept = new Map<string, number>();
    for (const spare of await this.list(SPARES)) {
      // Claimed, but this record outlived the move.
      if ((await this.#deps.kv.get<string>(indexKey(spare.id))) !== SPARES) {
        await this.#deps.kv.delete(recordKey(SPARES, spare.id));
        continue;
      }
      if (spare.state === "releasing") continue;
      if (await this.#adoptIfUsed(spare)) continue;
      const slot = slotOf(spare);
      const count = kept.get(slot) ?? 0;
      if (this.#work.has(spare.id) && isActive(spare)) {
        kept.set(slot, count + 1);
        continue;
      }
      if (this.#holdsNothing(spare)) {
        // An image's spare that failed to start: its build is not tried for a spare again for a day (#440).
        if (spare.state === "failed" && spare.image?.from) await this.#spareFailed(spare.image.name, spare.backend, spare.kind, spare.image.from);
        await this.#forget(spare);
        continue;
      }
      // No claim takes these: stopped, unless it waits so, or not enrolled when it should be, as when its machine was removed in BB.
      const failed =
        spare.state === "gone" ||
        (spare.state === "stopped" && !this.#waitsStopped(spare)) ||
        spare.enrol.state === "failed" ||
        (spare.state === "ready" && spare.enrol.state === "off" && !spare.restoredAt && (await this.#enrols(spare)));
      const image = spare.image;
      const want = image ? wantOf(spare) : null;
      // An image's spare is wanted while its build there is current and the image in use, one per backend and kind.
      const stale = !!image && wants !== null && (!want || image.state !== "baked" || image.from !== want.ref);
      const unwanted = image ? wants !== null && (stale || count >= 1) : count >= (general.spares[spare.kind] ?? 0);
      const resized = !sameMachineSize(await this.#size(spare), defaultSize(kindSizes(spare.kind, general.sizes)));
      // A kind's spare from a build of its image that a refresh has replaced since (049): a claim would take the old build.
      const old = !image && !failed && !unwanted && !resized && (await this.#oldBuild(spare));
      const waitedPastRestore = !failed && !unwanted && !resized && !old ? this.#waitedPastRestore(spare) : null;
      if (waitedPastRestore) {
        await this.#release(spare, waitedPastRestore);
        continue;
      }
      if (failed || unwanted || resized || old) {
        // A spare of a build that failed is not made again from it for a day: no loop of making and releasing.
        if (failed && image?.from) await this.#spareFailed(image.name, spare.backend, spare.kind, image.from);
        await this.#release(
          spare,
          failed
            ? `no claim can take it, as it is ${spare.state} and its enrolment ${spare.enrol.state}`
            : stale
              ? `its image ${image!.name} is not in use, or its build on ${spare.backend} is not current`
              : unwanted
                ? `bb-box keeps ${count} spare ${image ? `${image.name} ` : ""}${spare.kind} boxes${image ? ` on ${spare.backend}` : ""}`
                : resized
                  ? "its kind's default size changed"
                  : `its ${spare.kind} image on ${spare.backend} has a newer build`,
        );
        continue;
      }
      kept.set(slot, count + 1);
      // A spare that can wait stopped does, so it holds no memory until a claim starts it (#539). Its BB machine's name then says
      // it is stopped, as BB shows the machine offline.
      if (spare.state === "ready" && this.#waitsStopped(spare) && !this.#work.has(spare.id)) {
        const settling = await this.#spareSettling(spare);
        if (settling.is === "failed") {
          this.#spareSettleFailedAt.set(spare.kind, this.#now());
          this.#spareShortfalls.set(spare.kind, settling.words);
          await this.#release(spare, settling.words);
          continue;
        }
        if (settling.is === "settling") continue;
        const stopped = await this.stop(SPARES, spare.id, undefined, byBbBox("a spare waits stopped until a thread claims it")).catch((error) => {
          this.#deps.logError("stop a spare", error);
          return null;
        });
        if (stopped?.state === "stopped") await this.#deps.renameMachine?.(stopped).catch((error) => this.#deps.logError("rename a spare's machine", error));
      }
    }
    for (const kind of [...this.#spareShortfalls.keys()]) if (!general.spares[kind]) this.#spareShortfalls.delete(kind);
    for (const [kind, wanted] of Object.entries(general.spares)) {
      const settleFailedAt = this.#spareSettleFailedAt.get(kind);
      if (settleFailedAt !== undefined && this.#now() - settleFailedAt < SPARE_SETTLE_RETRY_MS) continue;
      this.#spareSettleFailedAt.delete(kind);
      let count = kept.get(kind) ?? 0;
      if (count >= wanted) this.#spareShortfalls.delete(kind);
      for (; count < wanted && !this.#disposed; count++) {
        try {
          await this.acquire({ threadId: SPARES, projectId: null, kind, who: byBbBox(`bb-box keeps ${wanted} spare ${kind} ${wanted === 1 ? "box" : "boxes"}`) });
          this.#spareShortfalls.delete(kind);
        } catch (error) {
          if (error instanceof BoxError) {
            this.#deps.log?.(`bb-box keeps ${count} of ${wanted} spare ${kind} boxes for now: ${error.message}`);
            this.#spareShortfalls.set(kind, error.message);
          } else this.#deps.logError("spares", error);
          break;
        }
      }
    }
    for (const want of wants ?? []) {
      if (this.#disposed || (kept.get(slotOf({ image: want, backend: want.backend, kind: want.kind })) ?? 0) >= 1) continue;
      const failed = await this.#deps.kv.get<{ ref: string; at: number }>(spareFailedKey(want.name, want.backend, want.kind));
      if (failed && failed.ref === want.ref && this.#now() - failed.at < SPARE_RETRY_MS) continue;
      try {
        const made = await this.acquire({ threadId: SPARES, projectId: null, kind: want.kind, image: want.name, on: want.backend, who: byBbBox(`bb-box keeps a spare of image ${want.name}`) });
        // The build changed as it was made: it would run the script at start, so it goes, and waits a day.
        if (made.image?.state !== "baked" || made.image.from !== want.ref) {
          await this.#spareFailed(want.name, want.backend, want.kind, want.ref);
          await this.#release(made, `it did not start from ${want.name}'s current build on ${want.backend}`);
        }
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        this.#deps.log?.(`bb-box keeps no spare ${want.name} ${want.kind} box on ${want.backend} for now: ${why}`);
        // No room is not a failure of the build: the next upkeep tries again.
        if (!(error instanceof BoxError && error.code === "no_capacity")) await this.#spareFailed(want.name, want.backend, want.kind, want.ref);
      }
    }
  }

  /**
   * Whether a kind's spare comes from a build of its image that is no
   * longer the one its backend starts boxes from, as the backend tells. A
   * backend that cannot tell, or does not answer, keeps the spare. It asks of
   * a spare that is ready or waits stopped, never one starting, stopping or
   * failed; the backend answers without starting the guest.
   */
  async #oldBuild(spare: BoxRecord): Promise<boolean> {
    const backend = this.#deps.backends.get(spare.backend);
    if (!backend?.fromCurrentBuild || !spare.guest || (spare.state !== "ready" && spare.state !== "stopped")) return false;
    const current = await backend.fromCurrentBuild(spare.guest, spare.kind).catch((error) => {
      this.#deps.logError("spares", error);
      return null;
    });
    return current === false;
  }

  /** Remembers that a spare of an image's build failed, so the upkeep makes none from it for a day (#440). */
  async #spareFailed(name: string, backend: string, kind: string, ref: string): Promise<void> {
    await this.#deps.kv.set(spareFailedKey(name, backend, kind), { ref, at: this.#now() });
  }

  /**
   * Makes a spare yours when a thread started on its BB machine from BB's
   * picker (036): it moves to OPERATOR under the spares' lock, as a claim
   * does, its machine drops "(spare)", and the upkeep makes another spare.
   * A stopped one is yours too, not released as failed, and stays stopped
   * until you start it (#156), unless it waited stopped as a spare: the
   * thread waits for its machine, so it starts (#539).
   */
  async #adoptIfUsed(spare: BoxRecord): Promise<boolean> {
    if (!this.#deps.spareThread || (spare.state !== "ready" && spare.state !== "stopped") || spare.enrol.state !== "enrolled" || this.#work.has(spare.id)) return false;
    let threadId: string | null;
    try {
      threadId = await this.#deps.spareThread(spare);
    } catch (error) {
      this.#deps.logError("spares", error);
      return false;
    }
    if (threadId === null) return false;
    const moved = await this.#locked(OPERATOR, () =>
      this.#locked(SPARES, async () => {
        const current = await this.#read(SPARES, spare.id);
        if (!current) return null;
        const taken = new Set((await this.list(OPERATOR)).filter((box) => box.state !== "gone").map((box) => box.name));
        const name = isMachineName(current.name) && !taken.has(current.name) ? current.name : generateName(await this.#liveNames(taken), this.#random);
        const yours: BoxRecord = { ...current, threadId: OPERATOR, projectId: null, name };
        await this.#deps.kv.set(indexKey(yours.id), OPERATOR);
        await this.#write(yours);
        await this.#deps.kv.delete(recordKey(SPARES, yours.id));
        return { box: yours, from: current.name };
      }),
    );
    if (!moved) return false;
    const { box, from } = moved;
    this.#deps.log?.(`Spare box ${box.name} is now yours: thread ${threadId} started on it from BB's picker.`);
    this.#deps.notify(SPARES);
    if (box.state === "stopped" && this.#waitsStopped(box)) {
      void this.#chain(box.id, () => this.#start(box, undefined, false, byBbBox("a thread started on its BB machine from BB's picker"))).then(
        (started) => this.#renamed(started, from),
        (error) => this.#deps.logError("start a spare that is yours", error),
      );
    } else this.#renamed(box, from);
    return true;
  }

  /**
   * After a spare changed owner, and perhaps name (`from` was its name): the
   * backend records them on the guest and names it inside, BB's machine is
   * renamed, and reconnected if BB shows it disconnected and the box is
   * running; a stopped one reconnects when it starts. Commands wait for
   * the guest's new name only when it changed (#128), so a claim's total
   * then counts the relabel too (#186).
   */
  #renamed(box: BoxRecord, from: string): void {
    const backend = this.#deps.backends.get(box.backend);
    if (backend?.relabel && box.guest) {
      const guest = box.guest;
      const renamed = from !== box.name;
      const started = this.#now();
      const relabel = this.#size(box)
        .then((size) => backend.relabel!(guest, identity(box, size), from))
        .then(async () => {
          const ms = this.#now() - started;
          await this.update(box, ({ timings }) => ({
            // A claim's total so far is the claim's, and a waiting spare's resume (#539).
            timings: { ...timings, relabel: ms, ...(renamed && timings.spare !== undefined ? { total: (timings.total ?? timings.spare) + ms } : {}) },
          }));
        })
        .catch((error) => this.#deps.logError("relabel", error));
      if (renamed) this.#waitFor(box.id, relabel);
    }
    const { claimed, reconnect } = this.#deps;
    if (!box.enrol.hostId || !claimed) return;
    void claimed(box).then(
      (disconnected) => {
        // Not while a start's reconnect runs, which commands already wait for.
        if (disconnected && reconnect && box.state === "ready" && !this.#reconnects.has(box.id)) {
          this.#waitFor(box.id, reconnect(box).catch((error) => this.#deps.logError("reconnect", error)));
        }
      },
      (error) => this.#deps.logError("claim", error),
    );
  }

  /** A provider's name for people and for `on` (044): "Proxmox LXC on pve1", "Docker on devpc", "Tart on 2 Macs". */
  /**
   * The room one provider has for one more box of a kind at its default
   * size, as the provider says it, with the boxes still being acquired on
   * it counted, for the provider's profile. Null when it does not offer the
   * kind.
   */
  async room(backendId: string, kindId: string, signal?: AbortSignal, request?: SizeRequest): Promise<Capacity | null> {
    const candidate = this.#deps.backends.kinds().find((offer) => offer.backend.id === backendId && offer.kind.id === kindId);
    if (!candidate) return null;
    const general = await this.#deps.general();
    const sizes = kindSizes(kindId, general.sizes);
    const chosen = request ? chooseSize(kindId, sizes, request) : null;
    if (chosen && !chosen.ok) return null;
    const size = chosen ? chosen.size : defaultSize(sizes);
    return candidate.backend.capacity(kindId, size, await this.#pending(backendId), signal);
  }

  #namedWithDevice(named: Named, device: ModelName, withDevice: readonly OfferedKind[]): Named {
    const offers = named.offers.filter((candidate) => offersModel(candidate.kind.capabilities.device, device));
    if (offers.length) return { ...named, offers };
    const lacking = [...new Set(named.offers.map((candidate) => this.#providerName(candidate.backend)))];
    const having = [...new Set(withDevice.map((candidate) => this.#providerName(candidate.backend)))];
    throw new BoxError("unknown_device", `${listWords(lacking, "and")} ${lacking.length === 1 ? "has" : "have"} no ${device}. The ${device} comes from: ${having.join(", ")}. Leave "on" out for the first with room.`);
  }

  #offeredKinds(backend: Backend): readonly BoxKind[] {
    return this.#deps.backends.offered?.(backend) ?? backend.kinds();
  }

  #providerName(backend: Backend): string {
    return providerName({ label: this.#deps.backends.driverLabel?.(backend.id) ?? backend.label, hosts: backend.hosts ?? [], type: backend.id.split(":")[0]! });
  }

  #takingGpu(offered: OfferedKind[], kind: string, gpu: GpuPart, asked: boolean, forAgent: boolean): OfferedKind[] {
    const taking = offered.filter((candidate) => offersGpuPart(candidate.kind, gpuOnOffer(candidate.kind, gpu, asked)));
    if (taking.length || !offered.length) return taking;
    const providers = [...new Set(offered.map((candidate) => this.#providerName(candidate.backend)))].join(" and ");
    const gives = offered.length === 1 ? "gives" : "give";
    const shared = gpu === "whole" && offered.some((candidate) => offersGpuPart(candidate.kind, "shared"));
    const why = gpu === "none" ? `${kind} boxes from ${providers} always have a GPU` : shared ? `${providers} ${gives} ${kind} boxes a shared GPU, not a whole card` : `${providers} ${gives} ${kind} boxes no GPU`;
    const instead = gpu === "none" ? (kind === "linux-desktop" ? "Ask for linux-desktop-cpu for a desktop drawn by the CPU" : "Leave gpu out") : shared ? "Ask for gpu shared" : asked ? "Ask for gpu none" : `Ask for gpu none, or for another kind`;
    if (forAgent) throw new BoxError("unsupported", `Not made: no provider here gives ${kind} boxes ${gpuPartWords(gpu)}: ${why}. ${instead}, or ask the user. bb-box changed nothing.`);
    throw new BoxError("unsupported", `No provider gives ${kind} boxes ${gpuPartWords(gpu)}: ${why}. ${instead}.`);
  }

  /**
   * The offers `on` names (044): one provider, or a list for the first with
   * room among them. Each name is matched among the active backends by the
   * provider's name, its backend ID or its one host, without case; a name
   * that matches none, or two, or a provider without the kind, refuses the
   * acquire, and so does an empty list. A name given twice counts once.
   * The offers come in acquire order: the list narrows, never reorders. A
   * named provider that is off is passed over, with its reason in `out`,
   * and `ids` holds every provider named.
   */
  #on(on: string | readonly string[], kind: string, offered: OfferedKind[]): Named {
    const names = (typeof on === "string" ? [on] : on).map((name) => name.trim()).filter((name) => name.length);
    const others = offered.map((candidate) => this.#providerName(candidate.backend));
    if (!names.length) {
      throw new BoxError("unknown_provider", `Name a provider in "on", or leave it out for the first with room. ${kind} comes from: ${others.join(", ")}.`);
    }
    const providers = this.#deps.backends.active();
    const chosen = new Map<string, Backend>();
    for (const name of names) {
      // box_list follows a provider's name with what its boxes are, in brackets, which an agent may copy whole.
      const key = foldName(name.replace(/\s*\(.*\)\s*$/s, ""));
      const matched = providers.filter((backend) =>
        providerKeys(backend.id, { label: this.#deps.backends.driverLabel?.(backend.id) ?? backend.label, hosts: backend.hosts ?? [], type: backend.id.split(":")[0]! }).includes(key),
      );
      if (!matched.length) {
        throw new BoxError("unknown_provider", `No provider is called "${name}". ${kind} comes from: ${others.join(", ")}. Leave "on" out for the first with room.`);
      }
      if (matched.length > 1) {
        throw new BoxError("unknown_provider", `"${name}" names ${matched.length} providers: ${matched.map((backend) => backend.id).join(", ")}. Give the ID.`);
      }
      chosen.set(matched[0]!.id, matched[0]!);
    }
    const out: string[] = [];
    const ids = new Set<string>();
    for (const backend of chosen.values()) {
      ids.add(backend.id);
      if (this.#deps.backends.on && !this.#deps.backends.on().some((candidate) => candidate.id === backend.id)) {
        out.push(`${this.#providerName(backend)} is off; turn it on in BB Box's settings.`);
        continue;
      }
      if (!offered.some((candidate) => candidate.backend.id === backend.id)) {
        const has = [...new Set(this.#deps.backends.kinds().filter((candidate) => candidate.backend.id === backend.id).map((candidate) => candidate.kind.id))];
        throw new BoxError(
          "unknown_provider",
          `${this.#providerName(backend)} has no ${kind}${has.length ? `; it has: ${has.join(", ")}` : ""}. ${kind} comes from: ${others.join(", ")}.`,
        );
      }
    }
    return { offers: offered.filter((candidate) => ids.has(candidate.backend.id)), out, ids };
  }

  /**
   * Where the box goes: the first offer with room, freeing a spare's room
   * when none has it. With `on`, only the named offers are tried, and a
   * refusal gives each named provider's reason, then names the kind's
   * other providers (044).
   */
  async #place(
    input: { threadId: string; named: Named | null; forAgent?: boolean; gpuFor?: (kind: BoxKind) => GpuPart },
    offered: OfferedKind[],
    everywhere: OfferedKind[],
    size: BoxSize,
    features: readonly string[],
  ): Promise<OfferedKind> {
    const forAgent = input.forAgent ?? false;
    const gpuFor = input.gpuFor ?? (() => size.gpu);
    const choose = () => (input.threadId === SPARES ? this.#choose(offered, size, features, forAgent, gpuFor, input.threadId) : this.#chooseFreeing(offered, size, features, forAgent, gpuFor, input.threadId));
    if (!input.named) return choose();
    let reasons: string[];
    if (offered.length) {
      try {
        return await choose();
      } catch (error) {
        if (!(error instanceof BoxError) || error.code !== "no_capacity") throw error;
        reasons = [error.message, ...input.named.out];
      }
    } else {
      reasons = input.named.out;
    }
    const kind = everywhere[0]!.kind.id;
    const others = everywhere.filter((candidate) => !input.named!.ids.has(candidate.backend.id)).map((candidate) => this.#providerName(candidate.backend));
    throw new BoxError("no_capacity", `${reasons.join(" ")}${others.length ? ` ${kind} also comes from ${others.join(", ")}.` : ""} Leave "on" out for the first with room.`);
  }

  /** The first backend with room for a box of the kind and size, and still the features asked for, or the reasons none has. */
  async #choose(offered: OfferedKind[], size: BoxSize, features: readonly string[], forAgent = false, gpuFor: (kind: BoxKind) => GpuPart = () => size.gpu, threadId: string | null = null): Promise<OfferedKind> {
    const reasons: string[] = [];
    const full: string[] = [];
    let lacking = 0;
    for (const candidate of offered) {
      const pending = await this.#pending(candidate.backend.id);
      try {
        const capacity = await candidate.backend.capacity(candidate.kind.id, { ...size, gpu: gpuFor(candidate.kind) }, pending, undefined, threadId === null ? undefined : { threadId });
        if (!capacity.ok) {
          reasons.push((forAgent ? capacity.agentMessage : null) ?? capacity.message ?? `${candidate.backend.label} has no room.`);
          full.push(candidate.backend.id);
          continue;
        }
        // Checking room can show a backend lacks what it offered, as a rootless Docker host lacks Docker (041).
        const kind = this.#offeredKinds(candidate.backend).find((other) => other.id === candidate.kind.id) ?? candidate.kind;
        const missing = features.filter((feature) => !kind.capabilities.features.includes(feature));
        if (!missing.length) return { ...candidate, kind };
        lacking++;
        reasons.push(`${candidate.kind.id} boxes from ${candidate.backend.label} have no ${missing.map(featureWord).join(" or ")}.`);
      } catch (error) {
        this.#deps.logError("capacity", error);
        reasons.push(describeError(error, `Checking room on ${candidate.backend.label}`));
      }
    }
    // No room makes a box wait; a feature no offer has is no matter of room.
    if (lacking === offered.length) {
      throw new Unplaced("unknown_kind", `${reasons.join(" ")} Ask for ${offered[0]!.kind.id} if the box can do without it.`, full);
    }
    throw new Unplaced("no_capacity", reasons.join(" "), full);
  }

  /**
   * #choose for a thread's box. When no backend has room, a spare of a
   * backend that had none gives its room back and the choice is made once
   * more: on a Mac a spare holds one of its two VM slots (#120).
   */
  async #chooseFreeing(offered: OfferedKind[], size: BoxSize, features: readonly string[], forAgent = false, gpuFor: (kind: BoxKind) => GpuPart = () => size.gpu, threadId: string | null = null): Promise<OfferedKind> {
    try {
      return await this.#choose(offered, size, features, forAgent, gpuFor, threadId);
    } catch (error) {
      if (!(error instanceof Unplaced)) throw error;
      const spares = (await this.list(SPARES)).filter((spare) => spare.state !== "releasing" && !this.#holdsNothing(spare));
      const spare = error.full.map((backend) => spares.find((spare) => spare.backend === backend)).find((spare) => !!spare);
      if (!spare) throw error;
      if (await this.#release(spare, `a thread's ${offered[0]!.kind.id} box needs its room`)) throw error;
      return this.#choose(offered, size, features, forAgent, gpuFor, threadId);
    }
  }

  /** The size a box was asked to be. One recorded before sizes was made at the default preset. */
  async #size(box: BoxRecord): Promise<BoxSize> {
    return withGpu(box.size ?? defaultSize(kindSizes(box.kind, (await this.#deps.general()).sizes)), recordedGpu(box));
  }

  #startAcquire(box: BoxRecord): void {
    if (this.#acquiring.has(box.id) || this.#disposed) return;
    const controller = new AbortController();
    this.#acquiring.set(box.id, controller);
    void this.#chain(box.id, () => this.#acquire(box, controller.signal))
      .catch((error) => this.#deps.logError("acquire", error))
      .finally(() => {
        this.#acquiring.delete(box.id);
        if (box.fork && !this.#disposed) void this.#forkSettled(box);
      });
  }

  async #forkSettled(box: BoxRecord): Promise<void> {
    try {
      const current = await this.#read(box.threadId, box.id);
      if (current && !isAcquiring(current)) this.#deps.forked?.(current);
    } catch (error) {
      this.#deps.logError("fork", error);
    }
  }

  async #forkGuest(box: BoxRecord, backend: Backend, hooks: AcquireHooks, timings: Record<string, number>, signal: AbortSignal): Promise<Guest> {
    const fork = box.fork!;
    if (!backend.forkSnapshot || !backend.armFork || !backend.start || !backend.guestIdentity) throw new BoxError("unsupported", `${box.backendLabel} forks no snapshots.`);
    const forkSnapshot = backend.forkSnapshot.bind(backend);
    if (backend.placeForkGpu) await backend.placeForkGpu(identity(box, await this.#size(box)), recordedGpu(box), signal);
    const size = await this.#size(box);
    const made = await this.#chain(fork.source.id, () => forkSnapshot({ id: fork.snapshot.id, ref: fork.snapshot.ref, guest: fork.snapshot.livesOn, ...(fork.snapshot.from ? { from: fork.snapshot.from } : {}) }, identity(box, size), box.guest, hooks, signal));
    await hooks.claim(made);
    await this.#deps.forkHold?.(box, signal);
    await backend.armFork(made, "network", signal);
    await hooks.starting();
    const booting = this.#now();
    let started: Started | void = undefined;
    if (backend.startForForkCheck) await backend.startForForkCheck(made, signal, hooks.timing);
    else started = await backend.start(made, signal, hooks.timing, undefined, FORK_START_WAIT_MS);
    timings.start = this.#now() - booting;
    const running = startedGuest(made, started);
    await this.#chain(fork.source.id, async () => {
      await this.#checkFork(box, running, backend, timings, signal);
      await backend.armFork!(running, "boot", signal);
    });
    return running;
  }

  async #forkFailed(box: BoxRecord, backend: Backend, error: unknown, timings: Record<string, number>): Promise<void> {
    backend.clearForkGpu?.(box.id);
    const left = (await this.#read(box.threadId, box.id))?.guest ?? null;
    let cleanup: string | null = null;
    let stopped = false;
    if (left) {
      await backend.disarmFork?.(left).catch((cause) => this.#deps.logError(`disarm guest ${left.ref} of fork ${box.name} before deleting it`, cause));
      try {
        await backend.release(left, QUIET);
      } catch (cause) {
        cleanup = cause instanceof Error ? cause.message : String(cause);
        stopped = backend.powerOff ? await backend.powerOff(left).then(() => true, () => false) : false;
        this.#deps.logError(`delete guest ${left.ref} of fork ${box.name}`, cause);
      }
    }
    const why = sentenceOf(describeError(error, "Forking the box"));
    const agentWhy = sentenceOf(describeErrorForAgent(error, "Forking the box"));
    const after = cleanup === null ? forkReleasedWords(box) : forkCleanupWords(left!.ref, cleanup, stopped);
    const next = await this.update(box, (current) => {
      if (current.state === "releasing") return cleanup === null ? { guest: null } : {};
      return {
        state: "failed",
        guest: cleanup === null ? null : current.guest,
        error: `${why} ${after}`,
        agentError: { of: `${why} ${after}`, words: `${agentWhy} ${after}` },
        forkFailure: why,
        agentForkFailure: agentWhy,
        timings: { ...timings },
        waitingOn: null,
      };
    });
    if (next?.state === "failed") this.#deps.logError("fork", error);
  }

  async #retryForkCleanup(box: BoxRecord): Promise<void> {
    const current = await this.#read(box.threadId, box.id);
    if (!current || current.state !== "failed" || !current.fork || !current.guest) return;
    const backend = this.#deps.backends.get(current.backend);
    if (!backend) return;
    const guest = current.guest;
    await backend.disarmFork?.(guest).catch((error) => this.#deps.log?.(`Could not disarm guest ${guest.ref} of fork ${current.name} before deleting it: ${describeError(error, "Disarming it")}`));
    try {
      await backend.release(guest, QUIET);
    } catch (error) {
      this.#deps.log?.(`Could not delete guest ${guest.ref} of fork ${current.name} yet: ${describeError(error, "Deleting it")} bb-box tries again at its next sweep.`);
      return;
    }
    const updated = await this.update(current, (latest) => {
      if (latest.guest?.ref !== guest.ref) return {};
      const error = `${latest.forkFailure ?? "The fork failed."} ${forkReleasedWords(latest)}`;
      return { guest: null, error, agentError: { of: error, words: `${latest.agentForkFailure ?? latest.forkFailure ?? "The fork failed."} ${forkReleasedWords(latest)}` } };
    });
    this.#deps.log?.(`Deleted guest ${guest.ref} of fork ${current.name}, which bb-box could not delete when the fork failed.`);
    if (updated) this.#deps.forked?.(updated);
  }

  async #checkFork(box: BoxRecord, guest: Guest, backend: Backend, timings: Record<string, number>, signal: AbortSignal): Promise<void> {
    const fork = box.fork!;
    const began = this.#now();
    const command = backend.forkCheckCommand ? await backend.forkCheckCommand(guest, signal) : (await backend.transports(guest, box.kind)).command;
    if (!command) throw new BoxError("unsupported", `bb-box cannot run commands in fork ${box.name}, so it cannot check that it gave up ${fork.source.name}'s identity.`);
    const own = await backend.guestIdentity!(guest, signal);
    const byEndpoint = backend.addressIsAnEndpoint === true;
    const expectedNow = async () => ({
      forkMacs: Object.values(own.macs),
      forkValue: own.value ?? null,
      sourceMacs: fork.source.macs,
      sourceBox: fork.source.id,
      sourceName: fork.source.name,
      ...(byEndpoint ? { sourceAddresses: [], freedSourceAddresses: [] } : await this.#sourceAddresses(box, backend, signal)),
      ownAddress: byEndpoint ? null : guest.address,
      boxAddresses: backend.boxAddresses?.() ?? [],
      held: fork.snapshot.identity,
      safeFrom: backend.snapshotting?.(box.kind)?.forkSafeFrom ?? 1,
    });
    const waitMs = this.#deps.forkWaitMs ?? FORK_WAIT_MS;
    for (let look = 1; ; look++) {
      const seen = await readForkSeen(command, signal, box.capabilities.os === "macos" ? "macos" : "linux");
      const verdict = forkVerdict(seen, await expectedNow());
      if (verdict.is === "ready") break;
      if (verdict.is === "refused" || look >= FORK_LOOKS) {
        const waited = verdict.is === "wait" ? ` after ${Math.round(waitMs / 1000)} s` : "";
        throw new BoxError("failed", `bb-box did not hand fork ${box.name} over${waited}: ${verdict.why}.`);
      }
      await new Promise((resolve) => setTimeout(resolve, waitMs / FORK_LOOKS));
      signal.throwIfAborted();
    }
    timings.check = this.#now() - began;
  }

  async #sourceAddresses(box: BoxRecord, backend: Backend, signal: AbortSignal): Promise<{ readonly sourceAddresses: readonly string[]; readonly freedSourceAddresses: readonly string[] }> {
    const fork = box.fork!;
    const asked = fork.source.address ?? null;
    if (!backend.leasedAddressNow) return { sourceAddresses: asked ? [asked] : [], freedSourceAddresses: [] };
    const source = await this.#read(fork.source.threadId, fork.source.id);
    const recorded = distinctAddresses([asked, source?.guest?.address ?? null]);
    if (!source?.guest) return { sourceAddresses: [], freedSourceAddresses: recorded };
    let now: LeasedAddressNow;
    try {
      now = await backend.leasedAddressNow(source.guest, signal);
    } catch (error) {
      signal.throwIfAborted();
      throw new BoxError("failed", `bb-box did not hand fork ${box.name} over: it could not read the address ${fork.source.name} holds now, so it cannot tell that the fork does not take it: ${sentenceOf(describeError(error, "Reading it"))}`);
    }
    if (now.power === "stopped" || now.power === "gone") return { sourceAddresses: [], freedSourceAddresses: recorded };
    return { sourceAddresses: distinctAddresses([now.leased, ...recorded]), freedSourceAddresses: [] };
  }

  async #acquire(initial: BoxRecord, signal: AbortSignal): Promise<void> {
    let box = (await this.#read(initial.threadId, initial.id)) ?? initial;
    if (!isAcquiring(box)) return;
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) {
      // The backend was switched off or its settings broke. The claim stays
      // recorded, and the sweep carries on when the backend is back.
      await this.update(box, () => this.#backendOff(box));
      return;
    }
    const timings: Record<string, number> = { ...box.timings };
    const released = () => new BoxError("released", `Box ${box.name} was released while it was being acquired.`);
    const hooks: AcquireHooks = {
      claim: async (guest) => {
        // Recorded even when a release is waiting, so the release finds it.
        const next = await this.update(box, (current) => placed(current, guest));
        if (!next) throw released();
        box = next;
        if (next.state === "releasing") throw released();
      },
      starting: async () => {
        const next = await this.update(box, (current) =>
          current.state === "releasing" ? {} : { state: "starting", timings: { ...timings } },
        );
        if (!next || next.state === "releasing") throw released();
        box = next;
      },
      timing: (step, ms) => {
        timings[step] = ms;
      },
      waiting: async (words) => {
        const next = await this.update(box, (current) => (current.state === "releasing" ? {} : { waitingOn: words }));
        if (next) box = next;
      },
    };
    let guest: Guest;
    try {
      guest = box.fork ? await this.#forkGuest(box, backend, hooks, timings, signal) : await backend.acquire(identity(box, await this.#size(box)), box.guest, hooks, signal);
    } catch (error) {
      if (box.fork) {
        if (!this.#disposed) await this.#forkFailed(box, backend, error, timings);
        return;
      }
      // The backend released whatever it claimed before it threw.
      const next = await this.update(box, (current) => {
        if (this.#disposed && current.state !== "releasing" && placedOnSharedHost(current)) return {};
        if (current.state === "releasing" || this.#disposed) return { guest: null };
        const said = describeError(error, "Acquiring the box");
        const agentWords = agentMessageOf(error) === null ? null : { of: said, words: describeErrorForAgent(error, "Acquiring the box") };
        return { state: "failed", guest: null, error: said, agentError: agentWords, timings: { ...timings }, waitingOn: null };
      });
      if (next?.state === "failed") this.#deps.logError("acquire", error);
      return;
    }
    // The project's image's script (049), as root, before the box is handed over. A failure releases the box.
    if (box.image && box.image.state !== "done" && box.image.state !== "baked") {
      try {
        await this.#runImage(box, guest, backend, timings, signal);
      } catch (error) {
        await this.update(box, (current) => ({ image: current.image ? { ...current.image, state: "failed" as const } : null }));
        await backend.release(guest, QUIET).catch((cause) => this.#deps.logError("release", cause));
        const next = await this.update(box, (current) => {
          if (current.state === "releasing" || this.#disposed) return { guest: null };
          return { state: "failed", guest: null, error: describeError(error, `Running ${box.image!.name}'s script`), timings: { ...timings } };
        });
        if (next?.state === "failed") this.#deps.logError("acquire", error);
        return;
      }
      box = (await this.#read(box.threadId, box.id)) ?? box;
    }
    await this.#markIdentity(box, guest, backend, timings, signal);
    const now = this.#now();
    const next = await this.update(box, (current) =>
      current.state === "releasing"
        ? placed(current, guest)
        : { ...placed(current, guest), state: "ready", readyAt: now, error: null, timings: { ...timings, total: now - current.createdAt }, waitingOn: null },
    );
    if (next?.state === "ready") {
      this.#event(next, "ready", UNKNOWN_ACTOR, { at: now });
      void this.#recordReady(next).catch((error) => this.#deps.logError("ready history", error));
    }
    // A spare's own start is not a use of its image: a claim is (#440).
    if (next?.state === "ready" && next.image && next.threadId !== SPARES) this.#deps.imageReady?.(next);
    if (!next) {
      await backend.release(guest, QUIET).catch((error) => this.#deps.logError("release", error));
      return;
    }
    // A release waiting behind this task releases the guest next.
    if (next.state !== "ready") return;
    await this.#enrol(await this.#readUserspaceOrLog(next, signal, true));
  }

  /**
   * Runs the box's project's image's script as root, with BB_BOX_IMAGE,
   * BB_BOX_KIND, BB_BOX_BACKEND and BB_BOX_ARCH, then its check as the box
   * user (049). Throws with the output's last lines when either fails. An
   * image removed since the box was asked for runs nothing.
   */
  async #runImage(box: BoxRecord, guest: Guest, backend: Backend, timings: Record<string, number>, signal: AbortSignal): Promise<void> {
    const found = box.image ? this.#deps.image?.(box.projectId, box.kind, box.image.name) : null;
    if (!found || found.name !== box.image?.name) {
      await this.update(box, () => ({ image: null }));
      return;
    }
    const { name, image } = found;
    const started = this.#now();
    await this.update(box, (current) => ({ image: { name, state: "running" as const } }));
    const command = (await backend.transports(guest, box.kind)).command;
    if (!command) throw new BoxError("unsupported", `A ${box.kindLabel} box takes no commands, so it cannot run ${name}'s script.`);
    const text = new TextEncoder();
    await command.writeFile(`${IMAGE_DIR}/setup.sh`, text.encode(image.script), { mode: "0700", signal });
    if (image.check) await command.writeFile(`${IMAGE_DIR}/check.sh`, text.encode(image.check), { mode: "0700", signal });
    const tools = Object.entries(this.#deps.imageTools ?? {});
    for (const [tool, body] of tools) await command.writeFile(`${IMAGE_DIR}/bin/${tool}`, text.encode(body), { mode: "0755", signal });
    const path = tools.length ? `PATH="$HOME/${IMAGE_DIR}/bin:$PATH" ` : "";
    const env = Object.entries({ BB_BOX_IMAGE: name, BB_BOX_KIND: box.kind, BB_BOX_BACKEND: backend.id, BB_BOX_ARCH: box.capabilities.arch })
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ");
    const failed = (what: string, ran: RunResult, limitMs: number) => {
      const lines = ran.stdout.trimEnd().split("\n").slice(-IMAGE_LINES).join("\n");
      return new Error(`${name}'s ${what} ${ran.timedOut ? `ran out of time after ${limitMs / 60_000} minutes` : `exited with ${ran.exitCode}`}. Its last lines:\n${lines}`);
    };
    const ran = await command.run(`sudo -n env ${path}${env} bash "$HOME/${IMAGE_DIR}/setup.sh" 2>&1`, { timeoutMs: IMAGE_SCRIPT_MS, signal, maxOutputBytes: 256 * 1024 });
    if (ran.exitCode !== 0) throw failed("script", ran, IMAGE_SCRIPT_MS);
    if (image.check) {
      // With the PATH and variables the script set, which a session on a shared connection has not read yet.
      const checked = await command.run(`${LOAD_ENVIRONMENT} env ${env} bash "$HOME/${IMAGE_DIR}/check.sh" 2>&1`, { timeoutMs: IMAGE_CHECK_MS, signal, maxOutputBytes: 256 * 1024 });
      if (checked.exitCode !== 0) throw failed("check", checked, IMAGE_CHECK_MS);
    }
    await command.run(`rm -rf "$HOME/${IMAGE_DIR}"`, { timeoutMs: 30_000, signal }).catch(() => undefined);
    const ms = this.#now() - started;
    timings.image = ms;
    await this.update(box, () => ({ image: { name, state: "done" as const, seconds: Math.round(ms / 1000) } }));
  }

  async #markIdentity(box: BoxRecord, guest: Guest, backend: Backend, timings: Record<string, number>, signal: AbortSignal): Promise<void> {
    const source = forksOn(box.capabilities.os) ? (backend.identitySource?.(box.kind) ?? null) : null;
    if (!source || !(await this.#deps.general()).identityResetBackends?.includes(backend.id)) return;
    const started = this.#now();
    try {
      const command = (await backend.transports(guest, box.kind)).command;
      if (!command) return;
      const written = await writeIdentityMarker(command, box.id, source, signal);
      timings.identity = this.#now() - started;
      if (written.written) await this.update(box, () => ({ identityMarkedAt: this.#now() }));
      else this.#deps.log?.(`Wrote no identity marker in box ${box.name}, so a copy of it would not reset, and its snapshots cannot be forked: ${written.why}.`);
    } catch (error) {
      if (!signal.aborted) this.#deps.logError("identity marker", error);
    }
  }

  async #markIdentityAgain(box: BoxRecord, signal?: AbortSignal): Promise<void> {
    const backend = this.#deps.backends.get(box.backend);
    if (!box.identityMarkedAt || !box.guest || !backend || backend.identitySource?.(box.kind) !== "value") return;
    if (!(await this.#deps.general()).identityResetBackends?.includes(backend.id)) return;
    try {
      const command = (await backend.transports(box.guest, box.kind)).command;
      if (!command) return;
      const read = await command.run(identityStatusScript(), { timeoutMs: FORK_SAFE_PROBE_MS, maxOutputBytes: 4096, ...(signal ? { signal } : {}) });
      const status = read.exitCode === 0 ? parseIdentityStatus(read.stdout) : null;
      if (!status?.enabled || status.pending || status.armed || status.marker !== "missing" || status.boot !== "reset") return;
      const written = await writeIdentityMarker(command, box.id, "value", signal);
      this.#deps.log?.(
        written.written
          ? `Wrote box ${box.name}'s identity marker again: a reset had left it none, as it found no value to write one with.`
          : `Could not write box ${box.name}'s identity marker again, so a copy of it would not reset, and its snapshots cannot be forked: ${written.why}.`,
      );
    } catch (error) {
      if (!signal?.aborted) this.#deps.logError("identity marker", error);
    }
  }

  /** Starts enrolling a ready box as a BB machine, when it can enrol. */
  async #enrol(box: BoxRecord, options: { restored?: boolean } = {}): Promise<void> {
    if (!(await this.#enrols(box))) return;
    const enrolling = await this.update(box, (current) => ({
      enrol: { state: "enrolling", hostId: null, error: null },
      joinTries: null,
      ...(current.restoredAt ? { restoredAt: null } : {}),
    }));
    if (enrolling) {
      void this.#deps.enrol!(enrolling, options)
        .catch((error) => this.#deps.logError("enrol", error))
        .then(async () => {
          // A spare that can wait stopped does so as soon as it is a BB machine (#539). Any other waits for the next upkeep.
          if (enrolling.threadId !== SPARES || this.#disposed) return;
          const now = await this.#read(SPARES, enrolling.id);
          if (now?.state === "ready" && this.#waitsStopped(now)) void this.keepSpares();
        })
        .catch((error) => {
          if (!this.#disposed) this.#deps.logError("spares", error);
        });
    }
  }

  /** Whether a box can enrol as a BB machine: its kind can and bb-box enrols boxes. */
  /** A thread's own box (role "machine") is enrolled by the machine provider that made it, with the thread's key. */
  async enrols(box: BoxRecord): Promise<boolean> {
    return this.#enrols(box);
  }

  async #enrols(box: BoxRecord): Promise<boolean> {
    // Your machines are BB machines whatever the general setting says (036).
    return box.role !== "machine" && box.capabilities.enrol && !!this.#deps.enrol && (box.threadId === OPERATOR || (await this.#deps.general()).enrol);
  }

  #backendOff(box: BoxRecord): { readonly error: string; readonly agentError: { readonly of: string; readonly words: string } } {
    const error = `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, or its settings need fixing. Fix them in bb-box's settings.`;
    return { error, agentError: { of: error, words: `The ${box.backendLabel} backend that holds box ${box.name} is not in bb-box's settings, or its settings need fixing, so ask the user. The box stays as it is until the backend is back.` } };
  }

  #backend(box: BoxRecord): Backend {
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) {
      const off = this.#backendOff(box);
      throw new BoxError("backend_off", off.error, off.agentError.words);
    }
    return backend;
  }

  /** Waits until the box's tasks in this process settle, then returns it. */
  async settled(box: Pick<BoxRecord, "threadId" | "id">): Promise<BoxRecord | null> {
    while (this.#work.has(box.id)) await this.#work.get(box.id);
    return this.#read(box.threadId, box.id);
  }

  /** Waits for every task in this process. */
  async idle(): Promise<void> {
    while (this.#work.size) await Promise.all(this.#work.values());
  }

  /**
   * Releases a box: its BB machine is removed, then the backend deletes the
   * guest or resets and returns the machine. Resolves when that is done, with
   * null, or with the box still releasing and the error when it failed; the
   * sweep then tries again. A spare released this way is replaced then, not
   * at the next sweep (#129). `why` says who asked, for the log.
   */
  async release(threadId: string, ref: string, why: string, who?: Actor): Promise<BoxRecord | null> {
    const box = await this.get(threadId, ref);
    const left = await this.#release(box, why, who);
    if (box.threadId === SPARES) void this.keepSpares();
    return left;
  }

  /** Every release starts here, and logs why: who asked, or what bb-box needed. */
  async #release(box: BoxRecord, why: string, who: Actor = byBbBox(why)): Promise<BoxRecord | null> {
    this.#resizing.get(box.id)?.abort(new BoxError("released", `Box ${box.name} was released.`));
    this.#updating.get(box.id)?.abort(new BoxError("released", `Box ${box.name} was released.`));
    const marked = await this.update(box, (current) => ({
      state: "releasing",
      releaseRequestedAt: current.releaseRequestedAt ?? this.#now(),
    }));
    if (!marked) return null;
    this.#deps.log?.(`Releasing ${describeBox(box)}: ${why}.`);
    this.#event(marked, "release-asked", who, { backend: marked.backendLabel, state: box.state });
    this.#acquiring.get(box.id)?.abort(new BoxError("released", `Box ${box.name} was released.`));
    return this.#chain(box.id, () => this.#finishRelease(marked, who));
  }

  #failedAgain(box: BoxRecord, operation: readonly BoxEventKind[], words: string): boolean {
    const last = this.#deps.events?.latest(box.id, operation);
    return last?.kind === operation[2] && last.words === utf8Prefix(words, EVENT_WORDS_BYTES);
  }

  async #finishRelease(initial: BoxRecord, asked?: Actor, options: { readonly observeFirst?: boolean } = {}): Promise<BoxRecord | null> {
    const box = await this.#read(initial.threadId, initial.id);
    if (!box) return null;
    const who = asked ?? this.#deps.events?.latest(box.id, ["release-asked"])?.by ?? UNKNOWN_ACTOR;
    const kinds = ["release-asked", "released", "release-failed"] as const;
    const failed = (words: string, observed: Observation | null) => {
      if (!this.#failedAgain(box, kinds, words)) this.#event(box, "release-failed", who, { words, observed, backend: box.backendLabel });
    };
    const backend = box.guest ? this.#deps.backends.get(box.backend) : null;
    const guestGone = options.observeFirst && box.guest && backend ? (await this.#stamped(box).then((stamped) => backend.power(stamped.guest!)).catch(() => undefined)) === null : false;
    if (!guestGone && box.guest && backend && this.#deps.beforeRelease) {
      try {
        await this.#deps.beforeRelease(box, who);
      } catch (error) {
        const words = `Release did not finish: ${sentenceOf(describeError(error, "Copying its kept snapshots"))}`;
        failed(words, null);
        const next = error instanceof ReleaseWaits ? "bb-box tries again in a few minutes." : `bb-box tries again in a few minutes. ${RELEASE_OR_DELETE_KEPT}`;
        return this.update(box, () => ({ error: `${words} ${next}` }));
      }
    }
    // A thread's own box (role "machine") has a BB machine that BB owns and removes itself; deleting it
    // from here would wait on BB's removal, which waits on this release.
    if (box.enrol.hostId && this.#deps.unenrol && box.role !== "machine") {
      try {
        await this.#deps.unenrol(box);
      } catch (error) {
        // The machine stays in BB as offline; releasing the box matters more.
        this.#deps.logError("unenrol", error);
      }
    }
    if (guestGone) {
      this.#deps.log?.(`${describeBox(box)}: its guest is gone, so its release, which a restart of bb-box interrupted, is done.`);
      this.#event(box, "released", who, { backend: box.backendLabel, words: "bb-box found its guest gone after a restart." });
      await this.#forget(box);
      return null;
    }
    if (box.guest) {
      if (!backend) {
        const off = this.#backendOff(box);
        failed(off.error, null);
        return this.update(box, () => off);
      }
      const timings: Record<string, number> = {};
      const hooks: ReleaseHooks = {
        resetting: async () => {
          await this.update(box, (current) => ({ resetAt: current.resetAt ?? this.#now() }));
        },
        timing: (step, ms) => {
          timings[`release.${step}`] = ms;
        },
      };
      try {
        const { guest } = await this.#stamped(box);
        if (box.fork) await backend.disarmFork?.(guest!).catch((error) => this.#deps.logError(`disarm guest ${guest!.ref} of fork ${box.name} before deleting it`, error));
        await backend.release(guest!, hooks);
      } catch (error) {
        this.#deps.logError("release", error);
        const power = await backend.power(box.guest).catch(() => undefined);
        failed(describeError(error, "Releasing the box"), { state: observedState(power), at: this.#now(), from: box.backendLabel });
        return this.update(box, (current) => ({
          error: `${sentence(describeError(error, "Releasing the box"))} bb-box tries again in a few minutes.`,
          timings: { ...current.timings, ...timings },
        }));
      }
    }
    this.#event(box, "released", who, { backend: box.backendLabel });
    await this.#forget(box);
    return null;
  }

  async forget(threadId: string, ref: string, who: Actor = UNKNOWN_ACTOR): Promise<void> {
    const box = await this.get(threadId, ref);
    if (this.#deps.backends.get(box.backend)) throw forgetRefusal(box);
    await this.#chain(box.id, async () => {
      const current = await this.#read(box.threadId, box.id);
      if (!current) return;
      this.#acquiring.get(current.id)?.abort(new BoxError("released", `Box ${current.name} was forgotten.`));
      this.#event(current, "forgotten", who, { backend: current.backendLabel, state: current.state });
      await this.#forget(current, "forgotten");
      this.#deps.log?.(`Forgot ${describeBox(current)}: bb-box removed its record. Nothing was deleted: its guest on ${current.backendLabel}, if it still runs, keeps running.`);
    });
  }

  /**
   * Releases every box of a thread that BB said was archived or deleted.
   * Resolves with how many it released. BB is asked again first, and the
   * boxes go now only when it returns the thread archived or deleted. When it
   * finds no such thread, the next sweep releases them if it still finds
   * none; while it says the thread is live, or cannot say, they stay.
   */
  async releaseThread(threadId: string, ended: "archived" | "deleted"): Promise<number> {
    const boxes = await this.list(threadId);
    if (!boxes.length) return 0;
    const { state, said } = await this.#ask(threadId);
    if (state !== "ended") {
      // BB's answer now counts as its first for the next sweep.
      if (state === "missing") this.#ending.add(threadId);
      const now =
        state === "live" ? "says now that it is live" :
        state === "missing" ? "finds no such thread now, and the next sweep releases them if BB still finds none" :
        "cannot say now whether it ended, and the sweep decides";
      this.#deps.log?.(`Kept the boxes of thread ${threadId}: BB said it was ${ended}, but ${now}. BB's answer: ${said}.`);
      return 0;
    }
    let count = 0;
    for (const box of boxes) {
      try {
        if (this.#holdsNothing(box)) await this.#forget(box);
        else if ((await this.#release(box, `its thread was ${ended}. BB's answer: ${said}`)) === null) count++;
      } catch (error) {
        this.#deps.logError("release", error);
      }
    }
    return count;
  }

  /** BB's answer for a thread; an error asking it is no answer. */
  #ask(threadId: string): Promise<ThreadAnswer> {
    return this.#deps.thread(threadId).catch((error: unknown) => ({ state: "unknown" as const, said: describeError(error, "Asking BB") }));
  }

  /** A failed box with no guest: nothing to release, only the record to forget. */
  #holdsNothing(box: BoxRecord): boolean {
    return !box.guest && !isAcquiring(box) && box.state !== "releasing" && !this.#work.has(box.id);
  }

  /** Whether the box's backend can stop and start it. The panel and tools offer stop and start only then. */
  canStopStart(box: BoxRecord): boolean {
    if (inSlot(box)) return false;
    const backend = this.#deps.backends.get(box.backend);
    return !!(backend?.stop && backend.start);
  }

  #stopStart(box: BoxRecord, hostRestart = false): { stop: NonNullable<Backend["stop"]>; start: NonNullable<Backend["start"]> } {
    if (inSlot(box) && !hostRestart) throw new BoxError("unsupported", stopRefusal(box.kind));
    const backend = this.#backend(box);
    if (!backend.stop || !backend.start) {
      throw new BoxError("unsupported", `${box.backendLabel} cannot stop and start its boxes, so box ${box.name} keeps running until it is released.`);
    }
    return { stop: backend.stop.bind(backend), start: backend.start.bind(backend) };
  }

  /** Stops a box to free memory while keeping its disk. */
  async stop(threadId: string, ref: string, signal?: AbortSignal, who: Actor = UNKNOWN_ACTOR): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, () => this.#stop(box, signal, who));
  }

  async #stop(box: BoxRecord, signal?: AbortSignal, who: Actor = UNKNOWN_ACTOR): Promise<BoxRecord> {
    const current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, signal);
    const { stop } = this.#stopStart(current);
    if (current.state === "stopped") return current;
    this.#require(current, "ready");
    const reading = await this.#forkSafetyAtStop(current, signal);
    this.#require((await this.#move(current, "stopping")) ?? { ...current, state: "releasing" }, "stopping");
    this.#event(current, "stop-asked", who);
    try {
      await stop(current.guest!, signal);
    } catch (error) {
      const observation = await this.#observedAfterFailure(current, signal, true);
      this.#event(current, "stop-failed", who, { words: describeError(error, "Stopping the box"), observed: observation });
      if (observation.state === "stopped") this.#event(current, "stopped", who, { at: observation.at, words: "bb-box found it stopped after its stop failed." });
      throw error;
    }
    const kept = reading ? await this.#keptAtStop(current, reading, signal) : null;
    const stopped = (await this.#move(current, "stopped", undefined, undefined, kept ? { stopForkSafety: kept } : {})) ?? current;
    this.#event(current, "stopped", who);
    return stopped;
  }

  async #keptAtStop(box: BoxRecord, reading: ForkSafety, signal?: AbortSignal): Promise<StoppedForkSafety | null> {
    const backend = this.#deps.backends.get(box.backend);
    if (!backend?.stoppedMark || !box.guest) return null;
    try {
      const mark = await backend.stoppedMark(box.guest, signal);
      return mark ? { ...reading, mark } : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#deps.log?.(`Could not mark box ${box.name}'s guest as bb-box stopped it, so a snapshot of it taken while it is stopped is not fork-safe: ${describeError(error, "Marking it")}`);
      return null;
    }
  }

  async #forkSafetyAtStop(box: BoxRecord, signal?: AbortSignal): Promise<ForkSafety | null> {
    const backend = this.#deps.backends.get(box.backend);
    const system = box.capabilities.os;
    if (!backend || !box.guest || (system !== "linux" && system !== "macos") || !readsForkSafetyAtStop(backend.snapshotting?.(box.kind))) return null;
    try {
      const command = (await backend.transports(box.guest, box.kind)).command;
      const read = command ? await readForkSafe(command, signal, backend.identitySource?.(box.kind) ?? null, system) : null;
      return read && (read.version !== null || read.resetOff) ? read : null;
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#deps.log?.(`Could not read box ${box.name}'s identity reset before its stop, so a snapshot of it taken while it is stopped is not fork-safe: ${describeError(error, "Reading it")}`);
      return null;
    }
  }

  /**
   * Starts a stopped box, waits until its command transport answers, and
   * reconnects its BB machine, or enrols it when the sweep restored it.
   */
  async start(threadId: string, ref: string, signal?: AbortSignal, who: Actor = UNKNOWN_ACTOR): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    return this.#chain(box.id, () => this.#start(box, signal, false, who));
  }

  /** start(), in the box's chain. */
  async #start(box: BoxRecord, signal?: AbortSignal, hostRestart = false, who: Actor = UNKNOWN_ACTOR): Promise<BoxRecord> {
    const current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, signal);
    const { start } = this.#stopStart(current, hostRestart);
    if (current.state === "ready") return current;
    this.#require(current, "stopped");
    this.#require((await this.#move(current, "starting")) ?? { ...current, state: "releasing" }, "starting");
    this.#event(current, "start-asked", who);
    const timings: Record<string, number> = {};
    const began = this.#now();
    let changed: Started | void;
    try {
      changed = await start(current.guest!, signal, (step, ms) => {
        timings[`start.${step}`] = ms;
      });
    } catch (error) {
      const observation = await this.#observedAfterFailure(current, signal, true);
      this.#event(current, "start-failed", who, { words: describeError(error, "Starting the box"), observed: observation });
      throw error;
    }
    timings["start.total"] = this.#now() - began;
    const moved = (await this.#move(current, "ready", timings, changed)) ?? current;
    this.#event(current, "started", who);
    if (moved.state === "ready") await this.#markIdentityAgain(moved, signal);
    const started = await this.#readUserspaceOrLog(moved, signal, true);
    if (started.state === "ready" && started.restoredAt) {
      await this.#enrol(started, { restored: true }).catch((error) => this.#deps.logError("enrol", error));
      return (await this.#read(started.threadId, started.id)) ?? started;
    }
    // A hard stop ends BB's daemon, and nothing in the box starts it again (017).
    if (started.state === "ready" && started.enrol.state === "enrolled" && this.#deps.reconnect) {
      this.#waitFor(started.id, this.#deps.reconnect(started).catch((error) => this.#deps.logError("reconnect", error)));
    }
    return started;
  }

  /**
   * Resizes a box (061), or with `check`, says what a resize would do. The
   * size is as box_acquire takes it, with parts left out kept as the box
   * has them. Refuses a part the backend cannot change, a size with no room
   * on the box's host, a restart unless `restart`, and a live shrink of
   * memory below what the box uses. `beforeRestart` may refuse a restart
   * by throwing, as for a person in control or threads at work. The resize
   * is recorded on the box before anything changes.
   */
  async resize(
    threadId: string,
    ref: string,
    request: SizeRequest & { readonly gpu?: GpuPart },
    options: {
      readonly restart?: boolean;
      readonly check?: boolean;
      readonly reportPlan?: boolean;
      readonly beforeRestart?: (box: BoxRecord) => Promise<void>;
      /** Who asked, for the log: "the tool", "the CLI" or "the panel". */
      readonly by?: string;
      readonly who?: Actor;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ResizeAnswer> {
    const box = await this.get(threadId, ref);
    const by = options.by ?? "a caller";
    if (options.check) return this.#resize(box, request, options, false);
    const asked = this.#now();
    try {
      const answer = await this.#chain(box.id, () => this.#resizeQueued(box, request, options));
      if (answer.changed) {
        const how = answer.box.resize?.restart ? "with a restart" : "live";
        const took = answer.box.resize?.ms ?? 0;
        const gpuChanged = answer.from.gpu !== answer.to.gpu;
        this.#deps.log?.(`Resized ${describeBox(box)} from ${sizeAndGpuWords(answer.from, gpuChanged)} to ${sizeAndGpuWords(answer.to, gpuChanged)}, ${how}, as ${by} asked, in ${took} ms.`);
      }
      return answer;
    } catch (error) {
      const changed = (await this.#read(box.threadId, box.id))?.resize;
      // A resize that began and failed, as opposed to one refused before it changed anything.
      const what = changed?.state === "failed" && changed.at >= asked ? "Could not resize" : "Refused to resize";
      this.#deps.log?.(`${what} ${describeBox(box)}, as ${by} asked: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  async #resizeQueued(box: BoxRecord, request: SizeRequest & { readonly gpu?: GpuPart }, options: { readonly restart?: boolean; readonly beforeRestart?: (box: BoxRecord) => Promise<void>; readonly who?: Actor; readonly signal?: AbortSignal }): Promise<ResizeAnswer> {
    const released = new AbortController();
    this.#resizing.set(box.id, released);
    try {
      return await this.#resize(box, request, { ...options, signal: options.signal ? AbortSignal.any([options.signal, released.signal]) : released.signal }, true);
    } finally {
      if (this.#resizing.get(box.id) === released) this.#resizing.delete(box.id);
    }
  }

  async #resize(
    box: BoxRecord,
    request: SizeRequest & { readonly gpu?: GpuPart },
    options: { readonly restart?: boolean; readonly check?: boolean; readonly reportPlan?: boolean; readonly beforeRestart?: (box: BoxRecord) => Promise<void>; readonly who?: Actor; readonly signal?: AbortSignal },
    queued: boolean,
  ): Promise<ResizeAnswer> {
    if (!ownedByThread(box.threadId) && box.threadId !== OPERATOR) throw new BoxError("unsupported", `Box ${box.name} is a spare, which takes its size when it is claimed.`);
    if (inSlot(box)) throw new BoxError("unsupported", options.restart ? restartRefusal(box.kind) : resizeRefusal(box.kind));
    const backend = this.#deps.backends.get(box.backend);
    const resizingOfBox = backend?.resizing?.(box.kind) ?? null;
    if (!backend?.planResize || !backend.resize || !resizingOfBox || (resizingOfBox.cores === "no" && resizingOfBox.memory === "no" && resizingOfBox.disk === "no")) {
      throw new BoxError("unsupported", `${box.backendLabel} cannot resize its ${box.kind} boxes, so box ${box.name} keeps its size.`);
    }
    {
      const stamped = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, options.signal);
      const current = stamped.resize?.state === "resizing" && (queued || !this.#work.has(stamped.id)) ? await this.#settledResize(backend, stamped, options.signal) : stamped;
      const sizes = kindSizes(current.kind, (await this.#deps.general()).sizes);
      const resizing = current.kind === box.kind ? resizingOfBox : backend.resizing?.(current.kind);
      if (!resizing) throw new BoxError("unsupported", `${current.backendLabel} cannot resize its ${current.kind} boxes, so box ${current.name} keeps its size.`);
      if (current.restoring || (current.state !== "ready" && current.state !== "stopped")) this.#require(current, "ready");
      const from = withGpu(current.guest!.size ?? (await this.#size(current)), recordedGpu(current));
      const chosen = chooseResize(current.kind, sizes, from, request, current.device?.model ?? current.askedDevice ?? current.capabilities.device?.devices[0].model);
      if (!chosen.ok) throw new BoxError("invalid_size", chosen.message);
      const to = withGpu(chosen.size, request.gpu ?? from.gpu);
      if (sameSize(to, from)) return { box: current, from, to, plan: null, changed: false };
      const gpuChanges = to.gpu !== from.gpu;
      const kind = gpuChanges ? kindWithGpu(current.kind) : current.kind;
      const becomes: KindChange | null = kind !== current.kind ? { from: current.kind, to: kind } : null;
      if (gpuChanges) await this.#gpuResizable(current, becomes ? (backend.resizing?.(kind) ?? null) : resizing, to.gpu, kind);
      if (gpuChanges && !holdsCard(from.gpu) && holdsCard(to.gpu) && current.state === "stopped") await this.#startFirstWhereRead(current, backend, kind, options.signal);
      const target = gpuChanges ? { ...machineSizeOf(to), gpu: to.gpu } : machineSizeOf(to);
      const recordedTo: RecordedSize = gpuChanges ? target : withRecordedGpu(to, current.size);
      const pending = await this.#pending(current.backend, current.id);
      const checked = gpuChanges && !options.check ? await this.#agreedGpu(current.id, from.gpu, to.gpu) : null;
      const planned = await backend.planResize!(current.guest!, kind, target, pending, options.signal, checked);
      // How long this box's restart took before, where it has a figure, rather than the backend's guess.
      const measured = planned.downSeconds !== null ? restartSeconds(current, backend.keepsSession?.(current.kind) ?? false) : null;
      const plan = measured !== null ? { ...planned, downSeconds: measured } : planned;
      const cannot = plan.parts.filter((part) => part.way === "no");
      if (cannot.length) {
        throw new BoxError("unsupported", `${current.backendLabel} cannot change the ${partWords(cannot.map((part) => part.part))} of its ${current.kind} boxes. ${resizingWords(resizing)}`);
      }
      let installFrom: UserspaceReading | null = null;
      if (gpuChanges) {
        const gpu = plan.gpu;
        if (!gpu) throw new BoxError("unsupported", ...gpuFixedWords(current));
        if (gpu.refusal || gpu.way === "no") {
          if (options.check && options.reportPlan) {
            await this.#rememberGpuPlan(current.id, gpu);
            return { box: current, from, to, plan, changed: false };
          }
          if (gpu.refusal) throw new BoxError(gpu.way === "no" ? "unsupported" : "no_capacity", gpu.refusal.person, gpu.refusal.agent);
          throw new BoxError("unsupported", gpu.words, `Not resized: ${gpu.words} bb-box changed nothing.`);
        }
        if (gpu.changedSinceAgreed) {
          await this.#rememberGpuPlan(current.id, gpu);
          if (options.reportPlan) return { box: current, from, to, plan, changed: false };
          throw new BoxError(gpu.way === "restart" && !options.restart ? "needs_restart" : "try_again", gpu.changedSinceAgreed.person, gpu.changedSinceAgreed.agent);
        }
        if (gpu.way === "restart" && !gpu.stopped) {
          const before = await this.#noUpdateRunning(current, kind, options.signal);
          if (gpu.installs) installFrom = await this.#installable(before?.box ?? current, gpu.installs, before?.reading ?? null, options.signal);
        }
        if (options.check) await this.#rememberGpuPlan(current.id, gpu);
      }
      const told = { ...(becomes ? { becomes } : {}) };
      // A check says up front what the resize would refuse, a live shrink below use too: one short command in the box.
      const shrinking = plan.parts.find((part) => part.part === "memory" && part.way === "live" && part.from !== null && part.to < part.from);
      if (shrinking && current.state === "ready") await this.#roomToShrink(current, to.memoryMiB, options.signal);
      if (options.check) return { box: current, from, to, plan, changed: false, ...told };
      if (!plan.room.ok) throw new BoxError("no_capacity", plan.room.message ?? `${current.backendLabel} has no room for box ${current.name} to grow.`, plan.room.agentMessage ?? null);
      const gpuRestarts = gpuChanges && plan.gpu?.way === "restart";
      const restart = plan.parts.some((part) => part.way === "restart") || gpuRestarts;
      if (restart && !options.restart) {
        const parts = [...plan.parts.filter((part) => part.way === "restart").map((part) => part.part), ...(gpuRestarts ? ["GPU"] : [])];
        const down = plan.downSeconds !== null ? `, for about ${plan.downSeconds} s` : "";
        const named = parts.length < 2 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
        const installing = installFrom && plan.gpu?.installs ? `, and installs NVIDIA's userspace ${plan.gpu.installs} in it first` : "";
        const said = `Resizing box ${current.name} to ${describeSize(to)}${gpuChanges ? `, GPU ${to.gpu}` : ""} needs a restart for its ${named}: the box shuts down and starts again${down}${installing}, which ends everything running in it.`;
        throw new BoxError("needs_restart", `${said} bb-box changed nothing.`, gpuRestarts ? `Not resized: ${said} Call box_resize with restart true to do that, or ask the user. bb-box changed nothing.` : null);
      }
      if (restart) await options.beforeRestart?.(current);
      options.signal?.throwIfAborted();
      const began = this.#now();
      const record: ResizeRecord = { from: withRecordedGpu(from, current.size), to: recordedTo, at: began, state: "resizing", ms: null, restart, error: null };
      // A restart takes the box down: box_run waits while it starts again, as after a start.
      const running = current.state === "ready";
      const installs = installFrom && plan.gpu?.installs && running ? plan.gpu.installs : null;
      await this.update(current, () => ({ resize: record, ...(restart && running && !installs ? { state: "starting" as const } : {}) }));
      const who = options.who ?? UNKNOWN_ACTOR;
      this.#event(current, "resize-asked", who, { words: `From ${sizeAndGpuWords(from, gpuChanges)} to ${sizeAndGpuWords(to, gpuChanges)}${restart ? ", with a restart" : ""}.` });
      let steps: UserspaceSteps | null = null;
      const working = options.signal;
      const installUserspace = async (driver: string, signal?: AbortSignal) => {
        working?.throwIfAborted();
        steps = await this.#installForGpu(current, driver, installFrom!, signal, options.beforeRestart);
      };
      const restartBegins = async () => {
        working?.throwIfAborted();
        await this.update(current, (latest) => (latest.state === "ready" ? { state: "starting" as const } : {}));
      };
      try {
        const guest = await backend.resize!(current.guest!, kind, target, { restart, ...(gpuChanges ? { agreed: checked ?? plan.gpu ?? null } : {}), ...(installs ? { installUserspace, restarting: restartBegins } : {}) }, working);
        const ranInstall = steps as UserspaceSteps | null;
        this.#event(current, "resized", who, { parts: changedParts(from, guest.size ?? to), words: `From ${sizeAndGpuWords(from, gpuChanges)} to ${sizeAndGpuWords(withGpu(guest.size ?? to, to.gpu), gpuChanges)}${ranInstall ? `, with NVIDIA's userspace ${installs} installed first` : ""}.` });
        let done = await this.update(current, (latest) => ({
          guest: { ...guest, facts: guest.facts ?? latest.guest?.facts },
          size: gpuChanges ? target : withRecordedGpu(to, latest.size),
          resize: { ...record, state: "done", ms: this.#now() - began },
          ...(restart && running && latest.state === "starting" ? { state: "ready" as const } : {}),
          ...(gpuChanges ? this.#kindWithGpu(latest, backend, kind, to.gpu) : {}),
        }));
        if (gpuChanges) await this.#forgetGpuPlan(current.id);
        const installed = steps ? await this.#checkInstalled(done ?? current, steps, installs!, working) : null;
        if (installed) done = (await this.#read(current.threadId, current.id)) ?? done;
        else if (gpuRestarts && running && done) done = await this.#readUserspaceOrLog(done, options.signal, true);
        // The restart ended BB's daemon, as a stop does (017).
        if (restart && done?.state === "ready" && done.enrol.state === "enrolled" && this.#deps.reconnect) {
          const reconnecting = done;
          this.#waitFor(reconnecting.id, this.#deps.reconnect(reconnecting).catch((error) => this.#deps.logError("reconnect", error)));
        }
        return { box: done ?? current, from, to, plan, changed: true, ...told, ...(installed ? { installed } : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const recovery = AbortSignal.timeout(RECOVERY_READ_MS);
        const installedSteps = steps as UserspaceSteps | null;
        if (installedSteps) await installedSteps.ended("restart", message, false);
        if (error instanceof GpuPlanChanged) await this.#rememberGpuPlan(current.id, error.plan);
        else if (gpuChanges) await this.#forgetGpuPlan(current.id);
        const now = await this.#sizeNow(backend, current.guest!, recovery);
        const power = restart && running ? await backend.power(current.guest!, recovery).catch(() => null) : null;
        const runs = error instanceof ResizeLeftStopped ? false : power === null ? true : power === "running";
        const held = error instanceof ResizeHolds ? error : null;
        await this.update(current, (latest) => ({
          resize: { ...record, state: "failed", ms: this.#now() - began, error: message },
          ...(restart && running && latest.state === "starting" ? { state: runs ? ("ready" as const) : ("stopped" as const) } : {}),
          ...(now && latest.guest ? { guest: { ...latest.guest, size: now } } : {}),
          ...(held && latest.guest ? { guest: { ...latest.guest, ...held.guest, facts: held.guest.facts ?? latest.guest.facts, size: now ?? latest.guest.size }, size: { ...withRecordedGpu(now ?? latest.guest.size ?? from, latest.size), gpu: held.gpu }, ...this.#kindWithGpu(latest, backend, kind, held.gpu) } : {}),
        }));
        const observed = restart ? await this.#observedAfterFailure(current, recovery, false) : null;
        const parts = changedParts(from, now);
        const sizeWords = now ? (parts.length ? ` Its ${partWords(parts)} changed: it has ${describeSize(now)} now.` : " Nothing changed.") : " bb-box could not read its size after.";
        this.#event(current, "resize-failed", who, { words: `${sentence(describeError(error, "Resizing the box"))}${sizeWords}`, parts, observed });
        throw error;
      }
    }
  }

  #kindWithGpu(box: BoxRecord, backend: Backend, kind: string, gpu: GpuPart): Partial<BoxRecord> {
    if (kind === box.kind || !holdsCard(gpu)) return {};
    const offered = backend.kinds().find((candidate) => candidate.id === kind);
    return offered ? { kind, kindLabel: offered.label, capabilities: offered.capabilities } : { kind };
  }

  async #startFirstWhereRead(box: BoxRecord, backend: Backend, kind: string, signal?: AbortSignal): Promise<void> {
    const reading = box.userspaceRead;
    if (!reading || !backend.nvidiaHost || !hasGpuPart(kind)) return;
    const driver = (await backend.nvidiaHost(kind, signal))?.driver ?? null;
    if (!driver || matchesDriver(reading, driver)) return;
    const words = startFirstWords(box.name, driver);
    throw new BoxError("unsupported", words.person, words.agent);
  }

  async #noUpdateRunning(box: BoxRecord, kind: string, signal?: AbortSignal): Promise<{ readonly box: BoxRecord; readonly reading: UserspaceReading } | null> {
    const backend = this.#deps.backends.get(box.backend);
    const host = backend?.nvidiaHost && hasGpuPart(kind) ? await backend.nvidiaHost(kind, signal) : null;
    if (!host) return null;
    const found = await this.#readingIn(box, host.driver, signal);
    if (found.running) {
      const said = stillRunningWords(box.name).replace(/^A/, "a");
      throw new BoxError("try_again", `Not changed: ${said}. Resize it again once it has ended.`, `Not resized: ${said}. Call box_resize again once it has ended, or ask the user. bb-box changed nothing.`);
    }
    return { box: found.box, reading: found.reading };
  }

  async #installable(box: BoxRecord, driver: string, known: UserspaceReading | null, signal?: AbortSignal): Promise<UserspaceReading> {
    const before = known ? { box, reading: known } : await this.#readingIn(box, driver, signal);
    const checked = await this.runOwn(before.box, UPDATE_CHECK, { stdin: updateScriptText(), timeoutMs: UPDATE_CHECK_MS, maxOutputBytes: 64 * 1024, signal });
    const verdict = judgeUpdateCheck(`${checked.stdout}\n${checked.stderr}`, driver);
    if (!verdict.ok) {
      const words = cannotInstallWords(box.name, verdict.why, verdict.transient === true);
      throw new BoxError(verdict.transient ? "try_again" : "unsupported", words.person, words.agent);
    }
    return before.reading;
  }

  async #installForGpu(box: BoxRecord, driver: string, reading: UserspaceReading, signal: AbortSignal | undefined, beforeRestart: ((box: BoxRecord) => Promise<void>) | undefined): Promise<UserspaceSteps> {
    const name = box.name;
    const steps = await this.#userspaceSteps(box, driver, reading, "install");
    this.#deps.log?.(`Installing NVIDIA's userspace ${driver} in ${describeBox(box)}, over ${steps.from}, to add its GPU.`);
    try {
      const failed = await this.#fetchAndInstall(box, driver, signal ? AbortSignal.any([signal, steps.signal]) : steps.signal, steps.signal, () => steps.stepTo("install"));
      if (failed?.step === "fetch") {
        await steps.ended("fetch", failed.why, false);
        const said = `bb-box could not download NVIDIA's installer ${driver} into box ${name}: ${failed.why.replace(/\.$/, "")}. Nothing in it changed, and it keeps no GPU`;
        throw new BoxError("failed", `Not resized: ${said}. Try again later.`, `Not resized: ${said}. Try again later, or ask the user.`);
      }
      if (failed) {
        const after = await steps.ended("install", failed.why, true);
        const now = after ? ` It has ${readingWords(after)} now.` : "";
        const said = `bb-box could not install NVIDIA's userspace ${driver} in box ${name}: ${failed.why.replace(/\.$/, "")}.${now} It goes on running with no GPU, as it was, and was not restarted`;
        throw new BoxError("failed", `Not resized: ${said}. Resize it again to try once more.`, `Not resized: ${said}. Ask the user.`);
      }
      await steps.stepTo("restart");
      try {
        await beforeRestart?.((await this.#read(box.threadId, box.id)) ?? box);
      } catch (error) {
        const why = describeError(error, "Checking the restart").replace(/\.$/, "");
        await steps.ended("restart", why, false);
        const said = `bb-box installed NVIDIA's userspace ${driver} in box ${name}, but did not restart it to add its GPU: ${why}. It goes on running with no GPU`;
        throw new BoxError(error instanceof BoxError ? error.code : "failed", `Not resized: ${said}. Resize it again once it can restart.`, `Not resized: ${said}. Ask the user.`);
      }
      return steps;
    } finally {
      steps.close();
    }
  }

  async #checkInstalled(box: BoxRecord, steps: UserspaceSteps, driver: string, signal?: AbortSignal): Promise<UserspaceInstalled> {
    await steps.stepTo("check");
    const problem = await this.#checkUpdated(box, driver, signal ?? AbortSignal.timeout(DESKTOP_CHECK_MS + CARD_CHECK_MS + USERSPACE_READ_MS)).catch((error: unknown) => describeError(error, "Checking the box"));
    if (problem) await steps.ended("check", problem, true);
    else {
      const ms = await steps.done();
      this.#deps.log?.(`Installed NVIDIA's userspace ${driver} in ${describeBox(box)}, over ${steps.from}, with its GPU, in ${ms} ms.`);
    }
    return { driver, from: steps.from, problem };
  }

  async #userspaceSteps(box: BoxRecord, driver: string, reading: UserspaceReading, what: "update" | "install"): Promise<UserspaceSteps> {
    const began = this.#now();
    const from = fromOf(reading);
    const controller = new AbortController();
    const record: UserspaceUpdate = { from, to: driver, at: began, state: "updating", step: "fetch", ms: null, error: null };
    await this.update(box, () => ({ userspaceUpdate: record }));
    this.#updating.set(box.id, controller);
    const ours = (change: (update: UserspaceUpdate) => Partial<UserspaceUpdate>) => (latest: BoxRecord) => (latest.userspaceUpdate?.at === began ? { userspaceUpdate: { ...latest.userspaceUpdate, ...change(latest.userspaceUpdate) } } : {});
    return {
      from,
      signal: controller.signal,
      stepTo: async (step) => {
        await this.update(box, ours(() => ({ step })));
      },
      ended: async (step, why, read) => {
        const cut = this.#disposed;
        const after = read && !cut ? await this.#readingIn((await this.#read(box.threadId, box.id)) ?? box, driver).then((found) => (found.running ? null : found.reading), () => null) : null;
        const state = cut ? ("unknown" as const) : ("failed" as const);
        await this.update(box, ours(() => ({ step, state, ms: cut ? null : this.#now() - began, error: why })));
        this.#deps.log?.(`${describeBox(box)}: the ${what} of NVIDIA's userspace to ${driver} ${cut ? "was cut short" : "failed"} while at its ${step} step: ${why}`);
        return after;
      },
      done: async () => {
        const ms = this.#now() - began;
        await this.update(box, ours(() => ({ state: "done", step: "check", ms, error: null })));
        return ms;
      },
      close: () => {
        if (this.#updating.get(box.id) === controller) this.#updating.delete(box.id);
      },
    };
  }

  async #fetchAndInstall(box: BoxRecord, driver: string, fetching: AbortSignal, installing: AbortSignal, beforeInstall: () => Promise<void>): Promise<{ readonly step: "fetch" | "install"; readonly why: string } | null> {
    const fetched = await this.runOwn(box, fetchCommand(driver), { timeoutMs: FETCH_MS, maxOutputBytes: 16 * 1024, signal: fetching }).catch((error: unknown) => error);
    if (!isRunResult(fetched) || fetched.exitCode !== 0) {
      return { step: "fetch", why: isRunResult(fetched) ? lastLines(fetched.stderr || fetched.stdout) || `exit code ${fetched.exitCode}` : describeError(fetched, "Downloading") };
    }
    await beforeInstall();
    const installed = await this.runOwn(box, installCommand(), { timeoutMs: INSTALL_MS, maxOutputBytes: 64 * 1024, signal: installing }).catch((error: unknown) => error);
    if (!isRunResult(installed) || installed.exitCode !== 0) {
      return { step: "install", why: isRunResult(installed) ? lastLines(installed.stderr || installed.stdout) || `exit code ${installed.exitCode}` : describeError(installed, "Installing") };
    }
    return null;
  }

  async #agreedGpu(boxId: string, from: GpuPart, to: GpuPart): Promise<GpuResize | null> {
    const checked = (await this.#deps.kv.get<GpuResize>(checkedGpuKey(boxId))) ?? null;
    return checked && checked.from === from && checked.to === to ? checked : null;
  }

  async #rememberGpuPlan(boxId: string, plan: GpuResize): Promise<void> {
    await this.#deps.kv.set(checkedGpuKey(boxId), plan);
  }

  async #forgetGpuPlan(boxId: string): Promise<void> {
    await this.#deps.kv.delete(checkedGpuKey(boxId));
  }

  async #gpuResizable(box: BoxRecord, resizing: Resizing | null, gpu: GpuPart, kind: string): Promise<void> {
    const chosen = chooseGpu(kind, gpu);
    if (!chosen.ok) throw new BoxError("unsupported", chosen.message, `Not resized: ${chosen.message} bb-box changed nothing.`);
    if (!resizing?.gpu) throw new BoxError("unsupported", ...(kind === box.kind ? gpuFixedWords(box) : noGpuDesktopWords(box, kind)));
    if (gpu === "whole" && !(await this.wholeCards())) throw new BoxError("unsupported", WHOLE_CARDS_OFF_FOR_RESIZE.person, WHOLE_CARDS_OFF_FOR_RESIZE.agent);
  }

  async #sizeNow(backend: Backend, guest: Guest, signal?: AbortSignal): Promise<MachineSize | null> {
    try {
      return (await backend.held(signal)).find((held) => held.ref === guest.ref)?.size ?? null;
    } catch {
      return null;
    }
  }

  /** A resize bb-box stopped in the middle of, as for an update: the box has the size its guest says now (061). */
  async #settledResize(backend: Backend, box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    await this.#resizeCutShort(backend, box, box.guest?.size, signal);
    const settled = (await this.#read(box.threadId, box.id)) ?? box;
    if (settled.resize?.state === "resizing") {
      throw new BoxError("try_again", `Not changed: bb-box could not yet read which GPU box ${box.name} holds after its last resize, which was cut short. Try again in a minute.`, `Not resized: bb-box could not yet read which GPU box ${box.name} holds after its last resize, which was cut short. Try again in a minute, or ask the user. bb-box changed nothing.`);
    }
    return settled;
  }

  async #resizeCutShort(backend: Backend, box: BoxRecord, guestSize: MachineSize | null | undefined, signal?: AbortSignal): Promise<void> {
    const error = "bb-box restarted before the resize finished, so the box has the size its guest says now.";
    const gpuCut = box.resize && box.resize.to.gpu !== undefined && box.resize.to.gpu !== (box.resize.from.gpu ?? recordedGpu(box));
    let held: GpuHandoff | null = null;
    if (gpuCut && box.guest && backend.readGpuClaim) {
      try {
        held = await backend.readGpuClaim(box.guest, signal);
      } catch (cause) {
        this.#deps.log?.(`${describeBox(box)}: ${error} bb-box could not read which GPU its backend holds for it, so it reads it again at the next sweep: ${describeError(cause, "Reading its claim")}`);
        return;
      }
    }
    await this.update(box, (current) => {
      if (current.resize?.state !== "resizing" || !current.guest) return {};
      const size = guestSize ?? current.guest.size;
      const recorded = size ? withRecordedGpu(size, current.size) : current.size;
      if (!held) return { guest: { ...current.guest, size }, ...(recorded ? { size: recorded } : {}), resize: { ...current.resize, state: "failed", error } };
      const claim: CardClaim | null = held.part === "none" ? null : { card: held.card, part: held.part, generation: held.generation, answer: "granted" };
      return {
        guest: { ...current.guest, size, claim },
        ...(recorded ? { size: { ...recorded, gpu: held.part } } : {}),
        resize: { ...current.resize, state: "failed", error },
        ...this.#kindWithGpu(current, backend, kindWithGpu(current.kind), held.part),
      };
    });
    this.#deps.log?.(`${describeBox(box)}: ${error}${held ? ` Its GPU is ${held.part}, as its backend holds it.` : ""}`);
  }

  async readUserspace(box: BoxRecord, signal?: AbortSignal, started = false): Promise<BoxRecord> {
    return this.#readUserspace(box, signal, undefined, started);
  }

  async #readUserspaceOrLog(box: BoxRecord, signal?: AbortSignal, started = false): Promise<BoxRecord> {
    try {
      return await this.#readUserspace(box, signal, undefined, started);
    } catch (error) {
      if (signal?.aborted) throw error;
      this.#deps.log?.(`${describeBox(box)}: ${describeError(error, "Reading NVIDIA's userspace in it")}`);
      return (await this.#read(box.threadId, box.id)) ?? box;
    }
  }

  #readsUserspace(box: BoxRecord): boolean {
    return hasGpuPart(box.kind) && (holdsCard(recordedGpu(box)) || unfinishedUpdate(box.userspaceUpdate)) && !!this.#deps.backends.get(box.backend)?.nvidiaHost;
  }

  async #userspaceHost(box: BoxRecord, signal?: AbortSignal): Promise<NvidiaHost | null> {
    const backend = this.#deps.backends.get(box.backend);
    return backend?.nvidiaHost ? backend.nvidiaHost(box.kind, signal) : null;
  }

  async #readUserspace(box: BoxRecord, signal?: AbortSignal, known?: NvidiaHost | null, started = false): Promise<BoxRecord> {
    const current = started ? ((await this.update(box, (latest) => restartedSinceUpdate(latest.userspaceUpdate))) ?? box) : box;
    if (current.state !== "ready" || !current.guest || !this.#readsUserspace(current)) return current;
    const host = known !== undefined ? known : await this.#userspaceHost(current, signal);
    if (!host) return current;
    return (await this.#readingIn(current, host.driver, signal)).box;
  }

  async #readingIn(box: BoxRecord, driver: string | null, signal?: AbortSignal): Promise<{ readonly box: BoxRecord; readonly reading: UserspaceReading; readonly running: boolean }> {
    const result = await this.runOwn(box, USERSPACE_READ, { timeoutMs: USERSPACE_READ_MS, maxOutputBytes: 2048, signal });
    const reading = result.exitCode === 0 ? judgeReading(result.stdout, driver, this.#now()) : null;
    if (!reading) throw new BoxError("unreachable", `bb-box could not read NVIDIA's userspace in box ${box.name}: ${lastLines(`${result.stdout}\n${result.stderr}`) || `exit code ${result.exitCode}`}.`);
    if (updateRunning(result.stdout)) return { box: (await this.update(box, () => ({ userspaceRunningSeenAt: reading.at }))) ?? box, reading, running: true };
    const recorded = await this.update(box, (current) => ({ nvidiaUserspace: userspaceOfReading(reading), userspaceRead: reading, userspaceRunningSeenAt: null, ...settledUpdate(current.userspaceUpdate, reading) }));
    return { box: recorded ?? box, reading, running: false };
  }

  async #userspaceUpdateCutShort(box: BoxRecord, signal?: AbortSignal): Promise<void> {
    let cut: BoxRecord | null = box;
    if (box.userspaceUpdate?.state === "updating") {
      const error = "bb-box restarted before the update finished.";
      cut = await this.update(box, (current) => (current.userspaceUpdate?.state === "updating" ? { userspaceUpdate: { ...current.userspaceUpdate, state: "unknown", ms: null, error } } : {}));
      this.#deps.log?.(`${describeBox(box)}: an update of NVIDIA's userspace was cut short: ${error}`);
    }
    if (!cut) return;
    const settled = cut.state === "stopping" || cut.state === "starting" ? ((await this.#observe(cut, { signal, moving: true })) ?? cut) : cut;
    if (settled.state === "ready") await this.#readUserspaceOrLog(settled, signal);
  }

  async updateUserspace(threadId: string, ref: string, options: UserspaceUpdateOptions = {}): Promise<UserspaceUpdateAnswer> {
    const box = await this.get(threadId, ref);
    if (this.#disposed) throw new BoxError("restarting", "bb-box is stopping, as for an update. Try again once it is back.");
    return this.#chain(box.id, () => this.#updateUserspace(box, options));
  }

  async #updateUserspace(box: BoxRecord, options: UserspaceUpdateOptions): Promise<UserspaceUpdateAnswer> {
    let current = await this.#stamped((await this.#read(box.threadId, box.id)) ?? box, options.signal);
    const name = current.name;
    if (!hasGpuPart(current.kind)) throw new BoxError("unsupported", `Box ${name} is a ${current.kind} box, which has no NVIDIA userspace. bb-box changed nothing.`);
    if (!holdsCard(recordedGpu(current))) throw new BoxError("unsupported", `Box ${name} has no GPU, so nothing in it uses NVIDIA's userspace. bb-box changed nothing.`);
    const backend = this.#backend(current);
    const host = backend.nvidiaHost ? await backend.nvidiaHost(current.kind, options.signal) : null;
    if (!host) throw new BoxError("unsupported", `${current.backendLabel} keeps no NVIDIA userspace in its boxes, so box ${name} has none to update. bb-box changed nothing.`);
    if (current.state === "stopped") throw new BoxError("not_ready", `Start box ${name} first: NVIDIA's userspace is updated in a running box. Nothing changed.`);
    this.#require(current, "ready");
    if (host.refused) throw new BoxError("unsupported", `Not changed: ${host.refused.why.replace(/\.$/, "")}.${host.refused.fix ? ` ${host.refused.fix}` : ""}`);
    const driver = host.driver;
    const before = await this.#readingIn(current, driver, options.signal);
    if (before.running) throw new BoxError("try_again", `Not changed: ${stillRunningWords(name).replace(/^A/, "a")}. Run this again once it has ended: bb box doctor says when it has.`);
    current = before.box;
    const reading = before.reading;
    if (userspaceState(reading, current.userspaceUpdate, driver).is === "matches") {
      return { box: current, needed: false, changed: false, from: reading, to: driver, processes: [], words: `Box ${name} already has NVIDIA's userspace ${driver}, the host's driver. bb-box changed nothing.` };
    }
    const checked = await this.runOwn(current, UPDATE_CHECK, { stdin: updateScriptText(), timeoutMs: UPDATE_CHECK_MS, maxOutputBytes: 64 * 1024, signal: options.signal });
    const verdict = judgeUpdateCheck(`${checked.stdout}\n${checked.stderr}`, driver);
    if (!verdict.ok) throw new BoxError("unsupported", `Not changed: box ${name} ${verdict.why}.`);
    const plan = planWords(name, reading, driver, verdict.processes);
    if (options.check) return { box: current, needed: true, changed: false, from: reading, to: driver, processes: verdict.processes, words: plan };
    await options.checkRestart?.(current);
    const who = options.who ?? UNKNOWN_ACTOR;
    const steps = await this.#userspaceSteps(current, driver, reading, "update");
    this.#deps.log?.(`Updating NVIDIA's userspace in ${describeBox(current)} from ${steps.from} to ${driver}.`);
    try {
      const failed = await this.#fetchAndInstall(current, driver, options.signal ? AbortSignal.any([options.signal, steps.signal]) : steps.signal, steps.signal, () => steps.stepTo("install"));
      if (failed?.step === "fetch") {
        await steps.ended("fetch", failed.why, false);
        throw new BoxError("failed", `Not changed: bb-box could not download NVIDIA's installer ${driver} into box ${name}: ${failed.why.replace(/\.$/, "")}. Nothing in it changed.`);
      }
      if (failed) {
        const after = await steps.ended("install", failed.why, true);
        const now = after ? ` It has ${readingWords(after)} now${halfInstalled(after) ? `: run bb box gpu update ${name} again` : ""}.` : "";
        throw new BoxError("failed", `bb-box could not install NVIDIA's userspace ${driver} in box ${name}: ${failed.why.replace(/\.$/, "")}.${now} It goes on running, and was not restarted.`);
      }
      await steps.stepTo("restart");
      try {
        await options.checkRestart?.((await this.#read(current.threadId, current.id)) ?? current);
      } catch (error) {
        await steps.ended("restart", describeError(error, "Checking the restart"), false);
        throw new BoxError(
          error instanceof BoxError ? error.code : "failed",
          `bb-box installed NVIDIA's userspace ${driver} in box ${name}, but did not restart it: ${describeError(error, "Checking the restart").replace(/\.$/, "")}. Its programs keep the old libraries until it restarts. Run bb box gpu update ${name} again once it can restart.`,
        );
      }
      try {
        await this.#stop(current, steps.signal, who);
        current = await this.#start(current, steps.signal, false, who);
      } catch (error) {
        await steps.ended("restart", describeError(error, "Restarting the box"), false);
        const now = (await this.#read(current.threadId, current.id)) ?? current;
        throw new BoxError("failed", `bb-box installed NVIDIA's userspace ${driver} in box ${name}, but could not restart it: ${describeError(error, "Restarting the box").replace(/\.$/, "")}. It is ${now.state} now, with the new userspace on its disk. Run bb box gpu update ${name} again once it runs.`);
      }
      await steps.stepTo("check");
      const problem = await this.#checkUpdated(current, driver, steps.signal).catch((error: unknown) => describeError(error, "Checking the box"));
      if (problem) {
        await steps.ended("check", problem, true);
        throw new BoxError("failed", `bb-box installed NVIDIA's userspace ${driver} in box ${name} and restarted it, but its check after the restart failed: ${problem.replace(/\.$/, "")}. It goes on running. Run bb box gpu update ${name} again, or bb box doctor.`);
      }
      const ms = await steps.done();
      current = (await this.#read(current.threadId, current.id)) ?? current;
      this.#deps.log?.(`Updated NVIDIA's userspace in ${describeBox(current)} from ${steps.from} to ${driver} in ${ms} ms.`);
      const fact = current.guest?.facts?.find((candidate) => candidate.label === "GPU")?.value;
      return {
        box: current,
        needed: true,
        changed: true,
        from: reading,
        to: driver,
        processes: verdict.processes,
        words: `Updated NVIDIA's userspace in box ${name} from ${steps.from} to ${driver}, and restarted it, in ${Math.round(ms / 1000)} s. nvidia-smi in it lists ${fact ?? "its card"}, and CUDA's driver initialises.`,
      };
    } finally {
      steps.close();
    }
  }

  async userspaceChecks(signal?: AbortSignal): Promise<DoctorCheck[]> {
    const boxes = (await this.all()).filter((box) => box.threadId !== SPARES && box.guest && (box.state === "ready" || box.state === "stopped" || box.userspaceUpdate?.state === "updating") && this.#readsUserspace(box));
    if (!boxes.length) return [];
    const hosts = new Map<string, Promise<NvidiaHost | { readonly failed: string } | null>>();
    const hostOf = (box: BoxRecord) => {
      const key = `${box.backend}\n${currentKindId(box.kind)}`;
      let host = hosts.get(key);
      if (!host) {
        host = this.#userspaceHost(box, signal).catch((error: unknown) => ({ failed: describeError(error, "Reading the host's NVIDIA driver") }));
        hosts.set(key, host);
      }
      return host;
    };
    let matching = 0;
    const checks = await Promise.all(
      boxes.map(async (box): Promise<DoctorCheck | null> => {
        const host = await hostOf(box);
        if (!host) return null;
        const driver = "failed" in host ? null : host.driver;
        if (box.userspaceUpdate?.state === "updating" && !this.#work.has(box.id)) await this.#userspaceUpdateCutShort(box, signal);
        let current = (await this.#read(box.threadId, box.id)) ?? box;
        let unread: string | null = null;
        let running = false;
        if (current.state === "ready" && !this.#work.has(box.id) && !("failed" in host)) {
          const before = current;
          current = await this.#readingIn(before, host.driver, signal).then(
            (found) => {
              running = found.running;
              return found.box;
            },
            (error: unknown) => {
              unread = describeError(error, "Reading it");
              return before;
            },
          );
        }
        const notReadNow = current.state !== "ready" ? null : this.#work.has(box.id) ? "bb-box is working on it" : "failed" in host ? `bb-box could not read the host's driver: ${host.failed.replace(/\.$/, "")}` : null;
        const state = userspaceState(current.userspaceRead, current.userspaceUpdate, driver, running);
        if (state.is === "matches" && !unread) {
          if (holdsCard(recordedGpu(current))) matching++;
          return null;
        }
        return userspaceCheck(current, state, unread, "failed" in host ? host.failed : host.refused ? `${host.refused.why.replace(/\.$/, "")}.${host.refused.fix ? ` ${host.refused.fix}` : ""}` : null, notReadNow);
      }),
    );
    const named = checks.filter((check): check is DoctorCheck => check !== null);
    const summary: DoctorCheck = {
      id: "gpu-userspace",
      name: "NVIDIA userspace",
      status: "ok",
      detail: `${matching === 1 ? "1 box" : `${matching} boxes`} with a GPU ${matching === 1 ? "has" : "have"} NVIDIA's userspace for ${matching === 1 ? "its" : "their"} host's driver.${named.length ? ` ${named.length === 1 ? "1 box needs" : `${named.length} boxes need`} a look, below.` : ""} bb-box never updates a box's userspace by itself.`,
      fix: null,
    };
    return [summary, ...named];
  }

  async #checkUpdated(box: BoxRecord, driver: string, signal: AbortSignal): Promise<string | null> {
    const { reading } = await this.#readingIn(box, driver, signal);
    if (!matchesDriver(reading, driver)) return `it has ${readingWords(reading)} after its restart`;
    const card = claimOf(box)?.card?.replace(/^GPU-/i, "").toLowerCase() ?? null;
    const ran = await this.runOwn(box, CARD_CHECK_COMMAND, { timeoutMs: CARD_CHECK_MS, maxOutputBytes: 8192, signal });
    const output = `${ran.stdout}\n${ran.stderr}`;
    const judged = card ? judgeCardCheck(output, card, driver) : judgeAnyCard(output);
    if (!judged.ok) return judged.why;
    if (currentKindId(box.kind) !== "linux-desktop") return null;
    const desktop = await this.runOwn(box, DESKTOP_GPU_CHECK, { timeoutMs: DESKTOP_CHECK_MS, maxOutputBytes: 8192, signal });
    return judgeDesktopCheck(`${desktop.stdout}\n${desktop.stderr}`);
  }

  /** Refuses a live shrink of a box's memory to `memoryMiB` when the box uses more than that, less a margin (061). */
  async #roomToShrink(box: BoxRecord, memoryMiB: number, signal?: AbortSignal): Promise<void> {
    if (box.capabilities.os !== "linux" || !box.capabilities.command) return;
    const result = await this.runOwn(box, MEMORY_IN_USE, { timeoutMs: 15_000, maxOutputBytes: 256, signal });
    const used = Number(result.stdout.trim());
    if (result.exitCode !== 0 || !Number.isFinite(used) || used <= 0) {
      throw new BoxError("unreachable", `bb-box could not read how much memory box ${box.name} uses, so it did not shrink it: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    const margin = Math.max(RESIZE_MEMORY_MARGIN_MIB, Math.round(memoryMiB / 10));
    if (used + margin > memoryMiB) {
      throw new BoxError(
        "memory_in_use",
        `Box ${box.name} uses ${formatMiB(used)} of memory now, so ${formatMiB(memoryMiB)} would leave less than ${formatMiB(margin)} free, and the kernel could end its processes. ` +
          `Give it at least ${formatMiB(Math.ceil((used + margin) / 1024) * 1024)}, or free memory in it first. bb-box changed nothing.`,
      );
    }
  }

  /**
   * What is still to come on a backend, for its room: the boxes being
   * acquired there, at their size, and those being resized, by what they
   * grow (061). `except` is left out.
   */
  async #pending(backendId: string, except?: string): Promise<{ kind: string; size: MachineSize }[]> {
    const all = (await this.all()).filter((box) => box.backend === backendId && box.id !== except);
    const acquiring = await Promise.all(all.filter(isAcquiring).map(async (box) => ({ kind: box.kind, size: machineSizeOf(await this.#size(box)) })));
    const resizing = all
      .filter((box) => box.resize?.state === "resizing")
      .map((box) => {
        const { from, to } = box.resize!;
        const disk = to.diskGiB !== null ? Math.max(0, to.diskGiB - (from.diskGiB ?? to.diskGiB)) : null;
        return { kind: box.kind, size: { cores: Math.max(0, to.cores - from.cores), memoryMiB: Math.max(0, to.memoryMiB - from.memoryMiB), diskGiB: disk } };
      })
      // Only a growth takes room; a shrink or a change of cores alone takes none.
      .filter((growth) => growth.size.memoryMiB > 0 || (growth.size.diskGiB ?? 0) > 0);
    return [...acquiring, ...resizing];
  }

  /**
   * Records why a box's guest stopped when bb-box did not stop it, as its
   * backend says (#406), and starts it again in the background when its VM
   * crashed, unless bb-box started it again after the stop before less than
   * RESTART_GAP_MS before.
   */
  async #stoppedUnrequested(box: BoxRecord, signal?: AbortSignal, asked: BoxEvent | null = null): Promise<BoxRecord> {
    const backend = this.#deps.backends.get(box.backend);
    let why: StopReason | null = null;
    try {
      why = (await backend?.stopped?.(box.guest!, signal)) ?? null;
    } catch (error) {
      this.#deps.logError("stopped", error);
    }
    if (asked && !why?.crashed) {
      this.#event(box, "stopped", asked.by, { words: "bb-box confirmed the stop after its request had failed." });
      return box;
    }
    const now = this.#now();
    const last = box.unrequestedStop?.restart?.at;
    const restart = !!why?.crashed && !!backend?.start && (last === undefined || now - last >= RESTART_GAP_MS);
    const stop: UnrequestedStop = { at: why?.at ?? now, reason: why?.reason ?? null, crashed: why?.crashed ?? false, restart: restart ? { at: now, error: null } : null };
    const updated = (await this.update(box, (current) => (current.state === "stopped" ? { unrequestedStop: stop } : {}))) ?? box;
    this.#deps.log?.(`${describeBox(box)}: ${stopWords(updated)}`);
    this.#event(updated, "stopped-unasked", BY_OUTSIDE, { at: stop.at, words: stop.reason });
    if (restart && updated.unrequestedStop === stop) {
      const restarter = byBbBox("its VM crashed, and bb-box starts such a box again");
      void this.#chain(box.id, () => this.#start(updated, undefined, inSlot(updated), restarter)).catch(async (error) => {
        this.#deps.logError("restart", error);
        const message = describeError(error, "The start");
        await this.update(box, (current) => {
          const last = current.unrequestedStop;
          return last?.restart ? { unrequestedStop: { ...last, restart: { ...last.restart, error: message } } } : {};
        });
      });
    }
    return updated;
  }

  /**
   * Moves a box to `state` for a stop or start, unless its release began
   * meanwhile. A start's timings replace the last start's, and the facts it
   * found the guest's.
   */
  #move(
    box: BoxRecord,
    state: "stopping" | "stopped" | "starting" | "ready",
    started?: Readonly<Record<string, number>>,
    changed?: Started | void,
    stoppedWith: Partial<BoxRecord> = {},
  ): Promise<BoxRecord | null> {
    const moving = state === "stopping" || state === "starting";
    return this.update(box, (current) => {
      if (current.state === "releasing") return {};
      if (state === "stopping") return { state, error: null, unrequestedStop: null };
      if (state === "starting") return { state, error: null, timings: withoutStartSteps(current.timings) };
      if (moving) return { state, error: null };
      if (state === "stopped") return { state, stoppedAt: this.#now(), ...stoppedWith };
      if (!started) return { state };
      const guest = changed && current.guest ? { guest: startedGuest(current.guest, changed) } : {};
      const gpu = startedGpu(changed);
      const size = gpu && current.size ? { size: { ...current.size, gpu } } : {};
      return { state, timings: { ...withoutStartSteps(current.timings), ...started }, ...guest, ...size };
    });
  }

  /** Throws the reason a box is not in `state`, in words for the user. */
  #require(box: BoxRecord, state: BoxState): void {
    if (box.restoring && box.state !== "releasing") throw new BoxError("not_ready", restoringWords(box, box.restoring));
    if (box.state === state && box.guest) return;
    const reasons: Record<BoxState, string> = {
      acquiring: `Box ${box.name} is still being acquired. Check its status in a few seconds.`,
      starting: restarting(box)
        ? `Box ${box.name} is starting again. ${stopWords(box)} Check its status in a few seconds.`
        : `Box ${box.name} is still starting. Check its status in a few seconds.`,
      ready: `Box ${box.name} is already running.`,
      stopping: `Box ${box.name} is stopping.`,
      stopped: restarting(box)
        ? `Box ${box.name} is stopped. ${stopWords(box)} Check its status in a few seconds.`
        : `Box ${box.name} is stopped.${box.unrequestedStop ? ` ${stopWords(box)}` : ""} Start it first.`,
      failed: `Box ${box.name} failed: ${box.error ?? "unknown error"} Release it and acquire another.`,
      gone: `Box ${box.name} no longer exists at its provider. Release it and acquire another.`,
      releasing: `Box ${box.name} is being released.`,
    };
    throw new BoxError("not_ready", reasons[box.state]);
  }

  /** Reads the guest's power and updates the box to match. */
  async refresh(threadId: string, ref: string, signal?: AbortSignal): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    if (this.#work.has(box.id)) return box;
    if (this.#deps.reach?.notAnswering(box.id)) {
      const last = this.#powerCheckedAt.get(box.id);
      if (last !== undefined && this.#now() - last < POWER_CHECK_GAP_MS) return box;
      this.#powerCheckedAt.set(box.id, this.#now());
    }
    return (await this.#observe(box, { signal })) ?? box;
  }

  /**
   * Moves a ready, stopped or gone box to match the guest's power. `moving`
   * also settles a box a failed stop or start left stopping or starting.
   */
  async #observe(
    box: BoxRecord,
    options: { signal?: AbortSignal; power?: PowerState | null; moving?: boolean; seen?: (power: PowerState | null) => void } = {},
  ): Promise<BoxRecord | null> {
    if (!box.guest || box.restoring) return box;
    const backend = this.#deps.backends.get(box.backend);
    if (!backend) return box;
    const read = async () => {
      const power = await backend.power((await this.#stamped(box, options.signal)).guest!, options.signal);
      options.seen?.(power);
      return power;
    };
    let power = options.power !== undefined ? options.power : await read();
    // A listing's power can be older than the box, which may have started or
    // stopped since, and a provider's listing can lag (Proxmox's by about
    // 10 s). Before such a reading changes the box, ask about the guest itself.
    if (options.power !== undefined) {
      const current = await this.#read(box.threadId, box.id);
      if (current && Object.keys(observed(current, power, options.moving)).length) power = await read();
    }
    let unrequested = false;
    let startedOutside = false;
    const updated = await this.update(box, (current) => {
      if (current.restoring) return {};
      const change = observed(current, power, options.moving);
      // A ready box stops through stop(), which moves it to stopping first: one that did not was not asked (#406).
      unrequested = current.state === "ready" && change.state === "stopped";
      startedOutside = current.state === "stopped" && change.state === "ready";
      return change;
    });
    if (startedOutside && updated) {
      this.#event(updated, "start-asked", BY_OUTSIDE);
      this.#event(updated, "started", BY_OUTSIDE);
    }
    if (!unrequested || !updated) return updated;
    return this.#stoppedUnrequested(updated, options.signal, this.#openStop(updated));
  }

  /**
   * The box with its guest as its backend keeps it now. The guest of a box
   * recorded before install IDs gets this install recorded on it first
   * (018), so the backend's checks know the box.
   */
  async #stamped(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const guest = box.guest;
    const backend = this.#deps.backends.get(box.backend);
    if (!guest || !backend?.stamp || guest.data?.box !== undefined) return box;
    const stamped = await backend.stamp(box.id, guest, signal);
    const updated = await this.update(box, (current) => (current.guest?.ref === guest.ref ? { guest: stamped } : {}));
    return updated ?? { ...box, guest: stamped };
  }

  /** Grants a program in a ready box macOS permissions (058). */
  async grant(threadId: string, ref: string, request: GrantRequest, signal?: AbortSignal): Promise<{ box: BoxRecord; answer: GrantAnswer }> {
    const box = await this.get(threadId, ref);
    if (inSlot(box)) throw new BoxError("unsupported", grantRefusal(box.kind));
    const backend = this.#backend(box);
    if (!backend.grant) throw new BoxError("unsupported", `${box.backendLabel} cannot grant macOS permissions: only Tart's macOS boxes and Macs of the SSH host pool with SIP off can.`);
    this.#require(box, "ready");
    try {
      return { box, answer: await backend.grant(box.guest!, request, signal) };
    } catch (error) {
      if (error instanceof BackendError && error.code === "unsupported") throw new BoxError("unsupported", error.message.replaceAll(box.guest!.ref, box.name));
      throw error;
    }
  }

  /** A ready box's grants, or null where its backend does not say. */
  async grants(box: BoxRecord, signal?: AbortSignal): Promise<BoxGrants | null> {
    const backend = this.#deps.backends.get(box.backend);
    if (!backend?.grants || box.state !== "ready" || !box.guest) return null;
    return backend.grants(box.guest, signal).catch(() => null);
  }

  async restartDeviceServer(box: BoxRecord, signal?: AbortSignal): Promise<boolean> {
    const backend = this.#deps.backends.get(box.backend);
    if (!inSlot(box) || !box.guest || !backend?.restartDeviceServer) return false;
    await backend.restartDeviceServer(box.guest, signal);
    return true;
  }

  encoderOf(box: BoxRecord): EncoderPlace | null {
    const backend = this.#deps.backends.get(box.backend);
    if (!box.guest || !backend?.encoderOf) return null;
    const place = backend.encoderOf(box.guest);
    return place ? { mac: encoderKey(backend.id, place.mac), label: place.mac, chip: place.chip, hardware: place.hardware ?? null, cores: place.cores ?? null } : null;
  }

  async probeEncoder(key: string, signal: AbortSignal): Promise<number | null> {
    const { backend: id, mac } = encoderKeyParts(key);
    const backend = this.#deps.backends.get(id);
    return backend?.probeEncoder ? backend.probeEncoder(mac, signal) : null;
  }

  /** The transports that reach a ready box. */
  async transports(box: BoxRecord): Promise<BoxTransports> {
    this.#require(box, "ready");
    return this.#backend(box).transports(box.guest!, box.kind);
  }

  async #command(box: BoxRecord): Promise<CommandTransport> {
    const { command } = await this.transports(box);
    if (!command) throw new BoxError("unsupported", `bb-box cannot run commands in box ${box.name}: its kind has no command transport.`);
    return command;
  }

  /** Turns an unreachable box into a message that says why, after checking its power. */
  async #reach<T>(box: BoxRecord, task: (transport: CommandTransport) => Promise<T>, signal?: AbortSignal): Promise<T> {
    const transport = await this.#command(box);
    let result: T;
    try {
      result = await task(transport);
    } catch (error) {
      if (!(error instanceof TransportError) || error.code !== "unreachable") throw error;
      const reconnecting = this.#deps.reconnecting?.(box) ?? null;
      if (reconnecting) throw new BoxError("reconnecting", `Box ${box.name} does not answer yet: ${reconnecting}`);
      const reach = this.#deps.reach;
      if (reach?.notAnswering(box.id)) throw new BoxError("unreachable", `Box ${box.name} does not answer. ${error.message}`);
      const current = await this.#observe(box, { signal }).catch(() => null);
      if (current && current.state !== "ready") this.#require(current, "ready");
      reach?.failed(current ?? box, error.message);
      throw new BoxError("unreachable", `Box ${box.name} is running but does not answer. ${error.message}`);
    }
    this.#deps.reach?.answered(box);
    return result;
  }

  /**
   * Runs a script in the box's shell, with the thread's environment. A box
   * still enrolling gets a few seconds to finish, so the command has the
   * thread's access. In a Linux or Windows box the timeout stops the script
   * and everything it started, and the local one is a backstop.
   */
  async run(
    threadId: string,
    ref: string,
    script: string,
    options: {
      stdin?: string | Uint8Array;
      timeoutMs?: number;
      cwd?: string;
      /** "desktop" runs the command in the box's logged-in desktop session, so it can open windows. */
      session?: Session;
      signal?: AbortSignal;
      maxOutputBytes?: number;
      /** False runs at once in a box that is enrolling. */
      waitForEnrolment?: boolean;
      /** Called once the env file's contents are worked out, as the command goes to the box. */
      onSend?: () => void;
      /** A job ID: the command leaves its result in the box, for job(), if it outlives bb-box (#405). */
      job?: string;
    } = {},
  ): Promise<{ box: BoxRecord; result: RunResult }> {
    const found = await this.get(threadId, ref);
    const box = options.waitForEnrolment === false ? found : await this.enrolled(found, options.signal);
    const capabilities = box.capabilities;
    if (options.session === "desktop" && !desktopDisplays(capabilities.displays).length) {
      throw new BoxError("unsupported", inSlot(box) ? noDesktopRefusal(box.name, box.kind) : `Box ${box.name} has no desktop. Run the command without session "desktop", or use a desktop box.`);
    }
    // A transport that already runs commands in the desktop session needs no wrapper.
    const session = options.session === "desktop" && !capabilities.command?.inDesktopSession ? "desktop" : "default";
    const env = await this.#envFile(box);
    // A Windows command in the desktop session runs through a scheduled task, which has no job yet.
    const jobs = options.job && !(capabilities.os === "windows" && session === "desktop") ? this.#jobsOf(box.id) : null;
    const job = jobs && options.job ? { id: options.job, forget: [...jobs.received], prune: !jobs.pruned } : undefined;
    options.onSend?.();
    // Every box stops a command at its timeout itself; bb-box's own comes a moment later.
    const inBox = options.timeoutMs;
    const result = await this.#reach(
      box,
      (transport) =>
        transport.run(command(capabilities.os, script, { cwd: options.cwd, session, env, timeoutMs: inBox, job }), {
          stdin: options.stdin,
          timeoutMs: inBox === undefined ? options.timeoutMs : inBox + LOCAL_TIMEOUT_GRACE_MS,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
    if (jobs && job) {
      for (const id of job.forget) jobs.received.delete(id);
      jobs.received.add(job.id);
      jobs.pruned = true;
    }
    const stopped = inBox !== undefined && timedOutExits(capabilities.os).includes(result.exitCode ?? -1) && result.durationMs >= inBox;
    return { box, result: stopped ? { ...result, timedOut: true } : result };
  }

  #jobsOf(boxId: string): { readonly received: Set<string>; pruned: boolean } {
    let jobs = this.#jobs.get(boxId);
    if (!jobs) this.#jobs.set(boxId, (jobs = { received: new Set(), pruned: false }));
    return jobs;
  }

  /**
   * Runs a short script of bb-box's own in the box, as for a desktop's
   * clipboard (#464): with no wait for enrolment and without writing the
   * thread's environment first, so it takes one round trip. "desktop" runs
   * it in the box's logged-in desktop session.
   */
  async runOwn(box: BoxRecord, script: string, options: { session?: Session; stdin?: string | Uint8Array; timeoutMs: number; maxOutputBytes?: number; signal?: AbortSignal }): Promise<RunResult> {
    const capabilities = box.capabilities;
    const session = options.session === "desktop" && !capabilities.command?.inDesktopSession ? "desktop" : "default";
    return this.#reach(
      box,
      (transport) =>
        transport.run(command(capabilities.os, script, { session, timeoutMs: options.timeoutMs }), {
          stdin: options.stdin,
          timeoutMs: options.timeoutMs + LOCAL_TIMEOUT_GRACE_MS,
          signal: options.signal,
          maxOutputBytes: options.maxOutputBytes,
        }),
      options.signal,
    );
  }

  async spawnOwn(box: BoxRecord, script: string, options: { session?: Session; signal?: AbortSignal } = {}): Promise<ByteChannel> {
    const capabilities = box.capabilities;
    const session = options.session === "desktop" && !capabilities.command?.inDesktopSession ? "desktop" : "default";
    return this.#reach(
      box,
      async (transport) => {
        if (!transport.spawn) throw new BoxError("unsupported", `bb-box cannot keep a process running in box ${box.name}: its commands cannot.`);
        return transport.spawn(command(capabilities.os, script, { session }), options.signal);
      },
      options.signal,
    );
  }

  /**
   * Job `id` in a box, which a command left when bb-box
   * restarted (#405): once it has ended, its exit code and output, which the
   * box's next command then removes; while it runs, the end of its output
   * so far; null when the box has no such job.
   */
  async job(threadId: string, ref: string, id: string, options: { signal?: AbortSignal; maxOutputBytes?: number } = {}): Promise<{ box: BoxRecord; job: JobResult | null }> {
    const box = await this.get(threadId, ref);
    const maxOutputBytes = options.maxOutputBytes ?? 128 * 1024;
    const result = await this.#reach(
      box,
      (transport) => transport.run(jobScript(id, maxOutputBytes / 2, box.capabilities.os), { timeoutMs: 30_000, signal: options.signal, maxOutputBytes }),
      options.signal,
    );
    if (result.exitCode === 3) return { box, job: null };
    if (result.exitCode === 4) return { box, job: { state: "running", stdout: result.stdout, stderr: result.stderr } };
    const newline = result.stdout.indexOf("\n");
    const exitCode = Number(result.stdout.slice(0, newline));
    if (result.exitCode !== 0 || newline < 0 || !Number.isInteger(exitCode)) {
      throw new BoxError("unreachable", `Reading job ${id} in box ${box.name} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
    }
    this.#jobsOf(box.id).received.add(id);
    return { box, job: { state: "ended", exitCode, stdout: result.stdout.slice(newline + 1), stderr: result.stderr, truncated: result.truncated } };
  }

  async writeAccess(box: BoxRecord, signal?: AbortSignal): Promise<void> {
    const env = await this.#envFile(box);
    if (env === undefined) throw new BoxError("unreachable", `bb-box could not work out the access of box ${box.name}, so it wrote no access file there.`);
    const os = box.capabilities.os;
    const digest = createHash("sha256").update(env).digest("hex");
    const check = os === "windows" ? ":" : `[ "$(sha256sum < "$HOME/${envFile(os)}" | cut -d' ' -f1)" = ${digest} ]`;
    const transport = (await this.#backend(box).transports(box.guest!, box.kind)).command;
    if (!transport) throw new BoxError("unsupported", `bb-box cannot run commands in box ${box.name}: its kind has no command transport.`);
    const result = await transport.run(command(os, check, { env }), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 });
    if (result.exitCode !== 0) throw new BoxError("unreachable", `Writing the access file of box ${box.name} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
  }

  rejoining(boxId: string): Promise<void> | null {
    return this.#reconnects.get(boxId) ?? null;
  }

  machineBack(box: BoxRecord): boolean {
    if (box.enrol.state !== "enrolled" || !this.#deps.reconnect) return false;
    this.#waitFor(box.id, this.#deps.reconnect(box).catch((error) => this.#deps.logError("reconnect", error)));
    return true;
  }

  /** Where commands in an enrolled box take the thread's access from, if from anywhere. */
  async access(box: BoxRecord): Promise<Access | undefined> {
    return (await this.#deps.access?.(box)) ?? undefined;
  }

  /**
   * Waits a while for a box that is enrolling to finish, or for its BB
   * machine to reconnect after a start, and returns it as it is then.
   */
  #joinUnsettled(box: BoxRecord): boolean {
    return (box.enrol.state === "enrolling" && !waitingToJoin(box)) || (box.enrol.state === "failed" && !!this.#deps.tryingToJoin?.(box.id));
  }

  async enrolled(box: BoxRecord, signal?: AbortSignal): Promise<BoxRecord> {
    const deadline = this.#now() + (this.#deps.enrolWaitMs ?? ENROL_WAIT_MS);
    const reconnect = this.#reconnects.get(box.id);
    if (reconnect) {
      await within(reconnect, deadline - this.#now(), signal);
      box = (await this.find(box.id)) ?? box;
    }
    while (box.state === "ready" && this.#joinUnsettled(box) && this.#now() < deadline && !signal?.aborted) {
      await new Promise((resolve) => setTimeout(resolve, ENROL_POLL_MS));
      box = (await this.find(box.id)) ?? box;
    }
    return box;
  }

  /**
   * The env file for a box: who it is, and once BB knows it as a machine,
   * where to take the thread's access from. Undefined leaves the file as it
   * is, when the access cannot be worked out.
   */
  async #envFile(box: BoxRecord): Promise<string | undefined> {
    const variables: Record<string, string> = {
      BB_BOX_ID: box.id,
      BB_BOX_NAME: box.name,
      BB_BOX_KIND: box.kind,
      BB_THREAD_ID: box.threadId,
    };
    const hostId = box.enrol.hostId;
    if (!hostId) return envScript(box.capabilities.os, variables);
    variables.BB_HOST_ID = hostId;
    try {
      return envScript(box.capabilities.os, variables, await this.access(box));
    } catch (error) {
      this.#deps.logError("access", error);
      return undefined;
    }
  }

  /** Writes a file in the box. A relative path is under the box user's home. */
  async writeFile(
    threadId: string,
    ref: string,
    path: string,
    data: Uint8Array,
    options: { mode?: string; signal?: AbortSignal } = {},
  ): Promise<BoxRecord> {
    const box = await this.get(threadId, ref);
    await this.#reach(box, (transport) => transport.writeFile(path, data, options), options.signal);
    return box;
  }

  async readFile(
    threadId: string,
    ref: string,
    path: string,
    options: { maxBytes: number; signal?: AbortSignal },
  ): Promise<{ box: BoxRecord; data: Uint8Array }> {
    const box = await this.get(threadId, ref);
    const data = await this.#reach(box, (transport) => transport.readFile(path, options), options.signal);
    return { box, data };
  }

  /** Runs `task` with the box's command transport, saying why when the box does not answer, as for box_copy's streamed copies (#492). */
  async reach<T>(threadId: string, ref: string, task: (transport: CommandTransport, box: BoxRecord) => Promise<T>, signal?: AbortSignal): Promise<{ box: BoxRecord; result: T }> {
    const box = await this.get(threadId, ref);
    return { box, result: await this.#reach(box, (transport) => task(transport, box), signal) };
  }

  /**
   * The safety net, run at start and every few minutes. In order: releases
   * the boxes of threads that ended, finishes interrupted releases and
   * acquires, restores the records of guests whose record was lost, releases
   * guests no box can own, checks power, keeps the spares, and lets each
   * backend do its upkeep. Nothing is released for age or idleness, and no
   * guest because its record is missing: only when BB says its thread was
   * archived or deleted, at this sweep and the last. One answer is not
   * enough to take a live thread's boxes. Spares belong to no thread, so
   * their thread lives.
   */
  async sweep(signal?: AbortSignal): Promise<SweepReport> {
    const own: ThreadAnswer = { state: "live", said: "bb-box's own" };
    const liveness = new Map<string, Promise<ThreadAnswer>>([
      [SPARES, Promise.resolve(own)],
      [OPERATOR, Promise.resolve(own)],
    ]);
    const thread = (threadId: string) => {
      let answer = liveness.get(threadId);
      if (!answer) {
        answer = this.#ask(threadId);
        liveness.set(threadId, answer);
      }
      return answer;
    };
    // "ended" once BB has said so at two sweeps running, "ending" at the first.
    // A thread BB returns archived or deleted and one it does not find count alike.
    const before = this.#ending;
    const ending = (this.#ending = new Set<string>());
    const verdict = async (threadId: string): Promise<{ state: "live" | "unknown" | "ending" | "ended"; said: string }> => {
      const { state, said } = await thread(threadId);
      if (state === "live" || state === "unknown") return { state, said };
      ending.add(threadId);
      return { state: before.has(threadId) ? "ended" : "ending", said };
    };
    let released = 0;
    let leftovers = 0;
    let adopted = 0;
    let kept = 0;
    let waiting = 0;
    let resumed = 0;
    let guarded = 0;

    // First, as at the first start after an upgrade: this install's ID goes on
    // the guests of its boxes from before install IDs, which held() and the
    // backends' checks look for (018).
    for (const box of await this.all()) {
      signal?.throwIfAborted();
      if (!box.guest || box.guest.data?.box !== undefined || this.#work.has(box.id)) continue;
      await this.#stamped(box, signal).catch((error) => this.#deps.logError("sweep", error));
    }

    for (const box of await this.all()) {
      signal?.throwIfAborted();
      if (this.#work.has(box.id)) continue;
      try {
        if (box.state === "releasing") {
          resumed++;
          this.#deps.log?.(`Releasing ${describeBox(box)} again: its release had not finished.`);
          await this.#chain(box.id, () => this.#finishRelease(box, undefined, { observeFirst: true }));
          continue;
        }
        const { state, said } = await verdict(box.threadId);
        if (state === "ended") {
          if (this.#holdsNothing(box)) await this.#forget(box);
          else if ((await this.#release(box, `BB says its thread ended, at this sweep and the last. BB's answer: ${said}`)) === null) released++;
          continue;
        }
        if (state === "ending") {
          waiting++;
          this.#deps.log?.(`Kept ${describeBox(box)}: BB says its thread ended, and the next sweep releases it if BB says so again. BB's answer: ${said}.`);
        }
        if (box.state === "failed" && box.fork && box.guest) {
          await this.#chain(box.id, () => this.#retryForkCleanup(box));
          continue;
        }
        if (isAcquiring(box) && box.readyAt === null) {
          resumed++;
          this.#startAcquire(box);
        }
      } catch (error) {
        this.#deps.logError("sweep", error);
      }
    }

    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      let held: HeldGuest[];
      try {
        held = await backend.held(signal);
      } catch (error) {
        this.#deps.logError(`sweep ${backend.id}`, error);
        await this.#backendSilent(backend.id, describeError(error, `Listing the boxes on ${backend.label}`));
        continue;
      }
      await this.#backendAnswered(backend.id);
      // Read after held(): a guest there was claimed, so recorded, before.
      const records = (await this.all()).filter((box) => box.backend === backend.id);
      const byRef = new Map<string, BoxRecord[]>();
      for (const box of records) if (box.guest) byRef.set(box.guest.ref, [...(byRef.get(box.guest.ref) ?? []), box]);
      /** Boxes whose guest held() listed. */
      const seen = new Set<string>();
      for (const guest of held) {
        signal?.throwIfAborted();
        try {
          // A reused reference may hold another box's guest now. Only an acquire's guest may not name its box yet.
          const record = byRef.get(guest.ref)?.find((box) => (guest.owner ? box.id === guest.owner.boxId : isAcquiring(box)));
          if (record) {
            seen.add(record.id);
            if (record.resize?.state === "resizing" && !this.#work.has(record.id)) await this.#resizeCutShort(backend, record, guest.size, signal);
            if ((record.userspaceUpdate?.state === "updating" || record.userspaceUpdate?.state === "unknown") && !this.#work.has(record.id)) await this.#userspaceUpdateCutShort(record, signal);
            if (!this.#work.has(record.id)) await this.#observe(record, { signal, power: guest.power });
            // A ready box whose guest still has what its start lowered, as when bb-box restarted while it started (#888).
            // A spare keeps it until a box takes it.
            if (guest.settling && record.readyAt !== null && record.threadId !== SPARES && !this.#work.has(record.id)) {
              await backend.settle?.(guest, signal).catch((error) => this.#deps.logError("put a box's CPU weight back", error));
            }
            continue;
          }
          const owner = guest.owner;
          if (!owner) {
            // An acquire interrupted before its guest named a box: no box can own it.
            if (await this.#releaseLeftover(backend, guest, "it names no box", signal)) leftovers++;
            else guarded++;
            continue;
          }
          const owned = records.find((box) => box.id === owner.boxId);
          if (owned) {
            // Its box has another guest now, or none, as after an acquire that tried again or failed.
            if (isAcquiring(owned) || this.#work.has(owned.id)) continue;
            if (await this.#releaseLeftover(backend, guest, `its box ${owned.name} ${owned.guest ? `has guest ${owned.guest.ref} now` : "holds no guest"}`, signal)) leftovers++;
            else guarded++;
            continue;
          }
          // Its record was lost, as when bb-box lost its storage. The guest
          // names its box and thread, so it goes only when the thread ended.
          const { state, said } = await verdict(owner.threadId);
          if (state === "live") {
            if (await this.#restore(backend, guest, signal)) adopted++;
          } else if (state === "ended") {
            if (await this.#releaseLeftover(backend, guest, `its box's thread ${owner.threadId} ended, as BB says at this sweep and the last. BB's answer: ${said}`, signal, true)) leftovers++;
            else guarded++;
          } else if (state === "ending") {
            this.#deps.log?.(`Kept guest ${guest.ref} of box ${owner.boxId} without a record: BB says thread ${owner.threadId} ended, and the next sweep releases the guest if BB says so again. BB's answer: ${said}.`);
            waiting++;
          } else {
            this.#deps.log?.(`Kept guest ${guest.ref} of box ${owner.boxId} without a record: BB did not say whether thread ${owner.threadId} still exists. BB's answer: ${said}.`);
            kept++;
          }
        } catch (error) {
          this.#deps.logError("sweep", error);
        }
      }
      for (const box of records) {
        if (!box.guest || seen.has(box.id) || this.#work.has(box.id)) continue;
        if (box.state !== "ready" && box.state !== "stopped") continue;
        await this.#observe(box, { signal }).catch((error) => this.#deps.logError("sweep", error));
      }
      for (const box of records) {
        if (!box.restoredAt || !seen.has(box.id) || this.#work.has(box.id)) continue;
        await this.#enrolAnswering(backend, box, signal).catch((error) => this.#deps.logError("sweep", error));
      }
    }

    signal?.throwIfAborted();
    await this.keepSpares();

    await this.#tellOfEnds(signal);

    // Every built backend, off ones too: an off backend's warm counts read 0, so its upkeep retires its warm guests (029).
    const boxes = await this.all();
    for (const backend of this.#deps.backends.active()) {
      signal?.throwIfAborted();
      const recordedGuests = new Set(boxes.flatMap((box) => (box.backend === backend.id && box.guest ? [box.guest.ref] : [])));
      await backend.maintain?.(signal, recordedGuests).catch((error) => this.#deps.logError(`maintain ${backend.id}`, error));
    }
    return { released, leftovers, adopted, kept, ending: waiting, resumed, guarded };
  }

  async #tellOfEnds(signal?: AbortSignal): Promise<void> {
    const tell = this.#deps.tell;
    if (!tell) return;
    const now = this.#now();
    for (const box of await this.all()) {
      signal?.throwIfAborted();
      const endsAt = box.guest?.endsAt;
      if (endsAt === undefined || box.endToldAt || !ownedByThread(box.threadId)) continue;
      if (box.state !== "ready" && box.state !== "stopped") continue;
      if (endsAt <= now || endsAt - now > END_NOTICE_MS) continue;
      try {
        await tell(box.threadId, endingWords(box, endsAt, now));
        await this.update(box, () => ({ endToldAt: now }));
      } catch (error) {
        this.#deps.logError(`tell thread ${box.threadId} that box ${box.name} ends`, error);
      }
    }
  }

  /** Enrols a restored box whose guest did not answer at the restore, once it runs and answers (026). */
  async #enrolAnswering(backend: Backend, box: BoxRecord, signal?: AbortSignal): Promise<void> {
    if (!(await this.#enrols(box))) return;
    await this.#chain(box.id, async () => {
      const current = await this.#read(box.threadId, box.id);
      if (current?.state !== "ready" || !current.restoredAt || !current.guest) return;
      if (!(await this.#answers(backend, current.guest, current.kind, signal))) return;
      this.#deps.log?.(`Restored box ${current.name} of thread ${current.threadId} answers now, so it enrols again.`);
      const answering = current.error === SILENT ? await this.update(current, () => ({ error: null })) : current;
      if (answering) await this.#enrol(answering, { restored: true });
    });
  }

  async #releaseLeftover(backend: Backend, guest: HeldGuest, reason: string, signal?: AbortSignal, ended = false): Promise<boolean> {
    const named = `guest ${guest.ref}${guest.owner ? ` of box ${guest.owner.boxId}` : ""}`;
    const copying = ended ? ((await this.#deps.holdKeptOn?.(backend.id, guest.ref, guest.owner?.boxId ?? null)) ?? null) : null;
    const keep = copying ?? this.#deps.keepsGuest?.(backend.id, guest.ref, ended) ?? null;
    if (keep) {
      this.#deps.log?.(`Kept ${named}, which no box records and ${reason}: ${keep}.`);
      return false;
    }
    this.#deps.log?.(`Releasing ${named}, which no box records: ${reason}.`);
    await backend.release(guest, QUIET, signal);
    this.#deps.leftoverReleased?.(backend.id, guest.ref, guest.owner?.boxId ?? null, reason);
    return true;
  }

  /**
   * Rebuilds the record of a live thread's guest, for example after storage
   * was lost, from what the guest names: its box, thread, name, kind and
   * creation, with its reference, address and data. A running guest is ready
   * when its command transport answers, and enrols again as a BB machine with
   * the same key, so BB gives back the machine it still has (025). Any other
   * enrols later, once it runs and answers (026). A box that is BB's machine
   * for its thread, as a "New box", is that machine again and never enrols.
   */
  async #restore(backend: Backend, held: HeldGuest, signal?: AbortSignal): Promise<boolean> {
    const { owner: found, power, ...guest } = held;
    const owner = found!;
    const asked = kindRequest(owner.kind ?? "unknown");
    const kindId = asked.kind;
    const kind = this.#offeredKinds(backend).find((candidate) => candidate.id === kindId);
    const answers = power === "stopped" ? false : await this.#answers(backend, guest, kindId, signal);
    const yours = owner.threadId === OPERATOR;
    const projectId = yours ? null : ((await this.#deps.projectOf?.(owner.threadId).catch(() => null)) ?? null);
    // A thread's own box is BB's machine for the thread still, and must not
    // enrol as another (#127). When BB does not say, the guest waits for the next sweep.
    const machine = yours ? null : ((await this.#deps.machineOf?.(owner.boxId)) ?? null);
    const restored = await this.#locked(owner.threadId, async () => {
      if (await this.#read(owner.threadId, owner.boxId)) return null;
      const existing = await this.list(owner.threadId);
      const taken = new Set(existing.map((box) => box.name));
      const fits = (name: string) => (yours ? isMachineName(name) : isFriendlyName(name)) && !taken.has(name);
      const name = owner.name && fits(owner.name) ? owner.name : generateName(await this.#liveNames(taken), this.#random);
      const box: BoxRecord = {
        id: owner.boxId,
        threadId: owner.threadId,
        projectId,
        name,
        kind: kindId,
        kindLabel: kind?.label ?? (owner.kind ? kindId : "Unknown kind"),
        requires: [...new Set([...(kind?.requires ?? []), ...asked.features])],
        capabilities: kind?.capabilities ?? UNKNOWN_KIND,
        backend: backend.id,
        backendLabel: backend.label,
        nature: backend.nature,
        role: machine ? "machine" : "box",
        guest,
        state: power === "stopped" ? "stopped" : "ready",
        error: power === "stopped" || answers ? null : SILENT,
        createdAt: owner.createdAt ?? this.#now(),
        readyAt: owner.createdAt ?? this.#now(),
        releaseRequestedAt: null,
        resetAt: null,
        timings: {},
        enrol: machine ? { state: "enrolled", hostId: machine, error: null } : { state: "off", hostId: null, error: null },
        restoredAt: machine ? null : this.#now(),
      };
      await this.#deps.kv.set(indexKey(box.id), box.threadId);
      return this.#write(box);
    });
    if (restored) {
      this.#deps.log?.(`Restored box ${restored.name} of thread ${restored.threadId} from guest ${guest.ref}, whose record was lost${machine ? ", as the thread's machine" : ""}. It is ${restored.state}.`);
      // Only a running guest answers.
      if (answers) await this.#enrol(restored, { restored: true }).catch((error) => this.#deps.logError("enrol", error));
    }
    return restored !== null;
  }

  /** Whether a guest's command transport answers, for a box being restored. */
  async #answers(backend: Backend, guest: Guest, kind: string, signal?: AbortSignal): Promise<boolean> {
    try {
      const { command } = await backend.transports(guest, kind);
      return command ? await command.probe(signal) : true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }

  /** True once dispose() has begun, as bb-box restarts. */
  get stopping(): boolean {
    return this.#disposed;
  }

  /** Cancels acquires in progress, which a restart then resumes, and waits for running tasks. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    for (const controller of this.#acquiring.values()) controller.abort(new BoxError("released", "bb-box is stopping."));
    for (const controller of this.#updating.values()) controller.abort(new BoxError("restarting", "bb-box is stopping."));
    await this.idle();
  }
}
