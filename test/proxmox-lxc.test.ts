import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, displayReason, namesGpu, parseGpuReport, warmNameScript, nameScript, type LxcBackendOptions } from "../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { installFromDescription, ownerFromDescription, ownerFromTags, templateFromTags } from "../src/backends/proxmox/owner.ts";
import { parseImageRecord, recordInDescription } from "../src/backends/images.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type MachineSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { gpuWhenNotAsked } from "../src/core/gpu.ts";
import { quote } from "../src/transports/process.ts";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { judgeGpuHelper, parseGpuHelper } from "../src/backends/proxmox-lxc/gpu-helper.ts";
import { FAKE_TOKEN, FakeProxmox, TOKEN_ROLE } from "./fake-proxmox.ts";
import { CARD_A, CARD_B, FakeNode, REPORT_VMID, cardLines, marker } from "./gpu-helper/node.ts";
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
const sized = (kind: string): MachineSize => defaultSize(kindSizes(kind));
const waiting = (...kinds: string[]) => kinds.map((kind) => ({ kind, size: sized(kind) }));

let boxCounter = 0;
function identity(kind = "linux", threadId = "thr_abc123", size = sized(kind)): BoxIdentity {
  boxCounter++;
  return { boxId: `box_${boxCounter}`, threadId, name: `calm-otter-${boxCounter}`, kind, createdAt: 1_790_000_000_000, size: { ...size, gpu: gpuWhenNotAsked(kind) } };
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
  assert.deepEqual(
    desktop.capabilities.displays,
    [{ id: "desktop", protocol: "rfb", resizable: true }, { id: "selkies", protocol: "selkies", resizable: true, cursor: "selkies", byChoice: true }, { id: "voxl", protocol: "voxl", resizable: true, byChoice: true }],
    "xrandr resizes the GPU's screen, and video with NVENC is there by choice (#863), and voxl by choice (072)",
  );
  assert.equal(desktop.capabilities.gpu, true);
  const cpu = setup({ "proxmox-lxc-desktop-cpu-templates": "9003" }).backend.kinds().find((kind) => kind.id === "linux-desktop-cpu")!;
  assert.equal(cpu.capabilities.gpu, false);
  assert.deepEqual(
    cpu.capabilities.displays,
    [
      { id: "desktop", protocol: "rfb", resizable: true },
      { id: "selkies", protocol: "selkies", resizable: true, cursor: "selkies" },
      { id: "voxl", protocol: "voxl", resizable: true, byChoice: true },
    ],
    "Xtigervnc resizes, and Selkies streams it beside (056), and voxl by choice (072)",
  );
  assert.deepEqual(cpu.capabilities.computerUse, desktop.capabilities.computerUse);
  const wayland = setup({ "proxmox-lxc-desktop-wayland-cpu-templates": "9004" }).backend.kinds().find((kind) => kind.id === "linux-desktop-wayland-cpu")!;
  assert.equal(wayland.label, "Linux desktop on Wayland");
  assert.equal(wayland.capabilities.gpu, false);
  assert.deepEqual(wayland.capabilities.features, ["docker"]);
  assert.deepEqual(
    wayland.capabilities.displays,
    [
      { id: "desktop", protocol: "rfb", resizable: true, refresh: "viewer" },
      { id: "selkies", protocol: "selkies", resizable: true, tellSize: "first" },
    ],
    "Sway resizes through the backend (048), and wayvnc sends no still area again, so the viewer asks (056); video by default, with no way to leave the cursor out, and Selkies told a size before Sway takes it (060)",
  );
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

  const unlimited = await setup({ "proxmox-lxc-desktops-per-gpu": 0 }).backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
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

/** Makes nvidia-smi in the box at `host` say the GPU has `free` of `total` MiB free. */
function gpuAt(ssh: { home(host: string): string }, host: string, free: number, total: number): void {
  const bin = join(ssh.home(host), "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\necho '${free}, ${total}'\n`, { mode: 0o755 });
}

const gpuCheck = async (backend: ProxmoxLxcBackend, gpu = "gpu-a") => (await backend.doctor()).checks.find((check) => check.id === `gpu.${gpu}`);

test("a GPU's memory is read as a desktop on it starts and each minute while one runs, for capacity, the doctor and gpuRoom (#603)", async () => {
  let now = 1_790_000_000_000;
  const { backend, ssh, storage } = setup({}, new MemoryStorage(), { now: () => now });
  assert.deepEqual(await backend.gpuRoom("linux-desktop"), { readings: [], fullUntil: null }, "nothing is read before a desktop starts");
  assert.deepEqual(
    await gpuCheck(backend),
    {
      id: "gpu.gpu-a",
      name: "GPU gpu-a",
      status: "skipped",
      detail: "No desktop has read its memory yet. A GPU desktop reads it as it starts, and bb-box reads it every few minutes while one runs.",
      fix: null,
    },
  );

  await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.deepEqual(await backend.gpuRoom("linux-desktop"), { readings: [{ id: "gpu-a", freeMiB: 7800, totalMiB: null, at: now, neededMiB: 384, source: "desktop" }], fullUntil: null });
  assert.deepEqual(await backend.gpuRoom("linux"), { readings: [], fullUntil: null, parts: ["none"], withheld: "pve: it has no GPU helper to give a box a card" }, "a server has no GPU on a node without the GPU helper");
  const booted = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(booted.hosts[0]!.limits.find((limit) => limit.resource === "gpu-memory"), undefined, "the display service gives no total");

  gpuAt(ssh, "192.0.2.100", 6100, 8192);
  await backend.maintain();
  assert.equal((await backend.gpuRoom("linux-desktop")).readings[0]!.freeMiB, 7800, "not read again within a minute");
  now += 60_000;
  await backend.maintain();
  assert.deepEqual((await backend.gpuRoom("linux-desktop")).readings, [{ id: "gpu-a", freeMiB: 6100, totalMiB: 8192, at: now, neededMiB: 384, source: "desktop" }]);
  const read = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(read.ok, true);
  assert.deepEqual(read.hosts[0]!.limits.at(-1), { resource: "gpu-memory", id: "gpu-a", used: 2092, total: 8192, reserve: 0, unit: "MiB" });
  assert.deepEqual(await storage.get("gpu-readings"), { "gpu-a": { freeMiB: 6100, totalMiB: 8192, at: now } }, "kept for the next instance");

  now += 3 * 60_000;
  gpuAt(ssh, "192.0.2.100", 5000, 8192);
  const check = await gpuCheck(backend);
  assert.equal(check?.status, "ok");
  assert.equal(check?.detail, "5000 of 8192 MiB free, read just now in a desktop. A desktop needs 384 MiB.", "the doctor reads it again");
});

test("a desktop goes to a GPU with room, and is refused at once while every GPU was last read full, offering CPU desktops (#603)", async () => {
  let now = 1_790_000_000_000;
  const { backend, ssh } = setup(
    { "proxmox-lxc-desktop-templates": "9001 gpu-a\n9002 gpu-b", "proxmox-lxc-desktop-cpu-templates": "9003" },
    new MemoryStorage(),
    { ...RETRY, now: () => now },
  );
  displayAt(ssh.dir, "192.0.2.100", "cpu", "GPU has 103 MiB free, below MIN_FREE_VRAM_MIB=384");
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(desktop.data?.template, 9002);
  assert.equal((await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, true, "gpu-b has room");

  now += 60_000;
  gpuAt(ssh, "192.0.2.101", 21, 8192);
  await backend.maintain();
  const full = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(full.ok, false);
  assert.equal(full.hosts[0]!.ok, false);
  assert.equal(
    full.message,
    "Every GPU on pve had less than the 384 MiB free a desktop needs, 1 minute ago: gpu-a 103 MiB, gpu-b 21 MiB. " +
      "Use a linux-desktop-cpu box, whose desktop runs without a GPU, or try again in 4 minutes.",
  );
  assert.equal((await backend.capacity("linux-desktop-cpu", sized("linux-desktop-cpu"), waiting(), signal())).ok, true, "CPU desktops use no GPU");
  const warn = await gpuCheck(backend, "gpu-b");
  assert.equal(warn?.status, "warn");
  assert.equal(warn?.detail, "21 of 8192 MiB free, read just now in a desktop. A desktop needs 384 MiB, so new desktop boxes cannot use this GPU.");
  assert.equal(warn?.fix, "Free memory on the GPU: release a desktop box, or stop what else uses it on pve. Use linux-desktop-cpu boxes meanwhile.");

  const room = await backend.gpuRoom("linux-desktop");
  assert.deepEqual(room.readings.map((gpu) => [gpu.id, gpu.freeMiB]), [["gpu-a", 103], ["gpu-b", 21]]);
  assert.equal(room.fullUntil, now + 4 * 60_000, "until gpu-a's reading is 5 minutes old");

  await backend.release(desktop, releasing());
  assert.equal((await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, true, "releasing gpu-b's desktop frees its memory");
  assert.equal((await backend.gpuRoom("linux-desktop")).fullUntil, null);
});

test("readings of full GPUs stand for 5 minutes, and a new instance keeps them (#603)", async () => {
  let now = 1_790_000_000_000;
  const storage = new MemoryStorage();
  await storage.set("gpu-readings", { "gpu-a": { freeMiB: 103, totalMiB: 8192, at: now } });
  const { backend } = setup({}, storage, { now: () => now });
  const full = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(
    full.message,
    "The GPU on pve had less than the 384 MiB free a desktop needs, just now: gpu-a 103 MiB. Free memory on a GPU, or try again in 5 minutes.",
  );
  now += 5 * 60_000;
  const later = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(later.ok, true, "an old reading does not refuse: the desktop starts and sees");
  assert.equal((await backend.gpuRoom("linux-desktop")).fullUntil, null);
  assert.deepEqual(later.hosts[0]!.limits.at(-1), { resource: "gpu-memory", id: "gpu-a", used: 8089, total: 8192, reserve: 0, unit: "MiB" });
});

const UUID_A = "GPU-8f3c1a2b-0000-4000-8000-00000000000a";
const UUID_B = "GPU-8f3c1a2b-0000-4000-8000-00000000000b";

/** The notes host/bb-box-gpu-memory writes, with each GPU's free and total MiB, written `at` (ms). */
function reportNotes(at: number, gpus: readonly [uuid: string, bus: string, free: number][]): string {
  return [
    "bb-box: each GPU's memory, from bb-box-gpu-memory.timer on this host. Do not edit.",
    "",
    `    at ${Math.floor(at / 1000)}`,
    ...gpus.map(([uuid, bus, free], index) => `    gpu ${uuid} ${bus} ${index} ${free} 8192`),
  ].join("\n");
}

/** The never-started VM whose notes carry the host's report, as host/setup-gpu-report.sh makes it. */
function reportVm(proxmox: FakeProxmox, notes: string, vmid = 9190): void {
  proxmox.guests.set(vmid, { vmid, type: "qemu", name: "bb-box-gpu-memory", status: "stopped", template: false, config: { name: "bb-box-gpu-memory", description: notes } });
}

test("the host's GPU report reads as written, and names a GPU by its UUID, PCI address or index (#603)", () => {
  const notes = reportNotes(1_790_000_000_000, [
    [UUID_A, "00000000:01:00.0", 103],
    [UUID_B, "00000000:02:00.0", 6100],
  ]);
  const report = parseGpuReport(notes)!;
  assert.deepEqual(report, {
    at: 1_790_000_000_000,
    gpus: [
      { uuid: UUID_A, bus: "00000000:01:00.0", index: "0", freeMiB: 103, totalMiB: 8192 },
      { uuid: UUID_B, bus: "00000000:02:00.0", index: "1", freeMiB: 6100, totalMiB: 8192 },
    ],
  });
  assert.equal(parseGpuReport("Notes the operator wrote."), null);
  const [a] = report.gpus;
  for (const id of [UUID_A, UUID_A.toLowerCase(), "0000:01:00.0", "01:00.0", "00000000:01:00.0", "0"]) assert.equal(namesGpu(id, a!), true, id);
  for (const id of [UUID_B, "0000:02:00.0", "1", "gpu-a"]) assert.equal(namesGpu(id, a!), false, id);
});

test("a GPU the host reports has room again as soon as the host says so, and readings in desktops stand in when its report is old (#603)", async () => {
  let now = 1_790_000_000_000;
  const { backend, proxmox } = setup(
    { "proxmox-lxc-desktop-templates": `9001 ${UUID_A}\n9002 0000:02:00.0`, "proxmox-lxc-desktop-cpu-templates": "9003" },
    new MemoryStorage(),
    { now: () => now },
  );
  reportVm(proxmox, reportNotes(now - 30_000, [
    [UUID_A, "00000000:01:00.0", 103],
    [UUID_B, "00000000:02:00.0", 21],
  ]));
  const full = await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal());
  assert.equal(
    full.message,
    `Every GPU on pve had less than the 384 MiB free a desktop needs, just now: ${UUID_A} 103 MiB, 0000:02:00.0 21 MiB. ` +
      "Use a linux-desktop-cpu box, whose desktop runs without a GPU, or try again in 1 minute.",
  );
  assert.deepEqual(
    full.hosts[0]!.limits.filter((limit) => limit.resource === "gpu-memory"),
    [
      { resource: "gpu-memory", id: UUID_A, used: 8089, total: 8192, reserve: 0, unit: "MiB" },
      { resource: "gpu-memory", id: "0000:02:00.0", used: 8171, total: 8192, reserve: 0, unit: "MiB" },
    ],
  );
  assert.deepEqual(await backend.gpuRoom("linux-desktop"), {
    readings: [
      { id: UUID_A, freeMiB: 103, totalMiB: 8192, at: now, neededMiB: 384, source: "host" },
      { id: "0000:02:00.0", freeMiB: 21, totalMiB: 8192, at: now, neededMiB: 384, source: "host" },
    ],
    fullUntil: now + 60_000,
  });

  // Other work frees the second GPU; bb-box reads the report again within 10 s.
  reportVm(proxmox, reportNotes(now, [
    [UUID_A, "00000000:01:00.0", 103],
    [UUID_B, "00000000:02:00.0", 7000],
  ]));
  assert.equal((await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, false, "a read serves 10 s");
  now += 10_000;
  assert.equal((await backend.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, true);
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.equal(desktop.data?.template, 9002, "the full GPU is skipped");

  const report = await backend.doctor();
  const check = (id: string) => report.checks.find((candidate) => candidate.id === id);
  assert.deepEqual([check("proxmox.gpu-report")?.status, check("proxmox.gpu-report")?.detail], ["ok", "The host reports 2 GPUs in VM 9190, written just now."]);
  assert.equal(check(`gpu.${UUID_A}`)?.detail, "103 of 8192 MiB free, read just now from the host's report. A desktop needs 384 MiB, so new desktop boxes cannot use this GPU.");

  // A report 10 minutes old no longer stands: the desktops' own readings do.
  now += 10 * 60_000;
  assert.deepEqual(
    (await backend.gpuRoom("linux-desktop")).readings.map((reading) => [reading.id, reading.freeMiB, reading.source]),
    [["0000:02:00.0", 7800, "desktop"]],
  );
  const stale = (await backend.doctor()).checks.find((candidate) => candidate.id === "proxmox.gpu-report");
  assert.deepEqual([stale?.status, stale?.detail], ["warn", "The host's report in VM 9190 is from 10 minutes ago, so bb-box reads GPU memory in desktops."]);
  assert.equal(stale?.fix, "Run systemctl status bb-box-gpu-memory.timer as root on pve, and check the host's clock.");
});

const GPU_REPORTER = new URL("../setup/proxmox-lxc/host/bb-box-gpu-memory", import.meta.url).pathname;

/** host/bb-box-gpu-memory with a fake nvidia-smi, qm and clock, and a VM 9190 named for it unless `vm` is false. */
function gpuReporter(vm = true) {
  const dir = tempDir("gpu-reporter");
  const bin = join(dir, "bin");
  const configs = join(dir, "qemu-server");
  mkdirSync(bin);
  mkdirSync(configs);
  mkdirSync(join(dir, "calls"));
  if (vm) writeFileSync(join(configs, "9190.conf"), "memory: 16\nname: bb-box-gpu-memory\nprotection: 1\n");
  writeFileSync(join(configs, "100.conf"), "name: something-else\n");
  writeFileSync(join(bin, "nvidia-smi"), `#!/bin/sh\ncat "${join(dir, "smi")}"\n`, { mode: 0o755 });
  writeFileSync(join(bin, "date"), `#!/bin/sh\ncat "${join(dir, "now")}"\n`, { mode: 0o755 });
  // Each call's arguments, then its notes.
  writeFileSync(
    join(bin, "qm"),
    `#!/bin/sh\nn=$(ls "${join(dir, "calls")}" | wc -l)\necho "$1 $2 $3" >"${join(dir, "calls")}/$n.args"\nprintf '%s' "$4" >"${join(dir, "calls")}/$n.notes"\n`,
    { mode: 0o755 },
  );
  const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
  return {
    run(now: number, smi: string) {
      writeFileSync(join(dir, "now"), `${now}\n`);
      writeFileSync(join(dir, "smi"), smi);
      return spawnSync(bash, [GPU_REPORTER], {
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, BBBOX_QEMU_CONFIGS: configs, BBBOX_GPU_REPORT_STATE: join(dir, "last") },
      });
    },
    /** The notes of each qm set, oldest first. */
    writes(): string[] {
      const calls = readdirSync(join(dir, "calls")).filter((name) => name.endsWith(".args")).length;
      return Array.from({ length: calls }, (_, index) => {
        assert.equal(readFileSync(join(dir, "calls", `${index * 2}.args`), "utf8"), "set 9190 --description\n");
        return readFileSync(join(dir, "calls", `${index * 2}.notes`), "utf8");
      });
    },
  };
}

const smi = (a: number, b: number) => `${UUID_A}, 00000000:01:00.0, 0, ${a}, 8192\n${UUID_B}, 00000000:02:00.0, 1, ${b}, 8192\n`;

test("the host's reporter writes each GPU's memory in the VM's notes as bb-box reads them, when a GPU's memory moves a step, and every 4 minutes (#603)", () => {
  const reporter = gpuReporter();
  const at = 1_790_000_000;
  assert.equal(reporter.run(at, smi(103, 6100)).status, 0);
  const [first] = reporter.writes();
  assert.match(first!, /^bb-box: each GPU's memory, from bb-box-gpu-memory\.timer on this host\. Do not edit\.\n\n    at 1790000000\n    gpu /);
  assert.deepEqual(parseGpuReport(first!), {
    at: at * 1000,
    gpus: [
      { uuid: UUID_A, bus: "00000000:01:00.0", index: "0", freeMiB: 103, totalMiB: 8192 },
      { uuid: UUID_B, bus: "00000000:02:00.0", index: "1", freeMiB: 6100, totalMiB: 8192 },
    ],
  });

  // Within a 64 MiB step, nothing is written until 4 minutes have passed.
  assert.equal(reporter.run(at + 15, smi(103, 6100)).status, 0);
  assert.equal(reporter.run(at + 30, smi(120, 6120)).status, 0);
  assert.equal(reporter.writes().length, 1);
  // 383 to 384 MiB is a step: the room a desktop needs.
  assert.equal(reporter.run(at + 45, smi(384, 6120)).status, 0);
  assert.equal(parseGpuReport(reporter.writes()[1]!)!.gpus[0]!.freeMiB, 384);
  assert.equal(reporter.run(at + 45 + 239, smi(384, 6120)).status, 0);
  assert.equal(reporter.writes().length, 2);
  assert.equal(reporter.run(at + 45 + 240, smi(384, 6120)).status, 0);
  assert.equal(parseGpuReport(reporter.writes()[2]!)!.at, (at + 285) * 1000, "a quiet GPU is written again after 4 minutes");
});

test("the host's reporter fails, writing nothing, without its VM or GPU memory (#603)", () => {
  const novm = gpuReporter(false);
  const missing = novm.run(1_790_000_000, smi(103, 6100));
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /no VM named bb-box-gpu-memory on this node; run setup-gpu-report\.sh/);
  const reporter = gpuReporter();
  const unread = reporter.run(1_790_000_000, `${UUID_A}, 00000000:01:00.0, 0, [N/A], [N/A]\n`);
  assert.equal(unread.status, 1);
  assert.match(unread.stderr, /nvidia-smi gave no GPU memory/);
  assert.deepEqual([novm.writes(), reporter.writes()], [[], []]);
});

test("the doctor says when the host's report has no report yet, or does not name a GPU (#603)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-desktop-templates": `9001 ${UUID_A}\n9002 gpu-b` });
  const report = async () => (await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-report");
  reportVm(proxmox, "bb-box: each GPU's memory, from bb-box-gpu-memory.timer. It is never started.");
  const empty = await report();
  assert.deepEqual([empty?.status, empty?.detail, empty?.fix], ["warn", "VM 9190 (bb-box-gpu-memory) has no report in its notes yet.", "Run systemctl status bb-box-gpu-memory.timer as root on pve, and check the host's clock."], "as before 071 unit 3 (Opus 5, Astra 6)");
  reportVm(proxmox, reportNotes(Date.now(), [[UUID_A, "00000000:01:00.0", 6100]]));
  const unnamed = await report();
  assert.deepEqual([unnamed?.status, unnamed?.detail, unnamed?.fix], [
    "warn",
    "The host's report has no GPU gpu-b, so bb-box reads its memory in desktops.",
    "Name each GPU in bb-box's settings by the UUID nvidia-smi -L shows on the host.",
  ]);
});

test("today's backend reads the report bb-box-gpu writes: the doctor's GPU report check passes, and each GPU's room comes from the host (071 unit 2)", async () => {
  const host = new FakeNode({ writes: "off" });
  host.guest(214, { box: "bx214", kind: "linux-desktop", marker: marker("shared", CARD_A, 3), lines: cardLines(CARD_A, "desktop"), running: true });
  host.guest(215, { box: "bx215", marker: marker("shared", CARD_B, 1) });
  host.guest(216, { box: "bx216", kind: "linux-desktop", lines: cardLines(CARD_B, "desktop") });
  assert.equal(host.run().status, 0);
  const notes = host.report();
  assert.ok(["holder ", "claim ", "would ", "card ", "helper "].every((line) => notes.includes(`\n    ${line}`)), notes);
  const { backend, proxmox } = setup({ "proxmox-lxc-desktop-templates": `9001 GPU-${CARD_A.uuid}\n9002 0000:d1:00.0` });
  reportVm(proxmox, notes, REPORT_VMID);
  const checks = (await backend.doctor()).checks;
  const check = (id: string) => checks.find((candidate) => candidate.id === id);
  assert.deepEqual([check("proxmox.gpu-report")?.status, check("proxmox.gpu-report")?.detail], ["ok", `The host reports 2 GPUs in VM ${REPORT_VMID}, written just now.`]);
  assert.deepEqual(
    (await backend.gpuRoom("linux-desktop")).readings.map((reading) => [reading.id, reading.freeMiB, reading.totalMiB, reading.source]),
    [
      [`GPU-${CARD_A.uuid}`, CARD_A.freeMiB, CARD_A.totalMiB, "host"],
      ["0000:d1:00.0", CARD_B.freeMiB, CARD_B.totalMiB, "host"],
    ],
  );
});

async function doctorOnReport(notes: string, now = Date.now(), values: Record<string, unknown> = { "proxmox-lxc-desktop-templates": `9001 GPU-${CARD_A.uuid}` }) {
  const { backend, proxmox } = setup(values, new MemoryStorage(), { now: () => now });
  reportVm(proxmox, notes, REPORT_VMID);
  const checks = (await backend.doctor()).checks;
  return (id: string) => checks.find((candidate) => candidate.id === id);
}

function helperReport(node: FakeNode, args: readonly string[] = ["--once"]): string {
  const run = node.run(args);
  assert.equal(run.status, 0, run.stdout + run.stderr);
  return node.report();
}

const verdict = (check: { status: string; detail: string; fix: string | null } | undefined) => check && [check.status, check.detail, check.fix];

test("the doctor's GPU helper check reads what real helpers report: a dry run warns, writes on passes, an untested pve-container fails, as the helper then starts no GPU desktop, and a pool not served fails (071 units 3 and 5, go review 4 N4)", async () => {
  const dryRun = await doctorOnReport(helperReport(new FakeNode({ writes: "off" })));
  assert.deepEqual(verdict(dryRun("proxmox.gpu-helper")), [
    "warn",
    "bb-box-gpu 0.4.3 on pve runs with writes off, a dry run: it writes the GPU report, answers markers that need no write, and changes no guest. Until writes are on, bb-box moves no box to another card, and a stopped box starts on the card its lines name (071).",
    "Once bb box gpu mark has marked this install's guests and a day of dry run shows no write the helper would make, run host/setup-gpu.sh --writes on --check, then host/setup-gpu.sh --writes on, as root on pve.",
  ]);
  assert.equal(dryRun("proxmox.gpu-report")?.status, "ok");
  assert.equal(verdict((await doctorOnReport(helperReport(new FakeNode({ writes: "on" }), ["--once", "--dry-run"])))("proxmox.gpu-helper"))?.[0], "warn", "--dry-run keeps writes off whatever gpu.conf says");

  const writing = await doctorOnReport(helperReport(new FakeNode({ writes: "on" })));
  assert.deepEqual(verdict(writing("proxmox.gpu-helper")), ["ok", "bb-box-gpu 0.4.3 on pve reported just now, with writes on, for pool bbbox, on pve-container 6.1.14, which it was tested on.", null]);

  const untested = await doctorOnReport(helperReport(new FakeNode({ writes: "on", pveContainer: "6.1.15" })));
  assert.deepEqual(verdict(untested("proxmox.gpu-helper")), [
    "fail",
    "bb-box-gpu 0.4.3 on pve was not tested on pve-container 6.1.15, so it changes no guest's lines, and only stops a GPU desktop or a guest with a GPU marker: those on pve are neither started nor released. Boxes with no GPU there are started, stopped and released through Proxmox's API meanwhile, as before 071.",
    "Install a bb-box-gpu release newer than 0.4.3 that was tested on pve-container 6.1.15: run host/setup-gpu.sh from that BB Box release, as root on pve.",
  ]);

  const elsewhere = await doctorOnReport(helperReport(new FakeNode({ writes: "on", pools: ["team", "lab"] })));
  assert.deepEqual(verdict(elsewhere("proxmox.gpu-helper")), ["fail", "bb-box-gpu 0.4.3 on pve serves pools team and lab, not this install's pool bbbox.", "Run host/setup-gpu.sh --pool bbbox as root on pve."]);
  const nowhere = await doctorOnReport(helperReport(new FakeNode({ writes: "off", pools: [] })));
  assert.equal(verdict(nowhere("proxmox.gpu-helper"))?.[1], "bb-box-gpu 0.4.3 on pve serves no pool, not this install's pool bbbox.");
});

test("the doctor's GPU helper check fails a report 3 minutes old and a helper of another protocol, with each fix; the GPU report's fix names the helper where it writes the report (071 unit 3)", async () => {
  const notes = helperReport(new FakeNode({ writes: "on" }));
  const at = Number(/^\s*at (\d+)$/m.exec(notes)![1]) * 1000;
  const minute = 60_000;
  assert.equal((await doctorOnReport(notes, at + 3 * minute - 1000))("proxmox.gpu-helper")?.status, "ok");
  const old = await doctorOnReport(notes, at + 3 * minute);
  assert.deepEqual(verdict(old("proxmox.gpu-helper")), ["fail", "The GPU helper on pve last reported 3 minutes ago, in VM 9190.", "Run systemctl status bb-box-gpu as root on pve, and check the host's clock."]);
  assert.equal(old("proxmox.gpu-report")?.status, "ok", "today's report still stands for 10 minutes");
  const stale = await doctorOnReport(notes, at + 10 * minute);
  assert.deepEqual(verdict(stale("proxmox.gpu-report")), ["warn", "The host's report in VM 9190 is from 10 minutes ago, so bb-box reads GPU memory in desktops.", "Run systemctl status bb-box-gpu as root on pve, and check the host's clock."]);

  const withHelper = (line: string) => notes.replace(/^(\s*)helper bb-box-gpu .*$/m, `$1${line}`);
  const newer = await doctorOnReport(withHelper("helper bb-box-gpu 2.0.0 protocol 2 writes on with new words"), at);
  assert.deepEqual(verdict(newer("proxmox.gpu-helper")), ["fail", "The GPU helper on pve, bb-box-gpu 2.0.0, speaks protocol 2, newer than this BB Box's protocol 1.", "Update BB Box."]);
  const older = await doctorOnReport(withHelper("helper bb-box-gpu 0.0.9 protocol 0 writes on pve-container 6.1.14 tested"), at);
  assert.deepEqual(verdict(older("proxmox.gpu-helper")), ["fail", "The GPU helper on pve, bb-box-gpu 0.0.9, speaks protocol 0, older than this BB Box's protocol 1.", "Run host/setup-gpu.sh again, from this BB Box's setup guide, as root on pve."]);
  const unread = await doctorOnReport(withHelper("helper bb-box-gpu 0.1.0 protocol 1 writes maybe"), at);
  assert.deepEqual(verdict(unread("proxmox.gpu-helper")), ["fail", "VM 9190's report has a helper line this BB Box cannot read.", "Run host/setup-gpu.sh again, from this BB Box's setup guide, as root on pve."]);
  const unreadable = await doctorOnReport(withHelper("helper bb-box-gpu 0.1.0 protocol broken"), at);
  assert.deepEqual(verdict(unreadable("proxmox.gpu-helper")), ["fail", "VM 9190's report has a helper line this BB Box cannot read.", "Run host/setup-gpu.sh again, from this BB Box's setup guide, as root on pve."], "a helper line with no protocol is not taken for no helper (Astra 5)");
  const many = await doctorOnReport(notes.replace(/^(\s*)serves .*$/m, "$1serves p1 p2 p3 and 40 more"), at);
  assert.deepEqual(verdict(many("proxmox.gpu-helper")), ["warn", "bb-box-gpu 0.4.3 on pve serves more pools than its report lists, so bb-box cannot tell whether it serves this install's pool bbbox.", "Run host/setup-gpu.sh --pool bbbox as root on pve."]);
});

test("the doctor's GPU helper check fails a report dated a minute or more ahead of BB's clock, as a stopped helper could pass for fresh until then (071 unit 3, Astra 4)", async () => {
  const notes = helperReport(new FakeNode({ writes: "on" }));
  const at = Number(/^\s*at (\d+)$/m.exec(notes)![1]) * 1000;
  const ahead = await doctorOnReport(notes, at - 24 * 60 * 60_000);
  assert.deepEqual(verdict(ahead("proxmox.gpu-helper")), [
    "fail",
    "The GPU helper's report in VM 9190 is dated 1 day ahead of this BB server's clock, so bb-box cannot tell whether the helper still runs.",
    "Run systemctl status bb-box-gpu as root on pve, and check the host's clock.",
  ]);
  assert.equal(verdict((await doctorOnReport(notes, at - 60_000))("proxmox.gpu-helper"))?.[0], "fail");
  assert.deepEqual(verdict((await doctorOnReport(notes, at - 30_000))("proxmox.gpu-helper"))?.slice(0, 2), ["ok", "bb-box-gpu 0.4.3 on pve reported just now, with writes on, for pool bbbox, on pve-container 6.1.14, which it was tested on."], "a clock under a minute behind the host's is allowed");
});

test("071 unit 7, Fable 5: box_list's room for servers says nothing on a node with no card at all, and says why there is no GPU on one with cards and no helper", async () => {
  const bare = setup({ "proxmox-lxc-desktop-templates": "" });
  assert.deepEqual(await bare.backend.gpuRoom("linux"), { readings: [], fullUntil: null });
  const carded = setup({ "proxmox-lxc-desktop-templates": `9001 ${UUID_A}` });
  assert.deepEqual((await carded.backend.gpuRoom("linux")).parts, ["none"]);
  assert.match((await carded.backend.gpuRoom("linux")).withheld ?? "", /it has no GPU helper to give a box a card/);
});

test("071 unit 7: a node with cards and no GPU helper warns that servers get no GPU, whole cards and changes of card need it; a node with no cards has no helper check", async () => {
  const now = 1_790_000_000_000;
  const timer = await doctorOnReport(reportNotes(now, [[UUID_A, "00000000:01:00.0", 6100]]), now, { "proxmox-lxc-desktop-templates": `9001 ${UUID_A}` });
  assert.equal(timer("proxmox.gpu-helper")?.status, "warn");
  assert.match(timer("proxmox.gpu-helper")!.detail, /^pve has no GPU helper, so its servers get no GPU, and no box gets a whole card or changes card\. GPU desktops go on as before, on the cards their templates name\. GPU on servers, whole cards and changes of card need host\/setup-gpu\.sh\.$/);
  assert.equal(timer("proxmox.gpu-helper")!.fix, "Run host/setup-gpu.sh from the setup guide as root on pve.");
  assert.equal(timer("proxmox.gpu-report")?.status, "ok");
  const { backend } = setup({ "proxmox-lxc-desktop-templates": `9001 ${UUID_A}` });
  assert.equal((await backend.doctor()).checks.find((check) => check.id === "proxmox.gpu-helper")?.status, "warn");
  const noCards = setup({ "proxmox-lxc-desktop-templates": "" });
  assert.equal((await noCards.backend.doctor()).checks.some((check) => check.id === "proxmox.gpu-helper"), false);
  const noDesktops = await doctorOnReport(helperReport(new FakeNode({ writes: "off" })), Date.now(), { "proxmox-lxc-desktop-templates": "" });
  assert.equal(noDesktops("proxmox.gpu-helper")?.status, "warn");
  assert.match(noDesktops("proxmox.gpu-helper")!.detail, /writes off/);
});

test("the GPU helper's lines are read by their protocol's grammar, and a pool list the report cut short says how many it left out (071 unit 3)", () => {
  const notes = (rest: string) => `bb-box: each GPU's memory and its claims.\n\n    at 1790000000\n    ${rest}\n    serves bbbox lab/gpu`;
  assert.deepEqual(parseGpuHelper(notes("helper bb-box-gpu 0.1.0 protocol 1 writes off pve-container 6.1.14 tested")), {
    version: "0.1.0",
    protocol: 1,
    writes: "off",
    pveContainer: "6.1.14",
    tested: true,
    serves: { listed: ["bbbox", "lab/gpu"], unlisted: 0 },
  });
  assert.deepEqual(parseGpuHelper(notes("helper bb-box-gpu 3.0.0 protocol 3 anything at all")), { version: "3.0.0", protocol: 3, writes: null, pveContainer: null, tested: null, serves: null });
  assert.deepEqual(parseGpuHelper(notes("helper bb-box-gpu 0.1.0 protocol broken")), { version: null, protocol: null, writes: null, pveContainer: null, tested: null, serves: null });
  assert.equal(parseGpuHelper("    helper bb-box-gpus are elsewhere"), null);
  assert.equal(parseGpuHelper(reportNotes(1_790_000_000_000, [[UUID_A, "00000000:01:00.0", 6100]])), null);
  assert.deepEqual(parseGpuHelper(`${notes("helper bb-box-gpu 0.1.0 protocol 1 writes on pve-container 6.1.14 untested")}`.replace("serves bbbox lab/gpu", "serves none"))?.serves, { listed: [], unlisted: 0 });
  assert.deepEqual(parseGpuHelper(notes("helper bb-box-gpu 0.1.0 protocol 1 writes on pve-container 6.1.14 tested").replace("serves bbbox lab/gpu", "serves a b and 12 more"))?.serves, { listed: ["a", "b"], unlisted: 12 });
  const seen = { node: "pve", pool: "bbbox", vmid: 9190, ageMs: 0, ago: () => "just now" };
  assert.equal(judgeGpuHelper(parseGpuHelper(notes("helper bb-box-gpu 0.1.0 protocol 1 writes on pve-container 6.1.14 tested"))!, { ...seen, ageMs: null }).detail, "The GPU helper on pve has written no report in VM 9190.");
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
    [["cores", "cpuunits", "delete", "digest", "memory", "net0", "onboot"], ["digest", "tags"], ["delete", "digest"], ["digest", "tags"]],
    "tags go in a PUT of their own; the low CPU weight and its tag go once it is ready (#888); each on the digest of the config bb-box checked",
  );
  assert.equal(puts[0]!.params.cpuunits, "10", "a tenth of the default weight while it starts");
  assert.ok(parseTags(String(puts[1]!.params.tags)).includes("bb-box-starting"));
  assert.equal(puts[2]!.params.delete, "cpuunits");
  assert.equal(made.config.cpuunits, undefined, "the default weight once ready");
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

test("a GPU desktop's start reads its display mode again, as it can fall back to the CPU; other boxes' starts change no facts (#597)", async () => {
  const { backend, ssh } = setup({ "proxmox-lxc-desktop-templates": "9001 gpu-a" });
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  assert.deepEqual(desktop.facts?.map((fact) => fact.value), ["gpu-a", "GPU", "The GPU had 7800 MiB of memory free."]);
  await backend.stop(desktop);
  // The boot clears /run, and the display service takes its path again.
  rmSync(join(ssh.dir, "home", "192.0.2.100", "run", "bb-box"), { recursive: true, force: true });
  displayAt(ssh.dir, "192.0.2.100", "cpu", "GPU has 300 MiB free, below MIN_FREE_VRAM_MIB=384");
  assert.deepEqual(await backend.start(desktop), {
    facts: [
      { label: "GPU", value: "gpu-a" },
      { label: "Display mode", value: "CPU" },
      { label: "Display reason", value: "The GPU had 300 MiB of memory free, less than the 384 MiB a desktop needs." },
    ],
  });
  const server = await backend.acquire(identity(), null, hooks().value, signal());
  await backend.stop(server);
  assert.equal(await backend.start(server), undefined);
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
        "proxmox-lxc-vmid-first": 7010,
        "proxmox-lxc-vmid-last": 7019,
      }),
      testContext(new MemoryStorage(), "other"),
      fakes(proxmox),
    ),
  );
  assert.deepEqual(await other.held(), []);
  await assert.rejects(other.power(desktop), /is outside bb-box's VMID range, so bb-box leaves it alone/);
  await assert.rejects(other.stop(desktop), /is outside bb-box's VMID range, so bb-box leaves it alone/);
  await assert.rejects(other.release(desktop, releasing()), /is outside bb-box's VMID range, so bb-box leaves it alone/);
  await other.maintain();
  assert.equal(proxmox.guests.get(7001)?.status, "running", "the other install's release left the desktop alone");
  assert.ok(proxmox.guests.has(7000), "the other install, with no warm pool, leaves this one's warm guest");
  assert.equal((await other.capacity("linux-desktop", sized("linux-desktop"), waiting(), signal())).ok, true, "desktops per GPU counts each install's own boxes, in its own VMID range");

  const theirs = await other.acquire(identity(), null, hooks().value, signal());
  assert.equal(theirs.ref, "7010", "the other install clones, in a VMID range of its own, rather than take this one's warm guest");
  assert.deepEqual(parseTags(proxmox.guests.get(7010)!.config.tags).slice(0, 2), ["bb-box", "install.other"]);
  assert.deepEqual((await backend.held()).map((guest) => guest.ref), ["7001"]);
  await assert.rejects(backend.power(theirs), /is outside bb-box's VMID range, so bb-box leaves it alone/);
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
  assert.equal(config.description, "bb-box old\ninstall test\nbox box_old\nthread thr_x\n");
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
  assert.equal(await display!.resize!({ width: 1600, height: 900 }), undefined, "on the GPU, xrandr set it");
  assert.match(readFileSync(log, "utf8"), /^:99 \S*\/run\/bb-box\/Xauthority --fb 1600x900\n$/);
  assert.ok(ssh.log().some((entry) => entry.target.startsWith("box@") && entry.command.includes("xrandr --fb 1600x900")), "it runs as the box user");
  await assert.rejects(display!.resize!({ width: 40000, height: 800 }), { message: `xrandr could not set the desktop to 40000x800: ${refusal}.` });
  await assert.rejects(display!.resize!({ width: 0.5, height: 800 }), { message: "The desktop cannot be 0.5 by 800 pixels." });

  // Its display service restarted without the GPU: Xtigervnc took the viewer's
  // SetDesktopSize, and xrandr would disconnect its output for an older size.
  writeFileSync(join(ssh.dir, "home", "192.0.2.100", "run", "bb-box", "display-mode"), "cpu\n");
  assert.equal(await display!.resize!({ width: 1400, height: 900 }), "stream-server", "a viewer that sent no SetDesktopSize, as video's, has one sent (072)");
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
  *"test -x "*"/usr/local/libexec/bb-box/selkies"*) [ -e "${dir}/selkies" ]; exit $?;;
  *"test -x "*"/usr/local/libexec/bb-box/cursor"*) [ -e "${dir}/cursor" ]; exit $?;;
  *"seat seat0 attach"*) printf '%s\n' "$*" >>"${dir}/pointer"; exit 0;;
  *"/usr/local/libexec/bb-box/display resize "*) printf '%s\\n' "$*" >>"${log}"; case "$*" in *40000x800*) echo "${refusal}" >&2; exit 1;; esac; exit 0;;
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

  // A box of an image with Selkies has video too, by choice (060); the box above keeps its image's answer.
  writeFileSync(join(dir, "selkies"), "");
  const video = await backend.acquire(identity("linux-desktop-wayland-cpu"), null, hooks().value, signal());
  const shown = (await backend.transports(video, "linux-desktop-wayland-cpu")).displays;
  assert.deepEqual(shown.map((each) => [each.protocol, each.label, each.cursor ?? null]), [["rfb", "Desktop", null], ["selkies", "Desktop, as video", null]], "Sway paints the pointer: the hidden theme takes it out, not Selkies");
  assert.equal((await backend.transports(box, "linux-desktop-wayland-cpu")).displays.length, 1, "asked once a box");

  // A VMID is reused: a later box of another image on the same VMID is asked again, both ways.
  const reused = { ...box, data: { ...box.data, box: "bx-later-box" } };
  assert.equal((await backend.transports(reused, "linux-desktop-wayland-cpu")).displays.length, 2, "the later box's image has Selkies");
  rmSync(join(dir, "selkies"));
  const again = { ...video, data: { ...video.data, box: "bx-older-image" } };
  assert.equal((await backend.transports(again, "linux-desktop-wayland-cpu")).displays.length, 1, "and one whose image has none has no video");

  // The pointer while a person holds control (#707, 060): an image without bb-box-cursor, as on 24.04, hides it from the
  // picture, as before; one with it, Sway 1.11's, keeps Sway's theme, whose pointer neither stream paints.
  const themes = async (record: typeof box) => {
    const [rfb] = (await backend.transports(record, "linux-desktop-wayland-cpu")).displays;
    rmSync(join(dir, "pointer"), { force: true });
    await rfb!.pointer!(false);
    await rfb!.pointer!(true);
    return readFileSync(join(dir, "pointer"), "utf8").split("\n").flatMap((line) => /xcursor_theme (\S+?)'/.exec(line)?.[1] ?? []);
  };
  assert.deepEqual(await themes(box), ["bb-box-hidden", "default"], "an image without the helper hides the pointer, as before");
  writeFileSync(join(dir, "cursor"), "");
  const sends = { ...box, data: { ...box.data, box: "bx-sway-1-11" } };
  assert.deepEqual(await themes(sends), ["default", "default"], "an image with the helper keeps Sway's theme");
  assert.deepEqual(await themes(box), ["bb-box-hidden", "default"], "a box keeps its image's answer");
  // And only a box with the helper has its pointer followed.
  const follows = async (record: typeof box) => (await backend.transports(record, "linux-desktop-wayland-cpu")).displays[0]!.followPointer !== undefined;
  assert.deepEqual([await follows(sends), await follows(box)], [true, false]);
});

test("the warm pool fills, hands out a ready guest and refills", async () => {
  const { backend, proxmox, ssh } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const warm = proxmox.guests.get(7000)!;
  assert.equal(warm.status, "running");
  assert.deepEqual(parseTags(warm.config.tags), ["bb-box", "install.test", "warm", "template.9000", "bb-box-starting"]);
  assert.equal(warm.config.cpuunits, "10", "a warm guest keeps a low CPU weight until a box takes it (#888)");
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
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "install.test", "warm", "template.9000", "bb-box-starting"]);
  const capacity = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });
});

test("a warm fill goes ready though Proxmox gives the description back ending in a newline, as its config writer stores it", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const warm = proxmox.guests.get(7000)!;
  assert.match(warm.config.description!, /^bb-box warm linux\ninstall test\nwarm [0-9a-f]{12}\n$/, "the fake stores the description as Proxmox does");
  assert.equal(warm.status, "running");
  assert.ok(parseTags(warm.config.tags).includes("warm"));
  assert.deepEqual(context.errors, []);
  const capacity = await backend.capacity("linux", sized("linux"), waiting(), signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });
});

test("a warm guest a box takes keeps the GPU marker bb box gpu mark gave it, as does a box relabelled for another owner (071 unit 4)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const shared = marker("shared", CARD_A, 1);
  const warm = proxmox.guests.get(7000)!;
  warm.config.tags = `${warm.config.tags};${shared}`;
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  assert.equal(guest.ref, "7000");
  const taken = parseTags(proxmox.guests.get(7000)!.config.tags);
  assert.equal(ownerFromTags(taken)?.boxId, box.boxId);
  assert.ok(taken.includes(shared), `the box keeps the warm guest's marker: ${taken.join(";")}`);

  proxmox.guests.get(7000)!.config.tags = [...parseTags(proxmox.guests.get(7000)!.config.tags).filter((tag) => tag !== shared), marker("shared", CARD_B, 2)].join(";");
  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" }, box.name, signal());
  const relabelled = parseTags(proxmox.guests.get(7000)!.config.tags);
  assert.equal(ownerFromTags(relabelled)?.threadId, "operator");
  assert.ok(relabelled.includes(marker("shared", CARD_B, 2)), `relabelled, it keeps its marker: ${relabelled.join(";")}`);
  assert.equal(relabelled.filter((tag) => tag.startsWith("gpu.")).length, 1);
});

test("a warm claim and a relabel read the tags again just before they write them, on the config's digest, so a marker written meanwhile stays (071 unit 4, Opus 3, Astra 6)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 });
  await backend.maintain();
  const meanwhile = (vmid: number, tag: string) => {
    let done = false;
    proxmox.intercept = (call) => {
      if (!done && call.method === "PUT" && call.path.endsWith(`/${vmid}/config`) && call.params.tags !== undefined) {
        done = true;
        const config = proxmox.guests.get(vmid)!.config;
        config.tags = `${config.tags};${tag}`;
      }
      return undefined;
    };
  };
  meanwhile(7000, marker("shared", CARD_A, 1));
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  const taken = parseTags(proxmox.guests.get(7000)!.config.tags);
  assert.equal(ownerFromTags(taken)?.boxId, box.boxId);
  assert.ok(taken.includes(marker("shared", CARD_A, 1)), `the marker written meanwhile stays: ${taken.join(";")}`);

  meanwhile(7000, marker("shared", CARD_A, 2));
  proxmox.guests.get(7000)!.config.tags = parseTags(proxmox.guests.get(7000)!.config.tags).filter((tag) => !tag.startsWith("gpu.")).join(";");
  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" }, box.name, signal());
  const relabelled = parseTags(proxmox.guests.get(7000)!.config.tags);
  assert.equal(ownerFromTags(relabelled)?.threadId, "operator");
  assert.ok(relabelled.includes(marker("shared", CARD_A, 2)), `relabelled, the marker written meanwhile stays: ${relabelled.join(";")}`);
  proxmox.intercept = undefined;
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
  assert.deepEqual(parseTags(proxmox.guests.get(7000)!.config.tags), ["bb-box", "install.test", "warm", "template.9000", "build.one", "bb-box-starting"]);

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
    [["bb-box", "install.test", "warm", "template.9000", "build.two", "bb-box-starting"]],
  );
  assert.deepEqual(context.errors, []);
});

test("a warm guest is not ready while its template is away, nor once a template without a build ID gets one", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-linux-warm": 1 });
  // Outside the pool, so read on its own.
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7000)!.config.tags), ["bb-box", "install.test", "warm", "template.9000", "bb-box-starting"]);
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
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "install.test", "warm", "template.9000", "build.one", "bb-box-starting"]);
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
  assert.deepEqual(parseTags(proxmox.guests.get(7000)?.config.tags), ["bb-box", "install.test", "warm", "template.9000", "bb-box-starting"]);
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
      ["proxmox.gpu-helper", "Host's GPU helper", "warn"],
      ["proxmox.gpu-report", "Host's GPU report", "skipped"],
      ["gpu.gpu-a", "GPU gpu-a", "skipped"],
      ["proxmox.bridge", "Network bridge", "ok"],
      ["proxmox.vmids", "VMID range", "ok"],
      ["proxmox.snapshots", "Snapshots", "ok"],
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

test("a template replaced in place is a template again, though Proxmox gives back the description it was cloned with ending in a newline", async () => {
  const dir = tempDir("image-replace-newline");
  const record = { contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261003-021500-3f9c", built: "2026-10-03T02:15:00Z" };
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *"cat /usr/share/bb-box/image.json"*) echo '${JSON.stringify(record)}'; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, proxmox } = setup({}, new MemoryStorage(), { sshBinary: binary });
  proxmox.guests.get(9000)!.config.tags = "build.20260926-060000-a1b2";
  proxmox.guests.get(9000)!.config.description = "bb-box linux template, built 2026-09-26.\n";
  const images = backend.images;
  const standard = (await images.list()).builds.find((build) => build.ref === "9000")!;
  const box = await images.box(standard, "refresh of 9000", signal());
  const captured = await images.capture(box, standard, "standard", signal());
  proxmox.statusPass();
  const replaced = await images.replace(captured, standard, signal());
  assert.deepEqual([replaced.ref, replaced.current], ["9000", true]);
  const template = proxmox.guests.get(9000)!;
  assert.deepEqual([template.template, template.config.template, template.config.protection], [true, "1", "1"]);
  assert.match(template.config.description!, /^bb-box linux template, refreshed \d{4}-\d{2}-\d{2}\.\n\{"contract":1,.*\}\n$/, "the fake stores the description as Proxmox does");
  assert.deepEqual(parseTags(template.config.tags), ["build.20261003-021500-3f9c"]);
  assert.equal(proxmox.guests.has(7000), false, "the captured build goes");
  const after = (await images.list()).builds.find((build) => build.ref === "9000")!;
  assert.deepEqual([after.current, after.build], [true, "build.20261003-021500-3f9c"]);
});

test("a project's box starts from its image's build, not a warm guest, and a build goes though templates are protected (049)", async () => {
  const dir = tempDir("image-from");
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *"cat /usr/share/bb-box/image.json"*) echo '{"contract":1,"image":"rust","kind":"linux","build":"build.x","built":"2026-10-03T00:00:00Z"}'; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const { backend, proxmox } = setup({ "proxmox-lxc-linux-warm": 1 }, new MemoryStorage(), { sshBinary: binary });
  assert.equal(backend.images.startsFrom, true);
  const standard = (await backend.images.list()).builds.find((build) => build.ref === "9000")!;
  const captured = await backend.images.capture(await backend.images.box(standard, "bake of rust", signal()), standard, "rust", signal());
  await backend.maintain();
  const warmGuests = [...proxmox.guests.entries()].filter(([, guest]) => parseTags(guest.config.tags).includes("warm")).map(([vmid]) => vmid);
  assert.equal(warmGuests.length, 1);

  const guest = await backend.acquire({ ...identity(), from: captured.ref }, null, hooks().value, signal());
  assert.equal(templateFromTags(parseTags(proxmox.guests.get(Number(guest.ref))!.config.tags)), Number(captured.ref));
  assert.ok(!warmGuests.includes(Number(guest.ref)), "not a warm guest of the standard image");
  await backend.release(guest, releasing());

  assert.equal(proxmox.guests.get(Number(captured.ref))!.config.protection, "1");
  await backend.images.remove(captured.ref, signal());
  assert.equal(proxmox.guests.has(Number(captured.ref)), false);
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

test("doctor names the snapshot rights a token made before 070 lacks, without the token, and what each template's storage restores (070)", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-ssh-private-key": "" });
  proxmox.privileges.set("/pool/bbbox", new Set(TOKEN_ROLE.filter((privilege) => !privilege.startsWith("VM.Snapshot"))));
  proxmox.storage.set("tank", { total: 900 * GiB, avail: 600 * GiB });
  proxmox.storageTypes.set("tank", "zfspool");
  proxmox.guests.get(9001)!.config.rootfs = "tank:base-9001-disk-0,size=8G";
  const report = await backend.doctor();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === "fail")));
  const snapshots = report.checks.find((check) => check.id === "proxmox.snapshots")!;
  assert.deepEqual([snapshots.status, snapshots.detail, snapshots.fix], [
    "warn",
    "The token lacks VM.Snapshot and VM.Snapshot.Rollback on /pool/bbbox, so bb-box cannot take or restore snapshots. " +
      "local-lvm (LVM-thin) restores any snapshot. tank (ZFS) restores only the newest snapshot.",
    "Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on pve. It keeps the token and its secret, and adds the missing rights to the token's role.",
  ]);
  for (const part of [FAKE_TOKEN.tokenSecret, FAKE_TOKEN.tokenId]) assert.ok(!JSON.stringify(report).includes(part), "the report never names the token");
  assert.deepEqual(
    proxmox.calls.filter((call) => call.path === "/access/permissions").map((call) => [call.method, call.params.path]),
    [["GET", "/pool/bbbox"]],
  );

  proxmox.privileges.set("/pool/bbbox", new Set(TOKEN_ROLE));
  const fixed = (await backend.doctor()).checks.find((check) => check.id === "proxmox.snapshots")!;
  assert.deepEqual([fixed.status, fixed.detail, fixed.fix], [
    "ok",
    "The token may take, delete and restore snapshots on /pool/bbbox. local-lvm (LVM-thin) restores any snapshot. tank (ZFS) restores only the newest snapshot.",
    null,
  ]);
});

test("doctor says a container on directory storage takes no snapshots (070)", async () => {
  const { backend, proxmox } = setup();
  proxmox.storage.set("files", { total: 900 * GiB, avail: 600 * GiB });
  proxmox.storageTypes.set("files", "dir");
  proxmox.guests.get(9001)!.config.rootfs = "files:9001/base-9001-disk-0.raw,size=8G";
  const snapshots = (await backend.doctor()).checks.find((check) => check.id === "proxmox.snapshots")!;
  assert.deepEqual([snapshots.status, snapshots.detail, snapshots.fix], [
    "warn",
    "The token may take, delete and restore snapshots on /pool/bbbox. local-lvm (LVM-thin) restores any snapshot. files (directory) takes no snapshots of containers.",
    "For snapshots, put the templates on storage that takes them: LVM-thin, ZFS, Ceph RBD or BTRFS.",
  ]);
});

test("doctor warns, without failing, when every VMID is in use", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000, "proxmox-lxc-ssh-private-key": "" });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.test;box.box_x;thread.thr_x;kind.linux" } });
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

test("a box comes from its template's current build until build.sh --replace swaps it, or the kind drops the template (049)", async () => {
  const { backend, proxmox } = setup();
  proxmox.guests.get(9000)!.config.tags = "build.20261001-000000-aaaa";
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.data?.build, "20261001-000000-aaaa");
  assert.equal(await backend.fromCurrentBuild(guest, "linux"), true);
  proxmox.guests.get(9000)!.config.tags = "build.20261009-000000-bbbb";
  assert.equal(await backend.fromCurrentBuild(guest, "linux"), false);
  assert.equal(await backend.fromCurrentBuild({ ...guest, data: { ...guest.data, template: 9999 } }, "linux"), false, "a template the kind no longer lists");
  const { build: _, ...data } = guest.data!;
  assert.equal(await backend.fromCurrentBuild({ ...guest, data }, "linux"), null, "no build recorded");
});

test("a GPU desktop shows as video only where its image encodes with NVENC, and by choice (#863)", async () => {
  const displaysWith = async (marker: string) => {
    const { backend } = setup({}, new MemoryStorage(), { gpuVideoMarker: marker });
    const guest = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
    return (await backend.transports(guest, "linux-desktop")).displays.map((display) => display.protocol);
  };
  // The fake SSH runs commands on the test machine, where /bin/sh is and the other path is not.
  assert.deepEqual(await displaysWith("/bin/sh"), ["rfb", "selkies"]);
  assert.deepEqual(await displaysWith("/nonexistent/bb-box-nofbc.so"), ["rfb"], "an image built before has no video");
});

test("a container resizes live in every part, with room for what it grows by, and its disk only grows (061)", async () => {
  const { backend, proxmox } = setup();
  assert.deepEqual(backend.resizing("linux"), { cores: "live", memory: "live", disk: "live", shrinks: true, gpu: { add: "restart", share: "no", move: "no" } });
  assert.deepEqual(setup({ "proxmox-lxc-desktop-cpu-templates": "9003" }).backend.resizing("linux-desktop-cpu"), { cores: "live", memory: "live", disk: "live", shrinks: true });
  assert.equal(backend.resizing("macos"), null);
  const guest = await backend.acquire(identity("linux"), null, hooks().value, signal());
  const vmid = Number(guest.ref);
  const to = { cores: 4, memoryMiB: 8192, diskGiB: 16 };

  const plan = await backend.planResize(guest, "linux", to, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: 2, to: 4, way: "live" },
    { part: "memory", from: 4096, to: 8192, way: "live" },
    { part: "disk", from: 8, to: 16, way: "live" },
  ]);
  assert.equal(plan.room.ok, true);
  assert.equal(plan.downSeconds, null);

  // Only the growth needs room: 4 GiB more memory, kept within the reserve, and 8 GiB more disk.
  proxmox.memory = { total: 64 * GiB, available: 7 * GiB };
  const tight = await backend.planResize(guest, "linux", to, [], signal());
  assert.equal(tight.room.ok, false);
  assert.equal(tight.room.message, "pve has 7 GiB of memory free and keeps 4 GiB free, so the 4 GiB more the box needs does not fit. Release a box, ask for less memory, or lower the memory kept free in bb-box's settings.");
  assert.equal((await backend.planResize(guest, "linux", { ...to, memoryMiB: 4096 }, [], signal())).room.ok, true, "the same memory needs none");
  proxmox.memory = { total: 64 * GiB, available: 48 * GiB };
  assert.equal((await backend.planResize(guest, "linux", { ...to, cores: 32 }, [], signal())).room.message, "pve has 16 CPU threads, fewer than the 32 cores asked for. Ask for at most 16 cores.");
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 55 * GiB });
  assert.match((await backend.planResize(guest, "linux", to, [], signal())).room.message!, /^The local-lvm storage on pve has 55 GiB free and keeps 50 GiB free, so 8 GiB more disk does not fit\./);
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 500 * GiB });

  const resized = await backend.resize(guest, "linux", to, { restart: false }, signal());
  assert.deepEqual(resized.size, to);
  const config = proxmox.guests.get(vmid)!.config;
  assert.deepEqual([config.cores, config.memory, /size=([^,]+)/.exec(String(config.rootfs))?.[1]], ["4", "8192", "16G"]);

  // Back down: cores and memory go down live, and the disk stays.
  assert.deepEqual((await backend.resize(guest, "linux", { cores: 2, memoryMiB: 4096, diskGiB: 16 }, { restart: false }, signal())).size, { cores: 2, memoryMiB: 4096, diskGiB: 16 });
  await assert.rejects(backend.planResize(guest, "linux", { cores: 2, memoryMiB: 4096, diskGiB: 12 }, [], signal()), (error) => error instanceof BackendError && /disk only grows, and this one's is 16 GiB/.test(error.message));
  await assert.rejects(backend.resize(guest, "linux", { cores: 2, memoryMiB: 4096, diskGiB: 12 }, { restart: false }, signal()), /disk only grows/);
});

test("a container whose disk does not grow gets its cores and memory back, and another box's guest is gone (061)", async () => {
  const { backend, proxmox } = setup();
  const guest = await backend.acquire(identity("linux"), null, hooks().value, signal());
  const vmid = Number(guest.ref);
  proxmox.nextTaskExit.set("resize", "lvextend failed: insufficient free space");
  await assert.rejects(backend.resize(guest, "linux", { cores: 4, memoryMiB: 8192, diskGiB: 40 }, { restart: false }, signal()), /insufficient free space/);
  const config = proxmox.guests.get(vmid)!.config;
  assert.deepEqual([String(config.cores), String(config.memory)], ["2", "4096"], "cores and memory went back");
  await assert.rejects(backend.resize({ ...guest, data: { ...guest.data, box: "box_other" } }, "linux", { cores: 4, memoryMiB: 4096, diskGiB: null }, { restart: false }, signal()), (error) => error instanceof BackendError && error.code === "gone");
});

test("a new box starts with a tenth of the CPU weight and has it back once ready; a weight set by hand is left alone (#888)", async () => {
  const { backend, proxmox } = setup();
  let atStart: string | undefined = "unread";
  proxmox.intercept = (call) => {
    if (call.method === "POST" && call.path.endsWith("/status/start")) atStart = proxmox.guests.get(Number(call.path.split("/")[4]))?.config.cpuunits;
    return undefined;
  };
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(atStart, "10", "low while it starts");
  const made = proxmox.guests.get(Number(guest.ref))!;
  assert.equal(made.config.cpuunits, undefined, "the default once ready");
  assert.ok(!parseTags(made.config.tags).includes("bb-box-starting"));
  assert.equal((await backend.held()).find((each) => each.ref === guest.ref)?.settling, undefined, "nothing left to put back");

  // A template with a weight of its own, as one set by hand: never lowered, never changed.
  proxmox.guests.get(9000)!.config.cpuunits = "50";
  atStart = "unread";
  const own = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(atStart, "50");
  assert.equal(proxmox.guests.get(Number(own.ref))!.config.cpuunits, "50");
  assert.ok(!parseTags(proxmox.guests.get(Number(own.ref))!.config.tags).includes("bb-box-starting"));
});

test("a spare keeps a low CPU weight until a box takes it, and held() says so, for the sweep (#888)", async () => {
  const { backend, proxmox } = setup();
  const spare = await backend.acquire(identity("linux", "spare"), null, hooks().value, signal());
  const vm = proxmox.guests.get(Number(spare.ref))!;
  assert.equal(vm.config.cpuunits, "10");
  assert.ok(parseTags(vm.config.tags).includes("bb-box-starting"));
  assert.equal((await backend.held()).find((each) => each.ref === spare.ref)?.settling, true);

  // A box takes it: relabel() puts the weight back.
  await backend.relabel!(spare, identity(), "calm-otter-spare", signal());
  assert.equal(vm.config.cpuunits, undefined);
  assert.ok(!parseTags(vm.config.tags).includes("bb-box-starting"));
  assert.equal((await backend.held()).find((each) => each.ref === spare.ref)?.settling, undefined);

  // settle() for the sweep, with the guest as held() reads it now, leaves a guest bb-box did not lower as it is.
  vm.config.cpuunits = "10";
  await assert.rejects(backend.settle!(spare, signal()), /is no longer box box_\d+ of this install/, "the spare's record names the box before relabel, which the guest no longer does");
  const taken = (await backend.held()).find((each) => each.ref === spare.ref)!;
  await backend.settle!(taken, signal());
  assert.equal(vm.config.cpuunits, "10", "without the tag, a weight of 10 is someone's own");
});

function recordingWarm<T extends { warm(kind: string): number }>(context: T): { context: T; asked: Set<string> } {
  const asked = new Set<string>();
  return { context: { ...context, warm: (kind: string) => (asked.add(kind), 0) }, asked };
}

test("stopping a Proxmox backend ends an API call that has not answered", async () => {
  let resolveSeen: (signal: AbortSignal | undefined) => void = () => {};
  const seen = new Promise<AbortSignal | undefined>((resolve) => {
    resolveSeen = resolve;
  });
  const fetch = (_url: string, init?: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      resolveSeen(init?.signal);
      const abort = () => reject(new Error("aborted"));
      if (init?.signal?.aborted) abort();
      else init?.signal?.addEventListener("abort", abort, { once: true });
    });
  const { backend } = setup({ "proxmox-lxc-node": "" }, new MemoryStorage(), { fetch });
  const running = backend.maintain();
  await seen;
  const started = Date.now();
  await backend.dispose();
  await running.catch(() => undefined);
  assert.ok(Date.now() - started < 1000, `dispose took ${Date.now() - started}ms`);
});

test("maintain reads the warm counts of the kinds the driver says it keeps warm, and no others", async () => {
  const { context, make } = setup({ "proxmox-lxc-linux-templates": "9000", "proxmox-lxc-desktop-cpu-templates": "9002", "proxmox-lxc-desktop-wayland-cpu-templates": "9003" });
  const recorded = recordingWarm(context);
  await make(recorded.context).maintain();
  assert.deepEqual([...recorded.asked].sort(), [...proxmoxLxcDriver.warmKinds!].sort());
});
