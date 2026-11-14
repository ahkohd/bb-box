import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { GUARD_FOLDER_PREFIX, SYSTEM_PATH, firstOnPath } from "./host-stubs.mjs";

export const MAY_BREAK_THIS_MACHINE = "BBBOX_TESTS_MAY_BREAK_THIS_MACHINE";
export const MACHINE_CHECK = "BBBOX_TEST_MACHINE_CHECK";
export const NO_EXEMPTIONS = "strict";
export const BOX_MARKER = "/usr/share/bb-box/image.json";

const TAILSCALE_APPS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
const SUDO_CHECK_MS = 10_000;

function machinePath(path) {
  const dirs = (path || "").split(delimiter).filter((dir) => dir !== "" && !dir.split(sep).some((part) => part.startsWith(GUARD_FOLDER_PREFIX)));
  return [...dirs, SYSTEM_PATH].join(delimiter);
}

function sudoNeedsNoPassword(sudo, path) {
  return spawnSync(sudo, ["-n", "true"], { stdio: "ignore", timeout: SUDO_CHECK_MS, env: { PATH: path } }).status === 0;
}

export function readTestMachineFacts({ env = process.env, marker = BOX_MARKER } = {}) {
  const path = machinePath(env.PATH);
  const sudo = firstOnPath("sudo", path);
  return {
    root: process.getuid?.() === 0,
    passwordlessSudo: sudo !== null && sudoNeedsNoPassword(sudo, path),
    tailscale: firstOnPath("tailscale", path) ?? firstOnPath("tailscaled", path) ?? TAILSCALE_APPS.find((app) => existsSync(app)) ?? null,
    box: existsSync(marker),
    githubActions: env.CI === "true" && env.GITHUB_ACTIONS === "true",
    override: env[MAY_BREAK_THIS_MACHINE] === "1",
    noExemptions: env[MACHINE_CHECK] === NO_EXEMPTIONS,
  };
}

function risksOf(facts) {
  return [
    facts.root ? "the tests run as root" : null,
    facts.passwordlessSudo ? "this user can run sudo without a password" : null,
    facts.tailscale ? `Tailscale is installed, at ${facts.tailscale}` : null,
  ].filter((risk) => risk !== null);
}

function disposable(facts) {
  return !facts.noExemptions && (facts.box || facts.githubActions);
}

export function testMachineRefusal(facts) {
  const risks = risksOf(facts);
  if (risks.length === 0 || facts.override || disposable(facts)) return null;
  return [
    `BB Box's tests will not run on this machine: ${risks.join(", and ")}.`,
    "A test that goes wrong could change this machine: one once logged a machine out of its tailnet.",
    "Run the tests in a BB Box box or on GitHub Actions.",
    `To run them here anyway, at the risk of changing this machine, set ${MAY_BREAK_THIS_MACHINE}=1.`,
  ].join(" ");
}

export function refusalForThisMachine(env = process.env) {
  if (env[MAY_BREAK_THIS_MACHINE] === "1") return null;
  return testMachineRefusal(readTestMachineFacts({ env }));
}

export function refuseRiskyTestMachine() {
  const refusal = refusalForThisMachine();
  if (refusal === null) return;
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) refuseRiskyTestMachine();
