import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { createArgs, labelsOf, type BoxContainerSettings } from "../src/backends/docker/box-container.ts";
import { commitChanges, snapshotImage } from "../src/backends/docker/snapshots.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import { fakeDockerHost, dockerConfig, type FakeDockerHost } from "./fake-docker.ts";
import { tempDir, testContext } from "./helpers.ts";
import { COMMAND, THREAD, readyBox, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const RESTORED = /^bbbox-bx[0-9a-z]+-[0-9a-f]{8}$/;

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
    if (args[0] === "run" && args.some((arg) => arg.startsWith(`${fresh}-docker:`))) return ["copy Docker data"];
    if (args[0] === "container" && args[1] === "create") return ["create new"];
    if (args[0] === "container" && args[1] === "start") return [args.at(-1) === old ? "start old" : "start new"];
    if (args[0] === "container" && args[1] === "rm" && args.includes("--volumes")) return ["remove old"];
    return [];
  });
  assert.deepEqual(steps, ["kill old", "commit undo", "copy Docker data", "create new", "start new", "remove old"]);
  const create = calls.find((args) => args[0] === "container" && args[1] === "create")!;
  assert.equal(create[create.indexOf("--name") + 1], fresh);
  assert.equal(create.at(-2), snapshotImage("test", box.id, target.id));
  assert.equal(create[create.indexOf("--restart") + 1], "unless-stopped");
});

test("Docker keeps a restored container's Docker volume through a sweep that runs while its data is copied", async () => {
  const fake = fakeDockerHost();
  const { state, box, target } = await boxWithSnapshotOfA(fake);
  const release = join(tempDir("docker-restore"), "copy-may-finish");
  fake.set({ holdRestoreCopy: release });

  const restoring = state.snapshots.restore(COMMAND, box, standing(box), target.id);
  let volume: string | undefined;
  for (let i = 0; i < 1000 && !volume; i++) {
    volume = Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8"))).find((name) => RESTORED.test(name.replace(/-docker$/, "")));
    if (!volume) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(volume, "the restore made its new container's Docker volume");
  await state.backend.maintain!();
  assert.ok(volume in JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")), "the sweep left the volume of the container being made");
  writeFileSync(release, "");
  await restoring;

  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready");
  assert.deepEqual(readBoth(fake, restored), ["A", "A"]);
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
