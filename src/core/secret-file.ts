import type { GuestOs, RunResult } from "../transports/types.ts";
import { sh } from "./box-fs-script.ts";
import { PRODUCT } from "../brand.ts";

export const SECRET_FILE_MOST_BYTES = 4096;
export const SECRET_MASK = "[hidden]";
export const SECRET_FILE_TIMEOUT_MS = 30_000;

export const SECURE_FIELD_TIMEOUT_MS = 30_000;

const MISSING = 10;
const NOT_A_FILE = 11;
const UNREADABLE = 12;
const EMPTY = 13;
const TOO_LARGE = 14;
const ENCODED_MOST_BYTES = Math.ceil(SECRET_FILE_MOST_BYTES / 3) * 4 + 1024;

export type RunInBox = (script: string, options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal; readonly session?: "desktop" }) => Promise<RunResult>;

export type SecretRead = { readonly ok: true; readonly secret: string } | { readonly ok: false; readonly reason: string; readonly hint: string };

export type FieldSecrecy = "hides" | "shows" | "unknown";

const HIDING_ROLE = /password|secure/i;
const SHOWING_ROLE = /text|entry|edit|search|combo|document|terminal|webarea/i;
const FIELD_THAT_MAY_HIDE: Readonly<Record<GuestOs, RegExp | null>> = {
  macos: /^AXTextField$/,
  windows: /edit/i,
  linux: null,
};

export function fieldSecrecy(os: GuestOs, role: string): FieldSecrecy {
  if (HIDING_ROLE.test(role)) return "hides";
  if (!SHOWING_ROLE.test(role)) return "unknown";
  if (FIELD_THAT_MAY_HIDE[os]?.test(role)) return "unknown";
  return "shows";
}

function powershellQuoted(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function readSecretScript(os: GuestOs, path: string): string {
  if (os === "windows") {
    return [
      `$f = ${powershellQuoted(path)}`,
      `if (-not (Test-Path -LiteralPath $f)) { exit ${MISSING} }`,
      `if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { exit ${NOT_A_FILE} }`,
      `try { $size = (Get-Item -LiteralPath $f -Force).Length } catch { exit ${UNREADABLE} }`,
      `if ($size -eq 0) { exit ${EMPTY} }`,
      `if ($size -gt ${SECRET_FILE_MOST_BYTES}) { exit ${TOO_LARGE} }`,
      `try { $bytes = [IO.File]::ReadAllBytes($f) } catch { exit ${UNREADABLE} }`,
      `if ($bytes.Length -gt ${SECRET_FILE_MOST_BYTES}) { exit ${TOO_LARGE} }`,
      `[Console]::Out.Write([Convert]::ToBase64String($bytes))`,
    ].join("\n");
  }
  return [
    `f=${sh(path)}`,
    `[ -e "$f" ] || exit ${MISSING}`,
    `[ -f "$f" ] || exit ${NOT_A_FILE}`,
    `[ -r "$f" ] || exit ${UNREADABLE}`,
    `size=$(wc -c < "$f") || exit ${UNREADABLE}`,
    `size=$((size + 0))`,
    `[ "$size" -gt 0 ] || exit ${EMPTY}`,
    `[ "$size" -le ${SECRET_FILE_MOST_BYTES} ] || exit ${TOO_LARGE}`,
    `base64 < "$f" || exit ${UNREADABLE}`,
  ].join("\n");
}

export function removeSecretScript(os: GuestOs, path: string): string {
  if (os === "windows") return `$f = ${powershellQuoted(path)}\nRemove-Item -LiteralPath $f -Force -ErrorAction SilentlyContinue\nif (Test-Path -LiteralPath $f) { exit 1 }`;
  return `f=${sh(path)}\nrm -f -- "$f" 2>/dev/null\n[ ! -e "$f" ]`;
}

export function withoutTrailingNewline(text: string): string {
  if (text.endsWith("\r\n")) return text.slice(0, -2);
  if (text.endsWith("\n")) return text.slice(0, -1);
  return text;
}

const EMPTY_FILE_HINT = "Write the secret to the file, then type it again.";

function emptyRead(path: string): SecretRead {
  return { ok: false, reason: `${path} is empty. ${PRODUCT} typed nothing.`, hint: EMPTY_FILE_HINT };
}

function tooLargeRead(path: string): SecretRead {
  return { ok: false, reason: `${path} is larger than ${SECRET_FILE_MOST_BYTES / 1024} KiB, the most ${PRODUCT} types from a file. ${PRODUCT} typed nothing.`, hint: "Give a file that holds only the secret." };
}

function refusedRead(path: string, exitCode: number | null): SecretRead {
  const typedNothing = `${PRODUCT} typed nothing.`;
  switch (exitCode) {
    case EMPTY:
      return emptyRead(path);
    case TOO_LARGE:
      return tooLargeRead(path);
    case MISSING:
      return { ok: false, reason: `${path} does not exist in the box. ${typedNothing}`, hint: "Write the secret to the file first, such as with op read in box_run, then type it again." };
    case NOT_A_FILE:
      return { ok: false, reason: `${path} is not a regular file, such as a folder. ${typedNothing}`, hint: "Give the path of a file that holds only the secret." };
    case UNREADABLE:
      return { ok: false, reason: `The box user cannot read ${path}. ${typedNothing}`, hint: "Write the file as the box user, the user box_run runs as, then type it again." };
    default:
      return { ok: false, reason: `${PRODUCT} could not read ${path} in the box. ${typedNothing}`, hint: "Check that the box answers with box_run, then try again." };
  }
}

export async function readSecretFile(run: RunInBox, os: GuestOs, path: string, signal?: AbortSignal): Promise<SecretRead> {
  const result = await run(readSecretScript(os, path), { timeoutMs: SECRET_FILE_TIMEOUT_MS, maxOutputBytes: ENCODED_MOST_BYTES, signal });
  if (result.exitCode !== 0 || result.truncated) return refusedRead(path, result.exitCode);
  const bytes = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  if (bytes.length === 0) return emptyRead(path);
  if (bytes.length > SECRET_FILE_MOST_BYTES) return tooLargeRead(path);
  const secret = withoutTrailingNewline(bytes.toString("utf8"));
  if (!secret) return { ok: false, reason: `${path} holds only a line break. ${PRODUCT} typed nothing.`, hint: EMPTY_FILE_HINT };
  return { ok: true, secret };
}

export async function removeSecretFile(run: RunInBox, os: GuestOs, path: string, signal?: AbortSignal): Promise<boolean> {
  try {
    const result = await run(removeSecretScript(os, path), { timeoutMs: SECRET_FILE_TIMEOUT_MS, maxOutputBytes: 4096, signal });
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

function formsOf(secret: string): readonly string[] {
  const escaped = JSON.stringify(secret).slice(1, -1);
  const forms = new Set([secret, escaped, secret.replace(/\s*\n\s*/g, " ")]);
  return [...forms].filter((form) => form.length > 0).sort((a, b) => b.length - a.length);
}

export function maskSecret(text: string, secret: string): string {
  let masked = text;
  for (const form of formsOf(secret)) masked = masked.split(form).join(SECRET_MASK);
  return masked;
}

export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let masked = text;
  for (const secret of secrets) masked = maskSecret(masked, secret);
  return masked;
}

export interface FieldIdentity {
  readonly role: string;
  readonly label: string;
}

export interface SecureProbe {
  readonly trusted: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly secure: boolean;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

const MAC_SECURE_SUBROLE = "AXSecureTextField";

function macSecureFieldScript(point: ScreenPoint): string {
  return `osascript -l JavaScript <<'BBBOXJXA'
ObjC.import("ApplicationServices");
function run() {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ trusted: false });
  const found = Ref();
  if ($.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), ${point.x}, ${point.y}, found) !== 0) return JSON.stringify({ trusted: true, role: null });
  const read = (name) => {
    const value = Ref();
    if ($.AXUIElementCopyAttributeValue(found[0], $(name), value) !== 0) return null;
    const plain = ObjC.unwrap(ObjC.castRefToObject(value[0]));
    return typeof plain === "string" ? plain : null;
  };
  return JSON.stringify({ trusted: true, role: read("AXRole"), name: read("AXTitle") || read("AXDescription"), secure: read("AXSubrole") === "${MAC_SECURE_SUBROLE}" });
}
BBBOXJXA`;
}

function windowsSecureFieldScript(point: ScreenPoint): string {
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase",
    `$found = [System.Windows.Automation.AutomationElement]::FromPoint([System.Windows.Point]::new(${point.x}, ${point.y}))`,
    "$current = $found.Current",
    "[pscustomobject]@{ trusted = $true; role = ($current.ControlType.ProgrammaticName -replace '^ControlType\\.', ''); name = $current.Name; secure = [bool]$current.IsPassword } | ConvertTo-Json -Compress",
  ].join("\n");
}

export function secureFieldScript(os: GuestOs, point: ScreenPoint): string | null {
  if (os === "macos") return macSecureFieldScript(point);
  if (os === "windows") return windowsSecureFieldScript(point);
  return null;
}

export function parseSecureProbe(stdout: string): SecureProbe | null {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    return { trusted: parsed.trusted === true, role: text(parsed.role), name: text(parsed.name), secure: parsed.secure === true };
  } catch {
    return null;
  }
}

function sameName(left: string | null, right: string): boolean {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim();
  return left !== null && plain(left) === plain(right);
}

export function secureVerdict(probe: SecureProbe | null, field: FieldIdentity): "secure" | "plain" | "unknown" {
  if (!probe?.trusted || probe.role !== field.role) return "unknown";
  if (field.label && !sameName(probe.name, field.label)) return "unknown";
  return probe.secure ? "secure" : "plain";
}
