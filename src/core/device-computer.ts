import type { BoxRecord } from "./boxes.ts";
import { isSecureRole, withSecureValuesHidden } from "./secure-fields.ts";
import { ComputerError, IMAGE_MAX_EDGE, TREE_LIMIT, chord, pngSize, type ActInput, type ComputerResult, type Direction, type TypeInput, type WindowRef } from "./computer.ts";
import {
  KEYBOARD_KEY_ROLE,
  PERSON_HAS_CONTROL_WORDS,
  orientationWord,
  type DeviceAgentRequest,
  type DeviceAnswer,
  type DeviceElement,
  type DeviceErrorCode,
  type DeviceInput,
  type DevicePlatform,
  type DeviceRead,
  type DeviceState,
  type ElementFrame,
  type KeyModifier,
  type Point,
  type VideoSize,
} from "./device.ts";
import { changesShowAtStart } from "./device-settings.ts";
import { PRODUCT } from "../brand.ts";

export const DEVICE_WINDOW = 1;
export const DEVICE_SETTLE = { quietMs: 300, mostMs: 2_000, fromNow: true } as const;
export const SCROLL_STEP_SETTLE = { quietMs: 150, mostMs: 1_000, fromNow: true } as const;
export const READ_SETTLE = { quietMs: 300, mostMs: 1_000, fromNow: false } as const;
export const DOUBLE_TAP_GAP_MS = 120;
export const LONG_PRESS_MS = 1_200;
export const SCROLL_STEP_FRACTION = 1 / 5;
export const SCROLL_BAND_FRACTION = 0.8;
export const SCROLL_SWIPE_MS = 250;
export const DRAG_MS = 600;
const SCROLLER_LEAST_FRACTION = 1 / 3;
export const TYPED_WAIT_MS = 5_000;
const TYPED_STILL_READS = 3;
export const APP_WAIT = { everyMs: 250, mostMs: 5_000 } as const;
export const KEYBOARD_WAIT = { everyMs: 250, mostMs: 5_000 } as const;
export const KEYBOARD_NEVER_CAME_WORDS = `No text field had the focus with its keyboard shown within ${KEYBOARD_WAIT.mostMs / 1000} s of the tap, so ${PRODUCT} typed anyway, and the first keys may be lost: check what the field reads.`;
const STATUS_BAR_FRACTION = 0.08;
const SETTINGS_APP = "Settings";
const SWITCH_REF = /^[+-] \[(e\d+)\] switch /;
export const SETTING_SHOWN_AT_START_WORDS =
  "On this shared box, iOS shows a change to a system setting, such as Dark or Bold Text, only at the device's start: call box_device with action reboot to see it, which closes open apps. A dedicated box shows such a change at once.";
const CHANGES_MOST_LINES = 60;
const REFS_MOST = 20_000;

export type DeviceAction = ActInput["action"] | "drag";

export interface DeviceActInput extends Omit<ActInput, "action"> {
  readonly action: DeviceAction;
  readonly toX?: number;
  readonly toY?: number;
}

export interface DeviceComputerDeps {
  read(box: BoxRecord, request: DeviceRead): Promise<DeviceAnswer>;
  input(box: BoxRecord, input: DeviceInput): Promise<DeviceAnswer>;
  agentRequest(box: BoxRecord, request: DeviceAgentRequest): Promise<DeviceAnswer>;
  personHasControl(boxId: string): boolean;
  takeBack(boxId: string): Promise<boolean>;
  sleep?(ms: number, signal?: AbortSignal): Promise<void>;
}

interface Shown {
  readonly ref: string;
  readonly element: DeviceElement;
  readonly depth: number;
  readonly parent: Shown | null;
  readonly key: string;
  readonly ordinal: number;
  count: number;
}

interface Snapshot {
  readonly model: string;
  readonly platform: DevicePlatform;
  readonly generation: number;
  readonly screen: VideoSize;
  readonly orientation: string;
  readonly app: string;
  readonly starting: boolean;
  readonly changesShowAtStart?: boolean;
  readonly shown: readonly Shown[];
  readonly byRef: ReadonlyMap<string, Shown>;
}

interface Remembered {
  readonly key: string;
  readonly identifier: string | null;
  readonly role: string;
  readonly label: string;
  readonly ordinal: number;
  readonly count: number;
  readonly frame: ElementFrame;
  readonly generation: number;
  readonly words: string;
}

interface HeldImage {
  readonly width: number;
  readonly height: number;
  readonly source: VideoSize;
  readonly generation: number;
}

interface BoxState {
  queue: Promise<unknown>;
  snapshot: Snapshot | null;
  image: HeldImage | null;
  readonly refs: Map<string, Remembered>;
  nextRef: number;
}

type Found = { readonly is: "found"; readonly shown: Shown } | { readonly is: "ambiguous"; readonly matches: readonly Shown[] } | { readonly is: "gone" };

const MODIFIERS: Readonly<Record<string, KeyModifier>> = {
  ctrl: "control",
  control: "control",
  shift: "shift",
  alt: "alt",
  option: "alt",
  opt: "alt",
  cmd: "meta",
  command: "meta",
  meta: "meta",
  super: "meta",
  win: "meta",
};

const KEY_NAMES: Readonly<Record<string, string>> = {
  return: "Enter",
  enter: "Enter",
  esc: "Escape",
  escape: "Escape",
  backspace: "Backspace",
  delete: "Delete",
  del: "Delete",
  tab: "Tab",
  space: " ",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
  arrowup: "ArrowUp",
  arrowdown: "ArrowDown",
  arrowleft: "ArrowLeft",
  arrowright: "ArrowRight",
  home: "Home",
  end: "End",
  pageup: "PageUp",
  pagedown: "PageDown",
  capslock: "CapsLock",
};

export function deviceKey(keys: string): { readonly key: string; readonly modifiers: readonly KeyModifier[] } {
  const parsed = chord(keys);
  const modifiers = parsed.modifiers.map((name) => {
    const modifier = MODIFIERS[name];
    if (!modifier) throw new ComputerError("input", `"${name}" is not a modifier key.`, "Use ctrl, shift, alt or cmd, such as cmd+a.");
    return modifier;
  });
  const lower = parsed.key.toLowerCase();
  const key = KEY_NAMES[lower] ?? (/^f([1-9]|1[0-2])$/.test(lower) ? lower.toUpperCase() : parsed.key);
  return { key, modifiers: [...new Set(modifiers)] };
}

function quoted(text: string): string {
  return JSON.stringify(text.replace(/\s+/g, " "));
}

function elementWords(element: DeviceElement): string {
  if (element.label) return `${element.role} ${quoted(element.label)}`;
  if (element.identifier) return `${element.role} (id ${element.identifier})`;
  if (element.value) return `${element.role} ${quoted(element.value)}`;
  return element.role;
}

function keyOf(element: DeviceElement): string {
  return JSON.stringify([element.identifier, element.role, element.label]);
}

function visiblePart(frame: ElementFrame, screen: VideoSize): ElementFrame | null {
  const left = Math.max(0, frame.x);
  const top = Math.max(0, frame.y);
  const right = Math.min(screen.width, frame.x + frame.width);
  const bottom = Math.min(screen.height, frame.y + frame.height);
  return right > left && bottom > top ? { x: left, y: top, width: right - left, height: bottom - top } : null;
}

function whereOff(frame: ElementFrame, screen: VideoSize): string | null {
  if (visiblePart(frame, screen)) return null;
  if (frame.y >= screen.height) return "below the screen";
  if (frame.y + frame.height <= 0) return "above the screen";
  if (frame.x >= screen.width) return "right of the screen";
  return "left of the screen";
}

function centre(frame: ElementFrame): { readonly x: number; readonly y: number } {
  return { x: Math.round(frame.x + frame.width / 2), y: Math.round(frame.y + frame.height / 2) };
}

function contains(frame: ElementFrame, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height;
}

function lineOf(shown: Shown, screen: VideoSize): string {
  const { element } = shown;
  const parts = [`${"  ".repeat(shown.depth)}- [${shown.ref}] ${element.role}`];
  if (element.label) parts.push(` ${quoted(element.label)}`);
  if (element.identifier) parts.push(` (id ${element.identifier})`);
  if (element.value !== null && element.value !== element.label) parts.push(` = ${quoted(element.value)}`);
  const notes: string[] = [];
  if (!element.enabled) notes.push("disabled");
  if (element.focused) notes.push("focused");
  if (element.can?.edit) notes.push("editable");
  if (element.can?.scroll) notes.push("scrolls");
  const off = whereOff(element.frame, screen);
  if (off) notes.push(off);
  if (notes.length) parts.push(`, ${notes.join(", ")}`);
  return parts.join("");
}

function signature(snapshot: Snapshot): string {
  return JSON.stringify(snapshot.shown.map((shown) => [shown.key, shown.element.value, shown.element.frame]));
}

function failure(answer: Extract<DeviceAnswer, { ok: false }>, what: string): ComputerError {
  const words = answer.error.words;
  const hints: Partial<Record<DeviceErrorCode, readonly [ConstructorParameters<typeof ComputerError>[0], string]>> = {
    "person-has-control": ["paused", "Leave the device alone until the person hands control back, or until they ask you to continue: then call computer_take_control."],
    "stale-geometry": ["stale", "Call computer_screenshot or computer_observe again, and act on what it gives."],
    "not-booted": ["driver", "Call box_status to see when the device has booted."],
    busy: ["driver", "Call box_status, and try again once it says the device has booted."],
    "bad-value": ["input", "Change what you gave, as the words say."],
    unsupported: ["unsupported", "Use box_run in the box instead."],
    superseded: ["driver", `Try again in a few seconds: another ${PRODUCT} instance holds the box's device server.`],
    "held-elsewhere": ["refused", "Use computer_screenshot until it ends, then read the elements again."],
  };
  const [code, hint] = hints[answer.error.code] ?? (["driver", "Call box_status to see the device's state, then try again."] as const);
  return new ComputerError(code, answer.error.code === "person-has-control" ? PERSON_HAS_CONTROL_WORDS : `${what}: ${words}`, hint);
}

export class DeviceComputer {
  readonly #deps: DeviceComputerDeps;
  readonly #boxes = new Map<string, BoxState>();

  constructor(deps: DeviceComputerDeps) {
    this.#deps = deps;
  }

  forget(boxId: string): void {
    this.#boxes.delete(boxId);
  }

  #state(boxId: string): BoxState {
    let state = this.#boxes.get(boxId);
    if (!state) {
      state = { queue: Promise.resolve(), snapshot: null, image: null, refs: new Map(), nextRef: 1 };
      this.#boxes.set(boxId, state);
    }
    return state;
  }

  #run<T>(box: BoxRecord, work: (state: BoxState) => Promise<T>): Promise<T> {
    const state = this.#state(box.id);
    const run = state.queue.then(
      () => work(state),
      () => work(state),
    );
    state.queue = run.catch(() => undefined);
    return run;
  }

  #sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (this.#deps.sleep) return this.#deps.sleep(ms, signal);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #window(window: WindowRef | undefined): void {
    if (window === undefined || window === "desktop" || window === DEVICE_WINDOW) return;
    throw new ComputerError("stale", `A device box has one window, ${DEVICE_WINDOW}, the device's screen: there is no window ${window}.`, `Give window ${DEVICE_WINDOW}, or leave window out.`);
  }

  #gate(box: BoxRecord): void {
    if (this.#deps.personHasControl(box.id)) {
      throw new ComputerError("paused", PERSON_HAS_CONTROL_WORDS, "Leave the device alone until the person hands control back, or until they ask you to continue: then call computer_take_control.");
    }
  }

  async #ok(answer: Promise<DeviceAnswer>, what: string): Promise<Extract<DeviceAnswer, { ok: true }>> {
    const said = await answer;
    if (!said.ok) throw failure(said, what);
    return said;
  }

  #screen(state: DeviceState): { readonly screen: VideoSize; readonly generation: number; readonly orientation: string } {
    if (state.power.is !== "booted" || !state.geometry) {
      throw new ComputerError("driver", `The ${state.model} is not showing a screen yet: it is ${state.power.is}.`, "Call box_status to see when the device has booted.");
    }
    return { screen: state.geometry.video, generation: state.geometry.generation, orientation: orientationWord(state.geometry.content) };
  }

  async #read(box: BoxRecord, state: BoxState, until: (snapshot: Snapshot) => boolean = drawn): Promise<Snapshot> {
    const began = performance.now();
    for (;;) {
      const late = () => performance.now() - began >= APP_WAIT.mostMs;
      let snapshot: Snapshot;
      try {
        snapshot = await this.#readOnce(box, state);
      } catch (error) {
        if (!(error instanceof ComputerError) || error.code !== "driver" || late()) throw error;
        await this.#sleep(APP_WAIT.everyMs);
        continue;
      }
      if (until(snapshot) || late()) return snapshot;
      await this.#sleep(APP_WAIT.everyMs);
    }
  }

  async #readOnce(box: BoxRecord, state: BoxState): Promise<Snapshot> {
    const answer = await this.#ok(this.#deps.read(box, { type: "tree" }), `${PRODUCT} could not read the device's elements`);
    if (answer.result.type !== "tree") throw new ComputerError("driver", "The device server answered a read of its elements with something else.", "Try again.");
    const { screen, orientation } = this.#screen(answer.state);
    const elements = answer.result.elements.map(withSecureValuesHidden);
    const snapshot = this.#snapshot(state, answer.state.model, answer.state.platform, answer.result.generation, screen, orientation, elements);
    return changesShowAtStart(answer.state) ? { ...snapshot, changesShowAtStart: true } : snapshot;
  }

  #snapshot(state: BoxState, model: string, platform: DevicePlatform, generation: number, screen: VideoSize, orientation: string, roots: readonly DeviceElement[]): Snapshot {
    const flat: { element: DeviceElement; depth: number; parent: number | null }[] = [];
    const walk = (element: DeviceElement, depth: number, parent: number | null) => {
      const index = flat.length;
      flat.push({ element, depth, parent });
      for (const child of element.children) walk(child, depth + 1, index);
    };
    for (const root of roots) walk(root, 0, null);
    const counts = new Map<string, number>();
    const keys = flat.map(({ element }) => keyOf(element));
    const ordinals = keys.map((key) => {
      const seen = counts.get(key) ?? 0;
      counts.set(key, seen + 1);
      return seen;
    });
    const previous = state.snapshot;
    const sameScreen = previous?.generation === generation;
    const draft = flat.map(({ element }, index) => ({ element, key: keys[index]!, ordinal: ordinals[index]!, count: counts.get(keys[index]!)! }));
    const refs = new Array<string | null>(flat.length).fill(null);
    if (sameScreen) {
      const taken = new Set<string>();
      for (const old of previous.shown) {
        const found = matchIn(rememberedOf(old, generation), draft);
        if (found.is !== "found" || taken.has(old.ref) || refs[found.index] !== null) continue;
        refs[found.index] = old.ref;
        taken.add(old.ref);
      }
    }
    const shown: Shown[] = [];
    const byRef = new Map<string, Shown>();
    flat.forEach(({ element, depth, parent }, index) => {
      const ref = refs[index] ?? `e${state.nextRef++}`;
      const entry: Shown = { ref, element, depth, parent: parent === null ? null : shown[parent]!, key: draft[index]!.key, ordinal: draft[index]!.ordinal, count: draft[index]!.count };
      shown.push(entry);
      byRef.set(ref, entry);
      state.refs.delete(ref);
      state.refs.set(ref, rememberedOf(entry, generation));
    });
    for (const ref of state.refs.keys()) {
      if (state.refs.size <= REFS_MOST) break;
      state.refs.delete(ref);
    }
    const app = roots[0]?.label || "";
    const starting = roots[0]?.role === "application" && roots[0].children.length === 0;
    const snapshot: Snapshot = { model, platform, generation, screen, orientation, app, starting, shown, byRef };
    state.snapshot = snapshot;
    return snapshot;
  }

  #name(snapshot: Snapshot): string {
    return `${snapshot.model} (device)`;
  }

  #found(state: BoxState, snapshot: Snapshot, ref: string): Shown {
    const remembered = state.refs.get(ref);
    const direct = snapshot.byRef.get(ref);
    if (direct && remembered?.generation === snapshot.generation) return direct;
    if (!remembered) throw new ComputerError("stale", `There is no element ${ref}: references come from computer_observe on this box.`, `Call computer_observe with window ${DEVICE_WINDOW}.`);
    if (remembered.generation !== snapshot.generation) {
      throw new ComputerError("stale", `The device turned or changed since you read ${ref}, ${remembered.words}, so its reference is void.`, `Call computer_observe with window ${DEVICE_WINDOW} again.`);
    }
    const found = matchIn(remembered, snapshot.shown.map((shown) => ({ element: shown.element, key: shown.key, ordinal: shown.ordinal, count: shown.count })));
    if (found.is === "found") return snapshot.shown[found.index]!;
    if (found.is === "ambiguous") {
      const named = found.indices.map((index) => snapshot.shown[index]!).map((shown) => `${shown.ref} at ${centre(shown.element.frame).x},${centre(shown.element.frame).y}`);
      throw new ComputerError("refused", `${ref}, ${remembered.words}, is ambiguous now: ${named.length} elements match it (${named.join(", ")}), and ${PRODUCT} cannot tell which was yours.`, `Act on one of them by its new reference, or call computer_observe with window ${DEVICE_WINDOW}.`);
    }
    throw new ComputerError("stale", `${ref}, ${remembered.words}, is no longer on the device's screen.`, `Call computer_observe with window ${DEVICE_WINDOW} to see what is there now.`);
  }

  #tree(snapshot: Snapshot, query: string | undefined, limit: number): string {
    const lines = snapshot.shown.map((shown) => lineOf(shown, snapshot.screen));
    let chosen = snapshot.shown.map((_shown, index) => index);
    if (query) {
      const wanted = query.toLowerCase();
      const keep = new Set<number>();
      snapshot.shown.forEach((shown, index) => {
        if (!lines[index]!.toLowerCase().includes(wanted)) return;
        for (let at: Shown | null = shown; at; at = at.parent) keep.add(snapshot.shown.indexOf(at));
      });
      chosen = chosen.filter((index) => keep.has(index));
      if (!chosen.length) return `No element matches ${quoted(query)}.`;
    }
    const shownLines = chosen.slice(0, limit).map((index) => lines[index]!);
    const more = chosen.length - shownLines.length;
    if (more > 0) shownLines.push(`... ${more} more line${more === 1 ? "" : "s"}: pass a larger limit, or a query.`);
    return shownLines.join("\n");
  }

  #heading(snapshot: Snapshot): string {
    const front = `${frontWords(snapshot)} in front`;
    return `Window ${DEVICE_WINDOW}: ${this.#name(snapshot)}, ${front}, ${snapshot.screen.width}x${snapshot.screen.height} pixels, ${snapshot.orientation}.`;
  }

  async windows(box: BoxRecord, _signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, async (state) => {
      await this.#settled(box, READ_SETTLE);
      const snapshot = await this.#read(box, state);
      return {
        text: `${this.#heading(snapshot)} A device box has this one window: the device's screen. An alert, such as one asking to allow something, shows inside it.`,
        hints: [`Call computer_observe with window ${DEVICE_WINDOW} to read it.`],
      };
    });
  }

  async observe(box: BoxRecord, input: { readonly window: number; readonly query?: string; readonly limit?: number; readonly screenshot?: boolean }, _signal?: AbortSignal): Promise<ComputerResult> {
    this.#window(input.window);
    return this.#run(box, async (state) => {
      await this.#settled(box, READ_SETTLE);
      const snapshot = await this.#read(box, state);
      const text = `${this.#heading(snapshot)}\n${this.#tree(snapshot, input.query, input.limit ?? TREE_LIMIT)}`;
      const hints = ["Act on an element with computer_act or computer_type by its reference, such as e12. Elements off the screen need a scroll first."];
      if (!input.screenshot) return { text, hints };
      const image = await this.#image(box, state);
      return { text: `${text}\n\n${image.words}`, image: image.image, hints };
    });
  }

  async #image(box: BoxRecord, state: BoxState): Promise<{ readonly words: string; readonly image: { readonly data: string; readonly mimeType: string } }> {
    const answer = await this.#ok(this.#deps.read(box, { type: "screenshot", longestEdge: IMAGE_MAX_EDGE }), `${PRODUCT} could not take the device's screenshot`);
    if (answer.result.type !== "screenshot") throw new ComputerError("driver", "The device server answered a screenshot with something else.", "Try again.");
    const size = pngSize(answer.result.png);
    if (!size) throw new ComputerError("driver", "The device server's screenshot is not a PNG.", "Try again.");
    const source = answer.result.source ?? size;
    state.image = { width: size.width, height: size.height, source, generation: answer.result.generation };
    const scale = Math.round((size.width / source.width) * 1000) / 1000;
    return {
      words: `Image ${size.width}x${size.height} of the device's screen ${source.width}x${source.height}, scale ${scale}; x and y are image pixels.`,
      image: { data: answer.result.png, mimeType: "image/png" },
    };
  }

  async screenshot(box: BoxRecord, window: WindowRef, _signal?: AbortSignal): Promise<ComputerResult> {
    this.#window(window);
    return this.#run(box, async (state) => {
      const image = await this.#image(box, state);
      return {
        text: `Window ${DEVICE_WINDOW}, the device's screen. ${image.words}`,
        image: image.image,
        hints: ["Prefer references from computer_observe: they do not depend on where things are drawn."],
      };
    });
  }

  #pixelPoint(state: BoxState, x: number, y: number): Point {
    const image = state.image;
    if (!image) throw new ComputerError("input", "x and y are pixels of your latest image of the device, and there is none yet.", `Call computer_screenshot with window ${DEVICE_WINDOW} first, or act on a reference.`);
    if (x >= image.width || y >= image.height) throw new ComputerError("input", `${x},${y} is outside your latest image of the device, ${image.width}x${image.height}.`, "Give a point inside it.");
    return { x: Math.round(((x + 0.5) * image.source.width) / image.width), y: Math.round(((y + 0.5) * image.source.height) / image.height), generation: image.generation };
  }

  async #target(box: BoxRecord, state: BoxState, input: { readonly ref?: string; readonly x?: number; readonly y?: number }, what: string, tapping = true): Promise<{ readonly before: Snapshot; readonly shown: Shown | null; readonly point: Point; readonly words: string }> {
    const before = await this.#read(box, state);
    if (input.ref !== undefined) {
      if (input.x !== undefined || input.y !== undefined) throw new ComputerError("input", `${what} takes ref, or x and y, not both.`, "Give one of them.");
      const shown = this.#found(state, before, input.ref);
      const words = `${shown.ref}, ${elementWords(shown.element)}`;
      if (!tapping) return { before, shown, point: { ...centre(shown.element.frame), generation: before.generation }, words };
      const visible = visiblePart(shown.element.frame, before.screen);
      if (!visible) {
        const off = whereOff(shown.element.frame, before.screen)!;
        const direction = off.startsWith("below") ? "down" : off.startsWith("above") ? "up" : off.startsWith("right") ? "right" : "left";
        throw new ComputerError("input", `${shown.ref}, ${elementWords(shown.element)}, is ${off}.`, `Scroll ${direction} to it first with computer_act's scroll, then observe again.`);
      }
      const point = await this.#uncovered(box, shown, visible, before.screen);
      return { before, shown, point: { ...point, generation: before.generation }, words };
    }
    if (input.x === undefined || input.y === undefined) throw new ComputerError("input", `${what} needs ref, or x and y.`, `Give a reference from computer_observe, or pixels of your latest computer_screenshot.`);
    const point = this.#pixelPoint(state, input.x, input.y);
    const at = deepestAt(before, point);
    return { before, shown: at, point, words: `${input.x},${input.y}${at ? ` (${elementWords(at.element)})` : ""}` };
  }

  async #uncovered(box: BoxRecord, shown: Shown, visible: ElementFrame, screen: VideoSize): Promise<{ readonly x: number; readonly y: number }> {
    let covering: DeviceElement | null = null;
    for (const point of tapPoints(visible)) {
      const answer = await this.#deps.read(box, { type: "at", ...point });
      if (!answer.ok || answer.result.type !== "at") return centre(visible);
      const found = answer.result.element && withSecureValuesHidden(answer.result.element);
      if (!found || isPartOf(found, shown.element)) return point;
      covering ??= found;
    }
    const by = covering ? elementWords(covering) : "something else";
    const upper = shown.element.frame.y + shown.element.frame.height / 2 < screen.height / 2;
    throw new ComputerError("input", `${shown.ref}, ${elementWords(shown.element)}, is covered by ${by} where it is now, so a tap would reach that instead.`, `Scroll ${upper ? "up" : "down"} with computer_act's scroll to bring it clear, then observe again, or tap what you can see with x and y from computer_screenshot.`);
  }

  async #frames(box: BoxRecord): Promise<number> {
    const answer = await this.#ok(this.#deps.read(box, { type: "settle", quietMs: 0, mostMs: 0, fromNow: false }), `${PRODUCT} could not read the device's frames`);
    return answer.result.type === "settled" ? answer.result.frames : 0;
  }

  async #settled(box: BoxRecord, settle: { readonly quietMs: number; readonly mostMs: number; readonly fromNow: boolean } = DEVICE_SETTLE): Promise<{ readonly frames: number; readonly quiet: boolean }> {
    const answer = await this.#ok(this.#deps.read(box, { type: "settle", ...settle }), `${PRODUCT} could not wait for the device's screen`);
    return answer.result.type === "settled" ? answer.result : { frames: 0, quiet: true };
  }

  async #send(box: BoxRecord, input: DeviceInput, what: string): Promise<void> {
    await this.#ok(this.#deps.input(box, input), what);
  }

  async #after(box: BoxRecord, state: BoxState, before: Snapshot, framesBefore: number): Promise<{ readonly parts: string[]; readonly after: Snapshot }> {
    const settled = await this.#settled(box);
    const after = await this.#read(box, state);
    const parts: string[] = [];
    if (!settled.quiet) parts.push(`The screen was still changing ${DEVICE_SETTLE.mostMs / 1000} s after.`);
    if (after.generation !== before.generation) {
      parts.push(`The device's screen changed shape: now ${after.screen.width}x${after.screen.height}, ${after.orientation}. Earlier references and images are void.`);
      return { parts, after };
    }
    if (after.app !== before.app) parts.push(`Now in front: ${frontWords(after)}.`);
    const was = new Set(before.shown.map((shown) => lineOf({ ...shown, depth: 0 }, before.screen)));
    const now = after.shown.map((shown) => lineOf({ ...shown, depth: 0 }, after.screen));
    const nowSet = new Set(now);
    const added = now.filter((line) => !was.has(line)).map((line) => `+ ${line.replace(/^- /, "")}`);
    const removed = [...was].filter((line) => !nowSet.has(line)).map((line) => `- ${line.replace(/^- /, "")}`);
    const changes = [...removed, ...added];
    if (after.changesShowAtStart && after.app === SETTINGS_APP && (!changes.length || switchToggled(removed, added))) parts.push(SETTING_SHOWN_AT_START_WORDS);
    if (!changes.length) {
      parts.push(settled.frames === framesBefore ? "Nothing on the screen changed." : "The picture changed, but no element did.");
      return { parts, after };
    }
    if (changes.length > CHANGES_MOST_LINES) {
      parts.push(`${changes.length} lines of the tree changed, too many to list.`);
      return { parts, after };
    }
    parts.push(`Changed:\n${changes.join("\n")}`);
    return { parts, after };
  }

  async act(box: BoxRecord, input: DeviceActInput, signal?: AbortSignal): Promise<ComputerResult> {
    this.#window(input.window);
    this.#gate(box);
    return this.#run(box, async (state) => {
      this.#gate(box);
      if (input.action === "key") {
        if (input.keys === undefined) throw new ComputerError("input", "key needs keys: a key or chord, such as Enter or cmd+a.", "Give keys.");
        return this.#typed(box, state, { keys: input.keys, ref: input.ref }, signal);
      }
      if (input.action === "set_value") return this.#setValue(box, state, input, signal);
      if (input.action === "scroll") return this.#scroll(box, state, input, signal);
      const target = await this.#target(box, state, input, input.action);
      const frames = await this.#frames(box);
      let done: string;
      switch (input.action) {
        case "click":
          await this.#send(box, { type: "tap", at: target.point }, "The tap failed");
          done = `Tapped ${target.words}.`;
          break;
        case "double_click":
          await this.#send(box, { type: "tap", at: target.point }, "The first tap failed");
          await this.#sleep(DOUBLE_TAP_GAP_MS, signal);
          await this.#send(box, { type: "tap", at: target.point }, "The second tap failed");
          done = `Tapped ${target.words} twice.`;
          break;
        case "right_click":
          await this.#send(box, { type: "long_press", at: target.point, ms: LONG_PRESS_MS }, "The long press failed");
          done = `Pressed ${target.words} for ${LONG_PRESS_MS / 1000} s, as a right click is on a device.`;
          break;
        case "drag": {
          if (input.toX === undefined || input.toY === undefined) throw new ComputerError("input", "drag needs to_x and to_y: where to drag to, in pixels of your latest image.", `Call computer_screenshot with window ${DEVICE_WINDOW} for an image, then give to_x and to_y.`);
          const to = this.#pixelPoint(state, input.toX, input.toY);
          const from = { ...target.point, generation: to.generation };
          await this.#send(box, { type: "swipe", from, to, ms: DRAG_MS }, "The drag failed");
          done = `Dragged from ${target.words} to ${input.toX},${input.toY}.`;
          break;
        }
      }
      const seen = await this.#after(box, state, target.before, frames);
      return { text: [done, ...seen.parts].join("\n\n"), hints: [] };
    });
  }

  async #scroll(box: BoxRecord, state: BoxState, input: DeviceActInput, signal?: AbortSignal): Promise<ComputerResult> {
    const direction = input.direction;
    if (!direction) throw new ComputerError("input", "scroll needs a direction: up, down, left or right.", "Give direction, and amount if you want other than 3.");
    const amount = input.amount ?? 3;
    const target = input.ref === undefined && input.x === undefined && input.y === undefined ? null : await this.#target(box, state, input, "scroll", false);
    let before = target?.before ?? (await this.#read(box, state));
    const region = scrollRegion(target?.shown ?? null, before.screen, direction);
    const frames = await this.#frames(box);
    const first = before;
    let steps = 0;
    for (; steps < amount; steps++) {
      signal?.throwIfAborted();
      this.#gate(box);
      const { from, to } = scrollSwipe(region.frame, direction);
      await this.#send(box, { type: "swipe", from: { ...from, generation: before.generation }, to: { ...to, generation: before.generation }, ms: SCROLL_SWIPE_MS }, "The scroll failed");
      await this.#settled(box, SCROLL_STEP_SETTLE);
      const now = await this.#read(box, state);
      const moved = signature(now) !== signature(before);
      before = now;
      if (!moved) break;
    }
    const within = region.shown ? `${region.shown.ref}, ${elementWords(region.shown.element)}` : "the screen";
    const done = steps < amount ? `Scrolled ${direction} in ${within} ${steps} of ${amount} steps: it moved no further, so it is at its end.` : `Scrolled ${direction} in ${within} by ${amount} steps, each a fifth of its ${direction === "up" || direction === "down" ? "height" : "width"}.`;
    const seen = await this.#after(box, state, first, frames);
    return { text: [done, ...seen.parts].join("\n\n"), hints: [] };
  }

  async #setValue(box: BoxRecord, state: BoxState, input: DeviceActInput, signal?: AbortSignal): Promise<ComputerResult> {
    if (input.ref === undefined) throw new ComputerError("input", "set_value needs a reference, not pixels.", "Give ref, from computer_observe.");
    if (input.value === undefined) throw new ComputerError("input", "set_value needs a value.", "Give value, the text to set.");
    const target = await this.#target(box, state, input, "set_value");
    const element = target.shown!.element;
    const editable = element.can ? element.can.edit : /text|search|edit/i.test(element.role);
    if (!editable) {
      throw new ComputerError(
        "refused",
        `${target.words}, is not a text field, so set_value cannot set it: on a device set_value sets fields you type in. Drag it with computer_act's drag instead.`,
        `Call computer_screenshot with window ${DEVICE_WINDOW}, then computer_act with action drag from its handle, x and y, to to_x and to_y. A button or switch takes a click.`,
      );
    }
    const frames = await this.#frames(box);
    await this.#send(box, { type: "tap", at: target.point }, "The tap on the field failed");
    await this.#settled(box, SCROLL_STEP_SETTLE);
    await this.#send(box, { type: "key", key: "a", modifiers: [selectAllModifier(target.before.platform)] }, "Selecting the field's text failed");
    if (input.value === "") await this.#send(box, { type: "key", key: "Backspace", modifiers: [] }, "Clearing the field failed");
    else await this.#typeChecked(box, state, input.value, target.shown!.ref);
    signal?.throwIfAborted();
    const seen = await this.#after(box, state, target.before, frames);
    const reads = readBack(seen.after, target.shown!.ref);
    return { text: [`Set ${target.words}, to ${quoted(input.value)}.${reads}`, ...seen.parts].join("\n\n"), hints: [] };
  }

  async type(box: BoxRecord, input: TypeInput, signal?: AbortSignal): Promise<ComputerResult> {
    this.#window(input.window);
    this.#gate(box);
    return this.#run(box, (state) => {
      this.#gate(box);
      return this.#typed(box, state, input, signal);
    });
  }

  async #typed(box: BoxRecord, state: BoxState, input: { readonly text?: string; readonly keys?: string; readonly ref?: string }, _signal?: AbortSignal): Promise<ComputerResult> {
    if (input.text === undefined && input.keys === undefined) throw new ComputerError("input", "Give text to type, keys to press, or both.", "Such as text \"hello\", or keys \"Enter\".");
    const key = input.keys === undefined ? null : deviceKey(input.keys);
    let before: Snapshot;
    let words = "the focused element";
    let ref: string | null = null;
    let keyboardNote = "";
    const frames = await this.#frames(box);
    if (input.ref !== undefined) {
      const target = await this.#target(box, state, { ref: input.ref }, "typing");
      before = target.before;
      words = target.words;
      ref = target.shown!.ref;
      if (!target.shown!.element.focused) {
        await this.#send(box, { type: "tap", at: target.point }, "The tap that focuses it failed");
        await this.#settled(box, SCROLL_STEP_SETTLE);
        if (input.text) keyboardNote = await this.#awaitKeyboard(box, state);
      }
    } else before = await this.#read(box, state);
    if (input.text !== undefined && input.text !== "") {
      const landed = await this.#typeChecked(box, state, input.text, ref);
      if (!landed.whole && key) {
        const seen = await this.#after(box, state, before, frames);
        throw new ComputerError(
          "input",
          `Typed ${quoted(input.text)} into ${words}, but ${landed.field} reads ${quoted(landed.reads)}: the device has not taken all of the keys, so ${PRODUCT} did not press ${input.keys}.${seen.parts.length ? `\n\n${seen.parts.join("\n\n")}` : ""}`,
          `Clear the field, such as with keys ${selectAllModifier(before.platform) === "control" ? "ctrl" : "cmd"}+a then Backspace, and type the text again.`,
        );
      }
    }
    if (key) await this.#send(box, { type: "key", key: key.key, modifiers: key.modifiers }, `Pressing ${input.keys} failed`);
    const seen = await this.#after(box, state, before, frames);
    const typed = [input.text ? `Typed ${quoted(input.text)}` : null, key ? `pressed ${input.keys}` : null].filter(Boolean).join(" and ");
    const reads = ref ? readBack(seen.after, ref) : focusedReads(seen.after);
    return { text: [`${typed[0]!.toUpperCase()}${typed.slice(1)} into ${words}.${reads}${keyboardNote}`, ...seen.parts].join("\n\n"), hints: [] };
  }

  async #awaitKeyboard(box: BoxRecord, state: BoxState): Promise<string> {
    for (let polls = 0; polls <= KEYBOARD_WAIT.mostMs / KEYBOARD_WAIT.everyMs; polls++) {
      const snapshot = await this.#readOnce(box, state).catch((error: unknown) => {
        if (error instanceof ComputerError && error.code === "driver") return null;
        throw error;
      });
      if (snapshot && focusedFieldWithKeyboard(snapshot)) {
        await this.#settled(box, SCROLL_STEP_SETTLE);
        return "";
      }
      await this.#sleep(KEYBOARD_WAIT.everyMs);
    }
    return ` ${KEYBOARD_NEVER_CAME_WORDS}`;
  }

  async #typeChecked(box: BoxRecord, state: BoxState, text: string, ref: string | null): Promise<{ readonly whole: boolean; readonly field: string; readonly reads: string }> {
    await this.#send(box, { type: "text", text }, "Typing failed");
    const began = performance.now();
    let last: string | null = null;
    let still = 0;
    for (;;) {
      const check = await this.#fieldReads(box, state, ref);
      if (!check || check.reads.includes(text)) return { whole: true, field: check?.field ?? "it", reads: check?.reads ?? "" };
      still = check.reads === last ? still + 1 : 0;
      last = check.reads;
      if (still >= TYPED_STILL_READS || performance.now() - began >= TYPED_WAIT_MS) return { whole: false, field: check.field, reads: check.reads };
    }
  }

  async #fieldReads(box: BoxRecord, state: BoxState, ref: string | null): Promise<{ readonly field: string; readonly reads: string } | null> {
    await this.#settled(box, SCROLL_STEP_SETTLE);
    const now = await this.#read(box, state);
    const shown = (ref ? now.byRef.get(ref) : undefined) ?? now.shown.filter((each) => each.element.focused).at(-1);
    if (!shown || shown.element.value === null || isSecureRole(shown.element.role)) return null;
    return { field: `${shown.ref}, ${elementWords(shown.element)},`, reads: shown.element.value };
  }

  async launch(box: BoxRecord, input: { readonly app?: string; readonly url?: string }, _signal?: AbortSignal): Promise<ComputerResult> {
    if ((input.app === undefined) === (input.url === undefined)) throw new ComputerError("input", "Give app or url, one of them.", "Such as app \"com.apple.Preferences\" or \"Settings\", or url \"https://example.com\".");
    this.#gate(box);
    return this.#run(box, async (state) => {
      this.#gate(box);
      let done: string;
      let front: (snapshot: Snapshot) => boolean = drawn;
      if (input.url !== undefined) {
        front = (snapshot) => !!snapshot.app && !snapshot.starting;
        await this.#ok(this.#deps.agentRequest(box, { type: "open", url: input.url }), `${PRODUCT} could not open ${input.url}`);
        done = `Opened ${input.url}.`;
      } else {
        const answer = await this.#ok(this.#deps.agentRequest(box, { type: "launch", app: input.app! }), `${PRODUCT} could not launch ${input.app}`);
        const launched = answer.result.type === "launched" ? answer.result.app : null;
        done = launched ? `Launched ${launched.name} (${launched.id}).` : `Launched ${input.app}.`;
        if (launched) front = (snapshot) => !snapshot.starting && snapshot.app.toLowerCase() === launched.name.toLowerCase();
      }
      await this.#read(box, state, front);
      const settled = await this.#settled(box);
      const after = await this.#read(box, state);
      const still = settled.quiet ? "" : ` The screen was still changing ${DEVICE_SETTLE.mostMs / 1000} s after.`;
      return { text: `${done} ${this.#heading(after)}${still}`, hints: [`Call computer_observe with window ${DEVICE_WINDOW} to read it.`] };
    });
  }

  async takeControl(box: BoxRecord): Promise<ComputerResult> {
    const took = await this.#deps.takeBack(box.id);
    const state = this.#boxes.get(box.id);
    if (state) {
      state.snapshot = null;
      state.image = null;
    }
    if (took) {
      return {
        text: `You took control of box ${box.name}'s device back. Touches and keys the person held were let go. The screen may have changed, and earlier references and images are gone.`,
        hints: [`Call computer_observe with window ${DEVICE_WINDOW} before acting.`],
      };
    }
    return { text: `You already have control of box ${box.name}'s device.`, hints: [] };
  }
}

function selectAllModifier(platform: DevicePlatform): KeyModifier {
  return platform === "android" ? "control" : "meta";
}

function switchToggled(removed: readonly string[], added: readonly string[]): boolean {
  const refs = (lines: readonly string[]) => new Set(lines.flatMap((line) => SWITCH_REF.exec(line)?.slice(1, 2) ?? []));
  const before = refs(removed);
  return [...refs(added)].some((ref) => before.has(ref));
}

function frontWords(snapshot: Snapshot): string {
  if (!snapshot.app) return snapshot.starting ? "an app still starting" : "the Home Screen or a system screen";
  return snapshot.starting ? `${snapshot.app} (still starting)` : snapshot.app;
}

function drawn(snapshot: Snapshot): boolean {
  if (snapshot.starting) return false;
  if (snapshot.app) return true;
  const band = snapshot.screen.height * STATUS_BAR_FRACTION;
  return snapshot.shown.some((shown) => shown.depth > 0 && shown.element.frame.y + shown.element.frame.height > band);
}

function rememberedOf(shown: Pick<Shown, "element" | "key" | "ordinal" | "count">, generation: number): Remembered {
  return {
    key: shown.key,
    identifier: shown.element.identifier,
    role: shown.element.role,
    label: shown.element.label,
    ordinal: shown.ordinal,
    count: shown.count,
    frame: shown.element.frame,
    generation,
    words: elementWords(shown.element),
  };
}

type Candidate = { readonly element: DeviceElement; readonly key: string; readonly ordinal: number; readonly count: number };
type Matched = { readonly is: "found"; readonly index: number } | { readonly is: "ambiguous"; readonly indices: readonly number[] } | { readonly is: "gone" };

export function matchIn(remembered: Remembered, candidates: readonly Candidate[]): Matched {
  const byKey = candidates.flatMap((candidate, index) => (candidate.key === remembered.key ? [index] : []));
  const pool = byKey.length
    ? byKey
    : remembered.identifier
      ? candidates.flatMap((candidate, index) => (candidate.element.identifier === remembered.identifier && candidate.element.role === remembered.role ? [index] : []))
      : [];
  if (!pool.length) return { is: "gone" };
  if (pool.length === 1) return { is: "found", index: pool[0]! };
  if (byKey.length && pool.length === remembered.count) return { is: "found", index: pool[remembered.ordinal]! };
  const sameFrame = pool.filter((index) => JSON.stringify(candidates[index]!.element.frame) === JSON.stringify(remembered.frame));
  if (sameFrame.length === 1) return { is: "found", index: sameFrame[0]! };
  return { is: "ambiguous", indices: pool };
}

function tapPoints(visible: ElementFrame): readonly { readonly x: number; readonly y: number }[] {
  const at = (across: number, down: number) => ({ x: Math.round(visible.x + visible.width * across), y: Math.round(visible.y + visible.height * down) });
  return [at(0.5, 0.5), at(0.5, 0.8), at(0.5, 0.2), at(0.2, 0.5), at(0.8, 0.5)];
}

function isPartOf(found: DeviceElement, target: DeviceElement): boolean {
  const same = (one: DeviceElement) =>
    (found.identifier !== null && found.identifier === one.identifier && found.role === one.role) || (found.role === one.role && found.label === one.label && sameFrame(found.frame, one.frame));
  const within = (one: DeviceElement): boolean => same(one) || one.children.some(within);
  return within(target);
}

function sameFrame(a: ElementFrame, b: ElementFrame): boolean {
  return Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.width - b.width) <= 1 && Math.abs(a.height - b.height) <= 1;
}

function deepestAt(snapshot: Snapshot, point: { readonly x: number; readonly y: number }): Shown | null {
  let best: Shown | null = null;
  for (const shown of snapshot.shown) if (contains(shown.element.frame, point) && (!best || shown.depth >= best.depth)) best = shown;
  return best;
}

function scrollRegion(target: Shown | null, screen: VideoSize, direction: Direction): { readonly frame: ElementFrame; readonly shown: Shown | null } {
  const vertical = direction === "up" || direction === "down";
  for (let at: Shown | null = target; at; at = at.parent) {
    if (!at.element.can?.scroll) continue;
    const visible = visiblePart(at.element.frame, screen);
    if (!visible) continue;
    const enough = vertical ? visible.height >= screen.height * SCROLLER_LEAST_FRACTION : visible.width >= screen.width * SCROLLER_LEAST_FRACTION;
    if (enough) return { frame: visible, shown: at };
  }
  return { frame: { x: 0, y: 0, width: screen.width, height: screen.height }, shown: null };
}

export function scrollSwipe(region: ElementFrame, direction: Direction): { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number } } {
  const middle = centre(region);
  const vertical = direction === "up" || direction === "down";
  const along = (vertical ? region.height : region.width) * Math.min(SCROLL_STEP_FRACTION, SCROLL_BAND_FRACTION);
  const half = Math.round(along / 2);
  const towards = direction === "down" || direction === "right" ? -1 : 1;
  if (vertical) return { from: { x: middle.x, y: middle.y - towards * half }, to: { x: middle.x, y: middle.y + towards * half } };
  return { from: { x: middle.x - towards * half, y: middle.y }, to: { x: middle.x + towards * half, y: middle.y } };
}

function readBack(snapshot: Snapshot, ref: string): string {
  const shown = snapshot.byRef.get(ref);
  if (!shown) return ` ${ref} is no longer on the screen.`;
  const value = shown.element.value;
  return value === null ? ` ${shown.ref} reads nothing now.` : ` ${shown.ref} reads ${quoted(value)} now.`;
}

function focusedFieldWithKeyboard(snapshot: Snapshot): boolean {
  const field = snapshot.shown.some((shown) => shown.element.focused && (shown.element.can?.edit ?? /text|search|edit/i.test(shown.element.role)));
  return field && snapshot.shown.some((shown) => shown.element.role === "keyboard" || shown.element.role === KEYBOARD_KEY_ROLE);
}

function focusedReads(snapshot: Snapshot): string {
  const focused = snapshot.shown.filter((shown) => shown.element.focused).at(-1);
  if (!focused) return "";
  return focused.element.value === null ? ` ${focused.ref}, ${elementWords(focused.element)}, has the focus.` : ` ${focused.ref}, ${elementWords(focused.element)}, reads ${quoted(focused.element.value)} now.`;
}
