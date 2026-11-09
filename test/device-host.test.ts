import assert from "node:assert/strict";
import { test } from "node:test";
import { DEVICE_DISPLAY, type KindCapabilities } from "../src/backends/types.ts";
import {
  AskOrder,
  OWN_VM,
  parseDeviceHost,
  parseSlot,
  placementData,
  placementOf,
  placementWords,
  readPlacement,
  slotCapabilities,
  slotHostName,
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

test("a slot's host is named by its Mac where BB Box knows it, never by the shared host VM's name or a Namespace tag; a VM of its own has none (069 unit 5)", () => {
  const tart: SlotPlacement = { on: "slot", host: "bb-box-host-0a1b2c3d4e", hostOn: "tart", carried: false, generation: 3, place: 1, most: 3 };
  assert.equal(slotHostName({ guest: { ref: "bb-box-host-0a1b2c3d4e/3", host: "mac-1", address: null, size: null, data: placementData(tart) } }), "mac-1");
  const pool: SlotPlacement = { ...tart, host: "mac-2", hostOn: "pool-mac" };
  assert.equal(slotHostName({ guest: { ref: "mac-2/3", host: "mac-2", address: null, size: null, data: placementData(pool) } }), "mac-2");
  const namespace: SlotPlacement = { ...tart, host: "bbbox-install-ios-host-abc123", hostOn: "namespace" };
  assert.equal(slotHostName({ guest: { ref: "r", host: null, address: null, size: null, data: placementData(namespace) } }), "its Namespace Mac", "a Namespace Mac has no name of its own");
  assert.equal(slotHostName({ guest: { ref: "r", host: "pve-1", address: null, size: null, data: { box: "bx1" } } }), null);
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

test("a host's ready slots go to its boxes in the order they asked: the k-th box still looking takes the k-th free slot, carried first; one making its own slot or claiming one holds no other back (F-11)", () => {
  const slot = (id: string, is: string, madeFor: string | null = null) => ({ id, is, madeFor, carried: id.startsWith("i"), uid: id.startsWith("i") ? 79990 + Number(id.slice(1)) : 80000 + Number(id) });
  const slots = [slot("1", "ready"), slot("i2", "ready"), slot("i1", "ready")];
  const order = new AskOrder();
  for (const box of ["first", "second", "third"]) order.asked("host-a", box);
  order.asked("host-b", "elsewhere");
  const none = new Set<string>();
  assert.deepEqual(["first", "second", "third"].map((box) => order.slotFor("host-a", box, slots, none)?.id), ["i1", "i2", "1"]);
  assert.equal(order.slotFor("host-a", "third", slots.slice(0, 2), none), null, "two free slots are the first two boxes'");
  assert.equal(order.slotForNewBox("host-a", slots, none), null, "a box that asks now comes after all three");
  assert.equal(order.slotForNewBox("host-b", slots, none)?.id, "i2", "another host's queue is its own");
  assert.equal(order.servesFirst("host-a", "first"), false);
  assert.equal(order.servesFirst("host-a", "third"), true);

  order.making("first");
  assert.equal(order.slotFor("host-a", "second", slots.slice(1), none)?.id, "i1", "the first box makes its own slot, so it holds none back");
  order.looking("first");
  order.claiming("first", "i1");
  assert.equal(order.slotFor("host-a", "second", slots, none)?.id, "i2", "the slot the first box claims is not offered to the next");
  order.served("first");
  assert.equal(order.slotFor("host-a", "second", slots, none)?.id, "i1");
  assert.equal(order.waitingOn("host-a"), 2);

  const mine = [slot("i1", "ready"), slot("3", "ready", "third")];
  assert.equal(order.slotFor("host-a", "third", mine, new Set(["third"]))?.id, "3", "a slot made for a box is its own, whatever its place");
  assert.equal(order.slotFor("host-a", "second", mine, new Set(["third"]))?.id, "i1", "and no other box's while it is acquired");
  order.asked("host-a", "second");
  assert.equal(order.slotFor("host-a", "second", slots, none)?.id, "i1", "asking again keeps a box's place");
});
