import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { Agent, fetch as undiciFetch } from "undici";
import { Tailnet } from "../src/core/tailnet.ts";
import { freshFetch } from "../src/core/fresh-fetch.ts";
import { Hetzner } from "../src/backends/hetzner/api.ts";
import { NamespaceApi } from "../src/backends/namespace/api.ts";

function tailscaleAnswer(path: string): { status: number; body: unknown } {
  if (path === "/api/v2/oauth/token") return { status: 200, body: { access_token: "tok", expires_in: 3600 } };
  return { status: 200, body: { devices: [{ nodeId: "n1", hostname: "bb-box-ns-i1-mac", tags: ["tag:bb-box"], addresses: ["100.64.0.1"] }] } };
}

function silentAfterFirstAnswer(answer: (path: string) => { status: number; body: unknown } = tailscaleAnswer): Promise<{ server: Server; url: string; connections: () => number; close: () => Promise<void> }> {
  const answered = new WeakSet<Socket>();
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    const socket = request.socket;
    if (answered.has(socket)) return;
    answered.add(socket);
    const { status, body } = answer(request.url ?? "/");
    response.writeHead(status, { "Content-Type": "application/json", "Keep-Alive": "timeout=600" });
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

test("the Tailscale client gets past a silent pooled connection: the timed-out request closes the pool and is tried once more on a fresh connection, and the log says only what went wrong", async () => {
  const site = await silentAfterFirstAnswer();
  const lines: string[] = [];
  const tailnet = new Tailnet({ credentials: { clientId: "id", clientSecret: "secret" }, apiUrl: site.url, attemptTimeoutMs: 500, log: (line) => lines.push(line) });
  try {
    assert.deepEqual(await tailnet.check(), { ok: true });
    await sleep(50);
    const devices = await tailnet.devices();
    assert.deepEqual(devices.map((device) => device.hostname), ["bb-box-ns-i1-mac"]);
    assert.equal(site.connections(), 2, "the token on one connection; the devices tried on it, then on a fresh one");
    assert.deepEqual(lines.filter((line) => line.includes("opened")), ["Tailscale: opened a fresh connection to 127.0.0.1 (IPv4), over http/1.1, after a failed request."], "only the connection after the failure is logged");
    assert.ok(lines.some((line) => /^Tailscale: GET \/api\/v2\/tailnet\/-\/devices failed after \d+ ms on a reused connection to 127\.0\.0\.1/.test(line)), lines.join("\n"));
  } finally {
    await site.close();
  }
});

test("the Tailscale client says it tried twice when Tailscale does not answer at all", async () => {
  const silent = createServer(() => {});
  await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
  const tailnet = new Tailnet({ credentials: { clientId: "id", clientSecret: "secret" }, apiUrl: `http://127.0.0.1:${(silent.address() as AddressInfo).port}`, attemptTimeoutMs: 1000, fetch: freshFetch("Tailscale") });
  try {
    await assert.rejects(tailnet.devices(), /Could not reach Tailscale to .+: it did not answer within 1 s, twice\./);
  } finally {
    silent.closeAllConnections();
    await new Promise((done) => silent.close(done));
  }
});

test("Namespace's and Hetzner's clients use the same fresh connections: a call stuck on a silent pooled connection fails at its timeout, and the next call opens a fresh one", async () => {
  for (const service of ["Namespace", "Hetzner Cloud"] as const) {
    const site = await silentAfterFirstAnswer((path) => (path.startsWith("/servers/") ? { status: 404, body: { error: { code: "not_found", message: "server not found" } } } : { status: 200, body: { instances: [] } }));
    const lines: string[] = [];
    const log = (line: string) => lines.push(line);
    const call =
      service === "Namespace"
        ? (() => {
            const api = new NamespaceApi({ token: "nsct_test", endpoint: site.url, log });
            return (signal?: AbortSignal) => api.list({ install: null }, signal);
          })()
        : (() => {
            const api = new Hetzner({ token: "hetzner-test", apiUrl: site.url, log });
            return (signal?: AbortSignal) => api.server(7, signal);
          })();
    try {
      await call();
      await sleep(50);
      await assert.rejects(call(AbortSignal.timeout(500)));
      await call();
      assert.equal(site.connections(), 2, `${service}: the stuck call's connection, then a fresh one`);
      assert.ok(lines.some((line) => line.startsWith(`${service}: `) && / failed after \d+ ms on a reused connection to 127\.0\.0\.1/.test(line)), lines.join("\n"));
      assert.deepEqual(lines.filter((line) => line.includes("opened")), [`${service}: opened a fresh connection to 127.0.0.1 (IPv4), over http/1.1, after a failed request.`]);
      assert.equal(lines.length, 2, "a failed request and the connection after it, and nothing for the first connection");
    } finally {
      await site.close();
    }
  }
});
