// Computer use (015). The agent drives a desktop box through bb-box's six
// computer tools, and bb-box drives the Cua Driver in the box over one MCP
// session per box. bb-box owns the references the agent sees, keeps pixels
// with the image they came from, retries in the foreground an action Cua
// cannot do in the background, says which menus and popups an action opened
// or closed, and refuses everything while a person holds the box's desktop.
// The agent never sees Cua's own words for what went wrong.

import { createHash } from "node:crypto";
import type { ByteChannel, GuestOs } from "../transports/types.ts";
import { currentKindId, kindInfo } from "../backends/kinds.ts";
import { BoxError, type BoxRecord } from "./boxes.ts";
import type { Owner } from "./control.ts";
import { driverCommand } from "./in-box.ts";
import { McpClosedError, McpError, McpSession, type McpResult } from "./mcp.ts";

export const PAUSED =
  "Paused: a person has taken control of this box's desktop in BB. The computer tools will work again when they hand control back. " +
  "Nothing was done and the desktop is as they left it. Wait, or ask them in the thread. " +
  "Once they ask you to continue, or the thread makes clear they have finished, take control back with computer_take_control.";
export const RETURNED = "Control returned; the desktop may have changed. Observe before acting.";

/** The longest edge of an image the agent gets. */
export const IMAGE_MAX_EDGE = 1568;
/** Tree lines computer_observe shows unless the agent asks for more. */
export const TREE_LIMIT = 300;
export const TREE_LIMIT_MAX = 2_000;
const TREE_MAX_CHARS = 40_000;
/** A tree longer than this is worth a query. */
const TREE_LARGE = 100;
const CHANGES_MAX_LINES = 60;
const IDLE_MS = 10 * 60_000;
const PAUSE_WAIT_MS = 3_000;
const OPEN_TIMEOUT_MS = 15_000;
const CALL_TIMEOUT_MS = 30_000;
const LAUNCH_WAIT_MS = 10_000;
const LAUNCH_POLL_MS = 250;
const FINDER_WINDOW_WAIT_MS = 3_000;
/**
 * How long a launch on Wayland waits at most for its windows to be the
 * compositor's: Cua can list a new window from its accessibility side
 * before Sway maps it, under an ID it can never act on, and lists Sway's
 * own some 150 ms later.
 */
const COMPOSITOR_WAIT_MS = 2_000;
/**
 * How long a launch by an app's name asks again while Windows' shell cannot
 * look the name up yet, as just after a box starts: Cua gives up on the
 * shell:AppsFolder query after 4 s, launches nothing, and says to retry.
 */
const LOOKUP_WAIT_MS = 20_000;
const LOOKUP_POLL_MS = 2_000;
/**
 * After an action on a window that changed nothing in it, how long bb-box
 * waits before it looks once more whether the window has gone, as a dialog
 * closes a moment after its button is pressed.
 */
const LATE_CLOSE_MS = 250;
/** computer_windows starts the namer of untitled windows at most this often, unless the window list changed (#365). */
const NAME_EVERY_MS = 15_000;
/** How long a URL's window may keep a placeholder title while its page loads. */
const PAGE_WAIT_MS = 10_000;
/** How long an action on the desktop may take to open, close or retitle a window. */
const DESKTOP_WAIT_MS = 1_000;
/**
 * The most elements a window's tree may have to be read before and after an
 * action on the desktop. Reading a web page's can take seconds.
 */
const TREE_SMALL = 200;
/** How long a read of a small tree, or of a popup, may take. */
const GLANCE_MS = 1_000;
/** Lines of a popup that opened shown with it. */
const POPUP_LINES = 30;
/**
 * How far bb-box moves a window from another of its app's when Cua reads the
 * other's tree for it: Cua confuses windows up to about 20 pixels apart.
 */
const APART = 40;
/** Installed apps named when a launch fails. */
const APPS_SHOWN = 40;
/** How long Cua may walk a window's tree. */
const WALK_MS = 3_000;
/** References kept per box; the oldest go first. */
const MAX_REFS = 20_000;

/** How bb-box names itself to the driver. Cua does not read it. */
const CLIENT = { name: "bb-box", version: "1" };
const PAUSED_WHILE_RUNNING = "A person took control of the box's desktop while this ran, so bb-box closed its session with the driver.";
const AFTER_PAUSE = "Wait until they hand control back, or take it back with computer_take_control once they ask you to continue; then call computer_observe.";
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
  /**
   * Gives each window on a Windows box's desktop that has no title one,
   * as Cua lists and reads only windows with a title (#365), and returns
   * those it named. computer_windows and computer_launch ask it.
   */
  nameWindows?(box: BoxRecord, signal?: AbortSignal): Promise<readonly { readonly id: number; readonly title: string }[]>;
  /**
   * Puts text on the clipboard of a Sway desktop for a paste into window
   * `windowId`, the clipboard's text saved (swayStageScript), as typing
   * there loses characters (#707). Says whether the window is a terminal,
   * which pastes with Ctrl+Shift+V, or "unsupported" on a box without Sway,
   * which Cua types for.
   */
  stageText?(box: BoxRecord, input: { readonly windowId: number; readonly text: string }, signal?: AbortSignal): Promise<"terminal" | "app" | "unsupported">;
  /**
   * Types text into window `windowId` on a Sway desktop with the image's US
   * keyboard (swayKeyboardScript), focused first if it is not. "unsupported"
   * where the image has none, or the text has a character the US layout
   * lacks: stageText pastes it then (#707).
   */
  keyText?(box: BoxRecord, input: { readonly windowId: number; readonly text: string }, signal?: AbortSignal): Promise<"typed" | "unsupported">;
  /** Puts back the clipboard's text that stageText saved (swayRestoreScript). */
  restoreClipboard?(box: BoxRecord, signal?: AbortSignal): Promise<void>;
  /** Who controls the box's desktop now. */
  owner(boxId: string): Owner;
  /** Takes control of the box's desktop back from a person (038). False when the agent had it already. */
  takeBack(boxId: string): Promise<boolean>;
  logError(operation: string, error: unknown): void;
  readonly idleMs?: number;
  readonly pauseWaitMs?: number;
  readonly callTimeoutMs?: number;
  readonly launchWaitMs?: number;
  /** How long a launch asks again while Windows cannot look an app's name up yet. */
  readonly lookupWaitMs?: number;
  readonly pageWaitMs?: number;
  readonly desktopWaitMs?: number;
  readonly smallTree?: number;
}

/** A window ID from computer_windows, or the whole desktop. */
export type WindowRef = number | "desktop";
export type Action = "click" | "double_click" | "right_click" | "scroll" | "set_value" | "key";
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
  /** For key: a key or chord, as computer_type takes it. */
  readonly keys?: string;
}

export interface TypeInput {
  readonly text?: string;
  readonly keys?: string;
  readonly ref?: string;
  /** Without ref: the window whose focused element gets the input, or the desktop, for whatever has the focus. */
  readonly window?: WindowRef;
}

interface Size {
  readonly width: number;
  readonly height: number;
}

/** A box on the screen, in the screen's pixels. */
interface Rect extends Size {
  readonly x: number;
  readonly y: number;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

interface WindowInfo extends Rect {
  readonly id: number;
  readonly pid: number;
  readonly app: string;
  readonly title: string;
  readonly onScreen: boolean;
  /** Its place in the stack: higher is on top. */
  readonly z: number;
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
  /**
   * A hash of its place in the tree: its role and its ancestors', and for
   * each, how many siblings of its role come before it. Names count only for
   * it and ancestors that share their role with a sibling, such as a list's
   * rows. The others' names change as a document is edited: an editor's only
   * tab, or a text area named after its text. A row's name stays, so a button
   * in a list whose rows all changed is not the old row's (023). Null when
   * another element of its snapshot has it too.
   */
  readonly place: string | null;
  /** Where it is on the screen, when the driver says. */
  readonly frame: Rect | null;
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
  /** Dialogs open over the window. */
  readonly dialogs: readonly Dialog[];
  /** Popups open over the window, such as its menus, which the window list leaves out. */
  readonly popups: readonly WindowInfo[];
}

interface Dialog {
  readonly id: number;
  readonly title: string;
  readonly modal: boolean;
}

/** A popup seen open, and the window whose reads list it. */
interface Open {
  readonly window: WindowInfo;
  readonly over: number;
}

interface Popup extends Open {
  /** What bb-box told the agent it is, such as "the menu Applications"; null when it only listed it. */
  readonly what: string | null;
}

/** What the desktop looked like before an action on it or in a popup. */
interface Watch {
  readonly windows: Map<number, WindowInfo>;
  /** The windows whose reads list the popups bb-box looks for. */
  readonly owners: readonly WindowInfo[];
  readonly popups: Map<number, Open>;
  /** The window or popup under the point. */
  readonly under: WindowInfo | null;
  /** The tree of the window under the point, when it is small enough to read quickly. */
  readonly tree: Snapshot | null;
  /** The named element under the point, when bb-box read it. */
  readonly element: Element | null;
}

/** What an action was done on, for naming a popup it opened. */
interface Cause {
  readonly element: Element | null;
  readonly right: boolean;
}

interface RefEntry {
  readonly windowId: number;
  readonly fingerprint: string;
  readonly unique: boolean;
  readonly describe: string;
  /** Its element's role and name as bb-box last showed them to the agent; null before it did (024). */
  readonly shown: string | null;
}

/** An image the agent was given, with the size of the screen or window it shows, in their own pixels. */
interface Held extends Size {
  readonly source: Size;
  /** For the desktop: the session whose Cua maps its pixels by it. */
  readonly generation?: number;
}

interface Changes {
  /** What changed, in words; when nothing did, says so, or anything else asked for. */
  readonly parts: string[];
  readonly hints: string[];
  /** Whether anything was seen to change. */
  readonly changed: boolean;
  /** The window as it is now, when bb-box could read it. */
  readonly after: Snapshot | null;
}

interface Target {
  readonly args: Json;
  readonly label: string;
  readonly snapshot: Snapshot | null;
  readonly element: Element | null;
  readonly coordinates?: string;
  readonly screen?: Point;
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
  /** Popups seen open, by window ID, until they are seen closed. */
  readonly popups: Map<number, Popup>;
  /** Windows whose trees are too large to read around an action on the desktop. */
  readonly large: Set<number>;
  /** The namer of untitled windows on a Windows box, while it runs; one at a time (#365). */
  naming: Promise<void> | null;
  /** When computer_windows last started the namer, and the windows Cua listed then. */
  lastNaming: { readonly at: number; readonly windows: string } | null;
  /** Titles the namer gave in the background, by window ID, until computer_windows says so. */
  readonly titled: Map<number, string>;
  /** On Linux, windows where the last action could have selected text: a key chord or a double-click. */
  readonly selecting: Set<number>;
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
  /** What bb-box said when it moved the window so that Cua could read it; null when it did not. */
  readonly moved: string | null;
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

/** Advice in Cua's words: its own tools and arguments, which the agent does not have. */
const CUA_ADVICE =
  /\b(call|use|pass|refresh|retry|round-trip|try)\b[\s\S]*\b(list_apps|list_windows|launch_app|launch_path|get_window_state|get_desktop_state|bundle_id|element_index|element_token|snapshot_id|delivery_mode|capture_id|max_image_dimension)\b/i;

/** Cua's text, as it gave it. */
function rawText(result: McpResult): string {
  return result.content
    .filter((part) => part.type === "text" && part.text)
    .map((part) => part.text!.trim())
    .join(" ");
}

/**
 * A click Cua made, which another process's window then came in front of,
 * as Explorer's hidden-icons panel or an app's tray menu does (#484). On
 * Windows, Cua checks after a click that the window it clicked, or one of
 * its process's, is in front, and says it failed when not, though the click
 * landed. bb-box takes it as done, and says which window came forward.
 */
export function landedElsewhere(result: McpResult): { forward: number | null } | null {
  const raw = rawText(result);
  if (!result.isError || !/\bwas not foreground after the click\b/i.test(raw)) return null;
  const forward = /\bactual foreground HWND (0x[0-9a-f]+|\d+)/i.exec(raw);
  return { forward: forward ? Number(forward[1]) : null };
}

/** Cua's code for a refusal, such as "foreground_unavailable". */
function codeOf(result: McpResult): string | undefined {
  const structured = obj(result.structuredContent);
  return str(structured.code) ?? str(obj(structured.refusal).code);
}

/**
 * Why Cua did not do something, in bb-box's words: without its codes, its
 * tools and its advice, which the agent does not have, and with window IDs
 * as computer_windows gives them.
 */
export function explain(result: McpResult): string {
  const raw = rawText(result);
  const window = /\bwindow (0x[0-9a-f]+|\d+)/i.exec(raw);
  switch (codeOf(result)) {
    case "foreground_unavailable":
      return `${window ? `Window ${Number(window[1])}` : "The window"} could not be made the active window, so nothing was sent to it.`;
    case "stale_element_token":
      return "The element changed since bb-box last read its window, so nothing was done.";
  }
  if (/^capture error\b/i.test(raw)) return `The desktop could not take an image of ${window ? `window ${Number(window[1])}` : "it"}.`;
  const text = raw
    .replace(/^[a-z]+(?:_[a-z]+)+:\s*/, "")
    .replace(/\bwindow (0x[0-9a-f]+)\b/gi, (_all, id: string) => `window ${Number(id)}`)
    .replace(/\s*[([][^()[\]]*[)\]]/g, (group) => (group.includes("=") || namesCua(group) ? "" : group))
    .split(/(?<=[.;!?])\s+|\s+[\u2013\u2014]\s+/)
    .filter((clause) => !CUA_ADVICE.test(clause) && !namesCua(clause))
    .join(" ")
    .trim()
    .replace(/[;,:]$/, "");
  if (!text) return "The desktop gave no reason.";
  const said = sentence(`${text[0]!.toUpperCase()}${text.slice(1)}`);
  return said.length > 500 ? `${said.slice(0, 500)}...` : said;
}

/** Whether text names Cua, or its tools and parameters by their snake_case words; paths and file names do not count. */
function namesCua(text: string): boolean {
  return /\b[a-z]+_[a-z_]+\b|\bCua\b/i.test(text.replace(/\S*(?:[/\\]|\w\.\w)\S*/g, ""));
}

/** What to do after a refusal, by Cua's code. */
function adviceFor(code: string | undefined): string {
  switch (code) {
    case "foreground_unavailable":
      return (
        "It may be minimized, on another workspace or under a dialog: click it on the desktop first, or act in the dialog over it. " +
        'For a menu or popup, give its window ID, or window "desktop" for keys.'
      );
    case "stale_element_token":
      return "Try again: bb-box reads the window first.";
    default:
      return "Call computer_observe to see the window, then try another way.";
  }
}

/** Chrome puts U+FFFC in text where an object such as a link sits; it tells the agent nothing. */
function clean(text: string): string {
  return text.replace(/ ?\uFFFC+/g, "");
}

/** How an image's pixels map to the screen's or the window's. */
function coordinates(image: Size, source: Size, of: "screen" | "window"): string {
  const scale = source.width > 0 ? Math.round((image.width / source.width) * 1000) / 1000 : 1;
  return `Image ${image.width}x${image.height} of ${of} ${source.width}x${source.height}, scale ${scale}; x and y are image pixels.`;
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
  return /^Background delivery is not available/.test(rawText(result));
}

/**
 * Cua on Windows could not look an app's name up in the shell for now, and
 * launched nothing: the shell did not answer in time, or an earlier lookup
 * still runs or cools down. Asking again later works.
 */
function lookupBusy(result: McpResult): boolean {
  return !!result.isError && /\bApp name lookup for .* is temporarily unavailable\b[\s\S]*\bNo app was launched\b/i.test(rawText(result));
}

/**
 * Cua found no action to click an element by, and could not click it as a
 * pointer does: on Wayland it tries X11, which is not there (048).
 */
function cannotInject(result: McpResult): boolean {
  return !!result.isError && /\bcannot inject input\b/i.test(rawText(result));
}

/**
 * Cua handed the launch to the app's running instance, as D-Bus activation
 * does for a single-instance app on Linux, and no new window appeared.
 */
function handedOff(result: McpResult): boolean {
  return !!result.isError && (obj(result.structuredContent).code === "launch_handoff_timeout" || /\bhanded off\b/i.test(rawText(result)));
}

/** The window Cua's agent cursor is drawn in on Windows. It covers the screen above the desktop, and is not an app's. */
const CURSOR_OVERLAY = /^Cua\.AgentCursorOverlay\b/;

function windowOf(value: unknown): WindowInfo | null {
  const raw = obj(value);
  const id = num(raw.window_id);
  const pid = num(raw.pid);
  if (id === undefined || pid === undefined || CURSOR_OVERLAY.test(str(raw.title) ?? "")) return null;
  const bounds = obj(raw.bounds);
  return {
    id,
    pid,
    app: str(raw.app_name) ?? "",
    title: str(raw.title) ?? "",
    width: num(bounds.width) ?? num(raw.width) ?? 0,
    height: num(bounds.height) ?? num(raw.height) ?? 0,
    onScreen: raw.is_on_screen !== false,
    x: num(bounds.x) ?? num(raw.x) ?? 0,
    y: num(bounds.y) ?? num(raw.y) ?? 0,
    z: num(raw.z_index) ?? 0,
  };
}

/** The popups an action's result lists. */
function popupsIn(result: McpResult | null, pid: number): WindowInfo[] {
  if (!result) return [];
  const structured = obj(result.structuredContent);
  const listed = arr(structured.popups).length ? structured.popups : structured.popup && typeof structured.popup === "object" ? [structured.popup] : [];
  return popupsOf({ popups: listed }, pid);
}

/** The popups a read of a window lists, but not those too small or too far off the screen to be seen. */
function popupsOf(structured: Json, pid: number): WindowInfo[] {
  return arr(structured.popups)
    .map((raw) => windowOf({ ...obj(raw), pid: num(obj(raw).pid) ?? pid }))
    .filter((popup): popup is WindowInfo => !!popup && popup.width > 10 && popup.height > 10 && popup.x + popup.width > 0 && popup.y + popup.height > 0);
}

/** A frame on the screen, as Cua gives it: x and y, and w and h or width and height. */
function rectOf(value: unknown): Rect | null {
  const raw = obj(value);
  const x = num(raw.x);
  const y = num(raw.y);
  const width = num(raw.w) ?? num(raw.width);
  const height = num(raw.h) ?? num(raw.height);
  return x === undefined || y === undefined || width === undefined || height === undefined ? null : { x, y, width, height };
}

/**
 * A Wayland window's element frames on the screen. Cua gives them in the
 * screen's pixels, but in the window's own for a GTK 3 app, which does not
 * know where its window is, and says "window" for both (048). The reading
 * that puts more of the frames inside the window holds for a frame that both
 * readings, or neither, put there. Elsewhere frames are always the screen's,
 * and one above or left of the window is an element scrolled out of it, so
 * only a Wayland window's frames come here.
 */
function screenFrames<K>(frames: ReadonlyMap<K, Rect | null>, window: Rect): Map<K, Rect | null> {
  const slack = 2;
  const within = (frame: Rect) =>
    frame.x >= window.x - slack && frame.y >= window.y - slack && frame.x + frame.width <= window.x + window.width + slack && frame.y + frame.height <= window.y + window.height + slack;
  const moved = (frame: Rect): Rect => ({ ...frame, x: frame.x + window.x, y: frame.y + window.y });
  let own = 0;
  let screen = 0;
  for (const frame of frames.values()) {
    if (frame && within(moved(frame))) own++;
    if (frame && within(frame)) screen++;
  }
  const placed = (frame: Rect) => {
    const asOwn = within(moved(frame));
    return asOwn === within(frame) ? (own > screen ? moved(frame) : frame) : asOwn ? moved(frame) : frame;
  };
  return new Map([...frames].map(([key, frame]) => [key, frame && placed(frame)]));
}

function inside(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.y >= rect.y && point.x < rect.x + rect.width && point.y < rect.y + rect.height;
}

/**
 * Whether a read of a popup's window gave the popup's own elements: they
 * fill it. For a submenu or a tooltip, Cua can give another window's
 * elements, moved to where the popup is.
 */
function fills(structured: Json, popup: Rect): boolean {
  const frames = arr(structured.elements)
    .map((raw) => rectOf(obj(raw).frame))
    .filter((frame): frame is Rect => !!frame && frame.width > 0 && frame.height > 0);
  if (!frames.length) return false;
  const left = Math.min(...frames.map((frame) => frame.x));
  const top = Math.min(...frames.map((frame) => frame.y));
  const right = Math.max(...frames.map((frame) => frame.x + frame.width));
  const bottom = Math.max(...frames.map((frame) => frame.y + frame.height));
  const near = (a: number, b: number, size: number) => Math.abs(a - b) <= Math.max(8, size * 0.15);
  return (
    near(left, popup.x, popup.width) &&
    near(right, popup.x + popup.width, popup.width) &&
    near(top, popup.y, popup.height) &&
    near(bottom, popup.y + popup.height, popup.height)
  );
}

/** The smallest named element of a snapshot at a point of the screen. */
function elementAt(snapshot: Snapshot | null | undefined, point: Point): Element | null {
  let found: Element | null = null;
  for (const element of snapshot?.elements ?? []) {
    const frame = element.frame;
    if (!element.label || !frame || !inside(frame, point)) continue;
    if (!found || frame.width * frame.height < found.frame!.width * found.frame!.height) found = element;
  }
  return found;
}

/** Windows that opened, closed, or changed title or size, between two window lists. */
function windowChanges(before: ReadonlyMap<number, WindowInfo>, after: ReadonlyMap<number, WindowInfo>): string[] {
  const shown = (window: WindowInfo) => window.width > 1 && window.height > 1;
  const out: string[] = [];
  for (const [id, window] of after) {
    const old = before.get(id);
    if (!old) {
      if (shown(window)) out.push(`+ ${windowLine(window)}`);
    } else if (old.title !== window.title || old.width !== window.width || old.height !== window.height || old.onScreen !== window.onScreen) {
      out.push(`~ ${windowLine(window)}${old.title !== window.title ? `, was "${old.title}"` : ""}`);
    }
  }
  for (const [id, window] of before) if (!after.has(id) && shown(window)) out.push(`- ${windowLine(window)}`);
  return out;
}

/** The topmost window on screen at a point of the screen. */
function windowAt(windows: ReadonlyMap<number, WindowInfo>, point: Point): WindowInfo | null {
  let found: WindowInfo | null = null;
  for (const window of windows.values()) {
    if (!window.onScreen || !inside(window, point)) continue;
    if (!found || window.z >= found.z) found = window;
  }
  return found;
}

/** Whether menu items appeared in a window's tree, as when a GTK app's menu opens. */
function menuItemsAppeared(before: Snapshot, after: Snapshot): boolean {
  const had = new Set(before.elements.map((element) => element.fingerprint));
  return after.elements.some((element) => /^menu ?item\b/i.test(element.role) && !had.has(element.fingerprint));
}

/** The name of the frame at the root of a tree, when it is not the window's title. */
function foreignFrame(structured: Json, title: string): string | null {
  const root = arr(structured.elements)
    .map(obj)
    .find((element) => num(element.parent_index) === undefined);
  if (!root || str(root.role) !== "frame") return null;
  const name = clean(str(root.label) ?? "").trim();
  return name && name !== clean(title).trim() ? name : null;
}

/** Chromium browsers on Windows, by program name or path. */
const WINDOWS_CHROMIUM = /(^|[\\/])(msedge|chrome|brave|microsoft edge|google chrome)(\.exe)?$/i;

/**
 * What launch_app gets for an app or a URL. A path has a slash, or on
 * Windows a backslash. On Windows a Chromium browser started by name or path
 * gets --force-renderer-accessibility, without which it shows Cua only its
 * toolbar (039); the template's link handler passes it for URLs, as Linux
 * templates wrap Chrome with it.
 */
export function launchArgs(os: GuestOs, input: { app?: string; url?: string }): Json {
  if (input.url !== undefined) return { urls: [input.url] };
  const app = input.app!;
  if (os === "macos" && isFinder(app)) return { bundle_id: FINDER, urls: ["~"] };
  const path = app.includes("/") || (os === "windows" && app.includes("\\"));
  const args: Json = path ? { launch_path: app } : { name: app };
  if (os === "windows" && WINDOWS_CHROMIUM.test(app.trim())) args.additional_arguments = ["--force-renderer-accessibility"];
  return args;
}

/**
 * Finder on macOS: it always runs, from /System/Library/CoreServices, where
 * Cua's lookup by name does not look, and opens a window only for a folder.
 * So a launch gives its bundle ID and the home folder, which opens a new
 * Finder window there (#712).
 */
const FINDER = "com.apple.finder";

/** True for Finder, by name, bundle ID or path. */
function isFinder(app: string): boolean {
  return /^(finder|com\.apple\.finder)$/i.test(appName(app));
}

/** An app's name as a launch gives it: Finder for Finder.app or /System/Library/CoreServices/Finder.app/. */
function appName(app: string): string {
  return app.trim().replace(/[\\/]+$/, "").replace(/^.*[\\/]/, "").replace(/\.app$/i, "");
}

/** Cua on macOS found no app of that name or bundle ID where it looks. */
function notInstalled(result: McpResult): boolean {
  return !!result.isError && (obj(result.structuredContent).error === "APP_NOT_INSTALLED" || /\bNo installed macOS app found\b/i.test(rawText(result)));
}

/** True when a window is the app a launch named, by name or path: mousepad, Mousepad or /usr/bin/mousepad, or an app ID such as org.xfce.mousepad. */
function sameApp(windowApp: string, app: string): boolean {
  const name = app.trim().replace(/^.*[\\/]/, "").replace(/\.(desktop|exe|app)$/i, "").toLowerCase();
  const own = windowApp.trim().toLowerCase();
  return !!name && (own === name || own.endsWith(`.${name}`));
}

/** Apps the launch refusal leaves out: settings panels and session actions, by their IDs and programs. */
const NOT_APPS = /settings|preferences|logout|log-out|lock-?screen|xflock|shutdown|reboot|suspend|hibernate/i;

/** Apps whose windows a URL may open in. */
const BROWSER = /chrom|firefox|browser|brave|edge|opera|vivaldi|epiphany|falkon|konqueror|midori|qutebrowser/i;

/**
 * A title a browser window shows before its page has one: none, a stock
 * one, or the page's address, as Chrome shows while it loads.
 */
function placeholder(title: string, url: string): boolean {
  const head = title.trim().replace(/\s+[-\u2013\u2014]\s+[^-\u2013\u2014]*$/, "").trim();
  if (!head || /^(untitled|new tab|about:blank|loading)\b/i.test(head)) return true;
  if (/\s/.test(head)) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    // Not a URL bb-box can take apart: only a scheme marks an address.
  }
  return head.includes("://") || (!!host && head.toLowerCase().replace(/^www\./, "").startsWith(host));
}

/**
 * Joins the pieces of one run of text: Chrome can give each word or each
 * letter of a page its own static line. Pieces that carry their own spaces
 * are joined as they are; words without them get one.
 */
function joinText(pieces: readonly string[]): string {
  const letters = pieces.every((piece) => [...piece.trim()].length <= 1);
  let out = "";
  for (const piece of pieces) {
    const tight = !out || letters || /\s$/.test(out) || /^\s/.test(piece) || /^[.,;:!?)\]}]/.test(piece) || /[(\[{]$/.test(out);
    out += tight ? piece : ` ${piece}`;
  }
  return out;
}

/** The line saying which listed windows bb-box gave a title, and why (#365); null for none. */
function namedLine(named: readonly { readonly id: number; readonly title: string }[], windows: readonly WindowInfo[]): string | null {
  const shown = named.filter((window) => windows.some((listed) => listed.id === window.id));
  if (!shown.length) return null;
  const which = shown.map((window) => `window ${window.id} the title "${window.title}"`);
  const list = which.length === 1 ? which[0] : `${which.slice(0, -1).join(", ")} and ${which.at(-1)}`;
  return `bb-box gave ${list}, as ${shown.length === 1 ? "it had" : "they had"} none, and Cua on Windows reaches only windows with a title.`;
}

export function windowLine(window: WindowInfo): string {
  const title = window.title ? ` "${window.title}"` : "";
  return `window ${window.id}: ${window.app || "an app"}${title}, ${window.width} by ${window.height}${window.onScreen ? "" : ", not on screen"}`;
}

function describe(role: string, label: string): string {
  return label ? `${role} '${label}'` : role;
}

function dialogLine(dialog: Dialog): string {
  const title = dialog.title ? ` "${dialog.title}"` : "";
  return `A${dialog.modal ? " modal" : ""} dialog${title}, window ${dialog.id}, is open over this window.`;
}

/**
 * Whether Cua read the whole tree. Its elements_complete is false whenever it
 * cannot prove that nothing is missing, as always on macOS and Windows, so its
 * truncated flag decides when it gives one.
 */
function whole(structured: Json): boolean {
  return typeof structured.truncated === "boolean" ? !structured.truncated : structured.elements_complete !== false;
}

/** Why Cua stopped reading a tree early, in words. */
function cutShort(reason: string): string {
  return /time|deadline|long/i.test(reason) ? `Reading the tree took longer than ${WALK_MS / 1000} s` : "bb-box read only part of the tree";
}

/** One line of the tree, for a list of changes: no indent, no list marker, on one line. */
function flat(line: Line): string {
  return line.text.trim().replace(/^- /, "").replace(/\s*\n\s*/g, " ");
}

/** App IDs of terminals, which paste with Ctrl+Shift+V. */
const TERMINALS = "foot|footclient|kitty|Alacritty|alacritty|org.wezfurlong.wezterm|xterm|XTerm|URxvt|konsole|org.kde.konsole|org.gnome.Terminal|org.gnome.Console|kgx|xfce4-terminal|Xfce4-terminal|terminator|Terminator|tilix|com.gexperts.Tilix|lxterminal|Lxterminal";

/**
 * Types `text` into Sway window `windowId` (Cua's window ID is Sway's
 * container ID) with the Wayland image's US keyboard, bb-box-type, after
 * focusing the window if it is not focused, as the box user. A bb-box-type
 * on the PATH comes first, as tests give one. Exits 3 where the image has
 * none or no Sway, or where the text has a character the US layout lacks,
 * which bb-box-type types none of (#707).
 */
export function swayKeyboardScript(windowId: number, text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
tool=$(command -v bb-box-type || echo /usr/local/libexec/bb-box/type)
[ -x "$tool" ] && tree=$(swaymsg -t get_tree 2>/dev/null) || exit 3
focused=$(printf %s "$tree" | python3 -c 'import json,sys
def walk(n):
    if n.get("focused"): print(n["id"]); return True
    return any(walk(c) for c in n.get("nodes",[])+n.get("floating_nodes",[]))
walk(json.load(sys.stdin))')
[ "$focused" = ${windowId} ] || swaymsg "[con_id=${windowId}] focus" >/dev/null || exit 4
printf %s ${encoded} | base64 -d | "$tool"`;
}

const CLIPBOARD_ENV = `set -a; [ ! -r /run/bb-box/display.env ] || . /run/bb-box/display.env; set +a
saved="\${XDG_RUNTIME_DIR:-$HOME}/.bb-box-clipboard"`;

/**
 * Puts `text` on the clipboard of a Sway desktop, as the box user, to be
 * pasted into window `windowId` (Cua's window ID is Sway's container ID),
 * after saving the clipboard's text for swayRestoreScript. Prints
 * "terminal" when the window is a terminal, which pastes with
 * Ctrl+Shift+V, and "app" otherwise. Exits 3 on a desktop without Sway,
 * or without wl-copy. Typing text there loses characters in Chrome,
 * whatever the form: wtype makes a keymap up as it goes, and Chrome
 * mishandles some of its keycodes.
 * Cua's `wtype -k Shift_L -- <text>` lost the "g" and "/" of
 * "wikipedia.org/wiki", and ":"; `wtype -s 150` lost every space of a
 * longer text. The paste key is Cua's, with its US keymap: GTK apps ignore
 * a Ctrl+V from wtype's (#707).
 */
export function swayStageScript(windowId: number, text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return `${CLIPBOARD_ENV}
command -v wl-copy >/dev/null && tree=$(swaymsg -t get_tree 2>/dev/null) || exit 3
umask 077; rm -f "$saved"
if timeout 2 wl-paste -l 2>/dev/null | grep -qx -e 'text/plain;charset=utf-8' -e text/plain -e UTF8_STRING; then
  timeout 2 wl-paste -n -t text > "$saved.new" 2>/dev/null && mv "$saved.new" "$saved"
fi
printf %s ${encoded} | base64 -d | wl-copy >/dev/null 2>&1 || exit 5
app=$(printf %s "$tree" | python3 -c 'import json,sys
def walk(n):
    if n["id"]==${windowId}: print(n.get("app_id") or (n.get("window_properties") or {}).get("class") or "-"); return True
    return any(walk(c) for c in n.get("nodes",[])+n.get("floating_nodes",[]))
walk(json.load(sys.stdin))')
case "$app" in ${TERMINALS}) echo terminal ;; *) echo app ;; esac`;
}

/**
 * Puts back the clipboard's text that swayStageScript saved, or clears the
 * clipboard if it held none, once the app has had time to read the paste.
 */
export function swayRestoreScript(): string {
  return `${CLIPBOARD_ENV}
sleep 0.5
if [ -f "$saved" ]; then wl-copy < "$saved" >/dev/null 2>&1; rm -f "$saved"; else wl-copy --clear >/dev/null 2>&1; fi
exit 0`;
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

/** A driver's answer that its session has ended, which every later call in it gets too (#662). */
function sessionEnded(result: McpResult): boolean {
  return !!result.isError && /\bSession '[^']*' has ended\b/i.test(rawText(result));
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
      const listed = await this.#listWindows(use);
      // The namer takes a second or more in the desktop session, so it runs in
      // the background: a window it names is listed from the next call on.
      this.#nameLater(use, listed);
      const windows = [...listed.values()].filter((window) => window.width > 1 && window.height > 1);
      if (!windows.length) {
        return { text: `Box ${box.name}'s desktop has no windows.`, hints: ["Open an app with computer_launch."] };
      }
      const lines = [`Windows on box ${box.name}'s desktop:\n${windows.map((window) => `- ${windowLine(window)}`).join("\n")}`];
      const titled = [...use.state.titled].map(([id, title]) => ({ id, title }));
      // Said once: a window not listed now has closed, or is listed under its new title next time without the line.
      use.state.titled.clear();
      const told = namedLine(titled, windows);
      if (told) lines.push(told);
      return { text: lines.join("\n\n"), hints: ["Read a window with computer_observe.", "Open another app with computer_launch."] };
    });
  }

  /** Names the untitled windows of a Windows box's desktop, where the backend can (#365). A failure leaves them as they are. */
  async #name(use: Use): Promise<readonly { readonly id: number; readonly title: string }[]> {
    if (use.box.capabilities.os !== "windows" || !this.#deps.nameWindows) return [];
    // One namer at a time per box: wait for the one in the background.
    await use.state.naming;
    try {
      return await this.#deps.nameWindows(use.box, use.signal);
    } catch (error) {
      if (use.signal?.aborted) throw error;
      this.#deps.logError("name windows", error);
      return [];
    }
  }

  /**
   * Starts the namer in the background, keeping what it names for
   * computer_windows to say (#365): unless it runs already, or ran less than
   * NAME_EVERY_MS ago and Cua lists the same windows as then, as agents call
   * computer_windows often and each run starts a PowerShell in the box.
   */
  #nameLater(use: Use, listed: ReadonlyMap<number, WindowInfo>): void {
    const { state, box } = use;
    if (box.capabilities.os !== "windows" || !this.#deps.nameWindows || state.naming) return;
    const windows = [...listed.keys()].sort((a, b) => a - b).join();
    const last = state.lastNaming;
    if (last && Date.now() - last.at < NAME_EVERY_MS && last.windows === windows) return;
    state.lastNaming = { at: Date.now(), windows };
    state.naming = this.#deps
      .nameWindows(box)
      .then((named) => {
        for (const window of named) state.titled.set(window.id, window.title);
      })
      .catch((error: unknown) => this.#deps.logError("name windows", error))
      .finally(() => {
        state.naming = null;
      });
  }

  /** Reads a window's accessibility tree, and its image when asked. */
  observe(
    box: BoxRecord,
    input: { window: number; query?: string; limit?: number; screenshot?: boolean },
    signal?: AbortSignal,
  ): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      const { snapshot, image, dropped, moved } = await this.#read(use, input.window, input.screenshot === true);
      const tree = this.#tree(use.state, snapshot, input.query, input.limit ?? TREE_LIMIT);
      const lines = [tree.text];
      if (moved) lines.push(moved);
      if (dropped) lines.push(`Window ${input.window} changed size, so your last image of it no longer applies.`);
      if (image) {
        const source = { width: snapshot.window.width, height: snapshot.window.height };
        use.state.images.set(input.window, { width: image.width, height: image.height, source });
        lines.push(coordinates(image, source, "window"));
      }
      const hints = ["Act on an element with computer_act or computer_type, giving its reference as ref."];
      if (tree.large && !input.query?.trim()) hints.push("This tree is large: pass query to see only the lines you need.");
      if (snapshot.dialogs.length || snapshot.popups.length) hints.push("Observe a dialog or popup by its window ID to act in it.");
      if (use.state.popups.has(input.window)) hints.push(`To close it, press Escape with computer_type and window ${input.window}.`);
      return { text: lines.join("\n\n"), image: image ? { data: image.data, mimeType: image.mimeType } : undefined, hints };
    });
  }

  /** An image of a window, or of the whole desktop. */
  screenshot(box: BoxRecord, window: WindowRef, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if (window === "desktop") {
        const { result, live } = await this.#call(use, "get_desktop_state", { max_image_dimension: IMAGE_MAX_EDGE }, { readOnly: true });
        if (result.isError) throw new ComputerError("driver", `bb-box could not take an image of the desktop: ${explain(result)}`, "Try again in a few seconds.");
        const image = imageOf(result);
        if (!image) throw new ComputerError("driver", "bb-box got no image of the desktop.", "Try again in a few seconds.");
        const structured = obj(result.structuredContent);
        for (const raw of arr(structured.windows)) {
          const found = windowOf(raw);
          if (found) use.state.windows.set(found.id, found);
        }
        const screen = { width: num(structured.screen_width) ?? image.width, height: num(structured.screen_height) ?? image.height };
        use.state.images.set("desktop", { width: image.width, height: image.height, source: screen, generation: live.generation });
        return {
          text: `The desktop. ${coordinates(image, screen, "screen")} Give window "desktop" with them.`,
          image: { data: image.data, mimeType: image.mimeType },
          hints: ["Prefer references from computer_observe: they do not depend on where things are drawn."],
        };
      }
      const { snapshot, image } = await this.#read(use, window, true);
      if (!image) throw new ComputerError("driver", `bb-box got no image of window ${window}.`, "Try again in a few seconds.");
      const source = { width: snapshot.window.width, height: snapshot.window.height };
      use.state.images.set(window, { width: image.width, height: image.height, source });
      return {
        text: `${windowLine(snapshot.window)}. ${coordinates(image, source, "window")}`,
        image: { data: image.data, mimeType: image.mimeType },
        hints: ["Prefer references from computer_observe: they do not depend on where things are drawn."],
      };
    });
  }

  /** Clicks, scrolls, sets a value or presses a key, on a reference or at pixels of the latest image. */
  act(box: BoxRecord, input: ActInput, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if (input.action === "key") {
        if (input.keys === undefined) {
          throw new ComputerError("input", "key needs keys: a key or chord, such as Escape or ctrl+a.", 'Give keys, with ref, or window: a window ID, or "desktop" for whatever has the focus.');
        }
        if (input.x !== undefined || input.y !== undefined) {
          throw new ComputerError("input", "key goes to ref or window, not to x and y.", 'Give ref, or window: a window ID, or "desktop" for whatever has the focus.');
        }
        return this.#type(use, { keys: input.keys, ref: input.ref, window: input.window });
      }
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
      const steps: Record<Exclude<Action, "key">, { tool: string; args: Json; done: string }> = {
        click: { tool: "click", args: { button: "left", count: 1 }, done: "Clicked" },
        double_click: { tool: "click", args: { button: "left", count: 2 }, done: "Double-clicked" },
        right_click: { tool: "click", args: { button: "right", count: 1 }, done: "Right-clicked" },
        scroll: { tool: "scroll", args: { direction: input.direction, amount }, done: `Scrolled ${input.direction} by ${amount} at` },
        set_value: { tool: "set_value", args: { value: input.value }, done: "Set the value of" },
      };
      const step = steps[input.action];
      this.#selecting(use, num(target.args.window_id), input.action === "double_click", input.action === "click" || input.action === "right_click");
      // On the desktop or in a popup, Cua cannot say what changed: bb-box looks before and after.
      const inPopup = !!target.snapshot && use.state.popups.has(target.snapshot.window.id);
      const watch = target.screen || inPopup ? await this.#watch(use, target.screen ?? null) : null;
      // An element Cua cannot click as an element is clicked at its centre (048).
      const centre = step.tool === "click" && target.element?.frame ? cannotInject : undefined;
      let { result, foreground } = await this.#deliver(use, step.tool, { ...target.args, ...step.args }, input.action !== "set_value", centre);
      let elsewhere = landedElsewhere(result);
      const byPosition = !!result.isError && !elsewhere;
      let before = target.snapshot;
      if (byPosition) ({ result, foreground, snapshot: before } = await this.#centre(use, target, step.args));
      elsewhere ??= landedElsewhere(result);
      const done = `${step.done} ${target.label}${byPosition ? " at its centre" : ""}${input.action === "set_value" ? ` to "${input.value}"` : ""}${foreground ? POINTER : ""}.${byPosition ? ` ${BY_POSITION}` : ""}`;
      const lines = [target.coordinates ? `${done} ${target.coordinates}` : done];
      if (elsewhere) lines.push(await this.#cameForward(use, elsewhere.forward));
      const cause: Cause = { element: watch?.element ?? target.element, right: input.action === "right_click" };
      const seen = watch ? await this.#settle(use, watch, cause) : await this.#changes(use, before!, { popups: { ...cause, result }, late: true });
      const forward = elsewhere?.forward;
      // What came in front may be among the windows that opened, whose hint says to observe it already.
      const told = forward == null || seen.hints.some((hint) => hint.includes(`computer_observe with window ${forward} `));
      return { text: [...lines, ...seen.parts].join("\n\n"), hints: told ? seen.hints : [`Call computer_observe with window ${forward} to act in what came in front.`, ...seen.hints] };
    });
  }

  /** Types text, or presses a key chord, into a reference, a window's focused element, or whatever has the focus. */
  type(box: BoxRecord, input: TypeInput, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, (use) => this.#type(use, input));
  }

  async #type(use: Use, input: TypeInput): Promise<ComputerResult> {
    if ((input.text === undefined) === (input.keys === undefined)) {
      throw new ComputerError("input", "Give text or keys, not both and not neither.", 'text types characters; keys presses one chord, such as "ctrl+a" or "Return".');
    }
    const keys = input.keys === undefined ? null : chord(input.keys);
    let args: Json;
    let label: string;
    let before: Snapshot | null = null;
    let readBack: string | null = null;
    let popup: Popup | undefined;
    let target: Target | null = null;
    if (input.ref !== undefined) {
      const { snapshot, element } = await this.#element(use, input.ref);
      popup = use.state.popups.get(snapshot.window.id);
      args = { pid: snapshot.window.pid, window_id: snapshot.window.id, ...this.#token(snapshot, element) };
      label = `${element.ref} (${describe(element.role, element.label)})`;
      before = snapshot;
      readBack = element.ref;
      target = { args, label, snapshot, element };
    } else if (input.window === "desktop") {
      args = {};
      label = "whatever has the focus";
    } else if (input.window !== undefined) {
      popup = use.state.popups.get(input.window);
      const window = popup?.window ?? (await this.#window(use, input.window));
      args = { pid: window.pid, window_id: window.id };
      label = `window ${window.id}`;
      before = use.state.snapshots.get(window.id) ?? null;
    } else {
      throw new ComputerError("input", 'Give ref, or window to type into its focused element, or window "desktop".', "Get both from computer_observe.");
    }
    const count = input.text?.length ?? 0;
    const what = keys ? `Pressed ${input.keys!.trim()}` : `Typed ${count} character${count === 1 ? "" : "s"}`;
    const tool = keys ? "press_key" : "type_text";
    const typed: Json = keys ? { key: keys.key, modifiers: keys.modifiers } : { text: input.text };
    // A menu or popup never becomes the active window, so its keys go to the desktop, where it holds the focus.
    if (popup || input.window === "desktop") {
      const watch = await this.#watch(use, null);
      if (popup && !watch.popups.has(popup.window.id)) throw this.#closed(use.state, popup);
      await this.#deliver(use, tool, { scope: "desktop", ...typed }, true);
      const where = popup ? `for ${popup.what ?? "the popup"} (window ${popup.window.id})` : "into whatever has the focus";
      const seen = await this.#settle(use, watch, { element: null, right: false });
      return { text: [`${what} with the real keyboard, ${where}.`, ...seen.parts].join("\n\n"), hints: seen.hints };
    }
    // On Windows, Cua presses a chord in the background with posted key
    // messages, which carry no modifier, and says it worked: the app gets the
    // bare key. So a chord goes in the foreground there, to its window brought
    // to the front first: Cua's own swap puts the window back behind the one
    // in front, and the window's focus does not come back with it, so text
    // typed into the window next would be lost.
    const chordOnWindows = !!keys?.modifiers.length && use.box.capabilities.os === "windows";
    // On Linux, Cua types in the background through AT-SPI at the caret, and
    // leaves a selection in place: after an action that could have selected
    // text in the window, its text goes through the real keyboard, which
    // types over the selection.
    const id = num(args.window_id);
    const overSelection = !keys && use.box.capabilities.os === "linux" && id !== undefined && use.state.selecting.has(id);
    this.#selecting(use, id, !!keys?.modifiers.length, !keys);
    if (chordOnWindows) await this.#call(use, "bring_to_front", { pid: args.pid, window_id: args.window_id }, { readOnly: true });
    // On Linux, text for an element that Cua cannot type in the background goes
    // through the real keyboard to its window, never to the element: Cua focuses
    // the element through AT-SPI first, which Chrome's address bar refuses, and
    // on Wayland once typed into the page instead, where "/" opened Wikipedia's
    // search. The element is clicked first with the real pointer, as a person
    // would, which focuses it and, in an address bar, selects what it holds,
    // unless a chord there may have selected text a click would lose (#707).
    // On Sway, bb-box types the text with the image's US keyboard, or, where
    // the image has none or the text has a character it lacks, pastes it:
    // bb-box puts it on the clipboard, and Cua presses the paste key. Cua's
    // own typing there loses characters.
    if (!keys && use.box.capabilities.os === "linux" && id !== undefined) {
      const window = { pid: args.pid, window_id: args.window_id };
      let clicked = false;
      if (!overSelection) {
        const { result } = await this.#call(use, tool, { ...args, ...typed, delivery_mode: "background" }, { readOnly: false });
        if (!refusedInBackground(result)) {
          if (result.isError) {
            if (codeOf(result) === "stale_element_token") this.#outdated(use.state, id);
            throw new ComputerError("refused", `bb-box could not do it: ${explain(result)}`, adviceFor(codeOf(result)));
          }
          return this.#typed(use, `${what} into ${label}.`, before, readBack, args);
        }
        if (target?.element?.frame) {
          await this.#centre(use, target, { button: "left", count: 1 });
          clicked = true;
        }
      }
      const keyed = this.#deps.keyText ? await this.#deps.keyText(use.box, { windowId: id, text: input.text! }, use.signal) : "unsupported";
      const staged = keyed === "typed" ? "keyed" : this.#deps.stageText ? await this.#deps.stageText(use.box, { windowId: id, text: input.text! }, use.signal) : "unsupported";
      if (staged === "unsupported") await this.#deliver(use, tool, { ...(target ? window : args), ...typed }, "foreground");
      else if (staged !== "keyed") {
        const modifiers = staged === "terminal" ? ["ctrl", "shift"] : ["ctrl"];
        try {
          await this.#deliver(use, "press_key", { ...window, key: "v", modifiers }, "foreground");
        } finally {
          await this.#deps.restoreClipboard?.(use.box, use.signal).catch((error: unknown) => this.#deps.logError("restoring the clipboard", error));
        }
      }
      const paste = staged === "terminal" ? "Ctrl+Shift+V" : "Ctrl+V";
      const how =
        staged === "unsupported"
          ? "with the real keyboard"
          : staged === "keyed"
            ? "with the real keyboard, in a US layout"
            : `pasting it with the real keyboard's ${paste}, as typing on Wayland loses characters, the clipboard's text put back after`;
      return this.#typed(use, `${what} into ${label}, ${clicked ? "clicking it first, then " : ""}${how} (the desktop's focus may have moved).`, before, readBack, args);
    }
    const { foreground } = await this.#deliver(use, tool, { ...args, ...typed }, chordOnWindows || overSelection ? "foreground" : true);
    const how = chordOnWindows ? `, with the real keyboard, its window brought to the front` : foreground ? KEYBOARD : "";
    return this.#typed(use, `${what} ${keys ? "in" : "into"} ${label}${how}.`, before, readBack, args);
  }

  /** What typing said, and what changed in the window since `before`. */
  async #typed(use: Use, said: string, before: Snapshot | null, readBack: string | null, args: Json): Promise<ComputerResult> {
    if (!before) return { text: said, hints: [`Call computer_observe with window ${args.window_id} to see it.`] };
    const changed = await this.#changes(use, before, { readBack, popups: { element: null, right: false, result: null }, late: true });
    return { text: [said, ...changed.parts].join("\n\n"), hints: changed.hints };
  }

  /** Opens an app by name or path, or a URL in the default browser. */
  launch(box: BoxRecord, input: { app?: string; url?: string }, signal?: AbortSignal): Promise<ComputerResult> {
    return this.#run(box, signal, async (use) => {
      if ((input.app === undefined) === (input.url === undefined)) {
        throw new ComputerError("input", "Give app or url, not both and not neither.", "app is an app's name or path; url opens in the default browser.");
      }
      const what = input.url ?? input.app!;
      const before = await this.#listWindows(use);
      const mac = box.capabilities.os === "macos";
      let args = launchArgs(box.capabilities.os, input);
      // Cua on macOS opens apps by name or bundle ID, not by path.
      if (mac && typeof args.launch_path === "string") args = (await this.#macApp(use, input.app!)) ?? { name: input.app! };
      let { result } = await this.#call(use, "launch_app", args, { readOnly: false });
      // An app outside the folders Cua looks in by name, such as one in /System/Library/CoreServices, by the bundle ID list_apps gives it (#712).
      if (mac && input.app !== undefined && args.name !== undefined && notInstalled(result)) {
        const found = await this.#macApp(use, input.app);
        if (found) {
          args = found;
          ({ result } = await this.#call(use, "launch_app", args, { readOnly: false }));
        }
      }
      const lookupUntil = Date.now() + (this.#deps.lookupWaitMs ?? LOOKUP_WAIT_MS);
      while (lookupBusy(result) && Date.now() < lookupUntil) {
        await sleep(Math.min(LOOKUP_POLL_MS, Math.max(0, lookupUntil - Date.now())), use.signal);
        ({ result } = await this.#call(use, "launch_app", args, { readOnly: false }));
      }
      if (input.app !== undefined && handedOff(result)) {
        const open = await this.#alreadyOpen(use, input.app, before);
        if (open) return open;
      }
      if (result.isError) {
        const reason = sentence(explain(result).replace(/^failed to launch:\s*/i, ""));
        if (input.app === undefined) throw new ComputerError("refused", `bb-box could not open ${what}: ${reason}`, "Check the URL.");
        const apps = await this.#apps(use);
        if (!apps.length) {
          throw new ComputerError("refused", `bb-box could not open ${what}: ${reason}`, "Check the app's name or path with box_run, for example command -v <name>.");
        }
        const shown = apps.slice(0, APPS_SHOWN).join(", ");
        const more = apps.length > APPS_SHOWN ? `, and ${apps.length - APPS_SHOWN} more` : "";
        throw new ComputerError(
          "refused",
          `bb-box could not open ${what}: ${reason} Apps installed in the box: ${shown}${more}.`,
          "Give app as one of these names, or the path of a program in the box.",
        );
      }
      // A URL can open in a browser window that was already open, which then changes its title.
      const launched = num(obj(result.structuredContent).pid);
      const ofLaunchedApp = (window: WindowInfo) => !mac || launched === undefined || window.pid === launched;
      let windows = arr(obj(result.structuredContent).windows)
        .map(windowOf)
        .filter((window): window is WindowInfo => !!window && !before.has(window.id) && ofLaunchedApp(window));
      for (const window of windows) use.state.windows.set(window.id, window);
      // An app already running on macOS with a window opens no other: its window, brought to the front (#712).
      if (mac && input.app !== undefined && args.urls === undefined && !windows.length && launched !== undefined && [...before.values()].some((window) => window.pid === launched)) {
        const open = await this.#alreadyOpen(use, input.app, before, launched);
        if (open) return open;
      }
      const browser = (window: WindowInfo) => BROWSER.test(window.app) || (launched !== undefined && window.pid === launched);
      let reused: WindowInfo | null = null;
      const finderShowing = mac && args.urls !== undefined && [...before.values()].some((window) => window.pid === launched && window.onScreen);
      const waited = Math.min(this.#deps.launchWaitMs ?? LAUNCH_WAIT_MS, finderShowing ? FINDER_WINDOW_WAIT_MS : Infinity);
      const deadline = Date.now() + waited;
      const named: { id: number; title: string }[] = [];
      while (!windows.length && !reused && Date.now() < deadline) {
        await sleep(LAUNCH_POLL_MS, use.signal);
        let now = await this.#listWindows(use);
        windows = [...now.values()].filter((window) => !before.has(window.id) && window.width > 1 && window.height > 1 && ofLaunchedApp(window));
        // Cua on Windows lists only windows with a title: name those without one, and look again (#365).
        const naming = windows.length ? [] : await this.#name(use);
        if (naming.length) {
          named.push(...naming);
          now = await this.#listWindows(use);
          windows = [...now.values()].filter((window) => !before.has(window.id) && window.width > 1 && window.height > 1 && ofLaunchedApp(window));
        }
        if (input.url !== undefined) {
          reused = [...now.values()].find((window) => before.has(window.id) && before.get(window.id)!.title !== window.title && browser(window)) ?? null;
        }
      }
      if (!windows.length && !reused && input.app !== undefined) {
        const open = await this.#alreadyOpen(use, input.app, before, launched);
        if (open) return open;
      }
      if (!windows.length && !reused) {
        const where = input.url !== undefined ? " It may have opened in a browser window that was already open." : "";
        return { text: `Opened ${what}, but no new window appeared within ${Math.round(waited / 1000)} s.${where}`, hints: ["Call computer_windows to see the windows now."] };
      }
      if (!reused && kindInfo(currentKindId(box.kind)).windowing === "wayland") windows = await this.#compositorWindows(use, windows, before);
      // The app's first window on screen, not a helper's off screen (#219). A
      // browser names its window after the page once the page has a title.
      let page =
        reused ??
        windows.find((window) => window.onScreen && (launched === undefined || window.pid === launched)) ??
        windows.find((window) => window.onScreen) ??
        windows[0]!;
      if (input.url !== undefined) {
        const until = Date.now() + (this.#deps.pageWaitMs ?? PAGE_WAIT_MS);
        while (placeholder(page.title, input.url) && Date.now() < until) {
          await sleep(LAUNCH_POLL_MS, use.signal);
          const found = (await this.#listWindows(use)).get(page.id);
          if (!found) break;
          page = found;
        }
        windows = windows.map((window) => (window.id === page.id ? page : window));
      }
      const lines = reused
        ? [`Opened ${what} in a window that was already open:\n- ${windowLine(page)}`]
        : [`Opened ${what}. Its window${windows.length === 1 ? "" : "s"}:\n${windows.map((window) => `- ${windowLine(window)}`).join("\n")}`];
      if (input.url !== undefined && placeholder(page.title, input.url)) {
        lines.push(`The page may still be loading, or it has no title of its own: its window's title is still ${page.title ? `"${page.title}"` : "empty"}.`);
      }
      const told = namedLine(named, windows);
      if (told) lines.push(told);
      return { text: lines.join("\n\n"), hints: [`Call computer_observe with window ${page.id} to read it.`] };
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

  /**
   * The agent takes control of the box's desktop back from a person (038).
   * The agent's references and images went when the person took it (pause).
   */
  async takeControl(box: BoxRecord): Promise<ComputerResult> {
    this.#drivable(box);
    const took = await this.#deps.takeBack(box.id);
    const state = this.#boxes.get(box.id);
    const notice = state?.notice ?? null;
    if (state) state.notice = null;
    if (took) {
      return {
        text: `You took control of box ${box.name}'s desktop back. Keys the person held down were let go, and the desktop has the size it had before they took control. It may have changed, and earlier references and images are gone.`,
        hints: ["Call computer_windows or computer_observe before acting."],
      };
    }
    const text = `You already have control of box ${box.name}'s desktop.`;
    return notice ? { text: `${notice}\n\n${text}`, hints: [] } : { text, hints: [] };
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
        popups: new Map(),
        large: new Set(),
        naming: null,
        lastNaming: null,
        titled: new Map(),
        selecting: new Set(),
      };
      this.#boxes.set(boxId, state);
    }
    return state;
  }

  /** Runs one tool call: after the box's earlier ones, and only while the agent has control. */
  async #run(box: BoxRecord, signal: AbortSignal | undefined, work: (use: Use) => Promise<ComputerResult>): Promise<ComputerResult> {
    this.#drivable(box);
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

  /** Refuses a box with no desktop the computer tools can drive. */
  #drivable(box: BoxRecord): void {
    const driver = box.capabilities.computerUse;
    if (!driver) {
      throw new ComputerError("unsupported", `Box ${box.name} has no computer use: its kind, ${box.kind}, has no desktop the computer tools can drive.`, "Acquire a desktop kind from box_list for computer use, or use box_run in this box.");
    }
    if (driver.driver !== "cua") throw new ComputerError("unsupported", `bb-box cannot drive box ${box.name}'s computer-use driver, ${driver.driver}.`, "Use box_run in this box.");
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
    state.popups.clear();
    state.large.clear();
    state.selecting.clear();
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
      const unsure = options.readOnly ? "" : " bb-box cannot tell whether it was done.";
      let result: McpResult;
      try {
        result = await live.mcp.call(name, args, { timeoutMs: this.#deps.callTimeoutMs ?? CALL_TIMEOUT_MS, signal: use.signal });
      } catch (error) {
        if (error instanceof McpError) {
          throw new ComputerError("driver", `bb-box's request to the desktop failed: ${sentence(error.message)}`, "This is probably a bb-box bug: tell the user.");
        }
        if (error instanceof McpClosedError) {
          if (live.reason === null && options.readOnly && attempt === 0) continue;
          const hint =
            live.reason === PAUSED_WHILE_RUNNING
              ? AFTER_PAUSE
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
      // The driver can end its session by itself, as after a while idle, and keep the connection: every call then
      // answers that the session has ended (#662). A new session takes over, for a read at once.
      if (!sessionEnded(result)) return { result, live };
      void live.mcp.close("The computer-use driver ended its session.");
      if (options.readOnly && attempt === 0) continue;
      throw new ComputerError(
        "interrupted",
        `The computer-use driver had ended its session, as it can after a while idle, so this was not done.`,
        "Call it again: bb-box opens a new session with the driver.",
      );
    }
  }

  /** Notes, on Linux, whether the action on window `id` could have selected text there, or ended any selection. */
  #selecting(use: Use, id: number | undefined, selects: boolean, ends: boolean): void {
    if (use.box.capabilities.os !== "linux" || id === undefined) return;
    if (selects) use.state.selecting.add(id);
    else if (ends) use.state.selecting.delete(id);
  }

  /**
   * Does an action in the background, or in the foreground when Cua cannot
   * do it in the background. Cua says so before it does anything, or
   * `delivery` is "foreground" for an action Cua does wrongly in the
   * background. An action on the desktop has no background, so it needs no
   * note that it went in the foreground. A failure that `handled` takes is
   * returned, not thrown.
   */
  async #deliver(use: Use, tool: string, args: Json, delivery: boolean | "foreground", handled?: (result: McpResult) => boolean): Promise<{ result: McpResult; foreground: boolean }> {
    let result: McpResult;
    let foreground = false;
    if (args.scope === "desktop") {
      ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
    } else if (delivery === "foreground") {
      ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
      foreground = true;
    } else {
      ({ result } = await this.#call(use, tool, delivery ? { ...args, delivery_mode: "background" } : args, { readOnly: false }));
      if (delivery && refusedInBackground(result)) {
        ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
        foreground = true;
      }
    }
    if (result.isError && !handled?.(result) && !(tool === "click" && landedElsewhere(result))) {
      const code = codeOf(result);
      const id = num(args.window_id);
      if (code === "stale_element_token" && id !== undefined) this.#outdated(use.state, id);
      throw new ComputerError("refused", `bb-box could not do it: ${explain(result)}`, adviceFor(code));
    }
    return { result, foreground };
  }

  /**
   * Clicks an element at the centre of its frame. The frame is in the
   * screen's pixels, and the click in those of Cua's latest image of the
   * window, which Cua takes only after a read of the window with an image in
   * this session: bb-box reads it first when the session has not (048).
   */
  async #centre(use: Use, target: Target, args: Json): Promise<{ result: McpResult; foreground: boolean; snapshot: Snapshot }> {
    let snapshot = target.snapshot!;
    let element = target.element!;
    if (!snapshot.screenshot || snapshot.generation !== use.state.live?.generation) {
      snapshot = (await this.#read(use, snapshot.window.id, true)).snapshot;
      const found = snapshot.byRef.get(element.ref);
      if (!found?.frame) throw new ComputerError("stale", `${element.ref} (${describe(element.role, element.label)}) is no longer on screen. Call computer_observe again.`, null);
      element = found;
    }
    const { window, screenshot } = snapshot;
    if (!screenshot) throw new ComputerError("driver", `bb-box got no image of window ${window.id}, which it needs to click ${element.ref} by position.`, "Try again in a few seconds.");
    const frame = element.frame!;
    const x = Math.round(((frame.x + frame.width / 2 - window.x) * screenshot.width) / window.width);
    const y = Math.round(((frame.y + frame.height / 2 - window.y) * screenshot.height) / window.height);
    const { result, foreground } = await this.#deliver(use, "click", { pid: window.pid, window_id: window.id, x, y, ...args }, true);
    return { result, foreground, snapshot };
  }

  /**
   * The window of an app that was already open, when opening it again only
   * handed the launch to it. A single-instance app, such as Mousepad, may
   * show a new document in its window and open none, as does an app on
   * macOS that has a window already. bb-box brings that window, of the app
   * by name or of process `pid`, to the front, as a new window would be.
   * Null when the app had no window before.
   */
  async #alreadyOpen(use: Use, app: string, before: ReadonlyMap<number, WindowInfo>, pid?: number): Promise<ComputerResult | null> {
    const own = [...(await this.#listWindows(use)).values()].filter(
      (window) => before.has(window.id) && (window.pid === pid || sameApp(window.app, app)) && window.width > 1 && window.height > 1,
    );
    const window = own.find((candidate) => candidate.onScreen) ?? own[0];
    if (!window) return null;
    // Bringing a window to the front again does no harm, so a lost connection may retry it.
    const { result } = await this.#call(use, "bring_to_front", { pid: window.pid, window_id: window.id }, { readOnly: true });
    const lines = [`${app} was already open, and opening it again opened no new window. ${result.isError ? "Its window" : "bb-box brought its window to the front"}:\n- ${windowLine(window)}`];
    if (result.isError) lines.push(`bb-box could not bring it to the front: ${sentence(explain(result))}`);
    const was = before.get(window.id)!.title;
    if (was !== window.title) lines.push(`Its title was "${was}" before, so it may show a new document.`);
    return { text: lines.join("\n\n"), hints: [`Call computer_observe with window ${window.id} to read it.`] };
  }

  /**
   * What launch_app takes for an app on macOS that Cua lists, by its name,
   * bundle ID or path: its bundle ID, with the home folder for Finder. Null
   * when Cua lists no such app, or cannot list them.
   */
  async #macApp(use: Use, app: string): Promise<Json | null> {
    let listed: Json[];
    try {
      const { result } = await this.#call(use, "list_apps", {}, { readOnly: true });
      if (result.isError) return null;
      listed = arr(obj(result.structuredContent).apps).map(obj);
    } catch (error) {
      if (error instanceof ComputerError && error.code !== "driver") throw error;
      return null;
    }
    const path = app.trim().replace(/\/+$/, "");
    const name = appName(app).toLowerCase();
    const found = path.includes("/")
      ? listed.find((entry) => str(entry.launch_path)?.replace(/\/+$/, "") === path)
      : listed.find((entry) => str(entry.name)?.trim().toLowerCase() === name || str(entry.bundle_id)?.toLowerCase() === name);
    const id = found && str(found.bundle_id);
    if (!id) return null;
    return id === FINDER ? { bundle_id: id, urls: ["~"] } : { bundle_id: id };
  }

  /** The names of the apps installed in the box, as Cua lists them, without settings panels or session actions; none when it cannot. */
  async #apps(use: Use): Promise<string[]> {
    try {
      const { result } = await this.#call(use, "list_apps", {}, { readOnly: true });
      if (result.isError) return [];
      const names = arr(obj(result.structuredContent).apps)
        .map(obj)
        .filter((app) => app.kind === "desktop" && !NOT_APPS.test(`${str(app.bundle_id) ?? ""} ${str(app.launch_path) ?? ""}`))
        .map((app) => str(app.name)?.trim())
        .filter((name): name is string => !!name && !/^log ?out\b/i.test(name));
      return [...new Set(names)].sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (error instanceof ComputerError && error.code !== "driver") throw error;
      return [];
    }
  }

  /**
   * A Wayland launch's new windows as the compositor knows them. Cua can list
   * a window from its accessibility side before Sway maps it, under an ID
   * that Sway cannot attest, so a first computer_type into it is refused.
   * Once Sway maps the window, Cua lists that one instead, under Sway's ID.
   * So this lists the launched processes' new windows again until they are
   * the same twice running. It waits about 0.25 s when they are Sway's
   * already.
   */
  async #compositorWindows(use: Use, windows: WindowInfo[], before: ReadonlyMap<number, WindowInfo>): Promise<WindowInfo[]> {
    const deadline = Date.now() + COMPOSITOR_WAIT_MS;
    const pids = new Set(windows.map((window) => window.pid));
    let last = windows.map((window) => window.id).join(",");
    for (;;) {
      await sleep(Math.min(LAUNCH_POLL_MS, Math.max(0, deadline - Date.now())), use.signal);
      const now = await this.#listWindows(use);
      const next = [...now.values()].filter((window) => pids.has(window.pid) && !before.has(window.id) && window.width > 1 && window.height > 1);
      const ids = next.map((window) => window.id).join(",");
      if (next.length) windows = next;
      for (const window of windows) use.state.windows.set(window.id, window);
      if ((next.length && ids === last) || Date.now() >= deadline) return windows;
      last = ids;
    }
  }

  async #listWindows(use: Use): Promise<Map<number, WindowInfo>> {
    const { result } = await this.#call(use, "list_windows", {}, { readOnly: true });
    if (result.isError) throw new ComputerError("driver", `bb-box could not list the windows: ${explain(result)}`, "Try again in a few seconds.");
    const windows = new Map<number, WindowInfo>();
    for (const raw of arr(obj(result.structuredContent).windows)) {
      const window = windowOf(raw);
      if (!window) continue;
      windows.set(window.id, window);
      use.state.windows.set(window.id, window);
    }
    return windows;
  }

  /** What came in front after a click, as a tray menu or Explorer's overflow panel does (#484). */
  async #cameForward(use: Use, id: number | null): Promise<string> {
    const window = id === null ? undefined : (await this.#listWindows(use).catch(() => null))?.get(id);
    const which = window ? windowLine(window) : id === null ? "another window" : `window ${id}`;
    return `The click landed, and ${which} came in front, such as a menu or panel of another app. Observe it to act in it; clicking the same place again may close it.`;
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
    state.popups.delete(id);
    state.large.delete(id);
  }

  /** A read of the window made its snapshot's tokens stale: the next action on it reads it again. */
  #outdated(state: BoxState, id: number): void {
    const snapshot = state.snapshots.get(id);
    if (snapshot) state.snapshots.set(id, { ...snapshot, generation: 0 });
  }

  /**
   * Reads a window's tree. The screenshot comes too when the agent asked for
   * it, or holds an image of the window: Cua measures pixel actions against
   * the screenshot it took last.
   */
  async #read(use: Use, id: number, show: boolean, moved: string | null = null): Promise<Read> {
    const popup = use.state.popups.get(id);
    if (popup) await this.#stillOpen(use, popup);
    const window = popup?.window ?? (await this.#window(use, id));
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
      if (/stale or no longer running|no longer running|not found/i.test(rawText(result))) {
        this.#lost(use.state, id);
        throw new ComputerError("stale", `Window ${id} has closed.`, "Call computer_windows to see the windows open now.");
      }
      throw new ComputerError("driver", `bb-box could not read window ${id}: ${explain(result)}`, "Call computer_windows to check the window, then try again.");
    }
    const structured = obj(result.structuredContent);
    // Cua on Sway reads a window it no longer lists as another of its app's,
    // with no title or bounds of its own (#402): one not listed has closed.
    if (!popup && structured.window_title === undefined && structured.window_bounds === undefined && !(await this.#listWindows(use)).has(id)) {
      this.#lost(use.state, id);
      throw new ComputerError("stale", `Window ${id} has closed.`, "Call computer_windows to see the windows open now.");
    }
    if (popup && !fills(structured, popup.window)) {
      this.#outdated(use.state, id);
      throw new ComputerError(
        "driver",
        `bb-box cannot read the items of ${popup.what ?? "the popup"} (window ${id}): the desktop gives another window's instead.`,
        'Call computer_screenshot with window "desktop" to see it, then click its items by pixels.',
      );
    }
    const twin = popup ? null : await this.#twin(use, window, structured, true);
    if (twin) {
      this.#outdated(use.state, twin.id);
      if (moved) {
        throw new ComputerError(
          "driver",
          `bb-box cannot read window ${id}: the desktop gives the tree of window ${twin.id}, "${twin.title}", instead.`,
          `Call computer_screenshot with window ${id} and act on it by pixels, or close window ${twin.id}.`,
        );
      }
      return this.#read(use, id, show, await this.#apart(use, window, twin));
    }
    const snapshot = this.#snapshot(use, window, live.generation, structured, image);
    const dropped = !!held && (!image || !sameSize(held, image));
    if (dropped) use.state.images.delete(id);
    return { snapshot, image: show ? image : null, dropped: dropped && !show, moved };
  }

  /**
   * Another window of the app whose tree Cua gave for this one. Cua finds a
   * window's tree by where the window is, so of two windows of one app within
   * a few pixels of each other, as a browser places a new window, it reads
   * the first for both; the tree's frame then bears the other's title. With
   * `list`, bb-box lists the windows to find it; otherwise it goes by the
   * windows it knows.
   */
  async #twin(use: Use, window: WindowInfo, structured: Json, list: boolean): Promise<WindowInfo | null> {
    const name = foreignFrame(structured, str(structured.window_title) ?? window.title);
    if (!name) return null;
    const windows = list ? await this.#listWindows(use) : use.state.windows;
    for (const other of windows.values()) {
      if (other.id !== window.id && other.pid === window.pid && clean(other.title).trim() === name) return other;
    }
    return null;
  }

  /** Moves a window clear of its twin, so that Cua tells them apart, and says so. */
  async #apart(use: Use, window: WindowInfo, twin: WindowInfo): Promise<string> {
    const clear = (mine: number, theirs: number) => (mine < theirs && theirs >= APART ? theirs - APART : theirs + APART);
    const x = clear(window.x, twin.x);
    const y = clear(window.y, twin.y);
    const args = { pid: window.pid, window_id: window.id, x, y, width: window.width, height: window.height };
    const { result } = await this.#call(use, "set_window_frame", args, { readOnly: false });
    // Cua says whether the window settled where it was sent; a maximised one stays put.
    const effect = str(obj(result.structuredContent).effect);
    if (result.isError || (effect !== undefined && effect !== "confirmed")) {
      const why = result.isError ? `: ${explain(result)}` : ", as when it is maximised.";
      throw new ComputerError(
        "driver",
        `bb-box cannot read window ${window.id}: the desktop gives the tree of window ${twin.id}, "${twin.title}", which lies within a few pixels of it, and window ${window.id} would not move${why}`,
        `Un-maximise or close one of the two windows, for example by double-clicking its title bar, then observe it again. Or act on window ${window.id} by pixels: call computer_screenshot with window ${window.id}.`,
      );
    }
    use.state.windows.set(window.id, { ...window, x, y });
    return `bb-box moved window ${window.id} to (${x}, ${y}) on the screen: it lay within a few pixels of window ${twin.id}, another window of its app, and the desktop gave that window's tree for both.`;
  }

  #snapshot(use: Use, window: WindowInfo, generation: number, structured: Json, image: Size | null): Snapshot {
    const { state } = use;
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
    const roleOf = (index: number) => str(byIndex.get(index)!.role) ?? "";
    const labelOf = (index: number) => clean(str(byIndex.get(index)!.label) ?? "");
    const parentOf = (index: number) => {
      const parent = num(byIndex.get(index)!.parent_index);
      return parent !== undefined && byIndex.has(parent) ? parent : null;
    };
    // How many earlier siblings share each element's role, and how many in all.
    const siblingKey = (index: number) => JSON.stringify([parentOf(index), roleOf(index)]);
    const before = new Map<number, number>();
    const seen = new Map<string, number>();
    for (const index of byIndex.keys()) {
      const key = siblingKey(index);
      before.set(index, seen.get(key) ?? 0);
      seen.set(key, (seen.get(key) ?? 0) + 1);
    }
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("base64url").slice(0, 22);
    /** A hash of the element and its ancestors, each by `part`. */
    const chained = (part: (index: number) => unknown) => {
      const memo = new Map<number, string>();
      const chain = (index: number, path: Set<number>): string => {
        const known = memo.get(index);
        if (known !== undefined) return known;
        const parent = parentOf(index);
        const up = parent !== null && !path.has(parent) ? chain(parent, path.add(index)) : "";
        const print = hash([part(index), up]);
        memo.set(index, print);
        return print;
      };
      return (index: number) => chain(index, new Set());
    };
    const printOf = chained((index) => [roleOf(index), labelOf(index)]);
    const spotOf = chained((index) => [roleOf(index), before.get(index), seen.get(siblingKey(index))! > 1 ? labelOf(index) : null]);
    const prints = new Map<number, { fingerprint: string; place: string }>();
    const counts = new Map<string, number>();
    for (const index of byIndex.keys()) {
      const print = { fingerprint: printOf(index), place: spotOf(index) };
      prints.set(index, print);
      for (const key of [`f${print.fingerprint}`, `p${print.place}`]) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let named = state.named.get(window.id);
    if (!named) {
      named = new Map();
      state.named.set(window.id, named);
    }
    // An element keeps its reference while its role, its name and its ancestors' do. When only
    // names changed that its place leaves out, as a text area's and its document's tab's do as
    // it is edited, it keeps the reference of the element in its place in the window's last snapshot.
    const placed = new Map<string, string>();
    for (const element of state.snapshots.get(window.id)?.elements ?? []) {
      if (element.unique && element.place) placed.set(element.place, element.ref);
    }
    const refs = new Map<number, string>();
    const taken = new Set<string>();
    for (const index of byIndex.keys()) {
      const { fingerprint } = prints.get(index)!;
      const ref = counts.get(`f${fingerprint}`) === 1 ? named.get(fingerprint) : undefined;
      if (ref && !taken.has(ref)) {
        refs.set(index, ref);
        taken.add(ref);
      }
    }
    for (const index of byIndex.keys()) {
      const { fingerprint, place } = prints.get(index)!;
      if (refs.has(index) || counts.get(`f${fingerprint}`) !== 1 || counts.get(`p${place}`) !== 1) continue;
      const ref = placed.get(place);
      if (ref && !taken.has(ref)) {
        refs.set(index, ref);
        taken.add(ref);
      }
    }
    const given = new Map([...byIndex].map(([index, entry]) => [index, rectOf(entry.frame)]));
    const frames = kindInfo(currentKindId(use.box.kind)).windowing === "wayland" ? screenFrames(given, updated) : given;
    const elements: Element[] = [];
    const byRef = new Map<string, Element>();
    const elementAt = new Map<number, Element>();
    for (const [index, entry] of byIndex) {
      const { fingerprint, place } = prints.get(index)!;
      const unique = counts.get(`f${fingerprint}`) === 1;
      const ref = refs.get(index) ?? `e${state.nextRef++}`;
      if (unique) named.set(fingerprint, ref);
      const role = roleOf(index);
      const label = labelOf(index);
      const element: Element = {
        index,
        ref,
        token: str(entry.element_token) ?? null,
        role,
        label,
        fingerprint,
        unique,
        place: counts.get(`p${place}`) === 1 ? place : null,
        frame: frames.get(index) ?? null,
      };
      elements.push(element);
      byRef.set(ref, element);
      elementAt.set(index, element);
      const shown = state.refs.get(ref)?.shown ?? null;
      state.refs.delete(ref);
      state.refs.set(ref, { windowId: window.id, fingerprint, unique, describe: describe(role, label), shown });
    }
    for (const ref of state.refs.keys()) {
      if (state.refs.size <= MAX_REFS) break;
      state.refs.delete(ref);
    }

    const read: Line[] = [];
    for (const text of clean(str(structured.tree_markdown) ?? "").split("\n")) {
      if (!text.trim()) continue;
      const indexed = /^(\s*)- \[(\d+)\] (.*)$/.exec(text);
      if (indexed) {
        const element = elementAt.get(Number(indexed[2])) ?? null;
        const rest = indexed[3]!.replace(" [actions=[]]", "");
        read.push({ text: `${indexed[1]}- ${element ? `[${element.ref}] ` : ""}${rest}`, depth: indexed[1]!.length / 2, element });
      } else if (/^\s*- /.test(text) || !read.length) {
        read.push({ text, depth: (/^\s*/.exec(text)![0].length) / 2, element: null });
      } else {
        // A name with a line break goes on over several lines.
        const last = read[read.length - 1]!;
        read[read.length - 1] = { ...last, text: `${last.text}\n${text}` };
      }
    }
    const lines = mergeText(read);

    const dialogs: Dialog[] = [];
    for (const dialog of arr(structured.dialogs).map(obj)) {
      const id = num(dialog.window_id);
      if (id === undefined) continue;
      this.#overlay(state, dialog, num(dialog.owning_pid) ?? window.pid);
      dialogs.push({ id, title: str(dialog.title) ?? "", modal: dialog.modal === true });
    }
    const popups = popupsOf(structured, window.pid).filter((popup) => popup.id !== window.id);
    this.#register(state, popups, window.id);

    const complete = whole(structured);
    if (!complete || elements.length > (this.#deps.smallTree ?? TREE_SMALL)) state.large.add(window.id);
    else state.large.delete(window.id);
    const snapshot: Snapshot = {
      window: updated,
      generation,
      id: str(structured.snapshot_id) ?? null,
      elements,
      byRef,
      lines,
      partial: complete ? null : (str(structured.truncation_reason) ?? "timeout"),
      screenshot: image ? { width: image.width, height: image.height } : null,
      dialogs,
      popups,
    };
    state.snapshots.set(window.id, snapshot);
    return snapshot;
  }

  /** Remembers a dialog's window, which a window list may not show. */
  #overlay(state: BoxState, raw: Json, pid: number): void {
    const found = windowOf({ ...raw, pid });
    if (found && !state.windows.has(found.id)) state.windows.set(found.id, found);
  }

  /** Remembers popups that a read of window `over` listed, with the window whose reads list them. */
  #register(state: BoxState, popups: readonly WindowInfo[], over: number): void {
    for (const popup of popups) {
      const known = state.popups.get(popup.id);
      state.popups.set(popup.id, { window: popup, over: known?.over ?? state.popups.get(over)?.over ?? over, what: known?.what ?? null });
      state.windows.set(popup.id, popup);
    }
  }

  /** The dialogs and popups open over a window, in words. */
  #overlays(state: BoxState, snapshot: Snapshot): string[] {
    const lines = snapshot.dialogs.map(dialogLine);
    for (const popup of snapshot.popups) {
      const what = state.popups.get(popup.id)?.what;
      const name = what ? `${what[0]!.toUpperCase()}${what.slice(1)}` : `A popup${popup.title ? ` "${popup.title}"` : ""}`;
      lines.push(`${name}, window ${popup.id}, is open over this window.`);
    }
    return lines;
  }

  /** The tree text of a snapshot, cut to `limit` lines, and whether it is long enough, though whole, to be worth a query. */
  #tree(state: BoxState, snapshot: Snapshot, query: string | undefined, limit: number): { text: string; large: boolean } {
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
    const told: Element[] = [];
    let elements = 0;
    let chars = 0;
    for (const index of chosen) {
      const line = lines[index]!;
      if (shown.length >= limit || chars + line.text.length > TREE_MAX_CHARS) break;
      if (line.element) {
        elements++;
        told.push(line.element);
      }
      chars += line.text.length + 1;
      shown.push(line.text);
    }
    this.#show(state, told);
    const cut = chosen.length - shown.length;
    const { window } = snapshot;
    const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;
    const header = [`${windowLine(window)[0]!.toUpperCase()}${windowLine(window).slice(1)}. ${plural(snapshot.elements.length, "element")}, ${plural(lines.length, "line")}.`];
    if (snapshot.partial) header.push(`${cutShort(snapshot.partial)}, so some elements are missing.`);
    if (query?.trim()) {
      header.push(matched ? `${plural(matched, "line")} ${matched === 1 ? "matches" : "match"} "${query.trim()}", shown with their ancestors.` : `Nothing matches "${query.trim()}".`);
    }
    if (cut) {
      const of = chosen.filter((index) => lines[index]!.element).length;
      header.push(
        `Partial: showing ${shown.length} of ${plural(chosen.length, "line")} (${elements} of ${plural(of, "element")}); ${plural(cut, "line")} cut.` +
          ` Pass ${query?.trim() ? "a narrower query" : "query to see only the lines you need"}, or a larger limit (at most ${TREE_LIMIT_MAX}).`,
      );
    }
    const parts = [header.join(" ")];
    if (shown.length) parts.push(shown.join("\n"));
    const overlays = this.#overlays(state, snapshot);
    if (overlays.length) parts.push(overlays.join(" "));
    return { text: parts.join("\n\n"), large: !cut && chosen.length > TREE_LARGE };
  }

  /**
   * Finds a reference in the window's latest snapshot, reading the window
   * again when its tokens are from an earlier session. Refuses once when its
   * element's role or name is not what bb-box last showed the agent (024).
   */
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
    const popup = use.state.popups.get(entry.windowId);
    if (!snapshot || snapshot.generation !== use.state.live?.generation) {
      snapshot = (await this.#read(use, entry.windowId, false)).snapshot;
    } else if (popup) {
      await this.#stillOpen(use, popup);
    }
    const matches = entry.unique ? snapshot.elements.filter((element) => element.fingerprint === entry.fingerprint) : [];
    const element = snapshot.byRef.get(name) ?? (matches.length === 1 ? matches[0]! : null);
    const shown = use.state.refs.get(name)?.shown ?? entry.shown;
    if (!element) throw new ComputerError("stale", `${name} (${shown ?? entry.describe}) is no longer on screen. Call computer_observe again.`, null);
    const now = describe(element.role, element.label);
    // A reference follows its element through a rename (023), but the agent
    // chose it by the name it saw: refuse once, and show the new name.
    this.#show(use.state, [element]);
    const current = use.state.refs.get(name);
    if (current && element.ref !== name) use.state.refs.set(name, { ...current, shown: now });
    if (shown !== null && shown !== now) {
      throw new ComputerError(
        "stale",
        `${name} is now ${now}, but bb-box last showed it as ${shown}, so nothing was done.`,
        `Act on ${name} again if it is the one you want; otherwise call computer_observe.`,
      );
    }
    return { snapshot, element };
  }

  /** Records how bb-box showed these elements to the agent. */
  #show(state: BoxState, elements: Iterable<Element | null>): void {
    for (const element of elements) {
      const entry = element && state.refs.get(element.ref);
      if (entry) state.refs.set(element.ref, { ...entry, shown: describe(element.role, element.label) });
    }
  }

  #token(snapshot: Snapshot, element: Element): Json {
    return element.token ? { element_token: element.token } : { element_index: element.index, snapshot_id: snapshot.id };
  }

  /**
   * What an action aims at: an element, pixels of a window's latest image, or
   * pixels of the desktop's. For pixels, `coordinates` says how the image maps
   * to the window or screen; on the desktop, `screen` is the point in the
   * screen's own pixels.
   */
  async #target(use: Use, input: ActInput): Promise<Target> {
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
      // Cua maps the desktop's pixels to the screen by its latest image of the
      // desktop in this session: the agent's, or in a new session one bb-box
      // takes of the same size.
      await this.#mapped(use, held);
      const screen = held.source;
      const sx = Math.round((x * screen.width) / held.width);
      const sy = Math.round((y * screen.height) / held.height);
      return {
        args: { x, y, scope: "desktop" },
        label: `(${x}, ${y}) on the desktop, (${sx}, ${sy}) on the screen`,
        snapshot: null,
        element: null,
        coordinates: coordinates(held, screen, "screen"),
        screen: { x: sx, y: sy },
      };
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
    return {
      args: { pid: snapshot.window.pid, window_id: window, x, y },
      label: `(${x}, ${y}) in window ${window}`,
      snapshot,
      element: null,
      coordinates: coordinates(held, held.source, "window"),
    };
  }

  /**
   * Makes sure Cua maps the desktop's pixels by an image the size of the
   * agent's. A new session, after an idle close or a reconnect, has no image
   * of the desktop, and Cua would take the pixels as the screen's.
   */
  async #mapped(use: Use, held: Held): Promise<void> {
    if (held.generation === (await this.#live(use)).generation) return;
    const { result, live } = await this.#call(use, "get_desktop_state", { max_image_dimension: IMAGE_MAX_EDGE }, { readOnly: true });
    if (result.isError) throw new ComputerError("driver", `bb-box could not take an image of the desktop: ${explain(result)}`, "Try again in a few seconds.");
    const image = imageOf(result);
    if (!image) throw new ComputerError("driver", "bb-box got no image of the desktop.", "Try again in a few seconds.");
    const structured = obj(result.structuredContent);
    const screen = { width: num(structured.screen_width) ?? image.width, height: num(structured.screen_height) ?? image.height };
    if (!sameSize(image, held) || !sameSize(screen, held.source)) {
      use.state.images.delete("desktop");
      throw new ComputerError("stale", "The screen changed size since your image of the desktop, so its pixels no longer match.", 'Take a new image with computer_screenshot, window "desktop".');
    }
    use.state.images.set("desktop", { ...held, generation: live.generation });
  }

  /**
   * Reads the window again after an action and says what changed. With
   * `popups`, also which popups over it the action opened or closed.
   */
  async #changes(
    use: Use,
    before: Snapshot,
    options: { readBack?: string | null; popups?: Cause & { result: McpResult | null }; late?: boolean } = {},
  ): Promise<Changes> {
    const id = before.window.id;
    let read: Read;
    try {
      read = await this.#read(use, id, false);
    } catch (error) {
      if (error instanceof ComputerError && error.code === "stale") return this.#gone(use, before.window);
      // A window closing as it is read can fail the read with no reason, as on Windows: look once more.
      if (options.late && !use.signal?.aborted) {
        await sleep(LATE_CLOSE_MS, use.signal);
        const now = await this.#listWindows(use).catch(() => null);
        if (now && !now.has(id)) {
          this.#lost(use.state, id);
          return this.#gone(use, before.window);
        }
      }
      return unread(error, `Call computer_observe with window ${id}.`);
    }
    const after = read.snapshot;
    const parts: string[] = [];
    const hints: string[] = [];
    let news = false;
    if (options.popups) {
      const open = (popups: readonly WindowInfo[]) =>
        new Map(popups.map((popup) => [popup.id, { window: popup, over: use.state.popups.get(popup.id)?.over ?? id }] as const));
      try {
        const told = await this.#popupNews(use, open(before.popups), open([...after.popups, ...popupsIn(options.popups.result, after.window.pid)]), options.popups, { before, after });
        parts.push(...told.parts);
        hints.push(...told.hints);
        news = told.parts.length > 0;
      } catch (error) {
        if (use.signal?.aborted) throw error;
        const failed = unread(error, `Call computer_observe with window ${id}.`);
        parts.push(...failed.parts);
        hints.push(...failed.hints);
        news = true;
      }
    }
    const listed = diff(before, after);
    if (listed.length) {
      const shown = listed.slice(0, CHANGES_MAX_LINES);
      const more = listed.length - shown.length;
      this.#show(use.state, shown.map((change) => change.element));
      parts.push(`What changed in window ${id} (+ appeared, - went, ~ changed):\n${shown.map((change) => change.text).join("\n")}${more ? `\n...and ${more} more. Call computer_observe to see the whole window.` : ""}`);
    }
    const retitled = after.window.title !== before.window.title;
    if (retitled) parts.push(`The window's title is now "${after.window.title}".`);
    const dialogs = (snapshot: Snapshot) => snapshot.dialogs.map((dialog) => dialog.id).join();
    const changed = news || listed.length > 0 || retitled || dialogs(after) !== dialogs(before) || read.dropped;
    // An action whose window closes a moment later, as a dialog's button does, read it before it went.
    if (!changed && options.late) {
      await sleep(LATE_CLOSE_MS, use.signal);
      // A list that fails leaves the answer as it was: nothing changed.
      const now = await this.#listWindows(use).catch(() => null);
      if (now && !now.has(id)) {
        this.#lost(use.state, id);
        return this.#gone(use, before.window);
      }
    }
    if (!changed) parts.push(`Nothing changed in window ${id}'s tree.`);
    if (options.readBack) {
      const line = after.lines.find((candidate) => candidate.element?.ref === options.readBack);
      if (line) this.#show(use.state, [line.element]);
      parts.push(line ? `${options.readBack} now reads: ${flat(line)}` : `${options.readBack} is no longer in the tree.`);
    }
    if (after.dialogs.length) parts.push(after.dialogs.map(dialogLine).join(" "));
    if (after.partial) parts.push(`${cutShort(after.partial)}, so this may miss changes.`);
    if (read.moved) parts.push(read.moved);
    if (read.dropped) parts.push(`Window ${id} changed size, so your last image of it no longer applies.`);
    hints.push(`Call computer_observe with window ${id} for the whole tree.`);
    if (after.dialogs.length) hints.push("Observe a dialog by its window ID to act in it.");
    return { parts, hints, changed, after };
  }

  /** A window that closed after an action, and the window of its app that took its place, as when a dialog gives way to the app's main window (#402). */
  async #gone(use: Use, window: WindowInfo): Promise<Changes> {
    const now = await this.#listWindows(use).catch(() => null);
    const next = [...(now?.values() ?? [])].filter((other) => other.pid === window.pid && other.id !== window.id && other.width > 1 && other.height > 1).sort((a, b) => b.z - a.z)[0];
    if (!next) return { parts: [`Window ${window.id} closed.`], hints: ["Call computer_windows to see the windows open now."], changed: true, after: null };
    return { parts: [`Window ${window.id} closed. Its app's ${windowLine(next)}, is open.`], hints: [`Call computer_observe with window ${next.id} to read it.`], changed: true, after: null };
  }

  /**
   * Reads a window quickly: at most `budget` elements, with no image. With a
   * budget of 1, only for the popups it lists. Gives its snapshot only when
   * the whole tree fitted; null when Cua could not read it.
   */
  async #glance(use: Use, window: WindowInfo, budget: number): Promise<{ popups: WindowInfo[]; snapshot: Snapshot | null } | null> {
    const args = { pid: window.pid, window_id: window.id, include_screenshot: false, max_elements: budget, timeout_ms: GLANCE_MS };
    const { result, live } = await this.#call(use, "get_window_state", args, { readOnly: true });
    this.#outdated(use.state, window.id);
    if (result.isError) return null;
    const structured = obj(result.structuredContent);
    const popups = popupsOf(structured, window.pid).filter((popup) => popup.id !== window.id);
    this.#register(use.state, popups, window.id);
    if (budget === 1 || (await this.#twin(use, window, structured, false))) return { popups, snapshot: null };
    if (!whole(structured)) {
      use.state.large.add(window.id);
      return { popups, snapshot: null };
    }
    return { popups, snapshot: this.#snapshot(use, window, live.generation, structured, null) };
  }

  /** Reads a popup that opened, when Cua gives the popup's own elements; null when it gives another window's. */
  async #readPopup(use: Use, popup: WindowInfo): Promise<Snapshot | null> {
    const args = { pid: popup.pid, window_id: popup.id, include_screenshot: false, max_elements: this.#deps.smallTree ?? TREE_SMALL, timeout_ms: GLANCE_MS };
    try {
      const { result, live } = await this.#call(use, "get_window_state", args, { readOnly: true });
      if (result.isError) return null;
      const structured = obj(result.structuredContent);
      if (!fills(structured, popup)) {
        this.#outdated(use.state, popup.id);
        return null;
      }
      return this.#snapshot(use, popup, live.generation, structured, null);
    } catch (error) {
      if (error instanceof ComputerError && error.code === "driver") return null;
      throw error;
    }
  }

  /** Throws when a popup has closed, as the window it is over no longer lists it. */
  async #stillOpen(use: Use, popup: Popup): Promise<void> {
    const over = use.state.windows.get(popup.over);
    const seen = over ? await this.#glance(use, over, 1) : null;
    if (seen?.popups.some((open) => open.id === popup.window.id)) return;
    throw this.#closed(use.state, popup);
  }

  #closed(state: BoxState, popup: Popup): ComputerError {
    this.#lost(state, popup.window.id);
    const what = popup.what ? `, ${popup.what},` : "";
    return new ComputerError("stale", `Window ${popup.window.id}${what} has closed.`, "Call computer_windows to see the windows open now.");
  }

  /**
   * The desktop before an action on it or in a popup: its windows, the
   * popups open, and what is at the point. A window's tree is read only when
   * it is small: a web page's can take seconds.
   */
  async #watch(use: Use, point: Point | null): Promise<Watch> {
    const { state } = use;
    const windows = await this.#listWindows(use);
    const found = point ? windowAt(windows, point) : null;
    const owners = new Map<number, WindowInfo>();
    if (found) owners.set(found.id, found);
    for (const popup of state.popups.values()) {
      const over = windows.get(popup.over);
      if (over) owners.set(over.id, over);
    }
    const popups = new Map<number, Open>();
    const glanced = new Set<number>();
    let tree: Snapshot | null = null;
    for (const owner of owners.values()) {
      const small = owner === found && !state.large.has(owner.id);
      const seen = await this.#glance(use, owner, small ? (this.#deps.smallTree ?? TREE_SMALL) : 1);
      if (small) tree = seen?.snapshot ?? null;
      if (seen) glanced.add(owner.id);
      for (const popup of seen?.popups ?? []) popups.set(popup.id, { window: popup, over: state.popups.get(popup.id)?.over ?? owner.id });
    }
    // Forget popups that have closed, so later actions glance at their windows
    // no more, and do not read those windows' whole trees again.
    for (const popup of [...state.popups.values()]) {
      if (popups.has(popup.window.id)) continue;
      if (!windows.has(popup.over) || glanced.has(popup.over)) this.#lost(state, popup.window.id);
    }
    const hit = point ? [...popups.values()].filter((open) => inside(open.window, point)).at(-1) : undefined;
    if (hit) {
      return { windows, owners: [...owners.values()], popups, under: hit.window, tree: null, element: elementAt(state.snapshots.get(hit.window.id), point!) };
    }
    return { windows, owners: [...owners.values()], popups, under: found, tree, element: point ? elementAt(tree, point) : null };
  }

  /**
   * After an action on the desktop or in a popup, which Cua cannot check
   * itself: which popups and windows opened, closed or changed, and what
   * changed in the window under the point when bb-box read its tree. Looks
   * again for a moment while nothing has.
   */
  async #settle(use: Use, watch: Watch, cause: Cause): Promise<{ parts: string[]; hints: string[] }> {
    const deadline = Date.now() + (this.#deps.desktopWaitMs ?? DESKTOP_WAIT_MS);
    const parts: string[] = [];
    const hints: string[] = [];
    let now = watch.windows;
    let listed: string[] = [];
    let inside: Changes | null = null;
    try {
      let popups = watch.popups;
      for (let first = true; ; first = false) {
        if (!first) await sleep(LAUNCH_POLL_MS, use.signal);
        now = await this.#listWindows(use);
        listed = windowChanges(watch.windows, now);
        popups = new Map();
        for (const owner of watch.owners) {
          if (owner.id === watch.tree?.window.id || !now.has(owner.id)) continue;
          const seen = await this.#glance(use, owner, 1);
          for (const popup of seen?.popups ?? []) popups.set(popup.id, { window: popup, over: use.state.popups.get(popup.id)?.over ?? owner.id });
        }
        if (watch.tree && now.has(watch.tree.window.id)) {
          inside = await this.#changes(use, watch.tree);
          for (const popup of inside.after?.popups ?? []) popups.set(popup.id, { window: popup, over: watch.tree.window.id });
        }
        const moved = popups.size !== watch.popups.size || [...popups.keys()].some((id) => !watch.popups.has(id));
        if (listed.length || inside?.changed || moved || Date.now() >= deadline) break;
      }
      for (const id of watch.windows.keys()) if (!now.has(id)) this.#lost(use.state, id);
      const news = await this.#popupNews(use, watch.popups, popups, cause, watch.tree && inside?.after ? { before: watch.tree, after: inside.after } : null);
      parts.push(...news.parts);
      hints.push(...news.hints);
    } catch (error) {
      if (use.signal?.aborted) throw error;
      // The action was done: say so, not that nothing was.
      const failed = unread(error, 'Call computer_screenshot with window "desktop" to see the desktop now.');
      return { parts: failed.parts, hints: failed.hints };
    }
    if (inside?.changed && inside.after) {
      parts.push(...inside.parts);
      hints.push(...inside.hints);
    }
    if (listed.length) {
      const shown = listed.slice(0, CHANGES_MAX_LINES);
      const more = listed.length - shown.length;
      parts.push(`Windows that changed (+ opened, - closed, ~ changed):\n${shown.join("\n")}${more ? `\n...and ${more} more. Call computer_windows to see them all.` : ""}`);
      const opened = [...now.values()].filter((window) => !watch.windows.has(window.id) && window.width > 1 && window.height > 1).sort((a, b) => b.z - a.z);
      if (opened.length) hints.push(`Call computer_observe with window ${opened[0]!.id} to read it.`);
    }
    if (!parts.length) {
      const under = watch.under;
      if (under && !watch.tree && use.state.large.has(under.id)) {
        parts.push(`No window opened, closed or changed. bb-box did not read the tree of window ${under.id}, which is under that point, as it is too large to read quickly.`);
        hints.push(`Call computer_observe with window ${under.id} to see what changed in it, or computer_screenshot with window "desktop".`);
      } else {
        const tree = watch.tree ? ` and nothing changed in the tree of window ${watch.tree.window.id}, which is under that point` : "";
        parts.push(`No window opened, closed or changed${tree}. Anything else that changed shows only in pixels.`);
        hints.push('Call computer_screenshot with window "desktop" to see the desktop now.');
      }
    }
    return { parts, hints };
  }

  /**
   * Which popups opened and closed, in words, each that opened with its
   * items when Cua gives them. A popup bb-box named when it opened is named
   * again when it closes. `tree` is the window read before and after, whose
   * changes follow: a GTK app's menu items show there.
   */
  async #popupNews(
    use: Use,
    before: ReadonlyMap<number, Open>,
    after: ReadonlyMap<number, Open>,
    cause: Cause,
    tree: { before: Snapshot; after: Snapshot } | null = null,
  ): Promise<{ parts: string[]; hints: string[] }> {
    const { state } = use;
    const parts: string[] = [];
    const hints: string[] = [];
    for (const [id, open] of before) {
      if (after.has(id)) continue;
      const what = state.popups.get(id)?.what;
      if (what) {
        parts.push(`Closed ${what} (window ${id}).`);
        hints.push(`Call computer_observe with window ${open.over} to read the window it was open over.`);
      }
      this.#lost(state, id);
    }
    for (const [id, open] of after) {
      if (before.has(id)) continue;
      const snapshot = await this.#readPopup(use, open.window);
      const menu = snapshot ? snapshot.elements.some((element) => /menu/i.test(element.role)) : /menu|combo/i.test(cause.element?.role ?? "");
      const kind = cause.right ? "context menu" : menu ? "menu" : "popup";
      const label = cause.element?.label || open.window.title;
      const on = cause.right ? (cause.element ? ` on ${describe(cause.element.role, cause.element.label)}` : "") : label ? `: ${label}` : "";
      state.popups.set(id, { window: open.window, over: open.over, what: `the ${kind}${on.replace(/^:/, "")}` });
      state.windows.set(id, open.window);
      const opened = `Opened a ${kind}${on} (window ${id})`;
      if (!snapshot && tree?.after.window.id === open.over && menuItemsAppeared(tree.before, tree.after)) {
        parts.push(`${opened}. Its items show in window ${open.over}'s tree below.`);
        hints.push(`Act on its items by reference. To close it, press Escape with computer_type and window ${id}.`);
        continue;
      }
      if (!snapshot) {
        parts.push(`${opened}, whose items bb-box cannot read.`);
        hints.push('Call computer_screenshot with window "desktop" to see it, then click its items by pixels.');
        continue;
      }
      const indent = Math.min(...snapshot.lines.map((line) => /^ */.exec(line.text)![0].length));
      const lines = snapshot.lines.slice(0, POPUP_LINES);
      this.#show(state, lines.map((line) => line.element));
      const shown = lines.map((line) => line.text.slice(indent));
      const more = snapshot.lines.length - shown.length;
      parts.push(`${opened}:\n${shown.join("\n")}${more ? `\n...and ${more} more. Call computer_observe with window ${id} to see them all.` : ""}`);
      hints.push(`Act on its items by reference. To close it, press Escape with computer_type and window ${id}.`);
    }
    return { parts, hints };
  }
}

/** What bb-box says when it cannot read what an action it did changed. */
function unread(error: unknown, hint: string): Changes {
  if (error instanceof ComputerError && (error.code === "paused" || error.code === "interrupted")) {
    return {
      parts: ["A person took control of the desktop before bb-box could read what changed."],
      hints: [AFTER_PAUSE],
      changed: true,
      after: null,
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { parts: [`bb-box could not read what changed: ${message}`], hints: [hint], changed: true, after: null };
}

/** Said of an action Cua could not do in the background, or that has no background. */
const POINTER = ", with the real pointer (the desktop's focus may have moved)";
const KEYBOARD = ", with the real keyboard (the desktop's focus may have moved)";
/** Said of a click on an element at its centre (048). */
const BY_POSITION = "The desktop could not click it as an element, so bb-box clicked where it is drawn.";

/** A line of text that cannot be acted on: `- static = "Hello"`. */
const PASSIVE = /^(\s*)- ([^"\n]+?) = "([\s\S]*)"$/;

/**
 * Drops text lines with no name, such as those whose name was only U+FFFC,
 * and makes each run of static text at one depth one line. A space inside a
 * run is kept.
 */
function mergeText(lines: readonly Line[]): Line[] {
  const out: Line[] = [];
  const runs = new Map<Line, string[]>();
  for (const line of lines) {
    const passive = line.element ? null : PASSIVE.exec(line.text);
    const last = out.at(-1);
    const run = last && runs.get(last);
    if (passive?.[2] === "static" && run && last.depth === line.depth) {
      run.push(passive[3]!);
      continue;
    }
    if (passive && !passive[3]!.trim()) continue;
    out.push(line);
    if (passive?.[2] === "static") runs.set(line, [passive[3]!]);
  }
  return out.map((line) => {
    const pieces = runs.get(line);
    return pieces && pieces.length > 1 ? { ...line, text: `${PASSIVE.exec(line.text)![1]}- static = "${joinText(pieces).trim()}"` } : line;
  });
}

/**
 * Lines that appeared, went or changed between two snapshots of a window,
 * each with the element it shows now, if any. Elements whose references
 * carried over are matched by reference; other lines by their text.
 */
function diff(before: Snapshot, after: Snapshot): { text: string; element: Element | null }[] {
  const keyed = (snapshot: Snapshot) => new Map(snapshot.lines.filter((line) => line.element?.unique).map((line) => [line.element!.ref, line] as const));
  const loose = (snapshot: Snapshot) => snapshot.lines.filter((line) => !line.element?.unique);
  const was = keyed(before);
  const now = keyed(after);
  const out: { text: string; element: Element | null }[] = [];
  const bare = (line: Line) => flat(line).replace(/^\[e\d+\] /, "");
  for (const [ref, line] of now) {
    const old = was.get(ref);
    if (!old) out.push({ text: `+ ${flat(line)}`, element: line.element });
    else if (bare(old) !== bare(line)) out.push({ text: `~ ${flat(line)}`, element: line.element });
  }
  for (const [ref, line] of was) if (!now.has(ref)) out.push({ text: `- ${flat(line)}`, element: null });
  const counts = new Map<string, number>();
  for (const line of loose(before)) counts.set(bare(line), (counts.get(bare(line)) ?? 0) + 1);
  for (const line of loose(after)) {
    const left = counts.get(bare(line)) ?? 0;
    if (left > 0) counts.set(bare(line), left - 1);
    else out.push({ text: `+ ${flat(line)}`, element: line.element });
  }
  for (const line of loose(before)) {
    const left = counts.get(bare(line)) ?? 0;
    if (left > 0) {
      counts.set(bare(line), left - 1);
      out.push({ text: `- ${flat(line)}`, element: null });
    }
  }
  return out;
}
