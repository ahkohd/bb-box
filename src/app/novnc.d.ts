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
    blur(): void;
  }
}
