import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { forkSafeVersion, parseIdentityStatus } from "../src/core/identity.ts";
import { tempDir } from "./helpers.ts";

const SCRIPT = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/bb-box-identity.sh", import.meta.url));
const CUSTOMIZE_BASE = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/customize-base.sh", import.meta.url));
const FINALIZE = fileURLToPath(new URL("../setup/proxmox-lxc/template/guest/finalize.sh", import.meta.url));
const DOCKER_START = fileURLToPath(new URL("../setup/docker/start", import.meta.url));
const BB_FOLDER = "home/box/.bb-machines/bb.example.com";
const WORKTREE_FILE = `${BB_FOLDER}/plugins/environment-git-worktree/host-data/worktrees/thr_a/notes.txt`;
const DAEMON_UNIT = "bb-host-daemon-bb-example-com-host_source.service";
const USER_UNITS = "home/box/.config/systemd/user";
const ETHER = 1;
const NONE = 65534;
const LOOPBACK = 772;

interface Nic {
  readonly name: string;
  readonly mac: string;
  readonly device?: boolean;
  readonly type?: number;
}

const LXC_ETH0: Nic = { name: "eth0", mac: "BC:24:11:AA:F1:B6" };
const LOOP: Nic = { name: "lo", mac: "00:00:00:00:00:00", type: LOOPBACK };
const BOX_MADE: readonly Nic[] = [
  { name: "docker0", mac: "02:42:ac:11:00:01" },
  { name: "br-0f1e2d3c4b5a", mac: "02:42:9c:01:02:03" },
  { name: "veth1a2b3c4", mac: "6a:01:02:03:04:05" },
  { name: "tailscale0", mac: "00:00:00:00:00:00", type: NONE },
];

function setNics(root: string, nics: readonly Nic[]): void {
  rmSync(join(root, "sys/class/net"), { recursive: true, force: true });
  mkdirSync(join(root, "sys/class/net"), { recursive: true });
  for (const nic of nics) {
    const dir = join(root, "sys/class/net", nic.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "address"), `${nic.mac}\n`);
    writeFileSync(join(dir, "type"), `${nic.type ?? ETHER}\n`);
    if (nic.device) mkdirSync(join(dir, "device"));
  }
}

function hostKey(root: string, type: string): void {
  const made = spawnSync("ssh-keygen", ["-q", "-t", type, "-N", "", "-C", "", "-f", join(root, `etc/ssh/ssh_host_${type}_key`)]);
  assert.equal(made.status, 0, made.stderr?.toString());
}

function seedIdentity(root: string): void {
  const bb = join(root, BB_FOLDER);
  mkdirSync(join(bb, "npm/lib/node_modules/bb-app"), { recursive: true });
  mkdirSync(join(root, WORKTREE_FILE, ".."), { recursive: true });
  mkdirSync(join(bb, "logs"), { recursive: true });
  mkdirSync(join(bb, "daemon.lock.lock"), { recursive: true });
  writeFileSync(join(root, WORKTREE_FILE), "the thread's work");
  writeFileSync(join(bb, "auth.json"), '{"token":"secret"}');
  writeFileSync(join(bb, "config.json"), "{}");
  writeFileSync(join(bb, "host-id"), "host_source\n");
  writeFileSync(join(bb, "host-artifact.sha256"), "0123abcd\n");
  writeFileSync(join(bb, "logs/daemon.log"), "a log");
  mkdirSync(join(root, USER_UNITS, "default.target.wants"), { recursive: true });
  writeFileSync(join(root, USER_UNITS, DAEMON_UNIT), "[Service]\n");
  symlinkSync(`../${DAEMON_UNIT}`, join(root, USER_UNITS, "default.target.wants", DAEMON_UNIT));
  mkdirSync(join(root, "home/box/.config/bb-box"), { recursive: true });
  writeFileSync(join(root, "home/box/.config/bb-box/env"), "export GH_TOKEN=token\n");
  writeFileSync(join(root, "home/box/.config/bb-box/access-a17e70a62012"), "");
  mkdirSync(join(root, "var/lib/tailscale"), { recursive: true });
  writeFileSync(join(root, "var/lib/tailscale/tailscaled.state"), '{"_machinekey":"x"}');
  mkdirSync(join(root, "etc/ssh"), { recursive: true });
  hostKey(root, "ed25519");
  hostKey(root, "ecdsa");
  writeFileSync(join(root, "etc/machine-id"), "b5bdde36761149f39ded9c32f34f25ef\n");
}

function guest(nics: readonly Nic[]): string {
  const root = tempDir("identity");
  setNics(root, nics);
  seedIdentity(root);
  return root;
}

function identity(root: string, args: readonly string[], options: { readonly waitSeconds?: number } = {}) {
  const ran = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: process.env.PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: String(options.waitSeconds ?? 0) },
    encoding: "utf8",
  });
  return { code: ran.status, out: ran.stdout, err: ran.stderr };
}

function boot(root: string, value?: string) {
  return identity(root, value === undefined ? ["boot"] : ["boot", "--value", value]);
}

function read(root: string, path: string): string | null {
  return existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null;
}

function identityOf(root: string) {
  return {
    auth: read(root, `${BB_FOLDER}/auth.json`),
    config: read(root, `${BB_FOLDER}/config.json`),
    hostId: read(root, `${BB_FOLDER}/host-id`),
    daemonUnit: existsSync(join(root, USER_UNITS, DAEMON_UNIT)),
    daemonWanted: existsSync(join(root, USER_UNITS, "default.target.wants", DAEMON_UNIT)),
    access: read(root, "home/box/.config/bb-box/env"),
    tailnet: readdirSync(join(root, "var/lib/tailscale")).length,
    ed25519: read(root, "etc/ssh/ssh_host_ed25519_key.pub"),
    ecdsa: read(root, "etc/ssh/ssh_host_ecdsa_key.pub"),
    machineId: read(root, "etc/machine-id"),
  };
}

function status(root: string): Record<string, string> {
  const ran = identity(root, ["status"]);
  assert.equal(ran.code, 0, ran.err);
  return Object.fromEntries(ran.out.trim().split("\n").map((line) => line.split("=", 2) as [string, string]));
}

function written(root: string, box: string, source: string) {
  const ran = identity(root, ["write", "--box", box, "--source", source]);
  assert.equal(ran.code, 0, ran.err);
  return ran.out;
}

function assertReset(root: string, before: ReturnType<typeof identityOf>): void {
  const after = identityOf(root);
  assert.equal(after.auth, null, "BB's machine credentials are gone");
  assert.equal(after.config, null);
  assert.equal(after.hostId, null, "BB's host ID is gone, so the box enrols as a new machine");
  assert.equal(after.daemonUnit, false, "BB's daemon unit for the old host ID is gone");
  assert.equal(after.daemonWanted, false);
  assert.equal(after.access, null, "the thread's access file is gone");
  assert.equal(after.tailnet, 0, "the tailnet node's state is gone");
  assert.ok(after.ed25519 && after.ed25519 !== before.ed25519, "a new ed25519 host key");
  assert.ok(after.ecdsa && after.ecdsa !== before.ecdsa, "a new ECDSA host key");
  assert.match(after.machineId ?? "", /^[0-9a-f]{32}\n$/);
  assert.notEqual(after.machineId, before.machineId, "a new machine ID");
  assert.equal(read(root, WORKTREE_FILE), "the thread's work", "the thread's files stay");
  assert.equal(read(root, `${BB_FOLDER}/host-artifact.sha256`), "0123abcd\n", "BB's installed app stays");
  assert.ok(existsSync(join(root, BB_FOLDER, "npm/lib/node_modules/bb-app")));
  assert.equal(existsSync(join(root, BB_FOLDER, "logs")), false);
  assert.equal(read(root, "home/box/.config/bb-box/access-a17e70a62012"), "");
}

test("a box made before the change, with the reset in its image but no marker, keeps its identity at every boot", () => {
  const root = guest([LOOP, LXC_ETH0]);
  const before = identityOf(root);
  for (let restart = 0; restart < 3; restart++) {
    const ran = boot(root);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /kept: bb-box has written no identity marker here/);
  }
  assert.deepEqual(identityOf(root), before);
  assert.deepEqual(status(root), { version: "1", boot: "unarmed", marker: "missing", armed: "no", box: "", source: "" });
});

test("on Proxmox LXC the marker holds the eth interfaces only, and a box with Docker's and Tailscale's own interfaces keeps its identity at each restart", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  assert.equal(written(root, "bxsource1", "eth"), "bb-box identity 1\nbox bxsource1\nsource eth\nmac bc:24:11:aa:f1:b6\n");
  assert.equal(read(root, "var/lib/bb-box/identity-armed"), "bxsource1\n");
  setNics(root, [LOOP, LXC_ETH0, ...BOX_MADE]);
  const before = identityOf(root);
  for (let restart = 0; restart < 3; restart++) {
    const ran = boot(root);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /kept: the identity marker of box bxsource1 matches/);
  }
  assert.deepEqual(identityOf(root), before);
  assert.deepEqual(status(root), { version: "1", boot: "kept", marker: "matches", armed: "yes", box: "bxsource1", source: "eth" });
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
});

test("a copy with new MAC addresses, as any Proxmox clone gets, resets every item of section 9's table once, and keeps the rest of its disk", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  const before = identityOf(root);
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  const ran = boot(root);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /this box is a copy, so it resets its identity: the MAC addresses of its eth interfaces \(bc:24:11:5e:77:01\) are not the marker's \(bc:24:11:aa:f1:b6\)/);
  assertReset(root, before);
  assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource eth\nmac bc:24:11:5e:77:01\nreset \d{4}-\d\d-\d\dT[\d:]+Z\n$/);
  assert.match(read(root, "var/lib/bb-box/identity-resets") ?? "", /Z the MAC addresses of its eth interfaces .*; BB machines removed: host_source\n$/);
  assert.deepEqual(status(root), { version: "1", boot: "reset", marker: "matches", armed: "yes", box: "", source: "eth" });
  const once = identityOf(root);
  assert.match(boot(root).out, /kept: the identity marker of box none matches/);
  assert.deepEqual(identityOf(root), once, "the next boot does not reset again");
});

test("on a VM the backend's interfaces are those with a device; a bridge and Docker's are ignored, and a new network card resets", () => {
  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  const root = guest([LOOP, ens18]);
  boot(root);
  assert.equal(written(root, "bxvm1", "device"), "bb-box identity 1\nbox bxvm1\nsource device\nmac bc:24:11:00:00:18\n");
  setNics(root, [LOOP, ens18, ...BOX_MADE, { name: "br0", mac: "bc:24:11:00:00:18" }]);
  assert.match(boot(root).out, /kept/);
  const before = identityOf(root);
  setNics(root, [LOOP, { ...ens18, mac: "bc:24:11:00:00:99" }]);
  assert.match(boot(root).out, /resets its identity: the MAC addresses of its device interfaces \(bc:24:11:00:00:99\)/);
  assertReset(root, before);
});

test("a VM's network card that appears late in its boot is waited for; one that never appears resets after the wait", async () => {
  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  const root = guest([LOOP, ens18]);
  boot(root);
  written(root, "bxvm1", "device");
  setNics(root, [LOOP]);
  const started = Date.now();
  const late = spawn("bash", [SCRIPT, "boot"], { env: { PATH: process.env.PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: "20" } });
  let out = "";
  late.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  setTimeout(() => setNics(root, [LOOP, ens18]), 600);
  const code = await new Promise<number | null>((resolve) => late.on("close", resolve));
  assert.equal(code, 0);
  assert.match(out, /kept/);
  assert.ok(Date.now() - started < 10_000, "it went on once the card was there");
  setNics(root, [LOOP]);
  const gone = identity(root, ["boot"], { waitSeconds: 1 });
  assert.match(gone.out, /resets its identity: the MAC addresses of its device interfaces \(none\)/);
});

test("a marker missing on a box that had one, or unreadable, resets: failing closed", () => {
  for (const spoil of ["remove", "header", "mac", "source"] as const) {
    const root = guest([LOOP, LXC_ETH0]);
    boot(root);
    written(root, "bxsource1", "eth");
    const before = identityOf(root);
    const marker = join(root, "etc/bb-box/identity");
    if (spoil === "remove") rmSync(marker);
    if (spoil === "header") writeFileSync(marker, "bb-box identity 9\nsource eth\nmac bc:24:11:aa:f1:b6\n");
    if (spoil === "mac") writeFileSync(marker, "bb-box identity 1\nsource eth\nmac not-a-mac\n");
    if (spoil === "source") writeFileSync(marker, "bb-box identity 1\nsource wifi\nmac bc:24:11:aa:f1:b6\n");
    const ran = boot(root);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /resets its identity: its identity marker is missing or unreadable/, spoil);
    assertReset(root, before);
    assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource eth\nmac bc:24:11:aa:f1:b6\nreset /, `${spoil}: the copy's own marker, so the next boot keeps`);
  }
});

test("a marker whose last line has no newline is still read", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  mkdirSync(join(root, "etc/bb-box"), { recursive: true });
  mkdirSync(join(root, "var/lib/bb-box"), { recursive: true });
  writeFileSync(join(root, "etc/bb-box/identity"), "bb-box identity 1\nbox bxsource1\nsource eth\nmac bc:24:11:aa:f1:b6");
  writeFileSync(join(root, "var/lib/bb-box/identity-armed"), "bxsource1\n");
  assert.match(boot(root).out, /kept: the identity marker of box bxsource1 matches/);
});

test("a box of Docker's image compares the value bb-box set on its guest, which its start passes, not its interfaces", () => {
  const root = guest([LOOP, { name: "eth0", mac: "02:42:ac:11:00:02" }]);
  assert.match(boot(root, "bxdock1").out, /no identity marker/);
  assert.equal(written(root, "bxdock1", "value"), "bb-box identity 1\nbox bxdock1\nsource value\nvalue bxdock1\n");
  setNics(root, [LOOP, { name: "eth0", mac: "02:42:ac:11:00:07" }]);
  for (let restart = 0; restart < 3; restart++) assert.match(boot(root, "bxdock1").out, /kept/, "Docker gave it a new MAC address at the restart");
  const before = identityOf(root);
  assert.match(boot(root, "bxdock2").out, /resets its identity: the value bb-box set on this guest is not the marker's/);
  assertReset(root, before);
  assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource value\nvalue bxdock2\nreset /);
  assert.match(boot(root, "bxdock2").out, /kept/);
  assert.match(boot(root, "").out, /resets its identity: the value bb-box set on this guest is not the marker's/, "a guest bb-box set no value on is a copy too");
  assert.equal(read(root, "etc/bb-box/identity"), null);
  assert.match(boot(root, "").out, /resets its identity: its identity marker is missing or unreadable/, "with no value to write, each boot resets again");
});

test("write refuses a marker that would not match at the next boot, and names its fault", () => {
  const root = guest([LOOP, { name: "eth0", mac: "02:42:ac:11:00:02" }]);
  boot(root);
  const noValue = identity(root, ["write", "--box", "bxdock1", "--source", "value"]);
  assert.equal(noValue.code, 3);
  assert.match(noValue.err, /this boot saw no value from bb-box/);
  const vm = identity(root, ["write", "--box", "bxdock1", "--source", "device"]);
  assert.equal(vm.code, 3);
  assert.match(vm.err, /found none of this box's device interfaces/);
  assert.equal(identity(root, ["write", "--box", "BX/1", "--source", "eth"]).code, 2);
  assert.equal(identity(root, ["write", "--box", "bxdock1", "--source", "wifi"]).code, 2);
  assert.equal(identity(root, ["write", "--box", "bxdock1", "--source"]).code, 2, "an option with no value is refused, not looped on");
  assert.equal(existsSync(join(root, "etc/bb-box/identity")), false);
  assert.equal(existsSync(join(root, "var/lib/bb-box/identity-armed")), false);
});

test("a reset that cannot finish fails the boot, so the network and identity services stay off", { skip: process.getuid?.() === 0 ? "root can remove what the test protects" : false }, () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  chmodSync(join(root, "var/lib/tailscale"), 0o555);
  try {
    const ran = boot(root);
    assert.equal(ran.code, 1);
    assert.match(ran.out, /could not remove the tailnet node's state/);
    assert.match(ran.out, /the reset failed, so the network, SSH, Tailscale and the box user's services stay off/);
    assert.equal(status(root).boot, "failed");
  } finally {
    chmodSync(join(root, "var/lib/tailscale"), 0o755);
  }
});

test("forkSafe is the reset's version only when this boot's check ran and the marker is the box's own", () => {
  const status = (lines: string) => forkSafeVersion(parseIdentityStatus(lines));
  assert.equal(status("version=1\nboot=kept\nmarker=matches\narmed=yes\nbox=bx1\nsource=eth\n"), 1);
  assert.equal(status("version=1\nboot=unarmed\nmarker=matches\narmed=yes\nbox=bx1\nsource=eth\n"), 1, "written by bb-box after this boot's check");
  assert.equal(status("version=2\nboot=reset\nmarker=matches\narmed=yes\nbox=\nsource=device\n"), 2);
  assert.equal(status("version=1\nboot=none\nmarker=matches\narmed=yes\nbox=bx1\nsource=eth\n"), null, "the boot check did not run: the unit is not wired");
  assert.equal(status("version=1\nboot=failed\nmarker=matches\narmed=yes\n"), null);
  assert.equal(status("version=1\nboot=kept\nmarker=missing\narmed=no\n"), null);
  assert.equal(status("version=1\nboot=kept\nmarker=differs\narmed=yes\n"), null);
  assert.equal(status("version=1\nboot=kept\nmarker=unreadable\narmed=yes\n"), null);
  assert.equal(status("version=1\nboot=kept\nmarker=matches\narmed=no\n"), null);
  assert.equal(status(""), null);
  assert.equal(status("version=x\nboot=kept\nmarker=matches\narmed=yes\n"), null);
});

test("every Linux image orders the check before the network and identity services, requires it of them, and clears the marker when it is finalized", () => {
  const base = readFileSync(CUSTOMIZE_BASE, "utf8");
  const unit = /cat >\/etc\/systemd\/system\/bb-box-identity\.service <<'EOF'\n([\s\S]*?)\nEOF/.exec(base)?.[1] ?? "";
  assert.match(unit, /^DefaultDependencies=no$/m);
  const before = /^Before=(.*)$/m.exec(unit)?.[1]?.split(" ") ?? [];
  for (const unitName of ["network-pre.target", "systemd-networkd.service", "ssh.service", "tailscaled.service"]) assert.ok(before.includes(unitName), unitName);
  assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/bb-box-identity boot$/m);
  assert.match(base, /for unit in systemd-networkd\.service NetworkManager\.service ssh\.service ssh\.socket tailscaled\.service user@\.service; do/);
  assert.match(base, /Requires=bb-box-identity\.service\\nAfter=bb-box-identity\.service/);
  assert.match(base, /install -m 0755 "\$build\/guest\/bb-box-identity\.sh" \/usr\/local\/sbin\/bb-box-identity/);
  assert.match(readFileSync(FINALIZE, "utf8"), /rm -f \/etc\/bb-box\/identity .*\/var\/lib\/bb-box\/identity-armed/);
  const start = readFileSync(DOCKER_START, "utf8");
  const check = start.indexOf('bb-box-identity boot --value "${BBBOX_IDENTITY:-}"');
  assert.ok(check > 0 && check < start.indexOf("rm -f \"$home\"/.bb-machines/*/daemon.lock.lock") && check < start.indexOf(`touch "$run/ready"`), "a Docker box checks before it starts anything");
});
