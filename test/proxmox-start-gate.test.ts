import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Backends } from "../src/backends/index.ts";
import { Proxmox } from "../src/backends/proxmox/api.ts";
import {
  HEAVY_START_SETTLE_DEFAULT_S,
  ProxmoxStartGate,
  START_MEMORY_MARGIN_DEFAULT_MIB,
  START_MEMORY_WAIT_DEFAULT_S,
  isHeavyGuest,
  startGateKey,
  type StartGateConfig,
} from "../src/backends/proxmox/start-gate.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { LXC_FIELDS, LXC_SETTINGS, parseLxcPart } from "../src/backends/proxmox-lxc/config.ts";
import { OwnedGuests, describedOwner } from "../src/backends/proxmox-lxc/owned.ts";
import { ProxmoxQemuBackend } from "../src/backends/proxmox-qemu/backend.ts";
import { QEMU_FIELDS, parseQemuPart, type QemuConfig } from "../src/backends/proxmox-qemu/config.ts";
import { BackendError, type AcquireHooks, type BoxIdentity, type Guest } from "../src/backends/types.ts";
import { SPARES } from "../src/core/boxes.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, KEY, MemoryStorage, fakeSsh, lxcConfig, testContext, windowsWithExpiringPassword } from "./helpers.ts";

const GIB = 2 ** 30;
const DEFAULT_GATE: StartGateConfig = {
  memoryMarginMiB: START_MEMORY_MARGIN_DEFAULT_MIB,
  memoryWaitSeconds: START_MEMORY_WAIT_DEFAULT_S,
  heavySettleSeconds: HEAVY_START_SETTLE_DEFAULT_S,
};

interface ScheduledSleep {
  readonly wakeAt: number;
  readonly resolve: () => void;
  readonly reject: (reason: unknown) => void;
  readonly detach: () => void;
}

class FakeClock {
  #now: number;
  readonly #sleeps: ScheduledSleep[] = [];
  readonly durations: number[] = [];

  constructor(startMs = 1_790_000_000_000) {
    this.#now = startMs;
  }

  now = (): number => this.#now;

  sleep = (ms: number, signal?: AbortSignal): Promise<void> => {
    this.durations.push(ms);
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise((resolve, reject) => {
      let entry!: ScheduledSleep;
      const onAbort = () => {
        this.#remove(entry);
        reject(signal!.reason);
      };
      entry = {
        wakeAt: this.#now + ms,
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.#sleeps.push(entry);
    });
  };

  async advance(ms: number): Promise<void> {
    const target = this.#now + ms;
    for (;;) {
      await flushMicrotasks();
      const due = this.#sleeps
        .filter((entry) => entry.wakeAt <= target)
        .sort((a, b) => a.wakeAt - b.wakeAt);
      if (due.length === 0) break;
      const next = due[0]!;
      this.#now = Math.max(this.#now, next.wakeAt);
      this.#remove(next);
      next.detach();
      next.resolve();
    }
    this.#now = Math.max(this.#now, target);
    await flushMicrotasks();
  }

  #remove(entry: ScheduledSleep): void {
    const index = this.#sleeps.indexOf(entry);
    if (index >= 0) this.#sleeps.splice(index, 1);
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
}

function gateClockSleep(clock: FakeClock): (ms: number, signal?: AbortSignal) => Promise<void> {
  return (ms, signal) => (ms < 1_000 ? Promise.resolve() : clock.sleep(ms, signal));
}

const madeBackends: { dispose(): Promise<void> }[] = [];
after(async () => {
  for (const backend of madeBackends) await backend.dispose();
});

function qemuConfig(values: Record<string, unknown> = {}): QemuConfig {
  const parsed = parseQemuPart({
    id: "proxmox-qemu",
    fields: {
      url: "https://pve.example.com:8006/api2/json",
      "token-id": FAKE_TOKEN.tokenId,
      "token-secret": FAKE_TOKEN.tokenSecret,
      "windows-templates": "9104",
      "linux-templates": "9106",
      bridge: "vmbr1",
      subnet: "192.0.2.0/24",
      gateway: "192.0.2.1",
      addresses: "192.0.2.150-192.0.2.159",
      "vmid-first": 9700,
      "vmid-last": 9709,
      "ssh-private-key": KEY,
      ...values,
    },
    hosts: [],
  });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}

function makeClient(api: FakeProxmox, type: "lxc" | "qemu"): Proxmox {
  return new Proxmox({
    apiUrl: "https://pve.example.com:8006/",
    ...FAKE_TOKEN,
    node: api.node,
    type,
    fetch: api.fetch,
    sleep: async () => {},
  });
}

function makeHooks(waitingLog: (string | null)[] = []): AcquireHooks {
  return {
    claim: async () => {},
    starting: async () => {},
    timing: () => {},
    waiting: async (words) => {
      waitingLog.push(words);
    },
  };
}

let boxCounter = 0;
function makeIdentity(kind: string, threadId = "thr_user1", memoryMiB?: number): BoxIdentity {
  boxCounter++;
  const base = defaultSize(kindSizes(kind));
  return {
    boxId: `box_gate_${boxCounter}`,
    threadId,
    name: `gate-box-${boxCounter}`,
    kind,
    createdAt: 1_790_000_000_000,
    size: { ...base, ...(memoryMiB !== undefined ? { memoryMiB } : {}), gpu: "none" },
  };
}

test("refusal: memory stays short, waits for start-memory-wait-seconds, fails with shortfall and never starts", async () => {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7001, hostname: "short-box", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  const progress: (string | null)[] = [];

  const pending = gate.start(lxc, {
    vmid: 7001,
    memoryMiB: 4096,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 30, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void progress.push(words),
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(7001)!.status, "stopped");
  assert.match(progress[0] ?? "", /Waiting for free memory on pve: needs 20 GiB \(4 GiB plus 16 GiB margin\), 18 GiB available/);

  await clock.advance(20_000);
  assert.equal(api.guests.get(7001)!.status, "stopped");

  const outcome = pending.catch((error: unknown) => error);
  await clock.advance(10_000);
  const error = await outcome;

  assert.ok(error instanceof BackendError);
  assert.equal(error.code, "no_capacity");
  assert.match(error.message, /\bpve\b/);
  assert.match(error.message, /short by 2 GiB/);
  assert.match(error.message, /Stop or release a box/);
  assert.equal(api.guests.get(7001)!.status, "stopped");
  assert.equal(api.calls.some((call) => call.path.endsWith("/status/start")), false);
  assert.equal(progress.at(-1), null);
});

test("queue: memory frees during the wait and the start proceeds", async () => {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 16 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7002, hostname: "queued-box", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  const progress: (string | null)[] = [];

  const pending = gate.start(lxc, {
    vmid: 7002,
    memoryMiB: 4096,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void progress.push(words),
  });

  await clock.advance(20_000);
  assert.equal(api.guests.get(7002)!.status, "stopped");

  api.memory = { total: 64 * GIB, available: 22 * GIB };
  await clock.advance(10_000);
  const waitedMs = await pending;

  assert.equal(waitedMs, 30_000);
  assert.equal(api.guests.get(7002)!.status, "running");
  assert.equal(progress.at(-1), null);
});

test("untouched memory of a recent boot counts against the next start until touched, stopped or expired", async () => {
  const api = new FakeProxmox();
  api.addVmTemplate(9104);
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 26 * GIB };
  const qemu = makeClient(api, "qemu");
  const lxc = makeClient(api, "lxc");
  await qemu.cloneLinked({ template: 9104, vmid: 9701, hostname: "win-1", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7003, hostname: "ct-1", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7004, hostname: "ct-2", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7005, hostname: "ct-3", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  await gate.start(qemu, { vmid: 9701, memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  api.guests.get(9701)!.memoryUsed = 1 * GIB;

  const ct1Progress: (string | null)[] = [];
  const ct1 = gate.start(lxc, {
    vmid: 7003,
    memoryMiB: 4096,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void ct1Progress.push(words),
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(7003)!.status, "stopped");
  assert.match(ct1Progress[0] ?? "", /7 GiB still held by recent starts/);

  api.guests.get(9701)!.memoryUsed = 7 * GIB;
  await clock.advance(10_000);
  await ct1;
  assert.equal(api.guests.get(7003)!.status, "running");

  api.guests.get(7003)!.memoryUsed = 0;
  api.memory = { total: 64 * GIB, available: 22 * GIB };
  const ct2 = gate.start(lxc, { vmid: 7004, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await flushMicrotasks();
  assert.equal(api.guests.get(7004)!.status, "stopped");

  await lxc.stop(7003);
  await clock.advance(10_000);
  await ct2;
  assert.equal(api.guests.get(7004)!.status, "running");

  api.guests.get(7004)!.memoryUsed = 0;
  api.guests.get(9701)!.memoryUsed = 8 * GIB;
  api.memory = { total: 64 * GIB, available: 22 * GIB };
  const ct3 = gate.start(lxc, {
    vmid: 7005,
    memoryMiB: 4096,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 700, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });
  await flushMicrotasks();
  assert.equal(api.guests.get(7005)!.status, "stopped");

  await clock.advance(10 * 60_000);
  await ct3;
  assert.equal(api.guests.get(7005)!.status, "running");
});

test("two heavy starts are serialised with the settle delay; a container is not held behind settle but is held by memory", async () => {
  const api = new FakeProxmox();
  api.addVmTemplate(9104);
  api.addTemplate(9000);
  api.memory = { total: 128 * GIB, available: 80 * GIB };
  const qemu = makeClient(api, "qemu");
  const lxc = makeClient(api, "lxc");
  await qemu.cloneLinked({ template: 9104, vmid: 9710, hostname: "win-a", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9711, hostname: "win-b", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7010, hostname: "ct-fast", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7011, hostname: "ct-mem", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  const starts: { vmid: number; at: number }[] = [];
  api.intercept = (call) => {
    const match = /^\/nodes\/pve\/(?:lxc|qemu)\/(\d+)\/status\/start$/.exec(call.path);
    if (match) starts.push({ vmid: Number(match[1]), at: clock.now() });
    return undefined;
  };

  const t0 = clock.now();
  const winA = gate.start(qemu, { vmid: 9710, kind: "windows-desktop", os: "windows", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  const winBProgress: (string | null)[] = [];
  const winB = gate.start(qemu, {
    vmid: 9711,
    kind: "windows-desktop",
    os: "windows",
    memoryMiB: 8192,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void winBProgress.push(words),
  });

  await winA;
  await flushMicrotasks();
  assert.equal(api.guests.get(9710)!.status, "running");
  assert.equal(api.guests.get(9711)!.status, "stopped");
  assert.match(winBProgress[0] ?? "", /Waiting 120 s for a recent heavy VM start on pve to settle/);

  await clock.advance(10_000);
  await gate.start(lxc, { vmid: 7010, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  assert.equal(api.guests.get(7010)!.status, "running");
  assert.equal(api.guests.get(9711)!.status, "stopped");

  api.memory = { total: 128 * GIB, available: 20 * GIB };
  const ctMem = gate.start(lxc, { vmid: 7011, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await flushMicrotasks();
  assert.equal(api.guests.get(7011)!.status, "stopped");

  api.memory = { total: 128 * GIB, available: 80 * GIB };
  await clock.advance(10_000);
  await ctMem;
  assert.equal(api.guests.get(7011)!.status, "running");
  assert.equal(api.guests.get(9711)!.status, "stopped");

  await clock.advance(99_000);
  assert.equal(api.guests.get(9711)!.status, "stopped");
  await clock.advance(1_000);
  await winB;
  assert.equal(api.guests.get(9711)!.status, "running");

  const startA = starts.find((entry) => entry.vmid === 9710)!.at;
  const startFast = starts.find((entry) => entry.vmid === 7010)!.at;
  const startB = starts.find((entry) => entry.vmid === 9711)!.at;
  assert.equal(startA - t0, 0);
  assert.equal(startFast - t0, 10_000);
  assert.equal(startB - startA, 120_000);
});

test("heavy classification matches Windows, Android, or non-ballooning QEMU VMs over 4 GiB, never containers", () => {
  assert.equal(isHeavyGuest("lxc", { balloon: "0", memory: "16384" }, 16384, "linux", "linux"), false);
  assert.equal(isHeavyGuest("qemu", { memory: "4096" }, 4096, "windows-desktop", "windows"), true);
  assert.equal(isHeavyGuest("qemu", { memory: "4096" }, 4096, "android", "linux"), true);
  assert.equal(isHeavyGuest("qemu", { balloon: "0", memory: "8192" }, 8192, "linux", "linux"), true);
  assert.equal(isHeavyGuest("qemu", { balloon: "0", memory: "4096" }, 4096, "linux", "linux"), false);
  assert.equal(isHeavyGuest("qemu", { balloon: "2048", memory: "8192" }, 8192, "linux", "linux"), false);
  assert.equal(isHeavyGuest("qemu", { memory: "8192" }, 8192, "linux", "linux"), false);
});

test("memory check for a heavy VM runs after the heavy settle wait, just before start", async () => {
  const api = new FakeProxmox();
  api.addVmTemplate(9104);
  api.memory = { total: 128 * GIB, available: 80 * GIB };
  const qemu = makeClient(api, "qemu");
  await qemu.cloneLinked({ template: 9104, vmid: 9720, hostname: "win-1", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9721, hostname: "win-2", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  await gate.start(qemu, { vmid: 9720, kind: "windows-desktop", os: "windows", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });

  const win2 = gate.start(qemu, {
    vmid: 9721,
    kind: "windows-desktop",
    os: "windows",
    memoryMiB: 8192,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 20, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });

  await clock.advance(60_000);
  api.memory = { total: 128 * GIB, available: 10 * GIB };
  await clock.advance(60_000);
  assert.equal(api.guests.get(9721)!.status, "stopped");

  const outcome = win2.catch((error: unknown) => error);
  await clock.advance(20_000);
  const error = await outcome;

  assert.ok(error instanceof BackendError && error.code === "no_capacity");
  assert.equal(api.guests.get(9721)!.status, "stopped");
});

test("a warm refill goes through the gate, gives up quietly when short, and an acquire waiting with a refill goes first", async () => {
  const ssh = fakeSsh();
  for (let last = 100; last <= 119; last++) ssh.home(`192.0.2.${last}`);
  const api = new FakeProxmox();
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };

  const clock = new FakeClock();
  const shared = new Map<string, unknown>();
  const storage = new MemoryStorage();
  const context = testContext(storage, "test", { id: "proxmox-lxc", warm: { linux: 1 }, shared });
  const config = lxcConfig({
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-vmid-first": 7000,
    "proxmox-lxc-vmid-last": 7009,
    "proxmox-lxc-start-memory-margin-mib": 16384,
    "proxmox-lxc-start-memory-wait-seconds": 20,
  });
  const backend = new ProxmoxLxcBackend(config, context, {
    fetch: api.fetch,
    sleep: gateClockSleep(clock),
    now: clock.now,
    sshBinary: FAKE_SSH_BINARY,
    portCheck: async () => true,
    readyTimeoutMs: 10_000,
  });
  madeBackends.push(backend);

  const refill = backend.maintain();
  await flushMicrotasks();
  assert.equal(api.guests.get(7000)?.status, "stopped");

  await clock.advance(20_000);
  await refill;
  assert.equal(api.guests.has(7000), false);
  assert.equal(context.errors.length, 0);
  assert.match(context.short.at(-1)?.[0]?.reason ?? "", /short by 2 GiB/);

  const order: number[] = [];
  api.intercept = (call) => {
    const match = /^\/nodes\/pve\/lxc\/(\d+)\/status\/start$/.exec(call.path);
    if (match) order.push(Number(match[1]));
    return undefined;
  };

  const secondRefill = backend.maintain();
  await flushMicrotasks();
  const acquire = backend.acquire(makeIdentity("linux"), null, makeHooks(), new AbortController().signal);
  await flushMicrotasks();

  api.memory = { total: 64 * GIB, available: 22 * GIB };
  await clock.advance(10_000);
  const acquired = await acquire;
  const acquiredVmid = Number(acquired.ref);

  api.memory = { total: 64 * GIB, available: 26 * GIB };
  await clock.advance(10_000);
  await secondRefill;

  assert.equal(order[0], acquiredVmid);
  assert.equal(order.length, 2);
});

test("LXC and QEMU backends built by Backends on the same node share one start gate", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }
  const api = new FakeProxmox();
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 26 * GIB };

  const clock = new FakeClock();
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const lxcCtx = backends.context("proxmox-lxc");
  const qemuCtx = backends.context("proxmox-qemu");

  const lxc = new ProxmoxLxcBackend(
    lxcConfig({
      "proxmox-lxc-url": "https://pve.example.com:8006/",
      "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
      "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
      "proxmox-lxc-vmid-first": 7000,
      "proxmox-lxc-vmid-last": 7009,
      "proxmox-lxc-start-memory-margin-mib": 16384,
      "proxmox-lxc-start-memory-wait-seconds": 20,
    }),
    lxcCtx,
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  const qemu = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 20, "heavy-start-settle-seconds": 120 }),
    qemuCtx,
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(lxc, qemu);

  assert.equal(
    startGateKey("https://pve.example.com:8006/", "pve"),
    startGateKey("https://PVE.EXAMPLE.COM:8006/api2/json", "pve"),
  );

  const vm = await qemu.acquire(makeIdentity("windows-desktop"), null, makeHooks(), new AbortController().signal);
  api.guests.get(Number(vm.ref))!.memoryUsed = 0;

  const ctWaiting: (string | null)[] = [];
  const ctAcquire = lxc.acquire(makeIdentity("linux"), null, makeHooks(ctWaiting), new AbortController().signal);
  await flushMicrotasks();
  assert.match(ctWaiting[0] ?? "", /8 GiB still held by recent starts/);

  api.guests.get(Number(vm.ref))!.memoryUsed = 8 * GIB;
  await clock.advance(10_000);
  const ct = await ctAcquire;
  assert.equal(api.guests.get(Number(ct.ref))!.status, "running");
});

test("a spare acquire yields to a thread acquire waiting on the same node", async () => {
  const ssh = fakeSsh();
  for (let last = 100; last <= 119; last++) ssh.home(`192.0.2.${last}`);
  const api = new FakeProxmox();
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };

  const clock = new FakeClock();
  const shared = new Map<string, unknown>();
  const backend = new ProxmoxLxcBackend(
    lxcConfig({
      "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
      "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
      "proxmox-lxc-vmid-first": 7000,
      "proxmox-lxc-vmid-last": 7009,
    }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-lxc", shared }),
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(backend);

  const starts: number[] = [];
  api.intercept = (call) => {
    const match = /^\/nodes\/pve\/lxc\/(\d+)\/status\/start$/.exec(call.path);
    if (match) starts.push(Number(match[1]));
    return undefined;
  };

  const spare = backend.acquire(makeIdentity("linux", SPARES), null, makeHooks(), new AbortController().signal);
  await flushMicrotasks();
  const thread = backend.acquire(makeIdentity("linux", "thr_real"), null, makeHooks(), new AbortController().signal);
  await flushMicrotasks();

  api.memory = { total: 64 * GIB, available: 22 * GIB };
  await clock.advance(10_000);
  const threadGuest = await thread;
  assert.equal(starts[0], Number(threadGuest.ref));

  api.memory = { total: 64 * GIB, available: 26 * GIB };
  await clock.advance(10_000);
  const spareGuest = await spare;
  assert.equal(starts[1], Number(spareGuest.ref));
});

test("abort ends a memory wait or heavy settle wait at once", async () => {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 10 * GIB };
  const lxc = makeClient(api, "lxc");
  const qemu = makeClient(api, "qemu");
  await lxc.cloneLinked({ template: 9000, vmid: 7020, hostname: "abort-ct", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9730, hostname: "heavy-1", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9731, hostname: "heavy-2", pool: "bbbox" });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  const controller = new AbortController();
  const progress: (string | null)[] = [];

  const memWait = gate.start(lxc, {
    vmid: 7020,
    memoryMiB: 4096,
    priority: "acquire",
    config: DEFAULT_GATE,
    signal: controller.signal,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void progress.push(words),
  });

  await flushMicrotasks();
  const reason = new Error("caller cancelled");
  controller.abort(reason);
  await assert.rejects(memWait, (error) => error === reason);
  assert.equal(api.guests.get(7020)!.status, "stopped");
  assert.equal(progress.at(-1), null);

  api.memory = { total: 128 * GIB, available: 80 * GIB };
  await gate.start(qemu, { vmid: 9730, kind: "windows-desktop", os: "windows", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });

  const heavyController = new AbortController();
  const heavyWait = gate.start(qemu, {
    vmid: 9731,
    kind: "windows-desktop",
    os: "windows",
    memoryMiB: 8192,
    priority: "acquire",
    config: DEFAULT_GATE,
    signal: heavyController.signal,
    now: clock.now,
    sleep: clock.sleep,
  });

  await flushMicrotasks();
  heavyController.abort(reason);
  await assert.rejects(heavyWait, (error) => error === reason);
  assert.equal(api.guests.get(9731)!.status, "stopped");
});

test("doctor memory check mentions the start memory margin, and settings declare the three advanced fields", async () => {
  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.addVmTemplate(9104);

  assert.equal("proxmox-lxc-start-memory-margin-mib" in LXC_SETTINGS, false);
  assert.equal(LXC_FIELDS["start-memory-margin-mib"]?.group, "advanced");
  assert.equal(LXC_FIELDS["start-memory-margin-mib"]?.default, 16384);
  assert.equal(LXC_FIELDS["start-memory-wait-seconds"]?.group, "advanced");
  assert.equal(LXC_FIELDS["start-memory-wait-seconds"]?.default, 600);
  assert.equal(QEMU_FIELDS["start-memory-margin-mib"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["start-memory-margin-mib"]?.default, 16384);
  assert.equal(QEMU_FIELDS["start-memory-wait-seconds"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["start-memory-wait-seconds"]?.default, 600);
  assert.equal(QEMU_FIELDS["heavy-start-settle-seconds"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["heavy-start-settle-seconds"]?.default, 120);

  const badLxc = parseLxcPart({
    id: "proxmox-lxc",
    fields: {
      url: "https://pve.example.com:8006",
      "token-id": FAKE_TOKEN.tokenId,
      "token-secret": FAKE_TOKEN.tokenSecret,
      "linux-templates": "9000",
      "start-memory-margin-mib": -1,
      "start-memory-wait-seconds": -5,
    },
    hosts: [],
  });
  assert.equal(badLxc.ok, false);
  assert.deepEqual(badLxc.problems.map((problem) => problem.path).sort(), ["start-memory-margin-mib", "start-memory-wait-seconds"]);

  const badQemu = parseQemuPart({
    id: "proxmox-qemu",
    fields: {
      url: "https://pve.example.com:8006",
      "token-id": FAKE_TOKEN.tokenId,
      "token-secret": FAKE_TOKEN.tokenSecret,
      "windows-templates": "9104",
      "start-memory-margin-mib": -1,
      "start-memory-wait-seconds": -5,
      "heavy-start-settle-seconds": -2,
    },
    hosts: [],
  });
  assert.equal(badQemu.ok, false);
  assert.deepEqual(
    badQemu.problems.map((problem) => problem.path).sort(),
    ["heavy-start-settle-seconds", "start-memory-margin-mib", "start-memory-wait-seconds"],
  );

  const lxc = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-lxc" }),
    { fetch: api.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  const qemu = new ProxmoxQemuBackend(
    qemuConfig(),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  madeBackends.push(lxc, qemu);

  const lxcMemory = (await lxc.doctor()).checks.find((check) => check.id === "proxmox.memory");
  const qemuMemory = (await qemu.doctor()).checks.find((check) => check.id === "proxmox.memory");
  assert.match(lxcMemory?.detail ?? "", /16 GiB margin/);
  assert.match(qemuMemory?.detail ?? "", /16 GiB margin/);
});

test("resume, image trial box, and resize restart all pass through the start gate", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }
  const api = new FakeProxmox();
  api.taskPolls = 0;
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 48 * GIB };

  const clock = new FakeClock();
  const backend = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 0, "heavy-start-settle-seconds": 0 }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(backend);

  const guest: Guest = await backend.acquire(makeIdentity("windows-desktop"), null, makeHooks(), new AbortController().signal);
  await backend.stop(guest, new AbortController().signal);

  api.memory = { total: 64 * GIB, available: 10 * GIB };
  await assert.rejects(
    backend.start(guest, new AbortController().signal),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity" && /short by 14 GiB/.test(error.message),
  );
  assert.equal(api.guests.get(Number(guest.ref))!.status, "stopped");

  const builds = (await backend.images.list()).builds;
  await assert.rejects(
    backend.images.box(builds[0]!, "trial", new AbortController().signal),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity",
  );

  api.memory = { total: 64 * GIB, available: 48 * GIB };
  await backend.start(guest, new AbortController().signal);
  api.memory = { total: 64 * GIB, available: 20 * GIB };
  await assert.rejects(
    backend.resize(guest, "windows-desktop", { cores: 6, memoryMiB: 8192, diskGiB: guest.size?.diskGiB ?? null }, { restart: true }, new AbortController().signal),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity",
  );
  assert.equal(api.guests.get(Number(guest.ref))!.status, "stopped");
});

test("GPU-helper starts also wait on the start gate before asking the helper to start", async () => {
  const api = new FakeProxmox();
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7030, hostname: "gpu-box", pool: "bbbox" });
  const description = "bb-box install:test gpu-gate-test";
  await lxc.configure(7030, { description, memory: 4096 });

  const helperCalls: string[] = [];
  const owned = new OwnedGuests(lxc, () => {}, {
    helperFor: async () => "gpu-helper",
    ask: async (vmid, action) => {
      helperCalls.push(`${action}:${vmid}`);
      if (action === "start") api.guests.get(vmid)!.status = "running";
    },
    acted: async () => {},
  });

  const clock = new FakeClock();
  const gate = new ProxmoxStartGate();
  const pending = owned.start(
    7030,
    describedOwner("test", description),
    gate,
    { memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep },
  );

  await flushMicrotasks();
  assert.deepEqual(helperCalls, []);
  assert.equal(api.guests.get(7030)!.status, "stopped");

  api.memory = { total: 64 * GIB, available: 24 * GIB };
  await clock.advance(10_000);
  await pending;
  assert.deepEqual(helperCalls, ["start:7030"]);
  assert.equal(api.guests.get(7030)!.status, "running");
});
