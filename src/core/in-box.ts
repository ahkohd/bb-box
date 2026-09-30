// Everything bb-box runs inside a box, written once per guest OS: POSIX sh
// for Linux and macOS, PowerShell for Windows. Backends never run these; the
// core sends them through the box's command transport.

import type { GuestOs } from "../transports/types.ts";

/**
 * The thread's environment for commands in the box, relative to the box
 * user's home. bb-box writes it when the box is enrolled and sources it
 * before every command it runs.
 */
export function envFile(os: GuestOs): string {
  return os === "windows" ? ".config/bb-box/env.ps1" : ".config/bb-box/env";
}

function sh(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function ps(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

/** Wraps `command` so it runs with the thread's environment, in `cwd` when given. */
export function command(os: GuestOs, script: string, cwd?: string): string {
  if (os === "windows") {
    const env = `$bbBoxEnv = Join-Path $HOME ${ps(envFile(os))}; if (Test-Path -LiteralPath $bbBoxEnv) { . $bbBoxEnv }; `;
    const cd = cwd ? `Set-Location -LiteralPath ${ps(cwd)}; ` : "";
    return `${env}${cd}${script}`;
  }
  const env = `if [ -r "$HOME/${envFile(os)}" ]; then . "$HOME/${envFile(os)}"; fi; `;
  const cd = cwd ? `cd -- ${sh(cwd)} && ` : "";
  return `${env}${cd}${script}`;
}

/**
 * The file that sets `variables` for commands in the box. Names that are not
 * valid shell names are left out.
 */
export function envScript(os: GuestOs, variables: Readonly<Record<string, string>>): string {
  const names = Object.keys(variables)
    .filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    .sort();
  if (os === "windows") {
    return names.map((name) => `$env:${name} = ${ps(variables[name]!)}`).join("\r\n") + "\r\n";
  }
  const header = "# Written by bb-box: the thread's environment for commands in this box.\n";
  return header + names.map((name) => `export ${name}=${sh(variables[name]!)}`).join("\n") + "\n";
}
