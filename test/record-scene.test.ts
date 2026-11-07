
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
  typingFocus,
  type Scene,
} from "../src/core/record-motion.ts";
import { planScene, sceneCommands, zoomFilter, type SceneFacts } from "../src/core/record-scene.ts";
import { clipGraph, parsePrepared, planClip, type Prepared } from "../src/core/record.ts";
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
    { at: 5, secret: false },
    { at: 5.8, secret: false },
    { at: 7, secret: false },
    { at: 12, secret: true },
    { at: 12.5, secret: true },
  ];
  const pills = planKeyPills(keys, typing, "pc", 20);
  assert.deepEqual(pills.map((pill) => [pill.text, pill.from, pill.to]), [
    ["↓ ×3", 1, 2.8],
    [TYPING_WORDS, 5, 7.6],
    ["Ctrl+S", 9, 10.2],
  ]);
  assert.ok(!pills.some((pill) => pill.from >= 12), "the password's typing shows nothing");
});

test("only Shift is typing, and so is Option on a Mac; a person's printable keys are logged as typing, never as the character (073)", () => {
  const inputs = new RecordingInputs(() => 5_000);
  inputs.begin("mac", 0, "macos");
  inputs.acted("mac", { type: "keys", chord: normalChord("2", ["option"]) });
  inputs.acted("mac", { type: "keys", chord: normalChord("a", ["shift"]) });
  inputs.acted("mac", { type: "keys", chord: normalChord("c", ["cmd"]) });
  assert.deepEqual(inputs.end("mac")!.map((event) => event.type), ["typing", "typing", "keys"]);
  const person = new RecordingInputs(() => 5_000);
  person.begin("pc", 0, "linux");
  for (const [keysym, down] of [[0xffe3, true], [0x73, true], [0x73, false], [0xffe3, false], [0x70, true], [0x77, true], [0xff0d, true]] as const) person.person("pc", { type: "key", keysym, down });
  const events = person.end("pc")!;
  assert.deepEqual(events.map((event) => (event.type === "keys" ? chordWords(event.chord, "pc") : event.type)), ["Ctrl+S", "typing", "typing", "Enter"]);
  assert.doesNotMatch(JSON.stringify(events), /"[pw]"/, "no typed character is kept");
  assert.equal(keysymKey(0x1000416), "Ж");
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
  inputs.acted("box", { type: "keys", chord: normalChord("Return", []) });
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
  assert.match(commands[0]!, /^0\.000 overlay@pointer x \d+, overlay@pointer y \d+;$/);
  assert.ok(commands.includes("0.000 overlay@pointer enable 1;"));
  const ring = commands.filter((line) => line.includes("overlay@ringl0"));
  assert.match(ring[0]!, /^3\.000 overlay@ringl0 x \d+, overlay@ringl0 y \d+, overlay@ringl0 enable 1;$/);
  assert.equal(ring[1], "3.067 overlay@ringl0 enable 0;");
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

test("the stop's facts carry the sampler's pointer, the changed regions and the brightness; a person's Selkies input is read as pointer places and keys (073)", () => {
  const stdout = `{"ended":"stopped","recorded":12.5,"size":"1920x1080","start":1000.000,"position":"top","cuts":[[1.5,3]],"pointer":"drawn","lag":0.09,"luma":71.2,"keys":"pc"}\nP screen 1920 1080\nP 1000.100 10 20 0\nP 1000.400 15 25 1\nC 2.250 400 300 120 24\n`;
  const prepared = parsePrepared(stdout)!;
  assert.deepEqual(prepared.scene, { pointer: "drawn", screen: { width: 1920, height: 1080 }, samples: [{ at: 1000.1, x: 10, y: 20, buttons: 0 }, { at: 1000.4, x: 15, y: 25, buttons: 1 }], changes: [{ at: 2.25, x: 400, y: 300, width: 120, height: 24 }], luma: 71.2, lag: 0.09, keys: "pc", agentCursor: false });
  assert.deepEqual(personInput("m,640,360,1,0,77"), { type: "pointer", x: 640, y: 360, buttons: 1 });
  assert.deepEqual(personInput("kd,65293"), { type: "key", keysym: 65293, down: true });
  assert.equal(personInput("m2,4,-3,0,0"), null, "relative motion is not a place");
  assert.equal(personInput("co,aGVsbG8="), null, "the clipboard is not input");
});

test("typing into a large text area zooms on where the text appears, or on the pointer, not on the whole area (073)", () => {
  const area = { x: 644, y: 353, width: 640, height: 452 };
  const typing = { at: 3, characters: 50, area, secret: false };
  const line = { at: 3.25, x: 650, y: 380, width: 300, height: 18 };
  const elsewhere = { at: 3.25, x: 1700, y: 10, width: 60, height: 12 };
  const pointer = planPointer(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }] }));
  assert.deepEqual(typingFocus(scene({ typing: [typing], changes: [line, elsewhere] }), typing, pointer), { x: 650, y: 380, width: 300, height: 18 }, "the text as it appears, inside the field");
  assert.deepEqual(typingFocus(scene({ typing: [typing] }), typing, pointer), { x: 900, y: 500, width: 0, height: 0 }, "else where the pointer is");
  const camera = planCamera(scene({ clicks: [{ at: 2.5, x: 900, y: 500, button: "left", count: 1, area: null }], typing: [typing], changes: [line] }), pointer);
  assert.ok(cameraAt(camera, 3.4).zoom > 1.5, "the click and the typing after it stay zoomed in");
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

test("where Cua draws the agent's own pointer, as on macOS, bb-box draws only the real pointer, from when it first moves, and still rings each click (073)", () => {
  const clicks = [{ at: 3, x: 700, y: 400, button: "left" as const, count: 1 as const, area: null }];
  const parked = planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }], agentCursor: true }));
  assert.equal(parked.visibleFrom, null, "a pointer parked in the corner all along is not drawn");
  assert.deepEqual(parked.rings.map((ring) => [ring.x, ring.y]), [[700, 400]]);
  const moved = planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }, { at: 5, x: 40, y: 30, buttons: 0 }, { at: 5.03, x: 80, y: 60, buttons: 0 }], agentCursor: true }));
  assert.ok(moved.visibleFrom !== null && moved.visibleFrom > 4.9 && moved.visibleFrom < 5, "shown once a person moves it");
  assert.deepEqual(moved.frames[Math.round(3 * CLIP_FPS)], { x: 0, y: 0 }, "the agent's click does not move it");
  assert.deepEqual(planPointer(scene({ clicks, samples: [{ at: 0, x: 0, y: 0, buttons: 0 }] })).frames[Math.round(3 * CLIP_FPS)], { x: 700, y: 400 }, "elsewhere it glides to the click");
});
