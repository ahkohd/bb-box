import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Backends, DRIVERS, boxForm, overlapChecks } from "../src/backends/index.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { installFromDescription, ownerFromDescription, ownerFromTags } from "../src/backends/proxmox/owner.ts";
import { proxmoxFootprint } from "../src/backends/proxmox/settings.ts";
import { proxmoxLxcDriver } from "../src/backends/proxmox-lxc/index.ts";
import { ProxmoxQemuBackend, bootDisk, net0On, smbios1For, type QemuBackendOptions } from "../src/backends/proxmox-qemu/backend.ts";
import { parseQemuPart, type QemuConfig } from "../src/backends/proxmox-qemu/config.ts";
import { proxmoxQemuDriver } from "../src/backends/proxmox-qemu/index.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { backendPart, checkDocument, type BackendConfig, type ConfigDocument, type Secrets } from "../src/core/document.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { driverFields } from "../src/plugin/configuration.ts";
import { generateKeyPair } from "../src/transports/ssh.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, KEY, MemoryStorage, fakeSsh, lxcConfig, testContext } from "./helpers.ts";

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

test("the driver makes VMs, and its kind is a Windows desktop that runs PowerShell and offers computer use", () => {
  assert.equal(boxForm("proxmox-qemu:main"), "VM");
  const [kind, ...others] = setup().backend.kinds();
  assert.deepEqual(others, []);
  assert.equal(kind!.id, KIND);
  assert.deepEqual(kind!.capabilities.command, { transport: "ssh", shell: "powershell", admin: true, inDesktopSession: false, streaming: true });
  assert.equal(kind!.capabilities.os, "windows");
  assert.equal(kind!.capabilities.arch, "x86_64");
  assert.equal(kind!.capabilities.enrol, false, "BB cannot enrol a Windows box yet");
  assert.deepEqual(kind!.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }]);
  assert.deepEqual(kind!.capabilities.computerUse, { driver: "cua", version: "0.30.4", socket: "\\\\.\\pipe\\cua-driver" });
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

/** A host that runs Linux boxes already: Proxmox LXC's connection and key, as the setup guide gives them. */
const LXC: BackendConfig = {
  id: "proxmox-lxc",
  type: "proxmox-lxc",
  enabled: true,
  fields: { url: "https://pve.example.com:8006/api2/json", "token-id": FAKE_TOKEN.tokenId, "tls-fingerprint": "AB:".repeat(31) + "AB", node: "pve-lxc" },
};
const LXC_SECRETS = { "token-secret": FAKE_TOKEN.tokenSecret, "ssh-private-key": KEY };
const WINDOWS_FIELDS = { "windows-templates": "9104", bridge: "vmbr1", subnet: "192.0.2.0/24", gateway: "192.0.2.1", addresses: "192.0.2.150-192.0.2.159", "vmid-first": 9700, "vmid-last": 9709 };

/** Proxmox QEMU's part beside Proxmox LXC, with `fields` and `secrets` of its own. */
function besideLxc(fields: Record<string, string | number> = {}, secrets: Record<string, string> = {}, lxc: BackendConfig | null = LXC) {
  const qemu: BackendConfig = { id: "proxmox-qemu", type: "proxmox-qemu", enabled: true, fields: { ...WINDOWS_FIELDS, ...fields } };
  const all: Secrets = { "proxmox-lxc": LXC_SECRETS, "proxmox-qemu": secrets };
  return backendPart(qemu, proxmoxQemuDriver, all, lxc ? [lxc, qemu] : [qemu]);
}

test("an empty connection and SSH key take Proxmox LXC's, and the node stays this backend's", () => {
  const part = besideLxc();
  assert.equal(part.fields.url, LXC.fields.url);
  assert.equal(part.fields["token-id"], FAKE_TOKEN.tokenId);
  assert.equal(part.fields["token-secret"], FAKE_TOKEN.tokenSecret);
  assert.equal(part.fields["tls-fingerprint"], LXC.fields["tls-fingerprint"]);
  assert.equal(part.fields["ca-certificate"], "", "Proxmox LXC has no CA certificate, so none comes");
  assert.equal(part.fields["ssh-private-key"], KEY);
  assert.equal(part.fields.node, "", "the template's node may not be Proxmox LXC's");
  const parsed = parseQemuPart(part);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  assert.equal(parsed.config.proxmox.tokenSecret, FAKE_TOKEN.tokenSecret);
  assert.equal(parsed.config.ssh.privateKey?.trim(), KEY, "the key as normalised");
  assert.equal(besideLxc({ url: "  " }).fields.url, LXC.fields.url, "a blank URL is empty");
});

test("a connection or key set here is this backend's whole, and nothing comes without Proxmox LXC", () => {
  const own = besideLxc({ url: "https://other.example.com:8006/api2/json" });
  assert.equal(own.fields.url, "https://other.example.com:8006/api2/json");
  assert.equal(own.fields["token-id"], "", "Proxmox LXC's token is not for another host");
  assert.equal(own.fields["token-secret"], undefined);
  assert.equal(own.fields["tls-fingerprint"], "", "nor its certificate");
  assert.equal(own.fields["ssh-private-key"], KEY, "the key goes on its own");
  const parsed = parseQemuPart(own);
  assert.ok(!parsed.ok);
  assert.deepEqual(parsed.problems.map((problem) => problem.path), ["token-id", "token-secret"]);

  const key = besideLxc({}, { "ssh-private-key": "own key" });
  assert.equal(key.fields["ssh-private-key"], "own key");
  assert.equal(key.fields["token-secret"], FAKE_TOKEN.tokenSecret, "the connection still comes from Proxmox LXC");

  const alone = besideLxc({}, {}, null);
  assert.equal(alone.fields.url, "");
  assert.equal(alone.fields["ssh-private-key"], undefined);
});

test("the document check and the backends take Proxmox LXC's connection, and a change to it rebuilds the backend", async () => {
  const lxcProblems = { ...proxmoxLxcDriver, parse: () => ({ ok: false as const, problems: [{ path: "", message: "Not under test." }] }) };
  const qemu: BackendConfig = { id: "proxmox-qemu", type: "proxmox-qemu", enabled: true, fields: WINDOWS_FIELDS };
  const document = (lxc: BackendConfig): ConfigDocument => ({ schema: 1, revision: 1, backends: [lxc, qemu], kinds: {}, general: {} });
  const secrets: Secrets = { "proxmox-lxc": LXC_SECRETS };
  const ofQemu = (doc: ConfigDocument) => checkDocument(doc, secrets, DRIVERS).filter((problem) => problem.path.startsWith("backends.proxmox-qemu"));
  assert.deepEqual(ofQemu(document(LXC)), []);
  assert.deepEqual(
    ofQemu({ ...document(LXC), backends: [qemu] }).map((problem) => problem.path),
    ["backends.proxmox-qemu.url", "backends.proxmox-qemu.token-id", "backends.proxmox-qemu.token-secret"],
  );

  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {}, drivers: [lxcProblems, proxmoxQemuDriver] });
  try {
    await backends.configure(document(LXC), secrets);
    const first = backends.get("proxmox-qemu");
    assert.ok(first, JSON.stringify(backends.statuses()));
    await backends.configure(document(LXC), secrets);
    assert.equal(backends.get("proxmox-qemu"), first, "the same fields keep the backend");
    await backends.configure(document({ ...LXC, fields: { ...LXC.fields, url: "https://pve2.example.com:8006/api2/json" } }), secrets);
    assert.notEqual(backends.get("proxmox-qemu"), first, "a new URL in Proxmox LXC rebuilds it");
  } finally {
    await backends.dispose();
  }
});

test("the settings page learns which fields come from Proxmox LXC, set by set", () => {
  const fields = Object.fromEntries(driverFields(proxmoxQemuDriver, DRIVERS).map((field) => [field.key, field.inherits]));
  const connection = ["url", "token-id", "token-secret", "tls-fingerprint", "ca-certificate"];
  for (const key of connection) assert.deepEqual(fields[key], { from: "proxmox-lxc", label: "Proxmox LXC", set: connection }, key);
  assert.deepEqual(fields["ssh-private-key"], { from: "proxmox-lxc", label: "Proxmox LXC", set: ["ssh-private-key"] });
  assert.equal(fields.node, undefined);
  assert.equal(fields["windows-templates"], undefined);
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
  assert.deepEqual(
    transports.displays.map(({ open: _, resize: __, ...display }) => display),
    [{ id: "desktop", label: "Desktop", protocol: "rfb", resizable: true, minSize: { width: 800, height: 600 } }],
  );
});

test("the desktop resizes to the viewer's size, else to the listed mode that best covers it, set by Windows in the box user's session, and gives Windows' reason when it cannot", async () => {
  const { backend, ssh } = setup();
  const home = ssh.home("192.0.2.150");
  // A stand-in for PowerShell that keeps each desktop command, and exits as $HOME/exit says.
  // It compiles the display helper slowly, and a desktop command fails if that has not finished.
  ssh.powershell(
    "192.0.2.150",
    `case "$1" in\n  *Schedule.Service*) [ -f "$HOME/compiled" ] || exit 9; printf "%s" "$1" > "$HOME/desktop"; [ -f "$HOME/exit" ] && . "$HOME/exit"; exit 0;;\n  *Add-Type*) sleep 0.5; printf "%s" "$1" > "$HOME/compiled";;\n  *) exec sh -c "$1";;\nesac\n`,
  );
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const [desktop] = (await backend.transports(guest)).displays;

  // The acquire compiles the helper into a file, and the first resize waits for it.
  await desktop!.resize!({ width: 1500, height: 900 });
  const compiled = readFileSync(join(home, "compiled"), "utf8");
  const dll = /'bb-box', '(display-[0-9a-f]{12}\.dll)'\)\n/.exec(compiled)?.[1];
  assert.ok(dll, "named for its source, in the box user's local app data");
  assert.match(compiled, /\n    Add-Type -OutputAssembly \$bbTemp -TypeDefinition @'\n/);
  const task = readFileSync(join(home, "desktop"), "utf8");
  assert.match(task, /\$bbTask\.Principal\.LogonType = 3\n/, "a task in the box user's session");
  assert.match(task, /\$bbClock\.ElapsedMilliseconds -ge 15000\)/, "that ends if it hangs");
  const run = Buffer.from(/FromBase64String\(''([A-Za-z0-9+\/=]+)''\)/.exec(task)![1]!, "base64").toString("utf8");
  assert.match(run, /ChangeDisplaySettingsEx\(null, ref mode, IntPtr\.Zero, 1, IntPtr\.Zero\)/, "keeps the mode for the next logon");
  assert.match(run, /DateTime\.UtcNow\.AddSeconds\(2\)/, "waits a moment for the driver to take the size");
  assert.ok(run.startsWith(compiled), "loads the same file, compiling it if it is missing");
  assert.match(run, /\n\$bbRefused = \$bbDisplay::Fit\(1500, 900\)\n/);

  writeFileSync(join(home, "exit"), `echo "Windows refused 1500x900 and the modes it lists, with -2." >&2; exit 1\n`);
  await assert.rejects(desktop!.resize!({ width: 1500, height: 900 }), { message: "Windows could not set the desktop to 1500x900: Windows refused 1500x900 and the modes it lists, with -2." });
  writeFileSync(join(home, "exit"), `echo "bb-box: there is no desktop session to join: box is not logged in to the desktop." >&2; exit 69\n`);
  await assert.rejects(desktop!.resize!({ width: 1280, height: 800 }), /^Error: Windows could not set the desktop to 1280x800: bb-box: there is no desktop session to join/);
  writeFileSync(join(home, "exit"), "exit 3\n");
  await assert.rejects(desktop!.resize!({ width: 1280, height: 800 }), { message: "Windows could not set the desktop to 1280x800: exit code 3." });

  rmSync(join(home, "desktop"));
  await assert.rejects(desktop!.resize!({ width: 0, height: 800 }), { message: "The desktop cannot be 0 by 800 pixels." });
  await assert.rejects(desktop!.resize!({ width: 1280.5, height: 800 }), { message: "The desktop cannot be 1280.5 by 800 pixels." });
  assert.equal(existsSync(join(home, "desktop")), false, "a size that is not one runs nothing");
});

test("a stop hibernates the VM, and a start resumes it and sets Windows' clock, or gives Windows' reason", async () => {
  const { backend, proxmox, ssh } = setup();
  const home = ssh.home("192.0.2.150");
  // A stand-in for PowerShell that keeps the clock script, and exits as $HOME/exit says.
  ssh.powershell("192.0.2.150", `case "$1" in\n  *Set-Date*) printf "%s" "$1" > "$HOME/clock"; [ -f "$HOME/exit" ] && . "$HOME/exit"; exit 0;;\n  *) exec sh -c "$1";;\nesac\n`);
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const vm = proxmox.guests.get(9700)!;
  const suspends = () => proxmox.calls.filter((call) => call.method === "POST" && call.path.endsWith("/status/suspend"));

  await backend.stop(guest, signal());
  assert.deepEqual([vm.status, vm.config.lock], ["stopped", "suspended"], "suspended to disk");
  assert.equal(suspends()[0]!.params.todisk, "1");
  assert.equal(await backend.power(guest, signal()), "stopped");
  await backend.stop(guest, signal());
  assert.equal(suspends().length, 1, "a stopped VM is left as it is");

  const before = Date.now();
  const steps: string[] = [];
  await backend.start(guest, signal(), (step, ms) => steps.push(`${step} ${Number.isInteger(ms) && ms >= 0}`));
  const after = Date.now();
  assert.deepEqual([vm.status, vm.config.lock, vm.config.vmstate], ["running", undefined, undefined], "resumed");
  assert.deepEqual(steps, ["resume true", "network true", "ssh true", "clock true"], "with the time each step took");
  const clock = readFileSync(join(home, "clock"), "utf8");
  const ms = Number(/FromUnixTimeMilliseconds\((\d+)\)/.exec(clock)?.[1]);
  assert.ok(ms >= before && ms <= after, "set to BB's server's time");
  assert.match(clock, /\[Diagnostics\.Process\]::GetCurrentProcess\(\)\.StartTime\)/, "plus the time PowerShell took to start");

  // A VM shut down from Windows boots.
  vm.status = "stopped";
  steps.length = 0;
  await backend.start(guest, signal(), (step) => steps.push(step));
  assert.deepEqual(steps, ["boot", "network", "ssh", "clock"]);

  writeFileSync(join(home, "exit"), `echo "Set-Date: A required privilege is not held by the client." >&2; exit 1\n`);
  await backend.stop(guest, signal());
  await assert.rejects(backend.start(guest, signal()), { message: "Windows could not set its clock: Set-Date: A required privilege is not held by the client." });
  assert.equal(await backend.power(guest, signal()), "running");

  await backend.stop(guest, signal());
  await backend.release(guest, releasing(), signal());
  assert.equal(proxmox.guests.has(9700), false, "a hibernated VM is deleted with its state");
  await assert.rejects(backend.start(guest, signal()), { name: "BackendError", code: "gone" });
  await assert.rejects(backend.stop(guest, signal()), { name: "BackendError", code: "gone" });
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

test("the desktop is the VM's console, through a VNC proxy of the API's on its token and certificate", async () => {
  const fingerprint = Array(32).fill("AB").join(":");
  const { backend, proxmox } = setup({ "tls-fingerprint": fingerprint });
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const [desktop] = (await backend.transports(guest)).displays;
  const { route, auth } = await desktop!.open();
  const proxy = proxmox.calls.at(-1)!;
  assert.equal(`${proxy.method} ${proxy.path}`, "POST /nodes/pve/qemu/9700/vncproxy");
  assert.deepEqual(proxy.params, { websocket: "1", "generate-password": "1" });
  const [issued] = proxmox.consoles;
  assert.ok(route.type === "websocket" && issued?.password);
  const url = new URL(route.url);
  assert.equal(`${url.origin}${url.pathname}`, "wss://pve.example.com:8006/api2/json/nodes/pve/qemu/9700/vncwebsocket");
  assert.equal(url.searchParams.get("port"), String(issued.port));
  assert.equal(url.searchParams.get("vncticket"), issued.ticket);
  assert.deepEqual(route.headers, { Authorization: `PVEAPIToken=${FAKE_TOKEN.tokenId}=${FAKE_TOKEN.tokenSecret}` });
  assert.deepEqual(route.protocols, ["binary"], "Proxmox requires a subprotocol");
  assert.equal(route.fingerprint, fingerprint, "the API's certificate, not the one in the proxy's answer");
  assert.equal(route.ca, undefined);
  assert.deepEqual(auth, { type: "vnc-password", password: issued.password });

  await desktop!.open();
  assert.equal(proxmox.consoles.length, 2, "each viewer gets a proxy of its own");
  proxmox.guests.get(9700)!.status = "stopped";
  await assert.rejects(desktop!.open(), /VM 9700 not running/);
  proxmox.intercept = (call) =>
    call.path.endsWith("/vncproxy")
      ? { ok: false, status: 403, statusText: "Permission check failed (/vms/9700, VM.Console)", text: async () => '{"data":null}' }
      : undefined;
  await assert.rejects(desktop!.open(), /^Error: The Proxmox token lacks VM.Console. Run setup-token.sh again to add it.$/);
});

test("the console trusts the API's CA, or the system roots when there is none", async () => {
  const ca = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----";
  for (const [values, trust] of [
    [{ "ca-certificate": ca }, { ca }],
    [{}, {}],
  ] as const) {
    const { backend } = setup(values);
    const guest = await backend.acquire(identity(), null, hooks().value, signal());
    const { route } = await (await backend.transports(guest)).displays[0]!.open();
    assert.ok(route.type === "websocket");
    assert.deepEqual({ ca: route.ca, fingerprint: route.fingerprint }, { ca: undefined, fingerprint: undefined, ...trust });
  }
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

test("doctor passes on a complete setup, and warns that a template from build.sh lacks a key bb-box made", async () => {
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
      ["ssh.key", "SSH key", "warn"],
    ],
  );
  assert.match(report.checks.at(-1)!.fix!, /^Paste BBBOX_SSH_KEY, the key build\.sh put in the template, here or in Proxmox LXC's settings\./);
  const notes = report.notes.join("\n");
  assert.match(notes, /^This install's ID is test\. Its VMs carry the tag install\.test\.$/m);
  assert.match(notes, /C:\\ProgramData\\ssh\\administrators_authorized_keys: ssh-ed25519 \S+ bb-box$/m);
  const stored = await storage.get<{ privateKey: string; publicKey: string }>("ssh-key");
  assert.ok(stored?.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY|s3cret-token-value/);
});

test("doctor passes the key from the settings", async () => {
  const { privateKey } = await generateKeyPair();
  const report = await setup({ "ssh-private-key": privateKey }).backend.doctor();
  const key = report.checks.find((check) => check.id === "ssh.key")!;
  assert.equal(key.status, "ok", JSON.stringify(key));
  assert.equal(key.detail, "From bb-box's settings; its public key is below.");
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
  assert.equal(byId["template.9106"]!.detail, "VM 9106 does not exist on pve, or is not in pool bbbox.");
  assert.match(byId["template.9106"]!.fix!, /setup\/proxmox-qemu\/build\.sh, or remove it from the Windows templates/);
  assert.match(byId["proxmox.bridge"]!.detail, /pve has no vmbr1/);
  assert.match(report.summary, /^Windows template 9105: /);
});

test("a Windows box is from its template as built now only while the template has the build it was cloned from (#227)", async () => {
  const { backend, proxmox } = setup();
  for (const vmid of [9104, 9105]) proxmox.guests.get(vmid)!.config.tags = "bbbox;windows;build.20260920-000000-aaaa";
  const before = identity();
  const old = await backend.acquire(before, null, hooks().value, signal());
  assert.equal(old.data?.build, "20260920-000000-aaaa");
  assert.equal(await backend.asOffered(old, KIND, before.createdAt), true);
  const during = { ...identity(), createdAt: Date.UTC(2026, 8, 25, 0, 30) };
  const cloned = await backend.acquire(during, null, hooks().value, signal());
  for (const vmid of [9104, 9105]) proxmox.guests.get(vmid)!.config.tags = "bbbox;windows;build.20260925-000000-bbbb";
  assert.equal(await backend.asOffered(old, KIND, before.createdAt), false, "made before the replace");
  assert.equal(await backend.asOffered(cloned, KIND, during.createdAt), false, "made during the build, before the swap");
  const { build: _, ...data } = old.data!;
  assert.equal(await backend.asOffered({ ...old, data }, KIND, Date.UTC(2026, 8, 26)), true, "with no recorded build, by the build's time");
});

test("the doctor warns when Proxmox QEMU's VMIDs or box addresses overlap Proxmox LXC's, and says nothing when they are apart (#194)", () => {
  const url = "https://pve.example.com:8006/";
  const lxc = (values: Record<string, unknown> = {}) => ({
    id: "proxmox-lxc",
    label: "Proxmox LXC",
    footprint: () =>
      proxmoxFootprint(lxcConfig({ "proxmox-lxc-url": url, "proxmox-lxc-vmid-first": 3000, "proxmox-lxc-vmid-last": 3189, "proxmox-lxc-addresses": "192.0.2.10-192.0.2.199", ...values })),
  });
  const qemu = (values: Record<string, unknown> = {}) => ({
    id: "proxmox-qemu",
    label: "Proxmox QEMU",
    footprint: () => proxmoxFootprint(qemuConfig({ url, "vmid-first": 3190, "vmid-last": 3239, addresses: "192.0.2.200-192.0.2.249", ...values })),
  });
  // As the live configuration has them: apart.
  assert.deepEqual(overlapChecks([lxc(), qemu()]), []);

  const [both] = overlapChecks([lxc(), qemu({ "vmid-first": 3180, addresses: "192.0.2.190-192.0.2.249" })]);
  assert.equal(both?.status, "warn");
  assert.equal(
    both?.detail,
    "They both use IDs 3180 to 3189, and both give boxes 10 addresses, from 192.0.2.190 to 192.0.2.199, so a box of one could take what a box of the other has.",
  );
  // The same addresses on another bridge are another network; VMIDs are the cluster's, whatever the bridge.
  const [ids] = overlapChecks([lxc(), qemu({ bridge: "vmbr2", "vmid-first": 3189, addresses: "192.0.2.199-192.0.2.249" })]);
  assert.match(ids?.detail ?? "", /^They both use ID 3189, so/);
  // Another cluster shares nothing.
  assert.deepEqual(overlapChecks([lxc(), qemu({ url: "https://other.example.com:8006/", "vmid-first": 3000, addresses: "192.0.2.10-192.0.2.249" })]), []);
  // Only the addresses its VMIDs use count: the rest of a longer range is never handed out.
  assert.deepEqual(overlapChecks([lxc({ "proxmox-lxc-addresses": "192.0.2.10-192.0.2.254" }), qemu()]), []);
});
