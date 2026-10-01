// Everything bb-box runs inside a box, written once per guest OS: POSIX sh
// for Linux and macOS, PowerShell for Windows. Backends never run these; the
// core sends them through the box's command transport.

import { posix } from "node:path";
import { DESKTOP_EXITS, desktopScript } from "../transports/powershell.ts";
import type { GuestOs } from "../transports/types.ts";

export { DESKTOP_EXITS };

/**
 * The thread's environment for commands in the box, relative to the box
 * user's home. bb-box writes it, readable by the box user only, before every
 * command it runs, and sources it. An enrolled box's ~/.bashrc, or ~/.zshenv
 * on macOS, sources it too, so the thread's own SSH commands get it.
 */
export function envFile(os: GuestOs): string {
  return os === "windows" ? ".config/bb-box/env.ps1" : ".config/bb-box/env";
}

/**
 * Where commands in a Linux or macOS box take the thread's access from: the
 * named variables of a live process below one that runs a program whose path
 * holds `parent`. In a box that is a BB machine, that is BB's daemon, whose
 * workers carry BB's machine variables, GH_TOKEN and the user's git
 * identity. A project's variables are only in the agent a worker starts for
 * a thread of the project on the box, a level further down (#109). Only the
 * program's path counts, not the rest of its command line: commands bb-box
 * runs carry the env file, and with it `parent`, on theirs.
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
 * Puts a macOS command in the box user's desktop session (030). sudo gives
 * `launchctl asuser` the root it needs, and runs the command as the box user
 * again, with a fresh environment, so `script` sources the env file itself.
 * A no-op goes through the wrapper first, so a Mac whose sudoers lacks the
 * rule fails with the rule to add. `sudo -l` would not do: it allows a
 * command that needs a password.
 */
function macDesktop(script: string): string {
  const wrapper = '/bin/launchctl asuser "$bb_uid" /usr/bin/sudo -n -u "$bb_user" --';
  return (
    `bb_uid=$(id -u) bb_user=$(id -un) bb_console=$(stat -f %Su /dev/console 2>/dev/null); ` +
    `if [ "$bb_console" != "$bb_user" ]; then ` +
    `printf 'bb-box: there is no desktop session to join: %s is not logged in to the desktop (the console belongs to %s).\\n' "$bb_user" "\${bb_console:-nobody}" >&2; ` +
    `exit ${DESKTOP_EXITS.noSession}; fi; ` +
    `if ! sudo -n ${wrapper} /usr/bin/true </dev/null >/dev/null 2>&1; then ` +
    `printf 'bb-box: sudo does not let %s run commands in the desktop session. Mac setup adds this rule as /etc/sudoers.d/bb-box-desktop:\\n%s ALL=(root) NOPASSWD: /bin/launchctl asuser %s /usr/bin/sudo -n -u %s -- *\\n' "$bb_user" "$bb_user" "$bb_uid" "$bb_user" >&2; ` +
    `exit ${DESKTOP_EXITS.refused}; fi; ` +
    `exec sudo -n ${wrapper} "\${SHELL:-/bin/sh}" -c ${sh(script)}`
  );
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly session?: Session;
  /** The env file's new contents, written before the command runs. */
  readonly env?: string;
  /** Stops the command and everything it started, in the box, after this long. */
  readonly timeoutMs?: number;
}

/**
 * What a command stopped in the box at its timeout exits with: GNU
 * timeout's TERM, then KILL 5 s later, on Linux, the same from MAC_TIMEOUT
 * on macOS, and taskkill's on Windows.
 */
export function timedOutExits(os: GuestOs): readonly number[] {
  return os === "windows" ? [1] : [124, 137];
}

/**
 * GNU timeout -k 5, in the Perl every Mac has, since macOS has no timeout:
 * runs its arguments in a process group of their own, and after the given
 * seconds sends the group TERM, then KILL 5 s later if the command is still
 * there. Once a timed-out command ends, what is left of the group is
 * killed, so nothing it started runs on. Exits as GNU timeout does: 124 when
 * it timed out, 128 and the signal when the command died of one.
 */
const MAC_TIMEOUT = String.raw`my $t = shift;
my $pid = fork;
die "bb-box: fork: $!\n" unless defined $pid;
if (!$pid) { setpgrp(0, 0); exec @ARGV or exit 127 }
my $timed = 0;
$SIG{ALRM} = sub { $timed = 1; kill "TERM", -$pid; $SIG{ALRM} = sub { kill "KILL", -$pid }; alarm 5 };
alarm $t;
my $r;
do { $r = waitpid($pid, 0) } until $r == $pid || ($r == -1 && !$!{EINTR});
my $s = $?;
alarm 0;
if ($timed) { kill "KILL", -$pid; exit(($s & 127) == 9 ? 137 : 124) }
exit(($s & 127) ? 128 + ($s & 127) : $s >> 8);`;

/** Runs `script` under MAC_TIMEOUT, or as it is on a Mac without Perl. */
function macTimeout(script: string, timeoutMs: number): string {
  const shell = `"\${SHELL:-/bin/sh}" -c ${sh(script)}`;
  return `if [ -x /usr/bin/perl ]; then exec /usr/bin/perl -e ${sh(MAC_TIMEOUT)} ${Math.ceil(timeoutMs / 1000)} ${shell}; else exec ${shell}; fi`;
}

/**
 * Wraps `script` so it runs with the thread's environment, in `cwd` when
 * given. The whole script runs in `cwd`, or none of it does.
 */
export function command(os: GuestOs, script: string, options: CommandOptions = {}): string {
  if (os === "windows") {
    const file = `$bbBoxEnv = Join-Path $HOME ${ps(envFile(os))}; `;
    const write =
      options.env === undefined
        ? ""
        : `New-Item -ItemType Directory -Force -Path (Split-Path $bbBoxEnv) | Out-Null; Set-Content -LiteralPath $bbBoxEnv -NoNewline -Value ${ps(options.env)}; `;
    const env = "if (Test-Path -LiteralPath $bbBoxEnv) { . $bbBoxEnv }; ";
    const cd = options.cwd ? `Set-Location -LiteralPath ${ps(options.cwd)} -ErrorAction Stop; ` : "";
    if (options.session === "desktop") return `${write && file + write}${desktopScript(`${file}${env}${cd}${script}`, options.timeoutMs)}`;
    return `${windowsTimeout(options.timeoutMs)}${file}${write}${env}${cd}${script}`;
  }
  const file = `"$HOME/${envFile(os)}"`;
  const write =
    options.env === undefined
      ? ""
      : `(umask 077 && mkdir -p "$HOME/${posix.dirname(envFile(os))}" && printf '%s' ${sh(options.env)} > ${file}.$$ && mv -f ${file}.$$ ${file}) 2>/dev/null; `;
  const env = `if [ -r ${file} ]; then . ${file}; fi; `;
  const cd = options.cwd ? `cd -- ${sh(options.cwd)} || exit 1; ` : "";
  if (os === "macos") {
    // Killing the local ssh leaves the command running in the box, as on Linux.
    const run = options.timeoutMs === undefined ? script : macTimeout(script, options.timeoutMs);
    return options.session === "desktop" ? `${write}${macDesktop(`${env}${cd}${run}`)}` : `${write}${env}${cd}${run}`;
  }
  const desktop = options.session === "desktop" ? LINUX_DESKTOP : "";
  if (options.timeoutMs === undefined) return `${write}${env}${desktop}${cd}${script}`;
  // Killing the local ssh leaves the command running in the box. GNU timeout
  // gives the script its own process group and stops all of it.
  const shell = `"\${SHELL:-/bin/sh}" -c ${sh(script)}`;
  const timeout = `timeout -k 5 ${options.timeoutMs / 1000} ${shell}`;
  return `${write}${env}${desktop}${cd}if command -v timeout >/dev/null 2>&1; then exec ${timeout}; else exec ${shell}; fi`;
}

/**
 * As on Linux, killing the local ssh leaves the command running in the box.
 * sshd runs it in a job that ends all its processes when its PowerShell
 * exits, so a watchdog in the job ends that PowerShell after `timeoutMs`,
 * rounded up to a second, and the job ends the rest. A command that finishes
 * first ends the watchdog with it. The watchdog has a console of its own, so
 * it does not hold the command's output open, and ping waits a second
 * between pings.
 */
function windowsTimeout(timeoutMs: number | undefined): string {
  if (timeoutMs === undefined) return "";
  const pings = Math.ceil(timeoutMs / 1000) + 1;
  return `Start-Process -WindowStyle Hidden cmd -ArgumentList '/d', '/c', ('ping -n ${pings} 127.0.0.1 >nul & taskkill /F /PID ' + $PID + ' >nul') -ErrorAction Ignore; `;
}

/** The names to take, valid and once each. */
function accessNames(access: Access): string[] {
  return [...new Set(access.names.filter((name) => NAME.test(name)))].sort();
}

/**
 * Sets the named variables from the newest of the processes below `parent`
 * that has the most of them, afresh each time the env file is sourced, so a
 * change in BB reaches the next command. BB gives some workers only some of
 * its variables. Values never reach the disk. Needs GNU grep and sed.
 */
function accessLoader(access: Access): string {
  const names = accessNames(access);
  if (!names.length) return "";
  const pattern = sh(`^(${names.join("|")})=`);
  return String.raw`bb_box_access() (
  ps -u "$(id -u)" -o pid= -o ppid= -o etimes= -o args= 2>/dev/null |
    awk -v parent=${sh(access.parent)} '{ up[$1] = $2; age[$1] = $3; program[$1] = $5 }
      END { for (pid in up) for (a = up[pid]; a in up; a = up[a]) if (index(program[a], parent)) { print age[pid], pid; break } }' |
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
 * The same on macOS, which has no /proc: `ps -E` prints a process's
 * environment after its arguments. Each variable runs from ` NAME=` to the
 * next ` WORD=`, and ps prints a newline in a value as `\012` and a tab as
 * `\011`, but a backslash as it is. So a value holding a space then `WORD=`,
 * or a backslash then three digits, can read wrongly. Elapsed times read
 * [[DD-]HH:]MM:SS.
 */
function macAccessLoader(access: Access): string {
  const names = accessNames(access);
  if (!names.length) return "";
  return String.raw`bb_box_access() (
  LC_ALL=en_US.UTF-8 ps -ww -U "$(id -u)" -o pid= -o ppid= -o etime= -o command= 2>/dev/null |
    LC_ALL=C awk -v parent=${sh(access.parent)} -v names=${sh(names.join(" "))} '
      function secs(t, p, n) { n = split(t, p, /[-:]/); return p[n] + 60 * p[n - 1] + 3600 * p[n - 2] + 86400 * p[n - 3] }
      function decode(s, out, c) {
        while (match(s, /\\[0-3][0-7][0-7]/)) {
          c = substr(s, RSTART + 1, 3)
          out = out substr(s, 1, RSTART - 1) sprintf("%c", substr(c, 1, 1) * 64 + substr(c, 2, 1) * 8 + substr(c, 3, 1))
          s = substr(s, RSTART + RLENGTH)
        }
        return out s
      }
      function quote(s, out, i) {
        while ((i = index(s, q))) { out = out substr(s, 1, i - 1) q "\\" q q; s = substr(s, i + 1) }
        return q out s q
      }
      BEGIN { q = "\047"; n = split(names, list, " "); for (i = 1; i <= n; i++) wanted[list[i]] = 1 }
      $1 ~ /^[0-9]+$/ {
        up[$1] = $2; age[$1] = secs($3); program[$1] = $5
        line = $0; sub(/^ *[0-9]+ +[0-9]+ +[^ ]+ +/, "", line); args[$1] = line
      }
      END {
        for (pid in up) for (a = up[pid]; a in up; a = up[a]) if (index(program[a], parent)) { pids = pids (pids == "" ? "" : ",") pid; break }
        if (pids == "") exit
        ps = "LC_ALL=en_US.UTF-8 ps -E -ww -o pid= -o command= -p " pids " 2>/dev/null"
        while ((ps | getline line) > 0) {
          pid = line; sub(/^ */, "", pid); sub(/ .*/, "", pid); sub(/^ *[0-9]+ +/, "", line)
          if (!(pid in args) || substr(line, 1, length(args[pid]) + 1) != args[pid] " ") continue
          rest = substr(line, length(args[pid]) + 1); name = ""
          for (;;) {
            value = rest; next_name = ""
            if (match(rest, / [A-Za-z_][A-Za-z0-9_]*=/)) {
              value = substr(rest, 1, RSTART - 1); next_name = substr(rest, RSTART + 1, RLENGTH - 2)
              rest = substr(rest, RSTART + RLENGTH)
            }
            if ((name in wanted) && !((pid, name) in got)) { got[pid, name] = value; count[pid]++ }
            if (next_name == "") break
            name = next_name
          }
        }
        close(ps)
        for (pid in count)
          if (count[pid] > most || (count[pid] == most && (age[pid] < age[best] || (age[pid] == age[best] && pid + 0 > best + 0)))) { best = pid; most = count[pid] }
        for (i = 1; i <= n; i++) if ((best, list[i]) in got) print "export " list[i] "=" quote(decode(got[best, list[i]]))
      }'
)
eval "$(bb_box_access)"
unset -f bb_box_access
`;
}

/**
 * The file that sets `variables` for commands in the box, and on Linux and
 * macOS takes the thread's access. Names that are not valid shell names are
 * left out. On Linux, package installs ask nothing, since nobody could
 * answer; a variable of the thread's own can say otherwise.
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
  const loader = !access ? "" : os === "macos" ? macAccessLoader(access) : accessLoader(access);
  return header + defaults + names.map((name) => `export ${name}=${sh(variables[name]!)}`).join("\n") + "\n" + loader;
}

/** The line an enrolled box's shell startup file starts with, above anything that returns early. */
const SHELL_HOOK = `# Added by bb-box: the thread's environment and access, for SSH commands too.
if [ -r "$HOME/${envFile("linux")}" ]; then . "$HOME/${envFile("linux")}"; fi
`;

/**
 * Run once a Linux or macOS box is a BB machine, after the env file is
 * written: the shell's startup file sources the env file first, git asks gh
 * for GitHub credentials, so both use GH_TOKEN, and git fetches GitHub's SSH
 * URLs over HTTPS, as on the thread's machine. Each rewrite replaces only
 * its own entry: an empty one would match every URL. That file is ~/.bashrc,
 * or ~/.zshenv on macOS, since an SSH command there runs a zsh that is not a
 * login shell, which reads only ~/.zshenv. Prints how long it took in the
 * box, in milliseconds, for the enrolment's log, when the box's date can
 * tell. Null for Windows.
 */
export function accessSetup(os: GuestOs): string | null {
  if (os === "windows") return null;
  // cp -p gives the new file the old one's mode, which writing it keeps.
  return String.raw`started=$(date +%s%N)
f="$HOME/${os === "macos" ? ".zshenv" : ".bashrc"}"
if ! grep -qsF ${sh(envFile(os))} "$f"; then
  { [ ! -e "$f" ] || cp -p "$f" "$f.bb-box"; } &&
    { printf '%s\n' ${sh(SHELL_HOOK)} && { [ ! -e "$f" ] || cat "$f"; }; } > "$f.bb-box" && mv -f "$f.bb-box" "$f"
fi
code=0
if command -v git >/dev/null 2>&1; then
  if command -v gh >/dev/null 2>&1; then
    gh auth setup-git >/dev/null 2>&1 || {
      git config --global --replace-all credential.https://github.com.helper '' &&
        git config --global --add credential.https://github.com.helper '!gh auth git-credential'
    } || code=$?
  fi
  git config --global --replace-all url.https://github.com/.insteadOf git@github.com: '^git@github\.com:$' &&
    git config --global --replace-all url.https://github.com/.insteadOf ssh://git@github.com/ '^ssh://git@github\.com/$' || code=$?
fi
ended=$(date +%s%N)
case "$started$ended" in *[!0-9]* | "") ;; *) echo $(((ended - started) / 1000000)) ;; esac
exit "$code"
`;
}

/** How long the access setup took in the box, from its output: null when it could not tell. */
export function accessSetupMs(stdout: string): number | null {
  const ms = /^(\d+)\n?$/.exec(stdout)?.[1];
  return ms === undefined ? null : Number(ms);
}

/** What the access check exits with. */
export const ACCESS_CHECK_EXITS = { found: 0, waiting: 1, noDaemon: 2 } as const;

/**
 * Run with the env file sourced, once a box's BB daemon connects: whether
 * the box's commands have the thread's access yet. BB starts the workers
 * that carry the variables a moment after its daemon connects. Exits 0 when
 * the env file set any of the names, 1 while the daemon runs without such a
 * worker, and 2 when nothing runs the daemon's program, so there is nothing
 * to wait for. Null for Windows, or when there are no names.
 */
export function accessCheck(os: GuestOs, access: Access): string | null {
  const names = accessNames(access);
  if (os === "windows" || !names.length) return null;
  const set = names.map((name) => `[ -n "\${${name}:-}" ]`).join(" || ");
  return (
    `if ${set}; then exit ${ACCESS_CHECK_EXITS.found}; fi\n` +
    `ps -ww -U "$(id -u)" -o command= 2>/dev/null |\n` +
    `  awk -v parent=${sh(access.parent)} 'index($2, parent) { found = 1 } END { exit !found }' && exit ${ACCESS_CHECK_EXITS.waiting}\n` +
    `exit ${ACCESS_CHECK_EXITS.noDaemon}\n`
  );
}

/**
 * Runs the computer-use driver's MCP proxy (015), whose stdin and stdout
 * carry the session. The driver's daemon listens on `socket` in the box's
 * desktop session; the proxy needs nothing from that session.
 */
export function driverCommand(os: GuestOs, socket: string): string {
  return os === "windows" ? `& cua-driver mcp --socket ${ps(socket)}` : `exec cua-driver mcp --socket ${sh(socket)}`;
}
