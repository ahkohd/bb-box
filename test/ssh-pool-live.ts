// Pool checks for the SSH host pool on live machines: the Docker rig that
// setup/ssh-pool/test/rig.sh starts on this computer. They look at and
// change the machines from outside with docker exec, as an operator would
// on the machine itself.
//
//   sh setup/ssh-pool/test/rig.sh up <dir>
//   SSH_POOL_RIG=<dir> node --test test/ssh-pool-live.ts
//
// Run them after `npm run conformance`, or alone. They need every machine
// free, and leave every machine free.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { promisify } from "node:util";
import { parseSshPoolSettings } from "../src/backends/ssh-pool/config.ts";
import { sshPoolDriver } from "../src/backends/ssh-pool/index.ts";
import type { Backend, Guest } from "../src/backends/types.ts";
import { readSettings } from "../scripts/smoke.ts";
import { identity, recordingHooks, releaseHooks, sizeOf } from "./conformance/suite.ts";
import { MemoryStorage, shippedKind } from "./helpers.ts";

const rig = process.env.SSH_POOL_RIG;
const run = promisify(execFile);
const HOOK = "/usr/local/libexec/bb-box/reset-machine";
const HELPER = "/usr/local/libexec/bb-box/machine";

const made: Backend[] = [];

function backend(file: string, errors: string[] = []): Backend {
  const parsed = parseSshPoolSettings(readSettings(join(rig!, file)));
  assert.ok(parsed.enabled && parsed.ok, `${file} parses`);
  const pool = sshPoolDriver.create(parsed.config, {
    id: "ssh-pool",
    storage: new MemoryStorage(),
    installId: "live",
    warm: () => 0,
    hostOn: () => true,
    kind: shippedKind,
    logError: (operation, error) => errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
  });
  made.push(pool);
  return pool;
}

/** Runs a script as root on a rig machine, and gives its output. */
async function onMachine(machine: string, script: string): Promise<string> {
  const child = run("docker", ["exec", "-i", `bbbox-sshpool-${machine}`, "sh", "-s"], { timeout: 120_000 });
  child.child.stdin!.end(script);
  return (await child).stdout.trim();
}

async function acquire(pool: Backend, kind: string, size = sizeOf(kind)): Promise<Guest> {
  return pool.acquire(identity(kind, size), null, recordingHooks().hooks, AbortSignal.timeout(120_000));
}

async function inBox(pool: Backend, guest: Guest, kind: string, script: string): Promise<string> {
  const { command } = await pool.transports(guest, kind);
  const result = await command!.run(script, { timeoutMs: 60_000 });
  assert.equal(result.exitCode, 0, `in the box: ${result.stderr}`);
  return result.stdout.trim();
}

async function member(pool: Backend, ref: string) {
  const found = (await pool.members!()).find((other) => other.ref === ref);
  assert.ok(found, `${ref} is a member`);
  return found;
}

/** What the reset must remove, as counts on the machine, for a user and UID. */
async function leftovers(machine: string, user: string, uid: string): Promise<Record<string, string>> {
  const out = await onMachine(
    machine,
    `u=${user} n=${uid}
echo "user=$(getent passwd $u | wc -l)"
echo "home=$(ls -d /home/$u 2>/dev/null | wc -l)"
echo "processes=$(pgrep -u $n | wc -l)"
echo "crontab=$(ls /var/spool/cron/crontabs/$u 2>/dev/null | wc -l)"
echo "at=$(atq 2>/dev/null | wc -l)"
echo "ipc=$(ipcs -a | awk -v u=$u -v n=$n '$3 == u || $3 == n' | wc -l)"
echo "files=$(find /tmp /var/tmp /dev/shm /home -xdev -uid $n 2>/dev/null | wc -l)"
echo "sudo=$(ls /etc/sudoers.d/$u 2>/dev/null | wc -l)"
echo "linger=$(ls /var/lib/systemd/linger/$u 2>/dev/null | wc -l)"`,
  );
  return Object.fromEntries(out.split("\n").map((line) => line.split("=") as [string, string]));
}

const NOTHING = { user: "0", home: "0", processes: "0", crontab: "0", at: "0", ipc: "0", files: "0", sudo: "0", linger: "0" };

/** Leaves processes, cron and at jobs, files in the shared temporary directories and SysV IPC objects. */
const DIRTY = `nohup sleep 1000 >/dev/null 2>&1 &
setsid sh -c 'trap "" HUP TERM; exec sleep 1001' </dev/null >/dev/null 2>&1 &
echo '* * * * * true' | crontab -
echo true | at now + 1 hour >/dev/null 2>&1
for dir in /tmp /var/tmp /dev/shm; do mkdir -p "$dir/left" && echo x >"$dir/left/file" && echo y >"$dir/left-file"; done
ipcmk -M 4096 >/dev/null && ipcmk -Q >/dev/null && ipcmk -S 1 >/dev/null
id -u`;

describe("SSH host pool on the Docker rig", { skip: rig ? false : "set SSH_POOL_RIG to the directory rig.sh up wrote" }, () => {
  // Closes the shared SSH connections, which would otherwise outlive the run.
  after(async () => {
    for (const pool of made) await pool.dispose?.();
  });

  it("starts with every machine free", async () => {
    const pool = backend("settings.json");
    for (const found of await pool.members!()) assert.equal(found.state, "free", `${found.ref}: ${found.reason}`);
    const report = await pool.doctor();
    assert.ok(report.ok, report.summary);
  });

  it("fails its doctor without Node.js on a machine, and warns without gh", async () => {
    const pool = backend("settings.json");
    const tools = async () => (await pool.doctor()).checks.find((check) => check.id === "machine.plain.tools")!;
    assert.match((await tools()).detail, /with Node\.js 24\.\d+\.\d+\./);
    await onMachine("plain", "mv /usr/local/bin/node /usr/local/bin/node.saved");
    try {
      const without = await tools();
      assert.equal(without.status, "fail");
      assert.equal(without.detail, "plain lacks node.");
    } finally {
      await onMachine("plain", "mv /usr/local/bin/node.saved /usr/local/bin/node");
    }
    await onMachine("plain", "mv /usr/bin/gh /usr/bin/gh.saved");
    try {
      const without = await tools();
      assert.equal(without.status, "warn");
      assert.match(without.detail, /^plain lacks gh\. /);
    } finally {
      await onMachine("plain", "mv /usr/bin/gh.saved /usr/bin/gh");
    }
    assert.equal((await tools()).status, "ok");
  });

  it("removes what a box left on a machine without systemd", async () => {
    const pool = backend("settings.json");
    const guest = await acquire(pool, "linux");
    assert.equal(guest.ref, "plain");
    const user = String(guest.data?.user);
    const uid = await inBox(pool, guest, "linux", DIRTY);
    const before = await leftovers("plain", user, uid);
    for (const what of ["user", "home", "crontab", "at"]) assert.equal(before[what], "1", `the box made its ${what}`);
    assert.ok(Number(before.processes) >= 2 && before.ipc === "3" && Number(before.files) >= 6, JSON.stringify(before));
    const generation = (await member(pool, "plain")).generation;
    await pool.release(guest, releaseHooks().hooks);
    assert.deepEqual(await leftovers("plain", user, uid), NOTHING);
    const after = await member(pool, "plain");
    assert.equal(after.state, "free");
    assert.equal(after.generation, generation + 1);
  });

  it("turns linger on for a box on systemd, gives it Docker, and a whole-machine reset removes both", async () => {
    // Only systemd gives Docker, so only a pool of it alone does (041).
    assert.ok(!backend("settings.json").kinds()[0]!.capabilities.features.includes("docker"), "a mixed pool has no Docker");
    const pool = backend("docker.json");
    assert.deepEqual(pool.kinds()[0]!.capabilities.features, ["docker"]);
    const guest = await acquire(pool, "linux");
    assert.equal(guest.ref, "systemd");
    const user = String(guest.data?.user);
    const uid = await inBox(pool, guest, "linux", "docker volume create left >/dev/null && tar cf - -T /dev/null | docker import - left:latest >/dev/null && id -u");
    const held = await onMachine(
      "systemd",
      `ls /var/lib/systemd/linger; systemctl is-active user@${uid}.service; docker volume ls -q; docker images -q | wc -l`,
    );
    assert.deepEqual(held.split("\n"), [user, "active", "left", "1"]);
    assert.equal((await pool.transports(guest, "linux")).access?.dockerHost, `ssh://${user}@127.0.0.1:2222`);
    await pool.release(guest, releaseHooks().hooks);
    assert.deepEqual(await leftovers("systemd", user, uid), NOTHING);
    const after = await onMachine("systemd", `systemctl is-active user@${uid}.service; docker volume ls -q | wc -l; docker images -q | wc -l`);
    assert.deepEqual(after.split("\n"), ["inactive", "0", "0"]);
  });

  it("puts a machine whose reset failed out of service, and returns it to service with a reset", async () => {
    const errors: string[] = [];
    const pool = backend("docker.json", errors);
    await onMachine("systemd", `cp ${HOOK} ${HOOK}.saved && printf '#!/bin/sh\\necho the disk is full >&2\\nexit 1\\n' >${HOOK}`);
    try {
      const guest = await acquire(pool, "linux");
      const user = String(guest.data?.user);
      const uid = await inBox(pool, guest, "linux", "id -u");
      const generation = (await member(pool, "systemd")).generation;
      await pool.release(guest, releaseHooks().hooks);
      const broken = await member(pool, "systemd");
      assert.equal(broken.state, "out-of-service");
      assert.match(broken.reason ?? "", /the disk is full/);
      assert.ok(errors.some((error) => /the disk is full/.test(error)), errors.join("\n"));
      assert.equal((await pool.capacity("linux", sizeOf("linux"), [])).ok, false);
      const report = await pool.doctor();
      const state = report.checks.find((check) => check.id === "machine.systemd.state");
      assert.equal(state?.status, "warn");
      assert.match(state?.fix ?? "", /machine reset machine/);
      await assert.rejects(pool.returnToService!("systemd"), /still out of service/);

      await onMachine("systemd", `mv -f ${HOOK}.saved ${HOOK}`);
      await pool.returnToService!("systemd");
      const back = await member(pool, "systemd");
      assert.equal(back.state, "free");
      assert.ok(back.generation > generation, `${back.generation} > ${generation}`);
      assert.deepEqual(await leftovers("systemd", user, uid), NOTHING);
    } finally {
      await onMachine("systemd", `[ ! -e ${HOOK}.saved ] || mv -f ${HOOK}.saved ${HOOK}`);
    }
  });

  it("finishes a whole-machine reset after the machine restarts during it", async () => {
    const pool = backend("docker.json");
    // A hook that says it restarts the machine to finish.
    await onMachine("systemd", `cp ${HOOK} ${HOOK}.saved && printf '#!/bin/sh\\ntouch "$BB_BOX_RESTARTING"\\nsleep 600\\n' >${HOOK}`);
    try {
      const guest = await acquire(pool, "linux");
      const user = String(guest.data?.user);
      const uid = await inBox(pool, guest, "linux", "id -u");
      const generation = (await member(pool, "systemd")).generation;
      const released = pool.release(guest, releaseHooks().hooks);
      await onMachine("systemd", "until [ -e /var/lib/bb-box/restore/restarting ]; do sleep 0.2; done");
      // The restart the hook asked for, as docker restart does to the rig's machine.
      await run("docker", ["restart", "bbbox-sshpool-systemd"], { timeout: 120_000 });
      await released;
      const after = await member(pool, "systemd");
      assert.equal(after.state, "free", after.reason ?? "");
      assert.equal(after.generation, generation + 1);
      assert.deepEqual(await leftovers("systemd", user, uid), NOTHING);
    } finally {
      await onMachine("systemd", `[ ! -e ${HOOK}.saved ] || mv -f ${HOOK}.saved ${HOOK}`);
    }
  });

  it("puts a machine out of service when it restarts before its whole-machine reset finishes", async () => {
    const errors: string[] = [];
    const pool = backend("docker.json", errors);
    // A hook that does not say it restarts the machine, so a restart cuts it short.
    await onMachine("systemd", `cp ${HOOK} ${HOOK}.saved && printf '#!/bin/sh\\nsleep 600\\n' >${HOOK}`);
    try {
      const guest = await acquire(pool, "linux");
      const user = String(guest.data?.user);
      const uid = await inBox(pool, guest, "linux", "id -u");
      const generation = (await member(pool, "systemd")).generation;
      const released = pool.release(guest, releaseHooks().hooks);
      await onMachine("systemd", "until [ -e /var/lib/bb-box/restore/boot ]; do sleep 0.2; done; sleep 1");
      await run("docker", ["restart", "bbbox-sshpool-systemd"], { timeout: 120_000 });
      await released;
      const broken = await member(pool, "systemd");
      assert.equal(broken.state, "out-of-service");
      assert.match(broken.reason ?? "", /The machine restarted before reset-machine finished/);
      assert.equal(await onMachine("systemd", "ls /var/lib/bb-box/restore.failed/log | wc -l"), "1", "the hook's log stays for the operator");

      await onMachine("systemd", `mv -f ${HOOK}.saved ${HOOK}`);
      await pool.returnToService!("systemd");
      const back = await member(pool, "systemd");
      assert.equal(back.state, "free", back.reason ?? "");
      assert.equal(back.generation, generation + 1);
      assert.deepEqual(await leftovers("systemd", user, uid), NOTHING);
    } finally {
      await onMachine("systemd", `[ ! -e ${HOOK}.saved ] || mv -f ${HOOK}.saved ${HOOK}`);
    }
  });

  it("never resets a machine a box holds, even when its helper is too old", async () => {
    const pool = backend("settings.json");
    const guest = await acquire(pool, "linux");
    const user = String(guest.data?.user);
    try {
      // The helper refuses, from bb-box and from an operator.
      assert.equal(await onMachine("plain", `printf 'install=live\\n' | ${HELPER} reset; echo $?`), "4");
      assert.equal(await onMachine("plain", `${HELPER} reset </dev/null; echo $?`), "4");
      // As after an upgrade that needs a newer helper.
      await onMachine("plain", `cp ${HELPER} ${HELPER}.saved && sed -i 's/^VERSION=.*/VERSION=0/' ${HELPER}`);
      assert.equal((await member(pool, "plain")).state, "held");
      await assert.rejects(pool.returnToService!("plain"), /plain is held by box .+\. Release the box first\./);
      assert.equal(await inBox(pool, guest, "linux", "id -un"), user);
    } finally {
      await onMachine("plain", `[ ! -e ${HELPER}.saved ] || mv -f ${HELPER}.saved ${HELPER}`);
    }
    await pool.release(guest, releaseHooks().hooks);
    assert.equal((await member(pool, "plain")).state, "free");
  });

  it("finishes a reset cut short, from a new instance on empty storage", async () => {
    const pool = backend("settings.json");
    const guest = await acquire(pool, "linux");
    const user = String(guest.data?.user);
    const uid = await inBox(pool, guest, "linux", "nohup sleep 1000 >/dev/null 2>&1 & id -u");
    // The helper's first step, after which the connection dropped.
    await onMachine("plain", "mv /var/lib/bb-box/owner /var/lib/bb-box/resetting");
    const fresh = backend("settings.json");
    const left = (await fresh.held()).find((other) => other.ref === "plain");
    assert.ok(left, "the new instance finds the machine");
    assert.equal(left.owner, null, "a machine being reset belongs to no box");
    assert.equal((await member(fresh, "plain")).state, "resetting");
    await fresh.release(left, releaseHooks().hooks);
    assert.equal((await member(fresh, "plain")).state, "free");
    assert.deepEqual(await leftovers("plain", user, uid), NOTHING);
  });

  it("leaves the next box alone when an old box on its machine is released again", async () => {
    const pool = backend("settings.json");
    const old = await acquire(pool, "linux");
    await pool.release(old, releaseHooks().hooks);
    const next = await acquire(pool, "linux");
    assert.equal(next.ref, old.ref);
    assert.equal(await pool.power(old), null, "the old box is gone");
    await pool.release(old, releaseHooks().hooks);
    assert.equal(await pool.power(next), "running");
    assert.equal(await inBox(pool, next, "linux", "echo here"), "here");
    await pool.release(next, releaseHooks().hooks);
    assert.equal((await member(pool, next.ref)).state, "free");
  });

  it("keeps a machine an earlier box left dirty out of service until an operator resets it", async () => {
    const pool = backend("settings.json");
    await onMachine("plain", "useradd -m bbx-stray");
    const dirty = await member(pool, "plain");
    assert.equal(dirty.state, "out-of-service");
    assert.match(dirty.reason ?? "", /bbx-stray/);
    await onMachine("plain", `${HELPER} reset </dev/null`);
    assert.equal((await member(pool, "plain")).state, "free");
    assert.equal(await onMachine("plain", "getent passwd bbx-stray | wc -l; ls /home | wc -l"), "0\n0");
  });

  it("says the cores a box can use when the machine is a container with a CPU limit", async (t) => {
    const [all, cpus] = (await onMachine("plain", "nproc; cat /sys/fs/cgroup/cpuset.cpus.effective")).split("\n");
    if (Number(all) < 2) return t.skip("plain has one CPU");
    const cores = async () => {
      const pool = backend("settings.json");
      // One core, so a machine limited to one still has the size.
      const guest = await acquire(pool, "linux", { ...sizeOf("linux"), cores: 1 });
      try {
        assert.equal(guest.ref, "plain");
        return { size: guest.size?.cores, nproc: Number(await inBox(pool, guest, "linux", "nproc")) };
      } finally {
        await pool.release(guest, releaseHooks().hooks);
      }
    };
    // Where the rig runs in a container with some of the host's CPUs, online CPUs count them all.
    assert.deepEqual(await cores(), { size: Number(all), nproc: Number(all) });
    // A CPU quota of one CPU, as docker run --cpus 1 sets: the box still sees every CPU.
    await run("docker", ["update", "--cpu-quota", "100000", "bbbox-sshpool-plain"]);
    try {
      assert.deepEqual(await cores(), { size: 1, nproc: Number(all) });
    } finally {
      await run("docker", ["update", "--cpu-quota", "-1", "bbbox-sshpool-plain"]);
    }
    // A CPU set of one CPU. Docker may not know the CPUs a container like this one has now, so taskset sets it.
    assert.equal(await onMachine("plain", `taskset -c ${cpus!.split(/[,-]/)[0]} ${HELPER} status </dev/null | grep '^cores='`), "cores=1");
  });

  it("says the memory a box can use when the machine is a container with a memory limit", async () => {
    const all = Number(await onMachine("plain", "awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo"));
    const memory = async () => {
      const pool = backend("settings.json");
      // 1 GiB, so a machine limited to 2 GiB still has the size.
      const guest = await acquire(pool, "linux", { ...sizeOf("linux"), memoryMiB: 1024 });
      try {
        assert.equal(guest.ref, "plain");
        return guest.size?.memoryMiB;
      } finally {
        await pool.release(guest, releaseHooks().hooks);
      }
    };
    // Docker's memory limit is not in /proc/meminfo, which shows the host's memory.
    assert.equal(await memory(), all);
    await run("docker", ["update", "--memory", "2g", "--memory-swap", "2g", "bbbox-sshpool-plain"]);
    try {
      assert.equal(await memory(), 2048);
    } finally {
      // Docker cannot remove a memory limit, so this one is the host's memory, which a machine says as without a limit.
      await run("docker", ["update", "--memory", `${all}m`, "--memory-swap", `${all * 2}m`, "bbbox-sshpool-plain"]);
    }
  });

  it("reaches a machine through a jump host", async () => {
    const pool = backend("via.json");
    const report = await pool.doctor();
    assert.ok(report.ok, report.summary);
    const guest = await acquire(pool, "linux");
    assert.equal(await inBox(pool, guest, "linux", "hostname"), "plain");
    assert.equal((await pool.transports(guest, "linux")).access?.dockerHost, null);
    await pool.release(guest, releaseHooks().hooks);
    assert.equal((await member(pool, "plain")).state, "free");
  });
});
