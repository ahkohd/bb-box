import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { parseArgs } from "node:util";
import { DEVICE_SERVER_VERSION, type DeviceOffer } from "../../../src/core/device.ts";
import { parseDeviceOffer } from "../../../src/core/device-parse.ts";
import { deliveryScript, deliveryStdin, deviceServerFiles } from "../../../src/core/device-delivery.ts";
import { DeviceLink } from "../../../src/core/device-link.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DIR = join(homedir(), ".bb-box", "device");
const LAUNCHER = join(DIR, "current", "src", "device", "bb-box-device.sh");
const RECORDS = ["/usr/share/bb-box/image.json", "/usr/share/bb-box/android-devices.json"];
const ADB = "/opt/android-sdk/platform-tools/adb";
const SERIAL = "emulator-5554";
const TICKS_A_SECOND = 100;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    seconds: { type: "string", default: "10" },
    window: { type: "string", default: "5" },
    times: { type: "string", default: "10" },
    device: { type: "string" },
    busy: { type: "boolean", default: false },
    out: { type: "string" },
  },
});

function offer(): DeviceOffer {
  for (const path of RECORDS) {
    if (!existsSync(path)) continue;
    const read = JSON.parse(readFileSync(path, "utf8")) as { devices?: unknown[] } | unknown[];
    const devices = Array.isArray(read) ? read : read.devices;
    if (!devices?.length) continue;
    const parsed = parseDeviceOffer({ platform: "android", devices });
    if (!parsed.ok) throw new Error(parsed.words);
    return parsed.value;
  }
  throw new Error(`None of ${RECORDS.join(" and ")} lists Android devices.`);
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
  readonly generation: number;
}

async function viewer(onFrame: (seen: Seen) => void): Promise<DeviceLink> {
  return DeviceLink.open(channel(), {
    role: "viewer",
    onFrame: (frame) => {
      if (frame[0] !== 4) return;
      onFrame({
        at: performance.now(),
        bytes: frame.byteLength - 12,
        key: (frame[1]! & 1) === 1,
        width: (frame[6]! << 8) | frame[7]!,
        height: (frame[8]! << 8) | frame[9]!,
        generation: (frame[10]! << 8) | frame[11]!,
      });
    },
  });
}

function pids(pattern: string): number[] {
  const out = spawnSync("pgrep", ["-f", pattern], { encoding: "utf8" }).stdout;
  return out.split("\n").map(Number).filter((pid) => pid > 0 && pid !== process.pid);
}

function processTree(root: number): number[] {
  const parents = new Map<number, number>();
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]));
    } catch {}
  }
  const tree = [root];
  for (let i = 0; i < tree.length; i++) for (const [pid, parent] of parents) if (parent === tree[i]) tree.push(pid);
  return tree;
}

function cpuTicks(pids: readonly number[]): number {
  let ticks = 0;
  for (const pid of pids) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const parts = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      ticks += Number(parts[11]) + Number(parts[12]);
    } catch {}
  }
  return ticks;
}

function residentMiB(pids: readonly number[]): number {
  let kib = 0;
  for (const pid of pids) {
    try {
      kib += Number(readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    } catch {}
  }
  return Math.round(kib / 1024);
}

interface Own {
  readonly server: number[];
  readonly encoder: number[];
  readonly emulator: number[];
}

function own(): Own {
  const emulator = pids("qemu-system-x86_64.*-avd");
  return {
    server: [...new Set([...pids(`${DIR}/current/src/device/main.ts serve`), ...pids("src/device/main.ts serve")])],
    encoder: pids("^/usr/local/bin/bb-box-h264"),
    emulator: emulator.flatMap(processTree),
  };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
}

function report(line: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

function adb(...args: string[]): string {
  return spawnSync(ADB, ["-s", SERIAL, ...args], { encoding: "utf8" }).stdout.replace(/\r/g, "").trim();
}

function busyLoop(): ChildProcess {
  const size = adb("shell", "wm", "size").match(/(\d+)x(\d+)/);
  const width = Number(size?.[1] ?? 1080);
  const height = Number(size?.[2] ?? 2400);
  const x = Math.round(width / 2);
  const low = Math.round(height * 0.8);
  const high = Math.round(height * 0.2);
  adb("shell", "input", "swipe", String(x), String(low), String(x), String(high), "200");
  return spawn(ADB, ["-s", SERIAL, "shell", `while true; do input swipe ${x} ${low} ${x} ${high} 120; input swipe ${x} ${high} ${x} ${low} 120; done`], { stdio: "ignore" });
}

async function deliver(): Promise<void> {
  const files = await deviceServerFiles(ROOT);
  const target = values.device ? { target: values.device, switching: null } : null;
  const began = performance.now();
  const ran = spawnSync("/bin/sh", ["-c", deliveryScript(DEVICE_SERVER_VERSION)], {
    input: deliveryStdin({ version: DEVICE_SERVER_VERSION, files, offer: offer(), intent: target as never, choices: { slim: true } }),
    encoding: "utf8",
  });
  report({ step: "deliver", version: DEVICE_SERVER_VERSION, exit: ran.status, ms: Math.round(performance.now() - began), stderr: ran.stderr.trim().slice(-400) });
}

async function stream(): Promise<void> {
  const seconds = Number(values.seconds);
  const windowSeconds = Number(values.window);
  const frames: Seen[] = [];
  const began = performance.now();
  const link = await viewer((seen) => frames.push(seen));
  const hello = performance.now();
  await link.send("START_VIDEO");
  const asked = performance.now();
  while (!frames.length && performance.now() - asked < 20_000) await wait(2);
  const first = frames[0];
  report({ step: "first", helloMs: Math.round(hello - began), firstFrameMs: first ? Math.round(first.at - asked) : null, key: first?.key ?? null, size: first ? `${first.width}x${first.height}` : null, power: link.state.power });
  const busy = values.busy ? busyLoop() : null;
  if (busy) await wait(1000);
  for (let window = 0; window * windowSeconds < seconds; window++) {
    const { server, encoder, emulator } = own();
    const from = performance.now();
    const ticks = [cpuTicks(server), cpuTicks(encoder), cpuTicks(emulator)];
    const count = frames.length;
    await wait(windowSeconds * 1000);
    const took = (performance.now() - from) / 1000;
    const these = frames.slice(count);
    const cores = [cpuTicks(server), cpuTicks(encoder), cpuTicks(emulator)].map((now, index) => +((now - ticks[index]!) / TICKS_A_SECOND / took).toFixed(3));
    const gaps = these.slice(1).map((frame, index) => frame.at - these[index]!.at);
    report({
      step: "window",
      busy: !!busy,
      fps: +(these.length / took).toFixed(1),
      keys: these.filter((frame) => frame.key).length,
      mbits: +((these.reduce((sum, frame) => sum + frame.bytes, 0) * 8) / took / 1e6).toFixed(2),
      gapMs: gaps.length ? { median: Math.round(median(gaps)), worst: Math.round(Math.max(...gaps)) } : null,
      serverCores: cores[0],
      encoderCores: cores[1],
      emulatorCores: cores[2],
      serverMiB: residentMiB(server),
      encoderMiB: residentMiB(encoder),
      emulatorMiB: residentMiB(emulator),
    });
  }
  busy?.kill();
  await link.close();
}

async function keyframes(): Promise<void> {
  const frames: Seen[] = [];
  const link = await viewer((seen) => frames.push(seen));
  await link.send("START_VIDEO");
  while (!frames.length) await wait(5);
  const busy = values.busy ? busyLoop() : null;
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
  busy?.kill();
  report({ step: "keyframes", busy: !!busy, ms: times.map((ms) => Math.round(ms * 10) / 10), median: Math.round(median(times) * 10) / 10, worst: Math.round(Math.max(...times) * 10) / 10 });
  await link.close();
}

async function stall(what: string, kill: (before: Own) => number[], waitMs: number): Promise<void> {
  const frames: Seen[] = [];
  const link = await viewer((seen) => frames.push(seen));
  await link.send("START_VIDEO");
  while (!frames.length) await wait(5);
  const busy = values.busy ? busyLoop() : null;
  await wait(2000);
  const before = own();
  const lastBefore = frames.at(-1)!.at;
  const killed = performance.now();
  const victims = kill(before);
  const count = frames.length;
  while (!frames.slice(count).some((frame) => frame.key) && performance.now() - killed < waitMs) await wait(5);
  const key = frames.slice(count).find((frame) => frame.key);
  await wait(2000);
  busy?.kill();
  report({
    step: what,
    busy: !!busy,
    killed: victims,
    keyFrameAfterKillMs: key ? Math.round(key.at - killed) : null,
    stallMs: key ? Math.round(key.at - Math.max(lastBefore, frames[count - 1]?.at ?? lastBefore)) : null,
    framesAfter: frames.length - count,
    state: link.state.power,
    now: own().encoder,
  });
  await link.close();
}

async function killEncoder(): Promise<void> {
  await stall(
    "kill-encoder",
    (before) => {
      for (const pid of before.encoder) process.kill(pid, "SIGKILL");
      return before.encoder;
    },
    10_000,
  );
}

async function killEmulator(): Promise<void> {
  await stall(
    "kill-emulator",
    (before) => {
      const qemu = pids("qemu-system-x86_64.*-avd");
      for (const pid of qemu) process.kill(pid, "SIGKILL");
      return qemu;
    },
    120_000,
  );
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
    emulatorKept: JSON.stringify(own().emulator.slice(0, 1)) === JSON.stringify(before.emulator.slice(0, 1)),
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

async function reboot(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "control", started: Date.now(), instance: "bench" });
  const asked = performance.now();
  const answer = await link.request({ type: "control", control: { action: "reboot" } }, { timeoutMs: 180_000 });
  report({ step: "reboot", ok: answer.ok, words: answer.ok ? null : answer.error.words, answeredMs: Math.round(performance.now() - asked), power: answer.state?.power });
  await link.close();
}

async function screenshotStep(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "input" });
  const times: number[] = [];
  let last: { png: string; generation: number } | null = null;
  for (let index = 0; index < Number(values.times); index++) {
    const began = performance.now();
    const answer = await link.request({ type: "screenshot" });
    times.push(performance.now() - began);
    if (answer.ok && answer.result.type === "screenshot") last = answer.result;
  }
  const png = last ? Buffer.from(last.png, "base64") : null;
  if (png && values.out) await import("node:fs/promises").then((fs) => fs.writeFile(values.out!, png));
  const view = png ? new DataView(png.buffer, png.byteOffset, png.byteLength) : null;
  report({ step: "screenshot", ms: times.map(Math.round), median: Math.round(median(times)), size: view ? `${view.getUint32(16)}x${view.getUint32(20)}` : null, generation: last?.generation ?? null, geometry: link.state.geometry });
  await link.close();
}

async function clock(): Promise<void> {
  const box = Date.now() / 1000;
  const device = Number(adb("shell", "date", "+%s"));
  report({ step: "clock", box: Math.round(box), device, apartSeconds: Math.round(device - box) });
}

async function memory(): Promise<void> {
  const { emulator, server, encoder } = own();
  const meminfo = adb("shell", "cat", "/proc/meminfo");
  const field = (name: string) => Number(meminfo.match(new RegExp(`^${name}:\\s+(\\d+)`, "m"))?.[1] ?? 0) / 1024;
  report({
    step: "memory",
    emulatorMiB: residentMiB(emulator),
    serverMiB: residentMiB(server),
    encoderMiB: residentMiB(encoder),
    androidUsedMiB: Math.round(field("MemTotal") - field("MemAvailable")),
    androidTotalMiB: Math.round(field("MemTotal")),
    boxAvailableMiB: Math.round(Number(readFileSync("/proc/meminfo", "utf8").match(/^MemAvailable:\s+(\d+)/m)?.[1] ?? 0) / 1024),
  });
}

async function watch(): Promise<void> {
  const until = performance.now() + Number(values.seconds) * 1000;
  let second = Math.floor(Date.now() / 1000);
  let frames = 0;
  let keys = 0;
  let link: DeviceLink | null = null;
  const flush = () => {
    const now = Math.floor(Date.now() / 1000);
    if (now === second) return;
    if (frames) report({ step: "watch", at: new Date(second * 1000).toISOString(), frames, keys });
    second = now;
    frames = keys = 0;
  };
  while (performance.now() < until) {
    if (!link || link.closed) {
      link = await DeviceLink.open(channel(), {
        role: "viewer",
        onFrame: (frame) => {
          if (frame[0] !== 4) return;
          flush();
          frames++;
          if ((frame[1]! & 1) === 1) keys++;
        },
        onState: (state) => report({ step: "watch", at: new Date().toISOString(), power: state.power.is, geometry: state.geometry }),
      }).catch(() => null);
      if (link) {
        report({ step: "watch", at: new Date().toISOString(), connected: true, power: link.state.power.is });
        await link.send("START_VIDEO");
      }
    }
    await wait(250);
    flush();
  }
  await link?.close();
}

async function state(): Promise<void> {
  const link = await DeviceLink.open(channel(), { role: "viewer" });
  report({ step: "state", version: link.hello.version, state: link.hello.state });
  await link.close();
}

const steps: Record<string, () => Promise<void>> = {
  deliver,
  stream,
  keyframes,
  "kill-encoder": killEncoder,
  "kill-emulator": killEmulator,
  "kill-server": killServer,
  switch: switchTo,
  reboot,
  screenshot: screenshotStep,
  clock,
  memory,
  state,
  watch,
};
const step = steps[positionals[0] ?? ""];
if (!step) {
  process.stderr.write(`usage: device.ts ${Object.keys(steps).join(" | ")}\n`);
  process.exit(2);
}
await step();
process.exit(0);
