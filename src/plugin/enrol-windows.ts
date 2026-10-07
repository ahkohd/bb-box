// Windows boxes as BB machines: a trial, off unless the Proxmox QEMU
// backend's setting is on (#539). BB's bootstrap runs its POSIX installer,
// install.sh, whatever the machine's OS, as its request names none, and
// install.sh runs only on macOS and Linux. But BB gives a machine's
// enrolment command, and its reconnect command, in a Windows form too:
// `windowsCommand`, which fetches install.ps1 with the machine's credential.
// For a provider's machine, BB makes the enrolment bundle only as the
// provider calls bootstrap, so bb-box still calls it, with an executor that
// runs the Windows form (windowsExecutor). bb-box runs it in the box user's
// desktop session, where BB's daemon has to run, not in SSH's session 0. The
// command holds the credential, so it goes as the script's stdin, not in its
// text.
//
// Node.js 22.19 or newer, which BB's Windows installer needs, is installed
// first when missing: a pinned portable build, checked by its SHA-256, in the
// box user's local app data and on that user's PATH. Images will have Node
// (#450), and then this finds it and does nothing.

import type { MachineExecutor } from "@get-bb/plugin-sdk";
import { command as inBoxCommand } from "../core/in-box.ts";
import type { CommandTransport, RunResult } from "../transports/types.ts";
import type { Phases } from "./enrol.ts";

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

/** The value of `name` that the command sets: as an argument `NAME=value`, or inside a shell script as NAME='value'. */
function assigned(command: readonly string[], name: string): string | null {
  for (const arg of command) {
    if (arg.startsWith(`${name}=`)) {
      const value = arg.slice(name.length + 1);
      return value.startsWith("'") ? unquoted(value) : value;
    }
    const at = arg.search(new RegExp(`(?:^|[\\s;])(?:export )?${name}='`));
    if (at >= 0) return unquoted(arg.slice(arg.indexOf(`${name}='`, at) + name.length + 1));
  }
  return null;
}

/** A shell single-quoted string at the start of `text`, `'\''` for a quote, unquoted; null when it does not end. */
function unquoted(text: string): string | null {
  let value = "";
  let at = 1;
  for (;;) {
    const end = text.indexOf("'", at);
    if (end < 0) return null;
    value += text.slice(at, end);
    if (text.startsWith("'\\''", end)) {
      value += "'";
      at = end + 4;
    } else return value;
  }
}

/** The command's shape for a message, with every long or JSON argument cut out, as one may carry the bundle. */
export function shapeOf(command: readonly string[]): string {
  return command.map((arg) => (arg.length > 48 || arg.includes("{") ? `<${arg.length} characters>` : arg)).join(" ");
}

/** The variable BB's POSIX request names for the bundle, and the bundle it sets there, if it does. */
export function bundleOf(command: readonly string[]): { name: string; bundle: string | null } | null {
  const at = command.indexOf("--bootstrap-env");
  const name = at >= 0 ? (command[at + 1] ?? null) : (/--bootstrap-env[ =]'?([A-Za-z_][A-Za-z0-9_]*)/.exec(command.join(" "))?.[1] ?? null);
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
  // Only a bundle counts: a script may set the variable from something else, such as $(cat).
  const value = assigned(command, name);
  return { name, bundle: value !== null && stdinBundle(value) ? value : null };
}

/** `text` when it is a bundle: a JSON object with a serverUrl, as install.sh reads one. */
export function stdinBundle(stdin: string): string | null {
  try {
    const parsed = JSON.parse(stdin) as unknown;
    return parsed && typeof parsed === "object" && typeof (parsed as { serverUrl?: unknown }).serverUrl === "string" ? stdin : null;
  } catch {
    return null;
  }
}

/** Stdin's shape for a message: its length, and the keys of a JSON object, never their values. */
export function stdinShape(stdin: string): string {
  try {
    const parsed = JSON.parse(stdin) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return `stdin of ${stdin.length} characters, a JSON object with ${Object.keys(parsed).join(", ") || "no keys"}`;
  } catch {}
  return `stdin of ${stdin.length} characters, not JSON${stdin.startsWith("#!") ? ", a script" : ""}`;
}

/** Runs install.ps1 with the bundle's headers, with the bundle, on stdin, in the variable `name`. */
function bundleScript(name: string): string {
  return WINDOWS_COMMAND_SCRIPT.replace(
    "$bbCommand = [Console]::In.ReadToEnd()",
    String.raw`$bbBundle = [Console]::In.ReadToEnd()
$bbParsed = $bbBundle | ConvertFrom-Json
$bbHeaders = @{}
if ($bbParsed.headers) { foreach ($bbHeader in $bbParsed.headers.PSObject.Properties) { $bbHeaders[$bbHeader.Name] = [string]$bbHeader.Value } }
Set-Item -LiteralPath 'Env:${name}' -Value $bbBundle
$bbCommand = Invoke-RestMethod -UseBasicParsing -Uri ($bbParsed.serverUrl.TrimEnd('/') + '/install.ps1') -Headers $bbHeaders`,
  );
}

export interface WindowsEnrolment {
  /** The machine's ID, once bb-box has it. */
  hostId(): Promise<string>;
  /** BB's enrolment command for the machine, with its Windows form. */
  command(hostId: string): Promise<{ windowsCommand?: string } | null>;
}

/**
 * The executor for BB's bootstrap on a Windows box (#539). BB makes a
 * provider's enrolment bundle only as it calls bootstrap, then asks for its
 * POSIX installer, which Windows cannot run. So when the request comes, this
 * runs, in the box user's desktop session, BB's Windows enrolment command,
 * which now exists; failing that, install.ps1 with the request's bundle;
 * failing both, it refuses, with the request's shape, so the log shows what
 * BB sent. It says which it ran, as the trial is to learn which works.
 */
export function windowsExecutor(transport: CommandTransport, enrolment: WindowsEnrolment, phases?: Phases): MachineExecutor {
  return {
    async exec({ command, stdin, timeoutMs, signal, onOutput }) {
      const requested = bundleOf(command);
      if (!requested) {
        onOutput(`bb-box cannot yet run this request of BB's on a Windows box: ${shapeOf(command)}\n`);
        return { exitCode: 2 };
      }
      const hostId = await enrolment.hostId();
      const windowsCommand = (await enrolment.command(hostId).catch(() => null))?.windowsCommand;
      let plan: { script: string; stdin: string; how: string };
      if (windowsCommand) plan = { script: WINDOWS_COMMAND_SCRIPT, stdin: windowsCommand, how: "BB's Windows enrolment command" };
      else {
        // The request sets the bundle in its command, or its script reads it from stdin.
        const bundle = requested.bundle ?? stdinBundle(stdin);
        if (!bundle) {
          onOutput(`BB gave no Windows enrolment command, and its request sets no ${requested.name}: ${shapeOf(command)}, with ${stdinShape(stdin)}\n`);
          return { exitCode: 2 };
        }
        plan = { script: bundleScript(requested.name), stdin: bundle, how: "install.ps1 with the bundle of BB's request, as BB gave no Windows enrolment command" };
      }
      onOutput(`bb-box: running ${plan.how}, in the box user's desktop session.\n`);
      phases?.mark("install");
      const result = await transport.run(inBoxCommand("windows", plan.script, { session: "desktop", timeoutMs }), { stdin: plan.stdin, timeoutMs: timeoutMs + 30_000, signal });
      phases?.mark("installed");
      if (result.stdout) onOutput(result.stdout);
      if (result.stderr) onOutput(result.stderr);
      return { exitCode: result.exitCode ?? (result.timedOut ? 124 : 137) };
    },
  };
}
