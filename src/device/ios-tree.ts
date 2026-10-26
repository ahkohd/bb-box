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
