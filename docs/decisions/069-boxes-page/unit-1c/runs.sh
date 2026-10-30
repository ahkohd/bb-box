#!/bin/sh
cd "$HOME/live" || exit 1
. ./env.sh
acquire() {
  "$HOME/agent-call.sh" "$LIVE_THREAD" box_acquire '{"kind":"linux","memory_gib":2}' | sed -n 's/.*result box_acquire: Box \([a-z-]*\) (.*/\1/p'
}
status=0
for run in 1 2 3; do
  B=${FIRST_B:-$(acquire)}
  FIRST_B=
  F=$(acquire)
  export LIVE_BOXES="{\"A\":\"$A\",\"M\":\"$M\",\"D\":\"$D\",\"B\":\"$B\",\"F\":\"$F\"}"
  echo "run $run: B=$B F=$F"
  node live-check.mjs "run-$run" > "$HOME/live-results/run-$run.log" 2>&1 || status=1
  grep -E "checks passed" "$HOME/live-results/run-$run.log"
done
exit $status
