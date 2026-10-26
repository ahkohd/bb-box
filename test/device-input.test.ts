import assert from "node:assert/strict";
import { connect } from "node:net";
import { Duplex } from "node:stream";
import { after, describe, test } from "node:test";
import { DEVICE_SERVER_VERSION, testDeviceOffer, type OfferedDevices, type TouchContact } from "../src/core/device.ts";
import { DeviceLink, type DeviceRole } from "../src/core/device-link.ts";
import { parseDeviceServerMessage } from "../src/core/device-parse.ts";
import { pictureIn } from "../src/app/device-input.ts";
import { InputLane, splitByCharacters } from "../src/device/input-lane.ts";
import { keysymMeaning, typedOnUsKeyboard, usKey } from "../src/device/keys.ts";
import { devicePaths } from "../src/device/paths.ts";
import { LONG_PRESS_MS, mirroredAboutCentre } from "../src/device/person-input.ts";
import { DeviceServer, textRuns } from "../src/device/server.ts";
import { TestDriver } from "../src/device/test-driver.ts";
import type { ByteChannel } from "../src/transports/types.ts";
import { tempDir } from "./helpers.ts";

const servers: DeviceServer[] = [];
after(async () => {
  for (const server of servers) await server.stop();
});

function channelTo(path: string): Promise<ByteChannel> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    socket.once("error", reject);
    socket.once("connect", () => {
      const web = Duplex.toWeb(socket);
      resolve({ readable: web.readable as ReadableStream<Uint8Array>, writable: web.writable as WritableStream<Uint8Array>, close: async () => void socket.destroy() });
    });
  });
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(what: string, check: () => boolean | Promise<boolean>, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await wait(5);
  }
}

async function started(driver = new TestDriver("android")) {
  const paths = devicePaths(tempDir("device-input"));
  const offer = testDeviceOffer(driver.platform);
  const log: string[] = [];
  const server = new DeviceServer({ paths, platform: offer.platform, devices: offer.devices as OfferedDevices, driver, version: DEVICE_SERVER_VERSION, log: (line) => log.push(line) });
  servers.push(server);
  await server.start();
  await until("the device to boot", () => server.state.power.is === "booted" && server.state.geometry !== null);
  const open = async (role: DeviceRole, extra: { onText?: (text: string) => void } = {}) => DeviceLink.open(await channelTo(paths.socket), { role, started: role === "control" ? 1 : undefined, instance: role === "control" ? "a" : undefined, ...extra });
  const touches = () => driver.record.touches;
  const clear = () => {
    driver.record.touches.length = 0;
    driver.record.keys.length = 0;
    driver.record.pastes.length = 0;
  };
  await until("the lift at start", () => touches().length > 0);
  clear();
  return { server, driver, log, open, touches, clear, video: server.state.geometry!.video, generation: server.state.geometry!.generation };
}

const key = (keysym: number) => [`kd,${keysym}`, `ku,${keysym}`];

describe("keys", () => {
  test("names a viewer's keysyms as W3C keys, and anything a US keyboard lacks as text", () => {
    assert.deepEqual(keysymMeaning(0x61), { is: "key", key: "a" });
    assert.deepEqual(keysymMeaning(0x41), { is: "key", key: "A" });
    assert.deepEqual(keysymMeaning(0x20), { is: "key", key: " " });
    assert.deepEqual(keysymMeaning(0xff0d), { is: "key", key: "Enter" });
    assert.deepEqual(keysymMeaning(0xffe7), { is: "key", key: "Meta" });
    assert.deepEqual(keysymMeaning(0xffe9), { is: "key", key: "Alt" });
    assert.deepEqual(keysymMeaning(0xe9), { is: "text", text: "é" });
    assert.deepEqual(keysymMeaning(0x1000000 + 0x65e5), { is: "text", text: "日" });
    assert.deepEqual(keysymMeaning(0x1000000 + 0x1f600), { is: "text", text: "😀" });
    assert.deepEqual(keysymMeaning(0xfe51), { is: "ignored" });
    assert.deepEqual(usKey("?"), { code: "Slash", shift: true });
    assert.equal(typedOnUsKeyboard("~"), true);
    assert.equal(typedOnUsKeyboard("ß"), false);
  });

  test("places a watcher's touch circle on the picture as the canvas fits it", () => {
    assert.deepEqual(pictureIn(400, 800, 360, 800), { left: 20, top: 0, scale: 1 });
    assert.deepEqual(pictureIn(360, 400, 360, 800), { left: 90, top: 0, scale: 0.5 });
    assert.equal(pictureIn(0, 800, 360, 800), null);
  });

  test("types what it can as keys, and pastes the rest in as few pieces as it can without pasting inside a word", () => {
    const typed = (character: string) => typedOnUsKeyboard(character) || "üé".includes(character);
    assert.deepEqual(textRuns("Grüße 日本 😀 مرحبا!", typed), [
      { keys: true, text: "Grü" },
      { keys: false, text: "ß" },
      { keys: true, text: "e " },
      { keys: false, text: "日本 😀 مرحبا" },
      { keys: true, text: "!" },
    ]);
    assert.deepEqual(textRuns("plain", typed), [{ keys: true, text: "plain" }]);
  });

  test("splits a long batch by characters, not by UTF-16 units", () => {
    assert.deepEqual(splitByCharacters("😀😀😀", 2), ["😀😀", "😀"]);
  });

  test("gathers text until it is quiet, and sends it before the next key", async () => {
    const pasted: string[] = [];
    const lane = new InputLane({ paste: async (text) => void pasted.push(text), failed: () => undefined, quietMs: 30 });
    lane.text("日");
    lane.text("本");
    await wait(60);
    assert.deepEqual(pasted, ["日本"]);
    const order: string[] = [];
    lane.text("é");
    await lane.run(async () => void order.push(`key after ${pasted.at(-1)}`));
    assert.deepEqual(order, ["key after é"]);
  });
});

describe("the person's input, from the input connection", () => {
  test("a click is a touch where it lands, its moves follow, and viewers see it", async () => {
    const { open, touches, generation } = await started();
    const echoes: { verb: string; contacts: readonly TouchContact[]; by: string; generation: number }[] = [];
    const viewer = await open("viewer", {
      onText: (text) => {
        const parsed = parseDeviceServerMessage(text);
        if (parsed.ok && parsed.value.verb === "BB_DEVICE_TOUCH") echoes.push(parsed.value);
      },
    });
    const input = await open("input");
    for (const message of ["m,100,200,0,0", "m,100,200,1,0", "m,110,230,1,0", "m,110,230,0,0"]) await input.send(message);
    await until("the lift", () => touches().length >= 3);
    assert.deepEqual(touches(), [[{ id: 0, x: 100, y: 200 }], [{ id: 0, x: 110, y: 230 }], []]);
    await until("the echo", () => echoes.length >= 3);
    assert.deepEqual(echoes[0], { verb: "BB_DEVICE_TOUCH", contacts: [{ id: 0, x: 100, y: 200 }], by: "person", generation });
    assert.deepEqual(echoes.at(-1)!.contacts, []);
    await viewer.close();
    await input.close();
  });

  test("the right button is a long press, held for its length", async () => {
    const { open, touches } = await started();
    const input = await open("input");
    const began = Date.now();
    for (const message of ["m,50,60,4,0", "m,50,60,0,0"]) await input.send(message);
    await until("the lift", () => touches().length >= 2, LONG_PRESS_MS + 2000);
    assert.ok(Date.now() - began >= LONG_PRESS_MS - 50);
    assert.deepEqual(touches(), [[{ id: 0, x: 50, y: 60 }], []]);
    await input.close();
  });

  test("with Alt held, a drag is a pinch: two touches mirrored about the centre, and Alt never reaches the device", async () => {
    const { open, touches, driver, video } = await started();
    const input = await open("input");
    for (const message of [...key(0xffe9).slice(0, 1), "m,150,300,1,0", "m,120,250,1,0", "m,120,250,0,0", "ku,65513"]) await input.send(message);
    await until("the lift", () => touches().length >= 3);
    const mirror = mirroredAboutCentre({ x: 120, y: 250 }, video);
    assert.deepEqual(touches()[1], [
      { id: 0, x: 120, y: 250 },
      { id: 1, x: mirror.x, y: mirror.y },
    ]);
    assert.deepEqual(touches().at(-1), []);
    assert.deepEqual(driver.record.keys, []);
    await input.close();
  });

  test("the wheel is a swipe from the pointer, a twelfth of the screen a notch, lifted once it stops", async () => {
    const { open, touches, video } = await started();
    const input = await open("input");
    for (const message of ["m,180,400,0,0", "m2,0,0,0,2", "m2,0,0,8,2", "m2,0,0,0,2"]) await input.send(message);
    await until("the lift", () => touches().at(-1)?.length === 0 && touches().length > 2, 2000);
    const ys = touches()
      .filter((contacts) => contacts.length)
      .map((contacts) => contacts[0]!.y);
    assert.equal(ys[0], 400);
    assert.ok(Math.abs(400 - ys.at(-1)! - (video.height * 2) / 12) < 1, `moved up two twelfths: ${ys.join(" ")}`);
    await input.close();
  });

  test("keys go by W3C name, text a US keyboard lacks goes as one paste with the clipboard put back, and kr lets go", async () => {
    const { open, driver, clear } = await started();
    const input = await open("input");
    const text = (words: string) => Buffer.from(words, "utf8").toString("base64");
    await input.send(`cw,${text("the person's copy")}`);
    await until("the clipboard", async () => (await driver.clipboard()) === "the person's copy");
    clear();
    for (const message of [...key(0x48), ...key(0x1000000 + 0x65e5), ...key(0x1000000 + 0x672c), ...key(0x21)]) await input.send(message);
    await until("the last key", () => driver.record.keys.length >= 4);
    assert.deepEqual(driver.record.pastes, ["日本"]);
    assert.deepEqual(driver.record.keys, [
      { key: "H", down: true },
      { key: "H", down: false },
      { key: "!", down: true },
      { key: "!", down: false },
    ]);
    await until("the clipboard put back", async () => (await driver.clipboard()) === "the person's copy");
    await input.send("kd,65505");
    await input.send("kr");
    await until("Shift let go", () => driver.record.keys.at(-1)?.key === "Shift" && !driver.record.keys.at(-1)!.down);
    await input.close();
  });

  test("committed text goes whole: keys when it is all on a US keyboard, a paste otherwise", async () => {
    const { open, driver } = await started();
    const input = await open("input");
    const japanese = await input.request({ type: "text", text: "こんにちは、世界" });
    assert.equal(japanese.ok, true);
    assert.deepEqual(driver.record.pastes, ["こんにちは、世界"]);
    const plain = await input.request({ type: "text", text: "ok" });
    assert.equal(plain.ok, true);
    assert.deepEqual(driver.record.keys.map((each) => each.key), ["o", "o", "k", "k"]);
    await input.close();
  });

  test("two fingers from a touch screen are two touches, and a touch from a picture before a turn is ended", async () => {
    const { open, touches, generation } = await started();
    const input = await open("input");
    const two = [
      { id: 0, x: 10, y: 20 },
      { id: 1, x: 30, y: 40 },
    ];
    assert.equal((await input.request({ type: "touch", contacts: two, generation })).ok, true);
    assert.equal((await input.request({ type: "touch", contacts: [], generation })).ok, true);
    assert.deepEqual(touches(), [two, []]);
    const stale = await input.request({ type: "touch", contacts: two, generation: generation - 1 });
    assert.equal(!stale.ok && stale.error.code, "stale-geometry");
    assert.deepEqual(touches().at(-1), []);
    const posing = await input.request({ type: "input", input: { type: "tap", at: { x: 1, y: 1, generation } }, owner: Date.now() });
    assert.equal(!posing.ok && posing.error.code, "superseded", "the agent's input comes only from the control connection that holds the lease");
    await input.close();
  });

  test("the input connection's end lifts its touch and keys", async () => {
    const { open, touches, driver } = await started();
    const input = await open("input");
    for (const message of ["kd,65505", "m,10,10,1,0"]) await input.send(message);
    await until("the touch", () => touches().length === 1);
    await input.close();
    await until("the lift", () => touches().at(-1)?.length === 0 && driver.record.keys.at(-1)?.down === false);
    assert.deepEqual(driver.record.keys, [
      { key: "Shift", down: true },
      { key: "Shift", down: false },
    ]);
  });
});

describe("control's owner fences the agent's input", () => {
  test("a person taking control halfway through the agent's swipe ends it where it is, and the agent's next input is refused", async () => {
    const { open, touches, driver, generation } = await started();
    const control = await open("control");
    const swipe = control.request({ type: "input", input: { type: "swipe", from: { x: 100, y: 600, generation }, to: { x: 100, y: 100, generation }, ms: 600 }, owner: 1 });
    await until("the swipe under way", () => touches().length >= 5);
    assert.equal((await control.request({ type: "owner", generation: 2, holder: "person" })).ok, true);
    const answer = await swipe;
    assert.equal(!answer.ok && answer.error.code, "person-has-control");
    assert.deepEqual(touches().at(-1), []);
    const moves = touches().length;
    await wait(200);
    assert.equal(touches().length, moves, "nothing of the swipe after the lift");
    assert.equal(driver.record.prepared > 0, true, "input made ready for the person");
    const refused = await control.request({ type: "input", input: { type: "tap", at: { x: 1, y: 1, generation } }, owner: 2 });
    assert.equal(!refused.ok && refused.error.code, "person-has-control");
    assert.equal((await control.request({ type: "owner", generation: 3, holder: "agent" })).ok, true);
    const old = await control.request({ type: "input", input: { type: "tap", at: { x: 1, y: 1, generation } }, owner: 2 });
    assert.equal(!old.ok && old.error.code, "superseded");
    const fresh = await control.request({ type: "input", input: { type: "tap", at: { x: 1, y: 1, generation } }, owner: 3 });
    assert.equal(fresh.ok, true);
    await control.close();
  });

  test("a person taking control halfway through the agent's paste abandons it before its paste key, and puts the clipboard back", async () => {
    const driver = new TestDriver("android");
    const { open } = await started(driver);
    await driver.setClipboard("the device's own");
    const setClipboard = driver.setClipboard.bind(driver);
    let slow = true;
    driver.setClipboard = async (text) => {
      await setClipboard(text);
      if (slow && text !== "the device's own") await wait(300);
    };
    const control = await open("control");
    const typing = control.request({ type: "input", input: { type: "text", text: "café" }, owner: 1 });
    await until("the clipboard set", () => driver.record.keys.length === 6);
    await wait(50);
    await control.request({ type: "owner", generation: 2, holder: "person" });
    const answer = await typing;
    slow = false;
    assert.equal(!answer.ok && answer.error.code, "person-has-control");
    assert.deepEqual(driver.record.pastes, []);
    assert.equal(await driver.clipboard(), "the device's own");
    await control.close();
  });

  test("the agent's text: keys for what a US keyboard has, one paste for each run it lacks, the clipboard put back", async () => {
    const { open, driver } = await started();
    await driver.setClipboard("kept");
    const control = await open("control");
    const answer = await control.request({ type: "input", input: { type: "text", text: "Hi 世界!" }, owner: 1 });
    assert.equal(answer.ok, true);
    assert.deepEqual(driver.record.pastes, ["世界"]);
    assert.deepEqual(
      driver.record.keys.filter((each) => each.down).map((each) => each.key),
      ["H", "i", " ", "!"],
    );
    assert.equal(await driver.clipboard(), "kept");
    await control.close();
  });

  test("a turn refuses the agent's points from before it, and a gesture under way is ended", async () => {
    const { open, generation, touches } = await started();
    const control = await open("control");
    const turned = await control.request({ type: "control", control: { action: "rotate", turn: "left" } });
    assert.equal(turned.ok, true);
    await until("the new picture", () => (control.state.geometry?.generation ?? generation) !== generation);
    const stale = await control.request({ type: "input", input: { type: "tap", at: { x: 1, y: 1, generation } }, owner: 1 });
    assert.equal(!stale.ok && stale.error.code, "stale-geometry");
    assert.equal(touches().filter((contacts) => contacts.length).length, 0);
    await control.close();
  });
});
