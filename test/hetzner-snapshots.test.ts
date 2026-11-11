import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { HETZNER_KEEP_OFF, forkRoomRefusal, type HetznerBackend } from "../src/backends/hetzner/backend.ts";
import { snapshotImage } from "../src/backends/docker/snapshots.ts";
import type { AcquireHooks, Guest, SnapshotStorage, TaskRef } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { keepWhyOf } from "../src/plugin/snapshot-card.ts";
import type { FakeDockerHost } from "./fake-docker.ts";
import { hetznerConfig, hetznerWorld } from "./fake-hetzner-world.ts";
import { MemoryStorage, tempDir } from "./helpers.ts";
import { COMMAND, THREAD, rejection, standing, untilHeld, world, type World } from "./snapshot-world.ts";

const LINUX_IMAGE = "bbbox/linux:1";
const SOURCE_CREDENTIALS = { "home/box/.bb-machines/bb.example/auth.json": '{"token":"source"}\n' } as const;
const RESTORED = /^bbbox-bx[0-9a-z]+-[0-9a-f]{8}$/;
const SMALL_HOST_MiB = 8192;

interface HetznerSnapshotWorld {
  readonly state: World;
  readonly clouds: ReturnType<typeof hetznerWorld>;
}

function hetznerSnapshotWorld(hostFacts: Record<string, unknown> = {}): HetznerSnapshotWorld {
  const clouds = hetznerWorld(hostFacts, (host) => host.withIdentityReset(LINUX_IMAGE, 9));
  const state = world({ forkWaitMs: 300, backend: (storage) => clouds.backend(hetznerConfig(), storage, "test", {}, { id: "fake" }) as never });
  return { state, clouds };
}

function hetznerOf(state: World): HetznerBackend {
  return state.backend as unknown as HetznerBackend;
}

function onlyHost(clouds: ReturnType<typeof hetznerWorld>): FakeDockerHost {
  const hosts = [...clouds.dockerHosts.values()];
  assert.equal(hosts.length, 1, "one Hetzner Cloud host");
  return hosts[0]!;
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

function snapshotImages(fake: FakeDockerHost): string[] {
  return Object.keys(JSON.parse(readFileSync(join(fake.root, "images.json"), "utf8"))).filter((image) => image.startsWith("bbbox-snapshot/"));
}

function snapshotListings(fake: FakeDockerHost): number {
  return fake.calls().filter((args) => args[0] === "image" && args[1] === "ls" && args.some((arg) => arg.startsWith("label=bbbox.snapshot.install="))).length;
}

async function readyHetznerBox(state: World): Promise<BoxRecord> {
  const made = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: BY_COMMAND });
  const box = (await state.boxes.settled(made))!;
  assert.equal(box.state, "ready", box.error ?? "");
  return box;
}

async function boxWithSnapshotOfA(hostFacts: Record<string, unknown> = {}) {
  const { state, clouds } = hetznerSnapshotWorld(hostFacts);
  const box = await readyHetznerBox(state);
  const fake = onlyHost(clouds);
  writeBoth(fake, box, "A");
  const target = (await state.snapshots.take(COMMAND, box, standing(box), { name: "A" })).snapshot!;
  writeBoth(fake, box, "B");
  return { state, clouds, fake, box, target };
}

test("Hetzner Cloud takes a snapshot on the box's host, restores it as a new container there, and its undo goes forward again", async () => {
  const { state, fake, box, target } = await boxWithSnapshotOfA();

  const answer = await state.snapshots.restore(COMMAND, box, standing(box), target.id);

  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready", restored.error ?? "");
  assert.match(restored.guest!.ref, RESTORED);
  assert.equal(restored.guest!.data?.hetznerHost, box.guest!.data?.hetznerHost, "the new container is on the box's own host");
  assert.equal(restored.guest!.host, box.guest!.host);
  assert.deepEqual(readBoth(fake, restored), ["A", "A"]);
  assert.deepEqual(fake.containers(), [restored.guest!.ref], "the old container is gone and the host stays");
  assert.ok(answer.undo);

  await state.snapshots.restore(COMMAND, restored, standing(restored), answer.undo!.id);

  const forward = (await state.boxes.find(box.id))!;
  assert.deepEqual(readBoth(fake, forward), ["B", "B"]);
  assert.match(state.store.record(target.id)!.storage!.name, /^Docker's disk on Hetzner Cloud host /);
});

test("Hetzner Cloud forks a snapshot on the same host, and the fork passes the identity reset check", async () => {
  const { state, fake, box, target } = await boxWithSnapshotOfA();
  mkdirSync(dirname(join(fake.identityRoot(box.guest!.ref), Object.keys(SOURCE_CREDENTIALS)[0]!)), { recursive: true });
  for (const [path, text] of Object.entries(SOURCE_CREDENTIALS)) writeFileSync(join(fake.identityRoot(box.guest!.ref), path), text);

  const answer = await state.snapshots.fork(COMMAND, box, standing(box), target.id, { name: "the-fork" });

  const fork = (await state.boxes.settled(answer.box!))!;
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(fork.guest!.data?.hetznerHost, box.guest!.data?.hetznerHost, "the fork is on its snapshot's host");
  assert.ok(fake.inspect(fork.guest!.ref).Config.Env.includes(`BBBOX_IDENTITY=${fork.id}`));
  assert.match(readFileSync(join(fake.identityRoot(fork.guest!.ref), "var/lib/bb-box/identity-resets"), "utf8"), /not the marker's/, "its boot reset ran");
  assert.equal(existsSync(join(fake.identityRoot(fork.guest!.ref), Object.keys(SOURCE_CREDENTIALS)[0]!)), false, "the source's BB credentials are gone");
  assert.deepEqual(readBoth(fake, fork), ["A", "A"]);
});

test("Hetzner Cloud refuses a fork its snapshot's host has no room for, before anything is made", async () => {
  const { state, clouds, fake, box, target } = await boxWithSnapshotOfA({ memoryMiB: SMALL_HOST_MiB });
  const servers = clouds.api.servers.size;
  const containers = fake.containers();
  const boxes = (await state.boxes.all()).length;

  const refused = await rejection(state.snapshots.checkFork(COMMAND, box, standing(box), target.id));
  const forked = await rejection(state.snapshots.fork(COMMAND, box, standing(box), target.id, { name: "no-room" }));

  for (const error of [refused, forked]) assert.match(error.message, /a fork goes on the same Hetzner Cloud host as its snapshot, .+, and it has no room for one: .+ Release a box there, then try again/);
  assert.equal(clouds.api.servers.size, servers, "no host was made");
  assert.deepEqual(fake.containers(), containers, "no container was made");
  assert.equal((await state.boxes.all()).length, boxes, "no box was made");
});

test("a fork's room on a Hetzner Cloud host counts the Docker disk its snapshots fill", () => {
  const full: SnapshotStorage = { key: "docker:x", name: "", type: "docker-overlay2", percentFull: 90, metadataPercentFull: null, metadataUnread: null, totalBytes: 100e9, usedBytes: 99e9 };

  const refused = forkRoomRefusal("bbbox-test-hz1", null, full, 2e9);
  const fits = forkRoomRefusal("bbbox-test-hz1", null, full, 0.5e9);

  assert.match(refused ?? "", /its Docker disk has 1(\.0)? GB free, less than the fork's 2(\.0)? GB\. Delete snapshots or release a box there, then try again$/);
  assert.equal(fits, null);
});

test("Hetzner Cloud deletes a box's snapshots when the box is released, and the host goes only when idle", async () => {
  const { state, clouds, fake, box } = await boxWithSnapshotOfA();
  await state.snapshots.take(COMMAND, box, standing(box), { name: "second" });
  assert.equal(snapshotImages(fake).length, 2);

  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);

  assert.deepEqual(snapshotImages(fake), [], "the release deleted every snapshot of the box");
  assert.deepEqual(state.store.records({ box: box.id }), []);
  assert.equal(clouds.api.servers.size, 1, "the host stays until its idle time ends");
});

test("Hetzner Cloud keeps no snapshot past its box's release, and says why in Keep and on the Snapshots card", async () => {
  const { state, box, target } = await boxWithSnapshotOfA();
  const offer = hetznerOf(state).snapshotting("linux");

  const refused = await rejection(state.snapshots.checkKeep(COMMAND, standing(box), target.id, { days: 30 }));

  assert.equal(refused.code, "unsupported");
  assert.ok(refused.message.includes(`: ${HETZNER_KEEP_OFF}, so BB Box does not keep "A".`), refused.message);
  assert.equal(keepWhyOf(state.store.record(target.id)!, offer, null), HETZNER_KEEP_OFF);
  assert.deepEqual([offer?.keepsPastRelease, offer?.fork, offer?.forkSafeFrom], ["no", "copy", 7]);
  assert.equal(hetznerOf(state).snapshotting("linux-desktop-cpu")?.forkSafeFrom, 9, "desktops fork from reset version 9");
});

test("Hetzner Cloud asks no host for snapshots while none of its boxes took one", async () => {
  const { state, clouds } = hetznerSnapshotWorld();
  const box = await readyHetznerBox(state);
  const fake = onlyHost(clouds);
  const before = snapshotListings(fake);

  const held = await hetznerOf(state).heldSnapshots();
  const on = await hetznerOf(state).snapshotsOn(box.guest!);
  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);

  assert.deepEqual([held, on], [[], []]);
  assert.equal(snapshotListings(fake), before, "the host was not asked");
});

test("Hetzner Cloud finishes a restore that BB Box stopped after the new container was made, leaving one working box", async () => {
  const { state, fake, box, target } = await boxWithSnapshotOfA();
  state.holds.step = "adopted";

  const held = state.snapshots.restore(COMMAND, box, standing(box), target.id).catch((error: unknown) => error);
  await untilHeld(state, held);
  await state.restart();
  await held;
  assert.equal(await state.snapshots.recover(), 1);

  const after = (await state.boxes.find(box.id))!;
  assert.equal(after.state, "ready", after.error ?? "");
  assert.match(after.guest!.ref, RESTORED);
  assert.deepEqual(fake.containers(), [after.guest!.ref]);
  assert.deepEqual(readBoth(fake, after), ["A", "A"]);
});

test("a Hetzner Cloud backend started again settles a take cut short on its host: it unpauses the box and removes the part-made copy", async () => {
  let clock = Date.UTC(2026, 10, 11, 9);
  const clouds = hetznerWorld({}, (host) => host.withIdentityReset(LINUX_IMAGE, 9));
  const storage = new MemoryStorage();
  const options = { dockerOptions: { readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh", now: () => clock } };
  const before = clouds.backend(hetznerConfig(), storage, "test", options) as HetznerBackend;
  const box = { boxId: "bxcutshortaaaa", threadId: THREAD, name: "cut-short", kind: "linux", size: { cores: 2, memoryMiB: 4096, diskGiB: null }, createdAt: clock };
  const hooks: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
  const guest: Guest = await before.acquire(box as never, null, hooks, AbortSignal.timeout(20_000));
  const fake = onlyHost(clouds);
  const release = join(tempDir("hetzner-take"), "copy-may-finish");
  fake.set({ holdTakeCopy: release });
  let task: TaskRef | null = null;

  const cutShort = before.snapshot(guest, { id: "sncutshortaaaa", box: box.boxId, memory: false, forkSafe: 7 }, { submitting: async () => {}, task: async (given) => void (task = given) }).catch(() => null);
  for (let i = 0; i < 1000 && fake.inspect(guest.ref).State.Status !== "paused"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(fake.inspect(guest.ref).State.Status, "paused");
  clock += 20 * 60_000;
  const after = clouds.backend(hetznerConfig(), storage, "test", options) as HetznerBackend;

  const outcome = await after.providerTask(task!);

  assert.equal(outcome.state, "failed");
  assert.equal(fake.inspect(guest.ref).State.Status, "running", "the box is unpaused");
  assert.deepEqual((await after.heldSnapshots()).map((held) => held.id), []);
  assert.equal(snapshotImages(fake).includes(snapshotImage("test", box.boxId, "sncutshortaaaa")), false);
  writeFileSync(release, "");
  await cutShort;
});

test("Hetzner Cloud's doctor gives Docker's snapshot lines for a host only once one of its boxes took a snapshot, and says Keep is off", async () => {
  const { state, clouds } = hetznerSnapshotWorld();
  const box = await readyHetznerBox(state);
  const lines = async () => (await hetznerOf(state).doctor()).checks.filter((check) => check.id.startsWith("hetzner.snapshots."));
  const before = await lines();

  await state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  const after = await lines();

  assert.deepEqual(before, []);
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, `hetzner.snapshots.${[...clouds.api.servers.values()][0]!.name}`);
  assert.match(after[0]!.detail, /^Snapshots: .+ Snapshot leftovers: .+ Kept snapshots: off, as a box's snapshots stay on its Hetzner Cloud host/);
});
