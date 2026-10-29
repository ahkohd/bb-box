import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import { scopedStorage } from "../src/backends/index.ts";
import { BackendError, type Backend, type PowerState, type ReleaseHooks } from "../src/backends/types.ts";
import { BY_COMMAND, BY_PERSON, byAgent, type BoxEventKind } from "../src/core/box-log.ts";
import { Boxes, SPARES, type BoxRecord, type BoxesDeps } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { REACH_DELAYS_MS, ReachCheck } from "../src/core/reach.ts";
import { openBoxFiles } from "../src/plugin/attached-files.ts";
import { BOX_LOG_MIGRATIONS, BoxLogStore } from "../src/plugin/box-log-store.ts";
import { FakeBackend } from "./fake-backend.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const THREAD = "thr_one";

function writable(backend: FakeBackend): { -readonly [K in keyof Backend]: Backend[K] } {
  return backend as unknown as { -readonly [K in keyof Backend]: Backend[K] };
}
const QUIET: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

function world(deps: Partial<BoxesDeps> = {}) {
  const root = tempDir("box-events");
  const kv = new MemoryStorage();
  const backendStorage = scopedStorage(kv, "backend/fake/");
  let handle: Database.Database | null = null;
  const files = openBoxFiles({ database: () => (handle?.open ? handle : (handle = new Database(join(root, "data.db")))) as never }, { log: BOX_LOG_MIGRATIONS, history: [] });
  let clock: number | null = null;
  const now = () => clock ?? Date.now();
  const log = new BoxLogStore({ file: files.log, now });
  const state = {
    root,
    kv,
    log,
    backend: new FakeBackend({ root, storage: backendStorage }),
    active: true,
    errors: [] as string[],
    unenrolled: [] as string[],
    powers: 0,
    boxes: null as unknown as Boxes,
    general: { perThreadLimit: null, enrol: false, sizes: {}, spares: {} } as GeneralConfig,
    setClock(at: number | null) {
      clock = at;
    },
    restart() {
      state.backend = new FakeBackend({ root, storage: backendStorage });
      state.boxes = registry();
      return state.boxes;
    },
    kinds(id: string): BoxEventKind[] {
      return log.events(id).map((event) => event.kind);
    },
    async guestPower(box: BoxRecord, power: PowerState): Promise<void> {
      const key = `guest/${box.guest!.ref}`;
      const record = await backendStorage.get<Record<string, unknown>>(key);
      await backendStorage.set(key, { ...record, power });
    },
  };
  const backends = {
    get: (id: string): Backend | null => (state.active && id === state.backend.id ? state.backend : null),
    active: (): Backend[] => (state.active ? [state.backend] : []),
    on: (): Backend[] => (state.active ? [state.backend] : []),
    kinds: () => (state.active ? state.backend.kinds().map((kind) => ({ kind, backend: state.backend as Backend })) : []),
  };
  const registry = () =>
    new Boxes({
      kv,
      backends,
      general: async () => state.general,
      notify: () => {},
      thread: async () => ({ state: "live", said: "live" }),
      logError: (operation, error) => state.errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
      unenrol: async (box) => void state.unenrolled.push(box.enrol.hostId!),
      events: log,
      now,
      ...deps,
    });
  state.boxes = registry();
  return state;
}

async function readyBox(state: ReturnType<typeof world>, who = byAgent(THREAD)): Promise<BoxRecord> {
  const box = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who });
  const settled = await state.boxes.settled(box);
  assert.equal(settled?.state, "ready");
  return settled!;
}

test("a stop and a start are logged with who asked: the person, an agent, a command, bb-box, or outside bb-box (069)", async () => {
  const state = world();
  const box = await readyBox(state);
  assert.deepEqual(state.kinds(box.id), ["made", "ready"]);
  assert.deepEqual(state.log.view(box.id).lastStart?.by, { is: "agent", threadId: THREAD });

  await state.boxes.stop(THREAD, box.id, undefined, BY_PERSON);
  assert.deepEqual(state.log.view(box.id).lastStop, { at: state.log.view(box.id).lastStop!.at, by: { is: "person" }, asked: true });
  await state.boxes.start(THREAD, box.id, undefined, BY_COMMAND);
  const start = state.log.view(box.id).lastStart!;
  assert.equal(start.first, false);
  assert.deepEqual(start.by, { is: "command" });
  assert.ok(start.readyAt! >= start.askedAt, "a start asked and finished");

  await state.boxes.stop(THREAD, box.id, undefined, byAgent("thr_other"));
  assert.deepEqual(state.log.view(box.id).lastStop?.by, { is: "agent", threadId: "thr_other" });
  await state.boxes.start(THREAD, box.id, undefined, BY_PERSON);

  await state.guestPower(box, "stopped");
  await state.boxes.sweep();
  assert.equal((await state.boxes.find(box.id))?.state, "stopped");
  const outside = state.log.view(box.id).lastStop!;
  assert.deepEqual(outside.by, { is: "outside" });
  assert.equal(outside.asked, false);
  assert.deepEqual(state.kinds(box.id), ["made", "ready", "stop-asked", "stopped", "start-asked", "started", "stop-asked", "stopped", "start-asked", "started", "stopped-unasked"]);

  await state.guestPower(box, "running");
  await state.boxes.sweep();
  assert.deepEqual(state.log.view(box.id).lastStart?.by, { is: "outside" }, "a start outside bb-box is the outside's");
});

test("bb-box's own stops say why: a spare is made, then waits stopped (069)", async () => {
  const state: ReturnType<typeof world> = world({
    enrol: async (box) => {
      await state.boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: `host-${box.id}`, error: null } }));
    },
  });
  state.general = { ...state.general, enrol: true, spares: { linux: 1 } };
  writable(state.backend).keepsSession = (kind: string) => kind === "linux";
  await state.boxes.keepSpares();
  await state.boxes.idle();
  for (let i = 0; i < 200 && (await state.boxes.list(SPARES))[0]?.enrol.state !== "enrolled"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await state.boxes.keepSpares();
  await state.boxes.idle();
  const [spare] = await state.boxes.list(SPARES);
  assert.equal(spare?.state, "stopped");
  const made = state.log.events(spare!.id)[0]!;
  assert.equal(made.kind, "made");
  assert.deepEqual(made.by, { is: "bb-box", why: "bb-box keeps 1 spare linux box" });
  assert.deepEqual(state.log.view(spare!.id).lastStop?.by, { is: "bb-box", why: "a spare waits stopped until a thread claims it" });
});

test("a stop that fails records what bb-box then saw, and a stop that times out and then succeeds is stopped from the confirmed time, by its asker (069 G6)", async () => {
  const state = world();
  const box = await readyBox(state);
  const stop = state.backend.stop!.bind(state.backend);
  writable(state.backend).stop = async () => {
    throw new Error("The provider timed out stopping it.");
  };
  state.setClock(1_000_000);
  await assert.rejects(state.boxes.stop(THREAD, box.id, undefined, BY_PERSON), /timed out/);
  const failed = state.log.view(box.id).lastFailed!;
  assert.equal(failed.operation, "stop");
  assert.match(failed.words ?? "", /timed out/);
  assert.deepEqual(failed.observed, { state: "running", at: 1_000_000, from: "Fake host" }, "it is still running, checked then");
  assert.equal((await state.boxes.find(box.id))?.state, "ready");
  assert.equal(state.log.view(box.id).lastStop, null, "a failed stop makes no stopped interval");

  writable(state.backend).stop = stop;
  await state.guestPower(box, "stopped");
  state.setClock(1_000_000 + 60_000);
  await state.boxes.sweep();
  const after = await state.boxes.find(box.id);
  assert.equal(after?.state, "stopped");
  assert.equal(after?.unrequestedStop ?? null, null, "not a stop bb-box did not ask for");
  assert.deepEqual(state.log.view(box.id).lastStop, { at: 1_060_000, by: { is: "person" }, asked: true }, "stopped from when bb-box confirmed it");
  assert.equal(state.log.view(box.id).lastFailed, null);
  assert.ok(!state.kinds(box.id).includes("stopped-unasked"));
});

test("a VM that boots but never answers SSH is logged as running, or as unconfirmed, never as still stopped (069 G6)", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.boxes.stop(THREAD, box.id, undefined, BY_PERSON);
  const start = state.backend.start!.bind(state.backend);
  writable(state.backend).start = async (guest, signal) => {
    await start(guest, signal);
    throw new Error("The box did not answer on SSH within 120 s.");
  };
  await assert.rejects(state.boxes.start(THREAD, box.id, undefined, BY_PERSON), /SSH/);
  const failed = state.log.view(box.id).lastFailed!;
  assert.equal(failed.operation, "start");
  assert.equal(failed.observed?.state, "running");
  assert.equal(state.log.view(box.id).lastStart?.failedAt, failed.at);
  assert.equal(state.log.view(box.id).lastStart?.readyAt, null);

  await state.boxes.stop(THREAD, box.id, undefined, BY_PERSON).catch(() => null);
  await state.boxes.refresh(THREAD, box.id);
  const power = state.backend.power.bind(state.backend);
  state.backend.power = async () => "unknown";
  await assert.rejects(state.boxes.start(THREAD, box.id, undefined, BY_PERSON));
  assert.equal(state.log.view(box.id).lastFailed?.observed?.state, "unknown", "bb-box could not confirm its state");
  state.backend.power = power;
});

test("a resize refused after its memory changed names memory as changed (069 G6)", async () => {
  const state = world();
  const box = await readyBox(state);
  state.backend.resizeWays = { cores: "live", memory: "live", disk: "no", shrinks: true };
  state.backend.resizeFault = new BackendError("unsupported", "The host refused the new cores.");
  const held = state.backend.held.bind(state.backend);
  state.backend.held = async () => (await held()).map((guest) => (guest.ref === box.guest!.ref ? { ...guest, size: { ...guest.size!, memoryMiB: 8192 } } : guest));
  await assert.rejects(state.boxes.resize(THREAD, box.id, { cores: 4, memoryGiB: 8 }, { who: BY_PERSON }), /refused/);
  const failed = state.log.view(box.id).lastFailed!;
  assert.equal(failed.operation, "resize");
  assert.deepEqual(failed.parts, ["memory"]);
  assert.match(failed.words ?? "", /Its memory changed/);
  assert.equal((await state.boxes.find(box.id))?.guest?.size?.memoryMiB, 8192, "the record has the size bb-box read back");
  assert.deepEqual(state.kinds(box.id).slice(-2), ["resize-asked", "resize-failed"]);
});

test("released is written only once the backend confirms; a failed release keeps its record (069 G5)", async () => {
  const state = world();
  const box = await readyBox(state);
  state.backend.faults.release = new Error("Proxmox refused: the container is locked by a backup.");
  const left = await state.boxes.release(THREAD, box.id, "released with bb box release", BY_COMMAND);
  assert.equal(left?.state, "releasing");
  assert.ok(await state.boxes.find(box.id), "the record stays");
  assert.deepEqual(state.kinds(box.id).slice(-2), ["release-asked", "release-failed"]);
  assert.equal(state.log.view(box.id).lastFailed?.operation, "release");
  assert.equal(state.log.view(box.id).lastFailed?.observed?.state, "running");
  assert.equal(state.log.ended(box.id), null, "no released until the backend confirms");

  await state.boxes.sweep();
  assert.equal(await state.boxes.find(box.id), null);
  assert.deepEqual(state.kinds(box.id).slice(-1), ["released"]);
  assert.deepEqual(state.log.ended(box.id)?.by, { is: "command" }, "by who asked");
  assert.equal(state.log.ended(box.id)?.how, "released");
});

test("bb-box restarted after the backend deleted a guest but before the record went finishes the release at start, by observing (069 G5)", async () => {
  const state = world();
  const box = await readyBox(state);
  await state.boxes.update(box, () => ({ state: "releasing", releaseRequestedAt: Date.now(), enrol: { state: "enrolled", hostId: "host-gone", error: null } }));
  state.log.record({ box: box.id, thread: THREAD, name: box.name, at: Date.now(), kind: "release-asked", by: BY_PERSON });
  await state.backend.release(box.guest!, QUIET);
  const boxes = state.restart();
  const calls = state.backend.calls.length;
  await boxes.sweep();
  assert.equal(await boxes.find(box.id), null, "the release is finished");
  assert.ok(!state.backend.calls.slice(calls).some((call) => call.startsWith("release")), "by observing the guest gone, with no second release");
  assert.deepEqual(state.unenrolled, ["host-gone"], "its BB machine is removed too");
  assert.deepEqual(state.kinds(box.id).slice(-2), ["release-asked", "released"]);
  assert.deepEqual(state.log.ended(box.id)?.by, { is: "person" });
});

test("forget removes a box whose backend is gone from the settings, says forgotten, never released, and makes no stopped interval (069 G5)", async () => {
  const state = world();
  const box = await readyBox(state);
  await assert.rejects(state.boxes.forget(THREAD, box.id, BY_PERSON), /release the box instead/, "a box whose backend is there is released, not forgotten");
  state.active = false;
  await state.boxes.forget(THREAD, box.id, BY_PERSON);
  assert.equal(await state.boxes.find(box.id), null);
  const kinds = state.kinds(box.id);
  assert.equal(kinds.at(-1), "forgotten");
  assert.ok(!kinds.includes("released") && !kinds.includes("stopped") && !kinds.includes("stopped-unasked"));
  const ended = state.log.ended(box.id)!;
  assert.equal(ended.how, "forgotten");
  assert.equal(ended.name, box.name);
  assert.equal(ended.backend, "Fake host");
  assert.equal(ended.state, "ready");
  assert.deepEqual(ended.by, { is: "person" });
});

test("a box that stops answering is checked after 1, 5, then every 15 minutes, by one command, and never by its backend (069 G7)", async () => {
  let now = 0;
  const timers: { at: number; task: () => void; id: number }[] = [];
  let ids = 0;
  const lines: string[] = [];
  let answers = false;
  let attempts = 0;
  const attemptTimes: number[] = [];
  let box: BoxRecord | null = null;
  const reach = new ReachCheck({
    find: async () => box,
    attempt: async () => {
      attempts++;
      attemptTimes.push(now);
      return answers ? null : "connect to host 10.0.0.9 port 22: No route to host";
    },
    checkable: () => true,
    changed: () => {},
    log: (line) => lines.push(line),
    now: () => now,
    setTimer: (task, ms) => {
      const timer = { at: now + ms, task, id: ids++ };
      timers.push(timer);
      return timer.id;
    },
    clearTimer: (id) => {
      const index = timers.findIndex((timer) => timer.id === id);
      if (index >= 0) timers.splice(index, 1);
    },
  });
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      timers.sort((a, b) => a.at - b.at);
      const next = timers[0];
      if (!next || next.at > end) break;
      timers.shift();
      now = next.at;
      next.task();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    }
    now = end;
  };
  const state = world({ reach });
  box = await readyBox(state);
  state.backend.faults.silent = box.guest!.ref;
  const power = state.backend.power.bind(state.backend);
  state.backend.power = async (guest) => {
    state.powers++;
    return power(guest);
  };
  await assert.rejects(state.boxes.run(THREAD, box.id, "true"), /does not answer/);
  const powersAtFirst = state.powers;
  await assert.rejects(state.boxes.run(THREAD, box.id, "true"), /does not answer/);
  assert.equal(state.powers, powersAtFirst, "a box known not to answer costs its backend nothing more");
  assert.equal(reach.reach(box).is, "not-answering");
  const predicted: number[] = [];
  const first = reach.reach(box);
  if (first.is === "not-answering" && first.nextCheckAt !== null) predicted.push(first.nextCheckAt - first.since);
  for (let minute = 0; minute < 60; minute++) {
    const before = attempts;
    await advance(60_000);
    const shown = reach.reach(box);
    if (attempts > before && shown.is === "not-answering" && shown.nextCheckAt !== null) predicted.push(shown.nextCheckAt - shown.since);
  }
  const at = attemptTimes.map((time) => time - attemptTimes[0]! + 60_000);
  assert.deepEqual(at.map((time) => time / 60_000), [1, 6, 21, 36, 51], `checked at ${at.map((time) => time / 60_000).join(", ")} minutes`);
  assert.deepEqual(predicted.slice(0, at.length), at, "the next check shown is when it comes");
  assert.ok(lines.length <= 6, `${lines.length} lines logged in the hour`);
  assert.equal(state.powers, powersAtFirst, "no backend call in the hour");
  const shown = reach.reach(box);
  assert.equal(shown.is, "not-answering");
  if (shown.is === "not-answering") assert.equal(shown.nextCheckAt, 51 * 60_000 + REACH_DELAYS_MS[2]);

  state.backend.faults.silent = undefined;
  await state.boxes.refresh(THREAD, box.id);
  const powersAtCheck = state.powers;
  await state.boxes.refresh(THREAD, box.id);
  assert.equal(state.powers, powersAtCheck, "Check now reads its power at most once a minute");
  answers = true;
  await reach.checkNow(box);
  assert.equal(reach.reach(box).is, "answers");
  reach.dispose();
});

test("a VM that crashes after a failed stop is a stop bb-box did not ask for, and is started again (069 G6)", async () => {
  const state = world();
  const box = await readyBox(state);
  const stop = state.backend.stop!.bind(state.backend);
  writable(state.backend).stop = async () => {
    throw new Error("The provider timed out stopping it.");
  };
  await assert.rejects(state.boxes.stop(THREAD, box.id, undefined, BY_PERSON));
  writable(state.backend).stop = stop;
  state.backend.stopReason = { at: Date.now(), reason: "The VM's process was killed.", crashed: true };
  await state.guestPower(box, "stopped");
  await state.boxes.sweep();
  await state.boxes.idle();
  assert.deepEqual(state.log.latest(box.id, ["stopped", "stopped-unasked"])?.kind, "stopped-unasked");
  assert.deepEqual(state.log.latest(box.id, ["stopped-unasked"])?.by, { is: "outside" });
  assert.equal(state.log.latest(box.id, ["start-asked"])?.by.is, "bb-box", "bb-box starts a crashed VM again");
  assert.equal((await state.boxes.find(box.id))?.state, "ready");
});

test("a claimed spare names who asked for the box, and when it was ready (069)", async () => {
  const state = world();
  state.general = { ...state.general, spares: { linux: 1 } };
  await state.boxes.keepSpares();
  await state.boxes.idle();
  const [spare] = await state.boxes.list(SPARES);
  assert.equal(spare?.state, "ready");
  const box = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: byAgent(THREAD) });
  assert.equal(box.id, spare!.id, "the spare was claimed");
  const start = state.log.view(box.id).lastStart!;
  assert.deepEqual(start.by, { is: "agent", threadId: THREAD });
  assert.equal(start.first, true);
  assert.ok(start.readyAt !== null);
  assert.match(state.log.latest(box.id, ["made"])?.words ?? "", new RegExp(`Claimed from bb-box's spare boxes, as ${spare!.name}\\.`));
});
