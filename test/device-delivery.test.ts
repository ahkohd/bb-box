import { EncoderLedgers } from "../src/core/encoder-ledger.ts";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { Readable, Writable } from "node:stream";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import type { BoxRecord } from "../src/core/boxes.ts";
import { DEVICE_SERVER_VERSION, PERSON_HAS_CONTROL_WORDS, testDeviceOffer } from "../src/core/device.ts";
import { DEVICE_SERVER_FILES, connectScript, deliveryStdin, deviceServerDigest, deviceServerFiles, parseStatus } from "../src/core/device-delivery.ts";
import { DeviceLink } from "../src/core/device-link.ts";
import { placementData } from "../src/core/device-host.ts";
import { DeviceServers, hostCheckWords, type DeviceServersDeps } from "../src/plugin/devices.ts";
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

  test("are under 512 KB to deliver, compressed", async () => {
    const files = await deviceServerFiles(ROOT);
    const sent = deliveryStdin({ version: DEVICE_SERVER_VERSION, files, offer: testDeviceOffer("android"), intent: null, choices: { slim: true } });
    assert.ok(sent.byteLength < 512_000, `${sent.byteLength} bytes`);
    const whole = files.reduce((sum, file) => sum + file.data.byteLength, 0);
    assert.ok(sent.byteLength < whole / 2, `${sent.byteLength} bytes compressed, of ${whole}`);
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

  test("caps a box in a slot at two thirds as soon as a delivery's new server says hello (064, unit 4)", async () => {
    logs.length = 0;
    const slot = { ...record, guest: { ref: "bb-box-host-1/i1", host: "mac1", address: null, size: null, data: { box: record.id, ...placementData({ on: "slot", host: "bb-box-host-1", hostOn: "tart", carried: true, generation: 1, place: 0, most: 8 }) } } } as BoxRecord;
    const capped = () => readFileSync(join(home, ".bb-box/device/server.log"), "utf8").split("\n").filter((line) => line.includes("video: capped at two-thirds")).length;
    const before = capped();
    const servers = make("slot", 70, 5, serverRoot(5));
    assert.equal((await servers.ensure(slot)).is, "connected");
    for (let tries = 0; capped() === before && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(logs.includes("slot: Box b-12's device server: delivered version 5, as it runs version 3."), logs.join("\n"));
    assert.ok(capped() > before, "the delivery's own connection caps the stream");
    await servers.dispose();
  });

  test("with the encoder ledger on, a slot's stream takes the ledger's cap and words, not two thirds (064, unit 6)", async () => {
    logs.length = 0;
    const slot = { ...record, guest: { ref: "bb-box-host-1/i1", host: "mac1", address: null, size: null, data: { box: record.id, ...placementData({ on: "slot", host: "bb-box-host-1", hostOn: "tart", carried: true, generation: 1, place: 0, most: 8 }) } } } as BoxRecord;
    record = slot;
    const serverLog = () => readFileSync(join(home, ".bb-box/device/server.log"), "utf8").split("\n");
    const before = serverLog().length;
    const sent: string[] = [];
    let on = true;
    const ledger = new EncoderLedgers({ on: () => on, controlled: () => false, send: (box) => sent.push(box), probe: async () => null, log: () => {}, logError: () => {} });
    const servers = make("ledger", 80, DEVICE_SERVER_VERSION, serverRoot(DEVICE_SERVER_VERSION), () => false, { ledger });
    assert.equal((await servers.ensure(slot)).is, "connected");
    const since = () => {
      const lines = serverLog().slice(before);
      return lines.slice(Math.max(0, lines.findIndex((line) => line.includes(`serving version ${DEVICE_SERVER_VERSION}`))));
    };
    for (let tries = 0; !since().some((line) => line.includes("video: capped at nothing")) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(since().some((line) => line.includes("video: capped at nothing")), since().join("\n"));
    assert.ok(!since().some((line) => line.includes("video: capped at two-thirds")), since().join("\n"));
    const words = "Shown at a lower resolution: this Mac's video encoder is busy with 1 other device (box ios-2).";
    servers.decided(slot.id, { cap: "third", words });
    for (let tries = 0; !since().some((line) => line.includes(`video: capped at third: ${words}`)) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(since().some((line) => line.includes(`video: capped at third: ${words}`)));
    on = false;
    servers.ledgerSwitched();
    for (let tries = 0; !since().some((line) => line.includes("video: capped at two-thirds")) && tries < 100; tries++) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(since().some((line) => line.includes("video: capped at two-thirds")), "off, a slot is capped at two thirds again");
    await servers.dispose();
    ledger.dispose();
    record = box;
  });

  test("the doctor says the device's state as its server gives it now, and what is not known when the server does not answer or bb-box closed its connection (F-8)", async () => {
    const check = async (servers: DeviceServers) => (await servers.checks()).find((each) => each.id === "device.b-12")!;
    const servers = make("doctor", 90, DEVICE_SERVER_VERSION, serverRoot(DEVICE_SERVER_VERSION), () => false, { deviceStateWaitMs: 1000 });
    assert.equal((await servers.ensure(box)).is, "connected");
    const answering = await check(servers);
    assert.match(answering.detail, new RegExp(`^Version ${DEVICE_SERVER_VERSION}, protocol \\d+: the Pixel Tablet, booted\\.`));

    const server = Number(readFileSync(join(home, ".bb-box/device/server.pid"), "utf8"));
    process.kill(server, "SIGSTOP");
    try {
      const silent = await check(servers);
      assert.equal(silent.status, "warn");
      assert.match(silent.detail, /: it did not answer within 1 s, so the device's state now is not known\. It last said the Pixel Tablet was booted, at \d{4}-\d\d-\d\d \d\d:\d\d:\d\d UTC\./);
      assert.equal(silent.fix, "box_status b-12 says whether the box runs.");
    } finally {
      process.kill(server, "SIGCONT");
    }
    await servers.dispose();

    const idle = make("doctor-idle", 100, DEVICE_SERVER_VERSION, serverRoot(DEVICE_SERVER_VERSION), () => false, { deviceStateWaitMs: 1000, idleCloseMs: 100 });
    assert.equal((await idle.ensure(box)).is, "connected");
    await new Promise((resolve) => setTimeout(resolve, 400));
    const closed = await check(idle);
    assert.equal(closed.status, "ok");
    assert.match(closed.detail, /: bb-box closed its connection at .* UTC, as nothing used it, so the device's state now is not known\. It last said the Pixel Tablet was booted/);
    await idle.dispose();
  });
});

test("the doctor looks for Device Hub in every ios box at once, each bounded, and says what it waited on for a box whose shared host does not answer (F-7)", async () => {
  const offer = { platform: "ios", devices: [{ model: "iPhone 18 Pro", native: "com.apple.CoreSimulator.SimDeviceType.iPhone-18-Pro", runtime: { platform: "ios", os: "27.0", build: "24A434", xcode: "27.0", companion: "1.7.7" } }] };
  const slot = (n: number) =>
    ({
      id: `bx-slot-${n}`,
      threadId: "t",
      name: `slot-box-${n}`,
      state: "ready",
      kind: "ios",
      capabilities: { device: offer, os: "macos" },
      guest: { ref: `bb-box-host-1/${n}`, host: "mac1", address: null, size: null, data: { box: `bx-slot-${n}`, ...placementData({ on: "slot", host: "bb-box-host-1", hostOn: "tart", carried: false, generation: n, place: n - 1, most: 8 }) } },
    }) as unknown as BoxRecord;
  const answering = { ...slot(9), id: "bx-own", name: "own-box", guest: null } as unknown as BoxRecord;
  const boxes = [slot(1), slot(2), slot(3), slot(4), answering];
  const servers = new DeviceServers({
    boxes: {
      find: async (id) => boxes.find((box) => box.id === id) ?? null,
      all: async () => boxes,
      update: async () => null,
      spawnOwn: async () => assert.fail("no device server is reached"),
      runOwn: (box) => (box.id === "bx-own" ? Promise.resolve({ exitCode: 0, stdout: "none\n", stderr: "", timedOut: false, truncated: false, durationMs: 1 }) : new Promise<RunResult>(() => {})),
    },
    kv: { get: async () => null, set: async () => {}, delete: async () => {} },
    files: async () => [],
    personHasControl: () => false,
    log: () => {},
    logError: () => {},
    deviceHubWaitMs: 1_000,
  });
  const began = Date.now();
  const checks = await servers.checks();
  assert.ok(Date.now() - began < 3_000, `${Date.now() - began} ms for 5 boxes, 4 not answering`);
  const hub = checks.filter((check) => check.id.startsWith("device-hub."));
  assert.equal(hub.length, 5);
  assert.deepEqual(hub.find((check) => check.id === "device-hub.own-box")?.status, "ok");
  assert.deepEqual(hub.find((check) => check.id === "device-hub.slot-box-2"), {
    id: "device-hub.slot-box-2",
    name: "Device Hub in slot-box-2",
    status: "skipped",
    detail: "bb-box could not look in box slot-box-2: it waited 1 s for box slot-box-2 to answer a command over SSH as its slot's user on the shared iOS host bb-box-host-1, and stopped waiting.",
    fix: null,
  });
  await servers.dispose();
});

test("a device server that does not answer points to the check of the box's own host: a shared Tart host's VM, or the pool Mac's iOS slots (F-8)", () => {
  const slotOn = (hostOn: "tart" | "pool-mac") =>
    ({ guest: { ref: "x", host: "mac1", address: null, size: null, data: { box: "bx", ...placementData({ on: "slot", host: "h", hostOn, carried: false, generation: 1, place: 0, most: 8 }) } } }) as unknown as BoxRecord;
  assert.equal(hostCheckWords(slotOn("tart")), " The check of shared iOS hosts says whether its host's VM runs.");
  assert.equal(hostCheckWords(slotOn("pool-mac")), " The iOS slots check of its Mac says how the Mac's slots are.");
  assert.equal(hostCheckWords({ guest: null } as unknown as BoxRecord), "");
});
