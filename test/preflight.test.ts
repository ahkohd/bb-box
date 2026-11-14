import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { imageRecord } from "./fake-mac.ts";
import { tempDir } from "./helpers.ts";
import { recordingStandInsForHostTools, type HostToolStandIns } from "./host-stubs.mjs";
import { MACHINE_CHECK, MAY_BREAK_THIS_MACHINE, NO_EXEMPTIONS, SUDO_ANSWERS, isBoxImageRecord, readTestMachineFacts, testMachineRefusal, type TestMachineFacts } from "./preflight.mjs";

const REPOSITORY = fileURLToPath(new URL("..", import.meta.url));
const PREFLIGHT = fileURLToPath(new URL("./preflight.mjs", import.meta.url));
const CHECK = fileURLToPath(new URL("./check-test-machine.mjs", import.meta.url));
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

function timedSudoAnswer(dir: string): { readonly sudo: string; readonly ms: number } {
  const started = Date.now();
  const facts = readTestMachineFacts({ env: { PATH: dir }, marker: NOWHERE, sudoLimits: QUICK_PROBE });
  return { sudo: facts.sudo, ms: Date.now() - started };
}

function stillRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const stat = existsSync(`/proc/${pid}/stat`) ? readFileSync(`/proc/${pid}/stat`, "utf8") : "";
  return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
}

function machineCheckImport(fromFolder: string, testRoot: string): string {
  const path = relative(fromFolder, join(testRoot, "check-test-machine.mjs"));
  return `import "${path.startsWith(".") ? path : `./${path}`}";`;
}

function testFilesLackingTheMachineCheck(testRoot: string): string[] {
  const runnable = /\.test\.tsx?$|-live\.ts$/;
  return readdirSync(testRoot, { recursive: true, encoding: "utf8" })
    .filter((name) => runnable.test(name))
    .filter((name) => readFileSync(join(testRoot, name), "utf8").split("\n")[0] !== machineCheckImport(dirname(join(testRoot, name)), testRoot));
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

test("sudo's answer to sudo -n true is read as no password, a password, or no clear answer", () => {
  const answers = [sudoThat("exit 0"), sudoThat("exit 1"), sudoThat("exit 2"), sudoThat("kill -9 $$")].map(timedSudoAnswer);

  assert.deepEqual(answers.map((answer) => answer.sudo), [SUDO_ANSWERS.noPassword, SUDO_ANSWERS.needsPassword, SUDO_ANSWERS.inconclusive, SUDO_ANSWERS.inconclusive]);
});

test("a sudo that hangs is stopped at the deadline, even one that ignores SIGTERM or answers it by exiting 1, and its answer is no clear answer", () => {
  const hangs = timedSudoAnswer(sudoThat("sleep 30"));
  const ignoresTerm = timedSudoAnswer(sudoThat("trap '' TERM\nsleep 30 & wait $!\nsleep 30"));
  const exitsOnTerm = timedSudoAnswer(sudoThat("trap 'exit 1' TERM\nsleep 60 & wait $!"));

  for (const answer of [hangs, ignoresTerm, exitsOnTerm]) {
    assert.equal(answer.sudo, SUDO_ANSWERS.inconclusive);
    assert.ok(answer.ms < LONGEST_QUICK_PROBE_MS, `answered after ${answer.ms} ms`);
  }
});

test("whatever sudo answers, what it left running in its process group is stopped", () => {
  const pidFile = join(tempDir("left-running"), "pid");

  const facts = readTestMachineFacts({ env: { PATH: sudoThat(`sleep 60 &\necho $! > ${pidFile}\nexit 1`) }, marker: NOWHERE, sudoLimits: QUICK_PROBE });

  assert.equal(facts.sudo, SUDO_ANSWERS.needsPassword);
  assert.equal(stillRunning(Number(readFileSync(pidFile, "utf8"))), false);
});

test("the machine's facts come from its sudo, its Tailscale and GitHub's variables, and a stray file at the box marker's path is not a box", () => {
  const tools = sudoWithoutPassword();
  const stray = join(tempDir("stray-marker"), "image.json");
  writeFileSync(stray, `${imageRecord("linux")}\n`, { mode: 0o644 });

  const facts = readTestMachineFacts({ env: { PATH: tools.dir, CI: "true", GITHUB_ACTIONS: "true", [MAY_BREAK_THIS_MACHINE]: "1" }, marker: NOWHERE });
  const elsewhere = readTestMachineFacts({ env: { PATH: tools.dir, CI: "true" }, marker: stray });

  assert.deepEqual({ ...facts, root: false }, { root: false, sudo: SUDO_ANSWERS.noPassword, tailscale: join(tools.dir, "tailscale"), box: false, githubActions: true, override: true, noExemptions: false });
  assert.deepEqual([elsewhere.box, elsewhere.githubActions, elsewhere.override], [false, false, false]);
  assert.deepEqual(tools.ran(), ["sudo -n true", "sudo -n true"], "only sudo -n true ran, to ask whether sudo needs a password");
});

test("the box marker counts only as a BB Box image record of a contract and kind BB Box knows, that its owner alone can change, not as a link or as other text", () => {
  const dir = tempDir("marker");
  const own = process.getuid!();
  const record = join(dir, "record.json");
  const other = join(dir, "other.json");
  const shared = join(dir, "shared.json");
  const link = join(dir, "link.json");
  const unknownContract = join(dir, "contract.json");
  const unknownKind = join(dir, "kind.json");
  writeFileSync(record, `${imageRecord("linux")}\n`, { mode: 0o644 });
  writeFileSync(unknownContract, `${imageRecord("linux", { contract: -99 })}\n`, { mode: 0o644 });
  writeFileSync(unknownKind, `${imageRecord("anything")}\n`, { mode: 0o644 });
  writeFileSync(other, "not a box image record\n", { mode: 0o644 });
  writeFileSync(shared, `${imageRecord("linux")}\n`);
  chmodSync(shared, 0o666);
  symlinkSync(record, link);

  assert.equal(isBoxImageRecord(record, own), true);
  assert.equal(isBoxImageRecord(other, own), false);
  assert.equal(isBoxImageRecord(shared, own), false);
  assert.equal(isBoxImageRecord(link, own), false);
  assert.equal(isBoxImageRecord(unknownContract, own), false);
  assert.equal(isBoxImageRecord(unknownKind, own), false);
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

test("on a machine that matters, a test file's other imports never run, under node --test or node alone", () => {
  const dir = tempDir("imports-after-the-check");
  const sentinel = join(dir, "an-import-ran");
  writeFileSync(join(dir, "side.mjs"), `import { writeFileSync } from "node:fs";\nimport { test } from "node:test";\nwriteFileSync(${JSON.stringify(sentinel)}, "");\ntest("a test that must not run", () => {});\n`);
  writeFileSync(join(dir, "probe.test.mjs"), `import ${JSON.stringify(pathToFileURL(CHECK).href)};\nimport "./side.mjs";\n`);
  const env = aMachineThatMatters(sudoWithoutPassword());

  for (const args of [["--test", "probe.test.mjs"], ["probe.test.mjs"]]) {
    const ran = spawnSync(process.execPath, args, { cwd: dir, env, encoding: "utf8" });

    assert.notEqual(ran.status, 0, args.join(" "));
    assert.match(`${ran.stdout}${ran.stderr}`, REFUSED, args.join(" "));
    assert.equal(existsSync(sentinel), false, `${args.join(" ")}: an import after the check ran`);
  }
});

test("on a machine that matters, a sudo that answers the deadline's SIGTERM by exiting 1 still stops node --test before any test runs", () => {
  const env = aMachineThatMatters(sudoWithoutPassword());

  const ran = spawnSync(process.execPath, ["--test", A_TEST_FILE], { cwd: REPOSITORY, env: { ...env, PATH: `${sudoThat("trap 'exit 1' TERM\nsleep 60 & wait $!")}:${process.env.PATH}` }, encoding: "utf8" });

  assert.notEqual(ran.status, 0);
  assert.match(`${ran.stdout}${ran.stderr}`, /BB Box's tests will not run on this machine: BB Box could not tell whether this user can run sudo without a password/);
  assert.doesNotMatch(`${ran.stdout}${ran.stderr}`, A_TEST_PASSED);
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

test("every test file the runners find, in nested folders too, and every live test, checks the machine first, by its own relative path", () => {
  const tree = tempDir("test-tree");
  mkdirSync(join(tree, "nested"));
  writeFileSync(join(tree, "top.test.ts"), `${MACHINE_CHECK_IMPORT}\n`);
  writeFileSync(join(tree, "nested", "checked.test.tsx"), 'import "../check-test-machine.mjs";\n');
  writeFileSync(join(tree, "nested", "missing.test.tsx"), 'import { test } from "vitest";\n');
  writeFileSync(join(tree, "nested", "wrong-path.test.tsx"), `${MACHINE_CHECK_IMPORT}\n`);

  assert.deepEqual(testFilesLackingTheMachineCheck(tree).sort(), [join("nested", "missing.test.tsx"), join("nested", "wrong-path.test.tsx")]);
  assert.deepEqual(testFilesLackingTheMachineCheck(join(REPOSITORY, "test")), []);
});

test("npm test and the panel's tests check the machine before they start a test runner", () => {
  const { scripts } = JSON.parse(readFileSync(join(REPOSITORY, "package.json"), "utf8")) as { scripts: Record<string, string> };

  assert.match(scripts.test!, /^node test\/preflight\.mjs && /);
  assert.match(scripts["test:app"]!, /^node test\/preflight\.mjs && /);
});
