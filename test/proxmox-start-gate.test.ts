import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { Backends } from "../src/backends/index.ts";
import { Proxmox } from "../src/backends/proxmox/api.ts";
import {
  HEAVY_START_SETTLE_DEFAULT_S,
  ProxmoxStartGate,
  START_GATE_POLL_MS,
  START_MEMORY_MARGIN_DEFAULT_MIB,
  START_MEMORY_WAIT_DEFAULT_S,
  effectiveStartMemoryMarginMiB,
  isHeavyGuest,
  startGateKey,
  type StartGateConfig,
} from "../src/backends/proxmox/start-gate.ts";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { LXC_FIELDS, LXC_SETTINGS, parseLxcPart } from "../src/backends/proxmox-lxc/config.ts";
import { OwnedGuests, describedOwner } from "../src/backends/proxmox-lxc/owned.ts";
import { ProxmoxQemuBackend } from "../src/backends/proxmox-qemu/backend.ts";
import { QEMU_FIELDS, parseQemuPart, type QemuConfig } from "../src/backends/proxmox-qemu/config.ts";
import { BackendError, SnapshotFailed, type AcquireHooks, type BoxIdentity, type Guest, type SnapshotHooks } from "../src/backends/types.ts";
import { SPARES, type BoxRecord } from "../src/core/boxes.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { ready } from "../src/plugin/tools.ts";
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
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7001, hostname: "short-box", pool: "bbbox" });

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
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 16 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7002, hostname: "queued-box", pool: "bbbox" });

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

test("A: recent heavy VMs and settle are read from the node across installs, manual starts, stops and destroys", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addVmTemplate(9104);
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 26 * GIB };

  api.guests.set(5500, {
    vmid: 5500,
    type: "qemu",
    name: "manual-win",
    status: "running",
    template: false,
    config: { ostype: "win11", balloon: "0", memory: "8192" },
    startedAt: clock.now() - 30_000,
    memoryUsed: 1 * GIB,
  });

  const qemu = makeClient(api, "qemu");
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7003, hostname: "ct-1", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9701, hostname: "win-1", pool: "bbbox" });

  const freshGate = new ProxmoxStartGate();
  const ctProgress: (string | null)[] = [];
  const ct = freshGate.start(lxc, {
    vmid: 7003,
    memoryMiB: 4096,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void ctProgress.push(words),
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(7003)!.status, "stopped");
  assert.match(ctProgress[0] ?? "", /7 GiB still held by recent starts/);

  api.guests.get(5500)!.memoryUsed = 7 * GIB;
  await clock.advance(10_000);
  await ct;
  assert.equal(api.guests.get(7003)!.status, "running");

  api.memory = { total: 64 * GIB, available: 48 * GIB };
  const winProgress: (string | null)[] = [];
  const win = freshGate.start(qemu, {
    vmid: 9701,
    kind: "windows-desktop",
    os: "windows",
    memoryMiB: 8192,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
    waiting: async (words) => void winProgress.push(words),
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(9701)!.status, "stopped");
  assert.match(winProgress[0] ?? "", /Waiting 80 s for a recent heavy VM start on pve to settle/);

  api.guests.delete(5500);
  await clock.advance(10_000);
  await win;
  assert.equal(api.guests.get(9701)!.status, "running");
});

test("B: containers and ballooned VMs never count as held untouched memory or heavy settle", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.addVmTemplate(9106, { ostype: "l26", memory: "8192" });
  api.memory = { total: 128 * GIB, available: 32 * GIB };

  const lxc = makeClient(api, "lxc");
  const qemu = makeClient(api, "qemu");
  await lxc.cloneLinked({ template: 9000, vmid: 7004, hostname: "ct-big-1", pool: "bbbox" });
  await lxc.configure(7004, { memory: 16384 });
  await lxc.cloneLinked({ template: 9000, vmid: 7005, hostname: "ct-big-2", pool: "bbbox" });
  await lxc.configure(7005, { memory: 16384 });
  await qemu.cloneLinked({ template: 9106, vmid: 9702, hostname: "linux-balloon", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7006, hostname: "ct-after", pool: "bbbox" });

  const gate = new ProxmoxStartGate();
  await gate.start(lxc, { vmid: 7004, memoryMiB: 16384, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await gate.start(lxc, { vmid: 7005, memoryMiB: 16384, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await gate.start(qemu, { vmid: 9702, kind: "linux", os: "linux", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });

  api.guests.get(7004)!.memoryUsed = 0;
  api.guests.get(7005)!.memoryUsed = 0;
  api.guests.get(9702)!.memoryUsed = 0;

  const waitedMs = await gate.start(lxc, {
    vmid: 7006,
    memoryMiB: 4096,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 0, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });

  assert.equal(waitedMs, 0);
  assert.equal(api.guests.get(7006)!.status, "running");
});

test("C: wall-clock wait expires without busy loop, sleeps at least a poll interval, and wakes at once on arrival during a read", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 128 * GIB, available: 24 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7010, hostname: "big-1", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7011, hostname: "big-2", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7012, hostname: "small-fit", pool: "bbbox" });

  const gate = new ProxmoxStartGate();
  const big1 = gate.start(lxc, {
    vmid: 7010,
    memoryMiB: 32768,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 60, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  }).catch((error: unknown) => error);

  await clock.advance(30_000);
  const big2 = gate.start(lxc, {
    vmid: 7011,
    memoryMiB: 32768,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 60, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  }).catch((error: unknown) => error);

  await clock.advance(30_000);
  const err1 = await big1;
  assert.ok(err1 instanceof BackendError && err1.code === "no_capacity");

  await clock.advance(30_000);
  const err2 = await big2;
  assert.ok(err2 instanceof BackendError && err2.code === "no_capacity");
  assert.ok(clock.durations.length > 0);
  assert.equal(clock.durations.every((ms) => ms >= START_GATE_POLL_MS), true);

  let releaseStatusRead!: () => void;
  let statusReadBlocked = false;
  const baseFetch = api.fetch;
  const blockedClient = new Proxmox({
    apiUrl: "https://pve.example.com:8006/",
    ...FAKE_TOKEN,
    node: api.node,
    type: "lxc",
    fetch: async (url, init) => {
      if (!statusReadBlocked && url.includes("/nodes/pve/status")) {
        statusReadBlocked = true;
        await new Promise<void>((resolve) => (releaseStatusRead = resolve));
      }
      return baseFetch(url, init);
    },
    sleep: async () => {},
  });

  const sleepCountBefore = clock.durations.length;
  const waitingBig = gate.start(blockedClient, {
    vmid: 7010,
    memoryMiB: 32768,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 60, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });

  await flushMicrotasks();
  assert.equal(statusReadBlocked, true);

  const urgentSmall = gate.start(lxc, {
    vmid: 7012,
    memoryMiB: 4096,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 60, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });

  releaseStatusRead();
  const smallWaited = await urgentSmall;
  assert.equal(smallWaited, 0);
  assert.equal(api.guests.get(7012)!.status, "running");
  assert.equal(clock.durations.length, sleepCountBefore + 1);

  const errWait = waitingBig.catch((error: unknown) => error);
  await clock.advance(60_000);
  assert.ok((await errWait) instanceof BackendError);
});

test("D: no head-of-line blocking, while priority puts acquires ahead of refills when both fit", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 128 * GIB, available: 24 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7020, hostname: "huge-vm", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7021, hostname: "small-ct", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7022, hostname: "refill-ct", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7023, hostname: "acquire-ct", pool: "bbbox" });

  const gate = new ProxmoxStartGate();
  const huge = gate.start(lxc, {
    vmid: 7020,
    memoryMiB: 32768,
    priority: "acquire",
    config: { memoryMarginMiB: 16384, memoryWaitSeconds: 30, heavySettleSeconds: 120 },
    now: clock.now,
    sleep: clock.sleep,
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(7020)!.status, "stopped");

  const smallWaited = await gate.start(lxc, {
    vmid: 7021,
    memoryMiB: 4096,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(smallWaited, 0);
  assert.equal(api.guests.get(7021)!.status, "running");
  assert.equal(api.guests.get(7020)!.status, "stopped");

  const hugeOutcome = huge.catch((error: unknown) => error);
  await clock.advance(30_000);
  assert.ok((await hugeOutcome) instanceof BackendError);

  api.memory = { total: 128 * GIB, available: 18 * GIB };
  const starts: number[] = [];
  api.intercept = (call) => {
    const match = /^\/nodes\/pve\/lxc\/(\d+)\/status\/start$/.exec(call.path);
    if (match) starts.push(Number(match[1]));
    return undefined;
  };

  const refill = gate.start(lxc, { vmid: 7022, memoryMiB: 4096, priority: "refill", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await flushMicrotasks();
  const acquire = gate.start(lxc, { vmid: 7023, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await flushMicrotasks();

  api.memory = { total: 128 * GIB, available: 24 * GIB };
  await clock.advance(10_000);
  await Promise.all([refill, acquire]);
  assert.deepEqual(starts, [7023, 7022]);
});

test("E: a slow Proxmox start task does not hold the queue for other containers, while heavy boots still serialise", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 128 * GIB, available: 80 * GIB };
  const lxc = makeClient(api, "lxc");
  const qemu = makeClient(api, "qemu");
  await lxc.cloneLinked({ template: 9000, vmid: 7030, hostname: "slow-ct", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7031, hostname: "fast-ct", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9730, hostname: "slow-win", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9731, hostname: "second-win", pool: "bbbox" });

  const gate = new ProxmoxStartGate();
  let releaseSlowCt!: () => void;
  const slowCt = gate.start(
    lxc,
    { vmid: 7030, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep },
    async (permit) => {
      await new Promise<void>((resolve) => (releaseSlowCt = resolve));
      await lxc.start(7030, permit);
    },
  );

  await flushMicrotasks();
  const fastCtWaited = await gate.start(lxc, { vmid: 7031, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  assert.equal(fastCtWaited, 0);
  assert.equal(api.guests.get(7031)!.status, "running");
  assert.equal(api.guests.get(7030)!.status, "stopped");

  releaseSlowCt();
  await slowCt;
  assert.equal(api.guests.get(7030)!.status, "running");

  let releaseSlowWin!: () => void;
  const slowWin = gate.start(
    qemu,
    { vmid: 9730, kind: "windows-desktop", os: "windows", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep },
    async (permit) => {
      await new Promise<void>((resolve) => (releaseSlowWin = resolve));
      await qemu.start(9730, permit);
    },
  );

  await flushMicrotasks();
  const secondWin = gate.start(qemu, {
    vmid: 9731,
    kind: "windows-desktop",
    os: "windows",
    memoryMiB: 8192,
    priority: "acquire",
    config: DEFAULT_GATE,
    now: clock.now,
    sleep: clock.sleep,
  });

  await flushMicrotasks();
  assert.equal(api.guests.get(9731)!.status, "stopped");

  releaseSlowWin();
  await slowWin;
  await clock.advance(120_000);
  await secondWin;
  assert.equal(api.guests.get(9731)!.status, "running");
});

test("two heavy starts are serialised with the settle delay; a container skips settle but is held by memory", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addVmTemplate(9104);
  api.addTemplate(9000);
  api.memory = { total: 128 * GIB, available: 80 * GIB };
  const qemu = makeClient(api, "qemu");
  const lxc = makeClient(api, "lxc");
  await qemu.cloneLinked({ template: 9104, vmid: 9710, hostname: "win-a", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9711, hostname: "win-b", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7040, hostname: "ct-fast", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7041, hostname: "ct-mem", pool: "bbbox" });

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
  await gate.start(lxc, { vmid: 7040, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  assert.equal(api.guests.get(7040)!.status, "running");
  assert.equal(api.guests.get(9711)!.status, "stopped");

  api.memory = { total: 128 * GIB, available: 20 * GIB };
  const ctMem = gate.start(lxc, { vmid: 7041, memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await flushMicrotasks();
  assert.equal(api.guests.get(7041)!.status, "stopped");

  api.memory = { total: 128 * GIB, available: 80 * GIB };
  await clock.advance(10_000);
  await ctMem;
  assert.equal(api.guests.get(7041)!.status, "running");
  assert.equal(api.guests.get(9711)!.status, "stopped");

  await clock.advance(90_000);
  assert.equal(api.guests.get(9711)!.status, "stopped");
  await clock.advance(10_000);
  await winB;
  assert.equal(api.guests.get(9711)!.status, "running");

  const startA = starts.find((entry) => entry.vmid === 9710)!.at;
  const startFast = starts.find((entry) => entry.vmid === 7040)!.at;
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

test("F: effective margin caps at a quarter of node RAM, placement agrees, and doctor fails when smallest size cannot fit", async () => {
  assert.equal(effectiveStartMemoryMarginMiB(16_384, 16 * GIB), 4_096);
  assert.equal(effectiveStartMemoryMarginMiB(16_384, 32 * GIB), 8_192);
  assert.equal(effectiveStartMemoryMarginMiB(16_384, 64 * GIB), 16_384);
  assert.equal(effectiveStartMemoryMarginMiB(16_384, 256 * GIB), 16_384);

  const api = new FakeProxmox();
  api.addTemplate(9000);
  api.addVmTemplate(9104);

  const lxc = new ProxmoxLxcBackend(
    lxcConfig({ "proxmox-lxc-token-id": FAKE_TOKEN.tokenId, "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-lxc" }),
    { fetch: api.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  const qemu = new ProxmoxQemuBackend(
    qemuConfig({ "linux-templates": "" }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: async () => {}, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 0 },
  );
  madeBackends.push(lxc, qemu);

  api.memory = { total: 64 * GIB, available: 18 * GIB };
  const lxcShort = await lxc.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null }, [], new AbortController().signal);
  assert.equal(lxcShort.ok, false);
  assert.match(lxcShort.message ?? "", /start memory margin/);

  api.memory = { total: 16 * GIB, available: 12 * GIB };
  const smallHostFits = await lxc.capacity("linux", { cores: 2, memoryMiB: 4096, diskGiB: null }, [], new AbortController().signal);
  assert.equal(smallHostFits.ok, true);
  const impossible = await lxc.capacity("linux", { cores: 2, memoryMiB: 16 * 1024, diskGiB: null }, [], new AbortController().signal);
  assert.equal(impossible.ok, false);
  assert.match(impossible.message ?? "", /cannot fit/);
  assert.match(impossible.message ?? "", /start memory margin/);

  api.memory = { total: 8 * GIB, available: 7 * GIB };
  const qemuDoctorSmall = (await qemu.doctor()).checks.find((check) => check.id === "proxmox.memory");
  assert.equal(qemuDoctorSmall?.status, "fail");
  assert.match(qemuDoctorSmall?.detail ?? "", /2 GiB effective start memory margin/);
  assert.match(qemuDoctorSmall?.detail ?? "", /cannot fit the smallest/);

  api.memory = { total: 4 * GIB, available: 3 * GIB };
  const lxcDoctorSmall = (await lxc.doctor()).checks.find((check) => check.id === "proxmox.memory");
  assert.equal(lxcDoctorSmall?.status, "fail");
  assert.match(lxcDoctorSmall?.detail ?? "", /1 GiB effective start memory margin/);
  assert.match(lxcDoctorSmall?.detail ?? "", /cannot fit the smallest/);

  api.memory = { total: 64 * GIB, available: 48 * GIB };
  const lxcMemory = (await lxc.doctor()).checks.find((check) => check.id === "proxmox.memory");
  const qemuMemory = (await qemu.doctor()).checks.find((check) => check.id === "proxmox.memory");
  assert.equal(lxcMemory?.status, "ok");
  assert.equal(qemuMemory?.status, "ok");
  assert.match(lxcMemory?.detail ?? "", /16 GiB effective start memory margin/);
  assert.match(qemuMemory?.detail ?? "", /16 GiB effective start memory margin/);

  assert.equal("proxmox-lxc-start-memory-margin-mib" in LXC_SETTINGS, false);
  assert.equal(LXC_FIELDS["start-memory-margin-mib"]?.group, "advanced");
  assert.equal(LXC_FIELDS["start-memory-wait-seconds"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["start-memory-margin-mib"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["start-memory-wait-seconds"]?.group, "advanced");
  assert.equal(QEMU_FIELDS["heavy-start-settle-seconds"]?.group, "advanced");

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
});

test("G: warm and spare refills ask the gate before cloning, clone nothing when blocked, and use wait 0", async () => {
  const ssh = fakeSsh();
  for (let last = 100; last <= 119; last++) ssh.home(`192.0.2.${last}`);
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }

  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 48 * GIB };

  api.guests.set(5600, {
    vmid: 5600,
    type: "qemu",
    name: "recent-win",
    status: "running",
    template: false,
    config: { ostype: "win11", balloon: "0", memory: "8192" },
    startedAt: clock.now() - 10_000,
    memoryUsed: 0,
  });

  const shared = new Map<string, unknown>();
  const qemuCtx = testContext(new MemoryStorage(), "test", { id: "proxmox-qemu", warm: { "windows-desktop": 1 }, shared });
  const qemu = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 600, "heavy-start-settle-seconds": 120 }),
    qemuCtx,
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  const lxcCtx = testContext(new MemoryStorage(), "test", { id: "proxmox-lxc", warm: { linux: 1 }, shared });
  const lxc = new ProxmoxLxcBackend(
    lxcConfig({
      "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
      "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
      "proxmox-lxc-vmid-first": 7000,
      "proxmox-lxc-vmid-last": 7009,
      "proxmox-lxc-start-memory-margin-mib": 16384,
      "proxmox-lxc-start-memory-wait-seconds": 600,
    }),
    lxcCtx,
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(qemu, lxc);

  await qemu.maintain();
  assert.equal(api.calls.filter((call) => call.path.endsWith("/clone")).length, 0);
  assert.match(qemuCtx.short.at(-1)?.[0]?.reason ?? "", /settle/);

  api.memory = { total: 64 * GIB, available: 24 * GIB };
  await lxc.maintain();
  assert.equal(api.calls.filter((call) => call.path.endsWith("/clone")).length, 0);
  assert.match(lxcCtx.short.at(-1)?.[0]?.reason ?? "", /short by/);

  await assert.rejects(
    lxc.acquire(makeIdentity("linux", SPARES), null, makeHooks(), new AbortController().signal),
    (error: unknown) => error instanceof BackendError && error.code === "no_capacity",
  );
  assert.equal(api.calls.filter((call) => call.path.endsWith("/clone")).length, 0);
  assert.equal(clock.durations.length, 0);
});

test("H: QEMU resize rollback passes signal on abort and uses wait 0 instead of waiting another 600 s", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }

  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 48 * GIB };

  const backend = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 30, "heavy-start-settle-seconds": 0 }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(backend);

  const guest: Guest = await backend.acquire(makeIdentity("windows-desktop"), null, makeHooks(), new AbortController().signal);
  const vmid = Number(guest.ref);

  api.memory = { total: 64 * GIB, available: 10 * GIB };
  const abortController = new AbortController();
  const startsBefore = api.calls.filter((call) => call.path.endsWith("/status/start")).length;
  const abortedResize = backend.resize(
    guest,
    "windows-desktop",
    { cores: 6, memoryMiB: 12288, diskGiB: guest.size?.diskGiB ?? null },
    { restart: true },
    abortController.signal,
  );

  for (let i = 0; i < 50 && api.guests.get(vmid)!.status !== "stopped"; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(api.guests.get(vmid)!.status, "stopped");
  await flushMicrotasks();
  const abortError = new Error("released");
  abortController.abort(abortError);
  await assert.rejects(abortedResize, (error: unknown) => error === abortError);
  assert.equal(api.calls.filter((call) => call.path.endsWith("/status/start")).length, startsBefore);
  assert.equal(api.guests.get(vmid)!.status, "stopped");

  api.memory = { total: 64 * GIB, available: 48 * GIB };
  await backend.start(guest, new AbortController().signal);

  api.memory = { total: 64 * GIB, available: 10 * GIB };
  const beforeResizeClock = clock.now();
  const failedResize = backend.resize(
    guest,
    "windows-desktop",
    { cores: 6, memoryMiB: 12288, diskGiB: guest.size?.diskGiB ?? null },
    { restart: true },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  for (let i = 0; i < 50 && api.guests.get(vmid)!.status !== "stopped"; i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(api.guests.get(vmid)!.status, "stopped");
  await clock.advance(30_000);
  const err = await failedResize;
  assert.ok(err instanceof BackendError && err.code === "no_capacity");
  assert.equal(clock.now() - beforeResizeClock, 30_000);
  assert.equal(api.guests.get(vmid)!.status, "stopped");
});

test("I: box_acquire ready() pauses its boot timeout while waitingOn is set", async () => {
  let current: BoxRecord = {
    id: "bx_ready_wait",
    threadId: "thr_1",
    projectId: null,
    name: "calm-otter",
    kind: "linux",
    kindLabel: "Linux",
    backend: "proxmox-lxc",
    backendLabel: "Proxmox LXC on pve",
    nature: "virtual",
    role: "box",
    requires: [],
    state: "acquiring",
    waitingOn: "Waiting for free memory on pve.",
    createdAt: 0,
    readyAt: null,
    releaseRequestedAt: null,
    resetAt: null,
    error: null,
    guest: null,
    capabilities: { os: "linux", arch: "x86_64", gpu: false, displays: [], command: null, computerUse: null, features: [], enrol: false, device: null },
    timings: {},
    enrol: { state: "off", hostId: null, error: null },
  };
  let settle!: (value: BoxRecord) => void;
  const settledPromise = new Promise<BoxRecord>((resolve) => (settle = resolve));

  const stubApp = {
    boxes: {
      kinds: () => [{ id: "linux", readyTimeoutMs: 40 }],
      find: async () => current,
      settled: () => settledPromise,
    },
  } as never;

  const waitingRun = ready(stubApp, current, new AbortController().signal, { pollMs: 10, maxWaitMs: 500 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  current = { ...current, state: "ready", waitingOn: null };
  settle(current);
  const resolved = await waitingRun;
  assert.equal(resolved?.state, "ready");

  const plainBox: BoxRecord = { ...current, state: "acquiring", waitingOn: null };
  const neverSettles = new Promise<BoxRecord>(() => {});
  const plainApp = {
    boxes: {
      kinds: () => [{ id: "linux", readyTimeoutMs: 30 }],
      find: async () => plainBox,
      settled: () => neverSettles,
    },
  } as never;
  const timedOut = await ready(plainApp, plainBox, new AbortController().signal, { pollMs: 10, maxWaitMs: 500 });
  assert.equal(timedOut, null);
});

test("J: rolling back a QEMU snapshot with memory passes through the gate and reports waiting progress", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) ssh.home(`192.0.2.${last}`);
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addVmTemplate(9104);
  api.addVmTemplate(9106, { ostype: "l26", memory: "4096" });
  api.memory = { total: 64 * GIB, available: 48 * GIB };

  const backend = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 20, "heavy-start-settle-seconds": 0 }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(backend);

  const guest = await backend.acquire(makeIdentity("linux"), null, makeHooks(), new AbortController().signal);
  const vmid = Number(guest.ref);
  const boxId = String(guest.data!.box);
  const snapId = "sn7kq2m6xa4pdq";
  const snapHooks: SnapshotHooks = { submitting: async () => {}, task: async () => {} };
  await backend.snapshot(guest, { id: snapId, box: boxId, memory: true }, snapHooks, new AbortController().signal);
  await backend.powerOff(guest, new AbortController().signal);

  const qemu = makeClient(api, "qemu");
  assert.throws(
    () => qemu.startRollbackWithMemory(vmid, `bb${snapId}`, {} as never),
    /must go through the node start gate/,
  );
  await assert.rejects(qemu.startRollback(vmid, `bb${snapId}`), /must go through the node start gate/);

  api.memory = { total: 64 * GIB, available: 10 * GIB };
  const waitingWords: (string | null)[] = [];
  const blockedRollback = backend.rollbackSnapshot(
    guest,
    { id: snapId, ref: `bb${snapId}`, guest },
    { submitting: async () => {}, task: async () => {}, waiting: async (words) => void waitingWords.push(words) },
    new AbortController().signal,
  ).catch((error: unknown) => error);

  await flushMicrotasks();
  assert.match(waitingWords[0] ?? "", /Waiting for free memory on pve/);
  assert.equal(api.calls.some((call) => call.path.endsWith("/rollback")), false);

  await clock.advance(20_000);
  const rollbackErr = await blockedRollback;
  assert.ok(rollbackErr instanceof SnapshotFailed);
  assert.match(rollbackErr.message, /short by/);
  assert.equal(api.calls.some((call) => call.path.endsWith("/rollback")), false);
  assert.equal(waitingWords.at(-1), null);

  api.memory = { total: 64 * GIB, available: 48 * GIB };
  await backend.rollbackSnapshot(guest, { id: snapId, ref: `bb${snapId}`, guest }, snapHooks, new AbortController().signal);
  assert.equal(api.guests.get(vmid)!.status, "running");
});

test("K: Backends.dispose clears shared gates, and LXC GPU reservation waits until gate admits start", async () => {
  const backends = new Backends({ storage: new MemoryStorage(), installId: "test", logError: () => {} });
  const ctx = backends.context("proxmox-lxc");
  const first = ctx.shared!("proxmox-start-gate:pve.example.com:8006/pve", () => new ProxmoxStartGate());
  const same = ctx.shared!("proxmox-start-gate:pve.example.com:8006/pve", () => new ProxmoxStartGate());
  assert.equal(first, same);
  await backends.dispose();
  const afterDispose = ctx.shared!("proxmox-start-gate:pve.example.com:8006/pve", () => new ProxmoxStartGate());
  assert.notEqual(first, afterDispose);

  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 18 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7050, hostname: "gpu-box", pool: "bbbox" });
  const description = "bb-box install:test gpu-gate-test";
  await lxc.configure(7050, { description, memory: 4096 });

  const order: string[] = [];
  const owned = new OwnedGuests(lxc, () => {}, {
    helperFor: async () => "gpu-helper",
    ask: async (vmid, action) => {
      order.push(`helper-${action}:${vmid}`);
      if (action === "start") api.guests.get(vmid)!.status = "running";
    },
    acted: async () => {},
  });

  const gate = new ProxmoxStartGate();
  const pending = owned.start(
    7050,
    describedOwner("test", description),
    gate,
    { memoryMiB: 4096, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep },
    undefined,
    async () => {
      order.push("gpu-reservation");
    },
  );

  await flushMicrotasks();
  assert.deepEqual(order, []);

  api.memory = { total: 64 * GIB, available: 24 * GIB };
  await clock.advance(10_000);
  await pending;
  assert.deepEqual(order, ["gpu-reservation", "helper-start:7050"]);
});

test("L: image box bootMs measures from gate admission so refresh timing excludes gate waits", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }

  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 48 * GIB };

  api.guests.set(5700, {
    vmid: 5700,
    type: "qemu",
    name: "other-win",
    status: "running",
    template: false,
    config: { ostype: "win11", balloon: "0", memory: "8192" },
    startedAt: clock.now() - 60_000,
    memoryUsed: 8 * GIB,
  });

  const backend = new ProxmoxQemuBackend(
    qemuConfig({ "start-memory-margin-mib": 16384, "start-memory-wait-seconds": 600, "heavy-start-settle-seconds": 120 }),
    testContext(new MemoryStorage(), "test", { id: "proxmox-qemu" }),
    { fetch: api.fetch, sleep: gateClockSleep(clock), now: clock.now, sshBinary: FAKE_SSH_BINARY, portCheck: async () => true, readyTimeoutMs: 10_000 },
  );
  madeBackends.push(backend);

  const builds = (await backend.images.list()).builds;
  const pendingBox = backend.images.box(builds[0]!, "trial", new AbortController().signal);
  await flushMicrotasks();
  await clock.advance(60_000);
  const imageBox = await pendingBox;

  assert.ok(imageBox.bootMs !== undefined);
  assert.ok(imageBox.bootMs < 5_000, `expected bootMs without 60 s gate wait, got ${imageBox.bootMs}`);
  const startStep = imageBox.steps?.find((step) => step.name === "start");
  assert.ok(startStep !== undefined && startStep.ms < 5_000);
});

test("LXC and QEMU backends built by Backends on the same node share one start gate", async () => {
  const ssh = fakeSsh();
  for (let last = 150; last <= 159; last++) {
    ssh.windows(`192.0.2.${last}`);
    ssh.powershell(`192.0.2.${last}`, windowsWithExpiringPassword());
  }

  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.taskPolls = 0;
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 26 * GIB };

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

test("abort ends a memory wait or heavy settle wait at once", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.addVmTemplate(9104);
  api.memory = { total: 64 * GIB, available: 10 * GIB };
  const lxc = makeClient(api, "lxc");
  const qemu = makeClient(api, "qemu");
  await lxc.cloneLinked({ template: 9000, vmid: 7060, hostname: "abort-ct", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9740, hostname: "heavy-1", pool: "bbbox" });
  await qemu.cloneLinked({ template: 9104, vmid: 9741, hostname: "heavy-2", pool: "bbbox" });

  const gate = new ProxmoxStartGate();
  const controller = new AbortController();
  const progress: (string | null)[] = [];

  const memWait = gate.start(lxc, {
    vmid: 7060,
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
  assert.equal(api.guests.get(7060)!.status, "stopped");
  assert.equal(progress.at(-1), null);

  api.memory = { total: 128 * GIB, available: 80 * GIB };
  await gate.start(qemu, { vmid: 9740, kind: "windows-desktop", os: "windows", memoryMiB: 8192, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });

  const heavyController = new AbortController();
  const heavyWait = gate.start(qemu, {
    vmid: 9741,
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
  assert.equal(api.guests.get(9741)!.status, "stopped");
});

const SERVER_ERROR = { ok: false, status: 500, statusText: "proxy error", text: async () => JSON.stringify({ data: null }) };

test("a failed read of the node's VMs admits nothing, keeps waiting, and fails at the end of the wait", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 64 * GIB, available: 48 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7101, hostname: "unread-1", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7102, hostname: "unread-2", pool: "bbbox" });
  let failing = true;
  api.intercept = (call) => (failing && call.method === "GET" && call.path === "/nodes/pve/qemu" ? SERVER_ERROR : undefined);
  const gate = new ProxmoxStartGate();

  const recovers = gate.start(lxc, { vmid: 7101, memoryMiB: 4096, priority: "acquire", config: { ...DEFAULT_GATE, memoryWaitSeconds: 60 }, now: clock.now, sleep: clock.sleep });
  await clock.advance(10_000);
  assert.equal(api.guests.get(7101)!.status, "stopped");

  failing = false;
  await clock.advance(10_000);
  await recovers;
  assert.equal(api.guests.get(7101)!.status, "running");

  failing = true;
  const gives = gate.start(lxc, { vmid: 7102, memoryMiB: 4096, priority: "acquire", config: { ...DEFAULT_GATE, memoryWaitSeconds: 20 }, now: clock.now, sleep: clock.sleep }).catch((error: unknown) => error);
  await clock.advance(30_000);
  const error = await gives;

  assert.ok(error instanceof BackendError);
  assert.equal(error.code, "no_capacity");
  assert.match(error.message, /could not read pve's memory/);
  assert.equal(api.guests.get(7102)!.status, "stopped");
  api.intercept = undefined;
});

test("a heavy settle obeys the wait: a start that may not wait fails at once, and one that may fails at the end of its wait", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addVmTemplate(9104);
  api.memory = { total: 128 * GIB, available: 96 * GIB };
  api.guests.set(5800, { vmid: 5800, type: "qemu", name: "booting-win", status: "running", template: false, config: { ostype: "win11", balloon: "0", memory: "8192" }, startedAt: clock.now() - 30_000, memoryUsed: 8 * GIB });
  const qemu = makeClient(api, "qemu");
  await qemu.cloneLinked({ template: 9104, vmid: 9702, hostname: "win-settle", pool: "bbbox" });
  const gate = new ProxmoxStartGate();
  const request = { vmid: 9702, kind: "windows-desktop", os: "windows" as const, memoryMiB: 8192, priority: "refill" as const, now: clock.now, sleep: clock.sleep };

  const now = await gate.start(qemu, { ...request, config: { ...DEFAULT_GATE, memoryWaitSeconds: 0 } }).catch((error: unknown) => error);
  assert.ok(now instanceof BackendError);
  assert.match(now.message, /started too recently/);

  const later = gate.start(qemu, { ...request, priority: "acquire", config: { ...DEFAULT_GATE, memoryWaitSeconds: 30 } }).catch((error: unknown) => error);
  await clock.advance(40_000);
  const error = await later;

  assert.ok(error instanceof BackendError);
  assert.match(error.message, /started too recently within 30 s/);
  assert.equal(api.guests.get(9702)!.status, "stopped");
});

test("a guest already starting is never admitted twice, and starts in flight hold their memory until they finish", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.memory = { total: 128 * GIB, available: 36 * GIB };
  const lxc = makeClient(api, "lxc");
  const gate = new ProxmoxStartGate();
  const config = { ...DEFAULT_GATE, memoryWaitSeconds: 120 };
  const ran: number[] = [];
  const finishes = new Map<number, () => void>();
  const slowStart = (vmid: number) => () => {
    ran.push(vmid);
    return new Promise<void>((resolve) => finishes.set(vmid, resolve));
  };

  const first = gate.start(lxc, { vmid: 7201, memoryMiB: 16384, priority: "acquire", config, now: clock.now, sleep: clock.sleep }, slowStart(7201));
  const again = gate.start(lxc, { vmid: 7201, memoryMiB: 16384, priority: "acquire", config, now: clock.now, sleep: clock.sleep }, slowStart(7201));
  const other = gate.start(lxc, { vmid: 7202, memoryMiB: 16384, priority: "acquire", config, now: clock.now, sleep: clock.sleep }, slowStart(7202));
  await clock.advance(20_000);
  assert.deepEqual(ran, [7201]);

  finishes.get(7201)!();
  await first;
  await clock.advance(10_000);
  assert.equal(ran.length, 2);
  assert.equal(ran.filter((vmid) => vmid === 7201).length + ran.filter((vmid) => vmid === 7202).length, 2);

  for (const finish of finishes.values()) finish();
  await clock.advance(10_000);
  for (const finish of finishes.values()) finish();
  await Promise.all([again, other]);
  assert.deepEqual([...ran].sort(), [7201, 7201, 7202]);
});

test("a refill that fits waits while a thread's box waits for memory, and starts once that box gives up", async () => {
  const clock = new FakeClock();
  const api = new FakeProxmox();
  api.now = clock.now;
  api.addTemplate(9000);
  api.memory = { total: 128 * GIB, available: 30 * GIB };
  const lxc = makeClient(api, "lxc");
  await lxc.cloneLinked({ template: 9000, vmid: 7301, hostname: "big-acquire", pool: "bbbox" });
  await lxc.cloneLinked({ template: 9000, vmid: 7302, hostname: "small-refill", pool: "bbbox" });
  const gate = new ProxmoxStartGate();
  const stop = new AbortController();

  const acquire = gate.start(lxc, { vmid: 7301, memoryMiB: 16384, priority: "acquire", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep, signal: stop.signal }).catch((error: unknown) => error);
  const refill = gate.start(lxc, { vmid: 7302, memoryMiB: 4096, priority: "refill", config: DEFAULT_GATE, now: clock.now, sleep: clock.sleep });
  await clock.advance(30_000);
  assert.equal(api.guests.get(7302)!.status, "stopped");

  stop.abort(new Error("released"));
  await acquire;
  await clock.advance(10_000);
  await refill;
  assert.equal(api.guests.get(7302)!.status, "running");
  assert.equal(api.guests.get(7301)!.status, "stopped");
});
