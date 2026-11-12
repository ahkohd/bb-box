import type { GuestOs, RunResult } from "../transports/types.ts";
import { sh } from "./box-fs-script.ts";
import { PRODUCT } from "../brand.ts";

export const SECRET_FILE_MOST_BYTES = 4096;
export const SECRET_MASK = "[hidden]";
export const SECRET_FILE_TIMEOUT_MS = 30_000;

const MISSING = 10;
const NOT_A_FILE = 11;
const UNREADABLE = 12;
const READ_BYTES = SECRET_FILE_MOST_BYTES + 1;
const ENCODED_MOST_BYTES = Math.ceil(READ_BYTES / 3) * 4 + 1024;

export type RunInBox = (script: string, options: { readonly timeoutMs: number; readonly maxOutputBytes: number; readonly signal?: AbortSignal }) => Promise<RunResult>;

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
      `try { $s = [IO.File]::OpenRead($f) } catch { exit ${UNREADABLE} }`,
      `$b = New-Object byte[] ${READ_BYTES}; $n = 0`,
      `try { while ($n -lt ${READ_BYTES}) { $r = $s.Read($b, $n, ${READ_BYTES} - $n); if ($r -le 0) { break }; $n += $r } } catch { exit ${UNREADABLE} } finally { $s.Close() }`,
      `[Console]::Out.Write([Convert]::ToBase64String($b, 0, $n))`,
    ].join("\n");
  }
  return [`f=${sh(path)}`, `[ -e "$f" ] || exit ${MISSING}`, `[ -f "$f" ] || exit ${NOT_A_FILE}`, `[ -r "$f" ] || exit ${UNREADABLE}`, `head -c ${READ_BYTES} "$f" | base64 | tr -d '\\n\\r'`].join("\n");
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

function refusedRead(path: string, exitCode: number | null): SecretRead {
  const typedNothing = `${PRODUCT} typed nothing.`;
  switch (exitCode) {
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
  if (bytes.length === 0) return { ok: false, reason: `${path} is empty. ${PRODUCT} typed nothing.`, hint: "Write the secret to the file, then type it again." };
  if (bytes.length > SECRET_FILE_MOST_BYTES) {
    return { ok: false, reason: `${path} is larger than ${SECRET_FILE_MOST_BYTES / 1024} KiB, the most ${PRODUCT} types from a file. ${PRODUCT} typed nothing.`, hint: "Give a file that holds only the secret." };
  }
  const secret = withoutTrailingNewline(bytes.toString("utf8"));
  if (!secret) return { ok: false, reason: `${path} holds only a line break. ${PRODUCT} typed nothing.`, hint: "Write the secret to the file, then type it again." };
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

export type ReadBack = "shows" | "hides" | "unknown";

const ONLY_MASK_CHARACTERS = /^[\u2022\u25cf\u2217*]*$/;

export function holdsSecret(value: string | null, secret: string): boolean {
  return value !== null && maskSecret(value, secret) !== value;
}

export function readBackOf(value: string | null, secret: string): ReadBack {
  if (value === null) return "unknown";
  if (holdsSecret(value, secret)) return "shows";
  return ONLY_MASK_CHARACTERS.test(value) ? "hides" : "unknown";
}

export function maskSecrets(text: string, secrets: Iterable<string>): string {
  let masked = text;
  for (const secret of secrets) masked = maskSecret(masked, secret);
  return masked;
}
