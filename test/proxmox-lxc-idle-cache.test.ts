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
  IDLE_CACHE_SWEEP_EVERY_MS,
  reclaimIdleCacheScript,
} from "../src/backends/proxmox-lxc/idle-cache.ts";
import { SPARES } from "../src/core/boxes.ts";
import { type AcquireHooks, type BoxIdentity, type MachineSize } from "../src/backends/types.ts";
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
    "proxmox-lxc-vmid-last": 7019,
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
  readonly fileBytes?: number;
  readonly inactiveFileBytes: number;
  readonly activeFileBytes?: number;
  readonly anonBytes?: number;
  readonly shmemBytes?: number;
  readonly swapCurrentBytes?: number;
  readonly swapMax?: string;
  readonly refaults?: number;
  readonly pressureSome?: string;
  readonly pressureFull?: string;
  readonly cpuUsageUsec?: number;
  readonly rejectSwappiness0?: boolean;
  readonly pressureAfterStep?: { readonly step: number; readonly some: string; readonly full: string };
  readonly refaultSpikeAfterStep?: number;
  readonly swapGrowAfterStep?: number;
  readonly activeDropAfterStep?: { readonly step: number; readonly dropBytes: number };
  readonly eagainOnStep?: number;
  readonly failSudo?: boolean;
  readonly concurrencyLock?: string;
}

function writeFakeCgroup(sshRoot: string, host: string, options: FakeCgroupOptions) {
  const home = join(sshRoot, "home", host);
  const cgroupDir = join(home, "sys", "fs", "cgroup");
  const binDir = join(home, "bin");
  mkdirSync(cgroupDir, { recursive: true });
  mkdirSync(binDir, { recursive: true });

  const anon = options.anonBytes ?? 256 * MIB;
  const shmem = options.shmemBytes ?? 1 * MIB;
  const active = options.activeFileBytes ?? 0;
  const inactive = options.inactiveFileBytes;
  const file = options.fileBytes ?? inactive + active + shmem;
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
      `file ${file}`,
      `inactive_file ${inactive}`,
      `active_file ${active}`,
      `shmem ${shmem}`,
      `workingset_refault_file ${refaults}`,
    ].join("\n") + "\n",
  );
  writeFileSync(join(cgroupDir, "memory.pressure"), `${pressureSome}\n${pressureFull}\n`);
  writeFileSync(join(cgroupDir, "memory.reclaim"), "");
  writeFileSync(join(cgroupDir, "memory.swap.current"), `${swapCurrent}\n`);
  writeFileSync(join(cgroupDir, "memory.swap.max"), `${swapMax}\n`);
  writeFileSync(join(cgroupDir, "cpu.stat"), `usage_usec ${cpuUsec}\n`);

  const sudoPath = join(binDir, "sudo");
  if (options.failSudo) {
    writeFileSync(sudoPath, "#!/bin/sh\necho 'sudo: a password is required' >&2\nexit 1\n");
  } else {
    writeFileSync(
      sudoPath,
      [
        "#!/bin/sh",
        "while [ $# -gt 0 ]; do",
        '  case "$1" in',
        "    -u|-g|-p|-C|-D|-R|-T|-U|-h) shift 2 ;;",
        "    --) shift; break ;;",
        "    -*) shift ;;",
        "    *) break ;;",
        "  esac",
        "done",
        "[ $# -gt 0 ] || exit 0",
        'exec "$@"',
        "",
      ].join("\n"),
    );
  }
  chmodSync(sudoPath, 0o755);

  const timeoutPath = join(binDir, "timeout");
  writeFileSync(
    timeoutPath,
    [
      "#!/bin/sh",
      'case "${1:-}" in',
      '  ""|*[!0-9]*) exit 125 ;;',
      "esac",
      "shift",
      'exec "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(timeoutPath, 0o755);

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
const currentInactive = Number(map.get("inactive_file") || 0);
const currentActive = Number(map.get("active_file") || 0);
const currentShmem = Number(map.get("shmem") || 0);
const currentRefaults = Number(map.get("workingset_refault_file") || 0);

const eagainStep = ${JSON.stringify(options.eagainOnStep ?? 0)};
if (eagainStep > 0 && stepNum >= eagainStep) {
  const partial = Math.min(bytes, Math.max(0, Math.floor(currentInactive / 2)));
  const nextInactive = Math.max(0, currentInactive - partial);
  const nextFile = Math.max(currentShmem, currentFile - partial);
  map.set("inactive_file", String(nextInactive));
  map.set("file", String(nextFile));
  writeFileSync(statPath, [...map.entries()].map(([k, v]) => k + " " + v).join("\\n") + "\\n");
  exitWith(1);
}

const activeDrop = ${JSON.stringify(options.activeDropAfterStep ?? null)};
let dropActive = 0;
if (activeDrop && stepNum >= activeDrop.step) {
  dropActive = Math.min(currentActive, activeDrop.dropBytes);
}
const dropInactive = Math.min(Math.max(0, bytes - dropActive), currentInactive);
const nextInactive = Math.max(0, currentInactive - dropInactive);
const nextActive = Math.max(0, currentActive - dropActive);
const nextFile = Math.max(currentShmem, currentFile - dropInactive - dropActive);
map.set("inactive_file", String(nextInactive));
map.set("active_file", String(nextActive));
map.set("file", String(nextFile));

const refaultStep = ${JSON.stringify(options.refaultSpikeAfterStep ?? 0)};
if (refaultStep > 0 && stepNum >= refaultStep) {
  map.set("workingset_refault_file", String(currentRefaults + 2048));
}

writeFileSync(statPath, [...map.entries()].map(([k, v]) => k + " " + v).join("\\n") + "\\n");

const swapStep = ${JSON.stringify(options.swapGrowAfterStep ?? 0)};
if (swapStep > 0 && stepNum >= swapStep) {
  const swapPath = join(dir, "memory.swap.current");
  const curSwap = Number(readFileSync(swapPath, "utf8").trim());
  writeFileSync(swapPath, String(curSwap + 4096) + "\\n");
}

const pressureStep = ${JSON.stringify(options.pressureAfterStep ?? null)};
if (pressureStep && stepNum >= pressureStep.step) {
  writeFileSync(join(dir, "memory.pressure"), pressureStep.some + "\\n" + pressureStep.full + "\\n");
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
    readInactiveBytes: () => readStatField("inactive_file"),
    readActiveBytes: () => readStatField("active_file"),
    readAnonBytes: () => readStatField("anon"),
    readShmemBytes: () => readStatField("shmem"),
    readSwapBytes: () => Number(readFileSync(join(cgroupDir, "memory.swap.current"), "utf8").trim()),
    readWrites: () => (existsSync(writesLog) ? readFileSync(writesLog, "utf8").trim().split("\n").filter(Boolean) : []),
    setCpuUsageUsec: (usec: number) => writeFileSync(join(cgroupDir, "cpu.stat"), `usage_usec ${usec}\n`),
    setCacheBytes: (nextInactive: number, nextActive = 0, nextShmem = shmem) => {
      const text = readFileSync(join(cgroupDir, "memory.stat"), "utf8");
      const nextFile = nextInactive + nextActive + nextShmem;
      const next = text
        .replace(/^file \d+$/m, `file ${nextFile}`)
        .replace(/^inactive_file \d+$/m, `inactive_file ${nextInactive}`)
        .replace(/^active_file \d+$/m, `active_file ${nextActive}`)
        .replace(/^shmem \d+$/m, `shmem ${nextShmem}`);
      writeFileSync(join(cgroupDir, "memory.stat"), next);
      writeFileSync(stateFile, "0\n");
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

test("idle cache settings default on with 15 minutes, validate inputs, and wrap script in timeout", () => {
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

  for (const minutes of [0, -5, 1.5, 1441]) {
    const badMinutes = parseLxcSettings(validBaseSettings({ "proxmox-lxc-idle-cache-minutes": minutes }));
    assert.equal(badMinutes.enabled && !badMinutes.ok, true, `minutes=${minutes} should fail`);
  }

  const script = reclaimIdleCacheScript({ prevCpuUsageUsec: 0, maxCpuDeltaUsec: 1000, timeoutSeconds: 7 });
  assert.match(script, /sudo -n true/);
  assert.match(script, /sudo -n timeout 7 sh -s/);
});

test("first visit samples cpu.stat without reclaiming; second visit reclaims, enforces cooldown above floor and 60s throttle", async () => {
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

  const idleCgroup = writeFakeCgroup(ssh.dir, idleGuest.address!, {
    inactiveFileBytes: 640 * MIB,
    shmemBytes: 0,
    cpuUsageUsec: 10_000_000,
  });
  const busyCgroup = writeFakeCgroup(ssh.dir, busyGuest.address!, {
    inactiveFileBytes: 640 * MIB,
    shmemBytes: 0,
    cpuUsageUsec: 10_000_000,
  });

  await backend.maintain(signal);
  assert.deepEqual(idleCgroup.readWrites(), [], "first visit only samples cpu.stat and reclaims nothing");
  assert.equal(await storage.get("idle-cache-sweeps"), undefined, "sample-only sweep is not stored");

  const lateGuest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const lateEntry = proxmox.guests.get(Number(lateGuest.ref))!;
  lateEntry.cpu = 0.01;
  lateEntry.uptime = 3600;
  lateEntry.memoryUsed = 900 * MIB;
  writeFakeCgroup(ssh.dir, lateGuest.address!, { inactiveFileBytes: 640 * MIB, shmemBytes: 0, cpuUsageUsec: 10_000_000 });

  const sampleLogCountFor = (host: string) =>
    existsSync(join(ssh.dir, "log"))
      ? readFileSync(join(ssh.dir, "log"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { target: string; command: string; control?: string })
          .filter((entry) => !entry.control && entry.target.endsWith(`@${host}`) && entry.command.includes("SAMPLE")).length
      : 0;

  clock += IDLE_CACHE_SWEEP_EVERY_MS / 2;
  await backend.maintain(signal);
  assert.equal(sampleLogCountFor(lateGuest.address!), 0, "60s throttle skips back-to-back sweep");

  clock += IDLE_CACHE_SWEEP_EVERY_MS / 2;
  await backend.maintain(signal);
  assert.equal(sampleLogCountFor(lateGuest.address!), 1, "sweep runs once 60s throttle elapses");
  lateEntry.cpu = 0.25;

  clock += 15 * MINUTE_MS;
  idleCgroup.setCpuUsageUsec(12_000_000);
  await backend.maintain(signal);

  assert.deepEqual(idleCgroup.readWrites(), [
    "0 swappiness=0",
    `${IDLE_CACHE_STEP_BYTES} swappiness=0`,
    `${IDLE_CACHE_STEP_BYTES} swappiness=0`,
  ]);
  assert.equal(idleCgroup.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES);
  assert.equal(idleCgroup.readAnonBytes(), 256 * MIB);
  assert.equal(idleCgroup.readSwapBytes(), 0);
  assert.deepEqual(busyCgroup.readWrites(), []);
  assert.ok(logs.some((line) => line.includes(`Reclaimed 512 MiB of idle page cache from CT ${idleVmid}`)));

  const check = (await backend.doctor(signal)).checks.find((entry) => entry.id === "proxmox.idle-cache");
  assert.ok(check);
  assert.equal(check.status, "ok");
  assert.match(check.detail, /freed 512 MiB from 1 container/);

  idleCgroup.setCacheBytes(640 * MIB, 0, 0);
  clock += 3 * MINUTE_MS;
  await backend.maintain(signal);
  assert.equal(
    idleCgroup.readInactiveBytes(),
    640 * MIB,
    "per-box cooldown protects a box even when its cache refills above the floor",
  );

  clock += 12 * MINUTE_MS;
  idleCgroup.setCpuUsageUsec(13_000_000);
  await backend.maintain(signal);
  assert.equal(idleCgroup.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES, "reclaims again once cooldown elapses");
});

test("cpu.stat usage_usec catches work across the idle window even when Proxmox cpu reads 0", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const entry = proxmox.guests.get(Number(guest.ref))!;
  entry.cpu = 0.0;
  entry.uptime = 3600;
  entry.memoryUsed = 900 * MIB;

  const cgroup = writeFakeCgroup(ssh.dir, guest.address!, {
    inactiveFileBytes: 640 * MIB,
    shmemBytes: 0,
    cpuUsageUsec: 1_000_000,
  });

  await backend.maintain(signal);
  assert.deepEqual(cgroup.readWrites(), []);

  cgroup.setCpuUsageUsec(1_000_000 + 250_000_000);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.deepEqual(cgroup.readWrites(), [], "high cpu.stat delta over the window blocks reclaim");
  assert.equal(cgroup.readInactiveBytes(), 640 * MIB);

  cgroup.setCpuUsageUsec(1_000_000 + 251_000_000);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  assert.equal(cgroup.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES, "reclaims once a full idle window passes");
});

test("floor excludes shmem, budget uses inactive_file only, and active_file tolerates small drift while stopping on large drops", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, make } = setup();
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const largeShmem = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const shmemAtFloor = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const mostlyActive = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const activeDrifts = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
  const activeDrops = await backend.acquire(identity("linux"), null, emptyHooks(), signal);

  for (const guest of [largeShmem, shmemAtFloor, mostlyActive, activeDrifts, activeDrops]) {
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 1400 * MIB;
  }

  const cgLargeShmem = writeFakeCgroup(ssh.dir, largeShmem.address!, {
    shmemBytes: 700 * MIB,
    inactiveFileBytes: 400 * MIB,
    activeFileBytes: 0,
  });
  const cgShmemFloor = writeFakeCgroup(ssh.dir, shmemAtFloor.address!, {
    shmemBytes: 700 * MIB,
    inactiveFileBytes: 128 * MIB,
    activeFileBytes: 0,
  });
  const cgMostlyActive = writeFakeCgroup(ssh.dir, mostlyActive.address!, {
    shmemBytes: 0,
    inactiveFileBytes: 40 * MIB,
    activeFileBytes: 600 * MIB,
  });
  const cgActiveDrifts = writeFakeCgroup(ssh.dir, activeDrifts.address!, {
    shmemBytes: 0,
    inactiveFileBytes: 768 * MIB,
    activeFileBytes: 64 * MIB,
    activeDropAfterStep: { step: 1, dropBytes: 4 * MIB },
  });
  const cgActiveDrops = writeFakeCgroup(ssh.dir, activeDrops.address!, {
    shmemBytes: 0,
    inactiveFileBytes: 768 * MIB,
    activeFileBytes: 500 * MIB,
    activeDropAfterStep: { step: 1, dropBytes: 36 * MIB },
  });

  await backend.maintain(signal);
  clock += 2 * MINUTE_MS;
  await backend.maintain(signal);

  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);
  clock += 2 * MINUTE_MS;
  await backend.maintain(signal);

  assert.equal(cgLargeShmem.readShmemBytes(), 700 * MIB);
  assert.equal(cgLargeShmem.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES, "keeps 128 MiB of non-shmem file cache");
  assert.equal(cgLargeShmem.readFileBytes(), 700 * MIB + IDLE_CACHE_FLOOR_BYTES);

  assert.deepEqual(cgShmemFloor.readWrites(), [], "large shmem does not make 128 MiB real file cache reclaimable");
  assert.deepEqual(cgMostlyActive.readWrites(), [], "active_file is not reclaimed when inactive_file is below 64 MiB");

  assert.equal(cgActiveDrifts.readWrites().length, 4, "continues through small multi-generation LRU drift down to the floor");
  assert.equal(cgActiveDrifts.readFileBytes(), IDLE_CACHE_FLOOR_BYTES);
  assert.equal(cgActiveDrifts.readActiveBytes(), 52 * MIB);

  assert.equal(cgActiveDrops.readWrites().length, 3, "allows 36 MiB (<10% of 500 MiB) on step 1 and stops at 72 MiB (>10%) on step 2");
  assert.equal(cgActiveDrops.readActiveBytes(), 428 * MIB);
  assert.equal(cgActiveDrops.readInactiveBytes(), 328 * MIB);
});

test("runs reclaim after warm top-up, caps at 3 boxes and 20s, and unanswered boxes fail fast with cooldown", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, errors, make } = setup({ "proxmox-lxc-linux-warm": 1 });
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const guests = [
    await backend.acquire(identity("linux"), null, emptyHooks(), signal),
    await backend.acquire(identity("linux"), null, emptyHooks(), signal),
    await backend.acquire(identity("linux"), null, emptyHooks(), signal),
    await backend.acquire(identity("linux"), null, emptyHooks(), signal),
    await backend.acquire(identity("linux"), null, emptyHooks(), signal),
  ];

  const concurrencyLock = join(ssh.dir, "reclaim-active.lock");
  const cgroups = guests.map((guest, index) => {
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
    return writeFakeCgroup(ssh.dir, guest.address!, {
      inactiveFileBytes: 512 * MIB,
      shmemBytes: 0,
      concurrencyLock: index > 0 ? concurrencyLock : undefined,
    });
  });

  mkdirSync(join(ssh.dir, "down"), { recursive: true });
  writeFileSync(join(ssh.dir, "down", guests[0]!.address!), "");

  const sshLog = () =>
    existsSync(join(ssh.dir, "log"))
      ? readFileSync(join(ssh.dir, "log"), "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line) as { target: string; command: string; control?: string })
      : [];

  let sampleRunsAtWarmClone = -1;
  proxmox.intercept = (call) => {
    if (call.method === "POST" && call.path.endsWith("/clone")) {
      sampleRunsAtWarmClone = sshLog().filter((entry) => !entry.control && entry.command.includes("SAMPLE")).length;
    }
    return undefined;
  };

  const wallStart = Date.now();
  await backend.maintain(signal);
  const wallElapsedMs = Date.now() - wallStart;
  proxmox.intercept = undefined;

  assert.ok(wallElapsedMs < 5_000, `unanswered box must not wait 15s (took ${wallElapsedMs} ms)`);
  assert.equal(errors.length, 0);
  assert.equal(sampleRunsAtWarmClone, 0, "warm top-up clones before idle cache reclaim starts");

  const sampledFirst = new Set(
    sshLog()
      .filter((entry) => !entry.control && entry.command.includes("SAMPLE"))
      .map((entry) => entry.target),
  );
  assert.equal(sampledFirst.size, 3, "sweep visits at most 3 boxes at once");

  const downAttemptsAfterFirst = sshLog().filter(
    (entry) => !entry.control && entry.target.endsWith(`@${guests[0]!.address!}`),
  ).length;

  clock += 3 * MINUTE_MS;
  await backend.maintain(signal);

  const downAttemptsAfterCooldownCheck = sshLog().filter(
    (entry) => !entry.control && entry.target.endsWith(`@${guests[0]!.address!}`),
  ).length;
  assert.equal(downAttemptsAfterCooldownCheck, downAttemptsAfterFirst, "unanswered box gets the same cooldown");

  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  const reclaimedCount = cgroups.slice(1).filter((cg) => cg.readInactiveBytes() === IDLE_CACHE_FLOOR_BYTES).length;
  assert.equal(reclaimedCount, 3, "reclaim sweep also caps at 3 boxes");
  for (const cg of cgroups.slice(1)) {
    assert.equal(existsSync(join(cg.cgroupDir, "overlap.log")), false);
  }

  let budgetClock = 1_900_000_000_000;
  let calls = 0;
  const budgetEnv = setup();
  const budgetBackend = budgetEnv.make(undefined, {
    ...fakes(budgetEnv.proxmox),
    now: () => {
      calls++;
      if (calls > 4) budgetClock += 21_000;
      return budgetClock;
    },
  });
  const b1 = await budgetBackend.acquire(identity("linux"), null, emptyHooks(), signal);
  const b2 = await budgetBackend.acquire(identity("linux"), null, emptyHooks(), signal);
  for (const g of [b1, b2]) {
    const e = budgetEnv.proxmox.guests.get(Number(g.ref))!;
    e.cpu = 0.0;
    e.uptime = 3600;
    e.memoryUsed = 900 * MIB;
    writeFakeCgroup(budgetEnv.ssh.dir, g.address!, { inactiveFileBytes: 512 * MIB, shmemBytes: 0 });
  }
  calls = 0;
  await budgetBackend.maintain(signal);
  const sampledBudget = new Set(
    readFileSync(join(budgetEnv.ssh.dir, "log"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { target: string; command: string; control?: string })
      .filter((entry) => !entry.control && entry.command.includes("SAMPLE"))
      .map((entry) => entry.target),
  );
  assert.equal(sampledBudget.size, 1, "20s sweep time cap stops after first box exceeds budget");
});

function readSshCommands(sshDir: string): { readonly target: string; readonly command: string }[] {
  const logPath = join(sshDir, "log");
  if (!existsSync(logPath)) return [];
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { target: string; command: string; control?: string })
    .filter((entry) => !entry.control)
    .map(({ target, command }) => ({ target, command }));
}

test("sends no SSH commands to warm boxes, spares, other installs, out-of-range, stopped, or filling, image-box and retired tags", async () => {
  let clock = 1_800_000_000_000;
  const { ssh, proxmox, storage, errors, make } = setup({ "proxmox-lxc-linux-warm": 1 });
  const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
  const signal = new AbortController().signal;

  const spareBox = await backend.acquire(identity("linux", SPARES), null, emptyHooks(), signal);
  const spareEntry = proxmox.guests.get(Number(spareBox.ref))!;
  spareEntry.cpu = 0;
  spareEntry.uptime = 3600;
  spareEntry.memoryUsed = 900 * MIB;

  proxmox.guests.set(7001, {
    vmid: 7001,
    name: "bb-box-warm",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: {
      tags: "bb-box;install.test;warm;template.9000",
      description: "bb-box warm linux\ninstall test\n",
      cores: "2",
      memory: "4096",
      rootfs: "local-lvm:base-9000-disk-0/vm-7001-disk-0,size=8G",
    },
  });
  proxmox.guests.set(7002, {
    vmid: 7002,
    name: "other-install",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.other;box.box_other;thread.thr_other" },
  });
  proxmox.guests.set(7020, {
    vmid: 7020,
    name: "out-of-range",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.test;box.box_oor;thread.thr_oor" },
  });
  proxmox.guests.set(7004, {
    vmid: 7004,
    name: "filling-box",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.test;filling" },
  });
  proxmox.guests.set(7005, {
    vmid: 7005,
    name: "image-box",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.test;image-box" },
  });
  proxmox.guests.set(7006, {
    vmid: 7006,
    name: "retired-box",
    pool: "bbbox",
    status: "running",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.test;retired" },
  });
  proxmox.guests.set(7007, {
    vmid: 7007,
    name: "stopped-box",
    pool: "bbbox",
    status: "stopped",
    template: false,
    cpu: 0,
    uptime: 3600,
    memoryUsed: 900 * MIB,
    config: { tags: "bb-box;install.test;box.box_stopped;thread.thr_stopped" },
  });

  const filteredHosts = [
    spareBox.address!,
    "10.200.0.11",
    "10.200.0.12",
    "10.200.0.30",
    "10.200.0.14",
    "10.200.0.15",
    "10.200.0.16",
    "10.200.0.17",
  ];
  const cgroups = filteredHosts.map((host) => writeFakeCgroup(ssh.dir, host, { inactiveFileBytes: 640 * MIB, shmemBytes: 0 }));

  const beforeSweeps = readSshCommands(ssh.dir).length;

  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);
  clock += 15 * MINUTE_MS;
  await backend.maintain(signal);

  const afterSweeps = readSshCommands(ssh.dir).slice(beforeSweeps);
  assert.deepEqual(afterSweeps, [], "no SSH command reaches any filtered guest across the idle window");
  assert.deepEqual(errors, []);
  assert.equal(await storage.get("idle-cache-sweeps"), undefined);
  for (const cg of cgroups) {
    assert.deepEqual(cg.readWrites(), []);
  }
});

test("sends no SSH commands to guests in the in-memory reserved, imageBoxes or acquiring sets", async () => {
  const signal = new AbortController().signal;

  {
    let clock = 1_800_000_000_000;
    const baseStorage = new MemoryStorage();
    let intercepted = false;
    let backend!: ProxmoxLxcBackend;
    let proxmox!: FakeProxmox;
    let sshDir = "";
    const wrappedStorage = new MemoryStorage();
    wrappedStorage.get = baseStorage.get.bind(baseStorage);
    wrappedStorage.delete = baseStorage.delete.bind(baseStorage);
    wrappedStorage.set = async (key: string, value: unknown) => {
      await baseStorage.set(key, value);
      if (key === "next-vmid" && !intercepted) {
        intercepted = true;
        proxmox.guests.set(7000, {
          vmid: 7000,
          name: "reserved-box",
          pool: "bbbox",
          status: "running",
          template: false,
          cpu: 0,
          uptime: 3600,
          memoryUsed: 900 * MIB,
          config: { tags: "bb-box;install.test;box.box_res;thread.thr_res" },
        });
        writeFakeCgroup(sshDir, "10.200.0.10", { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });
        const before = readSshCommands(sshDir).length;
        await backend.maintain(signal);
        clock += 15 * MINUTE_MS;
        await backend.maintain(signal);
        clock += 15 * MINUTE_MS;
        await backend.maintain(signal);
        assert.deepEqual(readSshCommands(sshDir).slice(before), [], "reserved VMID receives no SSH commands");
        proxmox.guests.delete(7000);
      }
    };

    const env = setup({}, wrappedStorage);
    proxmox = env.proxmox;
    sshDir = env.ssh.dir;
    backend = env.make(undefined, { ...fakes(proxmox), now: () => clock });
    await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    assert.equal(intercepted, true);
  }

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const { builds } = await backend.images.list(signal);
    const imageBox = await backend.images.box(builds[0]!, "try", signal);
    const imageVmid = Number(imageBox.ref);
    const entry = proxmox.guests.get(imageVmid)!;
    entry.config.tags = "bb-box;install.test";
    entry.cpu = 0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
    writeFakeCgroup(ssh.dir, "10.200.0.10", { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });

    const before = readSshCommands(ssh.dir).length;
    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    assert.deepEqual(readSshCommands(ssh.dir).slice(before), [], "in-memory imageBox receives no SSH commands even without image-box tag");
  }

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const id = identity("linux");
    const guest = await backend.acquire(id, null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
    writeFakeCgroup(ssh.dir, guest.address!, { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });

    let checkedDuringAcquire = false;
    await backend.acquire(
      id,
      guest,
      {
        ...emptyHooks(),
        starting: async () => {
          const before = readSshCommands(ssh.dir).length;
          await backend.maintain(signal);
          clock += 15 * MINUTE_MS;
          await backend.maintain(signal);
          clock += 15 * MINUTE_MS;
          await backend.maintain(signal);
          assert.deepEqual(readSshCommands(ssh.dir).slice(before), [], "guest being acquired receives no SSH commands");
          checkedDuringAcquire = true;
        },
      },
      signal,
    );
    assert.equal(checkedDuringAcquire, true);
  }
});

test("resets idle tracker on hold() and relabel()", async () => {
  const signal = new AbortController().signal;

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const id = identity("linux");
    const guest = await backend.acquire(id, null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
    const cg = writeFakeCgroup(ssh.dir, guest.address!, { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });

    await backend.maintain(signal);
    await backend.hold(
      { ref: guest.ref, host: guest.host, kinds: ["linux"], state: "free", reason: null, since: clock, generation: 0 },
      id,
      9000,
      signal,
    );

    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    assert.deepEqual(cg.readWrites(), [], "hold() reset the idle tracker so the next visit only re-samples");

    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    assert.equal(cg.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES, "reclaims after full idle window post-hold");
  }

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;
    const cg = writeFakeCgroup(ssh.dir, guest.address!, { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });

    await backend.maintain(signal);
    await backend.relabel(guest, identity("linux", "thr_claimed"), guest.address!, signal);

    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    assert.deepEqual(cg.readWrites(), [], "relabel() reset the idle tracker so the next visit only re-samples");

    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);
    assert.equal(cg.readInactiveBytes(), IDLE_CACHE_FLOOR_BYTES, "reclaims after full idle window post-relabel");
  }
});

test("enforces swap-growth stop and every initial and step memory.pressure rule plus refaults and EAGAIN", async () => {
  const cases: { readonly name: string; readonly cgroup: FakeCgroupOptions; readonly expectedWrites: number; readonly expectedInactiveMiB: number }[] = [
    {
      name: "initial some avg10",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureSome: "some avg10=1.20 avg60=0.00 avg300=0.00 total=1000",
        pressureFull: "full avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
      },
      expectedWrites: 0,
      expectedInactiveMiB: 768,
    },
    {
      name: "initial some avg60",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureSome: "some avg10=0.00 avg60=1.20 avg300=0.40 total=5000",
        pressureFull: "full avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
      },
      expectedWrites: 0,
      expectedInactiveMiB: 768,
    },
    {
      name: "initial full avg10",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureSome: "some avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
        pressureFull: "full avg10=0.60 avg60=0.00 avg300=0.00 total=5000",
      },
      expectedWrites: 0,
      expectedInactiveMiB: 768,
    },
    {
      name: "initial full avg60",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureSome: "some avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
        pressureFull: "full avg10=0.00 avg60=0.60 avg300=0.00 total=5000",
      },
      expectedWrites: 0,
      expectedInactiveMiB: 768,
    },
    {
      name: "step swap growth",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        swapGrowAfterStep: 1,
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step some avg10",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureAfterStep: {
          step: 1,
          some: "some avg10=1.20 avg60=0.00 avg300=0.00 total=1000",
          full: "full avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
        },
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step full avg10",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureAfterStep: {
          step: 1,
          some: "some avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
          full: "full avg10=0.60 avg60=0.00 avg300=0.00 total=1000",
        },
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step some total delta",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureAfterStep: {
          step: 1,
          some: "some avg10=0.00 avg60=0.00 avg300=0.00 total=60000",
          full: "full avg10=0.00 avg60=0.00 avg300=0.00 total=1000",
        },
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step full total delta",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        pressureAfterStep: {
          step: 1,
          some: "some avg10=0.00 avg60=0.00 avg300=0.00 total=6000",
          full: "full avg10=0.00 avg60=0.00 avg300=0.00 total=15000",
        },
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step refault spike",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        refaultSpikeAfterStep: 1,
      },
      expectedWrites: 2,
      expectedInactiveMiB: 512,
    },
    {
      name: "step eagain",
      cgroup: {
        inactiveFileBytes: 768 * MIB,
        shmemBytes: 0,
        eagainOnStep: 2,
      },
      expectedWrites: 3,
      expectedInactiveMiB: 256,
    },
  ];

  for (const scenario of cases) {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const signal = new AbortController().signal;

    const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 1024 * MIB;

    const cg = writeFakeCgroup(ssh.dir, guest.address!, scenario.cgroup);

    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);

    assert.equal(cg.readWrites().length, scenario.expectedWrites, `${scenario.name}: writes`);
    assert.equal(cg.readInactiveBytes(), scenario.expectedInactiveMiB * MIB, `${scenario.name}: inactive_file`);
  }
});

test("skips kernels without swappiness=0 even when swap is full, reports sudo failure distinctly, and doctor warns when all fail", async () => {
  const signal = new AbortController().signal;

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;

    const cg = writeFakeCgroup(ssh.dir, guest.address!, {
      inactiveFileBytes: 640 * MIB,
      shmemBytes: 0,
      swapCurrentBytes: 512 * MIB,
      swapMax: String(512 * MIB),
      rejectSwappiness0: true,
    });

    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);

    assert.deepEqual(cg.readWrites(), ["0 swappiness=0"], "never writes bare bytes even when swap is full");
    assert.equal(cg.readInactiveBytes(), 640 * MIB);

    const check = (await backend.doctor(signal)).checks.find((item) => item.id === "proxmox.idle-cache");
    assert.ok(check);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /swappiness=0/);
    assert.ok(check.fix);
  }

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup();
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;

    writeFakeCgroup(ssh.dir, guest.address!, {
      inactiveFileBytes: 640 * MIB,
      shmemBytes: 0,
      failSudo: true,
    });

    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);

    const check = (await backend.doctor(signal)).checks.find((item) => item.id === "proxmox.idle-cache");
    assert.ok(check);
    assert.equal(check.status, "warn");
    assert.match(check.detail, /failed sudo without a password/);
    assert.doesNotMatch(check.detail, /did not answer/);
    assert.match(check.fix!, /passwordless sudo/);
  }

  {
    let clock = 1_800_000_000_000;
    const { ssh, proxmox, make } = setup({ "proxmox-lxc-idle-cache-reclaim": false });
    const backend = make(undefined, { ...fakes(proxmox), now: () => clock });
    const guest = await backend.acquire(identity("linux"), null, emptyHooks(), signal);
    const entry = proxmox.guests.get(Number(guest.ref))!;
    entry.cpu = 0.0;
    entry.uptime = 3600;
    entry.memoryUsed = 900 * MIB;

    const cg = writeFakeCgroup(ssh.dir, guest.address!, { inactiveFileBytes: 640 * MIB, shmemBytes: 0 });
    await backend.maintain(signal);
    clock += 15 * MINUTE_MS;
    await backend.maintain(signal);

    assert.deepEqual(cg.readWrites(), []);
    const check = (await backend.doctor(signal)).checks.find((item) => item.id === "proxmox.idle-cache");
    assert.ok(check);
    assert.equal(check.status, "ok");
    assert.match(check.detail, /^Off in BB Box's settings/);
  }
});
