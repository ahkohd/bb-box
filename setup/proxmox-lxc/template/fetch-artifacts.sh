#!/bin/bash
# Downloads every artifact a template build needs into <dir> and checks each
# against its pinned SHA-256. Files already there and correct are kept.
#
# With BBBOX_ARTIFACT_CACHE set to a directory (#96), a pinned file already
# there is copied from it when its SHA-256 matches, and each download goes
# there too. At the end, files there that no pin names go, so the cache
# holds the current pins' files only. The Docker build keeps one on the
# Docker host; any directory of such files, such as a Proxmox host's
# artifacts, seeds a build too.
#
# usage: fetch-artifacts.sh <dir> linux|desktop|desktop-cpu|desktop-wayland-cpu [x86_64|arm64]
# (headless is linux's earlier name). The architecture is the image's, by
# default x86_64; it picks the tools in pins.json and desktop-pins.tsv.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
# shellcheck source=../host/common.sh
. "$here/../host/common.sh"
art=$1
kind=$2
arch=${3:-x86_64}
case "$arch" in x86_64 | arm64) ;; *) die "architecture must be x86_64 or arm64" ;; esac
[ "$kind" != desktop ] || [ "$arch" = x86_64 ] || die "a desktop on $arch is CPU-only: use desktop-cpu"
mkdir -p "$art"
cache=${BBBOX_ARTIFACT_CACHE:-}
[ -z "$cache" ] || mkdir -p "$cache"

# Every file the pins name, for either architecture: what the cache keeps.
pinned_files() {
  jq -r '.tools[].url | split("/") | last' "$here/pins.json"
  awk -F '\t' '$1 !~ /^(#|$)/ && $3 != "-" { print $2 }' "$here/desktop-pins.tsv"
}
prune_cache() {
  [ -n "$cache" ] && [ "$1" = 0 ] || return 0
  local keep file
  keep=$(pinned_files)
  for file in "$cache"/* "$cache"/.[!.]*; do
    [ -e "$file" ] || continue
    # Another build's download, on its way in.
    case ${file##*/} in *.part.*) continue ;; esac
    grep -qxF -- "${file##*/}" <<<"$keep" || { rm -rf -- "$file"; echo "cache: removed ${file##*/}, which no pin names"; }
  done
}
trap 'prune_cache $?' EXIT

fetch() { # url sha256 file
  local url=$1 sha=$2 name=$3
  if [ -f "$art/$name" ] && echo "$sha  $art/$name" | sha256sum -c --quiet - 2>/dev/null; then
    return 0
  fi
  if [ -n "$cache" ] && [ -f "$cache/$name" ] && echo "$sha  $cache/$name" | sha256sum -c --quiet - 2>/dev/null; then
    cp "$cache/$name" "$art/$name.part.$$" && mv "$art/$name.part.$$" "$art/$name"
    echo "cached $name"
    return 0
  fi
  # A download of its own, so builds running at the same time can fetch the
  # same file.
  local part=$art/$name.part.$$ got
  got=$(curl -fsSL --retry 3 -w '%{http_code} %{content_type}' -o "$part" "$url") || {
    rm -f "$part"
    case ${got%% *} in
      000 | '') die "download failed (no answer): $name from $url" ;;
      *) die "download failed (HTTP ${got%% *}): $name from $url" ;;
    esac
  }
  # A host in an outage may answer with a web page, as SourceForge does, and
  # no artifact is one.
  case ${got#* } in
    text/html*)
      rm -f "$part"
      die "download failed (HTTP ${got%% *}, a web page): $name from $url"
      ;;
  esac
  echo "$sha  $part" | sha256sum -c --quiet - || {
    rm -f "$part"
    die "checksum mismatch: $name from $url"
  }
  mv "$part" "$art/$name"
  # Into the cache too, whole or not at all, for builds that run at the same time.
  if [ -n "$cache" ]; then cp "$art/$name" "$cache/$name.part.$$" && mv "$cache/$name.part.$$" "$cache/$name"; fi
  echo "fetched $name"
}

# Tools unpacked into /opt/bb-box-tools, those for the image's architecture.
while IFS=$'\t' read -r url sha; do
  fetch "$url" "$sha" "${url##*/}"
done < <(jq -er --arg arch "$arch" '.tools[] | select(.arch == $arch) | "\(.url)\t\(.sha256)"' "$here/pins.json")

# BB's host daemon package, whatever build the server has now.
if [ -n "$BBBOX_BB_URL" ]; then
  resolve=()
  [ -z "$BBBOX_BB_RESOLVE" ] || resolve=(--resolve "$BBBOX_BB_RESOLVE")
  curl -fsS "${resolve[@]}" -D "$art/bb-app.headers.$$" -o "$art/bb-app.tgz.$$" "${BBBOX_BB_URL%/}/install/bb-app.tgz"
  digest=$(sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\).*/\1/Ip' "$art/bb-app.headers.$$" | tr -d '\r' | tail -1)
  echo "$digest  $art/bb-app.tgz.$$" | sha256sum -c --quiet - || die "bb-app.tgz does not match the server's digest"
  mv "$art/bb-app.tgz.$$" "$art/bb-app.tgz"
  mv "$art/bb-app.headers.$$" "$art/bb-app.headers"
  echo "bb-app $digest"
fi

case "$kind" in linux | headless) exit 0 ;; esac

while IFS=$'\t' read -r name file url sha pin_arch; do
  case "$name" in '' | \#*) continue ;; esac
  [ "$pin_arch" = "$arch" ] || continue
  # The Wayland desktop streams with wayvnc and has no GPU (048), and Selkies
  # cannot capture Sway (056).
  case "$kind:$name" in desktop-wayland-cpu:tigervnc | desktop-wayland-cpu:virtualgl | desktop-wayland-cpu:selkies) continue ;; esac
  [ "$url" = - ] || fetch "$url" "$sha" "$file"
done <"$here/desktop-pins.tsv"
[ "$kind" = desktop ] || exit 0

# NVIDIA's installer for exactly the host's driver, checked against the
# SHA-256 NVIDIA publishes next to it.
version=$(cat /sys/module/nvidia/version 2>/dev/null) || die "no NVIDIA driver is loaded on this host"
base=https://download.nvidia.com/XFree86/Linux-x86_64/$version
run=NVIDIA-Linux-x86_64-$version.run
curl -fsSL --retry 3 -o "$art/$run.sha256sum" "$base/$run.sha256sum"
sha=$(awk -v f="$run" '$2 == f { print $1 }' "$art/$run.sha256sum")
[[ "$sha" =~ ^[0-9a-f]{64}$ ]] || die "no SHA-256 for $run from NVIDIA"
fetch "$base/$run" "$sha" "$run"
