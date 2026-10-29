import type { DeviceElement, ElementFrame } from "../core/device.ts";
import { DriverError } from "./driver.ts";

const TAPPABLE_TRAITS = new Set(["Button", "Link", "LaunchIcon", "KeyboardKey", "TabBarItem", "ToggleButton", "Adjustable", "TextEntry", "SearchField"]);
const TAPPABLE_ROLES = new Set(["AXButton", "AXLink", "AXCell", "AXSwitch", "AXToggle", "AXTab", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXTextField", "AXSecureTextField", "AXSearchField", "AXTextArea"]);
const EDITABLE_ROLES = new Set(["AXTextField", "AXSecureTextField", "AXSearchField"]);
const FOCUSED_TRAITS = new Set(["IsEditing", "Focused"]);
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;
const MOST_DEPTH = 60;
export const SWITCH_KNOB_POINTS = { width: 63, fromRight: 14 } as const;
const ROW_SWITCH_WIDE_BY = 3;

interface IdbElement {
  readonly role?: unknown;
  readonly subrole?: unknown;
  readonly type?: unknown;
  readonly AXLabel?: unknown;
  readonly AXValue?: unknown;
  readonly AXUniqueId?: unknown;
  readonly title?: unknown;
  readonly frame?: unknown;
  readonly enabled?: unknown;
  readonly traits?: unknown;
  readonly children?: unknown;
}

function words(raw: unknown): string {
  return typeof raw === "string" ? raw.replace(DIRECTION_MARKS, "").trim() : "";
}

export function roleWords(role: string): string {
  const bare = role.replace(/^AX/, "");
  return bare.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() || "element";
}

function traitsOf(element: IdbElement): ReadonlySet<string> {
  return new Set(Array.isArray(element.traits) ? element.traits.filter((trait): trait is string => typeof trait === "string") : []);
}

function frameOf(raw: unknown, scale: number): ElementFrame {
  const read = (key: string) => {
    const value = (raw as Record<string, unknown> | null)?.[key];
    return typeof value === "number" && Number.isFinite(value) ? value : 0;
  };
  const left = Math.round(read("x") * scale);
  const top = Math.round(read("y") * scale);
  const right = Math.round((read("x") + read("width")) * scale);
  const bottom = Math.round((read("y") + read("height")) * scale);
  return { x: left, y: top, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

function roleOf(element: IdbElement, traits: ReadonlySet<string>): string {
  const subrole = words(element.subrole);
  if (subrole && subrole !== "AXStandardWindow") return subrole;
  if (traits.has("SearchField")) return "AXSearchField";
  return words(element.role) || (words(element.type) ? `AX${words(element.type)}` : "AXElement");
}

function knobOfRowSwitch(frame: ElementFrame, scale: number): ElementFrame {
  if (frame.width < frame.height * ROW_SWITCH_WIDE_BY) return frame;
  const width = Math.round(SWITCH_KNOB_POINTS.width * scale);
  const right = frame.x + frame.width - Math.round(SWITCH_KNOB_POINTS.fromRight * scale);
  return { x: right - width, y: frame.y, width, height: frame.height };
}

function converted(element: IdbElement, scale: number, inScroller: boolean, depth: number): DeviceElement {
  const traits = traitsOf(element);
  const axRole = roleOf(element, traits);
  const frame = frameOf(element.frame, scale);
  const enabled = element.enabled !== false && !traits.has("NotEnabled");
  const scrollable = traits.has("Scrollable");
  const value = words(element.AXValue);
  const identifier = words(element.AXUniqueId);
  const editable = traits.has("TextEntry") || EDITABLE_ROLES.has(axRole);
  const children = depth < MOST_DEPTH && Array.isArray(element.children) ? element.children : [];
  return {
    role: roleWords(axRole),
    identifier: identifier || null,
    label: words(element.AXLabel) || words(element.title),
    value: value || null,
    frame: axRole === "AXSwitch" ? knobOfRowSwitch(frame, scale) : frame,
    enabled,
    focused: [...traits].some((trait) => FOCUSED_TRAITS.has(trait)),
    can: {
      tap: enabled && (TAPPABLE_ROLES.has(axRole) || [...traits].some((trait) => TAPPABLE_TRAITS.has(trait))),
      edit: enabled && editable,
      scroll: scrollable && !inScroller,
    },
    children: children.map((child) => converted(child as IdbElement, scale, inScroller || scrollable, depth + 1)),
  };
}

export function iosElementAt(raw: unknown, scale: number): DeviceElement | null {
  const found = Array.isArray(raw) ? raw[0] : raw;
  if (typeof found !== "object" || found === null) return null;
  return { ...converted({ ...(found as IdbElement), children: [] }, scale, false, 1), children: [] };
}

export function iosTree(raw: unknown, scale: number): readonly DeviceElement[] {
  if (!Array.isArray(raw)) throw new DriverError("failed", "idb_companion's accessibility tree is not a list of elements.");
  return raw.map((element) => converted(element as IdbElement, scale, false, 1));
}

export const SCREEN_BY_POINTS = { across: 6, downPoints: 30, atOnce: 8 } as const;
export const READ_BY_POINTS_WORDS = "read point by point, as iOS named no app in front";
export const STARTING_WORDS = "still starting: iOS shows none of its elements yet, so observe again in a few seconds";
export const PAGE_BY_POINTS_WORDS = "its page, read point by point, as iOS lists a web page's elements only that way: an element smaller than the points' spacing may be missing, so use computer_screenshot to see the whole page";

function coversScreen(element: DeviceElement, screen: { readonly width: number; readonly height: number }): boolean {
  return !element.label && element.frame.width * element.frame.height >= screen.width * screen.height * 0.9;
}

export function namesNoFrontApp(error: unknown): boolean {
  return error instanceof Error && /no frontmost application/i.test(error.message);
}

export interface PointReads {
  at(point: { readonly x: number; readonly y: number }): Promise<unknown>;
  processName(pid: number): Promise<string | null>;
  appName(pid: number): Promise<string | null>;
}

export interface TreeReads extends PointReads {
  tree(): Promise<unknown>;
}

type Points = { readonly width: number; readonly height: number };

function pidOf(raw: unknown): number | null {
  const found = Array.isArray(raw) ? raw[0] : raw;
  const pid = (found as { pid?: unknown } | null)?.pid;
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null;
}

export async function readIosTree(reads: TreeReads, size: Points, scale: number): Promise<{ readonly elements: readonly DeviceElement[]; readonly byPoints: boolean; readonly pageByPoints: boolean }> {
  let raw: unknown;
  try {
    raw = await reads.tree();
  } catch (error) {
    if (!namesNoFrontApp(error)) throw error;
    return { elements: await screenByPoints(reads, size, scale), byPoints: true, pageByPoints: false };
  }
  const front = await withFrontAppNamed(iosTree(raw, scale), pidOf(raw), reads);
  const page = await withPageByPoints(front, pidOf(raw), reads, size, scale);
  return { elements: page ?? front, byPoints: false, pageByPoints: page !== null };
}

async function withFrontAppNamed(elements: readonly DeviceElement[], pid: number | null, reads: PointReads): Promise<readonly DeviceElement[]> {
  const [root, ...rest] = elements;
  if (!root || root.role !== "application") return elements;
  const label = root.label || (pid === null ? "" : ((await reads.appName(pid).catch(() => null)) ?? ""));
  const value = root.children.length ? root.value : STARTING_WORDS;
  if (label === root.label && value === root.value) return elements;
  return [{ ...root, label, value }, ...rest];
}

function contains(frame: ElementFrame, point: { readonly x: number; readonly y: number }): boolean {
  return point.x >= frame.x && point.x < frame.x + frame.width && point.y >= frame.y && point.y < frame.y + frame.height;
}

function shownAt(elements: readonly DeviceElement[], point: { readonly x: number; readonly y: number }): boolean {
  return elements.some((element) => ((!!element.label || !!element.value || !!element.can?.tap) && contains(element.frame, point)) || shownAt(element.children, point));
}

async function withPageByPoints(elements: readonly DeviceElement[], appPid: number | null, reads: PointReads, size: Points, scale: number): Promise<readonly DeviceElement[] | null> {
  const [root, ...rest] = elements;
  if (!root || root.role !== "application" || !root.label || !root.children.length || appPid === null) return null;
  const middle = { x: size.width / 2, y: size.height / 2 };
  if (shownAt(root.children, { x: middle.x * scale, y: middle.y * scale })) return null;
  const pagePid = pidOf(await reads.at(middle).catch(() => null));
  if (pagePid === null || pagePid === appPid) return null;
  const points = gridPoints(size).filter((point) => !shownAt(root.children, { x: point.x * scale, y: point.y * scale }));
  const found = (await elementsAtPoints(reads, points, size, scale)).filter((each) => each.pid === pagePid).map((each) => each.element);
  if (!found.length) return null;
  const scrolls = found.some((each) => each.can?.scroll);
  const page = found.map((each) => (each.can?.scroll ? { ...each, can: { ...each.can, scroll: false } } : each));
  const left = Math.min(...page.map((each) => each.frame.x));
  const top = Math.min(...page.map((each) => each.frame.y));
  const right = Math.max(...page.map((each) => each.frame.x + each.frame.width));
  const bottom = Math.max(...page.map((each) => each.frame.y + each.frame.height));
  const webView: DeviceElement = {
    role: "web view",
    identifier: null,
    label: "",
    value: PAGE_BY_POINTS_WORDS,
    frame: { x: left, y: top, width: right - left, height: bottom - top },
    enabled: true,
    focused: false,
    can: { tap: false, edit: false, scroll: scrolls },
    children: page,
  };
  return [{ ...root, children: [webView, ...root.children] }, ...rest];
}

function gridPoints(size: Points): { readonly x: number; readonly y: number }[] {
  const points: { x: number; y: number }[] = [];
  const across = size.width / SCREEN_BY_POINTS.across;
  for (let y = SCREEN_BY_POINTS.downPoints / 2; y < size.height; y += SCREEN_BY_POINTS.downPoints) {
    for (let column = 0; column < SCREEN_BY_POINTS.across; column++) points.push({ x: across * (column + 0.5), y });
  }
  return points;
}

async function elementsAtPoints(reads: PointReads, points: readonly { readonly x: number; readonly y: number }[], size: Points, scale: number): Promise<{ readonly element: DeviceElement; readonly pid: number | null }[]> {
  const found: unknown[] = [];
  for (let start = 0; start < points.length; start += SCREEN_BY_POINTS.atOnce) {
    const batch = await Promise.all(points.slice(start, start + SCREEN_BY_POINTS.atOnce).map((point) => reads.at(point).catch(() => null)));
    for (const raw of batch) found.push(Array.isArray(raw) ? raw[0] : raw);
  }
  const screen = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  const seen = new Set<string>();
  const elements: { element: DeviceElement; pid: number | null }[] = [];
  for (const raw of found) {
    const element = iosElementAt(raw, scale);
    if (!element || element.role === "application" || coversScreen(element, screen)) continue;
    const key = JSON.stringify([element.role, element.label, element.value, element.frame]);
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push({ element, pid: pidOf(raw) });
  }
  return elements.sort((a, b) => a.element.frame.y - b.element.frame.y || a.element.frame.x - b.element.frame.x);
}

export async function screenByPoints(reads: PointReads, size: Points, scale: number): Promise<readonly DeviceElement[]> {
  const found = await elementsAtPoints(reads, gridPoints(size), size, scale);
  const owners = new Map<number, number>();
  for (const { pid } of found) if (pid !== null) owners.set(pid, (owners.get(pid) ?? 0) + 1);
  const named = await Promise.all([...owners].map(async ([pid, count]) => ({ pid, name: await reads.processName(pid).catch(() => null), count })));
  const springBoardOwns = named.filter((each) => !!each.name && /SpringBoard/.test(each.name)).reduce((sum, each) => sum + each.count, 0);
  const springBoard = found.length > 0 && springBoardOwns * 2 >= found.length;
  const most = [...named].sort((a, b) => b.count - a.count)[0];
  const label = springBoard ? "Home Screen" : most && most.count * 2 >= found.length ? ((await reads.appName(most.pid).catch(() => null)) ?? "") : "";
  return [
    {
      role: "application",
      identifier: null,
      label,
      value: READ_BY_POINTS_WORDS,
      frame: { x: 0, y: 0, width: Math.round(size.width * scale), height: Math.round(size.height * scale) },
      enabled: true,
      focused: false,
      can: { tap: false, edit: false, scroll: false },
      children: found.map((each) => each.element),
    },
  ];
}
