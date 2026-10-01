// A fake Mac for the Tart backend's tests: the fake tart and system tools in a fake ssh host's home, and an image there.

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseTartSettings, type TartConfig } from "../src/backends/tart/config.ts";

const GiB = 2 ** 30;
export const FAKE_MAC = "192.0.2.20";
export const FAKE_IMAGE = "bb-box-macos";

/**
 * Puts the fake tart, sysctl, sw_vers and uname in a fake Mac's
 * ~/.nix-profile/bin, where the host scripts look for tart before the PATH.
 * Not on the test's own PATH: on a Mac whose /bin/sh is zsh, /etc/zshenv may
 * reset it.
 */
export function fakeMacTools(home: string): void {
  const bin = join(home, ".nix-profile", "bin");
  mkdirSync(bin, { recursive: true });
  const script = new URL("./fake-tart.mjs", import.meta.url).pathname;
  for (const tool of ["tart", "sysctl", "sw_vers", "uname"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\nexec '${process.execPath}' '${script}' ${tool} "$@"\n`);
    chmodSync(join(bin, tool), 0o755);
  }
}

/** Puts a Tart VM in a fake Mac's home, as the setup guide leaves an image. */
export function addImage(home: string, name = FAKE_IMAGE, os = "darwin"): void {
  mkdirSync(join(home, ".tart", "vms", name), { recursive: true });
  writeFileSync(join(home, ".tart", "vms", name, "config.json"), JSON.stringify({ os, cpuCount: 4, memorySize: 8 * GiB }));
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
