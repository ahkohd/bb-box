import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test, type TestContext } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { createArgs, labelsOf, type BoxContainerSettings } from "../src/backends/docker/box-container.ts";
import { commitChanges, COPY_INTO, snapshotImage } from "../src/backends/docker/snapshots.ts";
import { REMOVALS_FAILED_BEFORE_DOCTOR_WARNS } from "../src/backends/docker/restore-copies.ts";
import { identity, type BoxRecord } from "../src/core/boxes.ts";
import type { BackendStorage } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { fakeDockerHost, dockerConfig, type FakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, tempDir, testContext } from "./helpers.ts";
import { FileStorage } from "./conformance/file-storage.ts";
import { interruptStep, type StepSeen } from "./conformance/interrupt.ts";
import { COMMAND, THREAD, readyBox, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const RESTORED = /^bbbox-bx[0-9a-z]+-[0-9a-f]{8}$/;
const MAKES_FAKE_DOCKER_BACKEND = fileURLToPath(new URL("./fake-docker-elsewhere.ts", import.meta.url));
const ENGINE_HOLDS_THE_COPY_CREATE = "copy-landing.json";
const COPY_MAY_LAND = "copy-may-land";
const COPY_LANDED = "copy-landed";

function dockerWorld(fake: FakeDockerHost): World {
  return world({ markersOn: false, backend: (storage) => new DockerBackend(dockerConfig(), testContext(storage, "test", { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000 }) as never });
}

function dockerVolumeOf(fake: FakeDockerHost, container: string): string {
  const mount = fake.inspect(container).HostConfig.Mounts?.find((each) => each.Target === "/var/lib/docker");
  assert.ok(mount?.Name, `${container} has a Docker volume`);
  return mount.Name;
}

function writeBoth(fake: FakeDockerHost, box: BoxRecord, value: string): void {
  const container = box.guest!.ref;
  mkdirSync(fake.home(container), { recursive: true });
  writeFileSync(join(fake.home(container), "work.txt"), value);
  fake.writeVolumeFiles(dockerVolumeOf(fake, container), { "inner/data.txt": value });
}

function readBoth(fake: FakeDockerHost, box: BoxRecord): readonly [string, string | undefined] {
  const container = box.guest!.ref;
  return [readFileSync(join(fake.home(container), "work.txt"), "utf8"), fake.volumeFiles(dockerVolumeOf(fake, container))["inner/data.txt"]];
}

async function boxWithSnapshotOfA(fake: FakeDockerHost) {
  const state = dockerWorld(fake);
  const box = await readyBox(state);
  writeBoth(fake, box, "A");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "A" })).snapshot!;
  writeBoth(fake, box, "B");
  return { state, box, target, old: box.guest!.ref };
}

function copiesInto(fake: FakeDockerHost, volume: string): string[] {
  return fake.containers().filter((name) => fake.inspect(name).HostConfig.Mounts?.some((mount) => mount.Name === volume && mount.Target === "/to"));
}

async function restoredVolumeOnce(fake: FakeDockerHost): Promise<string> {
  for (let i = 0; i < 1000; i++) {
    const volume = Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8"))).find((name) => RESTORED.test(name.replace(/-docker$/, "")));
    if (volume && copiesInto(fake, volume).length) return volume;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return assert.fail("the restore did not start copying into its new container's Docker volume");
}

function boxLabels(fake: FakeDockerHost, container: string): Record<string, string> {
  const labels = fake.inspect(container).Config.Labels;
  return Object.fromEntries(["bbbox.backend", "bbbox.install", "bbbox.box", "bbbox.thread", "bbbox.name", "bbbox.kind", "bbbox.created"].map((key) => [key, labels[key] ?? ""]));
}

test("Docker restores a snapshot as a new container that keeps the box's ID, name and labels, and its undo goes forward again", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  const labelsBefore = boxLabels(fake, old);

  const answer = await state.snapshots.restore(COMMAND, box, standing(box), target.id);

  const restored = (await state.boxes.find(box.id))!;
  const fresh = restored.guest!.ref;
  assert.equal(restored.state, "ready");
  assert.equal(restored.id, box.id);
  assert.equal(restored.name, box.name);
  assert.match(fresh, RESTORED);
  assert.deepEqual(boxLabels(fake, fresh), labelsBefore);
  assert.equal(fake.inspect(fresh).Config.Labels["bbbox.from-snapshot"], target.id);
  assert.ok(fake.inspect(fresh).Config.Env.includes(`BBBOX_IDENTITY=${box.id}`));
  assert.equal(fake.inspect(fresh).State.Status, "running");
  assert.deepEqual(readBoth(fake, restored), ["A", "A"]);
  assert.deepEqual(fake.containers(), [fresh], "the old container is gone once the new one runs");
  assert.ok(answer.undo);

  const undone = await state.snapshots.restore(COMMAND, restored, standing(restored), answer.undo!.id);

  const forward = (await state.boxes.find(box.id))!;
  assert.deepEqual(readBoth(fake, forward), ["B", "B"]);
  assert.deepEqual(fake.containers(), [forward.guest!.ref]);
  assert.ok(undone.undo);

  for (const id of [target.id, answer.undo!.id, undone.undo!.id]) await state.snapshots.delete(COMMAND, standing(forward), id);
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);
  assert.deepEqual(fake.containers(), []);
  assert.doesNotMatch(JSON.stringify(Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")))), /bbbox-/);
});

test("Docker kills the box, takes its undo, copies the snapshot's Docker data, makes the new container, starts it, then removes the old one", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  const before = fake.calls().length;

  await state.snapshots.restore(COMMAND, box, standing(box), target.id);

  const fresh = (await state.boxes.find(box.id))!.guest!.ref;
  const calls = fake.calls().slice(before);
  const steps = calls.flatMap((args) => {
    if (args[0] === "container" && args[1] === "kill") return ["kill old"];
    if (args[0] === "container" && args[1] === "commit") return ["commit undo"];
    if (args[0] === "container" && args[1] === "create" && args.includes(`${fresh}-docker:/to`)) return ["copy Docker data"];
    if (args[0] === "container" && args[1] === "start" && args.includes("--attach")) return [];
    if (args[0] === "container" && args[1] === "create") return ["create new"];
    if (args[0] === "container" && args[1] === "start") return [args.at(-1) === old ? "start old" : "start new"];
    if (args[0] === "container" && args[1] === "rm" && args.includes("--volumes")) return ["remove old"];
    return [];
  });
  assert.deepEqual(steps, ["kill old", "commit undo", "copy Docker data", "create new", "start new", "remove old"]);
  const create = calls.find((args) => args[0] === "container" && args[1] === "create" && args[args.indexOf("--name") + 1] === fresh);
  assert.ok(create, "the new container is made with its own name");
  assert.equal(create.at(-2), snapshotImage("test", box.id, target.id));
  assert.equal(create[create.indexOf("--restart") + 1], "unless-stopped");
});

test("Docker keeps a restored container's Docker volume through a sweep that runs while its data is copied", async () => {
  const fake = fakeDockerHost();
  const { state, box, target } = await boxWithSnapshotOfA(fake);
  const release = join(tempDir("docker-restore"), "copy-may-finish");
  fake.set({ holdRestoreCopy: release });

  const restoring = state.snapshots.restore(COMMAND, box, standing(box), target.id);
  const volume = await restoredVolumeOnce(fake);
  await state.backend.maintain!();
  assert.ok(volume in JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")), "the sweep left the volume of the container being made");
  writeFileSync(release, "");
  await restoring;

  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready");
  assert.deepEqual(readBoth(fake, restored), ["A", "A"]);
});

test("Docker releases a restored container whose Docker data is still being copied, as after BB stopped part way, and leaves nothing of it", async () => {
  const fake = fakeDockerHost();
  const { state, box, target } = await boxWithSnapshotOfA(fake);
  const copyMayFinish = join(tempDir("docker-restore"), "copy-may-finish");
  fake.set({ holdRestoreCopy: copyMayFinish });
  const restoring = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch(() => null);
  const volume = await restoredVolumeOnce(fake);

  const restarted = new DockerBackend(dockerConfig(), testContext(new MemoryStorage(), "test", { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000 });
  await restarted.release({ ref: volume.replace(/-docker$/, ""), host: null, address: null, size: null, data: { box: box.id } }, { resetting: async () => {}, timing: () => {} });

  assert.equal(volume in JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")), false, "the part-made container's Docker volume is gone");
  assert.deepEqual(copiesInto(fake, volume), [], "and so is the copy into it");
  writeFileSync(copyMayFinish, "");
  await restoring;
});

function volumesOn(fake: FakeDockerHost): Record<string, { readonly Labels: Record<string, string> | null }> {
  return JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8"));
}

function dockerOn(fake: FakeDockerHost, storage: BackendStorage, now?: () => number): DockerBackend {
  return new DockerBackend(dockerConfig(), testContext(storage, "test", { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000, ...(now ? { now } : {}) });
}

async function snapshotRefOf(fake: FakeDockerHost) {
  const [held] = await dockerOn(fake, new MemoryStorage()).heldSnapshots();
  return { id: held!.id, ref: held!.ref, guest: held!.guest };
}

function theEngineFinishesTheCopy(fake: FakeDockerHost, copy: string): void {
  const config = join(fake.root, "containers", copy, "config.json");
  const container = JSON.parse(readFileSync(config, "utf8"));
  if (container.HostConfig.AutoRemove) return rmSync(dirname(config), { recursive: true, force: true });
  writeFileSync(config, JSON.stringify({ ...container, State: { Status: "exited", Running: false, Paused: false, ExitCode: 0 } }));
}

async function untilTheEngineFinishedTheCopyCreate(fake: FakeDockerHost): Promise<void> {
  for (let i = 0; i < 1000 && !existsSync(join(fake.root, COPY_LANDED)); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

interface EngineHoldingTheCopyCreate {
  readonly target: string;
  readonly engine: number;
}

function engineHoldingTheCopyCreate(fake: FakeDockerHost): EngineHoldingTheCopyCreate | null {
  const marker = join(fake.root, ENGINE_HOLDS_THE_COPY_CREATE);
  return existsSync(marker) ? JSON.parse(readFileSync(marker, "utf8")) : null;
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function untilEnded(pid: number): Promise<boolean> {
  for (let i = 0; i < 1000 && running(pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return !running(pid);
}

function letTheCopyLandThenCheckTheEngineEnded(t: TestContext, fake: FakeDockerHost): void {
  t.after(async () => {
    writeFileSync(join(fake.root, COPY_MAY_LAND), "");
    const holding = engineHoldingTheCopyCreate(fake);
    if (holding) assert.equal(await untilEnded(holding.engine), true, "the engine's late create ended, and left no process behind");
  });
}

async function restoreKilledWhileTheEngineMakesItsCopy(t: TestContext) {
  const fake = fakeDockerHost();
  const { box } = await boxWithSnapshotOfA(fake);
  const ref = await snapshotRefOf(fake);
  fake.set({ restoreCopyLandsLate: true });
  letTheCopyLandThenCheckTheEngineEnded(t, fake);
  const storage = join(tempDir("docker-restore"), "storage.json");

  const step = { step: "restore" as const, guest: box.guest!, ref, box: identity(box, box.size!) };
  const theEngineHoldsTheCopyCreate = async () => engineHoldingTheCopyCreate(fake) !== null;
  const seen = await interruptStep({ module: MAKES_FAKE_DOCKER_BACKEND, args: [fake.binary] }, storage, "test", step, theEngineHoldsTheCopyCreate, 30_000);

  assert.ok(seen.claimed, "the restore named its new guest");
  assert.ok(running(engineHoldingTheCopyCreate(fake)!.engine), "the engine still holds the copy's create after the restore's processes were killed");
  const volume = `${seen.claimed.ref}-docker`;
  assert.ok(volume in volumesOn(fake), "the killed restore left its new guest's Docker volume");
  return { fake, claimed: seen.claimed, storage, volume };
}

const KILLS_A_PROCESS_GROUP = { skip: process.platform === "win32" && "kills a process group" };

test("Docker releases a restore killed while the engine still made its copy, and removes the copy and the volume it made again", KILLS_A_PROCESS_GROUP, async (t) => {
  const { fake, claimed, storage, volume } = await restoreKilledWhileTheEngineMakesItsCopy(t);

  await dockerOn(fake, new FileStorage(storage)).release(claimed, { resetting: async () => {}, timing: () => {} });
  await untilTheEngineFinishedTheCopyCreate(fake);

  assert.equal(existsSync(join(fake.root, COPY_LANDED)), true, "the engine made the copy after the release began");
  assert.deepEqual(copiesInto(fake, volume), [], "no copy into the released guest's volume is left");
  assert.equal(volume in volumesOn(fake), false, "nor the volume the late copy made again");
});

test("Docker's maintenance removes a copy the engine made after its restore was killed and released, and the volume it made again", KILLS_A_PROCESS_GROUP, async (t) => {
  const { fake, claimed, volume } = await restoreKilledWhileTheEngineMakesItsCopy(t);
  const withoutTheRestoresStorage = dockerOn(fake, new MemoryStorage());
  await withoutTheRestoresStorage.release(claimed, { resetting: async () => {}, timing: () => {} });
  await untilTheEngineFinishedTheCopyCreate(fake);
  assert.equal(copiesInto(fake, volume).length, 1, "the late copy came after the release");
  assert.deepEqual(volumesOn(fake)[volume]?.Labels ?? null, null, "and made its volume again, without labels");

  await withoutTheRestoresStorage.maintain();

  assert.deepEqual(copiesInto(fake, volume), [], "maintenance removed the copy");
  assert.equal(volume in volumesOn(fake), false, "and the volume it made again");
});

async function lateCopyAfterAReleaseThatLostItsNote(t: TestContext) {
  const killed = await restoreKilledWhileTheEngineMakesItsCopy(t);
  const docker = dockerOn(killed.fake, new MemoryStorage());
  await docker.release(killed.claimed, { resetting: async () => {}, timing: () => {} });
  await untilTheEngineFinishedTheCopyCreate(killed.fake);
  assert.equal(copiesInto(killed.fake, killed.volume).length, 1, "the late copy came after the release");
  return { ...killed, docker };
}

async function snapshotLeftovers(docker: DockerBackend) {
  return (await docker.doctor()).checks.find((check) => check.id === "docker.snapshot-leftovers");
}

test("Docker's maintenance keeps the volume a late copy made again until a later sweep removes it, when the first removal fails", KILLS_A_PROCESS_GROUP, async (t) => {
  const { fake, volume, docker } = await lateCopyAfterAReleaseThatLostItsNote(t);
  fake.set({ failVolumeRemove: volume });

  await docker.maintain();

  assert.deepEqual(copiesInto(fake, volume), [], "the first sweep removed the copy");
  assert.equal(volume in volumesOn(fake), true, "but not the volume, whose removal failed");

  fake.set({ failVolumeRemove: null });
  await docker.maintain();

  assert.equal(volume in volumesOn(fake), false, "a later sweep removed the volume");
});

test("Docker's doctor names a volume a late copy made again once maintenance has failed to remove it 3 times, until it goes", KILLS_A_PROCESS_GROUP, async (t) => {
  const { fake, volume, docker } = await lateCopyAfterAReleaseThatLostItsNote(t);
  fake.set({ failVolumeRemove: volume });

  for (let sweep = 0; sweep < REMOVALS_FAILED_BEFORE_DOCTOR_WARNS; sweep++) await docker.maintain();

  const warned = await snapshotLeftovers(docker);
  assert.equal(warned?.status, "warn");
  assert.ok(warned?.detail.includes(`${volume}, after 3 tries`), `the warning names the volume: ${warned?.detail}`);
  assert.match(warned?.fix ?? "", /docker ps --all --filter volume=/, "and says how to find what holds it");

  fake.set({ failVolumeRemove: null });
  await docker.maintain();

  assert.equal(volume in volumesOn(fake), false, "the next sweep removed the volume");
  assert.equal((await snapshotLeftovers(docker))?.status, "ok", "and the warning went with it");
});

test("Docker releases a box that holds no restore note with one volume list, inspect and removal, and asks Docker nothing about copies", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const box = await readyBox(state);
  const before = fake.calls().length;

  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);

  const calls = fake.calls().slice(before);
  const aboutTheBoxsVolume = calls.filter((args) => args[0] === "volume" && args.some((arg) => arg.includes(box.guest!.ref)));
  const aboutCopies = calls.filter((args) => args.some((arg) => arg.includes(COPY_INTO)));
  assert.deepEqual(aboutTheBoxsVolume.map((args) => args.slice(0, 2)), [["volume", "ls"], ["volume", "inspect"], ["volume", "rm"]]);
  assert.deepEqual(aboutCopies, [], "nothing about copies");
});

test("Docker releases a restore killed while its copy ran, once the engine has finished that copy, without waiting for it", { ...KILLS_A_PROCESS_GROUP, timeout: 30_000 }, async (t) => {
  const fake = fakeDockerHost();
  const { box } = await boxWithSnapshotOfA(fake);
  const ref = await snapshotRefOf(fake);
  const copyMayFinish = join(tempDir("docker-restore"), "copy-may-finish");
  fake.set({ holdRestoreCopy: copyMayFinish });
  t.after(() => writeFileSync(copyMayFinish, ""));
  const storage = join(tempDir("docker-restore"), "storage.json");

  const step = { step: "restore" as const, guest: box.guest!, ref, box: identity(box, box.size!) };
  const copyRuns = async (seen: StepSeen) => seen.claimed !== null && copiesInto(fake, `${seen.claimed.ref}-docker`).some((copy) => fake.inspect(copy).State.Status === "running");
  const seen = await interruptStep({ module: MAKES_FAKE_DOCKER_BACKEND, args: [fake.binary] }, storage, "test", step, copyRuns, 30_000);
  const volume = `${seen.claimed!.ref}-docker`;
  theEngineFinishesTheCopy(fake, copiesInto(fake, volume)[0]!);

  const beforeTheCopysTimeRunsOut = Date.now();
  await dockerOn(fake, new FileStorage(storage), () => beforeTheCopysTimeRunsOut).release(seen.claimed!, { resetting: async () => {}, timing: () => {} });

  assert.deepEqual(copiesInto(fake, volume), [], "the finished copy is gone");
  assert.equal(volume in volumesOn(fake), false, "and so is the part-made guest's volume");
});

test("Docker puts the old container back when the new one does not start, and removes the new one with its volume", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  fake.set({ failStartMatching: "-[0-9a-f]{8}$" });

  await state.snapshots.restore(COMMAND, box, standing(box), target.id).catch(() => null);

  const back = (await state.boxes.find(box.id))!;
  assert.equal(back.guest!.ref, old);
  assert.equal(back.state, "ready");
  assert.deepEqual(fake.containers(), [old]);
  assert.equal(fake.inspect(old).State.Status, "running");
  assert.deepEqual(readBoth(fake, back), ["B", "B"]);
  assert.doesNotMatch(JSON.stringify(Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")))), /bbbox-bx[0-9a-z]+-[0-9a-f]{8}-docker/);
  assert.equal(state.store.record(target.id)!.livesOn.ref, old);
});

test("Docker removes a part-made restored container's volume when copying its Docker data fails, and keeps the box", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  fake.set({ failRestoreCopy: true });

  await state.snapshots.restore(COMMAND, box, standing(box), target.id).catch(() => null);

  const back = (await state.boxes.find(box.id))!;
  assert.equal(back.guest!.ref, old);
  assert.equal(back.state, "ready");
  assert.deepEqual(fake.containers(), [old]);
  assert.doesNotMatch(JSON.stringify(Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")))), /bbbox-bx[0-9a-z]+-[0-9a-f]{8}-docker/);
});

test("Docker finishes a restore that BB Box stopped after the undo was taken, leaving one working box", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  state.holds.step = "undo";

  const held = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  assert.deepEqual(fake.containers(), [old], "the box is stopped with its undo taken");
  assert.equal(await state.snapshots.recover(), 1);

  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.match(after.guest!.ref, RESTORED);
  assert.deepEqual(fake.containers(), [after.guest!.ref]);
  assert.deepEqual(readBoth(fake, after), ["A", "A"]);
});

test("Docker finishes a restore that BB Box stopped after the new container was made, before the old one was removed", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  state.holds.step = "adopted";

  const held = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  const fresh = state.store.unsettled().find((operation) => operation.kind === "restore")!.guests!.new!.ref;
  assert.deepEqual(fake.containers(), [old, fresh].sort(), "both containers are there, the old one stopped");
  assert.equal(fake.inspect(old).State.Status, "exited");
  await state.backend.maintain!();
  assert.ok(existsSync(join(fake.root, "containers", fresh)));
  assert.equal(await state.snapshots.recover(), 1);

  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready");
  assert.equal(after.guest!.ref, fresh);
  assert.deepEqual(fake.containers(), [fresh]);
  assert.deepEqual(readBoth(fake, after), ["A", "A"]);
});

test("Docker plans and makes a restore at the size the snapshot was taken at, with an undo", async () => {
  const fake = fakeDockerHost();
  const { state, box, target, old } = await boxWithSnapshotOfA(fake);
  const backend = state.backend as unknown as DockerBackend;
  const taken = box.guest!.size!;
  await new DockerCli(null, fake.binary).ok(["container", "update", "--cpus", "1", "--memory", "2048m", "--memory-swap", "2048m", old]);
  const smaller = { ...box.guest!, size: { cores: 1, memoryMiB: 2048, diskGiB: null } };

  const plan = await backend.planSnapshots(smaller, box.kind, { id: target.id, ref: target.ref!, guest: target.livesOn });

  assert.deepEqual([plan.restore.way, plan.restore.undo, plan.restore.why], ["new-guest", "snapshot", null]);
  assert.deepEqual([plan.restore.sizeBack?.cores, plan.restore.sizeBack?.memoryMiB], [taken.cores, taken.memoryMiB]);
  assert.equal(backend.snapshotting(box.kind)?.restore, "new-guest");

  await state.snapshots.restore(COMMAND, box, standing(box), target.id);

  const fresh = (await state.boxes.find(box.id))!.guest!.ref;
  assert.equal(fake.inspect(fresh).HostConfig.NanoCpus, taken.cores * 1e9);
  assert.equal(fake.inspect(fresh).HostConfig.Memory, taken.memoryMiB * 1024 * 1024);
});

test("Docker refuses to plan a restore of a snapshot it no longer has, and says what to do", async () => {
  const fake = fakeDockerHost();
  const { state, box, target } = await boxWithSnapshotOfA(fake);
  const backend = state.backend as unknown as DockerBackend;

  const missing = await backend.planSnapshots(box.guest!, box.kind, { id: "sn-gone", ref: snapshotImage("test", box.id, "sn-gone"), guest: target.livesOn });

  assert.equal(missing.restore.way, "none");
  assert.match(missing.restore.why ?? "", /no longer has this snapshot\. Choose another snapshot\./);
});

test("Docker counts a restored container as the box's own when its box is not named", async () => {
  const fake = fakeDockerHost();
  const { state, box, target } = await boxWithSnapshotOfA(fake);
  await state.snapshots.restore(COMMAND, box, standing(box), target.id);
  const fresh = (await state.boxes.find(box.id))!.guest!.ref;

  const power = await state.backend.power({ ref: fresh, host: null, address: null, size: null });

  assert.equal(power, "running");
  assert.equal(await state.backend.power({ ref: `${fresh}x`, host: null, address: null, size: null }), null);
});

test("Docker blanks in a snapshot image every label BB Box gives a box's container", () => {
  const settings: BoxContainerSettings = {
    box: { boxId: "bx1", threadId: "thr_1", name: "amber-fox", kind: "linux", createdAt: 1, size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu: "shared" } } as never,
    installId: "test",
    name: "bbbox-bx1",
    image: "bbbox/linux:1",
    dockerVolume: "bbbox-bx1-docker",
    placement: { gpu: "nvidia.com/gpu=0", card: "GPU-1", part: "shared", cpus: null },
    lxcfs: null,
    privileged: true,
    network: "bbbox",
    firstStart: "runs-its-services",
    fromSnapshot: "sn1",
  };
  const args = createArgs(settings);
  const given = Object.fromEntries(args.flatMap((arg, at) => (args[at - 1] === "--label" ? [arg.split("=")] : [])) as [string, string][]);

  const changes = commitChanges(given, {});

  assert.deepEqual(Object.keys(given).sort(), Object.keys(labelsOf(settings)).sort());
  for (const key of Object.keys(given)) assert.ok(changes.includes(`LABEL ${key}=""`), key);
});
