import { spawn } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { delimiter, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { recordFromJson } from "../src/backends/images.ts";
import { GUARD_FOLDER_PREFIX, SYSTEM_PATH, firstOnPath } from "./host-stubs.mjs";

export const MAY_BREAK_THIS_MACHINE = "BBBOX_TESTS_MAY_BREAK_THIS_MACHINE";
export const MACHINE_CHECK = "BBBOX_TEST_MACHINE_CHECK";
export const NO_EXEMPTIONS = "strict";
export const BOX_MARKER = "/usr/share/bb-box/image.json";

export const SUDO_ANSWERS = { noPassword: "no-password", needsPassword: "needs-password", inconclusive: "inconclusive", absent: "absent" };

const SUDO_NEEDS_A_PASSWORD = 1;
const ROOT_UID = 0;
const WRITABLE_BY_OTHERS = 0o022;
const TAILSCALE_APPS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export const SUDO_PROBE_LIMITS = { answerWithinMs: 10_000, killAfterMs: 2_000 };

function machinePath(path) {
  const dirs = (path || "").split(delimiter).filter((dir) => dir !== "" && !dir.split(sep).some((part) => part.startsWith(GUARD_FOLDER_PREFIX)));
  return [...dirs, SYSTEM_PATH].join(delimiter);
}

function signalGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch {}
}

function askSudo(sudo, path, limits) {
  return new Promise((resolve) => {
    const child = spawn(sudo, ["-n", "true"], { stdio: "ignore", detached: true, env: { PATH: path } });
    let answered = false;
    const answer = (value) => {
      if (answered) return;
      answered = true;
      clearTimeout(terminate);
      clearTimeout(kill);
      resolve(value);
    };
    const terminate = setTimeout(() => signalGroup(child, "SIGTERM"), limits.answerWithinMs);
    const kill = setTimeout(() => {
      signalGroup(child, "SIGKILL");
      answer(SUDO_ANSWERS.inconclusive);
    }, limits.answerWithinMs + limits.killAfterMs);
    child.on("error", () => answer(SUDO_ANSWERS.inconclusive));
    child.on("exit", (code) => {
      if (code === 0) answer(SUDO_ANSWERS.noPassword);
      else if (code === SUDO_NEEDS_A_PASSWORD) answer(SUDO_ANSWERS.needsPassword);
      else answer(SUDO_ANSWERS.inconclusive);
    });
  });
}

export function isBoxImageRecord(marker, expectedOwner = ROOT_UID) {
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.uid !== expectedOwner || (stat.mode & WRITABLE_BY_OTHERS) !== 0) return false;
    return recordFromJson(readFileSync(marker, "utf8")) !== null;
  } catch {
    return false;
  }
}

export async function readTestMachineFacts({ env = process.env, marker = BOX_MARKER, sudoLimits = SUDO_PROBE_LIMITS } = {}) {
  const path = machinePath(env.PATH);
  const sudo = firstOnPath("sudo", path);
  return {
    root: process.getuid?.() === ROOT_UID,
    sudo: sudo === null ? SUDO_ANSWERS.absent : await askSudo(sudo, path, sudoLimits),
    tailscale: firstOnPath("tailscale", path) ?? firstOnPath("tailscaled", path) ?? TAILSCALE_APPS.find((app) => existsSync(app)) ?? null,
    box: isBoxImageRecord(marker),
    githubActions: env.CI === "true" && env.GITHUB_ACTIONS === "true",
    override: env[MAY_BREAK_THIS_MACHINE] === "1",
    noExemptions: env[MACHINE_CHECK] === NO_EXEMPTIONS,
  };
}

function risksOf(facts) {
  return [
    facts.root ? "the tests run as root" : null,
    facts.sudo === SUDO_ANSWERS.noPassword ? "this user can run sudo without a password" : null,
    facts.sudo === SUDO_ANSWERS.inconclusive ? "BB Box could not tell whether this user can run sudo without a password, as sudo -n true did not answer in time or failed" : null,
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

export async function refusalForThisMachine(env = process.env) {
  if (env[MAY_BREAK_THIS_MACHINE] === "1") return null;
  return testMachineRefusal(await readTestMachineFacts({ env }));
}

export async function refuseRiskyTestMachine() {
  const refusal = await refusalForThisMachine();
  if (refusal === null) return;
  process.stderr.write(`${refusal}\n`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await refuseRiskyTestMachine();
