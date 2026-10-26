import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
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

test("the records the template's build writes are what bb-box reads: each device, its runtime and its snapshot's origin", () => {
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
