// Windows boxes as BB machines, unless the Proxmox QEMU or Tart backend's
// switch is set off (#539). BB's bootstrap runs its POSIX installer,
// install.sh, whatever the machine's OS, and install.sh runs only on macOS
// and Linux. A provider's machine gets no Windows enrolment command,
// and install.ps1 serves only manual enrolments. So bb-box makes a Windows
// box's machine with BB's manual provider, and runs that machine's enrolment
// command in its Windows form, `windowsCommand`, which fetches install.ps1
// with the machine's credential (enrol.ts). It runs in the box user's desktop
// session, where BB's daemon has to run, not in SSH's session 0. The command
// holds the credential, so it goes as the script's stdin, not in its text. A
// reconnect runs BB's reconnect command the same way.
//
// Node.js 22.19 or newer, which BB's Windows installer needs, is installed
// first when missing: a pinned portable build, checked by its SHA-256, in the
// box user's local app data and on that user's PATH. Images will have Node
// (#450), and then this finds it and does nothing.

import { command as inBoxCommand } from "../core/in-box.ts";
import type { CommandTransport, RunResult } from "../transports/types.ts";

/** The Node.js build installed where a box lacks one, as Linux images have it. */
const NODE_VERSION = "24.21.0";
/** From nodejs.org's SHASUMS256.txt for the version. */
const NODE_SHA256 = {
  x64: "158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541",
  arm64: "8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921",
} as const;

/** Installs the pinned Node.js in the box user's local app data and puts it on the user's PATH, unless Node.js 22.19 or newer is there. */
const NODE_STEP = String.raw`$bbNode = Get-Command node -ErrorAction SilentlyContinue
$bbHave = $null
if ($bbNode) { try { $bbHave = [Version]((& $bbNode.Source --version).TrimStart('v')) } catch {} }
if (-not $bbHave -or $bbHave -lt [Version]'22.19.0') {
  $bbArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $bbSha = @{ x64 = '${NODE_SHA256.x64}'; arm64 = '${NODE_SHA256.arm64}' }[$bbArch]
  $bbName = "node-v${NODE_VERSION}-win-$bbArch"
  $bbRoot = Join-Path $env:LOCALAPPDATA 'bb-box'
  $bbDir = Join-Path $bbRoot $bbName
  if (-not (Test-Path -LiteralPath (Join-Path $bbDir 'node.exe'))) {
    New-Item -ItemType Directory -Force -Path $bbRoot | Out-Null
    $bbZip = Join-Path ([IO.Path]::GetTempPath()) "$bbName.zip"
    Invoke-WebRequest -UseBasicParsing -Uri "https://nodejs.org/dist/v${NODE_VERSION}/$bbName.zip" -OutFile $bbZip
    if ((Get-FileHash -Algorithm SHA256 -LiteralPath $bbZip).Hash -ne $bbSha) {
      Remove-Item -LiteralPath $bbZip -Force
      throw "Node.js $bbName.zip from nodejs.org did not match its SHA-256."
    }
    Expand-Archive -LiteralPath $bbZip -DestinationPath $bbRoot -Force
    Remove-Item -LiteralPath $bbZip -Force
  }
  $bbPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  if (-not (($bbPath -split ';') -contains $bbDir)) {
    [Environment]::SetEnvironmentVariable('Path', (@($bbDir) + @($bbPath -split ';' | Where-Object { $_ })) -join ';', 'User')
  }
  $env:Path = "$bbDir;$env:Path"
}
`;

/**
 * Makes sure of Node.js, then runs the PowerShell command on stdin, BB's
 * `windowsCommand`: exits with its code, or 1 with the reason on stderr.
 */
export const WINDOWS_COMMAND_SCRIPT = `try {
$ErrorActionPreference = 'Stop'
${NODE_STEP}$bbCommand = [Console]::In.ReadToEnd()
$global:LASTEXITCODE = 0
Invoke-Expression $bbCommand
exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine('bb-box: ' + $_.Exception.Message)
  exit 1
}`;

/** Runs BB's `windowsCommand` in the box user's desktop session (WINDOWS_COMMAND_SCRIPT). */
export function runWindowsCommand(transport: CommandTransport, windowsCommand: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<RunResult> {
  return transport.run(inBoxCommand("windows", WINDOWS_COMMAND_SCRIPT, { session: "desktop", timeoutMs: options.timeoutMs }), {
    stdin: windowsCommand,
    timeoutMs: options.timeoutMs + 30_000,
    signal: options.signal,
  });
}

/** Why a run of BB's `windowsCommand` failed, from its last lines. */
export function windowsFailure(what: string, result: RunResult): string {
  const tail = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-8).join("\n");
  return `${what} exited with ${result.exitCode ?? (result.timedOut ? "a timeout" : "no code")}${tail ? `:\n${tail}` : "."}`;
}

/**
 * Reads a process's working directory from its PEB: the process parameters'
 * CurrentDirectory, at the offsets of 64-bit Windows, x64 and arm64 alike.
 * Null where the process cannot be opened or read.
 */
const DIRECTORY_READER = String.raw`using System;
using System.Runtime.InteropServices;
using System.Text;

public static class BbProcessDirectory {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr Parent; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref Basic info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);

  static byte[] Read(IntPtr handle, IntPtr address, int size) {
    var buffer = new byte[size];
    IntPtr read;
    return ReadProcessMemory(handle, address, buffer, (IntPtr)size, out read) && (long)read == size ? buffer : null;
  }

  public static string Of(int pid) {
    // PROCESS_QUERY_INFORMATION | PROCESS_VM_READ
    IntPtr handle = OpenProcess(0x0410, false, pid);
    if (handle == IntPtr.Zero) return null;
    try {
      var basic = new Basic();
      int returned;
      if (NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0 || basic.Peb == IntPtr.Zero) return null;
      byte[] parameters = Read(handle, basic.Peb + 0x20, 8);
      if (parameters == null) return null;
      IntPtr at = (IntPtr)BitConverter.ToInt64(parameters, 0);
      // CurrentDirectory.DosPath: a UNICODE_STRING, its length then its buffer.
      byte[] length = Read(handle, at + 0x38, 2);
      byte[] buffer = Read(handle, at + 0x40, 8);
      if (length == null || buffer == null) return null;
      int size = BitConverter.ToUInt16(length, 0);
      if (size == 0) return null;
      byte[] text = Read(handle, (IntPtr)BitConverter.ToInt64(buffer, 0), size);
      return text == null ? null : Encoding.Unicode.GetString(text);
    } finally {
      CloseHandle(handle);
    }
  }
}`;

/**
 * Ends the processes BB's daemon runs for threads in the box: each whose
 * working directory is in BB's worktrees, such as a thread's agent and the
 * worker that runs it, and what they started. Windows does not remove a
 * folder a process works in, so BB's teardown of a thread's worktree fails
 * with EBUSY while they run, and the box's machine stays "removing" (#539).
 * BB's daemon and its other workers work elsewhere, and go on. Prints
 * `ended=<count>`.
 */
export const END_THREADS_SCRIPT = `$ErrorActionPreference = 'Stop'
$bbRoots = @(Get-ChildItem -Directory -Path (Join-Path $HOME '.bb-machines\\*\\plugins\\environment-git-worktree\\host-data\\worktrees') -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName.TrimEnd('\\') })
if (-not $bbRoots.Count) { 'ended=0'; exit 0 }
Add-Type -TypeDefinition @'
${DIRECTORY_READER}
'@
$bbAll = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId, CommandLine)
$bbEnd = @{}
foreach ($bbProcess in $bbAll) {
  $bbDir = [BbProcessDirectory]::Of([int]$bbProcess.ProcessId)
  if (-not $bbDir) { continue }
  $bbDir = $bbDir.TrimEnd('\\')
  foreach ($bbRoot in $bbRoots) {
    if ($bbDir.StartsWith($bbRoot + '\\', [StringComparison]::OrdinalIgnoreCase)) { $bbEnd[[int]$bbProcess.ProcessId] = $true }
  }
}
# And what they started.
do {
  $bbMore = $false
  foreach ($bbProcess in $bbAll) {
    if (-not $bbEnd.ContainsKey([int]$bbProcess.ProcessId) -and $bbEnd.ContainsKey([int]$bbProcess.ParentProcessId)) { $bbEnd[[int]$bbProcess.ProcessId] = $true; $bbMore = $true }
  }
} while ($bbMore)
$bbEnded = 0
foreach ($bbProcess in $bbAll) {
  $bbId = [int]$bbProcess.ProcessId
  # Never BB's daemon, nor this command.
  if (-not $bbEnd.ContainsKey($bbId) -or $bbId -eq $PID -or "$($bbProcess.CommandLine)" -match 'bb-app\\.js"?\\s+host-daemon') { continue }
  try { Stop-Process -Id $bbId -Force -ErrorAction Stop; $bbEnded++ } catch {}
}
"ended=$bbEnded"`;

/** Ends the threads' processes in a Windows box (END_THREADS_SCRIPT), and says how many. */
export async function endThreadProcesses(transport: CommandTransport, options: { timeoutMs: number; signal?: AbortSignal }): Promise<number> {
  const result = await transport.run(inBoxCommand("windows", END_THREADS_SCRIPT, { timeoutMs: options.timeoutMs }), { timeoutMs: options.timeoutMs + 10_000, signal: options.signal });
  if (result.exitCode !== 0) throw new Error(windowsFailure("Ending the threads' processes in the box", result));
  return Number(/ended=(\d+)/.exec(result.stdout)?.[1] ?? 0);
}
