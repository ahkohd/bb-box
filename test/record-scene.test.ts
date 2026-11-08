
import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingInputs, isSecretTyping, keysymKey, looksLikeSecret, normalChord, type InputEvent } from "../src/core/record-input.ts";
import { chordWords, planKeyPills, TYPING_WORDS } from "../src/core/record-keys.ts";
import {
  CLIP_FPS,
  GLIDE_S,
  ZOOM_MOST,
  ZOOM_POINT,
  cameraAt,
  glideEase,
  keptMotion,
  planCamera,
  planPointer,
  pointerShapes,
  shapeAt,
  SHAPE_HOLD_S,
  MOVE_S,
  typingFocus,
  typingSpan,
  viewCovers,
  type Scene,
} from "../src/core/record-motion.ts";
import { GRID_COLUMNS, GRID_ROWS, areaOnClip, planScene, pointerVariants, sceneCommands, zoomFilter, type BrightnessGrid, type SceneFacts } from "../src/core/record-scene.ts";
import { ringArt } from "../src/core/record-art.ts";
import { cursorArt, cursorCanvas } from "../src/core/record-cursors.ts";
import { pngPixels } from "../src/core/png.ts";
import { clipGraph, driverDrawsAgentCursor, parsePrepared, planClip, withAgentCursorHidden, type Prepared } from "../src/core/record.ts";
import { personInput } from "../src/core/selkies.ts";

const SCREEN = { width: 1920, height: 1080 };

function scene(parts: Partial<Scene>): Scene {
  return { ...SCREEN, length: 20, samples: [], clicks: [], scrolls: [], typing: [], changes: [], ...parts };
}

function camera(parts: Partial<Scene>) {
  const planned = scene(parts);
  return planCamera(planned, planPointer(planned));
}

function evaluate(expression: string, it: number): number {
  const functions: Record<string, (...args: number[]) => number> = {
    gte: (a, b) => (a! >= b! ? 1 : 0),
    lt: (a, b) => (a! < b! ? 1 : 0),
    max: (a, b) => Math.max(a!, b!),
    pow: (a, b) => a! ** b!,
    clip: (a, low, high) => Math.min(high!, Math.max(low!, a!)),
  };
  let at = 0;
  const source = expression.replace(/\s/g, "");
  const peek = () => source[at];
  const sum = (): number => {
    let value = product();
    while (peek() === "+" || peek() === "-") value = source[at++] === "+" ? value + product() : value - product();
    return value;
  };
  const product = (): number => {
    let value = unary();
    while (peek() === "*" || peek() === "/") value = source[at++] === "*" ? value * unary() : value / unary();
    return value;
  };
  const unary = (): number => (peek() === "-" ? (at++, -unary()) : atom());
  const atom = (): number => {
    if (peek() === "(") {
      at++;
      const value = sum();
      at++;
      return value;
    }
    const number = /^\d+(\.\d+)?/.exec(source.slice(at));
    if (number) {
      at += number[0].length;
      return Number(number[0]);
    }
    const name = /^[a-z]+/.exec(source.slice(at))![0];
    at += name.length;
    if (name === "it") return it;
    at++;
    const args: number[] = [];
    if (name === "if") {
      const condition = sum();
      at++;
      const yes = sum();
      at++;
      const no = sum();
      at++;
      return condition ? yes : no;
    }
    for (;;) {
      args.push(sum());
      if (source[at++] === ")") break;
    }
    return functions[name]!(...args);
  };
  return sum();
}

function zoomExpressions(filter: string): { z: string; x: string } {
  const z = /z='([^']*)'/.exec(filter)![1]!;
  const x = /x='clip\(\((.*)\)-iw\/zoom\/2,0,iw-iw\/zoom\)'/.exec(filter)![1]!;
  return { z, x };
}

test("the zoom's expression gives the camera's zoom at every frame, finite before, during and after each move, so ffmpeg never sees a NaN (073)", () => {
  const plan = planScene(facts({ inputs: [click(2, 400, 300), click(9, 1500, 900)] }), SCREEN, 1000, 14, { zoom: true, frame: false });
  assert.ok(plan.zooms, "two groups far apart: two zooms");
  const { z, x } = zoomExpressions(zoomFilter(plan));
  for (let frame = 0; frame <= 14 * CLIP_FPS; frame++) {
    const t = frame / CLIP_FPS;
    const expected = cameraAt(plan.camera, t);
    const zoom = evaluate(z, t);
    assert.ok(Number.isFinite(zoom), `the zoom is a number at ${t.toFixed(3)} s`);
    assert.ok(Math.abs(zoom - Math.max(1, expected.zoom)) < 0.002, `${zoom} against ${expected.zoom} at ${t.toFixed(3)} s`);
    assert.ok(Math.abs(evaluate(x, t) - expected.x) < 0.6, `the centre at ${t.toFixed(3)} s`);
  }
});

function facts(parts: Partial<SceneFacts>): SceneFacts {
  return { pointer: "drawn", screen: null, samples: [], changes: [], luma: 40, lag: 0, keys: "pc", inputs: [], ...parts };
}

function click(at: number, x: number, y: number, button: "left" | "right" = "left", count: 1 | 2 = 1): InputEvent {
  return { at: 1000 + at, by: "agent", type: "click", space: "screen", button, count, x, y, area: null };
}

test("a single click zooms 1.8x and arrives before it, holds, and zooms out after it; clicks spread over the screen do not zoom (073)", () => {
  const one = camera({ clicks: [{ at: 5, x: 600, y: 400, button: "left", count: 1, area: null }] });
  const at = (t: number) => cameraAt(one, t);
  assert.equal(at(3).zoom, 1);
  assert.equal(at(4.85).zoom, ZOOM_POINT, "settled before the click lands");
  assert.equal(at(6.4).zoom, ZOOM_POINT, "held while its result shows");
  assert.equal(at(8).zoom, 1, "out again");
  assert.ok(at(4.4).zoom > 1 && at(4.4).zoom < ZOOM_POINT, "eased in, not cut");
  const spread = camera({ clicks: [{ at: 5, x: 50, y: 50, button: "left", count: 1, area: null }, { at: 5.5, x: 1870, y: 1030, button: "left", count: 1, area: null }] });
  for (const key of spread) assert.ok(key.view.zoom === 1 || key.view.zoom >= 1.3, "never a slight zoom");
  assert.ok(spread.every((key) => key.view.zoom <= ZOOM_MOST));
});

test("the view stays on the screen, and two groups close together pan from one to the other rather than zoom out between (073)", () => {
  const clicks = [
    { at: 3, x: 20, y: 20, button: "left" as const, count: 1 as const, area: null },
    { at: 6.5, x: 1900, y: 1060, button: "left" as const, count: 1 as const, area: null },
  ];
  const keys = camera({ clicks });
  for (let t = 0; t < 12; t += 0.05) {
    const view = cameraAt(keys, t);
    assert.ok(view.x - SCREEN.width / view.zoom / 2 >= -0.5 && view.x + SCREEN.width / view.zoom / 2 <= SCREEN.width + 0.5, `inside at ${t}`);
    assert.ok(view.y - SCREEN.height / view.zoom / 2 >= -0.5 && view.y + SCREEN.height / view.zoom / 2 <= SCREEN.height + 0.5, `inside at ${t}`);
  }
  for (let t = 4.5; t < 6.5; t += 0.1) assert.ok(cameraAt(keys, t).zoom > 1.5, `no zoom out between the two, at ${t.toFixed(1)} s`);
});

test("a big change outside the view zooms out early, and zoom off keeps the whole screen (073)", () => {
  const clicks = [{ at: 4, x: 300, y: 300, button: "left" as const, count: 1 as const, area: null }];
  const changes = [{ at: 4.6, x: 900, y: 100, width: 900, height: 800 }];
  const early = camera({ clicks, changes });
  assert.equal(cameraAt(early, 5.6).zoom, 1, "out by a second after the dialog opened");
  const late = camera({ clicks });
  assert.equal(cameraAt(late, 5.4).zoom, ZOOM_POINT);
  const off = planScene(facts({ inputs: [click(4, 300, 300)] }), SCREEN, 1000, 10, { zoom: false, frame: false });
  assert.equal(off.zooms, false);
  assert.match(zoomFilter(off), /^scale=/);
});

test("the pointer glides to a click on the web demo's curve, arriving as it lands, and stays put while still (073)", () => {
  const samples = [{ at: 0, x: 100, y: 100, buttons: 0 }];
  const clicks = [{ at: 4, x: 900, y: 600, button: "left" as const, count: 1 as const, area: null }];
  const plan = planPointer(scene({ samples, clicks, length: 6 }));
  const frame = (t: number) => plan.frames[Math.round(t * CLIP_FPS)]!;
  assert.deepEqual(frame(4 - GLIDE_S - 0.1), { x: 100, y: 100 }, "still until the glide");
  assert.deepEqual(frame(4), { x: 900, y: 600 }, "there as the click lands");
  const distances = Array.from({ length: GLIDE_S * CLIP_FPS + 1 }, (_, index) => Math.hypot(frame(4 - GLIDE_S + index / CLIP_FPS).x - 900, frame(4 - GLIDE_S + index / CLIP_FPS).y - 600));
  assert.ok(distances.every((distance, index) => index === 0 || distance <= distances[index - 1]!), "always closer");
  assert.ok(distances[Math.round(distances.length / 2)]! < distances[0]! * 0.15, "eased out: most of the way by half time");
  assert.ok(Math.abs(glideEase(0.5) - 0.966) < 0.005, "cubic-bezier(0.23, 1, 0.32, 1), close to an ease-out quint");
  assert.deepEqual(plan.glides, [{ from: 3.5, to: 4 }]);
  assert.equal(plan.visibleFrom, 0, "sampled from the start");
});

test("a pointer that rests and then moves does not creep towards where it went, and a person's motion is smoothed without lag (073)", () => {
  const moving = Array.from({ length: 31 }, (_, index) => ({ at: 5 + index / 30, x: 200 + index * 10, y: 300, buttons: 0 }));
  const plan = planPointer(scene({ samples: [{ at: 0, x: 200, y: 300, buttons: 0 }, ...moving.slice(1)], length: 8 }));
  assert.deepEqual(plan.frames[Math.round(4 * CLIP_FPS)], { x: 200, y: 300 }, "at rest until it moves");
  for (const sample of moving.slice(3, -3)) {
    const frame = plan.frames[Math.round(sample.at * CLIP_FPS)]!;
    assert.ok(Math.abs(frame.x - sample.x) <= 2, `on the path, not behind it, at ${sample.at.toFixed(3)} s`);
  }
});

test("clicks show rings, left, right and double; a sampled press is one with the agent's click there; a held button is a drag (073)", () => {
  const clicks = [
    { at: 2, x: 500, y: 500, button: "left" as const, count: 1 as const, area: null },
    { at: 4, x: 700, y: 500, button: "right" as const, count: 1 as const, area: null },
    { at: 6, x: 900, y: 500, button: "left" as const, count: 2 as const, area: null },
  ];
  const samples = [
    { at: 0, x: 100, y: 100, buttons: 0 },
    { at: 2.02, x: 502, y: 501, buttons: 1 },
    { at: 2.08, x: 502, y: 501, buttons: 0 },
    { at: 8, x: 300, y: 300, buttons: 1 },
    { at: 8.3, x: 400, y: 330, buttons: 1 },
    { at: 8.9, x: 600, y: 360, buttons: 1 },
    { at: 9.1, x: 600, y: 360, buttons: 0 },
  ];
  const plan = planPointer(scene({ clicks, samples, length: 12 }));
  assert.deepEqual(plan.rings.map((ring) => `${ring.kind}@${ring.at}`), ["left@2", "right@4", "left@6", "left@6.12"]);
  assert.deepEqual(plan.drags, [{ from: 8, to: 9.1 }]);
});

test("keys show as chords, counted when repeated, and typing as one pill; Backspace while typing is typing; nothing for secret typing (073)", () => {
  const chord = (key: string, ...modifiers: string[]) => normalChord(key, modifiers);
  assert.equal(chordWords(chord("s", "ctrl"), "pc"), "Ctrl+S");
  assert.equal(chordWords(chord("k", "cmd"), "mac"), "⌘K");
  assert.equal(chordWords(chord("t", "shift", "cmd"), "mac"), "⇧⌘T");
  assert.equal(chordWords(chord("Return"), "pc"), "Enter");
  assert.equal(chordWords(chord("Left", "alt"), "mac"), "⌥←");
  const keys = [
    { at: 1, chord: chord("Down") },
    { at: 1.3, chord: chord("Down") },
    { at: 1.6, chord: chord("Down") },
    { at: 6.2, chord: chord("BackSpace") },
    { at: 9, chord: chord("s", "ctrl") },
  ];
  const typing = [
    { at: 5, secret: false, characters: 1 },
    { at: 5.8, secret: false, characters: 1 },
    { at: 7, secret: false, characters: 1 },
    { at: 12, secret: true, characters: 1 },
    { at: 12.5, secret: true, characters: 1 },
  ];
  const pills = planKeyPills(keys, typing, "pc", 20);
  assert.deepEqual(pills.map((pill) => [pill.text, pill.from, pill.to]), [
    ["↓ ×3", 1, 2.8],
    [TYPING_WORDS, 5, 7.6],
    ["Ctrl+S", 9, 10.2],
  ]);
  assert.ok(!pills.some((pill) => pill.from >= 12), "the password's typing shows nothing");
});

test("one typing call is one pill, from when the text is in, including a Mac's slow call and the keys it echoes (073)", () => {
  const chord = (key: string, ...modifiers: string[]) => normalChord(key, modifiers);
  const slow = planKeyPills(
    [
      { at: 15, chord: chord("a", "cmd") },
      { at: 16.4, chord: chord("s", "cmd") },
    ],
    [
      { at: 10.5, secret: false, characters: 57 },
      { at: 13.2, secret: false, characters: 0 },
    ],
    "mac",
    30,
  );
  assert.deepEqual(
    slow.map((pill) => [pill.text, pill.from]),
    [
      [TYPING_WORDS, 13.2],
      ["⌘A", 15],
      ["⌘S", 16.4],
    ],
  );
  const echoed = planKeyPills(
    [],
    [
      { at: 10.5, secret: false, characters: 57 },
      { at: 11, secret: true, characters: 1 },
      { at: 12.4, secret: true, characters: 1 },
      { at: 13.2, secret: false, characters: 0 },
    ],
    "mac",
    30,
  );
  assert.deepEqual(echoed.map((pill) => [pill.text, pill.from]), [[TYPING_WORDS, 13.2]]);
});

test("a secret call does not lengthen or hide a public Typing pill, and the same call's echoes stay one pill (073)", () => {
  const after = planKeyPills(
    [],
    [
      { at: 2, secret: false, characters: 12, by: "agent", call: 1 },
      { at: 2.1, secret: false, characters: 0, by: "agent", call: 1 },
      { at: 3, secret: true, characters: 1, by: "agent", call: 2 },
    ],
    "pc",
    20,
  );
  assert.deepEqual(after.map((pill) => [pill.text, pill.from, pill.to]), [[TYPING_WORDS, 2.1, 3.1]]);
  const person = planKeyPills(
    [],
    [
      { at: 2, secret: false, characters: 12, by: "agent", call: 1 },
      { at: 2.1, secret: false, characters: 0, by: "agent", call: 1 },
      { at: 3, secret: true, characters: 1, by: "person" },
    ],
    "pc",
    20,
  );
  assert.deepEqual(person.map((pill) => [pill.text, pill.from, pill.to]), [[TYPING_WORDS, 2.1, 3.1]]);
  const other = planKeyPills(
    [],
    [
      { at: 2, secret: false, characters: 12, by: "agent", call: 1 },
      { at: 2.1, secret: false, characters: 0, by: "agent", call: 1 },
      { at: 3, secret: false, characters: 1, by: "agent", call: 2 },
    ],
    "pc",
    20,
  );
  assert.equal(other[0]?.to, 3, "a different call does not stretch the first pill");
  assert.equal(other.length, 2);
  const echoed = planKeyPills(
    [],
    [
      { at: 10.5, secret: false, characters: 57, by: "agent", call: 1 },
      { at: 11, secret: true, characters: 1, by: "agent", call: 1 },
      { at: 12.4, secret: true, characters: 1 },
      { at: 13.2, secret: false, characters: 0, by: "agent", call: 1 },
    ],
    "mac",
    30,
  );
  assert.deepEqual(echoed.map((pill) => [pill.text, pill.from, pill.to]), [[TYPING_WORDS, 13.2, 14.2]]);
  const edited = planKeyPills([{ at: 3, chord: normalChord("Backspace", []) }], [{ at: 2, secret: false, characters: 12, by: "agent", call: 1 }, { at: 2.1, secret: false, characters: 0, by: "agent", call: 1 }], "pc", 20);
  assert.deepEqual(edited.map((pill) => [pill.text, pill.from, pill.to]), [[TYPING_WORDS, 2.1, 3.6]]);
});

test("only Shift is typing, and so is Option on a Mac; a person's printable keys are logged as typing, never as the character (073)", () => {
  const inputs = new RecordingInputs(() => 5_000);
  inputs.begin("mac", 0, "macos");
  inputs.acted("mac", { type: "keys", key: "2", modifiers: ["option"] });
  inputs.acted("mac", { type: "keys", key: "a", modifiers: ["shift"] });
  inputs.acted("mac", { type: "keys", key: "c", modifiers: ["cmd"] });
  assert.deepEqual(inputs.end("mac")!.map((event) => event.type), ["typing", "typing", "keys"]);
  const person = new RecordingInputs(() => 5_000);
  person.begin("pc", 0, "linux");
  for (const [keysym, down] of [[0xffe3, true], [0x73, true], [0x73, false], [0xffe3, false], [0x70, true], [0x77, true], [0xff0d, true]] as const) person.person("pc", { type: "key", keysym, down });
  const events = person.end("pc")!;
  assert.deepEqual(events.map((event) => (event.type === "keys" ? chordWords(event.chord, "pc") : event.type)), ["Ctrl+S", "typing", "typing", "Enter"]);
  assert.doesNotMatch(JSON.stringify(events), /"[pw]"/, "no typed character is kept");
  assert.equal(keysymKey(0x1000041), "A");
  assert.equal(keysymKey(0x1000416), null, "a character past ASCII is never a shortcut's key");
});

test("typed text never reaches the log, and secret typing is told by its role, its name or the text's shape; its end stays secret (073)", () => {
  assert.ok(isSecretTyping("password text", null, "hunter2"));
  assert.ok(isSecretTyping("AXSecureTextField", "", "hunter2"));
  assert.ok(isSecretTyping("text", "API key", "abc"));
  assert.ok(isSecretTyping("entry", "PIN", "1234"));
  assert.ok(looksLikeSecret("sk-ant-1234"));
  assert.ok(looksLikeSecret("ghp_abcdefghijklmnop"));
  assert.ok(looksLikeSecret("Xk9#mP2$vL7!qR4w"));
  assert.ok(!looksLikeSecret("Hello from bb-box. This note is typed by an agent."));
  assert.ok(!isSecretTyping("text", "Search", "weather in Lisbon"));
  const inputs = new RecordingInputs(() => 1_000);
  inputs.begin("box", 0, "linux");
  inputs.acted("box", { type: "typing", characters: 8, area: { x: 10, y: 10, width: 200, height: 20 }, secret: true });
  inputs.acted("box", { type: "typing", characters: 0, area: null, secret: false });
  inputs.acted("box", { type: "keys", key: "Return", modifiers: [] });
  inputs.acted("box", { type: "typing", characters: 0, area: null, secret: false });
  const events = inputs.end("box")!;
  assert.deepEqual(events.map((event) => (event.type === "typing" ? `typing ${event.characters} ${event.secret}` : event.type)), ["typing 8 true", "typing 0 true", "keys"], "a chord's own end adds no typing");
  const secret = planScene(facts({ inputs: [{ at: 1003, by: "agent", type: "typing", characters: 8, space: "screen", area: { x: 800, y: 500, width: 200, height: 24 }, secret: true }] }), SCREEN, 1000, 10, { zoom: true, frame: false });
  assert.equal(secret.zooms, false, "no zoom on a password field");
  assert.deepEqual(secret.pills, []);
});

test("still stretches are cut around the motion: glides, rings, pills' first second and zoom moves are kept (073)", () => {
  assert.deepEqual(keptMotion([[1, 10]], [{ from: 3, to: 4 }, { from: 9.8, to: 12 }]), [[1, 3], [4, 9.8]]);
  assert.deepEqual(keptMotion([[1, 2]], [{ from: 1.2, to: 1.9 }]), [], "pieces too short to cut are kept");
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 20,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [[0.5, 9.9]],
    events: [],
    scene: facts({ inputs: [click(10, 600, 400)] }),
  };
  const plan = planClip(prepared, 1);
  for (const [from, to] of plan.cuts) assert.ok(to <= 10 - GLIDE_S || from >= 10.4, `the cut ${from}-${to} keeps the glide and ring`);
});

test("the pointer's commands move it each frame it moves, show it from when it is known, and switch each ring stage on and off in turn (073)", () => {
  const plan = planScene(facts({ samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }], inputs: [click(3, 500, 400)] }), SCREEN, 1000, 5, { zoom: true, frame: true });
  const commands = sceneCommands(plan).trim().split("\n");
  assert.match(commands[0]!, /^0\.000 overlay@arrowl x \d+, overlay@arrowl y \d+;$/, "a dark screen, so the light arrow");
  assert.ok(commands.includes("0.000 overlay@arrowl enable 1;"));
  const ring = commands.filter((line) => line.includes("overlay@ringll0"));
  assert.match(ring[0]!, /^3\.000 overlay@ringll0 x \d+, overlay@ringll0 y \d+, overlay@ringll0 enable 1;$/);
  assert.equal(ring[1], "3.067 overlay@ringll0 enable 0;");
  const times = commands.map((line) => Number(line.split(" ")[0]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in time order");
  assert.ok(plan.frame && plan.art.some((art) => art.name === "corner.png"));
});

test("a framed clip insets the screen on a background that matches its brightness, and its key pills move away from the pointer (073)", () => {
  const typing: InputEvent = { at: 1004, by: "agent", type: "typing", characters: 12, space: "screen", area: { x: 600, y: 1000, width: 400, height: 30 }, secret: false };
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 10,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events: [],
    scene: facts({ luma: 200, samples: [{ at: 1000, x: 800, y: 1040, buttons: 0 }], inputs: [typing, { at: 1007, by: "agent", type: "keys", chord: normalChord("s", ["ctrl"]) }] }),
  };
  const plan = planClip(prepared, 1, { zoom: false, frame: true });
  assert.deepEqual([plan.width, plan.height, plan.scene!.frame!.inset, plan.scene!.frame!.background], [1280, 758, 44, "ececee"]);
  assert.match(clipGraph(plan, true), /pad=1280:758:44:44:color=0xececee/);
  const pills = plan.overlays.filter((overlay) => overlay.look === "key");
  assert.deepEqual(pills.map((pill) => pill.text), [TYPING_WORDS, "Ctrl+S"]);
  assert.ok(pills.every((pill) => pill.y < plan.height / 2), "the pointer is low, so the pills go to the top");
  assert.equal(planClip({ ...prepared, scene: { ...prepared.scene!, luma: 30 } }, 1).scene!.frame!.background, "161618");
});

test("a key pill sits below the region it would cover, or above it when below does not fit (073)", () => {
  const line = { at: 3.2, x: 180, y: 16, width: 520, height: 28 };
  const typing: InputEvent = { at: 1003, by: "agent", type: "typing", characters: 40, space: "screen", area: { x: 160, y: 8, width: 600, height: 48 }, secret: false };
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 8,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events: [],
    position: "bottom",
    scene: facts({ samples: [{ at: 1000, x: 700, y: 500, buttons: 0 }], changes: [line], inputs: [typing] }),
  };
  const plan = planClip(prepared, 1, { zoom: true, frame: false });
  const pill = plan.overlays.find((overlay) => overlay.look === "key")!;
  const placed = areaOnClip(plan.scene!, line, 3);
  assert.ok(pill.y >= placed.y + placed.height, `the pill at ${pill.y} is below the line, which ends at ${placed.y + placed.height}`);
  const low: InputEvent = { ...typing, area: { x: 400, y: 980, width: 700, height: 40 } };
  const covered = planClip({ ...prepared, position: "top", scene: facts({ samples: [{ at: 1000, x: 700, y: 400, buttons: 0 }], changes: [{ ...line, y: 990, height: 36 }], inputs: [low] }) }, 1, { zoom: true, frame: false });
  const lowPill = covered.overlays.find((overlay) => overlay.look === "key")!;
  const lowLine = areaOnClip(covered.scene!, { ...line, y: 990, height: 36 }, 3);
  const lowTall = Math.round(covered.fontSize * 2.1);
  assert.ok(lowPill.y + lowTall <= lowLine.y + 1, `the pill at ${lowPill.y} is above a line at the bottom of the picture`);
});

test("the stop's facts carry the sampler's pointer, the changed regions and the brightness; a person's Selkies input is read as pointer places and keys (073)", () => {
  const stdout = `{"ended":"stopped","recorded":12.5,"size":"1920x1080","start":1000.000,"position":"top","cuts":[[1.5,3]],"pointer":"drawn","lag":0.09,"luma":71.2,"keys":"pc"}\nP screen 1920 1080\nP 1000.100 10 20 0\nP 1000.400 15 25 1\nC 2.250 400 300 120 24\n`;
  const prepared = parsePrepared(stdout)!;
  assert.deepEqual(prepared.scene, { pointer: "drawn", screen: { width: 1920, height: 1080 }, samples: [{ at: 1000.1, x: 10, y: 20, buttons: 0 }, { at: 1000.4, x: 15, y: 25, buttons: 1 }], changes: [{ at: 2.25, x: 400, y: 300, width: 120, height: 24 }], luma: 71.2, lag: 0.09, keys: "pc", agentCursor: false });
  assert.deepEqual(personInput("m,640,360,1,0,77"), { type: "pointer", x: 640, y: 360, buttons: 1 });
  assert.deepEqual(personInput("kd,65293"), { type: "key", keysym: 65293, down: true });
  assert.equal(personInput("m2,4,-3,0,0"), null, "relative motion is not a place");
  assert.equal(personInput("co,aGVsbG8="), null, "the clipboard is not input");
});

test("a typing call that never closes stays at its start, and a slow close still reaches the text (073)", () => {
  const set = { at: 10, characters: 8, area: { x: 100, y: 200, width: 900, height: 28 }, secret: false, by: "agent" as const, call: 1 };
  const keys = [
    { at: 25, characters: 1, area: null, secret: true, by: "person" as const },
    { at: 31, characters: 1, area: null, secret: true, by: "person" as const },
  ];
  assert.deepEqual(typingSpan(set, [set, ...keys]), { from: 10, to: 10 });
  const line = { at: 10.1, x: 100, y: 200, width: 900, height: 28 };
  const wide = { at: 25, x: 10, y: 10, width: 1190, height: 580 };
  assert.deepEqual(typingFocus(scene({ typing: [set, ...keys], changes: [line, wide] }), set, planPointer(scene({}))), { x: line.x, y: line.y, width: line.width, height: line.height });
  const slow = { at: 10.5, characters: 57, area: { x: 40, y: 360, width: 900, height: 28 }, secret: false };
  const close = { at: 13.2, characters: 0, area: null, secret: false };
  assert.deepEqual(typingSpan(slow, [slow, close]), { from: 10.5, to: 13.2 });
  const during = { at: 12.8, x: 40, y: 360, width: 900, height: 28 };
  assert.deepEqual(typingFocus(scene({ typing: [slow, close], changes: [during] }), slow, planPointer(scene({}))), { x: during.x, y: during.y, width: during.width, height: during.height });
  const foreign = { at: 12, characters: 0, area: null, secret: false, by: "agent" as const, call: 2 };
  assert.deepEqual(typingSpan(set, [set, foreign]), { from: 10, to: 10 });
});

test("an I-beam stays from the click in a field until the pointer glides away, and through the Typing pill (073)", () => {
  const field = { at: 2, x: 400, y: 300, button: "left" as const, count: 1 as const, area: null, role: "textbox" };
  const button = { at: 6, x: 900, y: 700, button: "left" as const, count: 1 as const, area: null, role: "push button" };
  const typing = [
    { at: 2.5, characters: 12, area: null, secret: false, role: "textbox" },
    { at: 3.2, characters: 0, area: null, secret: false },
  ];
  const shapes = pointerShapes(scene({ clicks: [field, button], typing }));
  assert.equal(shapeAt(shapes, 2.3), "ibeam");
  assert.equal(shapeAt(shapes, 3.7), "ibeam");
  assert.equal(shapeAt(shapes, 5.4), "ibeam");
  assert.equal(shapeAt(shapes, 5.6), "arrow");
  assert.equal(shapeAt(shapes, 6.05), "hand");
});

test("a drag whose press names a window frames that window where the drag ends (073)", () => {
  const window = { x: 400, y: 200, width: 700, height: 480 };
  const samples = [
    { at: 1, x: 500, y: 240, buttons: 0 },
    { at: 1.2, x: 500, y: 240, buttons: 1 },
    { at: 2, x: 900, y: 500, buttons: 1 },
    { at: 2.2, x: 900, y: 500, buttons: 0 },
  ];
  const planned = scene({ samples, clicks: [{ at: 1.2, x: 500, y: 240, button: "left" as const, count: 1 as const, area: null, window }] });
  const pointer = planPointer(planned);
  const view = cameraAt(planCamera(planned, pointer), 2.2);
  const frameAt = (t: number) => pointer.frames[Math.min(pointer.frames.length - 1, Math.max(0, Math.round(t * CLIP_FPS)))]!;
  const start = frameAt(1.2);
  const end = frameAt(2);
  const moved = { x: window.x + end.x - start.x, y: window.y + end.y - start.y, width: window.width, height: window.height };
  assert.ok(viewCovers(SCREEN, view, moved), `the window at the end stays in frame at zoom ${view.zoom}`);
  assert.ok(view.zoom < ZOOM_POINT);
});

test("typing into a large text area zooms on where the text appears, or on the pointer, not on the whole area (073)", () => {
  const area = { x: 644, y: 353, width: 640, height: 452 };
  const typing = { at: 3, characters: 50, area, secret: false };
  const line = { at: 3.25, x: 650, y: 380, width: 300, height: 18 };
  const elsewhere = { at: 3.25, x: 1700, y: 10, width: 60, height: 12 };
  const pointer = planPointer(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }] }));
  assert.deepEqual(typingFocus(scene({ typing: [typing], changes: [line, elsewhere] }), typing, pointer), { x: 650, y: 380, width: 300, height: 18 }, "the text as it appears, inside the field");
  assert.deepEqual(typingFocus(scene({ typing: [typing] }), typing, pointer), area, "else the element's frame");
  const unplaced = { ...typing, area: null };
  assert.deepEqual(typingFocus(scene({ typing: [unplaced] }), unplaced, pointer), { x: 900, y: 500, width: 0, height: 0 }, "else where the pointer is");
  const camera = planCamera(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }], typing: [typing], changes: [line] }), pointer);
  assert.ok(cameraAt(camera, 3.4).zoom > 1.5, "the click and the typing after it stay zoomed in");
});

test("a typing zoom keeps the whole changed region inside the frame, and zooms less instead of cropping it (073)", () => {
  const line = { at: 3.4, x: 40, y: 360, width: 1500, height: 28 };
  const field = { x: 30, y: 280, width: 1700, height: 520 };
  const typing = { at: 3, characters: 57, area: field, secret: false };
  const click = { at: 2.4, x: 900, y: 540, button: "left" as const, count: 1 as const, area: null };
  const planned = scene({ clicks: [click], typing: [typing], changes: [line] });
  const pointer = planPointer(planned);
  assert.deepEqual(typingFocus(planned, typing, pointer), { x: line.x, y: line.y, width: line.width, height: line.height });
  const view = cameraAt(planCamera(planned, pointer), 3.5);
  assert.ok(viewCovers(SCREEN, view, line), `the line stays inside at zoom ${view.zoom}`);
  assert.ok(view.zoom < 1.8, "a line that does not fit at the usual zoom is framed wider");
});

test("a key pill lasts its own time even where a caption's hold freezes the clip after it (073)", () => {
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 6,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events: [{ at: 1005.2, kind: "pass", text: "The note is typed and selected, and the window moved" }],
    scene: facts({ inputs: [{ at: 1005, by: "agent", type: "keys", chord: normalChord("Escape", []) }] }),
  };
  const plan = planClip(prepared, 1, { zoom: true, frame: false });
  assert.ok(plan.holds.length > 0, "the result is held to be read");
  const pill = plan.overlays.find((overlay) => overlay.look === "key")!;
  assert.equal(pill.text, "Esc");
  assert.ok(pill.to - pill.from <= 1.2 + 0.001, `${pill.to - pill.from} s`);
});

test("where Cua draws the agent's own pointer, as on macOS, BB Box draws only the real pointer, from when it first moves, and still rings each click (073)", () => {
  const clicks = [{ at: 3, x: 700, y: 400, button: "left" as const, count: 1 as const, area: null }];
  const parked = planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }], agentCursor: true }));
  assert.equal(parked.visibleFrom, null, "a pointer parked in the corner all along is not drawn");
  assert.deepEqual(parked.rings.map((ring) => [ring.x, ring.y]), [[700, 400]]);
  const moved = planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }, { at: 5, x: 40, y: 30, buttons: 0 }, { at: 5.03, x: 80, y: 60, buttons: 0 }], agentCursor: true }));
  assert.ok(moved.visibleFrom !== null && moved.visibleFrom > 4.9 && moved.visibleFrom < 5, "shown once a person moves it");
  assert.deepEqual(moved.frames[Math.round(3 * CLIP_FPS)], { x: 0, y: 0 }, "the agent's click does not move it");
  assert.deepEqual(planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }] })).frames[Math.round(3 * CLIP_FPS)], { x: 700, y: 400 }, "elsewhere it glides to the click");
});

const XK_SHIFT_L = 0xffe1;
const XK_CONTROL_L = 0xffe3;
const XK_META_L = 0xffe7;
const XK_ALT_L = 0xffe9;
const XK_ALT_R = 0xffea;
const XK_ISO_LEVEL3_SHIFT = 0xfe03;
const XK_MODE_SWITCH = 0xff7e;
const XK_F4 = 0xffc1;
const UNICODE_EURO = 0x10020ac;

function personKeys(os: "linux" | "macos" | "windows", keys: readonly (readonly [number, boolean])[], macKeys: "alt-command" | null = null): readonly InputEvent[] {
  const inputs = new RecordingInputs(() => 5_000);
  inputs.begin("box", 0, os);
  for (const [keysym, down] of keys) inputs.person("box", { type: "key", keysym, down }, macKeys);
  return inputs.end("box")!;
}

function pressed(events: readonly InputEvent[], style: "mac" | "pc" = "pc"): string[] {
  return events.map((event) => (event.type === "keys" ? chordWords(event.chord, style) : event.type));
}

test("typing whose field BB Box cannot tell, a person's or a single key's, is kept secret: no Typing pill and no zoom (073)", () => {
  const inputs = new RecordingInputs(() => 1_003_000);
  inputs.begin("box", 0, "linux");
  for (const keysym of [0x31, 0x32, 0x33, 0x34]) {
    inputs.person("box", { type: "key", keysym, down: true });
    inputs.person("box", { type: "key", keysym, down: false });
  }
  inputs.acted("box", { type: "keys", key: "5", modifiers: [] });
  const events = inputs.end("box")!;
  assert.deepEqual(
    events.map((event) => event.type === "typing" && event.secret),
    [true, true, true, true, true],
  );
  const plan = planScene(facts({ samples: [{ at: 1000, x: 900, y: 500, buttons: 0 }], inputs: events }), SCREEN, 1000, 10, { zoom: true, frame: false });
  assert.deepEqual(plan.pills, [], "no Typing pill for a PIN typed by a person");
  assert.equal(plan.zooms, false, "and no zoom on the pointer while it goes in");
});

test("a key that makes a character, with AltGr, a Mac's Option or Windows' Ctrl+Alt, is typing and its character is never logged; a shortcut needs a command modifier (073)", () => {
  const altGr = personKeys("linux", [
    [XK_ISO_LEVEL3_SHIFT, true],
    [UNICODE_EURO, true],
    [UNICODE_EURO, false],
    [0x40, true],
    [0x40, false],
    [XK_ISO_LEVEL3_SHIFT, false],
  ]);
  assert.deepEqual(pressed(altGr), ["typing", "typing"], "AltGr types € and @");
  const noVncOption = personKeys("linux", [
    [XK_MODE_SWITCH, true],
    [0x40, true],
  ]);
  assert.deepEqual(pressed(noVncOption), ["typing"], "a Mac's Option, as noVNC sends it");
  const windowsAltGr = personKeys("windows", [
    [XK_CONTROL_L, true],
    [XK_ALT_R, true],
    [0x40, true],
  ]);
  assert.deepEqual(pressed(windowsAltGr), ["typing"], "Windows' AltGr is Ctrl and Alt");
  const pastAscii = personKeys("linux", [
    [XK_CONTROL_L, true],
    [0xe9, true],
  ]);
  assert.deepEqual(pressed(pastAscii), ["typing"], "a character past ASCII is never a shortcut's key");
  const shortcuts = personKeys("linux", [
    [XK_CONTROL_L, true],
    [XK_SHIFT_L, true],
    [0x54, true],
    [XK_SHIFT_L, false],
    [XK_CONTROL_L, false],
    [XK_ALT_L, true],
    [XK_F4, true],
    [0x66, true],
  ]);
  assert.deepEqual(pressed(shortcuts), ["Ctrl+Shift+T", "Alt+F4", "Alt+F"]);
  const screenSharing = personKeys("macos", [
    [XK_ALT_L, true],
    [0xe5, true],
    [XK_ALT_L, false],
    [XK_META_L, true],
    [0x63, true],
  ]);
  assert.deepEqual(pressed(screenSharing, "mac"), ["typing", "⌘C"], "Alt is Option and Meta Command");
  const tart = personKeys(
    "macos",
    [
      [XK_META_L, true],
      [0x61, true],
      [XK_META_L, false],
      [XK_ALT_L, true],
      [0x63, true],
    ],
    "alt-command",
  );
  assert.deepEqual(pressed(tart, "mac"), ["typing", "⌘C"], "where the server takes Meta as Option and Alt as Command");
  const agent = new RecordingInputs(() => 5_000);
  agent.begin("pc", 0, "windows");
  const chords: [string, string[]][] = [
    ["e", ["ctrl", "alt"]],
    ["e", ["ctrl", "altgr"]],
    ["é", ["ctrl"]],
    ["s", ["ctrl"]],
    ["F4", ["alt"]],
  ];
  for (const [key, modifiers] of chords) agent.acted("pc", { type: "keys", key, modifiers });
  const agents = agent.end("pc")!;
  assert.deepEqual(pressed(agents), ["typing", "typing", "typing", "Ctrl+S", "Alt+F4"]);
  const linuxCtrlAlt = personKeys("linux", [
    [XK_CONTROL_L, true],
    [XK_ALT_L, true],
    [0x74, true],
  ]);
  assert.deepEqual(pressed(linuxCtrlAlt), ["Ctrl+Alt+T"], "on Linux, AltGr is a key of its own, so Ctrl and Alt make a shortcut");
  const linuxAgent = new RecordingInputs(() => 5_000);
  linuxAgent.begin("x11", 0, "linux");
  linuxAgent.acted("x11", { type: "keys", key: "t", modifiers: ["ctrl", "alt"] });
  assert.deepEqual(pressed(linuxAgent.end("x11")!), ["Ctrl+Alt+T"]);
  assert.doesNotMatch(JSON.stringify([altGr, noVncOption, windowsAltGr, pastAscii, screenSharing, tart, agents]), /€|@|é|É|å|Å/, "no typed character is kept");
});

test("an outside change ends a zoom as it happens, with clicks still to come, and the clicks after it are framed afresh (073)", () => {
  const clicks = [2, 4, 6, 8, 10].map((at) => ({ at, x: 400, y: 300, button: "left" as const, count: 1 as const, area: null }));
  const changes = [{ at: 3, x: 1000, y: 200, width: 800, height: 700 }];
  const keys = camera({ clicks, changes });
  const zoomed = cameraAt(keys, 2.5).zoom;
  assert.ok(zoomed > 1, "in on the first click");
  assert.equal(cameraAt(keys, 3).zoom, zoomed, "until the dialog opens");
  assert.ok(cameraAt(keys, 3.4).zoom < zoomed, "out as it opens");
  assert.equal(cameraAt(keys, 3.9).zoom, 1);
  assert.equal(cameraAt(keys, 5).zoom, 1, "out while the dialog is seen");
  assert.ok(cameraAt(keys, 8).zoom > 1, "the clicks after it zoom again");
  const between = camera({ clicks: [clicks[0]!, { ...clicks[0]!, at: 4.9 }], changes: [{ ...changes[0]!, at: 4.2 }] });
  assert.equal(cameraAt(between, 4.2 + 0.9).zoom, 1, "a change after a click's linger and before the next click ends the zoom too, rather than a pan through it");
  const quick = camera({
    clicks: [
      { at: 3, x: 300, y: 300, button: "left", count: 1, area: null },
      { at: 3.5, x: 1700, y: 900, button: "left", count: 1, area: null },
    ],
    changes: [{ at: 3.55, x: 0, y: 0, width: 900, height: 450 }],
  });
  assert.deepEqual(
    quick.map((key) => key.at),
    [...quick.map((key) => key.at)].sort((a, b) => a - b),
    "a zoom ended by a change just after its click still leaves after it arrives",
  );
  const late = camera({ clicks: clicks.slice(0, 2), changes });
  for (let t = 3.9; t < 8; t += 0.1) assert.equal(cameraAt(late, t).zoom, 1, `a click the view could reach only after it lands is not framed, at ${t.toFixed(1)} s`);
});

function pixelAt(png: Buffer, x: number, y: number): readonly number[] {
  const { width, rgba } = pngPixels(png);
  const at = (Math.round(y) * width + Math.round(x)) * 4;
  return [...rgba.subarray(at, at + 4)];
}

const POINTER_HEIGHT = 36;
const CURSOR = cursorCanvas(SCREEN.width, 1280);

function viewPixel(png: Buffer, width: number, x: number, y: number): readonly number[] {
  return pixelAt(png, (x / 32) * width, (y / 32) * width);
}

function inkNearHotspot(png: Buffer, width: number, hotX: number, hotY: number): boolean {
  const { rgba } = pngPixels(png);
  const hx = hotX * 2;
  const hy = hotY * 2;
  for (let y = hy - 8; y <= hy + 8; y++) {
    for (let x = hx - 8; x <= hx + 8; x++) {
      if (x < 0 || y < 0 || x >= width || y >= width) continue;
      if (rgba[(y * width + x) * 4 + 3]! > 200 && Math.hypot(x - hx, y - hy) <= 8) return true;
    }
  }
  return false;
}

test("the pointer is the owner's arrow, hand, I-beam and grab, each dark on a light screen and light on a dark one, with the hotspot on the shape (073)", () => {
  for (const variant of ["dark", "light"] as const) {
    const arrow = cursorArt("arrow", variant, CURSOR);
    assert.equal(arrow.hotX, Math.round((8.4 / 32) * (arrow.width / 2)));
    assert.equal(arrow.hotY, Math.round((8.4 / 32) * (arrow.width / 2)));
    assert.ok(inkNearHotspot(arrow.png, arrow.width, arrow.hotX, arrow.hotY), `${variant}: the arrow's ink meets the tip`);
    assert.equal(pixelAt(arrow.png, Math.max(0, arrow.hotX * 2 - 8), Math.max(0, arrow.hotY * 2 - 8))[3], 0, `${variant}: nothing is drawn beyond the tip`);
    const body = viewPixel(arrow.png, arrow.width, 14, 14);
    assert.ok(body[3]! > 200 && (variant === "dark" ? body[0]! < 40 : body[0]! > 200), `${variant}: the arrow's fill follows the screen, ${body.join(",")}`);
    const { rgba, width, height } = pngPixels(arrow.png);
    let solid = height;
    for (let y = height - 1; y >= 0; y--) {
      for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3]! > 200) {
        solid = y;
        y = -1;
        break;
      }
    }
    let shadow = false;
    for (let y = solid + 3; y < height; y++) for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3]! > 0) shadow = true;
    assert.ok(shadow, `${variant}: the shadow falls below the shape`);
  }
  for (const shape of ["hand", "ibeam", "grab"] as const) {
    const art = cursorArt(shape, "dark", CURSOR);
    assert.ok(inkNearHotspot(art.png, art.width, art.hotX, art.hotY), `${shape}: the hotspot is on the shape`);
  }
  const east = cursorArt("e", "dark", CURSOR);
  const west = cursorArt("w", "dark", CURSOR);
  assert.ok(Math.abs(east.hotX + west.hotX - east.width / 2) <= 1, "mirroring the east cursor makes the west one");
  assert.ok(pixelAt(west.png, west.hotX * 2, west.hotY * 2)[3]! > 200, "the west tip is drawn");
  const across = cursorArt("ew", "dark", CURSOR);
  const down = cursorArt("ns", "dark", CURSOR);
  const { rgba, width } = pngPixels(across.png);
  let tipX = 0;
  let tipY = 0;
  for (let y = 0; y < across.height; y++) {
    for (let x = 0; x < width; x++) if (rgba[(y * width + x) * 4 + 3]! > 200 && x >= tipX) {
      tipX = x;
      tipY = y;
    }
  }
  const centre = across.width / 2;
  const turned = pixelAt(down.png, centre + (tipY - centre), centre - (tipX - centre));
  assert.ok(turned[3]! > 100, "turning the left-right cursor a quarter turn makes the up-down one");
});

test("the pointer is a hand on a button, an I-beam on a text field, a grab while dragging, and a resize cursor on a window's edge (073)", () => {
  const button = { at: 2, x: 400, y: 300, button: "left" as const, count: 1 as const, area: null, role: "push button" };
  const field = { at: 4, x: 700, y: 500, button: "left" as const, count: 1 as const, area: null, role: "textbox" };
  const unknown = { at: 6, x: 200, y: 200, button: "left" as const, count: 1 as const, area: null, role: "document" };
  const shapes = pointerShapes(scene({ clicks: [button, field, unknown] }));
  assert.equal(shapeAt(shapes, 2.1), "hand");
  assert.equal(shapeAt(shapes, 4.1), "ibeam");
  assert.equal(shapeAt(pointerShapes(scene({ clicks: [{ at: 8, x: 10, y: 10, button: "left", count: 1, area: null, role: "text" }] })), 8.1), "ibeam", "a text area's role is text");
  assert.equal(shapeAt(shapes, 6.1), "arrow", "an unknown role keeps the arrow");
  const quick = pointerShapes(scene({ clicks: [button, { ...field, at: 2.1 }] }));
  assert.equal(shapeAt(quick, 2.2), "hand", "a shape holds for at least 0.3 s");
  assert.equal(shapeAt(quick, 2.1 + SHAPE_HOLD_S + 0.05), "ibeam");
  const drag = (x: number, y: number) => [
    { at: 1, x, y, buttons: 0 },
    { at: 1.2, x, y, buttons: 1 },
    { at: 1.5, x: x + 40, y: y + 30, buttons: 1 },
    { at: 1.8, x: x + 80, y: y + 40, buttons: 0 },
  ];
  const window = { x: 500, y: 200, width: 700, height: 400 };
  const grabbed = pointerShapes(scene({ samples: drag(300, 300), clicks: [{ at: 1.2, x: 300, y: 300, button: "left", count: 1, area: null, role: "button" }] }));
  assert.equal(shapeAt(grabbed, 1.4), "grab", "a drag keeps the open hand when the edge cannot be told");
  const edge = pointerShapes(scene({ samples: drag(1196, 400), clicks: [{ at: 1, x: 800, y: 400, button: "left", count: 1, area: null, role: "frame", window }] }));
  assert.equal(shapeAt(edge, 1.4), "ew");
  const corner = pointerShapes(scene({ samples: drag(1196, 204), clicks: [{ at: 1, x: 800, y: 400, button: "left", count: 1, area: null, window }] }));
  assert.equal(shapeAt(corner, 1.4), "ne");
  const flush = pointerShapes(scene({ samples: drag(4, 400), clicks: [{ at: 1, x: 200, y: 400, button: "left", count: 1, area: null, window: { x: 0, y: 100, width: 640, height: 480 } }] }));
  assert.equal(shapeAt(flush, 1.4), "e");
  const split = pointerShapes(scene({ samples: drag(960, 400), clicks: [{ at: 1, x: 960, y: 400, button: "left", count: 1, area: { x: 956, y: 200, width: 8, height: 400 }, role: "separator", window }] }));
  assert.equal(shapeAt(split, 1.4), "col");
});

function grid(at: number, brightness: (column: number, row: number) => number): BrightnessGrid {
  return { at, cells: Array.from({ length: GRID_COLUMNS * GRID_ROWS }, (_, index) => brightness(index % GRID_COLUMNS, Math.floor(index / GRID_COLUMNS))) };
}

test("the pointer is dark over a light part of the screen and light over a dark one, by the brightness under it, and does not flicker between them (073)", () => {
  const halves = [0, 1, 2, 3, 4].map((at) => grid(at, (column) => (column < GRID_COLUMNS / 2 ? 30 : 230)));
  const frames = Array.from({ length: 120 }, (_, index) => ({ x: index < 60 ? 300 : 1500, y: 400 }));
  assert.deepEqual(pointerVariants(frames, halves, SCREEN, POINTER_HEIGHT, 40), [
    { from: 0, to: 60, variant: "light" },
    { from: 60, to: 120, variant: "dark" },
  ]);
  const flicker = Array.from({ length: 90 }, (_, index) => ({ x: index >= 30 && index < 36 ? 1500 : 300, y: 400 }));
  assert.deepEqual(pointerVariants(flicker, halves, SCREEN, POINTER_HEIGHT, 40), [{ from: 0, to: 90, variant: "light" }], "a fifth of a second over the light half does not switch it");
  const grey = [0, 1, 2, 3].map((at) => grid(at, (column) => (column < GRID_COLUMNS / 2 ? 30 : 128)));
  assert.deepEqual(pointerVariants(frames.slice(0, 90), grey, SCREEN, POINTER_HEIGHT, 40).map((span) => span.variant), ["light"], "mid grey keeps the pointer it has");
  assert.deepEqual(pointerVariants(frames.slice(0, 10), [], SCREEN, POINTER_HEIGHT, 200).map((span) => span.variant), ["dark"], "with no grid, by the screen's brightness");
  const plan = planScene(
    facts({ brightness: halves, samples: [{ at: 1000, x: 300, y: 400, buttons: 0 }, { at: 1002, x: 1500, y: 400, buttons: 0 }], inputs: [click(2.5, 1500, 400), click(0.5, 300, 400)] }),
    SCREEN,
    1000,
    5,
    { zoom: false, frame: false },
  );
  assert.deepEqual(plan.art.filter((art) => art.name.startsWith("cursor-")).map((art) => art.name), ["cursor-arrow-dark.png", "cursor-arrow-light.png"]);
  assert.deepEqual(plan.ringStyles, [{ kind: "left", variant: "light" }, { kind: "left", variant: "dark" }], "each click's ring matches the pointer where it lands");
  const commands = sceneCommands(plan);
  assert.match(commands, /overlay@arrowl enable 1;[\s\S]*overlay@arrowl enable 0;[\s\S]*overlay@arrowd enable 1;/, "one pointer shows at a time");
  assert.match(commands, /overlay@ringld0 x/);
});

test("a click's ring is drawn as the pointer is: a band of the pointer's fill between edges of its other ink, blue for a right click (073)", () => {
  const ringPixel = (kind: "left" | "right", variant: "dark" | "light") => {
    const art = ringArt(POINTER_HEIGHT, 2, kind, variant);
    const radius = POINTER_HEIGHT * (0.3 + 0.55 * (1 - (1 - 3 / 6) ** 2));
    return pixelAt(art.png, art.width / 2 + radius, art.height / 2);
  };
  assert.ok(ringPixel("left", "dark")[0]! < 60, "a dark ring by a dark pointer");
  assert.ok(ringPixel("left", "light")[0]! > 200, "a light ring by a light pointer");
  const right = ringPixel("right", "dark");
  assert.ok(right[2]! > 200 && right[0]! < 120, "a right click's ring is blue");
});

test("the stop reads the brightness grid, a line a second of each cell's brightness, and keeps none that is cut short (073)", () => {
  const cells = (value: number) => Buffer.alloc(GRID_COLUMNS * GRID_ROWS, value).toString("hex");
  const stdout = `{"ended":"stopped","recorded":3,"size":"1920x1080","start":1000.000,"position":"top","cuts":[],"pointer":"drawn","lag":0,"luma":50,"keys":"pc"}\nG 0 ${cells(30)}\nG 1 ${cells(230)}\nG 2 ${cells(10).slice(0, 20)}\n`;
  const brightness = parsePrepared(stdout)!.scene!.brightness!;
  assert.deepEqual(brightness.map((each) => [each.at, each.cells.length, each.cells[0]]), [
    [0, GRID_COLUMNS * GRID_ROWS, 30],
    [1, GRID_COLUMNS * GRID_ROWS, 230],
  ]);
});

test("where the driver's agent cursor was hidden for the whole recording, the clip draws the agent's pointer as on Linux, gliding to its clicks (073)", () => {
  assert.deepEqual((["linux", "macos", "windows"] as const).map(driverDrawsAgentCursor), [false, true, true]);
  const prepared: Prepared = { ended: "stopped", recorded: 10, width: 1920, height: 1080, start: 1000, cuts: [], events: [], scene: facts({ agentCursor: true, samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }], inputs: [click(4, 900, 600)] }) };
  assert.equal(withAgentCursorHidden(prepared, false).scene?.agentCursor, true, "the driver's cursor stayed, so BB Box draws only the real pointer");
  const hidden = withAgentCursorHidden(prepared, true);
  assert.equal(hidden.scene?.agentCursor, false);
  assert.ok(planClip(hidden, 1).scene!.pointer.glides.length > 0, "the pointer glides to the agent's click");
  assert.equal(planClip(prepared, 1).scene!.pointer.glides.length, 0);
});

test("a change that touches the window just acted in, within half a second, is the action's own result and keeps the zoom; one elsewhere, or later, still ends it (073)", () => {
  const field = { x: 640, y: 345, width: 640, height: 450 };
  const window = { x: 640, y: 320, width: 640, height: 480 };
  const clicks = [{ at: 2, x: 900, y: 500, button: "left" as const, count: 1 as const, area: null, window }];
  const typing = [
    { at: 3.5, characters: 50, area: field, secret: false, window },
    { at: 3.6, characters: 0, area: null, secret: false, window },
  ];
  const typedWithTitle = { at: 3.3, x: 148, y: 4, width: 948, height: 392 };
  assert.ok(cameraAt(camera({ clicks, typing, changes: [typedWithTitle] }), 4).zoom > 1.5, "the typed line, merged with the panel's title, keeps the zoom");
  const titleOnly = { at: 3.3, x: 148, y: 4, width: 948, height: 330 };
  const titleView = cameraAt(camera({ clicks, typing, changes: [titleOnly] }), 4);
  assert.ok(titleView.zoom > 1 && viewCovers(SCREEN, titleView, field), "as does a change only in the window's title, not the field");
  assert.ok(cameraAt(camera({ clicks, changes: [{ ...titleOnly, at: 2.3 }] }), 2.9).zoom > 1.5, "and in the window of a click, away from where it landed");
  const elsewhere = { at: 3.3, x: 1300, y: 0, width: 620, height: 600 };
  const tight = [{ ...typing[0]!, area: { x: 860, y: 470, width: 80, height: 28 } }, typing[1]!];
  assert.equal(cameraAt(camera({ clicks, typing: tight, changes: [elsewhere] }), 4.4).zoom, 1, "a change beside the window still ends it");
  const later = { at: 4.3, x: 0, y: 0, width: 1920, height: 280 };
  assert.equal(cameraAt(camera({ clicks, typing, changes: [later] }), 5.4).zoom, 1, "and so does one long after the action, outside the view");

  const samples = Array.from({ length: 90 }, (_, index) => {
    const at = 4 + index / 30;
    const dragging = at >= 5 && at <= 6;
    const share = Math.min(1, Math.max(0, at - 5));
    return { at, x: 900 - 200 * share, y: 300 - 70 * share, buttons: dragging ? 1 : 0 };
  });
  const movedWindow = { at: 5.5, x: 580, y: 4, width: 1064, height: 828 };
  const dragged = camera({ samples, changes: [movedWindow] });
  assert.ok(cameraAt(dragged, 5.9).zoom > 1.5, "the dragged window's own move keeps the view on the drag");
  assert.ok(cameraAt(dragged, 6.3).zoom > 1.5, "through its end");
  const wideWindow = { x: 200, y: 100, width: 1400, height: 800 };
  const lowField = { x: 400, y: 720, width: 80, height: 28 };
  const typedLow = [
    { at: 3.5, characters: 20, area: lowField, secret: false, window: wideWindow },
    { at: 3.6, characters: 0, area: null, secret: false, window: wideWindow },
  ];
  const coversWindow = { at: 3.3, x: 200, y: 100, width: 1400, height: 500 };
  assert.ok(cameraAt(camera({ typing: typedLow, changes: [coversWindow] }), 4).zoom > 1.5, "typing that shares its window with a large change keeps the zoom");
  const dialog = { x: 200, y: 100, width: 1400, height: 800 };
  const closed = camera({ clicks: [{ at: 2, x: 900, y: 500, button: "left", count: 1, area: null, window: dialog }], changes: [{ at: 2.2, ...dialog }] });
  assert.equal(cameraAt(closed, 2.2 + MOVE_S + 0.3).zoom, 1, "a click that removes most of its window zooms out");
});

test("keys inside a composition, as GTK's Ctrl+Shift+U and a code point, the Compose key or a dead key, are counted as typing, never as shortcuts, until it is committed or let go (073)", () => {
  const [XK_U, XK_4, XK_1, XK_2, XK_S, XK_E, XK_SPACE, XK_MULTI_KEY, XK_DEAD_ACUTE] = [0x75, 0x34, 0x31, 0x32, 0x73, 0x65, 0x20, 0xff20, 0xfe51];
  const held = personKeys("linux", [
    [XK_CONTROL_L, true],
    [XK_SHIFT_L, true],
    [XK_U, true],
    [XK_U, false],
    [XK_4, true],
    [XK_4, false],
    [XK_1, true],
    [XK_1, false],
    [XK_SHIFT_L, false],
    [XK_CONTROL_L, false],
    [XK_CONTROL_L, true],
    [XK_S, true],
  ]);
  assert.deepEqual(pressed(held), ["typing", "typing", "typing", "Ctrl+S"], "Ctrl+Shift+U, 4 and 1 type A; once Ctrl and Shift are let go, a shortcut is one again");
  const committed = personKeys("linux", [
    [XK_CONTROL_L, true],
    [XK_SHIFT_L, true],
    [XK_U, true],
    [XK_SHIFT_L, false],
    [XK_CONTROL_L, false],
    [XK_4, true],
    [XK_1, true],
    [XK_SPACE, true],
    [XK_CONTROL_L, true],
    [XK_S, true],
  ]);
  assert.deepEqual(pressed(committed), ["typing", "typing", "typing", "typing", "Ctrl+S"], "or once Space commits it");
  const composed = personKeys("linux", [
    [XK_MULTI_KEY, true],
    [XK_CONTROL_L, true],
    [XK_4, true],
    [XK_1, true],
    [XK_2, true],
    [XK_S, true],
  ]);
  assert.deepEqual(pressed(composed), ["typing", "typing", "typing", "typing", "Ctrl+S"], "the Compose key's next keys");
  const dead = personKeys("linux", [
    [XK_DEAD_ACUTE, true],
    [XK_CONTROL_L, true],
    [XK_E, true],
    [XK_S, true],
  ]);
  assert.deepEqual(pressed(dead), ["typing", "typing", "Ctrl+S"], "a dead key's next key");
  const reset = new RecordingInputs(() => 5_000);
  reset.begin("box", 0, "linux");
  for (const [keysym, down] of [[XK_CONTROL_L, true], [XK_SHIFT_L, true], [XK_U, true]] as const) reset.person("box", { type: "key", keysym, down });
  reset.person("box", { type: "released" });
  for (const [keysym, down] of [[XK_CONTROL_L, true], [XK_S, true]] as const) reset.person("box", { type: "key", keysym, down });
  assert.deepEqual(pressed(reset.end("box")!), ["typing", "Ctrl+S"], "letting go of the held keys ends it too");
  const agent = new RecordingInputs(() => 5_000);
  agent.begin("box", 0, "linux");
  for (const [key, modifiers] of [["u", ["ctrl", "shift"]], ["4", ["ctrl", "shift"]], ["1", ["ctrl", "shift"]], ["Return", []], ["s", ["ctrl"]]] as const) agent.acted("box", { type: "keys", key, modifiers });
  assert.deepEqual(pressed(agent.end("box")!), ["typing", "typing", "typing", "typing", "Ctrl+S"], "the agent's keys too");
  const windows = new RecordingInputs(() => 5_000);
  windows.begin("pc", 0, "windows");
  windows.acted("pc", { type: "keys", key: "u", modifiers: ["ctrl", "shift"] });
  assert.deepEqual(pressed(windows.end("pc")!), ["Ctrl+Shift+U"], "Windows has no Ctrl+Shift+U entry");
});
