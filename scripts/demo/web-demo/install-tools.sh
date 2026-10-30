#!/bin/sh
set -e
tools="${1:-$HOME/.web-demo}"
mkdir -p "$tools"
cd "$tools"
[ -f package.json ] || echo '{ "private": true }' > package.json
npm i playwright@1 --no-audit --no-fund > "$tools/npm.log" 2>&1
sudo npx playwright install-deps chromium > "$tools/deps.log" 2>&1
command -v google-chrome > /dev/null || sudo npx playwright install chrome > "$tools/chrome.log" 2>&1
sudo apt-get install -y -qq ffmpeg webp tesseract-ocr wamerican > "$tools/apt.log" 2>&1
echo "tools in $tools: playwright $(node -p "require('$tools/node_modules/playwright/package.json').version"), $(google-chrome --version), $(ffmpeg -version | head -1 | cut -d' ' -f1-3), $(tesseract --version 2>&1 | head -1)"
