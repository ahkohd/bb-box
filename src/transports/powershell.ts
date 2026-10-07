// Scripts for a Windows box over SSH, whose default shell is PowerShell. The
// script goes base64-encoded into a script block, so none of its quotes reach
// the command line, and the command exits as a POSIX shell would: with the
// script's own exit, else the last native command's code when the last
// statement failed, else 1 when it failed, else 0. Progress bars and colours
// are off, and PowerShell's own output is UTF-8.
//
// sshd runs each command in a job that ends all its processes when the
// command exits, so what a script starts with Start-Process, Start-Job or
// `cmd /c start` ends with it. Start-Detached, Windows' nohup, starts a
// command through WMI instead, outside the job, with the script's
// environment variables and directory, and returns its process ID. Its
// output goes to a log file that is the standard output and error of all it
// runs, so a GUI program's output reaches it too (#483).
//
// Stdin is the process's, untouched: native commands and
// [Console]::OpenStandardInput() read it byte for byte, and
// [Console]::In.ReadToEnd() as text. $input is empty.
//
// Windows caps a command line at 32,767 characters. A script whose command
// would not fit goes to a file in the box user's temp directory first, which
// the next command reads, deletes and runs.

import { randomBytes } from "node:crypto";

/** The longest command sent on the command line, leaving room for sshd's shell and its arguments. */
export const COMMAND_LIMIT = 32_000;

/** $PSStyle is PowerShell 7's; Windows PowerShell has none and no colours. */
const SETTINGS =
  "$ProgressPreference='SilentlyContinue';" +
  "if($PSStyle){$PSStyle.OutputRendering='PlainText'};" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);";

/**
 * What a detached command's PowerShell runs once $f names its file: it reads
 * and deletes the file, takes on the environment variables in it, and runs
 * the command. Its output goes where the PowerShell's own does: the log.
 */
const DETACHED =
  SETTINGS +
  "$a=Import-Clixml -LiteralPath $f;Remove-Item -LiteralPath $f;" +
  "foreach($k in $a.e.Keys){[Environment]::SetEnvironmentVariable($k,$a.e[$k])};" +
  "& ([scriptblock]::Create($a.c))";

/**
 * Start-Detached { <command> } <log>. The command and the environment go in a
 * file in the temp directory, and WMI starts the new PowerShell in the
 * script's directory, through cmd, whose `> log 2>&1` makes the log, or NUL,
 * its standard output and error (#483). What the command runs inherits that
 * file, not a pipe: PowerShell does not wait for a GUI program, such as an
 * Electron app, and a pipe would close under it with its output lost. It
 * returns the PowerShell's process ID, not cmd's. $q is a double quote,
 * which the command line cannot carry.
 */
const DETACH =
  "function Start-Detached{param([Parameter(Mandatory)][string]$Command,[string]$Log);" +
  "$f=Join-Path ([IO.Path]::GetTempPath()) ('bb-box-'+[guid]::NewGuid().ToString('n')+'.xml');" +
  "$o=if($Log){$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)}else{'NUL'};" +
  "$e=@{};foreach($v in Get-ChildItem env:){$e[$v.Name]=$v.Value};" +
  "@{e=$e;c=$Command}|Export-Clixml -LiteralPath $f;" +
  `$b='$f='''+($f -replace '''','''''')+''';${DETACHED.replaceAll("'", "''")}';` +
  "$q=[char]34;$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{" +
  "CommandLine=$q+$env:ComSpec+$q+' /d /s /c '+$q+$q+[Environment]::ProcessPath+$q+' -NoProfile -NonInteractive -OutputFormat Text -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($b))+' >'+$q+$o+$q+' 2>&1'+$q;" +
  "CurrentDirectory=(Get-Location -PSProvider FileSystem).ProviderPath};" +
  "if($r.ReturnValue){Remove-Item -LiteralPath $f;throw ('Cannot start the command: Win32_Process Create returned '+$r.ReturnValue)};" +
  "$n=[IO.Path]::GetFileName([Environment]::ProcessPath);$p=$null;" +
  "for($i=0;-not $p -and $i -lt 50;$i++){$p=(Get-CimInstance Win32_Process -Filter ('ParentProcessId='+$r.ProcessId+' and Name='+[char]39+$n+[char]39)).ProcessId|Select-Object -First 1;if(-not $p){Start-Sleep -Milliseconds 100}};" +
  "if($p){$p}else{$r.ProcessId}};";

const PRELUDE = `${SETTINGS}${DETACH}$global:LASTEXITCODE=0;`;

/** Runs in the script's own scope after its last statement, where $? is that statement's. */
const TRAILER = "if(-not $?){if($LASTEXITCODE){exit $LASTEXITCODE};exit 1}";

function block(source: string): string {
  return `${PRELUDE}& ([scriptblock]::Create(${source}));exit 0`;
}

/** The script with what reads its exit, as the box runs it. */
export function scriptText(script: string): string {
  return `${script}\n${TRAILER}`;
}

/** The command that runs `script`, which may be longer than COMMAND_LIMIT. */
export function powershellCommand(script: string): string {
  const encoded = Buffer.from(scriptText(script), "utf8").toString("base64");
  return block(`[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}'))`);
}

/** A name for a staged script, in the box user's temp directory. */
export function stagedName(): string {
  return `bb-box-${randomBytes(8).toString("hex")}.ps1`;
}

function stagedPath(name: string): string {
  return `$p=Join-Path ([IO.Path]::GetTempPath()) '${name}';`;
}

/** Writes stdin, the bytes of scriptText, to the staged script `name`. */
export function stageCommand(name: string): string {
  return `${stagedPath(name)}$f=[IO.File]::Create($p);try{[Console]::OpenStandardInput().CopyTo($f)}finally{$f.Close()}`;
}

/** Reads the staged script `name`, deletes it and runs it. */
export function stagedCommand(name: string): string {
  return `${stagedPath(name)}$s=[IO.File]::ReadAllText($p,[Text.Encoding]::UTF8);Remove-Item -LiteralPath $p;${block("$s")}`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Runs `body` once $p is `path` as PowerShell resolves it: a relative path,
 * or one starting with ~, is under the box user's home, where sshd starts
 * the shell. A failure exits 1 with the reason, not PowerShell's wrapper.
 */
function onFile(path: string, body: string): string {
  return (
    `try{$p=$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(${literal(path)});` +
    `if([IO.Directory]::Exists($p)){throw ($p+' is a directory.')};${body}}` +
    "catch{$e=$_.Exception;if($e.InnerException){$e=$e.InnerException};[Console]::Error.WriteLine($e.Message);exit 1}"
  );
}

/** Writes stdin, byte for byte, to `path`, creating parent directories. */
export function writeFileScript(path: string): string {
  return onFile(
    path,
    "$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p));" +
      "$f=[IO.File]::Create($p);try{[Console]::OpenStandardInput().CopyTo($f)}finally{$f.Close()}",
  );
}

/** Prints the file's SHA-256 in lower-case hex and its size in bytes, as "<sha256> <bytes>" (#492). */
const PRINT_HASH = "[Console]::Out.Write((Get-FileHash -Algorithm SHA256 -LiteralPath $t).Hash.ToLower()+' '+(Get-Item -LiteralPath $t).Length)";

/** Prints `path`'s SHA-256 and size (#492). */
export function hashFileScript(path: string): string {
  return onFile(path, `if(-not [IO.File]::Exists($p)){throw ($p+' is not a file.')};$t=$p;${PRINT_HASH}`);
}

/** Writes stdin to `path`'s part file, creating parent directories, and prints the part's SHA-256 and size (#492). */
export function writePartScript(path: string): string {
  return onFile(
    path,
    "$t=$p+'.bb-box-part';$null=[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($p));" +
      `$f=[IO.File]::Create($t);try{[Console]::OpenStandardInput().CopyTo($f)}finally{$f.Close()};${PRINT_HASH}`,
  );
}

/** Puts `path`'s part file in its place, over any file there, or removes it when not `keep` (#492). */
export function settlePartScript(path: string, keep: boolean): string {
  return onFile(path, keep ? "[IO.File]::Move($p+'.bb-box-part',$p,$true)" : "[IO.File]::Delete($p+'.bb-box-part')");
}

/** Writes `path` to stdout, byte for byte. A file another process is writing can be read too. */
export function readFileScript(path: string): string {
  return onFile(
    path,
    "$f=[IO.FileStream]::new($p,'Open','Read','ReadWrite, Delete');" +
      "try{$o=[Console]::OpenStandardOutput();$f.CopyTo($o);$o.Flush()}finally{$f.Close()}",
  );
}

/**
 * What a desktop command exits with when the box user is not logged in to
 * the desktop, and on a Mac when sudo does not allow the wrapper: sysexits'
 * EX_UNAVAILABLE and EX_NOPERM.
 */
export const DESKTOP_EXITS = { noSession: 69, refused: 77 } as const;

/**
 * Puts a script in the box user's desktop session (039), for core's desktop
 * commands and a backend's own: a one-off scheduled task with the user's
 * interactive logon, made through Task Scheduler's COM API, which needs no
 * module loaded. The task runs at the
 * limited run level, as an app the user opens does. It runs a batch file in
 * a headless console, so no window shows, and the batch file runs the
 * command's PowerShell with its stdin, stdout and stderr in files, then
 * writes its exit status to another. This waits for that file, passes the
 * output on and deletes the task. What the command opened stays open, but at
 * `timeoutMs` the command and everything it started end. Task Scheduler
 * leaves the task of a user who is not logged on as it was, with the result
 * SCHED_S_TASK_HAS_NOT_RUN.
 */
export function desktopScript(script: string, timeoutMs: number | undefined): string {
  const timeout =
    timeoutMs === undefined
      ? ""
      : String.raw`  elseif ($bbClock.ElapsedMilliseconds -ge ${timeoutMs}) {
    $bbKill = @(Get-CimInstance Win32_Process -Filter "CommandLine LIKE '%$bbId%'" | ForEach-Object { '/PID'; $_.ProcessId })
    if ($bbKill) { taskkill /F /T @bbKill *> $null }
    $bbExit = 1
  }
`;
  return String.raw`$ErrorActionPreference = 'Stop'
$bbId = 'bb-box-' + [guid]::NewGuid().ToString('n')
$bbDir = Join-Path ([IO.Path]::GetTempPath()) $bbId
New-Item -ItemType Directory -Path $bbDir | Out-Null
$bbFile = [IO.File]::Create("$bbDir\in")
[Console]::OpenStandardInput().CopyTo($bbFile)
$bbFile.Close()
Set-Content -LiteralPath "$bbDir\run.ps1" -Value ${literal(powershellCommand(script))}
Set-Content -LiteralPath "$bbDir\run.cmd" -Value (
  '@"' + [Environment]::ProcessPath + '" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $bbDir + '\run.ps1" <"' + $bbDir + '\in" >"' + $bbDir + '\out" 2>"' + $bbDir + '\err"'),
  ('@>"' + $bbDir + '\code.tmp" echo %errorlevel%'),
  ('@move /y "' + $bbDir + '\code.tmp" "' + $bbDir + '\code" >nul')
$bbService = New-Object -ComObject Schedule.Service
$bbService.Connect()
$bbFolder = $bbService.GetFolder('\')
$bbTask = $bbService.NewTask(0)
$bbTask.Principal.UserId = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$bbTask.Principal.LogonType = 3
$bbTask.Settings.DisallowStartIfOnBatteries = $false
$bbTask.Settings.StopIfGoingOnBatteries = $false
$bbAction = $bbTask.Actions.Create(0)
$bbAction.Path = "$env:WINDIR\System32\conhost.exe"
$bbAction.Arguments = '--headless "' + $env:WINDIR + '\System32\cmd.exe" /d /c "' + $bbDir + '\run.cmd"'
$bbAction.WorkingDirectory = $HOME
$bbRegistered = $bbFolder.RegisterTaskDefinition($bbId, $bbTask, 6, $null, $null, 3)
$null = $bbRegistered.Run($null)
$bbClock = [Diagnostics.Stopwatch]::StartNew()
$bbExit = $null
while ($null -eq $bbExit) {
  if (Test-Path -LiteralPath "$bbDir\code") { $bbExit = [int](Get-Content -LiteralPath "$bbDir\code" -Raw).Trim() }
  elseif ($bbRegistered.State -ne 4 -and -not (Test-Path -LiteralPath "$bbDir\code")) {
    if ($bbRegistered.LastTaskResult -eq 0x41303) {
      [Console]::Error.WriteLine("bb-box: there is no desktop session to join: $([Environment]::UserName) is not logged in to the desktop.")
      $bbExit = ${DESKTOP_EXITS.noSession}
    } else {
      [Console]::Error.WriteLine('bb-box: the desktop command ended without an exit status. Task Scheduler gave {0:x}.' -f $bbRegistered.LastTaskResult)
      $bbExit = 1
    }
  }
${timeout}  else { Start-Sleep -Milliseconds 50 }
}
$bbFolder.DeleteTask($bbId, 0)
foreach ($bbOutput in ('out', [Console]::OpenStandardOutput()), ('err', [Console]::OpenStandardError())) {
  if (-not (Test-Path -LiteralPath "$bbDir\$($bbOutput[0])")) { continue }
  $bbFile = [IO.FileStream]::new("$bbDir\$($bbOutput[0])", 'Open', 'Read', 'ReadWrite, Delete')
  $bbFile.CopyTo($bbOutput[1])
  $bbOutput[1].Flush()
  $bbFile.Close()
}
Remove-Item -LiteralPath $bbDir -Recurse -Force -ErrorAction Ignore
exit $bbExit
`;
}
