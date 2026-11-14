import "./check-test-machine.mjs";
// What the backends with a warm pool share: an upkeep that runs once more
// when asked during a run (#355), and the record of pools short of room,
// logged once per reason (#356).

import assert from "node:assert/strict";
import { test } from "node:test";
import type { WarmShortfall } from "../src/backends/types.ts";
import { Upkeep, WarmShortfalls, warmChecks } from "../src/backends/warm.ts";

test("an upkeep asked for during a run runs once more after it, however often it was asked", async () => {
  let runs = 0;
  let open!: () => void;
  const upkeep = new Upkeep(async () => {
    runs++;
    if (runs === 1) await new Promise<void>((resolve) => (open = resolve));
  });
  const signal = new AbortController().signal;
  const first = upkeep.run(signal);
  assert.equal(upkeep.running, first);
  assert.equal(upkeep.run(signal), first, "a call during a run waits for the same one");
  void upkeep.run(signal);
  open();
  await first;
  assert.equal(runs, 2);
  assert.equal(upkeep.running, null);
  await upkeep.run(signal);
  assert.equal(runs, 3, "a call after a run starts one");
});

test("an upkeep stopped during a run does not run again, and a failed one fails its callers", async () => {
  let runs = 0;
  const stop = new AbortController();
  let open!: () => void;
  const upkeep = new Upkeep(async () => {
    runs++;
    await new Promise<void>((resolve) => (open = resolve));
  });
  const first = upkeep.run(stop.signal);
  void upkeep.run(stop.signal);
  stop.abort();
  open();
  await first;
  assert.equal(runs, 1);

  const failing = new Upkeep(async () => {
    throw new Error("no host answered");
  });
  await assert.rejects(failing.run(new AbortController().signal), /no host answered/);
  assert.equal(failing.running, null, "the next call runs again");
});

const pool = (have: number, reason: string, kinds = ["macos", "macos-desktop"]): WarmShortfall => ({ kinds, count: 2, have, reason });

test("a short pool is logged when it falls short, when its reason's words change and when it has room again, not at each upkeep", () => {
  const logs: string[] = [];
  let changes = 0;
  const shortfalls = new WarmShortfalls("tart", (message) => logs.push(message), () => changes++);
  shortfalls.set([]);
  assert.deepEqual([logs, changes], [[], 0]);

  const disk = "mac1 has 67.06 GiB of disk free beyond what Windows needs, and keeps 70 GiB free";
  shortfalls.set([pool(1, disk)]);
  shortfalls.set([pool(1, disk.replace("67.06", "66.9"))]);
  assert.equal(logs.length, 1, "other figures are the same reason");
  assert.equal(changes, 1);
  assert.deepEqual(shortfalls.list(), [pool(1, disk.replace("67.06", "66.9"))], "the list has the latest figures");

  shortfalls.set([pool(0, disk)]);
  assert.equal(logs.length, 1, "a pool with fewer boxes for the same reason is not logged again");
  assert.equal(changes, 2, "but the settings show it");

  shortfalls.set([pool(0, "mac1 is not answering")]);
  shortfalls.set([]);
  shortfalls.set([]);
  assert.deepEqual(logs, [
    `The warm pool of macos and macos-desktop on tart has 1 of its 2 boxes, and no room for another: ${disk}`,
    "The warm pool of macos and macos-desktop on tart has 0 of its 2 boxes, and no room for another: mac1 is not answering",
    "The warm pool of macos and macos-desktop on tart is no longer short of room.",
  ]);
  assert.equal(changes, 4);
  assert.deepEqual(shortfalls.list(), []);
});

test("the doctor warns of each short pool", () => {
  assert.deepEqual(warmChecks([]), []);
  assert.deepEqual(warmChecks([{ kinds: ["windows-desktop"], count: 1, have: 0, reason: "No VMID is free." }]), [
    {
      id: "warm.windows-desktop",
      name: "Warm pool of windows-desktop",
      status: "warn",
      detail: "It has 0 of its 1 box, and no room for another: No VMID is free.",
      fix: "Make room there, or lower the warm count in BB Box's settings.",
    },
  ]);
});
