#!/bin/bash
# usage: nvidia-userspace.sh <build-dir>
#   as root in the build CT; prints the version it installed
set -Eeuo pipefail
trap 'echo "nvidia-userspace: line $LINENO failed: $BASH_COMMAND" >&2' ERR
umask 022

build=$1
art=$build/artifacts
die() { echo "nvidia-userspace: $*" >&2; exit 1; }
[ "$(uname -m)" = x86_64 ] || die "NVIDIA's userspace is for x86_64 boxes only"
version=$(cat /sys/module/nvidia/version 2>/dev/null) || die "the host has no NVIDIA driver loaded"
run=$art/NVIDIA-Linux-x86_64-$version.run
[ -f "$run" ] || die "$run is missing (fetch-artifacts.sh downloads the host's version)"
(cd "$art" && sha256sum -c --quiet "NVIDIA-Linux-x86_64-$version.run.sha256sum") || die "NVIDIA installer checksum mismatch"
x_modules=/usr/lib/xorg/modules
sh "$run" --silent --no-kernel-modules --no-kernel-module-source --no-nouveau-check --no-nvidia-modprobe \
  --no-systemd --no-rpms --no-backup --no-check-for-alternate-installs --no-x-check --no-distro-scripts \
  --no-dkms --no-install-libglvnd --glvnd-egl-config-path=/usr/share/glvnd/egl_vendor.d --tmpdir /var/tmp \
  --x-library-path=/usr/lib/x86_64-linux-gnu --x-module-path="$x_modules" >&2
for f in "$x_modules/drivers/nvidia_drv.so" /etc/vulkan/icd.d/nvidia_icd.json /usr/share/glvnd/egl_vendor.d/10_nvidia.json \
  /usr/bin/nvidia-smi; do
  [ -e "$f" ] || die "the NVIDIA installer did not install $f"
done
install -d -m 0755 /usr/share/bb-box
echo "$version" >/usr/share/bb-box/nvidia-version
install -m 0755 "$build/guest/bb-box-nvidia-drivers.sh" /usr/local/sbin/bb-box-nvidia-drivers
cat >/etc/systemd/system/bb-box-nvidia-drivers.service <<'EOF'
[Unit]
Description=bb-box: NVIDIA's EGL and Vulkan drivers shown only in a box with a card
DefaultDependencies=no
After=local-fs.target
Before=sysinit.target bb-box-display.service
ConditionPathExists=/usr/share/bb-box/nvidia-version

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bb-box-nvidia-drivers

[Install]
WantedBy=sysinit.target
EOF
systemctl enable bb-box-nvidia-drivers.service >/dev/null
/usr/local/sbin/bb-box-nvidia-drivers >&2
echo "$version"
