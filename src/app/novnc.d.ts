// The parts of noVNC 1.7's RFB class the viewer uses. noVNC ships no types.
// See docs/API.md in the package.

declare module "@novnc/novnc" {
  export interface RfbOptions {
    readonly shared?: boolean;
    readonly wsProtocols?: readonly string[];
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
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
    blur(): void;
    /** The size of the element it draws in, which it asks the box for, floored; a subclass may measure it otherwise. */
    _screenSize(): { w: number; h: number };
  }
}
