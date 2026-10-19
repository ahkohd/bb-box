// The parts of noVNC 1.7's RFB class the viewer uses. noVNC ships no types.
// See docs/API.md in the package.

declare module "@novnc/novnc" {
  export interface RfbOptions {
    readonly shared?: boolean;
    readonly wsProtocols?: readonly string[];
  }

  /** Where noVNC draws: each rect a decoder gives it, before it is rendered. */
  export interface RfbDisplay {
    imageRect(x: number, y: number, width: number, height: number, mime: string, data: Uint8Array): void;
    blitImage(x: number, y: number, width: number, height: number, data: Uint8Array, offset: number, fromQueue?: boolean): void;
    fillRect(x: number, y: number, width: number, height: number, color: Uint8Array | number[], fromQueue?: boolean): void;
    videoFrame(x: number, y: number, width: number, height: number, frame: unknown): void;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    /** The JPEG quality it asks for, 0 to 9; 6 by default. */
    qualityLevel: number;
    /** The zlib level it asks for, 0 to 9; 2 by default. */
    compressionLevel: number;
    /** RFB's client messages, sent on a connection's socket. */
    static messages: {
      clientEncodings(sock: unknown, encodings: number[]): void;
      fbUpdateRequest(sock: unknown, incremental: boolean, x: number, y: number, width: number, height: number): void;
    };
    _sock: unknown;
    _display: RfbDisplay;
    /** Reads one FramebufferUpdate: true once all its rects are drawn. */
    _framebufferUpdate(): boolean;
    /** Sends SetEncodings: the encodings it decodes, then pseudo-encodings, a quality level among them. */
    _sendEncodings(): void;
    viewOnly: boolean;
    scaleViewport: boolean;
    resizeSession: boolean;
    clipViewport: boolean;
    focusOnClick: boolean;
    background: string;
    disconnect(): void;
    focus(options?: FocusOptions): void;
    /** Sends text as the viewer's clipboard: ClientCutText. */
    clipboardPasteFrom(text: string): void;
    /** Sends a key by keysym and DOM code; without `down`, a press and a release. Nothing while view-only. */
    sendKey(keysym: number, code: string | null, down?: boolean): void;
    /** Every key from the keyboard handler, before it is sent; a subclass may map it. */
    _handleKeyEvent(keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null): void;
    /** Puts the box's cursor, as last sent, on the canvas; called at connect and on each cursor the box sends. A subclass may decide otherwise. */
    _refreshCursor(): void;
    /** The box's cursor as last sent: none (no pixels) until it sends one. */
    _cursorImage: { rgbaPixels: Uint8Array; hotx: number; hoty: number; w: number; h: number };
    _rfbConnectionState: string;
    _canvas: HTMLCanvasElement;
    blur(): void;
    /** noVNC's keyboard handler: `_allKeysUp` lets go of every key it holds down, through `_handleKeyEvent`, as when the window loses focus. */
    _keyboard: { _allKeysUp(): void };
    /** The size of the element it draws in, which it asks the box for, floored; a subclass may measure it otherwise. */
    _screenSize(): { w: number; h: number };
  }
}

declare module "@novnc/novnc/core/input/keysymdef.js" {
  const keysyms: { lookup(codepoint: number): number };
  export default keysyms;
}

declare module "@novnc/novnc/core/input/keyboard.js" {
  export default class Keyboard {
    constructor(target: HTMLElement);
    onkeyevent: (keysym: number, code: string, down: boolean, numlock: boolean | null, capslock: boolean | null) => void;
    grab(): void;
    ungrab(): void;
    /** Lets go of every key it holds down, through `onkeyevent`, as when the window loses focus. */
    _allKeysUp(): void;
  }
}
