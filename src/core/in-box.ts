// Everything bb-box runs inside a box, written once per guest OS: POSIX sh
// for Linux and macOS, PowerShell for Windows. Backends never run these; the
// core sends them through the box's command transport.

import { randomBytes } from "node:crypto";
import { posix } from "node:path";
import { DESKTOP_EXITS, desktopScript, powershellCommand } from "../transports/powershell.ts";
import { LOADS_ENV } from "../transports/process.ts";
import type { GuestOs } from "../transports/types.ts";
import { WINDOWS_ACCESS_SETUP, windowsAccessCheck, windowsAccessLoader } from "./windows-access.ts";

export { DESKTOP_EXITS };

/**
 * The thread's environment for commands in the box, relative to the box
 * user's home. bb-box writes it, readable by the box user only, before every
 * command it runs, and sources it. An enrolled box's ~/.bashrc, or ~/.zshenv
 * on macOS, sources it too, so the thread's own SSH commands get it, but not
 * in the shells of bb-box's own commands, which start with LOADS_ENV.
 */
export function envFile(os: GuestOs): string {
  return os === "windows" ? ".config/bb-box/env.ps1" : ".config/bb-box/env";
}

/**
 * Where commands in a box take the thread's access from: the named
 * variables of a live process below one that runs a program whose path
 * holds `parent`, with \ read as / on Windows (#560). In a box that is a BB machine, that is BB's daemon, whose
 * workers carry BB's machine variables, GH_TOKEN and the user's git
 * identity. A project's variables are only in the agent a worker starts for
 * a thread of the project on the box, a level further down (#109). Only the
 * program's path counts, not the rest of its command line: commands bb-box
 * runs carry the env file, and with it `parent`, on theirs.
 */
export interface Access {
  readonly names: readonly string[];
  readonly parent: string;
  /**
   * Of `names`, those a box's commands must have before it counts as having
   * the thread's access, such as GH_TOKEN, which git needs. BB can give a
   * new machine some variables before others. Any name counts when empty.
   */
  readonly required?: readonly string[];
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * A macOS box's pasteboard as UTF-8 text: `read` prints it, `write` sets it
 * from stdin (#464). Run in the box user's desktop session, whose pasteboard
 * the desktop shows. pbcopy and pbpaste take their encoding from the locale,
 * which a command through `launchctl asuser` lacks.
 */
export const MAC_CLIPBOARD = {
  read: "LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 exec pbpaste",
  write: "LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 exec pbcopy",
} as const;

/**
 * A Windows box's clipboard as UTF-8 text, as MAC_CLIPBOARD is a Mac's (#461): PowerShell 7's Get-Clipboard and
 * Set-Clipboard, run in the box user's desktop session (039), whose clipboard the desktop shows; a command over SSH
 * has a window station, and a clipboard, of its own. The text goes as UTF-8 bytes both ways, not through the
 * console's code page. Measured on both Windows kinds on 7 October 2026: a write and a read take 2 to 4 s on
 * Proxmox QEMU and about 8 s on a Mac's Tart, most of it the desktop session's scheduled task and PowerShell starting.
 */
export const WINDOWS_CLIPBOARD = {
  read: "$t=Get-Clipboard -Raw;if($t){$b=[Text.Encoding]::UTF8.GetBytes($t);$o=[Console]::OpenStandardOutput();$o.Write($b,0,$b.Length);$o.Flush()}",
  write: "$m=[IO.MemoryStream]::new();[Console]::OpenStandardInput().CopyTo($m);Set-Clipboard -Value ([Text.Encoding]::UTF8.GetString($m.ToArray()))",
} as const;

/** The commands that read and write a box's clipboard in its desktop session, for a desktop whose server moves none; null where bb-box has none. */
export function clipboardCommands(os: GuestOs): { readonly read: string; readonly write: string } | null {
  return os === "macos" ? MAC_CLIPBOARD : os === "windows" ? WINDOWS_CLIPBOARD : null;
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
 * bb-box's launcher in a macOS image (#628), which a desktop command goes
 * through where the box has it: what the command starts is attributed by
 * TCC to the launcher, which has the microphone, the camera, the system's
 * audio and what sshd has, rather than to sshd, for which nothing can be
 * asked (setup/tart/guest/launcher.sh).
 */
export const MAC_LAUNCHER = "/usr/local/libexec/bb-box/Launcher.app/Contents/MacOS/bb-box-launcher";

/**
 * Puts a macOS command in the box user's desktop session (030). sudo gives
 * `launchctl asuser` the root it needs, and runs the command as the box user
 * again, with a fresh environment, so `script` sources the env file itself.
 * A no-op goes through the wrapper first, so a Mac whose sudoers lacks the
 * rule fails with the rule to add. `sudo -l` would not do: it allows a
 * command that needs a password. The command goes through the launcher where
 * the box has it.
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
    `bb_launch=; [ ! -x ${MAC_LAUNCHER} ] || bb_launch=${MAC_LAUNCHER}; ` +
    `exec sudo -n ${wrapper} $bb_launch "\${SHELL:-/bin/sh}" -c ${sh(LOADS_ENV + script)}`
  );
}

export interface CommandOptions {
  readonly cwd?: string;
  readonly session?: Session;
  /** The env file's new contents, written before the command runs. */
  readonly env?: string;
  /** Stops the command and everything it started, in the box, after this long. */
  readonly timeoutMs?: number;
  /** On Linux and macOS, runs the command as a job, whose result outlives bb-box (#405). */
  readonly job?: JobOptions;
}

export interface JobOptions {
  /** The job's ID, from newJobId. */
  readonly id: string;
  /** Jobs whose results bb-box has, whose files go first. */
  readonly forget: readonly string[];
  /** Also remove the files of jobs older than JOB_DAYS, as bb-box does once per box after it starts. */
  readonly prune: boolean;
}

/** Where box_run's commands keep their output and exit status, relative to the box user's home (#405). */
export const JOBS_DIR = ".local/state/bb-box/jobs";
/** Days a job's files stay when bb-box does not remove them. */
export const JOB_DAYS = 7;
/** A job's ID, as newJobId makes it. */
export const JOB_ID = /^[0-9a-f]{12}$/;

export function newJobId(): string {
  return randomBytes(6).toString("hex");
}

function jobDir(id: string): string {
  if (!JOB_ID.test(id)) throw new Error(`"${id}" is not a job ID.`);
  return `"$HOME/${JOBS_DIR}/${id}"`;
}

/**
 * Runs `run` with its output and exit status in files in the job's
 * directory, then passes them on. The files stay, for jobScript, until
 * bb-box's next command in the box removes them: a write to a connection
 * bb-box has dropped can still succeed, as `docker exec` takes it, so the
 * job cannot tell whether bb-box got its result. Where the files cannot be
 * made, it runs `run` as it is; when the status cannot be written, as on a
 * full disk, it says the output may be cut short.
 */
function inJob(job: JobOptions, run: string): string {
  const jobs = `"$HOME/${JOBS_DIR}"`;
  const file = (name: string) => `"$bb_job/${name}"`;
  const forget = job.forget.map(jobDir).join(" ");
  return (
    `bb_run() {\n${run}\n}\n` +
    `bb_job=${jobDir(job.id)}; ` +
    `if [ -n "\${HOME:-}" ] && mkdir -p "$bb_job" 2>/dev/null && : >${file("out")} 2>/dev/null; then ` +
    (forget ? `rm -rf ${forget}; ` : "") +
    (job.prune ? `find ${jobs} -mindepth 1 -maxdepth 1 -mtime +${JOB_DAYS} -exec rm -rf {} + 2>/dev/null; ` : "") +
    `(bb_run) >${file("out")} 2>${file("err")}; bb_status=$?; ` +
    `echo "$bb_status" >${file("status")} 2>/dev/null || bb_full=1; ` +
    `[ ! -s ${file("out")} ] || cat ${file("out")}; [ ! -s ${file("err")} ] || cat ${file("err")} >&2; ` +
    `if [ -n "\${bb_full:-}" ]; then rm -rf "$bb_job"; echo "bb-box: the box's disk may be full: the command's output may be cut short." >&2; fi; ` +
    `exit "$bb_status"; fi; bb_run`
  );
}

/** A job's directory in a Windows box, as PowerShell names it. */
function windowsJobDir(id: string): string {
  if (!JOB_ID.test(id)) throw new Error(`"${id}" is not a job ID.`);
  return `(Join-Path $HOME '.local\\state\\bb-box\\jobs\\${id}')`;
}

/**
 * Copies a job's file, or its last `tail` bytes, to a stream; the command
 * that writes it may still hold it open.
 */
const WINDOWS_EMIT =
  "function bbEmit($s,$p,$n){if(Test-Path -LiteralPath $p){$f=[IO.File]::Open($p,'Open','Read','ReadWrite');try{if($n -and $f.Length -gt $n){$null=$f.Seek(-$n,'End')};$f.CopyTo($s);$s.Flush()}finally{$f.Close()}}};";

/**
 * A job in a Windows box (#414). sshd ends every process of a command when
 * the command's PowerShell exits, so a command that is to outlive bb-box's
 * connection must start outside it. The script goes in a file in the job's
 * directory and stdin in another, and WMI starts cmd, which runs the script
 * in a PowerShell with the job's files as its stdin, output and error, then
 * writes its exit code to the status file. The command waits on cmd's
 * process, passes the files on, and exits with the status. A watchdog, a
 * second PowerShell that WMI starts beside it and that holds cmd's handle,
 * stops cmd and all it started at the timeout and writes status 1, as the
 * watchdog of a command in the session gives; it ends with the job, or when
 * the job ends first. If bb-box drops the connection, the job and the
 * watchdog go on, and jobScript reads the files. A process WMI starts has
 * the user's environment, not the session's, so the script reads the env
 * file itself. One PowerShell start, about 155 ms, is the job's cost over a
 * command in the session (measured on 7 October 2026).
 */
function windowsJob(job: JobOptions, script: string, timeoutMs: number | undefined): string {
  const file = Buffer.from(powershellCommand(script), "utf8").toString("base64");
  const jobs = "(Join-Path $HOME '.local\\state\\bb-box\\jobs')";
  // A path in the job's directory, in double quotes, for cmd's command line.
  const at = (name: string) => `$q+(Join-Path $bbJob '${name}')+$q`;
  const run =
    `$bbCl='cmd /d /v:on /s /c '+$q+$q+[Environment]::ProcessPath+$q+' -NoProfile -NonInteractive -ExecutionPolicy Bypass -File '+${at("script.ps1")}+` +
    `' <'+${at("in")}+' >'+${at("out")}+' 2>'+${at("err")}+` +
    `' & echo !errorlevel!>'+${at("status.tmp")}+' & move /y '+${at("status.tmp")}+' '+${at("status")}+' >nul'+$q;`;
  const start = (command: string, what: string) =>
    `$bbR=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=${command};CurrentDirectory=(Get-Location -PSProvider FileSystem).ProviderPath};` +
    `if($bbR.ReturnValue -ne 0 -or -not $bbR.ProcessId){[Console]::Error.WriteLine('bb-box: Windows did not start the ${what}: Win32_Process Create returned '+$bbR.ReturnValue+'.');exit 1};`;
  // The watchdog's own script: stop the job at its timeout, unless it ended first, and say it timed out.
  const dog =
    timeoutMs === undefined
      ? ""
      : `$d=$env:BB_BOX_JOB;$p=Get-Process -Id $env:BB_BOX_JOB_PID -ErrorAction Ignore;if($p.ProcessName -ne 'cmd'){$p=$null};` +
        `if($p -and -not $p.WaitForExit(${Math.ceil(timeoutMs)})){taskkill /T /F /PID $p.Id *>$null;$p.WaitForExit();` +
        `[IO.File]::WriteAllText((Join-Path $d 'status.tmp'),'1');Move-Item -Force -LiteralPath (Join-Path $d 'status.tmp') -Destination (Join-Path $d 'status')}`;
  // The watchdog's command line carries the job's directory and cmd's process ID itself, as a WMI start carries no variables.
  const dogLine =
    timeoutMs === undefined
      ? ""
      : `$bbDogScript='$env:BB_BOX_JOB='+[char]39+$bbJob.Replace([string][char]39,[string][char]39*2)+[char]39+';$env:BB_BOX_JOB_PID='+$bbCmd+';'+${ps(dog)};` +
        `$bbDogLine=$q+[Environment]::ProcessPath+$q+' -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($bbDogScript));` +
        start("$bbDogLine", "watchdog for the job");
  return (
    `$bbJob=${windowsJobDir(job.id)};$q=[char]34;` +
    job.forget.map((id) => `Remove-Item -Recurse -Force -LiteralPath ${windowsJobDir(id)} -ErrorAction Ignore;`).join("") +
    (job.prune ? `Get-ChildItem -Directory -LiteralPath ${jobs} -ErrorAction Ignore|Where-Object LastWriteTime -lt (Get-Date).AddDays(-${JOB_DAYS})|Remove-Item -Recurse -Force -ErrorAction Ignore;` : "") +
    "New-Item -ItemType Directory -Force -Path $bbJob|Out-Null;" +
    `[IO.File]::WriteAllBytes((Join-Path $bbJob 'script.ps1'),[Convert]::FromBase64String('${file}'));` +
    "$f=[IO.File]::Create((Join-Path $bbJob 'in'));try{[Console]::OpenStandardInput().CopyTo($f)}finally{$f.Close()};" +
    run +
    start("$bbCl", "job") +
    "$bbCmd=$bbR.ProcessId;" +
    dogLine +
    // Waits on cmd's handle, not by polling; a cmd that ended already has written the status.
    "try{(Get-Process -Id $bbCmd -ErrorAction Stop).WaitForExit()}catch{};" +
    "$bbStatus=Join-Path $bbJob 'status';" +
    // The watchdog writes the status of a job it stopped a moment after cmd ends.
    "for($i=0;-not (Test-Path -LiteralPath $bbStatus) -and $i -lt 50;$i++){Start-Sleep -Milliseconds 100};" +
    "if(-not (Test-Path -LiteralPath $bbStatus)){[Console]::Error.WriteLine('bb-box: the job ended without an exit status: the box'+[char]39+'s disk may be full.');exit 1};" +
    WINDOWS_EMIT +
    "bbEmit ([Console]::OpenStandardOutput()) (Join-Path $bbJob 'out') 0;bbEmit ([Console]::OpenStandardError()) (Join-Path $bbJob 'err') 0;" +
    "exit [int](Get-Content -Raw -LiteralPath $bbStatus)"
  );
}

/**
 * Reads a job in a Linux or macOS box. Exits 0 once the job has ended, with
 * its exit status on stdout's first line, then its stdout, and its stderr;
 * 4 while it runs, with the last `tailBytes` of each stream so far; 3 when
 * there is no such job (#405).
 */
export function jobScript(id: string, tailBytes: number, os: GuestOs = "linux"): string {
  if (os === "windows") {
    const tail = Math.floor(tailBytes);
    return (
      `$d=${windowsJobDir(id)};if(-not (Test-Path -LiteralPath $d)){exit 3};` +
      WINDOWS_EMIT +
      "$o=[Console]::OpenStandardOutput();$e=[Console]::OpenStandardError();$s=Join-Path $d 'status';" +
      "if(Test-Path -LiteralPath $s){$b=[Text.Encoding]::UTF8.GetBytes((Get-Content -Raw -LiteralPath $s).Trim()+[char]10);$o.Write($b,0,$b.Length);" +
      "bbEmit $o (Join-Path $d 'out') 0;bbEmit $e (Join-Path $d 'err') 0;exit 0};" +
      `bbEmit $o (Join-Path $d 'out') ${tail};bbEmit $e (Join-Path $d 'err') ${tail};exit 4`
    );
  }
  return (
    `bb_job=${jobDir(id)}; [ -d "$bb_job" ] || exit 3; ` +
    `if [ -s "$bb_job/status" ]; then { cat "$bb_job/status" "$bb_job/out" && cat "$bb_job/err" >&2; } || exit 5; exit 0; fi; ` +
    `tail -c ${Math.floor(tailBytes)} "$bb_job/out"; tail -c ${Math.floor(tailBytes)} "$bb_job/err" >&2; exit 4`
  );
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

/**
 * Runs `script` under MAC_TIMEOUT, or as it is on a Mac without Perl, in a
 * shell that has the env file's variables already.
 */
function macTimeout(script: string, timeoutMs: number): string {
  const shell = `"\${SHELL:-/bin/sh}" -c ${sh(LOADS_ENV + script)}`;
  return `if [ -x /usr/bin/perl ]; then exec /usr/bin/perl -e ${sh(MAC_TIMEOUT)} ${Math.ceil(timeoutMs / 1000)} ${shell}; else exec ${shell}; fi`;
}

/**
 * Wraps `script` so it runs with the thread's environment, in `cwd` when
 * given. The whole script runs in `cwd`, or none of it does. On Linux and
 * macOS, each shell it starts begins with LOADS_ENV, so the box's shell
 * startup file leaves loading the env file to it: once per command.
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
    // A job's runner keeps the timeout itself, as it outlives this command (#414).
    if (options.job) return `${file}${write}${windowsJob(options.job, `${file}${env}${cd}${script}`, options.timeoutMs)}`;
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
    const timed = options.timeoutMs === undefined ? script : macTimeout(script, options.timeoutMs);
    const run = options.job ? inJob(options.job, timed) : timed;
    return LOADS_ENV + (options.session === "desktop" ? `${write}${macDesktop(`${env}${cd}${run}`)}` : `${write}${env}${cd}${run}`);
  }
  const desktop = options.session === "desktop" ? LINUX_DESKTOP : "";
  const job = (run: string) => (options.job ? inJob(options.job, run) : run);
  if (options.timeoutMs === undefined) return `${LOADS_ENV}${write}${env}${desktop}${cd}${job(script)}`;
  // Killing the local ssh leaves the command running in the box. GNU timeout
  // gives the script its own process group and stops all of it.
  const shell = `"\${SHELL:-/bin/sh}" -c ${sh(LOADS_ENV + script)}`;
  const timeout = `timeout -k 5 ${options.timeoutMs / 1000} ${shell}`;
  return `${LOADS_ENV}${write}${env}${desktop}${cd}${job(`if command -v timeout >/dev/null 2>&1; then exec ${timeout}; else exec ${shell}; fi`)}`;
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
 * its variables. Each is read as it is counted, so one that ends before then
 * is passed over, not left as the one with none. Values never reach the
 * disk. Needs GNU grep and sed.
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
        [ "$count" -gt "$most" ] || continue
        found=$(grep -zE ${pattern} "/proc/$pid/environ" 2>/dev/null |
          sed -z "s/'/'\\\\''/g; s/=/='/; s/^/export /; s/\$/'/" | tr '\0' '\n')
        if [ -n "$found" ]; then best=$found most=$count; fi
      done
      [ -n "$best" ] && printf '%s\n' "$best"
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
 * The file that sets `variables` for commands in the box, and takes the
 * thread's access. Names that are not valid shell names are left out. On Linux, package installs ask nothing, since nobody could
 * answer; a variable of the thread's own can say otherwise.
 */
export function envScript(os: GuestOs, variables: Readonly<Record<string, string>>, access?: Access): string {
  const names = Object.keys(variables)
    .filter((name) => NAME.test(name))
    .sort();
  if (os === "windows") {
    const own = names.map((name) => `$env:${name} = ${ps(variables[name]!)}`).join("\r\n") + "\r\n";
    return own + (access ? windowsAccessLoader(accessNames(access), access.parent) : "");
  }
  const header = "# Written by bb-box: the thread's environment for commands in this box.\n";
  const defaults = os === "linux" ? "export DEBIAN_FRONTEND=noninteractive\n" : "";
  const loader = !access ? "" : os === "macos" ? macAccessLoader(access) : accessLoader(access);
  return header + defaults + names.map((name) => `export ${name}=${sh(variables[name]!)}`).join("\n") + "\n" + loader;
}

/** Sources the env file, unless the shell's command loads it (#100). */
const HOOK_LINE =
  `case "\${BASH_EXECUTION_STRING-}\${ZSH_EXECUTION_STRING-}" in ${sh(LOADS_ENV)}*) ;; ` +
  `*) if [ -r "$HOME/${envFile("linux")}" ]; then . "$HOME/${envFile("linux")}"; fi ;; esac`;

/**
 * The lines an enrolled box's shell startup file starts with, above anything
 * that returns early.
 */
const SHELL_HOOK = `# Added by bb-box: the thread's environment and access, for SSH commands too.
${HOOK_LINE}
`;

/**
 * Prints the startup file without the hook before #100, which loaded the env
 * file in every shell: its two lines and the blank line after them.
 */
const DROP_OLD_HOOK =
  `awk -v a=${sh("# Added by bb-box: the thread's environment and access, for SSH commands too.")} ` +
  `-v b=${sh(`if [ -r "$HOME/${envFile("linux")}" ]; then . "$HOME/${envFile("linux")}"; fi`)} ` +
  `'$0 == a { next } $0 == b { gap = 1; next } gap && $0 == "" { gap = 0; next } { gap = 0; print }'`;

/**
 * Run once a Linux or macOS box is a BB machine, after the env file is
 * written: the shell's startup file sources the env file first, in place of
 * an older hook, git asks gh for GitHub credentials, so both use GH_TOKEN,
 * and git fetches GitHub's SSH URLs over HTTPS, as on the thread's machine.
 * Each rewrite replaces only its own entry: an empty one would match every
 * URL. That file is ~/.bashrc, or ~/.zshenv on macOS, since an SSH command
 * there runs a zsh that is not a login shell, which reads only ~/.zshenv.
 * Prints how long it took in the box, in milliseconds, for the enrolment's
 * log, when the box's date can tell. A Windows box gets git's part (#560).
 */
export function accessSetup(os: GuestOs): string {
  if (os === "windows") return WINDOWS_ACCESS_SETUP;
  // cp -p gives the new file the old one's mode, which writing it keeps.
  return String.raw`started=$(date +%s%N)
f="$HOME/${os === "macos" ? ".zshenv" : ".bashrc"}"
if ! grep -qsxF ${sh(HOOK_LINE)} "$f"; then
  { [ ! -e "$f" ] || cp -p "$f" "$f.bb-box"; } &&
    { printf '%s\n' ${sh(SHELL_HOOK)} && { [ ! -e "$f" ] || ${DROP_OLD_HOOK} "$f"; }; } > "$f.bb-box" && mv -f "$f.bb-box" "$f"
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
 * the env file set every required name, or any name when none is required,
 * 1 while the daemon runs without them, and 2 when nothing runs the
 * daemon's program, so there is nothing to wait for. Null when there are
 * no names.
 */
export function accessCheck(os: GuestOs, access: Access): string | null {
  const names = accessNames(access);
  if (!names.length) return null;
  const required = (access.required ?? []).filter((name) => names.includes(name));
  if (os === "windows") return windowsAccessCheck(names, required, access.parent, ACCESS_CHECK_EXITS);
  const set = required.length
    ? required.map((name) => `[ -n "\${${name}:-}" ]`).join(" && ")
    : names.map((name) => `[ -n "\${${name}:-}" ]`).join(" || ");
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
 * desktop session; the proxy needs nothing from that session. A leading `~/`
 * is the home of the user the command runs as, which on a lent Mac is a new
 * user for each box (047).
 */
export function driverCommand(os: GuestOs, socket: string): string {
  const home = socket.startsWith("~/") ? socket.slice(2) : null;
  return os === "windows"
    ? `& cua-driver mcp --socket ${home === null ? ps(socket) : `(Join-Path $HOME ${ps(home)})`}`
    : `exec cua-driver mcp --socket ${home === null ? sh(socket) : `"$HOME"/${sh(home)}`}`;
}
