import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable, Writable } from "node:stream";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { testDeviceOffer } from "../src/core/device.ts";
import { DEVICE_SERVER_FILES, connectScript, deliveryScript, deliveryStdin, deviceServerFiles } from "../src/core/device-delivery.ts";
import { DeviceLink } from "../src/core/device-link.ts";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HELPER = readFileSync(join(ROOT, "setup/tart/ios/device-host.sh"), "utf8");
const DEVICE_SERVER_WAIT = /^DEVICE_SERVER_WAIT='(.*)'$/m.exec(HELPER)![1]!;
const children: ChildProcess[] = [];
after(() => {
  for (const child of children) if (child.pid) try { process.kill(-child.pid, "SIGKILL"); } catch {}
});

function serverRoot(version: number): string {
  const root = tempDir("device-root");
  for (const file of DEVICE_SERVER_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  const device = join(root, "src/core/device.ts");
  writeFileSync(device, readFileSync(device, "utf8").replace(/export const DEVICE_SERVER_VERSION = \d+;/, `export const DEVICE_SERVER_VERSION = ${version};`));
  return root;
}

function run(home: string, script: string, stdin: string | Uint8Array = ""): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", script], { env: { ...process.env, HOME: home } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
}

async function runningVersion(home: string): Promise<number | null> {
  const child = spawn("/bin/sh", ["-c", connectScript()], { env: { ...process.env, HOME: home }, stdio: ["pipe", "pipe", "ignore"] });
  const channel = { readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, close: async () => void child.kill() };
  try {
    const link = await DeviceLink.open(channel, { role: "viewer" });
    await link.close();
    return link.hello.version;
  } catch {
    child.kill();
    return null;
  }
}

async function deliver(home: string, version: number): Promise<void> {
  const files = await deviceServerFiles(serverRoot(version));
  const result = await run(home, deliveryScript(version), deliveryStdin({ version, files, offer: testDeviceOffer("ios"), intent: null, choices: { slim: true } }));
  assert.equal(result.code, 0, result.stderr);
}

test("a slot's device server runs under the host's daemon: delivered, it starts by itself, and a new version answers within 8 s", { skip: process.platform === "win32" }, async () => {
  const home = tempDir("slot-home");
  mkdirSync(join(home, ".bb-box/device"), { recursive: true });
  writeFileSync(join(home, ".bb-box/device/host-managed"), "1\n");
  const keepAlive = spawn("/bin/sh", ["-c", `while :; do /bin/sh -c '${DEVICE_SERVER_WAIT.replaceAll("'", `'\\''`)}'; sleep 1; done`], {
    env: { ...process.env, HOME: home },
    stdio: "ignore",
    detached: true,
  });
  children.push(keepAlive);

  await deliver(home, 41);
  let version: number | null = null;
  for (let i = 0; i < 100 && version !== 41; i++) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    version = await runningVersion(home);
  }
  assert.equal(version, 41, "the waiting daemon started the delivered server");
  assert.equal(readFileSync(join(home, ".bb-box/device/manager"), "utf8"), "host\n");

  const began = Date.now();
  await deliver(home, 42);
  for (version = null; version !== 42 && Date.now() - began < 10_000; ) version = await runningVersion(home);
  const tookMs = Date.now() - began;
  assert.equal(version, 42);
  assert.ok(tookMs < 8_000, `the new version answered in ${tookMs} ms, within 8 s`);

  const restart = await run(home, `sh "$HOME/.bb-box/device/current/src/device/bb-box-device.sh" restart; sh "$HOME/.bb-box/device/current/src/device/bb-box-device.sh" start`);
  assert.equal(restart.code, 0, restart.stderr);
  for (version = null; version !== 42; ) version = await runningVersion(home);
  const log = readFileSync(join(home, ".bb-box/device/server.log"), "utf8");
  assert.ok((log.match(/^bb-box-device: start .* by host$/gm)?.length ?? 0) >= 2, log);
  assert.doesNotMatch(log, / by (launchd|systemd|supervisor)$/m, "started by the host's daemon, never by launchctl, systemd or a supervisor");
});
