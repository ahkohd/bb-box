// What the Tart backend runs on a Mac host, as POSIX sh scripts sent over
// SSH, and the parsers for what they print. Nothing is installed on the Mac
// but Tart: the scripts keep their state under ~/.bb-box/tart, readable by
// the host user only. Windows boxes' VMs are QEMU's, which qemu.ts drives
// (046); their owner files are here too.
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
// - run/<vm>.exit: `tart run`'s process ID and start time, then its exit
//   status and end time, which the shell that waits for it writes (#406),
//   so bb-box can say why a VM it did not stop has stopped.
// - run/<vm>.out.last and run/<vm>.exit.last: the same for the run before,
//   which a start keeps.

import { quote } from "../../transports/process.ts";
import type { StopReason } from "../types.ts";

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
# The guest OS in VM $1's config: darwin or linux (040).
os_of() {
  h=$HOME/.tart; [ -z "$TART_HOME" ] || h=$TART_HOME
  sed -n 's/.*"os" *: *"\([^"]*\)".*/\1/p' "$h/vms/$1/config.json" 2>/dev/null | head -n 1
}
# Waits up to $2 tenths of a second for VM $1 to leave the running state:
# tart suspend returns before the VM is saved.
settled() {
  i=0
  while [ "$(state "$1")" = running ] && [ "$i" -lt "$2" ]; do sleep 0.1; i=$((i + 1)); done
  [ "$(state "$1")" != running ]
}
# Keeps a VM's output file $1 and exit file $2 from its last run as
# <file>.last, and starts the output afresh.
keep() {
  [ ! -f "$1" ] || mv -f "$1" "$1.last"
  [ ! -f "$2" ] || mv -f "$2" "$2.last"
  : > "$1"
}
# Runs the rest of the arguments detached from the SSH session, so they
# outlive it, with their output added to file $1. A shell waits for the
# process and writes its ID and start time to file $2, then its exit status
# and end time (#406). Sets pid to its process ID; fails when it has none
# after 5 s.
detach() {
  _o=$1 _x=$2; shift 2
  rm -f "$_x"
  nohup /bin/sh -c 'o=$1 x=$2; shift 2
"$@" >>"$o" 2>&1 </dev/null &
printf "pid=%s\nstarted=%s\n" $! "$(date +%s)" > "$x.new" && mv -f "$x.new" "$x"
wait $!
s=$?
printf "status=%s\nended=%s\n" "$s" "$(date +%s)" >> "$x"' sh "$_o" "$_x" "$@" >/dev/null 2>&1 </dev/null &
  _i=0
  until pid=$(sed -n 's/^pid=//p' "$_x" 2>/dev/null) && [ -n "$pid" ]; do
    _i=$((_i + 1)); [ "$_i" -lt 50 ] || return 1
    sleep 0.1
  done
}
# How a run ended (#406): its exit file $2 from detach, when the Mac
# started, the last lines of its output file $1 without the VNC URL and its
# password, and macOS's crash report of program $3 for it, if any. A
# crash's report can take seconds to be written, so a run that ended on a
# signal that leaves one waits up to 10 s for it.
ended() {
  echo @exit; cat "$2" 2>/dev/null
  echo @boot; sysctl -n kern.boottime 2>/dev/null
  echo @output; grep -v 'vnc://' "$1" 2>/dev/null | tail -n 5
  _p=$(sed -n 's/^pid=//p' "$2" 2>/dev/null); _s=$(sed -n 's/^status=//p' "$2" 2>/dev/null)
  [ -n "$_p" ] || return 0
  _i=0
  while :; do
    for _f in "$HOME/Library/Logs/DiagnosticReports/$3"-*.ips "/Library/Logs/DiagnosticReports/$3"-*.ips; do
      [ -f "$_f" ] && [ "$_f" -nt "$1" ] && grep -q "\"pid\" : $_p," "$_f" || continue
      echo @crash-file; basename "$_f"
      echo @crash; cat "$_f"
      return 0
    done
    # SIGHUP, SIGINT, SIGKILL and SIGTERM leave no report.
    case "$_s" in 129 | 130 | 137 | 143) return 0 ;; esac
    [ -n "$_s" ] && [ "$_s" -gt 128 ] && [ "$_i" -lt 50 ] || return 0
    _i=$((_i + 1))
    sleep 0.2
  done
}
`;

/** Runs in /bin/sh, not the host user's login shell: on a Mac that is zsh, where a glob that matches nothing is an error. */
export function script(body: string): string {
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
 * space where Tart keeps its VMs. Tart's part only when `tart`, as a Mac
 * that runs only Windows boxes needs no Tart; `extra` adds QEMU's (qemu.ts).
 */
export function stateScript(tart = true, extra = ""): string {
  const tartPart = `command -v tart >/dev/null 2>&1 || { echo "tart is not installed, or not on the PATH of $(id -un)'s SSH sessions." >&2; exit 3; }
echo @version; tart --version
echo @list; tart list --source local --format json || exit 1
home="\${TART_HOME:-$HOME/.tart}"
echo @configs
for vm in $(ls "$home/vms" 2>/dev/null); do
  [ -f "$home/vms/$vm/config.json" ] || continue
  printf '=%s\\n' "$vm"; tr -d '\\n' < "$home/vms/$vm/config.json"; echo
done
echo @builds
for vm in $(ls "$home/vms" 2>/dev/null); do
  f="$home/vms/$vm/disk.img"
  # macOS's stat takes -f for a format; GNU's, which answers --version, takes -c.
  [ -f "$f" ] && printf '%s %s\\n' "$vm" "$(if stat --version >/dev/null 2>&1; then stat -c '%i.%Y' "$f"; else stat -f '%i.%m' "$f"; fi)"
done
`;
  return script(`${tart ? tartPart : 'home="${TART_HOME:-$HOME/.tart}"\n'}echo @owners
for vm in $(ls "$d/owners"); do [ -f "$d/owners/$vm" ] || continue; printf '=%s\\n' "$vm"; cat "$d/owners/$vm"; done
${extra}echo @memory; sysctl -n hw.memsize
echo @cpus; sysctl -n hw.ncpu
[ -d "$home" ] || home=$HOME
echo @disk; df -k "$home" | awk 'NR == 2 { print $2, $4 }'
echo @arch; uname -m
echo @macos; sw_vers -productVersion
echo @macosbuild; sw_vers -buildVersion
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
  /** The VM's network MAC address, as Tart keeps it. */
  readonly macAddress: string | null;
  readonly memoryMiB: number;
  readonly cpus: number;
}

export interface HostState {
  readonly version: string;
  readonly vms: readonly TartVm[];
  readonly configs: ReadonlyMap<string, VmConfig>;
  /**
   * Each VM's disk, as an ID that changes when the disk changes: its file's
   * inode and modification time. A clone or an image built again has a new
   * file, and an image run to change it a new time; a rename keeps both.
   */
  readonly builds: ReadonlyMap<string, string>;
  readonly owners: ReadonlyMap<string, Record<string, string>>;
  readonly memoryMiB: number;
  /** The Mac's cores, or 0 when it did not say. */
  readonly cpus: number;
  readonly disk: { readonly totalMiB: number; readonly freeMiB: number };
  readonly arch: string;
  readonly macos: string;
  /** The Mac's macOS build, such as 26A428: a VM saved under another may not restore. */
  readonly macosBuild: string;
}

/** Entries of a section made of `=name` lines, each followed by its text. */
export function named(text: string): Map<string, string> {
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
    const config = JSON.parse(json.trim()) as { os?: unknown; memorySize?: unknown; cpuCount?: unknown; macAddress?: unknown };
    return {
      os: typeof config.os === "string" ? config.os : null,
      macAddress: typeof config.macAddress === "string" ? config.macAddress : null,
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
  const builds = new Map<string, string>();
  for (const line of (parts.get("builds") ?? "").split("\n")) {
    const [name, build] = line.trim().split(/\s+/);
    if (name && build) builds.set(name, build);
  }
  const owners = new Map<string, Record<string, string>>();
  for (const [name, fields] of named(parts.get("owners") ?? "")) owners.set(name, parseFields(fields));
  const [total = 0, free = 0] = (parts.get("disk") ?? "").trim().split(/\s+/).map(Number);
  return {
    version: parts.get("version")?.trim() ?? "",
    vms,
    configs,
    builds,
    owners,
    memoryMiB: Math.floor(Number(parts.get("memory")?.trim() || 0) / 1024 / 1024),
    cpus: Number(parts.get("cpus")?.trim()) || 0,
    disk: { totalMiB: Math.floor(total / 1024), freeMiB: Math.floor(free / 1024) },
    arch: parts.get("arch")?.trim() ?? "",
    macos: parts.get("macos")?.trim() ?? "",
    macosBuild: parts.get("macosbuild")?.trim() ?? "",
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

/**
 * Suspends a warm VM bb-box has filled, once it is ready, and marks it warm.
 * Prints "warm", or "gone" when its owner file no longer says it is filling.
 */
export function warmScript(vm: string, installId: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
grep -qxF ${quote(`install=${installId}`)} "$f" 2>/dev/null && grep -qx 'state=filling' "$f" || { echo gone; exit 0; }
if [ "$(state "$vm")" = running ]; then tart suspend "$vm" || exit 1; fi
settled "$vm" 1200 || { echo "$vm is still running a minute after tart suspend." >&2; exit 1; }
[ "$(state "$vm")" = suspended ] || { echo "$vm did not suspend." >&2; exit 1; }
sed 's/^state=filling$/state=warm/' "$f" > "$f.new" && mv -f "$f.new" "$f"
echo warm
`);
}

/**
 * Hands a warm VM, or one being filled, to a box: rewrites its owner file
 * with the box's fields, only while the file still says it is in that state.
 * Prints "held", or the file that is there.
 */
export function holdScript(vm: string, installId: string, from: "warm" | "filling", owner: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
if grep -qxF ${quote(`install=${installId}`)} "$f" 2>/dev/null && grep -qxF ${quote(`state=${from}`)} "$f"; then
  printf '%s' ${quote(owner)} > "$f.new" && mv -f "$f.new" "$f" && echo held
else
  cat "$f" 2>/dev/null
fi
`);
}

/**
 * Gives a box's VM a new owner and name (036): rewrites its owner file, only
 * while the file names this install and the box. Prints "relabelled", or
 * the file that is there.
 */
export function relabelScript(vm: string, installId: string, boxId: string, owner: string): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
if mine "$vm" ${quote(installId)} ${quote(boxId)}; then
  printf '%s' ${quote(owner)} > "$f.new" && mv -f "$f.new" "$f" && echo relabelled
else
  cat "$f" 2>/dev/null
fi
`);
}

/**
 * The MAC address the Mac's ARP table has for a VM's address, after bb-box
 * has just reached it, and the one in the VM's config, in one trip.
 */
export function macScript(vm: string, address: string): string {
  return script(String.raw`home=$HOME/.tart; [ -z "$TART_HOME" ] || home=$TART_HOME
echo @arp; arp -n ${quote(address)} 2>/dev/null || :
echo @config; sed -n 's/.*"macAddress" *: *"\([^"]*\)".*/\1/p' "$home/vms/"${quote(vm)}"/config.json" 2>/dev/null | head -n 1
`);
}

/** The MAC address in `arp -n` output, or null. */
export function parseArp(text: string): string | null {
  return /\bat ([0-9a-f]{1,2}(?::[0-9a-f]{1,2}){5})\b/i.exec(text)?.[1] ?? null;
}

/** What macScript printed: the MAC address that answered, and the VM's own. */
export function parseMacs(text: string): { answered: string | null; expected: string | null } {
  const parts = sections(text);
  return { answered: parseArp(parts.get("arp") ?? ""), expected: parts.get("config")?.trim() || null };
}

/** A MAC address in one form, as arp drops leading zeros: lower case, two digits a byte. */
export function normalMac(mac: string): string {
  return mac
    .toLowerCase()
    .split(":")
    .map((byte) => byte.padStart(2, "0"))
    .join(":");
}

/** A VM's owner file as it is, or nothing. */
export function ownerScript(vm: string): string {
  return script(`cat "$d/owners/"${quote(vm)} 2>/dev/null || :\n`);
}

/** Drops a VM's saved state, so a VM whose state does not restore boots afresh from its disk. */
export function discardStateScript(vm: string): string {
  return script(String.raw`home=$HOME/.tart; [ -z "$TART_HOME" ] || home=$TART_HOME
rm -f "$home/vms/"${quote(vm)}"/state.vzvmsave"
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
 * until it has started. A macOS VM runs with Tart's VNC server and can be
 * suspended, and has started when the VNC server is up; a suspended one
 * resumes. A Linux VM runs with neither, since Tart cannot resume one (040),
 * and has started when Tart lists it running. Prints "running" or "started";
 * when Tart exits first, exits 3 with its output, such as the system's limit
 * on VMs. The last run's output and exit are kept.
 */
export function startScript(vm: string, waitSeconds: number): string {
  return script(String.raw`vm=${quote(vm)}; out="$d/run/$vm.out"; x="$d/run/$vm.exit"
case "$(state "$vm")" in
  running) echo running; exit 0 ;;
  "") echo "There is no VM $vm." >&2; exit 1 ;;
esac
keep "$out" "$x"
if [ "$(os_of "$vm")" = linux ]; then
  set -- tart run --no-graphics "$vm"
  up() { [ "$(state "$vm")" = running ]; }
else
  set -- tart run --no-graphics --vnc-experimental --suspendable "$vm"
  up() { grep -q 'VNC server is running' "$out"; }
fi
detach "$out" "$x" "$@" || { echo "tart run did not start for $vm." >&2; exit 1; }
i=0
while [ "$i" -lt ${waitSeconds * 10} ]; do
  if up; then echo started; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    up && { echo started; exit 0; }
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
 * How the VM's last run ended, when it names the box (#406), as `ended`
 * prints it. Prints "gone" when it is not there or not this box's.
 */
export function endedScript(vm: string, installId: string, boxId: string | null): string {
  return script(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
ended "$d/run/$vm.out" "$d/run/$vm.exit" tart
`);
}

/** How a VM's process ended, as `ended` printed it. Times are in ms since the epoch. */
export interface RunEnd {
  readonly pid: number | null;
  readonly startedAt: number | null;
  /** Its exit status as the shell gives it: 128 and the signal for one that ended on a signal. */
  readonly status: number | null;
  readonly endedAt: number | null;
  /** When the Mac started. */
  readonly bootedAt: number | null;
  /** Its last lines of output, on one line. */
  readonly output: string;
  /** macOS's crash report of it: the file's name, and what it says in words. */
  readonly crash: { readonly file: string; readonly summary: string | null } | null;
}

/** What `ended` printed, or null for "gone". */
export function parseEnded(text: string): RunEnd | null {
  if (text.trim() === "gone") return null;
  const parts = sections(text);
  const fields = parseFields(parts.get("exit") ?? "");
  const number = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value.trim()) ? Number(value.trim()) : null);
  const seconds = (value: string | undefined) => {
    const n = number(value);
    return n === null ? null : n * 1000;
  };
  const boot = /\bsec = (\d+)/.exec(parts.get("boot") ?? "");
  const file = parts.get("crash-file")?.trim();
  return {
    pid: number(fields.pid),
    startedAt: seconds(fields.started),
    status: number(fields.status),
    endedAt: seconds(fields.ended),
    bootedAt: boot ? Number(boot[1]) * 1000 : null,
    output: (parts.get("output") ?? "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .join(" / ")
      .slice(-300),
    crash: file ? { file, summary: crashSummary(parts.get("crash") ?? "") } : null,
  };
}

/** Frames that only trap or abort, which say nothing of where a crash came from. */
const TRAP_FRAME = /trap|abort|assert|raise|pthread_kill|__exception/i;

/**
 * What a macOS crash report (.ips) says in words: the exception, the
 * application-specific information, such as "assertion failed", and the
 * first frames of the thread that crashed beyond those that trap. An
 * Objective-C method is named as it is; another symbol is cut short.
 */
export function crashSummary(text: string): string | null {
  type Frame = { imageIndex?: number; symbol?: string };
  type Report = {
    exception?: { type?: string; signal?: string };
    asi?: Record<string, string[]>;
    faultingThread?: number;
    threads?: { frames?: Frame[] }[];
    usedImages?: { name?: string }[];
  };
  let report: Report;
  try {
    report = JSON.parse(text.slice(text.indexOf("\n") + 1)) as Report;
  } catch {
    return null;
  }
  const parts: string[] = [];
  const exception = report.exception;
  if (exception?.type) parts.push(exception.signal ? `${exception.type} (${exception.signal})` : exception.type);
  const asi = Object.values(report.asi ?? {}).flat();
  if (asi.length) parts.push(asi.join("; "));
  const frames = (report.threads?.[report.faultingThread ?? -1]?.frames ?? []).filter((frame) => frame.symbol && !TRAP_FRAME.test(frame.symbol));
  // The first frames in the library where it crashed, as the queue that called them says little.
  const ours = frames.filter((frame) => frame.imageIndex === frames[0]?.imageIndex);
  const names = [...new Set(ours.map((frame) => /[-+]\[[^\]]+\]/.exec(frame.symbol!)?.[0] ?? (frame.symbol!.length > 100 ? `${frame.symbol!.slice(0, 100)}...` : frame.symbol!)))].slice(0, 2);
  if (names.length) {
    const image = report.usedImages?.[frames[0]!.imageIndex ?? -1]?.name;
    parts.push(`in ${image ? `${image}'s ` : ""}${names.join(", called from ")}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/** The signals a VM's process may end on, as macOS names them. */
const SIGNALS: Readonly<Record<number, string>> = {
  1: "SIGHUP",
  2: "SIGINT",
  4: "SIGILL",
  5: "SIGTRAP",
  6: "SIGABRT",
  9: "SIGKILL",
  10: "SIGBUS",
  11: "SIGSEGV",
  15: "SIGTERM",
};

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/**
 * Why a VM's run ended, in words, and whether the guest did not choose it
 * (#406), from what `ended` printed for `program`, such as "tart run". Null
 * when the run left no record, as one started before bb-box kept them.
 */
export function endReason(end: RunEnd, program: string): StopReason | null {
  if (end.pid === null) return null;
  const at = end.endedAt;
  if (end.status === null) {
    if (end.bootedAt !== null && end.startedAt !== null && end.bootedAt > end.startedAt) {
      return { reason: `The Mac restarted at ${utc(end.bootedAt)}, which ended ${program}.`, crashed: true, at: end.bootedAt };
    }
    return { reason: `${program} ended, but left no exit status.`, crashed: false, at: null };
  }
  const output = end.output ? ` Its last output: ${end.output}` : "";
  if (end.status === 0) return { reason: `${program} exited with status 0: the guest shut itself down, or someone stopped the VM on the Mac.`, crashed: false, at };
  if (end.status <= 128) return { reason: `${program} exited with status ${end.status}.${output}`, crashed: true, at };
  const signal = end.status - 128;
  const crash = end.crash ? ` macOS's crash report ${end.crash.file}${end.crash.summary ? `: ${end.crash.summary}` : ""}.` : "";
  return { reason: `${program} ended on signal ${signal}${SIGNALS[signal] ? ` (${SIGNALS[signal]})` : ""}.${crash || output}`, crashed: true, at };
}

/**
 * Stops the VM when it names the box: suspends it, which keeps its memory on
 * disk and frees its slot, or stops it. "shutdown" waits up to a minute for
 * a VM shutting itself down (a Linux box's, which bb-box asked) before it
 * stops it. A Linux VM is never suspended, since Tart cannot resume one
 * (040). Prints "gone" when it is not there or not this box's.
 */
export function stopScript(vm: string, installId: string, boxId: string | null, how: "suspend" | "stop" | "shutdown"): string {
  return script(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
now=$(state "$vm"); [ -n "$now" ] || { echo gone; exit 0; }
if [ "$now" = running ]; then
  how=${how}; [ "$how" != suspend ] || [ "$(os_of "$vm")" != linux ] || how=stop
  case "$how" in
    suspend) tart suspend "$vm" || exit 1 ;;
    shutdown) settled "$vm" 600 || tart stop "$vm" --timeout 30 || exit 1 ;;
    *) tart stop "$vm" --timeout 30 || exit 1 ;;
  esac
  settled "$vm" 1200 || { echo "$vm is still running two minutes after tart $how." >&2; exit 1; }
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
rm -f "$d/run/$vm.out" "$d/run/$vm.out.last" "$d/run/$vm.exit" "$d/run/$vm.exit.last"
rm -f "$d/owners/$vm"
echo deleted
`);
}
