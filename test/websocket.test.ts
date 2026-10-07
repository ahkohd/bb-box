// The relay's WebSocket client on a box's channel (src/core/websocket.ts, 056).

import assert from "node:assert/strict";
import { test } from "node:test";
import { BoxWebSocket, WebSocketError, clientFrame } from "../src/core/websocket.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { FakeSelkies, serverFrames } from "./fake-selkies.ts";
import { until } from "./fake-rfb.ts";

const at = { host: "127.0.0.1:5980", path: "/api/websockets?role=viewer" };

test("it upgrades a channel, and carries text and binary both ways, whole", async () => {
  const server = new FakeSelkies();
  const socket = await BoxWebSocket.upgrade(server.channel(), at);
  assert.equal(await socket.next(), "MODE websockets");
  const page = server.pages[0]!;
  assert.equal(page.role, "viewer");
  await socket.send("SETTINGS,{}");
  await socket.send(Uint8Array.of(1, 2, 3));
  await until("both messages", () => page.received.length === 2);
  assert.deepEqual(page.received, ["SETTINGS,{}", Uint8Array.of(1, 2, 3)]);
  // A message in fragments, and lengths that need 16 and 64 bits.
  for (const frame of serverFrames(1, new TextEncoder().encode("clipboard,aGVsbG8="), 3)) await page.raw(frame);
  const middle = new Uint8Array(70_000).fill(7);
  const large = new Uint8Array(70_000 * 2);
  await page.send(middle);
  await page.raw(serverFrames(2, large)[0]!);
  assert.equal(await socket.next(), "clipboard,aGVsbG8=");
  assert.deepEqual(await socket.next(), middle);
  assert.equal(((await socket.next()) as Uint8Array).byteLength, large.byteLength);
  await socket.close();
  await until("the close", () => page.closed);
});

test("it answers the server's pings, and reports how the server closed", async () => {
  const server = new FakeSelkies();
  const socket = await BoxWebSocket.upgrade(server.channel(), at);
  await socket.next();
  const page = server.pages[0]!;
  await page.raw(serverFrames(9, new TextEncoder().encode("are you there"))[0]!);
  await page.send("after the ping");
  assert.equal(await socket.next(), "after the ping");
  await until("the pong", () => page.received.includes("pong:are you there"));
  await page.close(4029);
  assert.equal(await socket.next(), null);
  assert.equal(socket.closedWith?.code, 4029);
});

test("a server that refuses the upgrade, or answers it wrongly, fails it and closes the channel", async () => {
  for (const answer of ["HTTP/1.1 404 Not Found\r\n\r\n", "HTTP/1.1 101 Switching Protocols\r\nSec-WebSocket-Accept: wrong\r\n\r\n"]) {
    let closed = false;
    const fromServer = new TransformStream<Uint8Array, Uint8Array>();
    const channel: ByteChannel = {
      readable: fromServer.readable,
      writable: new WritableStream({
        write() {
          const writer = fromServer.writable.getWriter();
          void writer.write(new TextEncoder().encode(answer)).then(() => writer.releaseLock());
        },
      }),
      async close() {
        closed = true;
      },
    };
    await assert.rejects(BoxWebSocket.upgrade(channel, at), WebSocketError);
    assert.ok(closed, "the channel is closed");
  }
});

test("a message larger than the relay takes ends the connection with an error", async () => {
  const server = new FakeSelkies();
  const socket = await BoxWebSocket.upgrade(server.channel(), { ...at, maxMessageBytes: 1000 });
  await socket.next();
  await server.pages[0]!.send(new Uint8Array(1001));
  await assert.rejects(socket.next(), /larger than the relay takes/);
});

test("this side's frames are masked, with the length in 7, 16 or 64 bits", () => {
  const mask = Uint8Array.of(1, 2, 3, 4);
  const small = clientFrame(1, Uint8Array.of(0x61, 0x62), mask);
  assert.deepEqual([...small], [0x81, 0x82, 1, 2, 3, 4, 0x61 ^ 1, 0x62 ^ 2]);
  assert.equal(clientFrame(2, new Uint8Array(300), mask)[1], 0x80 | 126);
  assert.equal(clientFrame(2, new Uint8Array(70_000), mask)[1], 0x80 | 127);
});
