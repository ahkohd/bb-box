import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { SNAPSHOTS_FOLDER, WINDOWS_NO_FORKS, parseTaskRef, taskRef, tartOffer } from "../src/backends/tart/snapshots.ts";
import { BackendError, SnapshotFailed, type AcquireHooks, type BoxIdentity, type Guest, type MachineSize, type ReleaseHooks, type SnapshotHooks, type TaskRef } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
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
  assert.match(plan.restore.why ?? "", /it stands on build 1 of the Windows image bb-box-windows, which mac1 no longer has: an image refresh removed it once no VM used it\. Delete the snapshot\./);
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
