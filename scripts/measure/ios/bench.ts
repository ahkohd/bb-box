import { execFileSync, spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { DEVICE_SERVER_VERSION, type DeviceOffer } from "../../../src/core/device.ts";
import { parseDeviceOffer } from "../../../src/core/device-parse.ts";
import { deliveryScript, deliveryStdin, deviceServerFiles } from "../../../src/core/device-delivery.ts";
import { DeviceLink } from "../../../src/core/device-link.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";
import { GrpcClient } from "../../../src/device/grpc.ts";
import { encode } from "../../../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../../../src/device/schemas.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(homedir(), ".bb-box", "device");
const LAUNCHER = join(DIR, "current", "src", "device", "bb-box-device.sh");
const RECORD = "/usr/local/share/bb-box/image.json";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "10" },
    window: { type: "string", default: "5" },
    times: { type: "string", default: "10" },
    device: { type: "string" },
    "no-slim": { type: "boolean", default: false },
    url: { type: "string" },
  },
});

function offer(): DeviceOffer {
  const record = JSON.parse(readFileSync(RECORD, "utf8")) as { devices: { runtime: { platform: string } }[] };
  const parsed = parseDeviceOffer({ platform: record.devices[0]!.runtime.platform, devices: record.devices });
  if (!parsed.ok) throw new Error(parsed.words);
  return parsed.value;
}

function channel(): ByteChannel {
  const child = spawn("/bin/sh", [LAUNCHER, "connect"], { stdio: ["pipe", "pipe", "inherit"] });
  return {
    readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
    writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
    close: async () => {
      child.kill();
    },
  };
}

interface Seen {
  readonly at: number;
  readonly bytes: number;
  readonly key: boolean;
  readonly width: number;
  readonly height: number;
}

async function viewer(onFrame: (seen: Seen) => void): Promise<DeviceLink> {
  return DeviceLink.open(channel(), {
    role: "viewer",
    onFrame: (frame) => {
      if (frame[0] !== 4) return;
      onFrame({ at: performance.now(), bytes: frame.byteLength - 12, key: (frame[1]! & 1) === 1, width: (frame[6]! << 8) | frame[7]!, height: (frame[8]! << 8) | frame[9]! });
    },
  });
}

function pids(pattern: string): number[] {
  const out = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout;
  return out.split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
}

function cpuSeconds(pid: number): number {
  const out = spawnSync("ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim();
  const parts = out.split(":").map(Number);
  return parts.reduce((sum, part) => sum * 60 + part, 0);
}

function rssMiB(pid: number): number {
  return Number(spawnSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).stdout.trim()) / 1024;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function own(): { server: number[]; companion: number[] } {
  return { server: pids(`${DIR}/current/src/device/main.ts serve`).concat(pids("src/device/main.ts serve")).filter((pid, index, all) => all.indexOf(pid) === index), companion: pids("idb_companion --udid") };
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
}

function report(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

async function deliver(): Promise<void> {
  const files = await deviceServerFiles(ROOT);
  const target = values.device ? { target: values.device, switching: null } : null;
  const script = deliveryScript(DEVICE_SERVER_VERSION);
  const began = performance.now();
  const ran = spawnSync("/bin/sh", ["-c", script], { input: deliveryStdin({ version: DEVICE_SERVER_VERSION, files, offer: offer(), intent: target as never, choices: { slim: !values["no-slim"] } }), encoding: "utf8" });
  report({ step: "deliver", exit: ran.status, ms: Math.round(performance.now() - began), stderr: ran.stderr.trim().slice(-400) });
}

async function stream(): Promise<void> {
  const seconds = Number(values.seconds);
  const windowSeconds = Number(values.window);
  if (values.url) execFileSync("xcrun", ["simctl", "openurl", "booted", values.url]);
  const frames: Seen[] = [];
  const began = performance.now();
  const link = await viewer((seen) => frames.push(seen));
  const hello = performance.now();
  await link.send("START_VIDEO");
  const asked = performance.now();
  while (!frames.length && performance.now() - asked < 20_000) await wait(5);
  const first = frames[0];
  report({ step: "first", helloMs: Math.round(hello - began), firstFrameMs: first ? Math.round(first.at - asked) : null, key: first?.key ?? null, size: first ? `${first.width}x${first.height}` : null });
  const { server, companion } = own();
  for (let window = 0; window * windowSeconds < seconds; window++) {
    const from = performance.now();
    const cpu = [...server, ...companion].map(cpuSeconds);
    const count = frames.length;
    await wait(windowSeconds * 1000);
    const took = (performance.now() - from) / 1000;
    const these = frames.slice(count);
    const cores = [...server, ...companion].map((pid, index) => (cpuSeconds(pid) - cpu[index]!) / took);
    report({
      step: "window",
      fps: +(these.length / took).toFixed(1),
      keys: these.filter((frame) => frame.key).length,
      mbits: +((these.reduce((sum, frame) => sum + frame.bytes, 0) * 8) / took / 1e6).toFixed(2),
      serverCores: +cores.slice(0, server.length).reduce((a, b) => a + b, 0).toFixed(3),
      companionCores: +cores.slice(server.length).reduce((a, b) => a + b, 0).toFixed(3),
      serverMiB: Math.round(server.reduce((sum, pid) => sum + rssMiB(pid), 0)),
      companionMiB: Math.round(companion.reduce((sum, pid) => sum + rssMiB(pid), 0)),
    });
  }
  await link.close();
}

async function keyframes(): Promise<void> {
  const frames: Seen[] = [];
  const link = await viewer((seen) => frames.push(seen));
  await link.send("START_VIDEO");
  while (!frames.length) await wait(5);
  await wait(1500);
  const times: number[] = [];
  for (let index = 0; index < Number(values.times); index++) {
    const count = frames.length;
    const asked = performance.now();
    await link.send("REQUEST_KEYFRAME");
    while (!frames.slice(count).some((frame) => frame.key) && performance.now() - asked < 5000) await wait(1);
    const key = frames.slice(count).find((frame) => frame.key);
    times.push(key ? key.at - asked : Infinity);
    await wait(500);
  }
  report({ step: "keyframes", ms: times.map((ms) => Math.round(ms * 10) / 10), median: Math.round(median(times) * 10) / 10, worst: Math.round(Math.max(...times) * 10) / 10 });
  await link.close();
}

async function killCompanion(): Promise<void> {
  const frames: Seen[] = [];
  const link = await viewer((seen) => frames.push(seen));
  await link.send("START_VIDEO");
  while (!frames.length) await wait(5);
  if (values.url) execFileSync("xcrun", ["simctl", "openurl", "booted", values.url]);
  await wait(2000);
  const before = own().companion;
  const lastBefore = frames.at(-1)!.at;
  const killed = performance.now();
  for (const pid of before) process.kill(pid, "SIGKILL");
  const count = frames.length;
  while (!frames.slice(count).some((frame) => frame.key) && performance.now() - killed < 30_000) await wait(5);
  const key = frames.slice(count).find((frame) => frame.key);
  const stall = key ? key.at - Math.max(lastBefore, frames[count - 1]!.at) : null;
  await wait(2000);
  report({ step: "kill-companion", killed: before, nowRunning: own().companion, keyFrameAfterKillMs: key ? Math.round(key.at - killed) : null, stallMs: stall === null ? null : Math.round(stall), framesAfter: frames.length - count });
  await link.close();
}

async function killServer(): Promise<void> {
  const before = own();
  const killed = performance.now();
  for (const pid of before.server) process.kill(pid, "SIGKILL");
  let link: DeviceLink | null = null;
  const frames: Seen[] = [];
  while (!link && performance.now() - killed < 30_000) {
    link = await viewer((seen) => frames.push(seen)).catch(() => null);
    if (!link) await wait(50);
  }
  const connected = performance.now();
  await link?.send("START_VIDEO");
  while (!frames.length && performance.now() - killed < 30_000) await wait(5);
  report({
    step: "kill-server",
    killed: before.server,
    helloAfterMs: Math.round(connected - killed),
    keyFrameAfterMs: frames[0] ? Math.round(frames[0].at - killed) : null,
    key: frames[0]?.key ?? null,
    state: link?.hello.state.power,
    companionKept: JSON.stringify(own().companion) === JSON.stringify(before.companion),
  });
  await link?.close();
}

async function switchTo(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "control", started: Date.now(), instance: "bench" });
  const frames: Seen[] = [];
  const watcher = await viewer((seen) => frames.push(seen));
  await watcher.send("START_VIDEO");
  const asked = performance.now();
  const answer = await link.request({ type: "control", control: { action: "switch", device: values.device as never } }, { timeoutMs: 180_000 });
  const answered = performance.now();
  const count = frames.length;
  await watcher.send("REQUEST_KEYFRAME");
  while (!frames.slice(count).some((frame) => frame.key) && performance.now() - answered < 10_000) await wait(5);
  const key = frames.slice(count).find((frame) => frame.key);
  report({ step: "switch", to: values.device, ok: answer.ok, words: answer.ok ? null : answer.error.words, answeredMs: Math.round(answered - asked), size: key ? `${key.width}x${key.height}` : null, power: answer.state?.power });
  await watcher.close();
  await link.close();
}

async function tap(): Promise<void> {
  const frames: Seen[] = [];
  const link = await viewer((seen) => frames.push(seen));
  await link.send("START_VIDEO");
  while (!frames.length) await wait(5);
  await wait(1500);
  const client = new GrpcClient({ socket: join(DIR, "idb.sock") });
  const press = (direction: number) => encode(IDB_SCHEMA, "idb.HIDEvent", { press: { action: { touch: { point: { x: 201, y: 437 } } }, direction } });
  const delays: number[] = [];
  for (let index = 0; index < Number(values.times); index++) {
    const count = frames.length;
    const sent = performance.now();
    await (async () => {
      for await (const _ of client.call(GRPC_METHODS.idb.hid, [press(0), press(1)])) void _;
    })();
    while (frames.length === count && performance.now() - sent < 3000) await wait(1);
    delays.push(frames.length > count ? frames[count]!.at - sent : Infinity);
    await wait(700);
  }
  client.close();
  report({ step: "tap", changedAfterMs: delays.map((ms) => Math.round(ms)), median: Math.round(median(delays)), worst: Math.round(Math.max(...delays)) });
  await link.close();
}

async function clock(): Promise<void> {
  const mac = Date.now() / 1000;
  const device = Number(execFileSync("xcrun", ["simctl", "spawn", "booted", "date", "+%s"], { encoding: "utf8" }).trim());
  report({ step: "clock", mac: Math.round(mac), device, apartSeconds: Math.round(device - mac) });
}

async function state(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "viewer" });
  report({ step: "state", version: link.hello.version, state: link.hello.state });
  await link.close();
}

const steps: Record<string, () => Promise<void>> = { deliver, stream, keyframes, "kill-companion": killCompanion, "kill-server": killServer, switch: switchTo, tap, clock, state };
const step = steps[positionals[0] ?? ""];
if (!step) {
  process.stderr.write(`usage: bench.ts ${Object.keys(steps).join(" | ")}\n`);
  process.exit(2);
}
await step();
process.exit(0);
