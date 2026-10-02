// The Windows guest, as the Proxmox QEMU backend runs it on x86_64 and the
// Tart backend will in QEMU on a Mac (039, 046): what bb-box runs in it over
// SSH, in PowerShell 7 as the box user, to extend C:, to set the desktop's
// mode and Windows' clock, and to see that the desktop is up.

import { createHash } from "node:crypto";
import { desktopScript } from "../transports/powershell.ts";
import type { CommandTransport, DisplaySize } from "../transports/types.ts";

/** The named pipe Cua's daemon listens on. A task at logon starts it, elevated, as SSH is (039). */
export const CUA_PIPE = "\\\\.\\pipe\\cua-driver";
/** How long setting the desktop's mode may take, in the desktop session. */
const RESIZE_TIMEOUT_MS = 15_000;
/** How long setting Windows' clock may take, over SSH. */
const CLOCK_TIMEOUT_MS = 30_000;

/**
 * Extends C: to the end of its disk. Windows Setup puts WinRE in a partition
 * of its own after C:, which stands between C: and the space a larger disk
 * adds, so WinRE moves onto C: and its partition goes, but only when space
 * follows it. Windows refuses a resize by less than 1 MB.
 */
const EXTEND_C = String.raw`try {
  Update-HostStorageCache
  $c = Get-Partition -DriveLetter C -ErrorAction Stop
  $disk = Get-Disk -Number $c.DiskNumber -ErrorAction Stop
  $after = @(Get-Partition -DiskNumber $c.DiskNumber | Where-Object Offset -gt $c.Offset)
  if ($after.Count -eq 1 -and $after[0].Type -eq 'Recovery' -and $disk.Size - $after[0].Offset - $after[0].Size -gt 1MB) {
    $out = reagentc.exe /disable 2>&1
    if ($LASTEXITCODE -ne 0) { throw "reagentc /disable failed: $out" }
    Remove-Partition -DiskNumber $c.DiskNumber -PartitionNumber $after[0].PartitionNumber -Confirm:$false -ErrorAction Stop
    $out = reagentc.exe /enable 2>&1
    if ($LASTEXITCODE -ne 0) { throw "reagentc /enable failed: $out" }
  }
  $max = (Get-PartitionSupportedSize -DriveLetter C -ErrorAction Stop).SizeMax
  $size = (Get-Partition -DriveLetter C -ErrorAction Stop).Size
  if ($max - $size -gt 1MB) { Resize-Partition -DriveLetter C -Size $max -ErrorAction Stop }
} catch {
  [Console]::Error.WriteLine("$_")
  exit 1
}`;

/**
 * BbDisplay.Fit sets the desktop to `width` by `height`. QEMU passes a
 * viewer's size on to the display driver, which then takes it beside the
 * modes Windows lists, though Windows does not switch to it. That can take a
 * moment, so it tries for up to `seconds`, at least once. Else it sets the smallest listed mode
 * that covers the size, which the viewer scales down and so stays sharp, else
 * the largest. The list can hold an earlier viewer's size that the driver no
 * longer takes, so it tries them in turn. Each keeps the colour depth, and the
 * mode is kept for the user's next logon.
 */
const DISPLAY_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
public static class BbDisplay {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct Mode {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
    public short SpecVersion, DriverVersion, Size, DriverExtra;
    public int Fields, PositionX, PositionY, Orientation, FixedOutput;
    public short Color, Duplex, YResolution, TTOption, Collate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string FormName;
    public short LogPixels;
    public int BitsPerPel, Width, Height, Flags, Frequency;
    public int ICMMethod, ICMIntent, MediaType, DitherType, Reserved1, Reserved2, PanningWidth, PanningHeight;
  }
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettings(string device, int index, ref Mode mode);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsEx(string device, ref Mode mode, IntPtr window, int flags, IntPtr param);
  static long Area(Mode mode) { return (long)mode.Width * mode.Height; }
  static int Set(Mode mode, int width, int height) {
    mode.Width = width;
    mode.Height = height;
    mode.Fields = 0x80000 | 0x100000; // DM_PELSWIDTH | DM_PELSHEIGHT
    return ChangeDisplaySettingsEx(null, ref mode, IntPtr.Zero, 1, IntPtr.Zero); // CDS_UPDATEREGISTRY
  }
  public static string Fit(int width, int height, int seconds) {
    var current = new Mode();
    current.Size = (short)Marshal.SizeOf(typeof(Mode));
    if (!EnumDisplaySettings(null, -1, ref current)) return "Windows gave no mode for the display.";
    if (current.Width == width && current.Height == height) return null;
    for (var deadline = DateTime.UtcNow.AddSeconds(seconds); ; Thread.Sleep(250)) {
      if (Set(current, width, height) == 0) return null;
      if (DateTime.UtcNow > deadline) break;
    }
    var modes = new List<Mode>();
    var mode = current;
    for (int i = 0; EnumDisplaySettings(null, i, ref mode); i++) if (mode.BitsPerPel == current.BitsPerPel) modes.Add(mode);
    modes.Sort((a, b) => {
      bool coversA = a.Width >= width && a.Height >= height, coversB = b.Width >= width && b.Height >= height;
      if (coversA != coversB) return coversA ? -1 : 1;
      return coversA ? Area(a).CompareTo(Area(b)) : Area(b).CompareTo(Area(a));
    });
    int result = -2; // DISP_CHANGE_BADMODE
    foreach (var chosen in modes) {
      if (chosen.Width == current.Width && chosen.Height == current.Height) return null;
      result = Set(current, chosen.Width, chosen.Height);
      if (result == 0) return null;
    }
    return "Windows refused " + width + "x" + height + " and the modes it lists, with " + result + ".";
  }
}`;

/** Named for its source, so a new source compiles afresh. */
const DISPLAY_DLL = `display-${createHash("sha256").update(DISPLAY_SOURCE).digest("hex").slice(0, 12)}.dll`;

/**
 * Loads BbDisplay as $bbDisplay, from a file in the box user's local app
 * data, compiling it there first if it is missing. Add-Type takes up to 3 s
 * in a new PowerShell, and loading the file a few milliseconds. Scripts that
 * compile at once each write a file of their own, and the first to move it
 * into place wins.
 */
const DISPLAY_HELPER = String.raw`$ErrorActionPreference = 'Stop'
$bbDll = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'bb-box', '${DISPLAY_DLL}')
if (-not (Test-Path -LiteralPath $bbDll)) {
  $bbTemp = "$bbDll.$PID"
  New-Item -ItemType Directory -Force -Path (Split-Path $bbDll) | Out-Null
  try {
    Add-Type -OutputAssembly $bbTemp -TypeDefinition @'
${DISPLAY_SOURCE}
'@
    [IO.File]::Move($bbTemp, $bbDll)
  } catch {
    if (-not (Test-Path -LiteralPath $bbDll)) { throw }
  } finally {
    Remove-Item -LiteralPath $bbTemp -ErrorAction Ignore
  }
}
$bbDisplay = [Reflection.Assembly]::LoadFile($bbDll).GetType('BbDisplay')`;

/**
 * Sets the desktop to `width` by `height`, or the listed mode that best
 * covers it. It runs in the box user's desktop session, as the session SSH
 * gives has another display.
 */
function modeScript(width: number, height: number, seconds: number): string {
  return `${DISPLAY_HELPER}
$bbRefused = $bbDisplay::Fit(${width}, ${height}, ${seconds})
if ($bbRefused) { [Console]::Error.WriteLine($bbRefused); exit 1 }`;
}

/**
 * Sets Windows' clock to `ms` after the epoch, plus the time PowerShell took
 * to start. A VM resumed from disk keeps the time it stopped at, and Windows
 * does not correct it for a while (039).
 */
function clockScript(ms: number): string {
  return `$bbNow = [DateTimeOffset]::FromUnixTimeMilliseconds(${ms}).LocalDateTime + ((Get-Date) - [Diagnostics.Process]::GetCurrentProcess().StartTime)
Set-Date -Date $bbNow -ErrorAction Stop | Out-Null`;
}

/**
 * Exits 0 once Windows' desktop is up: Explorer runs in a desktop session
 * and Cua's daemon listens on its pipe. A warm VM is saved then, so a claim
 * resumes a desktop that is ready for computer use.
 */
const DESKTOP_UP = `if ((Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0) -and (Test-Path -LiteralPath '${CUA_PIPE}')) { exit 0 }
exit 1`;

/** Extends C: over the space its disk grew by. */
export async function extendC(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  const result = await command.run(EXTEND_C, { timeoutMs: 60_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) {
    throw new Error(`The box's disk grew, but Windows could not extend C: over it: ${result.stderr.trim() || `exit code ${result.exitCode}`}.`);
  }
}

/**
 * Compiles the display helper, so that a box's first resize is as quick as
 * the rest. A failure is left to the first resize, which compiles it again.
 */
export async function compileDisplay(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  await command.run(DISPLAY_HELPER, { timeoutMs: RESIZE_TIMEOUT_MS, signal, maxOutputBytes: 4096 }).catch(() => undefined);
}

/**
 * Sets the desktop to `size`, or to the listed mode that best covers it,
 * through Windows itself (021), as the display driver does not switch to
 * a viewer's size. `seconds` is how long the driver may take to offer the
 * size; with 0 it is tried once.
 */
export async function setMode(command: CommandTransport, size: DisplaySize, signal?: AbortSignal, seconds = 2): Promise<void> {
  const { width, height } = size;
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error(`The desktop cannot be ${width} by ${height} pixels.`);
  }
  const result = await command.run(desktopScript(modeScript(width, height, seconds), RESIZE_TIMEOUT_MS), { timeoutMs: RESIZE_TIMEOUT_MS + 5_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) {
    throw new Error(`Windows could not set the desktop to ${width}x${height}: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
  }
}

/** Sets Windows' clock from BB's server's. */
export async function setClock(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  const result = await command.run(clockScript(Date.now()), { timeoutMs: CLOCK_TIMEOUT_MS, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) {
    throw new Error(`Windows could not set its clock: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
  }
}

/** Whether Windows' desktop is up (DESKTOP_UP). False when Windows does not answer. */
export async function desktopUp(command: CommandTransport, signal?: AbortSignal): Promise<boolean> {
  return (await command.run(DESKTOP_UP, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 }).catch(() => null))?.exitCode === 0;
}
