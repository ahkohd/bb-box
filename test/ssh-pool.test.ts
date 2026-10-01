// The SSH host pool backend on fake SSH, with test/fake-machine.mjs as each
// machine's helper: its settings, the conformance suite, and what the pool
// does when a reset fails, is cut short or leaves a machine dirty.

import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { SshPoolBackend } from "../src/backends/ssh-pool/backend.ts";
import { hostKeysFor, parseSshPoolSettings, parseTarget, type SshPoolConfig } from "../src/backends/ssh-pool/config.ts";
import { BackendError, type AcquireHooks, type Backend, type BackendStorage, type BoxIdentity, type BoxSize, type Capacity, type Guest } from "../src/backends/types.ts";
import { conformance, identity, recordingHooks, releaseHooks, sizeOf } from "./conformance/suite.ts";
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
function pool(lines: string, storage: BackendStorage = new MemoryStorage(), installId = "test") {
  const context = testContext(storage, installId);
  const backend = new SshPoolBackend(config(lines), context, {
    sshBinary: FAKE_SSH_BINARY,
    helperCommand: HELPER,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    readyTimeoutMs: 0,
    resetPollMs: 1,
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
    assert.ok(doctor.notes.some((note) => /^Give setup\/ssh-pool\/setup\.sh this public key with --key, .*: ssh-ed25519 /.test(note)));
    assert.deepEqual(backend.kinds(), []);
  });
});

describe("SSH host pool settings", () => {
  it("parse a machine per line, with defaults", () => {
    const parsed = config("build-1 192.0.2.21 linux\nbuild-2 ops@192.0.2.22:2222 linux,linux-docker via=jump@192.0.2.9 reset=machine labels=fast,big # the big one");
    assert.deepEqual(parsed.machines[0], {
      name: "build-1",
      admin: { host: "192.0.2.21", port: 22, user: "bbbox-admin" },
      jump: null,
      kinds: ["linux"],
      docker: false,
      reset: "home",
      labels: [],
    });
    assert.deepEqual(parsed.machines[1], {
      name: "build-2",
      admin: { host: "192.0.2.22", port: 2222, user: "ops" },
      jump: { host: "192.0.2.9", port: 22, user: "jump" },
      kinds: ["linux"],
      docker: true,
      reset: "machine",
      labels: ["fast", "big"],
    });
    assert.equal(parsed.privateKey, null, "bb-box makes a key when none is given");
  });

  it("accept the kind IDs from before 027, and linux-docker as linux with Docker (041)", () => {
    const old = config("old 192.0.2.23 linux-headless,linux-headless-docker reset=machine").machines[0]!;
    assert.deepEqual([old.kinds, old.docker], [["linux"], true]);
    const alone = config("d 192.0.2.24 linux-docker reset=machine").machines[0]!;
    assert.deepEqual([alone.kinds, alone.docker], [["linux"], true]);
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

// Two machines serve linux, so two installs can each hold one. Only the second lists linux-docker, so neither gives Docker.
machine("192.0.2.31");
machine("192.0.2.32", { docker: "", hook: "", "restore-steps": "2" });
const conformanceLines = "c1 192.0.2.31 linux\nc2 192.0.2.32 linux,linux-docker reset=machine";
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
  it("offers linux, with Docker and root only when every machine gives Docker, and restores the machine only when every machine does", () => {
    const home = pool("h1 192.0.2.41 linux").backend;
    assert.deepEqual(home.kinds().map((kind) => kind.id), ["linux"]);
    assert.equal(home.restores, "home");
    assert.deepEqual(home.kinds()[0]!.capabilities.features, []);
    assert.equal(home.kinds()[0]!.capabilities.command?.admin, false, "a linux box cannot become root");
    const whole = pool("w1 192.0.2.42 linux,linux-docker reset=machine").backend;
    assert.deepEqual(whole.kinds().map((kind) => kind.id), ["linux"], "linux-docker is an alias, not an offer (041)");
    assert.equal(whole.restores, "machine");
    assert.deepEqual(whole.kinds()[0]!.capabilities.features, ["docker"]);
    assert.equal(whole.kinds()[0]!.capabilities.command?.admin, true, "Docker gives root, so the box says so");
    const mixed = pool("w1 192.0.2.42 linux-docker reset=machine\nh1 192.0.2.41 linux reset=machine").backend;
    assert.deepEqual(mixed.kinds()[0]!.capabilities.features, [], "each box of a backend's offer has Docker, or none does");
    assert.equal(mixed.kinds()[0]!.capabilities.command?.admin, false);
  });

  it("gives Docker access over SSH when every machine gives Docker, and claims machines in turn", async () => {
    machine("192.0.2.43", { docker: "", hook: "" });
    machine("192.0.2.44", { docker: "", hook: "" });
    const { backend } = pool("d1 192.0.2.43 linux-docker reset=machine\nd2 192.0.2.44 linux,linux-docker reset=machine");
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

  it("gives no Docker in a pool where some machines do not, and its doctor says so", async () => {
    machine("192.0.2.67", { docker: "", hook: "" });
    machine("192.0.2.68");
    const { backend } = pool("both 192.0.2.67 linux,linux-docker reset=machine\nplain 192.0.2.68 linux");
    const { guest } = await acquire(backend);
    assert.equal((await backend.transports(guest, "linux")).access?.dockerHost, null);
    const doctor = await backend.doctor();
    const docker = doctor.checks.find((check) => check.id === "docker");
    assert.equal(docker?.status, "warn");
    assert.match(docker!.detail, /^plain does not list linux-docker, so none of the pool's linux boxes have Docker, and each says No Docker\.$/);
    assert.match(docker!.fix!, /^To give them Docker, set up a whole-machine reset on plain and add linux-docker and reset=machine to its line, /);
    assert.equal(doctor.checks.find((check) => check.id === "machine.both.docker")?.status, "ok", "both is still checked for Docker");
    await backend.release(guest, releaseHooks().hooks);
    await backend.dispose();
  });

  it("claims the smallest free machine of at least the size, counting 90% of the memory as all of it (028)", async () => {
    // MemTotal leaves out what the kernel keeps: 7861 MiB is an 8 GiB machine, 3500 MiB is less than 4 GiB.
    machine("192.0.2.46", { cores: "16", memory: "64000", disk: "500" });
    machine("192.0.2.47", { cores: "4", memory: "7861", disk: "40" });
    machine("192.0.2.48", { cores: "2", memory: "3500", disk: "40" });
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
    machine("192.0.2.54", { hook: "", "restore-steps": "3" });
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
