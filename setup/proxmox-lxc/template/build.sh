#!/bin/bash
# Builds bb-box's CT templates on a Proxmox host, as root.
#
#   build.sh headless <vmid>
#       the headless template: development tools, agent CLIs and Docker
#   build.sh desktop <vmid> [--gpu <pci-address> | --cpu]
#       the desktop template: everything in headless, plus XFCE, VNC, Chrome
#       and Cua Driver, on one NVIDIA GPU (the only one, if --gpu is left
#       out), or with --cpu on no GPU at all: no device nodes, no NVIDIA
#       userspace, and the display always on the CPU. A host without an
#       NVIDIA driver gets a CPU template without --cpu.
#   build.sh copy-desktop <from-vmid> <vmid> --gpu <pci-address>
#       a copy of a desktop template for another GPU, so desktops can spread
#       across cards
#
# Options: --keep  stop before finalizing and leave the build CT running.
# Settings: /etc/bb-box/bb-box.env (see host/bb-box.env.example).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../host/common.sh
. "$here/../host/common.sh"

usage() { sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }
kind=${1:-}
shift || usage
case "$kind" in headless | desktop) [ $# -ge 1 ] || usage; from= vmid=$1; shift ;;
  copy-desktop) [ $# -ge 2 ] || usage; from=$1 vmid=$2; shift 2 ;;
  *) usage ;;
esac
gpu= keep= cpu=
while [ $# -gt 0 ]; do
  case "$1" in
    --gpu) gpu=${2:?--gpu needs a PCI address}; shift 2 ;;
    --cpu) cpu=1; shift ;;
    --keep) keep=1; shift ;;
    *) usage ;;
  esac
done
[[ "$vmid" =~ ^[0-9]+$ ]] || die "VMID must be a number"
[ -z "$cpu" ] || [ -z "$gpu" ] || die "--gpu and --cpu exclude each other"
[ -z "$cpu" ] || [ "$kind" = desktop ] || die "--cpu is for desktop templates"
if [ "$kind" = desktop ] && [ -z "$gpu" ] && [ -z "$cpu" ] && [ ! -d /proc/driver/nvidia/gpus ]; then
  echo "no NVIDIA driver on this host: building a CPU-only desktop template"
  cpu=1
fi
! pct config "$vmid" >/dev/null 2>&1 && ! qm config "$vmid" >/dev/null 2>&1 || die "VMID $vmid is already in use"
command -v jq >/dev/null || die "jq is required (apt install jq)"

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
  echo "--dev0 /dev/nvidia$minor,mode=0666 --dev1 /dev/nvidiactl,mode=0666 --dev2 /dev/nvidia-uvm,mode=0666"
  echo "--dev3 /dev/nvidia-uvm-tools,mode=0666 --dev4 /dev/nvidia-modeset,mode=0666"
  echo "--dev5 /dev/dri/$render,mode=0666 --dev6 /dev/dri/$card,mode=0666"
  echo "# gpu $pci"
}

make_template() { # vmid description
  pct set "$1" --description "$2"
  pct template "$1"
  # The pool's ACL lets the plugin's token delete guests in it; protection
  # keeps it from deleting templates. Clones inherit the flag, so the plugin
  # clears it on each box (delete=protection) when it configures the box.
  pct set "$1" --protection 1
}

if [ "$kind" = copy-desktop ]; then
  pct config "$from" | grep -q '^template: 1' || die "$from is not a template"
  lines=$(gpu_lines "$gpu")
  # shellcheck disable=SC2046
  pct clone "$from" "$vmid" --full --pool "$BBBOX_POOL" --hostname "bb-box-desktop-$vmid" --storage "$BBBOX_STORAGE"
  pct set "$vmid" --delete protection 2>/dev/null || true
  # shellcheck disable=SC2046
  pct set "$vmid" $(grep -v '^#' <<<"$lines")
  make_template "$vmid" "bb-box desktop template ($(grep '^#' <<<"$lines" | cut -c3-)), copied from $from on $(date -u +%F)."
  echo "desktop template $vmid ready ($(grep '^#' <<<"$lines" | cut -c3-))"
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
[ -z "$cpu" ] || artifacts=desktop-cpu
bash "$here/fetch-artifacts.sh" "$cache" "$artifacts"
rm -rf "$stage"
install -d -m 0700 "$stage" "$stage/artifacts"
cp -r "$here/guest" "$here/pins.json" "$here/desktop-pins.tsv" "$here/baseline-packages.txt" "$here/apt-snapshot" "$stage/"
cp "$BBBOX_SSH_KEY.pub" "$stage/plugin-key.pub"
desktop_gpu=nvidia
[ -z "$cpu" ] || desktop_gpu=none
cat >"$stage/build.env" <<EOF
BOX_USER=box
BOX_DNS="$BBBOX_DNS"
BB_URL="$BBBOX_BB_URL"
DESKTOP_GPU=$desktop_gpu
EOF
for f in "$cache"/*; do
  case "${f##*/}" in
    *.run | *.run.sha256sum | *.deb | cua-driver-* | rustup-init) [ "$kind" = desktop ] || continue ;;
  esac
  ln "$f" "$stage/artifacts/" 2>/dev/null || cp "$f" "$stage/artifacts/"
done

# The OS template.
os=${BBBOX_OS_TEMPLATE#*:vztmpl/}
if ! pveam list "${BBBOX_OS_TEMPLATE%%:*}" | grep -q "$os"; then
  pveam update >/dev/null
  pveam download "${BBBOX_OS_TEMPLATE%%:*}" "$os"
fi

size=16
[ "$kind" = headless ] || size=24
lines=
if [ "$kind" = desktop ] && [ -z "$cpu" ]; then lines=$(gpu_lines "$gpu"); fi
[ -z "$cpu" ] || lines="# cpu only"
pct create "$vmid" "$BBBOX_OS_TEMPLATE" --hostname "bb-box-$kind" --pool "$BBBOX_POOL" --unprivileged 1 \
  --features nesting=1 --cores 16 --memory 16384 --swap 1024 --rootfs "$BBBOX_STORAGE:$size" \
  --net0 "name=eth0,bridge=$BBBOX_BRIDGE,ip=$BBBOX_BUILD_ADDRESS/$BBBOX_PREFIX,gw=$BBBOX_GATEWAY,type=veth" \
  --nameserver "$BBBOX_DNS" --ostype ubuntu --onboot 0
# Device lines are root@pam only; the plugin's clones copy them.
devices=$(grep -v '^#' <<<"$lines" || true)
# shellcheck disable=SC2086
[ -z "$devices" ] || pct set "$vmid" $devices
pct start "$vmid"
for _ in $(seq 1 60); do
  pct exec "$vmid" -- getent hosts archive.ubuntu.com >/dev/null 2>&1 && break
  sleep 1
done
pct exec "$vmid" -- getent hosts archive.ubuntu.com >/dev/null || die "the build CT has no network"

push() { tar -C "$stage" "$@" -cf - . | pct exec "$vmid" -- sh -c "rm -rf $in_ct && mkdir -p $in_ct && tar -xf - -C $in_ct --no-same-owner"; }
push
pct exec "$vmid" -- bash "$in_ct/guest/customize-base.sh" "$in_ct"
[ "$kind" = headless ] || pct exec "$vmid" -- bash "$in_ct/guest/customize-desktop.sh" "$in_ct"

# Boot it once as a box would, and check it as the box user.
pct reboot "$vmid"
sleep 1
pct exec "$vmid" -- timeout 60 systemctl is-system-running --wait >/dev/null || true
check=bb-box-check-$kind
pct exec "$vmid" -- runuser -u box -- env PATH=/home/box/.cargo/bin:/usr/local/bin:/usr/bin:/bin \
  XDG_RUNTIME_DIR=/run/user/1000 "$check" | tee "$stage/check.txt"
if grep -q '^[^ ].* FAIL ' "$stage/check.txt"; then
  die "checks failed; the build CT $vmid is left running for a look"
fi
if [ -n "$keep" ]; then
  echo "--keep: CT $vmid is left running, not finalized"
  exit 0
fi

push --exclude=./artifacts
pct exec "$vmid" -- bash "$in_ct/guest/finalize.sh" "$in_ct" "$kind"
pct shutdown "$vmid" --timeout 60
# Clones get their address from the plugin; without one they have none.
pct set "$vmid" --net0 "name=eth0,bridge=$BBBOX_BRIDGE,ip=manual,type=veth" --delete nameserver \
  --cores 2 --memory 4096 --swap 512
note=$(grep '^#' <<<"$lines" | cut -c3- || true)
make_template "$vmid" "bb-box $kind template${note:+ ($note)}, built $(date -u +%F). See /usr/share/bb-box/template-release inside."
rm -rf "$stage"
echo "$kind template $vmid ready${note:+ ($note)}"
