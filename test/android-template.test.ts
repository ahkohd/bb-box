import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEVICE_MODELS } from "../src/core/device-models.ts";
import { parseOfferedDevices } from "../src/core/device-parse.ts";

const ANDROID = join(import.meta.dirname, "..", "setup", "android");
const read = (name: string) => readFileSync(join(ANDROID, name), "utf8");

interface Pins {
  readonly sdk: readonly { name: string; version: string; url: string; sha1: string; sha256: string; top: string; path: string }[];
  readonly systemImage: { api: number; image: string; abi: string; revision: number; package: string };
  readonly license: { id: string; manifest: string; termsSha256: string; accepted: string };
  readonly avd: { cores: number; ramMiB: number };
  readonly devices: readonly { model: string; avd: string; profile: string; screens: readonly (readonly [number, number])[] }[];
}
const pins = JSON.parse(read("pins.json")) as Pins;

const pixels = (screen: { pixels: { width: number; height: number } }) => [screen.pixels.width, screen.pixels.height];

test("the template's devices are the model table's Android models, with its screens' pixels, which the image's check compares", () => {
  const android = DEVICE_MODELS.filter((model) => model.platform === "android");
  assert.deepEqual(
    pins.devices.map((device) => device.model),
    android.map((model) => model.name),
  );
  for (const model of android) {
    const device = pins.devices.find((one) => one.model === model.name)!;
    const screens = "outer" in model ? [pixels(model.outer), pixels(model.inner)] : [pixels(model.screen)];
    assert.deepEqual(device.screens, screens, model.name);
    assert.match(device.avd, /^[a-z0-9_]+$/);
  }
});

test("each SDK part is pinned from Google's repository by URL, the manifest's SHA-1 and the file's SHA-256, with Google APIs images only", () => {
  assert.deepEqual(
    pins.sdk.map((part) => part.name),
    ["cmdline-tools", "emulator", "platform-tools", "system-image"],
  );
  for (const part of pins.sdk) {
    assert.match(part.url, /^https:\/\/dl\.google\.com\/android\/repository\//, part.name);
    assert.match(part.sha1, /^[0-9a-f]{40}$/, part.name);
    assert.match(part.sha256, /^[0-9a-f]{64}$/, part.name);
  }
  const image = pins.sdk.find((part) => part.name === "system-image")!;
  const { api, image: tag, abi, revision } = pins.systemImage;
  assert.equal(tag, "google_apis", "no Google Play images (063)");
  assert.equal(image.path, `system-images/android-${api}/${tag}/${abi}`);
  assert.equal(image.version, `${api}-${tag}-${abi}-${revision}`);
  assert.equal(pins.systemImage.package, `system-images;android-${api};${tag};${abi}`);
  assert.match(image.url, new RegExp(`/sys-img/${tag}/${abi}-${api}_r${String(revision).padStart(2, "0")}\\.zip$`));
  assert.match(pins.sdk.find((part) => part.name === "emulator")!.version, /^\d+\.\d+\.\d+\.\d+$/, "as the emulator says its version, which the record keeps");
  assert.equal(pins.license.id, "android-sdk-license");
  assert.match(pins.license.termsSha256, /^[0-9a-f]{64}$/);
  assert.match(pins.license.accepted, /^[0-9a-f]{40}$/);
});

test("the records the template's build writes are what BB Box reads: each device, its runtime and its snapshot's origin", () => {
  const runtime = (made: string) => ({
    platform: "android",
    api: pins.systemImage.api,
    image: pins.systemImage.image,
    revision: pins.systemImage.revision,
    abi: pins.systemImage.abi,
    emulator: pins.sdk.find((part) => part.name === "emulator")!.version,
    snapshot: { emulator: pins.sdk.find((part) => part.name === "emulator")!.version, cpu: "Example CPU", made },
  });
  const devices = pins.devices.map((device) => ({ model: device.model, native: device.avd, runtime: runtime("2026-10-26T05:15:46Z") }));
  const parsed = parseOfferedDevices(devices);
  assert.ok(parsed.ok, JSON.stringify(parsed));
  const script = read("prepare-avds.sh");
  for (const field of ["model: $model", "native: $avd", 'platform: "android"', "api: $image.api", "image: $image.image", "revision: $image.revision", "abi: $image.abi", "emulator: $emulator", "snapshot: {emulator: $emulator, cpu: $cpu, made: $made}"]) {
    assert.ok(script.includes(field), field);
  }
});

test("the device's firewall drops what the emulator, adb and adb's server listen on, and its check knows exactly those rules", () => {
  const rules = read("device-firewall.nft");
  assert.match(rules, /^table inet bb_box_device \{$/m);
  assert.match(rules, /type filter hook input priority -300; policy accept;/);
  assert.match(rules, /iifname "lo" accept/);
  const ports = /tcp dport \{ ([^}]+) \} drop/.exec(rules)![1]!.split(", ");
  assert.deepEqual(ports, ["5037", "5554-5585", "8554"]);
  const firewall = read("bb-box-device-firewall");
  const expected = JSON.parse(/^expected_rules='(.*)'$/m.exec(firewall)![1]!) as unknown[][];
  const set = (expected[1]![0] as { match: { right: { set: (number | { range: number[] })[] } } }).match.right.set;
  assert.deepEqual(
    set.map((entry) => (typeof entry === "number" ? String(entry) : entry.range.join("-"))),
    ports,
  );
  const emulator = read("bb-box-emulator");
  assert.match(emulator, /bb-box-device-firewall check/, "the emulator does not start without it");
  assert.match(emulator, /-port 5554 -grpc 8554 -grpc-use-token/);
  assert.match(read("check-android.sh"), /for port in 8554 5554 5555 5037/);
});

test("what each box makes for itself is cleared before an Android image is captured, after the build's own check", () => {
  const finalize = readFileSync(join(ANDROID, "..", "proxmox-lxc", "template", "guest", "finalize.sh"), "utf8");
  assert.match(finalize, /^\[ "\$kind" != android \] \|\| \/usr\/local\/sbin\/bb-box-clear-device-state /m);
  assert.match(read("customize-android.sh"), /install -m 0755 "\$here\/clear-device-state\.sh" \/usr\/local\/sbin\/bb-box-clear-device-state/);
  const cleared = read("clear-device-state.sh");
  for (const path of [".android/adbkey", ".android/adbkey.pub", ".emulator_console_auth_token", ".android/avd/running", ".android/userid"]) assert.ok(cleared.includes(`"$home/${path}"`), path);
  assert.match(read("check-android.sh"), /older than the image's build: it came with the image/);
});

test("the template's scripts parse, and carry no comments: their usage says what they do", () => {
  const scripts = readdirSync(ANDROID).filter((name) => name.endsWith(".sh") || name.startsWith("bb-box-") && !name.includes("."));
  assert.ok(scripts.includes("customize-android.sh") && scripts.includes("bb-box-emulator"));
  for (const name of scripts.filter((one) => one !== "bb-box-h264")) {
    const text = read(name);
    assert.equal(spawnSync("bash", ["-n", join(ANDROID, name)]).status, 0, name);
    const comments = text.split("\n").slice(1).filter((line) => /^\s*#/.test(line));
    assert.deepEqual(comments, [], name);
  }
});

const STAND_INS: Readonly<Record<string, string>> = {
  python3: "exit 0",
  systemctl: "exit 0",
  "bb-box-device-firewall": '[ ! -e "$STATE/table-gone" ]',
  sudo: `case "$*" in
  "-n nft delete table inet bb_box_device") touch "$STATE/table-gone" ;;
  "-n systemctl restart bb-box-device-firewall.service") rm -f "$STATE/table-gone" ;;
  *"/dev/tcp/192.0.2.1/22"*) exit 0 ;;
  *"/dev/tcp/"*) exit 1 ;;
esac`,
  "bb-box-emulator": `case "$1" in
  start)
    [ ! -e "$STATE/table-gone" ] || exit 1
    if [ -e "$STATE/start-ends" ]; then
      echo "bb-box-emulator: the emulator ended before $2 booted, with exit status 1; its last lines:"
      for line in $(seq 1 6); do echo "INFO | starting, step $line of six, with a line long enough to fill the check's output"; done
      echo "FATAL | the last line the emulator wrote"
      exit 1
    fi
    echo "$2" >"$STATE/avd"; echo unfold >"$STATE/fold"; echo "avd=$2 boot_s=2.500 snapshot=loaded" ;;
  stop) rm -f "$STATE/avd" ;;
  grpc) case "\${3:-}" in --no-token | --token) echo 16 ;; *) echo 0 ;; esac ;;
esac`,
  adb: `shift 2
case "$1" in
  emu) echo "$2" >"$STATE/fold" ;;
  shell)
    shift
    case "$*" in
      "wm size")
        case "$(cat "$STATE/avd")" in
          pixel_8) echo "Physical size: 1080x2400" ;;
          pixel_tablet) echo "Physical size: 2560x1600" ;;
          pixel_fold) if [ "$(cat "$STATE/fold")" = fold ]; then echo "Physical size: 1080x2092"; else echo "Physical size: 2208x1840"; fi ;;
        esac ;;
      "settings get system accelerometer_rotation") echo 1 ;;
      "settings get system screen_off_timeout") echo 2147483647 ;;
      "settings get secure device_state_rotation_lock") if [ "$(cat "$STATE/avd")" = pixel_fold ]; then cat "$STATE/fold-postures"; else echo null; fi ;;
      "settings get "*) echo 0 ;;
      "dumpsys power") echo "mStayOn=true" ;;
      "su 0 grep -c AndroidWifi /data/misc/apexdata/com.android.wifi/WifiConfigStore.xml") if [ -e "$STATE/wifi-in-memory-only" ]; then echo 0; else echo 2; fi ;;
      "dumpsys connectivity") printf 'Active default network: 100\n  NetworkAgentInfo{network{100}  nc{[ Transports: WIFI Capabilities: NOT_METERED&INTERNET&VALIDATED&NOT_ROAMING ]}}\n' ;;
    esac ;;
esac`,
};

const ANDROID_POSTURES_CLOSED_LOCKED = "0:1:1:2:2:0";
const IMAGE_POSTURES_ALL_ROTATING = "0:2:1:2:2:0";

interface CheckWorld {
  readonly staleKey?: boolean;
  readonly wifiInMemoryOnly?: boolean;
  readonly foldPostures?: string;
  readonly startEnds?: boolean;
}

function checkAt(stage: "before finalize" | "after finalize" | "no devices", { staleKey = false, wifiInMemoryOnly = false, foldPostures = IMAGE_POSTURES_ALL_ROTATING, startEnds = false }: CheckWorld = {}) {
  const root = mkdtempSync(join(tmpdir(), "android-check-"));
  try {
    const bin = join(root, "bin");
    const share = join(root, "share");
    const home = join(root, "home");
    const state = join(root, "state");
    for (const dir of [bin, share, home, state]) mkdirSync(dir, { recursive: true });
    if (wifiInMemoryOnly) writeFileSync(join(state, "wifi-in-memory-only"), "");
    if (startEnds) writeFileSync(join(state, "start-ends"), "");
    writeFileSync(join(state, "fold-postures"), `${foldPostures}\n`);
    for (const [name, body] of Object.entries(STAND_INS)) writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    writeFileSync(join(share, "android-pins.json"), read("pins.json"));
    if (stage !== "no devices") writeFileSync(join(share, "android-devices.json"), JSON.stringify(pins.devices.map((device) => ({ model: device.model, native: device.avd }))));
    const built = new Date(Date.now() - 60_000);
    if (stage === "after finalize") writeFileSync(join(share, "image.json"), JSON.stringify({ kind: "android", built: built.toISOString().replace(/\.\d+Z$/, "Z") }));
    for (const device of pins.devices) {
      mkdirSync(join(home, ".android", "avd", `${device.avd}.avd`), { recursive: true });
      writeFileSync(join(home, ".android", "avd", `${device.avd}.avd`, "config.ini"), "hw.keyboard = yes\n");
    }
    if (staleKey) {
      writeFileSync(join(home, ".android", "adbkey"), "");
      const before = new Date(built.getTime() - 3_600_000);
      utimesSync(join(home, ".android", "adbkey"), before, before);
    }
    const ran = spawnSync("bash", [join(ANDROID, "check-android.sh"), "--no-base"], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STATE: state, BB_BOX_SHARE: share, ANDROID_HOME: join(root, "no-sdk") },
      encoding: "utf8",
      timeout: 60_000,
    });
    return ran.stdout.split("\n").filter(Boolean);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the image's check passes in build.sh's order, before finalize.sh writes the image's record, and after it in a clone", () => {
  for (const stage of ["before finalize", "after finalize"] as const) {
    const lines = checkAt(stage);
    assert.deepEqual(lines.filter((line) => /\bFAIL\b/.test(line)), [], `${stage}:\n${lines.join("\n")}`);
    for (const device of pins.devices) assert.ok(lines.some((line) => line.startsWith(`${device.model} boots from its snapshot`) && /\bok\b/.test(line)), `${stage}: ${device.model}`);
    assert.ok(lines.some((line) => /^Pixel Fold screens +ok +closed 1080x2092, open 2208x1840$/.test(line)), stage);
    assert.ok(lines.some((line) => /^Pixel 8 Wi-Fi +ok +AndroidWifi saved on disk, a validated default network$/.test(line)), stage);
    assert.ok(lines.some((line) => /^Pixel Fold defaults +ok +.*, auto-rotate on in every posture, awake$/.test(line)), stage);
    assert.ok(lines.some((line) => /^Pixel 8 defaults +ok +.*, auto-rotate on, awake$/.test(line)), stage);
    assert.equal(lines.filter((line) => /\bok\b/.test(line)).length, 4 + 6 * pins.devices.length, stage);
  }
});

test("the image's check fails, not passes, when the build made no devices, and when an adb key came with the image", () => {
  const none = checkAt("no devices");
  assert.ok(none.some((line) => /^no emulator without the firewall +FAIL .*lists no device to try$/.test(line)), none.join("\n"));
  assert.ok(none.some((line) => /^devices the build made +FAIL /.test(line)), none.join("\n"));
  const stale = checkAt("after finalize", { staleKey: true });
  assert.ok(stale.some((line) => /^this box's own adb identity +FAIL .*adbkey is older than the image's build/.test(line)), stale.join("\n"));
});

test("the image's check fails a snapshot whose AndroidWifi is only in its memory, not in the Wi-Fi store on disk (F-3)", () => {
  const lines = checkAt("after finalize", { wifiInMemoryOnly: true });
  for (const device of pins.devices) assert.ok(lines.some((line) => line.startsWith(`${device.model} Wi-Fi`) && /FAIL AndroidWifi is not in the Wi-Fi store on disk/.test(line)), lines.join("\n"));
});

test("the image's check fails a Pixel Fold whose closed posture locks auto-rotate, as Android's own default does, though it rotates once opened", () => {
  const lines = checkAt("after finalize", { foldPostures: ANDROID_POSTURES_CLOSED_LOCKED });

  assert.ok(lines.some((line) => /^Pixel Fold defaults +FAIL not as the image sets them: device_state_rotation_lock=0:1:1:2:2:0$/.test(line)), lines.join("\n"));
  for (const model of ["Pixel 8", "Pixel Tablet"]) assert.ok(lines.some((line) => line.startsWith(`${model} defaults`) && /\bok\b/.test(line)), lines.join("\n"));
});

test("the image's check shows the whole of a failed start, down to the emulator's last line", () => {
  const lines = checkAt("after finalize", { startEnds: true });

  const failed = lines.findIndex((line) => /^Pixel 8 boots from its snapshot +FAIL bb-box-emulator: the emulator ended before pixel_8 booted, with exit status 1; its last lines:$/.test(line));
  assert.notEqual(failed, -1, lines.join("\n"));
  assert.equal(lines[failed + 7], "FATAL | the last line the emulator wrote", lines.join("\n"));
});

const BUILD_STAND_INS: Readonly<Record<string, string>> = {
  sleep: "exit 0",
  emulator: 'echo "Android emulator version 37.2.12.0 (build_id 16428233) (CL:N/A)"',
  avdmanager: `cat >/dev/null
while [ $# -gt 0 ]; do [ "$1" = -n ] && name=$2; shift; done
mkdir -p "$HOME/.android/avd/$name.avd" && touch "$HOME/.android/avd/$name.avd/config.ini"`,
  "bb-box-emulator": `case "$1" in
  start) echo "$2" >"$STATE/avd"; mkdir -p "$STATE/settings/$2"; if [ "\${3:-}" = --cold ]; then echo "avd=$2 boot_s=20.000 snapshot=cold"; else echo "avd=$2 boot_s=3.000 snapshot=loaded"; fi ;;
  stop) [ ! -e "$STATE/avd" ] || { avd=$(cat "$STATE/avd"); mkdir -p "$HOME/.android/avd/$avd.avd/snapshots/default_boot"; touch "$HOME/.android/avd/$avd.avd/snapshots/default_boot/ram.bin"; rm -f "$STATE/avd"; } ;;
  grpc) echo 0 ;;
esac`,
  adb: `[ "$1" = -s ] || exit 0
shift 2
[ "$1" = shell ] || exit 0
shift
avd=$(cat "$STATE/avd")
store=$STATE/settings/$avd
case "$1 $2" in
  "settings put")
    [ "$4" = device_state_rotation_lock ] && [ -e "$STATE/postures-refused" ] && exit 0
    echo "$5" >"$store/$3.$4" ;;
  "settings get")
    if [ -e "$store/$3.$4" ]; then cat "$store/$3.$4"
    elif [ "$3 $4 $avd" = "secure device_state_rotation_lock pixel_fold" ]; then echo ${ANDROID_POSTURES_CLOSED_LOCKED}
    else echo null; fi ;;
  "dumpsys power") echo "mStayOn=true" ;;
  "su 0") echo 2 ;;
esac`,
};

function buildAvds(posturesRefused = false) {
  const root = mkdtempSync(join(tmpdir(), "android-avds-"));
  try {
    const bin = join(root, "bin");
    const home = join(root, "home");
    const state = join(root, "state");
    for (const dir of [bin, home, state]) mkdirSync(dir, { recursive: true });
    for (const [name, body] of Object.entries(BUILD_STAND_INS)) writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
    if (posturesRefused) writeFileSync(join(state, "postures-refused"), "");

    const ran = spawnSync("bash", [join(ANDROID, "prepare-avds.sh"), join(ANDROID, "pins.json"), join(root, "devices.json")], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STATE: state, ANDROID_HOME: join(root, "no-sdk") },
      encoding: "utf8",
      timeout: 60_000,
    });

    const written = (avd: string) => {
      try {
        return readFileSync(join(state, "settings", avd, "secure.device_state_rotation_lock"), "utf8").trim();
      } catch {
        return null;
      }
    };
    return { status: ran.status, stderr: ran.stderr, postures: Object.fromEntries(pins.devices.map((device) => [device.model, written(device.avd)])) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("the build turns auto-rotate on in every posture of the Pixel Fold, where Android locks it when closed, and leaves the other devices' postures alone", () => {
  const built = buildAvds();

  assert.equal(built.status, 0, built.stderr);
  assert.deepEqual(built.postures, { "Pixel 8": null, "Pixel Fold": IMAGE_POSTURES_ALL_ROTATING, "Pixel Tablet": null });
});

test("the build stops when the Pixel Fold keeps auto-rotate locked in a posture", () => {
  const built = buildAvds(true);

  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /prepare-avds: device_state_rotation_lock is 0:1:1:2:2:0, which locks auto-rotate in a posture/);
});

const EMULATOR_STAND_INS: Readonly<Record<string, string>> = {
  "bb-box-device-firewall": "exit 0",
  adb: `case "$*" in
  "-s emulator-5554 shell getprop sys.boot_completed") [ ! -e "$STATE/booted" ] || echo 1 ;;
  "-s emulator-5554 emu kill") exit 1 ;;
esac`,
  emulator: `case "$FAKE_EMULATOR" in
  hides-its-command-line)
    echo "INFO | Android emulator version 37.2.12.0"
    export QEMU=qemu-system-x86_64-headless
    exec -a "" bash -c 'sleep 1; touch "$STATE/booted"; exec -a "$QEMU" sleep 60' ;;
  fails)
    for line in $(seq 1 6); do echo "INFO | starting, step $line of six, with a line long enough to fill the check's output"; done
    echo "FATAL | Not enough space to create userdata partition"
    exit 3 ;;
  killed) kill -KILL $$ ;;
esac`,
};

function emulatorWorld() {
  const root = mkdtempSync(join(tmpdir(), "android-device-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const state = join(root, "state");
  for (const dir of [bin, home, state]) mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(EMULATOR_STAND_INS)) writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });

  const run = (fake: string, ...args: string[]) => {
    const ran = spawnSync("bash", [join(ANDROID, "bb-box-emulator"), ...args], {
      env: { PATH: `${bin}:/usr/bin:/bin`, HOME: home, STATE: state, ANDROID_HOME: join(root, "no-sdk"), FAKE_EMULATOR: fake },
      encoding: "utf8",
      timeout: 30_000,
    });
    return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
  };
  const recordedPid = () => Number(readFileSync(join(home, ".bb-box", "device", "emulator", "pid"), "utf8"));
  const close = () => {
    try {
      process.kill(recordedPid(), "SIGKILL");
    } catch {}
    rmSync(root, { recursive: true, force: true });
  };
  return { run, recordedPid, close };
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test("bb-box-emulator waits for its own emulator while its command line reads empty, as it does for a moment at each exec", () => {
  const world = emulatorWorld();
  try {
    const started = world.run("hides-its-command-line", "start", "pixel_8", "--no-save", "--timeout", "20");

    assert.equal(started.status, 0, started.stderr);
    assert.match(started.stdout, /^avd=pixel_8 boot_s=\d+\.\d{3} snapshot=not-loaded$/m);
    assert.equal(world.run("", "status").stdout.trim(), `pixel_8 ${world.recordedPid()}`);

    const pid = world.recordedPid();
    assert.equal(world.run("", "stop").status, 0);
    assert.equal(processAlive(pid), false);
  } finally {
    world.close();
  }
});

test("bb-box-emulator says how an emulator that ends before booting ended, with its last lines", () => {
  const world = emulatorWorld();
  try {
    const started = world.run("fails", "start", "pixel_8", "--no-save", "--timeout", "20");

    assert.equal(started.status, 1);
    assert.match(started.stderr, /^bb-box-emulator: the emulator ended before pixel_8 booted, with exit status 3; its last lines:\n(INFO .*\n){6}FATAL \| Not enough space to create userdata partition\n$/);
  } finally {
    world.close();
  }
});

test("bb-box-emulator says why it shows no lines when the emulator is killed before it writes any", () => {
  const world = emulatorWorld();
  try {
    const started = world.run("killed", "start", "pixel_8", "--no-save", "--timeout", "20");

    assert.equal(started.status, 1);
    assert.match(started.stderr, /^bb-box-emulator: the emulator ended before pixel_8 booted, killed by signal KILL, and wrote nothing to \S+\/emulator\.log; the kernel's log may say why: sudo dmesg \| tail\n$/);
  } finally {
    world.close();
  }
});
