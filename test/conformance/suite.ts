// The backend conformance suite: one set of checks every backend passes,
// whatever the provider. It runs against the fake backend and the Proxmox
// LXC backend on fakes in `npm test`, and against a live backend with
// `npm run conformance -- --backend <type> --settings <file>`.
//
// Doctor runs first. When it finds a failure, the rest is skipped with its
// summary. Steps a kind does not support are skipped by its declared
// capabilities, never by backend name. A check a run cannot do (Docker in a
// fake box, a desktop stream the test machine cannot reach) is skipped with
// its reason, never passed silently.
//
// The suite is an install of its own, with the ID "conformance". Its last
// checks add a second install on the same backend, and reuse a reference
// where the backend can (018).
//
// Boxes are made at their kind's default size, and one box at another
// preset, which the suite measures in the box (028).

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { after, describe, it } from "node:test";
import {
  BackendError,
  type AcquireHooks,
  type Backend,
  type BackendStorage,
  type BoxIdentity,
  type BoxKind,
  type MachineSize,
  type Capacity,
  type DoctorReport,
  type Guest,
  type ImageBuild,
  type Limit,
  type MachineNature,
  type ReleaseHooks,
  type SnapshotRef,
} from "../../src/backends/types.ts";
import { KIND_INFO } from "../../src/backends/kinds.ts";
import { endOfUtcDay, newSnapshotId } from "../../src/core/snapshot.ts";
import { gpuWhenNotAsked } from "../../src/core/gpu.ts";
import { displayShows } from "../../src/backends/types.ts";
import type { BoxRecord } from "../../src/core/boxes.ts";
import { deviceModel, isTestOffer, type DevicePlatform } from "../../src/core/device.ts";
import { placementOf, type SlotKind } from "../../src/core/device-host.ts";
import { parseDeviceOffer } from "../../src/core/device-parse.ts";
import { connectScript, deviceServerFiles } from "../../src/core/device-delivery.ts";
import { DeviceLink } from "../../src/core/device-link.ts";
import { withTestDevice } from "../../src/backends/index.ts";
import { DeviceServers } from "../../src/plugin/devices.ts";
import { fileURLToPath } from "node:url";
import { Computer } from "../../src/core/computer.ts";
import { DESKTOP_EXITS, command as inBox, driverCommand } from "../../src/core/in-box.ts";
import { McpSession } from "../../src/core/mcp.ts";
import { desktopSize, displayOpener, restoreSize } from "../../src/core/relay.ts";
import { PRESETS, defaultSize, describeSize, kindSizes } from "../../src/core/sizes.ts";
import { quote } from "../../src/transports/process.ts";
import { openRoute } from "../../src/transports/route.ts";
import type { ByteChannel, CommandTransport, DisplaySize, RunResult } from "../../src/transports/types.ts";
import { MemoryStorage } from "../helpers.ts";

export type ConformanceCheck =
  | "arch"
  | "docker"
  | "display"
  | "computer-use"
  /** Running a command in a Mac's desktop session, through sudo and `launchctl asuser` (030). */
  | "desktop-session"
  | "exact-size"
  | "enrol"
  | "stop-start"
  | "recovery"
  | "interrupted"
  | "installs"
  /** Measuring a box's cores, memory and disk in the box. */
  | "size"
  /** Resizing a box live, larger then smaller, and measuring it in the box (061). */
  | "resize"
  /** Booting an iOS Simulator device and running a command in it (047). */
  | "ios-simulator"
  /** Building a small image with the backend's image operations, which needs root in its box (049). */
  | "images"
  | "test-device"
  | "device"
  | "keep"
  | "snapshots";

const KEEP_DAY = "2099-12-30";
const LATER_KEEP_DAY = "2099-12-31";

/** A new Simulator device's first boot is slow (047). */
const SIMULATOR_TIMEOUT_MS = 600_000;

/**
 * Boots the first available iPhone under an iOS runtime, runs `defaults` in
 * it and shuts it down, printing what `defaults` read back (047). The box
 * user's first `simctl` makes Xcode's default devices.
 */
const SIMULATOR_SCRIPT = [
  "set -e",
  `udid=$(xcrun simctl list devices available | awk '/^-- iOS / { ios = 1; next } /^--/ { ios = 0 } ios && /iPhone/ && match($0, /\\([0-9A-F]+-[0-9A-F-]+\\)/) { print substr($0, RSTART + 1, RLENGTH - 2); exit }')`,
  '[ -n "$udid" ] || { echo "no iPhone device under an iOS runtime" >&2; exit 1; }',
  'trap \'xcrun simctl shutdown "$udid" 2>/dev/null\' EXIT',
  'xcrun simctl bootstatus "$udid" -b >/dev/null',
  'xcrun simctl spawn "$udid" defaults write bb-box.conformance said -string ok',
  'xcrun simctl spawn "$udid" defaults read bb-box.conformance said',
].join("\n");

/** Enrolment in a live BB server. */
export interface ConformanceBb {
  /**
   * Runs BB's bootstrap in the box with the box ID as the key. The suite
   * calls it again after a stop and start, as BB Box does (017).
   */
  enrol(box: BoxIdentity, command: CommandTransport, signal: AbortSignal): Promise<void>;
  /** Whether the box's BB machine is connected to the server. */
  connected(box: BoxIdentity, signal: AbortSignal): Promise<boolean>;
}

export interface ConformanceOptions {
  readonly name: string;
  /**
   * Makes the backend for an install. Called again on the same storage to
   * check recovery after a restart, and on new storage with another install
   * ID to check that two installs leave each other's guests alone.
   */
  readonly create: (storage: BackendStorage, installId: string) => Backend | Promise<Backend>;
  readonly storage: BackendStorage;
  /**
   * For a virtual backend that can reuse references: makes the next guest
   * that a new instance on this storage makes take this reference, which is
   * free.
   */
  readonly reuse?: (storage: BackendStorage, ref: string) => Promise<void>;
  /** Kinds to check. All the backend's kinds by default. */
  readonly kinds?: readonly string[];
  /** Checks this run cannot do, with the reason. */
  readonly skip?: Partial<Record<ConformanceCheck, string>>;
  /** Without it, only what enrolment needs in the box is checked. */
  readonly bb?: ConformanceBb;
  /** For each step that talks to the backend. */
  readonly timeoutMs?: number;
  readonly testDevice?: boolean;
}

const THREAD = "thr_conformance";
export const CONFORMANCE_INSTALL = "conformance";
const MiB = 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9-]*$/;
/** After a stop and start, the box is connected to BB again this soon after it is ready (017). */
const RECONNECT_MS = 3_000;
/** Prints the SHA-256 of stdin, on Linux and macOS. */
const SHA256 = "if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -c1-64";
/** Prints the SHA-256 of `path` under the home, on Windows. */
function windowsSha256(path: string): string {
  return `(Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $HOME '${path.replaceAll("'", "''")}')).Hash.ToLower()`;
}
/** The stock editor each OS's desktop has, which the computer-use check opens. */
const EDITOR: Readonly<Record<string, string>> = { linux: "mousepad", macos: "TextEdit", windows: "notepad" };
/** How long an app's window may take to appear, a first start of the app included. */
const WINDOW_WAIT_MS = 20_000;
const MIB_UNITS: readonly Limit["resource"][] = ["memory", "disk", "gpu-memory"];
const RESOURCES: readonly Limit["resource"][] = ["memory", "disk", "cpu", "guests", "gpu-desktops", "gpu-memory", "machines"];

/** The size a box of the kind gets when none is asked for. */
export function sizeOf(kind: string): MachineSize {
  return defaultSize(kindSizes(kind));
}

export function identity(kind: string, size = sizeOf(kind)): BoxIdentity {
  const suffix = randomBytes(3).toString("hex");
  return { boxId: `box_conformance_${suffix}`, threadId: THREAD, name: `conformance-${suffix}`, kind, createdAt: Date.now(), size: { ...size, gpu: gpuWhenNotAsked(kind) } };
}

/** Checks a size a guest reports, which may be null when the backend cannot read it. */
export function checkSize(size: MachineSize | null, what: string): void {
  if (size === null) return;
  assert.ok(Number.isInteger(size.cores) && size.cores > 0, `${what} has whole cores`);
  assert.ok(Number.isInteger(size.memoryMiB) && size.memoryMiB > 0, `${what} has whole MiB of memory`);
  assert.ok(size.diskGiB === null || (Number.isFinite(size.diskGiB) && size.diskGiB > 0), `${what} has a disk size or null`);
}

/**
 * Prints the box's cores, memory in MiB and the disk under its home in MiB:
 * the least of what the OS shows and its cgroup limits, which Docker sets
 * without the OS showing them. On Linux and macOS.
 */
const MEASURE = [
  "cores=$(nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || sysctl -n hw.ncpu)",
  'if [ -r /sys/fs/cgroup/cpu.max ]; then read quota period < /sys/fs/cgroup/cpu.max; if [ "$quota" != max ]; then q=$(( (quota + period - 1) / period )); [ "$q" -ge "$cores" ] || cores=$q; fi; fi',
  "if [ -r /proc/meminfo ]; then memory=$(awk '/^MemTotal:/ { print int($2 / 1024) }' /proc/meminfo); else memory=$(( $(sysctl -n hw.memsize) / 1048576 )); fi",
  'if [ -r /sys/fs/cgroup/memory.max ]; then limit=$(cat /sys/fs/cgroup/memory.max); if [ "$limit" != max ]; then m=$(( limit / 1048576 )); [ "$m" -ge "$memory" ] || memory=$m; fi; fi',
  "disk=$(df -Pk \"$HOME\" | awk 'NR == 2 { print int($2 / 1024) }')",
  'echo "$cores $memory $disk"',
].join("\n");

export function recordingHooks() {
  const events: string[] = [];
  const claimed: Guest[] = [];
  const timings: Record<string, number> = {};
  const hooks: AcquireHooks = {
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
  return { hooks, events, claimed, timings };
}

export function releaseHooks() {
  const events: string[] = [];
  const timings: Record<string, number> = {};
  const hooks: ReleaseHooks = {
    resetting: async () => {
      events.push("resetting");
    },
    timing: (step, ms) => {
      timings[step] = ms;
    },
  };
  return { hooks, events, timings };
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function checkTimings(timings: Record<string, number>): void {
  for (const [step, ms] of Object.entries(timings)) assert.ok(Number.isFinite(ms) && ms >= 0, `timing ${step} is a duration`);
}

/** The first `bytes` bytes a stream server sends, within `timeoutMs`. */
async function greeting(channel: ByteChannel, bytes: number, timeoutMs: number): Promise<string> {
  const reader = channel.readable.getReader();
  const timer = setTimeout(() => void reader.cancel(new Error(`No greeting within ${timeoutMs} ms.`)), timeoutMs);
  let data = Buffer.alloc(0);
  try {
    while (data.length < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      data = Buffer.concat([data, value]);
    }
  } finally {
    clearTimeout(timer);
    reader.releaseLock();
  }
  return data.subarray(0, bytes).toString("latin1");
}

async function until(check: () => Promise<boolean>, timeoutMs: number, what: string, intervalMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail(`${what} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

export function checkKind(kind: BoxKind): void {
  assert.match(kind.id, ID, "kind IDs are lowercase words joined by hyphens");
  assert.ok(kind.label.trim(), `${kind.id} has a label`);
  assert.ok(kind.description.trim(), `${kind.id} has a description`);
  assert.ok(Number.isFinite(kind.readyTimeoutMs) && kind.readyTimeoutMs > 0, `${kind.id} has a ready timeout`);
  const capabilities = kind.capabilities;
  assert.ok(["linux", "windows", "macos"].includes(capabilities.os), `${kind.id} has a known OS`);
  assert.ok(["x86_64", "arm64"].includes(capabilities.arch), `${kind.id} has a known architecture`);
  for (const flag of ["gpu", "enrol"] as const) assert.equal(typeof capabilities[flag], "boolean", `${kind.id}.${flag}`);
  const computerUse = capabilities.computerUse;
  if (computerUse !== null) {
    assert.equal(computerUse.driver, "cua", `${kind.id} names a known computer-use driver`);
    assert.ok(computerUse.version.trim() && computerUse.socket.trim(), `${kind.id} pins the driver's version and names its socket`);
  }
  for (const feature of [...kind.requires, ...capabilities.features]) assert.match(feature, ID, `${kind.id} feature ${feature}`);
  for (const feature of kind.requires) assert.ok(capabilities.features.includes(feature), `${kind.id} has the ${feature} it requires`);
  const command = capabilities.command;
  if (command) {
    assert.ok(command.transport.trim(), `${kind.id} names its command transport`);
    assert.equal(command.shell, capabilities.os === "windows" ? "powershell" : "sh", `${kind.id} scripts are in the OS's shell`);
    for (const flag of ["admin", "inDesktopSession", "streaming"] as const) assert.equal(typeof command[flag], "boolean", `${kind.id}.command.${flag}`);
  }
  const ids = capabilities.displays.map((display) => display.id);
  assert.equal(new Set(ids).size, ids.length, `${kind.id} display IDs are unique`);
  for (const display of capabilities.displays) {
    assert.match(display.id, ID, `${kind.id} display ${display.id}`);
    assert.ok(["rfb", "selkies"].includes(display.protocol), `${kind.id} display ${display.id} has a known protocol`);
    assert.equal(typeof display.resizable, "boolean");
  }
  if (capabilities.enrol) {
    assert.equal(command?.shell, "sh", `${kind.id} enrols, so it runs sh commands`);
    assert.notEqual(capabilities.os, "windows", `${kind.id} enrols, so it is not Windows`);
  }
  if (computerUse) assert.ok(capabilities.displays.length && command, `${kind.id} offers computer use, so it has a display and commands`);
  if (capabilities.features.includes("docker")) assert.ok(command, `${kind.id} has Docker, so it runs commands`);
  if (capabilities.features.includes("ios-simulator")) {
    assert.ok(capabilities.features.includes("xcode") && command?.shell === "sh", `${kind.id} has the iOS Simulator, so it has Xcode and runs sh commands`);
  }
  checkDevice(kind);
}

const DEVICE_HOSTS: Readonly<Record<DevicePlatform, { readonly os: string; readonly arch: string }>> = {
  ios: { os: "macos", arch: "arm64" },
  android: { os: "linux", arch: "x86_64" },
};

export function checkDevice(kind: BoxKind): void {
  const capabilities = kind.capabilities;
  const deviceDisplays = capabilities.displays.filter((display) => displayShows(display) === "device");
  const promised = KIND_INFO[kind.id]?.device ?? null;
  const device = capabilities.device;
  if (device === null) {
    assert.equal(promised, null, `${kind.id} is a ${promised} device kind, so its offer has a device`);
    assert.equal(deviceDisplays.length, 0, `${kind.id} has no device, so no display shows one`);
    return;
  }
  const parsed = parseDeviceOffer(device);
  assert.ok(parsed.ok, `${kind.id}'s device reads back: ${parsed.ok ? "" : parsed.words}`);
  if (promised) assert.equal(device.platform, promised, `${kind.id} offers ${promised} devices`);
  assert.deepEqual({ os: capabilities.os, arch: capabilities.arch }, DEVICE_HOSTS[device.platform], `${kind.id}'s ${device.platform} devices run on their platform's host`);
  for (const offered of device.devices) {
    assert.equal(offered.runtime.platform, device.platform, `${kind.id}'s ${offered.model} runs a ${device.platform} runtime`);
    assert.equal(deviceModel(offered.model).platform, device.platform, `${kind.id}'s ${offered.model} is a ${device.platform} model`);
  }
  assert.equal(deviceDisplays.length, 1, `${kind.id} shows its device in one display`);
  assert.equal(deviceDisplays[0]!.protocol, "selkies", `${kind.id}'s device display is video`);
  assert.equal(deviceDisplays[0]!.resizable, false, `${kind.id}'s device display keeps the device's own size`);
  assert.equal(capabilities.computerUse, null, `${kind.id}'s computer use is the device server's, not Cua's`);
  if (device.platform === "android") assert.equal(capabilities.displays.length, 1, `${kind.id} has no host desktop`);
}

const BACK_WITHIN_MS = 2000;

const FIRST_FRAME_MS = { test: 10_000, real: 120_000 } as const;

export async function testDeviceCase(command: CommandTransport, kind: BoxKind, firstFrameMs: number = FIRST_FRAME_MS.test): Promise<{ readonly helloMs: number; readonly keyframeMs: number; readonly backMs: number }> {
  const os = kind.capabilities.os;
  const offer = kind.capabilities.device!;
  const record = { id: `bx-${kind.id}`, threadId: THREAD, name: `conformance-${kind.id}`, state: "ready", kind: kind.id, capabilities: kind.capabilities, askedDevice: offer.devices[0].model } as unknown as BoxRecord;
  const servers = new DeviceServers({
    boxes: {
      find: async () => record,
      all: async () => [record],
      update: async () => record,
      spawnOwn: async (_box, script) => command.spawn!(inBox(os, script)),
      runOwn: (_box, script, options) => command.run(inBox(os, script, { timeoutMs: options.timeoutMs }), { stdin: options.stdin, timeoutMs: options.timeoutMs + 5_000 }),
    },
    kv: { get: async () => null, set: async () => undefined, delete: async () => undefined },
    files: () => deviceServerFiles(fileURLToPath(new URL("../../", import.meta.url))),
    personHasControl: () => false,
    log: (line) => console.log(`# ${line}`),
    logError: (operation, error) => console.log(`# ${operation}: ${error}`),
  });
  const viewer = async () => DeviceLink.open(await command.spawn!(inBox(os, connectScript())), { role: "viewer", helloWaitMs: 5_000 });
  try {
    const began = Date.now();
    const view = await servers.ensure(record);
    assert.equal(view.is, "connected", `the device's server answers: ${JSON.stringify(view)}`);
    const helloMs = Date.now() - began;
    assert.equal(view.is === "connected" && view.state.model, offer.devices[0].model, "it runs the model asked for");
    const keys: number[] = [];
    const watching = await DeviceLink.open(await command.spawn!(inBox(os, connectScript())), { role: "viewer", onFrame: (frame) => frame[0] === 4 && (frame[1]! & 15) === 1 && keys.push(Date.now()) });
    await watching.send("START_VIDEO");
    await until(async () => keys.length > 0, firstFrameMs, "a first key frame", 20);
    const asked = Date.now();
    await watching.send("REQUEST_KEYFRAME");
    await until(async () => keys.length > 1, 5_000, "a key frame on request", 10);
    const keyframeMs = keys[1]! - asked;
    await watching.close();
    await servers.dispose();
    const killed = await command.run(inBox(os, 'kill -9 "$(cat "$HOME/.bb-box/device/server.pid")"'), { timeoutMs: 10_000 });
    assert.equal(killed.exitCode, 0, `the server was killed: ${killed.stderr}`);
    const down = Date.now();
    let backMs: number | null = null;
    while (Date.now() - down < 15_000) {
      const link = await viewer().catch(() => null);
      if (link) {
        backMs = Date.now() - down;
        await link.close();
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(backMs !== null && backMs <= BACK_WITHIN_MS, `the server is back within ${BACK_WITHIN_MS / 1000} s of being killed: ${backMs ?? "never"} ms`);
    return { helloMs, keyframeMs, backMs: backMs! };
  } finally {
    await servers.dispose();
    await command.run(inBox(os, `f="$HOME/.bb-box/device/current/src/device/bb-box-device.sh"; [ ! -f "$f" ] || sh "$f" stop`), { timeoutMs: 30_000 }).catch(() => undefined);
  }
}

export function checkCapacity(capacity: Capacity, nature: MachineNature): void {
  assert.equal(typeof capacity.ok, "boolean");
  assert.equal(capacity.ok, capacity.message === null, "a message explains a refusal, and only a refusal");
  if (nature === "real") assert.equal(capacity.warm, null, "a real backend has no warm pool");
  if (capacity.warm) {
    for (const value of [capacity.warm.ready, capacity.warm.target]) assert.ok(Number.isInteger(value) && value >= 0, "warm counts");
  }
  assert.ok(capacity.hosts.length > 0, "capacity lists at least one host");
  for (const host of capacity.hosts) {
    assert.ok(host.host.trim(), "each host has a name");
    assert.equal(typeof host.ok, "boolean");
    for (const limit of host.limits) {
      const what = `${host.host} ${limit.resource}${limit.id ? ` ${limit.id}` : ""}`;
      assert.ok(RESOURCES.includes(limit.resource), `${what} is a known resource`);
      assert.equal(limit.unit, MIB_UNITS.includes(limit.resource) ? "MiB" : "count", `${what} unit`);
      assert.ok(limit.id === undefined || limit.id.trim(), `${what} ID`);
      for (const value of [limit.used, limit.reserve]) assert.ok(Number.isFinite(value) && value >= 0, `${what} figures`);
      assert.ok(limit.total === null || (Number.isFinite(limit.total) && limit.total >= 0), `${what} total`);
    }
  }
  if (capacity.hosts.some((host) => host.ok)) assert.ok(capacity.ok, "one more box fits when a host has room");
  if (nature === "real") {
    assert.ok(
      capacity.hosts.some((host) => host.limits.some((limit) => limit.resource === "machines")),
      "a real backend counts its machines",
    );
  }
}

function limitOf(capacity: Capacity, host: string, resource: Limit["resource"]): Limit | undefined {
  return capacity.hosts.find((other) => other.host === host)?.limits.find((limit) => limit.resource === resource);
}

export function checkDoctor(report: DoctorReport): void {
  assert.ok(report.checks.length > 0, "doctor runs at least one check");
  const ids = report.checks.map((check) => check.id);
  assert.equal(new Set(ids).size, ids.length, "check IDs are unique");
  for (const check of report.checks) {
    assert.match(check.id, /^\S+$/, "each check has an ID");
    assert.ok(check.name.trim() && check.detail.trim(), `${check.id} has a name and a detail`);
    assert.ok(["ok", "warn", "fail", "skipped"].includes(check.status), `${check.id} has a known status`);
    if (check.status === "fail" || check.status === "warn") assert.ok(check.fix?.trim(), `${check.id} says how to fix it`);
  }
  assert.equal(report.ok, report.checks.every((check) => check.status !== "fail"), "ok means no check failed");
  assert.ok(report.summary.trim(), "doctor has a summary");
  for (const note of report.notes) assert.equal(typeof note, "string");
}

function describeDoctor(report: DoctorReport): string {
  const lines = report.checks.map((check) => `${check.status} ${check.name}: ${check.detail}${check.fix ? ` Fix: ${check.fix}` : ""}`);
  return [`doctor: ${report.summary}`, ...lines].join("\n");
}

export async function conformance(options: ConformanceOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 180_000;
  const skip = options.skip ?? {};
  const signal = () => AbortSignal.timeout(timeout);
  const backend = await options.create(options.storage, CONFORMANCE_INSTALL);
  const doctor = await backend.doctor(signal()).catch((error: unknown) => (error instanceof Error ? error : new Error(String(error))));
  // After the doctor, as a pool's Macs offer xcode only once a survey has found it (047).
  const kinds = backend.kinds().filter((kind) => !options.kinds || options.kinds.includes(kind.id));
  const blocked = doctor instanceof Error ? `doctor threw: ${doctor.message}` : doctor.ok ? false : `doctor found a failure: ${doctor.summary}`;
  /** Guests this run acquired and has not released. */
  const outstanding = new Map<string, Guest>();
  const others: Backend[] = [];

  const acquire = async (box: BoxIdentity, hooks: AcquireHooks) => {
    const guest = await backend.acquire(box, null, hooks, signal());
    outstanding.set(guest.ref, guest);
    return guest;
  };
  const release = async (target: Backend, guest: Guest) => {
    const recorded = releaseHooks();
    await target.release(guest, recorded.hooks, signal());
    outstanding.delete(guest.ref);
    checkTimings(recorded.timings);
    if (target.nature === "real") assert.deepEqual(recorded.events, ["resetting"], "a real backend records the reset before it starts");
  };
  /** A virtual guest is gone after release; a real one is back in the pool. Either way no box holds it. */
  const assertReleased = async (target: Backend, guest: Guest, generation: number | null = null) => {
    const held = await target.held(signal());
    assert.equal(held.find((other) => other.ref === guest.ref), undefined, `${guest.ref} is no longer held`);
    if (target.nature === "virtual") assert.equal(await target.power(guest, signal()), null, `${guest.ref} no longer exists`);
    const member = (await target.members?.(signal()))?.find((other) => other.ref === guest.ref);
    if (member) {
      assert.equal(member.state, "free", `${guest.ref} is free again`);
      if (generation !== null) assert.ok(member.generation > generation, `${guest.ref} was reset`);
    }
  };
  const generationOf = async (guest: Guest) => (await backend.members?.(signal()))?.find((other) => other.ref === guest.ref)?.generation ?? null;

  describe(`${options.name} conformance`, { timeout: timeout * 20 }, () => {
    after(async () => {
      for (const guest of outstanding.values()) await backend.release(guest, releaseHooks().hooks).catch(() => undefined);
      for (const other of others) await other.dispose?.();
      await backend.dispose?.();
    });

    it("doctor reports a working setup", () => {
      if (doctor instanceof Error) throw doctor;
      checkDoctor(doctor);
      assert.equal(doctor.ok, true, describeDoctor(doctor));
    });

    describe("with a working setup", { skip: blocked }, () => {
      it("describes its kinds", () => {
        assert.ok(["virtual", "real"].includes(backend.nature));
        assert.ok(backend.id && backend.label, "the backend has an ID and a label");
        if (backend.nature === "real") assert.ok(backend.restores === "home" || backend.restores === "machine", "a real backend says what a release restores");
        assert.ok(backend.kinds().length > 0, "the backend offers at least one kind");
        const ids = backend.kinds().map((kind) => kind.id);
        assert.equal(new Set(ids).size, ids.length, "kind IDs are unique");
        for (const kind of backend.kinds()) checkKind(kind);
      });

      it("reports capacity for each kind", { timeout }, async () => {
        for (const kind of kinds) {
          const capacity = await backend.capacity(kind.id, sizeOf(kind.id), [], signal());
          checkCapacity(capacity, backend.nature);
          assert.ok(capacity.ok, `${kind.id}: ${capacity.message}`);
        }
      });

      it("lists its pool members", { timeout, skip: backend.members ? false : "the backend has no pool" }, async () => {
        const members = await backend.members!(signal());
        for (const member of members) {
          assert.ok(member.ref, "each member has a ref");
          assert.ok(["free", "held", "resetting", "out-of-service"].includes(member.state), `${member.ref} has a known state`);
          assert.equal(member.reason !== null, member.state === "out-of-service", `${member.ref} has a reason only when out of service`);
          assert.ok(Number.isInteger(member.generation) && member.generation >= 0, `${member.ref} has a generation`);
        }
      });

      it("refuses a kind it does not have", async () => {
        await assert.rejects(
          backend.acquire(identity("no-such-kind"), null, recordingHooks().hooks, signal()),
          (error: unknown) => error instanceof BackendError && error.code === "unsupported",
        );
      });

      for (const kind of kinds) {
        describe(kind.id, () => {
          const box = identity(kind.id);
          const capabilities = kind.capabilities;
          let guest: Guest | null = null;
          let generation: number | null = null;
          let command: CommandTransport | null = null;
          let enrolled = false;
          /** When the box answered again after the stop and start step. */
          let restartedAt: number | null = null;
          const posix = capabilities.os !== "windows";
          const scripts = posix ? false : "Windows scripts are not in the suite yet";
          const need = () => {
            assert.ok(guest && command, "the box was acquired");
            return { guest, command };
          };

          it("acquires a box, recording the guest before it changes anything", { timeout }, async () => {
            const recorded = recordingHooks();
            const started = Date.now();
            guest = await acquire(box, recorded.hooks);
            assert.ok(recorded.claimed.length >= 1, "claim ran");
            assert.equal(recorded.events[0], "claim", "claim ran first");
            assert.equal(recorded.events.filter((event) => event === "starting").length, 1, "starting ran once");
            // Its size may be read only once it is made.
            assert.deepEqual({ ...recorded.claimed.at(-1), size: null }, { ...guest, size: null }, "the guest is the last one claimed");
            assert.ok(guest.host === null || guest.host.trim(), "the guest's host is a name or null");
            checkSize(guest.size, "the guest");
            for (const fact of guest.facts ?? []) assert.ok(fact.label.trim() && typeof fact.value === "string", "a fact has a label and a value");
            for (const value of Object.values(guest.data ?? {})) assert.ok(["string", "number", "boolean"].includes(typeof value), "guest data is plain values");
            checkTimings(recorded.timings);
            const held = (await backend.held(signal())).find((other) => other.ref === guest!.ref);
            assert.ok(held, "held lists the new box");
            assert.equal(held.owner?.boxId, box.boxId, "held names the box that owns it");
            assert.equal(held.owner?.threadId, box.threadId);
            assert.equal(held.host, guest.host);
            checkSize(held.size, "the held guest");
            assert.equal(await backend.power(guest, signal()), "running");
            const member = (await backend.members?.(signal()))?.find((other) => other.ref === guest!.ref);
            if (backend.members) assert.equal(member?.state, "held", "the pool shows the machine held");
            generation = await generationOf(guest);
            console.log(`# ${options.name} ${kind.id}: ready in ${Date.now() - started} ms ${JSON.stringify(recorded.timings)}`);
          });

          it("gives the transports the kind declares", { timeout }, async () => {
            assert.ok(guest, "the box was acquired");
            const transports = await backend.transports(guest, kind.id);
            assert.deepEqual(
              transports.displays.map((display) => [display.id, display.protocol, display.resizable]),
              capabilities.displays.map((display) => [display.id, display.protocol, display.resizable]),
              "the displays match the kind",
            );
            for (const display of transports.displays) {
              assert.ok(display.label.trim(), `display ${display.id} has a label`);
              if (display.resize) assert.ok(display.resizable, `display ${display.id} can resize, so it says it is resizable`);
            }
            if (transports.access) {
              const ssh = transports.access.ssh;
              if (ssh) assert.ok(ssh.host && ssh.user && Number.isInteger(ssh.port), "SSH access names a host, port and user");
              assert.ok(transports.access.dockerHost === null || transports.access.dockerHost.trim(), "a Docker host is a URL or null");
            }
            if (!capabilities.command) {
              assert.equal(transports.command, null);
              return;
            }
            assert.ok(transports.command, "a kind with a command transport gets one");
            assert.equal(await transports.command.probe(signal()), true);
            command = transports.command;
          });

          it("spawns a command whose stdin and stdout are a channel", { timeout }, async (t) => {
            const { command } = need();
            if (!command.spawn) {
              assert.equal(capabilities.computerUse, null, `${kind.id} offers computer use, so its command transport can spawn the driver`);
              return t.skip("the command transport cannot spawn");
            }
            // PowerShell's cat reads files, not stdin.
            const echo = posix ? "cat" : 'while ($null -ne ($line = [Console]::In.ReadLine())) { [Console]::Out.Write("$line`n") }';
            const channel = await command.spawn(echo, signal());
            try {
              const writer = channel.writable.getWriter();
              await writer.write(new TextEncoder().encode("ping\n"));
              assert.equal(await greeting(channel, 5, 10_000), "ping\n");
              await writer.close();
            } finally {
              await channel.close();
            }
          });

          it("runs a command with stdin, exit codes and a timeout", { timeout, skip: scripts }, async () => {
            const { command } = need();
            const echoed = await command.run("cat; echo; echo to-stderr >&2; exit 3", { stdin: "hello from stdin", timeoutMs: 30_000 });
            assert.equal(echoed.exitCode, 3);
            assert.equal(echoed.stdout, "hello from stdin\n");
            assert.equal(echoed.stderr, "to-stderr\n");
            assert.equal(echoed.timedOut, false);
            const input = randomBytes(MiB);
            const digest = await command.run(SHA256, { stdin: input, timeoutMs: 60_000 });
            assert.equal(digest.exitCode, 0, digest.stderr);
            assert.equal(digest.stdout.trim(), sha256(input), "1 MiB of stdin arrives intact");
            const slow = await command.run("sleep 30", { timeoutMs: 500 });
            assert.equal(slow.timedOut, true);
            assert.ok(slow.durationMs < 10_000);
          });

          it("runs the OS and architecture it declares", { timeout, skip: skip.arch ?? scripts }, async () => {
            const { command } = need();
            const uname = await command.run("uname -s", { timeoutMs: 30_000 });
            assert.equal(uname.exitCode, 0);
            assert.equal(uname.stdout.trim(), capabilities.os === "macos" ? "Darwin" : "Linux");
            const machine = (await command.run("uname -m", { timeoutMs: 30_000 })).stdout.trim();
            assert.equal(machine === "aarch64" ? "arm64" : machine === "amd64" ? "x86_64" : machine, capabilities.arch);
          });

          it("streams output as it arrives", { timeout, skip: scripts }, async () => {
            const { command } = need();
            const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
            const text = { stdout: "", stderr: "" };
            const started = Date.now();
            let first: number | null = null;
            const result = await command.stream("echo early; sleep 1; echo late >&2; exit 4", {
              onOutput: (chunk, from) => {
                assert.ok(chunk instanceof Uint8Array, "output arrives as bytes");
                first ??= Date.now() - started;
                text[from] += decoders[from].decode(chunk, { stream: true });
              },
              timeoutMs: 30_000,
            });
            assert.equal(result.exitCode, 4);
            assert.equal(text.stdout, "early\n");
            assert.equal(text.stderr, "late\n");
            if (capabilities.command?.streaming) assert.ok(first !== null && first < Date.now() - started - 500, "output arrived before the command ended");
          });

          it("copies 32 MiB in and out byte for byte", { timeout }, async () => {
            const { command } = need();
            const data = randomBytes(32 * MiB);
            data[0] = 0;
            data[1] = 255;
            const path = `bb-box-conformance/dir with space/it's ${box.name}.bin`;
            await command.writeFile(path, data, { mode: "0600", signal: signal() });
            const inBox = await command.run(posix ? `cd "$HOME" && cat -- ${quote(path)} | ${SHA256}` : windowsSha256(path), { timeoutMs: 60_000 });
            assert.equal(inBox.stdout.trim(), sha256(data), "the file in the box matches");
            const make = posix
              ? `cd "$HOME" && head -c ${32 * MiB} /dev/urandom > bb-box-conformance/out.bin && cat bb-box-conformance/out.bin | ${SHA256}`
              : `$b = [byte[]]::new(${32 * MiB}); [Random]::new().NextBytes($b); [IO.File]::WriteAllBytes((Join-Path $HOME 'bb-box-conformance/out.bin'), $b); ${windowsSha256("bb-box-conformance/out.bin")}`;
            const out = await command.run(make, { timeoutMs: 60_000 });
            assert.equal(out.exitCode, 0, out.stderr);
            const read = await command.readFile("bb-box-conformance/out.bin", { maxBytes: 32 * MiB, signal: signal() });
            assert.equal(read.length, 32 * MiB);
            assert.equal(sha256(read), out.stdout.trim(), "the file read out matches");
            await assert.rejects(command.readFile(path, { maxBytes: 10 }), /larger than 10 bytes/);
            if (posix) {
              const mode = await command.run(`cd "$HOME" && (stat -c %a ${quote(path)} 2>/dev/null || stat -f %Lp ${quote(path)})`);
              assert.equal(mode.stdout.trim(), "600");
            }
            await command.run(posix ? 'cd "$HOME" && rm -rf bb-box-conformance' : "Remove-Item -LiteralPath (Join-Path $HOME 'bb-box-conformance') -Recurse -Force");
          });

          if (capabilities.enrol) {
            it("has what enrolment needs", { timeout, skip: skip.enrol ?? scripts }, async () => {
              const { command } = need();
              const result = await command.run(
                "command -v sh && command -v tar && (command -v curl || command -v wget) && mkdir -p .cache && test -w .cache",
                { timeoutMs: 30_000 },
              );
              assert.equal(result.exitCode, 0, `the box needs sh, tar, curl or wget and a writable home: ${result.stderr}`);
            });

            it("enrols in BB", { timeout, skip: skip.enrol ?? (options.bb ? false : "needs a live BB server") }, async () => {
              const { command } = need();
              await options.bb!.enrol(box, command, signal());
              await until(() => options.bb!.connected(box, signal()), timeout, "the box connects to BB");
              enrolled = true;
            });
          }

          if (capabilities.features.includes("docker")) {
            it("runs Docker", { timeout, skip: skip.docker ?? false }, async () => {
              const { command } = need();
              const result = await command.run("docker version --format '{{.Server.Version}}'", { timeoutMs: 60_000 });
              assert.equal(result.exitCode, 0, `docker: ${result.stderr}`);
              assert.match(result.stdout.trim(), /^\d+\./);
            });
          }

          if (capabilities.features.includes("ios-simulator")) {
            const limit = Math.max(timeout, SIMULATOR_TIMEOUT_MS);
            it("boots an iOS Simulator device and runs a command in it", { timeout: limit, skip: skip["ios-simulator"] ?? false }, async () => {
              const { command } = need();
              const started = Date.now();
              const result = await command.run(SIMULATOR_SCRIPT, { timeoutMs: limit });
              assert.equal(result.exitCode, 0, `the Simulator: ${result.stderr}`);
              assert.equal(result.stdout.trim(), "ok", "defaults in the Simulator reads back what it wrote");
              console.log(`# ${options.name} ${kind.id}: an iOS Simulator device booted and ran a command in ${Date.now() - started} ms`);
            });
          }

          const withDevice = withTestDevice(kind);
          if (withDevice.capabilities.device && !capabilities.device) {
            it("serves the test device: delivered, says hello, gives a key frame on request, and is back within 2 s of being killed (063)", { timeout: Math.max(timeout, 120_000), skip: skip["test-device"] ?? (options.testDevice ? false : "the run does not turn the test device on") }, async () => {
              const { command } = need();
              const measured = await testDeviceCase(command, withDevice);
              console.log(`# ${options.name} ${kind.id}: the test device's server said hello ${measured.helloMs} ms after its delivery began, gave a key frame ${measured.keyframeMs} ms after it was asked, and said hello again ${measured.backMs} ms after it was killed`);
            });
          }

          if (capabilities.device && !isTestOffer(capabilities.device)) {
            it("serves its device: delivered, says hello, streams a key frame, gives one on request, and is back within 2 s of being killed (063, 4.2)", { timeout: Math.max(timeout, 300_000), skip: skip.device ?? false }, async () => {
              const { command } = need();
              const measured = await testDeviceCase(command, kind, FIRST_FRAME_MS.real);
              console.log(`# ${options.name} ${kind.id}: the ${capabilities.device!.devices[0].model}'s server said hello ${measured.helloMs} ms after its delivery began, gave a key frame ${measured.keyframeMs} ms after it was asked, and said hello again ${measured.backMs} ms after it was killed`);
            });
          }

          for (const capability of capabilities.displays) {
            const unsupported = capability.protocol === "rfb" ? false : `the suite cannot check ${capability.protocol} yet`;
            it(`serves the ${capability.id} display`, { timeout, skip: skip.display ?? unsupported }, async () => {
              assert.ok(guest, "the box was acquired");
              const display = (await backend.transports(guest, kind.id)).displays.find((other) => other.id === capability.id);
              assert.ok(display, `the box has the ${capability.id} display`);
              const { route, auth } = await display.open(signal());
              assert.ok(["none", "vnc-password", "apple"].includes(auth.type), "the display's auth is known");
              const channel = await openRoute(route, signal());
              try {
                assert.match(await greeting(channel, 12, 10_000), /^RFB \d{3}\.\d{3}\n$/);
              } finally {
                await channel.close();
              }
            });

            it(`takes the ${capability.id} display's input through its own channel, when its stream server ignores a viewer's (#406)`, { timeout, skip: skip.display ?? unsupported }, async (t) => {
              assert.ok(guest, "the box was acquired");
              const display = (await backend.transports(guest, kind.id)).displays.find((other) => other.id === capability.id);
              assert.ok(display, `the box has the ${capability.id} display`);
              const { input: openInput } = await display.open(signal());
              if (!openInput) return t.skip("the stream server takes a viewer's input itself");
              const started = Date.now();
              const input = await openInput({}, signal());
              const opened = Date.now() - started;
              try {
                await input.size(1024, 768);
                // A pointer move, then a ping that returns once the move is posted: the time per event.
                const times: number[] = [];
                for (let i = 0; i < 20; i++) {
                  const sent = performance.now();
                  await input.pointer(0, 400 + i, 300);
                  await input.ping();
                  times.push(performance.now() - sent);
                }
                times.sort((a, b) => a - b);
                console.log(`# ${options.name} ${kind.id}: input opened in ${opened} ms; an event to the box and back takes ${times[10]!.toFixed(1)} ms (median of 20), at most ${times[19]!.toFixed(1)} ms`);
              } finally {
                await input.close();
              }
            });

            it(`resizes the ${capability.id} display through the backend`, { timeout, skip: skip.display ?? unsupported }, async (t) => {
              assert.ok(guest, "the box was acquired");
              const display = (await backend.transports(guest, kind.id)).displays.find((other) => other.id === capability.id);
              assert.ok(display, `the box has the ${capability.id} display`);
              if (!display.resize) return t.skip("the display's stream server sets its size");
              // As core does: SetDesktopSize, then resize, which may do nothing if
              // the stream server took it. Then a new connection's ServerInit gives
              // the size (021). Screen 0 is noVNC's before the server names one.
              const open = displayOpener(display);
              const set = async (size: DisplaySize) => {
                await restoreSize(open, size, { id: 0, flags: 0 });
                await display.resize!(size, signal());
              };
              const before = await desktopSize(open);
              const wanted = { width: before.width + 128, height: before.height + 64 };
              try {
                await set(wanted);
                assert.deepEqual(await desktopSize(open), wanted);
              } finally {
                await set(before);
              }
              assert.deepEqual(await desktopSize(open), before);
            });
          }

          if (capabilities.os === "macos" && capabilities.displays.length && !capabilities.command?.inDesktopSession) {
            // The desktop session may come up after the box answers.
            it("runs a desktop command in the Aqua session, with stdin, stderr apart from stdout, and its exit status", { timeout, skip: skip["desktop-session"] ?? scripts }, async () => {
              const { command } = need();
              const script = inBox(capabilities.os, "launchctl managername; cat; echo; echo to-stderr >&2; exit 5", { session: "desktop" });
              const deadline = Date.now() + 20_000;
              let result = await command.run(script, { stdin: "hello from stdin", timeoutMs: 30_000 });
              while (result.exitCode === DESKTOP_EXITS.noSession && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, 1_000));
                result = await command.run(script, { stdin: "hello from stdin", timeoutMs: 30_000 });
              }
              assert.equal(result.exitCode, 5, result.stderr);
              assert.equal(result.stdout, "Aqua\nhello from stdin\n", "the command runs in the Aqua session and reads stdin");
              assert.equal(result.stderr, "to-stderr\n", "stderr stays apart from stdout");
            });
          }

          if (capabilities.os === "windows" && capabilities.displays.length && !capabilities.command?.inDesktopSession) {
            it("runs a desktop command in the user's session, unelevated, with stdin, stderr apart from stdout, and its exit status", { timeout, skip: skip["desktop-session"] }, async () => {
              const { command } = need();
              // S-1-16-8192 is the medium integrity level, an unelevated process's.
              const source = "(Get-Process -Id $PID).SessionId; [bool](whoami /groups | Select-String 'S-1-16-8192'); [Console]::In.ReadToEnd(); [Console]::Error.WriteLine('to-stderr'); exit 5";
              const result = await command.run(inBox(capabilities.os, source, { session: "desktop" }), { stdin: "hello from stdin", timeoutMs: 30_000 });
              assert.equal(result.exitCode, 5, result.stderr);
              const [session, medium, stdin] = result.stdout.split(/\r?\n/);
              assert.match(session ?? "", /^[1-9]\d*$/, "the command runs in a desktop's session, not in services' session 0");
              assert.deepEqual([medium, stdin], ["True", "hello from stdin"], "it runs unelevated and reads stdin");
              assert.equal(result.stderr.replaceAll("\r\n", "\n"), "to-stderr\n", "stderr stays apart from stdout");
            });
          }

          const computerUse = capabilities.computerUse;
          if (computerUse) {
            // The driver's daemon starts with the desktop session, which may come up after the box answers.
            it("offers computer use: the driver answers over MCP and lists the desktop's windows", { timeout, skip: skip["computer-use"] }, async () => {
              const { command } = need();
              assert.ok(command.spawn, "the command transport can spawn the driver");
              const deadline = Date.now() + 20_000;
              for (;;) {
                const channel = await command.spawn(driverCommand(capabilities.os, computerUse.socket), signal());
                let windows: unknown;
                let problem: string;
                try {
                  const session = await McpSession.open(channel, { client: { name: "bb-box-conformance", version: "1" }, timeoutMs: 20_000 });
                  try {
                    const listed = await session.call("list_windows", {}, { timeoutMs: 20_000 });
                    windows = listed.structuredContent?.windows;
                    problem = listed.isError ? listed.content.map((part) => part.text ?? "").join(" ") : "";
                  } finally {
                    await session.close();
                  }
                } catch (error) {
                  problem = error instanceof Error ? error.message : String(error);
                }
                if (!problem && Array.isArray(windows)) return;
                if (Date.now() > deadline) assert.fail(`the driver did not list the windows: ${problem || "no windows array"}`);
                await new Promise((resolve) => setTimeout(resolve, 1_000));
              }
            });

            // As computer_launch does. An app reaches the desktop's display only
            // when the box is as its desktop needs, also after the backend named
            // it: a Linux display's X cookie is looked up by the hostname.
            const editor = EDITOR[capabilities.os];
            it(`opens an app, ${editor}, whose window appears on the desktop`, { timeout, skip: skip["computer-use"] ?? (editor ? false : `no stock app is known for ${capabilities.os}`) }, async () => {
              const { command } = need();
              const channel = await command.spawn!(driverCommand(capabilities.os, computerUse.socket), signal());
              const session = await McpSession.open(channel, { client: { name: "bb-box-conformance", version: "1" }, timeoutMs: 20_000 });
              try {
                const windows = async () => {
                  const listed = await session.call("list_windows", {}, { timeoutMs: 20_000 });
                  assert.ok(!listed.isError, listed.content.map((part) => part.text ?? "").join(" "));
                  const all = (listed.structuredContent?.windows ?? []) as { window_id?: number; pid?: number; width?: number; height?: number; bounds?: { width?: number; height?: number } }[];
                  return all.filter((window) => (window.bounds?.width ?? window.width ?? 0) > 1 && (window.bounds?.height ?? window.height ?? 0) > 1);
                };
                const before = await windows();
                const launched = await session.call("launch_app", { name: editor! }, { timeoutMs: 30_000 });
                assert.ok(!launched.isError, `the driver could not open ${editor}: ${launched.content.map((part) => part.text ?? "").join(" ")}`);
                const deadline = Date.now() + WINDOW_WAIT_MS;
                const isNew = (window: { window_id?: number }) => !before.some((old) => old.window_id === window.window_id);
                let opened = (await windows()).filter(isNew);
                while (!opened.length) {
                  if (Date.now() > deadline) assert.fail(`${editor} opened, but no new window appeared within ${WINDOW_WAIT_MS / 1000} s`);
                  await new Promise((resolve) => setTimeout(resolve, 500));
                  opened = (await windows()).filter(isNew);
                }
                // The next check opens the app again, which a single-instance
                // app, such as Mousepad, would hand to this one. Its process
                // goes, unless it had windows before. Closing it is only
                // tidying, so a driver that cannot says so and no more.
                const pids = new Set<number>();
                for (const pid of new Set(opened.map((window) => window.pid))) {
                  if (pid === undefined || before.some((old) => old.pid === pid)) continue;
                  const killed = await session.call("kill_app", { pid }, { timeoutMs: 20_000 });
                  if (killed.isError) console.log(`# ${options.name} ${kind.id}: the driver could not close ${editor}: ${killed.content.map((part) => part.text ?? "").join(" ")}`);
                  else pids.add(pid);
                }
                const gone = Date.now() + 5_000;
                while ((await windows()).some((window) => window.pid !== undefined && pids.has(window.pid))) {
                  if (Date.now() > gone) assert.fail(`${editor}'s window is still open 5 s after the driver closed it`);
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              } finally {
                await session.close();
              }
            });

            // As computer_launch, computer_type and computer_observe do.
            // Where the desktop takes input only in the foreground, as on
            // Wayland, the typing goes there (048).
            it(`types into ${editor} as the computer tools do, and reads the text back`, { timeout, skip: skip["computer-use"] ?? (editor ? false : `no stock app is known for ${capabilities.os}`) }, async () => {
              const { command } = need();
              const computer = new Computer({
                spawn: (_box, script, signal) => command.spawn!(script, signal),
                owner: () => "agent",
                takeBack: async () => false,
                logError: () => {},
                launchWaitMs: WINDOW_WAIT_MS,
              });
              // The computer tools read only these of a box's record.
              const record = { id: box.boxId, name: box.name, kind: kind.id, capabilities } satisfies Pick<BoxRecord, "id" | "name" | "kind" | "capabilities"> as BoxRecord;
              try {
                const opened = await computer.launch(record, { app: editor! }, signal());
                const window = Number(/computer_observe with window (\d+)/.exec(opened.hints.join("\n"))?.[1]);
                assert.ok(window, opened.text);
                const word = `conformance${randomBytes(3).toString("hex")}`;
                const typed = await computer.type(record, { window, text: word }, signal());
                console.log(`# ${options.name} ${kind.id}: ${typed.text.split("\n")[0]}`);
                // The app may take in the last keys a moment after the driver sent them.
                const deadline = Date.now() + 5_000;
                for (;;) {
                  const tree = (await computer.observe(record, { window, query: word }, signal())).text;
                  if (tree.split("\n\n")[1]?.includes(word)) break;
                  if (Date.now() > deadline) assert.fail(`${editor}'s tree does not show the text typed into it:\n${tree}`);
                  await new Promise((resolve) => setTimeout(resolve, 250));
                }
              } finally {
                await computer.dispose();
              }
            });
          }

          const stopStart = skip["stop-start"] ?? (backend.start && backend.stop ? false : "the backend cannot stop and start its boxes");
          it("stops and starts", { timeout, skip: stopStart }, async () => {
            const { guest } = need();
            await backend.stop!(guest, signal());
            assert.equal(await backend.power(guest, signal()), "stopped");
            await backend.start!(guest, signal());
            assert.equal(await backend.power(guest, signal()), "running");
            const { command } = await backend.transports(guest, kind.id);
            if (command) {
              assert.equal(await command.probe(signal()), true);
              // A VM resumed from disk keeps the time it stopped at, unless the backend sets it (039).
              const before = Date.now();
              const result = await command.run(posix ? "date +%s000" : "[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()", { timeoutMs: 30_000, signal: signal() });
              const off = Number(result.stdout.trim()) - before;
              assert.ok(off > -5_000 && off < Date.now() - before + 5_000, `the box's clock is within 5 s of the host's, not ${off} ms off`);
            }
            restartedAt = Date.now();
          });

          it("reconnects to BB within 3 s of being ready after a stop and start", { timeout, skip: stopStart || (options.bb && capabilities.enrol ? false : "needs a live BB server") }, async (t) => {
            if (!enrolled) return t.skip("the box did not enrol");
            if (restartedAt === null) return t.skip("the box did not stop and start");
            const { command } = need();
            // BB Box starts BB's daemon again with the same key after a start.
            await options.bb!.enrol(box, command, signal());
            await until(() => options.bb!.connected(box, signal()), Math.max(0, restartedAt + RECONNECT_MS - Date.now()), "the box reconnects to BB", 100);
          });

          const offer = backend.snapshotting?.(kind.id) ?? null;
          const keeps = skip.keep ?? (offer?.keepsPastRelease === "as-is" && backend.snapshot && backend.labelKept && backend.heldSnapshots && backend.deleteSnapshot ? false : "the kind keeps no snapshot as it is past its box's release");
          const restoresAsNewGuest = skip.snapshots ?? (offer?.restore === "new-guest" && backend.snapshot && backend.adoptSnapshot && backend.powerOff && backend.start && backend.heldSnapshots && backend.deleteSnapshot ? false : "the kind restores no snapshot as a new guest");
          const SNAPSHOT_FILE = "conformance-snapshot.txt";
          const quietly = { submitting: async () => {}, task: async () => {} };

          it("takes a snapshot, makes a new guest of the box from it with what the box held then, puts the box back, and deletes the snapshot", { timeout, skip: restoresAsNewGuest }, async () => {
            const { guest, command } = need();
            const id = newSnapshotId((bytes) => randomBytes(bytes));
            await command.run(`echo A > "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });

            await backend.snapshot!(guest, { id, box: box.boxId, memory: false, forkSafe: offer?.forkSafeFrom ?? 9 }, quietly, signal());
            const listed = (await backend.heldSnapshots!(signal())).find((held) => held.id === id);
            assert.equal(listed?.state, "complete", "the provider lists the snapshot it took, complete");
            const ref: SnapshotRef = { id, ref: listed.ref, guest: listed.guest };
            await command.run(`echo B > "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });

            await backend.powerOff!(guest, signal());
            const fresh = await backend.adoptSnapshot!(ref, box, { macs: {}, smbios: null }, { ...quietly, claimed: async () => {} }, signal());
            await backend.start!(fresh, signal());
            const then = await (await backend.transports(fresh, kind.id)).command!.run(`cat "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });
            assert.equal(then.stdout.trim(), "A", "the new guest holds what the box held at the snapshot");

            await backend.release(fresh, releaseHooks().hooks, signal());
            await backend.start!(guest, signal());
            const now = await command.run(`cat "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });
            assert.equal(now.stdout.trim(), "B", "releasing the new guest put the box back as it was, as a restore that goes back does");
            assert.equal(await backend.power(guest, signal()), "running");

            await backend.deleteSnapshot!(ref, quietly, signal());
            assert.equal((await backend.heldSnapshots!(signal())).some((held) => held.id === id), false, "gone once deleted");
          });

          const restoresInPlace = skip.snapshots ?? (offer?.restore === "in-place" && backend.snapshot && backend.rollbackSnapshot && backend.powerOff && backend.start && backend.heldSnapshots && backend.deleteSnapshot ? false : "the kind restores no snapshot in place");

          it("takes a snapshot, restores the box to it in place after an undo, restores the undo, and deletes both", { timeout, skip: restoresInPlace }, async () => {
            const { guest, command } = need();
            const id = newSnapshotId((bytes) => randomBytes(bytes));
            const undoId = newSnapshotId((bytes) => randomBytes(bytes));
            const contents = async () => (await (await backend.transports(guest, kind.id)).command!.run(`cat "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() })).stdout.trim();
            const listedRef = async (snapshot: string): Promise<SnapshotRef> => {
              const listed = (await backend.heldSnapshots!(signal())).find((held) => held.id === snapshot);
              assert.equal(listed?.state, "complete", "the provider lists the snapshot it took, complete");
              return { id: snapshot, ref: listed.ref, guest };
            };
            const restoreTo = async (ref: SnapshotRef) => {
              await backend.powerOff!(guest, signal());
              await backend.rollbackSnapshot!(guest, ref, quietly, signal());
              await backend.start!(guest, signal());
            };
            await command.run(`echo A > "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });
            await backend.snapshot!(guest, { id, box: box.boxId, memory: false, forkSafe: offer?.forkSafeFrom ?? 9 }, quietly, signal());
            const ref = await listedRef(id);
            await command.run(`echo B > "$HOME/${SNAPSHOT_FILE}"`, { timeoutMs: 30_000, signal: signal() });

            await backend.powerOff!(guest, signal());
            await backend.snapshot!(guest, { id: undoId, box: box.boxId, memory: false, forkSafe: offer?.forkSafeFrom ?? 9 }, quietly, signal());
            await backend.rollbackSnapshot!(guest, ref, quietly, signal());
            await backend.start!(guest, signal());
            assert.equal(await contents(), "A", "the box holds what it held at the snapshot");
            assert.equal(await backend.power(guest, signal()), "running");

            await restoreTo(await listedRef(undoId));
            assert.equal(await contents(), "B", "the undo puts back what the box held before the restore");

            for (const each of [ref, await listedRef(undoId)]) await backend.deleteSnapshot!(each, quietly, signal());
            const left = (await backend.heldSnapshots!(signal())).filter((held) => held.id === id || held.id === undoId);
            assert.deepEqual(left, [], "both gone once deleted");
          });

          let kept: SnapshotRef | null = null;
          const keptUntil = async (target: Backend, id: string) => (await target.heldSnapshots!(signal())).find((held) => held.id === id)?.keptUntil;

          it("writes a keep date on a snapshot, moves it and takes it off, and a new instance on empty storage reads it from the provider", { timeout, skip: keeps }, async () => {
            const { guest } = need();
            const id = newSnapshotId((bytes) => randomBytes(bytes));
            const taken = await backend.snapshot!(guest, { id, box: box.boxId, memory: false, forkSafe: offer?.forkSafeFrom ?? 9 }, { submitting: async () => {}, task: async () => {} }, signal());
            const listed = (await backend.heldSnapshots!(signal())).find((held) => held.id === id);
            assert.ok(listed, "the provider lists the snapshot it took");
            assert.ok(taken.ref, "the take names its snapshot");
            const ref: SnapshotRef = { id, ref: listed.ref, guest: listed.guest };

            await backend.labelKept!(ref, KEEP_DAY, signal());
            assert.equal(await keptUntil(backend, id), endOfUtcDay(KEEP_DAY));

            await backend.labelKept!(ref, LATER_KEEP_DAY, signal());
            assert.equal(await keptUntil(backend, id), endOfUtcDay(LATER_KEEP_DAY), "a new date replaces the old one");

            await backend.labelKept!(ref, null, signal());
            assert.equal(await keptUntil(backend, id), null, "taken off");

            await backend.labelKept!(ref, KEEP_DAY, signal());
            const fresh = await options.create(new MemoryStorage(), CONFORMANCE_INSTALL);
            others.push(fresh);
            assert.equal(await keptUntil(fresh, id), endOfUtcDay(KEEP_DAY), "the provider holds the date, not the backend's storage");
            kept = ref;
          });

          it("a new instance on empty storage with the same install ID names the box's owner", { timeout, skip: skip.recovery ?? false }, async () => {
            const { guest } = need();
            // As when BB Box loses its storage: the sweep rebuilds the box's record from this.
            const fresh = await options.create(new MemoryStorage(), CONFORMANCE_INSTALL);
            others.push(fresh);
            const held = (await fresh.held(signal())).find((other) => other.ref === guest.ref);
            assert.ok(held, "the new instance holds the guest");
            assert.equal(held.owner?.boxId, box.boxId);
            assert.equal(held.owner?.threadId, box.threadId);
            assert.equal(held.owner?.name, box.name);
            assert.equal(held.owner?.kind, box.kind);
            assert.ok(held.owner?.createdAt !== null && held.owner?.createdAt !== undefined, "it knows when the box was made");
            assert.ok(Math.abs(held.owner.createdAt - box.createdAt) < 2000, "to within a second or so");
            assert.notEqual(held.power, "unknown");
          });

          it("a new instance finds the box after a restart and releases it", { timeout, skip: skip.recovery ?? false }, async () => {
            const { guest } = need();
            const restarted = await options.create(options.storage, CONFORMANCE_INSTALL);
            others.push(restarted);
            const held = (await restarted.held(signal())).find((other) => other.ref === guest.ref);
            assert.ok(held, "the new instance holds the guest");
            assert.equal(held.owner?.boxId, box.boxId);
            await release(restarted, guest);
            await assertReleased(restarted, guest, generation);
            await assertReleased(backend, guest, generation);
          });

          it("releases the box, and releasing again is fine", { timeout }, async () => {
            const { guest } = need();
            if (outstanding.has(guest.ref)) await release(backend, guest);
            await assertReleased(backend, guest, generation);
            await backend.release(guest, releaseHooks().hooks, signal());
            await assertReleased(backend, guest, generation);
          });

          it("keeps a kept snapshot as it is past its box's release, and deletes it on request", { timeout, skip: keeps }, async (t) => {
            if (!kept) return t.skip("no snapshot was kept");
            assert.equal(await keptUntil(backend, kept.id), endOfUtcDay(KEEP_DAY), "listed after the release, with its date");

            await backend.deleteSnapshot!(kept, { submitting: async () => {}, task: async () => {} }, signal());

            assert.equal(await keptUntil(backend, kept.id), undefined, "gone once deleted");
          });
        });
      }

      describe("sizes", { skip: kinds.length ? false : "no kinds to check" }, () => {
        const kind = kinds[0];
        const sizes = kindSizes(kind?.id ?? "");
        const preset = PRESETS.find((name) => name !== sizes.default)!;
        const base = sizes.presets[preset];
        /** With a disk larger than a base disk is likely to be, for the backends that set one. */
        const disked: MachineSize = { ...base, diskGiB: base.diskGiB ?? 32 };
        let asked = base;
        let guest: Guest | null = null;
        let measured: RunResult | null = null;
        const measurable = kind?.capabilities.command && kind.capabilities.os !== "windows" ? false : "the kind runs no sh commands";

        it(`makes a ${preset} box, and reads its size from the guest`, { timeout }, async () => {
          // A warm pool in the run's settings is filled first, so the box can
          // come from it, at a size other than the one it waited at.
          await backend.maintain?.(signal());
          const withDisk = await backend.capacity(kind!.id, disked, [], signal());
          checkCapacity(withDisk, backend.nature);
          if (withDisk.ok) asked = disked;
          else {
            // A backend that cannot set a disk refuses one through capacity (028).
            console.log(`# ${options.name} ${kind!.id}: ${describeSize(disked)} refused: ${withDisk.message}`);
            const without = await backend.capacity(kind!.id, base, [], signal());
            assert.ok(without.ok, `${describeSize(base)}: ${without.message}`);
          }
          guest = await acquire(identity(kind!.id, asked), recordingHooks().hooks);
          // The box is used as soon as it is ready, so it must have its size
          // then, not only some seconds later.
          if (!(skip.size ?? measurable)) measured = await (await backend.transports(guest, kind!.id)).command!.run(MEASURE, { timeoutMs: 30_000 });
          const size = guest.size;
          assert.ok(size, "the backend reads the box's size");
          checkSize(size, "the guest");
          if (backend.nature === "virtual" && !skip["exact-size"]) {
            assert.deepEqual([size.cores, size.memoryMiB], [asked.cores, asked.memoryMiB], "a virtual box has the cores and memory asked for");
          } else {
            // A machine has memory M when it shows 90% of it, as the box's own check allows.
            assert.ok(size.cores >= asked.cores && size.memoryMiB >= asked.memoryMiB * 0.9, "a pool claims a machine of at least the size");
          }
          // A machine's disk is its own, so a pool may give null; the box's check measures it.
          const disk = size.diskGiB ?? (backend.nature === "real" ? asked.diskGiB : null);
          if (asked.diskGiB !== null) assert.ok(disk !== null && disk >= asked.diskGiB, "the disk is at least the size asked for");
          const held = (await backend.held(signal())).find((other) => other.ref === guest!.ref);
          assert.deepEqual(held?.size, size, "held reads the same size");
        });

        it("has the cores, memory and disk it says, as soon as it is ready", { timeout, skip: skip.size ?? measurable }, async () => {
          assert.ok(guest?.size && measured, "the box was acquired and measured");
          const size = guest.size;
          const result = measured;
          assert.equal(result.exitCode, 0, result.stderr);
          const [cores, memoryMiB, diskMiB] = result.stdout.trim().split(/\s+/).map(Number) as [number, number, number];
          console.log(`# ${options.name} ${kind!.id}: says ${describeSize(size)}; the box has ${cores} cores, ${memoryMiB} MiB memory, ${diskMiB} MiB disk`);
          if (backend.nature === "virtual") assert.equal(cores, size.cores, "the cores the box can use");
          else assert.ok(cores >= size.cores, "the cores the box can use");
          // A VM's kernel keeps some of its memory.
          assert.ok(memoryMiB >= size.memoryMiB * 0.9, `${memoryMiB} MiB of memory is about ${size.memoryMiB}`);
          if (backend.nature === "virtual") assert.ok(memoryMiB <= size.memoryMiB, `${memoryMiB} MiB of memory is no more than ${size.memoryMiB}`);
          // A file system keeps some of its disk.
          const disk = size.diskGiB ?? (backend.nature === "real" ? asked.diskGiB : null);
          if (disk !== null) assert.ok(diskMiB >= disk * 1024 * 0.9, `${diskMiB} MiB of disk is about ${disk} GiB`);
        });

        const resizing = kind ? (backend.resizing?.(kind.id) ?? null) : null;
        const live = resizing?.cores === "live" && resizing.memory === "live" && resizing.shrinks ? false : "the kind's cores and memory do not change live, larger and smaller";
        const restarts = resizing?.cores === "restart" || resizing?.memory === "restart" ? false : "no part of the kind's size needs a restart";
        /** Measures the box until it has `size`, for up to `ms`, and says what it last had; a command that fails, as while the box restarts, is tried again. */
        const has = async (command: CommandTransport, size: MachineSize, ms = 15_000): Promise<string> => {
          const until = Date.now() + ms;
          let last = "";
          for (;;) {
            const result = await command.run(MEASURE, { timeoutMs: 30_000 }).catch((error: unknown) => ({ exitCode: -1, stdout: "", stderr: String(error) }));
            const [cores, memoryMiB, diskMiB] = result.stdout.trim().split(/\s+/).map(Number) as [number, number, number];
            last = result.exitCode === 0 ? `${cores} cores, ${memoryMiB} MiB memory, ${diskMiB} MiB disk` : `no answer: ${result.stderr.trim()}`;
            const memory = memoryMiB >= size.memoryMiB * 0.9 && memoryMiB <= size.memoryMiB;
            const disk = size.diskGiB === null || diskMiB >= size.diskGiB * 1024 * 0.9;
            if (result.exitCode === 0 && cores === size.cores && memory && disk) return last;
            if (Date.now() >= until) assert.fail(`after ${ms / 1000} s the box has ${last}, not ${describeSize(size)}`);
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
        };
        it("resizes live, larger then smaller, with a process still running, and the box has each size within 15 s (061)", { timeout, skip: skip.resize ?? skip.size ?? (measurable || live) }, async (t) => {
          assert.ok(guest?.size, "the box was acquired and read");
          const from = guest.size;
          const command = (await backend.transports(guest, kind!.id)).command!;
          const sleeper = await command.run("nohup sleep 900 >/dev/null 2>&1 & echo $!", { timeoutMs: 30_000 });
          const pid = sleeper.stdout.trim();
          assert.match(pid, /^\d+$/, sleeper.stderr);
          const larger: MachineSize = {
            cores: from.cores + 1,
            memoryMiB: from.memoryMiB + 1024,
            diskGiB: resizing!.disk === "live" && from.diskGiB !== null ? from.diskGiB + 2 : from.diskGiB,
          };
          const plan = await backend.planResize!(guest, kind!.id, larger, [], signal());
          if (!plan.room.ok) {
            t.skip(`no room to grow: ${plan.room.message}`);
            return;
          }
          assert.ok(plan.parts.every((part) => part.way === "live"), "every part changes live");
          const grown = await backend.resize!(guest, kind!.id, larger, { restart: false }, signal());
          assert.deepEqual(grown.size, larger, "the backend reads the new size back");
          console.log(`# ${options.name} ${kind!.id}: grown to ${describeSize(larger)}; the box has ${await has(command, larger)}`);
          const smaller: MachineSize = { ...from, diskGiB: larger.diskGiB };
          const shrunk = await backend.resize!(grown, kind!.id, smaller, { restart: false }, signal());
          assert.deepEqual(shrunk.size, smaller);
          console.log(`# ${options.name} ${kind!.id}: shrunk to ${describeSize(smaller)}; the box has ${await has(command, smaller)}`);
          const alive = await command.run(`kill -0 ${pid} && echo alive; kill ${pid} 2>/dev/null; true`, { timeoutMs: 30_000 });
          assert.match(alive.stdout, /alive/, "the process started before the resize still runs");
          guest = shrunk;
        });

        it("resizes with a restart where a part needs one, refuses it without, and the box has the new size once it answers again (061)", { timeout, skip: skip.resize ?? skip.size ?? (measurable || restarts) }, async (t) => {
          assert.ok(guest?.size, "the box was acquired and read");
          const from = guest.size;
          const larger: MachineSize = { cores: from.cores + 1, memoryMiB: from.memoryMiB + 1024, diskGiB: resizing!.disk !== "no" && from.diskGiB !== null ? from.diskGiB + 2 : from.diskGiB };
          const plan = await backend.planResize!(guest, kind!.id, larger, [], signal());
          if (!plan.room.ok) {
            t.skip(`no room to grow: ${plan.room.message}`);
            return;
          }
          assert.ok(plan.parts.some((part) => part.way === "restart") && plan.downSeconds !== null, "a restart, and about how long it takes");
          await assert.rejects(backend.resize!(guest, kind!.id, larger, { restart: false }, signal()), "refused without restart");
          const began = Date.now();
          const grown = await backend.resize!(guest, kind!.id, larger, { restart: true }, signal());
          assert.deepEqual(grown.size, larger, "the backend reads the new size back");
          const command = (await backend.transports(grown, kind!.id)).command!;
          console.log(`# ${options.name} ${kind!.id}: restarted at ${describeSize(larger)} in ${((Date.now() - began) / 1000).toFixed(1)} s, planned ${plan.downSeconds} s; the box has ${await has(command, larger, 120_000)}`);
          guest = grown;
        });

        it("releases the box", { timeout }, async () => {
          if (!guest) return;
          await release(backend, guest);
          await assertReleased(backend, guest);
        });
      });

      describe("interrupted acquires", { skip: skip.interrupted ?? (kinds.length ? false : "no kinds to check") }, () => {
        const kind = kinds[0]?.id ?? "";
        for (const at of ["claim", "starting"] as const) {
          it(`leave nothing behind when cancelled at ${at}`, { timeout }, async () => {
            const controller = new AbortController();
            const recorded = recordingHooks();
            const hooks: AcquireHooks = {
              ...recorded.hooks,
              claim: async (guest) => {
                await recorded.hooks.claim(guest);
                if (at === "claim") controller.abort(new Error("cancelled by the suite"));
              },
              starting: async () => {
                await recorded.hooks.starting();
                if (at === "starting") controller.abort(new Error("cancelled by the suite"));
              },
            };
            await assert.rejects(backend.acquire(identity(kind), null, hooks, controller.signal));
            assert.ok(recorded.claimed.length > 0);
            for (const guest of recorded.claimed) await assertReleased(backend, guest);
          });
        }
      });

      describe("images", { skip: skip.images ?? (!backend.images ? "the backend has no image operations" : kinds.length ? false : "no kinds to check") }, () => {
        // Built and removed again: nothing is replaced, so boxes of the kind still start from its standard image.
        const left: string[] = [];
        after(async () => {
          for (const ref of left.reverse()) await backend.images?.remove(ref).catch(() => undefined);
        });

        it("builds a small image: a box from a standard build, a script as root, a capture, and a trial box that has what the script made", { timeout: timeout * 6 }, async () => {
          const images = backend.images!;
          // The smallest kind under test that has a standard build: Linux first, as desktops are bigger.
          const order = (kind: string) => (kind === "linux" ? 0 : kind.includes("desktop") ? 2 : 1);
          const standard = (await images.list(signal()))
            .builds.filter((build) => build.current && kinds.some((kind) => kind.id === build.kind))
            .sort((a, b) => order(a.kind) - order(b.kind))[0];
          assert.ok(standard, `the backend lists a standard build of ${kinds.map((kind) => kind.id).join(" or ")}`);
          const box = await images.box(standard, "conformance image", signal());
          left.push(box.ref);
          assert.equal((await backend.held(signal())).find((guest) => guest.ref === box.ref), undefined, "an image box is no box's guest");
          assert.ok((await images.list(signal())).boxes.includes(box.ref), "an image box is listed until it goes");

          // As a build's script and finalizing leave it: a file of the image's, and its record, where the OS keeps it (049, 054).
          const os = kinds.find((kind) => kind.id === standard.kind)?.capabilities.os;
          const dir = os === "windows" ? "C:\\bb-box" : os === "macos" ? "/usr/local/share/bb-box" : "/usr/share/bb-box";
          const marker = `BB Box conformance ${randomBytes(4).toString("hex")}`;
          const build = `build.conformance-${Date.now()}`;
          const record = { contract: 1, image: "conformance", kind: standard.kind, arch: "", build, built: new Date().toISOString(), os: "", tools: {} };
          const script =
            os === "windows"
              ? [
                  "$ErrorActionPreference = 'Stop'",
                  `New-Item -ItemType Directory -Force '${dir}' | Out-Null`,
                  `Set-Content '${dir}\\conformance' '${marker}'`,
                  `Set-Content '${dir}\\image.json' '${JSON.stringify(record)}'`,
                ].join("\n")
              : [
                  "set -e",
                  `sudo -n mkdir -p ${dir}`,
                  `printf '%s\\n' '${marker}' | sudo -n tee ${dir}/conformance >/dev/null`,
                  `printf '%s\\n' '${JSON.stringify(record)}' | sudo -n tee ${dir}/image.json >/dev/null`,
                ].join("\n");
          const ran = await box.command.run(script, { timeoutMs: timeout, signal: signal() });
          assert.equal(ran.exitCode, 0, ran.stderr);

          const made: ImageBuild = await images.capture(box, standard, "conformance", signal());
          assert.deepEqual([made.image, made.kind, made.build, made.current, made.record?.build], ["conformance", standard.kind, build, false, build]);
          const listed = await images.list(signal());
          assert.ok(listed.builds.some((other) => other.ref === made.ref && other.image === "conformance"), "the build is listed");
          assert.ok(!listed.boxes.includes(box.ref), "the captured box is a build, not a box");

          const trial = await images.box(made, "conformance trial", signal());
          left.push(trial.ref);
          const read = await trial.command.run(os === "windows" ? `Get-Content '${dir}\\conformance'` : `cat ${dir}/conformance`, { timeoutMs: timeout, signal: signal() });
          assert.equal(read.stdout.trim(), marker, "a box from the build has what the script made");

          await images.remove(trial.ref, signal());
          await images.remove(made.ref, signal());
          left.length = 0;
          const remaining = await images.list(signal());
          assert.ok(!remaining.builds.some((other) => other.image === "conformance"), "the build is gone");
          assert.deepEqual(remaining.boxes, [], "no image box is left");
          assert.ok(remaining.builds.some((other) => other.ref === standard.ref && other.current), "the standard build stays");
        });
      });

      describe("installs", { skip: skip.installs ?? (kinds.length ? false : "no kinds to check") }, () => {
        const kind = kinds[0]?.id ?? "";
        const isGone = (error: unknown) => error instanceof BackendError && error.code === "gone";
        const leftAlone = (error: unknown) => isGone(error) || /leaves it alone/.test(String(error));
        const unlessLeftAlone = <T>(work: Promise<T>, otherwise: T) => work.catch((error: unknown) => (leftAlone(error) ? otherwise : Promise.reject(error)));

        it("two installs on one backend leave each other's guests alone", { timeout }, async () => {
          const other = await options.create(new MemoryStorage(), `${CONFORMANCE_INSTALL}-other`);
          others.push(other);
          const before = await other.capacity(kind, sizeOf(kind), [], signal());
          const mine = await acquire(identity(kind), recordingHooks().hooks);
          // A box that took a warm guest starts a fill, which holds room the
          // other install cannot take from it until it is done.
          await backend.maintain?.(signal());
          const after = await other.capacity(kind, sizeOf(kind), [], signal());
          assert.ok(
            after.hosts.some((host) => host.limits.some((limit) => limit.used > (limitOf(before, host.host, limit.resource)?.used ?? Infinity))),
            "this install's guest counts against the other's capacity",
          );
          const theirs = await other.acquire(identity(kind), null, recordingHooks().hooks, signal());
          try {
            assert.equal((await other.held(signal())).find((guest) => guest.ref === mine.ref), undefined, "the other install does not hold this one's guest");
            assert.equal((await backend.held(signal())).find((guest) => guest.ref === theirs.ref), undefined, "this install does not hold the other's guest");
            assert.equal(await unlessLeftAlone(other.power(mine, signal()), null), null, "to the other install, this one's guest does not exist, or is outside its VMID range");
            if (other.stop) await assert.rejects(other.stop(mine, signal()), leftAlone);
            await unlessLeftAlone(other.release(mine, releaseHooks().hooks, signal()), undefined);
            await other.maintain?.(signal());
            assert.equal(await backend.power(mine, signal()), "running", "the other install left this one's guest alone");
            assert.equal(await other.power(theirs, signal()), "running");
          } finally {
            await other.release(theirs, releaseHooks().hooks, signal());
            await release(backend, mine);
          }
          await assertReleased(other, theirs);
        });

        const reuse = options.reuse && backend.nature === "virtual" ? false : "the backend does not reuse references";
        it("a reused reference belongs to the new box: the old box's guest is gone", { timeout, skip: reuse }, async () => {
          const old = await acquire(identity(kind), recordingHooks().hooks);
          await release(backend, old);
          await options.reuse!(options.storage, old.ref);
          const next = await options.create(options.storage, CONFORMANCE_INSTALL);
          others.push(next);
          const box = identity(kind);
          const current = await next.acquire(box, null, recordingHooks().hooks, signal());
          outstanding.set(current.ref, current);
          try {
            assert.equal(current.ref, old.ref, "the new box's guest took the old box's reference");
            assert.equal(await backend.power(old, signal()), null, "the old box's guest is gone");
            if (backend.start) await assert.rejects(backend.start(old, signal()), isGone);
            if (backend.stop) await assert.rejects(backend.stop(old, signal()), isGone);
            await backend.release(old, releaseHooks().hooks, signal());
            assert.equal(await backend.power(current, signal()), "running", "the old box's release left the new box alone");
            assert.equal((await backend.held(signal())).find((guest) => guest.ref === current.ref)?.owner?.boxId, box.boxId);
          } finally {
            await release(backend, current);
          }
        });
      });
    });
  });
}

export interface SlotConformanceOptions {
  readonly name: string;
  readonly create: () => Backend;
  readonly kind: SlotKind;
  readonly elastic: boolean;
  readonly timeoutMs?: number;
}

export async function slotConformance(options: SlotConformanceOptions): Promise<void> {
  const timeout = options.timeoutMs ?? 120_000;
  const wait = () => AbortSignal.timeout(timeout);
  describe(`${options.name}, ${options.kind} slots`, { timeout: timeout * 8 }, () => {
    const backend = options.create();
    const lender = backend.slots;
    after(async () => backend.dispose?.());
    const place = async (box: BoxIdentity): Promise<Guest> => {
      const tier = await lender!.offer(options.kind, null, wait());
      assert.notEqual(tier.tier, "wait", `a slot is offered: ${tier.tier === "wait" ? tier.words : ""}`);
      const taken = await lender!.take(tier, box, wait());
      assert.ok(!("lost" in taken), `the take wins: ${"lost" in taken ? taken.lost : ""}`);
      return taken;
    };
    const hostOf = (guest: Guest): string => {
      const placement = placementOf({ guest });
      assert.equal(placement.on, "slot", `${guest.ref} is in a slot`);
      return placement.on === "slot" ? placement.host : "";
    };
    let first: Guest | null = null;
    let second: Guest | null = null;

    it("lends the kind", () => {
      assert.ok(lender, "the backend has a lender");
      assert.equal(lender.lends(options.kind), true);
    });

    it("two acquires at once share one new host, each in a slot of its own", { timeout }, async () => {
      const boxes = [identity(options.kind), identity(options.kind)];
      const taken = [await place(boxes[0]!), await place(boxes[1]!)];
      const acquired = await Promise.all(boxes.map((box, n) => backend.acquire(box, taken[n]!, recordingHooks().hooks, wait())));
      [first, second] = acquired;
      assert.equal(hostOf(acquired[0]!), hostOf(acquired[1]!), "one host");
      assert.notEqual(acquired[0]!.ref, acquired[1]!.ref, "two slots");
      for (const guest of acquired) assert.equal(await backend.power(guest, wait()), "running");
    });

    it("refuses a stop, a resize and a grant of a box in a slot, in words", { timeout }, async () => {
      assert.ok(first);
      if (backend.stop) await assert.rejects(backend.stop(first, wait()), (error: unknown) => error instanceof BackendError && error.code === "unsupported" && /shared/.test(error.message));
      if (backend.planResize) await assert.rejects(backend.planResize(first, options.kind, { cores: 2, memoryMiB: 4096, diskGiB: null }, [], wait()), /no size of its own/);
      if (backend.grant) await assert.rejects(backend.grant(first, { program: "/bin/sh", permissions: ["accessibility"] }, wait()), /no console session/);
    });

    const restoresInItsSlot = async (guest: Guest): Promise<string | false> => {
      if (!(backend.planSnapshots && backend.snapshot && backend.rollbackSnapshot && backend.powerOff && backend.start && backend.heldSnapshots && backend.deleteSnapshot)) return "the backend restores no snapshot in place";
      const plan = await backend.planSnapshots(guest, options.kind, null, wait()).catch((error: unknown) => {
        if (error instanceof BackendError && error.code === "unsupported") return error.message;
        throw error;
      });
      if (typeof plan === "string") return plan;
      if (!plan.take.ok) return `it takes no snapshot of a box in a slot: ${plan.take.why}`;
      return plan.restore.way === "rollback" ? false : `it restores no snapshot of a box in a slot in place: ${plan.restore.why}`;
    };

    it("takes a snapshot of a box in a slot, restores it in place after an undo, restores the undo and deletes both, leaving the other slot's box as it was", { timeout }, async (t) => {
      assert.ok(first && second);
      const skipped = await restoresInItsSlot(first);
      if (skipped) return t.skip(skipped);
      const file = "conformance-slot-snapshot.txt";
      const quietly = { submitting: async () => {}, task: async () => {} };
      const command = async (guest: Guest) => (await backend.transports(guest, options.kind)).command!;
      const write = async (guest: Guest, text: string) => assert.equal((await (await command(guest)).run(`echo ${text} > "$HOME/${file}"`, { timeoutMs: 30_000, signal: wait() })).exitCode, 0);
      const contents = async (guest: Guest) => (await (await command(guest)).run(`cat "$HOME/${file}"`, { timeoutMs: 30_000, signal: wait() })).stdout.trim();
      const box = first.data?.box as string;
      const id = newSnapshotId((bytes) => randomBytes(bytes));
      const undoId = newSnapshotId((bytes) => randomBytes(bytes));
      const listedRef = async (snapshot: string): Promise<SnapshotRef> => {
        const listed = (await backend.heldSnapshots!(wait())).find((held) => held.id === snapshot);
        assert.equal(listed?.state, "complete", "the provider lists the snapshot it took, complete");
        return { id: snapshot, ref: listed.ref, guest: first! };
      };
      await write(first, "A");
      await write(second, "other");

      await backend.snapshot!(first, { id, box, memory: false }, quietly, wait());
      const ref = await listedRef(id);
      await write(first, "B");
      await backend.powerOff!(first, wait());
      assert.equal(await backend.power(first, wait()), "stopped", "a stopped slot box reads as stopped");
      await backend.snapshot!(first, { id: undoId, box, memory: false }, quietly, wait());
      await backend.rollbackSnapshot!(first, ref, quietly, wait());
      await backend.start!(first, wait());

      assert.equal(await contents(first), "A", "the box holds what it held at the snapshot");
      assert.equal(await backend.power(first, wait()), "running");
      assert.equal(await contents(second), "other", "the other slot's box is as it was");
      assert.equal(await backend.power(second, wait()), "running");

      await backend.powerOff!(first, wait());
      await backend.rollbackSnapshot!(first, await listedRef(undoId), quietly, wait());
      await backend.start!(first, wait());
      assert.equal(await contents(first), "B", "the undo puts back what the box held before the restore");

      for (const each of [ref, await listedRef(undoId)]) await backend.deleteSnapshot!(each, quietly, wait());
      assert.deepEqual((await backend.heldSnapshots!(wait())).filter((held) => held.id === id || held.id === undoId), [], "both gone once deleted");
    });

    it("a release of one leaves the other answering on the same host", { timeout }, async () => {
      assert.ok(first && second);
      await backend.release(first, releaseHooks().hooks, wait());
      assert.equal(await backend.power(second, wait()), "running");
      const command = (await backend.transports(second, options.kind)).command;
      assert.ok(command, "a slot box has a command transport");
      assert.equal((await command.run("true", { timeoutMs: 30_000 })).exitCode, 0);
      assert.ok(!(await backend.held(wait())).some((guest) => guest.ref === first!.ref && guest.owner), "the released slot is no box's");
    });

    if (options.kind === "macos") {
      it("a macos box's slot is never lent again: after its release an ios box gets a slot of its own", { timeout }, async () => {
        if (!lender?.lends("ios")) return;
        const macos = identity("macos");
        const held = await backend.acquire(macos, await place(macos), recordingHooks().hooks, wait());
        assert.equal((await backend.held(wait())).find((guest) => guest.ref === held.ref)?.owner?.kind, "macos", "the host holds the slot for a macos box");
        await backend.release(held, releaseHooks().hooks, wait());
        const ios = identity("ios");
        const tier = await lender.offer("ios", null, wait());
        assert.notEqual(tier.tier, "wait", `an ios slot is offered: ${tier.tier === "wait" ? tier.words : ""}`);
        const taken = await lender.take(tier, ios, wait());
        assert.ok(!("lost" in taken), `the take wins: ${"lost" in taken ? taken.lost : ""}`);
        const next = await backend.acquire(ios, taken, recordingHooks().hooks, wait());
        try {
          assert.notEqual(next.ref, held.ref, "a new slot, not the macos box's");
          const [was, now] = [placementOf({ guest: held }), placementOf({ guest: next })];
          assert.ok(was.on === "slot" && now.on === "slot" && (was.generation !== now.generation || was.carried !== now.carried), "another generation");
        } finally {
          await backend.release(next, releaseHooks().hooks, wait());
        }
      });
    }

    it(options.elastic ? "the last release deletes the host" : "the last release leaves the always-on host", { timeout }, async () => {
      assert.ok(second);
      const host = hostOf(second);
      await backend.release(second, releaseHooks().hooks, wait());
      assert.ok(!(await backend.held(wait())).some((guest) => placementOf({ guest }).on === "slot" && hostOf(guest) === host), "no slot of the host is held");
      if (!options.elastic) return;
      const next = await lender!.offer(options.kind, null, wait());
      assert.equal(next.tier, "new-host", "the next box needs a new host");
    });
  });
}
