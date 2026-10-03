// The VNC holder for a Tart macOS VM's run (#406), run with python3 against
// a fake Tart VNC server that, as Tart's does, ends on any second connection
// in its life, and on an update request before DesktopSize is set.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VNC_HOLDER_PY } from "../src/backends/tart/vnc-holder.ts";
import { FakeTart, Viewer, u16, u32 } from "./fake-tart-vnc.ts";
import { tempDir } from "./helpers.ts";

const PASSWORD = "rough-otter-blue-kite";

async function until(what: string, check: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function holder(t: TestContext, password = PASSWORD) {
  const tart = new FakeTart(PASSWORD);
  const port = await tart.listen();
  t.after(() => tart.server.close());
  const dir = tempDir("holder");
  const output = join(dir, "vm.out");
  writeFileSync(output, `VNC server is running at vnc://:old-run@127.0.0.1:1\nVNC server is running at vnc://:${password}@127.0.0.1:${port}\n`);
  writeFileSync(join(dir, "holder.py"), VNC_HOLDER_PY);
  const socket = join(dir, "vm.vnc");
  const status = join(dir, "status");
  const child: ChildProcess = spawn("python3", [join(dir, "holder.py"), output, socket, status], { stdio: ["ignore", "ignore", "pipe"] });
  let errors = "";
  child.stderr!.on("data", (d) => (errors += d));
  const exited = new Promise<number | null>((resolve) => child.on("exit", resolve));
  t.after(() => child.kill());
  const read = () => (existsSync(status) ? readFileSync(status, "utf8").trim() : "");
  await until("the holder's status", () => read() !== "");
  return { tart, socket, status: read, exited, errors: () => errors };
}

test("viewers join, leave, come back and watch two at once over the run's one connection, which never crashes Tart", async (t) => {
  const { tart, socket, status } = await holder(t);
  assert.equal(status(), "ready 1024x768");
  assert.equal(tart.connections, 1);
  const first = tart.received.findIndex((message) => message[0] === 3);
  assert.ok(first === -1 || tart.received.slice(0, first).some((message) => message[0] === 2), "DesktopSize is set before any update request");

  const a = new Viewer(socket);
  await a.join();
  assert.deepEqual(a.size, { width: 1024, height: 768 });
  await a.update();
  assert.ok(a.cursor, "the cursor shape");
  a.close();

  for (let round = 0; round < 5; round++) {
    const viewer = new Viewer(socket);
    await viewer.join();
    await viewer.update();
    viewer.close();
  }
  const [b, c] = [new Viewer(socket), new Viewer(socket)];
  await Promise.all([b.join(), c.join()]);
  await Promise.all([b.update(), c.update()]);
  b.ask();
  c.ask();
  await Promise.all([b.update(), c.update()]);
  b.close();
  c.close();
  assert.equal(tart.connections, 1, "one connection to Tart's VNC for the whole run");
  assert.equal(tart.crashed, false);
});

test("a late joiner gets the size and cursor of the moment and a whole screen, and its ZRLE decodes on its own", async (t) => {
  const { tart, socket } = await holder(t);
  const early = new Viewer(socket);
  await early.join();
  await early.update();
  tart.resize = { width: 1280, height: 800 };
  await tart.change();
  await early.update();
  assert.deepEqual(early.size, { width: 1280, height: 800 }, "the watching viewer sees the resize");

  // The screen is still: the late joiner's whole screen comes at once all the same.
  const late = new Viewer(socket);
  await late.join();
  assert.deepEqual(late.size, { width: 1280, height: 800 }, "ServerInit has the size of the moment");
  await late.update();
  assert.ok(late.cursor, "the cursor shape, from before it joined");
  await late.update();
  assert.match(late.tiles.toString(), /^whole 3; /, "its stream starts with the whole screen, and decodes on its own");
  await early.update();
  await tart.change();
  await Promise.all([early.update(), late.update()]);
  const sent = tart.tiles.map((tile) => tile.toString());
  assert.equal(early.tiles.toString(), sent.join(""), "the early viewer has every tile");
  assert.equal(late.tiles.toString(), sent.slice(2).join(""), "the late joiner every tile since it joined");
  assert.equal(tart.crashed, false);
  early.close();
  late.close();
});

test("a viewer's input reaches Tart byte for byte; its format, encodings and resizes stay with the holder", async (t) => {
  const { tart, socket } = await holder(t);
  const viewer = new Viewer(socket);
  await viewer.join();
  await viewer.update();
  const key = Buffer.from([4, 1, 0, 0, 0, 0, 0, 0x61]);
  const pointer = Buffer.from([5, 1, 0, 10, 0, 20]);
  const cut = Buffer.concat([Buffer.from([6, 0, 0, 0]), u32(5), Buffer.from("hello")]);
  const resize = Buffer.concat([Buffer.from([251, 0]), u16(800), u16(600), Buffer.from([1, 0]), Buffer.alloc(16)]);
  viewer.socket.write(Buffer.concat([key, pointer, resize, cut]));
  await until("the input", () => tart.received.some((message) => message[0] === 6));
  const input = tart.received.filter((message) => [4, 5, 6, 251].includes(message[0]!));
  assert.deepEqual(input.map((message) => message.toString("hex")), [key, pointer, cut].map((message) => message.toString("hex")));
  const formats = tart.received.filter((message) => message[0] === 0);
  assert.equal(formats.length, 1, "only the holder's own SetPixelFormat");
  assert.equal(tart.received.filter((message) => message[0] === 2).length, 1, "only the holder's own SetEncodings");
  viewer.close();
});

test("when the run's connection ends, the holder ends, removes its socket and never connects again", async (t) => {
  const { tart, socket, status, exited } = await holder(t);
  const viewer = new Viewer(socket);
  await viewer.join();
  await viewer.update();
  tart.end();
  assert.equal(await exited, 0);
  assert.match(status(), /^ended Tart's VNC server closed the connection/);
  assert.equal(existsSync(socket), false);
  await until("the viewer's connection to end", () => viewer.socket.destroyed || viewer.socket.readableEnded);
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(tart.connections, 1, "no second connection, which would crash Tart");
});

test("a wrong password ends the holder with the server's reason, before any socket is made", async (t) => {
  const { socket, status, exited } = await holder(t, "not-the-password");
  assert.match(status(), /^ended Tart's VNC server refused the password: wrong password$/);
  assert.equal(await exited, 0);
  assert.equal(existsSync(socket), false);
});
