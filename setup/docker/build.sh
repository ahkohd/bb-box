#!/bin/bash
# Builds bb-box's images for the Docker backend on the Docker host the docker
# CLI uses (DOCKER_HOST or its current context): bbbox/linux:1 for linux
# boxes, bbbox/linux-desktop:1 for linux-desktop-cpu and linux-desktop boxes,
# and bbbox/linux-desktop-wayland:1 for linux-desktop-wayland-cpu boxes (048).
# See README.md.
#
# usage: build.sh [--bb-url <url>] [--tag <image>] [--arch x86_64|arm64] [linux|desktop|desktop-wayland]...
# --tag names the one image it builds otherwise, as a refresh does (049) to
# check a build before it takes the image's own name. --arch arm64 builds the
# arm64 images, bbbox/linux:1-arm64 and bbbox/linux-desktop:1-arm64, for
# microsandbox on a Mac (053), on an arm64 Docker host: the guest scripts
# install the arm64 pins, as for Tart's Linux images (040). Its desktop is on
# the CPU, and there is no Wayland desktop for arm64 yet.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The images' layout version, which the backend checks (IMAGE_VERSION in
# src/backends/docker/config.ts, and the Dockerfile's label).
version=1

usage() {
  echo "usage: build.sh [--bb-url <url>] [--tag <image>] [--arch x86_64|arm64] [linux|desktop|desktop-wayland]..." >&2
  echo "  --bb-url  BB's server URL, to pre-install BB's host app in the images" >&2
  echo "  --tag     the name of the one image to build, in place of its own" >&2
  echo "  With no image named, builds all three." >&2
  exit 2
}
bb_url=
tag=
arch=x86_64
targets=()
while [ $# -gt 0 ]; do
  case $1 in
    --bb-url) [ $# -ge 2 ] || usage; bb_url=$2; shift 2 ;;
    --tag) [ $# -ge 2 ] || usage; tag=$2; shift 2 ;;
    --arch) [ $# -ge 2 ] || usage; arch=$2; shift 2 ;;
    linux | desktop | desktop-wayland) targets+=("$1"); shift ;;
    *) usage ;;
  esac
done
case $arch in
  x86_64) platform=linux/amd64 suffix= ;;
  arm64) platform=linux/arm64 suffix=-arm64 ;;
  *) echo "--arch is x86_64 or arm64" >&2; exit 2 ;;
esac
if [ "$arch" = arm64 ]; then
  [ ${#targets[@]} -gt 0 ] || targets=(linux desktop)
  for target in "${targets[@]}"; do
    [ "$target" != desktop-wayland ] || { echo "There is no Wayland desktop for arm64 yet: build linux or desktop." >&2; exit 2; }
  done
fi
[ ${#targets[@]} -gt 0 ] || targets=(linux desktop desktop-wayland)
[ -z "$tag" ] || [ ${#targets[@]} = 1 ] || { echo "--tag names one image: give one of linux, desktop or desktop-wayland" >&2; exit 2; }

# The digest of BB's app on the server, which the build fetches. It keys the
# images' layer with the app, so a build installs the app again only once
# BB's app has changed (#95).
app_sha256=
if [ -n "$bb_url" ]; then
  headers=$(curl -fsSI --max-time 30 "${bb_url%/}/install/bb-app.tgz") || {
    echo "build.sh could not reach BB's server at $bb_url for its app." >&2
    exit 1
  }
  app_sha256=$(sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\).*/\1/Ip' <<<"$headers" | tail -1)
  [ -n "$app_sha256" ] || { echo "BB's server at $bb_url gave no digest for its app." >&2; exit 1; }
fi

image_sources_digest() {
  (
    cd "$here/.."
    while read -r entry; do
      [ -z "$entry" ] || find "$entry" -type f ! -name .DS_Store ! -name '._*'
    done <"$here/image-sources" |
      grep -vxF -e proxmox-lxc/template/pins.json -e proxmox-lxc/template/apt-snapshot -e proxmox-lxc/template/desktop-pins.tsv |
      LC_ALL=C sort -u |
      while IFS= read -r file; do
        printf 'file %s\n' "$file"
        cat "$file"
      done |
      sha256sum | cut -d' ' -f1
  )
}
image_sources_sha256=$(image_sources_digest)

# A build needs this much of the Docker host's disk free, in GB. From an
# empty cache, on Docker 29 with its containerd image store, the linux image
# took about 6 GB, the desktop 12, the Wayland desktop 12 and all three 28:
# the images and Docker's build cache. The rest leaves room for an earlier
# build's. With less, a build fails part way, so it does not start. A
# container from the Dockerfile's base image writes how much is free where
# the layers go, and docker cp reads that file. An attached stream (docker
# run, docker exec) is empty when the Docker host is reached from Windows
# through WSL's localhost forwarder, so nothing here attaches.
case "${targets[*]}" in
  linux) need=10 what="the linux image" ;;
  desktop) need=18 what="the desktop image" ;;
  desktop-wayland) need=18 what="the desktop-wayland image" ;;
  *) need=36 what="${#targets[@]} images" ;;
esac
base=$(sed -n 's/^ARG UBUNTU=//p' "$here/Dockerfile")

copy_from_image() {
  local platform=$1 image=$2 path=$3 dest=$4
  local id status=0
  id=$(docker create --platform "$platform" "$image") || return $?
  docker cp "$id:$path" "$dest/" || status=$?
  docker rm "$id" >/dev/null || true
  return "$status"
}

host_disk() {
  local platform=$1 image=$2 dest=$3
  local id status=0
  id=$(docker create --platform "$platform" --network none --entrypoint sh "$image" -c 'df -Pk / > /tmp/bb-box-df') || return $?
  docker start "$id" >/dev/null || status=$?
  if [ "$status" -eq 0 ]; then
    docker wait "$id" >/dev/null || status=$?
  fi
  if [ "$status" -eq 0 ]; then
    docker cp "$id:/tmp/bb-box-df" "$dest/" || status=$?
  fi
  docker rm "$id" >/dev/null || true
  return "$status"
}

free_disk_kb() {
  local disk disk_err free
  disk=$(mktemp -d)
  disk_err=$(mktemp)
  if host_disk "$platform" "$base" "$disk" 2>"$disk_err" &&
    free=$(awk '$NF == "/" && $4 ~ /^[0-9]+$/ { print $4 }' "$disk/bb-box-df") && [ -n "$free" ]; then
    rm -rf "$disk" "$disk_err"
    printf '%s\n' "$free"
    return 0
  fi
  echo "build.sh could not see how much disk the Docker host has free, so it builds anyway: $(tail -n 1 "$disk_err")" >&2
  rm -rf "$disk" "$disk_err"
  return 1
}

prune_stale_build_cache() {
  local help out freed
  help=$(docker builder prune --help 2>&1 || true)
  if grep -q -- '--max-used-space' <<<"$help"; then
    out=$(docker builder prune --force --filter until=24h --max-used-space 4GB 2>&1) || return $?
  elif grep -q -- '--keep-storage' <<<"$help"; then
    out=$(docker builder prune --force --filter until=24h --keep-storage 4GB 2>&1) || return $?
  else
    out=$(docker builder prune --force --filter until=24h 2>&1) || return $?
  fi
  freed=$(awk '/^Total( reclaimed space)?:/ { print $NF }' <<<"$out" | tail -n 1)
  echo "build.sh pruned Docker build cache unused for 24h (freed ${freed:-0B})." >&2
}

need_kb=$((need * 1000000000 / 1024))
if free=$(free_disk_kb); then
  if [ "$free" -lt "$need_kb" ]; then
    prune_stale_build_cache || echo "build.sh could not prune Docker's build cache." >&2
    if measured=$(free_disk_kb); then
      free=$measured
    else
      free=$need_kb
    fi
  fi
  if [ "$free" -lt "$need_kb" ]; then
    echo "The Docker host has $((free * 1024 / 1000000000)) GB of disk free, and building $what needs about $need GB." \
      "Free some, for example with docker builder prune, then build again." >&2
    exit 1
  fi
fi

for target in "${targets[@]}"; do
  case $target in
    linux) image=bbbox/linux:$version$suffix ;;
    desktop) image=bbbox/linux-desktop:$version$suffix ;;
    desktop-wayland) image=bbbox/linux-desktop-wayland:$version ;;
  esac
  image=${tag:-$image}
  # The guest scripts install the tools built for the image's architecture.
  build=(docker build --platform "$platform" --target "$target" --build-arg BB_URL="$bb_url"
    --build-arg BB_APP_SHA256="$app_sha256" --build-arg IMAGE_SOURCES_SHA256="$image_sources_sha256" -t "$image" -f "$here/Dockerfile")
  "${build[@]}" "$here/.."
  # Its record (049) in a label, where the plugin's doctor reads it without
  # starting the image: the image's own, which a second build, all from the
  # cache, puts on the image. Copied out, not attached.
  record_dir=$(mktemp -d)
  copy_from_image "$platform" "$image" /usr/share/bb-box/image.json "$record_dir" || { rm -rf "$record_dir"; exit 1; }
  record=$(cat "$record_dir/image.json") || { rm -rf "$record_dir"; exit 1; }
  rm -rf "$record_dir"
  [ "${record:0:1}" = "{" ] && [[ $record != *$'\n'* ]] || { echo "$image: /usr/share/bb-box/image.json is not one JSON object" >&2; exit 1; }
  "${build[@]}" --quiet --label "bbbox.image-record=$record" "$here/.." >/dev/null
  echo "built $image"
done
