import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_DISPLAY, type KindCapabilities } from "../src/backends/types.ts";
import {
  OWN_VM,
  parseDeviceHost,
  parseSlot,
  placementData,
  placementOf,
  placementWords,
  readPlacement,
  slotCapabilities,
  slotPorts,
  slotUid,
  slotUser,
  type SlotPlacement,
} from "../src/core/device-host.ts";
import { illegal, legal } from "./device-host-types.ts";

test("a slot's user and UID come from its generation: carried slots 79991 and 79992, made ones from 80000, never a UID macOS gives (064)", () => {
  assert.equal(slotUser({ carried: true, generation: 1 }), "bbd-i1");
  assert.equal(slotUid({ carried: true, generation: 2 }), 79992);
  assert.equal(slotUser({ carried: false, generation: 1 }), "bbd-1");
  assert.equal(slotUid({ carried: false, generation: 1 }), 80001);
  assert.equal(slotUid({ carried: false, generation: 9999 }), 89999, "the last: no UID wraps, as the helper refuses generation 10000");
  for (let generation = 1; generation < 10_000; generation += 997) {
    const uid = slotUid({ carried: false, generation });
    assert.ok(uid >= 80000 && uid <= 89999, `generation ${generation} gives ${uid}`);
  }
});

test("each slot's ports are 100 from 20000 plus 100 times its place, from 0 as the helper counts places (064)", () => {
  assert.deepEqual(slotPorts(0), { base: 20000, count: 100 });
  assert.deepEqual(slotPorts(3), { base: 20300, count: 100 });
  assert.deepEqual(slotPorts(8), { base: 20800, count: 100 });
});

test("a placement is written into guest.data once and read back; no slot keys is a VM of its own; a broken one is refused in words (064)", () => {
  const slot: SlotPlacement = { on: "slot", host: "bb-box-host-1", hostOn: "pool-mac", carried: true, generation: 1, place: 0, most: 12 };
  const data = { box: "bx1", generation: 4, ...placementData(slot) };
  assert.deepEqual(readPlacement(data), { ok: true, value: slot }, "beside a backend's own keys, such as the pool's generation");
  assert.deepEqual(placementOf({ guest: { ref: "r", host: null, address: null, size: null, data } }), slot);
  assert.deepEqual(readPlacement({ box: "bx1" }), { ok: true, value: OWN_VM });
  assert.deepEqual(readPlacement(undefined), { ok: true, value: OWN_VM });
  assert.deepEqual(placementOf({ guest: null }), OWN_VM);
  assert.deepEqual(readPlacement({ ...placementData(slot), slotGeneration: 3 }), { ok: false, words: "guest.data.slotGeneration must be 1 or 2, not 3." });
  assert.deepEqual(readPlacement({ ...placementData(slot), slotPlace: 12 }), { ok: false, words: "guest.data.slotPlace must be a whole number from 0 to 11, not 12." });
  assert.deepEqual(readPlacement({ ...placementData(slot), slotCarried: false, slotGeneration: 10000 }), { ok: false, words: "guest.data.slotGeneration must be a whole number from 1 to 9999, not 10000." });
  assert.deepEqual(readPlacement({ ...placementData(slot), slotHostOn: "docker" }), { ok: false, words: 'guest.data.slotHostOn must be "pool-mac", "tart" or "namespace", not "docker".' });
});

test("box_status's words for where a box is (064)", () => {
  assert.equal(placementWords(OWN_VM), "A VM of its own.");
  assert.equal(
    placementWords({ on: "slot", host: "h", hostOn: "tart", carried: false, generation: 9, place: 2, most: 8 }),
    "On a shared iOS host (a Tart VM), slot 3 of 8. Ports 20200 to 20299, in BB_PORT_BASE and BB_PORT_COUNT.",
  );
  assert.match(placementWords({ on: "slot", host: "h", hostOn: "pool-mac", carried: false, generation: 9, place: 0, most: 12 }), /^On a shared iOS host \(the pool's Mac\), slot 1 of 12\. Ports 20000 to 20099/);
});

const IOS_ONE = {
  model: "iPhone 18 Pro",
  native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro",
  runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" },
  slim: { list: "ios-27.0-24A434", labels: 112, sha256: "a".repeat(64) },
} as const;

test("a slot's capabilities are the offer's with no root, no host desktop and no desktop computer use; the device and enrolment stay (064)", () => {
  const offer: KindCapabilities = {
    os: "macos",
    arch: "arm64",
    gpu: false,
    features: [],
    command: { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true },
    displays: [{ id: "desktop", protocol: "rfb", resizable: false }, DEVICE_DISPLAY],
    computerUse: { driver: "cua", version: "1", socket: "~/cua.sock" },
    enrol: true,
    device: { platform: "ios", devices: [IOS_ONE, { ...IOS_ONE, model: "iPhone 17", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-17" }] },
  };
  const slot = slotCapabilities(offer);
  assert.deepEqual(slot.device, { platform: "ios", devices: [IOS_ONE] }, "a slot's one model, the first, which every slot is made with");
  assert.equal(slot.command?.admin, false);
  assert.deepEqual(slot.displays, [DEVICE_DISPLAY]);
  assert.equal(slot.computerUse, null);
  assert.equal(slot.enrol, true);
  assert.equal(offer.command?.admin, true, "the offer is left as it was");
});

test("the legal shapes of hosts and slots read back whole; the illegal ones that reach the reader are refused (064)", () => {
  for (const host of [legal.poolMac, legal.tartStarting, legal.namespace]) assert.deepEqual(parseDeviceHost(JSON.parse(JSON.stringify(host))), { ok: true, value: host });
  assert.deepEqual(parseSlot(legal.making), { ok: true, value: legal.making });
  for (const state of [legal.heldIos, legal.heldMacos]) assert.deepEqual(parseSlot({ host: "h", carried: false, generation: 1, state }), { ok: true, value: { host: "h", carried: false, generation: 1, state } });
  const refused = (parsed: { ok: boolean; words?: string }, words: RegExp) => {
    assert.equal(parsed.ok, false);
    assert.match(parsed.words!, words);
  };
  refused(parseDeviceHost(illegal.poolMacStarting), /^host\.state\.is must be "free", "whole"/);
  refused(parseDeviceHost(illegal.tartLentWhole), /^host\.state\.is must be "starting"/);
  refused(parseDeviceHost(illegal.tartWithAnEnd), /^host has "endsAt", which it does not take\./);
  refused(parseDeviceHost(illegal.namespaceWithNoEnd), /^host\.endsAt must be a whole number/);
  refused(parseDeviceHost({ ...legal.tartStarting, state: { is: "starting", promised: Array.from({ length: 9 }, (_, index) => `bx${index}`), since: 0 } }), /has 9 boxes, more than the host's 8 slots\.$/);
  refused(parseDeviceHost({ ...legal.tartStarting, state: { is: "starting", promised: ["bx1", "bx1"], since: 0 } }), /names a box twice\.$/);
  refused(parseDeviceHost({ ...legal.tartStarting, settings: { most: 8, ahead: 9, resettingMost: 4 } }), /^host\.settings\.ahead must be a whole number from 0 to 8, not 9\.$/);
  refused(parseSlot({ ...illegal.carriedThird, host: "h", state: legal.heldMacos }), /^slot\.generation must be 1 or 2, not 3\.$/);
  refused(parseSlot(illegal.slotWithItsUser), /^slot has "user" and "uid", which they do not take\./);
  refused(parseSlot({ host: "h", carried: false, generation: 1, state: illegal.makingForNobodySaid }), /^slot\.state\.for must be text, not missing\.$/);
  refused(parseSlot({ host: "h", carried: false, generation: 1, state: illegal.heldIosWithNoDevice }), /^slot\.state\.device must be an object, not missing\.$/);
  refused(parseSlot({ host: "h", carried: false, generation: 1, state: illegal.heldMacosWithADevice }), /^slot\.state has "device", which it does not take\./);
  refused(parseSlot({ host: "h", carried: false, generation: 1, state: illegal.heldForLinux }), /^slot\.state\.for must be "ios" or "macos", not "linux"\.$/);
  refused(parseSlot({ host: "h", carried: false, generation: 1, state: illegal.androidInASlot }), /^slot\.state\.device\.model must be "iPhone 18 Pro"/);
});
