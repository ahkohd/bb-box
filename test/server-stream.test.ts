import assert from "node:assert/strict";
import { test } from "node:test";
import { ServerParser } from "../src/core/server-stream.ts";

function parser(width = 1920, height = 1080): ServerParser {
  return new ServerParser({ width, height, bitsPerPixel: 32 });
}

function sizeOf(stream: ServerParser): string {
  return `${stream.size.width}x${stream.size.height}`;
}

/** Feeds `bytes` one byte at a time, then as a whole to a fresh parser. */
function bothWays(bytes: Uint8Array, check: (stream: ServerParser) => void): void {
  const whole = parser();
  whole.read(bytes);
  check(whole);

  const split = parser();
  for (const byte of bytes) split.read(Uint8Array.of(byte));
  check(split);
}

function framebuffer(rectangles: Uint8Array[], count = rectangles.length): Uint8Array {
  const body = rectangles.reduce((left, right) => {
    const joined = new Uint8Array(left.byteLength + right.byteLength);
    joined.set(left);
    joined.set(right, left.byteLength);
    return joined;
  }, new Uint8Array(0));
  const bytes = new Uint8Array(4 + body.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(2, count);
  bytes.set(body, 4);
  return bytes;
}

function rectangle(encoding: number, width: number, height: number, payload: Uint8Array, x = 0, y = 0): Uint8Array {
  const bytes = new Uint8Array(12 + payload.byteLength);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, x);
  view.setUint16(2, y);
  view.setUint16(4, width);
  view.setUint16(6, height);
  view.setInt32(8, encoding);
  bytes.set(payload, 12);
  return bytes;
}

function extended(width: number, height: number, reason = 0, status = 0): Uint8Array {
  const payload = new Uint8Array(4 + 16);
  const view = new DataView(payload.buffer);
  view.setUint8(0, 1);
  view.setUint16(12, width);
  view.setUint16(14, height);
  return rectangle(-308, width, height, payload, reason, status);
}

function desktopSize(width: number, height: number): Uint8Array {
  return rectangle(-223, width, height, new Uint8Array(0));
}

test("DesktopSize and ExtendedDesktopSize set the framebuffer, and a refused resize does not", () => {
  bothWays(framebuffer([desktopSize(800, 600)]), (stream) => {
    assert.equal(sizeOf(stream), "800x600");
    assert.equal(stream.tracking, true);
  });

  bothWays(framebuffer([extended(2560, 1440)]), (stream) => {
    assert.equal(sizeOf(stream), "2560x1440");
  });

  bothWays(framebuffer([extended(800, 600, 1, 1)]), (stream) => {
    assert.equal(sizeOf(stream), "1920x1080", "a failed request from this client leaves the size");
  });
});

test("a size rectangle after pixel data is still the framebuffer", () => {
  const tight = rectangle(7, 1, 1, Uint8Array.of(0x80, 9, 8, 7));
  bothWays(framebuffer([tight, extended(1600, 900)]), (stream) => {
    assert.equal(sizeOf(stream), "1600x900");
    assert.equal(stream.tracking, true);
  });

  const zrle = rectangle(16, 2, 2, Uint8Array.of(0, 0, 0, 3, 1, 2, 3));
  bothWays(framebuffer([zrle, desktopSize(640, 480)]), (stream) => {
    assert.equal(sizeOf(stream), "640x480");
  });

  const raw = rectangle(0, 2, 1, Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  bothWays(framebuffer([raw, desktopSize(100, 50)]), (stream) => {
    assert.equal(sizeOf(stream), "100x50");
  });

  const copy = rectangle(1, 4, 4, Uint8Array.of(0, 1, 0, 2));
  bothWays(framebuffer([copy, desktopSize(320, 200)]), (stream) => {
    assert.equal(sizeOf(stream), "320x200");
  });

  const zlib = rectangle(6, 2, 2, Uint8Array.of(0, 0, 0, 2, 0xaa, 0xbb));
  bothWays(framebuffer([zlib, desktopSize(300, 200)]), (stream) => {
    assert.equal(sizeOf(stream), "300x200");
  });

  const h264 = rectangle(50, 8, 8, Uint8Array.of(0, 0, 0, 4, 0, 0, 0, 1, 9, 9, 9, 9));
  bothWays(framebuffer([h264, desktopSize(720, 480)]), (stream) => {
    assert.equal(sizeOf(stream), "720x480");
  });
});

test("cursor, names, bells and clipboard text do not hide a later size", () => {
  const cursor = rectangle(-239, 2, 2, new Uint8Array(2 * 2 * 4 + 2));
  const name = rectangle(-307, 0, 0, Uint8Array.of(0, 0, 0, 3, 98, 111, 120));
  const led = rectangle(-261, 0, 0, Uint8Array.of(2));
  const qemu = rectangle(-258, 0, 0, new Uint8Array(0));
  const pts = rectangle(-1000, 0, 0, new Uint8Array(8));
  const update = framebuffer([cursor, name, led, qemu, pts, desktopSize(1024, 768)]);

  const bell = Uint8Array.of(2);
  const cut = new Uint8Array(8 + 4);
  const view = new DataView(cut.buffer);
  view.setUint8(0, 3);
  view.setUint32(4, 4);
  cut.set([97, 98, 99, 100], 8);

  bothWays(new Uint8Array([...bell, ...cut, ...update]), (stream) => {
    assert.equal(sizeOf(stream), "1024x768");
    assert.equal(stream.tracking, true);
  });
});

test("LastRect ends the update, and an encoding with no length stops tracking", () => {
  const last = framebuffer([rectangle(-224, 0, 0, new Uint8Array(0))], 65535);
  const after = framebuffer([desktopSize(111, 222)]);
  const bytes = new Uint8Array(last.byteLength + after.byteLength);
  bytes.set(last);
  bytes.set(after, last.byteLength);

  bothWays(bytes, (stream) => {
    assert.equal(sizeOf(stream), "111x222");
    assert.equal(stream.tracking, true);
  });

  const unknown = framebuffer([rectangle(5, 16, 16, Uint8Array.of(1, 2, 3, 4)), desktopSize(10, 10)]);
  const lost = parser();
  lost.read(unknown);
  assert.equal(lost.tracking, false);
  assert.equal(sizeOf(lost), "1920x1080", "the last known size stays in force");

  lost.read(framebuffer([desktopSize(10, 10)]));
  assert.equal(sizeOf(lost), "1920x1080");
});
