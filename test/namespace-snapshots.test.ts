import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { NamespaceBackend } from "../src/backends/namespace/backend.ts";
import { NAMESPACE_FORK_OFF, NAMESPACE_KEEP_OFF, deadlineRefusal } from "../src/backends/namespace/linux.ts";
import type { BackendStorage } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { keepWhyOf } from "../src/plugin/snapshot-card.ts";
import { fakeDockerHost, type FakeDockerHost } from "./fake-docker.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace } from "./fake-namespace.ts";
import { FAKE_SSH_BINARY, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";
import { COMMAND, HOUR, THREAD, rejection, standing, untilHeld, world, type World } from "./snapshot-world.ts";

fakeSsh();
const disposed = disposedOnceTheFileEnds();

const RESTORED = /^bbbox-bx[0-9a-z]+-[0-9a-f]{8}$/;
const LONGEST_LIFE_HOURS = 4;

interface NamespaceSnapshotWorld {
  readonly state: World;
  readonly api: FakeNamespace;
  readonly machines: Map<string, FakeDockerHost>;
  readonly ahead: (ms: number) => void;
  readonly now: () => number;
}

function namespaceSnapshotWorld(): NamespaceSnapshotWorld {
  const machines = new Map<string, FakeDockerHost>();
  const clis = new Map<string, DockerCli>();
  const dockerOn = (instance: string): DockerCli => {
    let cli = clis.get(instance);
    if (!cli) {
      const host = fakeDockerHost({ name: instance, cpus: 4, memoryMiB: 16 * 1024 });
      machines.set(instance, host);
      cli = new DockerCli(`unix:///run/bb-box/namespace/${instance}.sock`, host.binary, async () => {});
      clis.set(instance, cli);
    }
    return cli;
  };
  let offset = 0;
  const now = () => Date.now() + offset;
  const api = new FakeNamespace({ maxCores: 64, now });
  const backend = (storage: BackendStorage) =>
    disposed(new NamespaceBackend({ token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 4, longestLifeHours: LONGEST_LIFE_HOURS, largestMachine: null }, testContext(storage, "test", { id: "fake" }), {
      fetch: api.fetch,
      sshBinary: FAKE_SSH_BINARY,
      sleep: async () => {},
      now,
      readyTimeoutMs: 20_000,
      setupArchive: async () => Buffer.from("setup"),
      linuxImageScript: (target, key) => `cat >/dev/null; echo nscr.io/ws/bbbox/${target}:${key}`,
      linuxPullScript: () => ":",
      dockerCli: dockerOn,
      dockerOptions: { readyTimeoutMs: 20_000, selkiesLauncher: "/bin/sh", now },
    }));
  const state = world({ markersOn: false, backend: (storage) => backend(storage) as never });
  return { state, api, machines, now, ahead: (ms) => void (offset += ms) };
}

function namespaceOf(state: World): NamespaceBackend {
  return state.backend as unknown as NamespaceBackend;
}

function machineOf(world: NamespaceSnapshotWorld, box: BoxRecord): FakeDockerHost {
  const machine = world.machines.get(String(box.guest!.data?.instance));
  assert.ok(machine, "the box has a Namespace machine");
  return machine;
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

function machineStatus(world: NamespaceSnapshotWorld, box: BoxRecord): string | undefined {
  return world.api.instances.get(String(box.guest!.data?.instance))?.status;
}

async function readyNamespaceBox(state: World): Promise<BoxRecord> {
  const made = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: BY_COMMAND });
  const box = (await state.boxes.settled(made))!;
  assert.equal(box.state, "ready", box.error ?? "");
  return box;
}

async function boxWithSnapshotOfA() {
  const made = namespaceSnapshotWorld();
  const box = await readyNamespaceBox(made.state);
  const fake = machineOf(made, box);
  writeBoth(fake, box, "A");
  const target = (await made.state.snapshots.take(COMMAND, box, standing(box), { name: "A" })).snapshot!;
  writeBoth(fake, box, "B");
  return { ...made, fake, box, target };
}

test("Namespace takes a snapshot on the box's machine, restores it as a new container there, and its undo goes forward again, keeping the machine", async () => {
  const made = await boxWithSnapshotOfA();
  const { state, fake, box, target } = made;

  const answer = await state.snapshots.restore(COMMAND, box, standing(box), target.id);

  const restored = (await state.boxes.find(box.id))!;
  assert.equal(restored.state, "ready", restored.error ?? "");
  assert.match(restored.guest!.ref, RESTORED);
  assert.equal(restored.guest!.data?.instance, box.guest!.data?.instance, "the new container is on the box's own machine");
  assert.deepEqual(readBoth(fake, restored), ["A", "A"]);
  assert.deepEqual(fake.containers(), [restored.guest!.ref], "the old container is gone");
  assert.equal(machineStatus(made, box), "RUNNING", "removing the old container left the machine");
  assert.ok(answer.undo);

  await state.snapshots.restore(COMMAND, restored, standing(restored), answer.undo!.id);

  const forward = (await state.boxes.find(box.id))!;
  assert.deepEqual(readBoth(fake, forward), ["B", "B"]);
  assert.equal(machineStatus(made, box), "RUNNING");
  assert.match(state.store.record(target.id)!.storage!.name, /^Docker's disk on the box's Namespace machine/);
});

test("Namespace lists a restored box under its new container, and still keeps its machine alive", async () => {
  const made = await boxWithSnapshotOfA();
  const { state, box, target } = made;
  await state.snapshots.restore(COMMAND, box, standing(box), target.id);
  const restored = (await state.boxes.find(box.id))!;
  const extendsBefore = made.api.calls.filter((call) => call.method === "ExtendInstance").length;
  made.ahead(HOUR / 2);

  const held = await namespaceOf(state).held();
  await namespaceOf(state).maintain(undefined, new Set([restored.guest!.ref]));

  assert.deepEqual(held.filter((guest) => guest.owner?.boxId === box.id).map((guest) => guest.ref), [restored.guest!.ref]);
  assert.equal(made.api.calls.filter((call) => call.method === "ExtendInstance").length, extendsBefore + 1, "its deadline was moved on");
  await state.boxes.sweep();
  assert.equal((await state.boxes.find(box.id))!.state, "ready", "the sweep found the box's guest");
  assert.equal(machineStatus(made, box), "RUNNING");
});

test("Namespace refuses a fork and Keep, and says why", async () => {
  const { state, box, target } = await boxWithSnapshotOfA();
  const offer = namespaceOf(state).snapshotting("linux");

  const fork = await rejection(state.snapshots.checkFork(COMMAND, box, standing(box), target.id));
  const forkNow = await rejection(state.snapshots.fork(COMMAND, box, standing(box), target.id, { name: "a-fork" }));
  const keep = await rejection(state.snapshots.checkKeep(COMMAND, standing(box), target.id, { days: 30 }));

  assert.ok(fork.message.endsWith(`: ${NAMESPACE_FORK_OFF}.`), fork.message);
  assert.equal(forkNow.message, fork.message);
  assert.ok(keep.message.includes(`: ${NAMESPACE_KEEP_OFF}, so BB Box does not keep "A".`), keep.message);
  assert.equal(keepWhyOf(state.store.record(target.id)!, offer, null), NAMESPACE_KEEP_OFF);
  assert.deepEqual([offer?.fork, offer?.keepsPastRelease, offer?.lives], ["none", "no", "host"]);
  assert.equal(namespaceOf(state).snapshotting("macos"), null, "Namespace's Macs take no snapshots");
});

test("Namespace refuses a take or a restore that its box's machine would end before, and says when it ends", async () => {
  const made = await boxWithSnapshotOfA();
  const { state, box, target } = made;
  const endsAt = box.guest!.endsAt!;
  made.api.instances.get(String(box.guest!.data?.instance))!.deadline = endsAt;
  made.ahead(endsAt - made.now() - 60_000);

  const take = await rejection(state.snapshots.checkTake(COMMAND, box, standing(box)));
  const restore = await rejection(state.snapshots.checkRestore(COMMAND, box, standing(box), target.id));

  const ends = new Date(endsAt).toISOString().slice(11, 16);
  assert.match(take.message, new RegExp(`The box's Namespace machine ends at ${ends} UTC, the plan's longest life, before this snapshot would be ready, and its snapshots end with it`));
  assert.match(restore.message, new RegExp(`ends at ${ends} UTC, the plan's longest life, before this restore would finish`));
});

test("Namespace's machine deadline refuses only what would end after it", () => {
  const endsAt = Date.UTC(2026, 10, 11, 14, 5);

  assert.equal(deadlineRefusal(endsAt, endsAt - HOUR, 60_000, "snapshot"), null);
  assert.match(deadlineRefusal(endsAt, endsAt - 3 * 60_000, 60_000, "snapshot") ?? "", /ends at 14:05 UTC/);
  assert.equal(deadlineRefusal(null, endsAt, 60_000, "restore"), null);
});

test("Namespace destroys the machine of a released box that took snapshots, and its snapshots with it", async () => {
  const made = await boxWithSnapshotOfA();
  const { state, box } = made;

  await state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);

  assert.equal(machineStatus(made, box), "DESTROYED");
  assert.deepEqual(state.store.records({ box: box.id }), []);
  assert.deepEqual(await namespaceOf(state).heldSnapshots(), []);
});

test("Namespace asks no machine for its containers or snapshots while its box took none", async () => {
  const made = namespaceSnapshotWorld();
  const box = await readyNamespaceBox(made.state);
  const fake = machineOf(made, box);
  const before = fake.calls().length;
  const listsBefore = made.api.calls.filter((call) => call.method === "ListInstances").length;

  const snapshotsFirst = await namespaceOf(made.state).heldSnapshots();
  const listsAfter = made.api.calls.filter((call) => call.method === "ListInstances").length;
  const held = await namespaceOf(made.state).held();
  const snapshots = await namespaceOf(made.state).heldSnapshots();
  await namespaceOf(made.state).maintain(undefined, new Set([box.guest!.ref]));
  await made.state.boxes.release(THREAD, box.id, "done with it", BY_COMMAND);

  assert.deepEqual(held.map((guest) => guest.ref), [box.guest!.ref]);
  assert.deepEqual([snapshotsFirst, snapshots], [[], []]);
  assert.equal(listsAfter, listsBefore, "listing snapshots asked Namespace for no machines");
  assert.equal(fake.calls().length, before, "the machine's Docker was not asked");
  assert.equal(machineStatus(made, box), "DESTROYED");
});

test("Namespace finishes a restore that BB Box stopped after the new container was made, leaving one working box", async () => {
  const made = await boxWithSnapshotOfA();
  const { state, fake, box, target } = made;
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
  assert.equal(machineStatus(made, box), "RUNNING");
});

test("Namespace's doctor gives Docker's snapshot lines for a machine only once its box took a snapshot, and says when the machine ends", async () => {
  const made = namespaceSnapshotWorld();
  const box = await readyNamespaceBox(made.state);
  const lines = async () => (await namespaceOf(made.state).doctor()).checks.filter((check) => check.id.startsWith("namespace.snapshots."));
  const before = await lines();

  await made.state.snapshots.take(COMMAND, box, standing(box), { name: "one" });
  const after = await lines();

  assert.deepEqual(before, []);
  assert.deepEqual(after.map((check) => check.id), [`namespace.snapshots.${box.guest!.data?.instance}`]);
  assert.match(after[0]!.detail, /^Snapshots: .+ They end with the machine at \d\d:\d\d UTC, the plan's longest life, or at the box's release\.$/);
});
