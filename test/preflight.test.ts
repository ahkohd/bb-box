import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { tempDir } from "./helpers.ts";
import { recordingStandInsForHostTools, type HostToolStandIns } from "./host-stubs.mjs";
import { MACHINE_CHECK, MAY_BREAK_THIS_MACHINE, NO_EXEMPTIONS, readTestMachineFacts, testMachineRefusal, type TestMachineFacts } from "./preflight.mjs";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const EXIT_GUARD = fileURLToPath(new URL("./exit-guard.ts", import.meta.url));
const PREFLIGHT = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
const NOWHERE = "/nonexistent/bb-box-image.json";

const A_DEVELOPERS_MACHINE: TestMachineFacts = { root: false, passwordlessSudo: true, tailscale: "/usr/bin/tailscale", box: false, githubActions: false, override: false, noExemptions: false };
const REFUSAL = /^BB Box's tests will not run on this machine: this user can run sudo without a password, and Tailscale is installed, at \/usr\/bin\/tailscale\. A test that goes wrong could change this machine: one once logged a machine out of its tailnet\. Run the tests in a BB Box box or on GitHub Actions\. To run them here anyway, at the risk of changing this machine, set BBBOX_TESTS_MAY_BREAK_THIS_MACHINE=1\.$/;

function sudoWithoutPassword(): HostToolStandIns {
  return recordingStandInsForHostTools(tempDir("machine-tools"), ["sudo", "tailscale"]);
}

function aMachineThatMatters(tools: HostToolStandIns, more: Record<string, string> = {}): Record<string, string> {
  return { PATH: `${tools.dir}:${process.env.PATH}`, HOME: process.env.HOME ?? "/", [MACHINE_CHECK]: NO_EXEMPTIONS, ...more };
}

test("the tests refuse a machine where this user can run sudo without a password or Tailscale is installed, and say what to do", () => {
  assert.match(testMachineRefusal(A_DEVELOPERS_MACHINE) ?? "", REFUSAL);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, passwordlessSudo: false }) ?? "", /^BB Box's tests will not run on this machine: Tailscale is installed, at \/usr\/bin\/tailscale\./);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, tailscale: null }) ?? "", /^BB Box's tests will not run on this machine: this user can run sudo without a password\./);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, passwordlessSudo: false, tailscale: null, root: true }) ?? "", /^BB Box's tests will not run on this machine: the tests run as root\./);
});

test("the tests run on a machine with none of those risks, in a BB Box box, on GitHub Actions, or when a person accepts the risk", () => {
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, passwordlessSudo: false, tailscale: null }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, box: true }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, githubActions: true }), null);
  assert.equal(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, override: true }), null);
  assert.match(testMachineRefusal({ ...A_DEVELOPERS_MACHINE, box: true, githubActions: true, noExemptions: true }) ?? "", REFUSAL);
});

test("the machine's facts come from its sudo, its Tailscale, BB Box's image record and GitHub's variables", () => {
  const tools = sudoWithoutPassword();

  const facts = readTestMachineFacts({ env: { PATH: tools.dir, CI: "true", GITHUB_ACTIONS: "true", [MAY_BREAK_THIS_MACHINE]: "1" }, marker: NOWHERE });
  const elsewhere = readTestMachineFacts({ env: { PATH: tools.dir, CI: "true" }, marker: PREFLIGHT });

  assert.deepEqual({ ...facts, root: false }, { root: false, passwordlessSudo: true, tailscale: join(tools.dir, "tailscale"), box: false, githubActions: true, override: true, noExemptions: false });
  assert.deepEqual([elsewhere.box, elsewhere.githubActions, elsewhere.override], [true, false, false]);
  assert.deepEqual(tools.ran(), ["sudo -n true", "sudo -n true"], "only sudo -n true ran, to ask whether sudo needs a password");
});

test("on a machine that matters, the preflight, a node test file and npm test stop before any test runs", () => {
  const tools = sudoWithoutPassword();
  const env = aMachineThatMatters(tools);

  const preflight = spawnSync(process.execPath, [PREFLIGHT], { env, encoding: "utf8" });
  const testFile = spawnSync(process.execPath, ["--import", EXIT_GUARD, "-e", "console.log('a test ran')"], { env, encoding: "utf8" });
  const npmTest = spawnSync("npm", ["test", "--silent"], { cwd: REPOSITORY, env, encoding: "utf8" });

  for (const [entry, ran] of [["preflight", preflight], ["test file", testFile], ["npm test", npmTest]] as const) {
    assert.equal(ran.status, 1, `${entry}: ${ran.stderr}`);
    assert.match(ran.stderr, /BB Box's tests will not run on this machine: this user can run sudo without a password/, entry);
    assert.doesNotMatch(ran.stdout, /a test ran|tests \d+/, entry);
  }
});

test("on a machine that matters, vitest stops before the panel's tests run", () => {
  const tools = sudoWithoutPassword();

  const vitest = spawnSync(join(REPOSITORY, "node_modules/.bin/vitest"), ["run", "test/activity.test.tsx"], { cwd: REPOSITORY, env: aMachineThatMatters(tools), encoding: "utf8" });

  assert.notEqual(vitest.status, 0);
  assert.match(`${vitest.stdout}${vitest.stderr}`, /BB Box's tests will not run on this machine: this user can run sudo without a password/);
});

test("a person who sets the variable that names the risk can run the tests on such a machine", () => {
  const tools = sudoWithoutPassword();

  const ran = spawnSync(process.execPath, ["--import", EXIT_GUARD, "-e", "console.log('a test ran')"], { env: aMachineThatMatters(tools, { [MAY_BREAK_THIS_MACHINE]: "1" }), encoding: "utf8" });

  assert.equal(ran.status, 0, ran.stderr);
  assert.match(ran.stdout, /a test ran/);
  assert.deepEqual(tools.ran(), [], "nothing was asked of sudo");
});

test("npm test and the panel's tests check the machine before they start a test runner", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { scripts: Record<string, string> };

  assert.match(scripts.test!, /^node test\/preflight\.mjs && /);
  assert.match(scripts["test:app"]!, /^node test\/preflight\.mjs && /);
});
