// The registry against the fake backend: acquire and release, limits and
// capacity, commands and copies, stop and start, and the sweep.

import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import { BackendError, type Backend, type ReleaseHooks } from "../src/backends/types.ts";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BoxError, Boxes, extraFeatures, type BoxRecord, type BoxesDeps, type ThreadLiveness } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { accessSetup, envScript } from "../src/core/in-box.ts";
import { FAKE_KINDS, FakeBackend, type FakeBackendOptions } from "./fake-backend.ts";
import { MemoryStorage, fakeDaemon, tempDir } from "./helpers.ts";

const THREAD = "thr_one";

const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function setup(options: Omit<FakeBackendOptions, "root" | "storage"> = {}, deps: Pick<BoxesDeps, "access" | "enrolWaitMs"> = {}) {
  const root = tempDir("boxes");
  const kv = new MemoryStorage();
  const backendStorage = scopedStorage(kv, "backend/fake/");
  const make = () => new FakeBackend({ root, storage: backendStorage, ...options });
  const world = {
    kv,
    backend: make() as FakeBackend,
    /** False when the backend is off in settings. */
    active: true,
    general: { perThreadLimit: null, enrol: true } as GeneralConfig,
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
      enrol: async (box) => {
        world.enrolled.push(box.name);
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
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: "prj", kind: "linux-headless" });
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

test("names are unique within a thread and unknown boxes are named in the error", async () => {
  const world = setup();
  const a = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
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
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "windows" }), /The kinds are: linux-headless, linux-desktop/);
  world.active = false;
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }), /No backend is set up/);
});

test("there is no per-thread limit by default, and a set limit names the boxes", async () => {
  const world = setup();
  for (let i = 0; i < 3; i++) await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  await world.boxes.idle();
  world.general = { ...world.general, perThreadLimit: 3 };
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }), (error: BoxError) => {
    assert.equal(error.code, "limit_reached");
    assert.match(error.message, /already has 3 boxes/);
    return true;
  });
  // Other threads have their own limit.
  await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" });
  await world.boxes.idle();
});

test("capacity counts boxes still being acquired, and the backend's message reaches the user", async () => {
  const world = setup({ maxGuests: 1 });
  const gate = deferred();
  world.backend.gate = gate.promise;
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  // The first box has no guest record yet at the fake, but it is pending.
  await assert.rejects(world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" }), (error: BoxError) => {
    assert.equal(error.code, "no_capacity");
    assert.match(error.message, /holds 1 guests at most/);
    return true;
  });
  gate.resolve();
  await world.boxes.idle();
  assert.equal((await world.boxes.all()).length, 1);
});

test("concurrent acquires from different threads never share the last room", async () => {
  const world = setup({ maxGuests: 2 });
  const results = await Promise.allSettled(
    ["a", "b", "c", "d"].map((thread) => world.boxes.acquire({ threadId: thread, projectId: null, kind: "linux-headless" })),
  );
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  await world.boxes.idle();
});

test("a failed acquire keeps the box as failed with the reason, holding nothing", async () => {
  const world = setup();
  world.backend.faults.acquire = { at: "started", error: new BackendError("no_capacity", "The host ran out of memory.") };
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  const done = await ready(world.boxes, box);
  assert.equal(done.state, "failed");
  assert.equal(done.error, "The host ran out of memory.");
  assert.equal(done.guest, null);
  assert.deepEqual(await world.backend.held(), []);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /failed: The host ran out of memory/);
  // A failed box does not count against the limit.
  world.general = { ...world.general, perThreadLimit: 1 };
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  await world.boxes.idle();
});

test("releasing a box while it is acquired cancels the acquire and leaves nothing", async () => {
  const world = setup();
  const gate = deferred();
  world.backend.gate = gate.promise;
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  const { result } = await world.boxes.run(THREAD, box.name, "echo first\necho second", { cwd: "missing" });
  assert.equal(result.exitCode, 1);
  assert.equal(result.stdout, "");
});

test("the env file sets only valid names, and quotes values", () => {
  const dir = tempDir("env");
  const script = envScript("linux", { GREETING: "it's\nhere", "BAD-NAME": "x" });
  assert.doesNotMatch(script, /BAD-NAME/);
  writeFileSync(join(dir, "env"), script);
  const out = execFileSync("sh", ["-c", '. ./env && printf %s "$GREETING"'], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH } });
  assert.equal(out, "it's\nhere");
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  assert.equal((await world.boxes.run(THREAD, box.name, 'printf %s "$BB_BOX_NAME"')).result.stdout, box.name);
  fail = true;
  const { result } = await world.boxes.run(THREAD, box.name, 'printf %s "$BB_BOX_NAME"');
  assert.equal(result.stdout, box.name);
  assert.deepEqual(world.errors, ["access: BB did not answer"]);
});

test("access setup puts the env file above ~/.bashrc's early return, once, and keeps the file's mode", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await world.boxes.writeFile(THREAD, box.name, ".bashrc", Buffer.from('case $- in *i*) ;; *) return;; esac\nexport MINE=1\n'), { mode: "640" });
  for (let i = 0; i < 2; i++) assert.equal((await world.boxes.run(THREAD, box.name, accessSetup("linux")!)).result.exitCode, 0);
  const { result } = await world.boxes.run(THREAD, box.name, "stat -c %a .bashrc; cat .bashrc; bash -c '. ~/.bashrc; printf %s \"$BB_BOX_NAME\"'");
  assert.equal(
    result.stdout,
    `640\n# Added by bb-box: the thread's environment and access, for SSH commands too.\nif [ -r "$HOME/.config/bb-box/env" ]; then . "$HOME/.config/bb-box/env"; fi\n\ncase $- in *i*) ;; *) return;; esac\nexport MINE=1\n${box.name}`,
  );
  assert.equal(accessSetup("macos"), null);
});

test("a command that times out stops in the box, with everything it started", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await world.boxes.update(box, () => ({ enrol: { state: "enrolling", hostId: "host-slow", error: null } }));
  const { box: after, result } = await world.boxes.run(THREAD, box.name, "echo ran");
  assert.equal(after.enrol.state, "enrolling");
  assert.equal(result.stdout, "ran\n");
});

test("a stop or start that ends during a release leaves the box releasing", async () => {
  for (const action of ["stop", "start"] as const) {
    const world = setup();
    const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  assert.equal(box.enrol.state, "off");
  await world.boxes.stop(THREAD, box.name);
  await world.boxes.start(THREAD, box.name);
  assert.deepEqual(world.reconnected, []);
});

test("a box stopped behind bb-box's back is found when a command cannot reach it", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await world.backend.stop!(box.guest!);
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /is stopped/);
  assert.equal((await world.boxes.get(THREAD, box.name)).state, "stopped");
});

test("a guest deleted outside bb-box marks the box gone, and release still works", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  assert.equal(await world.boxes.release(THREAD, box.name), null);
  assert.deepEqual(world.unenrolled, [`host-${box.id}`]);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal(await world.boxes.find(box.id), null);
  await assert.rejects(world.boxes.release(THREAD, box.name), /has no box/);
});

test("a failed release keeps the box releasing with the reason, and the sweep finishes it", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" });
  await world.boxes.idle();
  world.backend.faults.acquire = { at: "claimed", error: new Error("boom") };
  await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
  const other = await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" });
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
  const ended = await world.boxes.acquire({ threadId: "thr_ended", projectId: null, kind: "linux-headless" });
  const live = await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux-headless" });
  const unknown = await world.boxes.acquire({ threadId: "thr_unknown", projectId: null, kind: "linux-headless" });
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
  const lost = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_live", projectId: null, kind: "linux-headless" }));
  const orphan = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_gone", projectId: null, kind: "linux-headless" }));
  // Storage loses two records; the provider still has the guests.
  for (const box of [lost, orphan]) {
    await world.kv.delete(`box/${box.threadId}/${box.id}`);
    await world.kv.delete(`index/${box.id}`);
  }
  world.threads.set("thr_gone", "ended");
  const report = await world.boxes.sweep();
  assert.equal(report.adopted, 1);
  assert.equal(report.leftovers, 1);
  const adopted = await world.boxes.find(lost.id);
  assert.equal(adopted?.name, lost.name);
  assert.equal(adopted?.state, "ready");
  assert.equal(adopted?.kind, "linux-headless");
  assert.deepEqual(adopted?.guest, lost.guest);
  assert.equal((await world.boxes.run("thr_live", lost.name, "echo adopted")).result.stdout, "adopted\n");
  assert.deepEqual((await world.backend.held()).map((guest) => guest.ref).sort(), [kept.guest!.ref, lost.guest!.ref].sort());
});

test("the sweep releases a guest whose box moved on or failed", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  // The record says the box holds nothing, but the provider still has its guest.
  await world.boxes.update(box, () => ({ state: "failed", guest: null, error: "boom" }));
  const report = await world.boxes.sweep();
  assert.equal(report.leftovers, 1);
  assert.deepEqual(await world.backend.held(), []);
  assert.equal((await world.boxes.find(box.id))?.state, "failed");
});

test("the sweep notices power changes and deleted guests", async () => {
  const world = setup();
  const a = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  const b = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await world.backend.stop!(a.guest!);
  await world.backend.release(b.guest!, QUIET);
  await world.boxes.sweep();
  assert.equal((await world.boxes.find(a.id))?.state, "stopped");
  assert.equal((await world.boxes.find(b.id))?.state, "gone");
});

test("after a restart the sweep resumes an interrupted acquire with its claimed guest", async () => {
  const world = setup();
  world.backend.gate = new Promise(() => {});
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
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
  const box = await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" });
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
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  assert.equal(first.nature, "real");
  await world.boxes.writeFile(THREAD, first.name, "left-behind", Buffer.from("x"));
  await assert.rejects(world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" }), /All 1 machines are in use/);
  assert.equal(await world.boxes.release(THREAD, first.name), null);
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  assert.equal((await world.boxes.run("thr_two", second.name, "ls")).result.stdout, "");
});

test("a box whose backend is off can be seen but says what to fix, and is kept", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  world.active = false;
  await assert.rejects(world.boxes.run(THREAD, box.name, "true"), /backend that holds box .* is off or its settings need fixing/);
  const kept = await world.boxes.release(THREAD, box.name);
  assert.equal(kept?.state, "releasing");
  assert.match(kept!.error!, /is off or its settings need fixing/);
  await world.boxes.sweep();
  assert.ok(await world.boxes.find(box.id));
  world.active = true;
  await world.boxes.sweep();
  assert.equal(await world.boxes.find(box.id), null);
  assert.deepEqual(await world.backend.held(), []);
});

test("errors from a backend keep their message and never leak into other threads", async () => {
  const world = setup();
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await assert.rejects(world.boxes.get("thr_two", box.name), /This thread has no box .* It has no boxes/);
  await assert.rejects(world.boxes.run("thr_two", box.id, "true"), /This thread has no box/);
});

test("a box whose backend cannot stop and start says so, and keeps running", async () => {
  const world = setup({ stopStart: false });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  world.backend.power = async () => "unknown";
  assert.equal((await world.boxes.refresh(THREAD, box.name)).state, "ready");
  await world.boxes.sweep();
  assert.equal((await world.boxes.get(THREAD, box.name)).state, "ready");
});

test("a box records its offer's features, and the ones beyond what its kind requires", async () => {
  const [headless] = FAKE_KINDS;
  const world = setup({
    kinds: [{ ...headless!, id: "linux-headless-docker", requires: ["docker"], capabilities: { ...headless!.capabilities, features: ["docker", "systemd"] } }],
  });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless-docker" }));
  assert.deepEqual(box.requires, ["docker"]);
  assert.deepEqual(box.capabilities.features, ["docker", "systemd"]);
  assert.deepEqual(extraFeatures(box), ["systemd"]);
});

test("a desktop command runs in the desktop session, and a headless box has none", async () => {
  const world = setup();
  const desktop = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-desktop" }));
  const inSession = await world.boxes.run(THREAD, desktop.name, 'echo "$DISPLAY $DBUS_SESSION_BUS_ADDRESS"', { session: "desktop" });
  assert.match(inSession.result.stdout, /^:0 unix:path=\/run\/user\/\d+\/bus\n$/);
  assert.equal((await world.boxes.run(THREAD, desktop.name, 'echo "[$DISPLAY]"')).result.stdout, "[]\n");
  const headless = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await assert.rejects(world.boxes.run(THREAD, headless.name, "true", { session: "desktop" }), /has no desktop/);
});

test("a real backend's release records the reset, and a failed reset takes the machine out of service", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const box = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
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
  await assert.rejects(world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }), /All 1 machines are in use/);
  await world.backend.returnToService!(member!.ref);
  assert.equal((await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }))).state, "ready");
});

test("a stale release of a real machine does not reset the next box's machine", async () => {
  const world = setup({ nature: "real", machines: 1 });
  const first = await ready(world.boxes, await world.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-headless" }));
  await world.boxes.release(THREAD, first.name);
  const second = await ready(world.boxes, await world.boxes.acquire({ threadId: "thr_two", projectId: null, kind: "linux-headless" }));
  assert.equal(second.guest?.ref, first.guest?.ref);
  await world.backend.release(first.guest!, QUIET);
  assert.deepEqual(
    (await world.backend.held()).map((guest) => guest.owner?.boxId),
    [second.id],
  );
});
