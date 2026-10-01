// Computer use (015). The agent drives a desktop box through bb-box's six
// computer tools, and bb-box drives the Cua Driver in the box over one MCP
// session per box. bb-box owns the references the agent sees, keeps pixels
// with the image they came from, retries in the foreground an action Cua
// cannot do in the background, says which menus and popups an action opened
// or closed, and refuses everything while a person holds the box's desktop.
// The agent never sees Cua's own words for what went wrong.

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
}

/** An image the agent was given, with the size of the screen or window it shows, in their own pixels. */
interface Held extends Size {
  readonly source: Size;
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
    .replace(/\s*[([][^()[\]]*[=_][^()[\]]*[)\]]/g, "")
    .split(/(?<=[.;!?])\s+|\s+[\u2013\u2014]\s+/)
    .filter((clause) => !CUA_ADVICE.test(clause) && !/\b[a-z]+_[a-z_]+\b|\bCua\b/i.test(clause))
    .join(" ")
    .trim()
    .replace(/[;,:]$/, "");
  if (!text) return "The desktop gave no reason.";
  const said = sentence(`${text[0]!.toUpperCase()}${text.slice(1)}`);
  return said.length > 500 ? `${said.slice(0, 500)}...` : said;
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

/** Why Cua stopped reading a tree early, in words. */
function cutShort(reason: string): string {
  return /time|deadline|long/i.test(reason) ? `Reading the tree took longer than ${WALK_MS / 1000} s` : "bb-box read only part of the tree";
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
        const { result } = await this.#call(use, "get_desktop_state", { max_image_dimension: IMAGE_MAX_EDGE }, { readOnly: true });
        if (result.isError) throw new ComputerError("driver", `bb-box could not take an image of the desktop: ${explain(result)}`, "Try again in a few seconds.");
        const image = imageOf(result);
        if (!image) throw new ComputerError("driver", "bb-box got no image of the desktop.", "Try again in a few seconds.");
        const structured = obj(result.structuredContent);
        for (const raw of arr(structured.windows)) {
          const found = windowOf(raw);
          if (found) use.state.windows.set(found.id, found);
        }
        const screen = { width: num(structured.screen_width) ?? image.width, height: num(structured.screen_height) ?? image.height };
        use.state.images.set("desktop", { width: image.width, height: image.height, source: screen });
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
      // On the desktop or in a popup, Cua cannot say what changed: bb-box looks before and after.
      const inPopup = !!target.snapshot && use.state.popups.has(target.snapshot.window.id);
      const watch = target.screen || inPopup ? await this.#watch(use, target.screen ?? null) : null;
      const { result, foreground } = await this.#deliver(use, step.tool, { ...target.args, ...step.args }, input.action !== "set_value");
      const done = `${step.done} ${target.label}${input.action === "set_value" ? ` to "${input.value}"` : ""}${foreground ? POINTER : ""}.`;
      const lines = [target.coordinates ? `${done} ${target.coordinates}` : done];
      const cause: Cause = { element: watch?.element ?? target.element, right: input.action === "right_click" };
      const seen = watch ? await this.#settle(use, watch, cause) : await this.#changes(use, target.snapshot!, { popups: { ...cause, result } });
      return { text: [...lines, ...seen.parts].join("\n\n"), hints: seen.hints };
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
    if (input.ref !== undefined) {
      const { snapshot, element } = await this.#element(use, input.ref);
      popup = use.state.popups.get(snapshot.window.id);
      args = { pid: snapshot.window.pid, window_id: snapshot.window.id, ...this.#token(snapshot, element) };
      label = `${element.ref} (${describe(element.role, element.label)})`;
      before = snapshot;
      readBack = element.ref;
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
    const { foreground } = await this.#deliver(use, tool, { ...args, ...typed }, true);
    const lines = [`${what} ${keys ? "in" : "into"} ${label}${foreground ? KEYBOARD : ""}.`];
    if (!before) {
      return { text: lines.join("\n\n"), hints: [`Call computer_observe with window ${args.window_id} to see it.`] };
    }
    const changed = await this.#changes(use, before, { readBack, popups: { element: null, right: false, result: null } });
    return { text: [...lines, ...changed.parts].join("\n\n"), hints: changed.hints };
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
      let windows = arr(obj(result.structuredContent).windows)
        .map(windowOf)
        .filter((window): window is WindowInfo => !!window && !before.has(window.id));
      for (const window of windows) use.state.windows.set(window.id, window);
      // A URL can open in a browser window that was already open, which then changes its title.
      const launched = num(obj(result.structuredContent).pid);
      const browser = (window: WindowInfo) => BROWSER.test(window.app) || (launched !== undefined && window.pid === launched);
      let reused: WindowInfo | null = null;
      const waited = this.#deps.launchWaitMs ?? LAUNCH_WAIT_MS;
      const deadline = Date.now() + waited;
      while (!windows.length && !reused && Date.now() < deadline) {
        await sleep(LAUNCH_POLL_MS, use.signal);
        const now = await this.#listWindows(use);
        windows = [...now.values()].filter((window) => !before.has(window.id) && window.width > 1 && window.height > 1);
        if (input.url !== undefined) {
          reused = [...now.values()].find((window) => before.has(window.id) && before.get(window.id)!.title !== window.title && browser(window)) ?? null;
        }
      }
      if (!windows.length && !reused) {
        const where = input.url !== undefined ? " It may have opened in a browser window that was already open." : "";
        return { text: `Opened ${what}, but no new window appeared within ${Math.round(waited / 1000)} s.${where}`, hints: ["Call computer_windows to see the windows now."] };
      }
      // A browser names its window after the page once the page has a title.
      let page = reused ?? windows[0]!;
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
        lines.push(`The page is still loading: its window's title is still ${page.title ? `"${page.title}"` : "empty"}.`);
      }
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
    state.popups.clear();
    state.large.clear();
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
          throw new ComputerError("driver", `bb-box's request to the desktop failed: ${sentence(error.message)}`, "This is probably a bb-box bug: tell the user.");
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
   * do it in the background. Cua says so before it does anything. An action
   * on the desktop has no background, so it needs no note that it went in
   * the foreground.
   */
  async #deliver(use: Use, tool: string, args: Json, delivery: boolean): Promise<{ result: McpResult; foreground: boolean }> {
    let result: McpResult;
    let foreground = false;
    if (args.scope === "desktop") {
      ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
    } else {
      ({ result } = await this.#call(use, tool, delivery ? { ...args, delivery_mode: "background" } : args, { readOnly: false }));
      if (delivery && refusedInBackground(result)) {
        ({ result } = await this.#call(use, tool, { ...args, delivery_mode: "foreground" }, { readOnly: false }));
        foreground = true;
      }
    }
    if (result.isError) {
      const code = codeOf(result);
      const id = num(args.window_id);
      if (code === "stale_element_token" && id !== undefined) this.#outdated(use.state, id);
      throw new ComputerError("refused", `bb-box could not do it: ${explain(result)}`, adviceFor(code));
    }
    return { result, foreground };
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
    const snapshot = this.#snapshot(use.state, window, live.generation, structured, image);
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
        frame: rectOf(entry.frame),
      };
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

    const complete = structured.elements_complete !== false && structured.truncated !== true;
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
    let elements = 0;
    let chars = 0;
    for (const index of chosen) {
      const line = lines[index]!;
      if (shown.length >= limit || chars + line.text.length > TREE_MAX_CHARS) break;
      if (line.element) elements++;
      chars += line.text.length + 1;
      shown.push(line.text);
    }
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
    const popup = use.state.popups.get(entry.windowId);
    if (!snapshot || snapshot.generation !== use.state.live?.generation) {
      snapshot = (await this.#read(use, entry.windowId, false)).snapshot;
    } else if (popup) {
      await this.#stillOpen(use, popup);
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
      // desktop in this session, which is the agent's: bb-box takes no other.
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
   * Reads the window again after an action and says what changed. With
   * `popups`, also which popups over it the action opened or closed.
   */
  async #changes(
    use: Use,
    before: Snapshot,
    options: { readBack?: string | null; popups?: Cause & { result: McpResult | null } } = {},
  ): Promise<Changes> {
    const id = before.window.id;
    let read: Read;
    try {
      read = await this.#read(use, id, false);
    } catch (error) {
      if (error instanceof ComputerError && error.code === "stale") {
        return { parts: [`Window ${id} closed.`], hints: ["Call computer_windows to see the windows open now."], changed: true, after: null };
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
      parts.push(`What changed in window ${id} (+ appeared, - went, ~ changed):\n${shown.join("\n")}${more ? `\n...and ${more} more. Call computer_observe to see the whole window.` : ""}`);
    }
    const retitled = after.window.title !== before.window.title;
    if (retitled) parts.push(`The window's title is now "${after.window.title}".`);
    const dialogs = (snapshot: Snapshot) => snapshot.dialogs.map((dialog) => dialog.id).join();
    const changed = news || listed.length > 0 || retitled || dialogs(after) !== dialogs(before) || read.dropped;
    if (!changed) parts.push(`Nothing changed in window ${id}'s tree.`);
    if (options.readBack) {
      const line = after.lines.find((candidate) => candidate.element?.ref === options.readBack);
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
    if (structured.elements_complete === false || structured.truncated === true) {
      use.state.large.add(window.id);
      return { popups, snapshot: null };
    }
    return { popups, snapshot: this.#snapshot(use.state, window, live.generation, structured, null) };
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
      return this.#snapshot(use.state, popup, live.generation, structured, null);
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
    let tree: Snapshot | null = null;
    for (const owner of owners.values()) {
      const small = owner === found && !state.large.has(owner.id);
      const seen = await this.#glance(use, owner, small ? (this.#deps.smallTree ?? TREE_SMALL) : 1);
      if (small) tree = seen?.snapshot ?? null;
      for (const popup of seen?.popups ?? []) popups.set(popup.id, { window: popup, over: state.popups.get(popup.id)?.over ?? owner.id });
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
      const shown = snapshot.lines.slice(0, POPUP_LINES).map((line) => line.text.slice(indent));
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
      hints: ["Wait until they hand control back, then call computer_observe."],
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
