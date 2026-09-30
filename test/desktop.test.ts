// The desktop viewer's pieces: the RFB protocol, the relay that answers the
// box's VNC authentication and drops input from viewers without control, and
// shared control itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Control, ControlError, type ViewerConnection } from "../src/core/control.ts";
import { RfbRelay, restoreSize, type OpenDisplay, type RelayOptions } from "../src/core/relay.ts";
import {
  ClientParser,
  RfbError,
  StreamReader,
  concat,
  keyEvent,
  pointerEvent,
  qemuKeyEvent,
  setDesktopSize,
  setEncodings,
  vncResponse,
} from "../src/core/rfb.ts";
import { FakeRfb, until } from "./fake-rfb.ts";

const bytes = (...values: number[]) => Uint8Array.of(...values);
const text = (value: string) => new TextEncoder().encode(value);

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

/** A ClientCutText: a plain one, or an extended one with its flags. */
function cutText(content: Uint8Array, flags?: number): Uint8Array {
  const body = flags === undefined ? content : concat(u32(flags), content);
  const head = new Uint8Array(8);
  const view = new DataView(head.buffer);
  view.setUint8(0, 6);
  view.setInt32(4, flags === undefined ? body.byteLength : -body.byteLength);
  return concat(head, body);
}

function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

const UPDATE_REQUEST = bytes(3, 1, 0, 0, 0, 0, 5, 0, 3, 32);
const SCREEN = { id: 7, flags: 0 };

test("the VNC answer is DES with each password byte's bits reversed", () => {
  // From single DES in OpenSSL's legacy provider, with the key 0e86ceceeef64e26.
  const challenge = Uint8Array.from({ length: 16 }, (_, index) => index);
  assert.equal(hex(vncResponse(challenge, "password")), "b866924125c8eebb9debc1db61c538e2");
  assert.equal(hex(vncResponse(challenge, "password-longer")), "b866924125c8eebb9debc1db61c538e2", "only the first 8 bytes count");
});

test("the parser splits the viewer's messages however they arrive, and sorts them", () => {
  const stream = [
    setEncodings([0, -316, -308]),
    UPDATE_REQUEST,
    keyEvent(true, 0x61),
    pointerEvent(1, 10, 20),
    cutText(text("hi")),
    cutText(new Uint8Array(0), 1 << 24),
    cutText(text("x"), 1 << 28),
    setDesktopSize(1920, 1080, SCREEN),
    qemuKeyEvent(true, 0x61, 30),
    bytes(248, 0, 0, 0, 0, 0, 0, 1, 2, 9, 9),
  ].reduce(concat);
  const parser = new ClientParser();
  const messages = [...stream].flatMap((byte) => parser.push(bytes(byte)));
  assert.deepEqual(
    messages.map((message) => (message.type === "other" ? `other:${message.class}` : message.type)),
    ["other:pass", "other:pass", "key", "pointer", "other:input", "other:pass", "other:input", "resize", "qemu-key", "other:pass"],
  );
  assert.equal(hex(messages[0]!.bytes), hex(setEncodings([0, -308])), "ExtendedMouseButtons is removed, so a pointer event stays 6 bytes");
  const resize = messages[7]!;
  assert.ok(resize.type === "resize");
  assert.deepEqual([resize.width, resize.height, resize.screen], [1920, 1080, SCREEN]);
  assert.throws(() => new ClientParser().push(bytes(99)), RfbError);
});

/** The viewer's end of a relay: what the relay sent it, read in exact sizes. */
function fakeViewer() {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({ start: (value) => void (controller = value) });
  const viewer = {
    closed: null as { code: number; reason: string } | null,
    reader: new StreamReader(stream),
    send: (sent: Uint8Array) => controller.enqueue(sent.slice()),
    close: (code: number, reason: string) => {
      if (viewer.closed) return;
      viewer.closed = { code, reason };
      controller.close();
    },
  };
  return viewer;
}

/** The reason of a security failure the viewer was sent. */
async function failure(reader: StreamReader): Promise<string> {
  const head = await reader.read(4);
  const length = new DataView(head.buffer, head.byteOffset).getUint32(0);
  return new TextDecoder().decode(await reader.read(length));
}

function relayTo(server: FakeRfb, options: Partial<RelayOptions> & { password?: string } = {}) {
  const viewer = fakeViewer();
  let control = false;
  const ends: string[] = [];
  const resizes: unknown[] = [];
  const open: OpenDisplay = async () => ({
    channel: server.channel(),
    auth: options.password === undefined ? { type: "none" } : { type: "vnc-password", password: options.password },
  });
  const relay = new RfbRelay({
    viewer,
    open,
    mayInput: () => control,
    onResize: (size, screen) => resizes.push([size, screen]),
    onEnd: (by, error) => ends.push(`${by}${error ? `: ${error.message}` : ""}`),
    ...options,
  });
  return {
    relay,
    viewer,
    ends,
    resizes,
    give: (value: boolean) => void (control = value),
    /** The viewer's side of the handshake, as noVNC does it, asking not to share. */
    async handshake() {
      assert.equal(new TextDecoder().decode(await viewer.reader.read(12)), "RFB 003.008\n");
      await relay.receive(text("RFB 003.008\n"));
      assert.equal(hex(await viewer.reader.read(2)), "0101", "the relay offers security type None only");
      await relay.receive(bytes(1));
      return viewer.reader.read(4);
    },
    async init() {
      assert.equal(hex(await this.handshake()), "00000000");
      await relay.receive(bytes(0));
      const head = await viewer.reader.read(24);
      const view = new DataView(head.buffer, head.byteOffset);
      await viewer.reader.read(view.getUint32(20));
      return { width: view.getUint16(0), height: view.getUint16(2) };
    },
  };
}

test("the relay answers the box's VNC password and passes only the holder's input", async () => {
  const server = new FakeRfb({ password: "secret12" });
  const relay = relayTo(server, { password: "secret12" });
  assert.deepEqual(await relay.init(), { width: 1280, height: 800 });
  const [box] = server.connections;
  assert.equal(box!.shared, 1, "the relay always asks to share the desktop");

  const watch = [UPDATE_REQUEST, cutText(new Uint8Array(0), 1 << 24)].reduce(concat);
  const input = [keyEvent(true, 0x61), pointerEvent(1, 5, 5), cutText(text("pasted")), setDesktopSize(1920, 1080, SCREEN), bytes(250, 0, 1, 2)].reduce(concat);
  await relay.relay.receive(concat(watch, input));
  await until("the watcher's messages", () => box!.received.byteLength >= watch.byteLength);
  assert.equal(hex(box!.received), hex(watch), "a watcher's input, clipboard writes, resizes and power requests are dropped");
  assert.deepEqual(relay.resizes, []);

  relay.give(true);
  await relay.relay.receive(input);
  await until("the holder's input", () => box!.received.byteLength >= watch.byteLength + input.byteLength);
  assert.equal(hex(box!.received), hex(concat(watch, input)));
  assert.deepEqual(relay.resizes, [[{ width: 1920, height: 1080 }, SCREEN]]);
  assert.ok(relay.relay.holding, "the key and button are still down");

  // The box's pixels pass through untouched: the answer to the update request, then more.
  assert.equal(hex(await relay.viewer.reader.read(4)), "00000000");
  await box!.send(bytes(0, 0, 0, 1, 9, 9));
  assert.equal(hex(await relay.viewer.reader.read(6)), "000000010909");

  await relay.relay.close();
  assert.equal(
    hex(box!.received.subarray(watch.byteLength + input.byteLength)),
    hex(concat(keyEvent(false, 0x61), pointerEvent(0, 5, 5))),
    "closing lets go of what the viewer held down",
  );
  assert.deepEqual(relay.ends, ["viewer"]);
  await until("the box's side to close", () => box!.closed);
});

test("release lets go of held keys and buttons without closing", async () => {
  const server = new FakeRfb();
  const relay = relayTo(server);
  await relay.init();
  relay.give(true);
  await relay.relay.receive([qemuKeyEvent(true, 0xffe1, 42), keyEvent(true, 0x62), keyEvent(false, 0x62), pointerEvent(4, 1, 2)].reduce(concat));
  const [box] = server.connections;
  const before = box!.received.byteLength;
  await relay.relay.release();
  await until("the releases", () => box!.received.byteLength > before);
  assert.equal(hex(box!.received.subarray(before)), hex(concat(qemuKeyEvent(false, 0xffe1, 42), pointerEvent(0, 1, 2))));
  assert.equal(relay.relay.holding, false);
  await relay.relay.close();
});

test("a wrong password reaches the viewer as a security failure with the reason", async () => {
  const relay = relayTo(new FakeRfb({ password: "secret12" }), { password: "wrong" });
  const result = await relay.handshake();
  assert.equal(hex(result), "00000001");
  const reason = await failure(relay.viewer.reader);
  assert.equal(reason, "The box's desktop refused its VNC password: Authentication failed");
  assert.equal(relay.viewer.closed?.code, 1011);
  assert.deepEqual(relay.ends, [`box: ${reason}`]);
});

test("a display that cannot open reaches the viewer as a security failure", async () => {
  const relay = relayTo(new FakeRfb(), {
    open: async () => {
      throw new Error("Box calm-otter is not running, so its desktop cannot show.");
    },
  });
  assert.equal(hex(await relay.handshake()), "00000001");
  assert.match(await failure(relay.viewer.reader), /is not running/);
});

test("the box closing its desktop closes the viewer", async () => {
  const server = new FakeRfb();
  const relay = relayTo(server);
  await relay.init();
  await server.connections[0]!.end();
  await until("the viewer to close", () => relay.viewer.closed !== null);
  assert.deepEqual(relay.viewer.closed, { code: 1000, reason: "The box's desktop closed the connection." });
  assert.deepEqual(relay.ends, ["box"]);
});

test("restoring the size sets the desktop back over a connection of its own", async () => {
  const server = new FakeRfb({ password: "secret12", width: 1920, height: 1080 });
  const open: OpenDisplay = async () => ({ channel: server.channel(), auth: { type: "vnc-password", password: "secret12" } });
  assert.equal(await restoreSize(open, { width: 1280, height: 800 }, SCREEN), true);
  assert.deepEqual([server.width, server.height], [1280, 800]);
  assert.equal(await restoreSize(open, { width: 1280, height: 800 }, SCREEN), false, "nothing to do at the size already");
  assert.ok(server.connections.every((connection) => connection.closed));
});

/** Shared control over a box whose viewers are plain records. */
function control(options: { pause?: () => Promise<void>; staleMs?: number } = {}) {
  const events: string[] = [];
  const restores: unknown[] = [];
  const errors: string[] = [];
  const value = new Control({
    changed: (boxId) => events.push(`${boxId} ${value.view(boxId).owner}`),
    restore: async (_boxId, size, screen) => void restores.push([size, screen]),
    pause: options.pause,
    logError: (operation, error) => errors.push(`${operation}: ${String(error)}`),
    staleMs: options.staleMs,
  });
  const connect = (viewer: string, box = "box1") => {
    const connection: ViewerConnection & { releases: number } = {
      viewer,
      releases: 0,
      release: async () => {
        connection.releases++;
      },
    };
    value.attach(box, connection);
    return connection;
  };
  return { value, events, restores, errors, connect };
}

test("a person takes control from the agent in one viewer, and hands it back", async () => {
  const { value, events, restores, connect } = control();
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null });
  await assert.rejects(value.take("box1", "viewer-a"), ControlError, "a viewer must be connected");

  const a = connect("viewer-a");
  connect("viewer-b");
  value.seen("box1", { width: 1280, height: 800 });
  assert.deepEqual(await value.take("box1", "viewer-a"), { owner: "human", holder: "viewer-a" });
  assert.deepEqual(events, ["box1 none", "box1 human"], "control passes through none while the agent stops");
  assert.equal(value.mayInput("box1", "viewer-a"), true);
  assert.equal(value.mayInput("box1", "viewer-b"), false);

  // Taking again from the same viewer changes nothing.
  await value.take("box1", "viewer-a");
  assert.equal(events.length, 2);

  value.seen("box1", { width: 1920, height: 1080 });
  value.resized("box1", "viewer-a", SCREEN);
  assert.deepEqual(await value.handBack("box1"), { owner: "agent", holder: null });
  assert.equal(a.releases, 1, "handing back lets go of what the holder held down");
  assert.deepEqual(restores, [[{ width: 1280, height: 800 }, SCREEN]], "the size from before the person took control");
  assert.equal(value.mayInput("box1", "viewer-a"), false);
});

test("another viewer taking control lets go of the first viewer's input", async () => {
  const { value, connect } = control();
  const a = connect("viewer-a");
  connect("viewer-b");
  await value.take("box1", "viewer-a");
  await value.take("box1", "viewer-b");
  assert.equal(a.releases, 1);
  assert.deepEqual(value.view("box1"), { owner: "human", holder: "viewer-b" });
});

test("a failed pause leaves control with the agent", async () => {
  const { value, connect } = control({
    pause: async () => {
      throw new Error("the agent's session did not stop");
    },
  });
  connect("viewer-a");
  await assert.rejects(value.take("box1", "viewer-a"), /Taking control failed, so the agent keeps it: the agent's session did not stop/);
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null });
});

test("control goes back to the agent when the holder's viewer stays away", async () => {
  const { value, connect } = control({ staleMs: 30 });
  const a = connect("viewer-a");
  await value.take("box1", "viewer-a");

  // A reload: the viewer comes back within the time.
  value.detach("box1", a, "viewer");
  const again = connect("viewer-a");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(value.view("box1"), { owner: "human", holder: "viewer-a" });

  value.detach("box1", again, "viewer");
  await until("the agent to have control", () => value.view("box1").owner === "agent");
});

test("the box ending the holder's connection gives control back at once", async () => {
  const { value, connect } = control();
  const a = connect("viewer-a");
  await value.take("box1", "viewer-a");
  value.detach("box1", a, "box");
  await until("the agent to have control", () => value.view("box1").owner === "agent");
});

test("a box that stops or goes gives control back and forgets its size", async () => {
  const { value, restores, connect } = control();
  connect("viewer-a");
  value.seen("box1", { width: 1280, height: 800 });
  await value.take("box1", "viewer-a");
  value.resized("box1", "viewer-a", SCREEN);
  value.forget("box1");
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null });
  await value.handBack("box1");
  assert.deepEqual(restores, [], "a new desktop has nothing to restore");
});
