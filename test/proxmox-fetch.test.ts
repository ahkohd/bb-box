import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { proxmoxFetch } from "../src/backends/proxmox/tls.ts";

test("destroying the Proxmox client ends a request the API has not answered", async () => {
  const server = createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("the stalling API has no port");
  const http = proxmoxFetch({ ca: null, fingerprint: null });
  const started = Date.now();
  const pending = http.fetch(`http://127.0.0.1:${(address as AddressInfo).port}/api2/json/nodes`, { method: "GET", headers: {}, signal: AbortSignal.timeout(30_000) }).then(
    () => "done" as const,
    () => "rejected" as const,
  );
  await new Promise((resolve) => setTimeout(resolve, 30));
  await http.destroy();
  const outcome = await Promise.race([pending, new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 2_000))]);
  server.close();
  assert.equal(outcome, "rejected");
  assert.ok(Date.now() - started < 2_000);
});
