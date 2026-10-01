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
// environment variables and directory, and returns its process ID.
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
 * the command with all its output going to the log, or nowhere.
 */
const DETACHED =
  SETTINGS +
  "$a=Import-Clixml -LiteralPath $f;Remove-Item -LiteralPath $f;" +
  "foreach($k in $a.e.Keys){[Environment]::SetEnvironmentVariable($k,$a.e[$k])};" +
  "$s=[scriptblock]::Create($a.c);if($a.o){& $s *> $a.o}else{& $s *> $null}";

/**
 * Start-Detached { <command> } <log>. The command, the log's full path and
 * the environment go in a file in the temp directory, and WMI starts the new
 * PowerShell in the script's directory. $q is a double quote, which the
 * command line cannot carry.
 */
const DETACH =
  "function Start-Detached{param([Parameter(Mandatory)][string]$Command,[string]$Log);" +
  "$f=Join-Path ([IO.Path]::GetTempPath()) ('bb-box-'+[guid]::NewGuid().ToString('n')+'.xml');" +
  "$o=if($Log){$ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($Log)};" +
  "$e=@{};foreach($v in Get-ChildItem env:){$e[$v.Name]=$v.Value};" +
  "@{e=$e;c=$Command;o=$o}|Export-Clixml -LiteralPath $f;" +
  `$b='$f='''+($f -replace '''','''''')+''';${DETACHED.replaceAll("'", "''")}';` +
  "$q=[char]34;$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{" +
  "CommandLine=$q+[Environment]::ProcessPath+$q+' -NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($b));" +
  "CurrentDirectory=(Get-Location -PSProvider FileSystem).ProviderPath};" +
  "if($r.ReturnValue){Remove-Item -LiteralPath $f;throw ('Cannot start the command: Win32_Process Create returned '+$r.ReturnValue)};" +
  "$r.ProcessId};";

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
