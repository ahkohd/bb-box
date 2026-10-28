import { appendFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { UNIT_HEADER_BYTES } from "../src/device/h264-encoder.ts";
import { evenScaled, spsOfSize } from "./sps.ts";

const START = Uint8Array.of(0, 0, 0, 1);
const PPS = Uint8Array.of(0x68, 0xee, 0x3c, 0x80);
const IDR = Uint8Array.of(0x65, 0x88, 0x84, 0x00, 0x21);
const DELTA = Uint8Array.of(0x41, 0x9a, 0x02, 0x04);
const ENCODE_MICROS = 4_000;

const { values } = parseArgs({ options: { simulator: { type: "string" }, scale: { type: "string" }, bitrate: { type: "string" }, fps: { type: "string" }, developer: { type: "string" } }, strict: true });
const log = process.env.FAKE_H264_LOG;
if (log) appendFileSync(log, `${process.pid} simulator ${values.simulator} scale ${values.scale}\n`);
if (process.env.FAKE_H264_FAILS) {
  process.stderr.write(`bb-box-h264: ${process.env.FAKE_H264_FAILS}\n`);
  process.exit(2);
}
const scale = Number(values.scale) / 1000;
const width = evenScaled(1206, scale);
const height = evenScaled(2622, scale);

function annexB(...units: Uint8Array[]): Uint8Array {
  return Uint8Array.from(units.flatMap((unit) => [...START, ...unit]));
}

function unit(data: Uint8Array, key: boolean): Buffer {
  const head = Buffer.alloc(UNIT_HEADER_BYTES);
  head.writeUInt32LE(data.byteLength, 0);
  head[4] = key ? 1 : 0;
  head.writeUInt32LE(width, 5);
  head.writeUInt32LE(height, 9);
  head.writeUInt32LE(ENCODE_MICROS, 13);
  return Buffer.concat([head, Buffer.from(data)]);
}

process.stderr.write("bb-box-h264: x264 0.165, source b35605ace3ddf7c1a5d67a2eb553f034aef41d55, 8000 kbit/s, 1 thread\n");
process.stdout.write(unit(annexB(spsOfSize(width, height), PPS, IDR), true));
const timer = setInterval(() => process.stdout.write(unit(annexB(DELTA), false)), 30);
process.stdin.on("data", (bytes: Buffer) => {
  if (bytes.includes("K".charCodeAt(0))) process.stdout.write(unit(annexB(spsOfSize(width, height), PPS, IDR), true));
});
process.stdin.on("end", () => {
  clearInterval(timer);
  process.exit(0);
});
