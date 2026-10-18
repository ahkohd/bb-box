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
 * moment, so it tries for up to `seconds`, at least once. Else it sets the
 * smallest listed mode that covers the size, which the viewer scales down and
 * so stays sharp, else the largest. The list can hold an earlier viewer's size
 * that the driver no longer takes, so it tries them in turn. Each keeps the
 * colour depth, and the mode is kept for the user's next logon.
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

/**
 * Loads class `type` of C# `source` as $`variable`, from a file in the box
 * user's local app data named for the source, so a new source compiles
 * afresh, compiling it there first if it is missing. Add-Type takes up to
 * 3 s in a new PowerShell, and loading the file a few milliseconds. Scripts
 * that compile at once each write a file of their own, and the first to move
 * it into place wins.
 */
function helper(name: string, source: string, type: string, variable: string): string {
  const dll = `${name}-${createHash("sha256").update(source).digest("hex").slice(0, 12)}.dll`;
  return String.raw`$ErrorActionPreference = 'Stop'
$bbDll = [IO.Path]::Combine([Environment]::GetFolderPath('LocalApplicationData'), 'bb-box', '${dll}')
if (-not (Test-Path -LiteralPath $bbDll)) {
  $bbTemp = "$bbDll.$PID"
  New-Item -ItemType Directory -Force -Path (Split-Path $bbDll) | Out-Null
  try {
    Add-Type -OutputAssembly $bbTemp -TypeDefinition @'
${source}
'@
    [IO.File]::Move($bbTemp, $bbDll)
  } catch {
    if (-not (Test-Path -LiteralPath $bbDll)) { throw }
  } finally {
    Remove-Item -LiteralPath $bbTemp -ErrorAction Ignore
  }
}
$${variable} = [Reflection.Assembly]::LoadFile($bbDll).GetType('${type}')`;
}

/** Loads BbDisplay as $bbDisplay (helper). */
const DISPLAY_HELPER = helper("display", DISPLAY_SOURCE, "BbDisplay", "bbDisplay");

/**
 * Sets the monitor's scaling, as Windows' Settings app does, at once and with
 * no sign-out: SPI_SETLOGICALDPIOVERRIDE takes a step up or down Windows'
 * list of scales from the one it recommends, so it takes the step that gives
 * the scale wanted, then checks the monitor's DPI until it is that, as
 * Windows caps a scale a mode is too small for.
 */
const SCALE_SOURCE = String.raw`using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class BbScale {
  [StructLayout(LayoutKind.Sequential)] struct Point { public int X, Y; }
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, int param, IntPtr value, uint flags);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromPoint(Point point, uint flags);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr monitor, int type, out uint x, out uint y);
  static readonly int[] Scales = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };
  static int Now() {
    uint x, y;
    GetDpiForMonitor(MonitorFromPoint(new Point(), 1), 0, out x, out y);
    return (int)(x * 100 / 96);
  }
  public static string Set(int percent) {
    SetThreadDpiAwarenessContext(new IntPtr(-4)); // the monitor's own DPI, not one scaled for an unaware thread
    int target = Array.IndexOf(Scales, percent);
    if (target < 0) return "Windows has no scale of " + percent + "%.";
    // Windows recommends 100% for the VirtIO GPU's modes, whose screen has no size, so the step is the scale's place in the list;
    // a step that lands elsewhere is put right from where it landed.
    int step = target;
    for (int attempt = 0; attempt < 3; attempt++) {
      if (Now() == percent) return null;
      if (!SystemParametersInfo(0x009F, step, IntPtr.Zero, 1)) return "Windows refused the scale of " + percent + "%."; // SPI_SETLOGICALDPIOVERRIDE, SPIF_UPDATEINIFILE
      for (int i = 0; i < 60 && Now() != percent; i++) Thread.Sleep(50);
      int landed = Array.IndexOf(Scales, Now());
      if (landed < 0) break;
      step += target - landed;
    }
    return Now() == percent ? null : "Windows is at " + Now() + "%, not " + percent + "%: the display's mode may be too small for it.";
  }
}`;

/** Loads BbScale as $bbScale (helper). */
const SCALE_HELPER = helper("scale", SCALE_SOURCE, "BbScale", "bbScale");

/**
 * Sets the scaling of the box's monitor to `percent`, in the box user's
 * desktop session, as a script for a desktop command: High resolution's 200%
 * at twice the pixels, and 100% back.
 */
export function scaleScript(percent: 100 | 200): string {
  return `${SCALE_HELPER}
$bbRefused = $bbScale::Set(${percent})
if ($bbRefused) { [Console]::Error.WriteLine($bbRefused); exit 1 }`;
}

/**
 * Gives each window a person sees that has no title the title "<app>
 * (untitled)": visible, unowned, top-level, neither cloaked nor a tool
 * window, larger than a pixel, and not Cua's. Cua on Windows lists and reads
 * only windows with a title (#365). A title the app set, even of spaces, is
 * left alone. It sets the title as SetWindowText would, but gives up on an
 * app that does not answer within a second. Returns "<handle>\t<title>" for
 * each window it named.
 */
const NAMER_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;

public static class BbWindows {
  delegate bool EnumProc(IntPtr window, IntPtr data);
  [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr window);
  [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr SendMessageTimeout(IntPtr window, uint message, IntPtr wParam, string lParam, uint flags, uint timeout, out IntPtr result);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

  public static string Name() {
    var named = new List<string>();
    EnumWindows((window, data) => {
      if (!IsWindowVisible(window) || GetWindow(window, 4) != IntPtr.Zero || GetWindowTextLength(window) != 0) return true;
      int style = GetWindowLong(window, -20);
      // WS_EX_TOOLWINDOW, unless WS_EX_APPWINDOW, as the taskbar is.
      if ((style & 0x80) != 0 && (style & 0x40000) == 0) return true;
      int cloaked;
      if (DwmGetWindowAttribute(window, 14, out cloaked, 4) == 0 && cloaked != 0) return true;
      Rect rect;
      if (!GetWindowRect(window, out rect) || rect.Right - rect.Left <= 1 || rect.Bottom - rect.Top <= 1) return true;
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      string app;
      try { app = Process.GetProcessById((int)pid).ProcessName; } catch { return true; }
      if (app == "cua-driver") return true;
      string title = app + " (untitled)";
      IntPtr result;
      // WM_SETTEXT, with SMTO_ABORTIFHUNG.
      if (SendMessageTimeout(window, 0x000C, IntPtr.Zero, title, 0x0002, 1000, out result) != IntPtr.Zero) named.Add(window.ToInt64() + "\t" + title);
      return true;
    }, IntPtr.Zero);
    return string.Join("\n", named);
  }
}`;

/** Names untitled windows in the box user's desktop session (NAMER_SOURCE), and prints what it named. */
export const NAME_WINDOWS_SCRIPT = `${helper("windows", NAMER_SOURCE, "BbWindows", "bbWindows")}
$bbNamed = $bbWindows::Name()
if ($bbNamed) { [Console]::Out.WriteLine($bbNamed) }`;

/** The windows NAME_WINDOWS_SCRIPT named, by handle, with their new titles. */
export function parseNamed(stdout: string): { id: number; title: string }[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => /^(\d+)\t(.+)$/.exec(line.trim()))
    .filter((match): match is RegExpExecArray => !!match)
    .map((match) => ({ id: Number(match[1]), title: match[2]! }));
}

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
