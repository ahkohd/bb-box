#!/bin/sh
cd "$HOME/live" || exit 1
. ./env.sh
status=0
for run in 1 2 3; do
  node live-check.mjs "run-$run" > "$HOME/live-results/run-$run.log" 2>&1 || status=1
  grep -E "checks passed" "$HOME/live-results/run-$run.log"
done
exit $status
