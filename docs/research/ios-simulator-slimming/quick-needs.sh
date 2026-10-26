#!/bin/sh
udid=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
mkdir -p "$out"
pages=$(mktemp -d)
cp "$here/needs-page.html" "$pages/"
(cd "$pages" && exec python3 -m http.server 8765 --bind 127.0.0.1) > "$out/http.log" 2>&1 &
http=$!
idb_companion --udid "$udid" --grpc-port 10882 > "$out/companion.log" 2>&1 &
companion=$!
until nc -z 127.0.0.1 10882 2>/dev/null; do sleep 0.5; done
"$HOME/idbenv/bin/python" -u "$here/needs.py" --udid "$udid" --app "$HOME/slim/dd/Build/Products/Debug-iphonesimulator/SlimProbe.app" --out "$out" --http-log "$out/http.log"
kill "$companion" "$http"
