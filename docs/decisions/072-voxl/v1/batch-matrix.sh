#!/bin/sh
set -u
cd "$HOME/live"
. "$HOME/live-results/env.sh"
runs=${RUNS:-3}
seconds=${SECONDS_PER_RUN:-20}
for link in ${LINKS:-lan slow}; do
  proxy=http://127.0.0.1:7000
  [ "$link" = slow ] && proxy=http://127.0.0.1:7001
  for workload in ${WORKLOADS:-scroll animation}; do
    for run in $(seq 1 "$runs"); do
      for stream in ${STREAMS:-voxl selkies rfb}; do
        LINK=$link PROXY=$proxy VIEWER="m${stream}${workload}${link}${run}x" timeout 180 node measure.mjs "$stream" "$workload" "$seconds" "$stream-$workload-$link-$run"
      done
    done
  done
done
for stream in ${STREAMS:-voxl selkies rfb}; do
  LINK=lan PROXY=http://127.0.0.1:7000 VIEWER="m${stream}idlex" timeout 180 node measure.mjs "$stream" idle 15 "$stream-idle-lan-1"
done
echo matrix-done
