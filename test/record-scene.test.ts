
import assert from "node:assert/strict";
import { test } from "node:test";
import { RecordingInputs, isSecretTyping, keysymKey, looksLikeSecret, normalChord, type InputEvent } from "../src/core/record-input.ts";
import { chordWords, planKeyPills, TYPING_WORDS } from "../src/core/record-keys.ts";
import {
  CLIP_FPS,
  GLIDE_S,
  RING_S,
  ZOOM_LEAST,
  ZOOM_MOST,
  ZOOM_POINT,
  cameraAt,
  glideEase,
  keptMotion,
  planCamera,
  planPointer,
  pointerShapes,
  ringStageShown,
  shapeAt,
  SHAPE_HOLD_S,
  MOVE_S,
  typingFocus,
  typingSpan,
  viewCovers,
  type Scene,
} from "../src/core/record-motion.ts";
import { GRID_COLUMNS, GRID_ROWS, areaOnClip, planScene, pointerVariants, sceneCommands, sceneHead, zoomFilter, type BrightnessGrid, type SceneFacts } from "../src/core/record-scene.ts";
import { ringArt } from "../src/core/record-art.ts";
import { cursorArt, cursorCanvas } from "../src/core/record-cursors.ts";
import { pngPixels } from "../src/core/png.ts";
import { clipGraph, driverDrawsAgentCursor, parsePrepared, planClip, withAgentCursorHidden, type Prepared } from "../src/core/record.ts";
import { personInput } from "../src/core/selkies.ts";

const SCREEN = { width: 1920, height: 1080 };
const round = (value: number) => Math.round(value * 1000) / 1000;

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
    gt: (a, b) => (a! > b! ? 1 : 0),
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

test("a camera move that a result's hold would freeze halfway ends by that result, so the held frame is a settled framing (081)", () => {
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 12,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events: [
      { at: 1004.3, kind: "pass", text: "The button is down" },
      { at: 1004.4, kind: "step", text: "Look at the next one" },
    ],
    scene: facts({ samples: [{ at: 1000, x: 200, y: 200, buttons: 0 }], inputs: [click(5, 600, 400)] }),
  };
  const plan = planClip(prepared, 1, { zoom: true, frame: true, stills: "keep" });
  const top = Math.max(...plan.scene!.camera.map((key) => key.view.zoom));
  assert.ok(top > 1.5);
  assert.equal(cameraAt(plan.scene!.camera, 4.3).zoom, top, `in by the result at 4.3 s, not still easing in as it is held: ${JSON.stringify(plan.scene!.camera)}`);
  const without = planClip({ ...prepared, events: [] }, 1, { zoom: true, frame: true, stills: "keep" });
  assert.ok(cameraAt(without.scene!.camera, 4.3).zoom < top, "with no result to hold, the camera takes its usual 0.9 s");
});

test("the camera pans instead of easing out and back in when the next view overlaps this one within the group gap, counting only time that is not cut (081)", () => {
  const window = { x: 600, y: 300, width: 500, height: 300 };
  const at = (t: number, x: number) => ({ at: t, x, y: 450, button: "left" as const, count: 1 as const, area: { x: x - 40, y: 430, width: 80, height: 40 }, role: "push button", window });
  const near = camera({ clicks: [at(2, 700), at(7.4, 1000)], length: 14 });
  for (let t = 3.6; t < 7.4; t += 0.1) assert.ok(cameraAt(near, t).zoom > 1.3, `stays in over the same window at ${t.toFixed(1)} s: ${JSON.stringify(near)}`);
  assert.ok(cameraAt(near, 7.4).x > cameraAt(near, 3).x, "and pans to the second click");
  const far = camera({ clicks: [at(2, 300), { ...at(7.4, 1700), x: 1700, y: 950, area: { x: 1660, y: 930, width: 80, height: 40 } }], length: 14 });
  assert.equal(cameraAt(far, 5.5).zoom, 1, "views that do not overlap still zoom out between");
  const later = camera({ clicks: [at(2, 700), at(14, 1000)], length: 20 });
  assert.equal(cameraAt(later, 8).zoom, 1, "a long gap of real work zooms out");
  const planned = scene({ clicks: [at(2, 700), at(14, 1000)], length: 20 });
  const idle = planCamera(planned, planPointer(planned), [{ from: 4, to: 12 }]);
  assert.ok(cameraAt(idle, 8).zoom > 1.3, "the same gap, mostly idle and cut, pans instead");
  const blank = camera({
    clicks: [at(2, 700), at(7.4, 1000)],
    changes: [{ at: 7, ...window }],
    brightness: [7, 8, 9, 10, 11].map((t) => ({ at: t, cells: new Array(144).fill(250) })),
    length: 14,
  });
  assert.equal(cameraAt(blank, 10).zoom, 1, `when the next view is left out, as a window that never paints, the camera still zooms out: ${JSON.stringify(blank)}`);
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

function idleRecording(parts: Partial<SceneFacts> = {}, events: Prepared["events"] = []): Prepared {
  const caret = Array.from({ length: 26 }, (_, index) => ({ at: 6 + index * 0.5, x: 700, y: 400, width: 3, height: 20 }));
  const grids = Array.from({ length: 31 }, (_, at) => grid(at, () => 40));
  return {
    ended: "stopped",
    recorded: 30,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events,
    scene: facts({ samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }], changes: caret, brightness: grids, inputs: [click(5, 600, 400), click(21, 900, 500)], ...parts }),
  };
}

test("a dressed recording cuts its idle stretches by default, though a caret blinks, keeps a moving pointer, and keeps them all with stills keep (081)", () => {
  const plan = planClip(idleRecording(), 1);
  const cut = (from: number, to: number) => plan.cuts.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, to) - Math.max(a, from)), 0);
  assert.ok(cut(6, 20) > 12, `the 14 s with only a blinking caret is cut: ${JSON.stringify(plan.cuts)}`);
  assert.ok(cut(5, 5.5) === 0, "the first half second after the click stays");
  assert.ok(cut(20.5, 21.4) === 0, "the glide to the next click stays");
  assert.deepEqual(planClip(idleRecording(), 1, { zoom: true, frame: true, stills: "keep" }).cuts, [], "keep keeps every stretch");

  const moving = Array.from({ length: 60 }, (_, index) => ({ at: 1023 + index / 30, x: 300 + index * 4, y: 300, buttons: 0 }));
  const hovered = planClip({ ...idleRecording({ samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }, ...moving] }), cuts: [[22.5, 26]] }, 1);
  const hoverCut = hovered.cuts.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, 25) - Math.max(a, 23)), 0);
  assert.equal(hoverCut, 0, "a pointer moving over a still screen is not idle");
});

test("a dressed recording ends a second after the screen's last answer, though no result caption says it (081)", () => {
  const plan = planClip(idleRecording({ changes: [{ at: 8, x: 600, y: 300, width: 500, height: 300 }], inputs: [click(5, 600, 400)] }), 1);
  const tail = plan.cuts.at(-1)!;
  assert.ok(tail[0] >= 9.4 && tail[1] === 30, `the clip runs on to the answer at 8 s and a second and a half after it: ${JSON.stringify(plan.cuts)}`);
  assert.ok(plan.cuts.every(([from, to]) => to <= 8 || from > 8), "the answer itself is never cut");
});

test("a dressed recording starts on its first action and ends a second after its last result, then fades out to the frame (081)", () => {
  const events: Prepared["events"] = [
    { at: 1004, kind: "step", text: "Press the button" },
    { at: 1005.5, kind: "pass", text: "It was pressed" },
  ];
  const recording = (recorded: number): Prepared => ({ ...idleRecording({ changes: [], inputs: [click(5, 600, 400)] }, events), recorded });
  const plan = planClip(recording(30), 1);
  assert.ok(plan.cuts[0]![0] === 0 && plan.cuts[0]![1] >= 3.7, `the 4 s before the first step are gone: ${JSON.stringify(plan.cuts)}`);
  const step = plan.captions.find((caption) => caption.kind === "step")!;
  assert.ok(step.from <= 0.25, `the clip opens on the step: ${step.from}`);
  const result = plan.captions.find((caption) => caption.kind === "pass")!;
  assert.ok(Math.abs(plan.length - result.from - 1.5) < 0.05, `a second held after the result, then half a second's fade: ${plan.length - result.from}`);
  assert.deepEqual(plan.overlays.filter((overlay) => overlay.look === "mark"), [], "trimming the ends shows no skip mark");
  const timing = /setpts='\((.*)\)\/TB'/.exec(clipGraph(plan, true))![1]!;
  const shownAt = (captured: number) => evaluate(timing.replace(/\bT\b/g, `(${captured})`), 0);
  assert.ok(Math.abs(shownAt(5.5) - result.from) < 0.001, `the frame captured with the result is shown with it, though the clip's first frames are cut: ${shownAt(5.5)} against ${result.from}`);
  assert.ok(clipGraph(plan, true).endsWith(`[end]fade=t=out:st=${round(plan.length - 0.5)}:d=0.5:color=0x161618[out]`), clipGraph(plan, true).slice(-200));
  const stopped = planClip(recording(5.6), 1);
  const last = stopped.captions.find((caption) => caption.kind === "pass")!;
  assert.ok(Math.abs(stopped.length - last.from - 1.5) < 0.05, "a recording stopped just after its result still holds it for a second");
  const kept = planClip(recording(30), 1, { zoom: true, frame: true, stills: "keep" });
  assert.deepEqual(kept.cuts, [], "stills keep keeps the ends");
  assert.ok(clipGraph(kept, true).endsWith(`[end]fade=t=out:st=${round(kept.length - 0.5)}:d=0.5:color=0x161618[out]`), "and still fades out");
});

test("a caption is placed on the capture's own timeline, the box's first-frame lag after the start, so a result's held frame comes before the agent's next action (081)", () => {
  const prepared = idleRecording({ lag: 0.2, changes: [], inputs: [] }, [
    { at: 1004, kind: "step", text: "Look at the note" },
    { at: 1005, kind: "pass", text: "The note is open" },
    { at: 1005.1, kind: "step", text: "Close the note" },
  ]);
  const plan = planClip(prepared, 1, { zoom: true, frame: true, stills: "keep" });
  assert.equal(plan.captions[0]!.from, 3.8, "the step, 4 s after the start, is 3.8 s into a capture whose first frame came 0.2 s after it");
  assert.equal(plan.holds.find((hold) => hold.at > 4)?.at, 4.8, "the result is held on the frame captured as it was given");
  assert.equal(plan.captions[0]!.real, 4, "the page still lists the step at its real time");
});

test("a result is held at most about a second, though its words would take longer to read (081)", () => {
  const plan = planClip(idleRecording({}, [
    { at: 1005.2, kind: "pass", text: "The note was saved and the window closed without a prompt" },
    { at: 1005.4, kind: "step", text: "Find the file" },
  ]), 1);
  const result = plan.captions.find((caption) => caption.kind === "pass")!;
  const held = plan.holds.find((hold) => Math.abs(hold.at - result.from) < 0.01);
  assert.ok(held, `the result is held: ${JSON.stringify(plan.holds)}`);
  assert.ok(held.seconds <= 1 + 0.001, `held ${held.seconds} s`);
});

test("the pointer's commands move it each frame it moves, show it from when it is known, and switch each ring stage on and off in turn (073)", () => {
  const plan = planScene(facts({ samples: [{ at: 1000, x: 100, y: 100, buttons: 0 }], inputs: [click(3, 500, 400)] }), SCREEN, 1000, 5, { zoom: true, frame: true });
  const commands = sceneCommands(plan).trim().split("\n");
  assert.match(commands[0]!, /^0\.000 overlay@arrowl x \d+, overlay@arrowl y \d+;$/, "a dark screen, so the light arrow");
  assert.ok(commands.includes("0.000 overlay@arrowl enable 1;"));
  const ring = commands.filter((line) => line.includes("overlay@ringll0"));
  assert.match(ring[0]!, /^3\.000 overlay@ringll0 x \d+, overlay@ringll0 y \d+;$/);
  assert.equal(ring.length, 1, "a stage is placed once; it cannot be left enabled");
  const head = sceneHead(plan, 1).graph;
  assert.match(head, /overlay@ringll0=x=0:y=0:enable='between\(t,3\.000,3\.067\)':format=auto/);
  assert.match(head, /format=rgba,scale=iw\/2:ih\/2:flags=lanczos/, "the cursor is scaled with its alpha, so the overlay does not leave a box");
  assert.match(head, /between\(t,3\.333,3\.400\)/);
  assert.equal(RING_S, 0.4);
  assert.doesNotMatch(head, /between\(t,3\.\d+,3\.[5-9]/, "every stage of the ring is gone by 0.4 s");
  const times = commands.map((line) => Number(line.split(" ")[0]));
  assert.deepEqual(times, [...times].sort((a, b) => a - b), "in time order");
  assert.ok(plan.frame && plan.art.some((art) => art.name === "corner.png"));
});

test("a click whose window goes on the click rings on the frames before it goes, or its ring ends there (081)", () => {
  const dialog = { x: 600, y: 300, width: 500, height: 400 };
  const cancel: InputEvent = { at: 1005, by: "agent", type: "click", space: "screen", button: "left", count: 1, x: 1000, y: 660, area: { x: 950, y: 640, width: 100, height: 40 }, role: "push button", window: dialog };
  const planned = (keyAt: number, goneAt = 4.95, resizedAt: number | null = null) =>
    planScene(
      facts({
        samples: [{ at: 1000, x: 200, y: 200, buttons: 0 }],
        changes: [{ at: 3.2, ...dialog }, ...(resizedAt === null ? [] : [{ at: resizedAt, ...dialog }]), { at: goneAt, x: 590, y: 290, width: 520, height: 420 }],
        inputs: [{ at: 1000 + keyAt, by: "agent", type: "keys", chord: normalChord("s", ["ctrl"]) }, cancel],
      }),
      SCREEN,
      1000,
      10,
      { zoom: true, frame: true },
    );
  const early = planned(3);
  const ring = early.pointer.rings[0]!;
  assert.ok(ring.at < 5 && ring.at + RING_S <= 4.95 + 0.001, `the ring plays before the dialog goes: ${JSON.stringify(early.pointer.rings)}`);
  assert.equal(ring.at, 4.5, "moved at most half a second");
  const nearer = planned(3, 5.3).pointer.rings[0]!;
  assert.ok(Math.abs(nearer.at + RING_S - (5.3 - 1 / 15)) < 0.002, `the ring ends a frame of the capture before the window goes: ${nearer.at}`);
  assert.ok(Array.from({ length: 6 }, (_, stage) => stage).every((stage) => ringStageShown(ring, stage)), "the whole ring");
  const frame = early.pointer.frames[Math.round(ring.at * CLIP_FPS)]!;
  assert.deepEqual([frame.x, frame.y], [1000, 660], "the pointer has glided to the button as the ring starts");
  assert.equal(shapeAt(early.shapes, ring.at + 0.05), "hand");
  const short = planned(4.6).pointer.rings[0]!;
  assert.equal(short.at, 4.7, "no earlier than just after the action before it");
  const shown = Array.from({ length: 6 }, (_, stage) => stage).filter((stage) => ringStageShown(short, stage));
  assert.ok(shown.length >= 3 && shown.length < 6, "shortened to the stages before the dialog goes");
  for (const stage of shown) assert.ok(short.at + stage / 15 < 4.95);
  assert.doesNotMatch(sceneHead(planned(4.6), 1).graph, /between\(t,4\.967/, "the stage after the dialog has gone is never switched on");
  assert.equal(planned(4.9).pointer.rings.length, 0, "with no time before it goes, there is no ring over nothing");
  const captioned = planScene(
    facts({ samples: [{ at: 1000, x: 200, y: 200, buttons: 0 }], changes: [{ at: 3.2, ...dialog }, { at: 4.95, x: 590, y: 290, width: 520, height: 420 }], inputs: [cancel] }),
    SCREEN,
    1000,
    10,
    { zoom: true, frame: true, captions: [4.8] },
  ).pointer.rings[0]!;
  assert.ok(captioned.at >= 4.9 - 0.001, `never before the step caption that introduces it: ${captioned.at}`);
  const resized = planned(3, 4.95, 4.7).pointer.rings[0]!;
  assert.ok(Math.abs(resized.at - (4.7 + 1 / 15)) < 0.002, `no earlier than a frame after its window last settled: ${resized.at}`);
  const note = { x: 300, y: 200, width: 600, height: 330 };
  const field: InputEvent = { at: 1005, by: "agent", type: "click", space: "screen", button: "left", count: 1, x: 600, y: 360, area: { x: 310, y: 230, width: 580, height: 290 }, role: "text", window: note };
  const typedThere: InputEvent = { at: 1006, by: "agent", type: "typing", characters: 10, space: "screen", area: { x: 310, y: 230, width: 580, height: 290 }, secret: false, role: "text", window: note };
  const opened = planScene(facts({ samples: [{ at: 1000, x: 200, y: 200, buttons: 0 }], changes: [{ at: 5.2, x: 100, y: 0, width: 900, height: 600 }], inputs: [field, typedThere] }), SCREEN, 1000, 10, { zoom: true, frame: true });
  assert.equal(opened.pointer.rings[0]!.at, 5, "a window that appears or is uncovered around the click, and is acted in next, keeps its ring as it was");
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

test("each step's captions go to the top or the bottom, whichever covers less of what changes during it, and the key pills keep clear of them (081)", () => {
  const name = { x: 700, y: 40, width: 500, height: 36 };
  const button = { x: 860, y: 980, width: 80, height: 40 };
  const prepared: Prepared = {
    ended: "stopped",
    recorded: 12,
    width: 1920,
    height: 1080,
    start: 1000,
    position: "top",
    cuts: [],
    events: [
      { at: 1002, kind: "step", text: "Name the file" },
      { at: 1004, kind: "pass", text: "The name is in the field" },
      { at: 1006, kind: "step", text: "Press the button" },
      { at: 1008, kind: "pass", text: "The button was pressed" },
    ],
    scene: facts({
      samples: [{ at: 1000, x: 900, y: 600, buttons: 0 }],
      changes: [{ at: 3.4, ...name }, { at: 7.2, ...button }],
      inputs: [
        { at: 1003, by: "agent", type: "click", space: "screen", button: "left", count: 1, x: 900, y: 58, area: name, role: "text" },
        { at: 1003.3, by: "agent", type: "typing", characters: 12, space: "screen", area: name, secret: false, role: "text" },
        { at: 1003.5, by: "agent", type: "keys", chord: normalChord("Tab", []) },
        { at: 1007, by: "agent", type: "click", space: "screen", button: "left", count: 1, x: 900, y: 1000, area: button, role: "push button" },
      ],
    }),
  };
  const plan = planClip(prepared, 1, { zoom: false, frame: true });
  const caption = (text: string) => plan.overlays.find((overlay) => overlay.text === text)!;
  assert.ok(caption("Name the file").y > plan.height / 2, "the name field is at the top, so its step goes to the bottom");
  assert.ok(caption("The name is in the field").y > caption("Name the file").y, "its result stays under it");
  assert.ok(caption("Press the button").y < plan.height / 2, "the button is at the bottom, so the next step is at the top again");
  const tab = plan.overlays.find((overlay) => overlay.look === "key" && overlay.text === "Tab")!;
  assert.ok(tab.y + plan.fontSize * 2.1 <= caption("Name the file").y, "a key pill in that step sits clear of the captions at the bottom");
  const kept = planClip({ ...prepared, scene: facts({ samples: [{ at: 1000, x: 900, y: 600, buttons: 0 }] }) }, 1, { zoom: false, frame: true });
  assert.ok(kept.overlays.filter((overlay) => overlay.look === "step").every((overlay) => overlay.y < kept.height / 2), "with nothing to avoid, the captions stay where the agent put them");
});

test("a line that lands in one frame, with a result within half a second, shows no Typing pill: the result says it (081)", () => {
  const field = { x: 600, y: 400, width: 600, height: 40 };
  const typed = (at: number, characters: number): InputEvent => ({ at, by: "agent", type: "typing", characters, space: "screen", area: field, secret: false, role: "text", call: 1 });
  const recording = (inputs: InputEvent[], events: Prepared["events"]): Prepared => ({
    ended: "stopped",
    recorded: 10,
    width: 1920,
    height: 1080,
    start: 1000,
    cuts: [],
    events,
    scene: facts({ samples: [{ at: 1000, x: 900, y: 600, buttons: 0 }], inputs }),
  });
  const typingPills = (prepared: Prepared) => planClip(prepared, 1, { zoom: true, frame: true, stills: "keep" }).overlays.filter((overlay) => overlay.text === TYPING_WORDS);
  const step = { at: 1002, kind: "step" as const, text: "Type the line" };
  const passed = { at: 1003.2, kind: "pass" as const, text: "The line is in" };
  assert.equal(typingPills(recording([typed(1003, 40), typed(1003.01, 0)], [step, passed])).length, 0, "pasted at once, then the result");
  assert.equal(typingPills(recording([typed(1003, 40), typed(1003.01, 0)], [step])).length, 1, "with no result to say it, the pill shows");
  assert.equal(typingPills(recording([typed(1003, 40), typed(1003.01, 0)], [step, { ...passed, at: 1004 }])).length, 1, "a result a second later leaves the pill");
  assert.equal(typingPills(recording([typed(1002.2, 1), typed(1002.6, 1), typed(1003, 1), typed(1003.01, 0)], [step, passed])).length, 1, "typing that takes time keeps its pill");
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
  const laterSamples = samples.map((sample) => ({ ...sample, at: sample.at + 1.4 }));
  const later = scene({ samples: laterSamples, clicks: [{ at: 1.2, x: 500, y: 240, button: "left" as const, count: 1 as const, area: null, window }] });
  const laterPointer = planPointer(later);
  const laterView = cameraAt(planCamera(later, laterPointer), 3.6);
  const laterStart = laterPointer.frames[Math.round(2.6 * CLIP_FPS)]!;
  const laterEnd = laterPointer.frames[Math.round(3.4 * CLIP_FPS)]!;
  const laterMoved = { x: window.x + laterEnd.x - laterStart.x, y: window.y + laterEnd.y - laterStart.y, width: window.width, height: window.height };
  assert.ok(viewCovers(SCREEN, laterView, laterMoved), "a click that named the window a moment earlier still frames it where the drag ends");
  const titleSamples = [
    { at: 1, x: 700, y: 175, buttons: 0 },
    { at: 1.3, x: 700, y: 175, buttons: 1 },
    { at: 2, x: 860, y: 250, buttons: 1 },
    { at: 2.2, x: 860, y: 250, buttons: 0 },
  ];
  const byTitle = scene({ samples: titleSamples, clicks: [{ at: 1.2, x: 700, y: 220, button: "left" as const, count: 1 as const, area: null, window }] });
  const titlePointer = planPointer(byTitle);
  const titleView = cameraAt(planCamera(byTitle, titlePointer), 2.2);
  const titleStart = titlePointer.frames[Math.round(1.3 * CLIP_FPS)]!;
  const titleEnd = titlePointer.frames[Math.round(2 * CLIP_FPS)]!;
  const titleMoved = { x: window.x + titleEnd.x - titleStart.x, y: window.y + titleEnd.y - titleStart.y, width: window.width, height: window.height };
  assert.ok(titleView.zoom > 1 && viewCovers(SCREEN, titleView, titleMoved), "a drag by the title, just above the window, still frames it");
});

test("typing into a large text area zooms on where the text appears, or on the pointer, not on the whole area (073)", () => {
  const area = { x: 644, y: 353, width: 640, height: 452 };
  const typing = { at: 3, characters: 50, area, secret: false };
  const line = { at: 3.25, x: 650, y: 380, width: 300, height: 18 };
  const elsewhere = { at: 3.25, x: 1700, y: 10, width: 60, height: 12 };
  const pointer = planPointer(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }] }));
  assert.deepEqual(typingFocus(scene({ typing: [typing], changes: [line, elsewhere] }), typing, pointer), { x: 650, y: 380, width: 300, height: 18 }, "the text as it appears, inside the field");
  assert.deepEqual(typingFocus(scene({ typing: [typing] }), typing, pointer), { x: 644, y: 482, width: 640, height: 36 }, "else a line at the caret, when the field itself would not zoom");
  const unplaced = { ...typing, area: null };
  assert.deepEqual(typingFocus(scene({ typing: [unplaced] }), unplaced, pointer), { x: 900, y: 500, width: 0, height: 0 }, "else where the pointer is");
  const camera = planCamera(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }], typing: [typing], changes: [line] }), pointer);
  assert.ok(cameraAt(camera, 3.4).zoom > 1.5, "the click and the typing after it stay zoomed in");
});

test("a button, typing into a large field, and a dialog each zoom in, and the camera is out between them (073)", () => {
  const button = { x: 80, y: 40, width: 72, height: 28 };
  const field = { x: 40, y: 80, width: 900, height: 860 };
  const dialogButton = { x: 700, y: 520, width: 88, height: 32 };
  const clicks = [
    { at: 2, x: 116, y: 54, button: "left" as const, count: 1 as const, area: button, role: "push button" },
    { at: 8, x: 240, y: 180, button: "left" as const, count: 1 as const, area: field, role: "text" },
    { at: 14, x: 744, y: 536, button: "left" as const, count: 1 as const, area: dialogButton, role: "push button" },
  ];
  const typing = [
    { at: 8.4, characters: 48, area: field, secret: false, role: "text" },
    { at: 9.2, characters: 0, area: null, secret: false },
  ];
  const keys = camera({ clicks, typing, changes: [{ at: 8.6, ...field }], length: 20 });
  assert.ok(cameraAt(keys, 2.2).zoom >= ZOOM_LEAST, "in on the button");
  assert.equal(cameraAt(keys, 5).zoom, 1, "out before the field");
  const typed = cameraAt(keys, 9);
  assert.ok(typed.zoom >= ZOOM_LEAST, "in on the line, not the whole field");
  assert.ok(viewCovers(SCREEN, typed, { x: 220, y: 168, width: 80, height: 16 }), "the caret stays in frame");
  assert.ok(!viewCovers(SCREEN, typed, field), "the whole editor is not the frame");
  assert.equal(cameraAt(keys, 12).zoom, 1, "out before the dialog");
  assert.ok(cameraAt(keys, 14.2).zoom >= ZOOM_LEAST, "in on the dialog's button");
});

test("a zoom waits until a new window has painted, and holds the previous framing while that window is blank (080)", () => {
  const window = { x: 200, y: 120, width: 640, height: 420 };
  const click = { at: 2, x: 400, y: 300, button: "left" as const, count: 1 as const, area: window, role: "push button", window };
  const flat = new Array(144).fill(250);
  const painted = flat.slice();
  for (let x = 2; x < 8; x++) painted[16 + x] = 40;
  painted[3 * 16 + 5] = 30;
  painted[4 * 16 + 6] = 90;
  const desktop = new Array(144).fill(30);
  for (let index = 0; index < 40; index++) desktop[index] = 210;
  const keys = camera({
    clicks: [click],
    changes: [
      { at: 1.7, ...window },
      { at: 2.2, x: window.x, y: window.y + 300, width: window.width, height: 100 },
    ],
    brightness: [
      { at: 0, cells: desktop },
      { at: 1, cells: flat },
      { at: 2, cells: flat },
      { at: 3, cells: painted },
    ],
    length: 12,
  });
  assert.equal(cameraAt(keys, 2.2).zoom, 1, "a flat window keeps the previous framing");
  assert.ok(cameraAt(keys, 4.2).zoom > 1, "the camera eases in once the window has something on it");
  const stillBlank = camera({
    clicks: [click],
    changes: [{ at: 1.7, ...window }],
    brightness: [
      { at: 0, cells: desktop },
      { at: 1, cells: flat },
      { at: 2, cells: flat },
      { at: 3, cells: flat },
      { at: 4, cells: flat },
    ],
    length: 12,
  });
  for (const key of stillBlank) assert.equal(key.view.zoom, 1, "a window that never paints is not zoomed");
  const quiet = camera({ clicks: [click], changes: [{ at: 1.7, ...window }], length: 12 });
  assert.equal(cameraAt(quiet, 1.9).zoom, 1, "with no brightness, the previous framing holds while the window is still changing");
  assert.ok(cameraAt(quiet, 3.2).zoom > 1, "then the camera eases in");
  const half = new Array(144).fill(250);
  for (let y = 1; y <= 2; y++) for (let x = 1; x <= 6; x++) half[y * 16 + x] = 170;
  const settled = new Array(144).fill(40);
  for (let y = 1; y <= 4; y++) for (let x = 1; x <= 6; x++) settled[y * 16 + x] = (x + y) % 2 === 0 ? 30 : 200;
  const drawing = camera({
    clicks: [click],
    changes: [{ at: 1.6, ...window }],
    brightness: [
      { at: 0, cells: desktop },
      { at: 2, cells: half },
      { at: 3, cells: settled },
    ],
    length: 12,
  });
  assert.equal(cameraAt(drawing, 2.5).zoom, 1, "a half-drawn window keeps the previous framing");
  assert.ok(cameraAt(drawing, 4.5).zoom > 1, "the camera eases in once that window has settled");
});

test("typing that follows a click in its field within 2 s zooms on that field, though the window was resized as it opened and is a flat white page (081)", () => {
  const window = { x: 400, y: 120, width: 820, height: 600 };
  const field = { x: 600, y: 600, width: 500, height: 40 };
  const white = Array.from({ length: 144 }, (_, index) => {
    const column = index % 16;
    const row = Math.floor(index / 16);
    return column >= 3 && column <= 10 && row >= 1 && row <= 6 ? 245 : 40;
  });
  const keys = camera({
    clicks: [{ at: 5, x: 850, y: 620, button: "left", count: 1, area: field, role: "text", window }],
    typing: [{ at: 5.2, characters: 40, area: field, secret: false, role: "text", window, by: "agent", call: 1 }, { at: 5.25, characters: 0, area: field, secret: false, role: "text", window, by: "agent", call: 1 }],
    changes: [
      { at: 4, x: 400, y: 120, width: 800, height: 580 },
      { at: 4.6, ...window },
      { at: 5.3, x: 0, y: 0, width: 1300, height: 615 },
    ],
    brightness: [0, 1, 2, 3, 4, 5, 6, 7, 8].map((at) => ({ at, cells: white })),
    length: 14,
  });
  const zoomed = keys.filter((key) => key.view.zoom > 1);
  assert.ok(zoomed.length > 0, `the typed field is zoomed: ${JSON.stringify(keys)}`);
  assert.ok(zoomed.every((key) => key.view.zoom >= 1.8 && viewCovers(SCREEN, key.view, field)), `on the field, not on the panel and title that changed with the line: ${JSON.stringify(zoomed)}`);
  assert.ok(cameraAt(keys, 6.2).zoom >= 1.8, "it is in by the time the line has been typed");
  assert.equal(cameraAt(keys, 4.8).zoom, 1, "the previous framing holds while the window settles from its resize");
});

test("a zoom that could land only after its window has closed is left out, and does not push the next zoom late (081)", () => {
  const small = { width: 1280, height: 720 };
  const desktop = new Array(144).fill(40);
  const withButton = desktop.map((cell, index) => (index % 16 >= 6 && index % 16 <= 9 && Math.floor(index / 16) >= 3 && Math.floor(index / 16) <= 5 ? 220 : cell));
  const withNote = desktop.map((cell, index) => (index % 16 >= 4 && index % 16 <= 11 && Math.floor(index / 16) >= 2 && Math.floor(index / 16) <= 6 ? 245 : cell));
  const field = { x: 335, y: 216, width: 598, height: 299 };
  const note = { x: 334, y: 188, width: 600, height: 330 };
  const planned = scene({
    ...small,
    length: 8,
    clicks: [
      { at: 1.27, x: 644, y: 343, button: "left", count: 1, area: { x: 548, y: 302, width: 192, height: 82 }, role: "push button", window: { x: 524, y: 278, width: 240, height: 130 } },
      { at: 2.46, x: 634, y: 366, button: "left", count: 1, area: field, role: "text", window: note },
    ],
    typing: [{ at: 3.59, characters: 43, area: field, secret: false, role: "text", window: note, by: "agent", call: 1 }, { at: 3.6, characters: 0, area: null, secret: false, window: note, by: "agent", call: 1 }],
    changes: [
      { at: 0.75, x: 120, y: 0, width: 880, height: 413 },
      { at: 2.25, x: 120, y: 0, width: 880, height: 413 },
      { at: 2.5, x: 120, y: 0, width: 888, height: 522 },
      { at: 3.5, x: 146, y: 5, width: 578, height: 229 },
      { at: 3.75, x: 336, y: 216, width: 386, height: 18 },
    ],
    brightness: [desktop, withButton, withButton, withNote, withNote, withNote, withNote, withNote].map((cells, at) => ({ at, cells })),
  });
  const keys = planCamera(planned, planPointer(planned));
  for (let t = 0; t <= 2.6; t += 0.1) assert.equal(cameraAt(keys, t).zoom, 1, `no zoom in on a window that is closing at ${t.toFixed(1)} s: ${JSON.stringify(keys)}`);
  const button = { x: 548, y: 302, width: 192, height: 82 };
  assert.ok(keys.every((key) => key.view.zoom === 1 || key.view.y + 1 < button.y), `no camera key frames the closed window's button: ${JSON.stringify(keys)}`);
  assert.ok(cameraAt(keys, 3.6).zoom >= ZOOM_LEAST, "the typing after it is zoomed as it happens");
  assert.ok(cameraAt(keys, 4).y < button.y, "on the typed line");
});

test("a window is judged painted by its own frame, so a button in a small window on a dark desktop is zoomed, and the typing after it eases in as the camera comes out (081)", () => {
  const ready = { x: 524, y: 278, width: 240, height: 130 };
  const field = { x: 335, y: 216, width: 598, height: 299 };
  const note = { x: 334, y: 188, width: 600, height: 330 };
  const desktop = new Array(144).fill(32);
  const cells = (paint: (column: number, row: number) => number | null) => desktop.map((cell, index) => paint(index % 16, Math.floor(index / 16)) ?? cell);
  const withReady = cells((column, row) => (column >= 6 && column <= 9 && row >= 3 && row <= 5 ? (row === 5 ? 140 : 230) : null));
  const withNote = cells((column, row) => (column >= 4 && column <= 11 && row >= 2 && row <= 6 ? 250 : null));
  const keys = camera({
    width: 1280,
    height: 720,
    length: 8,
    clicks: [
      { at: 1.24, x: 644, y: 343, button: "left", count: 1, area: { x: 548, y: 302, width: 192, height: 82 }, role: "push button", window: ready },
      { at: 2.39, x: 634, y: 366, button: "left", count: 1, area: field, role: "text", window: note },
    ],
    typing: [{ at: 3.5, characters: 43, area: field, secret: false, role: "text", window: note, by: "agent", call: 1 }, { at: 3.51, characters: 0, area: null, secret: false, window: note, by: "agent", call: 1 }],
    changes: [
      { at: 0.67, x: 120, y: 0, width: 880, height: 413 },
      { at: 2.13, x: 120, y: 0, width: 880, height: 413 },
      { at: 2.33, x: 122, y: 0, width: 874, height: 522 },
      { at: 3.53, x: 146, y: 5, width: 578, height: 229 },
      { at: 4.67, x: 85, y: 26, width: 1106, height: 693 },
    ],
    brightness: [desktop, withReady, withNote, withNote, withNote].map((cells, at) => ({ at, cells })),
  });
  assert.ok(cameraAt(keys, 1.3).zoom > 1.5, `the button is zoomed as it is clicked: ${JSON.stringify(keys)}`);
  assert.ok(cameraAt(keys, 4.2).zoom >= ZOOM_LEAST, "the typed line is zoomed before the dialog opens");
  assert.ok(cameraAt(keys, 4.2).y < 300, "on the line");
});

test("a zoom on a window that painted at once lands without waiting for a later reading of the screen (081)", () => {
  const window = { x: 200, y: 120, width: 640, height: 420 };
  const painted = new Array(144).fill(40);
  for (let y = 1; y <= 4; y++) for (let x = 2; x <= 6; x++) painted[y * 16 + x] = (x + y) % 2 === 0 ? 30 : 200;
  const keys = camera({
    clicks: [{ at: 1.5, x: 400, y: 300, button: "left", count: 1, area: { x: 360, y: 280, width: 80, height: 30 }, role: "push button", window }],
    changes: [{ at: 1, ...window }],
    brightness: [{ at: 0, cells: new Array(144).fill(40) }, { at: 1, cells: painted }, { at: 2, cells: painted }, { at: 3, cells: painted }],
    length: 10,
  });
  const top = Math.max(...keys.map((key) => key.view.zoom));
  assert.ok(top > 1);
  assert.equal(cameraAt(keys, 2.4).zoom, top, `in by 2.4 s: ${JSON.stringify(keys)}`);
});

test("a window resized within a second of appearing is still opening: the previous framing holds until it settles (081)", () => {
  const window = { x: 300, y: 200, width: 700, height: 450 };
  const keys = camera({
    clicks: [{ at: 1.3, x: 500, y: 400, button: "left", count: 1, area: { x: 460, y: 380, width: 80, height: 40 }, role: "push button", window }],
    changes: [
      { at: 1, x: 300, y: 200, width: 900, height: 600 },
      { at: 1.8, ...window },
    ],
    length: 10,
  });
  assert.equal(cameraAt(keys, 1.9).zoom, 1, `the camera does not move while the window snaps to its size: ${JSON.stringify(keys)}`);
  assert.equal(cameraAt(keys, 2.15).zoom, 1, "nor until it has been quiet a moment");
  assert.ok(cameraAt(keys, 3.2).zoom > 1, "then it eases in");
  const later = camera({
    clicks: [{ at: 1.3, x: 500, y: 400, button: "left", count: 1, area: { x: 460, y: 380, width: 80, height: 40 }, role: "push button", window }],
    changes: [
      { at: 1, x: 300, y: 200, width: 900, height: 600 },
      { at: 2.3, ...window },
    ],
    length: 10,
  });
  assert.ok(cameraAt(later, 2.2).zoom > 1, "a change more than a second after it appeared is not part of its opening");
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
  const first = ringArt(POINTER_HEIGHT, 0, "left", "dark");
  assert.ok(pixelAt(first.png, first.width / 2, first.height / 2)[3]! < 16, "the ring is a band, not a filled disc");
});

test("a button held still is a click's ring, not a disc left under the pointer (073)", () => {
  const samples = [{ at: 0, x: 400, y: 300, buttons: 0 }, ...Array.from({ length: 24 }, (_, index) => ({ at: 2 + index * 0.25, x: 400, y: 300, buttons: index === 23 ? 0 : 1 }))];
  const planned = scene({
    samples,
    length: 10,
    clicks: [{ at: 2, x: 400, y: 300, button: "left" as const, count: 1 as const, area: null, role: "textbox" }],
    typing: [
      { at: 2.5, characters: 24, area: null, secret: false, role: "textbox" },
      { at: 3.2, characters: 0, area: null, secret: false },
    ],
  });
  const pointer = planPointer(planned);
  assert.deepEqual(pointer.drags, []);
  assert.equal(pointer.rings.length, 1);
  assert.equal(shapeAt(pointerShapes(planned), 4), "ibeam");
  const shown = planScene(
    facts({
      samples: samples.map((sample) => ({ ...sample, at: 1000 + sample.at })),
      inputs: [
        click(2, 400, 300),
        { at: 1002.5, by: "agent", type: "typing", characters: 24, space: "screen", area: null, secret: false, role: "textbox" },
        { at: 1003.2, by: "agent", type: "typing", characters: 0, space: "screen", area: null, secret: false },
      ],
    }),
    SCREEN,
    1000,
    10,
    { zoom: false, frame: false },
  );
  assert.equal(shown.art.some((art) => art.name === "press.png"), false);
  const head = sceneHead(shown, 1).graph;
  assert.doesNotMatch(head, /overlay@press/);
  assert.match(head, /between\(t,2\.000,2\.067\)/);
  assert.doesNotMatch(head, /between\(t,2\.\d+,2\.[5-9]/);
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
