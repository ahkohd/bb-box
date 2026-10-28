// The Tart backend's warm pool on a fake Mac: suspended clones at a kind's
// default size, filled by maintain(), taken by a box of that size, and
// retired when their image, Tart or macOS changes.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { TartBackend } from "../src/backends/tart/backend.ts";
import { ownerText } from "../src/backends/tart/host.ts";
import type { AcquireHooks, BoxIdentity, BoxSize, Guest, ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_DISK_GIB, FAKE_IMAGE, FAKE_MAC, addImage, addVmFiles, fakeMacTools, runVmElsewhere, tartConfig } from "./fake-mac.ts";
import { FAKE_MAC_HELPER, FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const SMALL: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };
const MEDIUM: BoxSize = { cores: 6, memoryMiB: 16384, diskGiB: null };

const made: TartBackend[] = [];
// Each test's backends end with it: the fake ssh serves the newest test's Mac, and a backend left running could fill
// its pools there later, once fills no longer wait for an acquire.
afterEach(async () => {
  for (const backend of made.splice(0)) await backend.dispose();
});

function setup(warm: Record<string, number> = { macos: 1 }) {
  const ssh = fakeSsh();
  const mac = ssh.home(FAKE_MAC);
  fakeMacTools(mac);
  addImage(mac);
  const vmsDir = join(mac, ".tart", "vms");
  const contexts: ReturnType<typeof testContext>[] = [];
  const make = (installId = "test", counts = warm, values: Record<string, unknown> = {}) => {
    const context = testContext(new MemoryStorage(), installId, { warm: counts });
    contexts.push(context);
    const backend = new TartBackend(tartConfig(values), context, { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER, fillQuietMs: 0 });
    made.push(backend);
    return backend;
  };
  const vms = () => readdirSync(vmsDir).filter((name) => !name.startsWith(".") && name !== FAKE_IMAGE);
  const warmVms = () => vms().filter((name) => name.startsWith("bb-box-warm-"));
  const owners = join(mac, ".bb-box", "tart", "owners");
  const owner = (vm: string) => readFileSync(join(owners, vm), "utf8");
  const suspended = (vm: string) => existsSync(join(vmsDir, vm, "state.vzvmsave")) && !existsSync(join(vmsDir, vm, "running"));
  /** The address the fake Mac gives the next VM to ask for one. */
  const nextAddress = () => {
    const counter = join(vmsDir, ".lease");
    return `192.168.64.${existsSync(counter) ? Number(readFileSync(counter, "utf8")) + 1 : 2}`;
  };
  const up = (host: string) => rmSync(join(ssh.dir, "down", host), { force: true });
  return { ssh, mac, vmsDir, make, contexts, vms, warmVms, owners, owner, suspended, nextAddress, up };
}

let counter = 0;
function identity(kind = "macos", size = SMALL): BoxIdentity {
  counter++;
  return { boxId: `bxw${counter}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size };
}

function hooks() {
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      claimed.push(guest);
    },
    starting: async () => {},
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks: value, claimed, timings };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(60_000);

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("maintain fills a pool with suspended clones at the default size, which held() and capacity count as warm", async () => {
  const { make, warmVms, owner, suspended } = setup({ macos: 1, "macos-desktop": 1 });
  const backend = make();
  await backend.maintain();
  // macos and macos-desktop share the image and the default size, so one pool of 1 + 1.
  assert.equal(warmVms().length, 2);
  for (const vm of warmVms()) {
    assert.ok(suspended(vm), `${vm} is suspended`);
    assert.match(owner(vm), /^state=warm$/m);
    assert.match(owner(vm), /^grants=[0-9a-f]{16}$/m, "its fill made its signing identity and default grants with this helper (058)");
    assert.match(owner(vm), /^saved=\d{10}$/m, "its fill notes when it was saved");
    assert.match(owner(vm), new RegExp(`^image=${FAKE_IMAGE}$`, "m"));
    assert.doesNotMatch(owner(vm), /^box=/m);
  }
  assert.deepEqual(await backend.held(), [], "warm VMs are no box's, so the sweep keeps them");
  const capacity = await backend.capacity("macos-desktop", SMALL, []);
  assert.deepEqual(capacity.warm, { ready: 2, target: 2 });
  assert.equal(capacity.hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used, 0, "a suspended VM holds no slot");
  await backend.maintain();
  assert.equal(warmVms().length, 2, "a full pool stays as it is");
});

test("a fill needs its memory free on disk beyond the disk kept free, for its suspend; a box does not", async () => {
  const { make, contexts, warmVms } = setup();
  const free = FAKE_DISK_GIB.free;
  // 4 GiB above what is kept free, less than the 8 GiB a small VM suspends.
  const short = make("test", { macos: 1 }, { "tart-reserve-disk-gib": free - 4 });
  await short.maintain();
  assert.deepEqual(warmVms(), []);
  // Why, for the log, the doctor and the settings (#356).
  const [pool, ...more] = contexts[0]!.short.at(-1)!;
  assert.deepEqual([pool!.kinds, pool!.count, pool!.have, more], [["macos"], 1, 0, []]);
  assert.match(pool!.reason, /^mac1 has [\d.]+ GiB of disk free and keeps [\d.]+ GiB free, so a warm VM saved with its 8 GiB of memory does not fit\.$/);
  assert.equal((await short.capacity("macos", SMALL, [])).ok, true, "a box still fits");
  await make("test", { macos: 1 }, { "tart-reserve-disk-gib": free - 12 }).maintain();
  assert.equal(warmVms().length, 1);
  assert.deepEqual(contexts[1]!.short.at(-1), []);
});

test("a box at the default size takes a warm VM, and the pool fills again", async () => {
  const { make, warmVms, owner } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const box = identity();
  const recorded = hooks();
  const guest = await backend.acquire(box, null, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.deepEqual(guest.size, { ...SMALL, diskGiB: 59 });
  assert.ok("warm" in recorded.timings && "clock" in recorded.timings && !("clone" in recorded.timings), JSON.stringify(recorded.timings));
  assert.ok(!("grants" in recorded.timings), "the fill made the grants, so the claim pays nothing for them");
  assert.match(owner(warm!), new RegExp(`^box=${box.boxId}$`, "m"));
  assert.doesNotMatch(owner(warm!), /^state=/m);
  assert.equal(await backend.power(guest), "running");
  assert.equal((await backend.held()).find((held) => held.ref === warm)?.owner?.boxId, box.boxId);
  await backend.maintain();
  assert.equal(warmVms().filter((vm) => vm !== warm).length, 1, "the pool fills again");
  await backend.release(guest, releasing);
});

test("where boxes become BB machines, a fill readies the box's access before the suspend, so the claim's enrolment finds it done; a clone leaves it to the enrolment", async () => {
  const { ssh, make, warmVms, contexts, nextAddress } = setup();
  const backend = make();
  Object.assign(contexts[0]!, { enrols: () => true });
  const address = nextAddress();
  await backend.maintain();
  const done = (home: string) => readdirSync(join(home, ".config", "bb-box")).filter((name) => /^access-[0-9a-f]{12}$/.test(name));
  assert.equal(done(ssh.home(address)).length, 1, "the fill ran the access setup to its end");
  const recorded = hooks();
  const guest = await backend.acquire(identity(), null, recorded.hooks, signal());
  assert.equal(guest.ref, warmVms()[0]);
  assert.ok(!("access" in recorded.timings), JSON.stringify(recorded.timings));
  await backend.release(guest, releasing);

  const cloned = hooks();
  const other = await backend.acquire(identity("macos", { cores: 2, memoryMiB: 4096, diskGiB: null }), null, cloned.hooks, signal());
  // A fresh Mac's access setup is left to its enrolment: beside the name and grants, on a Mac just booted, it took 8.1 s.
  assert.ok("clone" in cloned.timings && "grants" in cloned.timings && !("access" in cloned.timings), JSON.stringify(cloned.timings));
  await backend.release(other, releasing);
});

test("a warm VM filled with another Mac helper gets its grants again at its claim (058)", async () => {
  const { owners, make, warmVms, owner } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  // As a fill under an earlier build left it.
  writeFileSync(join(owners, warm!), owner(warm!).replace(/^grants=.*$/m, "grants=ready"));
  const recorded = hooks();
  const guest = await backend.acquire(identity(), null, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.ok("grants" in recorded.timings, JSON.stringify(recorded.timings));
  await backend.release(guest, releasing);
});

test("a warm VM whose fill could not make its grants gets them at its claim (058)", async () => {
  const { ssh, make, warmVms, owner, nextAddress } = setup();
  // The helper in the next VM says it made no signing identity.
  const flags = join(ssh.home(nextAddress()), ".bb-box-state", "flags");
  mkdirSync(flags, { recursive: true });
  writeFileSync(join(flags, "no-signing"), "");
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  assert.doesNotMatch(owner(warm!), /^grants=/m);
  const recorded = hooks();
  const guest = await backend.acquire(identity(), null, recorded.hooks, signal());
  assert.equal(guest.ref, warm);
  assert.ok("grants" in recorded.timings, JSON.stringify(recorded.timings));
  await backend.release(guest, releasing);
});

test("a refusal names a claimed warm VM by its box, not by its warm name (#599)", async () => {
  const { make, warmVms } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, warm);
  const clone = identity();
  const other = await backend.acquire(clone, null, hooks().hooks, signal());
  const capacity = await backend.capacity("macos", SMALL, []);
  assert.equal(capacity.ok, false);
  assert.match(capacity.message!, /Two macOS VMs already run on mac1, Apple's limit \(box /);
  for (const named of [box, clone]) assert.match(capacity.message!, new RegExp(`box ${named.name} of thread thr_abc123[,)]`));
  assert.doesNotMatch(capacity.message!, /bb-box-warm-/);
  await backend.release(guest, releasing);
  await backend.release(other, releasing);
});

test("a box at another size clones, and leaves the warm VM", async () => {
  const { make, warmVms, suspended } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const box = identity("macos", MEDIUM);
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.deepEqual(guest.size, { ...MEDIUM, diskGiB: 59 });
  assert.ok(suspended(warm!));
  await backend.release(guest, releasing);
});

test("a warm VM that does not restore gives way to a clone, and goes", async () => {
  const { make, warmVms, vmsDir, contexts } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  writeFileSync(join(vmsDir, warm!, "state.vzvmsave"), "corrupt");
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(!existsSync(join(vmsDir, warm!)), "the warm VM that failed is deleted");
  assert.ok(contexts[0]!.errors.some((error) => /could not use warm VM [^,]+, saved \d+ min ago, [\s\S]*failed to restore/.test(error)), contexts[0]!.errors.join("\n"));
  await backend.maintain();
  await backend.release(guest, releasing);
});

test("after a warm VM that does not restore, the box clones rather than trying another warm VM, and the one saved no later is retired, as the log says", async () => {
  const { make, warmVms, vmsDir, contexts, owners, owner } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const spares = warmVms();
  assert.equal(spares.length, 2);
  const now = Math.floor(Date.now() / 1000);
  for (const warm of spares) {
    savedAgo(owners, owner, warm, now, 600);
    writeFileSync(join(vmsDir, warm, "state.vzvmsave"), "corrupt");
  }
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  await until(() => spares.every((warm) => !existsSync(join(vmsDir, warm))), "the other warm VM to be retired");
  assert.ok(contexts[0]!.errors.some((error) => /Warm VM bb-box-warm-\w+ on mac1, saved \d+ min ago, is retired, as one saved after it failed to restore/.test(error)), contexts[0]!.errors.join("\n"));
  await backend.release(guest, releasing);
});

test("after a warm VM that does not restore, one saved after it stays", async () => {
  const { make, warmVms, vmsDir, owners, owner } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const [first, second] = warmVms().sort();
  const now = Math.floor(Date.now() / 1000);
  savedAgo(owners, owner, first!, now, 600);
  savedAgo(owners, owner, second!, now, 60);
  for (const warm of [first!, second!]) writeFileSync(join(vmsDir, warm, "state.vzvmsave"), "corrupt");
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(!existsSync(join(vmsDir, first!)), "the warm VM that failed is deleted");
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.ok(existsSync(join(vmsDir, second!)), "the warm VM saved after it stays");
  await backend.release(guest, releasing);
});

function savedAgo(owners: string, owner: (vm: string) => string, vm: string, now: number, seconds: number): void {
  writeFileSync(join(owners, vm), owner(vm).replace(/^saved=\d+$/m, `saved=${now - seconds}`));
}

test("a warm VM saved more than tart-warm-max-hours ago, or with no saved time, is retired and replaced", async () => {
  const { make, warmVms, owners, owner, contexts } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const [old, unknown] = warmVms();
  savedAgo(owners, owner, old!, Math.floor(Date.now() / 1000), 6 * 3600 + 60);
  writeFileSync(join(owners, unknown!), owner(unknown!).replace(/^saved=\d+\n/m, ""));
  assert.equal((await backend.capacity("macos", SMALL, [])).warm?.ready, 0, "neither is offered");
  await backend.maintain();
  const now = warmVms();
  assert.equal(now.length, 2);
  assert.ok(!now.includes(old!) && !now.includes(unknown!), now.join(", "));
  const retirements = () => contexts[0]!.logs.filter((line) => line.includes("is retired"));
  assert.deepEqual(retirements().sort(), [
    `Warm VM ${old} on mac1, saved 6 h 1 min ago, is retired, as tart-warm-max-hours is 6.`,
    `Warm VM ${unknown} on mac1, with no saved time, is retired, as tart-warm-max-hours is 6.`,
  ].sort());
  await backend.maintain();
  assert.equal(retirements().length, 2, "an upkeep that retires nothing logs nothing");
});

test("tart-warm-max-hours sets how long a macOS warm VM is kept", async () => {
  const { make, warmVms, owners, owner, contexts } = setup();
  const backend = make("test", { macos: 1 }, { "tart-warm-max-hours": 12 });
  await backend.maintain();
  const [warm] = warmVms();
  savedAgo(owners, owner, warm!, Math.floor(Date.now() / 1000), 7 * 3600);
  await backend.maintain();
  assert.deepEqual(warmVms(), [warm]);
  assert.deepEqual(contexts[0]!.logs.filter((line) => line.includes("is retired")), []);
});

test("a claim takes a warm VM whose slot a fill holds: the fill stops for it, as a claim comes before a fill; then the Mac refuses a third", async () => {
  const { ssh, vmsDir, make, warmVms, nextAddress, up } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const [taken, spare] = warmVms();
  // One box runs, from one warm VM; the pool fills again, and that fill, whose VM does not answer, holds the Mac's
  // second slot. A resumed warm VM keeps its address, so the fill's is the next.
  const address = nextAddress();
  ssh.down(address);
  const running = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.ok([taken, spare].includes(running.ref));
  const filling = backend.maintain().catch((error: unknown) => error);
  await until(() => warmVms().some((vm) => existsSync(join(vmsDir, vm, "lease")) && readFileSync(join(vmsDir, vm, "lease"), "utf8").trim() === address), "the fill to wait for its VM");
  const fill = warmVms().find((vm) => existsSync(join(vmsDir, vm, "lease")) && readFileSync(join(vmsDir, vm, "lease"), "utf8").trim() === address)!;
  const left = [taken, spare].find((vm) => vm !== running.ref)!;
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  up(address);
  assert.equal(guest.ref, left, "the box took the warm VM, not the fill and not a clone");
  assert.ok(!warmVms().includes(fill), "the fill was stopped and its VM deleted");
  const room = await backend.capacity("macos", SMALL, []);
  assert.equal(room.ok, false);
  assert.match(room.message!, /Two macOS VMs already run on mac1, Apple's limit/);
  await filling;
  await backend.release(guest, releasing);
  await backend.release(running, releasing);
});

test("a box whose saved state does not restore boots afresh from its disk", async () => {
  const { make, vmsDir } = setup({});
  const backend = make();
  const guest = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
  await backend.stop(guest);
  writeFileSync(join(vmsDir, guest.ref, "state.vzvmsave"), "corrupt");
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a fill cut short by a restart is listed with no owner, so the sweep releases it", async () => {
  const { make, vmsDir, owners } = setup({});
  const backend = make();
  const vm = "bb-box-warm-0123456789ab";
  mkdirSync(join(vmsDir, vm), { recursive: true });
  writeFileSync(join(vmsDir, vm, "config.json"), JSON.stringify({ os: "darwin", cpuCount: 4, memorySize: 8 * 2 ** 30 }));
  addVmFiles(join(vmsDir, vm));
  mkdirSync(owners, { recursive: true });
  writeFileSync(join(owners, vm), ownerText({ install: "test", state: "filling", image: FAKE_IMAGE, build: "1", tart: "2.30.0", macos: "27A1" }));
  const held = (await backend.held()).find((guest) => guest.ref === vm);
  assert.ok(held, "the leftover fill is listed");
  assert.equal(held.owner, null);
  await backend.release(held, releasing);
  assert.ok(!existsSync(join(vmsDir, vm)) && !existsSync(join(owners, vm)));
});

test("a restarted acquire resumes the warm VM it held, and starts over when it had not", async () => {
  const { make, warmVms, owners, owner } = setup({ macos: 2 });
  const backend = make();
  await backend.maintain();
  const [first, second] = warmVms();
  // Held before the restart: the owner file names the box.
  const box = identity();
  writeFileSync(
    join(owners, first!),
    ownerText({ install: "test", kind: box.kind, box: box.boxId, thread: box.threadId, name: box.name, created: box.createdAt }),
  );
  const recorded = hooks();
  const restarted = make();
  const guest = await restarted.acquire(box, { ref: first!, host: "mac1", address: null, size: null, data: { box: box.boxId } }, recorded.hooks, signal());
  assert.equal(guest.ref, first);
  assert.ok(!("place" in recorded.timings) && !("warm" in recorded.timings), JSON.stringify(recorded.timings));
  // Not held yet: the warm VM is still free, and the acquire takes one afresh.
  const other = identity();
  const again = await restarted.acquire(other, { ref: second!, host: "mac1", address: null, size: null, data: { box: other.boxId } }, hooks().hooks, signal());
  assert.equal(again.ref, second);
  assert.match(owner(second!), new RegExp(`^box=${other.boxId}$`, "m"));
  await restarted.maintain();
  await backend.release(guest, releasing);
  await backend.release(again, releasing);
});

test("an acquire that meets a fill holding the last slot takes it over at the fill's size, and stops it at any other", async () => {
  for (const size of [SMALL, MEDIUM]) {
    const { ssh, vmsDir, make, warmVms, owner, nextAddress, up } = setup();
    const backend = make();
    // One box runs, so a fill takes the second, last slot.
    const running = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
    // The fill's VM does not answer until the acquire has made its choice.
    const address = nextAddress();
    ssh.down(address);
    const filling = backend.maintain().catch((error: unknown) => error);
    // The fill has its address, and waits for SSH there.
    await until(() => warmVms().length === 1 && existsSync(join(vmsDir, warmVms()[0]!, "lease")), "the fill to wait for its VM");
    const [fill] = warmVms();
    const room = await backend.capacity("macos", size, []);
    assert.equal(room.ok, true, "the fill gives its slot to a box (#145)");
    assert.equal(room.hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used, 2, "while it holds the slot");
    const box = identity("macos", size);
    const recorded = hooks();
    const acquiring = backend.acquire(box, null, recorded.hooks, signal());
    if (size === SMALL) {
      await until(() => recorded.claimed.length > 0, "the acquire to take the fill over");
      up(address);
      const guest = await acquiring;
      assert.equal(guest.ref, fill, "the box takes the fill's VM over");
      assert.match(owner(fill!), new RegExp(`^box=${box.boxId}$`, "m"));
      assert.equal(await backend.power(guest), "running", "and it is never suspended");
      await backend.release(guest, releasing);
    } else {
      const guest = await acquiring;
      up(address);
      assert.equal(guest.ref, `bb-box-${box.boxId}`, "a box of another size clones");
      assert.ok(!warmVms().includes(fill!), "the fill was stopped and its VM deleted");
      await backend.release(guest, releasing);
    }
    await filling;
    await backend.maintain();
    await backend.release(running, releasing);
  }
});

test("a VM that answers as another is refused", async () => {
  const { ssh, make } = setup({});
  const backend = make();
  const guest = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
  await backend.stop(guest);
  // Another VM has the address now.
  const marker = join(ssh.home(guest.address!), ".config", "bb-box", "vm");
  assert.equal(readFileSync(marker, "utf8").trim(), guest.ref, "the VM keeps its own name");
  writeFileSync(marker, "bb-box-someone-else\n");
  await assert.rejects(backend.start(guest), /The VM that answers is bb-box-someone-else, not bb-box-/);
  await backend.release(guest, releasing);
});

test("a VM that keeps no name is named only when the Mac's ARP table gives its MAC address", async () => {
  const { ssh, vmsDir, make } = setup({});
  const backend = make();
  const guest = await backend.acquire(identity("macos", MEDIUM), null, hooks().hooks, signal());
  const marker = join(ssh.home(guest.address!), ".config", "bb-box", "vm");
  // As a box made before names were kept: its own address, so it is named.
  rmSync(marker);
  await backend.stop(guest);
  await backend.start(guest);
  assert.equal(readFileSync(marker, "utf8").trim(), guest.ref);
  // Its address now held by another VM, which keeps no name either.
  rmSync(marker);
  await backend.stop(guest);
  const intruder = join(vmsDir, "someone-else");
  mkdirSync(intruder);
  writeFileSync(join(intruder, "config.json"), JSON.stringify({ os: "darwin", cpuCount: 4, memorySize: 8 * 2 ** 30, macAddress: "0a:0b:0c:0d:0e:0f" }));
  addVmFiles(intruder);
  writeFileSync(join(intruder, "lease"), guest.address!);
  utimesSync(join(intruder, "lease"), new Date(), new Date(Date.now() + 60_000));
  await assert.rejects(backend.start(guest), /keeps no name, and its MAC address is a:b:c:d:e:f, not bb-box-/);
  assert.ok(!existsSync(marker), "nothing is written into a VM that is not the box's");
  rmSync(intruder, { recursive: true });
  await backend.release(guest, releasing);
});

test("a warm VM that someone ran is retired and replaced", async () => {
  const { make, vmsDir, warmVms } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  rmSync(join(vmsDir, warm!, "state.vzvmsave"));
  await runVmElsewhere(join(vmsDir, warm!));
  await backend.maintain();
  assert.ok(!existsSync(join(vmsDir, warm!)), "the warm VM that runs is retired");
  assert.equal(warmVms().length, 1, "and a new one is made");
});

test("warm VMs of an image built again, or saved under another macOS build, are retired and replaced", async () => {
  const { mac, vmsDir, make, warmVms } = setup();
  const backend = make();
  await backend.maintain();
  const [first] = warmVms();
  // The image built again: a new disk file.
  const disk = join(vmsDir, FAKE_IMAGE, "disk.img");
  writeFileSync(`${disk}.new`, "image again");
  renameSync(`${disk}.new`, disk);
  await backend.maintain();
  const [second] = warmVms();
  assert.ok(second && second !== first && !existsSync(join(vmsDir, first!)), "the old warm VM is retired, and a new one made");
  // The image run to change it: the same file, changed.
  utimesSync(disk, new Date(), new Date(Date.now() + 120_000));
  await backend.maintain();
  const [changed] = warmVms();
  assert.ok(changed && changed !== second && !existsSync(join(vmsDir, second!)), "an image changed in place retires it too");
  writeFileSync(join(mac, ".fake-macos-build"), "27A2\n");
  await backend.maintain();
  const [third] = warmVms();
  assert.ok(third && third !== changed && !existsSync(join(vmsDir, changed!)), "a macOS update retires it too");
});

test("two installs never share warm VMs", async () => {
  const { make, warmVms, suspended } = setup();
  const backend = make();
  await backend.maintain();
  const [warm] = warmVms();
  const other = make("other", {});
  assert.deepEqual((await other.capacity("macos", SMALL, [])).warm, { ready: 0, target: 0 });
  const box = identity();
  const guest = await other.acquire(box, null, hooks().hooks, signal());
  assert.equal(guest.ref, `bb-box-${box.boxId}`);
  assert.ok(suspended(warm!));
  await other.release(guest, releasing);
});

test("a cloned macOS box records its image's build, which tells a spare of an old build, and a spare waits suspended no longer than tart-warm-max-hours (063, 7.5)", async () => {
  const { make, mac } = setup({});
  const backend = make("test", {}, { "tart-warm-max-hours": 4 });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(guest.data?.build, "build.20261003-021500");
  assert.equal(await backend.fromCurrentBuild(guest, "macos"), true);
  writeFileSync(join(mac, ".bb-box", "tart", "images", `${FAKE_IMAGE}.json`), `${JSON.stringify({ contract: 1, image: "standard", kind: "macos", arch: "arm64", build: "build.20261101-021500", built: new Date().toISOString(), os: "fake OS", tools: {} })}\n`);
  assert.equal(await backend.fromCurrentBuild(guest, "macos"), false);
  assert.equal(await backend.fromCurrentBuild({ ...guest, data: { box: guest.data!.box! } }, "macos"), null, "a box made before builds were recorded cannot tell");
  assert.equal(backend.savedSessionRestoresWithinMs("macos"), 4 * 3_600_000);
  await backend.release(guest, releasing);
});

test("a start whose saved state does not restore boots afresh and says so in its timings; one that restores does not (063, 7.5)", async () => {
  const { make, vmsDir } = setup({});
  const backend = make("test", {});
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.stop(guest, signal());
  const resumed: Record<string, number> = {};
  await backend.start(guest, signal(), (step, ms) => (resumed[step] = ms));
  assert.equal(resumed.boot, undefined);
  await backend.stop(guest, signal());
  writeFileSync(join(vmsDir, guest.ref, "state.vzvmsave"), "corrupt");
  const booted: Record<string, number> = {};
  await backend.start(guest, signal(), (step, ms) => (booted[step] = ms));
  assert.equal(typeof booted.boot, "number");
  await backend.release(guest, releasing);
});
