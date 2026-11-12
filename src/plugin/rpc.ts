// The panel's RPC handlers. A failed change comes back as a message for the
// panel to show, not as an RPC error.

import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { writeHeapSnapshot } from "node:v8";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, SPARES, describeError, ownedByThread, type BoxRecord } from "../core/boxes.ts";
import { BY_PERSON } from "../core/box-log.ts";
import { ControlError } from "../core/control.ts";
import { contract, type BoxEntry, type BoxPageState, type BoxResult, type DeviceBoot, type MachineEntry, type MonitorReach, type ResizeResult, type ThreadOnBox } from "./contract.ts";
import { lastActiveAt, startedAt } from "./thread-on-box.ts";
import { gpuMates } from "./gpu-page.ts";
import { settingsCards } from "./gpu-settings.ts";
import { sizeView } from "./views.ts";
import type { SizeRequest } from "../core/sizes.ts";
import type { BbBox } from "./setup.ts";
import { profileLoop, type CpuProfile, type HeapProfile } from "./profile.ts";
import { GENERAL_DEFAULTS } from "../core/document.ts";
import { withPurposes } from "../transports/spawns.ts";
import { desktopDisplays, type GpuPart, type GpuResize } from "../backends/types.ts";
import { DEVICE_COPY_NEEDS_CONTROL_WORDS } from "./devices.ts";
import { MONITOR_OFF_WORDS, monitorRpcHandlers, readableState, unreadReason } from "./monitor.ts";
import { DROPPED_REPLY_MESSAGE } from "./live-checks.ts";
import { filesHandlers } from "./box-fs.ts";
import { answered, boxSnapshotsView, forkPreview, keepPreview, PERSON, personStanding, restorePreview, restoreStopped, TakeChecks, type BoxSnapshotsView, type SnapshotChange } from "./snapshot-card.ts";
import { bulkApply, bulkCheck, snapshotsTab } from "./snapshots-tab.ts";
import { standingOfRecord } from "../core/snapshots.ts";
import type { Standing } from "../core/snapshot.ts";

/** How many kept profiles stay: older ones go as a new one is kept. */
import { PRODUCT } from "../brand.ts";
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

const NOT_HERE: BoxPageState = { box: null, threadId: null, owner: null, thread: null, threads: [], monitor: { is: "not-running", machineId: null, why: null }, deviceFailed: null, ended: null };

function listed(box: BoxRecord): boolean {
  return ownedByThread(box.threadId) || box.threadId === OPERATOR;
}

const SNAPSHOT_ANSWER_WAIT_MS = 3_000;
const RESTORE_ANSWER_WAIT_MS = 60_000;

const CARDS_READ_MS = 15_000;

function answerWithin<T>(ms: number, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const signal = AbortSignal.timeout(ms);
  const late = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error(`no answer in ${ms / 1000} s`)), { once: true }));
  return Promise.race([work(signal), late]);
}

export function registerRpc(bb: BbPluginApi, app: BbBox): void {
  const { boxes, snapshots } = app;
  const takeChecks = new TakeChecks(snapshots);

  const snapshotsOf = async (box: BoxRecord): Promise<BoxSnapshotsView | null> => {
    try {
      return boxSnapshotsView(snapshots, box, await takeChecks.why(box));
    } catch (error) {
      bb.log.warn(`Could not read box ${box.name}'s snapshots for its page: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  };

  const pageBox = async (boxId: string): Promise<BoxRecord> => {
    const found = await boxes.find(boxId);
    if (!found || !listed(found)) throw new BoxError("not_found", "That box is gone.");
    return found;
  };

  const standingFor = async (boxId: string, snapshot: string): Promise<{ readonly standing: Standing; readonly box: BoxRecord | null }> => {
    const found = await boxes.find(boxId);
    if (found && listed(found)) return { standing: personStanding(found), box: found };
    const record = snapshots.ledger.record(snapshot) ?? snapshots.ledger.records({ box: boxId }).find((each) => each.name === snapshot) ?? null;
    if (record && record.box.id === boxId && record.boxGone) return { standing: standingOfRecord(record), box: null };
    throw new BoxError("not_found", "That box is gone.");
  };

  const snapshotAct = async (boxId: string, snapshot: string, action: string, work: (standing: Standing, box: BoxRecord | null) => Promise<unknown>): Promise<SnapshotChange> => {
    try {
      const { standing, box } = await standingFor(boxId, snapshot);
      if (box) takeChecks.forget(box.id);
      return await answered(work(standing, box), SNAPSHOT_ANSWER_WAIT_MS);
    } catch (error) {
      return { error: describeError(error, action), pending: false };
    }
  };

  const keepInput = (days?: number, until?: string) => ({ ...(days !== undefined ? { days } : {}), ...(until !== undefined ? { until } : {}) });

  const snapshotChange = async (boxId: string, action: string, work: (box: BoxRecord) => Promise<unknown>): Promise<SnapshotChange> => {
    try {
      const box = await pageBox(boxId);
      takeChecks.forget(box.id);
      return await answered(work(box), SNAPSHOT_ANSWER_WAIT_MS);
    } catch (error) {
      return { error: describeError(error, action), pending: false };
    }
  };

  const monitorReach = async (box: BoxRecord): Promise<MonitorReach> => {
    if (!app.monitor.config().enabled) return { is: "off", machineId: null, why: MONITOR_OFF_WORDS };
    if (!readableState(box.state)) return { is: "not-running", machineId: null, why: `${box.name} is not running.` };
    const machine = (await app.monitor.machines().catch(() => [])).find((each) => each.boxId === box.id);
    if (machine) return { is: "read", machineId: machine.id, why: null };
    return { is: "unreadable", machineId: null, why: unreadReason(box.name, box.enrol) };
  };

  const deviceFailed = (box: BoxRecord): DeviceBoot | null => {
    const view = app.devices.view(box.id);
    return view.is === "connected" && view.state.power.is === "failed" ? { model: view.state.model, words: view.state.power.error.words } : null;
  };
  const change = async (action: string, task: () => Promise<BoxRecord | null>): Promise<BoxResult> => {
    try {
      const box = await task();
      return { box: box ? app.view(box) : null, error: null };
    } catch (error) {
      return { box: null, error: error instanceof ControlError ? error.message : describeError(error, action) };
    }
  };

  const workingOn = async (box: BoxRecord): Promise<ThreadOnBox[]> => {
    const [holder, onMachine] = await Promise.all([app.holderOf(box).catch((): ThreadOnBox => ({ id: box.threadId, title: null, running: false, unchecked: true })), app.threadsOn(box)]);
    const working = onMachine.filter((thread) => thread.running && thread.id !== holder?.id);
    return holder && (holder.running || holder.unchecked) ? [holder, ...working] : working;
  };

  /** Leaves a box a thread runs on alone unless forced, and names the threads, so the panel can ask. */
  const guarded = async (threadId: string, ref: string, force: boolean | undefined, task: () => Promise<BoxResult>): Promise<BoxResult> => {
    if (!force) {
      try {
        const box = await boxes.get(threadId, ref);
        const threads = await workingOn(box);
        if (threads.length) return { box: app.view(box), error: null, threads };
      } catch (error) {
        return { box: null, error: describeError(error, "Checking the box") };
      }
    }
    return task();
  };

  function sizeAndGpu(size: (SizeRequest & { readonly gpu?: GpuPart }) | undefined): { size?: SizeRequest; gpu?: GpuPart } {
    if (!size) return {};
    const { gpu, ...rest } = size;
    return { ...(Object.keys(rest).length ? { size: rest } : {}), ...(gpu !== undefined ? { gpu } : {}) };
  }

  function gpuChangeView(gpu: GpuResize | null | undefined) {
    if (!gpu) return null;
    return {
      from: gpu.from,
      to: gpu.to,
      way: gpu.way,
      stopped: gpu.stopped,
      installs: gpu.installs,
      words: gpu.words,
      fromIndex: gpu.fromCard?.index ?? null,
      toIndex: gpu.toCard?.index ?? null,
      refusal: gpu.refusal?.person ?? (gpu.way === "no" ? gpu.words : null),
      others: gpu.others,
      changed: gpu.changedSinceAgreed?.person ?? null,
    };
  }

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
        reportPlan: true,
        by: "the panel",
        who: BY_PERSON,
        beforeRestart: async (found) => {
          if (options.force) return;
          const threads = await workingOn(found);
          if (threads.length) throw new Working(threads);
        },
      });
      const gib = (part: string, value: number | null) => (value !== null && part === "memory" ? value / 1024 : value);
      const gpu = gpuChangeView(answer.plan?.gpu);
      const plan = answer.plan && {
        parts: answer.plan.parts.map((part) => ({ part: part.part, from: gib(part.part, part.from), to: gib(part.part, part.to)!, way: part.way })),
        room: { ok: answer.plan.room.ok, message: answer.plan.room.message },
        downSeconds: answer.plan.downSeconds,
        ...(gpu ? { gpu } : {}),
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
      const project = await app.projectOf(threadId).catch(() => null);
      const audience = await boxes.audienceNow(threadId, project);
      const [list, kinds, machine, desktopOnDemand, access] = await Promise.all([boxes.list(threadId), app.kinds(audience), app.runsOn(threadId), app.desktopOnDemand(audience).catch(() => null), app.machineAccess().catch(() => null)]);
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
      change("Acquiring a box", async () => {
        const asked = sizeAndGpu(size);
        return boxes.acquire({ threadId, projectId: await app.projectOf(threadId), kind, ...asked, ...(on ? { on } : {}), ...(image ? { image } : {}), ...(device ? { device } : {}), ...(dedicated ? { dedicated } : {}), ...(shared ? { shared } : {}), who: BY_PERSON });
      }),
    images: async ({ threadId, projectId }) => app.imageOptions(projectId ?? (threadId ? await app.projectOf(threadId).catch(() => null) : null)),
    release: ({ threadId, box, force, deleteKept }) =>
      guarded(threadId, box, force, () =>
        change("Releasing the box", async () => {
          if (deleteKept) await snapshots.unkeepForRelease(await boxes.get(threadId, box), BY_PERSON);
          return boxes.release(threadId, box, "released in BB Box's panel", BY_PERSON);
        }),
      ),
    stop: ({ threadId, box, force }) => guarded(threadId, box, force, () => change("Stopping the box", () => boxes.stop(threadId, box, undefined, BY_PERSON))),
    start: ({ threadId, box }) => change("Starting the box", () => boxes.start(threadId, box, undefined, BY_PERSON)),
    resize: ({ threadId, box, ...options }) => resize(threadId, box, options),
    refresh: ({ threadId, box }) => change("Checking the box", () => app.checkNow(threadId, box)),
    enrol: ({ threadId, box }) => change("Adding the box to BB", async () => (await app.joinAgain(threadId, box)).box),
    forget: ({ threadId, box }) =>
      change("Forgetting the box", async () => {
        await app.forget(threadId, box, BY_PERSON);
        return null;
      }),
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
    ...monitorRpcHandlers(app.monitor, () => app.history.store.fullWords()),
    async "monitor.history"({ box: boxId, range }) {
      const found = await boxes.find(boxId);
      if (!found || !listed(found)) return null;
      return app.history.view(found, range);
    },
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
    async allBoxes(): Promise<BoxEntry[]> {
      const all = (await boxes.all()).filter((box) => listed(box)).sort((a, b) => a.createdAt - b.createdAt);
      const holders = new Map<string, Promise<ThreadOnBox | null>>();
      const holderOf = (box: BoxRecord) => {
        if (!holders.has(box.threadId)) holders.set(box.threadId, app.holderOf(box).catch((): ThreadOnBox => ({ id: box.threadId, title: null, running: false, unchecked: true })));
        return holders.get(box.threadId)!;
      };
      const now = Date.now();
      return Promise.all(
        all.map(async (box): Promise<BoxEntry> => {
          const view = app.view(box);
          const yours = box.threadId === OPERATOR;
          const thread = yours ? null : await holderOf(box);
          const threads = yours ? await app.threadsOn(box).catch(() => []) : thread && !thread.unchecked ? [thread] : [];
          const started = startedAt(view);
          return { threadId: box.threadId, box: view, owner: yours ? "yours" : "thread", thread, ...(yours ? { threads } : {}), busy: app.history.busy(box), startedAt: started, activeAt: lastActiveAt(threads, started, now) };
        }),
      );
    },
    async boxPage({ box: boxId }): Promise<BoxPageState> {
      const found = await boxes.find(boxId);
      if (!found || !listed(found)) return { ...NOT_HERE, ended: app.boxLog.ended(boxId) };
      const yours = found.threadId === OPERATOR;
      const [thread, threads, monitor, snapshotsView, all] = await Promise.all([app.holderOf(found).catch(() => null), app.threadsOn(found).catch(() => []), monitorReach(found), snapshotsOf(found), boxes.all()]);
      const view = app.view(found);
      const mates = gpuMates(view, all.filter((box) => listed(box)).map((box) => app.view(box)));
      return { box: view, threadId: found.threadId, owner: yours ? "yours" : "thread", thread, threads, monitor, deviceFailed: deviceFailed(found), ended: null, snapshots: snapshotsView, busy: app.history.busy(found), ...(mates.length ? { gpuMates: mates } : {}) };
    },
    async "snapshot.takeCheck"({ box: boxId, memory }) {
      try {
        const box = await pageBox(boxId);
        return { check: await snapshots.checkTake(PERSON, box, personStanding(box), memory !== undefined ? { memory } : {}), refusal: null };
      } catch (error) {
        return { check: null, refusal: describeError(error, "Planning the snapshot") };
      }
    },
    "snapshot.take": ({ box, name, note, memory, request }) =>
      snapshotChange(box, "Taking the snapshot", (found) =>
        snapshots.take(PERSON, found, personStanding(found), { ...(name?.trim() ? { name } : {}), ...(note?.trim() ? { note } : {}), ...(memory !== undefined ? { memory } : {}), request }),
      ),
    async "snapshot.restoreCheck"({ box: boxId, snapshot }) {
      try {
        return await restorePreview(snapshots, await pageBox(boxId), snapshot);
      } catch (error) {
        return { refusal: describeError(error, "Planning the restore"), threads: [], threadsUnread: null, control: false, terminals: 0, check: null, snapshot: null, token: "", undoUnflushed: null, homeUser: "signed-in" };
      }
    },
    async "snapshot.restore"({ box: boxId, snapshot, undo, accept, token, unflushed, request }) {
      try {
        const box = await pageBox(boxId);
        takeChecks.forget(box.id);
        const fresh = await restorePreview(snapshots, box, snapshot);
        if (fresh.token !== token) {
          return { error: "What the restore would do or end changed since this dialog read it. Read it again below before you restore.", pending: false, preview: fresh };
        }
        const { stopped, whenStopped } = restoreStopped();
        const work = snapshots.restore(PERSON, box, personStanding(box), snapshot, { undo, force: accept.length > 0, accept, unflushed: unflushed ? "go-on" : "stop", request, whenStopped });
        return await answered(work, RESTORE_ANSWER_WAIT_MS, stopped);
      } catch (error) {
        return { error: describeError(error, "Restoring the box"), pending: false };
      }
    },
    "snapshot.delete": ({ box, snapshot, request }) => snapshotAct(box, snapshot, "Deleting the snapshot", (standing) => snapshots.delete(PERSON, standing, snapshot, { request })),
    "snapshot.rename": ({ box, snapshot, name }) => snapshotAct(box, snapshot, "Renaming the snapshot", (standing) => snapshots.rename(PERSON, standing, snapshot, name)),
    "snapshot.note": ({ box, snapshot, note }) => snapshotAct(box, snapshot, "Saving the note", (standing) => snapshots.annotate(PERSON, standing, snapshot, note)),
    async "snapshot.keepCheck"({ box, snapshot, days, until }) {
      try {
        const { standing } = await standingFor(box, snapshot);
        return await keepPreview(snapshots, standing, snapshot, keepInput(days, until));
      } catch (error) {
        return { refusal: describeError(error, "Planning the keep"), check: null };
      }
    },
    "snapshot.keep": ({ box, snapshot, days, until }) => snapshotAct(box, snapshot, "Keeping the snapshot", (standing) => snapshots.keep(PERSON, standing, snapshot, keepInput(days, until))),
    "snapshot.unkeep": ({ box, snapshot }) => snapshotAct(box, snapshot, "Stopping keeping the snapshot", (standing) => snapshots.unkeep(PERSON, standing, snapshot)),
    async "snapshots.tab"() {
      return snapshotsTab(snapshots, (await boxes.all()).filter((box) => listed(box)));
    },
    "snapshots.bulkCheck": ({ snapshots: ids, change, days, until }) => bulkCheck(snapshots, ids, change, keepInput(days, until)),
    "snapshots.bulk": ({ snapshots: ids, change, days, until }) => bulkApply(snapshots, ids, change, keepInput(days, until)),
    async "snapshot.picture"({ box: boxId, snapshot }) {
      const { standing } = await standingFor(boxId, snapshot);
      const picture = snapshots.picture(PERSON, standing, snapshot);
      return picture ? { jpeg: Buffer.from(picture.jpeg).toString("base64"), width: picture.width, height: picture.height } : null;
    },
    "snapshot.settle": ({ box }) => snapshotChange(box, "Checking the restore", () => snapshots.recover()),
    async "snapshot.forkCheck"({ box: boxId, snapshot, asMachine, gpu }) {
      try {
        const { standing, box } = await standingFor(boxId, snapshot);
        return await forkPreview(snapshots, box, standing, snapshot, asMachine === true, gpu);
      } catch (error) {
        return { refusal: describeError(error, "Planning the fork"), check: null };
      }
    },
    async "snapshot.fork"({ box: boxId, snapshot, name, asMachine, gpu, request }) {
      try {
        const { standing, box } = await standingFor(boxId, snapshot);
        const answer = await snapshots.fork(PERSON, { id: standing.box!.id }, standing, snapshot, { ...(name?.trim() ? { name: name.trim() } : {}), asMachine: asMachine === true || !box, ...(gpu ? { gpu } : {}), request });
        return { error: null, box: answer.box ? { id: answer.box.id, name: answer.box.name } : null };
      } catch (error) {
        return { error: describeError(error, "Forking the snapshot"), box: null };
      }
    },
    async "machines.list"() {
      const records = (await boxes.list(OPERATOR)).sort((a, b) => a.createdAt - b.createdAt);
      const [machines, kinds, desktopOnDemand, access] = await Promise.all([
        Promise.all(records.map(async (box): Promise<MachineEntry> => ({ box: app.view(box), threads: await app.threadsOn(box).catch(() => []) }))),
        app.kinds(),
        app.desktopOnDemand().catch(() => null),
        app.machineAccess().catch(() => null),
      ]);
      return { machines, kinds: kinds.filter((kind) => kind.enrol), desktopOnDemand, desktopProblem: app.desktopProblem(OPERATOR), access };
    },
    "machines.add": ({ kind, size, name, on }) =>
      change("Adding the machine", () => boxes.acquire({ threadId: OPERATOR, projectId: null, kind, ...sizeAndGpu(size), ...(name ? { name } : {}), ...(on ? { on } : {}), who: BY_PERSON })),
    "machines.remove": ({ box, force, deleteKept }) =>
      guarded(OPERATOR, box, force, () =>
        change("Removing the machine", async () => {
          if (deleteKept) await snapshots.unkeepForRelease(await boxes.get(OPERATOR, box), BY_PERSON);
          return boxes.release(OPERATOR, box, "removed in BB Box's settings", BY_PERSON);
        }),
      ),
    "machines.stop": ({ box, force }) => guarded(OPERATOR, box, force, () => change("Stopping the machine", () => boxes.stop(OPERATOR, box, undefined, BY_PERSON))),
    "machines.start": ({ box }) => change("Starting the machine", () => boxes.start(OPERATOR, box, undefined, BY_PERSON)),
    "machines.resize": ({ box, ...options }) => resize(OPERATOR, box, options),
    async thread({ threadId, box, prompt }) {
      try {
        return { threadId: await app.startThread({ threadId, box, prompt }), error: null };
      } catch (error) {
        return { threadId: null, error: describeError(error, "Starting a thread on the box") };
      }
    },
    kinds: () => app.kinds(),
    projects: async () => [...(await app.projects())],
    provider: ({ backend }) => app.providerProfile(backend),
    rooms: ({ kind, size }) => app.offerRooms(kind, size),
    "kind.cards": ({ kind }) => app.kindCards(kind),
    backends: () => app.backendViews(),
    doctor: () => app.doctor(),
    "config.get": () => app.configuration.state(),
    "config.cards": async ({ backend: id }) => {
      const backend = app.backends.get(id);
      if (!backend?.cardsInUse) return { is: "none" };
      const read = backend.cardsInUse.bind(backend);
      const inUse = await answerWithin(CARDS_READ_MS, (signal) => read(signal)).catch((error: unknown) => ({ is: "unread" as const, host: null, why: `${PRODUCT} could not read the cards: ${error instanceof Error ? error.message : String(error)}`, setup: null }));
      return settingsCards(inUse, id, (await boxes.all()).map((box) => ({ id: box.id, name: box.name, backend: box.backend })));
    },
    "config.check": ({ draft, test, read }) => app.configuration.check(draft, test, undefined, { read }),
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
    ...filesHandlers(boxes),
  }));
}
