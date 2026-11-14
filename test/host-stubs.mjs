import { accessSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

export const ROOT_RUNNERS = ["sudo", "doas", "pkexec"];

export const HOST_CHANGING_COMMANDS = [
  "su",
  "tailscale",
  "tailscaled",
  "systemctl",
  "loginctl",
  "launchctl",
  "reboot",
  "shutdown",
  "poweroff",
  "halt",
  "iptables",
  "ip6tables",
  "iptables-restore",
  "ip6tables-restore",
  "nft",
  "mount",
  "umount",
  "pkill",
  "killall",
  "useradd",
  "userdel",
  "usermod",
  "groupadd",
  "groupdel",
  "chpasswd",
  "passwd",
  "visudo",
  "apt-get",
  "apt",
  "modprobe",
  "rmmod",
  "dscl",
  "sysadminctl",
  "pmset",
  "networksetup",
  "softwareupdate",
];

export const PATH_GUARDED_COMMANDS = ["rm", "chown", "chmod"];

export const PRIVILEGED_COMMANDS = [...ROOT_RUNNERS, ...HOST_CHANGING_COMMANDS];

const SERVICE_MANAGERS = new Set(["systemctl", "loginctl", "launchctl"]);

export const GUARD_FOLDER_PREFIX = "bbbox-test-guard-";

const STUBS_FOLDER = "host-stubs";
const RECORD_FILE = "host-stubs.log";
export const SYSTEM_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function realOrSame(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

const LONGEST_TEMP_BASE = 40;

function shortTempBaseAsBbBoxChoosesIt() {
  return tmpdir().length > LONGEST_TEMP_BASE ? "/tmp" : tmpdir();
}

let rootsOfThisProcess = null;

export function testMadeRoots() {
  rootsOfThisProcess ??= [...new Set([tmpdir(), shortTempBaseAsBbBoxChoosesIt()].flatMap((base) => [base, realOrSame(base)]))];
  return rootsOfThisProcess;
}

export function isTestMade(path) {
  return testMadeRoots().some((root) => path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
}

function executableIn(dir, name) {
  const path = join(dir, name);
  try {
    accessSync(path, constants.X_OK);
    return path;
  } catch {
    return null;
  }
}

export function firstOnPath(name, path) {
  for (const dir of path.split(delimiter)) {
    if (!dir) continue;
    const found = executableIn(dir, name);
    if (found) return found;
  }
  return null;
}

export function realHostToolsReached(path, madeByTests = isTestMade) {
  return PRIVILEGED_COMMANDS.flatMap((name) => {
    const found = firstOnPath(name, path);
    return found && !madeByTests(found) ? [found] : [];
  });
}

export function refusalForRealHostTools(fake, path, madeByTests = isTestMade) {
  const reached = realHostToolsReached(path, madeByTests);
  if (!reached.length) return null;
  return `${fake} refused to run a box's script: it would reach the test machine's own ${reached.join(", ")}. Put the fake's host stubs first on its PATH.\n`;
}

function recordLine(record) {
  return `printf '%s\\n' "$(basename "$0")\${*:+ $*}" >> ${shellQuote(record)}`;
}

function rootRunnerStub(record, stubs) {
  return [
    "#!/bin/sh",
    recordLine(record),
    "while [ $# -gt 0 ]; do",
    '  case "$1" in',
    "    -u|-g|-p|-C|-D|-R|-T|-U|-h) shift 2 ;;",
    "    --) shift; break ;;",
    "    -*) shift ;;",
    "    *) break ;;",
    "  esac",
    "done",
    '[ $# -gt 0 ] || exit 0',
    'case "$1" in',
    `  /*) stubbed=${shellQuote(stubs)}/"\${1##*/}"; if [ -x "$stubbed" ]; then shift; set -- "$stubbed" "$@"; fi ;;`,
    "esac",
    'exec env "$@"',
  ].join("\n");
}

function hostChangingStub(record) {
  return ["#!/bin/sh", recordLine(record), "exit 0"].join("\n");
}

function unreachableServiceManagerStub(record) {
  return ["#!/bin/sh", recordLine(record), 'echo "Failed to connect to bus: no service manager in a fake box" >&2', "exit 1"].join("\n");
}

function stubFor(name, record, stubs) {
  if (ROOT_RUNNERS.includes(name)) return rootRunnerStub(record, stubs);
  if (SERVICE_MANAGERS.has(name)) return unreachableServiceManagerStub(record);
  return hostChangingStub(record);
}

function withoutGuardFolders(path) {
  return path
    .split(delimiter)
    .filter((dir) => !dir.split(sep).some((part) => part.startsWith(GUARD_FOLDER_PREFIX)))
    .join(delimiter);
}

export function privilegedToolsOn(path) {
  const searched = withoutGuardFolders(path);
  return PRIVILEGED_COMMANDS.filter((name) => firstOnPath(name, searched) !== null);
}

const TAKES_OWNER_OR_MODE_FIRST = new Set(["chown", "chmod"]);

function pathGuardedStub(name, record, real) {
  const roots = testMadeRoots().map(shellQuote).join(" ");
  return [
    "#!/bin/sh",
    "outside=",
    `skip=${TAKES_OWNER_OR_MODE_FIRST.has(name) ? 1 : ""}`,
    'for operand in "$@"; do',
    '  case "$operand" in -*) continue ;; esac',
    '  if [ -n "$skip" ]; then skip=; continue; fi',
    '  case "$operand" in /*) full=$operand ;; *) full=$PWD/$operand ;; esac',
    '  case "/$full/" in */../*) outside=1; break ;; esac',
    "  inside=",
    `  for root in ${roots}; do case "$full" in "$root"/*) inside=1 ;; esac; done`,
    '  [ -n "$inside" ] || { outside=1; break; }',
    "done",
    `if [ -n "$outside" ]; then ${recordLine(record)}; exit 0; fi`,
    real ? `exec ${shellQuote(real)} "$@"` : "exit 0",
  ].join("\n");
}

function realToolOutside(name, path) {
  return firstOnPath(name, path.split(delimiter).filter((dir) => !isTestMade(dir)).join(delimiter) || SYSTEM_PATH);
}

function writeStubs(dir, record, finalDir, path) {
  mkdirSync(dir, { recursive: true });
  for (const name of privilegedToolsOn(path)) writeFileSync(join(dir, name), stubFor(name, record, finalDir), { mode: 0o755 });
  for (const name of PATH_GUARDED_COMMANDS) writeFileSync(join(dir, name), pathGuardedStub(name, record, realToolOutside(name, path)), { mode: 0o755 });
}

export function hostStubsIn(root, path = process.env.PATH ?? SYSTEM_PATH) {
  const stubs = join(root, STUBS_FOLDER);
  if (existsSync(stubs)) return stubs;
  const making = `${stubs}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeStubs(making, join(root, RECORD_FILE), stubs, path);
  try {
    renameSync(making, stubs);
  } catch {
    rmSync(making, { recursive: true, force: true });
  }
  return stubs;
}

export function pathWithHostStubs(root, testBins, rest) {
  const after = rest || SYSTEM_PATH;
  return [...testBins, hostStubsIn(root, after), after].join(delimiter);
}

export function hostCommandsRecorded(root) {
  const record = join(root, RECORD_FILE);
  return existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : [];
}

let stubsForThisProcess = null;

export function hostStubsRootForThisProcess() {
  if (stubsForThisProcess) return stubsForThisProcess;
  const root = mkdtempSync(join(tmpdir(), "bbbox-test-stubs-"));
  process.once("exit", () => rmSync(root, { recursive: true, force: true }));
  stubsForThisProcess = root;
  return root;
}

export function pathRefusingRealHostTools(fake, path) {
  const refusal = refusalForRealHostTools(fake, path);
  if (refusal) throw new Error(refusal.trim());
  return path;
}

export function recordingStandInsForHostTools(dir, names = PRIVILEGED_COMMANDS) {
  const record = join(dir, "ran.log");
  mkdirSync(join(dir, "bin"), { recursive: true });
  for (const name of names) writeFileSync(join(dir, "bin", name), hostChangingStub(record), { mode: 0o755 });
  return {
    dir: join(dir, "bin"),
    ran: () => (existsSync(record) ? readFileSync(record, "utf8").split("\n").filter(Boolean) : []),
  };
}

export async function withHostToolsFirstOnPath(standIns, run) {
  const before = process.env.PATH;
  process.env.PATH = `${standIns.dir}${delimiter}${before ?? SYSTEM_PATH}`;
  try {
    return await run();
  } finally {
    process.env.PATH = before;
  }
}
