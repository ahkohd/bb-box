// Wires bb-box into BB: settings, the active backends, the box registry,
// enrolment, thread events, the sweep, and the tools, RPC and CLI that use
// them. server.ts calls setup with the built-in drivers; tests pass fakes.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { Backends, DRIVERS, backendSettings, offerChecks } from "../backends/index.ts";
import type { BackendDriver, DoctorReport } from "../backends/types.ts";
import { BoxError, Boxes, type BoxRecord, type ThreadLiveness } from "../core/boxes.ts";
import { Computer, type ComputerDeps } from "../core/computer.ts";
import { GENERAL_SETTINGS, parseGeneral, type GeneralConfig } from "../core/config.ts";
import { loadInstallId, requireInstallId, storeInstallId } from "../core/install.ts";
import type { ControlView } from "../core/control.ts";
import { registerCli } from "./cli.ts";
import { registerComputerTools } from "./computer-tools.ts";
import { registerDesktop, type Desktops } from "./desktop.ts";
import { Enrolment, type HostApi } from "./enrol.ts";
import { registerRpc } from "./rpc.ts";
import { registerTools } from "./tools.ts";
import { boxView, kindViews, type BackendView, type BoxView, type DoctorView, type KindView } from "./views.ts";

/** Realtime channel: a thread's boxes, the kinds or the backends changed. The panel refetches. */
export const CHANGED = "changed";

/** In a box that is a BB machine, the program of the process whose workers carry BB's variables. */
const DAEMON_PARENT = "host-daemon/dist/daemon-bundle";
const SWEEP_EVERY_MS = 3 * 60_000;
const DOCTOR_TIMEOUT_MS = 30_000;

/** What the tools, RPC and CLI work with. */
export interface BbBox {
  readonly boxes: Boxes;
  readonly backends: Backends;
  readonly enrolment: Enrolment;
  /** Desktop viewers and who controls each desktop's input. */
  readonly desktops: Desktops;
  /** The agent's computer use of desktop boxes (015). */
  readonly computer: Computer;
  general(): Promise<GeneralConfig>;
  view(box: BoxRecord): BoxView;
  /** Who controls a box's desktop. */
  control(box: BoxRecord): ControlView;
  kinds(): KindView[];
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

function withTimeout(ms: number, signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(ms)]) : AbortSignal.timeout(ms);
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
  /** Computer use's waits, shorter in tests. */
  readonly computer?: Pick<ComputerDeps, "idleMs" | "pauseWaitMs" | "callTimeoutMs" | "launchWaitMs" | "pageWaitMs" | "desktopWaitMs" | "smallTree">;
}

export async function setup(bb: BbPluginApi, options: SetupOptions = {}): Promise<BbBox> {
  const drivers = options.drivers ?? DRIVERS;
  const settings = bb.settings.define({ ...GENERAL_SETTINGS, ...backendSettings(drivers) });
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

  const backends = new Backends({ storage: bb.storage.kv, installId: await loadInstallId(bb.storage.kv), logError, drivers });
  const initial = await settings.get();
  await backends.configure(initial);
  const general = async () => {
    const parsed = parseGeneral(await settings.get());
    return parsed.ok ? parsed.config : { perThreadLimit: null, enrol: true };
  };

  const projectOf = async (threadId: string): Promise<string | null> => {
    try {
      return (await bb.sdk.threads.get({ threadId })).projectId;
    } catch {
      return null;
    }
  };

  let enrolment: Enrolment;
  let desktops: Desktops | undefined;
  let computer: Computer | undefined;
  const boxes = new Boxes({
    kv: bb.storage.kv,
    backends,
    general,
    notify,
    // A desktop that stops, restarts or goes gives control back to the agent.
    recorded(box, deleted) {
      if (deleted || box.state !== "ready") {
        desktops?.control.forget(box.id);
        computer?.forget(box.id);
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
    enrol: (box) => enrolment.enrol(box),
    unenrol: (box) => enrolment.unenrol(box),
    reconnect: (box) => enrolment.reconnect(box),
    // Names only: BB never gives plugins the values.
    async access(box) {
      const names = new Set(["GH_TOKEN"]);
      for (const variable of (await bb.sdk.system.machineEnvironment()).variables) names.add(variable.name);
      if (box.projectId) {
        const project = await bb.sdk.projects.machineEnvironment({ projectId: box.projectId });
        for (const variable of [...project.inheritedVariables, ...project.variables]) names.add(variable.name);
      }
      return { names: [...names], parent: options.daemonParent ?? DAEMON_PARENT };
    },
    logError,
    log: (message) => bb.log.info(message),
  });
  enrolment = new Enrolment({
    boxes,
    hosts: () => bb.sdk.hosts as unknown as HostApi,
    bootstrap: (request) => bb.experimental_machines.bootstrap(request),
    logError,
  });
  bb.experimental_machines.register(enrolment.provider());
  const computing = new Computer({
    async spawn(box, script, signal) {
      const { command } = await boxes.transports(box);
      if (!command?.spawn) throw new BoxError("unsupported", `Box ${box.name}'s command transport cannot start the computer-use driver.`);
      return command.spawn(script, signal);
    },
    owner: (boxId) => desktops?.control.view(boxId).owner ?? "agent",
    logError,
    ...options.computer,
  });
  computer = computing;
  const desktop = registerDesktop(bb, { boxes, notify, logError, staleMs: options.controlStaleMs, pause: (boxId) => computing.pause(boxId) });
  desktops = desktop;
  const control = desktop.control;

  // Disposed in reverse: boxes first, so acquires stop before their backends.
  bb.onDispose(() => backends.dispose());
  bb.onDispose(() => boxes.dispose());
  bb.onDispose(() => desktop.dispose());
  bb.onDispose(() => computing.dispose());

  const problems = () =>
    backends
      .statuses()
      .filter((backend) => backend.state === "misconfigured")
      .map((backend) => `${backend.label}: ${backend.problems.join(" ")}`);
  const unconfigured = problems();
  if (!backends.active().length) {
    bb.status.needsConfiguration(
      unconfigured.length ? unconfigured.join(" ") : "Turn on a backend in bb-box's settings, then fill in its settings.",
    );
  }
  settings.onChange((next) => {
    void backends
      .configure(next)
      .then(() => notify(null))
      .catch((error) => logError("settings", error));
  });

  bb.events.on("thread.archived", ({ thread }) => {
    void boxes.releaseThread(thread.id).catch((error) => logError("thread archived", error));
  });
  bb.events.on("thread.deleted", ({ thread }) => {
    void boxes.releaseThread(thread.id).catch((error) => logError("thread deleted", error));
  });
  bb.events.on("experimental_host.deleted", ({ host }) => {
    void enrolment.forgetHost(host.id).catch((error) => logError("host deleted", error));
  });

  bb.background.service("sweeper", {
    async start(signal) {
      await enrolment.resume().catch((error) => logError("resume enrolment", error));
      while (!signal.aborted) {
        await boxes.sweep(signal).catch((error) => {
          if (!signal.aborted) logError("sweep", error);
        });
        await enrolment.sweep().catch((error) => logError("sweep enrolment", error));
        await sleep(SWEEP_EVERY_MS, signal);
      }
    },
  });

  const api: BbBox = {
    boxes,
    backends,
    enrolment,
    desktops: desktop,
    computer: computing,
    general,
    view: (box) => boxView(box, boxes.canStopStart(box), control.view(box.id)),
    control: (box) => control.view(box.id),
    kinds: () => kindViews(backends.kinds()),
    backendViews: () =>
      backends.statuses().map((backend) => ({
        ...backend,
        setup: drivers.find((driver) => driver.type === backend.type)?.setup ?? { guide: "", scripts: [] },
      })),
    async doctor(signal) {
      const sections: { title: string; report: DoctorReport }[] = [];
      for (const backend of backends.statuses()) {
        if (backend.state !== "misconfigured") continue;
        sections.push({
          title: backend.label,
          report: {
            ok: false,
            summary: "Its settings need fixing.",
            checks: backend.problems.map((problem, index) => ({
              id: `settings.${index}`,
              name: "Settings",
              status: "fail" as const,
              detail: problem,
              fix: "Fix it in bb-box's settings.",
            })),
            notes: [],
          },
        });
      }
      const reports = await Promise.all(
        backends.active().map(async (backend) => {
          try {
            return { title: backend.label, report: await backend.doctor(withTimeout(DOCTOR_TIMEOUT_MS, signal)) };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return {
              title: backend.label,
              report: {
                ok: false,
                summary: "The checks did not finish.",
                checks: [{ id: "doctor", name: "Checks", status: "fail" as const, detail: message, fix: null }],
                notes: [],
              },
            };
          }
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
  };

  registerTools(bb, api);
  registerComputerTools(bb, api);
  registerRpc(bb, api);
  registerCli(bb, api);
  return api;
}
