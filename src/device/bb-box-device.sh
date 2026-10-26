#!/bin/sh
set -u
dir="$HOME/.bb-box/device"
here=$(cd "$(dirname "$0")" && pwd)
entry="$here/main.ts"
label=app.bb-box.device
unit=bb-box-device.service
plist="$HOME/Library/LaunchAgents/$label.plist"
unit_file="$HOME/.config/systemd/user/$unit"
log="$dir/server.log"
starts="$dir/starts"
gave_up="$dir/gave-up"
host_managed="$dir/host-managed"
limit_burst=10
limit_seconds=60
log_most_bytes=1048576

say() { printf 'bb-box-device: %s\n' "$*" >&2; }

find_node() {
  if [ -s "$dir/node" ]; then
    n=$(cat "$dir/node")
    if [ -x "$n" ]; then printf '%s\n' "$n"; return 0; fi
  fi
  for n in "$(command -v node 2>/dev/null)" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [ -n "$n" ] && [ -x "$n" ]; then printf '%s\n' "$n"; return 0; fi
  done
  return 1
}

node_or_words() {
  if ! node=$(find_node); then
    say "there is no Node.js in this box, which the device server runs on. Install Node.js 22.18 or newer."
    exit 4
  fi
  if ! "$node" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)' 2>/dev/null; then
    say "the device server needs Node.js 22.18 or newer, and $node is $("$node" --version 2>/dev/null)."
    exit 4
  fi
}

manager() {
  if [ -n "${BB_BOX_DEVICE_MANAGER:-}" ]; then echo "$BB_BOX_DEVICE_MANAGER"
  elif [ -e "$host_managed" ]; then echo host
  elif [ "$(uname -s)" = Darwin ]; then echo launchd
  elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then echo systemd
  else echo supervisor; fi
}

launchd_domain() {
  uid=$(id -u)
  if launchctl print "gui/$uid" >/dev/null 2>&1; then echo "gui/$uid"; else echo "user/$uid"; fi
}

trim_log() {
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt "$log_most_bytes" ]; then
    tail -c $((log_most_bytes / 2)) "$log" >"$log.new" && mv "$log.new" "$log"
  fi
}

last_words() {
  [ -f "$log" ] || return 0
  grep -v '^bb-box-device: start ' "$log" | tail -n 3 | uniq | tr '\n' ' ' | sed 's/ *$//'
}

recent_starts() {
  [ -f "$starts" ] || { echo 0; return; }
  awk -v now="$(date +%s)" 'now - $1 < '"$limit_seconds" "$starts" | wc -l | tr -d ' '
}

record_start() {
  { [ -f "$starts" ] && tail -n "$limit_burst" "$starts"; date +%s; } >"$starts.new" 2>/dev/null && mv "$starts.new" "$starts"
  if [ "$(recent_starts)" -gt "$limit_burst" ]; then
    words=$(last_words)
    printf 'The device server stopped %s times in a minute, so it is left stopped. Its last words: %s\n' "$limit_burst" "${words:-none}" >"$gave_up"
    say "$(cat "$gave_up")"
    [ "$(manager)" = host ] || exit 0
    while [ -e "$gave_up" ]; do sleep 1; done
  fi
}

serve() {
  mkdir -p "$dir" && chmod 700 "$dir"
  trim_log
  exec >>"$log" 2>&1
  echo "bb-box-device: start $(date -u +%Y-%m-%dT%H:%M:%SZ) by $(cat "$dir/manager" 2>/dev/null || echo hand)"
  record_start
  node_or_words
  echo $$ >"$dir/server.pid"
  if command -v flock >/dev/null 2>&1; then
    exec 9>>"$dir/lock" || { say "cannot open the lock $dir/lock"; exit 1; }
    flock -n 9 || { say "another device server holds $dir/lock"; exit 75; }
    exec "$node" "$entry" serve
  fi
  exec perl -e 'use Fcntl qw(:flock); $^F = 255; my $lock = shift; open(my $f, ">>", $lock) or die "bb-box-device: cannot open the lock $lock: $!\n"; flock($f, LOCK_EX | LOCK_NB) or do { print STDERR "bb-box-device: another device server holds $lock\n"; exit 75 }; exec @ARGV or die "bb-box-device: cannot run $ARGV[0]: $!\n";' "$dir/lock" "$node" "$entry" serve
}

supervise() {
  if command -v flock >/dev/null 2>&1; then
    exec 8>>"$dir/supervisor.lock" || exit 1
    flock -n 8 || exit 0
  fi
  echo $$ >"$dir/supervisor.pid"
  trap 'kill "$child" 2>/dev/null; exit 0' TERM INT
  while :; do
    [ -e "$gave_up" ] && exit 0
    sh "$0" serve 8>&- &
    child=$!
    wait "$child"
    [ -e "$gave_up" ] && exit 0
    sleep 1
  done
}

write_launch_agent() {
  mkdir -p "$(dirname "$plist")"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$dir/current/src/device/bb-box-device.sh</string><string>serve</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>1</integer>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
PLIST
}

write_systemd_unit() {
  mkdir -p "$(dirname "$unit_file")"
  cat >"$unit_file" <<UNIT
[Unit]
Description=bb-box device server
StartLimitIntervalSec=$limit_seconds
StartLimitBurst=$limit_burst

[Service]
ExecStart=/bin/sh %h/.bb-box/device/current/src/device/bb-box-device.sh serve
Restart=on-failure
RestartSec=1

[Install]
WantedBy=default.target
UNIT
}

end_server_for_host() {
  [ -s "$dir/server.pid" ] && kill "$(cat "$dir/server.pid")" 2>/dev/null
  return 0
}

supervisor_alive() {
  [ -s "$dir/supervisor.pid" ] && kill -0 "$(cat "$dir/supervisor.pid")" 2>/dev/null
}

stop_supervised() {
  [ -s "$dir/supervisor.pid" ] && kill "$(cat "$dir/supervisor.pid")" 2>/dev/null
  [ -s "$dir/server.pid" ] && kill "$(cat "$dir/server.pid")" 2>/dev/null
  rm -f "$dir/supervisor.pid" "$dir/server.pid"
  return 0
}

start_supervisor() {
  if command -v setsid >/dev/null 2>&1; then setsid sh "$0" supervise </dev/null >/dev/null 2>&1 &
  else nohup sh "$0" supervise </dev/null >/dev/null 2>&1 & fi
}

fresh_starts() {
  rm -f "$gave_up" "$starts"
}

install() {
  mkdir -p "$dir" && chmod 700 "$dir"
  if node=$(find_node); then printf '%s\n' "$node" >"$dir/node"; fi
  m=$(manager)
  echo "$m" >"$dir/manager"
  fresh_starts
  case "$m" in
    launchd)
      write_launch_agent
      domain=$(launchd_domain)
      launchctl bootout "$domain/$label" 2>/dev/null
      tries=0
      until launchctl bootstrap "$domain" "$plist" 2>/dev/null; do
        if launchctl print "$domain/$label" >/dev/null 2>&1; then
          launchctl kickstart -k "$domain/$label" 2>/dev/null
          break
        fi
        tries=$((tries + 1))
        [ "$tries" -ge 20 ] && { say "launchd did not load $plist"; exit 1; }
        sleep 0.25
      done
      ;;
    systemd)
      write_systemd_unit
      systemctl --user daemon-reload
      systemctl --user enable "$unit" >/dev/null 2>&1
      systemctl --user reset-failed "$unit" 2>/dev/null
      systemctl --user restart "$unit"
      ;;
    supervisor)
      stop_supervised
      start_supervisor
      ;;
    host) end_server_for_host ;;
  esac
}

start() {
  m=$(cat "$dir/manager" 2>/dev/null || manager)
  case "$m" in
    launchd)
      domain=$(launchd_domain)
      if ! launchctl print "$domain/$label" >/dev/null 2>&1; then launchctl bootstrap "$domain" "$plist" 2>/dev/null
      elif ! launchctl print "$domain/$label" 2>/dev/null | grep -q 'state = running'; then launchctl kickstart "$domain/$label" 2>/dev/null; fi
      ;;
    systemd)
      case "$(systemctl --user is-active "$unit" 2>/dev/null)" in
        active | activating | reloading) ;;
        *) systemctl --user start "$unit" 2>/dev/null ;;
      esac
      ;;
    supervisor) supervisor_alive || start_supervisor ;;
    host) ;;
  esac
  return 0
}

restart() {
  fresh_starts
  m=$(cat "$dir/manager" 2>/dev/null || manager)
  case "$m" in
    launchd) launchctl kickstart -k "$(launchd_domain)/$label" 2>/dev/null || start ;;
    systemd) systemctl --user reset-failed "$unit" 2>/dev/null; systemctl --user restart "$unit" ;;
    supervisor) stop_supervised; start_supervisor ;;
    host) end_server_for_host ;;
  esac
}

stop() {
  m=$(cat "$dir/manager" 2>/dev/null || manager)
  case "$m" in
    launchd) launchctl bootout "$(launchd_domain)/$label" 2>/dev/null ;;
    systemd) systemctl --user stop "$unit" 2>/dev/null ;;
    supervisor) stop_supervised ;;
    host) end_server_for_host ;;
  esac
  return 0
}

status() {
  if [ -s "$gave_up" ]; then
    cat "$gave_up"
    exit 3
  fi
  m=$(cat "$dir/manager" 2>/dev/null || manager)
  if [ "$m" = systemd ] && [ "$(systemctl --user is-active "$unit" 2>/dev/null)" = failed ] && [ "$(recent_starts)" -ge "$limit_burst" ]; then
    printf 'The device server stopped %s times in a minute, so systemd leaves it stopped. Its last words: %s\n' "$limit_burst" "$(last_words)" >"$gave_up"
    cat "$gave_up"
    exit 3
  fi
  exit 0
}

case "${1:-}" in
  serve) serve ;;
  supervise) supervise ;;
  install) install ;;
  start) start ;;
  restart) restart ;;
  stop) stop ;;
  status) status ;;
  connect) node_or_words; exec "$node" "$entry" connect ;;
  version) node_or_words; exec "$node" "$entry" version ;;
  *) say "usage: bb-box-device serve | connect | install | start | restart | stop | status | supervise | version"; exit 2 ;;
esac
