#!/bin/bash
# What a Proxmox VM needs beyond the Linux template's guest scripts, run as
# root in the build VM after guest/customize-base.sh: the QEMU guest agent,
# growpart, the boot script that gives each box its address and grows its
# disk, DNS, and the end of what cloud-init set up for the build. A refresh
# of the image (057) runs it again, after customize-base.sh.
#
# usage: customize-vm.sh <build-dir>, the directory with build.env
set -euo pipefail
umask 022

build=$1
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck disable=SC1091
. "$build/build.env"
# shellcheck disable=SC1091
. "$build/guest/apt.sh"

# From the build's apt snapshot, as customize-base.sh installs the rest.
DEBIAN_FRONTEND=noninteractive apt_install -y -q --no-install-recommends qemu-guest-agent cloud-guest-utils

# The box user's groups as in other boxes, and kvm, for /dev/kvm where the
# host allows nested virtualization. cloud-init gave it adm, cdrom, dip and
# lxd as Ubuntu's default user.
for group in adm cdrom dip lxd; do gpasswd -d "$BOX_USER" "$group" >/dev/null 2>&1 || true; done
usermod -aG kvm "$BOX_USER"

install -m 0755 "$here/boot.sh" /usr/local/sbin/bb-box-boot
cat >/etc/systemd/system/bb-box-boot.service <<'EOF'
[Unit]
Description=bb-box: the box's address from the SMBIOS serial, and its disk grown
DefaultDependencies=no
After=local-fs.target
Before=network-pre.target systemd-networkd.service
Wants=network-pre.target

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/bb-box-boot

[Install]
WantedBy=multi-user.target
EOF
systemctl enable bb-box-boot.service systemd-networkd.service systemd-resolved.service >/dev/null

# The network is the boot script's alone: cloud-init's netplan file gave the
# build VM its address only for its first boot.
rm -f /etc/netplan/50-cloud-init.yaml /etc/sudoers.d/90-cloud-init-users
install -d -m 0755 /etc/systemd/resolved.conf.d
printf '[Resolve]\nDNS=%s\n' "${BOX_DNS:-1.1.1.1 9.9.9.9}" >/etc/systemd/resolved.conf.d/10-bb-box.conf
ln -sf ../run/systemd/resolve/stub-resolv.conf /etc/resolv.conf
# Only IPv4 matters for network-online (Docker waits for it).
install -d -m 0755 /etc/systemd/system/systemd-networkd-wait-online.service.d
cat >/etc/systemd/system/systemd-networkd-wait-online.service.d/10-bb-box.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/usr/lib/systemd/systemd-networkd-wait-online --any --ipv4 --timeout=10
EOF
