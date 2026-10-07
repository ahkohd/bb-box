import assert from "node:assert/strict";
import { test } from "node:test";
import { LosslessRefresh, STILL_MS, type Area } from "../src/app/rfb-refresh.ts";

/** A refresh whose asks and returns to JPEG are recorded in order. */
function recorded() {
  const calls: string[] = [];
  const refresh = new LosslessRefresh({ ask: (area: Area) => calls.push(`ask ${area.join(",")}`), back: () => calls.push("back") });
  /** One update: its rects, each [x, y, width, height, lossy]. */
  const update = (...rects: [number, number, number, number, boolean][]) => {
    for (const [x, y, width, height, lossy] of rects) refresh.drawn([x, y, width, height], lossy);
    refresh.updated();
  };
  return { calls, refresh, update };
}

test("a still screen drawn as JPEG is asked for again losslessly, once, and JPEG again after the answer (056)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, refresh, update } = recorded();
  update([0, 0, 100, 50, true], [100, 20, 50, 100, true]);
  t.mock.timers.tick(STILL_MS - 1);
  assert.deepEqual(calls, [], "not while it may still move");
  t.mock.timers.tick(1);
  assert.deepEqual(calls, ["ask 0,0,150,120"], "the area of both rects");
  assert.equal(refresh.asking, true);
  update([0, 0, 150, 120, false]);
  assert.deepEqual(calls, ["ask 0,0,150,120", "back"]);
  assert.equal(refresh.asking, false);
  t.mock.timers.tick(STILL_MS * 4);
  assert.deepEqual(calls, ["ask 0,0,150,120", "back"], "nothing more once it is exact");
});

test("motion is not asked for: the wait starts again with each update that draws", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, update } = recorded();
  for (let frame = 0; frame < 30; frame++) {
    update([0, frame, 200, 100, true]);
    t.mock.timers.tick(16);
  }
  assert.deepEqual(calls, []);
  t.mock.timers.tick(STILL_MS);
  assert.deepEqual(calls, ["ask 0,0,200,129"]);
});

test("an update that draws nothing, as a cursor's, neither ends an ask nor starts the wait again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, update } = recorded();
  update([10, 10, 20, 20, true]);
  t.mock.timers.tick(STILL_MS - 50);
  update();
  t.mock.timers.tick(50);
  assert.deepEqual(calls, ["ask 10,10,20,20"], "the empty update did not delay it");
  update();
  assert.deepEqual(calls, ["ask 10,10,20,20"], "an empty update is not the answer");
  update([10, 10, 20, 20, false]);
  assert.deepEqual(calls, ["ask 10,10,20,20", "back"]);
});

test("a screen drawn exactly is never asked for, and stop drops a wait", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, refresh, update } = recorded();
  update([0, 0, 1920, 1080, false]);
  t.mock.timers.tick(STILL_MS * 4);
  assert.deepEqual(calls, []);
  update([0, 0, 10, 10, true]);
  refresh.stop();
  t.mock.timers.tick(STILL_MS * 4);
  assert.deepEqual(calls, []);
});

test("motion that comes back during an ask ends it, and the JPEG it drew is asked for once still again", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, update } = recorded();
  update([0, 0, 100, 100, true]);
  t.mock.timers.tick(STILL_MS);
  update([0, 0, 100, 100, false], [0, 100, 100, 100, true]);
  assert.deepEqual(calls, ["ask 0,0,100,100", "back"]);
  t.mock.timers.tick(STILL_MS);
  assert.deepEqual(calls, ["ask 0,0,100,100", "back", "ask 0,100,100,100"]);
});

test("a server that answers each ask with JPEG is asked three times, then no more", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { calls, update } = recorded();
  update([0, 0, 50, 50, true]);
  for (let ask = 0; ask < 5; ask++) {
    t.mock.timers.tick(STILL_MS);
    update([0, 0, 50, 50, true]);
  }
  t.mock.timers.tick(STILL_MS * 4);
  assert.deepEqual(calls, ["ask 0,0,50,50", "back", "ask 0,0,50,50", "back", "ask 0,0,50,50", "back"]);
});

test("an empty area is not drawn", () => {
  const refresh = new LosslessRefresh({ ask: () => assert.fail("asked"), back: () => assert.fail("back") }, 0);
  refresh.drawn([5, 5, 0, 10], true);
  refresh.updated();
  refresh.stop();
});
