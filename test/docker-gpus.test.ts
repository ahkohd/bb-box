import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { Backends } from "../src/backends/index.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import type { DockerConfig } from "../src/backends/docker/config.ts";
import type { ConfigDocument } from "../src/core/document.ts";
import { cardsOnHost, environmentScript, judgeDockerCardCheck, parseProbe, placeCard, placementRefusal, reachWords, wrongCard, type CardHolder, type DockerCard } from "../src/backends/docker/gpus.ts";
import { BackendError, type AcquireHooks, type BackendContext, type BoxIdentity, type FieldValue, type GpuPart, type Guest, type MachineSize } from "../src/backends/types.ts";
import { cardReachText } from "../src/plugin/tools.ts";
import type { KindView } from "../src/plugin/views.ts";
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

function setup(values: Record<string, FieldValue> = {}, host: Record<string, unknown> = TWO_CARDS, options: { whole?: boolean; titles?: Record<string, string>; installId?: string; now?: () => number } = {}) {
  const fake = fakeDockerHost(host);
  const config = dockerConfig({ "gpu-desktops": true, ...values });
  const contextFor = (installId: string) => ({ ...testContext(new MemoryStorage(), installId), wholeCards: () => options.whole ?? false, threadTitle: async (threadId: string) => options.titles?.[threadId] ?? null });
  const context = contextFor(options.installId ?? "test");
  const backendOptions = { binary: fake.binary, readyTimeoutMs: 2_000, ...(options.now ? { now: options.now } : {}) };
  const make = (installId: string) => new DockerBackend(config, contextFor(installId), backendOptions);
  return { fake, context, make, backend: new DockerBackend(config, context, backendOptions) };
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

test("071 unit 11: a fresh box whose CUDA picks another card is removed, its card left out, and made again on another card within the acquire", async () => {
  const { fake, backend } = setup({}, { ...TWO_CARDS, cudaIgnoresVisible: true });
  const first = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(first.claim?.card, CARD_A);
  const claimed: Guest[] = [];
  const moved = await backend.acquire(identity("linux", "shared", "thr_abc123", "tidy-glade"), null, { ...hooks(), claim: async (guest) => void claimed.push(guest) }, signal());
  assert.equal(moved.claim?.card, CARD_A, "card 1 failed its check, so the box was made again on card 0");
  assert.deepEqual(claimed.map((guest) => guest.data?.card ?? null), [CARD_B, CARD_A, CARD_A], "the acquire's record follows the box to its new card");
  assert.equal(fake.inspect(moved.ref).Config.Labels["bbbox.gpu-card"], CARD_A);
  assert.equal(fake.containers().length, 2);
  const next = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(next.claim?.card, CARD_A, "card 1 is left out, though it has fewer boxes");
});

test("071 unit 11: a fresh box whose CUDA finds no card, as cuInit 100 says, is made again once; when both cards fail, or no other card can take it, it is refused for each audience and nothing is left", async () => {
  const both = setup({}, { ...TWO_CARDS, cudaNoDevice: true });
  await assert.rejects(both.backend.acquire(identity("linux", "shared", "thr_abc123", "tidy-glade"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "no_capacity");
    const why = (card: string) => `CUDA in it found no card it may use with CUDA_VISIBLE_DEVICES=GPU-${card}: it returned 100`;
    assert.equal(error.message, `tidy-glade did not get its card on fake-docker: card 0: ${why(CARD_A)}; then card 1: ${why(CARD_B)}. bb-box removed what it made, and new boxes leave card 0 and card 1 out for 10 minutes. Run bb box doctor.`);
    assert.equal(error.agentMessage, `Not made: tidy-glade did not get its card: card 0: ${why(CARD_A)}; then card 1: ${why(CARD_B)}. bb-box removed what it made. Ask the user.`);
    return true;
  });
  assert.deepEqual(both.fake.containers(), []);
  const one = setup({}, { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], cudaNoDevice: true });
  await assert.rejects(one.backend.acquire(identity("linux", "shared", "thr_abc123", "tidy-glade"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.match(error.message, /^tidy-glade did not get its card on fake-docker: card 0: CUDA in it found no card .*\. bb-box removed what it made, and new boxes leave card 0 out for 10 minutes\. No other card could take it: No card on fake-docker can take a shared GPU now: card 0 is left out for now, as a box lately did not see it\. Release a box on a card, ask for gpu none/);
    assert.match(error.agentMessage ?? "", /^Not made: tidy-glade did not get its card: card 0: .*\. bb-box removed what it made\. No other card could take it: no card on fake-docker can take a shared GPU now: card 0 is left out for now, as a box lately did not see it\. Ask for gpu none, or ask the user\.$/);
    return true;
  });
  assert.deepEqual(one.fake.containers(), []);
  const { backend: listing } = setup({}, { ...TWO_CARDS, smiListsNone: true });
  await assert.rejects(listing.acquire(identity("linux", "shared"), null, hooks(), signal()), /nvidia-smi in it listed no card, not its card/);
});

test("071 unit 11: two backends of one install on one Docker daemon share its card lock and reservations; only the one whose ID sorts first places GPU boxes there, boxes with no GPU are made through either, and the doctor warns", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] });
  const config = dockerConfig({ "gpu-desktops": true });
  const make = (id: string, on: () => boolean = () => true) => new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), wholeCards: () => true, on }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const first = make("docker");
  const twin = make("docker");
  const results = await Promise.allSettled([first.acquire(identity("linux", "whole"), null, hooks(), signal()), twin.acquire(identity("linux", "whole"), null, hooks(), signal())]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["fulfilled", "rejected"], "two instances of one backend, as a settings check makes, share the card lock and its reservations");
  assert.equal(fake.calls().filter((args) => args[0] === "container" && args[1] === "create").length, 1);
  const whole = (results.find((result) => result.status === "fulfilled") as PromiseFulfilledResult<Guest>).value;
  const second = make("docker:second");
  assert.equal((await second.capacity("linux", { ...SMALL, gpu: "none" }, [], signal())).ok, true, "a box with no GPU is never stopped by another backend on the daemon");
  const plain = await second.acquire(identity("linux", "none"), null, hooks(), signal());
  const shared = await second.planResize(whole, "linux", { ...SMALL, gpu: "shared" }, [], signal());
  assert.match(shared.gpu?.refusal?.agent ?? "", /^Not resized: Docker on fake-docker reaches the same Docker daemon as another backend, so bb-box places no GPU box through it/);
  await first.release(whole, { resetting: async () => {}, timing: () => {} }, signal());
  const refused = await second.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal());
  assert.equal(refused.message, "Docker on fake-docker reaches the same Docker daemon as the backend docker, so bb-box places no GPU box through it: two backends on one daemon would each count only their own boxes on its cards. Ask for gpu none here, or remove one of them in BB Box's settings.");
  assert.equal(refused.agentMessage, "Not made: Docker on fake-docker reaches the same Docker daemon as another backend, so bb-box places no GPU box through it. Ask for gpu none, or for another provider, or ask the user. bb-box changed nothing.");
  await assert.rejects(second.acquire(identity("linux", "shared"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && /places no GPU box through it/.test(error.message));
  assert.equal((await first.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true);
  const doctor = async (backend: DockerBackend) => (await backend.doctor(signal())).checks.find((check) => check.id === "docker.one-backend");
  assert.deepEqual([(await doctor(second))?.status, (await doctor(first))?.status], ["warn", "warn"]);
  assert.match((await doctor(second))!.detail, /places no GPU box through it, .* Boxes with no GPU are made as usual\.$/);
  await second.release(plain, { resetting: async () => {}, timing: () => {} }, signal());
  await first.dispose();
  await twin.dispose();
  assert.equal((await second.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true, "once the other backend is gone, this one places GPU boxes");
});

test("071 unit 11: a backend that is off, or that only listed, released or kept up its boxes, keeps no other backend on the daemon from placing GPU boxes", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] });
  const config = dockerConfig({ "gpu-desktops": true });
  let oldOn = true;
  const make = (id: string, on: () => boolean) => new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), wholeCards: () => true, on }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const old = make("a-old-docker", () => oldOn);
  const fresh = make("b-new-docker", () => true);
  await old.held(signal());
  await old.maintain(signal());
  assert.equal((await fresh.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true, "listing and upkeep do not count a backend as placing");
  await old.capacity("linux", { ...SMALL, gpu: "none" }, [], signal());
  assert.equal((await fresh.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, false, "once it places, the backend sorting first is the daemon's");
  oldOn = false;
  assert.equal((await fresh.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true, "a backend that is off does not count");
});

test("071 unit 11: a daemon is known by its engine ID with its name and Docker root, so cloned hosts that kept one engine ID are two daemons", async () => {
  const config = dockerConfig({ "gpu-desktops": true });
  const one = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], daemonId: "CLONED:ENGINE:ID", name: "clone-a" });
  const two = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], daemonId: "CLONED:ENGINE:ID", name: "clone-b" });
  const three = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], daemonId: "CLONED:ENGINE:ID", name: "clone-a", rootDir: "/srv/docker-two" });
  const make = (id: string, fake: ReturnType<typeof fakeDockerHost>) => new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const a = make("docker:a", one);
  const b = make("docker:b", two);
  const c = make("docker:c", three);
  await a.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal());
  assert.equal((await b.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true, "another host's name");
  assert.equal((await c.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, true, "another Docker root on one host");
  assert.equal((await b.doctor(signal())).checks.find((check) => check.id === "docker.one-backend"), undefined);
});

test("071 unit 11: a share switch made through one instance of a backend holds for another instance of it, as after a restart, on the same storage", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] });
  const config = dockerConfig({ "gpu-desktops": true });
  const storage = new MemoryStorage();
  const make = () => new DockerBackend(config, { ...testContext(storage, "test", { id: "docker" }), wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const live = make();
  const check = make();
  const box = await live.acquire(identity("linux", "shared", "thr_abc123", "amber-fox"), null, hooks(), signal());
  await live.resize(box, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  assert.match((await check.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).message ?? "", /card 0 is amber-fox's whole card/);
});

test("071 unit 11: a share switch holds for every backend on the daemon, one turned off and one made later too, and its record goes with its container", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)] });
  const config = dockerConfig({ "gpu-desktops": true });
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const everyBackend = backends.context("docker:a-old").sharedStorage!;
  let oldOn = true;
  const made: DockerBackend[] = [];
  const reached = async (signal?: AbortSignal) => (await Promise.all(made.map((backend) => backend.dockerDaemons(signal)))).flat();
  const make = (id: string, on: () => boolean) => {
    const backend = new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), sharedStorage: backends.context(id).sharedStorage!, dockerDaemonsReached: reached, wholeCards: () => true, on }, { binary: fake.binary, readyTimeoutMs: 2_000 });
    made.push(backend);
    return backend;
  };
  const old = make("docker:a-old", () => oldOn);
  const box = await old.acquire(identity("linux", "shared", "thr_abc123", "amber-fox"), null, hooks(), signal());
  assert.equal((await old.resize(box, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal())).claim?.part, "whole");
  oldOn = false;
  const next = make("docker:b-next", () => true);
  await assert.rejects(next.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is amber-fox's whole card/);
  assert.equal(fake.containers().length, 1);
  assert.deepEqual((await next.held(signal())).map((each) => [each.claim?.card, each.claim?.part]), [[CARD_A, "whole"]]);
  assert.equal((await next.doctor(signal())).checks.find((check) => check.id === `gpu.${CARD_A}.whole`)?.status, "ok");
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 1);
  execFileSync(fake.binary, ["container", "rm", "--force", fake.inspect(box.ref).Id]);
  await next.maintain(signal());
  assert.deepEqual(await everyBackend.list("docker/gpu-part/"), [], "a container removed outside bb-box loses its record at the next upkeep");
  const again = await next.acquire(identity("linux", "shared", "thr_abc123", "birch-owl"), null, hooks(), signal());
  await next.resize(again, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 1);
  await next.release(again, { resetting: async () => {}, timing: () => {} }, signal());
  assert.deepEqual(await everyBackend.list("docker/gpu-part/"), [], "a release drops its record");
  const other = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], name: "other-host" });
  const elsewhere = new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id: "docker:elsewhere" }), sharedStorage: backends.context("docker:elsewhere").sharedStorage!, wholeCards: () => true }, { binary: other.binary, readyTimeoutMs: 2_000 });
  const far = await elsewhere.acquire(identity("linux", "shared", "thr_abc123", "cedar-elk"), null, hooks(), signal());
  await elsewhere.resize(far, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  await next.maintain(signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 1, "one daemon's upkeep keeps another daemon's records");
});

test("071 unit 11: a switched part is found by its container's ID, so a box switched to whole keeps its card after its host is renamed, for the backend that switched it and one made after, and the renamed daemon's upkeep drops its records of containers gone", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], name: "before-rename" });
  const config = dockerConfig({ "gpu-desktops": true });
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const everyBackend = backends.context("docker").sharedStorage!;
  let reachKnown = true;
  const make = (): DockerBackend => {
    const made: DockerBackend = new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id: "docker" }), sharedStorage: backends.context("docker").sharedStorage!, dockerDaemonsReached: async (signal) => (reachKnown ? made.dockerDaemons(signal) : null), wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 });
    return made;
  };
  const live = make();
  const box = await live.acquire(identity("linux", "shared", "thr_abc123", "amber-fox"), null, hooks(), signal());
  await live.resize(box, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  fake.set({ name: "after-rename" });
  await assert.rejects(live.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is amber-fox's whole card/);
  const reconnected = make();
  await assert.rejects(reconnected.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is amber-fox's whole card/);
  assert.equal(fake.containers().length, 1);
  assert.equal((await reconnected.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, false);
  assert.deepEqual((await reconnected.held(signal())).map((each) => [each.host, each.claim?.part, each.claim?.generation]), [["after-rename", "whole", 2]]);
  assert.equal((await reconnected.planResize(box, "linux", { ...SMALL, gpu: "shared" }, [], signal())).gpu?.from, "whole");
  assert.equal((await reconnected.doctor(signal())).checks.find((check) => check.id === `gpu.${CARD_A}.whole`)?.status, "ok");
  execFileSync(fake.binary, ["container", "rm", "--force", fake.inspect(box.ref).Id]);
  reachKnown = false;
  await reconnected.maintain(signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 1, "while bb-box cannot tell which daemons it reaches, a record written under another name is kept");
  reachKnown = true;
  await reconnected.maintain(signal());
  assert.deepEqual(await everyBackend.list("docker/gpu-part/"), [], "written under this daemon's engine ID with a name no daemon reached has now, so its upkeep drops it once its container is gone");
});

test("071 unit 11: two cloned hosts with one engine ID keep each other's switches through their upkeep, a record going only once no daemon reached lists its container", async () => {
  const config = dockerConfig({ "gpu-desktops": true });
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const everyBackend = backends.context("docker").sharedStorage!;
  const hostA = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], daemonId: "CLONED:ENGINE:ID", name: "clone-a" });
  const hostB = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], daemonId: "CLONED:ENGINE:ID", name: "clone-b" });
  const made: DockerBackend[] = [];
  const reached = async (signal?: AbortSignal) => (await Promise.all(made.map((backend) => backend.dockerDaemons(signal)))).flat();
  const make = (id: string, host: ReturnType<typeof fakeDockerHost>) => {
    const backend = new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), sharedStorage: backends.context(id).sharedStorage!, dockerDaemonsReached: reached, wholeCards: () => true }, { binary: host.binary, readyTimeoutMs: 2_000 });
    made.push(backend);
    return backend;
  };
  const a = make("docker:a", hostA);
  const b = make("docker:b", hostB);
  const onA = await a.acquire(identity("linux", "shared", "thr_abc123", "amber-fox"), null, hooks(), signal());
  await a.resize(onA, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  const onB = await b.acquire(identity("linux", "shared", "thr_abc123", "birch-owl"), null, hooks(), signal());
  await b.resize(onB, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  await a.maintain(signal());
  await b.maintain(signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 2, "neither clone's upkeep drops the other's record");
  await assert.rejects(a.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is amber-fox's whole card/);
  await assert.rejects(b.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is birch-owl's whole card/);
  assert.equal((await b.doctor(signal())).checks.find((check) => check.id === "docker.one-backend"), undefined, "clones are two daemons, not two backends on one");
  execFileSync(hostB.binary, ["container", "rm", "--force", hostB.inspect(onB.ref).Id]);
  await a.maintain(signal());
  assert.deepEqual(await everyBackend.list("docker/gpu-part/"), [`docker/gpu-part/${hostA.inspect(onA.ref).Id}`], "once no daemon reached lists a container, an upkeep on its engine ID drops its record");
});

test("071 unit 11: Astra's round 5: a clone renamed after both clones switched a box to whole keeps its switch through the other clone's upkeep", async () => {
  const config = dockerConfig({ "gpu-desktops": true });
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const everyBackend = backends.context("docker").sharedStorage!;
  const hostA = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], daemonId: "CLONED:ENGINE:ID", name: "clone-a" });
  const hostB = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], daemonId: "CLONED:ENGINE:ID", name: "clone-b" });
  const made: DockerBackend[] = [];
  const reached = async (signal?: AbortSignal) => (await Promise.all(made.map((backend) => backend.dockerDaemons(signal)))).flat();
  const make = (id: string, host: ReturnType<typeof fakeDockerHost>) => {
    const backend = new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), sharedStorage: backends.context(id).sharedStorage!, dockerDaemonsReached: reached, wholeCards: () => true }, { binary: host.binary, readyTimeoutMs: 2_000 });
    made.push(backend);
    return backend;
  };
  const a = make("docker:a", hostA);
  const b = make("docker:b", hostB);
  const onA = await a.acquire(identity("linux", "shared", "thr_abc123", "whole-a"), null, hooks(), signal());
  const wholeA = await a.resize(onA, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  const onB = await b.acquire(identity("linux", "shared", "thr_abc123", "whole-b"), null, hooks(), signal());
  await b.resize(onB, "linux", { ...SMALL, gpu: "whole" }, { restart: false }, signal());
  await a.maintain(signal());
  await b.maintain(signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 2);
  hostA.set({ name: "renamed-clone-a" });
  await b.maintain(signal());
  assert.equal((await everyBackend.list("docker/gpu-part/")).length, 2, "the renamed clone still lists its container, so its record stays");
  await assert.rejects(a.acquire(identity("linux", "shared", "thr_abc123", "intruder-a"), null, hooks(), signal()), /card 0 is whole-a's whole card/);
  assert.equal(wholeA.claim?.part, "whole");
  assert.equal(hostA.containers().length, 1);
});

test("071 unit 11: Astra's round 5: a rename while an acquire is making its box keeps the daemon's lock and the pending whole card's reservation", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], name: "before-reservation-rename" });
  const { backend } = (() => {
    const config = dockerConfig({ "gpu-desktops": true });
    return { backend: new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id: "docker" }), wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 }) };
  })();
  let resume!: () => void;
  let paused!: () => void;
  const claimed = new Promise<void>((resolve) => (paused = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  let held = false;
  const pending = backend.acquire(identity("linux", "whole", "thr_abc123", "pending-whole"), null, { ...hooks(), claim: async () => { if (held) return; held = true; paused(); await resumed; } }, signal());
  try {
    await claimed;
    assert.equal(fake.containers().length, 0);
    fake.set({ name: "after-reservation-rename" });
    await assert.rejects(backend.acquire(identity("linux", "shared", "thr_abc123", "intruder-pending"), null, hooks(), signal()), /card 0 is kept whole for pending-whole, which bb-box is making/);
  } finally {
    resume();
  }
  const whole = await pending;
  assert.equal(whole.claim?.part, "whole");
  assert.equal(fake.containers().length, 1);
});

test("071 unit 11: a box one clone is making counts against that clone's room alone, though clones with one engine ID share a lock and its reservations", async () => {
  const config = dockerConfig({ "gpu-desktops": true, "reserve-memory-mib": 4096 });
  const hostA = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], daemonId: "CLONED:ENGINE:ID", name: "clone-a", memoryMiB: 12_288 });
  const hostB = fakeDockerHost({ gpus: [DEVICE_B], cards: [card(0, CARD_B, DEVICE_B)], daemonId: "CLONED:ENGINE:ID", name: "clone-b", memoryMiB: 12_288 });
  const make = (id: string, host: ReturnType<typeof fakeDockerHost>) => new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), wholeCards: () => true }, { binary: host.binary, readyTimeoutMs: 2_000 });
  const a = make("docker:a", hostA);
  const b = make("docker:b", hostB);
  const big = { ...SMALL, memoryMiB: 6_144, gpu: "none" as const };
  let resume!: () => void;
  let paused!: () => void;
  const claimed = new Promise<void>((resolve) => (paused = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  const pending = b.acquire({ ...identity("linux", "none", "thr_abc123", "big-on-b"), size: big }, null, { ...hooks(), claim: async () => { paused(); await resumed; } }, signal());
  try {
    await claimed;
    assert.equal((await a.capacity("linux", big, [], signal())).ok, true, "the box clone-b is making takes none of clone-a's memory");
    assert.equal((await b.capacity("linux", big, [], signal())).ok, false, "it takes clone-b's");
  } finally {
    resume();
  }
  await pending;
});

test("071 unit 11: Astra's round 6: after a rename, another backend on the daemon still counts a pending whole card, judged by its owner's daemon read now", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], name: "before-rename" });
  const config = dockerConfig({ "gpu-desktops": true });
  const sharedStorage = new MemoryStorage();
  const make = (id: string) => new DockerBackend(config, { ...testContext(new MemoryStorage(), "test", { id }), sharedStorage, wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const a = make("docker:a");
  const b = make("docker:b");
  let resume!: () => void;
  let paused!: () => void;
  const claimed = new Promise<void>((resolve) => (paused = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  let held = false;
  const pending = a.acquire(identity("linux", "whole", "thr_abc123", "pending-whole"), null, { ...hooks(), claim: async () => { if (held) return; held = true; paused(); await resumed; } }, signal());
  try {
    await claimed;
    assert.equal((await b.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal())).ok, false);
    fake.set({ name: "after-rename" });
    await assert.rejects(b.acquire(identity("linux", "shared", "thr_abc123", "second-box"), null, hooks(), signal()), /card 0 is kept whole for pending-whole, which bb-box is making/);
    await a.dispose();
    await assert.rejects(b.acquire(identity("linux", "shared", "thr_abc123", "third-box"), null, hooks(), signal()), /card 0 is kept whole for pending-whole, which bb-box is making/, "a reservation whose owner cannot be asked still counts");
  } finally {
    resume();
  }
  await pending;
  await a.dispose();
  await b.dispose();
  assert.equal(fake.containers().length, 1, "a whole card has one box");
});

test("071 unit 11: Astra's round 6: a reconfigure while a box with no GPU is being made keeps its reservation for the new instance and drops it when the acquire ends", async () => {
  const fake = fakeDockerHost();
  const driver = { ...dockerDriver, create: (config: DockerConfig, context: BackendContext) => new DockerBackend(config, context, { binary: fake.binary, readyTimeoutMs: 2_000 }) };
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {}, drivers: [driver] });
  const document = (boxes: number): ConfigDocument => ({ schema: 1, revision: boxes, backends: [{ id: "docker", type: "docker", enabled: true, fields: { boxes } }], kinds: {}, general: {} });
  try {
    await backends.configure(document(2), {});
    const old = backends.get("docker")!;
    let resume!: () => void;
    let paused!: () => void;
    const claimed = new Promise<void>((resolve) => (paused = resolve));
    const resumed = new Promise<void>((resolve) => (resume = resolve));
    let held = false;
    const pending = old.acquire(identity("linux", "none", "thr_abc123", "pending-cpu"), null, { ...hooks(), claim: async () => { if (held) return; held = true; paused(); await resumed; } }, signal());
    try {
      await claimed;
      await backends.configure(document(1), {});
      const fresh = backends.get("docker")!;
      assert.notEqual(fresh, old);
      assert.equal((await fresh.capacity("linux", { ...SMALL, gpu: "none" }, [], signal())).ok, false, "the new instance counts the box the old one is making");
    } finally {
      resume();
    }
    const box = await pending;
    const fresh = backends.get("docker")!;
    await fresh.release(box, { resetting: async () => {}, timing: () => {} }, signal());
    assert.equal(fake.containers().length, 0);
    assert.equal((await fresh.capacity("linux", { ...SMALL, gpu: "none" }, [], signal())).ok, true, "the acquire dropped its reservation from the share it made it in");
  } finally {
    await backends.dispose();
  }
});

test("071 unit 11: after a rename, a backend still counts its own pending whole card, though a settings check's instance of it last read the old name", async () => {
  const fake = fakeDockerHost({ gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], name: "before-rename" });
  const config = dockerConfig({ "gpu-desktops": true });
  const storage = new MemoryStorage();
  const make = () => new DockerBackend(config, { ...testContext(storage, "test", { id: "docker" }), wholeCards: () => true }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const live = make();
  const check = make();
  let resume!: () => void;
  let paused!: () => void;
  const claimed = new Promise<void>((resolve) => (paused = resolve));
  const resumed = new Promise<void>((resolve) => (resume = resolve));
  let held = false;
  const pending = live.acquire(identity("linux", "whole", "thr_abc123", "pending-whole"), null, { ...hooks(), claim: async () => { if (held) return; held = true; paused(); await resumed; } }, signal());
  try {
    await claimed;
    await check.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal());
    fake.set({ name: "after-rename" });
    await assert.rejects(live.acquire(identity("linux", "shared"), null, hooks(), signal()), /card 0 is kept whole for pending-whole, which bb-box is making/);
  } finally {
    resume();
  }
  await pending;
  assert.equal(fake.containers().length, 1);
});

test("071 unit 11: the daemons an install reaches are every Docker backend's, on or off, and none are known while one of them does not answer", async () => {
  const one = fakeDockerHost({ name: "host-one" });
  const two = fakeDockerHost({ name: "host-two" });
  const binaries: Record<string, string> = { "ssh://box@one.example": one.binary, "ssh://box@two.example": two.binary };
  const driver = { ...dockerDriver, create: (config: DockerConfig, context: BackendContext) => new DockerBackend(config, context, { binary: binaries[config.host ?? ""]! }) };
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {}, drivers: [driver] });
  const document: ConfigDocument = {
    schema: 1,
    revision: 1,
    backends: [
      { id: "docker", type: "docker", enabled: true, fields: { host: "ssh://box@one.example" } },
      { id: "docker:two", type: "docker", enabled: false, fields: { host: "ssh://box@two.example" } },
    ],
    kinds: {},
    general: {},
  };
  try {
    await backends.configure(document, {});
    assert.deepEqual(((await backends.context("docker").dockerDaemonsReached!(signal())) ?? []).map((daemon) => daemon.name).sort(), ["host-one", "host-two"]);
    two.set({ down: true });
    assert.equal(await backends.context("docker").dockerDaemonsReached!(signal()), null);
  } finally {
    await backends.dispose();
  }
});

test("071 unit 11: a failed probe keeps each card's key and its last reading's name, so a card held whole takes no shared box; its free memory is unknown and no whole card is placed", async () => {
  let clock = 1_800_000_000_000;
  const devices = ["nvidia.com/gpu=0", "nvidia.com/gpu=1"];
  const host = { gpus: devices, cards: [card(0, CARD_A, devices[0]!), card(1, CARD_B, devices[1]!)] };
  const { fake, backend } = setup({ "desktops-per-gpu": 4 }, host, { whole: true, now: () => clock });
  const whole = await backend.acquire(identity("linux", "whole", "thr_abc123", "quiet-elm"), null, hooks(), signal());
  assert.equal(whole.claim?.card, CARD_A);
  fake.set({ probeFails: "docker: Error response from daemon: the toolkit's hook failed" });
  clock += 70_000;
  const room = await backend.gpuRoom("linux");
  assert.deepEqual(room.cards?.map((each) => [each.index, each.totalMiB, each.freeMiB, each.whole, each.wholeBy]), [
    [0, 32_607, null, true, "quiet-elm"],
    [1, 32_607, null, false, null],
  ]);
  assert.match((await backend.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal())).message!, /card 1's free memory could not be read/);
  const shared = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(shared.claim?.card, CARD_B, "the shared box goes on the card that is not held whole");
  const doctor = (await backend.doctor(signal())).checks.find((check) => check.id === "docker.gpus")!;
  assert.equal(doctor.status, "warn");
  assert.match(doctor.detail, /bb-box could not read them just now \(nvidia-smi in a container given the cards answered docker: Error response from daemon: the toolkit's hook failed\), so it names them as last read/);
});

test("071 unit 11: with no reading at all, a box's card is matched by its device, so a card held whole takes no shared box; a whole holder that matches no card stops every GPU placement", async () => {
  const devices = ["nvidia.com/gpu=0", "nvidia.com/gpu=1"];
  const host = { gpus: devices, cards: [card(0, CARD_A, devices[0]!), card(1, CARD_B, devices[1]!)] };
  const { fake, backend, make } = setup({}, host, { whole: true });
  await backend.acquire(identity("linux", "whole", "thr_abc123", "quiet-elm"), null, hooks(), signal());
  fake.set({ probeFails: "docker: Error response from daemon: the toolkit's hook failed" });
  const restarted = make("test");
  const shared = await restarted.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(fake.inspect(shared.ref).Config.Labels["bbbox.gpu"], devices[1], "the shared box goes to the device whose card is not held whole");
  fake.set({ gpus: [devices[1]] });
  const lost = await restarted.capacity("linux", { ...SMALL, gpu: "shared" }, [], signal());
  assert.equal(lost.ok, false);
  assert.match(lost.message!, /^Fake-docker cannot give a box a GPU now: quiet-elm holds a card whole that bb-box cannot match to a card it reads now, as it could not read the cards: .*\. Run bb box doctor\.$/);
  assert.match(lost.agentMessage!, /^Not made: fake-docker cannot give a box a GPU now: quiet-elm holds a card whole .* Ask for gpu none, or ask the user\. bb-box changed nothing\.$/);
  assert.equal((await restarted.capacity("linux", { ...SMALL, gpu: "none" }, [], signal())).ok, true);
  const doctor = (await restarted.doctor(signal())).checks.find((check) => check.id === "docker.gpus")!;
  assert.equal(doctor.status, "fail");
  assert.match(doctor.detail, / quiet-elm holds a card whole that bb-box cannot match to a card it reads now, so it places no GPU box on fake-docker until it can\.$/);
  assert.match(doctor.fix!, /^Release quiet-elm, or give fake-docker its card back\. Check that nvidia-smi answers/);
});

test("071 unit 11: a retry on another card does not count the reservation of the container it removed", async () => {
  const { fake, backend } = setup({ boxes: 2 }, { ...TWO_CARDS, cudaIgnoresVisible: true });
  await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  const moved = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(moved.claim?.card, CARD_A);
  assert.equal(fake.containers().length, 2);
});

test("071 unit 11: a CUDA error other than no device, such as 802, keeps a fresh box on its card with the error in its GPU fact, and the card is not left out", async () => {
  const { fake, backend } = setup({}, { gpus: [DEVICE_A], cards: [card(0, CARD_A, DEVICE_A)], cudaError: 802 });
  const box = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(fake.containers().length, 1);
  assert.equal(box.claim?.card, CARD_A);
  assert.equal(fact(box, "GPU"), "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB: CUDA's driver did not initialise in it: it returned 802");
  const next = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(next.claim?.card, CARD_A, "the card is not left out");
});

test("071 unit 11: devices named by index whose cards could not be read still take shared boxes, by device, with no CUDA variables and no check; a whole card is refused on them", async () => {
  const { fake, backend } = setup({}, { gpus: ["nvidia.com/gpu=0", "nvidia.com/gpu=1"], probeFails: "docker: Error response from daemon: unknown" }, { whole: true });
  const desktop = await backend.acquire(identity("linux-desktop", "shared"), null, hooks(), signal());
  assert.equal(fake.inspect(desktop.ref).Config.Labels["bbbox.gpu"], "nvidia.com/gpu=0");
  assert.equal(fake.inspect(desktop.ref).Config.Labels["bbbox.gpu-card"], undefined);
  assert.ok(!env(fake, desktop.ref).some((pair) => /^(CUDA|NVIDIA)_VISIBLE_DEVICES=/.test(pair)));
  assert.equal(desktop.claim, undefined);
  assert.equal(fact(desktop, "GPU"), "card 0, shared");
  assert.equal(fact(desktop, "GPU check"), "Run nvidia-smi -i 0 to see it; every card on the host is listed");
  const server = await backend.acquire(identity("linux", "shared"), null, hooks(), signal());
  assert.equal(fake.inspect(server.ref).Config.Labels["bbbox.gpu"], "nvidia.com/gpu=1", "the next goes to the device with fewer boxes");
  assert.deepEqual((await backend.held(signal())).map((each) => each.data?.part).sort(), ["shared", "shared"]);
  assert.match((await backend.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal())).message!, /^No card on fake-docker is free for a whole card now: card 0 has .* running and card 1 has .* running\./);
  const plan = await backend.planResize(desktop, "linux-desktop", { ...SMALL, gpu: "whole" }, [], signal());
  assert.match(plan.gpu?.refusal?.agent ?? "", /^Not resized: no card is free for quiet-elm-\d+ alone: bb-box could not read card 0\. Keep the GPU shared, or ask the user\. bb-box changed nothing\.$/);
  const empty = setup({}, { gpus: ["nvidia.com/gpu=0"], probeFails: "docker: Error response from daemon: unknown" }, { whole: true });
  assert.match((await empty.backend.capacity("linux", { ...SMALL, gpu: "whole" }, [], signal())).message!, /card 0's free memory could not be read/);
});

test("071 unit 11: a box with no GPU never runs the probe; the reach words come from the host's privilege for every kind, CPU desktops too, with GPU boxes on or off", async () => {
  const { fake, backend } = setup({}, TWO_CARDS);
  const probes = () => fake.calls().filter((args) => args[0] === "container" && args[1] === "run" && args.at(-1)!.includes("--query-gpu")).length;
  const none = await backend.acquire(identity("linux", "none"), null, hooks(), signal());
  const cpu = await backend.acquire(identity("linux-desktop-cpu", "none"), null, hooks(), signal());
  assert.equal(probes(), 0);
  assert.equal(fact(none, "Cards"), SERVER_REACH);
  assert.equal(fact(cpu, "Cards"), SERVER_REACH);
  assert.equal(backend.cardReach("linux-desktop-cpu"), SERVER_REACH);
  const off = setup({ "gpu-desktops": false }, TWO_CARDS);
  const plain = await off.backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.equal(fact(plain, "Cards"), SERVER_REACH);
  assert.equal(off.backend.cardReach("linux"), SERVER_REACH);
  const cardless = setup({}, {});
  await cardless.backend.acquire(identity("linux", "none"), null, hooks(), signal());
  assert.equal(cardless.backend.cardReach("linux"), null);
  const kind = { offers: [{ cardReach: SERVER_REACH }, { cardReach: SERVER_REACH }, {}] } as unknown as KindView;
  assert.equal(cardReachText(kind), ` ${SERVER_REACH}`, "box_list says it once for a kind, whatever its GPU");
});

test("071 unit 11: on WSL a desktop that is not privileged still names its card for Xorg, as the one device gives it every card", async () => {
  const { fake, backend } = setup({ privileged: false }, WSL_TWO_CARDS);
  await backend.acquire(identity("linux-desktop", "shared"), null, hooks(), signal());
  const second = await backend.acquire(identity("linux-desktop", "shared"), null, hooks(), signal());
  assert.equal(fake.inspect(second.ref).HostConfig.Privileged, false);
  assert.ok(env(fake, second.ref).includes(`BBBOX_GPU_ID=GPU-${CARD_B}`));
  assert.ok(env(fake, second.ref).includes(`BBBOX_GPU_CARD=GPU-${CARD_B}`));
  const linux = setup({ privileged: false }, TWO_CARDS);
  const own = await linux.backend.acquire(identity("linux-desktop", "shared"), null, hooks(), signal());
  assert.ok(!env(linux.fake, own.ref).some((pair) => pair.startsWith("BBBOX_GPU_ID=")), "a desktop that sees only its own card needs no name for it");
});

test("071 unit 11: the desktop launcher gives its session and services the box's card from BBBOX_GPU_CARD, past its clean environment", () => {
  const start = readFileSync(new URL("../setup/docker/start", import.meta.url), "utf8");
  const from = start.indexOf("box_env=(");
  const to = start.indexOf("as_box()");
  assert.ok(from > 0 && to > from);
  const fragment = start.slice(from, to);
  const run = (card: string | null) =>
    execFileSync("bash", ["-c", `set -u; home=/home/box; user=box; ${fragment}\nenv -i "\${box_env[@]}" sh -c 'echo "CUDA=\${CUDA_VISIBLE_DEVICES:-unset} NVIDIA=\${NVIDIA_VISIBLE_DEVICES:-unset}"'`], {
      env: { PATH: process.env.PATH, ...(card ? { BBBOX_GPU_CARD: card, NVIDIA_VISIBLE_DEVICES: "void" } : {}) },
      encoding: "utf8",
    }).trim();
  assert.equal(run(`GPU-${CARD_A}`), `CUDA=GPU-${CARD_A} NVIDIA=GPU-${CARD_A}`);
  assert.equal(run(null), "CUDA=unset NVIDIA=unset");
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

test("071 unit 11: the cards read from a probe container: per-UUID devices, devices named by index, and WSL's one device for every card; a probe that fails leaves UUID-named cards with nothing read, and index-named ones kept by their device", () => {
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
  assert.deepEqual(unread.cards.map((each) => [each.index, each.uuid, each.uuidKnown, each.freeMiB]), [
    [0, "nvidia.com/gpu=0", false, null],
    [null, CARD_B, true, null],
  ]);
  assert.deepEqual(cardsOnHost({ devices: [], allListed: true, probed: null, readAt: null, unread: "no nvidia-smi" }).cards, []);
});

test("071 unit 11: placement's order: shared goes to the fewest boxes, then the most free, then the lowest index; whole to the least used card", () => {
  const cards: DockerCard[] = [
    { uuid: CARD_A, uuidKnown: true, index: 0, model: "m", totalMiB: 32_000, freeMiB: 20_000, device: DEVICE_A },
    { uuid: CARD_B, uuidKnown: true, index: 1, model: "m", totalMiB: 32_000, freeMiB: 25_000, device: DEVICE_B },
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

test("071 unit 11: the card check names a CUDA that picks no card or another, and passes a box with no Python on nvidia-smi alone; a cuInit of 100 with the card listed is a wrong card", () => {
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
  const noDevice = judgeDockerCardCheck(`cudacard 100 0 none\n${smi}\ncuinit 100\n${done}`, CARD_A);
  assert.equal(noDevice.ok ? null : noDevice.why, `CUDA in it found no card it may use with CUDA_VISIBLE_DEVICES=GPU-${CARD_A}: it returned 100`);
  assert.equal(wrongCard(noDevice, CARD_A), true);
  const bare = judgeDockerCardCheck(`${smi}\ncuinit 100\n${done}`, CARD_A);
  assert.equal(wrongCard(bare, CARD_A), true, "cuInit 100 alone, with no CUDA card line, is no device too");
  const library = judgeDockerCardCheck(`${smi}\ncuinit OSError: libcuda.so.1: cannot open shared object file\n${done}`, CARD_A);
  assert.equal(wrongCard(library, CARD_A), false, "a library that does not load keeps the box, with words");
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
