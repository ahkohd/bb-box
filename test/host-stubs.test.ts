import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { shortTempBase } from "../src/core/temp-folders.ts";
import { DEVICE_HOST_HELPER } from "../src/backends/tart/device-host.ts";
import { SshTransport } from "../src/transports/ssh.ts";
import { FakeBoatGuest } from "./fake-boat-guest.ts";
import { fakeIosHostMac } from "./fake-ios-host.ts";
import { at, fakeSsh, tempDir } from "./helpers.ts";
import { guardedPath } from "./host-guard.ts";
import { MAY_BREAK_THIS_MACHINE } from "./preflight.mjs";
import { hostCommandsRecorded, pathWithHostStubs, recordingStandInsForHostTools, refusalForRealHostTools, testMadeRoots, withHostToolsFirstOnPath } from "./host-stubs.mjs";

const EXIT_GUARD = new URL("./exit-guard.ts", import.meta.url).pathname;
const NEVER_THERE = "/etc/bb-box-test-never-here";
const TOOLS_THESE_TESTS_NAME = ["sudo", "tailscale", "systemctl", "reboot", "pkill", "runuser", "setpriv", "killall5", "osascript", "pfctl", "ip", "route", "sysctl", "scutil"];

function standInsForTheTestMachine() {
  return recordingStandInsForHostTools(tempDir("test-machine-tools"), TOOLS_THESE_TESTS_NAME);
}

test("sudo in a fake box runs its command under the fake's stubs, so tailscale, systemctl, reboot and pkill are only recorded", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");
  const testMachine = standInsForTheTestMachine();

  const ran = await withHostToolsFirstOnPath(testMachine, () =>
    box.run(`sudo -n sh -c 'tailscale up --auth-key=file:/dev/null; systemctl restart bbbox-test-none'; sudo ${join(testMachine.dir, "reboot")}; pkill -0 -f bbbox-test-none`, { timeoutMs: 20_000 }),
  );

  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
  assert.deepEqual(hostCommandsRecorded(fake.dir), [
    "sudo -n sh -c tailscale up --auth-key=file:/dev/null; systemctl restart bbbox-test-none",
    "tailscale up --auth-key=file:/dev/null",
    "systemctl restart bbbox-test-none",
    `sudo ${join(testMachine.dir, "reboot")}`,
    "reboot",
    "pkill -0 -f bbbox-test-none",
  ]);
});

test("rm, chown and chmod in a fake box change only the test's own folders, and are recorded and skipped elsewhere", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");

  const ran = await box.run(`touch mine && chmod 600 mine && rm mine && ! test -e mine && rm -rf ${NEVER_THERE} && rm -f ../../../../${NEVER_THERE} && chown box:box ${NEVER_THERE} && chmod 777 ${NEVER_THERE} && echo done`, { timeoutMs: 20_000 });

  assert.equal(ran.stdout.trim(), "done", ran.stderr);
  assert.deepEqual(hostCommandsRecorded(fake.dir), [`rm -rf ${NEVER_THERE}`, `rm -f ../../../../${NEVER_THERE}`, `chown box:box ${NEVER_THERE}`, `chmod 777 ${NEVER_THERE}`]);
});

test("runuser, setpriv, killall5, osascript and pfctl in a fake box are only recorded, as are ip, route, sysctl and scutil when they change something", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");
  const testMachine = standInsForTheTestMachine();
  const changes = [
    "runuser -u nobody -- true",
    "setpriv --reuid=65534 true",
    "killall5 -0",
    "osascript -e do shell script \"true\" with administrator privileges",
    "pfctl -s Running",
    "ip link set bbbox-test-none down",
    "route del -host 192.0.2.1",
    "sysctl -w bbbox.test.none=1",
    "scutil --set BbBoxTestNone none",
  ];

  const ran = await withHostToolsFirstOnPath(testMachine, () =>
    box.run(`runuser -u nobody -- true; setpriv --reuid=65534 true; killall5 -0; osascript -e 'do shell script "true" with administrator privileges'; pfctl -s Running; ip link set bbbox-test-none down; route del -host 192.0.2.1; sysctl -w bbbox.test.none=1; scutil --set BbBoxTestNone none; echo done`, { timeoutMs: 20_000 }),
  );

  assert.equal(ran.stdout.trim(), "done", ran.stderr);
  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
  assert.deepEqual(hostCommandsRecorded(fake.dir), changes);
});

test("rm, chmod and chown in a fake box follow a link to its target, and leave a target outside the fake's own folders alone", async () => {
  const fake = fakeSsh();
  const box = new SshTransport(fake.ssh, at("box-1"), "linux");
  const outside = tempDir("not-the-fakes");
  for (const name of ["victim-rm", "victim-chmod", "victim-chown", "unrelated"]) writeFileSync(join(outside, name), name, { mode: 0o600 });
  const home = fake.home("box-1");
  mkdirSync(home, { recursive: true });
  symlinkSync(outside, join(home, "escape"));

  const ran = await box.run(
    `rm -f escape/victim-rm; chmod 777 escape/victim-chmod; chown 12345 escape/victim-chown; rm -f ${outside}/unrelated; f=$(mktemp) && rm -f "$f" && ! test -e "$f" && touch mine && chmod 600 mine && rm mine && ! test -e mine && echo done`,
    { timeoutMs: 20_000 },
  );

  assert.equal(ran.stdout.trim(), "done", ran.stderr);
  assert.deepEqual(readdirSync(outside).sort(), ["unrelated", "victim-chmod", "victim-chown", "victim-rm"]);
  assert.equal(statSync(join(outside, "victim-chmod")).mode & 0o777, 0o600);
  assert.equal(statSync(join(outside, "victim-chown")).uid, process.getuid!());
  assert.deepEqual(hostCommandsRecorded(fake.dir), ["rm -f escape/victim-rm", "chmod 777 escape/victim-chmod", "chown 12345 escape/victim-chown", `rm -f ${outside}/unrelated`]);
});

test("the fake boat.dev guest's sudo runs its command under the stubs, even a command named by its full path", async () => {
  const testMachine = standInsForTheTestMachine();
  const guest = await withHostToolsFirstOnPath(testMachine, async () => new FakeBoatGuest());

  const ran = await withHostToolsFirstOnPath(testMachine, () => guest.run(`sudo -n ${join(testMachine.dir, "tailscale")} logout`, { timeoutMs: 20_000 }));
  guest.dispose();

  assert.equal(ran.exitCode, 0, ran.stderr);
  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
});

test("a fake iOS host's sudo runs its command under the stubs, and its device helper keeps the device host's PATH, stubs included", async () => {
  const testMachine = standInsForTheTestMachine();
  const { ssh, device } = await withHostToolsFirstOnPath(testMachine, async () => fakeIosHostMac());
  const host = new SshTransport(ssh.ssh, at("192.168.64.2"), "macos");
  writeFileSync(join(device.root, "../host/device-host"), 'printf %s "$PATH"\n');

  const tailscale = await withHostToolsFirstOnPath(testMachine, () => host.run(`sudo -n ${join(testMachine.dir, "tailscale")} logout`, { timeoutMs: 20_000 }));
  const helper = await host.run(`sudo -n ${DEVICE_HOST_HELPER} status`, { timeoutMs: 20_000 });

  assert.equal(tailscale.exitCode, 0, tailscale.stderr);
  assert.deepEqual(testMachine.ran(), [], "nothing reached the test machine's own tools");
  assert.equal(helper.stdout, device.env.PATH);
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
  const testMachine = recordingStandInsForHostTools(join(dir, "machine"), ["sudo", "tailscale", "systemctl"]);
  const reachesTheMachine = [
    'import { spawnSync } from "node:child_process";',
    'spawnSync("sh", ["-c", "sudo -n true; tailscale logout; systemctl restart bbbox-test-none"], { env: { PATH: `${process.env.MACHINE_TOOLS}:/usr/bin:/bin` }, stdio: "inherit" });',
  ].join("\n");

  const child = spawnSync(process.execPath, ["--import", EXIT_GUARD, "--input-type=module", "-e", reachesTheMachine], {
    env: { PATH: `${testMachine.dir}:${process.env.PATH}`, TMPDIR: childTemp, MACHINE_TOOLS: testMachine.dir, [MAY_BREAK_THIS_MACHINE]: "1" },
    encoding: "utf8",
  });

  assert.deepEqual(testMachine.ran(), [], "the test machine's tools never ran");
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /BB Box test guard: a test ran the test machine's own sudo -n true\./);
  assert.match(child.stderr, /This test file ran the test machine's own privileged tools, which BB Box's test guard stopped: sudo -n true; tailscale logout; systemctl restart bbbox-test-none\./);
});
