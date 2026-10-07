// The thread's access for commands in a Windows box that is a BB machine
// (#560), as in Linux and macOS boxes: each command takes the named
// variables from the newest process below BB's daemon that has the most of
// them. Windows has no /proc and no `ps -E`, so a small reader reads each
// process's environment block from its PEB, the way Windows' own tools do.
// The env file carries the reader's C# source, packed; the first command
// compiles it once into the box user's local app data, and later commands
// load it, in about 20 ms. Its class is named for its source, so a changed
// reader is compiled afresh. Values never reach the disk.

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

/**
 * The reader. Process.GetProcesses lists the processes; each is opened for
 * querying and reading only. A process's parent counts only if it started
 * first, as Windows reuses process IDs. A daemon is a process whose program
 * or first argument holds `parent`, with \ read as /. The PEB offsets are
 * those of 64-bit Windows, x64 and arm64 alike.
 */
const SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class @TYPE@ {
  [StructLayout(LayoutKind.Sequential)]
  struct Basic { public IntPtr ExitStatus; public IntPtr Peb; public IntPtr Affinity; public IntPtr Priority; public IntPtr Pid; public IntPtr Parent; }

  class Proc { public int Pid; public int Parent; public long Created; public IntPtr Handle; public IntPtr Peb; }

  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, ref Basic info, int length, out int returned);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr process, int kind, IntPtr info, int length, out int returned);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, IntPtr size, out IntPtr read);
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CommandLineToArgvW(string line, out int count);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr memory);

  // PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ
  const int Rights = 0x1010;
  const int CommandLineInformation = 60;

  static Dictionary<int, Proc> Snapshot() {
    var all = new Dictionary<int, Proc>();
    foreach (var process in Process.GetProcesses()) {
      int pid = process.Id;
      process.Dispose();
      IntPtr handle = OpenProcess(Rights, false, pid);
      if (handle == IntPtr.Zero) continue;
      var basic = new Basic();
      int returned;
      long created, exited, kernel, user;
      if (NtQueryInformationProcess(handle, 0, ref basic, Marshal.SizeOf(basic), out returned) != 0 || !GetProcessTimes(handle, out created, out exited, out kernel, out user)) {
        CloseHandle(handle);
        continue;
      }
      all[pid] = new Proc { Pid = pid, Parent = (int)(long)basic.Parent, Created = created, Handle = handle, Peb = basic.Peb };
    }
    return all;
  }

  static void Close(Dictionary<int, Proc> all) {
    foreach (var p in all.Values) CloseHandle(p.Handle);
  }

  static string CommandLine(IntPtr handle) {
    int size = 4096;
    for (int attempt = 0; attempt < 2; attempt++) {
      IntPtr buffer = Marshal.AllocHGlobal(size);
      try {
        int returned;
        if (NtQueryInformationProcess(handle, CommandLineInformation, buffer, size, out returned) == 0) {
          int length = Marshal.ReadInt16(buffer) & 0xFFFF;
          return Marshal.PtrToStringUni(Marshal.ReadIntPtr(buffer, IntPtr.Size), length / 2);
        }
        if (returned <= size) return null;
        size = returned;
      } finally {
        Marshal.FreeHGlobal(buffer);
      }
    }
    return null;
  }

  static bool IsDaemon(Proc p, string parent, Dictionary<int, bool> known) {
    bool found;
    if (known.TryGetValue(p.Pid, out found)) return found;
    string line = CommandLine(p.Handle);
    int count = 0;
    IntPtr argv = line == null ? IntPtr.Zero : CommandLineToArgvW(line, out count);
    if (argv != IntPtr.Zero) {
      try {
        for (int i = 0; i < Math.Min(count, 2) && !found; i++) {
          string arg = Marshal.PtrToStringUni(Marshal.ReadIntPtr(argv, i * IntPtr.Size));
          found = arg != null && arg.Replace('\\', '/').IndexOf(parent, StringComparison.OrdinalIgnoreCase) >= 0;
        }
      } finally {
        LocalFree(argv);
      }
    }
    known[p.Pid] = found;
    return found;
  }

  static bool BelowDaemon(Proc p, Dictionary<int, Proc> all, string parent, Dictionary<int, bool> known) {
    for (int depth = 0; depth < 64; depth++) {
      Proc up;
      if (!all.TryGetValue(p.Parent, out up) || up.Pid == p.Pid || up.Created > p.Created) return false;
      if (IsDaemon(up, parent, known)) return true;
      p = up;
    }
    return false;
  }

  static IntPtr Pointer(IntPtr handle, IntPtr address) {
    var buffer = new byte[8];
    IntPtr read;
    return ReadProcessMemory(handle, address, buffer, (IntPtr)8, out read) ? (IntPtr)BitConverter.ToInt64(buffer, 0) : IntPtr.Zero;
  }

  static Dictionary<string, string> Environment(Proc p) {
    var vars = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
    IntPtr parameters = Pointer(p.Handle, p.Peb + 0x20);
    if (parameters == IntPtr.Zero) return vars;
    IntPtr block = Pointer(p.Handle, parameters + 0x80);
    long size = (long)Pointer(p.Handle, parameters + 0x3F0);
    if (block == IntPtr.Zero || size <= 0 || size > (1 << 22)) return vars;
    var bytes = new byte[size];
    IntPtr read;
    if (!ReadProcessMemory(p.Handle, block, bytes, (IntPtr)size, out read)) return vars;
    foreach (string entry in Encoding.Unicode.GetString(bytes, 0, (int)read).Split('\0')) {
      // Entries such as =C:=C:\ start with =.
      int equals = entry.Length < 2 ? -1 : entry.IndexOf('=', 1);
      if (equals > 0 && !vars.ContainsKey(entry.Substring(0, equals))) vars[entry.Substring(0, equals)] = entry.Substring(equals + 1);
    }
    return vars;
  }

  // The named variables of the newest process below the daemon that has
  // the most of them, as name, value, name, value.
  public static string[] Read(string parent, string[] names) {
    var all = Snapshot();
    try {
      var known = new Dictionary<int, bool>();
      var best = new List<string>();
      int most = 0, bestPid = 0;
      long newest = 0;
      foreach (var p in all.Values) {
        if (!BelowDaemon(p, all, parent, known)) continue;
        var vars = Environment(p);
        var found = new List<string>();
        foreach (string name in names) {
          string value;
          if (vars.TryGetValue(name, out value)) { found.Add(name); found.Add(value); }
        }
        int count = found.Count / 2;
        if (count == 0 || count < most || (count == most && (p.Created < newest || (p.Created == newest && p.Pid < bestPid)))) continue;
        best = found;
        most = count;
        newest = p.Created;
        bestPid = p.Pid;
      }
      return best.ToArray();
    } finally {
      Close(all);
    }
  }

  // Whether a process of BB's daemon runs.
  public static bool Daemon(string parent) {
    var all = Snapshot();
    try {
      var known = new Dictionary<int, bool>();
      foreach (var p in all.Values) if (IsDaemon(p, parent, known)) return true;
      return false;
    } finally {
      Close(all);
    }
  }
}
`;

/** The reader's class, named for its source. */
export const READER_TYPE = `BbBoxAccess${createHash("sha256").update(SOURCE).digest("hex").slice(0, 12)}`;

/** The reader's source, as it is compiled. */
export const READER_SOURCE = SOURCE.replace("@TYPE@", READER_TYPE);

const PACKED = gzipSync(Buffer.from(READER_SOURCE, "utf8"), { level: 9 }).toString("base64");

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/**
 * Loads the reader, compiling it first if this box has not. Commands that
 * compile it at once each write their own file and the first to finish
 * gives it its name; one that loaded its own uses that. Loading takes .NET
 * calls, not cmdlets, which would load their modules, about 60 ms more.
 */
const LOAD_READER = `if (-not (${ps(READER_TYPE)} -as [type])) {
    $bbDll = [IO.Path]::Combine($env:LOCALAPPDATA, 'bb-box', ${ps(`${READER_TYPE}.dll`)})
    if (-not [IO.File]::Exists($bbDll)) {
      New-Item -ItemType Directory -Force -Path (Split-Path $bbDll) | Out-Null
      $bbZip = [IO.Compression.GZipStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('${PACKED}')), [IO.Compression.CompressionMode]::Decompress)
      $bbNew = "$bbDll.$PID.dll"
      Add-Type -TypeDefinition ([IO.StreamReader]::new($bbZip).ReadToEnd()) -OutputAssembly $bbNew -OutputType Library -ErrorAction Stop
      Move-Item -LiteralPath $bbNew -Destination $bbDll -Force -ErrorAction SilentlyContinue
      Remove-Item -LiteralPath $bbNew -Force -ErrorAction SilentlyContinue
    }
    if (-not (${ps(READER_TYPE)} -as [type])) { $null = [Reflection.Assembly]::LoadFrom($bbDll) }
  }`;

/**
 * The env file's lines that set `names` from BB's daemon's processes, afresh
 * each time it is sourced. A reader that cannot load or read leaves them
 * unset, and the command runs on.
 */
export function windowsAccessLoader(names: readonly string[], parent: string): string {
  if (!names.length) return "";
  return `& {
  try {
  ${LOAD_READER}
    $bbFound = [${READER_TYPE}]::Read(${ps(parent)}, [string[]]@(${names.map(ps).join(", ")}))
    for ($i = 0; $i -lt $bbFound.Length; $i += 2) { [Environment]::SetEnvironmentVariable($bbFound[$i], $bbFound[$i + 1]) }
  } catch {}
}\r\n`;
}

/**
 * The access check's Windows form: exits `found` once the env file set the
 * required names, or any name when none is required, `waiting` while BB's
 * daemon runs without them, and `noDaemon` when none runs or the reader
 * cannot tell.
 */
export function windowsAccessCheck(names: readonly string[], required: readonly string[], parent: string, exits: { found: number; waiting: number; noDaemon: number }): string {
  const set = (required.length ? required : names).map((name) => `[Environment]::GetEnvironmentVariable(${ps(name)})`).join(required.length ? " -and " : " -or ");
  return `if (${set}) { exit ${exits.found} }
try {
  ${LOAD_READER}
  if ([${READER_TYPE}]::Daemon(${ps(parent)})) { exit ${exits.waiting} }
} catch {}
exit ${exits.noDaemon}
`;
}

/**
 * The access setup's Windows form: git asks gh for GitHub credentials, so
 * both use GH_TOKEN, and fetches GitHub's SSH URLs over HTTPS, as on Linux
 * and macOS. Prints how long it took, in milliseconds.
 */
export const WINDOWS_ACCESS_SETUP = `$bbClock = [Diagnostics.Stopwatch]::StartNew()
$bbCode = 0
if (Get-Command git -ErrorAction SilentlyContinue) {
  if (Get-Command gh -ErrorAction SilentlyContinue) {
    & gh auth setup-git *> $null
    if ($LASTEXITCODE -ne 0) {
      & git config --global --replace-all credential.https://github.com.helper ''
      if ($LASTEXITCODE -eq 0) { & git config --global --add credential.https://github.com.helper '!gh auth git-credential' }
      if ($LASTEXITCODE -ne 0) { $bbCode = $LASTEXITCODE }
    }
  }
  & git config --global --replace-all url.https://github.com/.insteadOf git@github.com: '^git@github\\.com:$'
  if ($LASTEXITCODE -eq 0) { & git config --global --replace-all url.https://github.com/.insteadOf ssh://git@github.com/ '^ssh://git@github\\.com/$' }
  if ($LASTEXITCODE -ne 0) { $bbCode = $LASTEXITCODE }
}
[Console]::Out.Write("$([int]$bbClock.Elapsed.TotalMilliseconds)\`n")
exit $bbCode
`;
