#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const log = process.env.FAKE_H264_LOG;
const delayMs = Number(process.env.FAKE_H264_DELAY_MS ?? 0);
const failAfter = Number(process.env.FAKE_H264_FAIL_AFTER ?? Infinity);
process.stderr.write("bb-box-h264: fake 1, 8000 kbit/s, 1 thread\n");

let input = Buffer.alloc(0);
let answering = Promise.resolve();
let frames = 0;
let keyPending = true;
let last = null;

function unit(data, key, width, height) {
  const head = Buffer.alloc(17);
  head.writeUInt32LE(data.length, 0);
  head[4] = key ? 1 : 0;
  head.writeUInt32LE(width, 5);
  head.writeUInt32LE(height, 9);
  head.writeUInt32LE(1234, 13);
  return Buffer.concat([head, data]);
}

function answer(bytes) {
  answering = answering.then(() => new Promise((resolve) => setTimeout(() => {
    process.stdout.write(bytes);
    resolve();
  }, delayMs)));
}

function record(command) {
  if (log) appendFileSync(log, `${JSON.stringify(command)}\n`);
}

function take() {
  for (;;) {
    if (input.length < 1) return;
    const command = String.fromCharCode(input[0]);
    if (command === "K") {
      input = input.subarray(1);
      record({ command });
      if (last) answer(unit(Buffer.from([0, 0, 0, 1, 0x65, last.mark]), true, last.width, last.height));
      else {
        keyPending = true;
        answer(unit(Buffer.alloc(0), false, 0, 0));
      }
      continue;
    }
    if (command === "M") {
      if (input.length < 5) return;
      const length = input.readUInt32LE(1);
      if (input.length < 5 + length) return;
      record({ command, path: input.subarray(5, 5 + length).toString() });
      input = input.subarray(5 + length);
      continue;
    }
    if (command !== "F" && command !== "S") {
      process.stderr.write(`bb-box-h264: unknown command byte ${input[0]}\n`);
      process.exit(2);
    }
    if (input.length < 9) return;
    const width = input.readUInt32LE(1);
    const height = input.readUInt32LE(5);
    const size = command === "F" ? width * height * 3 : 0;
    if (input.length < 9 + size) return;
    const mark = command === "F" ? input[9] : 0;
    input = input.subarray(9 + size);
    record({ command, width, height, mark });
    frames++;
    if (frames > failAfter) {
      process.stderr.write("bb-box-h264: x264 failed to encode a frame\n");
      process.exit(2);
    }
    last = { width, height, mark };
    answer(unit(Buffer.from([0, 0, 0, 1, keyPending ? 0x65 : 0x41, mark]), keyPending, width, height));
    keyPending = false;
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  take();
});
process.stdin.on("end", () => answering.then(() => process.exit(0)));
