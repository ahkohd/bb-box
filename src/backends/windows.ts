// The Windows guest, as the Proxmox QEMU backend runs it on x86_64 and the
// Tart backend will in QEMU on a Mac (039, 046): what bb-box runs in it over
// SSH, in PowerShell 7 as the box user, to extend C:, to set the desktop's
// mode and Windows' clock, and to see that the desktop is up.

import { createHash } from "node:crypto";
import { SelkiesBox, type OpenStream } from "../core/selkies.ts";
import { desktopScript } from "../transports/powershell.ts";
import { POINTER_VERB } from "../core/pointer.ts";
import { BoxWebSocket } from "../core/websocket.ts";
import { pause } from "../transports/ready.ts";
import { PRODUCT } from "../brand.ts";
import type { BoxPointer, CommandTransport, DisplayInput, DisplaySize } from "../transports/types.ts";

/** The named pipe Cua's daemon listens on. A task at logon starts it, elevated, as SSH is (039). */
export const CUA_PIPE = "\\\\.\\pipe\\cua-driver";

/**
 * The desktop as video (060): bb-box-stream.exe in box's desktop session, which a box's image has where its record
 * lists OpenH264, on Proxmox and on a Mac. It leaves the pointer out while a person holds control (cursor "stream")
 * only where the record also lists the hardware cursor: without it, Windows draws the pointer into the image Desktop
 * Duplication returns.
 */
export const WINDOWS_VIDEO = { id: "video", protocol: "selkies", resizable: true } as const;
/**
 * One connection to it, in the pwsh that box's SSH runs: the pipe to the server, started through its task if it is not
 * running, copied both ways with the SSH channel. Whether it runs is asked of the pipe's name, at once: a connect that
 * waited 500 ms to fail was a third of a cold first picture (#916). pwsh copies, not bb-box-stream.exe connect: over SSH, a native
 * program pwsh starts gets only what reached its stdin before it started (measured 17 October 2026).
 */
export const WINDOWS_STREAM = [
  "$p = [IO.Pipes.NamedPipeClientStream]::new('.', 'bb-box-stream', 'InOut', 'Asynchronous')",
  "if (-not [IO.File]::Exists('\\\\.\\pipe\\bb-box-stream')) { schtasks.exe /run /tn bb-box-stream | Out-Null }",
  "$p.Connect(15000)",
  "$i = [Console]::OpenStandardInput(); $o = [Console]::OpenStandardOutput()",
  "[void][Threading.Tasks.Task]::WaitAny(@($p.CopyToAsync($o), $i.CopyToAsync($p)))",
].join("; ");

/**
 * Follows the box's pointer through a connection of its own to bb-box-stream.exe, `open`, which says where it is
 * (BB_POINTER_FOLLOW) and what it looks like, until `signal` ends it or the server does: a video from QEMU on a Mac has
 * no pointer in it, nor has QEMU's VNC (#865). A server from before says nothing of where it is.
 */
export async function followWindowsPointer(open: OpenStream, onEvent: (event: BoxPointer) => void, signal: AbortSignal): Promise<void> {
  const socket = await BoxWebSocket.upgrade(await open(signal), { host: "localhost", path: "/api/websockets", signal });
  const end = () => void socket.close().catch(() => undefined);
  signal.addEventListener("abort", end, { once: true });
  try {
    await socket.send("BB_POINTER_FOLLOW");
    for (let message = await socket.next(); message !== null && !signal.aborted; message = await socket.next()) {
      if (typeof message !== "string") continue;
      if (message.startsWith("cursor,")) onEvent({ type: "shape", message });
      else if (message === `${POINTER_VERB},`) onEvent({ type: "leave" });
      else if (message.startsWith(`${POINTER_VERB},`)) {
        const [x, y] = message.slice(POINTER_VERB.length + 1).split(",").map(Number);
        if (Number.isInteger(x) && Number.isInteger(y)) onEvent({ type: "position", x: x!, y: y! });
      }
    }
  } finally {
    signal.removeEventListener("abort", end);
    end();
  }
}

/** Where a Windows image has bb-box-stream.exe (setup/windows/install-stream.ps1). */
export const WINDOWS_STREAM_EXE = "C:\\Program Files\\bb-box-tools\\bb-box-stream\\bb-box-stream.exe";
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

const DESKTOP_LOGGED_IN = "(Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0)";
/**
 * Exits 0 once Windows' desktop is up: Explorer runs in a desktop session
 * and Cua's daemon listens on its pipe. A warm VM is saved then, so a claim
 * resumes a desktop that is ready for computer use.
 */
const EXIT_0_WHEN_DESKTOP_UP = `if (${DESKTOP_LOGGED_IN} -and (Test-Path -LiteralPath '${CUA_PIPE}')) { exit 0 }`;

const PASSWORD_REPAIRED_AND_RESTARTING = 3;
const PASSWORD_REPAIR_FAILED = 4;

const SET_BOX_USER_PASSWORD_NEVER_EXPIRES = `Set-LocalUser -Name $bbUser.Name -PasswordNeverExpires $true
net.exe accounts /maxpwage:unlimited | Out-Null`;

const DESKTOP_UP_OR_REPAIR = `${EXIT_0_WHEN_DESKTOP_UP}
$bbUser = Get-LocalUser -Name ([Environment]::UserName)
if ($null -eq $bbUser.PasswordExpires -or $bbUser.PasswordExpires -gt (Get-Date)) { exit 1 }
if (${DESKTOP_LOGGED_IN}) { exit 1 }
${SET_BOX_USER_PASSWORD_NEVER_EXPIRES}
if ($null -ne (Get-LocalUser -Name $bbUser.Name).PasswordExpires) {
  [Console]::Error.WriteLine("The password of $($bbUser.Name) expired on $($bbUser.PasswordExpires.ToString('u')), and Windows did not set it never to expire.")
  exit ${PASSWORD_REPAIR_FAILED}
}
[Console]::Out.WriteLine("The password of $($bbUser.Name) expired on $($bbUser.PasswordExpires.ToString('u')).")
shutdown.exe /r /t 0 /c "${PRODUCT} set the box user's password never to expire"
exit ${PASSWORD_REPAIRED_AND_RESTARTING}`;

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

/**
 * Takes Windows' pointer out of the picture, or puts it back, for the VNC
 * display: QEMU's and Tart's servers show what Windows draws, and once a
 * mouse has moved Windows draws its pointer, so a person in control saw the
 * box's pointer trail their browser's (the desktop sweep). Out, each of
 * Windows' pointers is a blank one (SetSystemCursor); back, Windows loads
 * the user's own (SPI_SETCURSORS). The blank ones last until then, or until
 * the user signs in again.
 */
const POINTER_SOURCE = String.raw`using System;
using System.Runtime.InteropServices;

public static class BbPointer {
  [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr cursor, uint id);
  [DllImport("user32.dll")] static extern IntPtr CreateCursor(IntPtr instance, int x, int y, int width, int height, byte[] and, byte[] xor);
  [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint param, IntPtr value, uint winIni);
  // The arrow, I-beam, wait, cross, up arrow, the four sizes and move, no, hand, app starting, help, pin and person.
  static readonly uint[] CURSORS = { 32512, 32513, 32514, 32515, 32516, 32642, 32643, 32644, 32645, 32646, 32648, 32649, 32650, 32651, 32671, 32672 };
  const uint SPI_SETCURSORS = 0x57;

  public static void Hide() {
    byte[] and = new byte[32 * 32 / 8], xor = new byte[32 * 32 / 8];
    for (int i = 0; i < and.Length; i++) and[i] = 0xff;
    foreach (uint id in CURSORS) SetSystemCursor(CreateCursor(IntPtr.Zero, 0, 0, 32, 32, and, xor), id);
  }

  public static void Show() {
    SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0);
  }
}`;

/** Loads BbPointer as $bbPointer (helper). */
const POINTER_HELPER = helper("pointer", POINTER_SOURCE, "BbPointer", "bbPointer");

/** Shows or hides Windows' pointer in the desktop's picture, in the box user's desktop session. */
export async function windowsPointer(command: CommandTransport, shown: boolean, signal?: AbortSignal): Promise<void> {
  const script = `${POINTER_HELPER}
$bbPointer::${shown ? "Show" : "Hide"}()`;
  const result = await command.run(desktopScript(script, POINTER_TIMEOUT_MS), { timeoutMs: POINTER_TIMEOUT_MS + 5_000, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) throw new Error(`Windows' pointer could not be ${shown ? "shown" : "hidden"}: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
}

/** How long Windows may take to show or hide its pointer, its helper compiled the first time. */
const POINTER_TIMEOUT_MS = 30_000;

/** Each printable key of a US keyboard by its XT scancode, as QEMU takes it: its character, then with Shift. */
const US_SCANCODES: ReadonlyArray<readonly [number, string]> = [
  [0x02, "1!"], [0x03, "2@"], [0x04, "3#"], [0x05, "4$"], [0x06, "5%"], [0x07, "6^"], [0x08, "7&"], [0x09, "8*"], [0x0a, "9("], [0x0b, "0)"],
  [0x0c, "-_"], [0x0d, "=+"], [0x10, "qQ"], [0x11, "wW"], [0x12, "eE"], [0x13, "rR"], [0x14, "tT"], [0x15, "yY"], [0x16, "uU"], [0x17, "iI"],
  [0x18, "oO"], [0x19, "pP"], [0x1a, "[{"], [0x1b, "]}"], [0x1e, "aA"], [0x1f, "sS"], [0x20, "dD"], [0x21, "fF"], [0x22, "gG"], [0x23, "hH"],
  [0x24, "jJ"], [0x25, "kK"], [0x26, "lL"], [0x27, ";:"], [0x28, "'\""], [0x29, "`~"], [0x2b, "\\|"], [0x2c, "zZ"], [0x2d, "xX"], [0x2e, "cC"],
  [0x2f, "vV"], [0x30, "bB"], [0x31, "nN"], [0x32, "mM"], [0x33, ",<"], [0x34, ".>"], [0x35, "/?"], [0x56, "\\|"],
];
const US_BY_SCANCODE = new Map(US_SCANCODES.map(([code, chars]) => [code, [chars.codePointAt(0)!, chars.codePointAt(1)!] as const]));
/** Each character a US keyboard types, and whether it takes Shift. */
const US_CHARACTERS = new Map(US_SCANCODES.flatMap(([, chars]) => [[chars.codePointAt(0)!, false] as const, [chars.codePointAt(1)!, true] as const]));
const SHIFT_KEYS = [0xffe1, 0xffe2];
/** Ctrl, Alt and the Windows key, as noVNC names them: a key with one held is a shortcut, which stays a key. */
const SHORTCUT_KEYS = [0xffe3, 0xffe4, 0xffe9, 0xffea, 0xffe7, 0xffe8, 0xffeb, 0xffec];

/**
 * Whether a key goes to bb-box-stream as its character rather than to QEMU's
 * VNC server, which types by key on the box's US layout: QEMU's key event by
 * its scancode, so é from a Mac's Option+E then E typed e, AZERTY's a typed
 * q and a French ! typed /; a plain key event by the key a US keyboard types
 * it with, dropping é and typing a French ! as 1. A printable key goes as
 * its character when it is not what its key types on a US keyboard with the
 * Shift held, or a US keyboard has no key for it; never Space, nor with Ctrl,
 * Alt or the Windows key held, so a US keyboard's keys, shortcuts and games
 * keep QEMU's keys.
 */
export function windowsTypesAsCharacter(keysym: number, held: ReadonlySet<number>, scancode?: number): boolean {
  if (SHORTCUT_KEYS.some((key) => held.has(key))) return false;
  const codePoint = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym > 0x20 && keysym <= 0xff ? keysym : null;
  if (codePoint === null || codePoint <= 0x20 || codePoint > 0x10ffff) return false;
  const shift = SHIFT_KEYS.some((key) => held.has(key));
  if (scancode !== undefined) {
    const key = US_BY_SCANCODE.get(scancode);
    return !key || key[shift ? 1 : 0] !== codePoint;
  }
  const shifted = US_CHARACTERS.get(codePoint);
  return shifted === undefined || shifted !== shift;
}

/** How long QEMU's VNC server spaces the key events it takes: its key-delay-ms, which neither Proxmox nor Tart sets. */
export const QEMU_KEY_DELAY_MS = 10;

/** How long the first character waits for bb-box-stream to say it takes BB_PING, before it is taken for one that does not. */
const FIRST_PONG_MS = 1_000;
/** How long a character waits for bb-box-stream to say it has typed it. */
const PONG_MS = 2_000;
/** What a character waits instead, on a box whose bb-box-stream does not say: QEMU's next key must not overtake it. */
const UNSAID_WAIT_MS = 50;

/**
 * Types the characters windowsTypesAsCharacter picks with bb-box-stream, over
 * an input connection of its own, for the VNC display's relay. Where it
 * answers BB_PING, as from the image with BB_PONG, as cd and cu, always as the
 * character, and each once it has typed it; else as a Unicode keysym's kd
 * and ku, which it types as the character where its key would type another,
 * and each with a short wait.
 */
export function windowsCharacterInput(open: OpenStream): DisplayInput {
  const box = new SelkiesBox(open);
  let says: Promise<boolean> | null = null;
  return {
    key: async () => false,
    async character(down, keysym) {
      says ??= box.ping(FIRST_PONG_MS);
      const answers = await says;
      const codePoint = keysym >= 0x1000000 ? keysym - 0x1000000 : keysym;
      await box.input(answers ? `${down ? "cd" : "cu"},${codePoint}` : `${down ? "kd" : "ku"},${0x1000000 | codePoint}`);
      if (!answers || !(await box.ping(PONG_MS))) await pause(UNSAID_WAIT_MS);
    },
    pointer: async () => undefined,
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: () => box.close(),
  };
}

/** Sets Windows' clock from BB's server's. */
export async function setClock(command: CommandTransport, signal?: AbortSignal): Promise<void> {
  const result = await command.run(clockScript(Date.now()), { timeoutMs: CLOCK_TIMEOUT_MS, signal, maxOutputBytes: 4096 });
  if (result.exitCode !== 0) {
    throw new Error(`Windows could not set its clock: ${result.stderr.trim() || `exit code ${result.exitCode}.`}`);
  }
}

export interface DesktopChecked {
  readonly up: boolean;
  readonly restarting: boolean;
  readonly said: string | null;
}

export async function checkDesktopOrRepairExpiredPassword(command: CommandTransport, signal?: AbortSignal): Promise<DesktopChecked> {
  const result = await command.run(DESKTOP_UP_OR_REPAIR, { timeoutMs: 10_000, signal, maxOutputBytes: 4096 }).catch(() => null);
  const restarting = result?.exitCode === PASSWORD_REPAIRED_AND_RESTARTING;
  const said = restarting ? `${result.stdout.trim()} ${PASSWORD_REPAIRED_SAYS}` : result?.exitCode === PASSWORD_REPAIR_FAILED ? result.stderr.trim() : null;
  return { up: result?.exitCode === 0, restarting, said };
}

export function desktopUpOrRepairExpiredPassword(command: CommandTransport, heard: (said: string) => void): { probe: (signal?: AbortSignal) => Promise<boolean> } {
  return {
    async probe(signal) {
      const checked = await checkDesktopOrRepairExpiredPassword(command, signal);
      if (checked.said) heard(checked.said);
      return checked.up;
    },
  };
}

const PASSWORD_REPAIRED_SAYS = `Windows did not log the box user in to the desktop, so ${PRODUCT} set the password never to expire and restarted Windows.`;

export const PASSWORD_REPAIR_BY_HAND =
  "If the box user's password has expired, run Set-LocalUser -Name box -PasswordNeverExpires $true; net accounts /maxpwage:unlimited in the box, then restart it.";
