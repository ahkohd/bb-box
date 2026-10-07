// The VNC holder for a Tart macOS VM's run (#406), run with python3 against
// a fake Tart VNC server that, as Tart's does, ends on any second connection
// in its life, and on an update request before DesktopSize is set.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { VNC_BRIDGE_PY, VNC_HOLDER_PY } from "../src/backends/tart/vnc-holder.ts";
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

async function holder(t: TestContext, password = PASSWORD, native: "bgrx" | "rgbx" = "bgrx") {
  const tart = new FakeTart(PASSWORD, native);
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
  assert.equal(a.label, "whole 1; ");
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
  await tart.change();
  await Promise.all([b.update(), c.update()]);
  assert.deepEqual([b.label, c.label], ["change 2; ", "change 2; "]);
  b.close();
  c.close();
  assert.equal(tart.connections, 1, "one connection to Tart's VNC for the whole run");
  assert.equal(tart.crashed, false);
});

test("a late joiner gets the size, cursor and screen of the moment at once, and its Zlib decodes on its own", async (t) => {
  const { tart, socket } = await holder(t);
  const early = new Viewer(socket);
  await early.join();
  await early.update();
  early.ask();
  tart.resize = { width: 1280, height: 800 };
  await tart.change();
  await early.update();
  assert.deepEqual(early.size, { width: 1280, height: 800 }, "the watching viewer sees the resize");
  assert.equal(early.label, "whole 3; ", "with the whole screen, which the holder asks for again at its new size");
  await until("the holder's requests", () => tart.requests.length === 4);
  assert.deepEqual(tart.requests, [true, false, true, false]);

  // The screen is still, and Tart holds the holder's request for changes: the late joiner's screen comes at once all the same.
  const late = new Viewer(socket);
  await late.join();
  assert.deepEqual(late.size, { width: 1280, height: 800 }, "ServerInit has the size of the moment");
  await late.update();
  assert.ok(late.cursor, "the cursor shape, from before it joined");
  assert.equal(late.label, "whole 3; ", "its stream starts with the screen of the moment, and decodes on its own");
  early.ask();
  late.ask();
  await tart.change();
  await Promise.all([early.update(), late.update()]);
  assert.deepEqual([early.label, late.label], ["change 4; ", "change 4; "]);
  assert.equal(tart.crashed, false);
  early.close();
  late.close();
});

test("joiners on a still screen get it at once, however many come and go, and the holder asks Tart for nothing for them", async (t) => {
  const { tart, socket } = await holder(t);
  await until("the first whole screen", () => tart.tiles.length === 1);
  for (let round = 0; round < 6; round++) {
    const viewer = new Viewer(socket);
    const started = performance.now();
    await viewer.join();
    await viewer.update();
    assert.ok(performance.now() - started < 1_000, `joiner ${round + 1} had its screen in ${Math.round(performance.now() - started)} ms`);
    assert.equal(viewer.label, "whole 1; ");
    viewer.close();
  }
  assert.deepEqual(tart.requests, [true, false], "the sign-in's request for the whole screen, then one for changes, held all along");
  // A change reaches a viewer that joins after it, on the holder's screen.
  await tart.change();
  await until("the change", () => tart.tiles.length === 2);
  const after = new Viewer(socket);
  await after.join();
  await after.update();
  assert.equal(after.label, "change 2; ");
  after.close();
  assert.equal(tart.connections, 1);
});

test("a viewer gets an update only when it asks, with all it missed, so a slow one gets the screen as it is rather than a queue (056)", async (t) => {
  const { tart, socket } = await holder(t);
  const [fast, slow] = [new Viewer(socket), new Viewer(socket)];
  await Promise.all([fast.join(), slow.join()]);
  await Promise.all([fast.update(), slow.update()]);
  const before = slow.received;
  for (let change = 2; change <= 21; change++) {
    fast.ask();
    await tart.change();
    await fast.update();
    assert.equal(fast.label, `change ${change}; `, "a viewer that asks after each update gets each");
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(slow.received, before, "nothing for a viewer that has not asked");
  slow.ask();
  assert.deepEqual(await slow.update(), { rects: 2 }, "then one update, the label and the colours once each");
  assert.equal(slow.label, "change 21; ", "of the screen as it is");
  const after = slow.received;
  slow.ask();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(slow.received, after, "a request with nothing new waits for a change");
  await tart.change();
  await slow.update();
  assert.equal(slow.label, "change 22; ");
  fast.close();
  slow.close();
});

test("red, green and blue from Tart are red, green and blue at the viewer, in the screen, its updates, a CopyRect and the cursor, whichever order Tart's own pixels are in", async (t) => {
  const RED_GREEN_BLUE = [
    [255, 0, 0],
    [0, 255, 0],
    [0, 0, 255],
  ];
  // Tart's server sends its own format whatever a client asks, so each is tried: macOS's blue-first, and red-first.
  for (const native of ["bgrx", "rgbx"] as const) {
    const { tart, socket } = await holder(t, PASSWORD, native);
    const viewer = new Viewer(socket);
    await viewer.join();
    await viewer.update();
    assert.deepEqual(viewer.cursorColour, [200, 100, 50], `${native}: the cursor's colour`);
    assert.deepEqual(viewer.colours(), RED_GREEN_BLUE, `${native}: the whole screen's colours`);
    assert.equal(viewer.label, "whole 1; ", `${native}: and the label, red by red`);
    viewer.screen.fill(0);
    viewer.ask();
    tart.copy = { x: 20, y: 20 };
    await tart.change();
    await viewer.update();
    assert.deepEqual(viewer.colours(), RED_GREEN_BLUE, `${native}: an update's colours`);
    assert.deepEqual(viewer.colours(20, 20), RED_GREEN_BLUE, `${native}: a CopyRect's, which the holder draws`);
    // A joiner's screen too.
    const late = new Viewer(socket);
    await late.join();
    await late.update();
    assert.deepEqual([late.colours(), late.colours(20, 20)], [RED_GREEN_BLUE, RED_GREEN_BLUE], `${native}: a joiner's colours`);
    viewer.close();
    late.close();
    tart.end();
  }
});

test("the bridge carries a viewer's bytes both ways, and closes the holder's socket when the viewer's input ends", async (t) => {
  const path = join(tempDir("bridge"), "holder.vnc");
  let received = "";
  let ended = false;
  const server = createServer((connection) => {
    connection.on("data", (data) => (received += data));
    connection.on("end", () => (ended = true));
    connection.write("from the holder");
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  t.after(() => server.close());
  const bridge = spawn("python3", ["-c", VNC_BRIDGE_PY, path], { stdio: ["pipe", "pipe", "inherit"] });
  t.after(() => bridge.kill());
  const exited = new Promise<number | null>((resolve) => bridge.on("exit", resolve));
  let sent = "";
  bridge.stdout!.on("data", (data) => (sent += data));
  bridge.stdin!.write("from the viewer");
  await until("both ways", () => received === "from the viewer" && sent === "from the holder");
  // The viewer goes: its SSH session's stdin ends.
  bridge.stdin!.end();
  await until("the holder to see the viewer go", () => ended);
  assert.equal(await exited, 0);
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
  assert.equal(formats.length, 0, "the holder keeps the server's own format, and a viewer's stays with the holder");
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
