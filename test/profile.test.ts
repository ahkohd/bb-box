import assert from "node:assert/strict";
import { test } from "node:test";
import { profileLoop, summarise, type CpuProfile } from "../src/plugin/profile.ts";

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
    "Busy 300 ms from 0.1 s, under: slow (src/core/views.ts:41) 100%, handler (src/plugin/rpc.ts:11) 100%.",
    "Most time of their own: slow (src/core/views.ts:41) 300 ms, handler (src/plugin/rpc.ts:11) 30 ms.",
  ]);
});

test("one profile runs at a time, for whole seconds of at most 30", async () => {
  const first = profileLoop(1);
  await assert.rejects(profileLoop(1), /A profile of BB's server is running already: one runs at a time\./);
  const lines = await first;
  assert.match(lines[0]!, /^A CPU profile of BB's server, which runs bb-box, over 1 s: busy \d+% of it/);
  // Free again once it ends.
  assert.match((await profileLoop(0.4))[0]!, /over 1 s/);
});
