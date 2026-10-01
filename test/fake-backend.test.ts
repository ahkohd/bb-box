// What the fake backend promises the tests that use it.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { tempDir } from "./helpers.ts";

const gone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("what a fake guest's commands start ends with the test process, as does what a timeout leaves running (#310)", async () => {
  // A test process with a guest that keeps a server, and a command that times out, which kills only its shell.
  const script = `
    import { readFileSync } from "node:fs";
    import { FakeTransport } from ${JSON.stringify(new URL("./fake-backend.ts", import.meta.url).href)};
    const home = ${JSON.stringify(tempDir("fake-group"))};
    const guest = new FakeTransport(home, async () => "running");
    const server = (await guest.run("sleep 300 & echo $!")).stdout.trim();
    const slow = await guest.run("sleep 300 & echo $! > sleep.pid; wait", { timeoutMs: 1_000 });
    if (!slow.timedOut) throw new Error("the command did not time out");
    const left = readFileSync(home + "/sleep.pid", "utf8").trim();
    for (const pid of [server, left]) process.kill(Number(pid), 0);
    console.log(server, left);
  `;
  const pids = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 20_000 }).trim().split(" ").map(Number);
  assert.equal(pids.length, 2);
  for (let i = 0; !pids.every(gone); i++) {
    assert.ok(i < 100, `still running 5 s after the test process ended: ${pids.filter((pid) => !gone(pid)).join(" ")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
