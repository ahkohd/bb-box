#!/usr/bin/env bash
set -euo pipefail

sdk="${ANDROID_SDK_ROOT:-/opt/android-sdk}"
build_tools_version=35.0.0
platform=android-35
here="$(cd "$(dirname "$0")/../.." && pwd)"
source_file="$here/setup/android/tree-server/TreeServer.java"
dex="$here/src/device/tree-server.dex"
record="$here/setup/android/tree-server/tree-server.json"

if [ "${1:-}" = "--install-tools" ]; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends openjdk-17-jdk-headless >/dev/null
  { yes || true; } | sudo "$sdk/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$sdk" "build-tools;$build_tools_version" "platforms;$platform" >/dev/null
fi

android_jar="$sdk/platforms/$platform/android.jar"
d8="$sdk/build-tools/$build_tools_version/d8"
for needed in "$android_jar" "$d8"; do
  [ -e "$needed" ] || { echo "Missing $needed: run $0 --install-tools on a Linux box with the Android SDK." >&2; exit 1; }
done
command -v javac >/dev/null || { echo "Missing javac: run $0 --install-tools." >&2; exit 1; }

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/classes" "$work/dex"
javac --release 11 -nowarn -Xlint:-options -cp "$android_jar" -d "$work/classes" "$source_file"
"$d8" --release --min-api 34 --lib "$android_jar" --output "$work/dex" $(find "$work/classes" -name '*.class' | sort)
cp "$work/dex/classes.dex" "$dex"

javac_version="$(javac -version 2>&1)"
source_digest="$(sha256sum "$source_file" | cut -d' ' -f1)"
dex_digest="$(sha256sum "$dex" | cut -d' ' -f1)"
cat >"$record" <<EOF
{ "source": "$source_digest", "dex": "$dex_digest", "javac": "$javac_version", "d8": "build-tools $build_tools_version", "platform": "$platform" }
EOF
echo "Built $dex, $(stat -c %s "$dex") bytes"
