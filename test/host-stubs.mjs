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
  "runuser",
  "setpriv",
  "killall5",
  "osascript",
  "pfctl",
];

export const READ_OR_CHANGE_COMMANDS = {
  ip: [
    "while [ $# -gt 0 ]; do case \"$1\" in -4|-6|-o|-oneline|-j|-json|-p|-pretty|-br|-brief|-d|-details|-s|-stats|-c|-color|-c=*|-color=*) shift ;; *) break ;; esac; done",
    'case "$1" in addr|address|link|route|neigh|rule) object=$1; shift ;; *) return 1 ;; esac',
    "[ $# -gt 0 ] || return 0",
    'case "$1" in show|list) return 0 ;; get) [ "$object" = route ] ;; *) return 1 ;; esac',
  ],
  route: ['for arg in "$@"; do case "$arg" in -n|-e|-ee|-v|-4|-6|--numeric|--extend|--verbose) ;; *) return 1 ;; esac; done'],
  sysctl: ['for arg in "$@"; do case "$arg" in -n|-e|-N|-q|-a|-A|-X|-b|--values|--names|--all|--ignore|--quiet|--binary) ;; -*|*=*) return 1 ;; esac; done'],
  scutil: ['[ $# -eq 2 ] && [ "$1" = --get ] && return 0', '[ $# -eq 1 ] && case "$1" in --dns|--proxy|--nwi) return 0 ;; esac', "return 1"],
};

export const PATH_GUARDED_COMMANDS = ["rm", "chown", "chmod"];

export const PRIVILEGED_COMMANDS = [...ROOT_RUNNERS, ...HOST_CHANGING_COMMANDS, ...Object.keys(READ_OR_CHANGE_COMMANDS)];

export const OWNED_FOLDERS_VARIABLE = "BBBOX_FAKE_OWNS";

const SERVICE_MANAGERS = new Set(["systemctl", "loginctl", "launchctl"]);

export const GUARD_FOLDER_PREFIX = "bbbox-test-guard-";

const STUBS_FOLDER = "host-stubs";
const RECORD_FILE = "host-stubs.log";
const RUN_AS_ROOT = ".run-as-root";
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

const CALLED_NAME = '$(basename "$0")';

function recordLine(record, name = CALLED_NAME) {
  return `printf '%s\\n' "${name}\${*:+ $*}" >> ${shellQuote(record)}`;
}

function rootRunnerStub(record, stubs, name = CALLED_NAME) {
  return [
    "#!/bin/sh",
    recordLine(record, name),
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

function readOrChangeStub(name, real, onChange) {
  return [
    "#!/bin/sh",
    "only_reads() {",
    ...READ_OR_CHANGE_COMMANDS[name].map((line) => `  ${line}`),
    "}",
    `if only_reads "$@"; then ${real ? `exec ${shellQuote(real)} "$@"` : "exit 0"}; fi`,
    onChange,
  ].join("\n");
}

function stubFor(name, record, stubs, path) {
  if (ROOT_RUNNERS.includes(name)) return rootRunnerStub(record, stubs);
  if (SERVICE_MANAGERS.has(name)) return unreachableServiceManagerStub(record);
  if (name in READ_OR_CHANGE_COMMANDS) return readOrChangeStub(name, realToolOutside(name, path), [recordLine(record), "exit 0"].join("\n"));
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

const FILE_TOOL_OPTIONS = {
  rm: {
    flags: "fiIrRdv",
    long: ["--force", "--interactive", "--interactive=*", "--one-file-system", "--preserve-root", "--preserve-root=all", "--recursive", "--dir", "--verbose"],
    operandFirst: null,
  },
  chmod: {
    flags: "Rcfv",
    long: ["--recursive", "--changes", "--silent", "--quiet", "--verbose", "--preserve-root", "--no-dereference", "--reference=*"],
    operandFirst: "mode",
  },
  chown: {
    flags: "RcfvhP",
    long: ["--recursive", "--changes", "--silent", "--quiet", "--verbose", "--preserve-root", "--no-dereference", "--reference=*", "--from=*"],
    operandFirst: "owner",
  },
};

const MODE_CHARACTERS = "rwxXstugoa0-7,+=-";

const RESOLVE_FOLLOWING_LINKS = [
  "resolve() {",
  '  target=$1',
  '  case "$target" in /*) ;; *) target=$PWD/$target ;; esac',
  '  if resolved=$(realpath -m -- "$target" 2>/dev/null); then printf \'%s\\n\' "$resolved"; return 0; fi',
  "  rest=",
  '  while [ ! -e "$target" ] && [ ! -L "$target" ]; do rest=/$(basename "$target")$rest; target=$(dirname "$target"); done',
  '  resolved=$(realpath -- "$target" 2>/dev/null) || return 1',
  '  printf \'%s%s\\n\' "$resolved" "$rest"',
  "}",
];

const OWNED_ROOTS = [
  "roots=",
  "saved_ifs=$IFS",
  "IFS=:",
  "for root in $owned; do",
  "  IFS=$saved_ifs",
  '  resolved_root=$(resolve "$root") && roots="$roots$resolved_root',
  '"',
  "done",
  "IFS=$saved_ifs",
  "inside() {",
  '  case "$1/" in */../*|*/./*) return 1 ;; esac',
  '  printf \'%s\' "$roots" | { while IFS= read -r root; do [ -n "$root" ] && case "$1/" in "$root"/*) exit 0 ;; esac; done; exit 1; }',
  "}",
];

function optionLines(options) {
  return [
    '    case "$arg" in',
    "      --) ended=1; continue ;;",
    `      ${options.long.join("|")}) continue ;;`,
    "      --*) refuse=1; break ;;",
    "      -?*)",
    '        flags=${arg#-}',
    `        case "$flags" in *[!${options.flags}]*) ;; *) continue ;; esac`,
    ...(options.operandFirst === "mode" ? [`        if [ -n "$first" ]; then case "$flags" in *[!${MODE_CHARACTERS}]*) ;; *) first=; continue ;; esac; fi`] : []),
    "        refuse=1; break ;;",
    "    esac",
  ];
}

function pathGuardedStub(name, record, real, owned) {
  const options = FILE_TOOL_OPTIONS[name];
  return [
    "#!/bin/sh",
    `owned=\${${OWNED_FOLDERS_VARIABLE}:-${shellQuote(owned)}}`,
    ...RESOLVE_FOLLOWING_LINKS,
    ...OWNED_ROOTS,
    "refuse=",
    "ended=",
    `first=${options.operandFirst ? 1 : ""}`,
    'case " $* " in *" --reference="*) first= ;; esac',
    'for arg in "$@"; do',
    '  if [ -z "$ended" ]; then',
    ...optionLines(options),
    "  fi",
    '  if [ -n "$first" ]; then first=; continue; fi',
    '  full=$(resolve "$arg") || { refuse=1; break; }',
    '  inside "$full" || { refuse=1; break; }',
    "done",
    `if [ -n "$refuse" ]; then ${recordLine(record)}; exit 0; fi`,
    real ? `exec ${shellQuote(real)} "$@"` : "exit 0",
  ].join("\n");
}

function realToolOutside(name, path) {
  return firstOnPath(name, path.split(delimiter).filter((dir) => !isTestMade(dir)).join(delimiter) || SYSTEM_PATH);
}

function writeStubs(dir, record, finalDir, path, owned) {
  mkdirSync(dir, { recursive: true });
  for (const name of privilegedToolsOn(path)) writeFileSync(join(dir, name), stubFor(name, record, finalDir, path), { mode: 0o755 });
  for (const name of PATH_GUARDED_COMMANDS) writeFileSync(join(dir, name), pathGuardedStub(name, record, realToolOutside(name, path), owned), { mode: 0o755 });
  writeFileSync(join(dir, RUN_AS_ROOT), rootRunnerStub(record, finalDir, "sudo"), { mode: 0o755 });
}

export function hostStubsIn(root, path = process.env.PATH ?? SYSTEM_PATH) {
  const stubs = join(root, STUBS_FOLDER);
  if (existsSync(stubs)) return stubs;
  const making = `${stubs}.${process.pid}.${Math.random().toString(36).slice(2)}`;
  writeStubs(making, join(root, RECORD_FILE), stubs, path, root);
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

export function runAsRootUnderHostStubs(root, path = process.env.PATH ?? SYSTEM_PATH) {
  return join(hostStubsIn(root, path), RUN_AS_ROOT);
}

export function ownedFoldersEnv(owned, temp) {
  mkdirSync(temp, { recursive: true });
  return { [OWNED_FOLDERS_VARIABLE]: [...owned, temp].join(delimiter), TMPDIR: temp };
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

export function recordingStandInsForHostTools(dir, names) {
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
