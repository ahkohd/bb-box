import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { forkSafeVersion, parseIdentityStatus } from "../src/core/identity.ts";
import { buildEnvFor } from "../src/backends/boat/templates.ts";
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
  readonly kind?: string;
  readonly netnsid?: number;
  readonly master?: string;
  readonly index?: number;
  readonly linkIndex?: number;
}

const LXC_ETH0: Nic = { name: "eth0", mac: "BC:24:11:AA:F1:B6" };
const LOOP: Nic = { name: "lo", mac: "00:00:00:00:00:00", type: LOOPBACK };
const BOX_MADE: readonly Nic[] = [
  { name: "docker0", mac: "02:42:ac:11:00:01", kind: "bridge" },
  { name: "br-0f1e2d3c4b5a", mac: "02:42:9c:01:02:03", kind: "bridge" },
  { name: "veth1a2b3c4", mac: "6a:01:02:03:04:05", kind: "veth", netnsid: 1, master: "br-0f1e2d3c4b5a" },
  { name: "tailscale0", mac: "00:00:00:00:00:00", type: NONE, kind: "tun" },
];
const FAKE_IP = tempDir("fake-ip");
writeFileSync(join(FAKE_IP, "ip"), '#!/bin/sh\nexec cat "$BBBOX_IDENTITY_ROOT/ip-link.json"\n', { mode: 0o755 });
const TEST_PATH = `${FAKE_IP}:${process.env.PATH}`;

function linkInfo(nic: Nic, at: number): Record<string, unknown> {
  const type = nic.type ?? ETHER;
  const lxcCard = !nic.device && type === ETHER && nic.kind === undefined;
  const kind = lxcCard ? "veth" : nic.kind;
  const netnsid = lxcCard ? 0 : nic.netnsid;
  return {
    ifindex: nic.index ?? at + 1,
    ...(nic.linkIndex === undefined ? {} : { link_index: nic.linkIndex }),
    ifname: nic.name,
    link_type: type === ETHER ? "ether" : type === LOOPBACK ? "loopback" : "none",
    address: nic.mac,
    ...(netnsid === undefined ? {} : { link_netnsid: netnsid }),
    ...(nic.master === undefined ? {} : { master: nic.master }),
    ...(kind === undefined ? {} : { linkinfo: { info_kind: kind } }),
  };
}

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
  writeFileSync(join(root, "ip-link.json"), JSON.stringify(nics.map(linkInfo)));
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
  writeFileSync(join(root, "etc/ssh/sshd_config"), "Include /etc/ssh/sshd_config.d/*.conf\n");
  hostKey(root, "ed25519");
  hostKey(root, "ecdsa");
  writeFileSync(join(root, "etc/machine-id"), "b5bdde36761149f39ded9c32f34f25ef\n");
}

function identity(root: string, args: readonly string[], options: { readonly waitSeconds?: number; readonly path?: string } = {}) {
  const ran = spawnSync("bash", [SCRIPT, ...args], {
    env: { PATH: options.path ?? TEST_PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: String(options.waitSeconds ?? 0) },
    encoding: "utf8",
  });
  return { code: ran.status, out: ran.stdout, err: ran.stderr };
}

function guest(nics: readonly Nic[], options: { readonly on?: boolean } = {}): string {
  const root = tempDir("identity");
  setNics(root, nics);
  seedIdentity(root);
  if (options.on !== false) assert.equal(identity(root, ["enable"]).code, 0);
  return root;
}

function boot(root: string, value?: string, options: { readonly path?: string } = {}) {
  return identity(root, value === undefined ? ["boot"] : ["boot", "--value", value], options);
}

function failingSshKeygen(): string {
  const bin = tempDir("failing-bin");
  writeFileSync(join(bin, "ssh-keygen"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  return `${bin}:${TEST_PATH}`;
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

test("a desktop copy drops only host-bound session locks, keeps its profile, keyring and desktop setup, and a same-box restart changes none of them", () => {
  for (const source of ["eth", "device", "value"] as const) {
    const nic = { ...LXC_ETH0, ...(source === "device" ? { device: true } : {}) };
    const root = guest([LOOP, nic]);
    const kept = [
      "home/box/.config/google-chrome/Local State",
      "home/box/.config/google-chrome/Default/Preferences",
      "home/box/.config/google-chrome/Default/Cookies",
      "home/box/.local/share/keyrings/login.keyring",
      "home/box/.cache/sessions/xfce4-session-source:99",
      "etc/bb-box/sway.conf",
      "usr/local/libexec/bb-box/display",
      "usr/local/libexec/bb-box/selkies",
      "usr/local/bin/cua-driver",
    ];
    const locks = [
      "home/box/.config/google-chrome/SingletonLock",
      "home/box/.config/google-chrome/SingletonSocket",
      "home/box/.config/google-chrome/SingletonCookie",
      "home/box/.dbus/session-bus/copied-machine-id-99",
      "home/box/.cache/cua-driver/cua-driver.sock",
    ];
    for (const path of [...kept, ...locks]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), path, { mode: 0o755 });
    }
    boot(root, source === "value" ? "bxsource1" : undefined);
    written(root, "bxsource1", source);
    assert.equal(boot(root, source === "value" ? "bxsource1" : undefined).code, 0);
    for (const path of [...kept, ...locks]) assert.equal(read(root, path), path, `same box: ${path}`);
    const before = identityOf(root);
    setNics(root, [LOOP, { ...nic, mac: "bc:24:11:00:00:99" }]);
    assert.equal(boot(root, source === "value" ? "bxfork1" : undefined).code, 0);
    assertReset(root, before);
    for (const path of locks) assert.equal(read(root, path), null, `copy: ${path}`);
    for (const path of kept) assert.equal(read(root, path), path, `copy: ${path}`);
    assert.equal(status(root).boot, "reset");
  }
});

test("a box made before the change, with the reset in its image but no marker, keeps its identity at every boot", () => {
  const root = guest([LOOP, LXC_ETH0]);
  const before = identityOf(root);
  for (let restart = 0; restart < 3; restart++) {
    const ran = boot(root);
    assert.equal(ran.code, 0, ran.err);
    assert.match(ran.out, /kept: bb-box has written no identity marker here/);
  }
  assert.deepEqual(identityOf(root), before);
  assert.deepEqual(status(root), { version: "9", enabled: "yes", boot: "unarmed", marker: "missing", armed: "no", pending: "no", box: "", source: "" });
});

test("in an image where the reset is off, a boot does nothing and BB Box can write no marker", () => {
  const root = guest([LOOP, LXC_ETH0], { on: false });
  const before = identityOf(root);
  assert.match(boot(root).out, /the identity reset is off in this image/);
  const refused = identity(root, ["write", "--box", "bxsource1", "--source", "eth"]);
  assert.equal(refused.code, 3);
  assert.match(refused.err, /off in this image, so bb-box writes no marker/);
  assert.equal(existsSync(join(root, "etc/bb-box/identity")), false);
  assert.deepEqual(identityOf(root), before);
  assert.equal(status(root).enabled, "no");
  assert.equal(status(root).boot, "off");
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
  assert.deepEqual(status(root), { version: "9", enabled: "yes", boot: "kept", marker: "matches", armed: "yes", pending: "no", box: "bxsource1", source: "eth" });
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
});

test("a box that is not a copy keeps its identity when a card is added or one of two is removed, at every boot; a card renamed from eth is no card, so the box is held, removing nothing", () => {
  const added = guest([LOOP, LXC_ETH0]);
  boot(added);
  written(added, "bxsource1", "eth");
  setNics(added, [LOOP, LXC_ETH0, { name: "eth1", mac: "bc:24:11:00:00:11" }]);
  const before = identityOf(added);
  assert.match(boot(added).out, /kept/, "pct set --net1");
  assert.deepEqual(identityOf(added), before);

  const removed = guest([LOOP, LXC_ETH0, { name: "eth1", mac: "bc:24:11:00:00:11" }]);
  boot(removed);
  written(removed, "bxsource2", "eth");
  setNics(removed, [LOOP, { name: "eth1", mac: "bc:24:11:00:00:11" }]);
  assert.match(boot(removed).out, /kept/, "net0 removed, net1 kept");

  const renamed = guest([LOOP, LXC_ETH0]);
  boot(renamed);
  written(renamed, "bxsource3", "eth");
  setNics(renamed, [LOOP, { name: "lan0", mac: LXC_ETH0.mac }]);
  const unchanged = identityOf(renamed);
  for (let restart = 0; restart < 3; restart++) assert.match(boot(renamed).out, /not knowing yet whether this box is a copy/, "name=lan0");
  assert.deepEqual(identityOf(renamed), unchanged);

  const vm = guest([LOOP, { name: "ens18", mac: "bc:24:11:00:00:18", device: true }]);
  boot(vm);
  written(vm, "bxvm1", "device");
  setNics(vm, [LOOP, { name: "ens18", mac: "bc:24:11:00:00:18", device: true }, { name: "ens19", mac: "bc:24:11:00:00:19", device: true }]);
  assert.match(boot(vm).out, /kept/, "qm set --net1");
  assert.equal(read(added, "var/lib/bb-box/identity-resets"), null);
});

test("a copy with new MAC addresses, as any Proxmox clone gets, resets every item of section 9's table once, and keeps the rest of its disk", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  const before = identityOf(root);
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  const ran = boot(root);
  assert.equal(ran.code, 0, ran.err);
  assert.match(ran.out, /this box is a copy, so it resets its identity: none of the marker's MAC addresses \(bc:24:11:aa:f1:b6\) is on this box's interfaces \(bc:24:11:5e:77:01\)/);
  assertReset(root, before);
  assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource eth\nmac bc:24:11:5e:77:01\nreset \d{4}-\d\d-\d\dT[\d:]+Z\n$/);
  assert.match(read(root, "var/lib/bb-box/identity-resets") ?? "", /Z none of the marker's MAC addresses .*; BB machines removed: host_source\n$/);
  assert.equal(existsSync(join(root, "var/lib/bb-box/identity-reset-pending")), false);
  assert.deepEqual(status(root), { version: "9", enabled: "yes", boot: "reset", marker: "matches", armed: "yes", pending: "no", box: "", source: "eth" });
  const once = identityOf(root);
  assert.match(boot(root).out, /kept: the identity marker of box none matches/);
  assert.deepEqual(identityOf(root), once, "the next boot does not reset again");
});

test("only a new card of the backend's shows a copy: one whose card has no eth name is held, removing nothing; one whose marker is gone and has no eth card resets, then unarms itself", () => {
  const renamed = guest([LOOP, LXC_ETH0]);
  boot(renamed);
  written(renamed, "bxsource1", "eth");
  setNics(renamed, [LOOP, { name: "lan0", mac: "bc:24:11:5e:77:01" }]);
  const kept = identityOf(renamed);
  const held = boot(renamed);
  assert.equal(held.code, 0, held.err);
  assert.match(held.out, /not knowing yet whether this box is a copy/);
  assert.deepEqual(identityOf(renamed), kept);
  assert.equal(status(renamed).boot, "unknown");

  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource2", "eth");
  rmSync(join(root, "etc/bb-box/identity"));
  setNics(root, [LOOP, { name: "lan0", mac: "bc:24:11:5e:77:01" }]);
  const ran = boot(root);
  assert.match(ran.out, /resets its identity: its identity marker is missing or unreadable/);
  assert.match(ran.out, /found no interface of the backend's to write a marker for, so it unarms this box/);
  assert.equal(existsSync(join(root, "etc/bb-box/identity")), false);
  assert.equal(existsSync(join(root, "var/lib/bb-box/identity-armed")), false);
  assert.match(boot(root).out, /kept: bb-box has written no identity marker here/);
});

test("on a VM the backend's interfaces are those with a device, and a VM whose cards are all new resets", () => {
  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  const root = guest([LOOP, ens18]);
  boot(root);
  assert.equal(written(root, "bxvm1", "device"), "bb-box identity 1\nbox bxvm1\nsource device\nmac bc:24:11:00:00:18\n");
  setNics(root, [LOOP, ens18, ...BOX_MADE, { name: "br0", mac: "bc:24:11:00:00:18" }]);
  assert.match(boot(root).out, /kept/);
  const before = identityOf(root);
  setNics(root, [LOOP, { ...ens18, mac: "bc:24:11:00:00:99" }, { name: "docker0", mac: "02:42:ac:11:00:01" }]);
  assert.match(boot(root).out, /resets its identity: none of the marker's MAC addresses \(bc:24:11:00:00:18\)/);
  assertReset(root, before);
});

test("a card that appears late is waited for; with none of the marker's cards and no new one the box boots as it is, not knowing, and resets nothing", async () => {
  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  const root = guest([LOOP, ens18]);
  boot(root);
  written(root, "bxvm1", "device");
  setNics(root, [LOOP]);
  const late = spawn("bash", [SCRIPT, "boot"], { env: { PATH: TEST_PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: "20" } });
  let out = "";
  late.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  setTimeout(() => setNics(root, [LOOP, ens18]), 600);
  assert.equal(await new Promise<number | null>((resolve) => late.on("close", resolve)), 0);
  assert.match(out, /kept/);
  setNics(root, [LOOP]);
  const before = identityOf(root);
  const absent = identity(root, ["boot"], { waitSeconds: 1 });
  assert.equal(absent.code, 0);
  assert.match(absent.out, /not knowing yet whether this box is a copy: after waiting about 1 s it found none of the marker's MAC addresses \(bc:24:11:00:00:18\) and no new one/);
  assert.deepEqual(identityOf(root), before, "never erases credentials on unknown");
  assert.equal(status(root).boot, "unknown");
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
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
    assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource eth\nmac bc:24:11:aa:f1:b6\nreset /, `${spoil}: the box's own marker, so the next boot keeps`);
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

test("a reset records what it removes, with the original host IDs, before it removes anything, and the next boot resumes one that failed part way", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  const failed = boot(root, undefined, { path: failingSshKeygen() });
  assert.equal(failed.code, 1);
  assert.match(failed.out, /could not make new SSH host keys/);
  assert.match(failed.out, /the reset failed, so the network, SSH, Tailscale, Docker, the desktop and the box user's services stay off; the next boot resumes it/);
  assert.match(read(root, "var/lib/bb-box/identity-reset-pending") ?? "", /Z none of the marker's MAC addresses .*; BB machines removed: host_source\n$/);
  assert.equal(read(root, `${BB_FOLDER}/host-id`), null, "BB's credentials went before the step that failed");
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null, "not done, so no receipt");
  assert.equal(status(root).pending, "yes");
  assert.equal(identity(root, ["write", "--box", "bxsource1", "--source", "eth"]).code, 3, "BB Box writes no marker while a reset is unfinished");
  const resumed = boot(root);
  assert.equal(resumed.code, 0, resumed.err);
  assert.match(resumed.out, /resuming the reset that began at /);
  assert.match(read(root, "var/lib/bb-box/identity-resets") ?? "", /; BB machines removed: host_source\n$/, "the original host ID, not none");
  assert.ok(read(root, "etc/ssh/ssh_host_ed25519_key.pub") && read(root, "etc/ssh/ssh_host_ecdsa_key.pub"), "host keys made again, though the failed attempt had removed them");
  assert.equal(existsSync(join(root, "var/lib/bb-box/identity-reset-pending")), false);
  assert.equal(status(root).boot, "reset");
});

test("a reset whose receipt cannot be written fails the boot, and the next boot finishes it", () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  mkdirSync(join(root, "var/lib/bb-box/identity-resets"));
  const failed = boot(root);
  assert.equal(failed.code, 1);
  assert.match(failed.out, /could not record the reset in .*identity-resets/);
  assert.equal(status(root).boot, "failed");
  assert.match(read(root, "var/lib/bb-box/identity-reset-pending") ?? "", /BB machines removed: host_source/);
  rmSync(join(root, "var/lib/bb-box/identity-resets"), { recursive: true });
  assert.equal(boot(root).code, 0);
  assert.match(read(root, "var/lib/bb-box/identity-resets") ?? "", /BB machines removed: host_source\n$/);
});

test("a reset removes root's BB machines and daemon units too, set aside or not", () => {
  const root = guest([LOOP, LXC_ETH0]);
  mkdirSync(join(root, "root/.bb-machines/.set-aside/old"), { recursive: true });
  writeFileSync(join(root, "root/.bb-machines/.set-aside/old/auth.json"), "{}");
  writeFileSync(join(root, "root/.bb-machines/.set-aside/old/host-id"), "host_root\n");
  mkdirSync(join(root, "root/.config/systemd/user/default.target.wants"), { recursive: true });
  writeFileSync(join(root, "root/.config/systemd/user/bb-host-daemon-x-host_root.service"), "[Service]\n");
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  assert.equal(boot(root).code, 0);
  assert.equal(existsSync(join(root, "root/.bb-machines/.set-aside/old/auth.json")), false);
  assert.equal(existsSync(join(root, "root/.config/systemd/user/bb-host-daemon-x-host_root.service")), false);
  assert.match(read(root, "var/lib/bb-box/identity-resets") ?? "", /BB machines removed: host_root host_source\n$/);
});

test("a box of Docker's image compares the value BB Box set on its guest, which its start passes, not its interfaces", () => {
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
  const none = boot(root, "");
  assert.match(none.out, /resets its identity: the value bb-box set on this guest is not the marker's/, "a guest BB Box set no value on is a copy too");
  assert.match(none.out, /unarms this box/);
  assert.match(boot(root, "").out, /kept: bb-box has written no identity marker here/, "unarmed, it does not reset again");
});

test("write refuses a marker that would not match at the next boot, and names its fault; unarm removes the marker", () => {
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
  written(root, "bxdock1", "eth");
  assert.equal(identity(root, ["unarm"]).code, 0);
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
    assert.equal(status(root).boot, "failed");
  } finally {
    chmodSync(join(root, "var/lib/tailscale"), 0o755);
  }
});

test("forkSafe is the reset's version only when it is on, this boot's check ran, no reset is unfinished and the marker is the box's own", () => {
  const status = (lines: string) => forkSafeVersion(parseIdentityStatus(lines));
  const on = "version=2\nenabled=yes\npending=no\n";
  assert.equal(status(`${on}boot=kept\nmarker=matches\narmed=yes\nbox=bx1\nsource=eth\n`), 2);
  assert.equal(status(`${on}boot=unarmed\nmarker=matches\narmed=yes\nbox=bx1\nsource=eth\n`), 2, "written by BB Box after this boot's check");
  assert.equal(status(`${on}boot=reset\nmarker=matches\narmed=yes\nbox=\nsource=device\n`), 2);
  assert.equal(status(`${on}boot=unknown\nmarker=matches\narmed=yes\n`), null, "a boot that could not tell");
  assert.equal(status(`${on}boot=none\nmarker=matches\narmed=yes\n`), null, "the boot check did not run: the unit is not wired");
  assert.equal(status(`${on}boot=failed\nmarker=matches\narmed=yes\n`), null);
  assert.equal(status(`${on}boot=kept\nmarker=missing\narmed=no\n`), null);
  assert.equal(status(`${on}boot=kept\nmarker=differs\narmed=yes\n`), null);
  assert.equal(status(`${on}boot=kept\nmarker=incomplete\narmed=yes\n`), null);
  assert.equal(status(`${on}boot=kept\nmarker=matches\narmed=no\n`), null);
  assert.equal(status("version=2\nenabled=no\npending=no\nboot=kept\nmarker=matches\narmed=yes\n"), null, "off in this image");
  assert.equal(status("version=2\nenabled=yes\npending=yes\nboot=kept\nmarker=matches\narmed=yes\n"), null, "a reset unfinished");
  assert.equal(status(""), null);
});

test("enable writes the unit before the network and identity services, and requires it of them, Docker's and the desktop's; disable removes it all", () => {
  const root = tempDir("identity-units");
  assert.equal(identity(root, ["enable"]).code, 0);
  const unit = read(root, "etc/systemd/system/bb-box-identity.service") ?? "";
  assert.match(unit, /^DefaultDependencies=no$/m);
  const before = /^Before=(.*)$/m.exec(unit)?.[1]?.split(" ") ?? [];
  for (const unitName of ["network-pre.target", "systemd-networkd.service", "ssh.service", "tailscaled.service", "docker.service", "containerd.service", "bb-box-display.service"]) assert.ok(before.includes(unitName), unitName);
  assert.match(unit, /^ExecStart=\/usr\/local\/sbin\/bb-box-identity boot$/m);
  for (const gated of ["systemd-networkd.service", "docker.service", "docker.socket", "containerd.service", "bb-box-docker-containers.service"]) {
    assert.equal(read(root, `etc/systemd/system/${gated}.d/10-bb-box-identity.conf`), "[Unit]\nRequires=bb-box-identity.service\nAfter=bb-box-identity.service\n", gated);
  }
  for (const user of ["ssh.service", "tailscaled.service", "user@.service", "bb-box-display.service", "bb-box-session.service", "bb-box-vnc.service", "bb-box-vnc-password.service", "bb-box-selkies.service"]) {
    assert.equal(read(root, `etc/systemd/system/${user}.d/10-bb-box-identity.conf`), "[Unit]\nRequires=bb-box-identity.service bb-box-identity-settle.service\nAfter=bb-box-identity.service bb-box-identity-settle.service\n", user);
  }
  const settleUnit = read(root, "etc/systemd/system/bb-box-identity-settle.service") ?? "";
  assert.match(settleUnit, /^Before=ssh\.service tailscaled\.service bb-box-display\.service bb-box-session\.service bb-box-vnc\.service bb-box-vnc-password\.service bb-box-selkies\.service shutdown\.target$/m);
  assert.match(settleUnit, /^After=bb-box-identity\.service$/m);
  assert.match(settleUnit, /^TimeoutStartSec=infinity$/m);
  assert.ok(existsSync(join(root, "etc/systemd/system/multi-user.target.wants/bb-box-identity-settle.service")));
  assert.equal(read(root, "etc/systemd/user/bb-host-daemon-.service.d/10-bb-box-identity.conf"), "[Service]\nExecStartPre=/usr/local/sbin/bb-box-identity wait %n\nTimeoutStartSec=infinity\n", "BB's daemon, a user unit, waits too");
  assert.ok(existsSync(join(root, "etc/systemd/system/multi-user.target.wants/bb-box-identity.service")));
  assert.equal(read(root, "usr/local/lib/bb-box/identity-reset-on"), "on\n");
  assert.equal(identity(root, ["disable"]).code, 0);
  assert.equal(existsSync(join(root, "etc/systemd/system/bb-box-identity.service")), false);
  assert.equal(existsSync(join(root, "etc/systemd/system/ssh.service.d")), false);
  assert.equal(existsSync(join(root, "etc/systemd/system/bb-box-identity-settle.service")), false);
  assert.equal(existsSync(join(root, "etc/systemd/user/bb-host-daemon-.service.d")), false);
  assert.equal(existsSync(join(root, "usr/local/lib/bb-box/identity-reset-on")), false);
  const docker = tempDir("identity-docker");
  assert.equal(identity(docker, ["enable", "--no-unit"]).code, 0);
  assert.equal(existsSync(join(docker, "etc/systemd/system/bb-box-identity.service")), false);
  assert.equal(read(docker, "usr/local/lib/bb-box/identity-reset-on"), "on\n");
});

test("every Linux build turns the reset on, including desktops; finalizing clears what a box wrote", () => {
  const base = readFileSync(CUSTOMIZE_BASE, "utf8");
  assert.match(base, /install -m 0755 "\$build\/guest\/bb-box-identity\.sh" \/usr\/local\/sbin\/bb-box-identity\n\/usr\/local\/sbin\/bb-box-identity disable\nif \[ "\$\{BOX_IDENTITY_RESET:-off\}" = on \]; then/);
  const on = (file: string) => readFileSync(fileURLToPath(new URL(`../setup/${file}`, import.meta.url)), "utf8");
  for (const build of ["proxmox-lxc/template/build.sh", "docker/customize.sh"]) {
    assert.match(on(build), /^BOX_IDENTITY_RESET=on$/m, build);
  }
  assert.match(on("proxmox-qemu/build-linux.sh"), /BOX_IDENTITY_RESET=\$\(\[ "\$kind" != android \] && echo on \|\| echo off\)/);
  const tart = on("tart/prepare-linux-image.sh");
  assert.match(tart, /kind=linux-arm64 artifacts=linux finalize=linux identity_reset=on\n/);
  assert.match(tart, /kind=linux-arm64-desktop-cpu artifacts=desktop-cpu finalize=desktop identity_reset=on\n/);
  assert.match(tart, /BUILD_ID=%s\\nBOX_IDENTITY_RESET=%s\\nPREPARE=%s\\n' "\$bb_url" "\$build_id" "\$identity_reset" "\$prepare" \| as_root sh -c "cat >\$src\/build\.env"/);
  for (const unchecked of ["boat/template.sh", "boat/customize-sandbox.sh"]) assert.doesNotMatch(on(unchecked), /BOX_IDENTITY_RESET/, unchecked);
  assert.match(readFileSync(FINALIZE, "utf8"), /rm -f \/etc\/bb-box\/identity .*\/var\/lib\/bb-box\/identity-armed/);
  const start = readFileSync(DOCKER_START, "utf8");
  const check = start.indexOf('bb-box-identity boot --value "${BBBOX_IDENTITY:-}"');
  assert.ok(check > 0 && check < start.indexOf("rm -f \"$home\"/.bb-machines/*/daemon.lock.lock") && check < start.indexOf(`touch "$run/ready"`), "a Docker box checks before it starts anything");
});

function settle(root: string, options: { readonly waitSeconds?: number; readonly path?: string } = {}) {
  return spawn("bash", [SCRIPT, "settle"], { env: { PATH: options.path ?? TEST_PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: String(options.waitSeconds ?? 0), BBBOX_IDENTITY_SETTLE_SECONDS: "0.1" } });
}

function waitFor(root: string, unit: string) {
  return spawn("bash", [SCRIPT, "wait", unit], { env: { PATH: TEST_PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_SETTLE_SECONDS: "0.1" } });
}

function ended(child: ReturnType<typeof spawn>): Promise<{ code: number | null; out: string }> {
  let out = "";
  child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
  return new Promise((resolve) => child.on("close", (code) => resolve({ code, out })));
}

function stillRunning(child: ReturnType<typeof spawn>, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(child.exitCode === null), ms);
    child.on("close", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

test("a card added and booted becomes an anchor, so removing the first card later keeps the box (sequential hot-plug)", () => {
  const lxc = guest([LOOP, LXC_ETH0]);
  boot(lxc);
  written(lxc, "bxsource1", "eth");
  const eth1: Nic = { name: "eth1", mac: "bc:24:11:00:00:11" };
  setNics(lxc, [LOOP, LXC_ETH0, eth1]);
  const grew = boot(lxc);
  assert.match(grew.out, /kept/);
  assert.match(grew.out, /added this boot's interfaces \( bc:24:11:00:00:11 \) to the marker/);
  assert.equal(read(lxc, "etc/bb-box/identity"), "bb-box identity 1\nbox bxsource1\nsource eth\nmac bc:24:11:00:00:11\nmac bc:24:11:aa:f1:b6\n");
  setNics(lxc, [LOOP, eth1]);
  const before = identityOf(lxc);
  assert.match(boot(lxc).out, /kept/, "net0 removed after net1 had booted");
  assert.deepEqual(identityOf(lxc), before);

  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  const ens19: Nic = { name: "ens19", mac: "bc:24:11:00:00:19", device: true };
  const vm = guest([LOOP, ens18]);
  boot(vm);
  written(vm, "bxvm1", "device");
  setNics(vm, [LOOP, ens18, ens19]);
  assert.match(boot(vm).out, /kept/);
  setNics(vm, [LOOP, ens19]);
  assert.match(boot(vm).out, /kept/, "qm set --net1, a boot, then --delete net0");
  assert.equal(read(vm, "var/lib/bb-box/identity-resets"), null);

  const copy = guest([LOOP, LXC_ETH0]);
  boot(copy);
  written(copy, "bxsource2", "eth");
  setNics(copy, [LOOP, LXC_ETH0, eth1]);
  boot(copy);
  setNics(copy, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }, { name: "eth1", mac: "bc:24:11:5e:77:02" }]);
  assert.match(boot(copy).out, /resets its identity/, "a copy of a box whose anchors grew still resets: all its cards are new");
});

test("a copy whose card appears after the wait is held, not let through: SSH, Tailscale and BB's daemon wait, and it resets once the card is there", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP]);
  const before = identityOf(root);
  const unknown = boot(root);
  assert.equal(unknown.code, 0, "the boot goes on, to the network and the console");
  assert.match(unknown.out, /not knowing yet whether this box is a copy: .* It removes nothing; SSH, Tailscale and BB's daemon wait while it looks again/);
  assert.deepEqual(identityOf(root), before, "nothing removed on unknown");
  const holding = settle(root);
  const done = ended(holding);
  const daemon = waitFor(root, "bb-host-daemon-bb-example-com-host_source.service");
  const daemonDone = ended(daemon);
  assert.equal(await stillRunning(daemon, 400), true, "BB's daemon waits");
  assert.deepEqual(identityOf(root), before);
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  const settled = await done;
  assert.equal(settled.code, 0);
  assert.match(settled.out, /this box is a copy, as its cards show now that they are here, so it resets its identity/);
  assertReset(root, before);
  assert.equal(status(root).boot, "reset");
  const daemonEnd = await daemonDone;
  assert.equal(daemonEnd.code, 1, "the copied machine's daemon never starts");
  assert.match(daemonEnd.out, /BB machine host_source went with this box's identity reset, so its daemon does not start/);
});

test("the box itself, its card late past the wait, keeps everything once the card appears, and its daemon starts", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP]);
  const before = identityOf(root);
  boot(root);
  const holding = ended(settle(root));
  const daemon = ended(waitFor(root, "bb-host-daemon-bb-example-com-host_source.service"));
  setTimeout(() => setNics(root, [LOOP, LXC_ETH0]), 300);
  const settled = await holding;
  assert.equal(settled.code, 0);
  assert.match(settled.out, /kept, now that its cards are here/);
  assert.deepEqual(identityOf(root), before);
  assert.equal(status(root).boot, "kept");
  assert.equal((await daemon).code, 0);
});

test("a box with no card at all still boots: nothing is removed, and only what uses its identity keeps waiting", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP]);
  const before = identityOf(root);
  assert.equal(boot(root).code, 0);
  const holding = settle(root);
  const daemon = waitFor(root, "bb-host-daemon-bb-example-com-host_source.service");
  assert.equal(await stillRunning(holding, 800), true, "SSH and Tailscale, behind it, wait");
  assert.equal(await stillRunning(daemon, 10), true);
  holding.kill();
  daemon.kill();
  assert.deepEqual(identityOf(root), before);
  assert.equal(status(root).boot, "unknown");
});

test("a box with no card past the wait stays held while its network, Docker and Tailscale add their own interfaces, on LXC as on a VM, and is kept once its card is back", async () => {
  const ens18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
  for (const [card, source] of [[LXC_ETH0, "eth"], [ens18, "device"]] as const) {
    const root = guest([LOOP, card]);
    boot(root);
    written(root, "bxsource1", source);
    const before = identityOf(root);
    setNics(root, [LOOP, ...BOX_MADE]);
    assert.match(boot(root).out, /not knowing yet whether this box is a copy/, `${source}: interfaces the box made are no card of the backend's`);
    setNics(root, [LOOP]);
    assert.match(boot(root).out, /not knowing yet whether this box is a copy/);
    const settling = settle(root);
    const settled = ended(settling);
    const daemon = waitFor(root, DAEMON_UNIT);
    const daemonDone = ended(daemon);
    setNics(root, [LOOP, ...BOX_MADE]);
    assert.equal(await stillRunning(settling, 600), true, `${source}: SSH and Tailscale still wait`);
    assert.equal(await stillRunning(daemon, 10), true, `${source}: BB's daemon still waits`);
    assert.deepEqual(identityOf(root), before, `${source}: nothing removed`);
    assert.equal(status(root).boot, "unknown");
    assert.equal(status(root).marker, "incomplete");
    setNics(root, [LOOP, card, ...BOX_MADE]);
    const done = await settled;
    assert.equal(done.code, 0);
    assert.match(done.out, /kept, now that its cards are here/);
    assert.deepEqual(identityOf(root), before);
    assert.equal((await daemonDone).code, 0, `${source}: BB's daemon starts`);
    assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
  }
});

const ENS18: Nic = { name: "ens18", mac: "bc:24:11:00:00:18", device: true };
const SOFTWARE_ETH9: ReadonlyArray<readonly [string, readonly Nic[]]> = [
  ["a bridge", [{ name: "eth9", mac: "02:55:44:33:22:11", kind: "bridge" }]],
  ["a bond", [{ name: "eth9", mac: "02:55:44:33:22:12", kind: "bond" }]],
  ["a TAP", [{ name: "eth9", mac: "02:55:44:33:22:13", kind: "tun" }]],
  ["a veth whose peer is inside the box", [{ name: "eth9", mac: "02:55:44:33:22:14", kind: "veth" }, { name: "peer9", mac: "02:55:44:33:22:24", kind: "veth" }]],
  ["a veth on a bridge, as Docker's are", [{ name: "eth9", mac: "02:55:44:33:22:17", kind: "veth", netnsid: 1, master: "docker0" }, { name: "docker0", mac: "02:42:ac:11:00:01", kind: "bridge" }]],
  ["a dummy", [{ name: "eth9", mac: "02:55:44:33:22:15", kind: "dummy" }]],
  ["a macvlan", [{ name: "eth9", mac: "02:55:44:33:22:16", kind: "macvlan" }]],
  ["an ipvlan", [{ name: "eth9", mac: "02:55:44:33:22:18", kind: "ipvlan" }]],
  ["a VLAN", [{ name: "eth9", mac: "02:55:44:33:22:19", kind: "vlan" }]],
  ["a GRE TAP", [{ name: "eth9", mac: "02:55:44:33:22:1a", kind: "gretap" }]],
  ["an IPv6 GRE TAP", [{ name: "eth9", mac: "02:55:44:33:22:1b", kind: "ip6gretap" }]],
  ["an ERSPAN", [{ name: "eth9", mac: "02:55:44:33:22:1c", kind: "erspan" }]],
  ["a VXLAN", [{ name: "eth9", mac: "02:55:44:33:22:1d", kind: "vxlan" }]],
  ["a Geneve", [{ name: "eth9", mac: "02:55:44:33:22:1e", kind: "geneve" }]],
];

test("on LXC only a veth whose peer is in another namespace, on no bridge and named eth, is a card: with the card missing, anything else named eth9, tunnels such as GRE TAP and ERSPAN included, leaves the box held at boot and in settle, on LXC as on a VM", async () => {
  for (const [card, source] of [[LXC_ETH0, "eth"], [ENS18, "device"]] as const) {
    for (const [what, made] of SOFTWARE_ETH9) {
      const root = guest([LOOP, card]);
      boot(root);
      written(root, "bxsource1", source);
      const before = identityOf(root);
      setNics(root, [LOOP, ...made]);
      assert.match(boot(root).out, /not knowing yet whether this box is a copy/, `${source}, ${what}: at boot`);
      assert.equal(status(root).marker, "incomplete", `${source}, ${what}`);
      const settling = settle(root);
      const settled = ended(settling);
      assert.equal(await stillRunning(settling, 300), true, `${source}, ${what}: held in settle`);
      assert.deepEqual(identityOf(root), before, `${source}, ${what}: nothing removed`);
      setNics(root, [LOOP, card, ...made]);
      assert.match((await settled).out, /kept, now that its cards are here/, `${source}, ${what}`);
      assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
    }
  }
});

test("only a card the backend gave becomes an anchor or keeps a box: a software interface with a fixed MAC never does, so a copy that makes it again is held, and resets once its own card comes", async () => {
  const bridge: Nic = { name: "eth9", mac: "02:55:44:33:22:11", kind: "bridge" };
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, LXC_ETH0, bridge]);
  const kept = boot(root);
  assert.match(kept.out, /kept: the identity marker of box bxsource1 matches/);
  assert.doesNotMatch(kept.out, /added this boot's interfaces/);
  assert.equal(read(root, "etc/bb-box/identity"), "bb-box identity 1\nbox bxsource1\nsource eth\nmac bc:24:11:aa:f1:b6\n");

  writeFileSync(join(root, "etc/bb-box/identity"), "bb-box identity 1\nbox bxsource1\nsource eth\nmac 02:55:44:33:22:11\nmac bc:24:11:aa:f1:b6\n");
  const before = identityOf(root);
  setNics(root, [LOOP]);
  assert.match(boot(root).out, /not knowing yet whether this box is a copy/);
  const settling = settle(root);
  const settled = ended(settling);
  const daemon = waitFor(root, DAEMON_UNIT);
  const daemonDone = ended(daemon);
  setNics(root, [LOOP, bridge]);
  assert.equal(await stillRunning(settling, 400), true, "a marker that holds the bridge's MAC, as version 3 could grow it, still does not keep the copy");
  assert.equal(await stillRunning(daemon, 10), true, "the copied machine's daemon still waits");
  assert.deepEqual(identityOf(root), before);
  setNics(root, [LOOP, bridge, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  assert.match((await settled).out, /this box is a copy, as its cards show now that they are here, so it resets its identity/);
  assertReset(root, before);
  assert.equal((await daemonDone).code, 1, "the copied machine's daemon never starts");
});

test("a card's peer is told by the namespace the kernel names, not by index: a veth whose index and peer index mirror the card's, in another namespace, leaves the card the box's own, and a second card is grown, never a reset", () => {
  const card: Nic = { name: "eth0", mac: LXC_ETH0.mac, index: 20, linkIndex: 100 };
  const mirror: Nic = { name: "vethDocker", mac: "b2:ba:42:83:33:e1", kind: "veth", netnsid: 1, index: 100, linkIndex: 20 };
  const root = guest([LOOP, card]);
  boot(root);
  written(root, "bxsource1", "eth");
  const before = identityOf(root);
  setNics(root, [LOOP, card, mirror]);
  assert.equal(status(root).marker, "matches");
  assert.match(boot(root).out, /kept: the identity marker of box bxsource1 matches/);
  const second: Nic = { name: "eth1", mac: "bc:24:11:00:00:11", index: 101, linkIndex: 200 };
  setNics(root, [LOOP, card, mirror, second]);
  writeFileSync(join(root, "run/bb-box-identity/boot"), "unknown\n");
  const settled = identity(root, ["settle"]);
  assert.equal(settled.code, 0, settled.err);
  assert.match(settled.out, /kept, now that its cards are here/);
  assert.match(boot(root).out, /added this boot's interfaces \( bc:24:11:00:00:11 \) to the marker/);
  assert.deepEqual(identityOf(root), before);
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
});

test("settle reads the cards once, so a second reading that arrives with a new card cannot turn the box into a copy", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  const marker = read(root, "etc/bb-box/identity");
  setNics(root, [LOOP]);
  boot(root);
  const full = [LOOP, LXC_ETH0, { name: "eth1", mac: "bc:24:11:00:00:11" }];
  writeFileSync(join(root, "ip-empty.json"), JSON.stringify([LOOP].map(linkInfo)));
  writeFileSync(join(root, "ip-full.json"), JSON.stringify(full.map(linkInfo)));
  const bin = tempDir("one-reading");
  writeFileSync(join(bin, "ip"), `#!/bin/sh
n=0
[ -f "$BBBOX_IDENTITY_ROOT/ip-calls" ] && n=$(cat "$BBBOX_IDENTITY_ROOT/ip-calls")
printf '%s\\n' "$((n + 1))" > "$BBBOX_IDENTITY_ROOT/ip-calls"
if [ "$n" -eq 0 ]; then cat "$BBBOX_IDENTITY_ROOT/ip-empty.json"; else cat "$BBBOX_IDENTITY_ROOT/ip-full.json"; fi
`, { mode: 0o755 });
  const settled = await ended(settle(root, { path: `${bin}:${TEST_PATH}` }));
  assert.equal(settled.code, 0, settled.out);
  assert.match(settled.out, /kept, now that its cards are here/);
  assert.equal(read(root, "etc/bb-box/identity"), marker);
  assert.equal(read(root, "var/lib/bb-box/identity-resets"), null);
});

test("anchors grow only at boot, before the box's own software makes interfaces, never in settle", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  written(root, "bxsource1", "eth");
  const marker = read(root, "etc/bb-box/identity");
  setNics(root, [LOOP]);
  boot(root);
  const settled = ended(settle(root));
  setTimeout(() => setNics(root, [LOOP, LXC_ETH0, { name: "eth1", mac: "bc:24:11:00:00:11" }]), 200);
  assert.match((await settled).out, /kept, now that its cards are here/);
  assert.equal(read(root, "etc/bb-box/identity"), marker);
  assert.match(boot(root).out, /added this boot's interfaces \( bc:24:11:00:00:11 \) to the marker/);
});

test("wait lets BB's daemon start once the identity is known, unless its machine went with a reset", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  boot(root);
  assert.equal((await ended(waitFor(root, "bb-host-daemon-bb-example-com-host_source.service"))).code, 0, "unarmed");
  written(root, "bxsource1", "eth");
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  boot(root);
  assert.equal((await ended(waitFor(root, "bb-host-daemon-bb-example-com-host_source.service"))).code, 1, "the copied machine");
  assert.equal((await ended(waitFor(root, "bb-host-daemon-bb-example-com-host_new.service"))).code, 0, "the machine BB Box enrols it as next");
  assert.equal((await ended(waitFor(root, "bb-host-daemon-bb-example-com-host_sour.service"))).code, 0, "another machine whose ID begins the same");
});

const SOURCE_NETWORK = "[Match]\nName = eth0\n\n[Network]\nAddress = 192.0.2.180/24\nGateway = 192.0.2.1\n";
const OWN_NETWORK = "[Match]\nName = eth0\n\n[Network]\nAddress = 192.0.2.182/24\nGateway = 192.0.2.1\n";
const NETWORK_FILE = "etc/systemd/network/eth0.network";

function networkFile(root: string, text: string): void {
  mkdirSync(join(root, "etc/systemd/network/eth0.network.d"), { recursive: true });
  writeFileSync(join(root, NETWORK_FILE), text);
}

const HELD_FILE = "var/lib/bb-box/held-network/eth0.network";

function armedWithNetwork(nics: readonly Nic[] = [LOOP, LXC_ETH0], source = "eth"): string {
  const root = guest(nics);
  boot(root);
  written(root, "bxsource1", source);
  networkFile(root, SOURCE_NETWORK);
  return root;
}

function bootAsync(root: string, waitSeconds: number) {
  return spawn("bash", [SCRIPT, "boot"], { env: { PATH: TEST_PATH, BBBOX_IDENTITY_ROOT: root, BBBOX_IDENTITY_NIC_WAIT_SECONDS: String(waitSeconds) } });
}

test("version 7: an LXC box that starts with no card holds its network settings on disk before it waits, so a copy's card added later never comes up with its source's address, and a copy drops them once it resets", async () => {
  const root = armedWithNetwork();
  setNics(root, [LOOP]);
  const unknown = boot(root);
  assert.match(unknown.out, /held its network settings \( eth0\.network \) aside in \S+\/var\/lib\/bb-box\/held-network, as it started with no card of its own/);
  assert.ok(unknown.out.indexOf("held its network settings") < unknown.out.indexOf("not knowing yet"), "held before it waits");
  assert.equal(read(root, NETWORK_FILE), null, "networkd, which starts after this, finds no settings for a card that comes later");
  assert.equal(read(root, HELD_FILE), SOURCE_NETWORK, "held on disk, not in /run");
  assert.ok(existsSync(join(root, "etc/systemd/network/eth0.network.d")), "a drop-in folder alone matches nothing, and stays");
  const settled = ended(settle(root));
  setTimeout(() => {
    networkFile(root, OWN_NETWORK);
    setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  }, 300);
  const done = await settled;
  assert.match(done.out, /resets its identity/);
  assert.equal(read(root, NETWORK_FILE), OWN_NETWORK, "its backend's settings for its own card stay");
  assert.equal(existsSync(join(root, "var/lib/bb-box/held-network")), false, "the copied settings are gone");
});

test("version 7: a copy's card that comes during the boot's own wait finds its settings already held, so the copy resets with only its backend's", async () => {
  const root = armedWithNetwork();
  setNics(root, [LOOP]);
  const booting = bootAsync(root, 5);
  const done = ended(booting);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(read(root, NETWORK_FILE), null, "held from the start of the wait");
  networkFile(root, OWN_NETWORK);
  setNics(root, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  const booted = await done;
  assert.equal(booted.code, 0);
  assert.match(booted.out, /resets its identity/);
  assert.equal(read(root, NETWORK_FILE), OWN_NETWORK);
  assert.equal(existsSync(join(root, "var/lib/bb-box/held-network")), false);
});

test("version 7: a reboot before settle decides loses nothing: the box itself, its card back, gets its held settings back, or keeps its backend's new ones", () => {
  for (const backendWrites of [false, true]) {
    const root = armedWithNetwork();
    setNics(root, [LOOP]);
    boot(root);
    rmSync(join(root, "run"), { recursive: true, force: true });
    if (backendWrites) networkFile(root, OWN_NETWORK);
    setNics(root, [LOOP, LXC_ETH0]);
    const kept = boot(root);
    assert.match(kept.out, /kept: the identity marker/);
    if (backendWrites) assert.equal(read(root, NETWORK_FILE), OWN_NETWORK, "the backend's fresh settings win");
    else {
      assert.match(kept.out, /put back its network settings \( eth0\.network \), as it is the box itself/);
      assert.equal(read(root, NETWORK_FILE), SOURCE_NETWORK, "its own settings, back after the reboot");
    }
    assert.equal(existsSync(join(root, "var/lib/bb-box/held-network")), false);
  }
});

test("version 7: a hold that cannot be made deletes the copied settings instead", () => {
  const root = armedWithNetwork();
  setNics(root, [LOOP]);
  mkdirSync(join(root, "var/lib/bb-box"), { recursive: true });
  writeFileSync(join(root, "var/lib/bb-box/held-network"), "not a folder");
  const deleted = boot(root);
  assert.equal(deleted.code, 0);
  assert.match(deleted.out, /could not hold its network settings aside in \S+, so it deletes them instead/);
  assert.equal(read(root, NETWORK_FILE), null, "no copied settings are left for a card added later");
  assert.equal(status(root).boot, "unknown");
});

test("version 7: a boot that can neither hold nor delete the copied settings fails closed", { skip: process.getuid?.() === 0 ? "root can remove what the test protects" : false }, () => {
  const stuck = armedWithNetwork();
  setNics(stuck, [LOOP]);
  mkdirSync(join(stuck, "var/lib/bb-box"), { recursive: true });
  writeFileSync(join(stuck, "var/lib/bb-box/held-network"), "not a folder");
  chmodSync(join(stuck, "etc/systemd/network"), 0o555);
  try {
    const failed = boot(stuck);
    assert.equal(failed.code, 1);
    assert.match(failed.out, /could neither hold nor delete its network settings while it has no card of its own, so the network, SSH, Tailscale, Docker, the desktop and the box user's services stay off/);
    assert.equal(status(stuck).boot, "failed");
  } finally {
    chmodSync(join(stuck, "etc/systemd/network"), 0o755);
  }
});

test("version 7: nothing is held for the box itself with a renamed card that carries its marker's address, for a VM, or for a copy whose card was there at its start; a copy with no marker and no card drops its copied settings as it resets", () => {
  const renamed = armedWithNetwork();
  setNics(renamed, [LOOP, { name: "lan0", mac: "BC:24:11:AA:F1:B6" }]);
  boot(renamed);
  assert.equal(read(renamed, NETWORK_FILE), SOURCE_NETWORK, "a card proven the box's own, whatever its name, holds nothing back");
  assert.equal(existsSync(join(renamed, "var/lib/bb-box/held-network")), false);
  const vm = armedWithNetwork([LOOP, ENS18], "device");
  setNics(vm, [LOOP]);
  assert.match(boot(vm).out, /not knowing yet/);
  assert.equal(read(vm, NETWORK_FILE), SOURCE_NETWORK, "a VM's address comes from its backend at each boot, so nothing is held");
  const present = armedWithNetwork();
  networkFile(present, OWN_NETWORK);
  setNics(present, [LOOP, { name: "eth0", mac: "bc:24:11:5e:77:01" }]);
  assert.match(boot(present).out, /resets its identity/);
  assert.equal(read(present, NETWORK_FILE), OWN_NETWORK, "a copy whose card was there at its start has its backend's settings, untouched");
  const unmarked = armedWithNetwork();
  rmSync(join(unmarked, "etc/bb-box/identity"));
  setNics(unmarked, [LOOP]);
  const reset = boot(unmarked);
  assert.match(reset.out, /missing or unreadable/);
  assert.equal(read(unmarked, NETWORK_FILE), null, "the copied settings are not left for a card added later");
  assert.equal(existsSync(join(unmarked, "var/lib/bb-box/held-network")), false);
});

const BOAT_ENV = "run/ascii-secrets/env.sh";
const BOAT_NICS: readonly Nic[] = [LOOP, { name: "enp0s1", mac: "02:00:00:00:00:01", device: true }];

function boatGuest(): string {
  const root = guest(BOAT_NICS, { on: false });
  assert.equal(identity(root, ["enable", "--value-file", "/run/ascii-secrets/env.sh", "--machine-from-provider"]).code, 0);
  return root;
}

function boatValue(root: string, value: string | null): void {
  mkdirSync(join(root, "run/ascii-secrets"), { recursive: true });
  writeFileSync(join(root, BOAT_ENV), `export SOME_OTHER="kept apart"\n${value === null ? "" : `export BBBOX_IDENTITY="${value}"\n`}export LAST="x"\n`);
}

test("version 8: enable can read the value from a file a provider writes, and leave the machine ID and SSH host keys to the provider; disable removes both settings, and a bad path is refused", () => {
  const root = tempDir("identity-options");
  assert.equal(identity(root, ["enable", "--value-file", "/run/ascii-secrets/env.sh", "--machine-from-provider"]).code, 0);
  assert.equal(read(root, "usr/local/lib/bb-box/identity-options"), "value-file /run/ascii-secrets/env.sh\nmachine provider\n");
  assert.equal(identity(root, ["enable"]).code, 0);
  assert.equal(existsSync(join(root, "usr/local/lib/bb-box/identity-options")), false, "a plain enable, as every other image runs, has no options");
  assert.equal(identity(root, ["enable", "--value-file", "relative/env.sh"]).code, 2);
  assert.equal(identity(root, ["enable", "--value-file"]).code, 2);
  assert.equal(identity(root, ["enable", "--value-file", "/run/env.sh"]).code, 0);
  assert.equal(identity(root, ["disable"]).code, 0);
  assert.equal(existsSync(join(root, "usr/local/lib/bb-box/identity-options")), false);
  assert.equal(identity(root, ["version"]).out, "9\n");
});

test("version 8, boat: the value is read from the file boat writes, never from the boot's arguments; a stop and start, a resize and a same-box swap keep the box, as the value is the box's own", () => {
  const root = boatGuest();
  boatValue(root, "bxsource1");
  assert.match(boot(root).out, /no identity marker/);
  assert.equal(written(root, "bxsource1", "value"), "bb-box identity 1\nbox bxsource1\nsource value\nvalue bxsource1\n");
  assert.deepEqual(status(root), { version: "9", enabled: "yes", boot: "unarmed", marker: "matches", armed: "yes", pending: "no", box: "bxsource1", source: "value" });
  const before = identityOf(root);
  setNics(root, [LOOP, { name: "enp0s1", mac: "02:00:00:00:00:99", device: true }]);
  for (let start = 0; start < 3; start++) assert.match(boot(root, "bxother9").out, /kept: the identity marker of box bxsource1 matches/, "a new machine with new MAC addresses, and an argument that is not the file's");
  assert.deepEqual(identityOf(root), before);
  assert.equal(forkSafeVersion(parseIdentityStatus(identity(root, ["status"]).out)), 9);
});

test("version 8, boat: a fork's new value resets BB's machine credentials and host ID, the access file and the tailnet node, and leaves the SSH host keys and machine ID, which boat makes new on every machine, alone", () => {
  const root = boatGuest();
  boatValue(root, "bxsource1");
  boot(root);
  written(root, "bxsource1", "value");
  const before = identityOf(root);
  boatValue(root, "bxfork1");
  const ran = boot(root);
  assert.match(ran.out, /this box is a copy, so it resets its identity: the value bb-box set on this guest is not the marker's/);
  assert.match(ran.out, /its provider gives each machine its own SSH host keys and machine ID/);
  const after = identityOf(root);
  assert.equal(after.auth, null);
  assert.equal(after.hostId, null);
  assert.equal(after.daemonUnit, false);
  assert.equal(after.access, null);
  assert.equal(after.tailnet, 0);
  assert.equal(after.ed25519, before.ed25519, "boat pins the host key it reported, so the reset leaves it");
  assert.equal(after.ecdsa, before.ecdsa);
  assert.equal(after.machineId, before.machineId);
  assert.equal(read(root, WORKTREE_FILE), "the thread's work");
  assert.match(read(root, "etc/bb-box/identity") ?? "", /^bb-box identity 1\nsource value\nvalue bxfork1\nreset /, "the fork's own marker, naming no box");
  assert.deepEqual(status(root), { version: "9", enabled: "yes", boot: "reset", marker: "matches", armed: "yes", pending: "no", box: "", source: "value" });
  assert.match(boot(root).out, /kept/, "it does not reset again");
});

test("version 8, boat: a value missing from the file never counts the box as a copy, however late it comes: the box is held, removing nothing, and says so, and settle keeps it once the value is there (Astra 1, Opus 4)", async () => {
  const root = boatGuest();
  boatValue(root, "bxsource1");
  boot(root);
  written(root, "bxsource1", "value");
  const before = identityOf(root);
  rmSync(join(root, BOAT_ENV));
  const held = identity(root, ["boot"], { waitSeconds: 1 });
  assert.equal(held.code, 0);
  assert.match(held.out, /not knowing yet whether this box is a copy: it has found no BBBOX_IDENTITY in \/run\/ascii-secrets\/env\.sh yet, so it cannot tell\. It removes nothing; SSH, Tailscale and BB's daemon wait while it looks again/);
  assert.equal(status(root).boot, "unknown");
  assert.deepEqual(identityOf(root), before, "a slow start costs the box nothing");
  const settling = settle(root);
  const daemon = waitFor(root, "bb-host-daemon-bb-example-com-host_source.service");
  assert.equal(await stillRunning(settling, 3_100), true, "still waiting, with no reset, past what version 8 first allowed");
  assert.equal(await stillRunning(daemon, 10), true, "BB's daemon waits too");
  assert.deepEqual(identityOf(root), before);
  boatValue(root, "bxsource1");
  assert.equal((await ended(settling)).code, 0);
  assert.equal((await ended(daemon)).code, 0);
  assert.equal(status(root).boot, "kept");
  assert.deepEqual(identityOf(root), before);
  boatValue(root, "bxother1");
  assert.match(boot(root).out, /resets its identity: the value bb-box set on this guest is not the marker's/, "only a value that differs is a copy");
});

test("version 8, boat: a box that reset with no value to write unarms itself in words that name the value, so BB Box writes its marker again at its next start", () => {
  const root = boatGuest();
  boatValue(root, "bxsource1");
  boot(root);
  written(root, "bxsource1", "value");
  rmSync(join(root, "etc/bb-box/identity"));
  rmSync(join(root, BOAT_ENV));
  const ran = boot(root);
  assert.match(ran.out, /its identity marker is missing or unreadable/);
  assert.match(ran.out, /found no BBBOX_IDENTITY in \/run\/ascii-secrets\/env\.sh to write a marker for, so it unarms this box until bb-box writes one at its next start/);
  assert.doesNotMatch(ran.out, /no interface/);
  assert.equal(status(root).armed, "no");
});

test("version 8 on Proxmox: with a plain enable, wait goes on at once when no check has run, exactly as version 7 did (Opus 3)", async () => {
  const root = guest([LOOP, LXC_ETH0]);
  assert.equal(existsSync(join(root, "run/bb-box-identity/boot")), false);
  const ran = await ended(waitFor(root, "bb-host-daemon-bb-example-com-host_source.service"));
  assert.equal(ran.code, 0);
});

test("version 8, boat: a value that is not a box ID, or sits on another variable's line, is no value", () => {
  const root = boatGuest();
  mkdirSync(join(root, "run/ascii-secrets"), { recursive: true });
  for (const text of ['export BBBOX_IDENTITY="$(touch /tmp/x)"\n', 'export NOT_BBBOX_IDENTITY="bxsource1"\n', "export BBBOX_IDENTITY=\"BX-1\"\n"]) {
    writeFileSync(join(root, BOAT_ENV), text);
    boot(root);
    const wrote = identity(root, ["write", "--box", "bxsource1", "--source", "value"]);
    assert.equal(wrote.code, 3, text);
    assert.match(wrote.err, /this boot saw no value from bb-box/);
  }
  writeFileSync(join(root, BOAT_ENV), "BBBOX_IDENTITY=bxsource1\n");
  boot(root);
  assert.equal(written(root, "bxsource1", "value"), "bb-box identity 1\nbox bxsource1\nsource value\nvalue bxsource1\n", "plain or exported, quoted or not");
});

test("version 8: with a value file, wait holds BB's daemon until this machine's own check has run, as on boat the box user's services can start before it; with the reset off it never holds", async () => {
  const root = boatGuest();
  boatValue(root, "bxsource1");
  const waiting = waitFor(root, "bb-host-daemon-bb-example-com-host_source.service");
  assert.equal(await stillRunning(waiting, 400), true, "no check has run on this machine yet");
  boot(root);
  assert.equal((await ended(waiting)).code, 0);
  const off = guest([LOOP, LXC_ETH0], { on: false });
  assert.equal((await ended(waitFor(off, "bb-host-daemon-bb-example-com-host_source.service"))).code, 0);
});

test("boat's Linux and desktop templates turn the reset on with boat's settings; Android does not", () => {
  for (const kind of ["linux", "linux-desktop-cpu"] as const) assert.match(buildEnvFor("build.1", kind), /^BOX_IDENTITY_RESET=on\nBOX_IDENTITY_VALUE_FILE=\/run\/ascii-secrets\/env\.sh\nBOX_IDENTITY_MACHINE=provider$/m);
  for (const kind of ["android"] as const) {
    assert.match(buildEnvFor("build.1", kind), /^BOX_IDENTITY_RESET=off$/m, kind);
    assert.doesNotMatch(buildEnvFor("build.1", kind), /BOX_IDENTITY_VALUE_FILE/, kind);
  }
  const base = readFileSync(CUSTOMIZE_BASE, "utf8");
  assert.match(base, /identity_options\+=\(--value-file "\$BOX_IDENTITY_VALUE_FILE"\)/);
  assert.match(base, /\[ "\$\{BOX_IDENTITY_MACHINE:-own\}" != provider \] \|\| identity_options\+=\(--machine-from-provider\)/);
  const fake = tempDir("customize-identity");
  const bin = join(fake, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "bb-box-identity"), `#!/bin/sh\necho "$@" >> ${join(fake, "calls")}\n`, { mode: 0o755 });
  const lines = base.split("\n");
  const from = lines.findIndex((line) => line.startsWith('if [ "${BOX_IDENTITY_RESET:-off}" = on ]; then'));
  const to = lines.indexOf("fi", from);
  const block = lines.slice(from, to + 1).join("\n").replaceAll("/usr/local/sbin/bb-box-identity", join(bin, "bb-box-identity"));
  for (const [settings, wanted] of [
    [{ BOX_IDENTITY_RESET: "on", runtime: "vm", BOX_IDENTITY_VALUE_FILE: "/run/ascii-secrets/env.sh", BOX_IDENTITY_MACHINE: "provider" }, "enable --value-file /run/ascii-secrets/env.sh --machine-from-provider"],
    [{ BOX_IDENTITY_RESET: "on", runtime: "lxc" }, "enable"],
    [{ BOX_IDENTITY_RESET: "on", runtime: "docker" }, "enable --no-unit"],
  ] as const) {
    rmSync(join(fake, "calls"), { force: true });
    const ran = spawnSync("bash", ["-euo", "pipefail", "-c", block], { env: { PATH: process.env.PATH, ...settings }, encoding: "utf8" });
    assert.equal(ran.status, 0, ran.stderr);
    assert.equal(read(fake, "calls"), `${wanted}\n`);
  }
});
