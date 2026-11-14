import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { IMAGE_CONTRACT, recordFromJson } from "../src/backends/images.ts";
import { KIND_INFO, currentKindId } from "../src/backends/kinds.ts";
import { GUARD_FOLDER_PREFIX, SYSTEM_PATH, firstOnPath } from "./host-stubs.mjs";

export const MAY_BREAK_THIS_MACHINE = "BBBOX_TESTS_MAY_BREAK_THIS_MACHINE";
export const MACHINE_CHECK = "BBBOX_TEST_MACHINE_CHECK";
export const NO_EXEMPTIONS = "strict";
export const BOX_MARKER = "/usr/share/bb-box/image.json";

export const SUDO_ANSWERS = { noPassword: "no-password", needsPassword: "needs-password", inconclusive: "inconclusive", absent: "absent" };

const SUDO_PROBE = join(dirname(fileURLToPath(import.meta.url)), "sudo-probe.mjs");
const PROBE_STARTS_WITHIN_MS = 5_000;
const ROOT_UID = 0;
const WRITABLE_BY_OTHERS = 0o022;
const TAILSCALE_APPS = ["/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
export const SUDO_PROBE_LIMITS = { answerWithinMs: 10_000, killAfterMs: 2_000 };
const ANSWERS_FROM_THE_PROBE = new Set([SUDO_ANSWERS.noPassword, SUDO_ANSWERS.needsPassword, SUDO_ANSWERS.inconclusive]);

function machinePath(path) {
  const dirs = (path || "").split(delimiter).filter((dir) => dir !== "" && !dir.split(sep).some((part) => part.startsWith(GUARD_FOLDER_PREFIX)));
  return [...dirs, SYSTEM_PATH].join(delimiter);
}

function askSudo(sudo, path, limits) {
  const ran = spawnSync(process.execPath, [SUDO_PROBE, sudo, String(limits.answerWithinMs), String(limits.killAfterMs)], {
    env: { PATH: path },
    encoding: "utf8",
    timeout: limits.answerWithinMs + limits.killAfterMs + PROBE_STARTS_WITHIN_MS,
    killSignal: "SIGKILL",
  });
  return ran.status === 0 && ANSWERS_FROM_THE_PROBE.has(ran.stdout) ? ran.stdout : SUDO_ANSWERS.inconclusive;
}

export function isBoxImageRecord(marker, expectedOwner = ROOT_UID) {
  try {
    const stat = lstatSync(marker);
    if (!stat.isFile() || stat.uid !== expectedOwner || (stat.mode & WRITABLE_BY_OTHERS) !== 0) return false;
    const record = recordFromJson(readFileSync(marker, "utf8"));
    return record !== null && record.contract === IMAGE_CONTRACT && Object.hasOwn(KIND_INFO, currentKindId(record.kind));
  } catch {
    return false;
  }
}

export function readTestMachineFacts({ env = process.env, marker = BOX_MARKER, sudoLimits = SUDO_PROBE_LIMITS } = {}) {
  const path = machinePath(env.PATH);
  const sudo = firstOnPath("sudo", path);
  return {
    root: process.getuid?.() === ROOT_UID,
    sudo: sudo === null ? SUDO_ANSWERS.absent : askSudo(sudo, path, sudoLimits),
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
