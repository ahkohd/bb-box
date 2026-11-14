import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shortTempBase } from "../src/core/temp-folders.ts";
import { SshTransport } from "../src/transports/ssh.ts";
import { at, fakeSsh, tempDir } from "./helpers.ts";
import { guardedPath } from "./host-guard.ts";
import { hostCommandsRecorded, pathWithHostStubs, recordingStandInsForHostTools, refusalForRealHostTools, testMadeRoots, withHostToolsFirstOnPath } from "./host-stubs.mjs";

const EXIT_GUARD = new URL("./exit-guard.ts", import.meta.url).pathname;
const NEVER_THERE = "/etc/bb-box-test-never-here";

test("sudo in a fake box runs its command under the fake's stubs, so tailscale, systemctl, reboot and pkill are only recorded", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");
  const testMachine = recordingStandInsForHostTools(tempDir("test-machine-tools"));

  const ran = await withHostToolsFirstOnPath(testMachine, () =>
    box.run("sudo -n sh -c 'tailscale up --auth-key=file:/dev/null; systemctl restart ssh'; sudo /sbin/reboot; pkill -f node", { timeoutMs: 20_000 }),
  );

  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
  assert.deepEqual(hostCommandsRecorded(fake.dir), [
    "sudo -n sh -c tailscale up --auth-key=file:/dev/null; systemctl restart ssh",
    "tailscale up --auth-key=file:/dev/null",
    "systemctl restart ssh",
    "sudo /sbin/reboot",
    "reboot",
    "pkill -f node",
  ]);
});

test("rm, chown and chmod in a fake box change only the test's own folders, and are recorded and skipped elsewhere", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");

  const ran = await box.run(`touch mine && chmod 600 mine && rm mine && ! test -e mine && rm -rf ${NEVER_THERE} && rm -f ../../../../${NEVER_THERE} && chown box:box ${NEVER_THERE} && chmod 777 ${NEVER_THERE} && echo done`, { timeoutMs: 20_000 });

  assert.equal(ran.stdout.trim(), "done", ran.stderr);
  assert.deepEqual(hostCommandsRecorded(fake.dir), [`rm -rf ${NEVER_THERE}`, `rm -f ../../../../${NEVER_THERE}`, `chown box:box ${NEVER_THERE}`, `chmod 777 ${NEVER_THERE}`]);
});

test("a fake refuses a PATH that would reach a real privileged tool, and takes one whose stubs come first", () => {
  const realTools = tempDir("real-tools");
  writeFileSync(join(realTools, "sudo"), "#!/bin/sh\n", { mode: 0o755 });
  const fakeRoot = tempDir("fake-root");
  const onlyTheFakeIsTestMade = (path: string) => path.startsWith(fakeRoot);

  const refused = refusalForRealHostTools("The fake ssh", realTools, onlyTheFakeIsTestMade);
  const taken = refusalForRealHostTools("The fake ssh", pathWithHostStubs(fakeRoot, [], realTools), onlyTheFakeIsTestMade);

  assert.equal(refused, `The fake ssh refused to run a box's script: it would reach the test machine's own ${join(realTools, "sudo")}. Put the fake's host stubs first on its PATH.\n`);
  assert.equal(taken, null);
});

test("the test's own folders are where BB Box makes its temporary folders, short ones too", () => {
  assert.ok(testMadeRoots().includes(tmpdir()));
  assert.ok(testMadeRoots().includes(shortTempBase()));
});

test("the suite's guard comes after a test's own tools and before the test machine's, even in a child given no PATH", () => {
  const guard = "/tmp/bbbox-test-guard-1000-abc/bin";
  const own = join(tempDir("own-tools"), "bin");

  assert.equal(guardedPath(`${own}:/usr/bin:/bin`, guard), `${own}:${guard}:/usr/bin:/bin`);
  assert.equal(guardedPath(`${guard}:/usr/bin`, guard), `${guard}:/usr/bin`);
  assert.ok(guardedPath(undefined, guard).startsWith(`${guard}:`));
});

test("a test process that runs the test machine's own sudo, tailscale or systemctl fails loudly, and the tool never runs", () => {
  const dir = tempDir("guard-proof");
  const childTemp = join(dir, "t");
  mkdirSync(childTemp);
  const testMachine = recordingStandInsForHostTools(join(dir, "machine"));
  const reachesTheMachine = [
    'import { spawnSync } from "node:child_process";',
    'spawnSync("sh", ["-c", "sudo -n true; tailscale logout; systemctl restart ssh"], { env: { PATH: `${process.env.MACHINE_TOOLS}:/usr/bin:/bin` }, stdio: "inherit" });',
  ].join("\n");

  const child = spawnSync(process.execPath, ["--import", EXIT_GUARD, "--input-type=module", "-e", reachesTheMachine], {
    env: { PATH: `${testMachine.dir}:${process.env.PATH}`, TMPDIR: childTemp, MACHINE_TOOLS: testMachine.dir },
    encoding: "utf8",
  });

  assert.deepEqual(testMachine.ran(), [], "the test machine's tools never ran");
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /BB Box test guard: a test ran the test machine's own sudo -n true\./);
  assert.match(child.stderr, /This test file ran the test machine's own privileged tools, which BB Box's test guard stopped: sudo -n true; tailscale logout; systemctl restart ssh\./);
});
