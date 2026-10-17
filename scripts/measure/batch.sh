#!/bin/bash
# Runs drive.mjs for each kind:label in turn as one viewer, so control taken
# for the first (after ./go) holds for the rest.
# usage: VIEWER=<id> BOX=<id> batch.sh <size> <scale> <kind:label>...
size=$1; scale=$2; shift 2; rm -f go connected; first=1
for run in "$@"; do
  kind=${run%%:*}; label=${run#*:}
  if [ $first = 1 ]; then node drive.mjs "$kind" "$label" "$size" "$scale" > "drive-$label.out" 2>&1; first=0
  else NO_GO=1 node drive.mjs "$kind" "$label" "$size" "$scale" > "drive-$label.out" 2>&1; fi
  tail -c 300 "drive-$label.out"; echo
done
echo batch done
