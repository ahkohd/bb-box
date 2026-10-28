#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<'EOF'
usage: build-h264.sh <prefix> [--with-x264]

Builds bb-box-h264, the frame encoder of Android devices and of iOS devices
on a Mac with no hardware H.264 encoder, into <prefix>/bin, with Cisco's
OpenH264 binary, downloaded from Cisco, in <prefix>/lib/bb-box. It builds on
Linux on x86_64 and on macOS on arm64.
With --with-x264 it also builds x264 from its pinned source and links it in,
and x264 becomes the helper's default encoder. Every download is checked
against setup/android/pins.json.

Needs cc, curl, bzip2 and node; make with --with-x264, and nasm with it on
Linux.
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
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) openh264_pin=openh264 openh264_file=libopenh264.so.8 cores=$(nproc) ;;
  Darwin-arm64) openh264_pin=openh264-mac-arm64 openh264_file=libopenh264.8.dylib cores=$(sysctl -n hw.ncpu) ;;
  *) echo "build-h264.sh: bb-box-h264 builds on Linux on x86_64 and macOS on arm64, not $(uname -s) on $(uname -m)" >&2; exit 1 ;;
esac
sha256_matches() { if command -v sha256sum >/dev/null; then echo "$1  $2" | sha256sum -c --quiet - >/dev/null 2>&1; else echo "$1  $2" | shasum -a 256 -c --quiet - >/dev/null 2>&1; fi; }
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
  if ! sha256_matches "$sha256" "$to"; then
    echo "build-h264.sh: $url does not match its pinned SHA-256" >&2
    exit 1
  fi
}

mkdir -p "$work/include/wels" "$prefix/bin" "$prefix/lib/bb-box"
while read -r url sha256; do
  fetch "$url" "$sha256" "$work/include/wels/${url##*/}"
done < <(pins openh264-header)

read -r url sha256 < <(pins "$openh264_pin")
fetch "$url" "$sha256" "$work/openh264.bz2"
bunzip2 -c "$work/openh264.bz2" >"$prefix/lib/bb-box/$openh264_file.new"
chmod 644 "$prefix/lib/bb-box/$openh264_file.new"
mv "$prefix/lib/bb-box/$openh264_file.new" "$prefix/lib/bb-box/$openh264_file"

flags=(-O2 -std=c11 -Wall -Wextra -I"$work/include" "-DBB_H264_OPENH264_LIBRARY=\"$prefix/lib/bb-box/$openh264_file\"")
sources=("$here/bb-box-h264/main.c" "$here/bb-box-h264/openh264.c")
libraries=(-ldl)
if [ "$with_x264" = yes ]; then
  read -r url sha256 < <(pins x264)
  fetch "$url" "$sha256" "$work/x264.tar.bz2"
  mkdir "$work/x264-source"
  tar -xjf "$work/x264.tar.bz2" -C "$work/x264-source" --strip-components=1
  (cd "$work/x264-source" && ./configure --prefix="$work/x264" --enable-static --disable-cli --enable-pic --bit-depth=8 >/dev/null && make -j"$cores" >/dev/null && make install >/dev/null)
  revision=${url##*/x264-}
  flags+=(-DBB_H264_WITH_X264 "-DBB_H264_X264_REVISION=\"${revision%.tar.bz2}\"" -I"$work/x264/include")
  sources+=("$here/bb-box-h264/x264.c")
  libraries=("$work/x264/lib/libx264.a" -lpthread -lm "${libraries[@]}")
fi

if [ "$(uname -s)" = Darwin ]; then
  cc -O2 -Wall -Wextra -fobjc-arc -I"$work/include" -c "$here/bb-box-h264/simulator.m" -o "$work/simulator.o"
  sources+=("$work/simulator.o")
  libraries+=(-framework Foundation -framework IOSurface -framework Accelerate)
fi
cc "${flags[@]}" -o "$prefix/bin/bb-box-h264.new" "${sources[@]}" "${libraries[@]}"
mv "$prefix/bin/bb-box-h264.new" "$prefix/bin/bb-box-h264"
"$prefix/bin/bb-box-h264" --version
