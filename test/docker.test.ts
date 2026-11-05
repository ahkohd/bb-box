import type { GuestOs } from "../src/backends/types.ts";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { toConfiguration } from "../scripts/smoke.ts";
import { daemonOs, containerName, DockerBackend, dockerKinds, hostnameOf } from "../src/backends/docker/backend.ts";
import { gpusOf, parseContainers, parseInfo, sshReuse } from "../src/backends/docker/cli.ts";
import { parseDockerPart } from "../src/backends/docker/config.ts";
import { dockerDriver } from "../src/backends/docker/index.ts";
import { offerChecks } from "../src/backends/index.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { BackendError, type AcquireHooks, type Backend, type BoxIdentity, type MachineSize, type FieldValue, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { backendPart } from "../src/core/document.ts";
import { TransportError } from "../src/transports/types.ts";
import { dockerConfig, fakeDockerHost } from "./fake-docker.ts";
import { MemoryStorage, lxcConfig, tempDir, testContext } from "./helpers.ts";

const MiB = 2 ** 20;
/** The linux kinds' small preset (028). */
const SMALL: MachineSize = { cores: 2, memoryMiB: 4096, diskGiB: null };
const GPU_A = "nvidia.com/gpu=GPU-0b1c2d3e-0000-0000-0000-000000000001";
const GPU_B = "nvidia.com/gpu=GPU-0b1c2d3e-0000-0000-0000-000000000002";
/** A GPU's UUID, as nvidia-smi --id takes it: its CDI name after "=". */
const uuidOf = (gpu: string) => gpu.slice(gpu.indexOf("=") + 1);

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
  return { boxId: `bx${String(counter).padStart(12, "0")}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: "none" } };
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
    images: { linux: "bbbox/linux:1", "linux-desktop-cpu": "bbbox/linux-desktop:1", "linux-desktop": null, "linux-desktop-wayland-cpu": "bbbox/linux-desktop-wayland:1" },
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
  assert.equal(dockerConfig({ host: "tcp://127.0.0.1:2375" }).host, "tcp://127.0.0.1:2375");
  assert.equal(dockerConfig({ host: "wsl://bbdocker" }).host, "wsl://bbdocker");
  assert.equal(dockerConfig({ host: "wsl://box@bbdocker" }).host, "wsl://box@bbdocker");
  // An empty image turns its kinds off.
  assert.deepEqual(dockerConfig({ "desktop-image": "", "gpu-desktops": true }).images, {
    linux: "bbbox/linux:1",
    "linux-desktop-cpu": null,
    "linux-desktop": null,
    "linux-desktop-wayland-cpu": "bbbox/linux-desktop-wayland:1",
  });
  // The Wayland desktop has an image of its own (048).
  assert.deepEqual(dockerConfig({ "linux-image": "", "desktop-image": "", "wayland-desktop-image": "registry.example/sway:2" }).images, {
    linux: null,
    "linux-desktop-cpu": null,
    "linux-desktop": null,
    "linux-desktop-wayland-cpu": "registry.example/sway:2",
  });
});

test("refuses fields it cannot use, and says which, at each field", () => {
  const parsed = parseDockerPart({
    id: "docker",
    fields: {
      host: "http://192.0.2.10:2375",
      "linux-image": "--privileged",
      "wayland-desktop-image": "-v /:/host",
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
    ["wayland-desktop-image", /Wayland desktop image "-v \/:\/host"/],
    ["network", /network name/],
    ["boxes", /most boxes/],
    ["desktops-per-gpu", /desktops per GPU/],
    ["reserve-memory-mib", /cannot be negative/],
  ] as const) {
    assert.ok(parsed.problems.some((problem) => problem.path === path && pattern.test(problem.message)), `${path}: ${pattern} in ${JSON.stringify(parsed.problems)}`);
  }
  const none = parseDockerPart({ id: "docker", fields: { "linux-image": "", "desktop-image": "", "wayland-desktop-image": "" }, hosts: [] });
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
  assert.deepEqual(dockerKinds(dockerConfig()).map((kind) => kind.id), ["linux", "linux-desktop-cpu", "linux-desktop-wayland-cpu"]);
  const kinds = dockerKinds(dockerConfig({ "gpu-desktops": true }));
  assert.deepEqual(kinds.map((kind) => kind.id), ["linux", "linux-desktop-cpu", "linux-desktop", "linux-desktop-wayland-cpu"]);
  // Every box has Docker in a privileged container, a GPU desktop too (#283), and none does with the setting off or on rootless Docker (041).
  assert.deepEqual(kinds.map((kind) => kind.capabilities.features), [["docker"], ["docker"], ["docker"], ["docker"]]);
  assert.deepEqual(dockerKinds(dockerConfig({ privileged: false, "gpu-desktops": true })).map((kind) => kind.capabilities.features), [[], [], [], []]);
  assert.deepEqual(dockerKinds(dockerConfig(), true).map((kind) => kind.capabilities.features), [[], [], []]);
  // wayvnc sends no still area again, so the Wayland desktop's viewer asks for it; Xtigervnc does, and Selkies is no RFB (056).
  assert.deepEqual(kinds.map((kind) => kind.capabilities.displays.map((display) => display.refresh ?? null)), [[], [null, null], [null], ["viewer", null]]);
  for (const kind of kinds) {
    assert.equal(kind.capabilities.arch, "x86_64");
    assert.equal(kind.capabilities.command?.transport, "docker");
    assert.equal(kind.capabilities.command?.shell, "sh");
    assert.equal(kind.capabilities.enrol, true);
  }
  const lxc = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-desktop-templates": "9001 gpu-a", "proxmox-lxc-desktop-cpu-templates": "9003", "proxmox-lxc-desktop-wayland-cpu-templates": "9004" }),
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
        CpuCfsQuota: false,
        CPUSet: false,
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
      apparmor: false,
      cpuLimit: false,
      memoryLimit: true,
      cpuset: false,
      gpus: [GPU_A, GPU_B],
    },
  );
  const [container] = parseContainers(
    JSON.stringify([
      {
        Id: "abc",
        Name: "/bbbox-bx1",
        Image: "sha256:1111",
        State: { Status: "running", ExitCode: 0 },
        Config: { Labels: { "bbbox.box": "bx1", other: 3 } },
        HostConfig: { NanoCpus: 2.5e9, Memory: 4096 * MiB, CpusetCpus: "4-5,7", Mounts: [{ Type: "bind", Source: "/var/lib/lxcfs/proc/meminfo", Target: "/proc/meminfo" }] },
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
    cpus: [4, 5, 7],
    lxcfs: true,
    addresses: { bbbox: "172.30.0.2" },
    imageId: "sha256:1111",
    execIds: [],
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
  assert.equal(after(create, "--cpuset-cpus"), "0-1");
  assert.equal(container.Config.Env.some((variable) => variable.startsWith("OMP_NUM_THREADS=")), false, "a pinned box needs no OMP_NUM_THREADS");
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

test("gives each box its own Docker daemon, privileged, unless the setting is off, and a GPU desktop one GPU, named for Xorg (#283)", async () => {
  const plain = setup({ privileged: false, "gpu-desktops": true }, { gpus: [GPU_A] });
  const unprivileged = await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(plain.fake.inspect(unprivileged.ref).HostConfig.Privileged, false);
  assert.ok(!plain.fake.inspect(unprivileged.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  // An unprivileged GPU desktop sees only its GPU, so Xorg needs no name for it.
  const alone = await plain.backend.acquire(identity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(plain.fake.inspect(alone.ref).HostConfig.Privileged, false);
  assert.deepEqual(plain.fake.inspect(alone.ref).HostConfig.Devices, [GPU_A]);
  assert.ok(!plain.fake.inspect(alone.ref).Config.Env.some((pair: string) => pair.startsWith("BBBOX_GPU_ID=")));
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
  // It has Docker, so it sees every GPU on the host, and its start points Xorg at the one placed.
  assert.equal(fake.inspect(gpu.ref).HostConfig.Privileged, true);
  assert.ok(fake.inspect(gpu.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  assert.ok(fake.inspect(gpu.ref).Config.Env.includes(`BBBOX_GPU_ID=${uuidOf(GPU_A)}`));
  // The next desktop gets the GPU with fewer desktops.
  const next = await backend.acquire(identity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(next.data?.gpu, GPU_B);
  const cpu = await backend.acquire(identity("linux-desktop-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.deepEqual(fake.inspect(cpu.ref).HostConfig.Devices, []);
  assert.equal(fake.inspect(cpu.ref).HostConfig.Privileged, true);
  assert.ok(fake.inspect(cpu.ref).Config.Env.includes("BBBOX_DOCKERD=1"));
  assert.equal(after(fake.calls().filter((args) => args[1] === "create").at(-1)!, "--shm-size"), "4096m");
  // A GPU nvidia-ctk names by index goes by its index.
  const indexed = setup({ "gpu-desktops": true }, { gpus: ["nvidia.com/gpu=1"] });
  const second = await indexed.backend.acquire(identity("linux-desktop", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  assert.ok(indexed.fake.inspect(second.ref).Config.Env.includes("BBBOX_GPU_ID=1"));
});

test("a GPU desktop on a desktop image built before gpu-bus-id stays unprivileged, without Docker, until the image is built again (#283)", async () => {
  const { fake, backend } = setup({ "gpu-desktops": true }, { gpus: [GPU_A] });
  const desktop = (labels: Record<string, string>) =>
    writeFileSync(join(fake.root, "images.json"), JSON.stringify({ "bbbox/linux:1": { "bbbox.image-version": "1" }, "bbbox/linux-desktop:1": labels }));
  desktop({ "bbbox.image-version": "1" });
  // Until bb-box has seen the image, the setting decides.
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [["docker"], ["docker"], ["docker"], ["docker"]]);
  assert.equal((await backend.capacity("linux-desktop", SMALL, [], signal())).ok, true);
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [["docker"], ["docker"], [], ["docker"]]);
  const size = { cores: 4, memoryMiB: 8192, diskGiB: null };
  const old = fake.inspect((await backend.acquire(identity("linux-desktop", size), null, hooks().hooks, signal())).ref);
  assert.equal(old.HostConfig.Privileged, false);
  assert.deepEqual(old.HostConfig.Devices, [GPU_A]);
  assert.ok(old.Config.Env.includes("BBBOX_GPU=1"));
  assert.ok(!old.Config.Env.some((pair: string) => pair.startsWith("BBBOX_DOCKERD=") || pair.startsWith("BBBOX_GPU_ID=")));
  // A CPU desktop on the same image has Docker still.
  assert.equal(fake.inspect((await backend.acquire(identity("linux-desktop-cpu", size), null, hooks().hooks, signal())).ref).HostConfig.Privileged, true);
  const report = await backend.doctor(signal());
  const image = report.checks.find((check) => check.id === "image.bbbox/linux-desktop:1")!;
  assert.equal(image.status, "warn");
  assert.match(image.detail, /^Built before GPU desktops could have Docker, so they have none/);
  assert.match(image.fix!, /setup\/docker\/build\.sh to give GPU desktops Docker/);

  // Built again, the image has the label, and the next GPU desktop has Docker.
  desktop({ "bbbox.image-version": "1", "bbbox.gpu-bus-id": "1", "bbbox.image-record": record() });
  const fresh = fake.inspect((await backend.acquire(identity("linux-desktop", size), null, hooks().hooks, signal())).ref);
  assert.equal(fresh.HostConfig.Privileged, true);
  assert.ok(fresh.Config.Env.includes(`BBBOX_GPU_ID=${uuidOf(GPU_A)}`));
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [["docker"], ["docker"], ["docker"], ["docker"]]);
  assert.equal((await backend.doctor(signal())).checks.find((check) => check.id === "image.bbbox/linux-desktop:1")!.status, "ok");
});

const GPU_BUS_ID = new URL("../setup/docker/gpu-bus-id", import.meta.url).pathname;
/** The Device section of the desktop's Xorg configuration, as setup/proxmox-lxc/template/guest/customize-desktop.sh writes it. */
const XORG_DEVICE = `Section "Device"
  Identifier "nvidia"
  Driver "nvidia"
  Option "AllowEmptyInitialConfiguration" "true"
EndSection
`;

/** Runs setup/docker/gpu-bus-id with an nvidia-smi that knows `gpus`, each id=bus ID, or none at all. */
function gpuBusId(gpu: string, gpus: Record<string, string> | null, conf = XORG_DEVICE) {
  const dir = tempDir("gpu-bus-id");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  if (gpus) {
    const cases = Object.entries(gpus).map(([id, bus]) => `  --id=${id}) echo "${bus}" ;;`).join("\n");
    writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\ncase "$1" in\n${cases}\n  *) echo "No devices were found"; exit 6 ;;\nesac\n`);
    chmodSync(join(bin, "nvidia-smi"), 0o755);
  }
  writeFileSync(join(dir, "xorg.conf"), conf);
  const bash = execFileSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).trim();
  const run = spawnSync(bash, [GPU_BUS_ID, gpu, join(dir, "xorg.conf")], { encoding: "utf8", env: { PATH: `${bin}:/usr/bin:/bin` } });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr, conf: readFileSync(join(dir, "xorg.conf"), "utf8") };
}

test("a GPU desktop's start finds the placed GPU's bus ID and writes it as Xorg's BusID, in place of any there (#283)", () => {
  const found = gpuBusId(uuidOf(GPU_B), { [uuidOf(GPU_A)]: "00000000:01:00.0", [uuidOf(GPU_B)]: "00000000:41:00.0" });
  assert.equal(found.status, 0, found.stderr);
  // The display reads this GPU's free memory with it.
  assert.equal(found.stdout, "00000000:41:00.0\n");
  assert.equal(found.conf, XORG_DEVICE.replace('  Driver "nvidia"\n', '  Driver "nvidia"\n  BusID "PCI:65:0:0"\n'));

  // At the next start the GPU may be another, after a restore elsewhere.
  const again = gpuBusId("1", { "1": "0000:0A:1F.7" }, found.conf);
  assert.equal(again.status, 0, again.stderr);
  assert.equal(again.conf, XORG_DEVICE.replace('  Driver "nvidia"\n', '  Driver "nvidia"\n  BusID "PCI:10:31:7"\n'));
  // Xorg names a PCI domain other than 0 after the bus.
  assert.match(gpuBusId("0", { "0": "00000001:C1:00.0" }).conf, /^  BusID "PCI:193@1:0:0"$/m);
});

test("when the placed GPU cannot be found, a GPU desktop's start leaves Xorg's configuration alone and says why, and its display takes the CPU (#283)", () => {
  for (const [gpus, why] of [
    [{ "GPU-other": "00000000:01:00.0" }, /nvidia-smi cannot find GPU GPU-gone: No devices were found/],
    [null, /nvidia-smi cannot find GPU GPU-gone/],
    [{ "GPU-gone": "[Unknown Error]" }, /the bus ID '\[UnknownError\]', not domain:bus:device.function/],
  ] as const) {
    const lost = gpuBusId("GPU-gone", gpus);
    assert.equal(lost.status, 1);
    assert.equal(lost.stdout, "");
    assert.match(lost.stderr, why);
    assert.equal(lost.conf, XORG_DEVICE);
  }
  const start = readFileSync(new URL("../setup/docker/start", import.meta.url), "utf8");
  const fallback = `        if bus=$(/usr/local/libexec/bb-box/gpu-bus-id "$BBBOX_GPU_ID"); then
          display_env+=(GPU_BUS_ID="$bus")
        else
          display_env[0]=DISPLAY_MODE=cpu
`;
  assert.ok(start.includes(fallback), "start keeps the display on the CPU when gpu-bus-id fails");
});

test("on rootless Docker, offers no Docker once the daemon has said so, and makes boxes unprivileged", async () => {
  const { fake, backend } = setup({}, { rootless: true });
  // Until the daemon answers, the setting decides.
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [["docker"], ["docker"], ["docker"]]);
  assert.equal((await backend.capacity("linux", SMALL, [], signal())).ok, true);
  assert.deepEqual(backend.kinds().map((kind) => kind.capabilities.features), [[], [], []]);
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
      ["docker.limits", "ok"],
      ["docker.cpuset", "ok"],
      ["docker.lxcfs", "warn"],
      ["docker.apparmor", "ok"],
      ["image.bbbox/linux:1", "ok"],
      ["image.bbbox/linux-desktop:1", "ok"],
      ["image.bbbox/linux-desktop-wayland:1", "ok"],
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

/** An image's record (049) as setup/docker/build.sh labels it, built `days` ago. */
function record(days = 0, changes: Record<string, unknown> = {}): string {
  const built = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return JSON.stringify({ contract: 1, image: "standard", kind: "linux-desktop", arch: "x86_64", build: "build.20261003-021500-3f9c", built, os: "Ubuntu 24.04.5 LTS", pins: "d".repeat(64), bbApp: "a".repeat(64), tools: { node: "24.21.0" }, ...changes });
}

test("the doctor judges each image by its record's label: contract, age, BB's app and pins (049)", async () => {
  const fake = fakeDockerHost();
  const [linuxPins, desktopPins, app] = ["l", "d", "a"].map((letter) => letter.repeat(64));
  const images = { pins: async (set: string) => (set === "linux" ? linuxPins! : desktopPins!), bbApp: async () => app! };
  writeFileSync(
    join(fake.root, "images.json"),
    JSON.stringify({
      // A record finalizing gave the Docker host's whole filesystem as the image's size (#474).
      "bbbox/linux:1": { "bbbox.image-version": "1", "bbbox.image-record": record(1, { kind: "linux", pins: linuxPins, sizeGiB: 190.7 }) },
      "bbbox/linux-desktop:1": { "bbbox.image-version": "1", "bbbox.gpu-bus-id": "1", "bbbox.image-record": record(20, { bbApp: null, pins: "x".repeat(64) }) },
      "bbbox/linux-desktop-wayland:1": { "bbbox.image-version": "1", "bbbox.image-record": record(1, { contract: 0 }) },
    }),
  );
  writeFileSync(join(fake.root, "image-sizes.json"), JSON.stringify({ "bbbox/linux:1": 2_400_000_000 }));
  const backend = new DockerBackend(dockerConfig(), { ...testContext(), images }, { binary: fake.binary, readyTimeoutMs: 2_000 });
  const report = await backend.doctor(signal());
  const by = (image: string) => report.checks.find((check) => check.id === `image.${image}`)!;

  const linux = by("bbbox/linux:1");
  assert.deepEqual([linux.status, linux.fix], ["ok", null]);
  // The size is Docker's of the image, not the record's.
  assert.match(linux.detail, /^For linux boxes\. Standard image build\.20261003-021500-3f9c, built \d+ \w+ \(1 day ago\): Ubuntu 24\.04\.5 LTS, node 24\.21\.0, 2\.2 GiB\.$/);
  const listed = (await backend.images!.list(signal())).builds.find((build) => build.ref === "bbbox/linux:1");
  assert.equal(listed?.record?.sizeGiB, 2.2, "the image list's record has Docker's size too");

  const desktop = by("bbbox/linux-desktop:1");
  assert.equal(desktop.status, "warn");
  assert.match(desktop.detail, /^For linux-desktop-cpu(, linux-desktop)? boxes\. /);
  assert.match(desktop.detail, /It is 20 days old, more than 14, .* It has no build of BB's app, .* It was built with other pins than this bb-box's/);
  assert.equal(desktop.fix, "Build it again with this bb-box's setup/docker/build.sh --bb-url <BB's server URL>.");

  const wayland = by("bbbox/linux-desktop-wayland:1");
  assert.equal(wayland.status, "fail");
  assert.match(wayland.detail, /It keeps image contract 0, and this bb-box needs 1, so its boxes may not work\./);
  assert.equal(report.ok, false);

  // Built by an earlier bb-box: its layout, and no record.
  writeFileSync(join(fake.root, "images.json"), JSON.stringify({ "bbbox/linux:1": { "bbbox.image-version": "1" } }));
  const before = (await backend.doctor(signal())).checks.find((check) => check.id === "image.bbbox/linux:1")!;
  assert.equal(before.status, "warn");
  assert.match(before.detail, /^For linux boxes\. It has no image record/);
});

test("image operations on Docker: an image box, its commit as an image with its record, a trial box, a build by build.sh, and the tag moved (049)", async () => {
  const fake = fakeDockerHost();
  const scripts: { args: readonly string[]; env: NodeJS.ProcessEnv }[] = [];
  const newer = JSON.stringify({ contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261003-021500-3f9c", built: new Date().toISOString(), os: "Ubuntu 24.04.5 LTS", tools: { node: "24.21.0" } });
  const backend = new DockerBackend(dockerConfig(), testContext(), {
    binary: fake.binary,
    readyTimeoutMs: 2_000,
    // As setup/docker/build.sh leaves an image: built under the tag it was given, with its record in a label.
    script: async (script, args, env, onLine) => {
      scripts.push({ args, env });
      const images = JSON.parse(readFileSync(join(fake.root, "images.json"), "utf8"));
      writeFileSync(join(fake.root, "images.json"), JSON.stringify({ ...images, [args[args.indexOf("--tag") + 1]!]: { "bbbox.image-version": "1", "bbbox.image-record": newer } }));
      onLine(`built ${script.split("/").slice(-2).join("/")}`);
      return 0;
    },
  });
  const images = backend.images;
  const listed = await images.list(signal());
  const linux = listed.builds.find((build) => build.ref === "bbbox/linux:1")!;
  assert.deepEqual([linux.image, linux.kind, linux.current, linux.record?.kind], ["standard", "linux", true, "linux"]);
  assert.deepEqual(listed.builds.map((build) => build.ref), ["bbbox/linux:1", "bbbox/linux-desktop:1", "bbbox/linux-desktop-wayland:1"]);
  assert.deepEqual(listed.boxes, []);

  // An image box: a container of the image, which no sweep takes.
  const box = await images.box(linux, "a small image", signal());
  assert.match(box.ref, /^bbbox-image-[0-9a-f]{12}$/);
  const made = fake.inspect(box.ref);
  assert.deepEqual([made.Config.Image, made.Config.Labels["bbbox.image-box"], made.Config.Labels["bbbox.box"], made.Config.Hostname], ["bbbox/linux:1", "test", undefined, "bb-box-image"]);
  assert.deepEqual(await backend.held(signal()), [], "an image box is no box's");
  assert.deepEqual((await images.list(signal())).boxes, [box.ref]);

  // Its capture: the record as finalizing leaves it, committed in the image's labels.
  const record = { contract: 1, image: "small", kind: "linux", arch: "x86_64", build: "build.20261003-030000-abcd", built: new Date().toISOString(), os: "Ubuntu 24.04.5 LTS", tools: {} };
  assert.equal((await box.command.run(`mkdir -p /usr/share/bb-box/ && printf '%s\\n' '${JSON.stringify(record)}' > /usr/share/bb-box/image.json`)).exitCode, 0);
  const captured = await images.capture(box, linux, "small", signal());
  assert.deepEqual([captured.ref, captured.build, captured.current], ["bbbox-image/small:20261003-030000-abcd", "build.20261003-030000-abcd", false]);
  const labels = JSON.parse(readFileSync(join(fake.root, "images.json"), "utf8"))["bbbox-image/small:20261003-030000-abcd"];
  assert.deepEqual([JSON.parse(labels["bbbox.image-record"]).build, labels["bbbox.image"], labels["bbbox.kind"], labels["bbbox.image-box"]], ["build.20261003-030000-abcd", "small", "linux", ""]);
  const commit = fake.calls().find((call) => call.includes("commit"))!;
  assert.ok(commit.includes("ENV BBBOX_DOCKERD=0"), "Docker is off in the image until a box asks for it");
  assert.throws(() => fake.inspect(box.ref), "the image box is gone");
  assert.ok((await images.list(signal())).builds.some((build) => build.ref === captured.ref && build.image === "small" && !build.current));

  // A trial box of the capture, removed; what is not an image's stays.
  const trial = await images.box(captured, "trial", signal());
  assert.equal(fake.inspect(trial.ref).Config.Image, "bbbox-image/small:20261003-030000-abcd");
  await images.remove(trial.ref, signal());
  // A project's box starts from the build (049).
  assert.equal(images.startsFrom, true);
  const project = await backend.acquire({ ...identity(), from: captured.ref }, null, hooks().hooks, signal());
  assert.equal(fake.inspect(project.ref).Config.Image, "bbbox-image/small:20261003-030000-abcd");
  await backend.release(project, releasing, signal());
  await images.remove(captured.ref, signal());
  assert.deepEqual((await images.list(signal())).builds.map((build) => build.ref), ["bbbox/linux:1", "bbbox/linux-desktop:1", "bbbox/linux-desktop-wayland:1"]);
  await assert.rejects(images.remove("bbbox/linux:1", signal()), /The image bbbox\/linux:1 is not an image build of this install's/);

  // A new build of the standard image by build.sh, under a tag of its own, then the tag moved.
  const lines: string[] = [];
  const built = await images.build!(linux, "/plugin/setup", { bbUrl: "https://bb.example.com", log: (line) => lines.push(line), signal: signal() });
  assert.match(built.ref, /^bbbox\/linux:refresh-[0-9a-z]+$/);
  assert.deepEqual(scripts[0]!.args, ["--bb-url", "https://bb.example.com", "--tag", built.ref, "linux"]);
  assert.deepEqual([built.build, built.current, lines], ["build.20261003-021500-3f9c", false, ["built docker/build.sh"]]);
  const replaced = await images.replace(built, linux, signal());
  assert.deepEqual([replaced.ref, replaced.current, replaced.build], ["bbbox/linux:1", true, "build.20261003-021500-3f9c"]);
  const after = JSON.parse(readFileSync(join(fake.root, "images.json"), "utf8"));
  assert.equal(JSON.parse(after["bbbox/linux:1"]["bbbox.image-record"]).build, "build.20261003-021500-3f9c");
  assert.equal(after[built.ref], undefined, "the refresh's tag goes");
  assert.match(images.check!("linux"), /for tool in node git gh claude codex pi rg fd jj uv/);
});

test("the doctor warns about a kind the host cannot hold at any preset, less the memory it keeps free (#74)", async () => {
  const { backend } = setup({}, { cpus: 4, memoryMiB: 10240 });
  const report = await backend.doctor(signal());
  const sizes = report.checks.find((check) => check.id === "docker.sizes")!;
  assert.equal(sizes.status, "warn");
  assert.equal(
    sizes.detail,
    "fake-docker has 4 cores and 10 GiB memory, and keeps 4 GiB free. It cannot hold a linux-desktop-cpu box at any of its presets, the smallest 4 cores, 8 GiB memory. " +
      "It cannot hold a linux-desktop-wayland-cpu box at any of its presets, the smallest 4 cores, 8 GiB memory.",
  );
  assert.match(sizes.fix!, /^Give fake-docker more memory, lower the memory kept free, or make the presets of linux-desktop-cpu and linux-desktop-wayland-cpu smaller/);
  assert.equal(report.ok, true, "a warning");
});

test("the doctor fails when Docker cannot limit a box's CPU, as rootless Docker with systemd before 252, and warns when it cannot limit memory (#94)", async () => {
  const { fake, backend } = setup({}, { rootless: true, cpuLimit: false });
  const report = await backend.doctor(signal());
  const limits = () => report.checks.find((check) => check.id === "docker.limits")!;
  assert.equal(report.ok, false);
  assert.deepEqual([limits().name, limits().status], ["CPU and memory limits", "fail"]);
  assert.equal(limits().detail, "Docker on fake-docker cannot limit a container's CPU, so it refuses the CPU limit each box has, and no box starts.");
  assert.equal(
    limits().fix,
    "Have systemd delegate the cgroup controllers to the user that runs rootless Docker on fake-docker: put Delegate=cpu cpuset io memory pids under [Service] in /etc/systemd/system/user@.service.d/delegate.conf, run sudo systemctl daemon-reload, and restart the host.",
  );
  assert.equal(report.summary, `CPU and memory limits: ${limits().detail}`);
  fake.set({ rootless: false, cpuLimit: true, memoryLimit: false });
  const memory = (await backend.doctor(signal())).checks.find((check) => check.id === "docker.limits")!;
  assert.equal(memory.status, "warn");
  assert.match(memory.detail, /^Docker on fake-docker cannot limit a container's memory, so boxes there start without their memory limit/);
  assert.match(memory.fix!, /^Turn on the kernel's cpu and memory cgroup controllers on fake-docker\./);
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
      ["image.bbbox/linux-desktop-wayland:1", "skipped"],
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

test("the doctor says whether the docker calls to an ssh:// host share one SSH connection (#97)", { skip: process.platform === "win32" }, async () => {
  const fake = fakeDockerHost();
  const dir = tempDir("ssh-g");
  const ssh = join(dir, "ssh");
  // ssh -G prints the config it would use, one "key value" line each, without logging in.
  writeFileSync(ssh, `#!/bin/sh\nprintf '%s\\n' "$*" >"${dir}/args"\n[ -f "${dir}/config" ] || exit 255\ncat "${dir}/config"\n`);
  chmodSync(ssh, 0o755);
  const config = (lines: string) => writeFileSync(join(dir, "config"), `user builder\nhostname docker.example\n${lines}`);
  const host = "ssh://builder@docker.example:2222";
  const shared = async (lines: string) => {
    config(lines);
    return (await sshReuse(host, ssh, signal()))?.shared;
  };
  assert.equal(await shared("controlmaster false\ncontrolpersist no\n"), false);
  assert.equal(readFileSync(join(dir, "args"), "utf8"), "-G -l builder -p 2222 -- docker.example\n", "as the docker CLI logs in");
  assert.equal(await shared("controlmaster auto\ncontrolpath /home/builder/.ssh/cm-0a1b\ncontrolpersist 600\n"), true);
  assert.equal(await shared("controlmaster true\ncontrolpath /home/builder/.ssh/cm-0a1b\ncontrolpersist yes\n"), true);
  // A master that lasts only as long as the call that opened it is no use to short calls.
  assert.equal(await shared("controlmaster auto\ncontrolpath /home/builder/.ssh/cm-0a1b\ncontrolpersist no\n"), false);
  // ControlMaster no with a ControlPath uses a connection something else keeps open.
  assert.equal(await shared("controlmaster false\ncontrolpath /home/builder/.ssh/cm-0a1b\ncontrolpersist no\n"), true);
  assert.deepEqual(await sshReuse("ssh://[2001:db8::1]", ssh, signal()), { host: "2001:db8::1", shared: true });
  assert.equal(readFileSync(join(dir, "args"), "utf8"), "-G -- 2001:db8::1\n");
  assert.equal(await sshReuse(null, ssh, signal()), null);
  assert.equal(await sshReuse("unix:///var/run/docker.sock", ssh, signal()), null);

  const backend = new DockerBackend(dockerConfig({ host }), testContext(), { binary: fake.binary, ssh, readyTimeoutMs: 2_000 });
  const check = async () => (await backend.doctor(signal())).checks.find((entry) => entry.id === "docker.ssh");
  config("controlmaster false\ncontrolpersist no\n");
  const off = await check();
  assert.equal(off?.status, "warn");
  assert.match(off!.detail, /^Each docker call to docker\.example logs in over SSH again, which took about 0\.2 s/);
  assert.match(off!.fix!, /give Host docker\.example the lines ControlMaster auto, ControlPath ~\/\.ssh\/cm-%C and ControlPersist 10m\./);
  config("controlmaster auto\ncontrolpath /home/builder/.ssh/cm-0a1b\ncontrolpersist 600\n");
  assert.deepEqual(await check(), {
    id: "docker.ssh",
    name: "SSH connection reuse",
    status: "ok",
    detail: "The docker calls to docker.example share one SSH connection.",
    fix: null,
  });
  // When ssh cannot say, the doctor does not guess.
  rmSync(join(dir, "config"));
  assert.equal(await check(), undefined);
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

test("streams the Wayland desktop with Apple's sign-in, as wayvnc asks, and resizes it with its display script (048)", async () => {
  const { fake, backend } = setup();
  const box = await backend.acquire(identity("linux-desktop-wayland-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  const [display, ...others] = (await backend.transports(box, "linux-desktop-wayland-cpu")).displays;
  assert.deepEqual(display?.minSize, { width: 800, height: 600 });
  assert.equal(others.length, 0, "an image without Selkies has no video (060)");
  const container = join(fake.root, "containers", box.ref);
  mkdirSync(join(container, "var-lib", "bb-box"), { recursive: true });
  writeFileSync(join(container, "var-lib", "bb-box", "vnc-password"), "s3cr3t\n");
  assert.deepEqual((await display!.open(signal())).auth, { type: "apple", user: "box", password: "s3cr3t" });

  // The script runs in the box, and says why Sway refused a size.
  mkdirSync(join(container, "libexec", "bb-box"), { recursive: true });
  const script = join(container, "libexec", "bb-box", "display");
  writeFileSync(script, `#!/bin/sh\necho "$*" >>"${container}/display.log"\n[ "$2" != 40000x800 ] || { echo "Sway refused 40000x800" >&2; exit 1; }\n`);
  chmodSync(script, 0o755);
  await display!.resize!({ width: 1280, height: 800 }, signal());
  await assert.rejects(display!.resize!({ width: 40000, height: 800 }, signal()), { message: "Sway could not set the desktop to 40000x800: Sway refused 40000x800." });
  await assert.rejects(display!.resize!({ width: 1280.5, height: 800 }, signal()), /cannot be 1280\.5 by 800 pixels/);
  assert.equal(readFileSync(join(container, "display.log"), "utf8"), "resize 1280x800\nresize 40000x800\n");

  // A box of an image with Selkies has video too, by choice (060).
  const video = await backend.acquire(identity("linux-desktop-wayland-cpu", { cores: 4, memoryMiB: 8192, diskGiB: null }), null, hooks().hooks, signal());
  const launcher = join(fake.root, "containers", video.ref, "libexec", "bb-box", "selkies");
  mkdirSync(dirname(launcher), { recursive: true });
  writeFileSync(launcher, "#!/bin/sh\n");
  chmodSync(launcher, 0o755);
  // And bb-box-cursor, as an image with Sway 1.11 has (060).
  const helper = join(dirname(launcher), "cursor");
  writeFileSync(helper, "#!/bin/sh\n");
  chmodSync(helper, 0o755);
  const shown = (await backend.transports(video, "linux-desktop-wayland-cpu")).displays;
  assert.deepEqual(shown.map((each) => [each.protocol, each.label, each.cursor ?? null]), [["rfb", "Desktop", null], ["selkies", "Desktop, as video", null]]);

  // The pointer while a person holds control (#707, 060): an image without bb-box-cursor, as on 24.04, hides it from the
  // picture, as before; one with it, Sway 1.11's, keeps Sway's theme, whose pointer neither stream paints. Sway's own command
  // stands in, recording the themes it is given, and GSettings' does nothing.
  const bin = join(fake.root, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "swaymsg"), `#!/bin/sh\nfor arg; do case "$arg" in *xcursor_theme*) echo "\${arg##* }" >>"${bin}/themes";; esac; done\n`);
  chmodSync(join(bin, "swaymsg"), 0o755);
  // GSettings too, which a test machine may have without its schemas.
  writeFileSync(join(bin, "gsettings"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "gsettings"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    const themes = async (ref: typeof box) => {
      const [rfb] = (await backend.transports(ref, "linux-desktop-wayland-cpu")).displays;
      rmSync(join(bin, "themes"), { force: true });
      await rfb!.pointer!(false);
      await rfb!.pointer!(true);
      return readFileSync(join(bin, "themes"), "utf8").trim().split("\n");
    };
    assert.deepEqual(await themes(box), ["bb-box-hidden", "default"], "an image without the helper hides the pointer, as before");
    assert.deepEqual(await themes(video), ["default", "default"], "an image with the helper keeps Sway's theme");
    // And only a box with the helper has its pointer followed.
    const follows = async (ref: typeof box) => (await backend.transports(ref, "linux-desktop-wayland-cpu")).displays[0]!.followPointer !== undefined;
    assert.deepEqual([await follows(video), await follows(box)], [true, false]);
  } finally {
    process.env.PATH = path;
  }
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
  assert.equal(image?.fix, "Run bb box docker-build devpc, or turn Docker on devpc off and on in bb-box's settings, to build it there.", "named as BB names it, which the command takes");
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

test("a container comes from its kind's image's current build until a refresh moves the tag (049)", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(await backend.fromCurrentBuild!(guest, "linux"), true);
  // A refresh's new build takes the tag.
  const ids = join(fake.root, "image-ids.json");
  writeFileSync(ids, JSON.stringify({ "bbbox/linux:1": `sha256:${"9".repeat(64)}` }));
  assert.equal(await backend.fromCurrentBuild!(guest, "linux"), false);
  assert.equal(await backend.fromCurrentBuild!({ ...guest, ref: "bbbox-gone" }, "linux"), null, "a container that is gone cannot tell");
});

test("a container's cores and memory resize live with docker update, with room for what it grows by, and it has no disk to grow (061)", async () => {
  const { fake, backend } = setup({}, { cpus: 8, memoryMiB: 16384 });
  assert.deepEqual(backend.resizing("linux"), { cores: "live", memory: "live", disk: "no", shrinks: true });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const to = { cores: 4, memoryMiB: 8192, diskGiB: null };

  const plan = await backend.planResize(guest, "linux", to, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: 2, to: 4, way: "live" },
    { part: "memory", from: 4096, to: 8192, way: "live" },
  ]);
  assert.equal(plan.room.ok, true);
  assert.deepEqual((await backend.planResize(guest, "linux", { ...to, diskGiB: 40 }, [], signal())).parts.at(-1), { part: "disk", from: null, to: 40, way: "no" });

  // 16 GiB, 4 of it this box's and 4 kept free: 8 GiB more fits, 9 GiB more does not; 10 cores are more than the host's.
  const tight = await backend.planResize(guest, "linux", { ...to, memoryMiB: 13 * 1024 }, [], signal());
  assert.equal(tight.room.message, "fake-docker has 12 GiB of memory free and keeps 4 GiB free, so the 9 GiB more the box needs does not fit. Ask for less memory, release a box, or lower the memory kept free in bb-box's settings.");
  assert.equal((await backend.planResize(guest, "linux", { ...to, memoryMiB: 12 * 1024 }, [], signal())).room.ok, true);
  assert.equal((await backend.planResize(guest, "linux", { ...to, cores: 10 }, [], signal())).room.message, "fake-docker has 8 cores, fewer than the 10 asked for. Ask for at most 8 cores.");

  const grown = await backend.resize(guest, "linux", to, { restart: false }, signal());
  assert.deepEqual(grown.size, to);
  const update = fake.calls().find((args) => args[0] === "container" && args[1] === "update")!;
  assert.deepEqual(update.slice(2, -1), ["--cpus", "4", "--cpuset-cpus", "0-3", "--memory", "8192m", "--memory-swap", "8192m"]);
  // Down again: memory and swap go together, which Docker needs to lower memory.
  assert.deepEqual((await backend.resize(guest, "linux", SMALL, { restart: false }, signal())).size, SMALL);
  assert.equal((await backend.capacity("linux", SMALL, [], signal())).hosts[0]!.limits.find((limit) => limit.resource === "memory")!.used, 4096, "capacity counts the new limit");

  await assert.rejects(backend.resize(guest, "linux", { ...SMALL, diskGiB: 40 }, { restart: false }, signal()), /no disk of its own/);
  fake.set({ failUpdate: "the kernel refused" });
  await assert.rejects(backend.resize(guest, "linux", to, { restart: false }, signal()), /the kernel refused/);
  await assert.rejects(backend.resize({ ...guest, data: { ...guest.data, box: "bx_other" } }, "linux", to, { restart: false }, signal()), (error) => error instanceof BackendError && error.code === "gone");
});

test("each box is pinned to the CPUs the fewest boxes have, two boxes placed at once get their own, and boxes past the host's CPUs share the least-used (062)", async () => {
  const { fake, backend } = setup({}, { cpus: 4, memoryMiB: 65536 });
  const pinned = (guest: Guest) => fake.inspect(guest.ref).HostConfig.CpusetCpus;
  const [a, b] = await Promise.all([backend.acquire(identity(), null, hooks().hooks, signal()), backend.acquire(identity(), null, hooks().hooks, signal())]);
  assert.deepEqual([pinned(a), pinned(b)].sort(), ["0-1", "2-3"]);
  const c = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(pinned(c), "0-1", "with every CPU taken, the least shared, the lowest first");

  const [sharing, alone] = pinned(a) === "0-1" ? [a, b] : [b, a];
  await backend.release(alone, releasing, signal());
  assert.deepEqual([pinned(sharing), pinned(c)].sort(), ["0-1", "2-3"], "a release moves one of the two sharing boxes onto the CPUs it freed");
  const moves = fake.calls().filter((args) => args[1] === "update" && args.includes("--cpuset-cpus"));
  assert.equal(moves.length, 1);
  assert.deepEqual(moves[0]!.slice(2, 4), ["--cpuset-cpus", "2-3"]);

  await backend.release(c, releasing, signal());
  assert.equal(fake.calls().filter((args) => args[1] === "update").length, 1, "a box that shares no CPU never moves");
});

test("the fake docker never shows another call a container half written, so boxes placed at once never see it die (#1152)", async () => {
  const { fake, backend } = setup({}, { cpus: 4, memoryMiB: 65536 });
  const [written, read] = await Promise.all([backend.acquire(identity(), null, hooks().hooks, signal()), backend.acquire(identity(), null, hooks().hooks, signal())]);
  const docker = (...args: string[]) =>
    new Promise<{ status: number | null; stderr: string }>((resolve) => {
      const child = spawn(fake.binary, args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("exit", (status) => resolve({ status, stderr }));
    });
  const rounds = Array.from({ length: 40 }, (_, round) => [docker("container", "update", "--cpus", String(1 + (round % 2)), written.ref), docker("container", "inspect", read.ref)]);
  const failed = (await Promise.all(rounds.flat())).filter((result) => result.status !== 0);
  assert.deepEqual(failed, []);
});

test("a resize keeps a box's CPUs, grows onto the least-used and shrinks off the most shared, and a box made before pinning is pinned at its first resize (062)", async () => {
  const { fake, backend } = setup({}, { cpus: 8, memoryMiB: 65536 });
  const pinned = (guest: Guest) => fake.inspect(guest.ref).HostConfig.CpusetCpus;
  const a = await backend.acquire(identity(), null, hooks().hooks, signal());
  const b = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.resize(a, "linux", { cores: 4, memoryMiB: 4096, diskGiB: null }, { restart: false }, signal());
  assert.equal(pinned(a), "0-1,4-5");
  await backend.resize(a, "linux", SMALL, { restart: false }, signal());
  assert.equal(pinned(a), "0-1");
  assert.equal(pinned(b), "2-3");

  fake.set({ cpuset: false });
  const unpinned = await backend.acquire(identity(), null, hooks().hooks, signal());
  fake.set({ cpuset: true });
  assert.equal(pinned(unpinned), "");
  await backend.resize(unpinned, "linux", SMALL, { restart: false }, signal());
  assert.equal(pinned(unpinned), "4-5");
});

test("where Docker cannot pin a container to CPUs, a box keeps its CPU limit, gets OMP_NUM_THREADS, which nproc follows, and the doctor says why (062)", async () => {
  const { fake, backend } = setup({}, { rootless: true, cpuset: false });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const create = fake.calls().find((args) => args[0] === "container" && args[1] === "create")!;
  assert.equal(after(create, "--cpus"), "2");
  assert.equal(create.includes("--cpuset-cpus"), false);
  assert.ok(fake.inspect(guest.ref).Config.Env.includes("OMP_NUM_THREADS=2"));
  await backend.resize(guest, "linux", { cores: 4, memoryMiB: 4096, diskGiB: null }, { restart: false }, signal());
  assert.equal(fake.calls().filter((args) => args[1] === "update" && args.includes("--cpuset-cpus")).length, 0);

  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.cpuset")!;
  assert.deepEqual([check.name, check.status], ["Cores a box sees", "warn"]);
  assert.match(check.detail, /^Docker on fake-docker cannot pin a container to CPUs, so nproc in a box says the host's CPUs/);
  assert.match(check.fix!, /Delegate=cpu cpuset io memory pids/);
});

test("on a Docker host whose CPUs are 27 and 61, as one in an LXC container, boxes are pinned to those, and when the host's CPUs change, a refused create probes again and goes on (062)", async () => {
  const { fake, backend } = setup({}, { cpuList: "27,61", memoryMiB: 65536 });
  const one: MachineSize = { cores: 1, memoryMiB: 2048, diskGiB: null };
  const pinned = (guest: Guest) => fake.inspect(guest.ref).HostConfig.CpusetCpus;
  const probes = () => readFileSync(join(fake.root, "probes"), "utf8").trim().split("\n").filter((line) => line.includes("cpuset.cpus.effective")).length;
  const a = await backend.acquire(identity("linux", one), null, hooks().hooks, signal());
  const b = await backend.acquire(identity("linux", one), null, hooks().hooks, signal());
  assert.deepEqual([pinned(a), pinned(b)], ["27", "61"]);
  assert.equal(probes(), 1, "the host's CPUs are probed once and kept");

  fake.set({ cpuList: "3,9" });
  const c = await backend.acquire(identity("linux", one), null, hooks().hooks, signal());
  assert.equal(probes(), 2, "a refused create probes again");
  assert.equal(pinned(c), "3");
  const refused = fake.calls().filter((args) => args[1] === "create" && after(args, "--cpuset-cpus") === "27");
  assert.equal(refused.length, 2, "the first create of c, on the CPUs the host had, and a's own");
  assert.deepEqual([pinned(a), pinned(b), pinned(c)].map((cpus) => ["3", "9"].includes(cpus)), [true, true, true], "boxes on CPUs the host no longer has move back onto it");
});

test("without cpuset.cpus.effective, as on cgroup v1, a host's CPUs are 0 to its count less one (062)", async () => {
  const { fake, backend } = setup({}, { cgroupV1: true, cpus: 4 });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(fake.inspect(guest.ref).HostConfig.CpusetCpus, "0-1");
});

test("when dockerd refuses CPUs the host has, as it keeps the set it started with, a box is pinned to CPUs both allow (062)", async () => {
  const { fake, backend } = setup({}, { cpuList: "1,23", daemonCpuList: "10,23", memoryMiB: 65536 });
  const guest = await backend.acquire(identity("linux", { cores: 1, memoryMiB: 2048, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(fake.inspect(guest.ref).HostConfig.CpusetCpus, "23");
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.cpuset")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /keeps the CPUs it had when it started \(10,23\), but its containers may now have 1,23, .* pinned to CPUs in both \(23\)/);
  assert.match(check.fix!, /^Restart Docker on fake-docker/);
});

test("when the CPUs both dockerd and the container allow are fewer than a box's cores, the box is not pinned to them: it keeps all its cores' time, and nproc follows OMP_NUM_THREADS (#1032)", async () => {
  const { fake, backend } = setup({}, { cpuList: "1,23", daemonCpuList: "10,23", memoryMiB: 65536 });
  const guest = await backend.acquire(identity("linux", { cores: 2, memoryMiB: 2048, diskGiB: null }), null, hooks().hooks, signal());
  const made = fake.inspect(guest.ref);
  assert.equal(made.HostConfig.CpusetCpus, "");
  assert.equal(made.HostConfig.NanoCpus, 2_000_000_000);
  assert.ok(made.Config.Env.includes("OMP_NUM_THREADS=2"));
  const one = await backend.acquire(identity("linux", { cores: 1, memoryMiB: 2048, diskGiB: null }), null, hooks().hooks, signal());
  assert.equal(fake.inspect(one.ref).HostConfig.CpusetCpus, "23", "a box with no more cores than CPUs in both is still pinned");
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.cpuset")!;
  assert.match(check.detail, /One with more cores is not pinned, so it keeps all its cores' time, and gets OMP_NUM_THREADS set to its cores/);
});

test("on a Docker host that is a container whose own AppArmor profile for unix_chkpwd cannot see into boxes, the doctor warns that sudo fails in them, and gives the two lines that disable that profile (#1032)", async () => {
  const refusing = setup({}, { apparmor: true, apparmorRefusesSetgid: true });
  const check = (await refusing.backend.doctor(signal())).checks.find((each) => each.id === "docker.apparmor")!;
  assert.deepEqual([check.name, check.status], ["Programs in boxes under the host's AppArmor", "warn"]);
  assert.match(check.detail, /^fake-docker is itself a container, and its own AppArmor profile for unix_chkpwd cannot see into boxes, so sudo fails in them with "account validation failure"/);
  assert.equal(check.fix, "On fake-docker, as root, disable that profile: ln -s /etc/apparmor.d/unix-chkpwd /etc/apparmor.d/disable/ && apparmor_parser -R /etc/apparmor.d/unix-chkpwd. Both last across a reboot. This only drops AppArmor's confinement of unix_chkpwd on fake-docker; boxes need not be made again.");
  const probe = readFileSync(join(refusing.fake.root, "probes"), "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]).find((args) => args.includes("/usr/sbin/unix_chkpwd"))!;
  assert.ok(probe.includes("--privileged") && probe.includes("--reuid=65534"), "as a user, in a container like a box with Docker of its own");

  const fine = setup({}, { apparmor: true });
  assert.equal((await fine.backend.doctor(signal())).checks.find((each) => each.id === "docker.apparmor")!.status, "ok");
  const none = setup({}, {});
  assert.match((await none.backend.doctor(signal())).checks.find((each) => each.id === "docker.apparmor")!.detail, /runs no AppArmor/);
});

test("on a host with LXCFS, each box mounts its files over /proc and the CPUs online, so free and /proc/cpuinfo say the box's own, and the doctor says so (062)", async () => {
  const { fake, backend } = setup({}, { lxcfs: true, cpus: 8 });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const mounts = fake.inspect(guest.ref).HostConfig.Mounts.map((mount) => `${mount.Source} ${mount.Target}`);
  assert.deepEqual(mounts, [
    ...["cpuinfo", "meminfo", "stat", "uptime", "swaps", "loadavg", "diskstats"].map((file) => `/var/lib/lxcfs/proc/${file} /proc/${file}`),
    "/var/lib/lxcfs/sys/devices/system/cpu/online /sys/devices/system/cpu/online",
  ]);
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!;
  assert.deepEqual([check.name, check.status], ["Memory and CPUs a box sees", "ok"]);

  fake.set({ lxcfsBroken: [guest.ref] });
  const broken = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!;
  assert.equal(broken.status, "warn");
  assert.match(broken.detail, /^LXCFS on fake-docker was restarted under running boxes, so in calm-otter-\d+ free, \/proc\/meminfo and \/proc\/cpuinfo fail with "Transport endpoint is not connected"\.$/);
  assert.match(broken.fix!, /^Stop and start each of them/);
});

test("on a host without LXCFS, boxes are made without its files and the doctor says what they see and how to add it; Docker Desktop cannot have it (062)", async () => {
  const { fake, backend } = setup({}, { cpus: 8 });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(fake.inspect(guest.ref).HostConfig.Mounts, []);
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!;
  assert.equal(check.status, "warn");
  assert.match(check.detail, /^fake-docker has no LXCFS, so in a box free, \/proc\/meminfo and \/proc\/cpuinfo say the host's memory and CPUs/);
  assert.match(check.fix!, /apt install lxcfs.*systemctl enable --now lxcfs.*Reload LXCFS/);
  fake.set({ operatingSystem: "Docker Desktop" });
  const desktop = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!;
  assert.match(desktop.detail, /Docker Desktop's VM cannot have LXCFS\.$/);
  assert.equal(desktop.fix, null);
});

test("a box is made without LXCFS's files when LXCFS went from the host after bb-box last looked, and without the CPUs online where LXCFS has none (062)", async () => {
  const { fake, backend } = setup({}, { lxcfs: true, cpus: 8 });
  await backend.acquire(identity(), null, hooks().hooks, signal());
  fake.set({ lxcfs: false });
  const after = await backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(fake.inspect(after.ref).HostConfig.Mounts, [], "the refused create looked again, and made the box without them");

  const older = setup({}, { lxcfs: true, lxcfsCpuOnline: false, cpus: 8 });
  const guest = await older.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.equal(older.fake.inspect(guest.ref).HostConfig.Mounts.some((mount) => mount.Target === "/sys/devices/system/cpu/online"), false);
  assert.equal(older.fake.inspect(guest.ref).HostConfig.Mounts.length, 7);
});

test("on a Docker host that is itself an LXC container, as on Proxmox VE, boxes mount the files the LXCFS outside gives the container, as it answers for each box's own cgroup (062)", async () => {
  const { fake, backend } = setup({}, { containerLxcfs: true, cpus: 8 });
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const mounts = fake.inspect(guest.ref).HostConfig.Mounts.map((mount) => `${mount.Source} ${mount.Target}`);
  assert.deepEqual(mounts, [
    ...["cpuinfo", "meminfo", "stat", "uptime", "swaps", "loadavg", "diskstats"].map((file) => `/proc/${file} /proc/${file}`),
    "/sys/devices/system/cpu/online /sys/devices/system/cpu/online",
  ]);
  const check = (await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!;
  assert.equal(check.status, "ok");
  assert.match(check.detail, /through the LXCFS of the machine that runs fake-docker's own container, in free/);
  fake.set({ lxcfsBroken: [guest.ref] });
  assert.match((await backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!.detail, /^The LXCFS of the machine that runs fake-docker's own container was restarted under running boxes, so in calm-otter-\d+/);

  const plain = setup({}, { cpus: 8 });
  const unserved = await plain.backend.acquire(identity(), null, hooks().hooks, signal());
  assert.deepEqual(plain.fake.inspect(unserved.ref).HostConfig.Mounts, [], "a host's own /proc files are not LXCFS's, so no box mounts them");
  assert.match((await plain.backend.doctor(signal())).checks.find((each) => each.id === "docker.lxcfs")!.fix!, /If fake-docker is itself a container, LXCFS cannot run in it/);
});

test("the sweep probes a host with boxes again before its probes are 10 minutes old, and moves boxes off CPUs the host no longer has, so a create never waits on a probe (062)", async () => {
  let now = 1_000_000;
  const fake = fakeDockerHost({ cpuList: "27,61", memoryMiB: 65536 });
  const backend = new DockerBackend(dockerConfig(), testContext(), { binary: fake.binary, readyTimeoutMs: 2_000, now: () => now });
  const one: MachineSize = { cores: 1, memoryMiB: 2048, diskGiB: null };
  const probes = () => (existsSync(join(fake.root, "probes")) ? readFileSync(join(fake.root, "probes"), "utf8").trim().split("\n").filter((line) => line.includes("cpuset.cpus.effective")).length : 0);

  const empty = fakeDockerHost();
  await new DockerBackend(dockerConfig(), testContext(), { binary: empty.binary, now: () => now }).maintain(signal());
  assert.equal(existsSync(join(empty.root, "probes")), false, "a host with no bb-box box is not probed");

  const a = await backend.acquire(identity("linux", one), null, hooks().hooks, signal());
  assert.equal(fake.inspect(a.ref).HostConfig.CpusetCpus, "27");
  await backend.maintain(signal());
  assert.equal(probes(), 1, "probes under 6 minutes old stand");

  fake.set({ cpuList: "3,61" });
  now += 7 * 60_000;
  await backend.maintain(signal());
  assert.equal(probes(), 2);
  assert.equal(fake.inspect(a.ref).HostConfig.CpusetCpus, "3", "the box on a CPU the host no longer has moved back onto it");

  now += 4 * 60_000;
  const b = await backend.acquire(identity("linux", one), null, hooks().hooks, signal());
  assert.equal(probes(), 2, "a create 11 minutes after the first probe did not wait on one");
  assert.equal(fake.inspect(b.ref).HostConfig.CpusetCpus, "61");
});
