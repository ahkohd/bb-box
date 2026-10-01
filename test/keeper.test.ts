// The BB terminal bb-box keeps on each enrolled box as a source of the
// thread's access (src/plugin/keeper.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { KEEPER_COMMAND, KEEPER_MAX_AGE_MS, KEEPER_TITLE, Keepers, type KeeperTerminals } from "../src/plugin/keeper.ts";

type Status = "starting" | "running" | "exited" | "disconnected";

function fakeTerminals() {
  const sessions = new Map<string, { id: string; hostId: string; title: string; status: Status; createdAt: number }>();
  const calls: string[] = [];
  let clock = 1_000_000;
  let failing = false;
  const terminals: KeeperTerminals = {
    async list({ scope }) {
      calls.push("list");
      if (failing) throw new Error("BB is busy");
      return { sessions: [...sessions.values()].filter((session) => session.hostId === scope.hostId).map((session) => ({ ...session })) };
    },
    async create({ scope, start, title }) {
      calls.push("create");
      assert.equal(start.command, KEEPER_COMMAND);
      const session = { id: `term_${sessions.size + 1}`, hostId: scope.hostId, title, status: "starting" as Status, createdAt: clock };
      sessions.set(session.id, session);
      return { ...session };
    },
    async get({ terminalId }) {
      calls.push("get");
      const session = sessions.get(terminalId)!;
      session.status = "running";
      return { ...session };
    },
    async close({ terminalId }) {
      calls.push(`close ${terminalId}`);
      sessions.get(terminalId)!.status = "exited";
      return {};
    },
  };
  return {
    terminals,
    sessions,
    calls,
    advance: (ms: number) => (clock += ms),
    now: () => clock,
    fail: (value: boolean) => (failing = value),
  };
}

const running = (fake: ReturnType<typeof fakeTerminals>) =>
  [...fake.sessions.values()].filter((session) => session.status === "running" || session.status === "starting").map((session) => session.id);

test("a machine gets one keeper, started before the command goes on, and asked about again only after a while", async () => {
  const fake = fakeTerminals();
  const errors: string[] = [];
  const keepers = new Keepers({ terminals: () => fake.terminals, logError: (operation) => errors.push(operation), now: fake.now });
  await Promise.all([keepers.ensure("host_a"), keepers.ensure("host_a")]);
  assert.deepEqual(fake.calls, ["list", "create", "get"], "two commands at once make one keeper");
  assert.equal(fake.sessions.get("term_1")?.status, "running");
  assert.equal(fake.sessions.get("term_1")?.title, KEEPER_TITLE);

  fake.calls.length = 0;
  await keepers.ensure("host_a");
  assert.deepEqual(fake.calls, [], "within 30 s, bb-box trusts what it found");
  fake.advance(30_000);
  await keepers.ensure("host_a");
  assert.deepEqual(fake.calls, ["list"], "then it looks again, and keeps the keeper it finds");

  // After a plugin reload, bb-box finds the keeper it made before.
  fake.calls.length = 0;
  await new Keepers({ terminals: () => fake.terminals, logError: () => {}, now: fake.now }).ensure("host_a");
  assert.deepEqual(fake.calls, ["list"]);
  assert.deepEqual(errors, []);
});

test("an old keeper is replaced, the new one starting before the old one closes, and one that exited is made again", async () => {
  const fake = fakeTerminals();
  const keepers = new Keepers({ terminals: () => fake.terminals, logError: () => {}, now: fake.now });
  await keepers.ensure("host_a");
  fake.advance(KEEPER_MAX_AGE_MS);
  fake.calls.length = 0;
  await keepers.ensure("host_a");
  assert.deepEqual(fake.calls, ["list", "create", "get", "close term_1"]);
  assert.deepEqual(running(fake), ["term_2"]);

  fake.sessions.get("term_2")!.status = "exited";
  fake.advance(30_000);
  await keepers.ensure("host_a");
  assert.deepEqual(running(fake), ["term_3"]);
});

test("a keeper bb-box cannot make is logged, commands go on, and bb-box tries again after a while", async () => {
  const fake = fakeTerminals();
  const errors: string[] = [];
  const keepers = new Keepers({ terminals: () => fake.terminals, logError: (operation) => errors.push(operation), now: fake.now });
  fake.fail(true);
  await keepers.ensure("host_a");
  await keepers.ensure("host_a");
  assert.deepEqual(errors, ["access keeper"], "asked once in 30 s");
  fake.fail(false);
  fake.advance(30_000);
  await keepers.ensure("host_a");
  assert.deepEqual(running(fake), ["term_1"]);
});
