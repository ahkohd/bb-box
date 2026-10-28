#!/bin/sh
# Grants an app Accessibility and Screen Recording in a stopped Tart VM, by
# writing the guest's system TCC database from the host. macOS protects that
# database on the running guest, but not on a disk the host mounts, which is
# how Devin prepares its Mac images. Run on the Mac, as the user that owns
# the VM, while the VM is stopped:
#
#   grant-tcc.sh <vm> <path to the app on this Mac> [<service>...]
#
# The app must be the same signed build the VM has: the rows hold its code
# requirement, so they keep working across updates signed by the same team.
# Services default to kTCCServiceAccessibility and kTCCServiceScreenCapture.
set -eu
die() { echo "grant-tcc: $*" >&2; exit 1; }
[ $# -ge 2 ] || die "usage: grant-tcc.sh <vm> <app> [<service>...]"
vm=$1 app=$2
shift 2
[ $# -gt 0 ] || set -- kTCCServiceAccessibility kTCCServiceScreenCapture
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.nix-profile/bin:$PATH"
command -v perl >/dev/null 2>&1 || die "perl is not on the PATH: it reads Tart's run lock. macOS has it in /usr/bin."
run_lock_holders() { perl -e 'use Fcntl; my $darwin = $^O eq "darwin"; for my $f (@ARGV) { open(my $h, "<", $f) or next; my $l = $darwin ? pack("q q l s s", 0, 0, 0, F_RDLCK, 0) : pack("s s x4 q q l x4", F_RDLCK, 0, 0, 0, 0); fcntl($h, F_GETLK, $l) or next; my ($type, $pid) = $darwin ? (unpack("q q l s s", $l))[3, 2] : (unpack("s s x4 q q l x4", $l))[0, 4]; print "$pid $f\n" if $type != F_UNLCK }' "$@"; }
tart_lists() {
  [ -f "$1/config.json" ] && [ -f "$1/nvram.bin" ] || return 1
  if [ -f "$1/disk.img" ]; then [ ! -f "$1/overlay.asif" ]; else [ -f "$1/manifest.json" ] && [ -f "$1/overlay.asif" ]; fi
}
folder="${TART_HOME:-$HOME/.tart}/vms/$vm"
disk="$folder/disk.img"
tart_lists "$folder" || die "no Tart VM $vm"
[ -f "$disk" ] || die "$vm has no disk.img to write: its disk is an overlay"
held=$(run_lock_holders "$folder/config.json") || die "could not read Tart's run lock on $vm"
[ -z "$held" ] || die "$vm must be stopped, not running"
[ ! -f "$folder/state.vzvmsave" ] || die "$vm must be stopped, not suspended"

bundle=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist") || die "$app is not an app"
requirement=$(codesign -d -r- "$app" 2>&1 | sed -n 's/^designated => //p')
[ -n "$requirement" ] || die "$app has no designated requirement: is it signed?"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
printf '%s' "$requirement" | csreq -r- -b "$tmp/csreq" || die "csreq could not compile $app's requirement"
csreq=$(xxd -p "$tmp/csreq" | tr -d '\n')

# Attach the disk (Tart's are Apple sparse images) without mounting it, then
# mount only the guest's Data volume, hidden from Finder and with owners
# ignored, so this user can write the guest's root-owned files.
diskutil image attach --noMount "$disk" >"$tmp/attach" || die "could not attach $disk"
device=$(head -1 "$tmp/attach" | cut -f1 | tr -d ' ')
detach() { diskutil unmount "$tmp/mnt" >/dev/null 2>&1; diskutil eject "$device" >/dev/null 2>&1 || :; }
trap 'detach; rm -rf "$tmp"' EXIT
data=
for volume in $(awk '/Apple_APFS_Volume/ { print $1 }' "$tmp/attach"); do
  case "$(diskutil info "$volume" | sed -n 's/^ *Volume Name: *//p')" in
    Data | *" - Data") data=$volume; break ;;
  esac
done
[ -n "$data" ] || die "found no Data volume on $vm's disk"
mkdir "$tmp/mnt"
diskutil mount -mountOptions noowners,nobrowse -mountPoint "$tmp/mnt" "$data" >/dev/null || die "could not mount $vm's Data volume"
db="$tmp/mnt/Library/Application Support/com.apple.TCC/TCC.db"
[ -f "$db" ] || die "found no TCC database on $vm's disk: is FileVault on in the guest?"

now=$(date +%s)
for service in "$@"; do
  sqlite3 "$db" "INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded) VALUES ('$service', '$bundle', 0, 2, 4, 1, X'$csreq', NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', 0);" ||
    die "could not write $service for $bundle"
  echo "granted $service to $bundle in $vm"
done
