#!/usr/bin/env bash
set -euo pipefail

API="${API:-35}"
IMAGE="${IMAGE:-google_apis}"
ABI="${ABI:-x86_64}"
SDK="${ANDROID_HOME:-$HOME/android-sdk}"
TOOLS_ZIP="commandlinetools-linux-13114758_latest.zip"

sudo apt-get update -qq
sudo apt-get install -y -qq openjdk-17-jre-headless unzip libpulse0 libnss3 libxcomposite1 libxcursor1 libxdamage1 libxi6 libxtst6 libgl1 libegl1 >/dev/null
sudo usermod -aG kvm "$USER"

mkdir -p "$SDK/cmdline-tools"
if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  curl -fsSLo "/tmp/$TOOLS_ZIP" "https://dl.google.com/android/repository/$TOOLS_ZIP"
  unzip -q -o "/tmp/$TOOLS_ZIP" -d "$SDK/cmdline-tools"
  mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

export ANDROID_HOME="$SDK"
export PATH="$SDK/cmdline-tools/latest/bin:$SDK/platform-tools:$SDK/emulator:$PATH"

(yes || true) | sdkmanager --licenses >/dev/null
time sdkmanager --install "platform-tools" "emulator" "system-images;android-$API;$IMAGE;$ABI" >/dev/null

du -sh "$SDK"/{platform-tools,emulator,system-images}
emulator -version | head -1
emulator -accel-check
