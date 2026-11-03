import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";
import { CardReservations, cardsView, loadOf, nextGeneration, outstandingRequests, placeShared, settleOutstanding, underCardLock, waitForAnswer, type PlaceInput, type Placed } from "../src/backends/proxmox-lxc/gpu-claims.ts";
import { parseHelperLines } from "../src/backends/proxmox-lxc/gpu-marking.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, POOL, SECOND_INSTALL } from "./gpu-helper/claims-bridge.ts";
import { marker, pciOf } from "./gpu-helper/node.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { boxTags } from "../src/backends/proxmox/owner.ts";
import type { FakeCall } from "./fake-proxmox.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;

let counter = 0;
function box(kind = "linux-desktop", name?: string): BoxIdentity {
  counter++;
  return { boxId: `bx${counter}`, threadId: "thr_claims", name: name ?? `claim-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 2), size: { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: "shared" } };
}

function hooks(): AcquireHooks & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    claim: async (guest) => {
      calls.push(`claim ${guest.ref}`);
    },
    starting: async () => {
      calls.push("starting");
    },
    timing: () => {},
  };
}

const releasing: ReleaseHooks = {
  resetting: async () => {
    throw new Error("nothing to reset");
  },
  timing: () => {},
};

const signal = () => new AbortController().signal;

function placedOn(placed: Placed): string | null {
  return placed.is === "placed" ? placed.card.uuid : null;
}

function reasonsOf(placed: Placed): readonly string[] {
  return placed.is === "refused" ? placed.reasons : [];
}

function cardIn(tags: readonly string[]): string | null {
  return /^gpu\.shared\.([0-9a-f-]+)\.g\d+$/.exec(tags.find((tag) => tag.startsWith("gpu.")) ?? "")?.[1] ?? null;
}

function isStart(call: FakeCall, vmid?: number): boolean {
  const at = vmid === undefined ? "" : `/lxc/${vmid}`;
  return (call.method === "POST" && call.path.endsWith(`${at}/status/start`)) || (call.method === "PUT" && call.path.endsWith(`${at}/config`) && /(^|;)bb-power\.start\./.test(call.params.tags ?? ""));
}

function puts(bridge: ClaimsBridge, vmid: number): Record<string, string>[] {
  return bridge.proxmox.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`)).map((call) => call.params);
}

test("071 unit 5: with the helper's writes on, a GPU desktop is placed on a card, its marker goes in the same write as its labels, and it starts only once the helper grants it; the helper writes no guest, and the claim is the box's", async () => {
  const bridge = new ClaimsBridge();
  const events: string[] = [];
  const backend = bridge.backend({ onSleep: () => events.push("helper pass") });
  bridge.proxmox.intercept = (call) => {
    if (call.method === "PUT" && /gpu\.shared\./.test(call.params.tags ?? "")) events.push("marker");
    if (isStart(call)) events.push("start");
    return undefined;
  };
  const made = await backend.acquire(box(), null, hooks(), signal());
  const vmid = Number(made.ref);
  const marked = events.indexOf("marker");
  const started = events.indexOf("start");
  assert.ok(marked >= 0 && started > marked && events.slice(marked, started).includes("helper pass"), `the start waits for the helper's answer: ${events.join(", ")}`);
  const tagged = puts(bridge, vmid).filter((params) => params.tags !== undefined);
  assert.ok(tagged[0]!.tags!.includes("box.") && tagged[0]!.tags!.includes(`gpu.shared.${A}.g1`), `one write gives the guest its labels and its marker: ${tagged[0]!.tags}`);
  assert.ok(tagged.every((params) => params.tags!.includes(`gpu.shared.${A}.g1`)), "and later tag writes keep the marker");
  assert.deepEqual(bridge.gpuTags(vmid), [marker("shared", CARD_A, 1)]);
  assert.deepEqual(made.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  assert.equal(made.data?.template, 9001);
  assert.ok(bridge.node.reportLines().includes(`claim ${vmid} g1 granted shared ${A}`));
  assert.deepEqual(bridge.node.guestWrites(), [], "the template's lines were the card's: the helper wrote nothing");
});

test("071 unit 5 gate: two acquires at once with desktops per GPU 1 go to different cards, the card lock and the reservation ordering them; a third is refused before anything is copied", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const [one, two] = await Promise.all([backend.acquire(box(), null, hooks(), signal()), backend.acquire(box(), null, hooks(), signal())]);
  const cards = [cardIn(bridge.tags(Number(one.ref))), cardIn(bridge.tags(Number(two.ref)))];
  assert.deepEqual(new Set(cards), new Set([A, B]), `two cards: ${cards.join(", ")}`);
  assert.deepEqual(new Set([one.data?.template, two.data?.template]), new Set([9001, 9002]));
  const clones = bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "no_capacity");
    assert.match(error.message, /^No card on pve can take another box now: card 0 has 1 of this install's boxes, the most a card may have and card 1 has 1 of this install's boxes, the most a card may have\. Release a desktop box, or raise the desktops per GPU\.$/);
    return true;
  });
  assert.equal(bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length, clones, "refused before any copy");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5 gate: a second install with its own pool asks for a card the first install's guest took whole meanwhile, and the helper refuses it; it places once more, on the other card, and is refused with words when there is none", async () => {
  const bridge = new ClaimsBridge();
  const first = box("linux-desktop", "quiet-elm");
  bridge.desktop(7001, CARD_A, first, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  const second = bridge.backend({ install: SECOND_INSTALL });
  let raced = false;
  bridge.proxmox.intercept = (call) => {
    if (!raced && call.method === "POST" && call.path.endsWith("/lxc/9001/clone")) {
      raced = true;
      bridge.proxmox.guests.get(7001)!.config.tags = bridge.proxmox.guests.get(7001)!.config.tags!.replace(marker("shared", CARD_A, 1), marker("whole", CARD_A, 2));
      bridge.pass();
    }
    return undefined;
  };
  const made = await second.acquire(box(), null, hooks(), signal());
  assert.ok(raced, "the first install's whole claim came between the second's placement and its clone");
  assert.ok(bridge.node.reportLines().includes(`claim 7001 g2 granted whole ${A}`));
  const refused = bridge.node.reportLines().find((line) => /^claim 70[5-9]\d g1 refused whole-taken /.test(line));
  assert.ok(refused, bridge.node.reportLines().join("\n"));
  assert.equal(cardIn(bridge.tags(Number(made.ref))), B, "placed once more, on the other card");
  assert.match((second as unknown as { errors: string[] }).errors.join("\n"), /refused card 0 for box .*, as another guest holds its card whole: CT 7001, so bb-box released its guest and places it once more, on another card/);

  const unnamed = bridge.backend({ install: SECOND_INSTALL, templates: "9001 gpu-x", first: 7070 });
  await assert.rejects(unnamed.acquire(box(), null, hooks(), signal()), /^BackendError: No card on pve can take another box now: no GPU desktop template's GPU ID \(gpu-x\) names a card the GPU helper's report lists; name each by the UUID nvidia-smi -L shows\./);
  const onlyA = bridge.backend({ install: SECOND_INSTALL, templates: `9001 GPU-${A}`, first: 7080 });
  await assert.rejects(onlyA.acquire(box(), null, hooks(), signal()), /^BackendError: No card on pve can take another box now: card 0 is CT 7001's whole card\. Release a desktop box/);
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5: a refusal by the helper on both cards is said in words, and the guests made for it are gone", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  bridge.proxmox.intercept = (call) => {
    if (call.method === "POST" && call.path.endsWith("/clone")) {
      const holder = box();
      const vmid = 7040 + bridge.proxmox.calls.filter((each) => each.path.endsWith("/clone")).length;
      bridge.desktop(vmid, call.path.includes("/9001/") ? CARD_A : CARD_B, holder, INSTALL, { marker: marker("whole", call.path.includes("/9001/") ? CARD_A : CARD_B, 1) });
      bridge.pass();
    }
    return undefined;
  };
  await assert.rejects(backend.acquire(box("linux-desktop", "turned-away"), null, hooks(), signal()), /The host's GPU helper on pve refused card \d for box turned-away, as another guest holds its card whole: CT 704\d, after it had refused another card\. bb-box released the guest it had made; nothing else changed\./);
  assert.deepEqual([...bridge.proxmox.guests.keys()].filter((vmid) => vmid >= 7000 && vmid < 7040), [], "no guest of the box is left");
});

test("071 unit 5 gate: bb-box killed between a marker and its answer; on restart nothing is placed until the helper has answered it, and a box whose marker stays unanswered is not started", async () => {
  const bridge = new ClaimsBridge();
  const left = box("linux-desktop", "half-made");
  bridge.answering = false;
  bridge.desktop(7003, CARD_A, left, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7004, CARD_B, box(), INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.pass();
  bridge.proxmox.guests.get(7004)!.config.tags = bridge.proxmox.guests.get(7004)!.config.tags!.replace(".g1", ".g2");
  const order: string[] = [];
  let sleeps = 0;
  const restarted = bridge.backend({
    onSleep: () => {
      sleeps++;
      if (sleeps === 3) {
        bridge.answering = true;
        order.push("helper answers");
      }
    },
  });
  bridge.proxmox.intercept = (call) => {
    if (call.method === "POST" && call.path.endsWith("/clone")) order.push("clone");
    return undefined;
  };
  bridge.push();
  await restarted.acquire(box(), null, hooks(), signal());
  assert.deepEqual(order, ["helper answers", "clone"], "the placement waited for the helper's answer to the marker left behind");
  assert.ok(bridge.node.reportLines().includes(`claim 7004 g2 granted shared ${B}`));

  const stuck = new ClaimsBridge();
  stuck.desktop(7005, CARD_A, box(), INSTALL, { marker: marker("shared", CARD_A, 1) });
  stuck.pass();
  stuck.answering = false;
  stuck.proxmox.guests.get(7005)!.config.tags = stuck.proxmox.guests.get(7005)!.config.tags!.replace(".g1", ".g2");
  const later = stuck.backend();
  const guest: Guest = { ref: "7005", host: "pve", address: null, size: null, data: { template: 9001, box: stuck.proxmox.guests.get(7005)!.config.tags!.match(/box\.(\S+?)(;|$)/)![1]! } };
  await assert.rejects(later.start(guest, signal()), /Container 7005 was not started: The host's GPU helper on pve did not answer within 10 s\. Run bb box doctor\. It is stopped, with its disk as it was\./);
  assert.equal(stuck.proxmox.guests.get(7005)!.status, "stopped");
  assert.match((later as unknown as { errors: string[] }).errors.join("\n"), /The GPU helper on pve had not answered CT 7005's gpu\.shared\.[0-9a-f-]+\.g2 a minute after bb-box started\. bb-box places nothing on their cards and does not start them until it answers/);
});

test("071 unit 5 gate: with writes on, a stopped shared desktop whose card is full is moved: the helper writes the other card's lines while it is stopped, and it starts on them; a running guest's lines are never written", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const stopped = box("linux-desktop", "swift-owl");
  bridge.desktop(7010, CARD_A, stopped, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7011, CARD_A, box("linux-desktop", "lone-pine"), INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
  bridge.pass();
  const before = bridge.configs();
  assert.equal(bridge.cardOf(7010), CARD_A);
  const started = await backend.start({ ref: "7010", host: "pve", address: null, size: null, data: { template: 9001, box: stopped.boxId } }, signal());
  assert.equal(bridge.proxmox.guests.get(7010)!.status, "running");
  assert.equal(bridge.cardOf(7010), CARD_B, "it starts on card 1's lines");
  assert.deepEqual(bridge.gpuTags(7010), [marker("shared", CARD_B, 2)]);
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: B, part: "shared", generation: 2, answer: "granted" });
  assert.deepEqual(started?.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: `GPU-${B}` }, "Opus 6: its GPU fact names the card it holds now, not its template's");
  assert.deepEqual(bridge.node.guestWrites(), ["lxc 7010"], "the helper wrote the stopped guest once");
  for (const [vmid, text] of before) if (vmid !== 7010) assert.equal(bridge.node.text(vmid), text, `CT ${vmid} is as it was`);

  bridge.proxmox.guests.get(7011)!.config.tags = bridge.proxmox.guests.get(7011)!.config.tags!.replace(`gpu.shared.${A}.g1`, `gpu.shared.${B}.g2`);
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7011 g2 refused running ${B}`));
  assert.equal(bridge.cardOf(7011), CARD_A, "the running guest keeps card 0's lines");
  assert.deepEqual(bridge.node.guestWrites(), ["lxc 7010"], "and is never written");
});

test("071 unit 5: a stopped shared desktop starts on its own card while it has room, a stopped one gives up its place, and none starts when no card has room", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const owl = box("linux-desktop", "swift-owl");
  const reef = box("linux-desktop", "calm-reef");
  bridge.desktop(7020, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7021, CARD_A, reef, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  await backend.start({ ref: "7020", host: "pve", address: null, size: null, data: { template: 9001, box: owl.boxId } }, signal());
  assert.equal(bridge.cardOf(7020), CARD_A, "its own card had room: the stopped calm-reef holds no place");
  assert.deepEqual(bridge.node.guestWrites(), []);
  const pine = box("linux-desktop", "lone-pine");
  bridge.desktop(7022, CARD_B, pine, INSTALL, { marker: marker("shared", CARD_B, 1), running: true });
  bridge.pass();
  await assert.rejects(backend.start({ ref: "7021", host: "pve", address: null, size: null, data: { template: 9001, box: reef.boxId } }, signal()), /Container 7021 was not started: No card on pve can take another box now: card 0 has 1 of this install's boxes, the most a card may have and card 1 has 1 of this install's boxes, the most a card may have\. Release another desktop box, or start it again later\. It is stopped, with its disk as it was\./);
  assert.equal(bridge.proxmox.guests.get(7021)!.status, "stopped");
  assert.deepEqual(bridge.gpuTags(7021), [marker("shared", CARD_A, 1)], "nothing about it changed");
});

test("071 unit 5: with the helper's writes off, today's GPU desktops behave as before: an acquire is marked and granted with no write, and a stopped desktop starts on its own card even where it is full", async () => {
  const bridge = new ClaimsBridge({ writes: "off" });
  const backend = bridge.backend({ perGpu: 1 });
  const made = await backend.acquire(box(), null, hooks(), signal());
  assert.deepEqual(made.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7030, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  await backend.start({ ref: "7030", host: "pve", address: null, size: null, data: { template: 9001, box: owl.boxId } }, signal());
  assert.equal(bridge.proxmox.guests.get(7030)!.status, "running");
  assert.equal(bridge.cardOf(7030), CARD_A);
  assert.deepEqual(bridge.gpuTags(7030), [marker("shared", CARD_A, 1)]);
  assert.deepEqual(bridge.node.guestWrites(), []);
  assert.deepEqual(parseHelperLines(bridge.node.report()).would, []);
});

test("071 unit 5: without the helper, a GPU desktop is made as before, with no marker; with a helper bb-box cannot use, it is refused with words, and a box whose claim stands starts only once the helper reports again, through it", async () => {
  const bridge = new ClaimsBridge();
  bridge.proxmox.guests.get(9190)!.config.description = "bb-box: each GPU's memory, from the host. Do not edit.\n\n    at 2000000000\n";
  const without = bridge.backend();
  const plain = await without.acquire(box(), null, hooks(), signal());
  assert.deepEqual(bridge.gpuTags(Number(plain.ref)), []);
  assert.equal(plain.claim, undefined);

  const stale = new ClaimsBridge();
  const owl = box("linux-desktop", "swift-owl");
  stale.desktop(7006, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  stale.pass();
  stale.answering = false;
  const report = stale.proxmox.guests.get(9190)!.config;
  report.description = report.description!.replace(/^(\s*at )\d+$/m, `$1${Math.floor(Date.now() / 1000) - 600}`);
  const backend = stale.backend();
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /^BackendError: bb-box cannot claim a card for a GPU desktop now\. The GPU helper on pve last reported 10 minutes ago, in VM 9190\. Run systemctl status bb-box-gpu as root on pve, and check the host's clock\.$/);
  const owlGuest = { ref: "7006", host: "pve", address: null, size: null, data: { template: 9001, box: owl.boxId } };
  await assert.rejects(backend.start(owlGuest, signal()), /The GPU helper on pve last reported 10 minutes ago, in VM 9190, and bb-box starts, stops and deletes a guest with a GPU's device lines only through it\./);
  assert.equal(stale.proxmox.guests.get(7006)!.status, "stopped", "with the helper silent, bb-box does not start it through Proxmox's API");
  assert.ok(!stale.proxmox.calls.some((call) => call.method === "POST" && call.path.endsWith("/lxc/7006/status/start")));
  stale.answering = true;
  stale.pass();
  await backend.start(owlGuest, signal());
  assert.equal(stale.proxmox.guests.get(7006)!.status, "running", "its claim stands, so once the helper reports it starts, through the helper");
  assert.deepEqual(stale.node.powerLog(), ["start 7006"]);
});

test("071 unit 5: a warm desktop is marked as it is made and holds its card as a shared box; a box that takes it keeps the claim; capacity counts claims, not stopped shared boxes", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ warm: 1, perGpu: 1 });
  await backend.maintain(signal());
  const warm = [...bridge.proxmox.guests.values()].find((guest) => (guest.config.tags ?? "").includes("warm"))!;
  assert.ok(warm, "a warm desktop was made");
  assert.deepEqual(bridge.gpuTags(warm.vmid), [marker("shared", CARD_A, 1)]);
  assert.ok(bridge.node.reportLines().includes(`claim ${warm.vmid} g1 granted shared ${A}`));
  const taken = await backend.acquire(box(), null, hooks(), signal());
  assert.equal(Number(taken.ref), warm.vmid);
  assert.deepEqual(bridge.gpuTags(warm.vmid), [marker("shared", CARD_A, 1)], "the box keeps the warm guest's marker");
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line === `ledger ${warm.vmid} box ${INSTALL}/${String(taken.data?.box)} answered g1 claim g1 shared ${A} granted`), bridge.node.reportLines().join("\n"));
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5: capacity counts claims: a stopped shared box holds no place, a running one does, and a released box frees its card", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const taken = await backend.acquire(box(), null, hooks(), signal());
  bridge.desktop(7012, CARD_B, box(), INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.pass();
  const room = await backend.capacity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }, [], signal());
  assert.equal(room.ok, true, "a stopped shared box on card 1 holds no place");
  assert.deepEqual(room.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops"), { resource: "gpu-desktops", used: 1, total: 2, reserve: 0, unit: "count" });
  bridge.desktop(7013, CARD_B, box(), INSTALL, { marker: marker("shared", CARD_B, 1), running: true });
  bridge.pass();
  const full = await backend.capacity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }, [], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /card 0 has 1 of this install's boxes, the most a card may have and card 1 has 1 of this install's boxes, the most a card may have/);
  await backend.release(taken, releasing);
  bridge.pass();
  assert.equal((await backend.capacity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }, [], signal())).ok, true, "a released box frees its card");
});

test("071 unit 5: the claim rules on their own: holders, reservations, the lock, generations, answers and recovery", async () => {
  const report = [
    `    gpu GPU-${A} 00000000:21:00.0 0 9000 97887`,
    `    gpu GPU-${B} 00000000:D1:00.0 1 300 97887`,
    "    helper bb-box-gpu 0.3.0 protocol 1 writes on pve-container 6.1.14 tested",
    `    card ${A} pci 0000:21:00.0 minor 1 drm card2 renderD129`,
    `    card ${B} pci 0000:d1:00.0 minor 0 drm card1 renderD128`,
    "    ledger entries 2",
    `    ledger 1 box ${INSTALL}/b1 answered g3 claim g3 shared ${A} granted`,
    `    ledger 2 box ${INSTALL}/b2 answered g1 claim g1 shared ${B} granted`,
    `    holder ${A} 1 shared running install ${INSTALL} managed`,
    `    holder ${B} 2 shared stopped install ${INSTALL} managed`,
    `    holder ${B} 3 shared stopped other unmanaged`,
  ].join("\n");
  const lines = parseHelperLines(report);
  const reservations = new CardReservations();
  const input = (more: Partial<PlaceInput> = {}): PlaceInput => ({ lines, memory: new Map([[A, { freeMiB: 9000, totalMiB: 97887 }], [B, { freeMiB: 300, totalMiB: 97887 }]]), installId: INSTALL, reserved: reservations.live(lines, 0), limit: null, needMiB: 384, candidates: new Set([A, B]), prefer: null, vmid: null, outstanding: [], ...more });
  const a = lines.cards[0]!;
  assert.deepEqual([loadOf(a, input()).boxes, loadOf(lines.cards[1]!, input()).boxes], [1, 1], "a stopped shared managed box holds no place; an unmanaged stopped one does");
  assert.equal(placedOn(placeShared(input())), A, "card 1 has too little memory free");
  assert.equal(placedOn(placeShared(input({ needMiB: 0 }))), A, "equal boxes: then the most memory free");
  const lost = parseHelperLines(`${report}\n    unsettled 3 ${A} g2\n    unsettled 4 ${A} g1`);
  assert.equal(placedOn(placeShared(input({ lines: lost, needMiB: 0 }))), B, "a card guests the lost ledger left unresolved may hold takes no new box");
  assert.deepEqual(reasonsOf(placeShared(input({ lines: lost, candidates: new Set([A]) }))), ["card 0 waits for CT 3 and CT 4 to ask again, as the GPU helper's ledger was lost and each may hold the card"]);
  assert.deepEqual(reasonsOf(placeShared(input({ lines: lost, candidates: new Set([A]), vmid: 3 }))), ["card 0 waits for CT 4 to ask again, as the GPU helper's ledger was lost and it may hold the card"], "one of them asking again is not held back by itself");
  const held = reservations.add(A, "shared", 384, "bx", null);
  assert.equal(placeShared(input({ reserved: reservations.live(lines, 0), limit: 2 })).is, "placed");
  assert.deepEqual(reasonsOf(placeShared(input({ reserved: reservations.live(lines, 0), limit: 1, candidates: new Set([A]) }))), ["card 0 has 2 of this install's boxes, the most a card may have"]);
  held.vmid = 1;
  assert.equal(loadOf(a, input({ reserved: reservations.live(lines, 0) })).boxes, 1, "a reservation for a guest the report already counts is counted once");
  reservations.settle(held, 0);
  assert.equal(reservations.live(lines, 1).length, 0, "settled, it ends once the report shows the guest running on the card");
  const other = reservations.add(B, "shared", 384, null, 9);
  reservations.settle(other, 0);
  assert.equal(reservations.live(lines, 60_000).length, 1);
  assert.equal(reservations.live(lines, 120_000).length, 0, "or after two minutes");
  assert.equal(nextGeneration(lines, 1, 0, 0), 4);
  assert.equal(nextGeneration(lines, 1, 5, 0), 6);
  assert.equal(nextGeneration(lines, 7, 0, 2), 3);
  assert.equal(nextGeneration(parseHelperLines(`    claim 7 g5 refused copy ${A}`), 7, 0, 0), 6, "Opus 8: a reused VMID asks above the answers the report still lists for it");
  const would = parseHelperLines(`${report}\n    would 2 lines ${B} desktop for request g2`);
  assert.deepEqual(outstandingRequests(would, [{ vmid: 2, tags: [marker("shared", CARD_B, 2)] }], new Set()), [], "a request the helper would make with writes on, but cannot with writes off, closes no card");
  assert.deepEqual(outstandingRequests(lines, [{ vmid: 1, tags: [marker("shared", CARD_A, 4)] }, { vmid: 2, tags: [marker("shared", CARD_B, 1)] }, { vmid: 5, tags: [marker("shared", CARD_A, 1)] }], new Set([5])).map((each) => each.vmid), [1]);
  assert.match(
    reasonsOf(placeShared(input({ outstanding: [{ vmid: 1, marker: { card: A, generation: 4 } }], candidates: new Set([A]) })))[0]!,
    /the GPU helper has not answered CT 1's request g4 on card 0/,
  );
  const whole = parseHelperLines(`${report}\n    holder ${A} 4 whole stopped install zz99 managed`);
  assert.deepEqual(reasonsOf(placeShared({ ...input(), lines: whole, candidates: new Set([A]) })), ["card 0 is CT 4's whole card"]);

  const order: string[] = [];
  await Promise.all([1, 2, 3].map((each) => underCardLock("node-x", async () => {
    order.push(`in ${each}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
    order.push(`out ${each}`);
  })));
  assert.deepEqual(order, ["in 1", "out 1", "in 2", "out 2", "in 3", "out 3"], "one at a time");

  let reads = 0;
  const answering = { read: async () => (++reads >= 3 ? parseHelperLines(`    claim 1 g4 granted shared ${A}`) : lines), sleep: async () => {} };
  assert.deepEqual(await waitForAnswer(answering, 1, { part: "shared", card: A, generation: 4 }), { is: "granted" });
  assert.deepEqual(await waitForAnswer({ read: async () => lines, sleep: async () => {} }, 1, { part: "shared", card: A, generation: 9 }), { is: "unanswered" });
  assert.deepEqual(await settleOutstanding({ read: async () => lines, sleep: async () => {} }, async () => [{ vmid: 2, tags: [marker("shared", CARD_B, 2)] }]), [{ vmid: 2, marker: marker("shared", CARD_B, 2) }]);
  assert.deepEqual(await settleOutstanding({ read: async () => parseHelperLines("    at 1"), sleep: async () => {} }, async () => [{ vmid: 2, tags: [marker("shared", CARD_B, 2)] }]), [], "with no ledger lines there is no helper to wait for");
  const seen = { node: "pve", pool: "bbbox", vmid: 9190, now: 1_000_000_000_000, ago: () => "just now" };
  assert.equal(cardsView(null, seen).is, "none");
  assert.equal(cardsView("    at 1000000000\n    gpu GPU-x 0:1:0.0 0 1 2", seen).is, "none", "a report with no helper line: as before 071");
  assert.equal(cardsView(`    at 1000000000\n${report}\n    serves bbbox`, seen).is, "on");
  assert.equal(cardsView(`    at 1000000000\n${report}\n    serves other`, seen).is, "blocked");
});

test("071 unit 5: an acquire resumed after a restart does not start the guest it had made before the helper answers its marker; refused, the guest is released with words", async () => {
  const bridge = new ClaimsBridge();
  const resumed = box("linux-desktop", "gentle-delta");
  bridge.answering = false;
  bridge.desktop(7007, CARD_A, resumed, INSTALL, { marker: marker("shared", CARD_A, 1) });
  const events: string[] = [];
  let sleeps = 0;
  const backend = bridge.backend({
    onSleep: () => {
      if (++sleeps === 3) {
        bridge.answering = true;
        events.push("helper answers");
      }
    },
  });
  bridge.proxmox.intercept = (call) => {
    if (isStart(call, 7007)) events.push("start");
    return undefined;
  };
  const previous: Guest = { ref: "7007", host: "pve", address: null, size: null, data: { template: 9001, box: resumed.boxId } };
  const made = await backend.acquire(resumed, previous, hooks(), signal());
  assert.deepEqual(events, ["helper answers", "start"]);
  assert.deepEqual(made.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(7007), [marker("shared", CARD_A, 1)], "its labels were written again, with its marker kept");

  const refused = box("linux-desktop", "turned-back");
  bridge.desktop(7008, CARD_B, box(), INSTALL, { marker: marker("whole", CARD_B, 1) });
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7008 g1 granted whole ${B}`));
  bridge.desktop(7009, CARD_B, refused, INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.proxmox.intercept = undefined;
  const onlyB = bridge.backend({ templates: `9002 GPU-${B}` });
  await assert.rejects(
    onlyB.acquire(refused, { ref: "7009", host: "pve", address: null, size: null, data: { template: 9002, box: refused.boxId } }, hooks(), signal()),
    /^Error: bb-box did not start the guest it had made for box turned-back, and releases it: No card on pve can take another box now: card 1 is CT 7008's whole card\. Release another desktop box, or start it again later\.$/,
  );
  assert.equal(bridge.proxmox.guests.has(7009), false, "the guest it had made is released");
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim 7009 g1 refused whole-taken ${B}`)), "the helper had refused its marker");

  const placedAgain = box("linux-desktop", "placed-again");
  bridge.desktop(7010, CARD_B, placedAgain, INSTALL, { marker: marker("shared", CARD_B, 1) });
  const moved = await backend.acquire(placedAgain, { ref: "7010", host: "pve", address: null, size: null, data: { template: 9002, box: placedAgain.boxId } }, hooks(), signal());
  assert.deepEqual(moved.claim, { card: A, part: "shared", generation: 2, answer: "granted" }, "with card 0 open, the refused guest is placed there instead, the helper writing its lines while it is stopped");
  assert.equal(bridge.cardOf(7010), CARD_A);
});

test("071 unit 5, Astra 2 and Opus 4: with a report that has no helper line, as while setup-gpu.sh restarts the helper, a marked box is not started and no unmarked GPU desktop is made", async () => {
  const bridge = new ClaimsBridge();
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7040, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7040 g1 granted shared ${A}`));
  bridge.answering = false;
  bridge.timerReport();
  const backend = bridge.backend();
  await assert.rejects(
    backend.start(bridge.stoppedGuest(7040, owl, 9001), signal()),
    /^Error: Container 7040 was not started: bb-box cannot see a grant of its GPU marker gpu\.shared\.[0-9a-f-]+\.g1\. The GPU helper on pve is not reporting: VM 9190's report has no helper line, as while host\/setup-gpu\.sh restarts the helper or once it is removed, and 1 guest of this install carries a GPU marker\./,
  );
  assert.equal(bridge.proxmox.guests.get(7040)!.status, "stopped");
  const clones = bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /^BackendError: bb-box cannot claim a card for a GPU desktop now\. The GPU helper on pve is not reporting/);
  assert.equal(bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length, clones, "no unmarked desktop is made");
  bridge.answering = true;
  bridge.pass();
  await backend.start(bridge.stoppedGuest(7040, owl, 9001), signal());
  assert.equal(bridge.proxmox.guests.get(7040)!.status, "running", "once the helper reports again, it starts");
});

test("071 unit 5, Astra 2: with writes off, a box whose marker the helper refused is not started on it; a claim the helper still holds for it is asked again first", async () => {
  const bridge = new ClaimsBridge({ writes: "off" });
  bridge.desktop(7041, CARD_A, box(), INSTALL, { marker: marker("whole", CARD_A, 1) });
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7041 g1 granted whole ${A}`));
  const late = box("linux-desktop", "late-comer");
  bridge.desktop(7042, CARD_A, late, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim 7042 g1 refused whole-taken ${A}`)));
  const backend = bridge.backend();
  await assert.rejects(backend.start(bridge.stoppedGuest(7042, late, 9001), signal()), /^Error: Container 7042 was not started: the host's GPU helper refused its marker gpu\.shared\.[0-9a-f-]+\.g1, as another guest holds its card whole: CT 7041\. It is stopped, with its disk as it was\.$/);
  assert.equal(bridge.proxmox.guests.get(7042)!.status, "stopped", "it does not start on another box's whole card");

  const moved = box("linux-desktop", "half-moved");
  bridge.desktop(7043, CARD_B, moved, INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.pass();
  bridge.proxmox.guests.get(7043)!.config.tags = bridge.proxmox.guests.get(7043)!.config.tags!.replace(marker("shared", CARD_B, 1), marker("shared", CARD_A, 2));
  bridge.pass();
  assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim 7043 g2 refused whole-taken ${A}`)));
  const started = await backend.start(bridge.stoppedGuest(7043, moved, 9002), signal());
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: B, part: "shared", generation: 3, answer: "granted" });
  assert.deepEqual(bridge.gpuTags(7043), [marker("shared", CARD_B, 3)], "its claim on card 1 was asked again, and granted, before the start");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5, Opus 5: a move left unanswered when writes went off does not hold the box: its standing claim is asked again, with no write, and it starts on its card", async () => {
  const bridge = new ClaimsBridge({ writes: "off" });
  const stuck = box("linux-desktop", "stuck-owl");
  bridge.desktop(7044, CARD_A, stuck, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  bridge.proxmox.guests.get(7044)!.config.tags = bridge.proxmox.guests.get(7044)!.config.tags!.replace(marker("shared", CARD_A, 1), marker("shared", CARD_B, 2));
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`would 7044 lines ${B} desktop for request g2`));
  const started = await bridge.backend().start(bridge.stoppedGuest(7044, stuck, 9001), signal());
  assert.equal(bridge.proxmox.guests.get(7044)!.status, "running");
  assert.deepEqual(started && "claim" in started ? started.claim : null, { card: A, part: "shared", generation: 3, answer: "granted" });
  assert.equal(bridge.cardOf(7044), CARD_A);
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5, Opus 1: the start gate places a box only on a card a desktop template names, as an acquire does", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1, templates: `9001 GPU-${A}` });
  bridge.desktop(7045, CARD_A, box(), INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7046, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  await assert.rejects(backend.start(bridge.stoppedGuest(7046, owl, 9001), signal()), /^Error: Container 7046 was not started: No card on pve can take another box now: card 0 has 1 of this install's boxes, the most a card may have\. Release another desktop box, or start it again later\./);
  assert.equal(bridge.cardOf(7046), CARD_A, "it is not moved to card 1, which no desktop template names");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5, Opus 3: a helper on a pve-container its release was not tested on runs as with writes off: desktops are made and marked, and none is moved", async () => {
  const bridge = new ClaimsBridge({ pveContainer: "6.1.15" });
  assert.match(bridge.node.reportLines().find((line) => line.startsWith("helper "))!, / writes off pve-container 6\.1\.15 untested$/);
  const backend = bridge.backend({ perGpu: 1 });
  const made = await backend.acquire(box(), null, hooks(), signal());
  assert.deepEqual(made.claim, { card: A, part: "shared", generation: 1, answer: "granted" });
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7047, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  await backend.start(bridge.stoppedGuest(7047, owl, 9001), signal());
  assert.equal(bridge.cardOf(7047), CARD_A, "card 0 is full, but with writes off it starts on its own card, as before");
  assert.deepEqual(bridge.node.guestWrites(), []);
  const doctor = (await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-helper");
  assert.equal(doctor?.status, "warn");
});

test("071 unit 5, Astra 5: stopping a box bb-box has just made gives up its card's reservation at once, so a stopped shared box holds no place", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1, templates: `9001 GPU-${A}` });
  const first = await backend.acquire(box(), null, hooks(), signal());
  await backend.stop(first, signal());
  bridge.pass();
  const second = await backend.acquire(box(), null, hooks(), signal());
  assert.equal(cardIn(bridge.tags(Number(second.ref))), A, "the stopped box's card took the next box");
});

test("071 unit 5: a guest bb-box has just deleted holds no place, though the helper's report, written each second, still lists it", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1, templates: `9001 GPU-${A}` });
  const first = await backend.acquire(box(), null, hooks(), signal());
  bridge.pass();
  const report = bridge.proxmox.guests.get(9190)!.config;
  const before = report.description!;
  await backend.release(first, releasing);
  report.description = before;
  assert.match(report.description, new RegExp(`holder ${A} ${first.ref} shared running`), "the report still lists the released guest, as in the second before the helper's next pass");
  const second = await backend.acquire(box(), null, hooks(), signal());
  assert.equal(cardIn(bridge.tags(Number(second.ref))), A, "its card took the next box at once");
});

test("071 unit 5, re-review R2: with the GPU desktop templates cleared or the desktop kind off, a marked box still goes through the start gate: unanswered, or refused as another guest holds its card whole, it is not started, and it is moved only to a card a template that is on names", async () => {
  for (const off of [{ templates: "" }, { kindsOff: ["linux-desktop"] }]) {
    const label = "templates" in off ? "templates cleared" : "desktop kind off";
    const quiet = new ClaimsBridge();
    const owl = box("linux-desktop", "swift-owl");
    quiet.desktop(7040, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
    quiet.pass();
    quiet.answering = false;
    quiet.timerReport();
    await assert.rejects(quiet.backend(off).start(quiet.stoppedGuest(7040, owl, 9001), signal()), /^Error: Container 7040 was not started: bb-box cannot see a grant of its GPU marker gpu\.shared\.[0-9a-f-]+\.g1\. The GPU helper on pve is not reporting/, label);
    assert.equal(quiet.proxmox.guests.get(7040)!.status, "stopped", label);

    const bridge = new ClaimsBridge();
    bridge.desktop(7041, CARD_A, box(), INSTALL, { marker: marker("whole", CARD_A, 1), running: true });
    bridge.pass();
    assert.ok(bridge.node.reportLines().includes(`claim 7041 g1 granted whole ${A}`));
    const late = box("linux-desktop", "late-comer");
    bridge.desktop(7042, CARD_A, late, INSTALL, { marker: marker("shared", CARD_A, 1) });
    bridge.pass();
    assert.ok(bridge.node.reportLines().some((line) => line.startsWith(`claim 7042 g1 refused whole-taken ${A}`)), label);
    const before = bridge.configs();
    await assert.rejects(bridge.backend(off).start(bridge.stoppedGuest(7042, late, 9001), signal()), /^Error: Container 7042 was not started: /, label);
    assert.equal(bridge.proxmox.guests.get(7042)!.status, "stopped", `${label}: it does not start on another box's whole card`);
    assert.equal(bridge.cardOf(7042), CARD_A, `${label}: nor is it moved to card 1, which no template that is on names`);
    assert.deepEqual(bridge.gpuTags(7042), [marker("shared", CARD_A, 1)], label);
    for (const [vmid, text] of before) assert.equal(bridge.node.text(vmid), text, `${label}: CT ${vmid} is as it was`);
    assert.deepEqual(bridge.node.guestWrites(), [], label);
  }
});

test("071 unit 5, re-review R4 and go review 3 H1: a moved box's GPU is the card it holds, not its template's, when it is started again; on a stale report it is not started", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7010, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7011, CARD_A, box("linux-desktop", "lone-pine"), INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
  bridge.pass();
  const guest = bridge.stoppedGuest(7010, owl, 9001);
  const moved = await backend.start(guest, signal());
  assert.equal(bridge.cardOf(7010), CARD_B);
  assert.deepEqual(moved?.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: `GPU-${B}` });
  await backend.stop(guest, signal());
  bridge.pass();
  bridge.answering = false;
  const report = bridge.proxmox.guests.get(9190)!.config;
  report.description = report.description!.replace(/^(\s*at )\d+$/m, (_, prefix: string) => `${prefix}${Math.floor(Date.now() / 1000) - 3600}`);
  await assert.rejects(backend.start(guest, signal()), /The GPU helper on pve last reported 1 hour ago, in VM 9190, and bb-box starts, stops and deletes a guest with a GPU's device lines only through it\./);
  assert.equal(bridge.proxmox.guests.get(7010)!.status, "stopped");
  bridge.answering = true;
  bridge.pass();
  const again = await backend.start(guest, signal());
  assert.equal(bridge.proxmox.guests.get(7010)!.status, "running");
  assert.deepEqual(again && "claim" in again ? again.claim : null, { card: B, part: "shared", generation: 2, answer: "granted" });
  assert.deepEqual(again?.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: `GPU-${B}` }, "started on a stale report, its GPU fact still names the card it holds");
});

test("071 unit 5, lost ledger: bb-box places no new desktop on a card a guest the rebuild left unresolved may hold, and the doctor names that guest until it has asked again", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const owl = box("linux-desktop", "swift-owl");
  bridge.desktop(7005, CARD_A, owl, INSTALL, { marker: marker("shared", CARD_B, 1) });
  bridge.desktop(7006, CARD_B, box("linux-desktop", "lone-pine"), INSTALL, { marker: marker("shared", CARD_B, 1), running: true });
  rmSync(bridge.node.ledgerPath());
  bridge.pass();
  const made = await backend.acquire(box(), null, hooks(), signal());
  assert.equal(cardIn(bridge.tags(Number(made.ref))), B, "each card has one box, and card 0 the most memory free, but CT 7005 may hold it");
  assert.ok(bridge.node.reportLines().includes(`unsettled 7005 ${A} g1`), bridge.node.reportLines().join("\n"));
  const doctor = (await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-migration");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor?.detail ?? "", /This guest of this install may hold a card and has not asked again since the GPU helper's ledger was lost: CT 7005\b[^.]*\. Until each has, card 0 takes no new box and no whole claim\./);
  assert.match(doctor?.fix ?? "", /Run bb box gpu mark, which asks again for each of this install's guests/);
  bridge.proxmox.guests.get(7005)!.config.tags = bridge.proxmox.guests.get(7005)!.config.tags!.replace(marker("shared", CARD_B, 1), marker("shared", CARD_A, 2));
  bridge.pass();
  assert.ok(bridge.node.reportLines().includes(`claim 7005 g2 granted shared ${A}`), bridge.node.reportLines().join("\n"));
  assert.ok(!bridge.node.reportLines().some((line) => line.startsWith("unsettled ")));
  const next = await backend.acquire(box(), null, hooks(), signal());
  assert.equal(cardIn(bridge.tags(Number(next.ref))), A, "asked again and answered, CT 7005 opens card 0");
});

test("071 unit 5, final review F1: a start whose marker write is retried after the guest changed meanwhile checks the guest is still this install's box first; another install's guest that took the VMID is neither marked nor started", async () => {
  const bridge = new ClaimsBridge();
  const original = box("linux-desktop", "swift-owl");
  bridge.desktop(7001, CARD_A, original, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7002, CARD_A, box("linux-desktop", "lone-pine"), INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
  bridge.pass();
  const backend = bridge.backend({ perGpu: 1 });
  let replaced = false;
  bridge.proxmox.intercept = (call) => {
    if (!replaced && call.method === "PUT" && call.path.endsWith("/lxc/7001/config") && call.params.tags?.includes("gpu.")) {
      replaced = true;
      bridge.desktop(7001, CARD_A, box("linux-desktop", "other-owl"), SECOND_INSTALL, { pool: POOL });
    }
    return undefined;
  };
  await assert.rejects(backend.start(bridge.stoppedGuest(7001, original, 9001), signal()), /^Error: CT 7001 is no longer box bx\d+ of this install: its config names box bx\d+ of install 9zz2\. bb-box changes nothing on it and does not start it\.$/);
  assert.ok(replaced, "the guest was replaced as bb-box wrote its marker");
  assert.equal(bridge.proxmox.guests.get(7001)!.status, "stopped");
  assert.deepEqual(bridge.gpuTags(7001), [], "the other install's guest has no marker of bb-box's");
  bridge.pass();
  assert.deepEqual(bridge.node.guestWrites(), [], "and the helper wrote nothing to it");
  assert.equal(bridge.cardOf(7001), CARD_A);
});

test("071 unit 5, final review F2: a ledger lost while nvidia-smi fails is rebuilt once the reading is back, so bb-box places no box on the running whole box's card", async () => {
  const bridge = new ClaimsBridge();
  bridge.desktop(7001, CARD_A, box("linux-desktop", "whole-owl"), INSTALL, { marker: marker("whole", CARD_A, 1), running: true });
  bridge.pass();
  rmSync(bridge.node.ledgerPath());
  bridge.node.smiFails(true);
  bridge.pass();
  const backend = bridge.backend({ templates: `9001 GPU-${A}` });
  bridge.answering = false;
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /^BackendError: bb-box cannot claim a card for a GPU desktop now\./);
  bridge.answering = true;
  bridge.node.smiFails(false);
  bridge.pass();
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /card 0 is CT 7001's whole card/);
  assert.ok(bridge.node.reportLines().includes(`claim 7001 g1 granted whole ${A}`), bridge.node.reportLines().join("\n"));
  assert.equal(bridge.proxmox.guests.get(7001)!.status, "running");
  assert.deepEqual(bridge.node.guestWrites(), []);
  rmSync(bridge.node.ledgerPath());
  bridge.node.smiFails(true);
  bridge.pass();
  bridge.answering = false;
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /The GPU helper on pve reports its ledger as unknown, as while it waits to rebuild a lost ledger from a full reading of every card, so bb-box cannot see its claims\./);
});

test("071 unit 5, final review: a moved box started again while it runs keeps the GPU fact of the card it holds", async () => {
  const bridge = new ClaimsBridge();
  const mover = box("linux-desktop", "swift-owl");
  bridge.desktop(7001, CARD_A, mover, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7002, CARD_A, box("linux-desktop", "lone-pine"), INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
  bridge.pass();
  const backend = bridge.backend({ perGpu: 1 });
  const guest = bridge.stoppedGuest(7001, mover, 9001);
  const first = await backend.start(guest, signal());
  const second = await backend.start(guest, signal());
  assert.equal(first?.facts?.find((fact) => fact.label === "GPU")?.value, `GPU-${B}`);
  assert.equal(second?.facts?.find((fact) => fact.label === "GPU")?.value, `GPU-${B}`, "the second start, of a running box, names card 1 too");
});

test("071 unit 5, go review N1: an acquire whose guest is replaced by another install's as it writes the labels and marker, or as that write fails, neither labels, marks, starts nor deletes the replacement", async () => {
  for (const stage of ["tags", "failed-tags"] as const) {
    const bridge = new ClaimsBridge();
    const backend = bridge.backend({ templates: `9001 GPU-${A}` });
    let replaced: number | null = null;
    bridge.proxmox.intercept = (call) => {
      const vmid = /\/lxc\/(\d+)\/config$/.exec(call.path);
      if (replaced === null && call.method === "PUT" && vmid && call.params.tags?.includes("gpu.")) {
        replaced = Number(vmid[1]);
        bridge.desktop(replaced, CARD_B, box("linux-desktop", "other-owl"), SECOND_INSTALL, { pool: POOL });
        if (stage === "failed-tags") throw new Error("the write failed as the guest was replaced");
      }
      return undefined;
    };
    await assert.rejects(backend.acquire(box(), null, hooks(), signal()), stage === "tags" ? /is no longer box bx\d+ of this install: its config names box bx\d+ of install 9zz2/ : /the write failed as the guest was replaced/, stage);
    assert.ok(replaced !== null, stage);
    const other = bridge.proxmox.guests.get(replaced!);
    assert.ok(other, `${stage}: the replacement is not deleted`);
    assert.ok(parseTags(other.config.tags).includes(`install.${SECOND_INSTALL}`), `${stage}: its labels are its own: ${other.config.tags}`);
    assert.deepEqual(bridge.gpuTags(replaced!), [], `${stage}: it has no marker of bb-box's`);
    assert.equal(other.status, "stopped", `${stage}: it is not started`);
    bridge.pass();
    assert.deepEqual(bridge.node.guestWrites(), [], `${stage}: and the helper writes nothing to it`);
    assert.equal(bridge.cardOf(replaced!), CARD_B, stage);
  }
});

test("071 unit 5, go review N1: a warm desktop's fill whose guest is replaced by another install's as it writes its marker neither marks, starts nor deletes the replacement", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ warm: 1, templates: `9001 GPU-${A}` });
  let replaced: number | null = null;
  bridge.proxmox.intercept = (call) => {
    const vmid = /\/lxc\/(\d+)\/config$/.exec(call.path);
    if (replaced === null && call.method === "PUT" && vmid && call.params.tags?.includes("gpu.")) {
      replaced = Number(vmid[1]);
      bridge.desktop(replaced, CARD_B, box("linux-desktop", "other-owl"), SECOND_INSTALL, { pool: POOL });
    }
    return undefined;
  };
  await backend.maintain(signal()).catch(() => undefined);
  assert.ok(replaced !== null);
  const other = bridge.proxmox.guests.get(replaced!);
  assert.ok(other, "the replacement is not deleted");
  assert.ok(parseTags(other.config.tags).includes(`install.${SECOND_INSTALL}`), other.config.tags);
  assert.deepEqual(bridge.gpuTags(replaced!), []);
  assert.equal(other.status, "stopped");
  bridge.pass();
  assert.deepEqual(bridge.node.guestWrites(), []);
});

test("071 unit 5, go review N2: a card the helper cannot map to its device nodes takes no box, and a ledger lost meanwhile is rebuilt once the mapping is back, so the running whole box keeps its card", async () => {
  const bridge = new ClaimsBridge();
  bridge.desktop(7001, CARD_A, box("linux-desktop", "whole-owl"), INSTALL, { marker: marker("whole", CARD_A, 1), running: true });
  bridge.pass();
  const loseMapping = () => {
    rmSync(bridge.node.file(`proc/driver/nvidia/gpus/${pciOf(CARD_A)}/information`));
    rmSync(bridge.node.file(`dev/dri/by-path/pci-${pciOf(CARD_A)}-card`));
    rmSync(bridge.node.file(`dev/dri/by-path/pci-${pciOf(CARD_A)}-render`));
  };
  loseMapping();
  bridge.pass();
  const backend = bridge.backend({ templates: `9001 GPU-${A}\n9002 GPU-${B}` });
  bridge.answering = false;
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /The GPU helper on pve cannot map card 0 to its device nodes, so bb-box cannot tell which guests hold it\./);
  bridge.answering = true;
  bridge.node.setCards([CARD_A, CARD_B]);
  rmSync(bridge.node.ledgerPath());
  loseMapping();
  bridge.pass();
  bridge.node.setCards([CARD_A, CARD_B]);
  bridge.pass();
  const lone = bridge.backend({ templates: `9001 GPU-${A}` });
  await assert.rejects(lone.acquire(box(), null, hooks(), signal()), /card 0 is CT 7001's whole card/);
  assert.ok(bridge.node.reportLines().includes(`claim 7001 g1 granted whole ${A}`), bridge.node.reportLines().join("\n"));
  assert.equal(bridge.proxmox.guests.get(7001)!.status, "running");
  assert.deepEqual(bridge.node.guestWrites(), []);
});

type PowerAction = "start" | "stop" | "delete";

function apiPowerCall(call: FakeCall, vmid: number, action: PowerAction): boolean {
  if (action === "delete") return call.method === "DELETE" && call.path.endsWith(`/lxc/${vmid}`);
  return call.method === "POST" && (action === "start" ? call.path.endsWith(`/lxc/${vmid}/status/start`) : /\/status\/(stop|shutdown)$/.test(call.path) && call.path.includes(`/lxc/${vmid}/`));
}

function powerRequest(call: FakeCall, vmid: number, action: PowerAction): boolean {
  const asked = action === "stop" ? /(^|;)bb-power\.(stop|shutdown)\./ : new RegExp(`(^|;)bb-power\\.${action}\\.`);
  return call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`) && asked.test(call.params.tags ?? "");
}

function replacedAtTheFinalAction(bridge: ClaimsBridge, vmid: number, action: PowerAction, replace: (request: string | null) => void): { readonly replaced: () => boolean; readonly from: () => number } {
  let replaced = false;
  let from = -1;
  bridge.proxmox.intercept = (call) => {
    if (replaced) return undefined;
    if (apiPowerCall(call, vmid, action)) {
      replaced = true;
      from = bridge.proxmox.calls.length;
      replace(null);
    } else if (powerRequest(call, vmid, action)) {
      replaced = true;
      from = bridge.proxmox.calls.length;
      bridge.beforePass = () => replace(bridge.tags(vmid).find((tag) => tag.startsWith("bb-power.")) ?? null);
    }
    return undefined;
  };
  return { replaced: () => replaced, from: () => from };
}

function powerCalls(bridge: ClaimsBridge, vmid: number): string[] {
  return bridge.proxmox.calls.filter((call) => (["start", "stop", "delete"] as const).some((action) => apiPowerCall(call, vmid, action))).map((call) => `${call.method} ${call.path}`);
}

test("071 unit 5, go review 2 G1 and go review 3 H1: another install's guest that takes the VMID as bb-box starts a GPU box, carrying its request, is not started: bb-box acts on it no more, records it, and the doctor fails, naming it, as does the next acquire", async () => {
  const bridge = new ClaimsBridge();
  const original = box("linux-desktop", "swift-owl");
  bridge.desktop(7001, CARD_A, original, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.desktop(7002, CARD_B, box("linux-desktop", "whole-owl"), INSTALL, { marker: marker("whole", CARD_B, 1), running: true });
  bridge.pass();
  const backend = bridge.backend();
  const other = box("linux-desktop", "other-owl");
  const at = replacedAtTheFinalAction(bridge, 7001, "start", (request) => bridge.desktop(7001, CARD_B, other, SECOND_INSTALL, { pool: POOL, tags: [...boxTags(other, SECOND_INSTALL, 9002), ...(request ? [request] : [])] }));
  await assert.rejects(backend.start(bridge.stoppedGuest(7001, original, 9001), signal()), /^Error: The GPU helper on pve did not start CT 7001, as the guest at that VMID is not the box bb-box asked for \(9zz2\/bx\d+\)\. bb-box acts on it no more\.$/);
  assert.ok(at.replaced());
  assert.equal(bridge.proxmox.guests.get(7001)!.status, "stopped", "the replacement is not started");
  assert.ok(!bridge.node.powerLog().some((line) => line.endsWith(" 7001")), bridge.node.powerLog().join(" | "));
  assert.deepEqual(powerCalls(bridge, 7001), [], "bb-box starts a GPU guest only through the helper");
  const after = bridge.proxmox.calls.slice(at.from()).filter((call) => call.method !== "GET" && call.path.includes("/lxc/7001"));
  assert.deepEqual(after.map((call) => `${call.method} ${call.path}`), [], "nothing more is written to it, nor is it stopped");
  assert.deepEqual(bridge.gpuTags(7001), [], "the other install's guest carries no marker of bb-box's");
  const doctor = (await backend.doctor()).checks.find((check) => check.id === "proxmox.vmids");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor?.detail ?? "", /A guest that is not this install's is in its VMID range from 7000 to 7049: CT 7001, of install 9zz2\./);
  assert.match(doctor?.detail ?? "", /The GPU helper on pve did not start CT 7001, as the guest at that VMID is not the box bb-box asked for/);
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /bb-box takes no VMID from 7000 to 7049 while a guest that is not this install's is in that range: CT 7001, of install 9zz2\./);
});

test("071 unit 5, go review 3 H1: another box of the same install that takes the VMID at bb-box's final start, stop or delete of a GPU box, whether before bb-box's request or carrying it, is not started on a card held whole, stopped or deleted", async () => {
  for (const carrying of [false, true]) {
    const label = carrying ? "carrying the request" : "at the API call";
    {
      const bridge = new ClaimsBridge();
      const original = box("linux-desktop", "start-owl");
      bridge.desktop(7001, CARD_A, original, INSTALL, { marker: marker("shared", CARD_A, 1) });
      bridge.desktop(7002, CARD_B, box("linux-desktop", "whole-owl"), INSTALL, { marker: marker("whole", CARD_B, 1), running: true });
      bridge.pass();
      const twin = box("linux-desktop", "twin-owl");
      const at = replacedAtTheFinalAction(bridge, 7001, "start", (request) => bridge.desktop(7001, CARD_B, twin, INSTALL, { tags: [...boxTags(twin, INSTALL, 9002), ...(carrying && request ? [request] : [])] }));
      const outcome = await bridge.backend().start(bridge.stoppedGuest(7001, original, 9001), signal()).then(() => "started", (error: Error) => error.message);
      assert.ok(at.replaced(), `start, ${label}`);
      assert.equal(bridge.proxmox.guests.get(7001)!.status, "stopped", `start, ${label}: ${outcome}`);
      assert.match(outcome, carrying ? /did not start CT 7001, as the guest at that VMID is not the box bb-box asked for \(4kq7\/bx\d+\)/ : /^CT 7001 is no longer box bx\d+ of this install: its config names box bx\d+ of install 4kq7\./, `start, ${label}`);
      assert.deepEqual(bridge.node.powerLog(), [], `start, ${label}`);
      assert.deepEqual(powerCalls(bridge, 7001), [], `start, ${label}`);
      bridge.pass();
      assert.ok(bridge.node.reportLines().includes(`claim 7002 g1 granted whole ${B}`), `start, ${label}: the whole box keeps its card`);
    }
    {
      const bridge = new ClaimsBridge();
      const original = box("linux-desktop", "stop-owl");
      bridge.desktop(7001, CARD_A, original, INSTALL, { marker: marker("shared", CARD_A, 1), running: true });
      bridge.pass();
      const twin = box("linux-desktop", "twin-owl");
      const at = replacedAtTheFinalAction(bridge, 7001, "stop", (request) => bridge.desktop(7001, CARD_B, twin, INSTALL, { running: true, tags: [...boxTags(twin, INSTALL, 9002), ...(carrying && request ? [request] : [])] }));
      const outcome = await bridge.backend().stop(bridge.stoppedGuest(7001, original, 9001), signal()).then(() => "stopped", (error: Error) => error.message);
      assert.ok(at.replaced(), `stop, ${label}`);
      assert.equal(bridge.proxmox.guests.get(7001)!.status, "running", `stop, ${label}: ${outcome}`);
      assert.deepEqual(bridge.node.powerLog(), [], `stop, ${label}`);
      assert.deepEqual(powerCalls(bridge, 7001), [], `stop, ${label}`);
    }
    {
      const bridge = new ClaimsBridge();
      let failed: number | null = null;
      let at: ReturnType<typeof replacedAtTheFinalAction> | null = null;
      const twin = box("linux-desktop", "twin-owl");
      bridge.proxmox.intercept = (call) => {
        const put = /\/lxc\/(\d+)\/config$/.exec(call.path);
        if (failed === null && call.method === "PUT" && put && call.params.tags?.includes("gpu.")) {
          failed = Number(put[1]);
          at = replacedAtTheFinalAction(bridge, failed, "delete", (request) => bridge.desktop(failed!, CARD_B, twin, INSTALL, { tags: [...boxTags(twin, INSTALL, 9002), ...(carrying && request ? [request] : [])] }));
          throw new Error("the marker write failed");
        }
        return undefined;
      };
      await assert.rejects(bridge.backend({ templates: `9001 GPU-${A}` }).acquire(box(), null, hooks(), signal()), /the marker write failed/, `delete, ${label}`);
      assert.ok(at!.replaced(), `delete, ${label}`);
      assert.ok(bridge.proxmox.guests.has(failed!), `delete, ${label}: the twin is not deleted`);
      assert.match(bridge.proxmox.guests.get(failed!)!.config.description ?? "", /^box bx\d+$/m);
      bridge.pass();
      assert.ok(bridge.node.exists(failed!), `delete, ${label}`);
      assert.ok(!bridge.node.powerLog().some((line) => /^(destroy|removed) /.test(line)), `delete, ${label}: ${bridge.node.powerLog().join(" | ")}`);
      assert.deepEqual(powerCalls(bridge, failed!), [], `delete, ${label}`);
    }
  }
});

test("071 unit 5, go review 3 H1: a GPU box starts, stops and is released through the helper, which acts under the guest's lock; bb-box makes no start, stop or delete call for it, while a box with no GPU keeps Proxmox's own calls", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const made = await backend.acquire(box(), null, hooks(), signal());
  const vmid = Number(made.ref);
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running");
  const guest = made;
  await backend.stop(guest, signal());
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "stopped");
  await backend.start(guest, signal());
  assert.equal(bridge.proxmox.guests.get(vmid)!.status, "running");
  assert.deepEqual(bridge.tags(vmid).filter((tag) => tag.startsWith("bb-power.")), [], "no request is left behind");
  await backend.release(guest, releasing);
  assert.ok(!bridge.proxmox.guests.has(vmid), "released");
  assert.deepEqual(bridge.node.powerLog(), ["start", "stop", "start", "stop", "destroy", "removed"].map((step) => `${step} ${vmid}`));
  assert.deepEqual(powerCalls(bridge, vmid), []);
  assert.deepEqual(bridge.node.guestWrites(), []);

  const plain = await bridge.backend().acquire(box("linux"), null, hooks(), signal());
  assert.ok(bridge.proxmox.calls.some((call) => call.method === "POST" && call.path.endsWith(`/lxc/${plain.ref}/status/start`)), "a box with no GPU starts with Proxmox's own call");
});

test("071 unit 5, go review 2 G1: a failed acquire's cleanup leaves another install's guest that took the VMID, whether it was there before the stop or came at the delete, and protected", async () => {
  for (const stage of ["cleanup-status", "protected-delete"] as const) {
    const bridge = new ClaimsBridge();
    let failed: number | null = null;
    let replaced = false;
    let from = 0;
    bridge.proxmox.intercept = (call) => {
      const put = /\/lxc\/(\d+)\/config$/.exec(call.path);
      if (failed === null && call.method === "PUT" && put && call.params.tags?.includes("gpu.")) {
        failed = Number(put[1]);
        throw new Error("the marker write failed");
      }
      const at = stage === "cleanup-status" ? call.method === "GET" && call.path.endsWith(`/lxc/${failed}/status/current`) : failed !== null && (apiPowerCall(call, failed, "delete") || powerRequest(call, failed, "delete"));
      if (failed !== null && !replaced && at) {
        replaced = true;
        from = bridge.proxmox.calls.length;
        bridge.desktop(failed, CARD_B, box("linux-desktop", "other-owl"), SECOND_INSTALL, { pool: POOL, running: stage === "cleanup-status" });
        if (stage === "protected-delete") bridge.proxmox.guests.get(failed)!.config.protection = "1";
      }
      return undefined;
    };
    await assert.rejects(bridge.backend({ templates: `9001 GPU-${A}` }).acquire(box(), null, hooks(), signal()), /the marker write failed/, stage);
    assert.ok(replaced, stage);
    const other = bridge.proxmox.guests.get(failed!);
    assert.ok(other, `${stage}: the other install's guest is not deleted`);
    assert.equal(other.status, stage === "cleanup-status" ? "running" : "stopped", `${stage}: nor stopped`);
    assert.ok(parseTags(other.config.tags).includes(`install.${SECOND_INSTALL}`), stage);
    if (stage === "protected-delete") assert.equal(other.config.protection, "1", "its protection is not cleared");
    const changed = bridge.proxmox.calls.slice(from).filter((call) => call.method !== "GET" && call.path.includes(`/lxc/${failed}`));
    assert.deepEqual(changed.map((call) => `${call.method} ${call.path} ${JSON.stringify(call.params)}`), [], `${stage}: once it is there, bb-box writes nothing to it, takes no protection off and deletes nothing`);
  }
});

test("071 unit 5, go review 2 G1: a warm desktop's fill writes only the warm guest it made, not another warm guest of this install that took the VMID", async () => {
  const bridge = new ClaimsBridge();
  let replaced: number | null = null;
  bridge.proxmox.intercept = (call) => {
    const vmid = /\/lxc\/(\d+)\/config$/.exec(call.path);
    if (replaced === null && call.method === "PUT" && vmid && call.params.tags?.includes("gpu.")) {
      replaced = Number(vmid[1]);
      bridge.desktop(replaced, CARD_B, box("linux-desktop", "warm-twin"), INSTALL, { description: `bb-box warm desktop\ninstall ${INSTALL}`, tags: ["bb-box", `install.${INSTALL}`, "warm", "template.9002"] });
    }
    return undefined;
  };
  await bridge.backend({ warm: 1, templates: `9001 GPU-${A}` }).maintain(signal()).catch(() => undefined);
  assert.ok(replaced !== null);
  assert.deepEqual(bridge.gpuTags(replaced!), [], "the other warm guest gets no marker");
  assert.equal(bridge.proxmox.guests.get(replaced!)!.status, "stopped", "nor is it started");
  bridge.pass();
  assert.deepEqual(bridge.node.guestWrites(), [], "and the helper writes nothing to it");
  assert.equal(bridge.cardOf(replaced!), CARD_B);
});

test("071 unit 5, go review 2 G1: bb-box takes no VMID while another install's guest, or a guest that is not bb-box's, is in its VMID range, and the doctor fails, naming them", async () => {
  const bridge = new ClaimsBridge();
  bridge.desktop(7003, CARD_B, box("linux-desktop", "other-owl"), SECOND_INSTALL, { pool: POOL });
  bridge.proxmox.guests.set(7004, { vmid: 7004, name: "someone", pool: POOL, status: "running", template: false, config: { hostname: "someone" } });
  bridge.pass();
  const backend = bridge.backend();
  const clones = () => bridge.proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
  const before = clones();
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /^BackendError: bb-box takes no VMID from 7000 to 7049 while a guest that is not this install's is in that range: CT 7003, of install 9zz2; CT 7004, which is not bb-box's\. Give each install a VMID range of its own/);
  assert.equal(clones(), before, "nothing is cloned");
  const doctor = (await backend.doctor()).checks.find((check) => check.id === "proxmox.vmids");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor?.detail ?? "", /CT 7003, of install 9zz2; CT 7004, which is not bb-box's/);
  bridge.proxmox.guests.delete(7003);
  bridge.proxmox.guests.delete(7004);
  bridge.pass();
  const made = await backend.acquire(box(), null, hooks(), signal());
  assert.ok(made.ref, "with the range its own again, an acquire goes ahead");
  assert.equal((await backend.doctor()).checks.find((check) => check.id === "proxmox.vmids")?.status, "ok");
});

test("071 unit 5, go review 3 H1: the doctor's VMID range check fails on a guest whose description names another install behind a bare bb-box tag, and says that it sees only the token's pool, so it is no proof that the range is this install's alone", async () => {
  const bridge = new ClaimsBridge();
  bridge.desktop(7003, CARD_A, box("linux-desktop", "legacy-owl"), SECOND_INSTALL, { pool: POOL, tags: ["bb-box"] });
  bridge.pass();
  const backend = bridge.backend();
  const doctor = (await backend.doctor()).checks.find((check) => check.id === "proxmox.vmids");
  assert.equal(doctor?.status, "fail");
  assert.match(doctor?.detail ?? "", /CT 7003, of install 9zz2/);
  await assert.rejects(backend.acquire(box(), null, hooks(), signal()), /CT 7003, of install 9zz2/);

  const unseen = /The token sees only the guests it has VM\.Audit on, those of pool bbbox, so a guest elsewhere in the range, or another install's range that overlaps this one, is not seen: this check is no proof that the range is this install's alone\./;
  const hidden = new ClaimsBridge();
  hidden.proxmox.hidden.add(7003);
  const quiet = (await hidden.backend().doctor()).checks.find((check) => check.id === "proxmox.vmids");
  assert.equal(quiet?.status, "ok");
  assert.match(quiet?.detail ?? "", /no guest the token can see there is another install's or not bb-box's/);
  assert.match(quiet?.detail ?? "", unseen);

  const overlap = new ClaimsBridge();
  const first = (await overlap.backend().doctor()).checks.find((check) => check.id === "proxmox.vmids");
  const second = (await overlap.backend({ install: SECOND_INSTALL, pool: "other", first: 7000 }).doctor()).checks.find((check) => check.id === "proxmox.vmids");
  assert.match(first?.detail ?? "", unseen);
  assert.match(second?.detail ?? "", /this check is no proof that the range is this install's alone/);
});
