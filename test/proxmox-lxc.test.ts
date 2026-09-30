import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import {
  ProxmoxLxcBackend,
  installFromDescription,
  ownerFromDescription,
  ownerFromTags,
  type LxcBackendOptions,
} from "../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, tempDir, testContext } from "./helpers.ts";

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
  for (const template of [9000, 9001, 9002, 9003, 9004]) proxmox.addTemplate(template);
  const config = lxcConfig({
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-desktop-templates": "9001 gpu-a",
    "proxmox-lxc-vmid-first": 7000,
    "proxmox-lxc-vmid-last": 7009,
    ...values,
  });
  const context = testContext(storage);
  const make = (on = context) => track(new ProxmoxLxcBackend(config, on, { ...fakes(proxmox), ...options }));
  return { ssh, proxmox, context, storage, make, backend: make() };
}

let boxCounter = 0;
function identity(kind = "linux-headless", threadId = "thr_abc123"): BoxIdentity {
  boxCounter++;
  return { boxId: `box_${boxCounter}`, threadId, name: `calm-otter-${boxCounter}`, kind, createdAt: 1_790_000_000_000 };
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
    ["linux-headless", "linux-headless-docker"],
  );
  assert.deepEqual(kinds[0]!.requires, []);
  assert.deepEqual(kinds[1]!.requires, ["docker"]);
  assert.deepEqual(kinds[0]!.capabilities.features, ["docker"]);
  assert.deepEqual(kinds[0]!.capabilities.command, { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true });
  assert.deepEqual(kinds[0]!.capabilities.displays, []);
  assert.equal(kinds[0]!.capabilities.arch, "x86_64");
  assert.equal(kinds[0]!.readyTimeoutMs, 30_000);
  assert.equal(kinds[0]!.size, "2 cores, 4 GiB memory, the template's disk");
  const desktop = setup().backend.kinds().find((kind) => kind.id === "linux-desktop")!;
  assert.deepEqual(desktop.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }], "xrandr resizes the GPU's screen");
  assert.equal(desktop.capabilities.gpu, true);
  assert.equal(desktop.size, "4 cores, 8 GiB memory, the template's disk");
  const cpu = setup({ "proxmox-lxc-desktop-cpu-templates": "9003" }).backend.kinds().find((kind) => kind.id === "linux-desktop-cpu")!;
  assert.equal(cpu.capabilities.gpu, false);
  assert.deepEqual(cpu.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }], "Xtigervnc resizes");
  assert.deepEqual(cpu.capabilities.computerUse, desktop.capabilities.computerUse);
});

test("a kind's size shows the template's disk once it is known, or the larger size set", async () => {
  const { backend } = setup();
  await backend.capacity("linux-headless", [], signal());
  assert.equal(backend.kinds()[0]!.size, "2 cores, 4 GiB memory, 8 GiB disk");
  const bigger = setup({ "proxmox-lxc-headless-disk-gib": 20 }).backend;
  assert.equal(bigger.kinds()[0]!.size, "2 cores, 4 GiB memory, 20 GiB disk");
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
  const ok = await backend.capacity("linux-headless", [], signal());
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
  const pending = await backend.capacity("linux-headless", ["linux-headless"], signal());
  assert.equal(pending.ok, false);
  assert.match(pending.message!, /pve has 6 GiB of memory free\. A linux-headless box needs 4 GiB and 4 GiB is kept free/);
  assert.match(pending.message!, /bb-box's settings/);

  proxmox.memory = { total: 64 * GiB, available: 48 * GiB };
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 20 * GiB });
  const disk = await backend.capacity("linux-headless", [], signal());
  assert.equal(disk.ok, false);
  assert.equal(disk.hosts[0]!.ok, false);
  assert.match(disk.message!, /local-lvm storage on pve has 20 GiB free, less than the 50 GiB kept free/);
});

test("capacity refuses when the VMID range is full", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000 });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bbbox", status: "running", template: false, config: {} });
  const full = await backend.capacity("linux-headless", [], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /Every VMID from 7000 to 7000 is in use/);
});

test("capacity counts desktops on each GPU against the limit per GPU", async () => {
  const { backend } = setup({ "proxmox-lxc-desktops-per-gpu": 2 });
  const headless = await backend.capacity("linux-headless", [], signal());
  assert.equal(headless.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops"), undefined);

  await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const one = await backend.capacity("linux-desktop", [], signal());
  assert.equal(one.ok, true);
  assert.deepEqual(one.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 1, total: 2, reserve: 0, unit: "count" });

  const full = await backend.capacity("linux-desktop", ["linux-desktop", "linux-headless"], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /Every GPU on pve runs 2 desktop boxes, the most bb-box's settings allow\. Release a desktop box, or raise the desktops per GPU/);

  const unlimited = await setup().backend.capacity("linux-desktop", [], signal());
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
  const display = [{ label: "Display mode", value: "gpu" }, { label: "Display reason", value: "fake GPU" }];
  assert.deepEqual([first.data?.template, first.facts], [9001, [{ label: "GPU", value: "gpu-a" }, ...display]]);
  assert.deepEqual([second.data?.template, second.facts], [9002, [{ label: "GPU", value: "gpu-b" }, ...display]]);
  assert.ok(parseTags(proxmox.guests.get(Number(second.ref))!.config.tags).includes("template.9002"));

  const full = await backend.capacity("linux-desktop", [], signal());
  assert.equal(full.ok, false);
  assert.deepEqual(full.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 2, total: 2, reserve: 0, unit: "count" });
  assert.match(full.message!, /Every GPU on pve runs 1 desktop box, .* Use a linux-desktop-cpu box, or release a desktop box/);
  assert.equal((await backend.capacity("linux-desktop-cpu", [], signal())).ok, true, "CPU desktops use no GPU");

  const cpu = await backend.acquire(identity("linux-desktop-cpu"), null, hooks().value, signal());
  assert.equal(cpu.data?.template, 9003);
  assert.deepEqual(cpu.facts, display, "a CPU desktop names no GPU");

  await backend.release(first, releasing());
  assert.equal((await backend.capacity("linux-desktop", [], signal())).ok, true, "gpu-a has room again");
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
    { label: "Display mode", value: "gpu" },
    { label: "Display reason", value: "fake GPU" },
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
  displayAt(ssh.dir, "192.0.2.100", "cpu", "software rendering");
  const guest = await backend.acquire(identity("linux-desktop-cpu"), null, hooks().value, signal());
  assert.equal(guest.ref, "7000");
  assert.deepEqual(guest.facts, [
    { label: "Display mode", value: "cpu" },
    { label: "Display reason", value: "software rendering" },
  ]);
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
  const { backend } = setup({ "proxmox-lxc-headless-templates": "9000 9004" });
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
    const capacity = await backend.capacity("linux-desktop", ["linux-desktop"], signal());
    during = capacity.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops")?.used;
  } }, signal());
  await acquired;
  assert.equal(during, 1, "the acquiring box is both pending and listed, and counts once");
  assert.equal(proxmox.guests.size, 6);
});

test("an unknown kind is refused", async () => {
  const { backend } = setup({ "proxmox-lxc-desktop-templates": "" });
  await assert.rejects(backend.capacity("linux-desktop", [], signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("acquire claims the VMID before it clones, then configures and starts the box", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const hook = hooks();
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) hook.events.push(`clone ${call.params.newid}`);
    return undefined;
  };
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest, { ref: "7000", host: "pve", address: "192.0.2.100", data: { template: 9000, box: box.boxId } });
  assert.deepEqual(hook.claimed[0]?.data, { template: 9000, box: box.boxId }, "the claim records the box");
  assert.deepEqual(hook.events, ["claim 7000", "clone 7000", "starting"]);
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "network", "ssh", "start", "tags", "warm"]);

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
});

test("a larger disk is applied once the box runs", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-disk-gib": 20 });
  const states: string[] = [];
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/resize")) states.push(proxmox.guests.get(Number(call.path.split("/")[4]))!.status);
    return undefined;
  };
  const hook = hooks();
  await backend.acquire(identity(), null, hook.value, signal());
  assert.deepEqual(states, ["running"]);
  assert.match(proxmox.guests.get(7000)!.config.rootfs!, /size=20G/);
  assert.equal(typeof hook.timings.resize, "number");
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
    /Port 22 of 192\.0\.2\.100 is open, but SSH as box did not answer.*user box in the linux-headless template accepts bb-box's key/,
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
  await assert.rejects(backend.release({ ref: "9000", host: null, address: null }, releasing()), /outside bb-box's VMID range/);
  assert.equal(proxmox.guests.has(9000), true);
});

test("power, stop and start, and a box's shared SSH connection closes before it stops and before it goes", async () => {
  const { backend, ssh } = setup();
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const run = async () => assert.equal((await (await backend.transports(guest, "linux-headless")).command!.run("true")).exitCode, 0);
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
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-warm": 1, "proxmox-lxc-desktops-per-gpu": 1 });
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
  assert.equal((await other.capacity("linux-desktop", [], signal())).ok, false, "this install's desktop still uses the GPU");

  const theirs = await other.acquire(identity(), null, hooks().value, signal());
  assert.equal(theirs.ref, "7002", "the other install clones rather than take this one's warm guest");
  assert.deepEqual(parseTags(proxmox.guests.get(7002)!.config.tags).slice(0, 2), ["bb-box", "install.other"]);
  assert.deepEqual((await backend.held()).map((guest) => guest.ref), ["7001"]);
  assert.equal(await backend.power(theirs), null);
});

test("stamp records this install on its guest from before install IDs, and leaves others alone", async () => {
  const { backend, proxmox } = setup();
  const tags = "bb-box;box.box_old;thread.thr_x;kind.linux-headless;template.9000";
  proxmox.guests.set(7005, {
    vmid: 7005,
    name: "old",
    pool: "bbbox",
    status: "running",
    template: false,
    config: { tags, description: "bb-box old\nbox box_old\nthread thr_x" },
  });
  proxmox.guests.set(7006, { vmid: 7006, name: "theirs", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.other;box.box_old" } });
  const guest: Guest = { ref: "7005", host: "pve", address: "192.0.2.105", data: { template: 9000 } };
  assert.deepEqual(await backend.held(), [], "a guest with no install ID is not this install's yet");

  const wrong = await backend.stamp("box_other", guest);
  assert.deepEqual(wrong.data, { template: 9000, box: "box_other" });
  assert.equal(proxmox.guests.get(7005)!.config.tags, tags, "a guest that names another box is not stamped");
  assert.equal(await backend.power(wrong), null);

  const stamped = await backend.stamp("box_old", guest);
  assert.deepEqual(stamped.data, { template: 9000, box: "box_old" });
  const config = proxmox.guests.get(7005)!.config;
  assert.deepEqual(parseTags(config.tags), ["bb-box", "install.test", "box.box_old", "thread.thr_x", "kind.linux-headless", "template.9000"]);
  assert.equal(config.description, "bb-box old\ninstall test\nbox box_old\nthread thr_x");
  assert.deepEqual(
    (await backend.held()).map((held) => [held.ref, held.owner?.boxId]),
    [["7005", "box_old"]],
  );
  assert.equal(await backend.power(stamped), "running");

  await backend.stamp("box_old", { ref: "7006", host: "pve", address: null });
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
    config: { description: "bb-box half-done\ninstall test\nbox box_x\nthread thr_x\nkind linux-headless\ncreated 2026-09-30T00:00:00.000Z" },
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
    config: { tags: "bb-box;install.other;box.box_y;thread.thr_y;kind.linux-headless" },
  });
  proxmox.guests.set(7006, { vmid: 7006, name: "their-half", pool: "bbbox", status: "stopped", template: false, config: { description: "bb-box their-half\ninstall other\nbox box_z" } });
  proxmox.guests.set(7007, { vmid: 7007, name: "mystery", pool: "bbbox", status: "running", template: false, config: {} });
  proxmox.guests.set(7008, { vmid: 7008, name: "old", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;box.box_old;thread.thr_x;kind.linux-headless" } });
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
  assert.deepEqual(held[1]!.owner, { boxId: "box_x", threadId: "thr_x", name: "half-done", kind: "linux-headless", createdAt: Date.parse("2026-09-30T00:00:00.000Z") });
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
  const plain = await backend.transports(headless, "linux-headless");
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
  assert.deepEqual([display!.id, display!.label, display!.protocol, display!.resizable], ["desktop", "Desktop", "rfb", true]);
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
});

test("the warm pool fills, hands out a ready guest and refills", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-warm": 1 });
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

  // Claiming a warm guest starts a refill; maintain returns the one in flight.
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "install.test", "warm", "template.9000"]);
  const capacity = await backend.capacity("linux-headless", [], signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });

  // Both headless kinds are clones of one template, so the warm guest serves either.
  const docker = identity("linux-headless-docker");
  const second = await backend.acquire(docker, null, hooks().value, signal());
  assert.equal(second.ref, "7001");
  assert.equal(ownerFromTags(parseTags(proxmox.guests.get(7001)!.config.tags))?.kind, "linux-headless-docker");
});

test("a warm guest satisfies capacity even when memory is short", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-warm": 1 });
  await backend.maintain();
  proxmox.memory = { total: 64 * GiB, available: 1 * GiB };
  assert.equal((await backend.capacity("linux-headless", [], signal())).ok, true);
  assert.equal((await backend.capacity("linux-headless", ["linux-headless"], signal())).ok, false);
});

test("warm guests beyond the target are removed", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-headless-warm": 2 });
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 2);
  const smaller = track(
    new ProxmoxLxcBackend(
      lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009, "proxmox-lxc-headless-warm": 1 }),
      context,
      fakes(proxmox),
    ),
  );
  await smaller.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  assert.deepEqual(context.errors, []);
});

test("the warm pool stops at the capacity guard", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-headless-warm": 3 });
  proxmox.memory = { total: 16 * GiB, available: 9 * GiB };
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) proxmox.memory = { ...proxmox.memory, available: proxmox.memory.available - 2 * GiB };
    return undefined;
  };
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  assert.match(context.errors.join("\n"), /warm pool: .*memory free/);
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
      ["proxmox.pool", "Resource pool", "ok"],
      ["template.9000", "Headless template 9000", "ok"],
      ["template.9001", "GPU desktop template 9001 (GPU gpu-a)", "ok"],
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
  await assert.rejects(backend.capacity("linux-headless", [], signal()), (error: unknown) => {
    assert.doesNotMatch(String(error), /wrong-secret-value/);
    return true;
  });
});

test("dispose stops a warm fill", async () => {
  const { backend } = setup({ "proxmox-lxc-headless-warm": 1 });
  const fill = backend.maintain();
  await backend.dispose();
  await fill.catch(() => undefined);
});
