import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, BoxKind } from "../src/backends/types.ts";
import { BY_COMMAND, type BoxEventKind } from "../src/core/box-log.ts";
import { BoxError, Boxes, OPERATOR, SPARES, type BoxRecord } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { openBoxFiles } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore } from "../src/plugin/box-log-store.ts";
import { gpuCommands } from "../src/plugin/gpu-cli.ts";
import type { BbBox } from "../src/plugin/setup.ts";
import { boxDetail, boxView, userspaceFixLine } from "../src/plugin/views.ts";
import { FAKE_KINDS, FakeBackend } from "./fake-backend.ts";
import { fakeNvidia, updateCalls, withFakeNvidia, type FakeNvidia } from "./fake-nvidia.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const THREAD = "thr_gpu";
const CARD = { card: "GPU-3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00", index: 0, model: "Fake RTX", memoryMiB: 24_576 } as const;

function world(nvidia: FakeNvidia = fakeNvidia(), nvidiaKinds: readonly string[] = ["linux", "linux-desktop"], spares: Readonly<Record<string, number>> = {}) {
  const root = tempDir("gpu-userspace");
  const kv = new MemoryStorage();
  const storage = scopedStorage(kv, "backend/fake/");
  let handle: Database.Database | null = null;
  const files = openBoxFiles({ database: () => (handle?.open ? handle : (handle = new Database(join(root, "data.db")))) as never }, { log: BOX_LOG_MIGRATIONS, history: [] });
  const linux: BoxKind = { ...FAKE_KINDS[0]!, gpuParts: ["none", "shared"] };
  const desktop: BoxKind = { ...FAKE_KINDS[1]!, gpuParts: ["none", "shared"], capabilities: { ...FAKE_KINDS[1]!.capabilities, gpu: true } };
  const backend = () => {
    const made = new FakeBackend({ root, storage, kinds: [linux, desktop], cards: [CARD], boxesPerCard: 4 });
    withFakeNvidia(made, nvidia, nvidiaKinds);
    return made;
  };
  const state = {
    nvidia,
    kv,
    backend: backend(),
    log: new BoxLogStore({ file: files.log }),
    logs: [] as string[],
    errors: [] as string[],
    boxes: null as unknown as Boxes,
    async restart(dispose = true) {
      if (dispose) await state.boxes.dispose();
      state.backend = backend();
      state.boxes = build();
    },
    kinds(box: BoxRecord): BoxEventKind[] {
      return state.log.events(box.id).map((event) => event.kind);
    },
  };
  const backends = {
    get: (id: string): Backend | null => (id === state.backend.id ? state.backend : null),
    active: (): Backend[] => [state.backend],
    on: (): Backend[] => [state.backend],
    kinds: () => state.backend.kinds().map((kind) => ({ kind, backend: state.backend as Backend })),
  };
  const build = () =>
    new Boxes({
      kv,
      backends,
      general: async () => ({ perThreadLimit: null, enrol: false, sizes: {}, spares }) as unknown as GeneralConfig,
      notify: () => {},
      thread: async () => ({ state: "live", said: "live" }),
      logError: (operation, error) => state.errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
      log: (message) => state.logs.push(message),
      events: state.log,
    });
  state.boxes = build();
  return state;
}

type World = ReturnType<typeof world>;

async function gpuBox(state: World, gpu: "shared" | "none" = "shared", kind = "linux", threadId = THREAD): Promise<BoxRecord> {
  const box = await state.boxes.acquire({ threadId, projectId: null, kind, gpu, who: BY_COMMAND });
  const settled = await state.boxes.settled(box);
  assert.equal(settled?.state, "ready", settled?.error ?? "");
  return settled!;
}

async function found(state: World, box: BoxRecord): Promise<BoxRecord> {
  return (await state.boxes.find(box.id))!;
}

async function rejectionOf(work: Promise<unknown>): Promise<Error & { code?: string }> {
  return work.then(
    () => assert.fail("it was not refused"),
    (error: unknown) => error as Error & { code?: string },
  );
}

test("071 unit 12: --check says what the update does and changes nothing; the update installs the host's driver's userspace over an older one, restarts the box and checks its card", async () => {
  const state = world(fakeNvidia({ processes: ["3310 python3"] }));
  const box = await gpuBox(state);
  assert.equal(box.nvidiaUserspace, "570.86", "read as the acquire made the box");
  assert.deepEqual(box.userspaceRead && { file: box.userspaceRead.file, library: box.userspaceRead.library, hostDriver: box.userspaceRead.hostDriver }, { file: "570.86", library: "570.86", hostDriver: "580.142" });
  state.nvidia.calls.length = 0;

  const plan = await state.boxes.updateUserspace(THREAD, box.id, { check: true });
  assert.equal(plan.needed, true);
  assert.equal(plan.changed, false);
  assert.equal(plan.words, `bb-box installs NVIDIA's userspace 580.142 in ${box.name}, over 570.86, then restarts it. Everything running in it stops: python3 (3310) has the GPU open.`);
  assert.deepEqual(updateCalls(state.nvidia), ["check"]);
  assert.equal((await found(state, box)).userspaceUpdate ?? null, null, "a check records no update");
  assert.equal((await found(state, box)).nvidiaUserspace, "570.86");

  const asked: string[] = [];
  const done = await state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND, beforeRestart: async (seen) => void asked.push(seen.name) });
  assert.deepEqual(asked, [box.name], "the restart's guards are asked once, before anything changes");
  assert.equal(done.changed, true);
  assert.match(done.words, new RegExp(`^Updated NVIDIA's userspace in box ${box.name} from 570\\.86 to 580\\.142, and restarted it, in \\d+ s\\. nvidia-smi in it lists .+, and CUDA's driver initialises\\.$`));
  assert.deepEqual(updateCalls(state.nvidia), ["check", "check", "fetch", "install"]);
  const calls = state.nvidia.calls;
  assert.ok(calls.lastIndexOf("read") > calls.indexOf("install"), "the userspace is read again after the install");
  assert.ok(calls.indexOf("card-check") > calls.indexOf("install"), "the card is checked after the restart");
  const after = await found(state, box);
  assert.equal(after.state, "ready");
  assert.equal(after.nvidiaUserspace, "580.142");
  assert.deepEqual([after.userspaceRead?.file, after.userspaceRead?.library], ["580.142", "580.142"]);
  assert.deepEqual(after.userspaceUpdate && { from: after.userspaceUpdate.from, to: after.userspaceUpdate.to, state: after.userspaceUpdate.state, step: after.userspaceUpdate.step, error: after.userspaceUpdate.error }, {
    from: "570.86",
    to: "580.142",
    state: "done",
    step: "check",
    error: null,
  });
  assert.deepEqual(state.kinds(box).slice(-4), ["stop-asked", "stopped", "start-asked", "started"]);
  assert.deepEqual(state.log.events(box.id).at(-1)?.by, BY_COMMAND, "the restart is the person's command's");
  assert.equal(boxView(after, true, { owner: "agent", holder: null }).userspaceNotice, null);

  state.nvidia.calls.length = 0;
  const again = await state.boxes.updateUserspace(THREAD, box.id, { check: true });
  assert.equal(again.needed, false);
  assert.equal(again.words, `Box ${box.name} already has NVIDIA's userspace 580.142, the host's driver. bb-box changed nothing.`);
  assert.deepEqual(updateCalls(state.nvidia), [], "nothing is checked or fetched when there is nothing to do");
});

test("071 unit 12: an update is refused before anything changes: NVIDIA packages from apt, a stopped box, a box with no GPU, a backend that keeps no userspace, and a host whose driver bb-box cannot tell", async () => {
  const apt = world(fakeNvidia({ apt: ["nvidia-driver-570"] }));
  const box = await gpuBox(apt);
  const conflict = await rejectionOf(apt.boxes.updateUserspace(THREAD, box.id, { check: true }));
  assert.equal(conflict.code, "unsupported");
  assert.equal(conflict.message, `Not changed: box ${box.name} has nvidia-driver-570 from apt, which NVIDIA's installer would conflict with. Remove it, or make a new box with a GPU.`);
  await rejectionOf(apt.boxes.updateUserspace(THREAD, box.id));
  assert.deepEqual(updateCalls(apt.nvidia), ["check", "check"]);
  assert.equal((await found(apt, box)).userspaceUpdate ?? null, null);

  const stopped = world();
  const sleeping = await gpuBox(stopped);
  await stopped.boxes.stop(THREAD, sleeping.id);
  const start = await rejectionOf(stopped.boxes.updateUserspace(THREAD, sleeping.id));
  assert.equal(start.message, `Start box ${sleeping.name} first: NVIDIA's userspace is updated in a running box. Nothing changed.`);
  assert.deepEqual(updateCalls(stopped.nvidia), []);
  assert.equal((await found(stopped, sleeping)).state, "stopped", "a stopped box stays stopped");

  const none = world();
  const plain = await gpuBox(none, "none");
  assert.equal((await rejectionOf(none.boxes.updateUserspace(THREAD, plain.id))).message, `Box ${plain.name} has no GPU, so nothing in it uses NVIDIA's userspace. bb-box changed nothing.`);

  const keepsNone = world(fakeNvidia(), []);
  const docker = await gpuBox(keepsNone);
  assert.match((await rejectionOf(keepsNone.boxes.updateUserspace(THREAD, docker.id))).message, /keeps no NVIDIA userspace in its boxes, so box \S+ has none to update\. bb-box changed nothing\.$/);

  const unknown = world(fakeNvidia({ hostRefused: { why: "The GPU helper on pve-1 is not reporting.", fix: "Try again in a minute." } }));
  const unsure = await gpuBox(unknown);
  assert.equal((await rejectionOf(unknown.boxes.updateUserspace(THREAD, unsure.id))).message, "Not changed: The GPU helper on pve-1 is not reporting. Try again in a minute.");
  assert.deepEqual(updateCalls(unknown.nvidia), []);
});

test("071 unit 12: an install cut short leaves a half-installed userspace, which the box's view, box_status and the doctor name; Update again fixes it", async () => {
  const state = world(fakeNvidia({ install: "fails-half" }));
  const box = await gpuBox(state);
  const failed = await rejectionOf(state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND }));
  assert.equal(failed.code, "failed");
  assert.equal(
    failed.message,
    `bb-box could not install NVIDIA's userspace 580.142 in box ${box.name}: ERROR: An error occurred while performing the step: "Installing 'NVIDIA Accelerated Graphics Driver'". It has a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570.86 now: run bb box gpu update ${box.name} again. It goes on running, and was not restarted.`,
  );
  const half = await found(state, box);
  assert.equal(half.state, "ready");
  assert.equal(half.userspaceUpdate?.state, "failed");
  assert.equal(half.userspaceUpdate?.step, "install");
  assert.deepEqual([half.userspaceRead?.file, half.userspaceRead?.library], ["570.86", "none"]);
  assert.ok(!state.kinds(half).includes("stop-asked"), "a failed install restarts nothing");
  assert.deepEqual(boxView(half, true, { owner: "agent", holder: null }).userspaceNotice, {
    words: "It has a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570.86, so nvidia-smi and CUDA may fail in it.",
    action: "update-again",
  });
  assert.match(boxDetail(half), new RegExp(`^GPU: .*nvidia-smi and CUDA may fail in ${half.name}: it has a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570\\.86\\. Ask the user to update it again\\.$`, "m"));
  assert.equal(userspaceFixLine(half), `NVIDIA userspace: It has a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570.86, so nvidia-smi and CUDA may fail in it. Update it again: bb box gpu update ${half.name} --thread ${THREAD}`);
  const checks = await state.boxes.userspaceChecks();
  const named = checks.find((check) => check.id === `gpu-userspace.${half.name}`);
  assert.equal(named?.status, "warn");
  assert.equal(named?.fix, `Update it again: bb box gpu update ${half.name} --thread ${THREAD}`);

  state.nvidia.install = "works";
  const again = await state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND });
  assert.equal(again.changed, true);
  assert.match(again.words, /from half-installed \(libraries none, version file 570\.86\) to 580\.142/);
  const fixed = await found(state, box);
  assert.equal(fixed.userspaceUpdate?.state, "done");
  assert.equal(boxView(fixed, true, { owner: "agent", holder: null }).userspaceNotice, null);
  assert.equal((await state.boxes.userspaceChecks()).some((check) => check.id.startsWith("gpu-userspace.")), false);
});

test("071 unit 12: bb-box restarting mid-install leaves the update unknown until bb-box reads the box again; the sweep reads it, names the half-installed userspace, and Update again fixes it", async () => {
  const state = world(fakeNvidia({ install: "hangs-half" }));
  const box = await gpuBox(state);
  const updating = state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND }).catch((error: unknown) => error);
  for (let i = 0; i < 400 && !state.nvidia.calls.includes("install"); i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(state.nvidia.calls.includes("install"), "the install began");
  const during = await found(state, box);
  assert.equal(during.userspaceUpdate?.state, "updating");
  assert.equal(during.userspaceUpdate?.step, "install");
  const stopped = state.boxes;
  await state.restart();
  assert.ok((await updating) instanceof Error);
  assert.equal((await rejectionOf(stopped.updateUserspace(THREAD, box.id))).message, "bb-box is stopping, as for an update. Try again once it is back.");
  const cut = await found(state, box);
  assert.equal(cut.userspaceUpdate?.state, "unknown", "bb-box stopped in the middle, so it does not know what the box has");
  assert.match(boxView(cut, true, { owner: "agent", holder: null }).userspaceNotice?.words ?? "", new RegExp(`^An update of NVIDIA's userspace in ${box.name} to 580\\.142 was cut short while installing it, and bb-box has not read its userspace since\\.$`));
  state.nvidia.calls.length = 0;

  await state.boxes.sweep();
  assert.deepEqual(updateCalls(state.nvidia), [], "the sweep reads; it never updates");
  assert.ok(state.nvidia.calls.includes("read"));
  const read = await found(state, box);
  assert.equal(read.userspaceUpdate?.state, "failed");
  assert.match(read.userspaceUpdate?.error ?? "", /When bb-box read the box again, it had a half-installed NVIDIA userspace: no NVIDIA libraries and a version file that says 570\.86\.$/);
  assert.equal(boxView(read, true, { owner: "agent", holder: null }).userspaceNotice?.action, "update-again");

  state.nvidia.install = "works";
  const again = await state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND });
  assert.equal(again.changed, true);
  assert.equal((await found(state, box)).userspaceUpdate?.state, "done");
});

test("071 unit 12: an update left updating by a crash of bb-box is cut short at the next sweep, which settles a box left starting and reads its userspace; one whose install had finished is named as not restarted", async () => {
  const state = world();
  const box = await gpuBox(state);
  state.nvidia.file = "580.142";
  state.nvidia.library = "580.142";
  await state.boxes.update(box, () => ({ state: "starting", userspaceUpdate: { from: "570.86", to: "580.142", at: Date.now(), state: "updating", step: "install", ms: null, error: null } }));
  await state.restart(false);
  const early = (await state.boxes.userspaceChecks()).find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.match(early?.detail ?? "", /did not finish: it stopped while restarting the box: bb-box restarted before the update finished\./, "the doctor does not take an update from before a restart as running");
  await state.boxes.sweep();
  const settled = await found(state, box);
  assert.equal(settled.state, "ready", "a box left starting is settled by its power");
  assert.equal(settled.userspaceUpdate?.state, "failed");
  assert.equal(settled.userspaceUpdate?.step, "restart", "its install had finished, so what is left is the restart");
  assert.ok(state.logs.some((line) => /an update of NVIDIA's userspace was cut short: bb-box restarted before the update finished\./.test(line)));
  assert.deepEqual(boxView(settled, true, { owner: "agent", holder: null }).userspaceNotice, {
    words: `The last update of NVIDIA's userspace in ${box.name} to 580.142 did not finish: it stopped while restarting the box: bb-box restarted before the update finished. When bb-box read the box again, it had NVIDIA's userspace 580.142.`,
    action: "update-again",
  });
  assert.deepEqual(updateCalls(state.nvidia), []);
});

test("071 unit 12: nothing updates NVIDIA's userspace by itself: not an acquire, a start, a stop, the sweep or the doctor, which names the box and the command, running or stopped", async () => {
  const state = world();
  const box = await gpuBox(state);
  await state.boxes.stop(THREAD, box.id);
  await state.boxes.start(THREAD, box.id);
  await state.boxes.sweep();
  await state.boxes.refresh(THREAD, box.id);
  const checks = await state.boxes.userspaceChecks();
  assert.deepEqual(updateCalls(state.nvidia), []);
  assert.equal((await found(state, box)).userspaceUpdate ?? null, null);
  assert.equal((await found(state, box)).nvidiaUserspace, "570.86");

  const summary = checks.find((check) => check.id === "gpu-userspace");
  assert.equal(summary?.status, "ok");
  assert.match(summary?.detail ?? "", /^0 boxes with a GPU have NVIDIA's userspace for their host's driver\. 1 box needs a look, below\. bb-box never updates a box's userspace by itself\.$/);
  const named = checks.find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.deepEqual(named && { status: named.status, detail: named.detail, fix: named.fix }, {
    status: "warn",
    detail: `Box ${box.name} has NVIDIA's userspace 570.86, and the host's driver is 580.142: nvidia-smi and CUDA fail in it until its userspace is updated.`,
    fix: `Update it: bb box gpu update ${box.name} --thread ${THREAD}`,
  });
  const ready = await found(state, box);
  assert.match(boxDetail(ready), new RegExp(`^GPU: .*nvidia-smi in ${box.name} fails: its NVIDIA userspace is 570\\.86 and the host's driver 580\\.142\\. Ask the user to update it\\.$`, "m"));

  await state.boxes.stop(THREAD, box.id);
  const stopped = (await state.boxes.userspaceChecks()).find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.match(stopped?.detail ?? "", / It is stopped: this is as bb-box read it at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\.$/);
  assert.equal(stopped?.fix, `Start ${box.name}, then update it: bb box gpu update ${box.name} --thread ${THREAD}`);
  assert.equal(userspaceFixLine(await found(state, box)), `NVIDIA userspace: Its NVIDIA userspace is 570.86, and the host's driver 580.142: nvidia-smi and CUDA fail in it until its userspace is updated. Update it once it runs: bb box gpu update ${box.name} --thread ${THREAD}`);
  assert.deepEqual(updateCalls(state.nvidia), []);

  await state.boxes.update(box, () => ({ userspaceRead: null, nvidiaUserspace: null }));
  const unread = (await state.boxes.userspaceChecks()).find((check) => check.id === `gpu-userspace.${box.name}`);
  assert.deepEqual(unread && { status: unread.status, detail: unread.detail }, { status: "ok", detail: `Box ${box.name} is stopped, and bb-box has not read its NVIDIA userspace yet: it does when ${box.name} next starts.` });
  await state.boxes.start(THREAD, box.id);
  assert.equal((await found(state, box)).nvidiaUserspace, "570.86", "a start bb-box makes reads it");
});

test("071 unit 12: the doctor reads a running box's userspace now, so a change bb-box did not make is named; a box with no GPU is not checked", async () => {
  const state = world(fakeNvidia({ file: "580.142", library: "580.142" }));
  const box = await gpuBox(state);
  await gpuBox(state, "none");
  assert.deepEqual(
    (await state.boxes.userspaceChecks()).map((check) => [check.id, check.status]),
    [["gpu-userspace", "ok"]],
  );
  state.nvidia.file = "570.86";
  state.nvidia.library = "570.86";
  const checks = await state.boxes.userspaceChecks();
  assert.equal(checks.find((check) => check.id === `gpu-userspace.${box.name}`)?.status, "warn");
  assert.equal((await found(state, box)).nvidiaUserspace, "570.86");
});

type CliRun = (input: { positionals: object; options: Record<string, unknown> }, ctx: object) => Promise<{ exitCode: number; stdout?: string; stderr?: string }>;

function cli(state: World, options: { readonly working?: boolean; readonly snapshots?: boolean } = {}) {
  const taken: string[] = [];
  const guarded: boolean[] = [];
  const app = {
    boxes: state.boxes,
    threadsOn: async () => (options.working ? [{ id: "thr_busy", title: "Train the model", running: true }] : []),
    checkRestart: async (box: BoxRecord, force: boolean) => {
      guarded.push(force);
      if (options.working && !force) throw new BoxError("in_use", `Restarting box ${box.name} would end the work of thread "Train the model", which is working on it. Wait until it is done.`);
      return [];
    },
    snapshots: {
      backendOf: () => state.backend,
      offerFor: () => (options.snapshots ? ({} as never) : null),
      take: async (_caller: unknown, box: BoxRecord, _standing: unknown, input: { readonly name?: string; readonly note?: string }) => {
        taken.push(`${box.name}: ${input.name ?? "named by the time"}: ${input.note}`);
        return { snapshot: { name: "Fri 22:30" } };
      },
    },
  } as unknown as BbBox;
  const run = gpuCommands(app)["gpu update"] as unknown as { run: CliRun };
  return { run: (boxes: string[], flags: Record<string, unknown> = {}) => run.run({ positionals: { box: boxes }, options: { thread: THREAD, ...flags } }, {}), taken, guarded };
}

test("071 unit 12: bb box gpu update --check says what the update does, who is working on the box and that --snapshot takes one first, and changes nothing", async () => {
  const state = world(fakeNvidia({ processes: ["3310 python3"] }));
  const box = await gpuBox(state);
  const { run } = cli(state, { working: true, snapshots: true });
  const checked = await run([box.name], { check: true });
  assert.equal(checked.exitCode, 0);
  assert.equal(
    checked.stdout,
    `bb-box installs NVIDIA's userspace 580.142 in ${box.name}, over 570.86, then restarts it. Everything running in it stops: python3 (3310) has the GPU open. A thread is working on it, "Train the model": the restart ends its work, so bb-box refuses it unless --force. --snapshot takes a snapshot of it first, so you can restore it. Changes nothing (--check).\n`,
  );
  assert.deepEqual(updateCalls(state.nvidia), ["check"]);
  assert.equal((await found(state, box)).userspaceUpdate ?? null, null);
});

test("071 unit 12: bb box gpu update is refused while a thread works on the box unless --force, takes a snapshot first with --snapshot, and updates several boxes one at a time, saying which failed", async () => {
  const state = world();
  const box = await gpuBox(state);
  const busy = cli(state, { working: true, snapshots: true });
  const refused = await busy.run([box.name]);
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stderr ?? "", /^Restarting box \S+ would end the work of thread "Train the model", which is working on it\. Wait until it is done\. \(in_use\)\n$/);
  assert.deepEqual(updateCalls(state.nvidia), ["check"], "refused before any download");
  assert.deepEqual(busy.taken, [], "no snapshot is taken for an update that is refused");

  busy.guarded.length = 0;
  const forced = await busy.run([box.name], { force: true, snapshot: true });
  assert.equal(forced.exitCode, 0, forced.stderr);
  assert.deepEqual(busy.taken, [`${box.name}: named by the time: Taken by bb box gpu update before it installed NVIDIA's userspace 580.142 over 570.86.`], "named by the time, so a second update's snapshot never takes the first's name");
  assert.match(forced.stdout ?? "", new RegExp(`^Took snapshot "Fri 22:30" first\\. Updated NVIDIA's userspace in box ${box.name} from 570\\.86 to 580\\.142`));
  assert.deepEqual(busy.guarded, [true, true], "--force reaches the restart's guard, before the snapshot and before the restart");

  state.nvidia.file = state.nvidia.library = "570.86";
  await state.boxes.readUserspace(await found(state, box));
  const plain = await gpuBox(state, "none");
  const several = await cli(state).run([plain.name, box.name]);
  assert.equal(several.exitCode, 1);
  assert.equal(several.stdout, "");
  const [first, second] = (several.stderr ?? "").trim().split("\n");
  assert.equal(first, `${plain.name}: Box ${plain.name} has no GPU, so nothing in it uses NVIDIA's userspace. bb-box changed nothing. (unsupported)`);
  assert.match(second ?? "", new RegExp(`^${box.name}: Updated NVIDIA's userspace in box ${box.name} from 570\\.86 to 580\\.142`));
});

test("071 unit 12: an update whose check after the restart fails is named as not finished, the box goes on running, and Update again finishes it", async () => {
  const state = world();
  const box = await gpuBox(state);
  state.nvidia.card = null;
  const failed = await rejectionOf(state.boxes.updateUserspace(THREAD, box.id, { who: BY_COMMAND }));
  assert.equal(failed.code, "failed");
  assert.match(failed.message, new RegExp(`^bb-box installed NVIDIA's userspace 580\\.142 in box ${box.name} and restarted it, but its check after the restart failed: nvidia-smi in it listed no card, not its card 3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00 \\(Failed to initialize NVML: Driver/library version mismatch\\)\\. It goes on running\\. Run bb box gpu update ${box.name} again, or bb box doctor\\.$`));
  const after = await found(state, box);
  assert.equal(after.state, "ready");
  assert.equal(after.nvidiaUserspace, "580.142");
  assert.deepEqual([after.userspaceUpdate?.state, after.userspaceUpdate?.step], ["failed", "check"]);
  assert.equal(boxView(after, true, { owner: "agent", holder: null }).userspaceNotice?.action, "update-again", "installed, but not checked, so named until Update again");
  state.nvidia.card = "3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00";
  assert.equal((await state.boxes.updateUserspace(THREAD, box.id, { check: true })).needed, true);
  assert.equal((await state.boxes.updateUserspace(THREAD, box.id)).changed, true);
  assert.equal(boxView(await found(state, box), true, { owner: "agent", holder: null }).userspaceNotice, null);
});

test("071 unit 12: a desktop's update checks that its desktop draws on the GPU and encodes with NVENC after the restart, and fails naming the CPU when it does not", async () => {
  const state = world(fakeNvidia({ display: "cpu" }));
  const box = await gpuBox(state, "shared", "linux-desktop");
  const failed = await rejectionOf(state.boxes.updateUserspace(THREAD, box.id));
  assert.match(failed.message, /its check after the restart failed: its desktop came up on the CPU \(no NVIDIA device nodes\)\./);
  assert.ok(state.nvidia.calls.includes("desktop-check"));
  state.nvidia.display = "gpu";
  state.nvidia.calls.length = 0;
  assert.equal((await state.boxes.updateUserspace(THREAD, box.id)).changed, true);
  assert.ok(state.nvidia.calls.includes("desktop-check"));

  const servers = world();
  await servers.boxes.updateUserspace(THREAD, (await gpuBox(servers)).id);
  assert.ok(!servers.nvidia.calls.includes("desktop-check"), "a server has no desktop to check");
});

test("071 unit 12: one of the person's machines is named with --machine, and spares are left out of the doctor", async () => {
  const state = world(fakeNvidia(), ["linux", "linux-desktop"], { "linux-desktop": 1 });
  const machine = await gpuBox(state, "shared", "linux", OPERATOR);
  const named = (await state.boxes.userspaceChecks()).find((check) => check.id === `gpu-userspace.${machine.name}`);
  assert.equal(named?.fix, `Update it: bb box gpu update ${machine.name} --machine`);
  assert.match(userspaceFixLine(await found(state, machine)) ?? "", new RegExp(`: bb box gpu update ${machine.name} --machine$`));

  await state.boxes.keepSpares();
  await state.boxes.idle();
  const [spare] = await state.boxes.list(SPARES);
  assert.ok(spare, "a desktop spare was made");
  assert.equal(spare.size?.gpu, "shared");
  assert.equal((await state.boxes.userspaceChecks()).some((check) => check.id === `gpu-userspace.${spare.name}`), false);
});

test("071 unit 12: an install that exits well but leaves the old userspace fails its check after the restart, saying what the box has", async () => {
  const state = world(fakeNvidia({ install: "changes-nothing" }));
  const box = await gpuBox(state);
  const failed = await rejectionOf(state.boxes.updateUserspace(THREAD, box.id));
  assert.match(failed.message, new RegExp(`in box ${box.name} and restarted it, but its check after the restart failed: it has NVIDIA's userspace 570\\.86 after its restart\\. It goes on running\\.`));
  assert.deepEqual([(await found(state, box)).userspaceUpdate?.state, (await found(state, box)).userspaceUpdate?.step], ["failed", "check"]);
});

test("071 unit 12: a check after the restart that cannot run fails the update at its check, never leaving it updating", async () => {
  const state = world(fakeNvidia({ cardCheckThrows: true }));
  const box = await gpuBox(state);
  const failed = await rejectionOf(state.boxes.updateUserspace(THREAD, box.id));
  assert.match(failed.message, /its check after the restart failed: Checking the box failed: the connection to the box closed\. It goes on running\./);
  assert.deepEqual([(await found(state, box)).userspaceUpdate?.state, (await found(state, box)).userspaceUpdate?.step], ["failed", "check"]);
});
