import type { IdentitySource } from "../backends/types.ts";
import type { CommandTransport } from "../transports/types.ts";
import { quote } from "../transports/process.ts";

export const IDENTITY_TOOL = "/usr/local/sbin/bb-box-identity";
export const IDENTITY_TOOL_MISSING = 64;
export const IDENTITY_VARIABLE = "BBBOX_IDENTITY";
export const MARKER_WRITE_MS = 20_000;
export const FORK_SAFE_PROBE_MS = 10_000;

const AS_ROOT = `as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }`;
const BOOT_CHECK_RAN = new Set(["kept", "unarmed", "reset"]);

export interface IdentityStatus {
  readonly version: number;
  readonly boot: string;
  readonly marker: string;
  readonly armed: boolean;
  readonly box: string;
  readonly source: string;
}

function withTool(run: string): string {
  return [`[ -x ${IDENTITY_TOOL} ] || exit ${IDENTITY_TOOL_MISSING}`, AS_ROOT, run].join("\n");
}

export function writeMarkerScript(boxId: string, source: IdentitySource): string {
  return withTool(`as_root ${IDENTITY_TOOL} write --box ${quote(boxId)} --source ${source}`);
}

export function identityStatusScript(): string {
  return withTool(`as_root ${IDENTITY_TOOL} status`);
}

export function parseIdentityStatus(stdout: string): IdentityStatus | null {
  const fields = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const version = Number(fields.get("version"));
  if (!Number.isInteger(version) || version < 1) return null;
  return {
    version,
    boot: fields.get("boot") ?? "none",
    marker: fields.get("marker") ?? "missing",
    armed: fields.get("armed") === "yes",
    box: fields.get("box") ?? "",
    source: fields.get("source") ?? "",
  };
}

export function forkSafeVersion(status: IdentityStatus | null): number | null {
  if (!status) return null;
  return BOOT_CHECK_RAN.has(status.boot) && status.marker === "matches" && status.armed ? status.version : null;
}

export async function readForkSafe(command: CommandTransport, signal?: AbortSignal): Promise<number | null> {
  const ran = await command.run(identityStatusScript(), { timeoutMs: FORK_SAFE_PROBE_MS, signal, maxOutputBytes: 4096 });
  return ran.exitCode === 0 ? forkSafeVersion(parseIdentityStatus(ran.stdout)) : null;
}

export type MarkerWritten = { readonly written: true } | { readonly written: false; readonly why: string };

export async function writeIdentityMarker(command: CommandTransport, boxId: string, source: IdentitySource, signal?: AbortSignal): Promise<MarkerWritten> {
  const ran = await command.run(writeMarkerScript(boxId, source), { timeoutMs: MARKER_WRITE_MS, signal, maxOutputBytes: 4096 });
  if (ran.exitCode === 0) return { written: true };
  if (ran.exitCode === IDENTITY_TOOL_MISSING) return { written: false, why: "its image has no identity reset" };
  const said = (ran.stderr.trim() || ran.stdout.trim()).split("\n").at(-1) ?? "";
  return { written: false, why: ran.timedOut ? `writing it took over ${MARKER_WRITE_MS / 1000} s` : `writing it exited with ${ran.exitCode}${said ? `: ${said}` : ""}` };
}
