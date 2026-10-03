#!/bin/bash
# Builds bb-box's images for the Docker backend on the Docker host the docker
# CLI uses (DOCKER_HOST or its current context): bbbox/linux:1 for linux
# boxes, bbbox/linux-desktop:1 for linux-desktop-cpu and linux-desktop boxes,
# and bbbox/linux-desktop-wayland:1 for linux-desktop-wayland-cpu boxes (048).
# See README.md.
#
# usage: build.sh [--bb-url <url>] [linux|desktop|desktop-wayland]...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The images' layout version, which the backend checks (IMAGE_VERSION in
# src/backends/docker/config.ts, and the Dockerfile's label).
version=1

usage() {
  echo "usage: build.sh [--bb-url <url>] [linux|desktop|desktop-wayland]..." >&2
  echo "  --bb-url  BB's server URL, to pre-install BB's host app in the images" >&2
  echo "  With no image named, builds all three." >&2
  exit 2
}
bb_url=
targets=()
while [ $# -gt 0 ]; do
  case $1 in
    --bb-url) [ $# -ge 2 ] || usage; bb_url=$2; shift 2 ;;
    linux | desktop | desktop-wayland) targets+=("$1"); shift ;;
    *) usage ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(linux desktop desktop-wayland)

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

# A build needs this much of the Docker host's disk free, in GB. From an
# empty cache, on Docker 29 with its containerd image store, the linux image
# took about 6 GB, the desktop 12, the Wayland desktop 12 and all three 28:
# the images and Docker's build cache. The rest leaves room for an earlier
# build's. With less, a build fails part way, so it does not start. A
# container from the Dockerfile's base image says how much is free where the
# layers go.
case "${targets[*]}" in
  linux) need=10 what="the linux image" ;;
  desktop) need=18 what="the desktop image" ;;
  desktop-wayland) need=18 what="the desktop-wayland image" ;;
  *) need=36 what="${#targets[@]} images" ;;
esac
base=$(sed -n 's/^ARG UBUNTU=//p' "$here/Dockerfile")
if df=$(docker run --rm --quiet --network none --platform linux/amd64 --entrypoint df "$base" -Pk / 2>&1) &&
  free=$(awk '$NF == "/" && $4 ~ /^[0-9]+$/ { print $4 }' <<<"$df") && [ -n "$free" ]; then
  if [ "$free" -lt $((need * 1000000000 / 1024)) ]; then
    echo "The Docker host has $((free * 1024 / 1000000000)) GB of disk free, and building $what needs about $need GB." \
      "Free some, for example with docker builder prune, then build again." >&2
    exit 1
  fi
else
  echo "build.sh could not see how much disk the Docker host has free, so it builds anyway: ${df##*$'\n'}" >&2
fi

for target in "${targets[@]}"; do
  case $target in
    linux) image=bbbox/linux:$version ;;
    desktop) image=bbbox/linux-desktop:$version ;;
    desktop-wayland) image=bbbox/linux-desktop-wayland:$version ;;
  esac
  # The guest scripts install x86_64 builds of their tools.
  docker build --platform linux/amd64 --target "$target" --build-arg BB_URL="$bb_url" \
    --build-arg BB_APP_SHA256="$app_sha256" -t "$image" -f "$here/Dockerfile" "$here/.."
  echo "built $image"
done
