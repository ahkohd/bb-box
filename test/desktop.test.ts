// The desktop viewer's pieces: the RFB protocol, the relay that answers the
// box's VNC authentication and drops input from viewers without control, and
// shared control itself.

import assert from "node:assert/strict";
import { test } from "node:test";
import { Control, ControlError, type KeptControl, type ViewerConnection } from "../src/core/control.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { connectBox, RfbRelay, restoreSize, type OpenDisplay, type RelayOptions } from "../src/core/relay.ts";
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
import type { DisplayAuth, DisplayInput, DisplayInputEvents, DisplayOpened } from "../src/transports/types.ts";
import { FakeRfb, until } from "./fake-rfb.ts";
import { RecordingInputs, type PersonInput } from "../src/core/record-input.ts";
import { tartTypesAsCharacter } from "../src/core/mac-input.ts";
import { windowsTypesAsCharacter } from "../src/backends/windows.ts";

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

function relayTo(
  server: FakeRfb,
  options: Partial<RelayOptions> & {
    password?: string;
    auth?: DisplayAuth;
    displayInput?: DisplayOpened["input"];
    inputTakes?: DisplayOpened["inputTakes"];
    typesAsCharacter?: DisplayOpened["typesAsCharacter"];
    keyDelayMs?: number;
  } = {},
) {
  const viewer = fakeViewer();
  let control = false;
  const ends: string[] = [];
  const resizes: unknown[] = [];
  const open: OpenDisplay = async () => ({
    channel: server.channel(),
    auth: options.auth ?? (options.password === undefined ? { type: "none" } : { type: "vnc-password", password: options.password }),
    input: options.displayInput,
    ...(options.inputTakes ? { inputTakes: options.inputTakes } : {}),
    ...(options.typesAsCharacter ? { typesAsCharacter: options.typesAsCharacter } : {}),
    ...(options.keyDelayMs ? { keyDelayMs: options.keyDelayMs } : {}),
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

test("a display with an input of its own gets the holder's keys, pointer and clipboard instead of the stream server, and the releases at the end (#406)", async () => {
  const server = new FakeRfb();
  const calls: string[] = [];
  let events: DisplayInputEvents | null = null;
  let closed = false;
  const input: DisplayInput = {
    key: async (down, keysym) => (calls.push(`key ${down} ${keysym}`), true),
    pointer: async (mask, x, y) => void calls.push(`pointer ${mask} ${x} ${y}`),
    clipboard: async (value) => void calls.push(`clipboard ${value}`),
    size: async (width, height) => void calls.push(`size ${width}x${height}`),
    ping: async () => undefined,
    close: async () => void (closed = true),
  };
  const clipboards: string[] = [];
  const relay = relayTo(server, {
    displayInput: async (given) => ((events = given), input),
    onClipboard: (value) => clipboards.push(value),
  });
  await relay.init();
  const [box] = server.connections;
  const held = [keyEvent(true, 0x61), pointerEvent(1, 5, 5), cutText(text("pasted"))].reduce(concat);
  await relay.relay.receive(held);
  assert.deepEqual(calls, [], "a watcher's input reaches neither, and opens no input");

  relay.give(true);
  await relay.relay.receive(concat(held, UPDATE_REQUEST));
  await until("the holder's input", () => calls.length >= 4);
  assert.deepEqual(calls, ["size 1280x800", "key true 97", "pointer 1 5 5", "clipboard pasted"], "the input learns the desktop's size first");
  await until("the update request", () => box!.received.byteLength >= UPDATE_REQUEST.byteLength);
  assert.equal(hex(box!.received), hex(UPDATE_REQUEST), "only the update request goes to the stream server");

  events!.onClipboard!("from the box");
  assert.deepEqual(clipboards, ["from the box"]);

  await relay.relay.close();
  assert.deepEqual(calls.slice(4), ["key false 97", "pointer 0 5 5"], "closing lets go of what the viewer held down, through the input");
  assert.ok(closed, "and closes the input");
  assert.equal(hex(box!.received), hex(UPDATE_REQUEST));
});

test("a display's input opens ahead of the first key once the viewer has control, after the desktop's size is known, but not where it takes characters only", async () => {
  const opened = (inputTakes?: DisplayOpened["inputTakes"]) => {
    const server = new FakeRfb();
    const calls: string[] = [];
    const input: DisplayInput = {
      key: async (down, keysym) => (calls.push(`key ${down} ${keysym}`), true),
      pointer: async (mask, x, y) => void calls.push(`pointer ${mask} ${x} ${y}`),
      clipboard: async (value) => void calls.push(`clipboard ${value}`),
      size: async (width, height) => void calls.push(`size ${width}x${height}`),
      ping: async () => undefined,
      close: async () => undefined,
    };
    return { calls, relay: relayTo(server, { displayInput: async () => input, ...(inputTakes ? { inputTakes } : {}) }) };
  };

  const early = opened();
  early.relay.relay.prepareInput();
  await early.relay.init();
  await until("the input to open", () => early.calls.length >= 1);
  assert.deepEqual(early.calls, ["size 1280x800"], "opened at ServerInit, with no input from the viewer");
  early.relay.give(true);
  await early.relay.relay.receive(keyEvent(true, 0x61));
  await until("the key", () => early.calls.length >= 2);
  assert.deepEqual(early.calls, ["size 1280x800", "key true 97"], "the first key goes to the input opened already");
  await early.relay.relay.close();

  const late = opened("wheel");
  await late.relay.init();
  assert.deepEqual(late.calls, []);
  late.relay.relay.prepareInput();
  await until("the input to open", () => late.calls.length >= 1);
  assert.deepEqual(late.calls, ["size 1280x800"]);
  await late.relay.relay.close();

  const characters = opened("characters");
  characters.relay.relay.prepareInput();
  await characters.relay.init();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(characters.calls, [], "a Windows VM's character input still opens at its first character");
  await characters.relay.relay.close();
});

test("a display whose input takes only the wheel gets the wheel's notches, and the stream server everything else, the pointer's moves and buttons included", async () => {
  const server = new FakeRfb();
  const calls: string[] = [];
  const input: DisplayInput = {
    key: async (down, keysym) => (calls.push(`key ${down} ${keysym}`), true),
    pointer: async (mask, x, y) => void calls.push(`pointer ${mask} ${x} ${y}`),
    clipboard: async (value) => void calls.push(`clipboard ${value}`),
    size: async (width, height) => void calls.push(`size ${width}x${height}`),
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "wheel" });
  await relay.init();
  const [box] = server.connections;
  relay.give(true);
  // A key, a click, then a notch down with the left button held, as noVNC sends them: button 5 down and up.
  const sent = [keyEvent(true, 0x61), pointerEvent(1, 5, 5), pointerEvent(1 | 16, 6, 7), pointerEvent(1, 6, 7)];
  await relay.relay.receive(sent.reduce(concat));
  await until("the wheel's notch", () => calls.length >= 3);
  assert.deepEqual(calls, ["size 1280x800", "pointer 16 6 7", "pointer 0 6 7"], "only the wheel goes to the input: its button down, then up");
  const expected = [keyEvent(true, 0x61), pointerEvent(1, 5, 5), pointerEvent(1, 6, 7), pointerEvent(1, 6, 7)].reduce(concat);
  await until("the rest", () => box!.received.byteLength >= expected.byteLength);
  assert.equal(hex(box!.received), hex(expected), "the stream server gets the key and the pointer, without the wheel's button");
  // Letting go at the end goes to the stream server, as without an input.
  await relay.relay.close();
  assert.deepEqual(calls, ["size 1280x800", "pointer 16 6 7", "pointer 0 6 7"]);
  assert.equal(hex(box!.received.subarray(expected.byteLength)), hex([keyEvent(false, 0x61), pointerEvent(0, 6, 7)].reduce(concat)));
});

test("over Tart's VNC server, a character it has no key for, or that needs another Shift, goes to the display's input as itself, and the rest to the server (the desktop sweep)", async () => {
  const server = new FakeRfb();
  const calls: string[] = [];
  const input: DisplayInput = {
    key: async (down, keysym) => (calls.push(`key ${down} ${keysym}`), true),
    character: async (down, keysym) => void calls.push(`character ${down} ${keysym.toString(16)}`),
    pointer: async (mask, x, y) => void calls.push(`pointer ${mask} ${x} ${y}`),
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "wheel", typesAsCharacter: tartTypesAsCharacter });
  await relay.init();
  const [box] = server.connections;
  relay.give(true);
  // a, é, then Shift with Z and with 1, as from a French keyboard; é's key is still down at the end.
  const sent = [keyEvent(true, 0x61), keyEvent(false, 0x61), keyEvent(true, 0xe9), keyEvent(false, 0xe9), keyEvent(true, 0xe9), keyEvent(true, 0xffe1), keyEvent(true, 0x5a), keyEvent(false, 0x5a), keyEvent(true, 0x31), keyEvent(false, 0x31), keyEvent(false, 0xffe1)];
  await relay.relay.receive(sent.reduce(concat));
  await until("the characters", () => calls.length >= 5);
  assert.deepEqual(calls, ["character true e9", "character false e9", "character true e9", "character true 31", "character false 31"]);
  const expected = [keyEvent(true, 0x61), keyEvent(false, 0x61), keyEvent(true, 0xffe1), keyEvent(true, 0x5a), keyEvent(false, 0x5a), keyEvent(false, 0xffe1)].reduce(concat);
  await until("the keys", () => box!.received.byteLength >= expected.byteLength);
  assert.equal(hex(box!.received), hex(expected), "the server gets the keys it types right");
  await relay.relay.close();
  assert.equal(calls.at(-1), "character false e9", "closing lets go of a character still down, through the input");
  assert.equal(box!.received.byteLength, expected.byteLength, "and sends the server nothing for it");
});

test("over Tart's VNC server, a character between two keys in one read goes after the first and before the second", async () => {
  const server = new FakeRfb();
  const seen: number[] = [];
  let calledAt = 0;
  let box: FakeRfb["connections"][number] | undefined;
  const input: DisplayInput = {
    key: async () => true,
    // What the server has when the helper posts the character; the relay sends the next key only once it has.
    character: async () => {
      calledAt = Date.now();
      await until("the key before it", () => (box?.received.byteLength ?? 0) >= 8);
      await new Promise((resolve) => setTimeout(resolve, 30));
      seen.push(box!.received.byteLength);
    },
    pointer: async () => undefined,
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "wheel", typesAsCharacter: tartTypesAsCharacter });
  await relay.init();
  [box] = server.connections;
  relay.give(true);
  const sentAt = Date.now();
  await relay.relay.receive([keyEvent(true, 0x7a), keyEvent(true, 0xe9), keyEvent(true, 0x78)].reduce(concat));
  // The first key reaches the box a little later by the server: the character waits for it.
  assert.ok(calledAt - sentAt >= 14, `the character waited ${calledAt - sentAt} ms after the key before it`);
  await until("the second key", () => box!.received.byteLength >= 16);
  assert.deepEqual(seen, [8], "the character was posted with only the first key at the server");
  assert.equal(hex(box!.received), hex([keyEvent(true, 0x7a), keyEvent(true, 0x78)].reduce(concat)));
  await relay.relay.close();
});

test("the viewer's reads go in turn: a key in a later read waits for a character in an earlier one, which waits for the input (the desktop sweep)", async () => {
  const server = new FakeRfb();
  const seen: number[] = [];
  let box: FakeRfb["connections"][number] | undefined;
  const input: DisplayInput = {
    key: async () => true,
    character: async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      seen.push(box!.received.byteLength);
    },
    pointer: async () => undefined,
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  // The input starts slowly, as the helper in a Mac does.
  const relay = relayTo(server, { displayInput: () => new Promise((resolve) => setTimeout(() => resolve(input), 80)), inputTakes: "wheel", typesAsCharacter: tartTypesAsCharacter });
  await relay.init();
  [box] = server.connections;
  relay.give(true);
  // Two reads, as two WebSocket messages, the second not waiting for the first.
  const first = relay.relay.receive(keyEvent(true, 0xe9));
  const second = relay.relay.receive(keyEvent(true, 0x78));
  await Promise.all([first, second]);
  await until("the key", () => box!.received.byteLength >= 8);
  assert.deepEqual(seen, [0], "the character was posted before the next read's key reached the server");
  await relay.relay.close();
});

test("keys a viewer sent while it had control reach the box though they wait their turn past a hand-back, and keys sent after it do not (the Mac sweep)", async () => {
  const server = new FakeRfb();
  const characters: number[] = [];
  let box: FakeRfb["connections"][number] | undefined;
  const input: DisplayInput = {
    key: async () => true,
    character: async (down, keysym) => {
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (down) characters.push(keysym);
    },
    pointer: async () => undefined,
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "wheel", typesAsCharacter: tartTypesAsCharacter });
  await relay.init();
  [box] = server.connections;
  relay.give(true);
  const typed = [relay.relay.receive(keyEvent(true, 0xe9)), relay.relay.receive(keyEvent(false, 0xe9)), relay.relay.receive(keyEvent(true, 0x78)), relay.relay.receive(keyEvent(false, 0x78))];
  relay.give(false);
  const late = relay.relay.receive(keyEvent(true, 0x79));
  await Promise.all([...typed, late]);
  await until("the key typed before the hand-back", () => box!.received.byteLength >= 16);
  assert.deepEqual(characters, [0xe9], "the character typed with control was posted");
  const keys = [...box!.received].length / 8;
  assert.equal(keys, 2, "the key typed with control went down and up, and the one typed after the hand-back was dropped");
  await relay.relay.close();
});

test("over QEMU's VNC server on Windows, a key typed otherwise than on a US keyboard goes to the display's input as its character, and the rest, the pointer included, to the server (the desktop sweep)", async () => {
  const server = new FakeRfb();
  const calls: string[] = [];
  const input: DisplayInput = {
    key: async (down, keysym) => (calls.push(`key ${down} ${keysym}`), true),
    character: async (down, keysym) => void calls.push(`character ${down} ${keysym.toString(16)}`),
    pointer: async (mask) => void calls.push(`pointer ${mask}`),
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "characters", typesAsCharacter: windowsTypesAsCharacter });
  await relay.init();
  const [box] = server.connections;
  relay.give(true);
  // AZERTY: a on the Q key, then Shift and 1 on the 1 key; then a US q, Ctrl+A on the Q key, and a wheel notch.
  const sent = [
    qemuKeyEvent(true, 0x61, 0x10), qemuKeyEvent(false, 0x61, 0x10),
    qemuKeyEvent(true, 0xffe1, 0x2a), qemuKeyEvent(true, 0x31, 0x02), qemuKeyEvent(false, 0x31, 0x02), qemuKeyEvent(false, 0xffe1, 0x2a),
    qemuKeyEvent(true, 0x71, 0x10), qemuKeyEvent(false, 0x71, 0x10),
    qemuKeyEvent(true, 0xffe3, 0x1d), qemuKeyEvent(true, 0x61, 0x10), qemuKeyEvent(false, 0x61, 0x10), qemuKeyEvent(false, 0xffe3, 0x1d),
    pointerEvent(16, 5, 5), pointerEvent(0, 5, 5),
  ];
  await relay.relay.receive(sent.reduce(concat));
  const expected = [
    qemuKeyEvent(true, 0xffe1, 0x2a), qemuKeyEvent(false, 0xffe1, 0x2a),
    qemuKeyEvent(true, 0x71, 0x10), qemuKeyEvent(false, 0x71, 0x10),
    qemuKeyEvent(true, 0xffe3, 0x1d), qemuKeyEvent(true, 0x61, 0x10), qemuKeyEvent(false, 0x61, 0x10), qemuKeyEvent(false, 0xffe3, 0x1d),
    pointerEvent(16, 5, 5), pointerEvent(0, 5, 5),
  ].reduce(concat);
  await until("the server's keys", () => box!.received.byteLength >= expected.byteLength);
  assert.deepEqual(calls, ["character true 61", "character false 61", "character true 31", "character false 31"]);
  assert.equal(hex(box!.received), hex(expected), "a US q, Ctrl+A and the wheel stay the server's");
  await relay.relay.close();
});

test("a character after keys to a server that spaces its key events waits until it has typed them, as QEMU does each 10 ms (the desktop sweep)", async () => {
  const server = new FakeRfb();
  let calledAt = 0;
  const input: DisplayInput = {
    key: async () => true,
    character: async () => void (calledAt = calledAt || Date.now()),
    pointer: async () => undefined,
    clipboard: async () => undefined,
    size: async () => undefined,
    ping: async () => undefined,
    close: async () => undefined,
  };
  const relay = relayTo(server, { displayInput: async () => input, inputTakes: "characters", typesAsCharacter: windowsTypesAsCharacter, keyDelayMs: 10 });
  await relay.init();
  relay.give(true);
  // d and e, down and up, then Shift and a German : on the period key: five key events QEMU types 10 ms apart.
  const sentAt = Date.now();
  await relay.relay.receive(
    [qemuKeyEvent(true, 0x64, 0x20), qemuKeyEvent(false, 0x64, 0x20), qemuKeyEvent(true, 0x65, 0x12), qemuKeyEvent(false, 0x65, 0x12), qemuKeyEvent(true, 0xffe1, 0x2a), qemuKeyEvent(true, 0x3a, 0x34)].reduce(concat),
  );
  assert.ok(calledAt - sentAt >= 60, `the character waited ${calledAt - sentAt} ms for QEMU's five key events`);
  await relay.relay.close();
});

test("when a wheel-only input cannot start, keys and clicks still reach the stream server, and only the wheel is lost", async () => {
  const server = new FakeRfb();
  const problems: string[] = [];
  const relay = relayTo(server, {
    displayInput: async () => {
      throw new Error("The desktop's wheel helper did not start.");
    },
    inputTakes: "wheel",
    onInputError: (error) => problems.push(error.message),
  });
  await relay.init();
  const [box] = server.connections;
  relay.give(true);
  await relay.relay.receive([keyEvent(true, 0x61), pointerEvent(16, 6, 7), pointerEvent(0, 6, 7), pointerEvent(1, 5, 5)].reduce(concat));
  const expected = [keyEvent(true, 0x61), pointerEvent(0, 6, 7), pointerEvent(0, 6, 7), pointerEvent(1, 5, 5)].reduce(concat);
  await until("the key and the click", () => box!.received.byteLength >= expected.byteLength);
  assert.equal(hex(box!.received), hex(expected));
  assert.deepEqual(problems, ["The desktop's wheel helper did not start."]);
});

test("an input that cannot open is reported, and the desktop still streams (#406)", async () => {
  const server = new FakeRfb();
  const problems: string[] = [];
  const relay = relayTo(server, {
    displayInput: async () => {
      throw new Error("the helper did not start");
    },
    onInputError: (error) => problems.push(error.message),
  });
  await relay.init();
  relay.give(true);
  await relay.relay.receive([keyEvent(true, 0x61), keyEvent(false, 0x61), UPDATE_REQUEST].reduce(concat));
  const [box] = server.connections;
  await until("the update request", () => box!.received.byteLength >= UPDATE_REQUEST.byteLength);
  assert.equal(hex(box!.received), hex(UPDATE_REQUEST), "the keys go nowhere rather than to a server that ignores them");
  assert.deepEqual(problems, ["the helper did not start"], "reported once");
  assert.equal(hex(await relay.viewer.reader.read(4)), "00000000", "the stream goes on");
  await relay.relay.close();
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

test("the relay signs in to Screen Sharing as the box user with Apple's authentication, and the viewer still gets type None (047)", async () => {
  const server = new FakeRfb({ user: "boxuser", password: "pässwort 9" });
  const relay = relayTo(server, { auth: { type: "apple", user: "boxuser", password: "pässwort 9" } });
  assert.deepEqual(await relay.init(), { width: 1280, height: 800 });
  assert.equal(server.connections[0]!.shared, 1);
  await relay.relay.close();
  assert.deepEqual(relay.ends, ["viewer"]);
});

test("a sign-in Screen Sharing refuses, or the relay cannot make, reaches the viewer as a security failure with the reason", async () => {
  const cases: [DisplayAuth, string][] = [
    [{ type: "apple", user: "boxuser", password: "wrong" }, "The box's desktop refused the sign-in of user boxuser: Authentication failed"],
    [{ type: "none" }, "The box's desktop asks for a user and password, and its backend gave none."],
    [{ type: "apple", user: "boxuser", password: "x".repeat(64) }, "The box user's name or password is longer than the 63 bytes Apple's authentication carries."],
  ];
  for (const [auth, reason] of cases) {
    const relay = relayTo(new FakeRfb({ user: "boxuser", password: "right" }), { auth });
    assert.equal(hex(await relay.handshake()), "00000001");
    assert.equal(await failure(relay.viewer.reader), reason);
    assert.deepEqual(relay.ends, [`box: ${reason}`]);
  }
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

test("a viewer that asked for the key log has each key logged as it goes to the box, or as it is dropped without control (a diagnostic)", async () => {
  const server = new FakeRfb();
  const lines: string[] = [];
  const relay = relayTo(server, { keyLog: (line) => lines.push(line) });
  await relay.init();
  await relay.relay.receive(keyEvent(true, 0x41));
  relay.give(true);
  await relay.relay.receive(concat(keyEvent(true, 0xffe1), keyEvent(true, 0x41)));
  await relay.relay.receive(keyEvent(false, 0x41));
  await until("the keys", () => lines.length >= 4);
  assert.match(lines[0]!, /^dropped, as the viewer has no control: down 0x41, held \[\], at \d+ ms$/);
  assert.match(lines[1]!, /^to the server: down 0xffe1, held \[0xffe1\]/);
  assert.match(lines[2]!, /^to the server: down 0x41, held \[0xffe1 0x41\]/);
  assert.match(lines[3]!, /^to the server: up 0x41, held \[0xffe1\]/);
  await relay.relay.close();
});

test("a sign-in that hangs has a display that can restart its server restart it, once, and sign in again (#411)", async () => {
  const server = new FakeRfb({ password: "secret12" });
  const auth = { type: "vnc-password", password: "secret12" } as const;
  // A server frozen at a viewer's sign-in, as wayvnc 0.7.2 can be after a restart: it never answers.
  const hung = (): ByteChannel => {
    const toBox = new TransformStream<Uint8Array, Uint8Array>();
    const fromBox = new TransformStream<Uint8Array, Uint8Array>();
    return { readable: fromBox.readable, writable: toBox.writable, close: async () => void (await toBox.writable.abort().catch(() => undefined)) };
  };
  let opens = 0;
  let restarts = 0;
  const open: OpenDisplay = async () => ({ channel: opens++ === 0 ? hung() : server.channel(), auth, restart: async () => void restarts++ });
  const connection = await connectBox(open, 2_000, 50);
  assert.deepEqual([opens, restarts], [2, 1]);
  await connection.channel.close();
  // A display that cannot restart its server waits out the whole time, as before.
  await assert.rejects(connectBox(async () => ({ channel: hung(), auth }), 200, 50), /did not finish its handshake in time/);
  // A server that hangs again after its restart is not restarted twice.
  let again = 0;
  await assert.rejects(connectBox(async () => ({ channel: hung(), auth, restart: async () => void again++ }), 300, 50), /did not finish its handshake in time/);
  assert.equal(again, 1);
});

test("a server that sends its Diffie-Hellman key a byte short is signed in to again on a new connection, not restarted, a few times at most (neatvnc 0.9.1, #902)", async () => {
  const server = new FakeRfb({ user: "boxuser", password: "pw" });
  const auth = { type: "apple", user: "boxuser", password: "pw" } as const;
  let opens = 0;
  let restarts = 0;
  const open: OpenDisplay = async () => (opens++, { channel: server.channel(), auth, restart: async () => void restarts++ });
  server.shortKeys = 2;
  const connection = await connectBox(open, 2_000, 1_000);
  assert.deepEqual([opens, restarts, server.shortKeys], [3, 0, 0]);
  await connection.channel.close();

  opens = 0;
  server.shortKeys = 10;
  await assert.rejects(connectBox(open, 2_000, 1_000), /sent a Diffie-Hellman key of 127 bytes, a byte short/);
  assert.deepEqual([opens, restarts], [6, 0]);
});

/** A FramebufferUpdateRequest for the whole 1280x800 desktop, full or incremental. */
function updateRequest(incremental: boolean): Uint8Array {
  return Uint8Array.of(3, incremental ? 1 : 0, 0, 0, 0, 0, 0x05, 0x00, 0x03, 0x20);
}

test("a server that sends no picture for a full update request is restarted, and the viewer connects again, but not one that answers, nor one that cannot restart (wayvnc 0.7.2)", async () => {
  const server = new FakeRfb();
  server.silent = true;
  let restarts = 0;
  const restarted: string[] = [];
  const open: OpenDisplay = async () => ({ channel: server.channel(), auth: { type: "none" }, restart: async () => void restarts++ });
  const dead = relayTo(server, { open, frameWaitMs: 50, onServerRestart: (why, error) => restarted.push(`${why}${error ? `: ${error.message}` : ""}`) });
  await dead.init();
  // An incremental request may wait for a change: only a full one must be answered.
  await dead.relay.receive(updateRequest(true));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(dead.viewer.closed, null);
  await dead.relay.receive(updateRequest(false));
  await until("the viewer to close", () => dead.viewer.closed !== null);
  assert.equal(restarts, 1);
  assert.deepEqual(restarted, ["sent no picture for a full update"]);
  assert.deepEqual(dead.viewer.closed, { code: 1011, reason: "The desktop's VNC server sent no picture for a full update, so bb-box restarted it, and the viewer connects again." });

  // A server that answers is left alone.
  server.silent = false;
  const alive = relayTo(server, { open, frameWaitMs: 50 });
  await alive.init();
  await alive.relay.receive(updateRequest(false));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual([alive.viewer.closed, restarts], [null, 1]);
  await alive.relay.receive(updateRequest(false));
  // A display that cannot restart its server is not watched.
  server.silent = true;
  const plain = relayTo(server, { frameWaitMs: 50 });
  await plain.init();
  await plain.relay.receive(updateRequest(false));
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(plain.viewer.closed, null);
});

test("a server that says it lost the desktop is restarted at once or within a check, with the viewer connected or new, and one that has it is asked again, never restarted (wayvnc 0.9.1)", async () => {
  const server = new FakeRfb();
  let restarts = 0;
  let attached = true;
  let asked = 0;
  const open: OpenDisplay = async () => ({
    channel: server.channel(),
    auth: { type: "none" },
    restart: async () => void restarts++,
    attached: async () => {
      asked++;
      return attached;
    },
  });
  const viewer = relayTo(server, { open, attachedCheckMs: 30 });
  await viewer.init();
  await until("a few checks", () => asked >= 3);
  assert.deepEqual([viewer.viewer.closed, restarts], [null, 0], "an idle desktop that has its server is left alone");
  attached = false;
  await until("the viewer to close", () => viewer.viewer.closed !== null);
  assert.equal(restarts, 1);
  assert.match(viewer.viewer.closed!.reason, /^The desktop's VNC server lost the desktop, so bb-box restarted it/);
  // A viewer that connects while it has lost it is told at once.
  const fresh = relayTo(server, { open, attachedCheckMs: 60_000 });
  await fresh.init();
  await until("the new viewer to close", () => fresh.viewer.closed !== null);
  assert.equal(restarts, 2);
  // A restart that fails is said.
  const failing = relayTo(server, { open: async () => ({ ...(await open(AbortSignal.timeout(1_000))), restart: async () => { throw new Error("wayvnc did not start again within 5 s"); } }), attachedCheckMs: 60_000 });
  await failing.init();
  await until("the failing viewer to close", () => failing.viewer.closed !== null);
  assert.match(failing.viewer.closed!.reason, /could not restart it: wayvnc did not start again/);
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
  options: {
    pause?: () => Promise<void>;
    keep?: (kept: readonly KeptControl[]) => Promise<void>;
    read?: () => Promise<readonly KeptControl[]>;
    stopping?: (boxId: string, kept: boolean) => Promise<void>;
    staleMs?: number;
    reconnectMs?: number;
  } = {},
) {
  const events: string[] = [];
  const restores: unknown[] = [];
  const errors: string[] = [];
  const value = new Control({
    changed: (boxId) => events.push(`${boxId} ${value.view(boxId).owner}`),
    restore: async (_boxId, size, screen) => void restores.push([size, screen]),
    pause: options.pause,
    keep: options.keep,
    read: options.read,
    stopping: options.stopping,
    logError: (operation, error) => errors.push(`${operation}: ${String(error)}`),
    staleMs: options.staleMs,
    reconnectMs: options.reconnectMs,
  });
  const connect = (viewer: string, box = "box1") => {
    const connection: ViewerConnection & { releases: number; prepares: number } = {
      viewer,
      releases: 0,
      prepares: 0,
      release: async () => {
        connection.releases++;
      },
      prepareInput: () => {
        connection.prepares++;
      },
    };
    value.attach(box, connection);
    return connection;
  };
  return { value, events, restores, errors, connect };
}

test("the viewer that takes control has its display's input opened then, and so does a holder that connects again after a restart", async () => {
  const { value, connect } = control();
  const a = connect("viewer-a");
  const b = connect("viewer-b");
  assert.equal(a.prepares + b.prepares, 0, "no input opens for a watcher");
  await value.take("box1", "viewer-a");
  assert.deepEqual([a.prepares, b.prepares], [1, 0]);
  await value.take("box1", "viewer-b");
  assert.deepEqual([a.prepares, b.prepares], [1, 1]);

  const after = control({ staleMs: 60_000 });
  after.value.resume([{ boxId: "box1", holder: "viewer-b", size: null, resized: null }]);
  const watcher = after.connect("viewer-a");
  const holder = after.connect("viewer-b");
  assert.deepEqual([watcher.prepares, holder.prepares], [0, 1], "the holder's input opens as it connects again");
});

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

test("a take or hand-back in the last instance after this one started holds once the first viewer connects (#318)", async () => {
  let storage: readonly KeptControl[] = [];
  let reads = 0;
  const { value, events, restores, errors, connect } = control({
    keep: async (kept) => void (storage = kept),
    read: async () => {
      reads++;
      return storage;
    },
  });
  // As this instance started, viewer-a had box1 and viewer-c had box3.
  const kept = { holder: "viewer-a", size: { width: 1280, height: 800 }, resized: SCREEN };
  value.resume([
    { boxId: "box1", ...kept },
    { boxId: "box3", ...kept, holder: "viewer-c" },
  ]);
  // Then, in the last instance, viewer-a handed box1 back, viewer-b took
  // box2, and viewer-d took box3 from viewer-c.
  storage = [
    { boxId: "box2", holder: "viewer-b", size: null, resized: null },
    { boxId: "box3", holder: "viewer-d", size: null, resized: null },
  ];
  events.length = 0;
  connect("viewer-a");
  connect("viewer-c", "box3");
  await until("the stored control", () => value.view("box1").owner === "agent" && value.view("box2").owner === "human" && value.view("box3").holder === "viewer-d");
  assert.deepEqual(events.sort(), ["box1 agent", "box2 human", "box3 human"], "box2 with no viewer yet too");
  assert.deepEqual(restores, [], "the last instance set box1's size back");
  assert.equal(value.mayInput("box3", "viewer-c"), false);

  connect("viewer-b", "box2");
  connect("viewer-d", "box3");
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(value.mayInput("box2", "viewer-b"), true);
  assert.equal(value.mayInput("box3", "viewer-d"), true);
  assert.equal(reads, 1, "once, for every box");
  value.resume([{ boxId: "box1", ...kept }]);
  assert.deepEqual(value.view("box1"), { owner: "agent", holder: null }, "a read at start that ends after a viewer connected is older");
  assert.deepEqual(storage, [
    { boxId: "box3", holder: "viewer-d", size: null, resized: null },
    { boxId: "box2", holder: "viewer-b", size: null, resized: null },
  ]);
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

test("a recording forgets the keys a viewer held when the relay lets them go, and when the viewer or the box ends its connection, so a later key is not a shortcut (073)", async () => {
  const inputs = new RecordingInputs(() => 5_000);
  inputs.begin("box", 0, "linux");
  const keys: PersonInput[] = [];
  const onInput = (input: PersonInput) => {
    if (input.type === "key") keys.push(input);
    inputs.person("box", input);
  };
  const server = new FakeRfb();
  const typed = async (relay: ReturnType<typeof relayTo>, messages: Uint8Array[]) => {
    const before = keys.length;
    await relay.relay.receive(messages.reduce(concat));
    await until("the keys to reach the recording", () => keys.length === before + messages.length);
  };
  const first = relayTo(server, { onInput });
  await first.init();
  first.give(true);
  await typed(first, [keyEvent(true, 0xffe3), keyEvent(true, 0x61), keyEvent(false, 0x61)]);
  await first.relay.release();
  await typed(first, [keyEvent(true, 0x61), keyEvent(false, 0x61), keyEvent(true, 0xffe3)]);
  await first.relay.close();
  const second = relayTo(server, { onInput });
  await second.init();
  second.give(true);
  await typed(second, [keyEvent(true, 0x61), keyEvent(false, 0x61), keyEvent(true, 0xffe3)]);
  await server.connections.at(-1)!.end();
  await until("the box to end it", () => second.ends.length === 1);
  const third = relayTo(server, { onInput });
  await third.init();
  third.give(true);
  await typed(third, [keyEvent(true, 0x61)]);
  const events = inputs.end("box")!;
  assert.deepEqual(
    events.map((event) => (event.type === "keys" ? `${event.chord.modifiers.join("+")}+${event.chord.key}` : event.type)),
    ["ctrl+A", "typing", "typing", "typing"],
  );
  await third.relay.close();
});
