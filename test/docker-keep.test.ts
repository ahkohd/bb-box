import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { DockerBackend } from "../src/backends/docker/backend.ts";
import { keptTag, retainedOnEngine, snapshotImage, snapshotVolume } from "../src/backends/docker/snapshots.ts";
import { DockerCli } from "../src/backends/docker/cli.ts";
import { HETZNER_KEEP_OFF, hostPartOptions } from "../src/backends/hetzner/backend.ts";
import { instancePartOptions, NAMESPACE_KEEP_OFF } from "../src/backends/namespace/linux.ts";
import { SnapshotFailed, type Guest } from "../src/backends/types.ts";
import { BY_COMMAND } from "../src/core/box-log.ts";
import type { BoxRecord } from "../src/core/boxes.ts";
import { endOfUtcDay, gbWords, keptUntilAfter, utcDay } from "../src/core/snapshot.ts";
import { keepWhyOf } from "../src/plugin/snapshot-card.ts";
import { deletedText, keepCostWords } from "../src/plugin/snapshot-words.ts";
import { dockerConfig, fakeDockerHost, type FakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, testContext } from "./helpers.ts";
import { COMMAND, THREAD, rejection, standing, world, type World } from "./snapshot-world.ts";

const START = Date.UTC(2026, 9, 30, 10, 42);
const DAY = 86_400_000;
const INSTALL = "test";
const SOURCE_CREDENTIALS = {
  "home/box/.bb-machines/bb.example/host-id": "host_source\n",
  "var/lib/tailscale/tailscaled.state": '{"_current-profile":"cHJvZmlsZQ=="}\n',
} as const;

function dockerWorld(fake: FakeDockerHost, keepOffBecause?: string): World {
  return world({ forkWaitMs: 300, backend: (storage) => new DockerBackend(dockerConfig(), testContext(storage, INSTALL, { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000, ...(keepOffBecause ? { keepOffBecause } : {}) }) as never });
}

function dockerOf(state: World): DockerBackend {
  return state.backend as unknown as DockerBackend;
}

function images(fake: FakeDockerHost): string[] {
  return Object.keys(JSON.parse(readFileSync(join(fake.root, "images.json"), "utf8")));
}

function volumes(fake: FakeDockerHost): string[] {
  return Object.keys(JSON.parse(readFileSync(join(fake.root, "volumes.json"), "utf8")));
}

function keepTags(fake: FakeDockerHost): string[] {
  return images(fake).filter((name) => name.startsWith("bbbox-kept/"));
}

function writeTree(root: string, files: Readonly<Record<string, string>>): void {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

async function readyDockerBox(state: World, fake: FakeDockerHost): Promise<BoxRecord> {
  fake.withIdentityReset("bbbox/linux:1", 9);
  const made = await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: BY_COMMAND });
  const box = (await state.boxes.settled(made))!;
  assert.equal(box.state, "ready", box.error ?? "");
  writeTree(fake.identityRoot(box.guest!.ref), SOURCE_CREDENTIALS);
  mkdirSync(fake.home(box.guest!.ref), { recursive: true });
  writeFileSync(join(fake.home(box.guest!.ref), "work.txt"), "before the take");
  return box;
}

async function keptAndPlain(state: World, fake: FakeDockerHost) {
  const box = await readyDockerBox(state, fake);
  const kept = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  const plain = (await state.snapshots.take(COMMAND, box, standing(box), { name: "plain" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), kept.id, { days: 30 });
  return { box, kept, plain };
}

test("Docker writes a snapshot's keep date as a tag on its engine, moves it when the date changes and removes it when you stop keeping it", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;

  const check = await state.snapshots.checkKeep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });

  assert.equal(check.way, "as-is");
  assert.match(keepCostWords(check), /^If \S+ is released, it stays where it is until Sun 29 Nov; nothing is copied then\. It takes about \S+ (MB|GB) of \S+ Docker's disk that no other image or container there uses, and up to \S+ (MB|GB) if what it shares is deleted\.$/);
  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, "2026-11-29")]);
  assert.equal(state.store.record(taken.id)?.keptUntil, keptUntilAfter(START, 30));

  await state.snapshots.keep(COMMAND, standing(box), taken.id, { until: "2026-12-10" });
  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, "2026-12-10")], "one keep tag at a time");

  await state.snapshots.unkeep(COMMAND, standing(box), taken.id);
  assert.deepEqual(keepTags(fake), []);
  assert.equal(state.store.record(taken.id)?.keptUntil, null);
  assert.ok(images(fake).includes(snapshotImage(INSTALL, box.id, taken.id)), "stopping keeping leaves the snapshot");
});

test("Docker keeps nothing when the engine refuses the keep tag", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  fake.set({ failImageTag: true });

  await rejection(state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 }));

  assert.equal(state.store.record(taken.id)?.keptUntil, null);
  assert.deepEqual(keepTags(fake), []);
});

const KEEP_TAG_REMOVALS = "^bbbox-kept/";

async function interruptedKeepChange(state: World, fake: FakeDockerHost, from: string, to: string) {
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { until: from });
  fake.set({ failImageRmMatching: KEEP_TAG_REMOVALS });

  await rejection(state.snapshots.keep(COMMAND, standing(box), taken.id, { until: to }));

  assert.deepEqual(keepTags(fake).sort(), [keptTag(INSTALL, taken.id, from), keptTag(INSTALL, taken.id, to)].sort(), "the new tag was written before the old one could go");
  fake.set({ failImageRmMatching: null });
  return { box, taken };
}

const RECOVERY_ORDERS = [
  { name: "the snapshot sweep, then Docker's maintenance", recover: async (state: World) => { await state.snapshots.sweep(); await dockerOf(state).maintain(); } },
  { name: "Docker's maintenance, then the snapshot sweep", recover: async (state: World) => { await dockerOf(state).maintain(); await state.snapshots.sweep(); } },
] as const;

for (const { name, recover } of RECOVERY_ORDERS) {
  for (const [change, from, to] of [["renewal", "2026-11-29", "2026-12-10"], ["shortening", "2026-12-10", "2026-11-20"]] as const) {
    test(`after a keep ${change} interrupted between its new tag and the old one's removal, ${name} leave one keep tag, the date asked for, on the engine and in the record`, async () => {
      const fake = fakeDockerHost();
      const state = dockerWorld(fake);
      const { taken } = await interruptedKeepChange(state, fake, from, to);

      await recover(state);

      assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, to)]);
      assert.equal(state.store.record(taken.id)?.keptUntil, endOfUtcDay(to));
      const listed = await dockerOf(state).heldSnapshots();
      assert.equal(listed.find((held) => held.id === taken.id)?.keptUntil, endOfUtcDay(to));
    });
  }
}

test("after an interrupted keep shortening with no record of it left, neither snapshots.db nor Docker's own, Docker keeps one keep tag, the later date", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { taken } = await interruptedKeepChange(state, fake, "2026-12-10", "2026-11-20");
  state.forgetRecords();
  const fresh = new DockerBackend(dockerConfig(), testContext(new MemoryStorage(), INSTALL, { id: "fake" }), { binary: fake.binary, readyTimeoutMs: 2_000 });

  await fresh.maintain();

  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, "2026-12-10")]);
  const listed = await fresh.heldSnapshots();
  assert.equal(listed.find((held) => held.id === taken.id)?.keptUntil, endOfUtcDay("2026-12-10"));
  await fresh.dispose?.();
});

test("an interrupted keep change whose new tag was never written changes nothing, and Docker's maintenance drops it", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { until: "2026-12-10" });
  fake.set({ failImageTag: true });
  await rejection(state.snapshots.keep(COMMAND, standing(box), taken.id, { until: "2026-11-20" }));
  fake.set({ failImageTag: false });

  await dockerOf(state).maintain();
  await state.snapshots.sweep();

  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, "2026-12-10")]);
  assert.equal(state.store.record(taken.id)?.keptUntil, endOfUtcDay("2026-12-10"));
});

test("Docker keeps a kept snapshot on its engine past its box's release, with its Docker data and keep tag, and deletes the unkept ones with the box", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept, plain } = await keptAndPlain(state, fake);

  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  assert.deepEqual(fake.containers(), [], "the box's container went");
  assert.ok(images(fake).includes(snapshotImage(INSTALL, box.id, kept.id)));
  assert.ok(volumes(fake).includes(snapshotVolume(kept.id)));
  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, kept.id, "2026-11-29")]);
  assert.ok(!images(fake).includes(snapshotImage(INSTALL, box.id, plain.id)), "the unkept snapshot went with its box");
  assert.ok(!volumes(fake).includes(snapshotVolume(plain.id)));
  assert.equal(state.store.record(plain.id), null);

  const gone = state.snapshots.findGone(box.name, "kept one");
  assert.deepEqual([gone.boxGone?.how, gone.keptUntil], ["released", keptUntilAfter(START, 30)]);
  const listed = await dockerOf(state).heldSnapshots();
  assert.deepEqual(listed.map((held) => [held.id, held.keptUntil]), [[kept.id, keptUntilAfter(START, 30)]]);
});

test("Docker forks a kept snapshot after its box's release into one of the person's machines, which resets its identity", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box } = await keptAndPlain(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const gone = state.snapshots.findGone(box.name, "kept one");

  const answer = await state.snapshots.forkGone(gone, { is: "command" }, { name: "from-kept" });
  const fork = (await state.boxes.settled(answer.box!))!;

  assert.equal(fork.state, "ready", fork.error ?? "");
  const container = fork.guest!.ref;
  assert.ok(fake.inspect(container).Config.Env.includes(`BBBOX_IDENTITY=${fork.id}`));
  assert.equal(readFileSync(join(fake.home(container), "work.txt"), "utf8"), "before the take");
  assert.match(readFileSync(join(fake.identityRoot(container), "var/lib/bb-box/identity-resets"), "utf8"), /BB machines removed: host_source/, "its boot reset ran");
  assert.equal(state.store.operation(answer.operation.id)?.state, "done");
});

function addressOf(fake: FakeDockerHost, container: string): string {
  return Object.values(fake.inspect(container).NetworkSettings.Networks)[0]!.IPAddress;
}

function dockerOn(fake: FakeDockerHost, ...args: string[]): void {
  const ran = spawnSync(fake.binary, args, { encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
}

async function keptSourceOnThisMachine(state: World, fake: FakeDockerHost) {
  fake.set({ name: hostname() });
  const { box, kept } = await keptAndPlain(state, fake);
  assert.equal(box.guest!.address, "172.30.0.2", "an engine on this machine records the box's address");
  return { box, kept };
}

async function forkOfKept(state: World, box: BoxRecord): Promise<BoxRecord> {
  const answer = await state.snapshots.forkGone(state.snapshots.findGone(box.name, "kept one"), { is: "command" }, { name: "from-kept" });
  return (await state.boxes.settled(answer.box!))!;
}

test("on an engine of this machine with no other box, Docker forks a kept snapshot after its box's release, though the engine gives the fork its source's old address", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box } = await keptSourceOnThisMachine(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  const fork = await forkOfKept(state, box);

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(addressOf(fake, fork.guest!.ref), "172.30.0.2", "Docker gave the fork the lowest free address, its source's");
  assert.equal(readFileSync(join(fake.home(fork.guest!.ref), "work.txt"), "utf8"), "before the take");
  assert.match(readFileSync(join(fake.identityRoot(fork.guest!.ref), "var/lib/bb-box/identity-resets"), "utf8"), /BB machines removed: host_source/);
});

test("Docker still refuses a fork that holds the address of its source, stopped but not released, as the source could come back to it", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptSourceOnThisMachine(state, fake);
  dockerOn(fake, "container", "stop", box.guest!.ref);

  const answer = await state.snapshots.fork(COMMAND, box, standing(box), kept.id, { name: "from-kept" });
  const fork = (await state.boxes.settled(answer.box!))!;

  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", new RegExp(`it holds ${box.name}'s address 172\\.30\\.0\\.2`));
  assert.ok(!fake.containers().includes(fork.guest?.ref ?? "none"), "the refused fork is removed");
});

test("Docker refuses a fork that holds the address of its stopped source whose box record is lost, as the source's container is still on the engine", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptSourceOnThisMachine(state, fake);
  dockerOn(fake, "container", "stop", box.guest!.ref);
  await state.forgetBox(box);

  const answer = await state.snapshots.fork(COMMAND, box, standing(box), kept.id, { name: "from-kept" });
  const fork = (await state.boxes.settled(answer.box!))!;

  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", new RegExp(`${box.name}'s (last )?address 172\\.30\\.0\\.2`));
  assert.ok(fake.containers().includes(box.guest!.ref), "the source's container is still there");
});

test("Docker refuses a fork that holds the address of its stopped source whose box record is lost and whose container was renamed, as its labels still name the box", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptSourceOnThisMachine(state, fake);
  dockerOn(fake, "container", "stop", box.guest!.ref);
  dockerOn(fake, "container", "rename", box.guest!.ref, `${box.guest!.ref}-renamed`);
  await state.forgetBox(box);

  const answer = await state.snapshots.fork(COMMAND, box, standing(box), kept.id, { name: "from-kept" });
  const fork = (await state.boxes.settled(answer.box!))!;

  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", new RegExp(`${box.name}'s (last )?address 172\\.30\\.0\\.2`));
});

test("Docker forks a kept snapshot whose source's box record is lost once the engine has no container of that box, though the fork gets its old address", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptSourceOnThisMachine(state, fake);
  dockerOn(fake, "container", "rm", "--force", box.guest!.ref);
  await state.forgetBox(box);

  const answer = await state.snapshots.fork(COMMAND, box, standing(box), kept.id, { name: "from-kept" });
  const fork = (await state.boxes.settled(answer.box!))!;

  assert.equal(fork.state, "ready", fork.error ?? "");
  assert.equal(addressOf(fake, fork.guest!.ref), "172.30.0.2");
});

test("a fork on the old address of a source whose box record is lost is refused when its provider cannot say that the source's machine is gone", async () => {
  const cannotSay = [
    { name: "cannot ask", boxHasNoGuest: async () => { throw new Error("the engine did not answer"); }, why: /it could not ask .+ whether \S+'s machine is still there, .+: Asking failed: the engine did not answer/ },
    { name: "has no way to ask", boxHasNoGuest: undefined, why: /\S+'s (last )?address 172\.30\.0\.2/ },
  ];
  for (const each of cannotSay) {
    const fake = fakeDockerHost();
    const state = dockerWorld(fake);
    const { box, kept } = await keptSourceOnThisMachine(state, fake);
    dockerOn(fake, "container", "rm", "--force", box.guest!.ref);
    await state.forgetBox(box);
    Object.assign(dockerOf(state), { boxHasNoGuest: each.boxHasNoGuest });

    const answer = await state.snapshots.fork(COMMAND, box, standing(box), kept.id, { name: "from-kept" });
    const fork = (await state.boxes.settled(answer.box!))!;

    assert.equal(fork.state, "failed", each.name);
    assert.match(fork.error ?? "", each.why, each.name);
  }
});

test("Docker refuses a fork after its source's release that holds the source's old address the engine did not give it", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box } = await keptSourceOnThisMachine(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const other = await state.boxes.settled(await state.boxes.acquire({ threadId: THREAD, projectId: null, kind: "linux", who: BY_COMMAND }));
  assert.equal(addressOf(fake, other!.guest!.ref), "172.30.0.2", "another box took the old address");
  fake.set({ guestAlsoHolds: "172.30.0.2" });

  const fork = await forkOfKept(state, box);

  assert.equal(fork.state, "failed");
  assert.match(fork.error ?? "", new RegExp(`it holds ${box.name}'s address 172\\.30\\.0\\.2`));
});

test("Docker's kept snapshots and their dates are found again from the engine alone after BB Box restarts without snapshots.db's records", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptAndPlain(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  state.forgetRecords();
  await state.restart();
  await state.snapshots.sweep();

  const found = state.store.record(kept.id)!;
  assert.equal(found.keptUntil, keptUntilAfter(START, 30));
  assert.equal(found.foundAt, null, "kept, so not a found orphan");
  assert.equal(found.forkSafe, 9, "the image's label keeps the identity reset version");
  assert.deepEqual([found.box.kind, found.box.name, found.box.thread], ["linux", box.name, THREAD], "the image's labels keep the box's kind, name and thread");
  const check = await state.snapshots.checkForkGone(found, {});
  assert.equal(check.asMachine, true);
});

test("Docker's sweep deletes a released box's kept snapshot after its date, with its image, Docker data and keep tag, and not a day early", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptAndPlain(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  state.tick(30 * DAY);
  await state.snapshots.sweep();
  assert.ok(images(fake).includes(snapshotImage(INSTALL, box.id, kept.id)), "kept to the end of its day");
  assert.notEqual(state.store.record(kept.id), null);

  state.tick(DAY);
  await state.snapshots.sweep();

  assert.equal(state.store.record(kept.id), null);
  assert.ok(!images(fake).includes(snapshotImage(INSTALL, box.id, kept.id)));
  assert.ok(!volumes(fake).includes(snapshotVolume(kept.id)));
  assert.deepEqual(keepTags(fake), []);
});

test("Docker's sweep deletes a living box's kept snapshot after its date, keep tag and all", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptAndPlain(state, fake);

  state.tick(31 * DAY);
  await state.snapshots.sweep();

  assert.equal(state.store.record(kept.id), null);
  assert.deepEqual(keepTags(fake), []);
  assert.ok(!images(fake).includes(snapshotImage(INSTALL, box.id, kept.id)));
});

test("Docker deletes a kept snapshot you delete with its keep tag first, so nothing holds its image", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, kept } = await keptAndPlain(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  await state.snapshots.deleteGone(state.snapshots.findGone(box.name, "kept one"), BY_COMMAND);

  const removes = fake.calls().filter((args) => args[0] === "image" && args[1] === "rm").map((args) => args.at(-1));
  assert.deepEqual(removes.slice(-2), [keptTag(INSTALL, kept.id, "2026-11-29"), snapshotImage(INSTALL, box.id, kept.id)]);
  assert.deepEqual(keepTags(fake), []);
  assert.ok(!volumes(fake).includes(snapshotVolume(kept.id)));
});

test("Docker's doctor says what kept snapshots hold on Docker's disk, and until when", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box } = await keptAndPlain(state, fake);
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);

  const report = await dockerOf(state).doctor();

  const kept = report.checks.find((check) => check.id === "docker.kept-snapshots");
  assert.match(kept?.detail ?? "", /^1 snapshot is kept, whether its box is released or not, until its keep date, 2026-11-29\. It takes about \S+ (MB|GB) of Docker's disk that no other image or container there uses, and up to \S+ (MB|GB) if what it shares is deleted\. BB Box refuses to remove this backend while it holds them\.$/);
  assert.match(kept?.fix ?? "", /bb box snapshot delete <box> <snapshot>/);
});

function keptCheckOf(report: { readonly checks: readonly { readonly id: string; readonly detail: string }[] }): string {
  return report.checks.find((check) => check.id === "docker.kept-snapshots")?.detail ?? "";
}

test("Keep and the doctor say what a kept snapshot of a large image with a tiny change takes that nothing else shares, up to its whole size, and its whole size once its image is refreshed", async () => {
  const fake = fakeDockerHost();
  writeFileSync(join(fake.root, "image-sizes.json"), JSON.stringify({ "bbbox/linux:1": 795_407_487 }));
  fake.set({ snapshotLayerBytes: 126_976, snapshotVolumeKiB: 4 });
  const state = dockerWorld(fake);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;

  const check = await state.snapshots.checkKeep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const released = keptCheckOf(await dockerOf(state).doctor());
  dockerOn(fake, "image", "rm", "bbbox/linux:1");
  const refreshed = keptCheckOf(await dockerOf(state).doctor());

  assert.match(keepCostWords(check), /nothing is copied then\. It takes about 1 MB of \S+ Docker's disk that no other image or container there uses, and up to 796 MB if what it shares is deleted\.$/);
  assert.match(released, /It takes about 1 MB of Docker's disk that no other image or container there uses, and up to 796 MB if what it shares is deleted\./);
  assert.match(refreshed, /It takes about 796 MB of Docker's disk that no other image or container there uses\. BB Box/, "nothing shares its layers once the image it came from is gone");
});

async function keptLargeImageForkedAfterRelease(state: World, fake: FakeDockerHost) {
  writeFileSync(join(fake.root, "image-sizes.json"), JSON.stringify({ "bbbox/linux:1": 795_407_487 }));
  fake.set({ snapshotLayerBytes: 126_976, snapshotVolumeKiB: 4 });
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "kept one" })).snapshot!;
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.boxes.release(THREAD, box.id, "done", BY_COMMAND);
  const fork = await forkOfKept(state, box);
  assert.equal(fork.state, "ready", fork.error ?? "");
  return { box, taken, fork };
}

test("the doctor counts a running fork that uses a kept snapshot's image as sharing it, so only the snapshot's Docker data is its own", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  await keptLargeImageForkedAfterRelease(state, fake);

  const withFork = keptCheckOf(await dockerOf(state).doctor());

  assert.match(withFork, new RegExp(`It takes about ${gbWords(4096)} of Docker's disk that no other image or container there uses, and up to 796 MB if what it shares is deleted\\.`));
});

test("deleting a kept snapshot whose fork still uses its image says its size was an estimate and that what the fork uses stays, not that it freed it", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { box, fork } = await keptLargeImageForkedAfterRelease(state, fake);

  const answer = await state.snapshots.deleteGone(state.snapshots.findGone(box.name, "kept one"), BY_COMMAND);
  const said = deletedText(answer, box.name);

  assert.match(said, /: it freed up to about \S+ (kB|MB|GB), an estimate from when it was taken, less what a fork or another image still uses, which stays until they go\.$/);
  assert.ok(fake.containers().includes(fork.guest!.ref), "the fork still runs on its image");
});

const MEASURED_ON_CONTAINERD = { layers: ["ubuntu", "tools", "start", "own"], layerBytes: [87_633_920, 2_102_317_056, 57_344, 139_264], imageBytes: 795_410_974, store: "containerd", volumeBytes: 7_193_000 } as const;

test("on containerd, a kept snapshot's unshared size counts its own layers unpacked and their share of its packed content, with its Docker data", () => {
  const whole = 795_410_974 + 87_633_920 + 2_102_317_056 + 57_344 + 139_264 + 7_193_000;

  const beside = retainedOnEngine(MEASURED_ON_CONTAINERD, [["ubuntu", "tools", "start"]]);
  const besideUbuntu = retainedOnEngine(MEASURED_ON_CONTAINERD, [["ubuntu"]]);
  const alone = retainedOnEngine(MEASURED_ON_CONTAINERD, []);
  const unmatched = retainedOnEngine({ ...MEASURED_ON_CONTAINERD, layerBytes: [87_633_920, 2_102_317_056] }, []);

  assert.deepEqual([beside.wholeBytes, alone.wholeBytes, alone.unsharedBytes], [whole, whole, whole]);
  assert.equal(Math.round(beside.unsharedBytes! / 1e6), 7, "its own 139 kB layer, about 50 kB of packed content, and 7.2 MB of Docker data");
  assert.equal(Math.round(besideUbuntu.unsharedBytes! / 1e8) / 10, 2.9, "Docker's own count was 2.898 GB with the containerd store");
  assert.deepEqual(unmatched, { unsharedBytes: null, wholeBytes: 795_410_974 + 87_633_920 + 2_102_317_056 + 7_193_000 });
});

test("where BB Box cannot read how much of Docker's disk a snapshot takes, Keep still keeps it and claims no size, and the doctor says it could not tell", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;
  fake.set({ failImageHistory: true });

  const check = await state.snapshots.checkKeep(COMMAND, standing(box), taken.id, { days: 30 });
  await state.snapshots.keep(COMMAND, standing(box), taken.id, { days: 30 });
  const detail = keptCheckOf(await dockerOf(state).doctor());

  assert.equal(keepCostWords(check), `If ${box.name} is released, it stays where it is until Sun 29 Nov.`);
  assert.match(detail, /BB Box could not read how much of Docker's disk it takes\./);
  assert.deepEqual(keepTags(fake), [keptTag(INSTALL, taken.id, "2026-11-29")]);
});

test("Docker lists a kept snapshot once, though its image carries two tags", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake);
  const { kept } = await keptAndPlain(state, fake);

  const listed = await dockerOf(state).heldSnapshots();

  assert.equal(listed.filter((held) => held.id === kept.id).length, 1);
});

const KEEP_OFF_PARTS = [
  { provider: "Hetzner Cloud", why: HETZNER_KEEP_OFF, options: (binary: string) => hostPartOptions({ binary, readyTimeoutMs: 2_000 }, new DockerCli(null, binary)) },
  { provider: "Namespace", why: NAMESPACE_KEEP_OFF, options: (binary: string) => instancePartOptions({ binary, readyTimeoutMs: 2_000 }, new DockerCli(null, binary), null) },
] as const;

for (const { provider, why, options } of KEEP_OFF_PARTS) {
  test(`the Docker engine ${provider} makes for its boxes offers no Keep, says why, and writes no keep tag`, async () => {
    const fake = fakeDockerHost();
    fake.withIdentityReset("bbbox/linux:1", 9);
    const backend = new DockerBackend(dockerConfig(), testContext(new MemoryStorage(), INSTALL, { id: "fake" }), options(fake.binary));
    const box = { boxId: "bxkeepoffaaaaa", threadId: THREAD, name: "keep-off", kind: "linux", size: { cores: 2, memoryMiB: 4096, diskGiB: null }, createdAt: START };
    const guest: Guest = await backend.acquire(box as never, null, { claim: async () => {}, starting: async () => {}, timing: () => {} }, AbortSignal.timeout(10_000));
    await backend.snapshot!(guest, { id: "snkeepoffaaaaa", box: box.boxId, memory: false, forkSafe: 9 }, { submitting: async () => {}, task: async () => {} });

    const offer = backend.snapshotting("linux");
    const plan = await backend.planSnapshots!(guest, "linux", null);
    const refused = await backend.labelKept!({ id: "snkeepoffaaaaa", ref: snapshotImage(INSTALL, box.boxId, "snkeepoffaaaaa"), guest }, utcDay(START + 30 * DAY)).then(() => null, (error: unknown) => error);

    assert.deepEqual([offer?.keepsPastRelease, offer?.keepWhy], ["no", why]);
    assert.deepEqual([plan.keep.way, plan.keep.why], ["no", why]);
    assert.ok(refused instanceof SnapshotFailed);
    assert.equal(refused.message, `BB Box keeps no snapshot here past its box's release: ${why}.`);
    assert.deepEqual(keepTags(fake), []);
    await backend.dispose?.();
  });
}

test("a Docker engine of a person's own keeps snapshots as they are, and lives with the provider, so BB Box asks the engine before it removes the backend", () => {
  const fake = fakeDockerHost();
  const backend = new DockerBackend(dockerConfig(), testContext(new MemoryStorage(), INSTALL, { id: "fake" }), { binary: fake.binary });

  const offer = backend.snapshotting("linux");

  assert.deepEqual([offer?.keepsPastRelease, offer?.lives, offer?.keepWhy], ["as-is", "provider", undefined]);
});

test("where a Docker engine keeps nothing past a release, Keep is refused with its reason, and the Snapshots card gives the same reason", async () => {
  const fake = fakeDockerHost();
  const state = dockerWorld(fake, HETZNER_KEEP_OFF);
  const box = await readyDockerBox(state, fake);
  const taken = (await state.snapshots.take(COMMAND, box, standing(box), { name: "one" })).snapshot!;

  const refused = await rejection(state.snapshots.checkKeep(COMMAND, standing(box), taken.id, { days: 30 }));
  const offer = dockerOf(state).snapshotting("linux");

  assert.equal(refused.code, "unsupported");
  assert.match(refused.message, new RegExp(`past the box's release: ${HETZNER_KEEP_OFF}, so BB Box does not keep "one"\\.$`));
  assert.equal(keepWhyOf(state.store.record(taken.id)!, offer, null), HETZNER_KEEP_OFF);
  assert.deepEqual(keepTags(fake), []);
});
