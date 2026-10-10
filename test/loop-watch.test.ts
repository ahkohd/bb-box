import assert from "node:assert/strict";
import { test } from "node:test";
import { LoopWatch } from "../src/plugin/loop-watch.ts";

test("the event loop watch tells, once a minute, how often bb-box's loop stood still and how much of it was garbage collection", () => {
  let now = 1_000;
  const lines: string[] = [];
  const watch = new LoopWatch({ log: (line) => lines.push(line), now: () => now, manual: true });
  const tick = (gap: number) => {
    now += gap;
    watch.tick();
  };
  // Ticks on time, then a stall of 470 ms, mostly a major collection, and one of 300 ms with none.
  for (let i = 0; i < 100; i++) tick(100);
  watch.gc({ startTime: now + 50, duration: 350, major: true });
  watch.gc({ startTime: now + 20, duration: 5, major: false });
  tick(470);
  for (let i = 0; i < 100; i++) tick(100);
  tick(300);
  assert.deepEqual(lines, [], "nothing before a minute");
  for (let i = 0; i < 400; i++) tick(100);
  assert.deepEqual(lines, [
    "bb-box's event loop stood still 2 times in the last minute, for up to 470 ms: desktops' frames and input waited meanwhile. " +
      "Garbage collection ran for 350 ms of it, in 1 collection, 1 of them major.",
  ]);
  // A minute without stalls says nothing; one stall without collection says so.
  for (let i = 0; i < 700; i++) tick(100);
  assert.equal(lines.length, 1);
  tick(260);
  for (let i = 0; i < 700; i++) tick(100);
  assert.equal(lines[1], "bb-box's event loop stood still once in the last minute, for up to 260 ms: desktops' frames and input waited meanwhile. No garbage collection ran then: something else held the loop.");
  watch.dispose();
});
