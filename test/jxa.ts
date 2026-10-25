import { runInNewContext } from "node:vm";

export interface FakePasteboard {
  changeCount: number;
  text: string | null;
}

function nsData(bytes: Buffer) {
  return {
    length: String(bytes.length),
    bytes,
    base64EncodedStringWithOptions: () => ({ js: bytes.toString("base64") }),
  };
}

function nsString(text: string) {
  return {
    js: text,
    length: String(text.length),
    isNil: () => false,
    characterAtIndex: (index: number) => text.charCodeAt(index),
    dataUsingEncoding: () => nsData(Buffer.from(text, "utf8")),
  };
}

const NIL = { isNil: () => true };

export class StopJxa extends Error {}

export interface PostedKey {
  readonly down: boolean;
  readonly units: readonly number[];
}

function singleSlotRef(): Record<string, unknown> {
  const slot: Record<string, unknown> = {};
  return new Proxy(slot, {
    set: (target, key, value) => {
      if (key === "0") target[key] = value;
      return true;
    },
  });
}

function utf16Pointer(text: { js: string }): Record<number, number> | null {
  if (/^[\x00-\x7f]*$/.test(text.js)) return null;
  return Object.fromEntries(Array.from({ length: text.js.length }, (_, index) => [index, text.js.charCodeAt(index)]));
}

export function runJxa(
  script: string,
  options: { chunks?: (string | (() => string))[]; pasteboard?: FakePasteboard; tick?: (count: number) => void; timeoutMs?: number; posted?: PostedKey[] } = {},
): string[] {
  const chunks = [...(options.chunks ?? [])];
  const pasteboard = options.pasteboard ?? { changeCount: 0, text: null };
  const out: string[] = [];
  let ticks = 0;
  const $ = Object.assign((value?: string) => nsString(value ?? ""), {
    NSUTF8StringEncoding: 4,
    NSPasteboardTypeString: "public.utf8-plain-text",
    NSFileHandle: {
      fileHandleWithStandardOutput: { writeData: (data: { bytes: Buffer }) => void out.push(data.bytes.toString("utf8").replace(/\n$/, "")) },
      fileHandleWithStandardInput: {
        get availableData() {
          const next = chunks.shift() ?? "";
          return nsData(Buffer.from(typeof next === "function" ? next() : next, "utf8"));
        },
      },
    },
    NSScreen: { mainScreen: { frame: { size: { width: 1440 } } } },
    NSPasteboard: {
      generalPasteboard: {
        get changeCount() {
          return String(pasteboard.changeCount);
        },
        clearContents: undefined,
        setStringForType: (text: { js: string }) => {
          pasteboard.text = text.js;
          pasteboard.changeCount++;
        },
        stringForType: () => (pasteboard.text === null ? NIL : nsString(pasteboard.text)),
      },
    },
    NSString: {
      alloc: { initWithDataEncoding: (data: { bytes: Buffer }) => nsString(data.bytes.toString("utf8")) },
      stringWithString: (text: string) => nsString(text),
    },
    NSData: { alloc: { initWithBase64EncodedStringOptions: (text: { js: string }) => nsData(Buffer.from(text.js, "base64")) } },
    kCGHIDEventTap: 0,
    CGEventCreateKeyboardEvent: (_source: unknown, _code: number, down: boolean) => ({ down, units: [] as number[] }),
    CGEventKeyboardSetUnicodeString: (event: { units: number[] }, length: number | string, units: Record<number, unknown>) => {
      event.units = Array.from({ length: Number(length) }, (_, index) => units[index] as number);
    },
    CGEventSetFlags: () => undefined,
    CGEventPost: (_tap: number, event: PostedKey) => void options.posted?.push({ down: event.down, units: event.units }),
    CFStringGetCharactersPtr: utf16Pointer,
    NSThread: {
      sleepForTimeInterval: () => {
        ticks++;
        options.tick?.(ticks);
      },
    },
  });
  try {
    runInNewContext(`${script}\nrun();`, { ObjC: { import: () => undefined }, $, Ref: singleSlotRef }, { timeout: options.timeoutMs ?? 2_000 });
  } catch (error) {
    if (!(error instanceof StopJxa)) throw error;
  }
  return out;
}
