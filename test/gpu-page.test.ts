import assert from "node:assert/strict";
import { test } from "node:test";
import type { BoxView } from "../src/plugin/views.ts";
import {
  gpuBadge,
  gpuFactLines,
  gpuFooter,
  gpuMates,
  gpuProgramsWords,
  holdsItsCard,
  holdsNoCardWhileStopped,
  HOLDS_NO_CARD,
  monitorCard,
  otherCheckNotice,
  readCardFact,
  userspaceNotice,
  wrongCardNotice,
} from "../src/plugin/gpu-page.ts";
const CARD = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

function box(patch: Partial<BoxView> = {}): BoxView {
  return {
    id: "bxamberfox01",
    name: "amber-fox",
    kind: "linux",
    kindLabel: "Linux",
    backendLabel: "Proxmox LXC on pve",
    nature: "virtual",
    form: "LXC",
    shared: false,
    role: "box",
    state: "ready",
    error: null,
    stopped: null,
    createdAt: NOW,
    readyAt: NOW,
    os: "linux",
    arch: "x86_64",
    gpu: true,
    gpuPart: "shared",
    claim: { card: CARD, part: "shared", generation: 1, answer: "granted" },
    requires: [],
    extras: [],
    docker: false,
    desktop: false,
    display: null,
    control: null,
    computerUse: false,
    terminal: true,
    address: null,
    facts: [{ label: "GPU", value: "card 1, shared, NVIDIA RTX 4090, 24 GiB" }],
    timings: {},
    enrol: { state: "enrolled", hostId: null, error: null },
    enrols: true,
    canStopStart: true,
    size: "4 cores, 8 GiB memory",
    ...patch,
  };
}

test("071 unit 14: a card fact keeps the model when the model itself has commas", () => {
  assert.deepEqual(readCardFact("card 0, whole, NVIDIA RTX PRO 6000, Blackwell Max-Q, 96 GiB"), {
    index: 0,
    part: "whole",
    model: "NVIDIA RTX PRO 6000, Blackwell Max-Q",
    memory: "96 GiB",
    why: null,
  });
  assert.equal(readCardFact("card 1, shared: the check in it did not finish")?.why, "the check in it did not finish");
  assert.equal(readCardFact("GPU-0a1b"), null);
});

test("071 unit 14: the GPU fact names the card once, with the model or the other boxes", () => {
  assert.deepEqual(gpuFactLines(box({ gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" }, facts: [{ label: "GPU", value: "card 0, whole, NVIDIA RTX 4090, 24 GiB" }] }), []), {
    first: "Card 0, whole",
    second: "NVIDIA RTX 4090 · 24 GiB",
  });
  const mate = box({ id: "bxlonepine01", name: "lone-pine" });
  assert.deepEqual(gpuFactLines(box(), [mate]), { first: "Card 1, shared", second: "with lone-pine" });
  assert.deepEqual(gpuFactLines(box(), [mate, box({ id: "bxcalmreef01", name: "calm-reef" })]), { first: "Card 1, shared", second: "with lone-pine and calm-reef" });
  assert.deepEqual(gpuFactLines(box(), []), { first: "Card 1, shared", second: "NVIDIA RTX 4090 · 24 GiB" });
});

test("071 unit 14: a stopped shared box on Proxmox LXC holds no card, and one on Docker or a whole card keeps it", () => {
  const stopped = box({ state: "stopped" });
  assert.equal(holdsNoCardWhileStopped(stopped), true);
  assert.equal(holdsItsCard(stopped), false);
  assert.deepEqual(gpuFactLines(stopped, []), { first: "Card 1 when it starts, if it has room", second: null });
  assert.equal(gpuFooter(stopped, "pve"), "Stopped: it holds no place on the card. When it starts it goes back to this card if there is room, or to another card.");
  const docker = box({ state: "stopped", form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "GPU", value: "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB" }] });
  assert.equal(holdsNoCardWhileStopped(docker), false);
  assert.equal(holdsItsCard(docker), true);
  assert.equal(gpuFactLines(docker, [])?.first, "Card 0, shared");
  assert.match(gpuFooter(docker, "devpc"), /keeps its card while stopped/);
  const whole = box({ state: "stopped", gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 2, answer: "granted" } });
  assert.equal(holdsNoCardWhileStopped(whole), false);
  assert.equal(holdsItsCard(whole), true);
  assert.equal(gpuFactLines(whole, [])?.first, "Card 1, whole");
  assert.match(gpuFooter(whole, "pve"), /the card stays its own/);
  assert.equal(holdsNoCardWhileStopped(box()), false);
});

test("071 unit 14: the badge says GPU for a shared card and Whole GPU for a whole one", () => {
  assert.equal(gpuBadge(box()), "GPU");
  assert.equal(gpuBadge(box({ gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } })), "Whole GPU");
  assert.equal(gpuBadge(box({ gpu: false, gpuPart: "none" })), null);
  assert.equal(gpuBadge(box({ state: "stopped" })), "GPU");
});

test("071 unit 14: a stopped shared box on Proxmox LXC is the one whose row says it holds no card", () => {
  assert.equal(holdsNoCardWhileStopped(box({ state: "stopped" })), true);
  assert.equal(HOLDS_NO_CARD, "holds no card while stopped");
  assert.equal(holdsNoCardWhileStopped(box({ state: "stopped", form: "Docker", backendLabel: "Docker on devpc" })), false);
  assert.equal(holdsNoCardWhileStopped(box({ state: "ready" })), false);
  assert.equal(holdsNoCardWhileStopped(box({ state: "stopped", gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } })), false);
});

test("071 unit 14: mates are the other boxes of this install that hold the same card", () => {
  const here = box();
  const mate = box({ id: "bxlonepine01", name: "lone-pine" });
  const stoppedShared = box({ id: "bxstopped001", name: "quiet-elm", state: "stopped" });
  const otherHost = box({ id: "bxotherhost1", name: "other-host", backendLabel: "Proxmox LXC on other" });
  const dockerStopped = box({ id: "bxdocker0001", name: "kept-card", state: "stopped", form: "Docker", backendLabel: "Docker on devpc" });
  const sameDocker = box({ form: "Docker", backendLabel: "Docker on devpc", state: "stopped" });
  assert.deepEqual(gpuMates(here, [here, mate, stoppedShared, otherHost]).map((each) => each.name), ["lone-pine"]);
  assert.deepEqual(gpuMates(sameDocker, [sameDocker, dockerStopped]).map((each) => each.name), ["kept-card"]);
  assert.equal(holdsItsCard(box({ claim: { card: null, part: "shared", generation: 1, answer: "refused" } })), false);
});

test("071 unit 14: notices name a wrong card, a userspace that does not match, and any other card check", () => {
  const userspace = "card 1, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142";
  const running = box({ facts: [{ label: "GPU", value: userspace }] });
  assert.match(userspaceNotice(running) ?? "", /nvidia-smi fails in amber-fox: its NVIDIA userspace is 570\.86, and the host's driver is 580\.142/);
  assert.equal(wrongCardNotice(running), null);
  const stopped = box({ state: "stopped", facts: [{ label: "GPU", value: userspace }] });
  assert.match(userspaceNotice(stopped) ?? "", /Start it, then update it/);
  const wrong = box({ facts: [{ label: "GPU", value: "card 1, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed no card, not its card " + CARD }] });
  assert.match(wrongCardNotice(wrong) ?? "", /on the wrong card/);
  assert.match(wrongCardNotice(wrong) ?? "", /does not stop it/);
  assert.equal(userspaceNotice(wrong), null);
  const missed = box({ state: "stopped", facts: [{ label: "GPU", value: "card 1, shared: nvidia-smi in it listed no card, not its card " + CARD }] });
  assert.match(wrongCardNotice(missed) ?? "", /did not get card 1/);
  assert.match(wrongCardNotice(missed) ?? "", /Start tries again/);
  const picked = box({ form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "GPU", value: "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB: CUDA in it picks GPU-other, not its card GPU-" + CARD }] });
  assert.match(wrongCardNotice(picked) ?? "", /on the wrong card/);
  const cuda = box({ facts: [{ label: "GPU", value: "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB: CUDA's driver did not initialise in it: it returned 802" }] });
  assert.equal(wrongCardNotice(cuda), null);
  assert.match(otherCheckNotice(cuda) ?? "", /returned 802/);
  assert.equal(otherCheckNotice(wrong), null);
});

test("071 unit 14: the card's last line says what a claim means, and a reading picks the box's model", () => {
  assert.match(gpuFooter(box(), "pve"), /share its memory and its time/);
  assert.match(gpuFooter(box({ gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } }), "pve"), /on Proxmox LXC a whole card is fenced/);
  assert.match(gpuFooter(box({ gpuPart: "whole", form: "Docker", backendLabel: "Docker on devpc", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } }), "devpc"), /not a fence/);
  const cards = [
    { index: 0, name: "NVIDIA RTX 4090" },
    { index: 1, name: "NVIDIA GeForce RTX 5090" },
  ];
  assert.equal(monitorCard(cards, "NVIDIA GeForce RTX 5090")?.index, 1);
  assert.equal(monitorCard(cards.slice(0, 1), "something else")?.index, 0);
  assert.equal(gpuProgramsWords([{ name: "python3", pid: 3310 }]), ": python3 (3310) has the GPU open");
  assert.equal(gpuProgramsWords([]), "");
  assert.deepEqual(gpuFactLines(box({ facts: [{ label: "GPU", value: "GPU-0a1b" }] }), []), { first: "Shared", second: "GPU-0a1b" });
});
