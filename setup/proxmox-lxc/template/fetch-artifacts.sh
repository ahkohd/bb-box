#!/bin/bash
# Downloads every artifact a template build needs into <dir> and checks each
# against its pinned SHA-256. Files already there and correct are kept.
#
# usage: fetch-artifacts.sh <dir> linux|desktop|desktop-cpu [x86_64|arm64]
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

fetch() { # url sha256 file
  local url=$1 sha=$2 name=$3
  if [ -f "$art/$name" ] && echo "$sha  $art/$name" | sha256sum -c --quiet - 2>/dev/null; then
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
