#!/bin/sh
# Installs Google Chrome on a Mac, as root: from setup-mac.sh on a pool Mac,
# and in Tart's macOS image, which prepare-image.sh builds and refreshes.
#
#   sudo sh mac-chrome.sh [<home>]...
#
# Chrome comes from Google's stable download, which names no version, so its
# signature is the check, as the Linux images check Chrome's package against
# Google's signed index: the app must verify, Gatekeeper must accept it as
# notarised, and it must be signed by Google's team, EQHXZ8M8AV. (codesign's
# --strict refuses Google's own app, for a helper's extended attributes.)
# A Chrome already there that is as new is kept, as Chrome updates itself.
#
# Without device management, macOS empties /Library/Managed Preferences at
# boot, so Chrome's machine policies go in /Library/Preferences, where Chrome
# applies them as recommended: no default-browser, promotion or sign-in
# prompts, and no sync, as on Linux. (MetricsReportingEnabled is ignored
# there: Chrome takes it only from device management. Metrics stay off as the
# first-run dialog that asks for them never shows.) No policy stops the
# first-run dialog or the What's New tab, so each <home> given, such as a box
# user's or the template box users' homes are made from, gets Chrome's
# First Run marker and a Local State that has seen every What's New.
#
# It also installs chrome-policies.mjs, which lists the policies Chrome
# applies, as chrome://policy shows them, for an image's check. Prints
# chrome=<version>.
set -eu
# Empty on a Mac. The tests set it to a directory laid out as a Mac's.
ROOT=${ROOT:-}
URL=https://dl.google.com/chrome/mac/universal/stable/GGRO/googlechrome.dmg
TEAM=EQHXZ8M8AV
APP="$ROOT/Applications/Google Chrome.app"
POLICIES="$ROOT/Library/Preferences/com.google.Chrome"
READER="$ROOT/usr/local/libexec/bb-box/chrome-policies.mjs"

die() { echo "mac-chrome.sh: $*" >&2; exit 1; }
version() { plutil -extract CFBundleShortVersionString raw "$1/Contents/Info.plist" 2>/dev/null || :; }
# Whether version $1 is at least $2, field by field.
at_least() { awk -v a="$1" -v b="$2" 'BEGIN { n = split(a, x, "."); m = split(b, y, "."); for (i = 1; i <= (n > m ? n : m); i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 } exit 0 }'; }

for home in "$@"; do [ -d "$home" ] || die "no home $home"; done

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

# The machine policies, and none where macOS empties them at boot, as an earlier version put them.
rm -f "$ROOT/Library/Managed Preferences/com.google.Chrome.plist"
defaults write "$POLICIES" DefaultBrowserSettingEnabled -bool false
defaults write "$POLICIES" PromotionsEnabled -bool false
defaults write "$POLICIES" BrowserSignin -int 0
defaults write "$POLICIES" SyncDisabled -bool true
chmod 0644 "$POLICIES.plist" 2>/dev/null || :

# The First Run marker and a Local State whose What's New is past any version, kept where Chrome has run.
for home in "$@"; do
  data="$home/Library/Application Support/Google/Chrome"
  mkdir -p "$data"
  [ -e "$data/First Run" ] || : >"$data/First Run"
  [ -e "$data/Local State" ] || printf '%s\n' '{"browser":{"last_whats_new_version":9999}}' >"$data/Local State"
  chown -R "$(stat -f %u "$home"):$(stat -f %g "$home")" "$home/Library/Application Support/Google"
done

# The reader of what Chrome applies: a headless Chrome of its own, through DevTools, prints each policy set,
# with its value, scope, level and status, as chrome://policy lists them.
mkdir -p "$(dirname "$READER")"
cat >"$READER" <<'JS'
// Lists the policies Google Chrome applies, as chrome://policy shows them: name, value, scope, level and status.
// From bb-box's mac-chrome.sh. Run as the user whose Chrome it is: node chrome-policies.mjs
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "chrome-policies-"));
const port = 9300 + Math.floor(Math.random() * 600);
const chrome = spawn("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", ["--headless=new", `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--no-first-run", "about:blank"], { stdio: "ignore" });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
try {
  let target = null;
  for (let i = 0; i < 80 && !target; i++) {
    await sleep(250);
    target = await fetch(`http://127.0.0.1:${port}/json/new?chrome://policy`, { method: "PUT" }).then((answer) => answer.json(), () => null);
  }
  if (!target) throw new Error("Chrome's DevTools did not answer");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  await sleep(3000);
  const rows = await new Promise((resolve) => {
    socket.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id === 1) resolve(message.result?.result?.value ?? []); };
    const expression = `(() => { const rows = []; const walk = (root) => { for (const row of root.querySelectorAll("policy-row, .policy-row")) rows.push((row.shadowRoot || row).textContent.replace(/\\s+/g, " ").trim()); for (const el of root.querySelectorAll("*")) if (el.shadowRoot) walk(el.shadowRoot); }; walk(document); return rows; })()`;
    socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression, returnByValue: true } }));
  });
  const seen = new Set();
  for (const row of rows) {
    const [name, ...rest] = row.split(" ");
    if (seen.has(name) || rest.join(" ").startsWith("Not set")) continue;
    seen.add(name);
    console.log(`${name} ${rest.join(" ").replace(/ Value .*$/, "")}`);
  }
  socket.close();
} finally {
  chrome.kill();
  await sleep(500);
  rmSync(dir, { recursive: true, force: true });
}
JS
chmod 0644 "$READER"
echo "chrome=$(version "$APP")"
