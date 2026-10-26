import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BoxRecord } from "../src/core/boxes.ts";
import { DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, testDeviceOffer } from "../src/core/device.ts";
import { DEVICE_SERVER_FILES, connectScript, deviceServerDigest, deviceServerFiles, parseStatus } from "../src/core/device-delivery.ts";
import { DeviceLink } from "../src/core/device-link.ts";
import { DeviceServers, type DeviceServersDeps } from "../src/plugin/devices.ts";
import type { RunResult } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const PINNED = JSON.parse(readFileSync(new URL("./fixtures/device-server-version.json", import.meta.url), "utf8")) as { readonly version: number; readonly digest: string };

function importsOf(file: string, seen = new Set<string>()): Set<string> {
  if (seen.has(file)) return seen;
  seen.add(file);
  const text = readFileSync(join(ROOT, file), "utf8");
  for (const match of text.matchAll(/from "(\.\.?\/[^"]+)"/g)) importsOf(relative(ROOT, join(ROOT, dirname(file), match[1]!)), seen);
  return seen;
}

describe("the device server's files", () => {
  test("are what its entry imports, and every file of src/device", () => {
    const wanted = new Set([...importsOf("src/device/main.ts"), ...readdirSync(join(ROOT, "src/device")).map((name) => `src/device/${name}`)]);
    assert.deepEqual([...DEVICE_SERVER_FILES].sort(), [...wanted].sort());
  });

  test("change only with a new DEVICE_SERVER_VERSION", async () => {
    const digest = deviceServerDigest(await deviceServerFiles(ROOT));
    assert.equal(
      digest,
      PINNED.digest,
      `The device server's files changed. Raise DEVICE_SERVER_VERSION in src/core/device.ts above ${PINNED.version}, then put the new version and the digest ${digest} in test/fixtures/device-server-version.json.`,
    );
    assert.equal(DEVICE_SERVER_VERSION, PINNED.version, "test/fixtures/device-server-version.json names another version than src/core/device.ts.");
  });

  test("are under 400 KB to deliver", async () => {
    const bytes = (await deviceServerFiles(ROOT)).reduce((sum, file) => sum + file.data.byteLength, 0);
    assert.ok(bytes < 400_000, `${bytes} bytes`);
  });

  test("a status says which version runs and why it is down", () => {
    assert.deepEqual(parseStatus(5, "This box has no device server yet.\n", ""), { none: true, version: null, words: null });
    assert.deepEqual(parseStatus(0, "version 3\n", ""), { none: false, version: 3, words: null });
    assert.deepEqual(parseStatus(3, "version 3\nThe device server stopped 10 times in a minute.\n", ""), { none: false, version: 3, words: "The device server stopped 10 times in a minute." });
  });
});

const cleanups: (() => void)[] = [];
after(() => {
  for (const cleanup of cleanups) cleanup();
});

function serverRoot(version: number, change: (main: string) => string = (main) => main): string {
  const root = tempDir("device-root");
  for (const file of DEVICE_SERVER_FILES) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  const device = join(root, "src/core/device.ts");
  writeFileSync(device, readFileSync(device, "utf8").replace(/export const DEVICE_SERVER_VERSION = \d+;/, `export const DEVICE_SERVER_VERSION = ${version};`));
  const main = join(root, "src/device/main.ts");
  writeFileSync(main, change(readFileSync(main, "utf8")));
  return root;
}

function inBox(home: string) {
  const env = { ...process.env, HOME: home, BB_BOX_DEVICE_MANAGER: "supervisor" };
  cleanups.push(() => {
    for (const name of ["supervisor.pid", "server.pid"]) {
      const file = join(home, ".bb-box/device", name);
      if (existsSync(file)) {
        try {
          process.kill(Number(readFileSync(file, "utf8")), "SIGKILL");
        } catch {}
      }
    }
  });
  const run = (script: string, stdin?: string | Uint8Array) =>
    new Promise<RunResult>((resolve) => {
      const began = Date.now();
      const child = spawn("/bin/sh", ["-c", script], { env, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.on("close", (code) => resolve({ exitCode: code, stdout, stderr, timedOut: false, truncated: false, durationMs: Date.now() - began }));
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "");
    });
  const channel = (script: string) => {
    const child = spawn("/bin/sh", ["-c", script], { env, stdio: ["pipe", "pipe", "ignore"] });
    child.stdin.on("error", () => undefined);
    return { readable: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>, writable: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>, close: async () => void child.kill() };
  };
  return { run, channel };
}

describe("delivering the device server", { skip: process.platform === "win32" }, () => {
  const offer = testDeviceOffer("android");
  const box = { id: "bx-device", threadId: "t", name: "b-12", state: "ready", kind: "linux", capabilities: { device: offer, os: "linux" }, askedDevice: "Pixel Tablet" } as unknown as BoxRecord;
  const home = tempDir("device-home");
  const reach = inBox(home);
  const kv = new Map<string, unknown>();
  const logs: string[] = [];
  let record: BoxRecord = box;
  const make = (name: string, started: number, version: number, root: string, person: () => boolean = () => false, extra: Partial<DeviceServersDeps> = {}) =>
    new DeviceServers({
      boxes: {
        find: async () => record,
        all: async () => [record],
        update: async (_box, change) => (record = { ...record, ...change(record) }),
        spawnOwn: async (_box, script) => reach.channel(script),
        runOwn: (_box, script, options) => reach.run(script, options.stdin),
      },
      kv: { get: async (key) => kv.get(key) as never, set: async (key, value) => void kv.set(key, value), delete: async (key) => void kv.delete(key) },
      files: () => deviceServerFiles(root),
      personHasControl: person,
      log: (line) => logs.push(`${name}: ${line}`),
      logError: (operation, error) => logs.push(`${name}: ${operation}: ${error}`),
      started,
      instance: name,
      version,
      ...extra,
    });
  const runs = async () => (await DeviceLink.open(reach.channel(connectScript()), { role: "viewer" }).then(async (link) => (await link.close(), link.hello.version)));

  test("delivers to a box that has none, starting the model it was asked for, and copies it to the box record", async () => {
    const first = make("first", 1, 1, serverRoot(1));
    const view = await first.ensure(box);
    assert.equal(view.is, "connected");
    assert.equal(view.is === "connected" && view.state.model, "Pixel Tablet");
    assert.equal(record.device?.model, "Pixel Tablet");
    assert.equal(record.device?.runtime.platform, "android");
    assert.deepEqual(JSON.parse(readFileSync(join(home, ".bb-box/device/choices.json"), "utf8")), { slim: true }, "the box's choices go with the delivery");
    assert.ok(logs.some((line) => line === "first: Box b-12's device server: delivered version 1, as it has none yet."));
    await first.dispose();
  });

  test("during a reload, only the later instance delivers, once, and the earlier one is superseded", async () => {
    logs.length = 0;
    const earlier = make("earlier", 10, 1, serverRoot(1));
    const later = make("later", 20, 2, serverRoot(2));
    assert.equal((await earlier.ensure(box)).is, "connected");
    const [laterView] = await Promise.all([later.ensure(box), earlier.ensure(box)]);
    assert.equal(laterView.is === "connected" && laterView.version, 2);
    assert.equal(earlier.view(box.id).is, "superseded");
    assert.equal((await earlier.ensure(box)).is, "superseded");
    assert.equal(logs.filter((line) => line.includes("delivered version")).length, 1);
    assert.equal(await runs(), 2);
    await earlier.dispose();
    await later.dispose();
  });

  test("waits while a person holds control, and delivers at the hand-back", async () => {
    logs.length = 0;
    let person = true;
    const servers = make("held", 30, 3, serverRoot(3), () => person);
    const waiting = await servers.ensure(box);
    assert.deepEqual(waiting, { is: "waiting", version: 2, for: 3, why: "person" });
    assert.ok(logs.includes("held: Box b-12's device server waits for version 3 until the person hands back control."));
    assert.equal(await runs(), 2);
    person = false;
    servers.controlChanged(box.id);
    for (let tries = 0; servers.view(box.id).is !== "connected" && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(await runs(), 3);
    const told = () => readFileSync(join(home, ".bb-box/device/server.log"), "utf8").split("\n").filter((line) => /owner: (agent|person), generation \d+/.test(line));
    for (let tries = 0; !told().some((line) => line.includes("owner: agent")) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(told().some((line) => line.includes("owner: agent")), "the new server is told the agent has control");
    await servers.dispose();
  });

  test("goes back to the last version when a new one never says hello, and does not deliver it again", async () => {
    logs.length = 0;
    const silent = serverRoot(4, (main) => main.replace("  await server.start();", "  await new Promise(() => {});"));
    const servers = make("silent", 40, 4, silent, () => false, { helloWaitMs: 1500 });
    const view = await servers.ensure(box);
    assert.equal(view.is === "connected" && view.version, 3);
    assert.equal(await servers.badVersion(box.id), 4);
    assert.ok(logs.some((line) => line.includes("version 4 did not answer within 1.5 s twice, so the box went back to its last version, and version 4 is marked bad for it.")));
    await servers.dispose();
    const again = make("silent-again", 50, 4, silent, () => false, { helloWaitMs: 1500 });
    logs.length = 0;
    assert.equal((await again.ensure(box)).is, "connected");
    assert.equal(logs.filter((line) => line.includes("delivered")).length, 0);
    assert.equal(await runs(), 3);
    await again.dispose();
  });
  test("box_device's controls go by ID: done once, answered again by ID after a lost connection, and refused while a person has control but for an install (063, 6.3)", async () => {
    logs.length = 0;
    let person = false;
    const servers = make("controls", 60, 3, serverRoot(3), () => person);
    assert.equal((await servers.ensure(box)).is, "connected");
    const turned = await servers.control(box, { action: "rotate", turn: "left" }, { id: "turn-1" });
    assert.ok(turned.ok);
    assert.equal(turned.state.geometry?.physical, "turned-left");
    const again = await servers.control(box, { action: "rotate", turn: "left" }, { id: "turn-1" });
    assert.deepEqual(again, turned, "the same ID gets the first answer, and the device turns once");
    const answering = servers.control(box, { action: "rotate", turn: "left" }, { id: "turn-2" });
    await servers.forget(box.id);
    const lost = await answering;
    assert.ok(lost.ok, JSON.stringify(lost));
    assert.equal(lost.state.geometry?.physical, "upside-down", "turned once more, not twice");
    person = true;
    servers.controlChanged(box.id);
    const refused = await servers.control(box, { action: "home" });
    assert.deepEqual(!refused.ok && refused.error, { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS });
    const install = await servers.control(box, { action: "install", paths: ["/tmp/app.apk"] });
    assert.ok(install.ok, JSON.stringify(install));
    person = false;
    servers.controlChanged(box.id);
    await servers.dispose();
  });
});
