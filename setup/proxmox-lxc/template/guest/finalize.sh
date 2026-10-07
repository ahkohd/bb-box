#!/bin/bash
# Last stage of a bb-box template, run as root inside the CT or VM: record
# what is in it, remove the build's apt pins, fetch fresh package lists from
# the Ubuntu archive, then remove SSH host keys, logs, caches, Docker state and
# the build directory. It writes the image's record,
# /usr/share/bb-box/image.json (049), with image-record.sh before the build
# directory goes, and its size last. The builds copy it outside the image for
# the doctor.
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
  # As baseline.sh: only the amd64 archive has snapshots.
  if [ "$(dpkg --print-architecture)" = amd64 ]; then echo "apt_snapshot=$(cat "$build/apt-snapshot")"; else echo "apt_snapshot=none"; fi
  arch=x86_64
  [ "$(uname -m)" = x86_64 ] || arch=arm64
  jq -r --arg arch "$arch" '.tools[] | select(.arch == $arch) | "tool=\(.name) \(.version) \(.sha256)"' "$build/pins.json"
  [ ! -f "$build/extra-release" ] || cat "$build/extra-release"
} >"$out/template-release"
chmod 0644 "$out"/*
bash "$build/guest/image-record.sh" "$build" "$kind" "$out"

# Docker's state from the build's checks. A template keeps no containers: a
# box with any starts Docker at boot (041).
if systemctl is-active --quiet docker || [ -n "$(ls -A /var/lib/docker/containers 2>/dev/null)" ]; then
  docker system prune -af --volumes >/dev/null || true
fi
systemctl stop docker.socket docker.service containerd.service 2>/dev/null || true
if [ -n "$(ls -A /var/lib/docker/containers 2>/dev/null)" ]; then
  echo "finalize: containers are left in /var/lib/docker/containers" >&2
  exit 1
fi

rm -f /etc/apt/apt.conf.d/50bb-box-build-snapshot /etc/apt/sources.list.d/zz-bb-box-build-fallback.sources \
  /etc/apt/preferences.d/bb-box-build-fallback
# Package lists from the image's own sources (the Ubuntu archive, not the
# build's snapshot), so `sudo apt-get install <package>` works on a new box
# without an update first. Kept compressed: about 70 MiB instead of 190.
# They are as old as the template; apt's 404 for a package updated since then
# means `sudo apt-get update`.
printf 'Acquire::GzipIndexes "true";\n' >/etc/apt/apt.conf.d/50bb-box-compressed-lists
rm -rf /var/lib/apt/lists/*
apt-get update --error-on=any
apt-get clean
rm -f /etc/ssh/ssh_host_*
rm -rf /root/.cache /root/.npm /root/.local /root/.config /home/*/.cache /home/*/.npm /tmp/* /var/tmp/*
find /var/log -type f \( -name '*.gz' -o -name '*.[0-9]' -o -name '*.old' \) -delete
find /var/log -type f -exec truncate -s 0 {} +
journalctl --rotate >/dev/null 2>&1 || true
journalctl --vacuum-time=1s >/dev/null 2>&1 || true
rm -f /root/.bash_history /home/*/.bash_history
# Cua Driver's installation identity and markers; its config file (telemetry
# and update check off) stays.
find /root/.cua-driver /home/*/.cua-driver -mindepth 1 -maxdepth 1 ! -name config.json \
  -exec rm -rf {} + 2>/dev/null || true
# Desktop state that each box makes for itself: VNC password, X logs, profiles.
rm -rf /var/lib/bb-box/vnc-password /var/lib/bb-box/vnc.passwd /home/*/.local/share/xorg \
  /home/*/.config/google-chrome /root/.config/google-chrome /home/*/.Xauthority
# State the checks' apps leave: Mousepad's autosaved document and its session
# in dconf, which would make a box's first Mousepad ask to restore it. No
# template sets anything in dconf.
rm -rf /home/*/.local/share/Mousepad /home/*/.config/dconf/user
# PVE also truncates this on clone; an empty file avoids first-boot presets.
: >/etc/machine-id
rm -f /var/lib/dbus/machine-id
# The image's size in its record, now that it is clean. A Docker image's is
# its layers', which Docker gives: in a container, as in a Docker build or a
# bake in a Docker box, / is the Docker host's whole filesystem (#474).
if ! grep -qx runtime=docker "$out/template-release" && [ ! -f /.dockerenv ]; then
  size=$(df -B1 --output=used / | tail -1 | awk '{ printf "%.1f", $1 / 1073741824 }')
  jq -c --argjson size "$size" '.sizeGiB = $size' "$out/image.json" >"$out/image.json.new"
  mv "$out/image.json.new" "$out/image.json"
  chmod 0644 "$out/image.json"
fi
rm -rf "$build"
echo "finalize: done ($kind)"
