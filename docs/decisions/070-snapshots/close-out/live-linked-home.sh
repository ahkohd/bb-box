#!/bin/sh
set -e
long=${LONG_HOME:-/home/box/home-long-enough-for-the-msb-link}
here=$(cd "$(dirname "$0")/.." && pwd)
[ -d "$long/bb-box" ] || { echo "put a checkout of bb-box in $long/bb-box first"; exit 1; }
home=$long/.local/share/bb-box/microsandbox/home
echo "msb's home: ${#home} bytes, so bb-box reaches it through /tmp/bb-box-msb-$(id -u)"
HOME=$long sh "$here/unit-10/live-setup.sh"
HOME=$long bash "$here/unit-10/live-gates.sh"
link=/tmp/bb-box-msb-$(id -u)
[ -L "$link" ] && [ "$(readlink "$link")" = "$home" ] && echo "msb ran through the link $link" || echo "no link at $link"
