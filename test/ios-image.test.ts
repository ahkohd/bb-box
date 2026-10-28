import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { judgeImage, parseImageRecord, pinsDigest } from "../src/backends/images.ts";
import { HELD_PORTS } from "../src/backends/tart/device-host.ts";
import { DEVICE_MODELS } from "../src/core/device-models.ts";
import { parseOfferedDevices } from "../src/core/device-parse.ts";
import { IOS_COMPANION_PAIRINGS, IOS_CONTENT_SIZES } from "../src/core/device.ts";
import { PASTEBOARD_SERVER, PASTEBOARD_SERVER_LABEL, PASTEBOARD_SERVICES, SESSION_JOB_LABEL, sessionJobPlist } from "../src/device/user-session.ts";

const SETUP = join(import.meta.dirname, "..", "setup");
const IOS = join(SETUP, "tart", "ios");
const read = (name: string) => readFileSync(join(IOS, name), "utf8");
const devices = read("devices.tsv")
  .trim()
  .split("\n")
  .map((line) => line.split("\t"));
const slimList = read("slim/ios-27.0-24A434.txt").trim().split("\n");
const pins = Object.fromEntries(
  read("pins")
    .trim()
    .split("\n")
    .map((line) => line.split("=", 2) as [string, string]),
);

test("the image's devices are the model table's iOS models, with its screens' pixels, which the image's check compares", () => {
  const ios = DEVICE_MODELS.filter((model) => model.platform === "ios");
  assert.deepEqual(
    devices.map(([model]) => model),
    ios.map((model) => model.name),
  );
  for (const model of ios) {
    const [, native, width, height] = devices.find(([name]) => name === model.name)!;
    assert.match(native!, /^com\.apple\.CoreSimulator\.SimDeviceType\.[A-Za-z0-9-]+$/, model.name);
    assert.deepEqual([Number(width), Number(height)], [model.screen.pixels.width, model.screen.pixels.height], model.name);
  }
});

test("idb_companion is Meta's release, pinned by URL and SHA-256, at a version an image check passed with Xcode, with its MIT notice", () => {
  assert.deepEqual(Object.keys(pins), ["IDB_VERSION", "IDB_URL", "IDB_SHA256"]);
  assert.equal(pins.IDB_URL, `https://github.com/facebook/idb/releases/download/v${pins.IDB_VERSION}/idb-companion.macos-arm64.tar.gz`);
  assert.match(pins.IDB_SHA256!, /^[0-9a-f]{64}$/);
  assert.ok(IOS_COMPANION_PAIRINGS.some((pairing) => pairing.companion === pins.IDB_VERSION));
  const notice = read("idb-companion-LICENSE");
  assert.match(notice, /^MIT License\n\nCopyright \(c\) Meta Platforms, Inc\. and affiliates\./);
  assert.equal(createHash("sha256").update(notice).digest("hex"), "da6d3703ed11cbe42bd212c725957c98da23cbff1998c05fa4b3d976d1a58e93", "facebook/idb's LICENSE at the pinned tag");
});

test("the slimming list is the research's full list: 112 labels, sorted, none of them launchd's one-shot labels or a service kept for a stated reason", () => {
  assert.equal(slimList.length, 112);
  assert.deepEqual(slimList, [...new Set(slimList)].sort());
  for (const label of slimList) assert.match(label, /^com\.apple\.[A-Za-z0-9._-]+$/);
  assert.ok(!slimList.some((label) => label.includes(".oneshot.")));
  for (const kept of ["com.apple.nanoregistryd", "com.apple.sleepd", "com.apple.gamed", "com.apple.SpringBoard", "com.apple.backboardd", "com.apple.CoreSimulator.bridge", "com.apple.pasteboard.pasted"]) {
    assert.ok(!slimList.includes(kept), `${kept} is kept`);
  }
  for (const gone of ["com.apple.apsd", "com.apple.PosterBoard", "com.apple.chronod", "com.apple.assistantd", "com.apple.healthd"]) assert.ok(slimList.includes(gone), gone);
});

test("the image's pins digest is the build's: pins, then devices.tsv, as prepare-ios-image.sh hashes them", async () => {
  const expected = createHash("sha256").update(read("pins")).update(read("devices.tsv")).digest("hex");
  assert.equal(await pinsDigest(SETUP, "ios"), expected);
  assert.match(readFileSync(join(SETUP, "tart", "prepare-ios-image.sh"), "utf8"), /cat "\$here\/ios\/pins" "\$here\/ios\/devices\.tsv" \| shasum -a 256/);
});

test("the record the build writes is the macOS image's, with kind ios, the macOS build as its base, idb_companion, and each device with its runtime and slimming list", (t) => {
  const python = spawnSync("python3", ["--version"]);
  if (python.status !== 0) return t.skip("no python3");
  const dir = mkdtempSync(join(tmpdir(), "ios-record-"));
  const base = { contract: 1, image: "standard", kind: "macos", arch: "arm64", build: "build.20261022-033224-9658", built: "2026-10-22T03:32:24Z", base: null, os: "macOS 27.0", aptSnapshot: null, pins: "p", bbApp: "app", tools: { xcode: "27.0", node: "24.21.0" }, nvidia: null, layer: null, sizeGiB: null };
  writeFileSync(join(dir, "macos.json"), JSON.stringify(base));
  const sha = "b".repeat(64);
  writeFileSync(
    join(dir, "build.txt"),
    [
      ...devices.map(([model, native]) => `device=${model}\t${native}\tUDID\t27.6\t89.5\t112`),
      "runtime=27.0\t24A434\t27.0\t1.7.7\tcom.apple.CoreSimulator.SimRuntime.iOS-27-0",
      `slim=ios-27.0-24A434\t112\t${sha}`,
      "encoders=no\topenh264 2.6.0",
      "",
    ].join("\n"),
  );
  const made = spawnSync("python3", ["-I", join(IOS, "record-ios.py"), join(dir, "macos.json"), join(dir, "build.txt"), "build.20261026-071000-abcd", "2026-10-26T07:10:00Z", "pins"], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr);
  const record = parseImageRecord(JSON.parse(made.stdout));
  assert.ok(record);
  assert.deepEqual([record.kind, record.base, record.build, record.pins, record.bbApp, record.tools.idb_companion, record.tools.xcode], ["ios", base.build, "build.20261026-071000-abcd", "pins", "app", "1.7.7", "27.0"]);
  assert.deepEqual(
    record.devices?.map((device) => [device.model, device.runtime.platform === "ios" && device.runtime.companion, "slim" in device && device.slim]),
    devices.map(([model]) => [model, "1.7.7", { list: "ios-27.0-24A434", labels: 112, sha256: sha }]),
  );
  assert.equal(judgeImage(record, { os: "ios", pins: "pins", bbApp: "app", macosBuild: base.build, now: Date.parse("2026-10-27T00:00:00Z") }, "rebuild").status, "ok");
  assert.deepEqual(record.encoders, { hardware: false, software: "openh264 2.6.0" }, "the build's VM measured its encoders (065)");
  assert.equal(record.tools["bb-box-h264"], "openh264 2.6.0");
});

test("an iOS device's slimming list is read where records are read, and refused on Android devices or when malformed", () => {
  const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" };
  const slim = { list: "ios-27.0-24A434", labels: 112, sha256: "c".repeat(64) };
  const parsed = parseOfferedDevices([{ model: "iPhone 17", native: "x", runtime, slim }]);
  assert.ok(parsed.ok && "slim" in parsed.value[0] && parsed.value[0].slim?.labels === 112);
  const stock = parseOfferedDevices([{ model: "iPhone 17", native: "x", runtime }]);
  assert.ok(stock.ok && !("slim" in stock.value[0]), "a device built without slimming");
  const android = { platform: "android", api: 35, image: "google_apis", revision: 9, abi: "x86_64", emulator: "37.2.12.0", snapshot: null };
  const refused = parseOfferedDevices([{ model: "Pixel 8", native: "pixel_8", runtime: android, slim }]);
  assert.ok(!refused.ok && /\[0\]\.slim is only for iOS devices/.test(refused.words));
  const badSha = parseOfferedDevices([{ model: "iPhone 17", native: "x", runtime, slim: { ...slim, sha256: "nope" } }]);
  assert.ok(!badSha.ok && /slim\.sha256 must be a SHA-256 in hex/.test(badSha.words));
});

test("an iOS image with no devices fails the doctor, and one with a stock device warns", () => {
  const record = parseImageRecord({ contract: 1, image: "standard", kind: "ios", arch: "arm64", build: "b", built: new Date().toISOString(), base: "m", os: "macOS 27.0", pins: "p", tools: {} })!;
  const none = judgeImage(record, { os: "ios", pins: null, bbApp: null, macosBuild: "m" }, "rebuild");
  assert.equal(none.status, "fail");
  assert.match(none.detail, /It offers no iOS devices in its record/);
  const runtime = { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" };
  const stock = parseImageRecord({ ...record, devices: [{ model: "iPhone 17", native: "x", runtime }] })!;
  const judged = judgeImage(stock, { os: "ios", pins: null, bbApp: null, macosBuild: "m" }, "rebuild");
  assert.equal(judged.status, "warn");
  assert.match(judged.detail, /iPhone 17 is not slimmed, so it takes about 1 GiB more memory/);
});

test("the build and the check are POSIX sh that parses, and the check runs the three checks the slimming note asks for", () => {
  for (const script of ["build-ios.sh", "check-ios.sh", "host-ios.sh", "device-host.sh"]) {
    const parsed = spawnSync("sh", ["-n", join(IOS, script)], { encoding: "utf8" });
    assert.equal(parsed.status, 0, `${script}: ${parsed.stderr}`);
  }
  assert.equal(spawnSync("sh", ["-n", join(SETUP, "tart", "prepare-ios-image.sh")]).status, 0);
  const check = read("check-ios.sh");
  assert.match(check, /boot_limit_s=\$\{BOOT_LIMIT_S:-60\}/, "nanoregistryd: bootstatus within 60 s");
  assert.match(check, /idle_cores_most=\$\{IDLE_CORES_MOST:-0\.1\}/, "sleepd: idle CPU at most 0.1 of a core");
  assert.match(check, /launch_limit_s=\$\{LAUNCH_LIMIT_S:-3\}/, "gamed: an XCUITest launch within 3 s");
  const build = read("build-ios.sh");
  assert.match(build, /apply_slimming "\$udid" "\$list"\n  restart_device "\$udid"\n  apply_slimming "\$udid" "\$list"/, "apply, reboot, apply again");
  assert.match(build, /\[ "\$count" -eq "\$labels" \] \|\| die/, "then the count is checked");
});

test("the check sets and reads back each control box_device reads back, on each model: appearance, every text size, the status bar, and reads the lock state (063)", () => {
  const check = read("check-ios.sh");
  const sizes = /^content_sizes="([^"]+)"$/m.exec(check)?.[1]?.split(" ");
  assert.deepEqual(sizes, [...IOS_CONTENT_SIZES], "the text sizes are box_device's");
  for (const line of [
    'check "$model appearance" ui_sets_and_reads_back "$udid" appearance "dark light"',
    'check "$model text size" ui_sets_and_reads_back "$udid" content_size "$content_sizes"',
    'check "$model status bar" status_bar_reads_back "$udid"',
    'check "$model lock state" lock_state_reads "$udid"',
  ]) {
    assert.ok(check.includes(line), line);
  }
  assert.match(check, /notifyutil -g com\.apple\.springboard\.lockstate/, "the lock state the driver reads");
});

test("the image's additions install device-host and its carried slots, and leave the host's settings to the host's backend", () => {
  const host = read("host-ios.sh");
  assert.match(host, /"\$helper" install/);
  assert.match(host, /"\$helper" carry/);
  assert.doesNotMatch(host, /bb-machines|bb-app/, "the image keeps no BB app for the slots, as it is stale after BB's next update; bb-box keeps the server's on each host (F-8)");
  assert.doesNotMatch(host, /"\$helper" init/, "settings are a snapshot taken when a host is made, so the image writes none");
  assert.match(read("build-ios.sh"), /sudo -n \/bin\/sh "\$here\/host-ios\.sh" "\$here" "\$\(id -un\)"/);
  assert.match(readFileSync(join(SETUP, "tart", "prepare-ios-image.sh"), "utf8"), /-C "\$here\/\.\.\/ssh-pool" mac-home\/\.zshenv/, "the slots' home is the pool's");
});

test("the image's check finds the held ports free and their daemon written but not loaded, as a dedicated box needs them (064 F-6)", () => {
  const check = read("check-ios.sh");
  assert.match(check, new RegExp(`^held_ports="${HELD_PORTS.join(" ")}"$`, "m"));
  assert.ok(check.includes('check "device-host daemons" daemons_written_not_loaded\ncheck "held ports free" held_ports_free\n'));
  assert.doesNotMatch(check, /421/, "nothing answers the held ports in the image");
});

test("a slot's clipboard: the image's check and the pool's setup run one script that sets and reads a device's clipboard as the device server does, in the user's own launchd session with its own pasteboard server (F-17)", () => {
  const script = read("slot-clipboard.sh");
  assert.equal(spawnSync("sh", ["-n", join(IOS, "slot-clipboard.sh")]).status, 0);
  for (const name of [PASTEBOARD_SERVER_LABEL, SESSION_JOB_LABEL, PASTEBOARD_SERVER, ...PASTEBOARD_SERVICES]) assert.ok(script.includes(name), name);
  assert.match(script, /domain=gui\/\$uid session=Aqua own_server=no/, "a user with a desktop session uses macOS's own pasteboard server");
  assert.match(script, /domain=user\/\$uid session=Background own_server=yes/);
  const wrapper = /<string>("\$0"[^<]*)<\/string>/.exec(sessionJobPlist({ label: "x", dir: "/d", session: "Background", program: "/p", args: [], env: {} }))![1]!;
  assert.ok(script.includes(wrapper), "the job keeps its exit code as the device server's does");
  assert.match(script, /as_user launchctl bootstrap "\$domain"/, "loaded as the user, as the device server does, not as root");
  assert.match(script, /printf '' \| session_job pbcopy/, "the device's clipboard is left empty");
  assert.match(script, /^SET_TRIES=12$/m, "a just-booted device's pasteboard answers some seconds later");
  assert.doesNotMatch(script.replace(/echo \$\? &gt;exit\.new/, ""), /echo "[^"]*"; (return|exit) 1/, "a failure's words go to standard error, as its callers keep it");

  const check = read("check-ios.sh");
  assert.ok(check.includes('check "slot uids" slot_uids_only_carried\ncheck "slot clipboard" carried_slot_clipboard_works\n'));
  assert.match(check, /sudo -n "\$slot_clipboard" "\$user" "\$udid"/);
  assert.match(check, /as_slot shutdown "\$udid"/, "the carried slot's device is shut down again, as the image keeps it");
  assert.match(read("build-ios.sh"), /sudo install -m 0755 "\$here\/slot-clipboard\.sh" \/usr\/local\/libexec\/bb-box\/slot-clipboard/);

  const pool = readFileSync(join(SETUP, "ssh-pool", "mac-ios.sh"), "utf8");
  assert.match(pool, /for file in [^;]*slot-clipboard\.sh/);
  assert.match(pool, /said=\$\(\/bin\/sh "\$ios\/slot-clipboard\.sh" "\$admin" "\$udid" 2>&1\)/);
  assert.match(pool, /if \[ -z "\$\{HOST_SETTINGS:-\}" \]; then\n  step "checking that a slot's user/, "on the pool's kept Mac only, so a Namespace host starts no slower");
  assert.match(pool, /echo "warning=A slot cannot set or read its device's clipboard/);
});
