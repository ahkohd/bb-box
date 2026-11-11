import assert from "node:assert/strict";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { describe, test, type TestContext } from "node:test";
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

const LIKE_SUDO = `use POSIX ":sys_wait_h"; $| = 1; my $command = fork(); if (!$command) { exec "sleep", "60" } print "$command\\n";
sub stopped { open(my $stat, "<", "/proc/$command/stat") or return 0; return (split(" ", <$stat>))[2] eq "T" }
while (1) { my $done = waitpid($command, WUNTRACED); last if $done <= 0; if (WIFSTOPPED(\${^CHILD_ERROR_NATIVE})) { if ($ARGV[0] > 0) { select(undef, undef, undef, 0.02) while stopped(); select(undef, undef, undef, $ARGV[0]) } print "stopping\\n"; kill "STOP", $$; print "resumed\\n" } else { last } }`;
const BEFORE_ANY_PROCESS = "Thu_Jan_1_00:00:00_1970";

function ending(t: TestContext, ...pids: number[]): void {
  t.after(() => {
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
}

function processOf(t: TestContext, mac: FakeMacos | null): number {
  const child = spawn("sleep", ["60"], { stdio: "ignore" });
  ending(t, child.pid!);
  if (mac) mac.add("process-uids", `${child.pid} ${UID}`);
  return child.pid!;
}

interface UnderSudo {
  readonly sudo: number;
  readonly command: number;
  readonly said: (line: string) => boolean;
}

async function commandUnderSudo(t: TestContext, mac: FakeMacos, stopsLateBySeconds = 0): Promise<UnderSudo> {
  const sudo = spawn("perl", ["-e", LIKE_SUDO, String(stopsLateBySeconds)], { stdio: ["ignore", "pipe", "ignore"] });
  const lines = createInterface({ input: sudo.stdout! });
  const [line] = (await once(lines, "line")) as [string];
  const said = new Set<string>();
  lines.on("line", (each) => said.add(each));
  const command = Number(line);
  ending(t, command, sudo.pid!);
  mac.add("process-uids", `${command} ${UID}`);
  return { sudo: sudo.pid!, command, said: (each) => said.has(each) };
}

function stateOf(pid: number): string {
  return spawnSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
}

const stopped = (pid: number) => stateOf(pid).startsWith("T");
const running = (pid: number) => stateOf(pid) !== "" && !stopped(pid);

async function eventually(check: () => boolean, what: string): Promise<void> {
  for (let tries = 0; tries < 100; tries++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(what);
}

function stopNow(pid: number): void {
  process.kill(pid, "SIGSTOP");
}

async function takeCaughtInItsClone(mac: FakeMacos, seconds: number): Promise<ChildProcess> {
  mac.flag("clone-waits", true, String(seconds));
  const taker = mac.start(["snapshot", "take", "0", "snaaaaaaaaaaaa"], BOX_A);
  await eventually(() => existsSync(join(mac.state, "cloning")), "the take reaches its clone");
  return taker;
}

const pauseRecord = (mac: FakeMacos) => mac.file(`${STORE}/.paused`);
const stillPaused = (mac: FakeMacos) => (pauseRecord(mac) ?? "").split("\n").filter((line) => /^(box|resumed) /.test(line));
const recordedParent = (mac: FakeMacos, pid: number) => (pauseRecord(mac) ?? "").split("\n").some((line) => line.startsWith(`parent ${pid} `));

describe("A Mac lent whole takes home snapshots of its box user (090)", () => {
  test("a take pauses the box user's processes, clones its home into the store only root can read, and resumes them", (t) => {
    const mac = lentMac();
    write(mac, "Users/bbx-0/work/notes.txt", "before\n");
    const work = processOf(t, mac);
    mac.flag("clone-records-states");

    const taken = ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(taken.get("snapshot"), "snaaaaaaaaaaaa");
    assert.match(taken.get("paused_ms") ?? "", /^\d+$/);
    assert.equal(mac.file(`${STORE}/snaaaaaaaaaaaa/home/work/notes.txt`), "before\n");
    assert.match(readFileSync(join(mac.state, "states-at-clone"), "utf8"), new RegExp(`^${work} T`, "m"));
    assert.ok(running(work), `the box user's process is ${stateOf(work)}`);
    assert.deepEqual(stillPaused(mac), [], "nothing is left paused");
    const info = fields(mac.file(`${STORE}/snaaaaaaaaaaaa/info`)!);
    assert.deepEqual([info.get("install"), info.get("box"), info.get("thread"), info.get("user")], ["inst_a", "box_a", "thr_a", "bbx-0"]);
  });

  test("a take resumes a process that stopped itself when the box user's processes stopped, as sudo does above a box command", async (t) => {
    const mac = lentMac();
    const { sudo, command } = await commandUnderSudo(t, mac);
    mac.flag("clone-records-states");

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.match(readFileSync(join(mac.state, "states-at-clone"), "utf8"), new RegExp(`^${command} T`, "m"));
    assert.ok(running(command), `the box command is ${stateOf(command)}`);
    assert.ok(running(sudo), `the process above it is ${stateOf(sudo)}`);
  });

  test("a take resumes a process above the box command that stops itself 0.5 s after the take resumed the command", async (t) => {
    const mac = lentMac();
    const { sudo, command, said } = await commandUnderSudo(t, mac, 0.5);

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    await eventually(() => said("stopping"), "the process above the box command stops itself");

    await eventually(() => said("resumed"), `the process above the box command runs again; it is ${stateOf(sudo)}`);
    assert.ok(running(command), `the box command is ${stateOf(command)}`);
    assert.deepEqual(stillPaused(mac), []);
  });

  test("a take keeps its record while a process above the box command may still stop, so the next command resumes one that stops 2 s after the take resumed the command", async (t) => {
    const mac = lentMac();
    const { sudo, command, said } = await commandUnderSudo(t, mac, 2);

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    assert.ok(recordedParent(mac, sudo), "the record keeps the process above the box command");
    await eventually(() => said("stopping") && stopped(sudo), "the process above the box command stops itself, later than the take's checks");
    assert.equal(mac.helper(["status"]).status, 0);

    await eventually(() => said("resumed"), `the process above the box command runs again; it is ${stateOf(sudo)}`);
    assert.ok(running(command), `the box command is ${stateOf(command)}`);
    assert.deepEqual(stillPaused(mac), []);
  });

  test("a take's record goes once its processes have had a minute to stop, with nothing in it stopped", (t) => {
    const mac = lentMac();
    mac.clock(1_790_000_000);
    processOf(t, mac);
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(mac.helper(["status"]).status, 0);
    const withinTheMinute = pauseRecord(mac);
    mac.clock(1_790_000_060);
    assert.equal(mac.helper(["status"]).status, 0);

    assert.notEqual(withinTheMinute, null, "the record stays within the minute");
    assert.equal(pauseRecord(mac), null);
  });

  test("a second take keeps the first take's record of a process above the box command, so the next command resumes it when it stops after its command ended", async (t) => {
    const mac = lentMac();
    const { sudo, command, said } = await commandUnderSudo(t, mac, 4);
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    assert.ok(recordedParent(mac, sudo), "the first take records the process above the box command");
    process.kill(command, "SIGKILL");

    ok(mac, ["take", "0", "snbbbbbbbbbbbb"]);
    await eventually(() => said("stopping") && stopped(sudo), "the process above the box command stops itself after the second take");
    assert.equal(mac.helper(["status"]).status, 0);

    await eventually(() => said("resumed"), `the process above the box command runs again; it is ${stateOf(sudo)}`);
  });

  test("a recovery cut short after it writes its record, before it resumes, keeps every stopped process in the record, even after the minute", async (t) => {
    const mac = lentMac();
    mac.clock(1_790_000_000);
    const work = processOf(t, mac);
    stopNow(work);
    mkdirSync(join(mac.root, STORE), { recursive: true });
    writeFileSync(join(mac.root, STORE, ".paused"), `settle 1789999000\nbox ${work} ${startOf(work)}\n`);
    mac.flag("die-after-moving", true, "*/.paused");

    const cut = mac.start(["status"], "");
    await once(cut, "exit");
    assert.ok(stopped(work), "the cut short recovery sent nothing");
    assert.match(pauseRecord(mac) ?? "", new RegExp(`^resumed ${work} `, "m"));
    assert.equal(mac.helper(["status"]).status, 0);

    assert.ok(running(work), `the process the take paused is ${stateOf(work)}`);
    assert.equal(pauseRecord(mac), null);
  });

  test("a take leaves stopped a process that another user stopped during it", (t) => {
    const mac = lentMac();
    const stranger = processOf(t, null);
    mac.flag("stop-during-clone", true, String(stranger));

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.ok(stopped(stranger), `the other user's process is ${stateOf(stranger)}`);
  });

  test("a take leaves stopped a box process that was stopped before it, and resumes the others", (t) => {
    const mac = lentMac();
    const held = processOf(t, mac);
    const work = processOf(t, mac);
    stopNow(held);

    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.ok(stopped(held), `the process stopped before the take is ${stateOf(held)}`);
    assert.ok(running(work), `the box user's other process is ${stateOf(work)}`);
  });

  test("a take asked again answers as the first, and pauses nothing", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    const listings = () => mac.calls().filter((call) => call.startsWith("ps -A")).length;
    const before = listings();

    const again = ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(again.get("snapshot"), "snaaaaaaaaaaaa");
    assert.equal(listings(), before);
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

  for (const [command, input] of [
    [["status"], ""],
    [["snapshot", "list"], "install=inst_a\n"],
    [["snapshot", "delete", "snzzzzzzzzzzzz"], "install=inst_a\n"],
  ] as const) {
    test(`a take killed during its pause has ${command.join(" ")} resume exactly what it stopped, with the sudo above it, and nothing stopped by others`, async (t) => {
      const mac = lentMac();
      const { sudo, command: boxCommand } = await commandUnderSudo(t, mac);
      const held = processOf(t, mac);
      stopNow(held);
      const stranger = processOf(t, null);
      mac.flag("stop-during-clone", true, String(stranger));
      const taker = await takeCaughtInItsClone(mac, 30);
      await eventually(() => stopped(boxCommand) && stopped(sudo), "the pause stops the box command, and the sudo above it stops itself");

      process.kill(-taker.pid!, "SIGKILL");
      await once(taker, "exit");
      assert.notEqual(pauseRecord(mac), null, "the killed take leaves its pause recorded");
      const next = mac.helper([...command], input);

      assert.notEqual(next.status, null, next.stderr);
      assert.ok(running(boxCommand), `the box command is ${stateOf(boxCommand)}`);
      assert.ok(running(sudo), `the sudo above it is ${stateOf(sudo)}`);
      assert.ok(stopped(held), `the box process stopped before the take is ${stateOf(held)}`);
      assert.ok(stopped(stranger), `the other user's process is ${stateOf(stranger)}`);
      assert.deepEqual(stillPaused(mac), []);
    });
  }

  test("a take ended by TERM during its pause resumes what it stopped before it exits", async (t) => {
    const mac = lentMac();
    const { sudo, command } = await commandUnderSudo(t, mac);
    const taker = await takeCaughtInItsClone(mac, 30);
    await eventually(() => stopped(command) && stopped(sudo), "the pause stops the box command and the sudo above it");

    process.kill(-taker.pid!, "SIGTERM");
    await once(taker, "exit");

    assert.ok(running(command), `the box command is ${stateOf(command)}`);
    assert.ok(running(sudo), `the sudo above it is ${stateOf(sudo)}`);
    assert.deepEqual(stillPaused(mac), []);
  });

  test("another command during a take's pause leaves that pause to the take", async (t) => {
    const mac = lentMac();
    const work = processOf(t, mac);
    const taker = await takeCaughtInItsClone(mac, 2);

    mac.helper(["status"]);

    assert.ok(stopped(work), `the box process is ${stateOf(work)} while the take clones`);
    assert.notEqual(pauseRecord(mac), null);
    await once(taker, "exit");
    assert.ok(running(work), `the box process is ${stateOf(work)} after the take`);
  });

  test("a recorded pause resumes no process that now has the recorded PID but started at another time", (t) => {
    const mac = lentMac();
    const reused = processOf(t, mac);
    stopNow(reused);
    mkdirSync(join(mac.root, STORE), { recursive: true });
    writeFileSync(join(mac.root, STORE, ".paused"), `box ${reused} ${BEFORE_ANY_PROCESS}\n`);

    assert.equal(mac.helper(["status"]).status, 0);

    assert.ok(stopped(reused), `the process is ${stateOf(reused)}`);
    assert.equal(pauseRecord(mac), null);
  });

  test("a take that fails to clone resumes the box user and keeps no part of the snapshot", (t) => {
    const mac = lentMac();
    const work = processOf(t, mac);
    mac.flag("no-clone");

    const failed = run(mac, ["take", "0", "snaaaaaaaaaaaa"]);

    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Could not clone bbx-0's home/);
    assert.ok(running(work), `the box user's process is ${stateOf(work)}`);
    assert.deepEqual(stillPaused(mac), []);
    assert.deepEqual(readdirSync(join(mac.root, STORE)).filter((name) => name !== ".paused"), []);
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

    const fork = ok(mac, ["fork", "snaaaaaaaaaaaa", "bbx-500", "70500"], "install=inst_a\n");

    assert.equal(fork.get("left"), "");
    assert.equal(fork.get("from"), "snaaaaaaaaaaaa");
    assert.equal(fork.get("signin"), "userspace");
    assert.equal(mac.file("Users/bbx-500/work/notes.txt"), "before\n");
    assert.equal(mac.file("Users/bbx-500/.ssh/id_ed25519"), "the user's own key\n");
    for (const gone of [".bb-machines/bb/host-id", ".config/bb-box/env", "Library/LaunchAgents/app.getbb.daemon.plist", "Library/Keychains/login.keychain-db", "Library/Keychains/0A1B2C3D-0000-4000-8000-000000000001", "Library/Preferences/com.apple.photolibraryd.plist"]) {
      assert.equal(existsSync(join(mac.root, "Users/bbx-500", gone)), false, gone);
    }
    assert.ok(mac.lines("owners").includes(`70500 ${mac.data}/Users/bbx-500/work/notes.txt`));
    assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "before\n");
  });

  test("are refused with the reason where another user shares the Mac", () => {
    const mac = lentMac();
    ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
    mkdirSync(join(mac.state, "users", "bbx-7"), { recursive: true });
    writeFileSync(join(mac.state, "users", "bbx-7", "UniqueID"), "70007\n");

    const refused = run(mac, ["fork", "snaaaaaaaaaaaa", "bbx-500", "70500"], "install=inst_a\n");

    assert.equal(refused.status, 5);
    assert.match(refused.stderr, /The Mac is shared \(box user bbx-7\), so it makes no fork/);
    assert.equal(mac.user("bbx-500"), null);
  });

  for (const [target, uid, reason, arrange] of [
    ["person", "70500", /person with UID 70500 is not/, () => {}],
    ["person", "501", /person with UID 501 is not/, () => {}],
    ["bbx-5", "70500", /bbx-5 with UID 70500 is not/, () => {}],
    ["bbx-0", "70000", /User bbx-0 is on the Mac already/, () => {}],
    ["bbx-501", "70501", /UID 70501 belongs to someone already/, (mac: FakeMacos) => {
      mkdirSync(join(mac.state, "users", "someone"), { recursive: true });
      writeFileSync(join(mac.state, "users", "someone", "UniqueID"), "70501\n");
    }],
    ["bbx-502", "70502", /bbx-502 is at the Mac's console/, (mac: FakeMacos) => mac.setConsole("bbx-502")],
  ] as const) {
    test(`are refused before any change when aimed at ${target} with UID ${uid}`, () => {
      const mac = lentMac();
      write(mac, "Users/bbx-0/work/notes.txt", "before\n");
      ok(mac, ["take", "0", "snaaaaaaaaaaaa"]);
      mkdirSync(join(mac.root, "Users/person"), { recursive: true });
      writeFileSync(join(mac.root, "Users/person/keep.txt"), "the person's own\n");
      mac.own("Users/person/keep.txt", 501);
      arrange(mac);
      const users = mac.users();
      const calls = mac.calls().length;

      const refused = run(mac, ["fork", "snaaaaaaaaaaaa", target, uid], "install=inst_a\n");

      assert.equal(refused.status, 5, refused.stderr);
      assert.match(refused.stderr, reason);
      assert.match(refused.stderr, /changed nothing/);
      assert.deepEqual(mac.users(), users);
      assert.equal(mac.user("person")?.UniqueID, "501");
      assert.equal(mac.user("bbx-0")?.UniqueID, String(UID));
      assert.equal(mac.file("Users/person/keep.txt"), "the person's own\n");
      assert.equal(mac.file("Users/bbx-0/work/notes.txt"), "before\n");
      assert.deepEqual(mac.calls().slice(calls).filter((call) => /^(sysadminctl|dseditgroup|createhomedir|chown) /.test(call) || /^dscl \. -(create|delete)/.test(call)), []);
    });
  }
});

const ACCOUNT_CHANGE = (call: string) => /^(sysadminctl|dseditgroup|createhomedir|chown) /.test(call) || /^dscl \. -(create|delete)/.test(call);
const STORE_OF_THE_TAKE = 'u=${2%/snproof000001.partial/home}; u=${u##*/}';
const REPLACES_THE_PROBE_ACCOUNT = `case $2 in */snproof000001.partial/home) ${STORE_OF_THE_TAKE}; echo 00000000-0000-4000-8000-0000000000BB >"$F/users/$u/GeneratedUID" ;; *) exit 1 ;; esac`;
const STORE_OF_THE_FORK = 'u=${2%/.fork-*}; u=${u##*/}';
const REPLACES_THE_PROBE_HOME = `case $2 in */.fork-*) ${STORE_OF_THE_FORK}; mv "$R/Users/$u" "$R/Users/$u.moved" && mkdir "$R/Users/$u" && echo keep >"$R/Users/$u/keep.txt" ;; *) exit 1 ;; esac`;
const GIVES_THE_PROBE_UID_TO_ANOTHER = `case $2 in */.fork-*) ${STORE_OF_THE_FORK}; id=$(cat "$F/users/$u/UniqueID"); rm -rf "$F/users/$u"; mkdir -p "$F/users/replacement" "$R/Users/replacement"; echo "$id" >"$F/users/replacement/UniqueID"; echo 00000000-0000-4000-8000-0000000000CC >"$F/users/replacement/GeneratedUID"; echo /Users/replacement >"$F/users/replacement/NFSHomeDirectory"; echo keep >"$R/Users/replacement/keep.txt"; echo "$id $(readlink -f "$R/Users/replacement/keep.txt")" >>"$F/owners" ;; *) exit 1 ;; esac`;
const PLANTS_A_SUDO_RULE_STAGING_FILE = `case $2 in */snproof000001.partial/home) ${STORE_OF_THE_TAKE}; echo keep >"$R/etc/sudoers.d/$u.new" && echo "$u" >"$F/planted" ;; *) exit 1 ;; esac`;
const HOLD_LOCK = `use Fcntl ":flock"; open(my $f, ">>", $ARGV[0]) or exit 1; flock($f, LOCK_EX) or exit 1; $| = 1; print "held\\n"; <STDIN>;`;
const RECORD = "var/db/bb-box/proof-made";

function freeMac(settings: Readonly<Record<string, string>> = {}): FakeMacos {
  const mac = fakeMacos({ settings });
  assert.equal(mac.helper(["init"]).status, 0);
  return mac;
}

function keep(mac: FakeMacos, path: string, uid: number): string {
  mkdirSync(join(mac.root, path, ".."), { recursive: true });
  writeFileSync(join(mac.root, path), "keep\n");
  if (uid) mac.own(path, uid);
  return path;
}

function assertChangedNothing(mac: FakeMacos, calls: number, users: readonly string[]): void {
  assert.deepEqual(mac.users(), users);
  assert.deepEqual(mac.calls().slice(calls).filter(ACCOUNT_CHANGE), []);
  assert.equal(existsSync(join(mac.root, RECORD)), false);
}

async function holdingALock(path: string): Promise<ChildProcess> {
  mkdirSync(join(path, ".."), { recursive: true });
  const holder = spawn("perl", ["-e", HOLD_LOCK, path], { stdio: ["pipe", "pipe", "ignore"] });
  await once(createInterface({ input: holder.stdout! }), "line");
  return holder;
}

function startOf(pid: number): string {
  return spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim().split(/\s+/).join("_");
}

interface ScratchUsers {
  readonly user: string;
  readonly uid: string;
  readonly fork: string;
  readonly forkUid: string;
}

function scratchUsers(stdout: string): ScratchUsers {
  const found = stdout.match(/^note: scratch users (\S+) \(UID (\d+)\) and (\S+) \(UID (\d+)\)/m);
  assert.ok(found, stdout);
  return { user: found[1]!, uid: found[2]!, fork: found[3]!, forkUid: found[4]! };
}

function dataVolumeScans(mac: FakeMacos, from: number): string[] {
  return mac.calls().slice(from).filter((call) => call.startsWith(`find ${mac.data} `) && call.includes("-uid"));
}

describe("The proof of home snapshots (090)", () => {
  test("runs on a free Mac on fresh scratch users, passes, and leaves nothing of them", () => {
    const mac = freeMac();
    mac.flag("sudo-processes");
    mkdirSync(join(mac.root, "var/db/bb-box/host/slots/1"), { recursive: true });
    writeFileSync(join(mac.root, "var/db/bb-box/host/slots/1/state"), "is=ready\n");

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /^result: passed/m);
    assert.doesNotMatch(proof.stdout, /^FAILED/m);
    const { user, uid, fork, forkUid } = scratchUsers(proof.stdout);
    assert.match(user, /^bbbox-probe-[0-9a-f]{8}$/);
    assert.match(fork, /^bbbox-probe-[0-9a-f]{8}$/);
    assert.notEqual(user, fork);
    for (const id of [uid, forkUid]) assert.ok(Number(id) >= 90000 && Number(id) < 100000, `UID ${id} is outside every box's and slot's`);
    assert.match(proof.stdout, /^ok: a fork is refused while another user shares the Mac: The Mac is shared \(box user bbx-0\)/m);
    for (const check of [
      "the root sudo above the user's process runs again after the take",
      "the user's process that someone else stopped before the take stays stopped",
      "a root process that someone else stopped during the take stays stopped",
      "the next helper command resumes the killed take's pause",
      "the user's process that someone else stopped stays stopped after the recovery",
      "a root process that someone else stopped during the killed take's pause stays stopped",
      `a fork aimed at a user on the Mac already, ${fork}, is refused`,
      `the refused fork left ${fork} with UID ${forkUid}`,
      "the take left nothing paused in its record",
      "a process above the user's that stops itself 3 s after the pause, after the take's last check, stops",
      "the take keeps its record while a process above the user's may still stop",
      "the next helper command resumes the process that stopped late",
      `removed ${user} and what the proof made for it`,
      `removed ${fork} and what the proof made for it`,
    ]) {
      assert.ok(proof.stdout.split("\n").includes(`ok: ${check}`), check);
    }
    assert.match(proof.stdout, new RegExp(`^note: made ${user}, UID ${uid}, GeneratedUID [0-9A-F-]{36}$`, "m"));
    assert.deepEqual(mac.users(), ["bbx-0", "person"]);
    assert.equal(existsSync(join(mac.root, "var/db/bb-box/home-snapshots")), false);
    assert.equal(existsSync(join(mac.root, RECORD)), false);
    assert.deepEqual(readdirSync(join(mac.root, "var/db/bb-box")).filter((name) => name.startsWith("proof")), []);
  });

  test("picks new scratch users each run, so it never decides whether an earlier account is its own", () => {
    const mac = freeMac();
    mac.flag("sudo-processes");

    const first = mac.helper(["snapshot", "proof"]);
    const second = mac.helper(["snapshot", "proof"]);

    assert.equal(first.status, 0, first.stdout + first.stderr);
    assert.equal(second.status, 0, second.stdout + second.stderr);
    assert.notEqual(scratchUsers(first.stdout).user, scratchUsers(second.stdout).user);
    assert.notEqual(scratchUsers(first.stdout).uid, scratchUsers(second.stdout).uid);
  });

  test("makes no scan of the Data volume, so a file of an unused UID neither stops it nor goes", () => {
    const mac = freeMac();
    mac.flag("sudo-processes");
    const kept = [90000, 95000, 99999].map((uid) => keep(mac, `Users/Shared/before-proof-${uid}`, uid));
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.deepEqual(dataVolumeScans(mac, calls), []);
    for (const path of kept) assert.equal(mac.file(path), "keep\n", path);
  });

  test("refuses, changing nothing, when it cannot list the Mac's users", () => {
    const mac = freeMac();
    mac.flag("directory-down");
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 5, proof.stdout + proof.stderr);
    assert.match(proof.stderr, /could not list the Mac's users, so it does not run\. It changed nothing/);
    mac.flag("directory-down", false);
    assertChangedNothing(mac, calls, ["bbx-0", "person"]);
  });

  test("refuses while a box holds the Mac, and changes nothing", () => {
    const mac = lentMac();
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 3);
    assert.match(proof.stderr, /runs only while the Mac is free, and a box holds the Mac/);
    assertChangedNothing(mac, calls, ["bbx-0", "person"]);
  });

  test("checks that the Mac is free only once it holds the helper's lock, so a claim that holds the lock first wins", async () => {
    const mac = freeMac();
    const claim = await holdingALock(join(mac.root, "var/db/bb-box/lock"));
    const proof = mac.start(["snapshot", "proof"]);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    writeFileSync(join(mac.root, "var/db/bb-box/owner"), "install=inst_a\nbox=box_a\ngeneration=0\nuser=bbx-0\nuid=70000\n");
    const calls = mac.calls().length;

    claim.stdin!.end();
    const [status] = (await once(proof, "exit")) as [number];

    assert.equal(status, 3);
    assertChangedNothing(mac, calls, ["bbx-0", "person"]);
  });

  test("refuses, changing nothing, while another command holds the iOS slots' lock past its wait", async () => {
    const mac = freeMac({ DEVICE_HOST_WAIT_SECONDS: "1" });
    const slotCommand = await holdingALock(join(mac.root, "var/db/bb-box/host/lock"));
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);
    slotCommand.stdin!.end();

    assert.equal(proof.status, 3, proof.stdout + proof.stderr);
    assert.match(proof.stderr, /runs only while the Mac's iOS slots are still/);
    assertChangedNothing(mac, calls, ["bbx-0", "person"]);
  });

  for (const [what, path, text] of [
    ["held by a box", "var/db/bb-box/host/slots/2/state", "is=held\nbox=box_x\nkind=ios\n"],
    ["being given back", "var/db/bb-box/host/slots/2/state", "is=releasing\nbox=box_x\n"],
    ["being made", "var/db/bb-box/host/slots/3/state", "is=making\nstep=device\nfor=\n"],
    ["being removed", "var/db/bb-box/host/slots/3/state", "is=resetting\nstep=sweep\n"],
    ["promised to a box", "var/db/bb-box/host/promises/box_y", "since=1790000000\n"],
  ] as const) {
    test(`refuses while an iOS slot is ${what}, and changes nothing`, () => {
      const mac = freeMac();
      mkdirSync(join(mac.root, path, ".."), { recursive: true });
      writeFileSync(join(mac.root, path), text);
      const calls = mac.calls().length;

      const proof = mac.helper(["snapshot", "proof"]);

      assert.equal(proof.status, 3, proof.stdout + proof.stderr);
      assert.match(proof.stderr, new RegExp(`an iOS slot is ${what}`));
      assertChangedNothing(mac, calls, ["bbx-0", "person"]);
    });
  }

  test("refuses while a take's pause record is left, and leaves what it paused to the helper's recovery", (t) => {
    const mac = freeMac();
    const work = processOf(t, mac);
    stopNow(work);
    const record = `box ${work} ${startOf(work)}\n`;
    mkdirSync(join(mac.root, STORE), { recursive: true });
    writeFileSync(join(mac.root, STORE, ".paused"), record);
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 3, proof.stdout + proof.stderr);
    assert.match(proof.stderr, /pause record is left/);
    assert.ok(stopped(work), `the paused process is ${stateOf(work)}`);
    assert.equal(pauseRecord(mac), record);
    assertChangedNothing(mac, calls, ["bbx-0", "person"]);
  });

  test("killed after its first take, leaves a record by which the next run ends its processes and removes its user, then passes", async () => {
    const mac = freeMac();
    mac.flag("sudo-processes");
    const killed = mac.start(["snapshot", "proof"]);
    const stores = join(mac.root, "var/db/bb-box/home-snapshots");
    const taken = () => existsSync(stores) && readdirSync(stores).some((user) => existsSync(join(stores, user, "snproof000001/home")));
    await eventually(taken, "the proof takes its first snapshot");
    process.kill(killed.pid!, "SIGKILL");
    await once(killed, "exit");
    const left = mac.file(RECORD) ?? "";
    const made = [...left.matchAll(/^user (\S+) \d+ [0-9A-F-]{36}$/gm)].map((line) => line[1]!);
    const processes = [...left.matchAll(/^process (\d+) /gm)].map((line) => Number(line[1]));
    assert.equal(made.length, 1, left);
    assert.ok(processes.some((pid) => !/^Z?$/.test(stateOf(pid))), `the killed proof left a recorded process: ${left}`);

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /^note: removed what the earlier proof made$/m);
    for (const pid of processes) assert.match(stateOf(pid), /^Z?$/, `recorded process ${pid} is ${stateOf(pid)}`);
    assert.equal(mac.user(made[0]!), null);
    assert.equal(mac.file(`Users/${made[0]}/proof/file.txt`), null);
    assert.deepEqual(mac.users(), ["bbx-0", "person"]);
    assert.equal(existsSync(join(mac.root, RECORD)), false);
  });

  test("refuses, changing nothing, where an earlier proof's record names an account that is not the one it made", () => {
    const mac = freeMac();
    mac.tool("dscl", [".", "-create", "/Users/bbbox-probe-0000abcd", "UniqueID", "90001"]);
    mac.tool("dscl", [".", "-create", "/Users/bbbox-probe-0000abcd", "GeneratedUID", "00000000-0000-4000-8000-0000000000BB"]);
    const home = keep(mac, "Users/bbbox-probe-0000abcd/keep.txt", 90001);
    const record = "user bbbox-probe-0000abcd 90001 00000000-0000-4000-8000-0000000000AA\n";
    writeFileSync(join(mac.root, RECORD), record);
    const users = mac.users();
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 5, proof.stdout + proof.stderr);
    assert.match(proof.stdout, /^note: the proof left user bbbox-probe-0000abcd, as it is not the account the proof made/m);
    assert.match(proof.stderr, /an earlier proof left what it cannot prove it made/);
    assert.deepEqual(mac.users(), users);
    assert.equal(mac.user("bbbox-probe-0000abcd")?.GeneratedUID, "00000000-0000-4000-8000-0000000000BB");
    assert.equal(mac.file(home), "keep\n");
    assert.equal(mac.file(RECORD), record);
    assert.deepEqual(mac.calls().slice(calls).filter(ACCOUNT_CHANGE), []);
  });

  test("refuses, changing nothing, an earlier proof's record in a form it does not read", () => {
    const mac = freeMac();
    const record = "user bbbox-probe 79999 00000000-0000-4000-8000-0000000000AA 1234\nstore bbbox-probe 5678\n";
    writeFileSync(join(mac.root, RECORD), record);
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 5, proof.stdout + proof.stderr);
    assert.match(proof.stderr, /in a form this proof does not read/);
    assert.equal(mac.file(RECORD), record);
    assert.deepEqual(mac.calls().slice(calls).filter(ACCOUNT_CHANGE), []);
  });

  for (const [what, during, left] of [
    ["an account that another made again under the scratch user's name", REPLACES_THE_PROBE_ACCOUNT, (user: string) => `Users/${user}/proof/file.txt`],
    ["a home that another put in place of the scratch user's", REPLACES_THE_PROBE_HOME, (user: string) => `Users/${user}/keep.txt`],
  ] as const) {
    test(`deletes only what it made, and leaves ${what}`, () => {
      const mac = freeMac();
      mac.flag("sudo-processes");
      mac.flag("during-clone", true, during);

      const proof = mac.helper(["snapshot", "proof"]);

      assert.equal(proof.status, 1, proof.stdout + proof.stderr);
      const { user, uid, fork } = scratchUsers(proof.stdout);
      assert.match(proof.stdout, /^result: FAILED/m);
      assert.match(proof.stdout, new RegExp(`^note: the proof left .*${user}`, "m"));
      assert.equal(mac.user(user)?.UniqueID, uid);
      assert.notEqual(mac.file(left(user)), null, `${left(user)} is left`);
      assert.match(mac.file(RECORD) ?? "", new RegExp(`^user ${user} ${uid} `, "m"));
      assert.equal(mac.user(fork), null);
    });
  }

  test("leaves the files of another account that takes a scratch user's UID after the scratch user goes", () => {
    const mac = freeMac();
    mac.flag("sudo-processes");
    mac.flag("during-clone", true, GIVES_THE_PROBE_UID_TO_ANOTHER);
    const calls = mac.calls().length;

    const proof = mac.helper(["snapshot", "proof"]);

    assert.match(mac.user("replacement")?.UniqueID ?? "", /^\d+$/, proof.stdout);
    assert.equal(mac.file("Users/replacement/keep.txt"), "keep\n");
    assert.deepEqual(dataVolumeScans(mac, calls), []);
  });

  test("leaves a file it did not make in a scratch user's sudo rule staging path", () => {
    const mac = freeMac();
    mac.flag("sudo-processes");
    mac.flag("during-clone", true, PLANTS_A_SUDO_RULE_STAGING_FILE);

    const proof = mac.helper(["snapshot", "proof"]);

    assert.equal(proof.status, 0, proof.stdout + proof.stderr);
    const planted = readFileSync(join(mac.state, "planted"), "utf8").trim();
    assert.equal(mac.file(`etc/sudoers.d/${planted}.new`), "keep\n");
  });
});
