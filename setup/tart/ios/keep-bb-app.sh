#!/bin/sh
set -eu

die() { echo "keep-bb-app: $*" >&2; exit 1; }
[ $# -eq 2 ] || die "usage: keep-bb-app.sh <the image user's home> <the slots' home>"
from=$1
to=$2
[ -d "$from" ] || die "there is no home $from"
[ -d "$to" ] || die "there is no slots' home $to"

clone() { cp -Rc "$1" "$2" 2>/dev/null || { rm -rf "$2"; cp -R "$1" "$2"; }; }

rm -rf "$to/.bb-machines"
kept=0
for data in "$from"/.bb-machines/*/; do
  data=${data%/}
  [ -d "$data" ] || continue
  digest=$(cat "$data/host-artifact.sha256" 2>/dev/null) || continue
  printf '%s' "$digest" | grep -Eqx '[a-f0-9]{64}' || continue
  [ -d "$data/npm/lib/node_modules/bb-app" ] || continue
  server=$(basename "$data")
  install -d -m 0700 "$to/.bb-machines" "$to/.bb-machines/$server"
  clone "$data/npm" "$to/.bb-machines/$server/npm"
  printf '%s\n' "$digest" >"$to/.bb-machines/$server/host-artifact.sha256"
  chmod 0600 "$to/.bb-machines/$server/host-artifact.sha256"
  echo "kept BB's app for $server, build $digest"
  kept=$((kept + 1))
done
[ "$kept" -gt 0 ] || echo "kept no BB app: $from has none BB's installer wrote, so each slot's enrolment downloads it"
