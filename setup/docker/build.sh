#!/bin/bash
# Builds bb-box's images for the Docker backend on the Docker host the docker
# CLI uses (DOCKER_HOST or its current context): bbbox/linux:1 for linux
# boxes, and bbbox/linux-desktop:1 for linux-desktop-cpu and linux-desktop
# boxes. See README.md.
#
# usage: build.sh [--bb-url <url>] [linux|desktop]...
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# The images' layout version, which the backend checks (IMAGE_VERSION in
# src/backends/docker/config.ts, and the Dockerfile's label).
version=1

usage() {
  echo "usage: build.sh [--bb-url <url>] [linux|desktop]..." >&2
  echo "  --bb-url  BB's server URL, to pre-install BB's host app in the images" >&2
  echo "  With no kind, builds both." >&2
  exit 2
}
bb_url=
targets=()
while [ $# -gt 0 ]; do
  case $1 in
    --bb-url) [ $# -ge 2 ] || usage; bb_url=$2; shift 2 ;;
    linux | desktop) targets+=("$1"); shift ;;
    *) usage ;;
  esac
done
[ ${#targets[@]} -gt 0 ] || targets=(linux desktop)

for target in "${targets[@]}"; do
  image=bbbox/linux:$version
  [ "$target" = linux ] || image=bbbox/linux-desktop:$version
  # The guest scripts install x86_64 builds of their tools.
  docker build --platform linux/amd64 --target "$target" --build-arg BB_URL="$bb_url" \
    -t "$image" -f "$here/Dockerfile" "$here/.."
  echo "built $image"
done
