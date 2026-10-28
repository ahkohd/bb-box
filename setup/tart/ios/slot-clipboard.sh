#!/bin/sh
set -u
PATH=/usr/bin:/bin:/usr/sbin:/sbin
export PATH

PASTEBOARD_SERVER_LABEL=app.bb-box.pboard
SESSION_JOB_LABEL=app.bb-box.session-job
JOB_MOST_S=60

[ $# -eq 2 ] || { echo "usage: slot-clipboard.sh <user> <booted device's udid>" >&2; exit 2; }
[ "$(id -u)" = 0 ] || { echo "run it as root" >&2; exit 2; }
user=$1 udid=$2
uid=$(id -u "$user" 2>/dev/null) || { echo "there is no user $user"; exit 1; }

as_user() { (cd / && sudo -n -H -u "$user" -- "$@"); }

if launchctl print "gui/$uid" >/dev/null 2>&1; then
  domain=gui/$uid session=Aqua own_server=no
else
  domain=user/$uid session=Background own_server=yes
fi

dir=$(as_user mktemp -d /tmp/bb-box-clipboard.XXXXXX) || { echo "could not make a folder as $user"; exit 1; }
server_loaded_here=no

finish() {
  [ "$server_loaded_here" = no ] || as_user launchctl bootout "$domain/$PASTEBOARD_SERVER_LABEL" >/dev/null 2>&1
  rm -rf "$dir"
}
trap finish EXIT

plist_head() {
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>' \
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">' \
    '<plist version="1.0">' '<dict>'
}

load_pasteboard_server() {
  as_user launchctl print "$domain/$PASTEBOARD_SERVER_LABEL" >/dev/null 2>&1 && return 0
  {
    plist_head
    printf '  <key>Label</key><string>%s</string>\n' "$PASTEBOARD_SERVER_LABEL"
    printf '  <key>ProgramArguments</key><array><string>/usr/libexec/pboard</string></array>\n'
    printf '  <key>MachServices</key><dict><key>com.apple.pasteboard.1</key><true/><key>com.apple.coreservices.uauseractivitypasteboardclient.xpc</key><true/></dict>\n'
    printf '  <key>LimitLoadToSessionType</key><string>Background</string>\n'
    printf '  <key>EnableTransactions</key><true/>\n  <key>POSIXSpawnType</key><string>Interactive</string>\n'
    printf '%s\n' '</dict>' '</plist>'
  } | as_user tee "$dir/$PASTEBOARD_SERVER_LABEL.plist" >/dev/null
  said=$(as_user launchctl bootstrap "$domain" "$dir/$PASTEBOARD_SERVER_LABEL.plist" 2>&1) || {
    echo "launchd did not load macOS's pasteboard server in $domain: $said"
    return 1
  }
  server_loaded_here=yes
}

session_job() {
  op=$1
  job=$(as_user mktemp -d "$dir/$SESSION_JOB_LABEL.check.XXXXXX") || { echo "could not make a folder for simctl $op as $user"; return 1; }
  label=${job##*/}
  cat | as_user tee "$job/in" >/dev/null
  {
    plist_head
    printf '  <key>Label</key><string>%s</string>\n' "$label"
    printf '  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-c</string><string>"$0" "$@" &lt;in &gt;out 2&gt;err; echo $? &gt;exit.new &amp;&amp; mv exit.new exit</string><string>/usr/bin/xcrun</string><string>simctl</string><string>%s</string><string>%s</string></array>\n' "$op" "$udid"
    printf '  <key>WorkingDirectory</key><string>%s</string>\n' "$job"
    printf '  <key>EnvironmentVariables</key><dict><key>HOME</key><string>%s</string><key>LANG</key><string>en_US.UTF-8</string><key>LC_ALL</key><string>en_US.UTF-8</string></dict>\n' "$(as_user sh -c 'printf %s "$HOME"')"
    printf '  <key>LimitLoadToSessionType</key><string>%s</string>\n' "$session"
    printf '  <key>ProcessType</key><string>Interactive</string>\n  <key>RunAtLoad</key><true/>\n'
    printf '%s\n' '</dict>' '</plist>'
  } | as_user tee "$job/job.plist" >/dev/null
  said=$(as_user launchctl bootstrap "$domain" "$job/job.plist" 2>&1) || { echo "launchd did not start simctl $op in $domain: $said"; return 1; }
  waited=0
  until [ -s "$job/exit" ] || [ "$waited" -ge $((JOB_MOST_S * 10)) ]; do sleep 0.1; waited=$((waited + 1)); done
  as_user launchctl bootout "$domain/$label" >/dev/null 2>&1
  [ -s "$job/exit" ] || { echo "simctl $op did not end within $JOB_MOST_S s in $domain"; return 1; }
  code=$(cat "$job/exit")
  [ "$code" = 0 ] || { echo "simctl $op exited with $code in $domain: $(tail -n 2 "$job/err" | tr '\n' ' ')"; return 1; }
  cat "$job/out"
}

started=$(perl -MTime::HiRes=time -e 'printf "%.3f", time')
[ "$own_server" = no ] || load_pasteboard_server || exit 1
sample=$(printf 'bb-box clipboard check \342\234\223 \303\251 \346\227\245\346\234\254')
printf '%s' "$sample" | session_job pbcopy >/dev/null || { session_job pbcopy </dev/null >/dev/null; exit 1; }
read_back=$(session_job pbpaste </dev/null) || exit 1
printf '' | session_job pbcopy >/dev/null
[ "$read_back" = "$sample" ] || { echo "the device's clipboard read back $(printf '%s' "$read_back" | wc -c | tr -d ' ') bytes that differ from the $(printf '%s' "$sample" | wc -c | tr -d ' ') set"; exit 1; }
seconds=$(perl -MTime::HiRes=time -e "printf '%.1f', time - $started")
if [ "$own_server" = yes ]; then where="its own session, $domain, with macOS's pasteboard server loaded there"; else where="its desktop session, $domain"; fi
echo "$user set and read its device's clipboard, UTF-8 intact, in $where, in $seconds s"
