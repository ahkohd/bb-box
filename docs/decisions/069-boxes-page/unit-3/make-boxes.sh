#!/bin/sh
set -e
cd "$HOME"
. run/env.sh
on="$1"; enrolled="$2"; routed="$3"; size="${4:-\"size\":\"small\"}"
make() {
  out=$(./agent-call.sh "$RUN_THREAD" box_acquire "{\"kind\":\"linux\",\"on\":\"$on\",$size}")
  echo "$out" | sed -n 's/.*result box_acquire: Box \([a-z-]*\) (\(bx[a-z0-9]*\)).*/\1 \2/p'
  echo "$out" | grep -q "result box_acquire: Box" || { echo "$out" >&2; return 1; }
}
if [ "$enrolled" -gt 0 ]; then
  ./bbc box option set enrol=true > /dev/null
  i=0; while [ $i -lt "$enrolled" ]; do make; i=$((i + 1)); done
fi
if [ "$routed" -gt 0 ]; then
  ./bbc box option set enrol=false > /dev/null
  i=0; while [ $i -lt "$routed" ]; do make || break; i=$((i + 1)); done
  ./bbc box option set enrol=true > /dev/null
fi
