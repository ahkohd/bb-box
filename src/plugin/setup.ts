// Wires bb-box into BB: its configuration, the active backends, the box registry,
// enrolment, thread events, the sweep, and the tools, RPC and CLI that use
// them. server.ts calls setup with the built-in drivers; tests pass fakes.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import packageJson from "../../package.json" with { type: "json" };
import { Backends, DRIVERS, offerChecks, overlapChecks } from "../backends/index.ts";
import type { BackendDriver, DoctorReport } from "../backends/types.ts";
import { BoxError, Boxes, SPARES, type BoxRecord, type ThreadLiveness } from "../core/boxes.ts";
import { Computer, type ComputerDeps } from "../core/computer.ts";
import type { GeneralConfig } from "../core/config.ts";
import { emptyDocument, type ConfigDocument } from "../core/document.ts";
import { loadInstallId, requireInstallId, storeInstallId } from "../core/install.ts";
import { CLEARED_KEY, DOCUMENT_KEY, clearSettings, earlierSettings, moveSettings } from "../core/move.ts";
import type { ControlView } from "../core/control.ts";
import { Configuration, boundedDoctor } from "./configuration.ts";
import { registerCli } from "./cli.ts";
import { registerComputerTools } from "./computer-tools.ts";
import { registerDesktop, type Desktops } from "./desktop.ts";
import { registerTerminals, type Terminals } from "./terminal.ts";
import { Enrolment, type HostApi } from "./enrol.ts";
import { CALL_TIMEOUT_MS, Holders, type RetiredTerminals } from "./holder.ts";
import { DockerCli, type DockerInfo } from "../backends/docker/cli.ts";
import { RELAY_ROUTE, RelayHub } from "../relay/hub.ts";
import { hostContract } from "../host/contract.ts";
import { Refreshing } from "./refreshing.ts";
import type { ThreadOnBox } from "./contract.ts";
import { newBoxHost, registerNewBox } from "./new-box.ts";
import { registerRpc } from "./rpc.ts";
import { registerTools } from "./tools.ts";
import { boxView, kindViews, threadsWords, type BackendView, type BoxView, type DoctorView, type KindView } from "./views.ts";

/** Realtime channel: a thread's boxes, the kinds or the backends changed. The panel refetches. */
export const CHANGED = "changed";

/** In a box that is a BB machine, the program of the process whose workers carry BB's variables. */
const DAEMON_PARENT = "host-daemon/dist/daemon-bundle";
const SWEEP_EVERY_MS = 3 * 60_000;
const DOCTOR_TIMEOUT_MS = 30_000;
/**
 * What BB's daemon gives its workers besides the machine variables: the
 * GitHub token and the user's git identity. A user without GitHub in BB
 * still has the identity, which ends the enrolment's wait for a worker.
 */
const DAEMON_NAMES = ["GH_TOKEN", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
/** How long the names of BB's machine variables are kept before a refresh. */
const NAMES_FRESH_MS = 60_000;
/** How long the host call that opens a Docker relay may take, the worker's start included. */
const RELAY_CALL_TIMEOUT_MS = 15_000;
/** bb-box's version, which the move from BB's settings records. */
export const VERSION: string = packageJson.version;

/** What the tools, RPC and CLI work with. */
export interface BbBox {
  readonly boxes: Boxes;
  readonly backends: Backends;
  readonly enrolment: Enrolment;
  /** Desktop viewers and who controls each desktop's input. */
  readonly desktops: Desktops;
  readonly terminals: Terminals;
  /** The agent's computer use of desktop boxes (015). */
  readonly computer: Computer;
  /** The configuration document (029). */
  readonly configuration: Configuration;
  /** The Docker API relay to BB machines that are Docker hosts (042). */
  readonly relay: RelayHub;
  /** Docker on BB machine `machine`, by ID or name, through the relay, and how long it took. */
  dockerCheck(machine: string, signal?: AbortSignal): Promise<{ hostId: string; name: string; endpoint: string; info: DockerInfo; firstMs: number; againMs: number }>;
  general(): Promise<GeneralConfig>;
  view(box: BoxRecord): BoxView;
  /** Who controls a box's desktop. */
  control(box: BoxRecord): ControlView;
  /** With each kind's sizes from bb-box's settings. */
  kinds(): Promise<KindView[]>;
  backendViews(): BackendView[];
  doctor(signal?: AbortSignal): Promise<DoctorView>;
  /**
   * Takes back an install ID this install had before it lost its storage
   * (018). Refused while a box holds a guest, since its guest carries the
   * current ID.
   */
  setInstallId(id: string): Promise<void>;
  /** The machine and directory a thread works in, for copying files to and from its boxes. */
  workspace(threadId: string, signal?: AbortSignal): Promise<{ hostId: string; path: string | null }>;
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
  checkInUse(box: BoxRecord, action: "Releasing" | "Stopping"): Promise<ThreadOnBox[]>;
}



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

/** Set, as opposed to null or missing. */
function isSet(value: unknown): boolean {
  return value !== null && value !== undefined;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
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
  /** How long a terminal session stays with no tab showing it. */
  readonly terminalIdleMs?: number;
  /** How long an enrolment waits for a worker of BB's daemon with the thread's variables. */
  readonly variablesWaitMs?: number;
  /** Computer use's waits, shorter in tests. */
  readonly computer?: Pick<ComputerDeps, "idleMs" | "pauseWaitMs" | "callTimeoutMs" | "launchWaitMs" | "pageWaitMs" | "desktopWaitMs" | "smallTree">;
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
  const earlier = earlierSettings(drivers);
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

  const backends = new Backends({ storage: kv, installId: await loadInstallId(kv), logError, drivers });
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
    },
    logError,
  });
  await configuration.configure();
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
  const variableNames = new Refreshing<readonly string[]>({
    freshMs: NAMES_FRESH_MS,
    onError: (error) => logError("variable names", error),
    async load(projectId) {
      if (!projectId) return (await bb.sdk.system.machineEnvironment()).variables.map((variable) => variable.name);
      const project = await bb.sdk.projects.machineEnvironment({ projectId });
      return [...project.inheritedVariables, ...project.variables].map((variable) => variable.name);
    },
  });
  const names = async (box: BoxRecord): Promise<string[]> => {
    const [system, project] = await Promise.all([variableNames.get(""), box.projectId ? variableNames.get(box.projectId) : []]);
    return [...new Set([...DAEMON_NAMES, ...system, ...project])];
  };

  // bb-box's host entry on each enrolled box keeps a process with the thread's access, as BB's workers come and go.
  const host = bb.hosts.experimental_client({ contract: hostContract });
  const holders = new Holders({
    access: (hostId, names) => host.call("access", { names: [...names] }, { hostId, timeoutMs: CALL_TIMEOUT_MS }),
    terminals: () => bb.sdk.terminals as unknown as RetiredTerminals,
    logError,
    log: (message) => bb.log.info(message),
  });
  host.experimental_onWorkerExit(({ hostId }) => holders.forget(hostId));

  // The Docker API relay (042): a socket per BB machine for the docker CLI, each
  // connection a channel on one WebSocket the machine's worker opens out to this route.
  const relay = new RelayHub({
    open: (hostId, secret, signal) =>
      host.call("relay", { secret, path: `/api/v1/plugins/${bb.pluginId}/http${RELAY_ROUTE}` }, { hostId, signal, timeoutMs: RELAY_CALL_TIMEOUT_MS }),
    // No box uses the relay yet, so an idle one closes.
    keep: async () => false,
    logError,
    log: (message) => bb.log.info(message),
  });
  bb.http.experimental_websocket(RELAY_ROUTE, ({ url }) => relay.route(url), { auth: "none" });
  bb.onDispose(() => relay.dispose());
  let enrolment: Enrolment;
  let desktops: Desktops | undefined;
  let terminals: Terminals | undefined;
  let computer: Computer | undefined;
  const boxes = new Boxes({
    kv: bb.storage.kv,
    backends,
    general,
    notify,
    recorded(box, deleted) {
      // Fetched while the box starts, for its enrolment.
      if (!deleted && box.state === "acquiring") void names(box).catch(() => {});
      // A desktop that stops, restarts or goes gives control back to the agent.
      if (deleted || box.state !== "ready") {
        desktops?.control.forget(box.id);
        computer?.forget(box.id);
        // Its shells are gone with it; their tabs hear why.
        void terminals?.end(box.id, deleted ? "The box was released." : box.state === "stopped" || box.state === "stopping" ? "The box stopped." : "The box is no longer running.");
      }
    },
    async thread(threadId): Promise<ThreadLiveness> {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        return isSet(thread.archivedAt) || isSet(thread.deletedAt) ? "ended" : "live";
      } catch (error) {
        return isMissingThread(error) ? "ended" : "unknown";
      }
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
    access: async (box) => {
      const listed = await names(box);
      if (box.enrol.hostId) await holders.ensure(box.enrol.hostId, listed);
      return { names: listed, parent: options.daemonParent ?? DAEMON_PARENT };
    },
    logError,
    log: (message) => bb.log.info(message),
  });
  enrolment = new Enrolment({
    boxes,
    hosts: () => bb.sdk.hosts as unknown as HostApi,
    bootstrap: (request) => bb.experimental_machines.bootstrap(request),
    logError,
    log: (message) => bb.log.info(message),
    variablesWaitMs: options.variablesWaitMs,
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
    owner: (boxId) => desktops?.control.view(boxId).owner ?? "agent",
    takeBack: (boxId) => desktops?.control.takeBack(boxId) ?? Promise.resolve(false),
    logError,
    ...options.computer,
  });
  computer = computing;
  const desktop = registerDesktop(bb, { boxes, notify, logError, staleMs: options.controlStaleMs, pause: (boxId) => computing.pause(boxId) });
  desktops = desktop;
  const terminal = registerTerminals(bb, { boxes, logError, idleMs: options.terminalIdleMs });
  terminals = terminal;
  const control = desktop.control;

  // Disposed in reverse: boxes first, so acquires stop before their backends.
  bb.onDispose(() => backends.dispose());
  bb.onDispose(() => boxes.dispose());
  bb.onDispose(() => desktop.dispose());
  bb.onDispose(() => terminal.dispose());
  bb.onDispose(() => computing.dispose());

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
    void boxes.releaseThread(thread.id).catch((error) => logError("thread archived", error));
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    threadHosts.delete(thread.id);
    void boxes.releaseThread(thread.id).catch((error) => logError("thread deleted", error));
  });
  bb.events.on("experimental_host.deleted", ({ host }) => {
    holders.forget(host.id);
    void enrolment.forgetHost(host.id).catch((error) => logError("host deleted", error));
  });

  bb.background.service("sweeper", {
    async start(signal) {
      await enrolment.resume().catch((error) => logError("resume enrolment", error));
      // What this release adds to a kind reaches boxes made before it (#215).
      await boxes.refreshCapabilities().catch((error) => logError("capabilities", error));
      while (!signal.aborted) {
        await boxes.sweep(signal).catch((error) => {
          if (!signal.aborted) logError("sweep", error);
        });
        await enrolment.sweep().catch((error) => logError("sweep enrolment", error));
        await sleep(SWEEP_EVERY_MS, signal);
      }
    },
  });

  /** Each thread's machine, once it has an environment. */
  const threadHosts = new Map<string, string>();
  const api: BbBox = {
    boxes,
    backends,
    enrolment,
    relay,
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
    terminals: terminal,
    computer: computing,
    configuration,
    general,
    view: (box) => boxView(box, boxes.canStopStart(box), control.view(box.id)),
    control: (box) => control.view(box.id),
    kinds: async () => {
      const config = await general();
      return kindViews(backends.kinds(), config.sizes, await boxes.spareCounts(), config.spares);
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
          const report = await boundedDoctor((bounded) => backend.doctor(bounded), DOCTOR_TIMEOUT_MS, signal);
          await configuration.recordDoctor(backend.id, report);
          return { title: backend.label, report };
        }),
      );
      sections.push(...reports);
      const offers = offerChecks(backends.kinds());
      if (offers.length) {
        sections.push({
          title: "Kinds",
          report: { ok: true, summary: "Offers of each kind agree.", checks: offers, notes: [] },
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
        .map((thread) => ({ id: thread.id, title: thread.title ?? thread.titleFallback ?? null, running: working.has(thread.status) || thread.hasPendingInteraction }));
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
    async startThread({ threadId, box: ref, prompt, title, signal }) {
      let box = await boxes.get(threadId, ref);
      if (box.state !== "ready") throw new BoxError("not_ready", `Box ${box.name} is ${box.state}. Start a thread on it once it is ready.`);
      box = await boxes.enrolled(box, signal);
      if (box.enrol.state !== "enrolled" || !box.enrol.hostId) {
        const why =
          box.enrol.state === "enrolling"
            ? "it is still becoming a BB machine. Try again in a few seconds"
            : box.enrol.state === "failed"
              ? `its enrolment as a BB machine failed: ${box.enrol.error ?? "no reason given"}`
              : "it is not a BB machine. Its kind does not enrol, or enrolment is off in bb-box's settings";
        throw new BoxError("unsupported", `A thread cannot run on box ${box.name}: ${why}.`);
      }
      const projectId = box.projectId ?? (await projectOf(threadId));
      if (!projectId) throw new BoxError("unsupported", "This thread has no project, so a thread on its box would have none either.");
      const hostId = box.enrol.hostId;
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
      });
      await bb.sdk.threads.update({ threadId: thread.id, parentThreadId: threadId });
      return thread.id;
    },
  };

  registerTools(bb, api);
  registerComputerTools(bb, api);
  registerRpc(bb, api);
  registerCli(bb, api);
  return api;
}
