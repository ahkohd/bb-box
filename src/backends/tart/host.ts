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
import { isSignallablePid } from "../../transports/spawns.ts";
import { recordFromJson, type ImageRecord } from "../images.ts";
import type { StopReason } from "../types.ts";
import { VNC_HOLDER_PY } from "./vnc-holder.ts";

/** Where `tart` may be on a Mac: Homebrew on Apple silicon and Intel, Nix. */
const PATHS = ["/opt/homebrew/bin", "/usr/local/bin", "$HOME/.nix-profile/bin", "/run/current-system/sw/bin", "/nix/var/nix/profiles/default/bin"];

/** The prefix of every VM bb-box clones for a box. */
export const VM_PREFIX = "bb-box-";

export function vmName(boxId: string): string {
  return `${VM_PREFIX}${boxId}`;
}

export const RUN_LOCK_HOLDERS_PL = String.raw`use Fcntl; my $darwin = $^O eq "darwin"; for my $f (@ARGV) { open(my $h, "<", $f) or next; my $l = $darwin ? pack("q q l s s", 0, 0, 0, F_RDLCK, 0) : pack("s s x4 q q l x4", F_RDLCK, 0, 0, 0, 0); fcntl($h, F_GETLK, $l) or next; my ($type, $pid) = $darwin ? (unpack("q q l s s", $l))[3, 2] : (unpack("s s x4 q q l x4", $l))[0, 4]; print "$pid $f\n" if $type != F_UNLCK }`;

export const TART_LISTS_SH = String.raw`tart_lists() {
  [ -f "$1/config.json" ] && [ -f "$1/nvram.bin" ] || return 1
  if [ -f "$1/disk.img" ]; then [ ! -f "$1/overlay.asif" ]; else [ -f "$1/manifest.json" ] && [ -f "$1/overlay.asif" ]; fi
}
`;

const VM_READ = String.raw`tart_vms=$HOME/.tart/vms; [ -z "$TART_HOME" ] || tart_vms=$TART_HOME/vms
if stat --version >/dev/null 2>&1; then stat_style=gnu; else stat_style=bsd; fi
stat_of() { if [ "$stat_style" = gnu ]; then stat -c "$1" "$3"; else stat -f "$2" "$3"; fi; }
run_lock_holders() { perl -e '${RUN_LOCK_HOLDERS_PL}' "$@"; }
${TART_LISTS_SH}state_of_folder() {
  tart_lists "$1" || return 0
  case "$2" in
    *" $1/config.json"*) _state=running ;;
    *) if [ -f "$1/state.vzvmsave" ]; then _state=suspended; else _state=stopped; fi ;;
  esac
  ! tart_lists "$1" || echo "$_state"
}
state() {
  _held=$(run_lock_holders "$tart_vms/$1/config.json") || return 1
  state_of_folder "$tart_vms/$1" "$_held"
}
disk_id() { stat_of '%i.%W' '%i.%B' "$1/disk.img" 2>/dev/null; }
disk_format() { sed -n 's/.*"diskFormat" *: *"\([^"]*\)".*/\1/p' "$1/config.json" 2>/dev/null | head -n 1; }
disk_gb() {
  [ -f "$1/disk.img" ] || return 0
  if [ "$(disk_format "$1")" = asif ]; then
    _id=$(disk_id "$1") && [ -n "$_id" ] && cat "$d/disks/$_id" 2>/dev/null
  else
    _bytes=$(stat_of %s %z "$1/disk.img" 2>/dev/null) && [ -n "$_bytes" ] && echo $((_bytes / 1000000000))
  fi
  return 0
}
disk_gb_tart_gives() { tart get "$1" --format json 2>/dev/null | sed -n 's/.*"Disk" *: *\([1-9][0-9]*\).*/\1/p' | head -n 1; }
note_disk_gb() {
  _id=$(disk_id "$1") && [ -n "$_id" ] && [ -n "$2" ] || return 0
  mkdir -p "$d/disks" && printf '%s\n' "$2" > "$d/disks/$_id.new" && mv -f "$d/disks/$_id.new" "$d/disks/$_id"
}`;

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
${VM_READ}
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
 * Tart's VMs and bb-box's QEMU files may be on another volume, through a
 * link (#632). When that volume is not mounted, the state fails, so the Mac
 * counts as unreachable and keeps its boxes, rather than as a Mac with none.
 */
const VOLUME_CHECK = String.raw`for f in "${"$"}{TART_HOME:-$HOME/.tart}" "$HOME/.bb-box/qemu"; do
  [ ! -L "$f" ] || [ -d "$f" ] || { echo "$f links to $(readlink "$f"), which is not there: is its volume mounted?" >&2; exit 1; }
done
`;

/**
 * Everything bb-box needs to know about a Mac at once: Tart's VMs, the owner
 * files, the configuration of each running VM, the host's memory and the free
 * space where Tart keeps its VMs. Tart's part only when `tart`, as a Mac
 * that runs only Windows boxes needs no Tart; `extra` adds QEMU's (qemu.ts).
 */
export function stateScript(tart = true, extra = ""): string {
  const tartPart = `command -v tart >/dev/null 2>&1 || { echo "tart is not installed, or not on the PATH of $(id -un)'s SSH sessions." >&2; exit 3; }
command -v perl >/dev/null 2>&1 || { echo "perl is not on the PATH of $(id -un)'s SSH sessions: bb-box reads Tart's run locks with it. macOS has it in /usr/bin." >&2; exit 3; }
echo @version; tart --version
home="\${TART_HOME:-$HOME/.tart}"
held=$(run_lock_holders "$tart_vms"/*/config.json) || exit 1
echo @vms
for vm in $(ls "$tart_vms" 2>/dev/null); do
  now=$(state_of_folder "$tart_vms/$vm" "$held")
  [ -z "$now" ] || printf '%s %s %s\\n' "$vm" "$now" "$(disk_gb "$tart_vms/$vm")"
done
echo @configs
for vm in $(ls "$home/vms" 2>/dev/null); do
  [ -f "$home/vms/$vm/config.json" ] || continue
  printf '=%s\\n' "$vm"; tr -d '\\n' < "$home/vms/$vm/config.json" 2>/dev/null; echo
done
echo @records
for f in "$d"/images/*.json; do [ -f "$f" ] || continue; n=\${f##*/}; printf '=%s\\n' "\${n%.json}"; tr -d '\\n' < "$f"; echo; done
echo @builds
for vm in $(ls "$home/vms" 2>/dev/null); do
  f="$home/vms/$vm/disk.img"
  [ -f "$f" ] && printf '%s %s\\n' "$vm" "$(stat_of '%i.%Y' '%i.%m' "$f")"
done
`;
  return script(`${VOLUME_CHECK}${tart ? tartPart : 'home="${TART_HOME:-$HOME/.tart}"\n'}echo @owners
for vm in $(ls "$d/owners"); do [ -f "$d/owners/$vm" ] || continue; printf '=%s\\n' "$vm"; cat "$d/owners/$vm"; done
${extra}echo @memory; sysctl -n hw.memsize
echo @cpus; sysctl -n hw.ncpu
echo @performance-cores; sysctl -n hw.perflevel0.physicalcpu 2>/dev/null
[ -d "$home" ] || home=$HOME
echo @disk; df -P -k "$home" | awk 'NR == 2 { m = $6; for (i = 7; i <= NF; i++) m = m " " $i; print $2, $4, m }'
echo @arch; uname -m
echo @macos; sw_vers -productVersion
echo @macosbuild; sw_vers -buildVersion
echo @chip; sysctl -n machdep.cpu.brand_string 2>/dev/null
`);
}

export interface TartVm {
  readonly name: string;
  /** "running", "suspended" or "stopped". */
  readonly state: string;
  readonly running: boolean;
  /** Its disk in decimal GB, as Tart gives it; null when bb-box has no note of an ASIF disk's. */
  readonly diskGB: number | null;
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
  /** Each image's record (049), from ~/.bb-box/tart/images/<image>.json, which the prepare scripts write. */
  readonly records: ReadonlyMap<string, ImageRecord>;
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
  readonly performanceCores: number | null;
  /** The free space where Tart keeps its VMs, and that volume's mount point. */
  readonly disk: { readonly totalMiB: number; readonly freeMiB: number; readonly volume: string };
  readonly arch: string;
  readonly macos: string;
  /** The Mac's macOS build, such as 26A428: a VM saved under another may not restore. */
  readonly macosBuild: string;
  readonly chip: string | null;
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
  const vms = (parts.get("vms") ?? "")
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([name, state]) => name && state)
    .map(([name, state, disk]) => ({
      name: name!,
      state: state!,
      running: state === "running",
      diskGB: Number(disk) > 0 ? Number(disk) : null,
    }));
  const configs = new Map<string, VmConfig>();
  for (const [name, json] of named(parts.get("configs") ?? "")) {
    const config = parseConfig(json);
    if (config) configs.set(name, config);
  }
  const records = new Map<string, ImageRecord>();
  for (const [name, json] of named(parts.get("records") ?? "")) {
    const record = recordFromJson(json.trim());
    if (record) records.set(name, record);
  }
  const builds = new Map<string, string>();
  for (const line of (parts.get("builds") ?? "").split("\n")) {
    const [name, build] = line.trim().split(/\s+/);
    if (name && build) builds.set(name, build);
  }
  const owners = new Map<string, Record<string, string>>();
  for (const [name, fields] of named(parts.get("owners") ?? "")) owners.set(name, parseFields(fields));
  const [total = "0", free = "0", ...volume] = (parts.get("disk") ?? "").trim().split(/\s+/);
  return {
    version: parts.get("version")?.trim() ?? "",
    vms,
    configs,
    records,
    builds,
    owners,
    memoryMiB: Math.floor(Number(parts.get("memory")?.trim() || 0) / 1024 / 1024),
    cpus: Number(parts.get("cpus")?.trim()) || 0,
    performanceCores: Number(parts.get("performance-cores")?.trim()) || null,
    disk: { totalMiB: Math.floor(Number(total) / 1024), freeMiB: Math.floor(Number(free) / 1024), volume: volume.join(" ") },
    arch: parts.get("arch")?.trim() ?? "",
    macos: parts.get("macos")?.trim() ?? "",
    macosBuild: parts.get("macosbuild")?.trim() ?? "",
    chip: parts.get("chip")?.trim() || null,
  };
}

/**
 * Starts `command`, a long build such as prepare-image.sh, in `cwd` under
 * the Mac user's home, detached from SSH (#707): its output goes to
 * `dir`/build.log and its pid, then its exit status, to `dir`/build.exit,
 * so the build outlives a link that drops. `prepare` runs first, in the
 * same shell, as to unpack the build's files. Prints "pid=<pid>".
 */
export function detachedBuildScript(dir: string, prepare: string, command: readonly string[]): string {
  return script(String.raw`${prepare} || exit 1
detach "$HOME/${dir}/build.log" "$HOME/${dir}/build.exit" ${command.map(quote).join(" ")} || { echo "The build did not start." >&2; exit 1; }
echo "pid=$pid"
`);
}

/**
 * What a detached build (detachedBuildScript) has done since byte `offset`
 * of its log: its exit status once it ended, the log's size, then up to
 * `max` bytes from `offset` in base64, so text cut mid-character survives.
 * The status is read before the size, so a status means the size is final.
 */
export function followBuildScript(dir: string, offset: number, max: number): string {
  return script(String.raw`x="$HOME/${dir}/build.exit"; f="$HOME/${dir}/build.log"
echo "@status=$(sed -n 's/^status=//p' "$x" 2>/dev/null)"
echo "@size=$(wc -c < "$f" 2>/dev/null | tr -d ' ')"
echo @log
tail -c +${offset + 1} "$f" 2>/dev/null | head -c ${max} | base64
`);
}

/** A detached build's progress, from followBuildScript. */
export function parseFollow(text: string): { status: number | null; size: number; bytes: Uint8Array } {
  const at = text.indexOf("@log\n");
  const head = at < 0 ? text : text.slice(0, at);
  const status = /^@status=(\d+)$/m.exec(head)?.[1];
  const size = Number(/^@size=(\d+)$/m.exec(head)?.[1] ?? 0);
  const bytes = at < 0 ? new Uint8Array() : new Uint8Array(Buffer.from(text.slice(at + 5).replace(/\s+/g, ""), "base64"));
  return { status: status === undefined ? null : Number(status), size, bytes };
}

/** Stops a detached build, pid `pid`, and what it started, if it still runs. */
export function stopBuildScript(pid: number): string {
  if (!isSignallablePid(pid)) return script("exit 0\n");
  return script(`kill -0 ${pid} 2>/dev/null || exit 0; pkill -TERM -P ${pid} 2>/dev/null; kill -TERM ${pid} 2>/dev/null; :\n`);
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
 * Suspends a warm VM bb-box has filled, once it is ready, and marks it warm,
 * and with `grants` notes that its fill made its grants with the Mac helper
 * of that hash (grants=<hash>, 058).
 * Prints "warm", or "gone" when its owner file no longer says it is filling.
 */
export function warmScript(vm: string, installId: string, grants: string | null = null): string {
  return script(String.raw`vm=${quote(vm)}; f="$d/owners/$vm"
grep -qxF ${quote(`install=${installId}`)} "$f" 2>/dev/null && grep -qx 'state=filling' "$f" || { echo gone; exit 0; }
if [ "$(state "$vm")" = running ]; then tart suspend "$vm" || exit 1; fi
settled "$vm" 1200 || { echo "$vm is still running a minute after tart suspend." >&2; exit 1; }
[ "$(state "$vm")" = suspended ] || { echo "$vm did not suspend." >&2; exit 1; }
{ sed 's/^state=filling$/state=warm/' "$f"${grants ? `; echo grants=${quote(grants)}` : ""}; echo "saved=$(date +%s)"; } > "$f.new" && mv -f "$f.new" "$f"
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

/**
 * Clones the image unless the VM is there, sizes it, and prints its config
 * after a line `@config`. An ASIF clone's disk is noted as the image's,
 * which `tart get` of the image gives once a build, as no VM runs on an
 * image's disk. Notes older than a day of disks no VM has are removed.
 */
export function cloneScript(image: string, vm: string, cpus: number, memoryMiB: number): string {
  return script(String.raw`vm=${quote(vm)}; image=${quote(image)}
tart_lists "$tart_vms/$vm" || tart clone "$image" "$vm" || exit 1
tart set "$vm" --cpu ${cpus} --memory ${memoryMiB} || exit 1
if [ "$(disk_format "$tart_vms/$vm")" = asif ] && [ -z "$(disk_gb "$tart_vms/$vm")" ]; then
  gb=$(disk_gb "$tart_vms/$image")
  if [ -z "$gb" ] && tart_lists "$tart_vms/$image"; then
    gb=$(disk_gb_tart_gives "$image")
    note_disk_gb "$tart_vms/$image" "$gb"
  fi
  note_disk_gb "$tart_vms/$vm" "$gb"
fi
if [ -d "$d/disks" ]; then
  ids=$(for v in "$tart_vms"/*; do [ ! -f "$v/disk.img" ] || disk_id "$v"; done)
  find "$d/disks" -type f -mtime +0 | while read -r n; do printf '%s\n' "$ids" | grep -qxF "$(basename "$n")" || rm -f "$n"; done
fi
echo @config; tr -d '\n' < "$tart_vms/$vm/config.json"; echo
`);
}

export const TART_RUN_AGAIN_SECONDS = 3;

/**
 * Starts the VM unless it runs, detached from the SSH session, and waits
 * until it has started. A macOS VM runs with Tart's VNC server and can be
 * suspended, and has started when the VNC server is up; a suspended one
 * resumes. A Linux VM runs with neither, since Tart cannot resume one (040),
 * and has started when its run holds Tart's run lock. Prints "running" or "started";
 * when Tart exits first, exits 3 with its output, such as the system's limit
 * on VMs. The last run's output and exit are kept. A macOS VM's VNC holder
 * starts with its run, so it makes the run's first and only connection to
 * Tart's VNC server (#406). A suspended VM's saved state is read through
 * once first: Virtualization reads it in small pieces, about 165 MB/s, so a
 * 4.4 GiB state not in the Mac's file cache took 27 s to restore, where a
 * read through takes 2 s, or 0.3 s when cached (#707).
 */
export function startScript(vm: string, waitSeconds: number): string {
  return script(String.raw`vm=${quote(vm)}; out="$d/run/$vm.out"; x="$d/run/$vm.exit"
${HOLD}
started() { [ "$(os_of "$vm")" = linux ] || hold || :; echo started; }
case "$(state "$vm")" in
  running) echo running; exit 0 ;;
  "") echo "There is no VM $vm." >&2; exit 1 ;;
esac
keep "$out" "$x"
# No clipboard shared with the Mac (#911): the Mac's is its owner's, and Universal Clipboard links it to their other Macs.
if [ "$(os_of "$vm")" = linux ]; then
  set -- tart run --no-graphics --no-clipboard "$vm"
  up() { [ -n "$(run_lock_holders "$tart_vms/$vm/config.json")" ]; }
else
  set -- tart run --no-graphics --no-clipboard --vnc-experimental --suspendable "$vm"
  up() { grep -q 'VNC server is running' "$out"; }
  h=$HOME/.tart; [ -z "$TART_HOME" ] || h=$TART_HOME
  [ ! -f "$h/vms/$vm/state.vzvmsave" ] || cat "$h/vms/$vm/state.vzvmsave" > /dev/null 2>&1 || :
fi
detach "$out" "$x" "$@" || { echo "tart run did not start for $vm." >&2; exit 1; }
i=0; again=1
while [ "$i" -lt ${waitSeconds * 10} ]; do
  if up; then started; exit 0; fi
  if ! kill -0 "$pid" 2>/dev/null; then
    up && { started; exit 0; }
    if [ "$again" = 1 ] && grep -q 'VZErrorDomain Code=1 ' "$out"; then
      again=0
      echo "ran-again: $(grep -m 1 'VZErrorDomain Code=1 ' "$out")"
      sleep ${TART_RUN_AGAIN_SECONDS}
      keep "$out" "$x"
      detach "$out" "$x" "$@" || { echo "tart run did not start for $vm." >&2; exit 1; }
      continue
    fi
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

/**
 * Defines `hold`, which starts the VM $vm's VNC holder (vnc-holder.ts) for
 * its current run unless one was started, and sets $run to the run's
 * directory, where the holder keeps its status. A run is known by Tart's VNC
 * port, which each run has anew, and only the first caller to make the run's
 * directory starts a holder, so a run has at most one, however often it is
 * asked. Returns 1 when Tart's VNC server is not running, and 2 when the
 * Mac has no python3, before it takes the run, so a later call tries again.
 */
const HOLD = String.raw`hold() {
  port=$(grep -o 'vnc://[^ ]*' "$d/run/$vm.out" 2>/dev/null | tail -n 1 | sed -n 's#.*:\([0-9][0-9]*\)/*$#\1#p')
  [ -n "$port" ] || return 1
  xcode-select -p >/dev/null 2>&1 || return 2
  run="$d/run/$vm.holder-$port"
  mkdir "$run" 2>/dev/null || return 0
  for old in "$d/run/$vm.holder-"*; do [ "$old" = "$run" ] || rm -rf "$old"; done
  cat > "$run/holder.py" <<'BBBOX_HOLDER'
${VNC_HOLDER_PY}BBBOX_HOLDER
  nohup /usr/bin/python3 "$run/holder.py" "$d/run/$vm.out" "$d/run/$vm.vnc" "$run/status" > "$run/log" 2>&1 < /dev/null &
}`;

/**
 * Starts the VM's VNC holder for its current run unless one was started, as
 * for a run that began before holders, and waits until it serves viewers:
 * prints "ready <width>x<height>". Exits 4 with the reason when the run's
 * holder has ended, 5 when the Mac has no python3, and 1 when Tart's VNC
 * server is not running.
 */
export function holderScript(vm: string): string {
  return script(String.raw`vm=${quote(vm)}
${HOLD}
hold
case $? in
  1) echo "Tart's VNC server for $vm is not running: the VM may be stopped." >&2; exit 1 ;;
  2) echo "The Mac has no python3 for bb-box's VNC holder: install Xcode's command line tools there (xcode-select --install)." >&2; exit 5 ;;
esac
i=0
while [ "$i" -lt 150 ]; do
  s=$(cat "$run/status" 2>/dev/null)
  case "$s" in
    ready*) echo "$s"; exit 0 ;;
    ended*) echo "$s" | sed 's/^ended //' >&2; exit 4 ;;
  esac
  sleep 0.1; i=$((i + 1))
done
echo "bb-box's VNC holder for $vm did not start within 15 s." >&2; tail -n 5 "$run/log" >&2; exit 1
`);
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

export function vmStateScript(vm: string): string {
  return script(String.raw`now=$(state ${quote(vm)}) || exit 1
[ -n "$now" ] || now=gone
echo "$now"
`);
}

export interface SpotlightView {
  readonly home: string;
  readonly homeFolder: string;
  readonly folder: string;
  readonly volume: string;
  readonly volumeIndexing: "enabled" | "disabled" | null;
  readonly listedVm: string | null;
}

export function spotlightScript(): string {
  return script(String.raw`home="${"$"}{TART_HOME:-$HOME/.tart}"
[ -d "$tart_vms" ] || exit 0
echo @home; echo "$home"
echo @home-folder; (cd "$home" && pwd -P)
folder=$(cd "$tart_vms" && pwd -P) || exit 1
echo @folder; echo "$folder"
volume=$(df -P "$folder" | awk 'NR == 2 { m = $6; for (i = 7; i <= NF; i++) m = m " " $i; print m }')
echo @volume; echo "$volume"
command -v mdutil >/dev/null 2>&1 && command -v mdfind >/dev/null 2>&1 || exit 0
echo @volume-indexing; mdutil -s "$volume" 2>/dev/null | tail -n 1
echo @listed; mdfind -onlyin "$folder" -name config.json 2>/dev/null | head -n 1
`);
}

export function parseSpotlight(text: string): SpotlightView | null {
  const parts = sections(text);
  const line = (name: string) => parts.get(name)?.trim() || null;
  const folder = line("folder");
  if (!folder || !parts.has("volume-indexing")) return null;
  const indexing = line("volume-indexing") ?? "";
  return {
    home: line("home") ?? folder,
    homeFolder: line("home-folder") ?? folder,
    folder,
    volume: line("volume") ?? "/",
    volumeIndexing: /Indexing enabled/.test(indexing) ? "enabled" : /Indexing disabled/.test(indexing) ? "disabled" : null,
    listedVm: line("listed"),
  };
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
 * Sizes a stopped VM, when its owner file names this install and box
 * (061): `tart set` its CPUs, memory and, when `diskGB` is given, its disk,
 * which Tart sizes in decimal GB and only grows. Prints the VM's config
 * after a line `@config` and its disk in GB after a line `@disk`, as the
 * Mac's state reads them; an ASIF disk Tart has just grown is noted as
 * `tart get` gives it. With no change asked, it only prints the size.
 * Prints "gone" when the VM is another box's, and refuses a VM that runs.
 */
export function sizeScript(vm: string, installId: string, boxId: string | null, change: { cpus: number; memoryMiB: number; diskGB: number | null } | null): string {
  const set = change ? `tart set "$vm" --cpu ${change.cpus} --memory ${change.memoryMiB}${change.diskGB !== null ? ` --disk-size ${change.diskGB}` : ""} || exit 1` : ":";
  const noteGrownDisk = change?.diskGB != null ? `[ "$(disk_format "$tart_vms/$vm")" != asif ] || note_disk_gb "$tart_vms/$vm" "$(disk_gb_tart_gives "$vm")"` : ":";
  return script(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
${change ? `[ "$(state "$vm")" != running ] || { echo "$vm runs, so Tart cannot size it." >&2; exit 1; }` : ":"}
${set}
${noteGrownDisk}
echo @config; tr -d '\n' < "$tart_vms/$vm/config.json"; echo
echo @disk; disk_gb "$tart_vms/$vm"
`);
}

/**
 * Deletes the VM when its owner file names this install and box, then its
 * run's output and, last, the owner file. Prints "gone" when the file names
 * another box, which leaves everything alone.
 */
/**
 * Captures an image box as a build (049): stops it, renames it, and writes
 * its record beside it, in images/<name>.json, and its owner file, which
 * names its image. Prints "captured".
 */
export function captureScript(vm: string, to: string, record: string, owner: string): string {
  return script(String.raw`vm=${quote(vm)}; to=${quote(to)}
if [ "$(state "$vm")" = running ]; then tart stop "$vm" --timeout 60 >/dev/null 2>&1; fi
settled "$vm" 600 || { echo "$vm is still running a minute after tart stop." >&2; exit 1; }
tart rename "$vm" "$to" || exit 1
mkdir -p "$d/images"
printf '%s
' ${quote(record)} > "$d/images/$to.json"
printf '%s' ${quote(owner)} > "$d/owners/$to"
rm -f "$d/owners/$vm" "$d/run/$vm.out" "$d/run/$vm.out.last" "$d/run/$vm.exit" "$d/run/$vm.exit.last"
echo captured
`);
}

/**
 * Puts a build in an image's place (049): the image is renamed aside, the
 * build takes its name, with its record and the prepare script's notes
 * beside it, and the old image goes. Boxes are copies on write and do not
 * need it. Should the build not take the name, the image gets its own back.
 * Prints "replaced".
 */
export function replaceScript(from: string, to: string): string {
  return script(String.raw`from=${quote(from)}; to=${quote(to)}; old="$to-replaced-$$"
[ "$(state "$from")" = stopped ] || { echo "$from is not a stopped VM." >&2; exit 1; }
if [ -n "$(state "$to")" ]; then tart rename "$to" "$old" || exit 1; fi
if ! tart rename "$from" "$to"; then
  [ -z "$(state "$old")" ] || tart rename "$old" "$to"
  exit 1
fi
mkdir -p "$d/images"
[ ! -f "$d/images/$from.json" ] || mv -f "$d/images/$from.json" "$d/images/$to.json"
[ ! -f "$d/images/$from" ] || mv -f "$d/images/$from" "$d/images/$to"
rm -f "$d/owners/$from"
[ -z "$(state "$old")" ] || tart delete "$old" || echo "$old could not be deleted." >&2
echo replaced
`);
}

/** String.raw for shell, where \${…} is the shell's own \${…}, not the template's. */
const sh = (strings: TemplateStringsArray, ...values: unknown[]) => String.raw(strings, ...values).replaceAll("\\${", "${");

/** Splits a registry reference, such as ghcr.io/cirruslabs/macos-golden-gate-xcode:27, into $reg, $repo, $tag and Tart's $cache directory for it. */
const BASE_PARTS = sh`reg=\${ref%%/*}; rest=\${ref#*/}
case $rest in *:*) repo=\${rest%:*}; tag=\${rest##*:} ;; *) repo=$rest; tag=latest ;; esac
cache=\${TART_HOME:-$HOME/.tart}/cache/OCIs/$reg/$repo`;

/**
 * Brings a refresh's base image up to date in Tart's cache (#475). A clone
 * from a registry reference takes Tart's cached copy, which a later push to
 * the tag leaves behind, so when the registry's digest for it is not the
 * cached one, it pulls it, if the disk has room for the image's disk beyond
 * \`reserveGiB\`. A local VM, a reference by digest, or a registry that does
 * not answer leaves the base as it is. Prints "base: …" lines; no room exits 3.
 */
export function baseScript(ref: string, reserveGiB: number): string {
  return script(sh`ref=${quote(ref)}; reserve=${reserveGiB}
case $ref in *@*) echo "base: $ref is pinned by digest"; exit 0 ;; */*) ;; *) echo "base: $ref is a local VM"; exit 0 ;; esac
${BASE_PARTS}
link=$(readlink "$cache/$tag" 2>/dev/null || true); old=\${link##*/}
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
# An anonymous pull token, from the realm the registry names, as ghcr.io gives one.
set --
realm=$(curl -sS -m 20 -o /dev/null -D - "https://$reg/v2/" 2>/dev/null | tr -d '\r' | sed -n 's/^[Ww][Ww][Ww]-[Aa]uthenticate: *Bearer realm="\([^"]*\)".*service="\([^"]*\)".*/\1?service=\2/p')
if [ -n "$realm" ]; then
  token=$(curl -fsS -m 20 "$realm&scope=repository:$repo:pull" 2>/dev/null | sed -n 's/.*"token" *: *"\([^"]*\)".*/\1/p')
  [ -z "$token" ] || set -- -H "Authorization: Bearer $token"
fi
if ! curl -fsS -m 30 -D "$tmp/headers" -o "$tmp/manifest" "$@" -H 'Accept: application/vnd.oci.image.manifest.v1+json' "https://$reg/v2/$repo/manifests/$tag" 2>/dev/null; then
  echo "base: $reg did not answer for $ref, so its cached copy is used"; exit 0
fi
new=$(tr -d '\r' <"$tmp/headers" | sed -n 's/^[Dd]ocker-[Cc]ontent-[Dd]igest: *//p' | tail -n 1)
[ -n "$new" ] || { echo "base: $reg gave no digest for $ref, so its cached copy is used"; exit 0; }
[ "$new" != "$old" ] || { echo "base: $ref is current"; exit 0; }
size=$(tr ',' '\n' <"$tmp/manifest" | sed -n 's/.*"org.cirruslabs.tart.uncompressed-disk-size" *: *"\([0-9]*\)".*/\1/p' | head -n 1)
free=$({ df -k "\${TART_HOME:-$HOME/.tart}" 2>/dev/null || df -k "$HOME"; } | awk 'NR == 2 { print $4 }')
free=\${free:-0}
if [ "$free" -lt $(( \${size:-0} / 1024 + reserve * 1048576 )) ]; then
  echo "base: no room to pull $ref: its disk is $(( \${size:-0} / 1073741824 )) GiB, and $(( free / 1048576 - reserve )) GiB is free beyond the $reserve GiB reserve." >&2
  exit 3
fi
echo "base: pulling $ref, $new\${old:+, in place of $old}"
tart pull "$ref" >"$tmp/pull" 2>&1 || { echo "base: tart pull $ref failed: $(tail -n 1 "$tmp/pull")" >&2; exit 1; }
echo "base: pulled $ref"
`);
}

/**
 * Removes the cached copies of a refresh's base that no tag names any more
 * (#475): after a pull moved the tag, the old copy only takes disk, as images
 * cloned from it are copies of their own. Prints "base: …" lines.
 */
export function pruneBaseScript(ref: string): string {
  return script(sh`ref=${quote(ref)}
case $ref in *@*) exit 0 ;; */*) ;; *) exit 0 ;; esac
${BASE_PARTS}
[ -d "$cache" ] || exit 0
named=$(for l in "$cache"/*; do [ -L "$l" ] && readlink "$l"; done | sed 's|.*/||')
for d in "$cache"/sha256:*; do
  [ -d "$d" ] || continue
  digest=\${d##*/}
  ! printf '%s\n' "$named" | grep -qx "$digest" || continue
  if tart delete "$reg/$repo@$digest" >/dev/null 2>&1; then echo "base: removed the old cached $reg/$repo@$digest"; else echo "base: could not remove $reg/$repo@$digest" >&2; fi
done
`);
}

/** Removes an image's notes beside it, images/<vm> and images/<vm>.json, once its VM has gone. */
export function forgetImageScript(vm: string): string {
  return script(String.raw`vm=${quote(vm)}
[ -n "$(state "$vm")" ] || rm -f "$d/images/$vm" "$d/images/$vm.json"
echo forgotten
`);
}

export function deleteScript(vm: string, installId: string, boxId: string | null): string {
  return script(String.raw`vm=${quote(vm)}
if [ -f "$d/owners/$vm" ] && ! mine "$vm" ${quote(installId)} ${quote(boxId ?? "")}; then echo gone; exit 0; fi
if [ -n "$(state "$vm")" ]; then
  tart stop "$vm" --timeout 0 >/dev/null 2>&1
  settled "$vm" 300 || exit 1
  tart delete "$vm" || exit 1
fi
rm -f "$d/run/$vm.out" "$d/run/$vm.out.last" "$d/run/$vm.exit" "$d/run/$vm.exit.last" "$d/run/$vm.vnc"
rm -rf "$d/run/$vm.holder-"*
rm -f "$d/owners/$vm"
echo deleted
`);
}
