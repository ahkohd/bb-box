import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TartBackend } from "../src/backends/tart/backend.ts";
import { HOST_VM_PREFIX, slotRefOf } from "../src/backends/tart/ios-hosts.ts";
import { setupDir } from "../src/backends/setup-dir.ts";
import type { AcquireHooks, BoxIdentity, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { placementOf, type SlotTier } from "../src/core/device-host.ts";
import { tartConfig } from "./fake-mac.ts";
import { IOS_HOST_FAKES, IOS_HOST_SETTINGS, fakeIosHostMac } from "./fake-ios-host.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

const signal = () => AbortSignal.timeout(60_000);
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

const made: TartBackend[] = [];
afterEach(async () => {
  for (const backend of made.splice(0)) await backend.dispose();
});

function setup(values: Record<string, unknown> = {}) {
  const world = fakeIosHostMac();
  const context = testContext(new MemoryStorage());
  const backend = new TartBackend(tartConfig({ ...IOS_HOST_SETTINGS, ...values }), context, IOS_HOST_FAKES);
  made.push(backend);
  return { ...world, context, backend };
}

let counter = 0;
function identity(): BoxIdentity {
  counter++;
  return { boxId: `bxios${counter}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind: "ios", createdAt: 1_790_000_000_000, size: { cores: 6, memoryMiB: 16384, diskGiB: null } };
}

function hooks(): { hooks: AcquireHooks; claimed: Guest[]; timings: Record<string, number> } {
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  return {
    hooks: { claim: async (guest) => void claimed.push(guest), starting: async () => {}, timing: (step, ms) => void (timings[step] = ms) },
    claimed,
    timings,
  };
}

async function place(backend: TartBackend, box: BoxIdentity): Promise<{ tier: SlotTier; guest: Guest }> {
  const tier = await backend.slots!.offer("ios", null, signal());
  const taken = await backend.slots!.take(tier, box, signal());
  assert.ok(!("lost" in taken), `taken: ${JSON.stringify(taken)}`);
  return { tier, guest: taken };
}

test("shared iOS hosts are off unless set on, and need the iOS image (064)", () => {
  assert.equal(tartConfig().iosHosts.on, false);
  assert.equal(new TartBackend(tartConfig(), testContext(), IOS_HOST_FAKES).slots, undefined);
  const off = new TartBackend(tartConfig({ "tart-ios-image": "bb-box-ios" }), testContext(), IOS_HOST_FAKES);
  assert.equal(off.slots?.lends("ios"), false);
  const on = tartConfig(IOS_HOST_SETTINGS);
  assert.deepEqual(on.iosHosts, { on: true, most: 4, ahead: 0, resettingMost: 4, cores: 8, memoryGiB: 32, perMac: 1, diskReserveGiB: 10 });
  assert.equal(new TartBackend(on, testContext(), IOS_HOST_FAKES).slots?.lends("macos"), true, "macos boxes asked for with shared take slots too (unit 8)");
  assert.equal(off.slots?.lends("macos"), false);
});

test("three ios boxes acquired at once make one host, not three: the first starts it, the next two join it while it starts; each gets a slot of its own (064)", async () => {
  const { backend, hosts, clones, ssh } = setup();
  const boxes = [identity(), identity(), identity()];
  const placed: { tier: SlotTier; guest: Guest }[] = [];
  for (const box of boxes) placed.push(await place(backend, box));
  assert.deepEqual(
    placed.map(({ tier }) => tier.tier),
    ["new-host", "join", "join"],
  );
  assert.equal(new Set(placed.map(({ guest }) => slotRefOf(guest)?.vm)).size, 1, "one host for all three");
  const results = await Promise.all(boxes.map((box, n) => backend.acquire(box, placed[n]!.guest, hooks().hooks, signal())));
  assert.equal(clones().length, 1, "one clone of the iOS image");
  assert.equal(hosts().length, 1);
  const slots = results.map((guest) => placementOf({ guest }));
  assert.deepEqual(slots.map((slot) => (slot.on === "slot" ? `${slot.carried ? "i" : ""}${slot.generation}` : "vm")).sort(), ["1", "i1", "i2"]);
  assert.equal(new Set(results.map((guest) => guest.ref)).size, 3);
  assert.ok(results.every((guest) => guest.address === "192.168.64.2"));
  assert.equal(readFileSync(join(ssh.home("192.168.64.2"), "installed-helper"), "utf8"), readFileSync(join(setupDir(), "tart/ios/device-host.sh"), "utf8"), "the host runs this bb-box's helper");
  assert.match(readFileSync(join(ssh.home("192.168.64.2"), "helper.log"), "utf8"), /^init\n/);
  const targets = ssh.log().map((entry) => entry.target);
  for (const user of ["bbd-i1", "bbd-i2", "bbd-1"]) assert.ok(targets.includes(`${user}@192.168.64.2`), `bb-box reached ${user} as itself`);
});

test("a box on a serving host claims a ready slot in its take; releases leave the host for the others, and the last deletes it and frees the Mac's VM slot (064)", async () => {
  const { backend, hosts, mac, device } = setup();
  const first = identity();
  const { guest } = await place(backend, first);
  const one = await backend.acquire(first, guest, hooks().hooks, signal());
  const second = identity();
  const { tier, guest: ready } = await place(backend, second);
  assert.equal(tier.tier, "ready");
  assert.equal(placementOf({ guest: ready }).on, "slot", "the claim is the take");
  const two = await backend.acquire(second, ready, hooks().hooks, signal());
  assert.notEqual(one.ref, two.ref);
  assert.deepEqual(await backend.power(one), "running");

  const held = await backend.held(signal());
  assert.deepEqual(
    held.filter((each) => slotRefOf(each)).map((each) => each.owner?.boxId).sort(),
    [first.boxId, second.boxId],
  );
  assert.ok(!held.some((each) => each.ref.startsWith(HOST_VM_PREFIX) && !slotRefOf(each)), "the host's VM is no box's");

  await backend.release(one, releasing, signal());
  assert.equal(hosts().length, 1, "the other box keeps the host");
  assert.notEqual(device.slot(slotRefOf(one)!.slot!)?.is, "held", "its slot is released");
  await backend.release(two, releasing, signal());
  assert.deepEqual(hosts(), [], "the last release deletes the host");
  assert.equal(readdirSync(join(mac, ".bb-box", "tart", "owners")).filter((vm) => vm.startsWith(HOST_VM_PREFIX)).length, 0);
  assert.equal(await backend.power(two), null);
});

test("a full host and a Mac with no room for another: the box waits with words; a size of slots refused across Macs (064)", async () => {
  const { backend } = setup({ "tart-ios-hosts-most": 2 });
  for (const box of [identity(), identity()]) {
    const { guest } = await place(backend, box);
    await backend.acquire(box, guest, hooks().hooks, signal());
  }
  const tier = await backend.slots!.offer("ios", null, signal());
  assert.equal(tier.tier, "wait");
  assert.match(tier.tier === "wait" ? tier.words : "", /has all its 2 slots making, ready, held or promised \(2 held\)\./);
  assert.match(tier.tier === "wait" ? tier.words : "", /No shared iOS host can start on mac1: mac1 runs a shared iOS host already, as many as it may \(1\)\./);
  const other = await backend.slots!.offer("ios", "iPhone 17", signal());
  assert.deepEqual(other, { tier: "wait", words: "A shared ios box has the iPhone 18 Pro, the model every slot is made with. Leave device out for it, or ask for dedicated: true for the iPhone 17." });
});

test("a take that loses its race answers lost, and a box's release before its slot gives its promise back (064)", async () => {
  const { backend, hosts } = setup();
  const first = identity();
  const { guest } = await place(backend, first);
  const one = await backend.acquire(first, guest, hooks().hooks, signal());
  const second = identity();
  const offered = await backend.slots!.offer("ios", null, signal());
  assert.equal(offered.tier, "ready");
  const thief = identity();
  await place(backend, thief);
  const lost = await backend.slots!.take(offered, second, signal());
  assert.ok("lost" in lost, "the ready slot went to another box first");
  const promised = await backend.slots!.take({ tier: "make", host: slotRefOf(one)!.vm, waitMs: 1 }, second, signal());
  assert.ok(!("lost" in promised));
  await backend.release(promised, releasing, signal());
  assert.equal(hosts().length, 1, "two boxes still hold the host");
});

test("a slot box's transports reach it as its slot's user, with the host keeping BB's daemon; its device server is started again through the helper (064)", async () => {
  const { backend, ssh } = setup();
  const box = identity();
  const { guest } = await place(backend, box);
  const slot = await backend.acquire(box, guest, hooks().hooks, signal());
  const transports = await backend.transports(slot, "ios");
  assert.equal(transports.access?.ssh?.user, "bbd-i1");
  assert.deepEqual(transports.displays, []);
  assert.deepEqual(transports.daemonKeptByHost?.installerEnvironment, { BB_INSTALL_SKIP_SERVICE: "1" });
  await backend.restartDeviceServer(slot, signal());
  assert.match(readFileSync(join(ssh.home("192.168.64.2"), "helper.log"), "utf8"), /^restart i1$/m);
  await assert.rejects(backend.stop(slot, signal()), /cannot be stopped on its own/);
});

test("the upkeep deletes a host that holds no box, and the doctor lists each host's slots (064)", async () => {
  const { backend, hosts } = setup();
  const box = identity();
  const { guest } = await place(backend, box);
  const slot = await backend.acquire(box, guest, hooks().hooks, signal());
  const doctor = await backend.doctor(signal());
  const check = doctor.checks.find((each) => each.id === "ios-hosts.mac1");
  assert.match(check?.detail ?? "", /^bb-box-host-[0-9a-f]+: 1 held, 1 ready, 0 making, 0 sweeping, of 4;/);
  assert.match(check?.detail ?? "", /slot i1 \(box bxios\d+\): /);
  await backend.maintain(signal());
  assert.equal(hosts().length, 1, "a host with a box stays");
  await backend.release(slot, releasing, signal());
  assert.deepEqual(hosts(), []);
});

test("a host whose last release is deleting it gives its VM slot to a new host at once, so a claim that lost the race is placed again (064)", async () => {
  const { backend, device } = setup({ "tart-vms-per-host": 1 });
  const box = identity();
  const { guest } = await place(backend, box);
  await backend.acquire(box, guest, hooks().hooks, signal());
  const full = await backend.slots!.offer("ios", null, signal());
  assert.equal(full.tier, "ready");
  writeFileSync(join(device.root, "var/db/bb-box/host/deleting"), `since=${Math.floor(Date.now() / 1000)}\nslot=i1\nbox=${box.boxId}\n`);
  const after = await backend.slots!.offer("ios", null, signal());
  assert.deepEqual(after, { tier: "new-host", where: "mac1", waitMs: 55_000, cost: "vm-slot" }, "the deleting host's VM counts as leaving the Mac");
});

test("a new host whose Mac has no VM slot free when it starts waits for one, and its box is placed once it frees (064)", async () => {
  const { backend, mac, context } = setup();
  const box = identity();
  const { guest } = await place(backend, box);
  writeFileSync(join(mac, ".fake-other-macos-vms"), "2");
  setTimeout(() => writeFileSync(join(mac, ".fake-other-macos-vms"), "0"), 1500);
  const placed = await backend.acquire(box, guest, hooks().hooks, signal());
  assert.equal(placementOf({ guest: placed }).on, "slot");
  assert.ok(context.logs.some((line) => /waits for room on mac1/.test(line)), context.logs.join("\n"));
});

test("the upkeep finishes a host its helper marked deleting long ago, as when the release that marked it died, but leaves one a release is still stopping (064)", async () => {
  const { backend, device, hosts } = setup();
  const box = identity();
  const { guest } = await place(backend, box);
  await backend.acquire(box, guest, hooks().hooks, signal());
  const marked = (secondsAgo: number) => writeFileSync(join(device.root, "var/db/bb-box/host/deleting"), `since=${Math.floor(Date.now() / 1000) - secondsAgo}\nslot=i1\nbox=${box.boxId}\n`);
  marked(5);
  await backend.maintain(signal());
  assert.equal(hosts().length, 1, "a release marked it a moment ago and deletes it itself");
  marked(600);
  await backend.maintain(signal());
  assert.deepEqual(hosts(), [], "marked 10 minutes ago, with no release running here");
});

async function until(met: () => boolean, words: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!met()) {
    if (Date.now() > deadline) assert.fail(`never: ${words}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("another instance of the same install never vacates a host this one is starting, nor one serving whose boxes' promises its helper has not taken yet, as during a reload (F-7)", async () => {
  const { backend, hosts, ssh, mac } = setup();
  const other = new TartBackend(tartConfig(IOS_HOST_SETTINGS), testContext(new MemoryStorage()), IOS_HOST_FAKES);
  made.push(other);
  const box = identity();
  const { guest } = await place(backend, box);
  const vm = slotRefOf(guest)!.vm;
  const owner = () => readFileSync(join(mac, ".bb-box", "tart", "owners", vm), "utf8");
  const hold = join(ssh.home("192.168.64.2"), "hold-promise");
  writeFileSync(hold, "");
  const acquired = backend.acquire(box, guest, hooks().hooks, signal());
  await other.maintain(signal());
  assert.equal(hosts().length, 1, "a starting host stays");
  await until(() => /^host-state=serving$/m.test(owner()) && existsSync(join(ssh.home("192.168.64.2"), "promise-held")), "the host serves and gives its helper the box's promise");
  await other.maintain(signal());
  assert.equal(hosts().length, 1, "a serving host whose helper has not taken its box's promise yet stays");
  rmSync(hold);
  const slot = await acquired;
  assert.equal(placementOf({ guest: slot }).on, "slot");
  await other.maintain(signal());
  assert.equal(hosts().length, 1, "a host holding a box stays");
  await backend.release(slot, releasing, signal());
  assert.deepEqual(hosts(), []);
});
