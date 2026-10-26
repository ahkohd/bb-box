import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { H264Encoder, H264EncoderStopped, UNIT_HEADER_BYTES, UnitReader, type EncodedFrame, type H264EncoderName } from "../src/device/h264-encoder.ts";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_HELPER = join(here, "fake-h264.mjs");
const BUILT_HELPER = process.env.BB_BOX_H264;
const BUILT_ENCODERS = (process.env.BB_BOX_H264_ENCODERS ?? "x264 openh264").split(/\s+/).filter(Boolean) as H264EncoderName[];

function unitBytes(data: number[], key: boolean, width: number, height: number, micros: number): Buffer {
  const head = Buffer.alloc(UNIT_HEADER_BYTES);
  head.writeUInt32LE(data.length, 0);
  head[4] = key ? 1 : 0;
  head.writeUInt32LE(width, 5);
  head.writeUInt32LE(height, 9);
  head.writeUInt32LE(micros, 13);
  return Buffer.concat([head, Buffer.from(data)]);
}

function solidFrame(width: number, height: number, rgb: readonly [number, number, number], generation = 1) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let i = 0; i < bytes.length; i += 3) bytes.set(rgb, i);
  return { width, height, rgb: bytes, generation };
}

function stripedFrame(width: number, height: number, offset: number, generation = 1) {
  const bytes = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = (y * width + x) * 3;
      const on = Math.floor((y + offset) / 8) % 2 === 0;
      bytes[at] = on ? 230 : 20;
      bytes[at + 1] = (x * 255) / width;
      bytes[at + 2] = on ? 40 : 200;
    }
  return { width, height, rgb: bytes, generation };
}

async function take(frames: AsyncIterator<EncodedFrame>, count: number, withinMs = 5000): Promise<EncodedFrame[]> {
  const taken: EncodedFrame[] = [];
  const deadline = new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`fewer than ${count} frames in ${withinMs} ms`)), withinMs).unref());
  while (taken.length < count) {
    const next = await Promise.race([frames.next(), deadline]);
    if (next.done) break;
    taken.push(next.value);
  }
  return taken;
}

function nalUnits(data: Uint8Array): Uint8Array[] {
  const starts: number[] = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) {
      starts.push(i + 3);
      i += 2;
    }
  }
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1]! - 3 : data.length;
    while (end > start && data[end - 1] === 0) end--;
    return data.subarray(start, end);
  });
}

const nalTypes = (data: Uint8Array) => nalUnits(data).map((nal) => nal[0]! & 31);

function spsOf(data: Uint8Array): { profile: number; constraints: number; width: number; height: number } {
  const nal = nalUnits(data).find((unit) => (unit[0]! & 31) === 7);
  assert.ok(nal, "no SPS in the unit");
  const bytes: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    bytes.push(nal[i]!);
  }
  let bit = 24;
  const read = (count: number) => {
    let value = 0;
    for (let n = 0; n < count; n++, bit++) value = value * 2 + ((bytes[bit >> 3]! >> (7 - (bit & 7))) & 1);
    return value;
  };
  const golomb = () => {
    let zeros = 0;
    while (read(1) === 0) zeros++;
    return 2 ** zeros - 1 + read(zeros);
  };
  const profile = bytes[0]!;
  const constraints = bytes[1]!;
  golomb();
  golomb();
  const pocType = golomb();
  if (pocType === 0) golomb();
  assert.notEqual(pocType, 1, "a picture order count of type 1 is not parsed here");
  golomb();
  read(1);
  const widthInMacroblocks = golomb() + 1;
  const heightInMapUnits = golomb() + 1;
  const frameMacroblocksOnly = read(1);
  if (!frameMacroblocksOnly) read(1);
  read(1);
  const cropped = read(1);
  const crop = cropped ? [golomb(), golomb(), golomb(), golomb()] : [0, 0, 0, 0];
  const rows = 2 - frameMacroblocksOnly;
  return {
    profile,
    constraints,
    width: widthInMacroblocks * 16 - 2 * (crop[0]! + crop[1]!),
    height: heightInMapUnits * 16 * rows - 2 * rows * (crop[2]! + crop[3]!),
  };
}

test("units are read whole however the pipe splits them, empty answers included", () => {
  const stream = Buffer.concat([
    unitBytes([0, 0, 0, 1, 0x67, 1, 2], true, 1080, 2400, 6700),
    unitBytes([], false, 1080, 2400, 12),
    unitBytes([0, 0, 0, 1, 0x41, 9], false, 2208, 1840, 7100),
  ]);
  for (const size of [1, 3, 16, 17, 18, 64]) {
    const reader = new UnitReader();
    const units = [];
    for (let at = 0; at < stream.length; at += size) units.push(...reader.push(stream.subarray(at, at + size)));
    assert.deepEqual(
      units.map((unit) => ({ ...unit, data: [...unit.data] })),
      [
        { key: true, width: 1080, height: 2400, encodeMicros: 6700, data: [0, 0, 0, 1, 0x67, 1, 2] },
        { key: false, width: 1080, height: 2400, encodeMicros: 12, data: [] },
        { key: false, width: 2208, height: 1840, encodeMicros: 7100, data: [0, 0, 0, 1, 0x41, 9] },
      ],
      `in chunks of ${size}`,
    );
    assert.equal(reader.partial, false);
  }
});

test("a frame waiting for the helper is replaced by a newer one, so at most one is in flight and one waits", async () => {
  const folder = mkdtempSync(join(tmpdir(), "h264-"));
  const log = join(folder, "log");
  process.env.FAKE_H264_LOG = log;
  process.env.FAKE_H264_DELAY_MS = "100";
  try {
    const encoder = new H264Encoder({ helper: FAKE_HELPER });
    assert.equal(await encoder.description, "fake 1");
    for (let mark = 1; mark <= 5; mark++) encoder.submit({ ...solidFrame(4, 2, [mark, 0, 0]), generation: mark });
    const frames = await take(encoder.frames(), 2);
    assert.deepEqual(frames.map((frame) => [frame.generation, frame.key, frame.data.at(-1)]), [[1, true, 1], [5, false, 5]]);
    encoder.keyframe();
    const [key] = await take(encoder.frames(), 1);
    assert.deepEqual([key!.generation, key!.key, key!.data.at(-1)], [5, true, 5]);
    await encoder.stop();
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(commands.map((command) => command.command + (command.mark ?? "")), ["F1", "F5", "K"]);
  } finally {
    delete process.env.FAKE_H264_LOG;
    delete process.env.FAKE_H264_DELAY_MS;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a key frame asked for before any frame makes the first frame a key frame, and frames carry when they came", async () => {
  const encoder = new H264Encoder({ helper: FAKE_HELPER });
  encoder.keyframe();
  const before = performance.now();
  encoder.submit({ ...solidFrame(4, 2, [7, 0, 0]), generation: 3 });
  const [frame] = await take(encoder.frames(), 1);
  assert.equal(frame!.key, true);
  assert.equal(frame!.generation, 3);
  assert.ok(frame!.monotonicMs >= before && frame!.monotonicMs <= performance.now());
  await encoder.stop();
});

test("shared memory is named once, and each frame in it is one command with no pixels", async () => {
  const folder = mkdtempSync(join(tmpdir(), "h264-"));
  const log = join(folder, "log");
  process.env.FAKE_H264_LOG = log;
  try {
    const encoder = new H264Encoder({ helper: FAKE_HELPER, sharedMemory: join(folder, "frames") });
    assert.throws(() => encoder.submit(solidFrame(4, 2, [1, 1, 1])), /shared memory/);
    encoder.submitShared({ width: 1080, height: 2400, generation: 1 });
    await take(encoder.frames(), 1);
    await encoder.stop();
    const commands = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(commands, [{ command: "M", path: join(folder, "frames") }, { command: "S", width: 1080, height: 2400, mark: 0 }]);
  } finally {
    delete process.env.FAKE_H264_LOG;
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a frame of the wrong length is refused before it reaches the helper", async () => {
  const encoder = new H264Encoder({ helper: FAKE_HELPER });
  assert.throws(() => encoder.submit({ width: 4, height: 2, rgb: new Uint8Array(10), generation: 1 }), /has 24 bytes, not 10/);
  await encoder.stop();
});

test("when the helper stops, reading frames fails with its own words", async () => {
  process.env.FAKE_H264_FAIL_AFTER = "1";
  try {
    const encoder = new H264Encoder({ helper: FAKE_HELPER });
    encoder.submit(solidFrame(4, 2, [1, 0, 0]));
    const frames = encoder.frames();
    await take(frames, 1);
    encoder.submit(solidFrame(4, 2, [2, 0, 0]));
    await assert.rejects(frames.next(), (error: unknown) => error instanceof H264EncoderStopped && error.message === "bb-box-h264: x264 failed to encode a frame");
  } finally {
    delete process.env.FAKE_H264_FAIL_AFTER;
  }
});

test("a helper that cannot start says so", async () => {
  const encoder = new H264Encoder({ helper: join(tmpdir(), "no-such-bb-box-h264") });
  await assert.rejects(encoder.frames().next(), /bb-box-h264 did not start: spawn .*ENOENT/);
});

for (const name of BUILT_ENCODERS) {
  const skip = BUILT_HELPER ? false : "BB_BOX_H264 names no built helper";

  test(`${name}: the first frame is a key frame with SPS and PPS, at the frame's size, in constrained baseline`, { skip }, async () => {
    const encoder = new H264Encoder({ helper: BUILT_HELPER!, encoder: name });
    assert.match(await encoder.description, new RegExp(`^${name} `));
    encoder.submit(stripedFrame(1080, 2400, 0));
    const [first] = await take(encoder.frames(), 1);
    assert.equal(first!.key, true);
    assert.deepEqual(nalTypes(first!.data).filter((type) => type !== 6), [7, 8, 5]);
    const sps = spsOf(first!.data);
    assert.deepEqual([sps.width, sps.height], [1080, 2400]);
    assert.equal(sps.profile, 66);
    assert.equal(sps.constraints & 0xc0, 0xc0, "constrained baseline, as the viewer asks its browser for");
    await encoder.stop();
  });

  test(`${name}: a change on screen is a frame with no key, and a key frame on command comes on a still screen`, { skip }, async () => {
    const encoder = new H264Encoder({ helper: BUILT_HELPER!, encoder: name });
    const frames = encoder.frames();
    encoder.submit({ ...stripedFrame(640, 480, 0), generation: 1 });
    await take(frames, 1);
    encoder.submit({ ...stripedFrame(640, 480, 2), generation: 1 });
    const [changed] = await take(frames, 1);
    assert.equal(changed!.key, false);
    assert.ok(!nalTypes(changed!.data).includes(5));
    const asked = performance.now();
    encoder.keyframe();
    const [key] = await take(frames, 1);
    assert.ok(performance.now() - asked < 200, `a key frame took ${Math.round(performance.now() - asked)} ms`);
    assert.equal(key!.key, true);
    assert.deepEqual(nalTypes(key!.data).filter((type) => type !== 6), [7, 8, 5]);
    assert.equal(key!.generation, 1);
    await encoder.stop();
  });

  test(`${name}: a new size starts again with a key frame at that size`, { skip }, async () => {
    const encoder = new H264Encoder({ helper: BUILT_HELPER!, encoder: name });
    const frames = encoder.frames();
    encoder.submit({ ...stripedFrame(2208, 1840, 0), generation: 1 });
    await take(frames, 1);
    encoder.submit({ ...stripedFrame(1080, 2092, 0), generation: 2 });
    const [folded] = await take(frames, 1);
    assert.equal(folded!.key, true);
    assert.equal(folded!.generation, 2);
    const sps = spsOf(folded!.data);
    assert.deepEqual([sps.width, sps.height], [1080, 2092]);
    await encoder.stop();
  });

  test(`${name}: a frame from shared memory encodes as one from the pipe does`, { skip }, async () => {
    const folder = mkdtempSync(join(tmpdir(), "h264-"));
    try {
      const shared = join(folder, "frames");
      writeFileSync(shared, stripedFrame(320, 240, 0).rgb);
      const encoder = new H264Encoder({ helper: BUILT_HELPER!, encoder: name, sharedMemory: shared });
      encoder.submitShared({ width: 320, height: 240, generation: 4 });
      const [frame] = await take(encoder.frames(), 1);
      assert.equal(frame!.key, true);
      assert.deepEqual([spsOf(frame!.data).width, spsOf(frame!.data).height], [320, 240]);
      await encoder.stop();
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });

  test(`${name}: frames it cannot encode are refused in words`, { skip }, () => {
    const run = (input: Buffer) => spawnSync(BUILT_HELPER!, ["--encoder", name], { input });
    const command = (letter: string, width: number, height: number) => {
      const bytes = Buffer.alloc(9);
      bytes.write(letter, 0, "latin1");
      bytes.writeUInt32LE(width, 1);
      bytes.writeUInt32LE(height, 5);
      return bytes;
    };
    const odd = run(Buffer.concat([command("F", 3, 2), Buffer.alloc(18)]));
    assert.equal(odd.status, 2);
    assert.match(odd.stderr.toString(), /a frame of 3x2 has an odd side/);
    const huge = run(command("F", 8192, 2));
    assert.match(huge.stderr.toString(), /a frame of 8192x2 is outside 2x2 to 4096x4096/);
    const short = run(Buffer.concat([command("F", 4, 2), Buffer.alloc(5)]));
    assert.match(short.stderr.toString(), /the input ended inside a 4x2 frame/);
    const unknown = run(Buffer.from("Z"));
    assert.match(unknown.stderr.toString(), /unknown command byte 0x5a/);
    const noShared = run(command("S", 4, 2));
    assert.match(noShared.stderr.toString(), /a shared frame came before any shared memory was named/);
    const empty = run(Buffer.alloc(0));
    assert.equal(empty.status, 0);
  });
}
