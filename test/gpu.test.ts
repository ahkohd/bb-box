import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { scopedStorage } from "../src/backends/index.ts";
import type { AcquireHooks, BoxIdentity, CardPlacement, GpuPart } from "../src/backends/types.ts";
import { cardsOf, chooseGpu, gpuPartsOf, gpuStayWords, gpuWhenNotAsked, hasGpuPart, holdsCard, kindNamingNoGpu, recordedGpu, userspaceOf, userspaceRestoreWords, withGpu, withRecordedGpu, type SnapshotGpu } from "../src/core/gpu.ts";
import { sameMachineSize, sameSize } from "../src/core/sizes.ts";
import { FAKE_KINDS, FakeBackend } from "./fake-backend.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";

const SMALL = { cores: 2, memoryMiB: 4096, diskGiB: null };

test("071 unit 1: a kind's GPU when not asked for is shared for linux-desktop and none for every other kind, whatever name asks for it", () => {
  const expected: Record<string, GpuPart> = {
    linux: "none",
    "linux-docker": "none",
    "linux-headless": "none",
    "linux-vm": "none",
    "linux-desktop": "shared",
    "linux-desktop-cpu": "none",
    "linux-desktop-wayland-cpu": "none",
    "linux-arm64": "none",
    "linux-arm64-desktop-cpu": "none",
    macos: "none",
    "macos-desktop": "none",
    "windows-desktop": "none",
    ios: "none",
    android: "none",
    "a-kind-bb-box-does-not-know": "none",
  };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((kind) => [kind, gpuWhenNotAsked(kind)])), expected);
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((kind) => [kind, chooseGpu(kind)])), Object.fromEntries(Object.entries(expected).map(([kind, gpu]) => [kind, { ok: true, gpu }])));
});

test("071 unit 1: only linux and linux-desktop have a GPU part; a setting can change their default but gives no other kind a card", () => {
  assert.deepEqual(gpuPartsOf("linux"), ["none", "shared", "whole"]);
  assert.deepEqual(gpuPartsOf("linux-docker"), ["none", "shared", "whole"]);
  assert.deepEqual(gpuPartsOf("linux-desktop"), ["none", "shared", "whole"]);
  for (const kind of ["linux-desktop-cpu", "linux-desktop-wayland-cpu", "linux-arm64", "macos", "windows-desktop", "ios", "android"]) assert.deepEqual(gpuPartsOf(kind), ["none"], kind);
  assert.equal(gpuWhenNotAsked("linux", { linux: "shared" }), "shared");
  assert.equal(gpuWhenNotAsked("linux-desktop", { "linux-desktop": "none" }), "none");
  assert.equal(gpuWhenNotAsked("linux-docker", { linux: "whole" }), "whole", "an alias takes its kind's setting");
  assert.equal(gpuWhenNotAsked("macos", { macos: "shared" }), "none");
  assert.equal(gpuWhenNotAsked("linux-desktop-cpu", { "linux-desktop-cpu": "shared", "linux-desktop": "whole" }), "none");
});

test("071 unit 1: linux-desktop-cpu is another name for a linux-desktop with no GPU, and refuses a GPU, as does a kind with no GPU part", () => {
  assert.equal(kindNamingNoGpu("linux-desktop-cpu"), "linux-desktop");
  assert.equal(kindNamingNoGpu("linux-desktop"), null);
  assert.deepEqual(chooseGpu("linux-desktop-cpu", "none"), { ok: true, gpu: "none" });
  for (const gpu of ["shared", "whole"] as const) {
    const refused = chooseGpu("linux-desktop-cpu", gpu);
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.message, `linux-desktop-cpu is a linux-desktop box with no GPU, so it cannot have gpu ${gpu}. Ask for linux-desktop with gpu ${gpu}, or leave gpu out.`);
  }
  assert.deepEqual(chooseGpu("macos", "shared"), { ok: false, message: "A macos box has no GPU. Leave gpu out, or ask for gpu none." });
  assert.deepEqual(chooseGpu("macos", "none"), { ok: true, gpu: "none" });
  assert.deepEqual(chooseGpu("linux", "whole"), { ok: true, gpu: "whole" });
  assert.deepEqual(chooseGpu("linux-desktop", "none"), { ok: true, gpu: "none" });
});

test("071 unit 1: a GPU part holds no card or one, so a count can grow from it later", () => {
  assert.deepEqual(
    (["none", "shared", "whole"] as const).map((gpu) => [cardsOf(gpu), holdsCard(gpu)]),
    [
      [0, false],
      [1, true],
      [1, true],
    ],
  );
  assert.deepEqual(withGpu({ ...SMALL, gpu: "whole" } as never, "shared"), { ...SMALL, gpu: "shared" });
});

test("071 unit 1: a record from before GPU parts reads shared only for a linux-desktop whose offer had a GPU, and its NVIDIA userspace reads unknown", () => {
  const gpu = { gpu: true };
  const none = { gpu: false };
  assert.equal(recordedGpu({ kind: "linux-desktop", capabilities: gpu, size: SMALL }), "shared");
  assert.equal(recordedGpu({ kind: "linux-desktop", capabilities: gpu }), "shared", "a record from before sizes, too");
  assert.equal(recordedGpu({ kind: "linux-desktop", capabilities: none, size: SMALL }), "none");
  assert.equal(recordedGpu({ kind: "linux-desktop-cpu", capabilities: none, size: SMALL }), "none");
  assert.equal(recordedGpu({ kind: "linux", capabilities: none, size: SMALL }), "none");
  assert.equal(recordedGpu({ kind: "linux-desktop-wayland-cpu", capabilities: none }), "none");
  assert.equal(recordedGpu({ kind: "linux", capabilities: gpu, size: SMALL }), "none", "only a desktop had a GPU before");
  assert.equal(recordedGpu({ kind: "linux", capabilities: none, size: { ...SMALL, gpu: "whole" } }), "whole");
  assert.equal(recordedGpu({ kind: "linux-desktop", capabilities: gpu, size: { ...SMALL, gpu: "none" } }), "none");
  assert.equal(recordedGpu({ kind: "linux-desktop", capabilities: gpu, size: { ...SMALL, gpu: "two" as GpuPart } }), "shared", "a part BB Box does not know reads as before");
  assert.equal(userspaceOf({ kind: "linux" }), "unknown");
  assert.equal(userspaceOf({ kind: "linux", nvidiaUserspace: null }), "unknown");
  assert.equal(userspaceOf({ kind: "linux", nvidiaUserspace: "580.142" }), "580.142");
  assert.equal(userspaceOf({ kind: "linux", nvidiaUserspace: "none" }), "none");
});

test("071 unit 1: NVIDIA's userspace reads none for a kind with no GPU part, as nothing will read it there, and unknown for a kind that can have a card", () => {
  const expected: Record<string, string> = {
    linux: "unknown",
    "linux-docker": "unknown",
    "linux-desktop": "unknown",
    "linux-desktop-cpu": "unknown",
    "linux-desktop-wayland-cpu": "none",
    "linux-arm64": "none",
    "linux-arm64-desktop-cpu": "none",
    macos: "none",
    "macos-desktop": "none",
    "windows-desktop": "none",
    ios: "none",
    android: "none",
  };
  assert.deepEqual(Object.fromEntries(Object.keys(expected).map((kind) => [kind, userspaceOf({ kind })])), expected);
  assert.equal(hasGpuPart("linux-desktop-cpu"), true, "it names a linux-desktop, which Resize can give a card");
});

test("071 unit 1: sameSize compares the GPU part too, so a box asked for none never takes a shared spare and a change of GPU alone is a change; sameMachineSize compares the three parts", () => {
  assert.equal(sameSize({ ...SMALL, gpu: "none" }, { ...SMALL, gpu: "none" }), true);
  assert.equal(sameSize({ ...SMALL, gpu: "none" }, { ...SMALL, gpu: "shared" }), false);
  assert.equal(sameSize({ ...SMALL, gpu: "shared" }, { ...SMALL, gpu: "whole" }), false);
  assert.equal(sameMachineSize({ ...SMALL, gpu: "none" } as never, { ...SMALL, gpu: "whole" } as never), true);
  assert.equal(sameMachineSize(SMALL, { ...SMALL, cores: 3 }), false);
});

test("071 unit 1: a size written from a guest keeps the record's own GPU part, or its absence", () => {
  const read = { cores: 3, memoryMiB: 4096, diskGiB: 20, gpu: "shared" } as never;
  assert.deepEqual(withRecordedGpu(read, { ...SMALL, gpu: "whole" }), { cores: 3, memoryMiB: 4096, diskGiB: 20, gpu: "whole" });
  assert.deepEqual(withRecordedGpu(read, SMALL), { cores: 3, memoryMiB: 4096, diskGiB: 20 });
  assert.deepEqual(withRecordedGpu(read, undefined), { cores: 3, memoryMiB: 4096, diskGiB: 20 });
});

const CARDS: readonly CardPlacement[] = [
  { card: "GPU-3f9a2c1e-55b0-4c1d-9e2a-0b7d6c4a1f00", index: 0, model: "Fake RTX", memoryMiB: 24_576 },
  { card: "GPU-8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11", index: 1, model: "Fake RTX", memoryMiB: 24_576 },
];

const QUIET: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

function cardsWorld(boxesPerCard = 2, cards: readonly CardPlacement[] = CARDS) {
  const kv = new MemoryStorage();
  const desktop = { ...FAKE_KINDS[1]!, capabilities: { ...FAKE_KINDS[1]!.capabilities, gpu: true } };
  const backend = new FakeBackend({ root: tempDir("gpu"), storage: scopedStorage(kv, "backend/fake/"), kinds: [FAKE_KINDS[0]!, desktop], cards, boxesPerCard });
  let counter = 0;
  const identity = (gpu: GpuPart, kind = "linux"): BoxIdentity => ({ boxId: `bxgpu${++counter}`, threadId: "thr_gpu", name: `gpu-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...SMALL, gpu } });
  const acquire = (gpu: GpuPart, kind?: string) => backend.acquire(identity(gpu, kind), null, QUIET, new AbortController().signal);
  const holders = async () => (await backend.cards()).map((card) => card.holders.map((holder) => `${holder.box} ${holder.part} ${holder.power}`));
  return { backend, acquire, holders };
}

test("071 unit 1: the fake backend places a shared box on the card with the fewest boxes, then the lowest index, by UUID, and a box with no GPU on none", async () => {
  const { backend, acquire, holders } = cardsWorld();
  const none = await acquire("none");
  assert.equal(none.claim, undefined);
  const first = await acquire("shared", "linux-desktop");
  const second = await acquire("shared");
  const third = await acquire("shared");
  assert.deepEqual(
    [first, second, third].map((guest) => guest.claim),
    [
      { card: CARDS[0]!.card, part: "shared", generation: 1, answer: "granted" },
      { card: CARDS[1]!.card, part: "shared", generation: 1, answer: "granted" },
      { card: CARDS[0]!.card, part: "shared", generation: 1, answer: "granted" },
    ],
  );
  assert.deepEqual(await holders(), [
    ["bxgpu2 shared running", "bxgpu4 shared running"],
    ["bxgpu3 shared running"],
  ]);
  assert.deepEqual(
    (await backend.held()).map((guest) => guest.claim?.card ?? null),
    [null, CARDS[0]!.card, CARDS[1]!.card, CARDS[0]!.card],
  );
});

test("071 unit 1: on the fake backend a whole box takes a card nobody holds, a stopped shared box gives up its place and a stopped whole box keeps its card", async () => {
  const { backend, acquire, holders } = cardsWorld(1);
  const shared = await acquire("shared");
  const whole = await acquire("whole");
  assert.equal(whole.claim?.card, CARDS[1]!.card);
  await assert.rejects(acquire("whole"), { code: "no_capacity", message: "No card on the fake host can take a whole GPU now." });
  await assert.rejects(acquire("shared"), { code: "no_capacity" }, "card 0 has its one box, and card 1 is held whole");
  await backend.stop!(shared);
  await backend.stop!(whole);
  assert.deepEqual(await holders(), [["bxgpu1 shared stopped"], ["bxgpu2 whole stopped"]]);
  assert.equal((await acquire("shared")).claim?.card, CARDS[0]!.card, "the stopped shared box holds no place");
  await assert.rejects(acquire("whole"), { code: "no_capacity" }, "the stopped whole box keeps its card");
});

test("071 unit 1: a fake backend with no cards places no box on one", async () => {
  const backend = new FakeBackend({ root: tempDir("gpu"), storage: new MemoryStorage() });
  const guest = await backend.acquire({ boxId: "bxnocards", threadId: "thr_gpu", name: "no-cards", kind: "linux", createdAt: 1, size: { ...SMALL, gpu: "shared" } }, null, QUIET, new AbortController().signal);
  assert.equal(guest.claim, undefined);
  assert.deepEqual(await backend.cards(), []);
});

test("071 unit 1: on the fake backend a stopped shared box starts on its card while it has room, moves to another card when its card is held whole, and is refused when no card has room", async () => {
  const one = cardsWorld(1, CARDS.slice(0, 1));
  const shared = await one.acquire("shared");
  await one.backend.stop!(shared);
  await one.acquire("whole");
  await assert.rejects(one.backend.start!(shared), { code: "no_capacity", message: "No card on the fake host can take a shared GPU now." });
  assert.deepEqual(await one.holders(), [["bxgpu1 shared stopped", "bxgpu2 whole running"]]);

  const two = cardsWorld(1);
  const moved = await two.acquire("shared");
  await two.backend.stop!(moved);
  await two.backend.start!(moved);
  assert.deepEqual((await two.backend.held())[0]!.claim, moved.claim, "it starts on its card, which has room");
  await two.backend.stop!(moved);
  await two.acquire("whole");
  await two.backend.start!(moved);
  assert.deepEqual((await two.backend.held()).find((guest) => guest.ref === moved.ref)!.claim, { card: CARDS[1]!.card, part: "shared", generation: 2, answer: "granted" });
  assert.deepEqual(await two.holders(), [["bxgpu2 whole running"], ["bxgpu1 shared running"]]);
});

test("071 unit 6: a restore says the GPU stays as it is now, and names a userspace that no longer matches the host", () => {
  assert.equal(gpuStayWords("none", null), "Its GPU stays as it is now: none.");
  assert.equal(gpuStayWords("shared", 1), "Its GPU stays as it is now: shared, card 1.");
  assert.equal(gpuStayWords("whole", null), "Its GPU stays as it is now: whole, its card.");
  const recorded = (userspace: SnapshotGpu["userspace"], part: SnapshotGpu["part"] = "shared"): SnapshotGpu => ({ part, card: part === "none" ? null : "card", index: 0, userspace });
  assert.equal(userspaceRestoreWords(null, "580.65.06"), "GPU not recorded.");
  assert.equal(userspaceRestoreWords(recorded("570.86"), "580.65.06"), "This snapshot has NVIDIA's userspace 570.86, and the host's driver is now 580.65.06: nvidia-smi will fail in the box until its userspace is updated.");
  assert.equal(userspaceRestoreWords(recorded("unknown"), "580.65.06"), "Whether this snapshot's NVIDIA userspace matches the host's driver is not known.");
  assert.equal(userspaceRestoreWords(recorded("570.86"), null), "Whether this snapshot's NVIDIA userspace matches the host's driver is not known.");
  assert.equal(userspaceRestoreWords(recorded("580.65.06"), "580.65.06"), null);
  assert.equal(userspaceRestoreWords(recorded("none", "none"), "580.65.06"), null);
});
