// The registry against the fake backend: acquire and release, limits and
// capacity, commands and copies, stop and start, and the sweep.

import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import { isEarlierKindId } from "../src/backends/kinds.ts";
import { BackendError, type Backend, type BoxSize, type ReleaseHooks } from "../src/backends/types.ts";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { BoxError, Boxes, extraFeatures, type BoxRecord, type BoxesDeps, type ThreadLiveness } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { ACCESS_CHECK_EXITS, MAC_DESKTOP_EXITS, accessCheck, accessSetup, accessSetupMs, canRunInDesktop, command, envScript } from "../src/core/in-box.ts";
import { parseSizeChanges } from "../src/core/sizes.ts";
import { adminText, boxDetail, boxView, kindViews } from "../src/plugin/views.ts";
import { FAKE_KINDS, FakeBackend, type FakeBackendOptions } from "./fake-backend.ts";
import { MemoryStorage, fakeDaemon, tempDir } from "./helpers.ts";

const THREAD = "thr_one";

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function setup(options: Omit<FakeBackendOptions, "root" | "storage"> = {}, deps: Pick<BoxesDeps, "access" | "enrolWaitMs" | "recorded" | "reconnect"> = {}) {
  const root = tempDir("boxes");
  const kv = new MemoryStorage();
  const backendStorage = scopedStorage(kv, "backend/fake/");
  const make = () => new FakeBackend({ root, storage: backendStorage, ...options });
  const world = {
    kv,
    backend: make() as FakeBackend,
    /** False when the backend is off in settings. */
    active: true,
    general: { perThreadLimit: null, enrol: true, sizes: {} } as GeneralConfig,
    threads: new Map<string, ThreadLiveness>(),
    notified: [] as string[],
    errors: [] as string[],
    enrolled: [] as string[],
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
  const backends = {
    get: (id: string): Backend | null => (world.active && id === world.backend.id ? world.backend : null),
    active: (): Backend[] => (world.active ? [world.backend] : []),
    kinds: () => (world.active ? world.backend.kinds().map((kind) => ({ kind, backend: world.backend as Backend })) : []),
  };
  const registry = () =>
    new Boxes({
      kv,
      backends,
      general: async () => world.general,
      notify: (threadId) => world.notified.push(threadId),
      thread: async (threadId) => world.threads.get(threadId) ?? "live",
      enrol: async (box, options) => {
        world.enrolled.push(options?.restored ? `${box.name}, restored` : box.name);
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
    const left = await world.boxes.release(THREAD, box.name);
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
    general: async () => ({ perThreadLimit: null, enrol: false, defaultKind: "linux", sizes: {} }),
    notify: () => {},
    thread: async () => "live",
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
  await boxes.releaseThread(THREAD);
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
    views.map((view) => [view.id, view.admin, adminText(view.admin)]),
    [
      ["linux", null, "Root: on some of its backends, through sudo; box_status says for each box."],
      ["linux-desktop", true, "Root: yes, through sudo without a password."],
    ],
  );
  assert.equal(adminText(false), "Root: no, the box user cannot use sudo.");
  const commandless = { ...FAKE_KINDS[0]!, capabilities: { ...FAKE_KINDS[0]!.capabilities, command: null } };
  assert.equal(kindViews([{ kind: commandless, backend: other }], {})[0]!.admin, false, "a kind without commands gives no root");
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

test("concurrent acquires from different threads never share the last room", async () => {
  const world = setup({ maxGuests: 2 });
  const results = await Promise.allSettled(
    ["a", "b", "c", "d"].map((thread) => world.boxes.acquire({ threadId: thread, projectId: null, kind: "linux" })),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
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
  const release = world.boxes.release(THREAD, box.name);
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
  assert.equal(accessCheck("windows", { names: ["GH_TOKEN"], parent: daemon.parent }), null);
  assert.equal(accessCheck("linux", { names: ["not a name"], parent: daemon.parent }), null);
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
    `640\n# Added by bb-box: the thread's environment and access, for SSH commands too.\nif [ -r "$HOME/.config/bb-box/env" ]; then . "$HOME/.config/bb-box/env"; fi\n\ncase $- in *i*) ;; *) return;; esac\nexport MINE=1\n${box.name}`,
  );
  assert.equal(accessSetup("windows"), null);

  // A date that cannot give nanoseconds leaves the time out, and the script's exit code as it was.
  const { result: untimed } = await world.boxes.run(THREAD, box.name, `date() { echo 1700000000N; }\n${accessSetup("linux")!}`);
  assert.deepEqual([untimed.exitCode, untimed.stdout, accessSetupMs(untimed.stdout)], [0, "", null]);
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
    `640\n# Added by bb-box: the thread's environment and access, for SSH commands too.\nif [ -r "$HOME/.config/bb-box/env" ]; then . "$HOME/.config/bb-box/env"; fi\n\nexport PATH="/opt/homebrew/bin:$PATH"\n`,
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
    const release = world.boxes.release(THREAD, box.name);
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

test("a guest deleted outside bb-box marks the box gone, and release still works", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  await world.backend.release(box.guest!, QUIET);
  const refreshed = await world.boxes.refresh(THREAD, box.name);
  assert.equal(refreshed.state, "gone");
  assert.match(refreshed.error!, /deleted outside bb-box/);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /no longer exists/);
  assert.equal(await world.boxes.release(THREAD, box.name), null);
  assert.deepEqual(await world.boxes.list(THREAD), []);
});

test("release removes the BB machine first, then the guest", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(await world.boxes.release(THREAD, box.name), null);
  assert.deepEqual(world.unenrolled, [`host-${box.id}`]);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal(await world.boxes.find(box.id), null);
  await assert.rejects(world.boxes.release(THREAD, box.name), /has no box/);
});

test("a failed release keeps the box releasing with the reason, and the sweep finishes it", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.backend.faults.release = new Error("the provider is busy");
  const kept = await world.boxes.release(THREAD, box.name);
  assert.equal(kept?.state, "releasing");
  assert.match(kept!.error!, /the provider is busy. bb-box tries again/);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /being released/);
  const report = await world.boxes.sweep();
  assert.equal(report.resumed, 1);
  assert.deepEqual(await world.boxes.list(THREAD), []);
  assert.deepEqual(await world.backend.held(), []);
});

test("releasing a thread releases all its boxes and forgets failed ones", async () => {
  const world = setup();
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" });
  await world.boxes.idle();
  world.backend.faults.acquire = { at: "claimed", error: new Error("boom") };
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" });
  const other = await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" });
  await world.boxes.idle();
  assert.equal(await world.boxes.releaseThread(THREAD), 2);
  assert.deepEqual(await world.boxes.list(THREAD), []);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [other.id],
  );
});

test("the sweep releases the boxes of ended threads and keeps live and unknown ones", async () => {
  const world = setup();
  const ended = await world.boxes.acquire({ threadId: "thr_ended", projectId: null, kind: "linux" });
  const live = await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux" });
  const unknown = await world.boxes.acquire({ threadId: "thr_unknown", projectId: null, kind: "linux" });
  await world.boxes.idle();
  world.threads.set("thr_ended", "ended");
  world.threads.set("thr_unknown", "unknown");
  const report = await world.boxes.sweep();
  assert.equal(report.released, 1);
  assert.equal(await world.boxes.find(ended.id), null);
  assert.ok(await world.boxes.find(live.id));
  assert.ok(await world.boxes.find(unknown.id));
  assert.ok(world.backend.calls.includes("maintain"));
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
  assert.equal(report.leftovers, 1);
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
  assert.deepEqual({ ...report }, { released: 0, leftovers: 1, adopted: 3, kept: 1, resumed: 0 });
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
  // A sweep while it is still silent leaves it.
  await boxes.sweep();
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
  assert.deepEqual({ ...(await boxes.sweep()) }, { released: 0, leftovers: 0, adopted: 1, kept: 0, resumed: 0 });
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
  assert.equal(await boxes.release("thr_live", running.name), null);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId).sort(),
    [stopped.id, silent.id, unsure.id].sort(),
  );
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
  assert.equal(await world.boxes.release(THREAD, old.id), null);
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
  assert.equal(await world.boxes.release(THREAD, other.id), null);
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

test("a real backend's release resets the machine and returns it for the next box", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  assert.equal(first.nature, "real");
  await world.boxes.writeFile(THREAD, first.name, "left-behind", Buffer.from("x"));
  await assert.rejects(world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }), /All 1 machines are in use/);
  assert.equal(await world.boxes.release(THREAD, first.name), null);
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  assert.equal((await world.boxes.run("thr_two", second.name, "ls")).result.stdout, "");
});

test("a box whose backend is off can be seen but says what to fix, and is kept", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux" }));
  world.active = false;
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /backend that holds box .* is not in bb-box.s settings, or its settings need fixing/);
  const kept = await world.boxes.release(THREAD, box.name);
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

test("a box records its offer's features, and the ones beyond what its kind requires", async () => {
  const [headless] = FAKE_KINDS;
  const world = setup({
    kinds: [{ ...headless!, id: "linux-docker", requires: ["docker"], capabilities: { ...headless!.capabilities, features: ["docker", "systemd"] } }],
  });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-docker" }));
  assert.deepEqual(box.requires, ["docker"]);
  assert.deepEqual(box.capabilities.features, ["docker", "systemd"]);
  assert.deepEqual(extraFeatures(box), ["systemd"]);
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
    const run = (env: Record<string, string>) => {
      const log = tempDir("mac-desktop-log");
      const result = spawnSync(shell, ["-c", script], {
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

    const away = run({ FAKE_CONSOLE: "root" });
    assert.equal(away.status, MAC_DESKTOP_EXITS.noSession, shell);
    assert.equal(away.stderr, `bb-box: there is no desktop session to join: ${username} is not logged in to the desktop (the console belongs to root).\n`);
    assert.deepEqual([away.stdout, away.calls.length], ["", 0]);

    const refused = run({ FAKE_REFUSES: "1" });
    assert.equal(refused.status, MAC_DESKTOP_EXITS.refused, shell);
    assert.match(refused.stderr, /^bb-box: sudo does not let \S+ run commands in the desktop session\. Mac setup adds this rule as \/etc\/sudoers\.d\/bb-box-desktop:\n/);
    assert.ok(refused.stderr.endsWith(`\n${username} ALL=(root) NOPASSWD: /bin/launchctl asuser ${uid} /usr/bin/sudo -n -u ${username} -- *\n`), refused.stderr);
    assert.deepEqual([refused.stdout, refused.calls.length], ["", 1]);
  }
  assert.ok(canRunInDesktop("macos"));
  assert.ok(!canRunInDesktop("windows"));
  assert.throws(() => command("windows", "Get-Process", { session: "desktop" }), /cannot run commands in a windows desktop session/);
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
  assert.equal(await world.boxes.release(THREAD, box.name), null);
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
  await world.boxes.release(THREAD, first.name);
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  await world.backend.release(first.guest!, QUIET);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [second.id],
  );
});
