import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { DEVICE_HOST_EXITS, HELD_PORTS, parseHostStatus, slotDaemonKeptByHost } from "../src/backends/tart/device-host.ts";
import { MAKING_STEPS, RESETTING_STEPS, slotPorts, slotUid, slotUser, type SlotName } from "../src/core/device-host.ts";
import type { CommandTransport, RunOptions } from "../src/transports/types.ts";
import { fakeDeviceHost, LIST, RUNTIME, type FakeDeviceHost } from "./fake-device-host.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxKeyForTests box";
const EXIT = DEVICE_HOST_EXITS;
const CLAIM = (box = "box_a", kind = "ios", install = "inst_a") => `install=${install}\nbox=${box}\nthread=thr_a\nname=ios-box\nkind=${kind}\ncreated=1790000000000\nkey=${KEY}\n`;
const BOX = (box = "box_a", install = "inst_a") => `install=${install}\nbox=${box}\n`;
const HOST = "/var/db/bb-box/host";
const HOST_DAEMONS = ["app.bb-box.device-host", "app.bb-box.device-host.ports"];

function quiet(settings = ""): FakeDeviceHost {
  const host = fakeDeviceHost();
  const init = host.run(["init"], `ahead=0\n${settings}`);
  assert.equal(init.status, 0, init.stderr);
  return host;
}

function slotDaemons(host: FakeDeviceHost): string[] {
  return host.daemons().filter((label) => !HOST_DAEMONS.includes(label));
}

function count(host: FakeDeviceHost, call: string): number {
  return host.calls().filter((line) => line.startsWith(call)).length;
}

function made(host: FakeDeviceHost, input = "install=inst_a\n"): Map<string, string> {
  const result = host.run(["make"], input);
  assert.equal(result.status, 0, result.stderr);
  return new Map(result.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

const SLOT_KEYBOARD_DEFAULTS = [
  "com.apple.keyboard.preferences KeyboardAutocorrection -bool NO",
  "com.apple.keyboard.preferences KeyboardPeriodShortcut -bool NO",
  "com.apple.keyboard.preferences SmartTyping -bool NO",
  "com.apple.keyboard.predictive KeyboardPrediction -bool NO",
  "com.apple.keyboard.predictive KeyboardInlineCompletion -bool NO",
  "com.apple.keyboard.ContinuousPath KeyboardContinuousPathEnabled -bool NO",
  "com.apple.Preferences DidShowContinuousPathIntroduction -bool YES",
];

function keyboardDefaultsInFiles(host: FakeDeviceHost, user: string, udid: string): string[] {
  const preferences = join(host.root, "Users", user, "Library/Developer/CoreSimulator/Devices", udid, "data/Library/Preferences");
  if (!existsSync(preferences)) return [];
  const written: string[] = [];
  for (const file of readdirSync(preferences).sort()) {
    for (const [, key, value] of readFileSync(join(preferences, file), "utf8").matchAll(/<key>(\w+)<\/key><bool>(\w+)<\/bool>/g)) written.push(`${file.replace(/\.plist$/, "")} ${key} -bool ${value}`);
  }
  return written.sort();
}

function keyboardDefaultsWritten(host: FakeDeviceHost, user: string, udid: string): string[] {
  const written = join(host.state, "sims", user, `.${udid}.defaults`);
  return existsSync(written) ? readFileSync(written, "utf8").trim().split("\n") : [];
}

function answer(stdout: string): Map<string, string> {
  return new Map(stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function ownedByTheSlot(host: FakeDeviceHost, folder: string, ...paths: string[]): void {
  host.own(folder, 80001);
  for (const path of paths) host.own(`${folder}/${path}`, 80001);
}

function helperEnv(host: FakeDeviceHost): Record<string, string> {
  const bin = join(host.root, "../bin");
  return { FAKE_MAC_STATE: host.state, FAKE_MAC_ROOT: host.root, FAKE_MAC_BIN: bin, FAKE_MACOS_BIN: join(host.root, "../macos-bin"), PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" };
}

function tune(host: FakeDeviceHost, name: string, value: string): void {
  const helper = join(host.root, "../host/device-host");
  const text = readFileSync(helper, "utf8");
  const line = new RegExp(`^${name}=.*$`, "m");
  assert.match(text, line);
  writeFileSync(helper, text.replace(line, `${name}=${value}`));
}

function internal(host: FakeDeviceHost, args: readonly string[]): { status: number | null; stdout: string; stderr: string } {
  const text = readFileSync(join(host.root, "../host/device-host"), "utf8");
  const dispatch = "\ncase $verb in\n";
  assert.equal(text.split(dispatch).length, 2);
  const copy = join(host.root, "../host/device-host-internal");
  writeFileSync(copy, text.replace(dispatch, `\n"$verb" "$@"\nexit $?${dispatch}`), { mode: 0o755 });
  const result = spawnSync("/bin/sh", [copy, ...args], { encoding: "utf8", env: helperEnv(host), timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function setSetting(host: FakeDeviceHost, key: string, value: string): void {
  const settings = join(host.root, HOST, "settings");
  const text = readFileSync(settings, "utf8");
  const line = new RegExp(`^${key}=.*$`, "m");
  assert.match(text, line);
  writeFileSync(settings, text.replace(line, `${key}=${value}`));
}

function lockHeld(path: string): boolean {
  return spawnSync("flock", ["-n", path, "true"]).status === 1;
}

function sleeper(): number {
  return Number(spawnSync("/bin/sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" }).stdout.trim());
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function installerLeftBy(host: FakeDeviceHost): { data: string; pid: number } {
  const data = join(host.root, "Users/bbd-1/.bb-machines/bb.example.test");
  mkdirSync(data, { recursive: true });
  const pid = sleeper();
  writeFileSync(join(data, "install-daemon.pid"), `${pid}\n`);
  writeFileSync(join(data, "host-daemon-port"), "38889\n");
  ownedByTheSlot(host, "/Users/bbd-1/.bb-machines", "bb.example.test", "bb.example.test/install-daemon.pid", "bb.example.test/host-daemon-port");
  host.add("processes", `${pid} 80001 node 1`);
  writeFileSync(join(host.state, "commands", String(pid)), "/Users/bbd-1/.bb-machines/bb.example.test/npm/bin/bb-app host-daemon --supervise --host-daemon-port 38889\n");
  return { data, pid };
}

async function swept(host: FakeDeviceHost): Promise<void> {
  await host.until("the sweep queue emptied", () => host.status().values.get("sweeping") === "0");
}

test("init keeps the settings the host was made with, and status gives them with the host's size", () => {
  const host = fakeDeviceHost();
  const first = host.run(["init"], "most=6\nahead=2\n");
  assert.deepEqual(first, { status: 0, stdout: "most=6\nahead=2\nresetting-most=4\ndisk-reserve-gib=10\n", stderr: "" });
  assert.equal(host.run(["init"], "most=12\n").stdout, first.stdout, "a snapshot: a later setting is for hosts made after it");
  const { values, slots } = host.status();
  assert.deepEqual(
    ["helper", "deleting", "most", "ahead", "generation", "cores", "memory", "disk", "memory_free", "runtime", "model", "counted", "sweeping"].map((key) => values.get(key)),
    ["7", "", "6", "2", "0", "8", "16384", "100", "60", RUNTIME, "iPhone 18 Pro", "0", "0"],
  );
  assert.deepEqual(slots, []);
  assert.deepEqual(host.run(["init"], "most=many\n").status, 0, "settings are written once");
  assert.equal(fakeDeviceHost().run(["init"], "most=many\n").status, 2);
  assert.match(fakeDeviceHost().run(["init"], "colour=blue\n").stderr, /^Unknown input: colour\.\n$/);
});

function hostUsersApp(host: FakeDeviceHost, digest: string): string {
  const npm = join(host.root, "Users/admin/.bb-machines/bb.example.com/npm");
  mkdirSync(join(npm, "lib/node_modules/bb-app/bin"), { recursive: true, mode: 0o755 });
  mkdirSync(join(npm, "bin"), { recursive: true, mode: 0o755 });
  writeFileSync(join(npm, "lib/node_modules/bb-app/package.json"), '{"name":"bb-app"}\n', { mode: 0o644 });
  writeFileSync(join(npm, "lib/node_modules/bb-app/bin/bb.js"), "#!/usr/bin/env node\n", { mode: 0o755 });
  symlinkSync("../lib/node_modules/bb-app/bin/bb.js", join(npm, "bin/bb"));
  writeFileSync(join(npm, "../host-artifact.sha256"), `${digest}\n`, { mode: 0o600 });
  writeFileSync(join(npm, "../auth.json"), "{}\n", { mode: 0o600 });
  host.own("/Users/admin", 501);
  host.own("/Users/admin/.bb-machines/bb.example.com/npm", 501);
  return npm;
}

const KEEP = (digest: string) => `server=bb.example.com\ndigest=${digest}\nfrom=/Users/admin\n`;

test("keep-app copies the host's own BB app into the slots' home and every ready slot no box has claimed, only when it is the server's build; a stale build is removed, so slots download it (F-8)", () => {
  const host = quiet();
  const digest = "c".repeat(64);
  hostUsersApp(host, digest);
  made(host);
  made(host);
  assert.equal(host.run(["claim", "2"], CLAIM("box_b")).status, 0);
  const kept = host.run(["keep-app"], KEEP(digest));
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /^refreshed=1\nkept=yes\n$/);
  const slots = "/usr/local/share/bb-box/slot-home/.bb-machines/bb.example.com";
  assert.equal(host.file(`${slots}/host-artifact.sha256`), `${digest}\n`);
  assert.equal(host.file(`${slots}/npm/lib/node_modules/bb-app/package.json`), '{"name":"bb-app"}\n');
  assert.equal(readlinkSync(join(host.root, slots, "npm/bin/bb")), "../lib/node_modules/bb-app/bin/bb.js", "a link inside the app is copied as a link");
  assert.equal(host.file(`${slots}/auth.json`), null, "nothing of the host user's own machine");
  assert.equal(host.file("/Users/bbd-1/.bb-machines/bb.example.com/host-artifact.sha256"), `${digest}\n`, "the ready slot has it");
  assert.ok(host.lines("owners").includes(`80001 ${host.data}/Users/bbd-1/.bb-machines/bb.example.com/host-artifact.sha256`), "owned by the slot's user");
  assert.ok(!existsSync(join(host.root, "Users/bbd-2/.bb-machines/bb.example.com")), "the claimed slot is not touched");
  assert.equal(host.status().values.get("bb-app"), digest);
  assert.equal(host.status().values.get("bb-app-kept"), "yes");
  made(host);
  assert.equal(host.file("/Users/bbd-3/.bb-machines/bb.example.com/host-artifact.sha256"), `${digest}\n`, "a slot made after has it");

  const stale = host.run(["keep-app"], KEEP("d".repeat(64)));
  assert.equal(stale.status, 0, stale.stderr);
  assert.match(stale.stdout, /kept=no\nwhy=BB's app in \/Users\/admin is another build than d{64}\n$/);
  assert.ok(!existsSync(join(host.root, "usr/local/share/bb-box/slot-home/.bb-machines")), "the slots' home keeps no stale app");
  assert.ok(!existsSync(join(host.root, "Users/bbd-1/.bb-machines/bb.example.com")), "nor the ready slot");
  assert.equal(host.status().values.get("bb-app-kept"), "no");
  made(host);
  assert.ok(!existsSync(join(host.root, "Users/bbd-4/.bb-machines")), "a new slot downloads it");
});

test("keep-app takes a copy whose files keep the host user's UID and whose folders and links are root's, as a clone made as root is, then makes all of it root's, links too (F-9)", () => {
  const host = quiet();
  const digest = "c".repeat(64);
  hostUsersApp(host, digest);
  const kept = host.run(["keep-app"], KEEP(digest));
  assert.equal(kept.status, 0, kept.stderr);
  assert.match(kept.stdout, /kept=yes\n$/);
  const staging = host.lines("calls").find((call) => /^chown -R -h 0:0 \S*\/bb-app-staging\.\d+$/.test(call));
  assert.ok(staging, host.lines("calls").filter((call) => call.startsWith("chown")).join("\n"));
  const link = `${host.data}/usr/local/share/bb-box/slot-home/.bb-machines/bb.example.com/npm/bin/bb`;
  assert.ok(host.lines("owners").some((line) => line.startsWith("0 ") && line.endsWith(`/bb-app-staging.${staging.split(".").pop()}/bb.example.com/npm/bin/bb`)), "the link itself is root's");
  assert.equal(readlinkSync(link), "../lib/node_modules/bb-app/bin/bb.js");
});

test("keep-app copies no link that is absolute or leaves the app, nothing writable by others, and nothing from a slot's home (F-8)", () => {
  const cases: [string, (npm: string) => void, RegExp][] = [
    ["an absolute link", (npm) => symlinkSync("/etc/sudoers", join(npm, "lib/node_modules/bb-app/sudoers")), /links to an absolute path/],
    ["a link out of the app", (npm) => symlinkSync("../../../../../../private/etc/sudoers", join(npm, "lib/node_modules/bb-app/sudoers")), /links outside/],
    ["a file others can write", (npm) => chmodSync(join(npm, "lib/node_modules/bb-app/package.json"), 0o666), /writable by its group or others/],
  ];
  for (const [what, spoil, why] of cases) {
    const host = quiet();
    const digest = "c".repeat(64);
    spoil(hostUsersApp(host, digest));
    const kept = host.run(["keep-app"], KEEP(digest));
    assert.equal(kept.status, 0, kept.stderr);
    assert.match(kept.stdout, /^kept=no\n/, what);
    assert.match(kept.stdout, why, what);
    assert.ok(!existsSync(join(host.root, "usr/local/share/bb-box/slot-home/.bb-machines")), what);
  }
  const host = quiet();
  assert.equal(host.run(["keep-app"], "server=bb.example.com\ndigest=" + "c".repeat(64) + "\nfrom=/Users/bbd-1\n").status, 2);
  assert.equal(host.run(["keep-app"], "server=../x\ndigest=" + "c".repeat(64) + "\nfrom=/Users/admin\n").status, 2);
});

test("make gives a slot's home the BB app the slots' home keeps, owned by the slot's user, so its enrolment skips the download (F-7)", () => {
  const host = fakeDeviceHost();
  const kept = join(host.data, "usr/local/share/bb-box/slot-home/.bb-machines/bb.example.com");
  mkdirSync(join(kept, "npm/lib/node_modules/bb-app"), { recursive: true });
  writeFileSync(join(kept, "npm/lib/node_modules/bb-app/package.json"), '{"name":"bb-app"}\n');
  writeFileSync(join(kept, "host-artifact.sha256"), `${"b".repeat(64)}\n`);
  made(host);
  assert.equal(host.file("/Users/bbd-1/.bb-machines/bb.example.com/host-artifact.sha256"), `${"b".repeat(64)}\n`);
  assert.equal(host.file("/Users/bbd-1/.bb-machines/bb.example.com/npm/lib/node_modules/bb-app/package.json"), '{"name":"bb-app"}\n');
  assert.ok(host.lines("owners").includes(`80001 ${host.data}/Users/bbd-1/.bb-machines/bb.example.com/host-artifact.sha256`), "the slot's user owns it");
  assert.match(host.file("/Users/bbd-1/.zshenv")!, /export BB_PORT_BASE=20000/);
});

test("make adds a slot as a new user with its own seeded device booted and its device server's daemon loaded", () => {
  const host = fakeDeviceHost();
  const slot = made(host);
  assert.deepEqual(
    ["slot", "user", "uid", "home", "model", "ports", "port_count"].map((key) => slot.get(key)),
    ["1", "bbd-1", "80001", "/Users/bbd-1", "iPhone 18 Pro", "20000", "100"],
  );
  assert.match(slot.get("took") ?? "", /^user \d+\.\d,device \d+\.\d,first-boot \d+\.\d,daemons \d+\.\d$/);

  const user = host.user("bbd-1")!;
  assert.deepEqual([user.UniqueID, user.IsHidden, user.RealName, user.NFSHomeDirectory], ["80001", "1", "bb-box bbd-1", "/Users/bbd-1"]);
  assert.deepEqual([host.members("_developer"), host.members("com.apple.access_ssh")], [["bbd-1"], ["bbd-1"]]);
  assert.ok(!host.members("admin").includes("bbd-1"), "a standard user, never admin");
  const home = join(host.root, "Users/bbd-1");
  assert.equal(statSync(home).mode & 0o777, 0o700);
  const zshenv = host.file("/Users/bbd-1/.zshenv")!;
  assert.match(zshenv, /path_helper/, "the pool's login PATH");
  assert.ok(zshenv.endsWith("export BB_PORT_BASE=20000 BB_PORT_COUNT=100\n"));
  assert.equal(host.file("/Users/bbd-1/.bb-box/ports"), "base=20000\ncount=100\n");
  assert.equal(host.file("/Users/bbd-1/.bb-box/device/host-managed"), "1\n");
  assert.ok(host.lines("owners").includes(`80001 ${host.data}/Users/bbd-1/.zshenv`), "the home is the user's");

  const devices = Object.entries(host.devices("bbd-1"));
  assert.equal(devices.length, 1, "CoreSimulator's default devices deleted");
  const [udid, device] = devices[0]!;
  assert.equal(slot.get("udid"), udid);
  assert.deepEqual(device, { name: "iPhone 18 Pro", type: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: RUNTIME, state: "Booted" });
  const store = `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${udid}`;
  assert.equal(host.file(`${store}/disabled.plist`), "bplist00 the image's 124 disabled labels\n", `seeded from ${LIST}.disabled.plist`);
  assert.equal(statSync(join(host.root, store)).mode & 0o777, 0o700);
  assert.ok(host.lines("owners").includes(`80001 ${host.data}${store}/disabled.plist`));
  const create = host.calls().findIndex((line) => line.startsWith("xcrun simctl create"));
  const boot = host.calls().findIndex((line) => line.startsWith("xcrun simctl boot"));
  const seedCopy = host.lines("owners").findIndex((line) => line.endsWith(`${store}/disabled.plist`));
  assert.ok(create >= 0 && boot > create && seedCopy >= 0, "made, then seeded, then booted");

  assert.deepEqual(host.daemons(), ["app.bb-box.device.bbd-1"]);
  const plist = host.file("/Library/LaunchDaemons/app.bb-box.device.bbd-1.plist")!;
  assert.match(plist, /<key>UserName<\/key><string>bbd-1<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key><true\/>/);
  assert.match(plist, /<key>ThrottleInterval<\/key><integer>1<\/integer>/);
  assert.match(plist, /<key>BB_PORT_BASE<\/key><string>20000<\/string>/);
  assert.match(plist, /until \[ -f "\$d\/current\/src\/device\/bb-box-device\.sh" \] &amp;&amp; \[ -f "\$d\/devices\.json" \]; do sleep 1; done; exec \/bin\/sh "\$d\/current\/src\/device\/bb-box-device\.sh" serve/);

  const status = host.slot("1")!;
  assert.deepEqual([status.is, status.user, status.uid, status.carried, status.ports, status.booted, status.loaded, status.udid], ["ready", "bbd-1", 80001, false, 20000, true, true, udid]);
  assert.equal(host.status().values.get("counted"), "1");

  const second = made(host);
  assert.deepEqual([second.get("slot"), second.get("uid"), second.get("ports")], ["2", "80002", "20100"], "the next generation, at the next free place");
});

test("make copies a device server into the slot when asked, so a ready slot's server runs before any claim", () => {
  const host = fakeDeviceHost();
  const from = join(host.root, "Users/person/.bb-box/device");
  mkdirSync(join(from, "server/19/src/device"), { recursive: true });
  writeFileSync(join(from, "server/19/src/device/bb-box-device.sh"), "#!/bin/sh\n");
  writeFileSync(join(from, "devices.json"), "{}\n");
  writeFileSync(join(from, "choices.json"), '{"slim":true}\n');
  symlinkSync("server/19", join(from, "current"));
  {
    made(host, "install=inst_a\nserver=/Users/person/.bb-box/device\n");
    const device = "/Users/bbd-1/.bb-box/device";
    assert.equal(host.file(`${device}/server/19/src/device/bb-box-device.sh`), "#!/bin/sh\n");
    assert.equal(host.file(`${device}/devices.json`), "{}\n");
    assert.equal(host.file(`${device}/choices.json`), '{"slim":true}\n');
    assert.ok(host.lines("owners").includes(`80001 ${host.data}${device}/devices.json`));
    const relative = host.run(["make"], "server=Users/person\n");
    assert.equal(relative.status, 1);
    assert.match(relative.stderr, /server= must be an absolute path to a device server's folder\./);
  }
});

test("make refuses with words while the host is being deleted, full, short of disk or short of memory", () => {
  const host = fakeDeviceHost();
  host.run(["init"], "most=2\n");
  made(host);
  made(host);
  assert.deepEqual(host.run(["make"]), { status: EXIT.full, stdout: "", stderr: "This host has all its 2 slots making, ready, held or promised.\n" });

  const disk = fakeDeviceHost();
  disk.flag("disk-free-kib", true, String(8 * 1048576));
  assert.deepEqual(disk.run(["make"]), { status: EXIT.full, stdout: "", stderr: "This host has 8 GiB of disk free, under the 10 GiB it keeps, so it makes no new slot.\n" });
  const memory = fakeDeviceHost();
  memory.flag("memory-free", true, "12");
  assert.deepEqual(memory.run(["make"]), { status: EXIT.full, stdout: "", stderr: "This host has 12% of its memory free, under 15%, so it makes no new slot.\n" });

  const gone = fakeDeviceHost();
  mkdirSync(join(gone.root, HOST), { recursive: true });
  writeFileSync(join(gone.root, HOST, "deleting"), "since=1\n");
  assert.deepEqual(gone.run(["make"]), { status: EXIT.deleting, stdout: "", stderr: "This host is being deleted; ask again.\n" });
  assert.equal(count(gone, "sysadminctl"), 0);
});

test("a make cut short carries on from its recorded step, and a step that fails twice removes the slot", async () => {
  const host = fakeDeviceHost();
  host.flag("simctl-create-fails");
  const cut = host.run(["make"], "install=inst_a\nbox=box_a\n");
  assert.equal(cut.status, 1);
  assert.equal(cut.stderr, "Making slot 1 failed at its device step: simctl did not make a iPhone 18 Pro on com.apple.CoreSimulator.SimRuntime.iOS-27-0 for bbd-1. Run it again to carry on from there.\n");
  assert.deepEqual([host.slot("1")?.is, host.slot("1")?.step, host.slot("1")?.for], ["making", "device", "box_a"]);
  host.flag("simctl-create-fails", false);
  const carried = host.run(["continue", "1"]);
  assert.deepEqual([carried.status, carried.stdout], [0, "slot=1\nis=ready\n"], carried.stderr);
  assert.equal(count(host, "sysadminctl -addUser"), 1, "the user made before the cut is kept");

  const twice = fakeDeviceHost();
  twice.flag("boot-fails", true, "5");
  assert.equal(twice.run(["make"]).status, 1);
  const again = twice.run(["continue", "1"]);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /^Making slot 1 failed at its first-boot step 2 times, so the slot is removed: simctl did not boot bbd-1's device /);
  assert.equal(twice.user("bbd-1"), null);
  assert.equal(existsSync(join(twice.root, "Users/bbd-1")), false);
  assert.deepEqual(twice.daemons(), []);
  await swept(twice);
  assert.deepEqual(twice.status().slots, [], "removed once swept");
});

test("a slot's first boot writes the image's keyboard defaults on its device, slide to type's tip seen among them, once (F-23)", () => {
  const host = fakeDeviceHost();
  const slot = made(host);
  const udid = slot.get("udid")!;
  assert.deepEqual(keyboardDefaultsWritten(host, "bbd-1", udid), SLOT_KEYBOARD_DEFAULTS);
  assert.ok(host.file(`${HOST}/slots/1/keyboard-defaults`) !== null, "the slot keeps that they are written");
  assert.equal(internal(host, ["write_keyboard_defaults", "1"]).status, 0);
  assert.deepEqual(keyboardDefaultsWritten(host, "bbd-1", udid), SLOT_KEYBOARD_DEFAULTS, "a later boot does not write them again");
});

test("a carried slot made before F-23 gets the keyboard defaults at its claim, in its shut-down device's files, or at its warm-up (F-23)", async () => {
  const host = fakeDeviceHost();
  assert.equal(host.run(["carry"]).status, 0);
  for (const id of ["i1", "i2"] as const) {
    const udid = host.slot(id)!.udid;
    assert.deepEqual(keyboardDefaultsWritten(host, `bbd-${id}`, udid), SLOT_KEYBOARD_DEFAULTS, `carried slot ${id}`);
    rmSync(join(host.root, HOST, "slots", id, "keyboard-defaults"));
    rmSync(join(host.state, "sims", `bbd-${id}`, `.${udid}.defaults`));
  }
  const first = host.slot("i1")!;
  assert.equal(first.booted, false, "a carried slot's device is shut down until a box or a warm-up boots it");
  assert.equal(host.run(["claim", "i1"], CLAIM()).status, 0);
  assert.deepEqual(keyboardDefaultsInFiles(host, "bbd-i1", first.udid), [...SLOT_KEYBOARD_DEFAULTS].sort(), "written in the device's own files, before its device server boots it");
  assert.deepEqual(keyboardDefaultsWritten(host, "bbd-i1", first.udid), [], "not through the device, which is not booted");
  assert.ok(host.file(`${HOST}/slots/i1/keyboard-defaults`) !== null);
  await host.until("bbd-i2 warmed", () => host.slot("i2")?.loaded === true && host.slot("i2")?.booted === true);
  assert.deepEqual(keyboardDefaultsWritten(host, "bbd-i2", host.slot("i2")!.udid), SLOT_KEYBOARD_DEFAULTS);
  assert.ok(host.file(`${HOST}/slots/i2/keyboard-defaults`) !== null);
});

test("carry makes the image's two slots, each seeded and first booted, then shut down, with daemons written but not loaded", () => {
  const host = fakeDeviceHost();
  assert.equal(host.run(["install"]).status, 0, "as the image's build does, with no init");
  const carry = host.run(["carry"]);
  assert.equal(carry.status, 0, carry.stderr);
  const lines = carry.stdout.trim().split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0]!, /^carried=i1 bbd-i1 79991 [0-9A-F-]{36} user \d+\.\d,device \d+\.\d,first-boot \d+\.\d,daemons \d+\.\d$/);
  assert.match(lines[1]!, /^carried=i2 bbd-i2 79992 /);
  for (const [id, uid, ports] of [["i1", 79991, 20000], ["i2", 79992, 20100]] as const) {
    const slot = host.slot(id)!;
    assert.deepEqual([slot.is, slot.uid, slot.carried, slot.ports, slot.booted, slot.loaded], ["ready", uid, true, ports, false, false]);
    const [device] = Object.values(host.devices(`bbd-${id}`));
    assert.equal(device?.state, "Shutdown");
    assert.ok(host.file(`/var/db/bb-box/host/slots/${id}/daemons/app.bb-box.device.bbd-${id}.plist`));
  }
  assert.deepEqual(host.daemons(), [], "nothing boots in the image, and nothing holds the ports");
  assert.equal(host.run(["init"], "ahead=0\n").status, 0);
  assert.deepEqual(host.daemons(), HOST_DAEMONS, "a host's start loads the host's daemons and no slot's");
  assert.equal(host.run(["carry"]).status, 0, "run again, it keeps them");
  assert.equal(count(host, "sysadminctl -addUser"), 2);
  assert.equal(host.run(["claim", "i1"], CLAIM()).status, 0);
  assert.equal(host.run(["claim", "i2"], CLAIM("box_b")).status, 0);
  assert.equal(host.run(["release", "i1"], BOX()).stdout, "released=yes\nlast=no\n");
  assert.equal(host.run(["carry"]).status, 0);
  assert.equal(count(host, "sysadminctl -addUser bbd-i1 "), 1, "a carried slot is made once in a host's life: its UID is never given again");
  rmSync(join(host.root, HOST, "carried"));
  assert.equal(host.run(["carry"]).status, 0);
  assert.deepEqual([host.slot("i2")?.is, count(host, "sysadminctl -addUser bbd-i2 ")], ["held", 1], "a host that kept no record of its carried slots keeps the ones it has");
  assert.deepEqual(made(host).get("uid"), "80001", "the first slot made in a running host is bbd-1");
});

test("a claim lends a ready slot once, with the box's key; a carried slot loads its daemons and warms the other", async () => {
  const host = fakeDeviceHost();
  assert.equal(host.run(["carry"]).status, 0);
  const claim = host.run(["claim", "i1"], CLAIM());
  assert.equal(claim.status, 0, claim.stderr);
  const lent = answer(claim.stdout);
  assert.deepEqual(["slot", "user", "uid", "home", "ports"].map((key) => lent.get(key)), ["i1", "bbd-i1", "79991", "/Users/bbd-i1", "20000"]);
  assert.equal(host.file("/Users/bbd-i1/.ssh/authorized_keys"), `${KEY}\n`);
  assert.equal(statSync(join(host.root, "Users/bbd-i1/.ssh/authorized_keys")).mode & 0o777, 0o600);
  assert.ok(host.lines("owners").includes(`79991 ${host.data}/Users/bbd-i1/.ssh/authorized_keys`));
  assert.match(host.file(`${HOST}/slots/i1/claim`)!, /^install=inst_a\nbox=box_a\nthread=thr_a\nname=ios-box\nkind=ios\ncreated=1790000000000\nclaimed=\d+\n$/);
  assert.ok(host.daemons().includes("app.bb-box.device.bbd-i1"));
  const held = host.slot("i1")!;
  assert.deepEqual([held.is, held.box], ["held", "box_a"]);
  await host.until("bbd-i2 warmed", () => host.slot("i2")?.loaded === true && host.slot("i2")?.booted === true);
  assert.equal(count(host, "sysadminctl -addUser"), 2, "the warmed carried slot is the one kept ahead");

  assert.deepEqual(host.run(["claim", "i1"], CLAIM("box_b")), { status: EXIT.notReady, stdout: "", stderr: "Slot i1 is held, not ready.\n" });
  assert.deepEqual(host.run(["claim", "9"], CLAIM("box_b")), { status: EXIT.lost, stdout: "", stderr: "This host has no slot 9; ask again.\n" });
  assert.equal(host.run(["claim", "i2"], `install=inst_a\nbox=box_b\n`).status, 2, "no key");
  assert.equal(host.run(["claim", "i2"], CLAIM("box b")).status, 2);
  assert.equal(host.run(["claim", "i2"], CLAIM("box_b", "android")).status, 2);
  assert.equal(host.run(["claim", "bogus"], CLAIM()).status, 2);

  const second = host.run(["claim", "i2"], CLAIM("box_b"));
  assert.equal(second.status, 0, second.stderr);
  await host.until("a slot made ahead once both carried slots are held", () => host.slot("1")?.is === "ready");
  assert.equal(host.slot("1")?.ports, 20200);
});

test("two claims of one slot at once: one wins, the other is told to ask again", async () => {
  const host = fakeDeviceHost();
  made(host);
  const claims = await Promise.all(
    ["box_a", "box_b", "box_c"].map(
      (box) =>
        new Promise<number>((resolve) => {
          const child = spawn("/bin/sh", [join(host.root, "../host/device-host"), "claim", "1"], { env: { ...process.env, FAKE_MAC_STATE: host.state, FAKE_MAC_ROOT: host.root, FAKE_MAC_BIN: join(host.root, "../bin"), FAKE_MACOS_BIN: join(host.root, "../macos-bin"), PATH: `${join(host.root, "../bin")}:/usr/bin:/bin` } });
          child.stdin.end(CLAIM(box));
          child.on("exit", (code) => resolve(code ?? -1));
        }),
    ),
  );
  assert.deepEqual(claims.filter((code) => code === 0).length, 1, `exits ${claims.join(", ")}`);
  assert.ok(claims.every((code) => code === 0 || code === EXIT.notReady || code === EXIT.lost));
});

test("a claim for a macos box deletes the slot's device and its server's daemon", () => {
  const host = quiet();
  made(host);
  const claim = host.run(["claim", "1"], CLAIM("box_m", "macos"));
  assert.equal(claim.status, 0, claim.stderr);
  assert.deepEqual(host.devices("bbd-1"), {});
  assert.deepEqual(slotDaemons(host), []);
  assert.equal(answer(claim.stdout).get("udid"), "");
});

test("a macos box's slot is removed at its release, never lent again, and the next ios claim gets a new slot with a device of its own (064, unit 8)", async () => {
  const host = quiet();
  made(host);
  made(host);
  made(host);
  assert.equal(host.run(["claim", "3"], CLAIM("box_k")).status, 0, "another box keeps the host");
  assert.equal(host.run(["claim", "1"], CLAIM("box_m", "macos")).status, 0);
  assert.match(host.status().lines.find((line) => line.startsWith("claim=1\t")) ?? "", /^claim=1\tinst_a\tbox_m\tthr_a\tios-box\tmacos\t/);
  assert.deepEqual(host.devices("bbd-1"), {});
  assert.deepEqual(host.run(["release", "1"], BOX("box_m")), { status: 0, stdout: "released=yes\nlast=no\n", stderr: "" });
  assert.equal(host.user("bbd-1"), null, "its user is removed with the release");
  assert.deepEqual(host.run(["claim", "1"], CLAIM("box_i")), { status: EXIT.notReady, stdout: "", stderr: "Slot 1 is resetting, not ready.\n" }, "slot 1 is not lent again");
  const next = host.run(["claim", "2"], CLAIM("box_i"));
  assert.equal(next.status, 0, next.stderr);
  const lent = answer(next.stdout);
  assert.equal(lent.get("slot"), "2");
  assert.notEqual(lent.get("udid"), "", "the ios box's slot has its device");
  assert.deepEqual(Object.keys(host.devices("bbd-2")), [lent.get("udid")]);
  await swept(host);
  assert.deepEqual(host.status().slots.map((slot) => slot.id), ["2", "3"]);
});

test("a release removes the box's user with its home, processes, daemons and crontab, answers within its steps, and queues the sweep", async () => {
  const host = quiet();
  made(host);
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(host.run(["claim", "2"], CLAIM("box_b")).status, 0);
  host.add("processes", "501 80001 ignores-sigterm 2");
  host.add("processes", "503 80001 idb_companion 1");
  host.add("processes", "504 80001 containermanagerd 1");
  host.add("processes", "502 501 Terminal 1");
  writeFileSync(join(host.root, "private/var/at/tabs/bbd-1"), "* * * * * true\n");
  for (const [path, uid] of [["/private/tmp/left-by-box", 80001], ["/Users/Shared/box-folder", 80001], ["/private/tmp/person-file", 501]] as const) {
    writeFileSync(join(host.root, path), "left\n");
    host.own(path, uid);
  }
  host.add("ipc", "m 65536 80001");
  host.add("ipc", "q 1 person");

  assert.deepEqual(host.run(["release", "1"], BOX("box_b")), { status: EXIT.notOurs, stdout: "", stderr: "Another box holds slot 1.\n" });
  assert.deepEqual(host.run(["release", "1"], BOX("box_a", "inst_b")), { status: EXIT.notOurs, stdout: "", stderr: "Another bb-box install holds slot 1.\n" });
  const release = host.run(["release", "1"], BOX());
  assert.deepEqual(release, { status: 0, stdout: "released=yes\nlast=no\n", stderr: "" });
  assert.equal(host.user("bbd-1"), null);
  assert.equal(existsSync(join(host.root, "Users/bbd-1")), false);
  assert.ok(!host.members("_developer").includes("bbd-1"));
  assert.equal(existsSync(join(host.root, "private/var/at/tabs/bbd-1")), false);
  assert.deepEqual(host.lines("processes").filter((line) => line.split(" ")[1] === "80001"), [], "a process that ignores SIGTERM is killed");
  assert.ok(count(host, "pkill -KILL -u 80001") >= 2);
  const calls = host.calls();
  const order = ["launchctl bootout system/app.bb-box.device.bbd-1", "xcrun simctl shutdown all", "pkill -TERM -u 80001 -x idb_companion", "launchctl bootout user/80001", "pkill -KILL -u 80001"].map((call) => calls.findIndex((line) => line.startsWith(call)));
  assert.ok(order.every((at, index) => at >= 0 && (index === 0 || at > order[index - 1]!)), `the slot is stopped gently first: its daemons, its devices, its companion, then its domain, then whatever is left (${order.join(", ")})`);
  assert.equal(count(host, "pkill -TERM -u 80001 -x containermanagerd"), 0, "its containermanagerd outlives its clients, so the system's CoreMediaIO service never queries a dead one");
  assert.ok(count(host, "launchctl bootout user/80001") >= 1);
  assert.deepEqual(slotDaemons(host), ["app.bb-box.device.bbd-2"]);
  assert.equal(host.file(`${HOST}/deleting`), null, "another box keeps the host");

  await swept(host);
  assert.equal(host.file("/private/tmp/left-by-box"), null);
  assert.equal(existsSync(join(host.root, "Users/Shared/box-folder")), false);
  assert.equal(host.file("/private/tmp/person-file"), "left\n");
  assert.ok(count(host, "launchctl bootout user/80001") >= 2, "logged out again after the sweep, as Spotlight's mds can start a removed user's domain again");
  assert.deepEqual(host.lines("ipc"), ["q 1 person"]);
  const { values, slots, lines } = host.status();
  assert.deepEqual(slots.map((slot) => slot.id), ["2"], "slot 1 removed once swept");
  assert.match(lines.find((line) => line.startsWith("sweep=80001\t")) ?? "", /^sweep=80001\t1\t\d+\t0\t\d+\.\d\t\d+$/);
  assert.equal(values.get("sweeping"), "0");

  assert.deepEqual(host.run(["release", "1"], BOX()), { status: 0, stdout: "released=already\nlast=no\n", stderr: "" });
});

test("the last release writes deleting under the lock and answers last, after which every claim, promise and make is refused", async () => {
  const host = quiet();
  made(host);
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  const last = host.run(["release", "1"], BOX());
  assert.deepEqual(last, { status: 0, stdout: "released=yes\nlast=yes\n", stderr: "" }, "a ready slot does not keep the host");
  assert.match(host.file(`${HOST}/deleting`)!, /^since=\d+\nslot=1\nbox=box_a\n$/);
  assert.match(host.status().values.get("deleting")!, /^\d+$/);
  for (const [args, input] of [[["claim", "2"], CLAIM("box_b")], [["promise"], BOX("box_c")], [["make"], ""]] as const) {
    assert.deepEqual(host.run(args, input), { status: EXIT.deleting, stdout: "", stderr: "This host is being deleted; ask again.\n" }, args.join(" "));
  }
  assert.match(host.run(["release", "1"], BOX()).stdout, /^released=(yes|already)\nlast=yes\n$/, "run again, it answers the same");
  await swept(host);
});

test("a promise or a slot being made for a box keeps the host at the last release, and counts against most", () => {
  const promised = quiet("most=2\n");
  made(promised);
  assert.equal(promised.run(["claim", "1"], CLAIM()).status, 0);
  assert.deepEqual(promised.run(["promise"], BOX("box_b")), { status: 0, stdout: "promised=box_b\n", stderr: "" });
  assert.match(promised.status().lines.find((line) => line.startsWith("promise="))!, /^promise=box_b\tinst_a\t\d+$/);
  assert.deepEqual(promised.run(["promise"], BOX("box_c")).status, EXIT.full, "slot 1 and box_b's promise fill most");
  assert.equal(promised.run(["release", "1"], BOX()).stdout, "released=yes\nlast=no\n");
  assert.equal(promised.run(["make"], "install=inst_a\nbox=box_b\n").status, 0, "a promised box's make takes its place");
  assert.equal(promised.status().lines.some((line) => line.startsWith("promise=")), false);

  const expired = quiet();
  made(expired);
  assert.equal(expired.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(expired.run(["promise"], BOX("box_b")).status, 0);
  writeFileSync(join(expired.root, HOST, "promises/box_b"), "install=inst_a\nbox=box_b\nsince=1\n");
  assert.equal(expired.run(["release", "1"], BOX()).stdout, "released=yes\nlast=yes\n", "a promise older than 10 minutes, as from an instance that died, keeps nothing");

  const making = quiet();
  made(making);
  assert.equal(making.run(["claim", "1"], CLAIM()).status, 0);
  making.flag("simctl-create-fails");
  assert.equal(making.run(["make"], "install=inst_a\nbox=box_b\n").status, 1);
  assert.equal(making.run(["release", "1"], BOX()).stdout, "released=yes\nlast=no\n");

  const unpromised = quiet();
  made(unpromised);
  assert.equal(unpromised.run(["claim", "1"], CLAIM()).status, 0);
  unpromised.run(["promise"], BOX("box_b"));
  assert.equal(unpromised.run(["unpromise"], BOX("box_b")).stdout, "unpromised=box_b\nlast=no\n", "slot 1's box keeps the host");
  assert.equal(unpromised.run(["release", "1"], BOX()).stdout, "released=yes\nlast=yes\n");
});

test("a promise given back with nothing else on the host, and vacate on a host that holds nothing, write deleting and answer last; status names each claim's box; restart starts a held slot's device server again (064, unit 4)", () => {
  const promised = quiet();
  made(promised);
  assert.equal(promised.run(["promise"], BOX("box_b")).status, 0);
  assert.deepEqual(promised.run(["unpromise"], BOX("box_b")), { status: 0, stdout: "unpromised=box_b\nlast=yes\n", stderr: "" }, "a ready slot does not keep the host");
  assert.match(promised.file(`${HOST}/deleting`) ?? "", /box=box_b/);
  assert.equal(promised.run(["promise"], BOX("box_c")).status, EXIT.deleting);
  assert.equal(promised.run(["vacate"], "install=inst_a\n").stdout, "last=yes\n", "a host being deleted stays so");

  const held = quiet();
  made(held);
  assert.equal(held.run(["claim", "1"], CLAIM("box_a")).status, 0);
  assert.deepEqual(held.run(["vacate"], "install=inst_a\n"), { status: 0, stdout: "last=no\n", stderr: "" });
  assert.equal(held.file(`${HOST}/deleting`), null);
  assert.ok(held.status().lines.includes("claim=1\tinst_a\tbox_a\tthr_a\tios-box\tios\t1790000000000"), held.status().lines.join("\n"));
  assert.deepEqual(parseHostStatus(held.status().lines.join("\n"))?.claims, [{ slot: "1", install: "inst_a", box: "box_a", thread: "thr_a", name: "ios-box", kind: "ios", created: 1790000000000 }]);
  assert.equal(held.run(["restart", "1"], BOX("box_b")).status, EXIT.notOurs);
  assert.deepEqual(held.run(["restart", "1"], BOX("box_a")), { status: 0, stdout: "restarted=1\n", stderr: "" });
  assert.ok(held.calls().some((line) => line === "launchctl kickstart -k system/app.bb-box.device.bbd-1"), held.calls().filter((line) => line.startsWith("launchctl")).join("\n"));

  const empty = quiet();
  assert.equal(empty.run(["vacate"], "install=inst_a\n").stdout, "last=yes\n");
  assert.equal(empty.run(["make"], "install=inst_a\n").status, EXIT.deleting);
});

test("a release cut short carries on from its step when run again, and answers as it first decided", async () => {
  const host = quiet();
  made(host);
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  host.flag("directory-down");
  const cut = host.run(["release", "1"], BOX());
  assert.equal(cut.status, 1);
  assert.match(cut.stderr, /^Resetting slot 1 failed at its user step: The Mac's directory service did not answer, so user bbd-1 is not removed yet\. Run it again to carry on from there\.\n$/);
  assert.deepEqual([host.slot("1")?.is, host.slot("1")?.step], ["resetting", "user"]);
  assert.match(host.file(`${HOST}/deleting`) ?? "", /slot=1/, "decided last before the cut");
  host.flag("directory-down", false);
  assert.deepEqual(host.run(["release", "1"], BOX("box_b")).status, EXIT.notOurs);
  assert.deepEqual(host.run(["release", "1"], BOX()), { status: 0, stdout: "released=yes\nlast=yes\n", stderr: "" });
  assert.equal(host.user("bbd-1"), null);
  assert.equal(count(host, "xcrun simctl shutdown all"), 1, "the processes step, done before the cut, is not run again");
  await swept(host);
});

test("the sweep takes at most resetting-most UIDs a pass, in one find, and refuses a UID outside the slots' ranges", async () => {
  const host = quiet("resetting-most=2\n");
  for (let i = 0; i < 3; i++) made(host);
  for (const id of ["1", "2", "3"]) assert.equal(host.run(["claim", id], CLAIM(`box_${id}`)).status, 0);
  const sweep = join(host.root, HOST, "sweep");
  writeFileSync(join(host.root, HOST, "sweep.lock"), "");
  for (const id of ["1", "2", "3"]) {
    writeFileSync(join(host.root, `private/tmp/left-${id}`), "left\n");
    host.own(`/private/tmp/left-${id}`, 80000 + Number(id));
  }
  const holder = spawn("flock", [join(host.root, HOST, "sweep.lock"), "sleep", "30"], { stdio: "ignore", detached: true });
  try {
    await host.until("the lock held", () => host.run(["reset"]).stdout === "sweeping=elsewhere\n");
    for (const id of ["1", "2", "3"]) assert.equal(host.run(["release", id], BOX(`box_${id}`)).status, 0);
    mkdirSync(sweep, { recursive: true });
    writeFileSync(join(sweep, "501"), "slot=\nuser=person\nuid=501\nsince=1\n");
  } finally {
    process.kill(-holder.pid!);
  }
  const reset = host.run(["reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  await swept(host);
  const passes = host.status().lines.filter((line) => line.startsWith("sweep=")).map((line) => line.split("\t").slice(0, 2).join(" "));
  assert.deepEqual(passes, ["sweep=80001 2", "sweep=80002 2", "sweep=80003 1"], "two UIDs in the first pass, one in the next");
  assert.equal(existsSync(join(sweep, "501")), false, "a UID outside the slots' ranges is refused");
  const finds = host.calls().filter((line) => line.startsWith("find ") && line.includes("-uid"));
  assert.equal(finds.filter((line) => line.startsWith(`find ${host.data} -xdev`)).length, 2, "one find over the Data volume a pass");
  assert.equal(finds.filter((line) => line.startsWith(`find ${host.data}/private/var/folders -xdev`)).length, 2, "and one over /private/var/folders once its users are logged out again");
  for (const id of ["1", "2", "3"]) assert.equal(host.file(`/private/tmp/left-${id}`), null);
  await swept(host);
});

test("daemon moves BB's daemon, as its installer left it with BB_INSTALL_SKIP_SERVICE=1, into a LaunchDaemon as the slot's user", async () => {
  const host = quiet();
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  const orphan = spawnSync("/bin/sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const installer = { pid: Number(orphan.stdout.trim()) };
  const data = join(host.root, "Users/bbd-1/.bb-machines/bb.example.test");
  mkdirSync(data, { recursive: true });
  writeFileSync(join(data, "install-daemon.pid"), `${installer.pid}\n`);
  writeFileSync(join(data, "host-daemon-port"), "38889\n");
  ownedByTheSlot(host, "/Users/bbd-1/.bb-machines", "bb.example.test", "bb.example.test/install-daemon.pid", "bb.example.test/host-daemon-port");
  host.add("processes", `${installer.pid} 80001 node 1`);
  writeFileSync(join(host.state, "commands", String(installer.pid)), "/Users/bbd-1/.bb-machines/bb.example.test/npm/bin/bb-app host-daemon --supervise --auto-update --host-daemon-port 38889 --server-url https://bb.example.test\n");

  assert.deepEqual(host.run(["daemon", "1"], BOX("box_b")).status, EXIT.notOurs);
  const daemon = host.run(["daemon", "1"], BOX());
  assert.deepEqual(daemon, { status: 0, stdout: "daemon=app.bb-box.bb.bbd-1\nport=38889\n", stderr: "" });
  assert.throws(() => process.kill(installer.pid, 0), "the installer's own daemon is stopped");
  assert.ok(host.daemons().includes("app.bb-box.bb.bbd-1"));
  const plist = host.file("/Library/LaunchDaemons/app.bb-box.bb.bbd-1.plist")!;
  assert.match(plist, /<key>UserName<\/key><string>bbd-1<\/string>/);
  const args = [...plist.matchAll(/^    <string>(.*)<\/string>$/gm)].map((match) => match[1]);
  assert.deepEqual(args, ["/Users/bbd-1/.bb-machines/bb.example.test/npm/bin/bb-app", "host-daemon", "--auto-update", "--host-daemon-port", "38889", "--server-url", "https://bb.example.test"]);
  assert.match(plist, /<key>BB_DATA_DIR<\/key><string>\/Users\/bbd-1\/.bb-machines\/bb.example.test<\/string>/);
  assert.match(plist, /<key>BB_APP_NPM_PREFIX<\/key><string>\/Users\/bbd-1\/.bb-machines\/bb.example.test\/npm<\/string>/);
  assert.match(plist, /<key>StandardErrorPath<\/key><string>\/private\/var\/log\/bb-box-slots\/bbd-1.log<\/string>/);

  const bare = spawnSync("/bin/sh", ["-c", "sleep 60 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" });
  const bareInstaller = Number(bare.stdout.trim());
  writeFileSync(join(data, "install-daemon.pid"), `${bareInstaller}\n`);
  host.add("processes", `${bareInstaller} 80001 node 1`);
  writeFileSync(join(host.state, "commands", String(bareInstaller)), "node /Users/bbd-1/.bb-machines/bb.example.test/npm/bin/bb-app host-daemon --supervise --host-daemon-port 38889\n");
  assert.equal(host.run(["daemon", "1"], BOX()).status, 0);
  const program = [...host.file("/Library/LaunchDaemons/app.bb-box.bb.bbd-1.plist")!.matchAll(/^    <string>(.*)<\/string>$/gm)][0]![1]!;
  assert.match(program, /^\/.*\/node$/, "a program BB's installer named bare, as node, is given to launchd by its path");

  writeFileSync(join(data, "install-daemon.pid"), "99999\n");
  assert.match(host.run(["daemon", "1"], BOX()).stderr, /^BB's installer left no daemon running as bbd-1: run BB's command with BB_INSTALL_SKIP_SERVICE=1 first\.\n$/);
  assert.equal(host.run(["release", "1"], BOX()).status, 0);
  assert.deepEqual(slotDaemons(host), [], "a release unloads BB's daemon too");
  await swept(host);
});

test("resume carries on every slot whose step was cut short, and the sweep queue", async () => {
  const host = quiet();
  made(host);
  host.flag("simctl-create-fails");
  assert.equal(host.run(["make"]).status, 1);
  host.flag("simctl-create-fails", false);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  host.flag("directory-down");
  assert.equal(host.run(["release", "1"], BOX()).status, 1);
  host.flag("directory-down", false);
  assert.match(host.run(["resume"]).stdout, /^resumed=\d+\n$/);
  await host.until("both carried on", () => host.slot("2")?.is === "ready" && host.slot("1") === undefined);
  assert.equal(host.user("bbd-1"), null);
});

test("status gives each slot's load, and a second booted device is shut down after 10 minutes, with words", () => {
  const host = fakeDeviceHost();
  made(host);
  const pid = host.lines("processes").find((line) => line.includes("launchd_sim"))!.split(" ")[0]!;
  writeFileSync(join(host.state, "load", pid), "250.0 2048000\n");
  const line = host.status().lines.find((each) => each.startsWith("slot=1\t"))!.split("\t");
  assert.deepEqual([line[14], line[15]], ["2.50", "2000"], "cores and MiB of resident memory");

  const env = { ...process.env, FAKE_MAC_STATE: host.state, FAKE_MAC_ROOT: host.root, FAKE_AS: "bbd-1", PATH: `${join(host.root, "../bin")}:/usr/bin:/bin` };
  const second = spawn(join(host.root, "../bin/xcrun"), ["simctl", "create", "iPhone 17", "x", RUNTIME], { env });
  return new Promise((resolve) => second.on("exit", resolve)).then(async () => {
    const extra = Object.entries(host.devices("bbd-1")).find(([, device]) => device.name === "iPhone 17")![0];
    await new Promise((resolve) => spawn(join(host.root, "../bin/xcrun"), ["simctl", "boot", extra], { env }).on("exit", resolve));
    host.clock(1_800_000_000);
    assert.equal(host.run(["bound"]).status, 0);
    assert.match(host.status().lines.find((each) => each.startsWith("devices=")) ?? "", /^devices=1\t2\t1800000000$/);
    host.clock(1_800_000_000 + 599);
    host.run(["bound"]);
    assert.equal(host.devices("bbd-1")[extra]?.state, "Booted", "left for a test that needs two");
    host.clock(1_800_000_000 + 600);
    host.run(["bound"]);
    assert.equal(host.devices("bbd-1")[extra]?.state, "Shutdown");
    assert.equal(Object.values(host.devices("bbd-1")).find((device) => device.name === "iPhone 18 Pro")?.state, "Booted", "the slot's own device stays");
    assert.match(host.status().lines.find((each) => each.startsWith("device_words=")) ?? "", new RegExp(`^device_words=1\\tA second device, ${extra}, was booted in slot 1 for 10 minutes, so it was shut down at \\d\\d:\\d\\d\\.$`));
  });
});

function restart(host: FakeDeviceHost): void {
  const loaded = join(host.state, "daemons");
  for (const label of readdirSync(loaded)) rmSync(join(loaded, label));
  const installed = join(host.root, "Library/LaunchDaemons");
  for (const name of readdirSync(installed)) if (name.endsWith(".plist")) writeFileSync(join(loaded, name.slice(0, -".plist".length)), readFileSync(join(installed, name)));
}

test("install writes the helper's daemon and the held ports' daemon but loads neither, so a dedicated box keeps the common dev ports free (064 F-6)", () => {
  const host = fakeDeviceHost();
  const install = host.run(["install"]);
  assert.deepEqual(install, { status: 0, stdout: "written=app.bb-box.device-host app.bb-box.device-host.ports\nloaded=\nheld_ports=\n", stderr: "" });
  assert.deepEqual(host.daemons(), []);
  assert.equal(host.file("/Library/LaunchDaemons/app.bb-box.device-host.ports.plist"), null);
  assert.equal(host.file("/Library/LaunchDaemons/app.bb-box.device-host.plist"), null);
  const helper = host.file(`${HOST}/app.bb-box.device-host.plist`)!;
  assert.match(helper, /<string>\/bin\/sh<\/string>\n    <string>\/usr\/local\/libexec\/bb-box\/device-host<\/string>\n    <string>run<\/string>/);
  assert.match(helper, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(helper, /<key>KeepAlive<\/key><dict><key>SuccessfulExit<\/key><false\/><\/dict>/, "run's return before init is not run again");
  const ports = host.file(`${HOST}/app.bb-box.device-host.ports.plist`)!;
  assert.match(ports, /<key>UserName<\/key><string>nobody<\/string>/);
  assert.deepEqual([...ports.matchAll(/^    <string>(\d+)<\/string>$/gm)].map((match) => Number(match[1])), [3000, 4200, 5000, 5173, 8000, 8080, 8081, 19000]);
  assert.equal(statSync(join(host.root, HOST)).mode & 0o777, 0o700, "no box reads the host's state");
  restart(host);
  assert.deepEqual(host.daemons(), [], "nothing holds the ports after a dedicated box's restart");
});

test("install takes the host's daemons out of launchd in a VM that an older image's install loaded them in", () => {
  const host = fakeDeviceHost();
  mkdirSync(join(host.root, "Library/LaunchDaemons"), { recursive: true });
  for (const label of HOST_DAEMONS) {
    writeFileSync(join(host.root, "Library/LaunchDaemons", `${label}.plist`), "an older install's plist\n");
    writeFileSync(join(host.state, "daemons", label), "an older install's plist\n");
  }
  assert.equal(host.run(["install"]).status, 0);
  assert.deepEqual(host.daemons(), []);
  restart(host);
  assert.deepEqual(host.daemons(), []);
});

test("run does nothing in a VM that never ran init", () => {
  const host = fakeDeviceHost();
  assert.equal(host.run(["install"]).status, 0);
  const before = host.calls().length;
  assert.deepEqual(host.run(["run"]), { status: 0, stdout: "", stderr: "" });
  assert.deepEqual(host.calls().slice(before).filter((line) => line !== "id -u"), []);
  assert.equal(host.file(`${HOST}/resumed-boot`), null);
});

test("init loads the held ports' daemon and the helper's, keeps them across the host's restarts, and leaves them running when run again", () => {
  const host = fakeDeviceHost();
  assert.equal(host.run(["install"]).status, 0);
  assert.equal(host.run(["init"], "ahead=0\n").status, 0);
  assert.deepEqual(host.daemons(), HOST_DAEMONS);
  assert.equal(host.file("/Library/LaunchDaemons/app.bb-box.device-host.ports.plist"), host.file(`${HOST}/app.bb-box.device-host.ports.plist`));
  restart(host);
  assert.deepEqual(host.daemons(), HOST_DAEMONS, "a host's restart holds the ports again");
  const bootouts = count(host, "launchctl bootout system/app.bb-box.device-host");
  assert.equal(host.run(["init"], "").status, 0);
  assert.equal(count(host, "launchctl bootout system/app.bb-box.device-host"), bootouts, "a second init does not let the ports go");
  assert.deepEqual(host.daemons(), HOST_DAEMONS);
  const reinstall = host.run(["install"]);
  assert.deepEqual(reinstall, { status: 0, stdout: "written=app.bb-box.device-host app.bb-box.device-host.ports\nloaded=app.bb-box.device-host app.bb-box.device-host.ports\nheld_ports=3000 4200 5000 5173 8000 8080 8081 19000\n", stderr: "" });
  assert.deepEqual(host.daemons(), HOST_DAEMONS, "install on a host loads the new helper's daemons");
  restart(host);
  assert.deepEqual(host.daemons(), HOST_DAEMONS);
});

test("the helper refuses to run as anyone but root, and its usage names its commands", () => {
  const host = fakeDeviceHost();
  assert.match(host.run(["bogus"]).stderr, /^usage: device-host status \| summary \| init \| install \| open \| close \| make \| carry \| promise \| unpromise \| vacate \| claim <slot> \| release <slot> \| restart <slot> \| reset \| daemon <slot> \| resume \| keep-app \| version\n$/);
  assert.equal(host.run(["version"]).stdout, "7\n");
  const text = readFileSync(new URL("../setup/tart/ios/device-host.sh", import.meta.url), "utf8");
  assert.match(text, /\[ "\$\(id -u\)" = 0 \] \|\| quit 2 "Run it as root, through sudo\."/);
  assert.doesNotMatch(text, /^\s*#(?!!)/m, "no comments: names carry intent");
});

test("BB Box reads the helper's status whole: settings, promises, every slot, a second device, and each sweep", async () => {
  const host = quiet("most=4\n");
  made(host);
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(host.run(["promise"], BOX("box_p")).status, 0);
  assert.equal(host.run(["claim", "2"], CLAIM("box_b")).status, 0);
  assert.equal(host.run(["release", "2"], BOX("box_b")).status, 0);
  await swept(host);
  const status = parseHostStatus(host.run(["status"]).stdout);
  assert.ok(status);
  assert.deepEqual(
    { ...status, boot: "", promises: status.promises.map((promise) => promise.box), claims: status.claims.map((claim) => [claim.slot, claim.box]), slots: status.slots.map((slot) => [slot.id, slot.is, slot.box, slot.portBase, slot.booted, slot.daemonsLoaded]), sweeps: status.sweeps.map((sweep) => [sweep.uid, sweep.uidsInPass]) },
    {
      helper: 7, boot: "", deletingSince: null, kept: false, closedSince: null, most: 4, ahead: 0, resettingMost: 4, diskReserveGiB: 10, generation: 2, cores: 8, memoryMiB: 16384, diskGiB: 100, memoryFreePercent: 60, bbApp: null, bbAppKept: false,
      runtime: RUNTIME, model: "iPhone 18 Pro", counted: 1, promises: ["box_p"], claims: [["1", "box_a"]], slots: [["1", "held", "box_a", 20000, true, true]], secondDevices: [], deviceWords: [], sweeping: 0, sweeps: [[80002, 1]],
    },
  );
  assert.equal(parseHostStatus("helper=1\n"), null, "no settings, no status");
});

test("a slot's BB daemon is taken over by the host's helper, as root, for the box that holds the slot", async () => {
  const runs: { script: string; stdin: string }[] = [];
  let exitCode = 0;
  const transport = { run: async (script: string, options: RunOptions = {}) => (runs.push({ script, stdin: String(options.stdin) }), { exitCode, stdout: "", stderr: exitCode ? "Box box_a does not hold slot 3.\n" : "", timedOut: false, truncated: false, durationMs: 1 }) } as unknown as CommandTransport;
  const kept = slotDaemonKeptByHost(transport, "3", { install: "inst_a", box: "box_a" }, 38902);
  assert.deepEqual(kept.installerEnvironment, { BB_INSTALL_SKIP_SERVICE: "1" });
  assert.equal(kept.daemonPort, 38902);
  await kept.takeOver(AbortSignal.timeout(1000));
  assert.deepEqual(runs, [{ script: "sudo -n /usr/local/libexec/bb-box/device-host daemon 3", stdin: "install=inst_a\nbox=box_a\n" }]);
  exitCode = DEVICE_HOST_EXITS.notOurs;
  await assert.rejects(kept.takeOver(AbortSignal.timeout(1000)), /^Error: The iOS host could not take over BB's daemon for slot 3: Box box_a does not hold slot 3\.$/);
  assert.match(readFileSync(new URL("../setup/tart/ios/device-host.sh", import.meta.url), "utf8"), new RegExp(`^HELD_PORTS="${HELD_PORTS.join(" ")}"$`, "m"), "the module's held ports are the helper's");
});

test("resume, at a new boot, clears the BB daemon's lock a hard stop left in each slot, and leaves a running daemon's alone", () => {
  const host = quiet();
  made(host);
  const data = join(host.root, "Users/bbd-1/.bb-machines/bb.example.test");
  mkdirSync(join(data, "daemon.lock.lock"), { recursive: true });
  writeFileSync(join(data, "install-daemon.pid"), "4242\n");
  writeFileSync(join(data, "host-daemon-port"), "38889\n");
  ownedByTheSlot(host, "/Users/bbd-1/.bb-machines", "bb.example.test");
  writeFileSync(join(host.state, "boot"), "BOOT-2\n");
  assert.equal(host.run(["resume"]).status, 0);
  assert.equal(existsSync(join(data, "daemon.lock.lock")), false);
  assert.equal(existsSync(join(data, "install-daemon.pid")), false);
  assert.equal(host.file("/Users/bbd-1/.bb-machines/bb.example.test/host-daemon-port"), "38889\n");
  mkdirSync(join(data, "daemon.lock.lock"));
  assert.equal(host.run(["resume"]).status, 0);
  assert.equal(existsSync(join(data, "daemon.lock.lock")), true, "the same boot: the daemon running now holds it");
});

test("the helper's slot users, UIDs, ports and steps are the data model's (064 unit 2)", () => {
  const host = quiet();
  assert.equal(host.run(["carry"]).status, 0);
  made(host);
  made(host);
  const status = parseHostStatus(host.run(["status"]).stdout)!;
  for (const slot of status.slots) {
    const name: SlotName = slot.carried ? { carried: true, generation: Number(slot.id.slice(1)) as 1 | 2 } : { carried: false, generation: Number(slot.id) };
    assert.deepEqual([slot.user, slot.uid], [slotUser(name), slotUid(name)], slot.id);
    assert.equal((slot.portBase - slotPorts(0).base) % slotPorts(0).count, 0, slot.id);
  }
  assert.deepEqual(status.slots.map((slot) => slot.portBase), [0, 1, 2, 3].map((place) => slotPorts(place).base));
  const helper = readFileSync(new URL("../setup/tart/ios/device-host.sh", import.meta.url), "utf8");
  for (const step of MAKING_STEPS) assert.ok(helper.includes(`making:${step})`), `the helper carries on from making step ${step}`);
  for (const step of RESETTING_STEPS.filter((each) => each !== "sweep")) assert.ok(helper.includes(`resetting:${step})`), `the helper carries on from resetting step ${step}`);
  assert.match(helper, new RegExp(`^PORT_COUNT=${slotPorts(0).count}$`, "m"));
});

test("daemon keeps BB's launchd log in a folder of root's, the file the slot user's, and a logs link the user planted is never followed", async () => {
  const host = quiet();
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  const { data } = installerLeftBy(host);
  const daemons = join(host.root, "Library/LaunchDaemons");
  symlinkSync(daemons, join(data, "logs"));
  const before = readdirSync(daemons);
  const callsBefore = host.calls().length;
  const daemon = host.run(["daemon", "1"], BOX());
  assert.equal(daemon.status, 0, daemon.stderr);
  assert.deepEqual(readdirSync(daemons).sort(), [...before, "app.bb-box.bb.bbd-1.plist"].sort(), "only the helper's own LaunchDaemon is added");
  assert.ok(!host.lines("owners").some((line) => line.endsWith("/Library/LaunchDaemons")), "the LaunchDaemons folder is never given to the slot's user");
  assert.deepEqual(host.calls().slice(callsBefore).filter((line) => line.startsWith("chown") && line.includes("/Users/bbd-1")), [], "root changes nothing in the user's home");
  assert.ok(lstatSync(join(data, "logs")).isSymbolicLink());

  const log = "/private/var/log/bb-box-slots/bbd-1.log";
  assert.equal(host.file(log), "");
  assert.equal(statSync(join(host.root, log)).mode & 0o777, 0o644);
  assert.ok(host.lines("owners").includes(`0 ${host.data}/private/var/log/bb-box-slots`), "a folder of root's, where the user can neither add nor swap a file");
  assert.ok(host.lines("owners").includes(`80001 ${host.data}${log}`), "the file the user's, as launchd opens it as the job's user");
  const plist = host.file("/Library/LaunchDaemons/app.bb-box.bb.bbd-1.plist")!;
  for (const key of ["StandardOutPath", "StandardErrorPath"]) assert.match(plist, new RegExp(`<key>${key}</key><string>${log}</string>`));
  assert.ok(host.calls().some((line) => line.startsWith("sudo -n -H -u bbd-1 -- kill -TERM ")), "the installer's daemon is stopped as its own user");

  assert.equal(host.run(["release", "1"], BOX()).status, 0);
  assert.equal(host.file(log), null, "a release removes the log");
  await swept(host);
});

test("daemon reads nothing through a link, or a file the slot user does not own, in the user's BB data", () => {
  const cases: [string, (data: string, host: FakeDeviceHost) => void, RegExp][] = [
    ["a linked .bb-machines", (_data, host) => {
      const machines = join(host.root, "Users/bbd-1/.bb-machines");
      spawnSync("mv", [machines, join(host.root, "private/var/elsewhere")]);
      symlinkSync(join(host.root, "private/var/elsewhere"), machines);
    }, /^BB's installer left no daemon running as bbd-1/],
    ["a linked data folder", (data, host) => {
      spawnSync("mv", [data, `${data}.real`]);
      symlinkSync(`${data}.real`, data);
      host.own("/Users/bbd-1/.bb-machines/bb.example.test.real", 80001);
    }, /^BB's installer left no daemon running as bbd-1/],
    ["a linked pid file", (data) => {
      writeFileSync(join(data, "pid.real"), readFileSync(join(data, "install-daemon.pid")));
      rmSync(join(data, "install-daemon.pid"));
      symlinkSync(join(data, "pid.real"), join(data, "install-daemon.pid"));
    }, /^BB's installer left no daemon running as bbd-1/],
    ["a pid file of root's, as a hard link to it would be", (_data, host) => host.own("/Users/bbd-1/.bb-machines/bb.example.test/install-daemon.pid", 0), /^BB's installer left no daemon running as bbd-1/],
    ["a linked port file", (data) => {
      writeFileSync(join(data, "port.real"), "38889\n");
      rmSync(join(data, "host-daemon-port"));
      symlinkSync(join(data, "port.real"), join(data, "host-daemon-port"));
    }, /^BB's installer left no daemon port in \/Users\/bbd-1\/.bb-machines\/bb.example.test\.\n$/],
  ];
  for (const [what, plant, words] of cases) {
    const host = quiet();
    made(host);
    assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
    const { data, pid } = installerLeftBy(host);
    plant(data, host);
    const daemon = host.run(["daemon", "1"], BOX());
    assert.equal(daemon.status, 1, what);
    assert.match(daemon.stderr, words, what);
    assert.ok(alive(pid), `${what}: nothing is stopped`);
    assert.ok(!host.daemons().includes("app.bb-box.bb.bbd-1"), what);
    process.kill(pid);
  }
});

test("resume at a new boot follows no link in a slot user's BB data, and clears the user's own as that user", () => {
  const host = quiet();
  made(host);
  made(host);
  const outside = join(host.root, "private/var/root-things");
  mkdirSync(join(outside, "daemon.lock.lock"), { recursive: true });
  writeFileSync(join(outside, "install-daemon.pid"), "1\n");
  const machines = join(host.root, "Users/bbd-1/.bb-machines");
  mkdirSync(join(machines, "real/daemon.lock.lock"), { recursive: true });
  mkdirSync(join(machines, "roots/daemon.lock.lock"), { recursive: true });
  ownedByTheSlot(host, "/Users/bbd-1/.bb-machines", "real");
  symlinkSync(outside, join(machines, "linked"));
  symlinkSync(outside, join(host.root, "Users/bbd-2/.bb-machines"));
  writeFileSync(join(host.state, "boot"), "BOOT-2\n");
  assert.equal(host.run(["resume"]).status, 0);
  assert.equal(existsSync(join(machines, "real/daemon.lock.lock")), false, "the user's own lock is cleared");
  assert.ok(host.calls().some((line) => line.startsWith(`sudo -n -H -u bbd-1 -- rm -rf ${machines}/real/daemon.lock.lock`)), "as the user");
  assert.ok(existsSync(join(outside, "daemon.lock.lock")) && existsSync(join(outside, "install-daemon.pid")), "a linked data folder and a linked .bb-machines are left");
  assert.ok(existsSync(join(machines, "roots/daemon.lock.lock")), "a folder the user does not own is left");
});

test("the sweep removes a hand-written sweep file named \"80001 0\" by its whole name and touches nothing of root's", async () => {
  const host = quiet();
  writeFileSync(join(host.root, "private/tmp/roots-file"), "root's\n");
  host.own("/private/tmp/roots-file", 0);
  host.add("processes", "700 0 rootd 1");
  host.add("ipc", "m 9 root");
  const sweep = join(host.root, HOST, "sweep");
  writeFileSync(join(sweep, "80001 0"), "slot=1\nuser=bbd-1\nuid=80001\nsince=1\n");
  symlinkSync(join(host.root, "private/tmp/roots-file"), join(sweep, "80002"));
  const reset = host.run(["reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  assert.match(reset.stdout, /^refused=80001 0: not a slot's UID with its own slot and user$/m);
  assert.match(reset.stdout, /^refused=80002: /m);
  assert.deepEqual(readdirSync(sweep), []);
  assert.equal(host.file("/private/tmp/roots-file"), "root's\n", "a link's target is left");
  assert.ok(host.lines("processes").includes("700 0 rootd 1"));
  assert.deepEqual(host.lines("ipc"), ["m 9 root"]);
  const acting = host.calls().filter((line) => /^(find|pkill|ipcrm) /.test(line) || line.startsWith("launchctl bootout user/"));
  assert.deepEqual(acting, [], "no find, kill, log-out or IPC removal ran");

  const resumed = quiet();
  writeFileSync(join(resumed.root, HOST, "sweep", "80001 0"), "slot=1\nuser=bbd-1\nuid=80001\nsince=1\n");
  assert.equal(resumed.run(["resume"]).status, 0);
  await resumed.until("resume's sweep removed it", () => readdirSync(join(resumed.root, HOST, "sweep")).length === 0);
  assert.equal(resumed.calls().filter((line) => line.startsWith("find ")).length, 0);
});

test("the sweep's steps each refuse a UID outside the slots' before they act", () => {
  const host = quiet();
  for (const line of ["m 5 bbd-1", "m 6 80001", "q 1 person", "m 7 root"]) host.add("ipc", line);
  host.add("processes", "700 0 rootd 1");
  const refused = [["sweep_pass", host.data, "0"], ["sweep_pass", host.data, "80001", "0"], ["sweep_pass", host.data, "80001 0"], ["sweep_pass", host.data], ["log_out_again", "0"], ["log_out_again", "501"], ["log_out_again", "80001 0"], ["remove_ipc", "0"], ["remove_ipc", "80001 0"], ["remove_ipc", "root"]];
  for (const args of refused) assert.equal(internal(host, args).status, 1, args.join(" "));
  assert.deepEqual(host.calls().filter((line) => /^(find|pkill|ipcrm|ipcs) /.test(line) || (line.startsWith("launchctl bootout") && !line.startsWith("launchctl bootout system/app.bb-box.device-host"))), []);
  assert.ok(host.lines("processes").includes("700 0 rootd 1"));
  assert.equal(internal(host, ["remove_ipc", "80001"]).status, 0);
  assert.deepEqual(host.lines("ipc"), ["q 1 person", "m 7 root"], "a slot's objects, by its user's name or its UID");
});

test("the sweep refuses a file whose slot or user is not its UID's, and removes no other slot's folder", async () => {
  const host = quiet();
  made(host);
  made(host);
  host.add("ipc", "m 7 root");
  const sweep = join(host.root, HOST, "sweep");
  writeFileSync(join(sweep, "80002"), "slot=1\nuser=bbd-1\nuid=80002\nsince=1\n");
  writeFileSync(join(sweep, "80003"), "slot=../../..\nuser=bbd-3\nuid=80003\nsince=1\n");
  writeFileSync(join(sweep, "80004"), "slot=4\nuser=root\nuid=80004\nsince=1\n");
  writeFileSync(join(sweep, "79991"), "slot=\nuser=bbd-i1\nuid=79991\nsince=1\n");
  const reset = host.run(["reset"]);
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(reset.stdout.split("\n").filter((line) => line.startsWith("refused=")).map((line) => line.split(":")[0]).sort(), ["refused=79991", "refused=80002", "refused=80003", "refused=80004"]);
  assert.deepEqual(readdirSync(sweep), []);
  assert.deepEqual([host.slot("1")?.is, host.slot("2")?.is], ["ready", "ready"]);
  assert.ok(existsSync(join(host.root, HOST, "settings")));
  assert.deepEqual(host.lines("ipc"), ["m 7 root"]);
  assert.equal(host.calls().filter((line) => line.startsWith("find ")).length, 0);
});

test("a release cut between its state and its claim's move carries on, from release or resume, and decides last once", async () => {
  const stranded = quiet();
  made(stranded);
  made(stranded);
  assert.equal(stranded.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(stranded.run(["claim", "2"], CLAIM("box_b")).status, 0);
  const slot1 = join(stranded.root, HOST, "slots/1");
  spawnSync("mv", [join(slot1, "claim"), join(slot1, "released")]);
  assert.equal(stranded.run(["release", "1"], BOX("box_b")).status, EXIT.notOurs, "the released file still names its box");
  assert.deepEqual(stranded.run(["release", "1"], BOX()), { status: 0, stdout: "released=yes\nlast=no\n", stderr: "" }, "a held slot with its claim moved, as the old order left it, is released");
  assert.equal(stranded.user("bbd-1"), null);

  const cut = quiet();
  made(cut);
  assert.equal(cut.run(["claim", "1"], CLAIM()).status, 0);
  writeFileSync(join(cut.root, HOST, "slots/1/state"), "is=releasing\nbox=box_a\nsince=1\n");
  const resumed = cut.run(["continue", "1"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  assert.match(cut.file(`${HOST}/deleting`) ?? "", /^since=\d+\nslot=1\nbox=box_a\n$/, "resume makes the last decision the cut skipped");
  assert.equal(cut.file(`${HOST}/slots/1/claim`), null);
  assert.equal(cut.run(["release", "1"], BOX()).stdout, "released=yes\nlast=yes\n");
  await swept(cut);

  const again = quiet();
  made(again);
  made(again);
  assert.equal(again.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(again.run(["claim", "2"], CLAIM("box_b")).status, 0);
  writeFileSync(join(again.root, HOST, "slots/1/state"), "is=releasing\nbox=box_a\nsince=1\n");
  assert.deepEqual(again.run(["release", "1"], BOX()), { status: 0, stdout: "released=yes\nlast=no\n", stderr: "" }, "the release run again decides");
  assert.equal(again.file(`${HOST}/deleting`), null);
  assert.match(again.file(`${HOST}/slots/1/released`) ?? "", /^install=inst_a\nbox=box_a\n/);
  await swept(again);
});

test("a claim whose slot's warm-up outlasts its wait gives the slot back as ready, with no claim", () => {
  const host = quiet();
  made(host);
  tune(host, "CLAIM_WARM_WAIT_S", "1");
  const lock = join(host.root, HOST, "slots/1/lock");
  const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore", detached: true });
  try {
    const end = Date.now() + 5000;
    while (!lockHeld(lock) && Date.now() < end) spawnSync("sleep", ["0.05"]);
    const claim = host.run(["claim", "1"], CLAIM());
    assert.deepEqual(claim, { status: 1, stdout: "", stderr: "Slot 1's warm-up did not end within 1 s; ask again.\n" });
    assert.deepEqual([host.slot("1")?.is, host.slot("1")?.box], ["ready", ""]);
    assert.equal(host.file(`${HOST}/slots/1/claim`), null);
    assert.equal(host.file("/Users/bbd-1/.ssh/authorized_keys"), null, "nothing of the box's was written");
  } finally {
    process.kill(-holder.pid!);
  }
  const later = host.run(["claim", "1"], CLAIM("box_b"));
  assert.equal(later.status, 0, later.stderr);
});

test("a lend that fails removes the slot instead of offering it again, for a macos box and an ios box", async () => {
  for (const [kind, input, prepare] of [
    ["macos", CLAIM("box_m", "macos"), (host: FakeDeviceHost) => host.flag("simctl-fails")],
    ["ios", `${CLAIM("box_i")}server=Users/person\n`, () => undefined],
  ] as const) {
    const host = quiet();
    made(host);
    prepare(host);
    const claim = host.run(["claim", "1"], input);
    assert.equal(claim.status, 1, kind);
    assert.match(claim.stderr, /^Could not lend slot 1, so it is removed: /, kind);
    host.flag("simctl-fails", false);
    assert.equal(host.user("bbd-1"), null, `${kind}: its user is removed`);
    assert.notEqual(host.slot("1")?.is, "ready", kind);
    assert.ok([EXIT.lost, EXIT.notReady].includes(host.run(["claim", "1"], CLAIM("box_n")).status as never), `${kind}: never lent again`);
    await swept(host);
    assert.deepEqual(host.status().slots, [], kind);
  }
});

test("the seed refuses a store that is a link or another user's folder, and seeds one of root's", () => {
  const udid = `00000004-0000-4000-8000-${(80001).toString(16).toUpperCase().padStart(12, "0")}`;
  const store = `/private/var/tmp/com.apple.CoreSimulator.SimDevice.${udid}`;

  const linked = fakeDeviceHost();
  const target = join(linked.root, "Library/LaunchDaemons");
  symlinkSync(target, join(linked.root, store));
  const refused = linked.run(["make"]);
  assert.equal(refused.status, 1);
  assert.equal(refused.stderr, `Making slot 1 failed at its device step: ${store} is not a folder of root's or bbd-1's, so the slot's device is not seeded. Run it again to carry on from there.\n`);
  assert.deepEqual(readdirSync(target), [], "nothing copied through the link");
  assert.ok(!linked.lines("owners").some((line) => line.includes("LaunchDaemons")), "nothing given away through it");

  const others = fakeDeviceHost();
  mkdirSync(join(others.root, store));
  others.own(store, 501);
  assert.match(others.run(["make"]).stderr, /is not a folder of root's or bbd-1's/);
  assert.equal(others.file(`${store}/disabled.plist`), null);

  const roots = fakeDeviceHost();
  mkdirSync(join(roots.root, store));
  symlinkSync(join(roots.root, "private/tmp/elsewhere"), join(roots.root, store, "disabled.plist"));
  const seeded = roots.run(["make"]);
  assert.equal(seeded.status, 0, seeded.stderr);
  assert.ok(!lstatSync(join(roots.root, store, "disabled.plist")).isSymbolicLink(), "a link inside is replaced, not written through");
  assert.equal(existsSync(join(roots.root, "private/tmp/elsewhere")), false);
  assert.ok(roots.lines("owners").includes(`80001 ${roots.data}${store}/disabled.plist`));
});

test("make refuses once the host has given every slot UID, with words to let it drain", () => {
  const host = quiet();
  writeFileSync(join(host.root, HOST, "generation"), "9998\n");
  const last = made(host);
  assert.deepEqual([last.get("slot"), last.get("user"), last.get("uid")], ["9999", "bbd-9999", "89999"]);
  const words = "This host has given all its 9999 slot UIDs, so it makes no new slot: let its boxes go, then set it up again.\n";
  assert.deepEqual(host.run(["make"]), { status: EXIT.full, stdout: "", stderr: words });
  assert.deepEqual(host.run(["promise"], BOX("box_p")), { status: EXIT.full, stdout: "", stderr: words });
  assert.equal(count(host, "sysadminctl -addUser"), 1);
  assert.equal(host.status().values.get("generation"), "9999");
});

test("a box ID must start with a letter or digit", () => {
  const host = quiet();
  made(host);
  for (const box of [".", "..", "...", ".hidden", "-a", "_a"]) {
    for (const [args, input] of [[["promise"], BOX(box)], [["unpromise"], BOX(box)], [["make"], `install=inst_a\nbox=${box}\n`], [["claim", "1"], CLAIM(box)], [["release", "1"], BOX(box)], [["daemon", "1"], BOX(box)]] as const) {
      const result = host.run(args, input);
      assert.equal(result.status, 2, `${args[0]} ${box}`);
      assert.match(result.stderr, /a box ID of letters, digits, dots, dashes and underscores that starts with a letter or digit\.\n$/);
    }
  }
  assert.ok(statSync(join(host.root, HOST, "promises")).isDirectory());
  assert.equal(host.run(["promise"], BOX("a.b-c_d")).stdout, "promised=a.b-c_d\n");
});

test("resetting-most is at least 1, so a sweep always moves", async () => {
  assert.deepEqual(fakeDeviceHost().run(["init"], "resetting-most=0\n"), { status: 2, stdout: "", stderr: "resetting-most must be at least 1.\n" });
  const host = quiet();
  setSetting(host, "resetting-most", "0");
  assert.equal(host.status().values.get("resetting-most"), "1");
  made(host);
  assert.equal(host.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(host.run(["release", "1"], BOX()).status, 0);
  await swept(host);
  assert.deepEqual(host.status().slots, []);
});

test("a claim that tops up the host lends the slot it claimed, and a release that tops up carries on its own slot", async () => {
  const host = fakeDeviceHost();
  made(host);
  const claim = host.run(["claim", "1"], CLAIM());
  assert.equal(claim.status, 0, claim.stderr);
  assert.deepEqual([answer(claim.stdout).get("slot"), answer(claim.stdout).get("user")], ["1", "bbd-1"]);
  assert.equal(host.file("/Users/bbd-1/.ssh/authorized_keys"), `${KEY}\n`);
  await host.until("slot 2 made ahead", () => host.slot("2")?.is === "ready");
  assert.equal(existsSync(join(host.root, "Users/bbd-2/.ssh")), false, "the slot made ahead got no key");
  assert.equal(host.slot("1")?.box, "box_a");

  const releasing = quiet();
  made(releasing);
  made(releasing);
  assert.equal(releasing.run(["claim", "1"], CLAIM()).status, 0);
  assert.equal(releasing.run(["claim", "2"], CLAIM("box_b")).status, 0);
  setSetting(releasing, "ahead", "1");
  assert.deepEqual(releasing.run(["release", "1"], BOX()), { status: 0, stdout: "released=yes\nlast=no\n", stderr: "" });
  assert.equal(releasing.user("bbd-1"), null, "the released slot's user is removed by the release itself");
  await releasing.until("slot 3 made ahead", () => releasing.slot("3")?.is === "ready");
  await swept(releasing);
});
