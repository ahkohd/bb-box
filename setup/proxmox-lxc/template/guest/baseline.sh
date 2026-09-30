#!/bin/bash
# Shared first stage of every template profile, run as root inside the image
# being built: apply Ubuntu updates from the pinned snapshot, install the
# baseline packages and any profile packages, then the pinned tools.
#
# usage: baseline.sh <build-dir> [<profile-package>...]
# <build-dir> holds pins.json, apt-snapshot, baseline-packages.txt, artifacts/
# and guest/.
# It records the applied updates in <build-dir>/apt-upgrades.tsv and every
# package it installed on request in <build-dir>/packages.txt.
set -euo pipefail
umask 022

build=$1
shift
export DEBIAN_FRONTEND=noninteractive
snapshot=$(cat "$build/apt-snapshot")
[[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "baseline: invalid apt snapshot" >&2; exit 1; }

# Every apt command in this build reads the same archive snapshot, so the
# candidate records exactly which security updates it received.
printf 'APT::Snapshot "%s";\nAcquire::Retries "5";\n' "$snapshot" >/etc/apt/apt.conf.d/50bb-box-build-snapshot
# snapshot.ubuntu.com has outages in which it cannot serve .debs. The archive
# is a second place to download the same files from: pinned to -1, it never
# supplies a version of its own, and apt checks each .deb
# against the SHA-256 in the snapshot's signed index. The host differs from
# the image's own sources so that the pin matches only this source, and the
# file name sorts after ubuntu.sources because apt tries sources in that order.
cat >/etc/apt/sources.list.d/zz-bb-box-build-fallback.sources <<'EOF'
Types: deb
URIs: http://gb.archive.ubuntu.com/ubuntu
Suites: noble noble-updates noble-backports noble-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Snapshot: no
EOF
cat >/etc/apt/preferences.d/bb-box-build-fallback <<'EOF'
Package: *
Pin: origin "gb.archive.ubuntu.com"
Pin-Priority: -1
EOF
rm -rf /var/lib/apt/lists/*
# A snapshot index that failed to download would leave only the archive's.
apt-get update --error-on=any
apt-get -s dist-upgrade \
  | awk '/^Inst / { from = $3; gsub(/[][]/, "", from); if ($3 !~ /^\[/) from = "-"; to = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", to); print $2 "\t" from "\t" to }' \
  >"$build/apt-upgrades.tsv"
apt-get -y -o Dpkg::Options::=--force-confold dist-upgrade

grep -v -e '^#' -e '^$' "$build/baseline-packages.txt" >"$build/packages.txt"
printf '%s\n' "$@" >>"$build/packages.txt"
sort -u -o "$build/packages.txt" "$build/packages.txt"
sed -i '/^$/d' "$build/packages.txt"
xargs -a "$build/packages.txt" apt-get install -y --no-install-recommends
while read -r package; do
  [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null)" = "install ok installed" ] || {
    echo "baseline: package $package is not installed" >&2
    exit 1
  }
done <"$build/packages.txt"

bash "$build/guest/install-tools.sh" "$build/pins.json" "$build/artifacts"
