import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, BoxKind } from "../src/backends/types.ts";
import { BoxError, Boxes, OPERATOR, SPARES, type BoxRecord } from "../src/core/boxes.ts";
import type { GeneralConfig } from "../src/core/config.ts";
import { readDraft } from "../src/core/document.ts";
import { EVERYONE, threadAudience } from "../src/core/reserved.ts";
import { FAKE_KINDS, FakeBackend, fakeDriver } from "./fake-backend.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const WORK = "proj_work";
const HOME = "proj_home";
const WORK_THREAD = "thr_work";
const HOME_THREAD = "thr_home";
const LOOSE_THREAD = "thr_loose";

interface Provider {
  readonly id: string;
  readonly hosts?: readonly string[];
  readonly maxGuests?: number;
  readonly kinds?: readonly BoxKind[];
  readonly projects?: readonly string[];
}

function world(providers: readonly Provider[]) {
  const kv = new MemoryStorage();
  const built = providers.map(
    (provider) =>
      new FakeBackend({
        root: tempDir(`reserved-${provider.id.replace(":", "-")}`),
        storage: scopedStorage(kv, `backend/${provider.id}/`),
        id: provider.id,
        ...(provider.hosts ? { hosts: provider.hosts } : {}),
        ...(provider.maxGuests !== undefined ? { maxGuests: provider.maxGuests } : {}),
        ...(provider.kinds ? { kinds: provider.kinds } : {}),
      }) as unknown as Backend,
  );
  const projects = new Map(providers.map((provider) => [provider.id, provider.projects ?? []]));
  const state = { general: { perThreadLimit: null, enrol: true, sizes: {}, spares: {} } as GeneralConfig };
  const boxes = new Boxes({
    kv,
    backends: {
      get: (id) => built.find((backend) => backend.id === id) ?? null,
      active: () => built,
      on: () => built,
      kinds: () => built.flatMap((backend) => backend.kinds().map((kind) => ({ kind, backend }))),
      driverLabel: (id) => (id.startsWith("fake") ? "Fake host" : id),
      projects: (id) => projects.get(id) ?? [],
    },
    general: async () => state.general,
    notify: () => {},
    thread: async () => ({ state: "live", said: "the test says live" }),
    enrol: async (box) => {
      await boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: `host-${box.id}`, error: null } }));
    },
    unenrol: async () => {},
    reconnect: async () => {},
    logError: () => {},
  });
  return { boxes, state, projects };
}

async function settled(boxes: Boxes, box: BoxRecord): Promise<BoxRecord> {
  return (await boxes.settled(box)) ?? box;
}

const SHARED_THEN_WORK: readonly Provider[] = [
  { id: "fake", hosts: ["devpc"] },
  { id: "fake:work", hosts: ["work-1"], maxGuests: 1, projects: [WORK] },
];

test("a thread in a listed project gets its project's reserved backend first, whatever the settings order, and falls back to shared ones when it is full (#1458)", async () => {
  const { boxes } = world(SHARED_THEN_WORK);

  const first = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });
  const second = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });

  assert.equal(first.backend, "fake:work", "reserved first, though listed second");
  assert.equal(second.backend, "fake", "the reserved backend is full, so a shared one");
  await boxes.idle();
});

test("reserved backends come in their settings order, before the shared ones (#1458)", async () => {
  const { boxes } = world([
    { id: "fake", hosts: ["devpc"] },
    { id: "fake:work-a", hosts: ["work-a"], maxGuests: 1, projects: [WORK] },
    { id: "fake:work-b", hosts: ["work-b"], maxGuests: 1, projects: [WORK, HOME] },
  ]);

  const placed = [];
  for (let n = 0; n < 3; n++) placed.push((await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" })).backend);

  assert.deepEqual(placed, ["fake:work-a", "fake:work-b", "fake"]);
  assert.deepEqual(boxes.offers(threadAudience(WORK)).filter((offer) => offer.kind.id === "linux").map((offer) => offer.backend.id), ["fake:work-a", "fake:work-b", "fake"]);
  await boxes.idle();
});

test("a thread in another project, or in none, never sees a reserved backend: not in its kinds, not where its boxes go, not even when the shared ones are full (#1458)", async () => {
  const desktopOnlyAtWork = [FAKE_KINDS.find((kind) => kind.id === "linux-desktop")!];
  const { boxes } = world([
    { id: "fake", hosts: ["devpc"], maxGuests: 1, kinds: FAKE_KINDS.filter((kind) => kind.id !== "linux-desktop") },
    { id: "fake:work", hosts: ["work-1"], kinds: [...desktopOnlyAtWork, FAKE_KINDS.find((kind) => kind.id === "linux")!], projects: [WORK] },
  ]);

  for (const audience of [threadAudience(HOME), threadAudience(null)]) {
    assert.ok(!boxes.kinds(audience).some((kind) => kind.id === "linux-desktop"), "the kind only the reserved backend offers is not listed");
    assert.ok(!boxes.offers(audience).some((offer) => offer.backend.id === "fake:work"));
  }
  assert.ok(boxes.kinds(threadAudience(WORK)).some((kind) => kind.id === "linux-desktop"));
  assert.ok(boxes.kinds(EVERYONE).some((kind) => kind.id === "linux-desktop"), "the person's own view lists every kind");

  await assert.rejects(boxes.acquire({ threadId: HOME_THREAD, projectId: HOME, kind: "linux-desktop" }), (error: unknown) => error instanceof BoxError && error.code === "unknown_kind" && !/work/i.test(error.message));
  const home = await boxes.acquire({ threadId: HOME_THREAD, projectId: HOME, kind: "linux" });
  assert.equal(home.backend, "fake");
  await assert.rejects(boxes.acquire({ threadId: LOOSE_THREAD, projectId: null, kind: "linux" }), (error: unknown) => error instanceof BoxError && error.code === "no_capacity" && !/work/i.test(error.message));
  await boxes.idle();
});

test("naming a reserved backend in on, from a thread outside its projects, is refused without naming them (#1458)", async () => {
  const { boxes } = world(SHARED_THEN_WORK);

  for (const [threadId, projectId] of [[HOME_THREAD, HOME], [LOOSE_THREAD, null]] as const) {
    for (const on of ["fake:work", "work-1", ["fake:work", "devpc"]]) {
      await assert.rejects(boxes.acquire({ threadId, projectId, kind: "linux", on }), (error: unknown) => {
        assert.ok(error instanceof BoxError);
        assert.equal(error.code, "unknown_provider");
        assert.match(error.message, /is kept for certain projects, and this thread('s project is not one of them| has no project), so it cannot make this box\. linux comes from: Fake host on devpc\./);
        assert.ok(!error.message.includes(WORK), "the projects are not named");
        return true;
      });
    }
  }

  assert.equal((await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux", on: "work-1" })).backend, "fake:work");
  await boxes.idle();
});

test("your own machines may be made on any backend, reserved or not (#1458)", async () => {
  const { boxes } = world(SHARED_THEN_WORK);

  const machine = await boxes.acquire({ threadId: OPERATOR, projectId: null, kind: "linux", on: "fake:work" });

  assert.equal(machine.backend, "fake:work");
  await boxes.idle();
});

test("a spare on a reserved backend goes only to a thread in its projects, which claims it before a shared one (#1458)", async () => {
  const { boxes, state } = world([
    { id: "fake:work", hosts: ["work-1"], maxGuests: 2, projects: [WORK] },
    { id: "fake", hosts: ["devpc"] },
  ]);
  state.general = { ...state.general, spares: { linux: 1 } };
  await boxes.keepSpares();
  await boxes.idle();
  const [spare] = await boxes.list(SPARES);
  assert.equal(spare?.backend, "fake:work", "spares are made in settings order");

  const home = await settled(boxes, await boxes.acquire({ threadId: HOME_THREAD, projectId: HOME, kind: "linux" }));
  const loose = await settled(boxes, await boxes.acquire({ threadId: LOOSE_THREAD, projectId: null, kind: "linux" }));
  assert.equal(home.timings.spare, undefined, "not claimed by another project's thread");
  assert.equal(loose.timings.spare, undefined, "not claimed by a thread with no project");
  assert.deepEqual([home.backend, loose.backend], ["fake", "fake"]);

  const work = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });
  assert.equal(work.id, spare!.id, "claimed by a thread of its project");
  await boxes.idle();
});

test("a thread in a listed project claims a shared spare only once its reserved backends are full (#1458)", async () => {
  const { boxes, state } = world([
    { id: "fake", hosts: ["devpc"] },
    { id: "fake:work", hosts: ["work-1"], maxGuests: 1, projects: [WORK] },
  ]);
  state.general = { ...state.general, spares: { linux: 1 } };
  await boxes.keepSpares();
  await boxes.idle();
  const [spare] = await boxes.list(SPARES);
  assert.equal(spare?.backend, "fake");

  const first = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });
  assert.equal(first.backend, "fake:work", "made on the reserved backend, not claimed from the shared spare");
  assert.notEqual(first.id, spare!.id);

  const second = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });
  assert.equal(second.id, spare!.id, "the reserved backend is full, so the shared spare");
  await boxes.idle();
});

test("a fork onto a reserved backend goes only to a thread in its projects or to your machines (#1458)", async () => {
  const { boxes } = world(SHARED_THEN_WORK);
  const fork = (threadId: string, projectId: string | null) => boxes.admitFork({ threadId, projectId, backend: "fake:work", backendLabel: "Fake host on work-1", kind: "linux", size: null });

  await fork(WORK_THREAD, WORK);
  await fork(OPERATOR, null);
  for (const [threadId, projectId] of [[HOME_THREAD, HOME], [LOOSE_THREAD, null]] as const) {
    await assert.rejects(fork(threadId, projectId), (error: unknown) => {
      assert.ok(error instanceof BoxError);
      assert.match(error.message, /^Fake host on work-1 is kept for certain projects, and this thread('s project is not one of them| has no project), so a fork there cannot be this thread's box\. Only the person can fork it, as one of their machines\.$/);
      return true;
    });
  }
  assert.equal(boxes.forkRefusal({ threadId: HOME_THREAD, projectId: HOME, backend: "fake", backendLabel: "Fake host on devpc" }), null, "a shared backend's forks go anywhere");
});

test("with no backend kept for a project, every thread sees every backend in settings order, as before (#1458)", async () => {
  const { boxes } = world([
    { id: "fake", hosts: ["devpc"], maxGuests: 1 },
    { id: "fake:second", hosts: ["lab"] },
  ]);

  for (const audience of [threadAudience(WORK), threadAudience(null), EVERYONE]) {
    assert.deepEqual([...new Set(boxes.offers(audience).map((offer) => offer.backend.id))], ["fake", "fake:second"]);
  }
  const first = await boxes.acquire({ threadId: LOOSE_THREAD, projectId: null, kind: "linux" });
  const second = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux", on: "lab" });
  assert.deepEqual([first.backend, second.backend], ["fake", "fake:second"]);
  await boxes.idle();
});

test("a backend's projects are a list of BB project IDs, read without repeats, left out when empty, and anything else is a problem at its path (#1458)", () => {
  const drivers = [fakeDriver(tempDir("reserved-driver"))];
  const read = (projects: unknown) => readDraft({ backends: [{ id: "fake", type: "fake", enabled: true, fields: { address: "192.0.2.10" }, projects }] }, drivers);

  assert.deepEqual(read(["proj_work", " proj_work ", "proj_home"]).document.backends[0]!.projects, ["proj_work", "proj_home"]);
  for (const empty of [[], null, undefined]) assert.equal("projects" in read(empty).document.backends[0]!, false, JSON.stringify(empty));
  for (const wrong of ["proj_work", [1], [""], { proj_work: true }]) {
    assert.deepEqual(read(wrong).problems.map((problem) => problem.path), ["backends.fake.projects"], JSON.stringify(wrong));
  }
});
