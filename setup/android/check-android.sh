#!/bin/bash
set -u

usage() {
  cat >&2 <<'USAGE'
usage: bb-box-check-android [--no-base]

Checks an Android image as the box user, one line a check, ok or FAIL: the
Linux VM's own checks (bb-box-check-headless) unless --no-base, then KVM, the
device's firewall and that the emulator does not start without it, that this
box's adb key is its own, and for each device in the image's record: it
boots from its snapshot, its screens' pixels are the model table's, the
image's defaults hold, its gRPC refuses no token and a wrong one, and its
ports are closed to another interface over IPv4 and IPv6.
USAGE
  exit 2
}

base=yes
case "${1:-}" in
  "") ;;
  --no-base) base=no ;;
  *) usage ;;
esac
t() { printf '%-34s ' "$1"; shift; out=$("$@" 2>&1) && echo "ok   ${out:0:200}" || echo "FAIL ${out:0:300}"; }
[ "$base" = no ] || bb-box-check-headless

sdk=${ANDROID_HOME:-/opt/android-sdk}
export ANDROID_HOME=$sdk PATH=$sdk/platform-tools:$sdk/emulator:$PATH
record=/usr/share/bb-box/image.json
serial=emulator-5554
shell() { adb -s "$serial" shell "$@" </dev/null | tr -d '\r'; }

kvm() { python3 -c 'import fcntl, os; fcntl.ioctl(os.open("/dev/kvm", os.O_RDWR), 0xAE01, 0)' && echo "/dev/kvm opens as $(id -un)"; }

firewall() {
  systemctl is-active --quiet bb-box-device-firewall.service || { echo "bb-box-device-firewall.service is not active"; return 1; }
  bb-box-device-firewall check && echo "table inet bb_box_device at priority -300, from boot"
}

fails_closed() {
  local avd started
  avd=$(jq -r '.devices[0].native' "$record")
  sudo -n nft delete table inet bb_box_device || return 1
  started=0
  bb-box-emulator start "$avd" --no-save --timeout 30 >/dev/null 2>&1 && started=1
  [ "$started" = 0 ] || bb-box-emulator stop
  sudo -n systemctl restart bb-box-device-firewall.service || return 1
  bb-box-device-firewall check || return 1
  [ "$started" = 0 ] && echo "refused while the table was gone; the table is back"
}

own_identity() {
  local built
  built=$(date -d "$(jq -r .built "$record")" +%s) || return 1
  for file in "$HOME/.android/adbkey" "$HOME/.emulator_console_auth_token"; do
    [ ! -e "$file" ] || [ "$(stat -c %Y "$file")" -gt "$built" ] || { echo "$file is older than the image's build: it came with the image"; return 1; }
  done
  echo "no adb key or console token came with the image"
}

pixels() {
  local screens=$1 size
  size=$(shell wm size | sed -n 's/^Physical size: //p')
  case " $screens " in *" $size "*) echo "$size" ;; *) echo "the screen is $size, not one of $screens"; return 1 ;; esac
}

fold_pixels() {
  local outer=$1 inner=$2 closed opened
  adb -s "$serial" emu fold >/dev/null && sleep 2
  closed=$(shell wm size | sed -n 's/^Physical size: //p')
  adb -s "$serial" emu unfold >/dev/null && sleep 2
  opened=$(shell wm size | sed -n 's/^Physical size: //p')
  [ "$closed" = "$outer" ] && [ "$opened" = "$inner" ] || { echo "closed $closed and open $opened, not $outer and $inner"; return 1; }
  echo "closed $closed, open $opened"
}

defaults() {
  local avd=$1 got failed=
  for expect in "secure stylus_handwriting_enabled 0" "secure spell_checker_enabled 0" "system accelerometer_rotation 1" "system screen_off_timeout 2147483647"; do
    read -r scope key value <<<"$expect"
    got=$(shell settings get "$scope" "$key")
    [ "$got" = "$value" ] || failed="$failed $key=$got"
  done
  shell dumpsys power | grep -q 'mStayOn=true' || failed="$failed stayon=false"
  grep -Eqx 'hw\.keyboard *= *yes' "$HOME/.android/avd/$avd.avd/config.ini" || failed="$failed hw.keyboard"
  [ -z "$failed" ] || { echo "not as the image sets them:$failed"; return 1; }
  echo "hw.keyboard, stylus handwriting off, spell checker off, auto-rotate on, awake"
}

tokens() {
  local none wrong right
  none=$(bb-box-emulator grpc getStatus --no-token)
  wrong=$(bb-box-emulator grpc getStatus --token "not-$RANDOM-the-token")
  right=$(bb-box-emulator grpc getStatus)
  [ "$none" = 16 ] && [ "$wrong" = 16 ] && [ "$right" = 0 ] || { echo "gRPC status with no token $none, a wrong one $wrong, this start's $right"; return 1; }
  echo "no token and a wrong one: UNAUTHENTICATED; this start's: OK"
}

ports_closed() {
  local ns=bb-box-check-$$ host=veth-bbc$$ peer=veth-bbn$$ result=
  sudo -n ip netns add "$ns" || return 1
  sudo -n ip link add "$host" type veth peer name "$peer" &&
    sudo -n ip link set "$peer" netns "$ns" &&
    sudo -n ip addr add 192.0.2.1/30 dev "$host" &&
    sudo -n ip addr add fd00:bb0::1/64 dev "$host" nodad &&
    sudo -n ip link set "$host" up &&
    sudo -n ip netns exec "$ns" ip addr add 192.0.2.2/30 dev "$peer" &&
    sudo -n ip netns exec "$ns" ip addr add fd00:bb0::2/64 dev "$peer" nodad &&
    sudo -n ip netns exec "$ns" ip link set "$peer" up &&
    sudo -n ip netns exec "$ns" ip link set lo up || result=FAIL
  if [ -z "$result" ]; then
    for address in 192.0.2.1 fd00:bb0::1; do
      for port in 8554 5554 5555 5037; do
        if sudo -n ip netns exec "$ns" timeout 2 bash -c "exec 3<>/dev/tcp/$address/$port" 2>/dev/null; then result="$result $address:$port open"; fi
      done
    done
    sudo -n ip netns exec "$ns" timeout 2 bash -c 'exec 3<>/dev/tcp/192.0.2.1/22' 2>/dev/null || result="$result the-path-itself-fails"
  fi
  sudo -n ip link del "$host" 2>/dev/null
  sudo -n ip netns del "$ns" 2>/dev/null
  [ -z "$result" ] || { echo "from another interface:$result"; return 1; }
  echo "8554, 5554, 5555 and 5037 closed from another interface over IPv4 and IPv6; SSH open"
}

t "KVM" kvm
t "device firewall" firewall
t "no emulator without the firewall" fails_closed
t "this box's own adb identity" own_identity
count=$(jq '.devices | length' "$record" 2>/dev/null || echo 0)
[ "$count" -gt 0 ] || echo "devices in the record             FAIL the image's record lists no devices"
for i in $(seq 0 $((count - 1))); do
  model=$(jq -r ".devices[$i].model" "$record")
  avd=$(jq -r ".devices[$i].native" "$record")
  screens=$(jq -r --arg avd "$avd" '.devices[] | select(.avd == $avd) | .screens | map("\(.[0])x\(.[1])") | join(" ")' /usr/share/bb-box/android-pins.json)
  booted=$(bb-box-emulator start "$avd" --no-save 2>&1)
  case "$booted" in
    *snapshot=loaded*) echo "$(printf '%-34s ' "$model boots from its snapshot")ok   $booted" ;;
    *) echo "$(printf '%-34s ' "$model boots from its snapshot")FAIL ${booted:0:300}"; bb-box-emulator stop >/dev/null 2>&1; continue ;;
  esac
  if [ "$(wc -w <<<"$screens")" = 2 ]; then t "$model screens" fold_pixels $screens; else t "$model screen" pixels "$screens"; fi
  t "$model defaults" defaults "$avd"
  t "$model gRPC token" tokens
  t "$model ports" ports_closed
  bb-box-emulator stop >/dev/null 2>&1
done
