import { execFile, spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { GrpcClient } from "../../../src/device/grpc.ts";
import { UnitReader } from "../../../src/device/h264-encoder.ts";
import { streamOutput } from "../../../src/device/idb.ts";
import { encode } from "../../../src/device/protobuf.ts";
import { GRPC_METHODS, IDB_SCHEMA } from "../../../src/device/schemas.ts";

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    socket: { type: "string", default: "" },
    udid: { type: "string", default: "" },
    format: { type: "string", default: "i420" },
    formats: { type: "string", default: "0,1,2,4" },
    scale: { type: "string", default: "1" },
    fps: { type: "string", default: "0" },
    seconds: { type: "string", default: "30" },
    warm: { type: "string", default: "3" },
    width: { type: "string", default: "1206" },
    height: { type: "string", default: "2622" },
    helper: { type: "string", default: `${process.env.HOME}/h264/bin/bb-box-h264` },
    encoder: { type: "string", default: "" },
    threads: { type: "string", default: "1" },
    bitrate: { type: "string", default: "8000" },
    taps: { type: "string", default: "0" },
    "tap-gap": { type: "string", default: "1000" },
    point: { type: "string", default: "201,437" },
    label: { type: "string", default: "" },
    "no-encode": { type: "boolean", default: false },
    still: { type: "boolean", default: false },
  },
});

const FORMATS: Readonly<Record<string, number>> = { h264: 0, rbga: 1, mjpeg: 2, minicap: 3, i420: 4 };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function startRequest(format: number, scale: number, fps: number): Uint8Array {
  return encode(IDB_SCHEMA, "idb.VideoStreamRequest", { start: { format, compression_quality: 0.2, scale_factor: scale, ...(fps ? { fps } : {}) } });
}

async function* openStream(client: GrpcClient, format: number, scale: number, fps: number, stopped: Promise<void>, signal: AbortSignal) {
  async function* requests() {
    yield startRequest(format, scale, fps);
    await stopped;
    yield encode(IDB_SCHEMA, "idb.VideoStreamRequest", { stop: {} });
  }
  for await (const message of client.call(GRPC_METHODS.idb.videoStream, requests(), { signal })) yield streamOutput(message);
}

function cpuSecondsOf(pid: number): Promise<number | null> {
  return new Promise((resolve) =>
    execFile("ps", ["-o", "time=", "-p", String(pid)], (error, stdout) => {
      if (error) return resolve(null);
      const parts = stdout.trim().split(":").map(Number);
      resolve(parts.reduce((total, part) => total * 60 + part, 0));
    }),
  );
}

function companionPid(socket: string): Promise<number | null> {
  return new Promise((resolve) =>
    execFile("pgrep", ["-f", `grpc-domain-sock ${socket}`], (error, stdout) => resolve(error ? null : Number(stdout.trim().split("\n")[0]) || null)),
  );
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : NaN;
}

function quantile(values: readonly number[], share: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))]! : NaN;
}

async function formats(): Promise<void> {
  const client = new GrpcClient({ socket: options.socket });
  for (const code of options.formats.split(",").map(Number)) {
    let stop!: () => void;
    const stopped = new Promise<void>((resolve) => (stop = resolve));
    const controller = new AbortController();
    const sizes: number[] = [];
    const logs: string[] = [];
    let error = "";
    const began = performance.now();
    let first = NaN;
    const timer = setTimeout(stop, Number(options.seconds) * 1000);
    const hardStop = setTimeout(() => controller.abort(), Number(options.seconds) * 1000 + 2000);
    try {
      for await (const output of openStream(client, code, Number(options.scale), Number(options.fps), stopped, controller.signal)) {
        if (output.log) logs.push(output.log);
        if (output.data?.byteLength) {
          if (!sizes.length) first = performance.now() - began;
          sizes.push(output.data.byteLength);
        }
      }
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    clearTimeout(timer);
    clearTimeout(hardStop);
    const distinct = [...new Set(sizes)].slice(0, 5);
    console.log(JSON.stringify({ format: code, scale: Number(options.scale), messages: sizes.length, perSecond: +(sizes.length / Number(options.seconds)).toFixed(1), firstMs: Math.round(first), sizes: distinct, logs: logs.slice(0, 3), error }));
  }
  client.close();
}

interface RawFrame {
  readonly at: number;
  readonly dark: boolean;
  encodedAt: number;
  encodeMicros: number;
  bytesOut: number;
}

function frameShape(bytes: number, format: string, scale: number): { readonly width: number; readonly height: number; readonly stride: number } {
  const width = Number(options.width);
  const height = Number(options.height);
  const candidates = [Math.round, Math.floor, Math.ceil].flatMap((round) => [round(width * scale), round(width * scale) & ~1]).flatMap((w) => [Math.round, Math.floor, Math.ceil].flatMap((round) => [round(height * scale), round(height * scale) & ~1]).map((h) => ({ w, h })));
  for (const { w, h } of candidates) {
    if (format === "i420" && w * h * 1.5 === bytes) return { width: w, height: h, stride: w };
    if (format === "rbga" && bytes % h === 0 && bytes / h >= w * 4 && bytes / h < w * 4 + 256) return { width: w & ~1, height: h & ~1, stride: bytes / h };
  }
  throw new Error(`No ${format} frame shape near ${width}x${height} at ${scale} has ${bytes} bytes.`);
}

function shapeWords(shape: { readonly width: number; readonly height: number } | null): string | null {
  return shape ? `${shape.width}x${shape.height}` : null;
}

function sampleDark(data: Uint8Array, shape: { readonly width: number; readonly height: number; readonly stride: number }, format: string, x: number, y: number): boolean {
  if (format === "i420") return data[y * shape.width + x]! < 128;
  const at = y * shape.stride + x * 4;
  return data[at]! + data[at + 1]! + data[at + 2]! < 384;
}

async function stream(): Promise<void> {
  const format = options.format;
  const code = FORMATS[format];
  if (code === undefined || (format !== "i420" && format !== "rbga")) throw new Error("--format is i420 or rbga.");
  const scale = Number(options.scale);
  const seconds = Number(options.seconds);
  const warm = Number(options.warm);
  const encodeFrames = !options["no-encode"];
  const client = new GrpcClient({ socket: options.socket });
  const companion = await companionPid(options.socket);
  let helper: ChildProcess | null = null;
  const reader = new UnitReader();
  const inFlight: RawFrame[] = [];
  const frames: RawFrame[] = [];
  let busyEncoding = false;
  let waiting: { readonly frame: RawFrame; readonly data: Uint8Array; readonly shape: ReturnType<typeof frameShape> } | null = null;
  let dropped = 0;
  let encoderWords = "";
  const send = () => {
    if (busyEncoding || !waiting || !helper) return;
    const { frame, data, shape } = waiting;
    waiting = null;
    busyEncoding = true;
    inFlight.push(frame);
    const head = Buffer.alloc(format === "rbga" ? 13 : 9);
    head.write(format === "rbga" ? "B" : "I", 0, "latin1");
    head.writeUInt32LE(shape.width, 1);
    head.writeUInt32LE(shape.height, 5);
    if (format === "rbga") head.writeUInt32LE(shape.stride, 9);
    helper.stdin!.write(head);
    helper.stdin!.write(format === "rbga" ? data.subarray(0, shape.stride * shape.height) : data);
  };
  if (encodeFrames) {
    const args = [...(options.encoder ? ["--encoder", options.encoder] : []), "--threads", options.threads, "--bitrate", options.bitrate];
    helper = spawn(options.helper, args, { stdio: ["pipe", "pipe", "pipe"] });
    helper.stderr!.setEncoding("utf8");
    helper.stderr!.on("data", (text: string) => (encoderWords += text));
    helper.stdout!.on("data", (chunk: Buffer) => {
      for (const unit of reader.push(chunk)) {
        const frame = inFlight.shift();
        busyEncoding = false;
        if (frame) {
          frame.encodedAt = performance.now();
          frame.encodeMicros = unit.encodeMicros;
          frame.bytesOut = unit.data.byteLength;
        }
        send();
      }
    });
  }
  let stop!: () => void;
  const stopped = new Promise<void>((resolve) => (stop = resolve));
  const controller = new AbortController();
  const [pointX, pointY] = options.point.split(",").map(Number) as [number, number];
  const began = performance.now();
  let firstAt = NaN;
  let shape: ReturnType<typeof frameShape> | null = null;
  let streamError = "";
  const reading = (async () => {
    try {
      for await (const output of openStream(client, code, scale, Number(options.fps), stopped, controller.signal)) {
        if (!output.data?.byteLength) continue;
        const at = performance.now();
        if (Number.isNaN(firstAt)) firstAt = at - began;
        shape ??= frameShape(output.data.byteLength, format, scale);
        const frame: RawFrame = { at, dark: sampleDark(output.data, shape, format, Math.round(pointX * Number(options.width) / 402 * scale), Math.round(pointY * Number(options.height) / 874 * scale)), encodedAt: NaN, encodeMicros: NaN, bytesOut: 0 };
        frames.push(frame);
        if (!encodeFrames) continue;
        if (waiting) dropped++;
        waiting = { frame, data: output.data, shape };
        send();
      }
    } catch (cause) {
      streamError = cause instanceof Error ? cause.message : String(cause);
    }
  })();
  while (Number.isNaN(firstAt) && performance.now() - began < 15_000) await wait(10);
  await wait(warm * 1000);
  const cpuBefore = { companion: companion ? await cpuSecondsOf(companion) : null, helper: helper?.pid ? await cpuSecondsOf(helper.pid) : null, node: process.cpuUsage() };
  const windowStart = performance.now();
  const taps: number[] = [];
  const tapCount = Number(options.taps);
  const tapping = (async () => {
    if (!tapCount) return;
    const hid = new GrpcClient({ socket: options.socket });
    const press = (direction: number) => encode(IDB_SCHEMA, "idb.HIDEvent", { press: { action: { touch: { point: { x: pointX, y: pointY } } }, direction } });
    const gap = Number(options["tap-gap"]);
    for (let index = 0; index < tapCount && performance.now() - windowStart < (seconds - 2) * 1000; index++) {
      const last = frames.at(-1);
      const before = last?.dark;
      const count = frames.length;
      const sent = performance.now();
      for await (const _ of hid.call(GRPC_METHODS.idb.hid, [press(0), press(1)])) void _;
      let shown = NaN;
      while (performance.now() - sent < 3000) {
        const flipped = frames.slice(count).find((frame) => frame.dark !== before);
        if (flipped && (!encodeFrames || !Number.isNaN(flipped.encodedAt))) {
          shown = (encodeFrames ? flipped.encodedAt : flipped.at) - sent;
          break;
        }
        await wait(1);
      }
      taps.push(shown);
      await wait(gap);
    }
    hid.close();
  })();
  await wait(seconds * 1000);
  await tapping;
  const windowEnd = performance.now();
  const cpuAfter = { companion: companion ? await cpuSecondsOf(companion) : null, helper: helper?.pid ? await cpuSecondsOf(helper.pid) : null, node: process.cpuUsage(cpuBefore.node) };
  stop();
  setTimeout(() => controller.abort(), 1000).unref();
  await reading;
  client.close();
  helper?.stdin!.end();
  const inside = frames.filter((frame) => frame.at >= windowStart && frame.at <= windowEnd);
  const encoded = inside.filter((frame) => !Number.isNaN(frame.encodedAt));
  const span = (windowEnd - windowStart) / 1000;
  const gaps = inside.slice(1).map((frame, at) => frame.at - inside[at]!.at);
  const cores = (before: number | null, after: number | null) => (before === null || after === null ? null : +((after - before) / span).toFixed(2));
  const validTaps = taps.filter(Number.isFinite);
  console.log(
    JSON.stringify({
      label: options.label,
      format,
      scale,
      frame: shapeWords(shape),
      firstFrameMs: Math.round(firstAt),
      receivedFps: +(inside.length / span).toFixed(1),
      encodedFps: +(encoded.length / span).toFixed(1),
      dropped,
      worstGapMs: Math.round(Math.max(0, ...gaps)),
      encodeMs: { median: +(median(encoded.map((frame) => frame.encodeMicros)) / 1000).toFixed(2), p95: +(quantile(encoded.map((frame) => frame.encodeMicros), 0.95) / 1000).toFixed(2) },
      queueToEncodedMs: +median(encoded.map((frame) => frame.encodedAt - frame.at)).toFixed(1),
      mbitPerSecond: +((encoded.reduce((sum, frame) => sum + frame.bytesOut, 0) * 8) / span / 1e6).toFixed(2),
      cores: { companion: cores(cpuBefore.companion, cpuAfter.companion), helper: cores(cpuBefore.helper, cpuAfter.helper), node: +((cpuAfter.node.user + cpuAfter.node.system) / 1e6 / span).toFixed(2) },
      taps: validTaps.length ? { count: taps.length, shown: validTaps.length, median: Math.round(median(validTaps)), p95: Math.round(quantile(validTaps, 0.95)), worst: Math.round(Math.max(...validTaps)) } : taps.length ? { count: taps.length, shown: 0 } : null,
      encoder: encoderWords.split("\n")[0]?.replace(/^bb-box-h264: /, "") ?? "",
      error: streamError,
    }),
  );
}

async function direct(): Promise<void> {
  const scale = Number(options.scale);
  const seconds = Number(options.seconds);
  const args = ["--simulator", options.udid, "--scale", String(Math.round(scale * 1000)), ...(options.encoder ? ["--encoder", options.encoder] : []), "--threads", options.threads, "--bitrate", options.bitrate, "--fps", options.fps === "0" ? "60" : options.fps];
  const helper = spawn(options.helper, args, { stdio: ["pipe", "pipe", "pipe"] });
  let words = "";
  helper.stderr!.setEncoding("utf8");
  helper.stderr!.on("data", (text: string) => (words += text));
  const reader = new UnitReader();
  const units: { readonly at: number; readonly bytes: number; readonly key: boolean; readonly encodeMicros: number; readonly size: string }[] = [];
  const began = performance.now();
  helper.stdout!.on("data", (chunk: Buffer) => {
    for (const unit of reader.push(chunk)) units.push({ at: performance.now(), bytes: unit.data.byteLength, key: unit.key, encodeMicros: unit.encodeMicros, size: `${unit.width}x${unit.height}` });
  });
  while (!units.length && performance.now() - began < 15_000) await wait(10);
  const firstAt = units.length ? units[0]!.at - began : NaN;
  await wait(Number(options.warm) * 1000);
  const cpuBefore = helper.pid ? await cpuSecondsOf(helper.pid) : null;
  const windowStart = performance.now();
  const taps: number[] = [];
  const tapCount = Number(options.taps);
  const [pointX, pointY] = options.point.split(",").map(Number) as [number, number];
  const tapping = (async () => {
    if (!tapCount || !options.socket) return;
    const hid = new GrpcClient({ socket: options.socket });
    const press = (direction: number) => encode(IDB_SCHEMA, "idb.HIDEvent", { press: { action: { touch: { point: { x: pointX, y: pointY } } }, direction } });
    for (let index = 0; index < tapCount && performance.now() - windowStart < (seconds - 2) * 1000; index++) {
      const recent = units.slice(-30).map((unit) => unit.bytes);
      const large = options.still ? Math.max(10 * median(recent), 1_000) : Math.max(4 * median(recent), 20_000);
      const count = units.length;
      const sent = performance.now();
      for await (const _ of hid.call(GRPC_METHODS.idb.hid, [press(0), press(1)])) void _;
      let shown = NaN;
      while (performance.now() - sent < 3000) {
        const flipped = units.slice(count).find((unit) => unit.bytes > large);
        if (flipped) {
          shown = flipped.at - sent;
          break;
        }
        await wait(1);
      }
      taps.push(shown);
      await wait(Number(options["tap-gap"]));
    }
    hid.close();
  })();
  await wait(seconds * 1000);
  await tapping;
  const windowEnd = performance.now();
  const cpuAfter = helper.pid ? await cpuSecondsOf(helper.pid) : null;
  helper.stdin!.end();
  const inside = units.filter((unit) => unit.at >= windowStart && unit.at <= windowEnd);
  const span = (windowEnd - windowStart) / 1000;
  const gaps = inside.slice(1).map((unit, at) => unit.at - inside[at]!.at);
  const validTaps = taps.filter(Number.isFinite);
  console.log(
    JSON.stringify({
      label: options.label,
      source: "framebuffer",
      scale,
      frame: inside[0]?.size ?? null,
      firstFrameMs: Math.round(firstAt),
      encodedFps: +(inside.length / span).toFixed(1),
      worstGapMs: Math.round(Math.max(0, ...gaps)),
      encodeMs: { median: +(median(inside.map((unit) => unit.encodeMicros)) / 1000).toFixed(2), p95: +(quantile(inside.map((unit) => unit.encodeMicros), 0.95) / 1000).toFixed(2) },
      mbitPerSecond: +((inside.reduce((sum, unit) => sum + unit.bytes, 0) * 8) / span / 1e6).toFixed(2),
      cores: { helper: cpuBefore === null || cpuAfter === null ? null : +((cpuAfter - cpuBefore) / span).toFixed(2) },
      taps: validTaps.length ? { count: taps.length, shown: validTaps.length, median: Math.round(median(validTaps)), p95: Math.round(quantile(validTaps, 0.95)), worst: Math.round(Math.max(...validTaps)) } : taps.length ? { count: taps.length, shown: 0 } : null,
      unitBytes: { median: median(inside.map((unit) => unit.bytes)), p95: quantile(inside.map((unit) => unit.bytes), 0.95) },
      encoder: words.split("\n")[0]?.replace(/^bb-box-h264: /, "") ?? "",
    }),
  );
}

const steps: Record<string, () => Promise<void>> = { formats, stream, direct };
const step = steps[positionals[0] ?? ""];
if (!step) {
  console.error(`usage: software.ts ${Object.keys(steps).join("|")} --socket <idb socket> [options]`);
  process.exit(2);
}
await step();
process.exit(0);
