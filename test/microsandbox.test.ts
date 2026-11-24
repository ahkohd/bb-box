import "./check-test-machine.mjs";
// The microsandbox backend (053) against a fake msb host (fake-msb.ts).

import assert from "node:assert/strict";
import { existsSync, readdirSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dockerKinds } from "../src/backends/docker/backend.ts";
import { offerChecks } from "../src/backends/index.ts";
import { BUILDER_IMAGE, MsbBackend, OWN_HOSTNAME, RUN_IN_MEMORY, msbKinds, parseFacts, sandboxName } from "../src/backends/microsandbox/backend.ts";
import { MsbCli } from "../src/backends/microsandbox/cli.ts";
import { parseMsbPart } from "../src/backends/microsandbox/config.ts";
import { microsandboxDriver } from "../src/backends/microsandbox/index.ts";
import {
  buildImageRef,
  canonicalRepositoryOf,
  isBuildOf,
  isRestoreDigestOf,
  msbScript,
  parseImageCache,
  parseProjectImageBuild,
  projectImageBase,
  scriptArgsOk,
} from "../src/backends/microsandbox/release.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type MachineSize, type FieldValue, type Guest, type MachineAccess, type ReleaseHooks, type SnapshotHooks } from "../src/backends/types.ts";
import { dockerConfig } from "./fake-docker.ts";
import { fakeMsbHost, imageLabels, msbConfig } from "./fake-msb.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };

function setup(values: Record<string, FieldValue> = {}, options: { imported?: boolean } = {}) {
  const fake = fakeMsbHost(options);
  const config = msbConfig(values);
  const context = testContext();
  const make = (installId = "test", storage = new MemoryStorage()) => new MsbBackend(config, testContext(storage, installId), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  return { fake, context, make, backend: new MsbBackend(config, context, { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 }) };
}

let counter = 0;
function identity(kind = "linux", size = SMALL, threadId = "thr_abc123"): BoxIdentity {
  counter++;
  return { boxId: `bx${String(counter).padStart(12, "0")}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: "none" } };
}

function hooks() {
  const events: string[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async () => void events.push("claim"),
    starting: async () => void events.push("starting"),
    timing: (step, ms) => void (timings[step] = ms),
  };
  return { hooks: value, events, timings };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

function untilSeen(dir: string, met: () => boolean): Promise<void> {
  if (met()) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      watcher.close();
      resolve();
    };
    const watcher = watch(dir, () => {
      if (met()) finish();
    });
    if (met()) finish();
  });
}

function after(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, i) => (arg === flag ? [args[i + 1]!] : []));
}

test("parses the fields, with the guide's defaults, and refuses what it cannot use at each field", () => {
  assert.deepEqual(msbConfig(), {
    host: null,
    machine: null,
    images: { linux: "bbbox/linux:1", "linux-desktop-cpu": "bbbox/linux-desktop:1", "linux-arm64": "bbbox/linux:1-arm64", "linux-arm64-desktop-cpu": "bbbox/linux-desktop:1-arm64" },
    docker: true,
    dockerDiskGiB: 64,
    diskGiB: 32,
    network: "public,private",
    boxes: 20,
    reserveMemoryMiB: 4096,
    memoryOvercommit: 1,
  });
  assert.equal(msbConfig({ host: "bb:host_abc123" }).machine, "host_abc123");
  assert.equal(msbConfig({ "memory-overcommit": 1.5 }).memoryOvercommit, 1.5);
  const bad = parseMsbPart({ id: "microsandbox", hosts: [], fields: { host: "tcp://x:1", "linux-image": "a b", network: "public,lan", boxes: 0, "disk-gib": 2, "memory-overcommit": 5 } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.problems.map((problem) => problem.path).sort(), ["boxes", "disk-gib", "host", "linux-image", "memory-overcommit", "network"]);
  const under = parseMsbPart({ id: "microsandbox", hosts: [], fields: { "memory-overcommit": 0.5 } });
  assert.deepEqual(under.ok ? [] : under.problems.map((problem) => problem.message), ["microsandbox: the memory overcommit must be from 1 to 4, such as 1.5."]);
  assert.equal(microsandboxDriver.several?.({ host: " bb:host_a " }), "bb:host_a");
});

test("offers linux, with Docker unless it is off, and linux-desktop-cpu, agreeing with Docker's offers of them", () => {
  const kinds = msbKinds(msbConfig());
  assert.deepEqual(kinds.map((kind) => kind.id), ["linux", "linux-desktop-cpu"]);
  assert.deepEqual(kinds[0]!.capabilities.features, ["docker"]);
  assert.deepEqual(msbKinds(msbConfig({ docker: false }))[0]!.capabilities.features, []);
  assert.deepEqual(msbKinds(msbConfig({ "desktop-image": "" })).map((kind) => kind.id), ["linux"]);
  const docker = dockerKinds(dockerConfig()).filter((kind) => kinds.some((other) => other.id === kind.id));
  const checks = offerChecks([
    ...docker.map((kind) => ({ kind, backend: { label: "Docker" } })),
    ...kinds.map((kind) => ({ kind, backend: { label: "microsandbox" } })),
  ] as never);
  assert.ok(checks.length >= 2);
  assert.deepEqual(checks.filter((check) => check.status !== "ok"), [], "the agent may rely on the same things from either");
});

test("acquires a box as a microVM labelled with its owner, at its size, with /run a tmpfs, Docker on a disk of its own and the network that reaches BB", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const run = hooks();
  const guest = await backend.acquire(box, null, run.hooks, signal());
  assert.equal(guest.ref, sandboxName(box.boxId));
  assert.deepEqual(guest.data, { box: box.boxId });
  assert.deepEqual(guest.size, { cores: 2, memoryMiB: 4096, diskGiB: 32 });
  assert.deepEqual(run.events, ["claim", "starting", "claim"], "claimed before anything is made");
  assert.deepEqual(Object.keys(run.timings), ["place", "image", "create", "ready"]);
  const create = fake.calls().find((call) => call[0] === "create")!;
  assert.equal(create[1], "bbbox/linux:1");
  assert.deepEqual(after(create, "--label").sort(), [
    "bbbox.backend=microsandbox",
    `bbbox.box=${box.boxId}`,
    "bbbox.created=1790000000000",
    "bbbox.install=test",
    "bbbox.kind=linux",
    `bbbox.name=${box.name}`,
    "bbbox.thread=thr_abc123",
  ]);
  assert.deepEqual(
    ["--hostname", "--cpus", "--memory", "--root-disk", "--tmpfs", "--net", "--pull", "--mount-owned"].map((flag) => after(create, flag)[0]),
    [box.name, "2", "4096M", "32G", "/run", "public,private", "never", "/var/lib/docker:kind=disk,size=64G"],
  );
  assert.deepEqual(after(create, "--mount-disk"), [], "msb's own disk, which msb snapshots and gives a restored box, never a file of the host's (070 unit 10)");
  assert.deepEqual(after(create, "--env"), [`BBBOX_IDENTITY=${box.boxId}`, "BBBOX_DOCKERD=1"], "the value its identity marker holds, set on the guest by bb-box (070)");
  assert.ok(!create.includes("--replace"));
  const quiet = setup({ docker: false });
  const small = identity("linux", { cores: 1, memoryMiB: 2048, diskGiB: 8 });
  await quiet.backend.acquire(small, null, hooks().hooks, signal());
  const plain = quiet.fake.calls().find((call) => call[0] === "create")!;
  assert.deepEqual([after(plain, "--mount-owned"), after(plain, "--mount-disk"), after(plain, "--env"), after(plain, "--root-disk")[0]], [[], [], [`BBBOX_IDENTITY=${small.boxId}`], "8G"]);
});

test("070 unit 10: a box made before, with its Docker disk a file of the host's, starts, resizes and releases as before, its file going with it, and the upkeep removes old disks no microVM has", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const name = sandboxName(box.boxId);
  const { mkdirSync, utimesSync, writeFileSync } = await import("node:fs");
  mkdirSync(join(fake.dir, "disks"), { recursive: true });
  const disk = join(fake.dir, "disks", `${name}.ext4`);
  writeFileSync(disk, "");
  await new MsbCli(null, null, undefined, { dir: fake.dir }).ok([
    "create", "bbbox/linux:1", "--name", name, "--label", "bbbox.backend=microsandbox", "--label", "bbbox.install=test", "--label", `bbbox.box=${box.boxId}`, "--label", `bbbox.thread=${box.threadId}`,
    "--cpus", "2", "--memory", "4096M", "--root-disk", "32G", "--tmpfs", "/run", "--mount-disk", `${disk}:/var/lib/docker`,
  ]);
  const guest: Guest = { ref: name, host: null, address: null, size: SMALL, data: { box: box.boxId } };
  await backend.stop(guest);
  await backend.start(guest);
  assert.equal(fake.inspect(name).status, "Running");
  const resized = await backend.resize(guest, "linux", { cores: 4, memoryMiB: 4096, diskGiB: 40 }, { restart: true }, signal());
  assert.equal(resized.size?.cores, 4);
  assert.deepEqual(fake.inspect(name).config.disks, [`${disk}:/var/lib/docker`], "its Docker disk stays the host's file");
  await backend.release(guest, releasing);
  assert.ok(!existsSync(disk), "released with the box");

  const kept = await backend.acquire(identity(), null, hooks().hooks, signal());
  const old = join(fake.dir, "disks", "bbbox-bxleftover.ext4");
  writeFileSync(old, "");
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(old, hourAgo, hourAgo);
  writeFileSync(join(fake.dir, "disks", "bbbox-bxmaking.ext4"), "");
  await backend.maintain(signal());
  assert.deepEqual(readdirSync(join(fake.dir, "disks")).sort(), ["bbbox-bxmaking.ext4"], "the old leftover goes; a new one stays");
  assert.ok(fake.sandboxes().includes(kept.ref));
  assert.ok(!fake.calls().some((call) => call[0] === "create" && after(call, "--name")[0]?.startsWith("bb-box-mkfs-")), "no template of a host disk is made any more");
});

test("installs msb on a host that lacks it, once, and imports a kind's image from Docker under a unique build tag when msb lacks it, and again when Docker's changes", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.facts({ installed: "" });

  const first = await backend.acquire(identity(), null, hooks().hooks, signal());
  const second = await backend.acquire(identity(), null, hooks().hooks, signal());

  assert.deepEqual(fake.scripts.filter(([name]) => name === "install"), [["install"]]);
  const initialImports = fake.scripts.filter(([name]) => name === "import");
  assert.equal(initialImports.length, 1);
  assert.equal(initialImports[0]![1], "bbbox/linux:1");
  assert.ok(isBuildOf(initialImports[0]![2]!, "bbbox/linux:1"));
  assert.deepEqual(Object.keys(fake.images()), [initialImports[0]![2]!]);

  // The upkeep imports the desktop image, and the linux image again once Docker's build is new.
  await backend.maintain(signal());
  assert.equal(fake.scripts.filter(([name]) => name === "import").length, 2);

  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.next") });
  await backend.maintain(signal());
  const imports = fake.scripts.filter(([name]) => name === "import");
  assert.deepEqual(imports.map(([, image]) => image), ["bbbox/linux:1", "bbbox/linux-desktop:1", "bbbox/linux:1"]);
  const nextLinux = imports[2]![2]!;
  assert.ok(isBuildOf(nextLinux, "bbbox/linux:1"));
  assert.notEqual(nextLinux, initialImports[0]![2]!);
  assert.ok(fake.images()[initialImports[0]![2]!]);

  await backend.release(first, releasing);
  await backend.release(second, releasing);
  await backend.maintain(signal());
  assert.equal(fake.scripts.filter(([name]) => name === "import").length, 3);
  assert.ok(!fake.images()[initialImports[0]![2]!]);
  assert.ok(fake.images()[nextLinux]);
});

test("a kind whose image neither msb nor Docker has is refused for now, and BB Box builds the image in a builder microVM under a unique build tag, pulling only Docker's own, pinned, and removes the builder (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.docker.delete("bbbox/linux:1");
  const built = fake.whenImage("bbbox/linux:1");
  await assert.rejects(
    backend.acquire(identity(), null, hooks().hooks, signal()),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /has no image bbbox\/linux:1 yet\. BB Box is building it there in a microVM/.test(error.message),
  );
  await built;
  const builtRef = Object.keys(fake.images()).find((ref) => isBuildOf(ref, "bbbox/linux:1"));
  assert.ok(builtRef);
  assert.equal(fake.images()["bbbox/linux:1"], undefined);
  const builder = fake.calls().find((call) => call[0] === "create" && call.includes("--name") && after(call, "--name")[0]!.startsWith("bb-box-builder-"))!;
  assert.equal(builder[1], BUILDER_IMAGE);
  assert.match(BUILDER_IMAGE, /^docker:[\w.-]+-dind@sha256:[0-9a-f]{64}$/);
  const { readFileSync } = await import("node:fs");
  const steps = readFileSync(join(fake.root, "builder"), "utf8");
  assert.match(steps, /nohup dockerd >\/var\/log\/dockerd\.log 2>&1 <\/dev\/null &/);
  assert.match(steps, /base64 -d \| tar -xz -C \/build/);
  assert.match(steps, /bash setup\/docker\/build\.sh --arch x86_64 --tag bbbox\/linux:1-b[a-z0-9]+ linux /);
  assert.ok(fake.scripts.some(([name, , image]) => name === "transfer" && image === builtRef));
  await untilSeen(join(fake.root, "sandboxes"), () => !fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")));
  assert.deepEqual(fake.sandboxes(), []);
  assert.ok(!fake.calls().some((call) => call[0] === "pull"));
  // The next box starts from the built image.
  await backend.acquire(identity(), null, hooks().hooks, signal());
});

test("on a Mac, the backend offers the arm64 kinds, checks the Hypervisor framework, builds there for arm64, and leaves the reclaim alone (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  fake.docker.clear();
  const report = await backend.doctor(signal());
  assert.deepEqual(backend.kinds().map((kind) => kind.id), ["linux-arm64", "linux-arm64-desktop-cpu"]);
  assert.ok(backend.kinds().every((kind) => kind.capabilities.arch === "arm64"));
  // The desktop has Selkies beside its VNC server, as on x86_64, and opens as video (060).
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "linux-arm64-desktop-cpu")!.capabilities.displays.map((display) => [display.protocol, display.byChoice ?? false]), [["rfb", false], ["selkies", false]]);
  assert.equal(backend.hostOs, "macos");
  const by = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.match(by["microsandbox.host"]!.detail, /It offers the arm64 kinds\./);
  assert.deepEqual([by["microsandbox.kvm"]!.name, by["microsandbox.kvm"]!.status], ["Hypervisor", "ok"]);
  assert.equal(by["image.bbbox/linux:1-arm64"]!.status, "warn");
  assert.match(by["image.bbbox/linux:1-arm64"]!.fix ?? "", /BB Box builds it there in a microVM of its own/);
  assert.equal(by["image.bbbox/linux:1"], undefined);
  await assert.rejects(backend.acquire(identity("linux"), null, hooks().hooks, signal()), /does not offer linux boxes/);
  const built = fake.whenImage("bbbox/linux:1-arm64");
  await assert.rejects(backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal()), /BB Box is building it there/);
  await built;
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /nohup sh -c .*build\.sh --arch arm64.*echo \$\? >\/build\/build\.exit/);
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /cat \/build\/build\.exit/);
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /build\.sh --arch arm64 --tag bbbox\/linux:1-arm64-b[a-z0-9]+ linux /);
  // The builder goes in the background after its image is in msb: the next box waits for that, so no fake reads a sandbox as it is removed.
  await untilSeen(join(fake.root, "sandboxes"), () => !fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")));
  const box = await backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.deepEqual(after(fake.calls().find((call) => call[0] === "create" && call.includes(box.ref))!, "--mount-owned"), ["/var/lib/docker:kind=disk,size=64G"]);
  await backend.maintain(signal());
  assert.ok(!fake.calls().some((call) => call[0] === "exec" && call.some((arg) => arg.includes("drop_caches"))));
});

test("a start runs the image's command again, which msb start does not, and waits for it; a stop stops the microVM", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.stop!(guest, signal());
  assert.equal(await backend.power(guest), "stopped");
  assert.equal(existsSync(join(fake.root, "sandboxes", guest.ref, "run", "bb-box", "ready")), false);
  const steps: string[] = [];
  await backend.start!(guest, signal(), (step) => steps.push(step));
  assert.deepEqual(steps, ["boot", "ready"]);
  assert.equal(await backend.power(guest), "running");
  // Once as the box was made, once after msb start: neither runs the image's command.
  const exec = fake.calls().filter((call) => call[0] === "exec" && call.some((arg) => arg.includes("bb-box-start")));
  assert.equal(exec.length, 2);
  assert.match(exec[1]!.at(-1)!, /\[ -e \/run\/bb-box-started \] \|\| \{ : >\/run\/bb-box-started; setsid -f \/usr\/local\/sbin\/bb-box-start /);
});

test("acts only on its own microVMs: another install's or another box's are left alone, and a failed create's leftover is replaced (018, 053)", async () => {
  const { fake, backend, make } = setup();
  const theirs = await make("other").acquire(identity(), null, hooks().hooks, signal());
  assert.equal(await backend.power(theirs), null, "another install's box counts as gone");
  await backend.release(theirs, releasing);
  assert.ok(fake.sandboxes().includes(theirs.ref));
  assert.deepEqual((await backend.held()).map((held) => held.ref), []);
  await assert.rejects(backend.start!(theirs), (error: unknown) => error instanceof BackendError && error.code === "gone");

  // A name msb says exists, though it lists no such box: a failed create's leftover.
  const box = identity();
  fake.set({ ghost: sandboxName(box.boxId) });
  await backend.acquire(box, null, hooks().hooks, signal());
  const creates = fake.calls().filter((call) => call[0] === "create" && call.includes(sandboxName(box.boxId)));
  assert.deepEqual(creates.map((call) => call.includes("--replace")), [false, true]);

  const mine = (await backend.held())[0]!;
  assert.equal(mine.owner?.boxId, box.boxId);
  assert.equal(mine.power, "running");
  await backend.relabel!(mine, { ...box, threadId: "thr_new", name: "new-name" }, "spare");
  assert.deepEqual([(await backend.held())[0]!.owner?.threadId, (await backend.held())[0]!.owner?.name], ["thr_new", "new-name"]);
});

test("counts every install's microVMs and the memory of running ones, and refuses a box the host cannot hold, saying why", async () => {
  const { fake, backend, make } = setup({ boxes: 3, "reserve-memory-mib": 4096 });
  fake.facts({ cpus: "8", memory_kib: String(16 * 1024 * 1024) });
  await make("other").acquire(identity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null }), null, hooks().hooks, signal());
  const mine = await backend.acquire(identity(), null, hooks().hooks, signal());
  const room = await backend.capacity("linux", SMALL, []);
  assert.equal(room.ok, true);
  assert.deepEqual(room.hosts[0]!.limits.map((limit) => [limit.resource, limit.used, limit.total]), [["guests", 2, 3], ["memory", 8192, 16384]]);
  const big = await backend.capacity("linux", { cores: 2, memoryMiB: 8192, diskGiB: null }, []);
  assert.match(big.message ?? "", /has 8 GiB of memory free and keeps 4 GiB free, so a box with 8 GiB does not fit/);
  assert.match((await backend.capacity("linux", { cores: 12, memoryMiB: 2048, diskGiB: null }, [])).message ?? "", /has 8 cores, fewer than the 12 asked for/);
  await backend.stop!(mine);
  const stopped = await backend.capacity("linux", SMALL, [{ kind: "linux", size: SMALL }]);
  assert.match(stopped.message ?? "", /has 3 of the 3 BB Box microVMs it may have, counting stopped boxes/);
  assert.match((await backend.capacity("linux", { ...SMALL, diskGiB: 900 }, [])).message ?? "", /less than the 900 GiB disk asked for/);
});

test("at a memory overcommit of 1, capacity is as before and reads no available memory (#557)", async () => {
  const { fake, backend } = setup({ boxes: 10, "reserve-memory-mib": 4096 });
  fake.facts({ cpus: "8", memory_kib: String(16 * 1024 * 1024), available_kib: String(1024) });
  for (let i = 0; i < 3; i++) await backend.acquire(identity(), null, hooks().hooks, signal());
  const full = await backend.capacity("linux", SMALL, []);
  assert.deepEqual(full.hosts[0]!.limits.map((limit) => [limit.resource, limit.id ?? null, limit.used, limit.total]), [["guests", null, 3, 10], ["memory", null, 12288, 16384]]);
  assert.match(full.message ?? "", /has 4 GiB of memory free and keeps 4 GiB free, so a box with 4 GiB does not fit/);
  assert.ok(!fake.scripts.some(([name]) => name === "memory"), "the memory script is not run");
});

test("above 1, the boxes' sizes may add up to the overcommit times the host's memory less the reserve, and a new box needs memory available now (#557)", async () => {
  const { fake, backend } = setup({ boxes: 10, "reserve-memory-mib": 4096, "memory-overcommit": 2 });
  // 16 GiB, less 4 GiB kept free: the boxes' sizes may add up to 24 GiB, 6 boxes of 4 GiB, where 1 takes 3.
  fake.facts({ cpus: "8", memory_kib: String(16 * 1024 * 1024), available_kib: String(12 * 1024 * 1024) });
  for (let i = 0; i < 5; i++) await backend.acquire(identity(), null, hooks().hooks, signal());
  const room = await backend.capacity("linux", SMALL, []);
  assert.equal(room.ok, true, room.message ?? "");
  assert.deepEqual(room.hosts[0]!.limits.map((limit) => [limit.resource, limit.id ?? null, limit.used, limit.total, limit.reserve]), [
    ["guests", null, 5, 10, 0],
    ["memory", "committed", 20480, 28672, 4096],
    ["memory", "in use", 4096, 16384, 4096],
  ]);
  // Another box in flight takes the last of the ceiling.
  const ceiling = await backend.capacity("linux", SMALL, [{ kind: "linux", size: SMALL }]);
  assert.match(ceiling.message ?? "", /the boxes on .+ may have 24 GiB of memory in all, at a memory overcommit of 2, and have 24 GiB, so a box with 4 GiB does not fit\. Ask for less memory, release a box, or raise the memory overcommit in BB Box's settings/);

  // Busy boxes: under the ceiling, but the host has too little available to start one.
  fake.facts({ available_kib: String(5 * 1024 * 1024) });
  const busy = await backend.capacity("linux", SMALL, []);
  assert.match(busy.message ?? "", /has 5 GiB of memory available now and keeps 4 GiB free, so it cannot start a box with 4 GiB, which takes up to 2 GiB as it starts\. Its boxes are busy: try again later, or release a box/);
  // A smaller box needs only its size.
  assert.equal((await backend.capacity("linux", { cores: 1, memoryMiB: 1024, diskGiB: null }, [])).ok, true);
  // A box still starting counts at what it takes as it starts.
  const starting = await backend.capacity("linux", { cores: 1, memoryMiB: 1024, diskGiB: null }, [{ kind: "linux", size: { cores: 1, memoryMiB: 2048, diskGiB: null } }]);
  assert.match(starting.message ?? "", /has 5 GiB of memory available now, 2 GiB of it for boxes still starting, and keeps 4 GiB free/);
});

test("on a Mac, which keeps the memory a box has used, each box counts at its full size whatever the overcommit, and the doctor says so (#557)", async () => {
  const { fake, backend } = setup({ boxes: 10, "reserve-memory-mib": 4096, "memory-overcommit": 2 });
  fake.facts({ os: "Darwin", arch: "arm64", cpus: "8", memory_kib: String(16 * 1024 * 1024), available_kib: String(12 * 1024 * 1024) });
  // A Mac offers the arm64 kinds (040).
  for (let i = 0; i < 3; i++) await backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  const full = await backend.capacity("linux-arm64", SMALL, []);
  assert.deepEqual(full.hosts[0]!.limits.map((limit) => [limit.resource, limit.id ?? null, limit.used, limit.total]), [["guests", null, 3, 10], ["memory", null, 12288, 16384]]);
  assert.match(full.message ?? "", /has 4 GiB of memory free and keeps 4 GiB free, so a box with 4 GiB does not fit/);
  assert.ok(!fake.scripts.some(([name]) => name === "memory"), "the memory script is not run");
  const check = (await backend.doctor(signal())).checks.find((one) => one.id === "microsandbox.overcommit");
  assert.equal(check?.status, "warn");
  assert.match(check?.detail ?? "", /is a Mac, which keeps the memory a box has used, so BB Box counts each box there at its full size, whatever the memory overcommit of 2\./);
  assert.equal(check?.fix, "Set the memory overcommit to 1.");
});

test("each launch and each upkeep raise the microVMs' oom_score_adj on the host, and the scripts read what they should (#557)", async () => {
  const { fake, backend } = setup();
  await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.scripts.filter(([name]) => name === "oom").length, 1, "at the launch");
  await backend.maintain(signal());
  assert.equal(fake.scripts.filter(([name]) => name === "oom").length, 2, "and at the upkeep");

  const { msbScript, scriptArgsOk } = await import("../src/backends/microsandbox/release.ts");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  assert.ok(scriptArgsOk("memory", []) && scriptArgsOk("oom", []));
  assert.ok(!scriptArgsOk("oom", ["bbbox-x"]));
  const dir = (await import("./helpers.ts")).tempDir("oom");
  // A stand-in /proc: a BB Box microVM, another sandbox's, one already raised, and another process.
  const proc = (pid: string, cmdline: string[], adj: string) => {
    mkdirSync(join(dir, pid));
    writeFileSync(join(dir, pid, "cmdline"), `${cmdline.join("\0")}\0`);
    writeFileSync(join(dir, pid, "oom_score_adj"), `${adj}\n`);
  };
  proc("101", ["/home/u/.local/share/bb-box/microsandbox/0.7.7/msb", "machine", "--name", "bbbox-bx1", "--sandbox-id", "3"], "0");
  proc("102", ["/opt/msb", "machine", "--name", "other", "--sandbox-id", "4"], "0");
  proc("103", ["/opt/msb", "machine", "-n", "bbbox-bx2"], "800");
  proc("104", ["/usr/bin/node", "bb-app.js", "host-daemon"], "0");
  const oom = msbScript("oom").replace("/proc/[0-9]*", `${dir}/[0-9]*`);
  assert.equal(execFileSync("sh", ["-c", oom], { encoding: "utf8" }).trim(), "adjusted=1");
  assert.deepEqual(["101", "102", "103", "104"].map((pid) => readFileSync(join(dir, pid, "oom_score_adj"), "utf8").trim()), ["500", "0", "800", "0"]);

  writeFileSync(join(dir, "meminfo"), "MemTotal: 16384000 kB\nMemFree: 1000000 kB\nMemAvailable: 9000000 kB\n");
  const linux = msbScript("memory").replace("/proc/meminfo", join(dir, "meminfo")).replace('"$(uname -s)" = Linux', "Linux = Linux");
  assert.equal(execFileSync("sh", ["-c", linux], { encoding: "utf8" }).trim(), "available_kib=9000000");
  writeFileSync(
    join(dir, "vm_stat"),
    "Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free:                               10000.\nPages active:                            50000.\nPages inactive:                          20000.\nPages speculative:                        2000.\n",
  );
  const mac = msbScript("memory").replace('"$(uname -s)" = Linux', "Darwin = Linux").replace("vm_stat |", `cat ${join(dir, "vm_stat")} |`).replace("$(sysctl -n hw.pagesize)", "16384");
  assert.equal(execFileSync("sh", ["-c", mac], { encoding: "utf8" }).trim(), `available_kib=${(32000 * 16384) / 1024}`);
});

test("the doctor checks the host, msb, KVM and the images, warns in LXC, and says what msb's files take", async () => {
  const { fake, backend } = setup();
  const report = await backend.doctor(signal());
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status !== "ok")));
  assert.equal(report.summary, "msb 0.7.7 on BB's server");
  // The largest desktop preset has more cores than the fake host, which sizes warns of.
  assert.deepEqual(report.checks.map((check) => check.id).filter((id) => id !== "microsandbox.sizes"), ["microsandbox.host", "microsandbox.msb", "microsandbox.kvm", "microsandbox.snapshots", "image.bbbox/linux:1", "image.bbbox/linux-desktop:1", "microsandbox.images", "microsandbox.capacity"]);
  assert.match(report.notes.join("\n"), /msb's state and images take 3 GiB in .+\/home on BB's server\. Its file system has no reflinks, so msb copies a box's disk to fork or snapshot it\./);

  fake.facts({ kvm: "denied", lxc: "1", installed: "" });
  const broken = await backend.doctor(signal());
  assert.equal(broken.ok, false);
  const by = Object.fromEntries(broken.checks.map((check) => [check.id, check]));
  assert.equal(by["microsandbox.kvm"]!.status, "fail");
  assert.match(by["microsandbox.kvm"]!.fix ?? "", /add it to the kvm group, then restart its services/);
  assert.equal(by["microsandbox.lxc"]!.status, "warn");
  assert.match(by["microsandbox.lxc"]!.detail, /refuses FICLONE, so msb's snapshots and flat roots fail there/);
  assert.equal(by["microsandbox.msb"]!.status, "warn");
  assert.match(by["microsandbox.msb"]!.fix ?? "", /BB Box installs msb 0\.7\.7 there, checked by its SHA-256/);
  assert.equal(by["microsandbox.images"]!.status, "skipped");
});

test("the doctor says which images BB Box imports from Docker, and which it builds itself (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  // Before msb is installed too: Docker alone says what BB Box can import.
  fake.facts({ installed: "" });
  fake.docker.delete("bbbox/linux-desktop:1");
  const report = await backend.doctor(signal());
  const by = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(by["image.bbbox/linux:1"]!.status, "warn");
  assert.match(by["image.bbbox/linux:1"]!.fix ?? "", /BB Box imports it from Docker with the first linux box/);
  assert.equal(by["image.bbbox/linux-desktop:1"]!.status, "warn");
  assert.match(by["image.bbbox/linux-desktop:1"]!.fix ?? "", /BB Box builds it there in a microVM of its own, about 10 minutes, with the first linux-desktop-cpu box/);
});

test("runs commands, copies files and probes through msb exec as the box user, and a stopped box does not answer", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const { command } = await backend.transports(guest, "linux");
  const result = await command!.run("echo hi; echo there >&2; exit 3", { stdin: "x" });
  assert.deepEqual([result.exitCode, result.stdout, result.stderr], [3, "hi\n", "there\n"]);
  await command!.writeFile("notes/a.txt", new TextEncoder().encode("hello"));
  assert.equal(new TextDecoder().decode(await command!.readFile("notes/a.txt", { maxBytes: 100 })), "hello");
  const exec = fake.calls().find((call) => call[0] === "exec" && call.includes("-w"))!;
  assert.deepEqual(exec.slice(0, 6), ["exec", "--stream", "-u", "box", "-w", "/home/box"]);
  assert.equal(await command!.probe(), true);
  await backend.stop!(guest);
  assert.equal(await command!.probe(), false, "msb ping says it is not running, so the probe never boots it");
});

test("on a BB machine, msb runs through BB Box's msb relay, and an offline machine takes no box and runs nothing (053)", async () => {
  const fake = fakeMsbHost();
  const calls: string[][] = [];
  let connected = true;
  const machines: MachineAccess = {
    dockerHost: () => "unix:///nowhere",
    ready: async () => {},
    name: () => "devpc",
    connected: async () => connected,
    msb: () => ({
      argv: (args) => {
        calls.push([...args]);
        return [join(fake.dir, "bin", "msb"), ...args];
      },
      ready: async () => {},
      script: (name, args) => fake.script(name, args).then((result) => ({ dir: fake.dir, ...result })),
    }),
  };
  const context = { ...testContext(), machines };
  const backend = new MsbBackend(msbConfig({ host: "bb:host_dev" }), context, { readyTimeoutMs: 2_000 });
  assert.equal(backend.label, "microsandbox on devpc");
  assert.deepEqual(backend.hosts, ["devpc"]);
  await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.ok(calls.some((call) => call[0] === "create"));
  connected = false;
  const before = calls.length;
  const room = await backend.capacity("linux", SMALL, []);
  assert.deepEqual([room.ok, room.message], [false, "devpc is offline in BB."]);
  assert.equal(calls.length, before);
});

test("over ssh://, msb is BB Box's own in the user's home there, and a terminal asks ssh for a PTY", () => {
  const cli = new MsbCli("ssh://box@msb.example.com:2222", null, undefined, { ssh: "ssh" });
  assert.deepEqual(cli.argv(["exec", "--stream", "bbbox-bx1", "--", "echo", "it's"]), [
    "ssh", "-o", "BatchMode=yes", "-T", "-l", "box", "-p", "2222", "--", "msb.example.com",
    `exec "$HOME/.local/share/bb-box/microsandbox/bin/msb" 'exec' '--stream' 'bbbox-bx1' '--' 'echo' 'it'\\''s'`,
  ]);
  assert.equal(cli.argv(["ls"], { tty: true })[3], "-tt");
});

test("reads the status script's facts", () => {
  const facts = parseFacts("pinned=0.7.7\ninstalled=0.7.7\nos=Linux\narch=x86_64\ncpus=16\nmemory_kib=97656976\nkvm=ok\nlxc=0\nfree_kib=781955776\nused_kib=85956\nreflink=0\ndocker=29.1.3\ndir=/x\n");
  assert.deepEqual([facts.installed, facts.cpus, facts.memoryMiB, facts.kvm, facts.lxc, facts.freeGiB, facts.usedGiB, facts.docker], ["0.7.7", 16, 95368, "ok", false, 745.7, 0.1, "29.1.3"]);
});

test("each boot sets the guest's page reporting to its smallest blocks, gives the box user TUN (#595), and the upkeep has each running, idle box of this install give its page cache back (053)", async () => {
  const { fake, backend, make } = setup();
  const mine = await backend.acquire(identity(), null, hooks().hooks, signal());
  const stopped = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.stop!(stopped);
  const theirs = await make("other").acquire(identity(), null, hooks().hooks, signal());
  const launch = fake.calls().find((call) => call[0] === "exec" && call.some((arg) => arg.includes("bb-box-start")))!;
  assert.ok(launch.at(-1)!.startsWith(`${RUN_IN_MEMORY}; ${OWN_HOSTNAME}; `), "first /run in memory and the box's hostname, which a restored box lacks (070 unit 10)");
  assert.match(launch.at(-1)!, /; echo 0 >\/sys\/module\/page_reporting\/parameters\/page_reporting_order 2>\/dev\/null; /);
  assert.match(launch.at(-1)!, /; chmod 0666 \/dev\/net\/tun 2>\/dev\/null; \[ -e \/run\/bb-box-started \]/, "the box user may open TUN (#595)");
  await backend.maintain(signal());
  const { readFileSync } = await import("node:fs");
  assert.deepEqual(readFileSync(join(fake.root, "reclaims"), "utf8").trim().split("\n"), [mine.ref], "not a stopped box, nor another install's");
  assert.ok(!readFileSync(join(fake.root, "reclaims"), "utf8").includes(theirs.ref));
  const reclaim = fake.calls().find((call) => call[0] === "exec" && call.some((arg) => arg.includes("drop_caches")))!;
  assert.ok(!reclaim.includes("-u"), "as root");
});

test("the reclaim drops caches and compacts only in a box whose load is under half its cores, with more than 256 MiB cached", async () => {
  const { RECLAIM } = await import("../src/backends/microsandbox/backend.ts");
  const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
  const { execFileSync } = await import("node:child_process");
  const dir = (await import("./helpers.ts")).tempDir("reclaim");
  mkdirSync(join(dir, "vm"));
  const script = RECLAIM.replaceAll("/proc/loadavg", join(dir, "loadavg")).replaceAll("/proc/meminfo", join(dir, "meminfo")).replaceAll("/proc/sys/vm/", `${join(dir, "vm")}/`).replace("sync;", ":;");
  const run = (load: string, cachedKiB: number) => {
    writeFileSync(join(dir, "loadavg"), `${load} 0.10 0.05 1/100 1234\n`);
    writeFileSync(join(dir, "meminfo"), `MemTotal: 4035404 kB\nCached: ${cachedKiB} kB\n`);
    writeFileSync(join(dir, "vm", "drop_caches"), "");
    const out = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    return [out.trim(), readFileSync(join(dir, "vm", "drop_caches"), "utf8").trim()];
  };
  assert.deepEqual(run("0.12", 1_600_000), ["reclaimed_kib=1600000", "3"]);
  const busy = String(Number(execFileSync("nproc", { encoding: "utf8" })) / 2 + 0.1);
  assert.deepEqual(run(busy, 1_600_000), ["", ""], "a busy box keeps its cache");
  assert.deepEqual(run("0.02", 100_000), ["", ""], "a small cache stays");
});

test("on a host without Docker, the nightly refresh's image operations build with BB's app in a builder, check a trial box, put the build under the image's name, and wait when the volume msb builds on is short (053)", async () => {
  const { fake, backend } = setup();
  fake.facts({ os: "Darwin", arch: "arm64", mkfs: "0", docker: "" });
  const images = backend.images!;
  const { builds, boxes } = await images.list(signal());
  assert.deepEqual(builds.map((one) => [one.ref, one.kind, one.image, one.current]), [["bbbox/linux:1-arm64", "linux-arm64", "standard", true], ["bbbox/linux-desktop:1-arm64", "linux-arm64-desktop-cpu", "standard", true]]);
  assert.deepEqual(boxes, []);
  assert.equal(images.startsFrom, undefined, "no project images on microsandbox yet");
  assert.match(images.check!("linux-arm64"), /docker on first use/);

  // The build: in a builder, from the refresh's setup/, with BB's app, under a tag of its own.
  const lines: string[] = [];
  const setupCopy = (await import("./helpers.ts")).tempDir("refresh-setup");
  const made = await images.build!(builds[0]!, setupCopy, { bbUrl: "https://bb.example.com", log: (line) => lines.push(line), signal: signal() });
  assert.match(made.ref, /^bbbox\/linux:1-arm64-b[a-z0-9]+$/);
  assert.equal(made.current, false);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /build\.sh --arch arm64 --bb-url \S*https:\/\/bb\.example\.com\S* --tag bbbox\/linux:1-arm64-b[a-z0-9]+ linux /);
  assert.ok(fake.images()[made.ref]);
  assert.ok(fake.images()["bbbox/linux:1-arm64"]);

  // A trial box of it, as a box of its kind, which no sweep takes.
  const trial = await images.box(made, "trial of a build", signal());
  assert.match(trial.ref, /^bbbox-image-[0-9a-f]{12}$/);
  const created = fake.calls().find((call) => call[0] === "create" && call.includes(trial.ref))!;
  assert.equal(created[1], made.ref);
  assert.ok(after(created, "--label").includes("bbbox.image-box=test"));
  assert.equal((await trial.command.run("echo hi")).stdout, "hi\n");
  assert.deepEqual((await backend.held()).map((held) => held.ref), []);
  assert.deepEqual((await images.list(signal())).boxes, [trial.ref]);
  await images.remove(trial.ref, signal());
  assert.ok(!fake.sandboxes().includes(trial.ref));

  const replaced = await images.replace(made, builds[0]!, signal());
  assert.deepEqual([replaced.ref, replaced.current], ["bbbox/linux:1-arm64", true]);
  assert.ok(fake.images()[made.ref]);
  assert.ok(!fake.images()["bbbox/linux:1-arm64"]);
  assert.equal(JSON.parse(fake.images()[made.ref]!["bbbox.image-record"]!).build, "build.builder");
  assert.ok(!fake.scripts.some(([name]) => name === "retag"));
  await assert.rejects(images.remove("bbbox/linux:1-arm64", signal()), /is not a refresh's build, so BB Box leaves it/);
  await assert.rejects(images.remove(made.ref, signal()), /is not a refresh's build, so BB Box leaves it/);

  const baselineTrial = await images.box(replaced, "after replace", signal());
  const afterCreate = fake.calls().find((call) => call[0] === "create" && call.includes(baselineTrial.ref))!;
  assert.equal(afterCreate[1], made.ref);
  await images.remove(baselineTrial.ref, signal());

  // The upkeep's sweep of leftover builders leaves the one a refresh's build is using.
  fake.set({ holdBuild: true });
  const held = images.build!(builds[0]!, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  while (!fake.sandboxes().some((name) => name.startsWith("bb-box-builder-"))) await new Promise((resolve) => setTimeout(resolve, 20));
  await backend.maintain(signal());
  assert.ok(fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")), "the sweep left the refresh's builder");
  writeFileSync(join(fake.root, "release"), "");
  await images.remove((await held).ref, signal());
  assert.ok(!fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")));
  fake.set({ holdBuild: false });

  // A failed build says what the builder's msb log ended with, which goes with the builder.
  fake.set({ failBuild: true });
  const failed: string[] = [];
  await assert.rejects(images.build!(builds[0]!, setupCopy, { bbUrl: null, log: (line) => failed.push(line), signal: signal() }), /build\.sh failed in the builder with exit code 1.*The builder's kernel says: .*Out of memory: Killed process 812.*The builder's msb log ended: .*agent relay: client disconnected/);
  assert.ok(failed.some((line) => /^msb: .*unexpected EOF/.test(line)));
  assert.ok(failed.some((line) => /^guest: .*Out of memory/.test(line)));
  assert.ok(!fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")), "the builder is removed");
  fake.set({ failBuild: false });

  // Room: the volume msb keeps its images and build files on, through any link.
  assert.equal(await images.room!(builds[0]!, signal()), null);
  fake.facts({ free_kib: String(37 * 1024 * 1024) });
  assert.match((await images.room!(builds[0]!, signal())) ?? "", /has 37 GiB free where msb keeps its images and build files \(.+\), and BB Box builds an image there only with 80 GiB free/);
  await assert.rejects(images.build!(builds[0]!, "/nowhere", { bbUrl: null, log: () => {}, signal: signal() }), /only with 80 GiB free/);

  // On a host with Docker, msb's images follow Docker's, so the refresh builds none here.
  const linux = setup();
  assert.deepEqual((await linux.backend.images!.list(signal())).builds, []);
  assert.equal(await linux.backend.images!.room!(builds[0]!, signal()), null);
});

test("a microVM comes from its kind's image's current build until a refresh or an import brings a new one (049)", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(await backend.fromCurrentBuild!(guest, "linux"), true);
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(fake.root, "images.json"), JSON.stringify({ ...fake.images(), "bbbox/linux:1": imageLabels("linux", "build.newer") }));
  assert.equal(await backend.fromCurrentBuild!(guest, "linux"), false);
  assert.equal(await backend.fromCurrentBuild!({ ...guest, ref: "bbbox-gone" }, "linux"), null);
});

test("a microVM's root disk grows live with msb modify, and its CPUs and memory change with a restart, saved for its next start (061)", async () => {
  const { fake, backend } = setup();
  assert.deepEqual(backend.resizing("linux"), { cores: "restart", memory: "restart", disk: "live", shrinks: true });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const from = guest.size!;
  const disk = from.diskGiB!;
  const to = { cores: 4, memoryMiB: 8192, diskGiB: disk + 8 };
  const modifies = () => fake.calls().filter((args) => args[0] === "modify");

  const plan = await backend.planResize(guest, "linux", to, [], signal());
  assert.deepEqual(plan.parts.map((part) => [part.part, part.way]), [["cores", "restart"], ["memory", "restart"], ["disk", "live"]]);
  assert.equal(plan.downSeconds, 5);
  assert.equal(plan.room.ok, true);

  // The disk alone: live, with no stop.
  assert.equal((await backend.resize(guest, "linux", { ...from, diskGiB: disk + 8 }, { restart: false }, signal())).size?.diskGiB, disk + 8);
  assert.deepEqual(modifies().at(-1)!.slice(1, 4), [guest.ref, "--root-disk", `${disk + 8}G`]);
  assert.equal(fake.calls().filter((args) => args[0] === "stop").length, 0);

  await assert.rejects(backend.resize(guest, "linux", to, { restart: false }, signal()), /only with a restart/);
  const resized = await backend.resize(guest, "linux", to, { restart: true }, signal());
  assert.deepEqual(resized.size, to);
  assert.ok(modifies().some((args) => args.includes("--next-start") && args.includes("--cpus") && args.includes("4")), "saved for the next start");
  assert.equal(await backend.power(guest, signal()), "running");
  await assert.rejects(backend.planResize(guest, "linux", { ...to, diskGiB: disk }, [], signal()), /root disk only grows/);

  // A stopped box takes every change for its next start, with no restart.
  await backend.stop(guest, signal());
  const stopped = await backend.planResize(guest, "linux", { ...to, cores: 2 }, [], signal());
  assert.deepEqual(stopped.parts.map((part) => [part.part, part.way]), [["cores", "live"]]);
  assert.equal((await backend.resize(guest, "linux", { ...to, cores: 2 }, { restart: false }, signal())).size?.cores, 2);
  assert.equal(await backend.power(guest, signal()), "stopped");
});

test("a microVM that does not start at its new size gets its old CPUs and memory back (061)", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  fake.set({ failStart: "not enough memory" });
  await assert.rejects(backend.resize(guest, "linux", { ...guest.size!, memoryMiB: 8192 }, { restart: true }, signal()), /not enough memory/);
  fake.set({ failStart: null });
  await backend.start(guest, signal());
  assert.equal((await backend.planResize(guest, "linux", guest.size!, [], signal())).parts.length, 0, "back at the size it had");
});

const QUIET_SNAPSHOT: SnapshotHooks = { submitting: async () => {}, task: async () => {} };

test("unique build refs stay while a box or snapshot uses them, never use --force or prune, and go on maintain once free", async () => {
  const { fake, backend } = setup({}, { imported: false });

  const box1 = identity();
  const guest1 = await backend.acquire(box1, null, hooks().hooks, signal());
  const build1 = fake.inspect(guest1.ref).config.image.Oci.reference;
  assert.ok(isBuildOf(build1, "bbbox/linux:1"));
  assert.equal(fake.images()["bbbox/linux:1"], undefined);

  const snapshotId = "snaaaaaaaaaaaa";
  const taken = await backend.snapshot(guest1, { id: snapshotId, box: box1.boxId, memory: false, forkSafe: 7 }, QUIET_SNAPSHOT, signal());

  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.two") });
  await backend.maintain(signal());

  const guest2 = await backend.acquire(identity(), null, hooks().hooks, signal());
  const build2 = fake.inspect(guest2.ref).config.image.Oci.reference;
  assert.ok(isBuildOf(build2, "bbbox/linux:1"));
  assert.notEqual(build2, build1);
  assert.ok(fake.images()[build1]);
  assert.ok(fake.images()[build2]);
  assert.equal(await backend.fromCurrentBuild!(guest1, "linux"), false);
  assert.equal(await backend.fromCurrentBuild!(guest2, "linux"), true);

  const reportWithBoxAndSnap = await backend.doctor(signal());
  const cacheWithBoth = reportWithBoxAndSnap.checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(cacheWithBoth.status, "ok");
  assert.match(cacheWithBoth.detail, /Image cache takes 3 GiB\./);
  assert.match(cacheWithBoth.detail, new RegExp(`1 earlier build kept: ${build1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(used by box ${guest1.ref} and snapshot bbbox-${box1.boxId}:test-${snapshotId}-r7\\)\\.`));
  assert.match(cacheWithBoth.detail, /0 untagged manifests in msb\.db\./);

  await backend.release(guest1, releasing);
  await backend.maintain(signal());
  assert.ok(fake.images()[build1]);

  const reportWithSnapOnly = await backend.doctor(signal());
  const cacheWithSnap = reportWithSnapOnly.checks.find((check) => check.id === "microsandbox.images")!;
  assert.match(cacheWithSnap.detail, new RegExp(`used by snapshot bbbox-${box1.boxId}:test-${snapshotId}-r7\\)`));

  await backend.deleteSnapshot({ id: snapshotId, ref: taken.ref, guest: guest1 }, QUIET_SNAPSHOT, signal());
  await backend.maintain(signal());
  assert.ok(!fake.images()[build1]);
  assert.ok(fake.images()[build2]);

  const reportClean = await backend.doctor(signal());
  const cacheClean = reportClean.checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(cacheClean.status, "ok");
  assert.match(cacheClean.detail, /No earlier builds are kept\. 0 untagged manifests in msb\.db\./);

  assert.ok(!fake.calls().some((call) => call[0] === "image" && call[1] === "prune"));
  assert.ok(!fake.calls().some((call) => call[0] === "image" && call[1] === "remove" && call.includes("--force")));
});

test("a host holding only the bare configured image keeps working, migrates on the next import, and removes the bare tag once no box uses it", async () => {
  const { fake, context, backend } = setup();
  await context.storage.set("imported/bbbox/linux:1", "sha256:linux1");
  await context.storage.set("imported/bbbox/linux-desktop:1", "sha256:desktop1");

  const guest1 = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.inspect(guest1.ref).config.image.Oci.reference, "bbbox/linux:1");
  assert.equal(await backend.fromCurrentBuild!(guest1, "linux"), true);

  await backend.maintain(signal());
  assert.ok(fake.images()["bbbox/linux:1"]);
  assert.equal(fake.scripts.filter(([name]) => name === "import").length, 0);

  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.migrated") });
  await backend.maintain(signal());

  const guest2 = await backend.acquire(identity(), null, hooks().hooks, signal());
  const migratedRef = fake.inspect(guest2.ref).config.image.Oci.reference;
  assert.ok(isBuildOf(migratedRef, "bbbox/linux:1"));
  assert.ok(fake.images()["bbbox/linux:1"]);
  assert.equal(await backend.fromCurrentBuild!(guest1, "linux"), false);
  assert.equal(await backend.fromCurrentBuild!(guest2, "linux"), true);

  await backend.release(guest1, releasing);
  await backend.maintain(signal());
  assert.ok(!fake.images()["bbbox/linux:1"]);
  assert.ok(fake.images()[migratedRef]);
});

test("a refresh build stays protected while in flight, switches boxes on replace without retag, and removes the old build once boxes go", async () => {
  const { fake, backend } = setup();
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  const images = backend.images!;

  const beforeBox = await backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.equal(fake.inspect(beforeBox.ref).config.image.Oci.reference, "bbbox/linux:1-arm64");

  const current = (await images.list(signal())).builds.find((build) => build.kind === "linux-arm64")!;
  const setupCopy = (await import("./helpers.ts")).tempDir("refresh-flight");
  const candidate = await images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });

  await backend.maintain(signal());
  assert.ok(fake.images()[candidate.ref]);

  await images.replace(candidate, current, signal());
  assert.ok(!fake.scripts.some(([name]) => name === "retag"));
  assert.ok(fake.images()["bbbox/linux:1-arm64"]);

  const afterBox = await backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.equal(fake.inspect(afterBox.ref).config.image.Oci.reference, candidate.ref);

  await backend.release(beforeBox, releasing);
  await backend.maintain(signal());
  assert.ok(!fake.images()["bbbox/linux:1-arm64"]);
  assert.ok(fake.images()[candidate.ref]);
});

test("doctor image cache check handles absent sqlite3, pre-change untagged manifests, stale unheld builds, and release script validation", async () => {
  const { fake, backend } = setup({}, { imported: false });

  const guest1 = await backend.acquire(identity(), null, hooks().hooks, signal());
  const build1 = fake.inspect(guest1.ref).config.image.Oci.reference;
  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.two") });
  await backend.maintain(signal());

  fake.facts({ sqlite3: "0" });
  const noSqlite = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(noSqlite.status, "warn");
  assert.match(noSqlite.detail, /sqlite3 is not installed/);
  assert.match(noSqlite.detail, new RegExp(`1 earlier build kept: ${build1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(used by box ${guest1.ref}\\)`));
  assert.match(noSqlite.fix ?? "", /Install sqlite3/);

  fake.facts({ sqlite3: "1", untagged: "4" });
  const withUntagged = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(withUntagged.status, "ok");
  assert.match(withUntagged.detail, /4 untagged manifests in msb\.db from before unique build tags/);

  await backend.release(guest1, releasing);
  fake.facts({ untagged: "0" });
  const recentUnheld = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(recentUnheld.status, "ok");

  fake.set({ imageCreatedAt: { [build1]: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString() } });
  const staleUnheld = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(staleUnheld.status, "warn");
  assert.match(staleUnheld.fix ?? "", /Upkeep could not remove an earlier build/);

  fake.facts({ sqlite3: "0" });
  const staleAndNoSqlite = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(staleAndNoSqlite.status, "warn");
  assert.match(staleAndNoSqlite.fix ?? "", /Upkeep could not remove an earlier build/);
  assert.match(staleAndNoSqlite.fix ?? "", /Install sqlite3/);
  fake.facts({ sqlite3: "1" });

  const validId = "mwulbvjg3755a5";
  const digest = "a".repeat(64);
  assert.equal(buildImageRef("bbbox/linux:1-arm64", validId), `bbbox/linux:1-arm64-b${validId}`);
  assert.equal(buildImageRef("localhost:5000/bbbox/linux", validId), `localhost:5000/bbbox/linux:b${validId}`);
  assert.equal(buildImageRef(`org/linux@sha256:${digest}`, validId), `org/linux:b${validId}`);
  assert.equal(buildImageRef(`org/linux:1@sha256:${digest}`, validId), `org/linux:1-b${validId}`);
  assert.equal(isBuildOf(`bbbox/linux:1-arm64-b${validId}`, "bbbox/linux:1-arm64"), true);
  assert.equal(isBuildOf(`bbbox/linux:1-arm64-b${validId}`, "bbbox/linux:1"), false);
  assert.equal(isBuildOf(`org/linux:b${validId}`, `org/linux@sha256:${digest}`), true);
  assert.equal(isBuildOf("org/linux:beta", "org/linux"), false);
  assert.equal(isBuildOf("org/linux:base", "org/linux"), false);
  assert.equal(isBuildOf("org/linux:1-beta", "org/linux:1"), false);
  assert.equal(canonicalRepositoryOf("bbbox/linux:1"), "docker.io/bbbox/linux");
  assert.equal(canonicalRepositoryOf("linux:1"), "docker.io/library/linux");
  assert.equal(canonicalRepositoryOf("docker.io/probe:1"), "docker.io/library/probe");
  assert.equal(canonicalRepositoryOf("index.docker.io/probe:1"), "docker.io/library/probe");
  assert.equal(canonicalRepositoryOf("index.docker.io/bbbox/linux:1"), "docker.io/bbbox/linux");
  assert.equal(canonicalRepositoryOf("localhost:5000/bbbox/linux:1"), "localhost:5000/bbbox/linux");
  assert.equal(canonicalRepositoryOf(`ghcr.io/org/linux@sha256:${digest}`), "ghcr.io/org/linux");
  assert.equal(isRestoreDigestOf(`docker.io/bbbox/linux@sha256:${digest}`, "bbbox/linux:1"), true);
  assert.equal(isRestoreDigestOf(`docker.io/library/probe@sha256:${digest}`, "docker.io/probe:1"), true);
  assert.equal(isRestoreDigestOf(`docker.io/library/probe@sha256:${digest}`, "index.docker.io/probe:1"), true);
  assert.equal(isRestoreDigestOf(`org/linux@sha256:${digest}`, `org/linux@sha256:${digest}`), false);
  assert.equal(isRestoreDigestOf(`docker.io/bbbox/linux@sha256:${digest}`, `docker.io/bbbox/linux@sha256:${digest}`), false);
  assert.equal(isRestoreDigestOf(`docker.io/bbbox/other@sha256:${digest}`, "bbbox/linux:1"), false);
  assert.equal(scriptArgsOk("retag", ["bbbox/linux:refresh-1", "bbbox/linux:1"]), false);
  assert.equal(scriptArgsOk("import", ["bbbox/linux:1"]), false);
  assert.equal(scriptArgsOk("import", ["bbbox/linux:1", `bbbox/linux:1-b${validId}`]), true);
  assert.equal(scriptArgsOk("cache", []), true);
  assert.equal(scriptArgsOk("cache", ["extra"]), false);

  const parsed = parseImageCache("cache_kib=2048\ndb=1\nsqlite3=1\nuntagged=2\nsandbox:bbbox/linux:1-b1=bbbox-bx1\nsandbox:bbbox/linux:1-b1=bbbox-bx2\nsnapshot:bbbox/linux:1-b1=bbbox-bx1:s1\n");
  assert.equal(parsed.cacheKiB, 2048);
  assert.equal(parsed.db, true);
  assert.equal(parsed.sqlite3, true);
  assert.equal(parsed.untagged, 2);
  assert.deepEqual(parsed.sandboxesByRef.get("bbbox/linux:1-b1"), ["bbbox-bx1", "bbbox-bx2"]);
  assert.deepEqual(parsed.snapshotsByRef.get("bbbox/linux:1-b1"), ["bbbox-bx1:s1"]);

  const { execFileSync, spawnSync } = await import("node:child_process");
  const { chmodSync, mkdirSync } = await import("node:fs");
  assert.match(msbScript("cache"), /sqlite3 -readonly -cmd "\.timeout 5000"/);

  const msbDir = (await import("./helpers.ts")).tempDir("msb-cache-script");
  mkdirSync(join(msbDir, "home", "db"), { recursive: true });
  mkdirSync(join(msbDir, "home", "cache"), { recursive: true });
  mkdirSync(join(msbDir, "bin"), { recursive: true });
  writeFileSync(join(msbDir, "bin", "msb"), "#!/bin/sh\nexit 1\n");
  chmodSync(join(msbDir, "bin", "msb"), 0o755);
  const transferFail = spawnSync("sh", ["-c", msbScript("transfer"), "bb-box-msb", "bb-box-builder-1234", "bbbox/linux:1-bm"], {
    encoding: "utf8",
    env: { ...process.env, BBBOX_MSB_DIR: msbDir },
  });
  assert.equal(transferFail.status, 2);
  assert.match(transferFail.stderr, /Docker in builder bb-box-builder-1234 has no image bbbox\/linux:1-bm to transfer\./);

  const dbPath = join(msbDir, "home", "db", "msb.db");
  execFileSync("sqlite3", [
    dbPath,
    "CREATE TABLE manifest (id INTEGER PRIMARY KEY, digest TEXT);" +
      "CREATE TABLE image_ref (id INTEGER PRIMARY KEY, reference TEXT, manifest_id INTEGER);" +
      "CREATE TABLE sandbox (id INTEGER PRIMARY KEY, name TEXT);" +
      "CREATE TABLE sandbox_rootfs (id INTEGER PRIMARY KEY, sandbox_id INTEGER, manifest_id INTEGER);" +
      "CREATE TABLE snapshot_index (snapshot_id TEXT, group_name TEXT, name TEXT, image_manifest_digest TEXT);" +
      "INSERT INTO manifest VALUES (1, 'sha256:m1'), (2, 'sha256:m2');" +
      "INSERT INTO image_ref VALUES (1, 'bbbox/linux:1-b1', 1);" +
      "INSERT INTO sandbox VALUES (1, 'bbbox-bx1');" +
      "INSERT INTO sandbox_rootfs VALUES (1, 1, 1);" +
      "INSERT INTO snapshot_index VALUES ('snap_1', 'grp1', 's1', 'sha256:m1');",
  ]);
  const out = execFileSync("sh", ["-c", msbScript("cache")], { encoding: "utf8", env: { ...process.env, BBBOX_MSB_DIR: msbDir } });
  const scriptParsed = parseImageCache(out);
  assert.equal(scriptParsed.db, true);
  assert.equal(scriptParsed.sqlite3, true);
  assert.equal(scriptParsed.untagged, 1);
  assert.deepEqual(scriptParsed.sandboxesByRef.get("bbbox/linux:1-b1"), ["bbbox-bx1"]);
  assert.deepEqual(scriptParsed.snapshotsByRef.get("bbbox/linux:1-b1"), ["grp1:s1"]);
});

test("snapshot restore adds a canonical digest reference that doctor deduplicates by digest, keeps while current or used, and prunes once free", async () => {
  const { fake, backend } = setup({}, { imported: false });

  const box1 = identity();
  const guest1 = await backend.acquire(box1, null, hooks().hooks, signal());
  const build1 = fake.inspect(guest1.ref).config.image.Oci.reference;
  const snapId = "snbbbbbbbbbbbb";
  const taken = await backend.snapshot(guest1, { id: snapId, box: box1.boxId, memory: false, forkSafe: 7 }, QUIET_SNAPSHOT, signal());

  const forkedBox = identity();
  const forked = await backend.forkSnapshot({ id: snapId, ref: taken.ref, guest: guest1 }, forkedBox, null, hooks().hooks, signal());
  const restoreRef = Object.keys(fake.images()).find((ref) => isRestoreDigestOf(ref, "bbbox/linux:1"));
  assert.ok(restoreRef);

  await backend.maintain(signal());
  assert.ok(fake.images()[restoreRef]);

  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.two") });
  await backend.maintain(signal());
  assert.ok(fake.images()[build1]);
  assert.ok(fake.images()[restoreRef]);

  const docWhileHeld = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.equal(docWhileHeld.status, "ok");
  assert.match(docWhileHeld.detail, new RegExp(`1 earlier build kept: ${build1.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(`));
  assert.ok(!docWhileHeld.detail.includes(restoreRef));

  await backend.release(guest1, releasing);
  await backend.release(forked, releasing);
  await backend.deleteSnapshot({ id: snapId, ref: taken.ref, guest: guest1 }, QUIET_SNAPSHOT, signal());
  await backend.maintain(signal());

  assert.ok(!fake.images()[build1]);
  assert.ok(!fake.images()[restoreRef]);
  const docClean = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.match(docClean.detail, /No earlier builds are kept\./);
});

test("a bare host with no stored pointer keeps the bare image even if an unchecked refresh build exists after restart, and dead pointers repair or clear", async () => {
  const fake = fakeMsbHost();
  const storage = new MemoryStorage();
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  fake.docker.clear();
  const make = () => new MsbBackend(msbConfig(), testContext(storage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  const first = make();
  const current = (await first.images.list(signal())).builds.find((build) => build.kind === "linux-arm64")!;
  assert.equal(await storage.get("current/bbbox/linux:1-arm64"), "bbbox/linux:1-arm64");

  await storage.delete("current/bbbox/linux:1-arm64");
  const setupCopy = (await import("./helpers.ts")).tempDir("bare-restart");
  const candidate = await first.images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });

  const restarted = make();
  const box = await restarted.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.equal(fake.inspect(box.ref).config.image.Oci.reference, "bbbox/linux:1-arm64");
  assert.equal(await storage.get("current/bbbox/linux:1-arm64"), "bbbox/linux:1-arm64");

  await restarted.maintain(signal());
  assert.ok(!fake.images()[candidate.ref]);
  assert.ok(fake.images()["bbbox/linux:1-arm64"]);

  await storage.set("current/bbbox/linux:1-arm64", "bbbox/linux:1-arm64-bmissing00000000");
  await restarted.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.equal(await storage.get("current/bbbox/linux:1-arm64"), "bbbox/linux:1-arm64");

  const empty = fakeMsbHost({ imported: false });
  const emptyStorage = new MemoryStorage();
  await emptyStorage.set("current/bbbox/linux:1", "bbbox/linux:1-bmissing00000000");
  const emptyBackend = new MsbBackend(msbConfig(), testContext(emptyStorage, "test"), { dir: empty.dir, script: empty.script, readyTimeoutMs: 2_000 });
  await emptyBackend.doctor(signal());
  assert.equal(await emptyStorage.get("current/bbbox/linux:1"), undefined);
});

test("pointer moves serialize with prune so a finishing replace build is never removed, and acquires hold their image across msb create", async () => {
  const fake = fakeMsbHost();
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  fake.docker.clear();
  const baseStorage = new MemoryStorage();
  let readsToSkip = 0;
  let onPruneRead: (() => void) | null = null;
  let resumePrune: (() => void) | null = null;
  let replaceDone: Promise<unknown> | null = null;
  const hookedStorage = {
    get: async <T>(key: string): Promise<T | undefined> => {
      const value = await baseStorage.get<T>(key);
      if (key === "current/bbbox/linux:1-arm64" && onPruneRead) {
        if (readsToSkip > 0) {
          readsToSkip--;
        } else {
          const trigger = onPruneRead;
          onPruneRead = null;
          trigger();
          await new Promise<void>((resolve) => {
            resumePrune = resolve;
          });
        }
      }
      return value;
    },
    set: <T>(key: string, value: T) => baseStorage.set(key, value),
    delete: (key: string) => baseStorage.delete(key),
    list: (prefix?: string) => baseStorage.list(prefix),
  };
  const backend = new MsbBackend(msbConfig(), testContext(hookedStorage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  const current = (await backend.images.list(signal())).builds.find((build) => build.kind === "linux-arm64")!;
  const setupCopy = (await import("./helpers.ts")).tempDir("serial-prune");
  const candidate = await backend.images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });

  readsToSkip = 1;
  onPruneRead = () => {
    replaceDone = backend.images.replace(candidate, current, signal());
    setTimeout(() => resumePrune?.(), 30);
  };
  await Promise.all([backend.maintain(signal()), new Promise<void>((resolve) => setTimeout(resolve, 80)).then(() => replaceDone)]);
  assert.ok(replaceDone);
  await replaceDone;
  assert.ok(fake.images()[candidate.ref]);
  assert.equal(await baseStorage.get("current/bbbox/linux:1-arm64"), candidate.ref);

  const candidate2 = await backend.images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  fake.set({ holdCreate: true });
  let imageResolved!: () => void;
  const sawImage = new Promise<void>((resolve) => {
    imageResolved = resolve;
  });
  const acquireHooks: AcquireHooks = {
    claim: async () => {},
    starting: async () => {},
    timing: (step) => {
      if (step === "image") imageResolved();
    },
  };
  const acquiringBox = backend.acquire(identity("linux-arm64"), null, acquireHooks, signal());
  await sawImage;

  await backend.images.replace(candidate2, current, signal());
  assert.ok(fake.images()[candidate.ref]);

  writeFileSync(join(fake.root, "release-create"), "");
  fake.set({ holdCreate: false });
  const box = await acquiringBox;
  assert.equal(fake.inspect(box.ref).config.image.Oci.reference, candidate.ref);

  await backend.release(box, releasing);
  await backend.maintain(signal());
  assert.ok(!fake.images()[candidate.ref]);
  assert.ok(fake.images()[candidate2.ref]);
});

test("removeImage refuses configured images, active builds even without a stored pointer, overlapping configured refs, and reports msb refusals", async () => {
  const validId = "mwulbvjg3755a5";
  const overlapRef = `org/linux:b${validId}`;
  const fake = fakeMsbHost({ imported: false });
  const storage = new MemoryStorage();
  writeFileSync(join(fake.root, "images.json"), JSON.stringify({ [overlapRef]: imageLabels("linux", "build.one") }));
  const config = msbConfig({ "linux-image": "org/linux", "desktop-image": overlapRef });
  const backend = new MsbBackend(config, testContext(storage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  await assert.rejects(backend.images.remove(overlapRef, signal()), /is not a refresh's build/);

  const singleFake = fakeMsbHost({ imported: false });
  const activeRef = buildImageRef("bbbox/linux:1", validId);
  const oldRef = buildImageRef("bbbox/linux:1", "mwulbvjg3755a6");
  writeFileSync(join(singleFake.root, "images.json"), JSON.stringify({ [activeRef]: imageLabels("linux", "build.active") }));
  const singleStorage = new MemoryStorage();
  const singleBackend = new MsbBackend(msbConfig(), testContext(singleStorage, "test"), { dir: singleFake.dir, script: singleFake.script, readyTimeoutMs: 2_000 });

  await assert.rejects(singleBackend.images.remove(activeRef, signal()), /is not a refresh's build/);

  const box = await singleBackend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(singleFake.inspect(box.ref).config.image.Oci.reference, activeRef);
  writeFileSync(join(singleFake.root, "images.json"), JSON.stringify({ ...singleFake.images(), [oldRef]: imageLabels("linux", "build.next") }));
  await singleStorage.set("current/bbbox/linux:1", oldRef);
  await assert.rejects(singleBackend.images.remove(activeRef, signal()), /in use by sandbox/);
});

test("prune runs msb image remove outside the image lock so acquires do not stall or lose their ready deadline, and resolveImage skips builds being removed", async () => {
  const fake = fakeMsbHost({ imported: false });
  const storage = new MemoryStorage();
  const backend = new MsbBackend(msbConfig(), testContext(storage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  const guest1 = await backend.acquire(identity(), null, hooks().hooks, signal());
  const build1 = fake.inspect(guest1.ref).config.image.Oci.reference;
  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.two") });
  await backend.maintain(signal());
  const build2 = (await storage.get<string>("current/bbbox/linux:1"))!;
  assert.notEqual(build2, build1);
  await backend.release(guest1, releasing);

  fake.set({ holdImageRemove: true });
  const pruning = backend.maintain(signal());
  const entered = join(fake.root, "image-remove-entered");
  for (let i = 0; i < 200 && !existsSync(entered); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(existsSync(entered));

  const guest2 = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.inspect(guest2.ref).config.image.Oci.reference, build2);
  await backend.release(guest2, releasing);

  const remaining = { ...fake.images() };
  delete remaining[build2];
  writeFileSync(join(fake.root, "images.json"), JSON.stringify(remaining));
  await backend.doctor(signal());
  assert.equal(await storage.get("current/bbbox/linux:1"), undefined);

  writeFileSync(join(fake.root, "release-image-remove"), "");
  fake.set({ holdImageRemove: false });
  await pruning;
  assert.ok(!fake.images()[build1]);

  const slowFake = fakeMsbHost({ imported: false });
  const slowStorage = new MemoryStorage();
  const slowBackend = new MsbBackend(msbConfig(), testContext(slowStorage, "test"), {
    dir: slowFake.dir,
    readyTimeoutMs: 2_000,
    script: async (name, args) => {
      if (name === "import") await new Promise((resolve) => setTimeout(resolve, 1_300));
      return slowFake.script(name, args);
    },
  });
  await slowBackend.acquire(identity(), null, hooks().hooks, signal());
  const readyExec = slowFake.calls().find((call) => call[0] === "exec" && call.some((arg) => arg.includes("/run/bb-box/ready")));
  assert.ok(readyExec);
  const readyScript = readyExec.at(-1) ?? "";
  assert.match(readyScript, /"-le" 20|-le 20/);
});

test("candidate holds do not leak on failed removeImage or replaceImage, and removeImage refuses held builds", async () => {
  const fake = fakeMsbHost();
  fake.facts({ os: "Darwin", arch: "arm64", docker: "" });
  fake.docker.clear();
  const baseStorage = new MemoryStorage();
  let failImportedWrite = false;
  const hookedStorage = {
    get: <T>(key: string) => baseStorage.get<T>(key),
    set: async <T>(key: string, value: T) => {
      if (failImportedWrite && key === "imported/bbbox/linux:1-arm64") {
        failImportedWrite = false;
        throw new Error("storage full");
      }
      return baseStorage.set(key, value);
    },
    delete: (key: string) => baseStorage.delete(key),
    list: (prefix?: string) => baseStorage.list(prefix),
  };
  const backend = new MsbBackend(msbConfig(), testContext(hookedStorage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });
  const images = backend.images!;
  const current = (await images.list(signal())).builds.find((build) => build.kind === "linux-arm64")!;
  const setupCopy = (await import("./helpers.ts")).tempDir("candidate-leaks");

  const leakedCandidate = await images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  fake.set({ failImage: "connection lost" });
  await assert.rejects(images.remove(leakedCandidate.ref, signal()), /connection lost/);
  fake.set({ failImage: null });

  const docBeforeMaintain = (await backend.doctor(signal())).checks.find((check) => check.id === "microsandbox.images")!;
  assert.ok(docBeforeMaintain.detail.includes(leakedCandidate.ref));
  await backend.maintain(signal());
  assert.ok(!fake.images()[leakedCandidate.ref]);

  const candidate1 = await images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  failImportedWrite = true;
  await assert.rejects(images.replace(candidate1, current, signal()), /storage full/);
  assert.equal(await baseStorage.get("current/bbbox/linux:1-arm64"), candidate1.ref);
  await assert.rejects(images.remove(candidate1.ref, signal()), /is not a refresh's build/);

  const candidate2 = await images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  await images.replace(candidate2, current, signal());
  assert.ok(!fake.images()[candidate1.ref]);
  assert.ok(fake.images()[candidate2.ref]);

  const candidate3 = await images.build!(current, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  fake.set({ holdCreate: true });
  let sawImage!: () => void;
  const imageHeld = new Promise<void>((resolve) => {
    sawImage = resolve;
  });
  const acquirePromise = backend.acquire(
    identity("linux-arm64"),
    null,
    { claim: async () => {}, starting: async () => {}, timing: (step) => { if (step === "image") sawImage(); } },
    signal(),
  );
  await imageHeld;

  await images.replace(candidate3, current, signal());
  await assert.rejects(images.remove(candidate2.ref, signal()), /in use right now/);
  assert.ok(fake.images()[candidate2.ref]);

  writeFileSync(join(fake.root, "release-create"), "");
  fake.set({ holdCreate: false });
  const box = await acquirePromise;
  assert.equal(fake.inspect(box.ref).config.image.Oci.reference, candidate2.ref);
  await backend.release(box, releasing);
  await backend.maintain(signal());
  assert.ok(!fake.images()[candidate2.ref]);
});

test("doctor serializes resolveImage with import so a concurrent import pointer is never overwritten back to bare", async () => {
  const fake = fakeMsbHost();
  const baseStorage = new MemoryStorage();
  let triggerImportOnBareAdopt = true;
  let maintainPromise: Promise<void> | null = null;
  let pointerSetDuringPause!: () => void;
  const sawPointerSet = new Promise<void>((resolve) => {
    pointerSetDuringPause = resolve;
  });
  const hookedStorage = {
    get: <T>(key: string) => baseStorage.get<T>(key),
    set: async <T>(key: string, value: T) => {
      if (key === "current/bbbox/linux:1" && value === "bbbox/linux:1" && triggerImportOnBareAdopt) {
        triggerImportOnBareAdopt = false;
        fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.two") });
        maintainPromise = backend.maintain(signal());
        await Promise.race([sawPointerSet, new Promise<void>((resolve) => setTimeout(resolve, 1_500))]);
      }
      await baseStorage.set(key, value);
      if (key === "current/bbbox/linux:1" && typeof value === "string" && isBuildOf(value, "bbbox/linux:1")) {
        pointerSetDuringPause();
      }
    },
    delete: (key: string) => baseStorage.delete(key),
    list: (prefix?: string) => baseStorage.list(prefix),
  };
  const backend = new MsbBackend(msbConfig(), testContext(hookedStorage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  await backend.doctor(signal());
  assert.ok(maintainPromise);
  await maintainPromise;
  await backend.maintain(signal());

  const currentRef = await baseStorage.get<string>("current/bbbox/linux:1");
  assert.ok(currentRef && isBuildOf(currentRef, "bbbox/linux:1"), `expected new build ref, got ${String(currentRef)}`);
  assert.ok(fake.images()[currentRef]);
  assert.ok(!fake.images()["bbbox/linux:1"]);
});

test("two-segment docker.io restore references are pruned and restore references with unknown digest are protected", async () => {
  const fake = fakeMsbHost({ imported: false });
  fake.docker.set("docker.io/probe:1", { id: "sha256:probe1", labels: imageLabels("linux", "build.one") });
  const storage = new MemoryStorage();
  const backend = new MsbBackend(msbConfig({ "linux-image": "docker.io/probe:1" }), testContext(storage, "test"), { dir: fake.dir, script: fake.script, readyTimeoutMs: 2_000 });

  const box1 = identity();
  const guest1 = await backend.acquire(box1, null, hooks().hooks, signal());
  const build1 = fake.inspect(guest1.ref).config.image.Oci.reference;
  const snapId = "sncccccccccccc";
  const taken = await backend.snapshot(guest1, { id: snapId, box: box1.boxId, memory: false, forkSafe: 7 }, QUIET_SNAPSHOT, signal());
  const forked = await backend.forkSnapshot({ id: snapId, ref: taken.ref, guest: guest1 }, identity(), null, hooks().hooks, signal());
  const restoreRef = Object.keys(fake.images()).find((ref) => ref.startsWith("docker.io/library/probe@sha256:"));
  assert.ok(restoreRef);

  fake.docker.set("docker.io/probe:1", { id: "sha256:probe2", labels: imageLabels("linux", "build.two") });
  await backend.maintain(signal());
  await backend.release(guest1, releasing);
  await backend.release(forked, releasing);
  await backend.deleteSnapshot({ id: snapId, ref: taken.ref, guest: guest1 }, QUIET_SNAPSHOT, signal());

  fake.set({ emptyDigestRefs: [restoreRef] });
  await backend.maintain(signal());
  assert.ok(!fake.images()[build1]);
  assert.ok(fake.images()[restoreRef]);

  fake.set({ emptyDigestRefs: [] });
  await backend.maintain(signal());
  assert.ok(!fake.images()[restoreRef]);
});

test("project images build, replace and prune old builds without touching standard, holding builds used by a box until release and maintain", async () => {
  assert.equal(projectImageBase("conformance", "linux"), "bbbox-image/conformance:linux");
  assert.equal(projectImageBase("standard", "linux"), null);
  assert.deepEqual(
    parseProjectImageBuild("bbbox-image/conformance:linux-bmwulbvjg3755a5", ["linux", "linux-desktop-cpu"]),
    { image: "conformance", kind: "linux", base: "bbbox-image/conformance:linux" },
  );
  assert.equal(parseProjectImageBuild("bbbox/linux:1-bmwulbvjg3755a5", ["linux"]), null);

  const { fake, backend } = setup();
  const images = backend.images;
  const setupCopy = (await import("./helpers.ts")).tempDir("msb-project-replace");
  const target = { ref: "", image: "conformance", kind: "linux", build: null, record: null, current: false };

  const first = await images.build!(target, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  const second = await images.build!(target, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  assert.equal((await images.list(signal())).builds.some((build) => build.ref === first.ref && build.image === "conformance"), true);
  assert.equal((await images.list(signal())).builds.some((build) => build.ref === second.ref && build.image === "conformance"), true);

  const replacedFirst = await images.replace(second, first, signal());
  assert.deepEqual([replacedFirst.ref, replacedFirst.image, replacedFirst.current], [second.ref, "conformance", false]);
  assert.equal((await images.list(signal())).builds.some((build) => build.ref === first.ref), false);
  await assert.rejects(images.box(first, "gone", signal()));

  const holder = await images.box(second, "holder", signal());
  const third = await images.build!(target, setupCopy, { bbUrl: null, log: () => {}, signal: signal() });
  await images.replace(third, second, signal());

  assert.equal((await images.list(signal())).builds.some((build) => build.ref === second.ref), true);
  await backend.maintain(signal());
  assert.equal((await images.list(signal())).builds.some((build) => build.ref === second.ref), true);

  await images.remove(holder.ref, signal());
  await backend.maintain(signal());

  assert.equal((await images.list(signal())).builds.some((build) => build.ref === second.ref), false);
  await assert.rejects(images.box(second, "gone after release", signal()));
  const standardRef = Object.keys(fake.images()).find((ref) => ref === "bbbox/linux:1" || isBuildOf(ref, "bbbox/linux:1"));
  assert.ok(standardRef, "the standard image stays");
  assert.equal(JSON.parse(fake.images()[standardRef]!["bbbox.image-record"]!).build, "build.fake");

  await images.remove(third.ref, signal());
  assert.deepEqual((await images.list(signal())).builds, []);
});
