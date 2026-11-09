import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSshPoolSettings } from "../src/backends/ssh-pool/config.ts";
import { parseTartPart } from "../src/backends/tart/config.ts";
import { hostSizingWords, macSlotSizingWords, sizeHost, sizeMacSlots, slotsTheCpuAllows, slotsTheEncoderAllows } from "../src/core/slot-sizing.ts";

const M4_MAX = { name: "mac-1", cores: 16, performanceCores: 12, memoryGiB: 128, chip: "Apple M4 Max" };
const POOL_MAC = { name: "pool-mac", cores: 18, performanceCores: null, memoryGiB: 36, chip: "Apple M5 Max" };
const DEFAULTS = { most: 8, cores: 8, memoryGiB: 32 };

test("a shared host on a 16-core, 128 GiB M4 Max gets its 12 performance cores, 9 slots for them, and 22 GiB; the pool's 18-core, 36 GiB M5 Max lends 13 (F-9 item 7)", () => {
  assert.deepEqual(slotsTheEncoderAllows("Apple M4 Max"), { slots: 12, budget: 320, measured: true });
  assert.deepEqual(slotsTheEncoderAllows("Apple M5 Max"), { slots: 14, budget: 375, measured: true });
  assert.deepEqual(slotsTheEncoderAllows("Apple M9 Ultra"), { slots: 12, budget: 320, measured: false });
  const host = sizeHost(M4_MAX, {}, {}, DEFAULTS, 112);
  assert.deepEqual([host.most.value, host.cores.value, host.memoryGiB.value], [9, 12, 22]);
  assert.equal(
    hostSizingWords(host),
    "9 slots (estimated: 9 for 12 cores at 1.3 a busy device, 69 for the 112 GiB of mac-1's memory a host may have, at 1.5 GiB a device after 8 GiB for the host, 12 for the video encoder (an Apple M4 Max, about 320 full-size frames a second, each slot a stream at a half at 60 a second within three quarters of it); the fewest), 12 cores (estimated: mac-1's performance cores), 22 GiB (estimated: 8 GiB for the host and 1.5 GiB for each of its 9 slots)",
  );
  const pool = sizeMacSlots(POOL_MAC, undefined, undefined, 12);
  assert.equal(pool.most.value, 13);
  assert.match(macSlotSizingWords(pool), /^13 slots \(estimated: 13 for 18 cores at 1\.3 a busy device, 18 for 36 GiB at 1\.5 GiB a device after 8 GiB for the Mac, 14 for the video encoder \(an Apple M5 Max, about 375 /);
});

test("a Mac's own value wins over the backend's setting, which wins over the estimate, size by size, and a host's memory set lower takes slots away (F-9 item 7)", () => {
  const both = sizeHost(M4_MAX, { most: 6 }, { most: 7, cores: 10 }, DEFAULTS, 112);
  assert.deepEqual([both.most, both.cores], [{ value: 6, from: "set for this Mac" }, { value: 10, from: "the backend's setting" }]);
  assert.deepEqual(both.memoryGiB, { value: 17, from: "estimated: 8 GiB for the host and 1.5 GiB for each of its 6 slots" });
  const memory = sizeHost(M4_MAX, {}, { memoryGiB: 16 }, DEFAULTS, 112);
  assert.deepEqual([memory.most.value, memory.memoryGiB], [5, { value: 16, from: "the backend's setting" }]);
  const short = sizeHost(M4_MAX, {}, {}, DEFAULTS, 14);
  assert.deepEqual([short.most.value, short.memoryGiB.value], [4, 14]);
  const silent = sizeHost({ name: "mac-2", cores: null, performanceCores: null, memoryGiB: null, chip: null }, {}, {}, DEFAULTS, null);
  assert.deepEqual([silent.cores, silent.most.value], [{ value: 8, from: "mac-2 did not say its cores, so the default" }, 6]);
  assert.deepEqual(sizeMacSlots(POOL_MAC, 4, 9, 12).most, { value: 4, from: "set for this Mac" });
  assert.deepEqual(sizeMacSlots(POOL_MAC, undefined, 9, 12).most, { value: 9, from: "the backend's setting" });
  assert.deepEqual(sizeMacSlots({ ...POOL_MAC, cores: null, memoryGiB: null }, undefined, undefined, 12).most, { value: 12, from: "pool-mac did not say its cores or memory yet, so the default" });
});

test("a Tart Mac takes its own slots, cores and memory for shared hosts, a backend's sizes count only where set, and the pool's line takes ios:<slots> (F-9 item 7)", () => {
  const part = (fields: Record<string, number | undefined>, hostFields: Record<string, string | number | undefined> = {}) =>
    parseTartPart({
      id: "tart",
      fields: { "ios-image": "bb-box-ios", "ios-hosts-on": true, ...fields },
      hosts: [{ name: "mac-1", fields: { address: "192.0.2.20", user: "admin", "host-keys": "192.0.2.20 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne", ...hostFields } }],
    });
  const unset = part({});
  assert.ok(unset.ok);
  assert.deepEqual([unset.config.iosHosts.sizedBy, unset.config.hosts[0]!.iosHostsSizedBy], [{}, undefined]);
  const set = part({ "ios-hosts-cores": 10 }, { "ios-hosts-most": 6, "ios-hosts-memory-gib": "20" });
  assert.ok(set.ok);
  assert.deepEqual([set.config.iosHosts.sizedBy, set.config.hosts[0]!.iosHostsSizedBy], [{ cores: 10 }, { most: 6, memoryGiB: 20 }]);
  const bad = part({}, { "ios-hosts-most": 0 });
  assert.ok(!bad.ok);
  assert.deepEqual(bad.problems, [{ path: "hosts.0.ios-hosts-most", message: "Mac mac-1: the slots of a shared iOS host on it must be a whole number from 1 to 64, or empty for BB Box's estimate." }]);

  const pool = (line: string, most?: number) => parseSshPoolSettings({ "ssh-pool-enabled": true, "ssh-pool-machines": line, "ssh-pool-known-hosts": "192.0.2.30 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOne", ...(most !== undefined ? { "ssh-pool-ios-hosts-most": most } : {}) });
  const lined = pool("mac-1 bbbox-admin@192.0.2.30 macos,ios:7", 9);
  assert.ok(lined.enabled && lined.ok, JSON.stringify(lined));
  assert.deepEqual([lined.config.machines[0]!.kinds, lined.config.machines[0]!.slotsMost, lined.config.slots.mostSet], [["macos", "ios"], 7, 9]);
  const plain = pool("mac-1 bbbox-admin@192.0.2.30 macos,ios");
  assert.ok(plain.enabled && plain.ok);
  assert.deepEqual([plain.config.machines[0]!.slotsMost, plain.config.slots.mostSet], [undefined, undefined]);
  const wrong = pool("mac-1 bbbox-admin@192.0.2.30 macos,ios:many");
  assert.ok(wrong.enabled && !wrong.ok);
  assert.match(JSON.stringify(wrong.problems), /Give machine mac-1's iOS slots as ios:<slots>, a whole number from 1 to 64, or ios for BB Box's estimate\./);
});

test("a Mac with no hardware encoder is sized by the cores its software video takes (065)", () => {
  assert.equal(slotsTheCpuAllows(6), 7);
  assert.equal(slotsTheCpuAllows(1), 1);
  const sized = sizeMacSlots({ name: "ns", cores: 6, performanceCores: null, memoryGiB: 14, chip: "Apple M4 Pro (Virtual)", hardware: false }, undefined, undefined, 3);
  assert.equal(sized.most.value, 4);
  assert.match(sized.most.from, /7 for video in software, as it has no hardware H\.264 encoder \(each slot a stream at a half at 60 a second, about 0\.21 of a core, within a quarter of its 6 cores\)/);
  const withEncoder = sizeMacSlots({ name: "ns", cores: 6, performanceCores: null, memoryGiB: 14, chip: "Apple M5 Max", hardware: true }, undefined, undefined, 3);
  assert.match(withEncoder.most.from, /for the video encoder \(an Apple M5 Max/);
});
