import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { HOST_VM_PREFIX, slotRefOf } from "../src/backends/tart/ios-hosts.ts";
import { hostAppInstallScript } from "../src/backends/tart/device-host.ts";
import { setupDir } from "../src/backends/setup-dir.ts";
import type { AcquireHooks, BoxIdentity, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { placementOf, type SlotTier } from "../src/core/device-host.ts";
import { FAKE_MAC, addImage, addVmFiles, fakeIosProbe, runVmElsewhere, fakeMacTools, imageRecord, tartConfig } from "./fake-mac.ts";
import { IOS_HOST_DEVICES, IOS_HOST_FAKES, IOS_HOST_SETTINGS, IOS_IMAGE_BUILD, fakeIosHostMac } from "./fake-ios-host.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

const signal = () => AbortSignal.timeout(60_000);
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };

const made: TartBackend[] = [];
afterEach(async () => {
  for (const backend of made.splice(0)) await backend.dispose();
});

function setup(values: Record<string, unknown> = {}, options: TartBackendOptions = {}) {
  const world = fakeIosHostMac();
  const context = testContext(new MemoryStorage());
  const backend = new TartBackend(tartConfig({ ...IOS_HOST_SETTINGS, ...values }), context, { ...IOS_HOST_FAKES, ...options });
  made.push(backend);
  return { ...world, context, backend };
}

let counter = 0;
function identity(): BoxIdentity {
  counter++;
  return { boxId: `bxios${counter}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind: "ios", createdAt: 1_790_000_000_000, size: { cores: 6, memoryMiB: 16384, diskGiB: null, gpu: "none" } };
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
  assert.deepEqual(on.iosHosts, { on: true, most: 4, ahead: 0, resettingMost: 4, cores: 8, memoryGiB: 32, perMac: 1, diskReserveGiB: 10, sizedBy: { most: 4 } });
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
  assert.equal(readFileSync(join(ssh.home("192.168.64.2"), "installed-helper"), "utf8"), readFileSync(join(setupDir(), "tart/ios/device-host.sh"), "utf8"), "the host runs this BB Box's helper");
  assert.match(readFileSync(join(ssh.home("192.168.64.2"), "helper.log"), "utf8"), /^init\n/);
  const targets = ssh.log().map((entry) => entry.target);
  for (const user of ["bbd-i1", "bbd-i2", "bbd-1"]) assert.ok(targets.includes(`${user}@192.168.64.2`), `BB Box reached ${user} as itself`);
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

test("a slot acquire that fails after its slot is claimed gives the slot back, as the registry expects of a backend (F-8)", async () => {
  const { backend, device } = setup();
  for (const box of [identity(), identity()]) {
    const { guest } = await place(backend, box);
    await backend.acquire(box, guest, hooks().hooks, signal());
  }
  const box = identity();
  const { tier, guest } = await place(backend, box);
  assert.equal(tier.tier, "make");
  const failing: AcquireHooks = { ...hooks().hooks, claim: async () => { throw new Error("the box's record could not be written"); } };
  await assert.rejects(backend.acquire(box, guest, failing, signal()), /could not be written/);
  assert.ok(!device.status().slots.some((slot) => slot.box === box.boxId), "no slot is held for the box");
  assert.ok(!device.status().lines.some((line) => line.startsWith(`promise=${box.boxId}\t`)), "nor a promise");
  const again = identity();
  const { guest: next } = await place(backend, again);
  assert.equal(placementOf({ guest: await backend.acquire(again, next, hooks().hooks, signal()) }).on, "slot", "the next box gets a slot");
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
  assert.equal(transports.daemonKeptByHost?.daemonPort, 38900, "each slot's BB daemon has its own port, from its place on the host");
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

test("the doctor bounds each shared host's check, and says what it waited on for a host that does not answer (F-7)", async () => {
  const { backend, ssh } = setup({}, { iosHostDoctorMs: 1_000 });
  const box = identity();
  const { guest } = await place(backend, box);
  const slot = await backend.acquire(box, guest, hooks().hooks, signal());
  const hold = join(ssh.home("192.168.64.2"), "hold-status");
  writeFileSync(hold, "");
  try {
    const began = Date.now();
    const doctor = await backend.doctor(signal());
    assert.ok(Date.now() - began < 10_000, `${Date.now() - began} ms`);
    const check = doctor.checks.find((each) => each.id === "ios-hosts.mac1");
    assert.equal(check?.status, "warn");
    assert.match(check?.detail ?? "", /^The shared iOS host bb-box-host-[0-9a-f]+ on mac1 did not answer within 1 s: BB Box waited on its helper's status over SSH at 192\.168\.64\.2, through mac1\. A new host here has 4 slots \(the backend's setting\), 12 cores \(estimated: mac1's performance cores\), 14 GiB \(estimated: 8 GiB for the host and 1\.5 GiB for each of its 4 slots\)\.$/);
  } finally {
    rmSync(hold);
  }
  await backend.release(slot, releasing, signal());
});

test("a box waiting for a host that one instance was starting as it stopped, as at a reload, is placed on that host by the next instance, which carries the start on; the stopped instance neither fails nor deletes the host (F-7)", async () => {
  const { backend, hosts, clones, ssh, mac } = setup();
  const box = identity();
  const { guest } = await place(backend, box);
  const vm = slotRefOf(guest)!.vm;
  const hold = join(ssh.home("192.168.64.2"), "hold-init");
  writeFileSync(hold, "");
  const first = backend.acquire(box, guest, hooks().hooks, AbortSignal.timeout(60_000)).catch((error: unknown) => error);
  await until(() => existsSync(join(ssh.home("192.168.64.2"), "init-held")), "the host's start reaches its helper's init");
  await backend.dispose();
  rmSync(hold);
  await first;
  assert.doesNotMatch(readFileSync(join(mac, ".bb-box", "tart", "owners", vm), "utf8"), /^host-state=failed$/m, "the stopped instance did not fail the host");
  assert.equal(hosts().length, 1, "nor delete it");
  const next = new TartBackend(tartConfig(IOS_HOST_SETTINGS), testContext(new MemoryStorage()), IOS_HOST_FAKES);
  made.push(next);
  const slot = await next.acquire(box, guest, hooks().hooks, signal());
  assert.equal(placementOf({ guest: slot }).on, "slot");
  assert.equal(slotRefOf(slot)!.vm, vm);
  assert.equal(clones().length, 1, "one host");
  await next.release(slot, releasing, signal());
  assert.deepEqual(hosts(), []);
});

test("a host's start names its BB Box instance and when it last said so in the host's owner file, so another instance never runs a start that is still under way, however old (F-8)", async () => {
  const { backend, hosts, clones, ssh, mac } = setup();
  const otherContext = testContext(new MemoryStorage());
  const other = new TartBackend(tartConfig(IOS_HOST_SETTINGS), otherContext, IOS_HOST_FAKES);
  made.push(other);
  const box = identity();
  const { guest } = await place(backend, box);
  const vm = slotRefOf(guest)!.vm;
  const ownerFile = join(mac, ".bb-box", "tart", "owners", vm);
  const hold = join(ssh.home("192.168.64.2"), "hold-init");
  writeFileSync(hold, "");
  const first = backend.acquire(box, guest, hooks().hooks, signal());
  await until(() => existsSync(join(ssh.home("192.168.64.2"), "init-held")), "the host's start reaches its helper's init");
  assert.match(readFileSync(ownerFile, "utf8"), /^start-by=[0-9a-f]{8}$/m);
  assert.match(readFileSync(ownerFile, "utf8"), /^start-beat=\d+$/m);
  writeFileSync(ownerFile, readFileSync(ownerFile, "utf8").replace(/^made=\d+$/m, `made=${Date.now() - 10 * 60_000}`));

  await other.maintain(signal());
  const second = identity();
  const joined = await other.slots!.take({ tier: "join", host: vm, waitMs: 1 }, second, signal());
  assert.ok(!("lost" in joined));
  const waiting = other.acquire(second, joined, hooks().hooks, signal());
  await until(() => otherContext.logs.some((line) => /is being started by another bb-box instance, [0-9a-f]{8}, which said so at \d+; this one waits for it/.test(line)), "the other instance waits for the start");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const inits = () => readFileSync(join(ssh.home("192.168.64.2"), "helper.log"), "utf8").split("\n").filter((line) => line === "init").length;
  const doctor = (await other.doctor(signal())).checks.find((check) => check.id === "ios-hosts.mac1");
  assert.match(doctor?.detail ?? "", /starting, made \d+ s ago, started by BB Box instance [0-9a-f]{8}, last heard from \d+ s ago, 2 boxes promised\./);

  rmSync(hold);
  const [one, two] = await Promise.all([first, waiting]);
  assert.equal(inits(), 1, "the start ran once, in the first instance");
  assert.equal(clones().length, 1, "one host");
  assert.doesNotMatch(readFileSync(ownerFile, "utf8"), /^start-(by|beat)=/m, "a serving host has no start");
  await backend.release(one, releasing, signal());
  await other.release(two, releasing, signal());
  assert.deepEqual(hosts(), []);
});

const TARBALL = "bb-app's tarball\n";
const TARBALL_DIGEST = createHash("sha256").update(TARBALL).digest("hex");

function appTools(home: string): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(home, "served.tgz"), TARBALL);
  writeFileSync(join(bin, "curl"), '#!/bin/sh\necho "curl $*" >> "$HOME/app-tools.log"\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && cp "$HOME/served.tgz" "$2"; shift; done\n', { mode: 0o755 });
  writeFileSync(
    join(bin, "npm"),
    `#!/bin/sh\necho "npm $*" >> "$HOME/app-tools.log"\nwhile [ $# -gt 0 ]; do [ "$1" = --prefix ] && prefix=$2; shift; done\nmkdir -p "$prefix/lib/node_modules/bb-app/bin" "$prefix/bin"\necho '{"name":"bb-app"}' > "$prefix/lib/node_modules/bb-app/package.json"\nln -s ../lib/node_modules/bb-app/bin/bb.js "$prefix/bin/bb"\n`,
    { mode: 0o755 },
  );
}

test("BB's app goes to the host's own user from BB's server, checked against the server's digest, and once installed is not fetched again (F-8)", () => {
  const home = mkdtempSync(join(tmpdir(), "host-app-"));
  appTools(home);
  const run = (digest: string) => spawnSync("/bin/sh", ["-c", hostAppInstallScript({ url: "https://bb.example.com/", digest })], { encoding: "utf8", env: { HOME: home, PATH: `${join(home, "bin")}:/usr/bin:/bin` } });
  const first = run(TARBALL_DIGEST);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, `installed=yes\nhome=${home}\n`);
  const data = join(home, ".bb-machines/bb.example.com");
  assert.equal(readFileSync(join(data, "host-artifact.sha256"), "utf8"), `${TARBALL_DIGEST}\n`);
  assert.equal(readlinkSync(join(data, "npm/bin/bb")), "../lib/node_modules/bb-app/bin/bb.js");
  assert.match(readFileSync(join(home, "app-tools.log"), "utf8"), /^curl .* https:\/\/bb\.example\.com\/install\/bb-app\.tgz\nnpm install -g .*--prefix .*\/npm\.new /);
  const again = run(TARBALL_DIGEST);
  assert.equal(again.stdout, `home=${home}\n`, "installed already");
  assert.equal(readFileSync(join(home, "app-tools.log"), "utf8").split("\n").filter((line) => line.startsWith("curl")).length, 1);
  const other = run("e".repeat(64));
  assert.equal(other.status, 4);
  assert.match(other.stderr, /BB's server gave an app that is not build e{64}/);
  assert.equal(readFileSync(join(data, "host-artifact.sha256"), "utf8"), `${TARBALL_DIGEST}\n`, "the build kept stays");
});

test("a host that serves keeps the server's build of BB's app for its slots: installed as the host's user, then copied by its helper into the slots' home (F-8)", async () => {
  const world = fakeIosHostMac();
  const context = { ...testContext(new MemoryStorage()), bbUrl: () => "https://bb.example.com", images: { pins: async () => null, bbApp: async () => TARBALL_DIGEST } };
  const backend = new TartBackend(tartConfig({ ...IOS_HOST_SETTINGS }), context, IOS_HOST_FAKES);
  made.push(backend);
  const vmHome = world.ssh.home("192.168.64.2");
  appTools(vmHome);
  mkdirSync(join(world.device.root, dirname(vmHome)), { recursive: true });
  symlinkSync(vmHome, join(world.device.root, vmHome));
  world.device.own(vmHome, 501);
  appendFileSync(join(world.device.state, "owners"), `501 ${realpathSync(vmHome)}/.bb-machines/bb.example.com/npm\n`);
  const box = identity();
  const { guest } = await place(backend, box);
  await backend.acquire(box, guest, hooks().hooks, signal());
  await until(() => context.logs.some((line) => /keeps BB's app build|keeps no BB app/.test(line)), "the host keeps BB's app");
  assert.ok(context.logs.some((line) => new RegExp(`keeps BB's app build ${TARBALL_DIGEST.slice(0, 12)} for its slots, in [\\d.]+ s \\(installed in [\\d.]+ s\\)`).test(line)), context.logs.join("\n"));
  assert.match(readFileSync(join(vmHome, "helper.log"), "utf8"), /^keep-app$/m);
  assert.equal(world.device.file("/usr/local/share/bb-box/slot-home/.bb-machines/bb.example.com/host-artifact.sha256"), `${TARBALL_DIGEST}\n`);
  assert.equal(world.device.status().values.get("bb-app-kept"), "yes");
  const doctor = (await backend.doctor(signal())).checks.find((check) => check.id === "ios-hosts.mac1");
  assert.match(doctor?.detail ?? "", new RegExp(`Its slots get BB's app build ${TARBALL_DIGEST.slice(0, 12)} from the host\\.`));
});

test("a new shared host goes to the Mac whose video encoder streams least; a VM's start warns that Mac's viewers; each box names its Mac and chip (064, unit 6)", async () => {
  const world = fakeIosHostMac();
  const other = "192.0.2.21";
  const second = world.ssh.home(other);
  fakeMacTools(second);
  addImage(second);
  addImage(second, "bb-box-ios");
  writeFileSync(join(second, ".bb-box", "tart", "images", "bb-box-ios.json"), `${imageRecord("ios", { build: IOS_IMAGE_BUILD, base: "build.20261003-021500", devices: IOS_HOST_DEVICES, tools: { idb_companion: "1.7.7" } })}\n`);
  writeFileSync(join(second, ".fake-chip"), "Apple M5 Max\n");
  const load = new Map([["mac1", 200], ["mac2", 10]]);
  const starting: string[] = [];
  const context = { ...testContext(new MemoryStorage()), encoder: { load: (mac: string) => load.get(mac) ?? 0, vmStarting: (mac: string, chip: string | null) => void starting.push(`${mac} ${chip}`) } };
  const backend = new TartBackend(
    tartConfig({ ...IOS_HOST_SETTINGS, "tart-hosts": `mac1 bbbox-admin@${FAKE_MAC}\nmac2 bbbox-admin@${other}`, "tart-host-keys": `${FAKE_MAC} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests\n${other} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests` }),
    context,
    IOS_HOST_FAKES,
  );
  made.push(backend);
  assert.deepEqual(await backend.slots!.offer("ios", null, signal()), { tier: "new-host", where: "mac2", waitMs: 55_000, cost: "vm-slot" });
  load.set("mac2", 300);
  const tier = await backend.slots!.offer("ios", null, signal());
  assert.deepEqual(tier, { tier: "new-host", where: "mac1", waitMs: 55_000, cost: "vm-slot" });
  const taken = await backend.slots!.take(tier, identity(), signal());
  assert.ok(!("lost" in taken));
  await until(() => starting.length > 0, "the host's VM to start");
  assert.deepEqual(starting, ["mac1 Apple M4 Max"]);
  assert.deepEqual(backend.encoderOf(taken), { mac: "mac1", chip: "Apple M4 Max", hardware: null, cores: null });
  assert.equal(backend.encoderOf({ ref: "elsewhere", host: "mac9", address: null, size: null, data: {} }), null);
});

test("BB Box stopping while a shared host starts closes every shared SSH connection it opened before it removes their folder (F-14)", async () => {
  const { backend, ssh, hosts } = setup();
  const tier = await backend.slots!.offer("ios", null, signal());
  const taking = backend.slots!.take(tier, identity(), signal()).catch(() => null);
  await until(() => hosts().length > 0, "the host's VM to be made");
  const from = ssh.log().length;
  made.splice(made.indexOf(backend), 1);
  await backend.dispose();
  const disposed = ssh.log().length;
  await taking;
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const log = ssh.log();
  const socketOf = (index: number) => log[index]!.args.find((arg) => arg.startsWith("ControlPath="));
  const closedBeforeItsFolderWent = (opened: number) => log.slice(opened + 1, disposed).some((entry, offset) => entry.control === "exit" && socketOf(opened + 1 + offset) === socketOf(opened));
  const left = log.map((entry, index) => ({ entry, index })).filter(({ entry, index }) => index >= from && entry.control === "master" && !closedBeforeItsFolderWent(index));
  assert.deepEqual(left, [], "each shared connection opened as it stopped was closed before its folder went");
});

function newIosBuild(mac: string): void {
  writeFileSync(join(mac, ".bb-box", "tart", "images", "bb-box-ios.json"), `${imageRecord("ios", { build: "build.20261028-002015-2222", base: "build.20261003-021500", devices: IOS_HOST_DEVICES, tools: { idb_companion: "1.7.7" } })}\n`);
}

async function anotherMacosVm(mac: string, name = "bb-box-dedicated"): Promise<void> {
  const vm = join(mac, ".tart", "vms", name);
  mkdirSync(vm, { recursive: true });
  writeFileSync(join(vm, "config.json"), JSON.stringify({ os: "darwin", memorySize: 16 * 1024 ** 3, cpuCount: 6 }));
  addVmFiles(vm);
  await runVmElsewhere(vm);
}

test("a host on an older build lends its ready slot while no host on the new build can start on its Mac, counting itself against the hosts each Mac may run, as a start does (F-9, H6)", async () => {
  const { backend, mac, clones } = setup();
  const first = identity();
  const { guest } = await place(backend, first);
  const one = await backend.acquire(first, guest, hooks().hooks, signal());
  newIosBuild(mac);
  const second = identity();
  const { tier } = await place(backend, second);
  assert.equal(tier.tier, "ready", "one host a Mac, so no host on the new build can start beside it");
  assert.equal(clones().length, 1);
  const doctor = (await backend.doctor(signal())).checks.find((check) => check.id === "ios-hosts.mac1");
  assert.match(doctor?.detail ?? "", /older than the iOS image's, so it lends only while no host on the new build can start\./);
  await backend.release(one, releasing, signal());
});

test("with two hosts a Mac, a host on an older build stops lending once a host on the new build can start, and lends again while the Mac's other VM slot is taken (F-9, H6)", async () => {
  const { backend, mac } = setup({ "tart-ios-hosts-per-mac": 2 });
  const first = identity();
  const { guest } = await place(backend, first);
  const one = await backend.acquire(first, guest, hooks().hooks, signal());
  newIosBuild(mac);
  const free = await backend.slots!.offer("ios", null, signal());
  assert.deepEqual(free, { tier: "new-host", where: "mac1", waitMs: 55_000, cost: "vm-slot" });
  await anotherMacosVm(mac);
  const full = await backend.slots!.offer("ios", null, signal());
  assert.equal(full.tier, "ready", "the Mac runs two macOS VMs, so no host on the new build can start");
  await backend.release(one, releasing, signal());
});

test("the box that started a shared host is served first, though the boxes that joined it reach its ready slots before it; a box that asks then comes after it (F-11)", async () => {
  const { backend } = setup();
  const boxes = [identity(), identity(), identity()];
  const placed: Guest[] = [];
  for (const box of boxes) placed.push((await place(backend, box)).guest);
  const [first, ...joined] = boxes as [BoxIdentity, BoxIdentity, BoxIdentity];
  const joiners = await Promise.all(joined.map((box, n) => backend.acquire(box, placed[n + 1]!, hooks().hooks, signal())));
  const slotOf = (guest: Guest) => {
    const slot = placementOf({ guest });
    return slot.on === "slot" ? `${slot.carried ? "i" : ""}${slot.generation}` : "vm";
  };
  assert.deepEqual(joiners.map(slotOf), ["i2", "1"], "the joiners leave the first carried slot to the first box, and the last makes one");
  const later = await backend.slots!.offer("ios", null, signal());
  assert.notEqual(later.tier, "ready", "a box asking now does not take the first box's slot");
  const one = await backend.acquire(first, placed[0]!, hooks().hooks, signal());
  assert.equal(slotOf(one), "i1");
  for (const slot of [one, ...joiners]) await backend.release(slot, releasing, signal());
});

test("a host whose VM fails to start starts once more on a fresh clone, still taking boxes meanwhile, and the doctor and log say why (F-9, H8)", async () => {
  const { backend, mac, clones, context, ssh } = setup();
  writeFileSync(join(mac, ".fake-tart-run-fails"), "2");
  const homes = ["192.168.64.2", "192.168.64.3"].map((address) => ssh.home(address));
  for (const home of homes) writeFileSync(join(home, "hold-init"), "");
  const first = identity();
  const { guest } = await place(backend, first);
  const vm = slotRefOf(guest)!.vm;
  const acquired = backend.acquire(first, guest, hooks().hooks, signal());
  await until(() => homes.some((home) => existsSync(join(home, "init-held"))), "the fresh clone's start reaches its helper's init");
  const second = identity();
  const { tier, guest: joined } = await place(backend, second);
  assert.deepEqual(tier.tier === "join" && tier.host, vm, "the host is still starting, so a box joins it");
  const doctor = (await backend.doctor(signal())).checks.find((check) => check.id === "ios-hosts.mac1");
  assert.match(doctor?.detail ?? "", /starting, made \d+ s ago, on a fresh clone as its first start failed \(Tart could not start bb-box-host-[0-9a-f]+ on mac1: Error Domain=VZErrorDomain Code=1 /);
  for (const home of homes) rmSync(join(home, "hold-init"));
  const slots = await Promise.all([acquired, backend.acquire(second, joined, hooks().hooks, signal())]);
  assert.ok(slots.every((slot) => placementOf({ guest: slot }).on === "slot" && slotRefOf(slot)!.vm === vm));
  assert.equal(clones().length, 2, "a fresh clone of the iOS image");
  assert.ok(context.logs.some((line) => line.startsWith(`Shared iOS host ${vm} on mac1 did not start, so bb-box deletes its VM and starts a fresh clone of the iOS image, once: Tart could not start`)), context.logs.join("\n"));
  for (const slot of slots) await backend.release(slot, releasing, signal());
});

test("a host whose VM stops after it answered on SSH, before it served, starts once more on a fresh clone too, and its words say the VM stopped (F-9b)", async () => {
  const { backend, mac, clones, context, ssh } = setup();
  const [first, fresh] = ["192.168.64.2", "192.168.64.3"].map((address) => ssh.home(address)) as [string, string];
  for (const home of [first, fresh]) writeFileSync(join(home, "hold-init"), "");
  writeFileSync(join(first, "lose-init"), "");
  const box = identity();
  const { guest } = await place(backend, box);
  const vm = slotRefOf(guest)!.vm;
  const acquired = backend.acquire(box, guest, hooks().hooks, signal());
  await until(() => existsSync(join(first, "init-held")), "the first clone's start reaches its helper's init");
  rmSync(join(mac, ".tart", "vms", vm, "running"));
  rmSync(join(first, "hold-init"));
  await until(() => existsSync(join(fresh, "init-held")), "the fresh clone's start reaches its helper's init");
  const second = identity();
  const { tier, guest: joined } = await place(backend, second);
  assert.deepEqual(tier.tier === "join" && tier.host, vm, "the host is still starting, so a box joins it");
  const doctor = (await backend.doctor(signal())).checks.find((check) => check.id === "ios-hosts.mac1");
  assert.match(doctor?.detail ?? "", /starting, made \d+ s ago, on a fresh clone as its first start failed \(Its VM stopped after it answered on SSH, before it served: Its helper's init failed: Connection to the VM closed by remote host\.\)/);
  rmSync(join(fresh, "hold-init"));
  const slots = await Promise.all([acquired, backend.acquire(second, joined, hooks().hooks, signal())]);
  assert.ok(slots.every((slot) => placementOf({ guest: slot }).on === "slot" && slotRefOf(slot)!.vm === vm));
  assert.equal(clones().length, 2, "a fresh clone of the iOS image");
  assert.ok(context.logs.some((line) => line.startsWith(`Shared iOS host ${vm} on mac1 did not start, so bb-box deletes its VM and starts a fresh clone of the iOS image, once: Its VM stopped after it answered on SSH`)), context.logs.join("\n"));
  for (const slot of slots) await backend.release(slot, releasing, signal());
});

test("a host whose VM stops before it answers on SSH is noticed within a poll, not at the start's deadline, and starts once more on a fresh clone (F-9b)", async () => {
  const { backend, mac, clones, context } = setup({}, { vmStoppedPollMs: 50 });
  const holds = join(mac, ".fake-tart-ip-holds");
  writeFileSync(holds, "");
  const box = identity();
  const { guest } = await place(backend, box);
  const vm = slotRefOf(guest)!.vm;
  const acquired = backend.acquire(box, guest, hooks().hooks, signal());
  await until(() => existsSync(join(mac, ".fake-tart-ip-held")), "the first clone's start waits for its address");
  rmSync(join(mac, ".tart", "vms", vm, "running"));
  const retried = `Shared iOS host ${vm} on mac1 did not start, so bb-box deletes its VM and starts a fresh clone of the iOS image, once: ${vm} on mac1 stopped before it answered on SSH: Tart lists it stopped.`;
  await until(() => context.logs.includes(retried), "the stop is noticed and a fresh clone started");
  assert.ok(context.logs.some((line) => new RegExp(`^${vm} on mac1 stopped before it answered on SSH: Tart lists it stopped\\. bb-box saw it \\d+\\.\\d s after the VM started, and stops waiting for it\\.$`).test(line)), context.logs.join("\n"));
  rmSync(holds);
  const slot = await acquired;
  assert.equal(slotRefOf(slot)!.vm, vm);
  assert.equal(clones().length, 2, "a fresh clone of the iOS image");
  await backend.release(slot, releasing, signal());
});

test("a host whose fresh clone fails to start too fails its boxes with both failures, and while its VM is deleted a new host can start in its place, rather than the Mac seeming full (F-9, H8)", async () => {
  const { backend, mac, hosts } = setup();
  await anotherMacosVm(mac);
  writeFileSync(join(mac, ".fake-tart-run-fails"), "4");
  const waits = join(mac, ".fake-tart-delete-waits");
  writeFileSync(waits, "1");
  const first = identity();
  const { guest } = await place(backend, first);
  const vm = slotRefOf(guest)!.vm;
  const acquired = backend.acquire(first, guest, hooks().hooks, signal()).catch((error: unknown) => error);
  const deleting = () => readFileSync(join(mac, ".fake-tart-log"), "utf8").split(JSON.stringify(["tart", "delete", vm])).length === 3;
  await until(() => /^host-state=failed$/m.test(readFileSync(join(mac, ".bb-box", "tart", "owners", vm), "utf8")) && deleting(), "the host fails and its VM is being deleted");
  const meanwhile = await backend.slots!.offer("ios", null, signal());
  assert.deepEqual(meanwhile, { tier: "new-host", where: "mac1", waitMs: 55_000, cost: "vm-slot" }, "the failed host's VM is leaving the Mac");
  rmSync(waits);
  const failed = await acquired;
  assert.ok(failed instanceof Error);
  assert.match(failed.message, /^The shared iOS host bb-box-host-[0-9a-f]+ on mac1 did not start: Tart could not start bb-box-host-[0-9a-f]+ on mac1: Error Domain=VZErrorDomain Code=1 .* That was a fresh clone's start; the first clone's failed too: Tart could not start .*VZErrorDomain Code=1 /s);
  assert.deepEqual(hosts(), []);
});

test("a new shared host is sized for its Mac where nothing is set: on the fake 16-core, 128 GiB M4 Max, 12 cores, 9 slots and 22 GiB; the Mac's own sizes win, and the doctor says where each came from (F-9 item 7)", async () => {
  const sizesOf = (mac: string, vm: string) => readFileSync(join(mac, ".bb-box", "tart", "owners", vm), "utf8").split("\n").filter((line) => /^(most|cores|memory-gib)=/.test(line)).sort();
  const estimated = setup({ "tart-ios-hosts-most": undefined });
  const first = identity();
  const { guest } = await place(estimated.backend, first);
  assert.deepEqual(sizesOf(estimated.mac, slotRefOf(guest)!.vm), ["cores=12", "memory-gib=22", "most=9"]);
  const check = (await estimated.backend.doctor(signal())).checks.find((each) => each.id === "ios-hosts.mac1");
  assert.match(check?.detail ?? "", / A new host here has 9 slots \(estimated: 9 for 12 cores at 1\.3 a busy device, 69 for the 112 GiB of mac1's memory a host may have, .*; the fewest\), 12 cores \(estimated: mac1's performance cores\), 22 GiB \(estimated: 8 GiB for the host and 1\.5 GiB for each of its 9 slots\)\.$/);
  await estimated.backend.release(await estimated.backend.acquire(first, guest, hooks().hooks, signal()), releasing, signal());

  const world = fakeIosHostMac();
  const config = tartConfig({ ...IOS_HOST_SETTINGS, "tart-ios-hosts-most": undefined, "tart-ios-hosts-cores": 10 });
  const own = new TartBackend({ ...config, hosts: config.hosts.map((host) => ({ ...host, iosHostsSizedBy: { most: 3, memoryGiB: 20 } })) }, testContext(new MemoryStorage()), IOS_HOST_FAKES);
  made.push(own);
  const second = identity();
  const placed = await place(own, second);
  assert.deepEqual(sizesOf(world.mac, slotRefOf(placed.guest)!.vm), ["cores=10", "memory-gib=20", "most=3"]);
  const words = (await own.doctor(signal())).checks.find((each) => each.id === "ios-hosts.mac1")?.detail ?? "";
  assert.match(words, / A new host here has 3 slots \(set for this Mac\), 10 cores \(the backend's setting\), 20 GiB \(set for this Mac\)\.$/);
  await own.release(await own.acquire(second, placed.guest, hooks().hooks, signal()), releasing, signal());
});

test("a Mac whose encoder is measured missing starts no shared host until its iOS image has bb-box-h264; the doctor and box_list say what each Mac offers (065)", async () => {
  const world = setup();
  fakeIosProbe(join(world.ssh.home(FAKE_MAC), ".nix-profile", "bin"), { hardware: "no" });
  const refused = await world.backend.slots!.offer("ios", null, signal());
  assert.equal(refused.tier, "wait", JSON.stringify(refused));
  assert.match("words" in refused ? refused.words : "", /No shared iOS host can start on mac1: mac1 cannot stream a device's screen: VideoToolbox could not make a hardware session \(-12903\), and the iOS image's build \S+ has no bb-box-h264\./);
  const [report] = world.backend.macCapabilities();
  assert.equal(report?.capabilities.simulator.is, "yes", "the simulator is the iOS image's, not the Mac's");
  const check = (await world.backend.doctor(signal())).checks.find((each) => each.id === "devices.mac1");
  assert.equal(check?.status, "warn");
  assert.match(check!.detail, /no device video: no hardware H\.264 encoder, and no software one/);

  writeFileSync(join(world.ssh.home(FAKE_MAC), ".bb-box", "tart", "images", "bb-box-ios.json"), `${imageRecord("ios", { build: IOS_IMAGE_BUILD, base: "build.20261003-021500", devices: IOS_HOST_DEVICES, tools: { idb_companion: "1.7.7", "bb-box-h264": "openh264 2.6.0" } })}\n`);
  const offered = await world.backend.slots!.offer("ios", null, signal());
  assert.equal(offered.tier, "new-host", JSON.stringify(offered));
  assert.equal(world.backend.macCapabilities()[0]?.capabilities.softwareEncoder.is, "yes");
});
