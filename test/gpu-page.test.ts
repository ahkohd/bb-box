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
  countsAsThisBox,
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
  assert.deepEqual(readCardFact("a card, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142"), {
    index: null,
    part: "shared",
    model: "NVIDIA RTX 4090",
    memory: "24 GiB",
    why: "nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142",
  });
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
  assert.deepEqual(gpuFactLines(box({ facts: [{ label: "GPU", value: "a card, shared, NVIDIA RTX 4090, 24 GiB" }] }), []), { first: "Its card, shared", second: "NVIDIA RTX 4090 · 24 GiB" });
  assert.deepEqual(gpuFactLines(box({ state: "stopped", facts: [{ label: "GPU", value: "a card, shared" }] }), []), { first: "Its card when it starts, if it has room", second: null });
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
  const unindexed = "a card, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it fails: its NVIDIA userspace is 570.86 and the host's driver 580.142";
  assert.match(userspaceNotice(box({ facts: [{ label: "GPU", value: unindexed }] })) ?? "", /570\.86/);
  assert.match(wrongCardNotice(wrong) ?? "", /card 1/);
  assert.doesNotMatch(wrongCardNotice(wrong) ?? "", new RegExp(CARD));
  const missed = box({ state: "stopped", facts: [{ label: "GPU", value: "card 1, shared: nvidia-smi in it listed no card, not its card " + CARD }] });
  assert.equal(wrongCardNotice(missed), null);
  const missedDocker = box({ state: "stopped", form: "Docker", backendLabel: "Docker on devpc", facts: missed.facts });
  assert.match(wrongCardNotice(missedDocker) ?? "", /last start found it on the wrong card/);
  assert.match(wrongCardNotice(missedDocker) ?? "", /devices do not change/);
  assert.doesNotMatch(wrongCardNotice(missedDocker) ?? "", /Start tries again/);
  const picked = box({ form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "GPU", value: "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB: CUDA in it picks GPU-11111111-1111-1111-1111-111111111111, not its card GPU-" + CARD }] });
  assert.match(wrongCardNotice(picked) ?? "", /on the wrong card/);
  const named = wrongCardNotice(picked, [{ uuid: "11111111-1111-1111-1111-111111111111", index: 2 }]);
  assert.match(named ?? "", /card 2/);
  assert.doesNotMatch(named ?? "", /11111111/);
  assert.doesNotMatch(named ?? "", new RegExp(CARD));
  const cuda = box({ facts: [{ label: "GPU", value: "card 0, shared, NVIDIA GeForce RTX 5090, 32 GiB: CUDA's driver did not initialise in it: it returned 802" }] });
  assert.equal(wrongCardNotice(cuda), null);
  assert.match(otherCheckNotice(cuda) ?? "", /returned 802/);
  assert.equal(otherCheckNotice(wrong), null);
});

test("071 unit 14: an unknown card reads as a card, two listed cards keep their indexes, and Proxmox LXC does not use the guest's index", () => {
  const unknown = "ffffffff-ffff-ffff-ffff-ffffffffffff";
  const listed = `card 1, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed card GPU-${unknown}, not its card GPU-${CARD}`;
  const unseen = wrongCardNotice(box({ facts: [{ label: "GPU", value: listed }] }));
  assert.match(unseen ?? "", /listed a card, not its card 1/);
  assert.doesNotMatch(unseen ?? "", /listed card a card/);
  const first = "11111111-1111-1111-1111-111111111111";
  const second = "22222222-2222-2222-2222-222222222222";
  const both = `card 4, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed cards GPU-${first} and GPU-${second}, not its card GPU-${CARD}`;
  const docker = box({ form: "Docker", backendLabel: "Docker on devpc", facts: [{ label: "GPU", value: both }] });
  const plural = wrongCardNotice(docker, [
    { uuid: first, index: 0 },
    { uuid: second, index: 1 },
  ]);
  assert.match(plural ?? "", /listed cards 0 and 1, not its card 4/);
  assert.doesNotMatch(plural ?? "", /cards card/);
  const other = "11111111-1111-1111-1111-111111111111";
  const guest = `card 0, shared, NVIDIA RTX 4090, 24 GiB: nvidia-smi in it listed card GPU-${other}, not its card GPU-${CARD}`;
  const lxc = wrongCardNotice(box({ facts: [{ label: "GPU", value: guest }] }), [{ uuid: other, index: 0 }]);
  assert.match(lxc ?? "", /listed another card, not its card 0/);
  assert.doesNotMatch(lxc ?? "", /listed card 0/);
});

test("071 unit 14: the card's last line says what a claim means, and a reading picks the box's model", () => {
  assert.match(gpuFooter(box(), "pve"), /share its memory and its time/);
  assert.match(gpuFooter(box({ gpuPart: "whole", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } }), "pve"), /on Proxmox LXC a whole card is fenced/);
  assert.match(gpuFooter(box({ gpuPart: "whole", form: "Docker", backendLabel: "Docker on devpc", claim: { card: CARD, part: "whole", generation: 1, answer: "granted" } }), "devpc"), /not a fence/);
  const same = "NVIDIA RTX 4090";
  const cards = [
    { index: 0, uuid: "11111111-1111-1111-1111-111111111111", name: same },
    { index: 1, uuid: CARD, name: same },
  ];
  assert.equal(monitorCard(cards, { uuid: CARD, index: 1 })?.index, 1);
  assert.equal(monitorCard(cards, { uuid: "ffffffff-ffff-ffff-ffff-ffffffffffff", index: 1 }), null);
  assert.equal(monitorCard(cards.map(({ index, name }) => ({ index, name })), { uuid: CARD, index: 1 })?.index, 1);
  assert.equal(monitorCard(cards, { uuid: null, index: null }), null);
  assert.equal(monitorCard(cards.slice(0, 1), { uuid: null, index: null }), null);
  assert.equal(gpuProgramsWords([{ name: "python3", pid: 3310 }]), ": python3 (3310) has the GPU open");
  assert.equal(gpuProgramsWords([]), "");
  assert.deepEqual(gpuFactLines(box({ facts: [{ label: "GPU", value: "GPU-0a1b" }] }), []), { first: "Shared", second: "GPU-0a1b" });
});

test("071 unit 14: a Docker box counts its measured use on every card, and any other box only the card it holds", () => {
  const other = { index: 0, uuid: "11111111-1111-1111-1111-111111111111" };
  const held = { index: 1, uuid: CARD };
  const lxc = box();
  assert.equal(countsAsThisBox(lxc, held), true);
  assert.equal(countsAsThisBox(lxc, other), false);
  const docker = box({ form: "Docker", backendLabel: "Docker on devpc" });
  assert.equal(countsAsThisBox(docker, held), true);
  assert.equal(countsAsThisBox(docker, other), true);
});
