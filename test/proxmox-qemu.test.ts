import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { Backends, DRIVERS, boxForm, overlapChecks } from "../src/backends/index.ts";
import { parseImageRecord, recordInDescription } from "../src/backends/images.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { buildFromTags, installFromDescription, ownerFromDescription, ownerFromTags } from "../src/backends/proxmox/owner.ts";
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

/** The fake Proxmox, SSH and network, and no waiting. `warm` gives warm counts by kind, which a test may change. */
function setup(values: Record<string, unknown> = {}, storage = new MemoryStorage(), options: QemuBackendOptions = {}, warm: Record<string, number> = {}) {
  const ssh = fakeSsh();
  // Each box address answers as Windows does, in PowerShell.
  for (let last = 150; last <= 159; last++) ssh.windows(`192.0.2.${last}`);
  const proxmox = new FakeProxmox();
  proxmox.addVmTemplate(9104);
  proxmox.addVmTemplate(9105);
  const context = testContext(storage, "test", { id: "proxmox-qemu", warm });
  const config = qemuConfig(values);
  const fakes: QemuBackendOptions = { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 };
  const make = (on = context) => {
    const backend = new ProxmoxQemuBackend(config, on, { ...fakes, ...options });
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
  assert.equal(kind!.capabilities.enrol, true, "its boxes join BB unless the switch is set off (#539)");
  // The desktop as video (060), which a box's transports include only where its image has bb-box-stream.
  assert.deepEqual(kind!.capabilities.displays, [
    { id: "desktop", protocol: "rfb", resizable: true, clipboard: "commands" },
    { id: "video", protocol: "selkies", resizable: true, cursor: "stream" },
  ]);
  assert.deepEqual(kind!.capabilities.computerUse, { driver: "cua", version: "0.30.4", socket: "\\\\.\\pipe\\cua-driver" });
});

test("the settings list Windows and Linux templates by VMID", () => {
  assert.deepEqual(qemuConfig({ "windows-templates": "9104, 9105" }).templates, [9104, 9105]);
  assert.deepEqual(qemuConfig({ "windows-templates": 9104 }).templates, [9104], "a settings file may give one VMID as a number");
  const problems = (values: Record<string, unknown>) => {
    const parsed = parse(values);
    return parsed.ok ? [] : parsed.problems;
  };
  assert.deepEqual(problems({ "windows-templates": "" }), [{ path: "windows-templates", message: "Set the VMID of at least one Windows, Linux or Android template." }]);
  // Linux templates (057): none by default, alone or beside Windows', never the same VMID.
  assert.deepEqual(qemuConfig({}).linuxTemplates, []);
  assert.deepEqual(qemuConfig({ "windows-templates": "", "linux-templates": "9120" }).linuxTemplates, [9120]);
  // Linux desktop templates (057): none by default, alone or beside the others, never one of theirs.
  assert.deepEqual(qemuConfig({}).linuxDesktopTemplates, []);
  assert.deepEqual(qemuConfig({ "windows-templates": "", "linux-desktop-templates": "9121" }).linuxDesktopTemplates, [9121]);
  assert.deepEqual(problems({ "linux-templates": "9120", "linux-desktop-templates": "9120" }), [{ path: "linux-desktop-templates", message: "Template 9120 is listed more than once. List each template once." }]);
  // Android templates (063): none by default, alone or beside the others, never one of theirs.
  assert.deepEqual(qemuConfig({}).androidTemplates, []);
  assert.deepEqual(qemuConfig({ "windows-templates": "", "android-templates": "9108" }).androidTemplates, [9108]);
  assert.deepEqual(problems({ "linux-templates": "9120", "android-templates": "9120" }), [{ path: "android-templates", message: "Template 9120 is listed more than once. List each template once." }]);
  assert.deepEqual(problems({ "windows-templates": "", "android-templates": "" }), [{ path: "windows-templates", message: "Set the VMID of at least one Windows, Linux or Android template." }]);
  // KVM in Linux VM boxes (057): off unless set.
  assert.equal(qemuConfig({}).kvm, false);
  assert.equal(qemuConfig({ "linux-kvm": true }).kvm, true);
  assert.deepEqual(problems({ "linux-templates": "9104" }), [{ path: "linux-templates", message: "Template 9104 is listed more than once. List each template once." }]);
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
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "network", "ssh", "start", "tags", "warm"], "with no warm VM to claim");
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
    transports.displays.map(({ open: _, resize: __, pointer: ___, ...display }) => display),
    [{ id: "desktop", label: "Desktop", protocol: "rfb", resizable: true, clipboard: "commands", pointerWhile: "rfb", minSize: { width: 800, height: 600 } }],
  );
});

test("with Linux templates, linux boxes are VMs from them, with their own kernel, run in sh, with no Windows steps (057)", async () => {
  const { backend, proxmox, ssh } = setup({ "linux-templates": "9120" });
  proxmox.addVmTemplate(9120);
  // The box's address answers as Linux does.
  rmSync(join(ssh.dir, "windows", "192.0.2.150"));
  const linux = backend.kinds().find((kind) => kind.id === "linux");
  assert.ok(linux, "offered beside windows-desktop");
  assert.deepEqual(linux.capabilities.features, ["docker", "kernel"], "no KVM unless the settings say the host allows it");
  assert.equal(linux.capabilities.os, "linux");
  assert.equal(linux.capabilities.enrol, true, "it joins BB as other Linux boxes do");
  assert.equal((await backend.capacity("linux", sized(), [])).ok, true);
  const report = await backend.doctor();
  const check = report.checks.find((one) => one.id === "template.9120");
  assert.equal(check?.status, "ok", "the doctor checks the Linux template");
  assert.equal(check?.name, "Linux template 9120", "and names it as Linux");
  assert.equal(report.checks.find((one) => one.id === "template.9104")?.name, "Windows template 9104");
  const image = report.checks.find((one) => one.id === "template.9120.image");
  assert.deepEqual([image?.name, image?.status], ["Image of Linux template 9120", "warn"], "judged as a Linux image, which this one has no record of");
  assert.match(image!.fix!, /build\.sh linux 9120 --replace\.$/);

  const box = identity(sized(), "linux");
  const hook = hooks();
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest.data, { template: 9120, box: box.boxId });
  assert.equal(proxmox.calls.find((call) => call.path.endsWith("/clone"))!.path, "/nodes/pve/qemu/9120/clone", "a clone of the Linux template");
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "network", "ssh", "start", "tags"], "no warm pool, clock or display");
  assert.equal(parseTags(proxmox.guests.get(9700)!.config.tags).at(-1), "template.9120");

  const transports = await backend.transports(guest);
  assert.deepEqual(transports.displays, []);
  const result = await transports.command!.run("echo hi from $USER", { timeoutMs: 10_000 });
  assert.equal(result.stdout, "hi from box\n");
  assert.doesNotMatch(ssh.log().at(-1)!.command, /FromBase64String/, "commands go to sh");

  // A stop hibernates it, and a start resumes it with no clock to set.
  await backend.stop!(guest, signal());
  const timings: Record<string, number> = {};
  await backend.start!(guest, signal(), (step, ms) => void (timings[step] = ms));
  assert.ok(!("clock" in timings), JSON.stringify(timings));

  // KVM is offered where the settings say the host allows nested virtualization.
  const withKvm = setup({ "linux-templates": "9120", "linux-kvm": true }).backend.kinds().find((kind) => kind.id === "linux");
  assert.deepEqual(withKvm?.capabilities.features, ["docker", "kernel", "kvm"]);
});

test("a Windows box shows its desktop as video, through its pipe over SSH, only where its template's image record lists OpenH264, and can leave the pointer out only where it lists the hardware cursor too (060)", async () => {
  const displaysOf = async (tools: Record<string, string> | null) => {
    const { backend, proxmox } = setup();
    if (tools) {
      const record = { contract: 1, image: "standard", kind: "windows-desktop", arch: "x86_64", build: "build.20261017-030000-1a2b", built: "2026-10-17T03:00:00Z", os: "Windows 11 Pro", pins: "p".repeat(64), bbApp: null, tools };
      proxmox.guests.get(9104)!.config.description = `bb-box windows template, built 2026-10-17.\n${JSON.stringify(record)}`;
    }
    const guest = await backend.acquire(identity(), null, hooks().value, signal());
    assert.equal(guest.data?.template, 9104);
    return (await backend.transports(guest)).displays;
  };
  assert.deepEqual(
    (await displaysOf(null)).map((display) => display.protocol),
    ["rfb"],
    "an image without it: the viewer's video ends at once, and it falls back to VNC",
  );
  assert.deepEqual((await displaysOf({ pwsh: "7.6.6" })).map((display) => display.protocol), ["rfb"]);
  const [, video] = await displaysOf({ pwsh: "7.6.6", openh264: "2.6.0" });
  assert.deepEqual([video!.id, video!.label, video!.protocol, video!.resizable], ["video", "Desktop, as video", "selkies", true]);
  assert.equal(video!.cursor, undefined, "an image without the hardware cursor has the pointer in its image, so its video cannot leave it out");
  const [, withCursor] = await displaysOf({ pwsh: "7.6.6", openh264: "2.6.0", "hardware-cursor": "1" });
  assert.equal(withCursor!.cursor, "stream", "an image with it can");
  assert.deepEqual((await displaysOf({ pwsh: "7.6.6", "hardware-cursor": "1" })).map((display) => display.protocol), ["rfb"], "nor any video without bb-box-stream");
  const opened = await video!.open();
  assert.deepEqual(opened.auth, { type: "none" });
  assert.equal(opened.route.type, "command");
  const script = opened.route.type === "command" ? opened.route.argv.at(-1)! : "";
  assert.match(script, /NamedPipeClientStream\]::new\('\.', 'bb-box-stream'/, "pwsh joins the channel to the server's pipe");
  assert.match(script, /if \(-not \[IO\.File\]::Exists\('\\\\\.\\pipe\\bb-box-stream'\)\) \{ schtasks\.exe \/run \/tn bb-box-stream \| Out-Null \}; \$p\.Connect\(15000\)/, "asks the pipe's name whether the server runs, not a connect that waits 500 ms to fail (#916)");
  assert.match(script, /schtasks\.exe \/run \/tn bb-box-stream/, "starting it through its task when it is not running");
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
  assert.match(run, /DateTime\.UtcNow\.AddSeconds\(seconds\)/, "waits a moment for the driver to take the size");
  assert.ok(run.startsWith(compiled), "loads the same file, compiling it if it is missing");
  assert.match(run, /\n\$bbRefused = \$bbDisplay::Fit\(1500, 900, 2\)\n/, "for up to 2 s");

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
  const extend = readFileSync(join(ssh.home("192.0.2.150"), "extended"), "utf8");
  assert.match(extend, /Resize-Partition -DriveLetter C -Size \$max/);
  assert.match(extend, /reagentc\.exe \/disable.*Remove-Partition .*reagentc\.exe \/enable/s, "WinRE's partition after C: moves onto C: first");
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
  assert.match(big.message!, /^The local-lvm storage on pve has 600 GiB free, less than the 636 GiB a 700 GiB disk adds to the template's\. Ask for a smaller disk or release boxes\./);

  proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  const low = await backend.capacity(KIND, sized(), [{ kind: KIND, size: sized() }], signal());
  assert.equal(low.ok, false);
  assert.match(low.message!, /^pve has 2 GiB of memory free, less than a windows-desktop box with 8 GiB memory needs\. Release a box or ask for less memory\./);
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
      ["proxmox.sizes", "Box sizes", "ok"],
      ["proxmox.pool", "Resource pool", "ok"],
      ["template.9104", "Windows template 9104", "ok"],
      // Built before images had records (049).
      ["template.9104.image", "Image of Windows template 9104", "warn"],
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

test("doctor judges each Windows template's image by the record in its description, and that its boxes can join BB (049, #539)", async () => {
  const { proxmox, context, make } = setup({ "windows-templates": "9104 9105 9106" });
  proxmox.addVmTemplate(9106);
  const day = 24 * 60 * 60 * 1000;
  const pins = "w".repeat(64);
  const images = { pins: async (set: string) => (set === "windows" ? pins : null), bbApp: async () => "a".repeat(64) };
  const record = (days: number, changes: Record<string, unknown> = {}) =>
    JSON.stringify({ contract: 1, image: "standard", kind: "windows-desktop", arch: "x86_64", build: "build.20261003-021500-3f9c", built: new Date(Date.now() - days * day).toISOString(), os: "Windows 11 Pro", pins, bbApp: null, tools: { pwsh: "7.6.6" }, ...changes });
  // Its boxes join BB, so it carries Node.js and the agent CLIs (#539, #581).
  const tools = { pwsh: "7.6.6", node: "24.21.0", "claude-code": "2.1.283", codex: "0.157.1", pi: "0.87.1" };
  proxmox.guests.get(9104)!.config.description = `bb-box windows template, built 2026-10-03 from win11.iso: Windows 11 Pro.\n${record(2, { tools })}`;
  proxmox.guests.get(9106)!.config.description = `bb-box windows template, built 2026-10-03 from win11.iso: Windows 11 Pro.\n${record(2, { tools: { pwsh: "7.6.6", node: "20.11.0" } })}`;
  proxmox.guests.get(9105)!.config.description = `bb-box windows template, built 2026-08-01 from win11.iso: Windows 11 Pro.\n${record(61, { pins: "o".repeat(64) })}`;
  const report = await make({ ...context, images }).doctor();
  const image = (vmid: number) => report.checks.find((check) => check.id === `template.${vmid}.image`)!;
  // A Windows image carries no build of BB's app, so a record without it is whole.
  assert.deepEqual([image(9104).status, image(9104).fix], ["ok", null], image(9104).detail);
  assert.match(image(9104).detail, /^Standard image build\.20261003-021500-3f9c, built \d+ \w+ \(2 days ago\): Windows 11 Pro, pwsh 7\.6\.6, /);
  // An image without them: its boxes install Node.js as they join, and box_thread refuses them.
  assert.equal(image(9106).status, "warn");
  assert.match(image(9106).detail, /It has Node\.js 20\.11\.0, and BB's installer needs 22\.19\.0 or later, so each box installs it as it joins BB, about 11 s more\./);
  assert.match(image(9106).detail, /It has none of the agent CLIs BB runs threads with, Claude Code, Codex, Pi, so box_thread refuses its boxes \(#561\)\./);
  assert.equal(image(9105).status, "warn");
  assert.match(image(9105).detail, /It is 61 days old, more than 60, .* It was built with other pins than this bb-box's/);
  assert.equal(image(9105).fix, "Rebuild it with the setup guide's setup/proxmox-qemu/build.sh, as root on pve: build.sh windows 9105 --replace.");
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

test("a Windows box comes from its template's current build until a refresh replaces it, and cannot tell with no build recorded (049)", async () => {
  const { backend, proxmox } = setup();
  for (const vmid of [9104, 9105]) proxmox.guests.get(vmid)!.config.tags = "bbbox;windows;build.20260920-000000-aaaa";
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(await backend.fromCurrentBuild(guest, KIND), true);
  for (const vmid of [9104, 9105]) proxmox.guests.get(vmid)!.config.tags = "bbbox;windows;build.20260925-000000-bbbb";
  assert.equal(await backend.fromCurrentBuild(guest, KIND), false);
  const { build: _, ...data } = guest.data!;
  assert.equal(await backend.fromCurrentBuild({ ...guest, data }, KIND), null, "no build recorded");
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

/**
 * setup() with `count` warm VMs. Windows' desktop is up in every VM unless
 * $HOME/no-desktop exists, and the clock and display helper scripts are kept.
 */
function warmSetup(count: number, values: Record<string, unknown> = {}, options: QemuBackendOptions = {}) {
  const warm = { [KIND]: count };
  const env = setup(values, new MemoryStorage(), options, warm);
  for (let last = 150; last <= 159; last++) {
    mkdirSync(env.ssh.home(`192.0.2.${last}`), { recursive: true });
    env.ssh.powershell(
      `192.0.2.${last}`,
      `case "$1" in\n  *"Get-Process explorer"*) [ -f "$HOME/no-desktop" ] && exit 1; exit 0;;\n  *Set-Date*) printf "%s" "$1" > "$HOME/clock"; exit 0;;\n  *Resize-Partition*) exit 0;;\n  *Add-Type*) printf "%s" "$1" > "$HOME/compiled"; exit 0;;\n  *) exec sh -c "$1";;\nesac\n`,
    );
  }
  return { ...env, warm };
}

/** The VMIDs of the warm VMs, and of the VMs deleted. */
const warmVms = (proxmox: FakeProxmox) => [...proxmox.guests.values()].filter((guest) => parseTags(guest.config.tags).includes("warm")).map((guest) => guest.vmid);
const deleted = (proxmox: FakeProxmox) => proxmox.calls.filter((call) => call.method === "DELETE").map((call) => Number(call.path.split("/")[4]));
const clones = (proxmox: FakeProxmox) => proxmox.calls.filter((call) => call.path.endsWith("/clone")).length;

test("the warm pool keeps hibernated VMs at the kind's default size, each filled once Windows' desktop is up", async () => {
  const { backend, proxmox, ssh, context } = warmSetup(1);
  await backend.maintain(signal());
  const vm = proxmox.guests.get(9700)!;
  assert.deepEqual([vm.status, vm.config.lock], ["stopped", "suspended"], "hibernated");
  assert.deepEqual(parseTags(vm.config.tags), ["bb-box", "install.test", "warm", "template.9104", "bb-box-starting"]);
  assert.equal(vm.config.cpuunits, "10", "a low CPU weight until a box takes it and it is ready (#888)");
  assert.equal(vm.name, "bb-box-warm");
  assert.deepEqual([vm.config.cores, vm.config.memory, vm.config.onboot], ["4", "8192", "0"], "and not started at the node's boot");
  assert.equal(installFromDescription(vm.config.description), "test");
  assert.equal(ownerFromDescription(vm.config.description), null);
  assert.ok(existsSync(join(ssh.home("192.0.2.150"), "compiled")), "the display helper is compiled before the hibernate");
  assert.deepEqual(await backend.held(), [], "a warm VM is no box's");
  assert.deepEqual((await backend.capacity(KIND, sized(), [], signal())).warm, { ready: 1, target: 1 });

  await backend.maintain(signal());
  assert.equal(clones(proxmox), 1, "a full pool makes no more");
  assert.deepEqual(context.errors, []);
});

test("a claim resumes a warm VM as the box, gives it the box's tags and name, sets its clock, and the pool fills again", async () => {
  const { proxmox, ssh, make, context } = warmSetup(1);
  await make().maintain(signal());
  // Another backend, as after a restart, finds the warm VM.
  const backend = make();
  const box = identity();
  const hook = hooks();
  const before = Date.now();
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest, { ref: "9700", host: "pve", address: "192.0.2.150", size: { cores: 4, memoryMiB: 8192, diskGiB: 64 }, data: { template: 9104, box: box.boxId } });
  assert.deepEqual(hook.events, ["claim 9700", "starting"]);
  assert.deepEqual(hook.claimed[0]?.data, { template: 9104, box: box.boxId }, "the claim records the box");
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clock", "network", "relabel", "resume", "ssh", "warm"]);
  const vm = proxmox.guests.get(9700)!;
  assert.deepEqual([vm.status, vm.config.lock, vm.config.vmstate], ["running", undefined, undefined]);
  assert.equal(vm.name, box.name);
  assert.equal(vm.config.onboot, "1");
  const tags = parseTags(vm.config.tags);
  assert.equal(tags.includes("warm"), false);
  // Its low CPU weight held through the claim, and went back once it was ready (#888).
  const relabelled = proxmox.calls.find((call) => call.method === "PUT" && call.path === "/nodes/pve/qemu/9700/config" && String(call.params.tags ?? "").includes("box."));
  assert.ok(parseTags(String(relabelled?.params.tags)).includes("bb-box-starting"), "kept as the claim relabels it");
  assert.equal(vm.config.cpuunits, undefined);
  assert.equal(tags.includes("bb-box-starting"), false);
  assert.deepEqual(ownerFromTags(tags), { boxId: box.boxId, threadId: box.threadId, name: null, kind: KIND, createdAt: box.createdAt });
  assert.equal(tags.at(-1), "template.9104");
  assert.equal(ownerFromDescription(vm.config.description)?.boxId, box.boxId);
  const ms = Number(/FromUnixTimeMilliseconds\((\d+)\)/.exec(readFileSync(join(ssh.home("192.0.2.150"), "clock"), "utf8"))?.[1]);
  assert.ok(ms >= before && ms <= Date.now(), "the clock is set to BB's server's time");

  // The claim began a fill: this waits for its clone, then joins it.
  for (let tries = 0; !proxmox.guests.has(9701) && tries < 300; tries++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(proxmox.guests.has(9701), "the claim began a fill");
  await backend.maintain(signal());
  assert.deepEqual(warmVms(proxmox), [9701]);
  assert.equal(proxmox.guests.get(9701)!.config.lock, "suspended");
  assert.deepEqual((await backend.held()).map((one) => [one.ref, one.owner?.boxId]), [["9700", box.boxId]]);
  assert.deepEqual(context.errors, []);
});

test("a box the warm VMs do not fit is cloned, and a box with a smaller disk takes one", async () => {
  const { backend, proxmox } = warmSetup(1);
  await backend.maintain(signal());
  const cores = await backend.acquire(identity(sized({ cores: 8 })), null, hooks().value, signal());
  const disk = await backend.acquire(identity(sized({ diskGiB: 100 })), null, hooks().value, signal());
  assert.deepEqual([cores.ref, disk.ref], ["9701", "9702"]);
  assert.equal(proxmox.guests.get(9700)!.config.lock, "suspended", "the warm VM waits for a box it fits");
  const hook = hooks();
  const smaller = await backend.acquire(identity(sized({ diskGiB: 40 })), null, hook.value, signal());
  assert.deepEqual([smaller.ref, smaller.size?.diskGiB], ["9700", 64]);
  assert.equal(typeof hook.timings.resume, "number");
  await backend.maintain(signal());
});

test("two acquires never claim the same warm VM", async () => {
  const { backend, proxmox } = warmSetup(1);
  await backend.maintain(signal());
  // Neither resumes its VM until both have claimed one.
  let claims = 0;
  let bothClaimed!: () => void;
  const both = new Promise<void>((resolve) => (bothClaimed = resolve));
  const waiting = (): AcquireHooks => {
    const hook = hooks().value;
    return {
      ...hook,
      claim: async (guest) => {
        await hook.claim(guest);
        if (++claims === 2) bothClaimed();
      },
      starting: () => both,
    };
  };
  const [first, second] = await Promise.all([backend.acquire(identity(), null, waiting(), signal()), backend.acquire(identity(), null, waiting(), signal())]);
  assert.deepEqual([first.ref, second.ref].sort(), ["9700", "9701"]);
  await backend.maintain(signal());
  assert.deepEqual(warmVms(proxmox), [9702]);
  assert.equal(clones(proxmox), 3);
});

test("a warm VM that fails to resume is deleted", async () => {
  const { backend, proxmox } = warmSetup(1);
  await backend.maintain(signal());
  proxmox.nextTaskExit.set("qmstart", "start failed: QEMU exited with code 1");
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /QEMU exited with code 1/);
  assert.deepEqual(deleted(proxmox), [9700]);
  await backend.maintain(signal());
  assert.deepEqual(warmVms(proxmox), [9701], "and a fill takes its place");
});

test("the pool deletes warm VMs beyond the count, from a replaced build or a template no longer listed, at another size, or running", async () => {
  const { backend, proxmox, warm, context } = warmSetup(2, { "windows-templates": "9104 9105" });
  for (const vmid of [9104, 9105]) proxmox.guests.get(vmid)!.config.tags = "bbbox;windows;build.20260920-000000-aaaa";
  await backend.maintain(signal());
  assert.deepEqual(warmVms(proxmox), [9700, 9701]);
  assert.deepEqual(parseTags(proxmox.guests.get(9701)!.config.tags).slice(-3), ["template.9105", "build.20260920-000000-aaaa", "bb-box-starting"]);

  warm[KIND] = 1;
  await backend.maintain(signal());
  assert.deepEqual([deleted(proxmox), warmVms(proxmox)], [[9701], [9700]]);

  // build.sh --replace swaps the template: the warm VM is from the old build.
  proxmox.guests.get(9104)!.config.tags = "bbbox;windows;build.20260925-000000-bbbb";
  const acquired = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(acquired.ref, "9702", "a warm VM from the old build is not handed out");
  await backend.maintain(signal());
  assert.deepEqual(deleted(proxmox), [9701, 9700]);
  assert.deepEqual(warmVms(proxmox), [9703]);
  assert.deepEqual(parseTags(proxmox.guests.get(9703)!.config.tags).slice(-3), ["template.9104", "build.20260925-000000-bbbb", "bb-box-starting"], "filled from the new build");

  const changes = [
    (vm: { status: string; config: Record<string, string> }) => (vm.config.cores = "8"),
    (vm: { status: string; config: Record<string, string> }) => {
      vm.status = "running";
      delete vm.config.lock;
    },
  ];
  for (const change of changes) {
    const [vmid] = warmVms(proxmox);
    change(proxmox.guests.get(vmid!)!);
    await backend.maintain(signal());
    assert.equal(deleted(proxmox).at(-1), vmid);
    assert.equal(warmVms(proxmox).length, 1);
  }
  assert.deepEqual(context.errors, []);

  // A template no longer listed: its warm VMs are deleted, and the pool fills from the one that is.
  const [last] = warmVms(proxmox);
  const unlisted = warmSetup(1, { "windows-templates": "9105" });
  unlisted.proxmox.guests.set(last!, { ...proxmox.guests.get(last!)! });
  await unlisted.backend.maintain(signal());
  assert.deepEqual(deleted(unlisted.proxmox), [last]);
  const [fresh] = warmVms(unlisted.proxmox);
  assert.equal(parseTags(unlisted.proxmox.guests.get(fresh!)!.config.tags).at(-2), "template.9105");
  assert.deepEqual(unlisted.context.errors, []);
});

test("warm VMs of another install, and a warm VM a fill was cut short making, are left for their owners and the registry", async () => {
  const { backend, proxmox } = warmSetup(0);
  proxmox.guests.set(9705, { vmid: 9705, type: "qemu", name: "bb-box-warm", pool: "bbbox", status: "stopped", template: false, config: { tags: "bb-box;install.other;warm;template.9104", cores: "4", memory: "8192" } });
  proxmox.guests.set(9706, { vmid: 9706, type: "qemu", name: "bb-box-warm", pool: "bbbox", status: "running", template: false, config: { tags: "bb-box;install.test;filling;template.9104", description: "bb-box warm windows-desktop\ninstall test", cores: "4", memory: "8192" } });
  await backend.maintain(signal());
  assert.deepEqual(deleted(proxmox), []);
  // The registry releases a guest that names no box.
  assert.deepEqual((await backend.held()).map((one) => [one.ref, one.owner]), [["9706", null]]);
});

test("a fill whose desktop never comes up is deleted, with the reason", async () => {
  const { backend, proxmox, ssh } = warmSetup(1);
  writeFileSync(join(ssh.home("192.0.2.150"), "no-desktop"), "");
  await assert.rejects(
    backend.maintain(signal()),
    /^Error: Windows' desktop in warm VM 9700 was not up within 1 s: Explorer did not run in a desktop session, or Cua's daemon did not listen on \\\\\.\\pipe\\cua-driver\./,
  );
  assert.equal(proxmox.guests.has(9700), false);
  assert.deepEqual(warmVms(proxmox), []);
});

test("the pool fills only while there is room, and a box a ready warm VM serves needs no VMID", async () => {
  const { backend, proxmox, context } = warmSetup(3, { "vmid-last": 9701 });
  await backend.maintain(signal());
  assert.deepEqual(warmVms(proxmox), [9700, 9701]);
  const [short] = context.short.at(-1)!;
  assert.deepEqual([short!.kinds, short!.count, short!.have], [[KIND], 3, 2]);
  assert.match(short!.reason, /VMID/);
  assert.deepEqual(context.errors, [], "a short pool is no error");
  const ok = await backend.capacity(KIND, sized(), [], signal());
  assert.equal(ok.ok, true, ok.message ?? "");
  assert.deepEqual(ok.warm, { ready: 2, target: 3 });
  assert.equal((await backend.capacity(KIND, sized(), [{ kind: KIND, size: sized() }, { kind: KIND, size: sized() }], signal())).ok, false, "two pending acquires take both");
  assert.equal((await backend.capacity(KIND, sized({ cores: 8 }), [], signal())).ok, false, "a box they do not fit needs a VMID");

  const low = warmSetup(1);
  low.proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  await low.backend.maintain(signal());
  assert.equal(clones(low.proxmox), 0);
  assert.match(low.context.short.at(-1)![0]!.reason, /^pve has 10 GiB of memory free/);
  low.proxmox.memory = { total: 64 * GiB, available: 48 * GiB };
  await low.backend.maintain(signal());
  assert.equal(clones(low.proxmox), 1);
  assert.deepEqual(low.context.short.at(-1), [], "a full pool is short no more");
});

test("dispose stops a warm fill", async () => {
  const { backend, proxmox } = warmSetup(1);
  let disposed: Promise<void> | null = null;
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/status/start")) disposed ??= backend.dispose();
    return undefined;
  };
  await assert.rejects(backend.maintain(), /bb-box is stopping/);
  await disposed;
  assert.equal(proxmox.guests.has(9700), false, "the VM it was filling is deleted");
});

/** A Windows box's PowerShell, as an image box's: its desktop up, its clock set, and the record a refresh writes (054). */
function imageSetup(record: Record<string, unknown>) {
  const env = setup();
  for (let last = 150; last <= 159; last++) {
    mkdirSync(env.ssh.home(`192.0.2.${last}`), { recursive: true });
    env.ssh.powershell(
      `192.0.2.${last}`,
      `case "$1" in\n  *"Get-Process explorer"*) exit 0;;\n  *Set-Date*) exit 0;;\n  *"Get-Content C:\\\\bb-box\\\\image.json"*) echo '${JSON.stringify(record)}'; exit 0;;\n  *Clear-Content*) printf cleared > "$HOME/boot-log"; exit 0;;\n  *) exec sh -c "$1";;\nesac\n`,
    );
  }
  return env;
}

test("with Linux desktop templates, linux-desktop-cpu boxes are VMs whose desktop is the guest's VNC server and Selkies, ready once its display is up (057)", async () => {
  const { backend, proxmox, ssh } = setup({ "linux-desktop-templates": "9121" });
  proxmox.addVmTemplate(9121);
  rmSync(join(ssh.dir, "windows", "192.0.2.150"));
  const desktop = backend.kinds().find((kind) => kind.id === "linux-desktop-cpu");
  assert.ok(desktop, "offered beside windows-desktop");
  assert.ok(!backend.kinds().some((kind) => kind.id === "linux"), "no linux kind without Linux templates");
  assert.deepEqual(desktop.capabilities.features, ["docker", "kernel"]);
  assert.deepEqual(desktop.capabilities.displays.map((display) => display.protocol), ["rfb", "selkies"]);
  assert.equal(desktop.capabilities.computerUse?.driver, "cua");
  const report = await backend.doctor();
  assert.equal(report.checks.find((check) => check.id === "template.9121")?.name, "Linux desktop template 9121");
  assert.match(report.checks.find((check) => check.id === "template.9121.image")!.fix!, /build\.sh linux-desktop 9121 --replace\.$/);

  // The display service says its mode once the desktop is up.
  const run = join(ssh.home("192.0.2.150"), "run", "bb-box");
  mkdirSync(run, { recursive: true });
  writeFileSync(join(run, "display-mode"), "cpu\n");
  writeFileSync(join(run, "display-reason"), "DISPLAY_MODE=cpu\n");
  const box = identity(sized(), "linux-desktop-cpu");
  const hook = hooks();
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest.data, { template: 9121, box: box.boxId });
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "display", "network", "ssh", "start", "tags"]);
  // Its display mode and why, as box_status shows them for Proxmox LXC's desktops.
  assert.deepEqual(guest.facts?.map((fact) => fact.label), ["Display mode", "Display reason"]);
  assert.equal(guest.facts?.[0]?.value, "CPU");

  const transports = await backend.transports(guest);
  assert.deepEqual(transports.displays.map((display) => [display.id, display.protocol]), [["desktop", "rfb"], ["selkies", "selkies"]]);
  const opened = await transports.displays[0]!.open(signal());
  assert.deepEqual(opened.route, { type: "tcp", host: "192.0.2.150", port: 5900 }, "the guest's own VNC server, not the VM's console");
  assert.equal(transports.access?.dockerHost, "ssh://box@192.0.2.150");
});

test("image operations on a Linux template: its build box has no Windows steps, its capture reads the record finalize.sh wrote, and its rollback says Linux (057)", async () => {
  const record = { contract: 1, image: "standard", kind: "linux", arch: "x86_64", build: "build.20261012-030000-1a2b", built: "2026-10-12T03:00:00Z", os: "Ubuntu 24.04", pins: "p".repeat(64), tools: { node: "24.21.0" } };
  const { backend, proxmox, ssh } = setup({ "linux-templates": "9120" });
  proxmox.addVmTemplate(9120);
  const template = proxmox.guests.get(9120)!;
  template.name = template.config.name = "bb-box-linux";
  template.config.tags = "bbbox;linux;build.20261011-090550-3ca0";
  template.config.description = "bb-box linux vm template, built 2026-10-11 from Ubuntu 24.04's cloud image 20260926.";
  for (let last = 150; last <= 159; last++) {
    const host = `192.0.2.${last}`;
    rmSync(join(ssh.dir, "windows", host), { force: true });
    mkdirSync(ssh.home(host), { recursive: true });
    ssh.powershell(host, `case "$1" in\n  *"cat /usr/share/bb-box/image.json"*) echo '${JSON.stringify(record)}';;\n  *) exec sh -c "$1";;\nesac\n`);
  }
  const images = backend.images;
  const standard = (await images.list()).builds.find((build) => build.ref === "9120")!;
  assert.deepEqual([standard.image, standard.kind, standard.build, standard.current], ["standard", "linux", "build.20261011-090550-3ca0", true]);

  const before = ssh.log().length;
  const box = await images.box(standard, "refresh of 9120", signal());
  assert.equal(box.ref, "9700");
  assert.equal(proxmox.calls.find((call) => call.path.endsWith("/clone"))!.path, "/nodes/pve/qemu/9120/clone");
  assert.equal(proxmox.guests.get(9700)!.config.cores, "2", "at the linux kind's default size");
  assert.ok(!ssh.log().slice(before).some((entry) => /Set-Date|explorer/.test(entry.command)), "no clock or desktop to wait for");
  const echoed = await box.command.run("echo hi from $USER", { timeoutMs: 10_000 });
  assert.equal(echoed.stdout, "hi from box\n", "commands go to sh");

  const captured = await images.capture(box, standard, "standard", signal());
  assert.deepEqual([captured.kind, captured.build, captured.record?.build], ["linux", "build.20261012-030000-1a2b", "build.20261012-030000-1a2b"]);
  const vm = proxmox.guests.get(9700)!;
  assert.deepEqual([vm.template, vm.name], [true, "bb-box-linux"]);
  assert.ok(parseTags(vm.config.tags).includes("kind.linux"));

  const replaced = await images.replace(captured, standard, signal());
  assert.deepEqual([replaced.ref, replaced.build], ["9120", "build.20261012-030000-1a2b"]);
  assert.match(proxmox.guests.get(9120)!.config.description!, /^bb-box linux vm template, refreshed \d{4}-\d{2}-\d{2} from Ubuntu 24\.04's cloud image 20260926\.\n\{"contract":1,/);
  const rollback = [...proxmox.guests.values()].find((guest) => parseTags(guest.config.tags).includes("image.rollback"))!;
  assert.equal(rollback.name, "bb-box-linux-rollback");
  assert.match(rollback.config.description!, /^bb-box rollback of Linux template 9120, build\.20261011-090550-3ca0, kept until its next refresh\. To use it, list \d+ as the Linux template in bb-box's settings\.$/);
  // The doctor lists it, as it holds a box's VMID and address (054, 057).
  const notes = (await backend.doctor()).notes.join("\n");
  assert.match(
    notes,
    new RegExp(`^VMID ${rollback.vmid} is the rollback of Linux template 9120, build\\.20261011-090550-3ca0\\. It holds a box's VMID and address until the template's next refresh replaces it\\. To go back to it, list ${rollback.vmid} as the Linux template in bb-box's settings\\.$`, "m"),
  );
});

test("image operations: a box from the Windows template, its capture as a template with its record, a trial box, and the template replaced in place (054)", async () => {
  const record = { contract: 1, image: "standard", kind: KIND, arch: "x86_64", build: "build.20261007-030000-5e1f", built: "2026-10-07T03:00:00Z", os: "Windows 11 Pro", pins: "p".repeat(64), tools: { node: "24.21.0" } };
  const { backend, proxmox, ssh } = imageSetup(record);
  const template = proxmox.guests.get(9104)!;
  template.name = template.config.name = "bb-box-windows";
  template.config.tags = "bbbox;windows;build.20260901-020000-77aa";
  template.config.description = "bb-box windows template, built 2026-09-01 from win11.iso: Windows 11 Pro, PowerShell 7.6.6.";
  const images = backend.images;
  assert.equal(images.windows, true);

  const listed = await images.list();
  const standard = listed.builds.find((build) => build.ref === "9104")!;
  assert.deepEqual([standard.image, standard.kind, standard.build, standard.record, standard.current], ["standard", KIND, "build.20260901-020000-77aa", null, true]);
  assert.deepEqual(listed.builds.map((build) => build.ref), ["9104"], "the configured template alone");
  assert.deepEqual(listed.boxes, []);

  // The build box: a clone at a box's VMID and address, with its desktop up, which no sweep takes.
  const box = await images.box(standard, "refresh of 9104", signal());
  assert.equal(box.ref, "9700");
  const vm = proxmox.guests.get(9700)!;
  assert.deepEqual([vm.status, vm.name, parseTags(vm.config.tags)], ["running", "bb-box-image", ["bb-box", "install.test", "image-box", "template.9104"]]);
  assert.match(vm.config.smbios1!, /serial=/, "the box's address, as a box has it");
  assert.equal(installFromDescription(vm.config.description), "test");
  assert.deepEqual(await backend.held(), [], "not a box's guest");
  assert.deepEqual((await images.list()).boxes, ["9700"]);

  // The capture: stopped, a template configured as the one it came from, with no address, the record and the build's tags.
  const captured = await images.capture(box, standard, "standard", signal());
  assert.deepEqual([captured.ref, captured.build, captured.current, captured.record?.build], ["9700", "build.20261007-030000-5e1f", false, "build.20261007-030000-5e1f"]);
  assert.deepEqual([vm.template, vm.status, vm.name, vm.config.protection, vm.config.onboot], [true, "stopped", "bb-box-windows", "1", "0"]);
  assert.match(vm.config.smbios1!, /^uuid=[0-9a-f-]{36}$/, "no address in the template");
  // A new EFI variable store with the old one's options, as deleted records pile up in OVMF's at each build's boots (060).
  assert.match(vm.config.efidisk0!, /^local-lvm:vm-9700-disk-\d+,efitype=4m,ms-cert=2023k,pre-enrolled-keys=1,size=4M$/);
  assert.deepEqual(Object.keys(vm.config).filter((key) => key.startsWith("unused")), [], "the old store goes");
  assert.deepEqual(parseTags(vm.config.tags), ["bb-box", "install.test", "image.standard", "kind.windows-desktop", "template.9104", "build.20261007-030000-5e1f"]);
  assert.deepEqual(recordInDescription(vm.config.description!), parseImageRecord(record));
  assert.equal(readFileSync(join(ssh.home("192.0.2.150"), "boot-log"), "utf8"), "cleared", "clones start with an empty boot log");
  assert.deepEqual(await backend.held(), []);
  assert.deepEqual((await images.list()).builds.map((build) => [build.ref, build.image, build.current]), [["9104", "standard", true], ["9700", "standard", false]]);

  // A trial box from the build, then removed; a configured template stays.
  const trial = await images.box(captured, "trial of build.20261007-030000-5e1f", signal());
  assert.equal(trial.ref, "9701");
  assert.equal(proxmox.calls.find((call) => call.path.endsWith("/clone") && call.params.newid === "9701")?.path, "/nodes/pve/qemu/9700/clone");
  await images.remove(trial.ref, signal());
  assert.equal(proxmox.guests.has(9701), false);
  await assert.rejects(images.remove("9104", signal()), /VM 9104 is not an image box or build of this install's/);

  // The replace: 9104 is kept as a rollback, then goes, the build is cloned into its VMID and made a template, and the build goes.
  const before = proxmox.calls.length;
  const replaced = await images.replace(captured, standard, signal());
  assert.deepEqual([replaced.ref, replaced.current, replaced.build], ["9104", true, "build.20261007-030000-5e1f"]);
  assert.equal(proxmox.guests.has(9700), false);
  const now = proxmox.guests.get(9104)!;
  assert.deepEqual([now.template, now.name, now.config.protection], [true, "bb-box-windows", "1"]);
  assert.deepEqual(parseTags(now.config.tags), ["bbbox", "windows", "build.20261007-030000-5e1f"]);
  assert.match(now.config.description!, /^bb-box windows template, refreshed \d{4}-\d{2}-\d{2} from win11\.iso: Windows 11 Pro, PowerShell 7\.6\.6\.\n\{"contract":1,/);
  assert.deepEqual(
    proxmox.calls
      .slice(before)
      .filter((call) => /\/qemu\/(9104|9700)(\/(clone|template))?$/.test(call.path) && call.method !== "GET")
      .map((call) => `${call.method} ${call.path.replace(/^\/nodes\/pve/, "")}`),
    ["POST /qemu/9104/clone", "DELETE /qemu/9104", "POST /qemu/9700/clone", "POST /qemu/9104/template", "DELETE /qemu/9700"],
  );
  // The rollback: the old template as it was, at a free VMID of the range, until the next replace.
  const rollback = [...proxmox.guests.values()].find((guest) => parseTags(guest.config.tags).includes("image.rollback"))!;
  assert.equal(rollback.vmid, 9702);
  assert.deepEqual([rollback.template, rollback.name, rollback.config.protection], [true, "bb-box-windows-rollback", "1"]);
  assert.deepEqual(parseTags(rollback.config.tags), ["bb-box", "install.test", "image.rollback", "kind.windows-desktop", "template.9104", "build.20260901-020000-77aa"]);
  assert.match(rollback.config.description!, /^bb-box rollback of Windows template 9104, build\.20260901-020000-77aa, kept until its next refresh\. To use it, list 9702 as the Windows template in bb-box's settings\.$/);
  assert.deepEqual(
    (await images.list()).builds.map((one) => [one.ref, one.image, one.current]),
    [["9104", "standard", true], ["9702", "rollback", false]],
    "listed, but not as a standard build that a run would remove",
  );
  assert.deepEqual(await backend.held(), [], "no box's");
  const after = (await images.list()).builds.find((build) => build.ref === "9104")!;
  assert.deepEqual([after.build, after.record?.build], ["build.20261007-030000-5e1f", "build.20261007-030000-5e1f"]);
  // A box from the replaced template, as any.
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.data?.template, 9104);

  // The next replace keeps the template it replaces, and only then removes the rollback before.
  const next = await images.capture(await images.box(after, "refresh of 9104", signal()), after, "standard", signal());
  await images.replace(next, after, signal());
  const rollbacks = [...proxmox.guests.values()].filter((one) => parseTags(one.config.tags).includes("image.rollback"));
  assert.deepEqual(rollbacks.map((one) => [one.vmid, buildFromTags(parseTags(one.config.tags))]), [[rollbacks[0]!.vmid, "20261007-030000-5e1f"]]);
  assert.notEqual(rollbacks[0]!.vmid, 9702);
});

test("a replace with no free VMID for the rollback changes nothing (054)", async () => {
  const { backend, proxmox } = imageSetup({ contract: 1, image: "standard", kind: KIND, build: "build.x", built: "2026-10-07T03:00:00Z", os: "Windows 11 Pro", pins: "p".repeat(64), tools: { node: "24.21.0" } });
  const standard = (await backend.images.list()).builds[0]!;
  const captured = await backend.images.capture(await backend.images.box(standard, "refresh of 9104", signal()), standard, "standard", signal());
  for (let vmid = 9701; vmid <= 9709; vmid++) proxmox.addVmTemplate(vmid);
  await assert.rejects(backend.images.replace(captured, standard, signal()), /No VMID from 9700 to 9709 is free for the rollback of template 9104/);
  assert.equal(proxmox.guests.get(9104)!.template, true, "the template stays");
  assert.ok(proxmox.guests.has(9700), "and the build, for the refresh to remove");
});

test("a capture without the refresh's record is refused, and a failed image box is deleted (054)", async () => {
  const { backend, proxmox } = imageSetup({});
  const standard = (await backend.images.list()).builds[0]!;
  const box = await backend.images.box(standard, "refresh of 9104", signal());
  await assert.rejects(backend.images.capture(box, standard, "standard", signal()), /Image box 9700 has no image record in C:\\bb-box\\image\.json/);
  await backend.images.remove(box.ref, signal());
  assert.equal(proxmox.guests.has(9700), false);

  proxmox.nextTaskExit.set("qmstart", "start failed: QEMU exited with code 1");
  await assert.rejects(backend.images.box(standard, "refresh of 9104", signal()), /QEMU exited with code 1/);
  assert.deepEqual([...proxmox.guests.keys()].filter((vmid) => vmid >= 9700), [], "the clone that did not start is gone");
});

test("a Windows VM's disk grows live with C: extended over it, and its cores and memory change only with a restart: a clean shutdown and a boot (061)", async () => {
  const { backend, proxmox, ssh } = setup();
  // Extends C: and sets the clock as Windows would, and runs every other script with sh.
  ssh.powershell("192.0.2.150", `case "$1" in\n  *Resize-Partition*) echo "$1" >> "$HOME/extended"; exit 0;;\n  *Set-Date*) exit 0;;\n  *) exec sh -c "$1";;\nesac\n`);
  assert.deepEqual(backend.resizing(KIND), { cores: "restart", memory: "restart", disk: "live", shrinks: true });
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const vm = proxmox.guests.get(9700)!;
  const from = guest.size!;
  const to = { cores: from.cores + 2, memoryMiB: from.memoryMiB * 2, diskGiB: from.diskGiB! + 8 };

  const plan = await backend.planResize(guest, KIND, to, [], signal());
  assert.deepEqual(plan.parts.map((part) => [part.part, part.way]), [["cores", "restart"], ["memory", "restart"], ["disk", "live"]]);
  assert.equal(plan.downSeconds, 40, "a clean shutdown and a boot: 30 s measured");
  assert.equal(plan.room.ok, true);

  // The disk alone: live, with C: extended, and no shutdown.
  const disk = await backend.resize(guest, KIND, { ...from, diskGiB: from.diskGiB! + 8 }, { restart: false }, signal());
  assert.equal(disk.size?.diskGiB, from.diskGiB! + 8);
  assert.equal(vm.status, "running");
  assert.match(readFileSync(join(ssh.home("192.0.2.150"), "extended"), "utf8"), /Resize-Partition -DriveLetter C/);
  const shutdowns = () => proxmox.calls.filter((call) => call.path.endsWith("/status/shutdown")).length;
  assert.equal(shutdowns(), 0);

  await assert.rejects(backend.resize(guest, KIND, to, { restart: false }, signal()), (error) => error instanceof BackendError && /only with a restart/.test(error.message));
  const resized = await backend.resize(guest, KIND, to, { restart: true }, signal());
  assert.deepEqual(resized.size, to);
  assert.equal(shutdowns(), 1, "a clean shutdown, not a hibernate");
  assert.deepEqual([vm.status, String(vm.config.cores), String(vm.config.memory)], ["running", String(to.cores), String(to.memoryMiB)]);
  await assert.rejects(backend.planResize(guest, KIND, { ...to, diskGiB: 10 }, [], signal()), /disk only grows/);

  // A hibernated VM is resized once it runs.
  await backend.stop(guest, signal());
  await assert.rejects(backend.planResize(guest, KIND, from, [], signal()), (error) => error instanceof BackendError && /start it first/.test(error.message));
});

test("a VM that does not boot at its new size gets its old cores and memory back and boots again (061)", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.powershell("192.0.2.150", extending("exit 0"));
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  const vm = proxmox.guests.get(9700)!;
  const from = guest.size!;
  proxmox.nextTaskExit.set("qmstart", "start failed: not enough memory");
  await assert.rejects(backend.resize(guest, KIND, { ...from, memoryMiB: from.memoryMiB * 4 }, { restart: true }, signal()), /not enough memory/);
  assert.deepEqual([vm.status, String(vm.config.memory)], ["running", String(from.memoryMiB)]);
});

test("a Linux VM's root file system grows live over its disk (061)", async () => {
  const { backend, proxmox, ssh } = setup({ "linux-templates": "9120" });
  proxmox.addVmTemplate(9120);
  rmSync(join(ssh.dir, "windows", "192.0.2.150"));
  const home = ssh.home("192.0.2.150");
  // The disk tools, as the box would have them; sudo runs the command and logs it.
  mkdirSync(join(home, "bin"), { recursive: true });
  const tools: Record<string, string> = {
    findmnt: "echo /dev/sda1",
    lsblk: "echo sda",
    sudo: `echo "$*" >> "$HOME/sudo.log"`,
  };
  for (const [name, script] of Object.entries(tools)) {
    writeFileSync(join(home, "bin", name), `#!/bin/sh\n${script}\n`);
    chmodSync(join(home, "bin", name), 0o755);
  }
  mkdirSync(join(home, "sys"), { recursive: true });
  const guest = await backend.acquire(identity(sized(), "linux"), null, hooks().value, signal());
  assert.deepEqual(backend.resizing("linux"), { cores: "restart", memory: "restart", disk: "live", shrinks: true });
  assert.equal((await backend.planResize(guest, "linux", { ...guest.size!, cores: guest.size!.cores + 2 }, [], signal())).downSeconds, 20);
  const grown = await backend.resize(guest, "linux", { ...guest.size!, diskGiB: guest.size!.diskGiB! + 8 }, { restart: false }, signal()).catch((error: Error) => error);
  // The partition number comes from sysfs, which the test machine's own /sys gives or not: what matters is the order.
  const log = existsSync(join(home, "sudo.log")) ? readFileSync(join(home, "sudo.log"), "utf8") : "";
  if (grown instanceof Error) assert.fail(grown.message);
  assert.match(log, /^growpart \/dev\/sda \S*\nresize2fs \/dev\/sda1\n$/);
});

test("an Android template is no kind's yet, but its image is listed, boxed at the android kind's size, captured, and checked by the doctor (063)", async () => {
  const runtime = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: { emulator: "37.2.12.0", cpu: "Example CPU", made: "2026-10-26T05:15:46Z" } };
  const devices = [
    { model: "Pixel 8", native: "pixel_8", runtime },
    { model: "Pixel Fold", native: "pixel_fold", runtime },
    { model: "Pixel Tablet", native: "pixel_tablet", runtime },
  ];
  const record = { contract: 1, image: "standard", kind: "android", arch: "x86_64", build: "build.20261026-051500-1a2b", built: new Date().toISOString(), os: "Ubuntu 24.04", pins: "p".repeat(64), tools: { node: "24.21.0", "android-emulator": "37.2.12.0" }, devices };
  const { backend, proxmox, ssh } = setup({ "android-templates": "9108" });
  proxmox.addVmTemplate(9108);
  const template = proxmox.guests.get(9108)!;
  template.name = template.config.name = "bb-box-android";
  template.config.tags = "bbbox;android;build.20261020-030000-77aa";
  template.config.description = `bb-box android vm template, built 2026-10-20 from Ubuntu 24.04's cloud image 20260911.\n${JSON.stringify(record)}`;
  for (let last = 150; last <= 159; last++) {
    const host = `192.0.2.${last}`;
    rmSync(join(ssh.dir, "windows", host), { force: true });
    mkdirSync(ssh.home(host), { recursive: true });
    ssh.powershell(host, `case "$1" in\n  *"cat /usr/share/bb-box/image.json"*) echo '${JSON.stringify(record)}';;\n  *) exec sh -c "$1";;\nesac\n`);
  }
  assert.ok(!backend.kinds().some((kind) => kind.id === "android"), "not offered until the Android driver");

  const report = await backend.doctor();
  const check = (id: string) => report.checks.find((one) => one.id === id);
  assert.equal(check("template.9108")?.name, "Android template 9108");
  assert.equal(check("template.9108.image")?.status, "ok", JSON.stringify(check("template.9108.image")));
  assert.equal(check("proxmox.android-kvm")?.status, "fail");
  assert.match(check("proxmox.android-kvm")!.fix!, /Turn on linux-kvm/);
  assert.equal(check("proxmox.android-disk")?.status, "ok");
  assert.match(check("proxmox.android-disk")!.detail, /^local-lvm, where Android template 9108 is, has 600 GiB free, 550 GiB beyond the 50 GiB kept free\./);
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 80 * GiB });
  const short = (await backend.doctor()).checks.find((one) => one.id === "proxmox.android-disk")!;
  assert.equal(short.status, "warn");
  assert.match(short.detail, /30 GiB beyond the 50 GiB kept free.*need about 40 GiB, so a refresh may wait for room or fail\./);
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 600 * GiB });

  const images = backend.images;
  const standard = (await images.list()).builds.find((build) => build.ref === "9108")!;
  assert.deepEqual([standard.image, standard.kind, standard.current, standard.record?.devices?.length], ["standard", "android", true, 3]);
  const box = await images.box(standard, "refresh of 9108", signal());
  assert.deepEqual([proxmox.guests.get(Number(box.ref))!.config.cores, proxmox.guests.get(Number(box.ref))!.config.memory], ["8", "16384"], "at the android kind's default size");
  const captured = await images.capture(box, standard, "standard", signal());
  assert.deepEqual([captured.kind, captured.record?.devices?.map((device) => device.native)], ["android", ["pixel_8", "pixel_fold", "pixel_tablet"]]);
  assert.ok(parseTags(proxmox.guests.get(Number(captured.ref))!.config.tags).includes("kind.android"));
  const replaced = await images.replace(captured, standard, signal());
  assert.equal(replaced.ref, "9108");
  const rollback = [...proxmox.guests.values()].find((guest) => parseTags(guest.config.tags).includes("image.rollback"))!;
  assert.equal(rollback.name, "bb-box-android-rollback");
  assert.match(rollback.config.description!, /^bb-box rollback of Android template 9108, build\.20261020-030000-77aa, kept until its next refresh\./);
  const withKvm = setup({ "android-templates": "9108", "linux-kvm": true });
  withKvm.proxmox.addVmTemplate(9108);
  assert.equal((await withKvm.backend.doctor()).checks.find((one) => one.id === "proxmox.android-kvm")?.status, "ok");

  const noDevices = setup({ "android-templates": "9108" });
  noDevices.proxmox.addVmTemplate(9108);
  noDevices.proxmox.guests.get(9108)!.config.description = `bb-box android vm template.\n${JSON.stringify({ ...record, devices: undefined })}`;
  const judged = (await noDevices.backend.doctor()).checks.find((one) => one.id === "template.9108.image")!;
  assert.equal(judged.status, "fail");
  assert.match(judged.detail, /It offers no Android devices in its record/);
  assert.match(judged.fix!, /build\.sh android 9108 --replace\.$/);

});
