import assert from "node:assert/strict";
import { test } from "node:test";
import { BackendError, GpuPlanChanged, ResizeHolds, ResizeLeftStopped, startedGpu, startedGuest, type AcquireHooks, type BoxIdentity, type GpuPart, type Guest, type ResizeTarget } from "../src/backends/types.ts";
import type { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, SECOND_INSTALL, SECOND_POOL } from "./gpu-helper/claims-bridge.ts";
import { cardLines, marker } from "./gpu-helper/node.ts";
import { OPERATOR, SPARES, resizingWords } from "../src/core/boxes.ts";
import { PERSON, blockWords, type CardNamer } from "../src/backends/proxmox-lxc/gpu-refusals.ts";
import { reservationsOn, underCardLock } from "../src/backends/proxmox-lxc/gpu-claims.ts";
import { parseHelperLines } from "../src/backends/proxmox-lxc/gpu-marking.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
const DRIVER = "580.142";
let counter = 0;

function box(kind: string, gpu: GpuPart, threadId = "thr_resize", name?: string): BoxIdentity {
  counter++;
  return { boxId: `bxresize${counter}`, threadId, name: name ?? `resize-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 6), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

const signal = () => new AbortController().signal;

function record(nvidia: string | null): string {
  return JSON.stringify({ contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261106-090000-1a2b", built: "2026-11-06T09:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia });
}

function withUserspace(bridge: ClaimsBridge, nvidia: string | null = DRIVER): void {
  bridge.proxmox.guests.get(9000)!.config.description = `bb-box linux template (NVIDIA ${nvidia}, no card), built 2026-11-06. See /usr/share/bb-box/template-release inside.\n${record(nvidia)}`;
}

function size(gpu: GpuPart, cores = 2): ResizeTarget {
  return { cores, memoryMiB: 4096, diskGiB: null, gpu };
}

function powerOf(bridge: ClaimsBridge, vmid: number): string[] {
  return bridge.node.powerLog().filter((line) => line.endsWith(` ${vmid}`));
}

function anotherInstallRunning(bridge: ClaimsBridge, vmid: number, card: typeof CARD_A, part: "shared" | "whole" = "shared"): void {
  bridge.desktop(vmid, card, { ...box("linux-desktop", part, "thr_elsewhere"), name: `other-${vmid}` }, SECOND_INSTALL, { marker: marker(part, card, 1), running: true, pool: SECOND_POOL });
  bridge.pass();
}

async function server(bridge: ClaimsBridge, backend: ProxmoxLxcBackend, gpu: GpuPart, name?: string, threadId = "thr_resize"): Promise<{ readonly guest: Guest; readonly vmid: number }> {
  const guest = await backend.acquire(box("linux", gpu, threadId, name), null, hooks(), signal());
  const vmid = Number(guest.ref);
  bridge.userspaceIn(vmid, DRIVER);
  bridge.pass();
  return { guest, vmid };
}

async function stopped(bridge: ClaimsBridge, backend: ProxmoxLxcBackend, guest: Guest): Promise<void> {
  await backend.stop(guest, signal());
  bridge.pass();
}

function gpuFact(guest: Guest): string | null {
  return guest.facts?.find((fact) => fact.label === "GPU")?.value ?? null;
}

test("071 unit 9: Proxmox LXC resizes a GPU on linux and linux-desktop: shared and whole switch live, adding, removing and moving restart; with whole cards off, only adding and removing", () => {
  const bridge = new ClaimsBridge();
  const on = bridge.backend();
  assert.deepEqual(on.resizing("linux")?.gpu, { add: "restart", share: "live", move: "restart" });
  assert.deepEqual(on.resizing("linux-desktop")?.gpu, { add: "restart", share: "live", move: "restart" });
  assert.equal(resizingWords(on.resizing("linux")), "Resize: cores, memory and disk live, the disk only growing. A box's GPU switches between shared and whole live, and is added, removed or moved to another card with a restart.");
  const off = bridge.backend({ wholeCards: false });
  assert.deepEqual(off.resizing("linux")?.gpu, { add: "restart", share: "no", move: "no" });
  assert.equal(resizingWords(off.resizing("linux")), "Resize: cores, memory and disk live, the disk only growing. A box's GPU is added or removed with a restart, and cannot be moved to another card.");
  assert.equal(resizingWords({ cores: "live", memory: "live", disk: "no", shrinks: true, gpu: { add: "no", share: "live", move: "no" } }), "Resize: cores and memory live. A box's GPU switches between shared and whole live, and cannot be added, removed or moved to another card.", "Docker's words are as unit 11 had them");
});

test("071 unit 9, section 8, running: none to shared restarts the box once, with its cores, onto the card with room, and the helper gives it the card's lines while it is stopped", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const { guest, vmid } = await server(bridge, backend, "none", "amber-fox");
  assert.deepEqual(bridge.gpuTags(vmid), []);
  const plan = await backend.planResize(guest, "linux", size("shared", 4), [], signal());
  assert.equal(plan.gpu?.way, "restart");
  assert.equal(plan.gpu?.toCard?.card, A);
  assert.equal(plan.gpu?.stopped, false);
  assert.equal(plan.gpu?.words, "GPU: none → shared, card 0 · Restart. Amber-fox restarts, gets card 0 (96 GiB), with no other box on it now, in about 15 s. Everything running in it stops.");
  assert.deepEqual(plan.parts, [{ part: "cores", from: 2, to: 4, way: "restart" }], "cores change in the same restart");
  assert.equal(plan.downSeconds, 15);
  const before = bridge.node.powerLog().length;
  const resized = await backend.resize(guest, "linux", size("shared", 4), { restart: true, agreed: plan.gpu! }, signal());
  assert.deepEqual(bridge.node.powerLog().slice(before), [`stop ${vmid}`, `start ${vmid}`], "one restart for cores and GPU together");
  assert.equal(resized.size?.cores, 4);
  assert.deepEqual(resized.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(vmid), [marker("shared", CARD_A, 1)]);
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "server"));
  assert.ok(bridge.node.isRunning(vmid));
  assert.equal(gpuFact(resized), "card 0, shared, NVIDIA Fake Card, 96 GiB");
});

test("071 unit 9, section 8, running: none to whole restarts onto a free card, to itself", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  anotherInstallRunning(bridge, 7060, CARD_A);
  const { guest, vmid } = await server(bridge, backend, "none", "lone-pine");
  const plan = await backend.planResize(guest, "linux", size("whole"), [], signal());
  assert.equal(plan.gpu?.way, "restart");
  assert.equal(plan.gpu?.toCard?.card, B, "card 0 has another install's guest");
  assert.equal(plan.gpu?.words, "GPU: none → whole, card 1 · Restart. Lone-pine restarts, gets card 1 (96 GiB), to itself, in about 15 s. Everything running in it stops.");
  const resized = await backend.resize(guest, "linux", size("whole"), { restart: true, agreed: plan.gpu! }, signal());
  assert.deepEqual(resized.claim, { card: B, part: "whole", generation: 1, answer: "granted" });
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${B} ${vmid} whole running `)));
});

test("071 unit 9, section 8, running: shared to whole with no other box on its card is live, nothing stops and its lines stay, and whole to shared is live again", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const { guest, vmid } = await server(bridge, backend, "shared", "quiet-elm");
  assert.equal(guest.claim?.card, A);
  const before = bridge.node.powerLog().length;
  const plan = await backend.planResize(guest, "linux", size("whole"), [], signal());
  assert.equal(plan.gpu?.way, "live");
  assert.equal(plan.gpu?.words, "GPU: shared → whole card 0 · Live. Card 0 becomes quiet-elm's alone: no other box is placed on it while quiet-elm holds it. Nothing in quiet-elm stops.");
  assert.equal(plan.downSeconds, null);
  const whole = await backend.resize(guest, "linux", size("whole"), { restart: false, agreed: plan.gpu! }, signal());
  assert.deepEqual(bridge.node.powerLog().slice(before), [], "nothing stopped or started");
  assert.deepEqual(whole.claim, { card: A, part: "whole", generation: 2, answer: "granted" });
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "server"), "its lines are as they were");
  assert.equal(gpuFact(whole), "card 0, whole, NVIDIA Fake Card, 96 GiB");
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${A} ${vmid} whole running `)));
  const other = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(other.claim?.card, B, "no other box goes on the card while it is whole");
  const back = await backend.planResize(whole, "linux", size("shared"), [], signal());
  assert.equal(back.gpu?.way, "live");
  assert.equal(back.gpu?.words, "GPU: whole card 0 → shared · Live. Card 0 opens to other boxes, up to 4. They share its memory and its time. Nothing in quiet-elm stops.");
  const shared = await backend.resize(whole, "linux", size("shared"), { restart: false }, signal());
  assert.deepEqual(bridge.node.powerLog().slice(before).filter((line) => line.endsWith(` ${vmid}`)), []);
  assert.deepEqual(shared.claim, { card: A, part: "shared", generation: 3, answer: "granted" });
  assert.ok(bridge.node.isRunning(vmid));
});

test("071 unit 9, section 8: a stopped shared box of this install on the card yields to a live switch to whole, and the words say it is placed elsewhere when it next starts", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 4 });
  anotherInstallRunning(bridge, 7061, CARD_B);
  const runner = await server(bridge, backend, "shared", "amber-fox");
  const sleeper = await server(bridge, backend, "shared", "swift-owl");
  assert.equal(runner.guest.claim?.card, A);
  assert.equal(sleeper.guest.claim?.card, A);
  await stopped(bridge, backend, sleeper.guest);
  const plan = await backend.planResize(runner.guest, "linux", size("whole"), [], signal());
  assert.equal(plan.gpu?.way, "live");
  assert.deepEqual(plan.gpu?.others, [{ box: sleeper.guest.data?.box, name: "swift-owl", stopped: true }]);
  assert.equal(plan.gpu?.words, "GPU: shared → whole card 0 · Live. Card 0 becomes amber-fox's alone: no other box is placed on it while amber-fox holds it. Nothing in amber-fox stops. swift-owl (stopped) is placed on another card when it next starts.");
  await backend.resize(runner.guest, "linux", size("whole"), { restart: false, agreed: plan.gpu! }, signal());
  bridge.pass();
  assert.deepEqual(bridge.lines(sleeper.vmid), [], "the stopped box yielded its lines");
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim ${sleeper.vmid} g1 yielded ${A}`)), bridge.node.reportLines().join("\n"));
  assert.ok(bridge.node.isRunning(runner.vmid));
});

test("071 unit 9, section 8, running: shared to whole with another box running on its card moves it to a free card with a restart; with no free card it is refused, naming the boxes on each card for each audience, and nothing changes", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 4, titles: { thr_train: "Train the model" } });
  anotherInstallRunning(bridge, 7062, CARD_B);
  const fox = await server(bridge, backend, "shared", "amber-fox");
  const pine = await server(bridge, backend, "shared", "lone-pine", "thr_train");
  assert.equal(fox.guest.claim?.card, A);
  assert.equal(pine.guest.claim?.card, A);
  bridge.proxmox.guests.delete(7062);
  bridge.pass();
  const plan = await backend.planResize(fox.guest, "linux", size("whole"), [], signal());
  assert.equal(plan.gpu?.way, "restart");
  assert.equal(plan.gpu?.fromCard?.card, A);
  assert.equal(plan.gpu?.toCard?.card, B);
  assert.equal(plan.gpu?.words, "GPU: shared on card 0 → whole card 1 · Restart. Card 0 has lone-pine (in thread \"Train the model\") running. BB Box moves amber-fox to card 1, which has no other box, in about 15 s. Everything running in amber-fox stops.");
  anotherInstallRunning(bridge, 7063, CARD_B);
  const configs = bridge.configs();
  const refused = await backend.planResize(fox.guest, "linux", size("whole"), [], signal());
  assert.deepEqual(refused.gpu?.refusal, {
    person: "No card is free for amber-fox alone. Card 0 has lone-pine (in thread \"Train the model\") running. Card 1 has CT 7063 of another install running. Release one of them, or keep the GPU shared.",
    agent: "Not resized: no card is free for amber-fox alone. Card 0 has lone-pine running; card 1 has CT 7063 of another install running. Keep the GPU shared, or ask the user. BB Box changed nothing.",
  });
  await assert.rejects(backend.resize(fox.guest, "linux", size("whole"), { restart: true }, signal()), (error: unknown) => error instanceof BackendError && error.agentMessage === refused.gpu!.refusal!.agent);
  assert.deepEqual(bridge.configs(), configs, "no guest changed");
  const pineAsks = await backend.planResize(pine.guest, "linux", size("whole"), [], signal());
  assert.equal(pineAsks.gpu?.refusal?.agent, "Not resized: no card is free for lone-pine alone. Card 0 has amber-fox running; card 1 has CT 7063 of another install running. Keep the GPU shared, or ask the user. BB Box changed nothing.");
  bridge.proxmox.guests.delete(7063);
  bridge.pass();
  const before = bridge.node.powerLog().length;
  const moved = await backend.resize(fox.guest, "linux", size("whole"), { restart: true, agreed: plan.gpu! }, signal());
  assert.deepEqual(bridge.node.powerLog().slice(before), [`stop ${fox.vmid}`, `start ${fox.vmid}`]);
  assert.deepEqual(moved.claim, { card: B, part: "whole", generation: 2, answer: "granted" });
  assert.deepEqual(bridge.lines(fox.vmid), cardLines(CARD_B, "server"));
  assert.deepEqual(bridge.lines(pine.vmid), cardLines(CARD_A, "server"));
});

test("071 unit 9, section 8, running: shared or whole to none restarts the box without its card, and its GPU fact goes", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const shared = await server(bridge, backend, "shared", "amber-fox");
  const plan = await backend.planResize(shared.guest, "linux", size("none"), [], signal());
  assert.equal(plan.gpu?.way, "restart");
  assert.equal(plan.gpu?.words, "GPU: shared, card 0 → none · Restart. Amber-fox restarts without card 0, in about 15 s. Everything running in it stops.");
  const before = bridge.node.powerLog().length;
  const none = await backend.resize(shared.guest, "linux", size("none"), { restart: true, agreed: plan.gpu! }, signal());
  assert.deepEqual(bridge.node.powerLog().slice(before), [`stop ${shared.vmid}`, `start ${shared.vmid}`]);
  assert.equal(none.claim, null);
  assert.equal(gpuFact(none), null);
  assert.deepEqual(bridge.gpuTags(shared.vmid), [marker("none", null, 2)]);
  assert.deepEqual(bridge.lines(shared.vmid), []);
  assert.ok(bridge.node.isRunning(shared.vmid));
  const whole = await server(bridge, backend, "whole", "quiet-elm");
  const gone = await backend.resize(whole.guest, "linux", size("none"), { restart: true }, signal());
  assert.equal(gone.claim, null);
  assert.deepEqual(bridge.lines(whole.vmid), []);
  bridge.pass();
  assert.equal(bridge.node.reportLines().filter((line) => line.startsWith("holder ")).length, 0, bridge.node.reportLines().join("\n"));
});

test("071 unit 9, section 8, stopped: a stopped box stays stopped; to none its lines go now, to whole its card is claimed now, to shared its part changes now and it is placed when it next starts", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const owl = await server(bridge, backend, "shared", "swift-owl");
  await stopped(bridge, backend, owl.guest);
  const before = bridge.node.powerLog().length;
  const toNone = await backend.planResize(owl.guest, "linux", size("none", 4), [], signal());
  assert.equal(toNone.gpu?.way, "live");
  assert.equal(toNone.gpu?.stopped, true);
  assert.deepEqual(toNone.parts, [{ part: "cores", from: 2, to: 4, way: "live" }]);
  assert.equal(toNone.gpu?.words, "GPU: shared, card 0 → none · While stopped. Swift-owl is stopped: it has no GPU from its next start. Nothing starts now.");
  const none = await backend.resize(owl.guest, "linux", size("none", 4), { restart: false, agreed: toNone.gpu! }, signal());
  assert.equal(none.claim, null);
  assert.equal(none.size?.cores, 4);
  assert.deepEqual(bridge.lines(owl.vmid), [], "its lines went while it was stopped");
  const toShared = await backend.planResize(none, "linux", size("shared", 4), [], signal());
  assert.equal(toShared.gpu?.words, "GPU: none → shared · While stopped. Swift-owl is stopped: it gets a shared GPU from its next start, on card 0 if it has room then. Nothing starts now.");
  const filler = await server(bridge, backend, "shared", "lone-pine");
  assert.equal(filler.guest.claim?.card, A);
  const filled = await backend.planResize(none, "linux", size("shared", 4), [], signal());
  assert.equal(filled.gpu?.toCard?.card, B, "the card with room first");
  const shared = await backend.resize(none, "linux", size("shared", 4), { restart: false }, signal());
  assert.deepEqual(shared.claim, { card: B, part: "shared", generation: 3, answer: "granted" });
  assert.deepEqual(bridge.lines(owl.vmid), cardLines(CARD_B, "server"));
  const toWhole = await backend.resize(shared, "linux", size("whole", 4), { restart: false }, signal());
  assert.deepEqual(toWhole.claim, { card: B, part: "whole", generation: 4, answer: "granted" });
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${B} ${owl.vmid} whole stopped `)), "a stopped whole box holds its card");
  const backToShared = await backend.planResize(toWhole, "linux", size("shared", 4), [], signal());
  assert.equal(backToShared.gpu?.words, "GPU: whole card 1 → shared · While stopped. Card 1 opens to other boxes now. Swift-owl is stopped: it goes on a card with room when it next starts, card 1 first. Nothing starts now.");
  await backend.resize(toWhole, "linux", size("shared", 4), { restart: false }, signal());
  assert.deepEqual(powerOf(bridge, owl.vmid).slice(before), [], "nothing started");
  assert.equal(bridge.node.isRunning(owl.vmid), false);
});

test("071 unit 9, section 8, stopped: none to whole on a stopped box claims a free card now and leaves it stopped", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const box = await server(bridge, backend, "none", "calm-reef");
  await stopped(bridge, backend, box.guest);
  const plan = await backend.planResize(box.guest, "linux", size("whole"), [], signal());
  assert.equal(plan.gpu?.words, "GPU: none → whole card 0 · While stopped. Card 0 is claimed for calm-reef now: no other box is placed on it while calm-reef holds it. Calm-reef is stopped, and nothing starts now.");
  const whole = await backend.resize(box.guest, "linux", size("whole"), { restart: false }, signal());
  assert.deepEqual(whole.claim, { card: A, part: "whole", generation: 1, answer: "granted" });
  assert.equal(bridge.node.isRunning(box.vmid), false);
});

test("071 unit 9, section 8, the plan made again: a live switch that now needs a move, and an added card that another box took meanwhile, are asked again with what changed, and nothing changes", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  const live = await backend.planResize(elm.guest, "linux", size("whole"), [], signal());
  assert.equal(live.gpu?.way, "live");
  anotherInstallRunning(bridge, 7064, CARD_A);
  const now = await backend.planResize(elm.guest, "linux", size("whole"), [], signal(), live.gpu!);
  assert.equal(now.gpu?.way, "restart");
  assert.deepEqual(now.gpu?.changedSinceAgreed, {
    person: "Not resized: when you checked, quiet-elm could change to a whole card live, on card 0; now card 0 has CT 7064 of another install running, so it would move to card 1 with a restart. Resize it again with the restart to do that, or keep its GPU as it is. BB Box changed nothing.",
    agent: "Not resized: when you checked, quiet-elm could change to a whole card live, on card 0; now card 0 has CT 7064 of another install running, so it would move to card 1 with a restart. Call box_resize with restart true to do that, or ask the user. BB Box changed nothing.",
  });
  const configs = bridge.configs();
  const power = bridge.node.powerLog().length;
  await assert.rejects(backend.resize(elm.guest, "linux", size("whole"), { restart: true, agreed: live.gpu! }, signal()), (error: unknown) => error instanceof BackendError && error.agentMessage === now.gpu!.changedSinceAgreed!.agent);
  assert.deepEqual(bridge.configs(), configs, "nothing changed");
  assert.equal(bridge.node.powerLog().length, power);
  assert.equal(await backend.planResize(elm.guest, "linux", size("whole"), [], signal(), now.gpu!).then((plan) => plan.gpu?.changedSinceAgreed ?? null), null, "the plan it was told is the plan now");

  const fox = await server(bridge, backend, "none", "amber-fox");
  const add = await backend.planResize(fox.guest, "linux", size("shared"), [], signal());
  assert.equal(add.gpu?.toCard?.card, B, "card 1 has room");
  const taker = await backend.acquire(box("linux", "shared", "thr_other", "tidy-glade"), null, hooks(), signal());
  assert.equal(taker.claim?.card, B);
  bridge.pass();
  const before = bridge.configs();
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true, agreed: add.gpu! }, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.agentMessage, "Not resized: no card on pve can take a shared GPU for amber-fox now: card 0 has 1 of this install's boxes, the most a card may have (quiet-elm); card 1 has 1 of this install's boxes, the most a card may have (tidy-glade). Release one of your own boxes on card 0 (quiet-elm), keep it with no GPU, or ask the user. BB Box changed nothing.");
    return true;
  });
  assert.deepEqual(bridge.configs(), before, "a card taken meanwhile changes nothing");
});

test("071 unit 9 gate: a move whose card is taken meanwhile is asked again, naming who took it, and goes ahead on the card asked about once asked again", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1, titles: { thr_other: "Other work" } });
  const fox = await server(bridge, backend, "none", "amber-fox");
  const add = await backend.planResize(fox.guest, "linux", size("shared"), [], signal());
  assert.equal(add.gpu?.toCard?.card, A);
  const taker = await backend.acquire(box("linux", "shared", "thr_other", "tidy-glade"), null, hooks(), signal());
  assert.equal(taker.claim?.card, A, "another box takes the card the check named");
  bridge.pass();
  const configs = bridge.configs();
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true, agreed: add.gpu! }, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.agentMessage, "Not resized: when you checked, amber-fox would get card 0 with a restart; now card 0 has 1 of this install's boxes, the most a card may have (tidy-glade), so it would get card 1 with a restart. Call box_resize with restart true to do that, or ask the user. BB Box changed nothing.");
    assert.equal(error.message, "Not resized: when you checked, amber-fox would get card 0 with a restart; now card 0 has 1 of this install's boxes, the most a card may have (tidy-glade in thread \"Other work\"), so it would get card 1 with a restart. Resize it again with the restart to do that, or keep its GPU as it is. BB Box changed nothing.");
    return true;
  });
  assert.deepEqual(bridge.configs(), configs);
  const again = await backend.planResize(fox.guest, "linux", size("shared"), [], signal());
  const resized = await backend.resize(fox.guest, "linux", size("shared"), { restart: true, agreed: again.gpu! }, signal());
  assert.deepEqual(resized.claim, { card: B, part: "shared", generation: 1, answer: "granted" });
});

test("071 unit 9 gate: a restart whose new claim the helper does not grant leaves the box stopped with its disk and its old claim, its cores put back and its marker asked back", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched !== null && bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.shared."))) bridge.answering = false;
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  const disk = bridge.proxmox.guests.get(fox.vmid)!.config.rootfs;
  watched = fox.vmid;
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared", 4), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.gpu, "none");
    assert.equal(error.guest.claim, null);
    assert.match(error.message, /^Amber-fox is stopped, with its disk as it was: the host's GPU helper on pve did not answer within 10 s\. BB Box cannot tell yet whether the host's GPU helper on pve grants its request gpu\.none\.g\d+: until it answers, amber-fox holds no GPU, and its start waits for the answer\. Start it to use it so, or resize it again\.$/);
    assert.match(error.agentMessage ?? "", /^Not resized: amber-fox is stopped, with its disk as it was: .* Start it with box_start, or ask the user\.$/);
    return true;
  });
  watched = null;
  bridge.answering = true;
  bridge.pass();
  assert.equal(bridge.node.isRunning(fox.vmid), false, "left stopped");
  assert.equal(bridge.proxmox.guests.get(fox.vmid)!.config.rootfs, disk, "with its disk");
  assert.equal(bridge.proxmox.guests.get(fox.vmid)!.config.cores, "2", "its cores put back");
  assert.deepEqual(bridge.lines(fox.vmid), []);
  assert.equal(bridge.gpuTags(fox.vmid)[0]?.startsWith("gpu.none."), true, "its marker asks for its old claim again");
});

test("071 unit 9 gate: a restart that is granted its card but cannot start leaves the box stopped with its disk, holding the new claim, and says so", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched !== null && bridge.tags(watched).some((tag) => tag.startsWith("bb-power.start."))) bridge.proxmox.guests.get(watched)!.config.lock = "backup";
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  watched = fox.vmid;
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.gpu, "shared");
    assert.deepEqual(error.guest.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
    assert.match(error.message, /^Amber-fox holds a shared GPU, card 0 now, but did not start after its GPU changed: .*It is stopped, with its disk as it was\. Start tries again; bb box doctor has more\.$/);
    assert.equal(error.message.split("It is stopped").length, 2, "it says once that it is stopped");
    assert.equal((error.agentMessage ?? "").split("It is stopped").length, 2, "and once to an agent");
    return true;
  });
  watched = null;
  assert.equal(bridge.node.isRunning(fox.vmid), false);
  assert.deepEqual(bridge.lines(fox.vmid), cardLines(CARD_A, "server"), "it holds the new card's lines");
});

test("071 unit 9: a GPU change is refused before anything changes, for each audience, where the helper has writes off or is missing, on a guest with a card's lines and no marker, a stopped box without the host's userspace (unit 10 installs it in a running one), and for whole while whole cards are off", async () => {
  const off = new ClaimsBridge({ writes: "off" });
  withUserspace(off);
  const offBackend = off.backend();
  const plain = await server(off, offBackend, "none", "calm-reef");
  assert.deepEqual((await offBackend.planResize(plain.guest, "linux", size("shared"), [], signal())).gpu?.refusal, {
    person: "pve cannot change calm-reef's GPU now: its GPU helper has writes off, so it gives no box a card. Turn writes on with host/setup-gpu.sh --writes on --check, then --writes on, as root on pve.",
    agent: "Not resized: pve cannot change calm-reef's GPU now: its GPU helper has writes off, so it gives no box a card. Keep its GPU as it is, or ask the user. BB Box changed nothing.",
  });
  await assert.rejects(offBackend.resize(plain.guest, "linux", size("shared"), { restart: true }, signal()), /its GPU helper has writes off/);

  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const old = box("linux-desktop", "shared", "thr_resize", "old-desk");
  bridge.desktop(7040, CARD_A, old, INSTALL, { running: true });
  const refused = await backend.planResize(bridge.stoppedGuest(7040, old, 9001), "linux-desktop", size("none"), [], signal());
  assert.equal(refused.gpu?.refusal?.person, "Old-desk has a card's device lines and no GPU marker, so BB Box does not know which claim it holds. Run bb box gpu mark, then resize it again.");

  const bare = await server(bridge, backend, "none", "pale-moss");
  bridge.userspaceIn(bare.vmid, null);
  const installing = (await backend.planResize(bare.guest, "linux", size("shared"), [], signal())).gpu;
  assert.equal(installing?.refusal, null, "unit 10 installs the userspace in place of this refusal");
  assert.equal(installing?.installs, DRIVER);
  await stopped(bridge, backend, bare.guest);
  withUserspace(bridge, null);
  assert.equal((await backend.planResize(bare.guest, "linux", size("shared"), [], signal())).gpu?.refusal?.agent, "Not resized: pale-moss is stopped, and a card needs NVIDIA's userspace 580.142 in it, which BB Box installs only in a running box. Start it with box_start, then resize it again, or ask the user. BB Box changed nothing.");
  withUserspace(bridge);

  const shared = await server(bridge, backend, "shared", "quiet-elm");
  const wholeOff = bridge.backend({ wholeCards: false });
  const offPlan = await wholeOff.planResize(shared.guest, "linux", size("whole"), [], signal());
  assert.equal(offPlan.gpu?.refusal?.agent, "Not resized: whole cards are off on Proxmox LXC on pve. Keep the GPU shared, or ask the user. BB Box changed nothing.");

  const timer = new ClaimsBridge();
  withUserspace(timer);
  const timerBackend = timer.backend();
  const lone = await server(timer, timerBackend, "none", "lone-pine");
  timer.timerReport();
  assert.equal((await timerBackend.planResize(lone.guest, "linux", size("shared"), [], signal())).gpu?.refusal?.agent, "Not resized: pve cannot change lone-pine's GPU now: it has no GPU helper to give a box a card. Keep its GPU as it is, or ask the user. BB Box changed nothing.");
});

test("071 unit 9, section 8, desktops: a GPU desktop that loses its card restarts on the CPU's words and keeps no GPU fact, and gets a card again with a restart", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const desk = await backend.acquire(box("linux-desktop", "shared", "thr_resize", "amber-fox"), null, hooks(), signal());
  const vmid = Number(desk.ref);
  bridge.userspaceIn(vmid, DRIVER);
  bridge.pass();
  assert.equal(desk.claim?.card, A);
  const plan = await backend.planResize(desk, "linux-desktop", size("none", 4), [], signal());
  assert.equal(plan.gpu?.words, "GPU: shared, card 0 → none · Restart. Amber-fox restarts without card 0, in about 15 s. Everything running in it stops. Its desktop is then drawn by the CPU.");
  const none = await backend.resize(desk, "linux-desktop", { ...size("none"), cores: 4, memoryMiB: 8192 }, { restart: true }, signal());
  assert.equal(none.claim, null);
  assert.equal(gpuFact(none), null);
  assert.deepEqual(bridge.lines(vmid), []);
  const back = await backend.planResize(none, "linux-desktop", { ...size("shared"), cores: 4, memoryMiB: 8192 }, [], signal());
  assert.equal(back.gpu?.words, "GPU: none → shared, card 0 · Restart. Amber-fox restarts, gets card 0 (96 GiB), with no other box on it now, in about 15 s. Everything running in it stops. Its desktop is then drawn by the GPU.");
  const shared = await backend.resize(none, "linux-desktop", { ...size("shared"), cores: 4, memoryMiB: 8192 }, { restart: true }, signal());
  assert.equal(shared.claim?.card, A);
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "desktop"));
});

test("071 unit 9, section 4's race: a resize to whole and an acquire of a shared box, in one install, take the card lock in turn, so a card never ends whole with another box on it", async () => {
  for (let round = 0; round < 4; round++) {
    const bridge = new ClaimsBridge();
    withUserspace(bridge);
    const backend = bridge.backend({ perGpu: 4 });
    anotherInstallRunning(bridge, 7066, CARD_B);
    const fox = await server(bridge, backend, "shared", "amber-fox");
    assert.equal(fox.guest.claim?.card, A);
    const both = await Promise.allSettled([backend.resize(fox.guest, "linux", size("whole"), { restart: false }, signal()), backend.acquire(box("linux", "shared", "thr_race"), null, hooks(), signal())]);
    bridge.pass();
    const report = bridge.node.reportLines();
    const whole = report.filter((line) => /^holder \S+ \d+ whole /.test(line));
    for (const line of whole) {
      const card = line.split(" ")[1];
      assert.equal(report.filter((other) => other.startsWith(`holder ${card} `)).length, 1, `a whole card with another holder: ${report.join("\n")}`);
    }
    assert.ok(both.some((result) => result.status === "fulfilled"), JSON.stringify(both.map((result) => (result.status === "rejected" ? String(result.reason) : "ok"))));
  }
});

test("071 unit 9, section 8, stopped: a stopped box's GPU part changes to shared even while every card is at its limit, as it holds no place until it starts; its start is then refused with names, and it stays stopped", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  const owl = await server(bridge, backend, "none", "swift-owl");
  await stopped(bridge, backend, owl.guest);
  const pine = await server(bridge, backend, "shared", "lone-pine");
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  assert.deepEqual([pine.guest.claim?.card, elm.guest.claim?.card].sort(), [A, B].sort());
  const plan = await backend.planResize(owl.guest, "linux", size("shared"), [], signal());
  assert.equal(plan.gpu?.refusal, null, plan.gpu?.words);
  assert.equal(plan.gpu?.stopped, true);
  const shared = await backend.resize(owl.guest, "linux", size("shared"), { restart: false }, signal());
  assert.equal(shared.claim?.part, "shared");
  assert.equal(bridge.node.isRunning(owl.vmid), false);
  await assert.rejects(backend.start(shared, signal()), /No card on pve can take another box now: card 0 has 1 of this install's boxes, the most a card may have/);
  assert.equal(bridge.node.isRunning(owl.vmid), false);
});

test("071 unit 9: a box whose claim is none and whose marker asks for a card the helper refused, as after a resize whose claim could not be asked back, starts with no card, its none claim asked again", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const fox = await server(bridge, backend, "shared", "amber-fox");
  const none = await backend.resize(fox.guest, "linux", size("none"), { restart: true }, signal());
  assert.deepEqual(bridge.gpuTags(fox.vmid), [marker("none", null, 2)]);
  await stopped(bridge, backend, none);
  anotherInstallRunning(bridge, 7067, CARD_A, "whole");
  anotherInstallRunning(bridge, 7068, CARD_B, "whole");
  const guest = bridge.proxmox.guests.get(fox.vmid)!;
  guest.config.tags = [...bridge.tags(fox.vmid).filter((tag) => !tag.startsWith("gpu.")), marker("shared", CARD_A, 3)].join(";");
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim ${fox.vmid} g3 refused `)), bridge.node.reportLines().join("\n"));
  const started = await backend.start(none, signal());
  assert.ok(bridge.node.isRunning(fox.vmid));
  assert.deepEqual(bridge.lines(fox.vmid), [], "it started with no card");
  assert.equal(started && "claim" in started ? started.claim : undefined, null, "it says it holds no card");
  assert.deepEqual(bridge.gpuTags(fox.vmid), [marker("none", null, 4)], "its none claim was asked again");
});

test("071 unit 9: a card reserved for a box whose GPU a resize changes is named as such to boxes placed meanwhile", () => {
  const card = { uuid: A, index: 0, pci: "0000:21:00.0", minor: 1, drmCard: "card2", drmRender: "renderD129" };
  const namer: CardNamer = { guest: (vmid) => ({ is: "box", name: `CT ${vmid}`, threadId: null }), title: () => null };
  const making = { name: "amber-fox", threadId: "thr_resize", resizing: true };
  assert.equal(blockWords({ is: "reserved-whole", card, making }, namer, PERSON), "card 0 is kept whole for amber-fox, which BB Box is resizing");
  assert.equal(blockWords({ is: "placing", card, making: [making] }, namer, PERSON), "BB Box is changing the GPU of amber-fox to card 0");
  assert.equal(blockWords({ is: "placing", card, making: [{ name: "lone-pine", threadId: "thr_resize", starting: true }] }, namer, PERSON), "BB Box is starting lone-pine on card 0");
});

test("071 unit 9: a running box's restart for a card reserves it, as the box's own, while the resize waits for the helper, so no other box is placed in its room", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const held: { vmid: number | null; seen: readonly { readonly card: string; readonly part: string; readonly vmid: number | null }[] | null } = { vmid: null, seen: null };
  const backend = bridge.backend({
    perGpu: 1,
    onSleep: () => {
      if (held.vmid === null || held.seen !== null || !bridge.gpuTags(held.vmid).some((tag) => tag.startsWith(`gpu.shared.${A}.`))) return;
      held.seen = reservationsOn(`${bridge.url.replace(/\/+$/, "")}#pve`).live(parseHelperLines(""), Date.now()).map((each) => ({ card: each.card, part: each.part, vmid: each.vmid }));
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  const plan = await backend.planResize(fox.guest, "linux", size("shared"), [], signal());
  assert.equal(plan.gpu?.toCard?.card, A);
  held.vmid = fox.vmid;
  const resized = await backend.resize(fox.guest, "linux", size("shared"), { restart: true, agreed: plan.gpu! }, signal());
  assert.deepEqual(held.seen, [{ card: A, part: "shared", vmid: fox.vmid }], "while it waited for the helper, its card was reserved for it");
  assert.equal(resized.claim?.card, A);
  const other = await backend.acquire(box("linux", "shared", "thr_meanwhile", "tidy-glade"), null, hooks(), signal());
  assert.equal(other.claim?.card, B);
});

test("071 unit 9: the boxes that fill a card are named in one pair of brackets, a person's with their threads, never brackets within brackets", () => {
  const card = { uuid: A, index: 0, pci: "0000:21:00.0", minor: 1, drmCard: "card2", drmRender: "renderD129" };
  const holders: Record<number, { readonly is: "box"; readonly name: string; readonly threadId: string | null }> = { 7001: { is: "box", name: "lone-pine", threadId: "thr_train" }, 7002: { is: "box", name: "quiet-elm", threadId: SPARES } };
  const namer: CardNamer = { guest: (vmid) => holders[vmid]!, title: (threadId) => (threadId === "thr_train" ? "Train the model" : null) };
  const block = { is: "limit" as const, card, own: 3, vmids: [7001, 7002], making: [{ name: "amber-fox", threadId: OPERATOR }] };
  assert.equal(blockWords(block, namer, PERSON), "card 0 has 3 of this install's boxes, the most a card may have (lone-pine in thread \"Train the model\", quiet-elm as a spare and amber-fox as your machine)");
  assert.equal(blockWords(block, namer, { to: "agent", threadId: null }), "card 0 has 3 of this install's boxes, the most a card may have (lone-pine, quiet-elm and amber-fox)");
  assert.equal(blockWords({ is: "held", card, holders: [{ card: A, vmid: 7001, part: "shared", running: true, install: "4kq7", managed: true }] }, namer, PERSON), "card 0 has lone-pine (in thread \"Train the model\") running", "outside brackets a thread keeps its own");
});

function refused(text: string) {
  return { ok: false, status: 500, statusText: text, text: async () => JSON.stringify({ data: null }) };
}

test("071 unit 9, review 1: the plan is made again under the card lock from the box as it is then, so a box stopped while the resize waited for the lock is asked again and is not started", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const fox = await server(bridge, backend, "shared", "amber-fox");
  const plan = await backend.planResize(fox.guest, "linux", size("none"), [], signal());
  assert.equal(plan.gpu?.way, "restart");
  let release: (() => void) | null = null;
  const held = underCardLock(`${bridge.url.replace(/\/+$/, "")}#pve`, () => new Promise<void>((resolve) => (release = resolve)));
  const resizing = backend.resize(fox.guest, "linux", size("none"), { restart: true, agreed: plan.gpu! }, signal());
  await new Promise((resolve) => setTimeout(resolve, 300));
  bridge.proxmox.guests.get(fox.vmid)!.status = "stopped";
  bridge.pass();
  assert.equal(bridge.node.isRunning(fox.vmid), false);
  release!();
  await held;
  await assert.rejects(resizing, (error: unknown) => {
    assert.ok(error instanceof GpuPlanChanged, String(error));
    assert.equal(error.agentMessage, "Not resized: when you checked, amber-fox would lose card 0 with a restart; now amber-fox has stopped since, so it would lose its card while stopped. Call box_resize again to do that, or ask the user. BB Box changed nothing.");
    assert.equal(error.plan.stopped, true, "the plan it says is the plan now");
    return true;
  });
  assert.equal(bridge.node.isRunning(fox.vmid), false, "not started");
  assert.deepEqual(bridge.gpuTags(fox.vmid), [marker("shared", CARD_A, 1)], "nothing written");
});

test("071 unit 9, review 2: an unanswered request is not taken as refused: when the helper grants it late and its claim cannot be asked back, the box reports the claim the helper holds", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched !== null && bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.shared."))) bridge.answering = false;
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  watched = fox.vmid;
  bridge.proxmox.intercept = (call) => {
    if (call.method !== "PUT" || !call.path.endsWith(`/lxc/${fox.vmid}/config`) || !(call.params.tags ?? "").includes("gpu.none.")) return undefined;
    watched = null;
    bridge.answering = true;
    bridge.pass();
    return refused("CT is locked (backup)");
  };
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.gpu, "shared");
    assert.deepEqual(error.guest.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
    assert.match(error.message, /^Amber-fox is stopped, with its disk as it was: the host's GPU helper on pve did not answer within 10 s\. It holds a shared GPU, card 0 now\. /);
    return true;
  });
  bridge.proxmox.intercept = undefined;
  assert.deepEqual(bridge.lines(fox.vmid), cardLines(CARD_A, "server"), "the helper wrote the card it granted");
});

test("071 unit 9, review 6: a change in place whose marker cannot be written puts back the cores it changed and keeps its claim", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  bridge.proxmox.intercept = (call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${elm.vmid}/config`) && (call.params.tags ?? "").includes("gpu.whole.") ? refused("CT is locked (backup)") : undefined);
  await assert.rejects(backend.resize(elm.guest, "linux", size("whole", 4), { restart: false }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeHolds && !(error instanceof ResizeLeftStopped), String(error));
    assert.equal(error.gpu, "shared");
    assert.equal(error.guest.claim?.part, "shared");
    assert.match(error.message, /^Not resized: BB Box could not ask for its new GPU, as .*\. Its GPU is as it was: a shared GPU, card 0\. Try again, or run bb box doctor\.$/);
    return true;
  });
  bridge.proxmox.intercept = undefined;
  assert.equal(bridge.proxmox.guests.get(elm.vmid)!.config.cores, "2", "its cores put back");
  assert.ok(bridge.node.isRunning(elm.vmid));
  assert.ok(bridge.gpuTags(elm.vmid)[0]?.startsWith(`gpu.shared.${A}.`), bridge.gpuTags(elm.vmid).join(" "));
});

test("071 unit 9, Fable 1: a failed change asks back the marker the box had, its card and part with a fresh generation, even where its claim yielded", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    perGpu: 4,
    onSleep: () => {
      if (watched !== null && bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.none."))) bridge.answering = false;
    },
  });
  anotherInstallRunning(bridge, 7069, CARD_B);
  const owl = await server(bridge, backend, "shared", "swift-owl");
  assert.equal(owl.guest.claim?.card, A);
  await stopped(bridge, backend, owl.guest);
  await backend.acquire(box("linux", "whole", "thr_job", "whole-job"), null, hooks(), signal());
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim ${owl.vmid} g1 yielded ${A}`)), bridge.node.reportLines().join("\n"));
  watched = owl.vmid;
  await assert.rejects(backend.resize(owl.guest, "linux", size("none"), { restart: false }, signal()), (error: unknown) => error instanceof ResizeHolds);
  watched = null;
  const tags = bridge.gpuTags(owl.vmid);
  assert.equal(tags.length, 1);
  assert.match(tags[0]!, new RegExp(`^gpu\\.shared\\.${A}\\.g([3-9]|\\d{2,})$`), "it asks back its shared card, not none");
});

test("071 unit 9, Fable 2: when a refused marker cannot be asked back on a box the helper holds no claim for, the box reports the marker as it stands, which its next start places", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched === null || !bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.shared."))) return;
      bridge.proxmox.guests.get(watched)!.config.lock = "backup";
      watched = null;
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  assert.deepEqual(bridge.gpuTags(fox.vmid), []);
  watched = fox.vmid;
  bridge.proxmox.intercept = (call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${fox.vmid}/config`) && (call.params.tags ?? "").includes("gpu.none.") ? refused("CT is locked (backup)") : undefined);
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.gpu, "shared");
    assert.deepEqual(error.guest.claim, { card: A, part: "shared", generation: 1, answer: "refused" });
    assert.match(error.message, /Its marker still asks for a shared GPU, card 0, which the host's GPU helper refused, and the helper holds no claim for it, so its next start places it on a card with room for that, or does not start it\./);
    return true;
  });
  bridge.proxmox.intercept = undefined;
  delete bridge.proxmox.guests.get(fox.vmid)!.config.lock;
  bridge.pass();
  const started = await backend.start(fox.guest, signal());
  assert.equal(started && "claim" in started ? started.claim?.part : undefined, "shared", "its start does what the record says");
});

test("071 unit 9, Fable 3: a resize to the GPU part the box's marker already holds still changes its cores", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  const resized = await backend.resize(elm.guest, "linux", size("shared", 4), { restart: false }, signal());
  assert.equal(resized.size?.cores, 4);
  assert.equal(bridge.proxmox.guests.get(elm.vmid)!.config.cores, "4");
  assert.equal(resized.claim?.part, "shared");
});

test("071 unit 9, Fable 4: the disk grows only once the new claim is granted, so a restart left stopped has its disk as it was, and a granted one grows it", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched !== null && bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.shared."))) bridge.answering = false;
    },
  });
  const fox = await server(bridge, backend, "none", "amber-fox");
  const disk = bridge.proxmox.guests.get(fox.vmid)!.config.rootfs;
  watched = fox.vmid;
  await assert.rejects(backend.resize(fox.guest, "linux", { ...size("shared"), diskGiB: 16 }, { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.guest.size?.diskGiB, Number(/size=(\d+)G/.exec(disk ?? "")?.[1]));
    return true;
  });
  watched = null;
  bridge.answering = true;
  bridge.pass();
  assert.equal(bridge.proxmox.guests.get(fox.vmid)!.config.rootfs, disk, "the disk did not grow");
  await backend.start(fox.guest, signal());
  bridge.pass();
  const grown = await backend.resize(fox.guest, "linux", { ...size("shared"), diskGiB: 16 }, { restart: true }, signal());
  assert.equal(grown.size?.diskGiB, 16);
  assert.equal(grown.claim?.part, "shared");
});

test("071 unit 9, gate F1a: a start refused after the grant is said in whole sentences, Proxmox's words ended before BB Box's", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const fox = await server(bridge, backend, "none", "amber-fox");
  bridge.proxmox.intercept = (call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${fox.vmid}/config`) && /(^|;)bb-power\.start\./.test(call.params.tags ?? "") ? refused("CT is locked (backup)") : undefined);
  await assert.rejects(backend.resize(fox.guest, "linux", size("shared"), { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.gpu, "shared");
    assert.match(error.message, /CT is locked \(backup\)\. It is stopped, with its disk as it was\. Start tries again; bb box doctor has more\.$/);
    assert.match(error.agentMessage ?? "", /CT is locked \(backup\)\. It is stopped, with its disk as it was\. Start it with box_start, or ask the user\.$/);
    return true;
  });
  bridge.proxmox.intercept = undefined;
});

test("071 unit 9, Astra re-review 1: a resize cancelled after the helper granted its new claim still puts the cores and the old claim back on a signal of its own, and reports what the helper holds", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const abort = new AbortController();
  const backend = bridge.backend({
    onSleep: () => {
      if (watched === null || !bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.whole."))) return;
      bridge.pass();
      watched = null;
      abort.abort();
    },
  });
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  watched = elm.vmid;
  await assert.rejects(backend.resize(elm.guest, "linux", size("whole", 4), { restart: false }, abort.signal), (error: unknown) => {
    assert.ok(error instanceof ResizeHolds && !(error instanceof ResizeLeftStopped), String(error));
    const held = bridge.node.ledger().guests[elm.vmid]?.claim;
    assert.equal(held?.answer, "granted");
    assert.equal(error.gpu, held?.part, "the part reported is the one the helper holds");
    assert.equal(error.guest.claim?.part, held?.part);
    assert.equal(error.guest.claim?.card, held?.card);
    assert.equal(error.gpu, "shared", "the old claim was asked back though the resize was cancelled");
    assert.match(error.message, /^Not resized: the resize was cancelled before the host's GPU helper answered its request for a new GPU\. Its GPU is as it was: a shared GPU, card 0\. /);
    return true;
  });
  assert.equal(bridge.proxmox.guests.get(elm.vmid)!.config.cores, "2", "its cores put back");
  assert.match(bridge.gpuTags(elm.vmid)[0] ?? "", new RegExp(`^gpu\\.shared\\.${A}\\.g\\d+$`));
});

test("071 unit 9, Astra re-review 2: a start after a late refusal, which starts the box with no card as its claim of none says, reports no claim, so the record's claim and GPU part are cleared", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  let watched: number | null = null;
  const backend = bridge.backend({
    onSleep: () => {
      if (watched !== null && bridge.gpuTags(watched).some((tag) => tag.startsWith("gpu.shared."))) bridge.answering = false;
    },
  });
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  const none = await backend.resize(elm.guest, "linux", size("none"), { restart: true }, signal());
  assert.equal(none.claim, null);
  const had = bridge.gpuTags(elm.vmid)[0]!;
  watched = elm.vmid;
  bridge.proxmox.intercept = (call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${elm.vmid}/config`) && (call.params.tags ?? "").includes("gpu.none.") && !(call.params.tags ?? "").includes(had) ? refused("CT is locked (backup)") : undefined);
  const left = await backend.resize(none, "linux", size("shared"), { restart: true }, signal()).catch((error: unknown) => error);
  assert.ok(left instanceof ResizeLeftStopped, String(left));
  assert.equal(left.gpu, "shared");
  assert.equal(left.guest.claim?.answer, "asked");
  watched = null;
  bridge.proxmox.intercept = undefined;
  bridge.answering = true;
  bridge.proxmox.guests.get(elm.vmid)!.config.lock = "backup";
  bridge.pass();
  delete bridge.proxmox.guests.get(elm.vmid)!.config.lock;
  bridge.pass();
  const started = await backend.start(left.guest, signal());
  assert.ok(bridge.node.isRunning(elm.vmid));
  assert.deepEqual(bridge.lines(elm.vmid), [], "it started with no card");
  assert.equal(startedGuest(left.guest, started).claim, null, "the asked claim is cleared");
  assert.equal(startedGpu(started), "none", "and its GPU part is none");
  await stopped(bridge, backend, left.guest);
  const again = await backend.start(left.guest, signal());
  assert.equal(startedGpu(again), "none", "a start under a marker of none says so too");
});

test("071 unit 9, Astra re-review 3 and Fable low 1: a start that fails after the disk grew says the disk's size now, not that it is as it was", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const fox = await server(bridge, backend, "none", "amber-fox");
  const before = Number(/size=(\d+)G/.exec(bridge.proxmox.guests.get(fox.vmid)!.config.rootfs ?? "")?.[1]);
  const grownTo = before + 8;
  bridge.proxmox.intercept = (call) => (call.method === "PUT" && call.path.endsWith(`/lxc/${fox.vmid}/config`) && /(^|;)bb-power\.start\./.test(call.params.tags ?? "") ? refused("CT is locked (backup)") : undefined);
  await assert.rejects(backend.resize(fox.guest, "linux", { ...size("shared"), diskGiB: grownTo }, { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.equal(error.guest.size?.diskGiB, grownTo);
    assert.doesNotMatch(error.message, /disk as it was/);
    assert.doesNotMatch(error.agentMessage ?? "", /disk as it was/);
    assert.match(error.message, new RegExp(`CT is locked \\(backup\\)\\. It is stopped, with its disk grown to ${grownTo} GiB\\. Start tries again; bb box doctor has more\\.$`));
    assert.match(error.agentMessage ?? "", new RegExp(`It is stopped, with its disk grown to ${grownTo} GiB\\. Start it with box_start, or ask the user\\.$`));
    return true;
  });
  bridge.proxmox.intercept = undefined;
  assert.equal(bridge.proxmox.guests.get(fox.vmid)!.config.rootfs?.includes(`size=${grownTo}G`), true);
});

test("071 unit 9, Astra re-review 1: a change in place cancelled after its claim was granted, while its disk grew, reports the claim and the disk it has", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const elm = await server(bridge, backend, "shared", "quiet-elm");
  const before = Number(/size=(\d+)G/.exec(bridge.proxmox.guests.get(elm.vmid)!.config.rootfs ?? "")?.[1]);
  const abort = new AbortController();
  bridge.proxmox.intercept = (call) => {
    if (call.method === "PUT" && call.path.endsWith(`/lxc/${elm.vmid}/resize`)) abort.abort();
    return undefined;
  };
  const resized = await backend.resize(elm.guest, "linux", { ...size("whole"), diskGiB: before + 8 }, { restart: false }, abort.signal);
  bridge.proxmox.intercept = undefined;
  assert.ok(abort.signal.aborted);
  assert.equal(resized.claim?.part, "whole");
  assert.equal(resized.claim?.answer, "granted");
  assert.equal(resized.size?.diskGiB, before + 8);
  assert.equal(bridge.node.ledger().guests[elm.vmid]?.claim?.part, "whole");
});

test("071 unit 9, Astra re-review 3: a start that fails after the grant, in words that say the box is stopped, says so once, with the disk's size now", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ perGpu: 1 });
  await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  bridge.pass();
  const fox = await server(bridge, backend, "none", "amber-fox");
  const before = Number(/size=(\d+)G/.exec(bridge.proxmox.guests.get(fox.vmid)!.config.rootfs ?? "")?.[1]);
  bridge.seenInBox.set(fox.vmid, { shows: "No devices were found" });
  await assert.rejects(backend.resize(fox.guest, "linux", { ...size("shared"), diskGiB: before + 8 }, { restart: true }, signal()), (error: unknown) => {
    assert.ok(error instanceof ResizeLeftStopped, String(error));
    assert.match(error.message, /did not get card \d/);
    assert.equal(error.message.split("It is stopped").length, 2, error.message);
    assert.equal((error.agentMessage ?? "").split("It is stopped").length, 2, error.agentMessage ?? "");
    assert.match(error.message, new RegExp(`It is stopped, with its disk grown to ${before + 8} GiB\\. Start tries again; bb box doctor has more\\.$`));
    assert.doesNotMatch(error.message, /disk as it was/);
    return true;
  });
  bridge.seenInBox.delete(fox.vmid);
  assert.equal(bridge.proxmox.guests.get(fox.vmid)!.status, "stopped");
});
