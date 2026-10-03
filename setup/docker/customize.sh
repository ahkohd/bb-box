#!/bin/bash
# bb-box: makes a Docker box image from inside, as
# setup/proxmox-lxc/template/build.sh does in its build CT: stages a build
# directory, runs the template's guest scripts with BOX_RUNTIME=docker, then
# finalize.sh. BB's app goes in a layer of its own (see the Dockerfile). Run
# by the Dockerfile, with the template's directory at /mnt/template, the
# fetched artifacts at /mnt/artifacts and the fetch stage's CA certificates
# at /mnt/ca-certificates.crt, all read-only.
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
apt=(-o "APT::Snapshot=$(cat /mnt/template/apt-snapshot)" -o Acquire::https::CaInfo=/mnt/ca-certificates.crt
  -o Acquire::Retries=5)
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
END
echo runtime=docker >"$build/extra-release"

bash "$build/guest/customize-base.sh" "$build"
[ "$kind" = linux ] || bash "$build/guest/customize-desktop.sh" "$build"
# The template's release names the session, as an LXC template's does.
bash "$build/guest/finalize.sh" "$build" "${kind%-wayland}"
