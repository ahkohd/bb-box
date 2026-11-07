#!/bin/sh
thread="$1"; tool="$2"; args="${3:-{\}}"
before=$(wc -c < "$HOME/agent-trace.log")
~/bbc thread tell "$thread" "CALL $tool $args" > /dev/null
i=0
while [ $i -lt 600 ]; do
  out=$(tail -c +$((before + 1)) "$HOME/agent-trace.log" | grep -m1 "result $tool:")
  if [ -n "$out" ]; then echo "$out" | cut -c1-400; exit 0; fi
  sleep 1; i=$((i + 1))
done
echo "timed out"; exit 1
