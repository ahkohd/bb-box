// The microsandbox backend (053) against a fake msb host (fake-msb.ts).

import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dockerKinds } from "../src/backends/docker/backend.ts";
import { offerChecks } from "../src/backends/index.ts";
import { BUILDER_IMAGE, MsbBackend, msbKinds, parseFacts, sandboxName } from "../src/backends/microsandbox/backend.ts";
import { MsbCli } from "../src/backends/microsandbox/cli.ts";
import { parseMsbPart } from "../src/backends/microsandbox/config.ts";
import { microsandboxDriver } from "../src/backends/microsandbox/index.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type MachineSize, type FieldValue, type Guest, type MachineAccess, type ReleaseHooks } from "../src/backends/types.ts";
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
    ["--hostname", "--cpus", "--memory", "--root-disk", "--tmpfs", "--net", "--pull", "--mount-disk"].map((flag) => after(create, flag)[0]),
    [box.name, "2", "4096M", "32G", "/run", "public,private", "never", `${fake.dir}/disks/${guest.ref}.ext4:/var/lib/docker`],
  );
  assert.deepEqual(after(create, "--env"), [`BBBOX_IDENTITY=${box.boxId}`, "BBBOX_DOCKERD=1"], "the value its identity marker holds, set on the guest by bb-box (070)");
  assert.deepEqual(fake.scripts.find(([name]) => name === "disk"), ["disk", guest.ref, "64"], "bb-box makes the box's Docker disk, at the configured size");
  assert.ok(!create.includes("--replace"));
  const quiet = setup({ docker: false });
  const small = identity("linux", { cores: 1, memoryMiB: 2048, diskGiB: 8 });
  await quiet.backend.acquire(small, null, hooks().hooks, signal());
  const plain = quiet.fake.calls().find((call) => call[0] === "create")!;
  assert.deepEqual([after(plain, "--mount-owned"), after(plain, "--mount-disk"), after(plain, "--env"), after(plain, "--root-disk")[0]], [[], [], [`BBBOX_IDENTITY=${small.boxId}`], "8G"]);
});

test("a box's Docker disk goes with the box, a host without mkfs.ext4 gets msb's own until bb-box has made a template to clone, and the upkeep removes old disks no microVM has", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const disk = join(fake.dir, "disks", `${guest.ref}.ext4`);
  assert.ok(existsSync(disk));
  await backend.release(guest, releasing);
  assert.ok(!existsSync(disk), "released with the box");

  // An acquire that fails after the disk is made removes it.
  fake.set({ neverReady: true });
  const failed = identity();
  await assert.rejects(backend.acquire(failed, null, hooks().hooks, signal()), /was not ready/);
  assert.ok(!existsSync(join(fake.dir, "disks", `${sandboxName(failed.boxId)}.ext4`)));
  fake.set({ neverReady: false });

  // A leftover: old, with no microVM of its name. A new one and a box's own stay.
  const kept = await backend.acquire(identity(), null, hooks().hooks, signal());
  const { utimesSync, writeFileSync } = await import("node:fs");
  const old = join(fake.dir, "disks", "bbbox-bxleftover.ext4");
  writeFileSync(old, "");
  const hourAgo = new Date(Date.now() - 3600_000);
  utimesSync(old, hourAgo, hourAgo);
  utimesSync(join(fake.dir, "disks", `${kept.ref}.ext4`), hourAgo, hourAgo);
  writeFileSync(join(fake.dir, "disks", "bbbox-bxmaking.ext4"), "");
  await backend.maintain(signal());
  assert.deepEqual(readdirSync(join(fake.dir, "disks")).sort(), [`${kept.ref}.ext4`, "bbbox-bxmaking.ext4"].sort());

  // A host without mkfs.ext4, as a Mac: msb's own disk until bb-box has made its template, then a clone of it.
  const plain = setup();
  plain.fake.facts({ mkfs: "0" });
  const before = await plain.backend.doctor(signal());
  assert.equal(before.checks.find((check) => check.id === "microsandbox.disks")?.status, "warn");
  const first = await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(after(plain.fake.calls().find((call) => call[0] === "create" && call.includes(first.ref))!, "--mount-owned"), ["/var/lib/docker:kind=disk,size=64G"]);
  for (let i = 0; i < 200 && !existsSync(join(plain.fake.dir, "templates", "docker-64G.ext4")); i++) await new Promise((r) => setTimeout(r, 25));
  const helper = plain.fake.calls().find((call) => call[0] === "create" && after(call, "--name")[0]?.startsWith("bb-box-mkfs-"))!;
  assert.deepEqual([helper[1], after(helper, "--mount-dir")[0]], [BUILDER_IMAGE, `${plain.fake.dir}/templates:/work:quota=65G`]);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(plain.fake.root, "mkfs"), "utf8"), /mkfs\.ext4 -q -F -E lazy_itable_init=1,lazy_journal_init=1 \/work\/docker-64G\.ext4\.new/);
  for (let i = 0; i < 100 && plain.fake.sandboxes().some((name) => name.startsWith("bb-box-mkfs-")); i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(!plain.fake.sandboxes().some((name) => name.startsWith("bb-box-mkfs-")), "the helper goes");
  const second = await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(after(plain.fake.calls().find((call) => call[0] === "create" && call.includes(second.ref))!, "--mount-disk"), [`${plain.fake.dir}/disks/${second.ref}.ext4:/var/lib/docker`]);
  assert.equal(readFileSync(join(plain.fake.dir, "disks", `${second.ref}.ext4`), "utf8"), "template", "a clone of the template");
  const report = await plain.backend.doctor(signal());
  assert.match(report.checks.find((check) => check.id === "microsandbox.disks")?.detail ?? "", /Each box's Docker disk is a clone of bb-box's template, docker-64G\.ext4/);
});

test("installs msb on a host that lacks it, once, and imports a kind's image from Docker when msb lacks it, and again when Docker's changes", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.facts({ installed: "" });
  await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(fake.scripts.filter(([name]) => name === "install"), [["install"]]);
  assert.deepEqual(fake.scripts.filter(([name]) => name === "import"), [["import", "bbbox/linux:1"]], "imported once, for the first box");
  assert.deepEqual(Object.keys(fake.images()), ["bbbox/linux:1"]);

  // The upkeep imports the desktop image, and the linux image again once Docker's build is new.
  await backend.maintain(signal());
  assert.deepEqual(fake.scripts.filter(([name]) => name === "import").length, 2);
  fake.docker.set("bbbox/linux:1", { id: "sha256:linux2", labels: imageLabels("linux", "build.next") });
  await backend.maintain(signal());
  assert.deepEqual(fake.scripts.filter(([name]) => name === "import").map(([, image]) => image), ["bbbox/linux:1", "bbbox/linux-desktop:1", "bbbox/linux:1"]);
  await backend.maintain(signal());
  assert.equal(fake.scripts.filter(([name]) => name === "import").length, 3, "nothing new, nothing imported");
});

test("a kind whose image neither msb nor Docker has is refused for now, and bb-box builds the image in a builder microVM, pulling only Docker's own, pinned, and removes the builder (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.docker.delete("bbbox/linux:1");
  await assert.rejects(
    backend.acquire(identity(), null, hooks().hooks, signal()),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /has no image bbbox\/linux:1 yet\. bb-box is building it there in a microVM/.test(error.message),
  );
  for (let i = 0; i < 200 && !fake.images()["bbbox/linux:1"]; i++) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fake.images()["bbbox/linux:1"], "built and moved into msb");
  const builder = fake.calls().find((call) => call[0] === "create" && call.includes("--name") && after(call, "--name")[0]!.startsWith("bb-box-builder-"))!;
  assert.equal(builder[1], BUILDER_IMAGE);
  assert.match(BUILDER_IMAGE, /^docker:[\w.-]+-dind@sha256:[0-9a-f]{64}$/, "by digest");
  const { readFileSync } = await import("node:fs");
  const steps = readFileSync(join(fake.root, "builder"), "utf8");
  assert.match(steps, /nohup dockerd >\/var\/log\/dockerd\.log 2>&1 <\/dev\/null &/);
  assert.match(steps, /base64 -d \| tar -xz -C \/build/);
  assert.match(steps, /bash setup\/docker\/build\.sh --arch x86_64 --tag bbbox\/linux:1 linux /);
  assert.ok(fake.scripts.some(([name, , image]) => name === "transfer" && image === "bbbox/linux:1"));
  for (let i = 0; i < 100 && fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")); i++) await new Promise((r) => setTimeout(r, 25));
  assert.deepEqual(fake.sandboxes(), [], "the builder is removed, and no box was made");
  assert.ok(!fake.calls().some((call) => call[0] === "pull"));
  // The next box starts from the built image.
  await backend.acquire(identity(), null, hooks().hooks, signal());
});

test("on a Mac, the backend offers the arm64 kinds, checks the Hypervisor framework, builds there for arm64, and leaves the reclaim alone (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.facts({ os: "Darwin", arch: "arm64", mkfs: "0", docker: "" });
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
  assert.match(by["image.bbbox/linux:1-arm64"]!.fix ?? "", /bb-box builds it there in a microVM of its own/);
  assert.equal(by["image.bbbox/linux:1"], undefined, "no x86_64 image on an arm64 host");
  await assert.rejects(backend.acquire(identity("linux"), null, hooks().hooks, signal()), /does not offer linux boxes/);
  await assert.rejects(backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal()), /bb-box is building it there/);
  for (let i = 0; i < 200 && !fake.images()["bbbox/linux:1-arm64"]; i++) await new Promise((r) => setTimeout(r, 25));
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /nohup sh -c .*build\.sh --arch arm64.*echo \$\? >\/build\/build\.exit/, "detached, as a heavy build has ended msb's exec session");
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /cat \/build\/build\.exit/);
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /build\.sh --arch arm64 --tag bbbox\/linux:1-arm64 linux /);
  // The builder goes in the background after its image is in msb: the next box waits for that, so no fake reads a sandbox as it is removed.
  for (let i = 0; i < 200 && fake.sandboxes().some((name) => name.startsWith("bb-box-builder-")); i++) await new Promise((r) => setTimeout(r, 25));
  const box = await backend.acquire(identity("linux-arm64"), null, hooks().hooks, signal());
  assert.deepEqual(after(fake.calls().find((call) => call[0] === "create" && call.includes(box.ref))!, "--mount-owned"), ["/var/lib/docker:kind=disk,size=64G"], "msb's own disk, as a Mac has no mkfs.ext4");
  await backend.maintain(signal());
  assert.ok(!fake.calls().some((call) => call[0] === "exec" && call.some((arg) => arg.includes("drop_caches"))), "a Mac keeps what a guest has used, so no reclaim");
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
  assert.match(stopped.message ?? "", /has 3 of the 3 bb-box microVMs it may have, counting stopped boxes/);
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
  assert.match(ceiling.message ?? "", /the boxes on .+ may have 24 GiB of memory in all, at a memory overcommit of 2, and have 24 GiB, so a box with 4 GiB does not fit\. Ask for less memory, release a box, or raise the memory overcommit in bb-box's settings/);

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
  assert.match(check?.detail ?? "", /is a Mac, which keeps the memory a box has used, so bb-box counts each box there at its full size, whatever the memory overcommit of 2\./);
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
  // A stand-in /proc: a bb-box microVM, another sandbox's, one already raised, and another process.
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
  assert.deepEqual(report.checks.map((check) => check.id).filter((id) => id !== "microsandbox.sizes"), ["microsandbox.host", "microsandbox.msb", "microsandbox.kvm", "image.bbbox/linux:1", "image.bbbox/linux-desktop:1", "microsandbox.capacity"]);
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
  assert.match(by["microsandbox.msb"]!.fix ?? "", /bb-box installs msb 0\.7\.7 there, checked by its SHA-256/);
});

test("the doctor says which images bb-box imports from Docker, and which it builds itself (053)", async () => {
  const { fake, backend } = setup({}, { imported: false });
  // Before msb is installed too: Docker alone says what bb-box can import.
  fake.facts({ installed: "" });
  fake.docker.delete("bbbox/linux-desktop:1");
  const report = await backend.doctor(signal());
  const by = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(by["image.bbbox/linux:1"]!.status, "warn");
  assert.match(by["image.bbbox/linux:1"]!.fix ?? "", /bb-box imports it from Docker with the first linux box/);
  assert.equal(by["image.bbbox/linux-desktop:1"]!.status, "warn");
  assert.match(by["image.bbbox/linux-desktop:1"]!.fix ?? "", /bb-box builds it there in a microVM of its own, about 10 minutes, with the first linux-desktop-cpu box/);
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

test("on a BB machine, msb runs through bb-box's msb relay, and an offline machine takes no box and runs nothing (053)", async () => {
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

test("over ssh://, msb is bb-box's own in the user's home there, and a terminal asks ssh for a PTY", () => {
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
  assert.match(launch.at(-1)!, /^echo 0 >\/sys\/module\/page_reporting\/parameters\/page_reporting_order 2>\/dev\/null; /);
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
  assert.match(made.ref, /^bbbox\/linux:refresh-[a-z0-9]+$/);
  assert.equal(made.current, false);
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync(join(fake.root, "builder"), "utf8"), /build\.sh --arch arm64 --bb-url \S*https:\/\/bb\.example\.com\S* --tag bbbox\/linux:refresh-[a-z0-9]+ linux /);
  assert.ok(fake.images()[made.ref], "the build is in msb under its own tag");
  assert.ok(fake.images()["bbbox/linux:1-arm64"], "and the image stays until the build passes");

  // A trial box of it, as a box of its kind, which no sweep takes.
  const trial = await images.box(made, "trial of a build", signal());
  assert.match(trial.ref, /^bbbox-image-[0-9a-f]{12}$/);
  const created = fake.calls().find((call) => call[0] === "create" && call.includes(trial.ref))!;
  assert.equal(created[1], made.ref);
  assert.ok(after(created, "--label").includes("bbbox.image-box=test"));
  assert.equal((await trial.command.run("echo hi")).stdout, "hi\n");
  assert.deepEqual((await backend.held()).map((held) => held.ref), [], "not a box");
  assert.deepEqual((await images.list(signal())).boxes, [trial.ref]);
  await images.remove(trial.ref, signal());
  assert.ok(!fake.sandboxes().includes(trial.ref));

  // The build replaces the image: under the image's name, and its own tag goes.
  const replaced = await images.replace(made, builds[0]!, signal());
  assert.deepEqual([replaced.ref, replaced.current], ["bbbox/linux:1-arm64", true]);
  assert.ok(!fake.images()[made.ref]);
  assert.equal(JSON.parse(fake.images()["bbbox/linux:1-arm64"]!["bbbox.image-record"]!).build, "build.builder");
  await assert.rejects(images.remove("bbbox/linux:1-arm64", signal()), /is not a refresh's build, so bb-box leaves it/);

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
  assert.match((await images.room!(builds[0]!, signal())) ?? "", /has 37 GiB free where msb keeps its images and build files \(.+\), and bb-box builds an image there only with 80 GiB free/);
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
