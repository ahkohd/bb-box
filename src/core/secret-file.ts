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

export const HIDDEN_VALUE = "(hidden)";

export interface FieldFrame {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface FieldIdentity {
  readonly role: string;
  readonly label: string;
  readonly frame: FieldFrame | null;
  readonly identifier?: string | null;
}

export interface FocusedProbe {
  readonly trusted: boolean;
  readonly role: string | null;
  readonly name: string | null;
  readonly secure: boolean;
  readonly frame: FieldFrame | null;
  readonly identifier?: string | null;
  readonly samePlace?: boolean | null;
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
}

export type FocusVerdict = "secure" | "plain" | "elsewhere" | "unknown";

const FRAME_SLACK_PIXELS = 4;
const LINUX_SECURE_ROLE = "password text";
const MAC_SECURE_SUBROLE = "AXSecureTextField";

function macFocusedScript(pid: number, point: ScreenPoint | null): string {
  const samePlace = point
    ? `(() => { const at = Ref(); return $.AXUIElementCopyElementAtPosition($.AXUIElementCreateSystemWide(), ${point.x}, ${point.y}, at) === 0 && $.CFEqual(focused, ObjC.castRefToObject(at[0])); })()`
    : "null";
  return `osascript -l JavaScript <<'BBBOXJXA'
ObjC.import("ApplicationServices");
function run() {
  if (!$.AXIsProcessTrusted()) return JSON.stringify({ trusted: false });
  const read = (element, name) => {
    const value = Ref();
    if ($.AXUIElementCopyAttributeValue(element, $(name), value) !== 0) return null;
    return ObjC.castRefToObject(value[0]);
  };
  const text = (element, name) => {
    const value = read(element, name);
    if (value === null) return null;
    const plain = ObjC.unwrap(value);
    return typeof plain === "string" ? plain : null;
  };
  const focused = read($.AXUIElementCreateApplication(${pid}), "AXFocusedUIElement");
  if (focused === null) return JSON.stringify({ trusted: true, role: null });
  return JSON.stringify({ trusted: true, role: text(focused, "AXRole"), name: text(focused, "AXTitle") || text(focused, "AXDescription"), secure: text(focused, "AXSubrole") === "${MAC_SECURE_SUBROLE}", frame: null, samePlace: ${samePlace} });
}
BBBOXJXA`;
}

function windowsFocusedScript(): string {
  return [
    "Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, WindowsBase",
    "$current = [System.Windows.Automation.AutomationElement]::FocusedElement.Current",
    "$box = $current.BoundingRectangle",
    "[pscustomobject]@{ trusted = $true; role = ($current.ControlType.ProgrammaticName -replace '^ControlType\\.', ''); name = $current.Name; secure = [bool]$current.IsPassword; frame = @([int]$box.X, [int]$box.Y, [int]$box.Width, [int]$box.Height); identifier = $current.AutomationId } | ConvertTo-Json -Compress",
  ].join("\n");
}

function linuxFocusedScript(pid: number): string {
  return `python3 - ${pid} <<'BBBOXPY'
import json, sys
from gi.repository import Gio, GLib
pid = int(sys.argv[1])
session = Gio.bus_get_sync(Gio.BusType.SESSION, None)
address = session.call_sync("org.a11y.Bus", "/org/a11y/bus", "org.a11y.Bus", "GetAddress", None, GLib.VariantType("(s)"), 0, 2000, None).unpack()[0]
bus = Gio.DBusConnection.new_for_address_sync(address, Gio.DBusConnectionFlags.AUTHENTICATION_CLIENT | Gio.DBusConnectionFlags.MESSAGE_BUS_CONNECTION, None, None)
def call(name, path, interface, method, args, reply):
    return bus.call_sync(name, path, interface, method, args, GLib.VariantType(reply), 0, 3000, None).unpack()
FOCUSED = 1 << 12
apps = call("org.a11y.atspi.Registry", "/org/a11y/atspi/accessible/root", "org.a11y.atspi.Accessible", "GetChildren", None, "(a(so))")[0]
found = []
for app in apps:
    try:
        owner = call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "GetConnectionUnixProcessID", GLib.Variant("(s)", (app[0],)), "(u)")[0]
    except Exception:
        continue
    if owner != pid:
        continue
    stack, seen = [(app, 0)], 0
    while stack and seen < 20000:
        node, depth = stack.pop()
        seen += 1
        try:
            state = call(node[0], node[1], "org.a11y.atspi.Accessible", "GetState", None, "(au)")[0]
            if state and state[0] & FOCUSED:
                found.append((depth, node))
            stack.extend((child, depth + 1) for child in call(node[0], node[1], "org.a11y.atspi.Accessible", "GetChildren", None, "(a(so))")[0])
        except Exception:
            pass
deepest = [node for depth, node in found if depth == max((each for each, _ in found), default=-1)]
if len(deepest) != 1:
    print(json.dumps({"trusted": True, "role": None}))
    sys.exit(0)
node = deepest[0]
role = call(node[0], node[1], "org.a11y.atspi.Accessible", "GetRoleName", None, "(s)")[0]
name = call(node[0], node[1], "org.freedesktop.DBus.Properties", "Get", GLib.Variant("(ss)", ("org.a11y.atspi.Accessible", "Name")), "(v)")[0]
try:
    frame = list(call(node[0], node[1], "org.a11y.atspi.Component", "GetExtents", GLib.Variant("(u)", (0,)), "((iiii))")[0])
except Exception:
    frame = None
print(json.dumps({"trusted": True, "role": role, "name": name, "secure": role == "${LINUX_SECURE_ROLE}", "frame": frame}))
BBBOXPY`;
}

export function focusedFieldScript(os: GuestOs, pid: number, point: ScreenPoint | null = null): string | null {
  if (os === "macos") return macFocusedScript(pid, point);
  if (os === "windows") return windowsFocusedScript();
  if (os === "linux") return linuxFocusedScript(pid);
  return null;
}

function frameOf(value: unknown): FieldFrame | null {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((part) => typeof part === "number")) return null;
  const [x, y, width, height] = value as number[];
  return { x: x!, y: y!, width: width!, height: height! };
}

export function parseFocusedProbe(stdout: string): FocusedProbe | null {
  const line = stdout.trim().split("\n").at(-1);
  if (!line) return null;
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const text = (value: unknown) => (typeof value === "string" ? value : null);
    const samePlace = typeof parsed.samePlace === "boolean" ? parsed.samePlace : null;
    return { trusted: parsed.trusted === true, role: text(parsed.role), name: text(parsed.name), secure: parsed.secure === true, frame: frameOf(parsed.frame), identifier: text(parsed.identifier) || null, samePlace };
  } catch {
    return null;
  }
}

function sameName(left: string | null, right: string): boolean {
  const plain = (text: string) => text.replace(/\s+/g, " ").trim();
  return left !== null && plain(left) === plain(right);
}

function sameFrame(left: FieldFrame, right: FieldFrame): boolean {
  return [left.x - right.x, left.y - right.y, left.width - right.width, left.height - right.height].every((gap) => Math.abs(gap) <= FRAME_SLACK_PIXELS);
}

export function focusVerdict(probe: FocusedProbe | null, target: FieldIdentity): FocusVerdict {
  if (!probe?.trusted) return "unknown";
  if (probe.role === null) return "elsewhere";
  if (!sameName(probe.name, target.label)) return "elsewhere";
  if (probe.frame && target.frame && !sameFrame(probe.frame, target.frame)) return "elsewhere";
  if (probe.identifier && target.identifier && probe.identifier !== target.identifier) return "elsewhere";
  if (probe.samePlace === false) return "elsewhere";
  if (probe.role !== target.role) return probe.secure ? "elsewhere" : "plain";
  return probe.secure ? "secure" : "plain";
}

const QUOTED_VALUE = /( = |value=)"(?:[^"\\]|\\.)*"/g;

export function withValueHidden(line: string): string {
  return line.replace(QUOTED_VALUE, `$1"${HIDDEN_VALUE}"`);
}
