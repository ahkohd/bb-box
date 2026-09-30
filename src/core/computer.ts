// Computer use (015). The agent drives a desktop box through bb-box's six
// computer tools, and bb-box drives the Cua Driver in the box over one MCP
// session per box. bb-box owns the references the agent sees, keeps pixels
// with the image they came from, retries in the foreground an action Cua
// cannot do in the background, and refuses everything while a person holds
// the box's desktop.

import { createHash } from "node:crypto";
import type { ByteChannel } from "../transports/types.ts";
import { BoxError, type BoxRecord } from "./boxes.ts";
import type { Owner } from "./control.ts";
import { driverCommand } from "./in-box.ts";
import { McpClosedError, McpError, McpSession, type McpResult } from "./mcp.ts";

export const PAUSED =
  "Paused: a person has taken control of this box's desktop in BB. The computer tools will work again when they hand control back. " +
  "Nothing was done and the desktop is as they left it. Wait, or ask them in the thread.";
export const RETURNED = "Control returned; the desktop may have changed. Observe before acting.";

/** The longest edge of an image the agent gets. */
export const IMAGE_MAX_EDGE = 1568;
/** Elements computer_observe shows unless the agent asks for more. */
export const TREE_LIMIT = 300;
export const TREE_LIMIT_MAX = 2_000;
const TREE_MAX_CHARS = 40_000;
const CHANGES_MAX_LINES = 60;
const IDLE_MS = 10 * 60_000;
const PAUSE_WAIT_MS = 3_000;
const OPEN_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const LAUNCH_WAIT_MS = 10_000;
const LAUNCH_POLL_MS = 250;
/** How long Cua may walk a window's tree. */
const WALK_MS = 3_000;
/** References kept per box; the oldest go first. */
const MAX_REFS = 20_000;

/** How bb-box names itself to the driver. Cua does not read it. */
const CLIENT = { name: "bb-box", version: "1" };
const PAUSED_WHILE_RUNNING = "A person took control of the box's desktop while this ran, so bb-box closed its session with the driver.";
const FORGOTTEN = "The box stopped or was released while this ran.";

export type ComputerErrorCode = "paused" | "unsupported" | "stale" | "input" | "refused" | "driver" | "interrupted";

/** A computer tool's refusal or failure, with what the agent should do next. */
export class ComputerError extends Error {
  readonly code: ComputerErrorCode;
  readonly hint: string | null;
  constructor(code: ComputerErrorCode, message: string, hint: string | null = null) {
    super(message);
    this.name = "ComputerError";
    this.code = code;
    this.hint = hint;
  }
}

export interface ComputerResult {
  readonly text: string;
  readonly image?: { readonly data: string; readonly mimeType: string };
  readonly hints: readonly string[];
}

export interface ComputerDeps {
  /** Starts `script` in the box through its command transport's spawn. */
  spawn(box: BoxRecord, script: string, signal?: AbortSignal): Promise<ByteChannel>;
  /** Who controls the box's desktop now. */
  owner(boxId: string): Owner;
  logError(operation: string, error: unknown): void;
  readonly idleMs?: number;
  readonly pauseWaitMs?: number;
  readonly callTimeoutMs?: number;
  readonly launchWaitMs?: number;
}

/** A window ID from computer_windows, or the whole desktop. */
export type WindowRef = number | "desktop";
export type Action = "click" | "double_click" | "right_click" | "scroll" | "set_value";
export type Direction = "up" | "down" | "left" | "right";

export interface ActInput {
  readonly action: Action;
  readonly ref?: string;
  readonly window?: WindowRef;
  readonly x?: number;
  readonly y?: number;
  readonly value?: string;
  readonly direction?: Direction;
  readonly amount?: number;
}

export interface TypeInput {
  readonly text?: string;
  readonly keys?: string;
  readonly ref?: string;
  readonly window?: number;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

interface WindowInfo extends Size {
  readonly id: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string;
  readonly onScreen: boolean;
}

interface Element {
  readonly index: number;
  readonly ref: string;
  readonly token: string | null;
  readonly role: string;
  readonly label: string;
  /** A hash of its role, its name, and its ancestors' roles and names. */
  readonly fingerprint: string;
  /** No other element of its snapshot has its fingerprint. */
  readonly unique: boolean;
}

/** A line of the tree text. An element's line carries its reference. */
interface Line {
  readonly text: string;
  readonly depth: number;
  readonly element: Element | null;
}

interface Snapshot {
  readonly window: WindowInfo;
  /** The session whose Cua tokens it holds. */
  readonly generation: number;
  readonly id: string | null;
  readonly elements: readonly Element[];
  readonly byRef: ReadonlyMap<string, Element>;
  readonly lines: readonly Line[];
  /** Why Cua stopped reading the tree early, when it did. */
  readonly partial: string | null;
  /** The screenshot Cua took with it, which pixel actions on the window are measured against. */
  readonly screenshot: Size | null;
  /** Dialogs and popups open over the window, in words. */
  readonly overlays: readonly string[];
}

interface RefEntry {
  readonly windowId: number;
  readonly fingerprint: string;
  readonly unique: boolean;
  readonly describe: string;
}

/** An image the agent was given. The desktop's also has the screen's size, to turn its pixels into the screen's. */
interface Held extends Size {
  readonly screen?: Size;
}

interface Image extends Size {
  readonly data: string;
  readonly mimeType: string;
}

interface Live {
  readonly mcp: McpSession;
  readonly generation: number;
  /** Why bb-box closed it; null while open, or when it ended by itself. */
  reason: string | null;
}

interface BoxState {
  live: Live | null;
  opening: Promise<Live> | null;
  generation: number;
  /** Calls running or queued. Calls to one box run one at a time. */
  inFlight: number;
  queue: Promise<unknown>;
  drained: (() => void)[];
  idle: ReturnType<typeof setTimeout> | null;
  forgotten: boolean;
  /** Told with the next call that runs. */
  notice: string | null;
  readonly windows: Map<number, WindowInfo>;
  readonly snapshots: Map<number, Snapshot>;
  readonly refs: Map<string, RefEntry>;
  /** Per window, the reference of each fingerprint that was unique. */
  readonly named: Map<number, Map<string, string>>;
  nextRef: number;
  readonly images: Map<WindowRef, Held>;
}

interface Use {
  readonly state: BoxState;
  readonly box: BoxRecord;
  readonly signal?: AbortSignal;
}

interface Read {
  readonly snapshot: Snapshot;
  readonly image: Image | null;
  /** The agent's image of the window no longer matches it. */
  readonly dropped: boolean;
}

type Json = Record<string, unknown>;

function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : {};
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function textOf(result: McpResult): string {
  const text = result.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .join(" ");
  return text.length > 500 ? `${text.slice(0, 500)}...` : text || "Cua Driver gave no reason.";
}

/** The width and height in a PNG's header. */
export function pngSize(base64: string): Size | null {
  const head = Buffer.from(base64.slice(0, 32), "base64");
  if (head.length < 24 || head.toString("latin1", 12, 16) !== "IHDR") return null;
  return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
}

function imageOf(result: McpResult): Image | null {
  const part = result.content.find((candidate) => candidate.type === "image" && candidate.data);
  if (!part?.data) return null;
  const structured = obj(result.structuredContent);
  const size = pngSize(part.data) ?? { width: num(structured.screenshot_width) ?? 0, height: num(structured.screenshot_height) ?? 0 };
  return { data: part.data, mimeType: part.mimeType ?? "image/png", ...size };
}

function sameSize(a: Size, b: Size): boolean {
  return a.width === b.width && a.height === b.height;
}

/** Cua could not do it in the background, and did nothing, so the foreground may. */
function refusedInBackground(result: McpResult): boolean {
  if (!result.isError) return false;
  const structured = obj(result.structuredContent);
  const code = str(structured.code);
  if (code === "background_unavailable" || code === "background_pointer_failed") return true;
  if (str(obj(structured.escalation).recommended) === "foreground") return true;
  return /^Background delivery is not available/.test(textOf(result));
}

function windowOf(value: unknown): WindowInfo | null {
  const raw = obj(value);
  const id = num(raw.window_id);
  const pid = num(raw.pid);
  if (id === undefined || pid === undefined) return null;
  const bounds = obj(raw.bounds);
  return {
    id,
    pid,
    app: str(raw.app_name) ?? "",
    title: str(raw.title) ?? "",
    width: num(bounds.width) ?? num(raw.width) ?? 0,
    height: num(bounds.height) ?? num(raw.height) ?? 0,
    onScreen: raw.is_on_screen !== false,
  };
}

export function windowLine(window: WindowInfo): string {
  const title = window.title ? ` "${window.title}"` : "";
  return `window ${window.id}: ${window.app || "an app"}${title}, ${window.width} by ${window.height}${window.onScreen ? "" : ", not on screen"}`;
}

function describe(role: string, label: string): string {
  return label ? `${role} '${label}'` : role;
}

/** One line of the tree, for a list of changes: no indent, no list marker, on one line. */
function flat(line: Line): string {
  return line.text.trim().replace(/^- /, "").replace(/\s*\n\s*/g, " ");
}

/** The ref as the agent may write it: e12 or [e12]. */
function refName(ref: string): string {
  return ref.trim().replace(/^\[(.*)\]$/, "$1");
}

/** A key chord such as "ctrl+shift+t", "Return" or "ctrl++". */
export function chord(keys: string): { key: string; modifiers: string[] } {
  const trimmed = keys.trim();
  if (trimmed === "+") return { key: "+", modifiers: [] };
  const plus = trimmed.endsWith("++");
  const parts = (plus ? trimmed.slice(0, -2) : trimmed).split("+").map((part) => part.trim());
  const key = plus ? "+" : parts.pop();
  if (!key || parts.some((part) => !part)) {
    throw new ComputerError("input", `"${keys}" is not a key chord.`, 'Give one key, such as "Return", or a chord such as "ctrl+a".');
  }
  return { key, modifiers: parts.map((part) => part.toLowerCase()) };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
  });
}

export class Computer {
  readonly #deps: ComputerDeps;
  readonly #boxes = new Map<string, BoxState>();

  constructor(deps: ComputerDeps) {
    this.#deps = deps;
  }

  /** Lists the desktop's windows. */
  windows(box: BoxRecord, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      const windows = [...(await this.#listWindows(use)).values()].filter((window) => window.width > 1 && window.height > 1);
      if (!windows.length) {
        return { text: `Box ${box.name}'s desktop has no windows.`, hints: ["Open an app with computer_launch."] };
      }
      return {
        text: `Windows on box ${box.name}'s desktop:\n${windows.map((window) => `- ${windowLine(window)}`).join("\n")}`,
        hints: ["Read a window with computer_observe.", "Open another app with computer_launch."],
      };
    });
  }

  /** Reads a window's accessibility tree, and its image when asked. */
  observe(
    box: BoxRecord,
    input: { window: number; query?: string; limit?: number; screenshot?: boolean },
    signal?: AbortSignal,
  ): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      const { snapshot, image, dropped } = await this.#read(use, input.window, input.screenshot === true);
      const lines = [this.#tree(snapshot, input.query, input.limit ?? TREE_LIMIT)];
      if (dropped) lines.push(`Window ${input.window} changed size, so your last image of it no longer applies.`);
      if (image) {
        use.state.images.set(input.window, { width: image.width, height: image.height });
        lines.push(`The image is ${image.width} by ${image.height} pixels. x and y are pixels of this image.`);
      }
      const hints = ["Act on an element with computer_act or computer_type, giving its reference as ref."];
      if (snapshot.overlays.length) hints.push("Observe a dialog or popup by its window ID to act in it.");
      return { text: lines.join("\n\n"), image: image ? { data: image.data, mimeType: image.mimeType } : undefined, hints };
    });
  }

  /** An image of a window, or of the whole desktop. */
  screenshot(box: BoxRecord, window: WindowRef, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if (window === "desktop") {
        const { result } = await this.#call(use, "get_desktop_state", { max_image_dimension: IMAGE_MAX_EDGE }, { readOnly: true });
        if (result.isError) throw new ComputerError("driver", `Cua Driver could not take an image of the desktop: ${textOf(result)}`, "Try again in a few seconds.");
        const image = imageOf(result);
        if (!image) throw new ComputerError("driver", "Cua Driver returned no image of the desktop.", "Try again in a few seconds.");
        const structured = obj(result.structuredContent);
        for (const raw of arr(structured.windows)) {
          const found = windowOf(raw);
          if (found) use.state.windows.set(found.id, found);
        }
        const screen = { width: num(structured.screen_width) ?? image.width, height: num(structured.screen_height) ?? image.height };
        use.state.images.set("desktop", { width: image.width, height: image.height, screen });
        return {
          text: `The desktop, ${image.width} by ${image.height} pixels. x and y are pixels of this image; give window "desktop" with them.`,
          image: { data: image.data, mimeType: image.mimeType },
          hints: ["Prefer references from computer_observe: they do not depend on where things are drawn."],
        };
      }
      const { snapshot, image } = await this.#read(use, window, true);
      if (!image) throw new ComputerError("driver", `Cua Driver returned no image of window ${window}.`, "Try again in a few seconds.");
      use.state.images.set(window, { width: image.width, height: image.height });
      return {
        text: `${windowLine(snapshot.window)}. The image is ${image.width} by ${image.height} pixels. x and y are pixels of this image.`,
        image: { data: image.data, mimeType: image.mimeType },
        hints: ["Prefer references from computer_observe: they do not depend on where things are drawn."],
      };
    });
  }

  /** Clicks, scrolls or sets a value, on a reference or at pixels of the latest image. */
  act(box: BoxRecord, input: ActInput, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      const target = await this.#target(use, input);
      if (input.action === "set_value" && !target.element) {
        throw new ComputerError("input", "set_value needs a reference, not pixels.", "Give ref, from computer_observe.");
      }
      if (input.action === "set_value" && input.value === undefined) {
        throw new ComputerError("input", "set_value needs a value.", "Give value, the text or number to set.");
      }
      if (input.action === "scroll" && !input.direction) {
        throw new ComputerError("input", "scroll needs a direction: up, down, left or right.", "Give direction, and amount if you want other than 3.");
      }
      const amount = input.amount ?? 3;
      const steps: Record<Action, { tool: string; args: Json; done: string }> = {
        click: { tool: "click", args: { button: "left", count: 1 }, done: "Clicked" },
        double_click: { tool: "click", args: { button: "left", count: 2 }, done: "Double-clicked" },
        right_click: { tool: "click", args: { button: "right", count: 1 }, done: "Right-clicked" },
        scroll: { tool: "scroll", args: { direction: input.direction, amount }, done: `Scrolled ${input.direction} by ${amount} at` },
        set_value: { tool: "set_value", args: { value: input.value }, done: "Set the value of" },
      };
      const step = steps[input.action];
      const { result, foreground } = await this.#deliver(use, step.tool, { ...target.args, ...step.args }, input.action !== "set_value");
      const lines = [`${step.done} ${target.label}${input.action === "set_value" ? ` to "${input.value}"` : ""}${foreground ? FOREGROUND : ""}.`];
      const popups = this.#popups(use, result, target.snapshot?.window.pid);
      if (popups.length) lines.push(popups.join(" "));
      if (!target.snapshot) {
        return { text: lines.join("\n\n"), hints: ["Call computer_screenshot to see the desktop now, or computer_windows."] };
      }
      const changed = await this.#changes(use, target.snapshot);
      lines.push(changed.text);
      return { text: lines.join("\n\n"), hints: changed.hints };
    });
  }

  /** Types text, or presses a key chord, into a reference or a window's focused element. */
  type(box: BoxRecord, input: TypeInput, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if ((input.text === undefined) === (input.keys === undefined)) {
        throw new ComputerError("input", "Give text or keys, not both and not neither.", 'text types characters; keys presses one chord, such as "ctrl+a" or "Return".');
      }
      let args: Json;
      let label: string;
      let before: Snapshot | null;
      let readBack: string | null = null;
      if (input.ref !== undefined) {
        const { snapshot, element } = await this.#element(use, input.ref);
        args = { pid: snapshot.window.pid, window_id: snapshot.window.id, ...this.#token(snapshot, element) };
        label = `${element.ref} (${describe(element.role, element.label)})`;
        before = snapshot;
        readBack = element.ref;
      } else if (input.window !== undefined) {
        const window = await this.#window(use, input.window);
        args = { pid: window.pid, window_id: window.id };
        label = `window ${window.id}`;
        before = use.state.snapshots.get(window.id) ?? null;
      } else {
        throw new ComputerError("input", "Give ref, or window to type into its focused element.", "Get both from computer_observe.");
      }
      let done: string;
      let tool: string;
      if (input.text !== undefined) {
        tool = "type_text";
        args = { ...args, text: input.text };
        done = `Typed ${input.text.length} character${input.text.length === 1 ? "" : "s"} into ${label}`;
      } else {
        const { key, modifiers } = chord(input.keys!);
        tool = "press_key";
        args = { ...args, key, modifiers };
        done = `Pressed ${input.keys!.trim()} in ${label}`;
      }
      const { foreground } = await this.#deliver(use, tool, args, true);
      const lines = [`${done}${foreground ? FOREGROUND : ""}.`];
      if (!before) {
        return { text: lines.join("\n\n"), hints: [`Call computer_observe with window ${args.window_id} to see it.`] };
      }
      const changed = await this.#changes(use, before, readBack);
      lines.push(changed.text);
      return { text: lines.join("\n\n"), hints: changed.hints };
    });
  }

  /** Opens an app by name or path, or a URL in the default browser. */
  launch(box: BoxRecord, input: { app?: string; url?: string }, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if ((input.app === undefined) === (input.url === undefined)) {
        throw new ComputerError("input", "Give app or url, not both and not neither.", "app is an app's name or path; url opens in the default browser.");
      }
      const what = input.url ?? input.app!;
      const before = await this.#listWindows(use);
      const args = input.url !== undefined ? { urls: [input.url] } : input.app!.includes("/") ? { launch_path: input.app } : { name: input.app };
      const { result } = await this.#call(use, "launch_app", args, { readOnly: false });
      if (result.isError) {
        throw new ComputerError("refused", `Cua Driver could not open ${what}: ${textOf(result)}`, "Check the app's name or path with box_run, for example command -v <name>.");
      }
      let windows = arr(obj(result.structuredContent).windows)
        .map(windowOf)
        .filter((window): window is WindowInfo => !!window);
      for (const window of windows) use.state.windows.set(window.id, window);
      const deadline = Date.now() + (this.#deps.launchWaitMs ?? LAUNCH_WAIT_MS);
      while (!windows.length && Date.now() < deadline) {
        await sleep(LAUNCH_POLL_MS, use.signal);
        windows = [...(await this.#listWindows(use)).values()].filter((window) => !before.has(window.id) && window.width > 1 && window.height > 1);
      }
      if (!windows.length) {
        const where = input.url !== undefined ? " It may have opened in a browser window that was already open." : "";
        return { text: `Opened ${what}, but no new window appeared within ${Math.round((this.#deps.launchWaitMs ?? LAUNCH_WAIT_MS) / 1000)} s.${where}`, hints: ["Call computer_windows to see the windows now."] };
      }
      return {
        text: `Opened ${what}. Its window${windows.length === 1 ? "" : "s"}:\n${windows.map((window) => `- ${windowLine(window)}`).join("\n")}`,
        hints: [`Call computer_observe with window ${windows[0]!.id} to read it.`],
      };
    });
  }

  /**
   * A person is taking control of the box's desktop, and new calls are
   * already refused: waits a moment for a call in flight, closes the
   * session, and drops every reference and image.
   */
  async pause(boxId: string): Promise<void> {
    const state = this.#boxes.get(boxId);
    if (!state) return;
    this.#stopIdle(state);
    await this.#drain(state, this.#deps.pauseWaitMs ?? PAUSE_WAIT_MS);
    await this.#close(state, PAUSED_WHILE_RUNNING);
    this.#drop(state);
    state.notice = RETURNED;
  }

  /** The box stopped, restarted or went: its session closes and nothing is kept. */
  forget(boxId: string): void {
    const state = this.#boxes.get(boxId);
    if (!state) return;
    this.#boxes.delete(boxId);
    state.forgotten = true;
    this.#stopIdle(state);
    void this.#close(state, FORGOTTEN).catch((error) => this.#deps.logError("close a computer-use session", error));
  }

  /** Whether bb-box holds a session to the box's driver. For tests and the doctor. */
  connected(boxId: string): boolean {
    const live = this.#boxes.get(boxId)?.live;
    return !!live && !live.mcp.closed;
  }

  async dispose(): Promise<void> {
    const states = [...this.#boxes.values()];
    this.#boxes.clear();
    await Promise.all(
      states.map((state) => {
        state.forgotten = true;
        this.#stopIdle(state);
        return this.#close(state, "bb-box stopped while this ran.").catch(() => {});
      }),
    );
  }

  #state(boxId: string): BoxState {
    let state = this.#boxes.get(boxId);
    if (!state) {
      state = {
        live: null,
        opening: null,
        generation: 0,
        inFlight: 0,
        queue: Promise.resolve(),
        drained: [],
        idle: null,
        forgotten: false,
        notice: null,
        windows: new Map(),
        snapshots: new Map(),
        refs: new Map(),
        named: new Map(),
        nextRef: 1,
        images: new Map(),
      };
      this.#boxes.set(boxId, state);
    }
    return state;
  }

  /** Runs one tool call: after the box's earlier ones, and only while the agent has control. */
  async #run(box: BoxRecord, signal: AbortSignal | undefined, work: (use: Use) => Promise<ComputerResult>): Promise<ComputerResult> {
    const driver = box.capabilities.computerUse;
    if (!driver) {
      throw new ComputerError("unsupported", `Box ${box.name} has no computer use: its kind, ${box.kind}, has no desktop the computer tools can drive.`, "Acquire a desktop kind from box_list for computer use, or use box_run in this box.");
    }
    if (driver.driver !== "cua") throw new ComputerError("unsupported", `bb-box cannot drive box ${box.name}'s computer-use driver, ${driver.driver}.`, "Use box_run in this box.");
    const state = this.#state(box.id);
    state.inFlight++;
    this.#stopIdle(state);
    const task = async () => {
      const use: Use = { state, box, signal };
      this.#gate(use);
      const notice = state.notice;
      state.notice = null;
      try {
        const result = await work(use);
        return notice ? { ...result, text: `${notice}\n\n${result.text}` } : result;
      } catch (error) {
        if (notice) state.notice ??= notice;
        throw error;
      }
    };
    try {
      const run = state.queue.then(task, task);
      state.queue = run.catch(() => undefined);
      return await run;
    } finally {
      state.inFlight--;
      if (!state.inFlight) this.#settled(state);
    }
  }

  #gate(use: Use): void {
    if (use.state.forgotten) throw new ComputerError("interrupted", FORGOTTEN, "Call box_status to see the box.");
    if (this.#deps.owner(use.box.id) !== "agent") throw new ComputerError("paused", PAUSED);
  }

  #settled(state: BoxState): void {
    for (const resolve of state.drained.splice(0)) resolve();
    if (state.forgotten || !state.live) return;
    state.idle = setTimeout(() => {
      state.idle = null;
      void this.#close(state, "The computer-use session was idle.").catch((error) => this.#deps.logError("close a computer-use session", error));
    }, this.#deps.idleMs ?? IDLE_MS);
    state.idle.unref?.();
  }

  #stopIdle(state: BoxState): void {
    if (state.idle) clearTimeout(state.idle);
    state.idle = null;
  }

  #drain(state: BoxState, ms: number): Promise<void> {
    if (!state.inFlight) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms);
      state.drained.push(done);
      function done() {
        clearTimeout(timer);
        resolve();
      }
    });
  }

  async #close(state: BoxState, reason: string): Promise<void> {
    if (state.opening) await state.opening.catch(() => {});
    const live = state.live;
    state.live = null;
    if (!live) return;
    live.reason = reason;
    await live.mcp.close(reason);
  }

  #drop(state: BoxState): void {
    state.windows.clear();
    state.snapshots.clear();
    state.refs.clear();
    state.named.clear();
    state.images.clear();
  }

  async #live(use: Use): Promise<Live> {
    const { state } = use;
    if (state.live && !state.live.mcp.closed) return state.live;
    state.opening ??= this.#open(state, use.box).finally(() => {
      state.opening = null;
    });
    return state.opening;
  }

  /** Opens a session with the driver, trying twice. */
  async #open(state: BoxState, box: BoxRecord): Promise<Live> {
    const driver = box.capabilities.computerUse!;
    const script = driverCommand(box.capabilities.os, driver.socket);
    let failure: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (state.forgotten) throw new ComputerError("interrupted", FORGOTTEN, "Call box_status to see the box.");
      try {
        const channel = await this.#deps.spawn(box, script, AbortSignal.timeout(OPEN_TIMEOUT_MS));
        const generation = state.generation + 1;
        let live: Live | null = null;
        const mcp = await McpSession.open(channel, {
          client: CLIENT,
          timeoutMs: OPEN_TIMEOUT_MS,
          onClose: (error) => {
            if (!live) return;
            if (state.live === live) state.live = null;
            if (live.reason === null) this.#deps.logError(`computer-use session with box ${box.name}`, error);
          },
        });
        live = { mcp, generation, reason: null };
        state.generation = generation;
        if (state.forgotten) {
          live.reason = FORGOTTEN;
          await mcp.close(FORGOTTEN);
          throw new ComputerError("interrupted", FORGOTTEN, "Call box_status to see the box.");
        }
        state.live = live;
        return live;
      } catch (error) {
        if (error instanceof BoxError || error instanceof ComputerError) throw error;
        failure = error;
      }
    }
    const reason = failure instanceof Error ? failure.message : String(failure);
    throw new ComputerError(
      "driver",
      `bb-box could not reach the computer-use driver in box ${box.name}: ${sentence(reason)}`,
      "The driver runs in the box's desktop session. If the desktop just restarted, try again in a few seconds; otherwise call box_status.",
    );
  }

  /**
   * Calls one of Cua's tools. A read whose session ended by itself is tried
   * once more on a new session; an action is not, since it may have been done.
   */
  async #call(use: Use, name: string, args: Json, options: { readOnly: boolean }): Promise<{ result: McpResult; live: Live }> {
    for (let attempt = 0; ; attempt++) {
      this.#gate(use);
      const live = await this.#live(use);
      this.#gate(use);
      try {
        const result = await live.mcp.call(name, args, { timeoutMs: this.#deps.callTimeoutMs ?? CALL_TIMEOUT_MS, signal: use.signal });
        return { result, live };
      } catch (error) {
        const unsure = options.readOnly ? "" : " bb-box cannot tell whether it was done.";
        if (error instanceof McpError) {
          throw new ComputerError("driver", `Cua Driver refused ${name}: ${error.message}`, "This is probably a bb-box bug: tell the user.");
        }
        if (error instanceof McpClosedError) {
          if (live.reason === null && options.readOnly && attempt === 0) continue;
          const hint =
            live.reason === PAUSED_WHILE_RUNNING
              ? "Wait until they hand control back, then call computer_observe."
              : live.reason === FORGOTTEN
                ? "Call box_status to see the box."
                : "Call computer_observe to see the window; bb-box opens a new session with the driver.";
          throw new ComputerError("interrupted", `${sentence(error.message)}${unsure}`, hint);
        }
        if (use.signal?.aborted) throw error;
        // A driver that does not answer is not trusted with the next call.
        live.reason = "The computer-use driver stopped answering.";
        void live.mcp.close(live.reason);
        const message = error instanceof Error ? error.message : String(error);
        throw new ComputerError("driver", `${sentence(message)}${unsure}`, "Call computer_observe to see the window, then try again.");
      }
    }
  }

  /**
   * Does an action in the background, or in the foreground when Cua cannot
   * do it in the background. Cua says so before it does anything.
   */
  async #deliver(use: Use, tool: string, args: Json, delivery: boolean): Promise<{ result: McpResult; foreground: boolean }> {
    let { result } = await this.#call(use, tool, delivery ? { ...args, delivery_mode: "background" } : args, { readOnly: false });
    let foreground = false;
    if (delivery && refusedInBackground(result)) {
      ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
      foreground = true;
    }
    if (result.isError) {
      throw new ComputerError("refused", `Cua Driver did not do it: ${textOf(result)}`, "Call computer_observe to see the window, then try another way.");
    }
    return { result, foreground };
  }

  async #listWindows(use: Use): Promise<Map<number, WindowInfo>> {
    const { result } = await this.#call(use, "list_windows", {}, { readOnly: true });
    if (result.isError) throw new ComputerError("driver", `Cua Driver could not list the windows: ${textOf(result)}`, "Try again in a few seconds.");
    const windows = new Map<number, WindowInfo>();
    for (const raw of arr(obj(result.structuredContent).windows)) {
      const window = windowOf(raw);
      if (!window) continue;
      windows.set(window.id, window);
      use.state.windows.set(window.id, window);
    }
    return windows;
  }

  async #window(use: Use, id: number): Promise<WindowInfo> {
    const known = use.state.windows.get(id) ?? (await this.#listWindows(use)).get(id);
    if (!known) throw new ComputerError("stale", `Box ${use.box.name} has no window ${id}.`, "Call computer_windows to see its windows.");
    return known;
  }

  /** Forgets a window that closed. */
  #lost(state: BoxState, id: number): void {
    state.windows.delete(id);
    state.snapshots.delete(id);
    state.images.delete(id);
  }

  /**
   * Reads a window's tree. The screenshot comes too when the agent asked for
   * it, or holds an image of the window: Cua measures pixel actions against
   * the screenshot it took last.
   */
  async #read(use: Use, id: number, show: boolean): Promise<Read> {
    const window = await this.#window(use, id);
    const held = use.state.images.get(id);
    const screenshot = show || !!held;
    const args: Json = { pid: window.pid, window_id: id, include_screenshot: screenshot, timeout_ms: WALK_MS };
    let { result, live } = await this.#call(use, "get_window_state", args, { readOnly: true });
    let image = screenshot && !result.isError ? imageOf(result) : null;
    if (image && Math.max(image.width, image.height) > IMAGE_MAX_EDGE) {
      ({ result, live } = await this.#call(use, "get_window_state", { ...args, max_image_dimension: IMAGE_MAX_EDGE }, { readOnly: true }));
      image = result.isError ? null : imageOf(result);
    }
    if (result.isError) {
      const detail = textOf(result);
      if (/stale or no longer running|no longer running|not found/i.test(detail)) {
        this.#lost(use.state, id);
        throw new ComputerError("stale", `Window ${id} has closed.`, "Call computer_windows to see the windows open now.");
      }
      throw new ComputerError("driver", `Cua Driver could not read window ${id}: ${detail}`, "Call computer_windows to check the window, then try again.");
    }
    const snapshot = this.#snapshot(use.state, window, live.generation, obj(result.structuredContent), image);
    const dropped = !!held && (!image || !sameSize(held, image));
    if (dropped) use.state.images.delete(id);
    return { snapshot, image: show ? image : null, dropped: dropped && !show };
  }

  #snapshot(state: BoxState, window: WindowInfo, generation: number, structured: Json, image: Size | null): Snapshot {
    const bounds = obj(structured.window_bounds);
    const updated: WindowInfo = {
      ...window,
      app: str(structured.app_name) ?? window.app,
      title: str(structured.window_title) ?? window.title,
      width: num(bounds.width) ?? window.width,
      height: num(bounds.height) ?? window.height,
    };
    state.windows.set(window.id, updated);

    const raw = arr(structured.elements).map(obj);
    const byIndex = new Map<number, Json>();
    for (const entry of raw) {
      const index = num(entry.element_index);
      if (index !== undefined) byIndex.set(index, entry);
    }
    const prints = new Map<number, string>();
    const chain = (index: number, seen: Set<number>): string => {
      const known = prints.get(index);
      if (known !== undefined) return known;
      const entry = byIndex.get(index)!;
      const parent = num(entry.parent_index);
      const up = parent !== undefined && byIndex.has(parent) && !seen.has(parent) ? chain(parent, seen.add(index)) : "";
      const print = createHash("sha256")
        .update(JSON.stringify([str(entry.role) ?? "", str(entry.label) ?? "", up]))
        .digest("base64url")
        .slice(0, 22);
      prints.set(index, print);
      return print;
    };
    const counts = new Map<string, number>();
    for (const index of byIndex.keys()) {
      const print = chain(index, new Set());
      counts.set(print, (counts.get(print) ?? 0) + 1);
    }
    let named = state.named.get(window.id);
    if (!named) {
      named = new Map();
      state.named.set(window.id, named);
    }
    const elements: Element[] = [];
    const byRef = new Map<string, Element>();
    const elementAt = new Map<number, Element>();
    for (const [index, entry] of byIndex) {
      const fingerprint = prints.get(index)!;
      const unique = counts.get(fingerprint) === 1;
      let ref = unique ? named.get(fingerprint) : undefined;
      if (!ref) {
        ref = `e${state.nextRef++}`;
        if (unique) named.set(fingerprint, ref);
      }
      const role = str(entry.role) ?? "";
      const label = str(entry.label) ?? "";
      const element: Element = { index, ref, token: str(entry.element_token) ?? null, role, label, fingerprint, unique };
      elements.push(element);
      byRef.set(ref, element);
      elementAt.set(index, element);
      state.refs.delete(ref);
      state.refs.set(ref, { windowId: window.id, fingerprint, unique, describe: describe(role, label) });
    }
    for (const ref of state.refs.keys()) {
      if (state.refs.size <= MAX_REFS) break;
      state.refs.delete(ref);
    }

    const lines: Line[] = [];
    for (const text of (str(structured.tree_markdown) ?? "").split("\n")) {
      if (!text.trim()) continue;
      const indexed = /^(\s*)- \[(\d+)\] (.*)$/.exec(text);
      if (indexed) {
        const element = elementAt.get(Number(indexed[2])) ?? null;
        const rest = indexed[3]!.replace(" [actions=[]]", "");
        lines.push({ text: `${indexed[1]}- ${element ? `[${element.ref}] ` : ""}${rest}`, depth: indexed[1]!.length / 2, element });
      } else if (/^\s*- /.test(text) || !lines.length) {
        lines.push({ text, depth: (/^\s*/.exec(text)![0].length) / 2, element: null });
      } else {
        // A name with a line break goes on over several lines.
        const last = lines[lines.length - 1]!;
        lines[lines.length - 1] = { ...last, text: `${last.text}\n${text}` };
      }
    }

    const overlays: string[] = [];
    for (const dialog of arr(structured.dialogs).map(obj)) {
      const id = num(dialog.window_id);
      if (id === undefined) continue;
      this.#overlay(state, dialog, num(dialog.owning_pid) ?? window.pid);
      const title = str(dialog.title) ? ` "${str(dialog.title)}"` : "";
      overlays.push(`A${dialog.modal === true ? " modal" : ""} dialog${title}, window ${id}, is open over this window.`);
    }
    for (const popup of arr(structured.popups).map(obj)) {
      const id = num(popup.window_id);
      if (id === undefined) continue;
      this.#overlay(state, popup, num(popup.pid) ?? window.pid);
      overlays.push(`A popup, window ${id}, is open over this window.`);
    }

    const complete = structured.elements_complete !== false && structured.truncated !== true;
    const snapshot: Snapshot = {
      window: updated,
      generation,
      id: str(structured.snapshot_id) ?? null,
      elements,
      byRef,
      lines,
      partial: complete ? null : (str(structured.truncation_reason) ?? "it took too long"),
      screenshot: image ? { width: image.width, height: image.height } : null,
      overlays,
    };
    state.snapshots.set(window.id, snapshot);
    return snapshot;
  }

  /** Remembers a dialog's or popup's window, which a window list may not show. */
  #overlay(state: BoxState, raw: Json, pid: number): void {
    const found = windowOf({ ...raw, pid });
    if (found && !state.windows.has(found.id)) state.windows.set(found.id, found);
  }

  /** Popups an action opened, in words. */
  #popups(use: Use, result: McpResult, pid: number | undefined): string[] {
    const structured = obj(result.structuredContent);
    const raws = arr(structured.popups).length ? arr(structured.popups) : structured.popup && typeof structured.popup === "object" ? [structured.popup] : [];
    const found: string[] = [];
    for (const raw of raws.map(obj)) {
      const id = num(raw.window_id);
      const owner = num(raw.pid) ?? pid;
      if (id === undefined || owner === undefined) continue;
      this.#overlay(use.state, raw, owner);
      found.push(`A popup opened: window ${id}. Observe it to act on its items.`);
    }
    return found;
  }

  /** The tree text of a snapshot, cut to `limit` elements. */
  #tree(snapshot: Snapshot, query: string | undefined, limit: number): string {
    const { lines } = snapshot;
    let chosen = lines.map((_line, index) => index);
    let matched = 0;
    if (query?.trim()) {
      const wanted = query.trim().toLowerCase();
      const keep = new Set<number>();
      for (let index = 0; index < lines.length; index++) {
        if (!flat(lines[index]!).toLowerCase().includes(wanted)) continue;
        matched++;
        keep.add(index);
        // Its ancestors, for context: the nearest line above at each shallower depth.
        let depth = lines[index]!.depth;
        for (let up = index - 1; up >= 0 && depth > 0; up--) {
          if (lines[up]!.depth < depth) {
            keep.add(up);
            depth = lines[up]!.depth;
          }
        }
      }
      chosen = [...keep].sort((a, b) => a - b);
    }
    const shown: string[] = [];
    let elements = 0;
    let chars = 0;
    let cut = false;
    for (const index of chosen) {
      const line = lines[index]!;
      if ((line.element && elements >= limit) || chars + line.text.length > TREE_MAX_CHARS) {
        cut = true;
        break;
      }
      if (line.element) elements++;
      chars += line.text.length + 1;
      shown.push(line.text);
    }
    const { window } = snapshot;
    const header = [`${windowLine(window)[0]!.toUpperCase()}${windowLine(window).slice(1)}. ${snapshot.elements.length} elements.`];
    if (snapshot.partial) header.push(`Cua stopped reading the tree early (${snapshot.partial}), so some elements are missing.`);
    if (query?.trim()) {
      header.push(matched ? `${matched} line${matched === 1 ? "" : "s"} match "${query.trim()}", shown with their ancestors.` : `Nothing matches "${query.trim()}".`);
    }
    if (cut) header.push(`Partial: showing ${elements} of them. Pass query to find an element, or a larger limit.`);
    const parts = [header.join(" ")];
    if (shown.length) parts.push(shown.join("\n"));
    if (snapshot.overlays.length) parts.push(snapshot.overlays.join(" "));
    return parts.join("\n\n");
  }

  /** Finds a reference in the window's latest snapshot, reading the window again when its tokens are from an earlier session. */
  async #element(use: Use, ref: string): Promise<{ snapshot: Snapshot; element: Element }> {
    const name = refName(ref);
    const entry = use.state.refs.get(name);
    if (!entry) {
      throw new ComputerError(
        "stale",
        `bb-box has no reference ${name} for box ${use.box.name}. References last until a person takes control of the desktop or the box stops.`,
        "Call computer_observe to get references.",
      );
    }
    let snapshot = use.state.snapshots.get(entry.windowId);
    if (!snapshot || snapshot.generation !== use.state.live?.generation) {
      snapshot = (await this.#read(use, entry.windowId, false)).snapshot;
    }
    const direct = snapshot.byRef.get(name);
    if (direct) return { snapshot, element: direct };
    const matches = entry.unique ? snapshot.elements.filter((element) => element.fingerprint === entry.fingerprint) : [];
    if (matches.length === 1) return { snapshot, element: matches[0]! };
    throw new ComputerError("stale", `${name} (${entry.describe}) is no longer on screen. Call computer_observe again.`, null);
  }

  #token(snapshot: Snapshot, element: Element): Json {
    return element.token ? { element_token: element.token } : { element_index: element.index, snapshot_id: snapshot.id };
  }

  /** What an action aims at: an element, pixels of a window's latest image, or pixels of the desktop's. */
  async #target(use: Use, input: ActInput): Promise<{ args: Json; label: string; snapshot: Snapshot | null; element: Element | null }> {
    if (input.ref !== undefined) {
      if (input.x !== undefined || input.y !== undefined) throw new ComputerError("input", "Give ref, or x and y, not both.", null);
      const { snapshot, element } = await this.#element(use, input.ref);
      return {
        args: { pid: snapshot.window.pid, window_id: snapshot.window.id, ...this.#token(snapshot, element) },
        label: `${element.ref} (${describe(element.role, element.label)})`,
        snapshot,
        element,
      };
    }
    if (input.x === undefined || input.y === undefined || input.window === undefined) {
      throw new ComputerError("input", "Give ref, or window with x and y.", "Get references from computer_observe, or pixels from computer_screenshot.");
    }
    const { x, y, window } = input;
    const held = use.state.images.get(window);
    const name = window === "desktop" ? "the desktop" : `window ${window}`;
    if (!held) {
      throw new ComputerError(
        "stale",
        `You have no current image of ${name}, so bb-box cannot tell what x and y mean.`,
        `Call computer_screenshot with window ${window === "desktop" ? '"desktop"' : window}, then give pixels of that image.`,
      );
    }
    if (x < 0 || y < 0 || x >= held.width || y >= held.height) {
      throw new ComputerError("input", `x and y must be inside the image of ${name}: x from 0 to ${held.width - 1}, y from 0 to ${held.height - 1}.`, null);
    }
    if (window === "desktop") {
      // Cua takes the desktop's pixels in the screen's own.
      const screen = held.screen ?? held;
      const sx = Math.round((x * screen.width) / held.width);
      const sy = Math.round((y * screen.height) / held.height);
      return { args: { x: sx, y: sy, scope: "desktop" }, label: `(${x}, ${y}) on the desktop`, snapshot: null, element: null };
    }
    let snapshot = use.state.snapshots.get(window);
    if (!snapshot || snapshot.generation !== use.state.live?.generation || !snapshot.screenshot) {
      const read = await this.#read(use, window, false);
      snapshot = read.snapshot;
      if (read.dropped) {
        throw new ComputerError("stale", `Window ${window} changed size since your image of it, so its pixels no longer match.`, `Take a new image with computer_screenshot, window ${window}.`);
      }
    }
    if (!snapshot.screenshot || !sameSize(snapshot.screenshot, held)) {
      use.state.images.delete(window);
      throw new ComputerError("stale", `Window ${window} changed size since your image of it, so its pixels no longer match.`, `Take a new image with computer_screenshot, window ${window}.`);
    }
    return { args: { pid: snapshot.window.pid, window_id: window, x, y }, label: `(${x}, ${y}) in window ${window}`, snapshot, element: null };
  }

  /** Reads the window again after an action and says what changed. */
  async #changes(use: Use, before: Snapshot, readBack: string | null = null): Promise<{ text: string; hints: string[] }> {
    const id = before.window.id;
    let read: Read;
    try {
      read = await this.#read(use, id, false);
    } catch (error) {
      if (error instanceof ComputerError && error.code === "stale") {
        return { text: `Window ${id} closed.`, hints: ["Call computer_windows to see the windows open now."] };
      }
      if (error instanceof ComputerError && (error.code === "paused" || error.code === "interrupted")) {
        return { text: "A person took control of the desktop before bb-box could read what changed.", hints: ["Wait until they hand control back, then call computer_observe."] };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { text: `bb-box could not read what changed: ${message}`, hints: [`Call computer_observe with window ${id}.`] };
    }
    const after = read.snapshot;
    const parts: string[] = [];
    const listed = diff(before, after);
    if (!listed.length) parts.push(`Nothing changed in window ${id}'s tree.`);
    else {
      const shown = listed.slice(0, CHANGES_MAX_LINES);
      const more = listed.length - shown.length;
      parts.push(`What changed in window ${id} (+ appeared, - went, ~ changed):\n${shown.join("\n")}${more ? `\n...and ${more} more. Call computer_observe to see the whole window.` : ""}`);
    }
    if (after.window.title !== before.window.title) parts.push(`The window's title is now "${after.window.title}".`);
    if (readBack) {
      const line = after.lines.find((candidate) => candidate.element?.ref === readBack);
      parts.push(line ? `${readBack} now reads: ${flat(line)}` : `${readBack} is no longer in the tree.`);
    }
    if (after.overlays.length) parts.push(after.overlays.join(" "));
    if (after.partial) parts.push(`Cua stopped reading the tree early (${after.partial}), so this may miss changes.`);
    if (read.dropped) parts.push(`Window ${id} changed size, so your last image of it no longer applies.`);
    const hints = [`Call computer_observe with window ${id} for the whole tree.`];
    if (after.overlays.length) hints.push("Observe a dialog or popup by its window ID to act in it.");
    return { text: parts.join("\n\n"), hints };
  }
}

const FOREGROUND = ", in the foreground because Cua could not do it in the background, so the pointer or focus may have moved";

/**
 * Lines that appeared, went or changed between two snapshots of a window.
 * Elements whose references carried over are matched by reference; other
 * lines by their text.
 */
function diff(before: Snapshot, after: Snapshot): string[] {
  const keyed = (snapshot: Snapshot) => new Map(snapshot.lines.filter((line) => line.element?.unique).map((line) => [line.element!.ref, line] as const));
  const loose = (snapshot: Snapshot) => snapshot.lines.filter((line) => !line.element?.unique);
  const was = keyed(before);
  const now = keyed(after);
  const out: string[] = [];
  const bare = (line: Line) => flat(line).replace(/^\[e\d+\] /, "");
  for (const [ref, line] of now) {
    const old = was.get(ref);
    if (!old) out.push(`+ ${flat(line)}`);
    else if (bare(old) !== bare(line)) out.push(`~ ${flat(line)}`);
  }
  for (const [ref, line] of was) if (!now.has(ref)) out.push(`- ${flat(line)}`);
  const counts = new Map<string, number>();
  for (const line of loose(before)) counts.set(bare(line), (counts.get(bare(line)) ?? 0) + 1);
  for (const line of loose(after)) {
    const left = counts.get(bare(line)) ?? 0;
    if (left > 0) counts.set(bare(line), left - 1);
    else out.push(`+ ${flat(line)}`);
  }
  for (const line of loose(before)) {
    const left = counts.get(bare(line)) ?? 0;
    if (left > 0) {
      counts.set(bare(line), left - 1);
      out.push(`- ${flat(line)}`);
    }
  }
  return out;
}
