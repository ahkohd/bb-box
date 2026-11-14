import "./check-test-machine.mjs";
// The box's pointer from bb-box-cursor (060): its lines as events, and its
// images as the PNG the panel shows.

import assert from "node:assert/strict";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { followPointer, pointerEvent } from "../src/backends/selkies.ts";
import { argbToRgba, rgbaPng } from "../src/core/png.ts";
import type { BoxPointer, StreamOptions } from "../src/transports/types.ts";

test("bb-box-cursor's lines are pointer events, and a line it cannot have written is none", () => {
  assert.deepEqual(pointerEvent('{"enter":true}'), { type: "enter" });
  assert.deepEqual(pointerEvent('{"leave":true}'), { type: "leave" });
  assert.deepEqual(pointerEvent('{"position":[640,-3]}'), { type: "position", x: 640, y: -3 });
  const image = pointerEvent(`{"image":{"width":2,"height":1,"hotspot":[1,0],"argb":"${Buffer.from([0, 0, 255, 255, 0, 0, 0, 0]).toString("base64")}"}}`);
  assert.equal(image?.type, "image");
  assert.deepEqual(image?.type === "image" && [image.width, image.height, image.hotX, image.hotY, [...image.argb]], [2, 1, 1, 0, [0, 0, 255, 255, 0, 0, 0, 0]]);
  for (const line of ["", "not json", "{}", '{"position":[1]}', '{"position":[1.5,2]}', '{"image":{"width":2,"height":2,"hotspot":[0,0],"argb":"AAAA"}}']) {
    assert.equal(pointerEvent(line), null, line);
  }
});

test("bb-box-cursor runs in the box's session, and its output, in pieces however it comes, is read a line at a time", async () => {
  let script = "";
  const events: BoxPointer[] = [];
  const command = {
    async stream(text: string, options: StreamOptions) {
      script = text;
      const out = '{"enter":true}\n{"posi' + 'tion":[1,2]}\n{"position":[3,4]}\nnot json\n{"leave":true}';
      for (const piece of [out.slice(0, 20), out.slice(20, 33), out.slice(33)]) options.onOutput(new TextEncoder().encode(piece), "stdout");
      options.onOutput(new TextEncoder().encode('{"enter":true}\n'), "stderr");
      return { exitCode: 0, timedOut: false };
    },
  };
  await followPointer(command as never, (event) => events.push(event), new AbortController().signal);
  assert.match(script, /\. \/run\/bb-box\/display\.env/);
  assert.match(script, /exec '\/usr\/local\/libexec\/bb-box\/cursor'$/);
  // The last line has no newline yet: it is not taken, as the helper ends each line it writes.
  assert.deepEqual(events, [{ type: "enter" }, { type: "position", x: 1, y: 2 }, { type: "position", x: 3, y: 4 }]);
});

test("a cursor image is a PNG of its pixels, its colour no longer premultiplied by its alpha", () => {
  // Little-endian ARGB, as Wayland's ARGB8888: blue, green, red, alpha. A clear pixel, an opaque red one, a half-clear white one.
  const argb = Uint8Array.from([0, 0, 0, 0, 0, 0, 255, 255, 128, 128, 128, 128]);
  const rgba = argbToRgba(argb);
  assert.deepEqual([...rgba], [0, 0, 0, 0, 255, 0, 0, 255, 255, 255, 255, 128]);
  const png = rgbaPng(3, 1, rgba);
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20), png[24], png[25]], [3, 1, 8, 6], "3 by 1, 8 bits a channel, RGBA");
  const idat = png.indexOf("IDAT");
  const rows = inflateSync(png.subarray(idat + 4, idat + 4 + png.readUInt32BE(idat - 4)));
  assert.deepEqual([...rows], [0, ...rgba], "one row, unfiltered");
});
