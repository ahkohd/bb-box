#!/bin/bash
# Run at each boot of a Linux VM box as root, by bb-box-boot.service, before
# systemd-networkd starts. It reads the box's address from the SMBIOS serial,
# which the backend sets on each clone as the address with its prefix, a
# space, then the gateway (qm set --smbios1 base64=1,serial=<base64>), and
# writes it as systemd-networkd's config for the VM's network card. With no
# such serial it leaves the network alone. Then it grows the root file system
# over its disk, which the backend grows before a box's first start when its
# size asks for more than the template's.
set -uo pipefail

log() { echo "bb-box-boot: $*"; }

serial=$(cat /sys/class/dmi/id/product_serial 2>/dev/null || true)
network=/run/systemd/network/10-bb-box.network
if [[ "$serial" =~ ^([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/[0-9]+)\ ([0-9]+\.[0-9]+\.[0-9]+\.[0-9]+)$ ]]; then
  install -d -m 0755 /run/systemd/network
  # IPv4 only: IPv6 link-local DAD holds network-online, and Docker, back.
  cat >"$network" <<EOF
[Match]
Type=ether
Name=en*

[Network]
Address=${BASH_REMATCH[1]}
Gateway=${BASH_REMATCH[2]}
LinkLocalAddressing=no
IPv6AcceptRA=no
EOF
  log "address ${BASH_REMATCH[1]}, gateway ${BASH_REMATCH[2]}"
else
  rm -f "$network"
  log "no address in the SMBIOS serial"
fi

# The root partition fills its disk, once the disk has grown. growpart says
# NOCHANGE, and exits 1, when there is nothing to grow.
root=$(findmnt -no SOURCE /)
part=$(cat "/sys/class/block/${root#/dev/}/partition" 2>/dev/null || true)
disk=$(lsblk -no PKNAME "$root" 2>/dev/null || true)
if [ -n "$part" ] && [ -n "$disk" ] && growpart "/dev/$disk" "$part" >/dev/null 2>&1; then
  resize2fs "$root" >/dev/null && log "grew $root to fill /dev/$disk"
fi
exit 0
