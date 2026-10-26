import type { DeviceElement, ElementFrame } from "../core/device.ts";
import { DriverError } from "./driver.ts";

const TAPPABLE_TRAITS = new Set(["Button", "Link", "LaunchIcon", "KeyboardKey", "TabBarItem", "ToggleButton", "Adjustable", "TextEntry", "SearchField"]);
const TAPPABLE_ROLES = new Set(["AXButton", "AXLink", "AXCell", "AXSwitch", "AXToggle", "AXTab", "AXMenuItem", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXSlider", "AXTextField", "AXSecureTextField", "AXSearchField", "AXTextArea"]);
const EDITABLE_ROLES = new Set(["AXTextField", "AXSecureTextField", "AXSearchField"]);
const FOCUSED_TRAITS = new Set(["IsEditing", "Focused"]);
const DIRECTION_MARKS = /[‎‏‪-‮⁦-⁩]/g;
const MOST_DEPTH = 60;

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

function converted(element: IdbElement, scale: number, inScroller: boolean, depth: number): DeviceElement {
  const traits = traitsOf(element);
  const axRole = roleOf(element, traits);
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
    frame: frameOf(element.frame, scale),
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

function coversScreen(element: DeviceElement, screen: { readonly width: number; readonly height: number }): boolean {
  return !element.label && element.frame.width * element.frame.height >= screen.width * screen.height * 0.9;
}

export function namesNoFrontApp(error: unknown): boolean {
  return error instanceof Error && /no frontmost application/i.test(error.message);
}

export interface PointReads {
  at(point: { readonly x: number; readonly y: number }): Promise<unknown>;
  processName(pid: number): Promise<string | null>;
}

export interface TreeReads extends PointReads {
  tree(): Promise<unknown>;
}

export async function readIosTree(reads: TreeReads, size: { readonly width: number; readonly height: number }, scale: number): Promise<{ readonly elements: readonly DeviceElement[]; readonly byPoints: boolean }> {
  try {
    return { elements: iosTree(await reads.tree(), scale), byPoints: false };
  } catch (error) {
    if (!namesNoFrontApp(error)) throw error;
    return { elements: await screenByPoints(reads, size, scale), byPoints: true };
  }
}

function gridPoints(size: { readonly width: number; readonly height: number }): { readonly x: number; readonly y: number }[] {
  const points: { x: number; y: number }[] = [];
  const across = size.width / SCREEN_BY_POINTS.across;
  for (let y = SCREEN_BY_POINTS.downPoints / 2; y < size.height; y += SCREEN_BY_POINTS.downPoints) {
    for (let column = 0; column < SCREEN_BY_POINTS.across; column++) points.push({ x: across * (column + 0.5), y });
  }
  return points;
}

export async function screenByPoints(reads: PointReads, size: { readonly width: number; readonly height: number }, scale: number): Promise<readonly DeviceElement[]> {
  const points = gridPoints(size);
  const found: unknown[] = [];
  for (let start = 0; start < points.length; start += SCREEN_BY_POINTS.atOnce) {
    const batch = await Promise.all(points.slice(start, start + SCREEN_BY_POINTS.atOnce).map((point) => reads.at(point).catch(() => null)));
    for (const raw of batch) found.push(Array.isArray(raw) ? raw[0] : raw);
  }
  const screen = { width: Math.round(size.width * scale), height: Math.round(size.height * scale) };
  const seen = new Set<string>();
  const elements: DeviceElement[] = [];
  const owners = new Map<number, number>();
  for (const raw of found) {
    const element = iosElementAt(raw, scale);
    if (!element || element.role === "application" || coversScreen(element, screen)) continue;
    const key = JSON.stringify([element.role, element.label, element.value, element.frame]);
    if (seen.has(key)) continue;
    seen.add(key);
    elements.push(element);
    const pid = (raw as { pid?: unknown }).pid;
    if (typeof pid === "number") owners.set(pid, (owners.get(pid) ?? 0) + 1);
  }
  const named = await Promise.all([...owners].map(async ([pid, count]) => ({ name: await reads.processName(pid).catch(() => null), count })));
  const springBoardOwns = named.filter((each) => !!each.name && /SpringBoard/.test(each.name)).reduce((sum, each) => sum + each.count, 0);
  const springBoard = elements.length > 0 && springBoardOwns * 2 >= elements.length;
  elements.sort((a, b) => a.frame.y - b.frame.y || a.frame.x - b.frame.x);
  return [
    {
      role: "application",
      identifier: null,
      label: springBoard ? "Home Screen" : "",
      value: READ_BY_POINTS_WORDS,
      frame: { x: 0, y: 0, ...screen },
      enabled: true,
      focused: false,
      can: { tap: false, edit: false, scroll: false },
      children: elements,
    },
  ];
}
