// A fake Mac for the Tart backend's tests: the fake tart and system tools in a fake ssh host's home, and an image there.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTartSettings, type TartConfig } from "../src/backends/tart/config.ts";

const GiB = 2 ** 30;
export const FAKE_MAC = "192.0.2.20";
export const FAKE_IMAGE = "bb-box-macos";
export const FAKE_WINDOWS_IMAGE = "bb-box-windows";

/**
 * Puts the fake tart, arp, sysctl, sw_vers and uname in a fake Mac's
 * ~/.nix-profile/bin, where the host scripts look for tart before the PATH.
 * Not on the test's own PATH: on a Mac whose /bin/sh is zsh, /etc/zshenv may
 * reset it.
 */
export function fakeMacTools(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  const script = new URL("./fake-tart.mjs", import.meta.url).pathname;
  for (const tool of ["tart", "arp", "sysctl", "sw_vers", "uname"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
}

/** Gives a fake Mac Xcode's command line tools, as far as `xcode-select -p` tells: the VNC holder runs on the test machine's own /usr/bin/python3. */
export function fakeXcode(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "xcode-select"), "#!/bin/sh\necho /Library/Developer/CommandLineTools\n");
  chmodSync(join(bin, "xcode-select"), 0o755);
}

/**
 * Puts the fake qemu-system-aarch64, qemu-img and nc in a fake Mac's
 * ~/.nix-profile/bin, and QEMU's firmware in its share/qemu, as a Nix
 * profile has them.
 */
export function fakeQemu(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  const share = join(home, ".nix-profile", "share", "qemu");
  mkdirSync(bin, { recursive: true });
  mkdirSync(share, { recursive: true });
  writeFileSync(join(share, "edk2-aarch64-code.fd"), "firmware");
  const script = new URL("./fake-qemu.mjs", import.meta.url).pathname;
  for (const tool of ["qemu-system-aarch64", "qemu-img", "nc"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
}

/** A fresh image record (049), as the prepare scripts write one. */
export function imageRecord(kind: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({ contract: 1, image: "standard", kind, arch: "arm64", build: "build.20261003-021500", built: new Date().toISOString(), os: "fake OS", tools: {}, ...changes });
}

/** Puts a build of a Windows image in a fake Mac's home, its disk read-only, with its record, and makes it the current one. */
export function addWindowsImage(home: string, build = "1", name = FAKE_WINDOWS_IMAGE): string {
  const image = join(home, ".bb-box", "qemu", "images", name);
  mkdirSync(join(image, build), { recursive: true });
  writeFileSync(join(image, build, "image.json"), `${imageRecord("windows-arm64-desktop")}\n`);
  writeFileSync(join(image, build, "disk.qcow2"), "base disk");
  chmodSync(join(image, build, "disk.qcow2"), 0o444);
  writeFileSync(join(image, build, "vars.fd"), "variables");
  rmSync(join(image, "current"), { force: true });
  symlinkSync(build, join(image, "current"));
  return join(image, build);
}

/** Puts a Tart VM in a fake Mac's home, as the setup guide leaves an image, with its record beside it. */
export function addImage(home: string, name = FAKE_IMAGE, os = "darwin"): void {
  mkdirSync(join(home, ".tart", "vms", name), { recursive: true });
  writeFileSync(join(home, ".tart", "vms", name, "config.json"), JSON.stringify({ os, cpuCount: 4, memorySize: 8 * GiB, macAddress: "02:00:00:00:00:01" }));
  mkdirSync(join(home, ".bb-box", "tart", "images"), { recursive: true });
  writeFileSync(join(home, ".bb-box", "tart", "images", `${name}.json`), `${imageRecord(os === "darwin" ? "macos" : "linux-arm64")}\n`);
}

export function tartConfig(values: Record<string, unknown> = {}): TartConfig {
  const parsed = parseTartSettings({
    "tart-enabled": true,
    "tart-hosts": `mac1 bbbox-admin@${FAKE_MAC}`,
    "tart-host-keys": `${FAKE_MAC} ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFakeHostKeyForTests`,
    ...values,
  });
  assert.ok(parsed.enabled && parsed.ok, JSON.stringify(parsed));
  return parsed.config;
}
