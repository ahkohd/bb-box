#!/bin/bash
# bb-box: pre-installs BB's host daemon package for the box user, where BB's
# installer looks for it. The installer then gets 304 for the same build and
# skips its download and npm install. A newer server build just downloads as
# usual. Run as root by customize-base.sh when the build has BB's server URL,
# and by setup/docker/Dockerfile in a layer of its own (#95).
#
# usage: install-bb-app.sh <user> <bb-url> <artifacts-dir>
# <artifacts-dir> holds bb-app.tgz and bb-app.headers, as fetch-artifacts.sh
# writes them.
set -Eeuo pipefail
user=$1 bb_url=$2 art=$3
die() { echo "install-bb-app: $*" >&2; exit 1; }

# The directory name BB's installer derives from the server URL (its
# `server_host`): the URL's host, port included, with anything outside
# [A-Za-z0-9.-] replaced by "-".
bb_host=$(/usr/local/bin/node -e \
  'process.stdout.write(new URL(process.argv[1]).host.replace(/[^a-zA-Z0-9.-]/gu, "-"))' "$bb_url")
[ -n "$bb_host" ] || die "cannot parse BB_URL $bb_url"
data_dir=/home/$user/.bb-machines/$bb_host
digest=$(sed -n 's/^x-bb-artifact-sha256: *\([a-f0-9]\{64\}\).*/\1/Ip' "$art/bb-app.headers" | tr -d '\r' | tail -1)
[[ "$digest" =~ ^[a-f0-9]{64}$ ]] || die "no bb-app digest"
echo "$digest  $art/bb-app.tgz" | sha256sum -c --quiet - || die "bb-app.tgz does not match its digest"
install -d -m 0755 -o "$user" -g "$user" "/home/$user/.bb-machines" "$data_dir"
install -m 0644 -o "$user" -g "$user" "$art/bb-app.tgz" "/home/$user/bb-app.tgz"
runuser -u "$user" -- env HOME="/home/$user" PATH=/usr/local/bin:/usr/bin:/bin sh -c "
  cd \"\$HOME\" &&
  npm install -g --no-fund --no-audit --allow-scripts=better-sqlite3,node-pty,@parcel/watcher \
    --prefix '$data_dir/npm' \"\$HOME/bb-app.tgz\" &&
  node -e 'require(process.argv[1] + \"/node_modules/node-pty\"); require(process.argv[1] + \"/node_modules/@parcel/watcher\")' \
    '$data_dir/npm/lib/node_modules/bb-app' &&
  (umask 077 && printf '%s\n' '$digest' >'$data_dir/host-artifact.sha256')
"
rm -f "/home/$user/bb-app.tgz"
for f in bin/bb-app bin/bb lib/node_modules/bb-app/host-daemon/dist/daemon-bundle.mjs; do
  [ -e "$data_dir/npm/$f" ] || die "bb-app is missing $f"
done
# An image's record (049) says which build of BB's app it has. A Docker
# image's has one already, as its app comes in a layer after it.
record=/usr/share/bb-box/image.json
if [ -f "$record" ]; then
  jq -c --arg app "$digest" '.bbApp = $app' "$record" >"$record.new"
  chmod 0644 "$record.new"
  mv "$record.new" "$record"
fi
