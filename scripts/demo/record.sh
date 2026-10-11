#!/bin/sh
# Record the demo window's page area, without Chrome's tabs and address bar,
# for a fixed number of seconds.
#   sh scripts/demo/record.sh SECONDS OUT.mov
# It returns at once; the recording ends by itself after SECONDS. Do not stop
# it with a signal: screencapture then exits without writing the file.
set -eu
X=${DEMO_X:-0} Y=${DEMO_Y:-40} W=${DEMO_W:-1280} H=${DEMO_H:-800} TB=${DEMO_TOOLBAR:-87}
nohup screencapture -v -C -x -V "$1" -R"$X,$((Y + TB)),$W,$H" "$2" >/dev/null 2>&1 &
echo "$!"
