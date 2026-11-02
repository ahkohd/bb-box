#!/bin/bash
set -uo pipefail
exec </dev/null
version=0.7.7
case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) file=microsandbox-darwin-aarch64.tar.gz sha=eed5faa16217ad375ad9a4eb5e819656baeab8ccde0d3ab7e79c4af49319d403 ;;
  Linux-x86_64) file=microsandbox-linux-x86_64.tar.gz sha=b3cc4a5e3f52dfdd938a6f67ac4a9a959ddfe304bab56de4964044b8613f01bb ;;
  Linux-aarch64) file=microsandbox-linux-aarch64.tar.gz sha=8997b1ea76de58689fb6d0fa7b32af6fbe8cbc24612da40b168a5b433c7d8318 ;;
  *) echo "msb $version has no release for $(uname -s)-$(uname -m)"; exit 2 ;;
esac
parent=${1:-/tmp}
[ -d "$parent" ] || { echo "no folder $parent"; exit 2; }
free_gib=$(($(df -k "$parent" | tail -1 | awk '{print $4}') / 1048576))
[ "$free_gib" -ge 10 ] || { echo "$free_gib GiB free where the probe would work; it wants 10"; exit 2; }
work=$(mktemp -d "$parent/msbp.XXXXXX") || exit 2
home=$work/h link=
mkdir -p "$home"
if [ ${#home} -gt 57 ]; then link=$(mktemp -u /tmp/msbp.XXXXXX) && ln -s "$home" "$link" && home=$link; fi
export MSB_HOME=$home
passed=0 failed=0
pass() { passed=$((passed + 1)); echo "PASS $*"; }
skip() { echo "SKIP $*"; }
fail() { failed=$((failed + 1)); echo "FAIL $*"; }
now() { perl -MTime::HiRes=time -e 'printf "%.2f\n", time' 2>/dev/null || date +%s; }
t() { local s; s=$(now); "$@"; local rc=$?; echo "TIME $(awk -v a="$s" -v b="$(now)" 'BEGIN{printf "%.2f", b-a}') s rc=$rc :: $*"; return $rc; }
field() { tr ',{}' '\n\n\n' | sed -n "s/^[[:space:]]*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",]*\)\"\{0,1\}[[:space:]]*\$/\1/p"; }
listed() { grep -E '"(name|snapshot_id|parent_digest|format|scope)"' | sed 's/^ *//' | paste -d' ' - - - - -; }
ours() { if command -v lsof >/dev/null; then lsof -t +D "$work" 2>/dev/null | sort -u | wc -l | tr -d ' '; else echo unknown; fi; }
msb() { if [ "$1" = exec ]; then shift; "$work/v/msb" exec --no-tty "$@"; else "$work/v/msb" "$@"; fi; }
names="e-src e-r e-f own own-m own-d own-f chain chain-r head head-r head-s a-src a-r b-r c-src c-r"
empty_home() {
  export MSB_HOME=$1
  local last= why
  for s in $names; do msb rm -f "$s" --quiet >/dev/null 2>&1; done
  for round in 1 2 3; do for id in $(msb snap ls --format json 2>/dev/null | field snapshot_id); do why=$(msb snapshot remove --force "$id" 2>&1) || last=$why; done; done
  echo "$2: snapshots left after removal by ID: $(msb snap ls --format json 2>/dev/null | field snapshot_id | wc -l | tr -d ' ')${last:+; the last refusal: $(printf '%s' "$last" | sed 's/snap_[0-9a-f]*/<ID>/g; s/[A-Za-z0-9_.-]*:<ID>/<group>:<ID>/g' | tail -n 1)}"
  for round in 1 2 3; do for one in $(msb snap ls --format json 2>/dev/null | tr ',{}' '\n\n\n' | sed -n -E 's/^[[:space:]]*"(group|name)"[[:space:]]*:[[:space:]]*"([^"]*)".*/\2/p' | paste -d: - -); do msb snap rm --force "$one" --quiet >/dev/null 2>&1; done; done
  echo "$2: left: sandboxes $(msb ls --format json 2>/dev/null | field name | wc -l | tr -d ' '), snapshots $(msb snap ls --format json 2>/dev/null | field snapshot_id | wc -l | tr -d ' ')"
}
cleanup() {
  trap - EXIT
  if [ -x "$work/v/msb" ]; then
    [ -z "${link_e:-}" ] || [ ! -L "$link_e" ] || empty_home "$link_e" "the linked home of E"
    [ -z "${real_e:-}" ] || [ ! -d "$real_e" ] || empty_home "$real_e" "the real home of E"
    empty_home "$home" "the main home"
    echo "processes with files in the probe's folder: $(ours)"
  fi
  [ -z "${link_e:-}" ] || rm -f "$link_e"
  [ -z "$link" ] || rm -f "$link"
  rm -rf "$work"
  [ ! -e "$work" ] && echo "removed the probe's folder" || echo "could not remove the probe's folder"
  echo "passed $passed, failed $failed"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

echo "== the host"
if [ "$(uname -s)" = Darwin ]; then
  echo "macOS $(sw_vers -productVersion) build $(sw_vers -buildVersion), $(sysctl -n machdep.cpu.brand_string), $(($(sysctl -n hw.memsize) / 1073741824)) GiB"
  dev=$(df "$work" | tail -1 | awk '{print $1}')
  diskutil info "$dev" 2>/dev/null | grep -E 'File System Personality|Solid State|Device Location' | sed 's/^ *//'
else
  echo "$(uname -sr), $(nproc) cores, file system $(df -T "$work" | tail -1 | awk '{print $2}')"
fi
echo "$free_gib GiB free where the probe works"

echo "== its own msb $version, apart from any other"
curl -fsSL --retry 3 -o "$work/$file" "https://github.com/superradcompany/microsandbox/releases/download/v$version/$file" || { echo "download failed"; exit 1; }
got=$(shasum -a 256 "$work/$file" 2>/dev/null | cut -d' ' -f1 || sha256sum "$work/$file" | cut -d' ' -f1)
[ "$got" = "$sha" ] || { echo "SHA-256 $got, not $sha"; exit 1; }
mkdir "$work/v" && tar -xzf "$work/$file" -C "$work/v" && rm -f "$work/$file"
[ "$(uname -s)" = Darwin ] || export LD_LIBRARY_PATH=$work/v
[ "$(msb --version)" = "msb $version" ] || { echo "these checks measure msb $version; this is $(msb --version)"; exit 1; }
echo "msb $version, SHA-256 checked, MSB_HOME of its own"
t msb pull alpine:3.20 >/dev/null || exit 1

fill() { msb exec "$1" -- sh -c "dd if=/dev/urandom of=/root/b bs=1M count=40 2>/dev/null; dd if=/dev/urandom of=/data/d bs=1M count=20 2>/dev/null; sync"; }
held() { msb exec "$1" -- sh -c 'md5sum /root/b /data/d'; }
same() { if diff "$1" "$2" >/dev/null; then pass "$3"; else fail "$3"; diff "$1" "$2"; fi; }
owned() { msb create alpine:3.20 --name "$1" --quiet --cpus 1 --memory 1024M --tmpfs /run --mount-owned /data:kind=disk,size=2G; }

echo "== 1: msb's own disk, with memory, restored beside its stopped source"
counting() {
  local out
  out=$(msb exec "$1" -- sh -c 'a=$(cat /root/count 2>/dev/null || echo none); sleep 3; echo "$a $(cat /root/count 2>/dev/null || echo none)"' 2>&1 | tail -n 1)
  case $out in [0-9n]*\ [0-9n]*) echo "$out" ;; *) echo "unread unread"; echo "msb exec in $1 said: ${out:-nothing}" >&2 ;; esac
}
number() { case $1 in "" | *[!0-9]*) return 1 ;; esac; }
advanced() { number "$1" && number "$2" && [ "$2" -gt "$1" ]; }
still() { [ "$1" = "$2" ] && [ "$1" != unread ]; }
owned own
fill own
msb exec own -- sh -c '{ nohup sh -c "i=0; while :; do i=\$((i + 1)); echo \$i >/root/count; sleep 1; done" </dev/null >/dev/null 2>&1 & }'
sleep 8
read -r a b <<<"$(counting own)"
echo "the counter in the source before the take: $a, then $b"
runs=no; advanced "$a" "$b" && runs=yes
held own >"$work/own.txt"
msb exec own -- sync
at=$(msb exec own -- cat /root/count 2>/dev/null || echo none)
t msb snap create full --sandbox own --full --quiet || fail "1 a snapshot with memory of a sandbox with msb's own disk"
t msb snap create disk --sandbox own --quiet || fail "1 a disk snapshot after it"
msb snap ls --group own --format json | listed
msb stop own --quiet
t msb snap restore own:full --name own-m --quiet || fail "1 the memory snapshot restored as another sandbox while its source is stopped"
held own-m >"$work/own-m.txt" 2>&1
same "$work/own.txt" "$work/own-m.txt" "1 the memory snapshot's root and own disk, byte for byte"
if [ "$runs" = yes ]; then
  read -r a b <<<"$(counting own-m)"
  echo "the counter at the take: $at; after the memory restore: $a, then $b"
  if advanced "$a" "$b" && [ "$a" -ge "$at" ] && [ "$a" -le $((at + 15)) ]; then pass "1 the memory restore resumed the running process from the take"; else fail "1 the memory restore resumed the running process from the take"; fi
else
  skip "1 the memory restore resumed the running process: the counter did not run in the source, so nothing was measured"
fi
t msb snap restore own:full --name own-f --quiet --disk-only || fail "1 the memory snapshot booted from its disk only, as a fork does"
held own-f >"$work/own-f.txt" 2>&1
same "$work/own.txt" "$work/own-f.txt" "1 the memory snapshot's disk alone, root and own disk, byte for byte"
read -r a b <<<"$(counting own-f)"
echo "the counter in the memory snapshot's disk alone: $a, then $b"
still "$a" "$b" && pass "1 the memory snapshot's disk alone holds no process" || fail "1 the memory snapshot's disk alone holds no process"
msb rm -f own-f own --quiet
t msb snap restore own:disk --name own-d --quiet --cpus 2 --memory 2048M || fail "1 the disk snapshot restored at another size after its source went"
held own-d >"$work/own-d.txt" 2>&1
same "$work/own.txt" "$work/own-d.txt" "1 the disk snapshot's root and own disk, byte for byte"
read -r a b <<<"$(counting own-d)"
echo "the counter in the disk snapshot's sandbox: $a, then $b"
still "$a" "$b" && pass "1 the disk snapshot holds no process" || fail "1 the disk snapshot holds no process"
t msb snap rm --force own:full || fail "1 the parent removed with --force while two sandboxes restored from the group run"
msb stop own-m --quiet; msb start own-m --quiet; held own-m >"$work/own-m2.txt" 2>&1
same "$work/own.txt" "$work/own-m2.txt" "1 the sandbox restored from it, the same after a stop and start"

echo "== 2: a chain of three, both parents removed with --force"
owned chain
for i in 0 1 2; do msb exec chain -- sh -c "dd if=/dev/urandom of=/root/b$i bs=1M count=20 2>/dev/null; dd if=/dev/urandom of=/data/d$i bs=1M count=5 2>/dev/null; echo gen$i > /root/gen; sync"; t msb snap create c$i --sandbox chain --quiet; done
msb exec chain -- sh -c 'md5sum /root/b* /data/d*; cat /root/gen' >"$work/before.txt"
msb snap ls --group chain --format json | listed
echo "snapshots folder before the removals: $(du -sk "$work/h" | cut -f1) KiB in all of the probe's msb home"
msb snap rm chain:c0 >/dev/null 2>&1 && fail "2 a parent removed without --force" || pass "2 a parent refused without --force"
t msb snap rm --force chain:c0; t msb snap rm --force chain:c1; msb rm -f chain --quiet
t msb snap restore chain:c2 --name chain-r --quiet || fail "2 the leaf restored after its parents and source went"
msb exec chain-r -- sh -c 'md5sum /root/b* /data/d*; cat /root/gen' >"$work/after.txt" 2>&1
same "$work/before.txt" "$work/after.txt" "2 the leaf holds its own data"

echo "== 3: the head, and a memory snapshot booted from its disk only at another size"
msb create alpine:3.20 --name head --quiet --cpus 1 --memory 1024M --tmpfs /run
msb exec head -- sh -c 'echo x > /root/x; sync'
msb snap create one --sandbox head --quiet; msb snap create two --sandbox head --full --quiet
msb snap rm --force head:two >/dev/null 2>&1 && fail "3 the group's head removed while it has other members" || pass "3 the group's head refused while it has other members"
t msb snap restore head:two --name head-r --quiet --disk-only --cpus 2 --memory 2048M || fail "3 --disk-only at another size"
said=$(msb exec head-r -- cat /root/x 2>&1)
echo "/root/x in the memory snapshot's disk alone, at another size: $said"
if [ "$said" = x ]; then pass "3 --disk-only boots the disk"; else fail "3 --disk-only boots the disk"; msb exec head-r -- sh -c 'ls -la /root; cat /proc/uptime' 2>&1 | head -12; fi
msb snap restore head:two --name head-s --quiet --cpus 2 --memory 2048M >/dev/null 2>&1 && fail "3 a memory restore at another size refused" || pass "3 a memory restore at another size refused"
msb snap head head:one --format json >/dev/null; t msb snap rm head:two && pass "3 the old head removed once another is head" || fail "3 the old head removed once another is head"
echo "what a restored sandbox keeps of its source's settings:"
msb inspect head-r --format json | tr ',' '\n' | grep -E '"(labels|env|hostname|cpus|memory_mib|guest)"' | head -20

echo "== A: a running sandbox restored from a snapshot that is then deleted"
owned a-src
fill a-src; msb snap create s1 --sandbox a-src --quiet; held a-src >"$work/a.txt"
msb snap restore a-src:s1 --name a-r --quiet; msb rm -f a-src --quiet
t msb snap rm a-src:s1
held a-r >"$work/a1.txt" 2>&1; same "$work/a.txt" "$work/a1.txt" "A the same running, after its snapshot and source went"
msb stop a-r --quiet; msb start a-r --quiet; held a-r >"$work/a2.txt" 2>&1; same "$work/a.txt" "$work/a2.txt" "A the same after a stop and start"

echo "== B: a capture of that sandbox names the deleted snapshot as its parent"
msb snap create t0 --sandbox a-r --quiet; msb snap create t1 --sandbox a-r --quiet
msb snap ls --group a-r --format json | listed
t msb snap rm --force a-r:t0; msb rm -f a-r --quiet
t msb snap restore a-r:t1 --name b-r --quiet; held b-r >"$work/b.txt" 2>&1; same "$work/a.txt" "$work/b.txt" "B the same after its parent was removed with --force"

echo "== C: a parent removed with --force while a sandbox restored from it runs"
owned c-src
fill c-src; msb snap create p0 --sandbox c-src --quiet; held c-src >"$work/c.txt"; msb snap create p1 --sandbox c-src --quiet
msb snap restore c-src:p0 --name c-r --quiet
t msb snap rm --force c-src:p0
msb stop c-r --quiet; msb start c-r --quiet; held c-r >"$work/c1.txt" 2>&1; same "$work/c.txt" "$work/c1.txt" "C the same after a restart"

echo "== E: bb-box's own snapshot commands, by group:member, through a linked home and through a real one"
ids() { msb snap ls --format json | field snapshot_id; }
gone() { ! ids | grep -qx "$1"; }
idof() { msb snap ls --group bbbox-e --format json | tr ',{}' '\n\n\n' | grep -E '"(name|snapshot_id)"' | paste -d' ' - - | grep "\"$1\"" | sed -n 's/.*"\(snap_[0-9a-f]*\)".*/\1/p'; }
step() { local what=$1 said rc; shift; said=$("$@" 2>&1); rc=$?; [ $rc = 0 ] || echo "  $what: rc=$rc, said: $(printf '%s' "$said" | sed 's/snap_[0-9a-f]*/<ID>/g' | tail -n 1)"; return $rc; }
main_home=$MSB_HOME
mkdir -p "$work/hl" "$work/hr"
link_e=$(mktemp -u /tmp/msbp.XXXXXX) && ln -s "$work/hl" "$link_e"
real_e=$(cd "$work/hr" && pwd -P)
for how in linked real; do
  if [ $how = linked ]; then export MSB_HOME=$link_e; else export MSB_HOME=$real_e; fi
  echo "-- MSB_HOME $how$([ -L "$MSB_HOME" ] && echo ", a link" || echo ", no link in its path: $( [ "$(cd "$MSB_HOME" && pwd -P)" = "$MSB_HOME" ] && echo yes || echo no)")"
  msb pull alpine:3.20 >/dev/null 2>&1
  msb create alpine:3.20 --name e-src --quiet --cpus 1 --memory 1024M --tmpfs /run
  msb exec e-src -- sh -c 'echo x > /root/x; sync'
  msb snapshot create e0 --sandbox e-src --group bbbox-e --label bbbox.box=e --quiet
  msb snapshot create e1 --sandbox e-src --group bbbox-e --label bbbox.box=e --full --quiet
  e0=$(idof e0) e1=$(idof e1)
  said=$(msb snapshot inspect "$e0" 2>&1) && echo "  inspect by ID: works" || echo "  inspect by ID: $(printf '%s' "$said" | sed 's/snap_[0-9a-f]*/<ID>/g' | tail -n 1)"
  step "inspect bbbox-e:e0" msb snapshot inspect bbbox-e:e0 && pass "E $how: inspect by group:member" || fail "E $how: inspect by group:member"
  step "restore bbbox-e:e0" msb snapshot restore bbbox-e:e0 --name e-r --quiet && [ "$(msb exec e-r -- cat /root/x 2>&1)" = x ] && pass "E $how: a restore by group:member" || fail "E $how: a restore by group:member"
  step "restore bbbox-e:e1 --disk-only" msb snapshot restore bbbox-e:e1 --name e-f --disk-only --quiet && [ "$(msb exec e-f -- cat /root/x 2>&1)" = x ] && pass "E $how: a fork's restore of a memory snapshot's disk by group:member" || fail "E $how: a fork's restore of a memory snapshot's disk by group:member"
  msb snapshot head bbbox-e --format json >/dev/null
  step "remove --force bbbox-e:e0" msb snapshot remove --force --quiet bbbox-e:e0 && gone "$e0" && pass "E $how: a parent removed by group:member with --force" || fail "E $how: a parent removed by group:member with --force"
  msb snapshot create e2 --sandbox e-src --group bbbox-e --label bbbox.box=e --quiet; e2=$(idof e2)
  msb snapshot head bbbox-e:e1 --format json >/dev/null
  step "remove bbbox-e:e2" msb snapshot remove --quiet bbbox-e:e2 && gone "$e2" && pass "E $how: the old head removed by group:member once another is head" || fail "E $how: the old head removed by group:member once another is head"
  msb rm -f e-src e-r e-f --quiet
  step "remove bbbox-e:e1" msb snapshot remove --quiet bbbox-e:e1 && gone "$e1" && [ -z "$(ids)" ] && pass "E $how: the last removed by group:member after its sandboxes went, as a release does, and none left" || fail "E $how: the last removed by group:member after its sandboxes went, as a release does, and none left"
done
export MSB_HOME=$main_home
