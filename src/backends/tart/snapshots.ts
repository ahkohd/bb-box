import { quote } from "../../transports/process.ts";
import { PRODUCT } from "../../brand.ts";
import { NO_PAUSE, type BoxOwner, type Guest, type HeldSnapshot, type HeldSnapshotState, type Holds, type MachineSize, type SnapshotPlan, type SnapshotStorage, type Snapshotting, type TakePause, type TaskOutcome } from "../types.ts";
import { IOS_IMAGE_KIND } from "./config.ts";
import { named, parseConfig, parseFields, script, sections, type VmConfig } from "./host.ts";

export const SNAPSHOTS_FOLDER = "bb-box-snapshots";
export const MACOS_FORK_SAFE_FROM = 3;
export const LINUX_FORK_SAFE_FROM = 8;
export const LINUX_FORK_KINDS: readonly string[] = ["linux-arm64", "linux-arm64-desktop-cpu"];
export const TART_EXCLUDES = "the VM's network address, which the Mac's DHCP gives again";
export const LINUX_NO_FORKS = "this Linux kind has no supported identity reset";
export const WINDOWS_NO_FORKS = `Windows has no identity reset in ${PRODUCT}, so a fork or a kept copy would come up as its source, with its computer name, its machine identity and its BB machine`;
export const WINDOWS_EXCLUDES = "Windows' memory and the apps open in it: Windows shuts down for the copy, and a restore starts it afresh";
export const MIN_FREE_GIB = 20;
export const NO_IMAGE_ATTACH = `the Mac's diskutil has no image attach, which ${PRODUCT} needs to clean a fork's disk of its source's identity before the fork first boots, and which macOS 27 has. So ${PRODUCT} makes no macOS forks on it, and keeps no macOS snapshot past its box's release`;
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const DAY_MS = 24 * 60 * 60_000;
const SUSPEND_MS_PER_GIB = 450;
const RESUME_MS = 11_000;
const COPY_MS = 1_000;
const MACOS_BOOT_MS = 90_000;
const LINUX_BOOT_MS = 40_000;
const LINUX_SHUTDOWN_MS = 20_000;

export type VmEngine = "tart" | "qemu";

export type TartTask = { readonly kind: "take" | "delete"; readonly id: string } | { readonly kind: "rollback"; readonly vm: string; readonly id: string; readonly attempt: string; readonly engine?: VmEngine };

export function taskRef(task: TartTask): string {
  return task.kind === "rollback" ? `${task.engine ?? "tart"}-rollback:${task.vm}:${task.id}:${task.attempt}` : `tart-${task.kind}:${task.id}`;
}

export function parseTaskRef(ref: string): TartTask | null {
  const rollback = /^(tart|qemu)-rollback:([A-Za-z0-9._-]+):(sn[a-z2-7]{12}):([a-z0-9]{8,32})$/.exec(ref);
  if (rollback) return { kind: "rollback", vm: rollback[2]!, id: rollback[3]!, attempt: rollback[4]!, ...(rollback[1] === "qemu" ? { engine: "qemu" as const } : {}) };
  const other = /^tart-(take|delete):(sn[a-z2-7]{12})$/.exec(ref);
  return other ? { kind: other[1] as "take" | "delete", id: other[2]! } : null;
}

export type SnapshotOs = "macos" | "linux" | "windows";

export function tartOffer(os: SnapshotOs, forks = true): Snapshotting {
  if (os === "windows") {
    return {
      scope: "box",
      holds: ["disk"],
      whileRunning: "stopped-only",
      restore: "in-place",
      fork: "none",
      keepsPastRelease: "no",
      lives: "host",
      outlivesGuest: true,
      price: null,
      excludes: WINDOWS_EXCLUDES,
      forkWhy: WINDOWS_NO_FORKS,
    };
  }
  if (os === "linux" && forks) {
    return {
      scope: "box",
      holds: ["disk"],
      whileRunning: "stopped-only",
      restore: "in-place",
      fork: "copy",
      keepsPastRelease: "as-is",
      lives: "host",
      outlivesGuest: true,
      price: null,
      excludes: TART_EXCLUDES,
      forkSafeFrom: LINUX_FORK_SAFE_FROM,
    };
  }
  return os === "macos"
    ? {
        scope: "box",
        holds: ["disk-and-memory"],
        whileRunning: "suspends",
        restore: "in-place",
        fork: "copy",
        keepsPastRelease: "as-is",
        lives: "host",
        outlivesGuest: true,
        price: null,
        excludes: TART_EXCLUDES,
        forkSafeFrom: MACOS_FORK_SAFE_FROM,
      }
    : {
        scope: "box",
        holds: ["disk"],
        whileRunning: "stopped-only",
        restore: "in-place",
        fork: "none",
        keepsPastRelease: "no",
        lives: "host",
        outlivesGuest: true,
        price: null,
        excludes: TART_EXCLUDES,
        forkWhy: LINUX_NO_FORKS,
      };
}

export interface SnapshotLabel {
  readonly install: string;
  readonly box: string;
  readonly vm: string;
  readonly snapshot: string;
  readonly takenAt: number | null;
  readonly holds: Holds;
  readonly os: "darwin" | "linux" | "windows";
  readonly macosBuild: string | null;
  readonly tart: string | null;
  readonly reset: number | null;
  readonly kept: string | null;
  readonly kind: string | null;
  readonly diskGB: number | null;
  readonly image?: string | null;
  readonly build?: string | null;
}

export function labelText(label: SnapshotLabel): string {
  const lines: [string, string | number | null][] = [
    ["install", label.install],
    ["box", label.box],
    ["vm", label.vm],
    ["snapshot", label.snapshot],
    ["taken", label.takenAt === null ? null : Math.round(label.takenAt / 1000)],
    ["holds", label.holds],
    ["os", label.os],
    ["macos", label.macosBuild],
    ["tart", label.tart],
    ["reset", label.reset],
    ["kept", label.kept],
    ["kind", label.kind],
    ["diskgb", label.diskGB],
    ["image", label.image ?? null],
    ["build", label.build ?? null],
  ];
  return lines.flatMap(([key, value]) => (value === null || value === "" ? [] : [`${key}=${value}`])).join("\n") + "\n";
}

export function parseLabel(text: string): SnapshotLabel | null {
  const fields = parseFields(text);
  const number = (value: string | undefined) => (value !== undefined && /^\d+$/.test(value) ? Number(value) : null);
  if (!fields.install || !fields.box || !fields.vm || !/^sn[a-z2-7]{12}$/.test(fields.snapshot ?? "")) return null;
  const kept = fields.kept && /^\d{4}-\d{2}-\d{2}$/.test(fields.kept) ? fields.kept : null;
  const taken = number(fields.taken);
  return {
    install: fields.install,
    box: fields.box,
    vm: fields.vm,
    snapshot: fields.snapshot!,
    takenAt: taken === null ? null : taken * 1000,
    holds: fields.holds === "disk-and-memory" ? "disk-and-memory" : "disk",
    os: fields.os === "linux" || fields.os === "windows" ? fields.os : "darwin",
    macosBuild: fields.macos || null,
    tart: fields.tart || null,
    reset: number(fields.reset),
    kept,
    kind: fields.kind || null,
    diskGB: number(fields.diskgb),
    image: fields.image || null,
    build: fields.build || null,
  };
}

export function keptUntilOf(date: string | null): number | null {
  if (!date) return null;
  const start = Date.parse(`${date}T00:00:00Z`);
  return Number.isNaN(start) ? null : start + DAY_MS - 1;
}

export const SNAPSHOT_SH = String.raw`snaps_root() {
  _v=$(cd "$tart_vms" 2>/dev/null && pwd -P) || { echo "Tart has no VMs folder at $tart_vms." >&2; return 1; }
  printf '%s/${SNAPSHOTS_FOLDER}\n' "$(dirname "$_v")"
}
device_of() { stat_of %d %d "$1/." 2>/dev/null; }
same_volume() { _a=$(device_of "$1") && _b=$(device_of "$2") && [ -n "$_a" ] && [ "$_a" = "$_b" ]; }
volume_of() { df -P -k "$1/." 2>/dev/null | awk 'NR == 2 { m = $6; for (i = 7; i <= NF; i++) m = m " " $i; print m }'; }
free_gib() { df -P -k "$1/." 2>/dev/null | awk 'NR == 2 { print int($4 / 1048576) }'; }
clone_copy() {
  python3 -c 'import ctypes, os, sys
libc = ctypes.CDLL(None, use_errno=True)
if libc.clonefile(os.fsencode(sys.argv[1]), os.fsencode(sys.argv[2]), 0) != 0:
    sys.exit("clonefile: " + os.strerror(ctypes.get_errno()))' "$1" "$2" && return 0
  rm -f "$2"
  echo "APFS could not clone $1 here, and BB Box makes no full copy of a VM, which would take its whole size from the disk kept free." >&2
  return 1
}
copy_vm_files() {
  _from=$1 _to=$2 _skip=$3
  mkdir -p "$_to" || return 1
  for _f in "$_from"/*; do
    [ -f "$_f" ] || continue
    [ "${"$"}{_f##*/}" != "$_skip" ] || continue
    clone_copy "$_f" "$_to/${"$"}{_f##*/}" || return 1
  done
}
label_of() { sed -n "s/^$2=//p" "$1/label" 2>/dev/null | head -n 1; }
ours() { [ -f "$1/label" ] && grep -qxF "install=$2" "$1/label"; }
room_for_copy() {
  _free=$(free_gib "$1")
  [ "${"$"}{_free:-0}" -ge "$2" ] && return 0
  echo "The VMs' volume $(volume_of "$1") has ${"$"}{_free:-0} GiB free, and BB Box copies a VM there only with at least $2 GiB free, as the copy grows as the VM changes." >&2
  return 1
}
other_volume() {
  echo "$1 is on another volume than the VMs, so a copy there would be a full copy. Move it to the VMs' volume, $(volume_of "$2")." >&2
}
can_attach() { diskutil image attach --help >/dev/null 2>&1; }
container_of() { diskutil info "$1" 2>/dev/null | awk -F: '/APFS Container/ { gsub(/ /, "", $2); print $2; exit }'; }
scrub_disk() {
  _img=$1 _mac=$(container_of /) _dev= _mnt=
  can_attach || { echo "${NO_IMAGE_ATTACH.charAt(0).toUpperCase()}${NO_IMAGE_ATTACH.slice(1)}." >&2; return 1; }
  [ -n "$_mac" ] || { echo "BB Box could not read the Mac's own APFS container, so it does not attach the fork's disk." >&2; return 1; }
  _out=$(diskutil image attach --noMount "$_img" 2>&1) || { echo "diskutil could not attach the fork's disk: $(printf '%s' "$_out" | tail -n 1)" >&2; return 1; }
  _dev=$(printf '%s\n' "$_out" | grep -o '/dev/disk[0-9]*' | head -n 1); _dev=${"$"}{_dev#/dev/}
  scrub_end() {
    [ -z "$_mnt" ] || { diskutil unmount "$_mnt" >/dev/null 2>&1 || diskutil unmount force "$_mnt" >/dev/null 2>&1; rmdir "$_mnt" 2>/dev/null; }
    [ -z "$_dev" ] || diskutil eject "$_dev" >/dev/null 2>&1 || diskutil eject force "$_dev" >/dev/null 2>&1 || :
  }
  case $_dev in disk[0-9]*) ;; *) echo "diskutil attached the fork's disk as no device BB Box can read." >&2; scrub_end; return 1 ;; esac
  [ "$_dev" != "$_mac" ] || { echo "The fork's disk came up as the Mac's own disk, so BB Box changed nothing." >&2; _dev=; return 1; }
  _store=$(diskutil list "$_dev" 2>/dev/null | awk '$2 == "Apple_APFS" { print $NF; exit }')
  case $_store in "$_dev"s[0-9]*) ;; *) echo "The fork's disk has no APFS store BB Box can read." >&2; scrub_end; return 1 ;; esac
  _box=$(container_of "$_store")
  case $_box in disk[0-9]*) ;; *) echo "BB Box could not read the APFS container of the fork's disk." >&2; scrub_end; return 1 ;; esac
  [ "$_box" != "$_mac" ] && [ "$_box" != "$_dev" ] || { echo "The fork's disk names the Mac's own container, so BB Box changed nothing." >&2; scrub_end; return 1; }
  _data=$(diskutil apfs list "$_box" 2>/dev/null | awk '/APFS Volume Disk \(Role\)/ && /\(Data\)/ { print $6; exit }')
  case $_data in "$_box"s[0-9]*) ;; *) echo "The fork's disk has no Data volume in its own container." >&2; scrub_end; return 1 ;; esac
  _mnt=$(mktemp -d "${"$"}{TMPDIR:-/tmp}/bbbox-fork.XXXXXX") || { scrub_end; return 1; }
  diskutil mount -mountPoint "$_mnt" "$_data" >/dev/null 2>&1 || { echo "diskutil could not mount the fork's Data volume." >&2; rmdir "$_mnt"; _mnt=; scrub_end; return 1; }
  [ -d "$_mnt/Users" ] || { echo "The fork's Data volume has no Users folder." >&2; scrub_end; return 1; }
  for _f in "$_mnt"/Users/*/.bb-machines/* "$_mnt"/Users/*/.bb-machines/.set-aside/* "$_mnt"/private/var/root/.bb-machines/*; do
    [ -d "$_f" ] || continue
    find "$_f" -mindepth 1 -maxdepth 1 ! -type d ! -name host-artifact.sha256 -delete && rm -rf "$_f/logs" "$_f/daemon.lock.lock" || { scrub_end; return 1; }
  done
  rm -f "$_mnt"/Users/*/Library/LaunchAgents/app.getbb.host-daemon.*.plist "$_mnt"/Users/*/.config/bb-box/env "$_mnt"/Users/*/.config/bb-box/vm "$_mnt"/private/var/root/.config/bb-box/env "$_mnt"/private/etc/ssh/ssh_host_* || { scrub_end; return 1; }
  _left=$(ls "$_mnt"/Users/*/Library/LaunchAgents/app.getbb.host-daemon.*.plist "$_mnt"/Users/*/.config/bb-box/env "$_mnt"/Users/*/.bb-machines/*/host-id "$_mnt"/Users/*/.bb-machines/*/auth.json "$_mnt"/private/etc/ssh/ssh_host_* 2>/dev/null)
  [ -z "$_left" ] || { echo "The fork's disk still holds $(printf '%s' "$_left" | sed "s|$_mnt||g" | tr '\n' ' ')after BB Box removed them." >&2; scrub_end; return 1; }
  sync
  scrub_end
}
made_as_kind() { [ "$(sed -n 's/^kind=//p' "$d/owners/$1" 2>/dev/null | head -n 1)" = "$2" ]; }
alive_in() { [ -f "$1" ] && read -r _p _st < "$1" && runs_still "$_p" "$_st"; }
journal() { mkdir -p "$snaps/.rollbacks" && printf '%s\n' "$2" > "$snaps/.rollbacks/$1.new" && mv -f "$snaps/.rollbacks/$1.new" "$snaps/.rollbacks/$1"; }
`;

function withSnapshots(body: string): string {
  return script(`${SNAPSHOT_SH}snaps=$(snaps_root) || exit 1\n${body}`);
}

export interface TakeScriptInput {
  readonly vm: string;
  readonly install: string;
  readonly box: string;
  readonly snapshot: string;
  readonly kind: string;
  readonly reset: number | null;
  readonly takenAt: number;
  readonly minFreeGiB: number;
}

export function takeScript(input: TakeScriptInput): string {
  const head = labelText({
    install: input.install,
    box: input.box,
    vm: input.vm,
    snapshot: input.snapshot,
    takenAt: input.takenAt,
    holds: "disk",
    os: "darwin",
    macosBuild: null,
    tart: null,
    reset: input.reset,
    kept: null,
    kind: input.kind,
    diskGB: null,
  })
    .split("\n")
    .filter((line) => line && !line.startsWith("holds=") && !line.startsWith("os=") && !line.startsWith("kind="))
    .join("\n");
  return withSnapshots(String.raw`vm=${quote(input.vm)}; id=${quote(input.snapshot)}
mine "$vm" ${quote(input.install)} ${quote(input.box)} || { echo gone; exit 0; }
now=$(state "$vm") || exit 1
case $now in
  "") echo gone; exit 0 ;;
  running) echo "$vm runs: BB Box takes a snapshot of a Tart VM only once it is suspended or stopped." >&2; exit 5 ;;
esac
mkdir -p "$snaps" || exit 1
same_volume "$tart_vms/$vm" "$snaps" || { other_volume "$snaps" "$tart_vms"; exit 6; }
sd="$snaps/$id"
if [ -d "$sd" ] && ours "$sd" ${quote(input.install)}; then echo @taken; cat "$sd/label"; echo @kib; du -sk "$sd/vm" | awk '{print $1}'; exit 0; fi
room_for_copy "$snaps" ${input.minFreeGiB} || exit 7
rm -rf "$sd.part" && mkdir -p "$sd.part" || exit 1
os=$(os_of "$vm"); [ -n "$os" ] || os=darwin
holds=disk; [ ! -f "$tart_vms/$vm/state.vzvmsave" ] || holds=disk-and-memory
kind=${quote(input.kind)}; ! made_as_kind "$vm" ${IOS_IMAGE_KIND} || kind=${IOS_IMAGE_KIND}
saved=$d/run/$vm.saved-under
under() { _u=$(sed -n "s/^$1=//p" "$saved" 2>/dev/null | head -n 1); printf '%s' "${"$"}{_u:-unknown}"; }
{ printf '%s\n' ${quote(head)}; echo "holds=$holds"; echo "os=$os"; echo "kind=$kind"; if [ "$holds" = disk-and-memory ]; then echo "macos=$(under macos)"; echo "tart=$(under tart)"; fi; g=$(disk_gb "$tart_vms/$vm"); [ -z "$g" ] || echo "diskgb=$g"; } > "$sd.part/label" || exit 1
this_shell > "$sd.part/pid"
copy_vm_files "$tart_vms/$vm" "$sd.part/vm" "" || { rm -rf "$sd.part"; echo "The copy of $vm failed." >&2; exit 1; }
rm -f "$sd.part/pid"
mv "$sd.part" "$sd" || exit 1
echo @taken; cat "$sd/label"; echo @kib; du -sk "$sd/vm" | awk '{print $1}'
`);
}

export interface Taken {
  readonly label: SnapshotLabel;
  readonly kib: number | null;
}

export function parseTaken(stdout: string): Taken | "gone" | null {
  if (stdout.trim() === "gone") return "gone";
  const parts = sections(stdout);
  const label = parseLabel(parts.get("taken") ?? "");
  if (!label) return null;
  const kib = Number(parts.get("kib")?.trim());
  return { label, kib: Number.isFinite(kib) && kib > 0 ? kib : null };
}

export function deleteScript(install: string, snapshot: string): string {
  return withSnapshots(String.raw`id=${quote(snapshot)}; sd="$snaps/$id"
for e in "$sd" "$sd.part"; do
  [ -d "$e" ] || continue
  ours "$e" ${quote(install)} || { echo "$e is not a snapshot of this install's, so BB Box leaves it." >&2; exit 4; }
  rm -rf "$sd.deleting" && mv "$e" "$sd.deleting" || exit 1
done
if [ -d "$sd.deleting" ]; then
  ours "$sd.deleting" ${quote(install)} || { echo "$sd.deleting is not a snapshot of this install's, so BB Box leaves it." >&2; exit 4; }
  rm -rf "$sd.deleting" || exit 1
fi
echo deleted
`);
}

export function listScript(): string {
  return withSnapshots(String.raw`[ -d "$snaps" ] || { echo @none; exit 0; }
echo @macosbuild; sw_vers -buildVersion 2>/dev/null
echo @tart; tart --version 2>/dev/null | head -n 1
echo @volume; volume_of "$snaps"
echo @entries
for e in "$snaps"/sn*; do
  [ -d "$e" ] || continue
  n=${"$"}{e##*/}
  alive=no; ! alive_in "$e/pid" || alive=yes
  printf '=%s\n' "$n"; echo "alive=$alive"; [ -d "$e/vm" ] && [ -f "$e/vm/state.vzvmsave" ] && echo "saved=yes"; cat "$e/label" 2>/dev/null; echo
done
`);
}

export type EntryState = "complete" | "taking" | "deleting";

export interface ListedEntry {
  readonly snapshot: string;
  readonly state: EntryState;
  readonly alive: boolean;
  readonly label: SnapshotLabel | null;
}

export interface Listing {
  readonly macosBuild: string;
  readonly tart: string;
  readonly volume: string;
  readonly entries: readonly ListedEntry[];
}

export function parseListing(stdout: string): Listing {
  const parts = sections(stdout);
  const entries: ListedEntry[] = [];
  for (const [name, text] of named(parts.get("entries") ?? "")) {
    const found = /^(sn[a-z2-7]{12})(?:\.(part|deleting))?$/.exec(name);
    if (!found) continue;
    const fields = parseFields(text);
    entries.push({ snapshot: found[1]!, state: found[2] === "part" ? "taking" : found[2] === "deleting" ? "deleting" : "complete", alive: fields.alive === "yes", label: parseLabel(text) });
  }
  return { macosBuild: parts.get("macosbuild")?.trim() ?? "", tart: parts.get("tart")?.trim() ?? "", volume: parts.get("volume")?.trim() ?? "", entries };
}

export function heldOf(entry: ListedEntry, host: string, install: string, guestOf: (label: SnapshotLabel) => { readonly guest: Guest; readonly owner: BoxOwner | null }, volume: string): HeldSnapshot | null {
  const label = entry.label;
  if (!label || label.install !== install || label.snapshot !== entry.snapshot) return null;
  const state: HeldSnapshotState = entry.state === "complete" ? "complete" : entry.state === "taking" && entry.alive ? "in-progress" : "incomplete";
  const words = entry.state === "deleting" ? `a delete stopped part way on ${host}; deleting it again finishes it` : entry.state === "taking" && !entry.alive ? `its copy on ${host} stopped part way` : null;
  const { guest, owner } = guestOf(label);
  return {
    id: label.snapshot,
    ref: label.snapshot,
    box: label.box,
    owner,
    guest,
    where: "current",
    state,
    words,
    holds: label.holds,
    takenAt: label.takenAt,
    keptUntil: keptUntilOf(label.kept),
    storage: { name: volume || "the VMs' volume", type: "apfs" },
    forkSafe: label.reset,
  };
}

export function taskOutcome(task: TartTask, listing: Listing, rollback: string | null): TaskOutcome {
  const entry = listing.entries.find((each) => each.snapshot === task.id) ?? null;
  if (task.kind === "rollback") return rollbackOutcome(task, rollback ?? "");
  if (task.kind === "take") {
    if (entry?.state === "complete") return { state: "ok" };
    if (entry?.state === "taking") return entry.alive ? { state: "running" } : { state: "failed", words: "its copy stopped part way" };
    return { state: "failed", words: "the Mac has no copy of it, so the take did not begin" };
  }
  if (!entry) return { state: "ok" };
  return entry.state === "deleting" ? { state: "failed", words: "its delete stopped part way" } : { state: "failed", words: "the Mac still has it" };
}

export function rollbackOutcome(task: Extract<TartTask, { kind: "rollback" }>, said: string): TaskOutcome {
  const lines = said.trim().split("\n");
  if (lines[0] === "running") return { state: "running" };
  if (lines[0] === "unhealed") return { state: "failed", words: "the VM's folder is missing, and the Mac has neither the snapshot's whole copy nor the VM's own folder set aside to put back" };
  const [phase, id, attempt] = (lines.at(-1) ?? "").trim().split(/\s+/);
  const ours = id === task.id && attempt === task.attempt;
  if (ours && phase === "done") return { state: "ok" };
  if (ours && phase === "undone") return { state: "failed", unchanged: true, words: `${PRODUCT} stopped before it finished putting the snapshot's copy in the VM's place, and the Mac put the VM's own folder back as it was` };
  return { state: "failed", unchanged: true, words: "the Mac has no record of putting this snapshot back for this restore, so it did not begin, and the VM is as it was" };
}

export function rollbackRecordScript(vm: string): string {
  return withSnapshots(String.raw`vm=${quote(vm)}
if rollback_running "$vm"; then echo running; else heal_rollback "$vm" || echo "unhealed"; fi
cat "$snaps/.rollbacks/$vm" 2>/dev/null || :
`);
}

export function labelKeptScript(install: string, snapshot: string, kept: string | null): string {
  return withSnapshots(String.raw`sd="$snaps/"${quote(snapshot)}
ours "$sd" ${quote(install)} || { echo "The Mac has no snapshot ${snapshot} of this install's." >&2; exit 4; }
{ grep -v '^kept=' "$sd/label"; ${kept ? `echo ${quote(`kept=${kept}`)}` : ":"}; } > "$sd/label.new" && mv -f "$sd/label.new" "$sd/label" || exit 1
echo labelled
`);
}

export interface PlanRead {
  readonly vm: string | null;
  readonly config: VmConfig | null;
  readonly diskGB: number | null;
  readonly sameVolume: boolean | null;
  readonly volume: string;
  readonly totalKiB: number;
  readonly freeKiB: number;
  readonly macosBuild: string;
  readonly tart: string;
  readonly canAttach: boolean;
  readonly snapshot: { readonly label: SnapshotLabel | null; readonly config: VmConfig | null; readonly complete: boolean; readonly saved: boolean } | null;
}

export function planScript(vm: string, install: string, box: string | null, snapshot: string | null): string {
  return withSnapshots(String.raw`vm=${quote(vm)}
mkdir -p "$snaps" 2>/dev/null
if mine "$vm" ${quote(install)} ${quote(box ?? "")}; then echo @vm; state "$vm"; echo @config; tr -d '\n' < "$tart_vms/$vm/config.json" 2>/dev/null; echo; echo @diskgb; disk_gb "$tart_vms/$vm"; fi
echo @same; if [ ! -d "$tart_vms/$vm" ]; then echo unknown; elif same_volume "$tart_vms/$vm" "$snaps"; then echo yes; else echo no; fi
echo @volume; volume_of "$snaps"
echo @df; df -P -k "$snaps/." | awk 'NR == 2 { print $2, $4 }'
echo @macosbuild; sw_vers -buildVersion 2>/dev/null
echo @tart; tart --version 2>/dev/null | head -n 1
echo @attach; if can_attach; then echo yes; else echo no; fi
${snapshot ? String.raw`sd="$snaps/"${quote(snapshot)}
if [ -d "$sd" ] && ours "$sd" ${quote(install)}; then echo @snapshot; echo complete=yes; [ -f "$sd/vm/state.vzvmsave" ] && echo saved=yes; cat "$sd/label"; echo @snapconfig; tr -d '\n' < "$sd/vm/config.json" 2>/dev/null; echo
elif [ -d "$sd.part" ] && ours "$sd.part" ${quote(install)}; then echo @snapshot; echo complete=no; cat "$sd.part/label"; fi` : ""}
`);
}

export function parsePlanRead(stdout: string): PlanRead {
  const parts = sections(stdout);
  const vmState = parts.get("vm")?.trim() || null;
  const [total = "0", free = "0"] = (parts.get("df") ?? "").trim().split(/\s+/);
  const same = parts.get("same")?.trim();
  const snapshotText = parts.get("snapshot");
  const disk = Number(parts.get("diskgb")?.trim());
  const snapshotFields = snapshotText === undefined ? null : parseFields(snapshotText);
  return {
    vm: vmState,
    config: parts.has("config") ? parseConfig(parts.get("config") ?? "") : null,
    diskGB: Number.isFinite(disk) && disk > 0 ? disk : null,
    sameVolume: same === "yes" ? true : same === "no" ? false : null,
    volume: parts.get("volume")?.trim() ?? "",
    totalKiB: Number(total) || 0,
    freeKiB: Number(free) || 0,
    macosBuild: parts.get("macosbuild")?.trim() ?? "",
    tart: parts.get("tart")?.trim() ?? "",
    canAttach: parts.get("attach")?.trim() === "yes",
    snapshot:
      snapshotText === undefined
        ? null
        : { label: parseLabel(snapshotText), config: parts.has("snapconfig") ? parseConfig(parts.get("snapconfig") ?? "") : null, complete: snapshotFields?.complete === "yes", saved: snapshotFields?.saved === "yes" },
  };
}

export function rollbackScript(vm: string, install: string, box: string, snapshot: string, minFreeGiB: number, attempt: string): string {
  return withSnapshots(String.raw`vm=${quote(vm)}; id=${quote(snapshot)}; try=${quote(attempt)}; sd="$snaps/$id"; v="$tart_vms/$vm"
r="$snaps/.restore-$vm"; a="$snaps/.replaced-$vm"
mine "$vm" ${quote(install)} ${quote(box)} || { echo gone; exit 0; }
! rollback_running "$vm" || { echo "Another restore of $vm runs on the Mac." >&2; exit 9; }
heal_rollback "$vm" || { echo "The VM's folder $v is missing, and the Mac has nothing whole to put back." >&2; exit 1; }
[ -d "$v" ] || { echo "The VM's folder $v is gone." >&2; exit 1; }
[ "$(state "$vm")" != running ] || { echo "$vm runs, so BB Box does not put a snapshot in its place." >&2; exit 5; }
[ -d "$sd" ] && ours "$sd" ${quote(install)} || { echo "The Mac has no snapshot $id of this install's." >&2; exit 4; }
[ "$(label_of "$sd" box)" = ${quote(box)} ] && [ "$(label_of "$sd" vm)" = "$vm" ] || { echo "Snapshot $id is not of $vm." >&2; exit 4; }
same_volume "$v" "$snaps" || { other_volume "$snaps" "$tart_vms"; exit 6; }
room_for_copy "$snaps" ${minFreeGiB} || exit 7
journal "$vm" "copying $id $try $(this_shell)" || exit 1
undone() { rm -rf "$r"; journal "$vm" "undone $id $try"; echo "$1" >&2; exit "$2"; }
rm -rf "$r" "$a"
copy_vm_files "$sd/vm" "$r" "" || undone "The copy of snapshot $id failed, and $vm is as it was." 1
: > "$r/.complete"
[ "$(state "$vm")" != running ] || undone "$vm started while BB Box copied snapshot $id, so it put nothing in its place." 5
journal "$vm" "swapping $id $try $(this_shell)" || undone "BB Box could not record the swap, so it put nothing in the place of $vm." 1
if mv "$v" "$a"; then
  mv "$r" "$v" || { mv "$a" "$v"; undone "BB Box could not put snapshot $id in the place of $vm, so it put the VM back." 1; }
else
  undone "BB Box could not move $vm aside, so it put nothing in its place." 1
fi
rm -f "$v/.complete"
g=$(label_of "$sd" diskgb); [ -z "$g" ] || note_disk_gb "$v" "$g"
if [ -f "$v/state.vzvmsave" ]; then grep -E '^(macos|tart)=' "$sd/label" > "$d/run/$vm.saved-under"; : > "$d/run/$vm.restored"; else rm -f "$d/run/$vm.saved-under" "$d/run/$vm.restored"; fi
rm -rf "$a"
journal "$vm" "done $id $try"
echo restored
`);
}

export function stoppedMarkScript(vm: string): string {
  return script(String.raw`v="$tart_vms/"${quote(vm)}
[ -d "$v" ] || { echo gone; exit 0; }
[ "$(state ${quote(vm)})" != running ] || { echo running; exit 0; }
for f in config.json nvram.bin disk.img state.vzvmsave; do
  if [ -e "$v/$f" ]; then printf '%s %s %s\n' "$f" "$(stat_of '%y' '%Fm' "$v/$f")" "$(stat_of '%s' '%z' "$v/$f")"; else echo "$f none"; fi
done
`);
}

export function forkScript(input: { readonly install: string; readonly snapshot: string; readonly vm: string; readonly cpus: number; readonly memoryMiB: number; readonly macos: boolean; readonly minFreeGiB: number }): string {
  return withSnapshots(String.raw`vm=${quote(input.vm)}; id=${quote(input.snapshot)}; sd="$snaps/$id"; v="$tart_vms/$vm"; s="$snaps/.fork-$vm"
[ -d "$sd" ] && ours "$sd" ${quote(input.install)} || { echo "The Mac has no snapshot $id of this install's." >&2; exit 4; }
same_volume "$sd" "$tart_vms" || { other_volume "$snaps" "$tart_vms"; exit 6; }
[ ! -e "$v" ] || { echo "$v is there already, so BB Box makes no fork over it." >&2; exit 8; }
room_for_copy "$snaps" ${input.minFreeGiB} || exit 7
rm -rf "$s"
copy_vm_files "$sd/vm" "$s" state.vzvmsave || { rm -rf "$s"; echo "The copy of snapshot $id failed." >&2; exit 1; }
${input.macos ? `scrub_disk "$s/disk.img" || { rm -rf "$s"; echo "BB Box could not remove the source's identity from the fork's disk before its first boot, so it makes no fork." >&2; exit 10; }` : ""}
mv "$s" "$v" || { rm -rf "$s"; exit 1; }
tart set "$vm" --random-mac || { echo "tart set --random-mac failed for $vm, so the fork would have its source's MAC address." >&2; exit 1; }
${input.macos ? `tart set "$vm" --random-serial || { echo "tart set --random-serial failed for $vm, so the fork would have its source's hardware identity." >&2; exit 1; }` : ""}
tart set "$vm" --cpu ${input.cpus} --memory ${input.memoryMiB} || exit 1
g=$(label_of "$sd" diskgb); [ -z "$g" ] || note_disk_gb "$v" "$g"
echo @config; tr -d '\n' < "$v/config.json"; echo
echo @disk; disk_gb "$v"
`);
}

export function storageOf(host: string, read: Pick<PlanRead, "volume" | "totalKiB" | "freeKiB">): SnapshotStorage {
  const totalBytes = read.totalKiB * 1024;
  const usedBytes = Math.max(0, (read.totalKiB - read.freeKiB) * 1024);
  return {
    key: `tart:${host}:${read.volume}`,
    name: read.volume || "the VMs' volume",
    type: "apfs",
    percentFull: totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0,
    metadataPercentFull: null,
    metadataUnread: null,
    totalBytes: totalBytes > 0 ? totalBytes : null,
    usedBytes: totalBytes > 0 ? usedBytes : null,
  };
}

export function sizeFrom(config: VmConfig | null, diskGB: number | null): MachineSize | null {
  if (!config || !config.cpus || !config.memoryMiB) return null;
  return { cores: config.cpus, memoryMiB: config.memoryMiB, diskGiB: diskGB !== null ? Math.floor((diskGB * 1e9) / GiB) : null };
}

export function suspendAboutMs(memoryMiB: number): number {
  return Math.round((memoryMiB / 1024) * SUSPEND_MS_PER_GIB);
}

export function savedUnder(label: SnapshotLabel | null, saved: boolean, now: { readonly macosBuild: string; readonly tart: string }): string | null {
  if (!label || !saved) return null;
  if (!label.macosBuild || label.macosBuild === "unknown" || !label.tart || label.tart === "unknown") {
    return `${PRODUCT} does not know which macOS build and Tart saved its memory, as the VM was suspended before ${PRODUCT} noted them, so it does not restore it. Fork it instead, which starts from its disk`;
  }
  if (now.macosBuild && label.macosBuild !== now.macosBuild) {
    return `its memory was saved while the Mac ran macOS build ${label.macosBuild}, and the Mac runs ${now.macosBuild} now, so ${PRODUCT} does not restore it: Virtualization restores a saved state only under the build that saved it. Fork it instead, which starts from its disk`;
  }
  if (now.tart && label.tart !== now.tart) {
    return `its memory was saved by Tart ${label.tart}, and the Mac has Tart ${now.tart} now, so ${PRODUCT} does not restore it. Fork it instead, which starts from its disk`;
  }
  return null;
}

export function roomShort(read: Pick<PlanRead, "volume" | "freeKiB">, floorGiB: number): string | null {
  const free = Math.floor(read.freeKiB / 1048576);
  const where = read.volume ? `the VMs' volume ${read.volume}` : "the VMs' volume";
  return free >= floorGiB ? null : `${where} has ${free} GiB free, and ${PRODUCT} copies a VM there only with at least ${floorGiB} GiB free, as the copy grows as the VM changes`;
}

export function planOf(host: string, os: "macos" | "linux", read: PlanRead, asked: string | null, offer: Snapshotting, floorGiB: number): SnapshotPlan {
  const storage = storageOf(host, read);
  const memoryMiB = read.config?.memoryMiB ?? 0;
  const memoryBytes = memoryMiB * MiB;
  const running = read.vm === "running";
  const gone = read.vm === null ? `its VM is not on ${host} any more` : null;
  const elsewhere = read.sameVolume === false ? `the snapshots folder on ${host} is on another volume than the VMs, so a copy there would be a full copy. Move it to the VMs' volume` : null;
  const linuxRuns = os === "linux" && running ? `Tart cannot suspend a Linux VM, so ${PRODUCT} takes its snapshot only while the box is stopped. Stop it first` : null;
  const short = roomShort(read, floorGiB);
  const takeWhy = gone ?? elsewhere ?? short ?? linuxRuns;
  const suspends = os === "macos" && running;
  const takeMs = suspends ? suspendAboutMs(memoryMiB) + COPY_MS + RESUME_MS : COPY_MS;
  const pause: TakePause = suspends ? { pauses: true, aboutMs: takeMs, basis: { bytes: memoryBytes, of: "memory" } } : NO_PAUSE;
  const memory = os === "macos" ? { storage, addsBytes: memoryBytes, pause } : null;
  const target = read.snapshot;
  const label = target?.label ?? null;
  const missing = asked && !target ? `${host} has no copy of it any more` : asked && target && !target.complete ? `its copy on ${host} is not complete` : null;
  const another = savedUnder(label, target?.saved ?? false, read);
  const restoreWhy = gone ?? elsewhere ?? short ?? missing ?? another;
  const undoMs = os === "macos" ? (running ? suspendAboutMs(memoryMiB) : 0) + COPY_MS : (running ? LINUX_SHUTDOWN_MS : 0) + COPY_MS;
  const sizeBack = target ? sizeFrom(target.config, label?.diskGB ?? null) : null;
  const readSize = target ? sizeBack : sizeFrom(read.config, read.diskGB);
  const forkSize = readSize ? { ...readSize, diskGiB: null } : null;
  const notForked = offer.fork === "copy" ? null : (offer.forkWhy ?? `${host} forks no snapshots of this box`);
  const unsafe = label && (label.reset === null || label.reset < (offer.forkSafeFrom ?? 0)) ? (os === "macos" ? "it was taken before its box had macOS's identity reset" : "it was taken before its box had the identity reset, which boxes from a Linux image refreshed since have") : null;
  const cannotClean = os === "macos" && !read.canAttach ? NO_IMAGE_ATTACH : null;
  const forkWhy = notForked ?? elsewhere ?? short ?? missing ?? unsafe ?? cannotClean ?? (forkSize ? null : `${PRODUCT} could not read the size of ${asked ? "the snapshot" : "the box"}`);
  const wholeBytes = (label?.diskGB ?? read.diskGB ?? 0) * 1e9 + (target?.saved ? memoryBytes : 0);
  return {
    storage,
    take: {
      ok: takeWhy === null,
      why: takeWhy ? `${takeWhy}.` : null,
      aboutMs: takeMs,
      memoryAboutMs: os === "macos" ? takeMs : null,
      addsBytes: memoryBytes,
      pause,
      memory,
      memoryWhy: os === "macos" ? null : "Tart cannot suspend a Linux VM, so its snapshots hold its disk only.",
    },
    restore: {
      way: restoreWhy ? "none" : "rollback",
      why: restoreWhy ? `${restoreWhy}.` : null,
      undo: restoreWhy ? "none" : os === "macos" ? "suspend-copy" : "snapshot",
      undoAboutMs: undoMs,
      undoBytes: memoryBytes,
      sizeBack,
      leavesOnEarlierGuest: 0,
      newer: 0,
      copyAboutMs: null,
    },
    keep: { way: notForked ? "no" : "as-is", why: notForked ? `${notForked}.` : null, aboutMs: null, bytes: wholeBytes > 0 ? wholeBytes : null, price: null },
    fork: { ok: forkWhy === null, why: forkWhy ? `${forkWhy}.` : null, aboutMs: COPY_MS + (os === "macos" ? MACOS_BOOT_MS : LINUX_BOOT_MS), bytes: null, size: forkSize },
    locked: null,
    busy: null,
  };
}
