import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { boxForm } from "../src/backends/index.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { installFromDescription, ownerFromDescription, ownerFromTags } from "../src/backends/proxmox/owner.ts";
import { ProxmoxQemuBackend, bootDisk, net0On, smbios1For, type QemuBackendOptions } from "../src/backends/proxmox-qemu/backend.ts";
import { parseQemuPart, type QemuConfig } from "../src/backends/proxmox-qemu/config.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, KEY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const GiB = 2 ** 30;
const KIND = "windows-desktop";

const VALUES = {
  url: "https://pve.example.com:8006/api2/json",
  "token-id": FAKE_TOKEN.tokenId,
  "token-secret": FAKE_TOKEN.tokenSecret,
  "windows-templates": "9104",
  bridge: "vmbr1",
  subnet: "192.0.2.0/24",
  gateway: "192.0.2.1",
  addresses: "192.0.2.150-192.0.2.159",
  "vmid-first": 9700,
  "vmid-last": 9709,
  "ssh-private-key": KEY,
};

function parse(values: Record<string, unknown> = {}) {
  return parseQemuPart({ id: "proxmox-qemu", fields: { ...VALUES, ...values } as never, hosts: [] });
}

function qemuConfig(values: Record<string, unknown> = {}): QemuConfig {
  const parsed = parse(values);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}

/** Every backend the tests make, disposed at the end so their key files go. */
const made: ProxmoxQemuBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

/** The fake Proxmox, SSH and network, and no waiting. */
function setup(values: Record<string, unknown> = {}, storage = new MemoryStorage(), options: QemuBackendOptions = {}) {
  const ssh = fakeSsh();
  // Each box address answers as Windows does, in PowerShell.
  for (let last = 150; last <= 159; last++) ssh.windows(`192.0.2.${last}`);
  const proxmox = new FakeProxmox();
  proxmox.addVmTemplate(9104);
  proxmox.addVmTemplate(9105);
  const context = testContext(storage, "test", { id: "proxmox-qemu" });
  const config = qemuConfig(values);
  const fakes: QemuBackendOptions = { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 };
  const make = () => {
    const backend = new ProxmoxQemuBackend(config, context, { ...fakes, ...options });
    made.push(backend);
    return backend;
  };
  return { ssh, proxmox, context, storage, make, backend: make() };
}

const sized = (size: Partial<BoxSize> = {}): BoxSize => ({ ...defaultSize(kindSizes(KIND)), ...size });

let boxCounter = 0;
function identity(size = sized(), kind = KIND): BoxIdentity {
  boxCounter++;
  return { boxId: `box_${boxCounter}`, threadId: "thr_abc123", name: `calm-otter-${boxCounter}`, kind, createdAt: 1_790_000_000_000, size };
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

function releasing(): ReleaseHooks {
  return {
    resetting: async () => {
      throw new Error("A virtual backend has nothing to reset.");
    },
    timing: () => {},
  };
}

/** A PowerShell stand-in that extends C: as `extend` says, and runs every other script with sh. */
function extending(extend: string): string {
  return `case "$1" in\n  *Resize-Partition*) ${extend};;\n  *) exec sh -c "$1";;\nesac\n`;
}

test("the driver makes VMs, and its kind is a Windows desktop that runs PowerShell", () => {
  assert.equal(boxForm("proxmox-qemu:main"), "VM");
  const [kind, ...others] = setup().backend.kinds();
  assert.deepEqual(others, []);
  assert.equal(kind!.id, KIND);
  assert.deepEqual(kind!.capabilities.command, { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true });
  assert.equal(kind!.capabilities.os, "windows");
  assert.equal(kind!.capabilities.arch, "x86_64");
  assert.equal(kind!.capabilities.enrol, false, "BB cannot enrol a Windows box yet");
  assert.deepEqual(kind!.capabilities.displays, []);
  assert.equal(kind!.capabilities.computerUse, null);
});

test("the settings list Windows templates by VMID", () => {
  assert.deepEqual(qemuConfig({ "windows-templates": "9104, 9105" }).templates, [9104, 9105]);
  assert.deepEqual(qemuConfig({ "windows-templates": 9104 }).templates, [9104], "a settings file may give one VMID as a number");
  const problems = (values: Record<string, unknown>) => {
    const parsed = parse(values);
    return parsed.ok ? [] : parsed.problems;
  };
  assert.deepEqual(problems({ "windows-templates": "" }), [{ path: "windows-templates", message: "Set the VMID of at least one Windows template." }]);
  assert.deepEqual(problems({ "windows-templates": "9104 win" }), [{ path: "windows-templates", message: 'Use VMIDs from 100 for the Windows templates. "win" is not one.' }]);
  assert.deepEqual(problems({ "windows-templates": "9104 9104" }), [{ path: "windows-templates", message: "Template 9104 is listed more than once. List each template once." }]);
  assert.deepEqual(problems({ "windows-templates": "9701" }), [{ path: "vmid-first", message: "Move template 9701 out of the box VMID range." }]);
  assert.deepEqual(problems({ "ssh-user": "Box User" }).map((problem) => problem.path), ["ssh-user"]);
});

test("the serial carries the address, prefix and gateway in base64, with a UUID", () => {
  const smbios1 = smbios1For("10.200.0.12", 24, "10.200.0.1", "6f1c7e4e-0b8a-4a63-9a4e-3f1d2c5b7a90");
  assert.equal(smbios1, `base64=1,uuid=6f1c7e4e-0b8a-4a63-9a4e-3f1d2c5b7a90,serial=${Buffer.from("10.200.0.12/24 10.200.0.1").toString("base64")}`);
  assert.notEqual(/uuid=([^,]+)/.exec(smbios1For("192.0.2.150", 24, "192.0.2.1"))![1], /uuid=([^,]+)/.exec(smbios1For("192.0.2.150", 24, "192.0.2.1"))![1]);
});

test("a clone's NIC keeps its MAC on the bridge, and the boot disk is the first disk in the boot order", () => {
  assert.equal(net0On("virtio=BC:24:11:00:97:00,bridge=vmbr0,firewall=1", "vmbr1"), "virtio=BC:24:11:00:97:00,bridge=vmbr1,firewall=1");
  assert.equal(net0On("virtio=BC:24:11:00:97:00", "vmbr1"), "virtio=BC:24:11:00:97:00,bridge=vmbr1");
  assert.equal(net0On(undefined, "vmbr1"), "virtio,bridge=vmbr1");
  assert.equal(bootDisk({ boot: "order=ide2;virtio0", ide2: "none,media=cdrom", virtio0: "local-lvm:vm-1-disk-0,size=64G" }), "virtio0");
  assert.equal(bootDisk({ scsi0: "local-lvm:vm-1-disk-0,size=64G" }), "scsi0", "with no boot order, the first disk");
  assert.equal(bootDisk({ ide2: "none,media=cdrom" }), null);
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
    ref: "9700",
    host: "pve",
    address: "192.0.2.150",
    size: { cores: 4, memoryMiB: 8192, diskGiB: 64 },
    data: { template: 9104, box: box.boxId },
  });
  assert.deepEqual(hook.claimed[0]?.data, { template: 9104, box: box.boxId }, "the claim records the box");
  assert.deepEqual(hook.events, ["claim 9700", "clone 9700", "starting"]);
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "network", "ssh", "start", "tags"]);
  const clone = proxmox.calls.find((call) => call.path.endsWith("/clone"))!;
  assert.equal(clone.path, "/nodes/pve/qemu/9104/clone");
  assert.equal(clone.params.full, "0", "a linked clone");

  const vm = proxmox.guests.get(9700)!;
  assert.equal(vm.type, "qemu");
  assert.equal(vm.status, "running");
  assert.equal(vm.pool, "bbbox");
  assert.equal(vm.name, box.name);
  assert.equal(vm.config.cores, "4");
  assert.equal(vm.config.memory, "8192");
  assert.equal(vm.config.onboot, "1");
  assert.equal(vm.config.net0, "virtio=BC:24:11:00:97:00,bridge=vmbr1", "the clone's own MAC, on the box bridge");
  const smbios1 = /^base64=1,uuid=([0-9a-f-]{36}),serial=([A-Za-z0-9+/=]+)$/.exec(vm.config.smbios1 ?? "");
  assert.ok(smbios1, vm.config.smbios1);
  assert.equal(Buffer.from(smbios1[2]!, "base64").toString(), "192.0.2.150/24 192.0.2.1");
  assert.equal(vm.config.protection, undefined, "the template's protection is dropped");
  assert.equal(proxmox.calls.some((call) => call.path.endsWith("/resize")), false, "the template's disk is kept");
  const tags = parseTags(vm.config.tags);
  assert.deepEqual(tags.slice(0, 2), ["bb-box", "install.test"]);
  assert.equal(tags.at(-1), "template.9104");
  assert.deepEqual(ownerFromTags(tags), { boxId: box.boxId, threadId: box.threadId, name: null, kind: KIND, createdAt: box.createdAt });
  assert.equal(installFromDescription(vm.config.description), "test", "the clone's description names the install");
  assert.equal(ownerFromDescription(vm.config.description)?.boxId, box.boxId);

  // The ready check opened the box's shared SSH connection, for its first commands.
  const dials = ssh.log().filter((entry) => entry.target === "box@192.0.2.150");
  assert.deepEqual(dials.map((entry) => entry.control ?? "command"), ["master", "command"]);

  const transports = await backend.transports(guest);
  const result = await transports.command!.run("echo hi from $USER", { timeoutMs: 10_000 });
  assert.equal(result.stdout, "hi from box\n");
  assert.match(ssh.log().at(-1)!.command, /FromBase64String/, "commands go to PowerShell");
  assert.deepEqual(transports.access!.ssh, { host: "192.0.2.150", port: 22, user: "box", hostKeys: [] });
  assert.deepEqual(transports.displays, []);
});

test("a larger disk grows before the box starts, and C: is extended over it", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.powershell("192.0.2.150", extending('echo "$1" > "$HOME/extended"; exit 0'));
  const states: string[] = [];
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/resize")) states.push(`${call.params.disk} ${proxmox.guests.get(Number(call.path.split("/")[4]))!.status}`);
    return undefined;
  };
  const hook = hooks();
  const guest = await backend.acquire(identity(sized({ diskGiB: 100 })), null, hook.value, signal());
  assert.deepEqual(states, ["scsi0 stopped"]);
  assert.match(proxmox.guests.get(9700)!.config.scsi0!, /size=100G/);
  assert.equal(guest.size?.diskGiB, 100, "the size is read back from the VM");
  assert.equal(typeof hook.timings.resize, "number");
  assert.equal(typeof hook.timings.extend, "number");
  assert.match(readFileSync(join(ssh.home("192.0.2.150"), "extended"), "utf8"), /Resize-Partition -DriveLetter C -Size \$max/);
});

test("a disk no larger than the template's is kept, and C: is left alone", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.powershell("192.0.2.150", extending('touch "$HOME/extended"; exit 0'));
  const guest = await backend.acquire(identity(sized({ diskGiB: 40 })), null, hooks().value, signal());
  assert.equal(guest.size?.diskGiB, 64);
  assert.equal(proxmox.calls.some((call) => call.path.endsWith("/resize")), false);
  assert.equal(existsSync(join(ssh.home("192.0.2.150"), "extended")), false);
});

test("a box whose C: cannot be extended is deleted with Windows's reason", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.powershell("192.0.2.150", extending('echo "Size Not Supported" >&2; exit 1'));
  await assert.rejects(
    backend.acquire(identity(sized({ diskGiB: 100 })), null, hooks().value, signal()),
    /^Error: The box's disk grew, but Windows could not extend C: over it: Size Not Supported\.$/,
  );
  assert.equal(proxmox.guests.has(9700), false);
});

test("a box is made at the size asked for", async () => {
  const { backend, proxmox } = setup();
  const guest = await backend.acquire(identity({ cores: 8, memoryMiB: 16_384, diskGiB: null }), null, hooks().value, signal());
  assert.equal(proxmox.guests.get(9700)!.config.cores, "8");
  assert.equal(proxmox.guests.get(9700)!.config.memory, "16384");
  assert.deepEqual(guest.size, { cores: 8, memoryMiB: 16_384, diskGiB: 64 });
});

test("boxes spread across the Windows templates", async () => {
  const { backend, proxmox } = setup({ "windows-templates": "9104 9105" });
  const first = await backend.acquire(identity(), null, hooks().value, signal());
  const second = await backend.acquire(identity(), null, hooks().value, signal());
  assert.deepEqual([first.data?.template, second.data?.template], [9104, 9105]);
  assert.equal(parseTags(proxmox.guests.get(Number(second.ref))!.config.tags).at(-1), "template.9105");
});

test("acquire resumes the VM of an interrupted acquire", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const first = await backend.acquire(box, null, hooks().value, signal());
  const again = await backend.acquire(box, first, hooks().value, signal());
  assert.equal(again.ref, first.ref);
  assert.equal(proxmox.calls.filter((call) => call.path.endsWith("/clone")).length, 1);
});

test("a VM that fails to start is deleted", async () => {
  const { backend, proxmox } = setup();
  proxmox.nextTaskExit.set("qmstart", "start failed: QEMU exited with code 1");
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /QEMU exited with code 1/);
  assert.equal(proxmox.guests.has(9700), false);
});

test("a clone that fails before it is configured is deleted despite the template's protection", async () => {
  const { backend, proxmox } = setup();
  proxmox.intercept = (call) =>
    call.method === "PUT" && call.params.smbios1
      ? { ok: false, status: 500, statusText: "Internal Server Error", text: async () => JSON.stringify({ data: null, message: "no such bridge" }) }
      : undefined;
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /no such bridge/);
  assert.equal(proxmox.guests.has(9700), false);
});

test("a box that never answers on SSH is deleted, pointing to the template's key and boot log", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.down("192.0.2.150");
  await assert.rejects(
    backend.acquire(identity(), null, hooks().value, signal()),
    /Port 22 of 192\.0\.2\.150 is open, but SSH as box did not answer.*administrators_authorized_keys/,
  );
  assert.equal(proxmox.guests.has(9700), false);

  const closed = setup({}, new MemoryStorage(), { portCheck: async () => false });
  await assert.rejects(closed.backend.acquire(identity(), null, hooks().value, signal()), /Nothing answered on port 22 of 192\.0\.2\.150.*C:\\bb-box\\boot\.log/);
});

test("an unknown kind is refused", async () => {
  const { backend } = setup();
  await assert.rejects(backend.capacity("linux", sized(), [], signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
  await assert.rejects(backend.acquire(identity(sized(), "linux"), null, hooks().value, signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("capacity keeps the memory and disk reserves, and counts a larger disk against the template's storage", async () => {
  const { backend, proxmox } = setup();
  const ok = await backend.capacity(KIND, sized(), [], signal());
  assert.equal(ok.ok, true, ok.message ?? "");
  assert.deepEqual(ok.warm, { ready: 0, target: 0 });
  assert.deepEqual(ok.hosts[0]!.limits, [
    { resource: "memory", used: 16 * 1024, total: 64 * 1024, reserve: 4096, unit: "MiB" },
    { resource: "disk", used: 300 * 1024, total: 900 * 1024, reserve: 50 * 1024, unit: "MiB" },
    { resource: "guests", used: 0, total: 10, reserve: 0, unit: "count" },
  ]);

  const big = await backend.capacity(KIND, sized({ diskGiB: 700 }), [], signal());
  assert.equal(big.ok, false);
  assert.match(big.message!, /^The local-lvm storage on pve has 600 GiB free\. A 700 GiB disk needs 636 GiB more than the template's, and 50 GiB is kept free\./);

  proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  const low = await backend.capacity(KIND, sized(), [{ kind: KIND, size: sized() }], signal());
  assert.equal(low.ok, false);
  assert.match(low.message!, /^pve has 2 GiB of memory free\. A windows-desktop box with 8 GiB memory needs it all/);
});

test("release deletes the VM, and held lists this install's VMs with their owners", async () => {
  const { backend, proxmox, make } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  proxmox.guests.set(9705, { vmid: 9705, type: "qemu", name: "theirs", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.other;box.box_y" } });
  proxmox.guests.set(9706, { vmid: 9706, name: "a-container", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.test;box.box_z" } });
  const held = await make().held();
  assert.deepEqual(
    held.map((one) => [one.ref, one.owner?.boxId, one.power, one.data?.template]),
    [["9700", box.boxId, "running", 9104]],
  );
  assert.equal(await backend.power(guest), "running");

  await backend.release(guest, releasing());
  assert.equal(proxmox.guests.has(9700), false);
  assert.equal(await backend.power(guest), null);
  await backend.release(guest, releasing());
});

test("a box's VM is relabelled with its new owner and name (036)", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" }, box.name, signal());
  const vm = proxmox.guests.get(9700)!;
  assert.equal(vm.name, "build-1");
  assert.equal(ownerFromDescription(vm.config.description)?.threadId, "operator");
  const tags = parseTags(vm.config.tags);
  assert.equal(ownerFromTags(tags)?.threadId, "operator");
  assert.equal(tags.at(-1), "template.9104", "the template tag stays");
});

test("doctor passes on a complete setup and shows the generated public key", async () => {
  const { backend, storage } = setup({ "ssh-private-key": "" });
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
      ["template.9104", "Windows template 9104", "ok"],
      ["proxmox.bridge", "Network bridge", "ok"],
      ["proxmox.vmids", "VMID range", "ok"],
      ["ssh.key", "SSH key", "ok"],
    ],
  );
  const notes = report.notes.join("\n");
  assert.match(notes, /^This install's ID is test\. Its VMs carry the tag install\.test\.$/m);
  assert.match(notes, /C:\\ProgramData\\ssh\\administrators_authorized_keys: ssh-ed25519 \S+ bb-box$/m);
  const stored = await storage.get<{ privateKey: string; publicKey: string }>("ssh-key");
  assert.ok(stored?.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY|s3cret-token-value/);
});

test("doctor says what is missing", async () => {
  const { backend, proxmox } = setup({ "windows-templates": "9104 9105 9106", "ssh-private-key": "" });
  proxmox.bridges.delete("vmbr1");
  const copy = proxmox.guests.get(9105)!;
  copy.template = false;
  delete copy.config.template;
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId["template.9104"]!.status, "ok");
  assert.equal(byId["template.9105"]!.detail, "VM 9105 is not a template.");
  assert.equal(byId["template.9106"]!.detail, "VM 9106 does not exist on pve.");
  assert.match(byId["template.9106"]!.fix!, /setup\/proxmox-qemu\/build\.sh, or remove it from the Windows templates/);
  assert.match(byId["proxmox.bridge"]!.detail, /pve has no vmbr1/);
  assert.match(report.summary, /^Windows template 9105: /);
});
