import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SshPoolBackend } from "../src/backends/ssh-pool/backend.ts";
import { parseSshPoolSettings, type SshPoolConfig } from "../src/backends/ssh-pool/config.ts";
import type { Backend, BackendStorage, DoctorCheck, Guest } from "../src/backends/types.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";
import { COMMAND, readyBox, rejection, standing, world } from "./snapshot-world.ts";

const HELPER = `node ${new URL("./fake-machine.mjs", import.meta.url).pathname}`;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDbH0n7Bm2fQzZ0lH8w5j0c0pYh7J6Hq4Xb1x2u3v4w";
const LVM_THIN_HOOK = '{"contract":1,"scope":"machine","holds":["disk"],"whileRunning":"pauses","restore":"in-place","restarts":false,"lives":"host","keepsPastRelease":"no","price":null,"excludes":"memory","storage":{"name":"bbvg/thinpool","type":"lvmthin","percentFull":12}}';
const fake = fakeSsh();
const disposed = disposedOnceTheFileEnds();

function machine(host: string, flags: Record<string, string> = {}): void {
  const state = join(fake.home(host), ".bb-box-state");
  rmSync(state, { recursive: true, force: true });
  mkdirSync(join(state, "flags"), { recursive: true });
  writeFileSync(join(state, "generation"), "0\n");
  for (const [name, value] of Object.entries(flags)) writeFileSync(join(state, "flags", name), value);
}

function config(lines: string): SshPoolConfig {
  const hosts = [...lines.matchAll(/@?(192\.0\.2\.\d+)/g)].map(([, host]) => host);
  const result = parseSshPoolSettings({
    "ssh-pool-enabled": true,
    "ssh-pool-machines": lines,
    "ssh-pool-known-hosts": [...new Set(hosts)].map((host) => `${host} ${HOST_KEY}`).join("\n"),
    "ssh-pool-ssh-private-key": "",
  });
  assert.ok(result.enabled && result.ok, JSON.stringify(result));
  return result.config;
}

function pool(lines: string, storage: BackendStorage = new MemoryStorage(), id = "ssh-pool") {
  const backend = new SshPoolBackend(config(lines), testContext(storage, "test", { id }), { sshBinary: FAKE_SSH_BINARY, helperCommand: HELPER, readyTimeoutMs: 0, resetPollMs: 1, sleep: async () => {} });
  return disposed(backend);
}

function guestOn(machine: string): Guest {
  return { ref: machine, host: machine, address: null, size: null, data: {} };
}

function check(checks: readonly DoctorCheck[], id: string): DoctorCheck {
  const found = checks.find((each) => each.id === id);
  assert.ok(found, `the doctor has ${id}: ${checks.map((each) => each.id).join(", ")}`);
  return found;
}

describe("Pool machines report whether they can snapshot (090)", () => {
  it("the doctor shows what each machine could offer, why not where not, and a pool summary", async () => {
    machine("192.0.2.71");
    machine("192.0.2.72", { "homes-fs": "btrfs", "homes-snapshot": "btrfs" });
    machine("192.0.2.73", { "homes-fs": "btrfs", "homes-snapshot": "btrfs", docker: "", hook: "", "snapshot-hook": LVM_THIN_HOOK });
    machine("192.0.2.74", { macos: "", "homes-snapshot": "apfs" });
    const backend = pool("build-1 192.0.2.71 linux\nbuild-2 192.0.2.72 linux\nbuild-3 192.0.2.73 linux reset=machine\nmac-1 192.0.2.74 macos");

    const { checks } = await backend.doctor();

    assert.match(check(checks, "machine.build-1.snapshots").detail, /^Home snapshots: none: ext4 under \/home, which neither clones nor snapshots\. Machine snapshots: none: no snapshot hook is installed\. Probed just now\. BB Box takes no snapshots on the SSH host pool yet\.$/);
    assert.match(check(checks, "machine.build-2.snapshots").detail, /^Home snapshots: btrfs subvolumes available under \/home, 40 GiB free\. Machine snapshots: none: no snapshot hook is installed\./);
    assert.match(check(checks, "machine.build-3.snapshots").detail, /^Home snapshots: none: its boxes have root through its whole-machine reset, .*\. Machine snapshots: hook found: machine scope, LVM thin \(bbvg\/thinpool, 12% full\)\./);
    assert.match(check(checks, "machine.mac-1.snapshots").detail, /^Home snapshots: APFS clones available under \/Users, 40 GiB free\./);
    assert.ok(["build-1", "build-2", "build-3", "mac-1"].every((name) => check(checks, `machine.${name}.snapshots`).status === "ok"));
    assert.equal(
      check(checks, "snapshot-offers").detail,
      "2 of 4 machines could offer home snapshots (build-2, mac-1); 1 of 4 machines could offer machine snapshots by a hook (build-3). BB Box takes no snapshots on the SSH host pool yet.",
    );
  });

  it("names a hook that speaks another contract, or fails, as offering nothing, with its own words", async () => {
    machine("192.0.2.75", { "snapshot-hook": '{"contract":2,"scope":"machine"}' });
    machine("192.0.2.76", { "hook-fails": "lvs: volume group bbvg not found" });
    const backend = pool("build-5 192.0.2.75 linux\nbuild-6 192.0.2.76 linux");

    const { checks } = await backend.doctor();

    assert.match(check(checks, "machine.build-5.snapshots").detail, /Machine snapshots: none: its snapshot hook speaks contract 2, and BB Box speaks 1\./);
    assert.match(check(checks, "machine.build-6.snapshots").detail, /Machine snapshots: none: its snapshot hook's describe failed: it exited with 1: lvs: volume group bbvg not found\./);
  });

  it("warns, with the setup to run, for a machine whose helper does not probe", async () => {
    machine("192.0.2.77", { "no-snapshot": "" });
    const backend = pool("build-7 192.0.2.77 linux");

    const { checks } = await backend.doctor();

    const old = check(checks, "machine.build-7.snapshots");
    assert.equal(old.status, "warn");
    assert.match(old.detail, /has not said whether it can snapshot: its helper is older than this BB Box's/);
    assert.match(old.fix ?? "", /setup\/ssh-pool\/setup\.sh/);
    assert.match(check(checks, "snapshot-offers").detail, /1 of 1 machine have not said \(build-7\)/);
  });

  it("reads each machine's report from its status, keeps it, and answers from it when the machine is away", async () => {
    machine("192.0.2.78", { "homes-fs": "xfs" });
    const storage = new MemoryStorage();
    await pool("build-8 192.0.2.78 linux", storage).doctor();
    machine("192.0.2.78", { "homes-fs": "btrfs", "homes-snapshot": "btrfs" });
    const surveyed = pool("build-8 192.0.2.78 linux", new MemoryStorage());
    writeFileSync(join(fake.home("192.0.2.78"), ".bb-box-state", "snapshots"), "snapshot.probe=1\nsnapshot.at=4102444800\nsnapshot.homes=/home\nsnapshot.filesystem=btrfs\nsnapshot.home=yes\nsnapshot.home.how=btrfs\nsnapshot.hook=none\n");

    await surveyed.members();
    const later = pool("build-8 192.0.2.78 linux", storage);
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.match(surveyed.noSnapshotsWhy(guestOn("build-8")) ?? "", /reports home snapshots: btrfs subvolumes available under \/home, but BB Box takes no snapshots on the SSH host pool yet/);
    assert.match(later.noSnapshotsWhy(guestOn("build-8")) ?? "", /^its machine, build-8, takes no snapshots: for a home snapshot, xfs under \/home, which neither clones nor snapshots; for a machine snapshot, no snapshot hook is installed$/);
  });

  it("offers no snapshots in its kinds, and a take on its box refuses with the machine's own reason", async () => {
    machine("192.0.2.79");
    const made: SshPoolBackend[] = [];
    const state = world({ markersOn: false, backend: (storage) => made[made.push(pool("build-9 192.0.2.79 linux", storage, "fake")) - 1]! });
    await state.backend.doctor();
    const box = await readyBox(state);

    const refused = await rejection(state.snapshots.take(COMMAND, box, standing(box), { name: "A" }));

    const offered: Backend = made[0]!;
    assert.equal(offered.snapshotting?.("linux") ?? null, null);
    assert.equal(refused.code, "unsupported");
    assert.match(refused.message, /^SSH host pool of 1 machine takes no snapshot of box .+: its machine, build-9, takes no snapshots: for a home snapshot, ext4 under \/home, which neither clones nor snapshots; for a machine snapshot, no snapshot hook is installed\.$/);
  });
});
