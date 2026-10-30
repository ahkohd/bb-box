#!/bin/sh
profile="${DEMO_CHROME_PROFILE:-/tmp/demo-chrome}"
rm -rf "$profile"
exec google-chrome --headless=new --remote-debugging-port=9222 --window-size=1280,887 --force-device-scale-factor=2 --user-data-dir="$profile" --hide-scrollbars --mute-audio --no-first-run --no-default-browser-check about:blank
