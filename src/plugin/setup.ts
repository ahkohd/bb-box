// Wires bb-box into BB: its configuration, the active backends, the box registry,
// enrolment, thread events, the sweep, and the tools, RPC and CLI that use
// them. server.ts calls setup with the built-in drivers; tests pass fakes.

import { tailnetDoctor } from "../core/tailnet-doctor.ts";
import { hostname } from "node:os";
import { machineAccessProblem, machineSetups, type AccessConfig, type MachineAccessProblem, type MachineSetup } from "./setup-offer.ts";
import type { SetupFacts } from "../host/relay.ts";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import packageJson from "../../package.json" with { type: "json" };
import { Backends, DRIVERS, offerChecks, overlapChecks } from "../backends/index.ts";
import { providerName } from "../core/provider-name.ts";
import type { BackendDriver, DoctorReport, GuestOs, MachineAccess } from "../backends/types.ts";
import { warmChecks } from "../backends/warm.ts";
import { pinsDigest, type ImageFacts } from "../backends/images.ts";
import { resolveVersions, type Versions } from "../backends/versions.ts";
import { ImageBakes } from "./bakes.ts";
import { BoxFiles } from "./box-files.ts";
import { ImageJobs } from "./images.ts";
import { namedImage, projectImage, withImage } from "../core/project-images.ts";
import { BoxError, Boxes, SPARES, type BoxRecord, type ThreadAnswer , type ResizeAnswer } from "../core/boxes.ts";
import type { SizeRequest } from "../core/sizes.ts";
import { boxFiles as boxFilesOf } from "../core/box-files.ts";
import { Computer, swayKeyboardScript, swayRestoreScript, swayStageScript, type ComputerDeps } from "../core/computer.ts";
import { DeviceComputer } from "../core/device-computer.ts";
import type { GeneralConfig } from "../core/config.ts";
import { GENERAL_DEFAULTS, emptyDocument, type BackendConfig, type ConfigDocument, type ImageConfig } from "../core/document.ts";
import { INSTALL_ID_KEY, loadInstallId, requireInstallId, storeInstallId } from "../core/install.ts";
import { CLEARED_KEY, DOCUMENT_KEY, clearSettings, earlierSettings, moveSettings } from "../core/move.ts";
import { LINUX_LEAST_MEMORY_GIB, presetMemoryChecks } from "../core/sizes.ts";
import type { ControlView } from "../core/control.ts";
import { Configuration, boundedDoctor, type ApplyResult } from "./configuration.ts";
import { agentFor } from "./agents.ts";
import { registerCli } from "./cli.ts";
import { registerComputerTools } from "./computer-tools.ts";
import { registerDeviceTools } from "./device-tools.ts";
import { registerDesktop, type Desktops } from "./desktop.ts";
import { LoopWatch } from "./loop-watch.ts";
import { sweepStaleTempFolders } from "../core/temp-folders.ts";
import { stopForker } from "../transports/forker.ts";
import { forPurpose, spawnTotals, takeLongestSpawn } from "../transports/spawns.ts";
import { registerTerminals, type Terminals } from "./terminal.ts";
import { Enrolment, MACHINE_PROVIDER_ID, type HostApi } from "./enrol.ts";
import { CALL_TIMEOUT_MS, Holders, RETIRED_TITLE, type RetiredTerminals } from "./holder.ts";
import { DockerCli, type DockerInfo } from "../backends/docker/cli.ts";
import { dockerDriver } from "../backends/docker/index.ts";
import { backendPart } from "../core/document.ts";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { setupDir } from "../backends/setup-dir.ts";
import { RELAY_ROUTE, RelayHub } from "../relay/hub.ts";
import { FILE_ROUTE, FileRelay } from "../relay/files.ts";
import { MSB_ROUTE, msbClientArgv, refuseMsb } from "../relay/msb.ts";
import { NAME_WINDOWS_SCRIPT, parseNamed } from "../backends/windows.ts";
import { abortable } from "../core/abortable.ts";
import { DESKTOP_ON_DEMAND, DockerHosts, backendOn, desktopsOnDemand, machineOffline, withDesktopImage, withDockerHost, withoutDesktopImage, type DesktopOnDemandKind, type MachineRecord, MachineNames, MachinePlatforms } from "./docker-hosts.ts";
import { bbAppDigest, DockerImages, outdated } from "./docker-images.ts";
import { hostContract } from "../host/contract.ts";
import { Refreshing } from "./refreshing.ts";
import type { DesktopOnDemandView, ThreadOnBox } from "./contract.ts";
import { dockerKind } from "../backends/docker/backend.ts";
import { NEW_BOX_PROVIDER_ID, newBoxHost, registerNewBox } from "./new-box.ts";
import { registerRpc } from "./rpc.ts";
import { ReloadTimes } from "./reload-times.ts";
import { registerTools } from "./tools.ts";
import { DeviceServers, type DeviceServersDeps } from "./devices.ts";
import { connectScript, deviceServerFiles } from "../core/device-delivery.ts";
import { boxView, gpuRooms, kindViews, threadsWords, type BackendView, type BoxView, type DoctorView, type ImageOptionView, type KindView, type OfferRoom, type ProviderProfile } from "./views.ts";

/** Realtime channel: a thread's boxes, the kinds or the backends changed. The panel refetches. */
export const CHANGED = "changed";

/** In a box that is a BB machine, the program of the process whose workers carry BB's variables. */
const DAEMON_PARENT = "host-daemon/dist/daemon-bundle";
const SWEEP_EVERY_MS = 3 * 60_000;
/** The nightly rebuilds' schedule (049): its name in BB, its time on BB's server, and the hours after which no image starts, as bb box images refresh's default. */
const NIGHTLY_SCHEDULE = "nightly-images";
const NIGHTLY_CRON = "0 3 * * *";
const NIGHTLY_HOURS = 4;
/** How often bb-box looks for a BB update that leaves the images behind. */
const BB_UPDATE_LOOK_MS = 5 * 60_000;
const DOCTOR_TIMEOUT_MS = 30_000;
const ROOM_ANSWER_MS = 6_000;

function withinMs<T>(work: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(null), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function inUseBy(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  const listed = shown.length < 2 ? (shown[0] ?? "") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
  return `In use by ${listed}${rest ? ` and ${rest} more` : ""}`;
}

const SHORT_REASON = 60;

function firstSentence(text: string | null): string | null {
  if (!text) return null;
  const end = text.search(/\.(\s|$)/);
  const sentence = end > 0 ? text.slice(0, end) : text;
  const clause = sentence.indexOf(", ");
  return sentence.length > SHORT_REASON && clause > 0 ? sentence.slice(0, clause) : sentence;
}
/**
 * What BB's daemon gives its workers besides the machine variables: the
 * GitHub token and the user's git identity. A user without GitHub in BB
 * still has the identity, which ends the enrolment's wait for a worker.
 */
const NOTHING_COMES: readonly string[] = [];
const DAEMON_NAMES = ["GH_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
/** How long the names of BB's machine variables are kept before a refresh. */
const NAMES_FRESH_MS = 60_000;
/** How long the host call that opens a Docker relay may take, the worker's start included. */
const RELAY_CALL_TIMEOUT_MS = 15_000;
/** The longest a streamed box_copy may take (#492). */
const FILE_CALL_TIMEOUT_MS = 2 * 60 * 60_000;
/** How long each msb script may run on a BB machine (053), with a minute more for the call. */
const MSB_SCRIPT_TIMEOUT_MS = { install: 11 * 60_000, status: 2 * 60_000, images: 2 * 60_000, import: 31 * 60_000, disk: 90_000, undisk: 2 * 60_000, disks: 90_000, memory: 90_000, oom: 90_000, transfer: 31 * 60_000, retag: 31 * 60_000 } as const;
/** How long BB's word on a machine's connection is trusted, so each docker command does not ask again. */
const MACHINE_STATE_MS = 2_000;
/** bb-box's version, which the move from BB's settings records. */
export const VERSION: string = packageJson.version;

/** What the tools, RPC and CLI work with. */
export interface BbBox {
  readonly boxes: Boxes;
  readonly backends: Backends;
  readonly enrolment: Enrolment;
  /** Desktop viewers and who controls each desktop's input. */
  readonly desktops: Desktops;
  readonly devices: DeviceServers;
  readonly terminals: Terminals;
  /** The agent's computer use of desktop boxes (015). */
  readonly computer: Computer;
  readonly deviceComputer: DeviceComputer;
  /** The configuration document (029). */
  readonly configuration: Configuration;
  /** The Docker API relay to BB machines that are Docker hosts (042). */
  readonly relay: RelayHub;
  /** Streams box_copy's large files through the worker on the thread's machine (#492). */
  readonly files: FileRelay;
  /** BB machines that can host Docker boxes (042). */
  readonly dockerHosts: DockerHosts;
  /** Builds bb-box's images on BB machines that host Docker boxes (042). */
  readonly dockerImages: DockerImages;
  /** What each BB machine offers first-run setup: its Docker, and the one line that fixes what stands in the way. */
  setups(): Promise<MachineSetup[]>;
  /** What stands in the way of boxes joining BB through its machine access, or null. */
  machineAccess(): Promise<MachineAccessProblem | null>;
  /** BB machine `machine`, by ID or name, and its Docker backend, from BB's record and the configuration, with no call to it. */
  dockerHostOf(machine: string): Promise<{ hostId: string; name: string; backend: BackendConfig | null } | null>;
  /** Turns a BB machine on or off as a Docker host (042), through the configuration. */
  setDockerHost(hostId: string, enabled: boolean, linuxOnly?: boolean): Promise<ApplyResult>;
  /** Why the desktop box a thread asked to build first was not made once its image was built, and when, or null. */
  desktopProblem(threadId: string): { message: string; at: number } | null;
  /** The BB machine whose desktop image the New box form can build, with its name, or null for none (the setup plan's PR 4). */
  desktopOnDemand(): Promise<DesktopOnDemandView | null>;
  /**
   * Turns on the desktop image of BB machine `hostId`'s Docker and builds it, then makes a desktop box for the thread
   * once it is built. Returns once the configuration is saved; the panel shows the build.
   */
  buildDesktop(input: { threadId: string; hostId: string; kind?: DesktopOnDemandKind; size?: SizeRequest; name?: string }): Promise<ApplyResult>;
  /** Docker on BB machine `machine`, by ID or name, through the relay, and how long it took. */
  dockerCheck(machine: string, signal?: AbortSignal): Promise<{ hostId: string; name: string; endpoint: string; info: DockerInfo; firstMs: number; againMs: number }>;
  /** What a rebuild of the standard Linux images would take now (049): upstream's latest of the tools that follow it, or with `pinned` the pins alone. */
  imageVersions(options: { pinned?: boolean; signal?: AbortSignal }): Promise<Versions>;
  /** The nightly rebuilds of the standard images (049). */
  readonly imageJobs: ImageJobs;
  readonly imageBakes: ImageBakes;
  /** Sets a project's image in the configuration, or removes it with null (049). */
  setImage(name: string, image: ImageConfig | null): Promise<ApplyResult>;
  general(): Promise<GeneralConfig>;
  view(box: BoxRecord): BoxView;
  /** Who controls a box's desktop. */
  control(box: BoxRecord): ControlView;
  /** With each kind's sizes from bb-box's settings. */
  kinds(): Promise<KindView[]>;
  /** The projects' images a box can choose (049), marked as `project`'s or not, with their projects' names and builds. */
  imageOptions(project: string | null): Promise<ImageOptionView[]>;
  backendViews(): BackendView[];
  /** A provider's profile for the New box form's (i): one capacity call to the provider, made only when asked. */
  providerProfile(backendId: string, signal?: AbortSignal): Promise<ProviderProfile>;
  offerRooms(kindId: string, size?: SizeRequest): Promise<OfferRoom[]>;
  doctor(signal?: AbortSignal): Promise<DoctorView>;
  /**
   * Takes back an install ID this install had before it lost its storage
   * (018). Refused while a box holds a guest, since its guest carries the
   * current ID.
   */
  setInstallId(id: string): Promise<void>;
  /** The machine and directory a thread works in, for copying files to and from its boxes. */
  workspace(threadId: string, signal?: AbortSignal): Promise<{ hostId: string; path: string | null }>;
  /** The thread's own storage folder, $BB_THREAD_STORAGE, and its host (#482); null when BB gives none. */
  threadStorage(threadId: string, signal?: AbortSignal): Promise<{ hostId: string; path: string } | null>;
  /** The storage folders of the thread's parent, its parent's parent and so on, nearest first, up to `limit`. */
  ancestorStorages(threadId: string, limit: number, signal?: AbortSignal): Promise<{ threadId: string; hostId: string; path: string }[]>;
  /** A thread's project, for boxes the panel or the CLI acquires. */
  projectOf(threadId: string): Promise<string | null>;
  /**
   * Starts a child thread of `threadId` on a box's BB machine, with the
   * parent's project, in a worktree of the project's repository there. The
   * first thread on a box clones the repository onto it; BB forgets that
   * clone with the machine. In BB's personal project, which has no
   * repository, the thread gets a personal workspace on the box instead. The thread is archived and deleted with its
   * parent, which is also when the box goes. Returns its ID.
   */
  startThread(input: { threadId: string; box: string; prompt: string; title?: string; signal?: AbortSignal }): Promise<string>;
  /**
   * The box whose BB machine a thread runs on, whoever owns it (036): one
   * of your machines, a "New box", or another thread's box. Null when the
   * thread runs on no box.
   */
  runsOn(threadId: string, signal?: AbortSignal): Promise<BoxRecord | null>;
  /**
   * A box a thread may use: one of its own, or else the box it runs on,
   * with the thread that owns it for the calls that take one.
   */
  resolve(threadId: string, ref: string, signal?: AbortSignal): Promise<{ owner: string; box: BoxRecord; runsOn: boolean }>;
  /** The threads, not archived or deleted, that run on a box's BB machine. */
  threadsOn(box: BoxRecord): Promise<ThreadOnBox[]>;
  /**
   * Refuses, naming them, while threads are working on a box's BB machine:
   * releasing or stopping it would end their work. Returns the idle threads
   * there, which lose their machine, for the answer to name.
   */
  checkInUse(box: BoxRecord, action: "Releasing" | "Stopping" | "Restarting"): Promise<ThreadOnBox[]>;
  /**
   * Refuses a restart of a box for a resize (061) while a person holds its
   * desktop's control, and, unless `force`, while threads are working on
   * its BB machine. Returns the idle threads there.
   */
  checkRestart(box: BoxRecord, force: boolean): Promise<ThreadOnBox[]>;
  /**
   * After a live resize that changed a BB machine's cores (061): BB counts
   * a machine's processors only when its daemon connects, and sets its
   * automatic thread limit from them (BB request 28). Restarts BB's daemon
   * there when no thread works on the machine, as the restart ends a
   * running turn, and says so; otherwise says how to set the limit by hand.
   * Never changes a limit. Null when there is nothing to say.
   */
  machineCores(answer: ResizeAnswer): Promise<string | null>;
}

/**
 * Restarts BB's daemon, a systemd user service, once the box shows its new
 * cores, as the daemon reads the processors as it starts: the wait, up to
 * 15 s, and the restart run on in the box, detached, so the resize answers
 * at once (#916). Exits 3 where there is no daemon, as in a Docker box. Only
 * as a box's own user, whose home is /home/box: never on a machine a test's
 * fake box runs on, whose own daemon it would restart.
 */
export const restartDaemon = (cores: number) => String.raw`[ "$HOME" = /home/box ] || exit 3
unit=$(systemctl --user list-units --plain --no-legend 'bb-host-daemon-*.service' 2>/dev/null | awk '{ print $1; exit }')
[ -n "$unit" ] || exit 3
setsid nohup sh -c 'i=0; while [ "$(nproc)" -ne ${cores} ] && [ $i -lt 15 ]; do sleep 1; i=$((i + 1)); done; systemctl --user restart --no-block "$1"' sh "$unit" </dev/null >/dev/null 2>&1 &`;



function status(error: unknown): { status?: unknown; code?: unknown } {
  return (error ?? {}) as { status?: unknown; code?: unknown };
}

/**
 * Only BB's own answer for a thread that does not exist, or was deleted,
 * counts: a thread that ended loses its boxes. Any other error, another 404
 * included, keeps them.
 */
export function isMissingThread(error: unknown): boolean {
  const { status: code, code: name } = status(error);
  if (name === "thread_not_found") return true;
  return name === undefined && code === 404 && error instanceof Error && /^(HTTP 404: )?Thread not found\.?$/i.test(error.message);
}

/** An error from BB as it came, for the log: its status, code and message. */
export function describeAnswer(error: unknown): string {
  const { status: code, code: name } = status(error);
  return `status ${String(code ?? "none")}, code ${String(name ?? "none")}, message ${JSON.stringify(error instanceof Error ? error.message : String(error))}`;
}

/** A thread's archivedAt or deletedAt as BB sent it, for the log. */
function when(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : String(value);
}

/** Set, as opposed to null or missing. */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Waits `ms`, or until `signal` aborts. A signal that has aborted already
 * ends it at once: its abort event has fired, and would never come again.
 */
/** Commands a project image's script may call at start (049), from the setup files, or none when they are not there. */
function imageTools(setup: string): Record<string, string> {
  try {
    return { "bb-box-feature": readFileSync(join(setup, "proxmox-lxc", "template", "guest", "bb-box-feature.sh"), "utf8") };
  } catch {
    return {};
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

export interface SetupOptions {
  readonly drivers?: readonly BackendDriver<any>[];
  /** Where commands in a box take BB's variables from. Tests give a process of their own. */
  readonly daemonParent?: string;
  /** How long a viewer holding control may be gone before the agent has it again. */
  readonly controlStaleMs?: number;
  readonly devices?: Partial<Pick<DeviceServersDeps, "helloWaitMs" | "idleCloseMs" | "started" | "instance" | "version">>;
  readonly deviceServerRoot?: string;
  /** How long a deploy waits for box_run's commands still running (#405). */
  readonly drainMs?: number;
  /** How long box_run waits before a command goes on as a job (#486). */
  readonly runWaitMs?: number;
  /** How long a viewer holding control has to connect again after the box ended its connection. */
  readonly controlReconnectMs?: number;
  /** How long a terminal session stays with no tab showing it. */
  readonly terminalIdleMs?: number;
  /** How long an enrolment waits for a worker of BB's daemon with the thread's variables. */
  readonly variablesWaitMs?: number;
  /** How long a Windows box's daemon may take to connect by itself after a start, before bb-box runs BB's reconnect (#917). */
  readonly logonWaitMs?: number;
  /** How long an enrolment waits to ask BB again when BB does not know bb-box's machine provider yet. */
  readonly providerRetryMs?: number;
  /** How long a release waits for BB to finish removing a Windows box's manual machine. */
  readonly manualRemoveMs?: number;
  /** setup/docker/build.sh, which builds images on a BB machine (042). By default the one beside the plugin's bundle. */
  readonly dockerBuildScript?: string | null;
  /** Computer use's waits, shorter in tests. */
  readonly computer?: Pick<ComputerDeps, "idleMs" | "pauseWaitMs" | "callTimeoutMs" | "launchWaitMs" | "lookupWaitMs" | "pageWaitMs" | "desktopWaitMs" | "smallTree" | "nameWindows">;
}

function awaitedNames(gitToken: boolean, variablesSet: boolean): readonly string[] | undefined {
  if (gitToken) return ["GH_TOKEN"];
  return variablesSet ? undefined : NOTHING_COMES;
}

export async function setup(bb: BbPluginApi, options: SetupOptions = {}): Promise<BbBox> {
  const drivers = options.drivers ?? DRIVERS;
  const logError = (operation: string, error: unknown) => {
    bb.log.error(`${operation}: ${error instanceof Error ? error.message : String(error)}`);
  };
  const notify = (threadId: string | null) => {
    try {
      bb.realtime.publish(CHANGED, { threadId });
    } catch (error) {
      logError("notify", error);
    }
  };

  // BB's settings move into the configuration document once, before any
  // backend is built (029). The old keys stay declared until they are
  // cleared, and nothing listens to them: once the document exists they
  // drive nothing, so clearing them leaves the backends alone.
  const kv = bb.storage.kv;
  const reloadTimes = new ReloadTimes((message) => bb.log.info(message), kv);
  bb.onDispose(() => reloadTimes.stopped());
  const earlier = earlierSettings(drivers);
  const freshInstall = !(await kv.get<unknown>(DOCUMENT_KEY)) && !(await kv.get<unknown>(INSTALL_ID_KEY));
  if (freshInstall) await kv.set(CLEARED_KEY, { at: Date.now() });
  const settings = (await kv.get<unknown>(CLEARED_KEY)) ? null : bb.settings.define(earlier);
  if (!(await kv.get<ConfigDocument>(DOCUMENT_KEY))) {
    if (settings) {
      const { notes } = await moveSettings({ kv, drivers, values: await settings.get(), settings: earlier, version: VERSION });
      bb.log.info("Moved bb-box's settings into its configuration. bb box config migrated shows what they were.");
      for (const note of notes) bb.log.warn(`Moving bb-box's settings: ${note}`);
    } else {
      // BB's settings were moved and cleared before, so there is nothing to move: start empty, keeping the secrets.
      await kv.set(DOCUMENT_KEY, emptyDocument(1));
    }
  }
  if (settings) await clearSettings(kv, settings, earlier).catch((error) => logError("clear the settings bb-box moved", error));

  // bb-box's host entry on BB machines (src/host/entry.ts).
  const host = bb.hosts.experimental_client({ contract: hostContract });

  // The Docker API relay (042): a socket per BB machine for the docker CLI, each
  // connection a channel on one WebSocket the machine's worker opens out to this route.
  // Each BB machine's name, kept across restarts, and looked up again as bb-box starts.
  const machineNames = new MachineNames(kv);
  await machineNames.load();
  // Each BB machine's OS, as bb-box's host entry there last reported it, kept across restarts.
  const machinePlatforms = new MachinePlatforms(kv);
  await machinePlatforms.load();
  reloadTimes.phase("storage");
  const machineStates = new Map<string, { at: number; connected: boolean | null; offline: string | null }>();
  /**
   * Whether BB shows the machine connected and has heard from it lately, from
   * BB with no call to it, for a moment at a time. Null for no such machine.
   */
  const machineConnected = async (hostId: string): Promise<boolean | null> => {
    const known = machineStates.get(hostId);
    if (known && Date.now() - known.at < MACHINE_STATE_MS) return known.connected;
    let offline: string | null = null;
    let connected: boolean | null;
    try {
      const found = await bb.sdk.hosts.get({ hostId });
      await machineNames.learn(hostId, found.name);
      offline = machineOffline(found, Date.now());
      connected = offline === null;
    } catch (error) {
      if (status(error).status !== 404) throw error;
      connected = null;
    }
    machineStates.set(hostId, { at: Date.now(), connected, offline });
    return connected;
  };
  const offline = (hostId: string, connected: boolean | null) =>
    new Error(
      connected === null
        ? `BB has no machine ${hostId}.`
        : `${machineNames.get(hostId) ?? `BB machine ${hostId}`} ${machineStates.get(hostId)?.offline ?? "is offline in BB."}`,
    );
  const relay = new RelayHub({
    async open(hostId, secret, signal) {
      const connected = await machineConnected(hostId);
      if (connected !== true) throw offline(hostId, connected);
      return host.call("relay", { secret, path: `/api/v1/plugins/${bb.pluginId}/http${RELAY_ROUTE}` }, { hostId, signal, timeoutMs: RELAY_CALL_TIMEOUT_MS });
    },
    // While bb-box has a box on a Docker backend on the machine, its relay stays open.
    async keep(hostId) {
      const ids = new Set(configuration.document.backends.filter((backend) => backend.fields.host === `bb:${hostId}`).map((backend) => backend.id));
      return ids.size > 0 && (await boxes.all()).some((box) => ids.has(box.backend) && box.state !== "gone");
    },
    async offline(hostId) {
      // BB's word now, not a moment ago: this is asked when a relay has gone quiet.
      machineStates.delete(hostId);
      const connected = await machineConnected(hostId);
      return connected === true ? null : offline(hostId, connected).message;
    },
    logError,
    log: (message) => bb.log.info(message),
  });
  bb.http.experimental_websocket(RELAY_ROUTE, ({ url }) => relay.route(url), { auth: "none" });
  const fileRelay = new FileRelay({
    call: (hostId, request, signal) => host.call("file", { ...request, path: `/api/v1/plugins/${bb.pluginId}/http${FILE_ROUTE}` }, { hostId, signal, timeoutMs: FILE_CALL_TIMEOUT_MS }),
    logError,
  });
  bb.http.experimental_websocket(FILE_ROUTE, ({ url }) => fileRelay.route(url), { auth: "none" });
  bb.onDispose(() => relay.dispose());
  // The msb relay (053): as the Docker relay, with a channel per run of
  // bb-box's msb on the machine, for its msb client here.
  const msbRelay = new RelayHub({
    what: "msb",
    refuse: refuseMsb,
    async open(hostId, secret, signal) {
      const connected = await machineConnected(hostId);
      if (connected !== true) throw offline(hostId, connected);
      return host.call("msbRelay", { secret, path: `/api/v1/plugins/${bb.pluginId}/http${MSB_ROUTE}` }, { hostId, signal, timeoutMs: RELAY_CALL_TIMEOUT_MS });
    },
    // While bb-box has a box on a microsandbox backend on the machine, its relay stays open.
    async keep(hostId) {
      const ids = new Set(configuration.document.backends.filter((backend) => backend.type === "microsandbox" && backend.fields.host === `bb:${hostId}`).map((backend) => backend.id));
      return ids.size > 0 && (await boxes.all()).some((box) => ids.has(box.backend) && box.state !== "gone");
    },
    async offline(hostId) {
      machineStates.delete(hostId);
      const connected = await machineConnected(hostId);
      return connected === true ? null : offline(hostId, connected).message;
    },
    logError,
    log: (message) => bb.log.info(message),
  });
  bb.http.experimental_websocket(MSB_ROUTE, ({ url }) => msbRelay.route(url), { auth: "none" });
  bb.onDispose(() => msbRelay.dispose());
  const machines: MachineAccess = {
    dockerHost: (hostId) => relay.address(hostId),
    async ready(hostId) {
      const connected = await machineConnected(hostId);
      if (connected !== true) throw offline(hostId, connected);
      await relay.endpoint(hostId);
    },
    name: (hostId) => machineNames.get(hostId) ?? null,
    platform: (hostId) => machinePlatforms.get(hostId),
    connected: machineConnected,
    msb: (hostId) => ({
      argv: (args, options) => msbClientArgv(msbRelay.address(hostId).slice("unix://".length), { args, ...(options?.tty ? { tty: true } : {}) }),
      async ready() {
        const connected = await machineConnected(hostId);
        if (connected !== true) throw offline(hostId, connected);
        await msbRelay.endpoint(hostId);
      },
      script: (script, args, signal) => host.call("microsandbox", { script, args: [...args] }, { hostId, signal, timeoutMs: MSB_SCRIPT_TIMEOUT_MS[script] }),
    }),
  };

  // What the doctor judges images by (049): the pins in the plugin's own
  // setup files, and BB's app on BB's server now.
  const pins = setupDir();
  const images: ImageFacts = {
    pins: (set) => pinsDigest(pins, set),
    async bbApp() {
      const url = bb.server.experimental_appUrl;
      return url ? bbAppDigest(url).catch(() => null) : null;
    },
  };

  // A kind a backend changed by itself, as when a Mac reports Windows video ready: its boxes take it, once there are boxes.
  let kindsChanged = () => notify(null);
  const backends = new Backends({
    storage: kv,
    installId: await loadInstallId(kv),
    logError,
    log: (message) => bb.log.info(message),
    changed: () => notify(null),
    kindsChanged: () => kindsChanged(),
    drivers,
    machines,
    images,
    bbUrl: () => bb.server.experimental_appUrl,
  });
  // The files for every box (#455), once the boxes are there.
  let files: BoxFiles | null = null;
  const configuration = await Configuration.load({
    kv,
    backends,
    drivers,
    // Read only once setup is done.
    boxes: () => boxes.all(),
    spareCounts: () => boxes.spareCounts(),
    changed: () => {
      notify(null);
      needsConfiguration();
      // A kind may keep more or fewer spares now, and offer what older boxes lack.
      void boxes.keepSpares();
      void boxes.refreshCapabilities().catch((error) => logError("capabilities", error));
      // A warm count, a switch or the room kept free may have changed: tops the pools up now, not at the next sweep (#355).
      for (const backend of backends.active()) void backend.maintain?.().catch((error) => logError(`maintain ${backend.id}`, error));
      void files?.settingsChanged().catch((error) => logError("write the files for every box", error));
    },
    logError,
  });
  // The names of the BB machines providers run on, from BB, once as bb-box starts, in the background: a machine bb-box has not
  // reached this run, or one renamed since, is named at once, not by its ID (#916).
  for (const hostId of new Set(configuration.document.backends.map((backend) => backend.fields.host).filter((host): host is string => typeof host === "string" && host.startsWith("bb:")).map((host) => host.slice("bb:".length)))) {
    void machineConnected(hostId).catch(() => {});
  }
  await configuration.configure();
  reloadTimes.phase("configuration and backends");
  const general = async () => configuration.general();

  const projectOf = async (threadId: string): Promise<string | null> => {
    try {
      return (await bb.sdk.threads.get({ threadId })).projectId;
    } catch {
      return null;
    }
  };

  // Names only: BB never gives plugins the values. Every command in an
  // enrolled box needs them, and BB can take seconds to answer while it is
  // busy, so they are kept per project and refreshed in the background. The
  // key "" holds the machine-wide names.
  // With the names, whether BB gives machines GH_TOKEN: its built-in Git is
  // logged in to GitHub, or a variable sets it. Only then does a new box wait for it.
  const variableNames = new Refreshing<{ readonly names: readonly string[]; readonly gitToken: boolean }>({
    freshMs: NAMES_FRESH_MS,
    onError: (error) => logError("variable names", error),
    async load(projectId) {
      let variables: readonly { name: string }[];
      let git: string;
      if (projectId) {
        const project = await bb.sdk.projects.machineEnvironment({ projectId });
        variables = [...project.inheritedVariables, ...project.variables];
        git = project.builtInGit.status;
      } else {
        const system = await bb.sdk.system.machineEnvironment();
        variables = system.variables;
        git = system.builtInGit.status;
      }
      const names = variables.map((variable) => variable.name);
      return { names, gitToken: git === "logged in" || names.includes("GH_TOKEN") };
    },
  });
  const access = async (box: BoxRecord): Promise<{ names: string[]; gitToken: boolean; variablesSet: boolean }> => {
    const [system, project] = await Promise.all([variableNames.get(""), box.projectId ? variableNames.get(box.projectId) : null]);
    const set = [...(system?.names ?? []), ...(project?.names ?? [])];
    return {
      names: [...new Set([...DAEMON_NAMES, ...set])],
      // The project's own answer, when the box has one: it can override BB's Git.
      gitToken: (project ?? system)?.gitToken ?? false,
      variablesSet: set.length > 0,
    };
  };
  const names = async (box: BoxRecord): Promise<string[]> => (await access(box)).names;

  // bb-box's host entry on each enrolled box keeps a process with the thread's access, as BB's workers come and go.
  const holders = new Holders({
    access: (hostId, names) => host.call("access", { names: [...names] }, { hostId, timeoutMs: CALL_TIMEOUT_MS }),
    terminals: () => bb.sdk.terminals as unknown as RetiredTerminals,
    logError,
    log: (message) => bb.log.info(message),
  });
  host.experimental_onWorkerExit(({ hostId }) => {
    holders.forget(hostId);
    relay.drop(hostId, "the machine's worker exited");
  });

  let enrolment: Enrolment;
  let deviceServers: DeviceServers | undefined;
  let desktops: Desktops | undefined;
  let terminals: Terminals | undefined;
  let computer: Computer | undefined;
  let deviceComputer: DeviceComputer | undefined;
  // Projects' names, for a choice of image (049): asked of BB at most once a minute, as the panel polls.
  const projectNames = new Refreshing<Map<string, string>>({
    freshMs: 60_000,
    load: async () => new Map(((await bb.sdk.projects.list({ includePersonal: true })) as { id: string; name: string }[]).map((one) => [one.id, one.name])),
    onError: (error) => logError("project names", error),
  });
  // Projects' images, baked where their boxes start (049).
  const imageBakes: ImageBakes = new ImageBakes({
    backends: () => backends.on(),
    images: () => configuration.document.images ?? {},
    storage: kv,
    setup: pins,
    log: (line) => bb.log.info(line),
    // A build made or removed: the images' spares (#440) follow at once.
    changed: () => void boxes.keepSpares(),
    // A tried image's box, from its kept build (#451), ready to look inside.
    async keep({ threadId, projectId, kind, backend, name, build, ref }): Promise<{ id: string; name: string }> {
      const box = await boxes.acquire({ threadId, projectId, kind, on: backend, from: { name: `${name} (tried)`, build, ref } });
      const ready: BoxRecord = (await boxes.settled(box)) ?? box;
      if (ready.state !== "ready") {
        await boxes.release(threadId, box.id, "it did not start for a tried image").catch(() => null);
        throw new Error(ready.error ?? `it ended ${ready.state}`);
      }
      return { id: ready.id, name: ready.name };
    },
    boxExists: async (id) => (await boxes.find(id)) !== null,
  });
  const boxes: Boxes = new Boxes({
    kv: bb.storage.kv,
    backends,
    general,
    // A project's image for a kind (049), from the configuration as it is now.
    image: (projectId, kind, name) => (name === undefined ? projectImage(configuration.document, projectId, kind) : namedImage(configuration.document, name, kind)),
    baked: (name, backend, kind) => imageBakes.current(name, backend, kind),
    imageReady: (box) => imageBakes.ready(box),
    imageSpares: () => imageBakes.spareWants(),
    // As the bundle's setup files have it; a build installs the same in the image.
    imageTools: imageTools(pins),
    notify,
    recorded(box, deleted) {
      // A tried image's kept build goes with its box (#451).
      if (deleted) void imageBakes.released(box).catch((error) => logError("tried image", error));
      // Fetched while the box starts, for its enrolment.
      if (!deleted && box.state === "acquiring") void names(box).catch(() => {});
      // A desktop that stops, restarts or goes gives control back to the agent.
      if (deleted || box.state !== "ready") {
        desktops?.control.forget(box.id);
        computer?.forget(box.id);
        deviceComputer?.forget(box.id);
        // Its shells are gone with it; their tabs hear why.
        void terminals?.end(box.id, deleted ? "The box was released." : box.state === "stopped" || box.state === "stopping" ? "The box stopped." : "The box is no longer running.");
      }
      // A box that joins BB, or starts again, gets the files for every box it lacks.
      files?.recorded(box, deleted);
      deviceServers?.recorded(box, deleted);
    },
    async thread(threadId): Promise<ThreadAnswer> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const said = `archivedAt ${when(thread.archivedAt)}, deletedAt ${when(thread.deletedAt)}`;
        return { state: isSet(thread.archivedAt) || isSet(thread.deletedAt) ? "ended" : "live", said };
      } catch (error) {
        return { state: isMissingThread(error) ? "missing" : "unknown", said: describeAnswer(error) };
      }
    },
    async tell(threadId, text) {
      await bb.sdk.threads.send({ threadId, input: [{ type: "text", text, mentions: [] }], mode: "queue-if-active" });
    },
    projectOf,
    machineOf: (boxId) => newBoxHost({ list: (args) => bb.sdk.hosts.list(args), getResource: (hostId) => bb.experimental_machines.getResource(hostId) }, boxId),
    enrol: (box, options) => enrolment.enrol(box, { since: options?.restored ? "restored" : "ready" }),
    unenrol: (box) => enrolment.unenrol(box),
    reconnect: (box) => enrolment.reconnect(box),
    // Archived and deleted threads do not count: a spare whose machine had a thread once is still free.
    spareThread: async (box) => (await api.threadsOn(box))[0]?.id ?? null,
    claimed: (box) => {
      // A claimed spare's commands need the project's variable names, as a new box's do.
      void names(box).catch(() => {});
      return enrolment.claimed(box);
    },
    renameMachine: (box) => enrolment.rename(box),
    // A box on Docker on a BB machine whose relay is coming back, as after an update, is waited for (#415).
    reconnecting: (box) => {
      const host = configuration.document.backends.find((backend) => backend.id === box.backend)?.fields.host;
      if (typeof host !== "string" || !host.startsWith("bb:")) return null;
      const hostId = host.slice("bb:".length);
      if (!relay.reopening(hostId)) return null;
      return `bb-box is reconnecting to ${machineNames.get(hostId) ?? `BB machine ${hostId}`}, which runs its Docker, as after an update.`;
    },
    access: async (box) => {
      const { names: listed, gitToken, variablesSet } = await access(box);
      if (box.enrol.hostId) await holders.ensure(box.enrol.hostId, listed);
      return { names: listed, parent: options.daemonParent ?? DAEMON_PARENT, required: awaitedNames(gitToken, variablesSet) };
    },
    logError,
    log: (message) => bb.log.info(message),
  });
  kindsChanged = () => {
    notify(null);
    void boxes.refreshCapabilities().catch((error) => logError("capabilities", error));
  };
  files = new BoxFiles({ boxes, files: () => boxFilesOf(configuration.document.general.files, configuration.secrets), logError });
  void files.started().catch((error) => logError("write the files for every box", error));
  enrolment = new Enrolment({
    boxes,
    kv,
    hosts: () => bb.sdk.hosts as unknown as HostApi,
    bootstrap: (request) => bb.experimental_machines.bootstrap(request),
    logError,
    log: (message) => bb.log.info(message),
    bbUrl: () => bb.server.experimental_appUrl,
    variablesWaitMs: options.variablesWaitMs,
    logonWaitMs: options.logonWaitMs,
    providerRetryMs: options.providerRetryMs,
    manualRemoveMs: options.manualRemoveMs,
  });
  bb.experimental_machines.register(enrolment.provider());
  registerNewBox(bb, {
    boxes,
    async thread(threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return { id: thread.id, projectId: thread.projectId };
      } catch {
        return null;
      }
    },
    bootstrap: (request) => bb.experimental_machines.bootstrap(request),
  });
  const computing = new Computer({
    async spawn(box, script, signal) {
      const { command } = await boxes.transports(box);
      if (!command?.spawn) throw new BoxError("unsupported", `Box ${box.name}'s command transport cannot start the computer-use driver.`);
      return command.spawn(script, signal);
    },
    // In the box user's desktop session, whose windows they are (#365).
    async nameWindows(box, signal) {
      if (box.capabilities.os !== "windows") return [];
      const { result } = await boxes.run(box.threadId, box.id, NAME_WINDOWS_SCRIPT, { session: "desktop", timeoutMs: 60_000, signal, waitForEnrolment: false, maxOutputBytes: 16 * 1024 });
      if (result.exitCode !== 0) throw new Error(`Naming the untitled windows failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      return parseNamed(result.stdout);
    },
    // Text on a Sway desktop goes in with the image's US keyboard, or by paste, as Cua's typing loses characters (#707).
    async keyText(box, input, signal) {
      if (box.capabilities.os !== "linux") return "unsupported";
      const result = await boxes.runOwn(box, swayKeyboardScript(input.windowId, input.text), { timeoutMs: 120_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode === 3) return "unsupported";
      if (result.exitCode !== 0) throw new Error(`Typing on the desktop failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      return "typed";
    },
    async stageText(box, input, signal) {
      if (box.capabilities.os !== "linux") return "unsupported";
      const result = await boxes.runOwn(box, swayStageScript(input.windowId, input.text), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode === 3) return "unsupported";
      if (result.exitCode !== 0) throw new Error(`Putting the text on the clipboard failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
      return result.stdout.trim() === "terminal" ? "terminal" : "app";
    },
    async restoreClipboard(box, signal) {
      const result = await boxes.runOwn(box, swayRestoreScript(), { timeoutMs: 30_000, signal, maxOutputBytes: 4096 });
      if (result.exitCode !== 0) throw new Error(`Putting the clipboard back failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
    },
    owner: (boxId) => desktops?.control.view(boxId).owner ?? "agent",
    takeBack: (boxId) => desktops?.control.takeBack(boxId) ?? Promise.resolve(false),
    logError,
    ...options.computer,
  });
  computer = computing;
  const devices = new DeviceServers({
    boxes,
    kv,
    files: () => deviceServerFiles(options.deviceServerRoot ?? join(setupDir(), "..")),
    personHasControl: (boxId) => desktops?.control.view(boxId).owner === "human",
    log: (line) => bb.log.info(line),
    logError,
    ...options.devices,
  });
  deviceServers = devices;
  const deviceComputing = new DeviceComputer({
    read: (box, request) => devices.read(box, request),
    input: (box, input) => devices.input(box, input),
    agentRequest: (box, request) => devices.agentRequest(box, request),
    personHasControl: (boxId) => desktops?.control.view(boxId).owner === "human",
    takeBack: (boxId) => desktops?.control.takeBack(boxId) ?? Promise.resolve(false),
  });
  deviceComputer = deviceComputing;
  const desktop = registerDesktop(bb, {
    boxes,
    notify,
    logError,
    staleMs: options.controlStaleMs,
    reconnectMs: options.controlReconnectMs,
    pause: (boxId) => computing.pause(boxId),
    controlChanged: (boxId) => devices.controlChanged(boxId),
    openDevice: async (box) => {
      await devices.ensure(box).catch((error) => logError(`device server of box ${box.name}`, error));
      return boxes.spawnOwn(box, connectScript());
    },
  });
  desktops = desktop;
  const terminal = registerTerminals(bb, { boxes, logError, idleMs: options.terminalIdleMs });
  terminals = terminal;
  const control = desktop.control;

  // Disposed in reverse: boxes first, so acquires stop before their backends.
  // The nightly rebuilds (049): bb box images refresh starts a run here.
  const imageJobs = new ImageJobs({
    backends: () => backends.on(),
    setup: pins,
    bbUrl: () => bb.server.experimental_appUrl,
    facts: images,
    storage: kv,
    bakes: imageBakes,
    log: (line) => bb.log.info(line),
    afterBbUpdates: () => configuration.document.general.nightlyImages ?? GENERAL_DEFAULTS.nightlyImages,
    changed: () => notify(null),
  });
  // Stalls of the event loop bb-box runs on, BB's server's, which hold up every desktop's frames and input.
  const loopWatch = new LoopWatch({
    log: (message) => bb.log.warn(message),
    spawns: spawnTotals,
    longestSpawn: takeLongestSpawn,
    memory: () => process.memoryUsage(),
  });
  bb.onDispose(() => loopWatch.dispose());
  setTimeout(() => {
    const swept = sweepStaleTempFolders();
    if (swept.removed.length) bb.log.info(`Removed ${swept.removed.length} of bb-box's temporary folders that earlier runs of bb-box left: ${swept.removed.join(", ")}.`);
  }, 0).unref();
  bb.onDispose(() => stopForker());
  bb.onDispose(() => imageJobs.stop());
  bb.onDispose(() => imageBakes.stop());
  bb.onDispose(() => enrolment.dispose());
  bb.onDispose(() => backends.dispose());
  bb.onDispose(() => boxes.dispose());
  bb.onDispose(() => desktop.dispose());
  bb.onDispose(() => terminal.dispose());
  bb.onDispose(() => computing.dispose());
  bb.onDispose(() => devices.dispose());
  void devices.startAll().catch((error) => logError("device servers", error));

  /** Asks for configuration while no backend is on and valid. */
  function needsConfiguration(): void {
    if (backends.on().length) return;
    const unconfigured = backends
      .statuses()
      .filter((backend) => backend.state === "misconfigured")
      .map((backend) => `${backend.label}: ${backend.problems.join(" ")}`);
    bb.status.needsConfiguration(unconfigured.length ? unconfigured.join(" ") : "Set a backend up in BB Box's settings and turn it on.");
  }
  needsConfiguration();

  bb.events.on("thread.archived", ({ thread }) => {
    threadHosts.delete(thread.id);
    void forPurpose("thread archived", () => boxes.releaseThread(thread.id, "archived")).catch((error) => logError("thread archived", error));
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    threadHosts.delete(thread.id);
    void forPurpose("thread deleted", () => boxes.releaseThread(thread.id, "deleted")).catch((error) => logError("thread deleted", error));
  });
  // A thread that starts on a spare's machine from BB's picker makes it yours
  // now, not at the next spare upkeep (036, #155). Its machine is known once
  // it has an environment, which it may not have when it is created.
  const startedOn = async (thread: { id: string; environmentId: string | null }) => {
    if (thread.environmentId && (await boxes.list(SPARES)).length) await api.runsOn(thread.id);
  };
  for (const event of ["thread.created", "thread.active"] as const) {
    bb.events.on(event, ({ thread }) => {
      void forPurpose(event, () => startedOn(thread)).catch((error) => logError(event, error));
    });
  }
  bb.events.on("experimental_host.deleted", ({ host }) => {
    holders.forget(host.id);
    void forPurpose("host deleted", () => enrolment.forgetHost(host.id)).catch((error) => logError("host deleted", error));
  });

  // The nightly rebuilds (049) behind General's switch: BB runs this schedule while bb-box is loaded, and a run goes on
  // after it returns, as one that bb box images refresh starts does. A run already going is not started again.
  bb.background.schedule(NIGHTLY_SCHEDULE, NIGHTLY_CRON, () => {
    if (!(configuration.document.general.nightlyImages ?? GENERAL_DEFAULTS.nightlyImages)) return;
    if (imageJobs.running()) return;
    bb.log.info("Rebuilding the standard images that are due, as General's Rebuild images each night is on.");
    void forPurpose("nightly images", () => imageJobs.refreshAll({ limitMs: NIGHTLY_HOURS * 60 * 60_000 })).catch((error) => logError("nightly images", error));
  });

  // After a BB update, the images with BB's old app are refreshed within the hour, while the nightly switch is on.
  bb.background.service("bb-update-images", {
    async start(signal) {
      while (!signal.aborted) {
        // Its wait ends when the plugin stops, as the sweeper's steps do: a backend's listing of its images through a
        // machine BB no longer answers for a stopping plugin may never end, and kept the plugin from stopping on an
        // update (18 October 2026). What it started finishes on its own.
        await abortable(forPurpose("images after a BB update", () => imageJobs.afterBbUpdate(signal)), signal).catch((error) => {
          if (!signal.aborted) logError("images after a BB update", error);
        });
        // sleep sees an abort that came before it began, as one during the look above does: a listener added then
        // would never hear it, and the plugin stopped only when the wait ran out (19 October 2026).
        await sleep(BB_UPDATE_LOOK_MS, signal);
      }
    },
  });

  bb.background.service("sweeper", {
    async start(signal) {
      // Each step ends its wait when the plugin stops: BB may no longer answer
      // a stopping plugin, and a call to a machine through it, such as a Docker
      // host's relay, may never end. What a step started finishes on its own.
      const step = async (operation: string, work: () => Promise<unknown>) => {
        await abortable(forPurpose(operation, work), signal).catch((error) => {
          if (!signal.aborted) logError(operation, error);
        });
      };
      await step("resume enrolment", () => enrolment.resume());
      // What this release adds to a kind reaches boxes made before it (#215).
      await step("capabilities", () => boxes.refreshCapabilities(signal));
      while (!signal.aborted) {
        await step("sweep", () => boxes.sweep(signal));
        if (signal.aborted) break;
        await step("sweep enrolment", () => enrolment.sweep(signal));
        // An abort during a sweep came before this sleep began: sleep sees it at once.
        await sleep(SWEEP_EVERY_MS, signal);
      }
    },
  });

  /** Each thread's machine, once it has an environment. */
  const threadHosts = new Map<string, string>();
  const buildScript =
    options.dockerBuildScript !== undefined ? options.dockerBuildScript : (() => {
      const script = join(setupDir(), "docker", "build.sh");
      return existsSync(script) ? script : null;
    })();
  const dockerImages = new DockerImages({
    script: buildScript,
    images(hostId) {
      const config = backendOn(configuration.document, hostId);
      if (!config) return [];
      const parsed = dockerDriver.parse(backendPart(config, dockerDriver, {}, configuration.document.backends));
      return parsed.ok ? [...new Set(Object.values(parsed.config.images).filter((image): image is string => image !== null))] : [];
    },
    async host(hostId) {
      await machines.ready(hostId);
      return relay.address(hostId);
    },
    async stale(hostId, image, app) {
      const result = await new DockerCli(relay.address(hostId)).run(["image", "inspect", "--format", "{{json .Config.Labels}}", image], { timeoutMs: 30_000 });
      if (result.exitCode !== 0) return true;
      const labels = (JSON.parse(result.stdout || "null") as Record<string, unknown> | null) ?? {};
      return outdated(labels, app);
    },
    appUrl: () => bb.server.experimental_appUrl,
    appDigest: bbAppDigest,
    changed: () => notify(null),
    storage: kv,
    logError,
    log: (message) => bb.log.info(message),
  });
  /** What each BB machine's host entry last said for first-run setup. */
  const setupFactsOf = new Map<string, SetupFacts>();
  const dockerHosts = new DockerHosts({
    images: (hostId) => dockerImages.state(hostId),
    machines: async () => (await bb.sdk.hosts.list({ includeCreating: false } as never)) as unknown as readonly MachineRecord[],
    document: () => configuration.document,
    providers: [MACHINE_PROVIDER_ID, NEW_BOX_PROVIDER_ID],
    async found(hostId, signal) {
      const answer = await host.call("docker", {}, { hostId, signal, timeoutMs: RELAY_CALL_TIMEOUT_MS });
      if (answer.setup) setupFactsOf.set(hostId, answer.setup);
      // A machine's OS newly known: panels with the form open learn it for "Runs on".
      if (answer.platform && (await machinePlatforms.learn(hostId, answer.platform))) notify(null);
      // A socket that refused BB's daemon is Docker to fix, not a machine without Docker.
      if (answer.refused) throw new Error(answer.reason ?? "Docker's socket refused BB's daemon.");
      return answer.found ? null : `there is no Docker to reach: ${answer.reason ?? "it did not answer"}`;
    },
    async docker(hostId, signal) {
      await machines.ready(hostId);
      return new DockerCli(relay.address(hostId)).info(signal);
    },
    async boxes() {
      const counts = new Map<string, number>();
      for (const box of await boxes.all()) if (box.state !== "gone") counts.set(box.backend, (counts.get(box.backend) ?? 0) + 1);
      return counts;
    },
  });
  /** Why a thread's desktop box was not made after its image was built (the setup plan's PR 4), by thread, until it asks again. */
  const desktopProblems = new Map<string, { message: string; at: number }>();
  const desktopsAwaited = new Set<string>();
  /**
   * BB terminal sessions open on a machine (061): its own, and those of
   * each thread on it and of each such thread's environment, which BB lists
   * apart. bb-box's retired access terminal does not count.
   */
  const openTerminals = async (hostId: string): Promise<number> => {
    const threads = await bb.sdk.threads.list({ hostId, archived: false, includeHidden: true });
    const environments = [...new Set(threads.map((thread) => thread.environmentId).filter((id): id is string => typeof id === "string" && id.length > 0))];
    const scopes = [
      { kind: "host_path" as const, hostId },
      ...threads.map((thread) => ({ kind: "thread" as const, threadId: thread.id })),
      ...environments.map((environmentId) => ({ kind: "environment" as const, environmentId })),
    ];
    const seen = new Set<string>();
    for (const scope of scopes) {
      const { sessions } = await bb.sdk.terminals.list({ scope });
      for (const session of sessions) {
        if (session.hostId !== hostId || session.title === RETIRED_TITLE) continue;
        if (session.status === "running" || session.status === "starting") seen.add(session.id);
      }
    }
    return seen.size;
  };

  const api: BbBox = {
    boxes,
    backends,
    enrolment,
    relay,
    files: fileRelay,
    dockerHosts,
    dockerImages,
    setups: async () => {
      const hosts = await dockerHosts.list();
      const took = new Map(await Promise.all(hosts.map(async (host) => [host.hostId, await dockerImages.took(host.hostId)] as const)));
      return machineSetups(hosts, setupFactsOf, hostname(), took).map((setup) => (desktopsAwaited.has(setup.hostId) ? { ...setup, boxFollows: true } : setup));
    },
    machineAccess: async () => machineAccessProblem((await bb.sdk.system.config().catch(() => null)) as AccessConfig | null),
    async dockerHostOf(machine) {
      const hosts = (await bb.sdk.hosts.list({ includeCreating: true })) as readonly { id: string; name: string }[];
      const found = hosts.find((candidate) => candidate.id === machine) ?? hosts.find((candidate) => candidate.name === machine);
      return found ? { hostId: found.id, name: found.name, backend: backendOn(configuration.document, found.id) } : null;
    },
    async setDockerHost(hostId, enabled, linuxOnly = false) {
      const machine = (await dockerHosts.list()).find((candidate) => candidate.hostId === hostId);
      if (!machine) throw new BoxError("not_found", `BB machine ${hostId} cannot host boxes: it is not a connected, persistent machine of BB's that bb-box did not make.`);
      if (enabled && !machine.docker) throw new BoxError("unsupported", `${machine.name} cannot host boxes yet. ${machine.problem ?? ""}`.trim());
      const document = configuration.document;
      dockerHosts.forget(hostId);
      const result = await configuration.apply(withDockerHost(document, { id: hostId, name: machine.name }, enabled, machine.backend?.boxes ?? 0, linuxOnly), document.revision);
      // Turned on, it builds the images it lacks there; the row shows the build until it ends.
      if (result.ok && enabled) void dockerImages.ensure(hostId);
      return result;
    },
    desktopProblem: (threadId) => desktopProblems.get(threadId) ?? null,
    async desktopOnDemand() {
      const all = desktopsOnDemand(configuration.document);
      const first = all[0];
      const backend = first ? backends.get(first.backend) : undefined;
      if (!first || !backend) return null;
      const machine = (await dockerHosts.list()).find((candidate) => candidate.hostId === first.hostId);
      if (!machine?.connected || dockerImages.state(first.hostId)?.state === "building") return null;
      // The desktop as the backend will offer it once its image is set: with Docker in it when its Linux boxes have it.
      const docker = backends.kinds().some((offered) => offered.backend === backend && offered.kind.capabilities.features.includes("docker"));
      const config = await general();
      const took = await dockerImages.took(first.hostId);
      const onDemand = all.filter((candidate) => candidate.hostId === first.hostId && candidate.backend === first.backend);
      const views = kindViews(
        onDemand.map((candidate) => ({ kind: dockerKind(candidate.kind, docker), backend })),
        config.sizes,
        {},
        {},
        {},
        {},
        (id) => backends.driverLabel(id),
      );
      const kinds = views.map((kind) => ({ kind, took: took[kind.id === "linux-desktop-wayland-cpu" ? "desktop-wayland" : "desktop"] ?? null }));
      return kinds.length ? { hostId: first.hostId, name: machine.name, kinds } : null;
    },
    async buildDesktop({ threadId, hostId, kind = DESKTOP_ON_DEMAND, size, name }) {
      const document = configuration.document;
      const found = desktopsOnDemand(document).find((candidate) => candidate.hostId === hostId && candidate.kind === kind);
      if (!found) throw new BoxError("not_found", `BB machine ${hostId} has no Docker desktop image to build for ${kind}: its Docker is off, or that image is set already.`);
      const result = await configuration.apply(withDesktopImage(document, found.backend, kind), document.revision);
      if (!result.ok) return result;
      const projectId = await api.projectOf(threadId).catch(() => null);
      desktopProblems.delete(threadId);
      desktopsAwaited.add(hostId);
      // The box is made once the image is built; the panel shows the build until then, and a failed build says why.
      void dockerImages
        .ensure(hostId)
        .finally(() => desktopsAwaited.delete(hostId))
        .then(async (build) => {
          if (build.state === "built") {
            // A box that fails now says why in the thread's panel, as an acquire refused there does.
            await boxes.acquire({ threadId, projectId, kind, ...(size ? { size } : {}), ...(name ? { name } : {}), on: found.backend }).catch((error: unknown) => {
              const reason = error instanceof Error ? error.message : String(error);
              logError("desktop on demand", error);
              desktopProblems.set(threadId, { message: `The desktop image is built, but the box was not made: ${reason}`, at: Date.now() });
              notify(threadId);
            });
            return;
          }
          // Not built: the desktop goes back to building first, so the form offers it again rather than a desktop with no image.
          const now = configuration.document;
          await configuration.apply(withoutDesktopImage(now, found.backend, kind), now.revision);
        })
        .catch((error) => logError("desktop on demand", error));
      return result;
    },
    imageVersions: ({ pinned, signal }) => resolveVersions(pins, { pinned: !!pinned, ...(signal ? { signal } : {}) }),
    imageJobs,
    imageBakes,
    async setImage(name, image) {
      // Against the revision it read: another write in between means reading again.
      for (let tries = 0; ; tries++) {
        const document = configuration.exported();
        const result = await configuration.apply(withImage(document, name, image), document.revision);
        // A changed script's builds are baked again at once, and a removed image's go (049).
        if (result.ok) imageBakes.settle(name);
        if (result.ok || result.reason !== "revision" || tries >= 2) return result;
      }
    },
    async dockerCheck(machine, signal) {
      const hosts = (await bb.sdk.hosts.list({ includeCreating: true })) as readonly { id: string; name: string }[];
      const found = hosts.find((candidate) => candidate.id === machine) ?? hosts.find((candidate) => candidate.name === machine);
      if (!found) throw new BoxError("not_found", `BB has no machine ${machine}. bb machine list lists them.`);
      const endpoint = await relay.endpoint(found.id);
      const cli = new DockerCli(endpoint);
      let started = performance.now();
      const info = await cli.info(signal);
      const firstMs = Math.round(performance.now() - started);
      started = performance.now();
      await cli.ok(["version", "--format", "{{.Server.Version}}"], { timeoutMs: 30_000, signal });
      return { hostId: found.id, name: found.name, endpoint, info, firstMs, againMs: Math.round(performance.now() - started) };
    },
    desktops: desktop,
    devices,
    terminals: terminal,
    computer: computing,
    deviceComputer: deviceComputing,
    configuration,
    general,
    view: (box) => boxView(box, boxes.canStopStart(box), control.view(box.id), backends.get(box.backend)?.resizing?.(box.kind) ?? null),
    control: (box) => control.view(box.id),
    async imageOptions(project) {
      const images = Object.entries(configuration.document.images ?? {});
      if (!images.length) return [];
      const names = await projectNames.get("all").catch(() => new Map<string, string>());
      const spareCounts = await boxes.imageSpareCounts();
      const options: ImageOptionView[] = [];
      for (const [name, image] of images) {
        options.push({
          name,
          kinds: image.kinds,
          projects: image.projects.map((id) => ({ id, name: names.get(id) ?? id })),
          mine: !!project && image.projects.includes(project),
          builds: await imageBakes.builds(name),
          spares: Object.entries(spareCounts)
            .filter(([key]) => key.startsWith(`${name}|`))
            .map(([key, count]) => {
              const [, backend = "", kind = ""] = key.split("|");
              return { backend, kind, ...count };
            }),
        });
      }
      return options.sort((a, b) => Number(b.mine) - Number(a.mine) || a.name.localeCompare(b.name));
    },
    kinds: async () => {
      const config = await general();
      const offered = backends.kinds();
      return kindViews(offered, config.sizes, await boxes.spareCounts(), config.spares, await boxes.typicalReady(), await boxes.spareReadyByBackend(), (id) => backends.driverLabel(id), await gpuRooms(offered), boxes.sharedHosts());
    },
    async providerProfile(backendId, signal) {
      const status = backends.statuses().find((candidate) => candidate.id === backendId);
      if (!status) throw new Error(`No provider has the ID ${backendId}.`);
      const config = await general();
      const views = kindViews(backends.kinds(), config.sizes, await boxes.spareCounts(), config.spares, await boxes.typicalReady(), await boxes.spareReadyByBackend(), (id) => backends.driverLabel(id));
      const offers = views.flatMap((kind) => kind.offers.filter((offer) => offer.backend === backendId).map((offer) => ({ kind, offer })));
      const first = offers[0];
      const built = backends.get(backendId);
      const hosts = built?.hosts ?? first?.offer.hosts ?? [];
      const all = await boxes.all();
      const state = (await configuration.state()).backends.find((candidate) => candidate.id === backendId);
      return {
        backend: backendId,
        name: first?.offer.name ?? providerName({ label: backends.driverLabel(backendId), hosts, type: status.type }),
        technology: drivers.find((driver) => driver.type === status.type)?.description ?? status.label,
        nature: status.nature,
        hosts,
        hostOs: built?.hostOs ?? first?.offer.hostOs ?? null,
        // The GPU desktop is named as box_list names it, so two Linux desktops read apart.
        makes: offers.map(({ kind, offer }) => ({ id: kind.id, label: `${kind.label}${kind.gpu ? " (GPU)" : ""}`, form: offer.form, typicalReadyMs: offer.typicalReadyMs, ready: offer.ready })),
        boxes: all.filter((box) => box.backend === backendId && box.state !== "gone").length,
        room: first ? await boxes.room(backendId, first.kind.id, signal).catch(() => null) : null,
        status: { state: status.state, problem: status.problems[0] ?? null, ok: state?.doctor?.report.ok ?? null, summary: state?.doctor?.report.summary ?? null, checkedAt: state?.doctor?.at ?? null },
      };
    },
    async offerRooms(kindId, size) {
      const offered = backends.kinds().filter((offer) => offer.kind.id === kindId);
      const all = await boxes.all();
      return Promise.all(
        offered.map(async ({ backend }): Promise<OfferRoom> => {
          const holders = () => all.filter((box) => box.backend === backend.id && box.state !== "gone" && box.state !== "releasing").map((box) => box.name);
          if (backend.free?.(kindId) === 0 && holders().length) return { backend: backend.id, available: false, reason: inUseBy(holders()) };
          const room = await withinMs(boxes.room(backend.id, kindId, undefined, size), ROOM_ANSWER_MS).catch(() => null);
          if (!room || room.ok) return { backend: backend.id, available: true, reason: null };
          const held = backend.free ? holders() : [];
          return { backend: backend.id, available: false, reason: held.length ? inUseBy(held) : firstSentence(room.message) };
        }),
      );
    },
    backendViews: () =>
      backends.statuses().map((backend) => ({
        ...backend,
        setup: drivers.find((driver) => driver.type === backend.type)?.setup ?? { guide: "", scripts: [] },
      })),
    async doctor(signal) {
      const sections: { title: string; report: DoctorReport }[] = [];
      // The general and kinds parts are checked on every write; one the move brought may still need fixing.
      const unsettled = (await configuration.problems()).filter((problem) => !problem.path.startsWith("backends."));
      if (unsettled.length) {
        sections.push({
          title: "bb-box",
          report: {
            ok: true,
            summary: "Some settings need fixing.",
            checks: unsettled.map((problem) => ({
              id: `config.${problem.path}`,
              name: "Settings",
              status: "warn" as const,
              detail: problem.message,
              fix: "Fix it in bb-box's settings.",
            })),
            notes: [],
          },
        });
      }
      for (const backend of backends.statuses()) {
        if (backend.state !== "misconfigured") continue;
        sections.push({
          title: backend.label,
          report: {
            ok: false,
            summary: "Its settings need fixing.",
            checks: backend.fieldProblems.map((problem) => ({
              id: `config.${problem.path}`,
              name: "Settings",
              status: "fail" as const,
              detail: problem.message,
              fix: "Fix it in bb-box's settings.",
            })),
            notes: [],
          },
        });
      }
      const reports = await Promise.all(
        backends.on().map(async (backend) => {
          const doctor = await boundedDoctor((bounded) => backend.doctor(bounded), DOCTOR_TIMEOUT_MS, signal);
          const short = warmChecks(backends.warmShort(backend.id));
          const report = short.length ? { ...doctor, checks: [...doctor.checks, ...short] } : doctor;
          await configuration.recordDoctor(backend.id, report);
          return { title: backend.label, report };
        }),
      );
      sections.push(...reports);
      const tailnet = backends.tailnet();
      if (tailnet) sections.push({ title: "Tailnet", report: await tailnetDoctor(tailnet, backends.installId, signal) });
      const offers = offerChecks(backends.kinds());
      if (offers.length) {
        sections.push({
          title: "Kinds",
          report: { ok: true, summary: "Offers of each kind agree.", checks: offers, notes: [] },
        });
      }
      const imageChecks = [...(await imageJobs.checks(signal)), ...(await imageBakes.checks()), ...(await boxes.imageSpareChecks())];
      if (imageChecks.length) {
        sections.push({
          title: "Images",
          report: { ok: true, summary: "How the standard images are kept up to date.", checks: imageChecks, notes: [] },
        });
      }
      const fileChecks = files?.checks() ?? [];
      if (fileChecks.length) {
        sections.push({
          title: "Files for every box",
          report: { ok: true, summary: "bb-box writes them into each Linux and macOS box as it joins BB or starts, and into running boxes when they change.", checks: fileChecks, notes: [] },
        });
      }
      const deviceChecks = (await deviceServers?.checks()) ?? [];
      if (deviceChecks.length) {
        sections.push({
          title: "Device servers",
          report: { ok: deviceChecks.every((check) => check.status !== "fail"), summary: `The device server each device box runs, against version ${deviceServers?.version} that this bb-box delivers.`, checks: deviceChecks, notes: [] },
        });
      }
      const small = presetMemoryChecks((await general()).sizes);
      if (small.length) {
        sections.push({
          title: "Sizes",
          report: { ok: true, summary: `Some presets of Linux kinds have less than ${LINUX_LEAST_MEMORY_GIB} GiB memory.`, checks: small, notes: [] },
        });
      }
      const overlaps = overlapChecks(backends.on());
      if (overlaps.length) {
        sections.push({
          title: "Backends",
          report: { ok: true, summary: "Some backends' boxes could take the same IDs or addresses.", checks: overlaps, notes: [] },
        });
      }
      return { ok: sections.every((section) => section.report.ok), sections };
    },
    async setInstallId(id) {
      requireInstallId(id);
      if (id === backends.installId) return;
      const holding = (await boxes.all()).filter((box) => box.guest && box.state !== "gone");
      if (holding.length) {
        throw new Error(
          `Release ${holding.map((box) => box.name).join(", ")} first. ${holding.length === 1 ? "Its guest carries" : "Their guests carry"} ` +
            `this install's ID ${backends.installId}, so under another ID ${holding.length === 1 ? "it" : "they"} would count as gone.`,
        );
      }
      await storeInstallId(bb.storage.kv, id);
      await backends.useInstallId(id);
      notify(null);
    },
    async workspace(threadId, signal) {
      const thread = await bb.sdk.threads.get({ threadId, signal });
      if (!thread.environmentId) throw new Error("This thread has no workspace yet, so there is nowhere to copy files to or from.");
      const environment = await bb.sdk.environments.get({ environmentId: thread.environmentId, signal });
      return { hostId: environment.hostId, path: environment.path ?? null };
    },
    async threadStorage(threadId, signal) {
      const location = await bb.sdk.threads.storageLocation({ threadId, signal }).catch(() => null);
      return location ? { hostId: location.hostId, path: location.storageRootPath } : null;
    },
    async ancestorStorages(threadId, limit, signal) {
      const found: { threadId: string; hostId: string; path: string }[] = [];
      let parent = (await bb.sdk.threads.get({ threadId, signal }).catch(() => null))?.parentThreadId ?? null;
      while (parent && found.length < limit && !found.some((one) => one.threadId === parent)) {
        const location = await bb.sdk.threads.storageLocation({ threadId: parent, signal }).catch(() => null);
        if (location) found.push({ threadId: parent, hostId: location.hostId, path: location.storageRootPath });
        parent = (await bb.sdk.threads.get({ threadId: parent, signal }).catch(() => null))?.parentThreadId ?? null;
      }
      return found;
    },
    projectOf,
    async runsOn(threadId, signal) {
      // A thread's host does not change once it has an environment, and the panel asks on every update.
      let hostId = threadHosts.get(threadId);
      if (hostId === undefined) {
        try {
          hostId = (await api.workspace(threadId, signal)).hostId;
        } catch {
          return null;
        }
        threadHosts.set(threadId, hostId);
      }
      const box = (await boxes.all()).find((box) => box.enrol.hostId === hostId && box.state !== "gone" && box.state !== "releasing") ?? null;
      // A thread on a spare: the spare upkeep makes it yours now, not at the next sweep (036).
      if (box?.threadId === SPARES) void boxes.keepSpares();
      return box;
    },
    async resolve(threadId, ref, signal) {
      try {
        const box = await boxes.get(threadId, ref);
        return { owner: threadId, box, runsOn: false };
      } catch (error) {
        if (!(error instanceof BoxError) || error.code !== "not_found") throw error;
        const machine = await api.runsOn(threadId, signal);
        if (machine && (machine.id === ref || machine.name === ref)) return { owner: machine.threadId, box: machine, runsOn: true };
        throw error;
      }
    },
    async threadsOn(box) {
      const hostId = box.enrol.hostId;
      if (!hostId) return [];
      const threads = await bb.sdk.threads.list({ hostId, archived: false, includeHidden: true });
      const working = new Set(["active", "starting", "pending", "stopping"]);
      return threads
        .filter((thread) => !isSet(thread.archivedAt) && !isSet(thread.deletedAt))
        .map((thread): ThreadOnBox => ({ id: thread.id, title: thread.title ?? thread.titleFallback ?? null, running: working.has(thread.status) || thread.hasPendingInteraction, ...(typeof thread.updatedAt === "number" ? { activeAt: thread.updatedAt } : {}) }))
        .sort((a, b) => Number(b.running) - Number(a.running) || (b.activeAt ?? 0) - (a.activeAt ?? 0));
    },
    async checkInUse(box, action) {
      const threads = await api.threadsOn(box);
      const running = threads.filter((thread) => thread.running);
      if (running.length) {
        throw new BoxError(
          "in_use",
          `${action} box ${box.name} would end the work of ${threadsWords(running)}, which ${running.length === 1 ? "is" : "are"} working on it. Wait until ${running.length === 1 ? "it is" : "they are"} done.`,
        );
      }
      return threads;
    },
    async machineCores(answer) {
      const { box, from, to } = answer;
      if (!answer.changed || box.resize?.restart || from.cores === to.cores) return null;
      if (box.enrol.state !== "enrolled" || box.capabilities.os !== "linux" || box.capabilities.command?.shell !== "sh") return null;
      const kept = (why: string) =>
        `BB still counts ${from.cores} processors on machine ${box.name}, and its automatic thread limit stays at ${from.cores}, until BB's daemon there restarts, as it does when the box next starts${why}. ` +
        `To raise the limit now: bb concurrency-limit host ${box.name} ${to.cores}, and then bb concurrency-limit host ${box.name} auto once BB counts the new cores.`;
      const working = (await api.threadsOn(box).catch(() => [])).filter((thread) => thread.running);
      if (working.length) {
        const one = working.length === 1;
        return kept(`. bb-box does not restart it while ${threadsWords(working)} ${one ? "works" : "work"} on the machine, as that would end ${one ? "its" : "their"} turn`);
      }
      // BB's terminals there are the daemon's too, and a restart would end them.
      const terminals = await openTerminals(box.enrol.hostId!).catch(() => null);
      if (terminals === null) return kept(". bb-box could not tell whether a BB terminal is open there, so it did not restart it");
      if (terminals > 0) {
        return kept(`. bb-box does not restart it while ${terminals === 1 ? "a BB terminal is" : `${terminals} BB terminals are`} open on the machine, as that would end ${terminals === 1 ? "it" : "them"}`);
      }
      const result = await boxes.runOwn(box, restartDaemon(to.cores), { timeoutMs: 30_000, maxOutputBytes: 1024 }).catch(() => null);
      if (!result || result.exitCode !== 0) return kept("");
      return `BB's daemon on machine ${box.name} restarts once the box shows its ${to.cores} cores, within about 15 s, so BB counts its ${to.cores} processors and sets its automatic thread limit from them. A limit a person set stays as it is.`;
    },
    async checkRestart(box, force) {
      if (box.capabilities.displays.length && api.control(box).owner === "human") {
        throw new BoxError("in_use", `A person holds control of box ${box.name}'s desktop, and a restart would end what they are doing. Ask them to hand control back first.`);
      }
      return force ? api.threadsOn(box) : api.checkInUse(box, "Restarting");
    },
    async startThread({ threadId, box: ref, prompt, title, signal }) {
      let box = await boxes.get(threadId, ref);
      if (box.state !== "ready") throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. Start a thread on it once it is ready.`);
      box = await boxes.enrolled(box, signal);
      if (box.enrol.state !== "enrolled" || !box.enrol.hostId) {
        const why =
          box.enrol.state === "enrolling"
            ? `it is still becoming a BB machine. Try again in ${box.capabilities.os === "windows" ? "a minute or two" : "a few seconds"}`
            : box.enrol.state === "failed"
              ? `its enrolment as a BB machine failed: ${box.enrol.error ?? "no reason given"}`
              : box.capabilities.enrol && (await general()).enrol
                ? // Made before its kind's boxes joined BB, as a Windows box made before #539: it stays a box only, and is not enrolled in place.
                  `it was made before ${box.kindLabel} boxes joined BB, and stays a box only until it is released. Acquire another ${box.kind} box, which joins BB, for the thread`
                : "it is not a BB machine. Its kind does not enrol, or enrolment is off in bb-box's settings";
        throw new BoxError("unsupported", `A thread cannot run on box ${box.name}: ${why}.`);
      }
      const projectId = box.projectId ?? (await projectOf(threadId));
      if (!projectId) throw new BoxError("unsupported", "This thread has no project, so a thread on its box would have none either.");
      const hostId = box.enrol.hostId;
      // Before the clone: a box with none of BB's agent CLIs is refused (#561).
      const agent = await agentFor(bb.sdk, threadId, hostId, box.name, logError);
      // BB's personal project has no repository, and its threads take a personal workspace. A thread
      // of any other project runs where the project has a source, so a box gets a clone of its repository.
      const project = ((await bb.sdk.projects.list({ includePersonal: true })) as { id: string; kind: string; sources: { hostId: string }[] }[]).find(
        (candidate) => candidate.id === projectId,
      );
      if (!project) throw new BoxError("not_found", `BB has no project ${projectId} for a thread on box ${box.name}.`);
      const personal = project.kind === "personal";
      if (!personal && !project.sources.some((source) => source.hostId === hostId)) await bb.sdk.projects.sources.add({ projectId, type: "clone", hostId });
      // Spawned without its parent, then linked: BB gives a personal-project child its parent's
      // environment, on the parent's machine, whatever machine the request names.
      const thread = await bb.sdk.threads.spawn({
        projectId,
        lifecycleOwnerThreadId: threadId,
        environment: {
          type: "host",
          hostId,
          workspace: personal ? { type: "personal" } : { type: "managed-worktree", baseBranch: { kind: "default" } },
        },
        prompt,
        title: title ?? `On box ${box.name}`,
        ...agent,
      });
      await bb.sdk.threads.update({ threadId: thread.id, parentThreadId: threadId });
      return thread.id;
    },
  };

  registerTools(bb, api, { drainMs: options.drainMs, runWaitMs: options.runWaitMs });
  registerComputerTools(bb, api);
  registerDeviceTools(bb, api);
  registerRpc(bb, api);
  registerCli(bb, api);
  reloadTimes.phase("the rest");
  bb.onDispose(() => reloadTimes.stopping());
  void reloadTimes.started();
  return api;
}
