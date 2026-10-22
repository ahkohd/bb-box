import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { Tailnet } from "../src/core/tailnet.ts";
import { tailscaleFetch } from "../src/core/tailscale-fetch.ts";

function silentAfterFirstAnswer(): Promise<{ server: Server; url: string; connections: () => number; close: () => Promise<void> }> {
  const answered = new WeakSet<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const socket = request.socket;
    if (answered.has(socket)) return;
    answered.add(socket);
    const body = request.url === "/api/v2/oauth/token" ? { access_token: "tok", expires_in: 3600 } : { devices: [{ nodeId: "n1", hostname: "bb-box-ns-i1-mac", tags: ["tag:bb-box"], addresses: ["100.64.0.1"] }] };
    response.writeHead(200, { "Content-Type": "application/json", "Keep-Alive": "timeout=600" });
    response.end(JSON.stringify(body));
  });
  server.keepAliveTimeout = 600_000;
  server.on("connection", (socket) => sockets.add(socket));
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        connections: () => sockets.size,
        close: () => {
          for (const socket of sockets) socket.destroy();
          return new Promise((done) => server.close(() => done()));
        },
      }),
    ),
  );
}

test("a pooled connection that has gone silent hangs a long-lived fetch until its timeout, as bb-box's calls to Tailscale did", async () => {
  const site = await silentAfterFirstAnswer();
  const pool = new Agent({ keepAliveTimeout: 600_000, keepAliveMaxTimeout: 600_000 });
  try {
    assert.match(await (await undiciFetch(`${site.url}/first`, { dispatcher: pool })).text(), /devices/);
    await sleep(50);
    await assert.rejects(undiciFetch(`${site.url}/second`, { dispatcher: pool, signal: AbortSignal.timeout(500) }), { name: "TimeoutError" });
    assert.equal(site.connections(), 1, "the second request went down the first, silent, connection");
  } finally {
    await pool.destroy();
    await site.close();
  }
});

test("the Tailscale client gets past a silent pooled connection: the timed-out request closes the pool and is tried once more on a fresh connection, and the log says what happened", async () => {
  const site = await silentAfterFirstAnswer();
  const lines: string[] = [];
  const tailnet = new Tailnet({ credentials: { clientId: "id", clientSecret: "secret" }, apiUrl: site.url, attemptTimeoutMs: 500, log: (line) => lines.push(line) });
  try {
    assert.deepEqual(await tailnet.check(), { ok: true });
    await sleep(50);
    const devices = await tailnet.devices();
    assert.deepEqual(devices.map((device) => device.hostname), ["bb-box-ns-i1-mac"]);
    assert.equal(site.connections(), 2, "the token on one connection; the devices tried on it, then on a fresh one");
    assert.equal(lines.filter((line) => /^Tailscale: opened a connection to 127\.0\.0\.1 \(IPv4\), over http\/1\.1\.$/.test(line)).length, 2, lines.join("\n"));
    assert.ok(lines.some((line) => /^Tailscale: GET \/api\/v2\/tailnet\/-\/devices failed after \d+ ms on a reused connection to 127\.0\.0\.1/.test(line)), lines.join("\n"));
  } finally {
    await site.close();
  }
});

test("the Tailscale client says it tried twice when Tailscale does not answer at all", async () => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const tailnet = new Tailnet({ credentials: { clientId: "id", clientSecret: "secret" }, apiUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, attemptTimeoutMs: 1000, fetch: tailscaleFetch() });
  try {
    await assert.rejects(tailnet.devices(), /Could not reach Tailscale to .+: it did not answer within 1 s, twice\./);
  } finally {
    silent.closeAllConnections();
    await new Promise((done) => silent.close(done));
  }
});
