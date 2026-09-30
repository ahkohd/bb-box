import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, ownerFromDescription, ownerFromTags } from "../src/backends/proxmox-lxc/backend.ts";
import { parseTags } from "../src/backends/proxmox/api.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest, type ReleaseHooks } from "../src/backends/types.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, testContext } from "./helpers.ts";

const GiB = 2 ** 30;

/** Every backend the tests make, disposed at the end so their key files go. */
const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

function track(backend: ProxmoxLxcBackend): ProxmoxLxcBackend {
  made.push(backend);
  return backend;
}

function setup(values: Record<string, unknown> = {}, storage = new MemoryStorage()) {
  const ssh = fakeSsh();
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  proxmox.addTemplate(9001);
  const config = lxcConfig({
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-desktop-template": 9001,
    "proxmox-lxc-vmid-first": 7000,
    "proxmox-lxc-vmid-last": 7009,
    ...values,
  });
  const context = testContext(storage);
  const make = () =>
    track(new ProxmoxLxcBackend(config, context, { fetch: proxmox.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, readyTimeoutMs: 0 }));
  return { ssh, proxmox, context, storage, make, backend: make() };
}

let boxCounter = 0;
function identity(kind = "linux-headless", threadId = "thr_abc123"): BoxIdentity {
  boxCounter++;
  return { boxId: `box_${boxCounter}`, threadId, name: `calm-otter-${boxCounter}`, kind, createdAt: 1_790_000_000_000 };
}

function hooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const value: AcquireHooks = {
    claim: async (guest) => {
      events.push(`claim ${guest.ref}`);
      claimed.push(guest);
    },
    starting: async () => {
      events.push("starting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { value, events, claimed, timings };
}

const signal = () => new AbortController().signal;

function releasing(): ReleaseHooks & { timings: Record<string, number> } {
  const timings: Record<string, number> = {};
  return {
    timings,
    resetting: async () => {
      throw new Error("A virtual backend has nothing to reset.");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
}

test("kinds lists only kinds with a template", () => {
  const { backend } = setup({ "proxmox-lxc-desktop-template": 0 });
  const kinds = backend.kinds();
  assert.deepEqual(
    kinds.map((kind) => kind.id),
    ["linux-headless", "linux-headless-docker"],
  );
  assert.deepEqual(kinds[0]!.requires, []);
  assert.deepEqual(kinds[1]!.requires, ["docker"]);
  assert.deepEqual(kinds[0]!.capabilities.features, ["docker"]);
  assert.deepEqual(kinds[0]!.capabilities.command, { transport: "ssh", shell: "sh", admin: true, inDesktopSession: false, streaming: true });
  assert.deepEqual(kinds[0]!.capabilities.displays, []);
  assert.equal(kinds[0]!.capabilities.arch, "x86_64");
  assert.equal(kinds[0]!.readyTimeoutMs, 30_000);
  assert.equal(kinds[0]!.size, "2 cores, 4 GiB memory, 16 GiB disk");
  const desktop = setup().backend.kinds().find((kind) => kind.id === "linux-desktop")!;
  assert.deepEqual(desktop.capabilities.displays, [{ id: "desktop", protocol: "rfb", resizable: true }]);
  assert.equal(desktop.capabilities.gpu, true);
  assert.equal(desktop.size, "4 cores, 8 GiB memory, 32 GiB disk");
});

test("the node is found when there is only one", async () => {
  const { backend, proxmox } = setup();
  assert.equal((await backend.client()).node, "pve");
  assert.equal(backend.label, "Proxmox LXC on pve.example.com");

  const two = setup();
  two.proxmox.intercept = (call) =>
    call.path === "/nodes"
      ? { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ data: [{ node: "a" }, { node: "b" }] }) }
      : undefined;
  await assert.rejects(two.backend.client(), /lists 2 nodes \(a, b\)\. Set the node/);
  assert.ok(proxmox.calls.length > 0);
});

test("capacity keeps the memory and disk reserves", async () => {
  const { backend, proxmox } = setup();
  const ok = await backend.capacity("linux-headless", [], signal());
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.warm, { ready: 0, target: 0 });
  assert.equal(ok.hosts.length, 1);
  assert.equal(ok.hosts[0]!.host, "pve");
  assert.deepEqual(ok.hosts[0]!.limits, [
    { resource: "memory", used: 16 * 1024, total: 64 * 1024, reserve: 4096, unit: "MiB" },
    { resource: "disk", used: 300 * 1024, total: 900 * 1024, reserve: 50 * 1024, unit: "MiB" },
    { resource: "guests", used: 0, total: 10, reserve: 0, unit: "count" },
  ]);

  proxmox.memory = { total: 64 * GiB, available: 10 * GiB };
  const pending = await backend.capacity("linux-headless", ["linux-headless"], signal());
  assert.equal(pending.ok, false);
  assert.match(pending.message!, /pve has 6 GiB of memory free\. A linux-headless box needs 4 GiB and 4 GiB is kept free/);
  assert.match(pending.message!, /bb-box's settings/);

  proxmox.memory = { total: 64 * GiB, available: 48 * GiB };
  proxmox.storage.set("local-lvm", { total: 900 * GiB, avail: 20 * GiB });
  const disk = await backend.capacity("linux-headless", [], signal());
  assert.equal(disk.ok, false);
  assert.equal(disk.hosts[0]!.ok, false);
  assert.match(disk.message!, /local-lvm storage on pve has 20 GiB free, less than the 50 GiB kept free/);
});

test("capacity refuses when the VMID range is full", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000 });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bb-box", status: "running", template: false, config: {} });
  const full = await backend.capacity("linux-headless", [], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /Every VMID from 7000 to 7000 is in use/);
});

test("capacity counts desktops on the GPU against its limit", async () => {
  const { backend } = setup({ "proxmox-lxc-desktop-gpu-limit": 2 });
  const headless = await backend.capacity("linux-headless", [], signal());
  assert.equal(headless.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops"), undefined);

  await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const one = await backend.capacity("linux-desktop", [], signal());
  assert.equal(one.ok, true);
  assert.deepEqual(one.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 1, total: 2, reserve: 0, unit: "count" });

  const full = await backend.capacity("linux-desktop", ["linux-desktop", "linux-headless"], signal());
  assert.equal(full.ok, false);
  assert.match(full.message!, /pve runs 2 desktop boxes on its GPU, the most bb-box's settings allow/);

  const unlimited = await setup().backend.capacity("linux-desktop", [], signal());
  assert.deepEqual(unlimited.hosts[0]!.limits.at(-1), { resource: "gpu-desktops", used: 0, total: null, reserve: 0, unit: "count" });
});

test("a desktop still being acquired counts once against the GPU limit", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-desktop-gpu-limit": 2 });
  const box = identity("linux-desktop");
  let during: number | undefined;
  const hook = hooks();
  const acquired = backend.acquire(box, null, { ...hook.value, starting: async () => {
    const capacity = await backend.capacity("linux-desktop", ["linux-desktop"], signal());
    during = capacity.hosts[0]!.limits.find((limit) => limit.resource === "gpu-desktops")?.used;
  } }, signal());
  await acquired;
  assert.equal(during, 1, "the acquiring box is both pending and listed, and counts once");
  assert.equal(proxmox.guests.size, 3);
});

test("an unknown kind is refused", async () => {
  const { backend } = setup({ "proxmox-lxc-desktop-template": 0 });
  await assert.rejects(backend.capacity("linux-desktop", [], signal()), (error: unknown) => error instanceof BackendError && error.code === "unsupported");
});

test("acquire claims the VMID before it clones, then configures and starts the box", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const hook = hooks();
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) hook.events.push(`clone ${call.params.newid}`);
    return undefined;
  };
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.deepEqual(guest, { ref: "7000", host: "pve", address: "192.0.2.100" });
  assert.deepEqual(hook.events, ["claim 7000", "clone 7000", "starting"]);
  assert.deepEqual(Object.keys(hook.timings).sort(), ["clone", "configure", "ready", "start", "warm"]);

  const made = proxmox.guests.get(7000)!;
  assert.equal(made.status, "running");
  assert.equal(made.pool, "bb-box");
  assert.equal(made.name, box.name);
  assert.equal(made.config.cores, "2");
  assert.equal(made.config.memory, "4096");
  assert.equal(made.config.onboot, "1");
  assert.equal(made.config.net0, "name=eth0,bridge=vmbr1,ip=192.0.2.100/24,gw=192.0.2.1,type=veth");
  assert.match(made.config.rootfs!, /size=16G/);
  const tags = parseTags(made.config.tags);
  assert.deepEqual(ownerFromTags(tags), { boxId: box.boxId, threadId: box.threadId, name: null, kind: box.kind, createdAt: box.createdAt });
  assert.equal(ownerFromDescription(made.config.description)?.boxId, box.boxId);
});

test("acquire skips a VMID another pool holds", async () => {
  const { backend, proxmox } = setup();
  proxmox.hidden.add(7000);
  const hook = hooks();
  const guest = await backend.acquire(identity(), null, hook.value, signal());
  assert.equal(guest.ref, "7001");
  assert.deepEqual(hook.events, ["claim 7000", "claim 7001", "starting"]);
});

test("a failed acquire deletes what it made", async () => {
  const { backend, proxmox } = setup();
  proxmox.nextTaskExit.set("vzstart", "startup for container '7000' failed");
  await assert.rejects(backend.acquire(identity(), null, hooks().value, signal()), /startup for container/);
  assert.equal(proxmox.guests.has(7000), false);
});

test("a box that never answers on SSH is deleted with a clear reason", async () => {
  const { backend, proxmox, ssh } = setup();
  ssh.down("192.0.2.100");
  await assert.rejects(
    backend.acquire(identity(), null, hooks().value, signal()),
    /SSH on 192\.0\.2\.100 did not answer.*template starts sshd on port 22.*user box accepts bb-box's key/,
  );
  assert.equal(proxmox.guests.has(7000), false);
});

test("acquire resumes the guest of an interrupted acquire", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  const first = await backend.acquire(box, null, hooks().value, signal());
  proxmox.guests.get(7000)!.status = "stopped";
  const hook = hooks();
  const again = await backend.acquire(box, first, hook.value, signal());
  assert.deepEqual(again, first);
  assert.deepEqual(hook.events, ["starting"]);
  assert.equal(proxmox.guests.size, 3);

  const other = await backend.acquire(identity(), first, hooks().value, signal());
  assert.equal(other.ref, "7001", "a guest another box owns is not resumed");
});

test("release deletes the guest, and a missing guest counts as released", async () => {
  const { backend, proxmox } = setup();
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(guest.host, "pve");
  const release = releasing();
  await backend.release(guest, release);
  assert.equal(typeof release.timings.delete, "number");
  assert.equal(proxmox.guests.has(7000), false);
  assert.equal(await backend.power(guest), null);
  await backend.release(guest, releasing());
  await assert.rejects(backend.release({ ref: "9000", host: null, address: null }, releasing()), /outside bb-box's VMID range/);
  assert.equal(proxmox.guests.has(9000), true);
});

test("power, stop and start", async () => {
  const { backend } = setup();
  const guest = await backend.acquire(identity(), null, hooks().value, signal());
  assert.equal(await backend.power(guest), "running");
  await backend.stop(guest);
  assert.equal(await backend.power(guest), "stopped");
  await backend.start(guest);
  assert.equal(await backend.power(guest), "running");
  await backend.release(guest, releasing());
  await assert.rejects(backend.start(guest), (error: unknown) => error instanceof BackendError && error.code === "gone");
});

test("held lists owned guests and unlabelled ones, and leaves others alone", async () => {
  const { backend, proxmox } = setup();
  const box = identity();
  await backend.acquire(box, null, hooks().value, signal());
  // Cloned but not yet tagged: only the description names the box.
  proxmox.guests.set(7001, {
    vmid: 7001,
    name: "half",
    pool: "bb-box",
    status: "stopped",
    template: false,
    config: { description: "bb-box half-done\nbox box_x\nthread thr_x\nkind linux-headless\ncreated 2026-09-30T00:00:00.000Z" },
  });
  proxmox.guests.set(7002, { vmid: 7002, name: "mystery", pool: "bb-box", status: "running", template: false, config: {} });
  proxmox.guests.set(7003, { vmid: 7003, name: "warm", pool: "bb-box", status: "running", template: false, config: { tags: "bb-box;warm;kind.linux-headless" } });
  proxmox.guests.set(8000, { vmid: 8000, name: "outside", pool: "bb-box", status: "running", template: false, config: {} });
  proxmox.guests.set(7004, { vmid: 7004, name: "other-pool", pool: "else", status: "running", template: false, config: {} });

  const held = await backend.held();
  assert.deepEqual(
    held.map((guest) => guest.ref),
    ["7000", "7001", "7002"],
  );
  assert.equal(held[0]!.owner?.boxId, box.boxId);
  assert.equal(held[0]!.owner?.name, box.name);
  assert.equal(held[0]!.power, "running");
  assert.deepEqual(held[1]!.owner, { boxId: "box_x", threadId: "thr_x", name: "half-done", kind: "linux-headless", createdAt: Date.parse("2026-09-30T00:00:00.000Z") });
  assert.equal(held[2]!.owner, null);
});

test("a new instance finds the guests the last one held", async () => {
  const { backend, make } = setup();
  const box = identity();
  const guest = await backend.acquire(box, null, hooks().value, signal());
  const restarted = make();
  const held = await restarted.held();
  assert.equal(held.find((other) => other.ref === guest.ref)?.owner?.boxId, box.boxId);
  await restarted.release(guest, releasing());
  assert.deepEqual(await restarted.held(), []);
});

test("transports reach the box over SSH, and desktops over VNC", async () => {
  const { backend, ssh } = setup();
  const headless = await backend.acquire(identity(), null, hooks().value, signal());
  const plain = await backend.transports(headless, "linux-headless");
  assert.deepEqual(plain.displays, []);
  assert.deepEqual(plain.access, {
    ssh: { host: "192.0.2.100", port: 22, user: "box", hostKeys: [] },
    dockerHost: "ssh://box@192.0.2.100",
  });
  const result = await plain.command!.run("echo hi; whoami 2>/dev/null || true", { stdin: "" });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^hi\n/);
  assert.ok(ssh.log().some((entry) => entry.target === "box@192.0.2.100"));

  const route = await plain.command!.route!(5900);
  assert.equal(route.type, "command");
  assert.deepEqual(route.type === "command" && route.argv.slice(-3), ["-W", "127.0.0.1:5900", "box@192.0.2.100"]);

  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const [display, ...others] = (await backend.transports(desktop, "linux-desktop")).displays;
  assert.equal(others.length, 0);
  assert.deepEqual([display!.id, display!.label, display!.protocol, display!.resizable], ["desktop", "Desktop", "rfb", true]);
  assert.deepEqual(await display!.open(), { route: { type: "tcp", host: "192.0.2.101", port: 5900 }, auth: { type: "none" } });
});

test("a desktop with a VNC password says so, and the relay answers it", async () => {
  const { backend } = setup({ "proxmox-lxc-desktop-vnc-password": "hunter2" });
  const desktop = await backend.acquire(identity("linux-desktop"), null, hooks().value, signal());
  const [display] = (await backend.transports(desktop, "linux-desktop")).displays;
  assert.deepEqual((await display!.open()).auth, { type: "vnc-password", password: "hunter2" });
});

test("the warm pool fills, hands out a ready guest and refills", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-warm": 1 });
  await backend.maintain();
  const warm = proxmox.guests.get(7000)!;
  assert.equal(warm.status, "running");
  assert.deepEqual(parseTags(warm.config.tags), ["bb-box", "warm", "template.headless"]);
  assert.deepEqual(await backend.held(), [], "warm guests belong to no box");

  const box = identity();
  const hook = hooks();
  const guest = await backend.acquire(box, null, hook.value, signal());
  assert.equal(guest.ref, "7000");
  assert.deepEqual(hook.events, ["claim 7000", "starting"]);
  assert.equal(ownerFromTags(parseTags(proxmox.guests.get(7000)!.config.tags))?.boxId, box.boxId);
  assert.equal(proxmox.guests.get(7000)!.name, box.name);

  // Claiming a warm guest starts a refill; maintain returns the one in flight.
  await backend.maintain();
  assert.deepEqual(parseTags(proxmox.guests.get(7001)?.config.tags), ["bb-box", "warm", "template.headless"]);
  const capacity = await backend.capacity("linux-headless", [], signal());
  assert.deepEqual(capacity.warm, { ready: 1, target: 1 });

  // Both headless kinds are clones of one template, so the warm guest serves either.
  const docker = identity("linux-headless-docker");
  const second = await backend.acquire(docker, null, hooks().value, signal());
  assert.equal(second.ref, "7001");
  assert.equal(ownerFromTags(parseTags(proxmox.guests.get(7001)!.config.tags))?.kind, "linux-headless-docker");
});

test("a warm guest satisfies capacity even when memory is short", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-headless-warm": 1 });
  await backend.maintain();
  proxmox.memory = { total: 64 * GiB, available: 1 * GiB };
  assert.equal((await backend.capacity("linux-headless", [], signal())).ok, true);
  assert.equal((await backend.capacity("linux-headless", ["linux-headless"], signal())).ok, false);
});

test("warm guests beyond the target are removed", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-headless-warm": 2 });
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 2);
  const smaller = track(
    new ProxmoxLxcBackend(lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret, "proxmox-lxc-vmid-first": 7000, "proxmox-lxc-vmid-last": 7009, "proxmox-lxc-headless-warm": 1 }), context, {
      fetch: proxmox.fetch,
      sleep: async () => {},
      sshBinary: FAKE_SSH_BINARY,
      readyTimeoutMs: 0,
    }),
  );
  await smaller.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  assert.deepEqual(context.errors, []);
});

test("the warm pool stops at the capacity guard", async () => {
  const { backend, proxmox, context } = setup({ "proxmox-lxc-headless-warm": 3 });
  proxmox.memory = { total: 16 * GiB, available: 9 * GiB };
  proxmox.intercept = (call) => {
    if (call.path.endsWith("/clone")) proxmox.memory = { ...proxmox.memory, available: proxmox.memory.available - 2 * GiB };
    return undefined;
  };
  await backend.maintain();
  assert.equal([...proxmox.guests.values()].filter((guest) => !guest.template).length, 1);
  assert.match(context.errors.join("\n"), /warm pool: .*memory free/);
});

test("doctor passes on a complete setup and shows the generated public key", async () => {
  const { backend, storage } = setup({ "proxmox-lxc-ssh-private-key": "" });
  const report = await backend.doctor();
  assert.equal(report.ok, true, JSON.stringify(report, null, 2));
  assert.equal(report.summary, "Proxmox VE 9.2.0 on pve");
  assert.deepEqual(
    report.checks.map((check) => [check.id, check.name, check.status]),
    [
      ["proxmox.api", "Proxmox API", "ok"],
      ["proxmox.node", "Node", "ok"],
      ["proxmox.memory", "Node memory", "ok"],
      ["proxmox.pool", "Resource pool", "ok"],
      ["template.headless", "Headless template", "ok"],
      ["template.desktop", "Desktop template", "ok"],
      ["proxmox.bridge", "Network bridge", "ok"],
      ["proxmox.vmids", "VMID range", "ok"],
      ["ssh.key", "SSH key", "ok"],
    ],
  );
  assert.match(report.notes.join("\n"), /user box .* accept this SSH key .*: ssh-ed25519 \S+ bb-box$/);
  const stored = await storage.get<{ privateKey: string; publicKey: string }>("ssh-key");
  assert.ok(stored?.privateKey.startsWith("-----BEGIN OPENSSH PRIVATE KEY-----"));
  assert.doesNotMatch(JSON.stringify(report), /PRIVATE KEY/);
});

test("doctor says what is missing", async () => {
  const { backend, proxmox } = setup();
  proxmox.pools.clear();
  proxmox.bridges.delete("vmbr1");
  proxmox.guests.get(9000)!.config.features = "";
  proxmox.guests.delete(9001);
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  const byId = Object.fromEntries(report.checks.map((check) => [check.id, check]));
  assert.equal(byId["proxmox.pool"]!.status, "fail");
  assert.match(byId["proxmox.pool"]!.fix!, /pveum pool add bb-box/);
  assert.match(byId["template.headless"]!.fix!, /pct set 9000 --features nesting=1/);
  assert.match(byId["template.desktop"]!.detail, /CT 9001 does not exist on pve/);
  assert.match(byId["proxmox.bridge"]!.detail, /pve has no vmbr1/);
  assert.match(report.summary, /^Resource pool: /);
});

test("doctor warns, without failing, when every VMID is in use", async () => {
  const { backend, proxmox } = setup({ "proxmox-lxc-vmid-last": 7000, "proxmox-lxc-ssh-private-key": "" });
  proxmox.guests.set(7000, { vmid: 7000, name: "x", pool: "bb-box", status: "running", template: false, config: {} });
  const report = await backend.doctor();
  assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === "fail")));
  const vmids = report.checks.find((check) => check.id === "proxmox.vmids")!;
  assert.equal(vmids.status, "warn");
  assert.match(vmids.fix!, /widen the VMID range/);
});

test("doctor with a wrong token skips the rest and never shows the secret", async () => {
  const { backend } = setup({ "proxmox-lxc-token-secret": "wrong-secret-value" });
  const report = await backend.doctor();
  assert.equal(report.ok, false);
  assert.equal(report.checks[0]!.status, "fail");
  assert.match(report.checks[0]!.fix!, /token ID and secret/);
  assert.ok(report.checks.slice(1, -1).every((check) => check.status === "skipped"));
  assert.doesNotMatch(JSON.stringify(report), /wrong-secret-value|s3cret-token-value/);
});

test("errors never contain the token secret", async () => {
  const { backend } = setup({ "proxmox-lxc-token-secret": "wrong-secret-value" });
  await assert.rejects(backend.capacity("linux-headless", [], signal()), (error: unknown) => {
    assert.doesNotMatch(String(error), /wrong-secret-value/);
    return true;
  });
});

test("dispose stops a warm fill", async () => {
  const { backend } = setup({ "proxmox-lxc-headless-warm": 1 });
  const fill = backend.maintain();
  await backend.dispose();
  await fill.catch(() => undefined);
});
