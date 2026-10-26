import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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

function quiet(settings = ""): FakeDeviceHost {
  const host = fakeDeviceHost();
  const init = host.run(["init"], `ahead=0\n${settings}`);
  assert.equal(init.status, 0, init.stderr);
  return host;
}

function count(host: FakeDeviceHost, call: string): number {
  return host.calls().filter((line) => line.startsWith(call)).length;
}

function made(host: FakeDeviceHost, input = "install=inst_a\n"): Map<string, string> {
  const result = host.run(["make"], input);
  assert.equal(result.status, 0, result.stderr);
  return new Map(result.stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function answer(stdout: string): Map<string, string> {
  return new Map(stdout.trim().split("\n").map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

async function swept(host: FakeDeviceHost): Promise<void> {
  await host.until("the sweep queue emptied", () => host.status().values.get("sweeping") === "0");
}

test("init keeps the settings the host was made with, and status gives them with the host's size", () => {
  const host = fakeDeviceHost();
  const first = host.run(["init"], "most=6\nahead=2\n");
  assert.deepEqual(first, { status: 0, stdout: "most=6\nahead=2\nresetting-most=4\ndisk-reserve-gib=40\n", stderr: "" });
  assert.equal(host.run(["init"], "most=12\n").stdout, first.stdout, "a snapshot: a later setting is for hosts made after it");
  const { values, slots } = host.status();
  assert.deepEqual(
    ["helper", "deleting", "most", "ahead", "generation", "cores", "memory", "disk", "memory_free", "runtime", "model", "counted", "sweeping"].map((key) => values.get(key)),
    ["1", "", "6", "2", "0", "8", "16384", "100", "60", RUNTIME, "iPhone 18 Pro", "0", "0"],
  );
  assert.deepEqual(slots, []);
  assert.deepEqual(host.run(["init"], "most=many\n").status, 0, "settings are written once");
  assert.equal(fakeDeviceHost().run(["init"], "most=many\n").status, 2);
  assert.match(fakeDeviceHost().run(["init"], "colour=blue\n").stderr, /^Unknown input: colour\.\n$/);
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
  disk.flag("disk-free-kib", true, String(30 * 1048576));
  assert.deepEqual(disk.run(["make"]), { status: EXIT.full, stdout: "", stderr: "This host has 30 GiB of disk free, under the 40 GiB it keeps, so it makes no new slot.\n" });
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

test("carry makes the image's two slots, each seeded and first booted, then shut down, with daemons written but not loaded", () => {
  const host = quiet();
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
  assert.deepEqual(host.daemons(), [], "nothing boots at a host's start");
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
  assert.deepEqual(host.daemons(), []);
  assert.equal(answer(claim.stdout).get("udid"), "");
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
  assert.deepEqual(host.daemons(), ["app.bb-box.device.bbd-2"]);
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
  assert.equal(unpromised.run(["unpromise"], BOX("box_b")).stdout, "unpromised=box_b\n");
  assert.equal(unpromised.run(["release", "1"], BOX()).stdout, "released=yes\nlast=yes\n");
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
  assert.match(plist, /<key>StandardErrorPath<\/key><string>\/Users\/bbd-1\/.bb-machines\/bb.example.test\/logs\/launchd.log<\/string>/);

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
  assert.deepEqual(host.daemons(), [], "a release unloads BB's daemon too");
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

test("install loads the helper's own daemon, run at every boot, and the held ports' daemon, as nobody", () => {
  const host = fakeDeviceHost();
  const install = host.run(["install"]);
  assert.deepEqual(install, { status: 0, stdout: "installed=app.bb-box.device-host app.bb-box.device-host.ports\nheld_ports=3000 4200 5000 5173 8000 8080 8081 19000\n", stderr: "" });
  assert.deepEqual(host.daemons(), ["app.bb-box.device-host", "app.bb-box.device-host.ports"]);
  const helper = host.file("/Library/LaunchDaemons/app.bb-box.device-host.plist")!;
  assert.match(helper, /<string>\/bin\/sh<\/string>\n    <string>\/usr\/local\/libexec\/bb-box\/device-host<\/string>\n    <string>run<\/string>/);
  assert.match(helper, /<key>RunAtLoad<\/key><true\/>/);
  const ports = host.file("/Library/LaunchDaemons/app.bb-box.device-host.ports.plist")!;
  assert.match(ports, /<key>UserName<\/key><string>nobody<\/string>/);
  assert.deepEqual([...ports.matchAll(/^    <string>(\d+)<\/string>$/gm)].map((match) => Number(match[1])), [3000, 4200, 5000, 5173, 8000, 8080, 8081, 19000]);
  assert.equal(statSync(join(host.root, HOST)).mode & 0o777, 0o700, "no box reads the host's state");
});

test("the helper refuses to run as anyone but root, and its usage names its commands", () => {
  const host = fakeDeviceHost();
  assert.match(host.run(["bogus"]).stderr, /^usage: device-host status \| init \| install \| make \| carry \| promise \| unpromise \| claim <slot> \| release <slot> \| reset \| daemon <slot> \| resume \| version\n$/);
  assert.equal(host.run(["version"]).stdout, "1\n");
  const text = readFileSync(new URL("../setup/tart/ios/device-host.sh", import.meta.url), "utf8");
  assert.match(text, /\[ "\$\(id -u\)" = 0 \] \|\| quit 2 "Run it as root, through sudo\."/);
  assert.doesNotMatch(text, /^\s*#(?!!)/m, "no comments: names carry intent");
});

test("bb-box reads the helper's status whole: settings, promises, every slot, a second device, and each sweep", async () => {
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
    { ...status, boot: "", promises: status.promises.map((promise) => promise.box), slots: status.slots.map((slot) => [slot.id, slot.is, slot.box, slot.portBase, slot.booted, slot.daemonsLoaded]), sweeps: status.sweeps.map((sweep) => [sweep.uid, sweep.uidsInPass]) },
    {
      helper: 1, boot: "", deletingSince: null, most: 4, ahead: 0, resettingMost: 4, diskReserveGiB: 40, generation: 2, cores: 8, memoryMiB: 16384, diskGiB: 100, memoryFreePercent: 60,
      runtime: RUNTIME, model: "iPhone 18 Pro", counted: 1, promises: ["box_p"], slots: [["1", "held", "box_a", 20000, true, true]], secondDevices: [], deviceWords: [], sweeping: 0, sweeps: [[80002, 1]],
    },
  );
  assert.equal(parseHostStatus("helper=1\n"), null, "no settings, no status");
});

test("a slot's BB daemon is taken over by the host's helper, as root, for the box that holds the slot", async () => {
  const runs: { script: string; stdin: string }[] = [];
  let exitCode = 0;
  const transport = { run: async (script: string, options: RunOptions = {}) => (runs.push({ script, stdin: String(options.stdin) }), { exitCode, stdout: "", stderr: exitCode ? "Box box_a does not hold slot 3.\n" : "", timedOut: false, truncated: false, durationMs: 1 }) } as unknown as CommandTransport;
  const kept = slotDaemonKeptByHost(transport, "3", { install: "inst_a", box: "box_a" });
  assert.deepEqual(kept.installerEnvironment, { BB_INSTALL_SKIP_SERVICE: "1" });
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
