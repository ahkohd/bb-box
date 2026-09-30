#!/bin/bash
# Last stage of a bb-box template, run as root inside the CT: record what is in
# it, then remove the build's apt pins, package lists, SSH host keys, logs,
# caches, Docker state and the build directory.
#
# usage: finalize.sh <build-dir> <kind>
set -euo pipefail
umask 022

build=$1
kind=$2
out=/usr/share/bb-box

install -d -m 0755 "$out"
dpkg-query -W -f='${Package}\t${Version}\n' >"$out/template-packages.tsv"
install -m 0644 "$build/pins.json" "$out/template-pins.json"
{
  echo "kind=$kind"
  echo "built=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "apt_snapshot=$(cat "$build/apt-snapshot")"
  jq -r '.tools[] | "tool=\(.name) \(.version) \(.sha256)"' "$build/pins.json"
  [ ! -f "$build/extra-release" ] || cat "$build/extra-release"
} >"$out/template-release"
chmod 0644 "$out"/*

# Docker's state from the build's checks.
if systemctl is-active --quiet docker; then
  docker system prune -af --volumes >/dev/null || true
fi
systemctl stop docker.socket docker.service containerd.service 2>/dev/null || true

rm -f /etc/apt/apt.conf.d/50bb-box-build-snapshot /etc/apt/sources.list.d/zz-bb-box-build-fallback.sources \
  /etc/apt/preferences.d/bb-box-build-fallback
apt-get clean
rm -rf /var/lib/apt/lists/*
rm -f /etc/ssh/ssh_host_*
rm -rf /root/.cache /root/.npm /root/.local /root/.config /home/*/.cache /home/*/.npm /tmp/* /var/tmp/*
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/*/.bash_history
# Desktop state that each box makes for itself: VNC password, X logs, profiles.
rm -rf /var/lib/bb-box/vnc-password /var/lib/bb-box/vnc.passwd /home/*/.local/share/xorg \
  /home/*/.config/google-chrome /root/.config/google-chrome /home/*/.Xauthority
# PVE also truncates this on clone; an empty file avoids first-boot presets.
: >/etc/machine-id
rm -f /var/lib/dbus/machine-id
rm -rf "$build"
echo "finalize: done ($kind)"
