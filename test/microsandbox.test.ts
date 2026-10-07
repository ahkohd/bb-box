// The microsandbox backend (053) against a fake msb host (fake-msb.ts).

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { dockerKinds } from "../src/backends/docker/backend.ts";
import { offerChecks } from "../src/backends/index.ts";
import { MsbBackend, msbKinds, parseFacts, sandboxName } from "../src/backends/microsandbox/backend.ts";
import { MsbCli } from "../src/backends/microsandbox/cli.ts";
import { parseMsbPart } from "../src/backends/microsandbox/config.ts";
import { microsandboxDriver } from "../src/backends/microsandbox/index.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type FieldValue, type Guest, type MachineAccess, type ReleaseHooks } from "../src/backends/types.ts";
import { dockerConfig } from "./fake-docker.ts";
import { fakeMsbHost, imageLabels, msbConfig } from "./fake-msb.ts";
import { MemoryStorage, testContext } from "./helpers.ts";

const SMALL: BoxSize = { cores: 2, memoryMiB: 4096, diskGiB: null };

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
  return { boxId: `bx${String(counter).padStart(12, "0")}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size };
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
    images: { linux: "bbbox/linux:1", "linux-desktop-cpu": "bbbox/linux-desktop:1" },
    docker: true,
    dockerDiskGiB: 64,
    diskGiB: 32,
    network: "public,private",
    boxes: 20,
    reserveMemoryMiB: 4096,
  });
  assert.equal(msbConfig({ host: "bb:host_abc123" }).machine, "host_abc123");
  const bad = parseMsbPart({ id: "microsandbox", hosts: [], fields: { host: "tcp://x:1", "linux-image": "a b", network: "public,lan", boxes: 0, "disk-gib": 2 } });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.ok ? [] : bad.problems.map((problem) => problem.path).sort(), ["boxes", "disk-gib", "host", "linux-image", "network"]);
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
    ["--hostname", "--cpus", "--memory", "--root-disk", "--tmpfs", "--net", "--pull", "--mount-disk", "--env"].map((flag) => after(create, flag)[0]),
    [box.name, "2", "4096M", "32G", "/run", "public,private", "never", `${fake.dir}/disks/${guest.ref}.ext4:/var/lib/docker`, "BBBOX_DOCKERD=1"],
  );
  assert.deepEqual(fake.scripts.find(([name]) => name === "disk"), ["disk", guest.ref, "64"], "bb-box makes the box's Docker disk, at the configured size");
  assert.ok(!create.includes("--replace"));
  const quiet = setup({ docker: false });
  await quiet.backend.acquire(identity("linux", { cores: 1, memoryMiB: 2048, diskGiB: 8 }), null, hooks().hooks, signal());
  const plain = quiet.fake.calls().find((call) => call[0] === "create")!;
  assert.deepEqual([after(plain, "--mount-owned"), after(plain, "--mount-disk"), after(plain, "--env"), after(plain, "--root-disk")[0]], [[], [], [], "8G"]);
});

test("a box's Docker disk goes with the box, a host without mkfs.ext4 gets msb's own, and the upkeep removes old disks no microVM has", async () => {
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

  fake.facts({ mkfs: "0" });
  const plain = setup();
  plain.fake.facts({ mkfs: "0" });
  await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(after(plain.fake.calls().find((call) => call[0] === "create")!, "--mount-owned"), ["/var/lib/docker:kind=disk,size=64G"]);
  const report = await plain.backend.doctor(signal());
  assert.match(report.checks.find((check) => check.id === "microsandbox.disks")?.detail ?? "", /has no mkfs\.ext4, so msb formats each box's Docker disk whole/);
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

test("refuses a kind whose image neither msb nor Docker has, without pulling it, and leaves nothing", async () => {
  const { fake, backend } = setup({}, { imported: false });
  fake.docker.delete("bbbox/linux:1");
  await assert.rejects(backend.acquire(identity(), null, hooks().hooks, signal()), /has no image bbbox\/linux:1, in msb or in Docker, and bb-box never pulls one\. Build it there with setup\/docker\/build\.sh/);
  assert.deepEqual(fake.sandboxes(), []);
  assert.ok(!fake.calls().some((call) => call[0] === "pull"));
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

test("the doctor says which images bb-box imports from Docker, and fails for one Docker lacks too", async () => {
  const { fake, backend } = setup({}, { imported: false });
  // Before msb is installed too: Docker alone says what bb-box can import.
  fake.facts({ installed: "" });
  fake.docker.delete("bbbox/linux-desktop:1");
  const report = await backend.doctor(signal());
  const by = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(by["image.bbbox/linux:1"]!.status, "warn");
  assert.match(by["image.bbbox/linux:1"]!.fix ?? "", /bb-box imports it from Docker with the first linux box/);
  assert.equal(by["image.bbbox/linux-desktop:1"]!.status, "fail");
  assert.match(by["image.bbbox/linux-desktop:1"]!.fix ?? "", /Build it on the host with setup\/docker\/build\.sh/);
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

test("each boot sets the guest's page reporting to its smallest blocks, and the upkeep has each running, idle box of this install give its page cache back (053)", async () => {
  const { fake, backend, make } = setup();
  const mine = await backend.acquire(identity(), null, hooks().hooks, signal());
  const stopped = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.stop!(stopped);
  const theirs = await make("other").acquire(identity(), null, hooks().hooks, signal());
  const launch = fake.calls().find((call) => call[0] === "exec" && call.some((arg) => arg.includes("bb-box-start")))!;
  assert.match(launch.at(-1)!, /^echo 0 >\/sys\/module\/page_reporting\/parameters\/page_reporting_order 2>\/dev\/null; /);
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
