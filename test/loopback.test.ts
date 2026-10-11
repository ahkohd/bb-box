// BB's loopback address, carried to Docker boxes on the machine that runs BB.

import assert from "node:assert/strict";
import { connect, createServer, type AddressInfo } from "node:net";
import { test } from "node:test";
import { boxForwarder, inSubnet, LoopbackRelay } from "../src/backends/docker/loopback.ts";
import { loopbackPort } from "../src/backends/index.ts";

test("BB's address is loopback for 127.x, ::1 and localhost, with its port, and not for any other", () => {
  assert.deepEqual(loopbackPort("http://127.0.0.1:41820"), { port: 41820 });
  assert.deepEqual(loopbackPort("http://localhost:3000/"), { port: 3000 });
  assert.deepEqual(loopbackPort("http://[::1]:8080"), { port: 8080 });
  assert.deepEqual(loopbackPort("http://127.0.0.1"), { port: 80 });
  assert.equal(loopbackPort("https://bb.example.com"), null);
  assert.equal(loopbackPort("http://10.0.0.2:41820"), null);
  assert.equal(loopbackPort(null), null);
  assert.equal(loopbackPort("not a url"), null);
});

test("an address is in a subnet by its prefix, IPv4-mapped too, and nothing else is", () => {
  assert.equal(inSubnet("172.18.0.5", "172.18.0.0/16"), true);
  assert.equal(inSubnet("::ffff:172.18.3.4", "172.18.0.0/16"), true);
  assert.equal(inSubnet("172.19.0.5", "172.18.0.0/16"), false);
  assert.equal(inSubnet("10.0.0.1", "0.0.0.0/0"), true);
  assert.equal(inSubnet("::1", "127.0.0.0/8"), false);
  assert.equal(inSubnet("192.168.1.10", "bad"), false);
});

test("the relay carries a box's connection to BB's port on loopback, takes only its subnet's addresses, and lets go when closed", async (t) => {
  // BB, on loopback.
  const bb = createServer((socket) => socket.end("hello from BB\n"));
  await new Promise<void>((resolve) => bb.listen({ host: "127.0.0.1", port: 0 }, () => resolve()));
  t.after(() => bb.close());
  const port = (bb.address() as AddressInfo).port;
  // The relay, on a second loopback address as the gateway, so it can take BB's port there.
  const relay = new LoopbackRelay();
  t.after(() => relay.close());
  const read = (host: string) =>
    new Promise<string>((resolve) => {
      const socket = connect({ host, port });
      let got = "";
      socket.on("data", (chunk) => (got += chunk.toString()));
      socket.on("close", () => resolve(got));
      socket.on("error", () => resolve(got));
    });

  await relay.open({ gateway: "127.0.0.2", subnet: "127.0.0.0/8", port });
  assert.equal(await read("127.0.0.2"), "hello from BB\n");
  assert.deepEqual(relay.target, { gateway: "127.0.0.2", subnet: "127.0.0.0/8", port });

  // From outside its subnet, the connection is closed with nothing carried.
  await relay.open({ gateway: "127.0.0.2", subnet: "10.0.0.0/8", port });
  assert.equal(await read("127.0.0.2"), "");

  await relay.close();
  assert.equal(relay.target, null);
  await assert.rejects(
    new Promise((resolve, reject) => {
      const socket = connect({ host: "127.0.0.2", port });
      socket.on("connect", () => resolve(socket.destroy()));
      socket.on("error", reject);
    }),
  );
});

test("each box forwards its own 127.0.0.1 at BB's port to the gateway", () => {
  assert.deepEqual(boxForwarder({ gateway: "172.18.0.1", subnet: "172.18.0.0/16", port: 41820 }), ["socat", "TCP-LISTEN:41820,bind=127.0.0.1,reuseaddr,fork", "TCP:172.18.0.1:41820"]);
});
