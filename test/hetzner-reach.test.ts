import assert from "node:assert/strict";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { HetznerBackend } from "../src/backends/hetzner/backend.ts";
import { Hetzner } from "../src/backends/hetzner/api.ts";
import { HOST_SETUP_PATH, LXCFS_KEPT_RUNNING, METADATA_ADDRESS, TAILSCALE_KEY_PATH, hostUserData } from "../src/backends/hetzner/cloud-init.ts";
import { HETZNER_FIELDS, parseHetznerPart } from "../src/backends/hetzner/config.ts";
import type { HostRecord } from "../src/backends/hetzner/hosts.ts";
import { HostReach, firewallRules, forwardArgs } from "../src/backends/hetzner/reach.ts";
import { DRIVERS } from "../src/backends/index.ts";
import type { AcquireHooks, BoxIdentity, ReleaseHooks } from "../src/backends/types.ts";
import type { Tailnet, TailnetDevice } from "../src/core/tailnet.ts";
import { fakeDockerHost } from "./fake-docker.ts";
import { FAKE_HETZNER_TOKEN, FakeHetzner } from "./fake-hetzner.ts";
import { hetznerConfig } from "./fake-hetzner-world.ts";
import { MemoryStorage, tempDir, testContext } from "./helpers.ts";

const TAILNET_KEY = "tskey-auth-kFAKE1CNTRL-0123456789abcdef";
const signal = () => AbortSignal.timeout(30_000);

function fakeTailnet(devices: TailnetDevice[] = [], joined: () => TailnetDevice[] = () => []) {
  const removed: string[] = [];
  const minted: string[] = [];
  const tailnet = {
    mintKey: async (request: { description: string }) => {
      minted.push(request.description);
      return { id: "k1", key: TAILNET_KEY, expiresAt: Date.now() + 600_000 };
    },
    devices: async () => [...devices, ...joined()].filter((each) => !removed.includes(each.id)),
    removeDevice: async (id: string) => void removed.push(id),
  } as unknown as Tailnet;
  return { tailnet, devices, removed, minted };
}

function fakeSsh(mode: "forwards" | "refused") {
  const dir = tempDir("fake-ssh-forward");
  const binary = join(dir, "ssh");
  const log = join(dir, "calls");
  const body =
    mode === "forwards"
      ? `for a; do if [ "$prev" = "-L" ]; then sock=\${a%%:/var/run/docker.sock}; fi; prev=$a; done; : > "$sock"; exec sleep 300`
      : `echo "root@192.0.2.9: Permission denied (publickey)." >&2; exit 255`;
  writeFileSync(binary, `#!/bin/sh\necho "$*" >> '${log}'\n${body}\n`);
  chmodSync(binary, 0o755);
  return { binary, calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []) };
}

const record = (overrides: Partial<HostRecord> = {}): HostRecord => ({
  hostId: "h1abcdef",
  serverName: "bb-box-test-h1abcdef",
  state: "ready",
  serverId: 1001,
  claimedAtMs: 0,
  serverType: "cpx42",
  location: "nbg1",
  ipv4: "203.0.113.9",
  ipv6: null,
  lastBusyAtMs: 0,
  answeredAtMs: null,
  ...overrides,
});

test("the settings parse with their defaults, the token is a secret field, and a monthly limit of 0 is none", () => {
  assert.equal((HETZNER_FIELDS.token as { secret?: boolean }).secret, true);
  assert.ok(DRIVERS.some((driver) => driver.type === "hetzner"));
  const parsed = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token: "a".repeat(64) } });
  assert.ok(parsed.ok);
  const config = parsed.config;
  assert.deepEqual(
    [config.location, config.serverType, config.hostImage, config.mostHosts, config.idleMinutes, config.monthlyLimitEurosBeforeVat, config.sshFrom, config.docker.images.linux, config.docker.images["linux-desktop"]],
    ["nbg1", "cpx42", "ubuntu-26.04", 2, 30, 20, [], "bbbox/linux:1", null],
  );
  const none = parseHetznerPart({ id: "hetzner", hosts: [], fields: { token: "a".repeat(64), "monthly-limit-eur": 0, "host-image": "123456", "ssh-from": "203.0.113.7/32, 2001:db8::/64" } });
  assert.ok(none.ok);
  assert.deepEqual([none.config.monthlyLimitEurosBeforeVat, none.config.hostImage, none.config.hostImageLabel, none.config.sshFrom], [null, 123456, "snapshot-123456", ["203.0.113.7/32", "2001:db8::/64"]]);
});

test("the settings say what is wrong, field by field, without the token", () => {
  const parsed = parseHetznerPart({ id: "hetzner", hosts: [], fields: { location: "Nuremberg", "server-type": "big one", "most-hosts": 0, "idle-minutes": 1, "monthly-limit-eur": -5, "ssh-from": "everyone", "linux-image": "" , "desktop-image": "", "wayland-desktop-image": "" } });
  assert.ok(!parsed.ok);
  assert.deepEqual(parsed.problems.map((each) => each.path).sort(), ["idle-minutes", "linux-image", "location", "monthly-limit-eur", "most-hosts", "server-type", "ssh-from", "token"].sort());
  assert.ok(parsed.problems.every((each) => each.message.startsWith("Hetzner Cloud:")));
});

test("a host's first boot keeps containers from the metadata service before Docker starts, and joins the tailnet with a key read from a root-only file", () => {
  const data = hostUserData({ serverName: "bb-box-test-h1abcdef", tailnetKey: TAILNET_KEY });
  assert.ok(data.startsWith("#cloud-config\n"));
  const bootcmd = data.slice(data.indexOf("bootcmd:"), data.indexOf("runcmd:"));
  assert.match(bootcmd, new RegExp(`DOCKER-USER -d ${METADATA_ADDRESS.replaceAll(".", "\\.")}/32 -j REJECT`));
  assert.match(data, new RegExp(`- path: ${TAILSCALE_KEY_PATH}\\n    owner: root:root\\n    permissions: '0600'`));
  const setup = JSON.parse(data.split("\n").find((line) => line.startsWith("    content: ") && line.includes("tailscale up"))!.slice("    content: ".length)) as string;
  assert.match(setup, new RegExp(`tailscale up --auth-key=file:${TAILSCALE_KEY_PATH} --hostname=bb-box-test-h1abcdef --accept-dns=false`));
  assert.ok(setup.indexOf("tailscale up") < setup.indexOf(`rm -f ${TAILSCALE_KEY_PATH}`), "the key file goes once used");
  assert.ok(setup.indexOf(`-d ${METADATA_ADDRESS}`) < setup.indexOf("get.docker.com"), "the rule is there before Docker is");
  assert.ok(setup.indexOf("get.docker.com") < setup.indexOf("apt-get install -y -qq lxcfs"), "LXCFS comes after Docker, so boxes see their own memory and CPUs (062)");
  assert.match(setup, /systemctl enable --now lxcfs\napt-mark hold lxcfs/, "held, so unattended-upgrades never upgrades it under running boxes");
  assert.ok(setup.includes(`printf '[Unit]\\nRefuseManualStop=yes\\n' > ${LXCFS_KEPT_RUNNING}\nsystemctl daemon-reload`), "and systemd refuses to restart it, from needrestart or a package's script, which would break running boxes' files");
  assert.equal(setup.split(TAILNET_KEY).length, 1, "the key is never in the script, so never in a command line");
  assert.match(data, new RegExp(`runcmd:\\n  - \\["${HOST_SETUP_PATH}"\\]`));
  const withoutTailnet = hostUserData({ serverName: "bb-box-test-h1abcdef", tailnetKey: null });
  assert.doesNotMatch(withoutTailnet, /tailscale|tskey/);
  assert.match(withoutTailnet, /DOCKER-USER/);
});

test("the firewall lets in only Tailscale's direct connections and ping, and SSH only from the addresses set when the tailnet is off", () => {
  assert.deepEqual(firewallRules(true, ["203.0.113.7/32"]).map((rule) => `${rule.protocol}:${rule.port ?? ""}`), ["udp:41641", "icmp:"]);
  const off = firewallRules(false, ["203.0.113.7/32"]);
  assert.deepEqual(off.at(-1), { direction: "in", protocol: "tcp", port: "22", sourceIps: ["203.0.113.7/32"], description: "SSH from BB's server" });
  assert.equal(firewallRules(false, []).some((rule) => rule.port === "22"), false);
});

test("the forward is one SSH connection that carries Docker's socket, with bb-box's key, the host's key pinned at first sight, and no shell", () => {
  const args = forwardArgs({ keyPath: "/k/id", knownHostsPath: "/k/known_hosts-h1", socket: "/tmp/bb-box-hz-x/h1.sock", address: "192.0.2.9" });
  assert.deepEqual(args.slice(-4), ["-N", "-L", "/tmp/bb-box-hz-x/h1.sock:/var/run/docker.sock", "root@192.0.2.9"]);
  for (const option of ["IdentitiesOnly=yes", "BatchMode=yes", "StrictHostKeyChecking=accept-new", "UserKnownHostsFile=/k/known_hosts-h1", "ExitOnForwardFailure=yes", "StreamLocalBindUnlink=yes"]) assert.ok(args.includes(option), option);
  assert.equal(forwardArgs({ keyPath: "/k", knownHostsPath: "/h", socket: "/s", address: "fd7a::9" }).at(-1), "root@[fd7a::9]");
});

test("a host is reached at its tailnet address over a forward that comes up once, is made again when it dies, and says why it failed", async () => {
  const { tailnet } = fakeTailnet([{ id: "n1", hostname: "bb-box-test-h1abcdef", tags: ["tag:bb-box"], lastSeen: null, addresses: ["192.0.2.9", "fd7a::9"] }]);
  const ssh = fakeSsh("forwards");
  const docker = fakeDockerHost();
  const api = new Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: new FakeHetzner().fetch, sleep: async () => {} });
  const reach = new HostReach({ api, storage: new MemoryStorage(), installId: "test", tailnet: () => tailnet, sshFrom: [], sshBinary: ssh.binary, dockerBinary: docker.binary });
  try {
    assert.deepEqual(await reach.address(record()), { address: "192.0.2.9", via: "tailnet" });
    const cli = reach.cli(record());
    await cli.prepare();
    await cli.prepare();
    assert.equal(ssh.calls().length, 1, "one forward for every call");
    assert.match(ssh.calls()[0]!, /-N -L \S+\/h1abcdef\.sock:\/var\/run\/docker\.sock root@192\.0\.2\.9$/);
    assert.equal((await cli.run(["info", "--format", "{{json .}}"])).exitCode, 0);
    await reach.forget("h1abcdef");
    await cli.prepare();
    assert.equal(ssh.calls().length, 2, "a forward that went is made again");
    const refused = new HostReach({ api, storage: new MemoryStorage(), installId: "test", tailnet: () => tailnet, sshFrom: [], sshBinary: fakeSsh("refused").binary });
    await assert.rejects(refused.cli(record()).prepare(), /could not reach bb-box-test-h1abcdef at 192\.0\.2\.9 over SSH: root@192\.0\.2\.9: Permission denied \(publickey\)\./);
    const offTailnet = new HostReach({ api, storage: new MemoryStorage(), installId: "test", tailnet: () => fakeTailnet().tailnet, sshFrom: [] });
    await assert.rejects(offTailnet.address(record()), /not on the tailnet yet/);
    await refused.dispose();
    await offTailnet.dispose();
  } finally {
    await reach.dispose();
  }
});

test("without the tailnet, a host is reached at its public IPv4 when SSH from is set, and not at all otherwise", async () => {
  const api = new Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: new FakeHetzner().fetch, sleep: async () => {} });
  const open = new HostReach({ api, storage: new MemoryStorage(), installId: "test", tailnet: () => null, sshFrom: ["198.51.100.4/32"] });
  assert.equal(open.canReach(), null);
  assert.deepEqual(await open.address(record()), { address: "203.0.113.9", via: "internet" });
  const closed = new HostReach({ api, storage: new MemoryStorage(), installId: "test", tailnet: () => null, sshFrom: [] });
  assert.match(closed.canReach()!, /Turn the tailnet on in BB Box's General settings, or set SSH from/);
  await open.dispose();
  await closed.dispose();
});

test("bb-box makes its SSH key and firewall once, labelled for the install, and changes the firewall's rules when the tailnet goes off", async () => {
  const fake = new FakeHetzner();
  const api = new Hetzner({ token: FAKE_HETZNER_TOKEN, fetch: fake.fetch, sleep: async () => {} });
  const storage = new MemoryStorage();
  let tailnet: Tailnet | null = fakeTailnet().tailnet;
  const reach = new HostReach({ api, storage, installId: "test", tailnet: () => tailnet, sshFrom: ["198.51.100.4/32"] });
  const key = await reach.hetznerSshKeyId();
  assert.equal(await reach.hetznerSshKeyId(), key);
  assert.deepEqual([...fake.sshKeys.values()].map((each) => [each.name, each.labels]), [["bb-box-test", { "bbbox-install": "test" }]]);
  assert.match([...fake.sshKeys.values()][0]!.publicKey, /^ssh-ed25519 \S+ bb-box$/);
  assert.match((await storage.get<{ privateKey: string }>("ssh-key"))!.privateKey, /OPENSSH PRIVATE KEY/);
  const firewall = await reach.firewallId();
  assert.equal(fake.firewalls.size, 1);
  assert.equal((fake.firewalls.get(firewall)!.rules as { port?: string }[]).some((rule) => rule.port === "22"), false);
  tailnet = null;
  assert.equal(await reach.firewallId(), firewall);
  assert.equal(fake.firewalls.size, 1);
  assert.equal((fake.firewalls.get(firewall)!.rules as { port?: string }[]).some((rule) => rule.port === "22"), true);
  await reach.dispose();
});

test("with the tailnet on, a new host gets bb-box's key, its firewall and a first boot with a fresh key; its tailnet device goes with it", async () => {
  const fake = new FakeHetzner();
  const docker = fakeDockerHost({ name: "cloud-host", cpus: 8, memoryMiB: 16_384 });
  const ssh = fakeSsh("forwards");
  const seen = new Map<number, TailnetDevice>();
  const joined = () => {
    for (const server of fake.servers.values()) seen.set(server.id, { id: `n${server.id}`, hostname: server.name, tags: ["tag:bb-box"], lastSeen: null, addresses: ["192.0.2.9"] });
    return [...seen.values()];
  };
  const { tailnet, removed, minted } = fakeTailnet([], joined);
  const logs: string[] = [];
  const context = { ...testContext(new MemoryStorage(), "test", { id: "hetzner" }), tailnet: () => tailnet, log: (line: string) => void logs.push(line) };
  const backend = new HetznerBackend(hetznerConfig(), context, {
    fetch: fake.fetch,
    sleep: async () => {},
    now: () => fake.now,
    dockerOptions: { binary: docker.binary, readyTimeoutMs: 20_000 },
    sshBinary: ssh.binary,
    pollMs: 1,
  });
  const hooksValue: AcquireHooks = { claim: async () => {}, starting: async () => {}, timing: () => {} };
  const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
  const box: BoxIdentity = { boxId: "bxreach000001", threadId: "thr_abc123", name: "calm-otter", kind: "linux", createdAt: 1_790_000_000_000, size: { cores: 2, memoryMiB: 4096, diskGiB: null } };
  try {
    const guest = await backend.acquire(box, null, hooksValue, signal());
    const [server] = fake.servers.values();
    assert.equal(server!.sshKeys.length, 1);
    assert.equal(server!.firewalls.length, 1);
    assert.match(server!.userData!, new RegExp(TAILNET_KEY));
    assert.match(server!.userData!, /DOCKER-USER/);
    assert.deepEqual(minted, [`bb-box host ${server!.name}`]);
    assert.ok(logs.every((line) => !line.includes(TAILNET_KEY)));
    assert.equal((await backend.doctor(signal())).checks.find((each) => each.id === "hetzner.reach")!.status, "ok");
    await backend.release(guest, releasing, signal());
    fake.advanceClock(31 * 60_000);
    await backend.maintain(signal());
    assert.equal(fake.servers.size, 0);
    assert.deepEqual(removed, [`n${server!.id}`]);
  } finally {
    await backend.dispose();
  }
});

test("with the tailnet off and no SSH from, no host is made, and the offer says how to fix it", async () => {
  const fake = new FakeHetzner();
  const backend = new HetznerBackend(hetznerConfig(), testContext(new MemoryStorage(), "test", { id: "hetzner" }), { fetch: fake.fetch, sleep: async () => {}, now: () => fake.now });
  const offer = await backend.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null }, [], signal());
  assert.equal(offer.ok, false);
  assert.match(offer.message!, /Turn the tailnet on in BB Box's General settings, or set SSH from/);
  assert.equal(fake.servers.size, 0);
  const doctor = await backend.doctor(signal());
  assert.equal(doctor.checks.find((each) => each.id === "hetzner.reach")!.status, "fail");
  await backend.dispose();
});

test("maintain removes the tailnet devices of this install's hosts that are gone, by the Hetzner prefix and the one before it, and never another backend's or a person's", async () => {
  const fake = new FakeHetzner();
  const device = (hostname: string): TailnetDevice => ({ id: hostname, hostname, tags: ["tag:bb-box"], lastSeen: null, addresses: [] });
  const { tailnet, removed } = fakeTailnet([device("bb-box-hz-test-gone0001"), device("bb-box-test-gone0002"), device("bb-box-ns-test-mac00001"), device("bb-box-hz-other-gone0003"), device("owners-laptop")]);
  const context = { ...testContext(new MemoryStorage(), "test", { id: "hetzner" }), tailnet: () => tailnet };
  const backend = new HetznerBackend(hetznerConfig({ hostImage: 4242, hostImageLabel: "snapshot-4242" }), context, { fetch: fake.fetch, sleep: async () => {}, now: () => fake.now });
  await backend.maintain(signal());
  assert.deepEqual(removed.sort(), ["bb-box-hz-test-gone0001", "bb-box-test-gone0002"]);
  await backend.dispose();
});
