import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATOR, SPARES, type BoxRecord, type Boxes } from "../src/core/boxes.ts";
import { FILES_FROM_PANEL, filesHandlers } from "../src/plugin/box-fs.ts";

function record(id: string, threadId: string): BoxRecord {
  return { id, threadId, state: "ready", device: null, capabilities: { os: "linux", command: { program: "sh" }, displays: [] } } as unknown as BoxRecord;
}

test("the files RPC opens any box that is not a spare, and refuses a plugin or a call with no caller", async () => {
  let calls = 0;
  const records = new Map<string, BoxRecord>([
    ["bx_other", record("bx_other", "thr_other")],
    ["bx_spare", record("bx_spare", SPARES)],
    ["bx_mine", record("bx_mine", OPERATOR)],
  ]);
  const boxes = {
    async find(id: string) {
      return records.get(id) ?? null;
    },
    async runOwn() {
      calls += 1;
      return { exitCode: 0, stdout: `HOME\t${Buffer.from("/home/box").toString("base64")}\n`, stderr: "", timedOut: false, truncated: false };
    },
  } as unknown as Boxes;
  const handlers = filesHandlers(boxes);
  const plugin = { experimental_caller: { kind: "plugin" } };
  for (const handler of Object.values(handlers)) {
    const answer = await (handler as (input: never, context?: { experimental_caller?: { kind: string } }) => Promise<{ error: string | null }>)({} as never, plugin);
    assert.deepEqual(answer, { error: FILES_FROM_PANEL });
  }
  assert.equal(calls, 0);
  const home = await handlers["files.home"]({ box: "bx_other" }, { experimental_caller: { kind: "client" } });
  assert.equal(home.error, null);
  if (home.error) return;
  assert.equal(home.path, "/home/box");
  const plain = await handlers["files.home"]({ box: "bx_mine" });
  assert.deepEqual(plain, { error: FILES_FROM_PANEL });
  const mine = await handlers["files.home"]({ box: "bx_mine" }, { experimental_caller: { kind: "client" } });
  assert.equal(mine.error, null);
  if (mine.error) return;
  assert.equal(mine.path, "/home/box");
  const spare = await handlers["files.home"]({ box: "bx_spare" }, { experimental_caller: { kind: "client" } });
  assert.equal(spare.error, "That box is gone.");
  assert.equal(calls, 2);
});
