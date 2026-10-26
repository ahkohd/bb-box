import { createReadStream, existsSync } from "node:fs";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect, createServer } from "node:net";
import { homedir } from "node:os";
import { extname, join } from "node:path";
import { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { DeviceControl, DeviceInput } from "../../../src/core/device.ts";
import { DeviceLink } from "../../../src/core/device-link.ts";
import { DEVICE_PATHS, SelkiesBox, SelkiesRelay, type OpenStream } from "../../../src/core/selkies.ts";
import { devicePaths } from "../../../src/device/paths.ts";
import { ServerWebSocket } from "../../../src/device/ws.ts";
import type { ByteChannel } from "../../../src/transports/types.ts";

const { values } = parseArgs({ options: { port: { type: "string", default: "8770" }, socket: { type: "string", default: "8771" } } });
const pagePort = Number(values.port);
const socketPort = Number(values.socket);
const deviceSocket = devicePaths(homedir()).socket;
const here = fileURLToPath(new URL(".", import.meta.url));
const pages = [here, join(here, "..", "web")];
const TYPES: Readonly<Record<string, string>> = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".json": "application/json" };

function channel(): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const socket = connect(deviceSocket);
    socket.once("error", reject);
    socket.once("connect", () => {
      const web = Duplex.toWeb(socket);
      resolve({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() });
    });
  });
}

const open: OpenStream = () => channel();
const relays = new Set<SelkiesRelay>();
const box = new SelkiesBox(open, { paths: DEVICE_PATHS, spacingMs: 0, apart: () => true, onText: (message) => relays.forEach((relay) => relay.fromBox(message)) });
let personHasControl = false;
let generation = 0;
const HARNESS_STARTED = Date.now();

async function openControl(): Promise<DeviceLink> {
  for (;;) {
    try {
      return await DeviceLink.open(await channel(), { role: "control", started: HARNESS_STARTED, instance: "harness", onClosed: () => void openControl().then((link) => (control = link)) });
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

let control = await openControl();

async function setOwner(holder: "agent" | "person") {
  generation = Math.max(generation + 1, Date.now());
  personHasControl = holder === "person";
  if (personHasControl) box.warm();
  return control.request({ type: "owner", generation, holder });
}

async function body(request: IncomingMessage): Promise<unknown> {
  const parts: Buffer[] = [];
  for await (const part of request) parts.push(part as Buffer);
  return parts.length ? JSON.parse(Buffer.concat(parts).toString("utf8")) : null;
}

function reply(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
}

createHttpServer(async (request, response) => {
  const url = new URL(request.url ?? "/", "http://harness");
  try {
    if (url.pathname === "/api/owner") {
      reply(response, 200, await setOwner(url.searchParams.get("holder") === "person" ? "person" : "agent"));
      return;
    }
    if (url.pathname === "/api/input") {
      const input = (await body(request)) as DeviceInput;
      const began = performance.now();
      const answer = await control.request({ type: "input", input, owner: Number(url.searchParams.get("owner") ?? generation) });
      reply(response, 200, { answer, ms: Math.round(performance.now() - began) });
      return;
    }
    if (url.pathname === "/api/control") {
      const began = performance.now();
      const answer = await control.request({ type: "control", control: (await body(request)) as DeviceControl }, { timeoutMs: 180_000 });
      reply(response, 200, { answer, ms: Math.round(performance.now() - began) });
      return;
    }
    if (url.pathname === "/api/state") {
      reply(response, 200, control.state);
      return;
    }
    const file = pages.map((dir) => join(dir, url.pathname.replace(/^\/+/, ""))).find((path) => !path.includes("..") && existsSync(path));
    if (!file) {
      reply(response, 404, { error: "no such file" });
      return;
    }
    response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  } catch (error) {
    reply(response, 500, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(pagePort, "127.0.0.1");

createServer(async (socket) => {
  const accepted = await ServerWebSocket.accept(socket);
  if (!accepted) return;
  const { ws } = accepted;
  const relay = new SelkiesRelay({
    viewer: { send: (message) => ws.send(message), close: (code, reason) => ws.close(code, reason) },
    box,
    open,
    mayInput: () => personHasControl,
    onEnd: () => relays.delete(relay),
  });
  relays.add(relay);
  ws.onMessage = (message) => void relay.receive(message);
  ws.onClose = () => void relay.close().catch(() => undefined);
}).listen(socketPort, "127.0.0.1");

process.stdout.write(`harness: pages on http://127.0.0.1:${pagePort}/device.html, viewers on ws://127.0.0.1:${socketPort}, control lease taken\n`);
