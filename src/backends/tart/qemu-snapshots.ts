import { quote } from "../../transports/process.ts";
import { PRODUCT } from "../../brand.ts";
import { NO_PAUSE, type MachineSize, type SnapshotPlan, type Snapshotting, type TakePause } from "../types.ts";
import { ROLLBACK_BASE_GONE, parseFields, sections } from "./host.ts";
import { parseQemuVm, qemuScript, type QemuVm } from "./qemu.ts";
import { SNAPSHOT_SH, labelText, parseLabel, roomShort, storageOf, type SnapshotLabel } from "./snapshots.ts";

export const WINDOWS_SNAPSHOT_KIND = "windows";
export const WINDOWS_COPIED_FILES = ["disk.qcow2", "vars.fd", "config"] as const;
export const BASE_GONE_EXIT = 11;
const COPY_MS = 1_000;
const WINDOWS_SHUTDOWN_MS = 5_000;
const WINDOWS_RESUME_MS = 10_000;
const WINDOWS_BOOT_MS = 15_000;
const GiB = 2 ** 30;

const QEMU_SNAPSHOT_SH = String.raw`copy_windows_files() {
  mkdir -p "$2" || return 1
  for _f in ${WINDOWS_COPIED_FILES.join(" ")}; do
    [ -f "$1/$_f" ] || { echo "$1 has no $_f." >&2; return 1; }
    clone_copy "$1/$_f" "$2/$_f" || return 1
  done
}
base_of() { printf '%s/images/%s/%s/disk.qcow2' "$q" "$(label_of "$1" image)" "$(label_of "$1" build)"; }
has_base() { [ -n "$(label_of "$1" image)" ] && [ -n "$(label_of "$1" build)" ] && [ -f "$(base_of "$1")" ]; }
base_gone() {
  echo "Snapshot $(label_of "$1" snapshot) stands on build $(label_of "$1" build) of the Windows image $(label_of "$1" image), which the Mac no longer has. Delete the snapshot." >&2
}
config_val() { sed -n "s/^$2=//p" "$1/config" 2>/dev/null | head -n 1; }
`;

function withWindowsSnapshots(body: string): string {
  return qemuScript(`${SNAPSHOT_SH}${QEMU_SNAPSHOT_SH}[ -d "$tart_vms" ] || mkdir -p "$tart_vms" || exit 1\nsnaps=$(snaps_root) || exit 1\n${body}`);
}

export interface WindowsTakeInput {
  readonly vm: string;
  readonly install: string;
  readonly box: string;
  readonly snapshot: string;
  readonly takenAt: number;
  readonly minFreeGiB: number;
}

function windowsLabelHead(input: WindowsTakeInput): string {
  return labelText({
    install: input.install,
    box: input.box,
    vm: input.vm,
    snapshot: input.snapshot,
    takenAt: input.takenAt,
    holds: "disk",
    os: "windows",
    macosBuild: null,
    tart: null,
    reset: null,
    kept: null,
    kind: WINDOWS_SNAPSHOT_KIND,
    diskGB: null,
  });
}

export function qemuTakeScript(input: WindowsTakeInput): string {
  return withWindowsSnapshots(String.raw`vm=${quote(input.vm)}; id=${quote(input.snapshot)}; v="$q/vms/$vm"
mine "$vm" ${quote(input.install)} ${quote(input.box)} && [ -f "$v/config" ] || { echo gone; exit 0; }
! qrunning "$vm" || { echo "$vm runs: ${PRODUCT} copies a Windows VM only once Windows has shut down." >&2; exit 5; }
[ ! -f "$v/state" ] || { echo "$vm has its memory saved, so its disk is not as Windows leaves it at a shutdown. ${PRODUCT} copies it only once Windows has shut down." >&2; exit 5; }
mkdir -p "$snaps" || exit 1
same_volume "$v" "$snaps" || { other_volume "$snaps" "$q/vms"; exit 6; }
sd="$snaps/$id"
if [ -d "$sd" ] && ours "$sd" ${quote(input.install)}; then echo @taken; cat "$sd/label"; echo @kib; du -sk "$sd/vm" | awk '{print $1}'; exit 0; fi
room_for_copy "$snaps" ${input.minFreeGiB} || exit 7
rm -rf "$sd.part" && mkdir -p "$sd.part" || exit 1
{ printf '%s' ${quote(windowsLabelHead(input))}; echo "image=$(config_val "$v" image)"; echo "build=$(config_val "$v" build)"; } > "$sd.part/label" || exit 1
this_shell > "$sd.part/pid"
copy_windows_files "$v" "$sd.part/vm" || { rm -rf "$sd.part"; echo "The copy of $vm failed." >&2; exit 1; }
rm -f "$sd.part/pid"
mv "$sd.part" "$sd" || exit 1
echo @taken; cat "$sd/label"; echo @kib; du -sk "$sd/vm" | awk '{print $1}'
`);
}

export function qemuRollbackScript(vm: string, install: string, box: string, snapshot: string, minFreeGiB: number, attempt: string): string {
  return withWindowsSnapshots(String.raw`vm=${quote(vm)}; id=${quote(snapshot)}; try=${quote(attempt)}; sd="$snaps/$id"; v="$q/vms/$vm"
r="$snaps/.restore-$vm"; a="$snaps/.replaced-$vm"
mine "$vm" ${quote(install)} ${quote(box)} || { echo gone; exit 0; }
! rollback_running "$vm" || { echo "Another restore of $vm runs on the Mac." >&2; exit 9; }
heal_rollback "$vm" "$v" || { echo "The VM's folder $v is missing, and the Mac has nothing whole to put back." >&2; exit 1; }
[ -f "$v/config" ] || { echo "The VM's folder $v is gone." >&2; exit 1; }
! qrunning "$vm" || { echo "$vm runs, so ${PRODUCT} does not put a snapshot in its place." >&2; exit 5; }
[ -d "$sd" ] && ours "$sd" ${quote(install)} || { echo "The Mac has no snapshot $id of this install's." >&2; exit 4; }
[ "$(label_of "$sd" box)" = ${quote(box)} ] && [ "$(label_of "$sd" vm)" = "$vm" ] && [ "$(label_of "$sd" os)" = windows ] || { echo "Snapshot $id is not of $vm." >&2; exit 4; }
has_base "$sd" || { base_gone "$sd"; exit ${BASE_GONE_EXIT}; }
same_volume "$v" "$snaps" || { other_volume "$snaps" "$q/vms"; exit 6; }
room_for_copy "$snaps" ${minFreeGiB} || exit 7
journal "$vm" "copying $id $try $(this_shell)" || exit 1
undone() { free_bases; rm -rf "$r"; journal "$vm" "undone $id $try${"$"}{3:+ $3}"; echo "$1" >&2; exit "$2"; }
rm -rf "$r" "$a"
copy_windows_files "$sd/vm" "$r" || undone "The copy of snapshot $id failed, and $vm is as it was." 1
{ grep -v -e '^ssh=' -e '^vnc=' "$r/config"; grep -e '^ssh=' -e '^vnc=' "$v/config"; } > "$r/config.new" && mv -f "$r/config.new" "$r/config" || undone "${PRODUCT} could not keep the ports of $vm, so it put nothing in its place." 1
: > "$r/.complete"
! qrunning "$vm" || undone "$vm started while ${PRODUCT} copied snapshot $id, so it put nothing in its place." 5
qvideostop "$vm"
hold_bases || undone "${PRODUCT} put nothing in the place of $vm." 1
base_present_for "$r" || undone "Snapshot $id stands on $(base_disk_of "$r"), which the Mac no longer has, so ${PRODUCT} put nothing in the place of $vm. Delete the snapshot." ${BASE_GONE_EXIT} ${ROLLBACK_BASE_GONE}
journal "$vm" "swapping $id $try $(this_shell)" || undone "${PRODUCT} could not record the swap, so it put nothing in the place of $vm." 1
if mv "$v" "$a"; then
  mv "$r" "$v" || { mv "$a" "$v"; undone "${PRODUCT} could not put snapshot $id in the place of $vm, so it put the VM back." 1; }
else
  undone "${PRODUCT} could not move $vm aside, so it put nothing in its place." 1
fi
free_bases
rm -f "$v/.complete"
rm -rf "$a"
journal "$vm" "done $id $try"
echo restored
`);
}

export function qemuRollbackRecordScript(vm: string): string {
  return withWindowsSnapshots(String.raw`vm=${quote(vm)}
if rollback_running "$vm"; then echo running; else heal_rollback "$vm" "$q/vms/$vm" || echo "unhealed"; fi
cat "$snaps/.rollbacks/$vm" 2>/dev/null || :
`);
}

export function qemuPlanScript(vm: string, install: string, box: string | null, snapshot: string | null): string {
  return withWindowsSnapshots(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"
mkdir -p "$snaps" 2>/dev/null
if mine "$vm" ${quote(install)} ${quote(box ?? "")}; then
  rollback_running "$vm" || heal_rollback "$vm" "$v" || :
  if [ -f "$v/config" ]; then
    echo @vm; if rollback_running "$vm"; then echo stopped; else qstate "$vm"; fi
    echo @config; cat "$v/config"; echo @bytes; qbytes "$v/disk.qcow2"
  fi
fi
echo @same; if [ ! -d "$v" ]; then echo unknown; elif same_volume "$v" "$snaps"; then echo yes; else echo no; fi
echo @volume; volume_of "$snaps"
echo @df; df -P -k "$snaps/." | awk 'NR == 2 { print $2, $4 }'
${snapshot ? String.raw`sd="$snaps/"${quote(snapshot)}
if [ -d "$sd" ] && ours "$sd" ${quote(install)}; then
  echo @snapshot; echo complete=yes; ! has_base "$sd" || echo base=yes; cat "$sd/label"
  echo @snapconfig; cat "$sd/vm/config" 2>/dev/null; echo @snapbytes; qbytes "$sd/vm/disk.qcow2"
elif [ -d "$sd.part" ] && ours "$sd.part" ${quote(install)}; then echo @snapshot; echo complete=no; cat "$sd.part/label"; fi` : ""}
`);
}

export interface WindowsPlanRead {
  readonly vm: string | null;
  readonly config: QemuVm | null;
  readonly diskGiB: number | null;
  readonly sameVolume: boolean | null;
  readonly volume: string;
  readonly totalKiB: number;
  readonly freeKiB: number;
  readonly snapshot: { readonly label: SnapshotLabel | null; readonly complete: boolean; readonly base: boolean; readonly size: MachineSize | null } | null;
}

function gibOf(text: string | undefined): number | null {
  const bytes = Number(text?.trim());
  return bytes > 0 ? Math.ceil(bytes / GiB) : null;
}

function sizeOf(vm: QemuVm | null, diskGiB: number | null): MachineSize | null {
  return vm ? { cores: vm.cores, memoryMiB: vm.memoryMiB, diskGiB } : null;
}

export function parseWindowsPlanRead(stdout: string): WindowsPlanRead {
  const parts = sections(stdout);
  const [total = "0", free = "0"] = (parts.get("df") ?? "").trim().split(/\s+/);
  const same = parts.get("same")?.trim();
  const snapshotText = parts.get("snapshot");
  const snapshotFields = snapshotText === undefined ? null : parseFields(snapshotText);
  const config = parts.has("config") ? parseQemuVm(parts.get("config") ?? "") : null;
  const diskGiB = gibOf(parts.get("bytes"));
  return {
    vm: parts.get("vm")?.trim() || null,
    config,
    diskGiB,
    sameVolume: same === "yes" ? true : same === "no" ? false : null,
    volume: parts.get("volume")?.trim() ?? "",
    totalKiB: Number(total) || 0,
    freeKiB: Number(free) || 0,
    snapshot:
      snapshotText === undefined
        ? null
        : {
            label: parseLabel(snapshotText),
            complete: snapshotFields?.complete === "yes",
            base: snapshotFields?.base === "yes",
            size: sizeOf(parts.has("snapconfig") ? parseQemuVm(parts.get("snapconfig") ?? "") : null, gibOf(parts.get("snapbytes"))),
          },
  };
}

export function baseGoneWords(host: string, label: SnapshotLabel | null): string {
  const build = label?.build ? `build ${label.build} of the Windows image ${label.image ?? ""}`.trimEnd() : "a build of the Windows image";
  return `it stands on ${build}, which ${host} no longer has. Delete the snapshot`;
}

function stopFirstMs(power: string | null): number {
  if (power === "running") return WINDOWS_SHUTDOWN_MS;
  return power === "suspended" ? WINDOWS_RESUME_MS + WINDOWS_SHUTDOWN_MS : 0;
}

export function windowsTakeAboutMs(power: string | null): number {
  return stopFirstMs(power) + COPY_MS + (power === "running" ? WINDOWS_BOOT_MS : 0);
}

export function windowsPlanOf(host: string, read: WindowsPlanRead, asked: string | null, offer: Snapshotting, floorGiB: number): SnapshotPlan {
  const storage = storageOf(host, read);
  const gone = read.vm === null ? `its VM is not on ${host} any more` : null;
  const elsewhere = read.sameVolume === false ? `the snapshots folder on ${host} is on another volume than the VMs, so a copy there would be a full copy. Move it to the VMs' volume` : null;
  const short = roomShort(read, floorGiB);
  const takeWhy = gone ?? elsewhere ?? short;
  const takeMs = windowsTakeAboutMs(read.vm);
  const pause: TakePause = read.vm === "running" ? { pauses: true, aboutMs: takeMs, basis: null } : NO_PAUSE;
  const target = read.snapshot;
  const missing = asked && !target ? `${host} has no copy of it any more` : asked && target && !target.complete ? `its copy on ${host} is not complete` : null;
  const baseGone = asked && target?.complete && !target.base ? baseGoneWords(host, target.label) : null;
  const restoreWhy = gone ?? elsewhere ?? short ?? missing ?? baseGone;
  const notForked = offer.forkWhy ?? `${host} forks no snapshots of this box`;
  const readSize = sizeOf(read.config, read.diskGiB);
  return {
    storage,
    take: {
      ok: takeWhy === null,
      why: takeWhy ? `${takeWhy}.` : null,
      aboutMs: takeMs,
      memoryAboutMs: null,
      addsBytes: null,
      pause,
      memory: null,
      memoryWhy: `${PRODUCT} copies a Windows box's disk once Windows has shut down, so its snapshots hold no memory.`,
    },
    restore: {
      way: restoreWhy ? "none" : "rollback",
      why: restoreWhy ? `${restoreWhy}.` : null,
      undo: restoreWhy ? "none" : "snapshot",
      undoAboutMs: stopFirstMs(read.vm) + COPY_MS,
      undoBytes: null,
      sizeBack: target ? target.size : null,
      leavesOnEarlierGuest: 0,
      newer: 0,
      copyAboutMs: null,
    },
    keep: { way: "no", why: `${notForked}.`, aboutMs: null, bytes: null, price: null },
    fork: { ok: false, why: `${notForked}.`, aboutMs: COPY_MS + WINDOWS_BOOT_MS, bytes: null, size: readSize ? { ...readSize, diskGiB: null } : null },
    locked: null,
    busy: null,
  };
}
