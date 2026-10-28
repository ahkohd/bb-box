import type { Geometry, TouchContact } from "../core/device.ts";
import type { InputLane } from "./input-lane.ts";
import { keysymMeaning } from "./keys.ts";

export const LONG_PRESS_MS = 1200;
export const WHEEL_SWIPE = { joinMs: 100, screenFraction: 1 / 12, steps: 6, stepMs: 16, edgeFraction: 0.05, stillWobblePixels: 1 } as const;

export function easedOut(step: number, steps: number): number {
  return 1 - (1 - step / steps) ** 3;
}

const PRIMARY = 1;
const SECONDARY = 4;
const WHEEL_DOWN = 8;
const WHEEL_UP = 16;

export interface PersonInputTarget {
  readonly lane: InputLane;
  geometry(): Geometry | null;
  waitingForGeometry(): boolean;
  touch(contacts: readonly TouchContact[]): Promise<void>;
  typesAsKeys(character: string): boolean;
  key(key: string, down: boolean): Promise<void>;
  acting(): void;
  log(line: string): void;
  readonly wait?: (ms: number, signal: AbortSignal) => Promise<void>;
}

type Point = { readonly x: number; readonly y: number };

type Gesture =
  | { readonly kind: "touch"; last: Point }
  | { readonly kind: "long"; readonly downAt: number; readonly at: Point }
  | { readonly kind: "pinch"; last: Point }
  | { readonly kind: "wheel"; finger: Point; waiting: number };

export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    }, ms);
    const stop = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", stop, { once: true });
  });
}

export function mirroredAboutCentre(point: Point, size: { readonly width: number; readonly height: number }): Point {
  return { x: size.width - point.x, y: size.height - point.y };
}

export class PersonInput {
  readonly #target: PersonInputTarget;
  #buttons = 0;
  #wheelButtons = 0;
  #pointer: Point = { x: 0, y: 0 };
  #alt = false;
  #gesture: Gesture | null = null;
  #moveQueued = false;
  #nextMove: readonly TouchContact[] | null = null;
  readonly #held = new Set<string>();

  constructor(target: PersonInputTarget) {
    this.#target = target;
  }

  get gesture(): Gesture["kind"] | null {
    return this.#gesture?.kind ?? null;
  }

  #wait(ms: number, signal: AbortSignal): Promise<void> {
    return (this.#target.wait ?? waitFor)(ms, signal);
  }

  message(text: string): boolean {
    const fields = text.split(",");
    switch (fields[0]) {
      case "m":
        this.#pointerMessage(Number(fields[1]), Number(fields[2]), Number(fields[3]) || 0);
        return true;
      case "m2":
        this.#wheelMessage(Number(fields[3]) || 0, Math.max(1, Math.min(64, Number(fields[4]) || 1)));
        return true;
      case "kd":
      case "ku":
        this.#keyMessage(Number(fields[1]), fields[0] === "kd");
        return true;
      case "kr":
        this.releaseKeys();
        return true;
      case "cw":
      case "cws":
      case "cwd":
      case "cwe":
        this.#clipboardMessage(fields);
        return true;
      default:
        return false;
    }
  }

  #size(): { readonly width: number; readonly height: number } | null {
    return this.#target.geometry()?.video ?? null;
  }

  #clamp(x: number, y: number): Point | null {
    const size = this.#size();
    if (!size || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { x: Math.max(0, Math.min(size.width - 1, x)), y: Math.max(0, Math.min(size.height - 1, y)) };
  }

  #touch(contacts: readonly TouchContact[]): void {
    this.#target.lane.run(() => this.#target.touch(contacts)).catch((error) => this.#target.log(`person: a touch was not sent: ${words(error)}`));
  }

  #pointerMessage(x: number, y: number, buttons: number): void {
    const point = this.#clamp(x, y);
    if (!point) return;
    this.#pointer = point;
    const was = this.#buttons;
    this.#buttons = buttons;
    const pressed = (buttons & PRIMARY) !== 0 && (was & PRIMARY) === 0;
    const released = (buttons & PRIMARY) === 0 && (was & PRIMARY) !== 0;
    const longPressed = (buttons & SECONDARY) !== 0 && (was & SECONDARY) === 0;
    const longReleased = (buttons & SECONDARY) === 0 && (was & SECONDARY) !== 0;
    const gesture = this.#gesture;
    if (gesture?.kind === "wheel" && (pressed || longPressed)) this.#endWheel();
    if (!this.#gesture) {
      if (!pressed && !longPressed) return;
      if (this.#target.waitingForGeometry()) {
        this.#target.log("person: a touch came while the device was turning or switching, so it waits for the new picture and is not sent");
        return;
      }
      this.#target.acting();
      if (pressed && this.#alt) {
        this.#gesture = { kind: "pinch", last: point };
        this.#touch(this.#pinchContacts(point));
      } else if (pressed) {
        this.#gesture = { kind: "touch", last: point };
        this.#touch([{ id: 0, ...point }]);
      } else {
        this.#gesture = { kind: "long", downAt: performance.now(), at: point };
        this.#touch([{ id: 0, ...point }]);
      }
      return;
    }
    const current = this.#gesture;
    if (current.kind === "long") {
      if (!longReleased) return;
      const left = Math.max(0, current.downAt + LONG_PRESS_MS - performance.now());
      this.#gesture = null;
      this.#target.lane.run((signal) => this.#wait(left, signal).then(() => this.#target.touch([]))).catch((error) => this.#target.log(`person: a long press did not end: ${words(error)}`));
      return;
    }
    if (current.kind !== "touch" && current.kind !== "pinch") return;
    if (released) {
      this.#gesture = null;
      this.#touch([]);
      return;
    }
    if ((buttons & PRIMARY) === 0 || (point.x === current.last.x && point.y === current.last.y)) return;
    current.last = point;
    this.#move(current.kind === "pinch" ? this.#pinchContacts(point) : [{ id: 0, ...point }]);
  }

  #pinchContacts(point: Point): readonly TouchContact[] {
    const size = this.#size()!;
    const other = mirroredAboutCentre(point, size);
    return [
      { id: 0, ...point },
      { id: 1, x: Math.max(0, Math.min(size.width - 1, other.x)), y: Math.max(0, Math.min(size.height - 1, other.y)) },
    ];
  }

  #move(contacts: readonly TouchContact[]): void {
    this.#nextMove = contacts;
    if (this.#moveQueued) return;
    this.#moveQueued = true;
    this.#target.lane
      .run(async () => {
        this.#moveQueued = false;
        const next = this.#nextMove;
        this.#nextMove = null;
        if (next) await this.#target.touch(next);
      })
      .catch((error) => {
        this.#moveQueued = false;
        this.#target.log(`person: a move was not sent: ${words(error)}`);
      });
  }

  #wheelMessage(buttons: number, count: number): void {
    const was = this.#wheelButtons;
    this.#wheelButtons = buttons;
    const down = (buttons & WHEEL_DOWN) !== 0 && (was & WHEEL_DOWN) === 0;
    const up = (buttons & WHEEL_UP) !== 0 && (was & WHEEL_UP) === 0;
    if (!down && !up) return;
    const size = this.#size();
    if (!size) return;
    if (this.#gesture && this.#gesture.kind !== "wheel") return;
    if (!this.#gesture && this.#target.waitingForGeometry()) return;
    this.#target.acting();
    const direction = down ? -1 : 1;
    let gesture = this.#gesture;
    if (!gesture) {
      gesture = { kind: "wheel", finger: this.#pointer, waiting: 0 };
      this.#gesture = gesture;
      const start = gesture.finger;
      this.#touch([{ id: 0, ...start }]);
    }
    const wheel = gesture;
    wheel.waiting++;
    const notchPixels = size.height * WHEEL_SWIPE.screenFraction;
    const edge = size.height * WHEEL_SWIPE.edgeFraction;
    this.#target.lane
      .run(async (signal) => {
        wheel.waiting--;
        for (let notch = 0; notch < count; notch++) {
          for (let each = 1; each <= WHEEL_SWIPE.steps; each++) {
            if (this.#gesture !== wheel) return;
            const y = wheel.finger.y + direction * notchPixels * (easedOut(each, WHEEL_SWIPE.steps) - easedOut(each - 1, WHEEL_SWIPE.steps));
            if (y < edge || y > size.height - edge) {
              await this.#target.touch([]);
              wheel.finger = this.#pointer;
              await this.#target.touch([{ id: 0, ...wheel.finger }]);
              continue;
            }
            wheel.finger = { x: wheel.finger.x, y };
            await this.#target.touch([{ id: 0, ...wheel.finger }]);
            await this.#wait(WHEEL_SWIPE.stepMs, signal);
          }
        }
        for (let held = 0, wobble: number = WHEEL_SWIPE.stillWobblePixels; held < WHEEL_SWIPE.joinMs; held += WHEEL_SWIPE.stepMs, wobble = -wobble) {
          if (this.#gesture !== wheel || wheel.waiting > 0) return;
          await this.#target.touch([{ id: 0, x: wheel.finger.x, y: wheel.finger.y + Math.max(0, wobble) }]);
          await this.#wait(WHEEL_SWIPE.stepMs, signal);
        }
        await this.#target.touch([{ id: 0, ...wheel.finger }]);
        if (this.#gesture !== wheel || wheel.waiting > 0) return;
        this.#gesture = null;
        await this.#target.touch([]);
      })
      .catch((error) => this.#target.log(`person: a scroll was not sent: ${words(error)}`));
  }

  #endWheel(): void {
    const gesture = this.#gesture;
    if (gesture?.kind !== "wheel") return;
    this.#gesture = null;
    this.#touch([]);
  }

  #keyMessage(keysym: number, down: boolean): void {
    if (!Number.isInteger(keysym)) return;
    const meaning = keysymMeaning(keysym);
    if (meaning.is === "ignored") return;
    if (meaning.is === "text" && !this.#target.typesAsKeys(meaning.text)) {
      if (!down) return;
      this.#target.acting();
      this.#target.lane.text(meaning.text);
      return;
    }
    const key = meaning.is === "key" ? meaning.key : meaning.text;
    if (key === "Alt") {
      this.#alt = down;
      return;
    }
    if (!down && !this.#held.has(key)) return;
    this.#target.acting();
    if (down) this.#held.add(key);
    else this.#held.delete(key);
    this.#target.lane.run(() => this.#target.key(key, down)).catch((error) => this.#target.log(`person: the key ${key} was not sent: ${words(error)}`));
  }

  releaseKeys(): void {
    const held = [...this.#held];
    this.#held.clear();
    this.#alt = false;
    for (const key of held) this.#target.lane.run(() => this.#target.key(key, false)).catch(() => undefined);
  }

  #clipboardMessage(fields: readonly string[]): void {
    if (fields[0] === "cw" || fields[0] === "cws") this.#target.log("clipboard: the viewer's clipboard was not put on the device; it goes only with a paste");
  }

  forget(): void {
    this.#gesture = null;
    this.#moveQueued = false;
    this.#nextMove = null;
    this.#buttons = 0;
    this.#wheelButtons = 0;
    this.#held.clear();
    this.#alt = false;
  }
}

function words(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
