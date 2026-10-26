#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: build-h264.sh <prefix> [--with-x264]

Builds bb-box-h264, the Android device's frame encoder, into <prefix>/bin,
with Cisco's OpenH264 binary, downloaded from Cisco, in <prefix>/lib/bb-box.
With --with-x264 it also builds x264 from its pinned source and links it in,
and x264 becomes the helper's default encoder. Every download is checked
against setup/android/pins.json.

Needs cc, curl, bzip2 and node; nasm and make with --with-x264.
EOF
  exit 2
}

[ $# -ge 1 ] || usage
prefix=$1
shift
with_x264=no
for option in "$@"; do
  case "$option" in
    --with-x264) with_x264=yes ;;
    *) usage ;;
  esac
done

here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

pins() {
  node -e '
    const pins = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).encoder;
    for (const pin of pins.filter((pin) => pin.name === process.argv[2])) console.log(pin.url, pin.sha256);
  ' "$here/pins.json" "$1"
}

fetch() {
  local url=$1 sha256=$2 to=$3
  curl -fsSL --retry 3 -o "$to" "$url"
  if ! echo "$sha256  $to" | sha256sum -c --quiet - >/dev/null 2>&1; then
    echo "build-h264.sh: $url does not match its pinned SHA-256" >&2
    exit 1
  fi
}

mkdir -p "$work/include/wels" "$prefix/bin" "$prefix/lib/bb-box"
while read -r url sha256; do
  fetch "$url" "$sha256" "$work/include/wels/${url##*/}"
done < <(pins openh264-header)

read -r url sha256 < <(pins openh264)
fetch "$url" "$sha256" "$work/openh264.so.bz2"
bunzip2 -c "$work/openh264.so.bz2" >"$prefix/lib/bb-box/libopenh264.so.8.new"
chmod 644 "$prefix/lib/bb-box/libopenh264.so.8.new"
mv "$prefix/lib/bb-box/libopenh264.so.8.new" "$prefix/lib/bb-box/libopenh264.so.8"

flags=(-O2 -std=c11 -Wall -Wextra -I"$work/include" "-DBB_H264_OPENH264_LIBRARY=\"$prefix/lib/bb-box/libopenh264.so.8\"")
sources=("$here/bb-box-h264/main.c" "$here/bb-box-h264/openh264.c")
libraries=(-ldl)
if [ "$with_x264" = yes ]; then
  read -r url sha256 < <(pins x264)
  fetch "$url" "$sha256" "$work/x264.tar.bz2"
  mkdir "$work/x264-source"
  tar -xjf "$work/x264.tar.bz2" -C "$work/x264-source" --strip-components=1
  (cd "$work/x264-source" && ./configure --prefix="$work/x264" --enable-static --disable-cli --enable-pic --bit-depth=8 >/dev/null && make -j"$(nproc)" >/dev/null && make install >/dev/null)
  revision=${url##*/x264-}
  flags+=(-DBB_H264_WITH_X264 "-DBB_H264_X264_REVISION=\"${revision%.tar.bz2}\"" -I"$work/x264/include")
  sources+=("$here/bb-box-h264/x264.c")
  libraries=("$work/x264/lib/libx264.a" -lpthread -lm "${libraries[@]}")
fi

cc "${flags[@]}" -o "$prefix/bin/bb-box-h264.new" "${sources[@]}" "${libraries[@]}"
mv "$prefix/bin/bb-box-h264.new" "$prefix/bin/bb-box-h264"
"$prefix/bin/bb-box-h264" --version
