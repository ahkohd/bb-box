import { PRODUCT } from "../brand.ts";
import type { DeviceElement, ElementFrame, Orientation, VideoSize } from "../core/device.ts";
import { DriverError } from "./driver.ts";

export const NODE_FLAGS = {
  clickable: 1,
  longClickable: 2,
  scrollable: 4,
  editable: 8,
  enabled: 16,
  focused: 32,
  checkable: 64,
  checked: 128,
  selected: 256,
  password: 512,
  visible: 1024,
  showingHint: 2048,
  focusable: 4096,
} as const;

export const WINDOW_TYPES = { application: 1, inputMethod: 2, system: 3, accessibilityOverlay: 4, splitDivider: 5, magnification: 6 } as const;

const DISPLAY_TURNS: readonly Orientation[] = ["upright", "turned-left", "upside-down", "turned-right"];
const MOST_DEPTH = 80;

export type Bounds = readonly [left: number, top: number, right: number, bottom: number];

export interface AndroidNode {
  readonly className: string;
  readonly text: string;
  readonly description: string;
  readonly hint: string;
  readonly id: string;
  readonly state: string;
  readonly range: readonly [min: number, max: number, current: number] | null;
  readonly bounds: Bounds;
  readonly flags: number;
  readonly children: readonly AndroidNode[];
}

export interface AndroidWindow {
  readonly type: number;
  readonly layer: number;
  readonly title: string;
  readonly active: boolean;
  readonly focused: boolean;
  readonly bounds: Bounds;
  readonly pkg: string;
  readonly root: AndroidNode | null;
}

export interface AndroidScreen {
  readonly source: "server" | "dump";
  readonly rotation: number;
  readonly display: VideoSize | null;
  readonly windows: readonly AndroidWindow[];
}

export interface Picture {
  readonly video: VideoSize;
  readonly physical: Orientation;
}

export type AppLabels = (pkg: string) => string | null;

function has(flags: number, flag: number): boolean {
  return (flags & flag) !== 0;
}

function text(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

function count(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : 0;
}

function boundsOf(raw: unknown): Bounds {
  if (!Array.isArray(raw) || raw.length !== 4 || !raw.every((each) => typeof each === "number" && Number.isFinite(each))) return [0, 0, 0, 0];
  return [raw[0], raw[1], raw[2], raw[3]];
}

function serverNode(raw: unknown, depth: number): AndroidNode {
  const node = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const range = Array.isArray(node.r) && node.r.length === 3 && node.r.every((each) => typeof each === "number") ? (node.r as [number, number, number]) : null;
  const children = depth < MOST_DEPTH && Array.isArray(node.k) ? node.k.map((child) => serverNode(child, depth + 1)) : [];
  return { className: text(node.c), text: text(node.t), description: text(node.d), hint: text(node.h), id: text(node.i), state: text(node.s), range, bounds: boundsOf(node.b), flags: count(node.f), children };
}

export type ServerAnswer = { readonly ok: true; readonly screen: AndroidScreen; readonly held: boolean; readonly ms: number } | { readonly ok: false; readonly code: string; readonly words: string };

export function parseServerTree(line: string): ServerAnswer {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new DriverError("failed", `${PRODUCT}'s tree server answered with something that is not JSON: ${line.slice(0, 120)}`);
  }
  const answer = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  if (answer.ok !== true) return { ok: false, code: text(answer.code) || "failed", words: text(answer.words) || `${PRODUCT}'s tree server refused without saying why.` };
  if (!Array.isArray(answer.windows)) throw new DriverError("failed", `${PRODUCT}'s tree server answered a tree with no windows.`);
  const windows = answer.windows.map((each): AndroidWindow => {
    const window = (typeof each === "object" && each !== null ? each : {}) as Record<string, unknown>;
    return {
      type: count(window.type),
      layer: count(window.layer),
      title: text(window.title),
      active: window.active === true,
      focused: window.focused === true,
      bounds: boundsOf(window.b),
      pkg: text(window.pkg),
      root: window.root === undefined ? null : serverNode(window.root, 0),
    };
  });
  const width = count(answer.width);
  const height = count(answer.height);
  return {
    ok: true,
    screen: { source: "server", rotation: count(answer.rotation), display: width > 0 && height > 0 ? { width, height } : null, windows },
    held: answer.held === true,
    ms: count(answer.ms),
  };
}

const ENTITIES: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

function unescaped(value: string): string {
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (whole, name: string) => {
    if (name.startsWith("#x")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number.parseInt(name.slice(1), 10));
    return ENTITIES[name] ?? whole;
  });
}

function attributes(source: string): ReadonlyMap<string, string> {
  const found = new Map<string, string>();
  for (const match of source.matchAll(/([\w:-]+)="([^"]*)"/g)) found.set(match[1]!, unescaped(match[2]!));
  return found;
}

function dumpBounds(raw: string | undefined): Bounds {
  const match = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(raw ?? "");
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), Number(match[4])] : [0, 0, 0, 0];
}

const EDITABLE_CLASS = /EditText|AutoCompleteTextView|SearchAutoComplete/;

function dumpNode(found: ReadonlyMap<string, string>, children: AndroidNode[]): AndroidNode & { children: AndroidNode[] } {
  const yes = (name: string) => found.get(name) === "true";
  const className = found.get("class") ?? "";
  const flags =
    (yes("clickable") ? NODE_FLAGS.clickable : 0) |
    (yes("long-clickable") ? NODE_FLAGS.longClickable : 0) |
    (yes("scrollable") ? NODE_FLAGS.scrollable : 0) |
    (EDITABLE_CLASS.test(className) ? NODE_FLAGS.editable : 0) |
    (yes("enabled") ? NODE_FLAGS.enabled : 0) |
    (yes("focused") ? NODE_FLAGS.focused : 0) |
    (yes("checkable") ? NODE_FLAGS.checkable : 0) |
    (yes("checked") ? NODE_FLAGS.checked : 0) |
    (yes("selected") ? NODE_FLAGS.selected : 0) |
    (yes("password") ? NODE_FLAGS.password : 0) |
    (yes("focusable") ? NODE_FLAGS.focusable : 0);
  const bounds = dumpBounds(found.get("bounds"));
  const shown = bounds[2] > bounds[0] && bounds[3] > bounds[1];
  return {
    className,
    text: (found.get("text") ?? "").trim(),
    description: (found.get("content-desc") ?? "").trim(),
    hint: (found.get("hint") ?? "").trim(),
    id: found.get("resource-id") ?? "",
    state: "",
    range: null,
    bounds,
    flags: shown ? flags | NODE_FLAGS.visible : flags,
    children,
  };
}

export function parseDump(xml: string): AndroidScreen {
  const start = xml.indexOf("<hierarchy");
  if (start < 0) throw new DriverError("failed", `uiautomator gave no tree: ${xml.trim().split("\n").slice(-2).join(" ").slice(0, 200) || "nothing at all"}`);
  const rotation = Number(attributes(/<hierarchy([^>]*)>/.exec(xml.slice(start))?.[1] ?? "").get("rotation") ?? 0);
  const roots: AndroidNode[] = [];
  const open: (AndroidNode & { children: AndroidNode[] })[] = [];
  for (const tag of xml.slice(start).matchAll(/<(\/?)node\b([^>]*?)(\/?)>/g)) {
    if (tag[1]) {
      const done = open.pop();
      if (done && !open.length) roots.push(done);
      continue;
    }
    const node = dumpNode(attributes(tag[2]!), []);
    if (open.length) open.at(-1)!.children.push(node);
    if (tag[3]) {
      if (!open.length) roots.push(node);
    } else open.push(node);
  }
  const pkgOf = (source: string) => /package="([^"]*)"/.exec(source)?.[1] ?? "";
  const packages = [...xml.slice(start).matchAll(/<node\b[^>]*>/g)].map((tag) => pkgOf(tag[0]));
  let next = 0;
  const windows = roots.map((root, index): AndroidWindow => {
    const pkg = packages[next] ?? "";
    next += nodeCount(root);
    return { type: WINDOW_TYPES.application, layer: roots.length - index, title: "", active: index === 0, focused: index === 0, bounds: root.bounds, pkg, root };
  });
  return { source: "dump", rotation: Number.isFinite(rotation) ? rotation : 0, display: null, windows };
}

function nodeCount(node: AndroidNode): number {
  return 1 + node.children.reduce((sum, child) => sum + nodeCount(child), 0);
}

function turnsOf(orientation: Orientation): number {
  return Math.max(0, DISPLAY_TURNS.indexOf(orientation));
}

function natural(size: VideoSize, turns: number): VideoSize {
  return turns % 2 === 0 ? size : { width: size.height, height: size.width };
}

function fromDisplay(x: number, y: number, turns: number, panel: VideoSize): { readonly u: number; readonly v: number } {
  switch (turns % 4) {
    case 1:
      return { u: panel.width - y, v: x };
    case 2:
      return { u: panel.width - x, v: panel.height - y };
    case 3:
      return { u: y, v: panel.height - x };
    default:
      return { u: x, v: y };
  }
}

function toPicture(u: number, v: number, turns: number, panel: VideoSize): { readonly x: number; readonly y: number } {
  switch (turns % 4) {
    case 1:
      return { x: v, y: panel.width - u };
    case 2:
      return { x: panel.width - u, y: panel.height - v };
    case 3:
      return { x: panel.height - v, y: u };
    default:
      return { x: u, y: v };
  }
}

export interface Placement {
  readonly displayTurns: number;
  readonly pictureTurns: number;
  readonly displayPanel: VideoSize;
  readonly panel: VideoSize;
}

export function placement(screen: Pick<AndroidScreen, "rotation" | "display">, picture: Picture): Placement {
  const pictureTurns = turnsOf(picture.physical);
  const panel = natural(picture.video, pictureTurns);
  const displayTurns = ((screen.rotation % 4) + 4) % 4;
  const displayPanel = screen.display ? natural(screen.display, displayTurns) : panel;
  return { displayTurns, pictureTurns, displayPanel, panel };
}

export function pictureFrame(bounds: Bounds, place: Placement): ElementFrame {
  const scaleX = place.panel.width / (place.displayPanel.width || place.panel.width);
  const scaleY = place.panel.height / (place.displayPanel.height || place.panel.height);
  const corners = [
    [bounds[0], bounds[1]],
    [bounds[2], bounds[3]],
  ].map(([x, y]) => {
    const { u, v } = fromDisplay(x!, y!, place.displayTurns, place.displayPanel);
    return toPicture(u * scaleX, v * scaleY, place.pictureTurns, place.panel);
  });
  const left = Math.round(Math.min(corners[0]!.x, corners[1]!.x));
  const top = Math.round(Math.min(corners[0]!.y, corners[1]!.y));
  const right = Math.round(Math.max(corners[0]!.x, corners[1]!.x));
  const bottom = Math.round(Math.max(corners[0]!.y, corners[1]!.y));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

const ROLES: readonly (readonly [RegExp, string])[] = [
  [/Switch/, "switch"],
  [/ToggleButton/, "toggle button"],
  [/CheckBox|CheckedTextView/, "check box"],
  [/RadioButton/, "radio button"],
  [/SeekBar|Slider|RatingBar/, "slider"],
  [/ProgressBar/, "progress bar"],
  [/EditText|AutoCompleteTextView|SearchAutoComplete/, "text field"],
  [/Button$/, "button"],
  [/Spinner/, "pop up button"],
  [/WebView/, "web view"],
  [/ImageView|Image$/, "image"],
  [/TextView$/, "text"],
  [/RecyclerView|ListView|GridView/, "list"],
  [/ViewPager/, "pager"],
  [/ScrollView/, "scroll view"],
  [/TabWidget|TabLayout/, "tab bar"],
  [/Toolbar|ActionBar/, "toolbar"],
];

function roleOf(node: AndroidNode): string {
  const short = node.className.split(".").at(-1) ?? "";
  if (isPageNotShown(node)) return "web view";
  if (node.range && has(node.flags, NODE_FLAGS.focusable)) return "slider";
  if (has(node.flags, NODE_FLAGS.editable)) return has(node.flags, NODE_FLAGS.password) ? "secure text field" : "text field";
  const tappable = has(node.flags, NODE_FLAGS.clickable) || has(node.flags, NODE_FLAGS.longClickable);
  for (const [pattern, role] of ROLES) if (pattern.test(short)) return tappable && (role === "text" || role === "image") ? "button" : role;
  if (has(node.flags, NODE_FLAGS.checkable)) return "check box";
  if (tappable) return "button";
  if (has(node.flags, NODE_FLAGS.scrollable)) return "scroll view";
  if ((node.text || node.description) && !node.children.length) return "text";
  return "group";
}

function identifierOf(id: string, pkg: string): string | null {
  if (!id) return null;
  return id.startsWith(`${pkg}:id/`) ? id.slice(pkg.length + 4) : id;
}

export const PAGE_NOT_SHOWN_WORDS = "its page is not in the tree: Chrome is not showing the page to accessibility now. Use computer_screenshot to see it";

function isPageNotShown(node: AndroidNode): boolean {
  return node.description === "Web View" && !node.children.length;
}

function valueOf(node: AndroidNode, editable: boolean): string | null {
  if (isPageNotShown(node)) return PAGE_NOT_SHOWN_WORDS;
  if (editable) return has(node.flags, NODE_FLAGS.showingHint) || !node.text ? null : node.text;
  if (node.state) return node.state;
  if (has(node.flags, NODE_FLAGS.checkable)) return has(node.flags, NODE_FLAGS.checked) ? "on" : "off";
  if (node.range) return String(Math.round(node.range[2] * 100) / 100);
  if (has(node.flags, NODE_FLAGS.selected) && (has(node.flags, NODE_FLAGS.clickable) || has(node.flags, NODE_FLAGS.longClickable))) return "selected";
  return null;
}

function labelOf(node: AndroidNode, editable: boolean): string {
  if (editable) return node.description || node.hint || (has(node.flags, NODE_FLAGS.showingHint) ? node.text : "");
  return node.description || node.text;
}

export function placedOffScreen(frame: ElementFrame, viewport: ElementFrame, screen: VideoSize): ElementFrame | null {
  const width = Math.max(frame.width, 1);
  const height = Math.max(frame.height, 1);
  if (frame.y >= viewport.y + viewport.height - 1) return { x: frame.x, y: Math.max(frame.y, screen.height), width, height };
  if (frame.y + frame.height <= viewport.y + 1) return { x: frame.x, y: Math.min(frame.y, 0) - height, width, height };
  if (frame.x >= viewport.x + viewport.width - 1) return { x: Math.max(frame.x, screen.width), y: frame.y, width, height };
  if (frame.x + frame.width <= viewport.x + 1) return { x: Math.min(frame.x, 0) - width, y: frame.y, width, height };
  return null;
}

interface Converting {
  readonly place: Placement;
  readonly screen: VideoSize;
  readonly viewport: ElementFrame;
  readonly pkg: string;
}

function isPlainText(element: DeviceElement): boolean {
  return !!element.label && !element.children.length && !element.can?.tap && !element.can?.edit && !element.can?.scroll && element.role !== "image";
}

function converted(node: AndroidNode, context: Converting): DeviceElement[] {
  const frame = pictureFrame(node.bounds, context.place);
  const shown = has(node.flags, NODE_FLAGS.visible);
  const scrollable = has(node.flags, NODE_FLAGS.scrollable);
  const inside = scrollable && shown ? { ...context, viewport: frame } : context;
  let children = node.children.flatMap((child) => converted(child, inside));
  const editable = has(node.flags, NODE_FLAGS.editable);
  const enabled = has(node.flags, NODE_FLAGS.enabled);
  const tappable = has(node.flags, NODE_FLAGS.clickable) || has(node.flags, NODE_FLAGS.longClickable) || has(node.flags, NODE_FLAGS.checkable);
  let label = labelOf(node, editable);
  const value = valueOf(node, editable);
  const actionable = tappable || editable || scrollable;
  if (!actionable && !label && value === null) return children;
  if (tappable && !editable && !label) {
    const merged = children.filter(isPlainText);
    if (merged.length) {
      label = [...new Set(merged.map((each) => each.label))].join(", ");
      children = children.filter((each) => !merged.includes(each));
    }
  }
  const placed = shown ? frame : frame.width > 0 && frame.height > 0 ? placedOffScreen(frame, context.viewport, context.screen) : null;
  if (!placed) return children;
  return [
    {
      role: roleOf(node),
      identifier: identifierOf(node.id, context.pkg),
      label,
      value,
      frame: placed,
      enabled,
      focused: has(node.flags, NODE_FLAGS.focused),
      can: { tap: enabled && tappable, edit: enabled && editable, scroll: scrollable },
      children,
    },
  ];
}

function windowOrder(windows: readonly AndroidWindow[]): readonly AndroidWindow[] {
  const shown = windows.filter((window) => window.root && window.type !== WINDOW_TYPES.accessibilityOverlay && window.type !== WINDOW_TYPES.magnification && window.type !== WINDOW_TYPES.splitDivider);
  const byLayer = [...shown].sort((a, b) => b.layer - a.layer);
  const apps = byLayer.filter((window) => window.type === WINDOW_TYPES.application);
  const front = apps.find((window) => window.active) ?? apps.find((window) => window.focused) ?? apps[0];
  return front ? [front, ...byLayer.filter((window) => window !== front)] : byLayer;
}

export function windowName(window: AndroidWindow, labels: AppLabels): string {
  if (window.type === WINDOW_TYPES.application) return labels(window.pkg) ?? (window.title || window.pkg);
  if (window.type === WINDOW_TYPES.inputMethod) return window.title || "Keyboard";
  return window.title || "System UI";
}

function windowElement(window: AndroidWindow, context: Converting, labels: AppLabels): DeviceElement {
  const keyboard = window.type === WINDOW_TYPES.inputMethod;
  return {
    role: window.type === WINDOW_TYPES.application ? "application" : keyboard ? "keyboard" : "system",
    identifier: null,
    label: windowName(window, labels),
    value: null,
    frame: pictureFrame(window.bounds, context.place),
    enabled: true,
    focused: window.focused,
    can: { tap: false, edit: false, scroll: false },
    children: keyboard || !window.root ? [] : converted(window.root, context),
  };
}

export interface AndroidElements {
  readonly elements: readonly DeviceElement[];
  readonly byLayer: readonly DeviceElement[];
}

export function androidElements(screen: AndroidScreen, picture: Picture, labels: AppLabels): AndroidElements {
  const place = placement(screen, picture);
  const ordered = windowOrder(screen.windows);
  const whole = { x: 0, y: 0, ...picture.video };
  const made = new Map(ordered.map((window) => [window, windowElement(window, { place, screen: picture.video, viewport: whole, pkg: window.pkg }, labels)] as const));
  const byLayer = [...ordered].sort((a, b) => b.layer - a.layer).map((window) => made.get(window)!);
  return { elements: ordered.map((window) => made.get(window)!), byLayer };
}

function contains(frame: ElementFrame, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height;
}

export function androidElementAt(read: AndroidElements, point: { readonly x: number; readonly y: number }): DeviceElement | null {
  for (const window of read.byLayer) {
    if (!contains(window.frame, point)) continue;
    let best: DeviceElement | null = null;
    const walk = (element: DeviceElement) => {
      if (!contains(element.frame, point)) return;
      best = element;
      for (const child of element.children) walk(child);
    };
    for (const child of window.children) walk(child);
    return best ?? { ...window, children: [] };
  }
  return null;
}
