import assert from "node:assert/strict";
import { test } from "node:test";
import { allocationLines, gcLines, ownerOf, profileLoop, summarise, type CpuProfile } from "../src/plugin/profile.ts";

const frame = (functionName: string, url = "", lineNumber = 0) => ({ functionName, url, lineNumber });

test("a profile's summary names a long busy span by the frames it ran under, files from bb-box's folder, and the functions with time of their own", () => {
  // root > idle; root > handler (src/plugin/rpc.ts:11) > slow (src/core/views.ts:41); root > node's own code.
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3, 5] },
      { id: 2, callFrame: frame("(idle)") },
      { id: 3, callFrame: frame("handler", "file:///srv/plugins/bb-box/src/plugin/rpc.ts", 10), children: [4] },
      { id: 4, callFrame: frame("slow", "file:///srv/plugins/bb-box/src/core/views.ts", 40) },
      { id: 5, callFrame: frame("processTicksAndRejections", "node:internal/process/task_queues", 1) },
    ],
    // 1 ms samples: 50 idle, 300 in slow, 20 idle, 30 in handler alone, 100 idle.
    samples: [...Array(50).fill(2), ...Array(300).fill(4), ...Array(20).fill(2), ...Array(30).fill(3), ...Array(100).fill(2)],
    timeDeltas: Array(500).fill(1000),
  };
  assert.deepEqual(summarise(profile, 1), [
    "A CPU profile of BB's server, which runs bb-box, over 1 s: busy 66% of it, with 1 span busy for 100 ms or more, the longest 300 ms.",
    "Busy time by whose code it ran under: bb-box 330 ms (100%), other plugins 0 ms (0%), BB 0 ms (0%), Node alone 0 ms (0%), garbage collection 0 ms (0%), V8 and native code with no JavaScript frame 0 ms (0%).",
    "Busy 300 ms from 0.1 s, under: slow (src/core/views.ts:41) 100%, handler (src/plugin/rpc.ts:11) 100%.",
    "Most time of their own: slow (src/core/views.ts:41) 300 ms, handler (src/plugin/rpc.ts:11) 30 ms.",
  ]);
});

test("busy time goes to bb-box when bb-box's code is anywhere under it, as what it calls of BB's runs for it, then to another plugin, BB, Node, or garbage collection", () => {
  // root > bb's handler > bb-box's relay > bb's storage write; root > another plugin; root > bb alone; root > gc.
  const profile: CpuProfile = {
    nodes: [
      { id: 1, callFrame: frame("(root)"), children: [2, 3, 6, 7, 8] },
      { id: 2, callFrame: frame("(idle)") },
      { id: 3, callFrame: frame("handle", "file:///app/server/dist/server.js", 1), children: [4] },
      { id: 4, callFrame: frame("relay", "file:///data/plugins/bb-box/src/core/selkies.ts", 1), children: [5] },
      { id: 5, callFrame: frame("set", "file:///app/server/dist/kv.js", 1) },
      { id: 6, callFrame: frame("tick", "file:///data/plugins/other/index.js", 1) },
      { id: 7, callFrame: frame("route", "file:///app/server/dist/server.js", 9) },
      { id: 8, callFrame: frame("(garbage collector)") },
    ],
    samples: [...Array(10).fill(2), ...Array(40).fill(5), ...Array(20).fill(6), ...Array(30).fill(7), ...Array(10).fill(8)],
    timeDeltas: Array(110).fill(1000),
  };
  assert.equal(
    summarise(profile, 1)[1],
    "Busy time by whose code it ran under: bb-box 40 ms (40%), other plugins 20 ms (20%), BB 30 ms (30%), Node alone 0 ms (0%), garbage collection 10 ms (10%), V8 and native code with no JavaScript frame 0 ms (0%).",
  );
  assert.deepEqual(["node:fs", "file:///x/bb-box/a.ts", "file:///data/plugins/canvas/b.js", "file:///app/c.js", ""].map(ownerOf), ["node", "bb-box", "plugin", "bb", null]);
});

test("the long garbage collections are summed, with the heap after each major one", () => {
  const MiB = 1024 * 1024;
  assert.deepEqual(gcLines([], 100, { used_heap_size: 120 * MiB, heap_size_limit: 4096 * MiB }), ["No garbage collection took 10 ms or more; the heap went from 100 to 120 MiB used, of 4096 MiB at most."]);
  assert.deepEqual(
    gcLines(
      [
        { at: 1200, ms: 342, major: true, heapMiB: 610.4, oldMiB: 540 },
        { at: 3000, ms: 12, major: false, heapMiB: 700, oldMiB: 541 },
      ],
      800,
      { used_heap_size: 650 * MiB, heap_size_limit: 4096 * MiB },
    ),
    [
      "Garbage collections of 10 ms or more: 1 major, 342 ms, and 1 other, 12 ms; the heap went from 800 to 650 MiB used, of 4096 MiB at most.",
      "Each major one, at its start: 1.2 s 342 ms, then 610 MiB used, 540 MiB old.",
    ],
  );
});

test("one profile runs at a time, for whole seconds of at most 60", async () => {
  const first = profileLoop(1);
  await assert.rejects(profileLoop(1), /A profile of BB's server is running already: one runs at a time\./);
  const lines = await first;
  assert.match(lines[0]!, /^A CPU profile of BB's server, which runs bb-box, over 1 s: busy \d+% of it/);
  // Free again once it ends.
  assert.match((await profileLoop(0.4))[0]!, /over 1 s/);
});

test("the allocations sampled are summed by whose code made them, and the sites that made most", () => {
  const MiB = 1024 * 1024;
  const node = (functionName: string, url: string, selfSize: number, children: object[] = []) => ({ callFrame: frame(functionName, url, 0), selfSize, children });
  const profile = {
    head: node("(root)", "", 0, [
      node("handle", "file:///app/server/dist/server.js", 1 * MiB, [node("relay", "file:///data/plugins/bb-box/src/core/selkies.ts", 6 * MiB, [node("parse", "file:///app/server/dist/json.js", 2 * MiB)])]),
      node("tick", "file:///data/plugins/other/index.js", 3 * MiB),
    ]),
  } as Parameters<typeof allocationLines>[0];
  assert.deepEqual(allocationLines(profile, 60), [
    "Allocations sampled over 60 s, by whose code made them: bb-box 8.0 MiB, other plugins 3.0 MiB, BB 1.0 MiB, Node alone 0.0 MiB, with no JavaScript frame 0.0 MiB.",
    "Allocated most: relay (src/core/selkies.ts:1) 6.0 MiB, tick (index.js:1) 3.0 MiB, parse (json.js:1) 2.0 MiB, handle (server.js:1) 1.0 MiB.",
  ]);
});

test("a profile with allocations sampled tells them and what starting a process costs here", async () => {
  let heap: unknown = null;
  const lines = await profileLoop(1, { allocations: async (profile) => ((heap = profile), "kept at test") });
  assert.ok(heap && typeof heap === "object" && "head" in heap);
  assert.ok(lines.some((line) => line.startsWith("Allocations sampled over 1 s, by whose code made them: bb-box ")));
  assert.ok(lines.includes("The allocations are kept at test."));
  assert.match(lines.at(-1)!, /^Starting a process here held the loop for \d+\.\d ms, \d+\.\d ms, \d+\.\d ms, as the spawn call forks BB's server with \d+ MiB in use\.$/);
});
