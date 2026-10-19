// A person's characters over a Windows desktop's VNC (the desktop sweep): which keys go to bb-box-stream as their
// character rather than to QEMU, and how they go, against a stand-in for the box's bb-box-stream.

import assert from "node:assert/strict";
import { test } from "node:test";
import { windowsCharacterInput, windowsTypesAsCharacter } from "../src/backends/windows.ts";
import { FakeSelkies } from "./fake-selkies.ts";
import { until } from "./fake-rfb.ts";

const SHIFT = 0xffe1;
const CONTROL = 0xffe3;
const ALT = 0xffe9;
const MODE_SWITCH = 0xff7e;
const typed = (char: string | number, held: number[] = [], scancode?: number) =>
  windowsTypesAsCharacter(typeof char === "number" ? char : char.codePointAt(0)!, new Set(held), scancode);

test("a US keyboard's keys stay QEMU's, by scancode or keysym, Space and shortcuts included", () => {
  assert.deepEqual([typed("a", [], 0x1e), typed("A", [SHIFT], 0x1e), typed("1", [], 0x02), typed("!", [SHIFT], 0x02), typed("/", [], 0x35), typed("?", [SHIFT], 0x35)], [false, false, false, false, false, false]);
  assert.deepEqual([typed("a"), typed("A", [SHIFT]), typed("!", [SHIFT])], [false, false, false], "plain key events of a US keyboard");
  assert.deepEqual([typed(0x20, [], 0x39), typed(0xff0d, [], 0x1c), typed(0xffb1, [], 0x4f)], [false, false, false], "Space, Return and the keypad's 1");
  assert.deepEqual([typed("é", [CONTROL], 0x03), typed("z", [CONTROL], 0x15), typed("q", [ALT], 0x1e)], [false, false, false], "a shortcut stays keys, whatever the layout");
});

test("a key a layout types otherwise than a US keyboard goes as its character: French, German, a Mac's Option, and Caps Lock", () => {
  // French AZERTY: a on the Q key, é on the 2 key, ! on the slash key, 1 with Shift on the 1 key.
  assert.deepEqual([typed("a", [], 0x10), typed("é", [], 0x03), typed("!", [], 0x35), typed("1", [SHIFT], 0x02)], [true, true, true, true]);
  // German QWERTZ: z on the Y key, ß on the minus key, = with Shift on the 0 key, ü on the [ key.
  assert.deepEqual([typed("z", [], 0x15), typed("ß", [], 0x0c), typed("=", [SHIFT], 0x0b), typed("ü", [], 0x1a)], [true, true, true, true]);
  // A Mac's Option+E then E: é on the E key, Option let go; Option+C: ç with Mode_switch held.
  assert.deepEqual([typed("é", [], 0x12), typed("ç", [MODE_SWITCH], 0x2e), typed(0x10020ac, [MODE_SWITCH], 0x13)], [true, true, true]);
  assert.equal(typed("A", [], 0x1e), true, "a capital with Caps Lock on");
  // Plain key events: what a US keyboard has no key for, or types with another Shift.
  assert.deepEqual([typed("é"), typed("!"), typed("1", [SHIFT]), typed(0x1000436)], [true, true, true, true]);
});

test("characters go to bb-box-stream as cd and cu, each once it says it has typed it, where it answers BB_PING", async () => {
  const server = new FakeSelkies({});
  const input = windowsCharacterInput(async () => server.channel());
  const answering = (async () => {
    for (let answered = 0; answered < 3; ) {
      await until("a ping", () => (server.pages[0]?.received.filter((message) => typeof message === "string" && message.startsWith("BB_PING,")).length ?? 0) > answered);
      const ping = server.pages[0]!.received.filter((message): message is string => typeof message === "string" && message.startsWith("BB_PING,"))[answered]!;
      await server.pages[0]!.send(`BB_PONG,${ping.slice(8)}`);
      answered += 1;
    }
  })();
  await input.character!(true, 0xe9);
  await input.character!(false, 0xe9);
  await answering;
  const sent = server.pages[0]!.received.filter((message): message is string => typeof message === "string" && /^(cd|cu|kd|ku|BB_PING),/.test(message));
  assert.deepEqual(sent.map((message) => message.replace(/^BB_PING,\d+$/, "BB_PING")), ["BB_PING", "cd,233", "BB_PING", "cu,233", "BB_PING"]);
  await input.close();
  await server.close();
});

test("where bb-box-stream does not answer, as from an older image, characters go as Unicode keysyms' kd and ku, each with a short wait", async () => {
  const server = new FakeSelkies({});
  const input = windowsCharacterInput(async () => server.channel());
  const started = Date.now();
  await input.character!(true, 0xe9);
  await input.character!(false, 0xe9);
  const sent = server.pages[0]!.received.filter((message): message is string => typeof message === "string" && /^(cd|cu|kd|ku),/.test(message));
  assert.deepEqual(sent, [`kd,${0x10000e9}`, `ku,${0x10000e9}`]);
  assert.ok(Date.now() - started >= 1_000, "the first waited for an answer that did not come");
  await input.close();
  await server.close();
});
