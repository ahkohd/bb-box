import type { TouchContact } from "../core/device.ts";

export const ECHO_DIAMETER_PX = 36;
export const ECHO_SHOWN_MS = 300;
const XK_BACKSPACE = 0xff08;

export interface Picture {
  readonly left: number;
  readonly top: number;
  readonly scale: number;
}

export function pictureIn(width: number, height: number, videoWidth: number, videoHeight: number): Picture | null {
  if (!videoWidth || !videoHeight || !width || !height) return null;
  const scale = Math.min(width / videoWidth, height / videoHeight);
  return { left: (width - videoWidth * scale) / 2, top: (height - videoHeight * scale) / 2, scale };
}

export class TouchEcho {
  readonly element = document.createElement("div");

  constructor() {
    this.element.style.cssText = "position:absolute;inset:0;pointer-events:none;overflow:hidden";
    this.element.setAttribute("aria-hidden", "true");
  }

  show(contacts: readonly TouchContact[], picture: Picture | null): void {
    if (!picture) return;
    for (const contact of contacts) {
      const circle = document.createElement("div");
      const x = picture.left + contact.x * picture.scale - ECHO_DIAMETER_PX / 2;
      const y = picture.top + contact.y * picture.scale - ECHO_DIAMETER_PX / 2;
      circle.style.cssText = `position:absolute;left:${x}px;top:${y}px;width:${ECHO_DIAMETER_PX}px;height:${ECHO_DIAMETER_PX}px;border-radius:50%;background:rgba(255,255,255,0.45);box-shadow:0 0 0 1px rgba(0,0,0,0.35);transition:opacity ${ECHO_SHOWN_MS}ms ease-out`;
      this.element.appendChild(circle);
      requestAnimationFrame(() => (circle.style.opacity = "0"));
      setTimeout(() => circle.remove(), ECHO_SHOWN_MS);
    }
  }
}

export interface DeviceTypingOptions {
  readonly text: (text: string) => void;
  readonly key: (keysym: number) => void;
}

export class DeviceTyping {
  readonly element = document.createElement("textarea");
  readonly #options: DeviceTypingOptions;

  constructor(options: DeviceTypingOptions) {
    this.#options = options;
    const field = this.element;
    field.setAttribute("aria-label", "Keyboard input for the device");
    field.setAttribute("autocapitalize", "off");
    field.setAttribute("autocomplete", "off");
    field.setAttribute("autocorrect", "off");
    field.spellcheck = false;
    field.tabIndex = -1;
    field.style.cssText = "position:absolute;left:0;top:0;width:1px;height:1px;opacity:0;padding:0;border:0;resize:none;pointer-events:none;overflow:hidden";
    field.addEventListener("compositionend", (event) => {
      if (event.data) this.#options.text(event.data);
      field.value = "";
    });
    field.addEventListener("input", (event) => {
      const input = event as InputEvent;
      if (input.isComposing) return;
      if ((input.inputType === "insertText" || input.inputType === "insertReplacementText") && input.data) this.#options.text(input.data);
      else if (input.inputType === "deleteContentBackward") this.#options.key(XK_BACKSPACE);
      if (input.inputType !== "insertCompositionText") field.value = "";
    });
  }

  composing(event: KeyboardEvent): boolean {
    return event.target === this.element && (event.isComposing || event.keyCode === 229 || event.key === "Dead");
  }
}

export class DeviceFingers {
  readonly #down = new Map<number, { x: number; y: number }>();

  get count(): number {
    return this.#down.size;
  }

  set(pointerId: number, at: { readonly x: number; readonly y: number }): readonly TouchContact[] {
    this.#down.set(pointerId, { x: at.x, y: at.y });
    return this.contacts();
  }

  lift(pointerId: number): readonly TouchContact[] {
    this.#down.delete(pointerId);
    return this.contacts();
  }

  has(pointerId: number): boolean {
    return this.#down.has(pointerId);
  }

  clear(): void {
    this.#down.clear();
  }

  contacts(): readonly TouchContact[] {
    return [...this.#down.values()].map((at, id) => ({ id, x: at.x, y: at.y }));
  }
}
