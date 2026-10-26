import { isSideways, type Orientation, type TableModel, type TouchContact, type VideoSize } from "../core/device.ts";
import { DriverError } from "./driver.ts";
import { usKey } from "./keys.ts";

export const PASTE_KEY = "Paste";
export const ANDROID_PASTE_LANDS_MS = 300;

const NAMED_KEYS: ReadonlySet<string> = new Set([
  "Enter",
  "Escape",
  "Backspace",
  "Tab",
  " ",
  "CapsLock",
  "Insert",
  "Home",
  "PageUp",
  "Delete",
  "End",
  "PageDown",
  "ArrowRight",
  "ArrowLeft",
  "ArrowDown",
  "ArrowUp",
  "Shift",
  "Control",
  "Alt",
  "Meta",
  ...Array.from({ length: 12 }, (_, index) => `F${index + 1}`),
]);

export function emulatorKey(key: string): string {
  if (NAMED_KEYS.has(key)) return key;
  if (usKey(key) && key.length === 1) return key;
  throw new DriverError("bad-value", `A US keyboard has no key ${JSON.stringify(key)}. Send it as text, which bb-box pastes.`);
}

export interface PanelPoint {
  readonly x: number;
  readonly y: number;
}

export function touchPanel(model: TableModel): VideoSize {
  return model.form === "foldable" ? model.inner.pixels : model.screen.pixels;
}

export function panelPoint(point: PanelPoint, video: VideoSize, physical: Orientation, panel: VideoSize): PanelPoint {
  const right = video.width - 1;
  const bottom = video.height - 1;
  const upright =
    physical === "turned-right"
      ? { x: point.y, y: right - point.x }
      : physical === "turned-left"
        ? { x: bottom - point.y, y: point.x }
        : physical === "upside-down"
          ? { x: right - point.x, y: bottom - point.y }
          : point;
  const screen = isSideways(physical) ? { width: video.height, height: video.width } : video;
  const clamp = (value: number, most: number) => Math.max(0, Math.min(most - 1, Math.round(value)));
  return { x: clamp((upright.x * panel.width) / screen.width, panel.width), y: clamp((upright.y * panel.height) / screen.height, panel.height) };
}

export type EmulatorTouch = {
  readonly x: number;
  readonly y: number;
  readonly identifier: number;
  readonly pressure: number;
};

export class TouchesDown {
  #down = new Map<number, PanelPoint>();

  get any(): boolean {
    return this.#down.size > 0;
  }

  next(contacts: readonly TouchContact[], toPanel: (contact: TouchContact) => PanelPoint): readonly EmulatorTouch[] {
    const now = new Map(contacts.map((contact) => [contact.id, toPanel(contact)] as const));
    const lifted = [...this.#down].filter(([id]) => !now.has(id)).map(([id, at]) => ({ ...at, identifier: id, pressure: 0 }));
    const pressed = [...now].map(([id, at]) => ({ ...at, identifier: id, pressure: 1 }));
    this.#down = now;
    return [...pressed, ...lifted];
  }

  liftAll(): readonly EmulatorTouch[] {
    const lifted = [...this.#down].map(([id, at]) => ({ ...at, identifier: id, pressure: 0 }));
    this.#down = new Map();
    return lifted;
  }
}
