import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import type { Backend, BoxKind } from "../src/backends/types.ts";
import type { SlotKind } from "../src/core/device-host.ts";
import { BoxError, Boxes, OPERATOR, SPARES, type BoxRecord, type ForkRequest } from "../src/core/boxes.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
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
  readonly slots?: { readonly kinds: readonly SlotKind[]; readonly most: number };
}

const BB_CANNOT_SAY = new Error("BB did not answer");

function threadsInProjects(): Map<string, string | null | Error> {
  return new Map<string, string | null | Error>([
    [WORK_THREAD, WORK],
    [HOME_THREAD, HOME],
    [LOOSE_THREAD, null],
  ]);
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
        ...(provider.slots ? { slots: provider.slots } : {}),
      }),
  );
  const projects = new Map(providers.map((provider) => [provider.id, provider.projects ?? []]));
  const threads = threadsInProjects();
  const asBackends = built as unknown as Backend[];
  const state = { general: { perThreadLimit: null, enrol: true, sizes: {}, spares: {} } as GeneralConfig };
  const boxes = new Boxes({
    kv,
    backends: {
      get: (id) => asBackends.find((backend) => backend.id === id) ?? null,
      active: () => asBackends,
      on: () => asBackends,
      kinds: () => asBackends.flatMap((backend) => backend.kinds().map((kind) => ({ kind, backend }))),
      driverLabel: (id) => (id.startsWith("fake") ? "Fake host" : id),
      projects: (id) => projects.get(id) ?? [],
    },
    general: async () => state.general,
    notify: () => {},
    thread: async () => ({ state: "live", said: "the test says live" }),
    projectOf: async (threadId) => {
      const project = threads.get(threadId) ?? null;
      if (project instanceof Error) throw project;
      return project;
    },
    enrol: async (box) => {
      await boxes.update(box, () => ({ enrol: { state: "enrolled", hostId: `host-${box.id}`, error: null } }));
    },
    unenrol: async () => {},
    reconnect: async () => {},
    logError: () => {},
  });
  return { boxes, state, projects, threads, built };
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
  const fork = (threadId: string) => boxes.admitFork({ threadId, backend: "fake:work", backendLabel: "Fake host on work-1", kind: "linux", size: null });

  await fork(WORK_THREAD);
  await fork(OPERATOR);
  for (const threadId of [HOME_THREAD, LOOSE_THREAD]) {
    await assert.rejects(fork(threadId), (error: unknown) => {
      assert.ok(error instanceof BoxError);
      assert.match(error.message, /^Fake host on work-1 is kept for certain projects, and this thread('s project is not one of them| has no project), so a fork there cannot be this thread's box\. Only the person can fork it, as one of their machines\.$/);
      return true;
    });
  }
  assert.equal(await boxes.forkRefusal({ threadId: HOME_THREAD, backend: "fake", backendLabel: "Fake host on devpc" }), null, "a shared backend's forks go anywhere");
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

const KEPT_FROM_THREAD = /is kept for certain projects, and this thread('s project is not one of them| has no project)/;

function keptFromThread(error: unknown): boolean {
  assert.ok(error instanceof BoxError, String(error));
  assert.equal(error.code, "unsupported");
  assert.match(error.message, KEPT_FROM_THREAD);
  assert.ok(!error.message.includes(WORK) && !error.message.includes(HOME), "the projects are not named");
  return true;
}

function forkOf(source: BoxRecord, id: string, onto: Pick<ForkRequest, "backend" | "backendLabel"> = source): ForkRequest {
  return {
    id,
    threadId: source.threadId,
    projectId: source.projectId,
    backend: onto.backend,
    backendLabel: onto.backendLabel,
    kind: source.kind,
    size: { cores: 2, memoryMiB: 4096, diskGiB: null },
    origin: {
      operation: "op-fork",
      snapshot: { id: "snap-1", name: "before", takenAt: 0, ref: "snap-1", livesOn: source.guest!, identity: null },
      source: { id: source.id, name: source.name, threadId: source.threadId, macs: [] },
    },
    who: BY_COMMAND,
  };
}

test("a fork follows the thread's project now, as BB says it, not the project its source box was made in: a thread moved out of a kept backend's project gets no fork there (#1458)", async () => {
  const { boxes, threads } = world([
    { id: "fake", hosts: ["devpc"] },
    { id: "fake:work", hosts: ["work-1"], projects: [WORK] },
  ]);
  const source = await settled(boxes, await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" }));
  assert.equal(source.backend, "fake:work");
  assert.equal(source.projectId, WORK);
  const askedWithSourceProject = { threadId: WORK_THREAD, projectId: source.projectId, backend: "fake:work", backendLabel: source.backendLabel, kind: "linux", size: null };

  threads.set(WORK_THREAD, HOME);

  await assert.rejects(boxes.admitFork(askedWithSourceProject), keptFromThread);
  await assert.rejects(boxes.fork(forkOf(source, "bxforkmoved01")), keptFromThread);
  assert.ok(await boxes.forkRefusal(askedWithSourceProject));

  threads.set(WORK_THREAD, BB_CANNOT_SAY);
  await assert.rejects(boxes.admitFork(askedWithSourceProject), keptFromThread, "a thread BB cannot place has no project");

  threads.set(WORK_THREAD, HOME);
  const shared = await boxes.fork(forkOf(source, "bxforkshared1", { backend: "fake", backendLabel: "Fake host on devpc" }));
  assert.equal(shared.projectId, HOME, "the fork's record has the thread's project now");
  await boxes.idle();
});

test("a thread's spares on its project's kept backends are claimed in settings order, not in the order the spares were made (#1458)", async () => {
  const { boxes, state } = world([
    { id: "fake", hosts: ["devpc"] },
    { id: "fake:work-a", hosts: ["work-a"], projects: [WORK] },
    { id: "fake:work-b", hosts: ["work-b"], projects: [WORK] },
  ]);
  state.general = { ...state.general, spares: { linux: 2 } };
  const onB = await settled(boxes, await boxes.acquire({ threadId: SPARES, projectId: null, kind: "linux", on: "fake:work-b" }));
  const onA = await settled(boxes, await boxes.acquire({ threadId: SPARES, projectId: null, kind: "linux", on: "fake:work-a" }));
  assert.deepEqual((await boxes.list(SPARES)).map((spare) => spare.backend), ["fake:work-b", "fake:work-a"], "B's spare was made first");

  const first = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });
  const second = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" });

  assert.deepEqual([first.id, second.id], [onA.id, onB.id]);
  await boxes.idle();
});

function slotKind(id: SlotKind): BoxKind {
  const linux = FAKE_KINDS[0]!;
  if (id === "macos") return { ...linux, id: "macos", label: "macOS" };
  const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" } as const;
  return {
    ...linux,
    id: "ios",
    label: "iOS Simulator",
    capabilities: {
      ...linux.capabilities,
      displays: [{ id: "device", shows: "device", protocol: "selkies", resizable: false }],
      device: { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime }] },
    },
  };
}

function slotWorld(kind: SlotKind, most: number) {
  return world([
    { id: "fake", hosts: ["devpc"], kinds: [slotKind(kind)], slots: { kinds: [kind], most } },
    { id: "fake:work", hosts: ["work-1"], kinds: [slotKind(kind)], slots: { kinds: [kind], most }, projects: [WORK] },
  ]);
}

for (const kind of ["ios", "macos"] as const) {
  test(`a shared ${kind} box of a thread goes to a slot on its project's kept backend before a shared host, even one that is ready while the kept one must start a host, and to the shared host once the kept one is full (#1458)`, async () => {
    const { boxes, built } = slotWorld(kind, 2);
    const shared = { kind, shared: true } as const;
    const home = await boxes.acquire({ threadId: HOME_THREAD, projectId: HOME, ...shared });
    assert.equal(home.backend, "fake", "Home starts a host on the shared backend, which is then ready");
    assert.equal(built[1]!.slotHost, null, "the kept backend has no host yet");

    const work = [];
    for (let n = 0; n < 3; n++) work.push((await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, ...shared })).backend);
    assert.deepEqual(work, ["fake:work", "fake:work", "fake"], "a new host on the kept backend, not the ready shared one, and the shared host once the kept one is full");
    await boxes.idle();
  });
}

test("with no backend kept for a project, a shared slot still goes to the readiest host, as before (#1458)", async () => {
  const { boxes, projects } = slotWorld("macos", 2);
  projects.set("fake:work", []);
  const shared = { kind: "macos", shared: true } as const;
  await boxes.acquire({ threadId: HOME_THREAD, projectId: HOME, on: "fake:work", ...shared });

  const next = await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, ...shared });

  assert.equal(next.backend, "fake:work", "the ready host wins over one that must start, though listed second");
  await boxes.idle();
});

test("a box whose backend is no longer kept for its thread's project, as after the reservation changed or the thread moved, keeps working and may shrink, but cannot grow (#1458)", async () => {
  const { boxes, projects, threads, built } = world(SHARED_THEN_WORK);
  built[1]!.resizeWays = { cores: "live", memory: "live", disk: "live", shrinks: true };
  const box = await settled(boxes, await boxes.acquire({ threadId: WORK_THREAD, projectId: WORK, kind: "linux" }));
  assert.equal(box.backend, "fake:work");
  assert.equal((await boxes.resize(WORK_THREAD, box.name, { cores: 3 })).changed, true, "it grows while it is kept for the thread's project");

  projects.set("fake:work", [HOME]);
  await assert.rejects(boxes.resize(WORK_THREAD, box.name, { cores: 4 }, { check: true }), keptFromThread);
  await assert.rejects(boxes.resize(WORK_THREAD, box.name, { memoryGiB: 6 }), keptFromThread);
  assert.equal((await boxes.resize(WORK_THREAD, box.name, { cores: 2 })).changed, true, "it may still shrink");

  projects.set("fake:work", [WORK]);
  threads.set(WORK_THREAD, HOME);
  await assert.rejects(boxes.resize(WORK_THREAD, box.name, { diskGiB: 40 }), keptFromThread, "the thread moved to another project");
  await boxes.idle();
});
