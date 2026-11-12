import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test, type TestContext } from "node:test";
import { EXIT as MACHINE_EXIT, fields, parseStatus } from "../src/backends/ssh-pool/protocol.ts";
import { DEVICE_HOST_EXITS as EXIT, parseHostStatus } from "../src/backends/tart/device-host.ts";
import { fakeDeviceHost, type FakeDeviceHost } from "./fake-device-host.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxKeyForTests box";
const SLOT_CLAIM = (box: string) => `install=inst_a\nbox=${box}\nthread=thr_${box}\nname=ios-${box}\nkind=ios\ncreated=1790000000000\nkey=${KEY}\n`;
const BOX = (box: string, install = "inst_a") => `install=${install}\nbox=${box}\n`;
const OPEN = "install=inst_a\nmost=12\nahead=0\nresetting-most=4\ndisk-reserve-gib=40\n";
const STORES = "/var/db/bb-box/home-snapshots";
const SETTING = "Library/Developer/CoreSimulator/Devices";
const WHOLE_MAC_UID = 70000;

interface SlotMac {
  readonly host: FakeDeviceHost;
  readonly slot: string;
  readonly other: string;
}

function lines(stdout: string): Map<string, string> {
  return fields(stdout);
}

function claimed(host: FakeDeviceHost, box: string): string {
  const made = host.machine(["slot", "make"], "install=inst_a\n");
  assert.equal(made.status, 0, made.stderr);
  const slot = lines(made.stdout).get("slot")!;
  const claim = host.machine(["slot", "claim", slot], SLOT_CLAIM(box));
  assert.equal(claim.status, 0, claim.stderr);
  return slot;
}

function slotMac(): SlotMac {
  const host = fakeDeviceHost();
  assert.equal(host.run(["init"], "kept=yes\nahead=0\n").status, 0);
  assert.equal(host.run(["open"], OPEN).status, 0);
  assert.equal(host.machine(["init"]).status, 0);
  return { host, slot: claimed(host, "box_a"), other: claimed(host, "box_b") };
}

function snapshot(host: FakeDeviceHost, args: readonly string[], input = BOX("box_a")) {
  return host.machine(["snapshot", ...args], input);
}

function ok(host: FakeDeviceHost, args: readonly string[], input = BOX("box_a")): Map<string, string> {
  const result = snapshot(host, args, input);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return lines(result.stdout);
}

function homeFile(host: FakeDeviceHost, slot: string, path: string, text: string): void {
  const user = `bbd-${slot}`;
  const full = join(host.root, "Users", user, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  host.own(`Users/${user}/${path}`, 80000 + Number(slot));
}

function settingOf(host: FakeDeviceHost, slot: string): string | null {
  const udid = host.slot(slot)!.udid;
  return host.file(`/Users/bbd-${slot}/${SETTING}/${udid}/data/Library/Preferences/com.example.app.plist`);
}

function setSetting(host: FakeDeviceHost, slot: string, value: string): void {
  homeFile(host, slot, `${SETTING}/${host.slot(slot)!.udid}/data/Library/Preferences/com.example.app.plist`, value);
}

function stillRuns(host: FakeDeviceHost, uid: number, name: string): boolean {
  return host.lines("processes").some((line) => line.split(" ")[1] === String(uid) && line.split(" ")[2] === name);
}

function bystanders(host: FakeDeviceHost, other: string): () => void {
  const otherUid = 80000 + Number(other);
  host.add("processes", `61001 ${otherUid} Xcode 1`);
  host.add("processes", `61002 ${WHOLE_MAC_UID} Finder 1`);
  const otherBooted = host.slot(other)!.booted;
  const otherFile = join(host.root, "Users", `bbd-${other}`, ".zshenv");
  const otherEnv = readFileSync(otherFile, "utf8");
  return () => {
    assert.ok(stillRuns(host, otherUid, "Xcode"), "the other slot's process runs on");
    assert.ok(stillRuns(host, WHOLE_MAC_UID, "Finder"), "the whole-Mac box user's process runs on");
    assert.equal(host.slot(other)!.booted, otherBooted, "the other slot's device is as it was");
    assert.equal(host.slot(other)!.is, "held");
    assert.equal(readFileSync(otherFile, "utf8"), otherEnv, "the other slot's home is as it was");
    const signalled = host.calls().filter((call) => /^(pkill|launchctl bootout) /.test(call) && new RegExp(`(-u |/)(${otherUid}|${WHOLE_MAC_UID})\\b`).test(call));
    assert.deepEqual(signalled, [], "nothing signalled the other slot's user or the whole-Mac box user");
  };
}

function slotFolder(host: FakeDeviceHost, slot: string): string {
  return join(host.root, "var/db/bb-box/host/slots", slot);
}

function replaceTheSlotsAccount(host: FakeDeviceHost, slot: string): void {
  writeFileSync(join(host.state, "users", `bbd-${slot}`, "GeneratedUID"), "REPLACEMENT-ACCOUNT\n");
  host.add("processes", `62001 ${80000 + Number(slot)} replacement-work 1`);
}

function asAnOlderSlotHelperMadeIt(host: FakeDeviceHost, slot: string): void {
  writeFileSync(join(slotFolder(host, slot), "user-made"), "");
}

function signalledUid(host: FakeDeviceHost, uid: number): string[] {
  return host.calls().filter((call) => /^(pkill|launchctl bootout) /.test(call) && new RegExp(`(-u |/)${uid}\\b`).test(call));
}

function lockHeldElsewhere(path: string): boolean {
  return spawnSync("perl", ["-e", 'use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 2; exit(flock($f, LOCK_EX | LOCK_NB) ? 1 : 0)', path]).status === 0;
}

function pausedAt(host: FakeDeviceHost, functionName: string): { readonly reached: string; readonly go: string } {
  const reached = join(host.state, `${functionName}-reached`);
  const go = join(host.state, `${functionName}-go`);
  const helper = readFileSync(host.machineHelper, "utf8");
  assert.equal(helper.split(`${functionName}() {`).length, 2, `the helper has one ${functionName}`);
  writeFileSync(host.machineHelper, helper.replace(`${functionName}() {`, `${functionName}() {\n  touch '${reached}'\n  while [ ! -e '${go}' ]; do sleep 0.05; done`));
  return { reached, go };
}

function started(host: FakeDeviceHost, args: readonly string[], input: string): { readonly child: ChildProcess; readonly ended: Promise<{ code: number | null; output: string }> } {
  const child = spawn("/bin/sh", [host.machineHelper, ...args], { env: host.env, stdio: ["pipe", "pipe", "pipe"] });
  let output = "";
  child.stdout!.on("data", (data) => (output += data));
  child.stderr!.on("data", (data) => (output += data));
  child.stdin!.end(input);
  return { child, ended: new Promise((resolve) => child.on("exit", (code) => resolve({ code, output }))) };
}

function stateOf(host: FakeDeviceHost, slot: string): string {
  return lines(readFileSync(join(slotFolder(host, slot), "state"), "utf8")).get("is") ?? "";
}

function restoreOf(host: FakeDeviceHost, slot: string, snapshotId: string, operation: string, undo: string): void {
  ok(host, ["stop", `slot-${slot}`]);
  ok(host, ["take", `slot-${slot}`, undo]);
  ok(host, ["restore", `slot-${slot}`, snapshotId, operation]);
  ok(host, ["start", `slot-${slot}`]);
}

describe("An iOS slot on a pool Mac takes home snapshots of its slot user (090)", () => {
  test("a take, a restore with its undo and a restore of the undo bring back the slot's files and its device's setting, and boot its device again", () => {
    const { host, slot, other } = slotMac();
    const untouched = bystanders(host, other);
    homeFile(host, slot, "app/data.txt", "at the take\n");
    setSetting(host, slot, "dark\n");
    assert.equal(host.slot(slot)!.booted, true, "the slot's device runs as lent");

    const taken = ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    homeFile(host, slot, "app/data.txt", "after the take\n");
    setSetting(host, slot, "light\n");
    restoreOf(host, slot, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa", "snundoaaaaaaaa");

    assert.equal(taken.get("snapshot"), "snaaaaaaaaaaaa");
    assert.equal(host.file(`/Users/bbd-${slot}/app/data.txt`), "at the take\n");
    assert.equal(settingOf(host, slot), "dark\n");
    assert.equal(host.slot(slot)!.booted, true, "the device boots again");
    assert.equal(host.slot(slot)!.loaded, true, "the slot's daemons run again");
    assert.equal(host.slot(slot)!.is, "held");
    const info = lines(host.file(`${STORES}/bbd-${slot}/snaaaaaaaaaaaa/info`)!);
    assert.deepEqual(["user", "uid", "box", "thread", "kind", "slot"].map((key) => info.get(key)), [`bbd-${slot}`, String(80000 + Number(slot)), "box_a", "thr_box_a", "ios", slot]);
    assert.match(info.get("slot_made") ?? "", /^\d+$/);

    restoreOf(host, slot, "snundoaaaaaaaa", "opbbbbbbbbbbbb", "snundobbbbbbbb");

    assert.equal(host.file(`/Users/bbd-${slot}/app/data.txt`), "after the take\n");
    assert.equal(settingOf(host, slot), "light\n");
    untouched();
  });

  test("the stop ends only the slot user's processes, after it unloads its daemons and shuts its device down, and the start puts them back", () => {
    const { host, slot, other } = slotMac();
    const untouched = bystanders(host, other);
    const uid = 80000 + Number(slot);
    host.add("processes", `62001 ${uid} xcodebuild 1`);

    const stopped = ok(host, ["stop", `slot-${slot}`]);

    assert.equal(stopped.get("stopped"), "yes");
    assert.ok(!stillRuns(host, uid, "xcodebuild"), "the slot user's process ended");
    assert.deepEqual([host.slot(slot)!.booted, host.slot(slot)!.loaded], [false, false]);
    assert.ok(!host.daemons().some((label) => label.endsWith(`bbd-${slot}`)), "its daemons are unloaded");
    const status = parseHostStatus(host.run(["status"]).stdout)!;
    assert.deepEqual(status.stopped.map((each) => each.slot), [slot]);
    untouched();

    const daemon = host.machine(["slot", "daemon", slot], BOX("box_a"));
    assert.equal(daemon.status, EXIT.notReady, "BB's daemon is not loaded while the slot is stopped");
    assert.match(daemon.stderr, /stopped while its box is restored/);

    const started = ok(host, ["start", `slot-${slot}`]);

    assert.equal(started.get("booted"), "yes");
    assert.deepEqual([host.slot(slot)!.booted, host.slot(slot)!.loaded], [true, true]);
    assert.deepEqual(parseHostStatus(host.run(["status"]).stdout)!.stopped, []);
    untouched();
  });

  test("a restore is refused, changing nothing, until the slot is stopped for it, and while it runs again", () => {
    const { host, slot } = slotMac();
    homeFile(host, slot, "app/data.txt", "at the take\n");
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    homeFile(host, slot, "app/data.txt", "now\n");

    const refused = snapshot(host, ["restore", `slot-${slot}`, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);

    assert.equal(refused.status, MACHINE_EXIT.dirty);
    assert.match(refused.stderr, /has not been ended for a restore/);
    assert.equal(host.file(`/Users/bbd-${slot}/app/data.txt`), "now\n");
    assert.equal(host.slot(slot)!.booted, true);

    ok(host, ["stop", `slot-${slot}`]);
    assert.equal(host.run(["start", slot], BOX("box_a")).status, 0, "the slot started again outside the restore");
    const started = snapshot(host, ["restore", `slot-${slot}`, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);

    assert.equal(started.status, MACHINE_EXIT.dirty, "a slot whose daemons and device run again is not restored");
    assert.equal(host.file(`/Users/bbd-${slot}/app/data.txt`), "now\n");
  });

  test("another box, another install and a slot no box holds are refused, and nothing changes", () => {
    const { host, slot, other } = slotMac();
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);

    for (const [args, input] of [
      [["take", `slot-${slot}`, "snbbbbbbbbbbbb"], BOX("box_b")],
      [["take", `slot-${slot}`, "snbbbbbbbbbbbb"], BOX("box_a", "inst_b")],
      [["stop", `slot-${other}`], BOX("box_a")],
      [["start", `slot-${other}`], BOX("box_a")],
      [["restore", `slot-${other}`, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"], BOX("box_a")],
      [["take", "slot-99", "snbbbbbbbbbbbb"], BOX("box_a")],
    ] as const) {
      const refused = snapshot(host, args, input);
      assert.equal(refused.status, MACHINE_EXIT.notOurs, `${args.join(" ")}: ${refused.stderr}`);
    }
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`, "snbbbbbbbbbbbb")));
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${other}`)));
    assert.equal(host.slot(other)!.booted, true);
    assert.deepEqual(parseHostStatus(host.run(["status"]).stdout)!.stopped, []);
    assert.equal(snapshot(host, ["take", "slot-x", "snbbbbbbbbbbbb"]).status, MACHINE_EXIT.usage);
  });

  test("lists the slot's snapshots by box and user, and deletes one only from the slot user's own store", () => {
    const { host, slot } = slotMac();
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    const listed = snapshot(host, ["list"], "install=inst_a\n").stdout.split("\n").filter((line) => line.startsWith("snapshot="));
    assert.deepEqual(listed.map((line) => line.split("\t").filter((part) => /^(snapshot|box|user|state)=/.test(part)).join(" ")), [`snapshot=snaaaaaaaaaaaa box=box_a user=bbd-${slot} state=complete`]);

    const elsewhere = snapshot(host, ["delete", "bbx-0", "snaaaaaaaaaaaa"], "install=inst_a\n");
    assert.equal(elsewhere.status, 0, "a user's store with no such snapshot deletes nothing");
    assert.ok(existsSync(join(host.root, STORES, `bbd-${slot}`, "snaaaaaaaaaaaa")));
    assert.equal(snapshot(host, ["delete", `bbd-${slot}`, "snaaaaaaaaaaaa"], "install=inst_b\n").status, MACHINE_EXIT.notOurs, "another install's delete is refused");

    ok(host, ["delete", `bbd-${slot}`, "snaaaaaaaaaaaa"], "install=inst_a\n");
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`, "snaaaaaaaaaaaa")));
  });

  test("a live slot's store does not make the Mac dirty, and the slot's release deletes its snapshots and store before its user", async () => {
    const { host, slot, other } = slotMac();
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    ok(host, ["stop", `slot-${slot}`]);
    ok(host, ["take", `slot-${slot}`, "snundoaaaaaaaa"]);
    assert.equal(parseStatus(host.machine(["status"]).stdout).dirty, null, "a held slot's store is not an earlier box's leftovers");

    const released = host.machine(["slot", "release", slot], BOX("box_a"));

    assert.equal(released.status, 0, released.stderr);
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`)), "no snapshot of the slot is left");
    assert.equal(host.user(`bbd-${slot}`), null);
    assert.equal(host.slot(other)!.is, "held");
    await host.until("the sweep queue emptied", () => host.status().values.get("sweeping") === "0");
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`)));
  });

  test("the slot's reset leaves a store with anything it cannot prove is the slot's own, deletes nothing of it, and fails until a person checks it", () => {
    const { host, slot } = slotMac();
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    const stranger = join(host.root, STORES, `bbd-${slot}`, "snstrangerxxxx");
    mkdirSync(stranger);
    writeFileSync(join(stranger, "info"), `install=inst_a\nbox=box_a\nuser=bbd-${slot}\nuid=${80000 + Number(slot)}\nslot_made=1\n`);

    const released = host.machine(["slot", "release", slot], BOX("box_a"));

    assert.notEqual(released.status, 0);
    assert.match(released.stderr, /snstrangerxxxx is not a snapshot this install took of bbd-\d+ in this slot/);
    assert.ok(existsSync(join(stranger, "info")), "the folder it cannot prove stays");
    assert.ok(existsSync(join(host.root, STORES, `bbd-${slot}`, "snaaaaaaaaaaaa", "home")), "and so does every snapshot beside it");
    assert.ok(host.user(`bbd-${slot}`), "the slot's user stays until its snapshots are gone");
    assert.equal(snapshot(host, ["forget-slot", slot], "").status, MACHINE_EXIT.notOurs);
  });

  test("forget-slot deletes nothing of a slot a box still holds", () => {
    const { host, slot } = slotMac();
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);

    const refused = snapshot(host, ["forget-slot", slot], "");

    assert.equal(refused.status, MACHINE_EXIT.dirty);
    assert.match(refused.stderr, /is held, not being removed/);
    assert.ok(existsSync(join(host.root, STORES, `bbd-${slot}`, "snaaaaaaaaaaaa", "home")));
  });

  test("a take waits for the slot's lock, so no claim, release or reset of that slot runs in the middle of it", async (t: TestContext) => {
    const { host, slot } = slotMac();
    const lock = join(host.root, "var/db/bb-box/host/slots", slot, "lock");
    const holder = spawn("perl", ["-e", 'use Fcntl ":flock"; $| = 1; open(my $f, ">>", $ARGV[0]) or die; flock($f, LOCK_EX) or die; print "held\\n"; sleep 2', lock], { stdio: ["ignore", "pipe", "ignore"] });
    t.after(() => holder.kill("SIGKILL"));
    await new Promise<void>((resolve) => holder.stdout!.once("data", () => resolve()));
    const store = join(host.root, STORES, `bbd-${slot}`, "snaaaaaaaaaaaa");

    const taking = new Promise<number | null>((resolve) => spawn("/bin/sh", [host.machineHelper, "snapshot", "take", `slot-${slot}`, "snaaaaaaaaaaaa"], { env: host.env, stdio: ["pipe", "ignore", "ignore"] }).on("exit", resolve).stdin!.end(BOX("box_a")));
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const whileHeld = existsSync(store);
    const code = await taking;

    assert.equal(whileHeld, false, "nothing is taken while another command holds the slot's lock");
    assert.equal(code, 0);
    assert.ok(existsSync(join(store, "home")), "the take ran once the lock was let go");
  });
});

describe("A slot's snapshots act only on the account the device host made, checked by its UID and GeneratedUID (090 unit 3)", () => {
  test("a stop of a replacement account with the slot user's name and UID is refused, and ends none of its processes", () => {
    const { host, slot } = slotMac();
    const uid = 80000 + Number(slot);
    replaceTheSlotsAccount(host, slot);

    const refused = snapshot(host, ["stop", `slot-${slot}`]);

    assert.equal(refused.status, MACHINE_EXIT.failed);
    assert.match(refused.stderr, /UID or GeneratedUID differs from the record/);
    assert.ok(stillRuns(host, uid, "replacement-work"), "the replacement account's process runs on");
    assert.deepEqual(signalledUid(host, uid), []);
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`)), "no store or session is made for it");
    assert.deepEqual(parseHostStatus(host.run(["status"]).stdout)!.stopped, []);
  });

  test("a take and a restore of a replacement account are refused, and its home is as it was", () => {
    const { host, slot } = slotMac();
    homeFile(host, slot, "app/data.txt", "at the take\n");
    ok(host, ["take", `slot-${slot}`, "snaaaaaaaaaaaa"]);
    homeFile(host, slot, "app/data.txt", "now\n");
    ok(host, ["stop", `slot-${slot}`]);
    ok(host, ["take", `slot-${slot}`, "snundoaaaaaaaa"]);
    replaceTheSlotsAccount(host, slot);

    const take = snapshot(host, ["take", `slot-${slot}`, "snbbbbbbbbbbbb"]);
    const restore = snapshot(host, ["restore", `slot-${slot}`, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);

    for (const refused of [take, restore]) {
      assert.equal(refused.status, MACHINE_EXIT.failed);
      assert.match(refused.stderr, /UID or GeneratedUID differs from the record/);
    }
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`, "snbbbbbbbbbbbb")));
    assert.equal(host.file(`/Users/bbd-${slot}/app/data.txt`), "now\n");
    assert.ok(stillRuns(host, 80000 + Number(slot), "replacement-work"));
  });

  test("a start of a replacement account is refused, by the pool helper and by the device host itself, and nothing of the slot runs again", () => {
    for (const startOf of [
      (host: FakeDeviceHost, slot: string) => snapshot(host, ["start", `slot-${slot}`]),
      (host: FakeDeviceHost, slot: string) => host.run(["start", slot], BOX("box_a")),
    ]) {
      const { host, slot } = slotMac();
      ok(host, ["stop", `slot-${slot}`]);
      replaceTheSlotsAccount(host, slot);

      const refused = startOf(host, slot);

      assert.equal(refused.status, MACHINE_EXIT.failed, refused.stderr);
      assert.match(refused.stderr, /UID or GeneratedUID differs from the record/);
      assert.deepEqual([host.slot(slot)!.booted, host.slot(slot)!.loaded], [false, false], "its device and daemons stay stopped");
      assert.deepEqual(parseHostStatus(host.run(["status"]).stdout)!.stopped.map((each) => each.slot), [slot]);
    }
  });

  test("a slot made by an older slot helper, with no GeneratedUID on record, is refused snapshots with the reason, and is lent as before", () => {
    const host = fakeDeviceHost();
    assert.equal(host.run(["init"], "kept=yes\nahead=0\n").status, 0);
    assert.equal(host.run(["open"], OPEN).status, 0);
    assert.equal(host.machine(["init"]).status, 0);
    const made = host.machine(["slot", "make"], "install=inst_a\n");
    const slot = lines(made.stdout).get("slot")!;
    assert.match(readFileSync(join(slotFolder(host, slot), "user-made"), "utf8"), /^generated_uid=[0-9A-F-]{36}$/m, "a new slot records its user's GeneratedUID");
    asAnOlderSlotHelperMadeIt(host, slot);

    const claim = host.machine(["slot", "claim", slot], SLOT_CLAIM("box_a"));

    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(host.slot(slot)!.is, "held");
    for (const args of [["take", `slot-${slot}`, "snaaaaaaaaaaaa"], ["stop", `slot-${slot}`]]) {
      const refused = snapshot(host, args);
      assert.equal(refused.status, MACHINE_EXIT.dirty, refused.stderr);
      assert.match(refused.stderr, /made by an older slot helper, which kept no record of its user's GeneratedUID, so it has no snapshots\. It lends as before/);
    }
    const direct = host.run(["stop", slot], BOX("box_a"));
    assert.equal(direct.status, EXIT.notReady);
    assert.match(direct.stderr, /made by an older slot helper/);
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`)));
    assert.equal(host.slot(slot)!.booted, true, "its device runs on");
    assert.deepEqual(parseHostStatus(host.run(["status"]).stdout)!.stopped, []);
  });
});

describe("A slot's stop and start check and change its session under the slot's lock, so a release waits for them (090 unit 3)", () => {
  test("a release while a stop is between its check and its changes waits, then deletes the store, and nothing is made again", async () => {
    const { host, slot } = slotMac();
    const lock = join(slotFolder(host, slot), "lock");
    const barrier = pausedAt(host, "end_slot_session");
    const stop = started(host, ["snapshot", "stop", `slot-${slot}`], BOX("box_a"));
    await host.until("the stop checked the slot is the box's", () => existsSync(barrier.reached));

    assert.ok(lockHeldElsewhere(lock), "the stop holds the slot's lock from its check on");
    const release = started(host, ["slot", "release", slot], BOX("box_a"));
    await host.until("the release marked the slot", () => stateOf(host, slot) === "releasing");
    assert.ok(host.user(`bbd-${slot}`), "the release waits for the stop before it removes the user");
    writeFileSync(barrier.go, "");
    const [stopped, released] = await Promise.all([stop.ended, release.ended]);

    assert.equal(stopped.code, MACHINE_EXIT.notOurs, stopped.output);
    assert.match(stopped.output, /no box holds it/);
    assert.equal(released.code, 0, released.output);
    assert.equal(host.user(`bbd-${slot}`), null);
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`, ".session")), "no session file is left");
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`)), "no store is left");
  });

  test("a start removes the session file under the slot's lock", async () => {
    const { host, slot } = slotMac();
    ok(host, ["stop", `slot-${slot}`]);
    const barrier = pausedAt(host, "start_slot_session");
    const start = started(host, ["snapshot", "start", `slot-${slot}`], BOX("box_a"));
    await host.until("the start checked the slot is the box's", () => existsSync(barrier.reached));

    const heldDuringStart = lockHeldElsewhere(join(slotFolder(host, slot), "lock"));
    writeFileSync(barrier.go, "");
    const ended = await start.ended;

    assert.equal(heldDuringStart, true, "the start holds the slot's lock from its check on");
    assert.equal(ended.code, 0, ended.output);
    assert.ok(!existsSync(join(host.root, STORES, `bbd-${slot}`, ".session")));
    assert.equal(host.slot(slot)!.booted, true);
  });
});

describe("The proof of home snapshots on a Mac that lends iOS slots (090 unit 3)", () => {
  test("makes a scratch slot user and device, takes with the device booted, restores with an undo, finds the device as at the take, boots it, and removes what it made", () => {
    const host = fakeDeviceHost();
    assert.equal(host.run(["init"], "kept=yes\nahead=0\n").status, 0);
    assert.equal(host.run(["open"], OPEN).status, 0);
    assert.equal(host.machine(["init"]).status, 0);
    host.flag("sims-in-home");
    host.flag("sudo-processes");
    const usersBefore = host.users();

    const proof = host.machine(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.doesNotMatch(proof.stdout, /^FAILED/m);
    const slotUser = /for an iOS slot, (\S+) \(UID (\d+)\)/.exec(proof.stdout)!;
    for (const check of [
      `made ${slotUser[1]}, UID ${slotUser[2]}, a scratch user for an iOS slot, with no console session, as slot users have none`,
      "the device still runs after the take",
      "the stop ended the slot user's processes, its device's with them",
      "a file in the slot user's home is as at the take",
      "simctl lists the device as at the take",
      "simctl no longer lists the device made after the take",
      "the setting inside the device is as at the take: one",
      "the undo puts back the device made after the take",
      "the device boots after the undo, its setting two",
      `removed ${slotUser[1]} and what the proof made for it`,
    ]) {
      assert.ok(proof.stdout.split("\n").includes(`ok: ${check}`), `${check}\n${proof.stdout}`);
    }
    assert.match(proof.stdout, /^ok: the device boots after the restore, in \d+ s$/m);
    assert.match(proof.stdout, /^result: passed/m);
    assert.deepEqual(host.users(), usersBefore, "every scratch user is gone");
    assert.deepEqual(readdirSync(join(host.root, "private/var/tmp")).filter((name) => name.startsWith("com.apple.CoreSimulator.SimDevice.")), [], "no device's folder is left outside the home");
    assert.ok(!existsSync(join(host.root, STORES, slotUser[1]!)));
    assert.ok(!existsSync(join(host.root, "var/db/bb-box/proof-made")));
  });

  test("a proof ended during its scratch device's first boot leaves nothing of the device once the next proof recovers", async () => {
    const host = fakeDeviceHost();
    assert.equal(host.run(["init"], "kept=yes\nahead=0\n").status, 0);
    assert.equal(host.run(["open"], OPEN).status, 0);
    assert.equal(host.machine(["init"]).status, 0);
    host.flag("sims-in-home");
    host.flag("sudo-processes");
    host.flag("boot-waits");
    const usersBefore = host.users();
    const proof = started(host, ["snapshot", "proof"], "");
    const waiting = join(host.state, "flags", "boot-waiting");
    await host.until("the scratch device's first boot began", () => existsSync(waiting));

    proof.child.kill("SIGKILL");
    const killed = await proof.ended;
    const udid = /^ok: simctl made device (\S+),/m.exec(killed.output)![1]!;
    const slotUser = /for an iOS slot, (\S+) \(UID/.exec(killed.output)![1]!;
    const deviceStore = join(host.root, "private/var/tmp", `com.apple.CoreSimulator.SimDevice.${udid}`);
    assert.ok(existsSync(deviceStore), "the boot had made the device's folder");
    rmSync(join(host.state, "flags", "boot-waits"));
    const booting = Number(readFileSync(waiting, "utf8"));
    host.flag("boot-go");
    await host.until("the cut-short boot ended", () => {
      try {
        process.kill(booting, 0);
        return false;
      } catch {
        return true;
      }
    });

    const recovered = host.machine(["snapshot", "proof"]);

    assert.equal(killed.code, null);
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.match(recovered.stdout, /^note: removed what the earlier proof made$/m);
    assert.match(recovered.stdout, /^result: passed/m);
    assert.ok(!existsSync(deviceStore), "the device's folder outside the home is gone");
    assert.ok(!existsSync(join(host.root, "Users", slotUser)), "and so is the home that held its registry entry");
    assert.equal(host.user(slotUser), null);
    assert.deepEqual(host.users(), usersBefore);
    assert.ok(!existsSync(join(host.root, "var/db/bb-box/proof-made")));
  });

  test("on a Mac with no iOS slots, says it checked no slot user's device", () => {
    const host = fakeDeviceHost();
    assert.equal(host.machine(["init"]).status, 0);
    host.flag("sudo-processes");

    const proof = host.machine(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /^note: this Mac lends no iOS slots, so the proof checked no slot user's device$/m);
  });
});
