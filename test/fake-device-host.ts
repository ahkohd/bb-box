import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseHostSlot } from "../src/backends/tart/device-host.ts";
import { fakeMacos, type FakeMacos, type Run } from "./fake-macos.ts";

const IOS = fileURLToPath(new URL("../setup/tart/ios/", import.meta.url));
const POOL_HOME = fileURLToPath(new URL("../setup/ssh-pool/mac-home/", import.meta.url));
const MACOS_TOOLS = fileURLToPath(new URL("./fake-macos.sh", import.meta.url));
const DEVICE_TOOLS = fileURLToPath(new URL("./fake-device-host.sh", import.meta.url));
const DEVICE_TOOL_NAMES = ["sudo", "xcrun", "launchctl", "ps", "top", "pkill", "memory_pressure", "df", "taskpolicy"];
const DELEGATED = ["launchctl", "plutil", "pkill"];
export const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
export const LIST = "ios-27.0-24A434";

export interface DeviceSlot {
  readonly id: string;
  readonly user: string;
  readonly uid: number;
  readonly carried: boolean;
  readonly ports: number;
  readonly is: string;
  readonly step: string;
  readonly box: string;
  readonly for: string;
  readonly model: string;
  readonly udid: string;
  readonly booted: boolean;
  readonly loaded: boolean;
}

export interface FakeDeviceHost extends FakeMacos {
  run(args: readonly string[], input?: string): Run;
  machine(args: readonly string[], input?: string): Run;
  readonly env: Readonly<Record<string, string>>;
  readonly machineHelper: string;
  status(): { readonly values: Map<string, string>; readonly slots: readonly DeviceSlot[]; readonly lines: readonly string[] };
  slot(id: string): DeviceSlot | undefined;
  daemons(): string[];
  devices(user: string): Record<string, Record<string, string>>;
  until(what: string, check: () => boolean, ms?: number): Promise<void>;
}

function rewrite(from: string, to: string, root: string, bin: string): void {
  let text = readFileSync(from, "utf8");
  for (const [pattern, line] of [[/^ROOT=$/m, `ROOT='${root}'`], [/^PATH=.*$/m, `PATH=${bin}:/usr/bin:/bin`]] as const) {
    assert.equal(text.match(new RegExp(pattern.source, "gm"))?.length, 1, `${from} has one ${pattern.source} line`);
    text = text.replace(pattern, line);
  }
  writeFileSync(to, text, { mode: 0o755 });
}

export function parseSlot(line: string): DeviceSlot {
  const slot = parseHostSlot(line.slice("slot=".length).split("\t"));
  assert.ok(slot, `a slot line: ${line}`);
  return {
    id: slot.id, user: slot.user, uid: slot.uid, carried: slot.carried, ports: slot.portBase, is: slot.is, step: slot.step ?? "", box: slot.box ?? "",
    for: slot.madeFor ?? "", model: slot.model ?? "", udid: slot.udid ?? "", booted: slot.booted, loaded: slot.daemonsLoaded,
  };
}

export function fakeDeviceHost(options: { slim?: boolean; template?: boolean } = {}): FakeDeviceHost {
  const mac = fakeMacos({ template: false });
  const dir = dirname(mac.root);
  const bin = join(dir, "bin");
  const macosBin = join(dir, "macos-bin");
  mkdirSync(macosBin);
  for (const tool of DELEGATED) symlinkSync(MACOS_TOOLS, join(macosBin, tool));
  for (const tool of DEVICE_TOOL_NAMES) {
    rmSync(join(bin, tool), { force: true });
    symlinkSync(DEVICE_TOOLS, join(bin, tool));
  }
  const host = join(dir, "host");
  mkdirSync(host);
  const helper = join(host, "device-host");
  rewrite(join(IOS, "device-host.sh"), helper, mac.root, bin);
  const libexec = join(mac.data, "usr/local/libexec/bb-box");
  mkdirSync(libexec, { recursive: true });
  copyFileSync(helper, join(libexec, "device-host"));
  const machineHelper = join(dir, "pool", "machine-mac.sh");

  const share = join(mac.data, "usr/local/share/bb-box");
  mkdirSync(join(share, "ios"), { recursive: true });
  copyFileSync(join(IOS, "devices.tsv"), join(share, "ios/devices.tsv"));
  writeFileSync(join(share, "ios/runtimes.tsv"), `${RUNTIME}\t27.0\t24A434\t${LIST}\n`);
  if (options.slim !== false) writeFileSync(join(share, "ios", `${LIST}.disabled.plist`), "bplist00 the image's 124 disabled labels\n");
  if (options.template !== false) {
    mkdirSync(join(share, "slot-home"), { recursive: true });
    copyFileSync(join(POOL_HOME, ".zshenv"), join(share, "slot-home/.zshenv"));
  }
  mkdirSync(join(mac.data, "private/var/tmp"), { recursive: true });
  for (const path of ["daemons", "load", "commands"]) mkdirSync(join(mac.state, path), { recursive: true });
  mkdirSync(join(mac.state, "groups", "com.apple.access_ssh"), { recursive: true });

  const env = { FAKE_MAC_STATE: mac.state, FAKE_MAC_ROOT: mac.root, FAKE_MAC_BIN: bin, FAKE_MACOS_BIN: macosBin, PATH: `${bin}:/usr/bin:/bin`, LC_ALL: "C" };
  const run = (args: readonly string[], input = ""): Run => {
    const result = spawnSync("/bin/sh", [helper, ...args], { input, encoding: "utf8", env, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const status = () => {
    const result = run(["status"]);
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.split("\n").filter(Boolean);
    const values = new Map<string, string>();
    for (const line of lines) if (!line.startsWith("slot=")) values.set(line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1));
    return { values, slots: lines.filter((line) => line.startsWith("slot=")).map(parseSlot), lines };
  };
  const machine = (args: readonly string[], input = ""): Run => {
    const result = spawnSync("/bin/sh", [machineHelper, ...args], { input, encoding: "utf8", env, timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  return {
    ...mac,
    run,
    machine,
    env,
    machineHelper,
    status,
    slot: (id) => status().slots.find((slot) => slot.id === id),
    daemons: () => readdirSync(join(mac.state, "daemons")).sort(),
    devices(user) {
      const sims = join(mac.state, "sims", user);
      if (!existsSync(sims)) return {};
      return Object.fromEntries(
        readdirSync(sims)
          .filter((name) => !name.startsWith(".") && !name.endsWith(".pid"))
          .map((udid) => [udid, Object.fromEntries(readFileSync(join(sims, udid), "utf8").trim().split("\n").map((line) => line.split("=", 2) as [string, string]))]),
      );
    },
    async until(what, check, ms = 20_000) {
      const end = Date.now() + ms;
      while (!check()) {
        if (Date.now() > end) assert.fail(`${what} within ${ms} ms`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
}
