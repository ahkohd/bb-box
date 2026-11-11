import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { TURN_LOCK, script, turnSh } from "../src/backends/tart/host.ts";
import { qemuCloneScript, qemuRemoveBuildScript, qemuReplaceScript, qemuScript } from "../src/backends/tart/qemu.ts";
import { SNAPSHOTS_FOLDER, WINDOWS_NO_FORKS, parseTaskRef, taskRef, tartOffer } from "../src/backends/tart/snapshots.ts";
import { BackendError, SnapshotFailed, type AcquireHooks, type BoxIdentity, type Guest, type MachineSize, type ReleaseHooks, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { quote } from "../src/transports/process.ts";
import { FAKE_MAC, FAKE_WINDOWS_IMAGE, addImage, addWindowsImage, fakeMacTools, fakeQemu, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";
import { COMMAND, THREAD, rejection, standing, untilHeld, world } from "./snapshot-world.ts";

const MAC = FAKE_MAC;
const GUEST = "127.0.0.1";
const KIND = "windows-arm64-desktop";
const SMALL: MachineSize = { cores: 4, memoryMiB: 8192, diskGiB: null };
const SNAP = "snaaaaaaaaaaaa";
const UNDO = "snbbbbbbbbbbbb";
const DEAD_SHELL = "999999 Thu Jan  1 00:00:00 1970";
const ATTEMPT = "a1b2c3d4e5f6";
const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, fillQuietMs: 0, windowsShutdownWaitS: 3 };
const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const acquiring: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(60_000);

const made: TartBackend[] = [];
const macs: string[] = [];
afterEach(async () => {
  for (const backend of made.splice(0)) await backend.dispose();
});
after(() => {
  for (const mac of macs) {
    const vms = join(mac, ".bb-box", "qemu", "vms");
    for (const vm of existsSync(vms) ? readdirSync(vms) : []) rmSync(join(vms, vm, "pid"), { force: true });
  }
});

function windowsGuest(ssh: ReturnType<typeof fakeSsh>, qemu: string): void {
  ssh.windows(GUEST);
  ssh.powershell(
    GUEST,
    [
      `case "$1" in`,
      `  *Stop-Computer*) echo off >> "$HOME/off"; [ ! -f "$HOME/unreachable" ] || exit 255; [ -f "$HOME/stuck" ] || kill "$(cat ${qemu}/vms/*/pid)"; echo "powering off";;`,
      `  *"Get-Process explorer"*) [ ! -f "$HOME/slow-desktop" ] || sleep 2; exit 0;;`,
      `  *Set-Date*|*Add-Type*|*Get-Volume*|*Get-FileHash*) exit 0;;`,
      `  *"Test-Path -LiteralPath"*bb-box-stream.exe*) exit 3;;`,
      `  *) exec sh -c "$1";;`,
      `esac`,
      ``,
    ].join("\n"),
  );
}

function setup(options: Partial<TartBackendOptions> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  macs.push(mac);
  fakeMacTools(mac);
  fakeQemu(mac);
  addImage(mac);
  const build = addWindowsImage(mac);
  const qemu = join(mac, ".bb-box", "qemu");
  windowsGuest(ssh, qemu);
  const config = tartConfig({ "tart-windows-image": FAKE_WINDOWS_IMAGE, "tart-reserve-disk-gib": 0 });
  const make = () => {
    const backend = new TartBackend(config, testContext(new MemoryStorage(), "test"), { ...FAKES, ...options });
    made.push(backend);
    return backend;
  };
  return { ssh, mac, build, qemu, config, make, backend: make(), snaps: join(mac, ".tart", SNAPSHOTS_FOLDER), guestHome: ssh.home(GUEST) };
}

let counter = 0;
function identity(): BoxIdentity {
  counter++;
  return { boxId: `wsnap${counter}`, threadId: "thr_abc123", name: `still-heron-${counter}`, kind: KIND, createdAt: 1_790_000_000_000, size: { ...SMALL, gpu: "none" } };
}

function recorder(): { hooks: SnapshotHooks; tasks: TaskRef[] } {
  const tasks: TaskRef[] = [];
  return {
    tasks,
    hooks: {
      submitting: async () => {},
      task: async (task) => {
        tasks.push(task);
      },
    },
  };
}

function runs(mac: string): string[][] {
  const file = join(mac, ".fake-qemu-log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]) : [];
}

function qmpCommands(mac: string): string[] {
  const file = join(mac, ".fake-qmp-log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").map((line) => (JSON.parse(line) as { execute: string }).execute) : [];
}

function label(snaps: string, id: string): Record<string, string> {
  return Object.fromEntries(readFileSync(join(snaps, id, "label"), "utf8").trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function vmDir(qemu: string, guest: Guest): string {
  return join(qemu, "vms", guest.ref);
}

function writeOnDisk(qemu: string, guest: Guest, text: string): void {
  appendFileSync(join(vmDir(qemu, guest), "disk.qcow2"), `file=${text}\n`);
}

function fileOnDisk(qemu: string, guest: Guest): string | null {
  const lines = readFileSync(join(vmDir(qemu, guest), "disk.qcow2"), "utf8").split("\n").filter((line) => line.startsWith("file="));
  return lines.at(-1)?.slice("file=".length) ?? null;
}

function lowDisk(mac: string): void {
  writeFileSync(join(mac, ".nix-profile", "bin", "df"), `#!/bin/sh\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho 'fake 1073741824 1063256064 10485760 99% /'\n`);
}

async function runningBox(options: Partial<TartBackendOptions> = {}) {
  const made = setup(options);
  const box = identity();
  const guest = await made.backend.acquire(box, null, acquiring, signal());
  return { ...made, box, guest };
}

async function stoppedWithSnapshot() {
  const made = await runningBox();
  writeOnDisk(made.qemu, made.guest, "A");
  await made.backend.snapshot(made.guest, { id: SNAP, box: made.box.boxId, memory: false }, recorder().hooks, signal());
  writeOnDisk(made.qemu, made.guest, "B");
  await made.backend.powerOff(made.guest, signal());
  return made;
}

function cutShort(made: { snaps: string; qemu: string }, guest: Guest, phase: "copying" | "swapping", parts: { readonly restore?: "whole" | "part"; readonly aside?: boolean; readonly shell?: string }): TaskRef {
  const restore = join(made.snaps, `.restore-${guest.ref}`);
  if (parts.restore) {
    mkdirSync(restore, { recursive: true });
    for (const file of readdirSync(join(made.snaps, SNAP, "vm"))) writeFileSync(join(restore, file), readFileSync(join(made.snaps, SNAP, "vm", file)));
    if (parts.restore === "whole") writeFileSync(join(restore, ".complete"), "");
  }
  if (parts.aside) renameSync(vmDir(made.qemu, guest), join(made.snaps, `.replaced-${guest.ref}`));
  mkdirSync(join(made.snaps, ".rollbacks"), { recursive: true });
  writeFileSync(join(made.snaps, ".rollbacks", guest.ref), `${phase} ${SNAP} ${ATTEMPT} ${parts.shell ?? DEAD_SHELL}\n`);
  return { ref: taskRef({ kind: "rollback", engine: "qemu", vm: guest.ref, id: SNAP, attempt: ATTEMPT }), host: "mac1" };
}

function startedAt(pid: number): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

test("a Windows box on Tart takes snapshots of its disk only while stopped, restores them in place, and neither forks nor keeps them, saying why", () => {
  const { backend } = setup();

  const offer = backend.snapshotting(KIND);

  assert.deepEqual(offer, tartOffer("windows"));
  assert.deepEqual([offer?.scope, offer?.holds, offer?.whileRunning, offer?.restore, offer?.fork, offer?.keepsPastRelease, offer?.lives, offer?.outlivesGuest], ["box", ["disk"], "stopped-only", "in-place", "none", "no", "host", true]);
  assert.equal(offer?.forkWhy, WINDOWS_NO_FORKS);
  assert.equal(backend.identitySource(KIND), null, "no identity reset is installed or read");
});

test("a take of a running Windows box shuts Windows down, copies its overlay, UEFI variables and config alone, and boots it afresh", async () => {
  const { backend, mac, qemu, snaps, guestHome, box, guest, build } = await runningBox();
  writeOnDisk(qemu, guest, "A");
  writeFileSync(join(guestHome, "slow-desktop"), "");
  const plan = await backend.planSnapshots(guest, KIND, null, signal());
  const before = runs(mac).length;

  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal());

  assert.deepEqual([plan.take.ok, plan.take.pause.pauses, plan.take.memory], [true, true, null]);
  assert.match(plan.take.memoryWhy ?? "", /copies a Windows box's disk once Windows has shut down/);
  assert.equal(readFileSync(join(guestHome, "off"), "utf8"), "off\n", "Windows was asked to shut down");
  assert.deepEqual(readdirSync(join(snaps, SNAP, "vm")).sort(), ["config", "disk.qcow2", "vars.fd"]);
  assert.match(readFileSync(join(snaps, SNAP, "vm", "disk.qcow2"), "utf8"), /file=A/);
  assert.deepEqual([label(snaps, SNAP).os, label(snaps, SNAP).holds, label(snaps, SNAP).image, label(snaps, SNAP).build, label(snaps, SNAP).box], ["windows", "disk", FAKE_WINDOWS_IMAGE, build.split("/").pop(), box.boxId]);
  assert.equal(taken.holds, "disk");
  assert.ok((taken.pausedMs ?? 0) >= 2_000, "the pause lasts until Windows' desktop is up again, not until QEMU starts");
  assert.equal(taken.notResumed, null);
  const boots = runs(mac).slice(before);
  assert.equal(boots.length, 1);
  assert.ok(!boots[0]!.includes("-incoming"), "booted afresh, not from saved memory");
  assert.equal(await backend.power(guest, signal()), "running");
  await backend.release(guest, releasing, signal());
});

test("a take of a stopped Windows box with its memory saved resumes it, shuts Windows down, copies the disk, and leaves the box stopped with no saved memory", async () => {
  const { backend, mac, qemu, snaps, guestHome, box, guest } = await runningBox();
  await backend.stop(guest, signal());
  assert.ok(existsSync(join(vmDir(qemu, guest), "state")), "an ordinary stop saves the memory");
  const before = runs(mac).length;

  const taken = await backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal());

  const resumed = runs(mac).slice(before);
  assert.equal(resumed.length, 1);
  assert.ok(resumed[0]!.includes("-incoming"), "it resumed from its memory to shut down");
  assert.equal(readFileSync(join(guestHome, "off"), "utf8"), "off\n");
  assert.ok(!existsSync(join(vmDir(qemu, guest), "state")));
  assert.ok(!readdirSync(join(snaps, SNAP, "vm")).includes("state"));
  assert.equal(taken.pausedMs, null);
  assert.equal(await backend.power(guest, signal()), "stopped");
  await backend.release(guest, releasing, signal());
});

test("Windows that cannot be reached to shut down is shut down by QEMU's ACPI power button", async () => {
  const { backend, mac, qemu, guestHome, guest } = await runningBox();
  writeFileSync(join(guestHome, "unreachable"), "");

  await backend.powerOff(guest, signal());

  assert.ok(qmpCommands(mac).includes("system_powerdown"));
  assert.ok(!existsSync(join(vmDir(qemu, guest), "state")), "no memory is saved");
  assert.equal(await backend.power(guest, signal()), "stopped");
  await backend.release(guest, releasing, signal());
});

test("a Windows take whose Windows does not shut down in time copies nothing and boots the box again", async () => {
  const { backend, mac, qemu, snaps, guestHome, box, guest } = await runningBox();
  writeFileSync(join(guestHome, "stuck"), "");
  writeFileSync(join(mac, ".fake-qemu-no-powerdown"), "");

  await assert.rejects(backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /Windows did not shut down within 3 s, so BB Box ended QEMU/.test(error.message) && error.notResumed === null);

  assert.ok(!existsSync(join(snaps, SNAP)) && !existsSync(join(snaps, `${SNAP}.part`)));
  assert.equal(await backend.power(guest, signal()), "running");
  void qemu;
  await backend.release(guest, releasing, signal());
});

test("a Windows take with too little free on the VMs' volume is refused before Windows is shut down", async () => {
  const { backend, mac, snaps, guestHome, box, guest } = await runningBox();
  const pid = readFileSync(join(setupQemuDir(mac), "vms", guest.ref, "pid"), "utf8");
  lowDisk(mac);

  const plan = await backend.planSnapshots(guest, KIND, null, signal());
  const refused = backend.snapshot(guest, { id: SNAP, box: box.boxId, memory: false }, recorder().hooks, signal());

  assert.equal(plan.take.ok, false);
  assert.match(plan.take.why ?? "", /has 10 GiB free, and BB Box copies a VM there only with at least 20 GiB free/);
  await assert.rejects(refused, (error: unknown) => error instanceof SnapshotFailed && /10 GiB free.*BB Box stopped nothing\./.test(error.message));
  assert.ok(!existsSync(join(guestHome, "off")), "Windows was never asked to shut down");
  assert.equal(readFileSync(join(setupQemuDir(mac), "vms", guest.ref, "pid"), "utf8"), pid, "the same QEMU runs");
  assert.ok(!existsSync(join(snaps, SNAP)));
  await backend.release(guest, releasing, signal());
});

function setupQemuDir(mac: string): string {
  return join(mac, ".bb-box", "qemu");
}

test("a restore puts the snapshot's disk set in the VM's place, keeps the VM's ports, never resumes saved memory, and boots afresh; the undo puts the later disk back", async () => {
  const { backend, mac, qemu, snaps, box, guest } = await stoppedWithSnapshot();
  const ports = readFileSync(join(vmDir(qemu, guest), "config"), "utf8").split("\n").filter((line) => /^(ssh|vnc)=/.test(line));
  writeFileSync(join(snaps, SNAP, "vm", "config"), readFileSync(join(snaps, SNAP, "vm", "config"), "utf8").replace(/^ssh=\d+$/m, "ssh=42998"));
  await backend.snapshot(guest, { id: UNDO, box: box.boxId, memory: false }, recorder().hooks, signal());
  writeFileSync(join(vmDir(qemu, guest), "state"), "saved running\n");

  const plan = await backend.planSnapshots(guest, KIND, { id: SNAP, ref: SNAP, guest }, signal());
  const steps = recorder();
  await backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, steps.hooks, signal());

  assert.deepEqual([plan.restore.way, plan.restore.undo, plan.restore.sizeBack], ["rollback", "snapshot", { cores: 4, memoryMiB: 8192, diskGiB: 64 }]);
  assert.equal(fileOnDisk(qemu, guest), "A");
  assert.ok(!existsSync(join(vmDir(qemu, guest), "state")), "the stale saved memory is gone");
  assert.deepEqual(readFileSync(join(vmDir(qemu, guest), "config"), "utf8").split("\n").filter((line) => /^(ssh|vnc)=/.test(line)), ports);
  assert.match(steps.tasks[0]!.ref, /^qemu-rollback:/);
  assert.deepEqual(await backend.providerTask(steps.tasks[0]!, signal()), { state: "ok" });
  const before = runs(mac).length;
  await backend.start(guest, signal());
  assert.ok(!runs(mac).slice(before)[0]!.includes("-incoming"), "a cold boot");

  await backend.powerOff(guest, signal());
  await backend.rollbackSnapshot(guest, { id: UNDO, ref: UNDO, guest }, recorder().hooks, signal());

  assert.equal(fileOnDisk(qemu, guest), "B");
  await backend.release(guest, releasing, signal());
});

test("a snapshot whose image build is gone is not restored, and the plan and the refusal say what it stands on", async () => {
  const { backend, qemu, snaps, guest, build } = await stoppedWithSnapshot();
  chmodSync(join(build, "disk.qcow2"), 0o644);
  rmSync(build, { recursive: true });

  const plan = await backend.planSnapshots(guest, KIND, { id: SNAP, ref: SNAP, guest }, signal());
  const refused = backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal());

  assert.equal(plan.restore.way, "none");
  assert.match(plan.restore.why ?? "", /it stands on build 1 of the Windows image bb-box-windows, which mac1 no longer has\. Delete the snapshot\./);
  await assert.rejects(refused, (error: unknown) => error instanceof SnapshotFailed && /stands on build 1 of the Windows image/.test(error.message));
  assert.equal(fileOnDisk(qemu, guest), "B", "the VM is as it was");
  assert.ok(existsSync(join(snaps, SNAP)));
});

test("a Windows restore refused by the Mac when the base build went after the plan leaves the VM as it was", async () => {
  const { backend, qemu, guest, build, snaps } = await stoppedWithSnapshot();
  writeFileSync(join(snaps, SNAP, "label"), readFileSync(join(snaps, SNAP, "label"), "utf8").replace(/^build=.*$/m, "build=7"));
  void build;

  await assert.rejects(backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal()), (error: unknown) => error instanceof SnapshotFailed && /cannot restore snapshot snaaaaaaaaaaaa: .*stands on build 7/.test(error.message));

  assert.equal(fileOnDisk(qemu, guest), "B");
  assert.ok(!existsSync(join(snaps, ".rollbacks", guest.ref)), "nothing was begun");
});

test("a Windows snapshot never forks and is never kept: the plan says why, and a fork is refused", async () => {
  const { backend, guest } = await stoppedWithSnapshot();

  const plan = await backend.planSnapshots(guest, KIND, { id: SNAP, ref: SNAP, guest }, signal());

  assert.deepEqual([plan.fork.ok, plan.keep.way], [false, "no"]);
  assert.equal(plan.fork.why, `${WINDOWS_NO_FORKS}.`);
  assert.equal(plan.keep.why, `${WINDOWS_NO_FORKS}.`);
  await assert.rejects(backend.forkSnapshot({ id: SNAP, ref: SNAP, guest }, identity(), null, acquiring, signal()), (error: unknown) => error instanceof BackendError && error.message.includes(WINDOWS_NO_FORKS));
});

test("a Windows take cut short reads as stopped part way, and a whole one as done, from the Mac's folders", async () => {
  const { backend, snaps, guest } = await stoppedWithSnapshot();
  const take = { ref: taskRef({ kind: "take", id: SNAP }), host: "mac1" };

  assert.deepEqual(await backend.providerTask(take, signal()), { state: "ok" });
  assert.deepEqual((await backend.findTasks(guest, "take", 0, signal())).map((task) => task.ref), [take.ref]);
  renameSync(join(snaps, SNAP), join(snaps, `${SNAP}.part`));
  writeFileSync(join(snaps, `${SNAP}.part`, "pid"), DEAD_SHELL);
  assert.deepEqual(await backend.providerTask(take, signal()), { state: "failed", words: "its copy stopped part way" });
  const held = await backend.heldSnapshots(signal());
  assert.deepEqual(held.map((one) => [one.id, one.state, one.guest.data?.os]), [[SNAP, "incomplete", "windows"]]);
});

test("a Windows restore cut short between its renames is put right when its task is read: the whole copy goes in, or the VM's own folder back", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, qemu, snaps, guest } = made;

  const task = cutShort(made, guest, "swapping", { restore: "whole", aside: true });
  assert.equal(parseTaskRef(task.ref)?.kind, "rollback");
  assert.deepEqual(await backend.providerTask(task, signal()), { state: "ok" });
  assert.equal(fileOnDisk(qemu, guest), "A");
  assert.ok(!existsSync(join(vmDir(qemu, guest), ".complete")));
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".re")), []);

  const second = cutShort(made, guest, "swapping", { restore: "part", aside: true });
  const answer = await backend.providerTask(second, signal());
  assert.deepEqual([answer.state, answer.state === "failed" && answer.unchanged], ["failed", true]);
  assert.equal(fileOnDisk(qemu, guest), "A", "the VM's own folder is back");
  assert.deepEqual((await backend.findTasks(guest, "rollback", 0, signal())).map((one) => one.ref), [second.ref]);
});

test("a Windows restore cut short while it copied leaves the VM as it was; one still running holds start and power, and a release clears what it left", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, qemu, snaps, guest } = made;
  const copying = cutShort(made, guest, "copying", { restore: "part" });
  const answer = await backend.providerTask(copying, signal());
  assert.deepEqual([answer.state, answer.state === "failed" && answer.unchanged], ["failed", true]);
  assert.equal(fileOnDisk(qemu, guest), "B");
  assert.ok(!existsSync(join(snaps, `.restore-${guest.ref}`)));

  cutShort(made, guest, "swapping", { restore: "whole", aside: true, shell: `${process.pid} ${startedAt(process.pid)}` });
  assert.equal(await backend.power(guest, signal()), "stopped", "never gone while a restore runs");
  await assert.rejects(backend.start(guest, signal()), /BB Box is putting a snapshot in the place of \S+ on the Mac, so it does not start it until that has ended/);
  writeFileSync(join(snaps, ".rollbacks", guest.ref), `swapping ${SNAP} ${ATTEMPT} ${DEAD_SHELL}\n`);
  await backend.start(guest, signal());
  assert.equal(fileOnDisk(qemu, guest), "A", "the start put the whole copy in first");

  await backend.powerOff(guest, signal());
  cutShort(made, guest, "swapping", { restore: "part", aside: true });
  await backend.release(guest, releasing, signal());
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".") && entry !== ".rollbacks"), []);
  assert.ok(!existsSync(join(snaps, ".rollbacks", guest.ref)));
  assert.ok(!existsSync(vmDir(qemu, guest)));
});

function windowsWorld() {
  const fake = setup();
  let tart: TartBackend | null = null;
  const state = world({
    backend: (storage) => {
      tart = new TartBackend(fake.config, testContext(storage, "test", { id: "fake" }), FAKES);
      made.push(tart);
      return tart;
    },
  });
  return { ...fake, state, backend: () => tart! };
}

async function windowsBox(state: ReturnType<typeof windowsWorld>["state"]) {
  const asked = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: KIND, who: BY_COMMAND });
  const box = (await state.boxes.settled(asked))!;
  assert.equal(box.state, "ready", box.error ?? "");
  return box;
}

test("through BB Box: a Windows box's take, restore and undo, with fork and Keep refused and saying why, and its snapshots deleted at its release", async () => {
  const { state, qemu, snaps } = windowsWorld();
  const box = await windowsBox(state);
  writeOnDisk(qemu, box.guest!, "A");

  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "with A" })).snapshot!;
  writeOnDisk(qemu, box.guest!, "B");
  const keep = await rejection(state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 }));
  const fork = await rejection(state.snapshots.fork(COMMAND, box, standing(box), taken.id));
  const restored = await state.snapshots.restore(COMMAND, box, standing(box), taken.id);

  assert.equal(state.store.record(taken.id)?.state, "ready");
  assert.match(keep.message, /Windows has no identity reset/);
  assert.match(fork.message, /forks Linux and macOS boxes only, as only they reset their identity at a fork's first boot/);
  assert.equal(fileOnDisk(qemu, box.guest!), "A");
  const undo = restored.undo!;
  assert.ok(undo, "the restore took an undo");
  assert.equal((await state.boxes.find(box.id))?.state, "ready");
  const now = (await state.boxes.find(box.id))!;
  await state.snapshots.restore(COMMAND, now, standing(now), undo.id, { undo: false });
  assert.equal(fileOnDisk(qemu, box.guest!), "B");

  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith("sn")), [], "its snapshots went with it");
});

test("through BB Box: a restart while a Windows restore waits after its undo finishes the restore from the Mac's record", async () => {
  const { state, qemu } = windowsWorld();
  const box = await windowsBox(state);
  writeOnDisk(qemu, box.guest!, "A");
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "with A" })).snapshot!;
  writeOnDisk(qemu, box.guest!, "B");

  state.holds.step = "undo";
  const held = state.snapshots.restore(COMMAND, box, standing(box), taken.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  await state.snapshots.recover();

  assert.equal(fileOnDisk(qemu, box.guest!), "A");
  const restore = state.store.operations({ box: box.id, kind: "restore" }).at(-1);
  assert.equal(restore?.state, "done", restore?.error ?? "");
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
});

function onMac(mac: string, script: string): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  return spawnSync("/bin/sh", ["-c", script], { encoding: "utf8", env: macEnv(mac), timeout: 60_000 });
}

function imageDir(mac: string): string {
  return join(mac, ".bb-box", "qemu", "images", FAKE_WINDOWS_IMAGE);
}

function buildsOnMac(mac: string, current: string, ...builds: string[]): void {
  for (const build of builds) addWindowsImage(mac, build);
  rmSync(join(imageDir(mac), "current"));
  symlinkSync(current, join(imageDir(mac), "current"));
}

function removeBuild(mac: string, build: string): void {
  chmodSync(join(imageDir(mac), build, "disk.qcow2"), 0o644);
  rmSync(join(imageDir(mac), build), { recursive: true });
}

function standOn(folder: string, build: string): void {
  writeFileSync(join(folder, "config"), readFileSync(join(folder, "config"), "utf8").replace(/^build=.*$/m, `build=${build}`));
}

interface MacRun {
  readonly done: Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }>;
}

function macEnv(mac: string, extra: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${join(mac, "bin")}:${process.env.PATH}`, HOME: mac, USER: "admin", ...extra };
}

function runOnMac(mac: string, script: string, extra: Record<string, string> = {}): MacRun {
  const child = spawn("/bin/sh", ["-c", script], { env: macEnv(mac, extra) });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  const done = new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve) => child.on("close", (status) => resolve({ status, stdout, stderr })));
  return { done };
}

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`waited 30 s for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function realTool(tool: string): string {
  return spawnSync("/bin/sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
}

function macTools(mac: string): string {
  return join(mac, ".nix-profile", "bin");
}

function pauseFirst(mac: string, tool: string): { readonly env: Record<string, string>; readonly arrived: () => Promise<void>; readonly go: () => void } {
  const barrier = join(mac, `.pause-${tool}`);
  mkdirSync(barrier, { recursive: true });
  writeFileSync(
    join(macTools(mac), tool),
    `#!/bin/sh
if [ -n "$PAUSE_DIR" ] && mkdir "$PAUSE_DIR/paused" 2>/dev/null; then
  : > "$PAUSE_DIR/arrived"
  while [ ! -e "$PAUSE_DIR/go" ]; do sleep 0.02; done
fi
exec ${realTool(tool)} "$@"
`,
    { mode: 0o755 },
  );
  return {
    env: { PAUSE_DIR: barrier },
    arrived: () => until(() => existsSync(join(barrier, "arrived")), `the first ${tool} to be reached`),
    go: () => writeFileSync(join(barrier, "go"), ""),
  };
}

function turnAttempts(mac: string): number {
  const file = join(mac, ".turn-attempts");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").length : 0;
}

function countTurnAttempts(mac: string): void {
  writeFileSync(join(macTools(mac), "perl"), `#!/bin/sh
case "$*" in *LOCK_EX*) echo "$$" >> "$HOME/.turn-attempts" ;; esac
exec ${realTool("perl")} "$@"
`, { mode: 0o755 });
}

async function waitingForTurn(mac: string, attempts: number, run: MacRun): Promise<void> {
  let ended = false;
  void run.done.then(() => (ended = true));
  await until(() => ended || turnAttempts(mac) >= attempts, "the script to wait for its turn");
}

async function holdTurn(mac: string): Promise<() => Promise<void>> {
  mkdirSync(join(mac, ".bb-box"), { recursive: true });
  const holder = spawn("perl", ["-MFcntl=:flock", "-e", '$| = 1; open(my $h, ">>", $ARGV[0]) or die; flock($h, LOCK_EX) or die; print "held\n"; <STDIN>', join(mac, TURN_LOCK)], { stdio: ["pipe", "pipe", "inherit"] });
  await new Promise<void>((resolve) => holder.stdout.once("data", () => resolve()));
  const ended = new Promise((resolve) => holder.on("exit", resolve));
  return async () => {
    holder.stdin.end();
    await ended;
  };
}

function currentBuild(mac: string): string {
  return readlinkSync(join(imageDir(mac), "current"));
}

function rollbackBuild(mac: string): string {
  return readlinkSync(join(imageDir(mac), "rollback"));
}

function awaitingPromotion(mac: string, build: string, installId: string): void {
  writeFileSync(join(imageDir(mac), build, "owner"), `install=${installId}\nimage-build=standard\n`);
}

function stagedBuild(mac: string, folder: string): void {
  mkdirSync(join(imageDir(mac), folder), { recursive: true });
  writeFileSync(join(imageDir(mac), folder, "disk.qcow2"), "operator's disk");
  writeFileSync(join(imageDir(mac), folder, "vars.fd"), "variables");
}

const PREPARE_WINDOWS_IMAGE = fileURLToPath(new URL("../setup/tart/prepare-windows-image.sh", import.meta.url));

function prepareScriptFunction(name: string): string {
  const found = new RegExp(`^${name}\\(\\) \\{(?: [^\\n]*\\}\\n|\\n[\\s\\S]*?\\n\\}\\n)`, "m").exec(readFileSync(PREPARE_WINDOWS_IMAGE, "utf8"));
  assert.ok(found, `prepare-windows-image.sh has ${name}`);
  return found[0];
}

function operatorPublication(mac: string, build: string): string {
  const functions = ["step", "lock_opens", "hold_turn", "free_turn", "publish_build"].map(prepareScriptFunction).join("");
  return `set -eu
${functions}export PATH=${quote(macTools(mac))}:"$PATH"
images=${quote(imageDir(mac))}; build=${quote(build)}; d="$images/$build.new"
publish_build
`;
}

function brokenFolder(folder: string, config: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, "disk.qcow2"), "overlay");
  writeFileSync(join(folder, "config"), config);
}

test("an image refresh while a Windows restore is cut short between its renames keeps the build both disks stand on, and the restore then finishes and boots on it", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, mac, qemu, guest, build } = made;
  buildsOnMac(mac, "2", "2", "3");
  const task = cutShort(made, guest, "swapping", { restore: "whole", aside: true });

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  const healed = await backend.providerTask(task, signal());
  await backend.start(guest, signal());

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.ok(existsSync(join(build, "disk.qcow2")), "build 1, which both the VM's own disk and the snapshot's copy stand on, stays");
  assert.deepEqual(healed, { state: "ok" });
  assert.equal(fileOnDisk(qemu, guest), "A");
  assert.equal(await backend.power(guest, signal()), "running");
  await backend.release(guest, releasing, signal());
});

test("an image refresh keeps a build a snapshot or a restore's staged folder alone stands on, and removes it once nothing does", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, mac, qemu, snaps, guest, build } = made;
  buildsOnMac(mac, "2", "2", "3", "4");
  writeFileSync(join(imageDir(mac), "4", "owner"), "install=install-1\n");
  standOn(vmDir(qemu, guest), "3");
  cutShort(made, guest, "swapping", { restore: "whole", aside: true });
  standOn(join(snaps, `.replaced-${guest.ref}`), "4");

  const first = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  const removal = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "4", "install-1"));

  assert.deepEqual([first.stdout.trim(), removal.stdout.trim()], ["replaced", "kept"], `${first.stderr}${removal.stderr}`);
  assert.ok(existsSync(join(build, "disk.qcow2")), "the snapshot and the restore's copy stand on build 1");
  assert.ok(existsSync(join(imageDir(mac), "4", "disk.qcow2")), "the VM's folder set aside stands on build 4");

  await backend.deleteSnapshot({ id: SNAP, ref: SNAP, guest }, recorder().hooks, signal());
  await backend.release(guest, releasing, signal());
  const second = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  const later = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "4", "install-1"));

  assert.deepEqual([second.stdout.trim(), later.stdout.trim()], ["replaced", "removed"]);
  assert.ok(!existsSync(build), "nothing stands on build 1 once the box and its snapshots are gone");
});

test("an image refresh waits for its turn while a restore holds it, and lets go of it when it ends", async () => {
  const { mac } = await stoppedWithSnapshot();
  buildsOnMac(mac, "2", "2", "3");
  countTurnAttempts(mac);
  const release = await holdTurn(mac);

  const refresh = runOnMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  await waitingForTurn(mac, 1, refresh);

  assert.equal(currentBuild(mac), "2", "the refresh changes nothing before its turn");
  await release();
  const done = await refresh.done;
  assert.equal(done.stdout.trim(), "replaced", done.stderr);
  assert.equal(currentBuild(mac), "3");
  const again = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "2"));
  assert.equal(again.stdout.trim(), "replaced", again.stderr);
});

test("two installs' image refreshes take turns, and each keeps the other's build awaiting promotion, so both promotions succeed", async () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3", "4");
  awaitingPromotion(mac, "3", "install-1");
  awaitingPromotion(mac, "4", "install-2");
  countTurnAttempts(mac);
  const pause = pauseFirst(mac, "ln");

  const first = runOnMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"), pause.env);
  await pause.arrived();
  const second = runOnMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "4"));
  await waitingForTurn(mac, 2, second);
  pause.go();
  const [one, two] = [await first.done, await second.done];

  assert.equal(one.stdout.trim(), "replaced", one.stderr);
  assert.equal(two.stdout.trim(), "replaced", two.stderr);
  assert.equal(currentBuild(mac), "4");
  assert.equal(rollbackBuild(mac), "3");
  assert.ok(existsSync(join(imageDir(mac), "4", "disk.qcow2")), "the current build stays");
  assert.ok(existsSync(join(imageDir(mac), "3", "disk.qcow2")), "the rollback stays");
});

test("an image refresh keeps another install's build awaiting promotion that nothing stands on, which only its own install removes", () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3", "4");
  awaitingPromotion(mac, "4", "install-2");

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  const notOurs = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "4", "install-1"));

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.ok(existsSync(join(imageDir(mac), "4", "disk.qcow2")), "build 4 waits for its own install's promotion");
  assert.equal(notOurs.status, 1);
  assert.match(notOurs.stderr, /Build 4 of the image is not a refresh's build of this install's\./);

  const ours = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "4", "install-2"));

  assert.equal(ours.stdout.trim(), "removed", ours.stderr);
  assert.ok(!existsSync(join(imageDir(mac), "4")));
});

test("an image refresh never removes a build still being made, by an operator's build or a refresh's capture", () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3");
  stagedBuild(mac, "build.20261111-040000.new");
  stagedBuild(mac, "build.20261111-050000.new");

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.ok(existsSync(join(imageDir(mac), "build.20261111-040000.new", "disk.qcow2")));
  assert.ok(existsSync(join(imageDir(mac), "build.20261111-050000.new", "disk.qcow2")));
});

test("an operator's build of the Windows image waits for a refresh's turn to publish, so the refresh never removes the build it makes current", async () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3");
  awaitingPromotion(mac, "3", "install-1");
  const operatorBuild = "build.20261111-040000";
  stagedBuild(mac, `${operatorBuild}.new`);
  countTurnAttempts(mac);
  const pause = pauseFirst(mac, "ln");

  const refresh = runOnMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"), pause.env);
  await pause.arrived();
  const publication = runOnMac(mac, operatorPublication(mac, operatorBuild));
  await waitingForTurn(mac, 2, publication);

  assert.ok(existsSync(join(imageDir(mac), `${operatorBuild}.new`, "disk.qcow2")), "the operator's build waits, staged, for its turn");
  pause.go();
  const [refreshed, published] = [await refresh.done, await publication.done];

  assert.equal(refreshed.stdout.trim(), "replaced", refreshed.stderr);
  assert.equal(published.status, 0, published.stderr);
  assert.match(published.stdout, /waiting up to 10 minutes for BB Box's restore or image refresh on this Mac to end/);
  assert.equal(currentBuild(mac), operatorBuild);
  assert.equal(rollbackBuild(mac), "3");
  assert.ok(existsSync(join(imageDir(mac), operatorBuild, "disk.qcow2")), "the build the operator made current stays");
  assert.ok(existsSync(join(imageDir(mac), "3", "disk.qcow2")), "the rollback stays");
});

test("an operator's build of the Windows image that cannot open the turn's lock is not published and says why", { skip: process.getuid?.() === 0 ? "root writes every file" : false }, () => {
  const { mac } = setup();
  const operatorBuild = "build.20261111-040000";
  stagedBuild(mac, `${operatorBuild}.new`);
  writeFileSync(join(mac, TURN_LOCK), "");
  chmodSync(join(mac, TURN_LOCK), 0o444);

  const publication = onMac(mac, operatorPublication(mac, operatorBuild));

  assert.equal(publication.status, 1);
  assert.match(publication.stderr, /could not open .*turn\.lock, which BB Box's restores and image refreshes on this Mac take turns by\. Check that \S+ can write to it\./);
  assert.equal(currentBuild(mac), "1");
  assert.ok(existsSync(join(imageDir(mac), `${operatorBuild}.new`, "disk.qcow2")));
});

test("an image refresh waits for a build's removal to end, and never makes current a build that removal deletes", async () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3");
  writeFileSync(join(imageDir(mac), "3", "owner"), "install=install-1\n");
  countTurnAttempts(mac);
  const pause = pauseFirst(mac, "chmod");

  const removal = runOnMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "3", "install-1"), pause.env);
  await pause.arrived();
  const refresh = runOnMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  await Promise.race([waitingForTurn(mac, 2, refresh), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  pause.go();
  const [removed, refreshed] = [await removal.done, await refresh.done];

  assert.equal(removed.stdout.trim(), "removed", removed.stderr);
  assert.equal(refreshed.status, 1);
  assert.match(refreshed.stderr, /The image has no build 3\./);
  assert.equal(currentBuild(mac), "2");
  assert.ok(existsSync(join(imageDir(mac), "2", "disk.qcow2")), "the current build stays");
});

test("a build's removal checks that the build is not current in its turn, so a refresh that made it current first keeps it", async () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3");
  writeFileSync(join(imageDir(mac), "3", "owner"), "install=install-1\n");
  const pause = pauseFirst(mac, "dirname");

  const removal = runOnMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "3", "install-1"), pause.env);
  await pause.arrived();
  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  pause.go();
  const removed = await removal.done;

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.equal(removed.status, 1);
  assert.match(removed.stderr, /^Build 3 (is the image's current build|of the image is not a refresh's build of this install's)\.$/m);
  assert.equal(currentBuild(mac), "3");
  assert.ok(existsSync(join(imageDir(mac), "3", "disk.qcow2")), "the current build stays");
});

test("a new Windows VM names the build it stands on in its turn, so refreshes meanwhile keep that build", async () => {
  const { mac, qemu } = setup();
  buildsOnMac(mac, "1", "2", "3");
  brokenFolder(join(qemu, "vms", "bb-box-on-3"), `image=${FAKE_WINDOWS_IMAGE}\nbuild=3\n`);
  countTurnAttempts(mac);
  const pause = pauseFirst(mac, "head");

  const clone = runOnMac(mac, qemuCloneScript(FAKE_WINDOWS_IMAGE, "bb-box-new", 2, 4096), pause.env);
  await pause.arrived();
  const refreshes = runOnMac(mac, '/bin/sh -c "$TO_2" && /bin/sh -c "$TO_3"', { TO_2: qemuReplaceScript(FAKE_WINDOWS_IMAGE, "2"), TO_3: qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3") });
  await Promise.race([waitingForTurn(mac, 2, refreshes), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  pause.go();
  const [made, refreshed] = [await clone.done, await refreshes.done];

  assert.equal(made.status, 0, made.stderr);
  assert.equal(refreshed.stdout.trim(), "replaced\nreplaced", refreshed.stderr);
  assert.match(readFileSync(join(qemu, "vms", "bb-box-new", "config"), "utf8"), /^build=1$/m);
  assert.ok(existsSync(join(imageDir(mac), "1", "disk.qcow2")), "the new VM's build stays");
});

test("a second reader of a Windows restore cut short re-reads its record in its turn, and never records a finished restore as undone", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, snaps, qemu, guest } = made;
  const task = cutShort(made, guest, "swapping", { restore: "whole", aside: true });
  const pause = pauseFirst(made.mac, "ps");

  const second = runOnMac(made.mac, qemuScript(`heal_rollback ${guest.ref} "$q/vms/${guest.ref}"; echo healed=$?`), pause.env);
  await pause.arrived();
  const first = await backend.providerTask(task, signal());
  pause.go();
  const late = await second.done;

  assert.deepEqual(first, { state: "ok" });
  assert.equal(late.stdout.trim(), "healed=0", late.stderr);
  assert.match(readFileSync(join(snaps, ".rollbacks", guest.ref), "utf8"), /^done snaaaaaaaaaaaa a1b2c3d4e5f6$/m);
  assert.deepEqual(await backend.providerTask(task, signal()), { state: "ok" });
  assert.equal(fileOnDisk(qemu, guest), "A");
});

test("an image refresh and a build's removal keep every build when a VM's or snapshot's config does not say which build it stands on", async () => {
  const { mac, qemu, snaps } = setup();
  buildsOnMac(mac, "2", "2", "3");
  brokenFolder(join(qemu, "vms", "bb-box-broken"), `image=${FAKE_WINDOWS_IMAGE}\nbuild=\n`);

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.match(refresh.stderr, /could not read the config of every Windows VM, snapshot and restore on the Mac to tell which builds they stand on, so it kept the image's builds 1\./);
  assert.ok(existsSync(join(imageDir(mac), "1", "disk.qcow2")));

  rmSync(join(qemu, "vms", "bb-box-broken"), { recursive: true });
  awaitingPromotion(mac, "1", "install-1");
  brokenFolder(join(snaps, "snbroken", "vm"), `image=${FAKE_WINDOWS_IMAGE}\n`);
  const removal = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "1", "install-1"));

  assert.equal(removal.stdout.trim(), "kept", removal.stderr);
  assert.match(removal.stderr, /so it kept build 1\. Try again once they can be read\./);
  assert.ok(existsSync(join(imageDir(mac), "1", "disk.qcow2")));

  rmSync(join(snaps, "snbroken", "vm", "disk.qcow2"));
  const withoutDisk = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "1", "install-1"));

  assert.equal(withoutDisk.stdout.trim(), "kept", withoutDisk.stderr);

  rmSync(join(snaps, "snbroken"), { recursive: true });
  const cleared = onMac(mac, qemuRemoveBuildScript(FAKE_WINDOWS_IMAGE, "1", "install-1"));
  assert.equal(cleared.stdout.trim(), "removed", cleared.stderr);
});

test("an image refresh keeps a build that a config names, in every place a VM, snapshot or restore keeps one, before its disk is there", () => {
  const places = [join("qemu", "vms", "vm1"), join("snaps", "sn1", "vm"), join("snaps", "sn1.part", "vm"), join("snaps", ".restore-vm1"), join("snaps", ".replaced-vm1")];
  const kept: string[] = [];

  for (const place of places) {
    const { mac, qemu, snaps } = setup();
    buildsOnMac(mac, "2", "2", "3");
    const folder = place.startsWith("qemu") ? join(qemu, place.slice("qemu".length + 1)) : join(snaps, place.slice("snaps".length + 1));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, "config"), `image=${FAKE_WINDOWS_IMAGE}\nbuild=1\n`);
    const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
    assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
    if (existsSync(join(imageDir(mac), "1", "disk.qcow2"))) kept.push(place);
  }

  assert.deepEqual(kept, places);
});

test("an image refresh keeps every build when it cannot read a VM's config", { skip: process.getuid?.() === 0 ? "root reads every file" : false }, () => {
  const { mac, qemu } = setup();
  buildsOnMac(mac, "2", "2", "3");
  const folder = join(qemu, "vms", "bb-box-unread");
  brokenFolder(folder, `image=${FAKE_WINDOWS_IMAGE}\nbuild=1\n`);
  chmodSync(join(folder, "config"), 0o000);

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));
  chmodSync(join(folder, "config"), 0o600);

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.match(refresh.stderr, /so it kept the image's builds 1\./);
  assert.ok(existsSync(join(imageDir(mac), "1", "disk.qcow2")));
});

test("an image refresh is not held up by a link left by an earlier hold in a folder it cannot write", () => {
  const { mac, qemu } = setup();
  buildsOnMac(mac, "2", "2", "3");
  symlinkSync(DEAD_SHELL, join(qemu, ".bases-lock"));
  chmodSync(qemu, 0o555);

  const refresh = spawnSync("/bin/sh", ["-c", qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3")], { encoding: "utf8", env: macEnv(mac), timeout: 20_000 });
  chmodSync(qemu, 0o755);

  assert.equal(refresh.stdout.trim(), "replaced", refresh.stderr);
  assert.equal(currentBuild(mac), "3");
});

test("an image refresh that cannot open the turn's lock refuses at once, says what to do, and changes nothing", { skip: process.getuid?.() === 0 ? "root writes every file" : false }, () => {
  const { mac } = setup();
  buildsOnMac(mac, "2", "2", "3");
  writeFileSync(join(mac, TURN_LOCK), "");
  chmodSync(join(mac, TURN_LOCK), 0o444);

  const refresh = onMac(mac, qemuReplaceScript(FAKE_WINDOWS_IMAGE, "3"));

  assert.equal(refresh.status, 1);
  assert.match(refresh.stderr, /BB Box could not open \S+\/\.bb-box\/turn\.lock on the Mac, which restores and image refreshes take turns by\. Check that \S+ can write to it\./);
  assert.equal(currentBuild(mac), "2");
});

test("no script for the Mac opens the turn's lock with command exec, which crashes macOS's bash 3.2 once a calling function returns", () => {
  const scripts = [script(""), qemuReplaceScript(FAKE_WINDOWS_IMAGE, "2"), readFileSync(PREPARE_WINDOWS_IMAGE, "utf8")];

  for (const text of scripts) assert.doesNotMatch(text, /command exec/);
});

test("a task waits for its turn only as long as its limit, then says to try again", async () => {
  const { mac } = setup();
  const release = await holdTurn(mac);

  const waited = onMac(mac, `${turnSh(3)}hold_turn; echo held=$?`);
  await release();

  assert.equal(waited.stdout.trim(), "held=1");
  assert.match(waited.stderr, /Another BB Box task on the Mac, a restore or an image refresh, has kept this one waiting for 0\.3 s\. Try again once it has ended\./);
});

test("a turn whose shell was killed stays with the children it started, and passes on once they end", async () => {
  const { mac } = setup();
  const go = join(mac, ".child-go");
  const holder = onMac(mac, `${turnSh(10)}hold_turn || exit 9; ( while [ ! -e "${go}" ]; do sleep 0.02; done ) >/dev/null 2>&1 & echo "$!" > "$HOME/.child"; kill -KILL $$`);
  assert.equal(holder.signal, "SIGKILL", holder.stderr);

  const whileChildRuns = onMac(mac, `${turnSh(5)}hold_turn; echo held=$?`);
  writeFileSync(go, "");
  const child = Number(readFileSync(join(mac, ".child"), "utf8"));
  await until(() => spawnSync("kill", ["-0", String(child)]).status !== 0, "the holder's child to end");
  const afterChild = onMac(mac, `${turnSh(10)}hold_turn; echo held=$?`);

  assert.equal(whileChildRuns.stdout.trim(), "held=1");
  assert.equal(afterChild.stdout.trim(), "held=0", afterChild.stderr);
});

test("a Windows restore cut short between its renames whose snapshot's build is gone puts the VM's own folder back and says why", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, mac, qemu, snaps, guest } = made;
  buildsOnMac(mac, "2", "2");
  const task = cutShort(made, guest, "swapping", { restore: "whole", aside: true });
  standOn(join(snaps, `.replaced-${guest.ref}`), "2");
  removeBuild(mac, "1");

  const answer = await backend.providerTask(task, signal());

  assert.equal(answer.state, "failed");
  assert.equal(answer.state === "failed" && answer.unchanged, true);
  assert.match(answer.state === "failed" ? answer.words : "", /the build of the Windows image that the snapshot's disk stands on is gone from the Mac, so the Mac put the VM's own folder back as it was/);
  assert.equal(fileOnDisk(qemu, guest), "B");
  assert.deepEqual(readdirSync(snaps).filter((entry) => entry.startsWith(".re")), []);
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  await backend.release(guest, releasing, signal());
});

test("a Windows restore found in place on a build that is gone, with nothing set aside, is not reported done, and the box does not start", async () => {
  const made = await stoppedWithSnapshot();
  const { backend, mac, qemu, snaps, guest } = made;
  const task = cutShort(made, guest, "swapping", { restore: "whole", aside: true });
  renameSync(join(snaps, `.restore-${guest.ref}`), vmDir(qemu, guest));
  rmSync(join(snaps, `.replaced-${guest.ref}`), { recursive: true });
  removeBuild(mac, "1");

  const answer = await backend.providerTask(task, signal());

  assert.deepEqual(answer, { state: "failed", words: "the build of the Windows image that the snapshot's disk stands on is gone from the Mac, and the Mac has no folder of the VM's own to put back. Release the box" });
  await assert.rejects(backend.start(guest, signal()), /stands on \S+\/images\/bb-box-windows\/1\/disk\.qcow2, which the Mac no longer has, so QEMU cannot start it\. Release the box\./);
  assert.deepEqual((await backend.findTasks(guest, "rollback", 0, signal())).map((one) => one.ref), [task.ref]);
});

test("a Windows restore checks the build its copy stands on while it holds the image's builds, and puts nothing in place when it is gone", async () => {
  const { backend, qemu, snaps, guest } = await stoppedWithSnapshot();
  standOn(join(snaps, SNAP, "vm"), "7");

  const refused = backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal());

  await assert.rejects(refused, (error: unknown) => error instanceof SnapshotFailed && /cannot restore snapshot snaaaaaaaaaaaa: Snapshot snaaaaaaaaaaaa stands on \S+\/images\/bb-box-windows\/7\/disk\.qcow2, which the Mac no longer has, so BB Box put nothing in the place of \S+\. Delete the snapshot\./.test(error.message));
  assert.equal(fileOnDisk(qemu, guest), "B");
  assert.match(readFileSync(join(snaps, ".rollbacks", guest.ref), "utf8"), /^undone snaaaaaaaaaaaa \S+ base-gone$/m);
});

test("a Windows restore waits for its turn to swap its folders while an image refresh holds it", async () => {
  const { backend, mac, qemu, guest } = await stoppedWithSnapshot();
  countTurnAttempts(mac);
  const release = await holdTurn(mac);

  const restore = backend.rollbackSnapshot(guest, { id: SNAP, ref: SNAP, guest }, recorder().hooks, signal());
  await until(() => turnAttempts(mac) >= 1, "the restore to wait for its turn");

  assert.equal(fileOnDisk(qemu, guest), "B", "nothing is swapped before the restore's turn");
  await release();
  await restore;
  assert.equal(fileOnDisk(qemu, guest), "A");
});
