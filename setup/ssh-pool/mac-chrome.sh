#!/bin/sh
# Installs Google Chrome on a Mac, as root: from setup-mac.sh on a pool Mac,
# and in Tart's macOS image, which prepare-image.sh builds and refreshes.
#
#   sudo sh mac-chrome.sh
#
# Chrome comes from Google's stable download, which names no version, so its
# signature is the check, as the Linux images check Chrome's package against
# Google's signed index: the app must verify, Gatekeeper must accept it as
# notarised, and it must be signed by Google's team, EQHXZ8M8AV. (codesign's
# --strict refuses Google's own app, for a helper's extended attributes.)
# A Chrome already there that is as new is kept, as Chrome
# updates itself. Its machine policies are the Linux images': no first-run,
# default-browser, promotion or sign-in prompts, and no metrics. Prints
# chrome=<version>.
set -eu
# Empty on a Mac. The tests set it to a directory laid out as a Mac's.
ROOT=${ROOT:-}
URL=https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg
TEAM=EQHXZ8M8AV
APP="$ROOT/Applications/Google Chrome.app"
POLICIES="$ROOT/Library/Managed Preferences/com.google.Chrome.plist"

die() { echo "mac-chrome.sh: $*" >&2; exit 1; }
version() { plutil -extract CFBundleShortVersionString raw "$1/Contents/Info.plist" 2>/dev/null || :; }
# Whether version $1 is at least $2, field by field.
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); for (i = 1; i <= (n > m ? n : m); i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; }

tmp=$(mktemp -d)
mount=$tmp/mount
mkdir "$mount"
trap 'hdiutil detach -quiet "$mount" >/dev/null 2>&1 || :; rm -rf "$tmp"' EXIT
curl -fsSL --retry 3 -o "$tmp/chrome.dmg" "$URL" || die "could not download Chrome from $URL"
hdiutil attach -nobrowse -readonly -quiet -mountpoint "$mount" "$tmp/chrome.dmg" || die "could not open Chrome's disk image"
new="$mount/Google Chrome.app"
[ -d "$new" ] || die "Chrome's disk image has no Google Chrome.app"
codesign --verify --deep "$new" || die "Chrome's app does not verify as signed"
spctl --assess --type execute "$new" || die "Gatekeeper does not accept Chrome's app as notarised"
codesign -dv "$new" 2>&1 | grep -qx "TeamIdentifier=$TEAM" || die "Chrome's app is not signed by Google's team, $TEAM"
offered=$(version "$new")
[ -n "$offered" ] || die "Chrome's app gives no version"
had=$(version "$APP")
if [ -n "$had" ] && at_least "$had" "$offered"; then
  echo "mac-chrome.sh: keeping Chrome $had, as new as Google's $offered" >&2
else
  rm -rf "$APP"
  ditto "$new" "$APP"
fi

mkdir -p "$(dirname "$POLICIES")"
cat >"$POLICIES" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>MetricsReportingEnabled</key><false/>
<key>DefaultBrowserSettingEnabled</key><false/>
<key>PromotionsEnabled</key><false/>
<key>BrowserSignin</key><integer>0</integer>
<key>SyncDisabled</key><true/>
</dict></plist>
PLIST
chmod 0644 "$POLICIES"
echo "chrome=$(version "$APP")"
