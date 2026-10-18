// The panel's RPC handlers. A failed change comes back as a message for the
// panel to show, not as an RPC error.

import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { BoxError, OPERATOR, SPARES, describeError, ownedByThread, type BoxRecord } from "../core/boxes.ts";
import { ControlError } from "../core/control.ts";
import { contract, type BoxResult } from "./contract.ts";
import type { BbBox } from "./setup.ts";
import { profileLoop } from "./profile.ts";
import { GENERAL_DEFAULTS } from "../core/document.ts";

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

  const desktopBox = async (threadId: string, ref: string): Promise<BoxRecord> => {
    const { box } = await app.resolve(threadId, ref);
    if (!box.capabilities.displays.length) throw new ControlError(`Box ${box.name} has no desktop.`);
    return box;
  };

  bb.rpc.register(contract, {
    async state({ threadId }) {
      const [list, kinds, machine, project, desktopOnDemand] = await Promise.all([boxes.list(threadId), app.kinds(), app.runsOn(threadId), app.projectOf(threadId).catch(() => null), app.desktopOnDemand().catch(() => null)]);
      const imageOffer = !!project && !Object.values(app.configuration.exported().images ?? {}).some((image) => image.projects.includes(project));
      const images = await app.imageOptions(project).catch(() => []);
      const yours = machine !== null && (machine.threadId === OPERATOR || machine.threadId === SPARES);
      const runsOn =
        machine && !list.some((box) => box.id === machine.id)
          ? { box: app.view(machine), owner: yours ? ("yours" as const) : ("thread" as const), threadId: yours ? null : machine.threadId }
          : null;
      return { boxes: list.map(app.view), kinds, backends: app.backendViews(), desktopPath: app.desktops.path, terminalPath: app.terminals.path, runsOn, imageOffer, images, desktopOnDemand, desktopProblem: app.desktopProblem(threadId) };
    },
    acquire: ({ threadId, kind, size, on, image }) =>
      change("Acquiring a box", async () => boxes.acquire({ threadId, projectId: await app.projectOf(threadId), kind, size, ...(on ? { on } : {}), ...(image ? { image } : {}) })),
    images: async ({ threadId, projectId }) => app.imageOptions(projectId ?? (threadId ? await app.projectOf(threadId).catch(() => null) : null)),
    release: ({ threadId, box, force }) => guarded(threadId, box, force, () => change("Releasing the box", () => boxes.release(threadId, box, "released in BB Box's panel"))),
    stop: ({ threadId, box, force }) => guarded(threadId, box, force, () => change("Stopping the box", () => boxes.stop(threadId, box))),
    start: ({ threadId, box }) => change("Starting the box", () => boxes.start(threadId, box)),
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
      const video = !!box && (app.configuration.document.general.video ?? GENERAL_DEFAULTS.video) && box.capabilities.displays.some((display) => display.protocol === "selkies");
      const videoByDefault = video && !box.capabilities.displays.some((display) => display.protocol === "selkies" && display.byChoice);
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
    async profile({ seconds }) {
      const lines = await profileLoop(seconds);
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
      const [machines, kinds] = await Promise.all([
        Promise.all(records.map(async (box) => ({ box: app.view(box), threads: await app.threadsOn(box).catch(() => []) }))),
        app.kinds(),
      ]);
      return { machines, kinds: kinds.filter((kind) => kind.enrol) };
    },
    "machines.add": ({ kind, size, name, on }) =>
      change("Adding the machine", () => boxes.acquire({ threadId: OPERATOR, projectId: null, kind, ...(size ? { size } : {}), ...(name ? { name } : {}), ...(on ? { on } : {}) })),
    "machines.remove": ({ box, force }) => guarded(OPERATOR, box, force, () => change("Removing the machine", () => boxes.release(OPERATOR, box, "removed in BB Box's settings"))),
    "machines.stop": ({ box, force }) => guarded(OPERATOR, box, force, () => change("Stopping the machine", () => boxes.stop(OPERATOR, box))),
    "machines.start": ({ box }) => change("Starting the machine", () => boxes.start(OPERATOR, box)),
    async thread({ threadId, box, prompt }) {
      try {
        return { threadId: await app.startThread({ threadId, box, prompt }), error: null };
      } catch (error) {
        return { threadId: null, error: describeError(error, "Starting a thread on the box") };
      }
    },
    kinds: () => app.kinds(),
    provider: ({ backend }) => app.providerProfile(backend),
    backends: () => app.backendViews(),
    doctor: () => app.doctor(),
    "config.get": () => app.configuration.state(),
    "config.check": ({ draft, test }) => app.configuration.check(draft, test),
    "config.apply": ({ draft, revision }) => app.configuration.apply(draft, revision),
    "docker.hosts": async () => ({ hosts: await app.dockerHosts.list() }),
    "setup.offer": async () => ({ machines: await app.setups(), access: await app.machineAccess() }),
    "images.progress": async () => ({ progress: app.imageJobs.progress(), running: app.imageJobs.running() }),
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
          };
        }),
      };
    },
    "images.refresh": async () => app.imageJobs.startNow(),
    "setup.desktop": async ({ threadId, hostId, size }) => ({ result: await app.buildDesktop({ threadId, hostId, ...(size ? { size } : {}) }) }),
    "setup.docker": async ({ hostId }) => {
      const result = await app.setDockerHost(hostId, true, true);
      return { result, machines: await app.setups() };
    },
    "docker.host.set": async ({ hostId, enabled }) => {
      const result = await app.setDockerHost(hostId, enabled);
      return { result, hosts: await app.dockerHosts.list() };
    },
  });
}
