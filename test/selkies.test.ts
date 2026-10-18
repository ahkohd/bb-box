// The desktop relay for a Selkies display (src/core/selkies.ts, 056), against
// a stand-in for the box's Selkies.

import assert from "node:assert/strict";
import { test } from "node:test";
import { SelkiesBox, SelkiesRelay, Spacing, classify, unsequenced, type Clock } from "../src/core/selkies.ts";
import type { Message } from "../src/core/websocket.ts";
import { FakeSelkies, videoFrame } from "./fake-selkies.ts";
import { until } from "./fake-rfb.ts";

/** The relay's clock in a test: time moves only when the test moves it, or a wait asks it to. */
class FakeClock implements Clock {
  t = 1_000_000;
  readonly sleeps: number[] = [];
  now(): number {
    return this.t;
  }
  async sleep(ms: number): Promise<void> {
    this.sleeps.push(ms);
    this.t += ms;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

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

let marks = 0;

function setup(options: { refuse?: number; spacingMs?: number; lagMs?: number; onSize?: (size: { width: number; height: number }) => void } = {}) {
  const server = new FakeSelkies({ refuse: options.refuse });
  const open = async () => server.channel();
  const clock = new FakeClock();
  const box = new SelkiesBox(open, { spacingMs: options.spacingMs ?? 0, clock });
  let control: string | null = null;
  const relay = (name: string) => {
    const end = viewer();
    const relay = new SelkiesRelay({ viewer: end.end, box, open, mayInput: () => control === name, lagMs: options.lagMs, onSize: options.onSize });
    // Not spread: that would copy `closed` as it is now.
    return Object.assign(end, { relay });
  };
  /**
   * Waits until each viewer has had everything every page was sent so far,
   * and Selkies everything the relay sent it so far: a mark each way, which
   * comes after it. So what has not come by then never will.
   */
  const settle = async (...ends: ReturnType<typeof relay>[]) => {
    const mark = `mark-${++marks}`;
    for (const page of server.pages) if (!page.closed) await page.send(mark);
    await until("the viewers to have it all", () => ends.every((end) => end.got.includes(mark)));
    for (const end of ends) await end.relay.receive("START_VIDEO");
    await until("Selkies to have it all", () => server.pages.filter((page) => page.role === "viewer" && !page.closed).every((page) => page.received.at(-1) === "START_VIDEO"));
  };
  return { server, box, clock, relay, settle, give: (name: string | null) => void (control = name) };
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
  // Last, a request that passes: what was dropped before it would have come first.
  await a.relay.receive("STOP_VIDEO");
  await until("the video requests", () => page.received.at(-1) === "STOP_VIDEO");
  assert.deepEqual(page.received, ["SETTINGS,{}", "START_VIDEO", "REQUEST_KEYFRAME", "STOP_VIDEO"], "nothing else reaches Selkies from a viewer");
  await a.relay.receive("START_VIDEO");
  await until("the video again", () => !page.stopped);
  await server.frame(1, true);
  await server.frame(2, false);
  await until("two frames", () => a.frames().length === 2);
  assert.deepEqual(a.frames(), [1, 2]);
  await a.relay.close();
  await box.close();
});

test("a viewer's video is stopped and started again for a restart of the capture, unless the viewer asked for none, as a hidden tab does", async () => {
  const { server, relay } = setup();
  const a = relay("a");
  const b = relay("b");
  await until("both pages", () => server.pages.length === 2);
  await until("Selkies' first messages", () => a.got.includes("MODE websockets") && b.got.includes("MODE websockets"));
  await b.relay.receive("STOP_VIDEO");
  assert.equal(a.relay.pause(), true);
  assert.equal(b.relay.pause(), false, "a viewer that asked for no video is left so");
  a.relay.resume();
  b.relay.resume();
  const [pageA, pageB] = server.pages;
  await until("a's restart", () => pageA!.received.join(" ").endsWith("STOP_VIDEO START_VIDEO REQUEST_KEYFRAME"));
  await until("b's own stop", () => pageB!.received.includes("STOP_VIDEO"));
  assert.deepEqual(pageB!.received.filter((message) => typeof message === "string" && /_VIDEO|KEYFRAME/.test(message)), ["STOP_VIDEO"]);
  assert.equal(pageA!.stopped, false);
});

test("input reaches the box over the input connection only from the viewer with control, with no pointer sequence", async () => {
  const { server, box, relay, give } = setup();
  const a = relay("a");
  const b = relay("b");
  await until("both pages", () => server.pages.length === 2);
  // A receive that passed input on would have opened the input connection before it returned.
  await a.relay.receive("kd,120");
  await b.relay.receive("m,10,10,0,0,5");
  assert.equal(server.pages.length, 2, "no input connection while no viewer has control");
  give("a");
  await a.relay.receive("kd,120");
  await a.relay.receive("ku,120");
  await a.relay.receive("m,300,200,1,0,42");
  await b.relay.receive("kd,65");
  assert.equal(server.pages.length, 3, "the input connection");
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
  const { server, box, relay, give, settle } = setup();
  const a = relay("a");
  const b = relay("b");
  await until("both pages", () => server.pages.length === 2);
  give("a");
  await server.clipboard("copied in the box");
  await settle(a, b);
  const text = `clipboard,${Buffer.from("copied in the box").toString("base64")}`;
  assert.ok(a.got.includes(text), "the viewer with control gets it");
  assert.ok(!b.got.includes(text), "a viewer without control does not");
  await a.relay.close();
  await b.relay.close();
  await box.close();
});

test("a viewer that falls behind gets no frames until it has caught up, then from a key frame, which the relay asks for only then", async () => {
  const { server, box, clock, relay, settle } = setup({ lagMs: 50 });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  await server.frame(1, true);
  await server.frame(2, false);
  await until("two frames", () => a.frames().length === 2);
  // It shows nothing for longer than it may.
  clock.advance(80);
  await server.frame(3, false);
  await server.frame(4, true);
  await settle(a);
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

test("a capture that starts again numbers its frames from 0, and a frame the viewer had not acknowledged from the one before holds none of them back (the owner's note of 18 October 2026)", async () => {
  const sizes: string[] = [];
  const { server, box, clock, relay } = setup({ lagMs: 50, onSize: (size) => sizes.push(`${size.width}x${size.height}`) });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  await server.frame(4999, true, 1920, 1080);
  await server.frame(5000, false, 1920, 1080);
  await until("two frames", () => a.frames().length === 2);
  // The capture stops with frame 5000 not yet acknowledged, and Selkies starts the next, at a new size, after longer than the lag.
  await a.relay.receive("CLIENT_FRAME_ACK 4999 0");
  clock.advance(300);
  await server.frame(0, true, 3840, 2160);
  await server.frame(1, false, 3840, 2160);
  await until("the new capture's frames", () => a.frames().length === 4);
  assert.deepEqual(a.frames(), [4999, 5000, 0, 1]);
  assert.deepEqual(sizes, ["1920x1080", "3840x2160"]);
  await a.relay.close();
  await box.close();
});

test("a frame held back from a viewer that is behind does not count as its size: the viewer shows nothing of it", async () => {
  const sizes: string[] = [];
  const { server, box, clock, relay, settle } = setup({ lagMs: 50, onSize: (size) => sizes.push(`${size.width}x${size.height}`) });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  await server.frame(1, true, 1920, 1080);
  await until("a frame", () => a.frames().length === 1);
  clock.advance(80);
  await server.frame(2, true, 3840, 2160);
  await settle(a);
  assert.deepEqual(a.frames(), [1]);
  assert.deepEqual(sizes, ["1920x1080"], "not the size of the frame it did not get");
  await a.relay.close();
  await box.close();
});

test("a viewer that caught up asks for its key frame again until one comes, on the input connection when it is open (Selkies takes a viewer's once a second)", async () => {
  const { server, box, clock, relay, give, settle } = setup({ lagMs: 50 });
  const a = relay("a");
  await until("the page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  const requests = () => page.received.filter((message) => message === "REQUEST_KEYFRAME").length;
  await server.frame(1, true);
  await until("a frame", () => a.frames().length === 1);
  clock.advance(80);
  // Frame 2 comes while the viewer is behind, and is dropped; then it catches up.
  await server.frame(2, false);
  await settle(a);
  await a.relay.receive("CLIENT_FRAME_ACK 1 0");
  await server.frame(3, false);
  await until("the first request", () => requests() === 1);
  await server.frame(4, false);
  await settle(a);
  assert.equal(requests(), 1, "not again within 250 ms");
  clock.advance(260);
  await server.frame(5, false);
  await until("the second request", () => requests() === 2);
  assert.deepEqual(a.frames(), [1], "no frame until the key frame");

  // With the box's input connection open, it asks there instead.
  give("a");
  await a.relay.receive("kd,65");
  const input = server.pages[1]!;
  await until("the key", () => input.received.includes("kd,65"));
  clock.advance(260);
  await server.frame(6, false);
  await until("the request on the input connection", () => input.received.includes("REQUEST_KEYFRAME"));
  await settle(a);
  assert.equal(requests(), 2, "not on the viewer's own");
  await server.frame(7, true);
  await until("the key frame", () => a.frames().length === 2);
  assert.deepEqual(a.frames(), [1, 7]);
  await a.relay.close();
  await box.close();
});

test("a box's connections take turns a spacing apart, and one Selkies refused waits a whole spacing from then", async () => {
  const clock = new FakeClock();
  const spacing = new Spacing(60, clock);
  await Promise.all([spacing.turn(), spacing.turn(), spacing.turn()]);
  assert.deepEqual(clock.sleeps, [60, 60], "the second and third each waited a spacing");
  // An attempt that took long, then was refused: the next waits a whole spacing from the refusal, not from its turn.
  clock.advance(500);
  await spacing.turn();
  clock.advance(100);
  spacing.refused();
  await spacing.turn();
  assert.deepEqual(clock.sleeps, [60, 60, 60]);

  // Through the relay: two viewers and the input connection each wait their turn, and Selkies refuses none.
  const { server, box, clock: boxClock, relay, give } = setup({ spacingMs: 60 });
  const a = relay("a");
  const b = relay("b");
  give("a");
  await a.relay.receive("kd,1");
  await until("three pages", () => server.pages.length === 3);
  assert.deepEqual(boxClock.sleeps, [60, 60]);
  assert.equal(server.refused, 0);
  await until("both first messages", () => a.got.includes("MODE websockets") && b.got.includes("MODE websockets"));
  await a.relay.close();
  await b.relay.close();
  await box.close();
});

test("a connection Selkies refuses for coming too soon (4029) opens again, a spacing later", async () => {
  const { server, box, clock, relay } = setup({ refuse: 1, spacingMs: 30 });
  const c = relay("c");
  await until("the page", () => server.pages.length === 1);
  await until("its first message", () => c.got.includes("MODE websockets"));
  assert.equal(server.refused, 1);
  assert.deepEqual(clock.sleeps, [30]);
  await c.relay.close();
  await box.close();
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

test("a viewer's word on 4:4:4 goes to bb-box, not to Selkies; bb-box asks the display for it over its controller connection", async () => {
  const { server, box } = setup();
  const open = async () => server.channel();
  const end = viewer();
  const said: boolean[] = [];
  const relay = new SelkiesRelay({ viewer: end.end, box, open, mayInput: () => false, onFullColour: (yes) => void said.push(yes) });
  await until("the viewer's page", () => server.pages.length === 1);
  const page = server.pages[0]!;
  await relay.receive("BB_FULLCOLOR,1");
  await relay.receive("BB_FULLCOLOR,0");
  await relay.receive("BB_FULLCOLOR,2");
  await relay.receive("STOP_VIDEO");
  await until("the video request", () => page.received.at(-1) === "STOP_VIDEO");
  assert.deepEqual(said, [true, false]);
  assert.deepEqual(page.received, ["STOP_VIDEO"], "Selkies never sees bb-box's own message");
  await box.fullColour(true);
  await until("the setting", () => !!server.pages.find((one) => one.role === "controller")?.received.includes('SETTINGS,{"displayId":"primary","video_fullcolor":true}'));
  await relay.close();
  await box.close();
});
