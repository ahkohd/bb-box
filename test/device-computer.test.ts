import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { BoxRecord } from "../src/core/boxes.ts";
import { ComputerError } from "../src/core/computer.ts";
import { DeviceComputer, deviceKey, scrollSwipe, type DeviceComputerDeps } from "../src/core/device-computer.ts";
import { PERSON_HAS_CONTROL_WORDS, type DeviceAgentRequest, type DeviceAnswer, type DeviceElement, type DeviceInput, type DeviceRead, type DeviceState } from "../src/core/device.ts";
import { rgbaPng } from "../src/core/png.ts";
import { GrpcError } from "../src/device/grpc.ts";
import { READ_BY_POINTS_WORDS, iosTree, readIosTree, roleWords, type TreeReads } from "../src/device/ios-tree.ts";

const SCALE = 3;
const SCREEN = { width: 1206, height: 2622 };

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`./fixtures/ios-tree-${name}.json`, import.meta.url), "utf8"));
}

function flatten(elements: readonly DeviceElement[]): DeviceElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children)]);
}

const BOX = { id: "b1", name: "quiet-fox", capabilities: { device: { platform: "ios" } } } as unknown as BoxRecord;

class FakeDevice {
  tree: readonly DeviceElement[];
  generation = 1;
  frames = 0;
  personHasControl = false;
  readonly inputs: DeviceInput[] = [];
  readonly requests: DeviceAgentRequest[] = [];
  readonly reads: DeviceRead["type"][] = [];
  onInput: (input: DeviceInput) => void = () => undefined;
  took = false;

  constructor(tree: readonly DeviceElement[]) {
    this.tree = tree;
  }

  at(point: { readonly x: number; readonly y: number }): DeviceElement | null {
    let found: DeviceElement | null = null;
    const visit = (element: DeviceElement) => {
      const { x, y, width, height } = element.frame;
      if (point.x >= x && point.y >= y && point.x < x + width && point.y < y + height) found = { ...element, children: [] };
      element.children.forEach(visit);
    };
    this.tree.forEach(visit);
    return found;
  }

  state(): DeviceState {
    return {
      platform: "ios",
      model: "iPhone 18 Pro",
      power: { is: "booted", awake: true },
      geometry: { generation: this.generation, physical: "upright", content: "upright", video: SCREEN },
      settings: { appearance: { known: false, why: "test" }, textSize: { known: false, why: "test" }, location: { set: null, at: null }, statusBar: { set: null, at: null } },
      at: 0,
    };
  }

  ok(result: Extract<DeviceAnswer, { ok: true }>["result"]): DeviceAnswer {
    return { id: "r", ok: true, ms: 1, state: this.state(), result };
  }

  deps(): DeviceComputerDeps {
    return {
      read: async (_box, request) => {
        this.reads.push(request.type);
        if (request.type === "tree") return this.ok({ type: "tree", elements: this.tree, generation: this.generation });
        if (request.type === "settle") return this.ok({ type: "settled", frames: this.frames, quiet: true });
        if (request.type === "at") return this.ok({ type: "at", element: this.at(request), generation: this.generation });
        const png = rgbaPng(603, 1311, new Uint8Array(603 * 1311 * 4)).toString("base64");
        return this.ok({ type: "screenshot", png, generation: this.generation, source: SCREEN });
      },
      input: async (_box, input) => {
        if (this.personHasControl) return { id: "r", ok: false, error: { code: "person-has-control", words: PERSON_HAS_CONTROL_WORDS }, state: this.state() };
        for (const at of pointsOf(input)) if (at.generation !== this.generation) return { id: "r", ok: false, error: { code: "stale-geometry", words: "The device turned or changed since that point was taken. Take another screenshot." }, state: this.state() };
        this.inputs.push(input);
        this.frames++;
        this.onInput(input);
        return this.ok({ type: "done" });
      },
      agentRequest: async (_box, request) => {
        this.requests.push(request);
        if (request.type === "launch") return this.ok({ type: "launched", app: { id: "com.apple.Preferences", name: "Settings" } });
        return this.ok({ type: "done" });
      },
      personHasControl: () => this.personHasControl,
      takeBack: async () => {
        const had = this.personHasControl;
        this.personHasControl = false;
        this.took = had;
        return had;
      },
      sleep: async () => undefined,
    };
  }
}

function pointsOf(input: DeviceInput): { readonly generation: number }[] {
  switch (input.type) {
    case "tap":
    case "long_press":
      return [input.at];
    case "swipe":
      return [input.from, input.to];
    case "pinch":
      return [input.centre];
    default:
      return [];
  }
}

function refOf(text: string, line: RegExp): string {
  const found = text.split("\n").find((each) => line.test(each));
  assert.ok(found, `no line matches ${line} in:\n${text}`);
  return /\[(e\d+)\]/.exec(found)![1]!;
}

function element(role: string, label: string, frame: DeviceElement["frame"], extra: Partial<DeviceElement> = {}): DeviceElement {
  return { role, identifier: null, label, value: null, frame, enabled: true, focused: false, can: { tap: true, edit: false, scroll: false }, children: [], ...extra };
}

function screenOf(children: DeviceElement[]): readonly DeviceElement[] {
  return [element("application", "Test", { x: 0, y: 0, ...SCREEN }, { can: { tap: false, edit: false, scroll: false }, children })];
}

describe("iOS's accessibility tree, read from idb (063, 7.1)", () => {
  test("turns idb's elements into the device's, in the video's pixels, with identifiers, values and what each can do", () => {
    const tree = flatten(iosTree(fixture("settings"), SCALE));
    const general = tree.find((each) => each.identifier === "com.apple.settings.general")!;
    assert.deepEqual(general.frame, { x: 48, y: 880, width: 1110, height: 156 });
    assert.equal(general.role, "button");
    assert.equal(general.label, "General");
    assert.deepEqual(general.can, { tap: true, edit: false, scroll: false });
    const search = tree.find((each) => each.role === "search field")!;
    assert.equal(search.value, "Search");
    assert.equal(search.can?.edit, true);
    const list = tree.find((each) => each.identifier === "com.apple.settings.sidebar.collectionView")!;
    assert.equal(list.can?.scroll, true, "the list scrolls");
    assert.ok(list.children.every((row) => !row.can?.scroll), "its rows, inside it, are not scrollers of their own");
    const safari = flatten(iosTree(fixture("safari"), SCALE));
    const address = safari.find((each) => each.identifier === "TabBarItemTitle")!;
    assert.equal(address.value, "example.com", "direction marks are dropped");
    assert.equal(address.can?.edit, true);
    const back = safari.find((each) => each.identifier === "BackButton")!;
    assert.equal(back.enabled, false);
    assert.equal(back.can?.tap, false);
  });

  test("reads the Home Screen point by point when iOS names no app in front, as on a new box, and says so", async () => {
    const raw = (fixture("home") as { children: { frame: { x: number; y: number; width: number; height: number } }[] }[])[0]!.children;
    const reads: TreeReads = {
      tree: async () => {
        throw new GrpcError(2, "The simulator's accessibility service named no frontmost application");
      },
      at: async (point) => raw.find(({ frame }) => point.x >= frame.x && point.y >= frame.y && point.x < frame.x + frame.width && point.y < frame.y + frame.height) ?? { role: "AXApplication", AXLabel: " ", frame: { x: 0, y: 0, width: 402, height: 874 }, pid: 78378 },
      processName: async () => "/Library/Developer/CoreSimulator/Volumes/iOS_24A434/Library/Developer/CoreSimulator/Profiles/Runtimes/iOS 27.0.simruntime/Contents/Resources/RuntimeRoot/System/Library/CoreServices/SpringBoard.app/SpringBoard",
    };
    const read = await readIosTree(reads, { width: 402, height: 874 }, SCALE);
    assert.equal(read.byPoints, true);
    const root = read.elements[0]!;
    assert.equal(root.label, "Home Screen");
    assert.equal(root.value, READ_BY_POINTS_WORDS);
    const labels = root.children.map((each) => each.label);
    assert.equal(labels.filter((label) => label === "Calendar").length, 2, "the widget and the app, each once");
    assert.ok(labels.includes("Safari") && labels.includes("Settings"));
    assert.equal(new Set(root.children.map((each) => JSON.stringify(each.frame))).size, root.children.length, "no element twice");
    const device = new FakeDevice(read.elements);
    const computer = new DeviceComputer(device.deps());
    assert.match((await computer.windows(BOX)).text, /^Window 1: iPhone 18 Pro \(device\), Home Screen in front,/);
    assert.match((await computer.observe(BOX, { window: 1 })).text, /- \[e\d+\] application "Home Screen" = "read point by point, as iOS named no app in front"/);
    await assert.rejects(readIosTree({ ...reads, tree: async () => { throw new GrpcError(14, "connection refused"); } }, { width: 402, height: 874 }, SCALE), /connection refused/);
    assert.equal((await readIosTree({ ...reads, tree: async () => fixture("settings") }, { width: 402, height: 874 }, SCALE)).byPoints, false);
  });

  test("names roles in words", () => {
    assert.equal(roleWords("AXStaticText"), "static text");
    assert.equal(roleWords("AXSearchField"), "search field");
    assert.equal(roleWords("AXSlider"), "slider");
  });
});

describe("the computer tools on a device (063, 7.1)", () => {
  test("observe gives one line an element, with references, identifiers, values, and where an element is off the screen", async () => {
    const device = new FakeDevice(iosTree(fixture("safari"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    assert.match(text, /^Window 1: iPhone 18 Pro \(device\), Safari in front, 1206x2622 pixels, upright\./);
    assert.match(text, /- \[e\d+\] text field "Address" \(id TabBarItemTitle\) = "example\.com", editable/);
    assert.match(text, /- \[e\d+\] button "Turn On", below the screen/);
    assert.match(text, /- \[e\d+\] button "Back" \(id BackButton\), disabled/);
    const windows = await computer.windows(BOX);
    assert.match(windows.text, /Window 1: iPhone 18 Pro \(device\), Safari in front/);
    await assert.rejects(computer.observe(BOX, { window: 2 }), (error: unknown) => error instanceof ComputerError && /one window, 1/.test(error.message));
  });

  test("a click by reference taps the element's centre, in the video's pixels, and keeps its reference across reads", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const first = await computer.observe(BOX, { window: 1 });
    const general = refOf(first.text, /"General"/);
    const again = await computer.observe(BOX, { window: 1 });
    assert.equal(refOf(again.text, /"General"/), general);
    const done = await computer.act(BOX, { action: "click", ref: general });
    assert.deepEqual(device.inputs, [{ type: "tap", at: { x: 603, y: 958, generation: 1 } }]);
    assert.match(done.text, new RegExp(`^Tapped ${general}, button "General"\\.`));
    assert.match(done.text, /Nothing on the screen changed\.|The picture changed, but no element did\./);
  });

  test("tells two elements with one label apart by their place, and refuses one that has become ambiguous", async () => {
    const device = new FakeDevice(iosTree(fixture("home"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    const calendars = text.split("\n").filter((line) => /button "Calendar" \(id Calendar\)/.test(line));
    assert.equal(calendars.length, 2);
    const second = /\[(e\d+)\]/.exec(calendars[1]!)![1]!;
    await computer.act(BOX, { action: "click", ref: second });
    assert.deepEqual(device.inputs.at(-1), { type: "tap", at: { x: 186, y: 1002, generation: 1 } }, "the second Calendar, the app's icon, not the widget");
    const moved = (shift: number) => (element: DeviceElement): DeviceElement => ({ ...element, frame: { ...element.frame, y: element.frame.y + shift }, children: element.children.map(moved(shift)) });
    const widget = flatten(device.tree).find((each) => each.label === "Calendar")!;
    device.tree = [{ ...device.tree[0]!, children: [...device.tree[0]!.children.map(moved(30)), { ...widget, frame: { ...widget.frame, y: 2000 } }] }];
    await assert.rejects(computer.act(BOX, { action: "click", ref: second }), (error: unknown) => error instanceof ComputerError && error.code === "refused" && /is ambiguous now: 3 elements match it/.test(error.message));
  });

  test("set_value sets a text field by a tap, select all and typing, and refuses a slider with words to drag it", async () => {
    const field = element("text field", "Name", { x: 60, y: 600, width: 1000, height: 120 }, { can: { tap: true, edit: true, scroll: false } });
    const slider = element("slider", "Brightness", { x: 60, y: 900, width: 1000, height: 90 }, { value: "50%", can: { tap: true, edit: false, scroll: false } });
    const device = new FakeDevice(screenOf([field, slider]));
    device.onInput = (input) => {
      if (input.type === "text") device.tree = screenOf([{ ...field, value: input.text }, slider]);
    };
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    const name = refOf(text, /"Name"/);
    const brightness = refOf(text, /"Brightness"/);
    const set = await computer.act(BOX, { action: "set_value", ref: name, value: "Ada" });
    assert.deepEqual(
      device.inputs.map((input) => input.type === "key" ? `key ${input.modifiers.join("+")}+${input.key}` : input.type),
      ["tap", "key meta+a", "text"],
    );
    assert.match(set.text, new RegExp(`Set ${name}, text field "Name", to "Ada"\\. ${name} reads "Ada" now\\.`));
    await assert.rejects(
      computer.act(BOX, { action: "set_value", ref: brightness, value: "80%" }),
      (error: unknown) => error instanceof ComputerError && error.code === "refused" && /is not a text field, so set_value cannot set it.*Drag it with computer_act's drag instead\./.test(error.message),
    );
    assert.equal(device.inputs.length, 3, "nothing sent to the slider");
  });

  test("scroll swipes within the list holding the element, a fifth of it a step, and stops at the list's end", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    const general = refOf(text, /"General"/);
    let moves = 0;
    device.onInput = () => {
      if (++moves > 1) return;
      const shift = (element: DeviceElement): DeviceElement => ({ ...element, frame: { ...element.frame, y: element.frame.y - 500 }, children: element.children.map(shift) });
      device.tree = [{ ...device.tree[0]!, children: device.tree[0]!.children.map((child) => (child.identifier === "com.apple.settings.sidebar.collectionView" ? { ...child, children: child.children.map(shift) } : child)) }];
    };
    const done = await computer.act(BOX, { action: "scroll", ref: general, direction: "down", amount: 3 });
    assert.equal(device.inputs.length, 2, "the second swipe moved nothing, so there was no third");
    const swipe = device.inputs[0]!;
    assert.ok(swipe.type === "swipe");
    assert.deepEqual([swipe.from.x, swipe.from.y, swipe.to.x, swipe.to.y], [603, 1573, 603, 1049], "up the list's middle by a fifth of its height");
    assert.match(done.text, /Scrolled down in e\d+, group \(id com\.apple\.settings\.sidebar\.collectionView\) 1 of 3 steps: it moved no further, so it is at its end\./);
  });

  test("a tap by reference goes where the element shows, and is refused where another covers it", async () => {
    const row = element("button", "Accessibility", { x: 48, y: 42, width: 1110, height: 168 });
    const bar = element("heading", "Settings", { x: 0, y: 0, width: 1206, height: 150 }, { can: { tap: false, edit: false, scroll: false } });
    const island = element("generic element", "Dynamic Island", { x: 460, y: 42, width: 284, height: 110 }, { can: { tap: false, edit: false, scroll: false } });
    const hidden = element("button", "General", { x: 48, y: 20, width: 1110, height: 100 });
    const device = new FakeDevice(screenOf([row, hidden, bar, island]));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    await computer.act(BOX, { action: "click", ref: refOf(text, /"Accessibility"/) });
    assert.deepEqual(device.inputs, [{ type: "tap", at: { x: 603, y: 176, generation: 1 } }], "below the bar and the island, where the row shows");
    await assert.rejects(
      computer.act(BOX, { action: "click", ref: refOf(text, /"General"/) }),
      (error: unknown) => error instanceof ComputerError && /is covered by (heading "Settings"|generic element "Dynamic Island") where it is now/.test(error.message) && /^Scroll up/.test(error.hint ?? ""),
    );
    assert.equal(device.inputs.length, 1);
  });

  test("names the system's screen when what comes in front has no name, as an alert", async () => {
    const button = element("button", "Continue", { x: 100, y: 2000, width: 1000, height: 150 });
    const device = new FakeDevice(screenOf([button]));
    device.onInput = () => {
      device.tree = [element("application", "", { x: 0, y: 0, ...SCREEN }, { can: { tap: false, edit: false, scroll: false }, children: [element("button", "Allow Once", { x: 100, y: 1200, width: 1000, height: 150 })] })];
    };
    const computer = new DeviceComputer(device.deps());
    const done = await computer.act(BOX, { action: "click", ref: refOf((await computer.observe(BOX, { window: 1 })).text, /"Continue"/) });
    assert.match(done.text, /Now in front: the Home Screen or a system screen\./);
  });

  test("a turn of the device voids its references, and a point of an older image", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    const general = refOf(text, /"General"/);
    await computer.screenshot(BOX, 1);
    device.generation = 2;
    await assert.rejects(computer.act(BOX, { action: "click", ref: general }), (error: unknown) => error instanceof ComputerError && error.code === "stale" && /turned or changed since you read/.test(error.message));
    await assert.rejects(computer.act(BOX, { action: "click", x: 10, y: 10 }), (error: unknown) => error instanceof ComputerError && error.code === "stale");
    assert.equal(device.inputs.length, 0);
  });

  test("x and y are pixels of the latest image, scaled to the device's own", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const shot = await computer.screenshot(BOX, 1);
    assert.match(shot.text, /Image 603x1311 of the device's screen 1206x2622, scale 0\.5; x and y are image pixels\./);
    await computer.act(BOX, { action: "click", x: 301, y: 478 });
    assert.deepEqual(device.inputs, [{ type: "tap", at: { x: 603, y: 957, generation: 1 } }]);
    await computer.act(BOX, { action: "drag", x: 100, y: 500, toX: 300, toY: 500 });
    const drag = device.inputs.at(-1)!;
    assert.ok(drag.type === "swipe");
    assert.deepEqual([drag.from.x, drag.to.x], [201, 601]);
  });

  test("while a person has control, reading goes on and acting is refused in the device's words", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const { text } = await computer.observe(BOX, { window: 1 });
    device.personHasControl = true;
    assert.match((await computer.observe(BOX, { window: 1 })).text, /"General"/);
    for (const act of [() => computer.act(BOX, { action: "click", ref: refOf(text, /"General"/) }), () => computer.type(BOX, { text: "hi" }), () => computer.launch(BOX, { app: "Settings" })]) {
      await assert.rejects(act(), (error: unknown) => error instanceof ComputerError && error.code === "paused" && error.message === PERSON_HAS_CONTROL_WORDS);
    }
    assert.equal(device.inputs.length + device.requests.length, 0);
    const back = await computer.takeControl(BOX);
    assert.match(back.text, /You took control of box quiet-fox's device back\./);
  });

  test("launch opens an app by name, or a link, and says what is in front", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const computer = new DeviceComputer(device.deps());
    const app = await computer.launch(BOX, { app: "Settings" });
    assert.match(app.text, /^Launched Settings \(com\.apple\.Preferences\)\. Window 1: iPhone 18 Pro \(device\), Settings in front/);
    const link = await computer.launch(BOX, { url: "https://example.com" });
    assert.match(link.text, /^Opened https:\/\/example\.com\./);
    assert.deepEqual(device.requests, [{ type: "launch", app: "Settings" }, { type: "open", url: "https://example.com" }]);
  });

  test("type taps the field first, types, presses keys by their W3C names, and says what it reads", async () => {
    const field = element("text field", "Address", { x: 60, y: 600, width: 1000, height: 120 }, { can: { tap: true, edit: true, scroll: false } });
    const device = new FakeDevice(screenOf([field]));
    device.onInput = (input) => {
      if (input.type === "text") device.tree = screenOf([{ ...field, value: input.text, focused: true }]);
    };
    const computer = new DeviceComputer(device.deps());
    const ref = refOf((await computer.observe(BOX, { window: 1 })).text, /"Address"/);
    const done = await computer.type(BOX, { ref, text: "example.com", keys: "Return" });
    assert.deepEqual(device.inputs.map((input) => input.type), ["tap", "text", "key"]);
    assert.deepEqual(device.inputs.at(-1), { type: "key", key: "Enter", modifiers: [] });
    assert.match(done.text, new RegExp(`^Typed "example\\.com" and pressed Return into ${ref}, text field "Address"\\. ${ref} reads "example\\.com" now\\.`));
  });

  test("waits for typed text that the device takes slowly, and presses no keys when it never arrives", async () => {
    const field = element("text field", "Address", { x: 60, y: 600, width: 1000, height: 120 }, { focused: true, can: { tap: true, edit: true, scroll: false } });
    const device = new FakeDevice(screenOf([field]));
    let pending = "";
    let shown = "";
    device.onInput = (input) => {
      if (input.type === "text") pending = input.text;
    };
    const deps = device.deps();
    const read = deps.read;
    deps.read = async (box, request) => {
      if (request.type === "tree" && pending) {
        shown += pending.slice(shown.length, shown.length + 4);
        device.tree = screenOf([{ ...field, value: shown }]);
      }
      return read(box, request);
    };
    const computer = new DeviceComputer(deps);
    const ref = refOf((await computer.observe(BOX, { window: 1 })).text, /"Address"/);
    const done = await computer.type(BOX, { ref, text: "example.com", keys: "Return" });
    assert.deepEqual(device.inputs.map((input) => input.type), ["text", "key"], "the text once, then Return");
    assert.match(done.text, /reads "example\.com" now\./);
    pending = "";
    shown = "";
    device.onInput = (input) => {
      if (input.type === "text") device.tree = screenOf([{ ...field, value: "exam" }]);
    };
    await assert.rejects(
      computer.type(BOX, { ref, text: "example.com", keys: "Return" }),
      (error: unknown) => error instanceof ComputerError && /reads "exam": the device has not taken all of the keys, so bb-box did not press Return\./.test(error.message),
    );
    assert.equal(device.inputs.at(-1)?.type, "text", "no Return after text that did not land");
  });

  test("reads again while the device cannot name its app yet, as just after it boots", async () => {
    const device = new FakeDevice(iosTree(fixture("settings"), SCALE));
    const deps = device.deps();
    const read = deps.read;
    let failures = 2;
    deps.read = async (box, request) => {
      if (request.type === "tree" && failures-- > 0) return { id: "r", ok: false, error: { code: "failed", words: "The simulator's accessibility service named no frontmost application" }, state: device.state() };
      return read(box, request);
    };
    const computer = new DeviceComputer(deps);
    assert.match((await computer.windows(BOX)).text, /Settings in front/);
  });

  test("names keys and modifiers as the device server takes them", () => {
    assert.deepEqual(deviceKey("cmd+a"), { key: "a", modifiers: ["meta"] });
    assert.deepEqual(deviceKey("ctrl+shift+Tab"), { key: "Tab", modifiers: ["control", "shift"] });
    assert.deepEqual(deviceKey("esc"), { key: "Escape", modifiers: [] });
    assert.deepEqual(deviceKey("f5"), { key: "F5", modifiers: [] });
    assert.throws(() => deviceKey("hyper+a"), (error: unknown) => error instanceof ComputerError && /not a modifier key/.test(error.message));
  });

  test("a scroll's swipe runs against the way the list scrolls", () => {
    const region = { x: 0, y: 0, width: 1000, height: 2000 };
    assert.deepEqual(scrollSwipe(region, "down"), { from: { x: 500, y: 1200 }, to: { x: 500, y: 800 } });
    assert.deepEqual(scrollSwipe(region, "up"), { from: { x: 500, y: 800 }, to: { x: 500, y: 1200 } });
    assert.deepEqual(scrollSwipe(region, "right"), { from: { x: 600, y: 1000 }, to: { x: 400, y: 1000 } });
  });
});
