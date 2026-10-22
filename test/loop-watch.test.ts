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
    "BB's server, which runs bb-box, stood still 2 times in the last minute, for up to 470 ms: desktops' frames and input waited meanwhile. " +
      "Garbage collection ran for 350 ms of it, in 1 collection, 1 of them major.",
  ]);
  // A minute without stalls says nothing; one stall without collection says so.
  for (let i = 0; i < 700; i++) tick(100);
  assert.equal(lines.length, 1);
  tick(260);
  for (let i = 0; i < 700; i++) tick(100);
  assert.equal(lines[1], "BB's server, which runs bb-box, stood still once in the last minute, for up to 260 ms: desktops' frames and input waited meanwhile. No garbage collection ran then: something else held the loop.");
  watch.dispose();
});

test("the minute's line tells the processes bb-box started and how long their spawn calls held the loop, and each hour the server's memory", () => {
  let now = 1_000;
  const lines: string[] = [];
  let spawned = { count: 10, ms: 50 };
  let longest = 0;
  const MiB = 1024 * 1024;
  const watch = new LoopWatch({
    log: (line) => lines.push(line),
    now: () => now,
    manual: true,
    spawns: () => spawned,
    longestSpawn: () => {
      const was = longest;
      longest = 0;
      return was;
    },
    memory: () => ({ rss: 3500 * MiB, heapUsed: 2100 * MiB, heapTotal: 2300 * MiB, external: 400 * MiB }),
  });
  const tick = (gap: number) => {
    now += gap;
    watch.tick();
  };
  // In the minute: 3 processes, 240 ms of spawn calls, the longest 180 ms, which is the stall.
  spawned = { count: 13, ms: 290 };
  longest = 180;
  tick(300);
  for (let i = 0; i < 600; i++) tick(100);
  assert.equal(
    lines[0],
    "BB's server, which runs bb-box, stood still once in the last minute, for up to 300 ms: desktops' frames and input waited meanwhile. No garbage collection ran then: something else held the loop. " +
      "bb-box started 3 processes in that minute, the spawn calls taking 240 ms in all, 180 ms at most.",
  );
  // The hour's line comes whatever happened, with the hour's processes.
  for (let i = 0; i < 36_000; i++) tick(100);
  assert.equal(
    lines.at(-1),
    "BB's server, which runs bb-box: its heap held 2100 MiB of 2300 MiB, 400 MiB more was outside it, and the process 3500 MiB in all; bb-box started 3 processes in the last hour, the spawn calls taking 240 ms in all.",
  );
  watch.dispose();
});
