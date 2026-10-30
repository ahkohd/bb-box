#!/bin/sh
cd "$HOME"
note() { printf '{"at":%s,"event":"%s"}\n' "$(date +%s%3N)" "$1" >> run/events.jsonl; }
at=$(date -u -d "$1" +%s)
sleep $((at - $(date -u +%s)))
./bbc box option set monitor.boxHistory=false > /dev/null && note "history off, five pages open"
(cd live && node pages.mjs 7200) &
sleep 3600
./bbc box option set monitor.boxHistory=true > /dev/null && note "history on, five pages open"
wait
