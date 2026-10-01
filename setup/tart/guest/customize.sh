#!/bin/sh
# Runs inside the image's VM as its user, through `tart exec`, while
# prepare-image.sh builds the image. The user has passwordless sudo, as in
# Cirrus Labs' images. Settings come in the environment:
#
#   BBBOX_SSH_PUBLIC_KEY  bb-box's public keys, one per line, which the user accepts
#   CUA_VERSION           Cua Driver release to install, for example 0.30.4
#   CUA_SHA256            SHA-256 of its darwin-arm64 archive
#   BB_URL                optional: BB's server URL, to pre-install bb-app
set -eu
user=$(id -un)
home=$HOME
die() { echo "customize: $*" >&2; exit 1; }
[ -n "${BBBOX_SSH_PUBLIC_KEY:-}" ] || die "BBBOX_SSH_PUBLIC_KEY is not set"
[ -n "${CUA_VERSION:-}" ] && [ -n "${CUA_SHA256:-}" ] || die "CUA_VERSION and CUA_SHA256 must be set"
sudo -n true 2>/dev/null || die "$user needs passwordless sudo while the image is built"

# bb-box's key, marked so it is easy to find. SSH takes keys only.
mkdir -p "$home/.ssh" && chmod 700 "$home/.ssh"
touch "$home/.ssh/authorized_keys" && chmod 600 "$home/.ssh/authorized_keys"
printf '%s\n' "$BBBOX_SSH_PUBLIC_KEY" | while read -r line; do
  [ -n "$line" ] || continue
  grep -qF "$(echo "$line" | awk '{print $2}')" "$home/.ssh/authorized_keys" || printf '%s\n' "$line" >>"$home/.ssh/authorized_keys"
done
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\n' | sudo tee /etc/ssh/sshd_config.d/100-bb-box.conf >/dev/null

# Commands over SSH run in a non-login zsh, which reads only ~/.zshenv: give
# them the PATH a login shell has, with Homebrew and Node, and Cua Driver's
# telemetry and update check off for its CLI too.
cat >"$home/.zshenv" <<'ZSHENV'
# Added by bb-box: the login PATH, Homebrew and Node for SSH commands, which skip ~/.zprofile.
if [ -x /usr/libexec/path_helper ]; then eval "$(/usr/libexec/path_helper -s)"; fi
if [ -d /opt/homebrew/bin ]; then
  export HOMEBREW_PREFIX=/opt/homebrew HOMEBREW_CELLAR=/opt/homebrew/Cellar HOMEBREW_REPOSITORY=/opt/homebrew
  PATH="/opt/homebrew/bin:/opt/homebrew/sbin:$PATH"
fi
for d in /opt/homebrew/opt/node@24/bin /opt/homebrew/opt/node/bin; do if [ -d "$d" ]; then PATH="$d:$PATH"; break; fi; done
export PATH CUA_DRIVER_RS_TELEMETRY_ENABLED=false CUA_DRIVER_RS_UPDATE_CHECK=false
ZSHENV

# Stay awake, unlocked and quiet: a box's desktop is watched remotely.
sudo pmset -a sleep 0 displaysleep 0 disksleep 0 >/dev/null
defaults -currentHost write com.apple.screensaver idleTime -int 0
sudo softwareupdate --schedule off >/dev/null 2>&1 || :
sudo mdutil -a -i off >/dev/null 2>&1 || :

# BB's daemon leaves its lock and PID file after a hard stop; clear them at
# boot so a box that restarts reconnects at once (decision 017).
sudo tee /Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist >/dev/null <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.bb-box.clear-bb-state</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
<string>rm -rf $home/.bb-machines/*/daemon.lock.lock $home/.bb-machines/*/install-daemon.pid</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PLIST
sudo chown root:wheel /Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist
sudo chmod 0644 /Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist

# Cua Driver, pinned by version and SHA-256, its daemon a LaunchAgent in the
# user's desktop session (decision 015). Telemetry and update checks are off.
tmp=$(mktemp -d)
archive="cua-driver-rs-$CUA_VERSION-darwin-arm64"
curl -fsSL --retry 3 -o "$tmp/cua.tgz" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$CUA_VERSION/$archive.tar.gz"
echo "$CUA_SHA256  $tmp/cua.tgz" | shasum -a 256 -c --quiet - || die "Cua Driver's archive does not match CUA_SHA256"
tar -xzf "$tmp/cua.tgz" -C "$tmp"
sudo rm -rf /Applications/CuaDriver.app
sudo cp -R "$tmp/$archive/CuaDriver.app" /Applications/
sudo mkdir -p /usr/local/bin
sudo ln -sf /Applications/CuaDriver.app/Contents/MacOS/cua-driver /usr/local/bin/cua-driver
rm -rf "$tmp"
CUA_DRIVER_RS_TELEMETRY_ENABLED=false /usr/local/bin/cua-driver telemetry disable >/dev/null
mkdir -p "$home/Library/LaunchAgents"
cat >"$home/Library/LaunchAgents/com.trycua.cua-driver.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>com.trycua.cua-driver</string>
<key>ProgramArguments</key><array><string>/Applications/CuaDriver.app/Contents/MacOS/cua-driver</string><string>serve</string></array>
<key>EnvironmentVariables</key><dict>
<key>CUA_DRIVER_RS_TELEMETRY_ENABLED</key><string>false</string>
<key>CUA_DRIVER_RS_UPDATE_CHECK</key><string>false</string>
</dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><true/>
<key>ProcessType</key><string>Interactive</string>
</dict></plist>
PLIST

# Screen capture without a person. On macOS 26 and later, an app's first
# capture that bypasses the system's window picker raises a consent dialog,
# and again after 30 days; replayd records when it last alerted. An entry
# dated far ahead means Cua's first capture, after a boot or a resume too,
# raises none. The dialog's Allow writes nothing else.
replayd="$home/Library/Group Containers/group.com.apple.replayd"
mkdir -p "$replayd" && chmod 700 "$replayd"
cat >"$replayd/ScreenCaptureApprovals.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>com.trycua.driver</key><dict>
<key>kScreenCaptureAlertableUsageCount</key><integer>1</integer>
<key>kScreenCaptureApprovalLastAlerted</key><date>3000-01-01T00:00:00Z</date>
<key>kScreenCaptureApprovalLastUsed</key><date>3000-01-01T00:00:00Z</date>
<key>kScreenCapturePrivacyHintDate</key><date>3000-01-01T00:00:00Z</date>
<key>kScreenCapturePrivacyHintPolicy</key><integer>2592000</integer>
</dict></dict></plist>
PLIST
chmod 600 "$replayd/ScreenCaptureApprovals.plist"

# No "App Background Activity" notices: BB's daemon is added when a box
# enrols, and Notification Center keeps an unread notice and shows it again
# at every login. The user's Background Task Management agent posts them;
# with it off, background items still load and run. Then the notices kept so
# far, such as the one for Tart's guest agent, go.
launchctl disable "gui/$(id -u)/com.apple.backgroundtaskmanagement.agent"
sqlite3 "$home/Library/Group Containers/group.com.apple.usernoted/db2/db" \
  "delete from app where identifier = 'com.apple.btmnotificationagent';" 2>/dev/null || :
killall usernoted NotificationCenter 2>/dev/null || :

# BB's host daemon package, where BB's installer looks for it, so enrolment
# skips its download and npm install. A newer server build downloads as usual.
if [ -n "${BB_URL:-}" ]; then
  bb_host=$(node -e 'process.stdout.write(new URL(process.argv[1]).host.replace(/[^a-zA-Z0-9.-]/gu, "-"))' "$BB_URL")
  data_dir=$home/.bb-machines/$bb_host
  mkdir -p "$data_dir"
  curl -fsS -D "$home/bb-app.headers" -o "$home/bb-app.tgz" "${BB_URL%/}/install/bb-app.tgz"
  digest=$(sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\).*/\1/Ip' "$home/bb-app.headers" | tr -d '\r' | tail -1)
  echo "$digest  $home/bb-app.tgz" | shasum -a 256 -c --quiet - || die "bb-app.tgz does not match the server's digest"
  npm install -g --no-fund --no-audit --allow-scripts=better-sqlite3,node-pty,@parcel/watcher --prefix "$data_dir/npm" "$home/bb-app.tgz"
  (umask 077 && printf '%s\n' "$digest" >"$data_dir/host-artifact.sha256")
  rm -f "$home/bb-app.tgz" "$home/bb-app.headers"
fi
echo "customize: done"
