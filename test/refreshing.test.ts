import assert from "node:assert/strict";
import { test } from "node:test";
import { Refreshing } from "../src/plugin/refreshing.ts";

test("a value is fetched once, then refreshed in the background once stale, while callers get the last value", async () => {
  let now = 0;
  let version = 0;
  const loads: string[] = [];
  const errors: unknown[] = [];
  let fail = false;
  let release: () => void = () => {};
  const cache = new Refreshing<string>({
    freshMs: 60_000,
    now: () => now,
    onError: (error) => errors.push(error),
    async load(key) {
      loads.push(key);
      const value = `${key}${++version}`;
      if (version > 1) await new Promise<void>((resolve) => (release = resolve));
      if (fail) throw new Error("BB is down");
      return value;
    },
  });
  // Callers share the first fetch.
  assert.deepEqual(await Promise.all([cache.get("p"), cache.get("p")]), ["p1", "p1"]);
  now = 59_999;
  assert.equal(await cache.get("p"), "p1");
  assert.deepEqual(loads, ["p"]);

  // Stale: the caller gets the last value at once, and one refresh runs.
  now = 60_000;
  assert.equal(await cache.get("p"), "p1");
  assert.equal(await cache.get("p"), "p1");
  assert.deepEqual(loads, ["p", "p"]);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(await cache.get("p"), "p2");

  // A refresh that fails keeps the last value, and is tried again once that is stale too.
  fail = true;
  now = 120_000;
  assert.equal(await cache.get("p"), "p2");
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(errors.length, 1);
  assert.equal(await cache.get("p"), "p2");
  assert.equal(loads.length, 3);
  now = 180_000;
  void cache.get("p");
  assert.equal(loads.length, 4);
  release();
});

test("a first fetch that fails reaches its callers, and the next get tries again", async () => {
  let calls = 0;
  const cache = new Refreshing<number>({
    freshMs: 60_000,
    onError: () => assert.fail("only background refreshes are reported"),
    async load() {
      if (++calls === 1) throw new Error("BB is busy");
      return calls;
    },
  });
  await assert.rejects(cache.get("system"), /BB is busy/);
  assert.equal(await cache.get("system"), 2);
  assert.equal(await cache.get("system"), 2);
});
