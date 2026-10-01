// The desktop viewer's pieces: the RFB protocol, the relay that answers the
// box's VNC authentication and drops input from viewers without control, and
// shared control itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Control, ControlError, type KeptControl, type ViewerConnection } from "../src/core/control.ts";
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
  type Screen,
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

test("a resize below the display's smallest size is raised to it, in each dimension", async () => {
  const server = new FakeRfb();
  const relay = relayTo(server, { minSize: () => ({ width: 800, height: 600 }) });
  await relay.init();
  relay.give(true);
  const [box] = server.connections;
  // noVNC's resize, and one with no screens.
  const sent = [setDesktopSize(518, 722, SCREEN), setDesktopSize(1024, 500, SCREEN), setDesktopSize(1280, 800, SCREEN), bytes(251, 0, 2, 0, 1, 144, 0, 0)];
  const raised = [setDesktopSize(800, 722, SCREEN), setDesktopSize(1024, 600, SCREEN), setDesktopSize(1280, 800, SCREEN), bytes(251, 0, 3, 32, 2, 88, 0, 0)];
  await relay.relay.receive(sent.reduce(concat));
  const length = raised.reduce(concat).byteLength;
  await until("the resizes", () => box!.received.byteLength >= length);
  assert.equal(hex(box!.received), hex(raised.reduce(concat)));
  assert.deepEqual(relay.resizes, [
    [{ width: 800, height: 722 }, SCREEN],
    [{ width: 1024, height: 600 }, SCREEN],
    [{ width: 1280, height: 800 }, SCREEN],
    [{ width: 800, height: 600 }, null],
  ]);
  await relay.relay.close();
});

test("a raised size asked for again goes with no screens, so that Xvnc refuses it and noVNC stops asking", async () => {
  const server = new FakeRfb();
  const relay = relayTo(server, { minSize: () => ({ width: 800, height: 600 }) });
  await relay.init();
  relay.give(true);
  const [box] = server.connections;
  // Xvnc sets 800x722 and says so, so noVNC asks for its pane again, which
  // is refused. Asked for later, or after a size the box takes as it is, the
  // size is raised again. A pane of another size raised to the size just
  // set is refused; one raised to another width or height is not.
  const asks = [[518, 722], [518, 722], [518, 722], [1280, 800], [518, 722], [518, 500], [1024, 500], [1024, 300]];
  const passes: [number, number, Screen | null][] = [
    [800, 722, SCREEN],
    [800, 722, null],
    [800, 722, SCREEN],
    [1280, 800, SCREEN],
    [800, 722, SCREEN],
    [800, 600, SCREEN],
    [1024, 600, SCREEN],
    [1024, 600, null],
  ];
  for (const [width, height] of asks) await relay.relay.receive(setDesktopSize(width!, height!, SCREEN));
  const passed = passes.map(([width, height, screen]) => setDesktopSize(width, height, screen)).reduce(concat);
  await until("the resizes", () => box!.received.byteLength >= passed.byteLength);
  assert.equal(hex(box!.received), hex(passed));
  assert.equal(hex(setDesktopSize(800, 722, null)), "fb00032002d20000", "a SetDesktopSize with no screens");
  assert.deepEqual(
    relay.resizes,
    passes.map(([width, height]) => [{ width, height }, SCREEN]),
    "the backend hears of each, so its own resize is as before",
  );
  await relay.relay.close();
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

test("input the box can no longer take ends the relay, and no write is left unawaited", async () => {
  const server = new FakeRfb();
  let broken = false;
  const relay = relayTo(server, {
    open: async () => {
      const channel = server.channel();
      const writer = channel.writable.getWriter();
      const writable = new WritableStream<Uint8Array>({
        write: (chunk) => (broken ? Promise.reject(new Error("The box's socket closed.")) : writer.write(chunk)),
      });
      return { channel: { ...channel, writable }, auth: { type: "none" } };
    },
  });
  await relay.init();
  relay.give(true);
  const unhandled: unknown[] = [];
  const record = (reason: unknown) => void unhandled.push(reason);
  process.on("unhandledRejection", record);
  try {
    broken = true;
    await relay.relay.receive([keyEvent(true, 0x61), keyEvent(false, 0x61), pointerEvent(1, 5, 5)].reduce(concat));
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    process.off("unhandledRejection", record);
  }
  assert.deepEqual(unhandled, [], "an unhandled rejection ends the plugin's process");
  assert.deepEqual(relay.ends, ["box: The box's socket closed."]);
  assert.equal(relay.viewer.closed?.code, 1011);
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
function control(
  options: { pause?: () => Promise<void>; keep?: (kept: readonly KeptControl[]) => Promise<void>; stopping?: (boxId: string, kept: boolean) => Promise<void>; staleMs?: number; reconnectMs?: number } = {},
) {
  const events: string[] = [];
  const restores: unknown[] = [];
  const errors: string[] = [];
  const value = new Control({
    changed: (boxId) => events.push(`${boxId} ${value.view(boxId).owner}`),
    restore: async (_boxId, size, screen) => void restores.push([size, screen]),
    pause: options.pause,
    keep: options.keep,
    stopping: options.stopping,
    logError: (operation, error) => errors.push(`${operation}: ${String(error)}`),
    staleMs: options.staleMs,
    reconnectMs: options.reconnectMs,
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

test("the agent takes control back as a hand-back, and the view names the viewer it took it from until a person takes it (038)", async () => {
  const { value, events, restores, connect } = control();
  assert.equal(await value.takeBack("box1"), false, "nothing to take while the agent has it");
  const a = connect("viewer-a");
  connect("viewer-b");
  value.seen("box1", { width: 1280, height: 800 });
  await value.take("box1", "viewer-a");
  value.resized("box1", "viewer-a", SCREEN);

  assert.equal(await value.takeBack("box1"), true);
  assert.equal(a.releases, 1, "the holder's held keys go up");
  assert.deepEqual(restores, [[{ width: 1280, height: 800 }, SCREEN]], "the size from before the person took control");
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null, takenFrom: "viewer-a" });
  assert.deepEqual(events, ["box1 none", "box1 human", "box1 none", "box1 agent"]);
  assert.equal(await value.takeBack("box1"), false, "the agent has it already");
  assert.equal(events.length, 4);

  await value.take("box1", "viewer-b");
  assert.deepEqual(value.view("box1"), { owner: "human", holder: "viewer-b" }, "a person taking control again clears it");
  await value.handBack("box1");
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null }, "a person's own hand-back says nothing of the agent");

  await value.take("box1", "viewer-a");
  await value.takeBack("box1");
  const before = events.length;
  value.forget("box1");
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null }, "a box that stops forgets it");
  assert.deepEqual(events.slice(before), ["box1 agent"], "and its panels hear of it");
});

test("another viewer taking control stops the first viewer's input, then lets go of it", async () => {
  const { value, connect } = control();
  const a = connect("viewer-a");
  connect("viewer-b");
  await value.take("box1", "viewer-a");
  const release = a.release;
  let inputWhileReleasing: boolean | null = null;
  a.release = async () => {
    inputWhileReleasing = value.mayInput("box1", "viewer-a");
    await release();
  };
  await value.take("box1", "viewer-b");
  assert.equal(a.releases, 1);
  assert.equal(inputWhileReleasing, false, "a key the first viewer presses while it is let go would stay down");
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

test("the box ending the holder's connection keeps control while the viewer connects again, then gives it back sooner than a viewer going (020)", async () => {
  const { value, connect } = control({ staleMs: 60_000, reconnectMs: 30 });
  const a = connect("viewer-a");
  await value.take("box1", "viewer-a");

  // The relay's connection to the box dropped, and the viewer tried again.
  value.detach("box1", a, "box");
  const again = connect("viewer-a");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(value.view("box1"), { owner: "human", holder: "viewer-a" });

  value.detach("box1", again, "box");
  await until("the agent to have control", () => value.view("box1").owner === "agent");
});

test("each person's control is stored as it changes, and a reload keeps it for their viewer, which has it again if it connects in time (045)", async () => {
  const stored: (readonly KeptControl[])[] = [];
  const stopping: string[] = [];
  const before = control({
    keep: async (kept) => void stored.push(kept),
    stopping: async (boxId, kept) => void stopping.push(`${boxId} ${kept}`),
  });
  const a = before.connect("viewer-a");
  before.connect("viewer-b", "box2");
  before.value.seen("box1", { width: 1280, height: 800 });
  await before.value.take("box1", "viewer-a");
  before.value.resized("box1", "viewer-a", SCREEN);
  await before.value.dispose();
  const kept = { boxId: "box1", holder: "viewer-a", size: { width: 1280, height: 800 }, resized: SCREEN };
  assert.deepEqual(stored, [[], [{ ...kept, resized: null }], [kept]], "every change, and only a box a person has; nothing as bb-box stops");
  assert.equal(a.releases, 1, "what the holder held down is let go");
  assert.deepEqual(before.restores, [], "the desktop keeps the person's size");
  assert.deepEqual(stopping, ["box1 true"]);

  const after = control({ staleMs: 30 });
  after.value.resume([kept]);
  assert.deepEqual(after.value.view("box1"), { owner: "human", holder: "viewer-a" });
  assert.deepEqual(after.events, ["box1 human"], "the panel hears of it");
  after.connect("viewer-a");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(after.value.view("box1"), { owner: "human", holder: "viewer-a" }, "the viewer connected again in time");
  await after.value.handBack("box1");
  assert.deepEqual(after.restores, [[{ width: 1280, height: 800 }, SCREEN]], "the size from before the person took control");
});

test("kept control goes back to the agent with the desktop's size when the viewer does not connect again in time, and never over a person's take (045)", async () => {
  const kept = { holder: "viewer-a", size: { width: 1280, height: 800 }, resized: SCREEN };
  const stored: (readonly KeptControl[])[] = [];
  // The time a viewer that went away has, not the time a box gives it.
  const { value, restores, errors, connect } = control({ staleMs: 30, reconnectMs: 60_000, keep: async (each) => void stored.push(each) });
  connect("viewer-b", "box2");
  await value.take("box2", "viewer-b");
  connect("viewer-a", "box3");
  value.resume([
    { boxId: "box1", ...kept },
    { boxId: "box2", ...kept },
    { boxId: "box3", ...kept },
  ]);
  assert.deepEqual(value.view("box2"), { owner: "human", holder: "viewer-b" }, "a take since the start stands");
  await until("the agent to have control", () => value.view("box1").owner === "agent");
  assert.deepEqual(restores, [[{ width: 1280, height: 800 }, SCREEN]]);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(value.view("box3"), { owner: "human", holder: "viewer-a" }, "a viewer that connected before the resume keeps it");
  assert.deepEqual(
    stored.at(-1),
    [
      { boxId: "box2", holder: "viewer-b", size: null, resized: null },
      { boxId: "box3", ...kept },
    ],
  );
  assert.deepEqual(errors, []);
});

test("a reload that cannot keep control gives it back and sets the desktop's size back before bb-box goes, and schedules nothing after (#139)", async () => {
  const stopping: string[] = [];
  let stores = 0;
  const { value, events, restores, errors, connect } = control({
    staleMs: 10,
    // The latest store fails.
    keep: async (kept) => {
      stores++;
      if (kept.some((each) => each.resized)) throw new Error("storage is gone");
    },
    stopping: async (boxId, kept) => {
      stopping.push(`${boxId} ${kept}`);
      throw new Error("the log is gone");
    },
  });
  const a = connect("viewer-a");
  connect("viewer-a", "box2");
  value.seen("box1", { width: 1280, height: 800 });
  await value.take("box1", "viewer-a");
  value.resized("box1", "viewer-a", SCREEN);
  await value.dispose();
  assert.equal(stores, 3, "the hand-back stores nothing over the next instance's");
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null });
  assert.equal(a.releases, 1, "what the holder held down is let go");
  assert.deepEqual(restores, [[{ width: 1280, height: 800 }, SCREEN]], "even when the log line fails");
  assert.deepEqual(stopping, ["box1 false"], "the log says why for each box a person had control of");
  assert.deepEqual(errors, ["keep control: Error: storage is gone", "log a hand back: Error: the log is gone"]);

  // A take that lands during the reload, then its viewer closing, as the
  // reload closes every viewer: nothing hands back later with the old plugin's API.
  const b = connect("viewer-b");
  await value.take("box1", "viewer-b");
  const changes = events.length;
  value.detach("box1", b, "viewer");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(events.length, changes);
  assert.equal(stores, 3);
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
