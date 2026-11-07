import assert from "node:assert/strict";
import { test } from "node:test";
import { VoxlRelay, ViewerInput, fullFrameId, viewerFrame, viewerMessageKind, CLIPBOARD_CHUNK_BYTES } from "../src/core/voxl.ts";
import { pngPixels } from "../src/core/png.ts";
import type { Message } from "../src/core/websocket.ts";
import { FakeVoxl, voxlCursor, voxlVideo, type VoxlClient } from "./fake-voxl.ts";
import { until } from "./fake-rfb.ts";

function viewer() {
  const got: Message[] = [];
  let closed: { code: number; reason: string } | null = null;
  return {
    got,
    get closed() {
      return closed;
    },
    texts: () => got.filter((message): message is string => typeof message === "string"),
    frames: () => got.filter((message): message is Uint8Array => typeof message !== "string"),
    end: { send: (message: Message) => void got.push(message), close: (code: number, reason: string) => void (closed = { code, reason }) },
  };
}

function setup(options: { control?: () => boolean; size?: { width: number; height: number } } = {}) {
  const server = new FakeVoxl(options.size);
  const sizes: { width: number; height: number }[] = [];
  const resizes: { width: number; height: number }[] = [];
  const ends: ("viewer" | "box")[] = [];
  const connect = (mayInput: () => boolean = options.control ?? (() => true)) => {
    const end = viewer();
    const relay = new VoxlRelay({
      viewer: end.end,
      open: async () => server.channel(),
      mayInput,
      onSize: (size) => sizes.push(size),
      onResize: (size) => resizes.push(size),
      onEnd: (by) => ends.push(by),
    });
    return Object.assign(end, { relay });
  };
  return { server, sizes, resizes, ends, connect };
}

async function clientOf(server: FakeVoxl, index = 0): Promise<VoxlClient> {
  await until("voxl's client", () => server.clients.length > index);
  return server.clients[index]!;
}

async function settled(relay: VoxlRelay, client: VoxlClient): Promise<void> {
  const before = client.received.filter((message) => message === "kf").length;
  await relay.receive("REQUEST_KEYFRAME");
  await until("voxl to have it all", () => client.received.filter((message) => message === "kf").length > before);
}

test("the relay opens voxl's WebSocket as localhost with no Origin, so voxl's host and origin checks pass", async () => {
  const { server, connect } = setup();
  connect();
  const client = await clientOf(server);
  assert.equal(client.path, "/ws");
  assert.equal(client.host, "localhost");
  assert.equal(client.origin, null);
});

test("a frame goes to the viewer in the viewer's 12-byte header, at the latest hello's size, with its pixels untouched and not copied", async () => {
  const header = new Uint8Array(16);
  const body = new Uint8Array([0, 0, 0, 1, 0x67, 9, 8, 7]);
  const voxl = voxlVideo(0x00012345, true, body);
  const translated = viewerFrame(voxl, { width: 1920, height: 1080 })!;
  assert.equal(translated.id, 0x00012345);
  assert.equal(translated.key, true);
  assert.equal(translated.frame.buffer, voxl.buffer);
  assert.deepEqual([...translated.frame.subarray(0, 12)], [4, 0x11, 0x23, 0x45, 0, 0, 1920 >> 8, 1920 & 255, 1080 >> 8, 1080 & 255, 0, 0]);
  assert.deepEqual([...translated.frame.subarray(12)], [...body]);
  assert.equal(viewerFrame(header, { width: 1, height: 1 }), null);
  const delta = viewerFrame(voxlVideo(7, false), { width: 800, height: 600 })!;
  assert.equal(delta.frame[1], 0x10);

  const { server, connect, sizes } = setup();
  const a = connect();
  const client = await clientOf(server);
  await until("the hello's size", () => sizes.length === 1);
  await client.send(voxlVideo(65537, true));
  await until("the frame", () => a.frames().length === 1);
  const [frame] = a.frames();
  assert.equal((frame![2]! << 8) | frame![3]!, 1);
  assert.equal((frame![6]! << 8) | frame![7]!, 1920);
});

test("a frame of several stripes is not passed on, as the viewer decodes one stream", () => {
  const voxl = voxlVideo(1, true);
  voxl[11] = 2;
  assert.equal(viewerFrame(voxl, { width: 1920, height: 1080 }), null);
});

test("the viewer's acknowledgement goes back with voxl's full frame number, across the 16-bit wrap", async () => {
  assert.equal(fullFrameId(1, 65537), 65537);
  assert.equal(fullFrameId(65535, 65537), 65535);
  assert.equal(fullFrameId(3, 3), 3);
  assert.equal(fullFrameId(0xfffe, 0x20001), 0x1fffe);
  const { server, connect } = setup({ control: () => false });
  const a = connect();
  const client = await clientOf(server);
  await client.send(voxlVideo(65537, true));
  await until("the frame", () => a.frames().length === 1);
  await a.relay.receive("CLIENT_FRAME_ACK 1 0");
  await settled(a.relay, client);
  assert.ok(client.received.includes("a,65537"), JSON.stringify(client.received));
});

test("a viewer without control only watches: acknowledgements, video on and off, key frames and ping answers reach voxl, and nothing that acts", async () => {
  const { server, connect, resizes } = setup({ control: () => false });
  const a = connect();
  const client = await clientOf(server);
  await client.send(voxlVideo(9, true));
  await until("the frame", () => a.frames().length === 1);
  for (const message of ["kd,65", "ku,65", "kr", "m,10,20,1,0", "m2,0,0,8,3", "cw,aGk=", "cb,image/png,iVBO", "cws,x,2", "cwd,x,aGk=", "cwe,x", "r,1280x720", "SETTINGS,{}", "BB_FULLCOLOR,1"]) await a.relay.receive(message);
  for (const message of ["START_VIDEO", "STOP_VIDEO", "CLIENT_FRAME_ACK 9 0", "VOXL_PONG,77"]) await a.relay.receive(message);
  await settled(a.relay, client);
  const sent = client.received.filter((message) => message !== "kf");
  assert.deepEqual(sent, ["v,1", "v,0", "a,9", "po,77"]);
  assert.deepEqual(resizes, []);
});

test("the viewer with control drives the desktop in voxl's own commands: keys, buttons, the wheel and the clipboard", async () => {
  const { server, connect } = setup();
  const a = connect();
  const client = await clientOf(server);
  await until("voxl's hello reached the relay", () => a.relay.size !== null);
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
  const text = "voxl, with commas, and ü";
  const utf8 = Buffer.from(text, "utf8");
  for (const message of [
    "kd,65",
    "ku,65",
    "m,100,200,0,0",
    "m,100,200,1,0",
    "m,110,210,5,0",
    "m,110,210,0,0",
    "m2,0,0,0,3",
    "m2,0,0,16,3",
    "m2,0,0,0,3",
    "m2,0,0,8,2",
    `cw,${utf8.toString("base64")}`,
    "cws,t1,8",
    `cwd,t1,${Buffer.from("chunk").toString("base64")}`,
    `cwd,t1,${Buffer.from("ed!").toString("base64")}`,
    "cwe,t1",
    `cb,image/png,${Buffer.from(png).toString("base64")}`,
    `cb,image/jpeg,${Buffer.from(png).toString("base64")}`,
  ])
    await a.relay.receive(message);
  await settled(a.relay, client);
  const sent = client.received.filter((message) => message !== "kf");
  const image = sent.find((message): message is Uint8Array => typeof message !== "string");
  assert.deepEqual(
    sent.filter((message) => typeof message === "string"),
    ["k,65,1", "k,65,0", "m,100,200", "m,100,200", "b,1,1", "m,110,210", "b,3,1", "m,110,210", "b,1,0", "b,3,0", "s,0,3", "s,0,-2", `c,${text}`, "c,chunked!"],
  );
  assert.deepEqual([...image!], [0x11, ...png]);
  assert.equal(sent.filter((message) => typeof message !== "string").length, 1);
});

test("the box's clipboard goes only to the viewer with control, text and PNG, in parts past a chunk", async () => {
  let holder = "a";
  const { server, connect } = setup();
  const a = connect(() => holder === "a");
  const b = connect(() => holder === "b");
  const [ca, cb] = [await clientOf(server, 0), await clientOf(server, 1)];
  await ca.send(JSON.stringify({ t: "clip", d: "from the box" }));
  await cb.send(JSON.stringify({ t: "clip", d: "from the box" }));
  const small = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
  const large = new Uint8Array(CLIPBOARD_CHUNK_BYTES + 10).fill(7);
  for (const client of [ca, cb]) {
    await client.send(new Uint8Array([0x04, ...small]));
    const message = new Uint8Array(large.byteLength + 1);
    message[0] = 0x04;
    message.set(large, 1);
    await client.send(message);
    await client.send(voxlVideo(1, true));
  }
  await until("both frames", () => a.frames().length === 1 && b.frames().length === 1);
  assert.ok(a.texts().includes(`clipboard,${Buffer.from("from the box").toString("base64")}`));
  assert.ok(a.texts().includes(`clipboard_binary,image/png,${Buffer.from(small).toString("base64")}`));
  const start = a.texts().indexOf(`clipboard_start,image/png,${large.byteLength}`);
  assert.ok(start >= 0);
  assert.equal(a.texts()[start + 3], "clipboard_finish");
  assert.equal(Buffer.concat(a.texts().slice(start + 1, start + 3).map((each) => Buffer.from(each.slice("clipboard_data,".length), "base64"))).byteLength, large.byteLength);
  assert.deepEqual(b.texts().filter((each) => each.startsWith("clipboard")), []);
  holder = "b";
  await cb.send(JSON.stringify({ t: "clip", d: "now b's" }));
  await cb.send(voxlVideo(2, false));
  await until("b's second frame", () => b.frames().length === 2);
  assert.ok(b.texts().includes(`clipboard,${Buffer.from("now b's").toString("base64")}`));
});

test("voxl's pings go to the viewer and its answers back, so voxl sees the whole round trip", async () => {
  const { server, connect } = setup({ control: () => false });
  const a = connect();
  const client = await clientOf(server);
  await client.send(JSON.stringify({ t: "ping", s: 123456 }));
  await until("the ping", () => a.texts().includes("VOXL_PING,123456"));
  await a.relay.receive("VOXL_PONG,123456");
  await a.relay.receive("VOXL_PONG,1;r");
  await settled(a.relay, client);
  assert.deepEqual(client.received.filter((message) => typeof message === "string" && message.startsWith("po,")), ["po,123456"]);
});

test("a resize from the viewer with control goes to bb-box, never to voxl", async () => {
  let control = true;
  const { server, connect, resizes } = setup({ control: () => control });
  const a = connect();
  const client = await clientOf(server);
  await a.relay.receive("r,1280x720");
  control = false;
  await a.relay.receive("r,1024x768");
  await settled(a.relay, client);
  assert.deepEqual(resizes, [{ width: 1280, height: 720 }]);
  assert.ok(!client.received.some((message) => typeof message === "string" && /^(sz|r),/.test(message)));
});

test("the desktop's size is said once for each new size voxl's hello gives", async () => {
  const { server, connect, sizes } = setup();
  connect();
  await clientOf(server);
  await until("the first size", () => sizes.length === 1);
  await server.everyone(server.hello());
  await server.resize(1280, 720);
  await until("the new size", () => sizes.length === 2);
  assert.deepEqual(sizes, [
    { width: 1920, height: 1080 },
    { width: 1280, height: 720 },
  ]);
});

test("hand-back releases what the viewer held, once, and nothing when it held nothing", async () => {
  const { server, connect } = setup();
  const a = connect();
  const client = await clientOf(server);
  await a.relay.release();
  await a.relay.receive("kd,65");
  await a.relay.receive("m,5,5,1,0");
  assert.equal(a.relay.holding, true);
  await a.relay.release();
  await a.relay.release();
  await settled(a.relay, client);
  assert.deepEqual(client.received.filter((message) => message === "r"), ["r"]);
  assert.equal(a.relay.holding, false);
});

function slowToOpen(control: () => boolean) {
  const server = new FakeVoxl();
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const end = viewer();
  const relay = new VoxlRelay({
    viewer: end.end,
    open: async () => {
      await gate;
      return server.channel();
    },
    mayInput: control,
  });
  return { server, relay, open };
}

test("input a viewer sent while voxl's connection opened never reaches voxl once its control has ended, and hand-back does not wait for the connection", async () => {
  let control = true;
  const { server, relay, open } = slowToOpen(() => control);
  await relay.receive("kd,97");
  await relay.receive("m,5,5,1,0");
  control = false;
  const handedBack = await Promise.race([relay.release().then(() => "handed back"), new Promise((resolve) => setTimeout(() => resolve("waited for the connection"), 1000))]);
  assert.equal(handedBack, "handed back");
  open();
  const client = await clientOf(server);
  await settled(relay, client);
  assert.deepEqual(client.received.filter((message) => message !== "kf"), [], "nothing from the viewer that lost control, not even a release of what never arrived");
});

test("input a viewer sent while voxl's connection opened reaches voxl in order once it opens, while the viewer keeps control", async () => {
  const { server, relay, open } = slowToOpen(() => true);
  await relay.receive("kd,97");
  await relay.receive("START_VIDEO");
  await relay.receive("ku,97");
  open();
  const client = await clientOf(server);
  await settled(relay, client);
  assert.deepEqual(client.received.filter((message) => message !== "kf"), ["k,97,1", "v,1", "k,97,0"]);
  await relay.release();
  await settled(relay, client);
  assert.deepEqual(client.received.filter((message) => message === "r"), ["r"], "hand-back releases once input reached voxl");
});

test("a viewer that goes while holding a key releases it before its connection closes", async () => {
  const { server, connect, ends } = setup();
  const a = connect();
  const client = await clientOf(server);
  await a.relay.receive("kd,65");
  await settled(a.relay, client);
  await a.relay.close();
  await until("the close", () => client.received.includes("close"));
  const after = client.received.slice(client.received.indexOf("k,65,1"));
  assert.deepEqual(after.filter((message) => message === "r" || message === "close"), ["r", "close"]);
  assert.deepEqual(ends, ["viewer"]);
});

test("the cursor's image becomes the viewer's cursor message, a PNG with its hotspot, and a hidden cursor a clear pixel", async () => {
  const { server, connect } = setup({ control: () => false });
  const a = connect();
  const client = await clientOf(server);
  const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 0, 0, 0, 0]);
  await client.send(voxlCursor(2, 2, 1, 0, rgba));
  await client.send(voxlCursor(0, 0, 0, 0, new Uint8Array()));
  await until("both cursors", () => a.texts().filter((text) => text.startsWith("cursor,")).length === 2);
  const [shape, hidden] = a.texts().filter((text) => text.startsWith("cursor,")).map((text) => JSON.parse(text.slice(7)) as { curdata: string; hotx: number; hoty: number });
  assert.deepEqual([shape!.hotx, shape!.hoty], [1, 0]);
  const pixels = pngPixels(Buffer.from(shape!.curdata, "base64"));
  assert.deepEqual([pixels.width, pixels.height, ...pixels.rgba], [2, 2, ...rgba]);
  const clear = pngPixels(Buffer.from(hidden!.curdata, "base64"));
  assert.deepEqual([clear.width, clear.height, clear.rgba[3]], [1, 1, 0]);
});

test("voxl dropping a viewer that fell too far behind ends the viewer's connection, saying why", async () => {
  const { server, connect, ends } = setup();
  const a = connect();
  const client = await clientOf(server);
  await client.send(JSON.stringify({ t: "close" }));
  await until("the viewer's close", () => a.closed !== null);
  assert.equal(a.closed!.code, 1011);
  assert.match(a.closed!.reason, /fallen too far behind/);
  assert.deepEqual(ends, ["box"]);
});

test("a box whose voxl cannot be reached closes the viewer with the reason", async () => {
  const end = viewer();
  new VoxlRelay({
    viewer: end.end,
    open: async () => {
      throw new Error("The box's voxl did not start: no display");
    },
    mayInput: () => true,
  });
  await until("the viewer's close", () => end.closed !== null);
  assert.equal(end.closed!.code, 1011);
  assert.match(end.closed!.reason, /did not start: no display/);
});

test("each viewer message is sorted as watching, input, a resize, or dropped", () => {
  assert.equal(viewerMessageKind("CLIENT_FRAME_ACK 3 0"), "watching");
  assert.equal(viewerMessageKind("VOXL_PONG,1"), "watching");
  assert.equal(viewerMessageKind("kd,65"), "input");
  assert.equal(viewerMessageKind("cbs,id,image/png,10"), "input");
  assert.equal(viewerMessageKind("r,1280x720"), "resize");
  assert.equal(viewerMessageKind("r,huge"), "drop");
  assert.equal(viewerMessageKind("co,1"), "drop");
  assert.equal(viewerMessageKind("SETTINGS,{}"), "drop");
});

test("a clipboard transfer larger than it said is dropped, and one that never ends sends nothing", () => {
  const input = new ViewerInput();
  assert.deepEqual(input.translate("cws,a,2"), []);
  assert.deepEqual(input.translate(`cwd,a,${Buffer.from("too long").toString("base64")}`), []);
  assert.deepEqual(input.translate("cwe,a"), []);
  assert.deepEqual(input.translate("cws,b,2"), []);
  assert.deepEqual(input.translate(`cwd,b,${Buffer.from("ok").toString("base64")}`), []);
  assert.deepEqual(input.translate("cwe,b"), ["c,ok"]);
});
