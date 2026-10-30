#!/bin/sh
port="${WEB_DEMO_CDP_PORT:-9222}"
size="${WEB_DEMO_WINDOW:-1280,800}"
scale="${WEB_DEMO_SCALE:-2}"
profile="${WEB_DEMO_CHROME_PROFILE:-/tmp/web-demo-chrome}"
rm -rf "$profile"
exec google-chrome --headless=new --remote-debugging-port="$port" --window-size="$size" --force-device-scale-factor="$scale" --user-data-dir="$profile" --hide-scrollbars --mute-audio --no-first-run --no-default-browser-check --autoplay-policy=no-user-gesture-required about:blank
