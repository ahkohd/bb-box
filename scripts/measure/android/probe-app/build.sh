#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
B=/opt/android-sdk/build-tools/35.0.0; J=/opt/android-sdk/platforms/android-35/android.jar
rm -rf out && mkdir -p out/classes out/dex
$B/aapt2 link -o out/base.apk -I $J --manifest AndroidManifest.xml --min-sdk-version 30 --target-sdk-version 35
javac --release 11 -nowarn -cp $J -d out/classes $(find src -name '*.java')
$B/d8 --min-api 30 --lib $J --output out/dex $(find out/classes -name '*.class')
cp out/base.apk out/unsigned.apk && (cd out/dex && zip -q ../unsigned.apk classes.dex)
$B/zipalign -f 4 out/unsigned.apk out/aligned.apk
ks="$(pwd)/probe.keystore"
[ -f "$ks" ] || keytool -genkeypair -keystore "$ks" -storepass probepass -keypass probepass -alias probe -keyalg RSA -dname CN=probe -validity 3650 >/dev/null 2>&1
$B/apksigner sign --ks "$ks" --ks-pass pass:probepass --out out/probe.apk out/aligned.apk
echo built out/probe.apk
