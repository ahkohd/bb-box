import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedDriver } from "../src/backends/proxmox-lxc/gpu-marking.ts";
import { heldCopyDescription, heldCopyTags } from "../src/backends/proxmox/copies.ts";
import type { AcquireHooks, BoxIdentity, CopyHooks, GpuHandoff, Guest } from "../src/backends/types.ts";
import { CARD_A, CARD_B, ClaimsBridge, INSTALL, POOL, SECOND_INSTALL } from "./gpu-helper/claims-bridge.ts";
import { REPORT_VMID, marker, type FakeCard } from "./gpu-helper/node.ts";

const A = CARD_A.uuid;
const B = CARD_B.uuid;
const signal = () => new AbortController().signal;
const copyHooks: CopyHooks = { claimed: async () => {}, submitting: async () => {}, task: async () => {} };
const acquireHooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

let counter = 0;
function box(kind = "linux-desktop"): BoxIdentity {
  counter++;
  return { boxId: `bxrestore${counter}`, threadId: "thr_restore", name: `restore-box-${counter}`, kind, createdAt: Date.UTC(2026, 10, 5), size: { cores: 4, memoryMiB: 8192, diskGiB: null, gpu: kind === "linux-desktop" ? "shared" : "none" } };
}

function legacyHeldCopy(bridge: ClaimsBridge, vmid: number, of: BoxIdentity, card: FakeCard): Guest {
  const template = card === CARD_A ? 9001 : 9002;
  const label = { box: of.boxId, snapshot: "snlegacycopy01", kept: null };
  const { template: _template, protection: _protection, ...config } = bridge.proxmox.guests.get(template)!.config;
  bridge.proxmox.guests.set(vmid, {
    vmid,
    name: `copy-${vmid}`,
    pool: POOL,
    status: "stopped",
    template: true,
    config: { ...config, template: "1", hostname: `copy-${vmid}`, description: heldCopyDescription(INSTALL, label), tags: heldCopyTags(INSTALL, label, Date.UTC(2026, 10, 1), template).join(";"), rootfs: `local-lvm:vm-${vmid}-disk-0,size=8G` },
  });
  bridge.proxmox.statusPass();
  return { ref: String(vmid), host: "pve", address: null, size: null, data: { template, box: of.boxId } };
}

function generationOf(bridge: ClaimsBridge, vmid: number): number {
  return Number(/\.g(\d+)$/.exec(bridge.gpuTags(vmid)[0] ?? "")?.[1] ?? 0);
}

function configWrites(bridge: ClaimsBridge, from: number): number {
  return bridge.proxmox.calls.slice(from).filter((call) => call.method === "PUT" && call.path.endsWith("/config")).length;
}

async function oldGuestOnB(bridge: ClaimsBridge, generation: number): Promise<{ readonly of: BoxIdentity; readonly old: Guest; readonly held: GpuHandoff }> {
  const backend = bridge.backend({ perGpu: 1 });
  const of = box();
  bridge.desktop(7042, CARD_B, of, INSTALL, { marker: marker("shared", CARD_B, generation) });
  bridge.pass();
  const old = bridge.stoppedGuest(7042, of, 9002);
  const held = (await backend.readGpuClaim(old, signal()))!;
  assert.equal(held.card, B);
  await backend.releaseGpuClaim(old, signal());
  assert.deepEqual(bridge.lines(7042), [], "the old guest's claim is cleared, and its lines with it");
  return { of, old, held };
}

test("071 unit 6, Astra 1: a swap's new guest, made from a held copy that still has another card's lines and no marker, does not start with its node until the helper grants it the box's claim and its lines name that card", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const { of, held } = await oldGuestOnB(bridge, 3);
  const fresh = await backend.adoptCopy(legacyHeldCopy(bridge, 7045, of, CARD_A), of, { macs: {}, smbios: null }, copyHooks, signal());
  const vmid = Number(fresh.ref);
  const made = bridge.proxmox.guests.get(vmid)!.config;
  assert.equal(made.onboot, "0", "a node boot now would not start it on card 0's lines");
  assert.equal(bridge.cardOf(vmid)?.uuid, A, "it came with the copy's lines");
  bridge.answering = false;
  await assert.rejects(backend.armAdopted(fresh, held, signal()), /did not grant gpu\.shared\.8c41d7b2-1a9e-4f63-b0c5-7e2d9a3b6c11\.g\d+: The host's GPU helper on pve did not answer within 10 s/);
  assert.equal(made.onboot, "0", "with no answer, it stays disarmed");
  bridge.answering = true;
  await backend.armAdopted(fresh, held, signal());
  assert.equal(bridge.cardOf(vmid)?.uuid, B, "its lines name the box's card");
  assert.equal(made.onboot, "1", "and only then does it start with its node");
  assert.deepEqual(bridge.lines(7042), [], "the old guest has no card: never two claims");
});

test("071 unit 6, Astra 1: a new guest whose lines still name another card after the helper grants its claim is not set to start with its node", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const { of, held } = await oldGuestOnB(bridge, 3);
  const fresh = await backend.adoptCopy(legacyHeldCopy(bridge, 7045, of, CARD_A), of, { macs: {}, smbios: null }, copyHooks, signal());
  const vmid = Number(fresh.ref);
  let tampered = false;
  bridge.proxmox.intercept = (call) => {
    if (!tampered && call.method === "GET" && call.path.endsWith(`/lxc/${vmid}/config`) && bridge.node.ledger().guests[String(vmid)]?.claim?.answer === "granted") {
      tampered = true;
      bridge.proxmox.guests.get(vmid)!.config.dev9 = `/dev/nvidia${CARD_A.minor},mode=0666`;
    }
    return undefined;
  };
  await assert.rejects(backend.armAdopted(fresh, held, signal()), new RegExp(`CT ${vmid}'s device lines do not match its claim, card 1, after the host's GPU helper granted it: it has /dev/nvidia1,mode=0666\\.`));
  assert.ok(tampered);
  assert.equal(bridge.proxmox.guests.get(vmid)!.config.onboot, "0");
});

test("071 unit 6, Astra 3: after a restart, the new guest asks with a generation above every ledger entry of its box, as the helper names it install/box, so it is not refused as a copy", async () => {
  const bridge = new ClaimsBridge();
  const before = bridge.backend({ perGpu: 1 });
  const { of, held } = await oldGuestOnB(bridge, 100);
  assert.equal(bridge.node.ledger().guests["7042"]?.answered, 101);
  assert.equal(bridge.node.ledger().guests["7042"]?.box, `${INSTALL}/${of.boxId}`);
  const fresh = await before.adoptCopy(legacyHeldCopy(bridge, 7045, of, CARD_A), of, { macs: {}, smbios: null }, copyHooks, signal());
  const restarted = bridge.backend({ perGpu: 1 });
  await restarted.armAdopted(fresh, held, signal());
  const vmid = Number(fresh.ref);
  assert.ok(generationOf(bridge, vmid) > 101, bridge.gpuTags(vmid).join(" "));
  assert.equal(bridge.node.ledger().guests[String(vmid)]?.claim?.answer, "granted");
  assert.equal(bridge.cardOf(vmid)?.uuid, B);
});

test("071 unit 6, Astra 2: a restore holds the box's card while the box is stopped, so another desktop goes to the other card, and its start keeps that card; after a restart a card that has filled is refused, and a claim the helper has taken away is not started, never moved", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend({ perGpu: 1 });
  const restoring = box();
  bridge.desktop(7040, CARD_B, restoring, INSTALL, { marker: marker("shared", CARD_B, 2), running: true });
  bridge.pass();
  const guest = bridge.stoppedGuest(7040, restoring, 9002);
  const held = (await backend.readGpuClaim(guest, signal()))!;
  await backend.holdGpuCard(guest, held, signal());
  await backend.powerOff(guest, signal());
  bridge.pass();
  const other = await backend.acquire(box(), null, acquireHooks, signal());
  assert.equal(bridge.cardOf(Number(other.ref))?.uuid, A, "card 1 is held for the box being restored");
  await assert.rejects(backend.acquire(box(), null, acquireHooks, signal()), /No card on pve can take another box now/);
  await backend.start(guest, signal());
  assert.equal(bridge.cardOf(7040)?.uuid, B);
  assert.deepEqual(bridge.gpuTags(7040), [marker("shared", CARD_B, 2)], "the claim the restore kept, not a new one");

  const second = new ClaimsBridge();
  const stopped = box();
  second.desktop(7040, CARD_B, stopped, INSTALL, { marker: marker("shared", CARD_B, 2) });
  second.desktop(7041, CARD_B, box(), INSTALL, { marker: marker("shared", CARD_B, 1), running: true });
  second.pass();
  const restarted = second.backend({ perGpu: 1 });
  const gone = second.stoppedGuest(7040, stopped, 9002);
  await assert.rejects(restarted.holdGpuCard(gone, (await restarted.readGpuClaim(gone, signal()))!, signal()), /^BackendError: Card 1, which the box holds, cannot take it now: card 1 has 1 of this install's boxes, the most a card may have\. A restore keeps a box on its card, so bb-box does not move it to another one\./);
  assert.deepEqual(second.gpuTags(7040), [marker("shared", CARD_B, 2)]);

  const third = new ClaimsBridge();
  const pinned = third.backend({ perGpu: 1 });
  const kept = box();
  third.desktop(7040, CARD_B, kept, INSTALL, { marker: marker("shared", CARD_B, 2) });
  third.pass();
  const keptGuest = third.stoppedGuest(7040, kept, 9002);
  await pinned.holdGpuCard(keptGuest, (await pinned.readGpuClaim(keptGuest, signal()))!, signal());
  third.desktop(7055, CARD_B, box(), SECOND_INSTALL, { marker: marker("whole", CARD_B, 1) });
  third.pass();
  await assert.rejects(pinned.start(keptGuest, signal()), /^Error: Container 7040 was not started: .* It is stopped, with its disk as it was\.$/);
  assert.equal(third.proxmox.guests.get(7040)!.status, "stopped");
  assert.ok(!third.gpuTags(7040).some((tag) => tag.includes(A)), "not moved to card 0");
});

test("071 unit 6, Fable 3: keeping the claim of a box with no GPU, or one whose rolled-back marker is its current claim, writes nothing and never waits for the helper", async () => {
  const bridge = new ClaimsBridge();
  let sleeps = 0;
  const backend = bridge.backend({ onSleep: () => sleeps++ });
  const plain = box("linux");
  bridge.plain(7046, plain, INSTALL, { tags: [marker("none", null, 1)] });
  const desktop = box();
  bridge.desktop(7047, CARD_B, desktop, INSTALL, { marker: marker("shared", CARD_B, 4) });
  bridge.pass();
  const plainGuest = bridge.stoppedGuest(7046, plain, 9000);
  const desktopGuest = bridge.stoppedGuest(7047, desktop, 9002);
  const plainHeld = (await backend.readGpuClaim(plainGuest, signal()))!;
  const desktopHeld = (await backend.readGpuClaim(desktopGuest, signal()))!;
  assert.equal(plainHeld.part, "none");
  bridge.answering = false;
  const from = bridge.proxmox.calls.length;
  await backend.keepGpuClaim(plainGuest, plainHeld, signal());
  assert.equal(bridge.proxmox.calls.slice(from).filter((call) => call.path.includes(`/${REPORT_VMID}/`)).length, 0, "the helper's report is not even read");
  await backend.keepGpuClaim(desktopGuest, desktopHeld, signal());
  await backend.releaseGpuClaim(bridge.stoppedGuest(7046, plain, 9000), signal());
  assert.equal(configWrites(bridge, from), 0);
  assert.equal(sleeps, 0);
  assert.deepEqual(bridge.gpuTags(7047), [marker("shared", CARD_B, 4)]);
});

test("071 unit 6, Astra 7: the restore's userspace note reads the host's driver from the helper's report, whose lines are indented", async () => {
  const bridge = new ClaimsBridge();
  const backend = bridge.backend();
  const desktop = box();
  bridge.desktop(7048, CARD_A, desktop, INSTALL, { marker: marker("shared", CARD_A, 1) });
  bridge.pass();
  const notes = bridge.proxmox.guests.get(REPORT_VMID)!.config.description ?? "";
  assert.match(notes, /^\s+driver 580\.142 since \d+$/m);
  assert.equal(reportedDriver(notes), "580.142");
  assert.equal((await backend.gpuRestoreFacts(bridge.stoppedGuest(7048, desktop, 9001), signal())).driver, "580.142");
});
