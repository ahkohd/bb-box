// The helper that starts bb-box's short-lived child processes in place of BB's server (forker.ts).

import assert from "node:assert/strict";
import { test } from "node:test";
import { startChild, type ChildLike } from "../src/transports/forker.ts";

/** Everything a child said, and how it ended. */
function collect(child: ChildLike): Promise<{ out: string; err: string; code: number | null; signal: string | null; exitCode: number | null }> {
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (err += chunk.toString()));
  return new Promise((resolve) => child.on("close", (code: number | null, signal: string | null) => resolve({ out, err, code, signal, exitCode: child.exitCode })));
}

test("a child started from the helper gets its stdin, and gives back its output, errors and exit code, in order", async () => {
  const child = startChild("sh", ["-c", "cat; echo to-err >&2; exit 3"]);
  const done = collect(child);
  child.stdin.write("hello ");
  child.stdin.end("world\n");
  const result = await done;
  assert.deepEqual(result, { out: "hello world\n", err: "to-err\n", code: 3, signal: null, exitCode: 3 });
  assert.ok(typeof child.pid === "number" && child.pid > 0);
});

test("a child from the helper is killed, gives its environment and folder, and a missing program is an error", async () => {
  const sleeper = startChild("sleep", ["30"]);
  const ended = collect(sleeper);
  await new Promise((resolve) => sleeper.once("spawn", resolve));
  assert.equal(sleeper.kill("SIGKILL"), true);
  assert.deepEqual([(await ended).signal, sleeper.signalCode], ["SIGKILL", "SIGKILL"]);

  const env = startChild("sh", ["-c", 'printf "%s %s" "$BB_FORKER_TEST" "$(pwd)"'], { env: { ...process.env, BB_FORKER_TEST: "yes" }, cwd: "/tmp" });
  env.stdin.end();
  assert.equal((await collect(env)).out, "yes /tmp");

  const missing = startChild("bb-box-no-such-program", []);
  const error = new Promise<Error>((resolve) => missing.once("error", resolve));
  missing.stdin.end();
  assert.match((await error).message, /ENOENT/);
});

test("a large output comes back whole, and in order, through the helper", async () => {
  const child = startChild("sh", ["-c", "head -c 8000000 /dev/zero | tr '\\0' 'x'"]);
  child.stdin.end();
  const result = await collect(child);
  assert.equal(result.out.length, 8_000_000);
  assert.equal(result.code, 0);
});
