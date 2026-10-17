#!/bin/bash
# Linux: every 0.5 s, epoch, busy and total CPU ticks of the whole box. usage: cpu.sh <seconds> > cpu.log
end=$(( $(date +%s) + $1 ))
while [ "$(date +%s)" -lt $end ]; do echo "$(date +%s.%N) $(awk '/^cpu /{print $2+$3+$4+$7+$8, $2+$3+$4+$5+$6+$7+$8}' /proc/stat) $(nproc)"; sleep 0.5; done
