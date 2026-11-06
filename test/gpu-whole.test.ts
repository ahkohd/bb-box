import assert from "node:assert/strict";
import { test } from "node:test";
import { AudienceError, BackendError, type AcquireHooks, type BoxIdentity, type GpuPart, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { CardReservations, placeShared, placeWhole, reservationsOn, type PlaceInput } from "../src/backends/proxmox-lxc/gpu-claims.ts";
import { answerTo, parseHelperLines, type HelperLines } from "../src/backends/proxmox-lxc/gpu-marking.ts";
import { PERSON, blockWords, type CardNamer } from "../src/backends/proxmox-lxc/gpu-refusals.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, SECOND_INSTALL, SECOND_POOL } from "./gpu-helper/claims-bridge.ts";
import { cardLines, marker } from "./gpu-helper/node.ts";
import { gpuPartsText, gpuRoomText } from "../src/plugin/tools.ts";
import { Backends } from "../src/backends/index.ts";
import { MemoryStorage } from "./helpers.ts";
import { emptyDocument, generalConfig, readDraft } from "../src/core/document.ts";
import { OPTIONS } from "../src/plugin/config-edits.ts";
import type { KindView } from "../src/plugin/views.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
let counter = 0;

function box(kind: string, gpu: GpuPart, threadId = "thr_whole", name?: string): BoxIdentity {
  counter++;
  return { boxId: `bxwhole${counter}`, threadId, name: name ?? `whole-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 6), size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function hooks(): AcquireHooks {
  return { claim: async () => {}, starting: async () => {}, timing: () => {} };
}

const signal = () => new AbortController().signal;
const releasing: ReleaseHooks = {
  resetting: async () => {},
  timing: () => {},
};

function record(nvidia: string | null): string {
  return JSON.stringify({ contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261105-090000-1a2b", built: "2026-11-05T09:00:00Z", os: "Ubuntu 24.04.5 LTS", tools: {}, nvidia });
}

function withUserspace(bridge: ClaimsBridge): void {
  bridge.proxmox.guests.get(9000)!.config.description = `bb-box linux template (NVIDIA 580.142, no card), built 2026-11-05. See /usr/share/bb-box/template-release inside.\n${record("580.142")}`;
}

function clones(bridge: ClaimsBridge): number {
  return bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
}

function runningElsewhere(bridge: ClaimsBridge, vmid: number, card: typeof CARD_A): void {
  bridge.desktop(vmid, card, { ...box("linux-desktop", "shared", "thr_elsewhere"), name: `other-${vmid}` }, SECOND_INSTALL, { marker: marker("shared", card, 1), running: true, pool: SECOND_POOL });
  bridge.pass();
}

function stopped(made: Guest): Guest {
  return made;
}

const WHOLE_FIX = "Release a box on one of the cards, ask for gpu shared, or ask for gpu none.";

function lines(text: string): HelperLines {
  return parseHelperLines(text);
}

const report = [
  `gpu GPU-${A} 00000000:21:00.0 0 97000 97887`,
  `gpu GPU-${B} 00000000:D1:00.0 1 90000 97887`,
  `card ${A} pci 0000:21:00.0 minor 1 drm card2 renderD129`,
  `card ${B} pci 0000:d1:00.0 minor 0 drm card1 renderD128`,
  "ledger entries 0",
];

function rules(holders: readonly string[] = [], more: Partial<PlaceInput> & { readonly retirable?: ReadonlySet<number>; readonly ownPool?: ReadonlySet<number> } = {}) {
  const parsed = lines([...report, ...holders].join("\n"));
  return {
    lines: parsed,
    memory: new Map([
      [A, { freeMiB: 97_000, totalMiB: 97_887 }],
      [B, { freeMiB: 90_000, totalMiB: 97_887 }],
    ]),
    installId: "test",
    reserved: [],
    limit: null,
    needMiB: 1024,
    candidates: new Set([A, B]),
    prefer: null,
    vmid: null,
    outstanding: [],
    retirable: new Set<number>(),
    ownPool: new Set<number>(),
    ...more,
  };
}

const byVmid: CardNamer = { guest: (vmid) => ({ is: "box", name: `CT ${vmid}`, threadId: null }), title: () => null };

function said(placed: { readonly is: string; readonly reasons?: readonly Parameters<typeof blockWords>[0][] }): string[] {
  return placed.is === "refused" ? placed.reasons!.map((reason) => blockWords(reason, byVmid, PERSON)) : [];
}

test("071 unit 8: the whole-card rules: stopped shared boxes the helper manages yield, every other guest on the card blocks it, a reservation or an unanswered request closes it, and the card with the least memory in use is chosen", () => {
  const free = placeWhole(rules());
  assert.ok(free.is === "placed" && free.card.uuid === A, "card 0 has the least memory in use");
  const preferred = placeWhole(rules([], { prefer: B }));
  assert.ok(preferred.is === "placed" && preferred.card.uuid === B, "a box's last card first, where it is free");
  const yielding = placeWhole(rules([`holder ${A} 11 shared stopped install test managed`], { ownPool: new Set([11]) }));
  assert.ok(yielding.is === "placed" && yielding.card.uuid === A);
  assert.deepEqual(yielding.yielding, [11], "this install's own stopped shared boxes yield");
  assert.deepEqual(said(placeWhole(rules([`holder ${A} 11 shared stopped install test managed`, `holder ${A} 12 shared stopped install other managed`], { ownPool: new Set([11]), candidates: new Set([A]) }))), ["card 0 has CT 12 holding it while stopped"], "another install's never yields");
  assert.deepEqual(said(placeWhole(rules([`holder ${A} 13 shared stopped install test managed`], { candidates: new Set([A]) }))), ["card 0 has CT 13 holding it while stopped"], "nor this install's outside its pool");
  const blocked = placeWhole(
    rules([
      `holder ${A} 21 shared running install test managed`,
      `holder ${B} 22 shared stopped install other unmanaged`,
    ]),
  );
  assert.equal(blocked.is, "refused");
  assert.deepEqual(said(blocked), ["card 0 has CT 21 running", "card 1 has CT 22 holding it while stopped"]);
  assert.deepEqual(said(placeWhole(rules([`holder ${A} 31 whole stopped install test managed`], { candidates: new Set([A]) }))), ["card 0 is CT 31's whole card"], "a stopped whole box keeps its card");
  const reservations = new CardReservations();
  reservations.add(A, "shared", 384, "bxr", null, { name: "amber-fox", threadId: "thr_x" });
  assert.deepEqual(said(placeWhole(rules([], { reserved: reservations.live(lines(report.join("\n")), 0), candidates: new Set([A]) }))), ["bb-box is placing amber-fox on card 0"]);
  assert.deepEqual(said(placeWhole(rules([], { outstanding: [{ vmid: 40, marker: { card: A, generation: 3 } }], candidates: new Set([A]) }))), ["the GPU helper has not answered CT 40's request g3 on card 0"]);
  assert.deepEqual(said(placeWhole(rules([`unsettled 41 ${A} g2`], { candidates: new Set([A]) }))), ["card 0 waits for CT 41 to ask again, as the GPU helper's ledger was lost and it may hold the card"]);
  assert.deepEqual(said(placeWhole(rules([], { memory: new Map([[A, { freeMiB: 900, totalMiB: 97_887 }]]), candidates: new Set([A]) }))), ["card 0 has 900 MiB free when last read, less than the 1024 MiB a new server needs"]);
  assert.deepEqual(said(placeWhole(rules([], { memory: new Map(), candidates: new Set([A]) }))), ["card 0's free memory is not known from the GPU helper's report"]);
  const warm = placeWhole(rules([`holder ${A} 51 shared running install test managed`], { retirable: new Set([51]), candidates: new Set([A]) }));
  assert.ok(warm.is === "placed" && warm.card.uuid === A);
  assert.deepEqual(warm.retire, [51], "this install's warm guests on the card are retired, not counted");
});

test("071 unit 8: a card kept whole for a box bb-box is making takes no shared box, so a shared placement and a whole one never meet on a card", () => {
  const reservations = new CardReservations();
  reservations.add(A, "whole", 1024, "bxw", null, { name: "quiet-elm", threadId: "thr_job" });
  const live = reservations.live(lines(report.join("\n")), 0);
  const placed = placeShared({ ...rules([], { reserved: live, limit: 4 }), needMiB: 1024 });
  assert.ok(placed.is === "placed" && placed.card.uuid === B, "the shared box goes to the other card");
  const refused = placeShared({ ...rules([], { reserved: live, limit: 4, candidates: new Set([A]) }), needMiB: 1024 });
  assert.deepEqual(said(refused), ["card 0 is kept whole for quiet-elm, which bb-box is making"]);
});

test("071 unit 8: a server with a whole card is placed, marked whole in the write that labels it, granted, given the server set while stopped, and started on its card", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const room = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
  assert.equal(room.ok, true, room.message ?? "");
  const made = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  const vmid = Number(made.ref);
  assert.deepEqual(made.claim, { card: A, part: "whole", generation: 1, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(vmid), [marker("whole", CARD_A, 1)]);
  const tagged = bridge.proxmox.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`) && call.params.tags !== undefined);
  assert.ok(tagged[0]!.params.tags!.includes("box.") && tagged[0]!.params.tags!.includes(marker("whole", CARD_A, 1)), "one write gives the guest its labels and its whole marker");
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_A, "server"));
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim ${vmid} g1 granted whole ${A}`));
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${A} ${vmid} whole running `)), bridge.node.reportLines().join("\n"));
  assert.deepEqual(made.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: "card 0, whole, NVIDIA Fake Card, 96 GiB" });
  const shared = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(shared.claim?.card, B, "no other box goes on a whole card");
});

test("071 unit 8 gate: two whole acquires at once for one free card make one box and refuse the other before anything is copied, and the node has one whole claim", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  runningElsewhere(bridge, 7060, CARD_B);
  const before = clones(bridge);
  const results = await Promise.allSettled([backend.acquire(box("linux", "whole", "thr_one"), null, hooks(), signal()), backend.acquire(box("linux", "whole", "thr_two"), null, hooks(), signal())]);
  const made = results.filter((result) => result.status === "fulfilled");
  const refused = results.flatMap((result) => (result.status === "rejected" ? [result.reason as unknown] : []));
  assert.equal(made.length, 1, JSON.stringify(results.map((result) => result.status)));
  assert.equal(refused.length, 1);
  const error = refused[0];
  assert.ok(error instanceof BackendError && error.code === "no_capacity", String(error));
  assert.match(
    error.message,
    /^No card on pve is free for a whole card now: card 0 (is kept whole for whole-box-\d+, which bb-box is making|is whole-box-\d+'s whole card) and card 1 has CT 7060 of another install running\. Release a box on one of the cards, ask for gpu shared, or ask for gpu none\.$/,
  );
  assert.match(error.agentMessage ?? "", /^Not made: no card on pve is free for a whole card now: .* Ask for gpu shared, or ask the user\. bb-box changed nothing\.$/);
  assert.equal(clones(bridge), before + 1, "the refused acquire copied nothing");
  bridge.pass();
  assert.equal(bridge.node.reportLines().filter((line) => / granted whole /.test(line)).length, 1, bridge.node.reportLines().join("\n"));
  assert.equal(bridge.node.reportLines().filter((line) => /^holder \S+ \d+ whole /.test(line)).length, 1);
});

test("071 unit 8: a whole card refused while boxes run on the cards names them: to the person with their threads, to an agent by name only and with its own boxes to release", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ titles: { thr_train: "Train the model", thr_job: "Long job" } });
  const runner = await backend.acquire(box("linux", "shared", "thr_train", "lone-pine"), null, hooks(), signal());
  assert.equal(runner.claim?.card, A);
  const holder = await backend.acquire(box("linux", "whole", "thr_job", "quiet-elm"), null, hooks(), signal());
  assert.equal(holder.claim?.card, B);
  const before = clones(bridge);
  await assert.rejects(backend.acquire(box("linux", "whole", "thr_agent"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.message, `No card on pve is free for a whole card now: card 0 has lone-pine (in thread "Train the model") running and card 1 is quiet-elm's whole card (in thread "Long job"). ${WHOLE_FIX}`);
    assert.equal(error.agentMessage, "Not made: no card on pve is free for a whole card now: card 0 has lone-pine running and card 1 is quiet-elm's whole card. Ask for gpu shared, or ask the user. bb-box changed nothing.");
    return true;
  });
  await assert.rejects(backend.acquire(box("linux", "whole", "thr_train"), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.agentMessage, "Not made: no card on pve is free for a whole card now: card 0 has lone-pine running and card 1 is quiet-elm's whole card. Release one of your own boxes on card 0 (lone-pine), ask for gpu shared, or ask the user. bb-box changed nothing.");
    assert.doesNotMatch(error.agentMessage!, /Train the model|Long job|quiet-elm\)|settings/);
    return true;
  });
  assert.equal(clones(bridge), before, "refused before any copy");
  const room = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, [], undefined, { threadId: "thr_job" });
  assert.equal(room.ok, false);
  assert.equal(room.agentMessage, "Not made: no card on pve is free for a whole card now: card 0 has lone-pine running and card 1 is quiet-elm's whole card. Release one of your own boxes on card 1 (quiet-elm), ask for gpu shared, or ask the user. bb-box changed nothing.");
  const desktop = await backend.capacity("linux-desktop", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
  assert.match(desktop.message!, /^No card on pve is free for a whole card now: card 0 has lone-pine \(in thread "Train the model"\) running and card 1 is quiet-elm's whole card/);
});

test("071 unit 8 gate: a stopped shared box on the only free card yields to a whole box, its lines taken out while stopped, and its next start places it on the other card", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const sleeper = await backend.acquire(box("linux", "shared", "thr_sleep", "stopped-fox"), null, hooks(), signal());
  const sleeperVmid = Number(sleeper.ref);
  assert.equal(sleeper.claim?.card, A);
  await backend.stop(sleeper);
  bridge.pass();
  const whole = await backend.acquire(box("linux", "whole", "thr_job", "whole-job"), null, hooks(), signal());
  assert.equal(whole.claim?.card, A, "the stopped shared box does not keep the card from a whole box");
  bridge.pass();
  assert.deepEqual(bridge.lines(sleeperVmid), [], "the helper took the yielding box's lines out");
  assert.ok(bridge.node.reportLines().includes(`claim ${sleeperVmid} g1 yielded ${A} ${whole.ref}`), bridge.node.reportLines().join("\n"));
  assert.equal(bridge.proxmox.guests.get(sleeperVmid)!.status, "stopped");
  const started = await backend.start(stopped(sleeper), signal());
  assert.equal(bridge.proxmox.guests.get(sleeperVmid)!.status, "running");
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: B, part: "shared", generation: 2, answer: "granted" });
  assert.deepEqual(bridge.lines(sleeperVmid), cardLines(CARD_B, "server"), "it starts on the other card's lines");
  assert.deepEqual(bridge.lines(Number(whole.ref)), cardLines(CARD_A, "server"), "the whole box keeps its card");
});

test("071 unit 8: a stopped whole box keeps its card, which takes no other box, and starts on it again with no new claim", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const whole = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  await backend.stop(whole);
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${A} ${whole.ref} whole stopped `)));
  const shared = await backend.acquire(box("linux", "shared"), null, hooks(), signal());
  assert.equal(shared.claim?.card, B);
  bridge.pass();
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /card 0 is whole-box-\d+'s whole card and card 1 has whole-box-\d+ running/);
  const started = await backend.start(whole, signal());
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: A, part: "whole", generation: 1, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(Number(whole.ref)), [marker("whole", CARD_A, 1)]);
});

test("071 unit 8: a whole desktop never takes a warm guest; this install's warm desktops on the card it takes are retired first", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ warm: 1 });
  await backend.maintain(signal());
  const warm = [...bridge.proxmox.guests.values()].find((guest) => (guest.config.tags ?? "").split(";").includes("warm"));
  assert.ok(warm, "a warm desktop was made");
  assert.equal(bridge.cardOf(warm.vmid), CARD_A);
  runningElsewhere(bridge, 7061, CARD_B);
  const fitting = box("linux-desktop", "whole");
  const made = await backend.acquire({ ...fitting, size: { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "whole" } }, null, hooks(), signal());
  assert.notEqual(Number(made.ref), warm.vmid, "a whole box is cloned, never a warm guest, though this one fits it");
  assert.equal(bridge.proxmox.guests.has(warm.vmid), false, "the warm desktop on the card was retired");
  assert.deepEqual(made.claim, { card: A, part: "whole", generation: 1, answer: "granted" });
  assert.ok(backend.logs.some((line) => line === `Retired warm box CT ${warm.vmid} on card 0, so that a box can have the card whole.`), backend.logs.join("\n"));
});

test("071 unit 8: whole is refused, with words for each audience and before any copy, while the helper has writes off, and where there is no helper", async () => {
  const off = new ClaimsBridge({ writes: "off" });
  withUserspace(off);
  const backend = off.backend();
  for (const kind of ["linux", "linux-desktop"]) {
    const room = await backend.capacity(kind, { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
    assert.equal(room.message, "pve cannot give a box a whole card now: its GPU helper has writes off, so it gives no box a card. Turn writes on with host/setup-gpu.sh --writes on --check, then --writes on, as root on pve.", kind);
    assert.equal(room.agentMessage, "Not made: pve cannot give a box a whole card now: its GPU helper has writes off, so it gives no box a card. Ask for gpu shared, or ask the user. bb-box changed nothing.", kind);
  }
  const before = clones(off);
  await assert.rejects(backend.acquire(box("linux-desktop", "whole"), null, hooks(), signal()), /pve cannot give a box a whole card now: its GPU helper has writes off/);
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /pve cannot give a box a whole card now: its GPU helper has writes off/);
  assert.equal(clones(off), before);

  const bare = new ClaimsBridge();
  bare.timerReport();
  const timer = bare.backend();
  const room = await timer.capacity("linux-desktop", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
  assert.equal(room.agentMessage, "Not made: pve cannot give a box a whole card now: it has no GPU helper to give a box a card. Ask for gpu shared, or ask the user. bb-box changed nothing.");
});

test("071 unit 8: a fork with a whole card is placed and its card kept whole before anything is copied, and refused with the fork's own words when no card is free", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  runningElsewhere(bridge, 7062, CARD_B);
  const fork = box("linux-desktop", "whole", "thr_fork", "fork-fox");
  await backend.placeForkGpu(fork, "whole");
  const beside = await backend.acquire(box("linux-desktop", "shared"), null, hooks(), signal());
  assert.equal(beside.claim?.card, B, "the card kept whole for the fork takes no shared box");
  await assert.rejects(backend.acquire(box("linux-desktop", "whole"), null, hooks(), signal()), /card 0 is kept whole for fork-fox, which bb-box is making/);
  backend.clearForkGpu(fork.boxId);
  await backend.release(beside, releasing);
  bridge.pass();
  const holder = await backend.acquire(box("linux-desktop", "shared", "thr_fork", "lone-pine"), null, hooks(), signal());
  assert.equal(holder.claim?.card, A);
  bridge.pass();
  await assert.rejects(backend.placeForkGpu(box("linux-desktop", "whole", "thr_fork"), "whole"), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "no_capacity");
    assert.equal(error.message, "Not forked: No card on pve is free for a whole card now: card 0 has lone-pine running and card 1 has CT 7062 of another install running. Fork it with gpu shared or none, or ask the user. bb-box copied nothing.");
    assert.equal(error.agentMessage, "Not forked: No card on pve is free for a whole card now: card 0 has lone-pine running and card 1 has CT 7062 of another install running. Fork it with gpu shared or none, or ask the user. bb-box copied nothing.");
    return true;
  });
  await assert.rejects(backend.placeForkGpu(box("linux", "whole"), "whole"), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("071 unit 8: box_list says which cards are free for a whole card, and whose whole card each other one is", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  await backend.acquire(box("linux", "whole", "thr_job", "quiet-elm"), null, hooks(), signal());
  bridge.pass();
  const room = await backend.gpuRoom("linux");
  assert.deepEqual(room.parts, ["none", "shared", "whole"]);
  assert.deepEqual(
    room.cards?.map((card) => [card.index, card.whole, card.wholeBy, card.freeForWhole]),
    [
      [0, true, "quiet-elm", false],
      [1, false, null, true],
    ],
  );
  const linux = { desktop: false, offers: [{ name: "Proxmox LXC on pve", gpuParts: ["none", "shared", "whole"], gpuRoom: { ...room, at: 1_000 } }] } as unknown as KindView;
  assert.equal(
    gpuPartsText(linux, 1_000),
    " GPU on Proxmox LXC on pve: none, shared or whole; ask with gpu shared or gpu whole (pve: 2 cards; card 0 whole, quiet-elm's; card 1, shared, 0 boxes, 87.9 GiB free, free for a whole card, when read just now; a new box needs 1024 MiB free on its card).",
  );
  const other = { desktop: false, offers: [{ name: "Proxmox LXC on pve", gpuParts: ["none", "shared", "whole"], gpuRoom: { ...room, at: 1_000, cards: [{ ...room.cards![0]!, wholeBy: "CT 214 of another install" }] } }] } as unknown as KindView;
  assert.match(gpuPartsText(other, 1_000), /\(pve: 1 card; card 0 held whole by CT 214 of another install, when read just now;/);
});

test("071 unit 8: a claim the helper took away for a whole card is no grant, so its box is placed again before it starts", () => {
  const yielded = lines([...report, `claim 61 g4 yielded ${A} 62`, `claim 61 g4 granted shared ${A}`, `ledger 61 box test/bx answered g4 claim g4 shared ${A} yielded`].join("\n"));
  const answer = answerTo(yielded, 61, { part: "shared", card: A, generation: 4 }, true);
  assert.equal(answer.is, "refused");
  assert.match(answer.is === "refused" ? answer.why : "", /took its card's lines out while it was stopped, as another box claimed the card whole/);
  const granted = lines([...report, `claim 61 g4 granted shared ${A}`, `ledger 61 box test/bx answered g4 claim g4 shared ${A} granted`].join("\n"));
  assert.equal(answerTo(granted, 61, { part: "shared", card: A, generation: 4 }, true).is, "granted");
});

test("071 unit 8: a released whole box frees its card for the next whole box", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  runningElsewhere(bridge, 7063, CARD_B);
  const first = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  await backend.release(first, releasing);
  bridge.pass();
  const next = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  assert.equal(next.claim?.card, A);
});

test("071 unit 8: a stopped whole box whose claim the helper does not hold is placed again as a whole box, on another card where its own is taken, never turned into a shared one", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const owl = box("linux-desktop", "whole", "thr_whole", "lost-owl");
  runningElsewhere(bridge, 7064, CARD_A);
  bridge.desktop(7010, CARD_A, owl, INSTALL, { marker: marker("whole", CARD_A, 1) });
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => /^claim 7010 g1 refused card-held /.test(line)), bridge.node.reportLines().join("\n"));
  const started = await backend.start(bridge.stoppedGuest(7010, owl, 9001), signal());
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: B, part: "whole", generation: 2, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(7010), [marker("whole", CARD_B, 2)]);
  assert.deepEqual(bridge.lines(7010), cardLines(CARD_B, "desktop"));
  assert.equal(bridge.proxmox.guests.get(7010)!.status, "running");
});

test("071 unit 8: each backend's context gives the threads' titles BB has, for the person's words, and none where there is no BB", async () => {
  const titles = new Backends({ storage: new MemoryStorage(), installId: "i8", logError: () => {}, threadTitle: async (threadId) => (threadId === "thr_train" ? "Train the model" : null) });
  assert.equal(await titles.context("proxmox-lxc").threadTitle?.("thr_train"), "Train the model");
  assert.equal(await titles.context("proxmox-lxc").threadTitle?.("thr_other"), null);
  const bare = new Backends({ storage: new MemoryStorage(), installId: "i8", logError: () => {} });
  assert.equal(bare.context("proxmox-lxc").threadTitle, undefined);
});

test("071 unit 8, lead: whole cards are off unless the install turns them on: no offer, room or acquire has them, and the words say so to each audience", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ wholeCards: false });
  for (const kind of backend.kinds().filter((each) => each.id === "linux" || each.id === "linux-desktop")) assert.ok(!kind.gpuParts?.includes("whole"), kind.id);
  const room = await backend.gpuRoom("linux");
  assert.deepEqual(room.parts, ["none", "shared"]);
  assert.equal(room.wholeOff, true);
  assert.ok(room.cards?.every((card) => !card.freeForWhole));
  const linux = { desktop: false, offers: [{ name: "Proxmox LXC on pve", gpuParts: ["none", "shared"], gpuRoom: { ...room, at: 1_000 } }] } as unknown as KindView;
  assert.match(gpuPartsText(linux, 1_000), /: none or shared; ask with gpu shared \(.*\)\. Whole cards are off on this install: ask the user if a box needs a card to itself\.$/);
  const refused = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
  assert.equal(refused.message, "Whole cards are off on this install, so no box gets a card to itself. Ask for gpu shared, or turn whole cards on with bb box option set general.wholeCards=true.");
  assert.equal(refused.agentMessage, "Not made: whole cards are off on this install. Ask for gpu shared, or ask the user. bb-box changed nothing.");
  const before = clones(bridge);
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported" && error.agentMessage === refused.agentMessage);
  await assert.rejects(backend.placeForkGpu(box("linux-desktop", "whole"), "whole"), { agentMessage: "Not forked: whole cards are off on this install. Fork it with gpu shared or none, or ask the user. bb-box copied nothing." });
  assert.equal(clones(bridge), before);
  assert.equal((await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "shared" }, [])).ok, true, "shared is as before");
});

test("071 unit 8, Astra 2: a whole card never yields another install's guest or one outside this install's pool; only this install's own stopped shared boxes yield", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  const theirs = { ...box("linux-desktop", "shared", "thr_theirs"), name: "their-desktop" };
  bridge.desktop(7065, CARD_A, theirs, SECOND_INSTALL, { marker: marker("shared", CARD_A, 1), pool: SECOND_POOL });
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`holder ${A} 7065 shared stopped install ${SECOND_INSTALL} managed`)), bridge.node.reportLines().join("\n"));
  const made = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  assert.equal(made.claim?.card, B, "the card another install's stopped box holds is not taken, though it has the least memory in use");
  bridge.pass();
  assert.deepEqual(bridge.lines(7065), cardLines(CARD_A, "desktop"), "the other install's guest keeps its lines");
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /card 0 has CT 7065 of another install holding it while stopped/);
  const elsewhere = { ...box("linux-desktop", "shared", "thr_whole"), name: "other-pool" };
  bridge.desktop(7066, CARD_B, elsewhere, INSTALL, { marker: marker("shared", CARD_B, 1), pool: SECOND_POOL });
  await backend.release(made, releasing);
  bridge.pass();
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /card 1 has CT 7066 holding it while stopped/);
  bridge.pass();
  assert.deepEqual(bridge.lines(7066), cardLines(CARD_B, "desktop"), "this install's guest in another pool keeps its lines");
  assert.deepEqual(bridge.node.guestWrites().filter((write) => / (7065|7066) /.test(` ${write} `)), [], "the helper wrote neither guest");
});

test("071 unit 8, Astra 1 and Fable 3: whole is refused before any path that does not go through the helper: a template's, an image's and a resumed acquire's", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  assert.equal((await backend.capacity("linux-desktop", { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, [])).ok, true);
  bridge.timerReport();
  const before = clones(bridge);
  const refusal = /pve cannot give a box a whole card now: it has no GPU helper to give a box a card/;
  await assert.rejects(backend.acquire(box("linux-desktop", "whole"), null, hooks(), signal()), refusal);
  await assert.rejects(backend.acquire({ ...box("linux-desktop", "whole"), from: "9001" }, null, hooks(), signal()), refusal);
  await assert.rejects(backend.acquire({ ...box("linux", "whole"), from: "9000" }, null, hooks(), signal()), /pve cannot give a box a whole card now/);
  assert.equal(clones(bridge), before, "nothing was copied");
  const resumed = box("linux-desktop", "whole");
  bridge.plain(7012, resumed, INSTALL);
  await assert.rejects(backend.acquire(resumed, { ref: "7012", host: "pve", address: null, size: null, data: { template: 9000, box: resumed.boxId } }, hooks(), signal()), refusal);
  const left = bridge.proxmox.guests.get(7012);
  assert.ok(!left || (left.status === "stopped" && !bridge.gpuTags(7012).length), "the resumed guest was neither started nor marked");
  assert.ok(!bridge.node.reportLines().some((line) => /^holder \S+ 7012 /.test(line)), "nor given a card");
});

test("071 unit 8, Astra 4: a whole server whose start check finds no card is placed again as a whole box on the other card, where one is free", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend({ readyTimeoutMs: 60_000 });
  const whole = await backend.acquire(box("linux", "whole"), null, hooks(), signal());
  const vmid = Number(whole.ref);
  assert.equal(whole.claim?.card, A);
  await backend.stop(whole);
  bridge.pass();
  bridge.seenInBox.set(vmid, { onCard: A, shows: "No devices were found" });
  const started = await backend.start(whole, signal());
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: B, part: "whole", generation: 2, answer: "granted" });
  assert.deepEqual(bridge.lines(vmid), cardLines(CARD_B, "server"));
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running");
});

test("071 unit 8, Fable 5: a card the start gate keeps whole names the box it is starting", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const owl = box("linux-desktop", "whole", "thr_whole", "starting-owl");
  runningElsewhere(bridge, 7067, CARD_A);
  bridge.desktop(7011, CARD_A, owl, INSTALL, { marker: marker("whole", CARD_A, 1) });
  bridge.pass();
  let seen: string | null = null;
  bridge.proxmox.intercept = (call) => {
    if (seen === null && call.method === "PUT" && call.path.endsWith("/lxc/7011/config") && (call.params.tags ?? "").includes(`gpu.whole.${B}.g2`)) {
      const reservation = reservationsOn(`${bridge.url.replace(/\/+$/, "")}#pve`).live(parseHelperLines(""), Date.now()).find((each) => each.card === B);
      seen = reservation?.making ? `${reservation.making.name} ${reservation.making.starting ? "starting" : "making"}` : "unnamed";
    }
    return undefined;
  };
  await backend.start(bridge.stoppedGuest(7011, owl, 9001), signal());
  assert.equal(seen, "starting-owl starting");
  assert.equal(blockWords({ is: "reserved-whole", card: lines(report.join("\n")).cards[1]!, making: { name: "starting-owl", threadId: "thr_whole", starting: true } }, byVmid, PERSON), "card 1 is kept whole for starting-owl, which bb-box is starting");
});

test("071 unit 8, Astra 6, Astra 7 and Fable 4: box_list gives desktops their cards too, whose whole card each is and which are free for a whole card, by the acquire's own placement, so a card a mismatch closes is not free", async () => {
  const bridge = new ClaimsBridge();
  withUserspace(bridge);
  const backend = bridge.backend();
  await backend.acquire(box("linux-desktop", "whole", "thr_job", "quiet-elm"), null, hooks(), signal());
  bridge.pass();
  const desktop = await backend.gpuRoom("linux-desktop");
  assert.deepEqual(desktop.parts, ["shared", "whole"]);
  assert.deepEqual(desktop.cards?.map((card) => [card.index, card.whole, card.wholeBy, card.freeForWhole]), [
    [0, true, "quiet-elm", false],
    [1, false, null, true],
  ]);
  assert.equal(desktop.neededMiB, 384);
  assert.ok(desktop.readings.length > 0, "the readings stay");
  const mismatched = { ...box("linux-desktop", "shared", "thr_m"), name: "on-wrong-lines" };
  bridge.desktop(7013, CARD_B, mismatched, INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.pass();
  const guest = bridge.proxmox.guests.get(7013)!;
  for (const key of Object.keys(guest.config)) if (/^dev\d+$/.test(key)) delete guest.config[key];
  Object.assign(guest.config, Object.fromEntries(cardLines(CARD_A, "desktop").map((line, index) => [`dev${index}`, line])));
  guest.status = "running";
  bridge.proxmox.statusPass();
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith("mismatch 7013 ")), bridge.node.reportLines().join("\n"));
  const closed = await backend.gpuRoom("linux");
  assert.equal(closed.cards?.find((card) => card.index === 1)?.freeForWhole, false, "a card a mismatch closes is not free for a whole card");
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /card 1 takes no new box while a box there is on another card's lines/);
});

test("071 unit 8, lead: general.wholeCards is a boolean, off unless set, and bb box option lists it", () => {
  const read = (general: unknown) => readDraft({ schema: emptyDocument().schema, revision: 0, backends: [], kinds: {}, general }, []);
  const on = read({ wholeCards: true });
  assert.deepEqual(on.problems, []);
  assert.equal(generalConfig(on.document).wholeCards, true);
  assert.equal(generalConfig(read({}).document).wholeCards, false, "off unless set");
  assert.deepEqual(read({ wholeCards: "yes" }).problems.map((problem) => [problem.path, problem.message]), [["general.wholeCards", "wholeCards is true or false."]]);
  const option = OPTIONS.find((each) => each.name === "general.wholeCards");
  assert.deepEqual(option && { type: option.type, default: option.default }, { type: { kind: "boolean" }, default: false });
});

test("071 unit 8, round 2, Astra 1: with whole cards on, whole is refused while the node's helper is older than 0.4.3, which could take another install's stopped box's card; servers, desktops and forks alike", async () => {
  const bridge = new ClaimsBridge({ helperVersion: "0.4.2" });
  withUserspace(bridge);
  const backend = bridge.backend();
  const why = "pve cannot give a box a whole card now: its GPU helper is bb-box-gpu 0.4.2, and a whole card needs 0.4.3 or later, which takes a card only from this install's own stopped boxes.";
  for (const kind of ["linux", "linux-desktop"]) {
    const room = await backend.capacity(kind, { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "whole" }, []);
    assert.equal(room.message, `${why} Upgrade the helper with host/setup-gpu.sh from a BB Box release with bb-box-gpu 0.4.3 or later, as root on pve.`, kind);
    assert.equal(room.agentMessage, `Not made: ${why} Ask for gpu shared, or ask the user. bb-box changed nothing.`, kind);
    assert.doesNotMatch(room.agentMessage!, /setup-gpu|upgrade/i);
  }
  const before = clones(bridge);
  await assert.rejects(backend.acquire(box("linux", "whole"), null, hooks(), signal()), /its GPU helper is bb-box-gpu 0\.4\.2, and a whole card needs 0\.4\.3 or later/);
  await assert.rejects(backend.acquire(box("linux-desktop", "whole"), null, hooks(), signal()), /its GPU helper is bb-box-gpu 0\.4\.2/);
  await assert.rejects(backend.placeForkGpu(box("linux-desktop", "whole"), "whole"), /its GPU helper is bb-box-gpu 0\.4\.2/);
  assert.equal(clones(bridge), before, "nothing was copied");
  for (const kind of ["linux", "linux-desktop"]) {
    const room = await backend.gpuRoom(kind);
    assert.ok(!room.parts?.includes("whole"), kind);
    assert.ok(room.cards?.every((card) => !card.freeForWhole), kind);
    assert.equal(room.wholeOff, false, `${kind}: whole cards are not said to be off where the helper could not give one anyway`);
  }
  assert.equal((await backend.acquire(box("linux", "shared"), null, hooks(), signal())).claim?.part, "shared", "shared is as before");
  const off = bridge.backend({ wholeCards: false });
  for (const kind of ["linux", "linux-desktop"]) assert.equal((await off.gpuRoom(kind)).wholeOff, false, `${kind}: with whole cards off too, nothing is said of them where the helper could not give one`);
});

test("071 unit 8, round 2, Fable 4: box_list gives a desktop with cards one GPU line, and none that says ask with gpu shared while no card has room for a desktop", () => {
  const room = { readings: [{ id: "GPU-a", freeMiB: 300, totalMiB: 97_887, at: 1_000, neededMiB: 384, source: "host" as const }], fullUntil: null, parts: ["none", "shared"], cards: [{ index: 0, boxes: 1, whole: false, freeMiB: 300, totalMiB: 97_887 }], host: "pve", limit: 4, at: 1_000, neededMiB: 384 };
  const desktop = (gpuRoom: object) => ({ desktop: true, os: "linux", arch: "x86_64", windowing: "x11", gpu: true, offers: [{ name: "Proxmox LXC on pve", gpuParts: ["none", "shared"], gpuRoom }] }) as unknown as KindView;
  assert.equal(gpuRoomText(desktop(room), [], 1_000), "", "the cards line carries the memory");
  assert.match(gpuPartsText(desktop(room), 1_000), /^ GPU on Proxmox LXC on pve: none or shared; ask with gpu shared \(pve: 1 card; /);
  const full = { ...room, fullUntil: 1_000 + 5 * 60_000 };
  assert.match(gpuRoomText(desktop(full), [], 1_000), /^ No GPU has room for a desktop now \(GPU-a 300 MiB free/);
  assert.doesNotMatch(gpuPartsText(desktop(full), 1_000), /ask with gpu shared/);
});

test("071 unit 8, round 3, Astra 1: with helper 0.4.2, a whole server whose start check finds no card is left stopped, and no whole claim is asked on another card, where another install's box could yield", async () => {
  const bridge = new ClaimsBridge({ helperVersion: "0.4.2" });
  withUserspace(bridge);
  const backend = bridge.backend({ readyTimeoutMs: 60_000 });
  const server = box("linux", "whole", "thr_whole", "stuck-server");
  bridge.plain(7014, server, INSTALL, { tags: [marker("whole", CARD_A, 1)] });
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7014 g1 granted whole ${A}`), bridge.node.reportLines().join("\n"));
  let arrived = false;
  bridge.proxmox.intercept = (call) => {
    if (!arrived && call.method === "PUT" && call.path.endsWith("/lxc/7014/config") && (call.params.tags ?? "").includes(`gpu.whole.${B}.`)) {
      arrived = true;
      bridge.desktop(7068, CARD_B, { ...box("linux-desktop", "shared", "thr_theirs"), name: "their-desktop" }, SECOND_INSTALL, { marker: marker("shared", CARD_B, 1), pool: SECOND_POOL });
    }
    return undefined;
  };
  bridge.seenInBox.set(7014, { onCard: A, shows: "No devices were found" });
  await assert.rejects(backend.start(bridge.stoppedGuest(7014, server, 9000), signal()), (error: unknown) => {
    assert.ok(error instanceof AudienceError, String(error));
    assert.match(error.message, /needs a new whole claim, and pve cannot give a box a whole card now: its GPU helper is bb-box-gpu 0\.4\.2, and a whole card needs 0\.4\.3 or later/);
    assert.match(error.message, /It is stopped, with its disk as it was\./);
    assert.match(error.agentMessage, /its GPU helper is bb-box-gpu 0\.4\.2/);
    assert.match(error.agentMessage, /Start it again later, or ask the user\./);
    assert.doesNotMatch(error.agentMessage, /setup-gpu|Upgrade/);
    return true;
  });
  assert.equal(arrived, false, "no whole claim was asked on another card");
  assert.equal(bridge.proxmox.guests.get(7014)!.status, "stopped");
  assert.ok(!bridge.gpuTags(7014).some((tag) => tag.includes(B)), "its marker names no other card");
});
