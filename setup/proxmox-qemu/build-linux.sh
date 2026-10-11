#!/bin/bash
# Builds bb-box's Linux VM template on a Proxmox host, as root (057).
#
#   build.sh linux <vmid> [--replace] [--keep]
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
# Options: --replace  <vmid> may be a bb-box Linux VM template already. The
#                     new one is built and checked in another VM
#                     (BBBOX_BUILD_VMID, or the next free VMID) and only then
#                     takes its place.
#          --keep     leave the build VM when the build fails, to look at it.
# Settings: /etc/bb-box/bb-box.env (see
# ../proxmox-lxc/host/bb-box.env.example), and BBBOX_CHECK_VMID, the clone
# the check runs in (the next free VMID).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../proxmox-lxc/host/common.sh
. "$here/../proxmox-lxc/host/common.sh"

usage() { sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
[ $# -ge 1 ] || usage
vmid=$1
shift
replace='' keep=''
while [ $# -gt 0 ]; do
  case "$1" in
    --replace) replace=1; shift ;;
    --keep) keep=1; shift ;;
    *) usage ;;
  esac
done
[[ "$vmid" =~ ^[0-9]+$ ]] || die "VMID must be a number"

# The base: Ubuntu 24.04's cloud image, pinned by release and SHA-256.
IMAGE_RELEASE=20260926
IMAGE_SHA256=6a81c37564db9b1ee84e141922625e1d7c5b389b99bb3c572e0243607d5bb4d2
IMAGE_URL=https://cloud-images.ubuntu.com/releases/noble/release-$IMAGE_RELEASE/ubuntu-24.04-server-cloudimg-amd64.img
# The template waits at the linux kind's default size (028), on the LXC
# template's disk.
cores=2 memory=4096 disk=16

for tool in curl jq ssh sha256sum; do command -v "$tool" >/dev/null || die "$tool is required"; done
template=$here/../proxmox-lxc/template
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

# With --replace, an existing <vmid> must be a Linux VM template this script
# made that no box needs. The build then goes to another VM ($vm), which
# replaces <vmid> only once it is checked, so a failure leaves the old one.
vm=$vmid
if in_use "$vmid"; then
  [ -n "$replace" ] || die "VMID $vmid is already in use (--replace replaces a bb-box Linux VM template)"
  config=$(qm config "$vmid" 2>/dev/null || true)
  grep -q '^template: 1' <<<"$config" && grep -q '^description: bb-box linux vm template' <<<"$config" ||
    die "$vmid is not a bb-box Linux VM template; --replace replaces only those"
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
bash "$template/fetch-artifacts.sh" "$cache" linux
install -d -m 0700 "$stage/artifacts"
cp -r "$template/guest" "$template/pins.json" "$template/desktop-pins.tsv" "$template/baseline-packages.txt" "$template/apt-snapshot" "$here/linux" "$stage/"
cp "$BBBOX_SSH_KEY.pub" "$stage/plugin-key.pub"
cat >"$stage/build.env" <<EOF
BOX_USER=box
BOX_RUNTIME=vm
BOX_DNS="$BBBOX_DNS"
BB_URL="$BBBOX_BB_URL"
DESKTOP_GPU=none
BUILD_ID=$build
EOF
for f in "$cache"/*; do
  case "${f##*/}" in *.run | *.run.sha256sum | *.deb | cua-driver-* | rustup-init) continue ;; esac
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
log "creating build VM $vm from the cloud image"
created=1
qm create "$vm" --name bb-box-linux-build --pool "$BBBOX_POOL" --ostype l26 --machine q35 --cpu host \
  --cores 16 --memory 16384 --balloon 0 --scsihw virtio-scsi-single --agent enabled=1 \
  --scsi0 "$BBBOX_STORAGE:0,import-from=$image,discard=on,iothread=1,ssd=1" --boot order=scsi0 \
  --ide2 "$BBBOX_STORAGE:cloudinit" --serial0 socket --net0 "virtio,bridge=$BBBOX_BRIDGE" \
  --smbios1 "base64=1,uuid=$(cat /proc/sys/kernel/random/uuid),serial=$serial" --tags "$build" \
  --ciuser box --sshkeys "$BBBOX_SSH_KEY.pub" --ipconfig0 "ip=$BBBOX_BUILD_ADDRESS/$BBBOX_PREFIX,gw=$BBBOX_GATEWAY" \
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

# Boot it again as a box would, with its address from the serial, and check it
# as the box user.
log "booting the build VM again, as a box would, and checking it as the box user"
down() { ! ssh_box exit; }
timeout 30 ssh_box 'sudo systemctl reboot' </dev/null || true
wait_for "the build VM to go down" 120 1 down || die "the build VM did not reboot"
wait_for "the build VM answers SSH again" 300 2 ssh_box exit || die "the build VM did not come back after its reboot"
ssh_box 'timeout 120 systemctl is-system-running --wait' >/dev/null </dev/null || true
ssh_box 'bash -lc bb-box-check-headless' </dev/null | tee "$stage/check.txt"
! grep -q '^[^ ].* FAIL ' "$stage/check.txt" || die "checks failed (above)"

log "finalizing the build VM"
ssh_box "sudo bash $in_vm/guest/finalize.sh $in_vm linux" </dev/null
# The image's record (049), which the template's description carries for the
# plugin's doctor, as its second line.
record=$(ssh_box 'cat /usr/share/bb-box/image.json' </dev/null | jq -c .) || die "the template has no image record"
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
qm clone "$vm" "$check_vm" --name bb-box-linux-check --pool "$BBBOX_POOL" >/dev/null
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
ssh_box 'bash -lc bb-box-check-headless' </dev/null | tee "$stage/check.txt" || checked=1
! grep -q '^[^ ].* FAIL ' "$stage/check.txt" || checked=1
# Spares wait hibernated (#612), so the clone must hibernate and resume.
if [ "$checked" = 0 ]; then
  start=$(date +%s%N)
  qm suspend "$check_vm" --todisk 1 >/dev/null
  log "the clone hibernated in $((($(date +%s%N) - start) / 1000000)) ms"
  sleep 5
  start=$(date +%s%N)
  qm start "$check_vm" >/dev/null
  wait_for "the resumed clone answers SSH" 120 1 ssh_box exit || checked=1
  log "the clone resumed and answered SSH in $((($(date +%s%N) - start) / 1000000)) ms"
fi
qm stop "$check_vm" >/dev/null
qm destroy "$check_vm" --purge 1 >/dev/null
check_vm=
[ "$checked" = 0 ] || die "the check failed (above)"

description="bb-box linux vm template, built $(date -u +%F) from Ubuntu 24.04's cloud image $IMAGE_RELEASE.
$record"
# The pool's ACL lets the plugin's token delete guests in it; protection keeps
# it from deleting templates. Clones inherit the flag, so the plugin clears it
# on each box (delete=protection) when it configures the box.
if [ "$vm" = "$vmid" ]; then
  qm set "$vmid" --name bb-box-linux --description "$description" --tags "bbbox;linux;$build" --protection 1 >/dev/null
else
  # Puts the checked template in <vmid>'s place. On LVM-thin the new one is a
  # linked clone of the build, which takes seconds; elsewhere a full copy.
  log "replacing template $vmid with $vm"
  qm set "$vmid" --protection 0 >/dev/null
  start=$(date +%s%N)
  qm destroy "$vmid" || { qm set "$vmid" --protection 1 >/dev/null; die "could not remove template $vmid"; }
  if [ -n "$thin" ]; then
    qm clone "$vm" "$vmid" --name bb-box-linux --pool "$BBBOX_POOL" >/dev/null
  else
    qm clone "$vm" "$vmid" --name bb-box-linux --pool "$BBBOX_POOL" --full 1 --storage "$BBBOX_STORAGE" >/dev/null
  fi
  qm template "$vmid"
  echo "template $vmid was missing for $((($(date +%s%N) - start) / 1000000)) ms"
  qm set "$vmid" --description "$description" --tags "bbbox;linux;$build" --protection 1 >/dev/null
  qm destroy "$vm" --purge 1 >/dev/null
fi
done_ok=1
log "Linux VM template $vmid ready ($build)"
