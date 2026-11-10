import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import type { AcquireHooks, BoxIdentity, CopyHooks, Guest, SnapshotHooks } from "../src/backends/types.ts";
import { FORK_HOLD_MISSING, snapshotImage } from "../src/backends/docker/snapshots.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { fakeDockerHost, dockerConfig, type FakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, tempDir, testContext } from "./helpers.ts";
import { COMMAND, THREAD, rejection, standing, world, type World } from "./snapshot-world.ts";

const SOURCE_CREDENTIALS = {
  "home/box/.bb-machines/bb.example/host-id": "host_source\n",
  "home/box/.bb-machines/bb.example/auth.json": '{"token":"source"}\n',
  "home/box/.config/bb-box/env": "GH_TOKEN=source\n",
  "var/lib/tailscale/tailscaled.state": '{"_current-profile":"cHJvZmlsZQ==","profile-a1b2":"bm9kZQ=="}\n',
} as const;

const HALF_MADE_FORK = "-[0-9a-f]{8}$";
const CARD = "0b1c2d3e-0000-0000-0000-00000000000a";
const DEVICE = `nvidia.com/gpu=GPU-${CARD}`;
const ONE_CARD = { gpus: [DEVICE], cards: [{ index: 0, uuid: CARD, name: "NVIDIA GeForce RTX 5090", totalMiB: 32_607, freeMiB: 30_000, device: DEVICE }] };
const QUIET: SnapshotHooks = { submitting: async () => {}, task: async () => {} };
const ACQUIRING: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
const COPYING: CopyHooks = { claimed: async () => {}, submitting: async () => {}, task: async () => {} };
const IMAGE_OF: Readonly<Record<string, string>> = { linux: "bbbox/linux:1", "linux-desktop-cpu": "bbbox/linux-desktop:1" };

function forkingWorld(fake: FakeDockerHost): World {
  return world({ forkWaitMs: 300, backend: (storage) => new DockerBackend(dockerConfig(), testContext(storage, "test", { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000 }) as never });
}

function forkName(boxId: string): RegExp {
  return new RegExp(`^bbbox-${boxId}-[0-9a-f]{8}$`);
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function present(root: string, files: Readonly<Record<string, string>>): string[] {
  return Object.keys(files).filter((path) => existsSync(join(root, path)));
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

function identityFile(fake: FakeDockerHost, box: BoxRecord, path: string): string {
  return readFileSync(join(fake.identityRoot(box.guest!.ref), path), "utf8");
}

function volumes(fake: FakeDockerHost): string[] {
  return Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")));
}

async function joinedBox(state: World, fake: FakeDockerHost, kind = "linux"): Promise<BoxRecord> {
  const made = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind, who: BY_COMMAND });
  const box = (await state.boxes.settled(made))!;
  assert.equal(box.state, "ready", box.error ?? "");
  writeTree(fake.identityRoot(box.guest!.ref), SOURCE_CREDENTIALS);
  return box;
}

async function sourceWithSnapshotOfA(fake: FakeDockerHost, options: { readonly kind?: string; readonly resetVersion?: number } = {}) {
  const kind = options.kind ?? "linux";
  fake.withIdentityReset(IMAGE_OF[kind]!, options.resetVersion ?? 9);
  const state = forkingWorld(fake);
  const source = await joinedBox(state, fake, kind);
  writeBoth(fake, source, "A");
  const target = (await state.snapshots.take(COMMAND, source, standing(source), { name: "A" })).snapshot!;
  return { state, source, target };
}

async function forkOf(state: World, source: BoxRecord, snapshot: string): Promise<BoxRecord> {
  const answer = await state.snapshots.fork(COMMAND, source, standing(source), snapshot, { name: "the-fork" });
  assert.ok(answer.box, "the fork has a box");
  return (await state.boxes.settled(answer.box))!;
}

function createOf(fake: FakeDockerHost, container: string): string[] {
  const create = fake.calls().find((args) => args[0] === "container" && args[1] === "create" && args[args.indexOf("--name") + 1] === container);
  assert.ok(create, `${container} was made with docker container create`);
  return create;
}

function heldFile(fake: FakeDockerHost, container: string): string {
  return join(fake.root, "containers", container, "run", "bb-box", "held");
}

function readyFile(fake: FakeDockerHost, container: string): string {
  return join(fake.root, "containers", container, "run", "bb-box", "ready");
}

function callIndex(fake: FakeDockerHost, container: string, says: string): number {
  return fake.calls().findIndex((args) => args[0] === "exec" && args.includes(container) && args.some((arg) => arg.includes(says)));
}

async function until<T>(look: () => T | undefined | null | false, what: string): Promise<T> {
  for (let i = 0; i < 1000; i++) {
    const seen = look();
    if (seen) return seen;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`gave up waiting for ${what}`);
}

function restartUpdates(fake: FakeDockerHost, container: string): string[] {
  return fake.calls().filter((args) => args[0] === "container" && args[1] === "update" && args.includes("--restart") && args.at(-1) === container).map((args) => args[args.indexOf("--restart") + 1]!);
}

test("Docker forks a snapshot into a new container with the fork's own ID, name, labels and identity value, whose boot reset runs before BB Box hands it over", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const sourceMachineId = identityFile(fake, source, "etc/machine-id");
  const sourceHostKey = identityFile(fake, source, "etc/ssh/ssh_host_ed25519_key.pub");

  const fork = await forkOf(state, source, target.id);

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.notEqual(fork.id, source.id);
  assert.equal(fork.name, "the-fork");
  const container = fork.guest!.ref;
  assert.match(container, forkName(fork.id));
  const made = fake.inspect(container);
  assert.ok(made.Config.Env.includes(`BBBOX_IDENTITY=${fork.id}`), "the fork's identity value is its own box ID");
  assert.ok(!made.Config.Env.includes(`BBBOX_IDENTITY=${source.id}`));
  assert.equal(made.Config.Labels["bbbox.box"], fork.id);
  assert.equal(made.Config.Labels["bbbox.name"], "the-fork");
  assert.equal(made.Config.Labels["bbbox.from-snapshot"], target.id);
  assert.equal(made.Config.Image, snapshotImage("test", source.id, target.id));
  assert.deepEqual(readBoth(fake, fork), ["A", "A"]);

  assert.match(identityFile(fake, fork, "var/lib/bb-box/identity-resets"), /the value bb-box set on this guest is not the marker's; BB machines removed: host_source/, "its boot reset ran");
  assert.deepEqual(present(fake.identityRoot(container), SOURCE_CREDENTIALS), [], "BB's machine credentials, the access file and the tailnet node from the source are gone");
  assert.notEqual(identityFile(fake, fork, "etc/machine-id"), sourceMachineId);
  assert.notEqual(identityFile(fake, fork, "etc/ssh/ssh_host_ed25519_key.pub"), sourceHostKey);
  assert.match(identityFile(fake, fork, "etc/bb-box/identity"), new RegExp(`^box ${fork.id}$`, "m"), "BB Box wrote the fork's own marker once it was handed over");

  assert.equal(fake.inspect(source.guest!.ref).State.Status, "running", "the source is untouched");
  assert.deepEqual(present(fake.identityRoot(source.guest!.ref), SOURCE_CREDENTIALS), Object.keys(SOURCE_CREDENTIALS));
  assert.match(identityFile(fake, source, "etc/bb-box/identity"), new RegExp(`^box ${source.id}$`, "m"));

  writeBoth(fake, fork, "B");
  assert.deepEqual(readBoth(fake, (await state.boxes.find(source.id))!), ["A", "A"], "a write in the fork leaves the source as it was");
});

test("Docker makes a fork with restart policy no and changes it to unless-stopped only once BB Box's check has passed", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const before = fake.calls().length;

  const fork = await forkOf(state, source, target.id);

  assert.equal(fork.state, "ready", fork.error ?? "");
  const container = fork.guest!.ref;
  const id = fake.inspect(container).Id;
  const create = createOf(fake, container);
  assert.equal(create[create.indexOf("--restart") + 1], "no");
  const steps = fake.calls().slice(before).flatMap((args) => {
    if (args[0] === "container" && args[1] === "create" && args.includes(container)) return ["create"];
    if (args[0] === "container" && args[1] === "start" && args.at(-1) === id) return ["start"];
    if (args[0] === "exec" && args.includes(container) && args.some((arg) => arg.includes("tailnet_node"))) return ["check"];
    if (args[0] === "container" && args[1] === "update" && args.at(-1) === container) return [`restart ${args[args.indexOf("--restart") + 1]}`];
    return [];
  });
  assert.deepEqual(steps.filter((step, at) => step !== steps[at - 1]), ["create", "start", "check", "restart unless-stopped"]);
  assert.equal(fake.inspect(container).HostConfig.RestartPolicy.Name, "unless-stopped");
});

test("Docker forks a desktop from a snapshot taken with identity reset version 9", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake, { kind: "linux-desktop-cpu", resetVersion: 9 });

  const fork = await forkOf(state, source, target.id);

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(fork.kind, "linux-desktop-cpu");
  assert.ok(fake.inspect(fork.guest!.ref).Config.Env.includes(`BBBOX_IDENTITY=${fork.id}`));
});

for (const each of [
  { kind: "linux", version: 6, needs: 7 },
  { kind: "linux-desktop-cpu", version: 8, needs: 9 },
]) {
  test(`Docker refuses to fork a ${each.kind} snapshot taken under identity reset version ${each.version}, saying why, before anything is copied`, async () => {
    const fake = fakeDockerHost();
    const { state, source, target } = await sourceWithSnapshotOfA(fake, { kind: each.kind, resetVersion: each.version });
    const containers = fake.containers();
    const volumesBefore = volumes(fake);

    const refused = await rejection(state.snapshots.fork(COMMAND, source, standing(source), target.id));

    assert.equal(refused.code, "unsupported");
    assert.match(refused.message, new RegExp(`version ${each.version} of the identity reset when "A" was taken, and BB Box forks .*'s boxes only from version ${each.needs}`));
    assert.deepEqual(fake.containers(), containers, "no container was made");
    assert.deepEqual(volumes(fake), volumesBefore, "no Docker data was copied");
  });
}

test("Docker releases a fork whose boot reset did not run, says why, and never lets it start as its source", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  fake.set({ skipIdentityBootMatching: HALF_MADE_FORK });
  const containers = fake.containers();
  const volumesBefore = volumes(fake);

  const fork = await forkOf(state, source, target.id);

  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", /BB Box did not hand fork the-fork over/);
  assert.match(fork.error ?? "", /BB Box released it, so nothing of it acts as /);
  assert.equal(fork.guest, null);
  assert.deepEqual(fake.containers(), containers, "the fork's container is gone");
  assert.deepEqual(volumes(fake), volumesBefore, "and its Docker data");
  const made = fake.calls().find((args) => args[0] === "container" && args[1] === "create" && args.includes("--name") && forkName(fork.id).test(args[args.indexOf("--name") + 1]!))!;
  const name = made[made.indexOf("--name") + 1]!;
  assert.equal(made[made.indexOf("--restart") + 1], "no");
  assert.ok(!restartUpdates(fake, name).includes("unless-stopped"), "its restart policy never let Docker start it again");
  assert.ok(createOf(fake, name).includes("BBBOX_FORK_HOLD=1"), "it was made held");
  assert.deepEqual(fake.servicesStarted(name), [], "nothing copied from the source ran in it: no inner Docker, SSH, BB daemon, Tailscale or desktop");
  assert.equal(callIndex(fake, name, "fork-released"), -1, "BB Box never released it");
  assert.equal(fake.inspect(source.guest!.ref).State.Status, "running");
  assert.deepEqual(present(fake.identityRoot(source.guest!.ref), SOURCE_CREDENTIALS), Object.keys(SOURCE_CREDENTIALS));
});

test("Docker takes a fork's creation reservation under its new container's name, so a sweep while its Docker data is copied keeps the volume", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const release = join(tempDir("docker-fork"), "copy-may-finish");
  fake.set({ holdRestoreCopy: release });
  const before = new Set(volumes(fake));

  const answer = await state.snapshots.fork(COMMAND, source, standing(source), target.id, { name: "the-fork" });
  let volume: string | undefined;
  for (let i = 0; i < 1000 && !volume; i++) {
    volume = volumes(fake).find((name) => !before.has(name) && forkName(answer.box!.id).test(name.replace(/-docker$/, "")));
    if (!volume) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(volume, "the fork made its container's Docker volume before its container");
  await state.backend.maintain!();
  assert.ok(volumes(fake).includes(volume), "the sweep left the volume of the fork being made");
  writeFileSync(release, "");

  const fork = (await state.boxes.settled(answer.box!))!;
  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(dockerVolumeOf(fake, fork.guest!.ref), volume);
  assert.deepEqual(readBoth(fake, fork), ["A", "A"]);
});

test("Docker removes a fork BB Box stopped after its copy, before its check passed, makes it again, and leaves the source untouched", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const release = join(tempDir("docker-fork"), "start-may-finish");
  fake.set({ holdStartMatching: HALF_MADE_FORK, holdStartUntil: release });

  const answer = await state.snapshots.fork(COMMAND, source, standing(source), target.id, { name: "the-fork" });
  const starting = (name: string) => fake.calls().some((args) => args[0] === "container" && args[1] === "start" && args.at(-1) === fake.inspect(name).Id);
  let halfMade: string | undefined;
  for (let i = 0; i < 1000 && !halfMade; i++) {
    halfMade = fake.containers().find((name) => forkName(answer.box!.id).test(name) && starting(name));
    if (!halfMade) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(halfMade, "the fork's copy was made and is starting");
  const halfMadeVolume = dockerVolumeOf(fake, halfMade);
  await state.restart();
  writeFileSync(release, "");
  assert.equal((await state.boxes.find(answer.box!.id))?.guest?.ref, halfMade, "the fork's record names its half-made container");

  await state.boxes.sweep();
  const fork = (await state.boxes.settled((await state.boxes.find(answer.box!.id))!))!;

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.notEqual(fork.guest!.ref, halfMade);
  assert.ok(!fake.containers().includes(halfMade), "the half-made fork is gone");
  assert.ok(!volumes(fake).includes(halfMadeVolume), "and its Docker data");
  assert.deepEqual(fake.containers(), [source.guest!.ref, fork.guest!.ref].sort());
  assert.deepEqual(readBoth(fake, fork), ["A", "A"]);
  assert.equal(fake.inspect(source.guest!.ref).State.Status, "running");
  assert.deepEqual(present(fake.identityRoot(source.guest!.ref), SOURCE_CREDENTIALS), Object.keys(SOURCE_CREDENTIALS));
  assert.deepEqual(readBoth(fake, (await state.boxes.find(source.id))!), ["A", "A"]);
});

function boxOf(boxId: string, gpu: "none" | "shared"): BoxIdentity {
  return { boxId, threadId: THREAD, name: `box-${boxId}`, kind: "linux", createdAt: 1_790_000_000_000, size: { cores: 2, memoryMiB: 4096, diskGiB: null, gpu } };
}

function gpuBackend(): { readonly fake: FakeDockerHost; readonly backend: DockerBackend } {
  const fake = fakeDockerHost(ONE_CARD);
  const backend = new DockerBackend(dockerConfig({ "gpu-desktops": true }), testContext(new MemoryStorage(), "test"), { binary: fake.binary, readyTimeoutMs: 2_000 });
  return { fake, backend };
}

test("Docker places a fork as a new box, so a fork without a GPU of a box with one gets no card", async () => {
  const { fake, backend } = gpuBackend();
  const source = await backend.acquire(boxOf("bxsource00001", "shared"), null, ACQUIRING, AbortSignal.timeout(30_000));
  assert.deepEqual(fake.inspect(source.ref).HostConfig.Devices, [DEVICE], "the source has the card");
  const taken = await backend.snapshot(source, { id: "sngpu", box: "bxsource00001", memory: false, forkSafe: 9 }, QUIET);

  const fork = await backend.forkSnapshot({ id: "sngpu", ref: taken.ref, guest: source }, boxOf("bxfork0000001", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));

  const made = fake.inspect(fork.ref);
  assert.deepEqual(made.HostConfig.Devices, []);
  assert.deepEqual(made.Config.Env.filter((entry) => /^(CUDA_VISIBLE_DEVICES|NVIDIA_VISIBLE_DEVICES|BBBOX_GPU_CARD|NVIDIA_DRIVER_CAPABILITIES)=./.test(entry)), []);
  assert.equal(made.Config.Labels["bbbox.gpu"] ?? "", "");
  assert.equal(fork.data?.card, undefined);
});

test("Docker disarms a fork before it goes: no restart policy, and stopped", async () => {
  const { fake, backend } = gpuBackend();
  const source = await backend.acquire(boxOf("bxsource00002", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  const taken = await backend.snapshot(source, { id: "snarm", box: "bxsource00002", memory: false, forkSafe: 9 }, QUIET);
  const fork = await backend.forkSnapshot({ id: "snarm", ref: taken.ref, guest: source }, boxOf("bxfork0000002", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  await backend.startForForkCheck!(fork, AbortSignal.timeout(30_000));
  await backend.armFork!(fork, "boot");
  assert.equal(fake.inspect(fork.ref).HostConfig.RestartPolicy.Name, "unless-stopped");

  await backend.disarmFork!(fork);

  assert.equal(fake.inspect(fork.ref).HostConfig.RestartPolicy.Name, "no");
  assert.equal(fake.inspect(fork.ref).State.Status, "exited");
  assert.equal(fake.inspect(source.ref).State.Status, "running");
  assert.deepEqual(await backend.guestIdentity!(fork), { macs: {}, smbios: null, value: "bxfork0000002" });
});

test("Docker holds every service of a fork until BB Box's check has passed, then releases it as the fork's own box", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);

  const fork = await forkOf(state, source, target.id);

  assert.equal(fork.state, "ready", fork.error ?? "");
  const container = fork.guest!.ref;
  assert.ok(createOf(fake, container).includes("BBBOX_FORK_HOLD=1"));
  const checked = callIndex(fake, container, "tailnet_node");
  const released = callIndex(fake, container, "fork-released");
  assert.ok(checked >= 0 && released > checked, "BB Box released the fork only after its check");
  const [servicesAfterCalls, ...again] = fake.servicesStarted(container);
  assert.deepEqual(again, [], "its services started once");
  assert.ok(servicesAfterCalls !== undefined && servicesAfterCalls > released, "its services started only after the release");
  assert.equal(readFileSync(join(fake.root, "containers", container, "var-lib", "bb-box", "fork-released"), "utf8"), fork.id);
  assert.equal(existsSync(heldFile(fake, container)), false);
});

test("Docker leaves a fork held when BB Box stops before its check, and removes it without ever releasing it", async () => {
  const fake = fakeDockerHost();
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const release = join(tempDir("docker-fork"), "check-may-run");
  fake.set({ holdExecMatching: `${HALF_MADE_FORK.slice(0, -1)} .*tailnet_node`, holdExecUntil: release });

  const answer = await state.snapshots.fork(COMMAND, source, standing(source), target.id, { name: "the-fork" });
  const halfMade = await until(() => fake.containers().find((name) => forkName(answer.box!.id).test(name) && existsSync(heldFile(fake, name))), "the fork to be held");
  await until(() => callIndex(fake, halfMade, "tailnet_node") >= 0, "BB Box's check to start");
  await state.restart();
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(fake.inspect(halfMade).State.Status, "running");
  assert.equal(existsSync(heldFile(fake, halfMade)), true, "it is still held");
  assert.equal(existsSync(readyFile(fake, halfMade)), false);
  assert.deepEqual(fake.servicesStarted(halfMade), []);

  writeFileSync(release, "");
  await state.boxes.sweep();
  const fork = (await state.boxes.settled((await state.boxes.find(answer.box!.id))!))!;

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.ok(!fake.containers().includes(halfMade), "the held fork is gone");
  assert.deepEqual(fake.servicesStarted(halfMade), [], "it was never released, so nothing copied ran in it");
  assert.equal(callIndex(fake, halfMade, "fork-released"), -1);
  assert.equal(fake.inspect(source.guest!.ref).State.Status, "running");
});

test("Docker refuses to fork a snapshot of a box made from an image that cannot hold a fork, saying why, before anything is copied", async () => {
  const fake = fakeDockerHost();
  fake.withoutForkHold("bbbox/linux:1");
  const { state, source, target } = await sourceWithSnapshotOfA(fake);
  const containers = fake.containers();
  const volumesBefore = volumes(fake);

  const refused = await rejection(state.snapshots.fork(COMMAND, source, standing(source), target.id));

  assert.equal(refused.code, "unsupported");
  assert.ok(refused.message.includes(FORK_HOLD_MISSING), refused.message);
  assert.deepEqual(fake.containers(), containers);
  assert.deepEqual(volumes(fake), volumesBefore);
});

test("Docker refuses such a fork itself too, before it removes, places or copies anything", async () => {
  const { fake, backend } = gpuBackend();
  fake.withoutForkHold("bbbox/linux:1");
  const source = await backend.acquire(boxOf("bxsource00003", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  const taken = await backend.snapshot(source, { id: "snold", box: "bxsource00003", memory: false, forkSafe: 9 }, QUIET);
  const containers = fake.containers();

  await assert.rejects(backend.forkSnapshot({ id: "snold", ref: taken.ref, guest: source }, boxOf("bxfork0000003", "none"), null, ACQUIRING, AbortSignal.timeout(30_000)), { message: FORK_HOLD_MISSING });

  assert.deepEqual(fake.containers(), containers);
});

async function releasedFork(backend: DockerBackend, from: Guest, snapshot: string, boxId: string): Promise<Guest> {
  const taken = await backend.snapshot(from, { id: snapshot, box: from.data!.box as string, memory: false, forkSafe: 9 }, QUIET);
  const fork = await backend.forkSnapshot({ id: snapshot, ref: taken.ref, guest: from }, boxOf(boxId, "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  await backend.startForForkCheck!(fork, AbortSignal.timeout(30_000));
  await backend.armFork!(fork, "boot");
  return fork;
}

test("Docker starts a new box, an ordinary start and a restore at once, with no hold", async () => {
  const { fake, backend } = gpuBackend();
  const box = boxOf("bxsource00004", "none");

  const made = await backend.acquire(box, null, ACQUIRING, AbortSignal.timeout(30_000));
  assert.equal(fake.servicesStarted(made.ref).length, 1, "a new box's services start with it");
  await backend.stop!(made);
  await backend.start!(made);
  assert.equal(fake.servicesStarted(made.ref).length, 2, "and at an ordinary start");
  const taken = await backend.snapshot(made, { id: "snback", box: box.boxId, memory: false, forkSafe: 9 }, QUIET);
  await backend.powerOff!(made);
  const restored = await backend.adoptSnapshot!({ id: "snback", ref: taken.ref, guest: made }, box, { macs: {}, smbios: null, value: box.boxId }, COPYING);
  await backend.start!(restored);

  assert.equal(fake.servicesStarted(restored.ref).length, 1, "a restore's services start with it");
  for (const each of [made.ref, restored.ref]) {
    assert.ok(!createOf(fake, each).includes("BBBOX_FORK_HOLD=1"), `${each} was made with no hold`);
    assert.equal(createOf(fake, each)[createOf(fake, each).indexOf("--restart") + 1], "unless-stopped");
  }
});

test("Docker holds a fork of a fork, though its copy carries the first fork's release, and restores a fork's snapshot with no hold", async () => {
  const { fake, backend } = gpuBackend();
  const source = await backend.acquire(boxOf("bxsource00005", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  const first = await releasedFork(backend, source, "snfirst", "bxfork0000005");
  const taken = await backend.snapshot(first, { id: "snsecond", box: "bxfork0000005", memory: false, forkSafe: 9 }, QUIET);

  const second = await backend.forkSnapshot({ id: "snsecond", ref: taken.ref, guest: first }, boxOf("bxfork0000006", "none"), null, ACQUIRING, AbortSignal.timeout(30_000));
  await backend.startForForkCheck!(second, AbortSignal.timeout(30_000));
  await new Promise((resolve) => setTimeout(resolve, 500));

  assert.equal(readFileSync(join(fake.root, "containers", second.ref, "var-lib", "bb-box", "fork-released"), "utf8"), "bxfork0000005", "the copy carries the first fork's release");
  assert.equal(existsSync(heldFile(fake, second.ref)), true, "the second fork is held all the same");
  assert.deepEqual(fake.servicesStarted(second.ref), []);

  await backend.powerOff!(first);
  const restored = await backend.adoptSnapshot!({ id: "snsecond", ref: taken.ref, guest: first }, boxOf("bxfork0000005", "none"), { macs: {}, smbios: null, value: "bxfork0000005" }, COPYING);
  await backend.start!(restored);
  assert.equal(fake.servicesStarted(restored.ref).length, 1, "a restore of the first fork's snapshot starts at once");
  assert.ok(fake.inspect(restored.ref).Config.Env.includes("BBBOX_FORK_HOLD="), "the snapshot holds no fork's hold");
});
