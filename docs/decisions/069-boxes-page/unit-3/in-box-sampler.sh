#!/bin/sh
out="$HOME/cpu-samples.log"
while :; do
  if [ -f /sys/fs/cgroup/cpu.stat ] && [ -f /sys/fs/cgroup/cpu.max ]; then
    printf '%s cgroup %s\n' "$(date +%s)" "$(grep '^usage_usec' /sys/fs/cgroup/cpu.stat | cut -d' ' -f2)" >> "$out"
  else
    printf '%s stat %s\n' "$(date +%s)" "$(head -n 1 /proc/stat)" >> "$out"
  fi
  sleep 60
done
