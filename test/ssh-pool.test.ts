// The SSH host pool backend on fake SSH, with test/fake-machine.mjs as each
// machine's helper: its settings, the conformance suite, what the pool does
// when a reset fails, is cut short or leaves a machine dirty, and its Macs.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { overlapChecks } from "../src/backends/index.ts";
import { SshPoolBackend, type SshPoolBackendOptions } from "../src/backends/ssh-pool/backend.ts";
import { hostKeysFor, parseSshPoolSettings, parseTarget, type SshPoolConfig } from "../src/backends/ssh-pool/config.ts";
import { CUA_VERSION, TartBackend } from "../src/backends/tart/backend.ts";
import { BackendError, type AcquireHooks, type Backend, type BackendStorage, type BoxIdentity, type BoxSize, type Capacity, type Guest } from "../src/backends/types.ts";
import { conformance, identity, recordingHooks, releaseHooks, sizeOf } from "./conformance/suite.ts";
import { FAKE_MAC, tartConfig } from "./fake-mac.ts";
import { FAKE_SSH_BINARY, KEY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const HELPER = `node ${new URL("./fake-machine.mjs", import.meta.url).pathname}`;
const HOST_KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIIDbH0n7Bm2fQzZ0lH8w5j0c0pYh7J6Hq4Xb1x2u3v4w";
const fake = fakeSsh();

/** A fake pool machine at `host`, set up as setup.sh leaves one, with flags for the fake helper. */
function machine(host: string, flags: Record<string, string> = {}): void {
  const state = join(fake.home(host), ".bb-box-state");
  rmSync(state, { recursive: true, force: true });
  mkdirSync(join(state, "flags"), { recursive: true });
  writeFileSync(join(state, "generation"), "0\n");
  for (const [name, value] of Object.entries(flags)) setFlag(host, name, value);
}

function setFlag(host: string, name: string, value = ""): void {
  writeFileSync(join(fake.home(host), ".bb-box-state", "flags", name), value);
}

function clearFlag(host: string, name: string): void {
  rmSync(join(fake.home(host), ".bb-box-state", "flags", name), { force: true });
}

function write(host: string, file: string, text: string): void {
  writeFileSync(join(fake.home(host), ".bb-box-state", file), text);
}

function settings(lines: string, values: Record<string, unknown> = {}): Record<string, unknown> {
  const hosts = [...lines.matchAll(/(?:@|\s)(192\.0\.2\.\d+)(?::(\d+))?/g)].map(([, host, port]) => (port ? `[${host}]:${port}` : host));
  return {
    "ssh-pool-enabled": true,
    "ssh-pool-machines": lines,
    "ssh-pool-known-hosts": [...new Set(hosts)].map((host) => `${host} ${HOST_KEY}`).join("\n"),
    "ssh-pool-ssh-private-key": "",
    ...values,
  };
}

function config(lines: string): SshPoolConfig {
  const result = parseSshPoolSettings(settings(lines));
  assert.ok(result.enabled && result.ok, JSON.stringify(result));
  return result.config;
}

function problems(values: Record<string, unknown>): string {
  const result = parseSshPoolSettings(values);
  assert.ok(result.enabled && !result.ok, JSON.stringify(result));
  return result.problems.join(" ");
}

const sleeps: number[] = [];
function pool(lines: string, storage: BackendStorage = new MemoryStorage(), installId = "test", options: SshPoolBackendOptions = {}) {
  const context = testContext(storage, installId);
  const backend = new SshPoolBackend(config(lines), context, {
    sshBinary: FAKE_SSH_BINARY,
    helperCommand: HELPER,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readyTimeoutMs: 0,
    resetPollMs: 1,
    ...options,
  });
  return { backend, context, storage };
}

async function acquire(backend: Backend, kind = "linux", size = sizeOf(kind)): Promise<{ box: BoxIdentity; guest: Guest }> {
  const box = identity(kind, size);
  return { box, guest: await backend.acquire(box, null, recordingHooks().hooks, AbortSignal.timeout(20_000)) };
}

async function member(backend: Backend, ref: string) {
  const found = (await backend.members!()).find((other) => other.ref === ref);
  assert.ok(found, `${ref} is a member`);
  return found;
}

describe("an SSH host pool with no machines yet", () => {
  it("fails its doctor, and gives the public key setup.sh needs first", async () => {
    const { backend } = pool("");
    const doctor = await backend.doctor();
    assert.equal(doctor.ok, false);
    assert.equal(doctor.checks.find((check) => check.id === "machines")?.status, "fail");
    assert.ok(doctor.notes.some((note) => /^Give setup\/ssh-pool\/setup\.sh, or setup-mac\.sh on a Mac, this public key with --key, .*: ssh-ed25519 /.test(note)));
    assert.deepEqual(backend.kinds(), []);
  });
});

describe("SSH host pool settings", () => {
  it("parse a machine per line, with defaults", () => {
    const parsed = config("build-1 192.0.2.21 linux\nbuild-2 ops@192.0.2.22:2222 linux via=jump@192.0.2.9 reset=machine labels=fast,big # the big one");
    assert.deepEqual(parsed.machines[0], {
      name: "build-1",
      admin: { host: "192.0.2.21", port: 22, user: "bbbox-admin" },
      jump: null,
      kinds: ["linux"],
      os: "linux",
      docker: false,
      reset: "home",
      labels: [],
    });
    assert.deepEqual(parsed.machines[1], {
      name: "build-2",
      admin: { host: "192.0.2.22", port: 2222, user: "ops" },
      jump: { host: "192.0.2.9", port: 22, user: "jump" },
      kinds: ["linux"],
      os: "linux",
      docker: true,
      reset: "machine",
      labels: ["fast", "big"],
    });
    assert.equal(parsed.privateKey, null, "bb-box makes a key when none is given");
  });

  it("give Docker on a machine with reset=machine, and accept the kind IDs from before 027 and linux-docker on its line (041)", () => {
    const old = config("old 192.0.2.23 linux-headless,linux-headless-docker reset=machine").machines[0]!;
    assert.deepEqual([old.kinds, old.docker], [["linux"], true]);
    const alone = config("d 192.0.2.24 linux-docker reset=machine").machines[0]!;
    assert.deepEqual([alone.kinds, alone.docker], [["linux"], true]);
    const both = config("b 192.0.2.25 linux,linux-docker reset=machine").machines[0]!;
    assert.deepEqual([both.kinds, both.docker], [["linux"], true]);
  });

  it("take IPv6 addresses in brackets and known_hosts names off port 22", () => {
    assert.deepEqual(parseTarget("[2001:db8::5]:2200", "bbbox-admin"), { host: "2001:db8::5", port: 2200, user: "bbbox-admin" });
    assert.equal(parseTarget("2001:db8::5", "bbbox-admin"), null, "an IPv6 address needs brackets");
    assert.equal(parseTarget("host:0", "bbbox-admin"), null);
    const lines = [`[192.0.2.22]:2222 ${HOST_KEY}`, `192.0.2.21 ${HOST_KEY}`];
    assert.deepEqual(hostKeysFor(lines, { host: "192.0.2.22", port: 2222 }), [lines[0]]);
    assert.deepEqual(hostKeysFor(lines, { host: "192.0.2.24", port: 22 }), []);
    const hashed = [`|1|abc=|def= ${HOST_KEY}`];
    assert.deepEqual(hostKeysFor(hashed, { host: "192.0.2.24", port: 22 }), hashed, "a hashed line may be for any host");
  });

  it("are off unless enabled", () => {
    assert.deepEqual(parseSshPoolSettings({ "ssh-pool-machines": "a 192.0.2.21 linux" }), { enabled: false });
  });

  it("say what to fix", () => {
    const empty = parseSshPoolSettings(settings(""));
    assert.ok(empty.enabled && empty.ok, "a pool with no machines yet parses, so its doctor can give the public key");
    assert.match(problems(settings("Build 192.0.2.21 linux")), /lower-case letters/);
    assert.match(problems(settings("a 192.0.2.21 linux-desktop")), /cannot serve kind "linux-desktop"/);
    assert.match(problems(settings("a 192.0.2.21 linux-docker")), /needs reset=machine/);
    assert.match(problems(settings("a 192.0.2.21 linux-arm64-docker reset=machine")), /cannot serve kind "linux-arm64-docker"/);
    assert.match(problems(settings("a 192.0.2.21 linux reset=sometimes")), /reset=home or reset=machine/);
    assert.match(problems(settings("a 192.0.2.21 linux colour=blue")), /unknown option "colour=blue"/);
    assert.match(problems(settings("a 192.0.2.21 linux\na 192.0.2.22 linux")), /listed twice/);
    assert.match(problems(settings("a 192.0.2.21 linux\nb bbbox-admin@192.0.2.21 linux")), /same address/);
    assert.match(problems(settings("a 192.0.2.21 linux", { "ssh-pool-known-hosts": "" })), /host key of machine a, 192\.0\.2\.21/);
    assert.match(problems(settings("a 192.0.2.21 linux via=192.0.2.9")), /jump host, 192\.0\.2\.9/);
    assert.match(problems(settings("a 192.0.2.21 linux", { "ssh-pool-known-hosts": `192.0.2.21 ${HOST_KEY}\nnonsense` })), /whole known_hosts lines/);
    assert.match(problems(settings("a 192.0.2.21 linux", { "ssh-pool-ssh-private-key": "not a key" })), /whole SSH private key/);
    const keyed = parseSshPoolSettings(settings("a 192.0.2.21 linux", { "ssh-pool-ssh-private-key": KEY }));
    assert.ok(keyed.enabled && keyed.ok && keyed.config.privateKey?.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  });
});

// Two machines serve linux, so two installs can each hold one. Only the second has reset=machine, so neither gives Docker.
machine("192.0.2.31");
machine("192.0.2.32", { docker: "", hook: "", "restore-steps": "2" });
const conformanceLines = "c1 192.0.2.31 linux\nc2 192.0.2.32 linux reset=machine";
await conformance({
  name: "SSH host pool on fakes",
  storage: new MemoryStorage(),
  create: (storage, installId) => pool(conformanceLines, storage, installId).backend,
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    docker: "the fake SSH runs commands on the test machine",
    size: "the fake SSH runs commands on the test machine",
  },
  timeoutMs: 20_000,
});

describe("SSH host pool", () => {
  it("offers linux, with Docker and root only when every machine has a whole-machine reset, which it then restores (041)", () => {
    const home = pool("h1 192.0.2.41 linux").backend;
    assert.deepEqual(home.kinds().map((kind) => kind.id), ["linux"]);
    assert.equal(home.restores, "home");
    assert.deepEqual(home.kinds()[0]!.capabilities.features, []);
    assert.equal(home.kinds()[0]!.capabilities.command?.admin, false, "a linux box cannot become root");
    const whole = pool("w1 192.0.2.42 linux reset=machine").backend;
    assert.deepEqual(whole.kinds().map((kind) => kind.id), ["linux"], "linux-docker is an alias, not an offer (041)");
    assert.equal(whole.restores, "machine");
    assert.deepEqual(whole.kinds()[0]!.capabilities.features, ["docker"]);
    assert.equal(whole.kinds()[0]!.capabilities.command?.admin, true, "Docker gives root, so the box says so");
    const mixed = pool("w1 192.0.2.42 linux-docker reset=machine\nh1 192.0.2.41 linux").backend;
    assert.deepEqual(mixed.kinds()[0]!.capabilities.features, [], "each box of a backend's offer has Docker, or none does");
    assert.equal(mixed.kinds()[0]!.capabilities.command?.admin, false);
    assert.equal(mixed.restores, "home");
  });

  it("gives Docker access over SSH when every machine has a whole-machine reset, and claims machines in turn", async () => {
    machine("192.0.2.43", { docker: "", hook: "" });
    machine("192.0.2.44", { docker: "", hook: "" });
    const { backend } = pool("d1 192.0.2.43 linux reset=machine\nd2 192.0.2.44 linux,linux-docker reset=machine");
    const { guest } = await acquire(backend);
    assert.equal(guest.ref, "d1");
    assert.deepEqual(guest.data, { box: guest.data!.box, generation: 0, user: "bbx-0" });
    const transports = await backend.transports(guest, "linux");
    assert.equal(transports.access?.dockerHost, "ssh://bbx-0@192.0.2.43");
    assert.equal(transports.access?.ssh?.user, "bbx-0");
    const second = await acquire(backend);
    assert.equal(second.guest.ref, "d2");
    await assert.rejects(backend.capacity("linux-docker", sizeOf("linux"), []), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
    const full = await backend.capacity("linux", sizeOf("linux"), []);
    assert.equal(full.ok, false);
    assert.match(full.message!, /Of the 2 machines that serve linux, 2 are held by this install's boxes/);
    await assert.rejects(acquire(backend), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
    await backend.release(guest, releaseHooks().hooks);
    await backend.release(second.guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("claims machines it first sees free together in the order they are listed, whichever answers first", async () => {
    machine("192.0.2.78", { "slow-status": "300" });
    machine("192.0.2.79");
    const { backend } = pool("first 192.0.2.78 linux\nsecond 192.0.2.79 linux");
    const one = await acquire(backend);
    const two = await acquire(backend);
    assert.deepEqual([one.guest.ref, two.guest.ref], ["first", "second"]);
    await backend.release(one.guest, releaseHooks().hooks);
    await backend.release(two.guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("gives no Docker in a pool where some machines have no whole-machine reset, and its doctor says so", async () => {
    machine("192.0.2.67", { hook: "" });
    machine("192.0.2.68");
    const { backend } = pool("both 192.0.2.67 linux reset=machine\nplain 192.0.2.68 linux");
    const { guest } = await acquire(backend);
    assert.equal((await backend.transports(guest, "linux")).access?.dockerHost, null);
    const doctor = await backend.doctor();
    const docker = doctor.checks.find((check) => check.id === "docker");
    assert.equal(docker?.status, "warn");
    assert.match(docker!.detail, /^plain has no whole-machine reset, so none of the pool's linux boxes have Docker, and each says No Docker\.$/);
    assert.match(docker!.fix!, /^To give them Docker, set up a whole-machine reset on plain and add reset=machine to its line, /);
    assert.equal(doctor.checks.find((check) => check.id === "machine.both.docker"), undefined, "both lacks Docker, which no box here gets");
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("does not lend a machine with reset=machine but no Docker when the pool's boxes have Docker, and its doctor fails it (041)", async () => {
    machine("192.0.2.74", { hook: "" });
    machine("192.0.2.75", { docker: "", hook: "" });
    const { backend } = pool("bare 192.0.2.74 linux reset=machine\nfull 192.0.2.75 linux reset=machine");
    assert.deepEqual(backend.kinds()[0]!.capabilities.features, ["docker"]);
    const { guest } = await acquire(backend);
    assert.equal(guest.ref, "full", "bare has no Docker to give");
    const doctor = await backend.doctor();
    const bare = doctor.checks.find((check) => check.id === "machine.bare.docker");
    assert.equal(bare?.status, "fail");
    assert.equal(bare!.detail, "Docker is not installed. Its line has reset=machine, so its boxes get Docker.");
    assert.match(bare!.fix!, /^Install Docker on bare, /);
    assert.equal(doctor.checks.find((check) => check.id === "machine.full.docker")?.status, "ok");
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("claims the smallest free machine of at least the size, counting 90% of the memory as all of it (028)", async () => {
    // MemTotal leaves out what the kernel keeps: 7861 MiB is an 8 GiB machine, 2900 MiB is less than 4 GiB.
    machine("192.0.2.46", { cores: "16", memory: "64000", disk: "500" });
    machine("192.0.2.47", { cores: "4", memory: "7861", disk: "40" });
    machine("192.0.2.48", { cores: "2", memory: "2900", disk: "40" });
    const { backend } = pool("large 192.0.2.46 linux\nmedium 192.0.2.47 linux\ntiny 192.0.2.48 linux");
    const size = (cores: number, memoryGiB: number, diskGiB: number | null = null): BoxSize => ({ cores, memoryMiB: memoryGiB * 1024, diskGiB });
    const small = await acquire(backend, "linux", size(2, 4));
    assert.equal(small.guest.ref, "medium", "tiny has less than 90% of 4 GiB");
    assert.deepEqual(small.guest.size, { cores: 4, memoryMiB: 7861, diskGiB: null }, "the machine's own cores and memory");
    assert.deepEqual((await backend.held()).find((guest) => guest.ref === "medium")?.size, small.guest.size, "held reads the size");
    await backend.release(small.guest, releaseHooks().hooks);
    const disked = await acquire(backend, "linux", size(2, 4, 100));
    assert.equal(disked.guest.ref, "large", "only large has 100 GiB free");
    const refused = await backend.capacity("linux", size(8, 16), []);
    assert.equal(refused.ok, false);
    assert.match(refused.message!, /free for linux at 8 cores, 16 GiB memory\. .*2 smaller than 8 cores, 16 GiB memory \(medium: 4 cores, 7\.7 GiB memory, 40 GiB free disk; tiny: .*\)\. Release a box to free one, or ask for a smaller size\./);
    assert.equal((await backend.capacity("linux", size(8, 4), [])).ok, false, "no free machine has 8 cores");
    assert.equal((await backend.capacity("linux", size(1, 3), [])).ok, true, "tiny serves a box of 3 GiB");
    await backend.release(disked.guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("the doctor warns about a machine that holds no preset of its kinds, counting 90% of the memory as all of it (#74)", async () => {
    machine("192.0.2.47", { cores: "4", memory: "7861", disk: "40" });
    machine("192.0.2.48", { cores: "2", memory: "2900", disk: "40" });
    const { backend } = pool("medium 192.0.2.47 linux\ntiny 192.0.2.48 linux");
    const doctor = await backend.doctor();
    const sizes = (name: string) => doctor.checks.find((check) => check.id === `machine.${name}.sizes`)!;
    assert.deepEqual([sizes("medium").name, sizes("medium").status, sizes("medium").detail], ["medium: box sizes", "ok", "medium holds linux boxes at the default size."]);
    assert.equal(sizes("tiny").status, "warn");
    assert.equal(sizes("tiny").detail, "tiny has 2 cores, 2.8 GiB memory, 40 GiB free disk. It cannot hold a linux box at any of its presets, the smallest 2 cores, 4 GiB memory.");
    assert.match(sizes("tiny").fix!, /^Give tiny more memory, or make the presets of linux smaller/);
    assert.equal(doctor.ok, true, "a warning");
    await backend.dispose();
  });

  it("lends a machine with a whole-machine reset last in a mixed pool, even when it has been free longer", async () => {
    machine("192.0.2.76", { hook: "" });
    machine("192.0.2.77");
    const { backend } = pool("whole 192.0.2.76 linux reset=machine\nhome 192.0.2.77 linux");
    const first = await acquire(backend);
    assert.equal(first.guest.ref, "home");
    await backend.release(first.guest, releaseHooks().hooks);
    const next = await acquire(backend);
    assert.equal(next.guest.ref, "home", "home has been free for less time than whole, but its reset needs no restart");
    await backend.release(next.guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("counts acquires that have not claimed a machine yet", async () => {
    machine("192.0.2.45");
    const { backend } = pool("p 192.0.2.45 linux");
    assert.equal((await backend.capacity("linux", sizeOf("linux"), [])).ok, true);
    const pending = await backend.capacity("linux", sizeOf("linux"), [{ kind: "linux", size: sizeOf("linux") }]);
    assert.equal(pending.ok, false, "the one free machine is spoken for");
    assert.equal(pending.hosts[0]!.limits[0]!.used, 1);
    await assert.rejects(backend.capacity("linux-desktop", sizeOf("linux-desktop"), []), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
    await backend.dispose();
  });

  it("gives each acquire that has not claimed the machine its claim would take, whatever its size", async () => {
    machine("192.0.2.64", { cores: "2", memory: "3900" });
    machine("192.0.2.65", { cores: "2", memory: "3900" });
    machine("192.0.2.66", { cores: "8", memory: "15900" });
    const { backend } = pool("s 192.0.2.64 linux\nd 192.0.2.65 linux\nl 192.0.2.66 linux");
    const small = sizeOf("linux");
    const large: BoxSize = { cores: 8, memoryMiB: 16384, diskGiB: null };
    const used = (capacity: Capacity) => capacity.hosts[0]!.limits[0]!.used;

    const before = await backend.capacity("linux", large, [{ kind: "linux", size: small }]);
    assert.equal(before.ok, true, "the small box will claim s, which leaves l");
    assert.equal(used(before), 2, "s is spoken for, and d is too small");
    const another = await backend.capacity("linux", small, [{ kind: "linux", size: small }]);
    assert.equal(another.ok, true, "the small box will claim s, which leaves d and l");
    const all = await backend.capacity("linux", small, [{ kind: "linux", size: small }, { kind: "linux", size: small }, { kind: "linux", size: small }]);
    assert.equal(all.ok, false, "the small boxes will claim s, d and then l");
    assert.match(all.message!, /Of the 3 machines that serve linux, 3 about to be claimed by other boxes\. Release a box to free one\./);
    const refused = await backend.capacity("linux", large, [{ kind: "linux", size: large }]);
    assert.equal(refused.ok, false);
    assert.equal(used(refused), 3);
    assert.match(refused.message!, /, 2 smaller than 8 cores, 16 GiB memory \(s: .*; d: .*\), 1 about to be claimed by other boxes\. Release a box to free one, or ask for a smaller size\./);

    // A box that has claimed shows as held, so capacity does not give it another machine.
    let go = () => {};
    const gate = new Promise<void>((resolve) => (go = resolve));
    let claimed = () => {};
    const atClaim = new Promise<void>((resolve) => (claimed = resolve));
    const hooks: AcquireHooks = {
      ...recordingHooks().hooks,
      starting: async () => {
        claimed();
        await gate;
      },
    };
    const acquiring = backend.acquire(identity("linux", small), null, hooks, AbortSignal.timeout(20_000));
    await atClaim;
    const during = await backend.capacity("linux", large, [{ kind: "linux", size: small }]);
    assert.equal(during.ok, true, "the small box holds s");
    assert.equal(used(during), 2);
    assert.equal(used(await backend.capacity("linux", small, [{ kind: "linux", size: small }])), 1, "the small box does not also take d");
    go();
    const guest = await acquiring;
    assert.equal(guest.ref, "s");
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("puts a machine whose reset failed out of service, and returns it to service with a reset", async () => {
    machine("192.0.2.51");
    const { backend, context } = pool("f 192.0.2.51 linux");
    const { guest } = await acquire(backend);
    setFlag("192.0.2.51", "fail-reset", "the disk is full");
    const recorded = releaseHooks();
    await backend.release(guest, recorded.hooks);
    assert.deepEqual(recorded.events, ["resetting"]);
    assert.match(context.errors.join(" "), /reset f: Its reset failed: reset-machine exited with 1: the disk is full/);
    const out = await member(backend, "f");
    assert.equal(out.state, "out-of-service");
    assert.match(out.reason!, /the disk is full/);
    assert.equal(out.generation, 0);
    assert.equal(await backend.power(guest), null, "the box is gone");
    assert.deepEqual(await backend.held(), [], "the sweep leaves a machine out of service alone");
    const capacity = await backend.capacity("linux", sizeOf("linux"), []);
    assert.equal(capacity.ok, false);
    assert.match(capacity.message!, /1 out of service \(f: Its reset failed/);
    const doctor = await backend.doctor();
    const state = doctor.checks.find((check) => check.id === "machine.f.state");
    assert.equal(state?.status, "warn");
    assert.match(state!.fix!, /sudo \/usr\/local\/libexec\/bb-box\/machine reset"/);
    // Releasing again does nothing.
    await backend.release(guest, releaseHooks().hooks);

    await assert.rejects(backend.returnToService!("f"), /still out of service\. Its reset failed/);
    clearFlag("192.0.2.51", "fail-reset");
    await backend.returnToService!("f");
    const back = await member(backend, "f");
    assert.equal(back.state, "free");
    assert.equal(back.generation, 1, "the reset that failed has now completed");
    await backend.returnToService!("f");
    assert.equal((await member(backend, "f")).generation, 1, "returning a free machine to service does nothing");
    const next = await acquire(backend);
    assert.equal(next.guest.data?.user, "bbx-1");
    await assert.rejects(backend.returnToService!("f"), /f is held by box .+\. Release the box first\./);
    await backend.release(next.guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("finishes a reset cut short, from the machine's marker", async () => {
    machine("192.0.2.52");
    const { backend } = pool("c 192.0.2.52 linux");
    const { guest } = await acquire(backend);
    setFlag("192.0.2.52", "cut-reset");
    await assert.rejects(backend.release(guest, releaseHooks().hooks), /stopped answering during its reset/);
    assert.equal((await member(backend, "c")).state, "resetting");
    assert.equal(await backend.power(guest), null);
    // As after a restart that lost bb-box's storage: the machine says it is part-way through a reset.
    const fresh = pool("c 192.0.2.52 linux").backend;
    const [held] = await fresh.held();
    assert.ok(held);
    assert.equal(held.owner, null, "a machine mid-reset names no box, so the sweep releases it");
    assert.equal(held.power, "running");
    await fresh.release(held, releaseHooks().hooks);
    assert.deepEqual(await member(fresh, "c"), { ...(await member(fresh, "c")), state: "free", generation: 1 });
    // The first instance's release, tried again, finds nothing to do.
    await backend.release(guest, releaseHooks().hooks);
    assert.equal((await member(backend, "c")).generation, 1);
    await backend.dispose();
    await fresh.dispose();
  });

  it("keeps a dirty machine out of service until someone resets it", async () => {
    machine("192.0.2.53", { dirty: "/home/bbx-7" });
    const { backend } = pool("d 192.0.2.53 linux");
    const out = await member(backend, "d");
    assert.equal(out.state, "out-of-service");
    assert.match(out.reason!, /An earlier box left \/home\/bbx-7/);
    await assert.rejects(acquire(backend), (error: unknown) => error instanceof BackendError && error.code === "no_capacity");
    // A reset that leaves it dirty keeps it out of service.
    await assert.rejects(backend.returnToService!("d"), /The reset left \/home\/bbx-7/);
    clearFlag("192.0.2.53", "dirty");
    // As the operator does on the machine, as the doctor says: a reset with no input.
    write("192.0.2.53", "flags/.keep", "");
    const reset = await fake.ssh.run({ host: "192.0.2.53", port: 22, user: "bbbox-admin", hostKeys: [] }, `${HELPER} reset </dev/null`, { timeoutMs: 20_000 });
    assert.equal(reset.exitCode, 0, reset.stderr);
    const back = await member(backend, "d");
    assert.equal(back.state, "free", "it is clean at a later generation");
    assert.equal(back.generation, 1);
    const { guest } = await acquire(backend);
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("waits for a whole-machine reset to finish", async () => {
    machine("192.0.2.54", { docker: "", hook: "", "restore-steps": "3" });
    const { backend } = pool("m 192.0.2.54 linux reset=machine");
    const { guest } = await acquire(backend);
    sleeps.length = 0;
    await backend.release(guest, releaseHooks().hooks);
    assert.deepEqual(sleeps, [1, 1, 1], "it asked again while the reset ran");
    assert.equal((await member(backend, "m")).generation, 1);
    await backend.dispose();
  });

  it("keeps a box on a machine that does not answer, and resets it when it does", async () => {
    machine("192.0.2.55");
    const { backend, storage } = pool("u 192.0.2.55 linux");
    const { box, guest } = await acquire(backend);
    fake.down("192.0.2.55");
    try {
      assert.equal(await backend.power(guest), "unknown");
      const [held] = await backend.held();
      assert.equal(held?.owner?.boxId, box.boxId, "bb-box's record names the box");
      assert.equal(held?.power, "unknown");
      const out = await member(backend, "u");
      assert.equal(out.state, "out-of-service");
      assert.match(out.reason!, /does not answer over SSH/);
      await assert.rejects(backend.release(guest, releaseHooks().hooks), /cannot be reset now/);
      const doctor = await backend.doctor();
      assert.equal(doctor.ok, false);
      assert.match(doctor.checks.find((check) => check.id === "machine.u.ssh")!.fix!, /Check that u is on/);
    } finally {
      rmSync(join(fake.dir, "down", "192.0.2.55"));
    }
    const restarted = pool("u 192.0.2.55 linux", storage).backend;
    assert.equal(await restarted.power(guest), "running");
    await restarted.release(guest, releaseHooks().hooks);
    assert.equal((await member(restarted, "u")).state, "free");
    await backend.dispose();
    await restarted.dispose();
  });

  it("puts a machine out of service when its reset generation goes back", async () => {
    machine("192.0.2.56");
    const { backend } = pool("g 192.0.2.56 linux");
    const { guest } = await acquire(backend);
    await backend.release(guest, releaseHooks().hooks);
    assert.equal((await member(backend, "g")).generation, 1);
    write("192.0.2.56", "generation", "0\n");
    const out = await member(backend, "g");
    assert.equal(out.state, "out-of-service");
    assert.match(out.reason!, /went back from 1 to 0/);
    await backend.dispose();
  });

  it("resumes an acquire whose machine still names the box, and otherwise claims again", async () => {
    machine("192.0.2.57");
    machine("192.0.2.58");
    const lines = "r1 192.0.2.57 linux\nr2 192.0.2.58 linux";
    const { backend, storage } = pool(lines);
    const { box, guest } = await acquire(backend);
    const restarted = pool(lines, storage).backend;
    const resumed = recordingHooks();
    assert.deepEqual(await restarted.acquire(box, guest, resumed.hooks, AbortSignal.timeout(20_000)), guest);
    assert.deepEqual(resumed.events, ["starting"], "nothing new was claimed");

    const moved = { ...guest, data: { ...guest.data, generation: 5 } };
    const again = recordingHooks();
    const next = await restarted.acquire(box, moved, again.hooks, AbortSignal.timeout(20_000));
    assert.deepEqual(again.events, ["claim", "starting"]);
    assert.equal(next.data?.box, box.boxId);
    await restarted.release(guest, releaseHooks().hooks);
    await restarted.release(next, releaseHooks().hooks);
    await backend.dispose();
    await restarted.dispose();
  });

  it("leaves the next box alone when an old box on its machine is released again", async () => {
    machine("192.0.2.61");
    const { backend } = pool("n 192.0.2.61 linux");
    const old = (await acquire(backend)).guest;
    await backend.release(old, releaseHooks().hooks);
    const next = (await acquire(backend)).guest;
    assert.equal(next.ref, old.ref);
    assert.equal(await backend.power(old), null, "the old box is gone");
    await backend.release(old, releaseHooks().hooks);
    assert.equal(await backend.power(next), "running");
    assert.equal((await member(backend, "n")).state, "held");
    await backend.release(next, releaseHooks().hooks);
    assert.equal((await member(backend, "n")).state, "free");
    await backend.dispose();
  });

  it("keeps a box's machine held when its helper is too old, and never resets it", async () => {
    machine("192.0.2.62");
    const { backend } = pool("h 192.0.2.62 linux");
    const { guest } = await acquire(backend);
    // As after an upgrade that needs a newer helper.
    setFlag("192.0.2.62", "helper", "0");
    assert.equal((await member(backend, "h")).state, "held", "an old helper only stops new claims");
    assert.equal((await backend.held()).length, 1);
    await assert.rejects(backend.returnToService!("h"), /h is held by box .+\. Release the box first\./);
    assert.equal(await backend.power(guest), "running", "the box's machine was not reset");
    assert.equal((await member(backend, "h")).generation, 0);
    await backend.release(guest, releaseHooks().hooks);
    const out = await member(backend, "h");
    assert.equal(out.state, "out-of-service");
    assert.match(out.reason!, /helper is missing or too old/);
    clearFlag("192.0.2.62", "helper");
    const back = await member(backend, "h");
    assert.equal(back.state, "free");
    assert.equal(back.generation, 1);
    await backend.dispose();
  });

  it("tells the operator to run again a reset on the machine that was cut short", async () => {
    machine("192.0.2.63");
    write("192.0.2.63", "resetting", "install=\ngeneration=0\n");
    const { backend } = pool("r 192.0.2.63 linux");
    assert.equal((await member(backend, "r")).state, "resetting");
    const doctor = await backend.doctor();
    const state = doctor.checks.find((check) => check.id === "machine.r.state")!;
    assert.equal(state.status, "warn");
    assert.match(state.detail, /An operator's reset on the machine has not finished/);
    assert.match(state.fix!, /run "sudo \/usr\/local\/libexec\/bb-box\/machine reset" on r again/);
    assert.doesNotMatch(doctor.notes.join("\n"), /leaves alone/, "it is no other install's");
    assert.deepEqual(await backend.held(), [], "the sweep leaves it to the operator");
    const reset = await fake.ssh.run({ host: "192.0.2.63", port: 22, user: "bbbox-admin", hostKeys: [] }, `${HELPER} reset </dev/null`, { timeoutMs: 20_000 });
    assert.equal(reset.exitCode, 0, reset.stderr);
    assert.equal((await member(backend, "r")).state, "free");
    await backend.dispose();
  });

  it("fails its doctor without Node.js or npm for BB's installer, and warns without git or gh", async () => {
    machine("192.0.2.67");
    machine("192.0.2.68", { node: "v22.19.0" });
    machine("192.0.2.69", { node: "" });
    machine("192.0.2.70", { node: "v22.18.1" });
    machine("192.0.2.71", { lacks: "npm gh" });
    machine("192.0.2.72", { lacks: "git gh" });
    machine("192.0.2.73", { "no-enrolment": "" });
    const { backend } = pool(
      ["ok 192.0.2.67", "edge 192.0.2.68", "bare 192.0.2.69", "old 192.0.2.70", "nonpm 192.0.2.71", "nogit 192.0.2.72", "older 192.0.2.73"].map((line) => `${line} linux`).join("\n"),
    );
    const doctor = await backend.doctor();
    const tools = (name: string) => doctor.checks.find((check) => check.id === `machine.${name}.tools`)!;
    assert.equal(doctor.ok, false);
    assert.equal(tools("ok").status, "ok");
    assert.match(tools("ok").detail, /^Everything the helper, enrolment and the thread's GitHub access need, with Node\.js 24\.21\.0\./);
    assert.equal(tools("edge").status, "ok", "BB's installer takes 22.19");
    assert.equal(tools("bare").status, "fail");
    assert.equal(tools("bare").detail, "bare lacks node.");
    assert.match(tools("bare").fix!, /^On bare: Install Node\.js 22\.19 or newer with npm, such as Node\.js 24 from NodeSource or nodejs\.org\. Debian's and Ubuntu's own nodejs is too old\./);
    assert.equal(tools("old").status, "fail");
    assert.equal(tools("old").detail, "old has Node.js 22.18.1, but BB's installer needs 22.19 or newer.");
    assert.equal(tools("nonpm").status, "fail");
    assert.equal(tools("nonpm").detail, "nonpm lacks npm, gh.");
    assert.match(tools("nonpm").fix!, /Install Node\.js .* Install git and gh\. On Debian or Ubuntu: sudo apt-get install git gh\.$/);
    assert.equal(tools("nogit").status, "warn");
    assert.match(tools("nogit").detail, /^nogit lacks git, gh\. Boxes there enrol in BB, but cannot use the thread's GitHub access/);
    assert.equal(tools("nogit").fix, "On nogit: Install git and gh. On Debian or Ubuntu: sudo apt-get install git gh.");
    assert.equal(tools("older").status, "warn");
    assert.match(tools("older").detail, /^The helper does not say whether older has Node\.js, npm, git and gh/);
    assert.equal(tools("older").fix, "Run this bb-box's setup/ssh-pool/setup.sh on older as root.");
    assert.equal(doctor.checks.find((check) => check.id === "machine.older.helper")!.status, "ok", "the helper's version has not changed");
    // A box there still runs commands, so the machine stays in service.
    assert.equal((await member(backend, "bare")).state, "free");
    await backend.dispose();
  });

  it("notes machines held by another install in the doctor", async () => {
    machine("192.0.2.59");
    const mine = pool("o 192.0.2.59 linux", new MemoryStorage(), "mine").backend;
    const { guest } = await acquire(mine);
    const other = pool("o 192.0.2.59 linux", new MemoryStorage(), "other").backend;
    const doctor = await other.doctor();
    assert.ok(doctor.ok);
    assert.match(doctor.notes.join("\n"), /This install's ID is other/);
    assert.match(doctor.notes.join("\n"), /leaves alone 1 machine held by install mine\. They still count against capacity/);
    assert.match(doctor.checks.find((check) => check.id === "machine.o.state")!.detail, /Held by install mine/);
    await assert.rejects(other.returnToService!("o"), /o is held by box .+ of bb-box install mine\. Release the box first\./);
    assert.equal(await mine.power(guest), "running", "the box's machine was not reset");
    await mine.release(guest, releaseHooks().hooks);
    await mine.dispose();
    await other.dispose();
  });
});

/** A fake Mac at `host`, set up as setup-mac.sh leaves one, with its box user at the console. */
function mac(host: string, flags: Record<string, string> = {}): void {
  machine(host, { macos: "", cores: "8", memory: "16384", disk: "200", ...flags });
}

/** Makes Cua Driver's socket in the box user's home on `host`, as its LaunchAgent does in the box user's session. */
function cuaSocket(host: string): void {
  const dir = join(fake.home(host), "Library", "Caches", "cua-driver");
  mkdirSync(dir, { recursive: true });
  rmSync(join(dir, "cua-driver.sock"), { force: true });
  // Bound by its name in its directory, as the whole path may be too long for a socket.
  const made = spawnSync(process.execPath, ["-e", "require('node:net').createServer().listen('cua-driver.sock', () => process.exit(0))"], { cwd: dir });
  assert.equal(made.status, 0, String(made.stderr));
}

/** The script inside a command the pool ran over SSH, without the wrapping that marks its end. */
function script(command: string): string {
  const quoted = /-c '((?:[^']|'\\'')*)'/.exec(command);
  return quoted ? quoted[1]!.replaceAll("'\\''", "'") : command;
}

/** The helper commands the pool ran on `host`, such as "status" or "release 0". */
function helperCalls(host: string): string[] {
  return fake
    .log()
    .filter((entry) => entry.target.endsWith(`@${host}`) && entry.command.includes("fake-machine.mjs "))
    .map((entry) => script(entry.command).split("fake-machine.mjs ")[1]!.trim());
}

// Two Macs with Xcode serve both kinds, so two installs can each hold one.
// Each has the runtimes setup-mac.sh's `status xcode` noted, so the offers
// have ios-simulator from the first survey.
for (const host of ["192.0.2.95", "192.0.2.96"]) {
  mac(host, { xcode: "26.0" });
  write(host, "xcode", "xcode=26.0\nruntimes=iOS 26.0,watchOS 26.0\n");
  cuaSocket(host);
}
await conformance({
  name: "SSH host pool of Macs on fakes",
  storage: new MemoryStorage(),
  create: (storage, installId) => pool("cm1 192.0.2.95 macos,macos-desktop\ncm2 192.0.2.96 macos,macos-desktop", storage, installId).backend,
  skip: {
    arch: "the fake SSH runs commands on the test machine",
    size: "the fake SSH runs commands on the test machine",
    display: "the fake SSH cannot carry Screen Sharing through ssh -W",
    "desktop-session": "the test machine has no Aqua session",
    "computer-use": "the test machine has no Cua Driver",
    "ios-simulator": "the fake Mac has no Simulator",
  },
  timeoutMs: 20_000,
});

describe("An SSH host pool of Macs (047)", () => {
  it("parses a Mac's line, and refuses one that mixes Linux and macOS kinds or asks for a whole-machine reset", () => {
    const parsed = config("mac-mini bbbox-admin@192.0.2.80 macos,macos-desktop").machines[0]!;
    assert.deepEqual([parsed.os, parsed.kinds, parsed.docker, parsed.reset], ["macos", ["macos", "macos-desktop"], false, "home"]);
    assert.match(problems(settings("m 192.0.2.80 linux,macos")), /Machine m lists Linux and macOS kinds\. List linux on a Linux machine, and macos or macos-desktop on a Mac\./);
    assert.match(problems(settings("m 192.0.2.80 macos reset=machine")), /Machine m is a Mac, which has no whole-machine reset\. Remove reset=machine/);
    assert.match(problems(settings("m 192.0.2.80 macos-docker")), /cannot serve kind "macos-docker": .*, and macos and macos-desktop on a Mac\./);
  });

  it("offers the kinds its lines list, says which OS its machines run, and gives Docker by its Linux machines alone", () => {
    const macs = pool("m1 192.0.2.80 macos,macos-desktop\nm2 192.0.2.81 macos").backend;
    assert.deepEqual(macs.kinds().map((kind) => kind.id), ["macos", "macos-desktop"]);
    assert.equal(macs.hostOs, "macos");
    assert.equal(macs.restores, "home");
    const [headless, desktop] = macs.kinds();
    assert.deepEqual([headless!.capabilities.os, headless!.capabilities.arch, headless!.capabilities.displays, headless!.capabilities.computerUse], ["macos", "arm64", [], null]);
    assert.deepEqual(desktop!.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: false }]);
    assert.deepEqual(desktop!.capabilities.computerUse, { driver: "cua", version: CUA_VERSION, socket: "~/Library/Caches/cua-driver/cua-driver.sock" });
    assert.equal(desktop!.capabilities.command?.admin, false, "a box user is a standard user");
    assert.equal(desktop!.readyTimeoutMs, 3 * 60_000);
    assert.equal(pool("l1 192.0.2.41 linux").backend.hostOs, "linux");
    const mixed = pool("w1 192.0.2.42 linux reset=machine\nm1 192.0.2.80 macos").backend;
    assert.equal(mixed.hostOs, null, "its machines run Linux and macOS");
    assert.deepEqual(mixed.kinds().map((kind) => kind.id), ["linux", "macos"]);
    assert.deepEqual(mixed.kinds()[0]!.capabilities.features, ["docker"], "a Mac has no whole-machine reset, but takes no Docker from the linux boxes");
  });

  it("grants a program in a Mac's box macOS permissions through the helper, and lists the box's grants, only with SIP off (058)", async () => {
    const host = "192.0.2.79";
    mac(host);
    const { backend } = pool("g 192.0.2.79 macos");
    const { guest } = await acquire(backend, "macos");
    const request = { program: "/Users/bbx-0/Applications/Probe.app", permissions: ["accessibility", "microphone"] as const };
    await assert.rejects(backend.grant!(guest, request), (error: unknown) => error instanceof BackendError && error.code === "unsupported" && /^System Integrity Protection is on/.test(error.message));
    assert.deepEqual(await backend.grants!(guest), { canGrant: false, grants: [] });

    setFlag(host, "sip-off");
    assert.deepEqual(await backend.grant!(guest, request), { client: "dev.example.probe", granted: ["accessibility", "microphone"], refused: [] });
    await assert.rejects(backend.grant!(guest, { program: "/usr/bin/true", permissions: ["camera"] }), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
    assert.deepEqual(await backend.grants!(guest), {
      canGrant: true,
      grants: [
        { permission: "accessibility", client: "dev.example.probe", target: null },
        { permission: "microphone", client: "dev.example.probe", target: null },
      ],
    });
    assert.deepEqual(helperCalls(host).filter((call) => call.startsWith("grant")), ["grant", "granted 0", "grant", "grant", "granted 0"]);

    // The reset removes them.
    await backend.release(guest, releaseHooks().hooks);
    const next = await acquire(backend, "macos");
    assert.deepEqual(await backend.grants!(next.guest), { canGrant: true, grants: [] });
    await backend.release(next.guest, releaseHooks().hooks);
    await backend.dispose?.();
  });

  it("refuses grants on a Linux machine of the pool", async () => {
    machine("192.0.2.78");
    const { backend } = pool("l 192.0.2.78 linux");
    const { guest } = await acquire(backend);
    await assert.rejects(backend.grant!(guest, { program: "/home/bbx-0/tool", permissions: ["accessibility"] }), /^BackendError: Machine l runs Linux: only a Mac's box has macOS permissions to grant\.$/);
    assert.equal(await backend.grants!(guest), null);
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose?.();
  });

  it("lends a Mac once its box user is at the console and, for macos-desktop, Cua Driver's socket is in the box user's home", async () => {
    const host = "192.0.2.82";
    mac(host);
    rmSync(join(fake.home(host), "Library"), { recursive: true, force: true });
    const polls: number[] = [];
    const { backend } = pool("m 192.0.2.82 macos-desktop", new MemoryStorage(), "test", {
      readyTimeoutMs: 60_000,
      sleep: async (ms) => {
        polls.push(ms);
        // Cua's LaunchAgent makes its socket a moment after the box user signs in.
        if (polls.length === 3) cuaSocket(host);
      },
    });
    // The claim takes the Mac while its box user is still signing in.
    const signingIn = (times: number): AcquireHooks => {
      const recording = recordingHooks();
      return {
        ...recording.hooks,
        claim: async (guest) => {
          setFlag(host, "console-after", String(times));
          await recording.hooks.claim(guest);
        },
      };
    };
    const guest = await backend.acquire(identity("macos-desktop"), null, signingIn(2), AbortSignal.timeout(20_000));
    assert.deepEqual(polls, [1000, 1000, 1000], "twice for the console, then once for the socket");
    const tests = fake.log().filter((entry) => entry.target.endsWith(`@${host}`) && script(entry.command).startsWith("test -S "));
    assert.deepEqual(
      tests.map((entry) => [entry.target, script(entry.command)]),
      Array(2).fill(["bbx-0@192.0.2.82", `test -S "$HOME"/'Library/Caches/cua-driver/cua-driver.sock'`]),
      "the box user tests the socket in its own home",
    );
    await backend.release(guest, releaseHooks().hooks);

    rmSync(join(fake.home(host), "Library"), { recursive: true, force: true });
    const quick = pool("m 192.0.2.82 macos-desktop").backend;
    await assert.rejects(acquire(quick, "macos-desktop"), /^Error: Cua Driver's socket did not appear in box user bbx-1's session on m within 0 s\. Check that setup-mac\.sh installed Cua Driver there\.$/);
    assert.equal((await member(quick, "m")).state, "free", "the failed acquire released the Mac");
    cuaSocket(host);
    await assert.rejects(
      quick.acquire(identity("macos-desktop"), null, signingIn(1), AbortSignal.timeout(20_000)),
      /^Error: Box user bbx-2 was not signed in at m's console within 0 s\. Check that FileVault is off and nobody else is signed in there/,
    );
  });

  it("shows the desktop through Screen Sharing over SSH as the box user, with the sign-in the helper gives at each open, and puts it nowhere else", async () => {
    const host = "192.0.2.83";
    mac(host, { password: "pw-0f3c9a" });
    cuaSocket(host);
    const storage = new MemoryStorage();
    const { backend } = pool("m 192.0.2.83 macos-desktop", storage);
    const { guest } = await acquire(backend, "macos-desktop");
    const { displays } = await backend.transports(guest, "macos-desktop");
    assert.deepEqual(
      displays.map((display) => [display.id, display.label, display.protocol, display.resizable]),
      [["desktop", "Desktop", "rfb", false]],
    );
    const display = displays[0]!;
    const { input, ...first } = await display.open();
    const { input: _, ...second } = await display.open();
    assert.deepEqual(first.auth, { type: "apple", user: "bbx-0", password: "pw-0f3c9a" });
    assert.deepEqual(second, first);
    // Screen Sharing ignores the viewer's input, so it goes to the helper in the box user's desktop session (#406).
    // This fake box user has no desktop session to join, so the helper ends at once, and says so.
    assert.ok(input, "the display takes the viewer's input");
    await assert.rejects(input({}), /^Error: The desktop's input helper did not start on m: box user bbx-0 may not be signed in to the desktop\./);
    assert.equal(first.route.type, "command");
    assert.deepEqual(first.route.type === "command" ? first.route.argv.slice(-4) : [], ["ExitOnForwardFailure=yes", "-W", "127.0.0.1:5900", "bbx-0@192.0.2.83"]);
    assert.equal(helperCalls(host).filter((call) => call === "display 0").length, 2, "the helper gives the sign-in for each connection");
    assert.deepEqual((await backend.transports(guest, "macos")).displays, [], "a macos box has no desktop");

    setFlag(host, "display-user", "bbx-9");
    await assert.rejects(display.open(), (error: Error) => /did not give box user bbx-0's sign-in/.test(error.message) && !error.message.includes("pw-0f3c9a"));
    clearFlag(host, "display-user");
    const doctor = await backend.doctor();
    const everywhere = JSON.stringify([guest, [...storage.values], fake.log(), doctor, await backend.members!()]);
    assert.equal(everywhere.includes("pw-0f3c9a"), false, "the password is in the sign-in alone");

    await backend.release(guest, releaseHooks().hooks);
    await assert.rejects(display.open(), (error: unknown) => error instanceof BackendError && error.code === "gone" && !error.message.includes("pw-0f3c9a"));
  });

  it("waits while a Mac's reset signs the next box user in, and never asks a Mac for a whole-machine reset", async () => {
    const host = "192.0.2.84";
    mac(host, { "restore-steps": "2" });
    const { backend } = pool("m 192.0.2.84 macos");
    const { guest } = await acquire(backend, "macos");
    await backend.release(guest, releaseHooks().hooks);
    assert.deepEqual([(await member(backend, "m")).state, (await member(backend, "m")).generation], ["free", 1]);
    assert.deepEqual(helperCalls(host).filter((call) => call.startsWith("release")), ["release 0", "release 0", "release 0"]);

    setFlag(host, "fail-reset", "the next box user did not sign in");
    const again = await acquire(backend, "macos");
    await backend.release(again.guest, releaseHooks().hooks);
    assert.equal((await member(backend, "m")).state, "out-of-service");
    const signin = (await backend.doctor()).checks.find((check) => check.id === "machine.m.signin");
    assert.deepEqual([signin?.status, signin?.detail], ["warn", "Its reset stopped before signing the next box user in."], "a failed reset signs nobody in");
    clearFlag(host, "fail-reset");
    await backend.returnToService!("m");
    assert.deepEqual([(await member(backend, "m")).state, (await member(backend, "m")).generation], ["free", 2]);
    const calls = helperCalls(host);
    assert.ok(calls.includes("reset"), calls.join("; "));
    assert.ok(calls.every((call) => !/\b(machine|docker)\b/.test(call)), calls.join("; "));
  });

  it("waits for a Mac that drops SSH as its release restarts it, and takes out of service only a Mac silent past the limit (047)", async () => {
    // Dropped once, as macOS restarting in the reset: asked again, it finishes, and the Mac is free.
    const host = "192.0.2.87";
    mac(host);
    const { backend } = pool("m 192.0.2.87 macos");
    const { guest } = await acquire(backend, "macos");
    setFlag(host, "cut-reset");
    await backend.release(guest, releaseHooks().hooks);
    assert.deepEqual([(await member(backend, "m")).state, (await member(backend, "m")).generation], ["free", 1]);

    // Silent for a while, between its tries: the pool says resetting, not out of service, then finishes.
    const quiet = "192.0.2.88";
    mac(quiet);
    let silent: SshPoolBackend | null = null;
    const seen: string[] = [];
    let tries = 0;
    silent = pool("q 192.0.2.88 macos", new MemoryStorage(), "test", {
      macSilenceMs: 60_000,
      sleep: async () => {
        tries += 1;
        if (tries === 1) {
          fake.down(quiet);
          seen.push((await member(silent!, "q")).state);
        } else if (tries === 2) rmSync(join(fake.dir, "down", quiet));
      },
    }).backend;
    const held = await acquire(silent, "macos");
    setFlag(quiet, "cut-reset");
    await silent.release(held.guest, releaseHooks().hooks);
    assert.deepEqual(seen, ["resetting"], "while it does not answer");
    assert.deepEqual([(await member(silent, "q")).state, (await member(silent, "q")).generation], ["free", 1]);

    // Silent past the limit: out of service, saying so.
    const gone = "192.0.2.89";
    mac(gone);
    const limited = pool("g 192.0.2.89 macos", new MemoryStorage(), "test", { macSilenceMs: 0 }).backend;
    const lost = await acquire(limited, "macos");
    setFlag(gone, "cut-reset");
    await limited.release(lost.guest, releaseHooks().hooks);
    const state = await member(limited, "g");
    assert.equal(state.state, "out-of-service");
    assert.match(state.reason ?? "", /^It did not answer over SSH for 0 minutes during its reset/);
    await Promise.all([backend.dispose(), silent.dispose(), limited.dispose()]);
  });

  it("does not lend a Mac its box user cannot use, and says why", async () => {
    mac("192.0.2.85", { "filevault-on": "" });
    mac("192.0.2.86", { "no-fulldisk": "" });
    mac("192.0.2.87", { console: "alex" });
    mac("192.0.2.88", { console: "" });
    mac("192.0.2.89", { "no-screensharing": "" });
    machine("192.0.2.90");
    const lines = ["fv 192.0.2.85", "fd 192.0.2.86", "person 192.0.2.87", "nobody 192.0.2.88", "dark 192.0.2.89", "penguin 192.0.2.90"];
    const { backend } = pool(lines.map((line) => `${line} macos,macos-desktop`).join("\n"));
    const reason = async (name: string) => (await member(backend, name)).reason ?? "";
    assert.match(await reason("fv"), /^FileVault is on, so the Mac cannot sign its box user in\./);
    assert.match(await reason("fd"), /^The helper lacks Full Disk Access, which the Mac's reset needs\. .*Allow full disk access for remote users\.$/);
    assert.match(await reason("person"), /^alex is signed in at the console, so box user bbx-0 cannot be\. Sign them out\./);
    assert.match(await reason("nobody"), /^Box user bbx-0 is not signed in at the console\. If the Mac has just started/);
    assert.equal(await reason("penguin"), "It runs Linux, but its line lists macos, macos-desktop.");
    assert.equal((await member(backend, "dark")).state, "free", "a Mac without Screen Sharing still lends macos");
    const capacity = await backend.capacity("macos-desktop", sizeOf("macos-desktop"), []);
    assert.equal(capacity.ok, false);
    assert.match(capacity.message!, /dark: Screen Sharing is off\./);
    const { guest } = await acquire(backend, "macos");
    assert.equal(guest.ref, "dark");
    await backend.release(guest, releaseHooks().hooks);
  });

  it("checks in its doctor what a Mac's boxes need, and only the doctor asks for Cua Driver's grants", async () => {
    mac("192.0.2.91");
    mac("192.0.2.92", { "filevault-on": "", "no-fulldisk": "", "no-screensharing": "", grants: "1,0,0", autologin: "", "open-homes": "person other" });
    mac("192.0.2.93", { console: "", "sip-off": "" });
    mac("192.0.2.94", { node: "", lacks: "gh", memory: "6144" });
    const { backend } = pool("good 192.0.2.91 macos,macos-desktop\nbad 192.0.2.92 macos-desktop\naway 192.0.2.93 macos-desktop\nheadless 192.0.2.94 macos");
    await backend.capacity("macos-desktop", sizeOf("macos-desktop"), []);
    assert.equal(helperCalls("192.0.2.91").filter((call) => call !== "status").length, 0, "a survey does not wait for Cua");
    const doctor = await backend.doctor();
    const check = (id: string) => doctor.checks.find((other) => other.id === id);
    const status = (name: string) => doctor.checks.filter((other) => other.id.startsWith(`machine.${name}.`)).map((other) => `${other.id.split(".")[2]} ${other.status}`);
    assert.equal(doctor.ok, false);
    assert.deepEqual(status("good"), ["ssh ok", "helper ok", "arch ok", "tools ok", "filevault ok", "signin ok", "fulldisk ok", "homes ok", "sip ok", "xcode ok", "screensharing ok", "grants ok", "input ok", "state ok", "sizes ok"]);
    assert.equal(check("machine.good.arch")?.detail, "macOS 26.0 on arm64.");
    assert.equal(check("machine.good.sizes")?.detail, "good holds macos and macos-desktop boxes at the default sizes.");
    assert.equal(check("machine.good.tools")?.detail, "Everything the helper, enrolment and the thread's GitHub access need, with Node.js 24.21.0.");
    assert.deepEqual(status("bad"), ["ssh ok", "helper ok", "arch ok", "tools ok", "filevault fail", "signin fail", "fulldisk fail", "homes warn", "sip ok", "xcode ok", "screensharing fail", "grants fail", "input fail", "state warn", "sizes ok"]);
    // People's homes box users can enter, with the fix (047).
    assert.match(check("machine.bad.homes")!.detail, /^Box users can enter the homes of person, other, which macOS makes readable to the staff group they are in/);
    assert.equal(check("machine.bad.homes")?.fix, "On bad, as an administrator: sudo chmod 700 /Users/person /Users/other");
    // SIP's state, either way ok, saying what it gives (058).
    assert.match(check("machine.good.sip")!.detail, /^On\. Cua Driver has its grants/);
    assert.match(check("machine.away.sip")!.detail, /^Off, so bb-box grants box users' programs the macOS permissions they ask for/);
    assert.match(check("machine.bad.signin")!.detail, /^Box user bbx-0 is at the console, but the automatic login is off/);
    assert.match(check("machine.bad.fulldisk")!.fix!, /^On bad: In System Settings, General, Sharing, select the \(i\) beside Remote Login/);
    assert.equal(check("machine.bad.grants")?.detail, "Cua Driver lacks Screen Recording, so computer use cannot see the desktop.");
    assert.equal(check("machine.bad.input")?.detail, "A pointer move posted in the box user's session did not move the pointer, so a person cannot type or click in the desktop's viewer.");
    assert.match(check("machine.bad.input")!.fix!, /^On bad, turn on osascript and sshd-keygen-wrapper under Accessibility/);
    assert.match(check("machine.bad.state")!.detail, /^Out of service: FileVault is on/);
    assert.deepEqual(status("away").filter((line) => /signin|grants|input/.test(line)), ["signin fail", "grants warn", "input warn"]);
    assert.equal(check("machine.away.signin")?.detail, "Box user bbx-0 is not signed in at the console.");
    assert.deepEqual(status("headless"), ["ssh ok", "helper ok", "arch ok", "tools fail", "filevault ok", "signin ok", "fulldisk ok", "homes ok", "sip ok", "xcode ok", "state ok", "sizes warn"]);
    assert.equal(check("machine.headless.tools")?.fix, "On headless: Install Node.js 22.19 or newer with Homebrew: brew install node. BB's installer needs it to enrol a box. Install git and gh with Homebrew: brew install git gh.");
    assert.equal(check("machine.headless.sizes")?.detail, "headless has 8 cores, 6 GiB memory, 200 GiB free disk. It cannot hold a macos box at any of its presets, the smallest 4 cores, 8 GiB memory.");
    assert.equal(check("machine.headless.sizes")?.fix, "Give headless more memory, or make the presets of macos smaller in bb-box's settings, under Kinds.");
    for (const [host, asked] of [["192.0.2.91", 1], ["192.0.2.92", 1], ["192.0.2.93", 1], ["192.0.2.94", 0]] as const) {
      assert.equal(helperCalls(host).filter((call) => call === "status grants").length, asked, host);
      assert.equal(helperCalls(host).filter((call) => call === "status xcode").length, 1, host);
    }
    assert.match(doctor.notes.join("\n"), /name it in \/var\/db\/bb-box\/owner\./);
    assert.match(doctor.notes.join("\n"), /On a Mac, a release removes the box's user, .* It keeps macOS, apps, Homebrew and Cua Driver's grants\./);
    assert.doesNotMatch(doctor.notes.join("\n"), /none of them has Docker/);
  });

  it("offers xcode and ios-simulator while every Mac serving the kind that answered the last survey has them, and its doctor says which lack them", async () => {
    mac("192.0.2.70", { xcode: "26.0" });
    mac("192.0.2.71", { xcode: "26.0", runtimes: "watchOS 26.0" });
    mac("192.0.2.72");
    mac("192.0.2.73", { "no-status-xcode": "" });
    const features = async (backend: Backend) => {
      await backend.capacity("macos", sizeOf("macos"), []);
      return backend.kinds().map((kind) => `${kind.id}: ${kind.capabilities.features.join(" ")}`);
    };
    const check = async (backend: Backend, id: string) => (await backend.doctor()).checks.find((other) => other.id === id);
    const asked = () => helperCalls("192.0.2.70").filter((call) => call === "status xcode").length;
    const both = ["macos: xcode ios-simulator", "macos-desktop: xcode ios-simulator"];
    /** Whether a box on the Mac `ref` would take the features its kind has now. */
    const offered = (backend: SshPoolBackend, ref: string, kind = "macos") => backend.asOffered({ ref } as Guest, kind);

    const ready = pool("ready 192.0.2.70 macos,macos-desktop").backend;
    assert.deepEqual(ready.kinds().map((kind) => kind.capabilities.features), [[], []]);
    assert.deepEqual(await Promise.all(["linux", "macos"].map((kind) => offered(ready, "ready", kind))), [true, false], "before the first survey, a box keeps the features it has");
    assert.deepEqual(await features(ready), ["macos: xcode", "macos-desktop: xcode"], "plain status gives Xcode's version, and no runtimes until `status xcode` has found them");
    assert.deepEqual([await offered(ready, "ready"), await offered(ready, "gone")], [true, false], "a box takes them only when its own Mac answered");
    assert.equal(asked(), 0, "only the doctor and setup-mac.sh ask for Xcode's runtimes");
    assert.equal((await check(ready, "machine.ready.xcode"))?.detail, "Xcode 26.0, with the Simulator's iOS 26.0, watchOS 26.0.");
    assert.deepEqual(await features(ready), both);
    assert.match(ready.kinds()[0]!.description, /Its desktop is not shown\. It has Xcode and the iOS Simulator\.$/);
    assert.equal(await check(ready, "xcode"), undefined);

    const restarted = pool("ready 192.0.2.70 macos,macos-desktop").backend;
    const before = asked();
    assert.deepEqual(await features(restarted), both, "after a restart, the first survey gives them back");
    assert.equal(asked(), before);
    setFlag("192.0.2.70", "simctl-fails");
    try {
      assert.deepEqual(await check(restarted, "machine.ready.xcode"), {
        id: "machine.ready.xcode",
        name: "ready: Xcode",
        status: "warn",
        detail: "The helper did not say whether the Mac has Xcode. xcrun simctl did not list the Simulator's runtimes within 10 seconds. The offers keep what it found before.",
        fix: "Run this bb-box's setup/ssh-pool/setup-mac.sh on ready with sudo, which updates the helper and prepares Xcode. Then run the doctor again.",
      });
      assert.equal(await check(restarted, "xcode"), undefined);
      assert.deepEqual(await features(restarted), both, "a failed call keeps what the Mac found before");
    } finally {
      clearFlag("192.0.2.70", "simctl-fails");
    }

    const off = pool("ready 192.0.2.70 macos,macos-desktop\nbare 192.0.2.72 macos").backend;
    fake.down("192.0.2.72");
    try {
      assert.deepEqual(await features(off), both, "a Mac that does not answer does not hide them");
      assert.deepEqual([await offered(off, "ready"), await offered(off, "bare")], [true, false], "nor gives its box the Xcode it lacks");
    } finally {
      rmSync(join(fake.dir, "down", "192.0.2.72"));
    }
    assert.deepEqual(await features(off), ["macos: ", "macos-desktop: xcode ios-simulator"]);
    assert.equal(await offered(off, "bare"), true);

    const watch = pool("ready 192.0.2.70 macos,macos-desktop\nwatch 192.0.2.71 macos").backend;
    await watch.doctor();
    assert.deepEqual(await features(watch), ["macos: xcode", "macos-desktop: xcode ios-simulator"]);
    assert.match(watch.kinds()[0]!.description, /shown\. It has Xcode\.$/);
    assert.deepEqual(await check(watch, "machine.watch.xcode"), {
      id: "machine.watch.xcode",
      name: "watch: Xcode",
      status: "warn",
      detail: "Xcode 26.0 has no iOS runtime, so boxes here have no iOS Simulator.",
      fix: "Run setup/ssh-pool/setup-mac.sh on watch with sudo again. It accepts Xcode's licence, runs its first launch and downloads the iOS platform.",
    });
    assert.equal((await check(watch, "xcode"))?.detail, "watch has no iOS runtime, so the pool's macos boxes have no ios-simulator.");

    const some = pool("ready 192.0.2.70 macos,macos-desktop\nbare 192.0.2.72 macos,macos-desktop\nold 192.0.2.73 macos").backend;
    const doctor = await some.doctor();
    assert.deepEqual(await features(some), ["macos: ", "macos-desktop: "]);
    const found = (id: string) => doctor.checks.find((other) => other.id === id);
    assert.deepEqual([found("machine.bare.xcode")?.status, found("machine.bare.xcode")?.detail], ["ok", "None, so boxes here have neither Xcode nor the iOS Simulator."]);
    assert.deepEqual(found("machine.old.xcode"), {
      id: "machine.old.xcode",
      name: "old: Xcode",
      status: "warn",
      detail: "The helper did not say whether the Mac has Xcode. usage: machine status [grants]. Until it does, boxes here have neither Xcode nor the iOS Simulator.",
      fix: "Run this bb-box's setup/ssh-pool/setup-mac.sh on old with sudo, which updates the helper and prepares Xcode. Then run the doctor again.",
    });
    assert.deepEqual(found("xcode"), {
      id: "xcode",
      name: "Xcode",
      status: "warn",
      detail:
        "bare, old have no Xcode, so the pool's macos boxes have neither xcode nor ios-simulator. " +
        "bare has no Xcode, so the pool's macos-desktop boxes have neither xcode nor ios-simulator.",
      fix: "On bare, old, install Xcode in /Applications if it is not there, then run setup/ssh-pool/setup-mac.sh with sudo again, which downloads the iOS platform. Or serve those kinds only from Macs with Xcode.",
    });
    const none = pool("bare 192.0.2.72 macos,macos-desktop").backend;
    assert.equal(await check(none, "xcode"), undefined, "Xcode is optional, so a pool where no Mac has it does not warn");
  });

  it("warns in the doctor when a Mac it lends is also a Tart host", () => {
    const tart = new TartBackend(tartConfig(), testContext());
    const lent = pool(`mini ${FAKE_MAC} macos\nother 192.0.2.30 macos`).backend;
    const [both, ...rest] = overlapChecks([lent, tart]);
    assert.deepEqual(rest, []);
    assert.deepEqual([both?.name, both?.status, both?.detail, both?.fix], [
      `${lent.label} and ${tart.label}`,
      "warn",
      `They both use the machine at ${FAKE_MAC}, so a box of one could take what a box of the other has. ` +
        "On macOS 27 and later, each reset of a Mac restarts its user space, which stops every Tart VM on it and ends every SSH session.",
      "List the machine in one of them only.",
    ]);
    assert.equal(
      overlapChecks([pool(`box ${FAKE_MAC} linux`).backend, tart])[0]?.detail,
      `They both use the machine at ${FAKE_MAC}, so a box of one could take what a box of the other has.`,
      "a Linux machine's reset restarts nothing on a Mac",
    );
    assert.deepEqual(overlapChecks([pool("other 192.0.2.30 macos").backend, tart]), []);
    assert.deepEqual(overlapChecks([pool(`mini ${FAKE_MAC} macos via=jump@192.0.2.9`).backend, tart]), [], "a Mac through a jump host is on another network");
  });
});
