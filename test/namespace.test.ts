import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { KEEP_AHEAD_MS, LABELS, MAC_CUA, MEASURE_AGAIN_AFTER_MS, MEASURE_LIFE_MS, MEASURE_ROLE, NamespaceBackend, macShapeFor } from "../src/backends/namespace/backend.ts";
import { MACHINES_KEPT_PER_CHIP, NamespaceMacReports } from "../src/backends/namespace/mac-reports.ts";
import { CUA_SHA256, CUA_VERSION } from "../src/backends/tart/backend.ts";
import { parseNamespacePart, type NamespaceConfig } from "../src/backends/namespace/config.ts";
import { Tailnet } from "../src/core/tailnet.ts";
import { PROBE_VERSION, reportKey, type MacReport } from "../src/core/mac-capabilities.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest } from "../src/backends/types.ts";
import { FAKE_NAMESPACE_TOKEN, FakeNamespace, type FakeInstance } from "./fake-namespace.ts";
import { FAKE_SSH_BINARY, MemoryStorage, disposedOnceTheFileEnds, fakeSsh, testContext } from "./helpers.ts";

const disposed = disposedOnceTheFileEnds();
const CONFIG: NamespaceConfig = { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 2, longestLifeHours: 4, largestMachine: null };

function setup(options: { config?: Partial<NamespaceConfig>; now?: () => number; cuaScript?: string } = {}) {
  fakeSsh();
  const fake = new FakeNamespace({ ...(options.now ? { now: options.now } : {}), lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const context = testContext(new MemoryStorage(), "inst1");
  const backend = new NamespaceBackend({ ...CONFIG, ...options.config }, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, cuaScript: options.cuaScript ?? ":", ...(options.now ? { now: options.now } : {}) });
  return { fake, backend: disposed(backend), context };
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
  assert.deepEqual(fake.calls.slice(0, 2).map((call) => call.method), ["GetConcurrency", "CreateInstance"], "the workspace's limits are read, then the machine made");
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
  learned.fake.usageGranted = false;
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

test("with the usage grant, capacity reads the workspace's Mac limits from Namespace: the largest Mac it allows, and whether its cores are taken, before asking for one", async () => {
  const { fake, backend } = setup();
  const small = { cores: 4, memoryMiB: 8192, diskGiB: null };
  const workspace = new FakeNamespace({ maxCores: 6, maxMacMemoryMb: 14336 });
  const limited = disposed(new NamespaceBackend(CONFIG, testContext(new MemoryStorage(), "inst1"), { fetch: workspace.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 }));
  const medium = await limited.capacity("macos", { cores: 6, memoryMiB: 16384, diskGiB: null }, []);
  assert.equal(medium.ok, false);
  assert.match(medium.message!, /at most 6 cores and 14 GB of memory, and 6 cores and 16 GiB needs its 6x28 Mac/);
  assert.equal((await limited.capacity("macos", small, [])).ok, true);
  await limited.acquire(box("b1", small), null, hooks().hooks, new AbortController().signal);
  const full = await limited.capacity("macos", small, []);
  assert.equal(full.ok, false);
  assert.equal(full.message, "Namespace's workspace has 4 of its 6 Mac cores and 14 of its 14 GB of Mac memory in use, and this box needs a 4x14 Mac. Release a Mac box, or wait for one to end.");
  assert.equal(workspace.calls.filter((call) => call.method === "CreateInstance").length, 1, "the second Mac was never asked for");
  const doctor = await limited.doctor();
  assert.equal(doctor.checks.find((check) => check.id === "namespace.limits")?.detail, "The workspace allows 6 Mac cores and 14 GB of Mac memory at once, 4 cores in use now; the largest Mac bb-box asks for is 6x14.");

  fake.usageGranted = false;
  assert.equal((await backend.capacity("macos", small, [])).ok, true, "without the grant, capacity goes on as before");
  const warned = (await backend.doctor()).checks.find((check) => check.id === "namespace.limits")!;
  assert.equal(warned.status, "warn");
  assert.match(warned.detail, /^The token may not read the workspace's limits\./);
  assert.match(warned.fix!, /"resource_type":"tenant\/usage","resource_id":"\*","actions":\["get"\]/);
});

test("a cancelled acquire stops waiting for SSH at once, even with the tests' sleep that does not wait, and destroys the machine", async () => {
  const { fake, backend } = setup();
  writeFileSync(join(process.env.FAKE_SSH_DIR!, "down", "ssh.us.namespace.so"), "");
  const controller = new AbortController();
  const started = Date.now();
  const acquiring = backend.acquire(box("b1"), null, { ...hooks().hooks, starting: async () => void setTimeout(() => controller.abort(new Error("cancelled")), 200) }, controller.signal);
  await assert.rejects(acquiring, /cancelled/);
  assert.ok(Date.now() - started < 5_000, `it stopped after ${Date.now() - started} ms: at the cancel, not the 20 s deadline`);
  assert.deepEqual(fake.running(), [], "the machine was destroyed");
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
  assert.deepEqual(fine.ok ? fine.config : null, { token: FAKE_NAMESPACE_TOKEN, region: "us", macosVersion: "26.x", machines: 2, longestLifeHours: 3, largestMachine: null, iosHosts: { on: true, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 } });
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
  const backend = disposed(new NamespaceBackend(CONFIG, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000 }));
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

test("a macos-desktop box gets its desktop ready as it starts: the video helper built from bb-box's source, Screen Recording, Accessibility and event posting for the processes that need them, no screen-capture notice for those that capture, and a display that stays awake; and shows it over Screen Sharing and as video", async () => {
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
  tool("killall", `printf '%s\\n' "killall $*" >> ${log}`);
  tool("brew", `printf '%s\\n' "brew $*" >> ${log}`);
  const path = process.env.PATH;
  process.env.PATH = `${dir}:${path}`;
  try {
    const { fake, backend } = setup();
    const desktop = await backend.acquire({ ...box("d1"), kind: "macos-desktop" }, null, hooks().hooks, new AbortController().signal);
    const calls = readFileSync(log, "utf8").trim().split("\n");
    assert.ok(calls.some((call) => /^xcrun swiftc -O -swift-version 5 -o \S+ \S+stream\.swift$/.test(call)), calls.join("; "));
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
    const approvals = readFileSync(join(process.env.FAKE_SSH_DIR!, "home", "ssh.us.namespace.so", "Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist"), "utf8");
    const hintYear = new Date().getUTCFullYear() + 5;
    for (const client of ["/opt/namespace/vmguest", "/usr/local/bin/bb-box-stream", "com.trycua.driver"]) {
      assert.ok(approvals.includes(`<key>${client}</key><dict><key>kScreenCaptureAlertableUsageCount</key>`), `${client}'s notice put off`);
    }
    assert.equal(approvals.match(new RegExp(`<key>kScreenCapturePrivacyHintDate</key><date>${hintYear}-01-01T00:00:00Z</date>`, "g"))?.length, 3);
    assert.ok(calls.some((call) => /^killall -u \S+ replayd$/.test(call)), "replayd reads them afresh");
    assert.ok(calls.includes("brew install --quiet ffmpeg"), "ffmpeg, which box_record needs, is installed");

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

test("a macos-desktop box gets Cua Driver for computer use: the pinned release checked by its SHA-256, Accessibility and Screen Recording for its code requirement, and its LaunchAgent answering on its socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ns-cua-"));
  const home = join(dir, "home");
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(home);
  const log = join(dir, "calls");
  writeFileSync(log, "");
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\nprintf '%s\\n' "${name} $*" >> ${log}\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const socket = join(home, "Library/Caches/cua-driver/cua-driver.sock");
  tool("curl", 'while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; printf archive > "$out"');
  tool("shasum", `read -r sum file; [ "$sum" = "${CUA_SHA256}" ] && [ -f "$file" ] && [ ! -e "${dir}/mismatch" ]`);
  tool("tar", 'while [ $# -gt 0 ]; do [ "$1" = -C ] && into=$2; shift; done; mkdir -p "$into/cua-driver-rs-' + CUA_VERSION + '-darwin-arm64/CuaDriver.app"');
  tool("codesign", 'echo \'designated => identifier "com.trycua.driver" and anchor apple generic\'');
  tool("csreq", 'while [ $# -gt 0 ]; do [ "$1" = -b ] && out=$2; shift; done; printf req > "$out"');
  tool("xxd", "echo 0a0b");
  tool("sudo", `[ "$2" = launchctl ] && mkdir -p "${join(home, "Library/Caches/cua-driver")}" && python3 -c 'import socket,sys; socket.socket(socket.AF_UNIX).bind(sys.argv[1])' "${socket}"; :`);
  tool("cua-driver", '[ "$1" = permissions ] && echo \'{"accessibility": true, "screen_recording": true}\'; :');
  const shell = spawnSync("zsh", ["-fc", ":"]).status === 0 ? "zsh" : "sh";
  const run = () => spawnSync(shell, ["-c", MAC_CUA], { env: { PATH: `${bin}:${process.env.PATH}`, HOME: home }, encoding: "utf8" });
  const done = run();
  assert.equal(done.status, 0, done.stderr);
  const calls = readFileSync(log, "utf8").trim().split("\n");
  assert.ok(calls[0]!.includes(`https://github.com/trycua/cua/releases/download/cua-driver-rs-v${CUA_VERSION}/cua-driver-rs-${CUA_VERSION}-darwin-arm64.tar.gz`), calls[0]);
  assert.ok(calls.some((call) => /^sudo -n cp -R \S+\/CuaDriver\.app \/Applications\/$/.test(call)), calls.join("; "));
  const grants = calls.filter((call) => call.startsWith("sudo -n sqlite3"));
  for (const service of ["kTCCServiceAccessibility", "kTCCServiceScreenCapture"]) {
    assert.ok(grants.some((grant) => grant.includes(`'${service}', 'com.trycua.driver', 0, 2, 4, 1, X'0a0b'`)), service);
  }
  assert.match(readFileSync(join(home, "Library/LaunchAgents/com.trycua.cua-driver.plist"), "utf8"), /<string>serve<\/string>/);
  assert.ok(calls.some((call) => /^sudo -n launchctl bootstrap gui\/\d+ \S+com\.trycua\.cua-driver\.plist$/.test(call)), calls.join("; "));

  rmSync(socket);
  writeFileSync(join(dir, "mismatch"), "");
  const refused = run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /Cua Driver's archive does not match its pin\./);

  const { backend } = setup();
  assert.deepEqual(backend.kinds().find((kind) => kind.id === "macos-desktop")!.capabilities.computerUse, { driver: "cua", version: CUA_VERSION, socket: "/Users/runner/Library/Caches/cua-driver/cua-driver.sock" });
  assert.equal(backend.kinds().find((kind) => kind.id === "macos")!.capabilities.computerUse, null);
  assert.equal(backend.kinds().find((kind) => kind.id === "macos-desktop")!.capabilities.displays[0]!.clipboard, "commands", "Screen Sharing sends a viewer none of the box's clipboard, so bb-box moves it with pbcopy and pbpaste");
});

test("Namespace offers ios as slots on a shared host once it has measured a Mac that runs the iOS Simulator, and not while its setting is off (065, unit 7)", async () => {
  const report = {
    mac: "Apple M4 Pro (Virtual)",
    chip: "Apple M4 Pro (Virtual)",
    macos: "26.3.1",
    at: 1,
    where: "mac",
    capabilities: {
      simulator: { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2"], newest: { os: "26.2", build: "23C54" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17"] } },
      hardwareEncoder: { is: "yes", what: { fullSizeFps: 141 } },
      softwareEncoder: { is: "no", why: "bb-box-h264 is not installed" },
    },
  };
  const made = async (iosHosts?: NamespaceConfig["iosHosts"]) => {
    fakeSsh();
    const storage = new MemoryStorage();
    await storage.set(reportKey(report.chip), report);
    const fake = new FakeNamespace({ lifeCapMs: 4 * 3600_000, maxCores: 64 });
    const backend = disposed(new NamespaceBackend({ ...CONFIG, ...(iosHosts ? { iosHosts } : {}) }, testContext(storage, "inst1"), { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, cuaScript: ":" }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    return backend;
  };
  const backend = await made();
  const ios = backend.kinds().find((kind) => kind.id === "ios");
  assert.ok(ios?.slotsOnly);
  assert.equal(ios.capabilities.command?.admin, false);
  assert.deepEqual(ios.capabilities.device?.devices.map((device) => device.model), ["iPhone 17"]);
  assert.equal(backend.slots.lends("ios"), true);
  const capacity = await backend.capacity("ios", { cores: 6, memoryMiB: 14336, diskGiB: null }, []);
  assert.equal(capacity.ok, false);
  assert.match(capacity.message ?? "", /only as slots on a shared iOS host/);
  assert.match(backend.macCapabilities()[0]?.chip ?? "", /M4 Pro/);
  const off = await made({ on: false, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 });
  assert.equal(off.kinds().some((kind) => kind.id === "ios"), false);
});

const IOS_REPORT: MacReport = {
  mac: "Apple M4 Pro (Virtual)",
  chip: "Apple M4 Pro (Virtual)",
  macos: "26.3.1",
  at: 1,
  where: "mac",
  capabilities: {
    simulator: { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2"], newest: { os: "26.2", build: "23C54" }, deviceTypes: ["com.apple.CoreSimulator.SimDeviceType.iPhone-17"] } },
    hardwareEncoder: { is: "yes", what: { fullSizeFps: 141 } },
    softwareEncoder: { is: "no", why: "bb-box-h264 is not installed" },
  },
  probe: PROBE_VERSION,
};

test("Namespace counts which of its Macs of a kind had a hardware encoder, once each, and says each host builds the software one (065 C follow-up)", async () => {
  const storage = new MemoryStorage();
  const reports = new NamespaceMacReports(storage, () => {});
  const noHardware: MacReport = { ...IOS_REPORT, at: 2, capabilities: { ...IOS_REPORT.capabilities, hardwareEncoder: { is: "no", why: "VideoToolbox could not make a hardware session (-12903)" } } };
  reports.remember({ ...IOS_REPORT, mac: "instance-a" }, "instance-a");
  reports.remember({ ...IOS_REPORT, mac: "instance-a" }, "instance-a");
  assert.deepEqual(reports.all()[0]?.machines, { withHardwareEncoder: 1, withoutHardwareEncoder: 0 });
  assert.equal(reports.all()[0]?.capabilities.softwareEncoder.is, "yes", "each host builds bb-box-h264 as it starts");
  reports.remember({ ...noHardware, mac: "instance-b" }, "instance-b");
  const [kind] = reports.all();
  assert.deepEqual(kind?.machines, { withHardwareEncoder: 1, withoutHardwareEncoder: 1 });
  assert.equal(kind?.capabilities.hardwareEncoder.is, "no", "the latest machine's measure is the kind's");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const again = new NamespaceMacReports(storage, () => {});
  for (const report of await again.load()) again.remember(report, null);
  assert.deepEqual(again.all()[0]?.machines, { withHardwareEncoder: 1, withoutHardwareEncoder: 1 });
  for (let n = 0; n < MACHINES_KEPT_PER_CHIP + 5; n++) again.remember({ ...IOS_REPORT, at: 10 + n, mac: `more-${n}` }, `more-${n}`);
  assert.deepEqual(again.all()[0]?.machines, { withHardwareEncoder: MACHINES_KEPT_PER_CHIP, withoutHardwareEncoder: 0 }, "it keeps the latest machines of each kind");
});

test("box_list's ios offer on Namespace says its slots are on a Mac made for them, and the doctor says when Namespace's Macs vary by machine", async () => {
  fakeSsh();
  const storage = new MemoryStorage();
  await storage.set(reportKey(IOS_REPORT.chip!), IOS_REPORT);
  await storage.set("mac-machines/Apple M4 Pro (Virtual)", { "instance-a": true, "instance-b": false });
  const fake = new FakeNamespace({ lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const backend = disposed(new NamespaceBackend(CONFIG, testContext(storage, "inst1"), { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, cuaScript: ":" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(backend.offerNote("ios") ?? "", /^iOS slots on a Namespace Mac made for the first ios box, in about 5 minutes, and deleted after its last; as many slots as its cores, memory and video encoder allow; each slot a macOS user/);
  assert.equal(backend.offerNote("macos"), null);
  const report = await backend.doctor();
  const varies = report.checks.find((check) => check.id === "devices.namespace");
  assert.match(varies?.detail ?? "", /^Namespace's Macs vary by machine: Apple M4 Pro \(Virtual\), iOS devices, video by a hardware H\.264 encoder on 1 of the 2 machines measured, by software \(OpenH264\) on the other\./);
});

async function measuredAfresh(backend: NamespaceBackend): Promise<void> {
  while (backend.measuringAfreshUntil() !== null) await new Promise((resolve) => setTimeout(resolve, 10));
}

test("a Namespace report from an older probe that cannot make an offer is measured again on a Mac bb-box starts for a few minutes, logged, at most once a day, only while shared iOS hosts are on (065 C follow-up)", async () => {
  let now = Date.parse("2030-01-01T00:00:00Z");
  fakeSsh();
  const storage = new MemoryStorage();
  const { probe: _, ...withoutProbe } = IOS_REPORT;
  const older: MacReport = { ...withoutProbe, capabilities: { ...IOS_REPORT.capabilities, simulator: { is: "yes", what: { xcode: "26.1.1", runtimes: ["iOS 26.2"] } } } };
  await storage.set(reportKey(IOS_REPORT.chip!), older);
  const fake = new FakeNamespace({ now: () => now, lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const context = testContext(storage, "inst1");
  const made = (iosHosts?: NamespaceConfig["iosHosts"]) => disposed(new NamespaceBackend({ ...CONFIG, ...(iosHosts ? { iosHosts } : {}) }, context, { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, cuaScript: ":", now: () => now }));
  const off = made({ on: false, most: null, ahead: 1, resettingMost: 2, diskReserveGiB: 20 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await off.maintain();
  assert.equal(fake.instances.size, 0, "no Mac is started while shared iOS hosts are off");
  const backend = made();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(backend.slots.lends("ios"), false);
  fake.failNext("CreateInstance", "internal", "no Mac now");
  await backend.maintain();
  await measuredAfresh(backend);
  const creates = () => fake.calls.filter((call) => call.method === "CreateInstance").length;
  assert.equal(creates(), 1);
  now += 60 * 60_000;
  await backend.maintain();
  assert.equal(creates(), 1, "not again within the day");
  now += MEASURE_AGAIN_AFTER_MS;
  await backend.maintain();
  await measuredAfresh(backend);
  const measuring = [...fake.instances.values()].find((instance) => instance.labels[LABELS.role] === MEASURE_ROLE);
  assert.ok(measuring, "a Mac is started to measure");
  assert.equal(measuring.deadline, now + MEASURE_LIFE_MS, "Namespace ends it itself should bb-box lose it");
  assert.equal(measuring.status, "DESTROYED", "it is destroyed once measured");
  assert.ok(backend.macCapabilities().some((report) => report.probe === PROBE_VERSION), "a report from the current probe is kept");
  const logged = context.logs.join("\n");
  assert.match(logged, /bb-box is starting a \d+x\d+ Namespace Mac to measure what Namespace's Macs offer iOS devices afresh, as its last report came from an older probe and cannot make an offer\. It is destroyed once measured, and by \d\d:\d\d UTC at the latest\./);
  for (const step of ["made", "running", "answering SSH", "measured: an unknown chip", "destroyed"]) assert.match(logged, new RegExp(`made to measure afresh: ${step}`), step);
  now += MEASURE_AGAIN_AFTER_MS;
  await backend.maintain();
  assert.equal(creates(), 2, "a report from the current probe is not measured afresh");
});

test("a Namespace report from an older probe that can still make an offer is not measured afresh, so no ios box waits for the Mac", async () => {
  fakeSsh();
  const storage = new MemoryStorage();
  const { probe: _, ...withoutProbe } = IOS_REPORT;
  await storage.set(reportKey(IOS_REPORT.chip!), withoutProbe);
  const fake = new FakeNamespace({ lifeCapMs: 4 * 3600_000, maxCores: 64 });
  const backend = disposed(new NamespaceBackend(CONFIG, testContext(storage, "inst1"), { fetch: fake.fetch, sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, cuaScript: ":" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(backend.slots.lends("ios"), true);
  await backend.maintain();
  assert.equal(fake.calls.filter((call) => call.method === "CreateInstance").length, 0);
});
