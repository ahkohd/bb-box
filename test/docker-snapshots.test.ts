import assert from "node:assert/strict";
import { test } from "node:test";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { DockerSnapshotEngine } from "../src/backends/docker/snapshot-engine.ts";
import { commitChanges, mountRefusal, pauseEstimate, pausedTooLong, snapshotImage } from "../src/backends/docker/snapshots.ts";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { fakeDockerHost, dockerConfig } from "./fake-docker.ts";
import { testContext } from "./helpers.ts";
import type { Guest } from "../src/backends/types.ts";

async function setup(anonymous = false) {
  const fake = fakeDockerHost();
  const cli = new DockerCli(null, fake.binary);
  await cli.ok(["network", "create", "snapshot-test"]);
  if (!anonymous) await cli.ok(["volume", "create", "box-docker"]);
  await cli.ok(["container", "create", "--name", "bbbox-bx123", "--network", "snapshot-test", "--label", "bbbox.backend=docker", "--label", "bbbox.kind=linux", "--label", "bbbox.install=test", "--label", "bbbox.box=bx123", "--env", "BBBOX_IDENTITY=source", "--env", "BBBOX_GPU_CARD=source-card", "--volume", anonymous ? "/var/lib/docker" : "box-docker:/var/lib/docker", "bbbox/linux:1"]);
  await cli.ok(["container", "start", "bbbox-bx123"]);
  const guest: Guest = { ref: "bbbox-bx123", host: null, address: null, size: null, data: { box: "bx123" } };
  const context = testContext();
  const engine = new DockerSnapshotEngine(cli, context, () => 100_000);
  const hooks = { submitting: async () => {}, task: async () => {} };
  return { fake, cli, guest, engine, context, hooks };
}

test("Docker snapshots retain disk and Docker data, and can be deleted", async () => {
  const { engine, cli, guest, hooks, fake } = await setup();
  fake.writeVolumeFiles("box-docker", { value: "A" });
  const plan = await engine.plan(guest);
  assert.equal(plan.take.ok, true);

  const taken = await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  assert.equal(taken.holds, "disk");
  assert.equal(taken.size?.means, "whole");
  assert.deepEqual(fake.volumeFiles("bbbox-snapshot-sn123-docker"), { value: "A" });
  const images = JSON.parse(await cli.ok(["image", "inspect", taken.ref]));
  assert.equal(images[0].Config.Labels["bbbox.box"], "");
  assert.ok(images[0].Config.Env.includes("BBBOX_IDENTITY="));
  assert.ok(images[0].Config.Env.includes("BBBOX_GPU_CARD="));
  assert.equal(taken.size?.bytes, 4096 + 1024 * 1024);
  assert.equal(fake.inspect(guest.ref).State.Status, "running");
  assert.equal((await engine.listed())[0]?.state, "complete");

  const steps = fake.calls().filter((args) => args[0] === "pause" || args.includes("/from/.") || args[1] === "commit" || args[0] === "unpause");
  assert.deepEqual(steps.map((args) => args[0] === "container" ? args[1] : args[0]), ["pause", "run", "commit", "unpause"]);
  const copy = steps[1]!;
  assert.equal(copy[copy.indexOf("--network") + 1], "none");
  assert.equal(copy[copy.indexOf("--pull") + 1], "never");
  assert.ok(copy.includes("--privileged"));
  assert.ok(copy.includes(fake.inspect(guest.ref).Image));
  assert.ok(copy.some((arg) => arg.endsWith(":/from:ro")));

  await engine.remove({ id: "sn123", ref: taken.ref, guest }, hooks);
  assert.deepEqual(await engine.listed(), []);
});

test("Docker unpauses after a failed commit", async () => {
  const { engine, guest, hooks, fake } = await setup();
  fake.set({ failSnapshotCommit: true });

  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks), /commit failed/);
  assert.equal(fake.inspect(guest.ref).State.Status, "running");
  assert.deepEqual(await engine.listed(), []);
});

test("Docker refuses unsupported writable mounts before pausing", async () => {
  const { engine, guest, hooks, fake } = await setup();
  fake.set({ snapshotMounts: [{ Type: "bind", Destination: "/work", RW: true }] });

  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks), /shared storage at \/work/);
  assert.equal(fake.calls().some((args) => args[0] === "pause"), false);
});

test("Docker snapshot estimates account for the image store and bound recovery", () => {
  assert.equal(pauseEstimate({ layerBytes: 100, volumeBytes: 30, store: "containerd" }).addsBytes, 230);
  assert.equal(pausedTooLong({ startedAt: 100, estimateMs: 1000 }, 63099), false);
  assert.equal(pausedTooLong({ startedAt: 100, estimateMs: 1000 }, 63100), true);
  assert.equal(snapshotImage("test", "bx123", "sn123"), "bbbox-snapshot/test/bx123:sn123");
  assert.equal(mountRefusal([{ type: "volume", name: "anonymous", destination: "/var/lib/docker", writable: true }]), null);
  assert.ok(commitChanges({ "bbbox.box": "source" }, {}).includes('LABEL bbbox.box=""'));
  assert.ok(commitChanges({}, {}).includes("ENV BBBOX_IDENTITY="));
});

test("Docker refuses images at the layer limit before pausing", async () => {
  const { engine, guest, hooks, fake } = await setup();
  fake.set({ snapshotLayers: 120 });

  assert.equal((await engine.plan(guest)).take.ok, false);
  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks), /120 or more layers/);
  assert.equal(fake.calls().some((args) => args[0] === "pause"), false);
});

test("Docker recovers an interrupted take and removes its partial volume", async () => {
  const { cli, guest, hooks, context } = await setup();
  await context.storage.set("docker-snapshot-take:sn123", { id: "sn123", box: "bx123", container: guest.ref, startedAt: 0, estimateMs: 1000, phase: "taking" });
  await cli.ok(["volume", "create", "--label", "bbbox.snapshot=sn123", "--label", "bbbox.snapshot.box=bx123", "--label", "bbbox.snapshot.install=test", "bbbox-snapshot-sn123-docker"]);
  await cli.ok(["pause", guest.ref]);
  const restarted = new DockerSnapshotEngine(cli, context, () => 100_000);

  assert.equal((await restarted.settle({ ref: "take:sn123@0", host: null })).state, "failed");
  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "running");
  assert.notEqual((await cli.run(["volume", "inspect", "bbbox-snapshot-sn123-docker"])).exitCode, 0);
  assert.deepEqual(await restarted.listed(), []);
});

test("Docker deletion leaves another install's snapshot volume alone", async () => {
  const { cli, engine, guest, hooks } = await setup();
  await cli.ok(["volume", "create", "--label", "bbbox.snapshot=sn123", "--label", "bbbox.snapshot.box=bx123", "--label", "bbbox.snapshot.install=other", "bbbox-snapshot-sn123-docker"]);

  await assert.rejects(engine.remove({ id: "sn123", ref: snapshotImage("test", "bx123", "sn123"), guest }, hooks), /another box or install/);
  assert.equal((await cli.run(["volume", "inspect", "bbbox-snapshot-sn123-docker"])).exitCode, 0);
});

test("Docker finds complete snapshots without local records", async () => {
  const { engine, cli, guest, hooks } = await setup();
  await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  const recovered = new DockerSnapshotEngine(cli, testContext(), () => 100_000);

  const held = await recovered.listed();
  assert.equal(held.length, 1);
  assert.equal(held[0]?.id, "sn123");
  assert.equal(held[0]?.state, "complete");
});

test("Docker does not trust an image after a failed task", async () => {
  const { engine, context, guest, hooks } = await setup();
  await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  await context.storage.set("docker-snapshot-take:sn123", { id: "sn123", box: "bx123", container: guest.ref, startedAt: 0, estimateMs: 1000, phase: "failed" });

  assert.equal((await engine.listed())[0]?.state, "incomplete");
  await engine.maintain();
  assert.deepEqual(await engine.listed(), []);
});

test("Docker retries unpausing when the commit finished but unpause failed", async () => {
  const { engine, cli, context, guest, hooks, fake } = await setup();
  fake.set({ failSnapshotUnpause: true });
  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks), /Unpause failed/);
  assert.equal(fake.inspect(guest.ref).State.Status, "paused");
  fake.set({ failSnapshotUnpause: false });
  const restarted = new DockerSnapshotEngine(cli, context, () => 100_000);

  await restarted.maintain();
  assert.equal(fake.inspect(guest.ref).State.Status, "running");
  assert.equal((await restarted.listed())[0]?.state, "complete");
});


test("Docker leaves an interrupted pause alone until its recovery bound", async () => {
  const { engine, cli, context, guest } = await setup();
  await context.storage.set("docker-snapshot-take:sn123", { id: "sn123", box: "bx123", container: guest.ref, startedAt: 90_000, estimateMs: 1000, phase: "taking" });
  await cli.ok(["pause", guest.ref]);

  assert.equal((await engine.settle({ ref: "take:sn123@90000", host: null })).state, "running");
  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "paused");
});


test("Docker captures an older anonymous Docker volume", async () => {
  const { engine, guest, hooks, cli } = await setup(true);
  const before = await cli.ok(["volume", "ls", "--format", "{{.Name}}"]);

  const taken = await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  assert.equal((await engine.listed())[0]?.state, "complete");
  await engine.remove({ id: "sn123", ref: taken.ref, guest }, hooks);

  const after = await cli.ok(["volume", "ls", "--format", "{{.Name}}"]);
  for (const volume of before.trim().split("\n")) assert.ok(after.includes(volume));
});

test("Docker leaves a pause it did not make alone", async () => {
  const { engine, guest, hooks, cli } = await setup();
  await cli.ok(["pause", guest.ref]);

  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks), /already paused/);
  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "paused");
});

test("Docker reports the engine's space for the core's room check", async () => {
  const { engine, guest, fake } = await setup();
  fake.set({ snapshotUsedKiB: 860000 });

  const plan = await engine.plan(guest);
  assert.equal(plan.storage.percentFull, 86);
  assert.equal(plan.storage.totalBytes, 1000000 * 1024);
  assert.equal(plan.take.addsBytes, 4096 + 1024 * 1024);
});


test("Docker recovery does not take ownership of a later manual pause", async () => {
  const { engine, guest, hooks, fake, cli } = await setup();
  fake.set({ failSnapshotCommit: true });
  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks));
  await cli.ok(["pause", guest.ref]);

  await engine.maintain();
  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "paused");
});


test("Docker backend release leaves snapshots for the core to manage", async () => {
  const { engine, guest, hooks, cli, fake, context } = await setup();
  await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  await cli.ok(["container", "create", "--name", "bbbox-bxother", "--network", "snapshot-test", "--label", "bbbox.install=test", "--label", "bbbox.box=bxother", "--volume", "/var/lib/docker", "bbbox/linux:1"]);
  const other: Guest = { ...guest, ref: "bbbox-bxother", data: { box: "bxother" } };
  await engine.take(other, { id: "snother", box: "bxother", memory: false }, hooks);
  const backend = new DockerBackend(dockerConfig(), context, { binary: fake.binary });

  await backend.release(guest, { resetting: async () => {}, timing: () => {} });

  assert.deepEqual((await engine.listed()).map((held) => held.id), ["sn123", "snother"]);
  assert.equal((await cli.inspect([guest.ref])).length, 0);
  assert.equal((await cli.inspect([other.ref])).length, 1);
});


test("Docker deletes the snapshot tag and volume while another container uses its layers", async () => {
  const { engine, guest, hooks, cli } = await setup();
  const taken = await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  await cli.ok(["container", "create", "--name", "manual-copy", "--network", "snapshot-test", taken.ref]);

  await engine.remove({ id: "sn123", ref: taken.ref, guest }, hooks);

  assert.deepEqual(await engine.listed(), []);
  assert.equal((await cli.inspect(["manual-copy"])).length, 1);
  assert.notEqual((await cli.run(["volume", "inspect", "bbbox-snapshot-sn123-docker"])).exitCode, 0);
});


test("Docker reports and prunes this install's unused snapshot images without tags", async () => {
  const { engine, fake } = await setup();
  fake.set({ snapshotDangling: [{ id: "sha256:one", install: "test" }, { id: "sha256:two", install: "other" }] });

  const check = (await engine.doctor()).find((check) => check.id === "docker.snapshot-leftovers");
  assert.equal(check?.status, "warn");
  assert.match(check?.detail ?? "", /images without tags: 1/);

  await engine.maintain();
  const cleaned = (await engine.doctor()).find((check) => check.id === "docker.snapshot-leftovers");
  assert.equal(cleaned?.status, "ok");
});

test("Docker retires failed takes after cleanup", async () => {
  const { engine, guest, hooks, fake, context } = await setup();
  fake.set({ failSnapshotCommit: true });

  await assert.rejects(engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks));
  await engine.maintain();
  const before = fake.calls().filter((args) => args[0] === "image" && args[1] === "rm").length;
  await engine.maintain();

  assert.equal(fake.calls().filter((args) => args[0] === "image" && args[1] === "rm").length, before);
  assert.deepEqual(await context.storage.list("docker-snapshot-take:"), []);
});

test("Docker retires the task when its snapshot is deleted", async () => {
  const { engine, guest, hooks, context } = await setup();
  const taken = await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);

  await engine.remove({ id: "sn123", ref: taken.ref, guest }, hooks);

  assert.deepEqual(await context.storage.list("docker-snapshot-take:"), []);
});

test("Docker rebuilding lost records leaves a person's pause alone", async () => {
  const { engine, guest, hooks, cli } = await setup();
  await engine.take(guest, { id: "sn123", box: "bx123", memory: false }, hooks);
  await cli.ok(["pause", guest.ref]);
  const recovered = new DockerSnapshotEngine(cli, testContext(), () => 1_000_000);

  await recovered.maintain();

  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "paused");
});

test("Docker snapshot changes preserve image metadata", () => {
  const changes = commitChanges({ "bbbox.box": "source", "bbbox.image-version": "1", "bbbox.bb-app": "digest", "bbbox.image-record": "record", "bbbox.gpu-bus-id": "slot" }, {});

  assert.deepEqual(changes.filter((value) => value.startsWith("LABEL")), ['LABEL bbbox.box=""']);
});


test("Docker space probes leave no volume behind and doctor does not scan box data", async () => {
  const { engine, cli, guest, fake } = await setup();

  await engine.plan(guest);
  const before = fake.calls().filter((args) => args.includes("du -sk /from")).length;
  await engine.doctor();

  assert.equal(fake.calls().filter((args) => args.includes("du -sk /from")).length, before);
  assert.doesNotMatch(await cli.ok(["volume", "ls", "--format", "{{.Name}}"]), /snapshot-space/);
});

test("Docker cleans an orphan snapshot volume without unpausing its box", async () => {
  const { engine, cli, guest } = await setup();
  await cli.ok(["volume", "create", "--label", "bbbox.snapshot=sn123", "--label", "bbbox.snapshot.box=bx123", "--label", "bbbox.snapshot.install=test", "--label", `bbbox.snapshot.container=${guest.ref}`, "--label", "bbbox.snapshot.started=0", "--label", "bbbox.snapshot.estimate-ms=1000", "bbbox-snapshot-sn123-docker"]);
  await cli.ok(["pause", guest.ref]);

  await engine.maintain();

  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "paused");
  assert.notEqual((await cli.run(["volume", "inspect", "bbbox-snapshot-sn123-docker"])).exitCode, 0);
});

test("Docker maintenance unpauses later takes when an earlier cleanup fails", async () => {
  const { cli, guest, context } = await setup();
  await context.storage.set("docker-snapshot-take:stuck", { id: "stuck", box: "bx123", container: guest.ref, startedAt: 0, estimateMs: 1000, phase: "failed-resumed" });
  await cli.ok(["volume", "create", "--label", "bbbox.snapshot.install=other", "bbbox-snapshot-stuck-docker"]);
  await context.storage.set("docker-snapshot-take:later", { id: "later", box: "bx123", container: guest.ref, startedAt: 0, estimateMs: 1000, phase: "taking" });
  await cli.ok(["pause", guest.ref]);
  const restarted = new DockerSnapshotEngine(cli, context, () => 100_000);

  await restarted.maintain();

  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "running");
  assert.equal((await cli.run(["volume", "inspect", "bbbox-snapshot-stuck-docker"])).exitCode, 0);
});

test("Docker recovery unpauses before a cleanup that fails", async () => {
  const { cli, guest, context } = await setup();
  await context.storage.set("docker-snapshot-take:stuck", { id: "stuck", box: "bx123", container: guest.ref, startedAt: 0, estimateMs: 1000, phase: "taking" });
  await cli.ok(["volume", "create", "--label", "bbbox.snapshot.install=other", "bbbox-snapshot-stuck-docker"]);
  await cli.ok(["pause", guest.ref]);
  const restarted = new DockerSnapshotEngine(cli, context, () => 100_000);

  await assert.rejects(restarted.settle({ ref: "take:stuck@0", host: null }), /another box or install/);

  assert.equal((await cli.inspect([guest.ref]))[0]?.status, "running");
});
