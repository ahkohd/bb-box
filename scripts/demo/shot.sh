#!/bin/sh
# Take a PNG of the demo window's page area.
#   sh scripts/demo/shot.sh OUT.png
set -eu
X=${DEMO_X:-0} Y=${DEMO_Y:-40} W=${DEMO_W:-1280} H=${DEMO_H:-800} TB=${DEMO_TOOLBAR:-87}
screencapture -x -R"$X,$((Y + TB)),$W,$H" "$1"
