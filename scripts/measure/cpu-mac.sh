#!/bin/bash
# macOS: the whole machine's CPU each second, from top, as cpu.sh writes it:
# epoch, busy and total centiseconds summed so far, cores.
# usage: cpu-mac.sh <seconds> > cpu.log
cores=$(sysctl -n hw.ncpu); busy=0; total=0
top -l "$1" -s 1 -n 0 | while read -r line; do
  case $line in
    "CPU usage:"*)
      idle=$(echo "$line" | sed -E 's/.* ([0-9.]+)% idle.*/\1/')
      busy=$(echo "$busy + (100 - $idle) * $cores" | bc); total=$((total + 100 * cores))
      echo "$(date +%s) $busy $total $cores" ;;
  esac
done
