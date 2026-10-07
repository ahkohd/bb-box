// The viewer's own lossless refresh, for a desktop whose stream server never
// sends again losslessly what it sent as JPEG (056). Xtigervnc sends an area
// again, near losslessly, about 0.1 s after it stops changing; wayvnc does
// not, so its picture stayed as soft as the motion until the next change, at
// every quality; and QEMU with lossy=on does after 1.5 s, but partly as JPEG
// still. Here the viewer asks instead: once nothing has come for a moment, it
// asks for the area it drew as JPEG again with no quality level, which both
// answer losslessly, then asks for JPEG again. Motion keeps the light
// quality; a still screen is exact about 0.35 s after it stops.

import type RFB from "@novnc/novnc";

/** An area of the screen: x, y, width and height. */
export type Area = readonly [number, number, number, number];

/** How long the screen is still before the viewer asks for it losslessly. */
export const STILL_MS = 250;

/** Asks for lossless answers that come back as JPEG, before the viewer stops asking. */
const IGNORED_LIMIT = 3;
/** The quality-level pseudo-encodings, 0 to 9. */
const QUALITY_LEVEL_0 = -32;
const QUALITY_LEVEL_9 = -23;

function union(a: Area, b: Area): Area {
  const x = Math.min(a[0], b[0]);
  const y = Math.min(a[1], b[1]);
  return [x, y, Math.max(a[0] + a[2], b[0] + b[2]) - x, Math.max(a[1] + a[3], b[1] + b[3]) - y];
}

/**
 * When to ask. It is told each area drawn, lossy or not, and each update's
 * end. An update that draws nothing, as a cursor's, neither ends an ask nor
 * starts the wait. An ask ends with the next update that draws: whatever it
 * drew as JPEG is asked for again once the screen is still again, and a
 * server that answers asks with JPEG only is not asked any more.
 */
export class LosslessRefresh {
  readonly #ask: (area: Area) => void;
  readonly #back: () => void;
  readonly #stillMs: number;
  #dirty: Area | null = null;
  #lossy = false;
  #lossless = false;
  #asked = false;
  #ignored = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(actions: { ask: (area: Area) => void; back: () => void }, stillMs = STILL_MS) {
    this.#ask = actions.ask;
    this.#back = actions.back;
    this.#stillMs = stillMs;
  }

  /** An area the viewer drew: from JPEG, or exactly. */
  drawn(area: Area, lossy: boolean): void {
    if (area[2] <= 0 || area[3] <= 0) return;
    if (!lossy) {
      this.#lossless = true;
      return;
    }
    this.#lossy = true;
    this.#dirty = this.#dirty ? union(this.#dirty, area) : area;
  }

  /** An update has ended. */
  updated(): void {
    const drew = this.#lossy || this.#lossless;
    if (this.#asked && drew) {
      this.#asked = false;
      this.#ignored = this.#lossless ? 0 : this.#ignored + 1;
      this.#back();
    }
    this.#lossy = false;
    this.#lossless = false;
    if (!drew || this.#asked) return;
    clearTimeout(this.#timer);
    if (!this.#dirty || this.#ignored >= IGNORED_LIMIT) return;
    this.#timer = setTimeout(() => {
      const area = this.#dirty;
      if (!area) return;
      this.#dirty = null;
      this.#asked = true;
      this.#ask(area);
    }, this.#stillMs);
  }

  /** Whether the viewer is asking for lossless pictures now. */
  get asking(): boolean {
    return this.#asked;
  }

  stop(): void {
    clearTimeout(this.#timer);
  }
}

/**
 * Makes a noVNC client ask for still areas again losslessly: it is told each
 * rect as its decoder draws it, JPEG and video lossy and the rest exact, and
 * each update's end. An ask is SetEncodings without a quality level, which
 * noVNC always names, then a request for the area that is not incremental.
 */
export function refreshLosslessly(client: RFB): LosslessRefresh {
  const messages = (client.constructor as typeof RFB).messages;
  let lossless = false;
  const sendEncodings = client._sendEncodings.bind(client);
  client._sendEncodings = () => {
    if (!lossless) {
      sendEncodings();
      return;
    }
    const send = messages.clientEncodings;
    messages.clientEncodings = (sock, encodings) => send(sock, encodings.filter((encoding) => encoding < QUALITY_LEVEL_0 || encoding > QUALITY_LEVEL_9));
    try {
      sendEncodings();
    } finally {
      messages.clientEncodings = send;
    }
  };
  const refresh = new LosslessRefresh({
    ask: ([x, y, width, height]) => {
      lossless = true;
      client._sendEncodings();
      messages.fbUpdateRequest(client._sock, false, x, y, width, height);
    },
    back: () => {
      lossless = false;
      client._sendEncodings();
    },
  });
  const display = client._display;
  const imageRect = display.imageRect.bind(display);
  const blitImage = display.blitImage.bind(display);
  const fillRect = display.fillRect.bind(display);
  const videoFrame = display.videoFrame.bind(display);
  display.imageRect = (x, y, width, height, mime, data) => {
    refresh.drawn([x, y, width, height], mime === "image/jpeg");
    imageRect(x, y, width, height, mime, data);
  };
  // A rect drawn from the render queue was told when it was queued.
  display.blitImage = (x, y, width, height, data, offset, fromQueue) => {
    if (!fromQueue) refresh.drawn([x, y, width, height], false);
    blitImage(x, y, width, height, data, offset, fromQueue);
  };
  display.fillRect = (x, y, width, height, color, fromQueue) => {
    if (!fromQueue) refresh.drawn([x, y, width, height], false);
    fillRect(x, y, width, height, color, fromQueue);
  };
  display.videoFrame = (x, y, width, height, frame) => {
    refresh.drawn([x, y, width, height], true);
    videoFrame(x, y, width, height, frame);
  };
  const update = client._framebufferUpdate.bind(client);
  client._framebufferUpdate = () => {
    const done = update();
    if (done) refresh.updated();
    return done;
  };
  return refresh;
}
