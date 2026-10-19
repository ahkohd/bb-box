// The box's pointer drawn over a desktop's picture for a viewer without control
// (060): on a Wayland desktop with bb-box-cursor neither stream has it in its
// picture, so people watching the agent would not see where it points. bb-box
// sends its image (Selkies' cursor message) and where it is (BB_POINTER), to
// video viewers on their stream and to VNC viewers on a stream of their own.

import { POINTER_VERB } from "../core/pointer.ts";

/** A PNG's width and height, from its header, given as base64; null for what is not one. */
export function pngSize(data: string): { width: number; height: number } | null {
  try {
    const head = atob(data.slice(0, 32));
    if (head.length < 24 || head.slice(1, 4) !== "PNG") return null;
    const word = (at: number) => ((head.charCodeAt(at) << 24) | (head.charCodeAt(at + 1) << 16) | (head.charCodeAt(at + 2) << 8) | head.charCodeAt(at + 3)) >>> 0;
    return { width: word(16), height: word(20) };
  } catch {
    return null;
  }
}

/** Where a desktop's picture is in the element it is drawn in, in CSS pixels, and how many of the desktop's pixels it shows. */
export interface Picture {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  readonly desktopWidth: number;
  readonly desktopHeight: number;
}

/** The box's pointer over the picture: its image, scaled and placed as the picture is, at where bb-box says it is. */
export class BoxPointer {
  #image: { readonly url: string; readonly width: number; readonly height: number; readonly hotX: number; readonly hotY: number } | null = null;
  #at: { readonly x: number; readonly y: number } | null = null;
  #shown: HTMLImageElement | null = null;
  readonly #container: HTMLElement;

  constructor(container: HTMLElement) {
    this.#container = container;
  }

  /** The box's cursor's image, from Selkies' cursor message. */
  image(curdata: string, hotX: number, hotY: number): void {
    const size = pngSize(curdata);
    this.#image = size && { url: `data:image/png;base64,${curdata}`, ...size, hotX, hotY };
  }

  /** Where the box's pointer is, from bb-box's `BB_POINTER,<x>,<y>` (its text after the verb); null while it is off the desktop. */
  at(rest: string): void {
    const [x, y] = rest.split(",").map(Number);
    this.#at = rest && Number.isFinite(x) && Number.isFinite(y) ? { x: x!, y: y! } : null;
  }

  /** Takes a text message of the box's pointer, as a VNC viewer's pointer stream carries them; false for any other. */
  message(text: string): boolean {
    const comma = text.indexOf(",");
    const verb = comma < 0 ? text : text.slice(0, comma);
    const rest = comma < 0 ? "" : text.slice(comma + 1);
    if (verb === POINTER_VERB) {
      this.at(rest);
      return true;
    }
    if (verb !== "cursor") return false;
    try {
      const cursor = JSON.parse(rest) as { curdata?: string; hotx?: number; hoty?: number };
      if (typeof cursor.curdata === "string") this.image(cursor.curdata, cursor.hotx ?? 0, cursor.hoty ?? 0);
    } catch {
      // A cursor this viewer cannot read keeps the last.
    }
    return true;
  }

  /** Draws it over `picture`, or hides it: for the viewer with control, whose own pointer stands for it, or with none to draw. */
  place(picture: Picture | null, hidden: boolean): void {
    const image = this.#image;
    const at = this.#at;
    if (hidden || !image || !at || !picture || !picture.desktopWidth || !picture.desktopHeight || !picture.width || !picture.height) {
      if (this.#shown) this.#shown.style.display = "none";
      return;
    }
    if (!this.#shown) {
      this.#shown = document.createElement("img");
      this.#shown.alt = "";
      this.#shown.style.cssText = "position:absolute;pointer-events:none;z-index:1";
      this.#container.appendChild(this.#shown);
    }
    const shown = this.#shown;
    const scaleX = picture.width / picture.desktopWidth;
    const scaleY = picture.height / picture.desktopHeight;
    if (shown.getAttribute("src") !== image.url) shown.src = image.url;
    Object.assign(shown.style, {
      display: "block",
      left: `${picture.left + (at.x - image.hotX) * scaleX}px`,
      top: `${picture.top + (at.y - image.hotY) * scaleY}px`,
      width: `${image.width * scaleX}px`,
      height: `${image.height * scaleY}px`,
    });
  }
}
