import assert from "node:assert/strict";
import { test } from "node:test";
import { CardReservations, cardsView, loadOf, nextGeneration, outstandingRequests, placeShared, settleOutstanding, underCardLock, waitForAnswer, type PlaceInput, type Placed } from "../src/backends/proxmox-lxc/gpu-claims.ts";
import { parseHelperLines } from "../src/backends/proxmox-lxc/gpu-marking.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, SECOND_INSTALL } from "./gpu-helper/claims-bridge.ts";
import { marker } from "./gpu-helper/node.ts";

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

function puts(bridge: ClaimsBridge, vmid: number): Record<string, string>[] {
  return bridge.proxmox.calls.filter((call) => call.method === "PUT" && call.path.endsWith(`/lxc/${vmid}/config`)).map((call) => call.params);
}

test("071 unit 5: with the helper's writes on, a GPU desktop is placed on a card, its marker goes in the same write as its labels, and it starts only once the helper grants it; the helper writes no guest, and the claim is the box's", async () => {
  const bridge = new ClaimsBridge();
  const events: string[] = [];
  const backend = bridge.backend({ onSleep: () => events.push("helper pass") });
  bridge.proxmox.intercept = (call) => {
    if (call.method === "PUT" && /gpu\.shared\./.test(call.params.tags ?? "")) events.push("marker");
    if (call.method === "POST" && call.path.endsWith("/status/start")) events.push("start");
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

test("071 unit 5: without the helper, a GPU desktop is made as before, with no marker; with a helper bb-box cannot use, it is refused with words and a box whose claim stands still starts", async () => {
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
  await backend.start({ ref: "7006", host: "pve", address: null, size: null, data: { template: 9001, box: owl.boxId } }, signal());
  assert.equal(stale.proxmox.guests.get(7006)!.status, "running", "its claim stands, so it starts");
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
    if (call.method === "POST" && call.path.endsWith("/lxc/7007/status/start")) events.push("start");
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

test("071 unit 5, re-review R4: a moved box's GPU is the card it holds, not its template's, when it is started again on a stale report", async () => {
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
  const again = await backend.start(guest, signal());
  assert.equal(bridge.proxmox.guests.get(7010)!.status, "running");
  assert.deepEqual(again && "claim" in again ? again.claim : null, { card: B, part: "shared", generation: 2, answer: "granted" });
  assert.deepEqual(again?.facts?.find((fact) => fact.label === "GPU"), { label: "GPU", value: `GPU-${B}` }, "started on a stale report, its GPU fact still names the card it holds");
});
