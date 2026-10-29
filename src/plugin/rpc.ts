// The panel's RPC handlers. A failed change comes back as a message for the
// panel to show, not as an RPC error.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, SPARES, describeError, ownedByThread, type BoxRecord } from "../core/boxes.ts";
import { ControlError } from "../core/control.ts";
import { contract, type BoxResult, type ResizeResult, type ThreadOnBox } from "./contract.ts";
import { sizeView } from "./views.ts";
import type { SizeRequest } from "../core/sizes.ts";
import type { BbBox } from "./setup.ts";
import { profileLoop, type CpuProfile, type HeapProfile } from "./profile.ts";
import { GENERAL_DEFAULTS } from "../core/document.ts";
import { withPurposes } from "../transports/spawns.ts";
import { desktopDisplays } from "../backends/types.ts";
import { DEVICE_COPY_NEEDS_CONTROL_WORDS } from "./devices.ts";
import { monitorRpcHandlers } from "./monitor.ts";
import { DROPPED_REPLY_MESSAGE } from "./live-checks.ts";

/** How many kept profiles stay: older ones go as a new one is kept. */
const PROFILES_KEPT = 5;

/** bb-box's own folder of BB's data, beside its database: profiles/. */
async function profileFolder(bb: BbPluginApi): Promise<string> {
  const folder = join(dirname(bb.storage.database().name), "profiles");
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return folder;
}

/** Keeps a profile as profiles/<time>.<extension>, written without holding the loop; and the last five of each. */
async function keepProfile(bb: BbPluginApi, profile: CpuProfile | HeapProfile, extension: "cpuprofile" | "heapprofile"): Promise<string> {
  const folder = await profileFolder(bb);
  const file = join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`);
  await writeFile(file, JSON.stringify(profile), { mode: 0o600 });
  const kept = (await readdir(folder)).filter((name) => name.endsWith(`.${extension}`)).sort();
  for (const old of kept.slice(0, Math.max(0, kept.length - PROFILES_KEPT))) await rm(join(folder, old), { force: true });
  return `kept at ${file}`;
}

/**
 * A full heap snapshot, as profiles/<time>.heapsnapshot, refused unless the machine has as much free memory as the
 * heap uses and a fifth more, as writing one may take about that. Only one is kept.
 */
async function heapSnapshot(bb: BbPluginApi): Promise<string> {
  const used = process.memoryUsage().heapUsed;
  if (freemem() < used * 1.2) throw new Error(`refused: the heap uses ${Math.round(used / 2 ** 20)} MiB and only ${Math.round(freemem() / 2 ** 20)} MiB is free`);
  const folder = await profileFolder(bb);
  for (const old of (await readdir(folder)).filter((name) => name.endsWith(".heapsnapshot"))) await rm(join(folder, old), { force: true });
  const began = performance.now();
  const file = writeHeapSnapshot(join(folder, `${new Date().toISOString().replace(/[:.]/g, "-")}.heapsnapshot`));
  return `kept at ${file}, written in ${Math.round(performance.now() - began)} ms`;
}

export function registerRpc(bb: BbPluginApi, app: BbBox): void {
  const { boxes } = app;
  const change = async (action: string, task: () => Promise<BoxRecord | null>): Promise<BoxResult> => {
    try {
      const box = await task();
      return { box: box ? app.view(box) : null, error: null };
    } catch (error) {
      return { box: null, error: error instanceof ControlError ? error.message : describeError(error, action) };
    }
  };

  /** Leaves a box a thread runs on alone unless forced, and names the threads, so the panel can ask. */
  const guarded = async (threadId: string, ref: string, force: boolean | undefined, task: () => Promise<BoxResult>): Promise<BoxResult> => {
    if (!force) {
      try {
        const box = await boxes.get(threadId, ref);
        const threads = (await app.threadsOn(box)).filter((thread) => thread.running);
        if (threads.length) return { box: app.view(box), error: null, threads };
      } catch (error) {
        return { box: null, error: describeError(error, "Checking the box") };
      }
    }
    return task();
  };

  /** Threads working on a box, which a restart for a resize would stop: the panel names them and asks. */
  class Working extends Error {
    readonly threads: readonly ThreadOnBox[];
    constructor(threads: readonly ThreadOnBox[]) {
      super("Threads are working on the box.");
      this.threads = threads;
    }
  }

  /** A resize as the panel asks it (061): logged as the panel's, the person holding control not refused, threads asked about unless forced. */
  const resize = async (threadId: string, ref: string, options: { size?: SizeRequest; check?: boolean; restart?: boolean; force?: boolean }): Promise<ResizeResult> => {
    const empty = { box: null, from: null, to: null, plan: null, changed: false, machine: null, needsRestart: false, presets: [], largest: null };
    let box: BoxRecord;
    try {
      box = await boxes.get(threadId, ref);
    } catch (error) {
      return { ...empty, error: describeError(error, "Resizing the box") };
    }
    const kind = (await app.kinds().catch(() => [])).find((each) => each.id === box.kind);
    const picker = { presets: kind?.presets ?? [], largest: kind?.largest ?? null };
    try {
      const answer = await boxes.resize(threadId, box.id, options.size ?? {}, {
        check: options.check === true,
        restart: options.restart === true,
        by: "the panel",
        beforeRestart: async (found) => {
          if (options.force) return;
          const threads = (await app.threadsOn(found)).filter((thread) => thread.running);
          if (threads.length) throw new Working(threads);
        },
      });
      const gib = (part: string, value: number | null) => (value !== null && part === "memory" ? value / 1024 : value);
      const plan = answer.plan && {
        parts: answer.plan.parts.map((part) => ({ part: part.part, from: gib(part.part, part.from), to: gib(part.part, part.to)!, way: part.way })),
        room: { ok: answer.plan.room.ok, message: answer.plan.room.message },
        downSeconds: answer.plan.downSeconds,
      };
      const machine = options.check ? null : await app.machineCores(answer).catch(() => null);
      return { ...empty, ...picker, box: app.view(answer.box), from: sizeView(answer.from), to: sizeView(answer.to), plan, changed: answer.changed, machine, error: null };
    } catch (error) {
      const now = await boxes.get(threadId, box.id).catch(() => box);
      if (error instanceof Working) return { ...empty, ...picker, box: app.view(now), threads: error.threads, error: null };
      const needsRestart = error instanceof BoxError && error.code === "needs_restart";
      return { ...empty, ...picker, box: app.view(now), needsRestart, error: error instanceof Error ? error.message : describeError(error, "Resizing the box") };
    }
  };

  const desktopBox = async (threadId: string, ref: string): Promise<BoxRecord> => {
    const { box } = await app.resolve(threadId, ref);
    if (!box.capabilities.displays.length) throw new ControlError(`Box ${box.name} has no desktop.`);
    return box;
  };

  // What each method starts is counted as for it.
  bb.rpc.register(contract, withPurposes("rpc", {
    async state({ threadId }) {
      const [list, kinds, machine, project, desktopOnDemand, access] = await Promise.all([boxes.list(threadId), app.kinds(), app.runsOn(threadId), app.projectOf(threadId).catch(() => null), app.desktopOnDemand().catch(() => null), app.machineAccess().catch(() => null)]);
      const imageOffer = !!project && !Object.values(app.configuration.exported().images ?? {}).some((image) => image.projects.includes(project));
      const images = await app.imageOptions(project).catch(() => []);
      const yours = machine !== null && (machine.threadId === OPERATOR || machine.threadId === SPARES);
      const runsOn =
        machine && !list.some((box) => box.id === machine.id)
          ? { box: app.view(machine), owner: yours ? ("yours" as const) : ("thread" as const), threadId: yours ? null : machine.threadId }
          : null;
      return { boxes: list.map(app.view), kinds, backends: app.backendViews(), desktopPath: app.desktops.path, terminalPath: app.terminals.path, runsOn, imageOffer, images, desktopOnDemand, desktopProblem: app.desktopProblem(threadId), access };
    },
    acquire: ({ threadId, kind, size, on, image, device, dedicated, shared }) =>
      change("Acquiring a box", async () => boxes.acquire({ threadId, projectId: await app.projectOf(threadId), kind, size, ...(on ? { on } : {}), ...(image ? { image } : {}), ...(device ? { device } : {}), ...(dedicated ? { dedicated } : {}), ...(shared ? { shared } : {}) })),
    images: async ({ threadId, projectId }) => app.imageOptions(projectId ?? (threadId ? await app.projectOf(threadId).catch(() => null) : null)),
    release: ({ threadId, box, force }) => guarded(threadId, box, force, () => change("Releasing the box", () => boxes.release(threadId, box, "released in BB Box's panel"))),
    stop: ({ threadId, box, force }) => guarded(threadId, box, force, () => change("Stopping the box", () => boxes.stop(threadId, box))),
    start: ({ threadId, box }) => change("Starting the box", () => boxes.start(threadId, box)),
    resize: ({ threadId, box, ...options }) => resize(threadId, box, options),
    refresh: ({ threadId, box }) => change("Checking the box", () => boxes.refresh(threadId, box)),
    async desktop({ threadId, box: ref }) {
      // A released box shows as gone, not as an error.
      const box = await app.resolve(threadId, ref).then(
        (found) => found.box,
        (error) => {
          if (error instanceof BoxError && error.code === "not_found") return null;
          throw error;
        },
      );
      const video = !!box && (app.configuration.document.general.video ?? GENERAL_DEFAULTS.video) && desktopDisplays(box.capabilities.displays).some((display) => display.protocol === "selkies");
      const videoByDefault = video && !desktopDisplays(box.capabilities.displays).some((display) => display.protocol === "selkies" && display.byChoice);
      const sharp = box ? await app.desktops.sharp(box.id).catch(() => null) : null;
      const switching = !!box && app.desktops.switching(box.id);
      return { box: box ? app.view(box) : null, desktopPath: app.desktops.path, terminalPath: app.terminals.path, video, videoByDefault, sharp, switching };
    },
    "desktop.sharp": async ({ threadId, box: ref, on }) => {
      try {
        const { box } = await app.resolve(threadId, ref);
        await app.desktops.setSharp(box.id, on);
        return { error: null };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
    ping: async () => null,
    ...monitorRpcHandlers(app.monitor),
    async profile({ seconds, keep, allocations, snapshot, collect }) {
      const lines = await profileLoop(seconds, {
        fullCollection: collect === true,
        ...(keep ? { save: (profile: CpuProfile) => keepProfile(bb, profile, "cpuprofile") } : {}),
        ...(allocations ? { allocations: (profile: HeapProfile) => keepProfile(bb, profile, "heapprofile") } : {}),
        ...(snapshot ? { snapshot: () => heapSnapshot(bb) } : {}),
      });
      for (const line of lines) bb.log.info(line);
      return { lines };
    },
    takeControl: ({ threadId, box: ref, viewer }) =>
      change("Taking control", async () => {
        const box = await desktopBox(threadId, ref);
        await app.desktops.control.take(box.id, viewer);
        return box;
      }),
    async desktopClipboard({ threadId, box: ref, viewer }) {
      const box = await desktopBox(threadId, ref);
      return app.desktops.clipboard(box.id, viewer);
    },
    async deviceClipboard({ threadId, box: ref, viewer }) {
      const box = await desktopBox(threadId, ref);
      if (!app.desktops.control.mayInput(box.id, viewer)) return { text: null, error: DEVICE_COPY_NEEDS_CONTROL_WORDS };
      return app.devices.clipboard(box);
    },
    async deviceScreenshot({ threadId, box: ref }) {
      const box = await desktopBox(threadId, ref);
      const answer = await app.devices.screenshot(box);
      if (!answer.ok) return { png: null, model: answer.state?.model ?? null, error: answer.error.words };
      return answer.result.type === "screenshot" ? { png: answer.result.png, model: answer.state.model, error: null } : { png: null, model: answer.state.model, error: "The device server answered without a picture." };
    },
    async desktopPaste({ threadId, box: ref, viewer, text }) {
      const box = await desktopBox(threadId, ref);
      await app.desktops.paste(box.id, viewer, text);
      return null;
    },
    handBack: ({ threadId, box: ref }) =>
      change("Handing back control", async () => {
        const box = await desktopBox(threadId, ref);
        await app.desktops.control.handBack(box.id);
        return box;
      }),
    async allBoxes() {
      const all = await boxes.all();
      return all
        .filter((box) => box.state !== "releasing" && (ownedByThread(box.threadId) || box.threadId === OPERATOR))
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((box) => ({ threadId: box.threadId, box: app.view(box), owner: box.threadId === OPERATOR ? ("yours" as const) : ("thread" as const) }));
    },
    async "machines.list"() {
      const records = (await boxes.list(OPERATOR)).filter((box) => box.state !== "releasing").sort((a, b) => a.createdAt - b.createdAt);
      const [machines, kinds, desktopOnDemand, access] = await Promise.all([
        Promise.all(records.map(async (box) => ({ box: app.view(box), threads: await app.threadsOn(box).catch(() => []) }))),
        app.kinds(),
        app.desktopOnDemand().catch(() => null),
        app.machineAccess().catch(() => null),
      ]);
      return { machines, kinds: kinds.filter((kind) => kind.enrol), desktopOnDemand, desktopProblem: app.desktopProblem(OPERATOR), access };
    },
    "machines.add": ({ kind, size, name, on }) =>
      change("Adding the machine", () => boxes.acquire({ threadId: OPERATOR, projectId: null, kind, ...(size ? { size } : {}), ...(name ? { name } : {}), ...(on ? { on } : {}) })),
    "machines.remove": ({ box, force }) => guarded(OPERATOR, box, force, () => change("Removing the machine", () => boxes.release(OPERATOR, box, "removed in BB Box's settings"))),
    "machines.stop": ({ box, force }) => guarded(OPERATOR, box, force, () => change("Stopping the machine", () => boxes.stop(OPERATOR, box))),
    "machines.start": ({ box }) => change("Starting the machine", () => boxes.start(OPERATOR, box)),
    "machines.resize": ({ box, ...options }) => resize(OPERATOR, box, options),
    async thread({ threadId, box, prompt }) {
      try {
        return { threadId: await app.startThread({ threadId, box, prompt }), error: null };
      } catch (error) {
        return { threadId: null, error: describeError(error, "Starting a thread on the box") };
      }
    },
    kinds: () => app.kinds(),
    provider: ({ backend }) => app.providerProfile(backend),
    rooms: ({ kind, size }) => app.offerRooms(kind, size),
    backends: () => app.backendViews(),
    doctor: () => app.doctor(),
    "config.get": () => app.configuration.state(),
    "config.check": ({ draft, test }) => app.configuration.check(draft, test),
    "config.apply": async ({ draft, revision, operation, submission }) => {
      const result = await app.configuration.apply(draft, revision, operation === undefined ? undefined : { id: operation, submission });
      if (result.ok && !result.replayed && app.replyDrops?.take()) throw new Error(DROPPED_REPLY_MESSAGE);
      return result;
    },
    "config.migrated.remove": async () => ({ removed: await app.configuration.removeMigrated(), state: await app.configuration.state() }),
    "docker.hosts": async (input) => {
      if (input?.recheck) app.dockerHosts.forget(input.recheck);
      return { hosts: await app.dockerHosts.list() };
    },
    "setup.offer": async () => ({ machines: await app.setups(), access: await app.machineAccess() }),
    "images.progress": async () => {
      const standard = await app.imageJobs.failures().catch(() => []);
      const projects = await app.imageBakes.failures().catch(() => []);
      return {
        progress: app.imageJobs.progress(),
        running: app.imageJobs.running(),
        failures: [...standard.map((failure) => ({ of: "standard" as const, ...failure })), ...projects.map((failure) => ({ of: "project" as const, ...failure }))],
      };
    },
    "images.list": async () => {
      const views = await app.imageJobs.list().catch(() => []);
      return {
        images: views.map((view) => {
          const record = view.build.record;
          const age = record ? Math.floor((Date.now() - Date.parse(record.built)) / 86_400_000) : null;
          const when = view.last ? new Date(view.last.at).toISOString().slice(0, 10) : null;
          return {
            name: view.name,
            kind: view.build.kind,
            built: record ? `${record.build}, ${age === 0 ? "built today" : `${age} ${age === 1 ? "day" : "days"} old`}` : "no record",
            due: view.due,
            last: view.last ? (view.last.ok ? `Last rebuilt ${when}` : view.last.waiting ? `Its last rebuild waited, on ${when}: ${view.last.reason}` : `Its last rebuild failed, on ${when}: ${view.last.reason}`) : null,
            backend: view.backend,
            outcome: view.last ? { state: view.last.ok ? ("refreshed" as const) : view.last.waiting ? ("waiting" as const) : ("failed" as const), at: view.last.at, reason: view.last.reason } : null,
          };
        }),
      };
    },
    "images.refresh": async () => app.imageJobs.startNow(),
    "images.build": async ({ image }) => app.imageJobs.startOne(image),
    "setup.desktop": async ({ threadId, hostId, kind, size, name }) => ({ result: await app.buildDesktop({ threadId, hostId, ...(kind ? { kind } : {}), ...(size ? { size } : {}), ...(name ? { name } : {}) }) }),
    "setup.docker": async ({ hostId }) => {
      const result = await app.setDockerHost(hostId, true, true);
      return { result, machines: await app.setups() };
    },
    "docker.host.set": async ({ hostId, enabled, operation }) => {
      const result = await app.setDockerHost(hostId, enabled, false, operation);
      return { result, hosts: await app.dockerHosts.list() };
    },
  }));
}
