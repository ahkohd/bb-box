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
# shellcheck disable=SC1091
. "$(cd "$(dirname "$0")" && pwd)/apt.sh"
export DEBIAN_FRONTEND=noninteractive
snapshot=$(cat "$build/apt-snapshot")
[[ "$snapshot" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || { echo "baseline: invalid apt snapshot" >&2; exit 1; }

# Every apt command in this build reads the same archive snapshot, so the
# candidate records exactly which security updates it received. Ubuntu keeps
# snapshots of its main archive only: an arm64 image (ports.ubuntu.com, 040)
# installs from the live archive instead.
if [ "$(dpkg --print-architecture)" = amd64 ]; then
{
  printf 'APT::Snapshot "%s";\n' "$snapshot"
  apt_retry_conf
} >/etc/apt/apt.conf.d/50bb-box-build-snapshot
# snapshot.ubuntu.com has outages in which it cannot serve .debs. The archive
# is a second place to download the same files from: pinned to -1, it never
# supplies a version of its own, and apt checks each .deb
# against the SHA-256 in the snapshot's signed index. The host differs from
# the image's own sources so that the pin matches only this source, and the
# file name sorts after ubuntu.sources because apt tries sources in that order.
# The suites are the image's release's: noble for 24.04, resolute for 26.04.
suite=$(. /etc/os-release && echo "$VERSION_CODENAME")
[ -n "$suite" ] || { echo "baseline: /etc/os-release names no release" >&2; exit 1; }
cat >/etc/apt/sources.list.d/zz-bb-box-build-fallback.sources <<EOF
Types: deb
URIs: http://gb.archive.ubuntu.com/ubuntu
Suites: $suite $suite-updates $suite-backports $suite-security
Components: main universe restricted multiverse
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
Snapshot: no
EOF
cat >/etc/apt/preferences.d/bb-box-build-fallback <<'EOF'
Package: *
Pin: origin "gb.archive.ubuntu.com"
Pin-Priority: -1
EOF
else
  apt_retry_conf >/etc/apt/apt.conf.d/50bb-box-build-snapshot
fi
rm -rf /var/lib/apt/lists/*
# snapshot.ubuntu.com also has outages of a few minutes in which it refuses
# connections, and the archive no longer serves a package's snapshot version
# once the package has been updated there. So the download steps are retried
# with growing waits; files already downloaded stay in apt's cache, so a
# retry fetches only what is missing.
opts=()
apt_acquire_options opts
# A snapshot index that failed to download would leave only the archive's.
apt_update --error-on=any
apt-get "${opts[@]}" -s dist-upgrade \
  | awk '/^Inst / { from = $3; gsub(/[][]/, "", from); if ($3 !~ /^\[/) from = "-"; to = ($3 ~ /^\[/) ? $4 : $3; sub(/^\(/, "", to); print $2 "\t" from "\t" to }' \
  >"$build/apt-upgrades.tsv"
apt_retry apt-get "${opts[@]}" -y --download-only dist-upgrade
apt-get "${opts[@]}" -y -o Dpkg::Options::=--force-confold dist-upgrade

grep -v -e '^#' -e '^$' "$build/baseline-packages.txt" >"$build/packages.txt"
printf '%s\n' "$@" >>"$build/packages.txt"
sort -u -o "$build/packages.txt" "$build/packages.txt"
sed -i '/^$/d' "$build/packages.txt"
apt_retry xargs -a "$build/packages.txt" apt-get "${opts[@]}" install -y --no-install-recommends --download-only
xargs -a "$build/packages.txt" apt-get "${opts[@]}" install -y --no-install-recommends
while read -r package; do
  [ "$(dpkg-query -W -f='${Status}' "$package" 2>/dev/null)" = "install ok installed" ] || {
    echo "baseline: package $package is not installed" >&2
    exit 1
  }
done <"$build/packages.txt"

bash "$build/guest/install-tools.sh" "$build/pins.json" "$build/artifacts"
