// The doctor's check that a host holds the kinds it offers at their sizes (#74).

import assert from "node:assert/strict";
import test from "node:test";
import { sizesCheck, type KindRoom } from "../src/backends/fit.ts";
import type { MachineSize, KindSettings } from "../src/backends/types.ts";
import { shippedKind } from "./helpers.ts";

const size = (cores: number, memoryGiB: number): MachineSize => ({ cores, memoryMiB: memoryGiB * 1024, diskGiB: null });

function room(kinds: readonly KindRoom[], keepsMiB = 0) {
  return sizesCheck({ id: "host.sizes", name: "Box sizes", host: "mini", has: "4 cores and 8 GiB memory", keepsMiB, kinds });
}

test("a host that holds each kind at its default size passes, and one with no kind on has no check", () => {
  const largest = size(16, 60);
  const check = room([
    { kind: "linux", settings: shippedKind("linux"), largest },
    { kind: "linux-desktop", settings: shippedKind("linux-desktop"), largest },
    { kind: "macos", settings: { ...shippedKind("macos"), enabled: false }, largest: size(1, 1) },
  ]);
  assert.deepEqual(check, { id: "host.sizes", name: "Box sizes", status: "ok", detail: "mini holds linux and linux-desktop boxes at the default sizes.", fix: null });
  assert.equal(room([{ kind: "linux", settings: { ...shippedKind("linux"), enabled: false }, largest: size(1, 1) }]), null);
  assert.equal(room([]), null);
});

test("a host too small for a kind's default size warns and names the presets it holds, or that it holds none", () => {
  const linux = shippedKind("linux");
  const medium: KindSettings = { ...linux, defaultSize: linux.presets[1]! };
  const check = room([
    { kind: "linux", settings: medium, largest: size(4, 6) },
    { kind: "linux-desktop", settings: shippedKind("linux-desktop"), largest: size(2, 6) },
  ]);
  assert.equal(check?.status, "warn");
  assert.equal(
    check?.detail,
    "mini has 4 cores and 8 GiB memory. " +
      "It cannot hold a linux box at its default size, 4 cores, 8 GiB memory, only at 2 cores, 4 GiB memory. " +
      "It cannot hold a linux-desktop box at any of its presets, the smallest 4 cores, 8 GiB memory.",
  );
  assert.equal(check?.fix, "Give mini more cores and memory, or make the presets of linux and linux-desktop smaller in BB Box's settings, under Kinds.");
});

test("the memory a host keeps free counts, and the fix says it may be lowered", () => {
  const check = room([{ kind: "linux", settings: shippedKind("linux"), largest: size(4, 2) }], 6144);
  assert.equal(check?.detail, "mini has 4 cores and 8 GiB memory, and keeps 6 GiB free. It cannot hold a linux box at any of its presets, the smallest 2 cores, 4 GiB memory.");
  assert.equal(check?.fix, "Give mini more memory, lower the memory kept free, or make the presets of linux smaller in BB Box's settings, under Kinds.");
  // Kept memory is no fix when only cores bind.
  assert.match(room([{ kind: "linux", settings: shippedKind("linux"), largest: size(1, 60) }], 6144)!.fix!, /^Give mini more cores, or make/);
});
