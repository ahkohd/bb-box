#!/bin/bash
set -euo pipefail
umask 022

usage() {
  cat >&2 <<'USAGE'
usage: customize-android.sh <build-dir>

Run as root in the build VM of an Android template, after the Linux VM
template's guest scripts, and again by each refresh. <build-dir> has
build.env, and android/ beside this script's files.

It installs the Android SDK's command-line tools, emulator, platform-tools
and system image into /opt/android-sdk from setup/android/pins.json, each
checked by its SHA-256; bb-box-h264, with x264 when build.env says
ANDROID_X264=yes or the image's helper has it already; the device's firewall
and its unit; and bb-box-emulator. It then makes each device's AVD and its
snapshot as the box user (prepare-avds.sh), and clears what each box makes
for itself. Java, which avdmanager needs, is installed for the build and
removed after it.

It needs the operator's acceptance of the Android SDK's licence: a file
android-sdk-license in <build-dir>, as accept-sdk-licence.sh writes it, or
the one an earlier build left in /opt/android-sdk/licenses.
USAGE
  exit 2
}

[ $# -eq 1 ] || usage
build=$1
here=$(cd "$(dirname "$0")" && pwd)
. "$build/build.env"
pins=$here/pins.json
sdk=/opt/android-sdk
box=${BOX_USER:-box}
cache=/var/cache/bb-box/android
log() { echo "$(date -u +%H:%M:%S) customize-android: $*"; }
started=$(date +%s)

accepted=$(jq -r .license.accepted "$pins")
licence_id=$(jq -r .license.id "$pins")
given=
for file in "$build/android-sdk-license" "$sdk/licenses/$licence_id"; do
  [ -f "$file" ] || continue
  if grep -qx "$accepted" <(tr -d '\r' <"$file"); then given=$file; break; fi
done
if [ -z "$given" ]; then
  echo "customize-android: the operator has not accepted the Android SDK's licence ($licence_id, $accepted)." >&2
  echo "customize-android: run setup/android/accept-sdk-licence.sh on the host, which shows its terms, then build again." >&2
  exit 1
fi
licence=$(mktemp)
printf '\n%s' "$accepted" >"$licence"

packages=(libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libgl1 libegl1 libxkbfile1 nftables unzip bzip2 curl jq)
x264=${ANDROID_X264:-}
if [ -z "$x264" ] && [ -x /usr/local/bin/bb-box-h264 ]; then
  case "$(/usr/local/bin/bb-box-h264 --version 2>/dev/null)" in x264*) x264=yes ;; esac
fi
[ "$x264" != yes ] || packages+=(nasm make)
log "packages: ${packages[*]}"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${packages[@]}" >/dev/null

before_java=$(mktemp)
dpkg-query -W -f='${Package}\n' | sort >"$before_java"
DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends openjdk-17-jre-headless >/dev/null
mapfile -t java_packages < <(comm -13 "$before_java" <(dpkg-query -W -f='${Package}\n' | sort))
log "Java for avdmanager, for this build only: ${#java_packages[@]} packages"

install -d -m 0755 "$cache"
fetch() {
  local url=$1 sha256=$2 to=$3
  if ! echo "$sha256  $to" | sha256sum -c --status 2>/dev/null; then
    curl -fsSL --retry 3 -o "$to.part" "$url"
    echo "$sha256  $to.part" | sha256sum -c --status || { rm -f "$to.part"; echo "customize-android: $url does not match its pinned SHA-256" >&2; exit 1; }
    mv "$to.part" "$to"
  fi
}

install -d -m 0755 "$sdk"
count=$(jq '.sdk | length' "$pins")
for i in $(seq 0 $((count - 1))); do
  read -r name version url sha256 top path < <(jq -r ".sdk[$i] | [.name, .version, .url, .sha256, .top, .path] | @tsv" "$pins")
  marker=$sdk/$path/.bb-box-pin
  if [ "$(cat "$marker" 2>/dev/null)" = "$sha256" ]; then
    log "$name $version: installed already"
    continue
  fi
  zip=$cache/${url##*/}
  fetch "$url" "$sha256" "$zip"
  unpacked=$(mktemp -d "$sdk/.unpack-XXXXXX")
  unzip -q "$zip" -d "$unpacked"
  rm -rf "${sdk:?}/$path"
  install -d -m 0755 "$(dirname "$sdk/$path")"
  mv "$unpacked/$top" "$sdk/$path"
  rm -rf "$unpacked"
  echo "$sha256" >"$marker"
  log "$name $version: installed in $sdk/$path"
done
emulator_version=$(jq -r '.sdk[] | select(.name == "emulator") | .version' "$pins")
IFS=. read -r major minor micro _ <<<"$emulator_version"
cat >"$sdk/emulator/package.xml" <<EOF
<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<ns2:repository xmlns:ns2="http://schemas.android.com/repository/android/common/02" xmlns:ns3="http://schemas.android.com/repository/android/generic/02"><localPackage path="emulator" obsolete="false"><type-details xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="ns3:genericDetailsType"/><revision><major>$major</major><minor>$minor</minor><micro>$micro</micro></revision><display-name>Android Emulator</display-name></localPackage></ns2:repository>
EOF
install -d -m 0755 "$sdk/licenses"
install -m 0644 "$licence" "$sdk/licenses/$licence_id"
rm -f "$licence"
chmod -R a+rX "$sdk"
cat >/etc/profile.d/bb-box-android.sh <<EOF
export ANDROID_HOME=$sdk
export ANDROID_SDK_ROOT=$sdk
case ":\$PATH:" in *":$sdk/platform-tools:"*) ;; *) PATH="$sdk/platform-tools:$sdk/emulator:$sdk/cmdline-tools/latest/bin:\$PATH" ;; esac
EOF
for tool in adb emulator; do
  dir=platform-tools
  [ "$tool" = adb ] || dir=emulator
  ln -sf "$sdk/$dir/$tool" "/usr/local/bin/$tool"
done

log "bb-box-h264$([ "$x264" = yes ] && echo ", with x264 built from source" || echo ", with Cisco's OpenH264")"
if [ "$x264" = yes ]; then bash "$here/build-h264.sh" /usr/local --with-x264; else bash "$here/build-h264.sh" /usr/local; fi

install -d -m 0755 /etc/bb-box
install -m 0644 "$here/device-firewall.nft" /etc/bb-box/device-firewall.nft
install -m 0755 "$here/bb-box-device-firewall" /usr/local/sbin/bb-box-device-firewall
ln -sf /usr/local/sbin/bb-box-device-firewall /usr/local/bin/bb-box-device-firewall
install -m 0755 "$here/bb-box-emulator" /usr/local/bin/bb-box-emulator
install -m 0755 "$here/check-android.sh" /usr/local/bin/bb-box-check-android
install -m 0755 "$here/clear-device-state.sh" /usr/local/sbin/bb-box-clear-device-state
install -d -m 0755 /usr/share/bb-box
install -m 0644 "$pins" /usr/share/bb-box/android-pins.json
install -m 0644 "$pins" "$build/android-pins.json"
cat >/etc/systemd/system/bb-box-device-firewall.service <<'EOF'
[Unit]
Description=bb-box: the device's ports closed to every interface but loopback
DefaultDependencies=no
Before=network-pre.target
Wants=network-pre.target
After=local-fs.target

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/bb-box-device-firewall load
ExecReload=/usr/local/sbin/bb-box-device-firewall load

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable bb-box-device-firewall.service >/dev/null
systemctl restart bb-box-device-firewall.service
bb-box-device-firewall check
usermod -aG kvm "$box"

home=$(getent passwd "$box" | cut -d: -f6)
rm -rf "$home/.android/avd"
made=$(mktemp -d)
install -m 0644 "$here/prepare-avds.sh" "$made/prepare-avds.sh"
chown "$box:$box" "$made"
runuser -u "$box" -- env HOME="$home" ANDROID_HOME="$sdk" PATH="/usr/local/bin:/usr/bin:/bin" \
  bash "$made/prepare-avds.sh" /usr/share/bb-box/android-pins.json "$made/devices.json" </dev/null
install -m 0644 "$made/devices.json" "$build/android-devices.json"
install -m 0644 "$made/devices.json" /usr/share/bb-box/android-devices.json
rm -rf "$made"

log "removing Java, which only avdmanager needed"
[ "${#java_packages[@]}" -eq 0 ] || DEBIAN_FRONTEND=noninteractive apt-get purge -y -q "${java_packages[@]}" >/dev/null
rm -f "$before_java"

bb-box-clear-device-state "$box"
rm -rf "$cache"

{
  for i in $(seq 0 $((count - 1))); do jq -r ".sdk[$i] | \"android=\(.name) \(.version) \(.sha256)\"" "$pins"; done
  echo "android_encoder=$(/usr/local/bin/bb-box-h264 --version)"
} >"$build/extra-release"
log "done in $(($(date +%s) - started)) s"
