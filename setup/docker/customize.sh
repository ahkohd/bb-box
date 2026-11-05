#!/bin/bash
# bb-box: makes a Docker box image from inside, as
# setup/proxmox-lxc/template/build.sh does in its build CT: stages a build
# directory, runs the template's guest scripts with BOX_RUNTIME=docker, then
# finalize.sh. BB's app goes in a layer of its own (see the Dockerfile). Run
# by the Dockerfile, with the template's directory at /mnt/template, the
# fetched artifacts at /mnt/artifacts and the fetch stage's CA certificates
# at /mnt/ca-certificates.crt, all read-only, and the apt packages of earlier
# builds at /var/cache/bb-box-apt, a cache on the Docker host (#96).
#
# usage: customize.sh linux|desktop|desktop-wayland
set -euo pipefail
kind=${1:-}
case $kind in linux | desktop | desktop-wayland) ;; *) echo "usage: customize.sh linux|desktop|desktop-wayland" >&2; exit 2 ;; esac
build=/root/bb-box-build

# Ubuntu's container image has a user with uid 1000, which the box user takes.
if id -u ubuntu >/dev/null 2>&1; then userdel -r ubuntu 2>/dev/null; fi

# Ubuntu's container image has no CA certificates, which the https snapshot
# needs. Install them from the snapshot, reached with the fetch stage's, so
# that no package comes from the live archive: customize-base.sh would take
# them from there, and a newer libssl from the live archive does not match
# the snapshot's libssl-dev.
# Ubuntu keeps snapshots of its main archive only, so an arm64 image
# (ports.ubuntu.com) installs from the live archive, as baseline.sh does.
# The packages apt downloads go to the cache, and are taken from it in the
# next build: apt checks each against the snapshot's signed index. Not apt's
# own /var/cache/apt/archives, which Ubuntu's docker-clean and finalize.sh's
# apt-get clean empty.
packages=/var/cache/bb-box-apt
if [ -d "$packages" ]; then
  install -d -o _apt -m 0700 "$packages/partial"
  printf 'Dir::Cache::archives "%s/";\nBinary::apt::APT::Keep-Downloaded-Packages "true";\n' "$packages" >/etc/apt/apt.conf.d/40bb-box-build-cache
fi
apt=(-o Acquire::https::CaInfo=/mnt/ca-certificates.crt -o Acquire::Retries=5)
[ "$(dpkg --print-architecture)" != amd64 ] || apt+=(-o "APT::Snapshot=$(cat /mnt/template/apt-snapshot)")
apt-get "${apt[@]}" update -q --error-on=any
apt-get "${apt[@]}" install -y -q --no-install-recommends ca-certificates

install -d -m 0700 "$build"
cp -r /mnt/template/guest /mnt/template/pins.json /mnt/template/desktop-pins.tsv \
  /mnt/template/baseline-packages.txt /mnt/template/apt-snapshot "$build/"
# A link, so finalize.sh's removal of the build directory leaves the
# artifacts alone.
ln -s /mnt/artifacts "$build/artifacts"
# The display takes the CPU unless the box has a GPU, whose driver the NVIDIA
# Container Toolkit brings from the host when the box starts. The Wayland
# desktop is customize-desktop.sh's Wayland session, as in the template.
session=x11
[ "$kind" != desktop-wayland ] || session=wayland
cat >"$build/build.env" <<END
BOX_USER=box
DESKTOP_GPU=none
DESKTOP_SESSION=$session
BOX_RUNTIME=docker
BOX_IDENTITY_RESET=$([ "$kind" = linux ] && echo on || echo off)
PREPARE=$(sha256sum "$0" | awk 'NR==1{print $1}')
END

bash "$build/guest/customize-base.sh" "$build"
[ "$kind" = linux ] || bash "$build/guest/customize-desktop.sh" "$build"
# The template's release names the session, as an LXC template's does, and
# the runtime, which finalize.sh reads. The desktop scripts write the
# release's lines anew, so this goes after them (#474).
echo runtime=docker >>"$build/extra-release"
# The cache keeps one version of each package: those the build's lists still have.
if [ -f /etc/apt/apt.conf.d/40bb-box-build-cache ]; then
  apt-get autoclean -q
  echo "apt cache: $(find "$packages" -maxdepth 1 -name '*.deb' | wc -l) packages, $(du -sh "$packages" | cut -f1)"
  rm -f /etc/apt/apt.conf.d/40bb-box-build-cache
fi
bash "$build/guest/finalize.sh" "$build" "${kind%-wayland}"
