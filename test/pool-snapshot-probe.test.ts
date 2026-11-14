import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseSnapshotReport, type PoolSnapshotReport } from "../src/backends/ssh-pool/snapshot-report.ts";
import { fakeMacos, type FakeMacos, type Run } from "./fake-macos.ts";
import { tempDir } from "./helpers.ts";

const LINUX_HELPER = fileURLToPath(new URL("../setup/ssh-pool/machine.sh", import.meta.url));
const HOOK_SECONDS = 2;
const HOOK_DEADLINE_WORDS = `its snapshot hook's describe failed: it did not finish within ${HOOK_SECONDS} seconds, so the helper stopped it and everything it started`;
const BOUNDED_PROBE_MS = 15_000;
const STUCK_PROBE_MS = 45_000;
const VALID_DESCRIBE = '{"contract":1,"scope":"machine"}';
const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";
const LINUX_TRIALS = ".bb-box-snapshot-trials";

const ROOT_ID = `#!/bin/sh
if [ "$*" = -u ]; then echo 0; else exec /usr/bin/id "$@"; fi
`;

const BTRFS_WITH_FAULTS = `#!/bin/sh
real=$(PATH=${SYSTEM_PATH} command -v btrfs)
fault() { [ -e "$BTRFS_FAULTS/$1" ]; }
case "$1 $2" in
  "subvolume delete")
    case $3 in */snapshot) if fault snapshot-stays; then echo "ERROR: Could not destroy subvolume $3: Operation not permitted" >&2; exit 1; fi ;; esac
    ;;
  "subvolume snapshot")
    if fault snapshot-fails; then echo "ERROR: cannot snapshot: No space left on device" >&2; exit 1; fi
    if fault slow-snapshot; then
      rm -f "$BTRFS_FAULTS/slow-snapshot"
      "$real" "$@" >/dev/null || exit 1
      : >"$BTRFS_FAULTS/snapshotting"
      exec sleep 30
    fi
    ;;
esac
exec "$real" "$@"
`;

function hookIgnoringTerm(pids: string): string {
  return `#!/bin/sh
echo $$ >>${pids}
trap "" TERM
sleep 60 &
echo $! >>${pids}
wait
printf '{}\\n'
`;
}

function hookLeavingAChild(pids: string): string {
  return `#!/bin/sh
echo $$ >>${pids}
(trap "" TERM; exec sleep 60) &
echo $! >>${pids}
printf '%s\\n' '${VALID_DESCRIBE}'
`;
}

function alive(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return false;
  }
}

function pidsIn(file: string): number[] {
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map(Number);
}

function reportOf(probe: Run): PoolSnapshotReport {
  assert.equal(probe.status, 0, probe.stderr);
  const report = parseSnapshotReport(probe.stdout, "build-1");
  assert.ok(report, probe.stdout);
  return report;
}

function timed(probe: () => Run): Run & { readonly ms: number } {
  const started = performance.now();
  const result = probe();
  return { ...result, ms: performance.now() - started };
}

async function until(done: () => boolean, what: string): Promise<void> {
  const started = performance.now();
  while (!done()) {
    assert.ok(performance.now() - started < 20_000, `waited for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function exited(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once("exit", () => resolve())));
}

function entries(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

interface LinuxMachine {
  readonly homes: string;
  readonly state: string;
  readonly hook: string;
  readonly faults: string;
  probe(): Run;
  start(): ChildProcess;
}

function linuxMachine(homes: string = tempDir("homes")): LinuxMachine {
  const dir = tempDir("linux-machine");
  const [state, bin, faults, hook, script] = ["state", "bin", "faults", "snapshot-machine", "machine.sh"].map((name) => join(dir, name)) as [string, string, string, string, string];
  mkdirSync(bin);
  mkdirSync(faults);
  writeFileSync(join(bin, "id"), ROOT_ID, { mode: 0o755 });
  writeFileSync(join(bin, "btrfs"), BTRFS_WITH_FAULTS, { mode: 0o755 });

  let text = readFileSync(LINUX_HELPER, "utf8");
  for (const [name, value] of Object.entries({ PATH: `${bin}:${SYSTEM_PATH}`, STATE: state, HOMES: homes, SNAPSHOT_HOOK: hook, SNAPSHOT_HOOK_SECONDS: String(HOOK_SECONDS) })) {
    const line = new RegExp(`^${name}=.*$`, "m");
    assert.match(text, line);
    text = text.replace(line, `${name}=${value}`);
  }
  writeFileSync(script, text, { mode: 0o755 });

  const env = { PATH: SYSTEM_PATH, BTRFS_FAULTS: faults };
  return {
    homes,
    state,
    hook,
    faults,
    probe() {
      const result = spawnSync("/bin/sh", [script, "snapshot", "probe"], { env, encoding: "utf8", timeout: STUCK_PROBE_MS });
      return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    },
    start: () => spawn("/bin/sh", [script, "snapshot", "probe"], { env, stdio: "ignore", detached: true }),
  };
}

function macWithShortHookDeadline(): FakeMacos {
  const mac = fakeMacos({ settings: { SNAPSHOT_HOOK_SECONDS: String(HOOK_SECONDS) } });
  const init = mac.helper(["init"]);
  assert.equal(init.status, 0, init.stderr);
  mkdirSync(join(mac.root, "usr/local/libexec/bb-box"), { recursive: true });
  return mac;
}

const macHook = (mac: FakeMacos) => join(mac.root, "usr/local/libexec/bb-box/snapshot-machine");
const macState = (mac: FakeMacos) => realpathSync(join(mac.root, "var/db/bb-box"));

function cleanMacProbe(mac: FakeMacos): string[] {
  assert.deepEqual(reportOf(mac.helper(["snapshot", "probe"])).home, { is: "yes", what: { way: "apfs", dataset: null } });
  return tree(macState(mac));
}

describe("The Linux helper's snapshot hook keeps to its deadline (090)", () => {
  it("stops a hook that ignores TERM, with everything it started, and reports it as failed", () => {
    const machine = linuxMachine();
    const pids = join(machine.state, "..", "hook-pids");
    writeFileSync(machine.hook, hookIgnoringTerm(pids), { mode: 0o755 });

    const probe = timed(() => machine.probe());

    assert.ok(probe.ms < BOUNDED_PROBE_MS, `the probe took ${Math.round(probe.ms)} ms`);
    assert.deepEqual(reportOf(probe).hook, { is: "no", why: HOOK_DEADLINE_WORDS });
    assert.deepEqual(pidsIn(pids).filter(alive), []);
  });

  it("stops a child the hook leaves behind with its output, and reports the hook as failed", () => {
    const machine = linuxMachine();
    const pids = join(machine.state, "..", "hook-pids");
    writeFileSync(machine.hook, hookLeavingAChild(pids), { mode: 0o755 });

    const probe = timed(() => machine.probe());

    assert.ok(probe.ms < BOUNDED_PROBE_MS, `the probe took ${Math.round(probe.ms)} ms`);
    assert.deepEqual(reportOf(probe).hook, { is: "no", why: HOOK_DEADLINE_WORDS });
    assert.deepEqual(pidsIn(pids).filter(alive), []);
  });

  it("reads a hook that finishes in time, and leaves only its report and the hook's errors", () => {
    const machine = linuxMachine();
    writeFileSync(machine.hook, `#!/bin/sh\nprintf '%s\\n' '${VALID_DESCRIBE}'\n`, { mode: 0o755 });

    const report = reportOf(machine.probe());

    assert.deepEqual(report.hook, { is: "yes", what: { whileRunning: null, restarts: null, storage: null } });
    assert.deepEqual(entries(machine.state), ["snapshot-hook.err", "snapshots"]);
  });
});

describe("The Mac helper's snapshot hook keeps to its deadline (090)", () => {
  it("stops a hook that ignores TERM, with everything it started, and reports it as failed", () => {
    const mac = macWithShortHookDeadline();
    const pids = join(mac.state, "hook-pids");
    writeFileSync(macHook(mac), hookIgnoringTerm(pids), { mode: 0o755 });

    const probe = timed(() => mac.helper(["snapshot", "probe"]));

    assert.ok(probe.ms < BOUNDED_PROBE_MS, `the probe took ${Math.round(probe.ms)} ms`);
    assert.deepEqual(reportOf(probe).hook, { is: "no", why: HOOK_DEADLINE_WORDS });
    assert.deepEqual(pidsIn(pids).filter(alive), []);
  });

  it("stops a child the hook leaves behind with its output, and reports the hook as failed", () => {
    const mac = macWithShortHookDeadline();
    const pids = join(mac.state, "hook-pids");
    writeFileSync(macHook(mac), hookLeavingAChild(pids), { mode: 0o755 });

    const probe = timed(() => mac.helper(["snapshot", "probe"]));

    assert.ok(probe.ms < BOUNDED_PROBE_MS, `the probe took ${Math.round(probe.ms)} ms`);
    assert.deepEqual(reportOf(probe).hook, { is: "no", why: HOOK_DEADLINE_WORDS });
    assert.deepEqual(pidsIn(pids).filter(alive), []);
  });
});

describe("The Mac helper's clone trial leaves nothing behind (090)", () => {
  it("removes its trial when the probe is stopped mid-clone", async () => {
    const mac = macWithShortHookDeadline();
    const clean = cleanMacProbe(mac);
    mac.flag("slow-clonefile");

    const probe = mac.start(["snapshot", "probe"]);
    await until(() => existsSync(join(mac.state, "cloning")), "the trial clone");
    process.kill(-probe.pid!, "SIGTERM");
    await exited(probe);

    assert.deepEqual(tree(macState(mac)), clean);
  });

  it("removes the trial of a probe that was killed outright, at the next probe", async () => {
    const mac = macWithShortHookDeadline();
    const clean = cleanMacProbe(mac);
    mac.flag("slow-clonefile");
    const probe = mac.start(["snapshot", "probe"]);
    await until(() => existsSync(join(mac.state, "cloning")), "the trial clone");
    process.kill(-probe.pid!, "SIGKILL");
    await exited(probe);
    assert.notDeepEqual(tree(macState(mac)), clean);
    mac.flag("slow-clonefile", false);

    const report = reportOf(mac.helper(["snapshot", "probe"]));

    assert.deepEqual(report.home, { is: "yes", what: { way: "apfs", dataset: null } });
    assert.deepEqual(tree(macState(mac)), clean);
  });
});

const ROOT_FILESYSTEMS = process.getuid?.() === 0 && process.env.BB_BOX_TEST_FILESYSTEMS === "1";
const ROOT_FILESYSTEMS_SKIP = ROOT_FILESYSTEMS ? false : "needs root, btrfs-progs and BB_BOX_TEST_FILESYSTEMS=1, as it mounts real filesystems";

function sh(command: string): string {
  const result = spawnSync("/bin/sh", ["-c", command], { encoding: "utf8", env: { PATH: SYSTEM_PATH } });
  assert.equal(result.status, 0, `${command}: ${result.stderr}`);
  return result.stdout;
}

describe("The Linux helper's btrfs trial on real btrfs leaves nothing behind, or says what it left (090)", { skip: ROOT_FILESYSTEMS_SKIP }, () => {
  let mount = "";
  let homes = "";

  before(() => {
    const dir = tempDir("btrfs");
    mount = join(dir, "mnt");
    mkdirSync(mount);
    sh(`truncate -s 300M ${dir}/btrfs.img && mkfs.btrfs -q ${dir}/btrfs.img && mount -o loop ${dir}/btrfs.img ${mount}`);
    homes = join(mount, "home");
    mkdirSync(homes);
  });

  after(() => {
    if (mount) sh(`umount ${mount}`);
  });

  const subvolumes = () => sh(`btrfs subvolume list -o ${mount}`).split("\n").filter(Boolean).map((line) => line.replace(/^.* path /, ""));
  const cleanProbe = (machine: LinuxMachine) => {
    assert.deepEqual(reportOf(machine.probe()).home, { is: "yes", what: { way: "btrfs", dataset: null } });
    return tree(homes);
  };

  it("takes and deletes a trial subvolume and its snapshot", () => {
    const machine = linuxMachine(homes);

    const report = reportOf(machine.probe());

    assert.deepEqual(report.home, { is: "yes", what: { way: "btrfs", dataset: null } });
    assert.deepEqual(subvolumes(), []);
    assert.ok(tree(homes).every((path) => path === LINUX_TRIALS), tree(homes).join(", "));
  });

  it("deletes the trial subvolume when its snapshot fails", () => {
    const machine = linuxMachine(homes);
    const clean = cleanProbe(machine);
    writeFileSync(join(machine.faults, "snapshot-fails"), "");

    const report = reportOf(machine.probe());

    assert.deepEqual(report.home, { is: "no", why: `box homes are on btrfs under ${homes}, but a trial subvolume failed: ERROR: cannot snapshot: No space left on device` });
    assert.deepEqual([subvolumes(), tree(homes)], [[], clean]);
  });

  it("reports a snapshot it could not delete, where it is, and removes it at the next probe", () => {
    const machine = linuxMachine(homes);
    const clean = cleanProbe(machine);
    writeFileSync(join(machine.faults, "snapshot-stays"), "");

    const report = reportOf(machine.probe());

    const [snapshot, folder] = report.left;
    assert.equal(report.left.length, 2, report.left.join(", "));
    assert.match(folder!, new RegExp(`^${homes}/${LINUX_TRIALS}/\\d+$`));
    assert.equal(snapshot, `${folder}/snapshot`);
    assert.deepEqual(report.home, {
      is: "no",
      why: `box homes are on btrfs under ${homes}, but the helper could not remove its trial, which leaves ${snapshot}, ${folder}: as root, delete each subvolume there with btrfs subvolume delete, then its folder with rmdir`,
    });
    assert.deepEqual(subvolumes(), [relative(mount, snapshot!)]);

    sh(`rm ${machine.faults}/snapshot-stays`);
    assert.deepEqual(reportOf(machine.probe()).home, { is: "yes", what: { way: "btrfs", dataset: null } });
    assert.deepEqual([subvolumes(), tree(homes)], [[], clean]);
  });

  it("deletes its trial when the probe is stopped mid-snapshot", async () => {
    const machine = linuxMachine(homes);
    const clean = cleanProbe(machine);
    const state = tree(machine.state);
    writeFileSync(join(machine.faults, "slow-snapshot"), "");

    const probe = machine.start();
    await until(() => existsSync(join(machine.faults, "snapshotting")), "the trial snapshot");
    assert.equal(subvolumes().length, 2);
    process.kill(-probe.pid!, "SIGTERM");
    await exited(probe);

    assert.deepEqual([subvolumes(), tree(homes), tree(machine.state)], [[], clean, state]);
  });

  it("removes a killed probe's trial at the next probe, and leaves a running probe's alone", async () => {
    const machine = linuxMachine(homes);
    const clean = cleanProbe(machine);
    writeFileSync(join(machine.faults, "slow-snapshot"), "");
    const killed = machine.start();
    await until(() => existsSync(join(machine.faults, "snapshotting")), "the trial snapshot");
    process.kill(-killed.pid!, "SIGKILL");
    await exited(killed);
    assert.equal(subvolumes().length, 2);
    sh(`rm ${machine.faults}/snapshotting`);
    writeFileSync(join(machine.faults, "slow-snapshot"), "");
    const running = machine.start();
    await until(() => existsSync(join(machine.faults, "snapshotting")), "the second trial snapshot");
    const runningTrial = (path: string) => path.includes(`/${running.pid}/`);
    assert.ok(subvolumes().every(runningTrial), subvolumes().join(", "));

    const report = reportOf(machine.probe());

    assert.deepEqual(report.home, { is: "yes", what: { way: "btrfs", dataset: null } });
    assert.equal(subvolumes().filter(runningTrial).length, 2);
    assert.equal(subvolumes().length, 2);
    process.kill(-running.pid!, "SIGTERM");
    await exited(running);
    assert.deepEqual([subvolumes(), tree(homes)], [[], clean]);
  });
});

describe("The Mac helper's clone trial on a full disk leaves nothing behind (090)", { skip: ROOT_FILESYSTEMS_SKIP }, () => {
  it("removes the trial file it could not write", () => {
    const mac = macWithShortHookDeadline();
    const trials = realpathSync(join(mac.root, "var/db/bb-box"));
    mkdirSync(join(trials, "snapshot-trials"));
    sh(`mount -t tmpfs -o size=4k,mode=700 tmpfs ${trials}/snapshot-trials`);
    try {
      spawnSync("/bin/sh", ["-c", `cat /dev/zero >${trials}/snapshot-trials/filler`]);

      const report = reportOf(mac.helper(["snapshot", "probe"]));

      assert.match(JSON.stringify(report.home), /^\{"is":"no","why":"box homes are on APFS under \/Users, but a trial clone failed: the helper could not write .*\/snapshot-trials\/\d+\/trial"\}$/);
      assert.deepEqual(entries(join(trials, "snapshot-trials")), ["filler"]);
    } finally {
      sh(`umount ${trials}/snapshot-trials`);
    }
  });
});
