import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { placementOf, placementWords } from "../src/core/device-host.ts";
import { poolSlotOf, sweepWords } from "../src/backends/ssh-pool/slots.ts";
import { offerChecks } from "../src/backends/index.ts";
import { identity, recordingHooks, releaseHooks, sizeOf } from "./conformance/suite.ts";
import { fakePoolMac } from "./fake-pool-mac.ts";

const wait = () => AbortSignal.timeout(60_000);

describe("the SSH host pool's Mac lends iOS slots (064 unit 5)", { timeout: 300_000 }, () => {
  const pool = fakePoolMac();
  const backend = pool.backend();

  it("offers ios only for slots, from what the Mac's slots are made with, once a survey has read them", async () => {
    assert.ok(backend.slots?.lends("ios"));
    assert.equal(backend.kinds().some((kind) => kind.id === "ios"), false, "before a survey");
    await backend.members(wait());
    const ios = backend.kinds().find((kind) => kind.id === "ios");
    assert.ok(ios);
    assert.equal(ios.slotsOnly, true);
    assert.deepEqual(ios.capabilities.displays.map((display) => display.id), ["device"]);
    assert.equal(ios.capabilities.command?.admin, false);
    assert.deepEqual(ios.capabilities.device?.devices.map((device) => [device.model, "os" in device.runtime ? device.runtime.os : null]), [["iPhone 18 Pro", "27.0"]]);
    assert.deepEqual(backend.context.logs, []);
    const capacity = await backend.capacity("ios", sizeOf("ios"), [], wait());
    assert.equal(capacity.ok, false);
    assert.match(capacity.message!, /lends ios boxes only as slots on its Macs/);
    assert.match(backend.offerNote("ios")!, /^iOS slots on 1 physical Mac \(8 cores, 16 GiB\), up to 12 on each, only with shared: true/);
    assert.equal(backend.free("ios"), null);
  });

  it("opens the closed Mac at the first take, makes and lends a slot, and refuses the Mac whole while it is held", async () => {
    const box = identity("ios");
    const offer = await backend.slots!.offer("ios", null, wait());
    assert.equal(offer.tier, "make", JSON.stringify(offer));
    const taken = await backend.slots!.take(offer, box, wait());
    assert.ok(!("lost" in taken), JSON.stringify(taken));
    assert.deepEqual(poolSlotOf(taken), { mac: "mac-1", slot: null, box: box.boxId });
    const { hooks } = recordingHooks();
    const guest = await backend.acquire(box, taken, hooks, wait());
    const placement = placementOf({ guest });
    assert.equal(placement.on, "slot");
    assert.match(placementWords(placement), /^On a shared iOS host \(the pool's Mac\), slot 1 of 12\. Ports 20000 to 20099/);
    assert.equal(await backend.power(guest, wait()), "running");
    assert.equal(pool.mac.status().slots.find((slot) => slot.box === box.boxId)?.is, "held");
    const transports = await backend.transports(guest, "ios");
    assert.equal(transports.access?.ssh?.user, "bbd-1");
    assert.equal(transports.displays.length, 0);
    assert.deepEqual(transports.daemonKeptByHost?.installerEnvironment, { BB_INSTALL_SKIP_SERVICE: "1" });

    const whole = await backend.capacity("macos-desktop", sizeOf("macos-desktop"), [], wait());
    assert.equal(whole.ok, false);
    assert.match(whole.message!, /The pool's Mac mac-1 is lending iOS slots \(1 held\)\. It is lent whole again when they are released\./);
    assert.equal(backend.free("macos-desktop"), 0);
    await assert.rejects(backend.grant(guest, { program: "/bin/sh", permissions: ["accessibility"] }, wait()), /no console session/);
    assert.equal(await backend.grants(guest, wait()), null);

    const held = await backend.held(wait());
    assert.deepEqual(held.filter((each) => each.owner).map((each) => [each.ref, each.owner?.boxId]), [[guest.ref, box.boxId]]);

    const doctor = await backend.doctor(wait());
    const slots = doctor.checks.find((check) => check.id === "machine.mac-1.slots");
    assert.equal(slots?.status, "ok");
    assert.match(slots!.detail, /^Lends iOS slots, 1 held, 0 ready, 0 making, \d+ sweeping, of 12: iOS 27\.0 \(24A434\), the iPhone 18 Pro/);
    assert.match(slots!.detail, new RegExp(`Slot 1 \\(box ${box.boxId}\\): \\d+\\.\\d\\d cores, \\d+\\.\\d GiB`));

    await backend.release(guest, releaseHooks().hooks, wait());
    assert.equal(await backend.power(guest, wait()), null);
    await pool.mac.until("the released slot swept", () => pool.mac.status().values.get("sweeping") === "0");
    const swept = (await backend.doctor(wait())).checks.find((check) => check.id === "machine.mac-1.slots");
    assert.match(swept!.detail, /Its last sweeps: of UID 80001, \d+ paths? found and 0 left, in \d+ s\./);
    const free = await backend.capacity("macos-desktop", sizeOf("macos-desktop"), [], wait());
    assert.equal(free.ok, true, free.message ?? "");
  });

  it("a whole box closes the Mac's slots, and while it holds the Mac an ios box waits with words; once it is released the upkeep opens the Mac again", async () => {
    const box = identity("macos");
    const { hooks } = recordingHooks();
    const guest = await backend.acquire(box, null, hooks, wait());
    assert.equal(guest.ref, "mac-1");
    assert.match(pool.mac.file("/var/db/bb-box/host/closed") ?? "", /^since=/);
    const offer = await backend.slots!.offer("ios", null, wait());
    assert.deepEqual(offer, { tier: "wait", words: "The pool's Mac mac-1 is lent whole to a box, so it lends no iOS slot until that box is released." });
    await backend.maintain(wait());
    assert.match(pool.mac.file("/var/db/bb-box/host/closed") ?? "", /^since=/, "the upkeep leaves a Mac lent whole closed");
    await backend.release(guest, releaseHooks().hooks, wait());
    await backend.maintain(wait());
    assert.equal(pool.mac.file("/var/db/bb-box/host/closed"), null);
    assert.ok(backend.context.logs.some((line) => /The pool's Mac mac-1 lends iOS slots again/.test(line)), backend.context.logs.join("\n"));
  });

  it("a box that asks for another model than the slots' is refused with words naming dedicated", async () => {
    const offer = await backend.slots!.offer("ios", "iPhone 17", wait());
    assert.equal(offer.tier, "wait");
    assert.match((offer as { words: string }).words, /the iPhone 18 Pro, the model every slot is made with\. Leave device out for it, or ask for dedicated: true for the iPhone 17\./);
  });

  it("the doctor's check that offers agree does not count the slot offer's missing desktop", () => {
    const ios = backend.kinds().find((kind) => kind.id === "ios")!;
    const vm = { ...ios, slotsOnly: undefined, capabilities: { ...ios.capabilities, displays: [{ id: "desktop", protocol: "rfb" as const, resizable: false }, ...ios.capabilities.displays] } };
    const checks = offerChecks([{ kind: vm, backend: { ...backend, label: "Tart" } as never }, { kind: ios, backend }]);
    assert.deepEqual(checks.map((check) => check.status), ["ok"]);
  });
});

describe("the doctor's words for the slots' sweeps", () => {
  it("give each pass once, with the UIDs it swept", () => {
    const sweep = (uid: number, inPass: number, found: number, left: number, seconds: number) => ({ uid, uidsInPass: inPass, found, left, seconds, at: 1 });
    const status = { sweeps: [sweep(80001, 1, 8, 0, 46), sweep(80002, 3, 38, 0, 36), sweep(80003, 3, 38, 0, 36), sweep(80004, 3, 38, 0, 36), sweep(80005, 1, 9, 1, 50)] } as unknown as Parameters<typeof sweepWords>[0];
    assert.equal(sweepWords(status), " Its last sweeps: of UID 80001, 8 paths found and 0 left, in 46 s; of UIDs 80002, 80003 and 80004, 38 paths found and 0 left, in 36 s; of UID 80005, 9 paths found and 1 left, in 50 s. A sweep that leaves a path needs the helper's Full Disk Access.");
  });
});

describe("a slot acquire that fails", { timeout: 120_000 }, () => {
  it("gives back the promise it was placed with, as the registry expects of a backend", async () => {
    const pool = fakePoolMac();
    const backend = pool.backend();
    await backend.members(wait());
    const box = identity("ios");
    const offer = await backend.slots.offer("ios", null, wait());
    const taken = await backend.slots.take(offer, box, wait());
    assert.ok(!("lost" in taken));
    assert.equal(pool.mac.status().lines.filter((line) => line.startsWith(`promise=${box.boxId}`)).length, 1);
    pool.mac.flag("simctl-create-fails");
    await assert.rejects(backend.acquire(box, taken, recordingHooks().hooks, wait()), /could not make an iOS slot/);
    assert.equal(pool.mac.status().lines.filter((line) => line.startsWith(`promise=${box.boxId}`)).length, 0, "the promise is given back");
  });
});

describe("a pool Mac whose line does not list ios", { timeout: 120_000 }, () => {
  it("lends no slot, and the upkeep closes slots left open with nothing held", async () => {
    const pool = fakePoolMac({ kinds: "macos,macos-desktop" });
    assert.equal(pool.mac.run(["open"], "install=test\nmost=12\nahead=0\nresetting-most=4\ndisk-reserve-gib=40\n").status, 0);
    const backend = pool.backend();
    assert.equal(backend.slots.lends("ios"), false);
    await backend.maintain(wait());
    assert.match(pool.mac.file("/var/db/bb-box/host/closed") ?? "", /^since=/);
  });
});
