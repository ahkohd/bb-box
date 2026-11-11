import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fields } from "../src/backends/ssh-pool/protocol.ts";
import { fakeMacos, type FakeMacos } from "./fake-macos.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxKeyForTests box";
const CLAIM = `install=inst_a\nbox=box_a\nthread=thr_a\nname=mac-box\nkind=macos-desktop\ncreated=1790000000000\nkey=${KEY}\n`;
const BOX_A = "install=inst_a\nbox=box_a\n";
const BOX_B = "install=inst_a\nbox=box_b\n";
const OTHER_INSTALL = "install=inst_b\nbox=box_a\n";
const UID = 70000;
const STORE = "var/db/bb-box/home-snapshots/bbx-0";
const SIGNING_IN = 10;

function lentMac(): FakeMacos {
  const mac = fakeMacos();
  assert.equal(mac.helper(["init"]).status, 0);
  const claim = mac.helper(["claim", "0"], CLAIM);
  assert.equal(claim.status, 0, claim.stderr);
  return mac;
}

function write(mac: FakeMacos, path: string, text: string): void {
  const full = join(mac.root, path);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, text);
  mac.own(path, UID);
}

function run(mac: FakeMacos, args: readonly string[], input = BOX_A) {
  return mac.helper(["snapshot", ...args], input);
}

function ok(mac: FakeMacos, args: readonly string[], input = BOX_A): Map<string, string> {
  const result = run(mac, args, input);
  assert.equal(result.status, 0, `${args.join(" ")}: ${result.stderr}`);
  return fields(result.stdout);
}

function autologin(mac: FakeMacos): string | null {
  const file = join(mac.state, "defaults", "_Library_Preferences_com.apple.loginwindow", "autoLoginUser");
  return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
}

function restored(mac: FakeMacos, snapshot: string, operation: string): void {
  ok(mac, ["stop", "0"]);
  ok(mac, ["restore", "0", snapshot, operation]);
}

describe("A Mac lent whole takes home snapshots of its box user (090)", () => {
  test("a take pauses the box user's processes, clones its home into the store only root can read, and resumes them", () => {
    const mac = lentMac();
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");

    const taken = ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(taken.get("snapshot"), "snaaaaaaaaaaaa");
    assert.match(taken.get("paused_ms") ?? "", /^\d+$/);
    assert.equal(mac.file(`${STORE}/snaaaaaaaaaaaa/home/work/notes.txt`), "before\n");
    assert.deepEqual(mac.lines("signals"), [`STOP ${UID}`, `CONT ${UID}`]);
    assert.equal(mac.file(`${STORE}/.paused`), null, "no pause is left marked");
    const info = fields(mac.file(`${STORE}/snaaaaaaaaaaaa/info`)!);
    assert.deepEqual([info.get("install"), info.get("box"), info.get("thread"), info.get("user")], ["inst_a", "box_a", "thr_a", "bbx-0"]);
  });

  test("a take resumes a process that stopped itself when the box user's processes stopped, as sudo does above a box command", () => {
    const mac = lentMac();
    const parent = spawn("sleep", ["30"], { stdio: "ignore" });
    mac.flag("parent-stops-too", true, String(parent.pid));

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    const state = spawnSync("ps", ["-o", "stat=", "-p", String(parent.pid)], { encoding: "utf8" }).stdout.trim();
    parent.kill("SIGKILL");
    assert.doesNotMatch(state, /^T/, `the process is ${state}`);
  });

  test("a take asked again answers as the first, and pauses nothing", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    const again = ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(again.get("snapshot"), "snaaaaaaaaaaaa");
    assert.equal(mac.lines("signals").length, 2);
  });

  test("only the box that holds the Mac takes, from this install", () => {
    const mac = lentMac();

    assert.equal(run(mac, ["take", "0", "snaaaaaaaaaaaa"], BOX_B).status, 4);
    assert.equal(run(mac, ["take", "0", "snaaaaaaaaaaaa"], OTHER_INSTALL).status, 4);
    assert.equal(run(mac, ["take", "1", "snaaaaaaaaaaaa"]).status, 4);
    assert.equal(run(mac, ["take", "0", "../escape"]).status, 2);
    assert.equal(mac.file(`${STORE}/snaaaaaaaaaaaa/info`), null);
  });

  test("a Mac that lends no box whole, as when it lends iOS slots, refuses a take with the reason", () => {
    const mac = fakeMacos();
    assert.equal(mac.helper(["init"]).status, 0);

    const refused = run(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(refused.status, 4);
    assert.match(refused.stderr, /No box holds the Mac/);
  });

  test("the list gives this install's snapshots with their box, and the room on the homes' volume", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    const listed = run(mac, ["list"], "install=inst_a\n").stdout;
    const others = run(mac, ["list"], "install=inst_b\n").stdout;

    const line = listed.split("\n").find((each) => each.startsWith("snapshot="))!;
    const values = new Map(line.split("\t").map((part) => [part.slice(0, part.indexOf("=")), part.slice(part.indexOf("=") + 1)]));
    assert.deepEqual([values.get("snapshot"), values.get("box"), values.get("state"), values.get("user")], ["snaaaaaaaaaaaa", "box_a", "complete", "bbx-0"]);
    assert.match(listed, /^store\.free_kib=\d+$/m);
    assert.doesNotMatch(others, /^snapshot=/m);
  });

  test("a take killed while it paused the box user is resumed by the next command", () => {
    const mac = lentMac();
    mkdirSync(join(mac.root, STORE), { recursive: true });
    writeFileSync(join(mac.root, STORE, ".paused"), "999999\n");

    assert.equal(mac.helper(["status"]).status, 0);

    assert.deepEqual(mac.lines("signals"), [`CONT ${UID}`]);
    assert.equal(mac.file(`${STORE}/.paused`), null);
  });

  test("a take that fails to clone resumes the box user and keeps no part of the snapshot", () => {
    const mac = lentMac();
    mac.flag("no-clone");

    const failed = run(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not clone bbx-0's home/);
    assert.deepEqual(mac.lines("signals"), [`STOP ${UID}`, `CONT ${UID}`]);
    assert.deepEqual(readdirSync(join(mac.root, STORE)), []);
  });
});

describe("A restore of a home snapshot (090)", () => {
  test("puts back the home as at the take, with its ACLs, and signs the user in again where it was", () => {
    const mac = lentMac();
    mac.setConsole("bbx-0");
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");
    write(mac, "Users/bbx-0/Library/Keychains/login.keychain-db", "keychain at take\n");
    mac.add("acls", `${mac.data}/Users/bbx-0/Desktop\tgroup:everyone deny delete`);
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    write(mac, "Users/bbx-0/work/notes.txt", "after\n");
    write(mac, "Users/bbx-0/work/later.txt", "later\n");
    write(mac, "Users/bbx-0/Library/Keychains/login.keychain-db", "keychain later\n");

    const stopped = ok(mac, ["stop", "0"]);
    assert.equal(stopped.get("console"), "yes");
    assert.equal(autologin(mac), null, "the automatic login is cleared before the session ends");
    assert.equal(mac.console(), "root");
    ok(mac, ["take", "0", "snundoundoundo"]);
    const answer = ok(mac, ["restore", "0", "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);
    assert.equal(answer.get("restored"), "snaaaaaaaaaaaa");

    assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "before\n");
    assert.equal(mac.file("Users/bbx-0/work/later.txt"), null);
    assert.equal(mac.file("Users/bbx-0/Library/Keychains/login.keychain-db"), "keychain at take\n");
    assert.ok(mac.lines("acls").includes(`${mac.data}/Users/bbx-0/Desktop\tgroup:everyone deny delete`));
    assert.equal(mac.file(`${STORE}/snundoundoundo/home/work/later.txt`), "later\n", "the undo holds the home before the restore");
    assert.equal(mac.file(`${STORE}/.replaced/work/notes.txt`), null, "the replaced home is deleted");

    assert.equal(run(mac, ["start", "0"]).status, SIGNING_IN);
    assert.equal(autologin(mac), "bbx-0");
    const started = ok(mac, ["start", "0"]);
    assert.equal(started.get("console"), "bbx-0");
    assert.equal(mac.file(`${STORE}/.session`), null);
  });

  test("leaves a user that was not signed in signed out, and restarts nothing", () => {
    const mac = lentMac();
    mac.setConsole("root");
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    restored(mac, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa");
    const kickstarts = () => mac.calls().filter((call) => call.startsWith("launchctl kickstart")).length;
    const before = kickstarts();

    const started = ok(mac, ["start", "0"]);

    assert.equal(started.get("console"), "root");
    assert.equal(kickstarts(), before);
  });

  test("restarts userspace when loginwindow does not sign the user in again", () => {
    const mac = lentMac();
    mac.setConsole("bbx-0");
    mac.flag("loginwindow-waits");
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    restored(mac, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa");
    mac.clock(1_000_000);
    assert.equal(run(mac, ["start", "0"]).status, SIGNING_IN);

    mac.clock(1_000_031);
    const later = run(mac, ["start", "0"]);

    assert.equal(later.status, SIGNING_IN);
    assert.match(later.stdout, /^signin=userspace$/m);
  });

  test("asked again with the same operation, changes nothing", () => {
    const mac = lentMac();
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    restored(mac, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa");
    write(mac, "Users/bbx-0/work/notes.txt", "written after the restore\n");

    ok(mac, ["restore", "0", "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);

    assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "written after the restore\n");
  });

  test("cut short with the home moved aside, finishes when asked again", () => {
    const mac = lentMac();
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    write(mac, "Users/bbx-0/work/notes.txt", "after\n");
    ok(mac, ["stop", "0"]);
    mkdirSync(join(mac.root, STORE, ".restoring", "work"), { recursive: true });
    writeFileSync(join(mac.root, STORE, ".restoring", "work", "notes.txt"), "before\n");
    mac.helper(["status"]);
    assert.equal(spawnMove(mac, "Users/bbx-0", `${STORE}/.replaced`), 0);

    ok(mac, ["restore", "0", "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]);

    assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "before\n");
    assert.equal(existsSync(join(mac.root, STORE, ".replaced")), false);
  });

  test("refuses a snapshot that is not there, and a home whose session was not ended", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(run(mac, ["restore", "0", "snaaaaaaaaaaaa", "opaaaaaaaaaaaa"]).status, 5);
    ok(mac, ["stop", "0"]);
    assert.equal(run(mac, ["restore", "0", "snbbbbbbbbbbbb", "opaaaaaaaaaaaa"]).status, 4);
  });

  test("clears the user's temporary and cache folders outside the home", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    write(mac, "private/var/folders/zz/user70000/T/module.cache", "stale\n");
    write(mac, "private/var/folders/zz/user70000/C/cache.db", "stale\n");
    mac.own("private/var/folders/zz/user70000", UID);

    restored(mac, "snaaaaaaaaaaaa", "opaaaaaaaaaaaa");

    assert.equal(mac.file("private/var/folders/zz/user70000/T/module.cache"), null);
    assert.equal(mac.file("private/var/folders/zz/user70000/C/cache.db"), null);
  });
});

function spawnMove(mac: FakeMacos, from: string, to: string): number {
  const result = mac.tool("mv", [join(mac.root, from), join(mac.root, to)]);
  return result.status ?? 1;
}

describe("Deleting home snapshots and releasing their box (090)", () => {
  test("a delete removes the snapshot, and again succeeds", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    ok(mac, ["delete", "snaaaaaaaaaaaa"], "install=inst_a\n");
    ok(mac, ["delete", "snaaaaaaaaaaaa"], "install=inst_a\n");

    assert.equal(existsSync(join(mac.root, STORE, "snaaaaaaaaaaaa")), false);
  });

  test("another install's delete leaves the snapshot", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(run(mac, ["delete", "snaaaaaaaaaaaa"], "install=inst_b\n").status, 4);

    assert.equal(existsSync(join(mac.root, STORE, "snaaaaaaaaaaaa")), true);
  });

  test("the release deletes the box user's snapshots with it", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    const released = mac.helper(["release", "0"], BOX_A);

    assert.ok(released.status === 0 || released.status === SIGNING_IN, released.stderr);
    assert.equal(existsSync(join(mac.root, STORE)), false);
  });

  test("a snapshot an earlier box left keeps the Mac from its next claim", () => {
    const mac = fakeMacos();
    assert.equal(mac.helper(["init"]).status, 0);
    mkdirSync(join(mac.root, "var/db/bb-box/home-snapshots/bbx-9/snaaaaaaaaaaaa"), { recursive: true });

    const claim = mac.helper(["claim", "0"], CLAIM);

    assert.equal(claim.status, 5);
    assert.match(claim.stderr, /home-snapshots\/bbx-9/);
  });
});

describe("Forks of home snapshots on the helper (090)", () => {
  test("make a new user from the snapshot, its files its own, without BB's machine, access file, launch agent, keychains or plists naming the source", () => {
    const mac = lentMac();
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");
    write(mac, "Users/bbx-0/.bb-machines/bb/host-id", "host\n");
    write(mac, "Users/bbx-0/.config/bb-box/env", "secret\n");
    write(mac, "Users/bbx-0/Library/LaunchAgents/app.getbb.daemon.plist", "agent\n");
    write(mac, "Users/bbx-0/Library/Keychains/login.keychain-db", "keychain\n");
    write(mac, "Users/bbx-0/Library/Keychains/0A1B2C3D-0000-4000-8000-000000000001/keychain-2.db", "keychain\n");
    write(mac, "Users/bbx-0/Library/Preferences/com.apple.photolibraryd.plist", "<string>/Users/bbx-0/Pictures</string>\n");
    write(mac, "Users/bbx-0/.ssh/id_ed25519", "the user's own key\n");
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    const fork = ok(mac, ["fork", "snaaaaaaaaaaaa", "bbx-fork", "70500"], "install=inst_a\n");

    assert.equal(fork.get("left"), "");
    assert.equal(fork.get("signin"), "userspace");
    assert.equal(mac.file("Users/bbx-fork/work/notes.txt"), "before\n");
    assert.equal(mac.file("Users/bbx-fork/.ssh/id_ed25519"), "the user's own key\n");
    for (const gone of [".bb-machines/bb/host-id", ".config/bb-box/env", "Library/LaunchAgents/app.getbb.daemon.plist", "Library/Keychains/login.keychain-db", "Library/Keychains/0A1B2C3D-0000-4000-8000-000000000001", "Library/Preferences/com.apple.photolibraryd.plist"]) {
      assert.equal(existsSync(join(mac.root, "Users/bbx-fork", gone)), false, gone);
    }
    assert.ok(mac.lines("owners").includes(`70500 ${mac.data}/Users/bbx-fork/work/notes.txt`));
    assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "before\n");
  });

  test("are refused with the reason where another user shares the Mac", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    mkdirSync(join(mac.state, "users", "bbx-7"), { recursive: true });
    writeFileSync(join(mac.state, "users", "bbx-7", "UniqueID"), "70007\n");

    const refused = run(mac, ["fork", "snaaaaaaaaaaaa", "bbx-fork", "70500"], "install=inst_a\n");

    assert.equal(refused.status, 5);
    assert.match(refused.stderr, /The Mac is shared \(box user bbx-7\), so it makes no fork/);
    assert.equal(mac.user("bbx-fork"), null);
  });
});

describe("The proof of home snapshots (090)", () => {
  test("runs on a free Mac on a scratch user, passes, and leaves nothing of it", () => {
    const mac = fakeMacos();
    assert.equal(mac.helper(["init"]).status, 0);
    mac.flag("sudo-processes");

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /^result: passed/m);
    assert.doesNotMatch(proof.stdout, /^FAILED/m);
    assert.match(proof.stdout, /^ok: a fork is refused while another user shares the Mac: The Mac is shared \(box user bbx-0\)/m);
    assert.deepEqual(mac.users(), ["bbx-0", "person"]);
    assert.equal(existsSync(join(mac.root, "var/db/bb-box/home-snapshots")), false);
  });

  test("refuses while a box holds the Mac, and changes nothing", () => {
    const mac = lentMac();

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 3);
    assert.match(proof.stderr, /Run the proof while the Mac is free/);
    assert.deepEqual(mac.users(), ["bbx-0", "person"]);
  });
});
