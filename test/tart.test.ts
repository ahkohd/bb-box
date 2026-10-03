import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { TartBackend, hostnameOf, nameScript, powerOffScript, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { parseHosts, parseTartSettings } from "../src/backends/tart/config.ts";
import { crashSummary, endReason, parseEnded, parseState, parseVnc, type RunEnd } from "../src/backends/tart/host.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const GiB = 2 ** 30;
const MAC = FAKE_MAC;

const made: TartBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

// Port 1 is closed on the test machine, so a macOS VM's Screen Sharing does not answer unless a test listens for it.
const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, screenSharingPort: 1 };

function setup(values: Record<string, unknown> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  fakeMacTools(mac);
  addImage(mac);
  const config = tartConfig(values);
  const storage = new MemoryStorage();
  const context = testContext(storage);
  const make = (on = context) => {
    const backend = new TartBackend(config, on, FAKES);
    made.push(backend);
    return backend;
  };
  const owners = join(mac, ".bb-box", "tart", "owners");
  return { ssh, mac, owners, context, make, backend: make() };
}

/** The macOS kinds' small preset (028). */
const SMALL: BoxSize = { cores: 4, memoryMiB: 8192, diskGiB: null };

let counter = 0;
function identity(kind = "macos-desktop", threadId = "thr_abc123", size = SMALL): BoxIdentity {
  counter++;
  return { boxId: `bx${counter}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000, size };
}

function hooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
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

test("parses Macs, one per line, and refuses what it cannot use", () => {
  assert.deepEqual(parseHosts("mac1 admin@192.0.2.20\n# a comment\nmac2 bbbox-admin@mac2.example:2222").hosts, [
    { name: "mac1", user: "admin", address: "192.0.2.20", port: 22 },
    { name: "mac2", user: "bbbox-admin", address: "mac2.example", port: 2222 },
  ]);
  assert.match(parseHosts("mac1 192.0.2.20").problems[0]!, /user@address/);
  assert.match(parseHosts("mac1 a@b\nmac1 a@c").problems[0]!, /twice/);
  const parsed = parseTartSettings({ "tart-enabled": true, "tart-hosts": "mac1 a@b", "tart-host-keys": "", "tart-vms-per-host": 3 });
  assert.ok(parsed.enabled && !parsed.ok);
  assert.ok(parsed.problems.some((problem) => /host key/.test(problem)));
  assert.ok(parsed.problems.some((problem) => /VMs per Mac/.test(problem)));
  assert.deepEqual(parseTartSettings({}), { enabled: false });
});

test("offers macos and macos-desktop from the image, each only when it has one", () => {
  assert.deepEqual(
    new TartBackend(tartConfig(), testContext()).kinds().map((kind) => kind.id),
    ["macos", "macos-desktop"],
  );
  const desktopOnly = new TartBackend(tartConfig({ "tart-macos-image": "" }), testContext()).kinds();
  assert.deepEqual(desktopOnly.map((kind) => kind.id), ["macos-desktop"]);
  const desktop = desktopOnly[0]!.capabilities;
  assert.equal(desktop.os, "macos");
  assert.equal(desktop.arch, "arm64");
  assert.equal(desktop.gpu, false);
  assert.equal(desktop.command?.inDesktopSession, false);
  assert.deepEqual(desktop.displays, [{ id: "desktop", protocol: "rfb", resizable: false }]);
  assert.equal(desktop.computerUse?.socket, "/Users/admin/Library/Caches/cua-driver/cua-driver.sock");
});

test("reads Tart's pretty-printed listing and its VNC URL", () => {
  const state = parseState(
    [
      "@version",
      "2.30.0",
      "@list",
      '[\n  {\n    "Accessed" : "1 minute ago",\n    "Name" : "bb-box-bx1",\n    "Running" : true,\n    "Source" : "local",\n    "State" : "running"\n  }\n]',
      "@configs",
      "=bb-box-bx1",
      '{  "os" : "darwin",  "cpuCount" : 4,  "memorySize" : 8589934592}',
      "@owners",
      "=bb-box-bx1",
      "install=k3v9q2m7xa",
      "box=bx1",
      "@memory",
      String(128 * GiB),
      "@disk",
      "1900000000 150000000",
      "@arch",
      "arm64",
      "@macos",
      "27.0",
    ].join("\n"),
  );
  assert.deepEqual(state.vms, [{ name: "bb-box-bx1", state: "running", running: true }]);
  assert.deepEqual(state.configs.get("bb-box-bx1"), { os: "darwin", macAddress: null, memoryMiB: 8192, cpus: 4 });
  assert.deepEqual(state.owners.get("bb-box-bx1"), { install: "k3v9q2m7xa", box: "bx1" });
  assert.equal(state.memoryMiB, 131072);
  assert.equal(state.disk.freeMiB, Math.floor(150000000 / 1024));
  assert.deepEqual(parseVnc("vnc://:open-sesame-word-four@127.0.0.1:61234\n"), { port: 61234, password: "open-sesame-word-four" });
  assert.equal(parseVnc(""), null);
});

test("a macOS desktop shows the VM's own Screen Sharing, signed in as the VM user, with input of its own; without it, Tart's VNC serves one connection per run (#406)", async (t) => {
  const listener = createServer((socket) => socket.end());
  await new Promise<void>((resolve) => listener.listen(0, "127.0.0.1", resolve));
  t.after(() => void listener.close());
  const port = (listener.address() as AddressInfo).port;
  const values = { "tart-vm-password": "s3cret" };
  const { context, backend } = setup(values);
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());

  const sharing = new TartBackend(tartConfig(values), context, { ...FAKES, screenSharingPort: port });
  made.push(sharing);
  const [display] = (await sharing.transports(guest, "macos-desktop")).displays;
  const opened = await display!.open(signal());
  assert.deepEqual(opened.auth, { type: "apple", user: "admin", password: "s3cret" });
  const argv = opened.route.type === "command" ? opened.route.argv : [];
  assert.deepEqual(argv.slice(-3), ["-W", `127.0.0.1:${port}`, `admin@${guest.address}`], "to the VM's own Screen Sharing, through the Mac");
  assert.equal(typeof opened.input, "function", "Screen Sharing ignores a viewer's input, so the display has its own");
  assert.deepEqual((await display!.open(signal())).auth.type, "apple", "as often as viewers connect");

  // With Screen Sharing off, Tart's VNC server, which ends the VM on a second connection in its run.
  const [fallback] = (await backend.transports(guest, "macos-desktop")).displays;
  const first = await fallback!.open(signal());
  assert.equal(first.auth.type, "vnc-password");
  assert.equal(first.input, undefined, "Tart's VNC server takes the viewer's input itself");
  await assert.rejects(fallback!.open(signal()), /takes one connection per run: a second would end the VM\. Turn Screen Sharing on in the VM, or stop and start the box/);
  assert.equal(tartConfig({}).ssh.vmPassword, "admin", "the password of Tart's images, unless one is set");
});

test("acquire claims the VM before it writes anything, then clones, starts and reaches it through the Mac", async () => {
  const { ssh, owners, backend } = setup();
  const box = identity();
  const recorded = hooks();
  const guest = await backend.acquire(box, null, recorded.hooks, signal());
  assert.deepEqual(recorded.events, ["claim", "starting", "claim"]);
  assert.deepEqual(recorded.claimed.at(-1), guest, "claimed again with its address");
  assert.equal(recorded.claimed[0]!.ref, `bb-box-${box.boxId}`);
  assert.deepEqual(recorded.claimed[0]!.data, { box: box.boxId });
  assert.deepEqual(Object.keys(recorded.timings), ["place", "clone", "start", "network", "ssh", "identify", "name"]);
  assert.equal(guest.host, "mac1");
  assert.match(guest.address ?? "", /^192\.168\.64\.\d+$/);
  const owner = readFileSync(join(owners, guest.ref), "utf8");
  assert.equal(owner, `install=test\nkind=macos-desktop\nbox=${box.boxId}\nthread=thr_abc123\nname=${box.name}\ncreated=1790000000000\n`);
  assert.equal(await backend.power(guest), "running");

  const { command, displays, access } = await backend.transports(guest, box.kind);
  assert.equal((await command!.run("echo hello")).stdout, "hello\n");
  assert.deepEqual(access?.ssh?.jump, { host: MAC, port: 22, user: "bbbox-admin", hostKeys: [`${MAC} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests`] });
  assert.equal(access?.ssh?.user, "admin");
  assert.equal(displays[0]!.minSize, undefined, "a viewer cannot resize a macOS desktop");
  const opened = await displays[0]!.open();
  assert.equal(opened.route.type, "command");
  assert.ok(opened.route.type === "command" && opened.route.argv.includes("-W") && opened.route.argv.at(-1) === `bbbox-admin@${MAC}`);
  assert.match(opened.auth.type === "vnc-password" ? opened.auth.password : "", /^fake-pass-word-\d+$/);

  // The VM's commands went to the VM, the rest to the Mac, and the VM is named after the box.
  const targets = new Set(ssh.log().map((entry) => entry.target));
  assert.ok(targets.has(`bbbox-admin@${MAC}`) && targets.has(`admin@${guest.address}`));
  assert.ok(
    ssh.log().some((entry) => entry.target === `admin@${guest.address}` && entry.command.includes("scutil --set") && entry.command.includes(box.name)),
    "the VM is named after the box",
  );
  await backend.release(guest, releasing);
});

test("stop suspends the VM and start resumes it; the VM counts against its Mac only while it runs", async () => {
  const { mac, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const used = async () => (await backend.capacity("macos", SMALL, [])).hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used;
  assert.equal(await used(), 1);
  await backend.stop(guest);
  assert.equal(await backend.power(guest), "stopped");
  assert.ok(existsSync(join(mac, ".tart", "vms", guest.ref, "state.vzvmsave")), "suspended, not shut down");
  assert.equal(await used(), 0);
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  assert.equal(await used(), 1);
  await backend.release(guest, releasing);
});

/** The Linux kinds' small preset (028, 040). */
const LINUX_SMALL: BoxSize = { cores: 2, memoryMiB: 4096, diskGiB: null };

/** A fake Mac with the Linux image too, and linux-arm64 boxes on (040). */
function linuxSetup(values: Record<string, unknown> = {}) {
  const made = setup({ "tart-linux-image": "bb-box-linux", ...values });
  addImage(made.mac, "bb-box-linux", "linux");
  return made;
}

/** What the fake tart on the Mac was asked to do, in order, from its log. */
function tartCalls(mac: string): string[][] {
  const file = join(mac, ".fake-tart-log");
  return existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [];
}

test("offers linux-arm64 only with a Linux image, as arm64, with Docker (040, 041)", () => {
  const kinds = new TartBackend(tartConfig({ "tart-linux-image": "bb-box-linux" }), testContext()).kinds();
  assert.deepEqual(kinds.map((kind) => kind.id), ["macos", "macos-desktop", "linux-arm64"], "linux-arm64-docker is an alias of linux-arm64, not an offer");
  const linux = kinds.find((kind) => kind.id === "linux-arm64")!;
  assert.deepEqual([linux.capabilities.os, linux.capabilities.arch, linux.capabilities.displays.length, linux.capabilities.computerUse, linux.capabilities.enrol], ["linux", "arm64", 0, null, true]);
  assert.match(linux.description, /amd64 container images and x86_64 binaries do not run there/);
  assert.deepEqual([linux.requires, linux.capabilities.features], [[], ["docker"]]);
  // Off by default, and on alone.
  assert.deepEqual(new TartBackend(tartConfig(), testContext()).kinds().map((kind) => kind.id), ["macos", "macos-desktop"]);
  const alone = tartConfig({ "tart-linux-image": "bb-box-linux", "tart-macos-image": "", "tart-macos-desktop-image": "" });
  assert.deepEqual(new TartBackend(alone, testContext()).kinds().map((kind) => kind.id), ["linux-arm64"]);
  const none = parseTartSettings({ "tart-enabled": true, "tart-hosts": "mac1 a@b", "tart-host-keys": "b ssh-ed25519 AAAA", "tart-macos-image": "", "tart-macos-desktop-image": "" });
  assert.ok(none.enabled && !none.ok && none.problems.some((problem) => /an image for macOS, Linux or Windows boxes/.test(problem)));
});

test("a Linux box runs as box, boots with no saved state or VNC, and stop shuts it down (040)", async () => {
  const { ssh, mac, make, backend } = linuxSetup();
  const box = identity("linux-arm64", "thr_abc123", LINUX_SMALL);
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  assert.deepEqual(guest.data, { box: box.boxId, os: "linux" });
  const runs = () => tartCalls(mac).filter((call) => call[0] === "tart" && call[1] === "run" && call.at(-1) === guest.ref);
  assert.deepEqual(runs(), [["tart", "run", "--no-graphics", guest.ref]], "neither --suspendable nor --vnc-experimental");
  assert.ok(ssh.log().some((entry) => entry.target === `box@${guest.address}`), "the VM is reached as box");
  assert.ok(!ssh.log().some((entry) => entry.target === `admin@${guest.address}`));

  const { command, access } = await backend.transports(guest, "linux-arm64");
  assert.equal(access?.ssh?.user, "box");
  assert.equal((await command!.run("echo hello")).stdout, "hello\n");
  // A new instance finds it as a Linux box.
  assert.deepEqual((await make().held()).find((held) => held.ref === guest.ref)?.data, { box: box.boxId, os: "linux" });

  // The macOS VMs' two are untouched while it runs.
  const guests = (await backend.capacity("macos", SMALL, [])).hosts[0]!.limits.find((limit) => limit.resource === "guests")!;
  assert.equal(guests.used, 0);

  // Another install's stop finds it gone, and never asks it to shut down.
  const poweroffs = () => ssh.log().filter((entry) => entry.command.includes("systemctl poweroff")).length;
  const asked = poweroffs();
  const other = make(testContext(new MemoryStorage(), "other-install"));
  await assert.rejects(other.stop(guest), (error: unknown) => error instanceof BackendError && error.code === "gone");
  assert.equal(poweroffs(), asked);
  assert.equal(await backend.power(guest), "running");

  await backend.stop(guest);
  assert.equal(poweroffs(), asked + 1, "its own install asks it to shut down first");
  assert.equal(await backend.power(guest), "stopped");
  assert.equal(existsSync(join(mac, ".tart", "vms", guest.ref, "state.vzvmsave")), false, "shut down, not suspended");
  assert.ok(tartCalls(mac).some((call) => call[1] === "stop" && call[2] === guest.ref));
  assert.ok(!tartCalls(mac).some((call) => call[1] === "suspend" && call[2] === guest.ref));
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  assert.equal(runs().length, 2, "it booted again");
  await backend.release(guest, releasing);
});

test("each new instance, as after a restart, reaches a Linux box as box from its data alone, and closes that connection when it stops it (#240)", async () => {
  const { ssh, make, backend } = linuxSetup();
  const box = identity("linux-arm64", "thr_abc123", LINUX_SMALL);
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  // Stop asks the VM to shut down on a shared connection, which must close before the VM goes.
  const exits = () => ssh.log().filter((entry) => entry.control === "exit" && entry.target === `box@${guest.address}`).length;
  const closed = exits();
  await make().stop(guest);
  assert.ok(exits() > closed, "its connection as box closed");
  await make().start(guest);
  assert.equal(await backend.power(guest), "running");
  await make().relabel(guest, { ...box, name: "build-2" }, box.name, signal());
  assert.ok(ssh.log().some((entry) => entry.target === `box@${guest.address}` && entry.command.includes("'build-2'")), "named as box");
  assert.ok(!ssh.log().some((entry) => entry.target === `admin@${guest.address}`), "never as the macOS user");
  const kept = exits();
  await backend.release(guest, releasing);
  assert.ok(exits() > kept, "release closes it too");
});

test("a Linux desktop box waits for its desktop, and opens it through SSH to the VM's own VNC server (040)", async () => {
  const off = new TartBackend(tartConfig({ "tart-linux-image": "bb-box-linux" }), testContext()).kinds();
  assert.ok(!off.some((kind) => kind.id === "linux-arm64-desktop-cpu"), "off until it has an image of its own");
  const { ssh, mac, backend } = linuxSetup({ "tart-linux-desktop-image": "bb-box-linux-desktop" });
  addImage(mac, "bb-box-linux-desktop", "linux");
  const kind = backend.kinds().find((candidate) => candidate.id === "linux-arm64-desktop-cpu")!;
  assert.deepEqual([kind.capabilities.os, kind.capabilities.arch, kind.capabilities.displays], ["linux", "arm64", [{ id: "desktop", protocol: "rfb", resizable: true }]]);
  assert.equal(kind.capabilities.computerUse?.socket, "/home/box/.cache/cua-driver/cua-driver.sock");

  const recorded = hooks();
  const guest = await backend.acquire(identity("linux-arm64-desktop-cpu", "thr_abc123", LINUX_SMALL), null, recorded.hooks, signal());
  assert.deepEqual(Object.keys(recorded.timings), ["place", "clone", "start", "network", "ssh", "desktop", "identify", "name"]);
  assert.ok(tartCalls(mac).some((call) => call[1] === "clone" && call[2] === "bb-box-linux-desktop" && call[3] === guest.ref));
  const waits = () => ssh.log().filter((entry) => entry.target === `box@${guest.address}` && entry.command.includes("systemctl is-active --quiet bb-box-display.service")).length;
  assert.equal(waits(), 1);

  const { displays } = await backend.transports(guest, "linux-arm64-desktop-cpu");
  assert.deepEqual(displays.map((display) => [display.id, display.resizable, Boolean(display.resize), display.minSize]), [["desktop", true, false, { width: 800, height: 600 }]]);
  const { route, auth } = await displays[0]!.open(signal());
  assert.equal(route.type, "command");
  const argv = route.type === "command" ? route.argv : [];
  assert.deepEqual(argv.slice(-3), ["-W", "127.0.0.1:5900", `box@${guest.address}`], "to the VM's own VNC server, through the Mac");
  // The test machine has no desktop, so no password file.
  assert.deepEqual(auth, { type: "none" });
  assert.ok(ssh.log().some((entry) => entry.target === `box@${guest.address}` && entry.command.includes("/var/lib/bb-box/vnc-password")));

  // It waits for the desktop again when it boots again.
  await backend.stop(guest);
  await backend.start(guest);
  assert.equal(waits(), 2);
  await backend.release(guest, releasing);
});

test("Linux boxes take memory on a Mac but none of its two macOS VMs, and have no warm pool (040)", async () => {
  const { make, backend } = linuxSetup();
  const asked = make(testContext(new MemoryStorage(), "test", { warm: { "linux-arm64": 1 } }));
  assert.equal((await asked.capacity("linux-arm64", LINUX_SMALL, [])).warm?.target, 0, "Tart cannot suspend a Linux VM");
  const first = await backend.acquire(identity("macos"), null, hooks().hooks, signal());
  const second = await backend.acquire(identity("macos"), null, hooks().hooks, signal());
  assert.equal((await backend.capacity("macos", SMALL, [])).ok, false);
  const linux = await backend.capacity("linux-arm64", LINUX_SMALL, [{ kind: "macos", size: SMALL }]);
  assert.equal(linux.ok, true, linux.message ?? "");
  const memory = linux.hosts[0]!.limits.find((limit) => limit.resource === "memory")!;
  assert.equal(memory.used, 2 * 8192 + 8192, "both macOS VMs and the pending box");
  const third = await backend.acquire(identity("linux-arm64", "thr_abc123", LINUX_SMALL), null, hooks().hooks, signal());
  for (const guest of [first, second, third]) await backend.release(guest, releasing);
});

test("a Mac takes two macOS VMs; the third is refused with what to release", async () => {
  const { owners, backend } = setup();
  const first = await backend.acquire(identity(), null, hooks().hooks, signal());
  const second = await backend.acquire(identity("macos"), null, hooks().hooks, signal());
  const capacity = await backend.capacity("macos", SMALL, []);
  assert.equal(capacity.ok, false);
  assert.match(capacity.message!, /mac1 runs 2 of the 2 macOS VMs/);
  assert.match(capacity.message!, new RegExp(first.ref));
  const third = identity();
  await assert.rejects(backend.acquire(third, null, hooks().hooks, signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
  assert.equal(existsSync(join(owners, `bb-box-${third.boxId}`)), false);
  await backend.release(first, releasing);
  await backend.release(second, releasing);
});

test("a VM the framework refuses to run, as when another app runs macOS VMs, is no_capacity and leaves nothing", async () => {
  const { mac, owners, backend } = setup({ "tart-vms-per-host": 2 });
  // Two running Linux VMs, which neither capacity nor the framework counts against the two, but whose memory counts.
  for (const name of ["other-a", "other-b"]) {
    addImage(mac, name, "linux");
    writeFileSync(join(mac, ".tart", "vms", name, "running"), String(process.pid));
  }
  const room = (await backend.capacity("macos", SMALL, [])).hosts[0]!;
  assert.equal(room.limits.find((limit) => limit.resource === "guests")!.used, 0, "Linux VMs do not count against the two");
  assert.equal(room.limits.find((limit) => limit.resource === "memory")!.used, 16384, "but their memory does");
  // Two macOS VMs another app runs, which Tart does not list but the framework counts.
  writeFileSync(join(mac, ".fake-other-macos-vms"), "2");
  const box = identity();
  await assert.rejects(backend.acquire(box, null, hooks().hooks, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "no_capacity", String(error));
    assert.match(error.message, /exceeds the system limit/);
    return true;
  });
  assert.equal(existsSync(join(owners, `bb-box-${box.boxId}`)), false);
  assert.equal(existsSync(join(mac, ".tart", "vms", `bb-box-${box.boxId}`)), false);
});

test("release deletes the VM, its output and last its owner file; again is fine; then the box is gone", async () => {
  const { mac, owners, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.release(guest, releasing);
  assert.equal(existsSync(join(mac, ".tart", "vms", guest.ref)), false);
  assert.equal(existsSync(join(owners, guest.ref)), false);
  assert.equal(existsSync(join(mac, ".bb-box", "tart", "run", `${guest.ref}.out`)), false);
  await backend.release(guest, releasing);
  assert.equal(await backend.power(guest), null);
  await assert.rejects(backend.start(guest), (error: unknown) => error instanceof BackendError && error.code === "gone");
});

/** A macOS crash report (.ips) of `tart run` in Apple's VNC server, as on 2 October 2026 (#406), cut down. */
function crashReport(pid: number): string {
  const header = { app_name: "tart", timestamp: "2026-10-03 00:33:06.00 +0100", app_version: "2.30.0", bug_type: "309", name: "tart" };
  const frames = [
    { imageIndex: 0, symbol: "Base::assertion_trap()" },
    { imageIndex: 0, symbol: "-[_VZVirtualMachineAccessor addAccessorObserver:]" },
    { imageIndex: 0, symbol: "void void (*Base::CallbackAdapter::Callback<0ul>::make<false, -[_VZVNCServer _setupVirtualMachineAccessor]::$_18>)(void*)" },
    { imageIndex: 1, symbol: "_dispatch_client_callout" },
  ];
  return `${JSON.stringify(header)}
{
  "pid" : ${pid},
  "exception" : {"codes":"0x1","type":"EXC_BREAKPOINT","signal":"SIGTRAP"},
  "asi" : {"libsystem_c.dylib":["assertion failed"]},
  "faultingThread" : 1,
  "threads" : [{"frames":[]},{"frames":${JSON.stringify(frames)}}],
  "usedImages" : [{"name":"Virtualization"},{"name":"libdispatch.dylib"}]
}`;
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; !done(); i++) {
    assert.ok(i < 200, "it did not happen within 10 s");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("a VM whose tart run crashed says so, with macOS's crash report; one that shut down says that; a start keeps the run before (#406)", async () => {
  const { mac, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const run = join(mac, ".bb-box", "tart", "run");
  const exit = join(run, `${guest.ref}.exit`);
  const pid = Number(readFileSync(join(mac, ".tart", "vms", guest.ref, "running"), "utf8"));
  assert.match(readFileSync(exit, "utf8"), new RegExp(`^pid=${pid}\nstarted=\\d+\n$`));

  process.kill(pid, "SIGTRAP");
  await until(() => readFileSync(exit, "utf8").includes("status="));
  assert.match(readFileSync(exit, "utf8"), /\nstatus=133\nended=\d+\n$/);
  const reports = join(mac, "Library", "Logs", "DiagnosticReports");
  mkdirSync(reports, { recursive: true });
  writeFileSync(join(reports, "tart-2026-10-02-235959.ips"), crashReport(pid + 1));
  writeFileSync(join(reports, "tart-2026-10-03-003306.ips"), crashReport(pid));
  assert.equal(await backend.power(guest), "stopped");
  const crashed = await backend.stopped(guest, signal());
  assert.equal(crashed?.crashed, true);
  assert.equal(
    crashed?.reason,
    "tart run ended on signal 5 (SIGTRAP). macOS's crash report tart-2026-10-03-003306.ips: EXC_BREAKPOINT (SIGTRAP), assertion failed, in Virtualization's -[_VZVirtualMachineAccessor addAccessorObserver:], called from -[_VZVNCServer _setupVirtualMachineAccessor].",
  );
  assert.ok(crashed?.at, "it says when");

  await backend.start(guest);
  assert.match(readFileSync(`${exit}.last`, "utf8"), /status=133/);
  assert.match(readFileSync(join(run, `${guest.ref}.out.last`), "utf8"), /VNC server is running/);
  // The guest shuts itself down, so tart run exits 0.
  rmSync(join(mac, ".tart", "vms", guest.ref, "running"));
  await until(() => readFileSync(exit, "utf8").includes("status="));
  const shut = await backend.stopped(guest, signal());
  assert.equal(shut?.crashed, false);
  assert.match(shut!.reason, /^tart run exited with status 0: the guest shut itself down/);
  assert.doesNotMatch(shut!.reason, /vnc:|fake-pass-word/);

  await backend.release(guest, releasing);
  for (const file of [".out", ".out.last", ".exit", ".exit.last"]) assert.equal(existsSync(join(run, `${guest.ref}${file}`)), false, file);
});

test("says why a run ended from what the Mac recorded (#406)", () => {
  const end = (fields: Partial<RunEnd>): RunEnd => ({ pid: 81818, startedAt: 1_790_000_000_000, status: null, endedAt: null, bootedAt: 1_700_000_000_000, output: "", crash: null, ...fields });
  assert.deepEqual(parseEnded("@exit\npid=81818\nstarted=1790000000\nstatus=1\nended=1790000060\n@boot\n{ sec = 1700000000, usec = 0 } Tue Nov 14\n@output\nError: VM stopped\n  with an error\n"), {
    pid: 81818,
    startedAt: 1_790_000_000_000,
    status: 1,
    endedAt: 1_790_000_060_000,
    bootedAt: 1_700_000_000_000,
    output: "Error: VM stopped / with an error",
    crash: null,
  });
  assert.equal(parseEnded("gone\n"), null);
  assert.equal(endReason(end({ pid: null }), "tart run"), null, "a run started before bb-box recorded them");
  assert.deepEqual(endReason(end({ status: 1, endedAt: 5, output: "Error: VM stopped" }), "tart run"), { reason: "tart run exited with status 1. Its last output: Error: VM stopped", crashed: true, at: 5 });
  assert.deepEqual(endReason(end({ bootedAt: 1_790_000_100_000 }), "tart run"), { reason: "The Mac restarted at 2026-09-21 14:15:00 UTC, which ended tart run.", crashed: true, at: 1_790_000_100_000 });
  assert.deepEqual(endReason(end({}), "QEMU"), { reason: "QEMU ended, but left no exit status.", crashed: false, at: null });
  assert.match(endReason(end({ status: 137 }), "QEMU")!.reason, /^QEMU ended on signal 9 \(SIGKILL\)\.$/);
  assert.equal(crashSummary("{}\nnot json"), null);
});

test("a new instance on empty storage finds this install's VMs and their owners, and no other install's", async () => {
  const { make, backend } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  const other = make(testContext(new MemoryStorage(), "other"));
  const theirs = await other.acquire(identity(), null, hooks().hooks, signal());

  const fresh = make(testContext(new MemoryStorage()));
  const held = await fresh.held();
  assert.deepEqual(
    held.map((entry) => ({ ref: entry.ref, host: entry.host, owner: entry.owner, power: entry.power, data: entry.data })),
    [{ ref: guest.ref, host: "mac1", owner: { boxId: box.boxId, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt }, power: "running", data: { box: box.boxId } }],
  );
  // To this install the other's VM does not exist, and it is left alone.
  assert.equal(await fresh.power(theirs), null);
  await assert.rejects(fresh.stop(theirs), (error: unknown) => error instanceof BackendError && error.code === "gone");
  await fresh.release(theirs, releasing);
  assert.equal(await other.power(theirs), "running");
  // It reaches this install's VM from the guest alone, asking the Mac for its address.
  const { command } = await fresh.transports({ ...held[0]!, address: null }, box.kind);
  assert.equal((await command!.run("echo again")).stdout, "again\n");

  const doctor = await fresh.doctor();
  assert.ok(doctor.ok, JSON.stringify(doctor.checks));
  assert.ok(doctor.notes.some((note) => /1 of install other/.test(note)));
  await fresh.release(guest, releasing);
  await other.release(theirs, releasing);
});

test("doctor says what is missing on the Mac", async () => {
  const { ssh, backend, make } = setup({ "tart-macos-desktop-image": "bb-box-missing" });
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  const image = report.checks.find((check) => check.id === "image.mac1.macos-desktop")!;
  assert.equal(image.status, "fail");
  assert.match(image.fix!, /prepare-image\.sh/);
  assert.ok(report.notes.some((note) => /authorized_keys: ssh-ed25519 /.test(note)));
  const sizes = report.checks.find((check) => check.id === "sizes.mac1")!;
  assert.deepEqual([sizes.name, sizes.status], ["Box sizes on mac1", "ok"]);
  assert.equal(sizes.detail, "mac1 holds macos and macos-desktop boxes at the default sizes.");
  ssh.down(MAC);
  const down = await make().doctor();
  assert.equal(down.checks.find((check) => check.id === "host.mac1")!.status, "fail");
  assert.equal(down.checks.find((check) => check.id === "image.mac1.macos")!.status, "skipped");
});

test("a box has the cores and memory it asks for, read from its config; capacity refuses what a Mac cannot give", async () => {
  const { backend } = setup();
  const medium: BoxSize = { cores: 6, memoryMiB: 16384, diskGiB: null };
  const guest = await backend.acquire(identity("macos", "thr_abc123", medium), null, hooks().hooks, signal());
  assert.deepEqual(guest.size, medium);
  assert.deepEqual((await backend.held()).find((held) => held.ref === guest.ref)?.size, medium, "held reads it from the VM's config");
  await backend.release(guest, releasing);

  const refused = async (size: BoxSize, pending: { kind: string; size: BoxSize }[] = []) => {
    const capacity = await backend.capacity("macos", size, pending);
    assert.equal(capacity.ok, false, JSON.stringify(size));
    return capacity.message!;
  };
  // The fake Mac has 16 cores and 128 GiB, and 16 GiB is kept free.
  assert.match(await refused({ ...SMALL, cores: 32 }), /mac1 has 16 cores, fewer than the 32 asked for/);
  assert.match(await refused({ ...SMALL, memoryMiB: 120 * 1024 }), /has [\d.]+ GiB of memory free and keeps 16 GiB free, so a box with 120 GiB does not fit/);
  assert.match(await refused({ ...SMALL, diskGiB: 32 }), /keeps its image's disk/);
  const big: BoxSize = { cores: 8, memoryMiB: 64 * 1024, diskGiB: null };
  assert.equal((await backend.capacity("macos", big, [])).ok, true);
  assert.match(await refused(big, [{ kind: "macos", size: big }]), /memory free/, "a pending box's memory counts");
});

test("a box's hostname comes from its name, and only a VM is renamed", () => {
  assert.equal(hostnameOf("calm-otter-3"), "calm-otter-3");
  assert.equal(hostnameOf("Calm Otter_3!"), "calm-otter-3");
  assert.equal(hostnameOf("--"), "box");
  assert.equal(hostnameOf("a".repeat(80)).length, 63);
  // The test machine is not a VM, so this renames nothing: Linux only in a VM, macOS only in a Virtualization framework VM.
  const script = nameScript("calm-otter-3");
  assert.match(script, /^if \[ "\$\(uname -s\)" = Linux \]; then\n {2}\[ "\$\(systemd-detect-virt --vm 2>\/dev\/null\)" = apple \] \|\| \{ echo "not a VM"; exit 0; \}\n/);
  // Shutting a Linux VM down is guarded the same way, and by the VM's own name.
  const off = powerOffScript("bb-box-bx1");
  assert.match(off, /^\[ "\$\(systemd-detect-virt --vm 2>\/dev\/null\)" = apple \] \|\| \{ echo "not a VM"; exit 0; \}\n/);
  assert.match(off, /\n\[ "\$\(cat "\$HOME\/\.config\/bb-box\/vm" 2>\/dev\/null\)" = 'bb-box-bx1' \] \|\| \{ echo "not bb-box-bx1"; exit 0; \}\nsync\nsudo -n systemctl poweroff --no-block/);
  assert.match(script, /\ncase "\$\(sysctl -n hw\.model 2>\/dev\/null\)" in VirtualMac\*\) ;; \*\) echo "not a VM"; exit 0 ;; esac\n/);
  // A Linux desktop's X cookie answers for any hostname before the name changes, which needs no D-Bus.
  const linux = script.slice(0, script.indexOf("\nfi\n"));
  assert.ok(linux.indexOf("nmerge -") < linux.indexOf("sudo -n sh -s -- 'calm-otter-3'"), linux);
  // Read, then merge: never two xauth on the file at once, which can wait 20 s for its lock and merge nothing.
  assert.match(linux, /if \[ -s "\$auth" \]; then entries=\$\(xauth -q -f "\$auth" nlist\) && printf '%s\\n' "\$entries" \| sed 's\/\^\.\.\.\.\/ffff\/' \| xauth -q -f "\$auth" nmerge -; fi\n/);
  assert.ok(!/nlist \|/.test(linux));
  assert.match(linux, /\nprintf '%s\\n' "\$1" > \/etc\/hostname\nhostname "\$1"\nNAME\n/);
  assert.ok(!linux.includes("hostnamectl"));
});

test("a VM that changes hands gets its new owner in its owner file, and its new name inside (036)", async () => {
  const { backend, ssh } = setup();
  const box = identity("macos-desktop", "spare");
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  await backend.relabel(guest, { ...box, threadId: "operator", name: "build-1" }, box.name, signal());
  const owner = (await backend.held()).find((held) => held.ref === guest.ref)?.owner;
  assert.deepEqual([owner?.threadId, owner?.name, owner?.boxId], ["operator", "build-1", box.boxId]);
  assert.ok(ssh.log().some((entry) => entry.target === `admin@${guest.address}` && entry.command.includes("scutil --set") && entry.command.includes("build-1")), "named inside");
  // Another box's ID is refused: the owner file is left alone.
  await assert.rejects(backend.relabel(guest, { ...box, boxId: "bxother" }, "build-1", signal()), /does not name box bxother/);
  await backend.release(guest, releasing);
});
