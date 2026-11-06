import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { cardsOnHost, environmentScript, judgeDockerCardCheck, parseProbe, placeCard, placementRefusal, reachWords, type CardHolder, type DockerCard } from "../src/backends/docker/gpus.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type FieldValue, type GpuPart, type Guest, type MachineSize } from "../src/backends/types.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, tempDir, testContext } from "./helpers.ts";

const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const CARD_A = "0b1c2d3e-0000-0000-0000-00000000000a";
const CARD_B = "0b1c2d3e-0000-0000-0000-00000000000b";
const DEVICE_A = `nvidia.com/gpu=GPU-${CARD_A}`;
const DEVICE_B = `nvidia.com/gpu=GPU-${CARD_B}`;
const card = (index: number, uuid: string, device: string, freeMiB = 30_000) => ({ index, uuid, name: "NVIDIA GeForce RTX 5090", totalMiB: 32_607, freeMiB, device });
const TWO_CARDS = { gpus: [DEVICE_A, DEVICE_B], cards: [card(0, CARD_A, DEVICE_A), card(1, CARD_B, DEVICE_B)] };
const WSL_ONE_CARD = { allGpus: true, kernelVersion: "6.6.87.2-microsoft-standard-WSL2", cards: [card(0, CARD_A, "nvidia.com/gpu=all")] };
const WSL_TWO_CARDS = { allGpus: true, kernelVersion: "6.6.87.2-microsoft-standard-WSL2", cards: [card(0, CARD_A, "nvidia.com/gpu=all"), card(1, CARD_B, "nvidia.com/gpu=all")] };
const signal = () => AbortSignal.timeout(30_000);

function setup(values: Record<string, FieldValue> = {}, host: Record<string, unknown> = TWO_CARDS, options: { whole?: boolean; titles?: Record<string, string>; installId?: string } = {}) {
  const fake = fakeDockerHost(host);
  const config = dockerConfig({ "gpu-desktops": true, ...values });
  const contextFor = (installId: string) => ({ ...testContext(new MemoryStorage(), installId), wholeCards: () => options.whole ?? false, threadTitle: async (threadId: string) => options.titles?.[threadId] ?? null });
  const context = contextFor(options.installId ?? "test");
  const make = (installId: string) => new DockerBackend(config, contextFor(installId), { binary: fake.binary, readyTimeoutMs: 2_000 });
  return { fake, context, make, backend: new DockerBackend(config, context, { binary: fake.binary, readyTimeoutMs: 2_000 }) };
}

let counter = 0;
function identity(kind: string, gpu: GpuPart, threadId = "thr_abc123", name?: string): BoxIdentity {
  counter++;
  return { boxId: `bg${String(counter).padStart(12, "0")}`, threadId, name: name ?? `quiet-elm-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...SMALL, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

function env(fake: ReturnType<typeof fakeDockerHost>, ref: string): string[] {
  return fake.inspect(ref).Config.Env;
}

function environmentFile(fake: ReturnType<typeof fakeDockerHost>, ref: string): string {
  return readFileSync(join(fake.root, "containers", ref, "etc", "environment"), "utf8");
}

function fact(guest: Guest, label: string): string | undefined {
  return guest.facts?.find((each) => each.label === label)?.value;
}

const SERVER_REACH = "On fake-docker, every box with Docker in it can open every card, with a GPU or without. None and Whole card are what bb-box places, not what a box can reach.";

test("071 unit 11: with GPU boxes on, a Docker linux box offers none and shared, and whole only where whole cards are on; a desktop offers shared and whole; with them off, neither offers a GPU", () => {
  const parts = (backend: DockerBackend) => Object.fromEntries(backend.kinds().map((kind) => [kind.id, kind.gpuParts ?? null]));
  assert.deepEqual(parts(setup().backend), { linux: ["none", "shared"], "linux-desktop-cpu": null, "linux-desktop": ["shared"], "linux-desktop-wayland-cpu": null });
  assert.deepEqual(parts(setup({}, TWO_CARDS, { whole: true }).backend), { linux: ["none", "shared", "whole"], "linux-desktop-cpu": null, "linux-desktop": ["shared", "whole"], "linux-desktop-wayland-cpu": null });
  assert.deepEqual(parts(setup({ "gpu-desktops": false }).backend), { linux: null, "linux-desktop-cpu": null, "linux-desktop-wayland-cpu": null });
  const { backend } = setup();
  assert.deepEqual(backend.resizing("linux"), { cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "no", share: "live", move: "no" } });
  assert.deepEqual(setup({ "gpu-desktops": false }).backend.resizing("linux"), { cores: "live", memory: "live", disk: "no", shrinks: true });
});

test("071 unit 11: a shared server gets one card as a CDI device, labelled with its card and part, CUDA pointed at it in its environment and /etc/environment, a granted claim, and the check after start passes", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  const made = fake.inspect(guest.ref);
  assert.deepEqual(made.HostConfig.Devices, [DEVICE_A]);
  assert.equal(made.Config.Labels["bbbox.gpu"], DEVICE_A);
  assert.equal(made.Config.Labels["bbbox.gpu-card"], CARD_A);
  assert.equal(made.Config.Labels["bbbox.gpu-part"], "shared");
  assert.ok(env(fake, guest.ref).includes(`CUDA_VISIBLE_DEVICES=GPU-${CARD_A}`));
  assert.ok(env(fake, guest.ref).includes(`NVIDIA_VISIBLE_DEVICES=GPU-${CARD_A}`));
  assert.ok(!env(fake, guest.ref).includes("BBBOX_GPU=1"), "BBBOX_GPU is a desktop's display switch");
  assert.equal(environmentFile(fake, guest.ref), `CUDA_VISIBLE_DEVICES="GPU-${CARD_A}"\nNVIDIA_VISIBLE_DEVICES="GPU-${CARD_A}"\n`);
  assert.deepEqual(guest.claim, { card: CARD_A, part: "shared", generation: 1, answer: "granted" });
  assert.deepEqual(guest.data, { box: guest.data?.box, gpu: DEVICE_A, card: CARD_A, part: "shared" });
  assert.equal(fact(guest, "GPU"), "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB");
  assert.equal(fact(guest, "GPU check"), `Run nvidia-smi -i GPU-${CARD_A} to see it; every card on the host is listed`);
  assert.equal(fact(guest, "Cards"), SERVER_REACH);
  const probe = fake.calls().find((args) => args[0] === "container" && args[1] === "run" && args.at(-1)!.includes("--query-gpu"));
  assert.ok(probe, "the cards are read in a probe container");
  assert.ok(!probe.includes("--privileged"));
  assert.deepEqual(probe.filter((arg, at) => probe[at - 1] === "--device"), ["nvidia.com/gpu=all"]);
  const second = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(second.claim?.card, CARD_B, "the next shared box goes to the card with fewer boxes");
  const held = await backend.held(signal());
  assert.deepEqual(held.find((each) => each.ref === guest.ref)?.claim, { card: CARD_A, part: "shared", generation: 1, answer: "granted" });
});

test("071 unit 11: a server with no GPU gets no device and no CUDA variables, and on a host whose boxes are privileged its facts say it can still open every card; with Docker in boxes off it says nothing of cards", async () => {
  const { fake, backend } = setup();
  const none = await backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.deepEqual(fake.inspect(none.ref).HostConfig.Devices, []);
  assert.equal(fake.inspect(none.ref).HostConfig.Privileged, true);
  assert.ok(!env(fake, none.ref).some((pair) => /^(CUDA|NVIDIA)_VISIBLE_DEVICES=/.test(pair)));
  assert.equal(none.claim, undefined);
  assert.equal(fact(none, "GPU"), undefined);
  assert.equal(fact(none, "Cards"), SERVER_REACH);
  const unprivileged = setup({ privileged: false });
  const fenced = await unprivileged.backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.equal(unprivileged.fake.inspect(fenced.ref).HostConfig.Privileged, false);
  assert.equal(fact(fenced, "Cards"), undefined);
  const sharedFenced = await unprivileged.backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(fact(sharedFenced, "Cards"), undefined, "an unprivileged box on a host with a device per card sees only its own");
});

test("071 unit 11: on WSL, where the CDI spec has only nvidia.com/gpu=all, every GPU box gets that device, the cards are read with it, each box's CUDA is pointed at its own card, and the words say a box with a GPU can open every card", async () => {
  const { fake, backend } = setup({ privileged: false }, WSL_TWO_CARDS);
  const first = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  const second = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.deepEqual(fake.inspect(first.ref).HostConfig.Devices, ["nvidia.com/gpu=all"]);
  assert.deepEqual(fake.inspect(second.ref).HostConfig.Devices, ["nvidia.com/gpu=all"]);
  assert.deepEqual([first.claim?.card, second.claim?.card], [CARD_A, CARD_B]);
  assert.ok(env(fake, second.ref).includes(`CUDA_VISIBLE_DEVICES=GPU-${CARD_B}`));
  assert.equal(fake.inspect(second.ref).Config.Labels["bbbox.gpu-card"], CARD_B);
  assert.equal(fact(second, "Cards"), "On fake-docker, Docker gives every card as one device, so every box with a GPU can open every card. Whole card is what bb-box places, not what a box can reach.");
  const probe = fake.calls().find((args) => args[0] === "container" && args[1] === "run" && args.at(-1)!.includes("--query-gpu"))!;
  assert.deepEqual(probe.filter((arg, at) => probe[at - 1] === "--device"), ["nvidia.com/gpu=all"]);
  const none = await backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.equal(fact(none, "Cards"), undefined, "an unprivileged box with no GPU gets no device on WSL");
  const privileged = setup({}, WSL_ONE_CARD);
  const box = await privileged.backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(fact(box, "Cards"), SERVER_REACH);
  assert.equal(fact(box, "GPU"), "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB");
});

test("071 unit 11: shared boxes per card count stopped boxes, boxes being made and other installs' boxes, and the refusal names them for each audience", async () => {
  const { fake, backend, make } = setup({ "desktops-per-gpu": 1 }, { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] }, { titles: { thr_abc123: "Train the model" } });
  const mine = await backend.acquire(identity("linux", "shared", "thr_abc123", "lone-pine"), null, hooks(), signal());
  await backend.stop(mine, signal());
  const full = await backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal(), { threadId: "thr_abc123" });
  assert.equal(full.ok, false);
  assert.equal(full.message, "No card on fake-docker can take a shared GPU now: card 0 has 1 box, the most a card may have (lone-pine (in thread \"Train the model\")). Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's Docker settings.");
  assert.equal(full.agentMessage, "Not made: no card on fake-docker can take a shared GPU now: card 0 has 1 box, the most a card may have (lone-pine). Release one of your own boxes on card 0 (lone-pine), ask for gpu none, or ask the user. bb-box changed nothing.");
  const other = await backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal(), { threadId: "thr_other" });
  assert.equal(other.agentMessage, "Not made: no card on fake-docker can take a shared GPU now: card 0 has 1 box, the most a card may have (lone-pine). Ask for gpu none, or ask the user. bb-box changed nothing.");
  await assert.rejects(backend.acquire(identity("linux", "shared"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /^Not made: no card/.test(error.agentMessage ?? ""));
  await backend.release(mine, { resetting: async () => {}, timing: () => {} }, signal());
  const theirs = make("other-install");
  await theirs.acquire(identity("linux", "shared", "thr_theirs", "amber-fox"), null, hooks(), signal());
  const blocked = await backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal(), { threadId: "thr_abc123" });
  assert.match(blocked.message!, /card 0 has 1 box, the most a card may have \(amber-fox of another install\)/);
  assert.equal(fake.containers().length, 1);
});

test("071 unit 11: a server needs 1,024 MiB free on its card when last read and a desktop 384 MiB, less what boxes being made reserve; a card whose memory is unknown takes a shared box but no whole one", async () => {
  const low = { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A, 900)] };
  const { backend } = setup({}, low, { whole: true });
  const server = await backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal());
  assert.equal(server.message, "No card on fake-docker can take a shared GPU now: card 0 has 900 MiB free when last read, less than the 1024 MiB a new server needs. Release a box on a card, ask for gpu none, or raise the boxes per card in BB Box's Docker settings.");
  assert.equal((await backend.capacity("linux-desktop", { ...SMALL, gpu: "shared" }, [], signal())).ok, true);
  const unknown = setup({}, { gpus: [DEVICE_A], cards: [{ ...card(0, CARD_A, DEVICE_A), freeMiB: "[N/A]" }] }, { whole: true });
  assert.equal((await unknown.backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true);
  assert.match((await unknown.backend.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal())).message!, /^No card on fake-docker is free for a whole card now: card 0's free memory could not be read\./);
});

test("071 unit 11: a whole box takes a card no box holds, and the card then takes no other box; whole is refused with the holders named, and while whole cards are off", async () => {
  const { backend } = setup({}, TWO_CARDS, { whole: true, titles: { thr_long: "Long job" } });
  const shared = await backend.acquire(identity("linux", "shared", "thr_abc123", "lone-pine"), null, hooks(), signal());
  assert.equal(shared.claim?.card, CARD_A);
  const whole = await backend.acquire(identity("linux", "whole", "thr_long", "quiet-elm"), null, hooks(), signal());
  assert.deepEqual(whole.claim, { card: CARD_B, part: "whole", generation: 1, answer: "granted" });
  assert.equal(fact(whole, "GPU"), "card 1, whole, NVIDIA GeForce RTX 5090, 32 GiB");
  const next = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(next.claim?.card, CARD_A, "a card held whole takes no shared box");
  const refused = await backend.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal(), { threadId: "thr_abc123" });
  assert.equal(refused.message, "No card on fake-docker is free for a whole card now: card 0 has lone-pine and quiet-elm-" + String(counter) + " running and card 1 is quiet-elm's whole card (in thread \"Long job\"). Release a box on one of the cards, or ask for gpu shared.");
  assert.equal(refused.agentMessage, "Not made: no card on fake-docker is free for a whole card now: card 0 has lone-pine and quiet-elm-" + String(counter) + " running and card 1 is quiet-elm's whole card. Release one of your own boxes on card 0 (lone-pine and quiet-elm-" + String(counter) + "), ask for gpu shared, or ask the user. bb-box changed nothing.");
  const off = setup().backend;
  const said = await off.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal());
  assert.match(said.message!, /^Whole cards are off on this install/);
  assert.match(said.agentMessage!, /^Not made: whole cards are off on this install/);
  await assert.rejects(off.acquire(identity("linux", "whole"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && /whole cards are off/.test(error.agentMessage ?? ""));
});

test("071 unit 11: two whole acquires at once for the only free card: one is made, and the other is refused before its container is made", async () => {
  const { fake, backend } = setup({}, { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] }, { whole: true });
  const results = await Promise.allSettled([backend.acquire(identity("linux", "whole"), null, hooks(), signal()), backend.acquire(identity("linux", "whole"), null, hooks(), signal())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"]);
  const refused = results.find((result) => result.status === "rejected") as PromiseRejectedResult;
  assert.match((refused.reason as BackendError).message, /^No card on fake-docker is free for a whole card now: card 0 /);
  assert.equal(fake.containers().length, 1);
  assert.equal(fake.calls().filter((args) => args[0] === "container" && args[1] === "create").length, 1);
});

test("071 unit 11: shared to whole and back are live on Docker: the plan says so, the switch is kept by this install and its claim's generation goes up; to whole is refused with the boxes on the card named; adding or removing a GPU cannot be done", async () => {
  const { backend, make } = setup({}, { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] }, { whole: true });
  const box = await backend.acquire(identity("linux", "shared", "thr_abc123", "amber-fox"), null, hooks(), signal());
  const plan = await backend.planResize(box, "linux", { ...SMALL, gpu: "whole" }, [], signal());
  assert.deepEqual(plan.parts, []);
  assert.equal(plan.gpu?.way, "live");
  assert.equal(plan.gpu?.refusal, null);
  assert.equal(plan.gpu?.words, `GPU: shared → whole card 0 · Live. Card 0 becomes amber-fox's alone: no other box is placed on it while amber-fox holds it. Nothing in amber-fox stops. ${SERVER_REACH}`);
  const whole = await backend.resize(box, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  assert.deepEqual(whole.claim, { card: CARD_A, part: "whole", generation: 2, answer: "granted" });
  assert.equal(fact(whole, "GPU"), "card 0, whole, NVIDIA GeForce RTX 5090, 32 GiB");
  assert.match((await backend.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).message!, /card 0 is amber-fox's whole card/);
  assert.equal((await backend.held(signal()))[0]!.claim?.part, "whole");
  const back = await backend.resize(whole, "linux", { ...SMALL, gpu: "shared" }, { restart: false }, signal());
  assert.deepEqual(back.claim, { card: CARD_A, part: "shared", generation: 3, answer: "granted" });
  const other = await backend.acquire(identity("linux", "shared", "thr_abc123", "lone-pine"), null, hooks(), signal());
  const refused = await backend.planResize(back, "linux", { ...SMALL, gpu: "whole" }, [], signal());
  assert.deepEqual(refused.gpu?.refusal, {
    person: "No card is free for amber-fox alone. Card 0 has lone-pine on it, and on Docker a box cannot move to another card. Release it, or keep the GPU shared.",
    agent: "Not resized: no card is free for amber-fox alone. Card 0 has lone-pine on it, and on Docker a box cannot move to another card. Keep the GPU shared, or ask the user. bb-box changed nothing.",
  });
  await assert.rejects(backend.resize(back, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
  const fixed = await backend.planResize(other, "linux", { ...SMALL, gpu: "none" }, [], signal());
  assert.equal(fixed.gpu?.way, "no");
  assert.match(fixed.gpu!.words, /^GPU: shared → none · Cannot change on Docker\. A container's devices are fixed when it is made, so lone-pine cannot lose card 0\. Make a new box with the GPU it needs\.$/);
  assert.deepEqual(fixed.gpu!.refusal, {
    person: "Lone-pine cannot lose card 0 on Docker: a container's devices are fixed when it is made. Make a new box with the GPU it needs.",
    agent: "Not resized: lone-pine cannot lose card 0 on Docker: a container's devices are fixed when it is made. Acquire a new box with the GPU it needs, or ask the user. bb-box changed nothing.",
  });
  await assert.rejects(backend.resize(other, "linux", { ...SMALL, gpu: "none" }, { restart: true }, signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported" && /^Not resized: lone-pine cannot lose card 0 on Docker/.test(error.agentMessage ?? ""));
  const plain = await backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.equal((await backend.planResize(plain, "linux", { ...SMALL, gpu: "shared" }, [], signal())).gpu?.way, "no");
  const theirs = make("other-install");
  assert.equal((await theirs.held(signal())).length, 0);
});

test("071 unit 11: a box whose CUDA picks another card than its own fails its check: the acquire is refused for each audience, its container removed, and its card left out for 10 minutes", async () => {
  const { fake, backend } = setup({}, { ...TWO_CARDS, cudaIgnoresVisible: true });
  await assert.rejects(backend.acquire(identity("linux", "shared"), null, hooks(), signal()).then(() => backend.acquire(identity("linux", "shared", "thr_abc123", "tidy-glade"), null, hooks(), signal())), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.message, `tidy-glade did not get card 1 on fake-docker: CUDA in it picks GPU-${CARD_A}, not its card GPU-${CARD_B}. bb-box removed it, and new boxes leave card 1 out for 10 minutes. Run bb box doctor.`);
    assert.equal(error.agentMessage, `Not made: tidy-glade did not get its card, card 1: CUDA in it picks GPU-${CARD_A}, not its card GPU-${CARD_B}. bb-box removed it. Ask the user.`);
    return true;
  });
  assert.equal(fake.containers().length, 1);
  const next = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(next.claim?.card, CARD_A, "card 1 is left out, though it has fewer boxes");
  const { backend: listing } = setup({}, { ...TWO_CARDS, smiListsNone: true });
  await assert.rejects(listing.acquire(identity("linux", "shared"), null, hooks(), signal()), /nvidia-smi in it listed no card, not its card/);
});

test("071 unit 11: a start of a GPU box checks its card again and gives its facts and claim; the share it was switched to holds", async () => {
  const { backend } = setup({}, TWO_CARDS, { whole: true });
  const box = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  const whole = await backend.resize(box, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  await backend.stop(whole, signal());
  const started = await backend.start(whole, signal());
  assert.ok(started);
  assert.deepEqual(started.claim, { card: CARD_A, part: "whole", generation: 2, answer: "granted" });
  assert.equal(started.facts?.find((each) => each.label === "GPU")?.value, "card 0, whole, NVIDIA GeForce RTX 5090, 32 GiB");
  assert.equal(started.facts?.filter((each) => each.label === "GPU").length, 1);
});

test("071 unit 11: box_list's room per card, with the reach words", async () => {
  const { backend } = setup({ "desktops-per-gpu": 2 }, TWO_CARDS, { whole: true });
  await backend.acquire(identity("linux", "whole", "thr_abc123", "quiet-elm"), null, hooks(), signal());
  const room = await backend.gpuRoom("linux");
  assert.deepEqual(room.parts, ["none", "shared", "whole"]);
  assert.equal(room.reach, SERVER_REACH);
  assert.deepEqual(room.cards?.map((each) => [each.index, each.boxes, each.whole, each.wholeBy, each.freeForWhole]), [
    [0, 1, true, "quiet-elm", false],
    [1, 0, false, null, true],
  ]);
  assert.equal(room.neededMiB, 1024);
  assert.equal(room.wholeOff, false);
  assert.equal((await backend.gpuRoom("linux-desktop")).neededMiB, 384);
  assert.deepEqual(await backend.gpuRoom("linux-desktop-cpu"), { readings: [], fullUntil: null });
  const none = await setup({}, {}).backend.gpuRoom("linux");
  assert.deepEqual([none.parts, none.withheld], [["none"], "fake-docker: it lists no NVIDIA card as a CDI device"]);
});

test("071 unit 11: the doctor lists the cards, warns of another install's GPU boxes, fails a whole card with another box on it, and warns of a card over its limit", async () => {
  const { fake, backend, make, context } = setup({ "desktops-per-gpu": 2 }, TWO_CARDS, { whole: true });
  const mine = await backend.acquire(identity("linux", "shared", "thr_abc123", "quiet-elm"), null, hooks(), signal());
  const healthy = await backend.doctor(signal());
  const gpus = healthy.checks.find((check) => check.id === "docker.gpus")!;
  assert.equal(gpus.status, "ok");
  assert.equal(gpus.detail, `2 NVIDIA cards as CDI devices (card 0, NVIDIA GeForce RTX 5090, 32 GiB, 30000 MiB free when read; card 1, NVIDIA GeForce RTX 5090, 32 GiB, 30000 MiB free when read), up to 2 boxes each. ${SERVER_REACH}`);
  await backend.resize(mine, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  assert.equal((await backend.doctor(signal())).checks.find((check) => check.id === `gpu.${CARD_A}.whole`)?.status, "ok");
  const theirs = make("other-install");
  await theirs.acquire(identity("linux", "shared", "thr_theirs", "amber-fox"), null, hooks(), signal());
  await theirs.acquire(identity("linux", "shared", "thr_theirs", "calm-reef"), null, hooks(), signal());
  const report = await backend.doctor(signal());
  const listed = report.checks.find((check) => check.id === "docker.gpus")!;
  assert.equal(listed.status, "warn");
  assert.match(listed.detail, /Another install's GPU boxes are on fake-docker: amber-fox and calm-reef\. bb-box counts them on their cards, but sees the GPU part they were made with, not a later switch/);
  const wrong = report.checks.find((check) => check.id === `gpu.${CARD_A}.whole`)!;
  assert.equal(wrong.status, "fail");
  assert.equal(wrong.detail, "Card 0 is held whole by quiet-elm, and calm-reef of another install is on it too: a placement went wrong.");
  const lower = new DockerBackend(dockerConfig({ "gpu-desktops": true, "desktops-per-gpu": 1 }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const limits = (await lower.doctor(signal())).checks.filter((check) => check.id.endsWith(".limit"));
  assert.deepEqual(limits.map((check) => [check.id, check.status, check.detail]), [[`gpu.${CARD_A}.limit`, "warn", "Card 0 has 2 boxes, 1 over the limit of 1: quiet-elm and calm-reef of another install. They keep running; no new box goes on card 0 until it has room."]]);
});

test("071 unit 11: the cards read from a probe container: per-UUID devices, devices named by index, and WSL's one device for every card; a probe that fails leaves UUID-named cards with nothing read", () => {
  const probed = parseProbe(`0, GPU-${CARD_A}, NVIDIA GeForce RTX 5090, 32607, 31000\n1, GPU-${CARD_B}, NVIDIA GeForce RTX 5090, 32607, [N/A]\nnoise\n`);
  assert.deepEqual(probed, [
    { index: 0, uuid: CARD_A, model: "NVIDIA GeForce RTX 5090", totalMiB: 32607, freeMiB: 31000 },
    { index: 1, uuid: CARD_B, model: "NVIDIA GeForce RTX 5090", totalMiB: 32607, freeMiB: null },
  ]);
  assert.deepEqual(cardsOnHost({ devices: ["nvidia.com/gpu=1", "nvidia.com/gpu=0"], allListed: true, probed, readAt: 5, unread: null }).cards.map((each) => [each.index, each.uuid, each.device]), [
    [0, CARD_A, "nvidia.com/gpu=0"],
    [1, CARD_B, "nvidia.com/gpu=1"],
  ]);
  const wsl = cardsOnHost({ devices: [], allListed: true, probed, readAt: 5, unread: null });
  assert.equal(wsl.oneDeviceForEveryCard, true);
  assert.deepEqual(wsl.cards.map((each) => each.device), ["nvidia.com/gpu=all", "nvidia.com/gpu=all"]);
  const unread = cardsOnHost({ devices: [DEVICE_B, "nvidia.com/gpu=0"], allListed: false, probed: null, readAt: null, unread: "exit code 125" });
  assert.deepEqual(unread.cards.map((each) => [each.index, each.uuid, each.freeMiB]), [[null, CARD_B, null]]);
  assert.deepEqual(cardsOnHost({ devices: [], allListed: true, probed: null, readAt: null, unread: "no nvidia-smi" }).cards, []);
});

test("071 unit 11: placement's order: shared goes to the fewest boxes, then the most free, then the lowest index; whole to the least used card", () => {
  const cards: DockerCard[] = [
    { uuid: CARD_A, index: 0, model: "m", totalMiB: 32_000, freeMiB: 20_000, device: DEVICE_A },
    { uuid: CARD_B, index: 1, model: "m", totalMiB: 32_000, freeMiB: 25_000, device: DEVICE_B },
  ];
  const holder = (cardId: string, part: "shared" | "whole" = "shared"): CardHolder => ({ card: cardId, part, name: "x", threadId: null, otherInstall: false, state: "running", container: `c-${Math.random()}`, needMiB: 0 });
  const ask = { needMiB: 1024, what: "server" as const, cards, perCard: 4, avoided: new Set<string>() };
  const placed = (result: ReturnType<typeof placeCard>) => (result.is === "placed" ? result.card.index : null);
  assert.equal(placed(placeCard({ ...ask, part: "shared", holders: [] })), 1);
  assert.equal(placed(placeCard({ ...ask, part: "shared", holders: [holder(CARD_B)] })), 0);
  assert.equal(placed(placeCard({ ...ask, part: "whole", holders: [] })), 1);
  assert.equal(placed(placeCard({ ...ask, part: "whole", holders: [holder(CARD_B)] })), 0);
  assert.equal(placed(placeCard({ ...ask, part: "shared", holders: [holder(CARD_A), holder(CARD_B, "whole")] })), 0);
  assert.equal(placed(placeCard({ ...ask, part: "shared", holders: [], avoided: new Set([CARD_B]) })), 0);
  const making: CardHolder = { ...holder(CARD_B), state: "making", needMiB: 24_500 };
  assert.equal(placed(placeCard({ ...ask, part: "shared", holders: [making] })), 0, "memory a box being made needs is taken off its card's reading");
  const refused = placeCard({ ...ask, part: "whole", holders: [holder(CARD_A), making] });
  assert.equal(refused.is, "refused");
  const words = placementRefusal("docker-1", "whole", "server", refused.is === "refused" ? refused.blocks : [], new Map(), null);
  assert.equal(words.agent, "Not made: no card on docker-1 is free for a whole card now: card 0 has x running and card 1 has x, which bb-box is making. Ask for gpu shared, or ask the user. bb-box changed nothing.");
});

test("071 unit 11: the card check names a CUDA that picks no card or another, and passes a box with no Python on nvidia-smi alone", () => {
  const smi = `GPU-${CARD_A}, NVIDIA GeForce RTX 5090, 32607\nGPU-${CARD_B}, NVIDIA GeForce RTX 5090, 32607`;
  const done = "userspace none\ncard check done";
  const hex = (uuid: string) => uuid.replaceAll("-", "");
  assert.equal(judgeDockerCardCheck(`cudacard 0 1 ${hex(CARD_A)}\n${smi}\ncuinit 0\n${done}`, CARD_A).ok, true);
  const other = judgeDockerCardCheck(`cudacard 0 1 ${hex(CARD_B)}\n${smi}\ncuinit 0\n${done}`, CARD_A);
  assert.equal(other.ok ? null : other.why, `CUDA in it picks GPU-${CARD_B}, not its card GPU-${CARD_A}`);
  const none = judgeDockerCardCheck(`cudacard 100 0 none\n${smi}\ncuinit 100\n${done}`, CARD_A);
  assert.equal(none.ok, false);
  assert.equal(judgeDockerCardCheck(`${smi}\ncuinit no-python\n${done}`, CARD_A).ok, true);
  assert.equal(judgeDockerCardCheck(`${smi}\ncuinit 0\n${done}`, CARD_A).ok, false, "a Python that gave no CUDA card answer fails");
});

test("071 unit 11: the environment script points CUDA at the card in /etc/environment and keeps the file's other lines; with no card it takes the lines out", () => {
  const dir = tempDir("environment");
  const file = join(dir, "environment");
  writeFileSync(file, `PATH="/usr/local/bin:/usr/bin"\nCUDA_VISIBLE_DEVICES="GPU-old"\nLANG=C.UTF-8\n`);
  const run = (card: string | null) => execFileSync("sh", ["-c", environmentScript(card).replaceAll("/etc/environment", file)]);
  run(CARD_A);
  assert.equal(readFileSync(file, "utf8"), `PATH="/usr/local/bin:/usr/bin"\nLANG=C.UTF-8\nCUDA_VISIBLE_DEVICES="GPU-${CARD_A}"\nNVIDIA_VISIBLE_DEVICES="GPU-${CARD_A}"\n`);
  run(CARD_A);
  assert.equal(readFileSync(file, "utf8").match(/CUDA_VISIBLE_DEVICES/g)?.length, 1);
  run(null);
  assert.equal(readFileSync(file, "utf8"), `PATH="/usr/local/bin:/usr/bin"\nLANG=C.UTF-8\n`);
  assert.equal(reachWords("h", false, false), null);
});
