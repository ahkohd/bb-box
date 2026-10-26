import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, ftruncateSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import http2 from "node:http2";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { H264Encoder, type EncodedUnit, type H264EncoderName } from "../../../src/device/h264-encoder.ts";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    grpc: { type: "string", default: "8554" },
    serial: { type: "string", default: "emulator-5554" },
    emulator: { type: "string", default: "" },
    helper: { type: "string", default: `${process.env.HOME}/h264-x264/bin/bb-box-h264` },
    encoder: { type: "string", default: "x264" },
    threads: { type: "string", default: "1" },
    bitrate: { type: "string", default: "8000" },
    fps: { type: "string", default: "60" },
    mode: { type: "string", default: "pipe" },
    seconds: { type: "string", default: "30" },
    window: { type: "string", default: "10" },
    busy: { type: "boolean", default: false },
    "no-encode": { type: "boolean", default: false },
    label: { type: "string", default: "" },
    record: { type: "string", default: "" },
    "record-frames": { type: "string", default: "120" },
    file: { type: "string", default: "" },
    out: { type: "string", default: "" },
    shm: { type: "string", default: "/dev/shm/bb-box-frames" },
  },
});

const TICKS_A_SECOND = 100;

function varint(value: number): Buffer {
  const bytes: number[] = [];
  while (value > 0x7f) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 128);
  }
  bytes.push(value);
  return Buffer.from(bytes);
}

function field(number: number, bytes: Buffer): Buffer {
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

function numberField(number: number, value: number): Buffer {
  return Buffer.concat([varint(number << 3), varint(value)]);
}

function* fields(message: Buffer): Generator<{ number: number; value: number; bytes: Buffer | null }> {
  let at = 0;
  const readVarint = () => {
    let value = 0;
    let scale = 1;
    for (;;) {
      const byte = message[at++]!;
      value += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) return value;
    }
  };
  while (at < message.length) {
    const tag = readVarint();
    const type = tag & 7;
    if (type === 0) yield { number: tag >>> 3, value: readVarint(), bytes: null };
    else if (type === 2) {
      const length = readVarint();
      yield { number: tag >>> 3, value: length, bytes: message.subarray(at, at + length) };
      at += length;
    } else if (type === 1) at += 8;
    else if (type === 5) at += 4;
    else throw new Error(`protobuf wire type ${type}`);
  }
}

interface Screen {
  readonly width: number;
  readonly height: number;
  readonly rgb: Buffer;
  readonly seq: number;
  readonly producedUs: number;
  readonly receivedMs: number;
}

function parseImage(message: Buffer): Screen {
  let width = 0;
  let height = 0;
  let rgb: Buffer = Buffer.alloc(0);
  let seq = 0;
  let producedUs = 0;
  for (const part of fields(message)) {
    if (part.number === 1 && part.bytes) {
      for (const inner of fields(part.bytes)) {
        if (inner.number === 3) width = inner.value;
        if (inner.number === 4) height = inner.value;
      }
    } else if (part.number === 4 && part.bytes) rgb = part.bytes;
    else if (part.number === 5) seq = part.value;
    else if (part.number === 6) producedUs = part.value;
  }
  return { width, height, rgb, seq, producedUs, receivedMs: performance.now() };
}

function streamScreenshots(port: number, shared: string | null, onScreen: (screen: Screen) => void): () => void {
  const session = http2.connect(`http://127.0.0.1:${port}`, { settings: { initialWindowSize: 2 ** 31 - 1 } });
  session.on("connect", () => session.setLocalWindowSize(2 ** 31 - 1));
  session.on("error", (error) => console.error("grpc", error.message));
  const request = session.request({
    ":method": "POST",
    ":path": "/android.emulation.control.EmulatorController/streamScreenshot",
    "content-type": "application/grpc",
    te: "trailers",
  });
  const transport = shared ? field(6, Buffer.concat([numberField(1, 1), field(2, Buffer.from(`file://${shared}`))])) : Buffer.alloc(0);
  const format = Buffer.concat([numberField(1, 2), transport]);
  const head = Buffer.alloc(5);
  head.writeUInt32BE(format.length, 1);
  request.end(Buffer.concat([head, format]));
  let chunks: Buffer[] = [];
  let buffered = 0;
  let need = -1;
  request.on("data", (chunk: Buffer) => {
    chunks.push(chunk);
    buffered += chunk.length;
    for (;;) {
      if (need < 0) {
        if (buffered < 5) return;
        const joined = Buffer.concat(chunks);
        chunks = [joined];
        need = joined.readUInt32BE(1) + 5;
      }
      if (buffered < need) return;
      const joined = chunks.length === 1 ? chunks[0]! : Buffer.concat(chunks);
      onScreen(parseImage(joined.subarray(5, need)));
      const rest = joined.subarray(need);
      chunks = rest.length ? [rest] : [];
      buffered = rest.length;
      need = -1;
    }
  });
  request.on("trailers", (trailers) => {
    if (trailers["grpc-status"] !== "0") console.error("grpc ended", trailers["grpc-status"], trailers["grpc-message"]);
  });
  return () => {
    request.close();
    session.close();
  };
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
      const status = readFileSync(`/proc/${pid}/status`, "utf8");
      kib += Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0);
    } catch {}
  }
  return Math.round(kib / 1024);
}

function selfCpuMs(): number {
  const usage = process.cpuUsage();
  return (usage.user + usage.system) / 1000;
}

function summary(values: readonly number[]) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (share: number) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]!;
  const round = (value: number) => Math.round(value * 10) / 10;
  return { n: sorted.length, median: round(at(0.5)), p95: round(at(0.95)), min: round(sorted[0]!), max: round(sorted.at(-1)!) };
}

function emulatorPid(): number {
  if (options.emulator) return Number(options.emulator);
  const found = readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).find((entry) => {
    try {
      const command = readFileSync(`/proc/${entry}/cmdline`, "utf8");
      return command.includes("qemu-system-x86_64") && command.includes(`-port\0${options.serial.split("-")[1]}`);
    } catch {
      return false;
    }
  });
  if (!found) throw new Error(`no emulator for ${options.serial}`);
  return Number(found);
}

function busyLoop(width: number, height: number): ChildProcess {
  const x = Math.round(width / 2);
  const low = Math.round(height * 0.8);
  const high = Math.round(height * 0.2);
  return spawn("adb", ["-s", options.serial, "shell", `while true; do input swipe ${x} ${low} ${x} ${high} 120; input swipe ${x} ${high} ${x} ${low} 120; done`], { stdio: "ignore" });
}

async function stream() {
  const shared = options.mode === "mmap" ? options.shm : null;
  if (shared) {
    const fd = openSync(shared, "w");
    ftruncateSync(fd, 4096 * 4096 * 3);
    closeSync(fd);
  }
  const encodeTimes: number[] = [];
  const encode = !options["no-encode"];
  const encoder = encode
    ? new H264Encoder({
        helper: options.helper,
        encoder: options.encoder as H264EncoderName,
        threads: Number(options.threads),
        bitrateKbps: Number(options.bitrate),
        framesPerSecond: Number(options.fps),
        ...(shared ? { sharedMemory: shared } : {}),
        onEncoded: (unit: EncodedUnit) => encodeTimes.push(unit.encodeMicros / 1000),
      })
    : null;
  const description = encoder ? await Promise.race([encoder.description, new Promise<string>((resolve) => setTimeout(() => resolve("?"), 2000))]) : "none";
  let received = 0;
  let encoded = 0;
  let encodedBytes = 0;
  let keys = 0;
  let size = { width: 0, height: 0 };
  const record = options.record ? openSync(options.record, "w") : null;
  let recorded = 0;
  const recordLimit = Number(options["record-frames"]);
  const latencies: number[] = [];
  const stopStream = streamScreenshots(Number(options.grpc), shared, (screen) => {
    received++;
    size = { width: screen.width, height: screen.height };
    if (record !== null && recorded < recordLimit && screen.rgb.length) {
      const head = Buffer.alloc(17);
      head.writeDoubleLE(screen.receivedMs, 0);
      head.write("F", 8, "latin1");
      head.writeUInt32LE(screen.width, 9);
      head.writeUInt32LE(screen.height, 13);
      writeSync(record, head);
      writeSync(record, screen.rgb);
      recorded++;
    }
    if (!encoder) return;
    if (shared) encoder.submitShared({ width: screen.width, height: screen.height, generation: 0 });
    else encoder.submit({ width: screen.width, height: screen.height, rgb: screen.rgb, generation: 0 });
  });
  const drain = encoder
    ? (async () => {
        for await (const frame of encoder.frames()) {
          encoded++;
          encodedBytes += frame.data.length;
          if (frame.key) keys++;
          latencies.push(performance.now() - frame.monotonicMs);
        }
      })().catch((error) => console.error("encoder", error.message))
    : null;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const emulator = emulatorPid();
  const busy = options.busy ? busyLoop(size.width || 1080, size.height || 2400) : null;
  if (busy) await new Promise((resolve) => setTimeout(resolve, 1000));
  const windows: Record<string, unknown>[] = [];
  const seconds = Number(options.seconds);
  const windowSeconds = Number(options.window);
  for (let elapsed = 0; elapsed < seconds; elapsed += windowSeconds) {
    const tree = processTree(emulator);
    const helperPid = encoder?.pid;
    const before = { at: performance.now(), emulator: cpuTicks(tree), helper: helperPid ? cpuTicks([helperPid]) : 0, node: selfCpuMs(), received, encoded, encodedBytes, encodeTimes: encodeTimes.length, latencies: latencies.length };
    await new Promise((resolve) => setTimeout(resolve, windowSeconds * 1000));
    const span = (performance.now() - before.at) / 1000;
    windows.push({
      t: elapsed + windowSeconds,
      size: `${size.width}x${size.height}`,
      receivedFps: Math.round(((received - before.received) / span) * 10) / 10,
      encodedFps: Math.round(((encoded - before.encoded) / span) * 10) / 10,
      mbitPerSecond: Math.round((((encodedBytes - before.encodedBytes) * 8) / span / 1e6) * 100) / 100,
      emulatorCores: Math.round(((cpuTicks(processTree(emulator)) - before.emulator) / TICKS_A_SECOND / span) * 100) / 100,
      helperCores: helperPid ? Math.round(((cpuTicks([helperPid]) - before.helper) / TICKS_A_SECOND / span) * 100) / 100 : 0,
      nodeCores: Math.round(((selfCpuMs() - before.node) / 1000 / span) * 100) / 100,
      encodeMs: summary(encodeTimes.slice(before.encodeTimes)),
      receiveToEncodedMs: summary(latencies.slice(before.latencies)),
      emulatorMiB: residentMiB(processTree(emulator)),
    });
    console.error(JSON.stringify(windows.at(-1)));
  }
  busy?.kill();
  stopStream();
  await encoder?.stop();
  await drain;
  if (record !== null) closeSync(record);
  const result = {
    label: options.label,
    mode: options.mode,
    encoder: description,
    threads: Number(options.threads),
    busy: options.busy,
    keys,
    windows,
    encodeMs: summary(encodeTimes),
    receiveToEncodedMs: summary(latencies),
  };
  console.log(JSON.stringify(result));
}

async function replay() {
  const file = readFileSync(options.file);
  const encodeTimes: number[] = [];
  const encoder = new H264Encoder({
    helper: options.helper,
    encoder: options.encoder as H264EncoderName,
    threads: Number(options.threads),
    bitrateKbps: Number(options.bitrate),
    framesPerSecond: Number(options.fps),
    onEncoded: (unit: EncodedUnit) => encodeTimes.push(unit.encodeMicros / 1000),
  });
  const description = await encoder.description;
  const out = options.out ? openSync(options.out, "w") : null;
  let frames = 0;
  let bytes = 0;
  const drain = (async () => {
    for await (const frame of encoder.frames()) {
      frames++;
      bytes += frame.data.length;
      if (out !== null) writeSync(out, frame.data);
    }
  })();
  let at = 0;
  let firstMs = -1;
  const startedMs = performance.now();
  const helperBefore = cpuTicks([encoder.pid!]);
  let submitted = 0;
  let width = 0;
  let height = 0;
  while (at < file.length) {
    const receivedMs = file.readDoubleLE(at);
    width = file.readUInt32LE(at + 9);
    height = file.readUInt32LE(at + 13);
    const rgb = file.subarray(at + 17, at + 17 + width * height * 3);
    at += 17 + width * height * 3;
    if (firstMs < 0) firstMs = receivedMs;
    const wait = receivedMs - firstMs - (performance.now() - startedMs);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    encoder.submit({ width, height, rgb, generation: 0 });
    submitted++;
    while (frames + 1 < submitted) await new Promise((resolve) => setTimeout(resolve, 1));
  }
  while (frames < submitted) await new Promise((resolve) => setTimeout(resolve, 1));
  const span = (performance.now() - startedMs) / 1000;
  const helperCores = (cpuTicks([encoder.pid!]) - helperBefore) / TICKS_A_SECOND / span;
  await encoder.stop();
  await drain;
  if (out !== null) closeSync(out);
  console.log(JSON.stringify({
    label: options.label,
    encoder: description,
    threads: Number(options.threads),
    size: `${width}x${height}`,
    frames,
    seconds: Math.round(span * 100) / 100,
    fps: Math.round((frames / span) * 10) / 10,
    mbitPerSecond: Math.round(((bytes * 8) / span / 1e6) * 100) / 100,
    helperCores: Math.round(helperCores * 100) / 100,
    encodeMs: summary(encodeTimes),
  }));
}

async function snap() {
  await new Promise<void>((resolve) => {
    const stop = streamScreenshots(Number(options.grpc), null, (screen) => {
      if (!screen.rgb.length) return;
      const fd = openSync(options.out, "w");
      writeSync(fd, screen.rgb);
      closeSync(fd);
      console.log(`${screen.width}x${screen.height}`);
      stop();
      resolve();
    });
  });
}

async function tear() {
  const shared = options.shm;
  const fd = openSync(shared, "w+");
  ftruncateSync(fd, 4096 * 4096 * 3);
  const delayMs = Number(options.window);
  const { createHash } = await import("node:crypto");
  const { readSync } = await import("node:fs");
  const fromShared: string[] = [];
  const fromBytes = new Set<string>();
  const stopShared = streamScreenshots(Number(options.grpc), shared, (screen) => {
    const read = () => {
      const copy = Buffer.alloc(screen.width * screen.height * 3);
      readSync(fd, copy, 0, copy.length, 0);
      fromShared.push(createHash("sha1").update(copy).digest("hex"));
    };
    if (delayMs > 0) setTimeout(read, delayMs);
    else read();
  });
  const stopBytes = streamScreenshots(Number(options.grpc), null, (screen) => {
    fromBytes.add(createHash("sha1").update(screen.rgb).digest("hex"));
  });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const busy = options.busy ? busyLoop(1080, 2400) : null;
  await new Promise((resolve) => setTimeout(resolve, Number(options.seconds) * 1000));
  busy?.kill();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  stopShared();
  stopBytes();
  closeSync(fd);
  const unmatched = fromShared.filter((hash) => !fromBytes.has(hash)).length;
  console.log(JSON.stringify({ label: options.label, readDelayMs: delayMs, sharedFrames: fromShared.length, byteFrames: fromBytes.size, sharedFramesSeenNowhereElse: unmatched }));
}

const commands: Record<string, () => Promise<void>> = { stream, replay, snap, tear };
const command = commands[positionals[0] ?? ""];
if (!command) {
  console.error("usage: bench.ts stream|replay|snap [options]");
  process.exit(2);
}
await command();
process.exit(0);
