// What the Tart backend runs on a Mac for Windows boxes, whose VMs QEMU runs
// on Apple's Hypervisor framework (046), and the parsers for what it prints.
// As host.ts's scripts, they run in /bin/sh over SSH as the Mac's user,
// install nothing, and keep their state under ~/.bb-box, readable by the
// host user only:
//
// - qemu/images/<image>/<build>/: the builds of a Windows image, each with
//   disk.qcow2, read-only, and vars.fd, its UEFI variables. The link
//   `current` names the build new VMs are made from.
// - qemu/vms/<vm>/: a VM. disk.qcow2 is an overlay on its build's disk, and
//   vars.fd a copy of the build's. config names its image and build, its
//   size, with its disk's when that is larger than the image's, its two
//   ports on the Mac's loopback, for SSH and VNC, and the machine, such as
//   virt-11.1, that QEMU's virt stood for, all chosen when it is made.
//   While QEMU runs it, it has QEMU's QMP socket, pid file and
//   output. exit holds how QEMU last exited, as host.ts's detach records
//   it (#406). A stopped or warm VM keeps its memory in state, saved by
//   QEMU's migration to a file, until it starts again.
// - The VM's owner file is in Tart's directory (host.ts) and names the
//   engine, qemu. It is written before the VM's directory and removed after.
//
// A VM runs while the process in its pid file runs QEMU with the VM's name,
// so a process that took the pid after the Mac restarted is not taken for it.

import { quote } from "../../transports/process.ts";
import { recordFromJson, type ImageRecord } from "../images.ts";
import { named, parseFields, script, sections } from "./host.ts";

/** The ports VMs take on the Mac's loopback, below macOS's ephemeral ports. */
const FIRST_PORT = 42000;
const LAST_PORT = 42999;

/**
 * The start of every QEMU script, after host.ts's: where VMs are, and
 * functions to tell a VM's state and drive its QEMU over QMP. QMP is reached
 * with nc through two FIFOs, which the script writes on fd 3 and reads on
 * fd 4. QEMU takes one QMP client at a time, so a second script waits for
 * the first.
 */
const LIBRARY = String.raw`q="$HOME/.bb-box/qemu"
# A write to a QMP connection that QEMU closed fails, rather than ending the script.
trap '' PIPE
nc=/usr/bin/nc; [ -x "$nc" ] || nc=nc
qrunning() {
  _p=$(cat "$q/vms/$1/pid" 2>/dev/null) && [ -n "$_p" ] && ps -ww -p "$_p" -o command= 2>/dev/null | grep -qF -- "-name $1 "
}
# VM $1's state: running; suspended while it has a saved state; stopped; nothing when it is not there.
qstate() {
  [ -d "$q/vms/$1" ] || return 0
  if qrunning "$1"; then echo running; elif [ -f "$q/vms/$1/state" ]; then echo suspended; else echo stopped; fi
}
# Disk $1's virtual size in bytes. -U reads a base that running VMs hold.
qbytes() { qemu-img info -U "$1" 2>/dev/null | sed -n 's/^virtual size: .*(\([0-9]*\) bytes).*/\1/p'; }
# QEMU's own data, with its firmware, beside the binary on the PATH.
qshare() {
  _b=$(command -v qemu-system-aarch64) || return 1
  _b=$(readlink -f "$_b" 2>/dev/null || printf '%s' "$_b")
  printf '%s/share/qemu\n' "$(dirname "$(dirname "$_b")")"
}
qmp_open() {
  _f="$q/vms/$1/qmp-$$"; rm -f "$_f.in" "$_f.out"
  mkfifo "$_f.in" "$_f.out" || return 1
  "$nc" -U "$q/vms/$1/qmp" <"$_f.in" >"$_f.out" 2>/dev/null &
  qnc=$!
  exec 3>"$_f.in" 4<"$_f.out"
  rm -f "$_f.in" "$_f.out"
  read -r _l <&4 || { qmp_close; return 1; }
  qmp '{"execute":"qmp_capabilities"}' >/dev/null
}
# Sends a command and prints QEMU's answer, past any events. Fails when QEMU answers an error or closes.
qmp() {
  printf '%s\n' "$1" >&3 || return 1
  while read -r _l <&4; do
    case "$_l" in *'"event"'*) continue ;; esac
    printf '%s\n' "$_l"
    case "$_l" in *'"return"'*) return 0 ;; *) return 1 ;; esac
  done
  return 1
}
qmp_close() { exec 3>&- 4<&-; kill "$qnc" 2>/dev/null; wait "$qnc" 2>/dev/null; }
# Whether QMP's answer $1 has "$2": "$3", however QEMU spaces it.
qhas() { printf '%s' "$1" | tr -d ' ' | grep -qF "\"$2\":\"$3\""; }
`;

function qemu(body: string): string {
  return script(`${LIBRARY}${body}`);
}

/**
 * What the state script adds for QEMU: each VM's config and state, and, when
 * Windows boxes are on, QEMU's version, whether the Mac has HVF, QEMU's
 * firmware, and the Windows image's current build.
 */
export function qemuStateBody(image: string | null): string {
  const vms = String.raw`echo @qemu
for vm in $(ls "$q/vms" 2>/dev/null); do
  case "$vm" in *.new) continue ;; esac
  [ -f "$q/vms/$vm/config" ] || continue
  printf '=%s\n' "$vm"; cat "$q/vms/$vm/config"; echo "power=$(qstate "$vm")"
done
`;
  if (!image) return `${LIBRARY}${vms}`;
  return `${LIBRARY}${vms}${String.raw`echo @qemu-version; qemu-system-aarch64 --version 2>/dev/null | head -n 1
echo @hvf; sysctl -n kern.hv_support 2>/dev/null
echo @qemu-firmware; f="$(qshare)/edk2-aarch64-code.fd" && [ -f "$f" ] && echo "$f"
echo @qemu-image
b=$(cd "$q/images/"${quote(image)}"/current" 2>/dev/null && pwd -P) && [ -f "$b/disk.qcow2" ] && [ -f "$b/vars.fd" ] && {
  # By its mode, which chmod a-w set, not by whether this user may write it: root always may.
  mode=read-only; [ -n "$(find "$b/disk.qcow2" -prune -perm -200 2>/dev/null)" ] && mode=writable
  echo "$(basename "$b") $mode $(qbytes "$b/disk.qcow2")"
  echo @qemu-record; tr -d '\n' < "$b/image.json" 2>/dev/null; echo
}
`}`;
}

export interface QemuVm {
  readonly image: string;
  /** The image's build its disk is an overlay on. */
  readonly build: string;
  readonly cores: number;
  readonly memoryMiB: number;
  /** Its ports on the Mac's loopback. */
  readonly ssh: number;
  readonly vnc: number;
  /** Its disk's size in GiB when it was made larger than the image's; null when it is the image's. */
  readonly diskGiB: number | null;
  /** "running", "suspended" or "stopped". */
  readonly power: string;
}

export interface QemuState {
  /** QEMU's version, such as 11.1.0, or "" when it is not installed. Read only when Windows boxes are on. */
  readonly version: string;
  readonly vms: ReadonlyMap<string, QemuVm>;
  readonly hvf: boolean;
  /** QEMU's UEFI firmware, or null when it is missing. */
  readonly firmware: string | null;
  /**
   * The Windows image's current build, whether its disk is read-only, the
   * disk's size in GiB, null when qemu-img did not say, and its record (049),
   * null when it has none; null when it has no build.
   */
  readonly image: { readonly build: string; readonly readOnly: boolean; readonly diskGiB: number | null; readonly record: ImageRecord | null } | null;
}

/** A VM's config, or the part after a line `@config`; null when it is not whole. */
export function parseQemuVm(text: string): QemuVm | null {
  const fields = parseFields(text.includes("@config") ? (sections(text).get("config") ?? "") : text);
  const [cores = 0, memoryMiB = 0, ssh = 0, vnc = 0] = ["cores", "memory", "ssh", "vnc"].map((key) => Number(fields[key]));
  if (!fields.image || ![cores, memoryMiB, ssh, vnc].every((value) => Number.isInteger(value) && value > 0)) return null;
  const disk = Number(fields.disk);
  const diskGiB = Number.isInteger(disk) && disk > 0 ? disk : null;
  return { image: fields.image, build: fields.build ?? "", cores, memoryMiB, ssh, vnc, diskGiB, power: fields.power || "stopped" };
}

export function parseQemuState(text: string): QemuState {
  const parts = sections(text);
  const vms = new Map<string, QemuVm>();
  for (const [name, config] of named(parts.get("qemu") ?? "")) {
    const vm = parseQemuVm(config);
    if (vm) vms.set(name, vm);
  }
  const [build, mode, bytes] = (parts.get("qemu-image") ?? "").trim().split(/\s+/);
  const size = Number(bytes);
  return {
    version: /\bversion (\S+)/.exec(parts.get("qemu-version") ?? "")?.[1] ?? "",
    vms,
    hvf: parts.get("hvf")?.trim() === "1",
    firmware: parts.get("qemu-firmware")?.trim() || null,
    image: build ? { build, readOnly: mode === "read-only", diskGiB: size > 0 ? Math.ceil(size / 2 ** 30) : null, record: recordFromJson(parts.get("qemu-record")?.trim()) } : null,
  };
}

/**
 * Makes the VM unless it is there: an overlay on the image's current build,
 * of `diskGiB` when that is larger than the image's disk, a copy of its UEFI
 * variables, two free ports, and the machine QEMU's virt stands for. The VM
 * keeps that machine, so that a state saved by this QEMU restores after QEMU
 * is updated. Then sizes it, and prints its config after a line `@config`.
 * An image box (049) can name another of the image's builds than the current.
 */
export function qemuCloneScript(image: string, vm: string, cores: number, memoryMiB: number, diskGiB: number | null = null, build = "current"): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"; image=${quote(image)}; disk=${Math.max(0, Math.trunc(diskGiB ?? 0))}
mkdir -p "$q/vms" || exit 1
if [ ! -d "$v" ]; then
  b=$(cd "$q/images/$image/"${quote(build)} 2>/dev/null && pwd -P) && [ -f "$b/disk.qcow2" ] && [ -f "$b/vars.fd" ] ||
    { echo "There is no Windows image $image on this Mac, in $q/images." >&2; exit 1; }
  machine=$(qemu-system-aarch64 -machine help 2>/dev/null | sed -n 's/^virt .*(alias of \(virt-[0-9.]*\)).*/\1/p' | head -n 1)
  [ -n "$machine" ] || machine=virt
  # A larger disk is the overlay's own size; Windows extends C: over the rest.
  size=
  if [ "$disk" -gt 0 ]; then
    base=$(qbytes "$b/disk.qcow2")
    [ -n "$base" ] || { echo "qemu-img could not read the size of $b/disk.qcow2." >&2; exit 1; }
    [ $((disk * 1073741824)) -le "$base" ] || size="$disk"G
  fi
  rm -rf "$v.new"; mkdir "$v.new" || exit 1
  qemu-img create -q -f qcow2 -F qcow2 -b "$b/disk.qcow2" "$v.new/disk.qcow2" $size || exit 1
  # An APFS clone, which shares the image's blocks until it changes.
  cp -c "$b/vars.fd" "$v.new/vars.fd" 2>/dev/null || cp "$b/vars.fd" "$v.new/vars.fd" || exit 1
  # One VM at a time takes ports: none another VM has, and none that something listens on.
  i=0
  until mkdir "$q/ports.lock" 2>/dev/null; do
    i=$((i + 1)); [ "$i" -lt 100 ] || { rm -rf "$q/ports.lock"; i=0; }
    sleep 0.1
  done
  taken=" $(cat "$q"/vms/*/config 2>/dev/null | sed -n -e 's/^ssh=//p' -e 's/^vnc=//p' | tr '\n' ' ') "
  free() {
    _p=$1
    while [ "$_p" -le ${LAST_PORT} ]; do
      case "$taken" in *" $_p "*) ;; *) "$nc" -z 127.0.0.1 "$_p" >/dev/null 2>&1 || { echo "$_p"; return 0; } ;; esac
      _p=$((_p + 1))
    done
    return 1
  }
  ssh=$(free ${FIRST_PORT}) && vnc=$(free $((ssh + 1))) ||
    { rmdir "$q/ports.lock"; echo "No two ports from ${FIRST_PORT} to ${LAST_PORT} are free on this Mac's loopback." >&2; exit 1; }
  {
    printf 'image=%s\nbuild=%s\nmachine=%s\nssh=%s\nvnc=%s\n' "$image" "$(basename "$b")" "$machine" "$ssh" "$vnc"
    [ -z "$size" ] || echo "disk=$disk"
  } > "$v.new/config" && mv "$v.new" "$v"
  made=$?; rmdir "$q/ports.lock"; [ "$made" -eq 0 ] || exit 1
fi
sed -e '/^cores=/d' -e '/^memory=/d' "$v/config" > "$v/config.new" && printf 'cores=%s\nmemory=%s\n' ${cores} ${memoryMiB} >> "$v/config.new" &&
  mv -f "$v/config.new" "$v/config" || exit 1
echo @config; cat "$v/config"
`);
}

/**
 * Starts the VM unless it runs, detached from the SSH session, and waits for
 * QEMU's QMP socket. A VM with a saved state restores it, runs on, and drops
 * it, as it no longer matches the disk. Prints "running", "started" or
 * "restored". When QEMU exits first, exits 3 with its output; when a state
 * does not restore, fails saying so. The last run's output and exit are
 * kept (host.ts).
 */
export function qemuStartScript(vm: string, waitSeconds: number): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"
[ -f "$v/config" ] || { echo "There is no VM $vm." >&2; exit 1; }
if qrunning "$vm"; then echo running; exit 0; fi
command -v qemu-system-aarch64 >/dev/null 2>&1 || { echo "QEMU is not installed, or not on the PATH of $(id -un)'s SSH sessions." >&2; exit 1; }
fw="$(qshare)/edk2-aarch64-code.fd"
[ -f "$fw" ] || { echo "QEMU's firmware $fw is missing." >&2; exit 1; }
val() { sed -n "s/^$1=//p" "$v/config" | head -n 1; }
rm -f "$v/qmp" "$v/pid"
# VNC with lossy=on, so a viewer that asks for JPEG, as the panel does, gets it (056).
set -- -name "$vm" -machine "$(val machine)" -accel hvf -cpu host -smp "$(val cores)" -m "$(val memory)" \
  -drive "if=pflash,format=raw,readonly=on,file=$fw" -drive "if=pflash,format=raw,file=$v/vars.fd" \
  -device qemu-xhci -device usb-kbd -device usb-tablet \
  -drive "if=none,id=disk,file=$v/disk.qcow2,discard=unmap" -device virtio-blk-pci,drive=disk \
  -netdev "user,id=net,hostfwd=tcp:127.0.0.1:$(val ssh)-:22" -device virtio-net-pci,netdev=net \
  -device virtio-gpu-pci -display none -vnc "127.0.0.1:$(($(val vnc) - 5900)),lossy=on" \
  -qmp "unix:$v/qmp,server=on,wait=off" -pidfile "$v/pid"
saved=; if [ -f "$v/state" ]; then saved=1; set -- "$@" -incoming defer; fi
keep "$v/out" "$v/exit"
detach "$v/out" "$v/exit" qemu-system-aarch64 "$@" || { echo "QEMU did not start for $vm." >&2; exit 1; }
i=0
until [ -S "$v/qmp" ]; do
  kill -0 "$pid" 2>/dev/null || { cat "$v/out" >&2; exit 3; }
  i=$((i + 1))
  [ "$i" -lt ${waitSeconds * 10} ] || { kill "$pid" 2>/dev/null; echo "QEMU did not start $vm within ${waitSeconds} s." >&2; cat "$v/out" >&2; exit 1; }
  sleep 0.1
done
[ -n "$saved" ] || { echo started; exit 0; }
failed() {
  qmp_close
  kill "$pid" 2>/dev/null
  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null
  echo "QEMU failed to restore $vm's saved state: $1 $(tail -n 5 "$v/out")" >&2; exit 1
}
qmp_open "$vm" || failed "its monitor did not answer."
r=$(qmp "{\"execute\":\"migrate-incoming\",\"arguments\":{\"uri\":\"file:$v/state\"}}") || failed "$r"
# Loaded, it is paused, as it was saved.
i=0
while :; do
  r=$(qmp '{"execute":"query-status"}') || failed "QEMU ended."
  qhas "$r" status inmigrate || break
  i=$((i + 1)); [ "$i" -lt ${waitSeconds * 10} ] || failed "it had not loaded after ${waitSeconds} s."
  sleep 0.1
done
qhas "$r" status running || qmp '{"execute":"cont"}' >/dev/null || failed "it did not run on: $r"
rm -f "$v/state"
qmp_close
echo restored
`);
}

/**
 * Saves VM $vm, in $v, when it runs: paused, its memory and devices written
 * to a file at full speed, then QEMU quits. A start restores it. One that
 * cannot be saved runs on, and the script fails.
 */
const SAVE = String.raw`if qrunning "$vm"; then
  pid=$(cat "$v/pid")
  qmp_open "$vm" || { echo "QEMU's monitor for $vm did not answer." >&2; exit 1; }
  failed() { rm -f "$v/state.part"; qmp '{"execute":"cont"}' >/dev/null; qmp_close; echo "QEMU could not save $vm: $1" >&2; exit 1; }
  rm -f "$v/state.part"
  r=$(qmp '{"execute":"stop"}') || failed "$r"
  r=$(qmp '{"execute":"migrate-set-parameters","arguments":{"max-bandwidth":107374182400}}') || failed "$r"
  r=$(qmp "{\"execute\":\"migrate\",\"arguments\":{\"uri\":\"file:$v/state.part\"}}") || failed "$r"
  i=0
  while :; do
    r=$(qmp '{"execute":"query-migrate"}') || failed "$r"
    qhas "$r" status completed && break
    qhas "$r" status failed && failed "$r"
    qhas "$r" status cancelled && failed "$r"
    i=$((i + 1)); [ "$i" -lt 1200 ] || failed "it had not saved after two minutes."
    sleep 0.1
  done
  mv -f "$v/state.part" "$v/state" || failed "its state could not be kept."
  qmp '{"execute":"quit"}' >/dev/null
  qmp_close
  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 300 ]; do sleep 0.1; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null
fi
`;

/**
 * Stops the VM when it names the box, saving it (SAVE). Prints "stopped", or
 * "gone" when it is not there or not this box's.
 */
export function qemuStopScript(vm: string, installId: string, boxId: string | null): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} && [ -d "$v" ] || { echo gone; exit 0; }
${SAVE}echo stopped
`);
}

/**
 * Saves a warm VM bb-box has filled, once it is ready (SAVE), and marks it
 * warm. Prints "warm", or "gone" when its owner file no longer says it is
 * filling.
 */
export function qemuWarmScript(vm: string, installId: string): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"; f="$d/owners/$vm"
grep -qxF ${quote(`install=${installId}`)} "$f" 2>/dev/null && grep -qx 'state=filling' "$f" || { echo gone; exit 0; }
${SAVE}[ -f "$v/state" ] || { echo "$vm was not running, so it has no state to restore." >&2; exit 1; }
sed 's/^state=filling$/state=warm/' "$f" > "$f.new" && mv -f "$f.new" "$f"
echo warm
`);
}

/** The VM's state, or "gone" when it is not there or not this box's. */
export function qemuPowerScript(vm: string, installId: string, boxId: string | null): string {
  return qemu(String.raw`vm=${quote(vm)}
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} || { echo gone; exit 0; }
qstate "$vm" | grep . || echo gone
`);
}

/**
 * How the VM's last run of QEMU ended, when it names the box (#406), as
 * host.ts's `ended` prints it. Prints "gone" when it is not there or not
 * this box's.
 */
export function qemuEndedScript(vm: string, installId: string, boxId: string | null): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"
mine "$vm" ${quote(installId)} ${quote(boxId ?? "")} && [ -d "$v" ] || { echo gone; exit 0; }
ended "$v/out" "$v/exit" qemu-system-aarch64
`);
}

/** Drops a VM's saved state, so a VM whose state does not restore boots afresh from its disk. */
export function qemuDiscardScript(vm: string): string {
  return qemu(`rm -f "$q/vms/"${quote(vm)}"/state"\n`);
}

/**
 * Deletes the VM when its owner file names this install and box: ends its
 * QEMU, then removes its directory and, last, the owner file. Prints "gone"
 * when the file names another box, which leaves everything alone.
 */
export function qemuDeleteScript(vm: string, installId: string, boxId: string | null): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"
if [ -f "$d/owners/$vm" ] && ! mine "$vm" ${quote(installId)} ${quote(boxId ?? "")}; then echo gone; exit 0; fi
if qrunning "$vm"; then
  pid=$(cat "$v/pid"); kill "$pid"
  i=0; while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
  kill -9 "$pid" 2>/dev/null
fi
rm -rf "$v" "$v.new" || exit 1
rm -f "$d/owners/$vm"
echo deleted
`);
}

/**
 * A Windows image's builds (049): each build directory, after a line
 * `=<build> current|other`, its owner fields as `owner:<key>=<value>` lines
 * (a refresh's build has them until it becomes current), and its record
 * after `record:`.
 */
export function qemuBuildsScript(image: string): string {
  return qemu(String.raw`d="$q/images/"${quote(image)}
cd "$d" 2>/dev/null || exit 0
cur=$(cd current 2>/dev/null && pwd -P); cur=$(basename "$cur" 2>/dev/null)
for b in *; do
  [ "$b" != current ] && [ -d "$b" ] && [ ! -L "$b" ] && [ -f "$b/disk.qcow2" ] || continue
  if [ "$b" = "$cur" ]; then echo "=$b current"; else echo "=$b other"; fi
  [ ! -f "$b/owner" ] || sed 's/^/owner:/' "$b/owner"
  printf 'record:'; tr -d '\n' < "$b/image.json" 2>/dev/null; echo
done
`);
}

/** A Windows image's builds, as qemuBuildsScript lists them. */
export function parseQemuBuilds(text: string): { readonly build: string; readonly current: boolean; readonly owner: Readonly<Record<string, string>>; readonly record: ImageRecord | null }[] {
  const builds: { build: string; current: boolean; owner: Record<string, string>; record: ImageRecord | null }[] = [];
  for (const line of text.split("\n")) {
    const head = /^=(\S+) (current|other)$/.exec(line);
    const last = builds.at(-1);
    if (head) builds.push({ build: head[1]!, current: head[2] === "current", owner: {}, record: null });
    else if (last && line.startsWith("owner:")) {
      const at = line.indexOf("=");
      if (at > 6) last.owner[line.slice(6, at)] = line.slice(at + 1);
    } else if (last && line.startsWith("record:")) last.record = recordFromJson(line.slice(7).trim());
  }
  return builds;
}

/**
 * Captures a Windows image box as a build of its image (049): asks the guest
 * to power down through ACPI, and quits QEMU when it has not after
 * `waitSeconds`, then flattens the box's overlay and its base into the new
 * build's own disk, read-only, with its UEFI variables, its record and the
 * owner fields that mark it a refresh's build until it becomes current.
 * The box's VM then goes. Prints "captured".
 */
export function qemuCaptureScript(vm: string, image: string, build: string, record: string, owner: string, waitSeconds: number): string {
  return qemu(String.raw`vm=${quote(vm)}; v="$q/vms/$vm"; t="$q/images/"${quote(image)}/${quote(build)}
[ -d "$v" ] || { echo "There is no VM $vm." >&2; exit 1; }
[ ! -e "$t" ] || { echo "The image has a build ${build} already." >&2; exit 1; }
if qrunning "$vm"; then
  if qmp_open "$vm"; then qmp '{"execute":"system_powerdown"}' >/dev/null; qmp_close; fi
  i=0; while qrunning "$vm" && [ "$i" -lt $((${Math.max(1, Math.trunc(waitSeconds))} * 2)) ]; do sleep 0.5; i=$((i + 1)); done
  if qrunning "$vm"; then
    echo "$vm did not power down in ${Math.max(1, Math.trunc(waitSeconds))} s, so QEMU is quit." >&2
    if qmp_open "$vm"; then qmp '{"execute":"quit"}' >/dev/null; qmp_close; fi
    sleep 2
  fi
fi
qrunning "$vm" && { echo "$vm is still running." >&2; exit 1; }
rm -rf "$t.new"; mkdir -p "$t.new" || exit 1
qemu-img convert -O qcow2 "$v/disk.qcow2" "$t.new/disk.qcow2" || { rm -rf "$t.new"; exit 1; }
cp "$v/vars.fd" "$t.new/vars.fd" || { rm -rf "$t.new"; exit 1; }
printf '%s\n' ${quote(record)} > "$t.new/image.json"
printf '%s' ${quote(owner)} > "$t.new/owner"
chmod a-w "$t.new/disk.qcow2" && mv "$t.new" "$t" || { chmod -R u+w "$t.new"; rm -rf "$t.new"; exit 1; }
rm -rf "$v"
rm -f "$d/owners/$vm"
echo captured
`);
}

/**
 * Makes a Windows image's build current (049): the link "current" names it,
 * in one rename, and it is no refresh's build any more. The build that was
 * current stays, named by the link "rollback", until the next replace,
 * whatever VMs use it: going back is pointing "current" at it, where a new
 * build from the ISO takes the operator's ISO and an hour. Other builds no
 * VM is an overlay on, the rollback before among them, then go. Prints
 * "replaced".
 */
export function qemuReplaceScript(image: string, build: string): string {
  return qemu(String.raw`im="$q/images/"${quote(image)}; b=${quote(build)}
[ -f "$im/$b/disk.qcow2" ] || { echo "The image has no build $b." >&2; exit 1; }
was=$(cd "$im/current" 2>/dev/null && pwd -P) && was=$(basename "$was")
if [ -n "$was" ] && [ "$was" != "$b" ] && [ -f "$im/$was/disk.qcow2" ]; then ln -sfn "$was" "$im/rollback" || exit 1; fi
ln -sfn "$b" "$im/current" || exit 1
rm -f "$im/$b/owner"
rb=$(cd "$im/rollback" 2>/dev/null && pwd -P) && rb=$(basename "$rb")
for o in "$im"/*; do
  n=$(basename "$o"); [ "$n" != current ] && [ "$n" != rollback ] && [ "$n" != "$b" ] && [ "$n" != "$rb" ] && [ -d "$o" ] && [ ! -L "$o" ] && [ -f "$o/disk.qcow2" ] || continue
  grep -qx "build=$n" "$q"/vms/*/config 2>/dev/null && continue
  chmod -R u+w "$o"; rm -rf "$o"
done
echo replaced
`);
}

/** Removes a refresh's build of a Windows image that is not current and no VM is an overlay on (049). Prints "removed" or "kept". */
export function qemuRemoveBuildScript(image: string, build: string, installId: string): string {
  return qemu(String.raw`im="$q/images/"${quote(image)}; b=${quote(build)}
[ -d "$im/$b" ] || { echo removed; exit 0; }
grep -qx "install="${quote(installId)} "$im/$b/owner" 2>/dev/null || { echo "Build $b of the image is not a refresh's build of this install's." >&2; exit 1; }
[ "$(cd "$im/current" 2>/dev/null && pwd -P)" != "$(cd "$im/$b" && pwd -P)" ] || { echo "Build $b is the image's current build." >&2; exit 1; }
if grep -qx "build=$b" "$q"/vms/*/config 2>/dev/null; then echo kept; exit 0; fi
chmod -R u+w "$im/$b"; rm -rf "$im/$b"
echo removed
`);
}
