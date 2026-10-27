import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT as MACHINE_EXIT, parseStatus } from "../src/backends/ssh-pool/protocol.ts";
import { DEVICE_HOST_EXITS as EXIT } from "../src/backends/tart/device-host.ts";
import { fakeDeviceHost, LIST, RUNTIME, type FakeDeviceHost } from "./fake-device-host.ts";
import { tempDir } from "./helpers.ts";

const IOS = fileURLToPath(new URL("../setup/tart/ios/", import.meta.url));
const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxKeyForTests box";
const SLOT_CLAIM = (box = "box_a") => `install=inst_a\nbox=${box}\nthread=thr_a\nname=ios-box\nkind=ios\ncreated=1790000000000\nkey=${KEY}\n`;
const WHOLE_CLAIM = (box = "box_w") => `install=inst_a\nbox=${box}\nthread=thr_w\nname=mac-box\nkind=macos-desktop\ncreated=1790000000000\nkey=${KEY}\n`;
const BOX = (box = "box_a") => `install=inst_a\nbox=${box}\n`;
const OPEN = (ahead = 0, most = 12) => `install=inst_a\nmost=${most}\nahead=${ahead}\nresetting-most=4\ndisk-reserve-gib=40\n`;
const HOST = "/var/db/bb-box/host";
const HELPER_DAEMON = "app.bb-box.device-host";
const PORTS_DAEMON = "app.bb-box.device-host.ports";

function lines(stdout: string): Map<string, string> {
  return new Map(stdout.trim().split("\n").filter(Boolean).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]));
}

function kept(): FakeDeviceHost {
  const host = fakeDeviceHost();
  const init = host.run(["init"], "kept=yes\nahead=0\n");
  assert.equal(init.status, 0, init.stderr);
  return host;
}

function opened(ahead = 0): FakeDeviceHost {
  const host = kept();
  const open = host.run(["open"], OPEN(ahead));
  assert.equal(open.status, 0, open.stderr);
  return host;
}

function poolMac(): FakeDeviceHost {
  const host = opened();
  const init = host.machine(["init"]);
  assert.equal(init.status, 0, init.stderr);
  return host;
}

function made(host: FakeDeviceHost, through: "device-host" | "machine" = "device-host"): string {
  const result = through === "machine" ? host.machine(["slot", "make"], "install=inst_a\n") : host.run(["make"], "install=inst_a\n");
  assert.equal(result.status, 0, result.stderr);
  return lines(result.stdout).get("slot")!;
}

async function swept(host: FakeDeviceHost): Promise<void> {
  await host.until("the sweep queue emptied", () => host.status().values.get("sweeping") === "0");
}

test("a kept host, as the pool's Mac is, starts closed with no carried slots, holds no ports until bb-box opens it, and opens with the settings bb-box gives", () => {
  const host = kept();
  assert.equal(host.file(`${HOST}/kept`), "");
  assert.match(host.file(`${HOST}/closed`)!, /^since=\d+\n$/);
  assert.deepEqual(host.daemons(), [HELPER_DAEMON], "its own daemon, for resume and the sweeps, and no held ports while closed");
  assert.deepEqual(host.run(["carry"]), { status: 2, stdout: "", stderr: "A kept host, such as the pool's Mac, has no carried slots.\n" });
  for (const [args, input] of [[["make"], ""], [["promise"], BOX()], [["claim", "1"], SLOT_CLAIM()]] as const) {
    const refused = host.run(args, input);
    assert.equal(refused.status, EXIT.deleting, args.join(" "));
    assert.match(refused.stderr, /^This host is closed, as the pool's Mac is while it is lent whole, so it lends no slot now; ask again\.\n$/);
  }
  assert.equal(host.run(["claim", "i1"], SLOT_CLAIM()).status, 2, "a kept host has no carried slot to claim");

  const open = host.run(["open"], OPEN(0, 6));
  assert.deepEqual(open, { status: 0, stdout: "open=yes\nmost=6\nahead=0\nresetting-most=4\ndisk-reserve-gib=40\n", stderr: "" });
  assert.equal(host.file(`${HOST}/closed`), null);
  assert.deepEqual(host.daemons(), [HELPER_DAEMON, PORTS_DAEMON]);
  assert.equal(lines(host.run(["open"], OPEN(1, 12)).stdout).get("most"), "12", "the pool's Mac takes bb-box's settings at each open, as it is never made again");

  const summary = host.run(["summary"]);
  assert.equal(summary.status, 0, summary.stderr);
  const values = lines(summary.stdout);
  assert.deepEqual(
    ["helper", "kept", "closed", "deleting", "most", "ahead", "held", "ready", "waiting", "sweeping", "runtime", "model", "labels"].map((key) => values.get(key)),
    ["3", "1", "", "", "12", "1", "0", values.get("ready"), "0", "0", `${RUNTIME}\t27.0\t24A434\t${LIST}`, "iPhone 18 Pro\tcom.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", undefined],
  );
  assert.equal(host.status().values.get("kept"), "1");

  const tart = fakeDeviceHost();
  assert.equal(tart.run(["init"], "ahead=0\n").status, 0);
  assert.deepEqual(tart.run(["init"], "kept=yes\n"), { status: 2, stdout: "", stderr: "This host was set up to be deleted with its last box, so it cannot be kept.\n" });
  for (const verb of ["open", "close"]) assert.match(tart.run([verb], "install=inst_a\n").stderr, new RegExp(`^${verb} is only for a kept host`));
  assert.equal(tart.status().values.get("kept"), "0");
  assert.equal(host.run(["init"], "kept=maybe\n").status, 2);
});

test("on a kept host the last release and a vacate write no deleting: the host keeps lending, and tops up its spares", async () => {
  const host = opened();
  const slot = made(host);
  assert.equal(host.run(["claim", slot], SLOT_CLAIM()).status, 0);
  assert.deepEqual(host.run(["release", slot], BOX()), { status: 0, stdout: "released=yes\nlast=yes\n", stderr: "" });
  assert.equal(host.file(`${HOST}/deleting`), null);
  assert.deepEqual(host.run(["vacate"], "install=inst_a\n"), { status: 0, stdout: "last=yes\n", stderr: "" });
  assert.equal(host.file(`${HOST}/deleting`), null);
  assert.equal(host.run(["promise"], BOX("box_b")).status, 0, "it still lends");
  assert.deepEqual(host.run(["unpromise"], BOX("box_b")).stdout, "unpromised=box_b\nlast=yes\n");
  assert.equal(host.file(`${HOST}/deleting`), null);
  assert.equal(host.run(["open"], OPEN(1)).status, 0);
  await host.until("a spare made ahead after open", () => host.status().slots.some((each) => each.is === "ready"));
  await swept(host);
});

test("close refuses while a slot is held or a box waits, and otherwise removes the spares, lets the ports go and refuses every claim until the host opens", async () => {
  const host = opened();
  const first = made(host);
  assert.equal(host.run(["claim", first], SLOT_CLAIM()).status, 0);
  assert.deepEqual(host.run(["close"], "install=inst_a\n"), { status: EXIT.lending, stdout: "held=1\nwaiting=0\n", stderr: "This host is lending slots: 1 held, and 0 promised or being made for a box.\n" });
  assert.equal(host.run(["release", first], BOX()).status, 0);
  assert.equal(host.run(["promise"], BOX("box_p")).status, 0);
  assert.equal(host.run(["close"], "install=inst_a\n").stdout, "held=0\nwaiting=1\n");
  assert.equal(host.run(["unpromise"], BOX("box_p")).status, 0);

  const spare = made(host);
  const user = `bbd-${spare}`;
  assert.ok(host.user(user));
  const close = host.run(["close"], "install=inst_a\n");
  assert.deepEqual(close, { status: 0, stdout: `closed=yes\nremoved=${spare}\n`, stderr: "" });
  assert.equal(host.user(user), null, "the spare's user is removed before the Mac is lent whole");
  assert.deepEqual(host.daemons(), [HELPER_DAEMON]);
  for (const [args, input] of [[["claim", spare], SLOT_CLAIM("box_b")], [["promise"], BOX("box_c")], [["make"], "install=inst_a\n"]] as const) {
    assert.equal(host.run(args, input).status, EXIT.deleting, args.join(" "));
  }
  assert.equal(host.run(["close"], "install=inst_a\n").status, 0, "run again, it is closed still");
  assert.equal(host.run(["open"], OPEN()).status, 0);
  assert.deepEqual(host.daemons(), [HELPER_DAEMON, PORTS_DAEMON]);
  await swept(host);
});

test("a spare being made when the host closes is removed once its step ends", async () => {
  const host = opened();
  const helper = readFileSync(join(host.root, "../host/device-host"), "utf8");
  const dispatch = "\ncase $verb in\n";
  const internal = join(host.root, "../host/device-host-internal");
  writeFileSync(internal, helper.replace(dispatch, `\n"$verb" "$@"\nexit $?${dispatch}`), { mode: 0o755 });
  const run = (args: readonly string[]) => spawnSync("/bin/sh", [internal, ...args], { encoding: "utf8", env: { ...host.env } });
  assert.equal(run(["eval", 'lock_host 60; echo 7 | put "$HOST/generation"; new_slot 7 0 "" host ""']).status, 0);
  assert.equal(host.slot("7")?.is, "making");
  assert.equal(host.run(["close"], "install=inst_a\n").status, 0, "a spare being made keeps no box");
  const carried = host.run(["continue", "7"]);
  assert.equal(carried.status, 0, carried.stderr);
  assert.equal(host.user("bbd-7"), null);
  assert.match(host.file(`${HOST}/slots/7/state`) ?? "is=gone\n", /^is=(resetting|gone)/);
  await swept(host);
});

test("the Mac's helper lends slots only while it is not lent whole, and a whole claim needs every slot released", async () => {
  const host = poolMac();
  const slot = made(host, "machine");
  const claim = host.machine(["slot", "claim", slot], SLOT_CLAIM());
  assert.equal(claim.status, 0, claim.stderr);
  const status = parseStatus(host.machine(["status"]).stdout);
  assert.equal(status.helper, 2);
  assert.deepEqual([status.slots?.kept, status.slots?.held, status.slots?.closedSince, status.slots?.model?.name], [true, 1, null, "iPhone 18 Pro"]);

  const refused = host.machine(["claim", "0"], WHOLE_CLAIM());
  assert.deepEqual(refused, { status: MACHINE_EXIT.held, stdout: "", stderr: "The pool's Mac is lending iOS slots (1 held). It is lent whole again when they are released.\n" });
  assert.equal(host.file("/var/db/bb-box/owner"), null);
  assert.equal(host.machine(["reset"]).status, MACHINE_EXIT.notOurs, "an operator's reset leaves the slots alone too");

  const released = host.machine(["slot", "release", slot], BOX());
  assert.deepEqual(released, { status: 0, stdout: "released=yes\nlast=yes\n", stderr: "" });
  const whole = host.machine(["claim", "0"], WHOLE_CLAIM());
  assert.equal(whole.status, 0, whole.stderr);
  assert.match(host.file(`${HOST}/closed`)!, /^since=\d+\n$/);
  assert.ok(!host.daemons().includes(PORTS_DAEMON), "the whole box gets the common dev ports");
  for (const [args, input] of [[["slot", "make"], "install=inst_a\n"], [["slot", "promise"], BOX("box_b")], [["slot", "claim", "1"], SLOT_CLAIM("box_b")], [["slot", "open"], OPEN()]] as const) {
    const lent = host.machine(args, input);
    assert.deepEqual([lent.status, lent.stderr], [EXIT.deleting, "The pool's Mac is lent whole to a box, so it lends no iOS slot until that box is released.\n"], args.join(" "));
  }
  assert.equal(parseStatus(host.machine(["status"]).stdout).slots?.closedSince !== null, true);
  await swept(host);
});

test("a whole claim removes the Mac's ready spare first, and the slot commands need the slots set up and a slot's number", async () => {
  const host = poolMac();
  const spare = made(host, "machine");
  assert.ok(host.user(`bbd-${spare}`));
  const whole = host.machine(["claim", "0"], WHOLE_CLAIM());
  assert.equal(whole.status, 0, whole.stderr);
  assert.equal(host.user(`bbd-${spare}`), null);
  for (const args of [["slot", "claim"], ["slot", "release", "a"], ["slot", "daemon", "1", "2"], ["slot", "bogus"], ["slot", "status", "x"]]) {
    assert.equal(host.machine(args, "").status, 2, args.join(" "));
  }
  await swept(host);

  const bare = fakeDeviceHost();
  assert.equal(bare.machine(["init"]).status, 0);
  const none = bare.machine(["slot", "status"]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /^This Mac has no iOS slots set up\./);
  assert.equal(parseStatus(bare.machine(["status"]).stdout).slots, null);
  assert.equal(bare.machine(["claim", "0"], WHOLE_CLAIM()).status, 0, "a Mac with no slots set up is lent whole as before");
});

function iosSetup(host: FakeDeviceHost, options: { list?: boolean } = {}): string {
  const dir = join(host.root, "..");
  const ios = join(dir, "tart", "ios");
  mkdirSync(join(ios, "slim"), { recursive: true });
  copyFileSync(join(dir, "host", "device-host"), join(ios, "device-host.sh"));
  for (const file of ["device-host-ports.pl", "devices.tsv", "pins", "idb-companion-LICENSE"]) copyFileSync(join(IOS, file), join(ios, file));
  if (options.list !== false) cpSync(join(IOS, "slim"), join(ios, "slim"), { recursive: true });
  const work = tempDir("idb");
  writeFileSync(join(work, "idb_companion"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", join(host.state, "flags", "idb-companion.macos-arm64.tar.gz"), "-C", work, "idb_companion"]).status, 0);
  mkdirSync(join(host.state, "users", "bbbox-admin"), { recursive: true });
  writeFileSync(join(host.state, "users", "bbbox-admin", "UniqueID"), "499\n");
  return join(dir, "pool");
}

test("mac-ios.sh installs idb_companion from its pin, the slots' helper and home, and a seed it makes by slimming a device as bb-box's admin user", () => {
  const host = fakeDeviceHost({ slim: false, template: false });
  const pool = iosSetup(host);
  const run = () => spawnSync("/bin/sh", [join(pool, "mac-ios.sh"), pool, "bbbox-admin"], { encoding: "utf8", env: { ...host.env } });
  const result = run();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `ios=27.0 24A434 ${LIST} companion=1.7.7\n`);
  assert.equal(host.file("/usr/local/share/bb-box/ios/companion"), "1.7.7\n");
  assert.ok(existsSync(join(host.root, "usr/local/lib/idb_companion-1.7.7/idb_companion")));
  assert.equal(host.file("/usr/local/share/bb-box/ios/runtimes.tsv"), `${RUNTIME}\t27.0\t24A434\t${LIST}\n`);
  const list = readFileSync(join(IOS, "slim", `${LIST}.txt`), "utf8").split("\n").filter(Boolean);
  const seed = host.file(`/usr/local/share/bb-box/ios/${LIST}.disabled.plist`)!;
  assert.equal((seed.match(/<true\/>/g) ?? []).length, list.length, "every label of the list off");
  assert.match(host.file("/usr/local/share/bb-box/slot-home/.zshenv")!, /path_helper/);
  assert.deepEqual(host.devices("bbbox-admin"), {}, "the admin user's devices are deleted once the seed is kept");
  assert.equal(host.file(`${HOST}/kept`), "", "set up as a kept host");
  assert.match(host.file(`${HOST}/closed`)!, /^since=/, "closed until bb-box opens it");
  assert.match(host.file(`${HOST}/settings`)!, /^most=12\nahead=1\nresetting-most=4\ndisk-reserve-gib=40\n/);

  const again = run();
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stderr, /kept ios-27\.0-24A434's seed, which has every label off/);
  assert.equal(host.calls().filter((line) => line.startsWith("curl")).length, 1, "idb_companion at its pin is kept");

  const short = fakeDeviceHost({ slim: false, template: false });
  const shortPool = iosSetup(short);
  short.flag("spawn-skips");
  const failed = spawnSync("/bin/sh", [join(shortPool, "mac-ios.sh"), shortPool, "bbbox-admin"], { encoding: "utf8", env: { ...short.env } });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /the seed for ios-27\.0-24A434 did not get all of its 112 labels off/);

  const unlisted = fakeDeviceHost({ slim: false, template: false });
  const unlistedPool = iosSetup(unlisted, { list: false });
  const missing = spawnSync("/bin/sh", [join(unlistedPool, "mac-ios.sh"), unlistedPool, "bbbox-admin"], { encoding: "utf8", env: { ...unlisted.env } });
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /bb-box has no slimming list for iOS 27\.0 \(24A434\), so it lends no iOS slot on this Mac/);
});
