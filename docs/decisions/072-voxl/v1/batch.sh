#!/bin/sh
set -u
cd "$HOME/live"
. "$HOME/live-results/env.sh"
runs=${RUNS:-3}
seconds=${SECONDS_PER_RUN:-20}
for workload in ${WORKLOADS:-scroll animation idle}; do
  for run in $(seq 1 "$runs"); do
    for stream in voxl selkies; do
      VIEWER="batch${stream}${workload}${run}" timeout 180 node measure.mjs "$stream" "$workload" "$seconds" "$stream-$workload-$run"
    done
  done
done
echo batch-done
