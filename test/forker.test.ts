import "./check-test-machine.mjs";
// The helper that starts BB Box's short-lived child processes in place of BB's server (forker.ts).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { startChild, type ChildLike } from "../src/transports/forker.ts";
import { isSignallablePid, timedSpawn } from "../src/transports/spawns.ts";
import { stopBuildScript } from "../src/backends/tart/host.ts";
import { tempDir } from "./helpers.ts";

/** Everything a child said, and how it ended. */
function collect(child: ChildLike): Promise<{ out: string; err: string; code: number | null; signal: string | null; exitCode: number | null }> {
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return new Promise((resolve) => child.on("close", (code: number | null, signal: string | null) => resolve({ out, err, code, signal, exitCode: child.exitCode })));
}

test("a child started from the helper gets its stdin, and gives back its output, errors and exit code, in order", async () => {
  const child = startChild("sh", ["-c", "cat; echo to-err >&2; exit 3"], { site: "test" });
  const done = collect(child);
  child.stdin.write("hello ");
  child.stdin.end("world\n");
  const result = await done;
  assert.deepEqual(result, { out: "hello world\n", err: "to-err\n", code: 3, signal: null, exitCode: 3 });
  assert.ok(typeof child.pid === "number" && child.pid > 0);
});

test("a child from the helper is killed, gives its environment and folder, and a missing program is an error", async () => {
  const sleeper = startChild("sleep", ["30"], { site: "test" });
  const ended = collect(sleeper);
  await new Promise((resolve) => sleeper.once("spawn", resolve));
  assert.equal(sleeper.kill("SIGKILL"), true);
  assert.deepEqual([(await ended).signal, sleeper.signalCode], ["SIGKILL", "SIGKILL"]);

  const env = startChild("sh", ["-c", 'printf "%s %s" "$BB_FORKER_TEST" "$(pwd)"'], { env: { ...process.env, BB_FORKER_TEST: "yes" }, cwd: "/tmp", site: "test" });
  env.stdin.end();
  assert.equal((await collect(env)).out, "yes /tmp");

  const missing = startChild("bb-box-no-such-program", [], { site: "test" });
  const error = new Promise<Error>((resolve) => missing.once("error", resolve));
  missing.stdin.end();
  assert.match((await error).message, /ENOENT/);
});

test("a large output comes back whole, and in order, through the helper", async () => {
  const child = startChild("sh", ["-c", "head -c 8000000 /dev/zero | tr '\\0' 'x'"], { site: "test" });
  child.stdin.end();
  const result = await collect(child);
  assert.equal(result.out.length, 8_000_000);
  assert.equal(result.code, 0);
});

test("a child whose streams are ignored ends at once, though what it left in the background runs on, as ssh's master does", async () => {
  const child = startChild("sh", ["-c", "sleep 3 & echo $! > /dev/null; exit 0"], { stdio: "ignore", site: "test" });
  const began = Date.now();
  const code = await new Promise((resolve) => child.once("close", resolve));
  assert.equal(code, 0);
  assert.ok(Date.now() - began < 2_000, "it waited for the background process");
});

function neverSignalled(child: ReturnType<typeof spawn>): () => boolean {
  const handle = (child as unknown as { _handle: { kill(signal: number): number } | null })._handle;
  assert.ok(handle, "Node keeps the handle of a child that could not start until the turn that tells its error");
  let signalled = false;
  handle.kill = () => ((signalled = true), 0);
  return () => signalled;
}

test("a child started here whose program could not start is never signalled, as Node would signal a process ID that is not its own, its group's when that reads 0 (#1004)", async () => {
  const missing = timedSpawn(() => spawn("bb-box-no-such-program", [], { stdio: "ignore" }), "test");
  const failed = new Promise((resolve) => missing.once("error", resolve));
  const signalled = neverSignalled(missing);
  assert.equal(missing.kill("SIGKILL"), false);
  assert.equal(signalled(), false);
  await failed;

  const controller = new AbortController();
  const aborted = timedSpawn(() => spawn("bb-box-no-such-program", [], { stdio: "ignore", signal: controller.signal }), "test");
  const abortFailed = new Promise((resolve) => aborted.once("error", resolve));
  const abortSignalled = neverSignalled(aborted);
  controller.abort();
  assert.equal(abortSignalled(), false, "nor when its abort signal fires");
  await abortFailed;
});

const NEVER_STARTS = `const cp = require("node:child_process");
const spawn = cp.ChildProcess.prototype.spawn;
cp.ChildProcess.prototype.spawn = function (options) {
  const result = spawn.call(this, options);
  if (this.pid === undefined && this._handle && options.file === "bb-box-never-starts") {
    this._handle.onexit = () => {};
    this._handle.kill = (signal) => (process.kill(0, signal), 0);
  }
  return result;
};
`;

const SIGNALS_UNSTARTED = (forker: string, spawns: string) => `import { spawn } from "node:child_process";
import { startChild, stopForker } from ${JSON.stringify(forker)};
import { timedSpawn } from ${JSON.stringify(spawns)};
const direct = timedSpawn(() => spawn("bb-box-never-starts", [], { stdio: "ignore" }), "test");
direct.kill("SIGKILL");
const helped = startChild("bb-box-never-starts", [], { site: "test" });
const sleeper = startChild("sleep", ["30"], { site: "test" });
await new Promise((resolve) => sleeper.once("spawn", resolve));
helped.kill("SIGKILL");
await new Promise((resolve) => setTimeout(resolve, 300));
stopForker();
await new Promise((resolve) => setTimeout(resolve, 300));
console.log("survived");
`;

test("neither a child started here nor one from the helper is signalled before it starts: a process group of its own, as Node's kill would signal it then, survives (#1004)", async () => {
  const dir = tempDir("forker-group");
  const preload = join(dir, "never-starts.cjs");
  const script = join(dir, "signals-unstarted.mts");
  writeFileSync(preload, NEVER_STARTS);
  writeFileSync(script, SIGNALS_UNSTARTED(new URL("../src/transports/forker.ts", import.meta.url).pathname, new URL("../src/transports/spawns.ts", import.meta.url).pathname));
  const group = spawn(process.execPath, [script], { detached: true, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: `--require ${preload}` } });
  let out = "";
  let err = "";
  group.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  group.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  const [code, signal] = await new Promise<[number | null, string | null]>((resolve) => group.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal])));
  assert.deepEqual({ code, signal, out }, { code: 0, signal: null, out: "survived\n" }, err);
});

test("only a positive whole process ID is ever signalled: never 0, which is the caller's own group, a negative, which is a group, NaN or none (#1004)", () => {
  for (const pid of [0, -0, -1, -4242, Number.NaN, 1.5, Number.POSITIVE_INFINITY, undefined, null, "4242"]) assert.equal(isSignallablePid(pid), false, String(pid));
  assert.equal(isSignallablePid(4242), true);
  assert.doesNotMatch(stopBuildScript(0), /kill/);
  assert.match(stopBuildScript(4242), /kill -TERM 4242/);
});
