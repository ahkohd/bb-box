#!/bin/sh
set -eu
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

ROOT=

die() { printf 'mac-ios.sh: %s\n' "$*" >&2; exit 1; }
step() { printf 'mac-ios.sh: %s\n' "$*" >&2; }
[ $# -eq 2 ] || die "usage: mac-ios.sh <the folder of setup-mac.sh> <bb-box's admin user>"
here=$1
admin=$2
ios=$here/../tart/ios
share=/usr/local/share/bb-box
libexec=/usr/local/libexec/bb-box
helper=$libexec/device-host
companion_root=/usr/local/lib

[ "$(id -u)" = 0 ] || die "run it as root"
id -u "$admin" >/dev/null 2>&1 || die "there is no user $admin"
for file in device-host.sh device-host-ports.pl slot-clipboard.sh devices.tsv pins idb-companion-LICENSE; do
  [ -f "$ios/$file" ] || die "found no $file in $ios: copy the whole setup folder to the Mac, not only setup/ssh-pool"
done
[ -f "$here/mac-home/.zshenv" ] || die "found no mac-home/.zshenv beside setup-mac.sh"

pin() { sed -n "s/^$1=//p" "$ios/pins" | head -n 1; }
idb_version=$(pin IDB_VERSION)
idb_url=$(pin IDB_URL)
idb_sha256=$(pin IDB_SHA256)
[ -n "$idb_version" ] && [ -n "$idb_url" ] && [ -n "$idb_sha256" ] || die "$ios/pins does not pin idb_companion"

as_admin() { (cd / && sudo -n -H -u "$admin" -- "$@"); }
simctl() { as_admin xcrun simctl "$@"; }

install_companion() {
  target=$companion_root/idb_companion-$idb_version
  if [ -x "$ROOT$target/idb_companion" ] && [ "$(cat "$ROOT$share/ios/companion" 2>/dev/null)" = "$idb_version" ]; then return 0; fi
  step "installing idb_companion $idb_version, checked by SHA-256"
  work=$(mktemp -d)
  curl -fsSL --retry 3 -o "$work/idb.tgz" "$idb_url" || { rm -rf "$work"; die "could not download idb_companion $idb_version"; }
  echo "$idb_sha256  $work/idb.tgz" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || { rm -rf "$work"; die "idb_companion's archive does not match its pin"; }
  rm -rf "$ROOT$target.partial"
  mkdir -p "$ROOT$target.partial" "$ROOT/usr/local/bin" "$ROOT$share/notices" "$ROOT$share/ios"
  tar -xzf "$work/idb.tgz" -C "$ROOT$target.partial"
  rm -rf "$work"
  [ -f "$ROOT$target.partial/idb_companion" ] || die "idb_companion's archive has no idb_companion"
  chown -R root:wheel "$ROOT$target.partial"
  rm -rf "$ROOT$target"
  mv "$ROOT$target.partial" "$ROOT$target"
  ln -sfn "$target/idb_companion" "$ROOT/usr/local/bin/idb_companion"
  install -m 0644 "$ios/idb-companion-LICENSE" "$ROOT$share/notices/idb_companion-$idb_version-LICENSE"
  echo "$idb_version" >"$ROOT$share/ios/companion"
}

newest_ios_runtime() {
  env HOME=/var/root xcrun simctl list runtimes available 2>/dev/null |
    sed -n 's/^iOS \([0-9][0-9.]*\) ([0-9.]* - \([0-9A-Za-z]*\)) - \(com\.apple\.CoreSimulator\.SimRuntime\.iOS-[0-9-]*\)$/\3 \1 \2/p' | tail -n 1
}

labels_off_in() {
  plutil -convert xml1 -o - "$1" 2>/dev/null | awk '
    /<key>/ { key = $0; sub(/.*<key>/, "", key); sub(/<\/key>.*/, "", key); if ($0 ~ /<\/key>[ \t]*<true\/>/) { print key; key = "" }; next }
    /<true\/>/ && key != "" { print key }
    { key = "" }' | sort -u
}

missing_from_seed() {
  labels_off_in "$1" | comm -13 - "$2" | grep -c . || true
}

device_store() { echo "/private/var/tmp/com.apple.CoreSimulator.SimDevice.$1"; }

booted() { simctl list devices | grep -F "($1)" | grep -q '(Booted)'; }

boot_and_wait() {
  booted "$1" || simctl boot "$1" >/dev/null
  simctl bootstatus "$1" -b >/dev/null
}

apply_list() {
  udid=$1
  while IFS= read -r label; do
    [ -n "$label" ] || continue
    tries=0
    until simctl spawn "$udid" launchctl disable "system/$label" >/dev/null 2>&1; do
      tries=$((tries + 1))
      [ "$tries" -lt 5 ] || return 1
      sleep 2
    done
  done <"$2"
}

models_xcode_has() {
  types=$(env HOME=/var/root xcrun simctl list devicetypes 2>/dev/null)
  while IFS= read -r line; do
    type=$(printf '%s\n' "$line" | cut -f 2)
    [ -n "$type" ] || continue
    printf '%s\n' "$types" | grep -qF "($type)" && printf '%s\n' "$line"
  done <"$ios/devices.tsv"
}

make_seed() {
  runtime=$1 list=$2 seed=$3
  model=$(head -n 1 "$ROOT$share/ios/devices.tsv" | cut -f 1)
  type=$(head -n 1 "$ROOT$share/ios/devices.tsv" | cut -f 2)
  sorted=$(mktemp)
  grep . "$ios/slim/$list.txt" | sort -u >"$sorted"
  step "making the seed for $list: the $model, made as $admin and slimmed twice, which takes a few minutes"
  simctl list devices >/dev/null 2>&1 || die "simctl did not run as $admin"
  udid=$(simctl create "bb-box seed" "$type" "$runtime" | tail -n 1)
  case $udid in ????????-????-????-????-????????????) ;; *) die "simctl could not make a $model on $runtime as $admin" ;; esac
  made=no
  if boot_and_wait "$udid" && apply_list "$udid" "$sorted" && simctl shutdown "$udid" >/dev/null && boot_and_wait "$udid" && apply_list "$udid" "$sorted"; then
    simctl shutdown "$udid" >/dev/null 2>&1 || :
    store=$(device_store "$udid")/disabled.plist
    if [ -s "$ROOT$store" ] && [ ! -L "$ROOT$store" ] && [ "$(missing_from_seed "$ROOT$store" "$sorted")" = 0 ]; then
      install -m 0644 "$ROOT$store" "$seed.new"
      mv -f "$seed.new" "$seed"
      made=yes
    fi
  fi
  simctl shutdown "$udid" >/dev/null 2>&1 || :
  simctl delete all >/dev/null 2>&1 || :
  rm -f "$sorted"
  [ "$made" = yes ] || die "the seed for $list did not get all of its $(grep -c . "$ios/slim/$list.txt") labels off"
}

slot_clipboard_works() {
  model=$(head -n 1 "$ROOT$share/ios/devices.tsv" | cut -f 1)
  type=$(head -n 1 "$ROOT$share/ios/devices.tsv" | cut -f 2)
  udid=$(simctl create "bb-box clipboard check" "$type" "$runtime" 2>/dev/null | tail -n 1)
  case $udid in ????????-????-????-????-????????????) ;; *) echo "simctl could not make a $model as $admin to check it with"; return 1 ;; esac
  worked=no
  if boot_and_wait "$udid" >/dev/null 2>&1; then
    said=$(/bin/sh "$ios/slot-clipboard.sh" "$admin" "$udid" 2>&1) && worked=yes
  else
    said="the $model made to check it with did not boot"
  fi
  simctl shutdown "$udid" >/dev/null 2>&1 || :
  simctl delete "$udid" >/dev/null 2>&1 || :
  printf '%s\n' "$said"
  [ "$worked" = yes ]
}

sshd_refuses_slots() {
  command -v sshd >/dev/null 2>&1 || return 1
  settings=$(sshd -T 2>/dev/null) || return 1
  users=$(printf '%s\n' "$settings" | awk '$1 == "allowusers" { for (i = 2; i <= NF; i++) print $i }')
  groups=$(printf '%s\n' "$settings" | awk '$1 == "allowgroups" { for (i = 2; i <= NF; i++) print $i }')
  [ -n "$users$groups" ] || return 1
  set -f
  for pattern in $users; do
    case bbd-1 in ${pattern%%@*}) set +f; return 1 ;; esac
  done
  for group in $groups; do
    case $group in _developer | com.apple.access_ssh | staff | localaccounts | everyone) set +f; return 1 ;; esac
  done
  set +f
  return 0
}

install_companion

install_software_encoder() {
  h264=$here/../android/build-h264.sh
  if [ ! -f "$h264" ]; then
    step "found no setup/android beside setup/ssh-pool, so no bb-box-h264: iOS video here needs the Mac's hardware encoder"
    return 0
  fi
  if [ "${H264_WITH_X264:-no}" = yes ]; then
    step "building bb-box-h264, with x264 from its pinned source, for iOS video should the Mac's hardware encoder fail"
    bash "$h264" "$ROOT/usr/local" --with-x264 >&2 || die "bb-box-h264 did not build"
  else
    step "building bb-box-h264, with Cisco's OpenH264, for iOS video should the Mac's hardware encoder fail"
    bash "$h264" "$ROOT/usr/local" >&2 || die "bb-box-h264 did not build"
  fi
}
install_software_encoder

step "installing device-host, its held ports' program and the slots' home"
mkdir -p "$ROOT$libexec" "$ROOT$share/ios" "$ROOT$share/slot-home"
install -m 0755 "$ios/device-host.sh" "$ROOT$helper"
install -m 0644 "$ios/device-host-ports.pl" "$ROOT$libexec/device-host-ports"
install -m 0644 "$here/mac-home/.zshenv" "$ROOT$share/slot-home/.zshenv"

set -- $(newest_ios_runtime)
[ $# -eq 3 ] || die "Xcode has no iOS Simulator runtime: run xcodebuild -downloadPlatform iOS, then run setup-mac.sh again"
runtime=$1 os=$2 build=$3
list=ios-$os-$build
[ -s "$ios/slim/$list.txt" ] || die "bb-box has no slimming list for iOS $os ($build), so it lends no iOS slot on this Mac: make one as docs/research/ios-simulator-slimming.md says, as setup/tart/ios/slim/$list.txt"
install -m 0644 "$ios/slim/$list.txt" "$ROOT$share/ios/$list.txt"
models_xcode_has >"$ROOT$share/ios/devices.tsv.new"
[ -s "$ROOT$share/ios/devices.tsv.new" ] || die "this Mac's Xcode can make none of bb-box's devices in $ios/devices.tsv"
chmod 0644 "$ROOT$share/ios/devices.tsv.new"
mv -f "$ROOT$share/ios/devices.tsv.new" "$ROOT$share/ios/devices.tsv"
seed=$ROOT$share/ios/$list.disabled.plist
sorted=$(mktemp)
grep . "$ios/slim/$list.txt" | sort -u >"$sorted"
if [ -s "$seed" ] && [ "$(missing_from_seed "$seed" "$sorted")" = 0 ]; then
  step "kept $list's seed, which has every label off"
else
  make_seed "$runtime" "$list" "$seed"
fi
rm -f "$sorted"
printf '%s\t%s\t%s\t%s\n' "$runtime" "$os" "$build" "$list" >"$ROOT$share/ios/runtimes.tsv"
chmod -R a+rX "$ROOT$share/ios" "$ROOT$share/slot-home"

/bin/sh "$ROOT$helper" install </dev/null >/dev/null
if [ -n "${HOST_SETTINGS:-}" ]; then
  step "writing device-host's daemons and setting it up as a host bb-box deletes after its last box"
  printf '%s\n' "$HOST_SETTINGS" | /bin/sh "$ROOT$helper" init >/dev/null
else
  step "writing device-host's daemons and setting it up as a kept host, closed until bb-box opens it"
  printf 'kept=yes\nmost=12\nahead=1\nresetting-most=4\ndisk-reserve-gib=40\n' | /bin/sh "$ROOT$helper" init >/dev/null
fi
if [ -z "${HOST_SETTINGS:-}" ]; then
  step "checking that a slot's user, with no desktop session, can set and read its device's clipboard"
  if said=$(slot_clipboard_works); then
    step "$said"
  else
    echo "warning=A slot cannot set or read its device's clipboard, so pasting into an ios box and copying from it fail: $said"
  fi
fi
echo "ios=$os $build $list companion=$idb_version"
if sshd_refuses_slots; then
  echo "warning=sshd lets only some users log in, with AllowUsers or AllowGroups, and no slot user, bbd-*, so no ios box can reach its slot. Add bbd-* beside bbx-* to AllowUsers in /etc/ssh/sshd_config or /etc/ssh/sshd_config.d; new connections read it."
fi
