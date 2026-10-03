import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, displayReason, warmNameScript, nameScript, type LxcBackendOptions } from "../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { installFromDescription, ownerFromDescription, ownerFromTags, templateFromTags } from "../src/backends/proxmox/owner.ts";
import { parseImageRecord, recordInDescription } from "../src/backends/images.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { quote } from "../src/transports/process.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, lxcWarm, tempDir, testContext } from "./helpers.ts";

const GiB = 2 ** 30;

/** Every backend the tests make, disposed at the end so their key files go. */
const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

function track(backend: ProxmoxLxcBackend): ProxmoxLxcBackend {
  made.push(backend);
  return backend;
}

/** The fake Proxmox, SSH and network, and no waiting. */
function fakes(proxmox: FakeProxmox): LxcBackendOptions {
  return { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 };
}

function setup(values: Record<string, unknown> = {}, storage = new MemoryStorage(), options: LxcBackendOptions = {}) {
  const ssh = fakeSsh();
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  // As build.sh leaves a desktop template: at its kinds' default size.
  for (const template of [9001, 9002, 9003, 9004]) proxmox.addTemplate(template, { cores: "4", memory: "8192" });
  const config = lxcConfig({
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-desktop-templates": "9001 gpu-a",
    "proxmox-lxc-vmid-first": 7000,
    "proxmox-lxc-vmid-last": 7009,
    ...values,
  });
  /** Warm counts by kind, which the backend reads live. */
  const warm = lxcWarm(values);
  const context = testContext(storage, "test", { id: "proxmox-lxc", warm });
  const make = (on = context) => track(new ProxmoxLxcBackend(config, on, { ...fakes(proxmox), ...options }));
  return { ssh, proxmox, context, storage, make, warm, backend: make() };
}

/** The size a box of the kind gets by default. */
const sized = (kind: string): BoxSize => defaultSize(kindSizes(kind));
const waiting = (...kinds: string[]) => kinds.map((kind) => ({ kind, size: sized(kind) }));

let boxCounter = 0;
function identity(kind = "linux", threadId = "thr_abc123", size = sized(kind)): BoxIdentity {
  boxCounter++;
  return { boxId: `box_${boxCounter}`, threadId, name: `calm-otter-${boxCounter}`, kind, createdAt: 1_790_000_000_000, size };
}

function hooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push(`claim ${guest.ref}`);
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { value, events, claimed, timings };
}

const signal = () => new AbortController().signal;

function releasing(): ReleaseHooks & { timings: Record<string, number> } {
  const timings: Record<string, number> = {};
  return {
    timings,
    resetting: async () => {
      throw new Error("A virtual backend has nothing to reset.");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
}

test("kinds lists only kinds with a template", () => {
  const { backend } = setup({ "proxmox-lxc-desktop-templates": "" });
  const kinds = backend.kinds();
  assert.deepEqual(
    kinds.map((kind) => kind.id),
    ["linux"],
    "linux-docker is an alias of linux, not an offer (041)",
  );
  assert.deepEqual(kinds[0]!.requires, []);
  assert.deepEqual(kinds[0]!.capabilities.features, ["docker"]);
  assert.deepEqual(kinds[0]!.capabilities.command, { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true });
  assert.deepEqual(kinds[0]!.capabilities.displays, []);
  assert.equal(kinds[0]!.capabilities.arch, "x86_64");
  assert.equal(kinds[0]!.readyTimeoutMs, 30_000);
  const desktop = setup().backend.kinds().find((kind) => kind.id === "linux-desktop")!;
  assert.deepEqual(desktop.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }], "xrandr resizes the GPU's screen");
  assert.equal(desktop.capabilities.gpu, true);
  const cpu = setup({ "proxmox-lxc-desktop-cpu-templates": "9003" }).backend.kinds().find((kind) => kind.id === "linux-desktop-cpu")!;
  assert.equal(cpu.capabilities.gpu, false);
  assert.deepEqual(cpu.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }], "Xtigervnc resizes");
  assert.deepEqual(cpu.capabilities.computerUse, desktop.capabilities.computerUse);
  const wayland = setup({ "proxmox-lxc-desktop-wayland-cpu-templates": "9004" }).backend.kinds().find((kind) => kind.id === "linux-desktop-wayland-cpu")!;
  assert.equal(wayland.label, "Linux desktop on Wayland");
  assert.equal(wayland.capabilities.gpu, false);
  assert.deepEqual(wayland.capabilities.features, ["docker"]);
  assert.deepEqual(wayland.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }], "Sway resizes through the backend (048)");
  assert.deepEqual(wayland.capabilities.computerUse, desktop.capabilities.computerUse);
});

test("the node is found when there is only one", async () => {
  const { backend, proxmox } = setup();
  assert.equal((await backend.client()).node, "pve");
  assert.equal(backend.label, "Proxmox LXC on pve.example.com");

  const two = setup();
  two.proxmox.intercept = (call) =>
    call.path === "/nodes"
      ? { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data: [{ node: "a" }, { node: "b" }] }) }
      : undefined;
  await assert.rejects(two.backend.client(), /lists 2 nodes \(a, b\)\. Set the node/);
  assert.ok(proxmox.calls.length > 0);
});

test("capacity keeps the memory and disk reserves", async () => {
  const { backend, proxmox } = setup();
  const ok = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warm, { ready: 0, target: 0 });
  assert.equal(ok.hosts.length, 1);
  assert.equal(ok.hosts[0]!.host, "pve");
  assert.deepEqual(ok.hosts[0]!.limits, [
    { resource: "memory", used: 16 * 1024, total: 64 * 1024, reserve: 4096, unit: "MiB" },
    { resource: "disk", used: 300 * 1024, total: 900 * 1024, reserve: 50 * 1024, unit: "MiB" },
    { resource: "guests", used: 0, total: 10, reserve: 0, unit: "count" },
  ]);

  proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  const pending = await backend.capacity("linux", sized("linux"), waiting("linux"), signal());
  assert.equal(pending.ok, false);
  assert.match(pending.message!, /pve has 6 GiB of memory free and keeps 4 GiB free, so a linux box with 4 GiB memory does not fit/);
  assert.match(pending.message!, /ask for less memory, or lower the memory kept free in bb-box's settings/);

  proxmox.memory = { total: 64 * GiB, available: 48 * GiB };
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 20 * GiB });
  const disk = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(disk.ok, false);
  assert.equal(disk.hosts[0]!.ok, false);
  assert.match(disk.message!, /local-lvm storage on pve has 20 GiB free, less than the 50 GiB kept free/);
});

test("a refusal for memory leads with what binds: the room kept free, or the box when it needs more than is free", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-reserve-memory-mib": 16 * 1024 });
  proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  const kept = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(
    kept.message,
    "pve has 10 GiB of memory free and keeps 16 GiB free, so a linux box with 4 GiB memory does not fit. " +
      "Release a box, or lower the memory kept free in bb-box's settings.",
  );
  const box = await backend.capacity("linux", { cores: 2, memoryMiB: 12 * 1024, diskGiB: null }, waiting(), signal());
  assert.equal(box.message, "pve has 10 GiB of memory free, less than a linux box with 12 GiB memory needs. Release a box or ask for less memory.");
});

test("capacity refuses when the VMID range is full", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000 });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bbbox", status: "running", template: false, config: {} });
  const full = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /Every VMID from 7000 to 7000 is in use/);
});

test("capacity refuses more cores than the node has, more memory than is free and a disk the storage cannot grow to (028)", async () => {
  const { backend, proxmox } = setup();
  const cores = await backend.capacity("linux", { cores: 32, memoryMiB: 4096, diskGiB: null }, waiting(), signal());
  assert.equal(cores.ok, false);
  assert.equal(cores.message, "pve has 16 CPU threads, fewer than the 32 cores asked for. Ask for at most 16 cores.");
  assert.equal((await backend.capacity("linux", { cores: 16, memoryMiB: 4096, diskGiB: null }, waiting(), signal())).ok, true);

  const memory = await backend.capacity("linux", { cores: 2, memoryMiB: 48 * 1024, diskGiB: null }, waiting(), signal());
  assert.equal(memory.ok, false);
  assert.match(memory.message!, /pve has 48 GiB of memory free and keeps 4 GiB free, so a linux box with 48 GiB memory does not fit/);

  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 100 * GiB });
  assert.equal((await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 50 }, waiting(), signal())).ok, true, "42 GiB more leaves 58 GiB free");
  const disk = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 60 }, waiting(), signal());
  assert.equal(disk.ok, false);
  assert.match(disk.message!, /^The local-lvm storage on pve has 100 GiB free and keeps 50 GiB free, so a 60 GiB disk, 52 GiB more than the template's, does not fit\. Ask for a smaller disk/);
  const huge = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 120 }, waiting(), signal());
  assert.match(huge.message!, /^The local-lvm storage on pve has 100 GiB free, less than the 112 GiB a 120 GiB disk adds to the template's\. Ask for a smaller disk or release boxes\./);
});

test("pending boxes count with the memory of their own size (028)", async () => {
  const { backend, proxmox } = setup();
  proxmox.memory = { total: 64 * GiB, available: 20 * GiB };
  const large = { kind: "linux", size: { cores: 8, memoryMiB: 13 * 1024, diskGiB: null } };
  assert.equal((await backend.capacity("linux", sized("linux"), waiting("linux"), signal())).ok, true, "4 GiB pending leaves room");
  const refused = await backend.capacity("linux", sized("linux"), [large], signal());
  assert.equal(refused.ok, false, "13 GiB pending does not");
  assert.equal(refused.hosts[0]!.limits[0]!.used, 44 * 1024 + 13 * 1024);
});

test("capacity counts desktops on each GPU against the limit per GPU", async () => {
  const { backend } = setup({ "proxmox-lxc-desktops-per-gpu": 2 });
  const headless = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(headless.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops"), undefined);

  await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const one = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(one.ok, true);
  assert.deepEqual(one.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 1, total: 2, reserve: 0, unit: "count" });

  const full = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting("linux-desktop", "linux"), signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /Every GPU on pve runs 2 desktop boxes, the most bb-box's settings allow\. Release a desktop box, or raise the desktops per GPU/);

  const unlimited = await setup().backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.deepEqual(unlimited.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 0, total: null, reserve: 0, unit: "count" });
});

test("desktops spread across GPUs, and a full set of GPUs points to CPU desktops", async () => {
  const { backend, proxmox } = setup({
    "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b",
    "proxmox-lxc-desktop-cpu-templates": "9003",
    "proxmox-lxc-desktops-per-gpu": 1,
  });
  const first = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const second = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const display = [{ label: "Display mode", value: "GPU" }, { label: "Display reason", value: "The GPU had 7800 MiB of memory free." }];
  assert.deepEqual([first.data?.template, first.facts], [9001, [{ label: "GPU", value: "gpu-a" }, ...display]]);
  assert.deepEqual([second.data?.template, second.facts], [9002, [{ label: "GPU", value: "gpu-b" }, ...display]]);
  assert.ok(parseTags(proxmox.guests.get(Number(second.ref))!.config.tags).includes("template.9002"));

  const full = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(full.ok, false);
  assert.deepEqual(full.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 2, total: 2, reserve: 0, unit: "count" });
  assert.match(full.message!, /Every GPU on pve runs 1 desktop box, .* Use a linux-desktop-cpu box, or release a desktop box/);
  assert.equal((await backend.capacity("linux-desktop-cpu", sized("linux-desktop-cpu"), waiting(), signal())).ok, true, "CPU desktops use no GPU");

  const cpu = await backend.acquire(identity("linux-desktop-cpu"), null, hooks().value, signal());
  assert.equal(cpu.data?.template, 9003);
  assert.deepEqual(cpu.facts, display, "a CPU desktop names no GPU");

  await backend.release(first, releasing());
  assert.equal((await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, true, "gpu-a has room again");
  const third = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(third.data?.template, 9001);
});

/** Time for a retry on another GPU, which the fakes' deadline of now leaves none for. */
const RETRY = { readyTimeoutMs: 10_000 };

/** Makes the box at `host` start its desktop in `mode`, as the display service would record it. */
function displayAt(dir: string, host: string, mode: string, reason: string): void {
  mkdirSync(join(dir, "display"), { recursive: true });
  writeFileSync(join(dir, "display", host), `${mode}\n${reason}`);
}

test("a desktop that starts without its GPU is released and tried on another GPU", async () => {
  const { backend, proxmox, ssh, context } = setup({ "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b" }, new MemoryStorage(), RETRY);
  displayAt(ssh.dir, "192.0.2.100", "cpu", "no render node");
  const hook = hooks();
  const guest = await backend.acquire(identity("linux-desktop"), null, hook.value, signal());
  assert.equal(guest.ref, "7001");
  assert.equal(guest.data?.template, 9002);
  assert.deepEqual(guest.facts, [
    { label: "GPU", value: "gpu-b" },
    { label: "Display mode", value: "GPU" },
    { label: "Display reason", value: "The GPU had 7800 MiB of memory free." },
  ]);
  assert.equal(proxmox.guests.has(7000), false, "the box without its GPU is deleted");
  assert.deepEqual(hook.events, ["claim 7000", "starting", "claim 7001", "claim 7001"]);
  assert.deepEqual(hook.claimed.at(-1), guest, "the last claim carries the display's facts");
  assert.match(context.errors.join("\n"), /started without GPU gpu-a \(no render node\), so bb-box released it and tries another GPU/);

  // gpu-a is avoided for a while, though it now runs fewer desktops.
  const next = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(next.data?.template, 9002);
});

test("a desktop with no GPU left to try is refused, naming CPU desktops", async () => {
  const { backend, proxmox, ssh } = setup();
  displayAt(ssh.dir, "192.0.2.100", "cpu", "no render node");
  await assert.rejects(backend.acquire(identity("linux-desktop"), null, hooks().value, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError);
    assert.equal(error.code, "no_capacity");
    assert.match(error.message, /started without a GPU, so bb-box released it \(GPU gpu-a: no render node\)/);
    assert.match(error.message, /No other GPU on pve has a linux-desktop template/);
    assert.match(error.message, /linux-desktop-cpu box/);
    return true;
  });
  assert.deepEqual([...proxmox.guests.values()].filter((guest) => !guest.template), [], "nothing is left behind");

  // While gpu-a is avoided and no other GPU exists, a desktop is still tried on it.
  const again = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(again.data?.template, 9001);
});

test("a desktop that fails on every GPU names each GPU and its reason", async () => {
  const { backend, ssh } = setup({ "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b" }, new MemoryStorage(), RETRY);
  displayAt(ssh.dir, "192.0.2.100", "cpu", "no render node");
  displayAt(ssh.dir, "192.0.2.101", "cpu", "driver mismatch");
  await assert.rejects(
    backend.acquire(identity("linux-desktop"), null, hooks().value, signal()),
    /\(GPU gpu-a: no render node; GPU gpu-b: driver mismatch\)\. No other GPU on pve has a linux-desktop template/,
  );
});

test("a CPU desktop shows its display mode and is never retried", async () => {
  const { backend, ssh } = setup({ "proxmox-lxc-desktop-cpu-templates": "9003" });
  displayAt(ssh.dir, "192.0.2.100", "cpu", "DISPLAY_MODE=cpu");
  const guest = await backend.acquire(identity("linux-desktop-cpu"), null, hooks().value, signal());
  assert.equal(guest.ref, "7000");
  assert.deepEqual(guest.facts, [
    { label: "Display mode", value: "CPU" },
    { label: "Display reason", value: "The template has no GPU." },
  ]);
});

test("the display service's reasons read as sentences", () => {
  // As setup/proxmox-lxc/template/guest/files/display writes them.
  const reasons: [string, string][] = [
    ["DISPLAY_MODE=cpu", "The template has no GPU."],
    ["DISPLAY_MODE=gpu", "The template sets the display mode to gpu."],
    ["no NVIDIA device nodes", "The box has no GPU device."],
    ["host NVIDIA driver '560.20.02' does not match the template's '550.10.01'", "The template was built for NVIDIA driver 550.10.01, but the host has 560.20.02."],
    ["host NVIDIA driver 'none' does not match the template's '550.10.01'", "The host has no NVIDIA driver loaded."],
    ["host NVIDIA driver '560.20.02' does not match the template's 'none'", "The template has no NVIDIA driver."],
    ["nvidia-smi cannot read the GPU", "The GPU did not answer nvidia-smi."],
    ["GPU has 120 MiB free, below MIN_FREE_VRAM_MIB=384", "The GPU had 120 MiB of memory free, less than the 384 MiB a desktop needs."],
    ["GPU has 7800 MiB free", "The GPU had 7800 MiB of memory free."],
    ["something new", "Something new."],
  ];
  for (const [reason, sentence] of reasons) assert.equal(displayReason(reason), sentence, reason);
});

test("a desktop whose display never records its mode is deleted with a clear reason", async () => {
  // An ssh whose box never writes the display mode.
  const binary = join(tempDir("no-display-ssh"), "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *display-mode*) exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, proxmox } = setup({}, new MemoryStorage(), { sshBinary: binary });
  await assert.rejects(
    backend.acquire(identity("linux-desktop"), null, hooks().value, signal()),
    /desktop did not start: \/run\/bb-box\/display-mode is missing after 1 s\. Check bb-box-display\.service/,
  );
  assert.deepEqual([...proxmox.guests.values()].filter((guest) => !guest.template), []);
});

test("a warm desktop that starts without its GPU is deleted, and its GPU avoided", async () => {
  const { backend, proxmox, ssh } = setup({ "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b", "proxmox-lxc-desktop-warm": 1 });
  displayAt(ssh.dir, "192.0.2.100", "cpu", "no render node");
  await assert.rejects(backend.maintain(), /A warm linux-desktop box started without GPU gpu-a \(no render node\), so bb-box released it/);
  assert.equal(proxmox.guests.has(7000), false);
  await backend.maintain();
  assert.equal(proxmox.guests.get(7001)?.config.tags?.includes("template.9002"), true, "the next warm desktop goes to gpu-b");
});

test("boxes spread across a flavour's templates", async () => {
  const { backend } = setup({ "proxmox-lxc-linux-templates": "9000 9004" });
  const made = await Promise.all([1, 2, 3].map(() => backend.acquire(identity(), null, hooks().value, signal())));
  assert.deepEqual(
    made.map((guest) => guest.data?.template),
    [9000, 9004, 9000],
  );
});

test("a desktop still being acquired counts once against the GPU limit", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-desktops-per-gpu": 2 });
  const box = identity("linux-desktop");
  let during: number | undefined;
  const hook = hooks();
  const acquired = backend.acquire(box, null, { ...hook.value, starting: async () => {
    const capacity = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting("linux-desktop"), signal());
    during = capacity.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops")?.used;
  } }, signal());
  await acquired;
  assert.equal(during, 1, "the acquiring box is both pending and listed, and counts once");
  assert.equal(proxmox.guests.size, 6);
});

test("an unknown kind is refused", async () => {
  const { backend } = setup({ "proxmox-lxc-desktop-templates": "" });
  await assert.rejects(backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("acquire claims the VMID before it clones, then configures and starts the box", async () => {
  const { backend, proxmox, ssh } = setup();
  const box = identity();
  const hook = hooks();
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) hook.events.push(`clone ${call.params.newid}`);
    return undefined;
  };
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest, {
    ref: "7000",
    host: "pve",
    address: "192.0.2.100",
    size: { cores: 2, memoryMiB: 4096, diskGiB: 8 },
    data: { template: 9000, box: box.boxId },
  });
  assert.deepEqual(hook.claimed[0]?.data, { template: 9000, box: box.boxId }, "the claim records the box");
  assert.deepEqual(hook.events, ["claim 7000", "clone 7000", "starting"]);
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "network", "ssh", "start", "tags", "warm"]);
  assert.ok(!ssh.log().some((entry) => entry.command.includes("bb-box-warm")), "a fresh clone has its name from the start");

  const made = proxmox.guests.get(7000)!;
  assert.equal(made.status, "running");
  assert.equal(made.pool, "bbbox");
  assert.equal(made.name, box.name);
  assert.equal(made.config.cores, "2");
  assert.equal(made.config.memory, "4096");
  assert.equal(made.config.onboot, "1");
  assert.equal(made.config.net0, "name=eth0,bridge=vmbr1,ip=192.0.2.100/24,gw=192.0.2.1,type=veth");
  assert.match(made.config.rootfs!, /size=8G/, "the template's disk is kept");
  assert.equal(made.config.protection, undefined, "the template's protection is dropped");
  assert.equal(proxmox.calls.some((call) => call.path.endsWith("/resize")), false);
  const puts = proxmox.calls.filter((call) => call.method === "PUT" && call.path === "/nodes/pve/lxc/7000/config");
  assert.deepEqual(
    puts.map((call) => Object.keys(call.params).sort()),
    [["cores", "delete", "memory", "net0", "onboot"], ["tags"]],
    "tags go in a PUT of their own",
  );
  const tags = parseTags(made.config.tags);
  assert.deepEqual(tags.slice(0, 2), ["bb-box", "install.test"]);
  assert.equal(tags.at(-1), "template.9000");
  assert.equal(installFromDescription(made.config.description), "test", "the clone's description names the install");
  assert.deepEqual(ownerFromTags(tags), { boxId: box.boxId, threadId: box.threadId, name: null, kind: box.kind, createdAt: box.createdAt });
  assert.equal(ownerFromDescription(made.config.description)?.boxId, box.boxId);

  // The ready check opened the box's shared SSH connection, for its first commands.
  const dials = ssh.log().filter((entry) => entry.target.endsWith("@192.0.2.100"));
  assert.deepEqual(dials.map((entry) => entry.control ?? "command"), ["master", "command"]);
  assert.ok(dials[1]!.args.includes("ControlMaster=no"));
});

/** Swaps template `vmid` as build.sh --replace does: gone, then a copy that is not yet a template, then a template, a step per read of its config. */
function replacing(proxmox: FakeProxmox, vmid: number, gone = 1): { reads: () => number } {
  const template = proxmox.guests.get(vmid)!;
  const { template: _flag, ...copy } = template.config;
  proxmox.guests.delete(vmid);
  let reads = 0;
  proxmox.intercept = (call) => {
    if (call.method !== "GET" || call.path !== `/nodes/pve/lxc/${vmid}/config`) return undefined;
    reads++;
    if (reads === gone + 1) proxmox.guests.set(vmid, { ...template, template: false, config: copy });
    if (reads === gone + 2) proxmox.guests.set(vmid, template);
    return undefined;
  };
  return { reads: () => reads };
}

test("an acquire waits for a template that is being replaced, and says so in the timings", async () => {
  const { backend, proxmox } = setup();
  const swap = replacing(proxmox, 9000);
  const hook = hooks();
  const guest = await backend.acquire(identity(), null, hook.value, signal());
  assert.equal(guest.ref, "7001", "the failed clone's VMID is left behind");
  assert.deepEqual(hook.events, ["claim 7000", "claim 7001", "starting"]);
  assert.equal(swap.reads(), 3, "missing, then not yet a template, then back");
  assert.equal(typeof hook.timings.template, "number");
  assert.deepEqual(Object.keys(hook.timings).slice(0, 3), ["warm", "template", "clone"]);
  assert.equal(proxmox.guests.has(7000), false);
});

test("a clone of the copy that is not yet a template waits for it too", async () => {
  const { backend, proxmox } = setup();
  const swap = replacing(proxmox, 9000, 0);
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.ref, "7001");
  assert.equal(swap.reads(), 2);
  const tasks = proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;
  assert.equal(tasks, 2, "the clone of the copy failed, and the next one worked");
});

test("an acquire fails when the template stays away, naming it and Proxmox's error", async () => {
  const { backend, proxmox } = setup({}, undefined, { templateWaitMs: 0 });
  proxmox.guests.delete(9000);
  await assert.rejects(
    backend.acquire(identity(), null, hooks().value, signal()),
    /^Error: CT template 9000 on pve was still missing, or not yet a template, after 0 s \(.*\(403\): Permission check failed \(\/vms\/9000, VM\.Audit\)\)\. Run the doctor check/,
  );
  assert.equal(proxmox.calls.filter((call) => call.path.endsWith("/clone")).length, 1);
});

test("a clone that fails while its template is there is tried once more, then fails", async () => {
  const { backend, proxmox } = setup();
  proxmox.nextTaskExit.set("vzclone", "no space left on device");
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.ref, "7001", "a template may come back between the failure and the check");

  proxmox.intercept = (call) =>
    call.path.endsWith("/clone")
      ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "no space left on device" }) }
      : undefined;
  const hook = hooks();
  await assert.rejects(backend.acquire(identity(), null, hook.value, signal()), /no space left on device/);
  assert.equal(proxmox.calls.filter((call) => call.path.endsWith("/clone")).length, 4);
  assert.equal(hook.timings.template, undefined);
});

test("the capacity check waits for a template that answers 403 while it is replaced", async () => {
  const { backend, proxmox } = setup();
  let reads = 0;
  proxmox.intercept = (call) => {
    if (call.method !== "GET" || call.path !== "/nodes/pve/lxc/9000/config" || ++reads > 2) return undefined;
    return { ok: false, status: 403, statusText: "Permission check failed (/vms/9000, VM.Audit)", text: async () => JSON.stringify({ data: null }) };
  };
  const capacity = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.equal(capacity.ok, true);
  assert.equal(reads, 4, "two refused, one to see it back, one to read it");
});

test("a larger disk is applied once the box runs", async () => {
  const { backend, proxmox } = setup();
  const states: string[] = [];
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/resize")) states.push(proxmox.guests.get(Number(call.path.split("/")[4]))!.status);
    return undefined;
  };
  const hook = hooks();
  const guest = await backend.acquire(identity("linux", "thr_abc123", { cores: 2, memoryMiB: 4096, diskGiB: 20 }), null, hook.value, signal());
  assert.deepEqual(states, ["running"]);
  assert.match(proxmox.guests.get(7000)!.config.rootfs!, /size=20G/);
  assert.equal(guest.size?.diskGiB, 20, "the size is read back from the guest");
  assert.equal(typeof hook.timings.resize, "number");
});

test("a box is made at the size asked for, and held reads its size from the guest (028)", async () => {
  const { backend, proxmox, make } = setup();
  const guest = await backend.acquire(identity("linux", "thr_abc123", { cores: 4, memoryMiB: 8192, diskGiB: 20 }), null, hooks().value, signal());
  const made = proxmox.guests.get(7000)!;
  assert.equal(made.config.cores, "4");
  assert.equal(made.config.memory, "8192");
  assert.match(made.config.rootfs!, /size=20G/);
  assert.deepEqual(guest.size, { cores: 4, memoryMiB: 8192, diskGiB: 20 });

  // Changed on the host, as an operator might: the guest says what the box has.
  made.config.cores = "6";
  const held = await make().held();
  assert.deepEqual(held.find((other) => other.ref === guest.ref)?.size, { cores: 6, memoryMiB: 8192, diskGiB: 20 });
});

test("a disk smaller than the template's keeps the template's", async () => {
  const { backend, proxmox } = setup();
  const guest = await backend.acquire(identity("linux", "thr_abc123", { cores: 2, memoryMiB: 4096, diskGiB: 4 }), null, hooks().value, signal());
  assert.match(proxmox.guests.get(7000)!.config.rootfs!, /size=8G/);
  assert.equal(proxmox.calls.some((call) => call.path.endsWith("/resize")), false);
  assert.equal(guest.size?.diskGiB, 8);
});

test("VMIDs are handed out round-robin, so a deleted box's address waits its turn", async () => {
  const storage = new MemoryStorage();
  const { backend, make } = setup({ "proxmox-lxc-vmid-last": 7002 }, storage);
  const first = await backend.acquire(identity(), null, hooks().value, signal());
  await backend.release(first, releasing());
  const second = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(second.ref, "7001");
  const third = await make().acquire(identity(), null, hooks().value, signal());
  assert.equal(third.ref, "7002", "a new instance carries on from the stored cursor");
  const fourth = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(fourth.ref, "7000", "the search wraps round to the first free VMID");
});

test("acquire skips a VMID another pool holds", async () => {
  const { backend, proxmox } = setup();
  proxmox.hidden.add(7000);
  const hook = hooks();
  const guest = await backend.acquire(identity(), null, hook.value, signal());
  assert.equal(guest.ref, "7001");
  assert.deepEqual(hook.events, ["claim 7000", "claim 7001", "starting"]);
});

test("a failed acquire deletes what it made", async () => {
  const { backend, proxmox } = setup();
  proxmox.nextTaskExit.set("vzstart", "startup for container '7000' failed");
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /startup for container/);
  assert.equal(proxmox.guests.has(7000), false);
});

test("a clone that fails before it is configured is deleted despite the template's protection", async () => {
  const { backend, proxmox } = setup();
  proxmox.intercept = (call) =>
    call.method === "PUT" && call.params.net0
      ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "no such bridge" }) }
      : undefined;
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /no such bridge/);
  assert.equal(proxmox.guests.has(7000), false);
});

test("a box that never answers on SSH is deleted with a clear reason", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.down("192.0.2.100");
  await assert.rejects(
    backend.acquire(identity(), null, hooks().value, signal()),
    /Port 22 of 192\.0\.2\.100 is open, but SSH as box did not answer.*user box in the linux template accepts bb-box's key/,
  );
  assert.equal(proxmox.guests.has(7000), false);
});

test("a box whose port 22 never opens is deleted with a clear reason", async () => {
  const checked: string[] = [];
  const portCheck = async (host: string, port: number) => {
    checked.push(`${host}:${port}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    return false;
  };
  const { backend, proxmox } = setup({}, new MemoryStorage(), { portCheck });
  await assert.rejects(
    backend.acquire(identity(), null, hooks().value, signal()),
    /Nothing answered on port 22 of 192\.0\.2\.100.*can reach the boxes' subnet/,
  );
  assert.ok(checked.length > 1 && checked.every((target) => target === "192.0.2.100:22"));
  assert.equal(proxmox.guests.has(7000), false);
});

test("acquire resumes the guest of an interrupted acquire", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const first = await backend.acquire(box, null, hooks().value, signal());
  proxmox.guests.get(7000)!.status = "stopped";
  const hook = hooks();
  const again = await backend.acquire(box, first, hook.value, signal());
  assert.deepEqual(again, first);
  assert.deepEqual(hook.events, ["starting"]);
  assert.equal(proxmox.guests.size, 6, "five templates and the one box");

  const other = await backend.acquire(identity(), first, hooks().value, signal());
  assert.equal(other.ref, "7001", "a guest another box owns is not resumed");
});

test("release deletes the guest, and a missing guest counts as released", async () => {
  const { backend, proxmox } = setup();
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.host, "pve");
  const release = releasing();
  await backend.release(guest, release);
  assert.equal(typeof release.timings.delete, "number");
  assert.equal(proxmox.guests.has(7000), false);
  assert.equal(await backend.power(guest), null);
  await backend.release(guest, releasing());
  await assert.rejects(backend.release({ ref: "9000", host: null, address: null, size: null }, releasing()), /outside bb-box's VMID range/);
  assert.equal(proxmox.guests.has(9000), true);
});

test("power, stop and start, and a box's shared SSH connection closes before it stops and before it goes", async () => {
  const { backend, ssh } = setup();
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const run = async () => assert.equal((await (await backend.transports(guest, "linux")).command!.run("true")).exitCode, 0);
  const closed = () => ssh.log().filter((entry) => entry.control === "exit" && entry.target === "box@192.0.2.100").length;
  await run();
  assert.equal(await backend.power(guest), "running");
  await backend.stop(guest);
  assert.equal(closed(), 1);
  assert.equal(await backend.power(guest), "stopped");
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  await run();
  await backend.release(guest, releasing());
  assert.equal(closed(), 2);
  await assert.rejects(backend.start(guest), (error: unknown) => error instanceof BackendError && error.code === "gone");
});

const isGone = (error: unknown) => error instanceof BackendError && error.code === "gone";

test("a reused VMID holds another box: the old box's guest is gone, and acting on it leaves the new box alone", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000 });
  const old = await backend.acquire(identity(), null, hooks().value, signal());
  // Deleted outside bb-box, so the only VMID goes to the next box.
  proxmox.guests.delete(7000);
  const current = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(current.ref, old.ref);
  assert.equal(await backend.power(old), null);
  await assert.rejects(backend.stop(old), isGone);
  await assert.rejects(backend.start(old), isGone);
  await backend.release(old, releasing());
  assert.equal(proxmox.guests.get(7000)?.status, "running", "the new box is untouched");
  assert.equal(await backend.power(current), "running");
});

test("another install's guests count against capacity, and this one leaves them alone", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1, "proxmox-lxc-desktops-per-gpu": 1 });
  await backend.maintain();
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(desktop.ref, "7001");
  const other = track(
    new ProxmoxLxcBackend(
      lxcConfig({
        "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
        "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
        "proxmox-lxc-desktop-templates": "9001 gpu-a",
        "proxmox-lxc-desktops-per-gpu": 1,
        "proxmox-lxc-vmid-first": 7000,
        "proxmox-lxc-vmid-last": 7009,
      }),
      testContext(new MemoryStorage(), "other"),
      fakes(proxmox),
    ),
  );
  assert.deepEqual(await other.held(), []);
  assert.equal(await other.power(desktop), null);
  await assert.rejects(other.stop(desktop), isGone);
  await other.release(desktop, releasing());
  await other.maintain();
  assert.equal(proxmox.guests.get(7001)?.status, "running", "the other install's release left the desktop alone");
  assert.ok(proxmox.guests.has(7000), "the other install, with no warm pool, leaves this one's warm guest");
  assert.equal((await other.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, false, "this install's desktop still uses the GPU");

  const theirs = await other.acquire(identity(), null, hooks().value, signal());
  assert.equal(theirs.ref, "7002", "the other install clones rather than take this one's warm guest");
  assert.deepEqual(parseTags(proxmox.guests.get(7002)!.config.tags).slice(0, 2), ["bb-box", "install.other"]);
  assert.deepEqual((await backend.held()).map((guest) => guest.ref), ["7001"]);
  assert.equal(await backend.power(theirs), null);
});

test("stamp records this install on its guest from before install IDs, and leaves others alone", async () => {
  const { backend, proxmox } = setup();
  const tags = "bb-box;box.box_old;thread.thr_x;kind.linux;template.9000";
  proxmox.guests.set(7005, {
    vmid: 7005,
    name: "old",
    pool: "bbbox",
    status: "running",
    template: false,
    config: { tags, description: "bb-box old\nbox box_old\nthread thr_x" },
  });
  proxmox.guests.set(7006, { vmid: 7006, name: "theirs", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.other;box.box_old" } });
  const guest: Guest = { ref: "7005", host: "pve", address: "192.0.2.105", size: null, data: { template: 9000 } };
  assert.deepEqual(await backend.held(), [], "a guest with no install ID is not this install's yet");

  const wrong = await backend.stamp("box_other", guest);
  assert.deepEqual(wrong.data, { template: 9000, box: "box_other" });
  assert.equal(proxmox.guests.get(7005)!.config.tags, tags, "a guest that names another box is not stamped");
  assert.equal(await backend.power(wrong), null);

  const stamped = await backend.stamp("box_old", guest);
  assert.deepEqual(stamped.data, { template: 9000, box: "box_old" });
  const config = proxmox.guests.get(7005)!.config;
  assert.deepEqual(parseTags(config.tags), ["bb-box", "install.test", "box.box_old", "thread.thr_x", "kind.linux", "template.9000"]);
  assert.equal(config.description, "bb-box old\ninstall test\nbox box_old\nthread thr_x");
  assert.deepEqual(
    (await backend.held()).map((held) => [held.ref, held.owner?.boxId]),
    [["7005", "box_old"]],
  );
  assert.equal(await backend.power(stamped), "running");

  await backend.stamp("box_old", { ref: "7006", host: "pve", address: null, size: null });
  assert.equal(proxmox.guests.get(7006)!.config.tags, "bb-box;install.other;box.box_old", "another install's guest is not stamped");
});

test("held lists this install's guests, labelled or part-made, and leaves others alone", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  await backend.acquire(box, null, hooks().value, signal());
  // Cloned but not yet tagged: only the description names the install and the box.
  proxmox.guests.set(7001, {
    vmid: 7001,
    name: "half",
    pool: "bbbox",
    status: "stopped",
    template: false,
    config: { description: "bb-box half-done\ninstall test\nbox box_x\nthread thr_x\nkind linux\ncreated 2026-09-30T00:00:00.000Z" },
  });
  // A warm guest whose fill was interrupted: this install's, and no box's.
  proxmox.guests.set(7002, { vmid: 7002, name: "filling", pool: "bbbox", status: "stopped", template: false, config: { tags: "bb-box;install.test;filling;template.9000" } });
  proxmox.guests.set(7003, { vmid: 7003, name: "warm", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.test;warm;template.9000" } });
  proxmox.guests.set(7005, {
    vmid: 7005,
    name: "theirs",
    pool: "bbbox",
    status: "running",
    template: false,
    config: { tags: "bb-box;install.other;box.box_y;thread.thr_y;kind.linux" },
  });
  proxmox.guests.set(7006, { vmid: 7006, name: "their-half", pool: "bbbox", status: "stopped", template: false, config: { description: "bb-box their-half\ninstall other\nbox box_z" } });
  proxmox.guests.set(7007, { vmid: 7007, name: "mystery", pool: "bbbox", status: "running", template: false, config: {} });
  proxmox.guests.set(7008, { vmid: 7008, name: "old", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;box.box_old;thread.thr_x;kind.linux" } });
  proxmox.guests.set(8000, { vmid: 8000, name: "outside", pool: "bbbox", status: "running", template: false, config: {} });
  proxmox.guests.set(7004, { vmid: 7004, name: "other-pool", pool: "else", status: "running", template: false, config: {} });

  const held = await backend.held();
  assert.deepEqual(
    held.map((guest) => guest.ref),
    ["7000", "7001", "7002"],
  );
  assert.equal(held[0]!.owner?.boxId, box.boxId);
  assert.equal(held[0]!.owner?.name, box.name);
  assert.equal(held[0]!.power, "running");
  assert.deepEqual(held[0]!.data, { template: 9000, box: box.boxId });
  assert.deepEqual(held[1]!.owner, { boxId: "box_x", threadId: "thr_x", name: "half-done", kind: "linux", createdAt: Date.parse("2026-09-30T00:00:00.000Z") });
  assert.deepEqual(held[1]!.data, { box: "box_x" });
  assert.equal(held[2]!.owner, null);
  assert.deepEqual(held[2]!.data, { template: 9000 }, "a guest of no box carries none");
});

test("a new instance finds the guests the last one held", async () => {
  const { backend, make } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  const restarted = make();
  const held = await restarted.held();
  assert.equal(held.find((other) => other.ref === guest.ref)?.owner?.boxId, box.boxId);
  await restarted.release(guest, releasing());
  assert.deepEqual(await restarted.held(), []);
});

test("transports reach the box over SSH, and desktops over VNC", async () => {
  const { backend, ssh } = setup();
  const headless = await backend.acquire(identity(), null, hooks().value, signal());
  const plain = await backend.transports(headless, "linux");
  assert.deepEqual(plain.displays, []);
  assert.deepEqual(plain.access, {
    ssh: { host: "192.0.2.100", port: 22, user: "box", hostKeys: [] },
    dockerHost: "ssh://box@192.0.2.100",
  });
  const result = await plain.command!.run("echo hi; whoami 2>/dev/null || true", { stdin: "" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^hi\n/);
  assert.ok(ssh.log().some((entry) => entry.target === "box@192.0.2.100"));

  const route = await plain.command!.route!(5900);
  assert.equal(route.type, "command");
  assert.deepEqual(route.type === "command" && route.argv.slice(-3), ["-W", "127.0.0.1:5900", "box@192.0.2.100"]);

  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const [display, ...others] = (await backend.transports(desktop, "linux-desktop")).displays;
  assert.equal(others.length, 0);
  assert.deepEqual([display!.id, display!.label, display!.protocol, display!.resizable, display!.minSize], ["desktop", "Desktop", "rfb", true, { width: 800, height: 600 }]);
  assert.deepEqual(await display!.open(), { route: { type: "tcp", host: "192.0.2.101", port: 5900 }, auth: { type: "none" } });
});

test("a desktop's VNC password is read from the box when a viewer opens it", async () => {
  // An ssh that answers the password file itself, since the fake runs commands on this machine.
  const binary = join(tempDir("vnc-ssh"), "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *vnc-password*) echo hunter2; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, ssh } = setup({}, new MemoryStorage(), { sshBinary: binary });
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const [display] = (await backend.transports(desktop, "linux-desktop")).displays;
  assert.equal(ssh.log().some((entry) => entry.command.includes("vnc-password")), false, "nothing is read before a viewer opens");
  assert.deepEqual((await display!.open()).auth, { type: "vnc-password", password: "hunter2" });
});

test("a GPU desktop is resized with xrandr as the box user, a size X cannot take fails with xrandr's reason, and back on the CPU nothing runs (021)", async () => {
  // An xrandr that records how it ran, since the fake SSH runs commands on this machine.
  const dir = tempDir("xrandr");
  const log = join(dir, "log");
  const refusal = "xrandr: screen cannot be larger than 32767x32767 (desired size 40000x800)";
  writeFileSync(join(dir, "xrandr"), `#!/bin/sh\necho "$DISPLAY $XAUTHORITY $*" >>"${log}"\n[ "$2" != 40000x800 ] || { echo "${refusal}" >&2; exit 1; }\n`, { mode: 0o755 });
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\nPATH="${dir}:$PATH" exec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, ssh } = setup({ "proxmox-lxc-desktop-cpu-templates": "9003" }, new MemoryStorage(), { sshBinary: binary });
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const [display] = (await backend.transports(desktop, "linux-desktop")).displays;
  await display!.resize!({ width: 1600, height: 900 });
  assert.match(readFileSync(log, "utf8"), /^:99 \S*\/run\/bb-box\/Xauthority --fb 1600x900\n$/);
  assert.ok(ssh.log().some((entry) => entry.target.startsWith("box@") && entry.command.includes("xrandr --fb 1600x900")), "it runs as the box user");
  await assert.rejects(display!.resize!({ width: 40000, height: 800 }), { message: `xrandr could not set the desktop to 40000x800: ${refusal}.` });
  await assert.rejects(display!.resize!({ width: 0.5, height: 800 }), { message: "The desktop cannot be 0.5 by 800 pixels." });

  // Its display service restarted without the GPU: Xtigervnc took the viewer's
  // SetDesktopSize, and xrandr would disconnect its output for an older size.
  writeFileSync(join(ssh.dir, "home", "192.0.2.100", "run", "bb-box", "display-mode"), "cpu\n");
  await display!.resize!({ width: 1400, height: 900 });
  assert.doesNotMatch(readFileSync(log, "utf8"), /1400x900/);

  const cpu = await backend.acquire(identity("linux-desktop-cpu"), null, hooks().value, signal());
  const [stream] = (await backend.transports(cpu, "linux-desktop-cpu")).displays;
  assert.equal(stream!.resize, undefined, "Xtigervnc takes a viewer's SetDesktopSize itself");
  assert.deepEqual(stream!.minSize, { width: 800, height: 600 });
});

test("a Wayland desktop signs in as box with Apple's sign-in, and its display script resizes it as the box user (048)", async () => {
  // An ssh that answers the password file and the display script, which the
  // fake would run on this machine, and records each resize.
  const dir = tempDir("wayland");
  const log = join(dir, "log");
  const refusal = "display: Sway cannot set HEADLESS-1 to 40000x800";
  const binary = join(dir, "ssh");
  writeFileSync(
    binary,
    `#!/bin/sh
case "$*" in
  *vnc-password*) echo hunter2; exit 0;;
  *"/usr/local/libexec/bb-box/display resize "*) echo "$*" >>"${log}"; case "$*" in *40000x800*) echo "${refusal}" >&2; exit 1;; esac; exit 0;;
esac
exec "${FAKE_SSH_BINARY}" "$@"
`,
    { mode: 0o755 },
  );
  const { backend, proxmox } = setup({ "proxmox-lxc-desktop-wayland-cpu-templates": "9004" }, new MemoryStorage(), { sshBinary: binary });
  const box = await backend.acquire(identity("linux-desktop-wayland-cpu"), null, hooks().value, signal());
  assert.ok(proxmox.calls.some((call) => call.path.endsWith("/lxc/9004/clone")), "cloned from the Wayland template");
  const [display, ...others] = (await backend.transports(box, "linux-desktop-wayland-cpu")).displays;
  assert.equal(others.length, 0);
  assert.deepEqual((await display!.open()).auth, { type: "apple", user: "box", password: "hunter2" }, "wayvnc offers no VNC password");
  assert.deepEqual(display!.minSize, { width: 800, height: 600 });

  await display!.resize!({ width: 1600, height: 900 });
  assert.match(readFileSync(log, "utf8"), /^.* box@192\.0\.2\.100 -- .*'\/usr\/local\/libexec\/bb-box\/display resize 1600x900'.*\n$/);
  await assert.rejects(display!.resize!({ width: 40000, height: 800 }), { message: `Sway could not set the desktop to 40000x800: ${refusal}.` });
  await assert.rejects(display!.resize!({ width: 0.5, height: 800 }), { message: "The desktop cannot be 0.5 by 800 pixels." });
  assert.equal(readFileSync(log, "utf8").split("\n").length, 3, "an impossible size reaches no box");

  const check = (await backend.doctor()).checks.find((candidate) => candidate.id === "template.9004");
  assert.deepEqual([check?.name, check?.status], ["CPU Wayland desktop template 9004", "ok"]);
});

test("the warm pool fills, hands out a ready guest and refills", async () => {
  const { backend, proxmox, ssh } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const warm = proxmox.guests.get(7000)!;
  assert.equal(warm.status, "running");
  assert.deepEqual(parseTags(warm.config.tags), ["bb-box", "install.test", "warm", "template.9000"]);
  assert.equal(installFromDescription(warm.config.description), "test", "a warm guest names the install from its first write");
  assert.deepEqual(await backend.held(), [], "warm guests belong to no box");

  const box = identity();
  const hook = hooks();
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.equal(guest.ref, "7000");
  assert.deepEqual(hook.events, ["claim 7000", "starting"]);
  assert.equal(ownerFromTags(parseTags(proxmox.guests.get(7000)!.config.tags))?.boxId, box.boxId);
  assert.equal(proxmox.guests.get(7000)!.name, box.name);
  const named = ssh.log().filter((entry) => entry.command.includes("bb-box-warm"));
  assert.equal(named.length, 1, "the guest is named after its box inside, once");
  assert.equal(named[0]!.target, "box@192.0.2.100");
  assert.ok(named[0]!.command.includes(`-c ${quote(warmNameScript(box.name))}`));
  assert.ok("name" in hook.timings);

  // Claiming a warm guest starts a refill; maintain returns the one in flight.
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "install.test", "warm", "template.9000"]);
  const capacity = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });
});

/** A stage for warmNameScript: stand-ins that keep the kernel's hostname in a file, and run as this user. */
function warmNameStage(prefix: string) {
  const dir = tempDir(prefix);
  const bin = join(dir, "bin");
  const etc = join(dir, "etc");
  const auth = join(dir, "Xauthority");
  mkdirSync(bin);
  mkdirSync(etc);
  writeFileSync(join(bin, "hostname"), `#!/bin/sh\nif [ $# -eq 0 ]; then cat '${dir}/kernel'; else printf '%s\\n' "$1" > '${dir}/kernel'; fi\n`);
  writeFileSync(join(bin, "sudo"), `#!/bin/sh\n[ "$1" = -n ] && shift\nexec "$@"\n`);
  for (const tool of ["hostname", "sudo"]) chmodSync(join(bin, tool), 0o755);
  const env = { PATH: `${bin}:/usr/bin:/bin` };
  const name = (kernel: string, hosts: string) => {
    writeFileSync(join(dir, "kernel"), `${kernel}\n`);
    writeFileSync(join(etc, "hostname"), `${kernel}\n`);
    writeFileSync(join(etc, "hosts"), hosts);
    return spawnSync("sh", ["-c", warmNameScript("calm-otter", etc, auth)], { encoding: "utf8", env });
  };
  return { dir, bin, etc, auth, env, name };
}

const HAS_XAUTH = spawnSync("sh", ["-c", "command -v xauth"]).status === 0;

test("a claimed warm guest is named after its box inside, and no other machine is", () => {
  const { dir, bin, etc, name } = warmNameStage("warm-name");
  const run = (kernel: string, hosts: string) => {
    const result = name(kernel, hosts);
    assert.equal(result.status, 0, result.stderr);
    const read = (name: string) => readFileSync(join(name === "kernel" ? dir : etc, name), "utf8");
    return { kernel: read("kernel"), hostname: read("hostname"), hosts: read("hosts") };
  };
  const pve = (line: string) => `127.0.0.1 localhost\n::1 localhost ip6-localhost\n# --- BEGIN PVE ---\n${line}\n# --- END PVE ---\n`;

  assert.deepEqual(run("bb-box-warm", pve("127.0.1.1 bb-box-warm")), {
    kernel: "calm-otter\n",
    hostname: "calm-otter\n",
    hosts: pve("127.0.1.1 calm-otter"),
  });
  assert.equal(run("bb-box-warm", pve("127.0.1.1 bb-box-warm.example bb-box-warm")).hosts, pve("127.0.1.1 calm-otter.example calm-otter"), "with a search domain");
  assert.equal(run("bb-box-warm", "127.0.0.1 localhost\n").hosts, "127.0.0.1 localhost\n127.0.1.1 calm-otter\n", "a hosts file with no such line gains one");
  // A machine not named as a warm guest is left as it is.
  assert.deepEqual(run("workstation", pve("127.0.1.1 workstation")), { kernel: "workstation\n", hostname: "workstation\n", hosts: pve("127.0.1.1 workstation") });
  // When sudo fails, so does the script, though the cookie step after it has nothing to do.
  writeFileSync(join(bin, "sudo"), "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n");
  const refused = name("bb-box-warm", pve("127.0.1.1 bb-box-warm"));
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /a password is required/);
});

test("a spare's guest that changes owner and name is relabelled, and named after its box inside (036)", async () => {
  const { backend, proxmox, ssh } = setup();
  const box = identity("linux", "spare");
  const guest = await backend.acquire(box, null, hooks().value, signal());
  const vmid = Number(guest.ref);
  assert.equal(ownerFromTags(parseTags(proxmox.guests.get(vmid)!.config.tags))?.threadId, "spare");

  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" }, box.name, signal());
  const config = proxmox.guests.get(vmid)!.config;
  const owner = ownerFromTags(parseTags(config.tags));
  assert.deepEqual([owner?.threadId, owner?.boxId], ["operator", box.boxId], "the sweep would restore it to you");
  assert.match(String(config.description), /^bb-box build-1\n/);
  assert.equal(proxmox.guests.get(vmid)!.name, "build-1");
  assert.ok(ssh.log().some((entry) => entry.command.includes(`-c ${quote(nameScript(box.name, "build-1"))}`)), "named inside");
});

test("a guest named after a spare is renamed inside, and only that guest (036)", () => {
  const { dir, etc, auth, env } = warmNameStage("spare-name");
  writeFileSync(join(dir, "kernel"), "polite-pine\n");
  writeFileSync(join(etc, "hostname"), "polite-pine\n");
  writeFileSync(join(etc, "hosts"), "127.0.0.1 localhost\n127.0.1.1 polite-pine\n");
  const run = () => spawnSync("sh", ["-c", nameScript("polite-pine", "build-1", etc, auth)], { encoding: "utf8", env });
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(dir, "kernel"), "utf8"), "build-1\n");
  assert.equal(readFileSync(join(etc, "hosts"), "utf8"), "127.0.0.1 localhost\n127.0.1.1 build-1\n");
  // Now named build-1, it is not polite-pine: a second run changes nothing.
  writeFileSync(join(etc, "hostname"), "kept\n");
  assert.equal(run().status, 0);
  assert.equal(readFileSync(join(etc, "hostname"), "utf8"), "kept\n");
});

test("a claimed warm desktop's display cookie still serves X clients under the box's name", { skip: !HAS_XAUTH && "xauth is not installed" }, () => {
  const { auth, env, name } = warmNameStage("warm-cookie");
  const cookie = "00112233445566778899aabbccddeeff";
  const xauth = (...args: string[]) => {
    const result = spawnSync("xauth", ["-q", "-f", auth, ...args], { encoding: "utf8", env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim().split("\n").sort();
  };
  // xauth nlist: the family, then each field's length and bytes in hex.
  const field = (text: string) => `${Buffer.byteLength(text).toString(16).padStart(4, "0")} ${Buffer.from(text).toString("hex")}`;
  const entry = (family: string, host: string) => `${family} ${field(host)} ${field("99")} ${field("MIT-MAGIC-COOKIE-1")} 0010 ${cookie}`;
  // What the display wrote while the guest was warm: a cookie for its hostname alone.
  xauth("add", "bb-box-warm/unix:99", "MIT-MAGIC-COOKIE-1", cookie);
  assert.deepEqual(xauth("nlist"), [entry("0100", "bb-box-warm")]);

  const result = name("bb-box-warm", "127.0.1.1 bb-box-warm\n");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(xauth("nlist"), [entry("0100", "bb-box-warm"), entry("ffff", "bb-box-warm")], "the same cookie for any hostname");

  // A machine not named as a warm guest keeps its cookies as they are.
  xauth("remove", "bb-box-warm/unix:99");
  xauth("add", "workstation/unix:99", "MIT-MAGIC-COOKIE-1", cookie);
  assert.equal(name("workstation", "127.0.1.1 workstation\n").status, 0);
  assert.deepEqual(xauth("nlist"), [entry("0100", "workstation")]);
});

test("a warm guest satisfies capacity even when memory is short", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  proxmox.memory = { total: 64 * GiB, available: 1 * GiB };
  assert.equal((await backend.capacity("linux", sized("linux"), waiting(), signal())).ok, true);
  assert.equal((await backend.capacity("linux", sized("linux"), waiting("linux"), signal())).ok, false);
});

test("a warm guest waits at its template's size, and serves a box with its cores (028)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const fill = proxmox.calls.filter((call) => call.method === "PUT" && call.path === "/nodes/pve/lxc/7000/config");
  assert.equal(
    fill.some((call) => "cores" in call.params || "memory" in call.params),
    false,
  );
  assert.equal(proxmox.guests.get(7000)!.config.memory, "4096");

  // New cores reach a running container only when Proxmox next rebalances
  // its CPUs, so a box with other cores is a new clone.
  const other = await backend.acquire(identity("linux", "thr_abc123", { cores: 8, memoryMiB: 16384, diskGiB: 30 }), null, hooks().value, signal());
  assert.notEqual(other.ref, "7000");
  assert.equal(proxmox.guests.get(Number(other.ref))!.config.cores, "8");
  assert.equal(proxmox.guests.get(7000)!.config.cores, "2");

  const before = proxmox.calls.length;
  const guest = await backend.acquire(identity("linux", "thr_abc123", { cores: 2, memoryMiB: 16384, diskGiB: 30 }), null, hooks().value, signal());
  assert.equal(guest.ref, "7000");
  const claimed = proxmox.guests.get(7000)!;
  assert.equal(claimed.config.cores, "2");
  assert.equal(claimed.config.memory, "16384");
  assert.match(claimed.config.rootfs!, /size=30G/);
  assert.deepEqual(guest.size, { cores: 2, memoryMiB: 16384, diskGiB: 30 });
  const claim = proxmox.calls.slice(before).filter((call) => call.method === "PUT" && call.path === "/nodes/pve/lxc/7000/config");
  assert.equal(claim.some((call) => "cores" in call.params), false);
});

test("a warm guest needs only the memory a claim adds (028)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  // The warm guest has the template's 4 GiB, and 4 GiB is kept free.
  proxmox.memory = { total: 64 * GiB, available: 9 * GiB };
  const medium = await backend.capacity("linux", { cores: 2, memoryMiB: 8192, diskGiB: null }, waiting(), signal());
  assert.equal(medium.ok, true, "4 GiB more leaves 5 GiB free");
  assert.equal(medium.hosts[0]!.ok, false, "a new guest with 8 GiB would not fit");
  // A box with other cores is a new guest, as the warm one cannot serve it.
  const four = await backend.capacity("linux", { cores: 4, memoryMiB: 8192, diskGiB: null }, waiting(), signal());
  assert.equal(four.ok, false);
  assert.match(four.message!, /^pve has 9 GiB of memory free and keeps 4 GiB free, so a linux box with 8 GiB memory does not fit\./);
  const more = await backend.capacity("linux", { cores: 2, memoryMiB: 10 * 1024, diskGiB: null }, waiting(), signal());
  assert.equal(more.ok, false);
  assert.match(more.message!, /^pve has 9 GiB of memory free and keeps 4 GiB free, so a warm linux box given 10 GiB, which needs 6 GiB more, does not fit\./);
  const most = await backend.capacity("linux", { cores: 2, memoryMiB: 14 * 1024, diskGiB: null }, waiting(), signal());
  assert.match(most.message!, /^pve has 9 GiB of memory free, less than the 10 GiB more a warm linux box given 14 GiB needs\. Release a box or ask for less memory\./);

  // A warm guest has no more cores or disk room than a new one.
  proxmox.memory = { total: 64 * GiB, available: 32 * GiB };
  const cores = await backend.capacity("linux", { cores: 32, memoryMiB: 4096, diskGiB: null }, waiting(), signal());
  assert.equal(cores.message, "pve has 16 CPU threads, fewer than the 32 cores asked for. Ask for at most 16 cores.");
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 100 * GiB });
  const disk = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: 60 }, waiting(), signal());
  assert.match(disk.message!, /^The local-lvm storage on pve has 100 GiB free and keeps 50 GiB free, so a 60 GiB disk, 52 GiB more than the template's, does not fit/);
});

test("an acquire that holds a warm guest needs no other, and counts only the memory it adds (#122)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 2 });
  await backend.maintain();
  // Too little memory for a new guest, so no warm guest is made meanwhile.
  proxmox.memory = { total: 64 * GiB, available: 1 * GiB };
  let started = false;
  let go!: () => void;
  const gate = new Promise<void>((resolve) => (go = resolve));
  const starting = () => ((started = true), gate);
  const acquired = backend.acquire(identity(), null, { ...hooks().value, starting }, signal());
  while (!started) await new Promise((resolve) => setTimeout(resolve, 5));

  // The first box holds one warm guest, so the other serves the next.
  assert.equal((await backend.capacity("linux", sized("linux"), waiting("linux"), signal())).ok, true);
  assert.equal((await backend.capacity("linux", sized("linux"), waiting("linux", "linux"), signal())).ok, false, "unless another acquire waits for it");
  // A new guest has the memory the first box does not add to its warm guest's.
  proxmox.memory = { total: 64 * GiB, available: 9 * GiB };
  const clone = await backend.capacity("linux", { cores: 4, memoryMiB: 4096, diskGiB: null }, waiting("linux"), signal());
  assert.equal(clone.ok, true, "9 GiB free less 4 GiB leaves the 4 GiB kept free");
  assert.equal(clone.hosts[0]!.limits[0]!.used, 55 * 1024);
  go();
  await acquired;
});

test("warm guests beyond the target are removed, and a count changes without the backend being built again (029)", async () => {
  const { backend, proxmox, context, warm } = setup({ "proxmox-lxc-linux-warm": 2 });
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 2);
  warm.linux = 1;
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  warm.linux = 2;
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 2);
  assert.deepEqual(context.errors, []);
});

test("warm guests of a template that build.sh replaced are retired, not handed out", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 1 });
  // In the pool, as build.sh puts it, so the pool's listing shows its tags.
  const template = proxmox.guests.get(9000)!;
  template.pool = "bbbox";
  template.config.tags = "build.one";
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7000)!.config.tags), ["bb-box", "install.test", "warm", "template.9000", "build.one"]);

  // While build.sh --replace copies the new build to the template's VMID, that is not yet a template.
  template.template = false;
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 0, target: 1 });
  // Then it is, with an ID of its own.
  template.template = true;
  template.config.tags = "build.two";
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 0, target: 1 });
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.notEqual(guest.ref, "7000", "the old build's warm guest is not handed out");

  await backend.maintain();
  assert.equal(proxmox.guests.has(7000), false, "it is retired");
  const warm = [...proxmox.guests.values()].filter((other) => parseTags(other.config.tags).includes("warm"));
  assert.deepEqual(
    warm.map((other) => parseTags(other.config.tags)),
    [["bb-box", "install.test", "warm", "template.9000", "build.two"]],
  );
  assert.deepEqual(context.errors, []);
});

test("a warm guest is not ready while its template is away, nor once a template without a build ID gets one", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 1 });
  // Outside the pool, so read on its own.
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7000)!.config.tags), ["bb-box", "install.test", "warm", "template.9000"]);
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 1, target: 1 });

  // As between build.sh removing the old template and making the new one a template.
  const template = proxmox.guests.get(9000)!;
  proxmox.guests.delete(9000);
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 0, target: 1 });
  const cloning: Record<string, string> = { ...template.config, lock: "create" };
  delete cloning.template;
  proxmox.guests.set(9000, { ...template, template: false, config: cloning });
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 0, target: 1 });

  // The first build.sh that stamps it.
  proxmox.guests.set(9000, { ...template, config: { ...template.config, tags: "build.one" } });
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 0, target: 1 });
  await backend.maintain();
  assert.equal(proxmox.guests.has(7000), false);
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "install.test", "warm", "template.9000", "build.one"]);
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 1, target: 1 });
  assert.deepEqual(context.errors, []);
});

test("a warm guest stays ready while a backup locks its template", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 1 });
  // Outside the pool, so read on its own.
  await backend.maintain();
  const template = proxmox.guests.get(9000)!;
  proxmox.guests.set(9000, { ...template, config: { ...template.config, lock: "backup" } });
  assert.deepEqual((await backend.capacity("linux", sized("linux"), waiting(), signal())).warm, { ready: 1, target: 1 });
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7000)?.config.tags), ["bb-box", "install.test", "warm", "template.9000"]);
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  assert.deepEqual(context.errors, []);
});

test("the warm pool stops at the capacity guard", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 3 });
  proxmox.memory = { total: 16 * GiB, available: 9 * GiB };
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) proxmox.memory = { ...proxmox.memory, available: proxmox.memory.available - 2 * GiB };
    return undefined;
  };
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  const [short] = context.short.at(-1)!;
  assert.deepEqual([short!.kinds, short!.count, short!.have], [["linux"], 3, 1]);
  assert.match(short!.reason, /memory free/);
  assert.deepEqual(context.errors, []);
});

test("doctor passes on a complete setup and shows the generated public key", async () => {
  const { backend, storage } = setup({ "proxmox-lxc-ssh-private-key": "" });
  const report = await backend.doctor();
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.summary, "Proxmox VE 9.2.0 on pve");
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.name, check.status]),
    [
      ["proxmox.api", "Proxmox API", "ok"],
      ["proxmox.node", "Node", "ok"],
      ["proxmox.memory", "Node memory", "ok"],
      ["proxmox.sizes", "Box sizes", "ok"],
      ["proxmox.pool", "Resource pool", "ok"],
      ["template.9000", "Linux template 9000", "ok"],
      // Built before images had records (049).
      ["template.9000.image", "Image of Linux template 9000", "warn"],
      ["template.9001", "GPU desktop template 9001 (GPU gpu-a)", "ok"],
      ["template.9001.image", "Image of GPU desktop template 9001 (GPU gpu-a)", "warn"],
      ["proxmox.bridge", "Network bridge", "ok"],
      ["proxmox.vmids", "VMID range", "ok"],
      ["ssh.key", "SSH key", "ok"],
    ],
  );
  assert.match(report.notes.join("\n"), /user box .* accept this SSH key .*: ssh-ed25519 \S+ bb-box$/);
  const stored = await storage.get<{ privateKey: string; publicKey: string }>("ssh-key");
  assert.ok(stored?.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY/);
});

test("doctor judges each template's image by its record, and desktops tell it the host's NVIDIA driver (049)", async () => {
  const { proxmox, context, make, ssh, storage } = setup();
  const day = 24 * 60 * 60 * 1000;
  const [linuxPins, desktopPins, app] = ["l", "d", "a"].map((letter) => letter.repeat(64));
  const images = { pins: async (set: string) => (set === "linux" ? linuxPins! : desktopPins!), bbApp: async () => app! };
  const linux = {
    contract: 1,
    image: "standard",
    kind: "linux",
    arch: "x86_64",
    build: "build.20261003-021500-3f9c",
    built: new Date(Date.now() - day / 2).toISOString(),
    os: "Ubuntu 24.04.3 LTS",
    pins: linuxPins,
    bbApp: app,
    tools: { node: "24.21.0" },
    nvidia: null,
    sizeGiB: 3.3,
  };
  const desktop = { ...linux, kind: "linux-desktop", built: new Date(Date.now() - 20 * day).toISOString(), pins: desktopPins, bbApp: "b".repeat(64), nvidia: "580.95.05" };
  proxmox.guests.get(9000)!.config.description = `bb-box linux template, built 2026-10-03. See /usr/share/bb-box/template-release inside.\n${JSON.stringify(linux)}`;
  proxmox.guests.get(9001)!.config.description = `bb-box desktop template (GPU 0000:01:00.0), built 2026-09-13.\n${JSON.stringify(desktop)}\n`;
  const backend = make({ ...context, images });
  const image = async (vmid: number, on = backend) => (await on.doctor()).checks.find((check) => check.id === `template.${vmid}.image`)!;

  const fresh = await image(9000);
  assert.deepEqual([fresh.status, fresh.fix], ["ok", null]);
  assert.match(fresh.detail, /^Standard image build\.20261003-021500-3f9c, built \d+ \w+ \(today\): Ubuntu 24\.04\.3 LTS, node 24\.21\.0, 3\.3 GiB\.$/);
  const stale = await image(9001);
  assert.equal(stale.status, "warn");
  assert.match(stale.detail, /It is 20 days old, more than 14, .* another build of BB's app than BB's server gives/);
  assert.equal(stale.fix, "Rebuild it with the setup guide's template/build.sh, as root on pve: build.sh desktop 9001 --gpu <its GPU's PCI address> --replace.");

  // A desktop box sees the host's driver, newer than the template's userspace.
  const version = join(ssh.dir, "home", "192.0.2.100", "sys", "module", "nvidia");
  mkdirSync(version, { recursive: true });
  writeFileSync(join(version, "version"), "590.44.01\n");
  await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal((await storage.get<{ version: string }>("nvidia-host"))?.version, "590.44.01");
  for (const on of [backend, make({ ...context, images })]) {
    const gpu = await image(9001, on);
    assert.equal(gpu.status, "fail");
    assert.match(gpu.detail, /It has NVIDIA userspace 580\.95\.05, but the host has driver 590\.44\.01, as a box saw on \d+ \w+, so its desktops start without the GPU\./);
    assert.equal((await image(9000, on)).status, "ok", "a Linux template has no NVIDIA userspace");
  }
  assert.deepEqual(context.errors, []);
});

test("image operations: a box from a template, its capture as a template with its record, a trial box, and the template replaced in place (049)", async () => {
  // An ssh that answers the build box's record, as finalizing leaves it, and otherwise runs as the fake does.
  const dir = tempDir("image-ops");
  const record = { contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261003-021500-3f9c", built: "2026-10-03T02:15:00Z", os: "Ubuntu 24.04.5 LTS", tools: { node: "24.21.0" } };
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *"cat /usr/share/bb-box/image.json"*) echo '${JSON.stringify(record)}'; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, proxmox } = setup({}, new MemoryStorage(), { sshBinary: binary });
  proxmox.guests.get(9000)!.config.tags = "build.20260926-060000-a1b2";
  proxmox.guests.get(9000)!.config.description = "bb-box linux template, built 2026-09-26. See /usr/share/bb-box/template-release inside.";
  proxmox.guests.get(9000)!.config.net0 = "name=eth0,bridge=vmbr1,ip=manual,type=veth";
  proxmox.guests.get(9000)!.config.hostname = "bb-box-linux";
  const images = backend.images;

  const listed = await images.list();
  const standard = listed.builds.find((build) => build.ref === "9000")!;
  assert.deepEqual(
    [standard.image, standard.kind, standard.build, standard.record, standard.current],
    ["standard", "linux", "build.20260926-060000-a1b2", null, true],
  );
  assert.deepEqual(listed.boxes, []);

  // The build box: a clone at a box's VMID and address, which no sweep takes.
  const box = await images.box(standard, "refresh of 9000", signal());
  assert.equal(box.ref, "7000");
  const guest = proxmox.guests.get(7000)!;
  assert.deepEqual([guest.status, parseTags(guest.config.tags)], ["running", ["bb-box", "install.test", "image-box", "template.9000"]]);
  assert.match(guest.config.net0!, /ip=192\.0\.2\.100\//);
  assert.equal((await box.command.run("echo in the box")).stdout, "in the box\n");
  assert.deepEqual(await backend.held(), [], "not a box's guest");
  assert.deepEqual((await images.list()).boxes, ["7000"]);

  // The capture: stopped, a template configured as the one it came from, with the record and the build's tags.
  const captured = await images.capture(box, standard, "standard", signal());
  assert.deepEqual([captured.ref, captured.build, captured.current, captured.record?.build], ["7000", "build.20261003-021500-3f9c", false, "build.20261003-021500-3f9c"]);
  assert.deepEqual([guest.template, guest.status, guest.config.protection, guest.config.net0, guest.config.hostname], [true, "stopped", "1", "name=eth0,bridge=vmbr1,ip=manual,type=veth", "bb-box-linux"]);
  assert.deepEqual(parseTags(guest.config.tags), ["bb-box", "install.test", "image.standard", "kind.linux", "template.9000", "build.20261003-021500-3f9c"]);
  assert.deepEqual(recordInDescription(guest.config.description!), parseImageRecord(record));
  assert.deepEqual(await backend.held(), [], "a captured build is no box's, though the listing does not yet say it is a template");
  const builds = (await images.list()).builds;
  assert.deepEqual(builds.map((build) => [build.ref, build.image, build.current]), [["9000", "standard", true], ["9001", "standard", true], ["7000", "standard", false]]);

  // A trial box from the build, then removed; what is not an image's stays.
  const trial = await images.box(captured, "trial of build.20261003-021500-3f9c", signal());
  assert.equal(trial.ref, "7001");
  assert.equal(proxmox.guests.get(7001)!.config.rootfs!.split(",")[0], "local-lvm:base-7000-disk-0/vm-7001-disk-0");
  await images.remove(trial.ref, signal());
  assert.equal(proxmox.guests.has(7001), false);
  await assert.rejects(images.remove("9000", signal()), /CT 9000 is not an image box or build of this install's/);

  // The replace: 9000 goes, the build is cloned into its VMID and made a template, and the build goes.
  proxmox.statusPass();
  const before = proxmox.calls.length;
  const replaced = await images.replace(captured, standard, signal());
  assert.deepEqual([replaced.ref, replaced.current, replaced.build], ["9000", true, "build.20261003-021500-3f9c"]);
  assert.equal(proxmox.guests.has(7000), false);
  const template = proxmox.guests.get(9000)!;
  assert.deepEqual([template.template, template.config.protection, template.config.hostname], [true, "1", "bb-box-linux"]);
  assert.deepEqual(parseTags(template.config.tags), ["build.20261003-021500-3f9c"]);
  assert.match(template.config.description!, /^bb-box linux template, refreshed \d{4}-\d{2}-\d{2}\. See \/usr\/share\/bb-box\/template-release inside\.\n\{"contract":1,/);
  assert.equal(template.config.rootfs!.split(",")[0], "local-lvm:base-7000-disk-0/base-9000-disk-0", "a linked clone on LVM-thin");
  assert.deepEqual(
    proxmox.calls
      .slice(before)
      .filter((call) => /\/lxc\/(9000|7000)(\/(clone|template))?$/.test(call.path) && call.method !== "GET")
      .map((call) => `${call.method} ${call.path.replace(/^\/nodes\/pve/, "")}`),
    ["DELETE /lxc/9000", "POST /lxc/7000/clone", "POST /lxc/9000/template", "DELETE /lxc/7000"],
  );
  const after = (await images.list()).builds.find((build) => build.ref === "9000")!;
  assert.deepEqual([after.build, after.record?.build], ["build.20261003-021500-3f9c", "build.20261003-021500-3f9c"]);
  // A box from the replaced template, as any.
  const box2 = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(templateFromTags(parseTags(proxmox.guests.get(Number(box2.ref))!.config.tags)), 9000);
});

test("image operations replace a template on storage other than LVM-thin with a full copy, as a linked clone there needs its origin (049)", async () => {
  const dir = tempDir("image-ops-full");
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *"cat /usr/share/bb-box/image.json"*) echo '{"contract":1,"kind":"linux","build":"build.x","built":"2026-10-03T00:00:00Z"}'; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, proxmox } = setup({}, new MemoryStorage(), { sshBinary: binary });
  proxmox.storageTypes.set("local-lvm", "lvm");
  const standard = (await backend.images.list()).builds.find((build) => build.ref === "9000")!;
  const box = await backend.images.box(standard, "refresh", signal());
  const captured = await backend.images.capture(box, standard, "standard", signal());
  await backend.images.replace(captured, standard, signal());
  const clone = proxmox.calls.find((call) => call.path.endsWith("/lxc/7000/clone"))!;
  assert.deepEqual([clone.params.full, clone.params.storage, clone.params.newid], ["1", "local-lvm", "9000"]);
  assert.equal(proxmox.guests.get(9000)!.config.rootfs!.split(",")[0], "local-lvm:base-9000-disk-0");
  assert.equal(proxmox.guests.has(7000), false);
});

test("doctor warns about a kind the node cannot hold at any preset (#74)", async () => {
  const { backend, proxmox } = setup();
  proxmox.cpus = 2;
  const report = await backend.doctor();
  const sizes = report.checks.find((check) => check.id === "proxmox.sizes")!;
  assert.equal(sizes.status, "warn");
  assert.equal(
    sizes.detail,
    "pve has 2 CPU threads and 64 GiB memory, and keeps 4 GiB free. It cannot hold a linux-desktop box at any of its presets, the smallest 4 cores, 8 GiB memory.",
  );
  assert.match(sizes.fix!, /^Give pve more cores, or make the presets of linux-desktop smaller/);
});

test("doctor shows this install's ID and counts the containers it leaves alone", async () => {
  const { backend, proxmox } = setup();
  await backend.acquire(identity(), null, hooks().value, signal());
  proxmox.guests.set(7005, { vmid: 7005, name: "theirs", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.other;box.box_y" } });
  proxmox.guests.set(7006, { vmid: 7006, name: "their-half", pool: "bbbox", status: "stopped", template: false, config: { description: "bb-box their-half\ninstall other\nbox box_z" } });
  proxmox.guests.set(7007, { vmid: 7007, name: "mystery", pool: "bbbox", status: "running", template: false, config: {} });
  proxmox.guests.set(7008, { vmid: 7008, name: "old", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;box.box_old" } });
  const report = await backend.doctor();
  const notes = report.notes.join("\n");
  assert.match(notes, /^This install's ID is test\. Its containers carry the tag install\.test\.$/m);
  assert.match(
    notes,
    /^This install leaves alone 2 containers of install other, 2 containers with no install ID in pool bbbox\. They still count against the host's capacity\. .* bb box install-id --set <id>\.$/m,
  );
});

test("doctor says what is missing", async () => {
  const { backend, proxmox } = setup();
  proxmox.pools.clear();
  proxmox.bridges.delete("vmbr1");
  proxmox.guests.get(9000)!.config.features = "";
  proxmox.guests.delete(9001);
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId["proxmox.pool"]!.status, "fail");
  assert.match(byId["proxmox.pool"]!.fix!, /pveum pool add bbbox/);
  assert.match(byId["template.9000"]!.fix!, /pct set 9000 --features nesting=1/);
  assert.match(byId["template.9001"]!.detail, /CT 9001 does not exist on pve/);
  assert.match(byId["template.9001"]!.fix!, /remove it from the GPU desktop templates/);
  assert.match(byId["proxmox.bridge"]!.detail, /pve has no vmbr1/);
  assert.match(report.summary, /^Resource pool: /);
});

test("doctor warns, without failing, when every VMID is in use", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000, "proxmox-lxc-ssh-private-key": "" });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bbbox", status: "running", template: false, config: {} });
  const report = await backend.doctor();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === "fail")));
  const vmids = report.checks.find((check) => check.id === "proxmox.vmids")!;
  assert.equal(vmids.status, "warn");
  assert.match(vmids.fix!, /widen the VMID range/);
});

test("doctor with a wrong token skips the rest and never shows the secret", async () => {
  const { backend } = setup({ "proxmox-lxc-token-secret": "wrong-secret-value" });
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  assert.equal(report.checks[0]!.status, "fail");
  assert.match(report.checks[0]!.fix!, /token ID and secret/);
  assert.ok(report.checks.slice(1, -1).every((check) => check.status === "skipped"));
  assert.doesNotMatch(JSON.stringify(report), /wrong-secret-value|s3cret-token-value/);
});

test("errors never contain the token secret", async () => {
  const { backend } = setup({ "proxmox-lxc-token-secret": "wrong-secret-value" });
  await assert.rejects(backend.capacity("linux", sized("linux"), waiting(), signal()), (error: unknown) => {
    assert.doesNotMatch(String(error), /wrong-secret-value/);
    return true;
  });
});

test("dispose stops a warm fill", async () => {
  const { backend } = setup({ "proxmox-lxc-linux-warm": 1 });
  const fill = backend.maintain();
  await backend.dispose();
  await fill.catch(() => undefined);
});

test("a box is from its template as built now only while the template has the build it was cloned from (#227)", async () => {
  const { backend, proxmox } = setup();
  const template = proxmox.guests.get(9000)!;
  template.config.tags = "build.20260920-000000-aaaa";
  const before = identity();
  const old = await backend.acquire(before, null, hooks().value, signal());
  assert.equal(old.data?.build, "20260920-000000-aaaa", "the build is read before the clone and kept with the guest");
  assert.equal(await backend.asOffered(old, "linux", before.createdAt), true);
  // build.sh --replace begins a new build; boxes cloned until it swaps come from the old one.
  const during = { ...identity(), createdAt: Date.UTC(2026, 8, 25, 0, 30) };
  const cloned = await backend.acquire(during, null, hooks().value, signal());
  // The swap: the same VMID with the new build. On LVM-thin both boxes keep running.
  template.config.tags = "build.20260925-000000-bbbb";
  assert.equal(await backend.asOffered(old, "linux", before.createdAt), false, "made before the replace");
  assert.equal(await backend.asOffered(cloned, "linux", during.createdAt), false, "made during the build, before the swap");

  // A box from before bb-box recorded builds goes by the build's time.
  const { build: _, ...data } = old.data!;
  const unrecorded = { ...old, data };
  assert.equal(await backend.asOffered(unrecorded, "linux", before.createdAt), false, "made before the build began");
  assert.equal(await backend.asOffered(unrecorded, "linux", Date.UTC(2026, 8, 26)), true, "made after it began");
  assert.equal(await backend.asOffered(old, "linux-desktop", before.createdAt), false, "not a template of the kind");
  template.config.tags = "";
  assert.equal(await backend.asOffered(unrecorded, "linux", Date.UTC(2026, 8, 26)), false, "a template with no build keeps what boxes have");
});
