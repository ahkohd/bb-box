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

/**
 * Whether BB's daemon in the box is on its way without bb-box (#917): its
 * supervisor or BB's installer runs, as when a resumed box's daemon
 * reconnects by itself, or BB's logon entry for machine `hostId` is about to
 * start it, as in the first 2 minutes after the box user's logon. BB's
 * reconnect command then would race it, and two supervisors could run.
 * Prints `running`, `logon` or `none`.
 */
export function daemonStartingScript(hostId: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(hostId)) throw new Error(`Not a BB machine ID: ${hostId}`);
  return `$ErrorActionPreference = 'Stop'
$bbOwn = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'powershell.exe'" | Where-Object { "$($_.CommandLine)" -match 'bb-app\\.js"?\\s+host-daemon|install-machine-windows\\.mjs' })
if ($bbOwn.Count) { 'running'; exit 0 }
$bbRun = Get-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue
$bbEntry = $bbRun -and @($bbRun.PSObject.Properties | Where-Object { $_.Name -like 'bb-host-daemon-*-${hostId}' }).Count
$bbShell = @(Get-CimInstance Win32_Process -Filter "Name = 'explorer.exe'" | Sort-Object CreationDate | Select-Object -First 1)
if ($bbEntry -and (-not $bbShell.Count -or ((Get-Date) - $bbShell[0].CreationDate).TotalSeconds -lt 120)) { 'logon'; exit 0 }
'none'`;
}

/** Whether BB's daemon in the box is on its way without bb-box (daemonStartingScript): why, or null. */
export async function daemonStarting(transport: CommandTransport, hostId: string, options: { timeoutMs: number; signal?: AbortSignal }): Promise<"running" | "logon" | null> {
  const result = await transport.run(inBoxCommand("windows", daemonStartingScript(hostId), { timeoutMs: options.timeoutMs }), { timeoutMs: options.timeoutMs + 10_000, signal: options.signal });
  if (result.exitCode !== 0) throw new Error(windowsFailure("Looking for BB's daemon in the box", result));
  const said = result.stdout.trim().split("\n").at(-1)?.trim();
  return said === "running" || said === "logon" ? said : null;
}

/**
 * Run in a child PowerShell, as attaching to another process's console
 * loses the output of the PowerShell that does: the windows of the consoles
 * of BB's processes in the desktop session, those whose command line is in
 * BB's data folder and what they start, hidden. In Windows Terminal, the
 * default console host on Windows 11, a console's window is a pseudo window
 * that Terminal only minimises, to the taskbar, so it hides Terminal's own
 * window. A window is minimised, then hidden: hidden alone, it kept the
 * keyboard. Writes `consoles=<n> hidden=<n>` to $env:BB_BOX_HIDE_RESULT.
 */
const HIDE_CONSOLES_CHILD = String.raw`$ProgressPreference = 'SilentlyContinue'
Add-Type -Namespace BbHide -Name W -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern bool AttachConsole(uint p);
[DllImport("kernel32.dll")] public static extern bool FreeConsole();
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr h, System.Text.StringBuilder s, int n);
'@
function Class($h) { $c = New-Object System.Text.StringBuilder 64; [void][BbHide.W]::GetClassName($h, $c, 64); "$c" }
$session = (Get-Process -Id $PID).SessionId
$all = @(Get-CimInstance Win32_Process)
$bb = @{}; foreach ($p in $all) { if ("$($p.CommandLine)" -match '\\\.bb-machines\\') { $bb[[int]$p.ProcessId] = $true } }
$ours = @($all | Where-Object { $_.SessionId -eq $session -and $_.ProcessId -ne $PID -and ($bb.ContainsKey([int]$_.ProcessId) -or $bb.ContainsKey([int]$_.ParentProcessId)) })
$windows = @{}
[void][BbHide.W]::FreeConsole()
foreach ($p in $ours) {
  if (-not [BbHide.W]::AttachConsole([uint32]$p.ProcessId)) { continue }
  $h = [BbHide.W]::GetConsoleWindow()
  [void][BbHide.W]::FreeConsole()
  if ($h -eq [IntPtr]::Zero) { continue }
  if ((Class $h) -eq 'PseudoConsoleWindow') { $o = [BbHide.W]::GetWindow($h, 4); if ($o -ne [IntPtr]::Zero -and (Class $o) -eq 'CASCADIA_HOSTING_WINDOW_CLASS') { $h = $o } else { continue } }
  $windows[$h] = $true
}
$hidden = 0
# Minimised first, which gives the keyboard to the next window: hidden alone, it kept it, so keys went to the console.
foreach ($h in $windows.Keys) {
  if ([BbHide.W]::IsWindowVisible($h) -or $h -eq [BbHide.W]::GetForegroundWindow()) { [void][BbHide.W]::ShowWindow($h, 6); [void][BbHide.W]::ShowWindow($h, 0); $hidden++ }
}
[IO.File]::WriteAllText($env:BB_BOX_HIDE_RESULT, "consoles=$($windows.Count) hidden=$hidden")`;

/**
 * Hides the windows of BB's daemon's consoles, which BB starts in front of
 * the desktop until it fixes bb-requests 27, where a person's first keys
 * went, and a Ctrl+C could stop the daemon. It waits up to 10 s for a
 * console to appear. Prints `consoles=<n> hidden=<n>`.
 */
export const HIDE_CONSOLES_SCRIPT = `$ErrorActionPreference = 'Stop'
$env:BB_BOX_HIDE_RESULT = [IO.Path]::GetTempFileName()
try {
  for ($bbTry = 0; $bbTry -lt 5; $bbTry++) {
    & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${Buffer.from(HIDE_CONSOLES_CHILD, "utf16le").toString("base64")} *> $null
    $bbSaid = Get-Content -Raw -LiteralPath $env:BB_BOX_HIDE_RESULT
    if ($bbSaid -notmatch '^consoles=0') { break }
    Start-Sleep -Seconds 2
  }
  $bbSaid
} finally { Remove-Item -LiteralPath $env:BB_BOX_HIDE_RESULT -ErrorAction SilentlyContinue }`;

/** Hides BB's daemon's console windows in the box's desktop session (HIDE_CONSOLES_SCRIPT): how many it found, and hid. */
export async function hideBbConsoles(transport: CommandTransport, options: { timeoutMs: number; signal?: AbortSignal }): Promise<{ consoles: number; hidden: number }> {
  const result = await transport.run(inBoxCommand("windows", HIDE_CONSOLES_SCRIPT, { session: "desktop", timeoutMs: options.timeoutMs }), { timeoutMs: options.timeoutMs + 30_000, signal: options.signal });
  if (result.exitCode !== 0) throw new Error(windowsFailure("Hiding BB's console windows", result));
  const said = /consoles=(\d+) hidden=(\d+)/.exec(result.stdout);
  return { consoles: Number(said?.[1] ?? 0), hidden: Number(said?.[2] ?? 0) };
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
