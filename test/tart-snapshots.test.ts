import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { identityInstallScript, macosIdentityTool } from "../src/backends/tart/identity.ts";
import { LINUX_NO_FORKS, LINUX_FORK_SAFE_FROM, MACOS_FORK_SAFE_FROM, NO_IMAGE_ATTACH, SNAPSHOTS_FOLDER, labelText, parseListing, parseTaskRef, savedUnder, taskOutcome, taskRef, tartOffer, type SnapshotLabel } from "../src/backends/tart/snapshots.ts";
import { SnapshotFailed, type AcquireHooks, type BoxIdentity, type Guest, type MachineSize, type ReleaseHooks, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { IDENTITY_TOOL, forkCheckScript, forkSafetyScript, forkVerdict, parseForkSeen } from "../src/core/identity.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { quote } from "../src/transports/process.ts";
import { COMMAND, THREAD, identityGuest, standing, world } from "./snapshot-world.ts";
import { FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_MAC_HELPER, FAKE_SSH_BINARY, MemoryStorage, fakeSsh, tempDir, testContext } from "./helpers.ts";

const MAC = FAKE_MAC;
const made: TartBackend[] = [];
afterEach(async () => {
  for (const backend of made.splice(0)) await backend.dispose();
});
after(async () => {
  for (const backend of made) await backend.dispose();
});

const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER, fillQuietMs: 0 };
const SMALL: MachineSize = { cores: 4, memoryMiB: 8192, diskGiB: null };
const SNAP = "snaaaaaaaaaaaa";
const OTHER = "snbbbbbbbbbbbb";
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

function setup(values: Record<string, unknown> = {}, options: Partial<TartBackendOptions> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  fakeMacTools(mac);
  addImage(mac);
  if (values["tart-linux-image"]) addImage(mac, "bb-box-linux", "linux");
  const make = (install = "test") => {
    const backend = new TartBackend(tartConfig(values), testContext(new MemoryStorage(), install), { ...FAKES, ...options });
    made.push(backend);
    return backend;
  };
  return { ssh, mac, make, backend: make(), snaps: join(mac, ".tart", SNAPSHOTS_FOLDER), vms: join(mac, ".tart", "vms") };
}

let counter = 0;
function identity(kind = "macos-desktop", size = SMALL): BoxIdentity {
  counter++;
  return { boxId: `bxsnap${counter}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: "none" } };
}

const acquiring: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };

function recorder(): { hooks: SnapshotHooks; tasks: TaskRef[]; steps: string[] } {
  const tasks: TaskRef[] = [];
  const steps: string[] = [];
  return {
    tasks,
    steps,
    hooks: {
      submitting: async () => {
        steps.push("submitting");
      },
      task: async (task) => {
        steps.push("task");
        tasks.push(task);
      },
    },
  };
}

function tartCalls(mac: string): string[][] {
  const file = join(mac, ".fake-tart-log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}

function label(snaps: string, id: string): Record<string, string> {
  return Object.fromEntries(readFileSync(join(snaps, id, "label"), "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

test("a macOS box's snapshots hold its disk and memory, suspend it, restore in place, fork, and are kept as they are, beside the VMs; a Linux VM's hold its disk, only while stopped, and fork and are kept too, including a Linux desktop", () => {
  const macos = tartOffer("macos");
  assert.deepEqual([macos.holds, macos.whileRunning, macos.restore, macos.fork, macos.keepsPastRelease, macos.lives, macos.outlivesGuest, macos.forkSafeFrom], [["disk-and-memory"], "suspends", "in-place", "copy", "as-is", "host", true, MACOS_FORK_SAFE_FROM]);
  const linux = tartOffer("linux");
  assert.deepEqual([linux.holds, linux.whileRunning, linux.restore, linux.fork, linux.keepsPastRelease, linux.lives, linux.outlivesGuest, linux.forkSafeFrom], [["disk"], "stopped-only", "in-place", "copy", "as-is", "host", true, LINUX_FORK_SAFE_FROM]);
  const desktop = tartOffer("linux", false);
  assert.deepEqual([desktop.holds, desktop.fork, desktop.keepsPastRelease, desktop.forkWhy], [["disk"], "none", "no", LINUX_NO_FORKS]);
  const { backend } = setup({ "tart-linux-image": "bb-box-linux", "tart-linux-desktop-image": "bb-box-linux-desktop" });
  assert.equal(backend.snapshotting("macos")?.whileRunning, "suspends");
  assert.equal(backend.snapshotting("linux-arm64")?.fork, "copy");
  assert.equal(backend.snapshotting("linux-arm64-desktop-cpu")?.fork, "copy");
  assert.equal(backend.snapshotting("linux-arm64-desktop-cpu")?.forkSafeFrom, 9);
  assert.equal(backend.snapshotting("linux-arm64-desktop-cpu")?.keepsPastRelease, "as-is");
  assert.equal(backend.snapshotting("windows-arm64-desktop"), null);
  assert.equal(backend.identitySource("macos"), "device");
  assert.equal(backend.identitySource("linux-arm64"), "device");
  assert.equal(backend.identitySource("linux-arm64-desktop-cpu"), "device");
});

test("a take of a running macOS box suspends it, copies its folder with its saved memory beside the VMs, labels the copy, and resumes the box", async () => {
  const { backend, mac, snaps, vms } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(vms, guest.ref, "marker.txt"), "before");
  const recorded = recorder();
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorded.hooks, signal());
  assert.equal(taken.ref, SNAP);
  assert.equal(taken.holds, "disk-and-memory");
  assert.deepEqual(recorded.steps, ["submitting", "task"]);
  assert.deepEqual(recorded.tasks, [{ ref: `tart-take:${SNAP}`, host: "mac1" }]);
  const calls = tartCalls(mac).map((call) => `${call[1]} ${call.at(-1)}`);
  const suspended = calls.lastIndexOf(`suspend ${guest.ref}`);
  assert.ok(suspended >= 0 && calls.lastIndexOf(`run ${guest.ref}`) > suspended, "suspended for the copy, then resumed");
  assert.equal(await backend.power(guest), "running");
  assert.ok(existsSync(join(snaps, SNAP, "vm", "state.vzvmsave")), "the copy holds the saved memory");
  assert.equal(readFileSync(join(snaps, SNAP, "vm", "marker.txt"), "utf8"), "before");
  assert.deepEqual(label(snaps, SNAP), { install: "test", box: box.boxId, vm: guest.ref, snapshot: SNAP, taken: label(snaps, SNAP).taken!, reset: "3", kind: "macos", holds: "disk-and-memory", os: "darwin", macos: "27A1", tart: "2.30.0", diskgb: "64" });
  assert.ok(!existsSync(join(snaps, `${SNAP}.part`)));
  await backend.release(guest, releasing);
  assert.ok(existsSync(join(snaps, SNAP)), "a snapshot lives beside its VM, not in it, so the VM's release leaves it");
});

test("a Tart take of a running macOS box says it pauses the box while it suspends and saves its memory, and measures the pause from suspend to resume; a stopped box does not pause", async () => {
  let clock = 1_000_000;
  const { backend } = setup({}, { now: () => (clock += 9_000) });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());

  const plan = await backend.planSnapshots(guest, "macos-desktop", null, signal());
  const running = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal());
  await backend.stop(guest);
  const stoppedPlan = await backend.planSnapshots(guest, "macos-desktop", null, signal());
  const stopped = await backend.snapshot(guest, { id: "sntartsnaptwob", box: box.boxId, memory: true }, recorder().hooks, signal());

  assert.deepEqual(plan.take.memory?.pause, { pauses: true, aboutMs: plan.take.memoryAboutMs, basis: { bytes: SMALL.memoryMiB * 2 ** 20, of: "memory" } });
  assert.equal(running.pausedMs, 9_000);
  assert.deepEqual(stoppedPlan.take.memory?.pause, { pauses: false });
  assert.equal(stopped.pausedMs, 0);
  await backend.release(guest, releasing);
});

test("a take whose suspend fails copies nothing, says so, and leaves the box running", async () => {
  const { backend, mac, snaps } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(mac, ".fake-tart-suspend-fails"), "");
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /could not suspend bb-box-\S+ on mac1 to copy it, so it copied nothing/.test(error.message));
  assert.ok(!existsSync(join(snaps, SNAP)) && !existsSync(join(snaps, `${SNAP}.part`)));
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a Tart take's measured pause ends when the VM resumes, not after the SSH, identity and clock checks that follow", async () => {
  let clock = 1_000_000;
  const { backend, ssh } = setup({}, { now: () => (clock += 9_000), sleep: async () => void (clock += 60_000) });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());

  ssh.upAfter(guest.address!, 3);
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal());

  assert.equal(taken.notResumed, null);
  assert.equal(taken.pausedMs, 9_000, "the three minutes of SSH retries after the resume are not part of the pause");
  await backend.release(guest, releasing);
});

test("a Tart take whose box does not resume reports no completed pause", async () => {
  let clock = 1_000_000;
  const { backend, mac } = setup({}, { now: () => (clock += 9_000) });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());

  writeFileSync(join(mac, ".fake-tart-run-fails"), "2");
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal());

  assert.match(taken.notResumed ?? "", /could not start bb-box-\S+ on mac1/);
  assert.equal(taken.pausedMs, null);
  await backend.release(guest, releasing);
});

test("a take of a stopped macOS box copies it as it is, with no suspend or resume", async () => {
  const { backend, mac } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.stop(guest);
  const runs = tartCalls(mac).filter((call) => call[1] === "run").length;
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal());
  assert.equal(taken.holds, "disk-and-memory");
  assert.equal(tartCalls(mac).filter((call) => call[1] === "run").length, runs);
  assert.equal(await backend.power(guest), "stopped");
  await backend.release(guest, releasing);
});

test("a Linux VM is copied only while stopped, and holds its disk", async () => {
  const { backend, snaps } = setup({ "tart-linux-image": "bb-box-linux" });
  const box = identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null });
  const guest = await backend.acquire(box, null, acquiring, signal());
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /only while the box is stopped/.test(error.message));
  const plan = await backend.planSnapshots(guest, "linux-arm64", null, signal());
  assert.equal(plan.take.ok, false);
  assert.match(plan.take.why ?? "", /Stop it first/);
  await backend.stop(guest);
  assert.equal((await backend.planSnapshots(guest, "linux-arm64", null, signal())).take.ok, true);
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal());
  assert.equal(taken.holds, "disk");
  assert.equal(label(snaps, SNAP).os, "linux");
  await backend.release(guest, releasing);
});

test("what a Tart VM holds now: its lease while it runs, none once it is shut down, gone only when its folder is missing; a start returns the address the Mac's DHCP gave it", async () => {
  const { backend, mac, vms } = setup({ "tart-linux-image": "bb-box-linux" });
  const linux = await backend.acquire(identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null }), null, acquiring, signal());
  assert.ok(linux.address);
  assert.deepEqual(await backend.leasedAddressNow(linux, signal()), { power: "running", leased: linux.address });
  await backend.stop(linux);
  assert.deepEqual(await backend.leasedAddressNow(linux, signal()), { power: "stopped", leased: null }, "a Linux VM released its lease at its shutdown");
  rmSync(join(vms, linux.ref, "lease"));
  const started = await backend.start(linux, signal());
  assert.ok(started?.address);
  assert.notEqual(started.address, linux.address);
  assert.deepEqual(await backend.leasedAddressNow(linux, signal()), { power: "running", leased: started.address });
  await backend.release(linux, releasing);
  assert.deepEqual(await backend.leasedAddressNow(linux, signal()), { power: "gone", leased: null });
  const macos = await backend.acquire(identity(), null, acquiring, signal());
  await backend.stop(macos);
  assert.equal(await backend.power(macos), "stopped");
  assert.deepEqual(await backend.leasedAddressNow(macos, signal()), { power: "suspended", leased: macos.address }, "a suspended macOS VM resumes with its address");
  writeFileSync(join(mac, ".fake-tart-ip-fails"), "");
  assert.deepEqual(await backend.leasedAddressNow(macos, signal()), { power: "suspended", leased: null }, "a suspended VM's lease may have gone; core still compares its recorded address");
  rmSync(join(mac, ".fake-tart-ip-fails"));
  await backend.release(macos, releasing);
});

test("what a Tart VM holds now fails closed: a VM that is there but not this box's, one Tart does not list, a running VM with no lease, and a lease that is not an address all throw", async () => {
  const { backend, mac, vms } = setup({ "tart-linux-image": "bb-box-linux" });
  const linux = await backend.acquire(identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null }), null, acquiring, signal());
  const owner = join(mac, ".bb-box", "tart", "owners", linux.ref);
  const owned = readFileSync(owner, "utf8");
  writeFileSync(owner, owned.replace(/^box=.*$/m, "box=bxsomeoneelse"));
  await assert.rejects(backend.leasedAddressNow(linux, signal()), /is there, but its owner file does not name this box/);
  writeFileSync(owner, owned);
  writeFileSync(join(mac, ".fake-tart-ip-fails"), "");
  await assert.rejects(backend.leasedAddressNow(linux, signal()), /tart ip found no lease for \S+ on mac1, which runs: .*no IP address found/);
  rmSync(join(mac, ".fake-tart-ip-fails"));
  writeFileSync(join(vms, linux.ref, "lease"), "deadbeef");
  await assert.rejects(backend.leasedAddressNow(linux, signal()), /tart ip gave \S+ on mac1 "deadbeef", not an address/);
  await backend.stop(linux);
  renameSync(join(vms, linux.ref, "nvram.bin"), join(vms, linux.ref, "nvram.aside"));
  await assert.rejects(backend.leasedAddressNow(linux, signal()), /Tart does not list \S+ on mac1 as running, suspended or stopped: it says "unlisted"/);
  renameSync(join(vms, linux.ref, "nvram.aside"), join(vms, linux.ref, "nvram.bin"));
  await backend.release(linux, releasing);
});

test("a Tart VM's commands never go to its recorded address: with no address from the Mac, a connection is unreachable, so a fork that now holds that address is never reached as its source", async () => {
  const { backend, mac, make } = setup({ "tart-linux-image": "bb-box-linux" });
  const linux = await backend.acquire(identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null }), null, acquiring, signal());
  assert.ok(linux.address);
  writeFileSync(join(mac, ".fake-tart-ip-fails"), "");
  const restarted = make();
  await assert.rejects(restarted.transports(linux, "linux-arm64"), /The VM \S+ on mac1 has no address/);
  rmSync(join(mac, ".fake-tart-ip-fails"));
  await backend.release(linux, releasing);
});

test("a snapshots folder on another volume than the VMs is refused before anything is copied, and the plan says so", async () => {
  const { backend, mac, snaps } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  const stat = join(mac, ".nix-profile", "bin", "stat");
  writeFileSync(stat, `#!/bin/sh\nfor a; do last=$a; done\ncase "$*" in *"-c %d"*) case $last in *${SNAPSHOTS_FOLDER}*) echo 4242; exit 0 ;; esac ;; esac\nexec /usr/bin/stat "$@"\n`);
  chmodSync(stat, 0o755);
  const plan = await backend.planSnapshots(guest, "macos-desktop", null, signal());
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, "the snapshots folder on mac1 is on another volume than the VMs, so a copy there would be a full copy. Move it to the VMs' volume.");
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /is on another volume than the VMs, so a copy there would be a full copy\. Move it to the VMs' volume\. BB Box suspended nothing\./.test(error.message));
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith("sn")), [], "nothing copied");
  assert.ok(!tartCalls(mac).some((call) => call[1] === "suspend"), "refused before the suspend");
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a take is refused when the VMs' volume has less free than the floor, before the suspend", async () => {
  const { backend, mac, snaps } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(mac, ".nix-profile", "bin", "df"), `#!/bin/sh\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho 'fake 1073741824 1063256064 10485760 99% /'\n`);
  const plan = await backend.planSnapshots(guest, "macos-desktop", null, signal());
  assert.deepEqual([plan.take.ok, plan.fork.ok], [false, false]);
  assert.match(plan.take.why ?? "", /has 10 GiB free, and BB Box copies a VM there only with at least 50 GiB free/);
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /10 GiB free, and BB Box copies a VM there only with at least 50 GiB free.*BB Box suspended nothing\./.test(error.message));
  assert.ok(!existsSync(join(snaps, SNAP)) && !existsSync(join(snaps, `${SNAP}.part`)));
  assert.ok(!tartCalls(mac).some((call) => call[1] === "suspend"), "refused before the suspend");
  await backend.release(guest, releasing);
});

test("the listing finds this install's snapshots, a copy cut short as incomplete and a delete cut short as incomplete, and never another install's; a keep date is on the label", async () => {
  const { backend, make, snaps } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.stop(guest);
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  await backend.labelKept({ id: SNAP, ref: SNAP, guest }, "2026-12-01", signal());
  mkdirSync(join(snaps, `${OTHER}.part`, "vm"), { recursive: true });
  writeFileSync(join(snaps, `${OTHER}.part`, "label"), labelText({ ...(baseLabel(box.boxId, guest.ref) as SnapshotLabel), snapshot: OTHER }));
  writeFileSync(join(snaps, `${OTHER}.part`, "pid"), "999999");
  const held = await backend.heldSnapshots(signal());
  const kept = held.find((one) => one.id === SNAP)!;
  assert.equal(kept.state, "complete");
  assert.equal(kept.keptUntil, Date.parse("2026-12-01T00:00:00Z") + 86_400_000 - 1);
  assert.equal(kept.forkSafe, 3);
  assert.equal(kept.holds, "disk-and-memory");
  assert.equal(kept.guest.ref, guest.ref);
  assert.equal(kept.owner?.boxId, box.boxId);
  const cut = held.find((one) => one.id === OTHER)!;
  assert.equal(cut.state, "incomplete");
  assert.match(cut.words ?? "", /stopped part way/);
  assert.deepEqual(await make("other-install").heldSnapshots(signal()), []);
  await backend.labelKept({ id: SNAP, ref: SNAP, guest }, null, signal());
  assert.equal((await backend.heldSnapshots(signal())).find((one) => one.id === SNAP)?.keptUntil, null);
  await assert.rejects(make("other-install").deleteSnapshot({ id: SNAP, ref: SNAP, guest }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /not a snapshot of this install's/.test(error.message));
  const deleting = recorder();
  await backend.deleteSnapshot({ id: SNAP, ref: SNAP, guest }, deleting.hooks, signal());
  assert.deepEqual(deleting.tasks, [{ ref: `tart-delete:${SNAP}`, host: "mac1" }]);
  await backend.deleteSnapshot({ id: OTHER, ref: OTHER, guest }, recorder().hooks, signal());
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith("sn")), []);
  await backend.release(guest, releasing);
});

function baseLabel(box: string, vm: string): Omit<SnapshotLabel, "snapshot"> & { snapshot: string } {
  return { install: "test", box, vm, snapshot: SNAP, takenAt: Date.UTC(2026, 10, 1), holds: "disk-and-memory", os: "darwin", macosBuild: "27A1", tart: "2.30.0", reset: 3, kept: null, kind: "macos", diskGB: null };
}

test("a task reads its outcome from the Mac's folders: a take done, cut short or never begun, a delete done or cut short, and a putting back recorded", () => {
  const listing = (entries: string) => parseListing(`@macosbuild\n27A1\n@tart\n2.30.0\n@volume\n/\n@entries\n${entries}`);
  const entry = (name: string, alive = "no") => `=${name}\nalive=${alive}\n${labelText(baseLabel("bxone", "bb-box-bxone"))}`;
  assert.deepEqual(parseTaskRef(taskRef({ kind: "take", id: SNAP })), { kind: "take", id: SNAP });
  assert.deepEqual(parseTaskRef(taskRef({ kind: "rollback", vm: "bb-box-bxone", id: SNAP, attempt: "a1b2c3d4e5f6" })), { kind: "rollback", vm: "bb-box-bxone", id: SNAP, attempt: "a1b2c3d4e5f6" });
  assert.equal(parseTaskRef("UPID:pve:1"), null);
  assert.deepEqual(taskOutcome({ kind: "take", id: SNAP }, listing(entry(SNAP)), null), { state: "ok" });
  assert.deepEqual(taskOutcome({ kind: "take", id: SNAP }, listing(entry(`${SNAP}.part`, "yes")), null), { state: "running" });
  assert.equal(taskOutcome({ kind: "take", id: SNAP }, listing(entry(`${SNAP}.part`)), null).state, "failed");
  assert.deepEqual(taskOutcome({ kind: "take", id: SNAP }, listing(""), null), { state: "failed", words: "the Mac has no copy of it, so the take did not begin" });
  assert.deepEqual(taskOutcome({ kind: "delete", id: SNAP }, listing(""), null), { state: "ok" });
  assert.equal(taskOutcome({ kind: "delete", id: SNAP }, listing(entry(`${SNAP}.deleting`)), null).state, "failed");
  const rollback = { kind: "rollback" as const, vm: "bb-box-bxone", id: SNAP, attempt: "a1b2c3d4e5f6" };
  assert.deepEqual(taskOutcome(rollback, listing(""), `done ${SNAP} a1b2c3d4e5f6\n`), { state: "ok" });
  assert.deepEqual(taskOutcome(rollback, listing(""), `running\nswapping ${SNAP} a1b2c3d4e5f6 42 Sun Nov  1 00:00:00 2026\n`), { state: "running" });
  assert.deepEqual(taskOutcome(rollback, listing(""), `undone ${SNAP} a1b2c3d4e5f6\n`), { state: "failed", unchanged: true, words: "BB Box stopped before it finished putting the snapshot's copy in the VM's place, and the Mac put the VM's own folder back as it was" });
  assert.deepEqual(taskOutcome(rollback, listing(""), `done ${SNAP} ffffffffffff\n`), { state: "failed", unchanged: true, words: "the Mac has no record of putting this snapshot back for this restore, so it did not begin, and the VM is as it was" }, "an earlier restore's done is not this one's");
  assert.equal(taskOutcome(rollback, listing(""), "unhealed\n").state, "failed");
  assert.deepEqual(taskOutcome(rollback, listing(""), "unhealed\n"), { state: "failed", words: "the VM's folder is missing, and the Mac has neither the snapshot's whole copy nor the VM's own folder set aside to put back" });
});

test("a restore puts the snapshot's copy in the VM's place and keeps the snapshot, so it can be restored again; the box resumes from the copy's memory", async () => {
  const { backend, snaps, vms } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(vms, guest.ref, "marker.txt"), "before");
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  writeFileSync(join(vms, guest.ref, "marker.txt"), "after");
  const plan = await backend.planSnapshots(guest, "macos-desktop", { id: SNAP, ref: SNAP, guest }, signal());
  assert.deepEqual([plan.restore.way, plan.restore.undo, plan.restore.why], ["rollback", "suspend-copy", null]);
  assert.deepEqual(plan.restore.sizeBack, { cores: 4, memoryMiB: 8192, diskGiB: 59 });
  assert.equal(plan.keep.way, "as-is");
  assert.equal(plan.fork.ok, true);
  assert.deepEqual(plan.fork.size, { cores: 4, memoryMiB: 8192, diskGiB: null }, "a fork keeps the copy's disk, as a Tart box keeps its image's");
  await backend.powerOff(guest, signal());
  assert.equal(await backend.power(guest), "stopped");
  assert.ok(existsSync(join(vms, guest.ref, "state.vzvmsave")), "the restore's stop is a suspend, never a hard stop");
  const recorded = recorder();
  await backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorded.hooks, signal());
  assert.match(recorded.tasks[0]!.ref, new RegExp(`^tart-rollback:${guest.ref}:${SNAP}:[0-9a-f]{12}$`));
  assert.deepEqual(await backend.providerTask(recorded.tasks[0]!, signal()), { state: "ok" });
  assert.equal(readFileSync(join(vms, guest.ref, "marker.txt"), "utf8"), "before");
  assert.ok(existsSync(join(vms, guest.ref, "state.vzvmsave")), "with the copy's memory");
  assert.equal(readFileSync(join(snaps, SNAP, "vm", "marker.txt"), "utf8"), "before", "the snapshot stays");
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".re")), [], "nothing left aside");
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest), "running");
  assert.ok(existsSync(join(snaps, ".rollbacks", guest.ref)));
  await backend.release(guest, releasing);
  assert.ok(!existsSync(join(snaps, ".rollbacks", guest.ref)), "the VM's release takes its restore journal with it");
});

test("a snapshot whose memory was saved under another macOS build or Tart is not restored, and the plan says to fork it", async () => {
  const { backend, mac } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  writeFileSync(join(mac, ".fake-macos-build"), "27B5");
  const plan = await backend.planSnapshots(guest, "macos-desktop", { id: SNAP, ref: SNAP, guest }, signal());
  assert.equal(plan.restore.way, "none");
  assert.match(plan.restore.why ?? "", /saved while the Mac ran macOS build 27A1, and the Mac runs 27B5 now, so BB Box does not restore it.*Fork it instead/);
  assert.equal(plan.fork.ok, true, "a fork starts from the disk");
  await backend.stop(guest);
  await assert.rejects(backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /27B5/.test(error.message));
  await backend.release(guest, releasing);
  assert.equal(savedUnder({ ...baseLabel("b", "v"), tart: "2.29.0" }, true, { macosBuild: "27A1", tart: "2.30.0" })?.startsWith("its memory was saved by Tart 2.29.0"), true);
  assert.equal(savedUnder({ ...baseLabel("b", "v"), macosBuild: "26A1" }, false, { macosBuild: "27A1", tart: "2.30.0" }), null, "a copy with no saved memory restores under any build");
});

test("a fork copies the snapshot's disk without its memory into a VM of its own, with a new MAC address and machine identifier, and claims it first", async () => {
  const { backend, vms, mac } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  await backend.stop(guest);
  const fork = identity("macos-desktop", { cores: 6, memoryMiB: 16384, diskGiB: null });
  const claims: Guest[] = [];
  const made = await backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, { ...acquiring, claim: async (one) => void claims.push(one) }, signal());
  assert.equal(made.ref, `bb-box-${fork.boxId}`);
  assert.deepEqual(made.data, { box: fork.boxId, forkOf: guest.ref, forkName: fork.name });
  assert.deepEqual(made.size, { cores: 6, memoryMiB: 16384, diskGiB: 59 });
  assert.equal(claims[0]?.ref, made.ref, "claimed before the copy");
  assert.ok(readFileSync(join(mac, ".bb-box", "tart", "owners", made.ref), "utf8").includes(`box=${fork.boxId}`));
  assert.ok(!existsSync(join(vms, made.ref, "state.vzvmsave")), "a fork starts from the disk, never the saved memory");
  const source = JSON.parse(readFileSync(join(vms, guest.ref, "config.json"), "utf8")) as { macAddress: string; ecid?: string };
  const copy = JSON.parse(readFileSync(join(vms, made.ref, "config.json"), "utf8")) as { macAddress: string; ecid?: string };
  assert.notEqual(copy.macAddress, source.macAddress);
  assert.ok(copy.ecid && copy.ecid !== source.ecid);
  assert.deepEqual(await backend.guestIdentity(made, signal()), { macs: { en0: copy.macAddress }, smbios: null });
  await backend.release(made, releasing);
  await backend.release(guest, releasing);
});

test("a Linux VM's snapshot forks into a VM of its own with a new MAC address, from its disk as it is: no machine identifier to change and nothing to clean on the Mac, as its own reset runs before its network; the plan offers fork and Keep", async () => {
  const { backend, vms, mac } = setup({ "tart-linux-image": "bb-box-linux" });
  writeFileSync(join(mac, ".fake-diskutil-no-image"), "");
  const box = identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null });
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.stop(guest);
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false, forkSafe: LINUX_FORK_SAFE_FROM }, recorder().hooks, signal());
  const plan = await backend.planSnapshots(guest, "linux-arm64", { id: SNAP, ref: SNAP, guest }, signal());
  assert.deepEqual([plan.fork.ok, plan.fork.why, plan.keep.way, plan.keep.why], [true, null, "as-is", null]);
  const fork = identity("linux-arm64", { cores: 4, memoryMiB: 8192, diskGiB: null });
  const made = await backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, acquiring, signal());
  assert.equal(made.ref, `bb-box-${fork.boxId}`);
  assert.deepEqual(made.data, { box: fork.boxId, os: "linux", forkOf: guest.ref, forkName: fork.name });
  assert.deepEqual([made.size?.cores, made.size?.memoryMiB], [4, 8192]);
  const source = JSON.parse(readFileSync(join(vms, guest.ref, "config.json"), "utf8")) as { macAddress: string };
  const copy = JSON.parse(readFileSync(join(vms, made.ref, "config.json"), "utf8")) as { macAddress: string };
  assert.notEqual(copy.macAddress, source.macAddress);
  const sets = tartCalls(mac).filter((call) => call[1] === "set" && call[2] === made.ref);
  assert.ok(sets.some((call) => call.includes("--random-mac")) && !sets.some((call) => call.includes("--random-serial")), "a new MAC address; a Linux VM has no Mac serial");
  assert.ok(!tartCalls(mac).some((call) => call[0] === "diskutil" && !call.includes("--help")), "nothing attached or cleaned on the Mac");
  assert.deepEqual(await backend.guestIdentity(made, signal()), { macs: { en0: copy.macAddress }, smbios: null });
  await backend.release(made, releasing);
  await backend.release(guest, releasing);
});

test("a Linux VM's snapshot taken before its box had the identity reset does not fork, and says a box from a refreshed image does", async () => {
  const { backend } = setup({ "tart-linux-image": "bb-box-linux", "tart-linux-desktop-image": "bb-box-linux-desktop" });
  const box = identity("linux-arm64", { cores: 2, memoryMiB: 4096, diskGiB: null });
  const guest = await backend.acquire(box, null, acquiring, signal());
  await backend.stop(guest);
  await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal());
  await backend.snapshot(guest, { id: OTHER, box: box.boxId, memory: false, forkSafe: LINUX_FORK_SAFE_FROM - 1 }, recorder().hooks, signal());
  for (const id of [SNAP, OTHER]) {
    const plan = await backend.planSnapshots(guest, "linux-arm64", { id, ref: id, guest }, signal());
    assert.deepEqual([plan.fork.ok, plan.fork.why], [false, "it was taken before its box had the identity reset, which boxes from a Linux image refreshed since have."], id);
  }
  await backend.release(guest, releasing);
});

test("a macOS box gets the identity reset installed at its first ready, only in a VM", () => {
  const script = identityInstallScript("#!/bin/sh\necho tool\n");
  assert.match(script, /^case "\$\(sysctl -n hw\.model 2>\/dev\/null\)" in VirtualMac\*\)/);
  assert.match(script, /\/Library\/LaunchDaemons\/dev\.bb-box\.identity\.plist/);
  assert.match(script, /bb-box-identity enable/);
  assert.match(script, /\[ -e \/var\/run\/bb-box-identity\/boot \] \|\| \/usr\/local\/sbin\/bb-box-identity boot/);
  assert.throws(() => identityInstallScript("BBBOX_IDENTITY_TOOL\n"), /ends its heredoc/);
  assert.match(macosIdentityTool(), /^VERSION=4$/m);
  assert.match(macosIdentityTool(), /ioreg -r -c AppleVirtIONetwork/, "only the VM's VirtIO cards, never the USB NCM placeholders en1 and anpi0");
});

function tool(root: string, macs: string, ...args: string[]) {
  const ran = spawnSync("/bin/sh", [join(import.meta.dirname, "..", "setup", "tart", "guest", "bb-box-identity-macos.sh"), ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH!, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_MACS: macs, BBBOX_IDENTITY_NIC_WAIT_TENTHS: "0" },
  });
  return { code: ran.status, out: ran.stdout, err: ran.stderr };
}

function status(root: string, macs: string): Record<string, string> {
  return Object.fromEntries(tool(root, macs, "status").out.trim().split("\n").map((line) => line.split("=") as [string, string]));
}

function macosBox(): string {
  const root = tempDir("macos-identity");
  const machine = join(root, "Users", "admin", ".bb-machines", "bb.example");
  mkdirSync(join(machine, "logs"), { recursive: true });
  writeFileSync(join(machine, "host-id"), "host_source1\n");
  writeFileSync(join(machine, "auth.json"), "{}");
  writeFileSync(join(machine, "host-artifact.sha256"), "abc\n");
  mkdirSync(join(root, "Users", "admin", ".config", "bb-box"), { recursive: true });
  writeFileSync(join(root, "Users", "admin", ".config", "bb-box", "env"), "GH_TOKEN=x\n");
  mkdirSync(join(root, "Users", "admin", "Library", "LaunchAgents"), { recursive: true });
  writeFileSync(join(root, "Users", "admin", "Library", "LaunchAgents", "app.getbb.host-daemon.bb-example-host_source1.plist"), "<plist/>");
  mkdirSync(join(root, "etc", "ssh"), { recursive: true });
  writeFileSync(join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"), "ssh-ed25519 OLDKEY\n");
  writeFileSync(join(root, "console-user"), "root\n");
  return root;
}

test("macOS's identity reset keeps a box whose MAC address matches its marker, and resets a copy at its boot: BB's credentials, its LaunchAgent and the access file go, the SSH host keys are new", () => {
  const root = macosBox();
  const box = "aa:bb:cc:00:00:01";
  assert.equal(tool(root, box, "boot").code, 0);
  assert.equal(status(root, box).boot, "off", "off until BB Box enables it");
  assert.equal(tool(root, box, "enable").code, 0);
  tool(root, box, "boot");
  assert.equal(status(root, box).boot, "unarmed");
  const written = tool(root, box, "write", "--box", "bxsource1", "--source", "device");
  assert.equal(written.code, 0, written.err);
  assert.equal(written.out, "bb-box identity 1\nbox bxsource1\nsource device\nmac aa:bb:cc:00:00:01\n");
  assert.deepEqual(status(root, box), { version: "4", enabled: "yes", boot: "unarmed", marker: "matches", armed: "yes", pending: "no", box: "bxsource1", source: "device", raced: "no" });
  tool(root, box, "boot");
  assert.equal(status(root, box).boot, "kept");
  assert.ok(existsSync(join(root, "Users", "admin", ".config", "bb-box", "env")));

  const fork = "aa:bb:cc:00:00:02";
  const reset = tool(root, fork, "boot");
  assert.equal(reset.code, 0, reset.err);
  assert.match(reset.out, /this box is a copy, so it resets its identity: none of the marker's MAC addresses \(aa:bb:cc:00:00:01\) is on this box's interfaces \(aa:bb:cc:00:00:02\)/);
  const after = status(root, fork);
  assert.deepEqual([after.boot, after.marker, after.armed, after.box, after.raced], ["reset", "matches", "yes", "", "no"]);
  const machine = join(root, "Users", "admin", ".bb-machines", "bb.example");
  assert.deepEqual(readdirSync(machine).sort(), ["host-artifact.sha256"]);
  assert.ok(!existsSync(join(root, "Users", "admin", ".config", "bb-box", "env")));
  assert.deepEqual(readdirSync(join(root, "Users", "admin", "Library", "LaunchAgents")), []);
  assert.doesNotMatch(readFileSync(join(root, "etc", "ssh", "ssh_host_ed25519_key.pub"), "utf8"), /OLDKEY/);
  assert.match(readFileSync(join(root, "var", "lib", "bb-box", "identity-resets"), "utf8"), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ .*; BB machines removed: host_source1$/m);
  tool(root, fork, "boot");
  assert.equal(status(root, fork).boot, "kept", "the next boot of the fork keeps it");
});

test("macOS's reset says when a user had logged in before it decided, and the fork check refuses such a fork", () => {
  const root = macosBox();
  tool(root, "aa:bb:cc:00:00:01", "enable");
  tool(root, "aa:bb:cc:00:00:01", "write", "--box", "bxsource1", "--source", "device");
  writeFileSync(join(root, "console-user"), "admin\n");
  tool(root, "aa:bb:cc:00:00:02", "boot");
  assert.equal(status(root, "aa:bb:cc:00:00:02").raced, "yes");
  assert.match(readFileSync(join(root, "var", "lib", "bb-box", "identity-resets"), "utf8"), /someone was logged in at the console \(admin admin\) while it decided or removed BB's machine/);
  const seen = parseForkSeen(`${tool(root, "aa:bb:cc:00:00:02", "status").out}tailnet_node=no\nmarker_mac=aa:bb:cc:00:00:02\naddress=192.168.64.9\naddresses_read=yes\nmachine_id=${"1".repeat(64)}\nhost_key=${"2".repeat(64)}\nprobes=done\n`, 0);
  const verdict = forkVerdict(seen, { forkMacs: ["aa:bb:cc:00:00:02"], forkValue: null, sourceMacs: ["aa:bb:cc:00:00:01"], sourceBox: "bxsource1", sourceName: "calm-otter", sourceAddresses: [], freedSourceAddresses: [], ownAddress: "192.168.64.9", boxAddresses: [], held: null, safeFrom: 1 });
  assert.deepEqual(verdict, { is: "refused", why: "its identity reset ran after a user had logged in, so BB's daemon may have started as its source before the reset" });
});

test("on macOS the checks read the hardware UUID, the users' homes, the LaunchAgents and ifconfig, never Linux's paths", () => {
  const safety = forkSafetyScript("macos");
  assert.match(safety, /IOPlatformUUID/);
  assert.match(safety, /shasum -a 256/);
  assert.doesNotMatch(safety, /etc\/machine-id|sha256sum/);
  const check = forkCheckScript("macos");
  assert.match(check, /\/Users\/\*\/\.bb-machines/);
  assert.match(check, /app\.getbb\.host-daemon/);
  assert.match(check, /ifconfig -a/);
  assert.doesNotMatch(check, /ip -o -4|\/home\/\*/);
  assert.match(forkCheckScript(), /ip -o -4/, "Linux's stays as it was");
});

function startedAt(pid: number): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

async function suspendedWithSnapshot() {
  const made = setup();
  const box = identity();
  const guest = await made.backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(made.vms, guest.ref, "marker.txt"), "before");
  await made.backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  writeFileSync(join(made.vms, guest.ref, "marker.txt"), "after");
  await made.backend.stop(guest);
  return { ...made, box, guest };
}

function cutShort(snaps: string, vms: string, vm: string, phase: "copying" | "swapping", parts: { readonly restore?: "whole" | "part"; readonly aside?: boolean; readonly pid?: string }) {
  const restore = join(snaps, `.restore-${vm}`);
  if (parts.restore) {
    mkdirSync(restore, { recursive: true });
    for (const file of readdirSync(join(snaps, SNAP, "vm"))) spawnSync("cp", ["--sparse=always", join(snaps, SNAP, "vm", file), join(restore, file)]);
    if (parts.restore === "whole") writeFileSync(join(restore, ".complete"), "");
  }
  if (parts.aside) renameSync(join(vms, vm), join(snaps, `.replaced-${vm}`));
  mkdirSync(join(snaps, ".rollbacks"), { recursive: true });
  writeFileSync(join(snaps, ".rollbacks", vm), `${phase} ${SNAP} a1b2c3d4e5f6 ${parts.pid ?? "999999 Thu Jan  1 00:00:00 1970"}\n`);
  return { ref: taskRef({ kind: "rollback", vm, id: SNAP, attempt: "a1b2c3d4e5f6" }), host: "mac1" };
}

test("a restore cut short between its two renames is put right when its task is read: the snapshot's whole copy goes in, or the VM's own folder back", async () => {
  const { backend, snaps, vms, guest } = await suspendedWithSnapshot();
  const task = cutShort(snaps, vms, guest.ref, "swapping", { restore: "whole", aside: true });
  assert.ok(!existsSync(join(vms, guest.ref)), "no VM folder while it was cut short");
  assert.deepEqual(await backend.providerTask(task, signal()), { state: "ok" });
  assert.equal(readFileSync(join(vms, guest.ref, "marker.txt"), "utf8"), "before", "the snapshot's whole copy went in");
  assert.ok(!existsSync(join(vms, guest.ref, ".complete")));
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".re")), [], "nothing left aside");

  const second = cutShort(snaps, vms, guest.ref, "swapping", { restore: "part", aside: true });
  const answer = await backend.providerTask(second, signal());
  assert.deepEqual([answer.state, answer.state === "failed" && answer.unchanged], ["failed", true]);
  assert.equal(readFileSync(join(vms, guest.ref, "marker.txt"), "utf8"), "before", "the VM's own folder is back");
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".re")), []);
  await backend.release(guest, releasing);
});

test("a restore cut short while it copied leaves the VM as it was, and its part-made copy goes", async () => {
  const { backend, snaps, vms, guest } = await suspendedWithSnapshot();
  const task = cutShort(snaps, vms, guest.ref, "copying", { restore: "part" });
  const answer = await backend.providerTask(task, signal());
  assert.deepEqual([answer.state, answer.state === "failed" && answer.unchanged], ["failed", true]);
  assert.equal(readFileSync(join(vms, guest.ref, "marker.txt"), "utf8"), "after");
  assert.ok(!existsSync(join(snaps, `.restore-${guest.ref}`)));
  await backend.release(guest, releasing);
});

test("a box whose restore was cut short is put right when it starts or its power is read, and a restore still running holds both", async () => {
  const { backend, snaps, vms, guest } = await suspendedWithSnapshot();
  const live = `${process.pid} ${startedAt(process.pid)}`;
  cutShort(snaps, vms, guest.ref, "swapping", { restore: "whole", aside: true, pid: live });
  assert.equal(await backend.power(guest), "stopped", "never gone while a restore runs");
  await assert.rejects(backend.start(guest, signal()), /BB Box is putting a snapshot in the place of bb-box-\S+ on the Mac, so it does not start it until that has ended/);
  assert.ok(!existsSync(join(vms, guest.ref)), "nothing moved under a live restore");
  writeFileSync(join(snaps, ".rollbacks", guest.ref), `swapping ${SNAP} a1b2c3d4e5f6 ${process.pid} Thu Jan  1 00:00:00 1970\n`);
  assert.equal(await backend.power(guest), "stopped", "a reused PID with another start time is not the restore's shell, so the power read puts the copy in");
  assert.equal(readFileSync(join(vms, guest.ref, "marker.txt"), "utf8"), "before");
  cutShort(snaps, vms, guest.ref, "swapping", { restore: "part", aside: true });
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a release deletes what a restore or a fork cut short left beside the VMs, and the restore's journal", async () => {
  const { backend, snaps, vms, guest } = await suspendedWithSnapshot();
  cutShort(snaps, vms, guest.ref, "swapping", { restore: "part", aside: true });
  mkdirSync(join(snaps, `.fork-${guest.ref}`));
  writeFileSync(join(snaps, `.fork-${guest.ref}`, "disk.img"), "x");
  await backend.release(guest, releasing);
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".") && entry !== ".rollbacks"), []);
  assert.ok(!existsSync(join(snaps, ".rollbacks", guest.ref)));
  assert.ok(!existsSync(join(vms, guest.ref)), "the VM went too");
});

test("each restore has its own attempt, and the journal says copying then swapping with the shell's PID and start time, just before the first rename", async () => {
  const { backend, snaps, guest, mac } = await suspendedWithSnapshot();
  const first = recorder();
  await backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, first.hooks, signal());
  const second = recorder();
  await backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, second.hooks, signal());
  assert.notEqual(first.tasks[0]!.ref, second.tasks[0]!.ref);
  assert.equal((await backend.providerTask(first.tasks[0]!, signal())).state, "failed", "the second's done is not the first's");
  assert.deepEqual(await backend.providerTask(second.tasks[0]!, signal()), { state: "ok" });
  const journal = readFileSync(join(snaps, ".rollbacks", guest.ref), "utf8");
  assert.match(journal, new RegExp(`^done ${SNAP} [0-9a-f]{12}\\n$`));
  const script = (await import("../src/backends/tart/snapshots.ts")).rollbackScript(guest.ref, "test", guest.data!.box as string, SNAP, 50, "a1b2c3d4e5f6");
  assert.ok(script.indexOf('journal "$vm" "swapping') < script.lastIndexOf('mv "$v" "$a"') && script.indexOf('journal "$vm" "copying') < script.lastIndexOf('copy_vm_files "$sd/vm"'));
  assert.ok(script.lastIndexOf('copy_vm_files "$sd/vm"') < script.indexOf('[ "$(state "$vm")" != running ] || undone') && script.indexOf('[ "$(state "$vm")" != running ] || undone') < script.indexOf('journal "$vm" "swapping'), "the VM's state is read again just before the swap");
  void mac;
  await backend.release(guest, releasing);
});

test("memory saved before a macOS update is labelled with the build that saved it, so it is not restored after; memory with no note of its build is not restored either", async () => {
  const { backend, mac, guest, box, snaps } = await suspendedWithSnapshot();
  writeFileSync(join(mac, ".fake-macos-build"), "27B5");
  await backend.snapshot(guest, { id: OTHER, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  assert.equal(label(snaps, OTHER).macos, "27A1", "the build the suspend saved its memory under, not the Mac's now");
  const plan = await backend.planSnapshots(guest, "macos-desktop", { id: OTHER, ref: OTHER, guest }, signal());
  assert.match(plan.restore.why ?? "", /saved while the Mac ran macOS build 27A1, and the Mac runs 27B5 now/);
  rmSync(join(mac, ".bb-box", "tart", "run", `${guest.ref}.saved-under`));
  await backend.deleteSnapshot({ id: OTHER, ref: OTHER, guest }, recorder().hooks, signal());
  await backend.snapshot(guest, { id: OTHER, box: box.boxId, memory: true, forkSafe: 3 }, recorder().hooks, signal());
  assert.deepEqual([label(snaps, OTHER).macos, label(snaps, OTHER).tart], ["unknown", "unknown"]);
  assert.match((await backend.planSnapshots(guest, "macos-desktop", { id: OTHER, ref: OTHER, guest }, signal())).restore.why ?? "", /does not know which macOS build and Tart saved its memory/);
  await backend.release(guest, releasing);
});

test("the start just after a restore never boots the VM from its disk when the snapshot's memory does not resume, and says so; a later start does", async () => {
  const { backend, guest, vms } = await suspendedWithSnapshot();
  await backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal());
  writeFileSync(join(vms, guest.ref, "state.vzvmsave"), "corrupt");
  await assert.rejects(backend.start(guest, signal()), /did not resume, so BB Box did not boot it from its disk/);
  assert.ok(existsSync(join(vms, guest.ref, "state.vzvmsave")), "its memory is kept");
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a copy APFS cannot clone is refused, never made in full, and the box resumes", async () => {
  const { backend, mac, snaps } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(mac, ".fake-clone-fails"), "");
  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /APFS could not clone .* and BB Box makes no full copy of a VM/.test(error.message));
  assert.ok(!existsSync(join(snaps, SNAP)) && !existsSync(join(snaps, `${SNAP}.part`)));
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing);
});

test("a take whose box does not resume says the box is stopped, with why", async () => {
  const { backend, mac } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring, signal());
  writeFileSync(join(mac, ".fake-tart-run-fails"), "2");
  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: true }, recorder().hooks, signal());
  assert.match(taken.notResumed ?? "", /could not start bb-box-\S+ on mac1/);
  assert.equal(await backend.power(guest), "stopped");
  await backend.release(guest, releasing);
});

function dataVolume(mac: string): void {
  const volume = join(mac, ".fake-data-volume");
  const files: Record<string, string> = {
    "Users/admin/.bb-machines/bb.example/host-id": "host_source1\n",
    "Users/admin/.bb-machines/bb.example/auth.json": "{}",
    "Users/admin/.bb-machines/bb.example/host-artifact.sha256": "abc\n",
    "Users/admin/.bb-machines/bb.example/logs/daemon.log": "x",
    "Users/admin/Library/LaunchAgents/app.getbb.host-daemon.bb-example-host_source1.plist": "<plist/>",
    "Users/admin/Library/LaunchAgents/com.trycua.cua-driver.plist": "<plist/>",
    "Users/admin/.config/bb-box/env": "GH_TOKEN=x\n",
    "Users/admin/.config/bb-box/vm": "bb-box-source\n",
    "Users/admin/work.txt": "kept\n",
    "private/etc/ssh/ssh_host_ed25519_key": "OLD",
    "private/etc/ssh/ssh_host_ed25519_key.pub": "ssh-ed25519 OLD\n",
    "private/etc/bb-box/identity": "bb-box identity 1\n",
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(volume, path, ".."), { recursive: true });
    writeFileSync(join(volume, path), text);
  }
}

test("a fork's disk loses its source's BB machine, LaunchAgent, access file, VM name and SSH host keys on the Mac, before its first boot, from its own container only", async () => {
  const { backend, vms, mac, guest } = await suspendedWithSnapshot();
  dataVolume(mac);
  const fork = identity();
  const made = await backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, acquiring, signal());
  const volume = join(vms, made.ref, "disk.img.data");
  const left = (path: string) => existsSync(join(volume, path));
  assert.deepEqual(
    ["Users/admin/.bb-machines/bb.example/host-id", "Users/admin/.bb-machines/bb.example/auth.json", "Users/admin/.bb-machines/bb.example/logs", "Users/admin/Library/LaunchAgents/app.getbb.host-daemon.bb-example-host_source1.plist", "Users/admin/.config/bb-box/env", "Users/admin/.config/bb-box/vm", "private/etc/ssh/ssh_host_ed25519_key", "private/etc/ssh/ssh_host_ed25519_key.pub"].filter(left),
    [],
  );
  assert.ok(left("Users/admin/.bb-machines/bb.example/host-artifact.sha256") && left("Users/admin/Library/LaunchAgents/com.trycua.cua-driver.plist") && left("Users/admin/work.txt") && left("private/etc/bb-box/identity"), "the rest of the disk stays, the marker too, so its own reset still runs");
  const calls = tartCalls(mac).filter((call) => call[0] === "diskutil" && !call.includes("--help")).map((call) => call.slice(1, 3).join(" "));
  assert.deepEqual(calls.filter((call) => /^(image attach|mount|unmount|eject)/.test(call)).map((call) => call.split(" ")[0]), ["image", "mount", "unmount", "eject"]);
  assert.equal(readFileSync(join(mac, ".fake-diskutil.json"), "utf8"), "{}", "nothing left attached");
  await backend.release(made, releasing);
});

test("a fork whose disk would mount from the Mac's own container, or will not attach, is refused, and nothing is left", async () => {
  const { backend, vms, mac, guest } = await suspendedWithSnapshot();
  dataVolume(mac);
  writeFileSync(join(mac, ".fake-diskutil-container"), "disk3");
  const fork = identity();
  await assert.rejects(backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, acquiring, signal()), /names the Mac's own container, so BB Box changed nothing.*could not remove the source's identity from the fork's disk before its first boot, so it makes no fork/s);
  assert.ok(!existsSync(join(vms, `bb-box-${fork.boxId}`)));
  assert.ok(!tartCalls(mac).some((call) => call[0] === "diskutil" && call[1] === "mount"), "nothing mounted");
  rmSync(join(mac, ".fake-diskutil-container"));
  writeFileSync(join(mac, ".fake-diskutil-attach-fails"), "");
  await assert.rejects(backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, identity(), null, acquiring, signal()), /diskutil could not attach the fork's disk/);
  await backend.release(guest, releasing);
});

test("a fork is never made over a VM that is there already, so it always gets a new MAC address and machine identifier", async () => {
  const { backend, vms, mac, guest } = await suspendedWithSnapshot();
  dataVolume(mac);
  const fork = identity();
  spawnSync("cp", ["-r", "--sparse=always", join(vms, guest.ref), join(vms, `bb-box-${fork.boxId}`)]);
  await assert.rejects(backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, acquiring, signal()), /is there already, so BB Box makes no fork over it/);
  await backend.release(guest, releasing);
});

test("macOS's reset records a race when someone logs in while it removes BB's machine, not only before it decides", () => {
  const root = macosBox();
  tool(root, "aa:bb:cc:00:00:01", "enable");
  tool(root, "aa:bb:cc:00:00:01", "write", "--box", "bxsource1", "--source", "device");
  writeFileSync(join(root, "console-users"), "root\nadmin\n");
  tool(root, "aa:bb:cc:00:00:02", "boot");
  assert.equal(status(root, "aa:bb:cc:00:00:02").raced, "yes");
  assert.match(readFileSync(join(root, "var", "lib", "bb-box", "identity-resets"), "utf8"), /someone was logged in at the console \(root admin\) while it decided or removed BB's machine/);
});

test("the restore's words follow the backend: Tart suspends and its undo holds memory", async () => {
  const { restoreCheckText } = await import("../src/plugin/snapshot-words.ts");
  const { backend, guest } = await suspendedWithSnapshot();
  const record = { id: SNAP, name: "before", takenAt: Date.UTC(2026, 10, 1), holds: "disk-and-memory", excludes: null } as never;
  const check = { snapshot: record, box: { name: "gate", guest } as never, onAMachine: false, plan: "", swap: false, fromSnapshot: false, costWords: null, undo: { kind: "snapshot", name: "before the restore at 00:35", aboutMs: 200, bytes: null, price: null }, from: null, to: null, anyway: [], leavesOnEarlierGuest: 0, replaces: null, storage: "/", undoRefused: null, capture: "suspend", gpuStay: null, userspaceNote: null } as const;
  const text = restoreCheckText(check as never);
  assert.match(text, /- suspend it, which saves its memory: it is never stopped hard;/);
  assert.match(text, /a snapshot of it suspended, with its memory, so undoing brings it back running as it is now/);
  assert.match(text, /- put the snapshot's copy in its place, and resume it;/);
  assert.doesNotMatch(text, /without a clean shutdown|roll its disk back/);
  await backend.release(guest, releasing);
});

test("a login during the reset of a disk that holds nothing of BB's, as a fork's after the Mac removed it, is no race: nothing of the source's could act", () => {
  const root = macosBox();
  tool(root, "aa:bb:cc:00:00:01", "enable");
  tool(root, "aa:bb:cc:00:00:01", "write", "--box", "bxsource1", "--source", "device");
  rmSync(join(root, "Users", "admin", ".bb-machines", "bb.example", "host-id"));
  rmSync(join(root, "Users", "admin", "Library", "LaunchAgents", "app.getbb.host-daemon.bb-example-host_source1.plist"));
  writeFileSync(join(root, "console-users"), "admin\nadmin\n");
  tool(root, "aa:bb:cc:00:00:02", "boot");
  assert.deepEqual([status(root, "aa:bb:cc:00:00:02").boot, status(root, "aa:bb:cc:00:00:02").raced], ["reset", "no"]);
  assert.match(readFileSync(join(root, "var", "lib", "bb-box", "identity-resets"), "utf8"), /BB machines removed: none$/m);
});

test("a Mac whose diskutil cannot attach a disk image makes no macOS forks, says which macOS has it, and the doctor says so; there is no other way to clean a fork's disk", async () => {
  const { backend, vms, mac, guest } = await suspendedWithSnapshot();
  const forks = async () => (await backend.doctor()).checks.find((check) => check.id === "forks.mac1");
  assert.equal((await forks())?.status, "ok");
  writeFileSync(join(mac, ".fake-diskutil-no-image"), "");
  const plan = await backend.planSnapshots(guest, "macos-desktop", { id: SNAP, ref: SNAP, guest }, signal());
  assert.deepEqual([plan.fork.ok, plan.fork.why], [false, `${NO_IMAGE_ATTACH}.`]);
  assert.match(NO_IMAGE_ATTACH, /macOS 27 has/);
  assert.equal(plan.restore.way, "rollback", "takes and restores go on");
  const fork = identity();
  await assert.rejects(backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, fork, null, acquiring, signal()), /The Mac's diskutil has no image attach/);
  assert.ok(!existsSync(join(vms, `bb-box-${fork.boxId}`)));
  assert.ok(!tartCalls(mac).some((call) => call[0] === "hdiutil"), "never hdiutil");
  const check = await forks();
  assert.deepEqual([check?.status, check?.fix], ["warn", "Update mac1 to macOS 27 or later to make macOS forks there."]);
  await backend.release(guest, releasing);
});

function throughGuestTool(backend: TartBackend, testRoot: { readonly root: string; readonly tool: string }): void {
  const transports = backend.transports.bind(backend);
  backend.transports = async (guest, kind) => {
    const found = await transports(guest, kind);
    const command = found.command;
    if (!command) return found;
    const run = (script: string, options?: Parameters<typeof command.run>[1]) => command.run(`sudo() { [ "$1" = -n ] && shift; "$@"; }\nexport BBBOX_IDENTITY_ROOT=${quote(testRoot.root)}\n${script.replaceAll(IDENTITY_TOOL, testRoot.tool)}`, options);
    return { ...found, command: new Proxy(command, { get: (target, key) => (key === "run" ? run : typeof Reflect.get(target, key) === "function" ? Reflect.get(target, key).bind(target) : Reflect.get(target, key)) }) };
  };
}

test("070 close-out: through BB Box's own boxes and snapshots, a Tart Linux box that BB Box stops takes a fork-safe snapshot, its identity reset read just before the stop, and Keep takes it; one stopped another way takes one that is not fork-safe", async () => {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  fakeMacTools(mac);
  addImage(mac);
  addImage(mac, "bb-box-linux", "linux");
  const guest = identityGuest();
  mkdirSync(join(guest.root, "sys/class/net/eth0/device"), { recursive: true });
  let tart: TartBackend | null = null;
  const state = world({
    backend: (storage) => {
      tart = new TartBackend(tartConfig({ "tart-linux-image": "bb-box-linux" }), testContext(storage, "test", { id: "fake" }), FAKES);
      made.push(tart);
      throughGuestTool(tart, guest);
      return tart;
    },
  });
  const asked = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux-arm64", who: BY_COMMAND });
  const box = (await state.boxes.settled(asked))!;
  assert.equal(box.state, "ready");
  assert.ok(box.identityMarkedAt, "core wrote the marker, of the VM's card");
  await state.boxes.stop(THREAD, box.id, undefined, BY_COMMAND);
  const stopped = (await state.boxes.find(box.id))!;
  assert.equal(stopped.stopForkSafety?.version, 9);
  const taken = (await state.snapshots.take(COMMAND, stopped, standing(stopped), { name: "stopped" })).snapshot!;
  assert.equal(state.store.record(taken.id)?.forkSafe, 9, "read through the box's own reset, not given by hand");
  const plan = await tart!.planSnapshots(stopped.guest!, "linux-arm64", { id: taken.id, ref: state.store.record(taken.id)!.ref!, guest: stopped.guest! }, signal());
  assert.deepEqual([plan.fork.ok, plan.keep.way], [true, "as-is"]);
  await state.snapshots.keep(COMMAND, standing(stopped), taken.id, { days: 30 });
  assert.notEqual(state.store.record(taken.id)?.keptUntil, null);
  assert.ok(stopped.stopForkSafety?.mark?.includes("nvram.bin "), "the mark is the stopped VM's files, read on the Mac");
  await tart!.start(stopped.guest!);
  await tart!.stop!(stopped.guest!);
  const ranOutside = (await state.boxes.find(box.id))!;
  assert.ok(ranOutside.state === "stopped" && ranOutside.stopForkSafety, "BB Box has not seen the run");
  const afterRun = (await state.snapshots.take(COMMAND, ranOutside, standing(ranOutside), { name: "after a run outside" })).snapshot!;
  assert.deepEqual([state.store.record(afterRun.id)?.forkSafe, state.store.record(afterRun.id)?.forkSafeWhy], [null, "unread"], "the VM's files changed as it ran, so the reading is not its own");
  await state.boxes.start(THREAD, box.id, undefined, BY_COMMAND);
  await tart!.stop!(box.guest!);
  await state.boxes.refresh(THREAD, box.id);
  const outside = (await state.boxes.find(box.id))!;
  assert.equal(outside.state, "stopped");
  const other = (await state.snapshots.take(COMMAND, outside, standing(outside), { name: "outside" })).snapshot!;
  assert.equal(state.store.record(other.id)?.forkSafe, null);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
});
