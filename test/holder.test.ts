// How bb-box's server calls its host entry to hold the thread's access on a
// box (src/plugin/holder.ts), and the host entry itself (src/host/access.ts).

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { accessEntry } from "../src/host/access.ts";
import { Holders, RETIRED_TITLE, type RetiredTerminals } from "../src/plugin/holder.ts";

function world() {
  let clock = 1_000_000;
  const calls: { hostId: string; names: readonly string[] }[] = [];
  const errors: string[] = [];
  const sessions = new Map<string, { id: string; hostId: string; title: string; status: string }>([
    ["term_old", { id: "term_old", hostId: "host_a", title: RETIRED_TITLE, status: "running" }],
    ["term_mine", { id: "term_mine", hostId: "host_a", title: "a person's shell", status: "running" }],
  ]);
  let failing = false;
  const terminals: RetiredTerminals = {
    list: async ({ scope }) => ({ sessions: [...sessions.values()].filter((session) => session.hostId === scope.hostId) }),
    close: async ({ terminalId }) => {
      sessions.get(terminalId)!.status = "exited";
      return {};
    },
  };
  const holders = new Holders({
    access: async (hostId, names) => {
      calls.push({ hostId, names });
      if (failing) throw new Error("the worker did not answer");
    },
    terminals: () => terminals,
    logError: (operation) => errors.push(operation),
    now: () => clock,
  });
  return { holders, calls, errors, sessions, advance: (ms: number) => (clock += ms), fail: (value: boolean) => (failing = value) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test("a machine's access is held with one call, called again after 30 s or for other names, and the old terminal is closed", async () => {
  const w = world();
  await Promise.all([w.holders.ensure("host_a", ["GH_TOKEN"]), w.holders.ensure("host_a", ["GH_TOKEN"])]);
  assert.equal(w.calls.length, 1, "two commands at once make one call");
  await w.holders.ensure("host_a", ["GH_TOKEN"]);
  assert.equal(w.calls.length, 1);
  w.advance(30_000);
  await w.holders.ensure("host_a", ["GH_TOKEN"]);
  await w.holders.ensure("host_a", ["GH_TOKEN", "MACHINE_VAR"]);
  assert.deepEqual(w.calls.map((call) => call.names), [["GH_TOKEN"], ["GH_TOKEN"], ["GH_TOKEN", "MACHINE_VAR"]]);
  w.holders.forget("host_a");
  await w.holders.ensure("host_a", ["GH_TOKEN", "MACHINE_VAR"]);
  assert.equal(w.calls.length, 4, "a machine whose worker ended is called at once");

  await settle();
  assert.equal(w.sessions.get("term_old")?.status, "exited");
  assert.equal(w.sessions.get("term_mine")?.status, "running", "only bb-box's own terminal is closed");
  assert.deepEqual(w.errors, []);
});

test("a call that fails is logged, commands go on, bb-box calls again after 30 s, and the old terminal stays until a call works", async () => {
  const w = world();
  w.fail(true);
  await w.holders.ensure("host_a", ["GH_TOKEN"]);
  await w.holders.ensure("host_a", ["GH_TOKEN"]);
  assert.deepEqual(w.errors, ["access holder"]);
  await settle();
  assert.equal(w.sessions.get("term_old")?.status, "running", "the box keeps its last source");
  w.fail(false);
  w.advance(30_000);
  await w.holders.ensure("host_a", ["GH_TOKEN"]);
  await settle();
  assert.equal(w.calls.length, 2);
  assert.equal(w.sessions.get("term_old")?.status, "exited");
});

/** The variables process `pid` started with, by name. */
function environ(pid: number): Map<string, string> {
  return new Map(
    readFileSync(`/proc/${pid}/environ`, "utf8")
      .split("\0")
      .filter(Boolean)
      .map((entry) => [entry.slice(0, entry.indexOf("=")), entry.slice(entry.indexOf("=") + 1)] as const),
  );
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 10));
  return !alive(pid);
}

test("the host entry holds a process with the call's variables, kept until they change, with a lease on its worker", { skip: process.platform !== "linux" && "reads /proc" }, async (t) => {
  const harness = experimental_createHostEntryHarness(accessEntry({ command: ["sleep", "300"] }));
  t.after(() => harness.experimental_dispose());
  const saved = process.env.BBBOX_TEST_TOKEN;
  t.after(() => (saved === undefined ? delete process.env.BBBOX_TEST_TOKEN : (process.env.BBBOX_TEST_TOKEN = saved)));

  // BB's worker puts the daemon's current variables in process.env for each call.
  process.env.BBBOX_TEST_TOKEN = "value-one";
  const first = await harness.experimental_call("access", { names: ["BBBOX_TEST_TOKEN"] });
  assert.equal(first.started, true);
  assert.equal(environ(first.pid!).get("BBBOX_TEST_TOKEN"), "value-one");
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 1);

  const again = await harness.experimental_call("access", { names: ["BBBOX_TEST_TOKEN"] });
  assert.deepEqual(again, { started: false, pid: first.pid }, "the same values keep the same process");

  process.env.BBBOX_TEST_TOKEN = "value-two";
  const changed = await harness.experimental_call("access", { names: ["BBBOX_TEST_TOKEN"] });
  assert.equal(changed.started, true);
  assert.equal(environ(changed.pid!).get("BBBOX_TEST_TOKEN"), "value-two");
  assert.ok(await gone(first.pid!), "the old process ends once the new one runs");
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 1, "one lease, however many calls");

  await harness.experimental_dispose();
  assert.ok(await gone(changed.pid!), "the process ends with the worker");
  assert.equal(harness.experimental_getRetainedWorkerLeaseCount(), 0);
});
