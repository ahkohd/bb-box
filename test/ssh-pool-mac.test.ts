// The SSH host pool's Mac helper and setup (047), run on Linux against a fake
// Mac: stub macOS tools that keep its state in files (test/fake-macos.ts).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, fields, parseStatus } from "../src/backends/ssh-pool/protocol.ts";
import { fakeMacos, type FakeMacos } from "./fake-macos.ts";
import { tempDir } from "./helpers.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBoxKeyForTests box";
const CLAIM = (box = "box_a", install = "inst_a") =>
  `install=${install}\nbox=${box}\nthread=thr_a\nname=mac-box\nkind=macos-desktop\ncreated=1790000000000\nkey=${KEY}\n`;
const RELEASE = (box = "box_a", install = "inst_a") => `install=${install}\nbox=${box}\n`;
const NOT_READY = "Box user bbx-0 is not ready. Reset the Mac: sudo /usr/local/libexec/bb-box/machine reset\n";
/** The privacy database: the helper has Full Disk Access when it can read it. */
const TCC = "Library/Application Support/com.apple.TCC/TCC.db";

/** A fake Mac set up with its first box user, bbx-0, signed in. */
function readyMac(): FakeMacos {
  const mac = fakeMacos();
  const init = mac.helper(["init"]);
  assert.equal(init.status, 0, init.stderr);
  return mac;
}

/** A fake Mac lent to box_a, at generation 0. */
function lentMac(): FakeMacos {
  const mac = readyMac();
  const claim = mac.helper(["claim", "0"], CLAIM());
  assert.equal(claim.status, 0, claim.stderr);
  return mac;
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function count(mac: FakeMacos, call: string): number {
  return mac.calls().filter((line) => line.startsWith(call)).length;
}

/** Waits for a call the helper makes 2 seconds after it answers, as when it restarts userspace or the Mac. */
async function waitForCall(mac: FakeMacos, call: string): Promise<void> {
  for (let i = 0; i < 50 && count(mac, call) === 0; i++) await pause(100);
  assert.equal(count(mac, call), 1, `${call} ran once`);
}

test("init makes the first box user, hidden and in _developer, from the home template, and loginwindow signs it in", () => {
  const mac = readyMac();
  assert.deepEqual(mac.users(), ["bbx-0", "person"]);
  const user = mac.user("bbx-0")!;
  assert.deepEqual([user.UniqueID, user.RealName, user.IsHidden, user.NFSHomeDirectory], ["70000", "bb-box bbx-0", "1", "/Users/bbx-0"]);
  assert.deepEqual(mac.members("_developer"), ["bbx-0"]);
  assert.match(mac.file("/Users/bbx-0/.zshenv")!, /path_helper/);
  assert.match(mac.file("/Users/bbx-0/Library/LaunchAgents/com.trycua.cua-driver.plist")!, /<string>serve<\/string>/);
  assert.match(
    mac.file("/Users/bbx-0/Library/Preferences/ByHost/com.apple.screensaver.0A1B2C3D-0000-4000-8000-000000000001.plist")!,
    /<key>idleTime<\/key><integer>0<\/integer>/,
  );
  assert.ok(mac.lines("owners").some((line) => line === `70000 ${mac.data}/Users/bbx-0/.zshenv`), "the home is the user's");

  const password = mac.file("/var/db/bb-box/passwords/bbx-0")!;
  assert.match(password, /^[A-Za-z0-9]{24}\n$/);
  assert.equal(password, readFileSync(join(mac.state, "secrets", "bbx-0"), "utf8"), "the password the user was made with");
  assert.equal(statSync(join(mac.root, "var/db/bb-box/passwords/bbx-0")).mode & 0o777, 0o600);
  assert.equal(statSync(join(mac.root, "var/db/bb-box/passwords")).mode & 0o777, 0o700);
  assert.ok(!mac.calls().some((line) => line.includes(password.trim())), "the password is in no command's arguments");
  assert.equal(readFileSync(join(mac.state, "defaults", "_Library_Preferences_com.apple.loginwindow", "autoLoginUser"), "utf8"), "bbx-0\n");
  assert.equal(statSync(join(mac.root, "etc/kcpassword")).mode & 0o777, 0o600);
  assert.equal(mac.console(), "bbx-0", "loginwindow read the password in /etc/kcpassword");
  assert.equal(count(mac, "launchctl disable gui/70000/com.apple.backgroundtaskmanagement.agent"), 1);

  const again = mac.helper(["init"]);
  assert.deepEqual([again.status, again.stdout], [0, "generation=0\n"]);
  assert.equal(count(mac, "sysadminctl -addUser"), 1, "a ready user is kept");
  assert.equal(count(mac, "launchctl kickstart"), 1, "loginwindow starts again only with nobody at the console");

  const personal = fakeMacos();
  personal.setConsole("person");
  assert.equal(personal.helper(["init"]).status, 0);
  assert.equal(personal.console(), "person", "a person signed in stays signed in");
  assert.equal(count(personal, "launchctl kickstart"), 0);
});

test("status gives the pool the Linux helper's keys, and the Mac's user, console and automatic login, with Cua's grants only when asked", () => {
  const mac = readyMac();
  mac.flag("screensharing");
  writeFileSync(join(mac.root, "usr/local/bin/cua-driver"), `#!/bin/sh\necho '{"accessibility": true, "screen_recording": false}'\n`, { mode: 0o755 });
  const cua = "launchctl asuser 70000 /usr/bin/sudo -n -H -u bbx-0 -- /usr/local/bin/cua-driver permissions status --json";
  const result = mac.helper(["status"]);
  assert.equal(result.status, 0, result.stderr);
  const status = parseStatus(result.stdout);
  assert.deepEqual(
    { ...status, diskGiB: null },
    {
      helper: 1, arch: "arm64", boot: "6F0E2A1C-0000-4000-8000-000000000001", generation: 0, marker: "none", owner: null, hook: false,
      docker: false, systemd: false, cores: 8, memoryMiB: 16384, diskGiB: null, missing: [], enrolment: { node: "24.9.0", lacks: [] }, dirty: null,
      mac: { version: "26.0", user: "bbx-0", console: "bbx-0", autologin: "bbx-0", fileVault: false, screenSharing: true, fullDisk: true, grants: null, xcode: { version: null, runtimes: [] } },
    },
  );
  const values = fields(result.stdout);
  assert.deepEqual(
    ["os", "macos", "user", "console", "autologin", "filevault", "screensharing", "fulldisk"].map((key) => values.get(key)),
    ["macos", "26.0", "bbx-0", "bbx-0", "bbx-0", "0", "1", "1"],
  );
  assert.equal(values.has("accessibility"), false, "the pool reads every Mac's status twice for each box it lends, so it does not wait for Cua");
  assert.equal(count(mac, cua), 0);
  const granted = mac.helper(["status", "grants"]);
  assert.equal(granted.status, 0, granted.stderr);
  assert.deepEqual(["accessibility", "screenrecording"].map((key) => fields(granted.stdout).get(key)), ["1", "0"]);
  assert.deepEqual(parseStatus(granted.stdout).mac?.grants, { accessibility: true, screenRecording: false });
  assert.equal(count(mac, cua), 1);
  for (const args of [["bogus"], ["grants", "xcode"]]) {
    assert.deepEqual(mac.helper(["status", ...args]), { status: 2, stdout: "", stderr: "usage: machine status [grants | xcode]\n" });
  }

  const xcodeOf = (args: readonly string[]) => parseStatus(mac.helper(["status", ...args]).stdout).mac?.xcode;
  assert.deepEqual(xcodeOf(["xcode"]), { version: null, runtimes: [] });
  assert.equal(count(mac, "xcrun"), 0, "with only the Command Line Tools, xcrun is not run, as it may offer to install them");
  assert.equal(mac.file("/var/db/bb-box/xcode"), "xcode=\nruntimes=\n");
  mkdirSync(join(mac.root, "Applications/Xcode.app"), { recursive: true });
  mkdirSync(join(mac.state, "defaults/_Applications_Xcode.app_Contents_Info"));
  const version = join(mac.state, "defaults/_Applications_Xcode.app_Contents_Info/CFBundleShortVersionString");
  writeFileSync(version, "26.0\n");
  assert.deepEqual(xcodeOf([]), { version: "26.0", runtimes: [] }, "plain status reads Xcode's version, and the runtimes only from what `status xcode` found");
  const xcode = mac.helper(["status", "xcode"]);
  assert.deepEqual(["xcode", "runtimes", "accessibility"].map((key) => fields(xcode.stdout).get(key)), ["26.0", "iOS 26.0,watchOS 26.0", undefined]);
  assert.deepEqual(parseStatus(xcode.stdout).mac?.xcode, { version: "26.0", runtimes: ["iOS 26.0", "watchOS 26.0"] });
  assert.equal(mac.file("/var/db/bb-box/xcode"), "xcode=26.0\nruntimes=iOS 26.0,watchOS 26.0\n");
  for (const args of [[], ["grants"]]) assert.deepEqual(xcodeOf(args), { version: "26.0", runtimes: ["iOS 26.0", "watchOS 26.0"] });
  assert.equal(count(mac, "xcrun simctl list runtimes available"), 1, "plain status stays fast, as the pool reads it twice for each box it lends");
  mac.flag("simctl-fails");
  const failed = mac.helper(["status", "xcode"]);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /^xcrun simctl did not list the Simulator's runtimes within 10 seconds\./);
  assert.deepEqual(xcodeOf([]), { version: "26.0", runtimes: ["iOS 26.0", "watchOS 26.0"] }, "a failure keeps what it found before");
  mac.flag("simctl-fails", false);
  mac.flag("no-ios-runtime");
  assert.deepEqual(xcodeOf(["xcode"]), { version: "26.0", runtimes: ["watchOS 26.0"] });
  writeFileSync(version, "26.1\n");
  assert.deepEqual(xcodeOf([]), { version: "26.1", runtimes: [] }, "what it found for another Xcode does not count");

  mac.setConsole("root");
  mac.flag("filevault-on");
  rmSync(join(mac.root, TCC));
  const away = fields(mac.helper(["status", "grants"]).stdout);
  assert.deepEqual(
    ["console", "filevault", "fulldisk", "accessibility", "screenrecording"].map((key) => away.get(key)),
    ["root", "1", "0", "", ""],
    "Cua's grants come only from a box user's session",
  );

  mac.add("ipc", "m 65536 79999");
  assert.equal(parseStatus(mac.helper(["status"]).stdout).dirty, "a System V IPC object of removed UID 79999");
});

test("a claim lends the ready user with the box's key and 030's desktop sudo rule, and says why it cannot", () => {
  const mac = lentMac();
  assert.equal(
    mac.file("/var/db/bb-box/owner"),
    "install=inst_a\nbox=box_a\nthread=thr_a\nname=mac-box\nkind=macos-desktop\ncreated=1790000000000\ngeneration=0\nuser=bbx-0\nuid=70000\n",
  );
  assert.equal(mac.file("/Users/bbx-0/.ssh/authorized_keys"), `${KEY}\n`);
  assert.equal(statSync(join(mac.root, "Users/bbx-0/.ssh")).mode & 0o777, 0o700);
  assert.equal(statSync(join(mac.root, "Users/bbx-0/.ssh/authorized_keys")).mode & 0o777, 0o600);
  assert.ok(mac.lines("owners").includes(`70000 ${mac.data}/Users/bbx-0/.ssh/authorized_keys`));
  assert.equal(mac.file("/etc/sudoers.d/bbx-0"), "bbx-0 ALL=(root) NOPASSWD: /bin/launchctl asuser 70000 /usr/bin/sudo -n -u bbx-0 -- *\n");
  assert.equal(statSync(join(mac.root, "etc/sudoers.d/bbx-0")).mode & 0o777, 0o440);
  assert.equal(parseStatus(mac.helper(["status"]).stdout).owner?.user, "bbx-0");

  const held = mac.helper(["claim", "0"], CLAIM("box_b"));
  assert.deepEqual([held.status, held.stderr], [EXIT.held, "Another box holds the Mac.\n"]);

  const free = readyMac();
  assert.deepEqual(free.helper(["claim", "3"], CLAIM()), { status: EXIT.moved, stdout: "", stderr: "The Mac is at reset generation 0, not 3.\n" });
  assert.deepEqual(free.helper(["claim", "0", "docker"], CLAIM()), { status: 2, stdout: "", stderr: "Boxes on a Mac have no Docker.\n" });
  assert.equal(free.helper(["claim", "0"], "install=inst_a\nbox=box_a\n").status, 2, "no key");
  assert.equal(free.file("/var/db/bb-box/owner"), null);

  const unmade = fakeMacos();
  mkdirSync(join(unmade.root, "var/db/bb-box"), { recursive: true });
  writeFileSync(join(unmade.root, "var/db/bb-box/generation"), "0\n");
  assert.deepEqual(unmade.helper(["claim", "0"], CLAIM()), { status: EXIT.dirty, stdout: "", stderr: NOT_READY });

  const left = readyMac();
  mkdirSync(join(left.state, "users", "bbx-7"));
  writeFileSync(join(left.state, "users", "bbx-7", "UniqueID"), "70007\n");
  assert.deepEqual(left.helper(["claim", "0"], CLAIM()), { status: EXIT.dirty, stdout: "", stderr: "An earlier box left user bbx-7.\n" });

  const refused = readyMac();
  refused.flag("visudo-refuses");
  assert.deepEqual([refused.helper(["claim", "0"], CLAIM()).status, refused.file("/var/db/bb-box/owner")], [1, null]);
  assert.equal(refused.file("/Users/bbx-0/.ssh/authorized_keys"), null, "a claim that fails takes the key away");
});

test("a claim does not wait for the Mac's lock", async () => {
  const mac = readyMac();
  const lock = join(mac.root, "var/db/bb-box/lock");
  // Linux's flock locks as perl's flock does on a Mac.
  const holder = spawn("flock", [lock, "sleep", "30"], { stdio: "ignore", detached: true });
  try {
    for (let i = 0; i < 50 && spawnSync("flock", ["-n", lock, "true"]).status === 0; i++) await pause(50);
    assert.deepEqual(mac.helper(["claim", "0"], CLAIM()), { status: EXIT.held, stdout: "", stderr: "Another bb-box command holds the Mac's lock.\n" });
  } finally {
    process.kill(-holder.pid!);
  }
});

test("display gives the box's user and password, only to the box that holds the Mac", () => {
  const mac = lentMac();
  const password = readFileSync(join(mac.state, "secrets", "bbx-0"), "utf8").trim();
  assert.deepEqual(mac.helper(["display", "0"], RELEASE()), { status: 0, stdout: `user=bbx-0\npassword=${password}\n`, stderr: "" });

  for (const [args, input] of [
    [["display", "0"], RELEASE("box_b")],
    [["display", "0"], RELEASE("box_a", "inst_b")],
    [["display", "1"], RELEASE()],
  ] as const) {
    const refused = mac.helper(args, input);
    assert.deepEqual([refused.status, refused.stdout], [EXIT.notOurs, ""], `${args.join(" ")} ${input}`);
    assert.ok(!refused.stderr.includes(password));
  }
  assert.equal(mac.helper(["display", "0"], "install=inst_a\n").status, 2);
  assert.deepEqual(readyMac().helper(["display", "0"], RELEASE()), { status: EXIT.notOurs, stdout: "", stderr: "No box holds the Mac.\n" });
});

test("a release removes the box's user with everything it left, and signs in the next box's user, made ahead", () => {
  const mac = fakeMacos();
  mkdirSync(join(mac.state, "groups", "com.apple.access_ssh"));
  assert.equal(mac.helper(["init"]).status, 0);
  assert.deepEqual(mac.members("com.apple.access_ssh"), ["bbx-0"], "where Remote Login allows only some users");
  assert.equal(mac.helper(["claim", "0"], CLAIM()).status, 0);
  // Screen Sharing allowed to all users since bbx-0 joined its group.
  mkdirSync(join(mac.state, "groups", "com.apple.access_screensharing-disabled"));
  writeFileSync(join(mac.state, "groups", "com.apple.access_screensharing-disabled", "GroupMembership"), "bbx-0\nperson\n");

  // What the box leaves.
  for (const [path, owner] of [
    ["/private/tmp/box-file", 70000],
    ["/Users/Shared/box-folder/inside", 70000],
    ["/private/var/folders/zz/box", 70000],
    ["/private/var/at/jobs/a0000501c77838", 70000],
    ["/private/var/at/jobs/a0000601c77839", 501],
    ["/Users/bbx-0/Library/LaunchAgents/box.plist", 70000],
    ["/Library/Managed Preferences/bbx-0/complete.plist", 0],
    ["/private/tmp/root-file", 0],
  ] as const) {
    mkdirSync(join(mac.root, path, ".."), { recursive: true });
    writeFileSync(join(mac.root, path), "left\n");
    if (owner) mac.own(path, owner);
  }
  mac.own("/Users/Shared/box-folder", 70000);
  writeFileSync(join(mac.root, "private/var/at/tabs/bbx-0"), "* * * * * true\n");
  mac.add("ipc", "m 65536 bbx-0");
  mac.add("ipc", "s 131072 70003");
  mac.add("ipc", "q 1 person");
  mac.add("processes", "401 70000 Finder 1");
  mac.add("processes", "402 70000 ignores-sigterm 2");
  mac.add("processes", "403 501 Terminal 1");

  const release = mac.helper(["release", "0"], RELEASE());
  assert.deepEqual(release, { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });

  assert.deepEqual(mac.users(), ["bbx-1", "person"]);
  assert.equal(mac.user("bbx-1")?.UniqueID, "70001");
  for (const path of ["/Users/bbx-0", "/private/tmp/box-file", "/Users/Shared/box-folder", "/private/var/folders/zz/box", "/private/var/at/jobs/a0000501c77838", "/Library/Managed Preferences/bbx-0", "/private/var/at/tabs/bbx-0", "/etc/sudoers.d/bbx-0", "/var/db/bb-box/passwords/bbx-0"]) {
    assert.equal(existsSync(join(mac.root, path)), false, path);
  }
  assert.equal(mac.file("/private/tmp/root-file"), "left\n");
  assert.match(mac.file("/var/db/bb-box/passwords/bbx-1")!, /^[A-Za-z0-9]{24}\n$/);
  assert.equal(mac.file("/private/var/at/jobs/a0000601c77839"), "left\n");
  assert.deepEqual(mac.lines("ipc"), ["q 1 person"]);
  assert.deepEqual(mac.lines("processes"), ["403 501 Terminal 1"]);
  assert.deepEqual(mac.lines("again"), [], "the old user is no longer the automatic login when it is logged out");
  assert.ok(count(mac, "pkill -KILL -u 70000") >= 2, "a process that outlives a kill is killed again");
  assert.deepEqual([mac.members("_developer"), mac.members("com.apple.access_ssh")], [["bbx-1"], ["bbx-1"]]);
  assert.deepEqual(mac.members("com.apple.access_screensharing-disabled"), ["person"]);
  assert.ok(count(mac, "dsmemberutil flushcache") >= 1, "the new user meets no cached membership of an earlier one");
  assert.equal(
    mac.file("/Users/bbx-1/Library/Preferences/loginwindow.plist"),
    '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
      '<plist version="1.0"><dict><key>SystemVersionStampAsString</key><string>26.0</string><key>BuildVersionStampAsString</key><string>25A354</string></dict></plist>\n',
    "a home stamped with the macOS it was made on, so its first sign-in skips Setup Assistant",
  );
  assert.equal(readFileSync(join(mac.state, "defaults", "_Library_Preferences_com.apple.loginwindow", "autoLoginUser"), "utf8"), "bbx-1\n");
  assert.equal(mac.console(), "bbx-1");
  assert.deepEqual([mac.file("/var/db/bb-box/generation"), mac.file("/var/db/bb-box/resetting"), mac.file("/var/db/bb-box/owner")], ["1\n", null, null]);
  assert.equal(mac.file("/var/db/bb-box/signs-in-by"), "loginwindow\n");
  const status = fields(mac.helper(["status"]).stdout);
  assert.deepEqual([status.get("dirty"), status.get("user"), status.get("console")], ["", "bbx-1", "bbx-1"]);

  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=already\n", stderr: "" });
  assert.equal(mac.helper(["claim", "1"], CLAIM("box_b")).status, 0, "the next box takes the next user");
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, EXIT.notOurs);
});

test("a release that cannot remove a file the old user owned fails, naming Full Disk Access when the helper lacks it, and the next reset finishes", { skip: process.getuid?.() === 0 && "root removes any file" }, () => {
  const mac = lentMac();
  mkdirSync(join(mac.root, "private/var/locked"));
  writeFileSync(join(mac.root, "private/var/locked/file"), "left\n");
  mac.own("/private/var/locked/file", 70000);
  chmodSync(join(mac.root, "private/var/locked"), 0o555);
  try {
    const failed = mac.helper(["release", "0"], RELEASE());
    assert.deepEqual([failed.status, failed.stderr], [1, "Could not remove /private/var/locked/file, which bbx-0 owned.\n"]);
    assert.equal(mac.file("/var/db/bb-box/resetting")?.includes("generation=0"), true);
    assert.equal(mac.user("bbx-0")?.UniqueID, "70000", "the user stays until its files are gone");

    rmSync(join(mac.root, TCC));
    assert.deepEqual(mac.helper(["reset"], "install=inst_a\n"), {
      status: 1,
      stdout: "",
      stderr:
        "Could not remove /private/var/locked/file, which bbx-0 owned. The helper has no Full Disk Access: on the Mac, in System Settings, General, Sharing, select the (i) beside Remote Login, and turn on Allow full disk access for remote users.\n",
    });
  } finally {
    chmodSync(join(mac.root, "private/var/locked"), 0o755);
  }
  assert.deepEqual(mac.helper(["reset"], "install=inst_a\n"), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.deepEqual(mac.users(), ["bbx-1", "person"]);
});

test("a process Spotlight starts as the old user during the sweep is ended, and the temporary folders it makes are swept", () => {
  const mac = lentMac();
  mac.flag("mds");
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.equal(existsSync(join(mac.data, "private/var/folders/zz/user70000")), false);
  assert.ok(!mac.lines("processes").some((line) => line.split(" ")[1] === "70000"), "no process of the old user runs");
});

test("a reset removes what earlier box users left only in a group or in managed preferences", () => {
  const mac = lentMac();
  for (const [group, members] of [
    ["com.apple.access_ssh", "bbx-7\nperson\n"],
    ["com.apple.access_screensharing-disabled", "bbx-6\nperson\n"],
  ]) {
    mkdirSync(join(mac.state, "groups", group));
    writeFileSync(join(mac.state, "groups", group, "GroupMembership"), members);
  }
  mkdirSync(join(mac.root, "Library/Managed Preferences/bbx-5"), { recursive: true });
  mkdirSync(join(mac.root, "Library/Managed Preferences/person"));
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.deepEqual(mac.members("com.apple.access_ssh"), ["person", "bbx-1"]);
  assert.deepEqual(mac.members("com.apple.access_screensharing-disabled"), ["person"]);
  assert.deepEqual(readdirSync(join(mac.root, "Library/Managed Preferences")), ["person"]);
});

test("while the next user is not signed in, the reset is still running; it restarts userspace, then the Mac, then gives up", async () => {
  const mac = lentMac();
  mac.flag("loginwindow-waits");
  mac.clock(1000);
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: EXIT.restoring, stdout: "signin=loginwindow\n", stderr: "" });
  assert.deepEqual(mac.users(), ["bbx-1", "person"], "the old user is gone while the next signs in");
  assert.equal(mac.file("/var/db/bb-box/generation"), "0\n");
  const sweeps = count(mac, "find ");

  mac.clock(1059);
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: EXIT.restoring, stdout: "signin=loginwindow\n", stderr: "" });
  assert.equal(count(mac, "launchctl kickstart"), 2, "init's, and the reset's");
  assert.equal(count(mac, "find "), sweeps, "nothing is left to sweep");

  mac.clock(1060);
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: EXIT.restoring, stdout: "signin=userspace\n", stderr: "" });
  await waitForCall(mac, "launchctl reboot userspace");
  // While userspace restarts, the directory does not answer, and the next user seems half made: it is left alone.
  mac.flag("directory-down");
  mac.clock(1062);
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: EXIT.restoring, stdout: "signin=userspace\n", stderr: "" });
  assert.match(mac.file("/var/db/bb-box/passwords/bbx-1")!, /^[A-Za-z0-9]{24}\n$/);
  assert.match(mac.file("/Users/bbx-1/.zshenv")!, /path_helper/);
  mac.flag("directory-down", false);
  mac.clock(1240);
  assert.deepEqual(mac.helper(["reset"], "install=inst_a\n"), { status: EXIT.restoring, stdout: "signin=restart\n", stderr: "" });
  await waitForCall(mac, "shutdown -r now");
  mac.clock(1720);
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), {
    status: 1,
    stdout: "",
    stderr: "The Mac did not sign bbx-1 in, even when it restarted. Check that FileVault is off and that the automatic login is bbx-1.\n",
  });

  mac.setConsole("bbx-1");
  assert.deepEqual(mac.helper(["reset"], "install=inst_a\n"), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
});

test("the reset remembers the way that signed the user in, and starts with it", async () => {
  const mac = lentMac();
  mac.flag("loginwindow-waits");
  mac.clock(1000);
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, EXIT.restoring);
  mac.clock(1060);
  assert.equal(mac.helper(["release", "0"], RELEASE()).stdout, "signin=userspace\n");
  await waitForCall(mac, "launchctl reboot userspace");
  mac.setConsole("bbx-1");
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.equal(mac.file("/var/db/bb-box/signs-in-by"), "userspace\n");

  assert.equal(mac.helper(["claim", "1"], CLAIM()).status, 0);
  const kicks = count(mac, "launchctl kickstart");
  assert.deepEqual(mac.helper(["release", "1"], RELEASE()), { status: EXIT.restoring, stdout: "signin=userspace\n", stderr: "" });
  assert.equal(count(mac, "launchctl kickstart"), kicks, "no time spent on loginwindow alone");
  for (let i = 0; i < 50 && count(mac, "launchctl reboot userspace") < 2; i++) await pause(100);
  assert.equal(count(mac, "launchctl reboot userspace"), 2);
  mac.setConsole("bbx-2");
  assert.deepEqual(mac.helper(["release", "1"], RELEASE()), { status: 0, stdout: "generation=2\nreleased=yes\n", stderr: "" });
});

test("on macOS 27 and later, the first reset restarts userspace, as restarting loginwindow alone does not sign the user in", async () => {
  const mac = lentMac();
  mac.flag("macos", true, "27.0\n");
  mac.flag("loginwindow-waits");
  const kicks = count(mac, "launchctl kickstart");
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: EXIT.restoring, stdout: "signin=userspace\n", stderr: "" });
  assert.equal(count(mac, "launchctl kickstart"), kicks, "no minute spent on loginwindow alone");
  await waitForCall(mac, "launchctl reboot userspace");
  mac.setConsole("bbx-1");
  assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.equal(mac.file("/var/db/bb-box/signs-in-by"), "userspace\n");

  // A Mac updated to macOS 27 starts with the way it remembers.
  const updated = lentMac();
  writeFileSync(join(updated.root, "var/db/bb-box/signs-in-by"), "loginwindow\n");
  updated.flag("macos", true, "27.0\n");
  updated.flag("loginwindow-waits");
  assert.equal(updated.helper(["release", "0"], RELEASE()).stdout, "signin=loginwindow\n");
});

test("an operator's reset moves a free Mac on to the next user, and leaves alone a Mac a box holds", () => {
  const mac = readyMac();
  assert.deepEqual(mac.helper(["reset"]), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
  assert.deepEqual([mac.users(), mac.console()], [["bbx-1", "person"], "bbx-1"]);

  assert.equal(mac.helper(["claim", "1"], CLAIM()).status, 0);
  assert.deepEqual(mac.helper(["reset"]), {
    status: EXIT.notOurs,
    stdout: "",
    stderr: "Box mac-box of bb-box install inst_a holds the Mac. Release the box first.\n",
  });
  assert.equal(mac.helper(["reset"], "install=inst_b\n").status, EXIT.notOurs);
  assert.deepEqual(mac.helper(["reset", "machine"]), { status: 2, stdout: "", stderr: "A Mac has no whole-machine reset. usage: machine reset\n" });
  assert.equal(mac.helper(["release", "1", "machine"], RELEASE()).status, 2);
  assert.equal(mac.user("bbx-1")?.UniqueID, "70001");
});

test("a person signed in at the console stops the reset, which leaves their session alone", () => {
  const mac = lentMac();
  mac.setConsole("person");
  const kicks = count(mac, "launchctl kickstart");
  const failed = mac.helper(["release", "0"], RELEASE());
  assert.deepEqual([failed.status, failed.stderr], [
    1,
    "person is signed in at the Mac's console, so the Mac cannot sign the next box's user in. Sign person out, then reset the Mac: sudo /usr/local/libexec/bb-box/machine reset\n",
  ]);
  assert.equal(mac.console(), "person");
  assert.equal(count(mac, "launchctl kickstart"), kicks);
  assert.match(mac.file("/var/db/bb-box/resetting")!, /^install=inst_a\n/);

  mac.setConsole("root");
  assert.deepEqual(mac.helper(["reset"]), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
});

test("a user sysadminctl did not make, a directory that does not answer, a UID another user has, or FileVault on stops the Mac with the reason", () => {
  const silent = fakeMacos();
  silent.flag("sysadminctl-fails");
  assert.deepEqual(silent.helper(["init"]), { status: 1, stdout: "", stderr: "sysadminctl did not make bbx-0.\nCould not make box user bbx-0.\n" });
  assert.deepEqual([silent.file("/Users/bbx-0/.zshenv"), silent.file("/var/db/bb-box/passwords/bbx-0")], [null, null]);
  silent.flag("sysadminctl-fails", false);
  assert.equal(silent.helper(["init"]).status, 0);
  assert.equal(silent.user("bbx-0")?.UniqueID, "70000");

  const down = fakeMacos();
  down.flag("directory-down");
  assert.equal(down.helper(["init"]).stderr, "The Mac's directory service did not answer.\nCould not make box user bbx-0.\n");

  const named = fakeMacos();
  writeFileSync(join(named.state, "users", "person", "RealName"), "bb-box bbx-0\n");
  assert.equal(
    named.helper(["init"]).stderr,
    "sysadminctl did not make bbx-0: User with full name 'bb-box bbx-0' already exists.\nCould not make box user bbx-0.\n",
  );

  const taken = fakeMacos();
  mkdirSync(join(taken.state, "users", "someone"));
  writeFileSync(join(taken.state, "users", "someone", "UniqueID"), "70000\n");
  assert.equal(taken.helper(["init"]).stderr, "UID 70000 belongs to someone. bb-box's box users take UIDs 70000 to 79999.\nCould not make box user bbx-0.\n");

  const locked = fakeMacos();
  locked.flag("filevault-on");
  assert.deepEqual(locked.helper(["init"]), {
    status: 1,
    stdout: "",
    stderr: "FileVault is on, so the Mac cannot sign box users in by itself. Turn FileVault off.\n",
  });
});

/** A fake Mac's tools ready for setup-mac.sh: Cua Driver's archive, Homebrew's installer and a host key. */
function setupMac(): FakeMacos {
  const mac = fakeMacos({ template: false });
  const work = tempDir("cua");
  const app = join(work, "cua-driver-rs-0.30.4-darwin-arm64", "CuaDriver.app", "Contents", "MacOS");
  mkdirSync(app, { recursive: true });
  writeFileSync(join(app, "cua-driver"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", join(work, "cua.tgz"), "-C", work, "cua-driver-rs-0.30.4-darwin-arm64"]).status, 0);
  writeFileSync(join(mac.state, "flags", "cua.tgz"), readFileSync(join(work, "cua.tgz")));
  mac.flag("install.sh", true, 'mkdir -p "$FAKE_MAC_ROOT/opt/homebrew/bin" && ln -s "$FAKE_MAC_BIN/brew" "$FAKE_MAC_ROOT/opt/homebrew/bin/brew"\n');
  mac.flag("owner", true, "person\n");
  writeFileSync(join(mac.root, "etc/ssh/ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMacHostKeyForTests root@mac\n");
  return mac;
}

test("setup-mac.sh makes the admin user, installs the helper, template, Homebrew and Cua Driver, and signs in the first box user", () => {
  const mac = setupMac();
  const result = mac.setup(["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Installing Homebrew as person\.\nThis Mac is ready for bb-box's SSH host pool, at reset generation 0, once a person has done the steps below\.\n/);
  assert.ok(result.stdout.includes("\n  mac-mini bbbox-admin@192.0.2.30 macos,macos-desktop\n"), result.stdout);
  assert.ok(result.stdout.includes("\n  192.0.2.30 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIMacHostKeyForTests\n"));
  assert.ok(result.stdout.includes("\n1. Turn on Screen Sharing in System Settings, General, Sharing, if it is off."));
  assert.ok(result.stdout.includes("\n2. In System Settings, General, Sharing, select the (i) beside Remote Login, and turn on Allow full disk access for remote users."));
  assert.ok(result.stdout.includes("\n4. If boxes need Xcode or the iOS Simulator, install Xcode in /Applications, then run setup-mac.sh again.\n"));
  assert.ok(!result.stdout.includes("Restart the Mac"), "nobody was at the console, so the first box user is signed in");
  assert.ok(!result.stdout.includes("Check these"), result.stdout);

  const admin = mac.user("bbbox-admin")!;
  assert.deepEqual([admin.RealName, admin.IsHidden, admin.NFSHomeDirectory], ["bb-box admin", "1", "/private/var/bbbox-admin"]);
  assert.equal(mac.file("/private/var/bbbox-admin/.ssh/authorized_keys"), "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box\n");
  assert.equal(mac.file("/etc/sudoers.d/bb-box"), "Defaults:bbbox-admin !requiretty\nbbbox-admin ALL=(root) NOPASSWD: /usr/local/libexec/bb-box/machine\n");
  assert.equal(statSync(join(mac.root, "usr/local/libexec/bb-box/machine")).mode & 0o777, 0o755);
  assert.match(mac.file("/usr/local/share/bb-box/home/.zshenv")!, /path_helper/);
  assert.equal(mac.file("/usr/local/share/bb-box/cua-driver"), "0.30.4\n");
  assert.equal(mac.file("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"), "#!/bin/sh\n");
  assert.equal(readlinkSync(join(mac.root, "usr/local/bin/cua-driver")), "/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
  assert.match(mac.file("/Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist")!, /rm -rf \/Users\/bbx-\*\/\.bb-machines\/\*\/daemon\.lock\.lock /);
  assert.equal(count(mac, "sudo -u person -H env NONINTERACTIVE=1 /bin/bash -c mkdir"), 1, "Homebrew's installer, as the person who ran sudo");
  assert.equal(count(mac, "brew install git gh node"), 1);
  assert.equal(count(mac, "pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1"), 1);
  for (const call of [
    "defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false",
    "defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallAppUpdates -bool false",
    "defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false",
  ]) {
    assert.equal(count(mac, call), 1, call);
  }
  assert.deepEqual([mac.console(), mac.user("bbx-0")?.UniqueID], ["bbx-0", "70000"]);
  assert.equal(mac.file("/var/db/bb-box/xcode"), "xcode=\nruntimes=\n");

  // Again, with Xcode, another install's key, and a person at the console.
  mkdirSync(join(mac.root, "Applications/Xcode.app"));
  mkdirSync(join(mac.state, "defaults/_Applications_Xcode.app_Contents_Info"), { recursive: true });
  writeFileSync(join(mac.state, "defaults/_Applications_Xcode.app_Contents_Info/CFBundleShortVersionString"), "26.0\n");
  mac.setConsole("person");
  const again = mac.setup(["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box", "--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherInstall bb-box", "--name", "studio"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes("\n  studio bbbox-admin@192.0.2.30 macos,macos-desktop\n"));
  assert.ok(again.stdout.includes("\n4. Restart the Mac, so that it signs in the first box user, bbx-0.\n"), again.stdout);
  assert.equal(mac.file("/private/var/bbbox-admin/.ssh/authorized_keys")!.split("\n").length, 3);
  assert.equal(count(mac, "sysadminctl -addUser bbbox-admin"), 1);
  assert.equal(count(mac, "sudo -u person -H env NONINTERACTIVE=1"), 1, "Homebrew is installed once");
  assert.equal(count(mac, "curl -fsSL --retry 3 -o"), 1, "Cua Driver is downloaded once");
  for (const call of ["xcodebuild -license accept", "xcodebuild -runFirstLaunch", "DevToolsSecurity -enable"]) assert.equal(count(mac, call), 1, call);
  assert.equal(count(mac, "xcodebuild -downloadPlatform iOS"), 0, "the iOS runtime is there");
  assert.equal(mac.file("/var/db/bb-box/xcode"), "xcode=26.0\nruntimes=iOS 26.0,watchOS 26.0\n", "what the pool's offers follow");
  assert.equal(count(mac, "sudo -u person open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"), 1);
  assert.equal(mac.file("/var/db/bb-box/generation"), "0\n");
});

test("setup-mac.sh refuses a Mac with FileVault on or Remote Login off, no key, someone else's admin user, or a Cua Driver that is not the pinned one", () => {
  const key = ["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box"];
  const failed = (mac: FakeMacos, args: readonly string[] = key) => {
    const result = mac.setup(args);
    assert.equal(result.status, 1, result.stdout);
    return result.stderr;
  };

  const encrypted = setupMac();
  encrypted.flag("filevault-on");
  assert.match(failed(encrypted), /^setup-mac\.sh: FileVault is on, or fdesetup could not say\. A Mac signs box users in by itself only with FileVault off\./);
  const closed = setupMac();
  closed.flag("no-remote-login");
  assert.equal(failed(closed), "setup-mac.sh: Remote Login is off. Turn it on in System Settings, General, Sharing, then run setup-mac.sh again.\n");
  assert.equal(failed(setupMac(), []), "setup-mac.sh: Give --key the public key bb-box's doctor shows, starting ssh-ed25519.\n");
  const taken = setupMac();
  mkdirSync(join(taken.state, "users", "bbbox-admin"));
  writeFileSync(join(taken.state, "users", "bbbox-admin", "RealName"), "Someone\n");
  assert.equal(failed(taken), "setup-mac.sh: User bbbox-admin exists and setup-mac.sh did not make it. Choose a new name for bb-box's admin user with --admin.\n");
  const tampered = setupMac();
  tampered.flag("bad-sha");
  assert.equal(failed(tampered), "setup-mac.sh: Cua Driver's archive does not match its pin.\n");
  assert.equal(tampered.file("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"), null);
  for (const mac of [encrypted, closed, taken]) assert.deepEqual(mac.users(), mac === taken ? ["bbbox-admin", "person"] : ["person"]);
});

test("setup-mac.sh pins the Cua Driver that Tart's image pins", () => {
  const pins = (path: string) => {
    const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    return [/^CUA_VERSION=(.+)$/m.exec(text)?.[1], /^CUA_SHA256=(.+)$/m.exec(text)?.[1]];
  };
  assert.deepEqual(pins("../setup/ssh-pool/setup-mac.sh"), pins("../setup/tart/prepare-image.sh"));
  assert.match(pins("../setup/ssh-pool/setup-mac.sh")[1]!, /^[0-9a-f]{64}$/);
});
