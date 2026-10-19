#!/bin/bash
# Runs coreutils.sh and sudo.sh in Ubuntu 24.04 and 26.04 containers and prints where they differ: 26.04 has uutils for
# coreutils and sudo-rs for sudo (060). Checked 19 October 2026 with GNU coreutils 9.4 and uutils 0.10.0, sudo 1.9.15p5 and
# sudo-rs 0.2.13. They differed only where test/coreutils.test.ts keeps bb-box from relying on either:
# - timeout -s KILL: a command it kills exits 124 on uutils, 137 on GNU
# - sudo -E: sudo-rs ignores it, with a warning, and keeps none of the caller's environment
# and in stty's wording of an error.
# usage: bash scripts/coreutils/compare.sh   (needs Docker)
set -u
here=$(cd "$(dirname "$0")" && pwd)
for v in 24.04 26.04; do docker pull -q "ubuntu:$v" >/dev/null; done
for probe in coreutils sudo; do
  for v in 24.04 26.04; do
    docker run --rm -v "$here/$probe.sh:/probe.sh:ro" "ubuntu:$v" bash /probe.sh >"/tmp/bb-box-$probe-$v.txt" 2>&1
  done
  echo "== $probe: 24.04 <, 26.04 >"
  diff <(grep -vE '^(ls|sudo): ' "/tmp/bb-box-$probe-24.04.txt" | sed -E 's/ on [0-9a-f]{12}:/:/') \
    <(grep -vE '^(ls|sudo): ' "/tmp/bb-box-$probe-26.04.txt" | sed -E 's/ on [0-9a-f]{12}:/:/')
done
