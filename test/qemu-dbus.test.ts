// bb-box-stream's qemu mode against a real QEMU's D-Bus display (#885): QEMU with no guest still shows a
// placeholder screen, which it shares as memory with the listener, as it shares a Windows VM's. A QEMU whose D-Bus
// display stops sharing, or changes its protocol, fails here. It runs where QEMU and swiftc are, as on the Macs that
// run Windows boxes, and is skipped elsewhere.

import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const SWIFT = fileURLToPath(new URL("../setup/ssh-pool/mac-stream.swift", import.meta.url));
const can =
  process.platform === "darwin" &&
  spawnSync("qemu-system-aarch64", ["--version"]).status === 0 &&
  spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

async function until(what: string, check: () => boolean, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

test("bb-box-stream's qemu mode maps QEMU's shared screen through its D-Bus display, and streams it as video (#885)", { skip: !can && "needs macOS, QEMU and swiftc", timeout: 240_000 }, async () => {
  // A short path of its own: Unix sockets have a short limit, and this test needs no other helper.
  const dir = mkdtempSync(join(tmpdir(), "bbbox-qd-"));
  after(() => rmSync(dir, { recursive: true, force: true }));
  const binary = join(dir, "bb-box-stream");
  const built = spawnSync("xcrun", ["swiftc", "-O", "-o", binary, SWIFT], { encoding: "utf8" });
  assert.equal(built.status, 0, built.stderr);
  const display = 100 + Math.floor(Math.random() * 400);
  const qmp = join(dir, "qmp");
  const children: ChildProcess[] = [];
  after(() => children.forEach((child) => child.kill()));
  const qemu = spawn("qemu-system-aarch64", ["-machine", "virt", "-display", "dbus,p2p=yes", "-device", "virtio-gpu-pci", "-vnc", `127.0.0.1:${display}`, "-qmp", `unix:${qmp},server=on,wait=off`], { stdio: "ignore" });
  children.push(qemu);
  await until("QEMU's QMP socket", () => existsSync(qmp));
  const socket = join(dir, "stream.sock");
  let log = "";
  const stream = spawn(binary, ["qemu", String(5900 + display), socket, qmp], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(stream);
  stream.stderr!.on("data", (data) => (log += data));
  // QEMU shares the screen: a ScanoutMap, whose file descriptor bb-box-stream maps.
  await until("the shared screen", () => /D-Bus: the desktop is \d+x\d+, shared/.test(log));
  assert.match(log, /serving QEMU's D-Bus display at /);
  const [, width, height] = /the desktop is (\d+)x(\d+), shared/.exec(log)!.map(Number);

  // A viewer, as the panel's video client is: an H.264 frame of the screen's size comes.
  const viewer = createConnection(socket);
  let got = Buffer.alloc(0);
  viewer.on("data", (data: Buffer) => (got = Buffer.concat([got, data])));
  await new Promise((resolve) => viewer.once("connect", resolve));
  viewer.write(`GET / HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await until("the upgrade", () => got.includes("\r\n\r\n"));
  const mask = randomBytes(4);
  const text = Buffer.from("START_VIDEO");
  viewer.write(Buffer.concat([Buffer.from([0x81, 0x80 | text.length]), mask, Buffer.from(text.map((byte, i) => byte ^ mask[i % 4]!))]));
  // WebSocket frames after the upgrade: the first binary one that is VIDEO (4).
  const frameOf = (): { width: number; height: number; key: boolean } | null => {
    let at = got.indexOf("\r\n\r\n") + 4;
    while (at + 2 <= got.length) {
      const opcode = got[at]! & 15;
      let length = got[at + 1]! & 127;
      let head = 2;
      if (length === 126) [length, head] = [got.readUInt16BE(at + 2), 4];
      else if (length === 127) [length, head] = [Number(got.readBigUInt64BE(at + 2)), 10];
      if (at + head + length > got.length) return null;
      const payload = got.subarray(at + head, at + head + length);
      if (opcode === 2 && payload[0] === 4) return { width: payload.readUInt16BE(6), height: payload.readUInt16BE(8), key: (payload[1]! & 1) === 1 };
      at += head + length;
    }
    return null;
  };
  await until("a video frame", () => frameOf() !== null);
  assert.deepEqual(frameOf(), { width, height, key: true }, "a key frame of the shared screen");
  viewer.destroy();
  assert.ok(existsSync(socket) && readFileSync(binary).length > 0);
});
