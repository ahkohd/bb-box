// Scripts for a Windows box over SSH, whose default shell is PowerShell. The
// script goes base64-encoded into a script block, so none of its quotes reach
// the command line, and the command exits as a POSIX shell would: with the
// script's own exit, else the last native command's code when the last
// statement failed, else 1 when it failed, else 0. Progress bars and coloured
// errors are off, and PowerShell's own output is UTF-8.
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
const PRELUDE =
  "$ProgressPreference='SilentlyContinue';" +
  "if($PSStyle){$PSStyle.Formatting.Error='';$PSStyle.Formatting.ErrorAccent=''};" +
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);" +
  "$global:LASTEXITCODE=0;";

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
