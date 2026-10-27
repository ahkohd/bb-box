import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TartBackendOptions } from "../src/backends/tart/backend.ts";
import { DEVICE_HOST_HELPER } from "../src/backends/tart/device-host.ts";
import { HOST_VM_PREFIX } from "../src/backends/tart/ios-hosts.ts";
import { FAKE_MAC, addImage, fakeMacTools, imageRecord } from "./fake-mac.ts";
import { fakeDeviceHost, type FakeDeviceHost } from "./fake-device-host.ts";
import { FAKE_MAC_HELPER, FAKE_SSH_BINARY, fakeSsh } from "./helpers.ts";

const IOS_DEVICE = (model: string, native: string) => ({
  model,
  native,
  runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" },
  slim: { list: "ios-27.0-24A434", labels: 112, sha256: "a".repeat(64) },
});
export const IOS_HOST_DEVICES = [IOS_DEVICE("iPhone 18 Pro", "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro"), IOS_DEVICE("iPhone 17", "com.apple.CoreSimulator.SimDeviceType.iPhone-17")];
export const IOS_HOST_FAKES: TartBackendOptions = { sshBinary: FAKE_SSH_BINARY, sleep: async () => {}, readyTimeoutMs: 20_000, macHelper: FAKE_MAC_HELPER, fillQuietMs: 0 };
export const IOS_HOST_SETTINGS = { "tart-ios-image": "bb-box-ios", "tart-ios-hosts-on": true, "tart-ios-hosts-most": 4, "tart-ios-hosts-ahead": 0 };
export const IOS_IMAGE_BUILD = "build.20261027-010000-1111";

function hostVmHome(home: string, device: FakeDeviceHost): void {
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const helper = join(device.root, "../host/device-host");
  const tools = join(device.root, "../bin");
  const env = `FAKE_MAC_STATE='${device.state}' FAKE_MAC_ROOT='${device.root}' FAKE_MAC_BIN='${tools}' FAKE_MACOS_BIN='${join(device.root, "../macos-bin")}' PATH='${tools}:/usr/bin:/bin' LC_ALL=C`;
  writeFileSync(
    join(bin, "sudo"),
    [
      "#!/bin/sh",
      '[ "$1" = -n ] && shift',
      `if [ "$1" = ${DEVICE_HOST_HELPER} ] && [ -f "$HOME/hold-$2" ]; then touch "$HOME/$2-held"; while [ -f "$HOME/hold-$2" ]; do sleep 0.05; done; fi`,
      `if [ "$1" = ${DEVICE_HOST_HELPER} ]; then shift; echo "$*" >> "$HOME/helper.log"; exec env ${env} /bin/sh '${helper}' "$@"; fi`,
      'for last in "$@"; do :; done',
      `if [ "$last" = ${DEVICE_HOST_HELPER} ]; then cat > "$HOME/installed-helper"; exit 0; fi`,
      'exec "$@"',
      "",
    ].join("\n"),
  );
  chmodSync(join(bin, "sudo"), 0o755);
}

export function fakeIosHostMac() {
  const ssh = fakeSsh();
  const mac = ssh.home(FAKE_MAC);
  fakeMacTools(mac);
  addImage(mac);
  addImage(mac, "bb-box-ios");
  writeFileSync(join(mac, ".bb-box", "tart", "images", "bb-box-ios.json"), `${imageRecord("ios", { build: IOS_IMAGE_BUILD, base: "build.20261003-021500", devices: IOS_HOST_DEVICES, tools: { idb_companion: "1.7.7" } })}\n`);
  const device = fakeDeviceHost();
  assert.equal(device.run(["carry"]).status, 0);
  for (let n = 2; n < 12; n++) hostVmHome(ssh.home(`192.168.64.${n}`), device);
  const hosts = () => readdirSync(join(mac, ".tart", "vms")).filter((vm) => vm.startsWith(HOST_VM_PREFIX));
  const clones = () =>
    readFileSync(join(mac, ".fake-tart-log"), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])
      .filter((args) => args[0] === "tart" && args[1] === "clone" && args[3]?.startsWith(HOST_VM_PREFIX));
  return { ssh, mac, device, hosts, clones };
}
