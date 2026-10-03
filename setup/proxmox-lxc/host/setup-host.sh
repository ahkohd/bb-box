#!/bin/bash
# Host prerequisites for bb-box boxes on a Proxmox host:
#
# - the kernel modules Docker inside unprivileged boxes relies on, and tun for
#   the /dev/net/tun every template binds (050), loaded at every boot (a
#   container cannot load modules itself);
# - with an NVIDIA GPU: a boot unit that creates every NVIDIA device node the
#   desktop template binds. /dev/nvidia-uvm* otherwise appear only on first
#   CUDA use, and `pct start` fails on a missing device.
#
# Idempotent. usage: setup-host.sh
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=common.sh
. "$here/common.sh"

# Not br_netfilter: loading it would send every bridged packet on the host's
# other bridges through iptables.
cat >/etc/modules-load.d/bb-box.conf <<'EOF'
# bb-box: modules that Docker inside unprivileged box containers relies on.
overlay
veth
nf_tables
nf_nat
nf_conntrack
nft_chain_nat
nft_compat
xt_MASQUERADE
xt_conntrack
xt_addrtype
xt_nat
xt_tcpudp
# The TUN device every template binds (050), for Tailscale and other VPNs.
tun
EOF
grep -v '^#' /etc/modules-load.d/bb-box.conf | xargs modprobe -a
echo "kernel modules: /etc/modules-load.d/bb-box.conf"

if [ ! -d /proc/driver/nvidia/gpus ]; then
  echo "no NVIDIA driver loaded: desktops will render on the CPU"
  exit 0
fi
command -v nvidia-modprobe >/dev/null || die "nvidia-modprobe is missing (it comes with NVIDIA's driver)"
minors=$(awk -F: '/^Device Minor/ { gsub(/[ \t]/, "", $2); print $2 }' /proc/driver/nvidia/gpus/*/information | sort -n | tr '\n' ' ')
create=""
for m in $minors; do create="$create -c $m"; done
nodes="nvidiactl nvidia-uvm nvidia-uvm-tools nvidia-modeset"
for m in $minors; do nodes="$nodes nvidia$m"; done
cat >/etc/systemd/system/bb-box-nvidia-devices.service <<EOF
[Unit]
Description=bb-box: create the NVIDIA device nodes that desktop boxes bind
After=systemd-modules-load.service systemd-udevd.service
Before=pve-guests.service

[Service]
Type=oneshot
RemainAfterExit=yes
# /dev/nvidiactl and /dev/nvidiaN
ExecStart=/usr/bin/nvidia-modprobe$create
# /dev/nvidia-uvm and /dev/nvidia-uvm-tools
ExecStart=/usr/bin/nvidia-modprobe -u -c 0
# /dev/nvidia-modeset
ExecStart=/usr/bin/nvidia-modprobe -m
ExecStartPost=/bin/sh -c 'for n in $nodes; do test -c /dev/\$\$n || { echo "missing /dev/\$\$n" >&2; exit 1; }; done'

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --quiet bb-box-nvidia-devices.service
systemctl restart bb-box-nvidia-devices.service
echo "NVIDIA device nodes: $nodes (bb-box-nvidia-devices.service)"
for gpu in /proc/driver/nvidia/gpus/*; do
  pci=${gpu##*/}
  echo "  GPU $pci: /dev/nvidia$(awk -F: '/^Device Minor/ { gsub(/[ \t]/, "", $2); print $2 }' "$gpu/information"), $(basename "$(readlink -f "/dev/dri/by-path/pci-$pci-card")"), $(basename "$(readlink -f "/dev/dri/by-path/pci-$pci-render")")"
done
