import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { test } from "node:test";
import { MsbBackend, OWN_HOSTNAME, RUN_IN_MEMORY, sandboxName } from "../src/backends/microsandbox/backend.ts";
import { MsbCli } from "../src/backends/microsandbox/cli.ts";
import { MSB_VERSION, msbScript, scriptValues } from "../src/backends/microsandbox/release.ts";
import { HOST_FILE_DOCKER, SNAPSHOTS_CHECKED_WITH, parseHead, parseInspect, parseSnapshotList, snapshotName, versionRefusal } from "../src/backends/microsandbox/snapshots.ts";
import { SnapshotFailed, type AcquireHooks, type BoxIdentity, type CopyHooks, type MachineSize, type Guest, type SnapshotHooks } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { IDENTITY_TOOL, forkCheckScript, forkSafetyOf, forkVerdict, parseForkSeen } from "../src/core/identity.ts";
import { newSnapshotId } from "../src/core/snapshot.ts";
import { fakeMsbHost, msbConfig } from "./fake-msb.ts";
import { tempDir, testContext } from "./helpers.ts";
import { COMMAND, THREAD, readyBox, standing, world } from "./snapshot-world.ts";

const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const FIXTURES = new URL("./fixtures/", import.meta.url).pathname;
const signal = () => AbortSignal.timeout(30_000);
const QUIET: SnapshotHooks = { submitting: async () => {}, task: async () => {} };

let counter = 0;
function identity(kind = "linux", size: MachineSize = SMALL): BoxIdentity {
  counter++;
  return { boxId: `bx${String(counter).padStart(12, "0")}`, threadId: "thr_abc123", name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: "none" } };
}

function snapshotId(): string {
  return newSnapshotId((bytes) => randomBytes(bytes));
}

const acquiring = (): AcquireHooks => ({ claim: async () => {}, starting: async () => {}, timing: () => {} });

function setup(values: Record<string, string | number | boolean> = {}) {
  const fake = fakeMsbHost();
  const context = testContext();
  const backend = new MsbBackend(msbConfig(values), context, { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  return { fake, context, backend };
}

function after(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

function writeHome(fake: ReturnType<typeof fakeMsbHost>, sandbox: string, file: string, text: string): void {
  mkdirSync(fake.home(sandbox), { recursive: true });
  writeFileSync(join(fake.home(sandbox), file), text);
}

test("070 unit 10: msb 0.7.7's recorded answers parse: a full snapshot that depends on a disk one, the head, and a snapshot's labels and disk", () => {
  const listed = parseSnapshotList(readFileSync(join(FIXTURES, "msb-snapshot-list.json"), "utf8"));
  assert.deepEqual(
    listed.map((each) => [each.group, each.name, each.holds, each.availability, each.parent]),
    [
      ["ox", "two", "disk-and-memory", "ready", "snap_1fc72f81f175e9d0c91ab294001be6fe"],
      ["ox", "one", "disk", "ready", null],
    ],
  );
  assert.equal(listed[1]!.createdAt, Date.parse("2026-11-01T00:15:50.805120940+00:00"));
  assert.equal(parseHead('{\n  "group": "ox",\n  "previous": "snap_a13191afaa479e9479770401bf4f90f5",\n  "head": "snap_a13191afaa479e9479770401bf4f90f5",\n  "reason": "unchanged",\n  "changed": false\n}'), "snap_a13191afaa479e9479770401bf4f90f5");
  const inspected = parseInspect(readFileSync(join(FIXTURES, "msb-snapshot-inspect.txt"), "utf8"));
  assert.deepEqual(inspected, { labels: {}, diskGiB: 4 });
  assert.deepEqual(parseInspect("Source Sandbox:       bbbox-bx6shhmycajhqm-k3j9\nLabels:               bbbox.box=bx6shhmycajhqm, bbbox.install=inst-1a2b\n").labels, { "bbbox.box": "bx6shhmycajhqm", "bbbox.install": "inst-1a2b" });
});

test("070 unit 10: BB Box's microsandbox snapshots are pinned to the msb whose snapshots its checks measured, and any other msb turns them off with words", async () => {
  assert.equal(SNAPSHOTS_CHECKED_WITH, MSB_VERSION, "moving msb past the release the snapshot checks measured needs them run again (docs/research/box-snapshots/microsandbox-unit-10.sh), then this constant moved");
  assert.ok(readFileSync(new URL("../docs/research/box-snapshots/microsandbox-unit-10.sh", import.meta.url), "utf8").includes(`msb ${SNAPSHOTS_CHECKED_WITH}`));
  assert.equal(versionRefusal("0.7.7"), null);
  assert.match(versionRefusal("0.8.0")!, /only with msb 0\.7\.7, whose snapshots its checks measured, and this host has msb 0\.8\.0/);
  const { fake, backend: first } = setup();
  const guest = await first.acquire(identity(), null, acquiring(), signal());
  fake.facts({ installed: "0.8.0" });
  fake.set({ version: "0.8.0" });
  const backend = new MsbBackend(msbConfig(), testContext(), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  const plan = await backend.planSnapshots(guest, "linux", null, signal());
  assert.equal(plan.take.ok, false);
  assert.match(plan.take.why!, /msb 0\.8\.0/);
  await assert.rejects(backend.snapshot(guest, { id: snapshotId(), box: guest.data!.box as string, memory: false }, QUIET, signal()), (error: unknown) => error instanceof SnapshotFailed && /msb 0\.8\.0/.test(error.message));
  await assert.rejects(backend.deleteSnapshot({ id: snapshotId(), ref: "snap_00000000000000000000000000000000", guest }, QUIET, signal()), /msb 0\.8\.0/);
  const report = await backend.doctor(signal());
  const check = report.checks.find((each) => each.id === "microsandbox.snapshots");
  assert.equal(check?.status, "warn");
  assert.match(check?.detail ?? "", /takes and deletes microsandbox snapshots only with msb 0\.7\.7/);
});

test("070 unit 10 review (Astra 2): msb changed under a running backend is read again before every change, so a --force delete, a take, a restore, a fork and Keep are refused at once, never from a cached version", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, acquiring(), signal());
  const box = guest.data!.box as string;
  const parent = snapshotId();
  const taken = await backend.snapshot(guest, { id: parent, box, memory: false, forkSafe: 7 }, QUIET, signal());
  await backend.snapshot(guest, { id: snapshotId(), box, memory: false, forkSafe: 7 }, QUIET, signal());
  fake.set({ version: "0.8.0" });
  const ref = { id: parent, ref: taken.ref, guest };
  const refused = (error: unknown) => error instanceof SnapshotFailed && /this host has msb 0\.8\.0/.test(error.message);
  await assert.rejects(backend.deleteSnapshot(ref, QUIET, signal()), refused);
  assert.ok(!fake.calls().some((call) => call[0] === "snapshot" && call[1] === "remove"), "nothing is removed, with --force or without");
  await assert.rejects(backend.snapshot(guest, { id: snapshotId(), box, memory: false }, QUIET, signal()), refused);
  await assert.rejects(backend.adoptSnapshot(ref, identity(), { macs: {}, smbios: null, value: box }, { claimed: async () => {}, submitting: async () => {}, task: async () => {} }, signal()), refused);
  await assert.rejects(backend.forkSnapshot(ref, identity(), null, acquiring(), signal()), refused);
  await assert.rejects(backend.labelKept(ref, "2026-12-01", signal()), refused);
  assert.equal(fake.snapshots().length, 2);
  fake.set({ version: "0.7.7" });
  await backend.deleteSnapshot(ref, QUIET, signal());
  assert.equal(fake.snapshots().length, 1);
});

test("a microsandbox take of a running box pauses it, disk or memory, for the time msb's runtime logs, not the time its command takes", async () => {
  const fake = fakeMsbHost();
  fake.set({ diskPauseUs: 24_272, fullPauseUs: 289_747 });
  let clock = 1_000_000;
  const backend = new MsbBackend(msbConfig(), testContext(), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000, now: () => (clock += 1_300) });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring(), signal());

  const plan = await backend.planSnapshots(guest, "linux", null, signal());
  const disk = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  const memory = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: true, forkSafe: 7 }, QUIET, signal());

  assert.deepEqual(plan.take.pause, { pauses: true, aboutMs: null, basis: null }, "msb pauses the VM while it captures its disk");
  assert.deepEqual(plan.take.memory?.pause, { pauses: true, aboutMs: 1_500, basis: { bytes: SMALL.memoryMiB * 2 ** 20, of: "memory" } });
  assert.equal(disk.pausedMs, 25, "msb's pause_us, 24,272 us, not its command's 1,300 ms");
  assert.equal(memory.pausedMs, 290, "msb's vm_pause_window_us, 289,747 us, not its command's 1,300 ms");
  const listed = await backend.heldSnapshots(signal());
  assert.deepEqual(disk.size, { bytes: 2048 * 1024, means: "whole" });
  assert.deepEqual(listed.map((held) => held.size), [disk.size, memory.size], "its listing gives each snapshot's size, as its take did");
});

test("a microsandbox take whose pause msb does not log says the pause is unknown, never 0; a stopped box's take does not pause", async () => {
  const fake = fakeMsbHost();
  fake.set({ pauseLogged: false });
  const backend = new MsbBackend(msbConfig(), testContext(), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring(), signal());

  const unlogged = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  await backend.stop(guest, signal());
  const stoppedPlan = await backend.planSnapshots(guest, "linux", null, signal());
  const stopped = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());

  assert.equal(unlogged.pausedMs, null);
  assert.deepEqual(stoppedPlan.take.pause, { pauses: false });
  assert.equal(stopped.pausedMs, 0);
});

test("070 close-out: a Mac host's microsandbox boxes take and delete snapshots, as the probe on a Mac measured, and the doctor says so; another msb is still refused", async () => {
  const fake = fakeMsbHost();
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  fake.set({ homeThroughLink: true });
  const backend = new MsbBackend(msbConfig(), testContext(), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  const box = identity("linux-arm64");
  const guest = await backend.acquire(box, null, acquiring(), signal());
  const plan = await backend.planSnapshots(guest, "linux-arm64", null, signal());
  assert.deepEqual([plan.take.ok, plan.take.why, plan.fork.ok], [true, null, true]);
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "microsandbox.snapshots");
  assert.equal(check?.status, "ok");
  const id = snapshotId();
  const taken = await backend.snapshot(guest, { id, box: box.boxId, memory: true, forkSafe: 7 }, QUIET, signal());
  assert.equal(taken.holds, "disk-and-memory");
  await backend.deleteSnapshot({ id, ref: taken.ref, guest }, QUIET, signal());
  assert.deepEqual(fake.snapshots(), []);
  fake.set({ version: "0.8.0" });
  await assert.rejects(backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal()), (error: unknown) => error instanceof SnapshotFailed && /this host has msb 0\.8\.0/.test(error.message));
});

test("070 close-out: where msb's home is reached through a link, as BB Box's wrapper reaches a long one and a Mac's /tmp always is, msb refuses a snapshot's ID, so BB Box names each by group and member to inspect, restore, fork and delete it", async () => {
  const { fake, backend } = setup();
  fake.set({ homeThroughLink: true });
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring(), signal());
  const parent = snapshotId();
  const first = await backend.snapshot(guest, { id: parent, box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  const last = snapshotId();
  const second = await backend.snapshot(guest, { id: last, box: box.boxId, memory: true, forkSafe: 7 }, QUIET, signal());
  const firstRef = { id: parent, ref: first.ref, guest };
  const secondRef = { id: last, ref: second.ref, guest };
  const restored = await backend.adoptSnapshot(firstRef, { ...box, size: { ...guest.size!, gpu: "none" } }, { macs: {}, smbios: null, value: box.boxId }, { claimed: async () => {}, submitting: async () => {}, task: async () => {} }, signal());
  assert.notEqual(restored.ref, guest.ref);
  const fork = await backend.forkSnapshot(secondRef, identity(), null, acquiring(), signal());
  assert.ok(fake.sandboxes().includes(fork.ref));
  await backend.deleteSnapshot(firstRef, QUIET, signal());
  assert.deepEqual(fake.snapshots().map((each) => each.id), [second.ref], "the parent goes, with --force, and its child stays");
  await backend.deleteSnapshot(secondRef, QUIET, signal());
  assert.deepEqual(fake.snapshots(), []);
  const named = fake.calls().filter((call) => call[0] === "snapshot" && ["inspect", "restore", "remove"].includes(call[1]!));
  assert.deepEqual([...new Set(named.map((call) => call[1]))].sort(), ["inspect", "remove", "restore"]);
  assert.deepEqual(named.filter((call) => call.some((arg) => /^snap_[0-9a-f]{32}$/.test(arg))), [], "no snapshot named by its ID");
});

test("070 unit 10 review (Opus 2): a restore keeps the box's disk when it has grown since the snapshot, as the dialog says, and as a fork does", async () => {
  const { fake, backend } = setup();
  const box = identity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 32 });
  const guest = await backend.acquire(box, null, acquiring(), signal());
  const taken = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  const grown = await backend.resize(guest, "linux", { cores: 2, memoryMiB: 4096, diskGiB: 48 }, { restart: false }, signal());
  const plan = await backend.planSnapshots(grown, "linux", { id: "sn", ref: taken.ref, guest: grown }, signal());
  assert.equal(plan.restore.sizeBack?.diskGiB, 48);
  const fresh = await backend.adoptSnapshot({ id: "sn", ref: taken.ref, guest: grown }, { ...box, size: { ...grown.size!, gpu: "none" } }, { macs: {}, smbios: null, value: box.boxId }, { claimed: async () => {}, submitting: async () => {}, task: async () => {} }, signal());
  assert.deepEqual(fake.calls().filter((call) => call[0] === "modify" && call[1] === fresh.ref && call.includes("--root-disk")).map((call) => after(call, "--root-disk")[0]), ["48G"]);
  assert.equal(fresh.size?.diskGiB, 48);
});

test("070 unit 10: a take names the snapshot for its install, box and identity reset, groups a box's snapshots, records what it depends on, and takes memory only from a running box", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, acquiring(), signal());
  const box = guest.data!.box as string;
  const first = snapshotId();
  const taken = await backend.snapshot(guest, { id: first, box, memory: false, forkSafe: 7 }, QUIET, signal());
  const create = fake.calls().find((call) => call[0] === "snapshot" && call[1] === "create")!;
  assert.equal(create[2], snapshotName("test", first, 7));
  assert.deepEqual([after(create, "--sandbox")[0], after(create, "--group")[0]], [guest.ref, `bbbox-${box}`]);
  assert.deepEqual(after(create, "--label").sort(), [`bbbox.box=${box}`, "bbbox.cores=2", "bbbox.disk-gib=32", "bbbox.install=test", "bbbox.memory-mib=4096", `bbbox.snapshot=${first}`]);
  assert.ok(!create.includes("--full"));
  assert.match(taken.ref, /^snap_[0-9a-f]{32}$/);
  assert.deepEqual([taken.holds, taken.size, taken.dependsOn], ["disk", { bytes: 2048 * 1024, means: "whole" }, []]);
  const second = snapshotId();
  const full = await backend.snapshot(guest, { id: second, box, memory: true, forkSafe: 7 }, QUIET, signal());
  assert.deepEqual([full.holds, full.dependsOn], ["disk-and-memory", [first]], "msb's parent: the box's previous capture");
  const held = await backend.heldSnapshots(signal());
  assert.deepEqual(
    held.map((each) => [each.id, each.box, each.holds, each.forkSafe, each.dependsOn, each.state, each.guest.ref, each.keptUntil]),
    [
      [second, box, "disk-and-memory", 7, [first], "complete", guest.ref, null],
      [first, box, "disk", 7, [], "complete", guest.ref, null],
    ],
  );
  assert.deepEqual((await backend.snapshotsOn(guest, signal())).map((each) => each.id).sort(), [first, second].sort());
  await backend.stop(guest);
  const plan = await backend.planSnapshots(guest, "linux", null, signal());
  assert.deepEqual([plan.take.ok, plan.take.memory, plan.take.memoryWhy], [true, null, "msb saves a box's memory only while it runs."]);
  await assert.rejects(backend.snapshot(guest, { id: snapshotId(), box, memory: true }, QUIET, signal()), (error: unknown) => error instanceof SnapshotFailed && /only while it runs/.test(error.message));
  const stopped = await backend.snapshot(guest, { id: snapshotId(), box, memory: false }, QUIET, signal());
  assert.equal(stopped.holds, "disk", "a stopped box's disk, as an undo takes it");
  const again = await backend.snapshot(guest, { id: first, box, memory: false, forkSafe: 7 }, QUIET, signal());
  assert.equal(again.ref, taken.ref, "a take repeated after it was made is the snapshot made, never deleted as a failed one");
  assert.ok(fake.snapshots().some((each) => each.id === taken.ref));
});

test("070 unit 10: a box made before, whose Docker disk is a file of the host's, takes no snapshot and says why; its plan still reads", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const name = sandboxName(box.boxId);
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok(["create", "bbbox/linux:1", "--name", name, "--label", "bbbox.backend=microsandbox", "--label", "bbbox.install=test", "--label", `bbbox.box=${box.boxId}`, "--label", `bbbox.name=${box.name}`, "--cpus", "2", "--memory", "4096M", "--root-disk", "32G", "--mount-disk", `${fake.dir}/disks/${name}.ext4:/var/lib/docker`]);
  const guest: Guest = { ref: name, host: null, address: null, size: SMALL, data: { box: box.boxId } };
  const plan = await backend.planSnapshots(guest, "linux", null, signal());
  assert.equal(plan.take.ok, false);
  assert.equal(plan.take.why, "It was made before BB Box could snapshot a box's Docker disk: its Docker data is on a file of the host's, which msb leaves out of a snapshot and cannot give a restored box. A new box can.");
  assert.ok(plan.take.why!.includes(HOST_FILE_DOCKER.slice(1)));
  assert.equal(plan.busy, null, "a refusal, not a wait");
  await assert.rejects(backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false }, QUIET, signal()), (error: unknown) => error instanceof SnapshotFailed && error.message.includes(HOST_FILE_DOCKER.slice(1)));
  assert.ok(!fake.calls().some((call) => call[0] === "snapshot" && call[1] === "create"), "msb is never asked");
});

test("070 unit 10: a delete removes a snapshot others depend on with --force, as their data is their own, moves the group's head first when it is the head, drops its keep date, and leaves other installs' alone", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, acquiring(), signal());
  const box = guest.data!.box as string;
  const ids = [snapshotId(), snapshotId(), snapshotId()];
  const taken = [];
  for (const id of ids) taken.push(await backend.snapshot(guest, { id, box, memory: false, forkSafe: 7 }, QUIET, signal()));
  assert.equal(fake.heads()[`bbbox-${box}`], taken[2]!.ref);
  await backend.labelKept({ id: ids[0]!, ref: taken[0]!.ref, guest }, "2026-11-29", signal());
  assert.equal((await backend.heldSnapshots(signal())).find((each) => each.id === ids[0])!.keptUntil, Date.UTC(2026, 10, 29, 23, 59, 59, 999));
  const tasks: string[] = [];
  await backend.deleteSnapshot({ id: ids[0]!, ref: taken[0]!.ref, guest }, { submitting: async () => {}, task: async (task) => void tasks.push(task.ref) }, signal());
  const removed = fake.calls().filter((call) => call[0] === "snapshot" && call[1] === "remove");
  assert.deepEqual(removed.at(-1), ["snapshot", "remove", "--force", "--quiet", `bbbox-${box}:${snapshotName("test", ids[0]!, 7)}`], "msb refuses a parent without --force");
  assert.deepEqual(tasks, [`delete:${taken[0]!.ref}`]);
  assert.ok(!existsSync(join(fake.dir, "kept", taken[0]!.ref)), "its keep date goes with it");
  assert.deepEqual(fake.snapshots().map((each) => each.id).sort(), [taken[1]!.ref, taken[2]!.ref].sort());
  await backend.deleteSnapshot({ id: ids[2]!, ref: taken[2]!.ref, guest }, QUIET, signal());
  const head = fake.calls().filter((call) => call[0] === "snapshot" && call[1] === "head").at(-1)!;
  assert.equal(head[2], `bbbox-${box}:${snapshotName("test", ids[1]!, 7)}`, "msb removes no group's head while it has other members");
  assert.deepEqual(fake.calls().filter((call) => call[0] === "snapshot" && call[1] === "remove").at(-1), ["snapshot", "remove", "--quiet", `bbbox-${box}:${snapshotName("test", ids[2]!, 7)}`], "no --force for a snapshot nothing depends on");
  await backend.deleteSnapshot({ id: ids[2]!, ref: taken[2]!.ref, guest }, QUIET, signal());
  const other = new MsbBackend(msbConfig(), testContext(undefined, "other"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  await assert.rejects(other.deleteSnapshot({ id: ids[1]!, ref: taken[1]!.ref, guest }, QUIET, signal()), (error: unknown) => error instanceof SnapshotFailed && /is not BB Box's snapshot .* of this install's/.test(error.message));
  assert.deepEqual(await other.heldSnapshots(signal()), []);
});

test("070 unit 10: a restore makes the box a new microVM from the snapshot, with the box's labels, its own identity value and hostname, at its size, or at the captured size for its memory", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring(), signal());
  writeHome(fake, guest.ref, "work.txt", "before");
  const diskId = snapshotId();
  const disk = await backend.snapshot(guest, { id: diskId, box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  writeHome(fake, guest.ref, "work.txt", "after");
  const claimed: string[] = [];
  const hooks: CopyHooks = { claimed: async (made) => void claimed.push(made.ref), submitting: async () => {}, task: async () => {} };
  const fresh = await backend.adoptSnapshot({ id: "sn", ref: disk.ref, guest }, box, await backend.guestIdentity(guest), hooks, signal());
  assert.match(fresh.ref, new RegExp(`^${guest.ref}-[0-9a-f]{8}$`));
  assert.notEqual(fresh.ref, guest.ref);
  assert.deepEqual(claimed, [fresh.ref, fresh.ref], "claimed before msb is asked");
  const restore = fake.calls().find((call) => call[0] === "snapshot" && call[1] === "restore")!;
  assert.deepEqual([restore[2], after(restore, "--name")[0], after(restore, "--cpus")[0], after(restore, "--memory")[0], restore.includes("--disk-only")], [`bbbox-${box.boxId}:${snapshotName("test", diskId, 7)}`, fresh.ref, "2", "4096M", false]);
  assert.deepEqual([after(restore, "--net-default"), after(restore, "--net-rule")], [["deny"], ["allow@dns,allow@public,allow@private,allow:ingress@any"]], "the box's own network profiles, as msb's create made them, which a restore does not keep: without private it cannot reach BB on a private address (found live)");
  const made = fake.inspect(fresh.ref);
  assert.equal(made.config.labels["bbbox.box"], box.boxId);
  assert.equal(made.config.labels["bbbox.thread"], box.threadId);
  assert.deepEqual(made.config.env.sort(), [`BBBOX_HOSTNAME=${box.name}`, "BBBOX_DOCKERD=1", `BBBOX_IDENTITY=${box.boxId}`].sort(), "the box's own value, passed on in a same-box swap (070, section 9)");
  assert.equal(readFileSync(join(fake.home(fresh.ref), "work.txt"), "utf8"), "before");
  assert.deepEqual(fresh.data, { box: box.boxId });
  await backend.start(fresh, signal());
  assert.equal(await backend.power(fresh), "running");

  const full = await backend.snapshot(fresh, { id: snapshotId(), box: box.boxId, memory: true, forkSafe: 7 }, QUIET, signal());
  const plan = await backend.planSnapshots(fresh, "linux", { id: "sn", ref: full.ref, guest: fresh }, signal());
  assert.deepEqual([plan.restore.way, plan.restore.undo, plan.restore.sizeBack?.cores, plan.restore.sizeBack?.memoryMiB], ["new-guest", "snapshot", 2, 4096]);
  const back = await backend.adoptSnapshot({ id: "sn", ref: full.ref, guest: fresh }, box, { macs: {}, smbios: null, value: box.boxId }, hooks, signal());
  const resumed = fake.calls().filter((call) => call[0] === "snapshot" && call[1] === "restore").at(-1)!;
  assert.deepEqual([after(resumed, "--cpus"), after(resumed, "--memory"), resumed.includes("--disk-only")], [[], [], false], "a memory restore keeps the captured size, as msb requires");
  assert.equal(fake.inspect(back.ref).config.labels["bbbox.box"], box.boxId);
});

test("070 unit 10: a part-made restored microVM, before BB Box labelled it, is deleted by a release and counted by power, and a fork's leftover is made again", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, acquiring(), signal());
  const taken = await backend.snapshot(guest, { id: snapshotId(), box: box.boxId, memory: false, forkSafe: 7 }, QUIET, signal());
  const part = `${guest.ref}-0a1b2c3d`;
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok(["snapshot", "restore", taken.ref, "--name", part, "--quiet"]);
  const made: Guest = { ref: part, host: null, address: null, size: null, data: { box: box.boxId } };
  assert.equal(await backend.power(made), "running", "a part-made guest is not taken for gone");
  await backend.release(made, { resetting: async () => {}, timing: () => {} });
  assert.equal(await backend.power(made), null);
  assert.ok(!fake.sandboxes().includes(part));
  const stranger = `${sandboxName("bx999999999999")}-0a1b2c3d`;
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok(["snapshot", "restore", taken.ref, "--name", stranger, "--quiet"]);
  await backend.release({ ...made, ref: stranger }, { resetting: async () => {}, timing: () => {} });
  assert.ok(fake.sandboxes().includes(stranger), "another box's name is not this guest's to delete");
});

test("070 unit 10: a fork boots a new microVM from the snapshot's disk only, never its memory, under the fork's own name, labels and identity value, so its identity reset runs", async () => {
  const { fake, backend } = setup();
  const source = identity();
  const guest = await backend.acquire(source, null, acquiring(), signal());
  writeHome(fake, guest.ref, "work.txt", "set up");
  const full = await backend.snapshot(guest, { id: snapshotId(), box: source.boxId, memory: true, forkSafe: 7 }, QUIET, signal());
  const plan = await backend.planSnapshots(guest, "linux", { id: "sn", ref: full.ref, guest }, signal());
  assert.deepEqual([plan.fork.ok, plan.fork.size], [true, { cores: 2, memoryMiB: 4096, diskGiB: 32 }]);
  const fork = identity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 32 });
  const leftover = sandboxName(fork.boxId);
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok(["snapshot", "restore", full.ref, "--name", leftover, "--disk-only", "--cpus", "1", "--memory", "512M", "--quiet"]);
  const made = await backend.forkSnapshot({ id: "sn", ref: full.ref, guest }, fork, null, acquiring(), signal());
  assert.equal(made.ref, leftover);
  const restores = fake.calls().filter((call) => call[0] === "snapshot" && call[1] === "restore");
  const own = restores.at(-1)!;
  assert.deepEqual([after(own, "--name")[0], own.includes("--disk-only"), after(own, "--cpus")[0], after(own, "--memory")[0]], [leftover, true, "2", "4096M"]);
  assert.ok(fake.calls().some((call) => call[0] === "remove" && call.includes(leftover)), "the unlabelled leftover went first");
  const config = fake.inspect(made.ref).config;
  assert.equal(config.labels["bbbox.box"], fork.boxId);
  assert.ok(config.env.includes(`BBBOX_IDENTITY=${fork.boxId}`), "a value new to the fork, which its marker does not hold, so it resets");
  assert.ok(!config.env.includes(`BBBOX_IDENTITY=${source.boxId}`));
  assert.ok(!existsSync(join(fake.dir, "..", "sandboxes", made.ref, "run", "bb-box", "ready")), "no memory, so nothing of the source runs: BB Box starts it");
  assert.equal(readFileSync(join(fake.home(made.ref), "work.txt"), "utf8"), "set up");
  const taken = identity();
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok(["create", "bbbox/linux:1", "--name", sandboxName(taken.boxId), "--label", "bbbox.backend=microsandbox", "--label", "bbbox.install=test", "--label", "bbbox.box=bx999999999998", "--cpus", "1", "--memory", "512M", "--root-disk", "8G"]);
  await assert.rejects(backend.forkSnapshot({ id: "sn", ref: full.ref, guest }, taken, null, acquiring(), signal()), /belongs to another box/);
});

test("070 unit 10: a fork that reset holds its own value in its marker; one with its source's value, or none, is refused", () => {
  const lines = (marker: string[]) => ["version=7", "enabled=yes", "boot=reset", "marker=matches", "armed=yes", "pending=no", "box=", "source=value", ...marker, "machine_id=" + "a".repeat(64), "host_key=" + "b".repeat(64), "tailnet_node=no", "addresses_read=yes", "probes=done"].join("\n");
  const expected = { forkMacs: [], forkValue: "bxfork0000001", sourceMacs: [], sourceBox: "bxsource00001", sourceName: "amber-fox", sourceAddresses: [], freedSourceAddresses: [], ownAddress: null, boxAddresses: [], held: { machineId: "c".repeat(64), hostKeys: ["d".repeat(64)] }, safeFrom: 7 };
  assert.deepEqual(forkVerdict(parseForkSeen(lines(["marker_value=bxfork0000001"]), 0), expected), { is: "ready" });
  assert.match((forkVerdict(parseForkSeen(lines(["marker_value=bxsource00001"]), 0), expected) as { why: string }).why, /holds amber-fox's value/);
  assert.match((forkVerdict(parseForkSeen(lines([]), 0), expected) as { why: string }).why, /holds no value, not its own bxfork0000001/);
});

test("070 unit 10: a box with no SSH server, whose identity is a value, is fork-safe without SSH host keys at a take, which its reset makes; a box compared by MAC address is not", () => {
  const stdout = ["version=7", "enabled=yes", "boot=unarmed", "marker=matches", "armed=yes", "pending=no", "box=bxcdajktgcrenv", "source=value", `machine_id=${"a".repeat(64)}`, "missing=ssh-host-keys", "probes=done"].join("\n");
  assert.deepEqual(forkSafetyOf(stdout, 0, "value"), { version: 7, identity: { machineId: "a".repeat(64), hostKeys: [] } });
  assert.deepEqual(forkSafetyOf(stdout, 0, "eth"), { version: null, identity: null });
  assert.deepEqual(forkSafetyOf(stdout, 0), { version: null, identity: null });
  assert.deepEqual(forkSafetyOf(stdout.replace(`machine_id=${"a".repeat(64)}`, "missing=machine-id"), 0, "value"), { version: null, identity: null }, "a machine ID is still needed");
  assert.deepEqual(forkSafetyOf(stdout.replace("missing=ssh-host-keys", "unreadable=/etc/ssh/ssh_host_ed25519_key.pub"), 0, "value"), { version: null, identity: null }, "an unreadable key is never taken for none");
});

test("070 unit 10: in an image with no ip command, as microsandbox's, the fork check reads its addresses with hostname -I, and its value marker, and passes a fork that reset (found live)", () => {
  const root = join(tempDir("msb-fork-probe"), "root");
  const bin = join(root, "..", "bin");
  const put = (path: string, text: string, mode = 0o644) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
    chmodSync(path, mode);
  };
  put(join(root, "etc/machine-id"), "fedcba9876543210fedcba9876543210\n");
  put(join(root, "etc/ssh/ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAInewkey fork\n");
  put(join(root, "etc/bb-box/identity"), "bb-box identity 1\nsource value\nvalue bxfork0000001\n");
  put(join(bin, "bb-box-identity"), "#!/bin/sh\nprintf 'version=7\\nenabled=yes\\nboot=reset\\nmarker=matches\\narmed=yes\\npending=no\\nbox=\\nsource=value\\n'\n", 0o755);
  put(join(bin, "id"), "#!/bin/sh\necho 0\n", 0o755);
  put(join(bin, "hostname"), "#!/bin/sh\necho 172.16.0.6 172.16.1.1 fd42:6d73:62::2\n", 0o755);
  for (const tool of ["sh", "sha256sum", "cut", "sed", "grep", "cat"]) {
    const found = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  const ran = spawnSync("/bin/sh", ["-c", forkCheckScript().replaceAll(IDENTITY_TOOL, join(bin, "bb-box-identity"))], { encoding: "utf8", env: { BBBOX_IDENTITY_ROOT: root, PATH: bin } });
  const seen = parseForkSeen(ran.stdout, ran.status);
  assert.deepEqual([seen.addresses, seen.markerValue, seen.unreadable], [["172.16.0.6", "172.16.1.1"], "bxfork0000001", []]);
  const expected = { forkMacs: [], forkValue: "bxfork0000001", sourceMacs: [], sourceBox: "bxsource00001", sourceName: "amber-fox", sourceAddresses: [], freedSourceAddresses: [], ownAddress: null, boxAddresses: [], held: { machineId: "c".repeat(64), hostKeys: [] }, safeFrom: 7 };
  assert.deepEqual(forkVerdict(seen, expected), { is: "ready" });
});

test("070 unit 10: each start puts /run in memory again and the box's own hostname, which msb's restore does not keep", () => {
  assert.match(RUN_IN_MEMORY, /\$2 == "\/run"/);
  assert.match(RUN_IN_MEMORY, /mount -t tmpfs -o mode=0755,nosuid,nodev tmpfs \/run/);
  assert.match(RUN_IN_MEMORY, /rm -rf "\$held" \/run\/bb-box \/run\/bb-box-started/);
  assert.match(OWN_HOSTNAME, /h=\$\{BBBOX_HOSTNAME:-\}/);
  assert.match(OWN_HOSTNAME, /hostname "\$h"; printf '%s\\n' "\$h" >\/etc\/hostname/);
});

test("070 unit 10: through BB Box's own snapshots, a restore swaps the box to a new microVM that keeps its ID and records, the old one goes, the snapshots outlive it, and a release deletes those nobody kept", async () => {
  const fake = fakeMsbHost();
  const state = world({ markersOn: false, backend: (storage) => new MsbBackend(msbConfig(), testContext(storage, "test", { id: "fake" }), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 }) });
  const box = await readyBox(state);
  const old = box.guest!.ref;
  writeHome(fake, old, "work.txt", "before");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "before" })).snapshot!;
  writeHome(fake, old, "work.txt", "after");
  const second = (await state.snapshots.take(COMMAND, box, standing(box), { name: "after" })).snapshot!;
  assert.deepEqual(state.store.record(second.id)!.dependsOn, [target.id]);
  const third = (await state.snapshots.take(COMMAND, box, standing(box), { name: "third" })).snapshot!;
  await state.snapshots.delete(COMMAND, standing(box), second.id);
  assert.deepEqual(state.store.record(third.id)!.dependsOn, [], "a deleted parent no longer shows on its child");
  assert.equal(fake.snapshots().length, 2);
  const answer = await state.snapshots.restore(COMMAND, box, standing(box), target.id);
  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready");
  assert.equal(restored.id, box.id);
  assert.match(restored.guest!.ref, new RegExp(`^${old}-[0-9a-f]{8}$`));
  assert.equal(readFileSync(join(fake.home(restored.guest!.ref), "work.txt"), "utf8"), "before");
  assert.ok(!fake.sandboxes().includes(old), "the old microVM is deleted once the new one runs");
  assert.ok(answer.undo, "an undo, taken of the stopped box");
  assert.equal(state.store.record(answer.undo!.id)!.holds, "disk");
  for (const id of [target.id, third.id, answer.undo!.id]) assert.equal(state.store.record(id)!.livesOn.ref, restored.guest!.ref, "its snapshots follow the box");
  assert.equal(fake.snapshots().length, 3, "msb's snapshots outlive the microVM they were taken of");
  const undone = await state.snapshots.restore(COMMAND, restored, standing(restored), answer.undo!.id);
  const again = (await state.boxes.find(box.id))!;
  assert.equal(readFileSync(join(fake.home(again.guest!.ref), "work.txt"), "utf8"), "after");
  assert.ok(undone.undo);
  state.store.updateRecord(target.id, { forkSafe: 7 });
  await state.snapshots.keep(COMMAND, standing(again), target.id);
  assert.ok(existsSync(join(fake.dir, "kept", state.store.record(target.id)!.ref!)), "the keep date is on the host first");
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  for (let i = 0; i < 100 && fake.snapshots().length > 1; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(fake.snapshots().map((each) => each.id), [state.store.record(target.id)!.ref], "a release deletes its snapshots that nobody kept, and the kept one stays as it is");
  assert.deepEqual(fake.sandboxes(), []);
  const gone = state.store.record(target.id)!;
  assert.ok(gone.boxGone);
  const check = await state.snapshots.checkForkGone(gone);
  assert.equal(check.asMachine, true, "a kept snapshot of a released box forks as one of your machines, from the snapshot itself");
  await state.snapshots.deleteGone(gone, BY_COMMAND);
  assert.deepEqual(fake.snapshots(), []);
});

test("070 unit 10 review (Astra 1): BB Box restarting after a restore's new microVM took its access file, before its image's command ran, starts it again on recovery, and deletes the old microVM only once the new one is ready", async () => {
  const fake = fakeMsbHost();
  const state = world({ markersOn: false, backend: (storage) => new MsbBackend(msbConfig(), testContext(storage, "test", { id: "fake" }), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 }) });
  const box = await readyBox(state);
  const old = box.guest!.ref;
  writeHome(fake, old, "work.txt", "before");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "before" })).snapshot!;
  writeHome(fake, old, "work.txt", "after");
  let answered = false;
  Object.assign(state.backend, {
    start: async (_guest: Guest, signal?: AbortSignal, _timing?: unknown, written?: () => Promise<void>) => {
      await written?.();
      answered = true;
      await new Promise<never>((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  const held = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch((error: unknown) => error);
  for (let i = 0; i < 500 && !answered; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(answered, "the access file was written before the image's command ran");
  const fresh = state.store.unsettled().find((operation) => operation.kind === "restore")!.guests!.new!.ref;
  assert.ok(!existsSync(join(fake.root, "sandboxes", fresh, "run", "bb-box", "ready")), "the new microVM is not ready yet");
  await state.restart();
  await held;
  const cut = state.store.unsettled().find((operation) => operation.kind === "restore")!;
  assert.equal(cut.step, "starting", "an access file written within the start is still the start, so recovery starts the box again");
  assert.ok(fake.sandboxes().includes(old), "the old microVM stays until the new one has started");
  assert.equal(await state.snapshots.recover(), 1);
  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.equal(after.guest!.ref, fresh);
  assert.ok(existsSync(join(fake.root, "sandboxes", fresh, "run", "bb-box", "ready")), "its image's command ran, and it said it was ready");
  assert.equal(readFileSync(join(fake.home(fresh), "work.txt"), "utf8"), "before");
  assert.ok(!fake.sandboxes().includes(old), "only then is the old microVM deleted");
  assert.equal(state.store.operation(cut.id)!.state, "done");
});

test("070 unit 10 review (Opus 4): the upkeep removes the Docker disk template an earlier BB Box made on a host without mkfs.ext4, and the status script no longer counts it", () => {
  const dir = join(tempDir("msb-templates"), "microsandbox");
  mkdirSync(join(dir, "templates"), { recursive: true });
  writeFileSync(join(dir, "templates", "docker-64G.ext4"), Buffer.alloc(4 * 1024 * 1024, 1));
  const run = (name: "status" | "disks") => spawnSync("sh", ["-c", msbScript(name), "bb-box-msb"], { encoding: "utf8", env: { ...process.env, BBBOX_MSB_DIR: dir } });
  assert.ok(Number(scriptValues(run("status").stdout).used_kib) < 1024, "the template's 4 MiB are not counted");
  assert.equal(run("disks").status, 0);
  assert.ok(!existsSync(join(dir, "templates")), "the template goes with the upkeep's sweep of Docker disks");
});
