import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer as createHttpServer, type IncomingHttpHeaders, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createServer, type AddressInfo, type Server } from "node:net";
import { join } from "node:path";
import type { Duplex } from "node:stream";
import { after, test } from "node:test";
import { openRoute } from "../src/transports/route.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const servers: (Server | HttpServer)[] = [];
after(() => {
  for (const server of servers) server.close();
});

function listen<T extends Server | HttpServer>(server: T): Promise<number> {
  servers.push(server);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)));
}

/** Reads until `bytes` bytes have arrived. */
async function read(channel: ByteChannel, bytes: number): Promise<string> {
  const reader = channel.readable.getReader();
  let data = Buffer.alloc(0);
  try {
    while (data.length < bytes) {
      const { value, done } = await reader.read();
      if (done) break;
      data = Buffer.concat([data, value]);
    }
  } finally {
    reader.releaseLock();
  }
  return data.toString("utf8");
}

async function write(channel: ByteChannel, text: string): Promise<void> {
  const writer = channel.writable.getWriter();
  await writer.write(new TextEncoder().encode(text));
  writer.releaseLock();
}

test("a tcp route carries bytes both ways", async () => {
  const port = await listen(createServer((socket) => socket.pipe(socket)));
  const channel = await openRoute({ type: "tcp", host: "127.0.0.1", port });
  await write(channel, "hello over tcp");
  assert.equal(await read(channel, 14), "hello over tcp");
  await channel.close();
});

test("a tcp route that cannot connect says where, and nothing else", async () => {
  const server = createServer();
  const port = await listen(server);
  server.close();
  await assert.rejects(openRoute({ type: "tcp", host: "127.0.0.1", port }), new RegExp(`Cannot connect to 127.0.0.1:${port}`));
});

test("a command route carries bytes over stdin and stdout, and reports a failed command", async () => {
  const channel = await openRoute({ type: "command", argv: ["sh", "-c", "head -c 5"] });
  await write(channel, "hello world");
  assert.equal(await read(channel, 5), "hello");
  await channel.close();

  const failing = await openRoute({ type: "command", argv: ["sh", "-c", "echo 'channel 0: open failed' >&2; exit 3"] });
  await assert.rejects(read(failing, 1), /The route's sh exited with 3: channel 0: open failed/);
  await failing.close();
  await assert.rejects(openRoute({ type: "command", argv: ["/nonexistent/binary"] }), /Cannot run \/nonexistent\/binary/);
});

test("closing a command route ends its process", async () => {
  const channel = await openRoute({ type: "command", argv: ["sleep", "30"] });
  const started = Date.now();
  await channel.close();
  assert.ok(Date.now() - started < 5_000);
});

function frame(opcode: number, payload: Buffer): Buffer {
  if (payload.length < 126) return Buffer.concat([Buffer.from([0x80 | opcode, payload.length]), payload]);
  const header = Buffer.from([0x80 | opcode, 126, 0, 0]);
  header.writeUInt16BE(payload.length, 2);
  return Buffer.concat([header, payload]);
}

/** Echoes binary messages back, and records the handshake's headers. It takes the first subprotocol asked for. */
function echoWebSocket(server: HttpServer, seen: { headers?: IncomingHttpHeaders }): void {
  server.on("upgrade", (request, socket: Duplex) => {
    seen.headers = request.headers;
    const accept = createHash("sha1")
      .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    const protocol = request.headers["sec-websocket-protocol"]?.split(",")[0]?.trim();
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n` +
        `${protocol ? `Sec-WebSocket-Protocol: ${protocol}\r\n` : ""}\r\n`,
    );
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 2) return;
        const opcode = buffer[0]! & 0x0f;
        let length = buffer[1]! & 0x7f;
        let offset = 2;
        if (length === 126) {
          if (buffer.length < 4) return;
          length = buffer.readUInt16BE(2);
          offset = 4;
        }
        const mask = offset;
        offset += 4;
        if (buffer.length < offset + length) return;
        const payload = Buffer.from(buffer.subarray(offset, offset + length));
        for (let i = 0; i < payload.length; i++) payload[i]! ^= buffer[mask + (i % 4)]!;
        buffer = buffer.subarray(offset + length);
        if (opcode === 8) {
          socket.end(frame(8, payload.subarray(0, 2)));
          return;
        }
        socket.write(frame(2, payload));
      }
    });
  });
}

test("a websocket route sends its headers and subprotocols, and carries bytes both ways", async () => {
  const seen: { headers?: IncomingHttpHeaders } = {};
  const server = createHttpServer();
  echoWebSocket(server, seen);
  const port = await listen(server);
  const url = `ws://127.0.0.1:${port}/console`;
  const channel = await openRoute({ type: "websocket", url, headers: { Cookie: "ticket=abc" }, protocols: ["binary"] });
  await write(channel, "hello over a websocket");
  const echoed = await read(channel, 22);
  await channel.close();
  assert.equal(echoed, "hello over a websocket");
  assert.equal(seen.headers?.cookie, "ticket=abc");
  assert.equal(seen.headers?.["sec-websocket-protocol"], "binary");
});

const openssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

test("a websocket route pins a self-signed certificate by fingerprint", { skip: openssl ? false : "needs openssl" }, async () => {
  const dir = tempDir("cert");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", join(dir, "key"), "-out", join(dir, "cert"), "-days", "1", "-subj", "/CN=box"],
    { stdio: "ignore" },
  );
  const cert = readFileSync(join(dir, "cert"));
  const server = createHttpsServer({ key: readFileSync(join(dir, "key")), cert });
  echoWebSocket(server, {});
  const port = await listen(server);
  const url = `wss://127.0.0.1:${port}/console`;
  const fingerprint = new X509Certificate(cert).fingerprint256;

  const channel = await openRoute({ type: "websocket", url, fingerprint });
  await write(channel, "pinned");
  assert.equal(await read(channel, 6), "pinned");
  await channel.close();

  const other = fingerprint.replaceAll(":", "").toLowerCase().replace(/^./, (c) => (c === "0" ? "1" : "0"));
  await assert.rejects(openRoute({ type: "websocket", url, fingerprint: other }), /Cannot open the WebSocket to 127.0.0.1/);
  await assert.rejects(openRoute({ type: "websocket", url }), /Cannot open the WebSocket/);
});

test("a websocket route trusts a CA in place of the system roots", { skip: openssl ? false : "needs openssl" }, async () => {
  const dir = tempDir("ca");
  const certificate = (name: string) => {
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-days", "1", "-subj", "/CN=pve",
        "-addext", "subjectAltName=IP:127.0.0.1", "-keyout", join(dir, `${name}.key`), "-out", join(dir, `${name}.pem`),
      ],
      { stdio: "ignore" },
    );
    return { key: readFileSync(join(dir, `${name}.key`)), cert: readFileSync(join(dir, `${name}.pem`), "utf8") };
  };
  const served = certificate("served");
  const server = createHttpsServer(served);
  echoWebSocket(server, {});
  const url = `wss://127.0.0.1:${await listen(server)}/console`;

  const channel = await openRoute({ type: "websocket", url, ca: served.cert });
  await write(channel, "trusted");
  assert.equal(await read(channel, 7), "trusted");
  await channel.close();

  await assert.rejects(openRoute({ type: "websocket", url, ca: certificate("other").cert }), /Cannot open the WebSocket to 127.0.0.1/);
});
