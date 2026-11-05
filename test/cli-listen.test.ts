import assert from "node:assert/strict";
import { test } from "node:test";
import { bbDirectListen, bbServerPort } from "../src/plugin/cli.ts";

function proc(port: number, address: string, state = "0A"): string {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return `   0: ${address}:${hex} 00000000:0000 ${state} 00000000:00000000\n`;
}

const HEADER = "  sl  local_address rem_address   st tx_queue rx_queue\n";
const IPV6_ANY = "0".repeat(32);
const OTHERS = HEADER + proc(5355, "00000000") + proc(22, "00000000");

test("BB's port comes from the app URL, then from machine access, and never from another listen", () => {
  assert.equal(bbServerPort("http://127.0.0.1:4777", "http://10.0.0.8:5355"), 4777);
  assert.equal(bbServerPort(null, "https://bb.example.com:8443"), 8443);
  assert.equal(bbServerPort(null, "http://10.0.0.8"), 80);
  assert.equal(bbServerPort("https://bb.example.com", null), 443);
  assert.equal(bbServerPort(null, null), null);

  const addresses = ["10.0.0.8"];
  assert.equal(bbDirectListen("http://127.0.0.1:4777", null, OTHERS + proc(4777, "0100007F"), HEADER, addresses), null);
  assert.deepEqual(bbDirectListen("http://127.0.0.1:4777", null, OTHERS + proc(4777, "00000000"), HEADER, addresses), { port: 4777, url: "http://10.0.0.8:4777" });
  assert.deepEqual(bbDirectListen("http://127.0.0.1:4777", "http://10.0.0.8:5355", OTHERS, HEADER + proc(4777, IPV6_ANY), addresses), { port: 4777, url: "http://10.0.0.8:4777" });
  assert.equal(bbDirectListen(null, "http://10.0.0.8:4777", OTHERS, HEADER + proc(4777, IPV6_ANY, "01"), addresses), null);
  assert.equal(bbDirectListen(null, null, OTHERS + proc(5355, "00000000"), HEADER + proc(22, IPV6_ANY), addresses), null);
});
