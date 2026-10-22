import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KEEP_AHEAD_MS, LABELS, NamespaceBackend, macShapeFor } from "../src/backends/namespace/backend.ts";
import { parseNamespacePart, type NamespaceConfig } from "../src/backends/namespace/config.ts";
import { Tailnet } from "../src/core/tailnet.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest } from "../src/backends/types.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace, type FakeInstance } from "./fake-namespace.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, testContext } from "./helpers.ts";

const CONFIG: NamespaceConfig = { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 2, longestLifeHours: 4, largestMachine: null };

function setup(options: { config?: Partial<NamespaceConfig>; now?: () => number } = {}) {
  fakeSsh();
  const fake = new FakeNamespace({ ...(options.now ? { now: options.now } : {}), lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const context = testContext(new MemoryStorage(), "inst1");
  const backend = new NamespaceBackend({ ...CONFIG, ...options.config }, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, ...(options.now ? { now: options.now } : {}) });
  return { fake, backend, context };
}

function box(id: string, size = { cores: 4, memoryMiB: 8192, diskGiB: null }): BoxIdentity {
  return { boxId: id, threadId: "thr_1", name: `box-${id}`, kind: "macos", createdAt: Date.parse("2030-01-01T00:00:00Z"), size };
}

function hooks() {
  const claims: Guest[] = [];
  const steps: string[] = [];
  const recorded: AcquireHooks = { claim: async (guest) => void claims.push(guest), starting: async () => {}, timing: (step) => void steps.push(step) };
  return { claims, steps, hooks: recorded };
}

test("a box's size takes Namespace's smallest Mac with at least its cores and memory, as Namespace has only fixed shapes", () => {
  assert.deepEqual(macShapeFor({ cores: 4, memoryMiB: 7168, diskGiB: null }), { cores: 4, memoryGB: 7 });
  assert.deepEqual(macShapeFor({ cores: 4, memoryMiB: 8192, diskGiB: null }), { cores: 4, memoryGB: 14 });
  assert.deepEqual(macShapeFor({ cores: 6, memoryMiB: 16384, diskGiB: null }), { cores: 6, memoryGB: 28 });
  assert.deepEqual(macShapeFor({ cores: 8, memoryMiB: 32768, diskGiB: null }), { cores: 12, memoryGB: 56 });
  assert.equal(macShapeFor({ cores: 32, memoryMiB: 8192, diskGiB: null }), null);
});

test("an acquire claims the box before it makes the machine, labels it with its install and box, keeps the deadline an hour ahead, and says when it ends", async () => {
  const now = Date.parse("2030-01-01T00:00:00Z");
  const { fake, backend } = setup({ now: () => now });
  const recorded = hooks();
  const guest = await backend.acquire(box("b1"), null, recorded.hooks, new AbortController().signal);
  assert.equal(recorded.claims[0]?.data?.instance, undefined, "the first claim is made before the machine is");
  assert.equal(fake.calls[0]?.method, "CreateInstance");
  const made = [...fake.instances.values()][0]!;
  assert.deepEqual(made.labels, { [LABELS.install]: "inst1", [LABELS.box]: "b1", [LABELS.thread]: "thr_1", [LABELS.name]: "box-b1", [LABELS.kind]: "macos", [LABELS.created]: String(Date.parse("2030-01-01T00:00:00Z")) });
  assert.equal(made.uniqueTag, "bbbox-inst1-b1");
  assert.equal(made.deadline, now + KEEP_AHEAD_MS);
  assert.deepEqual(made.shape, { os: "macos", machineArch: "arm64", virtualCpu: 4, memoryMegabytes: 14336, selectors: [{ name: "macos.version", value: "26.x" }] });
  assert.equal(made.sshKeys.length, 1);
  assert.match(made.sshKeys[0]!, /^ssh-ed25519 /);
  assert.deepEqual(guest.data, { box: "b1", instance: made.id });
  assert.equal(guest.endsAt, now + 4 * 3600_000);
  assert.deepEqual(guest.facts, [
    { label: "Ends", value: "04:00 UTC, the plan's longest life" },
    { label: "Runs in", value: "us" },
  ]);
  assert.deepEqual(recorded.steps, ["create", "ready", "ssh"]);
  const transports = await backend.transports(guest, "macos");
  assert.deepEqual(transports.access?.ssh, { host: "ssh.us.namespace.so", port: 22, user: made.id, hostKeys: [] });
});

test("a box that does not start destroys its machine, and the most machines at once is a limit with its reason", async () => {
  const { fake, backend } = setup({ config: { machines: 1 } });
  fake.failNext("WaitInstanceSync", "internal", "the machine failed to boot");
  await assert.rejects(backend.acquire(box("b1"), null, hooks().hooks, new AbortController().signal), /failed to boot/);
  assert.deepEqual(fake.running(), []);
  await backend.acquire(box("b2"), null, hooks().hooks, new AbortController().signal);
  const full = await backend.capacity("macos", { cores: 4, memoryMiB: 8192, diskGiB: null }, []);
  assert.equal(full.ok, false);
  assert.match(full.message ?? "", /1 of the 1 machines bb-box may have at once/);
});

test("a workspace's largest Mac, set or learned from Namespace's refusal, is refused up front with what to ask for instead", async () => {
  const medium = { cores: 6, memoryMiB: 16384, diskGiB: null };
  const set = setup({ config: { largestMachine: { cores: 6, memoryGB: 14 } } });
  const refused = await set.backend.capacity("macos", medium, []);
  assert.equal(refused.ok, false);
  assert.equal(refused.message, "Namespace's workspace allows Macs of at most 6 cores and 14 GB of memory, and 6 cores and 16 GiB needs its 6x28 Mac. Ask for at most 6 cores and 14 GiB, which gets its 6x14 Mac, or use another backend.");
  assert.equal((await set.backend.capacity("macos", { cores: 6, memoryMiB: 14336, diskGiB: null }, [])).ok, true);
  assert.equal(set.fake.calls.filter((call) => call.method === "CreateInstance").length, 0);

  const learned = setup();
  assert.equal((await learned.backend.capacity("macos", medium, [])).ok, true, "nothing known yet");
  learned.fake.failNext("CreateInstance", "invalid_argument", "requesting more machine resources than workspace quota allows (requesting 6x28, maximum 6x14)");
  const error = await learned.backend.acquire(box("b1", medium), null, hooks().hooks, new AbortController().signal).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof BackendError && error.code === "no_capacity");
  assert.match(error.message, /at most 6 cores and 14 GB/);
  assert.equal((await learned.backend.capacity("macos", medium, [])).ok, false, "refused up front from then on");
  assert.equal((await learned.backend.capacity("macos", { cores: 4, memoryMiB: 8192, diskGiB: null }, [])).ok, true);
  assert.equal(parseNamespacePart({ fields: { token: FAKE_NAMESPACE_TOKEN, "largest-machine": "6 x 14" } } as never).ok, true);
  assert.equal(parseNamespacePart({ fields: { token: FAKE_NAMESPACE_TOKEN, "largest-machine": "big" } } as never).ok, false);
});

test("a Namespace Mac's user is an administrator who can use sudo", () => {
  const { backend } = setup();
  assert.ok(backend.kinds().every((kind) => kind.capabilities.command?.admin === true));
});

test("Namespace refusing a machine for want of room is the backend having none", async () => {
  const { fake, backend } = setup();
  fake.failNext("CreateInstance", "resource_exhausted", "concurrency limit reached");
  const error = await backend.acquire(box("b1"), null, hooks().hooks, new AbortController().signal).catch((thrown: unknown) => thrown);
  assert.ok(error instanceof BackendError && error.code === "no_capacity");
});

test("upkeep keeps each recorded machine's deadline an hour ahead until the plan's longest life, and leaves one no box records to end at its own", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  const { fake, backend } = setup({ now: () => now });
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, new AbortController().signal);
  await backend.acquire(box("b2"), null, hooks().hooks, new AbortController().signal);
  const [made, leftover] = [...fake.instances.values()] as [FakeInstance, FakeInstance];
  const recorded = new Set([guest.ref]);
  now += 40 * 60_000;
  await backend.maintain(undefined, recorded);
  assert.equal(made.deadline, now + KEEP_AHEAD_MS);
  assert.equal(leftover.deadline, Date.parse("2030-01-01T01:00:00Z"), "a machine no box records is not kept alive");
  now += 4 * 60_000;
  await backend.maintain(undefined, recorded);
  assert.equal(made.deadline, now - 4 * 60_000 + KEEP_AHEAD_MS, "a deadline still most of an hour ahead is left");
  while (now + 30 * 60_000 <= Date.parse("2030-01-01T03:50:00Z")) {
    now += 30 * 60_000;
    await backend.maintain(undefined, recorded);
    assert.equal(made.status, "RUNNING");
  }
  assert.equal(made.deadline, Date.parse("2030-01-01T04:00:00Z"), "never past the plan's longest life");
  assert.equal(leftover.status, "DESTROYED", "the leftover ended at its first deadline");
});

test("held lists this install's machines with their owners, a release destroys the machine, and the sweep sees a machine no box claims", async () => {
  const { fake, backend } = setup();
  const guest = await backend.acquire(box("b1"), null, hooks().hooks, new AbortController().signal);
  await fake.fetch("https://us.compute.namespaceapis.com/namespace.cloud.compute.v1beta.ComputeService/CreateInstance", {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_NAMESPACE_TOKEN}` },
    body: JSON.stringify({ shape: { os: "macos", machineArch: "arm64", virtualCpu: 4, memoryMegabytes: 7168 }, labels: [{ name: LABELS.install, value: "inst1" }], deadline: new Date(Date.now() + 600_000).toISOString() }),
  });
  await fake.fetch("https://us.compute.namespaceapis.com/namespace.cloud.compute.v1beta.ComputeService/CreateInstance", {
    method: "POST",
    headers: { Authorization: `Bearer ${FAKE_NAMESPACE_TOKEN}` },
    body: JSON.stringify({ shape: { os: "macos", machineArch: "arm64", virtualCpu: 4, memoryMegabytes: 7168 }, labels: [{ name: LABELS.install, value: "another" }], deadline: new Date(Date.now() + 600_000).toISOString() }),
  });
  const held = await backend.held();
  assert.equal(held.length, 2, "only this install's machines");
  assert.deepEqual(held.find((one) => one.data?.box === "b1")?.owner, { boxId: "b1", threadId: "thr_1", name: "box-b1", kind: "macos", createdAt: Date.parse("2030-01-01T00:00:00Z") });
  assert.equal(held.find((one) => !one.data?.box)?.owner, null);
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(await backend.power(guest), null);
  assert.equal(fake.running().filter((instance) => instance.labels[LABELS.install] === "inst1").length, 1);
});

test("the doctor lists the machines and their ends, warns of one no box claims, and never shows the token", async () => {
  const { fake, backend } = setup();
  await backend.acquire(box("b1"), null, hooks().hooks, new AbortController().signal);
  const report = await backend.doctor();
  assert.equal(report.ok, true);
  assert.match(report.checks.find((check) => check.id === "namespace.machines")?.detail ?? "", /^1 of at most 2: box-b1, 0 min old, ends \d\d:\d\d UTC, in us\.$/);
  fake.token = "nsct_other";
  const refused = await backend.doctor();
  assert.equal(refused.ok, false);
  assert.doesNotMatch(JSON.stringify(refused), /fakeTOKEN|nsct_/);
});

test("the settings need a token, a known region and sane limits, each problem at its field", () => {
  const parsed = parseNamespacePart({ id: "namespace", hosts: [], fields: { token: "", region: "asia", "macos-version": "latest", machines: 0, "longest-life-hours": 30 } });
  assert.equal(parsed.ok, false);
  assert.deepEqual(parsed.ok ? [] : parsed.problems.map((problem) => problem.path), ["token", "region", "macos-version", "machines", "longest-life-hours"]);
  const fine = parseNamespacePart({ id: "namespace", hosts: [], fields: { token: FAKE_NAMESPACE_TOKEN } });
  assert.deepEqual(fine.ok ? fine.config : null, { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 2, longestLifeHours: 3, largestMachine: null });
});

function fakeTailscaleTools() {
  const dir = mkdtempSync(join(tmpdir(), "ns-tailscale-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  tool("tailscale", `printf '%s\\n' "tailscale $*" >> ${log}\ncase "$1" in up) f=$(printf '%s' "$2" | sed 's/^--auth-key=file://'); printf 'key %s\\n' "$(cat "$f")" >> ${log};; ip) echo 100.64.0.9;; esac`);
  tool("tailscaled", `printf '%s\\n' "tailscaled $*" >> ${log}`);
  tool("brew", `printf '%s\\n' "brew $*" >> ${log}`);
  tool("sudo", `[ "$1" = -n ] && shift\nexec "$@"`);
  process.env.PATH = `${dir}:${process.env.PATH}`;
  return { calls: () => readFileSync(log, "utf8").trim().split("\n").filter(Boolean) };
}

test("with a tailnet, each Mac joins it with a single-use key of its own, given only on its input, leaves it at release, and its stale device goes", async () => {
  const tools = fakeTailscaleTools();
  const minted: string[] = [];
  const devices = [
    { nodeId: "old", hostname: "bb-box-ns-inst1-gone-box", tags: ["tag:bb-box"], lastSeen: "2020-01-01T00:00:00Z" },
    { nodeId: "other-install", hostname: "bb-box-ns-inst2-gone-box", tags: ["tag:bb-box"], lastSeen: "2020-01-01T00:00:00Z" },
    { nodeId: "hetzner", hostname: "bb-box-hz-inst1-host-1", tags: ["tag:bb-box"], lastSeen: "2020-01-01T00:00:00Z" },
  ];
  const removed: string[] = [];
  const tailnet = new Tailnet({
    credentials: { clientId: "id", clientSecret: "secret" },
    fetch: async (url, init) => {
      const path = new URL(url).pathname;
      const reply = (body: unknown) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
      if (path === "/api/v2/oauth/token") return reply({ access_token: "tok", expires_in: 3600 });
      if (path === "/api/v2/tailnet/-/keys") {
        minted.push(JSON.parse(init.body!).description);
        return reply({ id: `k${minted.length}`, key: `tskey-auth-one-off-${minted.length}`, expires: "2030-01-01T00:10:00Z" });
      }
      if (path === "/api/v2/tailnet/-/devices") return reply({ devices });
      if (path.startsWith("/api/v2/device/")) return removed.push(path.split("/").at(-1)!), reply({});
      return { ok: false, status: 404, text: async () => "{}" };
    },
  });
  fakeSsh();
  const fake = new FakeNamespace({ maxCores: 64 });
  const context = { ...testContext(new MemoryStorage(), "inst1"), tailnet: () => tailnet };
  const backend = new NamespaceBackend(CONFIG, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 });
  const recorded = hooks();
  const guest = await backend.acquire(box("b1"), null, recorded.hooks, new AbortController().signal);
  assert.deepEqual(recorded.steps, ["create", "ready", "ssh", "tailnet"]);
  assert.deepEqual(minted, ["bb-box Namespace box-b1"]);
  const calls = tools.calls();
  assert.ok(!calls.some((call) => call.startsWith("brew")), "a Mac with Tailscale installs nothing");
  assert.ok(calls.some((call) => /^tailscale up --auth-key=file:\S+ --hostname=bb-box-ns-inst1-box-b1 --accept-dns=false --timeout=60s$/.test(call)), calls.join("; "));
  assert.ok(calls.includes("key tskey-auth-one-off-1"));
  assert.ok(!calls.some((call) => call.startsWith("tailscale") && call.includes("tskey-")), "the key is never on a command line");
  await backend.maintain();
  assert.deepEqual(removed, ["old"], "only this install's Namespace device that is gone, not another install's or another backend's");
  await backend.release(guest, { resetting: async () => {}, timing: () => {} });
  assert.equal(tools.calls().at(-1), "tailscale logout");
});

test("a macos-desktop box gets its desktop ready as it starts: the video helper built from bb-box's source, Screen Recording, Accessibility and event posting for the processes that need them, and a display that stays awake; and shows it over Screen Sharing and as video", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-desktop-"));
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const tool = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  tool("xcrun", `printf '%s\\n' "xcrun $*" >> ${log}\nout=; while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; : > "$out"`);
  tool("sudo", `printf '%s\\n' "sudo $*" >> ${log}`);
  tool("caffeinate", `printf '%s\\n' "caffeinate $*" >> ${log}`);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const { fake, backend } = setup();
    const desktop = await backend.acquire({ ...box("d1"), kind: "macos-desktop" }, null, hooks().hooks, new AbortController().signal);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.match(calls[0]!, /^xcrun swiftc -O -swift-version 5 -o \S+ \S+stream\.swift$/);
    assert.ok(calls.some((call) => /^sudo -n install -m 0755 \S+ \/usr\/local\/bin\/bb-box-stream$/.test(call)), calls.join("; "));
    const grants = calls.filter((call) => call.startsWith("sudo -n sqlite3"));
    assert.equal(grants.length, 9);
    for (const client of ["/opt/namespace/vmguest", "/usr/bin/osascript", "/usr/local/bin/bb-box-stream"]) {
      for (const service of ["kTCCServiceScreenCapture", "kTCCServiceAccessibility", "kTCCServicePostEvent"]) {
        assert.ok(grants.some((grant) => grant.includes(`'${service}', '${client}', 1, 2`)), `${service} for ${client}`);
      }
    }
    assert.ok(calls.includes("sudo -n pmset -a displaysleep 0 sleep 0"), calls.join("; "));
    assert.ok(calls.includes("caffeinate -u -t 1"), calls.join("; "));

    const transports = await backend.transports(desktop, "macos-desktop");
    assert.deepEqual(transports.displays.map((display) => `${display.id} ${display.protocol}`), ["desktop rfb", "video selkies"]);
    const made = [...fake.instances.values()][0]!;
    const opened = await transports.displays[0]!.open();
    assert.deepEqual(opened.auth, { type: "apple", user: "runner", password: `vnc-${made.id}` });
    assert.ok(opened.input, "the viewer's input goes to the input helper");
    const route = JSON.stringify(opened.route);
    assert.match(route, /127\.0\.0\.1:5900/);
    assert.match(route, new RegExp(`${made.id}@ssh\\.us\\.namespace\\.so`));
    assert.match(JSON.stringify((await transports.displays[1]!.open()).route), /bb-box-stream connect/);
    assert.deepEqual((await backend.transports(desktop, "macos")).displays, []);
  } finally {
    process.env.PATH = path;
  }
});
