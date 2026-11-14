import "./check-test-machine.mjs";
// The Docker API relay's channels (src/relay/mux.ts, 042).

import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import { FRAME_BYTES, INITIAL_WINDOW, Mux, type Channel, type Link } from "../src/relay/mux.ts";

/** Two muxes joined by an in-memory link that delivers each frame on a later turn, and counts them. */
function pair(options: { pingMs?: number; deadMs?: number; drop?: () => boolean } = {}) {
  const frames: { from: "a" | "b"; type: number; size: number }[] = [];
  let a!: Mux;
  let b!: Mux;
  const link = (from: "a" | "b", to: () => Mux): Link => ({
    send: (data) => {
      frames.push({ from, type: data[0]!, size: data.length - 5 });
      if (options.drop?.()) return;
      const copy = Uint8Array.from(data);
      setImmediate(() => to().receive(copy));
    },
    // A silent link carries no close either, so each side finds it dead on its own.
    close: () => {
      if (options.drop?.()) return;
      setImmediate(() => to().close("the other side closed"));
    },
  });
  const opened: Channel[] = [];
  a = new Mux(link("a", () => b), { opener: true, pingMs: options.pingMs, deadMs: options.deadMs });
  b = new Mux(link("b", () => a), { opener: false, onOpen: (channel) => opened.push(channel), pingMs: options.pingMs, deadMs: options.deadMs });
  return { a, b, frames, opened, accepted: async () => { while (!opened.length) await new Promise((r) => setImmediate(r)); return opened.shift()!; } };
}

/** Everything a channel reads until its other side ends. Not for await, which would destroy the channel's write side too. */
function readAll(channel: Channel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    channel.on("data", (part: Buffer) => parts.push(part));
    channel.once("end", () => resolve(Buffer.concat(parts)));
    channel.once("error", reject);
  });
}

/** Errors a test expects on the channels it does not watch. */
const quiet = (...channels: Channel[]) => channels.forEach((channel) => channel.on("error", () => {}));

test("a channel carries bytes both ways, and each direction ends on its own", async (t) => {
  const { a, b, accepted } = pair();
  t.after(() => (a.close("done"), b.close("done")));
  const client = a.open();
  const server = await accepted();
  // The client ends its input first, as docker exec does, and still reads the reply.
  client.end("hello");
  assert.equal((await readAll(server)).toString(), "hello");
  server.end("world");
  assert.equal((await readAll(client)).toString(), "world");
  await new Promise((r) => setImmediate(r));
  assert.equal(a.channels + b.channels, 0, "both ends forget a channel that ended both ways");
});

test("a sender never has more than the window in flight to a slow reader, and frames stay within 64 KiB", async (t) => {
  const { a, b, frames, accepted } = pair();
  t.after(() => (a.close("done"), b.close("done")));
  const client = a.open();
  const server = await accepted();
  quiet(client, server);
  const total = 5 * 1024 * 1024;
  const sent = Buffer.alloc(total);
  for (let i = 0; i < total; i++) sent[i] = i % 251;
  const writing = new Promise<void>((resolve) => client.end(sent, resolve));
  // The reader takes nothing for a while: the sender stops at the window.
  await new Promise((r) => setTimeout(r, 50));
  const early = frames.filter((f) => f.from === "a" && f.type === 2).reduce((sum, f) => sum + f.size, 0);
  assert.equal(early, INITIAL_WINDOW, "exactly the window, then it waits for credit");
  const received = await readAll(server);
  await writing;
  assert.ok(received.equals(sent), "every byte, in order");
  assert.ok(Math.max(...frames.filter((f) => f.type === 2).map((f) => f.size)) <= FRAME_BYTES);
});

test("a reset reaches the other side with its reason, and a sender that overruns its credit is reset", async (t) => {
  const { a, b, accepted } = pair();
  t.after(() => (a.close("done"), b.close("done")));
  const client = a.open();
  const server = await accepted();
  quiet(server);
  const failed = once(client, "error");
  server.destroy(new Error("Docker refused the connection"));
  const [error] = await failed;
  assert.match((error as Error).message, /Docker refused the connection/);

  // A side that sends past its credit, as a broken peer would.
  const other = a.open();
  const victim = await accepted();
  quiet(other);
  const reset = once(victim, "error");
  const data = new Uint8Array(5 + INITIAL_WINDOW + 1);
  data[0] = 2;
  new DataView(data.buffer).setUint32(1, other.id);
  b.receive(data);
  assert.match(((await reset)[0] as Error).message, /more than it was granted/);
});

test("a link that goes quiet is closed, and its channels end with the reason", async () => {
  let silent = false;
  const { a, b, accepted } = pair({ pingMs: 20, deadMs: 400, drop: () => silent });
  const client = a.open();
  // Listening at once: under load the link could go quiet before the channel is accepted.
  const ended = once(client, "error");
  quiet(await accepted());
  silent = true;
  const [error] = await ended;
  assert.match((error as Error).message, /The relay closed: nothing came over the relay for 0 s/);
  assert.ok(a.closed);
  b.close("done");
});

test("a side with no onOpen refuses channels the other side opens", async (t) => {
  const { a, b } = pair();
  t.after(() => (a.close("done"), b.close("done")));
  const reversed = b.open();
  const [error] = await once(reversed, "error");
  assert.match((error as Error).message, /opens no channels/);
});

// The two ends together: the server's hub (src/relay/hub.ts) and the machine's
// worker (src/host/relay.ts), joined by a WebSocket stand-in, with a unix
// socket server for Docker.

import { createServer as createHttpServer, request } from "node:http";
import { connect, createServer, type Server } from "node:net";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { experimental_createHostEntryHarness } from "@get-bb/plugin-sdk/testing/host";
import { hostEntry } from "../src/host/entry.ts";
import { endpointOf, refusal } from "../src/host/relay.ts";
import { REOPEN_MS, RELAY_ROUTE, RelayHub } from "../src/relay/hub.ts";
import { FILE_ROUTE, FileRelay } from "../src/relay/files.ts";
import { joined, tempDir } from "./helpers.ts";

function fakeDocker(path: string): Promise<Server> {
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (part) => (body += part));
    req.on("end", () => res.end(JSON.stringify({ path: req.url, method: req.method, got: body.length })));
  });
  return new Promise((resolve) => server.listen(path, () => resolve(server)));
}

function get(socketPath: string, path: string, body = ""): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, path, method: body ? "POST" : "GET", agent: false }, (res) => {
      let text = "";
      res.on("data", (part) => (text += part));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the docker CLI's connections reach Docker on the machine through the relay, and the relay opens once, with a secret used once", async (t) => {
  const dir = tempDir("relay");
  const docker = await fakeDocker(join(dir, "docker.sock"));
  t.after(() => docker.close());
  const saved = process.env.BB_SERVER_URL;
  process.env.BB_SERVER_URL = "https://bb.example.com/";
  t.after(() => (saved === undefined ? delete process.env.BB_SERVER_URL : (process.env.BB_SERVER_URL = saved)));

  let hub!: RelayHub;
  const { urls, connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: join(dir, "docker.sock") }) } }));
  t.after(() => worker.experimental_dispose());
  const calls: string[] = [];
  hub = new RelayHub({
    dir: tempDir("relay-hub"),
    open: async (hostId, secret) => {
      calls.push(hostId);
      return worker.experimental_call("relay", { secret, path: `/api/v1/plugins/bb-box/http${RELAY_ROUTE}` });
    },
    keep: async () => false,
    logError: () => {},
  });
  t.after(() => hub.dispose());

  // A new instance's relay is coming back until it opens, as after an update, but not for ever (#415).
  assert.equal(hub.reopening("host_abc"), true);
  assert.equal(hub.reopening("host_abc", Date.now() + REOPEN_MS + 1), false);
  const endpoint = await hub.endpoint("host_abc");
  assert.match(endpoint, /^unix:\/\/.+\/host_abc\.sock$/);
  const socketPath = endpoint.slice("unix://".length);
  const [one, two] = await Promise.all([get(socketPath, "/v1.47/version"), get(socketPath, "/containers/create", "x".repeat(300_000))]);
  assert.deepEqual(JSON.parse(one.text), { path: "/v1.47/version", method: "GET", got: 0 });
  assert.deepEqual(JSON.parse(two.text), { path: "/containers/create", method: "POST", got: 300_000 });
  assert.deepEqual(calls, ["host_abc"], "one relay serves every connection");
  assert.equal(hub.reopening("host_abc"), false, "open");
  assert.match(urls[0]!, /^wss:\/\/bb\.example\.com\/api\/v1\/plugins\/bb-box\/http\/docker-relay\?s=[0-9a-f]{32}$/);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1, "the worker holds a lease while the relay is open");

  // The same secret again is refused.
  let refused = "";
  hub.route(new URL(urls[0]!.replace(/^ws/, "http"))).onOpen({ send: () => {}, close: (_code, reason) => (refused = reason ?? "") });
  assert.match(refused, /unknown or used/);
});

function hijackHeaders(form: "101" | "200"): string {
  return form === "101"
    ? "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n"
    : "HTTP/1.1 200 OK\r\nContent-Type: application/vnd.docker.raw-stream\r\n\r\n";
}

function hijackingDocker(listen: string | { host: string }, form: "101" | "200"): Promise<{ server: Server; dockerClosed: () => boolean }> {
  let dockerClosed = false;
  const server = createServer({ allowHalfOpen: true }, (socket) => {
    let request = Buffer.alloc(0);
    let upgraded = false;
    socket.on("data", (chunk) => {
      request = Buffer.concat([request, chunk]);
      if (upgraded || !request.includes(Buffer.from("\r\n\r\n"))) return;
      upgraded = true;
      socket.write(hijackHeaders(form));
    });
    socket.on("end", () => {
      assert.equal(socket.destroyed, false, "a client half-close leaves Docker's socket up");
      assert.equal(socket.writableEnded, false, "a client half-close does not end Docker's write side");
      setTimeout(() => {
        assert.equal(socket.destroyed || socket.writableEnded, false, "Docker can still write the stream after the client's half-close");
        socket.end("hijacked-output");
      }, 30);
    });
    socket.on("close", () => (dockerClosed = true));
  });
  return new Promise((resolve) => {
    const ready = () => resolve({ server, dockerClosed: () => dockerClosed });
    if (typeof listen === "string") server.listen(listen, ready);
    else server.listen(0, listen.host, ready);
  });
}

test("an attached run returns its output after the client half-closes, for a unix socket and a TCP port, in both hijack forms", async (t) => {
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  const forms = ["101", "200"] as const;
  const targets = ["unix", "tcp"] as const;
  for (const target of targets) {
    for (const form of forms) {
      const dir = tempDir(`relay-attach-${target}-${form}`);
      const docker = await hijackingDocker(target === "unix" ? join(dir, "docker.sock") : { host: "127.0.0.1" }, form);
      t.after(() => docker.server.close());
      const endpoint = target === "unix" ? { path: join(dir, "docker.sock") } : { host: "127.0.0.1", port: (docker.server.address() as { port: number }).port };
      let hub!: RelayHub;
      const { connectTo } = joined(() => hub);
      const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => endpoint } }));
      t.after(() => worker.experimental_dispose());
      hub = new RelayHub({
        dir: tempDir("relay-hub"),
        open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }),
        keep: async () => false,
        logError: () => {},
      });
      t.after(() => hub.dispose());
      const socketPath = (await hub.endpoint(`host_${target}_${form}`)).slice("unix://".length);
      const reply = await new Promise<{ text: string; ended: boolean; closed: boolean }>((resolve, reject) => {
        const socket = connect({ path: socketPath, allowHalfOpen: true });
        let text = "";
        let ended = false;
        const finish = (closed: boolean) => resolve({ text, ended, closed });
        socket.on("data", (part) => (text += part));
        socket.on("end", () => (ended = true));
        socket.on("close", () => finish(true));
        socket.on("error", reject);
        socket.write(`POST /containers/abc/attach?stdout=1 HTTP/1.1\r\nHost: docker\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n`);
        const waitForHeaders = () => {
          if (!text.includes("\r\n\r\n")) return void setTimeout(waitForHeaders, 5);
          socket.end();
        };
        waitForHeaders();
        setTimeout(() => finish(false), 2_000);
      });
      assert.equal(reply.ended, true, `${target} ${form}: the client is told the stream ended`);
      assert.equal(reply.closed, true, `${target} ${form}: both directions of the client's socket close`);
      assert.ok(reply.text.startsWith(hijackHeaders(form)), `${target} ${form}: the hijack headers arrive`);
      assert.ok(reply.text.endsWith("hijacked-output"), `${target} ${form}: the output follows the half-close`);
      for (let i = 0; i < 50 && !docker.dockerClosed(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.equal(docker.dockerClosed(), true, `${target} ${form}: Docker's socket closes after the stream`);
    }
  }
});

test("a connection whose input ends first still gets its output, as docker exec needs", async (t) => {
  const dir = tempDir("relay-half");
  // Docker's side: reads all of the input, then answers and ends.
  const docker = createServer({ allowHalfOpen: true }, (socket) => {
    let got = 0;
    socket.on("data", (part) => (got += part.length));
    socket.on("end", () => socket.end(`read ${got}`));
  });
  await new Promise<void>((resolve) => docker.listen(join(dir, "docker.sock"), () => resolve()));
  t.after(() => docker.close());
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: join(dir, "docker.sock") }) } }));
  t.after(() => worker.experimental_dispose());
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {} });
  t.after(() => hub.dispose());
  const path = (await hub.endpoint("host_half")).slice("unix://".length);
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect({ path, allowHalfOpen: true });
    let text = "";
    socket.on("data", (part) => (text += part));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.end(Buffer.alloc(2 * 1024 * 1024, 1));
  });
  assert.equal(reply, `read ${2 * 1024 * 1024}`);
});

test("a machine the relay cannot reach answers the docker CLI with the reason, and an idle relay closes when BB Box has no box there", async (t) => {
  const failing = new RelayHub({ dir: tempDir("relay-fail"), open: async () => Promise.reject(new Error("Host is not connected")), keep: async () => false, logError: () => {} });
  t.after(() => failing.dispose());
  const path = (await failing.endpoint("host_off")).slice("unix://".length);
  const answer = await get(path, "/_ping");
  assert.equal(answer.status, 503);
  assert.equal(answer.text, "bb-box could not reach Docker on the BB machine: Host is not connected");

  const silent = new RelayHub({ dir: tempDir("relay-silent"), open: async () => {}, keep: async () => false, logError: () => {}, acceptMs: 100 });
  t.after(() => silent.dispose());
  const late = await get((await silent.endpoint("host_late")).slice("unix://".length), "/_ping");
  assert.match(late.text, /the machine's worker did not connect to bb-box within 0 s/);

  // An idle relay closes, so the worker's lease goes.
  const dir = tempDir("relay-idle");
  const docker = await fakeDocker(join(dir, "docker.sock"));
  t.after(() => docker.close());
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: join(dir, "docker.sock") }) } }));
  t.after(() => worker.experimental_dispose());
  const logs: string[] = [];
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {}, log: (line) => logs.push(line), idleMs: 50 });
  t.after(() => hub.dispose());
  await get((await hub.endpoint("host_idle")).slice("unix://".length), "/_ping");
  for (let i = 0; i < 100 && worker.experimental_getRetainedWorkerLeaseCount(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
  assert.ok(logs.some((line) => /closed: no box or connection used it for a while/.test(line)), logs.join("\n"));
});

test("Docker the machine cannot reach answers the docker CLI with the machine's reason, not EOF, and the hub logs it", async (t) => {
  const missing = join(tempDir("relay-reset"), "docker.sock");
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: missing }) } }));
  t.after(() => worker.experimental_dispose());
  const logs: string[] = [];
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {}, log: (line) => logs.push(line) });
  t.after(() => hub.dispose());
  const answer = await get((await hub.endpoint("host_nodocker")).slice("unix://".length), "/_ping");
  const reason = `Docker at ${missing}: connect ENOENT ${missing}`;
  assert.deepEqual([answer.status, answer.text], [503, `bb-box could not reach Docker on the BB machine: ${reason}`]);
  assert.ok(logs.includes(`Docker on BB machine host_nodocker did not answer: ${reason}`), logs.join("\n"));
});

test("a worker socket that opens after BB Box stopped waiting is closed, so no relay keeps the worker's lease", async (t) => {
  const dir = tempDir("relay-late");
  const docker = await fakeDocker(join(dir, "docker.sock"));
  t.after(() => docker.close());
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let hub!: RelayHub;
  // It upgrades at once, which takes its secret, and opens after the accept timer.
  const { connectTo } = joined(() => hub, { openAfterMs: 150 });
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: join(dir, "docker.sock") }) } }));
  t.after(() => worker.experimental_dispose());
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {}, acceptMs: 50, pingMs: 10 });
  t.after(() => hub.dispose());
  const late = await get((await hub.endpoint("host_late_open")).slice("unix://".length), "/_ping");
  assert.match(late.text, /the machine's worker did not connect to bb-box within 0 s/);
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 1, "the worker waits for its socket to open");
  for (let i = 0; i < 100 && worker.experimental_getRetainedWorkerLeaseCount(); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(worker.experimental_getRetainedWorkerLeaseCount(), 0);
});

test("the worker finds Docker as the docker CLI would", () => {
  assert.deepEqual(endpointOf("unix:///var/run/docker.sock"), { path: "/var/run/docker.sock" });
  assert.deepEqual(endpointOf("npipe:////./pipe/docker_engine"), { path: "\\\\.\\pipe\\docker_engine" });
  assert.deepEqual(endpointOf("tcp://127.0.0.1:2375"), { host: "127.0.0.1", port: 2375 });
  assert.deepEqual(endpointOf("wsl://bbdocker"), { wsl: { user: null, distro: "bbdocker" } });
  assert.deepEqual(endpointOf("wsl://box@bbdocker"), { wsl: { user: "box", distro: "bbdocker" } });
  assert.equal(endpointOf("wsl://"), null);
  assert.equal(endpointOf("ssh://me@host"), null);
});

test("a Docker socket that refuses BB's daemon says to put its user in the socket's group and restart the daemon with it", () => {
  const { username, uid } = userInfo();
  const socket = { path: "/var/run/docker.sock" };
  const denied = Object.assign(new Error("connect EACCES /var/run/docker.sock"), { code: "EACCES" });
  assert.equal(
    refusal(socket, denied, "linux"),
    `${username} may not use Docker's socket /var/run/docker.sock. Add ${username} to its group, usually docker, then restart ${username}'s services so BB's daemon has the group: sudo systemctl restart user@${uid}.service.`,
  );
  assert.equal(refusal(socket, denied, "darwin"), `${username} may not use Docker's socket /var/run/docker.sock. Add ${username} to its group, usually docker, then restart BB's daemon.`);
  assert.equal(refusal({ path: "\\\\.\\pipe\\docker_engine" }, denied, "win32"), null);
  assert.equal(refusal({ host: "127.0.0.1", port: 2375 }, denied, "linux"), null);
  assert.equal(refusal(socket, Object.assign(new Error("connect ENOENT /var/run/docker.sock"), { code: "ENOENT" }), "linux"), null);
});

test("a connection to a relay that went quiet asks BB first: it fails at once when the machine is offline, and gets a new relay when it is not; a worker's exit drops the relay", async (t) => {
  const dir = tempDir("relay-stale");
  const docker = await fakeDocker(join(dir, "docker.sock"));
  t.after(() => docker.close());
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  // Pings far apart, so a relay goes quiet quickly in this test.
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ path: join(dir, "docker.sock") }), pingMs: 60_000 } }));
  t.after(() => worker.experimental_dispose());
  let offline: string | null = null;
  let opens = 0;
  hub = new RelayHub({
    dir: tempDir("relay-hub"),
    open: (_hostId, secret) => (opens++, worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" })),
    keep: async () => true,
    offline: async () => offline,
    logError: () => {},
    pingMs: 60_000,
    staleMs: 50,
  });
  t.after(() => hub.dispose());
  const path = (await hub.endpoint("host_pc")).slice("unix://".length);
  assert.equal((await get(path, "/_ping")).status, 200);
  assert.equal(opens, 1);

  await new Promise((r) => setTimeout(r, 100));
  offline = "devpc is offline in BB.";
  const started = Date.now();
  const refused = await get(path, "/_ping");
  assert.deepEqual([refused.status, refused.text], [503, "bb-box could not reach Docker on the BB machine: devpc is offline in BB."]);
  assert.ok(Date.now() - started < 1_000, "at once, not when the pings stop");

  // Back online: a new relay serves it.
  offline = null;
  assert.equal((await get(path, "/_ping")).status, 200);
  assert.equal(opens, 2);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await get(path, "/_ping")).status, 200, "a quiet relay to a connected machine is replaced");
  assert.equal(opens, 3);

  // BB says the machine's worker exited: the relay goes, and the next connection opens another.
  hub.drop("host_pc", "the machine's worker exited");
  await new Promise((r) => setImmediate(r));
  assert.equal(hub.reopening("host_pc"), true, "lost: a box there is waited for (#415)");
  assert.equal((await get(path, "/_ping")).status, 200);
  assert.equal(opens, 4);
  assert.equal(hub.reopening("host_pc"), false, "open again");
});

test("a file copy through the worker refuses a file outside its folder or missing, and keeps no file that does not match the box's (#492)", async (t) => {
  const dir = tempDir("file-relay");
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  let relay!: FileRelay;
  const { connectTo } = joined(() => relay);
  const worker = experimental_createHostEntryHarness(hostEntry({ files: { connect: connectTo } }));
  t.after(() => worker.experimental_dispose());
  relay = new FileRelay({ call: (_hostId, request) => worker.experimental_call("file", { ...request, path: `/api/v1/plugins/bb-box/http${FILE_ROUTE}` }) as never, logError: () => {} });
  const nothing = async () => undefined;

  await assert.rejects(relay.copy("host_abc", { file: "/etc/hostname", root: dir, direction: "send" }, nothing), /\/etc\/hostname is not within /);
  await assert.rejects(relay.copy("host_abc", { file: join(dir, "missing.bin"), root: dir, direction: "send" }, nothing), /ENOENT/);

  // What came does not match what the box said it sent: the target is left as it was.
  writeFileSync(join(dir, "kept.bin"), "before");
  const expect = { bytes: 5, sha256: "0".repeat(64) };
  const sending = (channel: NodeJS.WritableStream) => new Promise<void>((resolve) => channel.end("after", () => resolve()));
  await assert.rejects(relay.copy("host_abc", { file: join(dir, "kept.bin"), root: dir, direction: "receive", expect }, sending), /not the box's 5 bytes with 0{64}: the file may have changed in the box/);
  assert.equal(readFileSync(join(dir, "kept.bin"), "utf8"), "before");
  assert.equal(existsSync(join(dir, "kept.bin.bb-box-part")), false);
});

test("wsl dial-stdio returns what it writes after the client half-closes", async (t) => {
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  const dial = () => {
    const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.end('after-half-close'))"], { stdio: ["pipe", "pipe", "pipe"] });
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("dial-stdio did not open its pipes");
    return child;
  };
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ wsl: { distro: "bbdocker", user: "box" } }), dial } }));
  t.after(() => worker.experimental_dispose());
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {} });
  t.after(() => hub.dispose());
  const socketPath = (await hub.endpoint("host_wsl")).slice("unix://".length);
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    let text = "";
    socket.on("data", (part) => (text += part));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.end("request");
  });
  assert.equal(reply, "after-half-close");
});

test("a relay open names the machine's Docker host, and the machine dials that instead of its own", async (t) => {
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  const seen: string[] = [];
  const dial = (wsl: { distro: string; user: string | null }) => {
    seen.push(wsl.user ? `${wsl.user}@${wsl.distro}` : wsl.distro);
    const child = spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => process.stdout.end('after-half-close'))"], { stdio: ["pipe", "pipe", "pipe"] });
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("dial-stdio did not open its pipes");
    return child;
  };
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({
    relay: {
      connect: connectTo,
      endpoint: async () => {
        throw new Error("the machine's DOCKER_HOST");
      },
      dial,
    },
  }));
  t.after(() => worker.experimental_dispose());
  hub = new RelayHub({
    dir: tempDir("relay-hub"),
    open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay", dockerHost: "wsl://archlinux" }),
    keep: async () => false,
    logError: () => {},
  });
  t.after(() => hub.dispose());
  const socketPath = (await hub.endpoint("host_wsl_field")).slice("unix://".length);
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = connect({ path: socketPath, allowHalfOpen: true });
    let text = "";
    socket.on("data", (part) => (text += part));
    socket.on("end", () => resolve(text));
    socket.on("error", reject);
    socket.end("request");
  });
  assert.equal(reply, "after-half-close");
  assert.deepEqual(seen, ["archlinux"]);
  const asked = await worker.experimental_call("docker", { dockerHost: "wsl://box@archlinux" });
  assert.equal(asked.endpoint, "wsl://box@archlinux");
  assert.equal(asked.found, true);
  assert.equal(asked.attached, undefined);
  assert.deepEqual(seen, ["archlinux", "box@archlinux"]);
});

test("a dial-stdio child that exits without stdout gives the client the reason, and the hub logs it", async (t) => {
  process.env.BB_SERVER_URL ??= "https://bb.example.com";
  const dial = () => {
    const child = spawn(process.execPath, ["-e", "process.stderr.end('no such distro', () => process.exit(1))"], { stdio: ["pipe", "pipe", "pipe"] });
    if (!child.stdin || !child.stdout || !child.stderr) throw new Error("dial-stdio did not open its pipes");
    return child;
  };
  let hub!: RelayHub;
  const { connectTo } = joined(() => hub);
  const worker = experimental_createHostEntryHarness(hostEntry({ relay: { connect: connectTo, endpoint: async () => ({ wsl: { distro: "missing", user: null } }), dial } }));
  t.after(() => worker.experimental_dispose());
  const logs: string[] = [];
  hub = new RelayHub({ dir: tempDir("relay-hub"), open: (_hostId, secret) => worker.experimental_call("relay", { secret, path: "/api/v1/plugins/bb-box/http/docker-relay" }), keep: async () => false, logError: () => {}, log: (line) => logs.push(line) });
  t.after(() => hub.dispose());
  const answer = await get((await hub.endpoint("host_wsl_fail")).slice("unix://".length), "/_ping");
  assert.deepEqual([answer.status, answer.text], [503, "bb-box could not reach Docker on the BB machine: no such distro"]);
  assert.ok(logs.includes("Docker on BB machine host_wsl_fail did not answer: no such distro"), logs.join("\n"));
});

test("a wsl host whose dial-stdio cannot start fails the docker check with the reason", async () => {
  const worker = experimental_createHostEntryHarness(hostEntry({
    relay: {
      endpoint: async () => ({ wsl: { distro: "bbdocker", user: null } }),
      dial: () => {
        throw new Error("wsl.exe: spawn wsl.exe ENOENT");
      },
    },
  }));
  const answer = await worker.experimental_call("docker", {});
  await worker.experimental_dispose();
  assert.equal(answer.found, false);
  assert.match(answer.reason ?? "", /wsl.exe/);
  assert.equal(answer.endpoint, "wsl://bbdocker");
});
