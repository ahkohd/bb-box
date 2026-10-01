import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { TartBackend, type TartBackendOptions } from "../src/backends/tart/backend.ts";
import { parseHosts, parseTartSettings } from "../src/backends/tart/config.ts";
import { parseState, parseVnc } from "../src/backends/tart/host.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_MAC, addImage, fakeMacTools, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const GiB = 2 ** 30;
const MAC = FAKE_MAC;

const made: TartBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

const FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 };

function setup(values: Record<string, unknown> = {}) {
  const ssh = fakeSsh();
  const mac = ssh.home(MAC);
  fakeMacTools(mac);
  addImage(mac);
  const config = tartConfig(values);
  const storage = new MemoryStorage();
  const context = testContext(storage);
  const make = (on = context) => {
    const backend = new TartBackend(config, on, FAKES);
    made.push(backend);
    return backend;
  };
  const owners = join(mac, ".bb-box", "tart", "owners");
  return { ssh, mac, owners, context, make, backend: make() };
}

let counter = 0;
function identity(kind = "macos-desktop", threadId = "thr_abc123"): BoxIdentity {
  counter++;
  return { boxId: `bx${counter}`, threadId, name: `calm-otter-${counter}`, kind, createdAt: 1_790_000_000_000 };
}

function hooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push("claim");
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks: value, events, claimed, timings };
}

const releasing: ReleaseHooks = { resetting: async () => {}, timing: () => {} };
const signal = () => AbortSignal.timeout(30_000);

test("parses Macs, one per line, and refuses what it cannot use", () => {
  assert.deepEqual(parseHosts("mac1 admin@192.0.2.20\n# a comment\nmac2 bbbox-admin@mac2.example:2222").hosts, [
    { name: "mac1", user: "admin", address: "192.0.2.20", port: 22 },
    { name: "mac2", user: "bbbox-admin", address: "mac2.example", port: 2222 },
  ]);
  assert.match(parseHosts("mac1 192.0.2.20").problems[0]!, /user@address/);
  assert.match(parseHosts("mac1 a@b\nmac1 a@c").problems[0]!, /twice/);
  const parsed = parseTartSettings({ "tart-enabled": true, "tart-hosts": "mac1 a@b", "tart-host-keys": "", "tart-vms-per-host": 3 });
  assert.ok(parsed.enabled && !parsed.ok);
  assert.ok(parsed.problems.some((problem) => /host key/.test(problem)));
  assert.ok(parsed.problems.some((problem) => /VMs per Mac/.test(problem)));
  assert.deepEqual(parseTartSettings({}), { enabled: false });
});

test("offers macos and macos-desktop from the image, each only when it has one", () => {
  assert.deepEqual(
    new TartBackend(tartConfig(), testContext()).kinds().map((kind) => kind.id),
    ["macos", "macos-desktop"],
  );
  const desktopOnly = new TartBackend(tartConfig({ "tart-macos-image": "" }), testContext()).kinds();
  assert.deepEqual(desktopOnly.map((kind) => kind.id), ["macos-desktop"]);
  const desktop = desktopOnly[0]!.capabilities;
  assert.equal(desktop.os, "macos");
  assert.equal(desktop.arch, "arm64");
  assert.equal(desktop.gpu, false);
  assert.equal(desktop.command?.inDesktopSession, false);
  assert.deepEqual(desktop.displays, [{ id: "desktop", protocol: "rfb", resizable: false }]);
  assert.equal(desktop.computerUse?.socket, "/Users/admin/Library/Caches/cua-driver/cua-driver.sock");
});

test("reads Tart's pretty-printed listing and its VNC URL", () => {
  const state = parseState(
    [
      "@version",
      "2.30.0",
      "@list",
      '[\n  {\n    "Accessed" : "1 minute ago",\n    "Name" : "bb-box-bx1",\n    "Running" : true,\n    "Source" : "local",\n    "State" : "running"\n  }\n]',
      "@configs",
      "=bb-box-bx1",
      '{  "os" : "darwin",  "cpuCount" : 4,  "memorySize" : 8589934592}',
      "@owners",
      "=bb-box-bx1",
      "install=k3v9q2m7xa",
      "box=bx1",
      "@memory",
      String(128 * GiB),
      "@disk",
      "1900000000 150000000",
      "@arch",
      "arm64",
      "@macos",
      "27.0",
    ].join("\n"),
  );
  assert.deepEqual(state.vms, [{ name: "bb-box-bx1", state: "running", running: true }]);
  assert.deepEqual(state.configs.get("bb-box-bx1"), { os: "darwin", memoryMiB: 8192, cpus: 4 });
  assert.deepEqual(state.owners.get("bb-box-bx1"), { install: "k3v9q2m7xa", box: "bx1" });
  assert.equal(state.memoryMiB, 131072);
  assert.equal(state.disk.freeMiB, Math.floor(150000000 / 1024));
  assert.deepEqual(parseVnc("vnc://:open-sesame-word-four@127.0.0.1:61234\n"), { port: 61234, password: "open-sesame-word-four" });
  assert.equal(parseVnc(""), null);
});

test("acquire claims the VM before it writes anything, then clones, starts and reaches it through the Mac", async () => {
  const { ssh, owners, backend } = setup();
  const box = identity();
  const recorded = hooks();
  const guest = await backend.acquire(box, null, recorded.hooks, signal());
  assert.deepEqual(recorded.events, ["claim", "starting", "claim"]);
  assert.deepEqual(recorded.claimed.at(-1), guest, "claimed again with its address");
  assert.equal(recorded.claimed[0]!.ref, `bb-box-${box.boxId}`);
  assert.deepEqual(recorded.claimed[0]!.data, { box: box.boxId });
  assert.deepEqual(Object.keys(recorded.timings), ["place", "clone", "start", "network", "ssh"]);
  assert.equal(guest.host, "mac1");
  assert.match(guest.address ?? "", /^192\.168\.64\.\d+$/);
  const owner = readFileSync(join(owners, guest.ref), "utf8");
  assert.equal(owner, `install=test\nkind=macos-desktop\nbox=${box.boxId}\nthread=thr_abc123\nname=${box.name}\ncreated=1790000000000\n`);
  assert.equal(await backend.power(guest), "running");

  const { command, displays, access } = await backend.transports(guest, box.kind);
  assert.equal((await command!.run("echo hello")).stdout, "hello\n");
  assert.deepEqual(access?.ssh?.jump, { host: MAC, port: 22, user: "bbbox-admin", hostKeys: [`${MAC} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests`] });
  assert.equal(access?.ssh?.user, "admin");
  const opened = await displays[0]!.open();
  assert.equal(opened.route.type, "command");
  assert.ok(opened.route.type === "command" && opened.route.argv.includes("-W") && opened.route.argv.at(-1) === `bbbox-admin@${MAC}`);
  assert.match(opened.auth.type === "vnc-password" ? opened.auth.password : "", /^fake-pass-word-\d+$/);

  // The VM's commands went to the VM, the rest to the Mac.
  const targets = new Set(ssh.log().map((entry) => entry.target));
  assert.ok(targets.has(`bbbox-admin@${MAC}`) && targets.has(`admin@${guest.address}`));
  await backend.release(guest, releasing);
});

test("stop suspends the VM and start resumes it; the VM counts against its Mac only while it runs", async () => {
  const { mac, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  const used = async () => (await backend.capacity("macos", [])).hosts[0]!.limits.find((limit) => limit.resource === "guests")!.used;
  assert.equal(await used(), 1);
  await backend.stop(guest);
  assert.equal(await backend.power(guest), "stopped");
  assert.ok(existsSync(join(mac, ".tart", "vms", guest.ref, "state.vzvmsave")), "suspended, not shut down");
  assert.equal(await used(), 0);
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  assert.equal(await used(), 1);
  await backend.release(guest, releasing);
});

test("a Mac takes two macOS VMs; the third is refused with what to release", async () => {
  const { owners, backend } = setup();
  const first = await backend.acquire(identity(), null, hooks().hooks, signal());
  const second = await backend.acquire(identity("macos"), null, hooks().hooks, signal());
  const capacity = await backend.capacity("macos", []);
  assert.equal(capacity.ok, false);
  assert.match(capacity.message!, /mac1 runs 2 of the 2 macOS VMs/);
  assert.match(capacity.message!, new RegExp(first.ref));
  const third = identity();
  await assert.rejects(backend.acquire(third, null, hooks().hooks, signal()), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
  assert.equal(existsSync(join(owners, `bb-box-${third.boxId}`)), false);
  await backend.release(first, releasing);
  await backend.release(second, releasing);
});

test("a VM the framework refuses to run, as when another app runs VMs, is no_capacity and leaves nothing", async () => {
  const { mac, owners, backend } = setup({ "tart-vms-per-host": 2 });
  // Two running VMs Tart lists as Linux, which capacity does not count but the framework does.
  for (const name of ["other-a", "other-b"]) {
    addImage(mac, name, "linux");
    writeFileSync(join(mac, ".tart", "vms", name, "running"), String(process.pid));
  }
  const room = (await backend.capacity("macos", [])).hosts[0]!;
  assert.equal(room.limits.find((limit) => limit.resource === "guests")!.used, 0, "Linux VMs do not count against the two");
  assert.equal(room.limits.find((limit) => limit.resource === "memory")!.used, 16384, "but their memory does");
  const box = identity();
  await assert.rejects(backend.acquire(box, null, hooks().hooks, signal()), (error: unknown) => {
    assert.ok(error instanceof BackendError && error.code === "no_capacity", String(error));
    assert.match(error.message, /exceeds the system limit/);
    return true;
  });
  assert.equal(existsSync(join(owners, `bb-box-${box.boxId}`)), false);
  assert.equal(existsSync(join(mac, ".tart", "vms", `bb-box-${box.boxId}`)), false);
});

test("release deletes the VM, its output and last its owner file; again is fine; then the box is gone", async () => {
  const { mac, owners, backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().hooks, signal());
  await backend.release(guest, releasing);
  assert.equal(existsSync(join(mac, ".tart", "vms", guest.ref)), false);
  assert.equal(existsSync(join(owners, guest.ref)), false);
  assert.equal(existsSync(join(mac, ".bb-box", "tart", "run", `${guest.ref}.out`)), false);
  await backend.release(guest, releasing);
  assert.equal(await backend.power(guest), null);
  await assert.rejects(backend.start(guest), (error: unknown) => error instanceof BackendError && error.code === "gone");
});

test("a new instance on empty storage finds this install's VMs and their owners, and no other install's", async () => {
  const { make, backend } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().hooks, signal());
  const other = make(testContext(new MemoryStorage(), "other"));
  const theirs = await other.acquire(identity(), null, hooks().hooks, signal());

  const fresh = make(testContext(new MemoryStorage()));
  const held = await fresh.held();
  assert.deepEqual(
    held.map((entry) => ({ ref: entry.ref, host: entry.host, owner: entry.owner, power: entry.power, data: entry.data })),
    [{ ref: guest.ref, host: "mac1", owner: { boxId: box.boxId, threadId: box.threadId, name: box.name, kind: box.kind, createdAt: box.createdAt }, power: "running", data: { box: box.boxId } }],
  );
  // To this install the other's VM does not exist, and it is left alone.
  assert.equal(await fresh.power(theirs), null);
  await assert.rejects(fresh.stop(theirs), (error: unknown) => error instanceof BackendError && error.code === "gone");
  await fresh.release(theirs, releasing);
  assert.equal(await other.power(theirs), "running");
  // It reaches this install's VM from the guest alone, asking the Mac for its address.
  const { command } = await fresh.transports({ ...held[0]!, address: null }, box.kind);
  assert.equal((await command!.run("echo again")).stdout, "again\n");

  const doctor = await fresh.doctor();
  assert.ok(doctor.ok, JSON.stringify(doctor.checks));
  assert.ok(doctor.notes.some((note) => /1 of install other/.test(note)));
  await fresh.release(guest, releasing);
  await other.release(theirs, releasing);
});

test("doctor says what is missing on the Mac", async () => {
  const { ssh, backend, make } = setup({ "tart-macos-desktop-image": "bb-box-missing" });
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  const image = report.checks.find((check) => check.id === "image.mac1.macos-desktop")!;
  assert.equal(image.status, "fail");
  assert.match(image.fix!, /prepare-image\.sh/);
  assert.ok(report.notes.some((note) => /authorized_keys: ssh-ed25519 /.test(note)));
  ssh.down(MAC);
  const down = await make().doctor();
  assert.equal(down.checks.find((check) => check.id === "host.mac1")!.status, "fail");
  assert.equal(down.checks.find((check) => check.id === "image.mac1.macos")!.status, "skipped");
});
