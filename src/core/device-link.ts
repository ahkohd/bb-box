import { randomBytes } from "node:crypto";
import type { ByteChannel } from "../transports/types.ts";
import type { DeviceAnswer, DeviceHello, DeviceRequest, DeviceState, VideoReport } from "./device.ts";
import { deviceRequestText, parseDeviceServerMessage } from "./device-parse.ts";
import { BoxWebSocket, type Message } from "./websocket.ts";

export const HELLO_WAIT_MS = 10_000;
export const SUPERSEDED_CLOSE = 4000;

export type DeviceRole = "viewer" | "input" | "control";

export interface DeviceLinkOptions {
  readonly role: DeviceRole;
  readonly started?: number;
  readonly instance?: string;
  readonly helloWaitMs?: number;
  readonly signal?: AbortSignal;
  readonly onState?: (state: DeviceState) => void;
  readonly onVideo?: (video: VideoReport) => void;
  readonly onFrame?: (frame: Uint8Array) => void;
  readonly onText?: (text: string) => void;
  readonly onClosed?: (why: { readonly superseded: boolean; readonly words: string }) => void;
}

export class DeviceLinkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceLinkError";
  }
}

export type DeviceRequestBody = DeviceRequest extends infer R ? (R extends DeviceRequest ? Omit<R, "id"> : never) : never;

export function newRequestId(): string {
  return `r-${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

export class DeviceLink {
  readonly hello: DeviceHello;
  readonly #socket: BoxWebSocket;
  readonly #options: DeviceLinkOptions;
  readonly #waiting = new Map<string, { resolve(answer: DeviceAnswer): void; reject(error: Error): void }>();
  #state: DeviceState;
  #video: VideoReport | null = null;
  #closed = false;

  private constructor(socket: BoxWebSocket, hello: DeviceHello, options: DeviceLinkOptions) {
    this.#socket = socket;
    this.hello = hello;
    this.#state = hello.state;
    this.#options = options;
    void this.#read();
  }

  static async open(channel: ByteChannel, options: DeviceLinkOptions): Promise<DeviceLink> {
    const query = new URLSearchParams({ role: options.role });
    if (options.started !== undefined) query.set("started", String(options.started));
    if (options.instance !== undefined) query.set("instance", options.instance);
    const wait = AbortSignal.any([AbortSignal.timeout(options.helloWaitMs ?? HELLO_WAIT_MS), ...(options.signal ? [options.signal] : [])]);
    const socket = await BoxWebSocket.upgrade(channel, { host: "device", path: `/device?${query}`, signal: wait });
    const timedOut = new Promise<never>((_, reject) => {
      const fail = () => reject(new DeviceLinkError(`The device server did not say hello within ${(options.helloWaitMs ?? HELLO_WAIT_MS) / 1000} s.`));
      if (wait.aborted) fail();
      wait.addEventListener("abort", fail, { once: true });
    });
    timedOut.catch(() => undefined);
    try {
      for (;;) {
        const message = await Promise.race([socket.next(), timedOut]);
        if (message === null) {
          const closed = socket.closedWith;
          throw new DeviceLinkError(closed?.code === SUPERSEDED_CLOSE ? `superseded: ${closed.reason}` : `The device server closed the connection before it said hello${closed?.reason ? `: ${closed.reason}` : ""}.`);
        }
        if (typeof message !== "string" || !message.startsWith("BB_DEVICE_HELLO ")) continue;
        const parsed = parseDeviceServerMessage(message);
        if (!parsed.ok) throw new DeviceLinkError(`The device server's hello could not be read: ${parsed.words}`);
        if (parsed.value.verb !== "BB_DEVICE_HELLO") continue;
        return new DeviceLink(socket, parsed.value.hello, options);
      }
    } catch (error) {
      await socket.close().catch(() => undefined);
      throw error;
    }
  }

  get state(): DeviceState {
    return this.#state;
  }

  get video(): VideoReport | null {
    return this.#video;
  }

  get closed(): boolean {
    return this.#closed;
  }

  async #read(): Promise<void> {
    let words = "The device server closed the connection.";
    let superseded = false;
    try {
      for (;;) {
        const message: Message | null = await this.#socket.next();
        if (message === null) break;
        if (typeof message !== "string") {
          this.#options.onFrame?.(message);
          continue;
        }
        if (!message.startsWith("BB_DEVICE_")) {
          this.#options.onText?.(message);
          continue;
        }
        const parsed = parseDeviceServerMessage(message);
        if (!parsed.ok) continue;
        const value = parsed.value;
        if (value.verb === "BB_DEVICE_STATE") {
          this.#state = value.state;
          this.#options.onState?.(value.state);
        } else if (value.verb === "BB_DEVICE_ANSWER") {
          this.#state = value.answer.state ?? this.#state;
          const waiter = this.#waiting.get(value.answer.id);
          this.#waiting.delete(value.answer.id);
          waiter?.resolve(value.answer);
        } else if (value.verb === "BB_DEVICE_VIDEO") {
          this.#video = value.video;
          this.#options.onVideo?.(value.video);
        } else this.#options.onText?.(message);
      }
      const closed = this.#socket.closedWith;
      superseded = closed?.code === SUPERSEDED_CLOSE;
      if (closed?.reason) words = closed.reason;
    } catch (error) {
      words = error instanceof Error ? error.message : String(error);
    }
    this.#ended(superseded, words);
  }

  #ended(superseded: boolean, words: string): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of this.#waiting.values()) waiter.reject(new DeviceLinkError(words));
    this.#waiting.clear();
    this.#options.onClosed?.({ superseded, words });
  }

  send(text: string): Promise<void> {
    return this.#socket.send(text);
  }

  request(body: DeviceRequestBody, options: { readonly id?: string; readonly timeoutMs?: number } = {}): Promise<DeviceAnswer> {
    if (this.#closed) return Promise.reject(new DeviceLinkError("The connection to the device server is closed."));
    const id = options.id ?? newRequestId();
    const request = { ...body, id } as DeviceRequest;
    return new Promise<DeviceAnswer>((resolve, reject) => {
      const timer = options.timeoutMs ? setTimeout(() => {
        this.#waiting.delete(id);
        reject(new DeviceLinkError(`The device server did not answer within ${options.timeoutMs! / 1000} s.`));
      }, options.timeoutMs) : undefined;
      this.#waiting.set(id, {
        resolve: (answer) => {
          clearTimeout(timer);
          resolve(answer);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.send(deviceRequestText(request)).catch((error: unknown) => {
        this.#waiting.delete(id);
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    await this.#socket.close().catch(() => undefined);
    this.#ended(false, "closed by bb-box");
  }
}
