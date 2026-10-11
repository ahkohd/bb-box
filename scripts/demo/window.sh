#!/bin/sh
# Open or close the Chrome window the demo is recorded in.
#   sh scripts/demo/window.sh open URL   prints the new window's ID
#   sh scripts/demo/window.sh close ID
# The window's page area is DEMO_W x DEMO_H points at DEMO_X, DEMO_Y plus
# Chrome's toolbar, DEMO_TOOLBAR points tall. record.sh captures that area.
set -eu
X=${DEMO_X:-0} Y=${DEMO_Y:-40} W=${DEMO_W:-1280} H=${DEMO_H:-800} TB=${DEMO_TOOLBAR:-87}
case "${1:-}" in
open)
  osascript - "$2" "$X" "$Y" "$((X + W))" "$((Y + TB + H))" <<'OSA'
on run argv
  tell application "Google Chrome"
    make new window
    set bounds of front window to {item 2 of argv as integer, item 3 of argv as integer, item 4 of argv as integer, item 5 of argv as integer}
    set URL of active tab of front window to item 1 of argv
    activate
    return id of front window
  end tell
end run
OSA
  ;;
close)
  osascript -e "tell application \"Google Chrome\" to close (every window whose id is $2)" ;;
*) echo "usage: window.sh open URL | close ID" >&2; exit 2 ;;
esac
