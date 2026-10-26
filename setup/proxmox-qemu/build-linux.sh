#!/bin/bash
# Builds bb-box's Linux VM templates on a Proxmox host, as root (057).
#
#   build.sh linux <vmid> [--replace] [--keep]
#   build.sh linux-desktop <vmid> [--replace] [--keep]
#       the Linux desktop template, for linux-desktop-cpu boxes: the Linux
#       one with the CPU desktop of Proxmox LXC's desktop-cpu template
#   build.sh android <vmid> [--replace] [--keep] [--with-x264]
#       the Android template (063), for android boxes: the Linux one with
#       ../android/customize-android.sh, the SDK, the emulator and an AVD
#       with its snapshot for each device. It needs the operator's
#       acceptance of the Android SDK's licence first, as
#       ../android/accept-sdk-licence.sh writes it, and KVM in the build VM.
#       --with-x264 builds x264 from source for bb-box-h264.
#
# Imports Ubuntu 24.04's cloud image, pinned by its SHA-256, as a VM on the
# box bridge, and boots it once with cloud-init, which gives it the build
# address and the plugin's key. Then it runs the Linux template's guest
# scripts in it (../proxmox-lxc/template/guest/, with BOX_RUNTIME=vm) and
# linux/, boots it again as a box would, checks it as the box user,
# finalizes it and makes it a template. Last, it checks a linked clone of it
# over SSH: its address from the SMBIOS serial, its root grown over a bigger
# disk, and a hibernate and resume.
#
# Options: --replace  <vmid> may be a bb-box Linux VM template of the same
#                     kind already. The new one is built and checked in
#                     another VM (BBBOX_BUILD_VMID, or the next free VMID)
#                     and only then takes its place.
#          --keep     leave the build VM when the build fails, to look at it.
# Settings: /etc/bb-box/bb-box.env (see
# ../proxmox-lxc/host/bb-box.env.example), BBBOX_CHECK_VMID, the clone
# the check runs in (the next free VMID), and for android
# BBBOX_ANDROID_LICENCE, the acceptance (/etc/bb-box/android-sdk-license).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../proxmox-lxc/host/common.sh
. "$here/../proxmox-lxc/host/common.sh"

usage() { sed -n '2,33p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
kind=${1:-}
case "$kind" in linux | linux-desktop | android) ;; *) usage ;; esac
[ $# -ge 2 ] || usage
vmid=$2
shift 2
replace='' keep='' x264=''
while [ $# -gt 0 ]; do
  case "$1" in
    --replace) replace=1; shift ;;
    --keep) keep=1; shift ;;
    --with-x264) [ "$kind" = android ] || usage; x264=yes; shift ;;
    *) usage ;;
  esac
done
[[ "$vmid" =~ ^[0-9]+$ ]] || die "VMID must be a number"

# The base: Ubuntu 24.04's cloud image, pinned by release and SHA-256. It
# must be older than the apt snapshot the guest scripts install from, whose
# packages then are as new as the image's or newer. A newer image has
# libraries the snapshot's -dev packages cannot match.
IMAGE_RELEASE=20260911
IMAGE_SHA256=612b2c0cc1bc413a6cb8c38fd611794caf0f2b436c50013d8b3794db12ad7354
IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release-$IMAGE_RELEASE/ubuntu-24.04-server-cloudimg-amd64.img
# The template waits at its kind's default size (028), on the LXC
# template's disk. Each kind's artifacts, finalize.sh's kind and check.
if [ "$kind" = linux ]; then
  cores=2 memory=4096 disk=16 artifacts=linux finalize=linux check=bb-box-check-headless
elif [ "$kind" = android ]; then
  cores=8 memory=16384 disk=48 artifacts=linux finalize=android check=bb-box-check-android
else
  cores=4 memory=8192 disk=24 artifacts=desktop-cpu finalize=desktop check=bb-box-check-desktop
fi
name=bb-box-$kind

for tool in curl jq ssh sha256sum; do command -v "$tool" >/dev/null || die "$tool is required"; done
licence=${BBBOX_ANDROID_LICENCE:-/etc/bb-box/android-sdk-license}
if [ "$kind" = android ]; then
  accepted=$(jq -r .license.accepted "$here/../android/pins.json")
  grep -qx "$accepted" "$licence" 2>/dev/null ||
    die "the Android SDK's licence is not accepted in $licence: run ../android/accept-sdk-licence.sh, which shows its terms, then build again"
fi
template=$here/../proxmox-lxc/template
snapshot=$(cut -c1-8 "$template/apt-snapshot")
[ "$IMAGE_RELEASE" -lt "$snapshot" ] ||
  die "the cloud image ($IMAGE_RELEASE) is not older than the apt snapshot ($snapshot): pin an older image release"
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
# Waits for a command to succeed: what for, how long, how often, the command.
wait_for() { # what seconds interval command...
  local what=$1 deadline=$(($(date +%s) + $2)) interval=$3
  shift 3
  until "$@" >/dev/null 2>&1; do
    [ "$(date +%s)" -lt "$deadline" ] || { log "timed out waiting for $what"; return 1; }
    sleep "$interval"
  done
}

# With --replace, an existing <vmid> must be a VM template this script made,
# of the same kind, that no box needs. The build then goes to another VM
# ($vm), which replaces <vmid> only once it is checked, so a failure leaves
# the old one.
vm=$vmid
if in_use "$vmid"; then
  [ -n "$replace" ] || die "VMID $vmid is already in use (--replace replaces a bb-box $kind VM template)"
  config=$(qm config "$vmid" 2>/dev/null || true)
  grep -q '^template: 1' <<<"$config" && grep -q "^description: bb-box $kind vm template" <<<"$config" ||
    die "$vmid is not a bb-box $kind VM template; --replace replaces only those"
  clones=$(linked_clones "$vmid")
  [ -z "$clones" ] || die "boxes are linked clones of template $vmid and need it ($clones); release them first"
  vm=${BBBOX_BUILD_VMID:-$(pvesh get /cluster/nextid)}
  [[ "$vm" =~ ^[0-9]+$ ]] && [ "$vm" != "$vmid" ] || die "BBBOX_BUILD_VMID must be a VMID other than $vmid"
  ! in_use "$vm" || die "VMID $vm for the build is already in use; set BBBOX_BUILD_VMID to a free one"
fi

# The plugin's key, as the LXC template build makes it.
[ -f "$BBBOX_SSH_KEY" ] || {
  install -d -m 0700 "$(dirname "$BBBOX_SSH_KEY")"
  ssh-keygen -q -t ed25519 -N '' -C "bb-box plugin" -f "$BBBOX_SSH_KEY"
  echo "created the plugin's SSH key $BBBOX_SSH_KEY"
}

# The cloud image, downloaded once and checked each time.
images=/var/cache/bb-box/images
image=$images/ubuntu-24.04-server-cloudimg-amd64-$IMAGE_RELEASE.img
install -d -m 0755 "$images"
if ! echo "$IMAGE_SHA256  $image" | sha256sum -c --status 2>/dev/null; then
  log "downloading Ubuntu 24.04's cloud image ($IMAGE_RELEASE)"
  curl -fsSL --retry 3 -o "$image.part" "$IMAGE_URL"
  echo "$IMAGE_SHA256  $image.part" | sha256sum -c --status || { rm -f "$image.part"; die "the cloud image's SHA-256 is not the pinned one"; }
  mv "$image.part" "$image"
fi

# The build directory, as the LXC template build stages it, with linux/.
cache=/var/cache/bb-box/artifacts
stage=$(mktemp -d /var/tmp/bb-box-linux-vm-XXXXXX)
in_vm=/var/tmp/bb-box-build
bash "$template/fetch-artifacts.sh" "$cache" "$artifacts"
install -d -m 0700 "$stage/artifacts"
cp -r "$template/guest" "$template/pins.json" "$template/desktop-pins.tsv" "$template/baseline-packages.txt" "$template/apt-snapshot" "$here/linux" "$stage/"
cp "$BBBOX_SSH_KEY.pub" "$stage/plugin-key.pub"
[ "$kind" != android ] || { cp -r "$here/../android" "$stage/"; cp "$licence" "$stage/android-sdk-license"; }
cat >"$stage/build.env" <<EOF
BOX_USER=box
BOX_RUNTIME=vm
BOX_DNS="$BBBOX_DNS"
BB_URL="$BBBOX_BB_URL"
DESKTOP_GPU=none
BUILD_ID=$build
ANDROID_X264=$x264
EOF
for f in "$cache"/*; do
  case "${f##*/}" in *.run | *.run.sha256sum | *.deb | cua-driver-* | rustup-init) [ "$kind" = linux-desktop ] || continue ;; esac
  ln "$f" "$stage/artifacts/" 2>/dev/null || cp "$f" "$stage/artifacts/"
done

check_vm=
done_ok=
created=
cleanup() {
  local status=$?
  rm -rf "$stage"
  if [ -n "$check_vm" ] && in_use "$check_vm"; then qm stop "$check_vm" >/dev/null 2>&1 || true; qm destroy "$check_vm" --purge 1 >/dev/null 2>&1 || true; fi
  if [ -z "$done_ok" ] && [ -n "$created" ]; then
    if [ -n "$keep" ]; then
      echo "build VM $vm kept (--keep); remove it with: qm stop $vm; qm destroy $vm --purge 1"
    else
      echo "removing build VM $vm"
      qm stop "$vm" >/dev/null 2>&1 || true
      qm destroy "$vm" --purge 1 >/dev/null 2>&1 || true
    fi
  fi
  # The last line, for anything watching the log.
  echo "exit $status"
}
trap cleanup EXIT
trap 'exit 1' INT TERM

# The SMBIOS serial a clone's boot script reads: the address with its
# prefix, then the gateway. The build VM has it too, for its boots after
# cloud-init's.
serial=$(printf '%s/%s %s' "$BBBOX_BUILD_ADDRESS" "$BBBOX_PREFIX" "$BBBOX_GATEWAY" | base64 -w0)
# Cloud-init gives the first boot its address, the key and the box user,
# and nothing from apt: --ciupgrade 0, as Proxmox's default upgrades every
# package from the live archive at first boot, past the apt snapshot the
# guest scripts install from, whose -dev packages then cannot match.
log "creating build VM $vm from the cloud image"
created=1
qm create "$vm" --name "$name-build" --pool "$BBBOX_POOL" --ostype l26 --machine q35 --cpu host \
  --cores 16 --memory 16384 --balloon 0 --scsihw virtio-scsi-single --agent enabled=1 \
  --scsi0 "$BBBOX_STORAGE:0,import-from=$image,discard=on,iothread=1,ssd=1" --boot order=scsi0 \
  --ide2 "$BBBOX_STORAGE:cloudinit" --serial0 socket --net0 "virtio,bridge=$BBBOX_BRIDGE" \
  --smbios1 "base64=1,uuid=$(cat /proc/sys/kernel/random/uuid),serial=$serial" --tags "$build" \
  --ciuser box --ciupgrade 0 --sshkeys "$BBBOX_SSH_KEY.pub" --ipconfig0 "ip=$BBBOX_BUILD_ADDRESS/$BBBOX_PREFIX,gw=$BBBOX_GATEWAY" \
  --nameserver "$BBBOX_DNS" --onboot 0 >/dev/null
qm resize "$vm" scsi0 "${disk}G" >/dev/null
qm start "$vm"

ssh_box() { ssh -i "$BBBOX_SSH_KEY" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR -o ConnectTimeout=3 "box@$BBBOX_BUILD_ADDRESS" "$@"; }
wait_for "the build VM answers SSH" 300 2 ssh_box exit || die "the build VM did not answer SSH at $BBBOX_BUILD_ADDRESS"
ssh_box 'cloud-init status --wait' >/dev/null || true
push() { tar -C "$stage" -cf - . | ssh_box "sudo sh -c 'rm -rf $in_vm && mkdir -p $in_vm && tar -xf - -C $in_vm --no-same-owner'"; }
push

log "customising the build VM (the Linux template's customize-base.sh)"
ssh_box "sudo bash $in_vm/guest/customize-base.sh $in_vm" </dev/null
ssh_box "sudo bash $in_vm/linux/customize-vm.sh $in_vm" </dev/null
[ "$kind" != linux-desktop ] || ssh_box "sudo bash $in_vm/guest/customize-desktop.sh $in_vm" </dev/null
if [ "$kind" = android ]; then
  ssh_box 'python3 -c "import fcntl, os; fcntl.ioctl(os.open(\"/dev/kvm\", os.O_RDWR), 0xAE01, 0)"' </dev/null 2>/dev/null ||
    ssh_box 'sudo python3 -c "import fcntl, os; fcntl.ioctl(os.open(\"/dev/kvm\", os.O_RDWR), 0xAE01, 0)"' </dev/null ||
    die "KVM does not work in the build VM, and the emulator needs it: allow nested virtualization on the host (kvm_amd or kvm_intel nested=1)"
  log "the Android layer (../android/customize-android.sh): the SDK, bb-box-h264, the device's firewall, and each device's AVD and snapshot"
  ssh_box "sudo bash $in_vm/android/customize-android.sh $in_vm" </dev/null
fi

# Boot it again as a box would, with its address from the serial, and check it
# as the box user.
log "booting the build VM again, as a box would, and checking it as the box user"
# Which boot the VM is in. The reboot is done once SSH answers from another
# boot: SSH can refuse, or still answer, while the old boot stops.
boot_id() { ssh_box 'cat /proc/sys/kernel/random/boot_id' </dev/null 2>/dev/null; }
booted_since() { local id; id=$(boot_id) && [ -n "$id" ] && [ "$id" != "$1" ]; }
# The guest scripts change SSH's units and settings under the running
# server, which can reset a connection for a while, so wait for it first.
wait_for "the build VM answers SSH before its reboot" 120 2 ssh_box true ||
  die "the build VM stopped answering SSH after its guest scripts"
before=$(boot_id) && [ -n "$before" ] || die "could not read the build VM's boot ID"
# The guest reboots a moment after SSH returns, so the command cannot hang
# on a connection the reboot drops. SSH's 255 means the connection went,
# which the reboot may have done already.
code=0
ssh_box 'sudo systemd-run --quiet --on-active=2 systemctl reboot' </dev/null || code=$?
[ "$code" = 0 ] || [ "$code" = 255 ] || die "the build VM refused to reboot (exit $code)"
wait_for "the build VM answers SSH from a new boot" 300 2 booted_since "$before" ||
  die "the build VM did not come back after its reboot"
ssh_box 'timeout 120 systemctl is-system-running --wait' >/dev/null </dev/null || true
ssh_box "bash -lc $check" </dev/null | tee "$stage/check.txt"
! grep -q '^[^ ].* FAIL ' "$stage/check.txt" || die "checks failed (above)"

log "finalizing the build VM"
# The image's record (049), which the template's description carries for the
# plugin's doctor, as its second line. It is read in finalize.sh's session:
# finalize.sh removes the SSH host keys, so no new connection can be made.
# Its own output goes to stderr, so the record is all there is on stdout.
record=$(ssh_box "sudo bash $in_vm/guest/finalize.sh $in_vm $finalize >&2 && cat /usr/share/bb-box/image.json" </dev/null | jq -c .) ||
  die "finalizing failed, or the template has no image record"
[ -n "$record" ] || die "the template has no image record"
qm shutdown "$vm" --timeout 120
# Clones get their address from the backend's serial; the template has none.
qm set "$vm" --delete ide2,ciuser,sshkeys,ipconfig0,nameserver,serial0 --cores "$cores" --memory "$memory" \
  --smbios1 "uuid=$(cat /proc/sys/kernel/random/uuid)" >/dev/null
qm template "$vm"
log "VM $vm is a template; checking a linked clone of it"

# The check: a linked clone with the build address in its serial and a bigger
# disk, reached over SSH as the backend reaches a box.
check_vm=${BBBOX_CHECK_VMID:-$(pvesh get /cluster/nextid)}
if in_use "$check_vm"; then taken=$check_vm check_vm=; die "VMID $taken for the check is already in use; set BBBOX_CHECK_VMID to a free one"; fi
qm clone "$vm" "$check_vm" --name "$name-check" --pool "$BBBOX_POOL" >/dev/null
qm set "$check_vm" --smbios1 "base64=1,uuid=$(cat /proc/sys/kernel/random/uuid),serial=$serial" >/dev/null
qm resize "$check_vm" scsi0 "$((disk + 4))G" >/dev/null
start=$(date +%s%N)
qm start "$check_vm"
wait_for "a clone answers SSH" 300 1 ssh_box exit || die "a clone of the template did not answer SSH at $BBBOX_BUILD_ADDRESS"
log "a clone answered SSH $((($(date +%s%N) - start) / 1000000)) ms after qm start"
checked=0
root_gib=$(ssh_box 'df -BG --output=size / | tail -1' </dev/null | tr -dc 0-9)
log "a clone's root is ${root_gib:-?} GiB on a $((disk + 4)) GiB disk"
[ "${root_gib:-0}" -gt "$disk" ] || { log "the clone's root did not grow over its disk"; checked=1; }
ssh_box "bash -lc $check" </dev/null | tee "$stage/check.txt" || checked=1
! grep -q '^[^ ].* FAIL ' "$stage/check.txt" || checked=1
# KVM in the box, as the box user: where it works, the backend's linux-kvm
# setting can offer it. Not a failure: the host may not allow nested
# virtualization.
if ssh_box 'python3 -c "import fcntl, os; fcntl.ioctl(os.open(\"/dev/kvm\", os.O_RDWR), 0xAE01, 0)"' </dev/null 2>/dev/null; then
  log "KVM works in a clone, as the box user: turn on linux-kvm in Proxmox QEMU's settings to offer it"
else
  log "KVM does not work in a clone: the host may not allow nested virtualization, so leave linux-kvm off"
fi
# Spares wait hibernated (#612), so the clone must hibernate and resume.
if [ "$checked" = 0 ]; then
  clone_boot=$(boot_id)
  start=$(date +%s%N)
  qm suspend "$check_vm" --todisk 1 >/dev/null
  log "the clone hibernated in $((($(date +%s%N) - start) / 1000000)) ms"
  sleep 5
  start=$(date +%s%N)
  qm start "$check_vm" >/dev/null
  wait_for "the resumed clone answers SSH" 120 1 ssh_box exit || checked=1
  log "the clone resumed and answered SSH in $((($(date +%s%N) - start) / 1000000)) ms"
  # A resume keeps the boot; another boot ID means the clone booted afresh.
  [ "$(boot_id)" = "$clone_boot" ] || { log "the clone booted again instead of resuming"; checked=1; }
fi
qm stop "$check_vm" >/dev/null
qm destroy "$check_vm" --purge 1 >/dev/null
check_vm=
[ "$checked" = 0 ] || die "the check failed (above)"

description="bb-box $kind vm template, built $(date -u +%F) from Ubuntu 24.04's cloud image $IMAGE_RELEASE.
$record"
# The pool's ACL lets the plugin's token delete guests in it; protection keeps
# it from deleting templates. Clones inherit the flag, so the plugin clears it
# on each box (delete=protection) when it configures the box.
if [ "$vm" = "$vmid" ]; then
  qm set "$vmid" --name "$name" --description "$description" --tags "bbbox;$kind;$build" --protection 1 >/dev/null
else
  # Puts the checked template in <vmid>'s place. On LVM-thin the new one is a
  # linked clone of the build, which takes seconds; elsewhere a full copy.
  log "replacing template $vmid with $vm"
  qm set "$vmid" --protection 0 >/dev/null
  start=$(date +%s%N)
  qm destroy "$vmid" || { qm set "$vmid" --protection 1 >/dev/null; die "could not remove template $vmid"; }
  if [ -n "$thin" ]; then
    qm clone "$vm" "$vmid" --name "$name" --pool "$BBBOX_POOL" >/dev/null
  else
    qm clone "$vm" "$vmid" --name "$name" --pool "$BBBOX_POOL" --full 1 --storage "$BBBOX_STORAGE" >/dev/null
  fi
  qm template "$vmid"
  echo "template $vmid was missing for $((($(date +%s%N) - start) / 1000000)) ms"
  qm set "$vmid" --description "$description" --tags "bbbox;$kind;$build" --protection 1 >/dev/null
  qm destroy "$vm" --purge 1 >/dev/null
fi
done_ok=1
log "$kind VM template $vmid ready ($build)"
