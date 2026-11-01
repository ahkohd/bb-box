// A fake Mac for the Tart backend's tests: the fake tart and system tools in a fake ssh host's home, and an image there.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTartSettings, type TartConfig } from "../src/backends/tart/config.ts";

const GiB = 2 ** 30;
export const FAKE_MAC = "192.0.2.20";
export const FAKE_IMAGE = "bb-box-macos";
export const FAKE_WINDOWS_IMAGE = "bb-box-windows";
/** The fake Mac's disk, whatever the test machine has free: 1 TiB, with 500 GiB free. */
export const FAKE_DISK_GIB = { size: 1024, free: 500 };

/**
 * Puts the fake tart, arp, sysctl, sw_vers, uname, mdutil, mdfind and df in a fake Mac's
 * ~/.nix-profile/bin, where the host scripts look for tart before the PATH.
 * Not on the test's own PATH: on a Mac whose /bin/sh is zsh, /etc/zshenv may
 * reset it.
 */
export function fakeMacTools(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  const script = new URL("./fake-tart.mjs", import.meta.url).pathname;
  for (const tool of ["tart", "arp", "sysctl", "sw_vers", "uname", "mdutil", "mdfind", "diskutil", "python3"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  const KiB = (gib: number) => gib * 2 ** 20;
  writeFileSync(join(bin, "df"), `#!/bin/sh\necho 'Filesystem 1024-blocks Used Available Capacity Mounted on'\necho 'fake ${KiB(FAKE_DISK_GIB.size)} ${KiB(FAKE_DISK_GIB.size - FAKE_DISK_GIB.free)} ${KiB(FAKE_DISK_GIB.free)} 50% /'\n`);
  chmodSync(join(bin, "df"), 0o755);
}

/** Gives a fake Mac Xcode's command line tools, as far as `xcode-select -p` tells: the VNC holder runs on the test machine's own /usr/bin/python3. */
export function fakeXcode(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "xcode-select"), "#!/bin/sh\necho /Library/Developer/CommandLineTools\n");
  chmodSync(join(bin, "xcode-select"), 0o755);
}

/**
 * Gives a fake Mac the Command Line Tools' swiftc, through xcrun, for the
 * build of bb-box-stream that Windows video runs (#865). What it builds is a
 * stand-in: `qemu <port> <socket> [<qmp socket>]` notes its arguments in
 * ~/.fake-stream-log and listens on the socket until it is ended, but with a
 * QMP socket exits 1 while ~/.fake-stream-no-dbus is there, as with a QEMU
 * that takes no D-Bus display client; `attach <socket>` prints "attached
 * <socket>". `fails`: swiftc fails with an error.
 */
export function fakeSwift(home: string, options: { fails?: boolean } = {}): void {
  fakeXcode(home);
  const bin = join(home, ".nix-profile", "bin");
  const standIn = [
    "#!/bin/sh",
    'case "$1" in',
    `  qemu) echo "$*" >> "$HOME/.fake-stream-log"; [ -z "$4" ] || [ ! -e "$HOME/.fake-stream-no-dbus" ] || exit 1; '${process.execPath}' -e 'require("node:net").createServer(() => {}).listen(process.argv[1])' "$3" & c=$!; trap 'kill $c; exit 0' TERM; wait $c ;;`,
    '  attach) echo "attached $2" ;;',
    "  *) exit 2 ;;",
    "esac",
    "",
  ].join("\n");
  writeFileSync(join(bin, "swift-stand-in"), standIn);
  const swiftc = options.fails
    ? 'echo "mac-stream.swift:12:3: error: cannot find \'SCStream\' in scope" >&2; exit 1'
    : `while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; cp "${join(bin, "swift-stand-in")}" "$out"`;
  writeFileSync(join(bin, "xcrun"), `#!/bin/sh
case "$1" in
  --find) echo /Library/Developer/CommandLineTools/usr/bin/swiftc ;;
  swiftc) shift; ${swiftc} ;;
esac
`);
  chmodSync(join(bin, "xcrun"), 0o755);
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

/** What a Windows image carries for its boxes to join BB and run threads (#539, #581). */
export const WINDOWS_TOOLS = { node: "24.21.0", "claude-code": "2.1.283", codex: "0.157.1", pi: "0.87.1" };

/** A fresh image record (049), as the prepare scripts write one. */
export function imageRecord(kind: string, changes: Record<string, unknown> = {}): string {
  return JSON.stringify({ contract: 1, image: "standard", kind, arch: "arm64", build: "build.20261003-021500", built: new Date().toISOString(), os: "fake OS", tools: {}, ...changes });
}

/** Puts a build of a Windows image in a fake Mac's home, its disk read-only, with its record, and makes it the current one. */
export function addWindowsImage(home: string, build = "1", name = FAKE_WINDOWS_IMAGE): string {
  const image = join(home, ".bb-box", "qemu", "images", name);
  mkdirSync(join(image, build), { recursive: true });
  writeFileSync(join(image, build, "image.json"), `${imageRecord("windows-arm64-desktop", { tools: WINDOWS_TOOLS })}\n`);
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
  addVmFiles(join(home, ".tart", "vms", name));
  mkdirSync(join(home, ".bb-box", "tart", "images"), { recursive: true });
  writeFileSync(join(home, ".bb-box", "tart", "images", `${name}.json`), `${imageRecord(os === "darwin" ? "macos" : "linux-arm64")}\n`);
}

export const FAKE_VM_DISK_BYTES = 64e9;

export function addVmFiles(vm: string, diskBytes = FAKE_VM_DISK_BYTES): void {
  writeFileSync(join(vm, "nvram.bin"), "");
  writeFileSync(join(vm, "disk.img"), "");
  truncateSync(join(vm, "disk.img"), diskBytes);
}

export function runVmElsewhere(vm: string): Promise<void> {
  writeFileSync(join(vm, "running"), String(process.pid));
  const lock = spawn("perl", [new URL("./fake-run-lock.pl", import.meta.url).pathname, join(vm, "config.json"), join(vm, "running"), String(process.pid)], { stdio: ["ignore", "pipe", "inherit"] });
  lock.unref();
  return new Promise((resolve, reject) => {
    lock.stdout.once("data", () => {
      lock.stdout.destroy();
      resolve();
    });
    lock.once("exit", (code) => reject(new Error(`fake-run-lock.pl exited ${code}`)));
  });
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

/**
 * Gives a Mac what bb-box's capability probe (065) reads, in `bin`: Xcode
 * through xcode-select and xcodebuild, its iOS runtimes through `xcrun
 * simctl`, and a hardware check that `xcrun swiftc` builds, which says
 * `hardware` (yes, or no as VideoToolbox's -12903). Each xcrun call is noted
 * in the Mac's ~/.fake-xcrun-log. `software` puts a bb-box-h264 at that path.
 */
export function fakeIosProbe(bin: string, options: { readonly hardware?: "yes" | "no"; readonly xcode?: string | null; readonly runtimes?: readonly string[]; readonly software?: string } = {}): void {
  mkdirSync(bin, { recursive: true });
  const xcode = options.xcode === undefined ? "27.0" : options.xcode;
  const tool = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  if (xcode !== null) {
    const developer = join(bin, "..", "Xcode.app", "Contents", "Developer");
    mkdirSync(developer, { recursive: true });
    tool("xcode-select", `echo '${developer}'`);
    tool("xcodebuild", `echo 'Xcode ${xcode}'; echo 'Build version 27A266a'`);
  }
  const hardware = options.hardware === "no" ? "echo hardware=no status=-12903" : "echo hardware=yes frames=12 seconds=0.05";
  const runtimes = (options.runtimes ?? ["iOS 27.0"]).map((runtime) => `echo '${runtime} (${runtime.slice(4)} - 24A434) - com.apple.CoreSimulator.SimRuntime.${runtime.replace(/[ .]/g, "-")}'`).join("; ");
  tool(
    "xcrun",
    `echo "$*" >> "$HOME/.fake-xcrun-log"
case "$1" in
  --find) echo /Applications/Xcode.app/Contents/Developer/usr/bin/swiftc ;;
  simctl) if [ "$3" = devicetypes ]; then echo '== Device Types =='; echo 'iPhone 18 Pro (com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro)'; echo 'iPhone 17 (com.apple.CoreSimulator.SimDeviceType.iPhone-17)'; else echo '== Runtimes =='; ${runtimes || ":"}; fi ;;
  swiftc) while [ $# -gt 0 ]; do [ "$1" = -o ] && out=$2; shift; done; printf '#!/bin/sh\\n%s\\n' '${hardware}' > "$out"; chmod +x "$out" ;;
esac`,
  );
  if (options.software) {
    mkdirSync(join(options.software, ".."), { recursive: true });
    writeFileSync(options.software, "#!/bin/sh\necho 'x264 0.165, source b35605ace3ddf7c1a5d67a2eb553f034aef41d55'\n");
    chmodSync(options.software, 0o755);
  }
}
