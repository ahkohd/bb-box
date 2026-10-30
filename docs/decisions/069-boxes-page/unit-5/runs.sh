#!/bin/sh
cd "$HOME/live" || exit 1
. ./env.sh
export LIVE_BOXES="{\"A\":\"$A\",\"D\":\"$D\"}"
status=0
for run in 1 2; do
  LIVE_ONLY=g8,live,numbers,keyboard,terminal-keys node live-check.mjs "run-$run" > "$HOME/live-results/run-$run.log" 2>&1 || status=1
  echo "run $run: $(grep -c '^- PASS' "$HOME/live-results/run-$run.log") passed, $(grep -c '^- FAIL' "$HOME/live-results/run-$run.log") failed"
done
LIVE_SHOTS=1 LIVE_ONLY=shots node live-check.mjs shots > "$HOME/live-results/shots.log" 2>&1 || status=1
exit $status
