// How bb-box talks to its helper on a pool machine, setup/ssh-pool/machine.sh,
// or machine-mac.sh on a Mac (047). The admin user runs it through sudo.
// Input and output are name=value lines, and the exit code says what happened.

import type { BoxIdentity } from "../types.ts";

/** Where setup.sh installs the helper, run as root through sudo. */
export const HELPER_COMMAND = "sudo -n /usr/local/libexec/bb-box/machine";
/** The helper version this bb-box speaks. A machine with an older one needs setup.sh again. */
export const HELPER_VERSION = 1;

export const EXIT = {
  ok: 0,
  failed: 1,
  usage: 2,
  /** Another box holds the machine. */
  held: 3,
  /** The marker names another install, box or generation, so release does nothing. */
  notOurs: 4,
  /** An earlier box left something behind, or setup is missing. */
  dirty: 5,
  /** The machine's reset generation moved on. */
  moved: 6,
  /** The whole-machine reset is still running: ask again. */
  restoring: 10,
} as const;

/** The owner or resetting marker on a machine. */
export interface Marker {
  readonly install: string;
  readonly box: string | null;
  readonly thread: string | null;
  readonly name: string | null;
  readonly kind: string | null;
  readonly createdAt: number | null;
  readonly generation: number | null;
  readonly user: string | null;
}

export interface MachineStatus {
  readonly helper: number | null;
  readonly arch: string;
  /** The boot ID, which changes when the machine restarts. */
  readonly boot: string;
  /** Resets completed, or null before setup. */
  readonly generation: number | null;
  readonly marker: "none" | "owner" | "resetting";
  /** The marker's fields, when there is one. */
  readonly owner: Marker | null;
  /** The operator's reset-machine command is installed. */
  readonly hook: boolean;
  readonly docker: boolean;
  readonly systemd: boolean;
  /** Online cores, memory in MiB and free disk under /home, or /Users on a Mac, in GiB, or null when the machine did not say. */
  readonly cores: number | null;
  readonly memoryMiB: number | null;
  readonly diskGiB: number | null;
  /** Tools the helper or enrolment needs that the machine lacks. */
  readonly missing: readonly string[];
  /** Node.js, npm, git and gh, or null when the helper is too old to say. */
  readonly enrolment: Enrolment | null;
  /** The first thing an earlier box left, or null when the machine is clean. */
  readonly dirty: string | null;
  /** What a Mac's helper adds, or null on Linux. */
  readonly mac: MacStatus | null;
}

/** A Mac's own status (047). */
export interface MacStatus {
  /** macOS's version, such as 26.0. */
  readonly version: string;
  /** The box user for this generation, once a reset has made it. */
  readonly user: string | null;
  /** Who is at the console: a box user, a person, or root at the login window. */
  readonly console: string | null;
  /** The user loginwindow signs in when it starts. */
  readonly autologin: string | null;
  /** FileVault is on, or the Mac did not say it is off. loginwindow then cannot sign a box user in. */
  readonly fileVault: boolean;
  readonly screenSharing: boolean;
  /** The helper has Full Disk Access, which the reset needs to remove a box's protected folders. */
  readonly fullDisk: boolean;
  /** Cua Driver's grants in the box user's session, given only by `status grants`. */
  readonly grants: CuaGrants | null;
  /**
   * Xcode and its Simulator runtimes. `status xcode` finds them again; plain
   * status gives the runtimes it last found. Null from a helper too old to say.
   */
  readonly xcode: Xcode | null;
}

/** The Xcode xcode-select chooses on a Mac (047). */
export interface Xcode {
  /** Its version, such as 26.0, or null when the Mac has no Xcode. */
  readonly version: string | null;
  /** The Simulator runtimes it can use, such as "iOS 26.0". */
  readonly runtimes: readonly string[];
}

/** Each grant, or null when no box user is at the console or Cua did not say. */
export interface CuaGrants {
  readonly accessibility: boolean | null;
  readonly screenRecording: boolean | null;
}

/** What BB's installer and a box's GitHub access need, beyond the helper's tools. */
export interface Enrolment {
  /** Node.js's version, such as 24.21.0, or null when the machine has no node. */
  readonly node: string | null;
  /** Those of npm, git and gh the machine lacks. */
  readonly lacks: readonly string[];
}

/** name=value lines as a map. A later line does not replace an earlier one. */
export function fields(text: string): Map<string, string> {
  const result = new Map<string, string>();
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    if (!result.has(key)) result.set(key, line.slice(at + 1).trim());
  }
  return result;
}

function whole(value: string | undefined): number | null {
  return value !== undefined && /^\d+$/.test(value) ? Number(value) : null;
}

function words(value: string | undefined): string[] {
  return (value ?? "").split(/\s+/).filter(Boolean);
}

/** A comma-separated list, whose items may have spaces. */
function listed(value: string | undefined): string[] {
  return (value ?? "").split(",").map((item) => item.trim()).filter(Boolean);
}

function granted(value: string | undefined): boolean | null {
  return value === "1" ? true : value === "0" ? false : null;
}

export function parseStatus(stdout: string): MachineStatus {
  const values = fields(stdout);
  const marker = values.get("marker");
  const kind = marker === "owner" || marker === "resetting" ? marker : "none";
  const field = (name: string) => values.get(`marker.${name}`) || null;
  return {
    helper: whole(values.get("helper")),
    arch: values.get("arch") ?? "",
    boot: values.get("boot") ?? "",
    generation: whole(values.get("generation")),
    marker: kind,
    owner:
      kind === "none"
        ? null
        : {
            install: field("install") ?? "",
            box: field("box"),
            thread: field("thread"),
            name: field("name"),
            kind: field("kind"),
            createdAt: whole(field("created") ?? undefined),
            generation: whole(field("generation") ?? undefined),
            user: field("user"),
          },
    hook: values.get("hook") === "1",
    docker: values.get("docker") === "1",
    systemd: values.get("systemd") === "1",
    cores: whole(values.get("cores")),
    memoryMiB: whole(values.get("memory")),
    diskGiB: whole(values.get("disk")),
    missing: words(values.get("missing")),
    enrolment: values.has("node") ? { node: values.get("node")?.replace(/^v/, "") || null, lacks: words(values.get("lacks")) } : null,
    dirty: values.get("dirty") || null,
    mac:
      values.get("os") === "macos"
        ? {
            version: values.get("macos") ?? "",
            user: values.get("user") || null,
            console: values.get("console") || null,
            autologin: values.get("autologin") || null,
            fileVault: values.get("filevault") !== "0",
            screenSharing: values.get("screensharing") === "1",
            fullDisk: values.get("fulldisk") === "1",
            grants: values.has("accessibility") ? { accessibility: granted(values.get("accessibility")), screenRecording: granted(values.get("screenrecording")) } : null,
            xcode: values.has("xcode") ? { version: values.get("xcode") || null, runtimes: listed(values.get("runtimes")) } : null,
          }
        : null,
  };
}

/**
 * The box user's name and password from a Mac's `machine display`, for
 * Screen Sharing, or null when the output has neither. The password goes
 * only into the display's sign-in, so nothing may quote this output.
 */
export function parseDisplay(stdout: string): { readonly user: string; readonly password: string } | null {
  const values = fields(stdout);
  const user = values.get("user") ?? "";
  const password = values.get("password") ?? "";
  return user && password ? { user, password } : null;
}

/** A value on one input line: the helper reads to the end of the line, so line breaks are dropped. */
function value(text: string): string {
  return text.replace(/[\r\n]+/g, " ");
}

/** The claim's input: the box's labels and the key its user accepts. */
export function claimInput(installId: string, box: BoxIdentity, publicKey: string): string {
  return [
    `install=${value(installId)}`,
    `box=${value(box.boxId)}`,
    `thread=${value(box.threadId)}`,
    `name=${value(box.name)}`,
    `kind=${value(box.kind)}`,
    `created=${Math.round(box.createdAt)}`,
    `key=${value(publicKey.trim())}`,
    "",
  ].join("\n");
}

/** A release's or reset's input. With no box, a release matches only a machine already resetting. */
export function releaseInput(installId: string, box: string | null): string {
  return [`install=${value(installId)}`, ...(box ? [`box=${value(box)}`] : []), ""].join("\n");
}
