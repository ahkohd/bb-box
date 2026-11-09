// The Proxmox API's self-signed certificate is trusted by its fingerprint, as
// the setup guide's token file gives it, against a real HTTPS server.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { X509Certificate } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { ProxmoxLxcBackend } from "../src/backends/proxmox-lxc/backend.ts";
import { lxcConfig, tempDir, testContext } from "./helpers.ts";

let url = "";
let fingerprint = "";
let server: ReturnType<typeof createServer>;

before(async () => {
  const dir = tempDir("tls");
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1",
    "-subj", "/CN=pve", "-addext", "subjectAltName=IP:127.0.0.1",
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "cert.pem"), "utf8");
  fingerprint = new X509Certificate(cert).fingerprint256;
  server = createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (request, response) => {
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/api2/json/nodes") return response.end(JSON.stringify({ data: [{ node: "pve", status: "online" }] }));
    response.statusCode = 501;
    response.end(JSON.stringify({ data: null }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `https://127.0.0.1:${(server.address() as AddressInfo).port}/api2/json`;
});

after(() => server.close());

async function node(settings: Record<string, unknown>): Promise<string> {
  const backend = new ProxmoxLxcBackend(lxcConfig({ "proxmox-lxc-url": url, ...settings }), testContext());
  try {
    return (await backend.client()).node;
  } finally {
    await backend.dispose();
  }
}

test("the API's certificate is trusted by its fingerprint", async () => {
  assert.equal(await node({ "proxmox-lxc-tls-fingerprint": fingerprint.toLowerCase() }), "pve");
});

test("a different certificate is refused, and the error says which one it saw", async () => {
  const other = Array(32).fill("AA").join(":");
  await assert.rejects(node({ "proxmox-lxc-tls-fingerprint": other }), (error: Error) => {
    assert.match(error.message, new RegExp(`fingerprint ${fingerprint}, not the one in BB Box's settings`));
    return true;
  });
});

test("without a fingerprint or CA, a self-signed certificate is refused", async () => {
  await assert.rejects(node({}), /cannot reach the Proxmox API: .*certificate/i);
});
