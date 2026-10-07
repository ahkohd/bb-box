// The desktop relay for a Selkies display (src/core/selkies.ts, 056), against
// a stand-in for the box's Selkies.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SelkiesBox, SelkiesRelay, classify, unsequenced } from "../src/core/selkies.ts";
import type { Message } from "../src/core/websocket.ts";
import { FakeSelkies, videoFrame } from "./fake-selkies.ts";
import { until } from "./fake-rfb.ts";

/** A viewer's end: what the relay sent it, and how it closed. */
function viewer() {
  const got: Message[] = [];
  let closed: { code: number; reason: string } | null = null;
  return {
    got,
    get closed() {
      return closed;
    },
    frames: () => got.filter((message): message is Uint8Array => typeof message !== "string").map((frame) => (frame[2]! << 8) | frame[3]!),
    end: { send: (message: Message) => void got.push(message), close: (code: number, reason: string) => void (closed = { code, reason }) },
  };
}

function setup(options: { debounceMs?: number; spacingMs?: number; lagMs?: number } = {}) {
  const server = new FakeSelkies({ debounceMs: options.debounceMs });
  const open = async () => server.channel();
  const box = new SelkiesBox(open, { spacingMs: options.spacingMs ?? 0 });
  let control: string | null = null;
  const relay = (name: string) => {
    const end = viewer();
    const relay = new SelkiesRelay({ viewer: end.end, box, open, mayInput: () => control === name, lagMs: options.lagMs });
    // Not spread: that would copy `closed` as it is now.
    return Object.assign(end, { relay });
  };
  return { server, box, relay, give: (name: string | null) => void (control = name) };
}

test("a viewer joins as a Selkies viewer, gets what Selkies sends, and may only ask for video", async () => {
  const { server, box, relay } = setup();
  const a = relay("a");
  await until("the viewer's page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  assert.equal(page.role, "viewer");
  assert.equal(page.path, "/api/websockets?role=viewer");
  await until("Selkies' first message", () => a.got.includes("MODE websockets"));
  for (const message of ["SETTINGS,{}", "START_VIDEO", "REQUEST_KEYFRAME", "r,800x600", "_f,60", "_arg_fps,30", "cmd,xterm", "s,1.5", "_gz,1", "CLIENT_FRAME_ACK 1 0"]) {
    await a.relay.receive(message);
  }
  await a.relay.receive(Uint8Array.of(2, 0, 0));
  await until("the video requests", () => page.received.length === 3);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(page.received, ["SETTINGS,{}", "START_VIDEO", "REQUEST_KEYFRAME"], "nothing else reaches Selkies from a viewer");
  await server.frame(1, true);
  await server.frame(2, false);
  await until("two frames", () => a.frames().length === 2);
  assert.deepEqual(a.frames(), [1, 2]);
  await a.relay.close();
  await box.close();
});

test("input reaches the box over the input connection only from the viewer with control, with no pointer sequence", async () => {
  const { server, box, relay, give } = setup();
  const a = relay("a");
  const b = relay("b");
  await until("both pages", () => server.pages.length === 2);
  await a.relay.receive("kd,120");
  await b.relay.receive("m,10,10,0,0,5");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(server.pages.length, 2, "no input connection while no viewer has control");
  give("a");
  await a.relay.receive("kd,120");
  await a.relay.receive("ku,120");
  await a.relay.receive("m,300,200,1,0,42");
  await b.relay.receive("kd,65");
  await until("the input connection", () => server.pages.length === 3);
  const input = server.pages[2]!;
  assert.equal(input.role, "controller");
  await until("the input", () => input.received.length === 4);
  assert.deepEqual(input.received, ["STOP_VIDEO", "kd,120", "ku,120", "m,300,200,1,0"]);
  // A frame to the input connection, as a new capture sends to every page: it asks for no video again.
  input.stopped = false;
  await input.send(videoFrame(9, true));
  await until("its STOP_VIDEO", () => input.received.filter((message) => message === "STOP_VIDEO").length === 2);
  await a.relay.close();
  await b.relay.close();
  await box.close();
});

test("a viewer with control that goes lets go of what it holds down", async () => {
  const { server, box, relay, give } = setup();
  give("a");
  const a = relay("a");
  await a.relay.receive("kd,65507");
  await a.relay.receive("kd,99");
  await a.relay.receive("m,50,60,1,0");
  await until("the input connection", () => server.pages.length === 2);
  const input = server.pages[1]!;
  await until("the input", () => input.received.length === 4);
  assert.ok(a.relay.holding);
  await a.relay.close();
  await until("the releases", () => input.received.length === 7);
  assert.deepEqual(input.received.slice(4), ["ku,65507", "ku,99", "m,50,60,0,0"]);
  await box.close();
});

test("the box's clipboard reaches only the viewer with control", async () => {
  const { server, box, relay, give } = setup();
  const a = relay("a");
  const b = relay("b");
  await until("both pages", () => server.pages.length === 2);
  give("a");
  await server.clipboard("copied in the box");
  const text = `clipboard,${Buffer.from("copied in the box").toString("base64")}`;
  await until("a's clipboard", () => a.got.includes(text));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(!b.got.includes(text), "a viewer without control does not get it");
  await a.relay.close();
  await b.relay.close();
  await box.close();
});

test("a viewer that falls behind gets no frames until it has caught up, then from a key frame, which the relay asks for only then", async () => {
  const { server, box, relay } = setup({ lagMs: 50 });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  await server.frame(1, true);
  await server.frame(2, false);
  await until("two frames", () => a.frames().length === 2);
  // It shows nothing for longer than it may.
  await new Promise((resolve) => setTimeout(resolve, 80));
  await server.frame(3, false);
  await server.frame(4, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(a.frames(), [1, 2], "nothing more while it is behind, not even a key frame");
  assert.ok(!page.received.includes("REQUEST_KEYFRAME"), "no key frame for every viewer while this one is behind");
  await a.relay.receive("CLIENT_FRAME_ACK 2 0");
  await server.frame(5, false);
  await until("the key frame request", () => page.received.includes("REQUEST_KEYFRAME"));
  await server.frame(6, true);
  await server.frame(7, false);
  await until("the frames from the key frame", () => a.frames().length === 4);
  assert.deepEqual(a.frames(), [1, 2, 6, 7]);
  await a.relay.close();
  await box.close();
});

test("a viewer that caught up asks for its key frame again until one comes, on the input connection when it is open (Selkies takes a viewer's once a second)", async () => {
  const { server, box, relay, give } = setup({ lagMs: 50 });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  await server.frame(1, true);
  await until("a frame", () => a.frames().length === 1);
  await new Promise((resolve) => setTimeout(resolve, 80));
  await server.frame(2, false);
  // Frame 2 comes while the viewer is behind, and is dropped; then it catches up.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await a.relay.receive("CLIENT_FRAME_ACK 1 0");
  await server.frame(3, false);
  await until("the first request", () => page.received.filter((message) => message === "REQUEST_KEYFRAME").length === 1);
  await server.frame(4, false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(page.received.filter((message) => message === "REQUEST_KEYFRAME").length, 1, "not again within 250 ms");
  await new Promise((resolve) => setTimeout(resolve, 260));
  await server.frame(5, false);
  await until("the second request", () => page.received.filter((message) => message === "REQUEST_KEYFRAME").length === 2);
  assert.deepEqual(a.frames(), [1], "no frame until the key frame");

  // With the box's input connection open, it asks there instead.
  give("a");
  await a.relay.receive("kd,65");
  await until("the input connection", () => server.pages.length === 2);
  const input = server.pages[1]!;
  await until("the key", () => input.received.includes("kd,65"));
  await new Promise((resolve) => setTimeout(resolve, 260));
  await server.frame(6, false);
  await until("the request on the input connection", () => input.received.includes("REQUEST_KEYFRAME"));
  assert.equal(page.received.filter((message) => message === "REQUEST_KEYFRAME").length, 2, "not on the viewer's own");
  await server.frame(7, true);
  await until("the key frame", () => a.frames().length === 2);
  assert.deepEqual(a.frames(), [1, 7]);
  await a.relay.close();
  await box.close();
});

test("a box's connections open one at a time, spaced, and one Selkies refuses for coming too soon opens again", async () => {
  const { server, box, relay, give } = setup({ debounceMs: 40, spacingMs: 60 });
  const started = Date.now();
  const a = relay("a");
  const b = relay("b");
  give("a");
  await a.relay.receive("kd,1");
  await until("three pages", () => server.pages.length === 3);
  assert.ok(Date.now() - started >= 120, "each waited its turn");
  assert.ok(a.got.includes("MODE websockets") && b.got.includes("MODE websockets"));
  await a.relay.close();
  await b.relay.close();
  await box.close();

  // Spaced less than Selkies wants, as when another client connected: refused, then opened a spacing later.
  const quick = setup({ debounceMs: 40, spacingMs: 30 });
  const c = quick.relay("c");
  const d = quick.relay("d");
  await until("both pages", () => quick.server.pages.length === 2);
  await until("both first messages", () => c.got.includes("MODE websockets") && d.got.includes("MODE websockets"));
  await c.relay.close();
  await d.relay.close();
  await quick.box.close();
});

test("the box ending the connection ends the viewer's, with why", async () => {
  const { server, box, relay } = setup();
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  await server.pages[0]!.close(1011);
  await until("the viewer's close", () => a.closed !== null);
  assert.equal(a.closed!.code, 1011);
  assert.match(a.closed!.reason, /closed the connection \(1011\)/);
  await box.close();
});

test("messages are told apart by their first field, and a pointer loses its sequence number", () => {
  assert.equal(classify("CLIENT_FRAME_ACK 12 3"), "ack");
  assert.equal(classify("SETTINGS,{\"a\":1}"), "video");
  assert.equal(classify("kd,65"), "input");
  assert.equal(classify("cws,1,2"), "input");
  assert.equal(classify("REQUEST_CLIPBOARD"), "input");
  assert.equal(classify("r,1x1"), "drop");
  assert.equal(classify("kdx,1"), "drop");
  assert.equal(unsequenced("m,1,2,0,0,99"), "m,1,2,0,0");
  assert.equal(unsequenced("m2,1,2,0,0"), "m2,1,2,0,0");
  assert.equal(unsequenced("kd,65"), "kd,65");
});
