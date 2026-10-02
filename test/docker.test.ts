import type { GuestOs } from "../src/backends/types.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toConfiguration } from "../scripts/smoke.ts";
import { daemonOs, containerName, DockerBackend, dockerKinds, hostnameOf } from "../src/backends/docker/backend.ts";
import { gpusOf, parseContainers, parseInfo } from "../src/backends/docker/cli.ts";
import { parseDockerPart } from "../src/backends/docker/config.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import { offerChecks } from "../src/backends/index.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { BackendError, type AcquireHooks, type Backend, type BoxIdentity, type BoxSize, type FieldValue, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { backendPart } from "../src/core/document.ts";
import { TransportError } from "../src/transports/types.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, lxcConfig, testContext } from "./helpers.ts";

const MiB = 2 ** 20;
/** The linux kinds' small preset (028). */
const SMALL: BoxSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const GPU_A = "nvidia.com/gpu=GPU-0b1c2d3e-0000-0000-0000-000000000001";
const GPU_B = "nvidia.com/gpu=GPU-0b1c2d3e-0000-0000-0000-000000000002";

function setup(values: Record<string, FieldValue> = {}, host: Record<string, unknown> = {}) {
  const fake = fakeDockerHost(host);
  const config = dockerConfig(values);
  const context = testContext();
  const make = (installId = "test") => new DockerBackend(config, testContext(new MemoryStorage(), installId), { binary: fake.binary, readyTimeoutMs: 2_000 });
  return { fake, context, make, backend: new DockerBackend(config, context, { binary: fake.binary, readyTimeoutMs: 2_000 }) };
}

let counter = 0;
function identity(kind = "linux", size = SMALL, threadId = "thr_abc123"): BoxIdentity {
  counter++;
  return { boxId: `bx${String(counter).padStart(12, "0")}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size };
}

function hooks(onClaim: (guest: Guest) => void = () => {}) {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
      onClaim(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks: value, events, claimed, timings };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

/** The value after `flag` in a docker command line. */
function after(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at < 0 ? undefined : args[at + 1];
}

test("parses the fields, with the setup guide's defaults", () => {
  const config = dockerConfig();
  assert.deepEqual(config, {
    host: null,
    machine: null,
    images: { linux: "bbbox/linux:1", "linux-desktop-cpu": "bbbox/linux-desktop:1", "linux-desktop": null },
    // Docker in boxes is on unless set (041).
    docker: true,
    network: "bbbox",
    boxes: 10,
    desktopsPerGpu: 4,
    reserveMemoryMiB: 4096,
  });
  const all = dockerConfig({ privileged: false, "gpu-desktops": true, host: "ssh://builder@docker.example:2222", boxes: 3 });
  assert.equal(all.docker, false);
  assert.equal(all.images["linux-desktop"], "bbbox/linux-desktop:1");
  assert.equal(all.host, "ssh://builder@docker.example:2222");
  assert.equal(all.boxes, 3);
  assert.equal(dockerConfig({ "host": "unix:///run/user/1000/docker.sock" }).host, "unix:///run/user/1000/docker.sock");
  // A BB machine, reached through bb-box's relay (042).
  assert.deepEqual([dockerConfig({ host: "bb:host_m1" }).host, dockerConfig({ host: "bb:host_m1" }).machine], ["bb:host_m1", "host_m1"]);
  // An empty image turns its kinds off.
  assert.deepEqual(dockerConfig({ "desktop-image": "", "gpu-desktops": true }).images, {
    linux: "bbbox/linux:1",
    "linux-desktop-cpu": null,
    "linux-desktop": null,
  });
});

test("refuses fields it cannot use, and says which, at each field", () => {
  const parsed = parseDockerPart({
    id: "docker",
    fields: {
      host: "tcp://192.0.2.10:2375",
      "linux-image": "--privileged",
      network: "bad name",
      boxes: 0,
      "desktops-per-gpu": 1.5,
      "reserve-memory-mib": -1,
    },
    hosts: [],
  });
  assert.ok(!parsed.ok);
  for (const [path, pattern] of [
    ["host", /unix:\/\/\/path/],
    ["linux-image", /linux image "--privileged"/],
    ["network", /network name/],
    ["boxes", /most boxes/],
    ["desktops-per-gpu", /desktops per GPU/],
    ["reserve-memory-mib", /cannot be negative/],
  ] as const) {
    assert.ok(parsed.problems.some((problem) => problem.path === path && pattern.test(problem.message)), `${path}: ${pattern} in ${JSON.stringify(parsed.problems)}`);
  }
  const none = parseDockerPart({ id: "docker", fields: { "linux-image": "", "desktop-image": "" }, hosts: [] });
  assert.ok(!none.ok);
  assert.deepEqual(none.problems, [{ path: "linux-image", message: "Docker: give a linux or a desktop image." }]);
});

test("reads its part of bb-box's configuration", () => {
  const configuration = toConfiguration({ backends: [{ id: "docker", type: "docker", enabled: true, fields: { privileged: false, boxes: 3 } }] });
  assert.deepEqual(configuration.problems, []);
  const parsed = dockerDriver.parse(backendPart(configuration.document.backends[0]!, dockerDriver, configuration.secrets));
  assert.ok(parsed.ok);
  assert.equal(parsed.config.docker, false);
  assert.equal(parsed.config.boxes, 3);
  // A field Docker does not have is a problem at its path, naming the key it has now when it is its old name in BB's settings.
  const wrong = toConfiguration({ backends: [{ id: "docker", type: "docker", enabled: true, fields: { "docker-privileged": true, colour: "blue" } }] });
  assert.deepEqual(wrong.problems, [
    `backends.docker.docker-privileged: Backend docker has no field "docker-privileged". That was its name in BB's settings; here it is "privileged".`,
    `backends.docker.colour: Backend docker has no field "colour". The fields are ${Object.keys(dockerDriver.fields).join(", ")}.`,
  ]);
});

test("offers kinds by image, and its offers agree with Proxmox LXC's", async () => {
  assert.deepEqual(dockerKinds(dockerConfig()).map((kind) => kind.id), ["linux", "linux-desktop-cpu"]);
  const kinds = dockerKinds(dockerConfig({ "gpu-desktops": true }));
  assert.deepEqual(kinds.map((kind) => kind.id), ["linux", "linux-desktop-cpu", "linux-desktop"]);
  // Every box has Docker in a privileged container but a GPU desktop, and none does with the setting off or on rootless Docker (041).
  assert.deepEqual(kinds.map((kind) => kind.capabilities.features), [["docker"], ["docker"], []]);
  assert.deepEqual(dockerKinds(dockerConfig({ privileged: false })).map((kind) => kind.capabilities.features), [[], []]);
  assert.deepEqual(dockerKinds(dockerConfig(), true).map((kind) => kind.capabilities.features), [[], []]);
  for (const kind of kinds) {
    assert.equal(kind.capabilities.arch, "x86_64");
    assert.equal(kind.capabilities.command?.transport, "docker");
    assert.equal(kind.capabilities.command?.shell, "sh");
    assert.equal(kind.capabilities.enrol, true);
  }
  const lxc = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-desktop-templates": "9001 gpu-a", "proxmox-lxc-desktop-cpu-templates": "9003" }),
    testContext(),
  );
  try {
    const docker = { id: "docker", label: "Docker" } as Backend;
    const offered = [...lxc.kinds().map((kind) => ({ kind, backend: lxc })), ...kinds.map((kind) => ({ kind, backend: docker }))];
    const checks = offerChecks(offered);
    assert.deepEqual(
      checks.map((check) => [check.id, check.status, check.detail]).sort(),
      kinds.map((kind) => [`offers.${kind.id}`, "ok", `${lxc.label} and Docker offer it and agree.`]).sort(),
    );
  } finally {
    await lxc.dispose();
  }
});

test("names a box's container from its ID and its hostname from its name", () => {
  assert.equal(containerName("bxabc123def456"), "bbbox-bxabc123def456");
  assert.equal(containerName("box_conformance_1f"), "bbbox-box_conformance_1f");
  assert.equal(containerName("a b/c"), "bbbox-a-b-c");
  assert.equal(hostnameOf("calm-otter"), "calm-otter");
  assert.equal(hostnameOf("Calm Otter!"), "calm-otter");
  assert.equal(hostnameOf("--"), "box");
  assert.equal(hostnameOf("a".repeat(70)).length, 63);
});

test("reads the daemon's facts and its containers", () => {
  // UUIDs are used where nvidia-ctk names each GPU both ways; "all" is not a GPU.
  const devices = [
    { Source: "cdi", ID: "nvidia.com/gpu=all" },
    { Source: "cdi", ID: "nvidia.com/gpu=0" },
    { Source: "cdi", ID: GPU_B },
    { Source: "cdi", ID: GPU_A },
    { Source: "cdi", ID: "vendor.example/fpga=0" },
  ];
  assert.deepEqual(gpusOf(devices), [GPU_A, GPU_B]);
  assert.deepEqual(gpusOf(devices.slice(0, 2)), ["nvidia.com/gpu=0"]);
  assert.deepEqual(gpusOf(null), []);
  assert.deepEqual(
    parseInfo(
      JSON.stringify({
        Name: "docker1",
        ServerVersion: "29.0.0",
        OperatingSystem: "Ubuntu 24.04 LTS",
        OSType: "linux",
        Architecture: "x86_64",
        NCPU: 8,
        MemTotal: 16 * 1024 * MiB + 5,
        SecurityOptions: ["name=seccomp,profile=builtin", "name=rootless"],
        DiscoveredDevices: devices,
      }),
    ),
    {
      name: "docker1",
      version: "29.0.0",
      operatingSystem: "Ubuntu 24.04 LTS",
      osType: "linux",
      kernelVersion: "",
      arch: "x86_64",
      cpus: 8,
      memoryMiB: 16 * 1024,
      rootless: true,
      gpus: [GPU_A, GPU_B],
    },
  );
  const [container] = parseContainers(
    JSON.stringify([
      {
        Id: "abc",
        Name: "/bbbox-bx1",
        State: { Status: "running", ExitCode: 0 },
        Config: { Labels: { "bbbox.box": "bx1", other: 3 } },
        HostConfig: { NanoCpus: 2.5e9, Memory: 4096 * MiB },
        NetworkSettings: { Networks: { bbbox: { IPAddress: "172.30.0.2" }, none: { IPAddress: "" } } },
      },
    ]),
  );
  assert.deepEqual(container, {
    id: "abc",
    name: "bbbox-bx1",
    labels: { "bbbox.box": "bx1" },
    status: "running",
    exitCode: 0,
    cores: 2.5,
    memoryMiB: 4096,
    addresses: { bbbox: "172.30.0.2" },
  });
  assert.deepEqual(parseContainers(""), []);
});

test("acquires a box as a container labelled from its first write, claimed before it is made", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const name = containerName(box.boxId);
  const seen = hooks(() => seen.events.push(fake.containers().includes(name) ? "made" : "not made"));
  const guest = await backend.acquire(box, null, seen.hooks, signal());
  assert.deepEqual(seen.events, ["claim", "not made", "starting", "claim", "made"]);
  assert.deepEqual(seen.claimed[0], { ref: name, host: "fake-docker", address: null, size: null, data: { box: box.boxId } });
  assert.deepEqual(guest, { ref: name, host: "fake-docker", address: null, size: SMALL, data: { box: box.boxId } });
  assert.deepEqual(Object.keys(seen.timings), ["place", "network", "create", "start", "ready"]);

  const container = fake.inspect(name);
  assert.deepEqual(container.Config.Labels, {
    "bbbox.backend": "docker",
    "bbbox.install": "test",
    "bbbox.box": box.boxId,
    "bbbox.thread": "thr_abc123",
    "bbbox.name": box.name,
    "bbbox.kind": "linux",
    "bbbox.created": "1790000000000",
  });
  assert.equal(container.Config.Hostname, box.name);
  // Docker in boxes is on unless set (041).
  assert.equal(container.HostConfig.Privileged, true);
  const create = fake.calls().find((args) => args[1] === "create" && args[0] === "container")!;
  assert.equal(after(create, "--pull"), "never");
  assert.ok(create.includes("--init"));
  assert.equal(after(create, "--cpus"), "2");
  assert.equal(after(create, "--memory"), "4096m");
  assert.equal(after(create, "--memory-swap"), "4096m");
  assert.equal(after(create, "--shm-size"), "2048m");
  assert.equal(after(create, "--restart"), "unless-stopped");
  assert.equal(after(create, "--network"), "bbbox");
  assert.deepEqual(create.slice(-2), ["bbbox/linux:1", "/usr/local/sbin/bb-box-start"]);
  // The network is made once, so boxes on it cannot reach each other.
  const network = fake.calls().filter((args) => args[0] === "network" && args[1] === "create");
  assert.deepEqual(network, [["network", "create", "--label", "bbbox.backend=docker", "--opt", "com.docker.network.bridge.enable_icc=false", "bbbox"]]);
  await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.calls().filter((args) => args[0] === "network" && args[1] === "create").length, 1);
});

test("gives each box but a GPU desktop its own Docker daemon, privileged, unless the setting is off, and a GPU desktop one GPU", async () => {
  const plain = setup({ privileged: false });
  const unprivileged = await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(plain.fake.inspect(unprivileged.ref).HostConfig.Privileged, false);
  assert.ok(!plain.fake.inspect(unprivileged.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  const { fake, backend } = setup({ "gpu-desktops": true }, { gpus: [GPU_A, GPU_B] });
  const docker = await backend.acquire(identity("linux"), null, hooks().hooks, signal());
  const made = fake.inspect(docker.ref);
  assert.equal(made.HostConfig.Privileged, true);
  assert.ok(made.Config.Env.includes("BBBOX_DOCKERD=1"));
  // Its Docker data is an anonymous volume, removed with the container.
  const created = fake.calls().find((args) => args[1] === "create" && after(args, "--name") === docker.ref)!;
  assert.equal(after(created, "--volume"), "/var/lib/docker");
  const gpu = await backend.acquire(identity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(gpu.data?.gpu, GPU_A);
  assert.deepEqual(fake.inspect(gpu.ref).HostConfig.Devices, [GPU_A]);
  assert.equal(fake.inspect(gpu.ref).Config.Labels["bbbox.gpu"], GPU_A);
  assert.ok(fake.inspect(gpu.ref).Config.Env.includes("BBBOX_GPU=1"));
  // A privileged container would see every GPU on the host.
  assert.equal(fake.inspect(gpu.ref).HostConfig.Privileged, false);
  assert.ok(!fake.inspect(gpu.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  // The next desktop gets the GPU with fewer desktops.
  const next = await backend.acquire(identity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(next.data?.gpu, GPU_B);
  const cpu = await backend.acquire(identity("linux-desktop-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.deepEqual(fake.inspect(cpu.ref).HostConfig.Devices, []);
  assert.equal(fake.inspect(cpu.ref).HostConfig.Privileged, true);
  assert.ok(fake.inspect(cpu.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  assert.equal(after(fake.calls().filter((args) => args[1] === "create").at(-1)!, "--shm-size"), "4096m");
});

test("on rootless Docker, offers no Docker once the daemon has said so, and makes boxes unprivileged", async () => {
  const { fake, backend } = setup({}, { rootless: true });
  // Until the daemon answers, the setting decides.
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [["docker"], ["docker"]]);
  assert.equal((await backend.capacity("linux", SMALL, [], signal())).ok, true);
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [[], []]);
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.inspect(guest.ref).HostConfig.Privileged, false);
  assert.ok(!fake.inspect(guest.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
});

test("gives the address only where BB's server reaches the bridge", async () => {
  const { backend } = setup({}, { name: hostname() });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.match(guest.address ?? "", /^172\.30\.0\.\d+$/);
  const rootless = setup({}, { name: hostname(), rootless: true });
  assert.equal((await rootless.backend.acquire(identity(), null, hooks().hooks, signal())).address, null);
  const desktop = setup({}, { name: hostname(), operatingSystem: "Docker Desktop" });
  assert.equal((await desktop.backend.acquire(identity(), null, hooks().hooks, signal())).address, null);
});

test("holds only this install's containers, with their owners and power", async () => {
  const { make, backend } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  const other = make("other");
  await other.acquire(identity(), null, hooks().hooks, signal());
  const held = await backend.held(signal());
  assert.deepEqual(held, [
    {
      ...guest,
      owner: { boxId: box.boxId, threadId: box.threadId, name: box.name, kind: "linux", createdAt: box.createdAt },
      power: "running",
    },
  ]);
  await backend.stop(guest, signal());
  assert.equal((await backend.held(signal()))[0]?.power, "stopped");
});

test("checks the container before each act, and acts only on its own (018)", async () => {
  const { fake, make, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  await backend.stop(guest, signal());
  assert.equal(await backend.power(guest, signal()), "stopped");
  await backend.start(guest, signal());
  assert.equal(await backend.power(guest, signal()), "running");

  // Another install sees none of it, and leaves it alone.
  const other = make("other");
  assert.equal(await other.power(guest, signal()), null);
  await assert.rejects(other.stop(guest, signal()), (error: unknown) => error instanceof BackendError && error.code === "gone");
  await other.release(guest, releasing, signal());
  assert.equal(await backend.power(guest, signal()), "running");
  // Nor does a guest that names another box.
  assert.equal(await backend.power({ ...guest, data: { box: "bxsomeoneelse0" } }, signal()), null);

  await backend.release(guest, releasing, signal());
  assert.deepEqual(fake.containers(), []);
  await backend.release(guest, releasing, signal());
  assert.equal(await backend.power(guest, signal()), null);
  await assert.rejects(backend.start(guest, signal()), (error: unknown) => error instanceof BackendError && error.code === "gone");
  await assert.rejects(backend.stop(guest, signal()), (error: unknown) => error instanceof BackendError && error.code === "gone");
});

test("power is unknown when the daemon does not answer", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  fake.set({ down: true });
  assert.equal(await backend.power(guest, signal()), "unknown");
});

test("removes the container when a box does not come up, and says why", async () => {
  const { fake, backend } = setup();
  fake.set({ failStart: true });
  await assert.rejects(backend.acquire(identity(), null, hooks().hooks, signal()), /stopped as it started \(exited, exit code 1\)\. Its last output: bb-box-start: something went wrong/);
  assert.deepEqual(fake.containers(), []);
  fake.set({ failStart: false, neverReady: true });
  await assert.rejects(backend.acquire(identity(), null, hooks().hooks, signal()), /was not ready within \d s/);
  assert.deepEqual(fake.containers(), []);
});

test("refuses a missing image without pulling it", async () => {
  const { backend } = setup({ "linux-image": "example/missing:1" });
  await assert.rejects(backend.acquire(identity(), null, hooks().hooks, signal()), /has no image example\/missing:1, and bb-box never pulls one/);
});

test("leaves alone a container of the box's name that another box has, and goes on with its own", async () => {
  const { fake, backend } = setup();
  const box = identity();
  const name = containerName(box.boxId);
  execFileSync(fake.binary, ["network", "create", "bbbox"]);
  execFileSync(fake.binary, ["container", "create", "--name", name, "--label", "bbbox.backend=docker", "--label", "bbbox.install=test", "--label", "bbbox.box=bxanother00000", "--cpus", "1", "--memory", "512m", "--network", "bbbox", "bbbox/linux:1"]);
  await assert.rejects(backend.acquire(box, null, hooks().hooks, signal()), /belongs to another box, so bb-box left it alone/);
  assert.equal(fake.inspect(name).Config.Labels["bbbox.box"], "bxanother00000");

  // An acquire that resumes after a restart finds its own container and goes on.
  const mine = identity();
  const first = hooks();
  const guest = await backend.acquire(mine, null, first.hooks, signal());
  const again = await backend.acquire(mine, first.claimed[0]!, hooks().hooks, signal());
  assert.deepEqual(again, guest);
  assert.equal(fake.calls().filter((args) => args[1] === "create" && args.includes(guest.ref)).length, 2);
});

test("counts every install's containers and the memory limits of running ones", async () => {
  const { fake, make, backend } = setup({ "boxes": 2 }, { cpus: 4, memoryMiB: 16384 });
  const empty = await backend.capacity("linux", SMALL, [], signal());
  assert.deepEqual(empty, {
    ok: true,
    message: null,
    warm: null,
    hosts: [
      {
        host: "fake-docker",
        ok: true,
        limits: [
          { resource: "guests", used: 0, total: 2, reserve: 0, unit: "count" },
          { resource: "memory", used: 0, total: 16384, reserve: 4096, unit: "MiB" },
        ],
      },
    ],
  });
  // Pending acquires count until they are placed.
  const pending = await backend.capacity("linux", SMALL, [{ kind: "linux", size: { cores: 2, memoryMiB: 8192, diskGiB: null } }], signal());
  assert.deepEqual(pending.hosts[0]!.limits.map((limit) => limit.used), [1, 8192]);
  assert.equal(pending.ok, true);

  const other = make("other");
  const guest = await other.acquire(identity(), null, hooks().hooks, signal());
  const used = await backend.capacity("linux", SMALL, [], signal());
  assert.deepEqual(used.hosts[0]!.limits.map((limit) => limit.used), [1, 4096]);
  // A stopped box holds no memory, but still counts as a box.
  await other.stop(guest, signal());
  assert.deepEqual((await backend.capacity("linux", SMALL, [], signal())).hosts[0]!.limits.map((limit) => limit.used), [1, 0]);

  const big = await backend.capacity("linux", { cores: 4, memoryMiB: 12289, diskGiB: null }, [], signal());
  assert.equal(big.ok, false);
  assert.match(big.message!, /has 16 GiB of memory free and keeps 4 GiB free, so a box with 12 GiB does not fit/);
  const cores = await backend.capacity("linux", { cores: 8, memoryMiB: 4096, diskGiB: null }, [], signal());
  assert.match(cores.message!, /has 4 cores, fewer than the 8 asked for/);
  const disk = await backend.capacity("linux", { ...SMALL, diskGiB: 32 }, [], signal());
  assert.match(disk.message!, /shares the host's disk/);

  await backend.acquire(identity(), null, hooks().hooks, signal());
  const full = await backend.capacity("linux", SMALL, [], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /has 2 of the 2 bb-box containers it may have, counting stopped boxes and other installs' boxes/);
  await assert.rejects(backend.acquire(identity(), null, hooks().hooks, signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
  assert.equal(fake.containers().length, 2);
});

test("counts an acquire from when it is placed, before its container runs", async () => {
  const { backend } = setup({}, { memoryMiB: 16384 });
  const seen: number[][] = [];
  await backend.acquire(
    identity(),
    null,
    {
      ...hooks().hooks,
      claim: async () => {
        seen.push((await backend.capacity("linux", SMALL, [], signal())).hosts[0]!.limits.map((limit) => limit.used));
      },
    },
    signal(),
  );
  assert.deepEqual(seen, [
    [1, 4096],
    [1, 4096],
  ]);
});

test("places GPU desktops per GPU, counting stopped ones", async () => {
  const size = { cores: 4, memoryMiB: 8192, diskGiB: null };
  const none = setup({ "gpu-desktops": true });
  assert.match((await none.backend.capacity("linux-desktop", size, [], signal())).message!, /lists no NVIDIA GPU as a CDI device/);

  const { backend } = setup({ "gpu-desktops": true, "desktops-per-gpu": 1 }, { gpus: [GPU_A, GPU_B] });
  const capacity = await backend.capacity("linux-desktop", size, [], signal());
  assert.deepEqual(
    capacity.hosts[0]!.limits.filter((limit) => limit.resource === "gpu-desktops"),
    [GPU_A, GPU_B].map((id) => ({ resource: "gpu-desktops", id, used: 0, total: 1, reserve: 0, unit: "count" })),
  );
  // A pending desktop takes a GPU before it is placed.
  const pending = await backend.capacity("linux-desktop", size, [{ kind: "linux-desktop", size }], signal());
  assert.deepEqual(pending.hosts[0]!.limits.filter((limit) => limit.resource === "gpu-desktops").map((limit) => limit.used), [1, 1]);
  assert.equal(pending.ok, false);
  const first = await backend.acquire(identity("linux-desktop", size), null, hooks().hooks, signal());
  await backend.stop(first, signal());
  await backend.acquire(identity("linux-desktop", size), null, hooks().hooks, signal());
  const full = await backend.capacity("linux-desktop", size, [], signal());
  assert.match(full.message!, /each GPU on fake-docker has the 1 desktops it may have/);
  // A CPU desktop needs no GPU.
  assert.equal((await backend.capacity("linux-desktop-cpu", size, [], signal())).ok, true);
});

test("capacity says when the daemon does not answer", async () => {
  const { fake, backend } = setup();
  fake.set({ down: true });
  const capacity = await backend.capacity("linux", SMALL, [], signal());
  assert.equal(capacity.ok, false);
  // It asks for the daemon's facts and its containers at once, and either may fail first.
  assert.match(capacity.message!, /did not answer: docker (info|container ls) failed: Cannot connect to the Docker daemon/);
  assert.deepEqual(capacity.hosts, [{ host: "the local Docker host", ok: false, limits: [] }]);
  await assert.rejects(backend.capacity("macos", SMALL, [], signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("the doctor checks the CLI, the daemon, the images, the network and the room, and names the install", async () => {
  const { fake, make, backend, context } = setup();
  // The host is named by its address until the daemon answers, then by its own name (docker info's Name); a local daemon has no address.
  // The label names it the same way, so the kinds' text agrees with the picker.
  assert.deepEqual([backend.hosts, backend.label], [[], "Docker"]);
  const remote = setup({ host: "ssh://builder@docker.example" }).backend;
  assert.deepEqual([remote.hosts, remote.label], [["docker.example"], "Docker on docker.example"]);
  const report = await backend.doctor(signal());
  assert.deepEqual([backend.hosts, backend.label], [["fake-docker"], "Docker on fake-docker"]);
  // The host's OS for "Runs on": a local daemon is this machine's, and one over ssh:// the daemon's own words, kept with the name.
  assert.equal(backend.hostOs, process.platform === "darwin" ? "macos" : process.platform === "win32" ? "windows" : "linux");
  // A backend over ssh:// asks its daemon once at a first start; the fake daemon's plain kernel reads as Linux.
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(remote.hostOs, "linux");
  assert.deepEqual(
    [
      daemonOs({ kernelVersion: "5.15.167.4-microsoft-standard-WSL2", operatingSystem: "Docker Desktop" }),
      daemonOs({ kernelVersion: "6.6.0", operatingSystem: "Docker Desktop" }),
      daemonOs({ kernelVersion: "6.6.0", operatingSystem: "OrbStack" }),
      daemonOs({ kernelVersion: "6.8.0-45-generic", operatingSystem: "Ubuntu 24.04" }),
    ],
    ["windows", "macos", "macos", "linux"],
  );
  // The name is kept, so a backend built again on the same storage, as after a restart, shows it before asking (#265).
  const later = new DockerBackend(dockerConfig(), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual([later.hosts, later.label], [["fake-docker"], "Docker on fake-docker"]);
  assert.equal(report.ok, true, JSON.stringify(report));
  assert.equal(report.summary, "Docker 29.0.0 on fake-docker");
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.status]),
    [
      ["docker.cli", "ok"],
      ["docker.daemon", "ok"],
      ["image.bbbox/linux:1", "ok"],
      ["image.bbbox/linux-desktop:1", "ok"],
      ["docker.network", "ok"],
      ["docker.privileged", "ok"],
      ["docker.capacity", "ok"],
      ["docker.sizes", "ok"],
    ],
  );
  assert.match(report.checks[1]!.detail, /Docker 29\.0\.0 on fake-docker \(Ubuntu 24\.04 LTS, x86_64, 16 cores, 64 GiB\)/);
  assert.match(report.checks.find((check) => check.id === "image.bbbox/linux:1")!.detail, /For linux boxes/);
  assert.match(report.checks.find((check) => check.id === "docker.privileged")!.detail, /privileged container .* root on fake-docker\. This is not a security boundary\./);
  const off = await setup({ privileged: false }).backend.doctor(signal());
  assert.match(off.checks.find((check) => check.id === "docker.privileged")!.detail, /^Off: boxes run unprivileged and say No Docker\.$/);
  assert.deepEqual(report.notes, ["This install's ID is test. Its containers carry the label bbbox.install=test."]);

  await make("other").acquire(identity(), null, hooks().hooks, signal());
  const again = await backend.doctor(signal());
  assert.match(again.notes[1]!, /leaves alone the containers of other installs on fake-docker: 1 of install other\. They still count against its room\./);
  assert.match(again.checks.find((check) => check.id === "docker.network")!.detail, /Made by bb-box/);

  writeFileSync(join(fake.root, "images.json"), JSON.stringify({ "bbbox/linux:1": { "bbbox.image-version": "0" } }));
  fake.set({ rootless: true, arch: "aarch64" });
  const broken = await backend.doctor(signal());
  assert.equal(broken.ok, false);
  const by = (id: string) => broken.checks.find((check) => check.id === id)!;
  assert.equal(by("docker.daemon").status, "warn");
  assert.match(by("docker.daemon").detail, /run under emulation/);
  assert.equal(by("image.bbbox/linux:1").status, "warn");
  assert.match(by("image.bbbox/linux:1").detail, /Built for layout 0/);
  assert.equal(by("image.bbbox/linux-desktop:1").status, "fail");
  assert.match(by("image.bbbox/linux-desktop:1").fix!, /setup\/docker\/build\.sh/);
  assert.equal(by("docker.privileged").status, "warn");
  assert.match(by("docker.privileged").detail, /^Rootless Docker cannot run the privileged containers .* say No Docker\.$/);
  assert.equal(broken.summary, `Image bbbox/linux-desktop:1: ${by("image.bbbox/linux-desktop:1").detail}`);
});

test("the doctor warns about a kind the host cannot hold at any preset, less the memory it keeps free (#74)", async () => {
  const { backend } = setup({}, { cpus: 4, memoryMiB: 10240 });
  const report = await backend.doctor(signal());
  const sizes = report.checks.find((check) => check.id === "docker.sizes")!;
  assert.equal(sizes.status, "warn");
  assert.equal(
    sizes.detail,
    "fake-docker has 4 cores and 10 GiB memory, and keeps 4 GiB free. It cannot hold a linux-desktop-cpu box at any of its presets, the smallest 4 cores, 8 GiB memory.",
  );
  assert.match(sizes.fix!, /^Give fake-docker more memory, lower the memory kept free, or make the presets of linux-desktop-cpu smaller/);
  assert.equal(report.ok, true, "a warning");
});

test("the doctor fails without a daemon or a CLI, and skips what depends on them", async () => {
  const { fake, backend } = setup({ "gpu-desktops": true });
  const gpus = await backend.doctor(signal());
  assert.equal(gpus.checks.find((check) => check.id === "docker.gpus")?.status, "fail");
  fake.set({ down: true });
  const down = await backend.doctor(signal());
  assert.equal(down.ok, false);
  assert.deepEqual(
    down.checks.map((check) => [check.id, check.status]),
    [
      ["docker.cli", "ok"],
      ["docker.daemon", "fail"],
      ["image.bbbox/linux:1", "skipped"],
      ["image.bbbox/linux-desktop:1", "skipped"],
    ],
  );
  assert.match(down.checks[1]!.fix!, /Start Docker on BB's server/);
  const missing = new DockerBackend(dockerConfig({ "host": "ssh://builder@docker.example" }), testContext(), { binary: join(fake.root, "no-such-docker") });
  assert.equal(missing.label, "Docker on docker.example");
  const report = await missing.doctor(signal());
  assert.deepEqual(report.checks.slice(0, 2).map((check) => [check.id, check.status]), [
    ["docker.cli", "fail"],
    ["docker.daemon", "skipped"],
  ]);
  assert.match(report.checks[0]!.fix!, /Install the docker CLI/);
});

test("the doctor warns of a network bb-box did not make", async () => {
  const { fake, backend } = setup();
  execFileSync(fake.binary, ["network", "create", "bbbox"]);
  const report = await backend.doctor(signal());
  const network = report.checks.find((check) => check.id === "docker.network")!;
  assert.equal(network.status, "warn");
  assert.match(network.detail, /bb-box did not make the network bbbox/);
});

test("runs commands, copies files and opens a shell through docker exec, as the box user", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const { command, displays, access } = await backend.transports(guest, "linux");
  assert.deepEqual(displays, []);
  assert.equal(access, null);
  const home = fake.home(guest.ref);
  const result = await command!.run('printf "%s %s %s %s|" "$USER" "$LOGNAME" "$SHELL" "$LANG"; pwd');
  assert.equal(result.stdout, `box box /bin/bash C.UTF-8|${realpathSync(home)}\n`);
  // A command reads the display path's settings, as a login shell does in an LXC box.
  writeFileSync(join(fake.root, "containers", guest.ref, "run", "bb-box", "display.env"), "DISPLAY=:99\n");
  assert.equal((await command!.run('printf %s "$DISPLAY"')).stdout, ":99");
  const failed = await command!.run("echo no >&2; exit 4");
  assert.deepEqual([failed.exitCode, failed.stderr], [4, "no\n"]);

  // A relative path is in the box user's home, and parents are made.
  await command!.writeFile("a/b/c.txt", Buffer.from("hello"), { mode: "0600" });
  assert.equal(readFileSync(join(home, "a", "b", "c.txt"), "utf8"), "hello");
  assert.equal(Buffer.from(await command!.readFile("/home/box/a/b/c.txt", { maxBytes: 5 })).toString(), "hello");
  await assert.rejects(command!.readFile("a/b/c.txt", { maxBytes: 4 }), /larger than/);

  // Closing stdin reaches the script as end of file.
  const channel = await command!.spawn!("cat; echo done");
  const writer = channel.writable.getWriter();
  await writer.write(Buffer.from("ping\n"));
  await writer.close();
  let output = "";
  const reader = channel.readable.getReader();
  for (let read = await reader.read(); !read.done; read = await reader.read()) output += Buffer.from(read.value).toString();
  await channel.close();
  assert.equal(output, "ping\ndone\n");

  await backend.stop(guest, signal());
  await assert.rejects(command!.run("true"), (error: unknown) => error instanceof TransportError && error.code === "unreachable");
});

test("works from a held box on empty storage", async () => {
  const { make, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const fresh = make();
  const [held] = await fresh.held(signal());
  assert.equal(held?.ref, guest.ref);
  const { command } = await fresh.transports(held!, "linux");
  assert.equal((await command!.run("echo ok")).stdout, "ok\n");
  await fresh.release(held!, releasing, signal());
  assert.equal(await backend.power(guest, signal()), null);
});

test("streams the desktop through socat under docker exec, with the box's VNC password", async () => {
  const { fake, backend } = setup({ "gpu-desktops": true }, { gpus: [GPU_A] });
  const size = { cores: 4, memoryMiB: 8192, diskGiB: null };
  const cpu = await backend.acquire(identity("linux-desktop-cpu", size), null, hooks().hooks, signal());
  const [display] = (await backend.transports(cpu, "linux-desktop-cpu")).displays;
  assert.equal(display?.resize, undefined);
  assert.deepEqual(display?.minSize, { width: 800, height: 600 });
  assert.deepEqual(await display!.open(signal()), {
    route: {
      type: "command",
      argv: [fake.binary, "exec", "-i", "-u", "box", "-w", "/home/box", "-e", "SHELL=/bin/bash", "-e", "USER=box", "-e", "LOGNAME=box", "-e", "LANG=C.UTF-8", cpu.ref, "socat", "-", "TCP:127.0.0.1:5900"],
    },
    auth: { type: "none" },
  });
  mkdirSync(join(fake.root, "containers", cpu.ref, "var-lib", "bb-box"), { recursive: true });
  writeFileSync(join(fake.root, "containers", cpu.ref, "var-lib", "bb-box", "vnc-password"), "s3cr3t\n");
  assert.deepEqual((await display!.open(signal())).auth, { type: "vnc-password", password: "s3cr3t" });

  // Only the GPU desktop resizes through the backend, and only while it is on the GPU.
  const gpu = await backend.acquire(identity("linux-desktop", size), null, hooks().hooks, signal());
  const [gpuDisplay] = (await backend.transports(gpu, "linux-desktop")).displays;
  assert.deepEqual(gpuDisplay?.minSize, { width: 800, height: 600 });
  writeFileSync(join(fake.root, "containers", gpu.ref, "run", "bb-box", "display-mode"), "cpu\n");
  await gpuDisplay!.resize!({ width: 1280, height: 800 }, signal());
  await assert.rejects(gpuDisplay!.resize!({ width: 0, height: 800 }, signal()), /cannot be 0 by 800 pixels/);
});

test("a box that changes hands keeps its new owner and name for the sweep, though its labels cannot change (036)", async () => {
  const { backend } = setup();
  const box = identity("linux", SMALL, "spare");
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.equal((await backend.held()).find((held) => held.ref === guest.ref)?.owner?.threadId, "spare");
  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" });
  const owner = (await backend.held()).find((held) => held.ref === guest.ref)?.owner;
  assert.deepEqual([owner?.threadId, owner?.name, owner?.boxId], ["operator", "build-1", box.boxId]);
  await backend.release(guest, releasing);
  assert.deepEqual(await backend.held(), []);
});

test("a Docker host that is a BB machine is reached through bb-box's relay, named as BB names it, and an offline one takes no box and runs nothing (042)", async () => {
  const fake = fakeDockerHost();
  const state = { connected: true as boolean | null, readies: 0 };
  const context = {
    ...testContext(),
    machines: {
      dockerHost: (hostId: string) => `unix:///tmp/bb-box-relay/${hostId}.sock`,
      ready: async (hostId: string) => {
        state.readies++;
        if (state.connected !== true) throw new Error(`devpc is offline in BB.`);
        assert.equal(hostId, "host_m1");
      },
      name: () => "devpc",
      connected: async () => state.connected,
    },
  };
  const backend = new DockerBackend(dockerConfig({ host: "bb:host_m1" }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  assert.equal(backend.label, "Docker on devpc");

  const room = await backend.capacity("linux", SMALL, [], signal());
  assert.equal(room.ok, true, room.message ?? "");
  const raw = readFileSync(join(fake.root, "log"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
  assert.ok(raw.length && raw.every((args) => args[0] === "-H" && args[1] === "unix:///tmp/bb-box-relay/host_m1.sock"), "every command goes to the relay's socket");
  assert.ok(state.readies >= raw.length, "the relay is made ready before each command");

  // Offline in BB: capacity says so from BB's view, with no command to the machine.
  state.connected = false;
  const before = fake.calls().length;
  const offline = await backend.capacity("linux", SMALL, [], signal());
  assert.deepEqual([offline.ok, offline.message], [false, "devpc is offline in BB."]);
  assert.equal(fake.calls().length, before);
  // A command on one of its boxes fails at once, saying so.
  await assert.rejects(() => backend.transports({ ref: "bbbox-x", host: "devpc", address: null, size: null }, "linux"), /devpc is offline in BB\./);
  const report = await backend.doctor(signal());
  const daemon = report.checks.find((check) => check.id === "docker.daemon");
  assert.equal(daemon?.status, "fail");
  assert.match(daemon?.detail ?? "", /devpc is offline in BB\./);
  assert.match(daemon?.fix ?? "", /bb box docker-check host_m1/);
  assert.equal(report.checks.find((check) => check.id === "docker.cli")?.status, "ok", "the CLI's own version needs no machine");
});

test("a BB machine's OS is BB's word, kept in storage, so a restart knows a Windows PC before the host entry has answered again", async () => {
  const fake = fakeDockerHost();
  const state = { platform: null as GuestOs | null };
  const context = {
    ...testContext(),
    machines: { dockerHost: () => "unix:///tmp/relay/host_m1.sock", ready: async () => {}, name: () => "devpc", platform: () => state.platform, connected: async () => true },
  };
  const backend = new DockerBackend(dockerConfig({ host: "bb:host_m1" }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(backend.hostOs, null, "unknown until the host entry has answered");
  // The host entry says BB's daemon runs in WSL on a Windows PC.
  state.platform = "windows";
  assert.equal(backend.hostOs, "windows");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await context.storage.get("host-os"), "windows", "kept with the host's name");
  // After a restart BB has not answered yet: the kept OS stands until it does, and BB's word wins when it comes.
  state.platform = null;
  const restarted = new DockerBackend(dockerConfig({ host: "bb:host_m1" }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(restarted.hostOs, "windows");
  state.platform = "linux";
  assert.equal(restarted.hostOs, "linux");
});

test("on a BB machine, the doctor's fix for a missing image is bb-box's own build there (042)", async () => {
  const fake = fakeDockerHost();
  writeFileSync(join(fake.root, "images.json"), JSON.stringify({}));
  const context = {
    ...testContext(),
    machines: { dockerHost: () => "unix:///tmp/relay/host_m1.sock", ready: async () => {}, name: () => "devpc", connected: async () => true },
  };
  const backend = new DockerBackend(dockerConfig({ host: "bb:host_m1" }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const report = await backend.doctor(signal());
  const image = report.checks.find((check) => check.id === "image.bbbox/linux:1");
  assert.equal(image?.status, "fail");
  assert.equal(image?.fix, "Run bb box docker-build devpc, or turn devpc off and on under Docker on BB machines in bb-box's settings, to build it there.", "named as BB names it, which the command takes");
});

test("on a BB machine, a command or a capacity check stops waiting when its signal aborts, though BB never answers, so a stopping plugin's sweep ends", async () => {
  const fake = fakeDockerHost();
  const never = new Promise<never>(() => {});
  const context = {
    ...testContext(),
    machines: { dockerHost: () => "unix:///tmp/relay/host_m1.sock", ready: () => never, name: () => "devpc", connected: () => never },
  };
  const backend = new DockerBackend(dockerConfig({ host: "bb:host_m1" }), context, { binary: fake.binary, readyTimeoutMs: 2_000 });
  for (const call of [(signal: AbortSignal) => backend.held(signal), (signal: AbortSignal) => backend.capacity("linux", SMALL, [], signal)]) {
    const stopping = new AbortController();
    const started = Date.now();
    const pending = call(stopping.signal);
    setTimeout(() => stopping.abort(new Error("the plugin is stopping")), 50);
    await assert.rejects(pending, /the plugin is stopping/);
    assert.ok(Date.now() - started < 2_000);
  }
  assert.deepEqual(fake.calls(), [], "nothing reached the machine");
});
