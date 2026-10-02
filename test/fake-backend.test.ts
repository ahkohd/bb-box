// What the fakes promise the tests that use them.

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

test("what the fake ssh and the fake docker run ends with the test process, as does what a timeout leaves running (#320)", async () => {
  // A test process with a command through each that times out, which kills only the fake.
  const at = (path: string) => JSON.stringify(new URL(path, import.meta.url).href);
  const script = `
    import { readFileSync } from "node:fs";
    import { DockerCli } from ${at("../src/backends/docker/cli.ts")};
    import { DockerTransport } from ${at("../src/backends/docker/transport.ts")};
    import { fakeDockerHost } from ${at("./fake-docker.ts")};
    import { at, fakeSsh } from ${at("./helpers.ts")};
    const { ssh, home } = fakeSsh();
    const docker = fakeDockerHost();
    const cli = new DockerCli(null, docker.binary);
    const image = Object.keys(JSON.parse(readFileSync(docker.root + "/images.json", "utf8")))[0];
    for (const args of [["network", "create", "net"], ["container", "create", "--name", "box", "--network", "net", image], ["container", "start", "box"]]) {
      const made = await cli.run(args, { timeoutMs: 10_000 });
      if (made.exitCode !== 0) throw new Error(made.stderr);
    }
    const slow = "sleep 300 & echo $! > sleep.pid; wait";
    const results = [await ssh.run(at("192.0.2.7"), slow, { timeoutMs: 1_000 }), await new DockerTransport(cli, "box").run(slow, { timeoutMs: 1_000 })];
    if (!results.every((result) => result.timedOut)) throw new Error("a command did not time out");
    const left = [home("192.0.2.7"), docker.home("box")].map((dir) => readFileSync(dir + "/sleep.pid", "utf8").trim());
    for (const pid of left) process.kill(Number(pid), 0);
    console.log(left.join(" "));
  `;
  const pids = execFileSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 30_000 }).trim().split(" ").map(Number);
  assert.equal(pids.length, 2);
  for (let i = 0; !pids.every(gone); i++) {
    assert.ok(i < 100, `still running 5 s after the test process ended: ${pids.filter((pid) => !gone(pid)).join(" ")}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
});
