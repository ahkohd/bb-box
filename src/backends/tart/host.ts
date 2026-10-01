// What the Tart backend runs on a Mac host, as POSIX sh scripts sent over
// SSH, and the parsers for what they print. Nothing is installed on the Mac
// but Tart: the scripts keep their state under ~/.bb-box/tart, readable by
// the host user only.
//
// - owners/<vm>: the owner file of each VM bb-box made. It names the install
//   and, from the claim on, the box, its thread, name, kind and creation time
//   (018, 019). It is written before the clone, with noclobber, so two
//   installs cannot claim one VM, and removed last on release, so a release
//   cut short leaves a VM that its install still finds.
// - run/<vm>.out: the output of `tart run`, which runs detached from the SSH
//   session that starts it, so the VM outlives the connection. launchd jobs
//   would load only while the host user is logged in at the Mac. The output
//   holds the URL of Tart's VNC server with its password, which changes on
//   every run; it is read each time a viewer opens the desktop.

import { quote } from "../../transports/process.ts";

/** Where `tart` may be on a Mac: Homebrew on Apple silicon and Intel, Nix. */
const PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "$HOME/.nix-profile/bin", "/run/current-system/sw/bin", "/nix/var/nix/profiles/default/bin"];

/** The prefix of every VM bb-box clones for a box. */
export const VM_PREFIX = "bb-box-";

export function vmName(boxId: string): string {
  return `${VM_PREFIX}${boxId}`;
}

/**
 * The start of every script: the PATH to find tart, no automatic pruning of
 * Tart's caches (a clone would otherwise delete the operator's other images
 * to make room), the state directories, and `mine`, which says whether a VM's
 * owner file names an install and a box, or no box when the box is empty.
 */
const PRELUDE = String.raw`export PATH="${PATHS.join(":")}:$PATH" TART_NO_AUTO_PRUNE=1
d="$HOME/.bb-box/tart"
umask 077
mkdir -p "$d/owners" "$d/run" || exit 1
mine() {
  [ -f "$d/owners/$1" ] && grep -qxF "install=$2" "$d/owners/$1" || return 1
  if [ -n "$3" ]; then grep -qxF "box=$3" "$d/owners/$1"; else ! grep -q '^box=' "$d/owners/$1"; fi
}
state() {
  tart list --source local | awk -v n="$1" '$2 == n { print $NF }'
}
# Waits up to $2 tenths of a second for VM $1 to leave the running state:
# tart suspend returns before the VM is saved.
settled() {
  i=0
  while [ "$(state "$1")" = running ] && [ "$i" -lt "$2" ]; do sleep 0.1; i=$((i + 1)); done
  [ "$(state "$1")" != running ]
}
`;

/** Runs in /bin/sh, not the host user's login shell: on a Mac that is zsh, where a glob that matches nothing is an error. */
function script(body: string): string {
  return `exec /bin/sh -c ${quote(`${PRELUDE}${body}`)}`;
}

/** Lines of `key=value`, as owner files hold them. */
export function ownerText(fields: Readonly<Record<string, string | number>>): string {
  return Object.entries(fields)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")
    .concat("\n");
}

export function parseFields(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1);
  }
  return fields;
}

/** Splits output into the sections a script marked with lines of `@name`. */
export function sections(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    if (/^@[a-z-]+$/.test(line)) {
      if (name) result.set(name, lines.join("\n"));
      name = line.slice(1);
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (name) result.set(name, lines.join("\n"));
  return result;
}

/**
 * Everything bb-box needs to know about a Mac at once: Tart's VMs, the owner
 * files, the configuration of each running VM, the host's memory and the free
 * space where Tart keeps its VMs.
 */
export function stateScript(): string {
  return script(`command -v tart >/dev/null 2>&1 || { echo "tart is not installed, or not on the PATH of $(id -un)'s SSH sessions." >&2; exit 3; }
echo @version; tart --version
echo @list; tart list --source local --format json || exit 1
home="\${TART_HOME:-$HOME/.tart}"
echo @configs
for vm in $(ls "$home/vms" 2>/dev/null); do
  [ -f "$home/vms/$vm/config.json" ] || continue
  printf '=%s\\n' "$vm"; tr -d '\\n' < "$home/vms/$vm/config.json"; echo
done
echo @owners
for vm in $(ls "$d/owners"); do [ -f "$d/owners/$vm" ] || continue; printf '=%s\\n' "$vm"; cat "$d/owners/$vm"; done
echo @memory; sysctl -n hw.memsize
echo @cpus; sysctl -n hw.ncpu
[ -d "$home" ] || home=$HOME
echo @disk; df -k "$home" | awk 'NR == 2 { print $2, $4 }'
echo @arch; uname -m
echo @macos; sw_vers -productVersion
`);
}

export interface TartVm {
  readonly name: string;
  /** "running", "suspended" or "stopped". */
  readonly state: string;
  readonly running: boolean;
}

export interface VmConfig {
  readonly os: string | null;
  readonly memoryMiB: number;
  readonly cpus: number;
}

export interface HostState {
  readonly version: string;
  readonly vms: readonly TartVm[];
  readonly configs: ReadonlyMap<string, VmConfig>;
  readonly owners: ReadonlyMap<string, Record<string, string>>;
  readonly memoryMiB: number;
  /** The Mac's cores, or 0 when it did not say. */
  readonly cpus: number;
  readonly disk: { readonly totalMiB: number; readonly freeMiB: number };
  readonly arch: string;
  readonly macos: string;
}

/** Entries of a section made of `=name` lines, each followed by its text. */
function named(text: string): Map<string, string> {
  const result = new Map<string, string>();
  let name: string | null = null;
  let lines: string[] = [];
  for (const line of text.split("\n")) {
    if (line.startsWith("=")) {
      if (name) result.set(name, lines.join("\n"));
      name = line.slice(1);
      lines = [];
    } else {
      lines.push(line);
    }
  }
  if (name) result.set(name, lines.join("\n"));
  return result;
}

/** A VM's config.json, or the part after a line `@config`; null when it is not whole. */
export function parseConfig(text: string): VmConfig | null {
  const json = text.includes("@config") ? (sections(text).get("config") ?? "") : text;
  try {
    const config = JSON.parse(json.trim()) as { os?: unknown; memorySize?: unknown; cpuCount?: unknown };
    return {
      os: typeof config.os === "string" ? config.os : null,
      memoryMiB: typeof config.memorySize === "number" ? Math.round(config.memorySize / 1024 / 1024) : 0,
      cpus: typeof config.cpuCount === "number" ? config.cpuCount : 0,
    };
  } catch {
    return null;
  }
}

export function parseState(text: string): HostState {
  const parts = sections(text);
  const list = JSON.parse(parts.get("list")?.trim() || "[]") as { Name?: unknown; State?: unknown; Running?: unknown }[];
  const vms = list
    .filter((vm) => typeof vm.Name === "string")
    .map((vm) => ({
      name: String(vm.Name),
      state: typeof vm.State === "string" ? vm.State : vm.Running ? "running" : "stopped",
      running: vm.Running === true,
    }));
  const configs = new Map<string, VmConfig>();
  for (const [name, json] of named(parts.get("configs") ?? "")) {
    // A VM being written has no whole config yet; it is counted by `tart list` alone.
    const config = parseConfig(json);
    if (config) configs.set(name, config);
  }
  const owners = new Map<string, Record<string, string>>();
  for (const [name, fields] of named(parts.get("owners") ?? "")) owners.set(name, parseFields(fields));
  const [total = 0, free = 0] = (parts.get("disk") ?? "").trim().split(/\s+/).map(Number);
  return {
    version: parts.get("version")?.trim() ?? "",
    vms,
    configs,
    owners,
    memoryMiB: Math.floor(Number(parts.get("memory")?.trim() || 0) / 1024 / 1024),
    cpus: Number(parts.get("cpus")?.trim()) || 0,
    disk: { totalMiB: Math.floor(total / 1024), freeMiB: Math.floor(free / 1024) },
    arch: parts.get("arch")?.trim() ?? "",
    macos: parts.get("macos")?.trim() ?? "",
  };
}

/**
 * Writes the VM's owner file unless one is there. Prints "claimed" when it
 * wrote it, or the file that is there.
 */
export function claimScript(vm: string, owner: string): string {
  return script(String.raw`f="$d/owners/"${quote(vm)}
if (set -C; printf '%s' ${quote(owner)} > "$f") 2>/dev/null; then echo claimed; else cat "$f"; fi
`);
}

/** Clones the image unless the VM is there, sizes it, and prints its config after a line `@config`. */
export function cloneScript(image: string, vm: string, cpus: number, memoryMiB: number): string {
  return script(String.raw`vm=${quote(vm)}
tart list --source local --quiet | grep -qxF "$vm" || tart clone ${quote(image)} "$vm" || exit 1
tart set "$vm" --cpu ${cpus} --memory ${memoryMiB} || exit 1
home=$HOME/.tart; [ -z "$TART_HOME" ] || home=$TART_HOME
echo @config; tr -d '\n' < "$home/vms/$vm/config.json"; echo
`);
}

/**
 * Starts the VM unless it runs, detached from the SSH session, and waits
 * until Tart's VNC server is up, which is when the VM has started. A
 * suspended VM resumes. Prints "running" or "started"; when Tart exits
 * first, exits 3 with its output, such as the system's limit on VMs.
 */
export function startScript(vm: string, waitSeconds: number): string {
  return script(String.raw`vm=${quote(vm)}; out="$d/run/$vm.out"
case "$(state "$vm")" in
  running) echo running; exit 0 ;;
  "") echo "There is no VM $vm." >&2; exit 1 ;;
esac
: > "$out"
nohup tart run --no-graphics --vnc-experimental --suspendable "$vm" >>"$out" 2>&1 </dev/null &
pid=$!
i=0
while [ "$i" -lt ${waitSeconds * 10} ]; do
  if grep -q 'VNC server is running' "$out"; then echo started; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    grep -q 'VNC server is running' "$out" && { echo started; exit 0; }
    cat "$out" >&2; exit 3
  fi
  sleep 0.1; i=$((i + 1))
done
echo "Tart did not start $vm within ${waitSeconds} s." >&2; cat "$out" >&2; exit 1
`);
}

/** The VM's address on the Mac's NAT, waiting up to `waitSeconds` for its DHCP lease. */
export function ipScript(vm: string, waitSeconds: number): string {
  return script(`tart ip ${quote(vm)} --wait ${waitSeconds}\n`);
}

/** The URL of Tart's VNC server for the VM's current run, with its password. */
export function vncScript(vm: string): string {
  return script(`grep -o 'vnc://[^ ]*' "$d/run/"${quote(vm)}.out | tail -n 1\n`);
}

export function parseVnc(text: string): { port: number; password: string } | null {
  const match = /^vnc:\/\/:([^@\s]*)@127\.0\.0\.1:(\d+)\/?$/m.exec(text.trim());
  if (!match) return null;
  return { password: decodeURIComponent(match[1]!), port: Number(match[2]) };
}

/** The VM's state as Tart lists it, or "gone" when it is not there or not this box's. */
export function powerScript(vm: string, installId: string, boxId: string | null): string {
  return script(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
state "$vm" | grep . || echo gone
`);
}

/**
 * Stops the VM when it names the box: suspends it, which keeps its memory on
 * disk and frees its slot, or shuts it down. Prints "gone" when it is not
 * there or not this box's.
 */
export function stopScript(vm: string, installId: string, boxId: string | null, how: "suspend" | "stop"): string {
  return script(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
now=$(state "$vm"); [ -n "$now" ] || { echo gone; exit 0; }
if [ "$now" = running ]; then
  ${how === "suspend" ? `tart suspend "$vm"` : `tart stop "$vm" --timeout 30`} || exit 1
  settled "$vm" 1200 || { echo "$vm is still running a minute after tart ${how}." >&2; exit 1; }
fi
echo stopped
`);
}

/**
 * Deletes the VM when its owner file names this install and box, then its
 * run's output and, last, the owner file. Prints "gone" when the file names
 * another box, which leaves everything alone.
 */
export function deleteScript(vm: string, installId: string, boxId: string | null): string {
  return script(String.raw`vm=${quote(vm)}
if [ -f "$d/owners/$vm" ] && ! mine "$vm" ${quote(installId)} ${quote(boxId ?? "")}; then echo gone; exit 0; fi
if [ -n "$(state "$vm")" ]; then
  tart stop "$vm" --timeout 0 >/dev/null 2>&1
  settled "$vm" 300 || exit 1
  tart delete "$vm" || exit 1
fi
rm -f "$d/run/$vm.out"
rm -f "$d/owners/$vm"
echo deleted
`);
}
