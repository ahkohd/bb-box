// The registry against the fake backend: acquire and release, limits and
// capacity, commands and copies, stop and start, and the sweep.

import { withTestDevice } from "../src/backends/index.ts";
import { testDeviceOffer } from "../src/core/device.ts";
import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import { isEarlierKindId } from "../src/backends/kinds.ts";
import { BackendError, DEVICE_DISPLAY, type Backend, type BoxKind, type Guest, type BoxSize, type DisplayCapability, type GpuRoom, type ReleaseHooks, type WithheldKind } from "../src/backends/types.ts";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { gunzipSync } from "node:zlib";
import { join } from "node:path";
import { BoxError, Boxes, OPERATOR, SPARES, extraFeatures, machineName, restartSeconds, withDeviceChecked, type BoxRecord, type BoxesDeps, type SpareSettling, type ThreadLiveness } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { ACCESS_CHECK_EXITS, DESKTOP_EXITS, JOBS_DIR, MAC_CLIPBOARD, MAC_LAUNCHER, WINDOWS_CLIPBOARD, accessCheck, accessSetup, accessSetupMs, clipboardCommands, command, envScript, jobScript, newJobId } from "../src/core/in-box.ts";
import { READER_SOURCE, READER_TYPE } from "../src/core/windows-access.ts";
import { powershellCommand } from "../src/transports/powershell.ts";
import { LOADS_ENV, endMarked } from "../src/transports/process.ts";
import { parseSizeChanges } from "../src/core/sizes.ts";
import { gpuRoomText } from "../src/plugin/tools.ts";
import { adminText, boxDetail, boxLine, boxView, gpuRooms, kindResizeText, kindViews, startingWords, waitingWords, type KindView } from "../src/plugin/views.ts";
import { FAKE_KINDS, FAKE_PWSH, FAKE_WINDOWS_KIND, FakeBackend, type FakeBackendOptions } from "./fake-backend.ts";
import { MemoryStorage, fakeDaemon, tempDir } from "./helpers.ts";
import { inSlot, placementData, placementOf, SHARED_IOS_BY_DEFAULT, type SlotPlacement } from "../src/core/device-host.ts";
import { placementText } from "../src/plugin/views.ts";

const THREAD = "thr_one";

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function setup(options: Omit<FakeBackendOptions, "root" | "storage"> = {}, deps: Pick<BoxesDeps, "access" | "spareThread" | "claimed" | "enrolWaitMs" | "log" | "machineOf" | "projectOf" | "recorded" | "reconnect" | "image" | "baked" | "imageReady" | "imageTools" | "reconnecting" | "imageSpares" | "random" | "tell" | "sharedIosByDefault" | "spareSettled" | "spareClaimed" | "now"> = {}) {
  const root = tempDir("boxes");
  const kv = new MemoryStorage();
  const backendStorage = scopedStorage(kv, "backend/fake/");
  const make = () => new FakeBackend({ root, storage: backendStorage, ...options });
  const world = {
    root,
    kv,
    backend: make() as FakeBackend,
    /** More backends offering kinds, after the first, for a choice of provider (044). */
    others: [] as Backend[],
    /** Backends that are built but off in settings. */
    off: new Set<string>(),
    /** False when the backend is off in settings. */
    active: true,
    testDevice: false,
    general: { perThreadLimit: null, enrol: true, sizes: {}, spares: {} } as GeneralConfig,
    threads: new Map<string, ThreadLiveness>(),
    notified: [] as string[],
    errors: [] as string[],
    enrolled: [] as string[],
    /** The IDs of the boxes enrolled, in order: a new spare can take a claimed one's name. */
    enrolledIds: [] as string[],
    unenrolled: [] as string[],
    reconnected: [] as string[],
    boxes: null as unknown as Boxes,
    /** A new registry and backend on the same storage, as after a restart. */
    restart() {
      world.backend = make();
      world.boxes = registry();
      return world.boxes;
    },
  };
  const offered = (backend: Backend): readonly BoxKind[] => (world.testDevice ? backend.kinds().map(withTestDevice) : backend.kinds());
  const backends = {
    get: (id: string): Backend | null => (world.active ? ([world.backend, ...world.others] as Backend[]).find((backend) => backend.id === id) ?? null : null),
    active: (): Backend[] => (world.active ? [world.backend, ...world.others] : []),
    on: (): Backend[] => (world.active ? [world.backend, ...world.others].filter((backend) => !world.off.has(backend.id)) : []),
    kinds: () =>
      world.active
        ? [world.backend, ...world.others].filter((backend) => !world.off.has(backend.id)).flatMap((backend) => offered(backend).map((kind) => ({ kind, backend: backend as Backend })))
        : [],
    offered,
    withheld: async (kind: string) => {
      const asked = world.active ? [world.backend, ...world.others].filter((backend) => !world.off.has(backend.id)) : [];
      const answers = await Promise.all(asked.map(async (backend) => ((await (backend as Backend).withheldKinds?.(kind)) ?? []).filter((each) => each.kind === kind).map((each) => ({ ...each, backend: backend as Backend }))));
      return answers.flat();
    },
    driverLabel: (id: string) => (id.startsWith("fake") ? "Fake host" : id.split(":")[0]!),
  };
  const registry = () =>
    new Boxes({
      kv,
      backends,
      general: async () => world.general,
      notify: (threadId) => world.notified.push(threadId),
      thread: async (threadId) => {
        const state = world.threads.get(threadId) ?? "live";
        return { state, said: `the test says ${state}` };
      },
      enrol: async (box, options) => {
        world.enrolled.push(options?.restored ? `${box.name}, restored` : box.name);
        world.enrolledIds.push(box.id);
        await world.boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: `host-${box.id}`, error: null } }));
      },
      unenrol: async (box) => {
        world.unenrolled.push(box.enrol.hostId!);
      },
      reconnect: async (box) => {
        world.reconnected.push(box.enrol.hostId!);
      },
      logError: (operation, error) => world.errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
      ...deps,
    });
  world.boxes = registry();
  return world;
}

async function ready(boxes: Boxes, box: BoxRecord): Promise<BoxRecord> {
  const settled = await boxes.settled(box);
  assert.ok(settled, "the box still exists");
  return settled;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function until(check: () => Promise<boolean>): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("timed out waiting");
}

test("a box of a project with an image runs its script as root, then its check, before it is handed over (049)", async () => {
  const image = {
    kinds: ["linux"],
    script: 'echo "$BB_BOX_IMAGE $BB_BOX_KIND $BB_BOX_BACKEND $BB_BOX_ARCH" > "$HOME/ran"\nfor i in $(seq 1 25); do echo "line $i"; done\n[ ! -e "$HOME/../fail-script" ] || exit 3\n',
    check: 'test -s "$HOME/ran" && echo checked\n[ ! -e "$HOME/../fail-check" ] || { echo "cargo: not found"; exit 1; }\n',
    projects: ["prj"],
  };
  const world = setup({}, { image: (projectId, kind) => (projectId === "prj" && kind === "linux" ? { name: "rust-tools", image } : null) });
  const asked = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.deepEqual(asked.image, { name: "rust-tools", state: "pending" });
  const box = await ready(world.boxes, asked);
  assert.equal(box.state, "ready", box.error ?? "");
  assert.deepEqual([box.image?.name, box.image?.state, typeof box.image?.seconds, typeof box.timings.image], ["rust-tools", "done", "number", "number"]);
  const { command } = await world.backend.transports(box.guest!, "linux");
  assert.equal((await command!.run("cat ran")).stdout, `rust-tools linux fake ${box.capabilities.arch}\n`);
  assert.equal((await command!.run("test -e .bb-box-image")).exitCode, 1, "its files go once it ran");

  // Another project's box, or another kind, has none.
  const other = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj_other", kind: "linux" }));
  assert.equal(other.image, undefined);

  // A failing script fails the acquire with its last 20 lines, and the box's guest goes.
  writeFileSync(join(world.root, "fake", "fail-script"), "");
  const failed = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }));
  assert.equal(failed.state, "failed");
  assert.equal(failed.error, `Running rust-tools's script failed: rust-tools's script exited with 3. Its last lines:\n${Array.from({ length: 20 }, (_, i) => `line ${i + 6}`).join("\n")}`);
  assert.deepEqual([failed.guest, failed.image?.state], [null, "failed"]);
  rmSync(join(world.root, "fake", "fail-script"));
  writeFileSync(join(world.root, "fake", "fail-check"), "");
  const unchecked = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }));
  assert.match(unchecked.error ?? "", /^Running rust-tools's script failed: rust-tools's check exited with 1\. Its last lines:\nchecked\ncargo: not found$/);
  assert.equal((await world.backend.held()).filter((guest) => guest.ref === failed.guest?.ref).length, 0);
});

test("a box of a project's image with a current build on its backend starts from it and runs no script, and each box of an image is counted (049)", async () => {
  const image = { kinds: ["linux"], script: 'touch "$HOME/ran"\n', projects: ["prj"] };
  const readied: BoxRecord[] = [];
  const world = setup({}, {
    image: (projectId, kind) => (projectId === "prj" && kind === "linux" ? { name: "rust", image } : null),
    baked: async (name, backend, kind) => (name === "rust" && backend === "fake" && kind === "linux" ? { ref: "rust-build", build: "build.20261003-100000-abcd" } : null),
    imageReady: (box) => void readied.push(box),
  });
  const started: (string | undefined)[] = [];
  const acquire = world.backend.acquire.bind(world.backend);
  world.backend.acquire = (box, previous, hooks, signal) => {
    started.push(box.from);
    return acquire(box, previous, hooks, signal);
  };
  // Only where the backend's builds start boxes.
  const plain = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }));
  assert.deepEqual([plain.image?.state, started], ["done", [undefined]]);
  Object.defineProperty(world.backend, "images", { value: { startsFrom: true } });

  const asked = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.deepEqual(asked.image, { name: "rust", state: "baked", build: "build.20261003-100000-abcd", from: "rust-build" });
  const box = await ready(world.boxes, asked);
  assert.equal(box.state, "ready", box.error ?? "");
  assert.deepEqual(started, [undefined, "rust-build"]);
  const { command } = await world.backend.transports(box.guest!, "linux");
  assert.equal((await command!.run("test -e ran")).exitCode, 1, "the script did not run");
  assert.deepEqual(readied.map((one) => [one.id, one.image?.state]), [[plain.id, "done"], [box.id, "baked"]]);
});

test("a box can start from a given build, as a tried image's kept one, on the backend named, and not elsewhere (#451)", async () => {
  const world = setup();
  const started: (string | undefined)[] = [];
  const acquire = world.backend.acquire.bind(world.backend);
  world.backend.acquire = (box, previous, hooks, signal) => {
    started.push(box.from);
    return acquire(box, previous, hooks, signal);
  };
  const from = { name: "rust (tried)", build: "build.20261007-100000-abcd", ref: "try-build" };
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", from }), /needs the backend that keeps it, in on/);
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", on: "fake", from }), /starts no box from a build/);
  Object.defineProperty(world.backend, "images", { value: { startsFrom: true } });
  const asked = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", on: "fake", from });
  assert.deepEqual(asked.image, { name: "rust (tried)", state: "baked", build: from.build, from: "try-build" });
  const box = await ready(world.boxes, asked);
  assert.equal(box.state, "ready", box.error ?? "");
  assert.deepEqual(started, ["try-build"]);
});

test("an image's script at start finds bb-box's own commands first on its PATH, such as bb-box-feature (049)", async () => {
  const image = { kinds: ["linux"], script: 'hello-tool > "$HOME/tool"\n', projects: ["prj"] };
  const world = setup({}, {
    image: (projectId, kind) => (projectId === "prj" && kind === "linux" ? { name: "tools", image } : null),
    imageTools: { "hello-tool": "#!/bin/sh\necho tool ran\n" },
  });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }));
  assert.equal(box.state, "ready", box.error ?? "");
  const { command } = await world.backend.transports(box.guest!, "linux");
  assert.equal((await command!.run("cat tool")).stdout, "tool ran\n");
  assert.equal((await command!.run("test -e .bb-box-image")).exitCode, 1, "its files go once it ran");
});

test("a box can choose its image, another project's or the standard one, and a thread's own box gets its project's (049)", async () => {
  const images: Record<string, { kinds: string[]; script: string; projects: string[] }> = {
    mine: { kinds: ["linux"], script: 'echo mine > "$HOME/which"\n', projects: ["prj"] },
    theirs: { kinds: ["linux"], script: 'echo theirs > "$HOME/which"\n', projects: ["prj_other"] },
  };
  const world = setup({}, {
    image: (projectId, kind, name) => {
      if (name !== undefined) return images[name]?.kinds.includes(kind) ? { name, image: images[name]! } : null;
      const found = Object.entries(images).find(([, image]) => !!projectId && image.projects.includes(projectId) && image.kinds.includes(kind));
      return found ? { name: found[0], image: found[1] } : null;
    },
  });
  const which = async (box: BoxRecord) => (await (await world.backend.transports(box.guest!, "linux")).command!.run("cat which 2>/dev/null || echo none")).stdout.trim();

  const theirs = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", image: "theirs" }));
  assert.deepEqual([theirs.state, theirs.image?.name, await which(theirs)], ["ready", "theirs", "theirs"], theirs.error ?? "");
  const standard = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", image: "standard" }));
  assert.deepEqual([standard.image, await which(standard)], [undefined, "none"]);
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux", image: "nope" }), /There is no image nope for linux boxes\. box_list names each kind's images; "standard" is bb-box's own\./);
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux-desktop", image: "mine" }), /There is no image mine for linux-desktop boxes/);

  // A thread on a box of its own (033) gets its project's image as any box does.
  const own = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: "prj", kind: "linux", role: "machine" }));
  assert.deepEqual([own.image?.name, await which(own)], ["mine", "mine"]);
});

test("acquire records the box at once and it becomes ready in the background", async () => {
  const world = setup();
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.equal(box.state, "acquiring");
  assert.match(box.name, /^[a-z]+-[a-z]+$/);
  assert.match(box.id, /^bx[a-z2-7]{12}$/);
  assert.equal(box.backend, "fake");
  assert.equal(box.nature, "virtual");

  const done = await ready(world.boxes, box);
  assert.equal(done.state, "ready");
  assert.ok(done.guest);
  assert.ok(done.readyAt);
  assert.deepEqual(Object.keys(done.timings).sort(), ["make", "start", "total"]);
  assert.deepEqual(world.enrolled, [box.name]);
  assert.equal(done.enrol.state, "enrolled");
  assert.ok(world.notified.includes(THREAD));
  assert.deepEqual(await world.boxes.list(THREAD), [done]);
  assert.deepEqual(await world.boxes.find(box.id), done);
  assert.deepEqual(await world.boxes.get(THREAD, box.name), done);
  assert.deepEqual(world.errors, []);
});

test("a kind's ID from before 027 is taken in an acquire, a stored record and a guest's owner, and only current IDs are shown", async () => {
  const world = setup();
  assert.ok(!world.boxes.kinds().some((kind) => isEarlierKindId(kind.id)), "an earlier ID is never offered");
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  assert.deepEqual([box.kind, box.kindLabel], ["linux", "Linux"]);

  // A record stored before the rename.
  const [key] = await world.kv.list(`box/${THREAD}/`);
  await world.kv.set(key!, { ...(await world.kv.get<BoxRecord>(key!))!, kind: "linux-headless", kindLabel: "Linux headless" });
  for (const read of [await world.boxes.find(box.id), await world.boxes.get(THREAD, box.name), ...(await world.boxes.list(THREAD)), ...(await world.boxes.all())]) {
    assert.deepEqual([read?.kind, read?.kindLabel], ["linux", "Linux"]);
  }
  assert.equal((await world.boxes.run(THREAD, box.name, "echo still")).result.stdout, "still\n");

  // A guest whose owner names the earlier ID, after bb-box lost the record.
  const guestKey = `backend/fake/guest/${box.guest!.ref}`;
  const guest = (await world.kv.get<{ owner: Record<string, unknown> }>(guestKey))!;
  await world.kv.set(guestKey, { ...guest, owner: { ...guest.owner, kind: "linux-headless" } });
  for (const lost of [...(await world.kv.list("box/")), ...(await world.kv.list("index/"))]) await world.kv.delete(lost);
  world.enrolled.length = 0;
  const boxes = world.restart();
  assert.equal((await boxes.sweep()).adopted, 1);
  const restored = await boxes.find(box.id);
  assert.deepEqual([restored?.kind, restored?.kindLabel, restored?.capabilities.enrol], ["linux", "Linux", true]);
  assert.deepEqual(world.enrolled, [`${box.name}, restored`], "it is the kind it was, so it enrols again");
});

test("a box is released while a command still writes in it, as BB's installer may during enrolment", async () => {
  for (let round = 0; round < 10; round++) {
    const world = setup();
    const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }));
    // Writes files for about 150 ms; release does not wait for it, as a real delete would not.
    const writing = world.boxes.run(THREAD, box.name, "i=0; while [ $i -lt 150 ]; do : > f$i; i=$((i+1)); sleep 0.001; done").catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const left = await world.boxes.release(THREAD, box.name, "the test asked");
    assert.equal(left, null, `round ${round}: ${left?.error}`);
    await writing;
  }
});

test("names are unique within a thread and unknown boxes are named in the error", async () => {
  const world = setup();
  const a = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  const b = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" });
  assert.notEqual(a.name, b.name);
  await world.boxes.idle();
  await assert.rejects(world.boxes.get(THREAD, "no-such-box"), (error: BoxError) => {
    assert.equal(error.code, "not_found");
    assert.match(error.message, new RegExp(`Its boxes are: (${a.name}, ${b.name}|${b.name}, ${a.name})\\.`));
    return true;
  });
});

test("an unknown kind lists the kinds, and no backend says to set one up", async () => {
  const world = setup();
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "windows" }), /The kinds are: linux, linux-desktop/);
  world.active = false;
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }), /No backend is set up/);
});

test("there is no per-thread limit by default, and a set limit names the boxes", async () => {
  const world = setup();
  for (let i = 0; i < 3; i++) await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
  world.general = { ...world.general, perThreadLimit: 3 };
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }), (error: BoxError) => {
    assert.equal(error.code, "limit_reached");
    assert.match(error.message, /already has 3 boxes/);
    return true;
  });
  // Other threads have their own limit.
  await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" });
  await world.boxes.idle();
});

test("a long step in an acquire says what it waits on, in box_status and box_acquire's answer, until the box is ready (#1117)", async () => {
  const world = setup();
  const gate = deferred();
  world.backend.gate = gate.promise;
  world.backend.waitingOn = "Building the image first, which takes about 7 minutes.";
  const asked = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  let waiting = (await world.boxes.find(asked.id))!;
  for (let wait = 0; !waiting.waitingOn && wait < 200; wait++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    waiting = (await world.boxes.find(asked.id))!;
  }
  assert.equal(waitingWords(waiting), "Building the image first, which takes about 7 minutes.");
  assert.match(boxDetail(waiting), /\nState: being acquired\nNow: Building the image first, which takes about 7 minutes\.\n/);
  assert.equal(startingWords(waiting, false), `Box ${waiting.name} is still starting. Building the image first, which takes about 7 minutes.`);
  gate.resolve();
  await world.boxes.idle();
  const ready = (await world.boxes.find(asked.id))!;
  assert.equal(ready.state, "ready");
  assert.equal(ready.waitingOn, null);
  assert.equal(waitingWords(ready), null);
  assert.doesNotMatch(boxDetail(ready), /\nNow:/);
});

test("capacity counts boxes still being acquired, and the backend's message reaches the user", async () => {
  const world = setup({ maxGuests: 1 });
  const gate = deferred();
  world.backend.gate = gate.promise;
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  // The first box has no guest record yet at the fake, but it is pending.
  await assert.rejects(world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }), (error: BoxError) => {
    assert.equal(error.code, "no_capacity");
    assert.match(error.message, /holds 1 guests at most/);
    return true;
  });
  gate.resolve();
  await world.boxes.idle();
  assert.equal((await world.boxes.all()).length, 1);
});

const GiB = 1024;

test("a box is made at its kind's default size, a preset or a custom size, and records it (028)", async () => {
  const world = setup();
  const made = async (size?: Parameters<Boxes["acquire"]>[0]["size"]) => {
    const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size }));
    assert.deepEqual(box.guest?.size, box.size, "the backend was asked for the size");
    return box.size;
  };
  assert.deepEqual(await made(), { cores: 2, memoryMiB: 4 * GiB, diskGiB: null });
  assert.deepEqual(await made({ preset: "large" }), { cores: 8, memoryMiB: 16 * GiB, diskGiB: null });
  assert.deepEqual(await made({ cores: 3, diskGiB: 40 }), { cores: 3, memoryMiB: 4 * GiB, diskGiB: 40 });
  assert.deepEqual(await made({ preset: "medium", memoryGiB: 12 }), { cores: 4, memoryMiB: 12 * GiB, diskGiB: null });
  world.general = { ...world.general, sizes: parseSizeChanges({ linux: { default: "medium", medium: { diskGiB: 30 } } }).changes };
  assert.deepEqual(await made(), { cores: 4, memoryMiB: 8 * GiB, diskGiB: 30 }, "the box-sizes setting changes the default");
  const views = (await world.boxes.all()).map((box) => boxView(box, true, { owner: "agent", holder: null }).size);
  assert.deepEqual(views.sort(), [
    "2 cores, 4 GiB memory",
    "3 cores, 4 GiB memory, 40 GiB disk",
    "4 cores, 12 GiB memory",
    "4 cores, 8 GiB memory, 30 GiB disk",
    "8 cores, 16 GiB memory",
  ]);
});

test("a size that is not a preset or is above the largest is refused before any backend is asked (028)", async () => {
  const world = setup();
  const refused = async (size: Parameters<Boxes["acquire"]>[0]["size"]) => {
    const error = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size }).then(
      () => assert.fail("acquired"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof BoxError && error.code === "invalid_size", String(error));
    return error.message;
  };
  assert.match(await refused({ preset: "huge" }), /^There is no "huge" size for a linux box\. Its presets are small \(2 cores, 4 GiB memory, the default\)/);
  assert.match(await refused({ cores: 17 }), /^A linux box can be at most 16 cores, 32 GiB memory, 256 GiB disk, not 17 cores, 4 GiB memory\./);
  assert.match(await refused({ memoryGiB: 0 }), /whole numbers of at least 1/);
  assert.deepEqual(await world.boxes.all(), []);
  assert.deepEqual(world.backend.calls, []);
});

test("a backend that cannot make a size refuses it through capacity, and the next backend that can is chosen (028)", async () => {
  const root = tempDir("sizes");
  const kv = new MemoryStorage();
  const small = new FakeBackend({ root, storage: scopedStorage(kv, "backend/small/"), id: "small", largest: { cores: 4, memoryMiB: 8 * GiB, diskGiB: 64 } });
  const big = new FakeBackend({ root, storage: scopedStorage(kv, "backend/big/"), id: "big", largest: { cores: 8, memoryMiB: 16 * GiB, diskGiB: 128 } });
  const all = [small, big];
  const boxes = new Boxes({
    kv,
    backends: {
      get: (id) => all.find((backend) => backend.id === id) ?? null,
      active: () => all,
      kinds: () => all.flatMap((backend) => backend.kinds().map((kind) => ({ kind, backend }))),
    },
    general: async () => ({ perThreadLimit: null, enrol: false, defaultKind: "linux", sizes: {}, spares: {} }),
    notify: () => {},
    thread: async () => ({ state: "live", said: "the test's own" }),
    logError: () => {},
  });
  const medium = await ready(boxes, await boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size: { preset: "medium" } }));
  assert.equal(medium.backend, "small", "the first backend with room");
  const large = await ready(boxes, await boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size: { preset: "large" } }));
  assert.equal(large.backend, "big");
  await assert.rejects(
    boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size: { cores: 12 } }),
    (error: unknown) => {
      assert.ok(error instanceof BoxError && error.code === "no_capacity");
      assert.equal(
        error.message,
        "The fake host makes guests of at most 4 cores, 8 GiB memory and 64 GiB disk. The fake host makes guests of at most 8 cores, 16 GiB memory and 128 GiB disk.",
      );
      return true;
    },
  );
  for (const box of await boxes.list(THREAD)) await boxes.release(THREAD, box.id, "the test asked");
  await boxes.idle();
});

test("capacity is told each pending box's kind and size, and a box recorded before sizes counts at its kind's default (028)", async () => {
  const world = setup();
  const asked: { size: BoxSize; pending: readonly { kind: string; size: BoxSize }[] }[] = [];
  const capacity = world.backend.capacity.bind(world.backend);
  world.backend.capacity = async (kind, size, pending) => {
    asked.push({ size, pending });
    return capacity(kind, size, pending);
  };
  const gate = deferred();
  world.backend.gate = gate.promise;
  const first = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", size: { preset: "large" } });
  await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-desktop", size: { cores: 6 } });
  // As a record from before sizes: no size.
  const { size: _, ...before } = (await world.boxes.find(first.id))!;
  await world.kv.set(`box/${THREAD}/${first.id}`, before);
  await world.boxes.acquire({ threadId: "thr_three", projectId: null, kind: "linux" });
  assert.deepEqual(asked.map((call) => call.size), [
    { cores: 8, memoryMiB: 16 * GiB, diskGiB: null },
    { cores: 6, memoryMiB: 8 * GiB, diskGiB: null },
    { cores: 2, memoryMiB: 4 * GiB, diskGiB: null },
  ]);
  assert.deepEqual(asked[1]!.pending, [{ kind: "linux", size: { cores: 8, memoryMiB: 16 * GiB, diskGiB: null } }]);
  assert.deepEqual(
    [...asked[2]!.pending].sort((a, b) => a.kind.localeCompare(b.kind)),
    [
      { kind: "linux", size: { cores: 2, memoryMiB: 4 * GiB, diskGiB: null } },
      { kind: "linux-desktop", size: { cores: 6, memoryMiB: 8 * GiB, diskGiB: null } },
    ],
  );
  gate.resolve();
  await world.boxes.idle();
});

test("a box's view shows the size its guest says, else the size asked for (028)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const control = { owner: "agent", holder: null } as const;
  assert.equal(boxView(box, true, control).size, "2 cores, 4 GiB memory");
  assert.equal(boxView({ ...box, guest: { ...box.guest!, size: { cores: 6, memoryMiB: 6 * GiB, diskGiB: 20 } } }, true, control).size, "6 cores, 6 GiB memory, 20 GiB disk");
  assert.equal(boxView({ ...box, guest: { ...box.guest!, size: null } }, true, control).size, "2 cores, 4 GiB memory");
  const { size: _, ...before } = box;
  assert.equal(boxView({ ...before, guest: null }, true, control).size, null, "a box from before sizes, with no guest yet");
});

test("a box's view says whether its desktop's viewer asks for a still area again (056)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const control = { owner: "agent", holder: null } as const;
  const withDisplay = (display: DisplayCapability) => boxView({ ...box, capabilities: { ...box.capabilities, displays: [display] } }, true, control).display;
  assert.equal(boxView(box, true, control).display, null, "no desktop");
  assert.deepEqual(withDisplay({ id: "desktop", protocol: "rfb", resizable: true }), { protocol: "rfb", resizable: true, clipboard: null, refresh: null, quality: null, macKeys: null });
  assert.equal(withDisplay({ id: "desktop", protocol: "rfb", resizable: true, refresh: "viewer" })?.refresh, "viewer");
  assert.equal(withDisplay({ id: "desktop", protocol: "rfb", resizable: true, quality: 4 })?.quality, 4);
  assert.equal(withDisplay({ id: "desktop", protocol: "rfb", resizable: false, macKeys: "alt-command" })?.macKeys, "alt-command");
});

test("box details say who has control of a device box's device, and of a desktop box's desktop", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const showing = (displays: readonly DisplayCapability[]): BoxRecord => ({ ...box, capabilities: { ...box.capabilities, displays } });
  const desktop: DisplayCapability = { id: "desktop", protocol: "rfb", resizable: true };
  const android = showing([DEVICE_DISPLAY]);
  const ios = showing([desktop, DEVICE_DISPLAY]);
  assert.match(boxDetail(android, { owner: "agent", holder: null }), /\nDevice control: the agent\n/);
  assert.match(boxDetail(ios, { owner: "agent", holder: null }), /\nDevice control: the agent\n/);
  assert.match(boxDetail(android, { owner: "human", holder: null }), /\nDevice control: the user, in bb-box's panel\. Leave the device alone until they hand control back/);
  assert.doesNotMatch(boxDetail(android, { owner: "agent", holder: null }), /Desktop control/);
  assert.match(boxDetail(showing([desktop]), { owner: "human", holder: null }), /\nDesktop control: the user, in bb-box's panel\. Leave the desktop's windows alone until/);
});

test("box details and kind lists say whether the box user can become root", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const admin = (value: boolean, os = box.capabilities.os): BoxRecord => ({
    ...box,
    capabilities: { ...box.capabilities, os, command: { ...box.capabilities.command!, admin: value } },
  });
  assert.match(boxDetail(box), /\nRoot: no, the box user cannot use sudo\. box_list shows the kinds that give root\n/);
  assert.match(boxDetail(admin(true)), /\nRoot: yes, through sudo without a password\n/);
  assert.match(boxDetail(admin(true, "windows")), /\nAdministrator: yes\n/);
  assert.doesNotMatch(boxDetail({ ...box, capabilities: { ...box.capabilities, command: null } }), /Root|Administrator/, "a box without commands");

  // Offers of a kind may differ: an SSH host pool's linux machines give no root.
  const rooted = FAKE_KINDS.map((kind) => ({ ...kind, capabilities: { ...kind.capabilities, command: { ...kind.capabilities.command!, admin: true } } }));
  const other = { id: "ssh-pool:rooted", label: "Rooted host" } as Backend;
  const views = kindViews([{ kind: FAKE_KINDS[0]!, backend: world.backend }, ...rooted.map((kind) => ({ kind, backend: other }))], {});
  assert.deepEqual(
    views.map((view) => [view.id, view.admin, adminText(view)]),
    [
      ["linux", null, "Root: on some of its backends, through sudo; box_status says for each box."],
      ["linux-desktop", true, "Root: yes, through sudo without a password."],
    ],
  );
  assert.equal(adminText({ admin: false, os: "linux" }), "Root: no, the box user cannot use sudo.");
  assert.equal(adminText({ admin: true, os: "windows" }), "Administrator: yes, and commands run elevated.");
  assert.equal(adminText({ admin: false, os: "windows" }), "Administrator: no, the box user is a standard user.");
  assert.equal(adminText({ admin: null, os: "windows" }), "Administrator: on some of its backends; box_status says for each box.");
  const commandless = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, command: null } };
  assert.equal(kindViews([{ kind: commandless, backend: other }], {})[0]!.admin, false, "a kind without commands gives no root");

  // Each offer, in acquire order, with what the picker's pane shows: the driver's label and glyph type, hosts, spares ready,
  // free pool machines, a typical cold start and Docker (041).
  const pool = { id: "ssh-pool:rooted", label: "Rooted host", free: (kind: string) => (kind === "linux" ? 2 : 0) } as unknown as Backend;
  const lxc = { ...world.backend, id: "proxmox-lxc", hosts: ["pve"] } as unknown as Backend;
  const dockered = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, features: ["docker"] } };
  const [linux] = kindViews(
    [
      { kind: dockered, backend: lxc },
      { kind: FAKE_KINDS[0]!, backend: pool },
    ],
    {},
    {},
    {},
    { "linux|proxmox-lxc": 2200 },
    { "linux|proxmox-lxc": 1 },
  );
  assert.deepEqual(
    linux!.offers.map((offer) => [offer.type, offer.label, offer.hosts, offer.ready, offer.free, offer.typicalReadyMs, offer.docker, offer.resizable]),
    [
      ["proxmox-lxc", "Proxmox LXC", ["pve"], 1, null, 2200, true, null],
      ["ssh-pool", "SSH host pool", [], 0, 2, null, false, null],
    ],
  );
  assert.equal(linux!.computerUse, false);
  // A VM's offer comes last, as a plain acquire tries it (057), and its kind keeps its place.
  const qemu = { ...world.backend, id: "proxmox-qemu", label: "Proxmox QEMU", hosts: ["pve"] } as unknown as Backend;
  const vm = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, features: ["docker", "kernel"] } };
  const ordered = kindViews(
    [
      { kind: vm, backend: qemu },
      { kind: FAKE_KINDS[1]!, backend: lxc },
      { kind: dockered, backend: lxc },
    ],
    {},
  );
  assert.deepEqual(ordered.map((view) => view.id), [FAKE_KINDS[0]!.id, FAKE_KINDS[1]!.id]);
  assert.deepEqual(ordered[0]!.offers.map((offer) => offer.type), ["proxmox-lxc", "proxmox-qemu"]);
  const [desktop] = kindViews([{ kind: FAKE_KINDS[1]!, backend: lxc }], {});
  assert.deepEqual([desktop!.computerUse, desktop!.offers[0]!.resizable], [true, true]);
});

test("a GPU desktop's offers carry its GPUs' room as last read, and box_list says it (#603)", async () => {
  const gpuKind: BoxKind = { ...FAKE_KINDS[1]!, capabilities: { ...FAKE_KINDS[1]!.capabilities, gpu: true } };
  const cpuKind: BoxKind = { ...FAKE_KINDS[1]!, id: "linux-desktop-cpu" };
  const now = 1_790_000_000_000;
  const reading = (id: string, freeMiB: number, totalMiB: number | null, age: number) => ({ id, freeMiB, totalMiB, at: now - age, neededMiB: 384, source: "desktop" as const });
  let room: GpuRoom = { readings: [reading("gpu-a", 6100, 8192, 2 * 60_000)], fullUntil: null };
  const lxc = { id: "proxmox-lxc", label: "Proxmox LXC", hosts: ["pve"], gpuRoom: async () => room } as unknown as Backend;
  const docker = { id: "docker:host_1", label: "Docker", hosts: ["devpc"] } as unknown as Backend;
  const views = async (offered: { kind: BoxKind; backend: Backend }[]) => kindViews(offered, {}, {}, {}, {}, {}, undefined, await gpuRooms(offered));

  const [desktop, cpu] = await views([
    { kind: gpuKind, backend: lxc },
    { kind: cpuKind, backend: lxc },
  ]);
  assert.deepEqual(desktop!.offers[0]!.gpuRoom, room);
  assert.equal(cpu!.offers[0]!.gpuRoom, null, "a kind without a GPU shows no GPU room");
  assert.equal(gpuRoomText(desktop!, [desktop!, cpu!], now), " GPU memory: gpu-a 6100 of 8192 MiB free, 2 minutes ago; a desktop needs 384 MiB.");

  room = { readings: [reading("gpu-a", 103, 8192, 60_000), reading("gpu-b", 21, null, 0)], fullUntil: now + 4 * 60_000 };
  const [full] = await views([{ kind: gpuKind, backend: lxc }]);
  assert.equal(
    gpuRoomText(full!, [full!, cpu!], now),
    " No GPU has room for a desktop now (gpu-a 103 MiB free, 1 minute ago; gpu-b 21 MiB free, just now; a desktop needs 384 MiB). " +
      "Acquire linux-desktop-cpu instead, or try again in 4 minutes.",
  );
  assert.match(gpuRoomText(full!, [full!], now), /needs 384 MiB\)\. Try again in 4 minutes\.$/, "with no CPU desktop to offer");
  assert.match(gpuRoomText(full!, [full!, cpu!], now + 4 * 60_000), /^ GPU memory: gpu-a 103 of 8192 MiB free, 5 minutes ago; gpu-b 21 MiB free, 4 minutes ago;/, "once the refusal ends");

  // With several providers, each names itself, and one that reads no GPU says nothing.
  const [both] = await views([
    { kind: gpuKind, backend: lxc },
    { kind: gpuKind, backend: docker },
  ]);
  assert.equal(both!.offers[1]!.gpuRoom, null);
  assert.match(gpuRoomText(both!, [both!], now), /^ No GPU on Proxmox LXC on pve has room for a desktop now \(/);

  room = { readings: [], fullUntil: null };
  const [unread] = await views([{ kind: gpuKind, backend: lxc }]);
  assert.equal(unread!.offers[0]!.gpuRoom, null);
  assert.equal(gpuRoomText(unread!, [], now), "", "nothing before a reading");
});

test("box details promise a restored box enrols again only when its kind can enrol", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const restored = (enrol: boolean): BoxRecord => ({
    ...box,
    restoredAt: Date.now(),
    enrol: { state: "off", hostId: null, error: null },
    capabilities: { ...box.capabilities, enrol },
  });
  assert.match(boxDetail(restored(true)), /\nBB machine: not enrolled since bb-box restored its lost record\. It enrols again once it runs and answers/);
  assert.match(boxDetail(restored(false)), /\nBB machine: not enrolled(\n|$)/, "a kind that never enrols, such as linux-docker");
});

test("box details say a box still being made joins BB once it is ready, not that it was made while its kind did not join BB", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const making = (state: BoxRecord["state"]): BoxRecord => ({
    ...box,
    state,
    readyAt: null,
    enrol: { state: "off", hostId: null, error: null },
    capabilities: { ...box.capabilities, enrol: true },
  });
  for (const state of ["acquiring", "starting"] as const) {
    assert.match(boxDetail(making(state)), /\nBB machine: not yet: it joins BB once it is ready, if bb-box enrols boxes(\n|$)/, state);
  }
  assert.match(boxDetail(making("failed")), /\nBB machine: not enrolled(\n|$)/, "a failed box is not about to join");
  assert.match(boxDetail({ ...making("starting"), readyAt: Date.now() }), /\nBB machine: not enrolled: it was made while boxes of its kind did not join BB/, "a box that was ready before");
});

test("concurrent acquires from different threads never share the last room", async () => {
  const world = setup({ maxGuests: 2 });
  const results = await Promise.allSettled(
    ["a", "b", "c", "d"].map((thread) => world.boxes.acquire({ threadId: thread, projectId: null, kind: "linux" })),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  await world.boxes.idle();
});

test("a box that holds its guest counts once while it starts (#122)", async () => {
  const world = setup({ maxGuests: 2 });
  const gate = deferred();
  world.backend.gate = gate.promise;
  const first = await world.boxes.acquire({ threadId: "a", projectId: null, kind: "linux" });
  await until(async () => !!(await world.boxes.find(first.id))?.guest && (await world.backend.held()).length === 1);
  // The starting box's guest is the only one, so there is room for one more.
  await world.boxes.acquire({ threadId: "b", projectId: null, kind: "linux" });
  await assert.rejects(world.boxes.acquire({ threadId: "c", projectId: null, kind: "linux" }), (error: unknown) => error instanceof BoxError && error.code === "no_capacity");
  gate.resolve();
  await world.boxes.idle();
});

test("a failed acquire keeps the box as failed with the reason, holding nothing", async () => {
  const world = setup();
  world.backend.faults.acquire = { at: "started", error: new BackendError("no_capacity", "The host ran out of memory.") };
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  const done = await ready(world.boxes, box);
  assert.equal(done.state, "failed");
  assert.equal(done.error, "The host ran out of memory.");
  assert.equal(done.guest, null);
  assert.deepEqual(await world.backend.held(), []);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /failed: The host ran out of memory/);
  // A failed box does not count against the limit.
  world.general = { ...world.general, perThreadLimit: 1 };
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
});

test("releasing a box while it is acquired cancels the acquire and leaves nothing", async () => {
  const world = setup();
  const gate = deferred();
  world.backend.gate = gate.promise;
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await until(async () => !!(await world.boxes.find(box.id))?.guest);
  const release = world.boxes.release(THREAD, box.name, "the test asked");
  gate.resolve();
  assert.equal(await release, null);
  assert.deepEqual(await world.boxes.list(THREAD), []);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal(await world.boxes.find(box.id), null);
});

test("commands run in the box's shell with the box's identity, in a directory", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.writeFile(THREAD, box.name, "work/dir/file.txt", Buffer.from("content"), { mode: "600" });
  const { result } = await world.boxes.run(THREAD, box.name, 'printf "%s|%s|" "$BB_BOX_NAME" "$BB_HOST_ID" && cat file.txt && cat >&2', {
    cwd: "work/dir",
    stdin: "from stdin",
  });
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, `${box.name}|host-${box.id}|content`);
  assert.equal(result.stderr, "from stdin");
  const exit = await world.boxes.run(THREAD, box.id, "exit 3");
  assert.equal(exit.result.exitCode, 3);
  const { data } = await world.boxes.readFile(THREAD, box.name, "work/dir/file.txt", { maxBytes: 100 });
  assert.equal(Buffer.from(data).toString(), "content");
  await assert.rejects(world.boxes.readFile(THREAD, box.name, "work/dir/file.txt", { maxBytes: 3 }), /larger than 3 bytes/);
  const mode = await world.boxes.run(THREAD, box.name, "stat -c %a .config/bb-box/env");
  assert.equal(mode.result.stdout, "600\n", "only the box user can read the env file");
});

test("a script given a directory that does not exist runs none of its lines", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const { result } = await world.boxes.run(THREAD, box.name, "echo first\necho second", { cwd: "missing" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
});

test("the env file sets only valid names, quotes values, and makes package installs ask nothing", () => {
  const dir = tempDir("env");
  const script = envScript("linux", { GREETING: "it's\nhere", "BAD-NAME": "x" });
  assert.doesNotMatch(script, /BAD-NAME/);
  writeFileSync(join(dir, "env"), script);
  const out = execFileSync("sh", ["-c", '. ./env && printf %s "$GREETING|$DEBIAN_FRONTEND"'], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(out, "it's\nhere|noninteractive");
  writeFileSync(join(dir, "env"), envScript("linux", { DEBIAN_FRONTEND: "readline" }));
  assert.equal(execFileSync("sh", ["-c", '. ./env && printf %s "$DEBIAN_FRONTEND"'], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } }), "readline");
});

test("commands in an enrolled box take the thread's access from BB's daemon as they start, and never store it", async (t) => {
  const multiline = "it's\ntwo lines";
  const daemon = await fakeDaemon([
    { FOO: "value-old", BAR: "value-bar", QUOTE: multiline },
    { FOO: "value-few" },
    { FOO: "value-new", BAR: "value-bar", QUOTE: multiline, OTHER: "value-other" },
  ]);
  t.after(daemon.stop);
  const asked: string[] = [];
  const world = setup(
    {},
    {
      access: async (box) => {
        asked.push(box.name);
        return { names: ["BAR", "FOO", "GH_TOKEN", "QUOTE", "not a name"], parent: daemon.parent };
      },
    },
  );
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const show = 'printf "%s|" "$FOO" "$BAR" "$QUOTE" "${OTHER-unset}" "${GH_TOKEN-unset}"';
  const first = await world.boxes.run(THREAD, box.name, show);
  assert.equal(first.result.stdout, `value-new|value-bar|${multiline}|unset|unset|`, "the newest worker with the most names");
  assert.deepEqual(asked, [box.name]);

  // BB replaced its newest worker: the next command takes the values it now has.
  process.kill(daemon.workers().at(-1)!, "SIGKILL");
  await until(async () => daemon.workers().length === 2);
  const second = await world.boxes.run(THREAD, box.name, show);
  assert.equal(second.result.stdout, `value-old|value-bar|${multiline}|unset|unset|`);

  const { data } = await world.boxes.readFile(THREAD, box.name, ".config/bb-box/env", { maxBytes: 100_000 });
  assert.doesNotMatch(Buffer.from(data).toString(), /value-/, "the env file holds names, not values");

  // A box that is not a BB machine has no daemon to take them from.
  await world.boxes.update(box, () => ({ enrol: { state: "off", hostId: null, error: null } }));
  const off = await world.boxes.run(THREAD, box.name, show);
  assert.equal(off.result.stdout, "|||unset|unset|");
  assert.equal(asked.length, 2);
});

test("the access loader finds its tools in a shell started with no PATH, as a startup file may be read in one", async (t) => {
  const daemon = await fakeDaemon([{ FOO: "value-one" }]);
  t.after(daemon.stop);
  const dir = tempDir("env");
  writeFileSync(join(dir, "env"), envScript("linux", {}, { names: ["FOO"], parent: daemon.parent }));
  const run = spawnSync("/bin/sh", ["-c", 'PATH=""; . ./env && printf %s "${FOO-unset}"'], { cwd: dir, encoding: "utf8", env: {} });
  assert.equal(run.stderr, "");
  assert.equal(run.stdout, "value-one");
});

test("a worker that ends between being counted and being read is passed over, not the cause of no access, and says nothing", async (t) => {
  const daemon = await fakeDaemon([{ FOO: "value-old" }, { FOO: "value-new" }]);
  t.after(daemon.stop);
  const newest = daemon.workers().at(-1)!;
  // grep ends the newest worker once it has counted its names, as BB may as a command starts.
  const bin = tempDir("grep");
  const grep = execFileSync("sh", ["-c", "command -v grep"], { encoding: "utf8" }).trim();
  writeFileSync(
    join(bin, "grep"),
    `#!/bin/sh\n"${grep}" "$@"; status=$?\ncase "$1 $3" in "-zcE /proc/${newest}/environ") kill -9 ${newest}; while [ -e /proc/${newest} ] && ! "${grep}" -q '^State:.*Z' /proc/${newest}/status 2>/dev/null; do sleep 0.01; done;; esac\nexit $status\n`,
    { mode: 0o755 },
  );
  const dir = tempDir("env");
  writeFileSync(join(dir, "env"), envScript("linux", {}, { names: ["FOO"], parent: daemon.parent }));
  const run = spawnSync("sh", ["-c", '. ./env && printf %s "${FOO-unset}"'], { cwd: dir, encoding: "utf8", env: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(run.stdout, "value-old", "the next newest worker's");
  assert.equal(run.stderr, "");
});

test("commands in an enrolled box take a project's variables from the agent of a thread of the project on the box (#109)", async (t) => {
  // BB gives a project's variables only to the agent its worker starts for the thread, not to the worker.
  const daemon = await fakeDaemon([{ GH_TOKEN: "value-token" }, { GH_TOKEN: "value-token" }], {
    agent: { GH_TOKEN: "value-token", PROJECT_VAR: "value-project" },
  });
  t.after(daemon.stop);
  const world = setup({}, { access: async () => ({ names: ["GH_TOKEN", "PROJECT_VAR"], parent: daemon.parent }) });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const show = 'printf "%s|%s|" "${GH_TOKEN-unset}" "${PROJECT_VAR-unset}"';
  // The newest worker started the agent before it ran on, so the agent is there.
  assert.equal((await world.boxes.run(THREAD, box.name, show)).result.stdout, "value-token|value-project|");
});

interface MacProcess {
  readonly pid: number;
  readonly ppid: number;
  readonly etime: string;
  readonly command: string;
  readonly env?: readonly (readonly [string, string])[];
}

/**
 * A stand-in for macOS's ps, in a directory of its own to put first on the
 * PATH. It lists `processes` with the columns the access loader asks for, and
 * with -E, the environments of those named with -p after their arguments,
 * with a newline as \012 and a tab as \011, as macOS prints them.
 */
function fakeMacPs(processes: readonly MacProcess[]) {
  const dir = tempDir("mac-ps");
  const column = (value: string | number, width: number) => String(value).padStart(width);
  const escape = (value: string) => value.replaceAll("\n", "\\012").replaceAll("\t", "\\011");
  writeFileSync(join(dir, "plain"), processes.map((p) => `${column(p.pid, 5)} ${column(p.ppid, 5)} ${column(p.etime, 10)} ${p.command}\n`).join(""));
  writeFileSync(
    join(dir, "env"),
    processes.map((p) => [column(p.pid, 5), p.command, ...(p.env ?? []).map(([name, value]) => `${name}=${escape(value)}`)].join(" ") + "\n").join(""),
  );
  writeFileSync(
    join(dir, "ps"),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${dir}/calls'
case " $* " in
*" -E "*)
  while [ "$#" -gt 0 ] && [ "$1" != -p ]; do shift; done
  awk -v list="$2" 'BEGIN { n = split(list, p, ","); for (i = 1; i <= n; i++) want[p[i]] = 1 } $1 in want' '${dir}/env' ;;
*) cat '${dir}/plain' ;;
esac
`,
    { mode: 0o755 },
  );
  return {
    dir,
    /** The process IDs whose environments ps -E was asked for, in order. */
    read: () =>
      readFileSync(join(dir, "calls"), "utf8")
        .split("\n")
        .filter((call) => / -E /.test(` ${call} `))
        .map((call) => call.split(" ").at(-1)!.split(",").map(Number).sort((a, b) => a - b)),
  };
}

test("the access check says whether the env file set any of the names, or else whether BB's daemon runs", async (t) => {
  const daemon = await fakeDaemon([{ UNLISTED: "value-unlisted" }]);
  t.after(daemon.stop);
  // The environment stands for what the env file set.
  const check = (parent: string, env: Record<string, string> = {}) =>
    spawnSync("sh", ["-c", accessCheck("linux", { names: ["GH_TOKEN", "MACHINE_VAR"], parent })!], { env: { PATH: process.env.PATH, ...env } }).status;
  assert.equal(check(daemon.parent, { MACHINE_VAR: "value-machine" }), ACCESS_CHECK_EXITS.found);
  assert.equal(check(daemon.parent), ACCESS_CHECK_EXITS.waiting, "the daemon runs, with no worker that has the names");
  assert.equal(check(daemon.parent, { MACHINE_VAR: "" }), ACCESS_CHECK_EXITS.waiting, "an empty value does not count");
  assert.equal(check(join(tempDir("access-check"), "no-daemon")), ACCESS_CHECK_EXITS.noDaemon);
  // With GH_TOKEN required, the other names do not end the wait: BB can give a new machine GH_TOKEN after them.
  const required = (env: Record<string, string>) =>
    spawnSync("sh", ["-c", accessCheck("linux", { names: ["GH_TOKEN", "MACHINE_VAR"], parent: daemon.parent, required: ["GH_TOKEN"] })!], { env: { PATH: process.env.PATH, ...env } }).status;
  assert.equal(required({ MACHINE_VAR: "value-machine" }), ACCESS_CHECK_EXITS.waiting);
  assert.equal(required({ MACHINE_VAR: "value-machine", GH_TOKEN: "value-token" }), ACCESS_CHECK_EXITS.found);
  assert.equal(accessCheck("linux", { names: ["not a name"], parent: daemon.parent }), null);
});

test("in a Windows box, the env file takes the thread's access through a reader it compiles once, and the check and setup have Windows forms (#560)", () => {
  const access = { names: ["GH_TOKEN", "not a name", "MACHINE_VAR"], parent: "host-daemon/dist/daemon-bundle", required: ["GH_TOKEN"] };
  const own = "$env:BB_BOX_NAME = 'calm-otter'\r\n";
  assert.equal(envScript("windows", { BB_BOX_NAME: "calm-otter" }), own, "a box that is not a BB machine sets its own variables only");
  const file = envScript("windows", { BB_BOX_NAME: "calm-otter" }, access);
  assert.ok(file.startsWith(own), file);
  assert.ok(file.includes(`[${READER_TYPE}]::Read('host-daemon/dist/daemon-bundle', [string[]]@('GH_TOKEN', 'MACHINE_VAR'))`), "only valid names, sorted");
  // The reader's source rides in the env file, packed, and is compiled under its own name.
  const packed = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(file)?.[1];
  assert.ok(packed, "the packed source");
  assert.equal(gunzipSync(Buffer.from(packed, "base64")).toString("utf8"), READER_SOURCE);
  assert.ok(READER_SOURCE.includes(`public static class ${READER_TYPE} {`));
  assert.ok(file.includes(`'bb-box', '${READER_TYPE}.dll'`));
  assert.equal(envScript("windows", {}, { ...access, names: ["not a name"] }), "\r\n", "no names, no reader");

  const check = accessCheck("windows", access)!;
  assert.ok(check.startsWith("if ([Environment]::GetEnvironmentVariable('GH_TOKEN')) { exit 0 }"), "GH_TOKEN is required");
  assert.ok(check.includes(`if ([${READER_TYPE}]::Daemon('host-daemon/dist/daemon-bundle')) { exit ${ACCESS_CHECK_EXITS.waiting} }`));
  assert.ok(check.trimEnd().endsWith(`exit ${ACCESS_CHECK_EXITS.noDaemon}`));
  assert.ok(accessCheck("windows", { names: ["A_VAR", "B_VAR"], parent: "p" })!.startsWith("if ([Environment]::GetEnvironmentVariable('A_VAR') -or [Environment]::GetEnvironmentVariable('B_VAR'))"), "any name, when none is required");

  const setup = accessSetup("windows");
  assert.ok(setup.includes("& gh auth setup-git"));
  assert.ok(setup.includes("--add credential.https://github.com.helper '!gh auth git-credential'"));
  assert.ok(setup.includes("url.https://github.com/.insteadOf git@github.com: '^git@github\\.com:$'"));
  assert.ok(setup.includes("url.https://github.com/.insteadOf ssh://git@github.com/ '^ssh://git@github\\.com/$'"));
});

test("in a macOS box, the env file takes the thread's access from the daemon's newest worker with the most names, as on Linux", () => {
  const parent = "host-daemon/dist/daemon-bundle";
  const worker = "node /app/bb-provider-bridge-worker.mjs";
  const multiline = "it's\ntwo lines\tand a tab";
  const others: MacProcess["env"] = [["FOO", "value-other"], ["BAR", "x"], ["QUOTE", "x"]];
  const ps = fakeMacPs([
    { pid: 1, ppid: 0, etime: "3-01:02:03", command: "/sbin/launchd" },
    { pid: 500, ppid: 1, etime: "2-00:00:00", command: `node /app/${parent}.mjs` },
    // Older than 503 and 504 by the days in its elapsed time.
    { pid: 501, ppid: 500, etime: "1-00:00:00", command: worker, env: [["FOO", "value-old"], ["BAR", "x"], ["QUOTE", "x"]] },
    { pid: 502, ppid: 500, etime: "00:05", command: worker, env: [["FOO", "value-few"]] },
    // As old as 504, whose process ID is higher, as on Linux.
    { pid: 503, ppid: 500, etime: "01:00:00", command: worker, env: [["FOO", "value-tie"], ["BAR", "x"], ["QUOTE", "x"]] },
    // Its arguments look like a variable, which the environment follows.
    {
      pid: 504,
      ppid: 500,
      etime: "01:00:00",
      command: `${worker} FOO=from-arguments`,
      env: [["PATH", "/usr/bin"], ["FOO", "value-new"], ["BAR", "spaces,  é = and a quote ' "], ["QUOTE", multiline], ["UNLISTED", "value-unlisted"]],
    },
    // Not the daemon's workers, though one's parent names it in its arguments.
    { pid: 600, ppid: 1, etime: "00:01", command: worker, env: others },
    { pid: 601, ppid: 1, etime: "00:01", command: `zsh -c ${parent}` },
    { pid: 602, ppid: 601, etime: "00:01", command: worker, env: others },
  ]);
  const dir = tempDir("env");
  const access = { names: ["BAR", "FOO", "GH_TOKEN", "QUOTE", "not a name"], parent };
  writeFileSync(join(dir, "env"), envScript("macos", { BB_BOX_NAME: "box" }, access));
  writeFileSync(join(dir, "no-daemon"), envScript("macos", { BB_BOX_NAME: "box" }, { ...access, parent: "no-daemon" }));
  assert.doesNotMatch(readFileSync(join(dir, "env"), "utf8"), /DEBIAN_FRONTEND/);
  const show = (file: string) => `PATH='${ps.dir}':$PATH; . ./${file} && printf "%s|" "$FOO" "$BAR" "$QUOTE" "\${GH_TOKEN-unset}" "\${UNLISTED-unset}" "$BB_BOX_NAME"`;
  // zsh runs SSH commands on macOS, and the env file from ~/.zshenv.
  const shells = spawnSync("zsh", ["-fc", ":"]).status === 0 ? ["sh", "zsh"] : ["sh"];
  for (const shell of shells) {
    const out = execFileSync(shell, ["-c", show("env")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(out, `value-new|spaces,  é = and a quote ' |${multiline}|unset|unset|box|`, shell);
    const none = execFileSync(shell, ["-c", show("no-daemon")], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
    assert.equal(none, "|||unset|unset|box|", shell);
  }
  assert.deepEqual(ps.read(), shells.map(() => [501, 502, 503, 504]), "only the daemon's workers' environments are read");
});

test("in a macOS box, the env file takes a project's variables from the agent of a thread of the project on the box (#109)", () => {
  const parent = "host-daemon/dist/daemon-bundle";
  const ps = fakeMacPs([
    { pid: 1, ppid: 0, etime: "3-01:02:03", command: "/sbin/launchd" },
    { pid: 500, ppid: 1, etime: "2-00:00:00", command: `node /app/${parent}.mjs` },
    { pid: 501, ppid: 500, etime: "00:05", command: "node /app/bb-provider-bridge-worker.mjs", env: [["GH_TOKEN", "value-token"]] },
    { pid: 502, ppid: 501, etime: "00:04", command: "/usr/local/bin/claude", env: [["GH_TOKEN", "value-token"], ["PROJECT_VAR", "value-project"]] },
  ]);
  const dir = tempDir("env");
  writeFileSync(join(dir, "env"), envScript("macos", {}, { names: ["GH_TOKEN", "PROJECT_VAR"], parent }));
  const out = execFileSync("sh", ["-c", `PATH='${ps.dir}':$PATH; . ./env && printf "%s|%s|" "\${GH_TOKEN-unset}" "\${PROJECT_VAR-unset}"`], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
  assert.equal(out, "value-token|value-project|");
});

test("when bb-box cannot tell which variables to take, commands keep the env file they had", async () => {
  let fail = false;
  const world = setup(
    {},
    {
      access: async () => {
        if (fail) throw new Error("BB did not answer");
        return null;
      },
    },
  );
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal((await world.boxes.run(THREAD, box.name, 'printf %s "$BB_BOX_NAME"')).result.stdout, box.name);
  fail = true;
  const { result } = await world.boxes.run(THREAD, box.name, 'printf %s "$BB_BOX_NAME"');
  assert.equal(result.stdout, box.name);
  assert.deepEqual(world.errors, ["access: BB did not answer"]);
});

/** The lines access setup puts at the top of the shell's startup file. */
const HOOK =
  "# Added by bb-box: the thread's environment and access, for SSH commands too.\n" +
  `case "\${BASH_EXECUTION_STRING-}\${ZSH_EXECUTION_STRING-}" in ': bb-box-env; '*) ;; *) if [ -r "$HOME/.config/bb-box/env" ]; then . "$HOME/.config/bb-box/env"; fi ;; esac\n`;

test("access setup puts the env file above ~/.bashrc's early return, once, and keeps the file's mode", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.writeFile(THREAD, box.name, ".bashrc", Buffer.from('case $- in *i*) ;; *) return;; esac\nexport MINE=1\n'), { mode: "640" });
  for (let i = 0; i < 2; i++) {
    const { result } = await world.boxes.run(THREAD, box.name, accessSetup("linux")!);
    assert.equal(result.exitCode, 0);
    // It says how long it took in the box, for the enrolment's log.
    assert.equal(typeof accessSetupMs(result.stdout), "number", result.stdout);
  }
  const { result } = await world.boxes.run(THREAD, box.name, "stat -c %a .bashrc; cat .bashrc; bash -c '. ~/.bashrc; printf %s \"$BB_BOX_NAME\"'");
  assert.equal(
    result.stdout,
    `640\n${HOOK}\ncase $- in *i*) ;; *) return;; esac\nexport MINE=1\n${box.name}`,
  );

  // Once it has run to its end, it does nothing again, as when a warm Mac's fill ran it before the claim's enrolment.
  await world.boxes.writeFile(THREAD, box.name, ".bashrc", Buffer.from("export MINE=2\n"));
  const { result: again } = await world.boxes.run(THREAD, box.name, `${accessSetup("linux")!}\ncat .bashrc`);
  assert.deepEqual([again.exitCode, again.stdout], [0, "0\n"]);
  assert.equal((await world.boxes.run(THREAD, box.name, "cat .bashrc")).result.stdout, "export MINE=2\n");

  // A date that cannot give nanoseconds leaves the time out, and the script's exit code as it was.
  await world.boxes.run(THREAD, box.name, "rm -f .config/bb-box/access-*");
  const { result: untimed } = await world.boxes.run(THREAD, box.name, `date() { echo 1700000000N; }\n${accessSetup("linux")!}`);
  assert.deepEqual([untimed.exitCode, untimed.stdout, accessSetupMs(untimed.stdout)], [0, "", null]);
});

test("access setup puts the new hook in place of the one before #100, once", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const old =
    "# Added by bb-box: the thread's environment and access, for SSH commands too.\n" +
    'if [ -r "$HOME/.config/bb-box/env" ]; then . "$HOME/.config/bb-box/env"; fi\n';
  await world.boxes.writeFile(THREAD, box.name, ".bashrc", Buffer.from(`${old}\nexport MINE=1\n`));
  for (let i = 0; i < 2; i++) assert.equal((await world.boxes.run(THREAD, box.name, accessSetup("linux")!)).result.exitCode, 0);
  assert.equal((await world.boxes.run(THREAD, box.name, "cat .bashrc")).result.stdout, `${HOOK}\nexport MINE=1\n`);
});

test("the hook loads the env file in a shell, but not in one whose command loads it itself (#100)", () => {
  const home = tempDir("hook");
  mkdirSync(join(home, ".config", "bb-box"), { recursive: true });
  writeFileSync(join(home, ".config", "bb-box", "env"), "echo loaded\n");
  writeFileSync(join(home, ".bashrc"), HOOK);
  writeFileSync(join(home, ".zshenv"), HOOK);
  // Node's pipes are sockets, and bash reads ~/.bashrc itself when stdin is
  // one, taking it for rshd's.
  const run = (shell: string, script: string) =>
    execFileSync(shell, ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "pipe", "pipe"] });
  assert.equal(run("bash", ". ~/.bashrc; echo plain"), "loaded\nplain\n");
  assert.equal(run("bash", ": bb-box-env; . ~/.bashrc; echo marked"), "marked\n");
  if (spawnSync("zsh", ["-fc", ":"]).status !== 0) return;
  // zsh reads ~/.zshenv in every shell, as an SSH command's and the one inside it.
  assert.equal(run("zsh", "echo plain"), "loaded\nplain\n");
  assert.equal(run("zsh", ": bb-box-env; echo marked"), "marked\n");
});

test("a macOS command unlocks the box user's signing keychain in its own session, as a keychain unlocks per session (058)", () => {
  const unlock = '/usr/bin/security unlock-keychain -p "" "$bb_keychain"';
  assert.ok(command("macos", "true").includes(unlock));
  // In the desktop session, it is part of the script that runs there.
  const desktop = command("macos", "true", { session: "desktop" });
  assert.ok(desktop.indexOf(unlock) > desktop.indexOf("launchctl asuser"), desktop);
  assert.ok(!command("linux", "true").includes("unlock-keychain"));
  // Without the keychain, as on a Tart box, it does nothing.
  assert.equal(execFileSync("sh", ["-c", command("macos", "echo ok")], { encoding: "utf8", env: { PATH: process.env.PATH, HOME: tempDir("home") } }), "ok\n");
});

test("bb-box's commands start with the mark, in each shell they start (#100)", () => {
  const marked = (script: string) => script.startsWith(LOADS_ENV);
  assert.ok(marked(command("linux", "true")));
  assert.ok(marked(command("macos", "true")));
  assert.ok(marked(command("macos", "true", { session: "desktop" })));
  const inner = `-c ${"'"}${LOADS_ENV}`;
  assert.ok(command("linux", "true", { timeoutMs: 1_000 }).includes(inner));
  assert.ok(command("macos", "true", { timeoutMs: 1_000 }).includes(inner));
  assert.ok(command("macos", "true", { session: "desktop" }).includes(inner));
  // The login shell gets the mark only when the script has it: one that is
  // not bb-box's command leaves the hook to load the env file.
  assert.ok(marked(endMarked(command("linux", "true"), "MARK", false)));
  assert.ok(!marked(endMarked("true", "MARK", false)));
});

test("access setup has git fetch GitHub's SSH URLs over HTTPS, and leaves other URLs and rewrites as they are", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  // A rewrite of the user's own, to the same place, stays.
  assert.equal((await world.boxes.run(THREAD, box.name, "git config --global url.https://github.com/.insteadOf gh:")).result.exitCode, 0);
  for (let i = 0; i < 2; i++) assert.equal((await world.boxes.run(THREAD, box.name, accessSetup("linux")!)).result.exitCode, 0);
  const urls = ["git@github.com:o/r.git", "ssh://git@github.com/o/r.git", "gh:o/r.git", "https://example.com/a.git", "git@example.com:a.git"];
  const { result } = await world.boxes.run(THREAD, box.name, `for url in ${urls.join(" ")}; do git ls-remote --get-url "$url"; done; git config --global --get-all url.https://github.com/.insteadOf`);
  assert.equal(
    result.stdout,
    "https://github.com/o/r.git\nhttps://github.com/o/r.git\nhttps://github.com/o/r.git\nhttps://example.com/a.git\ngit@example.com:a.git\n" +
      "gh:\ngit@github.com:\nssh://git@github.com/\n",
    result.stderr,
  );
});

test("in a macOS box, access setup puts the env file at the top of ~/.zshenv, once, and keeps the file's mode", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.writeFile(THREAD, box.name, ".zshenv", Buffer.from('export PATH="/opt/homebrew/bin:$PATH"\n'), { mode: "640" });
  for (let i = 0; i < 2; i++) {
    const { result } = await world.boxes.run(THREAD, box.name, accessSetup("macos")!);
    assert.equal(result.exitCode, 0);
    assert.equal(typeof accessSetupMs(result.stdout), "number", result.stdout);
  }
  const { result } = await world.boxes.run(THREAD, box.name, "stat -c %a .zshenv; cat .zshenv");
  assert.equal(
    result.stdout,
    `640\n${HOOK}\nexport PATH="/opt/homebrew/bin:$PATH"\n`,
  );
  if (spawnSync("zsh", ["-fc", ":"]).status !== 0) return;
  // A zsh that is not a login shell, as SSH runs, reads it.
  const { result: zsh } = await world.boxes.run(THREAD, box.name, `env -i HOME="$HOME" PATH="$PATH" zsh -c 'printf %s "$BB_BOX_NAME"'`);
  assert.equal(zsh.stdout, box.name);
});

test("a command that times out stops in the box, with everything it started", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const { result } = await world.boxes.run(THREAD, box.name, "sleep 60 & echo $! > child.pid; sleep 60", { timeoutMs: 300 });
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs < 5_000, `stopped in the box, not by the local backstop: ${result.durationMs} ms`);
  const alive = async () => (await world.boxes.run(THREAD, box.name, 'kill -0 "$(cat child.pid)" 2>/dev/null && echo alive')).result.stdout;
  await until(async () => (await alive()) === "");
  // A command that exits 124 by itself did not time out.
  const own = await world.boxes.run(THREAD, box.name, "exit 124", { timeoutMs: 10_000 });
  assert.equal(own.result.timedOut, false);
  assert.equal(own.result.exitCode, 124);
});

test("a macOS command that times out stops in the box, with everything it started, as on Linux (#203)", async () => {
  const mac: BoxKind = { ...FAKE_KINDS[0]!, id: "macos", label: "macOS", capabilities: { ...FAKE_KINDS[0]!.capabilities, os: "macos", enrol: false } };
  const world = setup({ kinds: [mac] });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos" }));
  const { result } = await world.boxes.run(THREAD, box.name, "sleep 60 & echo $! > child.pid; sleep 60", { timeoutMs: 1_000 });
  assert.deepEqual([result.exitCode, result.timedOut], [124, true]);
  assert.ok(result.durationMs < 4_000, `stopped in the box, not by the local backstop: ${result.durationMs} ms`);
  const alive = async () => (await world.boxes.run(THREAD, box.name, 'kill -0 "$(cat child.pid)" 2>/dev/null && echo alive')).result.stdout;
  assert.equal(await alive(), "", "what it started is gone too");
  const own = await world.boxes.run(THREAD, box.name, "exit 124", { timeoutMs: 10_000 });
  assert.deepEqual([own.result.exitCode, own.result.timedOut], [124, false]);
});

test("the macOS timeout passes a command's exit on, and kills one that ignores TERM 5 s later (#203)", () => {
  const run = (script: string, timeoutMs: number) => {
    const started = Date.now();
    const { status } = spawnSync("sh", ["-c", command("macos", script, { timeoutMs })], { stdio: "ignore", timeout: 20_000 });
    return { status, seconds: (Date.now() - started) / 1000 };
  };
  assert.equal(run("exit 3", 10_000).status, 3);
  assert.equal(run("kill -TERM $$", 10_000).status, 143, "as GNU timeout reports a command a signal ended");
  const stubborn = run("trap '' TERM; sleep 60", 1_000);
  assert.equal(stubborn.status, 137);
  assert.ok(stubborn.seconds >= 5.5 && stubborn.seconds < 9, `TERM at 1 s, KILL 5 s later: ${stubborn.seconds} s`);
  assert.ok(!command("macos", "true").includes("perl"), "no timeout, no wrapper");
});

test("a box that stops answering while bb-box reconnects to its machine, as after an update, is to be waited for, not released (#415)", async () => {
  let reconnecting: string | null = "bb-box is reconnecting to devpc, which runs its Docker, as after an update.";
  const world = setup({}, { reconnecting: () => reconnecting });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const lose = async () => {
    const running = world.boxes.run(THREAD, box.id, "sleep 5", { waitForEnrolment: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    world.backend.loseCommands(box.guest!.ref);
    return running.then(
      () => assert.fail("the command should fail"),
      (error: unknown) => error as BoxError,
    );
  };
  const waited = await lose();
  assert.equal(waited.code, "reconnecting");
  assert.equal(waited.message, `Box ${box.name} does not answer yet: bb-box is reconnecting to devpc, which runs its Docker, as after an update.`);
  // Otherwise, a box that does not answer is unreachable, as before.
  reconnecting = null;
  assert.equal((await lose()).code, "unreachable");
});

test("a Windows command with a job starts outside sshd's job, through WMI and cmd, with its script, stdin, output and status in the job's files, a watchdog for its timeout, and waits on cmd's handle (#414)", () => {
  const env = "$env:FOO = 'bar'";
  const script = command("windows", "Get-Process", { cwd: "C:\\work", env, timeoutMs: 1_500, job: { id: "0123456789ab", forget: ["ba9876543210"], prune: true } });
  assert.ok(!script.includes("ping -n"), "no watchdog in the session: the job's own keeps the timeout");
  assert.match(script, /Remove-Item -Recurse -Force -LiteralPath \(Join-Path \$HOME '\.local\\state\\bb-box\\jobs\\ba9876543210'\)/, "a job whose result bb-box has goes");
  assert.match(script, /Where-Object LastWriteTime -lt \(Get-Date\)\.AddDays\(-7\)/, "old jobs go");
  assert.match(script, /\$bbCl='cmd \/d \/v:on \/s \/c '.*' <'\+\$q\+\(Join-Path \$bbJob 'in'\).*' & echo !errorlevel!>'/);
  assert.match(script, /\$bbR=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @\{CommandLine=\$bbCl;.*if\(\$bbR\.ReturnValue -ne 0 -or -not \$bbR\.ProcessId\)\{.*exit 1\}/, "a job Windows did not start fails at once, not waits for ever");
  assert.match(script, /if\(\$p\.ProcessName -ne ''cmd''\)\{\$p=\$null\};if\(\$p -and -not \$p\.WaitForExit\(1500\)\)\{taskkill \/T \/F \/PID \$p\.Id/, "the watchdog holds cmd's handle and stops its tree at the timeout");
  assert.match(script, /try\{\(Get-Process -Id \$bbCmd -ErrorAction Stop\)\.WaitForExit\(\)\}catch\{\};/, "the session waits on cmd's handle");
  assert.ok(!script.includes("Start-Detached"), "no Start-Detached, whose search for its process took 190 ms");
  // Each WMI start hides its console, which in the desktop session would be a window over the desktop (#916).
  assert.equal(script.match(/Win32_Process -MethodName Create -Arguments @\{[^}]*ProcessStartupInformation=\(New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @\{ShowWindow=\[uint16\]0\}\)\}/g)?.length, 2, "the job and its watchdog");
  assert.ok(!command("windows", "x", { job: { id: "0123456789ab", forget: [], prune: false } }).includes("taskkill"), "no timeout, no watchdog");
  assert.match(script, /exit \[int\]\(Get-Content -Raw -LiteralPath \$bbStatus\)$/);
  assert.ok(script.includes("Set-Content -LiteralPath $bbBoxEnv -NoNewline -Value '$env:FOO = ''bar'''"), "the env file is written before the job starts");
  // The file the runner runs is the command as the transport would wrap it: the env file, the directory, the script.
  const file = Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)\);/.exec(script)![1]!, "base64").toString("utf8");
  const inner = Buffer.from(/FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(file)![1]!, "base64").toString("utf8");
  assert.match(inner, /\. \$bbBoxEnv \}; Set-Location -LiteralPath 'C:\\work' -ErrorAction Stop; Get-Process\n/);
  // A command in the desktop session has no job.
  assert.ok(!command("windows", "Get-Process", { session: "desktop", job: { id: "0123456789ab", forget: [], prune: false } }).includes("Start-Detached -Command"));

  const read = jobScript("0123456789ab", 4096, "windows");
  assert.match(read, /^\$d=\(Join-Path \$HOME '\.local\\state\\bb-box\\jobs\\0123456789ab'\);if\(-not \(Test-Path -LiteralPath \$d\)\)\{exit 3\};/);
  assert.match(read, /bbEmit \$o \(Join-Path \$d 'out'\) 4096;bbEmit \$e \(Join-Path \$d 'err'\) 4096;exit 4$/);
  assert.throws(() => jobScript("../x", 4, "windows"), /is not a job ID/);
});

test("a Windows command starts a watchdog that stops it in the box at its timeout", async () => {
  assert.ok(
    command("windows", "Get-Process", { timeoutMs: 1_500 }).startsWith(
      "Start-Process -WindowStyle Hidden cmd -ArgumentList '/d', '/c', ('ping -n 3 127.0.0.1 >nul & taskkill /F /PID ' + $PID + ' >nul') -ErrorAction Ignore; $bbBoxEnv = ",
    ),
  );
  assert.ok(!command("windows", "Get-Process").includes("taskkill"));

  const world = setup({ kinds: [FAKE_WINDOWS_KIND], shell: FAKE_PWSH });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "windows" }));
  // The fake PowerShell exits 1 after 1.5 s, as the watchdog's taskkill leaves it.
  const stopped = await world.boxes.run(THREAD, box.name, "Start-Sleep 60", { timeoutMs: 1_000 });
  assert.deepEqual([stopped.result.exitCode, stopped.result.timedOut], [1, true]);
  // A command that fails before its timeout did not time out.
  const failed = await world.boxes.run(THREAD, box.name, "Start-Sleep 1; exit 1", { timeoutMs: 10_000 });
  assert.deepEqual([failed.result.exitCode, failed.result.timedOut], [1, false]);
});

test("a Windows desktop command runs as a one-off scheduled task in the box user's session", async () => {
  const env = envScript("windows", { BBX_ONE: "one" });
  const script = command("windows", "Get-Process", { session: "desktop", cwd: "C:\\work", env, timeoutMs: 1_500 });
  // The env file is written before the task starts, and the task's PowerShell reads it.
  assert.ok(script.startsWith(`$bbBoxEnv = Join-Path $HOME '.config/bb-box/env.ps1'; New-Item -ItemType Directory -Force -Path (Split-Path $bbBoxEnv) | Out-Null; Set-Content`));
  const inner = `$bbBoxEnv = Join-Path $HOME '.config/bb-box/env.ps1'; if (Test-Path -LiteralPath $bbBoxEnv) { . $bbBoxEnv }; Set-Location -LiteralPath 'C:\\work' -ErrorAction Stop; Get-Process`;
  assert.ok(script.includes(`Set-Content -LiteralPath "$bbDir\\run.ps1" -Value '${powershellCommand(inner).replaceAll("'", "''")}'\n`), "the task runs the script as SSH would");
  assert.ok(script.includes("$bbTask.Principal.LogonType = 3\n"), "with the user's interactive logon");
  assert.ok(!script.includes("RunLevel"), "at the limited run level");
  // The task is outside sshd's job, so the script ends it itself.
  assert.ok(!script.includes("taskkill /F /PID"));
  assert.ok(script.includes("elseif ($bbClock.ElapsedMilliseconds -ge 1500) {\n"));
  const plain = command("windows", "Get-Process", { session: "desktop" });
  assert.ok(plain.startsWith("$ErrorActionPreference = 'Stop'\n"), "no env file to write");
  assert.ok(!plain.includes("elseif ($bbClock.ElapsedMilliseconds -ge"), "no timeout");
  // Task Scheduler's word lags as a task starts, which on a busy VM failed commands that ran: the batch file says it
  // started, and only a started task is taken to have ended without its exit status (the desktop sweep).
  assert.ok(plain.includes(`('@type nul >"' + $bbDir + '\\started"'),`), "the batch file says it started first");
  assert.ok(plain.includes("elseif ($bbStarted -and $bbRegistered.State -ne 4 -and $bbRegistered.LastTaskResult -ne 0x41301) {"));
  assert.ok(plain.includes("elseif (-not $bbStarted -and $bbRegistered.LastTaskResult -eq 0x41303 -and $bbRegistered.State -ne 2 -and $bbClock.ElapsedMilliseconds -ge 5000) {"));

  const desktop: BoxKind = {
    ...FAKE_KINDS[1]!,
    id: "windows-desktop",
    capabilities: { ...FAKE_KINDS[1]!.capabilities, os: "windows", computerUse: null, enrol: false },
  };
  const world = setup({ kinds: [desktop], shell: FAKE_PWSH });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "windows-desktop" }));
  const { result } = await world.boxes.run(THREAD, box.name, "notepad", { session: "desktop", timeoutMs: 10_000 });
  assert.deepEqual([result.stdout, result.exitCode, result.timedOut], ["a scheduled task\n", 1, false]);
});

test("a command waits a few seconds for its box to finish enrolling", async () => {
  const world = setup({}, { enrolWaitMs: 5_000 });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: "host-late", error: null } }));
  setTimeout(() => void world.boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: "host-late", error: null } })), 300);
  const started = Date.now();
  const waited = await world.boxes.run(THREAD, box.name, "true");
  assert.equal(waited.box.enrol.state, "enrolled");
  assert.ok(Date.now() - started >= 250);

  await world.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: "host-late", error: null } }));
  const now = Date.now();
  const unwaited = await world.boxes.run(THREAD, box.name, "true", { waitForEnrolment: false });
  assert.equal(unwaited.box.enrol.state, "enrolling");
  assert.ok(Date.now() - now < 250);
});

test("a command runs anyway when enrolment takes longer than the wait", async () => {
  const world = setup({}, { enrolWaitMs: 100 });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: "host-slow", error: null } }));
  const { box: after, result } = await world.boxes.run(THREAD, box.name, "echo ran");
  assert.equal(after.enrol.state, "enrolling");
  assert.equal(result.stdout, "ran\n");
});

test("after a start, a command waits a while for the box's BB machine to reconnect", async () => {
  const gate = deferred();
  const world = setup({}, { enrolWaitMs: 5_000, reconnect: () => gate.promise });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.stop(THREAD, box.name);
  await world.boxes.start(THREAD, box.name);
  setTimeout(gate.resolve, 300);
  const started = Date.now();
  assert.equal((await world.boxes.run(THREAD, box.name, "echo up")).result.stdout, "up\n");
  assert.ok(Date.now() - started >= 250, "it waited for the reconnect");
  const again = Date.now();
  await world.boxes.run(THREAD, box.name, "true");
  assert.ok(Date.now() - again < 250, "a reconnect that ended is not waited for");
});

test("a command runs anyway when a reconnect takes longer than the wait, or fails", async () => {
  for (const reconnect of [() => new Promise<void>(() => {}), async () => Promise.reject(new Error("the daemon did not start"))]) {
    const world = setup({}, { enrolWaitMs: 100, reconnect });
    const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
    await world.boxes.stop(THREAD, box.name);
    await world.boxes.start(THREAD, box.name);
    const started = Date.now();
    assert.equal((await world.boxes.run(THREAD, box.name, "echo ran")).result.stdout, "ran\n");
    assert.ok(Date.now() - started < 1_000);
  }
});

test("a stop or start that ends during a release leaves the box releasing", async () => {
  for (const action of ["stop", "start"] as const) {
    const world = setup();
    const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
    if (action === "start") await world.boxes.stop(THREAD, box.name);
    const gate = deferred();
    world.backend.powerGate = gate.promise;
    const moving = world.boxes[action](THREAD, box.name);
    await until(async () => (await world.boxes.find(box.id))?.state === (action === "stop" ? "stopping" : "starting"));
    world.backend.faults.release = new Error("the host is busy");
    const release = world.boxes.release(THREAD, box.name, "the test asked");
    gate.resolve();
    await moving;
    const left = await release;
    assert.equal(left?.state, "releasing", `a failed release after a ${action} is tried again by the sweep`);
    await assert.rejects(world.boxes[action](THREAD, box.name), /is being released/);
  }
});

test("stop and start, and a stopped box says so instead of timing out", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const stopped = await world.boxes.stop(THREAD, box.name);
  assert.equal(stopped.state, "stopped");
  assert.equal((await world.boxes.stop(THREAD, box.name)).state, "stopped");
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /is stopped. Start it first/);
  const started = await world.boxes.start(THREAD, box.name);
  assert.equal(started.state, "ready");
  assert.deepEqual(world.reconnected, [`host-${box.id}`], "the BB machine is reconnected after the start");
  assert.equal((await world.boxes.start(THREAD, box.name)).state, "ready");
  assert.equal(world.reconnected.length, 1, "a running box is not reconnected again");
  assert.equal((await world.boxes.run(THREAD, box.name, "echo up")).result.stdout, "up\n");

  // The start's own timings, beside the acquire's, and the next start's in their place.
  const starts = (timings: Readonly<Record<string, number>>) => Object.keys(timings).filter((step) => step.startsWith("start."));
  assert.deepEqual(starts(started.timings), ["start.boot", "start.total"]);
  assert.equal(started.timings.total, box.timings.total, "the acquire's are kept");
  assert.match(boxDetail(started), /\nTimings: (?:(?!boot)[^\n])*\nLast start: boot 1\.2 s, total [^\n]+$/);
  await world.boxes.stop(THREAD, box.name);
  world.backend.startSteps = { resume: 300 };
  const again = await world.boxes.start(THREAD, box.name);
  assert.deepEqual(starts(again.timings), ["start.resume", "start.total"]);
  assert.match(boxDetail(again), /\nLast start: resume 0\.3 s, total [^\n]+$/);
});

test("the facts a start finds replace the box's, so its status says what it has now (#597)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.stop(THREAD, box.name);
  const kept = await world.boxes.start(THREAD, box.name);
  assert.deepEqual(kept.guest?.facts, box.guest?.facts, "a start that finds none keeps them");
  await world.boxes.stop(THREAD, box.name);
  world.backend.startFacts = [{ label: "Display mode", value: "CPU" }];
  const started = await world.boxes.start(THREAD, box.name);
  assert.deepEqual(started.guest?.facts, [{ label: "Display mode", value: "CPU" }]);
  assert.match(boxDetail(started), /\nDisplay mode: CPU\n/);
});

test("a box that is not enrolled is not reconnected after a start", async () => {
  const world = setup();
  world.general = { ...world.general, enrol: false };
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(box.enrol.state, "off");
  await world.boxes.stop(THREAD, box.name);
  await world.boxes.start(THREAD, box.name);
  assert.deepEqual(world.reconnected, []);
});

test("a box stopped behind bb-box's back is found when a command cannot reach it", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.backend.stop!(box.guest!);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /is stopped/);
  assert.equal((await world.boxes.get(THREAD, box.name)).state, "stopped");
});

test("a box that stopped by itself says why, and a stop bb-box makes forgets it (#406)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.backend.stopReason = { reason: "tart run exited with status 0: the guest shut itself down", crashed: false, at: Date.UTC(2026, 9, 2, 23, 33, 5) };
  await world.backend.stop!(box.guest!);
  await assert.rejects(
    world.boxes.run(THREAD, box.name, "true"),
    new RegExp(`^BoxError: Box ${box.name} is stopped\\. It stopped without a request from bb-box at 2026-10-02 23:33:05 UTC\\. tart run exited with status 0: the guest shut itself down\\. Start it first\\.$`),
  );
  const stopped = await world.boxes.settled(box);
  assert.equal(stopped!.state, "stopped");
  assert.equal(stopped!.unrequestedStop?.restart, null);
  assert.match(boxDetail(stopped!), /\nLast unrequested stop: It stopped without a request from bb-box at 2026-10-02 23:33:05 UTC\. tart run exited/);
  assert.match(boxView(stopped!, true, { owner: "agent" } as never).stopped!, /the guest shut itself down/);

  await world.boxes.start(THREAD, box.name);
  assert.ok((await world.boxes.get(THREAD, box.name)).unrequestedStop, "a start keeps it");
  await world.boxes.stop(THREAD, box.name);
  const forgotten = await world.boxes.get(THREAD, box.name);
  assert.equal(forgotten.unrequestedStop, null);
  assert.doesNotMatch(boxDetail(forgotten), /unrequested/);
});

test("a box whose VM crashed is started again, but not twice in 10 minutes (#406)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.backend.stopReason = { reason: "tart run ended on signal 5 (SIGTRAP).", crashed: true, at: null };
  await world.backend.stop!(box.guest!);
  const found = await world.boxes.refresh(THREAD, box.name);
  assert.equal(found.state, "stopped");
  assert.match(found.unrequestedStop!.reason!, /SIGTRAP/);
  assert.ok(found.unrequestedStop!.restart);
  const restarted = await world.boxes.settled(box);
  assert.equal(restarted!.state, "ready");
  assert.match(boxDetail(restarted!), /Last unrequested stop: It stopped without a request from bb-box at .* UTC\. tart run ended on signal 5 \(SIGTRAP\)\. bb-box started it again at .* UTC\./);

  // It crashes again at once: bb-box leaves it stopped, and says so.
  await world.backend.stop!(box.guest!);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /SIGTRAP\)\. bb-box left it stopped, as it had started it again after a stop less than 10 minutes before\. Start it first\.$/);
  const left = await world.boxes.settled(box);
  assert.equal(left!.state, "stopped");
  assert.equal(left!.unrequestedStop!.restart, null);
});

test("a guest deleted outside bb-box marks the box gone, and release still works", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.backend.release(box.guest!, QUIET);
  const refreshed = await world.boxes.refresh(THREAD, box.name);
  assert.equal(refreshed.state, "gone");
  assert.match(refreshed.error!, /deleted outside bb-box/);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /no longer exists/);
  assert.equal(await world.boxes.release(THREAD, box.name, "the test asked"), null);
  assert.deepEqual(await world.boxes.list(THREAD), []);
});

test("release removes the BB machine first, then the guest", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(await world.boxes.release(THREAD, box.name, "the test asked"), null);
  assert.deepEqual(world.unenrolled, [`host-${box.id}`]);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal(await world.boxes.find(box.id), null);
  await assert.rejects(world.boxes.release(THREAD, box.name, "the test asked"), /has no box/);
});

test("a box whose backend ends it at a set time has its thread told once, within the hour before, and again at the next sweep if telling failed", async () => {
  const told: { threadId: string; text: string }[] = [];
  let refuse = false;
  const world = setup({}, {
    tell: async (threadId, text) => {
      if (refuse) throw new Error("BB is busy");
      told.push({ threadId, text });
    },
  });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const endIn = (ms: number) => world.boxes.update(box, (current) => ({ guest: { ...current.guest!, endsAt: Date.now() + ms } }));
  await endIn(2 * 3600_000);
  await world.boxes.sweep();
  assert.equal(told.length, 0, "not while the end is more than an hour away");
  await endIn(50 * 60_000);
  refuse = true;
  await world.boxes.sweep();
  assert.equal(told.length, 0);
  assert.match(world.errors.at(-1)!, /BB is busy/);
  refuse = false;
  await world.boxes.sweep();
  await world.boxes.sweep();
  assert.equal(told.length, 1, "told once");
  assert.equal(told[0]!.threadId, THREAD);
  assert.match(told[0]!.text, new RegExp(`^Box ${box.name} \\(.+\\) ends at \\d\\d:\\d\\d UTC, in 50 minutes: .+ box_copy.+ box_acquire\\.$`));
  assert.ok((await world.boxes.find(box.id))?.endToldAt);
});

test("the sweep tells each backend's upkeep which of its guests have a box, so a leftover is not kept alive", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.sweep();
  assert.deepEqual([...world.backend.recordedGuests!], [box.guest!.ref]);
});

test("a failed release keeps the box releasing with the reason, and the sweep finishes it", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.backend.faults.release = new Error("the provider is busy");
  const kept = await world.boxes.release(THREAD, box.name, "the test asked");
  assert.equal(kept?.state, "releasing");
  assert.match(kept!.error!, /the provider is busy. bb-box tries again/);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /being released/);
  const report = await world.boxes.sweep();
  assert.equal(report.resumed, 1);
  assert.deepEqual(await world.boxes.list(THREAD), []);
  assert.deepEqual(await world.backend.held(), []);
});

test("a thread BB says was archived loses all its boxes, failed ones forgotten, but not while BB says it is live, and each release is logged with why", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line) });
  const first = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" });
  await world.boxes.idle();
  world.backend.faults.acquire = { at: "claimed", error: new Error("boom") };
  const failed = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
  assert.equal((await world.boxes.find(failed.id))?.state, "failed", "the fault is one-shot: the next acquire must not start before this one takes it");
  const other = await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" });
  await world.boxes.idle();
  assert.equal(await world.boxes.releaseThread(THREAD, "archived"), 0);
  assert.equal((await world.boxes.list(THREAD)).length, 3);
  assert.ok(logs.includes(`Kept the boxes of thread ${THREAD}: BB said it was archived, but says now that it is live. BB's answer: the test says live.`));
  world.threads.set(THREAD, "ended");
  assert.equal(await world.boxes.releaseThread(THREAD, "archived"), 2);
  assert.deepEqual(await world.boxes.list(THREAD), []);
  assert.ok(logs.includes(`Releasing box ${first.name} of thread ${THREAD}: its thread was archived. BB's answer: the test says ended.`));
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [other.id],
  );
  await world.boxes.release("thr_two", other.name, "its thread released it with box_release");
  assert.ok(logs.includes(`Releasing box ${other.name} of thread thr_two: its thread released it with box_release.`));
});

test("a thread event releases its boxes at once only when BB returns the thread archived or deleted, and leaves the rest to the sweep", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line) });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  // BB cannot say: the box stays, and the sweep decides as ever.
  world.threads.set(THREAD, "unknown");
  assert.equal(await world.boxes.releaseThread(THREAD, "deleted"), 0);
  assert.ok(logs.includes(`Kept the boxes of thread ${THREAD}: BB said it was deleted, but cannot say now whether it ended, and the sweep decides. BB's answer: the test says unknown.`));
  assert.equal((await world.boxes.sweep()).released, 0);
  // BB finds no such thread: that counts as its first answer, and the next sweep releases the box if BB still finds none.
  world.threads.set(THREAD, "missing");
  assert.equal(await world.boxes.releaseThread(THREAD, "deleted"), 0);
  assert.equal((await world.boxes.find(box.id))?.state, "ready");
  assert.ok(logs.includes(`Kept the boxes of thread ${THREAD}: BB said it was deleted, but finds no such thread now, and the next sweep releases them if BB still finds none. BB's answer: the test says missing.`));
  assert.equal((await world.boxes.sweep()).released, 1);
  assert.equal(await world.boxes.find(box.id), null);
  assert.ok(logs.includes(`Releasing box ${box.name} of thread ${THREAD}: BB says its thread ended, at this sweep and the last. BB's answer: the test says missing.`));
});

test("the sweep releases the boxes of ended threads and keeps live and unknown ones", async () => {
  const world = setup();
  const ended = await world.boxes.acquire({ threadId: "thr_ended", projectId: null, kind: "linux" });
  const live = await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux" });
  const unknown = await world.boxes.acquire({ threadId: "thr_unknown", projectId: null, kind: "linux" });
  await world.boxes.idle();
  world.threads.set("thr_ended", "ended");
  world.threads.set("thr_unknown", "unknown");
  assert.equal((await world.boxes.sweep()).ending, 1);
  const report = await world.boxes.sweep();
  assert.equal(report.released, 1);
  assert.equal(await world.boxes.find(ended.id), null);
  assert.ok(await world.boxes.find(live.id));
  assert.ok(await world.boxes.find(unknown.id));
  assert.ok(world.backend.calls.includes("maintain"));
});

test("the sweep puts back what a ready box's guest still has lowered from its start, as after a restart, and leaves a spare's (#888)", async () => {
  const world = setup();
  world.threads.set("thr_live", "live");
  const box = await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux" });
  const spare = await world.boxes.acquire({ threadId: SPARES, projectId: null, kind: "linux" });
  await world.boxes.idle();
  const ready = (await world.boxes.find(box.id))!;
  const spareReady = (await world.boxes.find(spare.id))!;
  assert.ok(ready.readyAt !== null && spareReady.readyAt !== null);
  world.backend.settling.add(ready.guest!.ref);
  world.backend.settling.add(spareReady.guest!.ref);
  await world.boxes.sweep();
  assert.deepEqual(world.backend.settled, [ready.guest!.ref], "the ready box's, once; the spare keeps its low weight until a box takes it");
  await world.boxes.sweep();
  assert.deepEqual(world.backend.settled, [ready.guest!.ref], "and not again");
});

test("a box goes for its thread ending only when BB says so at two sweeps running, so one wrong answer, as after a restart, takes no live thread's box", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line) });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  // BB says once that the thread is gone, at the first sweep after a restart.
  world.threads.set(THREAD, "ended");
  const first = await world.boxes.sweep();
  assert.equal(first.released, 0);
  assert.equal(first.ending, 1);
  assert.equal((await world.boxes.find(box.id))?.state, "ready");
  assert.ok(logs.includes(`Kept box ${box.name} of thread ${THREAD}: BB says its thread ended, and the next sweep releases it if BB says so again. BB's answer: the test says ended.`));
  world.threads.delete(THREAD);
  await world.boxes.sweep();
  world.threads.set(THREAD, "ended");
  assert.equal((await world.boxes.sweep()).released, 0, "a live answer between starts it over");
  // A restart forgets what BB said: the new registry's first sweep releases nothing.
  const boxes = world.restart();
  assert.equal((await boxes.sweep()).released, 0);
  assert.deepEqual(await world.backend.held().then((held) => held.map((guest) => guest.owner?.boxId)), [box.id]);
  assert.ok(!logs.some((line) => line.startsWith("Releasing")));

  // A thread BB returns archived or deleted and one it does not find count alike.
  world.threads.set(THREAD, "missing");
  assert.equal((await boxes.sweep()).released, 1);
  assert.equal(await boxes.find(box.id), null);
  assert.deepEqual(await world.backend.held(), []);
  assert.ok(logs.includes(`Releasing box ${box.name} of thread ${THREAD}: BB says its thread ended, at this sweep and the last. BB's answer: the test says missing.`));
});

test("the sweep releases guests no box owns and adopts guests of live threads", async () => {
  const world = setup();
  const kept = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux-desktop" }));
  const lost = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux" }));
  const orphan = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_gone", projectId: null, kind: "linux" }));
  // Storage loses two records; the provider still has the guests.
  for (const box of [lost, orphan]) {
    await world.kv.delete(`box/${box.threadId}/${box.id}`);
    await world.kv.delete(`index/${box.id}`);
  }
  world.threads.set("thr_gone", "ended");
  // A restored box enrols only when bb-box enrols boxes.
  world.general = { ...world.general, enrol: false };
  const enrolled = world.enrolled.length;
  const report = await world.boxes.sweep();
  assert.equal(world.enrolled.length, enrolled);
  assert.equal(report.adopted, 1);
  assert.equal(report.ending, 1, "BB says its thread ended at this sweep, not the last");
  assert.equal((await world.boxes.sweep()).leftovers, 1);
  const adopted = await world.boxes.find(lost.id);
  assert.equal(adopted?.name, lost.name);
  assert.equal(adopted?.state, "ready");
  assert.equal(adopted?.kind, "linux");
  assert.deepEqual(adopted?.guest, lost.guest);
  assert.equal((await world.boxes.run("thr_live", lost.name, "echo adopted")).result.stdout, "adopted\n");
  assert.deepEqual((await world.backend.held()).map((guest) => guest.ref).sort(), [kept.guest!.ref, lost.guest!.ref].sort());
  // Nor does a later sweep reach into it to see whether it can enrol.
  let reached = 0;
  const transports = world.backend.transports.bind(world.backend);
  world.backend.transports = (...args) => (reached++, transports(...args));
  await world.boxes.sweep();
  assert.equal(reached, 0);
  assert.equal(world.enrolled.length, enrolled);
});

test("the sweep never enrols a box whose BB machine was removed", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.deepEqual(world.enrolled, [box.name]);
  // As when someone removes the box's machine in BB.
  await world.boxes.update(box, () => ({ enrol: { state: "off", hostId: null, error: null } }));
  await world.boxes.sweep();
  assert.deepEqual(world.enrolled, [box.name]);
  assert.equal((await world.boxes.find(box.id))?.enrol.state, "off");
});

test("after its records are wiped, the sweep restores the boxes of live threads, releases only those of ended threads, and keeps the rest", async () => {
  const world = setup();
  const acquire = async (threadId: string, kind = "linux") => ready(world.boxes, await world.boxes.acquire({ threadId, projectId: null, kind }));
  const running = await acquire("thr_live", "linux-desktop");
  const stopped = await acquire("thr_live");
  const silent = await acquire("thr_quiet");
  const ended = await acquire("thr_ended");
  const unsure = await acquire("thr_unsure");
  await world.boxes.stop("thr_live", stopped.name);
  await world.boxes.run("thr_live", running.name, "echo work > file.txt");
  // Every record and index entry goes, as when bb-box loses its storage; the backend's own keys stay.
  for (const key of [...(await world.kv.list("box/")), ...(await world.kv.list("index/"))]) await world.kv.delete(key);
  const boxes = world.restart();
  assert.deepEqual(await boxes.all(), []);
  world.threads.set("thr_ended", "ended");
  world.threads.set("thr_unsure", "unknown");
  world.backend.faults.silent = silent.guest!.ref;
  world.enrolled.length = 0;

  const report = await boxes.sweep();
  assert.deepEqual({ ...report }, { released: 0, leftovers: 0, adopted: 3, kept: 1, ending: 1, resumed: 0, guarded: 0 });
  assert.deepEqual(world.enrolled, [`${running.name}, restored`], "only the box that runs and answers enrols again");

  for (const [before, state] of [[running, "ready"], [stopped, "stopped"]] as const) {
    const after = await boxes.find(before.id);
    assert.ok(after, `${before.name} is restored`);
    assert.equal(after.threadId, before.threadId);
    assert.equal(after.name, before.name);
    assert.equal(after.kind, before.kind);
    assert.equal(after.kindLabel, before.kindLabel);
    assert.deepEqual(after.capabilities, before.capabilities);
    assert.deepEqual(after.guest, before.guest);
    assert.equal(after.createdAt, before.createdAt);
    assert.equal(after.state, state);
    assert.equal(after.error, null);
  }
  const quiet = await boxes.find(silent.id);
  assert.equal(quiet?.state, "ready", "its guest runs");
  assert.match(quiet?.error ?? "", /did not answer when bb-box restored/);
  assert.ok(quiet?.restoredAt, "it enrols once it answers");
  assert.equal(quiet?.enrol.state, "off");
  // A sweep while it is still silent leaves it, and releases the guest whose thread BB says ended again.
  assert.equal((await boxes.sweep()).leftovers, 1);
  assert.equal((await boxes.find(silent.id))?.enrol.state, "off");
  assert.deepEqual(world.enrolled, [`${running.name}, restored`]);
  delete world.backend.faults.silent;
  assert.equal(await boxes.find(ended.id), null);
  assert.equal(await boxes.find(unsure.id), null, "no record until BB answers");
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId).sort(),
    [running.id, stopped.id, silent.id, unsure.id].sort(),
    "only the ended thread's guest went",
  );
  assert.equal((await boxes.run("thr_live", running.name, "cat file.txt")).result.stdout, "work\n");

  // Records restored once are left alone; a thread BB confirms later gets its box back.
  // The silent box answers now, so it enrols, and its error goes.
  world.threads.set("thr_unsure", "live");
  assert.deepEqual({ ...(await boxes.sweep()) }, { released: 0, leftovers: 0, adopted: 1, kept: 0, ending: 0, resumed: 0, guarded: 0 });
  assert.equal((await boxes.find(unsure.id))?.name, unsure.name);
  assert.deepEqual(world.enrolled, [`${running.name}, restored`, `${unsure.name}, restored`, `${silent.name}, restored`]);
  const answering = await boxes.find(silent.id);
  assert.equal(answering?.error, null);
  assert.equal(answering?.restoredAt, null);
  assert.equal(answering?.enrol.state, "enrolled");
  // The box restored stopped enrols when it starts, once.
  await boxes.start("thr_live", stopped.name);
  assert.equal(world.enrolled.at(-1), `${stopped.name}, restored`);
  assert.equal((await boxes.find(stopped.id))?.restoredAt, null);
  await boxes.sweep();
  assert.equal(world.enrolled.length, 4);
  assert.equal(await boxes.release("thr_live", running.name, "the test asked"), null);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId).sort(),
    [stopped.id, silent.id, unsure.id].sort(),
  );
});

test("the sweep restores a thread's own box as BB's machine for the thread, which does not enrol again, and waits when BB does not say (#127)", async () => {
  /** The ID of BB's machine for each box that is one, as BB keeps for a "New box". */
  const machines = new Map<string, string>();
  let answers = false;
  const logs: string[] = [];
  const world = setup(
    {},
    {
      log: (message) => logs.push(message),
      machineOf: async (boxId) => {
        if (!answers) throw new Error("BB did not answer");
        return machines.get(boxId) ?? null;
      },
    },
  );
  const own = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", role: "machine" }));
  const other = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  machines.set(own.id, "host-thread");
  for (const key of [...(await world.kv.list("box/")), ...(await world.kv.list("index/"))]) await world.kv.delete(key);
  const boxes = world.restart();
  world.enrolled.length = 0;

  await boxes.sweep();
  assert.deepEqual(await boxes.all(), [], "no record until BB says which machine each box is");
  assert.ok(world.errors.includes("sweep: BB did not answer"));

  answers = true;
  assert.equal((await boxes.sweep()).adopted, 2);
  const restored = await boxes.find(own.id);
  assert.equal(restored?.role, "machine");
  assert.deepEqual(restored?.enrol, { state: "enrolled", hostId: "host-thread", error: null });
  assert.equal(restored?.restoredAt, null);
  assert.ok(logs.includes(`Restored box ${own.name} of thread ${THREAD} from guest ${own.guest!.ref}, whose record was lost, as the thread's machine. It is ready.`));
  assert.equal((await boxes.find(other.id))?.role, "box");
  assert.deepEqual(world.enrolled, [`${other.name}, restored`], "only the other box enrols again");

  // It is the thread's machine still: a start reconnects BB's machine and enrols nothing.
  await boxes.stop(THREAD, own.name);
  await boxes.start(THREAD, own.name);
  await boxes.settled(own);
  assert.deepEqual(world.reconnected, ["host-thread"]);
  assert.deepEqual(world.enrolled, [`${other.name}, restored`]);
});

test("an acquire may name its provider, by name, ID or host, without case; only it is tried, and a refusal says what would do (044)", async () => {
  const world = setup();
  const root = tempDir("boxes-other");
  const other = new FakeBackend({ root, storage: scopedStorage(world.kv, "backend/fake:second/"), id: "fake:second", hosts: ["devpc"] }) as unknown as Backend;
  world.others = [other];
  const acquire = (on?: string, kind = "linux") => world.boxes.acquire({ threadId: THREAD, projectId: null, kind, ...(on !== undefined ? { on } : {}) });

  // Without on, the first offer; with on, the named one, however it is named.
  assert.equal((await acquire()).backend, world.backend.id);
  for (const name of ["Fake host on devpc", "fake host on DEVPC", "fake:second", "devpc"]) assert.equal((await acquire(name)).backend, "fake:second", name);
  await world.boxes.idle();

  // A name that matches none, or a provider without the kind, or two providers.
  await assert.rejects(acquire("elsewhere"), /No provider is called "elsewhere"\. linux comes from: Fake host, Fake host on devpc\. Leave "on" out for the first with room\./);
  await assert.rejects(acquire("devpc", "no-such-kind"), /There is no "no-such-kind" kind/);
  const second = new FakeBackend({ root: tempDir("boxes-third"), storage: scopedStorage(world.kv, "backend/fake:third/"), id: "fake:third", hosts: ["lab"], kinds: [FAKE_KINDS[1]!] }) as unknown as Backend;
  world.others = [other, second];
  await assert.rejects(acquire("lab"), /Fake host on lab has no linux; it has: linux-desktop\. linux comes from: Fake host, Fake host on devpc\./);
  const twin = new FakeBackend({ root: tempDir("boxes-twin"), storage: scopedStorage(world.kv, "backend/fake:twin/"), id: "fake:twin", hosts: ["devpc"] }) as unknown as Backend;
  world.others = [other, second, twin];
  await assert.rejects(acquire("devpc"), /"devpc" names 2 providers: fake:second, fake:twin\. Give the ID\./);
  assert.equal((await acquire("fake:twin")).backend, "fake:twin", "the ID tells them apart");
  world.others = [other, second];

  // A provider that is off is said to be off; one that is full refuses with its words and names the others.
  world.off.add("fake:second");
  await assert.rejects(acquire("devpc"), /Fake host on devpc is off; turn it on in BB Box's settings\. linux also comes from Fake host\. Leave "on" out for the first with room\.$/);
  world.off.delete("fake:second");
  const full = new FakeBackend({ root: tempDir("boxes-full"), storage: scopedStorage(world.kv, "backend/fake:full/"), id: "fake:full", hosts: ["lab2"], maxGuests: 0 }) as unknown as Backend;
  world.others = [other, second, full];
  await assert.rejects(acquire("lab2"), /^(?!.*Fake host on lab2 has no linux).* linux also comes from Fake host, Fake host on devpc\. Leave "on" out for the first with room\.$/);
  // Without on, the first with room is still taken.
  assert.equal((await acquire()).backend, world.backend.id);
});

test("a plain linux acquire takes a VM's offer last, whatever the backends' order, unless it asks for a VM by linux-vm or on (057)", async () => {
  // The first backend's linux boxes are VMs, with the feature kernel; the second's are not.
  const vm: BoxKind = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, features: ["docker", "kernel"] } };
  const world = setup({ kinds: [vm] });
  const plain = new FakeBackend({ root: tempDir("boxes-plain"), storage: scopedStorage(world.kv, "backend/fake:plain/"), id: "fake:plain", hosts: ["devpc"] }) as unknown as Backend;
  world.others = [plain];
  const acquire = (kind: string, on?: readonly string[]) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind, ...(on ? { on } : {}) });
  assert.equal((await acquire("linux")).backend, "fake:plain", "the VM's offer comes last");
  assert.equal((await acquire("linux-vm")).backend, world.backend.id, "linux-vm asks for a VM");
  assert.equal((await acquire("linux", [world.backend.id])).backend, world.backend.id, "on names it");
  await world.boxes.idle();
});

test("linux-kvm asks for a VM with KVM, and is refused, naming KVM, where no VM has it (057)", async () => {
  const vm: BoxKind = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, features: ["docker", "kernel"] } };
  const without = setup({ kinds: [vm] });
  await assert.rejects(without.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-kvm" }), /have no KVM\. Ask for linux if the box can do without it\./);
  const kvm: BoxKind = { ...vm, capabilities: { ...vm.capabilities, features: ["docker", "kernel", "kvm"] } };
  const world = setup({ kinds: [kvm] });
  const plain = new FakeBackend({ root: tempDir("boxes-plain-kvm"), storage: scopedStorage(world.kv, "backend/fake:plain/"), id: "fake:plain", hosts: ["devpc"] }) as unknown as Backend;
  world.others = [plain];
  assert.equal((await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-kvm" })).backend, world.backend.id, "the VM, though it comes last");
  await world.boxes.idle();
});

test("an acquire may name several providers: the first with room among them in acquire order, strict, a list with a mistake refused whole (044)", async () => {
  const world = setup();
  const other = new FakeBackend({ root: tempDir("boxes-list-other"), storage: scopedStorage(world.kv, "backend/fake:second/"), id: "fake:second", hosts: ["devpc"] }) as unknown as Backend;
  const full = new FakeBackend({ root: tempDir("boxes-list-full"), storage: scopedStorage(world.kv, "backend/fake:full/"), id: "fake:full", hosts: ["lab2"], maxGuests: 0 }) as unknown as Backend;
  world.others = [other, full];
  const acquire = (on: readonly string[]) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", on });

  // The list narrows and never reorders: the first in acquire order with room takes the box; a name given twice counts once; a full one is passed over.
  assert.equal((await acquire(["devpc", world.backend.id])).backend, world.backend.id);
  assert.equal((await acquire(["devpc", "fake:second", "Fake host on devpc"])).backend, "fake:second");
  assert.equal((await acquire(["lab2", "devpc"])).backend, "fake:second");
  await world.boxes.idle();
  const before = (await world.boxes.list(THREAD)).length;

  // A mistake anywhere refuses the whole acquire, and so does an empty list.
  await assert.rejects(acquire(["devpc", "elsewhere"]), /No provider is called "elsewhere"\. linux comes from: Fake host, Fake host on devpc, Fake host on lab2\. Leave "on" out for the first with room\./);
  await assert.rejects(acquire([]), /Name a provider in "on", or leave it out for the first with room\. linux comes from: Fake host, Fake host on devpc, Fake host on lab2\.$/);
  await assert.rejects(acquire([" ", ""]), /Name a provider in "on"/);
  assert.equal((await world.boxes.list(THREAD)).length, before, "nothing was placed");

  // A listed provider that is off is passed over like a full one; when none has room, each one's reason comes, then the kind's other providers.
  world.off.add("fake:second");
  assert.equal((await acquire(["devpc", world.backend.id])).backend, world.backend.id);
  await assert.rejects(acquire(["lab2", "devpc"]), /(?=.*Fake host on devpc is off; turn it on in BB Box's settings\.).* linux also comes from Fake host\. Leave "on" out for the first with room\.$/);
  await assert.rejects(acquire(["devpc"]), /Fake host on devpc is off; turn it on in BB Box's settings\. linux also comes from Fake host, Fake host on lab2\. Leave "on" out for the first with room\.$/);
  world.off.delete("fake:second");
  await world.boxes.idle();

  // A spare is claimed only from a listed provider: the first provider's spare stays, and the box is placed on the listed one.
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const placed = await acquire(["devpc"]);
  assert.equal(placed.backend, "fake:second");
  assert.equal(placed.timings.spare, undefined, "the spare on the first provider was not claimed");
  await world.boxes.idle();
});

test("the registry keeps each kind's last cold starts per backend, not claims from a spare, and counts spares ready per backend", async () => {
  const world = setup();
  const key = `linux|${world.backend.id}`;
  assert.deepEqual(await world.boxes.typicalReady(), {}, "nothing before the first start");
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.idle();
  let typical = await world.boxes.typicalReady();
  assert.equal(typical[key], first.timings.total, "one start: its own total");
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.idle();
  typical = await world.boxes.typicalReady();
  assert.equal(typical[key], Math.round((first.timings.total! + second.timings.total!) / 2), "two starts: their mean, as the median");
  const history = (await world.kv.get<Record<string, number[]>>("ready-history"))!;
  assert.deepEqual(history[key], [first.timings.total, second.timings.total]);

  // A spare counts as ready on its backend; claiming it is not a start.
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  assert.deepEqual(await world.boxes.spareReadyByBackend(), { [key]: 1 });
  const claimed = await world.boxes.acquire({ threadId: "thr_other", projectId: null, kind: "linux" });
  await world.boxes.idle();
  assert.notEqual(claimed.timings.spare, undefined, "claimed from the spare");
  assert.equal(((await world.kv.get<Record<string, number[]>>("ready-history"))!)[key]!.length, 3, "the spare's own cold start counted once; the claim did not");
});

test("a kind's spares are made and enrolled ahead, and an acquire of the kind at its default size claims one at once (032)", async () => {
  const gate = deferred();
  const claimed: string[] = [];
  const logs: string[] = [];
  /** Whether BB shows a claimed spare's machine disconnected. */
  let disconnected = false;
  const world = setup(
    {},
    {
      enrolWaitMs: 5_000,
      claimed: async (box) => {
        claimed.push(`${machineName(box)} of ${box.threadId}`);
        return disconnected;
      },
      reconnect: async () => {
        await gate.promise;
      },
      log: (line) => logs.push(line),
    },
  );
  world.general = { ...world.general, perThreadLimit: 1, spares: { linux: 2 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const spares = await world.boxes.list(SPARES);
  assert.equal(spares.length, 2, "the per-thread limit is for threads");
  for (const spare of spares) {
    assert.equal(spare.state, "ready");
    assert.equal(spare.enrol.state, "enrolled");
    assert.equal(machineName(spare), `${spare.name} (spare)`);
    // One that waits stopped says so, as BB shows its machine offline meanwhile (#539).
    assert.equal(machineName({ ...spare, state: "stopped" }), `${spare.name} (spare, stopped)`);
  }
  assert.deepEqual([...world.enrolled].sort(), spares.map((spare) => spare.name).sort());
  const [spare] = spares;

  const started = Date.now();
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.ok(Date.now() - started < 250, "the claim does not wait for its machine's rename");
  assert.deepEqual(
    { id: box.id, state: box.state, threadId: box.threadId, projectId: box.projectId, name: box.name, enrol: box.enrol, guest: box.guest },
    { id: spare!.id, state: "ready", threadId: THREAD, projectId: "prj", name: spare!.name, enrol: spare!.enrol, guest: spare!.guest },
  );
  assert.equal(machineName(box), box.name);
  assert.deepEqual(Object.keys(box.timings).sort(), ["spare", "total"]);
  assert.match(boxDetail(box), /\nTimings: claiming a spare \d/);
  assert.deepEqual(await world.boxes.find(box.id), box);
  assert.deepEqual(await world.boxes.list(THREAD), [box]);
  assert.deepEqual(claimed, [`${box.name} of ${THREAD}`]);
  assert.ok(logs.includes(`Claimed spare box ${box.name} for thread ${THREAD}.`));
  assert.ok(world.notified.includes(SPARES) && world.notified.includes(THREAD));

  // Its first command does not wait for the machine's rename (#128).
  const ran = Date.now();
  assert.equal((await world.boxes.run(THREAD, box.name, "echo claimed")).result.stdout, "claimed\n");
  assert.ok(Date.now() - ran < 250, "the command did not wait for the claim");

  // Another spare takes its place; the claimed box does not enrol again.
  await until(async () => (await world.boxes.list(SPARES)).filter((spare) => spare.enrol.state === "enrolled").length === 2);
  const after = await world.boxes.list(SPARES);
  assert.ok(!after.some((spare) => spare.id === box.id));
  assert.equal(world.enrolled.length, 3);
  // By ID: the new spare's name is free to be the claimed box's, which left the spares.
  assert.ok(!world.enrolledIds.slice(2).includes(box.id));
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" }), /already has 1 boxes/);
  assert.equal((await world.boxes.list(SPARES)).length, 2, "a claim keeps to the thread's limit");
  assert.deepEqual(world.errors, []);
});

test("a new spare's name avoids a box a thread claimed with that name, so no two live boxes, or their BB machines, share one (#539)", async () => {
  // Every name is drawn from the same bytes, so a new name meets each name it could take; box IDs stay random.
  const { randomBytes } = await import("node:crypto");
  const world = setup({}, { enrolWaitMs: 5_000, random: (bytes) => (bytes === 2 ? new Uint8Array(2) : randomBytes(bytes)) });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.equal(box.id, spare!.id);
  assert.equal(box.name, spare!.name);
  await until(async () => (await world.boxes.list(SPARES)).some((other) => other.enrol.state === "enrolled"));
  const [next] = await world.boxes.list(SPARES);
  assert.notEqual(next!.id, box.id);
  assert.notEqual(next!.name, box.name, "the new spare's name is not the claimed box's");
  // A thread's new box avoids the spare's name too.
  const other = await world.boxes.acquire({ threadId: "thr_two", projectId: "prj", kind: "linux", size: { preset: "medium" } });
  assert.ok(![box.name, next!.name].includes(other.name), other.name);
});

test("a claimed spare whose BB machine BB shows disconnected reconnects, and its commands wait for that (#128)", async () => {
  const gate = deferred();
  const reconnected: string[] = [];
  const world = setup(
    {},
    {
      enrolWaitMs: 5_000,
      claimed: async () => true,
      reconnect: async (box) => {
        reconnected.push(box.name);
        await gate.promise;
      },
    },
  );
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  await until(async () => reconnected.length === 1);
  const ran = Date.now();
  setTimeout(gate.resolve, 300);
  assert.equal((await world.boxes.run(THREAD, box.name, "echo after")).result.stdout, "after\n");
  assert.ok(Date.now() - ran >= 250, "the command waited for the reconnect");
  assert.deepEqual(reconnected, [box.name]);
});

test("a claim takes only a ready, enrolled spare of the kind and size whose BB machine no thread uses, and keeps names unique (032)", async () => {
  let usable: boolean | Error = true;
  const logs: string[] = [];
  const world = setup(
    {},
    {
      spareThread: async () => {
        if (usable instanceof Error) throw usable;
        return usable ? null : "thr_picker";
      },
      log: (line) => logs.push(line),
    },
  );
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.ok(spare);
  const acquire = (input: Partial<Parameters<Boxes["acquire"]>[0]> = {}) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", ...input });
  const notClaimed = async (input: Partial<Parameters<Boxes["acquire"]>[0]> = {}) => {
    const box = await acquire(input);
    assert.equal(box.state, "acquiring");
    assert.notEqual(box.id, spare.id);
    assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => spare.id), [spare.id]);
    await world.boxes.release(THREAD, box.name, "the test asked");
  };
  await notClaimed({ kind: "linux-desktop" });
  await notClaimed({ size: { preset: "large" } });
  await world.boxes.update(spare, () => ({ enrol: { state: "enrolling", hostId: "host-late", error: null } }));
  await notClaimed();
  await world.boxes.update(spare, () => ({ enrol: { state: "enrolled", hostId: `host-${spare.id}`, error: null } }));
  usable = false;
  await notClaimed();
  assert.ok(logs.includes(`Skipped spare box ${spare.name}: a thread uses its BB machine.`));
  usable = new Error("BB did not answer");
  await notClaimed();
  assert.deepEqual(world.errors, ["claim: BB did not answer"]);

  // A thread with a box of the spare's name gives the claimed box another.
  usable = true;
  const other = await ready(world.boxes, await acquire({ kind: "linux-desktop" }));
  await world.boxes.update(other, () => ({ name: spare.name }));
  const box = await acquire();
  assert.equal(box.id, spare.id);
  assert.notEqual(box.name, spare.name);
  assert.deepEqual((await world.boxes.list(THREAD)).map((box) => box.name).sort(), [box.name, spare.name].sort());
});

test("a stopped spare a thread started on becomes yours, still stopped, and reconnects when it starts, rather than going as failed (036, #156)", async () => {
  let picker: string | null = null;
  const world = setup({}, { spareThread: async () => picker, claimed: async () => true });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare?.enrol.state, "enrolled");
  await world.boxes.stop(SPARES, spare.name);

  picker = "thr_picker";
  await world.boxes.keepSpares();
  const [yours] = await world.boxes.list(OPERATOR);
  assert.deepEqual([yours?.id, yours?.state, yours?.enrol.state], [spare.id, "stopped", "enrolled"]);
  await until(async () => (await world.boxes.list(SPARES)).some((other) => other.id !== spare.id));
  await world.boxes.idle();
  assert.deepEqual(world.reconnected, [], "its daemon cannot start while it is stopped");

  await world.boxes.start(OPERATOR, yours!.name);
  await until(async () => world.reconnected.length === 1);
  assert.deepEqual(world.reconnected, [spare.enrol.hostId]);
  assert.deepEqual(world.errors, []);
});

test("a spare released by hand is replaced at once, not at the next sweep (#129)", async () => {
  const world = setup();
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare?.enrol.state, "enrolled");

  assert.equal(await world.boxes.release(SPARES, spare.name, "the test asked"), null);
  await until(async () => (await world.boxes.list(SPARES)).some((other) => other.id !== spare.id && other.enrol.state === "enrolled"));
  assert.equal((await world.boxes.list(SPARES)).length, 1);
  assert.deepEqual(world.errors, []);
});

/** A world whose fake backend starts boxes from builds, with a project's image "rust" baked as `build.ref`, and its spare wanted while `build.wanted`. */
function imageWorld(options: Omit<FakeBackendOptions, "root" | "storage"> = {}, log?: (line: string) => void) {
  const image = { kinds: ["linux"], script: 'touch "$HOME/ran"\n', projects: ["prj"] };
  const build = { ref: "rust-1", wanted: true };
  const readied: string[] = [];
  const started: (string | undefined)[] = [];
  const world = setup(options, {
    image: (projectId, kind, name) => ((name ?? (projectId === "prj" ? "rust" : null)) === "rust" && kind === "linux" ? { name: "rust", image } : null),
    baked: async (name, backend, kind) => (name === "rust" && kind === "linux" ? { ref: build.ref, build: `build.${build.ref}` } : null),
    imageReady: (box) => void readied.push(`${box.threadId} ${box.image?.state}`),
    imageSpares: async () => (build.wanted ? [{ name: "rust", backend: world.backend.id, kind: "linux", ref: build.ref }] : []),
    ...(log ? { log } : {}),
  });
  Object.defineProperty(world.backend, "images", { value: { startsFrom: true, spares: true } });
  const acquire = world.backend.acquire.bind(world.backend);
  world.backend.acquire = (box, previous, hooks, signal) => {
    started.push(box.from);
    if (box.from === "broken") return Promise.reject(new Error("the build does not boot"));
    return acquire(box, previous, hooks, signal);
  };
  return { world, build, readied, started };
}

test("a project's box claims a spare of its image's current build, made ahead, and a kind's box does not (#440)", async () => {
  const { world, readied, started } = imageWorld();
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.deepEqual([spare?.image, spare?.enrol.state, started], [{ name: "rust", state: "baked", build: "build.rust-1", from: "rust-1" }, "enrolled", ["rust-1"]]);
  assert.deepEqual(readied, [], "a spare's own start is no use of its image");
  assert.deepEqual(await world.boxes.imageSpareCounts(), { "rust|fake|linux": { ready: 1, making: 0 } });
  assert.deepEqual(await world.boxes.spareCounts(), {}, "an image's spare is not its kind's");
  assert.deepEqual(await world.boxes.spareReadyByBackend(), {}, "nor ready for the kind's boxes");

  // A kind's box makes its own guest; the project's box takes the spare at once.
  const plain = await world.boxes.acquire({ threadId: THREAD, projectId: "prj_other", kind: "linux" });
  assert.equal(plain.timings.spare, undefined);
  const claimed = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux" });
  assert.deepEqual([claimed.id, claimed.image?.from, typeof claimed.timings.spare], [spare!.id, "rust-1", "number"]);
  assert.deepEqual(readied, [`${THREAD} baked`], "the claim is a use of its build");
  await world.boxes.idle();
  assert.equal((await world.boxes.list(SPARES)).length, 1, "another spare is made");
});

test("an image's spare goes when its build changes or the image is not in use, and one of a failing build is not made again for a day (#440)", async () => {
  const logs: string[] = [];
  const { world, build, started } = imageWorld({}, (line) => logs.push(line));
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [first] = await world.boxes.list(SPARES);

  // A new build: the old spare goes, and one of the new build comes.
  build.ref = "rust-2";
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const spares = await world.boxes.list(SPARES);
  assert.deepEqual(spares.map((spare) => spare.image?.from), ["rust-2"]);
  assert.ok(logs.includes(`Releasing spare box ${first!.name}: its image rust is not in use, or its build on fake is not current.`), logs.join("\n"));

  // Not in use: no spare.
  build.wanted = false;
  await world.boxes.keepSpares();
  await world.boxes.idle();
  assert.deepEqual(await world.boxes.list(SPARES), []);

  // A build whose boxes fail: one try, then none for a day, then again for another build.
  build.wanted = true;
  build.ref = "broken";
  for (let i = 0; i < 3; i++) {
    await world.boxes.keepSpares();
    await world.boxes.idle();
  }
  assert.equal(started.filter((from) => from === "broken").length, 1, "made once, not in a loop");
  const [check] = await world.boxes.imageSpareChecks();
  assert.deepEqual([check?.name, check?.status], ["Spare of rust for linux on fake", "warn"]);
  assert.match(check!.detail, /^A spare from its build broken failed to start at \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC, so bb-box keeps none of that build until .* UTC\. Its boxes start from the build meanwhile\.$/);
  build.ref = "rust-3";
  await world.boxes.keepSpares();
  await world.boxes.idle();
  assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => [spare.image?.from, spare.state]), [["rust-3", "ready"]]);
});

test("an image's spare gives its room to a thread's box that finds none (#440)", async () => {
  const logs: string[] = [];
  const { world } = imageWorld({ maxGuests: 1 }, (line) => logs.push(line));
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare?.image?.name, "rust");
  const box = await world.boxes.acquire({ threadId: "a", projectId: null, kind: "linux-desktop" });
  assert.ok(logs.includes(`Releasing spare box ${spare!.name}: a thread's linux-desktop box needs its room.`));
  assert.equal((await ready(world.boxes, box)).state, "ready");
  await world.boxes.keepSpares();
  assert.deepEqual(await world.boxes.list(SPARES), [], "the upkeep takes no thread's room");
  assert.ok(logs.some((line) => line.startsWith("bb-box keeps no spare rust linux box on fake for now: ")), logs.join("\n"));
});

test("a spare gives its room to a thread's box that finds none, and comes back only when there is room (#120)", async () => {
  const logs: string[] = [];
  const world = setup({ maxGuests: 2 }, { log: (line) => logs.push(line) });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare?.enrol.state, "enrolled");
  // No claim takes a linux spare for a desktop, so each desktop needs a guest of its own.
  const first = await world.boxes.acquire({ threadId: "a", projectId: null, kind: "linux-desktop" });

  const second = await world.boxes.acquire({ threadId: "b", projectId: null, kind: "linux-desktop" });
  assert.ok(logs.includes(`Releasing spare box ${spare.name}: a thread's linux-desktop box needs its room.`));
  assert.deepEqual(await world.boxes.list(SPARES), []);
  assert.ok(world.unenrolled.includes(spare.enrol.hostId!));
  assert.equal((await ready(world.boxes, second)).state, "ready");
  await world.boxes.idle();

  // With no spare left, a box that finds no room fails as before, and keeping spares takes no thread's room.
  await assert.rejects(world.boxes.acquire({ threadId: "c", projectId: null, kind: "linux-desktop" }), (error: unknown) => error instanceof BoxError && error.code === "no_capacity");
  await world.boxes.keepSpares();
  assert.deepEqual(await world.boxes.list(SPARES), []);
  assert.ok(logs.some((line) => line.startsWith("bb-box keeps 0 of 1 spare linux boxes for now: ")));
  assert.equal((await world.boxes.list("a"))[0]?.state, "ready");

  assert.equal(await world.boxes.release("a", first.name, "the test asked"), null);
  await world.boxes.keepSpares();
  await world.boxes.idle();
  assert.equal((await world.boxes.list(SPARES))[0]?.enrol.state, "enrolled");
  assert.deepEqual(world.errors, []);
});

test("a claimed spare's guest is relabelled for its new owner, and renamed when its name changes (036)", async () => {
  const world = setup();
  world.general = { ...world.general, spares: { linux: 2 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const spares = await world.boxes.list(SPARES);
  const mine = await world.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", name: "build-1" });
  const theirs = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  assert.ok(spares.some((spare) => spare.id === mine.id) && spares.some((spare) => spare.id === theirs.id), "both took a spare");
  await until(async () => world.backend.relabels.length === 2);
  const from = (id: string) => spares.find((spare) => spare.id === id)!.name;
  assert.deepEqual(
    [...world.backend.relabels].sort((a, b) => a.threadId.localeCompare(b.threadId)),
    [
      { boxId: mine.id, threadId: OPERATOR, name: "build-1", from: from(mine.id) },
      { boxId: theirs.id, threadId: THREAD, name: theirs.name, from: from(theirs.id) },
    ].sort((a, b) => a.threadId.localeCompare(b.threadId)),
  );
});

test("a claimed spare's timings count the relabel when its name changes, and show a short claim in milliseconds (#186)", async () => {
  const world = setup();
  world.general = { ...world.general, spares: { linux: 2 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  world.backend.relabelMs = 150;
  // Your machine takes the name you give it, so its commands wait for the relabel; the thread's keeps the spare's.
  const mine = await world.boxes.enrolled(await world.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", name: "build-1" }));
  const theirs = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await until(async () => (await world.boxes.find(theirs.id))?.timings.relabel !== undefined);

  const { spare, relabel, total } = mine.timings;
  assert.ok(spare! < 100 && relabel! >= 150, JSON.stringify(mine.timings));
  assert.equal(total, spare! + relabel!, "the claim is ready once its guest has the new name");
  assert.match(boxDetail(mine), new RegExp(`\\nTimings: claiming a spare ${spare} ms, total ${(total! / 1000).toFixed(1)} s, naming it for its owner ${(relabel! / 1000).toFixed(1)} s$`));
  const kept = (await world.boxes.find(theirs.id))!.timings;
  assert.equal(kept.total, kept.spare, "a spare that keeps its name is ready on the claim");
});

test("the sweep keeps your machines, and restores a lost one to you under its name, asking BB for no project (036)", async () => {
  const projects: string[] = [];
  const world = setup({}, { projectOf: async (threadId) => (projects.push(threadId), null) });
  world.threads.set(OPERATOR, "ended");
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", name: "build-1" }));
  await world.boxes.sweep();
  await world.boxes.idle();
  assert.deepEqual((await world.boxes.list(OPERATOR)).map((each) => each.id), [box.id], "BB's answer for its thread is never asked");

  await world.kv.delete(`box/${OPERATOR}/${box.id}`);
  await world.kv.delete(`index/${box.id}`);
  assert.equal((await world.boxes.sweep()).adopted, 1);
  await world.boxes.idle();
  const restored = await world.boxes.find(box.id);
  assert.equal(restored?.threadId, OPERATOR);
  assert.equal(restored?.name, "build-1");
  assert.equal(restored?.projectId, null);
  assert.deepEqual(projects, []);
});

test("the sweep keeps spares, restores a lost one as a spare, and releases those no kind keeps or no claim can take (032)", async () => {
  const world = setup();
  world.general = { ...world.general, spares: { linux: 2 } };
  // BB knows no thread of that ID; the sweep never asks.
  world.threads.set(SPARES, "ended");
  await world.boxes.sweep();
  await world.boxes.idle();
  const made = await world.boxes.list(SPARES);
  assert.equal(made.length, 2);
  await world.boxes.sweep();
  await world.boxes.idle();
  assert.deepEqual(await world.boxes.list(SPARES), made, "the sweep kept them");

  // A lost record comes back as a spare.
  const [lost, kept] = made;
  await world.kv.delete(`box/${SPARES}/${lost!.id}`);
  await world.kv.delete(`index/${lost!.id}`);
  assert.equal((await world.boxes.sweep()).adopted, 1);
  await world.boxes.idle();
  const restored = await world.boxes.find(lost!.id);
  assert.equal(restored?.threadId, SPARES);
  assert.equal(restored?.enrol.state, "enrolled");
  assert.equal((await world.boxes.list(SPARES)).length, 2);

  // A claimed spare whose old record outlived the move is not released.
  const claimed = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
  await world.kv.set(`box/${SPARES}/${claimed.id}`, { ...claimed, threadId: SPARES });
  await world.boxes.sweep();
  await world.boxes.idle();
  assert.equal((await world.boxes.find(claimed.id))?.threadId, THREAD);
  assert.ok(!(await world.boxes.list(SPARES)).some((spare) => spare.id === claimed.id));

  // A spare whose machine was removed in BB, or that stopped, is replaced.
  const spares = await world.boxes.list(SPARES);
  assert.equal(spares.length, 2);
  await world.boxes.update(spares[0]!, () => ({ enrol: { state: "off", hostId: null, error: null } }));
  await world.boxes.stop(SPARES, spares[1]!.name);
  await world.boxes.sweep();
  await world.boxes.idle();
  const replaced = await world.boxes.list(SPARES);
  assert.equal(replaced.length, 2);
  assert.ok(!replaced.some((spare) => spares.some((old) => old.id === spare.id)));

  // A new default size replaces them, and a kind that keeps none releases them.
  world.general = { ...world.general, sizes: parseSizeChanges({ linux: { default: "medium" } }).changes };
  await world.boxes.sweep();
  await world.boxes.idle();
  assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => spare.size), [{ cores: 4, memoryMiB: 8 * GiB, diskGiB: null }, { cores: 4, memoryMiB: 8 * GiB, diskGiB: null }]);
  world.general = { ...world.general, spares: {} };
  await world.boxes.sweep();
  await world.boxes.idle();
  assert.deepEqual(await world.boxes.list(SPARES), []);
  assert.deepEqual((await world.backend.held()).map((guest) => guest.owner?.boxId), [claimed.id]);
  assert.equal((await world.boxes.find(kept!.id)), null);
  assert.deepEqual(world.errors, []);
});

test("the sweep never releases a guest whose record is missing while its thread is live or unknown", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.kv.delete(`box/${THREAD}/${box.id}`);
  await world.kv.delete(`index/${box.id}`);
  for (const liveness of ["unknown", "unknown", "live", "live"] as const) {
    world.threads.set(THREAD, liveness);
    const report = await world.boxes.sweep();
    assert.equal(report.leftovers, 0, `a ${liveness} thread keeps its guest`);
    assert.equal(report.released, 0);
  }
  assert.equal((await world.boxes.find(box.id))?.state, "ready");
  assert.deepEqual((await world.backend.held()).map((guest) => guest.owner?.boxId), [box.id]);
});

test("the sweep releases a guest whose box moved on or failed", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  // The record says the box holds nothing, but the provider still has its guest.
  await world.boxes.update(box, () => ({ state: "failed", guest: null, error: "boom" }));
  const report = await world.boxes.sweep();
  assert.equal(report.leftovers, 1);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal((await world.boxes.find(box.id))?.state, "failed");
});

test("the sweep notices power changes and deleted guests", async () => {
  const world = setup();
  const a = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const b = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.backend.stop!(a.guest!);
  await world.backend.release(b.guest!, QUIET);
  await world.boxes.sweep();
  assert.equal((await world.boxes.find(a.id))?.state, "stopped");
  assert.equal((await world.boxes.find(b.id))?.state, "gone");
});

test("the sweep acts on a guest's power only once the guest confirms it, so a box that started meanwhile stays ready", async () => {
  /** What the box was recorded as, other than ready, as computer use forgets the box then. */
  const states: string[] = [];
  const world = setup({}, { recorded: (box, deleted) => (deleted || box.state !== "ready") && states.push(deleted ? "deleted" : box.state) });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.stop(THREAD, box.name);
  const held = world.backend.held.bind(world.backend);
  // The listing says stopped, and the box starts before the sweep reads the records.
  world.backend.held = async () => {
    const listing = await held();
    await world.boxes.start(THREAD, box.name);
    states.length = 0;
    return listing;
  };
  await world.boxes.sweep();
  assert.equal((await world.boxes.find(box.id))?.state, "ready");
  assert.deepEqual(states, [], "the box was only ever recorded as ready");

  // A provider's listing that lags behind a running guest.
  world.backend.held = async () => (await held()).map((guest) => ({ ...guest, power: "stopped" as const }));
  await world.boxes.sweep();
  assert.equal((await world.boxes.find(box.id))?.state, "ready");
  assert.deepEqual(states, []);
});

test("a reused reference is the new box's: the old box goes, and its release leaves the new box alone", async () => {
  const world = setup();
  const old = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  // Deleted outside bb-box, then the provider gives the reference to the next box.
  await world.backend.release(old.guest!, QUIET);
  await world.kv.set("backend/fake/counter", 0);
  const next = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(next.guest!.ref, old.guest!.ref);
  await world.boxes.sweep();
  assert.equal((await world.boxes.find(old.id))?.state, "gone");
  assert.equal((await world.boxes.find(next.id))?.state, "ready");
  assert.equal(await world.boxes.release(THREAD, old.id, "the test asked"), null);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [next.id],
  );
  assert.equal((await world.boxes.run(THREAD, next.name, "echo still")).result.stdout, "still\n");
});

/** Makes a box's guest and record as they were before install IDs (018). */
async function fromBeforeInstallIds(world: ReturnType<typeof setup>, box: BoxRecord): Promise<string> {
  const key = `backend/fake/guest/${box.guest!.ref}`;
  const { install: _, ...record } = (await world.kv.get<Record<string, unknown>>(key))!;
  await world.kv.set(key, record);
  const { ref, host, address } = box.guest!;
  await world.boxes.update(box, () => ({ guest: { ref, host, address, size: null } }));
  return key;
}

test("the first sweep records this install on its boxes' guests from before install IDs, and leaves other guests alone", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const key = await fromBeforeInstallIds(world, box);
  // An acquire the last process left after its claim.
  world.backend.gate = new Promise(() => {});
  const interrupted = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await until(async () => !!(await world.boxes.find(interrupted.id))?.guest);
  const claimed = (await world.boxes.find(interrupted.id))!;
  await fromBeforeInstallIds(world, claimed);
  // A guest with no install ID that no box of this install records.
  const stranger = { boxId: "bx_stranger", threadId: "thr_else", name: "stranger", kind: "linux", createdAt: 0 };
  await world.kv.set("backend/fake/guest/g9", { owner: stranger, power: "running" });
  assert.deepEqual(await world.backend.held(), [], "no guest names this install yet");

  const boxes = world.restart();
  const report = await boxes.sweep();
  assert.equal(report.leftovers, 0);
  assert.equal(report.resumed, 1);
  const after = await boxes.find(box.id);
  assert.equal(after?.state, "ready");
  assert.deepEqual(after?.guest?.data, { box: box.id });
  assert.equal((await world.kv.get<{ install?: string }>(key))?.install, "test");
  const resumed = await ready(boxes, interrupted);
  assert.equal(resumed.guest?.ref, claimed.guest!.ref, "the interrupted acquire resumes with its claimed guest");
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [box.id, interrupted.id],
  );
  assert.deepEqual((await world.kv.list("backend/fake/guest/")).length, 3, "no guest is left behind or made twice");
  assert.ok(await world.kv.get("backend/fake/guest/g9"), "the stranger's guest is left alone");
  const stamps = world.backend.calls.filter((call) => call.startsWith("stamp"));
  assert.deepEqual(stamps.sort(), [`stamp ${box.guest!.ref}`, `stamp ${claimed.guest!.ref}`].sort());
  await boxes.sweep();
  assert.equal(world.backend.calls.filter((call) => call.startsWith("stamp")).length, 2, "each box is stamped once");
});

test("stopping or releasing a box from before install IDs records the install first", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await fromBeforeInstallIds(world, box);
  const stopped = await world.boxes.stop(THREAD, box.id);
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.guest?.data?.box, box.id);
  const other = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await fromBeforeInstallIds(world, other);
  assert.equal(await world.boxes.release(THREAD, other.id, "the test asked"), null);
  assert.deepEqual(world.backend.calls.slice(-2), [`stamp ${other.guest!.ref}`, `release ${other.guest!.ref}`]);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [box.id],
  );
});

test("after a restart the sweep resumes an interrupted acquire with its claimed guest", async () => {
  const world = setup();
  world.backend.gate = new Promise(() => {});
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await until(async () => !!(await world.boxes.find(box.id))?.guest);
  const claimed = (await world.boxes.find(box.id))!.guest!;
  // The old process stops here without cleaning up.
  const boxes = world.restart();
  const report = await boxes.sweep();
  assert.equal(report.resumed, 1);
  const done = await ready(boxes, box);
  assert.equal(done.state, "ready");
  assert.deepEqual(done.guest, claimed);
  assert.deepEqual((await world.backend.held()).map((guest) => guest.ref), [claimed.ref]);
});

test("dispose cancels acquires in progress, and the next start acquires them again", async () => {
  const world = setup();
  const gate = deferred();
  world.backend.gate = gate.promise;
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await until(async () => !!(await world.boxes.find(box.id))?.guest);
  const disposed = world.boxes.dispose();
  gate.resolve();
  await disposed;
  const left = await world.boxes.find(box.id);
  assert.equal(left?.state, "acquiring");
  assert.equal(left?.guest, null);
  assert.deepEqual(await world.backend.held(), []);
  const boxes = world.restart();
  await boxes.sweep();
  assert.equal((await ready(boxes, box)).state, "ready");
});

test("dispose during a shared box's acquire keeps its place on the shared host, and the next start acquires it there (F-7)", async () => {
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 8 } });
  const gate = deferred();
  world.backend.gate = gate.promise;
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true });
  const placed = (await world.boxes.find(box.id))!.guest!;
  assert.ok(inSlot({ guest: placed }));
  const disposed = world.boxes.dispose();
  gate.resolve();
  await disposed;
  const left = await world.boxes.find(box.id);
  assert.equal(left?.state, "acquiring");
  assert.deepEqual(left?.guest, placed, "its place on the host outlives the instance");
  world.backend.gate = null;
  const boxes = world.restart();
  await boxes.sweep();
  const done = await ready(boxes, box);
  assert.equal(done.state, "ready");
  assert.equal(done.guest?.ref, placed.ref, "the same slot, not a VM of its own");
});

test("a real backend's release resets the machine and returns it for the next box", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(first.nature, "real");
  await world.boxes.writeFile(THREAD, first.name, "left-behind", Buffer.from("x"));
  await assert.rejects(world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }), /All 1 machines are in use/);
  assert.equal(await world.boxes.release(THREAD, first.name, "the test asked"), null);
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  assert.equal((await world.boxes.run("thr_two", second.name, "ls")).result.stdout, "");
});

test("a box whose backend is off can be seen but says what to fix, and is kept", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.active = false;
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /backend that holds box .* is not in bb-box.s settings, or its settings need fixing/);
  const kept = await world.boxes.release(THREAD, box.name, "the test asked");
  assert.equal(kept?.state, "releasing");
  assert.match(kept!.error!, /its settings need fixing/);
  await world.boxes.sweep();
  assert.ok(await world.boxes.find(box.id));
  world.active = true;
  await world.boxes.sweep();
  assert.equal(await world.boxes.find(box.id), null);
  assert.deepEqual(await world.backend.held(), []);
});

test("errors from a backend keep their message and never leak into other threads", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await assert.rejects(world.boxes.get("thr_two", box.name), /This thread has no box .* It has no boxes/);
  await assert.rejects(world.boxes.run("thr_two", box.id, "true"), /This thread has no box/);
});

test("a box whose backend cannot stop and start says so, and keeps running", async () => {
  const world = setup({ stopStart: false });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(world.boxes.canStopStart(box), false);
  await assert.rejects(world.boxes.stop(THREAD, box.name), (error: BoxError) => {
    assert.equal(error.code, "unsupported");
    assert.match(error.message, /Fake host cannot stop and start its boxes/);
    return true;
  });
  await assert.rejects(world.boxes.start(THREAD, box.name), /cannot stop and start/);
  assert.equal((await world.boxes.get(THREAD, box.name)).state, "ready");
});

test("a power the provider cannot tell leaves the box as it was", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.backend.power = async () => "unknown";
  assert.equal((await world.boxes.refresh(THREAD, box.name)).state, "ready");
  await world.boxes.sweep();
  assert.equal((await world.boxes.get(THREAD, box.name)).state, "ready");
});

test("a box records its offer's features, and the ones beyond what its kind and alias require (041)", async () => {
  const [headless] = FAKE_KINDS;
  const world = setup({ kinds: [{ ...headless!, capabilities: { ...headless!.capabilities, features: ["docker", "systemd"] } }] });
  const plain = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.deepEqual(plain.requires, []);
  assert.deepEqual(extraFeatures(plain), ["docker", "systemd"]);
  // linux-docker is linux that must have Docker.
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-docker" }));
  assert.deepEqual([box.kind, box.kindLabel], ["linux", "Linux"]);
  assert.deepEqual(box.requires, ["docker"]);
  assert.deepEqual(box.capabilities.features, ["docker", "systemd"]);
  assert.deepEqual(extraFeatures(box), ["systemd"]);
  assert.ok(!world.boxes.kinds().some((kind) => kind.id === "linux-docker"), "an alias is never offered");

  // A record stored when linux-docker was a kind reads as linux that must have Docker.
  let key = "";
  for (const each of await world.kv.list(`box/${THREAD}/`)) if ((await world.kv.get<BoxRecord>(each))?.id === plain.id) key = each;
  const stored = (await world.kv.get<BoxRecord>(key))!;
  await world.kv.set(key, { ...stored, kind: "linux-docker", kindLabel: "Linux with Docker", requires: ["docker"] });
  const read = await world.boxes.find(stored.id);
  assert.deepEqual([read?.kind, read?.kindLabel, read?.requires], ["linux", "Linux", ["docker"]]);
});

test("an acquire through an alias takes only offers with its features, and says what to ask for instead (041)", async () => {
  const world = setup();
  await assert.rejects(
    world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-docker" }),
    (error: unknown) =>
      error instanceof BoxError &&
      error.code === "unknown_kind" &&
      error.message === `No backend offers linux-docker now: linux boxes from ${world.backend.label} have no Docker. Ask for linux if the box can do without it.`,
  );
  assert.deepEqual(await world.boxes.list(THREAD), [], "nothing was made");
  await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
});

test("an offer must still have an alias's features once its room is checked, a box records what it has then, and no spare is freed for it (041, #282)", async () => {
  const [headless, desktop] = FAKE_KINDS;
  const logs: string[] = [];
  const world = setup({ kinds: [{ ...headless!, capabilities: { ...headless!.capabilities, features: ["docker"] } }, desktop!] }, { log: (line) => logs.push(line) });
  world.general = { ...world.general, spares: { "linux-desktop": 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare?.enrol.state, "enrolled");
  // As a Docker backend learns that its host is rootless Docker when it first asks it for room.
  const capacity = world.backend.capacity.bind(world.backend);
  world.backend.capacity = async (kind, size, pending) => {
    world.backend.kinds = () => [headless!, desktop!];
    return capacity(kind, size, pending);
  };
  await assert.rejects(
    world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-docker" }),
    (error: unknown) =>
      error instanceof BoxError &&
      error.code === "unknown_kind" &&
      error.message === `linux boxes from ${world.backend.label} have no Docker. Ask for linux if the box can do without it.`,
  );
  assert.deepEqual(await world.boxes.list(THREAD), [], "nothing was made");
  assert.deepEqual((await world.boxes.list(SPARES)).map((box) => box.id), [spare.id], "the spare gave no room for nothing");
  assert.ok(!logs.some((line) => line.startsWith("Releasing spare box")));
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.deepEqual(box.capabilities.features, []);
});

test("a desktop command runs in the desktop session, and a box without a desktop has none", async () => {
  const world = setup();
  const desktop = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" }));
  const inSession = await world.boxes.run(THREAD, desktop.name, 'echo "$DISPLAY $DBUS_SESSION_BUS_ADDRESS"', { session: "desktop" });
  assert.match(inSession.result.stdout, /^:0 unix:path=\/run\/user\/\d+\/bus\n$/);
  assert.equal((await world.boxes.run(THREAD, desktop.name, 'echo "[$DISPLAY]"')).result.stdout, "[]\n");
  const headless = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await assert.rejects(world.boxes.run(THREAD, headless.name, "true", { session: "desktop" }), /has no desktop/);
});

test("a macOS desktop command runs through sudo and launchctl asuser, with the thread's environment, stdin and its own exit status", () => {
  const { uid, username } = userInfo();
  const dir = tempDir("mac-desktop");
  const fakes = join(dir, "bin");
  const home = join(dir, "home");
  const work = join(dir, "work dir");
  for (const path of [fakes, home, work]) mkdirSync(path);
  // As on a Mac: the wrapper starts the command in the desktop session, as
  // the box user, with a fresh environment.
  writeFileSync(
    join(fakes, "sudo"),
    String.raw`#!/bin/sh
n=$(ls "$FAKE_LOG" | wc -l | tr -d ' ')
printf '%s\0' "$@" > "$FAKE_LOG/$n"
[ -z "$FAKE_REFUSES" ] || { echo 'sudo: a password is required' >&2; exit 1; }
[ "$1 $2 $3 $4 $5 $6 $7 $8 $9" = "-n /bin/launchctl asuser $(id -u) /usr/bin/sudo -n -u $(id -un) --" ] || exit 1
shift 9
exec env -i HOME="$HOME" PATH="$PATH" BBX_SESSION=Aqua "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(join(fakes, "stat"), `#!/bin/sh\n[ "$*" = "-f %Su /dev/console" ] && printf '%s\\n' "$FAKE_CONSOLE"\n`, { mode: 0o755 });
  const script = command("macos", 'printf \'%s|%s|%s\\n\' "$BBX_SESSION" "$BBX_ONE" "$PWD"; echo to-stderr >&2; cat; exit 5', {
    session: "desktop",
    cwd: work,
    env: envScript("macos", { BBX_ONE: "one" }),
  });
  const zsh = spawnSync("zsh", ["-fc", "command -v zsh"], { encoding: "utf8" }).stdout?.trim();
  const shells = ["/bin/sh", ...(zsh ? [zsh] : [])];
  for (const shell of shells) {
    const run = (env: Record<string, string>, body = script) => {
      const log = tempDir("mac-desktop-log");
      const result = spawnSync(shell, ["-c", body], {
        input: "hello\n",
        encoding: "utf8",
        env: { PATH: `${fakes}:/usr/bin:/bin`, HOME: home, SHELL: shell, FAKE_LOG: log, FAKE_CONSOLE: username, ...env },
      });
      const calls = readdirSync(log)
        .sort((a, b) => Number(a) - Number(b))
        .map((name) => readFileSync(join(log, name), "utf8").split("\0").slice(0, -1));
      return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
    };
    const ran = run({});
    assert.deepEqual([ran.status, ran.stdout, ran.stderr], [5, `Aqua|one|${work}\nhello\n`, "to-stderr\n"], shell);
    const wrapper = ["-n", "/bin/launchctl", "asuser", String(uid), "/usr/bin/sudo", "-n", "-u", username, "--"];
    assert.deepEqual(ran.calls[0], [...wrapper, "/usr/bin/true"], `${shell}: a no-op checks the wrapper first`);
    assert.deepEqual(ran.calls[1]!.slice(0, -1), [...wrapper, shell, "-c"], `${shell}: the command runs through the wrapper`);

    // Where the box has bb-box's launcher (#628), the command goes through it, with the same result.
    const launcher = join(dir, "launcher");
    writeFileSync(launcher, '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
    const launched = run({}, script.replaceAll(MAC_LAUNCHER, launcher));
    assert.deepEqual([launched.status, launched.stdout, launched.stderr], [5, `Aqua|one|${work}\nhello\n`, "to-stderr\n"], shell);
    assert.deepEqual(launched.calls[1]!.slice(0, -1), [...wrapper, launcher, shell, "-c"], `${shell}: the command goes through the launcher`);

    // Another user has the console: root, as at the login window, unless the tests run as root.
    const other = username === "root" ? "nobody" : "root";
    const away = run({ FAKE_CONSOLE: other });
    assert.equal(away.status, DESKTOP_EXITS.noSession, shell);
    assert.equal(away.stderr, `bb-box: there is no desktop session to join: ${username} is not logged in to the desktop (the console belongs to ${other}).\n`);
    assert.deepEqual([away.stdout, away.calls.length], ["", 0]);

    const refused = run({ FAKE_REFUSES: "1" });
    assert.equal(refused.status, DESKTOP_EXITS.refused, shell);
    assert.match(refused.stderr, /^bb-box: sudo does not let \S+ run commands in the desktop session\. Mac setup adds this rule as \/etc\/sudoers\.d\/bb-box-desktop:\n/);
    assert.ok(refused.stderr.endsWith(`\n${username} ALL=(root) NOPASSWD: /bin/launchctl asuser ${uid} /usr/bin/sudo -n -u ${username} -- *\n`), refused.stderr);
    assert.deepEqual([refused.stdout, refused.calls.length], ["", 1]);
  }
});

test("a real backend's release records the reset, and a failed reset takes the machine out of service", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const release = world.backend.release.bind(world.backend);
  let seen: BoxRecord | null = null;
  world.backend.release = (guest, hooks) =>
    release(guest, {
      ...hooks,
      resetting: async () => {
        await hooks.resetting();
        seen = await world.boxes.find(box.id);
      },
    });
  world.backend.faults.reset = "the box user's processes would not stop";
  assert.equal(await world.boxes.release(THREAD, box.name, "the test asked"), null);
  assert.equal(seen!.state, "releasing");
  assert.ok(seen!.resetAt);
  const [member] = await world.backend.members!();
  assert.equal(member?.state, "out-of-service");
  assert.equal(member?.reason, "the box user's processes would not stop");
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }), /All 1 machines are in use/);
  await world.backend.returnToService!(member!.ref);
  assert.equal((await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }))).state, "ready");
});

test("a stale release of a real machine does not reset the next box's machine", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.boxes.release(THREAD, first.name, "the test asked");
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  await world.backend.release(first.guest!, QUIET);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [second.id],
  );
});

test("a box gains what a release adds to its kind, where its backend says the guest comes from what it offers, keeping its guest as made (#215)", async () => {
  const options: { kinds: BoxKind[] } = { kinds: [...FAKE_KINDS] };
  const world = setup(options);
  const kept = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const other = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(kept.capabilities.computerUse, null);
  assert.equal(await world.boxes.refreshCapabilities(), 0, "nothing changed");

  // A release whose linux kind has computer use, after a restart.
  const computerUse = { driver: "cua" as const, version: "1.0.0", socket: "/tmp/cua.sock" };
  options.kinds = FAKE_KINDS.map((kind) => (kind.id === "linux" ? { ...kind, capabilities: { ...kind.capabilities, computerUse } } : kind));
  const boxes = world.restart();
  // The backend made `other` from something it no longer offers the kind from.
  world.backend.asOffered = async (guest) => guest.ref !== other.guest!.ref;
  assert.equal(await boxes.refreshCapabilities(), 1);

  const gained = (await boxes.find(kept.id))!;
  assert.deepEqual(gained.capabilities.computerUse, computerUse);
  assert.deepEqual({ ...gained, capabilities: kept.capabilities }, kept, "the rest of the record, its guest and size among it, stays");
  assert.equal((await boxes.find(other.id))!.capabilities.computerUse, null);
  assert.equal(await boxes.refreshCapabilities(), 0, "once is enough");
});

test("a job's command outlives its connection and leaves its exit status and output, which the next job removes once bb-box has them (#405)", async () => {
  const home = tempDir("jobs");
  const env = { PATH: process.env.PATH, HOME: home };
  const run = (script: string, job: { id: string; forget: string[]; prune: boolean }) =>
    spawnSync("sh", ["-c", command("linux", script, { timeoutMs: 10_000, job })], { env, encoding: "utf8" });
  const read = (id: string) => spawnSync("sh", ["-c", jobScript(id, 4)], { env, encoding: "utf8" });

  // As when bb-box goes mid-command: its end of the connection closes, and
  // the command runs on.
  const id = newJobId();
  const child = spawn("sh", ["-c", command("linux", "echo started; sleep 0.5; echo out; echo err >&2; exit 3", { timeoutMs: 10_000, job: { id, forget: [], prune: false } })], { env, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.destroy();
  child.stderr.destroy();
  await until(async () => read(id).status === 4);
  assert.deepEqual([read(id).stdout, read(id).stderr], ["ted\n", ""], "while it runs, the end of its output so far");
  await until(async () => read(id).status === 0);
  assert.deepEqual([read(id).stdout, read(id).stderr], ["3\nstarted\nout\n", "err\n"], "its exit status, then its output, as often as it is read");

  // A job passes its result on as a command does, and leaves it too; the
  // next job removes the jobs bb-box has the results of.
  const next = newJobId();
  const ran = run("echo next; exit 2", { id: next, forget: [id], prune: false });
  assert.deepEqual([ran.status, ran.stdout, ran.stderr], [2, "next\n", ""]);
  assert.deepEqual([read(id).status, read(next).status], [3, 0]);

  // Once per box after bb-box starts, a job removes those older than a week.
  const old = join(home, JOBS_DIR, newJobId());
  mkdirSync(old);
  utimesSync(old, new Date(Date.now() - 8 * 86_400_000), new Date(Date.now() - 8 * 86_400_000));
  assert.equal(run("true", { id: newJobId(), forget: [], prune: false }).status, 0);
  assert.ok(existsSync(old), "kept without a prune");
  assert.equal(run("true", { id: newJobId(), forget: [], prune: true }).status, 0);
  assert.equal(existsSync(old), false);
  assert.equal(read(next).status, 0, "a recent job stays");

  // Where the files cannot be made, the command runs as it is.
  chmodSync(join(home, JOBS_DIR), 0o555);
  const direct = run("echo direct; exit 5", { id: newJobId(), forget: [], prune: false });
  chmodSync(join(home, JOBS_DIR), 0o755);
  assert.deepEqual([direct.status, direct.stdout], [5, "direct\n"]);
  assert.throws(() => jobScript("../x", 4), /is not a job ID/);
});

test("a desktop's clipboard commands: pbcopy and pbpaste on macOS, Get-Clipboard and Set-Clipboard as UTF-8 on Windows, in the desktop session; none on Linux (#464, #461)", () => {
  assert.equal(clipboardCommands("macos"), MAC_CLIPBOARD);
  assert.equal(clipboardCommands("windows"), WINDOWS_CLIPBOARD);
  assert.equal(clipboardCommands("linux"), null);
  // UTF-8 bytes both ways, not the console's code page.
  assert.match(WINDOWS_CLIPBOARD.read, /Get-Clipboard -Raw/);
  assert.match(WINDOWS_CLIPBOARD.read, /\[Text\.Encoding\]::UTF8\.GetBytes/);
  assert.match(WINDOWS_CLIPBOARD.read, /OpenStandardOutput/);
  assert.match(WINDOWS_CLIPBOARD.write, /OpenStandardInput\(\)\.CopyTo/);
  assert.match(WINDOWS_CLIPBOARD.write, /Set-Clipboard -Value \(\[Text\.Encoding\]::UTF8\.GetString/);
  // In the desktop session: the one-off scheduled task in the user's interactive logon (039), which passes stdin in and stdout back.
  const wrapped = command("windows", WINDOWS_CLIPBOARD.write, { session: "desktop", timeoutMs: 20_000 });
  assert.match(wrapped, /Schedule\.Service/);
  assert.match(wrapped, /OpenStandardInput\(\)\.CopyTo\(\$bbFile\)/);
});

test("the upkeep replaces a kind's spare whose image has a newer build, and keeps one its backend says is current or cannot tell of (049)", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line) });
  world.general = { ...world.general, spares: { linux: 1 } };
  const answers: (boolean | null)[] = [];
  let current: boolean | null = true;
  let asked = 0;
  Object.defineProperty(world.backend, "fromCurrentBuild", {
    value: async () => {
      asked++;
      answers.push(current);
      return current;
    },
  });
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [first] = await world.boxes.list(SPARES);
  assert.equal(first?.enrol.state, "enrolled");

  // Current, then cannot tell: the spare stays.
  await world.boxes.keepSpares();
  current = null;
  await world.boxes.keepSpares();
  assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => spare.id), [first.id]);

  // A refresh replaced the build: the upkeep releases the spare and makes another.
  current = false;
  await world.boxes.keepSpares();
  current = true;
  await until(async () => (await world.boxes.list(SPARES)).some((spare) => spare.id !== first.id && spare.enrol.state === "enrolled"));
  assert.ok(!(await world.boxes.list(SPARES)).some((spare) => spare.id === first.id));
  assert.match(logs.join("\n"), /its linux image on .+ has a newer build/);

  // A claim asks the backend once, and takes the current spare.
  const before = asked;
  const claimed = await world.boxes.acquire({ threadId: "thr_a", projectId: null, kind: "linux" });
  assert.ok(claimed.timings?.spare !== undefined, "from the spare");
  assert.equal(asked, before + 1, "the claim asked once");
  assert.deepEqual(world.errors, []);
});

test("once its image is replaced, a claim does not take a spare of the old build, even before the upkeep: it makes a box of the new build, and the upkeep replaces the spare at once", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line) });
  world.general = { ...world.general, spares: { linux: 1 } };
  let current = true;
  Object.defineProperty(world.backend, "fromCurrentBuild", { value: async () => current });
  await world.boxes.keepSpares();
  await world.boxes.idle();
  const [old] = await world.boxes.list(SPARES);
  assert.equal(old?.enrol.state, "enrolled");

  // The template is replaced; no upkeep has run since.
  current = false;
  const box = await world.boxes.acquire({ threadId: "thr_a", projectId: null, kind: "linux" });
  current = true;
  assert.equal(box.timings?.spare, undefined, "not the old build's spare");
  assert.notEqual(box.id, old!.id);
  assert.match(logs.join("\n"), new RegExp(`Skipped spare box ${old!.name}: it is of an older build of its linux image than .+ starts boxes from now\\. The upkeep replaces it\\.`));
  await until(async () => (await world.boxes.list(SPARES)).some((spare) => spare.id !== old!.id && spare.enrol.state === "enrolled"));
  assert.ok(!(await world.boxes.list(SPARES)).some((spare) => spare.id === old!.id), "the old spare is gone");
  assert.deepEqual(world.errors, []);
});

test("the upkeep replaces a spare that waits stopped when its image has a newer build, without starting it (#539, 049)", async () => {
  const logs: string[] = [];
  const world = setup({ keepsSession: () => true }, { log: (line) => logs.push(line) });
  world.general = { ...world.general, spares: { linux: 1 } };
  let current = true;
  const states: string[] = [];
  Object.defineProperty(world.backend, "fromCurrentBuild", {
    value: async () => current,
  });
  await world.boxes.keepSpares();
  await world.boxes.idle();
  await until(async () => (await world.boxes.list(SPARES))[0]?.state === "stopped");
  const [first] = await world.boxes.list(SPARES);
  await world.boxes.keepSpares();
  assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => [spare.id, spare.state]), [[first!.id, "stopped"]], "a current spare waits on");

  current = false;
  const original = world.backend.start!.bind(world.backend);
  Object.defineProperty(world.backend, "start", {
    value: async (...args: Parameters<typeof original>) => {
      states.push("started");
      return original(...args);
    },
  });
  await world.boxes.keepSpares();
  current = true;
  await until(async () => (await world.boxes.list(SPARES)).some((spare) => spare.id !== first!.id && spare.state === "stopped"));
  assert.ok(!(await world.boxes.list(SPARES)).some((spare) => spare.id === first!.id));
  assert.deepEqual(states, [], "the old spare was not started to ask");
  assert.match(logs.join("\n"), /its linux image on .+ has a newer build/);
  assert.deepEqual(world.errors, []);
});

test("a spare that waits stopped stays running until its device has booted, then stops; one whose device does not boot goes, and its kind makes none for a while (063)", async () => {
  const logs: string[] = [];
  let settling: SpareSettling = { is: "settling" };
  const asked: string[] = [];
  const world = setup({ keepsSession: () => true }, { log: (line) => logs.push(line), spareSettled: async (box) => (asked.push(box.name), settling) });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  await until(async () => (await world.boxes.list(SPARES))[0]?.enrol.state === "enrolled");
  await world.boxes.keepSpares();
  const [spare] = await world.boxes.list(SPARES);
  assert.equal(spare!.state, "ready", "its device is still booting");
  assert.ok(asked.includes(spare!.name));

  settling = { is: "settled" };
  await world.boxes.keepSpares();
  await until(async () => (await world.boxes.list(SPARES))[0]?.state === "stopped");
  const [stopped] = await world.boxes.list(SPARES);
  assert.equal(typeof stopped!.stoppedAt, "number");

  await world.boxes.start(SPARES, stopped!.id);
  settling = { is: "failed", words: "its Pixel 8 did not boot: the emulator exited" };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  await until(async () => (await world.boxes.list(SPARES)).every((each) => each.id !== stopped!.id));
  assert.match(logs.join("\n"), /its Pixel 8 did not boot: the emulator exited/);
  await world.boxes.keepSpares();
  await world.boxes.idle();
  assert.deepEqual(await world.boxes.list(SPARES), [], "no spare of the kind is made again at once");
  const [check] = (await world.boxes.spareChecks()).filter((each) => each.id === "spares.linux");
  assert.equal(check!.status, "warn");
  assert.match(check!.detail, /^bb-box keeps 1 spare linux box: 0 ready, 0 being made\. A spare waits stopped with its session saved: it holds no memory, and its saved memory takes disk, at most a little over its 4 GiB of memory, besides its own disk\. It has too few: its Pixel 8 did not boot: the emulator exited\.$/);
  assert.deepEqual(world.errors, []);
});

test("a spare that has waited stopped longer than its backend restores a saved session reliably is replaced, and one within it is kept (063)", async () => {
  const logs: string[] = [];
  let clock = 1_790_000_000_000;
  const world = setup({ keepsSession: () => true }, { log: (line) => logs.push(line), now: () => clock });
  Object.defineProperty(world.backend, "savedSessionRestoresWithinMs", { value: () => 6 * 3_600_000 });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  await until(async () => (await world.boxes.list(SPARES))[0]?.state === "stopped");
  const [first] = await world.boxes.list(SPARES);
  assert.equal(first!.stoppedAt, clock);

  clock += 5 * 3_600_000;
  await world.boxes.keepSpares();
  assert.deepEqual((await world.boxes.list(SPARES)).map((spare) => spare.id), [first!.id], "5 hours is within 6");

  clock += 2 * 3_600_000;
  await world.boxes.keepSpares();
  await until(async () => (await world.boxes.list(SPARES)).some((spare) => spare.id !== first!.id && spare.state === "stopped"));
  assert.ok(!(await world.boxes.list(SPARES)).some((spare) => spare.id === first!.id));
  assert.match(logs.join("\n"), /it has waited stopped for 7 hours, longer than .+ restores a saved linux VM reliably, 6 hours/);
  assert.deepEqual(world.errors, []);
});

test("the doctor says spares are off for a kind with a device, and what one costs; a kind with none and no device says nothing (063)", async () => {
  const world = setup({ keepsSession: (kind) => kind === "linux" });
  assert.deepEqual(await world.boxes.spareChecks(), []);
  world.testDevice = true;
  const checks = await world.boxes.spareChecks();
  const linux = checks.find((check) => check.id === "spares.linux");
  assert.deepEqual(linux, {
    id: "spares.linux",
    name: "Spare linux boxes",
    status: "ok",
    detail: "Spares are off for linux boxes: none is kept. A spare waits stopped with its session saved: it holds no memory, and its saved memory takes disk, at most a little over its 4 GiB of memory, besides its own disk.",
    fix: null,
  });
  world.testDevice = false;
  world.general = { ...world.general, spares: { linux: 2 } };
  const [kept] = await world.boxes.spareChecks();
  assert.equal(kept!.detail, "bb-box keeps 2 spare linux boxes: 0 ready, 0 being made. A spare waits stopped with its session saved: it holds no memory, and its saved memory takes disk, at most a little over its 4 GiB of memory, besides its own disk.");
});

test("a claim of a spare tells the plugin once the box is the thread's, after a spare that waited stopped has started (063)", async () => {
  const claimed: string[] = [];
  const world = setup({ keepsSession: () => true }, { spareClaimed: (box) => claimed.push(`${box.threadId} ${box.state} ${box.askedDevice ?? "default"}`) });
  world.general = { ...world.general, spares: { linux: 1 } };
  await world.boxes.keepSpares();
  await world.boxes.idle();
  await until(async () => (await world.boxes.list(SPARES))[0]?.state === "stopped");
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  assert.notEqual(box.timings.spare, undefined);
  await until(async () => claimed.length === 1);
  assert.deepEqual(claimed, [`${THREAD} ready default`]);
});

test("each resize is logged with the box, from and to, how, who asked and how long it took, and each refusal and failure with why (061)", async () => {
  const logs: string[] = [];
  const world = setup({}, { log: (line) => logs.push(line), reconnect: async (box) => void world.reconnected.push(box.id) });
  world.backend.resizeWays = { cores: "restart", memory: "restart", disk: "live", shrinks: true };
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
  const resized = (line: string) => logs.filter((entry) => entry.includes(line));

  await world.boxes.resize(THREAD, box.name, { diskGiB: 30 }, { by: "the tool" });
  assert.match(resized("Resized")[0]!, new RegExp(`^Resized box ${box.name} of thread ${THREAD} from 2 cores, 4 GiB memory to 2 cores, 4 GiB memory, 30 GiB disk, live, as the tool asked, in \\d+ ms\\.$`));

  await assert.rejects(world.boxes.resize(THREAD, box.name, { cores: 4 }, { by: "the CLI" }), { code: "needs_restart" });
  assert.match(resized("Refused to resize")[0]!, new RegExp(`^Refused to resize box ${box.name} of thread ${THREAD}, as the CLI asked: Resizing box ${box.name} to 4 cores, 4 GiB memory, 30 GiB disk needs a restart for its cores`));
  assert.equal(await world.boxes.resize(THREAD, box.name, { cores: 4 }, { check: true }).then(() => logs.length), logs.length, "a check is not logged");

  // A restart: the box is starting while it is down, ready after, and its BB machine reconnects.
  const states: string[] = [];
  world.backend.boxResizeGate = (async () => {
    for (let i = 0; i < 50 && !states.length; i++) {
      const state = (await world.boxes.find(box.id))?.state;
      if (state === "starting") states.push(state);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  })();
  const restarted = await world.boxes.resize(THREAD, box.name, { cores: 4 }, { restart: true, by: "the panel" });
  world.backend.boxResizeGate = null;
  assert.deepEqual([states, restarted.box.state], [["starting"], "ready"]);
  assert.match(resized("with a restart, as the panel asked")[0]!, /^Resized box .* to 4 cores, 4 GiB memory, 30 GiB disk, with a restart, as the panel asked, in \d+ ms\.$/);
  await world.boxes.idle();

  world.backend.resizeFault = new Error("The provider said no.");
  await assert.rejects(world.boxes.resize(THREAD, box.name, { diskGiB: 40 }, { by: "the tool" }), /The provider said no/);
  assert.equal(resized("Could not resize")[0], `Could not resize box ${box.name} of thread ${THREAD}, as the tool asked: The provider said no.`);
});

test("box_list's resize line names only the providers that resize, and says once that the others cannot (061)", () => {
  const offer = (name: string, resizing?: KindView["offers"][number]["resizing"]) => ({ name, ...(resizing ? { resizing } : {}) }) as KindView["offers"][number];
  const kind = (...offers: KindView["offers"][number][]) => ({ offers }) as unknown as KindView;
  const lxc = { cores: "live", memory: "live", disk: "live", shrinks: true } as const;
  const docker = { cores: "live", memory: "live", disk: "no", shrinks: true } as const;
  assert.equal(kindResizeText(kind(offer("Pool"))), "");
  assert.equal(kindResizeText(kind(offer("Proxmox LXC on pve", lxc))), "Resize: cores, memory and disk live, the disk only growing.");
  assert.equal(
    kindResizeText(kind(offer("Proxmox LXC on pve", lxc), offer("Pool"), offer("Docker on devpc", docker), offer("microsandbox on devpc"))),
    "Resize: on Proxmox LXC on pve, cores, memory and disk live, the disk only growing; on Docker on devpc, cores and memory live; the other providers cannot.",
  );
  assert.equal(kindResizeText(kind(offer("Docker on a", docker), offer("Pool"))), "Resize: on Docker on a, cores and memory live; the other provider cannot.");
});

test("a restart's estimate comes from the box's own last restart resize, or else its last start when it was a boot, rounded up, and the backend's guess without either (061)", async () => {
  const world = setup();
  world.backend.resizeWays = { cores: "restart", memory: "restart", disk: "live", shrinks: true };
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.idle();
  const down = async () => (await world.boxes.resize(THREAD, box.name, { cores: 4 }, { check: true })).plan?.downSeconds;
  assert.equal(await down(), 8, "the backend's guess, with no figure of the box's own");
  // A start that was a boot: twice over, for the shutdown before it.
  await world.boxes.update(box, () => ({ timings: { "start.boot": 4_000, "start.total": 4_800 } }));
  assert.equal(await down(), 10);
  // A resume says nothing of a boot.
  await world.boxes.update(box, () => ({ timings: { "start.resume": 1_500, "start.total": 1_800 } }));
  assert.equal(await down(), 8);
  // A restart resize it had: what it took, with a fifth more, rounded up.
  const size = { cores: 2, memoryMiB: 4096, diskGiB: null };
  const last = { from: size, to: size, at: 1, state: "done" as const, ms: 9_600, restart: true, error: null };
  await world.boxes.update(box, () => ({ resize: last }));
  assert.equal(await down(), 12);
  assert.equal(restartSeconds({ ...box, resize: { ...last, restart: false } }, false), null, "a live resize says nothing of a restart");
  assert.equal(restartSeconds({ ...box, resize: null, timings: { "start.total": 4_000 } }, true), null, "a backend whose stop keeps the session resumes, unless its timings name a boot");
  assert.equal(restartSeconds({ ...box, resize: null, timings: { "start.total": 4_000, "start.boot": 3_000 } }, true), 8);
});

const ANDROID_RUNTIME = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: null } as const;

function androidKind(...models: ("Pixel 8" | "Pixel Fold" | "Pixel Tablet")[]): BoxKind {
  const [first, ...rest] = models.map((model) => ({ model, native: model.toLowerCase().replace(" ", "_"), runtime: ANDROID_RUNTIME }));
  return {
    ...FAKE_KINDS[0]!,
    id: "android",
    label: "Android emulator",
    capabilities: { ...FAKE_KINDS[0]!.capabilities, displays: [{ id: "device", shows: "device", protocol: "selkies", resizable: false }], device: { platform: "android", devices: [first!, ...rest] } },
  };
}

const IOS_RUNTIME = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" } as const;

function iosKind(): BoxKind {
  return {
    ...FAKE_KINDS[0]!,
    id: "ios",
    label: "iOS Simulator",
    capabilities: {
      ...FAKE_KINDS[0]!.capabilities,
      displays: [{ id: "device", shows: "device", protocol: "selkies", resizable: false }],
      device: { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: IOS_RUNTIME }] },
    },
  };
}

const refusedWith = (code: string, words: RegExp) => (error: unknown) => {
  assert.ok(error instanceof BoxError, String(error));
  assert.equal(error.code, code);
  assert.match(error.message, words);
  return true;
};

test("an acquire of a device kind no backend offers is refused, naming no offer, and device is refused on other kinds and for unknown models (063)", async () => {
  const world = setup();
  const acquire = (kind: string, device?: string) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind, ...(device !== undefined ? { device } : {}) });
  await assert.rejects(acquire("ios"), refusedWith("unknown_kind", /^No backend offers ios boxes \(iOS Simulator\) now\. The kinds you can acquire are: linux, linux-desktop\.$/));
  await assert.rejects(acquire("android"), refusedWith("unknown_kind", /^No backend offers android boxes \(Android emulator\) now\./));
  await assert.rejects(acquire("ios", "iphone 18 pro"), refusedWith("unknown_kind", /^No backend offers ios boxes/));
  await assert.rejects(acquire("linux", "iPhone 18 Pro"), refusedWith("unsupported", /^A linux box has no device\. device is only for ios and android boxes, such as iPhone 18 Pro or Pixel 8\.$/));
  await assert.rejects(acquire("linux-docker", "Pixel 8"), refusedWith("unsupported", /^A linux box has no device\./));
  await assert.rejects(acquire("windows-desktop", "Pixel 8"), refusedWith("unsupported", /^A windows-desktop box has no device\./));
  await assert.rejects(acquire("ios", "Pixel 8"), refusedWith("unknown_device", /^The Pixel 8 is an Android device, not an iOS one\. The iOS devices are: iPhone 18 Pro, iPhone 17, iPad Pro 13-inch \(M5\)\.$/));
  await assert.rejects(acquire("android", "Pixel 99"), refusedWith("unknown_device", /^There is no Android device called "Pixel 99"\./));
  await assert.rejects(acquire("no-such-kind", "Pixel 8"), refusedWith("unknown_kind", /^There is no "no-such-kind" kind\./));
  assert.deepEqual(await world.boxes.list(THREAD), [], "nothing was recorded");
});

test("an acquire of a kind a backend withholds until it has read what decides it waits for that read, then is refused for room as any kind is, or told why the backend still withholds it (063)", async () => {
  const world = setup();
  const mac = new FakeBackend({ root: tempDir("boxes-mac"), storage: scopedStorage(world.kv, "backend/fake:mac/"), id: "fake:mac", hosts: ["mac1"], kinds: [iosKind()], maxGuests: 0 });
  const allKinds = mac.kinds.bind(mac);
  let read: WithheldKind | null = null;
  let declared = false;
  const withholding = Object.assign(mac, {
    kinds: () => (declared ? allKinds() : allKinds().filter((kind) => kind.id !== "ios")),
    withheldKinds: async (): Promise<WithheldKind[]> => {
      if (declared) return [];
      if (!read) declared = true;
      return read ? [read] : [];
    },
  });
  world.others = [withholding as unknown as Backend];
  const acquire = () => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" });
  await assert.rejects(acquire(), refusedWith("no_capacity", /^The fake host holds 0 guests at most\. Release a box to make room\.$/));
  declared = false;
  read = { kind: "ios", why: "mac1 did not answer: ssh timed out.", passing: true };
  await assert.rejects(acquire(), refusedWith("no_capacity", /^No ios box \(iOS Simulator\) can come now\. Fake host on mac1 offers them, but not now: mac1 did not answer: ssh timed out\.$/));
  read = { kind: "ios", why: "its image lists no iOS devices.", passing: false };
  await assert.rejects(acquire(), refusedWith("unknown_kind", /^No ios box \(iOS Simulator\) can come now\. Fake host on mac1 offers them, but not now: its image lists no iOS devices\.$/));
  world.others = [];
  await assert.rejects(acquire(), refusedWith("unknown_kind", /^No backend offers ios boxes \(iOS Simulator\) now\./), "a kind no backend is set up for is still no backend's");
  assert.deepEqual(await world.boxes.list(THREAD), [], "nothing was recorded");
});

test("box_list's kinds wait, as acquire does, for a backend's read of a kind it withholds until then: offered once read, being checked while the read goes on, and otherwise withheld with why", async () => {
  const world = setup();
  const mac = new FakeBackend({ root: tempDir("boxes-mac-list"), storage: scopedStorage(world.kv, "backend/fake:mac/"), id: "fake:mac", hosts: ["mac1"], kinds: [iosKind()] });
  const allKinds = mac.kinds.bind(mac);
  let declared = false;
  let read: () => Promise<WithheldKind[]> = async () => {
    declared = true;
    return [];
  };
  world.others = [Object.assign(mac, { kinds: () => (declared ? allKinds() : allKinds().filter((kind) => kind.id !== "ios")), withheldKinds: async (kind: string) => (kind === "ios" ? read() : []) }) as unknown as Backend];
  assert.equal(world.boxes.kinds().some((kind) => kind.id === "ios"), false, "before the Mac's read");
  assert.deepEqual(await world.boxes.withheldKinds(1_000), []);
  assert.equal(world.boxes.kinds().some((kind) => kind.id === "ios"), true, "offered once read");

  declared = false;
  read = () => new Promise(() => undefined);
  assert.deepEqual(await world.boxes.withheldKinds(50), [{ kind: "ios", label: "iOS Simulator", words: "Being checked: bb-box is still reading whether its backends can make them now. Call box_list again in a few seconds" }]);
  read = async () => [{ kind: "ios", why: "mac1 did not answer: ssh timed out.", passing: true }];
  assert.deepEqual(await world.boxes.withheldKinds(1_000), [{ kind: "ios", label: "iOS Simulator", words: "Not now: Fake host on mac1 offers them, but not now: mac1 did not answer: ssh timed out." }]);
});

test("an acquire with a device tries only the offers whose image has it, and the box keeps what it asked for (063)", async () => {
  const world = setup({ kinds: [androidKind("Pixel 8")] });
  world.others = [new FakeBackend({ root: tempDir("boxes-fold"), storage: scopedStorage(world.kv, "backend/fake:fold/"), id: "fake:fold", hosts: ["lab"], kinds: [androidKind("Pixel 8", "Pixel Fold")] }) as unknown as Backend];
  const acquire = (device?: string) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "android", ...(device !== undefined ? { device } : {}) });
  const plain = await acquire();
  assert.equal(plain.backend, world.backend.id, "with no device, the first offer");
  assert.equal(plain.askedDevice, undefined);
  const fold = await acquire("pixel fold");
  assert.equal(fold.backend, "fake:fold", "only the offer with the Pixel Fold");
  assert.equal(fold.askedDevice, "Pixel Fold");
  assert.equal((await world.boxes.get(THREAD, fold.name)).askedDevice, "Pixel Fold", "as stored");
  await assert.rejects(acquire("Pixel Tablet"), refusedWith("unknown_device", /^No backend offers the Pixel Tablet now\. The android devices offered are: Pixel 8, Pixel Fold\.$/));
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "android", device: "Pixel Fold", on: world.backend.id }), refusedWith("unknown_device", /^Fake host has no Pixel Fold\. The Pixel Fold comes from: Fake host on lab\. Leave "on" out for the first with room\.$/));
  assert.equal((await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "android", device: "Pixel 8", on: world.backend.id })).backend, world.backend.id);
  await world.boxes.idle();
});

test("a stored box's device data is read through its validators: what does not read is dropped, and a record from before devices has none (063)", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  const key = `box/${THREAD}/${box.id}`;
  const stored = (await world.kv.get<BoxRecord>(key))!;
  const { device: _, ...before } = stored.capabilities;
  await world.kv.set(key, { ...stored, capabilities: before });
  assert.equal((await world.boxes.get(THREAD, box.id)).capabilities.device, null, "a record from before devices");
  const good = { platform: "android", model: "Pixel 8", runtime: ANDROID_RUNTIME } as const;
  await world.kv.set(key, { ...stored, device: good, askedDevice: "Pixel 8" });
  const read = await world.boxes.get(THREAD, box.id);
  assert.deepEqual([read.device, read.askedDevice], [good, "Pixel 8"]);
  await world.kv.set(key, { ...stored, capabilities: { ...stored.capabilities, device: { platform: "ios", devices: [] } }, device: { ...good, model: "Pixel 99" }, askedDevice: "Pixel 99" });
  const dropped = await world.boxes.get(THREAD, box.id);
  assert.deepEqual([dropped.capabilities.device, dropped.device, dropped.askedDevice], [null, null, undefined]);
  await world.boxes.idle();
});

test("with the test device on, a linux box asked for the Test device keeps it through a placement and a refresh of its capabilities (063)", async () => {
  const world = setup();
  world.testDevice = true;
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: "t1", projectId: null, kind: "linux", device: "Test device" }));
  assert.equal(box.askedDevice, "Pixel 8");
  assert.deepEqual(box.capabilities.device, testDeviceOffer("android"));
  await world.boxes.refreshCapabilities();
  assert.deepEqual((await world.boxes.find(box.id))?.capabilities.device, testDeviceOffer("android"));
  world.testDevice = false;
  await assert.rejects(world.boxes.acquire({ threadId: "t1", projectId: null, kind: "linux", device: "Test device" }), (error: unknown) => error instanceof BoxError && error.code === "unsupported");
});

test("an ios box is slim unless it asks for slim false, which it keeps; slim is refused on every other kind (063, 3.2)", async () => {
  const world = setup({ kinds: [iosKind(), androidKind("Pixel 8")] });
  const acquire = (kind: string, slim?: boolean) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind, ...(slim !== undefined ? { slim } : {}) });
  const slim = await acquire("ios");
  assert.equal(slim.slim, true, "slim by default");
  const stock = await acquire("ios", false);
  assert.equal(stock.slim, false);
  assert.equal((await world.boxes.get(THREAD, stock.name)).slim, false, "as stored");
  assert.equal((await acquire("android")).slim, undefined, "an android box carries no slim");
  await assert.rejects(acquire("android", false), refusedWith("unsupported", /^slim is only for ios boxes, .* Boxes of kind android have no such device\.$/));
  await assert.rejects(acquire("linux", true), refusedWith("unsupported", /Boxes of kind linux have no such device\.$/));
});

test("a stored slim that is not true or false is dropped where records are read, and the rest of the record kept (063, 3.2)", () => {
  const box = { kind: "ios", askedDevice: "iPhone 17", slim: "yes", capabilities: { device: null } } as unknown as BoxRecord;
  const checked = withDeviceChecked(box);
  assert.equal(checked.slim, undefined);
  assert.equal(checked.askedDevice, "iPhone 17");
  assert.equal(withDeviceChecked({ ...box, slim: false } as unknown as BoxRecord).slim, false);
});

function sharedIosKind(): BoxKind {
  const kind = iosKind();
  return {
    ...kind,
    capabilities: {
      ...kind.capabilities,
      command: { ...kind.capabilities.command!, admin: true },
      displays: [{ id: "desktop", protocol: "rfb", resizable: false }, DEVICE_DISPLAY],
    },
  };
}

const SLOT_THREE: SlotPlacement = { on: "slot", host: "bb-box-host-1", hostOn: "tart", carried: false, generation: 7, place: 2, most: 8 };

function lendingSlots(backend: FakeBackend, placement: SlotPlacement): void {
  const acquire = backend.acquire.bind(backend);
  const inSlot = (guest: Guest): Guest => ({ ...guest, data: { ...guest.data, ...placementData(placement) } });
  backend.acquire = async (box, previous, hooks, signal) => inSlot(await acquire(box, previous, { ...hooks, claim: (guest) => hooks.claim(inSlot(guest)) }, signal));
}

test("with the switch off, an ios size without dedicated is today's box, a VM of its own at that size, and box_list says no more of a size (064, unit 2)", async () => {
  const world = setup({ kinds: [sharedIosKind()] }, { sharedIosByDefault: false });
  assert.equal(world.boxes.sharedHosts().byDefault, false);
  const sized = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", size: { preset: "large" } }));
  assert.equal(sized.state, "ready");
  assert.deepEqual(placementOf(sized), { on: "vm" });
  assert.equal(sized.size?.cores, 8);
  const [kind] = kindViews(world.boxes.kinds().map((each) => ({ kind: each, backend: world.backend })), {}, {}, {}, {}, {}, undefined, {}, world.boxes.sharedHostsByKind());
  assert.equal(placementText(kind!), " Each box is a macOS VM of its own, with sudo, brew install and its own cores, ports and desktop; dedicated: true asks for one. No shared iOS host is set up, so shared ios boxes, a macOS user on a Mac or VM shared with other ios boxes, are not offered yet.");
});

test("an ios box with dedicated true is today's box, a VM of its own; with shared the default but no shared host set up, a size needs no dedicated; dedicated and shared are refused where they do not apply (064, units 2 and 6)", async () => {
  const world = setup({ kinds: [sharedIosKind(), FAKE_KINDS[0]!, { ...FAKE_KINDS[0]!, id: "macos", label: "macOS" }] }, { sharedIosByDefault: true });
  const [kind] = kindViews(world.boxes.kinds().filter((each) => each.id === "ios").map((each) => ({ kind: each, backend: world.backend })), {}, {}, {}, {}, {}, undefined, {}, world.boxes.sharedHostsByKind());
  assert.match(placementText(kind!), /; dedicated: true asks for one\. No shared iOS host is set up/);
  const acquire = (kind: string, more: { dedicated?: boolean; shared?: boolean; size?: { preset?: string; cores?: number } } = {}) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind, ...more });
  const dedicated = await ready(world.boxes, await acquire("ios", { dedicated: true, size: { preset: "large" } }));
  assert.equal(dedicated.state, "ready");
  assert.deepEqual(placementOf(dedicated), { on: "vm" });
  assert.equal(dedicated.capabilities.command?.admin, true, "the offer's capabilities, as today");
  assert.equal(dedicated.size?.cores, 8, "the size asked for");
  assert.match(boxDetail(dedicated), /\nWhere: A VM of its own\.\nSize: 8 cores/);
  assert.equal(world.boxes.canStopStart(dedicated), true);
  const plain = await ready(world.boxes, await acquire("ios"));
  assert.deepEqual(placementOf(plain), { on: "vm" }, "with no shared host set up, an ios box is a VM of its own");
  const sized = await ready(world.boxes, await acquire("ios", { size: { preset: "large" } }));
  assert.deepEqual(placementOf(sized), { on: "vm" }, "with no shared host set up, a size needs no dedicated");
  assert.equal(sized.size?.cores, 8);
  await assert.rejects(acquire("ios", { shared: true }), refusedWith("no_capacity", /^No shared iOS host is set up, so an ios box cannot have a slot on one yet\. Leave shared out, or ask for dedicated: true, for a VM of its own\.$/));
  await assert.rejects(acquire("macos", { shared: true }), refusedWith("no_capacity", /^No shared iOS host is set up, so a macos box cannot have a slot on one yet\. Leave shared out for a VM of its own\.$/));
  await assert.rejects(acquire("ios", { dedicated: true, shared: true }), refusedWith("unsupported", /^Ask for dedicated or shared, not both/));
  await assert.rejects(acquire("macos", { dedicated: true }), refusedWith("unsupported", /^dedicated is only for ios boxes.* A macos box is a machine of its own already\.$/));
  await assert.rejects(acquire("linux", { shared: true }), refusedWith("unsupported", /^shared is only for ios and macos boxes.* A linux box cannot\.$/));
  const machine = await world.boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "ios", size: { preset: "large" } });
  assert.deepEqual(placementOf(machine), { on: "vm" }, "one of your machines is a VM of its own, so its size needs no dedicated");
});

test("a box in a slot has the slot's capabilities, says where it is, and refuses a stop, a start, a resize, a restart and a grant in words naming dedicated (064, unit 2)", async () => {
  const world = setup({ kinds: [sharedIosKind()] });
  lendingSlots(world.backend, SLOT_THREE);
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }));
  assert.equal(box.state, "ready");
  assert.deepEqual(placementOf(box), SLOT_THREE, "held once, in guest.data");
  const stored = await world.boxes.get(THREAD, box.name);
  assert.equal(stored.capabilities.command?.admin, false, "no root in a slot");
  assert.deepEqual(stored.capabilities.displays, [DEVICE_DISPLAY], "the device, but not the host's desktop");
  assert.equal(stored.capabilities.computerUse, null);
  assert.equal(stored.capabilities.enrol, true, "a slot box still joins BB");
  const detail = boxDetail(stored);
  assert.match(detail, /\nWhere: On a shared iOS host \(a Tart VM\), slot 3 of 8\. Ports 20200 to 20299, in BB_PORT_BASE and BB_PORT_COUNT\.\n/);
  assert.match(detail, /\nRoot: no, the box user cannot use sudo or brew install on a shared host\. Ask for dedicated: true for a VM of its own\n/);
  assert.doesNotMatch(detail, /\nSize: /, "no size of its own");
  assert.equal(world.boxes.canStopStart(stored), false);
  assert.equal(boxView(stored, world.boxes.canStopStart(stored), { owner: "none", holder: null }).canStopStart, false);
  await assert.rejects(world.boxes.stop(THREAD, box.name), refusedWith("unsupported", /^A shared ios box cannot be stopped on its own: it shares its host with other boxes\. Release it, or ask for dedicated\.$/));
  await assert.rejects(world.boxes.start(THREAD, box.name), refusedWith("unsupported", /^A shared ios box cannot be stopped on its own/));
  await assert.rejects(world.boxes.resize(THREAD, box.name, { preset: "large" }), refusedWith("unsupported", /^A shared ios box has no size of its own, so it cannot be resized\. Release it, and ask for dedicated: true with a size\.$/));
  await assert.rejects(world.boxes.resize(THREAD, box.name, { preset: "large" }, { restart: true }), refusedWith("unsupported", /^A shared ios box cannot be restarted on its own.* box_device reboot reboots its device\.$/));
  await assert.rejects(world.boxes.grant(THREAD, box.name, { program: "/bin/sh", permissions: ["accessibility"] }), refusedWith("unsupported", /^A shared ios box has no console session.*Ask for dedicated: true for a VM of its own\.$/));
  assert.deepEqual(world.errors, []);
});

test("with a backend lending slots, shared: true places an ios box in a slot: three asked for at once share one host, a ninth waits with words, and the last release deletes the host (064, unit 4)", async () => {
  const world = setup({ kinds: [sharedIosKind(), { ...FAKE_KINDS[0]!, id: "macos", label: "macOS" }], slots: { kinds: ["ios"], most: 8 } }, { sharedIosByDefault: false });
  assert.deepEqual(world.boxes.sharedHosts(), { on: true, why: null, byDefault: false });
  const [kind] = kindViews(world.boxes.kinds().filter((each) => each.id === "ios").map((each) => ({ kind: each, backend: world.backend })), {}, {}, {}, {}, {}, undefined, {}, world.boxes.sharedHostsByKind());
  assert.match(placementText(kind!), /unless it asks for shared: true: then a macOS user on a Mac or VM shared with other ios boxes, ready in seconds/);
  const shared = () => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true });
  const three = await Promise.all([shared(), shared(), shared()]);
  assert.equal(world.backend.hostsMade, 1, "one host for three boxes asked for at once");
  assert.deepEqual(world.backend.calls.filter((call) => call.startsWith("take ")).map((call) => call.split(" ")[1]), ["new-host", "ready", "ready"]);
  const placed = await Promise.all(three.map((box) => ready(world.boxes, box)));
  assert.deepEqual(placed.map((box) => box.state), ["ready", "ready", "ready"]);
  assert.deepEqual(new Set(placed.map((box) => (placementOf(box).on === "slot" ? (placementOf(box) as SlotPlacement).place : -1))), new Set([0, 1, 2]));
  assert.ok(placed.every((box) => box.capabilities.command?.admin === false), "slot capabilities from the claim");
  for (let n = 3; n < 8; n++) await ready(world.boxes, await shared());
  await assert.rejects(shared(), refusedWith("no_capacity", /^The shared host fake-host-1 has all its 8 slots held\.$/));
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true, size: { preset: "large" } }), refusedWith("invalid_size", /^A shared ios box has no size of its own/));
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true }), refusedWith("no_capacity", /^No shared iOS host is set up, so a macos box cannot have a slot on one yet\./));
  const plain = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }));
  assert.deepEqual(placementOf(plain), { on: "vm" }, "with the switch off, shared is opt-in");
  for (const box of await world.boxes.list(THREAD)) if (inSlot(box)) await world.boxes.release(THREAD, box.name, "the test is done with it");
  await until(async () => (await world.boxes.list(THREAD)).every((box) => !inSlot(box) || box.state === "gone" || box.state === "failed"));
  assert.equal(world.backend.hostsDeleted, 1);
});

test("with shared the default, an ios box asked for with nothing else takes a slot where a lender has room and a VM of its own otherwise; a size needs dedicated; slim false and dedicated are VMs of their own (064, unit 6)", async () => {
  const logs: string[] = [];
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 2 } }, { log: (line) => logs.push(line) });
  assert.equal(SHARED_IOS_BY_DEFAULT, true);
  assert.deepEqual(world.boxes.sharedHosts(), { on: true, why: null, byDefault: true });
  const [kind] = kindViews(world.boxes.kinds().map((each) => ({ kind: each, backend: world.backend })), {}, {}, {}, {}, {}, undefined, {}, world.boxes.sharedHostsByKind());
  assert.equal(kind!.placement?.sizeNeedsDedicated, true);
  assert.match(placementText(kind!), /^ Shared by default: a macOS user on a Mac or VM shared with other ios boxes, ready in seconds, .*; where no shared iOS host has room, a VM of its own\. .* Ask for dedicated: true for a VM of its own, .*; a size needs it\./);
  const acquire = (more: { dedicated?: boolean; shared?: boolean; slim?: boolean; size?: { preset?: string } } = {}) => world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", ...more });
  const first = await ready(world.boxes, await acquire());
  assert.equal(placementOf(first).on, "slot");
  assert.equal(first.capabilities.command?.admin, false);
  assert.match(boxDetail(first), /\nWhere: On a shared iOS host \(a Tart VM\), slot 1 of 2\./);
  const second = await ready(world.boxes, await acquire());
  assert.equal(placementOf(second).on, "slot");
  const third = await ready(world.boxes, await acquire());
  assert.deepEqual(placementOf(third), { on: "vm" }, "the host is full, so a VM of its own");
  assert.equal(third.capabilities.command?.admin, true);
  await assert.rejects(acquire({ shared: true }), refusedWith("no_capacity", /^The shared host fake-host-1 has all its 2 slots held\.$/), "shared: true still refuses rather than give a VM");
  await assert.rejects(acquire({ size: { preset: "large" } }), refusedWith("invalid_size", /^A shared ios box has no size of its own\. Ask for dedicated: true with a size\.$/));
  await world.boxes.release(THREAD, first.name, "the test is done with it");
  await until(async () => (await world.boxes.get(THREAD, first.name).catch(() => null))?.state !== "releasing");
  const unslim = await ready(world.boxes, await acquire({ slim: false }));
  assert.deepEqual(placementOf(unslim), { on: "vm" }, "a slot's device is always slim");
  const dedicated = await ready(world.boxes, await acquire({ dedicated: true, size: { preset: "large" } }));
  assert.deepEqual(placementOf(dedicated), { on: "vm" });
  assert.equal(dedicated.size?.cores, 8);
  const again = await ready(world.boxes, await acquire());
  assert.equal(placementOf(again).on, "slot", "the slot freed by the release");
  assert.ok(logs.some((line) => /found no slot on a shared iOS host, so bb-box looks for a VM of its own: The shared host fake-host-1 has all its 2 slots held\./.test(line)), logs.join("\n"));
});

test("with shared the default, an ios box that finds neither a slot nor a VM is refused with both reasons (064, unit 6)", async () => {
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 1 }, maxGuests: 0 });
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }));
  assert.equal(placementOf(first).on, "slot");
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }), refusedWith("no_capacity", /^No shared iOS host had a slot: The shared host fake-host-1 has all its 1 slots held\. And no VM of its own could be had: /));
});

test("a take that loses its race is asked again, three times, then the box is refused with what each lost to (064, unit 4)", async () => {
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 8 } });
  world.backend.takeLosses = 2;
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true }));
  assert.equal(placementOf(box).on, "slot", "placed again after two lost races");
  assert.equal(world.backend.calls.filter((call) => call.startsWith("offer ")).length, 3);
  world.backend.takeLosses = 3;
  await assert.rejects(
    world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true }),
    refusedWith("no_capacity", /^Every shared iOS host bb-box asked had its room taken first, 3 times, so this ios box has no slot: Another box claimed it first\. Another box claimed it first\. Another box claimed it first\. Ask again\.$/),
  );
});

test("a box in a slot has its placement on a shared host in its timings, which its total counts (F-7)", async () => {
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 8 } }, { sharedIosByDefault: false });
  world.backend.takeLosses = 1;
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true }));
  assert.equal(typeof box.timings["shared-host"], "number");
  assert.ok(box.timings.total! >= box.timings["shared-host"]!);
  assert.match(boxDetail(box), /\nTimings: choosing a shared host \d+ ms, /);
  const plain = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }));
  assert.equal(plain.timings["shared-host"], undefined, "a VM of its own is placed as before");
});

test("a box in a slot whose host's VM stopped, as after its Mac restarted, is started again by bb-box, though a person's start is refused (064, unit 4)", async () => {
  const world = setup({ kinds: [sharedIosKind()], slots: { kinds: ["ios"], most: 8 } });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true }));
  assert.equal(placementOf(box).on, "slot");
  world.backend.stopReason = { reason: "The shared iOS host's VM is not running, as after its Mac restarted.", crashed: true, at: null };
  await world.backend.stop!(box.guest!);
  const found = await world.boxes.refresh(THREAD, box.name);
  assert.equal(found.state, "stopped");
  assert.ok(found.unrequestedStop!.restart);
  const restarted = await world.boxes.settled(box);
  assert.equal(restarted!.state, "ready");
  assert.match(boxDetail(restarted!), /bb-box started it again at .* UTC\./);
  await world.backend.stop!(box.guest!);
  await assert.rejects(world.boxes.start(THREAD, box.name), refusedWith("unsupported", /^A shared ios box cannot be stopped on its own/));
});

function sharedMacosKind(): BoxKind {
  return { ...FAKE_KINDS[0]!, id: "macos", label: "macOS", capabilities: { ...FAKE_KINDS[0]!.capabilities, command: { ...FAKE_KINDS[0]!.capabilities.command!, admin: true } } };
}

test("with a backend lending slots, shared: true places a macos box in a slot in seconds, with no root, desktop or grants, each refusal naming what to ask for instead (064, unit 8)", async () => {
  const world = setup({ kinds: [sharedIosKind(), sharedMacosKind()], slots: { kinds: ["ios", "macos"], most: 8 } });
  assert.deepEqual(world.boxes.sharedHosts("macos"), { on: true, why: null, byDefault: false });
  const macos = kindViews(world.boxes.kinds().map((each) => ({ kind: each, backend: world.backend })), {}, {}, {}, {}, {}, undefined, {}, world.boxes.sharedHostsByKind()).find((each) => each.id === "macos")!;
  assert.equal(
    placementText(macos),
    " Each box is a macOS VM of its own, with sudo, brew install and its own cores and ports, unless it asks for shared: true: then a macOS user on a Mac or VM shared with ios boxes, ready in seconds, for commands, builds and the iOS Simulator, with its own files and keychain, but no sudo, Homebrew installs, desktop or app windows, and cores, ports and processes shared. Servers on localhost are reachable from every box on the host: use your box's ports, from BB_PORT_BASE.",
  );
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true }));
  assert.equal(box.state, "ready");
  assert.equal(placementOf(box).on, "slot");
  assert.ok(world.backend.calls.includes("offer macos"));
  assert.equal(box.capabilities.command?.admin, false, "no root in a slot");
  assert.deepEqual(box.capabilities.displays, [], "no desktop");
  assert.equal(box.capabilities.computerUse, null);
  assert.equal(box.capabilities.device, null, "no device: the slot's is deleted at the claim");
  const detail = boxDetail(box);
  assert.match(detail, /\nWhere: On a shared iOS host \(a Tart VM\), slot 1 of 8\. Ports 20000 to 20099, in BB_PORT_BASE and BB_PORT_COUNT\.\n/);
  assert.match(detail, /\nRoot: no, the box user cannot use sudo or brew install on a shared host\. Acquire a macos box without shared for a VM of its own\n/);
  assert.match(detail, /\nDesktop: none\. A shared macos box has no console session: no app windows, screenshots, computer use or macOS permission grants\. Acquire a macos box without shared for a VM of its own\n/);
  assert.doesNotMatch(detail, /\nSize: /);
  assert.doesNotMatch(detail, /dedicated/, "dedicated is for ios boxes only");
  assert.match(detail, /\nForm: a macOS user on a shared iOS host\n/);
  assert.match(boxLine(box), /^- [a-z-]+: macOS \(macos\), ready/, "box_list gives a slot box no size");
  const view = boxView(box, world.boxes.canStopStart(box), { owner: "none", holder: null });
  assert.deepEqual([view.size, view.form], [null, null], "the panel shows a slot box no size and no VM badge");
  assert.equal(world.boxes.canStopStart(box), false);
  await assert.rejects(world.boxes.stop(THREAD, box.name), refusedWith("unsupported", /^A shared macos box cannot be stopped on its own: it shares its host with other boxes\. Release it, or acquire a macos box without shared for a VM of its own\.$/));
  await assert.rejects(world.boxes.resize(THREAD, box.name, { preset: "large" }), refusedWith("unsupported", /^A shared macos box has no size of its own, so it cannot be resized\. Release it, and acquire a macos box without shared, with a size\.$/));
  await assert.rejects(world.boxes.resize(THREAD, box.name, { preset: "large" }, { restart: true }), refusedWith("unsupported", /^A shared macos box cannot be restarted on its own: it shares its host with other boxes\. Release it, or acquire a macos box without shared for a VM of its own\.$/));
  await assert.rejects(world.boxes.grant(THREAD, box.name, { program: "/bin/sh", permissions: ["accessibility"] }), refusedWith("unsupported", /^A shared macos box has no console session, so there is nothing to grant macOS permissions to\. Acquire a macos box without shared for a VM of its own, or macos-desktop for one with a desktop\.$/));
  await assert.rejects(world.boxes.run(THREAD, box.name, "true", { session: "desktop" }), refusedWith("unsupported", /^Box .* is a shared macos box, a macOS user on a shared iOS host with no console session: it has no desktop, so nothing it runs can open a window, take a screenshot or be driven by the computer tools\. Run commands without desktop, or acquire macos-desktop for a VM with a desktop\.$/));
  assert.equal((await world.boxes.run(THREAD, box.name, "echo built")).result.stdout, "built\n", "commands run");
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true, size: { preset: "large" } }), refusedWith("invalid_size", /^A shared macos box has no size of its own\. Leave shared out for a VM of its own at that size\.$/));
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true, dedicated: true }), refusedWith("unsupported", /^dedicated is only for ios boxes/));
  const plain = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos" }));
  assert.deepEqual(placementOf(plain), { on: "vm" }, "without shared, a macos box is a VM of its own");
  assert.equal(plain.capabilities.command?.admin, true);
  await world.boxes.release(THREAD, box.name, "the test is done with it");
  await until(async () => (await world.boxes.list(THREAD)).every((each) => !inSlot(each) || each.state === "gone"));
  assert.equal(world.backend.hostsDeleted, 1, "a host with only a macos box goes with it");
  assert.deepEqual(world.errors, []);
});

test("a macos box without shared that finds no VM is refused with the backend's words and told what shared gives, where a host lends slots (064, unit 8)", async () => {
  const world = setup({ kinds: [sharedIosKind(), sharedMacosKind()], slots: { kinds: ["ios", "macos"], most: 8 }, maxGuests: 1 }, { sharedIosByDefault: false });
  await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos" }));
  await assert.rejects(
    world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos" }),
    refusedWith("no_capacity", /^The fake host holds 1 guests at most\. Release a box to make room\. Or ask for shared: true: a macOS user on a Mac or VM shared with ios boxes, ready in seconds, .* and cores, ports and processes shared\.$/),
  );
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios" }), refusedWith("no_capacity", /^The fake host holds 1 guests at most\. Release a box to make room\.$/), "an ios box is not pointed at a macos slot");
  const placed = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true }));
  assert.equal(placementOf(placed).on, "slot", "shared still finds a slot");
  const lone = setup({ kinds: [sharedMacosKind()], maxGuests: 0 });
  await assert.rejects(lone.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos" }), refusedWith("no_capacity", /^The fake host holds 0 guests at most\. Release a box to make room\.$/), "no hint where no host lends slots");
  const view = kindViews(lone.boxes.kinds().map((each) => ({ kind: each, backend: lone.backend })), {}, {}, {}, {}, {}, undefined, {}, lone.boxes.sharedHostsByKind())[0]!;
  assert.equal(view.placement, null, "box_list and the New box form say nothing of shared for macos where no host lends slots");
});

test("a refresh of capabilities keeps a slot box's slot capabilities, for an ios and a macos box (064, unit 8)", async () => {
  const world = setup({ kinds: [sharedIosKind(), sharedMacosKind()], slots: { kinds: ["ios", "macos"], most: 8 } });
  const ios = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "ios", shared: true }));
  const macos = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "macos", shared: true }));
  await world.boxes.refreshCapabilities();
  for (const box of [ios, macos]) {
    const found = (await world.boxes.find(box.id))!;
    assert.equal(found.capabilities.command?.admin, false, `${box.kind}: no root after the refresh`);
    assert.ok(!found.capabilities.displays.some((display) => display.id === "desktop"), `${box.kind}: no desktop after the refresh`);
  }
});
