import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import { ProxmoxLxcBackend, type LxcBackendOptions } from "../src/backends/proxmox-lxc/backend.ts";
import { parseLxcSettings } from "../src/backends/proxmox-lxc/config.ts";
import {
  IDLE_CACHE_FLOOR_BYTES,
  IDLE_CACHE_MINUTES_DEFAULT,
  IDLE_CACHE_STEP_BYTES,
} from "../src/backends/proxmox-lxc/idle-cache.ts";
import { type AcquireHooks, type BoxIdentity, type Guest, type MachineSize } from "../src/backends/types.ts";
import { gpuWhenNotAsked } from "../src/core/gpu.ts";
import { defaultSize, kindSizes } from "../src/core/sizes.ts";
import { FAKE_TOKEN, FakeProxmox } from "./fake-proxmox.ts";
import { FAKE_SSH_BINARY, MemoryStorage, fakeSsh, lxcConfig, lxcWarm, testContext } from "./helpers.ts";

const MIB = 2 ** 20;
const MINUTE_MS = 60_000;

const made: ProxmoxLxcBackend[] = [];
after(async () => {
  for (const backend of made) await backend.dispose();
});

function track(backend: ProxmoxLxcBackend): ProxmoxLxcBackend {
  made.push(backend);
  return backend;
}

function fakes(proxmox: FakeProxmox): LxcBackendOptions {
  return {
    fetch: proxmox.fetch,
    sleep: async () => {},
    sshBinary: FAKE_SSH_BINARY,
    portCheck: async () => true,
    readyTimeoutMs: 0,
  };
}

function setup(values: Record<string, unknown> = {}, storage = new MemoryStorage(), options: LxcBackendOptions = {}) {
  const ssh = fakeSsh();
  const proxmox = new FakeProxmox();
  proxmox.addTemplate(9000);
  const config = lxcConfig({
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-desktop-templates": "",
    "proxmox-lxc-vmid-first": 7000,
    "proxmox-lxc-vmid-last": 7009,
    ...values,
  });
  const logs: string[] = [];
  const errors: string[] = [];
  const warm = lxcWarm(values);
  const context = {
    ...testContext(storage, "test", { id: "proxmox-lxc", warm }),
    log: (line: string) => logs.push(line),
    logError: (operation: string, error: unknown) =>
      errors.push(`${operation}: ${error instanceof Error ? error.message : String(error)}`),
  };
  const make = (on = context, overrideOptions: LxcBackendOptions = options) =>
    track(new ProxmoxLxcBackend(config, on, { ...fakes(proxmox), ...overrideOptions }));
  return { ssh, proxmox, context, storage, logs, errors, make, backend: make() };
}

const sized = (kind: string): MachineSize => defaultSize(kindSizes(kind));

let boxCounter = 0;
function identity(kind = "linux", threadId = "thr_idle"): BoxIdentity {
  boxCounter++;
  return {
    boxId: `box_idle_${boxCounter}`,
    threadId,
    name: `quiet-fox-${boxCounter}`,
    kind,
    createdAt: 1_790_000_000_000,
    size: { ...sized(kind), gpu: gpuWhenNotAsked(kind) },
  };
}

function emptyHooks(): AcquireHooks {
  return {
    claim: async () => {},
    starting: async () => {},
    timing: () => {},
  };
}

interface FakeCgroupOptions {
  readonly fileBytes: number;
  readonly anonBytes?: number;
  readonly shmemBytes?: number;
  readonly swapCurrentBytes?: number;
  readonly swapMax?: string;
  readonly refaults?: number;
  readonly pressureSome?: string;
  readonly pressureFull?: string;
  readonly cpuUsageUsec?: number;
  readonly rejectSwappiness0?: boolean;
  readonly pressureAfterStep?: number;
  readonly refaultSpikeAfterStep?: number;
  readonly eagainOnStep?: number;
  readonly concurrencyLock?: string;
}

function writeFakeCgroup(sshRoot: string, host: string, options: FakeCgroupOptions): {
  readonly cgroupDir: string;
  readonly writesLog: string;
  readonly readFileBytes: () => number;
  readonly readAnonBytes: () => number;
  readonly readShmemBytes: () => number;
  readonly readSwapBytes: () => number;
  readonly readWrites: () => string[];
  readonly setCpuUsageUsec: (usec: number) => void;
  readonly setFileBytes: (bytes: number) => void;
} {
  const home = join(sshRoot, "home", host);
  const cgroupDir = join(home, "sys", "fs", "cgroup");
  const binDir = join(home, "bin");
  mkdirSync(cgroupDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const anon = options.anonBytes ?? 256 * MIB;
  const shmem = options.shmemBytes ?? 1 * MIB;
  const swapCurrent = options.swapCurrentBytes ?? 0;
  const swapMax = options.swapMax ?? "max";
  const refaults = options.refaults ?? 100;
  const pressureSome = options.pressureSome ?? "some avg10=0.00 avg60=0.00 avg300=0.00 total=1000";
  const pressureFull = options.pressureFull ?? "full avg10=0.00 avg60=0.00 avg300=0.00 total=1000";
  const cpuUsec = options.cpuUsageUsec ?? 5_000_000;

  writeFileSync(
    join(cgroupDir, "memory.stat"),
    [
      `anon ${anon}`,
      `file ${options.fileBytes}`,
      `inactive_file ${options.fileBytes}`,
      `active_file 0`,
      `shmem ${shmem}`,
      `workingset_refault_file ${refaults}`,
    ].join("\n") + "\n",
  );
  writeFileSync(join(cgroupDir, "memory.pressure"), `${pressureSome}\n${pressureFull}\n`);
  writeFileSync(join(cgroupDir, "memory.reclaim"), "");
  writeFileSync(join(cgroupDir, "memory.swap.current"), `${swapCurrent}\n`);
  writeFileSync(join(cgroupDir, "memory.swap.max"), `${swapMax}\n`);
  writeFileSync(join(cgroupDir, "cpu.stat"), `usage_usec ${cpuUsec}\n`);

  const writesLog = join(cgroupDir, "reclaim.log");
  const stateFile = join(cgroupDir, "reclaim.steps");
  writeFileSync(stateFile, "0\n");

  const ddScript = `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ofArg = process.argv.slice(2).find((arg) => arg.startsWith("of="));
const target = ofArg ? ofArg.slice(3) : "";
const input = readFileSync(0, "utf8").trim();

if (!target.endsWith("/memory.reclaim")) {
  process.exit(1);
}

const dir = target.slice(0, -"/memory.reclaim".length);
const lock = ${JSON.stringify(options.concurrencyLock ?? "")};
if (lock) {
  if (existsSync(lock)) {
    appendFileSync(join(dir, "overlap.log"), "overlap\\n");
  }
  writeFileSync(lock, String(process.pid));
}

const exitWith = (code) => {
  if (lock) rmSync(lock, { force: true });
  process.exit(code);
};

appendFileSync(${JSON.stringify(writesLog)}, input + "\\n");
const parts = input.split(/\\s+/);
const bytes = Number(parts[0]);
const hasSwappiness = parts.includes("swappiness=0");
if (!Number.isFinite(bytes) || bytes < 0) exitWith(1);
if (hasSwappiness && ${JSON.stringify(Boolean(options.rejectSwappiness0))}) exitWith(1);
if (bytes === 0) exitWith(0);

const stepNum = Number(readFileSync(${JSON.stringify(stateFile)}, "utf8").trim()) + 1;
writeFileSync(${JSON.stringify(stateFile)}, String(stepNum) + "\\n");

const statPath = join(dir, "memory.stat");
const lines = readFileSync(statPath, "utf8").trim().split("\\n");
const map = new Map(lines.map((line) => line.split(/\\s+/)));
const currentFile = Number(map.get("file") || 0);
const currentRefaults = Number(map.get("workingset_refault_file") || 0);

const eagainStep = ${JSON.stringify(options.eagainOnStep ?? 0)};
if (eagainStep > 0 && stepNum >= eagainStep) {
  const partial = Math.min(bytes, Math.max(0, Math.floor((currentFile - ${IDLE_CACHE_FLOOR_BYTES}) / 2)));
  const nextFile = Math.max(0, currentFile - partial);
  map.set("file", String(nextFile));
  map.set("inactive_file", String(nextFile));
  writeFileSync(statPath, [...map.entries()].map(([k, v]) => k + " " + v).join("\\n") + "\\n");
  exitWith(1);
}

const drop = Math.min(bytes, Math.max(0, currentFile - 16 * ${MIB}));
const nextFile = Math.max(0, currentFile - drop);
map.set("file", String(nextFile));
map.set("inactive_file", String(nextFile));

const refaultStep = ${JSON.stringify(options.refaultSpikeAfterStep ?? 0)};
if (refaultStep > 0 && stepNum >= refaultStep) {
  map.set("workingset_refault_file", String(currentRefaults + 2048));
}

writeFileSync(statPath, [...map.entries()].map(([k, v]) => k + " " + v).join("\\n") + "\\n");

const pressureStep = ${JSON.stringify(options.pressureAfterStep ?? 0)};
if (pressureStep > 0 && stepNum >= pressureStep) {
  writeFileSync(
    join(dir, "memory.pressure"),
    "some avg10=2.50 avg60=0.80 avg300=0.20 total=120000\\nfull avg10=0.50 avg60=0.10 avg300=0.02 total=25000\\n",
  );
}
exitWith(0);
`;

  const ddPath = join(binDir, "dd");
  writeFileSync(ddPath, ddScript);
  chmodSync(ddPath, 0o755);

  const readStatField = (field: string): number => {
    const text = readFileSync(join(cgroupDir, "memory.stat"), "utf8");
    const match = new RegExp(`^${field}\\s+(\\d+)$`, "m").exec(text);
    return match ? Number(match[1]) : 0;
  };

  return {
    cgroupDir,
    writesLog,
    readFileBytes: () => readStatField("file"),
    readAnonBytes: () => readStatField("anon"),
    readShmemBytes: () => readStatField("shmem"),
    readSwapBytes: () => Number(readFileSync(join(cgroupDir, "memory.swap.current"), "utf8").trim()),
    readWrites: () => (existsSync(writesLog) ? readFileSync(writesLog, "utf8").trim().split("\n").filter(Boolean) : []),
    setCpuUsageUsec: (usec: number) => writeFileSync(join(cgroupDir, "cpu.stat"), `usage_usec ${usec}\n`),
    setFileBytes: (bytes: number) => {
      const text = readFileSync(join(cgroupDir, "memory.stat"), "utf8");
      const next = text
        .replace(/^file \d+$/m, `file ${bytes}`)
        .replace(/^inactive_file \d+$/m, `inactive_file ${bytes}`);
      writeFileSync(join(cgroupDir, "memory.stat"), next);
    },
  };
}

function validBaseSettings(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    "proxmox-lxc-url": "https://192.0.2.10:8006/api2/json",
    "proxmox-lxc-token-id": FAKE_TOKEN.tokenId,
    "proxmox-lxc-token-secret": FAKE_TOKEN.tokenSecret,
    "proxmox-lxc-linux-templates": "9000",
    ...overrides,
  };
}

test("idle cache settings default on with 15 minutes and validate inputs", () => {
  const defaults = parseLxcSettings(validBaseSettings());
  assert.equal(defaults.enabled, true);
  assert.equal(defaults.ok, true);
  assert.deepEqual(defaults.config.idleCache, { reclaim: true, idleMinutes: IDLE_CACHE_MINUTES_DEFAULT });

  const custom = parseLxcSettings(
    validBaseSettings({
      "proxmox-lxc-idle-cache-reclaim": false,
      "proxmox-lxc-idle-cache-minutes": 30,
    }),
  );
  assert.equal(custom.enabled && custom.ok, true);
  if (custom.enabled && custom.ok) {
    assert.deepEqual(custom.config.idleCache, { reclaim: false, idleMinutes: 30 });
  }

  const badFlag = parseLxcSettings(validBaseSettings({ "proxmox-lxc-idle-cache-reclaim": "yes" }));
  assert.equal(badFlag.enabled && !badFlag.ok, true);
  if (badFlag.enabled && !badFlag.ok) {
    assert.match(badFlag.problems.join(" "), /Reclaim idle page cache is true or false/);
  }

  for (const minutes of [0, -5, 1.5, 1441]) {
    const badMinutes = parseLxcSettings(validBaseSettings({ "proxmox-lxc-idle-cache-minutes": minutes }));
    assert.equal(badMinutes.enabled && !badMinutes.ok, true, `minutes=${minutes} should fail`);
    if (badMinutes.enabled && !badMinutes.ok) {
      assert.match(badMinutes.problems.join(" "), /whole number of minutes from 1 to 1440/);
    }
  }
});

test("reclaims cold page cache of an idle box, leaves busy boxes alone, logs and reports in doctor", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, storage, logs, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const idleGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const busyGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const idleVmid = Number(idleGuest.ref);
  const busyVmid = Number(busyGuest.ref);

  proxmox.guests.get(idleVmid)!.cpu = 0.01;
  proxmox.guests.get(idleVmid)!.uptime = 3600;
  proxmox.guests.get(idleVmid)!.memoryUsed = 900 * MIB;

  proxmox.guests.get(busyVmid)!.cpu = 0.35;
  proxmox.guests.get(busyVmid)!.uptime = 3600;
  proxmox.guests.get(busyVmid)!.memoryUsed = 900 * MIB;

  const idleCgroup = writeFakeCgroup(ssh.dir, idleGuest.address!, { fileBytes: 640 * MIB });
  const busyCgroup = writeFakeCgroup(ssh.dir, busyGuest.address!, { fileBytes: 640 * MIB });

  await backend.maintain(signal);
  assert.deepEqual(idleCgroup.readWrites(), []);
  assert.deepEqual(busyCgroup.readWrites(), []);

  clock += 10 * MINUTE_MS;
  await backend.maintain(signal);
  assert.deepEqual(idleCgroup.readWrites(), []);

  clock += 5 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(idleCgroup.readWrites(), [
    "0 swappiness=0",
    `${IDLE_CACHE_STEP_BYTES} swappiness=0`,
    `${IDLE_CACHE_STEP_BYTES} swappiness=0`,
  ]);
  assert.equal(idleCgroup.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);
  assert.equal(idleCgroup.readAnonBytes(), 256 * MIB);
  assert.equal(idleCgroup.readShmemBytes(), 1 * MIB);
  assert.equal(idleCgroup.readSwapBytes(), 0);

  assert.deepEqual(busyCgroup.readWrites(), []);
  assert.equal(busyCgroup.readFileBytes(), 640 * MIB);

  assert.ok(logs.some((line) => line.includes(`Reclaimed 512 MiB of idle page cache from CT ${idleVmid}`)));

  const report = await backend.doctor(signal);
  const check = report.checks.find((entry) => entry.id === "proxmox.idle-cache");
  assert.ok(check);
  assert.equal(check.status, "ok");
  assert.match(check.detail, /freed 512 MiB from 1 container/);

  clock += 3 * MINUTE_MS;
  await backend.maintain(signal);
  assert.equal(idleCgroup.readWrites().length, 3, "cooldown skips re-reclaiming immediately");

  const reloaded = make(undefined, { ...fakes(proxmox), now: () => clock });
  const reloadedCheck = (await reloaded.doctor(signal)).checks.find((entry) => entry.id === "proxmox.idle-cache");
  assert.ok(reloadedCheck);
  assert.match(reloadedCheck.detail, /512 MiB freed across 1 container/);
  assert.ok(await storage.get("idle-cache-sweeps"));
});

test("an unanswered box does not stop the sweep and boxes run one at a time", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, errors, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const brokenGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const healthyGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const thirdGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);

  for (const guest of [brokenGuest, healthyGuest, thirdGuest]) {
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
  }

  const concurrencyLock = join(ssh.dir, "reclaim-active.lock");
  const healthyCgroup = writeFakeCgroup(ssh.dir, healthyGuest.address!, {
    fileBytes: 512 * MIB,
    concurrencyLock,
  });
  const thirdCgroup = writeFakeCgroup(ssh.dir, thirdGuest.address!, {
    fileBytes: 384 * MIB,
    concurrencyLock,
  });

  mkdirSync(join(ssh.dir, "down"), { recursive: true });
  writeFileSync(join(ssh.dir, "down", brokenGuest.address!), "");

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.equal(errors.length, 0, "unanswered box gives up quietly without logging an error");
  assert.equal(healthyCgroup.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);
  assert.equal(thirdCgroup.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);
  assert.equal(existsSync(join(healthyCgroup.cgroupDir, "overlap.log")), false);
  assert.equal(existsSync(join(thirdCgroup.cgroupDir, "overlap.log")), false);

  const check = (await backend.doctor(signal)).checks.find((entry) => entry.id === "proxmox.idle-cache");
  assert.ok(check);
  assert.match(check.detail, /checked 3 idle containers and freed 640 MiB from 2 containers/);
  assert.match(check.detail, /1 did not answer/);
});

test("stops stepping on memory pressure, refaults or EAGAIN and skips pressured boxes", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const alreadyPressured = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const risesPressure = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const spikesRefaults = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const hitsEagain = await backend.acquire(identity("linux"), null, emptyHooks(), signal);

  for (const guest of [alreadyPressured, risesPressure, spikesRefaults, hitsEagain]) {
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 1024 * MIB;
  }

  const cgroupAlready = writeFakeCgroup(ssh.dir, alreadyPressured.address!, {
    fileBytes: 768 * MIB,
    pressureSome: "some avg10=2.50 avg60=1.20 avg300=0.40 total=50000",
  });
  const cgroupRises = writeFakeCgroup(ssh.dir, risesPressure.address!, {
    fileBytes: 768 * MIB,
    pressureAfterStep: 1,
  });
  const cgroupRefaults = writeFakeCgroup(ssh.dir, spikesRefaults.address!, {
    fileBytes: 768 * MIB,
    refaultSpikeAfterStep: 1,
  });
  const cgroupEagain = writeFakeCgroup(ssh.dir, hitsEagain.address!, {
    fileBytes: 768 * MIB,
    eagainOnStep: 2,
  });

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(cgroupAlready.readWrites(), []);
  assert.equal(cgroupAlready.readFileBytes(), 768 * MIB);

  assert.equal(cgroupRises.readWrites().length, 2, "probe plus 1 step before pressure stops it");
  assert.equal(cgroupRises.readFileBytes(), 512 * MIB);

  assert.equal(cgroupRefaults.readWrites().length, 2, "probe plus 1 step before refault spike stops it");
  assert.equal(cgroupRefaults.readFileBytes(), 512 * MIB);

  assert.equal(cgroupEagain.readWrites().length, 3, "probe plus step 1 plus EAGAIN on step 2");
  assert.equal(cgroupEagain.readFileBytes(), 320 * MIB);
});

test("skips reclaim without swappiness=0 when swap headroom exists, and allows it when swap is full", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const withSwapHeadroom = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const withoutSwapHeadroom = await backend.acquire(identity("linux"), null, emptyHooks(), signal);

  for (const guest of [withSwapHeadroom, withoutSwapHeadroom]) {
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
  }

  const cgroupWithSwap = writeFakeCgroup(ssh.dir, withSwapHeadroom.address!, {
    fileBytes: 640 * MIB,
    swapCurrentBytes: 0,
    swapMax: String(512 * MIB),
    rejectSwappiness0: true,
  });
  const cgroupFullSwap = writeFakeCgroup(ssh.dir, withoutSwapHeadroom.address!, {
    fileBytes: 640 * MIB,
    swapCurrentBytes: 512 * MIB,
    swapMax: String(512 * MIB),
    rejectSwappiness0: true,
  });

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(cgroupWithSwap.readWrites(), ["0 swappiness=0"]);
  assert.equal(cgroupWithSwap.readFileBytes(), 640 * MIB);

  assert.deepEqual(cgroupFullSwap.readWrites(), [
    "0 swappiness=0",
    String(IDLE_CACHE_STEP_BYTES),
    String(IDLE_CACHE_STEP_BYTES),
  ]);
  assert.equal(cgroupFullSwap.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);
});

test("skips young boxes and catches CPU bursts between sweeps via cgroup cpu.stat", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const youngGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const burstGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);

  proxmox.guests.get(Number(youngGuest.ref))!.cpu = 0.0;
  proxmox.guests.get(Number(youngGuest.ref))!.uptime = 300;
  proxmox.guests.get(Number(youngGuest.ref))!.memoryUsed = 900 * MIB;

  proxmox.guests.get(Number(burstGuest.ref))!.cpu = 0.0;
  proxmox.guests.get(Number(burstGuest.ref))!.uptime = 3600;
  proxmox.guests.get(Number(burstGuest.ref))!.memoryUsed = 900 * MIB;

  const cgroupYoung = writeFakeCgroup(ssh.dir, youngGuest.address!, { fileBytes: 640 * MIB });
  const cgroupBurst = writeFakeCgroup(ssh.dir, burstGuest.address!, {
    fileBytes: 640 * MIB,
    cpuUsageUsec: 1_000_000,
  });

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(cgroupYoung.readWrites(), [], "uptime under 15 minutes is never reclaimed");
  assert.equal(cgroupBurst.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);

  cgroupBurst.setFileBytes(640 * MIB);
  cgroupBurst.setCpuUsageUsec(1_000_000 + 300_000_000);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.equal(cgroupBurst.readFileBytes(), 640 * MIB, "burst of 300 CPU-seconds over 15 minutes prevents reclaim");
});

test("idle-cache-reclaim false disables the sweep and reports off in doctor", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup({ "proxmox-lxc-idle-cache-reclaim": false });
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  proxmox.guests.get(Number(guest.ref))!.cpu = 0.0;
  proxmox.guests.get(Number(guest.ref))!.uptime = 3600;
  proxmox.guests.get(Number(guest.ref))!.memoryUsed = 900 * MIB;

  const cgroup = writeFakeCgroup(ssh.dir, guest.address!, { fileBytes: 640 * MIB });

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(cgroup.readWrites(), []);
  assert.equal(cgroup.readFileBytes(), 640 * MIB);

  const check = (await backend.doctor(signal)).checks.find((entry) => entry.id === "proxmox.idle-cache");
  assert.ok(check);
  assert.equal(check.status, "ok");
  assert.match(check.detail, /^Off in BB Box's settings/);
});
