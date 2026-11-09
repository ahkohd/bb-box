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

test("cached tree reopens without a shell call before explicit refresh", async () => {
  let calls = 0;
  const boxes = {
    async find() { return record('bx_tree', OPERATOR); },
    async runOwn() {
      calls++;
      return { exitCode: 0, stdout: `ROOT\0/home/box\0d\0folder-${calls}\0DONE\0`, stderr: '', timedOut: false, truncated: false };
    },
  } as unknown as Boxes;
  const handlers = filesHandlers(boxes);
  const context = { experimental_caller: { kind: 'client' } };
  const first = await handlers['files.tree']({ box: 'bx_tree' }, context);
  assert.equal(calls, 1);
  const cached = await handlers['files.tree']({ box: 'bx_tree' }, context);
  assert.equal(calls, 1);
  assert.equal(cached.error, null);
  if (cached.error === null && first.error === null) assert.deepEqual(cached.directories, first.directories);
  const fresh = await handlers['files.tree']({ box: 'bx_tree', refresh: true }, context);
  assert.equal(calls, 2);
  assert.notDeepEqual(fresh, cached);
});

test('tree cache separates boxes and paths and evicts least recently used bytes', async () => {
  let calls = 0;
  const filename = 'x'.repeat(1024);
  const listing = Array.from({ length: 1900 }, (_, index) => `f\0${index}-${filename}\0`).join('');
  const boxes = {
    async find(id: string) { return record(id, OPERATOR); },
    async runOwn() {
      calls++;
      return { exitCode: 0, stdout: `ROOT\0/tmp\0${listing}DONE\0`, stderr: '', timedOut: false, truncated: false };
    },
  } as unknown as Boxes;
  const handlers = filesHandlers(boxes);
  const context = { experimental_caller: { kind: 'client' } };
  const tree = (box: string, path: string) => handlers['files.tree']({ box, path }, context);
  await tree('bx_one', '/a');
  await tree('bx_two', '/a');
  await tree('bx_one', '/b');
  await tree('bx_one', '/c');
  assert.equal(calls, 4);
  await tree('bx_one', '/a');
  assert.equal(calls, 4);
  await tree('bx_one', '/d');
  assert.equal(calls, 5);
  await tree('bx_one', '/a');
  assert.equal(calls, 5);
  await tree('bx_two', '/a');
  assert.equal(calls, 6);
});

test('recursive results preserve shallow cache entries and stay fresh', async () => {
  let calls = 0;
  const listing = Array.from({ length: 1900 }, (_, index) => `f\0${index}-${'x'.repeat(1024)}\0`).join('');
  const boxes = {
    async find(id: string) { return record(id, OPERATOR); },
    async runOwn() {
      calls++;
      return { exitCode: 0, stdout: `ROOT\0/tmp\0${listing}DONE\0`, stderr: '', timedOut: false, truncated: false };
    },
  } as unknown as Boxes;
  const handlers = filesHandlers(boxes);
  const context = { experimental_caller: { kind: 'client' } };
  await handlers['files.tree']({ box: 'bx_one', path: '/shallow' }, context);
  for (let index = 0; index < 6; index++) await handlers['files.tree']({ box: 'bx_one', path: `/index-${index}`, recursive: true }, context);
  await handlers['files.tree']({ box: 'bx_one', path: '/shallow' }, context);
  assert.equal(calls, 7);
  await handlers['files.tree']({ box: 'bx_one', path: '/index-5', recursive: true }, context);
  assert.equal(calls, 8);
});
