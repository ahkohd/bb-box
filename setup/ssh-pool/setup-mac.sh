#!/bin/sh
# Sets up a Mac for bb-box's SSH host pool (047). Copy this directory to the
# Mac and run it there with sudo, from an administrator's account:
#
#   sudo sh setup-mac.sh --key "ssh-ed25519 AAAA... bb-box" [--name mac-mini]
#     [--address 192.0.2.30] [--port 22] [--admin bbbox-admin]
#
# --key is the public key bb-box's doctor shows. Give it once for each
# bb-box install that lends the Mac. The Mac must have Apple silicon,
# FileVault off and Remote Login on. It:
#
# - makes bb-box's admin user, hidden, which accepts only those keys, with no
#   forwarding or terminal, and may run only bb-box's helper as root
# - installs the helper, machine-mac.sh, as /usr/local/libexec/bb-box/machine,
#   and the box users' home template, mac-home, as /usr/local/share/bb-box/home
# - installs Homebrew if it is missing, as the administrator who ran sudo,
#   then Git, GitHub CLI and Node.js with it, and Cua Driver
# - installs BlackHole 2ch, the box's audio input (#631)
# - installs Google Chrome from Google's stable download, its signature
#   checked, with the Linux images' policies against its prompts, and box
#   users' profiles past its first run (mac-chrome.sh, which Tart's image
#   shares)
# - installs the agent CLIs BB runs threads with, Claude Code, Codex and Pi,
#   pinned as the Linux images pin them (#561)
# - builds bb-box-stream, each box's desktop as video (060), with swiftc
# - clears BB's daemon lock and PID file in box homes at boot (017)
# - keeps the Mac awake, starts it after a power failure, and turns off
#   automatic macOS updates, which would restart a box, automatic App Store
#   updates, which would change Xcode under the pool's offers, and Spotlight
#   indexing
# - with Xcode in /Applications, accepts its licence, runs its first launch,
#   downloads the iOS platform and lets developers debug without a password
# - has the helper note Xcode's version and Simulator runtimes, which the
#   pool's offers follow
# - starts the Mac's reset generation at 0 and makes the first box user,
#   bbx-0, the automatic login
# - prints the line for bb-box's machines setting, the host keys, and the
#   steps for a person at the Mac: Screen Sharing, Full Disk Access for
#   SSH, Cua Driver's grants, the grant for a viewer's input, and Xcode
#
# Running it again updates the helper, the template, Cua Driver and the keys,
# and keeps the reset generation. It replaces the keys, so give every
# install's key again. What an operator adds to the template is kept.

set -eu
umask 022
PATH=/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin
export PATH

# Empty on a Mac. The tests set it to a directory laid out as a Mac's, to run setup on Linux with stub macOS tools.
ROOT=

# Cua Driver, as Tart's image pins it in setup/tart/prepare-image.sh.
CUA_VERSION=0.30.4
CUA_SHA256=e270ea67388d794505031b0a15d8b58994c67e18e754a43634d7732251f595df
# BlackHole 2ch (#631), as Tart's image pins it in setup/tart/prepare-image.sh.
BLACKHOLE_VERSION=0.7.1
BLACKHOLE_SHA256=57b540f27a3e29c37e310e01bee0fdfab76733087e47f997ef9dccf851400dcf
# The agent CLIs BB runs threads with, at the versions the Linux images pin
# in setup/proxmox-lxc/template/pins.json (#561), for darwin-arm64. A test
# keeps the versions equal. Claude Code's SHA-256 is from its release
# manifest, Codex's and Pi's from GitHub's asset digests.
CLAUDE_VERSION=2.1.283
CLAUDE_SHA256=d8cb1e5c79684cc12a8bfc813e3a2073406921b6245744b3009be3ab5651d21e
CODEX_VERSION=0.157.1
CODEX_SHA256=3c45b162b7a76f51325015b1d0a8112c73219b7a9b59cd5762c37c9ba55894fa
PI_VERSION=0.87.1
PI_SHA256=4f8d288b78c9768d3a4ac6f61f06cd34394b82ac17d5b42d1e44a437add401b7

LIBEXEC=/usr/local/libexec/bb-box
SHARE=/usr/local/share/bb-box
BREW=/opt/homebrew/bin/brew
CUA_APP=/Applications/CuaDriver.app
here=$(cd "$(dirname "$0")" && pwd)
keys='' admin=bbbox-admin name='' address='' port=''

die() {
  printf 'setup-mac.sh: %s\n' "$*" >&2
  exit 1
}
usage() { die "usage: setup-mac.sh --key <public key> [--key <another install's key>] [--name <name>] [--address <host>] [--port <port>] [--admin <user>]"; }

while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case $1 in
    --key)
      case $2 in
        *"
"*) die "Give each --key one public key on one line." ;;
        "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"*) ;;
        *) die "Give --key the public key bb-box's doctor shows, starting ssh-ed25519." ;;
      esac
      keys="$keys$2
"
      ;;
    --admin) admin=$2 ;;
    --name) name=$2 ;;
    --address) address=$2 ;;
    --port) port=$2 ;;
    *) usage ;;
  esac
  shift 2
done

[ "$(id -u)" = 0 ] || die "Run it as root, with sudo."
[ "$(uname -s)" = Darwin ] || die "setup-mac.sh sets up a Mac. For a Linux machine, use setup.sh."
[ "$(uname -m)" = arm64 ] || die "bb-box lends only Macs with Apple silicon."
[ -n "$keys" ] || die "Give --key the public key bb-box's doctor shows, starting ssh-ed25519."
printf '%s\n' "$admin" | grep -Eq '^[a-z_][a-z0-9_-]{0,31}$' || die "--admin must be a user name."
case $admin in bbx-*) die "bbx- names are for box users. Choose another admin user." ;; esac
[ -f "$here/machine-mac.sh" ] && [ -d "$here/mac-home" ] && [ -f "$here/mac-chrome.sh" ] && [ -f "$here/mac-ios.sh" ] ||
  die "machine-mac.sh, mac-chrome.sh, mac-ios.sh and mac-home must be beside setup-mac.sh. Copy the whole setup/ssh-pool directory."
fdesetup status 2>/dev/null | grep -qx 'FileVault is Off\.' ||
  die "FileVault is on, or fdesetup could not say. A Mac signs box users in by itself only with FileVault off. Turn it off in System Settings, Privacy and Security, wait until it has decrypted the disk, then run setup-mac.sh again."
launchctl print system/com.openssh.sshd >/dev/null 2>&1 ||
  die "Remote Login is off. Turn it on in System Settings, General, Sharing, then run setup-mac.sh again."

# The admin user: hidden, with a random password nobody keeps, so only the key logs in.
if dscl . -read "/Users/$admin" >/dev/null 2>&1; then
  [ "$(id -F "$admin" 2>/dev/null)" = "bb-box admin" ] ||
    die "User $admin exists and setup-mac.sh did not make it. Choose a new name for bb-box's admin user with --admin."
else
  sysadminctl -addUser "$admin" -fullName "bb-box admin" -password "$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c 32)" \
    -home "/private/var/$admin" >/dev/null 2>&1 || :
  dscl . -read "/Users/$admin" >/dev/null 2>&1 || die "sysadminctl could not make user $admin."
  dscl . -create "/Users/$admin" IsHidden 1
fi
home=$(dscl . -read "/Users/$admin" NFSHomeDirectory | sed -n 's/^NFSHomeDirectory: //p')
[ -n "$home" ] || die "User $admin has no home directory."
uid=$(id -u "$admin")
gid=$(id -g "$admin")
mkdir -p "$ROOT$home/.ssh"
# Closed to box users, who are in staff, its group (047). sshd asks only that
# no one else may write to it.
chmod 0700 "$ROOT$home"
chmod 0700 "$ROOT$home/.ssh"
printf '%s' "$keys" | sed 's/^/restrict /' >"$ROOT$home/.ssh/authorized_keys.new"
chmod 0600 "$ROOT$home/.ssh/authorized_keys.new"
mv -f "$ROOT$home/.ssh/authorized_keys.new" "$ROOT$home/.ssh/authorized_keys"
chown "$uid:$gid" "$ROOT$home" "$ROOT$home/.ssh" "$ROOT$home/.ssh/authorized_keys"
# Where Remote Login allows only some users.
if dscl . -read /Groups/com.apple.access_ssh >/dev/null 2>&1; then
  dseditgroup -o edit -a "$admin" -t user com.apple.access_ssh
fi

# The helper and the box users' home template.
mkdir -p "$ROOT$LIBEXEC" "$ROOT$SHARE/home"
chmod 0755 "$ROOT$LIBEXEC"
install -m 0755 "$here/machine-mac.sh" "$ROOT$LIBEXEC/machine.new"
mv -f "$ROOT$LIBEXEC/machine.new" "$ROOT$LIBEXEC/machine"
# A screen-capture approval placed in the template by hand, before the helper
# wrote one for each user (047): each user now gets its own, of its own date.
replayd="$ROOT$SHARE/home/Library/Group Containers/group.com.apple.replayd"
rm -f "$replayd/ScreenCaptureApprovals.plist"
rmdir "$replayd" "$ROOT$SHARE/home/Library/Group Containers" 2>/dev/null || true
cp -R "$here/mac-home/." "$ROOT$SHARE/home/"

# The admin user may run the helper as root, and nothing else.
rule=$ROOT/etc/sudoers.d/bb-box
printf 'Defaults:%s !requiretty\n%s ALL=(root) NOPASSWD: %s/machine\n' "$admin" "$admin" "$LIBEXEC" >"$rule.new"
chmod 0440 "$rule.new"
visudo -cqf "$rule.new" >/dev/null || die "visudo refused the sudo rule in $rule.new."
mv -f "$rule.new" "$rule"

# Homebrew, which brew will not run as root, with what enrolment needs.
if [ ! -x "$ROOT$BREW" ]; then
  person=${SUDO_USER:-}
  [ -n "$person" ] && [ "$person" != root ] ||
    die "Homebrew is missing, and it installs as an administrator. Run setup-mac.sh with sudo from an administrator's account."
  echo "Installing Homebrew as $person."
  installer=$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh) || die "Could not download Homebrew's installer."
  sudo -u "$person" -H env NONINTERACTIVE=1 /bin/bash -c "$installer" || die "Homebrew's installer failed."
  [ -x "$ROOT$BREW" ] || die "Homebrew's installer did not install $BREW."
fi
owner=$(stat -f %Su "$ROOT/opt/homebrew")
# ffmpeg records a box's desktop for box_record (059).
sudo -u "$owner" -H "$ROOT$BREW" install git gh node ffmpeg || die "brew install git gh node ffmpeg failed."

# Cua Driver, pinned by version and SHA-256, in /Applications. Its daemon
# is a LaunchAgent in the home template, so it starts in each box user's
# session (015).
if [ "$(cat "$ROOT$SHARE/cua-driver" 2>/dev/null)" != "$CUA_VERSION" ] || [ ! -e "$ROOT$CUA_APP/Contents/MacOS/cua-driver" ]; then
  tmp=$(mktemp -d)
  archive=cua-driver-rs-$CUA_VERSION-darwin-arm64
  curl -fsSL --retry 3 -o "$tmp/cua.tgz" "https://github.com/trycua/cua/releases/download/cua-driver-rs-v$CUA_VERSION/$archive.tar.gz" ||
    die "Could not download Cua Driver $CUA_VERSION."
  echo "$CUA_SHA256  $tmp/cua.tgz" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || die "Cua Driver's archive does not match its pin."
  tar -xzf "$tmp/cua.tgz" -C "$tmp"
  rm -rf "$ROOT$CUA_APP"
  cp -R "$tmp/$archive/CuaDriver.app" "$ROOT/Applications/"
  rm -rf "$tmp"
  echo "$CUA_VERSION" >"$ROOT$SHARE/cua-driver"
fi
mkdir -p "$ROOT/usr/local/bin"
ln -sf "$CUA_APP/Contents/MacOS/cua-driver" "$ROOT/usr/local/bin/cua-driver"

# Google Chrome, which agents mostly use, as Tart's image has it: from
# Google's stable download, its signature checked, kept where it is as new.
# Box users' homes come from the template, which gets Chrome's profile past its first run and What's New.
ROOT=$ROOT sh "$here/mac-chrome.sh" "$ROOT$SHARE/home" >/dev/null || die "Could not install Google Chrome."

# The agent CLIs, so threads on a box can run (#561): each pinned by
# version and SHA-256, in /usr/local/lib/bb-box/<name>-<version>, linked
# from /usr/local/bin, which box users' PATH has. An earlier version goes.
TOOLS=/usr/local/lib/bb-box
tool() { # name version sha256 url strip command path
  dest=$TOOLS/$1-$2
  if [ ! -x "$ROOT$dest/$7" ]; then
    tmp=$(mktemp -d)
    curl -fsSL --retry 3 -o "$tmp/download" "$4" || die "Could not download $1 $2."
    echo "$3  $tmp/download" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || die "$1's download does not match its pin."
    rm -rf "$ROOT$dest.partial"
    mkdir -p "$ROOT$dest.partial"
    case $4 in
      *.tar.gz) tar -xzf "$tmp/download" -C "$ROOT$dest.partial" --strip-components "$5" ;;
      *) install -m 0755 "$tmp/download" "$ROOT$dest.partial/$7" ;;
    esac
    rm -rf "$tmp"
    [ -x "$ROOT$dest.partial/$7" ] || die "$1 $2 has no $7."
    chown -R root:wheel "$ROOT$dest.partial" && chmod -R go-w "$ROOT$dest.partial"
    rm -rf "$ROOT$dest" && mv "$ROOT$dest.partial" "$ROOT$dest"
  fi
  ln -sfn "$dest/$7" "$ROOT/usr/local/bin/$6"
  for old in "$ROOT$TOOLS/$1"-[0-9]*; do [ "$old" = "$ROOT$dest" ] || [ ! -d "$old" ] || rm -rf "$old"; done
}
mkdir -p "$ROOT$TOOLS"
tool claude-code "$CLAUDE_VERSION" "$CLAUDE_SHA256" \
  "https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases/$CLAUDE_VERSION/darwin-arm64/claude" 0 claude claude
tool codex "$CODEX_VERSION" "$CODEX_SHA256" \
  "https://github.com/openai/codex/releases/download/rust-v$CODEX_VERSION/codex-aarch64-apple-darwin.tar.gz" 0 codex codex-aarch64-apple-darwin
tool pi "$PI_VERSION" "$PI_SHA256" \
  "https://github.com/earendil-works/pi/releases/download/v$PI_VERSION/pi-darwin-arm64.tar.gz" 1 pi pi

# BlackHole 2ch (#631, 058): a virtual audio device whose output comes back on
# its input. The Mac has no microphone of its own, so it is the only input, and
# macOS makes it the default: a box records through it, and say -a BlackHole
# feeds it speech. A Core Audio plug-in, not a kernel extension.
if [ "$(cat "$ROOT$SHARE/blackhole" 2>/dev/null)" != "$BLACKHOLE_VERSION" ]; then
  tmp=$(mktemp -d)
  curl -fsSL --retry 3 -o "$tmp/blackhole.pkg" "https://existential.audio/downloads/BlackHole2ch-$BLACKHOLE_VERSION.pkg" ||
    die "Could not download BlackHole $BLACKHOLE_VERSION."
  echo "$BLACKHOLE_SHA256  $tmp/blackhole.pkg" | shasum -a 256 -c --quiet - >/dev/null 2>&1 || die "BlackHole's package does not match its pin."
  installer -pkg "$tmp/blackhole.pkg" -target / >/dev/null || die "BlackHole's installer failed."
  rm -rf "$tmp"
  killall coreaudiod 2>/dev/null || :
  echo "$BLACKHOLE_VERSION" >"$ROOT$SHARE/blackhole"
fi

# 058: bb-box-own runs a program as its own responsible process, so the
# permissions bb-box grants that program are the ones macOS checks. Built
# with the Command Line Tools' clang, which Homebrew needs anyway.
own_built=
if clang -O -o "$ROOT/usr/local/bin/bb-box-own.new" "$here/mac-own.c" 2>/dev/null; then
  chmod 0755 "$ROOT/usr/local/bin/bb-box-own.new" && mv -f "$ROOT/usr/local/bin/bb-box-own.new" "$ROOT/usr/local/bin/bb-box-own" && own_built=1
fi
# bb-box-display gives each box user's desktop the 2x mode of its size, for
# the session, where the display offers one, as with an HDMI dummy plug: the
# viewer then draws it as sharp as the Mac does.
display_built=
if clang -O -framework ApplicationServices -o "$ROOT/usr/local/bin/bb-box-display.new" "$here/mac-display.c" 2>/dev/null; then
  chmod 0755 "$ROOT/usr/local/bin/bb-box-display.new" && mv -f "$ROOT/usr/local/bin/bb-box-display.new" "$ROOT/usr/local/bin/bb-box-display" && display_built=1
fi

# 060: bb-box-stream streams each box user's desktop as H.264 video, for the
# panel's video client. It runs over the box user's SSH in the desktop
# session, so it has the Screen Recording and Accessibility that
# sshd-keygen-wrapper has below. Built with the Command Line Tools' swiftc.
stream_built=
if swiftc -O -swift-version 5 -o "$ROOT/usr/local/bin/bb-box-stream.new" "$here/mac-stream.swift" 2>/dev/null; then
  chmod 0755 "$ROOT/usr/local/bin/bb-box-stream.new" && mv -f "$ROOT/usr/local/bin/bb-box-stream.new" "$ROOT/usr/local/bin/bb-box-stream" && stream_built=1
fi

# 058: with System Integrity Protection off, a box's commands run over SSH,
# charged to sshd-keygen-wrapper, get Screen Recording as they have
# Accessibility, so they can capture the box's screen. A person grants the
# Accessibility at setup; no person can grant this with SIP on.
sip_granted=
if csrutil status 2>/dev/null | grep -q 'status: disabled'; then
  db="$ROOT/Library/Application Support/com.apple.TCC/TCC.db"
  wrapper=/usr/libexec/sshd-keygen-wrapper
  requirement=$(codesign -d -r- "$ROOT$wrapper" 2>&1 | sed -n 's/^designated => //p' | head -n 1)
  blob=$(printf '%s' "$requirement" | csreq -r- -b /dev/stdout 2>/dev/null | xxd -p | tr -d '\n')
  now=$(date +%s)
  if [ -n "$blob" ] && sqlite3 "$db" "DELETE FROM access WHERE service = 'kTCCServiceScreenCapture' AND client = '$wrapper';
    INSERT INTO access (service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded)
    VALUES ('kTCCServiceScreenCapture', '$wrapper', 1, 2, 4, 1, X'$blob', NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', $now);" 2>/dev/null; then
    sip_granted=1
  fi
fi

# 017: a box's BB daemon leaves its lock and PID file after a hard stop. Clear them at boot.
daemon=$ROOT/Library/LaunchDaemons/dev.bb-box.clear-bb-state.plist
cat >"$daemon" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>dev.bb-box.clear-bb-state</string>
<key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string>
<string>rm -rf /Users/bbx-*/.bb-machines/*/daemon.lock.lock /Users/bbx-*/.bb-machines/*/install-daemon.pid</string></array>
<key>RunAtLoad</key><true/>
</dict></plist>
PLIST
chown 0:0 "$daemon"
chmod 0644 "$daemon"

# Awake and quiet: a box's desktop is watched remotely, and an update would restart it.
pmset -a sleep 0 displaysleep 0 disksleep 0 autorestart 1 >/dev/null
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallMacOSUpdates -bool false
# Nor App Store apps, such as Xcode, which a person updates and then runs this again.
# macOS 27 keeps the App Store's Automatic Updates in com.apple.commerce, and System
# Settings has no switch for them. Earlier macOS kept them in SoftwareUpdate.
defaults write /Library/Preferences/com.apple.SoftwareUpdate AutomaticallyInstallAppUpdates -bool false
defaults write /Library/Preferences/com.apple.commerce AutoUpdate -bool false
softwareupdate --schedule off >/dev/null 2>&1 || :
mdutil -a -i off >/dev/null 2>&1 || :

warnings=''
warn() { warnings="$warnings
- $*"; }
[ -n "$display_built" ] ||
  warn "clang could not build bb-box-display, so desktops stay at 1x. Install the Command Line Tools: xcode-select --install, then run setup-mac.sh again."
[ -n "$stream_built" ] ||
  warn "swiftc could not build bb-box-stream, so desktops show over Screen Sharing only, not as video. Install the Command Line Tools: xcode-select --install, then run setup-mac.sh again."
[ -n "$own_built" ] ||
  warn "clang could not build bb-box-own, so programs granted permissions cannot run as their own responsible process. Install the Command Line Tools: xcode-select --install, then run setup-mac.sh again."
if csrutil status 2>/dev/null | grep -q 'status: disabled' && [ -z "$sip_granted" ]; then
  warn "SIP is off, but Screen Recording could not be granted to sshd-keygen-wrapper, so box_run's commands cannot capture the screen."
fi

# Xcode is the operator's to install, as its download needs an Apple Account.
xcode=no
if [ -d "$ROOT/Applications/Xcode.app" ]; then
  xcode=yes
  echo "Preparing Xcode. Downloading the iOS platform the first time takes a while."
  xcode-select -s /Applications/Xcode.app/Contents/Developer || warn "xcode-select could not choose /Applications/Xcode.app."
  xcodebuild -license accept || warn "Xcode's licence was not accepted. Run sudo xcodebuild -license accept."
  xcodebuild -runFirstLaunch >/dev/null || warn "Xcode's first launch failed. Run sudo xcodebuild -runFirstLaunch."
  if ! xcrun simctl list runtimes 2>/dev/null | grep -q '^iOS '; then
    xcodebuild -downloadPlatform iOS || warn "Xcode did not download the iOS platform. Run xcodebuild -downloadPlatform iOS."
  fi
  # Box users are in _developer, so the debugger and Instruments need no password.
  DevToolsSecurity -enable >/dev/null || warn "DevToolsSecurity -enable failed, so box users need a password to debug."
fi

ios_slots=no
if [ "$xcode" = yes ] && [ -d "$here/../tart/ios" ]; then
  echo "Setting up iOS slots (064): idb_companion, the slimming lists and a seed, and the slots' helper. Making the seed takes a few minutes the first time."
  if ios_said=$(sh "$here/mac-ios.sh" "$here" "$admin"); then
    ios_slots=yes
    ios_warning=$(printf '%s\n' "$ios_said" | sed -n 's/^warning=//p')
    [ -z "$ios_warning" ] || warn "$ios_warning"
  else
    warn "iOS slots are not set up, so the Mac lends no ios box: mac-ios.sh says why above. Fix it, then run setup-mac.sh again."
  fi
elif [ "$xcode" = yes ]; then
  warn "iOS slots are not set up, as setup/tart/ios is not beside setup/ssh-pool. To lend ios boxes from this Mac, copy the whole setup folder, then run setup-mac.sh again."
fi

"$ROOT$LIBEXEC/machine" init >/dev/null || die "The helper could not make the first box user. Fix what it says above, then run setup-mac.sh again."
# `status xcode` notes Xcode's runtimes, which plain status, and so the pool, reads.
status=$("$ROOT$LIBEXEC/machine" status xcode) || warn "The helper could not list Xcode's Simulator runtimes. Check that sudo xcrun simctl list runtimes works, then run setup-mac.sh again."
value() { printf '%s\n' "$status" | sed -n "s/^$1=//p" | head -n 1; }
snapshots=$("$ROOT$LIBEXEC/machine" snapshot probe 2>&1) || {
  warn "The helper's snapshot probe failed: $(printf '%s\n' "$snapshots" | tail -n 1). bb box doctor probes it again."
  snapshots=''
}
probed() { printf '%s\n' "$snapshots" | sed -n "s/^snapshot\.$1=//p" | head -n 1; }
generation=$(value generation)

# What BB's installer and a box's GitHub access need.
node=$(value node | sed 's/^v//')
lacks=$(value lacks | sed 's/ /, /g')
if [ -z "$node" ]; then
  warn "Node.js is missing. BB's installer needs Node.js 22.19 or newer with npm: brew install node."
elif ! printf '%s\n' "$node" | awk -F. '{ exit !($1 > 22 || ($1 == 22 && $2 >= 19)) }'; then
  warn "Node.js is $node, but BB's installer needs 22.19 or newer with npm: brew upgrade node."
fi
[ -z "$lacks" ] || warn "This Mac lacks $lacks. BB's installer needs npm, and boxes need git and gh for the thread's GitHub access: brew install git gh node."

# The panes for Cua Driver's grants and the viewer's input, for the person at the Mac.
person=${SUDO_USER:-}
if [ -n "$person" ] && [ "$(value console)" = "$person" ]; then
  sudo -u "$person" open "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility" >/dev/null 2>&1 || :
  sudo -u "$person" open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture" >/dev/null 2>&1 || :
fi

[ -n "$name" ] || name=$(scutil --get LocalHostName 2>/dev/null | tr 'A-Z_.' 'a-z--' || true)
[ -n "$name" ] || name=mac
[ -n "$address" ] || address=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)
[ -n "$address" ] || address=$(scutil --get LocalHostName 2>/dev/null | sed 's/$/.local/' || true)
[ -n "$port" ] || port=22
case $address in *:*) target="[$address]" ;; *) target=$address ;; esac
[ "$port" = 22 ] || target="$target:$port"
known=$address
[ "$port" = 22 ] || known="[$address]:$port"

echo "This Mac is ready for bb-box's SSH host pool, at reset generation $generation, once a person has done the steps below."
echo
echo "Add this line to the SSH host pool's machines setting. Use another name or address if bb-box reaches it by another:"
echo
if [ "$ios_slots" = yes ]; then
  echo "  $name $admin@$target macos,macos-desktop,ios"
  echo
  echo "With ios, it lends iOS slots ($(printf '%s\n' "$ios_said" | sed -n 's/^ios=//p')): a macOS user with its own device for each ios box asked for with shared: true, and it is lent whole only while it lends none. Leave ios out to keep it for whole boxes."
else
  echo "  $name $admin@$target macos,macos-desktop"
fi
echo
echo "Add these lines to the SSH host pool's host keys setting:"
echo
for file in "$ROOT"/etc/ssh/ssh_host_*_key.pub; do
  [ -f "$file" ] || continue
  printf '  %s %s\n' "$known" "$(cut -d' ' -f1,2 "$file")"
done
echo
echo "Then, at the Mac or through Screen Sharing:"
echo
echo "1. Turn on Screen Sharing in System Settings, General, Sharing, if it is off. Under its options, allow all users, and leave the VNC password off."
echo "2. In System Settings, General, Sharing, select the (i) beside Remote Login, and turn on Allow full disk access for remote users. Without it, the reset cannot remove the protected folders a box's user has, such as ~/Library/Mail."
echo "3. Turn on CuaDriver under Accessibility and under Screen Recording, in System Settings, Privacy and Security."
echo "4. Under Accessibility, also add and turn on /usr/bin/osascript and /usr/libexec/sshd-keygen-wrapper: select +, press Command-Shift-G and enter each path. A person's keys and pointer in the desktop's viewer reach the box user's session through them, as Screen Sharing ignores them."
step=5
if [ "$xcode" = no ]; then
  echo "$step. If boxes need Xcode or the iOS Simulator, install Xcode in /Applications, then run setup-mac.sh again."
  step=$((step + 1))
fi
if [ "$(value console)" != "$(value autologin)" ]; then
  echo "$step. Restart the Mac, so that it signs in the first box user, $(value autologin)."
fi
if [ -n "$snapshots" ]; then
  echo
  echo "For snapshots, which bb-box does not take on pool machines yet, it reported: box homes on $(probed filesystem) under $(probed homes), home snapshots $(probed home), snapshot hook $(probed hook). bb box doctor shows what each machine could offer."
fi
if [ -n "$warnings" ]; then
  echo
  echo "Check these before you add it:$warnings"
fi
