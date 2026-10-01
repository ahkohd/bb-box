#!/bin/bash
# Builds bb-box's Windows template on a Proxmox host, as root.
#
#   build.sh windows <vmid> [--replace] [--keep] [--sata]
#
# Installs Windows 11 unattended from BBBOX_WINDOWS_ISO with the answer file in
# answer/, in a VM on the box bridge: the VirtIO drivers and the QEMU guest
# agent, OpenSSH with PowerShell 7 and the plugin's key, Cua Driver, and user
# box logged on automatically. Then it makes the VM a template, not
# generalized, and checks a linked clone of it over SSH with check.ps1. About
# 45 minutes, nearly all of it Windows Setup and OpenSSH from Windows Update.
#
# Options: --replace  <vmid> may be a bb-box Windows template already. The new
#                     one is built and checked in another VM (BBBOX_BUILD_VMID,
#                     or the next free VMID) and only then takes its place.
#          --keep     leave the build VM when the build fails, to look at it.
#          --sata     put the disk on SATA, should Windows not boot from VirtIO
#                     SCSI (INACCESSIBLE_BOOT_DEVICE on the console).
# Settings: /etc/bb-box/bb-box.env (see ../proxmox-lxc/host/bb-box.env.example),
# and these, with their defaults:
#   BBBOX_WINDOWS_ISO=local:iso/win11.iso      Windows 11 x64, English (United States)
#   BBBOX_VIRTIO_ISO=local:iso/virtio-win.iso  the virtio-win drivers
#   BBBOX_WINDOWS_EDITION="Windows 11 Pro"     the edition to install from the ISO
#   BBBOX_WINDOWS_KEY=<Microsoft's generic key for Pro, which installs without activating>
#   BBBOX_CHECK_VMID=<the next free VMID>      the clone the check runs in
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../proxmox-lxc/host/common.sh
. "$here/../proxmox-lxc/host/common.sh"

usage() { sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ "${1:-}" = windows ] && [ $# -ge 2 ] || usage
vmid=$2
shift 2
replace='' keep='' bus=scsi
while [ $# -gt 0 ]; do
  case "$1" in
    --replace) replace=1; shift ;;
    --keep) keep=1; shift ;;
    --sata) bus=sata; shift ;;
    *) usage ;;
  esac
done
[[ "$vmid" =~ ^[0-9]+$ ]] || die "VMID must be a number"

BBBOX_WINDOWS_ISO=${BBBOX_WINDOWS_ISO:-local:iso/win11.iso}
BBBOX_VIRTIO_ISO=${BBBOX_VIRTIO_ISO:-local:iso/virtio-win.iso}
BBBOX_WINDOWS_EDITION=${BBBOX_WINDOWS_EDITION:-Windows 11 Pro}
BBBOX_WINDOWS_KEY=${BBBOX_WINDOWS_KEY:-VK7JG-NPHTM-C97JM-9MPGT-3V66T}
# What the first logon downloads, pinned by version and SHA-256.
PWSH_VERSION=7.6.6
PWSH_SHA256=958838FF55091E1C8705D89EFED0CC7E8245A3A6EF6C0CCFAE20015227108AD8
CUA_VERSION=0.30.4
CUA_SHA256=71CA8DFB3B98EDD1E897EC59715269C40610879E03AEFF6AE0E2CE709C6900C9

for tool in genisoimage jq python3 ssh scp; do command -v "$tool" >/dev/null || die "$tool is required"; done
[ -f "$BBBOX_SSH_KEY.pub" ] || die "no plugin key at $BBBOX_SSH_KEY.pub: run ../proxmox-lxc/host/setup-host.sh"
windows_iso=$(pvesm path "$BBBOX_WINDOWS_ISO" 2>/dev/null) && [ -f "$windows_iso" ] ||
  die "no Windows ISO at $BBBOX_WINDOWS_ISO (set BBBOX_WINDOWS_ISO)"
virtio_iso=$(pvesm path "$BBBOX_VIRTIO_ISO" 2>/dev/null) && [ -f "$virtio_iso" ] ||
  die "no virtio-win ISO at $BBBOX_VIRTIO_ISO (set BBBOX_VIRTIO_ISO)"

log() { echo "$(date -u +%H:%M:%S) $*"; }
# The build ID: a tag of its own on the template, which it keeps through
# --replace. Warm boxes copy it, and the plugin retires those whose template
# now has another.
build=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
in_use() { qm config "$1" >/dev/null 2>&1 || pct config "$1" >/dev/null 2>&1; }
# On LVM-thin a linked clone is a thin snapshot that needs nothing of its
# template's volume once made; elsewhere it needs the template's base volume.
thin=
[ "$(pvesh get "/storage/$BBBOX_STORAGE" --output-format json 2>/dev/null | jq -r .type)" != lvmthin ] || thin=1
linked_clones() { # vmid
  { grep -lE ":base-$1-disk-[0-9]+/" /etc/pve/nodes/*/lxc/*.conf /etc/pve/nodes/*/qemu-server/*.conf 2>/dev/null ||
    true; } | sed 's|.*/||; s|\.conf$||' | sort -n | paste -sd ' ' -
}

# With --replace, an existing <vmid> must be a Windows template this script
# made that no box needs. The build then goes to another VM ($vm), which
# replaces <vmid> only once it is checked, so a failure leaves the old one.
vm=$vmid
if in_use "$vmid"; then
  [ -n "$replace" ] || die "VMID $vmid is already in use (--replace replaces a bb-box Windows template)"
  config=$(qm config "$vmid" 2>/dev/null || true)
  grep -q '^template: 1' <<<"$config" && grep -q '^description: bb-box windows template' <<<"$config" ||
    die "$vmid is not a bb-box Windows template; --replace replaces only those"
  clones=$(linked_clones "$vmid")
  [ -z "$clones" ] || die "boxes are linked clones of template $vmid and need it ($clones); release them first"
  vm=${BBBOX_BUILD_VMID:-$(pvesh get /cluster/nextid)}
  [[ "$vm" =~ ^[0-9]+$ ]] && [ "$vm" != "$vmid" ] || die "BBBOX_BUILD_VMID must be a VMID other than $vmid"
  ! in_use "$vm" || die "VMID $vm for the build is already in use; set BBBOX_BUILD_VMID to a free one"
fi

# The answer disc. build.json holds the password, so the disc lives only as
# long as the build, and the first logon deletes its copy in the VM.
work=$(mktemp -d /var/tmp/bb-box-windows-XXXXXX)
iso_store=${BBBOX_WINDOWS_ISO%%:*}
answer_name=bb-box-answer-$vm.iso
answer_iso=$(dirname "$windows_iso")/$answer_name
check_vm=
done_ok=
created=
cleanup() {
  rm -rf "$work"
  rm -f "$answer_iso"
  if [ -n "$check_vm" ] && in_use "$check_vm"; then qm stop "$check_vm" >/dev/null 2>&1 || true; qm destroy "$check_vm" --purge 1 >/dev/null 2>&1 || true; fi
  [ -z "$done_ok" ] && [ -n "$created" ] || return 0
  if [ -n "$keep" ]; then
    echo "build VM $vm kept (--keep); remove it with: qm stop $vm; qm destroy $vm --purge 1"
  else
    echo "removing build VM $vm"
    qm stop "$vm" >/dev/null 2>&1 || true
    qm destroy "$vm" --purge 1 >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
# Ctrl-C or systemctl stop cleans up too.
trap 'exit 1' INT TERM

password=$(python3 -c 'import secrets, string; a = string.ascii_letters + string.digits; print("".join(secrets.choice(a) for _ in range(24)))')
cp -r "$here/answer" "$work/answer"
python3 - "$work/answer/autounattend.xml" "$password" "$BBBOX_WINDOWS_EDITION" "$BBBOX_WINDOWS_KEY" <<'EOF'
import sys
from xml.sax.saxutils import escape
path, password, edition, key = sys.argv[1:]
text = open(path).read()
for name, value in (("PASSWORD", password), ("EDITION", edition), ("PRODUCT_KEY", key)):
    text = text.replace(f"@{name}@", escape(value))
open(path, "w").write(text)
EOF
python3 - "$work/answer/bb-box/build.json" <<EOF
import json, sys
json.dump({
    "address": "$BBBOX_BUILD_ADDRESS/$BBBOX_PREFIX",
    "gateway": "$BBBOX_GATEWAY",
    "dns": "$BBBOX_DNS".split(),
    "keys": [line.strip() for line in open("$BBBOX_SSH_KEY.pub") if line.strip()],
    "password": "$password",
    "pwsh": {"version": "$PWSH_VERSION", "sha256": "$PWSH_SHA256",
             "url": "https://github.com/PowerShell/PowerShell/releases/download/v$PWSH_VERSION/PowerShell-$PWSH_VERSION-win-x64.msi"},
    "cua": {"version": "$CUA_VERSION", "sha256": "$CUA_SHA256",
            "url": "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$CUA_VERSION/cua-driver-rs-$CUA_VERSION-windows-x86_64.zip"},
}, open(sys.argv[1], "w"), indent=2)
EOF
genisoimage -quiet -J -r -V BBBOXANSWER -o "$answer_iso" "$work/answer"
chmod 600 "$answer_iso"

if [ "$bus" = sata ]; then
  disk=(--sata0 "$BBBOX_STORAGE:64,discard=on,ssd=1") boot_disk=sata0
else
  disk=(--scsihw virtio-scsi-single --scsi0 "$BBBOX_STORAGE:64,iothread=1,discard=on,ssd=1") boot_disk=scsi0
fi
# A template waits at its kind's default size (028): 4 cores and 8 GiB.
log "creating build VM $vm ($BBBOX_WINDOWS_EDITION from $(basename "$windows_iso"), disk on $bus)"
qm create "$vm" --name "bb-box-windows-$vm" --pool "$BBBOX_POOL" --ostype win11 --machine q35 --bios ovmf \
  --cpu host --cores 4 --memory 8192 --balloon 0 \
  --efidisk0 "$BBBOX_STORAGE:1,efitype=4m,pre-enrolled-keys=1" --tpmstate0 "$BBBOX_STORAGE:1,version=v2.0" \
  "${disk[@]}" --net0 "virtio,bridge=$BBBOX_BRIDGE" --vga virtio --agent enabled=1 \
  --ide2 "$BBBOX_WINDOWS_ISO,media=cdrom" --ide0 "$BBBOX_VIRTIO_ISO,media=cdrom" --ide3 "$iso_store:iso/$answer_name,media=cdrom" \
  --boot "order=$boot_disk;ide2" --tags "bbbox;windows;$build" --description "bb-box windows template being built, $(date -u +%F)"
created=1
qm start "$vm"
# Past the ISO's "Press any key to boot from CD or DVD".
for _ in $(seq 20); do qm sendkey "$vm" ret >/dev/null 2>&1 || true; sleep 1; done

# A PowerShell command in the VM through the guest agent: its output, and
# success when it exited 0.
gexec() { # vmid timeout command
  qm guest exec "$1" --timeout "$2" -- powershell -NoProfile -Command "$3" 2>/dev/null |
    python3 -c 'import json, sys; d = sys.stdin.read(); i = d.find("{"); o = json.loads(d[i:]) if i >= 0 else {}; sys.stdout.write(o.get("out-data", "")); sys.exit(o.get("exitcode", 1) if o.get("exited") else 1)'
}
wait_for() { # what seconds interval command...
  local what=$1 limit=$2 interval=$3 start
  start=$(date +%s)
  shift 3
  until "$@" >/dev/null 2>&1; do
    [ $(($(date +%s) - start)) -lt "$limit" ] || { log "$what: not within $limit s"; return 1; }
    sleep "$interval"
  done
  log "$what after $(($(date +%s) - start)) s"
}
screen() { # vmid: the console as a PPM image, for a failed build
  echo "screendump $work/../bb-box-windows-$1.ppm" | qm monitor "$1" >/dev/null 2>&1 &&
    echo "console of VM $1: /var/tmp/bb-box-windows-$1.ppm"
}
# Exit 0 once installed, restarted and logged on with Cua; 2 if the first
# logon failed; 1 while it is not there yet.
installed() { gexec "$vm" 20 'if (Test-Path C:\bb-box\firstlogon-failed) { exit 2 }; if ((Test-Path C:\bb-box\firstlogon-done) -and (Get-Service sshd).Status -eq "Running" -and (Get-Process cua-driver -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0)) { exit 0 } else { exit 1 }'; }

log "Windows Setup, then the first logon (C:\\bb-box\\firstlogon.log in the VM)"
start=$(date +%s)
while :; do
  state=0
  installed >/dev/null 2>&1 || state=$?
  [ "$state" != 0 ] || break
  if [ "$state" = 2 ] || [ $(($(date +%s) - start)) -ge 6000 ]; then
    screen "$vm"
    gexec "$vm" 30 'Get-Content C:\bb-box\firstlogon.log -Tail 20' || true
    die "Windows did not finish installing in VM $vm (above)"
  fi
  sleep 20
done
log "installed, restarted and logged on after $(($(date +%s) - start)) s"
gexec "$vm" 30 'Select-String -Path C:\bb-box\firstlogon.log -Pattern "^\d\d:\d\d:\d\d " | ForEach-Object Line'

# The template: no build address (clones take theirs from the SMBIOS serial),
# no CD drives, stopped.
gexec "$vm" 60 '$n = Get-NetAdapter -Physical | Select-Object -First 1; Remove-NetRoute -InterfaceIndex $n.ifIndex -DestinationPrefix 0.0.0.0/0 -Confirm:$false -ErrorAction SilentlyContinue; Get-NetIPAddress -InterfaceIndex $n.ifIndex -AddressFamily IPv4 | Remove-NetIPAddress -Confirm:$false; Set-NetIPInterface -InterfaceIndex $n.ifIndex -Dhcp Enabled; Clear-Content C:\bb-box\boot.log' >/dev/null ||
  die "could not clear the build address in VM $vm"
qm shutdown "$vm" --timeout 300
qm set "$vm" --delete ide0,ide2,ide3 >/dev/null
rm -f "$answer_iso"
qm template "$vm"
log "VM $vm is a template; checking a linked clone of it"

# The check: a linked clone with the build address in its serial, reached
# over SSH as the backend reaches a box.
check_vm=${BBBOX_CHECK_VMID:-$(pvesh get /cluster/nextid)}
if in_use "$check_vm"; then taken=$check_vm check_vm=; die "VMID $taken for the check is already in use; set BBBOX_CHECK_VMID to a free one"; fi
qm clone "$vm" "$check_vm" --name bb-box-windows-check --pool "$BBBOX_POOL" >/dev/null
serial=$(printf '%s/%s %s' "$BBBOX_BUILD_ADDRESS" "$BBBOX_PREFIX" "$BBBOX_GATEWAY" | base64 -w0)
qm set "$check_vm" --smbios1 "base64=1,uuid=$(cat /proc/sys/kernel/random/uuid),serial=$serial" >/dev/null
ssh_box() { ssh -i "$BBBOX_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=3 "box@$BBBOX_BUILD_ADDRESS" "$@"; }
desktop_up() { ssh_box 'if (Get-Process cua-driver -ErrorAction SilentlyContinue | Where-Object SessionId -gt 0) { cua-driver status *> $null; exit $LASTEXITCODE } else { exit 1 }'; }
qm start "$check_vm"
wait_for "a clone answers SSH" 300 1 ssh_box exit || { screen "$check_vm"; die "a clone of the template did not answer SSH at $BBBOX_BUILD_ADDRESS"; }
wait_for "a clone's desktop has Cua" 300 1 desktop_up || die "Cua did not start in a clone's desktop session"
scp -q -i "$BBBOX_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$here/check.ps1" "box@$BBBOX_BUILD_ADDRESS:C:/bb-box/check.ps1"
checked=0
ssh_box '& C:\bb-box\check.ps1' || checked=$?
# The warm pool hibernates boxes and resumes them (039), so the clone must too.
if [ "$checked" = 0 ]; then
  start=$(date +%s%N)
  qm suspend "$check_vm" --todisk 1 >/dev/null
  log "the clone hibernated in $((($(date +%s%N) - start) / 1000000)) ms"
  sleep 5
  start=$(date +%s%N)
  qm start "$check_vm" >/dev/null
  log "qm start resumed the clone in $((($(date +%s%N) - start) / 1000000)) ms"
  wait_for "the resumed clone answers SSH" 120 1 ssh_box exit &&
    wait_for "the resumed clone's Cua answers" 120 1 desktop_up || checked=1
  clock=$(ssh_box '[DateTimeOffset]::UtcNow.ToUnixTimeSeconds()' 2>/dev/null || echo 0)
  log "the resumed clone's clock is $((clock - $(date -u +%s))) s off the host's (the backend sets it)"
fi
qm stop "$check_vm" >/dev/null
qm destroy "$check_vm" --purge 1 >/dev/null
check_vm=
[ "$checked" = 0 ] || die "the check failed (above)"

description="bb-box windows template, built $(date -u +%F) from $(basename "$windows_iso"): $BBBOX_WINDOWS_EDITION, PowerShell $PWSH_VERSION, Cua Driver $CUA_VERSION."
# The pool's ACL lets the plugin's token delete guests in it; protection keeps
# it from deleting templates. Clones inherit the flag, so the plugin clears it
# on each box (delete=protection) when it configures the box.
if [ "$vm" = "$vmid" ]; then
  qm set "$vmid" --name "bb-box-windows" --description "$description" --protection 1 >/dev/null
else
  # Puts the checked template in <vmid>'s place. On LVM-thin the new one is a
  # linked clone of the build, which takes seconds; elsewhere a full copy.
  log "replacing template $vmid with $vm"
  qm set "$vmid" --protection 0 >/dev/null
  start=$(date +%s%N)
  qm destroy "$vmid" || { qm set "$vmid" --protection 1 >/dev/null; die "could not remove template $vmid"; }
  if [ -n "$thin" ]; then
    qm clone "$vm" "$vmid" --name bb-box-windows --pool "$BBBOX_POOL" >/dev/null
  else
    qm clone "$vm" "$vmid" --name bb-box-windows --pool "$BBBOX_POOL" --full 1 --storage "$BBBOX_STORAGE" >/dev/null
  fi
  qm template "$vmid"
  echo "template $vmid was missing for $((($(date +%s%N) - start) / 1000000)) ms"
  qm set "$vmid" --description "$description" --tags "bbbox;windows;$build" --protection 1 >/dev/null
  qm destroy "$vm" --purge 1 >/dev/null
fi
done_ok=1
log "Windows template $vmid ready ($build)"
