#!/bin/bash
# Builds bb-box's CT templates on a Proxmox host, as root.
#
#   build.sh linux <vmid> [--cpu]
#       the Linux template: development tools, agent CLIs and Docker, and on a
#       host with an NVIDIA driver NVIDIA's userspace for it, so its boxes can
#       be given a card (071). --cpu leaves the userspace out. build.sh
#       headless, its earlier name, does the same
#   build.sh desktop <vmid> [--gpu <pci-address> | --cpu] [--wayland]
#       the desktop template: everything in the Linux one, plus XFCE, VNC,
#       Chrome and Cua Driver, with NVIDIA's userspace and no device lines:
#       the host's GPU helper gives each box its card, and a box with none
#       draws on the CPU (071). --gpu gives the template one card's device
#       lines, for a host without the helper. With --cpu, no NVIDIA userspace
#       and the display always on the CPU. A host without an NVIDIA driver
#       gets a CPU template without --cpu. With --wayland, the Wayland desktop
#       (048) instead of XFCE: Sway with floating windows, Waybar and wayvnc,
#       on the CPU only, so --wayland implies --cpu.
#   build.sh copy-desktop <from-vmid> <vmid> --gpu <pci-address>
#       a copy of a desktop template with another GPU's device lines, for a
#       host without the GPU helper, so desktops can spread across cards
#
# Options: --keep     stop before finalizing and leave the build CT running.
#          --replace  <vmid> may be a bb-box template of the same kind
#                     already. The new one is built and checked (or copied)
#                     in another CT (BBBOX_BUILD_VMID, or the next free VMID)
#                     and only then takes the old one's place. Boxes cloned
#                     from the old one keep running on LVM-thin; on storage
#                     where they need it, it refuses until they are released.
# Settings: /etc/bb-box/bb-box.env (see host/bb-box.env.example).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../host/common.sh
. "$here/../host/common.sh"

usage() { sed -n '2,31p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
kind=${1:-}
shift || usage
[ "$kind" != headless ] || kind=linux
case "$kind" in linux | desktop) [ $# -ge 1 ] || usage; from= vmid=$1; shift ;;
  copy-desktop) [ $# -ge 2 ] || usage; from=$1 vmid=$2; shift 2 ;;
  *) usage ;;
esac
gpu= keep= cpu= replace= wayland=
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) gpu=${2:?--gpu needs a PCI address}; shift 2 ;;
    --cpu) cpu=1; shift ;;
    --wayland) wayland=1; shift ;;
    --keep) keep=1; shift ;;
    --replace) replace=1; shift ;;
    *) usage ;;
  esac
done
[[ "$vmid" =~ ^[0-9]+$ ]] || die "VMID must be a number"
[ "$from" != "$vmid" ] || die "copy-desktop needs another VMID for the copy"
[ -z "$cpu" ] || [ -z "$gpu" ] || die "--gpu and --cpu exclude each other"
[ -z "$cpu" ] || [ "$kind" != copy-desktop ] || die "--cpu is for linux and desktop templates"
[ -z "$gpu" ] || [ "$kind" != linux ] || die "--gpu is for desktop templates: a Linux box gets its card from the host's GPU helper"
if [ -n "$wayland" ]; then
  [ "$kind" = desktop ] || die "--wayland is for desktop templates"
  # Wayland on NVIDIA needs the host's nvidia-drm with modeset=1 (048).
  [ -z "$gpu" ] || die "a Wayland desktop is CPU only for now (048): leave out --gpu"
  cpu=1
fi
if [ "$kind" != copy-desktop ] && [ -z "$gpu" ] && [ -z "$cpu" ] && [ ! -d /proc/driver/nvidia/gpus ]; then
  echo "no NVIDIA driver on this host: building a $kind template without NVIDIA's userspace"
  cpu=1
fi
nvidia_run=
[ -n "$cpu" ] || [ "$kind" = copy-desktop ] || nvidia_run=NVIDIA-Linux-x86_64-$(cat /sys/module/nvidia/version 2>/dev/null).run
command -v jq >/dev/null || die "jq is required (apt install jq)"
# The build ID: a tag of its own on each template this makes, which the build
# CT carries from the start and the template keeps through --replace. Warm
# boxes copy it, and the plugin retires those whose template now has another.
build=build.$(date -u +%Y%m%d-%H%M%S)-$(od -An -N2 -tx1 /dev/urandom | tr -d ' \n')
in_use() { pct config "$1" >/dev/null 2>&1 || qm config "$1" >/dev/null 2>&1; }

# On LVM-thin a linked clone is a thin snapshot, which needs nothing of its
# template's volume once made: "The origin thin LV can be removed without
# affecting snapshots that reference it" (lvmthin(7)). Elsewhere, on ZFS or
# Ceph RBD for example, a linked clone needs its template's base volume.
thin=
[ "$(pvesh get "/storage/$BBBOX_STORAGE" --output-format json 2>/dev/null | jq -r .type)" != lvmthin ] || thin=1
# Guests whose disks need a template's base volume: storages other than
# LVM-thin name a linked clone's volume base-<vmid>-disk-<n>/<volume>.
linked_clones() { # vmid
  { grep -lE ":base-$1-disk-[0-9]+/" /etc/pve/nodes/*/lxc/*.conf /etc/pve/nodes/*/qemu-server/*.conf 2>/dev/null ||
    true; } | sed 's|.*/||; s|\.conf$||' | sort -n | paste -sd ' ' -
}
# A copy of CT <from> at <to>: on LVM-thin a linked clone, which takes about a
# second and is as independent as a full copy (<from> is then a template);
# otherwise a full copy.
copy_ct() { # from to hostname
  if [ -n "$thin" ]; then
    pct clone "$1" "$2" --pool "$BBBOX_POOL" --hostname "$3"
  else
    pct clone "$1" "$2" --full --pool "$BBBOX_POOL" --hostname "$3" --storage "$BBBOX_STORAGE"
  fi
}

# With --replace, an existing <vmid> must be a template this script made, of
# the same kind, that no box needs. The build or copy then goes to another CT
# ($ct), which replaces <vmid> at the end, so a failure leaves the old
# template.
ct=$vmid
if in_use "$vmid"; then
  [ -n "$replace" ] || die "VMID $vmid is already in use (--replace replaces a bb-box template)"
  word=$kind
  [ "$kind" != copy-desktop ] || word=desktop
  # A Linux template built before its rename says headless.
  pattern=$word
  [ "$word" != linux ] || pattern='(linux|headless)'
  config=$(pct config "$vmid" 2>/dev/null || true)
  grep -q '^template: 1' <<<"$config" && grep -Eq "^description: bb-box $pattern template" <<<"$config" ||
    die "$vmid is not a bb-box $word template; --replace replaces only those"
  # A Wayland desktop replaces only a Wayland one, and an X11 one only an X11 one.
  if [ "$kind" = desktop ]; then
    was_wayland=
    ! grep -q '^description: bb-box desktop template (Wayland' <<<"$config" || was_wayland=1
    [ "$was_wayland" = "$wayland" ] || die "$vmid is a desktop template of the other session (X11 or Wayland); --replace replaces only one of the same"
  fi
  clones=$(linked_clones "$vmid")
  [ -z "$clones" ] || die "boxes are linked clones of template $vmid and need it ($clones); release them first"
  ct=${BBBOX_BUILD_VMID:-$(pvesh get /cluster/nextid)}
  [[ "$ct" =~ ^[0-9]+$ ]] && [ "$ct" != "$vmid" ] && [ "$ct" != "$from" ] ||
    die "BBBOX_BUILD_VMID must be a VMID other than $vmid${from:+ and $from}"
  ! in_use "$ct" || die "VMID $ct for the build is already in use; set BBBOX_BUILD_VMID to a free one"
fi

cache=/var/cache/bb-box/artifacts
stage=/var/tmp/bb-box-build-$vmid
in_ct=/var/tmp/bb-box-build

# The NVIDIA GPU's device nodes: /dev/nvidiaN, and its DRM card and render nodes.
gpu_lines() {
  local pci=${1,,} minor card render
  [ -n "$pci" ] || {
    mapfile -t gpus < <(ls /proc/driver/nvidia/gpus 2>/dev/null)
    [ "${#gpus[@]}" -eq 1 ] || die "choose a GPU with --gpu, one of: ${gpus[*]:-none found}"
    pci=${gpus[0]}
  }
  [[ "$pci" == *:*:*.* ]] || pci=0000:$pci
  minor=$(awk -F: '/^Device Minor/ { gsub(/[ \t]/, "", $2); print $2 }' "/proc/driver/nvidia/gpus/$pci/information" 2>/dev/null) ||
    true
  [ -n "$minor" ] || die "no NVIDIA GPU at $pci (see /proc/driver/nvidia/gpus)"
  card=$(basename "$(readlink -f "/dev/dri/by-path/pci-$pci-card")")
  render=$(basename "$(readlink -f "/dev/dri/by-path/pci-$pci-render")")
  [ -c "/dev/dri/$card" ] && [ -c "/dev/dri/$render" ] || die "no DRM nodes for $pci"
  for node in "nvidia$minor" nvidiactl nvidia-uvm nvidia-uvm-tools nvidia-modeset; do
    [ -c "/dev/$node" ] || die "/dev/$node is missing: run host/setup-host.sh"
  done
  printf '%s\n' "/dev/nvidia$minor,mode=0666" /dev/nvidiactl,mode=0666 /dev/nvidia-uvm,mode=0666 /dev/nvidia-uvm-tools,mode=0666 \
    /dev/nvidia-modeset,mode=0666 "/dev/dri/$render,mode=0666" "/dev/dri/$card,mode=0666"
  echo "# gpu $pci"
}
add_devices() { # ct device...
  local ct=$1 config n=0 device
  shift
  config=$(pct config "$ct")
  for device in "$@"; do
    while grep -q "^dev$n:" <<<"$config"; do n=$((n + 1)); done
    pct set "$ct" "--dev$n" "$device"
    config=$(pct config "$ct")
  done
}
devices_of() { grep -v '^#' <<<"$1" || true; }
# /dev/net/tun, so boxes can run Tailscale and other VPNs with a TUN device
# (050), as CT <ct>'s next free devN. A copy keeps the line its template has.
add_tun() { # ct
  ! pct config "$1" | grep -Eq '^dev[0-9]+: /dev/net/tun(,|$)' || return 0
  add_devices "$1" /dev/net/tun
}

make_template() { # vmid description
  pct template "$1"
  # The pool's ACL lets the plugin's token delete guests in it; protection
  # keeps it from deleting templates. Clones inherit the flag, so the plugin
  # clears it on each box (delete=protection) when it configures the box.
  pct set "$1" --description "$2" --tags "$build" --protection 1
}
# Puts the finished, stopped CT <ct> in template <vmid>'s place, and says how
# long no template had that VMID: from removing the old one to `pct template`
# on the new one. On LVM-thin the new one is a linked clone of <ct>, made a
# template first, which takes seconds; elsewhere it is a full copy. Boxes
# cloned from the old template on LVM-thin keep running on their own, and keep
# its blocks in the pool until they are released.
replace_with() { # ct vmid hostname description
  local clones start
  [ -z "$thin" ] || pct template "$1"
  clones=$(linked_clones "$2")
  [ -z "$clones" ] || die "boxes are linked clones of template $2 and need it ($clones); release them first"
  pct set "$2" --protection 0
  start=$(date +%s%N)
  pct destroy "$2" || { pct set "$2" --protection 1; die "could not remove template $2"; }
  copy_ct "$1" "$2" "$3"
  pct template "$2"
  echo "template $2 was missing for $((($(date +%s%N) - start) / 1000000)) ms"
  pct set "$2" --description "$4" --tags "$build" --protection 1
  pct destroy "$1"
}

if [ "$kind" = copy-desktop ]; then
  pct config "$from" | grep -q '^template: 1' || die "$from is not a template"
  pvesh get "/nodes/$BBBOX_NODE/lxc/$from/config" --output-format json | jq -r '.description // ""' | grep '^{' | tail -1 |
    jq -e '.nvidia != null and .kind == "linux-desktop"' >/dev/null 2>&1 ||
    pct config "$from" | grep -q '^dev[0-9]*: /dev/nvidia' ||
    die "$from is not a GPU desktop template; copy a GPU desktop template to another GPU, or build a new desktop with build.sh desktop"
  lines=$(gpu_lines "$gpu")
  note=$(grep '^#' <<<"$lines" | cut -c3-)
  # The copy has its source's image record (049), from the description's second line.
  record=$(pvesh get "/nodes/$BBBOX_NODE/lxc/$from/config" --output-format json | jq -r '.description // ""' | grep '^{' | tail -1 || true)
  description="bb-box desktop template ($note), copied from $from on $(date -u +%F).${record:+
$record}"
  copy_ct "$from" "$ct" "bb-box-desktop-$vmid"
  pct set "$ct" --delete protection 2>/dev/null || true
  for key in $(pct config "$ct" | sed -n 's|^\(dev[0-9]*\): /dev/\(nvidia\|dri/\).*|\1|p'); do pct set "$ct" --delete "$key"; done
  pct set "$ct" --tags "$build"
  mapfile -t devices < <(devices_of "$lines")
  add_devices "$ct" "${devices[@]}"
  add_tun "$ct"
  if [ "$ct" != "$vmid" ]; then
    replace_with "$ct" "$vmid" "bb-box-desktop-$vmid" "$description"
  else
    make_template "$vmid" "$description"
  fi
  echo "desktop template $vmid ready ($note)"
  exit 0
fi

# Stage the build directory: scripts, pins, settings, the plugin's public key
# and the artifacts.
[ -f "$BBBOX_SSH_KEY" ] || {
  install -d -m 0700 "$(dirname "$BBBOX_SSH_KEY")"
  ssh-keygen -q -t ed25519 -N '' -C "bb-box plugin" -f "$BBBOX_SSH_KEY"
  echo "created the plugin's SSH key $BBBOX_SSH_KEY"
}
artifacts=$kind
[ "$kind" != linux ] || [ -n "$cpu" ] || artifacts=linux-nvidia
[ "$kind" != desktop ] || [ -z "$cpu" ] || artifacts=desktop-cpu
[ -z "$wayland" ] || artifacts=desktop-wayland-cpu
bash "$here/fetch-artifacts.sh" "$cache" "$artifacts"
rm -rf "$stage"
install -d -m 0700 "$stage" "$stage/artifacts"
cp -r "$here/guest" "$here/pins.json" "$here/desktop-pins.tsv" "$here/baseline-packages.txt" "$here/apt-snapshot" "$stage/"
cp "$BBBOX_SSH_KEY.pub" "$stage/plugin-key.pub"
desktop_gpu=nvidia
[ -z "$cpu" ] || desktop_gpu=none
linux_gpu=none
[ "$kind" != linux ] || [ -n "$cpu" ] || linux_gpu=nvidia
cat >"$stage/build.env" <<EOF
BOX_USER=box
BOX_DNS="$BBBOX_DNS"
BB_URL="$BBBOX_BB_URL"
DESKTOP_GPU=$desktop_gpu
LINUX_GPU=$linux_gpu
DESKTOP_SESSION=${wayland:+wayland}
BUILD_ID=$build
BOX_IDENTITY_RESET=on
PREPARE=$(sha256sum "$0" | awk 'NR==1{print $1}')
EOF
for f in "$cache"/*; do
  case "${f##*/}" in
    "$nvidia_run" | "$nvidia_run.sha256sum") [ -n "$nvidia_run" ] || continue ;;
    *.run | *.run.sha256sum) continue ;;
    *.deb | cua-driver-* | rustup-init) [ "$kind" = desktop ] || continue ;;
  esac
  ln "$f" "$stage/artifacts/" 2>/dev/null || cp "$f" "$stage/artifacts/"
done

# The OS template: Ubuntu 26.04 for the Wayland desktop, whose Sway and
# wayvnc carry the box's own pointer shapes; 24.04 for the rest.
os_template=$BBBOX_OS_TEMPLATE
[ -z "$wayland" ] || os_template=$BBBOX_OS_TEMPLATE_WAYLAND
os=${os_template#*:vztmpl/}
if ! pveam list "${os_template%%:*}" | grep -q "$os"; then
  pveam update >/dev/null
  pveam download "${os_template%%:*}" "$os"
fi

# A template waits at its kinds' default size (028), so its warm boxes serve
# them: a warm box serves only a box with its cores.
size=16 cores=2 memory=4096
[ "$kind" = linux ] || size=24 cores=4 memory=8192
lines=
[ "$kind" != linux ] || [ -n "$cpu" ] || lines="# NVIDIA $(cat /sys/module/nvidia/version), no card"
if [ "$kind" = desktop ] && [ -z "$cpu" ]; then
  if [ -n "$gpu" ]; then lines=$(gpu_lines "$gpu"); else lines="# NVIDIA $(cat /sys/module/nvidia/version), no card"; fi
fi
[ -z "$cpu" ] || [ "$kind" != desktop ] || lines="# cpu only"
[ -z "$wayland" ] || lines="# Wayland, cpu only"
pct create "$ct" "$os_template" --hostname "bb-box-$kind" --pool "$BBBOX_POOL" --unprivileged 1 \
  --features nesting=1 --cores 16 --memory 16384 --swap 1024 --rootfs "$BBBOX_STORAGE:$size" --tags "$build" \
  --net0 "name=eth0,bridge=$BBBOX_BRIDGE,ip=$BBBOX_BUILD_ADDRESS/$BBBOX_PREFIX,gw=$BBBOX_GATEWAY,type=veth" \
  --nameserver "$BBBOX_DNS" --ostype ubuntu --onboot 0
mapfile -t devices < <(devices_of "$lines")
[ "${#devices[@]}" -eq 0 ] || add_devices "$ct" "${devices[@]}"
add_tun "$ct"
pct start "$ct"
for _ in $(seq 1 60); do
  pct exec "$ct" -- getent hosts archive.ubuntu.com >/dev/null 2>&1 && break
  sleep 1
done
pct exec "$ct" -- getent hosts archive.ubuntu.com >/dev/null || die "the build CT has no network"

push() { tar -C "$stage" "$@" -cf - . | pct exec "$ct" -- sh -c "rm -rf $in_ct && mkdir -p $in_ct && tar -xf - -C $in_ct --no-same-owner"; }
push
pct exec "$ct" -- bash "$in_ct/guest/customize-base.sh" "$in_ct"
[ "$kind" = linux ] || pct exec "$ct" -- bash "$in_ct/guest/customize-desktop.sh" "$in_ct"

# Boot it once as a box would, and check it as the box user.
pct reboot "$ct"
sleep 1
pct exec "$ct" -- timeout 60 systemctl is-system-running --wait >/dev/null || true
# The Linux template's check keeps its earlier name, which templates have.
check=bb-box-check-$kind
[ "$kind" != linux ] || check=bb-box-check-headless
pct exec "$ct" -- runuser -u box -- env PATH=/home/box/.local/bin:/home/box/.cargo/bin:/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR=/run/user/1000 "$check" | tee "$stage/check.txt"
if grep -q '^[^ ].* FAIL ' "$stage/check.txt"; then
  die "checks failed; the build CT $ct is left running for a look"
fi
if [ -n "$keep" ]; then
  echo "--keep: CT $ct is left running, not finalized"
  exit 0
fi

pct exec "$ct" -- sh -c "cat $in_ct/extra-release 2>/dev/null || true" >"$stage/extra-release"
push --exclude=./artifacts
pct exec "$ct" -- bash "$in_ct/guest/finalize.sh" "$in_ct" "$kind"
# The image's record (049), which the template's description carries for the
# plugin's doctor, as its second line.
record=$(pct exec "$ct" -- cat /usr/share/bb-box/image.json | jq -c .) || die "the template has no image record"
pct fstrim "$ct" || echo "pct fstrim $ct failed: the template keeps the blocks its build deleted"
pct shutdown "$ct" --timeout 60
# Clones get their address from the plugin; without one they have none.
pct set "$ct" --net0 "name=eth0,bridge=$BBBOX_BRIDGE,ip=manual,type=veth" --delete nameserver \
  --cores "$cores" --memory "$memory" --swap 512
note=$(grep '^#' <<<"$lines" | cut -c3- || true)
description="bb-box $kind template${note:+ ($note)}, built $(date -u +%F). See /usr/share/bb-box/template-release inside.
$record"
if [ "$ct" != "$vmid" ]; then
  # The new template replaces the old one only now.
  echo "replacing template $vmid with CT $ct (if this fails, CT $ct keeps the new template)"
  replace_with "$ct" "$vmid" "bb-box-$kind" "$description"
else
  make_template "$vmid" "$description"
fi
rm -rf "$stage"
echo "$kind template $vmid ready${note:+ ($note)}"
