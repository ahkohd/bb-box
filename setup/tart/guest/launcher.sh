#!/bin/sh
# bb-box's launcher for desktop commands (#628), built in the image's VM as
# its user, after customize.sh. A command bb-box runs in the desktop session
# goes through it.
#
# TCC attributes what a command over SSH starts to sshd-keygen-wrapper, a
# platform binary, for which tccd never prompts, so an app started that way
# cannot have the microphone or the system's audio. The launcher spawns
# itself again with its responsibility disclaimed, so that copy is its own
# responsible process, and runs the command as its child: what the command
# starts is attributed to the launcher, as Terminal's children are to
# Terminal. The launcher has the rows sshd-keygen-wrapper has in the
# system's TCC database, and the microphone, the camera and the system's
# audio in the user's, so nothing prompts. SIP is off in Cirrus Labs'
# images, so both databases can be written here.
set -eu
die() { echo "launcher: $*" >&2; exit 1; }
user=$(id -un)
id=dev.bb-box.launcher
app=/usr/local/libexec/bb-box/Launcher.app
exe=$app/Contents/MacOS/bb-box-launcher
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

cat >"$tmp/launcher.c" <<'EOF'
/* bb-box's launcher (#628): runs a command as the child of a process that
 * is its own responsible process for TCC, so the command's requests are
 * the launcher's. usage: bb-box-launcher <command> [<argument>...] */
#include <errno.h>
#include <limits.h>
#include <mach-o/dyld.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;
/* libsystem's, as Qt Creator's and LLDB's launchers use it. */
int responsibility_spawnattrs_setdisclaim(posix_spawnattr_t *attrs, int disclaim);

static pid_t child = 0;
static void forward(int sig) { if (child > 0) kill(child, sig); }

/* Runs the command and waits for it: its exit status, or its signal again. */
static int run(const char *path, char *const argv[], int disclaim) {
  posix_spawnattr_t attr;
  posix_spawnattr_init(&attr);
  if (disclaim && responsibility_spawnattrs_setdisclaim(&attr, 1) != 0) {
    fprintf(stderr, "bb-box-launcher: could not disclaim responsibility\n");
    return 127;
  }
  int err = disclaim ? posix_spawn(&child, path, NULL, &attr, argv, environ) : posix_spawnp(&child, path, NULL, &attr, argv, environ);
  posix_spawnattr_destroy(&attr);
  if (err) {
    fprintf(stderr, "bb-box-launcher: %s: %s\n", path, strerror(err));
    return 127;
  }
  int status;
  while (waitpid(child, &status, 0) < 0)
    if (errno != EINTR) return 127;
  if (WIFEXITED(status)) return WEXITSTATUS(status);
  if (WIFSIGNALED(status)) {
    int sig = WTERMSIG(status);
    signal(sig, SIG_DFL);
    kill(getpid(), sig);
    return 128 + sig;
  }
  return 127;
}

int main(int argc, char *argv[]) {
  if (argc < 2) {
    fprintf(stderr, "usage: bb-box-launcher <command> [<argument>...]\n");
    return 2;
  }
  int sigs[] = {SIGHUP, SIGINT, SIGQUIT, SIGTERM, SIGUSR1, SIGUSR2};
  struct sigaction sa;
  memset(&sa, 0, sizeof sa);
  sa.sa_handler = forward;
  for (size_t i = 0; i < sizeof sigs / sizeof *sigs; i++) sigaction(sigs[i], &sa, NULL);
  /* First, itself again, disclaimed; then, in that copy, the command. */
  if (!getenv("BBBOX_LAUNCHER_DISCLAIMED")) {
    char self[PATH_MAX];
    uint32_t size = sizeof self;
    if (_NSGetExecutablePath(self, &size) != 0) return 127;
    setenv("BBBOX_LAUNCHER_DISCLAIMED", "1", 1);
    return run(self, argv, 1);
  }
  unsetenv("BBBOX_LAUNCHER_DISCLAIMED");
  return run(argv[1], argv + 1, 0);
}
EOF
cc -O2 -Wall -o "$tmp/bb-box-launcher" "$tmp/launcher.c" || die "could not build the launcher"
sudo rm -rf "$app"
sudo mkdir -p "$app/Contents/MacOS"
sudo cp "$tmp/bb-box-launcher" "$exe"
sudo tee "$app/Contents/Info.plist" >/dev/null <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>$id</string>
<key>CFBundleName</key><string>bb-box Launcher</string>
<key>CFBundleExecutable</key><string>bb-box-launcher</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleShortVersionString</key><string>1</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
<key>NSMicrophoneUsageDescription</key><string>A command bb-box runs in the desktop session records audio.</string>
<key>NSCameraUsageDescription</key><string>A command bb-box runs in the desktop session uses the camera.</string>
<key>NSAudioCaptureUsageDescription</key><string>A command bb-box runs in the desktop session records the system's audio.</string>
</dict></plist>
EOF
sudo codesign --force -s - "$app" 2>/dev/null || die "could not sign the launcher"

# Its code requirement, which each row holds: an ad-hoc signature's is its cdhash.
codesign -d -r- "$app" 2>&1 | sed -n 's/^#* *designated => //p' | csreq -r- -b "$tmp/csreq" || die "csreq could not compile the launcher's requirement"
csreq=$(xxd -p "$tmp/csreq" | tr -d '\n')
now=$(date +%s)
cols='service, client, client_type, auth_value, auth_reason, auth_version, csreq, policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, last_modified, pid, pid_version, boot_uuid, last_reminded'

# The system's database: what sshd-keygen-wrapper is allowed, as Accessibility,
# Screen Recording and Apple Events, so desktop commands keep it.
system="/Library/Application Support/com.apple.TCC/TCC.db"
sudo sqlite3 "$system" "INSERT OR REPLACE INTO access ($cols) SELECT service, '$id', 0, auth_value, 4, auth_version, X'$csreq', policy_id, indirect_object_identifier_type, indirect_object_identifier, indirect_object_code_identity, flags, $now, NULL, NULL, 'UNUSED', 0 FROM access WHERE client = '/usr/libexec/sshd-keygen-wrapper' AND auth_value = 2;" ||
  die "could not write the system's TCC database"

# The user's, whose tccd answers for the microphone, the camera and the
# system's audio. From macOS 27 it is in a protected container of the
# user's, not in ~/Library, where rows are ignored.
db=$(sudo find /private/var/containers/Data/ProtectedSystem -maxdepth 7 -path '*/Data/Library/Application Support/com.apple.TCC/TCC.db' -user "$user" 2>/dev/null | head -n 2)
[ "$(printf '%s\n' "$db" | grep -c .)" -le 1 ] || die "found more than one TCC database of $user's: $db"
[ -n "$db" ] || db="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
sudo test -f "$db" || die "found no TCC database of $user's"
for service in kTCCServiceMicrophone kTCCServiceCamera kTCCServiceAudioCapture; do
  sudo sqlite3 "$db" "INSERT OR REPLACE INTO access ($cols) VALUES ('$service', '$id', 0, 2, 4, 1, X'$csreq', NULL, 0, 'UNUSED', NULL, 0, $now, NULL, NULL, 'UNUSED', 0);" ||
    die "could not write $service to $db"
done
# Both tccds read their databases again; the check below says whether they did.
sudo launchctl kickstart -k system/com.apple.tccd 2>/dev/null || :
launchctl kickstart -k "gui/$(id -u)/com.apple.tccd" 2>/dev/null || :
echo "launcher: $id has $(sudo sqlite3 "$system" "select count(*) from access where client = '$id'") rows in the system's TCC database and 3 in $user's"

# The check: the microphone, asked for as a desktop command asks, within 10 s.
cat >"$tmp/mic.swift" <<'EOF'
import AVFoundation
AVCaptureDevice.requestAccess(for: .audio) { print("granted:", $0); exit(0) }
dispatchMain()
EOF
swiftc -o "$tmp/mic" "$tmp/mic.swift" 2>/dev/null || die "could not build the microphone check"
sudo -n /bin/launchctl asuser "$(id -u)" /usr/bin/sudo -n -u "$user" -- "$exe" "$tmp/mic" >"$tmp/mic.out" 2>&1 &
check=$!
i=0
while kill -0 "$check" 2>/dev/null && [ "$i" -lt 100 ]; do sleep 0.1; i=$((i + 1)); done
kill "$check" 2>/dev/null || :
grep -qx 'granted: true' "$tmp/mic.out" || die "a desktop command through the launcher was not given the microphone: $(cat "$tmp/mic.out")"
echo "launcher: a desktop command through it has the microphone, with no prompt"
