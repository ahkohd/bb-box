import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { imageRecord } from "./fake-mac.ts";
import { tempDir } from "./helpers.ts";
import { recordingStandInsForHostTools, type HostToolStandIns } from "./host-stubs.mjs";
import { MACHINE_CHECK, MAY_BREAK_THIS_MACHINE, NO_EXEMPTIONS, SUDO_ANSWERS, isBoxImageRecord, readTestMachineFacts, testMachineRefusal, type TestMachineFacts } from "./preflight.mjs";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const PREFLIGHT = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
const A_TEST_FILE = "test/sizes.test.ts";
const MACHINE_CHECK_IMPORT = 'import "./check-test-machine.mjs";';
const NOWHERE = "/nonexistent/bb-box-image.json";
const QUICK_PROBE = { answerWithinMs: 300, killAfterMs: 300 };
const LONGEST_QUICK_PROBE_MS = 3_000;

const A_DEVELOPERS_MACHINE: TestMachineFacts = { root: false, sudo: SUDO_ANSWERS.noPassword, tailscale: "/usr/bin/tailscale", box: false, githubActions: false, override: false, noExemptions: false };
const REFUSAL = /^BB Box's tests will not run on this machine: this user can run sudo without a password, and Tailscale is installed, at \/usr\/bin\/tailscale\. A test that goes wrong could change this machine: one once logged a machine out of its tailnet\. Run the tests in a BB Box box or on GitHub Actions\. To run them here anyway, at the risk of changing this machine, set BBBOX_TESTS_MAY_BREAK_THIS_MACHINE=1\.$/;
const REFUSED = /BB Box's tests will not run on this machine: this user can run sudo without a password/;
const A_TEST_PASSED = /pass [1-9]|^ok /m;

function sudoWithoutPassword(): HostToolStandIns {
  return recordingStandInsForHostTools(tempDir("machine-tools"), ["sudo", "tailscale"]);
}

function aMachineThatMatters(tools: HostToolStandIns, more: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${tools.dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "/", [MACHINE_CHECK]: NO_EXEMPTIONS, ...more };
}

function sudoThat(body: string): string {
  const dir = tempDir("sudo-shim");
  writeFileSync(join(dir, "sudo"), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return dir;
}

async function timedSudoAnswer(dir: string): Promise<{ readonly sudo: string; readonly ms: number }> {
  const started = Date.now();
  const facts = await readTestMachineFacts({ env: { PATH: dir }, marker: NOWHERE, sudoLimits: QUICK_PROBE });
  return { sudo: facts.sudo, ms: Date.now() - started };
}

test("the tests refuse a machine where this user can run sudo without a password or Tailscale is installed, and say what to do", () => {
  assert.match(testMachineRefusal(A_DEVELOPERS_MACHINE) ?? "", REFUSAL);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, sudo: SUDO_ANSWERS.needsPassword }) ?? "", /^BB Box's tests will not run on this machine: Tailscale is installed, at \/usr\/bin\/tailscale\./);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, tailscale: null }) ?? "", /^BB Box's tests will not run on this machine: this user can run sudo without a password\./);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, sudo: SUDO_ANSWERS.absent, tailscale: null, root: true }) ?? "", /^BB Box's tests will not run on this machine: the tests run as root\./);
});

test("a sudo that does not answer, or fails, counts as a risk, and the refusal names the variable to run anyway", () => {
  const refusal = testMachineRefusal({ ...A_DEVELOPERS_MACHINE, sudo: SUDO_ANSWERS.inconclusive, tailscale: null }) ?? "";

  assert.match(refusal, /^BB Box's tests will not run on this machine: BB Box could not tell whether this user can run sudo without a password, as sudo -n true did not answer in time or failed\./);
  assert.match(refusal, /set BBBOX_TESTS_MAY_BREAK_THIS_MACHINE=1\.$/);
});

test("the tests run on a machine with none of those risks, in a BB Box box, on GitHub Actions, or when a person accepts the risk", () => {
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, sudo: SUDO_ANSWERS.needsPassword, tailscale: null }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, sudo: SUDO_ANSWERS.absent, tailscale: null }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, box: true }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, githubActions: true }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, override: true }), null);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, box: true, githubActions: true, noExemptions: true }) ?? "", REFUSAL);
});

test("sudo's answer to sudo -n true is read as no password, a password, or no clear answer", async () => {
  const answers = await Promise.all([sudoThat("exit 0"), sudoThat("exit 1"), sudoThat("exit 2"), sudoThat("kill -9 $$")].map(timedSudoAnswer));

  assert.deepEqual(answers.map((answer) => answer.sudo), [SUDO_ANSWERS.noPassword, SUDO_ANSWERS.needsPassword, SUDO_ANSWERS.inconclusive, SUDO_ANSWERS.inconclusive]);
});

test("a sudo that hangs is stopped at the deadline, even one that ignores SIGTERM, and its answer is no clear answer", async () => {
  const hangs = await timedSudoAnswer(sudoThat("sleep 30"));
  const ignoresTerm = await timedSudoAnswer(sudoThat("trap '' TERM\nsleep 30 & wait $!\nsleep 30"));

  for (const answer of [hangs, ignoresTerm]) {
    assert.equal(answer.sudo, SUDO_ANSWERS.inconclusive);
    assert.ok(answer.ms < LONGEST_QUICK_PROBE_MS, `answered after ${answer.ms} ms`);
  }
});

test("the machine's facts come from its sudo, its Tailscale and GitHub's variables, and a stray file at the box marker's path is not a box", async () => {
  const tools = sudoWithoutPassword();
  const stray = join(tempDir("stray-marker"), "image.json");
  writeFileSync(stray, `${imageRecord("linux")}\n`, { mode: 0o644 });

  const facts = await readTestMachineFacts({ env: { PATH: tools.dir, CI: "true", GITHUB_ACTIONS: "true", [MAY_BREAK_THIS_MACHINE]: "1" }, marker: NOWHERE });
  const elsewhere = await readTestMachineFacts({ env: { PATH: tools.dir, CI: "true" }, marker: stray });

  assert.deepEqual({ ...facts, root: false }, { root: false, sudo: SUDO_ANSWERS.noPassword, tailscale: join(tools.dir, "tailscale"), box: false, githubActions: true, override: true, noExemptions: false });
  assert.deepEqual([elsewhere.box, elsewhere.githubActions, elsewhere.override], [false, false, false]);
  assert.deepEqual(tools.ran(), ["sudo -n true", "sudo -n true"], "only sudo -n true ran, to ask whether sudo needs a password");
});

test("the box marker counts only as a BB Box image record that its owner alone can change, not as a link or as other text", () => {
  const dir = tempDir("marker");
  const own = process.getuid!();
  const record = join(dir, "record.json");
  const other = join(dir, "other.json");
  const shared = join(dir, "shared.json");
  const link = join(dir, "link.json");
  writeFileSync(record, `${imageRecord("linux")}\n`, { mode: 0o644 });
  writeFileSync(other, "not a box image record\n", { mode: 0o644 });
  writeFileSync(shared, `${imageRecord("linux")}\n`);
  chmodSync(shared, 0o666);
  symlinkSync(record, link);

  assert.equal(isBoxImageRecord(record, own), true);
  assert.equal(isBoxImageRecord(other, own), false);
  assert.equal(isBoxImageRecord(shared, own), false);
  assert.equal(isBoxImageRecord(link, own), false);
  assert.equal(isBoxImageRecord(NOWHERE, own), false);
});

test("on a machine that matters, a test file run by node --test or by node alone, the preflight and npm test all stop before any test runs", () => {
  const env = aMachineThatMatters(sudoWithoutPassword());

  const ran = {
    "node --test": spawnSync(process.execPath, ["--test", A_TEST_FILE], { cwd: REPOSITORY, env, encoding: "utf8" }),
    node: spawnSync(process.execPath, [A_TEST_FILE], { cwd: REPOSITORY, env, encoding: "utf8" }),
    preflight: spawnSync(process.execPath, [PREFLIGHT], { env, encoding: "utf8" }),
    "npm test": spawnSync("npm", ["test", "--silent"], { cwd: REPOSITORY, env, encoding: "utf8" }),
  };

  for (const [entry, each] of Object.entries(ran)) {
    const output = `${each.stdout}${each.stderr}`;
    assert.notEqual(each.status, 0, `${entry}: ${output}`);
    assert.match(output, REFUSED, entry);
    assert.doesNotMatch(output, A_TEST_PASSED, entry);
  }
});

test("on a machine that matters, vitest stops before the panel's tests run", () => {
  const vitest = spawnSync(join(REPOSITORY, "node_modules/.bin/vitest"), ["run", "test/activity.test.tsx"], { cwd: REPOSITORY, env: aMachineThatMatters(sudoWithoutPassword()), encoding: "utf8" });

  assert.notEqual(vitest.status, 0);
  assert.match(`${vitest.stdout}${vitest.stderr}`, REFUSED);
});

test("a person who sets the variable that names the risk can run a test file on such a machine, and nothing is asked of sudo", () => {
  const tools = sudoWithoutPassword();

  const ran = spawnSync(process.execPath, ["--test", A_TEST_FILE], { cwd: REPOSITORY, env: aMachineThatMatters(tools, { [MAY_BREAK_THIS_MACHINE]: "1" }), encoding: "utf8" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /pass [1-9]/);
  assert.deepEqual(tools.ran(), []);
});

test("every test file, and every live test a person runs with node --test, checks the machine first, before it imports anything else", () => {
  const testFiles = readdirSync(join(REPOSITORY, "test")).filter((name) => /\.test\.tsx?$|-live\.ts$/.test(name));

  const without = testFiles.filter((name) => readFileSync(join(REPOSITORY, "test", name), "utf8").split("\n")[0] !== MACHINE_CHECK_IMPORT);

  assert.ok(testFiles.length > 200);
  assert.deepEqual(without, []);
});

test("npm test and the panel's tests check the machine before they start a test runner", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { scripts: Record<string, string> };

  assert.match(scripts.test!, /^node test\/preflight\.mjs && /);
  assert.match(scripts["test:app"]!, /^node test\/preflight\.mjs && /);
});
