import type { DeviceHost, HostState, Placement, PoolMacState, Slot, SlotName, SlotState, SlotTier } from "../src/core/device-host.ts";

const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27A266a", companion: "1.7.7" } as const;
const settings = { most: 8, ahead: 1, resettingMost: 4 };
const common = { id: "bb-box-host-1", runtime, cores: 8, memoryGiB: 32, settings };
const device = { model: "iPhone 18 Pro", udid: "0F5B" } as const;

export const legal = {
  poolMac: { ...common, on: "pool-mac", machine: "mac1", state: { is: "slots" } } satisfies DeviceHost,
  tartStarting: { ...common, on: "tart", mac: "mac1", vm: "bb-box-host-1", state: { is: "starting", promised: ["bx1", "bx2"], since: 0 } } satisfies DeviceHost,
  namespace: { ...common, on: "namespace", backend: "namespace:team-b", instance: "ns-1", endsAt: 0, state: { is: "draining", why: "ending", lends: false, since: 0 } } satisfies DeviceHost,
  failed: { is: "failed", error: { code: "no-slot-made", words: "three slots failed" }, since: 0 } satisfies HostState,
  whole: { is: "whole", box: "bx1" } satisfies PoolMacState,
  carried: { carried: true, generation: 2 } satisfies SlotName,
  made: { carried: false, generation: 4711 } satisfies SlotName,
  making: { host: "h", carried: false, generation: 3, state: { is: "making", step: "first-boot", for: "bx1", since: 0 } } satisfies Slot,
  heldIos: { is: "held", box: "bx1", for: "ios", device, since: 0 } satisfies SlotState,
  heldMacos: { is: "held", box: "bx1", for: "macos", since: 0 } satisfies SlotState,
  vm: { on: "vm" } satisfies Placement,
  slot: { on: "slot", host: "h", hostOn: "tart", carried: false, generation: 9, place: 2, most: 8 } satisfies Placement,
  newHost: { tier: "new-host", where: "mac1", waitMs: 55_000, cost: "vm-slot" } satisfies SlotTier,
};

export const illegal = {
  // @ts-expect-error
  poolMacStarting: { ...common, on: "pool-mac", machine: "mac1", state: { is: "starting", promised: [], since: 0 } } satisfies DeviceHost,
  // @ts-expect-error
  poolMacDeleting: { ...common, on: "pool-mac", machine: "mac1", state: { is: "deleting", since: 0 } } satisfies DeviceHost,
  // @ts-expect-error
  tartLentWhole: { ...common, on: "tart", mac: "mac1", vm: "v", state: { is: "whole", box: "bx1" } } satisfies DeviceHost,
  // @ts-expect-error
  tartWithAnEnd: { ...common, on: "tart", mac: "mac1", vm: "v", endsAt: 0, state: { is: "serving" } } satisfies DeviceHost,
  // @ts-expect-error
  namespaceWithNoEnd: { ...common, on: "namespace", backend: "namespace", instance: "ns-1", state: { is: "serving" } } satisfies DeviceHost,
  // @ts-expect-error
  namespaceWithNoBackend: { ...common, on: "namespace", instance: "ns-1", endsAt: 0, state: { is: "serving" } } satisfies DeviceHost,
  // @ts-expect-error
  startingWithNoPromise: { is: "starting", since: 0 } satisfies HostState,
  // @ts-expect-error
  failedWithOtherCode: { is: "failed", error: { code: "tired", words: "" }, since: 0 } satisfies HostState,
  // @ts-expect-error
  carriedThird: { carried: true, generation: 3 } satisfies SlotName,
  // @ts-expect-error
  slotWithItsUser: { host: "h", carried: false, generation: 7, user: "bbd-7", uid: 80009, state: { is: "resetting", step: "sweep", since: 0 } } satisfies Slot,
  // @ts-expect-error
  makingForNobodySaid: { is: "making", step: "user", since: 0 } satisfies SlotState,
  // @ts-expect-error
  heldIosWithNoDevice: { is: "held", box: "bx1", for: "ios", since: 0 } satisfies SlotState,
  // @ts-expect-error
  heldMacosWithADevice: { is: "held", box: "bx1", for: "macos", device, since: 0 } satisfies SlotState,
  // @ts-expect-error
  heldForLinux: { is: "held", box: "bx1", for: "linux", since: 0 } satisfies SlotState,
  // @ts-expect-error
  readyWithNoDevice: { is: "ready", booted: true } satisfies SlotState,
  // @ts-expect-error
  androidInASlot: { is: "ready", device: { model: "Pixel 8", udid: "x" }, booted: true } satisfies SlotState,
  // @ts-expect-error
  vmOnAHost: { on: "vm", host: "h" } satisfies Placement,
  // @ts-expect-error
  slotWithNoHost: { on: "slot", hostOn: "tart", carried: false, generation: 9, place: 2, most: 8 } satisfies Placement,
  // @ts-expect-error
  slotCarriedThird: { on: "slot", host: "h", hostOn: "tart", carried: true, generation: 3, place: 1, most: 8 } satisfies Placement,
  // @ts-expect-error
  readyTierWithNoHost: { tier: "ready", waitMs: 0 } satisfies SlotTier,
  // @ts-expect-error
  newHostOtherCost: { tier: "new-host", where: "mac1", waitMs: 0, cost: "free" } satisfies SlotTier,
};
