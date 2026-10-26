#!/bin/bash
set -euo pipefail

usage() {
  cat >&2 <<'USAGE'
usage: accept-sdk-licence.sh [--to <file>] [--yes]

Shows the Android SDK's licence, the terms the Android template's SDK,
emulator and system image come under, and asks whether you accept them. The
terms are read from Google's repository manifest and checked against the
SHA-256 pinned in setup/android/pins.json, so what you read is what the pins
name. Only once you accept does it write <file>, /etc/bb-box/android-sdk-license
unless --to says otherwise, which build.sh android needs. The template keeps
that acceptance, and its refreshes need it; a pin that names other terms
needs this step again.

--yes accepts without asking, for an operator who has read the terms already;
it still shows them.

Needs curl and python3.
USAGE
  exit 2
}

to=/etc/bb-box/android-sdk-license
yes=no
while [ $# -gt 0 ]; do
  case "$1" in
    --to) [ $# -ge 2 ] || usage; to=$2; shift ;;
    --yes) yes=yes ;;
    *) usage ;;
  esac
  shift
done

here=$(cd "$(dirname "$0")" && pwd)
read -r id manifest terms_sha256 accepted < <(python3 -I -c '
import json, sys
licence = json.load(open(sys.argv[1]))["license"]
print(licence["id"], licence["manifest"], licence["termsSha256"], licence["accepted"])
' "$here/pins.json")

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
curl -fsSL --retry 3 -o "$work/manifest.xml" "$manifest"
python3 -I -c '
import sys, xml.etree.ElementTree as ET
for element in ET.parse(sys.argv[1]).getroot().iter():
    if element.tag.rsplit("}", 1)[-1] == "license" and element.get("id") == sys.argv[2]:
        open(sys.argv[3], "w").write(element.text or "")
        break
else:
    sys.exit(f"accept-sdk-licence.sh: Google'\''s manifest has no licence {sys.argv[2]}")
' "$work/manifest.xml" "$id" "$work/terms.txt"
if ! echo "$terms_sha256  $work/terms.txt" | sha256sum -c --status; then
  echo "accept-sdk-licence.sh: the terms of $id in Google's manifest are not the ones setup/android/pins.json pins." >&2
  echo "accept-sdk-licence.sh: a bb-box update has to pin them before an Android template is built." >&2
  exit 1
fi

cat "$work/terms.txt"
echo
echo "These are the terms of $id, which the Android SDK's command-line tools, emulator, platform-tools and system image come under."
if [ "$yes" = no ]; then
  [ -r /dev/tty ] || { echo "accept-sdk-licence.sh: no terminal to ask on; run it in one, or give --yes once you have read the terms" >&2; exit 1; }
  printf 'Do you accept them? Type yes to accept: ' >/dev/tty
  read -r answer </dev/tty
  [ "$answer" = yes ] || { echo "accept-sdk-licence.sh: not accepted; nothing was written" >&2; exit 1; }
fi
install -d -m 0755 "$(dirname "$to")"
printf '\n%s' "$accepted" >"$to.new"
chmod 0644 "$to.new"
mv "$to.new" "$to"
echo "accepted $id; written to $to"
