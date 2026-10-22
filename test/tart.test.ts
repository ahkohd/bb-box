import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { TartBackend, hostnameOf, macClockScript, nameScript, powerOffScript, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { parseHosts, parseTartSettings } from "../src/backends/tart/config.ts";
import { baseScript, crashSummary, endReason, ownerText, parseEnded, parseState, parseVnc, pruneBaseScript, startScript, stateScript, type RunEnd } from "../src/backends/tart/host.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type BoxSize, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_MAC, addImage, fakeMacTools, fakeXcode, imageRecord, tartConfig } from "./fake-mac.ts";
import { VNC_BRIDGE_PY } from "../src/backends/tart/vnc-holder.ts";
import { FakeTart, Viewer } from "./fake-tart-vnc.ts";
import { FAKE_MAC_HELPER, FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const GiB = 2 ** 30;
const MAC = FAKE_MAC;

const made: TartBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER };

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
  // macOS desktops as video are off until set on (060).
  assert.equal(tartConfig().video, false);
  assert.equal(tartConfig({ "tart-video": true }).video, true);
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
  // Tart's VNC server moves no clipboard, so bb-box does with commands in the box (#464), and takes Alt as Command.
  assert.deepEqual(desktop.displays, [{ id: "desktop", protocol: "rfb", resizable: false, clipboard: "commands", macKeys: "alt-command" }]);
  assert.equal(desktop.computerUse?.socket, "/Users/admin/Library/Caches/cua-driver/cua-driver.sock");
});

test("the Mac's state fails when Tart's home or the QEMU folder links to a volume that is not mounted, so its boxes are kept (#632)", () => {
  const home = mkdtempSync(join(tmpdir(), "bbbox-volume-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".bb-box", "tart", "owners"), { recursive: true });
  const run = () => spawnSync("/bin/sh", ["-c", stateScript(true)], { encoding: "utf8", env: { HOME: home, PATH: "/usr/bin:/bin" } });
  for (const [link, at] of [[join(home, ".tart"), join(home, "gone", "tart")], [join(home, ".bb-box", "qemu"), join(home, "gone", "qemu")]] as const) {
    symlinkSync(at, link);
    const missing = run();
    assert.notEqual(missing.status, 0);
    assert.equal(missing.stderr.trim(), `${link} links to ${at}, which is not there: is its volume mounted?`);
    // Mounted again: the state goes on, here to say there is no tart.
    mkdirSync(at, { recursive: true });
    assert.doesNotMatch(run().stderr, /is its volume mounted/u);
  }
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
  assert.deepEqual(state.vms, [{ name: "bb-box-bx1", state: "running", running: true, diskGB: null }]);
  assert.deepEqual(state.configs.get("bb-box-bx1"), { os: "darwin", macAddress: null, memoryMiB: 8192, cpus: 4 });
  assert.deepEqual(state.owners.get("bb-box-bx1"), { install: "k3v9q2m7xa", box: "bx1" });
  assert.equal(state.memoryMiB, 131072);
  assert.equal(state.disk.freeMiB, Math.floor(150000000 / 1024));
  assert.equal(state.disk.volume, "");
  // df's mount point, which may have spaces: Tart's VMs on another volume, through a link (#632).
  assert.deepEqual(parseState("@disk\n1900000000 150000000 /Volumes/Fast VMs\n").disk, { totalMiB: Math.floor(1900000000 / 1024), freeMiB: Math.floor(150000000 / 1024), volume: "/Volumes/Fast VMs" });
  assert.deepEqual(parseVnc("vnc://:open-sesame-word-four@127.0.0.1:61234\n"), { port: 61234, password: "open-sesame-word-four" });
  assert.equal(parseVnc(""), null);
});

test("a macOS desktop is Tart's VNC through the run's holder, which starts with the run and makes its only connection, however often viewers open it (#406)", async (t) => {
  const { mac, backend } = setup();
  fakeXcode(mac);
  // Tart's VNC server for the run, which crashes on a second connection.
  const probe = new FakeTart("");
  const port = await probe.listen();
  const tart = new FakeTart(`fake-pass-word-${port}`);
  probe.server.close();
  await new Promise<void>((resolve) => tart.server.listen(port, "127.0.0.1", resolve));
  t.after(() => {
    tart.end();
    tart.server.close();
  });
  writeFileSync(join(mac, ".fake-vnc-port"), String(port));

  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  // The holder connects as the run starts, before any viewer, however long python3 takes to start under load (#580).
  await tart.connected;
  const displays = (await backend.transports(guest, "macos-desktop")).displays;
  assert.deepEqual(displays.map((one) => one.protocol), ["rfb"], "no video in a VM without bb-box-stream (060)");
  const [display] = displays;
  for (let open = 0; open < 3; open++) {
    const opened = await display!.open(signal());
    assert.deepEqual(opened.auth, { type: "none" }, "the holder's socket is the host user's alone");
    const argv = opened.route.type === "command" ? opened.route.argv : [];
    assert.deepEqual(argv.slice(-3), [`bbbox-admin@${MAC}`, "--", `exec /usr/bin/python3 -c '${VNC_BRIDGE_PY}' "$HOME"/.bb-box/tart/run/'${guest.ref}.vnc'`]);
  }
  // A viewer on the holder's socket, as the bridge gives it to the relay.
  const viewer = new Viewer(join(mac, ".bb-box", "tart", "run", `${guest.ref}.vnc`));
  await viewer.join();
  await viewer.update();
  viewer.close();
  assert.equal(tart.connections, 1, "one connection to Tart's VNC for the run");
  assert.equal(tart.crashed, false);

  // The run ends; its holder with it, and no viewer can open the desktop until a new run.
  tart.end();
  await until(() => !existsSync(join(mac, ".bb-box", "tart", "run", `${guest.ref}.vnc`)));
  await assert.rejects(display!.open(signal()), /The desktop's stream for this run of bb-box-\S+ has ended: Tart's VNC server closed the connection, as when the run ends\. Stop and start the box to show its desktop again\./);
  assert.equal(tart.connections, 1, "and it did not connect again");
});

test("a macOS desktop declares video while every Mac's image record lists bb-box-stream, by choice unless the video field makes it the default, and offers it in a VM that has it, through bb-box-stream connect in the desktop session (060)", async () => {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  fakeMacTools(mac);
  addImage(mac);
  const stream = join(mkdtempSync(join(tmpdir(), "bb-box-stream-")), "bb-box-stream");
  const make = (video: boolean) => {
    const tart = new TartBackend(tartConfig({ "tart-video": video }), testContext(new MemoryStorage()), { ...FAKES, macStream: stream });
    made.push(tart);
    return tart;
  };
  const backend = make(true);
  // Before a Mac answers, as just after bb-box starts, a macOS desktop keeps the video it has: its kind does not yet say.
  const someGuest = { ref: "a-vm", data: {} } as unknown as Parameters<TartBackend["asOffered"]>[0];
  assert.equal(await backend.asOffered(someGuest, "macos-desktop"), false);
  assert.equal(await backend.asOffered(someGuest, "macos"), true);
  const declaredBy = async (by: TartBackend) => {
    await by.capacity("macos-desktop", SMALL, [], signal());
    return by.kinds().find((kind) => kind.id === "macos-desktop")!.capabilities.displays.map((display) => (display.byChoice ? `${display.protocol} by choice` : display.protocol));
  };
  const declared = () => declaredBy(backend);
  assert.deepEqual(await declared(), ["rfb"], "not while the image's record lacks it");
  assert.equal(await backend.asOffered(someGuest, "macos-desktop"), true, "once a Mac has answered, its kind says");
  const record = join(mac, ".bb-box", "tart", "images", "bb-box-macos.json");
  const without = readFileSync(record, "utf8");
  writeFileSync(record, `${JSON.stringify({ ...JSON.parse(without), tools: { "bb-box-stream": "0123456789ab" } })}\n`);
  assert.deepEqual(await declared(), ["rfb", "selkies"]);
  assert.deepEqual(await declaredBy(make(false)), ["rfb", "selkies by choice"], "and by choice while the video field is off, its default: the viewer opens VNC");

  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  // A VM without it, as a box of an older build may be, offers RFB alone.
  assert.deepEqual((await backend.transports(guest, "macos-desktop")).displays.map((display) => display.protocol), ["rfb"]);
  const other = await backend.acquire(identity(), null, hooks().hooks, signal());
  writeFileSync(stream, "#!/bin/sh\n", { mode: 0o755 });
  const { displays } = await backend.transports(other, "macos-desktop");
  assert.deepEqual(
    displays.map((display) => [display.id, display.label, display.protocol, display.resizable]),
    [
      ["desktop", "Desktop", "rfb", false],
      ["video", "Desktop, as video", "selkies", false],
    ],
  );
  const opened = await displays[1]!.open(signal());
  assert.deepEqual(opened.auth, { type: "none" });
  assert.equal(opened.input, undefined, "bb-box-stream takes the viewer's input itself");
  const remote = opened.route.type === "command" ? opened.route.argv.at(-1)! : "";
  assert.match(remote, /exec \/usr\/local\/bin\/bb-box-stream connect/);
  assert.match(remote, /launchctl asuser/, "in the box user's desktop session");

  writeFileSync(record, without);
  assert.deepEqual(await declared(), ["rfb"], "and no longer once a Mac's image lacks it");
});

test("a macOS box grants its programs macOS permissions through the Mac helper in the VM, refusing while SIP is on, and lists its grants (058)", async () => {
  const { ssh, backend } = setup();
  const guest = await backend.acquire(identity("macos"), null, hooks().hooks, signal());
  const flags = join(ssh.home(guest.address!), ".bb-box-state", "flags");
  const request = { program: "/Users/admin/Applications/Probe.app", permissions: ["accessibility", "screen-recording"] as const };
  await assert.rejects(backend.grant!(guest, request), (error: unknown) => error instanceof BackendError && error.code === "unsupported" && /^System Integrity Protection is on/.test(error.message));
  assert.deepEqual(await backend.grants!(guest), { canGrant: false, signingIdentity: true, grants: [] });
  mkdirSync(flags, { recursive: true });
  writeFileSync(join(flags, "sip-off"), "");
  assert.deepEqual(await backend.grant!(guest, request), { client: "dev.example.probe", granted: ["accessibility", "screen-recording"], refused: [] });
  await assert.rejects(backend.grant!(guest, { program: "/usr/bin/true", permissions: ["camera"] }), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
  assert.deepEqual((await backend.grants!(guest))?.grants.map((grant) => grant.permission), ["accessibility", "screen-recording"]);
  await backend.release(guest, releasing);
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
  // The name and the grants go side by side, so either may end first.
  assert.deepEqual(Object.keys(recorded.timings).slice(0, 6), ["place", "clone", "start", "network", "ssh", "identify"]);
  assert.deepEqual(Object.keys(recorded.timings).slice(6).sort(), ["grants", "name"]);
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
  // This Mac has no python3 for the VNC holder, so the desktop says how to give it one.
  await assert.rejects(displays[0]!.open(), /mac1 could not start the desktop's stream for bb-box-\S+: The Mac has no python3 for bb-box's VNC holder: install Xcode's command line tools there \(xcode-select --install\)\./);

  // The VM's commands went to the VM, the rest to the Mac, and the VM is named after the box.
  const targets = new Set(ssh.log().map((entry) => entry.target));
  assert.ok(targets.has(`bbbox-admin@${MAC}`) && targets.has(`admin@${guest.address}`));
  assert.ok(
    ssh.log().some((entry) => entry.target === `admin@${guest.address}` && entry.command.includes("scutil --set") && entry.command.includes(box.name)),
    "the VM is named after the box",
  );
  await backend.release(guest, releasing);
});

test("stop suspends the VM and start resumes it, setting its clock; the VM counts against its Mac only while it runs", async () => {
  const { mac, backend, ssh } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const clocks = () => ssh.log().filter((entry) => entry.target === `admin@${guest.address}` && entry.command.includes("sudo -n date -u ")).length;
  assert.equal(clocks(), 0, "a clone boots with the right time");
  const used = async () => (await backend.capacity("macos", SMALL, [])).hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used;
  assert.equal(await used(), 1);
  await backend.stop(guest);
  assert.equal(await backend.power(guest), "stopped");
  assert.ok(existsSync(join(mac, ".tart", "vms", guest.ref, "state.vzvmsave")), "suspended, not shut down");
  assert.equal(await used(), 0);
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  assert.equal(await used(), 1);
  assert.equal(clocks(), 1, "a resumed VM's clock is set");
  await backend.release(guest, releasing);
});

test("a macOS VM's clock is set in UTC, half a second on, and only in a VM", () => {
  const script = macClockScript(Date.parse("2026-10-03T23:59:59.700Z"));
  assert.match(script, /^case "\$\(sysctl -n hw\.model 2>\/dev\/null\)" in VirtualMac\*\) ;; \*\) echo "not a VM"; exit 0 ;; esac\n/);
  assert.ok(script.endsWith("\nsudo -n date -u 100400002026.00 >/dev/null"), script);
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
  assert.deepEqual(runs(), [["tart", "run", "--no-graphics", "--no-clipboard", guest.ref]], "neither --suspendable nor --vnc-experimental");
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
  const { ssh, mac, backend, context } = linuxSetup({ "tart-linux-desktop-image": "bb-box-linux-desktop" });
  addImage(mac, "bb-box-linux-desktop", "linux");
  const kind = backend.kinds().find((candidate) => candidate.id === "linux-arm64-desktop-cpu")!;
  // Selkies beside the VNC server, video by choice (060).
  assert.deepEqual(
    [kind.capabilities.os, kind.capabilities.arch, kind.capabilities.displays],
    ["linux", "arm64", [{ id: "desktop", protocol: "rfb", resizable: true }, { id: "selkies", protocol: "selkies", resizable: true, cursor: "selkies", byChoice: true }]],
  );
  assert.equal(kind.capabilities.computerUse?.socket, "/home/box/.cache/cua-driver/cua-driver.sock");

  const recorded = hooks();
  const guest = await backend.acquire(identity("linux-arm64-desktop-cpu", "thr_abc123", LINUX_SMALL), null, recorded.hooks, signal());
  assert.deepEqual(Object.keys(recorded.timings), ["place", "clone", "start", "network", "ssh", "desktop", "identify", "name"]);
  assert.ok(tartCalls(mac).some((call) => call[1] === "clone" && call[2] === "bb-box-linux-desktop" && call[3] === guest.ref));
  const waits = () => ssh.log().filter((entry) => entry.target === `box@${guest.address}` && entry.command.includes("systemctl is-active --quiet bb-box-display.service")).length;
  assert.equal(waits(), 1);

  const { displays } = await backend.transports(guest, "linux-arm64-desktop-cpu");
  assert.deepEqual(displays.map((display) => [display.id, display.resizable, Boolean(display.resize), display.minSize]), [["desktop", true, false, { width: 800, height: 600 }]], "no video for an image without Selkies' launcher");
  const { route, auth } = await displays[0]!.open(signal());
  assert.equal(route.type, "command");
  const argv = route.type === "command" ? route.argv : [];
  assert.deepEqual(argv.slice(-3), ["-W", "127.0.0.1:5900", `box@${guest.address}`], "to the VM's own VNC server, through the Mac");
  // The test machine has no desktop, so no password file.
  assert.deepEqual(auth, { type: "none" });
  assert.ok(ssh.log().some((entry) => entry.target === `box@${guest.address}` && entry.command.includes("/var/lib/bb-box/vnc-password")));

  // A box whose image has Selkies' launcher has video too, through SSH to Selkies on the VM's loopback (060).
  const withSelkies = new TartBackend(tartConfig({ "tart-linux-image": "bb-box-linux", "tart-linux-desktop-image": "bb-box-linux-desktop" }), context, { ...FAKES, selkiesLauncher: "/bin/sh" });
  made.push(withSelkies);
  const video = (await withSelkies.transports(guest, "linux-arm64-desktop-cpu")).displays;
  assert.deepEqual(video.map((display) => [display.id, display.label, display.cursor ?? null]), [["desktop", "Desktop", null], ["selkies", "Desktop, as video", "selkies"]]);
  const opened = await video[1]!.open(signal());
  assert.deepEqual(opened.route.type === "command" && opened.route.argv.slice(-3), ["-W", "127.0.0.1:5980", `box@${guest.address}`]);

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
  assert.match(capacity.message!, new RegExp(`box calm-otter-\\d+ of thread thr_abc123`), "names the box, not its VM");
  assert.doesNotMatch(capacity.message!, new RegExp(first.ref));
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

/** Waits for done(). The 60 s is for a hang, not a measure of speed: a full suite can be slow (#580). */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; !done(); i++) {
    assert.ok(i < 1200, "it did not happen within 60 s");
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

test("image operations on a Mac: an image box, its capture with its record beside it, a build by the prepare script, and the image's name moved to it (049)", async () => {
  const { mac, context } = setup();
  const record = (build: string, kind = "macos") => JSON.stringify({ contract: 1, image: "standard", kind, arch: "arm64", build, built: new Date().toISOString(), os: "macOS 27.0", tools: { "cua-driver": "0.30.4" } });
  // An ssh that answers a box's record, as finalizing leaves it in a macOS image, and otherwise runs as the fake does.
  const dir = join(mac, "..", `image-ops-${counter++}`);
  mkdirSync(dir, { recursive: true });
  const binary = join(dir, "ssh");
  writeFileSync(binary, `#!/bin/sh\ncase "$*" in *"cat /usr/local/share/bb-box/image.json"*) echo '${record("build.20261003-030000-abcd")}'; exit 0;; esac\nexec "${FAKE_SSH_BINARY}" "$@"\n`, { mode: 0o755 });
  const backend = new TartBackend(tartConfig({}), context, { ...FAKES, sshBinary: binary });
  made.push(backend);
  const images = backend.images;

  const listed = await images.list();
  const standard = listed.builds.find((build) => build.ref === "mac1/bb-box-macos")!;
  assert.deepEqual([listed.builds.length, standard.image, standard.kind, standard.current, standard.record?.kind], [1, "standard", "macos", true, "macos"], "macOS kinds share their image");
  assert.deepEqual(listed.boxes, []);

  // An image box: a clone at the kind's default size, with an owner file that marks it, which no sweep takes.
  const box = await images.box(standard, "a small image", signal());
  const vm = box.ref.slice("mac1/".length);
  assert.match(vm, /^bb-box-image-[0-9a-f]{12}$/);
  const owner = readFileSync(join(mac, ".bb-box", "tart", "owners", vm), "utf8");
  assert.match(owner, /^install=test\nkind=macos\nimage-box=a small image\n/);
  assert.equal((await box.command.run("echo in the box")).stdout, "in the box\n");
  assert.deepEqual(await backend.held(), [], "an image box is no box's");
  assert.deepEqual((await images.list()).boxes, [box.ref]);

  // Its capture: stopped, renamed, its record beside it, and an owner file that names its image.
  const captured = await images.capture(box, standard, "small", signal());
  assert.deepEqual([captured.ref, captured.build, captured.current], ["mac1/bb-box-img-small-20261003-030000-abcd", "build.20261003-030000-abcd", false]);
  assert.ok(existsSync(join(mac, ".tart", "vms", "bb-box-img-small-20261003-030000-abcd")));
  assert.ok(!existsSync(join(mac, ".tart", "vms", vm)), "the box is the build now");
  assert.equal(JSON.parse(readFileSync(join(mac, ".bb-box", "tart", "images", "bb-box-img-small-20261003-030000-abcd.json"), "utf8")).build, "build.20261003-030000-abcd");
  assert.match(readFileSync(join(mac, ".bb-box", "tart", "owners", "bb-box-img-small-20261003-030000-abcd"), "utf8"), /^install=test\nkind=macos\nimage-build=small\n/);
  assert.deepEqual(await backend.held(), [], "a captured build is no box's");
  assert.ok((await images.list()).builds.some((build) => build.ref === captured.ref && build.image === "small" && !build.current));

  // A project's box starts from the build, a clone of it (#439).
  assert.equal(images.startsFrom, true);
  const project = await backend.acquire({ ...identity(), from: captured.ref }, null, hooks().hooks, signal());
  assert.ok(tartCalls(mac).some((call) => call[1] === "clone" && call[2] === "bb-box-img-small-20261003-030000-abcd" && call[3] === project.ref), JSON.stringify(tartCalls(mac).filter((call) => call[1] === "clone")));
  await backend.release(project, releasing);

  // A trial box of it, then both removed; what is not an image's stays.
  const trial = await images.box(captured, "trial", signal());
  await images.remove(trial.ref, signal());
  await images.remove(captured.ref, signal());
  assert.ok(!existsSync(join(mac, ".tart", "vms", "bb-box-img-small-20261003-030000-abcd")));
  assert.ok(!existsSync(join(mac, ".bb-box", "tart", "images", "bb-box-img-small-20261003-030000-abcd.json")));
  await assert.rejects(images.remove("mac1/bb-box-macos", signal()), /bb-box-macos on mac1 is not an image box or build of this install's/);
  assert.deepEqual((await images.list()).boxes, []);

  // A new build by the prepare script, from a copy of setup/ on the Mac, as the user bb-box logs in as.
  const setupDir = join(dir, "setup");
  mkdirSync(join(setupDir, "tart"), { recursive: true });
  mkdirSync(join(setupDir, "proxmox-lxc"), { recursive: true });
  mkdirSync(join(setupDir, "ssh-pool"), { recursive: true });
  writeFileSync(join(setupDir, "ssh-pool", "mac-stream.swift"), "// bb-box-stream\n");
  writeFileSync(join(setupDir, "ssh-pool", "mac-chrome.sh"), "# Chrome\n");
  writeFileSync(
    join(setupDir, "tart", "prepare-image.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      'printf "%s\\n" "$@" > "$HOME/prepare-args"',
      // The image builds bb-box-stream from the pool Mac's source (060), which comes with the copy of setup/.
      'test -f ../ssh-pool/mac-stream.swift',
      // And installs Chrome as a pool Mac's setup does, with the script beside it.
      'test -f ../ssh-pool/mac-chrome.sh',
      'while [ $# -gt 0 ]; do case $1 in --name) name=$2; shift 2 ;; *) shift ;; esac; done',
      'export PATH="$HOME/.nix-profile/bin:$PATH"',
      'tart clone bb-box-macos "$name"',
      'mkdir -p "$HOME/.bb-box/tart/images"',
      `printf '%s\\n' '${record("build.20261003-090000-ef01")}' > "$HOME/.bb-box/tart/images/$name.json"`,
      'echo "done: $name is ready to clone"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const lines: string[] = [];
  const built = await images.build!(standard, setupDir, { bbUrl: "https://bb.example.com", log: (line) => lines.push(line), signal: signal() });
  assert.match(built.ref, /^mac1\/bb-box-img-refresh-[0-9a-z]+$/);
  assert.deepEqual([built.build, built.current], ["build.20261003-090000-ef01", false]);
  const args = readFileSync(join(mac, "prepare-args"), "utf8").trim().split("\n");
  assert.deepEqual(args.filter((arg) => arg.startsWith("--")), ["--key", "--name", "--bb-url"]);
  assert.match(args[args.indexOf("--key") + 1]!, /^ssh-ed25519 \S+ bb-box$/);
  assert.deepEqual(lines, [`done: ${built.ref.slice(5)} is ready to clone`]);
  assert.deepEqual(readdirSync(join(mac, ".bb-box", "tart")).filter((name) => name.startsWith("setup-")), [], "the copy of setup/ goes");
  assert.deepEqual(await backend.held(), []);

  // The replace: the build takes the image's name, with its record, and the old image goes.
  const replaced = await images.replace(built, standard, signal());
  assert.deepEqual([replaced.ref, replaced.current, replaced.build], ["mac1/bb-box-macos", true, "build.20261003-090000-ef01"]);
  assert.ok(!existsSync(join(mac, ".tart", "vms", built.ref.slice(5))));
  assert.deepEqual(readdirSync(join(mac, ".tart", "vms")).filter((name) => name.startsWith("bb-box-macos")), ["bb-box-macos"], "the old image is gone");
  assert.equal(JSON.parse(readFileSync(join(mac, ".bb-box", "tart", "images", "bb-box-macos.json"), "utf8")).build, "build.20261003-090000-ef01");
  assert.equal((await images.list()).builds.find((build) => build.ref === "mac1/bb-box-macos")?.build, "build.20261003-090000-ef01");
  assert.match(images.check!("macos"), /cua-driver/);
  assert.equal(images.check!("linux-arm64"), "bb-box-check-headless");
});

test("a standard image's prepare script runs detached on the Mac, so its build outlives a link that drops, and bb-box follows its log again (#707)", async () => {
  const { mac, context, ssh } = setup();
  const backend = new TartBackend(tartConfig({}), context, { ...FAKES, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 100))) });
  made.push(backend);
  const images = backend.images!;
  const standard = (await images.list()).builds.find((build) => build.ref === "mac1/bb-box-macos")!;
  const record = JSON.stringify({ contract: 1, image: "standard", kind: "macos", arch: "arm64", build: "build.20261017-090000-ab12", built: new Date().toISOString(), os: "macOS 27.0", tools: {} });
  const setupDir = join(mac, "..", `detached-${counter++}`, "setup");
  for (const sub of ["tart", "proxmox-lxc", "ssh-pool"]) mkdirSync(join(setupDir, sub), { recursive: true });
  writeFileSync(join(setupDir, "ssh-pool", "mac-stream.swift"), "// bb-box-stream\n");
  writeFileSync(join(setupDir, "ssh-pool", "mac-chrome.sh"), "# Chrome\n");
  // The Mac drops off the network for 2 s mid-build, as a Mac's link over Tailscale can.
  writeFileSync(
    join(setupDir, "tart", "prepare-image.sh"),
    [
      "#!/bin/sh",
      "set -eu",
      'while [ $# -gt 0 ]; do case $1 in --name) name=$2; shift 2 ;; *) shift ;; esac; done',
      'echo "before the drop: café"',
      'touch "$HOME/dropping"; sleep 3',
      'export PATH="$HOME/.nix-profile/bin:$PATH"',
      'tart clone bb-box-macos "$name"',
      'mkdir -p "$HOME/.bb-box/tart/images"',
      `printf '%s\\n' '${record}' > "$HOME/.bb-box/tart/images/$name.json"`,
      'echo "after the drop"',
    ].join("\n"),
    { mode: 0o755 },
  );
  const lines: string[] = [];
  let dropped = false;
  const drop = (async () => {
    while (!existsSync(join(mac, "dropping"))) await new Promise((resolve) => setTimeout(resolve, 50));
    ssh.down(MAC);
    dropped = true;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    rmSync(join(ssh.dir, "down", MAC));
  })();
  const built = await images.build!(standard, setupDir, { bbUrl: null, log: (line) => lines.push(line), signal: AbortSignal.timeout(60_000) });
  await drop;
  assert.ok(dropped);
  assert.equal(built.build, "build.20261017-090000-ab12");
  assert.deepEqual(lines, ["before the drop: café", "after the drop"], "each line once, whole, across the drop");
  assert.ok(!existsSync(join(ssh.dir, "down", MAC)));
  assert.deepEqual(readdirSync(join(mac, ".bb-box", "tart")).filter((name) => name.startsWith("setup-")), [], "the build's directory, log and all, goes");
});

test("the upkeep removes an image refresh's build VMs and image boxes of this install's left over hours ago, and leaves the rest (#707)", async () => {
  const { mac, owners, backend } = setup();
  const hours = (n: number) => Date.now() - n * 3_600_000;
  const stamp = (at: number) => at.toString(36);
  const vm = (name: string, owner?: Record<string, string | number>) => {
    addImage(mac, name);
    if (owner) writeFileSync(join(owners, name), ownerText(owner));
  };
  mkdirSync(owners, { recursive: true });
  const old = stamp(hours(6));
  const recent = stamp(hours(1));
  const others = hours(7);
  vm(`bb-box-img-refresh-${old}`, { install: "test", kind: "macos", "image-build": "standard", created: hours(6) });
  vm(`bb-box-img-refresh-${old}-build`);
  vm(`bb-box-img-refresh-${recent}`, { install: "test", kind: "macos", "image-build": "standard", created: hours(1) });
  vm("bb-box-image-0123456789ab", { install: "test", kind: "macos", "image-box": "answer time of build.x", created: hours(5) });
  vm("bb-box-image-ba9876543210", { install: "test", kind: "macos", "image-box": "trial of build.y", created: hours(1) });
  vm(`bb-box-img-refresh-${stamp(others)}`, { install: "another", kind: "macos", "image-build": "standard", created: others });
  vm("bb-box-img-myimage-20261001-000000-abcd", { install: "test", kind: "macos", "image-build": "myimage", created: hours(30) });
  await backend.maintain(AbortSignal.timeout(30_000));
  const left = readdirSync(join(mac, ".tart", "vms")).filter((name) => name !== "bb-box-macos").sort();
  assert.deepEqual(left, [
    `bb-box-img-refresh-${recent}`,
    `bb-box-img-refresh-${stamp(others)}`,
    "bb-box-image-ba9876543210",
    "bb-box-img-myimage-20261001-000000-abcd",
  ].sort(), "a recent refresh or box, another install's, and a project's build stay");
  assert.ok(!existsSync(join(owners, `bb-box-img-refresh-${old}`)));
  assert.ok(!existsSync(join(owners, "bb-box-image-0123456789ab")));
});

test("a suspended macOS VM's saved state is read through once before Tart restores it, which reads it in small pieces (#707)", () => {
  const script = startScript("bb-box-warm-0123456789ab", 60);
  const read = script.indexOf('cat "$h/vms/$vm/state.vzvmsave" > /dev/null');
  assert.ok(read > 0, "the read is there");
  assert.ok(read > script.indexOf("--suspendable") && read < script.indexOf("detach \"$out\""), "for a macOS VM, before its run starts");
  assert.ok(script.indexOf('cat "$h/vms/$vm/state.vzvmsave"') > script.indexOf("tart run --no-graphics --no-clipboard \"$vm\""), "not for a Linux VM, which Tart does not suspend");
});

test("the doctor judges each Tart image by the record beside it (049)", async () => {
  const { mac, context, make } = linuxSetup();
  const day = 24 * 60 * 60 * 1000;
  const [linuxPins, macosPins, app] = ["l", "m", "a"].map((letter) => letter.repeat(64));
  const images = { pins: async (set: string) => (set === "linux" ? linuxPins! : set === "macos" ? macosPins! : "x".repeat(64)), bbApp: async () => app! };
  const records = join(mac, ".bb-box", "tart", "images");
  const xcode = { xcode: "27.0", "ios-simulator": "27.0", metal: "32023.598" };
  writeFileSync(join(records, "bb-box-macos.json"), imageRecord("macos", { pins: macosPins, bbApp: app, tools: xcode }));
  writeFileSync(join(records, "bb-box-linux.json"), imageRecord("linux-arm64", { pins: "o".repeat(64), bbApp: null, built: new Date(Date.now() - 15 * day).toISOString() }));
  const backend = make({ ...context, images });
  let report = await backend.doctor();
  const check = (kind: string) => report.checks.find((candidate) => candidate.id === `image.mac1.${kind}`)!;
  for (const kind of ["macos", "macos-desktop"]) {
    assert.equal(check(kind).status, "ok", kind);
    assert.match(check(kind).detail, /^bb-box-macos, 4 cores and 8 GiB as prepared\. Standard image build\.20261003-021500, built \d+ \w+ \(today\): fake OS, xcode 27\.0, ios-simulator 27\.0, metal 32023\.598\.$/);
  }
  const linux = check("linux-arm64");
  assert.equal(linux.status, "warn");
  assert.match(linux.detail, /It is 15 days old, more than 14, .* It has no build of BB's app, .* It was built with other pins than this bb-box's/);
  assert.equal(linux.fix, "Build it again on mac1 with setup/tart/prepare-linux-image.sh --key '<bb-box's public key>' --name bb-box-linux --bb-url <BB's server URL> --replace.");

  // A macOS image without Xcode warns (#475).
  writeFileSync(join(records, "bb-box-macos.json"), imageRecord("macos", { pins: macosPins, bbApp: app }));
  report = await backend.doctor();
  assert.equal(check("macos").status, "warn");
  assert.match(check("macos").detail, /It has no Xcode, so its boxes have no XCTest, Metal compiler or iOS Simulator \(#475\)\.$/);

  rmSync(join(records, "bb-box-macos.json"));
  report = await backend.doctor();
  assert.equal(check("macos").status, "warn");
  assert.match(check("macos").detail, /^bb-box-macos, 4 cores and 8 GiB as prepared\. It has no image record/);
  assert.equal(check("macos").fix, "Build it again on mac1 with setup/tart/prepare-image.sh --key '<bb-box's public key>' --name bb-box-macos --bb-url <BB's server URL> --replace.");
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

test("a box has the cores and memory it asks for, read from its config, and its disk from the start, as tart get gives it; capacity refuses what a Mac cannot give", async () => {
  const { backend } = setup();
  const medium: BoxSize = { cores: 6, memoryMiB: 16384, diskGiB: null };
  const guest = await backend.acquire(identity("macos", "thr_abc123", medium), null, hooks().hooks, signal());
  assert.deepEqual(guest.size, { ...medium, diskGiB: 59 }, "64 GB, as tart list gives it, is 59 GiB, as a resize reads it");
  assert.deepEqual((await backend.held()).find((held) => held.ref === guest.ref)?.size, { ...medium, diskGiB: 59 }, "held reads it from the VM's config and tart list");
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

test("a refresh's base is pulled when the registry has moved its tag, room allowing, and the old cached copy goes after (#475)", () => {
  const dir = mkdtempSync(join(tmpdir(), "bb-box-base-"));
  const bin = join(dir, "bin");
  const cache = join(dir, "tart", "cache", "OCIs", "ghcr.io", "acme", "macos-xcode");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(cache, "sha256:old"), { recursive: true });
  symlinkSync(join(cache, "sha256:old"), join(cache, "27"));
  // The registry: a token challenge, then the manifest with the tag's digest and its disk's size.
  writeFileSync(
    join(bin, "curl"),
    [
      "#!/bin/sh",
      'case "$*" in',
      '  *"/v2/ "*|*"/v2/") printf \'HTTP/2 401\\r\\nwww-authenticate: Bearer realm="https://ghcr.io/token",service="ghcr.io"\\r\\n\\r\\n\' ;;',
      '  *token*) echo \'{"token":"anon"}\' ;;',
      '  *manifests*) while [ $# -gt 0 ]; do case $1 in -D) h=$2; shift 2 ;; -o) o=$2; shift 2 ;; *) shift ;; esac; done',
      '    printf \'HTTP/2 200\\r\\ndocker-content-digest: %s\\r\\n\' "$(cat "$DIGEST")" > "$h"',
      '    printf \'{"annotations":{"org.cirruslabs.tart.uncompressed-disk-size":"%s"}}\' "$SIZE" > "$o" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  // tart: a pull moves the tag to the new digest; a delete removes a digest's copy.
  writeFileSync(
    join(bin, "tart"),
    [
      "#!/bin/sh",
      'echo "$*" >> "$TART_HOME/calls"',
      `c=$TART_HOME/cache/OCIs/ghcr.io/acme/macos-xcode`,
      'case $1 in',
      '  pull) d=$(cat "$DIGEST"); mkdir -p "$c/$d"; ln -sfn "$c/$d" "$c/27" ;;',
      '  delete) rm -rf "$c/${2##*@}" ;;',
      "esac",
    ].join("\n"),
    { mode: 0o755 },
  );
  const digest = join(dir, "digest");
  const run = (body: string, size: string) =>
    spawnSync("sh", ["-c", body], { env: { PATH: `${bin}:/usr/bin:/bin`, HOME: dir, TART_HOME: join(dir, "tart"), DIGEST: digest, SIZE: size }, encoding: "utf8" });
  const calls = () => (existsSync(join(dir, "tart", "calls")) ? readFileSync(join(dir, "tart", "calls"), "utf8").trim().split("\n") : []);

  writeFileSync(digest, "sha256:old");
  assert.match(run(baseScript("ghcr.io/acme/macos-xcode:27", 60), "1000").stdout, /base: ghcr\.io\/acme\/macos-xcode:27 is current/);
  assert.deepEqual(calls(), []);

  // Moved, but its disk does not fit beyond the reserve.
  writeFileSync(digest, "sha256:new");
  const full = run(baseScript("ghcr.io/acme/macos-xcode:27", 60), String(1024 ** 5));
  assert.equal(full.status, 3);
  assert.match(full.stderr, /base: no room to pull ghcr\.io\/acme\/macos-xcode:27: its disk is 1048576 GiB, and -?\d+ GiB is free beyond the 60 GiB reserve\./);
  assert.deepEqual(calls(), []);

  const pulled = run(baseScript("ghcr.io/acme/macos-xcode:27", 0), "1000");
  assert.equal(pulled.status, 0, pulled.stderr);
  assert.match(pulled.stdout, /base: pulling ghcr\.io\/acme\/macos-xcode:27, sha256:new, in place of sha256:old\nbase: pulled/);
  assert.deepEqual(calls(), ["pull ghcr.io/acme/macos-xcode:27"]);

  // After the replace: the copy no tag names goes, the tag's stays.
  const pruned = run(pruneBaseScript("ghcr.io/acme/macos-xcode:27"), "0");
  assert.match(pruned.stdout, /base: removed the old cached ghcr\.io\/acme\/macos-xcode@sha256:old/);
  assert.deepEqual([existsSync(join(cache, "sha256:old")), existsSync(join(cache, "sha256:new"))], [false, true]);
  assert.match(run(baseScript("bb-box-macos", 60), "0").stdout, /base: bb-box-macos is a local VM/);
});

test("prepare-image.sh's boot waits while macOS's two VM slots are taken, saying so, and boots once one is free; with no slot in time it stops (#650)", async () => {
  const home = mkdtempSync(join(tmpdir(), "bbbox-slot-"));
  after(() => rmSync(home, { recursive: true, force: true }));
  fakeMacTools(home);
  addImage(home, "bb-box-macos-build");
  const source = readFileSync(new URL("../setup/tart/prepare-image.sh", import.meta.url), "utf8");
  const line = (pattern: RegExp) => source.match(pattern)![0];
  const start = source.indexOf("boot() {");
  const boot = source.slice(start, source.indexOf("\n}\n", start) + 2);
  const script = (minutes: number) =>
    ["set -eu", line(/^die\(\).*$/m), line(/^step\(\).*$/m), `SLOT_WAIT_MINUTES=${minutes}`, "SLOT_POLL_SECONDS=1", boot, "build=bb-box-macos-build; work=$(mktemp -d)", "boot", "echo booted", 'tart stop "$build"'].join("\n");
  const run = (minutes: number) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const child = spawn("/bin/sh", ["-c", script(minutes)], { env: { HOME: home, PATH: `${join(home, ".nix-profile", "bin")}:/usr/bin:/bin` } });
      let [out, err] = ["", ""];
      child.stdout.on("data", (data) => (out += data));
      child.stderr.on("data", (data) => (err += data));
      child.on("exit", (code) => resolve({ code, out, err }));
    });
  // Both slots are taken elsewhere: the boot waits, then boots once one is free.
  writeFileSync(join(home, ".fake-other-macos-vms"), "2");
  const waiting = run(1);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  rmSync(join(home, ".fake-other-macos-vms"));
  const booted = await waiting;
  assert.equal(booted.code, 0, booted.err);
  assert.match(booted.out, /no macOS VM slot is free for bb-box-macos-build \(The number of VMs exceeds the system limit \(other running VMs: another app's\)\): waiting for one, up to 1 more minutes\n/);
  assert.match(booted.out, /booted\n$/);
  // No slot within the time: it stops, saying why.
  writeFileSync(join(home, ".fake-other-macos-vms"), "2");
  const stopped = await run(0);
  assert.equal(stopped.code, 1);
  assert.match(stopped.err, /^prepare-image: no macOS VM slot was free for bb-box-macos-build within 0 minutes: The number of VMs exceeds the system limit/m);
});

test("a macOS VM resizes its CPUs and memory with a restart: shut down, not suspended, tart set and booted, and keeps its disk (061)", async () => {
  const { ssh, mac, backend } = setup();
  assert.deepEqual(backend.resizing("macos"), { cores: "restart", memory: "restart", disk: "no", shrinks: true });
  const guest = await backend.acquire(identity("macos", "thr_abc123", SMALL), null, hooks().hooks, signal());
  const to: BoxSize = { cores: 6, memoryMiB: 16384, diskGiB: null };

  const plan = await backend.planResize(guest, "macos", to, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: 4, to: 6, way: "restart" },
    { part: "memory", from: 8192, to: 16384, way: "restart" },
  ]);
  assert.equal(plan.downSeconds, 30);
  const disk = (await backend.planResize(guest, "macos", { ...to, diskGiB: 500 }, [], signal())).parts.find((part) => part.part === "disk");
  assert.equal(disk?.way, "no");
  await assert.rejects(backend.resize(guest, "macos", { ...to, diskGiB: 500 }, { restart: true }, signal()), /cannot grow a macOS VM's disk/);

  const before = tartCalls(mac).length;
  const resized = await backend.resize(guest, "macos", to, { restart: true }, signal());
  assert.deepEqual([resized.size?.cores, resized.size?.memoryMiB], [6, 16384]);
  const calls = tartCalls(mac).slice(before).filter((call) => call.includes(guest.ref));
  assert.deepEqual(
    calls.filter((call) => call[1] !== "get" && call[1] !== "ip"),
    [
      ["tart", "stop", guest.ref, "--timeout", "30"],
      ["tart", "set", guest.ref, "--cpu", "6", "--memory", "16384"],
      ["tart", "run", "--no-graphics", "--no-clipboard", "--vnc-experimental", "--suspendable", guest.ref],
    ],
    "stopped, not suspended, then sized and booted",
  );
  assert.ok(ssh.log().some((entry) => entry.command.includes("sudo -n shutdown -h now")), "macOS is asked to shut down first");
  assert.equal(existsSync(join(mac, ".tart", "vms", guest.ref, "state.vzvmsave")), false);
  assert.equal(await backend.power(guest, signal()), "running");
});

test("a Linux VM resizes with a restart: shut down, tart set, booted, and its root partition grown over a larger disk (061)", async () => {
  const { ssh, mac, backend } = linuxSetup();
  assert.deepEqual(backend.resizing("linux-arm64"), { cores: "restart", memory: "restart", disk: "restart", shrinks: true });
  assert.equal(backend.resizing("windows-arm64-desktop"), null, "a kind this backend does not offer");
  const guest = await backend.acquire(identity("linux-arm64", "thr_abc123", LINUX_SMALL), null, hooks().hooks, signal());
  // The disk tools, as the VM would have them; sudo logs the command.
  const home = ssh.home(guest.address!);
  mkdirSync(join(home, "bin"), { recursive: true });
  for (const [name, body] of Object.entries({ findmnt: "echo /dev/vda1", lsblk: "echo vda", sudo: `echo "$*" >> "$HOME/sudo.log"` })) {
    writeFileSync(join(home, "bin", name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(home, "bin", name), 0o755);
  }
  const from = { ...LINUX_SMALL, diskGiB: 59 };
  const to = { cores: 4, memoryMiB: 8192, diskGiB: 70 };

  const plan = await backend.planResize(guest, "linux-arm64", to, [], signal());
  assert.deepEqual(plan.parts, [
    { part: "cores", from: from.cores, to: 4, way: "restart" },
    { part: "memory", from: from.memoryMiB, to: 8192, way: "restart" },
    { part: "disk", from: 59, to: 70, way: "restart" },
  ]);
  assert.equal(plan.downSeconds, 20);
  assert.equal(plan.room.ok, true);
  assert.equal((await backend.planResize(guest, "linux-arm64", { ...to, cores: 64 }, [], signal())).room.message, "mac1 has 16 cores, fewer than the 64 asked for. Ask for at most 16 cores.");
  await assert.rejects(backend.planResize(guest, "linux-arm64", { ...to, diskGiB: 40 }, [], signal()), /disk only grows, and this one's is 59 GiB/);
  await assert.rejects(backend.resize(guest, "linux-arm64", to, { restart: false }, signal()), /only with a restart/);

  const resized = await backend.resize(guest, "linux-arm64", to, { restart: true }, signal());
  assert.deepEqual(resized.size, to, "70 GiB is 76 GB to Tart, and back");
  const sets = tartCalls(mac).filter((call) => call[1] === "set" && call[2] === guest.ref);
  assert.deepEqual(sets.at(-1), ["tart", "set", guest.ref, "--cpu", "4", "--memory", "8192", "--disk-size", "76"]);
  assert.equal(await backend.power(guest, signal()), "running");
  assert.match(readFileSync(join(home, "sudo.log"), "utf8"), /^growpart \/dev\/vda \S*\nresize2fs \/dev\/vda1\n$/);

  // A stopped VM is resized once it runs.
  await backend.stop(guest);
  await assert.rejects(backend.planResize(guest, "linux-arm64", to, [], signal()), /start it first/);
});
