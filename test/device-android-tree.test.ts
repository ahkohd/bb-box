import "./check-test-machine.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import type { DeviceElement } from "../src/core/device.ts";
import {
  AndroidTreeSource,
  TREE_SERVER_DEX,
  TREE_SERVER_RETRY_MS,
  appFor,
  heldElsewhereWords,
  instrumentationWords,
  type AndroidTreeOptions,
  type LauncherApp,
  type TreeChannel,
} from "../src/device/android-tree-source.ts";
import { PAGE_NOT_SHOWN_WORDS, androidElementAt, androidElements, parseDump, parseServerTree, placedOffScreen, pictureFrame, placement, type AndroidScreen } from "../src/device/android-tree.ts";
import { DriverError } from "../src/device/driver.ts";

const UPRIGHT = { video: { width: 1080, height: 2400 }, physical: "upright" } as const;
const LABELS: Readonly<Record<string, string>> = { "com.android.settings": "Settings", "com.google.android.apps.nexuslauncher": "Pixel Launcher" };
const labels = (pkg: string) => LABELS[pkg] ?? null;

function text(name: string): string {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
}

function served(name: string): AndroidScreen {
  const answer = parseServerTree(text(name));
  assert.ok(answer.ok);
  return answer.screen;
}

function flatten(elements: readonly DeviceElement[]): DeviceElement[] {
  return elements.flatMap((element) => [element, ...flatten(element.children)]);
}

function named(elements: readonly DeviceElement[], label: string, role?: string): DeviceElement {
  const found = flatten(elements).find((element) => element.label === label && (!role || element.role === role));
  assert.ok(found, `no element "${label}"`);
  return found;
}

describe("Android's tree, from BB Box's tree server and from uiautomator dump (063, 7.2 and 7.3)", () => {
  test("reads the server's windows, with the display's rotation and size", () => {
    const screen = served("android-tree-settings.json");
    assert.equal(screen.source, "server");
    assert.equal(screen.rotation, 0);
    assert.deepEqual(screen.display, { width: 1080, height: 2400 });
    assert.deepEqual(
      screen.windows.map((window) => [window.type, window.pkg, window.active]),
      [
        [3, "com.android.systemui", false],
        [1, "com.android.settings", true],
      ],
    );
  });

  test("puts the app in front first, named by its label, then the system's windows, and merges a row's texts into it", () => {
    const { elements } = androidElements(served("android-tree-settings.json"), UPRIGHT, labels);
    assert.deepEqual(
      elements.map((root) => [root.role, root.label]),
      [
        ["application", "Settings"],
        ["system", "System UI"],
      ],
    );
    const row = named(elements, "Network & internet, Mobile, Wi‑Fi, hotspot");
    assert.equal(row.role, "button");
    assert.deepEqual(row.can, { tap: true, edit: false, scroll: false });
    assert.deepEqual(row.frame, { x: 0, y: 774, width: 1080, height: 231 });
    assert.equal(row.children.length, 0, "its title and summary are its label, not lines of their own");
    const search = named(elements, "Search settings");
    assert.equal(search.identifier, "search_action_bar", "the app's own package is left off its identifiers");
    assert.equal(named(elements, "Settings", "text").identifier, "homepage_title");
  });

  test("lists rows the list holds below the screen as below it, and leaves out what is hidden", () => {
    const { elements } = androidElements(served("android-tree-settings.json"), UPRIGHT, labels);
    const below = named(elements, "Accessibility, Display, interaction, audio");
    assert.ok(below.frame.y >= 2400, `at ${JSON.stringify(below.frame)}`);
    assert.ok(!flatten(elements).some((element) => element.frame.width <= 0 || element.frame.height <= 0), "nothing of no size");
  });

  test("names a field by its hint, gives what it holds as its value, and keeps the keyboard as one element over it", () => {
    const read = androidElements(served("android-tree-keyboard.json"), UPRIGHT, labels);
    const field = named(read.elements, "Search settings");
    assert.equal(field.role, "text field");
    assert.equal(field.value, "Wallp");
    assert.equal(field.focused, true);
    assert.deepEqual(field.can, { tap: true, edit: true, scroll: false });
    const keyboard = read.elements.find((root) => root.role === "keyboard");
    assert.ok(keyboard);
    assert.equal(keyboard.label, "English (US) (QWERTY)");
    assert.deepEqual(keyboard.children, []);
    assert.equal(read.elements[0]?.label, "Settings Services", "an app that is not on the launcher goes by its window's title");
    assert.equal(androidElementAt(read, { x: 540, y: 2000 })?.role, "keyboard", "the keyboard covers what is under it");
    assert.equal(androidElementAt(read, { x: 500, y: 220 })?.label, "Search settings");
    assert.match(androidElementAt(read, { x: 90, y: 60 })?.label ?? "", /^7:34\sPM$/, "the status bar is above the app");
  });

  test("reads uiautomator's dump of the same screen, and finds the same rows by the same words", () => {
    const dump = parseDump(`${text("android-dump-settings.xml")}UI hierchary dumped to: /dev/tty\n`);
    assert.equal(dump.source, "dump");
    assert.equal(dump.windows.length, 1);
    assert.equal(dump.windows[0]?.pkg, "com.android.settings");
    const fromDump = androidElements(dump, UPRIGHT, labels).elements;
    const fromServer = androidElements(served("android-tree-settings.json"), UPRIGHT, labels).elements;
    const tappable = (elements: readonly DeviceElement[]) =>
      flatten(elements)
        .filter((element) => element.can?.tap && element.frame.y < 2400)
        .map((element) => `${element.role} ${element.label} ${element.identifier ?? ""} ${JSON.stringify(element.frame)}`)
        .sort();
    assert.deepEqual(tappable(fromDump), tappable(fromServer));
    assert.equal(fromDump[0]?.label, "Settings");
  });

  test("says when Chrome is not showing its page in the tree, and to take a screenshot", () => {
    const line = JSON.stringify({
      ok: true,
      rotation: 0,
      width: 1080,
      height: 2400,
      windows: [{ type: 1, layer: 0, title: "Chrome", active: true, focused: true, b: [0, 0, 1080, 2400], pkg: "com.android.chrome", root: { c: "android.widget.FrameLayout", b: [0, 132, 1080, 2337], f: 16 | 32 | 1024 | 4096, d: "Web View" } }],
    });
    const answer = parseServerTree(line);
    assert.ok(answer.ok);
    const page = androidElements(answer.screen, UPRIGHT, () => "Chrome").elements[0]!.children[0]!;
    assert.equal(page.role, "web view");
    assert.equal(page.value, PAGE_NOT_SHOWN_WORDS);
  });

  test("refuses a dump with no tree, in its own words", () => {
    assert.throws(
      () => parseDump("ERROR: could not get idle state.\n"),
      (error: unknown) => error instanceof DriverError && /uiautomator gave no tree: ERROR: could not get idle state\./.test(error.message),
    );
  });

  test("turns the display's pixels into the picture's, whichever way Android draws and the device is held", () => {
    const same = placement({ rotation: 0, display: { width: 1080, height: 2400 } }, UPRIGHT);
    assert.deepEqual(pictureFrame([10, 20, 110, 70], same), { x: 10, y: 20, width: 100, height: 50 });
    const sideways = placement({ rotation: 1, display: { width: 2400, height: 1080 } }, { video: { width: 2400, height: 1080 }, physical: "turned-left" });
    assert.deepEqual(pictureFrame([10, 20, 110, 70], sideways), { x: 10, y: 20, width: 100, height: 50 });
    const upsideDown = placement({ rotation: 1, display: { width: 2400, height: 1080 } }, { video: { width: 1080, height: 2400 }, physical: "upside-down" });
    assert.deepEqual(pictureFrame([0, 0, 100, 50], upsideDown), { x: 0, y: 2300, width: 50, height: 100 });
    const dumpUpsideDown = placement({ rotation: 1, display: null }, { video: { width: 1080, height: 2400 }, physical: "upside-down" });
    assert.deepEqual(pictureFrame([0, 0, 100, 50], dumpUpsideDown), { x: 0, y: 2300, width: 50, height: 100 });
  });

  test("places what a list hides beyond the screen on the side the list hides it", () => {
    const screen = { width: 1080, height: 2400 };
    const list = { x: 0, y: 774, width: 1080, height: 1563 };
    assert.deepEqual(placedOffScreen({ x: 0, y: 2337, width: 1080, height: 54 }, list, screen), { x: 0, y: 2400, width: 1080, height: 54 });
    assert.deepEqual(placedOffScreen({ x: 0, y: 700, width: 1080, height: 74 }, list, screen), { x: 0, y: -74, width: 1080, height: 74 });
    const row = { x: 0, y: 900, width: 1080, height: 300 };
    assert.deepEqual(placedOffScreen({ x: 1080, y: 950, width: 200, height: 200 }, row, screen), { x: 1080, y: 950, width: 200, height: 200 });
    assert.equal(placedOffScreen({ x: 100, y: 1000, width: 100, height: 100 }, list, screen), null, "hidden within the list: left out");
  });
});

class FakeChannel implements TreeChannel {
  readonly sent: string[] = [];
  #line: (line: string) => void = () => undefined;
  #exit: (words: string) => void = () => undefined;
  answers: ((request: string) => string | null)[] = [];
  closed = false;

  readonly #hello: string;

  constructor(hello = '{"ok":true,"hello":1}') {
    this.#hello = hello;
  }

  send(line: string): void {
    this.sent.push(line);
    const answer = this.answers.shift()?.(line) ?? null;
    if (answer !== null) queueMicrotask(() => this.#line(answer));
  }

  onLine(listener: (line: string) => void): void {
    this.#line = listener;
    queueMicrotask(() => listener(this.#hello));
  }

  onExit(listener: (words: string) => void): void {
    this.#exit = listener;
  }

  exit(words: string): void {
    this.#exit(words);
  }

  close(): void {
    this.closed = true;
  }
}

function source(overrides: Partial<AndroidTreeOptions> & { channels?: FakeChannel[]; dump?: string; present?: boolean } = {}) {
  const ran: string[][] = [];
  const shells: string[] = [];
  const logs: string[] = [];
  const spawned: string[] = [];
  let now = 0;
  const channels = overrides.channels ?? [];
  const tree = new AndroidTreeSource({
    adbRun: async (args) => {
      ran.push([...args]);
      if (args[0] === "exec-out") return { code: 0, output: overrides.dump ?? text("android-dump-settings.xml") };
      return { code: 0, output: "1 file pushed" };
    },
    shell: async (command) => {
      shells.push(command);
      if (command.startsWith("cmd package query-activities")) return "2 activities found:\n  Activity #0:\n    com.android.settings/.Settings\n  Activity #1:\n    com.android.chrome/com.google.android.apps.chrome.Main\n";
      return overrides.present === false && shells.filter((each) => each.includes("echo present")).length === 1 ? "missing\n" : "present\n";
    },
    spawnServer: (command) => {
      spawned.push(command);
      const channel = channels.shift();
      if (!channel) throw new Error("no more channels");
      return channel;
    },
    log: (line) => logs.push(line),
    now: () => now,
    ...overrides,
  });
  return { tree, ran, shells, logs, spawned, advance: (ms: number) => (now += ms) };
}

const TREE_LINE = text("android-tree-settings.json").trim();

describe("where an Android tree comes from (063, 7.3)", () => {
  test("starts BB Box's tree server from its dex on the device, and reads through it", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => TREE_LINE);
    const { tree, spawned, ran } = source({ channels: [channel] });
    const read = await tree.read();
    assert.equal(read.screen.source, "server");
    assert.equal(tree.lastVia, "server");
    const digest = createHash("sha256").update(readFileSync(TREE_SERVER_DEX)).digest("hex").slice(0, 16);
    assert.deepEqual(spawned, [`CLASSPATH=/data/local/tmp/bb-box-tree-${digest}.dex exec app_process / TreeServer 30000`]);
    assert.deepEqual(ran, [], "the dex was there already, and nothing was dumped");
  });

  test("copies its dex to the device when the device has not got this one", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => TREE_LINE);
    const { tree, ran, shells } = source({ channels: [channel], present: false });
    await tree.read();
    assert.match(shells[0]!, /rm -f \/data\/local\/tmp\/bb-box-tree-\*\.dex; echo missing/);
    assert.equal(ran[0]?.[0], "push");
    assert.equal(ran[0]?.[1], TREE_SERVER_DEX);
  });

  test("gives way to an instrumentation test: the read is refused in words, and nothing is dumped, as a dump could crash the test", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => JSON.stringify({ ok: false, code: "instrumentation", words: "BB Box's tree server gives way to an instrumentation running on the device." }));
    channel.answers.push(() => TREE_LINE);
    const { tree, ran, logs } = source({ channels: [channel] });
    await assert.rejects(tree.read(), (error: unknown) => error instanceof DriverError && error.code === "held-elsewhere" && error.message === instrumentationWords());
    assert.deepEqual(ran, []);
    assert.ok(logs.some((line) => /gives way \(instrumentation\)/.test(line)));
    assert.equal((await tree.read()).screen.source, "server", "it reads again as soon as the test has ended");
    assert.ok(logs.some((line) => /reads again/.test(line)));
  });

  test("says when something else holds UiAutomation", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => JSON.stringify({ ok: false, code: "held-elsewhere", words: "UiAutomationService already registered!" }));
    const { tree } = source({ channels: [channel] });
    await assert.rejects(tree.read(), (error: unknown) => error instanceof DriverError && error.message === heldElsewhereWords());
  });

  test("falls back to the dump when the server fails, and tries the server again later", async () => {
    const dead = new FakeChannel();
    dead.answers.push(() => {
      queueMicrotask(() => dead.exit("it ended with SIGKILL"));
      return null;
    });
    const fresh = new FakeChannel();
    fresh.answers.push(() => TREE_LINE);
    const { tree, ran, logs, spawned, advance } = source({ channels: [dead, fresh] });
    const first = await tree.read();
    assert.equal(first.screen.source, "dump");
    assert.deepEqual(ran.at(-1), ["exec-out", "uiautomator", "dump", "/dev/tty"]);
    assert.ok(logs.some((line) => /tree server failed, so uiautomator dump reads for the next 30 s: BB Box's tree server stopped: it ended with SIGKILL/.test(line)));
    assert.equal((await tree.read()).screen.source, "dump", "within the retry window, the dump reads");
    assert.equal(spawned.length, 1);
    advance(TREE_SERVER_RETRY_MS);
    assert.equal((await tree.read()).screen.source, "server");
    assert.equal(spawned.length, 2);
  });

  test("falls back to the dump when the server never says hello", async () => {
    const { tree } = source({ channels: [new FakeChannel("Exception in thread main")] });
    assert.equal((await tree.read()).screen.source, "dump");
  });

  test("the dump alone, as asked", async () => {
    const { tree, spawned } = source({ onlyDump: true });
    assert.equal((await tree.read()).screen.source, "dump");
    assert.deepEqual(spawned, []);
  });

  test("a dump refused because something holds UiAutomation says so", async () => {
    const { tree } = source({ onlyDump: true, dump: "Killed \n" });
    await assert.rejects(tree.read(), (error: unknown) => error instanceof DriverError && error.message === heldElsewhereWords());
  });

  test("lists the launcher's apps with their labels from the server, or by package from the package manager", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => JSON.stringify({ ok: true, apps: [{ pkg: "com.android.settings", activity: "com.android.settings.Settings", label: "Settings", system: true }], ms: 50 }));
    const { tree } = source({ channels: [channel] });
    assert.deepEqual(await tree.apps(), [{ pkg: "com.android.settings", activity: "com.android.settings.Settings", label: "Settings", system: true }]);
    assert.equal(tree.labelOf("com.android.settings"), "Settings");
    const plain = source({ onlyDump: true }).tree;
    assert.deepEqual(await plain.apps(), [
      { pkg: "com.android.settings", activity: "com.android.settings.Settings", label: null, system: false },
      { pkg: "com.android.chrome", activity: "com.google.android.apps.chrome.Main", label: null, system: false },
    ]);
  });

  test("pastes into the focused text field through the tree server, which Chrome's pages take where the Paste key reads a stale clipboard (F-18)", async () => {
    const channel = new FakeChannel();
    channel.answers.push(() => JSON.stringify({ ok: true, pasted: true, field: "android.widget.EditText", ms: 48 }));
    channel.answers.push(() => JSON.stringify({ ok: true, pasted: false, field: null, ms: 12 }));
    const { tree, logs } = source({ channels: [channel] });
    assert.equal(await tree.pasteIntoFocusedField(), true);
    assert.equal(await tree.pasteIntoFocusedField(), false, "no focused text field: the caller presses the Paste key");
    assert.deepEqual(channel.sent, ["paste", "paste"]);
    assert.deepEqual(logs.filter((line) => line.startsWith("paste:")), []);
  });

  test("a paste the tree server cannot make leaves it to the Paste key, with the reason logged (F-18)", async () => {
    const held = new FakeChannel();
    held.answers.push(() => JSON.stringify({ ok: false, code: "instrumentation", words: "BB Box's tree server gives way to an instrumentation running on the device." }));
    const first = source({ channels: [held] });
    assert.equal(await first.tree.pasteIntoFocusedField(), false);
    assert.ok(first.logs.some((line) => /^paste: the tree server did not paste, so the Paste key goes: BB Box's tree server gives way/.test(line)));

    const silent = source({ channels: [new FakeChannel("Exception in thread main")] });
    assert.equal(await silent.tree.pasteIntoFocusedField(), false);
    assert.ok(silent.logs.some((line) => /^paste: the tree server did not answer, so the Paste key goes/.test(line)));

    const dumpOnly = source({ onlyDump: true });
    assert.equal(await dumpOnly.tree.pasteIntoFocusedField(), false);
    assert.deepEqual(dumpOnly.spawned, []);
  });

  test("finds an app by its package, its label, or its package's last word", () => {
    const apps: LauncherApp[] = [
      { pkg: "com.android.settings", activity: "com.android.settings.Settings", label: "Settings", system: true },
      { pkg: "com.android.chrome", activity: "com.google.android.apps.chrome.Main", label: "Chrome", system: true },
      { pkg: "com.google.android.calendar", activity: "com.android.calendar.AllInOneActivity", label: null, system: true },
    ];
    assert.equal(appFor(apps, "com.android.chrome")?.label, "Chrome");
    assert.equal(appFor(apps, "settings")?.pkg, "com.android.settings");
    assert.equal(appFor(apps, "Calendar")?.pkg, "com.google.android.calendar");
    assert.equal(appFor(apps, "Maps"), null);
  });

  test("its dex is the one built from its source", () => {
    const record = JSON.parse(text("../../setup/android/tree-server/tree-server.json")) as { source: string; dex: string };
    const sha = (path: URL | string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(sha(new URL("../setup/android/tree-server/TreeServer.java", import.meta.url)), record.source, "TreeServer.java changed: build the dex again with setup/android/build-tree-server.sh");
    assert.equal(sha(TREE_SERVER_DEX), record.dex, "src/device/tree-server.dex is not the one its record names");
  });
});
