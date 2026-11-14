import "./check-test-machine.mjs";
// The SSH host pool's Mac helper and setup (047), run on Linux against a fake
// Mac: stub macOS tools that keep its state in files (test/fake-macos.ts).

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { EXIT, fields, parseStatus } from "../src/backends/ssh-pool/protocol.ts";
import { parseSnapshotReport } from "../src/backends/ssh-pool/snapshot-report.ts";
import { leftoverWords } from "../src/backends/ssh-pool/backend.ts";
import { CUA_SHA256, CUA_VERSION } from "../src/backends/tart/backend.ts";
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
  // BB Box's pinned CLIs in /usr/local/bin come before Homebrew's, prepended last.
  const zshenv = mac.file("/Users/bbx-0/.zshenv")!;
  assert.ok(zshenv.indexOf('PATH="/usr/local/bin:$PATH"') > zshenv.lastIndexOf("/opt/homebrew"), "after Homebrew's and Node's");
  assert.match(mac.file("/Users/bbx-0/Library/LaunchAgents/com.trycua.cua-driver.plist")!, /<string>serve<\/string>/);
  assert.match(
    mac.file("/Users/bbx-0/Library/Preferences/ByHost/com.apple.screensaver.0A1B2C3D-0000-4000-8000-000000000001.plist")!,
    /<key>idleTime<\/key><integer>0<\/integer>/,
  );
  assert.ok(mac.lines("owners").some((line) => line === `70000 ${mac.data}/Users/bbx-0/.zshenv`), "the home is the user's");
  // Screen capture approved for the user, so macOS 27 does not ask a box nobody answers (047): asked now, again in years.
  // Cua's, by bundle ID; box_run's, charged to sshd-keygen-wrapper, by path; and a Tart desktop command's launcher, by URL.
  const approvals = "/Users/bbx-0/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist";
  const approval = mac.file(approvals)!;
  const year = new Date().getUTCFullYear();
  for (const client of ["com.trycua.driver", "/usr/libexec/sshd-keygen-wrapper", "file:///usr/local/libexec/bb-box/Launcher.app/"]) {
    assert.ok(approval.includes(`<key>${client}</key><dict>`), client);
  }
  assert.equal(approval.match(/<key>kScreenCapturePrivacyHintDate<\/key>/g)?.length, 3);
  assert.match(approval, /<key>kScreenCaptureApprovalLastAlerted<\/key><date>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z<\/date>/);
  assert.match(approval, new RegExp(`<key>kScreenCapturePrivacyHintDate</key><date>${year + 5}-01-01T00:00:00Z</date>`));
  assert.equal(statSync(join(mac.root, approvals)).mode & 0o777, 0o600);
  assert.equal(statSync(join(mac.root, "/Users/bbx-0/Library/Group Containers/group.com.apple.replayd")).mode & 0o777, 0o700);

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
      helper: 2, arch: "arm64", boot: "6F0E2A1C-0000-4000-8000-000000000001", generation: 0, marker: "none", owner: null, hook: false,
      docker: false, systemd: false, cores: 8, memoryMiB: 16384, diskGiB: null, virt: "none", missing: [], enrolment: { node: "24.9.0", lacks: [] }, dirty: null,
      mac: { version: "26.0", user: "bbx-0", console: "bbx-0", autologin: "bbx-0", fileVault: false, screenSharing: true, fullDisk: true, grants: null, xcode: { version: null, runtimes: [] }, leftovers: null, openHomes: null, sip: true, stream: false },
      slots: null,
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
  assert.deepEqual(["accessibility", "screenrecording", "input"].map((key) => fields(granted.stdout).get(key)), ["1", "0", "1"]);
  assert.deepEqual(parseStatus(granted.stdout).mac?.grants, { accessibility: true, screenRecording: false, input: true });
  assert.equal(count(mac, "launchctl asuser 70000 /usr/bin/sudo -n -H -u bbx-0 -- /usr/bin/osascript -l JavaScript -e"), 1, "the input probe runs in the box user's session");
  assert.equal(count(mac, cua), 1);
  mac.flag("no-input");
  assert.equal(fields(mac.helper(["status", "grants"]).stdout).get("input"), "0", "macOS dropped the probe's pointer move");
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
  mac.add("processes", "402 70000 ignores-sigterm 3");
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

test("a release stops the old user gently: its devices shut down and every process but containermanagerd ended before its launchd domain goes, as the iOS host's helper does (064)", () => {
  const mac = lentMac();
  mac.add("processes", "501 70000 launchd_sim 1");
  mac.add("processes", "502 70000 idb_companion 1");
  mac.add("processes", "503 70000 containermanagerd 1");
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, 0);
  const calls = mac.calls();
  const at = (call: string) => calls.findIndex((line) => line.startsWith(call));
  const shutdown = at("sudo -n -H -u bbx-0 -- xcrun simctl shutdown all");
  const term = at("pkill -TERM -u 70000 -x idb_companion");
  const bootout = at("launchctl bootout user/70000");
  const kill = at("pkill -KILL -u 70000");
  assert.ok(shutdown >= 0 && term > shutdown && bootout > term && kill > bootout, `in order: ${[shutdown, term, bootout, kill].join(", ")}`);
  assert.equal(at("pkill -TERM -u 70000 -x containermanagerd"), -1, "containermanagerd outlives its clients");
  assert.deepEqual(mac.lines("processes"), []);
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

test("a release leaves what macOS 27 keeps of the old user's /private/var/folders folder, only folders of its own, and fails on a file, or on anything of another user", { skip: process.getuid?.() === 0 && "root removes any file" }, () => {
  // As on macOS 27: 0, C, T and X are sunlnk, which not even root can remove, and C holds a daemon's folder root cannot enter.
  const top = (mac: FakeMacos) => join(mac.data, "private/var/folders/sf/user70000");
  const folder = (mac: FakeMacos, extra: (dir: string) => void = () => {}) => {
    const dir = top(mac);
    for (const name of ["0", "C", "T", "X", "C/vault"]) mkdirSync(join(dir, name), { recursive: true });
    writeFileSync(join(dir, "T", "left"), "box\n");
    writeFileSync(join(dir, "C/vault", "kept"), "macOS's\n");
    extra(dir);
    for (const name of ["", "0", "C", "T", "X", "C/vault"]) mac.own(join("/private/var/folders/sf/user70000", name), 70000);
    for (const name of ["0", "C", "T", "X"]) mac.add("sunlnk", join(dir, name));
    chmodSync(join(dir, "C/vault"), 0o000);
    chmodSync(dir, 0o555);
  };
  const open = (mac: FakeMacos) => {
    for (const path of [top(mac), join(top(mac), "C/vault"), join(top(mac), "X")]) if (existsSync(path)) chmodSync(path, 0o755);
  };

  const mac = lentMac();
  folder(mac);
  try {
    assert.deepEqual(mac.helper(["release", "0"], RELEASE()), { status: 0, stdout: "generation=1\nreleased=yes\n", stderr: "" });
    assert.deepEqual(readdirSync(top(mac)).sort(), ["0", "C", "T", "X"], "the sunlnk folders stay");
    assert.deepEqual(readdirSync(join(top(mac), "T")), [], "emptied");
    assert.deepEqual(mac.users(), ["bbx-1", "person"]);
    // The doctor's status counts the old users' folders left there, and what root can see in them.
    const status = fields(mac.helper(["status", "xcode"]).stdout);
    assert.equal(status.get("leftovers"), "1");
    assert.match(status.get("leftovers_kib") ?? "", /^\d+$/);
    assert.equal(fields(mac.helper(["status"]).stdout).get("leftovers"), undefined, "not in an ordinary status");
    // BB Box reads them, and the doctor's state check says so.
    const parsed = parseStatus(mac.helper(["status", "xcode"]).stdout).mac?.leftovers;
    assert.equal(parsed?.count, 1);
    assert.equal(parseStatus(mac.helper(["status"]).stdout).mac?.leftovers, null);
    assert.equal(leftoverWords({ count: 3, kib: 2560 }), " Old box users left 3 folders in /private/var/folders, which macOS keeps, with 3 MiB that root can see.");
    assert.equal(leftoverWords({ count: 0, kib: 0 }), "");
  } finally {
    open(mac);
  }

  // A file root can see but not remove is not macOS's to keep.
  const file = lentMac();
  folder(file, (dir) => {
    writeFileSync(join(dir, "X", "stuck"), "box\n");
    chmodSync(join(dir, "X"), 0o555);
  });
  try {
    const failed = file.helper(["release", "0"], RELEASE());
    assert.deepEqual([failed.status, failed.stderr], [1, "Could not remove /private/var/folders/sf/user70000, which bbx-0 owned.\n"]);
  } finally {
    open(file);
  }

  // Nor is a folder of another user there, such as the next box's.
  const next = lentMac();
  folder(next, (dir) => {
    mkdirSync(join(dir, "X", "next"));
    chmodSync(join(dir, "X"), 0o555);
  });
  next.own("/private/var/folders/sf/user70000/X/next", 70001);
  try {
    const failed = next.helper(["release", "0"], RELEASE());
    assert.deepEqual([failed.status, failed.stderr], [1, "Could not remove /private/var/folders/sf/user70000, which bbx-0 owned.\n"]);
  } finally {
    open(next);
  }
});

test("an empty folder the old user left outside /private/var/folders, in /Users/Shared, still fails the reset: macOS keeps folders only there", { skip: process.getuid?.() === 0 && "root removes any file" }, () => {
  const mac = lentMac();
  const shared = join(mac.data, "Users/Shared");
  mkdirSync(join(shared, "box-empty"), { recursive: true });
  mac.own("/Users/Shared/box-empty", 70000);
  chmodSync(shared, 0o555);
  try {
    const failed = mac.helper(["release", "0"], RELEASE());
    assert.deepEqual([failed.status, failed.stderr], [1, "Could not remove /Users/Shared/box-empty, which bbx-0 owned.\n"]);
  } finally {
    chmodSync(shared, 0o755);
  }
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
  // The agent CLIs' downloads, laid out as their releases are.
  writeFileSync(join(mac.state, "flags", "claude"), "#!/bin/sh\necho claude\n");
  writeFileSync(join(work, "codex-aarch64-apple-darwin"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", join(mac.state, "flags", "codex-aarch64-apple-darwin.tar.gz"), "-C", work, "codex-aarch64-apple-darwin"]).status, 0);
  mkdirSync(join(work, "pi"));
  writeFileSync(join(work, "pi", "pi"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", join(mac.state, "flags", "pi-darwin-arm64.tar.gz"), "-C", work, "pi"]).status, 0);
  // Chrome's disk image, as a tar of what it holds: the app, signed by Google's team, with its version.
  const chrome = join(work, "chrome");
  mkdirSync(join(chrome, "Google Chrome.app", "Contents"), { recursive: true });
  writeFileSync(join(chrome, "Google Chrome.app", "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>155.0.8059.85</string></dict></plist>\n");
  writeFileSync(join(chrome, "Google Chrome.app.sig"), "identifier=com.google.Chrome\nteam=EQHXZ8M8AV\n");
  assert.equal(spawnSync("tar", ["-cf", join(mac.state, "flags", "googlechrome.dmg"), "-C", chrome, "Google Chrome.app", "Google Chrome.app.sig"]).status, 0);
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
  assert.ok(result.stdout.includes("\n4. Under Accessibility, also add and turn on /usr/bin/osascript and /usr/libexec/sshd-keygen-wrapper: select +, press Command-Shift-G and enter each path."));
  assert.ok(result.stdout.includes("\n5. If boxes need Xcode or the iOS Simulator, install Xcode in /Applications, then run setup-mac.sh again.\n"));
  assert.ok(!result.stdout.includes("Restart the Mac"), "nobody was at the console, so the first box user is signed in");
  assert.ok(!result.stdout.includes("Check these"), result.stdout);

  const admin = mac.user("bbbox-admin")!;
  assert.deepEqual([admin.RealName, admin.IsHidden, admin.NFSHomeDirectory], ["bb-box admin", "1", "/private/var/bbbox-admin"]);
  assert.equal(statSync(join(mac.root, "private/var/bbbox-admin")).mode & 0o777, 0o700, "closed to box users, in staff (047)");
  // bb-box-own, which runs a granted program as its own responsible process (058).
  assert.ok(statSync(join(mac.root, "usr/local/bin/bb-box-own")).mode & 0o111, "bb-box-own is built");
  assert.ok(statSync(join(mac.root, "usr/local/bin/bb-box-stream")).mode & 0o111, "bb-box-stream is built (060)");
  // bb-box-display, which gives each box user's desktop the 2x mode of its size.
  assert.ok(statSync(join(mac.root, "usr/local/bin/bb-box-display")).mode & 0o111, "bb-box-display is built");
  // The agent CLIs, pinned, linked from /usr/local/bin (#561).
  for (const [command, target] of [
    ["claude", "/usr/local/lib/bb-box/claude-code-2.1.283/claude"],
    ["codex", "/usr/local/lib/bb-box/codex-0.157.1/codex-aarch64-apple-darwin"],
    ["pi", "/usr/local/lib/bb-box/pi-0.87.1/pi"],
  ]) {
    assert.equal(readlinkSync(join(mac.root, "usr/local/bin", command)), target, command);
    assert.ok(statSync(join(mac.root, target)).mode & 0o111, `${command} is executable`);
  }
  assert.equal(mac.file("/private/var/bbbox-admin/.ssh/authorized_keys"), "restrict ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box\n");
  assert.equal(mac.file("/etc/sudoers.d/bb-box"), "Defaults:bbbox-admin !requiretty\nbbbox-admin ALL=(root) NOPASSWD: /usr/local/libexec/bb-box/machine\n");
  assert.equal(statSync(join(mac.root, "usr/local/libexec/bb-box/machine")).mode & 0o777, 0o755);
  assert.match(mac.file("/usr/local/share/bb-box/home/.zshenv")!, /path_helper/);
  assert.equal(mac.file("/usr/local/share/bb-box/cua-driver"), "0.30.4\n");
  // BlackHole 2ch, the box's audio input, pinned as Tart's image pins it (#631).
  assert.equal(mac.file("/usr/local/share/bb-box/blackhole"), "0.7.1\n");
  assert.equal(count(mac, "installer -pkg "), 1);
  assert.equal(count(mac, "killall coreaudiod"), 1);
  assert.equal(mac.file("/Applications/CuaDriver.app/Contents/MacOS/cua-driver"), "#!/bin/sh\n");
  assert.equal(readlinkSync(join(mac.root, "usr/local/bin/cua-driver")), "/Applications/CuaDriver.app/Contents/MacOS/cua-driver");
  assert.match(mac.file("/Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist")!, /rm -rf \/Users\/bbx-\*\/\.bb-machines\/\*\/daemon\.lock\.lock /);
  assert.equal(count(mac, "sudo -u person -H env NONINTERACTIVE=1 /bin/bash -c mkdir"), 1, "Homebrew's installer, as the person who ran sudo");
  assert.equal(count(mac, "brew install git gh node ffmpeg"), 1);
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
  // With SIP off, sshd-keygen-wrapper gets Screen Recording, by path with its requirement (058).
  mac.flag("sip-off");
  const tcc = join(mac.root, TCC);
  rmSync(tcc, { force: true });
  assert.equal(spawnSync("sqlite3", [tcc, TCC_SCHEMA]).status, 0);
  mkdirSync(join(mac.root, "usr/libexec"), { recursive: true });
  writeFileSync(join(mac.root, "usr/libexec/sshd-keygen-wrapper.sig"), 'identifier=com.apple.sshd-keygen-wrapper\nrequirement=identifier "com.apple.sshd-keygen-wrapper" and anchor apple\n');
  // An approval placed in the template by hand before the helper wrote one per user (047): setup removes it.
  const placed = join(mac.root, "usr/local/share/bb-box/home/Library/Group Containers/group.com.apple.replayd");
  mkdirSync(placed, { recursive: true });
  writeFileSync(join(placed, "ScreenCaptureApprovals.plist"), "<plist/>\n");
  const again = mac.setup(["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box", "--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherInstall bb-box", "--name", "studio"]);
  assert.equal(again.status, 0, again.stderr);
  assert.ok(again.stdout.includes("\n  studio bbbox-admin@192.0.2.30 macos,macos-desktop\n"));
  assert.match(again.stdout, /- iOS slots are not set up, as setup\/tart\/ios is not beside setup\/ssh-pool\. To lend ios boxes from this Mac, copy the whole setup folder/);

  assert.ok(again.stdout.includes("\n5. Restart the Mac, so that it signs in the first box user, bbx-0.\n"), again.stdout);
  assert.equal(mac.file("/private/var/bbbox-admin/.ssh/authorized_keys")!.split("\n").length, 3);
  assert.equal(count(mac, "sysadminctl -addUser bbbox-admin"), 1);
  assert.equal(count(mac, "sudo -u person -H env NONINTERACTIVE=1"), 1, "Homebrew is installed once");
  assert.equal(mac.calls().filter((line) => line.startsWith("curl -fsSL --retry 3 -o") && line.includes("cua-driver-rs")).length, 1, "Cua Driver is downloaded once");
  assert.equal(count(mac, "installer -pkg "), 1, "BlackHole is installed once");
  assert.equal(mac.calls().filter((line) => line.startsWith("curl -fsSL --retry 3 -o") && line.endsWith("/googlechrome.dmg")).length, 2, "Chrome is downloaded each time, and kept when as new");
  assert.equal(count(mac, "ditto "), 1, "and copied in once");
  assert.ok(existsSync(join(mac.root, "Applications/Google Chrome.app/Contents/Info.plist")));
  // Its policies where macOS keeps them without device management, and box users' profiles past its first run.
  assert.ok(mac.calls().some((line) => /^defaults write \S*\/Library\/Preferences\/com\.google\.Chrome DefaultBrowserSettingEnabled -bool false$/.test(line)), "the default-browser prompt off");
  assert.equal(existsSync(join(mac.root, "Library/Managed Preferences/com.google.Chrome.plist")), false, "nothing where macOS empties it at boot");
  assert.equal(mac.file("/usr/local/share/bb-box/home/Library/Application Support/Google/Chrome/First Run"), "");
  assert.equal(mac.file("/usr/local/share/bb-box/home/Library/Application Support/Google/Chrome/Local State"), '{"browser":{"last_whats_new_version":9999}}\n');
  assert.match(mac.file("/usr/local/libexec/bb-box/chrome-policies.mjs")!, /chrome:\/\/policy/, "the reader the image's check runs");
  for (const file of ["/claude", "codex-aarch64-apple-darwin.tar.gz", "pi-darwin-arm64.tar.gz"]) {
    assert.equal(mac.calls().filter((line) => line.startsWith("curl -fsSL --retry 3 -o") && line.endsWith(file)).length, 1, `${file} is downloaded once`);
  }
  for (const call of ["xcodebuild -license accept", "xcodebuild -runFirstLaunch", "DevToolsSecurity -enable"]) assert.equal(count(mac, call), 1, call);
  assert.equal(count(mac, "xcodebuild -downloadPlatform iOS"), 0, "the iOS runtime is there");
  assert.equal(mac.file("/var/db/bb-box/xcode"), "xcode=26.0\nruntimes=iOS 26.0,watchOS 26.0\n", "what the pool's offers follow");
  assert.equal(count(mac, "sudo -u person open x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"), 1);
  assert.equal(mac.file("/var/db/bb-box/generation"), "0\n");
  assert.equal(existsSync(join(mac.root, "usr/local/share/bb-box/home/Library/Group Containers")), false, "the hand-placed approval is gone");
  assert.equal(
    spawnSync("sqlite3", [tcc, "select client_type || '|' || auth_value || '|' || cast(csreq as text) from access where service = 'kTCCServiceScreenCapture' and client = '/usr/libexec/sshd-keygen-wrapper';"], { encoding: "utf8" }).stdout.trim(),
    '1|2|identifier "com.apple.sshd-keygen-wrapper" and anchor apple',
  );
  // With the whole setup folder, but no slimming list for this Mac's iOS runtime.
  const ios = join(mac.root, "..", "tart", "ios");
  mkdirSync(join(ios, "slim"), { recursive: true });
  for (const file of ["device-host.sh", "device-host-ports.pl", "slot-clipboard.sh", "devices.tsv", "pins", "idb-companion-LICENSE"]) writeFileSync(join(ios, file), readFileSync(fileURLToPath(new URL(`../setup/tart/ios/${file}`, import.meta.url))));
  const idb = tempDir("idb");
  writeFileSync(join(idb, "idb_companion"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(spawnSync("tar", ["-czf", join(mac.state, "flags", "idb-companion.macos-arm64.tar.gz"), "-C", idb, "idb_companion"]).status, 0);
  const unlisted = mac.setup(["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box", "--name", "studio"]);
  assert.equal(unlisted.status, 0, unlisted.stderr);
  assert.match(unlisted.stderr, /mac-ios\.sh: bb-box has no slimming list for iOS 26\.0 \(23A343\), so it lends no iOS slot on this Mac/);
  assert.match(unlisted.stdout, /- iOS slots are not set up, so the Mac lends no ios box: mac-ios\.sh says why above\./);
  assert.ok(unlisted.stdout.includes("\n  studio bbbox-admin@192.0.2.30 macos,macos-desktop\n"), "no ios on its line");
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

test("setup-mac.sh refuses a Chrome that Gatekeeper does not accept, or that Google's team did not sign", () => {
  for (const [flag, said] of [["gatekeeper-refuses", "Gatekeeper does not accept Chrome's app as notarised"], ["", "Chrome's app is not signed by Google's team, EQHXZ8M8AV"]] as const) {
    const mac = setupMac();
    if (flag) mac.flag(flag, true);
    else {
      // The same image, signed by another team.
      const work = tempDir("chrome-other");
      mkdirSync(join(work, "Google Chrome.app", "Contents"), { recursive: true });
      writeFileSync(join(work, "Google Chrome.app", "Contents", "Info.plist"), "<plist><dict><key>CFBundleShortVersionString</key><string>155.0.8059.85</string></dict></plist>\n");
      writeFileSync(join(work, "Google Chrome.app.sig"), "identifier=com.google.Chrome\nteam=SOMEONEELS\n");
      assert.equal(spawnSync("tar", ["-cf", join(mac.state, "flags", "googlechrome.dmg"), "-C", work, "Google Chrome.app", "Google Chrome.app.sig"]).status, 0);
    }
    const result = mac.setup(["--key", "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPoolKeyForTests bb-box"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`mac-chrome.sh: ${said}`), result.stderr);
    assert.ok(result.stderr.includes("Could not install Google Chrome."), result.stderr);
    assert.equal(existsSync(join(mac.root, "Applications/Google Chrome.app")), false);
  }
});

test("setup-mac.sh pins the Cua Driver that Tart's image pins", () => {
  const pins = (path: string) => {
    const text = readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");
    return [/^CUA_VERSION=(.+)$/m.exec(text)?.[1], /^CUA_SHA256=(.+)$/m.exec(text)?.[1]];
  };
  assert.deepEqual(pins("../setup/ssh-pool/setup-mac.sh"), pins("../setup/tart/prepare-image.sh"));
  assert.deepEqual(pins("../setup/ssh-pool/setup-mac.sh"), [CUA_VERSION, CUA_SHA256], "and the Namespace Macs install, as src/backends/tart/backend.ts pins it");
  assert.match(pins("../setup/ssh-pool/setup-mac.sh")[1]!, /^[0-9a-f]{64}$/);
});

test("setup-mac.sh pins the agent CLIs at the versions the Linux images pin (#561)", () => {
  const script = readFileSync(fileURLToPath(new URL("../setup/ssh-pool/setup-mac.sh", import.meta.url)), "utf8");
  const pins = JSON.parse(readFileSync(fileURLToPath(new URL("../setup/proxmox-lxc/template/pins.json", import.meta.url)), "utf8")) as { tools: { name: string; arch: string; version: string }[] };
  for (const [variable, name] of [["CLAUDE", "claude-code"], ["CODEX", "codex"], ["PI", "pi"]] as const) {
    const pinned = pins.tools.find((tool) => tool.name === name && tool.arch === "arm64")?.version;
    assert.ok(pinned, name);
    assert.equal(new RegExp(`^${variable}_VERSION=(\\S+)$`, "m").exec(script)?.[1], pinned, name);
    assert.match(script, new RegExp(`^${variable}_SHA256=[0-9a-f]{64}$`, "m"), `${name} has a SHA-256`);
  }
});

test("the doctor's status names the people whose homes box users can enter, as macOS makes a home readable to staff", () => {
  const mac = readyMac();
  writeFileSync(join(mac.state, "users", "person", "UserShell"), "/bin/zsh\n");
  const home = join(mac.data, "Users", "person");
  mkdirSync(home, { recursive: true });
  chmodSync(home, 0o750);
  assert.equal(fields(mac.helper(["status", "xcode"]).stdout).get("openhomes"), "person");
  assert.equal(fields(mac.helper(["status"]).stdout).get("openhomes"), undefined, "not in an ordinary status");
  chmodSync(home, 0o700);
  assert.equal(fields(mac.helper(["status", "xcode"]).stdout).get("openhomes"), "", "closed to others");
  // A hidden user, as BB Box's admin, is not a person's, though macOS names the flag dsAttrTypeNative:IsHidden.
  for (const [name, value] of Object.entries({ UniqueID: "502", UserShell: "/bin/zsh", IsHidden: "1", NFSHomeDirectory: "/private/var/hidden" })) {
    mkdirSync(join(mac.state, "users", "hidden"), { recursive: true });
    writeFileSync(join(mac.state, "users", "hidden", name), `${value}\n`);
  }
  mkdirSync(join(mac.data, "private/var/hidden"), { recursive: true });
  chmodSync(join(mac.data, "private/var/hidden"), 0o755);
  assert.equal(fields(mac.helper(["status", "xcode"]).stdout).get("openhomes"), "");
  // A user with no login shell, as macOS's service accounts, is not a person's.
  chmodSync(home, 0o755);
  writeFileSync(join(mac.state, "users", "person", "UserShell"), "/usr/bin/false\n");
  assert.equal(fields(mac.helper(["status", "xcode"]).stdout).get("openhomes"), "");
});

/** macOS 27's TCC access table, as a Mac with SIP off showed it (058). */
const TCC_SCHEMA = `CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL, auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL, csreq BLOB, policy_id INTEGER, indirect_object_identifier_type INTEGER, indirect_object_identifier TEXT NOT NULL DEFAULT 'UNUSED', indirect_object_code_identity BLOB, flags INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), pid INTEGER, pid_version INTEGER, boot_uuid TEXT NOT NULL DEFAULT 'UNUSED', last_reminded INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), one_time_reprompt_eligible INTEGER, reminder_count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (service, client, client_type, indirect_object_identifier));`;
const MACOS_26_TCC_SCHEMA = `CREATE TABLE access (service TEXT NOT NULL, client TEXT NOT NULL, client_type INTEGER NOT NULL, auth_value INTEGER NOT NULL, auth_reason INTEGER NOT NULL, auth_version INTEGER NOT NULL, csreq BLOB, policy_id INTEGER, indirect_object_identifier_type INTEGER, indirect_object_identifier TEXT NOT NULL DEFAULT 'UNUSED', indirect_object_code_identity BLOB, flags INTEGER, last_modified INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), pid INTEGER, pid_version INTEGER, boot_uuid TEXT NOT NULL DEFAULT 'UNUSED', last_reminded INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), PRIMARY KEY (service, client, client_type, indirect_object_identifier));`;
const NEWER_TCC_SCHEMA = TCC_SCHEMA.replace("reminder_count INTEGER NOT NULL DEFAULT 0,", "reminder_count INTEGER NOT NULL DEFAULT 0, granted_by TEXT,");
const sqlite = (db: string, sql: string) => {
  const run = spawnSync("sqlite3", [db, sql], { encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
};

test("with SIP off, the helper grants the box user's programs their permissions, by bundle ID or path with their requirement, and the reset removes every row added since the claim (058)", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 && "needs sqlite3" }, () => {
  const mac = readyMac();
  mac.flag("sip-off");
  // The system database, with Cua's grant from before the box, and the box user's, which macOS 27 keeps outside the home.
  const system = join(mac.root, TCC);
  rmSync(system, { force: true });
  sqlite(system, `${TCC_SCHEMA} INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', 'com.trycua.driver', 0, 2, 4, 1);`);
  const container = join(mac.data, "private/var/containers/Data/ProtectedSystem/U1/Data/Library/Application Support/com.apple.TCC");
  mkdirSync(container, { recursive: true });
  const user = join(container, "TCC.db");
  sqlite(user, TCC_SCHEMA);
  mac.add("processes", "500 70000 tccd 1");
  mkdirSync(join(mac.state, "openfiles"), { recursive: true });
  writeFileSync(join(mac.state, "openfiles", "500"), `${user}\n`);
  assert.equal(fields(mac.helper(["status"]).stdout).get("sip"), "0", "status says SIP is off");
  assert.equal(mac.helper(["claim", "0"], CLAIM()).status, 0);

  // An app the agent built, signed by the box's identity, and a program cargo built, signed only ad hoc.
  const home = join(mac.data, "Users/bbx-0");
  const app = join(home, "Applications/Probe.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>dev.example.probe</string></dict></plist>\n");
  writeFileSync(`${app}.sig`, 'identifier=dev.example.probe\nrequirement=identifier "dev.example.probe" and certificate leaf = H"ab"\n');
  const tool = join(home, "project/target/release/tool");
  mkdirSync(join(home, "project/target/release"), { recursive: true });
  writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(`${tool}.sig`, 'identifier=tool\nrequirement=cdhash H"12"\n');
  const grant = (program: string, permissions: string[], box = "box_a") =>
    mac.helper(["grant"], `install=inst_a\nbox=${box}\nprogram=${program}\n${permissions.map((permission) => `permission=${permission}\n`).join("")}`);

  const granted = grant("/Users/bbx-0/Applications/Probe.app", ["accessibility", "screen-recording", "microphone", "system-audio", "telepathy"]);
  assert.equal(granted.status, 0, granted.stderr);
  assert.deepEqual(granted.stdout.split("\n").filter(Boolean), [
    "granted=accessibility",
    "granted=screen-recording",
    "granted=microphone",
    "granted=system-audio",
    "refused=telepathy bb-box grants accessibility, screen-recording, input-monitoring, microphone, camera, system-audio and automation.",
    "client=dev.example.probe",
  ]);
  assert.equal(
    sqlite(system, "select service || '|' || client_type || '|' || auth_value || '|' || cast(csreq as text) from access where client = 'dev.example.probe' order by service;"),
    'kTCCServiceAccessibility|0|2|identifier "dev.example.probe" and certificate leaf = H"ab"\nkTCCServiceScreenCapture|0|2|identifier "dev.example.probe" and certificate leaf = H"ab"',
    "an app by bundle ID, with its requirement",
  );
  assert.equal(
    sqlite(user, "select service || '|' || auth_value from access where client = 'dev.example.probe' order by service;"),
    "kTCCServiceAudioCapture|2\nkTCCServiceMicrophone|2",
    "the microphone and the system's audio in the box user's database",
  );
  // A program signed only ad hoc, by its path alone, which a rebuild keeps.
  assert.equal(grant("/Users/bbx-0/project/target/release/tool", ["accessibility"]).stdout.split("\n")[0], "granted=accessibility");
  assert.equal(sqlite(system, "select client_type || '|' || ifnull(csreq, 'none') from access where client = '/Users/bbx-0/project/target/release/tool';"), "1|none");
  // What box_status lists, only to the box that holds the Mac.
  assert.deepEqual(mac.helper(["granted", "0"], RELEASE()).stdout.split("\n").filter(Boolean), [
    "sip=0",
    "tcc=1",
    "macos=26.0",
    "signing=1",
    "grant=accessibility\tdev.example.probe\tUNUSED",
    "grant=screen-recording\tdev.example.probe\tUNUSED",
    "grant=microphone\tdev.example.probe\tUNUSED",
    "grant=system-audio\tdev.example.probe\tUNUSED",
    "grant=accessibility\t/Users/bbx-0/project/target/release/tool\tUNUSED",
  ]);
  assert.equal(mac.helper(["granted", "0"], RELEASE("box_b")).status, EXIT.notOurs);
  // A denied row macOS wrote while the box had the Mac.
  sqlite(system, "INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version) VALUES ('kTCCServiceAccessibility', 'dev.example.asked', 0, 0, 4, 1);");

  // Refusals: Apple's, a shell, outside the box user's folders, another box, and SIP on.
  writeFileSync(`${tool}.sig`, 'identifier=com.apple.tool\nrequirement=identifier "com.apple.tool"\n');
  assert.match(grant("/Users/bbx-0/project/target/release/tool", ["accessibility"]).stderr, /is Apple's\. bb-box grants nothing to Apple's programs\./);
  writeFileSync(join(home, "zsh"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(home, "zsh.sig"), 'identifier=zsh\nrequirement=cdhash H"34"\n');
  assert.match(grant("/Users/bbx-0/zsh", ["accessibility"]).stderr, /runs any script/);
  assert.equal(grant("/usr/local/bin/cua-driver", ["accessibility"]).status, 8);
  assert.equal(grant("/Users/bbx-0/Applications/Probe.app", ["accessibility"], "box_b").status, EXIT.notOurs);
  mac.flag("sip-off", false);
  const protectedMac = grant("/Users/bbx-0/Applications/Probe.app", ["accessibility"]);
  assert.equal(protectedMac.status, 7);
  assert.match(protectedMac.stderr, /^System Integrity Protection is on/);
  mac.flag("sip-off");

  // What a user reset while SIP was on left: its container and its temporary folder, and a person's, which stays.
  const protectedSystem = join(mac.data, "private/var/containers/Data/ProtectedSystem");
  for (const [dir, uid] of [["U5", 70005], ["U501", 501]] as const) {
    mkdirSync(join(protectedSystem, dir, "Data"), { recursive: true });
    mac.own(`/private/var/containers/Data/ProtectedSystem/${dir}`, uid);
  }
  mkdirSync(join(mac.data, "private/var/folders/zz/old70005/T"), { recursive: true });
  mac.own("/private/var/folders/zz/old70005", 70005);

  // The reset removes every row added since the claim, the helper's and macOS's, and leaves Cua's.
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, 0);
  assert.equal(sqlite(system, "select client from access order by client;"), "com.trycua.driver");
  assert.deepEqual([existsSync(join(protectedSystem, "U5")), existsSync(join(protectedSystem, "U501"))], [false, true], "an old box user's container goes, a person's stays");
  assert.equal(existsSync(join(mac.data, "private/var/folders/zz/old70005")), false);
});

test("with SIP off, each box user's commands get the microphone and the camera in its own TCC database, which the reset keeps (058)", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 && "needs sqlite3" }, () => {
  const mac = readyMac();
  const container = join(mac.data, "private/var/containers/Data/ProtectedSystem/U1/Data/Library/Application Support/com.apple.TCC");
  mkdirSync(container, { recursive: true });
  const user = join(container, "TCC.db");
  sqlite(user, TCC_SCHEMA);
  mac.add("processes", "500 70000 tccd 1");
  mkdirSync(join(mac.state, "openfiles"), { recursive: true });
  writeFileSync(join(mac.state, "openfiles", "500"), `${user}\n`);
  mkdirSync(join(mac.root, "usr/libexec"), { recursive: true });
  writeFileSync(join(mac.root, "usr/libexec/sshd-keygen-wrapper.sig"), 'identifier=com.apple.sshd-keygen-wrapper\nrequirement=identifier "com.apple.sshd-keygen-wrapper" and anchor apple\n');
  const rows = "select service || '|' || client || '|' || client_type || '|' || auth_value || '|' || cast(csreq as text) from access order by service;";

  mac.flag("sip-off");
  assert.equal(mac.helper(["claim", "0"], CLAIM()).status, 0);
  const granted = [
    'kTCCServiceCamera|/usr/libexec/sshd-keygen-wrapper|1|2|identifier "com.apple.sshd-keygen-wrapper" and anchor apple',
    'kTCCServiceMicrophone|/usr/libexec/sshd-keygen-wrapper|1|2|identifier "com.apple.sshd-keygen-wrapper" and anchor apple',
  ].join("\n");
  assert.equal(sqlite(user, rows), granted);
  // They are the box user's from before the claim, so the reset keeps them.
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, 0);
  assert.equal(sqlite(user, rows), granted);
});

test("in a Mac VM that is itself the box, as Tart's are, the helper makes the user's identity and default grants at the start, and grants with no owner marker (058)", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 && "needs sqlite3" }, () => {
  // A VM's user, here bbx-0 as init makes it; no box claims the Mac.
  const mac = readyMac();
  mac.flag("sip-off");
  const system = join(mac.root, TCC);
  rmSync(system, { force: true });
  sqlite(system, TCC_SCHEMA);
  const container = join(mac.data, "private/var/containers/Data/ProtectedSystem/U1/Data/Library/Application Support/com.apple.TCC");
  mkdirSync(container, { recursive: true });
  const user = join(container, "TCC.db");
  sqlite(user, TCC_SCHEMA);
  mac.add("processes", "500 70000 tccd 1");
  mkdirSync(join(mac.state, "openfiles"), { recursive: true });
  writeFileSync(join(mac.state, "openfiles", "500"), `${user}\n`);
  mkdirSync(join(mac.root, "usr/libexec"), { recursive: true });
  writeFileSync(join(mac.root, "usr/libexec/sshd-keygen-wrapper.sig"), 'identifier=com.apple.sshd-keygen-wrapper\nrequirement=identifier "com.apple.sshd-keygen-wrapper" and anchor apple\n');

  const ready = mac.helper(["vm-ready", "bbx-0"]);
  assert.equal(ready.status, 0, ready.stderr);
  assert.equal(ready.stdout, "sip=0\ntcc=1\nmacos=26.0\nsigning=1\n");
  assert.ok(existsSync(join(mac.root, "/Users/bbx-0/Library/Keychains/bb-box-signing.keychain-db")));
  assert.equal(sqlite(user, "select service from access where client = '/usr/libexec/sshd-keygen-wrapper' order by service;"), "kTCCServiceCamera\nkTCCServiceMicrophone");
  // A desktop command's screencapture raises no notice: the approvals cover SSH and Tart's launcher too.
  const approvals = mac.file("/Users/bbx-0/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist")!;
  assert.ok(approvals.includes("<key>/usr/libexec/sshd-keygen-wrapper</key>") && approvals.includes("<key>file:///usr/local/libexec/bb-box/Launcher.app/</key>"), approvals);

  const tool = join(mac.data, "Users/bbx-0/bin/tool");
  mkdirSync(dirname(tool), { recursive: true });
  writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(`${tool}.sig`, 'identifier=tool\nrequirement=identifier "tool" and certificate leaf = H"ab"\n');
  const granted = mac.helper(["vm-grant", "bbx-0"], "program=/Users/bbx-0/bin/tool\npermission=accessibility\n");
  assert.equal(granted.status, 0, granted.stderr);
  assert.equal(granted.stdout, "granted=accessibility\nclient=/Users/bbx-0/bin/tool\n");
  assert.equal(sqlite(system, "select client from access where service = 'kTCCServiceAccessibility';"), "/Users/bbx-0/bin/tool");
  assert.deepEqual(mac.helper(["vm-granted", "bbx-0"]).stdout.split("\n").filter(Boolean), ["sip=0", "tcc=1", "macos=26.0", "signing=1", "grant=accessibility\t/Users/bbx-0/bin/tool\tUNUSED"]);
  // Refusals as on a pool Mac: outside the user's folders, or SIP on.
  assert.equal(mac.helper(["vm-grant", "bbx-0"], "program=/usr/local/bin/tool\npermission=accessibility\n").status, 8);
  mac.flag("sip-off", false);
  const on = mac.helper(["vm-grant", "bbx-0"], "program=/Users/bbx-0/bin/tool\npermission=accessibility\n");
  assert.equal(on.status, 7);
  assert.match(on.stderr, /^System Integrity Protection is on/);
  assert.equal(mac.helper(["vm-grant"]).status, 2);
});

test("each box user's desktop gets the 2x mode of its size for its session, after its sign-in and at a claim, where setup-mac.sh built bb-box-display", () => {
  const mac = readyMac();
  const display = "launchctl asuser 70000 /usr/bin/sudo -n -H -u bbx-0 -- /usr/local/bin/bb-box-display hidpi";
  // Without the tool, as before setup-mac.sh builds it, nothing runs.
  assert.equal(mac.helper(["claim", "0"], CLAIM()).status, 0);
  assert.equal(count(mac, display), 0);
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, 0);
  mkdirSync(join(mac.root, "usr/local/bin"), { recursive: true });
  writeFileSync(join(mac.root, "usr/local/bin/bb-box-display"), "#!/bin/sh\n", { mode: 0o755 });
  assert.equal(mac.helper(["claim", "1"], CLAIM("box_b")).status, 0);
  assert.equal(count(mac, display.replaceAll("70000", "70001").replace("bbx-0", "bbx-1")), 1, "at the claim");
  assert.equal(mac.helper(["release", "1"], RELEASE("box_b")).status, 0);
  assert.equal(count(mac, display.replaceAll("70000", "70002").replace("bbx-0", "bbx-2")), 1, "after the next user's sign-in");
});

test("each box user gets a code-signing identity of its own in a keychain codesign uses with no prompt, made at the reset and unlocked at each claim (058)", () => {
  const mac = lentMac();
  const keychain = "/Users/bbx-0/Library/Keychains/bb-box-signing.keychain-db";
  assert.ok(existsSync(join(mac.root, keychain)), "made at the claim, as the first user had none");
  const calls = mac.calls().filter((line) => line.startsWith("security "));
  for (const call of [
    `security create-keychain -p  ${keychain}`,
    `security import`,
    `security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k  ${keychain}`,
    `security unlock-keychain -p  ${keychain}`,
  ]) {
    assert.ok(calls.some((line) => line.startsWith(call)), call);
  }
  assert.ok(readFileSync(join(mac.state, "keychains", "0"), "utf8").split("\n").includes(keychain), "on the user's search list");
  assert.ok(mac.calls().some((line) => /^security import \S+\/id\.p12 -k \S+ -P \S+ -A$/.test(line)), "imported for all apps");

  // The next user's is made at the reset, once it is signed in, so its claim only unlocks it.
  assert.equal(mac.helper(["release", "0"], RELEASE()).status, 0);
  assert.ok(existsSync(join(mac.root, "/Users/bbx-1/Library/Keychains/bb-box-signing.keychain-db")));
  const before = mac.calls().length;
  assert.equal(mac.helper(["claim", "1"], CLAIM("box_b")).status, 0);
  const claim = mac.calls().slice(before).filter((line) => line.startsWith("security "));
  assert.ok(claim.some((line) => line.startsWith("security unlock-keychain")) && !claim.some((line) => line.startsWith("security create-keychain")), claim.join("; "));
  const signing = (generation: string, box: string) => fields(mac.helper(["granted", generation], RELEASE(box)).stdout).get("signing");
  assert.equal(signing("1", "box_b"), "1", "box_status can say the box has its identity");
  // The work folder is in /tmp, which the box user can enter, not in root's own temporary folder.
  assert.ok(mac.calls().some((line) => /^security import \/tmp\/bb-box-signing\.\w+\/id\.p12 /.test(line)), "imported from /tmp");

  // A failed attempt is reported, and leaves no keychain.
  mac.flag("no-import");
  assert.equal(mac.helper(["release", "1"], RELEASE("box_b")).status, 0);
  const next = join(mac.root, "/Users/bbx-2/Library/Keychains/bb-box-signing.keychain-db");
  assert.equal(existsSync(next), false);
  // A keychain without the identity, as an earlier attempt could leave, is made again at the claim.
  writeFileSync(next, "");
  mac.flag("no-import", false);
  assert.equal(mac.helper(["claim", "2"], CLAIM("box_c")).status, 0);
  assert.equal(readFileSync(next, "utf8"), "identity\n");
  assert.equal(signing("2", "box_c"), "1");
  mac.flag("no-import");
  assert.equal(mac.helper(["release", "2"], RELEASE("box_c")).status, 0);
  assert.equal(mac.helper(["claim", "3"], CLAIM("box_d")).status, 0);
  assert.equal(signing("3", "box_d"), "0", "box_status can say the box has no identity");
});

function probedSnapshots(mac: FakeMacos) {
  const probe = mac.helper(["snapshot", "probe"]);
  assert.equal(probe.status, 0, probe.stderr);
  const report = parseSnapshotReport(probe.stdout, "mac-1");
  assert.ok(report, probe.stdout);
  return report;
}

test("snapshot probe finds APFS clones under /Users, keeps its report for status, and says why not where it cannot clone", () => {
  const mac = readyMac();

  const apfs = probedSnapshots(mac);

  assert.deepEqual([apfs.homes, apfs.filesystem, apfs.home, apfs.hook], ["/Users", "apfs", { is: "yes", what: { way: "apfs", dataset: null } }, { is: "no", why: "no snapshot hook is installed" }]);
  assert.match(mac.helper(["status"]).stdout, /^snapshot\.home=yes$/m);
  assert.deepEqual(readdirSync(join(mac.root, "var/db/bb-box/snapshot-trials")), []);

  mac.flag("no-clonefile");
  assert.match(JSON.stringify(probedSnapshots(mac).home), /^\{"is":"no","why":"box homes are on APFS under \/Users, but a trial clone failed: cp: .*clonefile failed: Operation not supported"\}$/);
  assert.deepEqual(readdirSync(join(mac.root, "var/db/bb-box/snapshot-trials")), []);
  mac.flag("no-clonefile", false);

  rmSync(join(mac.root, TCC));
  assert.deepEqual(probedSnapshots(mac).home, { is: "no", why: "box homes are on APFS under /Users, but the helper lacks Full Disk Access, which it needs to clone the folders macOS protects in a home" });
  writeFileSync(join(mac.root, TCC), "SQLite format 3\0");

  mac.flag("homes-fs", true, "hfs");
  assert.deepEqual([probedSnapshots(mac).filesystem, probedSnapshots(mac).home], ["hfs", { is: "no", why: "" }]);
});

test("snapshot probe runs an operator's hook's describe, and says when it fails", () => {
  const mac = readyMac();
  const hook = join(mac.root, "usr/local/libexec/bb-box/snapshot-machine");
  mkdirSync(dirname(hook), { recursive: true });
  writeFileSync(hook, `#!/bin/sh\n[ "$1" = describe ] && printf '{"contract":1,"scope":"machine",\\n"storage":{"name":"vg0/thin","type":"lvmthin","percentFull":12}}\\n'\n`, { mode: 0o755 });

  const found = probedSnapshots(mac);

  assert.deepEqual(found.hook, { is: "yes", what: { whileRunning: null, restarts: null, storage: { name: "vg0/thin", type: "lvmthin", percentFull: 12 } } });

  writeFileSync(hook, "#!/bin/sh\necho 'lvs: volume group vg0 not found' >&2\nexit 3\n", { mode: 0o755 });
  assert.deepEqual(probedSnapshots(mac).hook, { is: "no", why: "its snapshot hook's describe failed: it exited with 3: lvs: volume group vg0 not found" });
});

test("on a Mac VM with macOS 26's TCC schema, as Namespace's Macs have, the helper grants, and on a schema it does not know it refuses with the reason (058)", { skip: spawnSync("sqlite3", ["-version"]).status !== 0 && "needs sqlite3" }, () => {
  const mac = readyMac();
  mac.flag("sip-off");
  const system = join(mac.root, TCC);
  rmSync(system, { force: true });
  sqlite(system, MACOS_26_TCC_SCHEMA);
  const user = join(mac.data, "Users/bbx-0/Library/Application Support/com.apple.TCC/TCC.db");
  mkdirSync(dirname(user), { recursive: true });
  sqlite(user, MACOS_26_TCC_SCHEMA);
  mac.add("processes", "500 70000 tccd 1");
  mkdirSync(join(mac.state, "openfiles"), { recursive: true });
  writeFileSync(join(mac.state, "openfiles", "500"), `${user}\n`);
  const app = join(mac.data, "Users/bbx-0/Applications/Probe.app");
  mkdirSync(join(app, "Contents"), { recursive: true });
  writeFileSync(join(app, "Contents/Info.plist"), "<plist><dict><key>CFBundleIdentifier</key><string>dev.example.probe</string></dict></plist>\n");
  writeFileSync(`${app}.sig`, 'identifier=dev.example.probe\nrequirement=identifier "dev.example.probe" and certificate leaf = H"ab"\n');
  const tool = join(mac.data, "Users/bbx-0/bin/micprobe");
  mkdirSync(dirname(tool), { recursive: true });
  writeFileSync(tool, "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(`${tool}.sig`, 'identifier=dev.example.micprobe\nrequirement=identifier "dev.example.micprobe" and certificate leaf = H"ab"\n');
  mac.flag("macos", true, "26.3.1");

  assert.deepEqual(mac.helper(["vm-ready", "bbx-0"]).stdout.split("\n").filter(Boolean).slice(0, 3), ["sip=0", "tcc=1", "macos=26.3.1"]);
  const appGrant = mac.helper(["vm-grant", "bbx-0"], "program=/Users/bbx-0/Applications/Probe.app\npermission=accessibility\npermission=screen-recording\n");
  const cliGrant = mac.helper(["vm-grant", "bbx-0"], "program=/Users/bbx-0/bin/micprobe\npermission=microphone\n");

  assert.equal(appGrant.stdout, "granted=accessibility\ngranted=screen-recording\nclient=dev.example.probe\n", appGrant.stderr);
  assert.equal(cliGrant.stdout, "granted=microphone\nclient=/Users/bbx-0/bin/micprobe\n", cliGrant.stderr);
  assert.equal(sqlite(system, "select service || '|' || client || '|' || client_type || '|' || auth_value from access order by service;"), "kTCCServiceAccessibility|dev.example.probe|0|2\nkTCCServiceScreenCapture|dev.example.probe|0|2");
  assert.equal(sqlite(user, "select service || '|' || client || '|' || client_type || '|' || auth_value from access where client = '/Users/bbx-0/bin/micprobe';"), "kTCCServiceMicrophone|/Users/bbx-0/bin/micprobe|1|2");

  rmSync(system);
  sqlite(system, NEWER_TCC_SCHEMA);
  const newer = mac.helper(["vm-grant", "bbx-0"], "program=/Users/bbx-0/Applications/Probe.app\npermission=accessibility\n");

  assert.equal(newer.status, EXIT.protected);
  assert.equal(newer.stderr, "TCC's database on this Mac has columns bb-box does not know, as a newer macOS may have, so it writes nothing there. A person grants permissions in System Settings, or a newer bb-box may know them.\n");
  assert.equal(sqlite(system, "select count(*) from access;"), "0");
  assert.deepEqual(mac.helper(["vm-granted", "bbx-0"]).stdout.split("\n").filter(Boolean).slice(0, 2), ["sip=0", "tcc=0"]);
});
