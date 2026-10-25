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

export function runJxa(script: string, options: { chunks?: (string | (() => string))[]; pasteboard?: FakePasteboard; tick?: (count: number) => void; timeoutMs?: number } = {}): string[] {
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
    NSThread: {
      sleepForTimeInterval: () => {
        ticks++;
        options.tick?.(ticks);
      },
    },
  });
  try {
    runInNewContext(`${script}\nrun();`, { ObjC: { import: () => undefined }, $, Ref: () => [] }, { timeout: options.timeoutMs ?? 2_000 });
  } catch (error) {
    if (!(error instanceof StopJxa)) throw error;
  }
  return out;
}
