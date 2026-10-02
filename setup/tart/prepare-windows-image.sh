#!/bin/sh
# Builds the Windows image windows-arm64-desktop boxes on a Mac are made from
# (046): Windows 11 on arm64 from your own ISO, installed unattended in QEMU
# with the Windows template's answer file and first-logon scripts
# (../proxmox-qemu), adapted for arm64 here. Run on each Mac as the user
# bb-box logs in as (see README.md):
#
#   ./prepare-windows-image.sh --iso <ISO> --iso-sha256 <its SHA-256> --key '<bb-box public key>' [--key <another>]... [--name <image>] [--edition <edition>] [--product-key <key>] [--reserve-gib <GiB>] [--delete-iso] [--replace] [--keep]
#
# The ISO is Windows 11 Arm64 in English (United States), which Setup needs
# no answers for. --edition is the one to install from it (Windows 11 Pro),
# and --product-key the key it takes (Microsoft's generic key for Pro, which
# installs without activating).
#
# It downloads the virtio-win drivers, installs Windows from the ISO with them
# (Setup, then the first logon, which installs OpenSSH, PowerShell 7, Git,
# GitHub CLI and Cua Driver), boots it once as a box boots, and checks a clone
# of it as the backend uses a box, saved and restored. The image is then
# ~/.bb-box/qemu/images/<name>/build.<time>, with a read-only disk.qcow2 and
# vars.fd, and the link `current` names it. About 20 minutes, and about 25 GiB
# beyond --reserve-gib (50 GiB, as the backend's tart-reserve-disk-gib): the
# build stops rather than leave less free. --delete-iso deletes the ISO once
# Setup has copied Windows from it, which gives its space back. --replace
# builds an image that is there again; boxes made from the old build keep it.
# --keep keeps a failed build's directory, to boot and look at.
set -eu

name=bb-box-windows
iso=
iso_sha256=
key=
edition='Windows 11 Pro'
product_key=VK7JG-NPHTM-C97JM-9MPGT-3V66T
reserve_gib=50
delete_iso=0
replace=0
keep=0
die() { echo "prepare-windows-image: $*" >&2; exit 1; }
while [ $# -gt 0 ]; do
  [ $# -gt 1 ] || case $1 in --delete-iso | --replace | --keep) ;; *) die "$1 needs a value" ;; esac
  case $1 in
    --iso) iso=$2; shift 2 ;;
    --iso-sha256) iso_sha256=$(printf '%s' "$2" | tr A-F a-f); shift 2 ;;
    --key)
      case $2 in ssh-ed25519\ *) ;; *) die "--key must be an OpenSSH ed25519 public key" ;; esac
      key="${key:+$key
}$2"
      shift 2 ;;
    --name) name=$2; shift 2 ;;
    --edition) edition=$2; shift 2 ;;
    --product-key) product_key=$2; shift 2 ;;
    --reserve-gib) reserve_gib=$2; shift 2 ;;
    --delete-iso) delete_iso=1; shift ;;
    --replace) replace=1; shift ;;
    --keep) keep=1; shift ;;
    *) die "unknown option $1 (see the top of this script)" ;;
  esac
done
[ -n "$key" ] || die "give bb-box's public key with --key, as bb box doctor shows it"
[ -n "$iso" ] || die "give the Windows 11 Arm64 ISO with --iso"
[ -f "$iso" ] || die "there is no ISO at $iso"
case $iso in *,*) die "QEMU cannot take a path with a comma: move $iso" ;; esac
printf '%s' "$iso_sha256" | grep -Eqx '[0-9a-f]{64}' || die "give the ISO's SHA-256 with --iso-sha256"
printf '%s' "$name" | grep -Eqx '[A-Za-z0-9][A-Za-z0-9._-]*' || die "--name may have only letters, digits, '.', '_' and '-'"
# What goes in the answer file without escaping.
printf '%s' "$edition" | grep -Eqx '[A-Za-z0-9 ._()-]+' || die "--edition may have only letters, digits, spaces and . _ ( ) -"
printf '%s' "$product_key" | grep -Eqx '[A-Z0-9]{5}(-[A-Z0-9]{5}){4}' || die "--product-key must be five groups of five letters or digits"
printf '%s' "$reserve_gib" | grep -Eqx '[0-9]+' || die "--reserve-gib must be a whole number of GiB"

# What the first logon downloads, pinned by version and SHA-256, as
# ../proxmox-qemu/build.sh pins them for x64.
PWSH_VERSION=7.6.6
PWSH_SHA256=387D0AF8E92BA97F73616C91FA8F29A284E8F82EE6C40FE12DADE971BB05BAC4
CUA_VERSION=0.30.4
CUA_SHA256=225926273A0BF962DA7CEFDD6915144D41F6FF519FA270F6C57C85436AE860AE
GIT_VERSION=2.56.0
GIT_SHA256=C130C04301D06995EF08F1CBD895342844D1FBB3312F5D32CB27CC05B4B394DC
GH_VERSION=2.101.0
GH_SHA256=02895F2F9CFC4F5BE0DAADE8314F0F8C1BFC88BF0ED16ADD284B95FA06461DFF
# The drivers Setup needs for the disk, and Windows for the network and display.
VIRTIO_VERSION=0.1.302
VIRTIO_SHA256=303f7ae40dad495d6ae474fdc571df58958a4dbc5c37a522d80f9a203867949d

here=$(cd "$(dirname "$0")" && pwd)
template=$here/../proxmox-qemu
[ -f "$template/answer/autounattend.xml" ] || die "no $template: run this from a checkout of bb-box"
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:/run/current-system/sw/bin:$PATH"
[ "$(uname -s)" = Darwin ] && [ "$(uname -m)" = arm64 ] || die "this builds Windows for a Mac with Apple silicon"
[ "$(/usr/sbin/sysctl -n kern.hv_support 2>/dev/null)" = 1 ] || die "this Mac has no Hypervisor framework"
for tool in qemu-system-aarch64 qemu-img hdiutil bsdtar curl shasum ssh scp ssh-keygen caffeinate; do
  command -v "$tool" >/dev/null ||
    case $tool in qemu*) die "install QEMU first: brew install qemu" ;; *) die "$tool is required" ;; esac
done
nc=/usr/bin/nc; [ -x "$nc" ] || nc=nc
# QEMU's own data, with its firmware, beside the binary on the PATH, as the backend finds it.
qemu=$(command -v qemu-system-aarch64)
share=$(dirname "$(dirname "$(readlink -f "$qemu" 2>/dev/null || printf '%s' "$qemu")")")/share/qemu
fw=$share/edk2-aarch64-code.fd
[ -f "$fw" ] && [ -f "$share/edk2-arm-vars.fd" ] || die "QEMU's UEFI firmware is not in $share"
# The machine QEMU's virt stands for, as a box's is chosen.
machine=$(qemu-system-aarch64 -machine help 2>/dev/null | sed -n 's/^virt .*(alias of \(virt-[0-9.]*\)).*/\1/p' | head -n 1)
[ -n "$machine" ] || machine=virt

# The ISO's volume label, from its primary volume descriptor, says its
# architecture and language, such as CCCOMA_A64FRE_EN-US_DV9.
label=$(dd if="$iso" bs=8 skip=4101 count=4 2>/dev/null | tr -d ' \000')
case $label in
  *A64*EN-US*) ;;
  *) die "$iso is ${label:-not a Windows ISO}: give Windows 11 Arm64 in English (United States)" ;;
esac

umask 077
q=$HOME/.bb-box/qemu
images=$q/images/$name
mkdir -p "$images"
if [ -e "$images/current" ] && [ "$replace" = 0 ]; then die "$name exists; give --replace to build it again"; fi
kib() { df -k "$images" | awk 'NR == 2 { print $4 }'; }
floor=$((reserve_gib * 1048576))
free=$(kib)
[ "$free" -ge $((floor + 25 * 1048576)) ] ||
  die "$((free / 1048576)) GiB is free; the build needs 25 GiB beyond the $reserve_gib GiB it leaves free (--reserve-gib)"

build=build.$(date -u +%Y%m%d-%H%M%S)
d=$images/$build.new
# Kept on a failure, to look at: the screen and QEMU's output.
png=$images/$build.png
log=$images/$build.log
w=
qpid=
dog=
done_ok=
step() { printf '%s  %s\n' "$(date +%H:%M:%S)" "$*"; }
cleanup() {
  status=$?
  if [ -n "$qpid" ]; then kill "$qpid" 2>/dev/null; wait "$qpid" 2>/dev/null; fi
  [ -z "$dog" ] || kill "$dog" 2>/dev/null
  # The work directory holds the password and the build's SSH key.
  if [ -n "$w" ]; then chmod -R u+w "$w" 2>/dev/null; rm -rf "$w"; fi
  if [ -z "$done_ok" ] && [ -d "$d" ]; then
    if [ "$keep" = 1 ]; then echo "kept $d (--keep)"; else rm -rf "$d"; fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
w=$(mktemp -d "$images/work.XXXXXX")
mkdir "$d"
# The Mac stays awake for the build.
caffeinate -i -w $$ >/dev/null 2>&1 &

# QEMU stops, and the build with it, should the disk fill below the reserve.
(
  while :; do
    if [ "$(kib)" -lt "$floor" ]; then
      : >"$w/low"
      kill "$(cat "$w/pid" 2>/dev/null)" 2>/dev/null
      exit 0
    fi
    sleep 5
  done
) &
dog=$!
low() { [ ! -f "$w/low" ] || die "fewer than $reserve_gib GiB would be left free on this Mac, so the build stopped"; }
trap '' PIPE

step "checking the ISO's SHA-256 ($(du -h "$iso" | cut -f1))"
sum=$(shasum -a 256 "$iso" | awk '{ print tolower($1) }')
[ "$sum" = "$iso_sha256" ] || die "$iso's SHA-256 is $sum, not $iso_sha256"

# The answer disc: the Windows template's answer file and first-logon
# scripts, adapted for arm64 with no SMBIOS address and no guest agent, and
# the arm64 drivers. It holds the password, so it lives only in the work
# directory, and the first logon deletes its copy in Windows.
step "downloading the virtio-win $VIRTIO_VERSION drivers"
a=$w/answer
mkdir -p "$a/bb-box" "$a/drivers"
curl -fsSL --retry 3 -o "$w/virtio.iso" "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/archive-virtio/virtio-win-$VIRTIO_VERSION-1/virtio-win-$VIRTIO_VERSION.iso"
[ "$(shasum -a 256 "$w/virtio.iso" | awk '{ print $1 }')" = "$VIRTIO_SHA256" ] || die "the virtio-win ISO does not match its SHA-256"
# Its arm64 drivers for Windows 11 are hard links to those for Server 2025,
# so both come out, in the ISO's read-only directories.
mkdir "$w/virtio"
bsdtar -xf "$w/virtio.iso" -C "$w/virtio" --exclude '*.pdb' --exclude Readme.md \
  viostor/2k25/ARM64 viostor/w11/ARM64 NetKVM/2k25/ARM64 NetKVM/w11/ARM64 viogpudo/2k25/ARM64 viogpudo/w11/ARM64
chmod -R u+w "$w/virtio"
for drv in viostor NetKVM viogpudo; do
  mkdir -p "$a/drivers/$drv/w11"
  mv "$w/virtio/$drv/w11/ARM64" "$a/drivers/$drv/w11/"
done
rm -rf "$w/virtio" "$w/virtio.iso"
for inf in viostor/w11/ARM64/viostor.inf NetKVM/w11/ARM64/netkvm.inf viogpudo/w11/ARM64/viogpudo.inf; do
  [ -f "$a/drivers/$inf" ] || die "the virtio-win ISO has no $inf"
done

step "making the answer disc"
password=$(dd if=/dev/urandom bs=1024 count=1 2>/dev/null | LC_ALL=C tr -dc 'A-Za-z0-9')
password=$(printf '%s' "$password" | cut -c 1-24)
[ ${#password} = 24 ] || die "could not make a password"
ssh-keygen -q -t ed25519 -N '' -C "$name-build" -f "$w/key"
# Setup takes the drivers from \drivers on the answer disc, whose letter
# varies, so C: and H: are listed too. Windows 11's checks for a TPM, Secure
# Boot and the like are off: QEMU's virt machine has neither.
cat >"$w/specialize.xml" <<'EOF'
        <RunSynchronousCommand wcm:action="add">
          <Order>4</Order>
          <Path>powershell.exe -NoProfile -ExecutionPolicy Bypass -File C:\bb-box\clock.ps1</Path>
        </RunSynchronousCommand>
EOF
cat >"$w/windowspe.xml" <<'EOF'
      <RunSynchronous>
        <RunSynchronousCommand wcm:action="add"><Order>1</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassTPMCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>2</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassSecureBootCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>3</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassRAMCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>4</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassCPUCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
        <RunSynchronousCommand wcm:action="add"><Order>5</Order><Path>reg add HKLM\SYSTEM\Setup\LabConfig /v BypassStorageCheck /t REG_DWORD /d 1 /f</Path></RunSynchronousCommand>
      </RunSynchronous>
EOF
sed -e 's/\\vioscsi\\w11\\amd64<\/Path>/\\drivers<\/Path>/' -e 's/processorArchitecture="amd64"/processorArchitecture="arm64"/g' \
  -e "s/@PASSWORD@/$password/g" -e "s/@EDITION@/$edition/g" -e "s/@PRODUCT_KEY@/$product_key/g" \
  "$template/answer/autounattend.xml" |
  awk -v specialize="$w/specialize.xml" -v windowspe="$w/windowspe.xml" '
    function insert(file, line) { while ((getline line < file) > 0) print line; close(file) }
    index($0, "wcm:keyValue=\"4\"><Path>G:\\drivers</Path>") {
      print; h = $0; c = $0
      sub(/"4"><Path>G:/, "\"5\"><Path>H:", h); print h
      sub(/"4"><Path>G:/, "\"6\"><Path>C:", c); print c
      paths++; next
    }
    $0 == "      </RunSynchronous>" { insert(specialize); runs++ }
    $0 == "      <DiskConfiguration>" { insert(windowspe); disks++ }
    { print }
    END { if (paths != 2 || runs != 1 || disks != 1) exit 1 }
  ' >"$a/autounattend.xml" || die "../proxmox-qemu/answer/autounattend.xml has changed: adapt this script to it"
! grep -Eq 'amd64|vioscsi|@[A-Z_]+@' "$a/autounattend.xml" && [ "$(grep -c '\\drivers</Path>' "$a/autounattend.xml")" = 12 ] &&
  [ "$(grep -c 'clock\.ps1\|LabConfig /v BypassTPMCheck' "$a/autounattend.xml")" = 2 ] ||
  die "../proxmox-qemu/answer/autounattend.xml has changed: adapt this script to it"
# The first logon without the SMBIOS address, and with OpenSSH for arm64
# should Windows Update not have it.
awk '
  $0 == "Step \"Build address $($build.address)\"" { n++; next }
  $0 == "& C:\\bb-box\\boot.ps1 -Address $build.address -Gateway $build.gateway -Dns $build.dns" { n++; next }
  $0 == "# The downloads below need the network the address has just brought up." { print "# The downloads below need the network."; n++; next }
  index($0, "Step '\''The box address at each boot") == 1 { drop = 1 }
  drop { if (index($0, "Set-Content C:\\bb-box\\dns.txt") == 1) { drop = 0; n++ } next }
  { if (sub(/OpenSSH-Win64-/, "OpenSSH-ARM64-")) n++; print }
  END { if (n != 5) exit 1 }
' "$template/answer/bb-box/firstlogon.ps1" >"$a/bb-box/firstlogon.ps1" &&
  ! grep -Eq 'boot\.ps1|\$build\.(address|gateway|dns)|Win64' "$a/bb-box/firstlogon.ps1" ||
  die "../proxmox-qemu/answer/bb-box/firstlogon.ps1 has changed: adapt this script to it"
cp "$template/answer/bb-box/logon.ps1" "$here/windows/clock.ps1" "$a/bb-box/"
# The check, with the clock's in place of the address's.
awk -v clock="$here/windows/check-clock.ps1" '
  $0 == "Check '\''address from the SMBIOS serial'\'' {" { while ((getline line < clock) > 0) print line; drop = 1; n++; next }
  drop { if ($0 == "}") drop = 0; next }
  { print }
  END { if (n != 1 || drop) exit 1 }
' "$template/check.ps1" >"$w/check.ps1" || die "../proxmox-qemu/check.ps1 has changed: adapt this script to it"
json() { printf '%s' "$1" | sed 's/[\\"]/\\&/g'; }
pin() { printf '"%s": {"version": "%s", "sha256": "%s", "url": "%s"}' "$1" "$2" "$3" "$4"; }
{
  printf '{\n  "keys": ['
  printf '%s\n%s\n' "$key" "$(cat "$w/key.pub")" | while IFS= read -r k; do printf '%s"%s"' "${sep:-}" "$(json "$k")"; sep=', '; done
  printf '],\n  "password": "%s",\n  ' "$password"
  pin pwsh "$PWSH_VERSION" "$PWSH_SHA256" "https://github.com/PowerShell/PowerShell/releases/download/v$PWSH_VERSION/PowerShell-$PWSH_VERSION-win-arm64.msi"
  printf ',\n  '
  pin cua "$CUA_VERSION" "$CUA_SHA256" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$CUA_VERSION/cua-driver-rs-$CUA_VERSION-windows-arm64.zip"
  printf ',\n  '
  pin git "$GIT_VERSION" "$GIT_SHA256" "https://github.com/git-for-windows/git/releases/download/v$GIT_VERSION.windows.1/Git-$GIT_VERSION-arm64.exe"
  printf ',\n  '
  pin gh "$GH_VERSION" "$GH_SHA256" "https://github.com/cli/cli/releases/download/v$GH_VERSION/gh_${GH_VERSION}_windows_arm64.msi"
  printf '\n}\n'
} >"$a/bb-box/build.json"
hdiutil makehybrid -quiet -iso -joliet -default-volume-name BBBOXANSWER -o "$w/answer.iso" "$a"
rm -rf "$a"

# QEMU as the backend starts a box (src/backends/tart/qemu.ts), on the disk
# and UEFI variables in directory $1, with the devices after it added. It
# runs in the foreground of this script, so it ends with it.
port_free() { ! "$nc" -z 127.0.0.1 "$1" >/dev/null 2>&1; }
ssh_port=41000
until port_free "$ssh_port" && port_free $((ssh_port + 1)); do
  ssh_port=$((ssh_port + 2))
  [ "$ssh_port" -lt 41998 ] || die "no two ports from 41000 to 41999 are free on this Mac's loopback"
done
vnc_port=$((ssh_port + 1))
vm=$name-build
qemu_up() {
  _dir=$1; shift
  rm -f "$w/qmp" "$w/pid"
  qemu-system-aarch64 -name "$vm" -machine "$machine" -accel hvf -cpu host -smp 4 -m 8192 \
    -drive "if=pflash,format=raw,readonly=on,file=$fw" -drive "if=pflash,format=raw,file=$_dir/vars.fd" \
    -device qemu-xhci -device usb-kbd -device usb-tablet \
    -drive "if=none,id=disk,file=$_dir/disk.qcow2,discard=unmap" -device virtio-blk-pci,drive=disk \
    -netdev "user,id=net,hostfwd=tcp:127.0.0.1:$ssh_port-:22" -device virtio-net-pci,netdev=net \
    "$@" -display none -vnc "127.0.0.1:$((vnc_port - 5900))" \
    -qmp "unix:$w/qmp,server=on,wait=off" -pidfile "$w/pid" >>"$log" 2>&1 </dev/null &
  qpid=$!
  _i=0
  until [ -S "$w/qmp" ]; do
    kill -0 "$qpid" 2>/dev/null || { qpid=; tail -n 5 "$log" >&2; die "QEMU did not start (above)"; }
    _i=$((_i + 1)); [ "$_i" -lt 300 ] || die "QEMU did not start within 30 s"
    sleep 0.1
  done
}
# Whether QEMU has ended, after which it is waited for.
ended() {
  if kill -0 "$qpid" 2>/dev/null && ! ps -o stat= -p "$qpid" 2>/dev/null | grep -q '^Z'; then return 1; fi
  wait "$qpid" 2>/dev/null || :
  qpid=
}
# QMP as the backend drives it: nc through two FIFOs, written on fd 3 and read on fd 4.
qmp_open() {
  rm -f "$w/qmp.in" "$w/qmp.out"
  mkfifo "$w/qmp.in" "$w/qmp.out" || return 1
  "$nc" -U "$w/qmp" <"$w/qmp.in" >"$w/qmp.out" 2>/dev/null &
  qnc=$!
  exec 3>"$w/qmp.in" 4<"$w/qmp.out"
  rm -f "$w/qmp.in" "$w/qmp.out"
  read -r _l <&4 || { qmp_close; return 1; }
  qmp '{"execute":"qmp_capabilities"}' >/dev/null
}
qmp() {
  printf '%s\n' "$1" >&3 || return 1
  while read -r _l <&4; do
    case "$_l" in *'"event"'*) continue ;; esac
    printf '%s\n' "$_l"
    case "$_l" in *'"return"'*) return 0 ;; *) return 1 ;; esac
  done
  return 1
}
qmp_close() { exec 3>&- 4<&-; kill "$qnc" 2>/dev/null; wait "$qnc" 2>/dev/null || :; }
qhas() { printf '%s' "$1" | tr -d ' ' | grep -qF "\"$2\":\"$3\""; }
# One command on a connection of its own.
qmp1() { qmp_open || return 1; _r=0; qmp "$1" >/dev/null || _r=1; qmp_close; return "$_r"; }
screen() { [ -z "$qpid" ] || qmp1 "{\"execute\":\"screendump\",\"arguments\":{\"filename\":\"$png\",\"format\":\"png\"}}" || :; }
fail() { screen; die "$* (the screen: $png; QEMU's output: $log)"; }
# Windows over SSH as the backend reaches a box: a PowerShell script, sent
# base64-encoded so that none of its quotes reach Windows' command line.
ssh_box() {
  ssh -F /dev/null -i "$w/key" -p "$ssh_port" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
    -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=5 -o ServerAliveInterval=5 box@127.0.0.1 "$@" </dev/null
}
win() { ssh_box "& ([scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('$(printf '%s' "$1" | base64 | tr -d '\n')'))))"; }
# The backend's test that the desktop is up (src/backends/windows.ts).
desktop_up='if ((Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0) -and (Test-Path -LiteralPath "\\.\pipe\cua-driver")) { exit 0 }; exit 1'
wait_for() { # what seconds script
  _t=$(date +%s)
  until win "$3" >/dev/null 2>&1; do
    low
    ! ended || return 1
    [ $(($(date +%s) - _t)) -lt "$2" ] || return 1
    sleep 1
  done
  step "$1 after $(($(date +%s) - _t)) s"
}
# The guest clock in seconds against the Mac's.
offset() { _g=$(win '[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()' 2>/dev/null | tr -dc 0-9); echo $((${_g:-0} - $(date -u +%s))); }
shut_down() {
  win 'Stop-Computer -Force' >/dev/null 2>&1 || :
  _i=0
  until ended; do
    _i=$((_i + 1)); [ "$_i" -lt 300 ] || fail "Windows did not shut down within 5 minutes"
    sleep 1
  done
}
progress() { step "  $(du -h "$d/disk.qcow2" | cut -f1) on disk, $(($(kib) / 1048576)) GiB free"; }

qemu-img create -q -f qcow2 "$d/disk.qcow2" 64G
cp "$share/edk2-arm-vars.fd" "$d/vars.fd"
chmod u+w "$d/vars.fd"
# Setup draws on a plain frame buffer, which needs no driver. The ISO boots
# first and waits a few seconds for a key ("Press any key to boot from CD or
# DVD"): Down arrow answers it, until Setup writes to the disk. QEMU ends at
# Setup's first restart instead, when Windows is on the disk.
step "Windows Setup from the ISO: watch it with a VNC viewer at 127.0.0.1:$vnc_port on this Mac"
qemu_up "$d" -device ramfb -no-reboot \
  -drive "if=none,id=iso,media=cdrom,readonly=on,format=raw,file=$iso" -device usb-storage,drive=iso,bootindex=0 \
  -drive "if=none,id=answer,media=cdrom,readonly=on,format=raw,file=$w/answer.iso" -device usb-storage,drive=answer
t=$(date +%s)
started= reset= size=0 grew=$t shot=0
until ended; do
  low
  now=$(date +%s)
  s=$(du -k "$d/disk.qcow2" | cut -f1)
  [ "$s" = "$size" ] || { size=$s; grew=$now; }
  if [ -z "$started" ]; then
    if [ "$s" -gt 10240 ]; then
      started=1
      step "Setup is writing Windows to the disk"
    elif [ $((now - t)) -lt 90 ]; then
      qmp1 '{"execute":"send-key","arguments":{"keys":[{"type":"qcode","data":"down"}]}}' || :
      sleep 0.5
      continue
    elif [ $((now - t)) -ge 300 ]; then
      [ -z "$reset" ] || fail "Setup had not written to the disk 5 minutes after a restart"
      screen
      step "Setup had not written to the disk after 5 minutes; restarting the VM (the screen was $png)"
      qmp1 '{"execute":"system_reset"}' || :
      reset=1 t=$now
      continue
    fi
  fi
  [ $((now - grew)) -lt 900 ] || fail "Setup has written nothing for 15 minutes; it may show a message"
  [ $((now - t)) -lt 3600 ] || fail "Setup had not restarted after an hour"
  if [ "$now" -ge "$shot" ]; then screen; shot=$((now + 60)); fi
  sleep 5
done
low
[ "$(du -k "$d/disk.qcow2" | cut -f1)" -ge 6291456 ] ||
  die "Setup restarted before it had copied Windows: see the last screen, $png, and QEMU's output, $log"
progress
if [ "$delete_iso" = 1 ]; then
  rm -f "$iso"
  step "deleted $iso (--delete-iso)"
fi

# Setup's last passes and the first logon, which restarts Windows when done.
# Cua's daemon starts at the logon after that restart, so its pipe says the
# restart is over.
step "Windows Setup's last passes, then the first logon (C:\\bb-box\\firstlogon.log in Windows): about 10 minutes"
qemu_up "$d" -device ramfb \
  -drive "if=none,id=answer,media=cdrom,readonly=on,format=raw,file=$w/answer.iso" -device usb-storage,drive=answer
installed='if (Test-Path C:\bb-box\firstlogon-failed) { exit 2 }
if ((Test-Path C:\bb-box\firstlogon-done) -and (Get-Process explorer -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0) -and (Test-Path -LiteralPath "\\.\pipe\cua-driver")) { exit 0 }
exit 1'
t=$(date +%s)
answered= shot=0 next=$((t + 300))
while :; do
  low
  ! ended || die "QEMU ended while Windows was being set up: see the last screen, $png, and QEMU's output, $log"
  st=0
  win "$installed" >/dev/null 2>&1 || st=$?
  case $st in
    0) break ;;
    2)
      win 'Get-Content C:\bb-box\firstlogon.log -Tail 20' 2>&1 | tr -d '\r' || :
      fail "the first logon failed (above)" ;;
    255) ;;
    *) [ -n "$answered" ] || { answered=1; step "Windows answers SSH: the first logon is installing the tools"; } ;;
  esac
  now=$(date +%s)
  [ $((now - t)) -lt 5400 ] || fail "Windows was not set up within 90 minutes"
  if [ "$now" -ge "$shot" ]; then screen; shot=$((now + 60)); fi
  if [ "$now" -ge "$next" ]; then progress; next=$((now + 300)); fi
  sleep 20
done
step "installed, restarted and logged on after $(($(date +%s) - t)) s"
win 'Select-String -Path C:\bb-box\firstlogon.log -Pattern "^\d\d:\d\d:\d\d " | ForEach-Object Line' | tr -d '\r'
step "shutting Windows down"
shut_down

# One boot as a box boots, so the display's driver is in the image.
step "booting Windows once as a box boots, with its display"
qemu_up "$d" -device virtio-gpu-pci
wait_for "Windows answers SSH" 300 'exit 0' || fail "Windows did not answer SSH within 5 minutes"
wait_for "its desktop is up" 300 "$desktop_up" || fail "Windows' desktop was not up within 5 minutes"
shut_down
chmod a-w "$d/disk.qcow2"
progress

# The check: a clone, made as the backend makes a box, checked over SSH,
# saved and restored as the backend stops and starts it, and checked again.
step "checking a clone of it, as a box"
c=$w/check
mkdir "$c"
qemu-img create -q -f qcow2 -F qcow2 -b "$d/disk.qcow2" "$c/disk.qcow2"
cp "$d/vars.fd" "$c/vars.fd"
vm=$name-check
qemu_up "$c" -device virtio-gpu-pci
wait_for "the clone answers SSH" 300 'exit 0' || fail "the clone did not answer SSH within 5 minutes"
off=$(offset)
step "the clone's clock is $off s off the Mac's"
[ "${off#-}" -le 120 ] || fail "the clone's clock is $off s off the Mac's"
wait_for "the clone's desktop is up" 300 "$desktop_up" || fail "the clone's desktop was not up within 5 minutes"
scp -q -F /dev/null -i "$w/key" -P "$ssh_port" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "$w/check.ps1" box@127.0.0.1:C:/bb-box/check.ps1
checked=0
win '& C:\bb-box\check.ps1; exit $LASTEXITCODE' >"$w/check.out" 2>&1 || checked=1
tr -d '\r' <"$w/check.out"
[ "$checked" = 0 ] || fail "the check failed (above)"
# The save takes up to the VM's memory on the disk.
[ "$(kib)" -ge $((floor + 8 * 1048576)) ] || die "too little is free on this Mac to save the clone"
t=$(date +%s)
qmp_open || fail "QEMU's monitor did not answer"
r=$(qmp '{"execute":"stop"}') && r=$(qmp '{"execute":"migrate-set-parameters","arguments":{"max-bandwidth":107374182400}}') &&
  r=$(qmp "{\"execute\":\"migrate\",\"arguments\":{\"uri\":\"file:$c/state\"}}") || { qmp_close; die "QEMU could not save the clone: $r"; }
i=0
while :; do
  r=$(qmp '{"execute":"query-migrate"}') || break
  if qhas "$r" status completed || qhas "$r" status failed || qhas "$r" status cancelled; then break; fi
  i=$((i + 1)); [ "$i" -lt 1200 ] || break
  sleep 0.1
done
qhas "$r" status completed || { qmp_close; die "QEMU could not save the clone: $r"; }
qmp '{"execute":"quit"}' >/dev/null || :
qmp_close
until ended; do sleep 0.1; done
step "saved the clone in $(($(date +%s) - t)) s ($(du -h "$c/state" | cut -f1))"
low
t=$(date +%s)
qemu_up "$c" -device virtio-gpu-pci -incoming defer
qmp_open || fail "QEMU's monitor did not answer"
r=$(qmp "{\"execute\":\"migrate-incoming\",\"arguments\":{\"uri\":\"file:$c/state\"}}") || { qmp_close; fail "QEMU could not restore the clone: $r"; }
i=0
while r=$(qmp '{"execute":"query-status"}') && qhas "$r" status inmigrate; do
  i=$((i + 1)); [ "$i" -lt 600 ] || break
  sleep 0.1
done
qhas "$r" status running || qmp '{"execute":"cont"}' >/dev/null || { qmp_close; fail "the restored clone did not run on: $r"; }
qmp_close
rm -f "$c/state"
step "restored the clone in $(($(date +%s) - t)) s"
wait_for "the restored clone answers SSH" 120 'exit 0' || fail "the restored clone did not answer SSH within 2 minutes"
wait_for "the restored clone's desktop is up" 120 "$desktop_up" || fail "the restored clone's desktop was not up within 2 minutes"
step "the restored clone's clock is $(offset) s off the Mac's; setting it, as the backend does"
win "\$bbNow = [DateTimeOffset]::FromUnixTimeMilliseconds($(date +%s)000).LocalDateTime + ((Get-Date) - [Diagnostics.Process]::GetCurrentProcess().StartTime)
Set-Date -Date \$bbNow -ErrorAction Stop | Out-Null" || fail "could not set the restored clone's clock"
off=$(offset)
step "the restored clone's clock is $off s off the Mac's"
[ "${off#-}" -le 5 ] || fail "the restored clone's clock is $off s off the Mac's"
qmp1 '{"execute":"quit"}' || :
until ended; do sleep 0.1; done
rm -rf "$c"

# The new build, and `current` names it, in one rename.
printf 'built=%s\niso=%s\niso-sha256=%s\nedition=%s\nvirtio-win=%s\npwsh=%s\ngit=%s\ngh=%s\ncua=%s\nqemu=%s\nmachine=%s\n%s\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$(basename "$iso")" "$iso_sha256" "$edition" "$VIRTIO_VERSION" "$PWSH_VERSION" "$GIT_VERSION" \
  "$GH_VERSION" "$CUA_VERSION" "$(qemu-system-aarch64 --version | head -n 1)" "$machine" "$(printf '%s\n' "$key" | awk '{ print "key=" $2 }')" \
  >"$d/info"
mv "$d" "$images/$build"
d=
ln -s "$build" "$images/current.new"
/bin/mv -fh "$images/current.new" "$images/current"
done_ok=1
rm -f "$png" "$log"
old=
for b in "$images"/build.*; do
  b=${b##*/}
  case $b in "$build" | *.new | *.png | *.log) continue ;; esac
  [ -d "$images/$b" ] || continue
  grep -qx "build=$b" "$q"/vms/*/config 2>/dev/null || old="$old $b"
done
[ -z "$old" ] || step "no VM uses these older builds in $images, which can go:$old"
step "done: $name is $build ($(du -sh "$images/$build" | cut -f1) on disk, $(($(kib) / 1048576)) GiB free)"
