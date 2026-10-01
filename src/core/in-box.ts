// Everything bb-box runs inside a box, written once per guest OS: POSIX sh
// for Linux and macOS, PowerShell for Windows. Backends never run these; the
// core sends them through the box's command transport.

import { posix } from "node:path";
import type { GuestOs } from "../transports/types.ts";

/**
 * The thread's environment for commands in the box, relative to the box
 * user's home. bb-box writes it, readable by the box user only, before every
 * command it runs, and sources it. An enrolled Linux box's ~/.bashrc sources
 * it too, so the thread's own SSH commands get it.
 */
export function envFile(os: GuestOs): string {
  return os === "windows" ? ".config/bb-box/env.ps1" : ".config/bb-box/env";
}

/**
 * Where commands in a Linux box take the thread's access from: the named
 * variables of a live process whose parent runs a program whose path holds
 * `parent`. In a box that is a BB machine, that parent is BB's daemon, whose
 * workers carry BB's machine variables and GH_TOKEN. Only the program's path
 * counts, not the rest of its command line: commands bb-box runs carry the
 * env file, and with it `parent`, on theirs.
 */
export interface Access {
  readonly names: readonly string[];
  readonly parent: string;
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Where a command runs: as the transport runs it, or in the box's logged-in desktop session. */
export type Session = "default" | "desktop";

/**
 * Puts a Linux command in the desktop session: the display and the session
 * bus of the box user's login. Values the box already sets are kept.
 */
const LINUX_DESKTOP =
  'export DISPLAY="${DISPLAY:-:0}" XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"; ' +
  'export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"; ';

/**
 * Whether bb-box can put a command in the desktop session of a box with this
 * OS, when its transport runs outside it. macOS needs a LaunchAgent and
 * Windows a scheduled task with /IT, which bb-box does not have yet.
 */
export function canRunInDesktop(os: GuestOs): boolean {
  return os === "linux";
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly session?: Session;
  /** The env file's new contents, written before the command runs. */
  readonly env?: string;
  /** Stops the command and everything it started, in the box, after this long. Linux boxes only. */
  readonly timeoutMs?: number;
}

/** What GNU timeout exits with when it stops a command: TERM first, then KILL 5 s later. */
export const TIMED_OUT_EXITS: readonly number[] = [124, 137];

/**
 * Wraps `script` so it runs with the thread's environment, in `cwd` when
 * given. The whole script runs in `cwd`, or none of it does.
 */
export function command(os: GuestOs, script: string, options: CommandOptions = {}): string {
  if (options.session === "desktop" && !canRunInDesktop(os)) throw new Error(`bb-box cannot run commands in a ${os} desktop session yet.`);
  if (os === "windows") {
    const file = `$bbBoxEnv = Join-Path $HOME ${ps(envFile(os))}; `;
    const write =
      options.env === undefined
        ? ""
        : `New-Item -ItemType Directory -Force -Path (Split-Path $bbBoxEnv) | Out-Null; Set-Content -LiteralPath $bbBoxEnv -NoNewline -Value ${ps(options.env)}; `;
    const env = "if (Test-Path -LiteralPath $bbBoxEnv) { . $bbBoxEnv }; ";
    const cd = options.cwd ? `Set-Location -LiteralPath ${ps(options.cwd)} -ErrorAction Stop; ` : "";
    return `${file}${write}${env}${cd}${script}`;
  }
  const file = `"$HOME/${envFile(os)}"`;
  const write =
    options.env === undefined
      ? ""
      : `(umask 077 && mkdir -p "$HOME/${posix.dirname(envFile(os))}" && printf '%s' ${sh(options.env)} > ${file}.$$ && mv -f ${file}.$$ ${file}) 2>/dev/null; `;
  const env = `if [ -r ${file} ]; then . ${file}; fi; `;
  const desktop = options.session === "desktop" ? LINUX_DESKTOP : "";
  const cd = options.cwd ? `cd -- ${sh(options.cwd)} || exit 1; ` : "";
  if (os !== "linux" || options.timeoutMs === undefined) return `${write}${env}${desktop}${cd}${script}`;
  // Killing the local ssh leaves the command running in the box. GNU timeout
  // gives the script its own process group and stops all of it.
  const shell = `"\${SHELL:-/bin/sh}" -c ${sh(script)}`;
  const timeout = `timeout -k 5 ${options.timeoutMs / 1000} ${shell}`;
  return `${write}${env}${desktop}${cd}if command -v timeout >/dev/null 2>&1; then exec ${timeout}; else exec ${shell}; fi`;
}

/**
 * Sets the named variables from the newest of the processes under `parent`
 * that has the most of them, afresh each time the env file is sourced, so a
 * change in BB reaches the next command. BB gives some workers only some of
 * its variables. Values never reach the disk. Needs GNU grep and sed.
 */
function accessLoader(access: Access): string {
  const names = access.names.filter((name) => NAME.test(name));
  if (!names.length) return "";
  const pattern = sh(`^(${[...new Set(names)].sort().join("|")})=`);
  return String.raw`bb_box_access() (
  ps -u "$(id -u)" -o pid= -o ppid= -o etimes= -o args= 2>/dev/null |
    awk -v parent=${sh(access.parent)} '{ up[$1] = $2; age[$1] = $3; program[$1] = $5 }
      END { for (pid in up) if (index(program[up[pid]], parent)) print age[pid], pid }' |
    sort -k1,1n -k2,2nr | {
      best= most=0
      while read -r _ pid; do
        count=$(grep -zcE ${pattern} "/proc/$pid/environ" 2>/dev/null) || continue
        if [ "$count" -gt "$most" ]; then best=$pid most=$count; fi
      done
      [ -n "$best" ] && grep -zE ${pattern} "/proc/$best/environ" |
        sed -z "s/'/'\\\\''/g; s/=/='/; s/^/export /; s/\$/'/" | tr '\0' '\n'
    }
)
eval "$(bb_box_access)"
unset -f bb_box_access
`;
}

/**
 * The file that sets `variables` for commands in the box, and on Linux takes
 * the thread's access. Names that are not valid shell names are left out. On
 * Linux, package installs ask nothing, since nobody could answer; a variable
 * of the thread's own can say otherwise.
 */
export function envScript(os: GuestOs, variables: Readonly<Record<string, string>>, access?: Access): string {
  const names = Object.keys(variables)
    .filter((name) => NAME.test(name))
    .sort();
  if (os === "windows") {
    return names.map((name) => `$env:${name} = ${ps(variables[name]!)}`).join("\r\n") + "\r\n";
  }
  const header = "# Written by bb-box: the thread's environment for commands in this box.\n";
  const defaults = os === "linux" ? "export DEBIAN_FRONTEND=noninteractive\n" : "";
  const loader = access && os === "linux" ? accessLoader(access) : "";
  return header + defaults + names.map((name) => `export ${name}=${sh(variables[name]!)}`).join("\n") + "\n" + loader;
}

/** The line an enrolled Linux box's ~/.bashrc starts with, above anything that returns early. */
const BASHRC_HOOK = `# Added by bb-box: the thread's environment and access, for SSH commands too.
if [ -r "$HOME/${envFile("linux")}" ]; then . "$HOME/${envFile("linux")}"; fi
`;

/**
 * Run once a Linux box is a BB machine, after the env file is written:
 * ~/.bashrc sources the env file first, and git asks gh for GitHub
 * credentials, so both use GH_TOKEN. Null for other systems.
 */
export function accessSetup(os: GuestOs): string | null {
  if (os !== "linux") return null;
  return String.raw`f="$HOME/.bashrc"
if ! grep -qsF ${sh(envFile(os))} "$f"; then
  { printf '%s\n' ${sh(BASHRC_HOOK)} && { [ ! -e "$f" ] || cat "$f"; }; } > "$f.bb-box" &&
    { [ ! -e "$f" ] || chmod --reference="$f" "$f.bb-box"; } && mv -f "$f.bb-box" "$f"
fi
if command -v gh >/dev/null 2>&1 && command -v git >/dev/null 2>&1; then
  gh auth setup-git >/dev/null 2>&1 || {
    git config --global --replace-all credential.https://github.com.helper '' &&
      git config --global --add credential.https://github.com.helper '!gh auth git-credential'
  }
fi
`;
}

/**
 * Runs the computer-use driver's MCP proxy (015), whose stdin and stdout
 * carry the session. The driver's daemon listens on `socket` in the box's
 * desktop session; the proxy needs nothing from that session.
 */
export function driverCommand(os: GuestOs, socket: string): string {
  return os === "windows" ? `& cua-driver mcp --socket ${ps(socket)}` : `exec cua-driver mcp --socket ${sh(socket)}`;
}
