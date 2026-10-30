import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Proxmox } from "../src/backends/proxmox/api.ts";
import { SNAPSHOT_PRIVILEGES, poolPrivileges, snapshotsCheck, storageSnapshots } from "../src/backends/proxmox/snapshots.ts";
import { TOKEN_ROLE } from "./fake-proxmox.ts";
import { tempDir } from "./helpers.ts";

const ROLE_ON_MAIN_BEFORE_070 = TOKEN_ROLE.filter((privilege) => !(SNAPSHOT_PRIVILEGES as readonly string[]).includes(privilege));

test("each storage type restores what section 2 of 070 says", () => {
  const lxc = (type: string, volume = `store:base-9000-disk-0,size=8G`) => storageSnapshots({ name: "store", type, volume }, "lxc");
  const qemu = (type: string, volume: string) => storageSnapshots({ name: "store", type, volume }, "qemu");
  assert.deepEqual(lxc("lvmthin"), { restore: "any", words: "store (LVM-thin) restores any snapshot." });
  assert.deepEqual(lxc("rbd"), { restore: "any", words: "store (Ceph RBD) restores any snapshot." });
  assert.deepEqual(lxc("btrfs"), { restore: "any", words: "store (BTRFS) restores any snapshot." });
  assert.deepEqual(lxc("zfspool"), { restore: "newest-only", words: "store (ZFS) restores only the newest snapshot." });
  assert.deepEqual(lxc("dir", "store:9000/base-9000-disk-0.raw,size=8G"), { restore: "none", words: "store (directory) takes no snapshots of containers." });
  assert.deepEqual(lxc("lvm"), { restore: "none", words: "store (LVM) takes no snapshots of containers." });
  assert.deepEqual(qemu("dir", "store:9104/base-9104-disk-1.qcow2,size=64G"), { restore: "any", words: "store (directory, qcow2 files) restores any snapshot." });
  assert.deepEqual(qemu("nfs", "store:9104/base-9104-disk-1.qcow2"), { restore: "any", words: "store (NFS, qcow2 files) restores any snapshot." });
  assert.deepEqual(qemu("dir", "store:9104/base-9104-disk-1.raw,size=64G"), { restore: "none", words: "store (directory, raw files) takes no snapshots." });
  assert.deepEqual(qemu("lvm", "store:vm-9104-disk-1,size=64G"), {
    restore: "none",
    words: "store (LVM) takes snapshots of VMs only as a preview in Proxmox VE 9, so bb-box restores none.",
  });
  assert.deepEqual(qemu("zfspool", "store:base-9104-disk-1,size=64G"), { restore: "newest-only", words: "store (ZFS) restores only the newest snapshot." });
  assert.deepEqual(lxc("iscsi"), { restore: "none", words: "store (iSCSI) takes no snapshots." });
  assert.deepEqual(lxc("newfs"), { restore: "unknown", words: "bb-box does not know whether store (newfs) takes snapshots." });
});

test("the check passes a token with both rights, and names each one a token lacks", () => {
  const check = (privileges: readonly string[]) =>
    snapshotsCheck({ pool: "boxes", node: "node-1", guest: "lxc", privileges: new Set(privileges), storages: [{ name: "fast", type: "lvmthin", volume: "fast:base-9000-disk-0" }] });
  assert.deepEqual(check(TOKEN_ROLE), {
    status: "ok",
    detail: "The token may take, delete and restore snapshots on /pool/boxes. fast (LVM-thin) restores any snapshot.",
    fix: null,
  });
  const rerun = "Run host/setup-token.sh from the Proxmox LXC setup guide again, as root on node-1. It keeps the token and its secret, and adds the missing rights to the token's role.";
  assert.deepEqual(check(ROLE_ON_MAIN_BEFORE_070), {
    status: "warn",
    detail: "The token lacks VM.Snapshot and VM.Snapshot.Rollback on /pool/boxes, so bb-box cannot take or restore snapshots. fast (LVM-thin) restores any snapshot.",
    fix: rerun,
  });
  assert.deepEqual(check(TOKEN_ROLE.filter((privilege) => privilege !== "VM.Snapshot")), {
    status: "warn",
    detail: "The token lacks VM.Snapshot on /pool/boxes, so bb-box cannot take or delete snapshots. fast (LVM-thin) restores any snapshot.",
    fix: rerun,
  });
  assert.deepEqual(check(TOKEN_ROLE.filter((privilege) => privilege !== "VM.Snapshot.Rollback")), {
    status: "warn",
    detail: "The token lacks VM.Snapshot.Rollback on /pool/boxes, so bb-box cannot restore snapshots. fast (LVM-thin) restores any snapshot.",
    fix: rerun,
  });
});

test("the check describes each storage once, and warns when one takes no snapshots", () => {
  const result = snapshotsCheck({
    pool: "boxes",
    node: "node-1",
    guest: "qemu",
    privileges: new Set(TOKEN_ROLE),
    storages: [
      { name: "fast", type: "lvmthin", volume: "fast:base-9100-disk-1" },
      { name: "fast", type: "lvmthin", volume: "fast:base-9101-disk-1" },
      { name: "tank", type: "zfspool", volume: "tank:base-9102-disk-1" },
      { name: "ceph", type: "rbd", volume: "ceph:base-9103-disk-1" },
      { name: "files", type: "dir", volume: "files:9104/base-9104-disk-1.raw" },
    ],
  });
  assert.deepEqual(result, {
    status: "warn",
    detail:
      "The token may take, delete and restore snapshots on /pool/boxes. fast (LVM-thin) restores any snapshot. tank (ZFS) restores only the newest snapshot. " +
      "ceph (Ceph RBD) restores any snapshot. files (directory, raw files) takes no snapshots.",
    fix: "For snapshots, put the templates on storage that takes them: LVM-thin, ZFS, Ceph RBD, BTRFS, or qcow2 disks on a directory.",
  });
});

test("the check says when it cannot read the token's rights", () => {
  const result = snapshotsCheck({ pool: "boxes", node: "node-1", guest: "lxc", privileges: new Error("Proxmox GET /access/permissions failed (0): cannot reach the Proxmox API: timed out."), storages: [] });
  assert.deepEqual(result, {
    status: "warn",
    detail: "bb-box cannot read the token's rights on /pool/boxes: Proxmox GET /access/permissions failed (0): cannot reach the Proxmox API: timed out.",
    fix: "Check that BB's server reaches the Proxmox API, then run the checks again.",
  });
});

test("a privilege Proxmox lists without propagate still counts, and a read that fails is the error", async () => {
  const asked: string[] = [];
  const answering = (status: number, body: unknown) =>
    new Proxmox({
      apiUrl: "https://node-1.example:8006",
      tokenId: "user@pve!name",
      tokenSecret: "never-shown",
      node: "node-1",
      fetch: async (url) => {
        asked.push(url);
        return { ok: status === 200, status, statusText: status === 200 ? "OK" : "Forbidden", text: async () => JSON.stringify(body) };
      },
    });
  const held = await poolPrivileges(answering(200, { data: { "/pool/boxes": { "VM.Snapshot": 0, "VM.Snapshot.Rollback": 1 } } }), "boxes");
  assert.deepEqual(held instanceof Error ? held : [...held], ["VM.Snapshot", "VM.Snapshot.Rollback"]);
  assert.deepEqual(asked, ["https://node-1.example:8006/api2/json/access/permissions?path=%2Fpool%2Fboxes"]);
  assert.deepEqual(await poolPrivileges(answering(200, { data: {} }), "boxes"), new Set());
  const refused = await poolPrivileges(answering(403, { message: "Permission check failed" }), "boxes");
  assert.ok(refused instanceof Error);
  assert.doesNotMatch(refused.message, /never-shown/);
});

const SETUP_TOKEN = new URL("../setup/proxmox-lxc/host/setup-token.sh", import.meta.url).pathname;
const HAS_JQ = spawnSync("sh", ["-c", "command -v jq"]).status === 0;

function setupToken() {
  const dir = tempDir("setup-token");
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  const log = join(dir, "pveum.log");
  writeFileSync(log, "");
  const listOf = (name: string) => `[ -f "${state}/${name}" ] && cat "${state}/${name}" || echo '[]'`;
  writeFileSync(
    join(bin, "pveum"),
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >>"${log}"`,
      'case "$1 $2 $3" in',
      `  "pool list "*) ${listOf("pools")} ;;`,
      `  "role list "*) ${listOf("roles")} ;;`,
      `  "role add "*) echo "[{\\"roleid\\":\\"$3\\"}]" >"${state}/roles.$3"; cat "${state}"/roles.* | jq -s add >"${state}/roles" ;;`,
      `  "user list "*) ${listOf("users")} ;;`,
      `  "user add "*) echo "[{\\"userid\\":\\"$3\\"}]" >"${state}/users" ;;`,
      `  "user token list") ${listOf("tokens")} ;;`,
      `  "user token add") echo "[{\\"tokenid\\":\\"$5\\"}]" >"${state}/tokens"; echo '{"value":"fake-secret-from-pveum"}' ;;`,
      "  \"acl list \"*) echo '[]' ;;",
      "esac",
    ].join("\n") + "\n",
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "openssl"), "#!/bin/sh\necho 'sha256 Fingerprint=AA:BB:CC'\n", { mode: 0o755 });
  writeFileSync(join(bin, "ip"), "#!/bin/sh\necho '1.1.1.1 via 192.0.2.1 dev vmbr0 src 192.0.2.10 uid 0'\n", { mode: 0o755 });
  const tokenFile = join(dir, "token", "proxmox-token.env");
  return {
    tokenFile,
    run() {
      return spawnSync("bash", [SETUP_TOKEN], {
        encoding: "utf8",
        env: { PATH: `${bin}:/usr/bin:/bin`, BBBOX_ENV: join(dir, "absent.env"), BBBOX_NODE: "node-1", BBBOX_TOKEN_FILE: tokenFile },
      });
    },
    calls(): string[] {
      return readFileSync(log, "utf8").trim().split("\n");
    },
  };
}

function privilegesSet(calls: readonly string[], verb: "add" | "modify"): string[] {
  const call = calls.find((line) => line.startsWith(`role ${verb} BBBoxPlugin --privs `));
  assert.ok(call, `pveum role ${verb} BBBoxPlugin was called: ${calls.join("; ")}`);
  return call.split(" --privs ")[1]!.split(",");
}

test("setup-token.sh gives a new role both snapshot rights, and a rerun adds them to the role while keeping the token", { skip: !HAS_JQ && "needs jq" }, () => {
  const host = setupToken();
  const first = host.run();
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(privilegesSet(host.calls(), "add"), [...TOKEN_ROLE]);
  assert.match(first.stdout, /^created token bbbox@pve!plugin in /m);
  assert.doesNotMatch(first.stdout + first.stderr, /fake-secret-from-pveum/);
  assert.match(readFileSync(host.tokenFile, "utf8"), /^PROXMOX_TOKEN_SECRET=fake-secret-from-pveum$/m);
  assert.equal(statSync(host.tokenFile).mode & 0o777, 0o600);

  const before = host.calls().length;
  const rerun = host.run();
  assert.equal(rerun.status, 0, rerun.stderr);
  const again = host.calls().slice(before);
  assert.deepEqual(privilegesSet(again, "modify"), [...TOKEN_ROLE]);
  assert.ok(!again.some((line) => line.startsWith("user token add") || line.startsWith("user add") || line.startsWith("role add BBBoxPlugin ")), again.join("; "));
  assert.match(rerun.stdout, /token bbbox@pve!plugin already exists; .* kept/);
  assert.doesNotMatch(rerun.stdout + rerun.stderr, /fake-secret-from-pveum/);
});
